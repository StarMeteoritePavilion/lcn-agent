import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { loadConfig } from "./config.js";
import type { SteamChatResult } from "./model.js";
import { runSubagent, type SubagentModel, type SubagentRunner } from "./subagent.js";
import type { ToolRegistry } from "./tools.js";

/**
 * @file 基于子进程隔离的子代理执行器。
 *
 * 核心安全机制与设计意图：
 * 1. 独立进程隔离：通过 `child_process.fork` 为子任务启动专属的 Worker 子进程（subagent-worker.js），
 *    将可能导致主进程挂起或内存消耗的模型通信隔离在子进程中。
 * 2. 最小环境与零凭据继承：子进程启动时使用 `env: {}` 和 `execArgv: []`，拒绝继承父进程环境变量、
 *    调试参数（NODE_OPTIONS）或敏感配置，仅通过受控的本机 IPC 发送模型连接配置。
 * 3. 管道屏蔽与纯 IPC 通信：`stdio: ["ignore", "ignore", "ignore", "ipc"]` 关闭普通标准输入输出流，
 *    所有指令与响应仅通过 Node.js 原生进程间通信（IPC）管道安全传递。
 * 4. 权限与工具执行不外包：子进程只负责请求大模型并返回聚合响应；当模型决定调用工具时，
 *    工具调用的参数校验、用户授权和本地读取始终在父进程受控执行，子进程不具备本地文件操作能力。
 * 5. 可靠进程回收：任务完成、异常或收到取消信号时，显式发送 SIGKILL 信号并等待进程 close 事件，
 *    杜绝孤儿进程或僵尸进程遗留。
 */

/**
 * 校验通过 IPC 接收到的对象是否为合规的 SteamChatResult 模型聚合结果。
 *
 * 属于 IPC 通信边界的防御性类型保护（Type Guard），防止子进程因异常返回残缺数据破坏父任务循环。
 *
 * @param value 待检查的未知数据
 * @returns 是否符合完整的 SteamChatResult 接口契约
 */
export function isModelResult(value: unknown): value is SteamChatResult {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.content !== "string" || typeof item.finishReason !== "string" || !Array.isArray(item.toolCalls)) {
    return false;
  }
  if (
    !item.toolCalls.every(
      (call) =>
        call !== null &&
        typeof call === "object" &&
        typeof call.id === "string" &&
        typeof call.name === "string" &&
        typeof call.arguments === "string",
    )
  )
    return false;
  if (item.usage === null) return true;
  if (typeof item.usage !== "object" || item.usage === null) return false;
  const usage = item.usage as Record<string, unknown>;
  return [usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
    (count) => typeof count === "number" && Number.isFinite(count) && count >= 0,
  );
}

/**
 * 创建子进程维度的子代理执行管理器。
 *
 * 每次执行子任务时启动一个独立的 worker 子进程；
 * 前台委派工具（run_subagent）和后台任务命令（tasks.ts）共用并发名额，进程退出后才释放名额。
 *
 * @param config 全局模型配置，包含 apiKey、baseURL 与 model
 * @param registry 父进程工具注册表，用于在父进程中受控执行子代理发起的只读工具
 * @returns 包含 run 执行方法、status 状态查询、setLimit 动态调优与 close 退出清理方法的执行管理器对象
 */
