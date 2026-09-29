import { randomUUID } from "node:crypto";
import type { Usage } from "../core/model.js";
import type { SubagentProgress, SubagentRunner } from "../core/subagent.js";
import type { StateContext } from "../core/state.js";
import type { ExtensionAPI } from "../core/tools.js";

/**
 * @file 后台异步任务扩展（registerTasks）。
 *
 * 核心架构与设计目标：
 * 1. 纯用户命令驱动：后台任务仅能由用户显式执行 `/task_start` 发起，不向大模型暴露启动后台任务的工具；
 * 2. 非阻塞前台输入：后台任务运行在独立子进程中，遇到文件读取工具调用时转为 `awaiting_approval` 状态挂起，
 *    用户通过 `/tasks` 查看并用 `/task_approve` 或 `/task_reject` 显式审批，绝不抢占前台交互；
 * 3. 持久化状态与离线中断防护：任务状态按会话持久化存储在 `background_tasks` 命名空间中；
 *    若宿主异常退出或重启，重新列出时会自动将遗留的 running/awaiting_approval 任务标记为 `interrupted`，
 *    绝不根据过期的 PID 误杀操作系统中已被重新分配的进程，也绝不静默自动重跑；
 * 4. 审批快照一致性防漂移：审批时记录参数快照 `snapshot`，只有当磁盘持久化的 pending 状态与快照严格一致时
 *    才允许放行，杜绝磁盘文件被意外改写导致的越权执行；
 * 5. 存储故障快速熔断：若状态文件写入失败，立即设置 storageFailure 并强行中止正在运行的任务，杜绝失控执行。
 */

// 状态持久化存储命名空间：存储在 .lcn-agent/background_tasks/<sessionFile>.json
const namespace = "background_tasks";

// 后台任务的全部合法生命周期状态枚举
const statuses = [
  "running", // 正在执行中
  "awaiting_approval", // 挂起等待用户显式审批工具调用
  "completed", // 任务已成功完成，结果已持久化
  "failed", // 任务因错误异常结束
  "cancelled", // 用户通过 /task_cancel 主动取消
  "timeout", // 任务运行超过 30 秒预算超时
  "interrupted", // 宿主重启或异常中断，已停止运行
] as const;

type Status = (typeof statuses)[number];

/**
 * 持久化在磁盘上的单个后台任务完整数据记录。
 */
type Task = {
  /** 任务唯一 UUID。 */
  id: string;
  /** 委派的具体任务文本。 */
  task: string;
  /** 当前任务生命周期状态。 */
  status: Status;
  /** 任务创建启动时的 ISO 8601 时间戳。 */
  startedAt: string;
  /** 任务最后一次状态更新的 ISO 8601 时间戳。 */
  updatedAt: string;
  /** 当前已执行完毕的工具循环轮次（0～5）。 */
  round: number;
  /** 已累积报告的 token 用量统计。 */
  reportedUsage: Usage;
  /** 提供商未报告 usage 的轮次统计。 */
  unreportedRounds: number;
  /** 执行本次任务的 Worker 子进程操作系统 PID（仅运行期间有效）。 */
  pid?: number;
  /** 任务成功完成后的最终结果 JSON 字符串（上限 64 KiB）。 */
  result?: string;
  /** 任务失败时的错误说明文本。 */
  error?: string;
  /** 处于 awaiting_approval 挂起状态时，待审批的工具调用详情。 */
  pending?: { approvalId: string; name: string; argumentsJson: string; callId: string };
};

/**
 * 当前内存中正在运行的活跃任务控制句柄。
 */
type Active = {
  /** 对应任务的 ID。 */
  id: string;
  /** 用于状态持久化读写的独立记账上下文。 */
  context: StateContext;
  /** 任务取消控制器，取消时触发 signal.abort()。 */
  abort: AbortController;
  /** 任务异步完成的 Promise。 */
  done: Promise<void>;
  /** 挂起等待审批时的内存句柄（包含审批 ID、参数快照与放行回调）。 */
  approval?: { id: string; snapshot: string; answer: (value: boolean) => void };
};

/**
 * 注册后台任务命令族（/task_start, /tasks, /task_show, /task_approve, /task_reject, /task_cancel）。
 *
 * @param api 扩展 API，用于注册命令和状态读写
 * @param run 统一的子任务执行器（由 createProcessSubagent 提供的子进程执行入口）
 */
