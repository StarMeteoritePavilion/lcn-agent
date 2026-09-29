import type { SubagentRunner } from "../core/subagent.js";
import type { ExtensionAPI } from "../core/tools.js";

/**
 * @file 只读子代理扩展（run_subagent）。
 *
 * 核心架构与设计目标：
 * 1. 独立上下文与任务委派：子任务仅接收明确的 task 字符串，在内存中维护全新的 messages 对话历史，
 *    不自动继承父会话的历史消息、项目记忆或 Skills，避免长上下文污染，降低模型幻觉。
 * 2. 受限的只读工具入口：子任务仅开放文件读取类工具（read_file、search_file、list_files），
 *    硬编码白名单防御，拒绝文件写入、系统命令、网络工具或递归调用；模型通信仍会联网。
 * 3. 授权边界不穿透：父任务批准委派（run_subagent）不代表静默放行后续操作，
 *    子代理的每一次底层文件读取仍需经过宿主注册表的 Schema 校验与用户终端逐次确认。
 * 4. 串行执行与生命周期管理：当前阶段严格限制同时只能运行一个子代理（基于 running 控制器互斥），
 *    扩展卸载时通过 onDispose 自动发出取消信号；全链路共享父任务剩余的时间预算，不重新计时。
 * 5. 诊断日志与链路追踪：每个子任务在父会话目录下生成独立的诊断 JSONL 文件，
 *    将每次工具调用的 callId 序列化为 `[父callId, 轮次, 子callId]` 元组，实现清晰的调用链路追溯。
 */

// 单个任务文本与模型聚合结果的字节上限（64 KiB）
const maxBytes = 64 * 1024;

/**
 * 向宿主注册 `run_subagent` 模型工具。
 *
 * 内部维护了 `running` 信号控制器，在等待宿主执行器时拒绝本扩展的重叠调用；执行器另限制前后台共用的子进程数量。
 *
 * @param api 扩展 API 接口，用于注册工具与监听扩展注销事件
 * @param run 宿主提供的子进程执行入口，共享前台与后台的串行限制
 */
export function registerSubagent(api: ExtensionAPI, run: SubagentRunner): void {
  // 当前正在运行的子任务取消控制器；存在值时表示有子任务正在执行
  let running: AbortController | undefined;
  let disposed = false;

  // 扩展注销时的清理回调：标记已注销，并中断正在运行的子任务请求
  api.onDispose(() => {
    disposed = true;
    running?.abort();
  });

  // 向宿主注册可被大模型调用的 run_subagent 函数
  api.registerTool({
    definition: {
      type: "function",
      function: {
        name: "run_subagent",
        description: "经确认串行执行独立只读子任务；仅可读取、搜索文件和列目录，每次读取仍须确认。",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              minLength: 1,
              maxLength: maxBytes,
              description: "委派给子代理的具体任务，上限 64 KiB",
            },
            maxRounds: {
              type: "integer",
              minimum: 1,
              maximum: 5,
              description: "子任务执行的最大循环轮次，1 到 5 之间，默认 5",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    },
    async execute(args, context) {
      context.signal.throwIfAborted();
      if (disposed) throw new Error("子代理扩展已卸载");
      // 串行互斥保证：若当前已有子代理正在运行，立即报错拒绝重叠并发
      if (running) throw new Error("已有子代理运行，当前只允许串行调用");

      // 运行时参数校验
      if (typeof args !== "object" || args === null || !("task" in args) || typeof args.task !== "string") {
        throw new Error("子代理参数必须包含 task");
      }
      const maxRounds = "maxRounds" in args ? args.maxRounds : 5;
      if (!Number.isInteger(maxRounds) || typeof maxRounds !== "number" || maxRounds < 1 || maxRounds > 5) {
        throw new Error("子代理 maxRounds 必须为 1 到 5 的整数");
      }
      if (!args.task.trim() || Buffer.byteLength(args.task) > maxBytes) {
        throw new Error("子代理任务为空或超过 64 KiB");
      }

      // 初始化当前运行实例的 AbortController
      running = new AbortController();
      // 关键设计：组合父调用的取消信号与子代理运行控制器；
      // 子代理共享父任务当前轮次剩余的 30 秒预算，不因子代理开启而重新发放计时器。
      const signal = AbortSignal.any([context.signal, running.signal]);

      try {
        return await run(args.task, maxRounds, Object.freeze({ ...context, signal }));
      } finally {
        // 运行完毕或异常退出后重置 running 标记，允许后续子代理运行
        running = undefined;
      }
    },
  });
}