export function createProcessSubagent(config: ReturnType<typeof loadConfig>, registry: ToolRegistry) {
  // 维护当前活跃的子任务控制器与其完成 Promise 的映射，用于容量统计与全量中断回收
  const active = new Map<AbortController, Promise<string>>();
  // 并发子进程上限（默认 1，可通过 setLimit 调整为 1~4）
  let limit = 1;
  let disposed = false;

  const run: SubagentRunner = (task, rounds, context, onProgress = () => {}) => {
    context.signal.throwIfAborted();
    if (disposed) throw new Error("子代理执行器已关闭");
    // 关键容量拦截：若当前运行中的任务数已达到并发上限，立即拒绝启动新任务
    if (active.size >= limit) throw new Error(`子代理已达到并发上限 ${limit}，未启动新任务`);
    if (context.model !== config.model) throw new Error("子代理模型必须与当前配置一致");
    const abort = new AbortController();
    const signal = AbortSignal.any([context.signal, abort.signal]);
    const completion = Promise.resolve().then(execute).finally(() => active.delete(abort));
    // 在异步启动前同步占用名额，防止同一轮连续调用超过上限。
    active.set(abort, completion);
    return completion;

    async function execute(): Promise<string> {
      signal.throwIfAborted();
      // 不继承 NODE_OPTIONS、调试参数或其他环境凭据；模型配置只经本机 IPC 传递。
      const child = fork(fileURLToPath(new URL("../subagent-worker.js", import.meta.url)), [], {
        cwd: context.cwd,
        execPath: process.execPath,
        execArgv: [],
        env: {},
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let closed = false;
      let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
      const exited = new Promise<void>((resolve) =>
        child.once("close", () => {
          closed = true;
          pending?.reject(new Error("子代理进程已退出"));
          resolve();
        }),
      );
      const abort = () => {
        pending?.reject(signal.reason);
        child.kill("SIGKILL");
      };
      child.on("error", () => pending?.reject(new Error("子代理进程启动或通信失败")));
      child.on("message", (message) => {
        if (!pending) {
          child.kill("SIGKILL");
          return;
        }
        const current = pending;
        pending = undefined;
        current.resolve(message);
      });
      signal.addEventListener("abort", abort, { once: true });
      let requestId = 0;
      const exchange = (message: object) =>
        new Promise<unknown>((resolve, reject) => {
          signal.throwIfAborted();
          if (closed || !child.connected) {
            reject(new Error("子代理进程未连接"));
            return;
          }
          pending = { resolve, reject };
          child.send(message, (error) => {
            if (error) reject(new Error("子代理进程通信失败"));
          });
        });
      try {
        signal.throwIfAborted();
        if (child.pid !== undefined) onProgress({ round: 0, pid: child.pid });
        const ready = await exchange({ type: "init", config });
        if (!ready || typeof ready !== "object" || !("type" in ready) || ready.type !== "ready") {
          throw new Error("子代理初始化失败");
        }
        const request: SubagentModel = async (messages, tools) => {
          const id = ++requestId;
          const response = await exchange({ type: "request", id, messages, tools });
          signal.throwIfAborted();
          if (
            !response ||
            typeof response !== "object" ||
            !("id" in response) ||
            response.id !== id ||
            !("result" in response) ||
            !isModelResult(response.result)
          ) {
            throw new Error("子代理模型请求失败或响应无效");
          }
          return response.result;
        };
        return await runSubagent(
          request,
          registry,
          task,
          rounds,
          Object.freeze({ ...context, signal }),
          onProgress,
        );
      } finally {
        signal.removeEventListener("abort", abort);
        child.kill("SIGKILL");
        await exited;
      }
    }
  };

  return {
    run,
    /** 查询当前配置的并发上限与正在运行中的子任务数量。 */
    status: () => ({ limit, running: active.size }),
    /**
     * 动态调整并发上限。
     *
     * 规则限制：
     * - 必须为 1 到 4 之间的整数；
     * - 新上限不能小于当前正在运行中的任务数量，否则报错拒绝。
     */
    setLimit(value: number): void {
      if (disposed) throw new Error("子代理执行器已关闭");
      if (!Number.isInteger(value) || value < 1 || value > 4) {
        throw new Error("并发上限必须是 1 到 4 的整数");
      }
      if (value < active.size) {
        throw new Error("新上限小于运行中的任务数，请先完成或取消任务");
      }
      limit = value;
    },
    /** 优雅关闭管理器：触发所有运行中子任务的 abort 信号，并等待其完全结算退出。 */
    async close(): Promise<void> {
      disposed = true;
      const jobs = [...active.entries()];
      for (const [abort] of jobs) abort.abort();
      await Promise.allSettled(jobs.map(([, completion]) => completion));
    },
  };
}
