import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

/**
 * @file 本地模拟模型服务（startDemoModel）。
 *
 * 核心架构与设计目标：
 * 1. 零配置开箱即用：提供完全兼容 OpenAI Chat Completions 协议的本机模拟 HTTP 服务，
 *    启动时动态绑定空闲端口并生成一次性随机 Bearer Token，无需用户配置真实 API Key 即可完整体验 Agent；
 * 2. 真实链路闭环：除大模型为预设规则外，宿主的 OpenAI SDK 请求、会话序列化、流式 SSE 解析、
 *    工具定义发现、Schema 校验、逐次权限审批与子代理子进程均走 100% 真实生产代码，绝无测试作弊分流；
 * 3. 安全防护与工具收敛：严格限制 Host/Origin 校验防 CSRF 探测，请求体上限 1 MiB 防 DoS，
 *    且演示工具严格收敛在 `demoTools` 白名单内，杜绝任意命令执行或外部网络访问；
 * 4. 真实结果回填：当接收到 `role: "tool"` 消息时，将实际工具执行结果（含用户拒绝或报错）
 *    原样回填到下一轮回答中，真实展示 Agent 的闭环推理行为，不编造工具成功。
 */

/** 演示模式只开放这些已有工具；网络、外部命令和业务文件写入工具不进入演示入口。 */
export const demoTools = new Set(["echo", "read_file", "list_files", "todo_add", "todo_list", "run_subagent"]);

/**
 * 启动本机轻量模拟模型 HTTP 服务。
 *
 * @returns 包含连接配置 config（apiKey、model、baseURL）及异步关闭方法 close 的服务句柄
 */
export async function startDemoModel() {
  const apiKey = randomUUID();
  const model = "lcn-demo";
  const server = createServer(async (request, response) => {
    const address = server.address();
    const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    // 安全校验：Host 必须精确匹配、禁止 Origin（防止浏览器跨域发起请求）、Bearer Token 鉴权必须一致
    if (
      request.headers.host !== host ||
      request.headers.origin !== undefined ||
      request.headers.authorization !== `Bearer ${apiKey}`
    ) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    // 路由与方法限制：仅处理 POST /v1/chat/completions 接口
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end("Not Found");
      return;
    }

    const abort = new AbortController();
    response.once("close", () => abort.abort());

    try {
      // 流式读取请求体，并设置 1 MiB 体积硬性保护
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error("请求过大");
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        !("model" in body) ||
        body.model !== model ||
        !("messages" in body) ||
        !Array.isArray(body.messages) ||
        !("stream" in body) ||
        typeof body.stream !== "boolean"
      ) {
        throw new Error("请求格式无效");
      }
      const messages = body.messages;
      if (
        !messages.length ||
        !messages.every(
          (message) =>
            message &&
            typeof message === "object" &&
            typeof message.role === "string" &&
            (typeof message.content === "string" || message.content === null),
        )
      ) {
        throw new Error("消息格式无效");
      }

      // 非流式请求分支：专门支持 /compact 会话压缩时的摘要生成调用
      if (!body.stream) {
        // 只演示摘要调用和保存机制，不把固定文本冒充真实语义总结。
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "本地演示摘要，不包含真实语义总结；请通过 /history 查看原始记录。",
                },
              },
            ],
          }),
        );
        return;
      }

      // 提取客户端声明可用的工具列表，用于校验模型意图是否在可用工具集内
      const available = new Set<string>();
      if ("tools" in body && body.tools !== undefined) {
        if (!Array.isArray(body.tools)) throw new Error("工具列表无效");
        for (const tool of body.tools) {
          if (!tool || typeof tool !== "object" || !tool.function || typeof tool.function.name !== "string") {
            throw new Error("工具定义无效");
          }
          available.add(tool.function.name);
        }
      }

      const last = messages.at(-1);
      let content: string;
      let call: { name: string; args: object } | undefined;

      // 1. 若上一条是工具执行结果（tool），则提取实际返回内容并向用户展示结果
      if (last.role === "tool") {
        // 展示执行器真正返回的结果，包括拒绝与失败，不编造工具成功。
        let start = messages.length;
        while (start > 0 && messages[start - 1].role === "tool") start--;
        content = "工具实际返回：\n" + messages.slice(start).map((message) => message.content).join("\n");
      } else {
        // 2. 若是用户消息，根据关键词意图模拟触发工具调用或常规文本回答
        const text = typeof last.content === "string" ? last.content.trim() : "";
        content =
          `本地演示回答：${text}\n` +
          "可输入：回显 内容、读取 路径、列目录 路径、待办 内容、查看待办、子任务 读取 路径、等待。";
        if (text.startsWith("回显 ")) call = { name: "echo", args: { text: text.slice(3) } };
        else if (text.startsWith("读取 ")) call = { name: "read_file", args: { path: text.slice(3) } };
        else if (text.startsWith("列目录 ")) call = { name: "list_files", args: { path: text.slice(4) } };
        else if (text.startsWith("待办 ")) call = { name: "todo_add", args: { text: text.slice(3) } };
        else if (text === "查看待办") call = { name: "todo_list", args: {} };
        else if (text.startsWith("子任务 ")) call = { name: "run_subagent", args: { task: text.slice(4) } };

        // 安全检查：如果生成的工具不在演示白名单或当前模式不允许，则拒绝触发
        if (call && (!demoTools.has(call.name) || !available.has(call.name))) {
          content = `当前模式没有提供 ${call.name}，未执行该操作。`;
          call = undefined;
        }
        if (text === "等待") content = "本地等待演示完成。";
      }

      // 返回符合 OpenAI 协议的 Server-Sent Events (SSE) 流
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (delta: object, finish_reason: string | null) => {
        abort.signal.throwIfAborted();
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      };

      if (call) {
        // 发送 tool_calls 触发分片
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: `demo_${randomUUID()}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        // 模拟长耗时流，用于测试 Ctrl+C 或 /task_cancel 的协作取消
        if (last.role === "user" && typeof last.content === "string" && last.content.trim() === "等待") {
          send({ content: "正在等待，可用 Ctrl+C 或 /task_cancel 取消。\n" }, null);
          await setTimeout(10_000, undefined, { signal: abort.signal });
        }
        // 分片仅用于展示流式输出；不存在真实提供商用量，不返回伪造的 usage。
        for (let index = 0; index < content.length; index += 256) {
          send({ content: content.slice(index, index + 256) }, null);
          await setTimeout(10, undefined, { signal: abort.signal });
        }
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch {
      if (!response.headersSent) response.writeHead(400).end("演示请求无效");
      else response.destroy();
    }
  });

  server.requestTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得演示服务端口");

  let closing: Promise<void> | undefined;
  return {
    config: { apiKey, model, baseURL: `http://127.0.0.1:${address.port}/v1` },
    /** 幂等关闭本地模拟 HTTP 服务并销毁所有已有连接。 */
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
