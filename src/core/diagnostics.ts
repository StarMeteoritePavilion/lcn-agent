import { listSessions, Session } from "./session.js";
import { join } from "node:path";
import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** 单次模型请求的 token 消耗统计。 */
type Usage = {
  /** 输入（提示词）消耗的 token 数。 */
  promptTokens: number;
  /** 输出（生成内容）消耗的 token 数。 */
  completionTokens: number;
  /** 总 token 消耗（promptTokens + completionTokens）。 */
  totalTokens: number;
};

/**
 * 操作的结束状态。
 * - "success"：正常完成
 * - "error"：执行过程中发生错误
 * - "cancelled"：被用户主动取消（Ctrl+C）
 * - "timeout"：超时终止
 */
type Outcome = "success" | "error" | "cancelled" | "timeout";

/**
 * 一次操作的句柄，由 start() 返回，传给 end() 以配对记录。
 * - id:      全局唯一的操作标识（UUID）
 * - started: 由 performance.now() 获取的高精度单调时钟戳（毫秒），用于计算耗时
 */
type Operation = { id: string; started: number };

const directory = ".lcn-agent/diagnostics";

/**
 * 诊断记录器接口。
 *
 * 由 createDiagnostics() 创建，在 Agent 运行期间用于记录每一步操作（模型请求或工具执行）
 * 的开始、结束与最终状态，持久化为 JSONL 文件以供事后排查。
 */
export type Diagnostics = {
  /**
   * 记录一次操作的开始。
   *
   * @param kind    操作类型："model" 表示模型请求，"tool" 表示工具执行
   * @param name    操作名称（模型名称或工具函数名）
   * @param round   当前所处的 Agent 循环轮次（从 1 开始）
   * @param callId  工具调用 ID（仅 kind 为 "tool" 时有意义），默认为 null
   * @returns 操作句柄 Operation，需传给 end() 以配对结束记录
   */
  start(kind: "model" | "tool", name: string, round: number, callId?: string | null): Operation;

  /**
   * 记录一次操作的结束。
   *
   * @param operation 由 start() 返回的操作句柄，用于配对并计算耗时
   * @param outcome   操作结果状态
   * @param reason    结果的描述信息（如错误消息、完成原因等）
   * @param usage     token 消耗统计，仅模型请求时有值，其余情况传 null
   */
  end(operation: Operation, outcome: Outcome, reason: string, usage?: Usage | null): void;

  /**
   * 记录整次 Agent 运行的结束。
   *
   * @param reason 结束原因（如 "completed"、"loop_limit"、"error" 等）
   * @param round  结束时所处的轮次
   */
  finish(reason: string, round: number): void;

  /**
   * 关闭底层文件描述符，释放系统资源。
   * 必须在 Agent 运行结束后调用（通常放在 finally 块中）。
   */
  close(): void;
};

/**
 * 诊断日志持久化写入失败时抛出的特定错误类型。
 *
 * 与 SessionWriteError 同理：写入失败意味着后续操作无法被审计，
 * 必须立即中止运行，而非静默吞掉错误继续执行工具。
 */
export class DiagnosticWriteError extends Error {}

/**
 * 为指定会话创建诊断记录器。
 *
 * 在 `.lcn-agent/diagnostics/<会话文件名>/` 目录下新建一个以 UUID 命名的 JSONL 文件，
 * 第一行写入运行头信息 `{ type: "run", version: 1, session, model, at }`，
 * 后续通过返回的 Diagnostics 接口方法逐条追加 start / end / finish 记录。
 *
 * 每个会话可能包含多次运行（多个 JSONL 文件），例如恢复会话后继续对话时会生成新的诊断文件。
 *
 * @param session 当前会话对象，用于获取会话文件名和模型名称
 * @returns Diagnostics 接口对象，包含 start / end / finish / close 四个方法
 * @throws {DiagnosticWriteError} 运行头写入失败时抛出（文件描述符会在抛出前关闭）
 */
