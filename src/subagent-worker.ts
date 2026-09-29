import OpenAI from "openai";
import { streamChat } from "./core/model.js";

/**
 * @file 子代理 Worker 子进程入口。
 *
 * 核心设计与安全沙箱特性：
 * 1. 纯净通信进程：本进程专职负责大模型网络请求，不装载扩展、不持有会话锁、
 *    不读取系统配置文件，也不具有任何操作业务文件的权限。
 * 2. 父子生命周期绑定：通过监听 `process.on("disconnect")`，一旦父进程退出或断开 IPC 管道，
 *    本 Worker 进程立即退出，彻底杜绝孤儿进程占用系统资源。
 * 3. 严格 IPC 协议校验：仅响应受控的 `init`（凭据与模型初始化）与 `request`（模型推理请求）指令，
 *    校验请求序号严格递增（lastId + 1），防止并发错乱。
 * 4. 敏感错误与凭据隔离：网络请求异常时仅向父进程返回 `{ id, error: true }`，
 *    绝不把 OpenAI SDK 的原始错误堆栈、请求头或 API Key 回传给父进程或输出到终端。
 */

let client: OpenAI | undefined;
let model = "";
let busy = false;
let lastId = 0;

// 关键防泄漏机制：一旦父进程断开 IPC 通道（如父进程被杀或正常关闭），子进程立即退出，防止变成孤儿进程。
process.on("disconnect", () => process.exit(0));

// 必须作为 child_process.fork 启动（具备 process.send IPC 通道），否则直接异常退出。
if (!process.send) {
  process.exitCode = 1;
} else {
  // 监听来自父进程的 IPC 指令
  process.on("message", async (raw: unknown) => {
    // 状态互斥校验：若当前正在处理请求，或消息体非普通对象，直接异常退出防错乱
    if (busy || typeof raw !== "object" || raw === null) {
      process.exit(1);
      return;
    }
    const message = raw as Record<string, unknown>;

    // 1. 初始化分支：接收模型配置（apiKey, baseURL, model），创建独立的 OpenAI 实例
    if (message.type === "init" && !client) {
      const config = message.config;
      if (
        !config ||
        typeof config !== "object" ||
        !("apiKey" in config) ||
        typeof config.apiKey !== "string" ||
        !("baseURL" in config) ||
        typeof config.baseURL !== "string" ||
        !("model" in config) ||
        typeof config.model !== "string"
      ) {
        process.exit(1);
        return;
      }
      try {
        client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
        model = config.model;
        process.send?.({ type: "ready" });
      } catch {
        process.exit(1);
      }
      return;
    }

    // 2. 模型请求分支：校验协议类型、client 已就绪、请求 ID 严格自增以及消息与工具数组完备
    if (
      message.type !== "request" ||
      !client ||
      message.id !== lastId + 1 ||
      !Array.isArray(message.messages) ||
      !Array.isArray(message.tools)
    ) {
      process.exit(1);
      return;
    }

    lastId++;
    busy = true;

    try {
      // IPC 发送方是宿主自己；模型与工具的业务边界仍在父进程执行器中校验。
      const result = await streamChat(
        client,
        model,
        message.messages,
        message.tools,
        new AbortController().signal,
        () => {},
      );
      // 响应体积限制：单次聚合结果超过 64 KiB 视为异常响应并抛错
      if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) {
        throw new Error("响应超限");
      }
      // 成功返回模型完整聚合结果
      process.send?.({ id: message.id, result });
    } catch {
      // 关键安全防线：不把 SDK 错误正文、请求信息或密钥传回父进程，统一脱敏为 error: true
      process.send?.({ id: message.id, error: true });
    } finally {
      busy = false;
    }
  });
}