export function registerTasks(api: ExtensionAPI, run: SubagentRunner) {
  let active: Active | undefined;
  let disposed = false;
  let storageFailure = false;

  api.onDispose(() => {
    disposed = true;
    active?.abort.abort();
  });

  /** 从磁盘读取指定会话的后台任务列表，并执行严格的数据格式校验与防御。 */
  function read(context: StateContext): Task[] {
    const data = api.readState(context, namespace);
    if (data === undefined) return [];
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 1 ||
      !("items" in data) ||
      !Array.isArray(data.items)
    )
      throw new Error("后台任务记录损坏或版本不支持");
    const ids = new Set<string>();
    for (const item of data.items) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !item.id ||
        ids.has(item.id) ||
        typeof item.task !== "string" ||
        !item.task.trim() ||
        Buffer.byteLength(item.task) > 64 * 1024 ||
        !statuses.includes(item.status) ||
        typeof item.startedAt !== "string" ||
        typeof item.updatedAt !== "string" ||
        !Number.isInteger(item.round) ||
        item.round < 0 ||
        item.round > 5 ||
        !Number.isInteger(item.unreportedRounds) ||
        item.unreportedRounds < 0 ||
        item.unreportedRounds > 5 ||
        !item.reportedUsage ||
        ![item.reportedUsage.promptTokens, item.reportedUsage.completionTokens, item.reportedUsage.totalTokens].every(
          (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
        ) ||
        (item.pid !== undefined && (!Number.isInteger(item.pid) || item.pid <= 0)) ||
        (item.result !== undefined &&
          (typeof item.result !== "string" || Buffer.byteLength(item.result) > 64 * 1024)) ||
        (item.error !== undefined && typeof item.error !== "string") ||
        (item.pending !== undefined &&
          (!item.pending ||
            typeof item.pending.approvalId !== "string" ||
            typeof item.pending.name !== "string" ||
            typeof item.pending.argumentsJson !== "string" ||
            typeof item.pending.callId !== "string"))
      ) {
        throw new Error("后台任务记录损坏，保留原文件");
      }
      ids.add(item.id);
    }
    return data.items;
  }

  /** 将后台任务列表原子落盘到会话状态中。 */
  function save(context: StateContext, items: Task[]): void {
    api.writeState(context, namespace, { version: 1, items });
  }

  /**
   * 获取并收敛后台任务列表。
   *
   * 离线中断检测：若发现磁盘状态为 running 或 awaiting_approval，但当前内存中没有对应的活跃任务
   * （说明进程曾异常终止或重启），自动将其状态收敛为 interrupted，绝不根据旧 PID 杀进程，也不自动重跑。
   */
  function list(context: StateContext): Task[] {
    if (storageFailure) throw new Error("后台任务状态保存失败，请检查存储后重启；未重跑任务");
    const items = read(context);
    let changed = false;
    for (const item of items) {
      if (
        (item.status === "running" || item.status === "awaiting_approval") &&
        !(active?.id === item.id && active.context.sessionFile === context.sessionFile)
      ) {
        item.status = "interrupted";
        item.error = "上次运行已中断，结果未知；未自动重跑";
        item.updatedAt = new Date().toISOString();
        delete item.pending;
        changed = true;
      }
    }
    if (changed) save(context, items);
    return items;
  }

  /** 安全修改并持久化当前任务状态；若持久化写入失败，立即熔断中止任务。 */
  function update(job: Active, change: (item: Task) => void): void {
    try {
      const items = read(job.context);
      const item = items.find((entry) => entry.id === job.id);
      if (!item) throw new Error("后台任务记录丢失");
      change(item);
      item.updatedAt = new Date().toISOString();
      save(job.context, items);
    } catch {
      storageFailure = true;
      job.abort.abort();
      throw new Error("后台任务状态保存失败，已停止任务");
    }
  }

  /** 获取当前正在运行的活跃任务，如果 ID 不匹配或不在当前会话中则报错。 */
  function current(id: string, context: StateContext): Active {
    context.signal.throwIfAborted();
    if (!active || active.id !== id.trim() || active.context.sessionFile !== context.sessionFile) {
      throw new Error("请提供当前会话中正在运行的完整任务编号");
    }
    return active;
  }

  // /task_start <task>: 启动一个新的后台异步任务
  api.registerCommand({
    name: "task_start",
    execute(args, context) {
      context.signal.throwIfAborted();
      if (disposed) throw new Error("后台任务扩展已卸载");
      if (active) throw new Error("已有后台任务运行，请先完成或取消");
      if (!context.sessionFile) throw new Error("请先 /new 或 /resume 选择会话");
      const task = args.trim();
      if (!task || Buffer.byteLength(task) > 64 * 1024) throw new Error("任务不能为空或超过 64 KiB");
      const items = list(context);
      const id = randomUUID();
      const now = new Date().toISOString();
      items.push({
        id,
        task,
        status: "running",
        startedAt: now,
        updatedAt: now,
        round: 0,
        reportedUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        unreportedRounds: 0,
      });
      save(context, items);
      // 状态收尾必须能在执行信号取消后落盘，使用独立的记账信号。
      const bookkeeping = { cwd: context.cwd, sessionFile: context.sessionFile, signal: new AbortController().signal };
      const job: Active = { id, context: bookkeeping, abort: new AbortController(), done: Promise.resolve() };
      active = job;
      const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(30_000)]);

      // 异步授权回调：当子任务模型请求工具时被调用，将任务置为 awaiting_approval 挂起等待显式命令审批
      const confirm = (name: string, argumentsJson: string, callId: string) =>
        new Promise<boolean>((resolve, reject) => {
          signal.throwIfAborted();
          const approvalId = randomUUID();
          const pending = { approvalId, name, argumentsJson, callId };
          update(job, (item) => {
            item.status = "awaiting_approval";
            item.pending = pending;
          });
          const cancelled = () => {
            job.approval = undefined;
            reject(signal.reason);
          };
          signal.addEventListener("abort", cancelled, { once: true });
          job.approval = {
            id: approvalId,
            snapshot: JSON.stringify(pending),
            answer: (value) => {
              signal.removeEventListener("abort", cancelled);
              job.approval = undefined;
              resolve(value);
            },
          };
        });

      // 进度回调：更新轮次、PID 和 token 用量到持久化记录中
      const progress = (event: SubagentProgress) =>
        update(job, (item) => {
          item.round = event.round;
          if (event.pid !== undefined) item.pid = event.pid;
          if (event.usage === null) item.unreportedRounds++;
          else if (event.usage !== undefined) {
            item.reportedUsage.promptTokens += event.usage.promptTokens;
            item.reportedUsage.completionTokens += event.usage.completionTokens;
            item.reportedUsage.totalTokens += event.usage.totalTokens;
          }
        });

      // 异步触发子任务执行，不阻塞前台命令返回
      job.done = Promise.resolve()
        .then(() =>
          run(
            task,
            5,
            {
              cwd: context.cwd,
              sessionFile: context.sessionFile!,
              model: context.model,
              callId: id,
              signal,
              confirm,
            },
            progress,
          ),
        )
        .then((result) => {
          signal.throwIfAborted();
          update(job, (item) => {
            item.status = "completed";
            item.result = result;
            delete item.pending;
          });
        })
        .catch(() => {
          const status = signal.aborted
            ? signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
              ? "timeout"
              : "cancelled"
            : "failed";
          if (!storageFailure)
            update(job, (item) => {
              item.status = status;
              item.error = "任务未完成，请查看诊断记录";
              delete item.pending;
            });
        })
        .catch(() => {
          storageFailure = true;
        })
        .finally(() => {
          if (active === job) active = undefined;
        });

      return `已启动后台任务：${id}；使用 /tasks 查看进度与待审批读取`;
    },
  });

  // /tasks: 查看当前会话的所有后台任务概览（隐去超长 result）
  api.registerCommand({
    name: "tasks",
    execute(args, context) {
      if (args.trim()) throw new Error("用法：/tasks");
      return JSON.stringify(
        list(context).map(({ result, ...item }) => item),
        null,
        2,
      );
    },
  });

  // /task_show <id>: 查看单个后台任务的完整详细信息（包含完整 result 与 pending 审批项）
  api.registerCommand({
    name: "task_show",
    execute(args, context) {
      const item = list(context).find((entry) => entry.id === args.trim());
      if (!item) throw new Error("请提供当前会话中存在的完整任务编号");
      return JSON.stringify(item, null, 2);
    },
  });

  // /task_approve <id> <approvalId> 和 /task_reject <id> <approvalId>: 用户显式审批挂起的工具调用
  for (const [name, answer] of [
    ["task_approve", true],
    ["task_reject", false],
  ] as const) {
    api.registerCommand({
      name,
      execute(args, context) {
        const parts = args.trim().split(/\s+/);
        if (parts.length !== 2) throw new Error(`用法：/${name} 完整任务编号 完整审批编号`);
        const job = current(parts[0], context);
        if (!job.approval || job.approval.id !== parts[1])
          throw new Error("审批已失效或编号不匹配，请重新 /tasks 查看");
        const approval = job.approval;
        // 防漂移防篡改检查：确保当前磁盘待审批记录与当初内存生成的快照完全一致
        update(job, (item) => {
          if (JSON.stringify(item.pending) !== approval.snapshot) throw new Error("审批参数记录已变化");
          item.status = "running";
          delete item.pending;
        });
        approval.answer(answer);
        return answer ? "已批准本次读取" : "已拒绝本次读取";
      },
    });
  }

  // /task_cancel <id>: 显式取消并中止正在运行的后台任务
  api.registerCommand({
    name: "task_cancel",
    async execute(args, context) {
      const job = current(args, context);
      job.abort.abort();
      await job.done;
      if (storageFailure) throw new Error("任务已停止，但状态保存失败");
      return "后台任务已停止并回收子进程";
    },
  });

  return {
    async close(): Promise<void> {
      disposed = true;
      active?.abort.abort();
      await active?.done;
      if (storageFailure) throw new Error("后台任务状态保存失败");
    },
  };
}