export function createDiagnostics(session: Session): Diagnostics {
  // 以会话文件名作为子目录名，同一会话的多次运行记录集中存放。
  const folder = join(directory, session.file);
  // 确保诊断目录存在（mkdirSync 参数说明见 session.ts createSession，此处跳过）。
  mkdirSync(folder, { recursive: true });

  // openSync: 创建诊断 JSONL 文件并返回文件描述符 fd。
  // - 参数 1 path: 完整文件路径 `.lcn-agent/diagnostics/<session.file>/<uuid>.jsonl`。
  // - 参数 2 flags: "wx" —— 独占创建，防止 UUID 冲突覆盖已有文件（说明同 session.ts）。
  // - 参数 3 mode: 0o600 —— 仅所有者可读写。
  // 使用文件描述符而非路径进行后续写入，避免每次 appendFileSync 都重新 open/close 文件。
  const descriptor = openSync(join(folder, `${randomUUID()}.jsonl`), "wx", 0o600);

  /**
   * 将一条诊断记录写入 JSONL 文件。
   *
   * 自动在记录中追加 `at` 字段（ISO 8601 时间戳），用于事后定位事件发生时间。
   * 写入失败直接抛出 DiagnosticWriteError 停止运行；不能把日志错误吞掉后继续执行工具。
   *
   * @param record 待写入的诊断记录对象（不含时间戳，由本函数自动添加）
   * @throws {DiagnosticWriteError} 磁盘写入失败时抛出
   */
  function write(record: object): void {
    try {
      appendFileSync(
        // 参数 1: 文件描述符 fd（而非路径），直接向已打开的文件追加内容。
        descriptor,
        // 参数 2 data: 将记录展开并追加 `at` 时间戳，序列化为 JSON 后加换行符。
        // new Date().toISOString() 生成 ISO 8601 格式的 UTC 时间字符串。
        JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n",
        // 参数 3 options: flush: true —— 立即刷盘（说明同 session.ts）。
        { flush: true },
      );
    } catch {
      throw new DiagnosticWriteError("诊断记录写入失败，停止运行；请检查存储路径和权限");
    }
  }

  // 写入运行头记录。若失败则立即关闭文件描述符，释放资源后再向上抛出错误。
  try {
    write({
      type: "run",
      version: 1,
      session: session.file,
      model: session.model,
    });
  } catch (error) {
    // closeSync: 关闭文件描述符（说明同 session.ts lockSessions）。
    closeSync(descriptor);
    throw error;
  }

  return {
    start(
      kind: "model" | "tool",
      name: string,
      round: number,
      callId: string | null = null,
    ): Operation {
      const id = randomUUID();
      write({ type: "start", operationId: id, kind, name, round, callId });
      // 日期用于定位事件；单调时钟用于测量耗时，避免系统时间调整影响差值。
      // performance.now(): 返回高精度单调递增的毫秒时间戳，不受系统时钟回拨影响。
      return { id, started: performance.now() };
    },
    end(operation: Operation, outcome: Outcome, reason: string, usage: Usage | null = null): void {
      write({
        type: "end",
        operationId: operation.id,
        // performance.now() - operation.started: 计算操作耗时（毫秒），
        // 基于单调时钟差值，不受系统时间调整干扰。
        elapsedMs: performance.now() - operation.started,
        outcome,
        reason,
        usage,
      });
    },
    finish(reason: string, round: number): void {
      write({ type: "finish", reason, round });
    },
    close(): void {
      // 关闭文件描述符，释放操作系统句柄资源（说明同 session.ts lockSessions）。
      closeSync(descriptor);
    },
  };
}

/**
 * 以纯文本格式展示指定会话的诊断记录。
 *
 * 读取该会话在 `.lcn-agent/diagnostics/<文件名>/` 下的所有运行 JSONL 文件，
 * 逐行校验并解析每条记录（run / start / end / finish），
 * 生成人类可读的诊断摘要。此操作为只读的，不会执行或重试任何工具。
 *
 * 可通过交互命令 `/diagnostics 完整会话文件名` 调用，
 * 适用于排查无法恢复的会话（如 loadSession 拒绝加载的情况）。
 *
 * @param file 会话文件名（需来自 listSessions() 的有效文件名）
 * @returns 格式化的诊断摘要文本，包含每次运行的操作记录与状态
 * @throws {Error} 会话文件名不在已知列表中时抛出错误
 */
export function showDiagnostics(file: string): string {
  // 校验文件名合法性（说明同 session.ts loadSession 的 includes 检查）。
  if (!listSessions().includes(file)) {
    throw new Error("会话不存在，请使用 /sessions 查看完整文件名");
  }

  const folder = join(directory, file);
  let files: string[];

  try {
    // readdirSync / filter / sort 说明同 session.ts listSessions，此处跳过。
    files = readdirSync(folder)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
  } catch (error) {
    // 若诊断目录不存在（ENOENT），说明该会话从未产生过诊断记录，属于正常情况。
    // "code" in error: 检查 error 对象是否具有 Node.js 文件系统错误的 code 属性。
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "此会话暂无诊断记录\n";
    }
    // 其他错误（如权限不足）向上抛出。
    throw error;
  }

  const lines: string[] = [];

  // 逐个解析该会话下的每个运行文件。
  for (const name of files) {
    lines.push(`运行文件：${name}`);
    // pending: 已开始但尚未结束的操作 Map，key 为 operationId，value 为可读描述文本。
    const pending = new Map<string, string>();
    // seen: 已出现过的所有 operationId 集合，用于检测 ID 重复。
    const seen = new Set<string>();
    // finished: 是否已遇到 finish 记录；finish 之后不应再有任何记录。
    let finished = false;
    // damaged: 是否检测到文件损坏（行解析失败或末尾未完整写入）。
    let damaged = false;
    let text: string;

    try {
      // readFileSync + TextDecoder 说明同 session.ts loadSession，此处跳过。
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(folder, name)));
    } catch {
      lines.push("文件无法读取或 UTF-8 无效；结果未知");
      continue;
    }

    // split + pop 校验末尾换行符的逻辑说明同 session.ts loadSession。
    const records = text.split("\n");
    const tail = records.pop();
    if (!records.length) {
      lines.push("缺少完整格式头；结果未知");
      continue;
    }

    for (let index = 0; index < records.length; index++) {
      try {
        const record: unknown = JSON.parse(records[index]);
        // 每条记录必须是对象且包含合法的 ISO 8601 时间戳 `at`。
        // Date.parse: 解析日期字符串并返回毫秒时间戳；无效日期返回 NaN。
        // Number.isFinite: 排除 NaN 和 Infinity，确保时间戳合法。
        if (
          !object(record) ||
          typeof record.at !== "string" ||
          !Number.isFinite(Date.parse(record.at))
        ) {
          throw new Error("记录缺少有效时间");
        }

        if (index === 0) {
          // ── 第一行：运行头校验（type / version / session / model） ──
          if (
            record.type !== "run" ||
            record.version !== 1 ||
            record.session !== file ||
            typeof record.model !== "string"
          ) {
            throw new Error("格式头不合法");
          }
          lines.push(`开始时间：${record.at}，模型：${record.model}`);
        } else if (finished) {
          // finish 记录之后不应存在任何后续行。
          throw new Error("运行结束后仍有记录");
        } else if (record.type === "start") {
          // ── start 记录校验 ──
          // operationId 非空字符串且不得重复；kind 必须为 "model" | "tool"；
          // round 必须为正整数；callId 只能为 null 或字符串。
          if (
            typeof record.operationId !== "string" ||
            !record.operationId ||
            seen.has(record.operationId) ||
            (record.kind !== "model" && record.kind !== "tool") ||
            typeof record.name !== "string" ||
            !Number.isInteger(record.round) ||
            Number(record.round) < 1 ||
            (record.callId !== null && typeof record.callId !== "string")
          ) {
            throw new Error("开始记录不合法");
          }

          // 登记此操作 ID 为"已见过"和"待结束"状态。
          seen.add(record.operationId);
          pending.set(
            record.operationId,
            `${record.kind} ${record.name} 第 ${record.round} 轮` +
              (record.callId === null ? "" : ` 调用 ${record.callId}`),
          );
        } else if (record.type === "end") {
          // ── end 记录校验 ──
          // operationId 必须对应一个尚在 pending 中的 start 记录；
          // elapsedMs 必须为非负有限数；outcome 必须为四种合法状态之一。
          if (
            typeof record.operationId !== "string" ||
            !pending.has(record.operationId) ||
            typeof record.elapsedMs !== "number" ||
            !Number.isFinite(record.elapsedMs) ||
            record.elapsedMs < 0 ||
            !["success", "error", "cancelled", "timeout"].includes(String(record.outcome)) ||
            typeof record.reason !== "string"
          ) {
            throw new Error("结束记录不合法或未配对");
          }

          // usage 字段若非 null，则校验其三个 token 计数必须均为非负有限数。
          if (
            record.usage !== null &&
            (!object(record.usage) ||
              ![
                record.usage.promptTokens,
                record.usage.completionTokens,
                record.usage.totalTokens,
              ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0))
          ) {
            throw new Error("用量记录不合法");
          }

          // 输出该操作的完整摘要：描述、结果、耗时、原因与 token 用量。
          // toFixed(1): 保留一位小数，避免浮点数显示过长。
          lines.push(
            `${pending.get(record.operationId)}：${record.outcome}，` +
              `${record.elapsedMs.toFixed(1)}ms，原因：${record.reason}，用量：` +
              (record.usage === null ? "未报告或不适用" : JSON.stringify(record.usage)),
          );
          // 核销已完成的操作，从 pending 中移除。
          pending.delete(record.operationId);
        } else if (record.type === "finish") {
          // ── finish 记录校验 ──
          // reason 必须为字符串；round 必须为非负整数（可为 0 表示运行尚未进入循环即结束）。
          if (
            typeof record.reason !== "string" ||
            !Number.isInteger(record.round) ||
            Number(record.round) < 0
          ) {
            throw new Error("运行结束记录不合法");
          }
          finished = true;
          lines.push(`运行结束：${record.reason}`);
        } else {
          throw new Error("未知记录类型");
        }
      } catch {
        lines.push(`第 ${index + 1} 行损坏，停止解析后续记录；原文件不变`);
        damaged = true;
        break;
      }

    }

    // 完成逐行解析后，再汇总整个文件的状态。

    // 末尾非空说明最后一行写入未完成（与 session.ts loadSession 的检查逻辑一致）。
    if (tail !== "") {
      lines.push(`第 ${records.length + 1} 行未完整写入；原文件不变`);
      damaged = true;
    }
    // 列出所有仍在 pending 中的操作——这些操作已开始但没有结束记录，结果未知。
    for (const label of pending.values()) {
      lines.push(`${label}：结果未知（没有有效的结束记录）`);
    }
    // 未正常 finish 或文件损坏时给出总结性警告。
    if (!finished || damaged) {
      lines.push("运行记录不完整，不自动重试");
    }
  }
  return lines.length ? lines.join("\n") + "\n" : "此会话暂无诊断记录\n";
}

/** 类型守卫：判断值是否为普通对象（详细说明见 session.ts 同名函数）。 */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
