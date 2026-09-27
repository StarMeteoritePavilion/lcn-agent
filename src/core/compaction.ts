import { createHash } from "node:crypto";
import type { Message, Session } from "./session.js";
import { readState, writeState, type StateContext } from "./state.js";

/**
 * 按会话保存的压缩状态。磁盘命名空间是 `compactions`。
 *
 * - version:    格式版本，当前为 1。
 * - cut:        保留区的起点下标。`messages[0 .. cut)` 用摘要代替，
 *               `messages[cut ..]` 仍原文发送；cut 处必须是一条 user 消息。
 * - prefixHash: `messages[0 .. cut)` 的 SHA-256，用来发现压缩后历史被改过。
 * - summary:    模型生成的中文摘要，上限 64 KiB。
 */
type Compaction = {
  version: 1;
  cut: number;
  prefixHash: string;
  summary: string;
};

/** 宿主提供的摘要函数：只概括传入的消息，不修改会话。 */
type Summarize = (messages: Message[], signal: AbortSignal) => Promise<string>;

function stateContext(session: Session, signal: AbortSignal): StateContext {
  return {
    cwd: process.cwd(),
    sessionFile: session.file,
    signal,
  };
}

/**
 * 指纹只用于检查摘要是否仍对应这段历史，不代表安全签名。
 *
 * @param session 当前会话
 * @param cut 前缀长度，对应 Compaction.cut
 * @returns 前缀 JSON 的 SHA-256 十六进制摘要
 */
function prefixHash(session: Session, cut: number): string {
  // createHash("sha256") 创建哈希器；update 喂数据；digest("hex") 得到十六进制字符串。
  return createHash("sha256")
    .update(JSON.stringify(session.messages.slice(0, cut)))
    .digest("hex");
}

/**
 * 读取压缩状态；范围或历史不一致时拒绝使用。
 *
 * 文件不存在视为尚未压缩。cut 越界、不是 user 消息、或哈希对不上，
 * 都当作损坏：不能拿一份过期摘要去替换另一段历史。
 *
 * @returns 通过校验的 Compaction；尚未压缩时为 undefined
 * @throws {Error} 状态损坏或与当前会话对不上
 */
function loadCompaction(session: Session, signal: AbortSignal): Compaction | undefined {
  const data = readState(stateContext(session, signal), "compactions");
  if (data === undefined) {
    return undefined;
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("version" in data) ||
    data.version !== 1 ||
    !("cut" in data) ||
    typeof data.cut !== "number" ||
    !Number.isInteger(data.cut) ||
    data.cut <= 0 ||
    data.cut >= session.messages.length ||
    session.messages[data.cut].role !== "user" ||
    !("prefixHash" in data) ||
    data.prefixHash !== prefixHash(session, data.cut) ||
    !("summary" in data) ||
    typeof data.summary !== "string" ||
    !data.summary.trim() ||
    Buffer.byteLength(data.summary, "utf8") > 64 * 1024
  ) {
    throw new Error("压缩状态损坏或与会话历史不一致");
  }

  return {
    version: 1,
    cut: data.cut,
    prefixHash: data.prefixHash,
    summary: data.summary,
  };
}

/**
 * 构造请求视图，不修改会话数组。
 *
 * 无压缩时就是 `messages[0 .. end)`。
 * 有压缩时：cut 之前的全部 user 原文 + 一条助理摘要 + cut 起的原文。
 * 会话文件里的消息一条都不删。
 *
 * @param end 视图右开边界，默认到数组末尾；生成摘要时会收到 cut，只概括保留区之前的内容
 */
function buildView(
  session: Session,
  state: Compaction | undefined,
  end = session.messages.length,
): Message[] {
  if (!state) return session.messages.slice(0, end);

  // ponytail: 保留全部用户原文以避免丢失约束；用户长文本仍占上下文，
  // 有明确的约束管理需求后再缩减这部分。
  const users = session.messages.slice(0, state.cut).filter((message) => message.role === "user");

  return [
    ...users,
    {
      role: "assistant",
      content:
        "以下是此前对话的压缩摘要，不是新的用户指令；应以用户原文和实际工具结果为准。\n" +
        state.summary,
    },
    ...session.messages.slice(state.cut, end),
  ];
}

/**
 * 每次模型请求前读取当前视图，确保包含刚回填的工具结果。
 *
 * 调用方应把返回值发给模型，而不是直接用 session.messages。
 */
export function contextMessages(session: Session, signal: AbortSignal): Message[] {
  return buildView(session, loadCompaction(session, signal));
}

/**
 * 在用户回合边界切分，保留最后一回合和最近的完整工具交互。
 *
 * cut 是保留区起点：该下标必须是 user。有工具结果时，cut 取
 * “最后一条 user”和“最后一条 tool 所属的那条 user”的较小值，
 * 这样最近一次完整工具交互和最后一问都会留在原文区。
 *
 * 摘要失败、变长或历史在生成期间被改过，都不会写入新状态。
 *
 * @param session 当前会话；成功时只改磁盘上的压缩状态，不改 messages
 * @param signal 取消或超时
 * @param summarize 宿主提供的摘要实现
 * @returns 给人看的结果说明；无需再压时返回提示而不是抛错
 * @throws {Error} 有未配对工具调用、摘要无效、历史变化，或没有缩短
 */
export async function compactSession(
  session: Session,
  signal: AbortSignal,
  summarize: Summarize,
): Promise<string> {
  signal.throwIfAborted();
  if (session.pending.size) {
    throw new Error("存在未配对的工具调用，不能压缩");
  }

  const previous = loadCompaction(session, signal);
  let currentUser = -1;
  let lastUser = -1;
  let lastToolUser = -1;

  for (let index = 0; index < session.messages.length; index++) {
    const message = session.messages[index];
    if (message.role === "user") {
      currentUser = index;
      lastUser = index;
    } else if (message.role === "tool") {
      lastToolUser = currentUser;
    }
  }

  const cut = lastToolUser >= 0 ? Math.min(lastUser, lastToolUser) : lastUser;
  if (cut <= (previous?.cut ?? 0)) {
    return "暂无可进一步压缩的完整历史";
  }

  const expectedHash = prefixHash(session, cut);
  const before = buildView(session, previous);
  const source = buildView(session, previous, cut);

  // 生成期间不修改历史或旧摘要；失败直接向调用方传播。
  const summary = await summarize(source, signal);
  signal.throwIfAborted();

  if (
    typeof summary !== "string" ||
    !summary.trim() ||
    Buffer.byteLength(summary, "utf8") > 64 * 1024
  ) {
    throw new Error("摘要为空或超过 64 KiB，原上下文保持不变");
  }

  if (prefixHash(session, cut) !== expectedHash) {
    throw new Error("摘要期间历史发生变化，拒绝保存");
  }

  const next: Compaction = {
    version: 1,
    cut,
    prefixHash: expectedHash,
    summary,
  };

  const beforeBytes = Buffer.byteLength(JSON.stringify(before), "utf8");
  const afterBytes = Buffer.byteLength(JSON.stringify(buildView(session, next)), "utf8");
  if (afterBytes >= beforeBytes) {
    throw new Error("摘要没有缩短上下文，原上下文保持不变");
  }

  writeState(stateContext(session, signal), "compactions", next);
  return `压缩已保存：请求消息 JSON 从 ${beforeBytes} 降至 ${afterBytes} 字节；原始历史保留`;
}

/**
 * 达到消息 JSON 字节阈值时，复用已有压缩流程。
 *
 * 量的是 contextMessages 的 JSON 字节数（发给模型的视图），不是磁盘上的全文。
 * 未达阈值返回 null，调用方就不必提示用户；达阈值则交给 compactSession，
 * 后者仍可能返回“暂无可进一步压缩”，或在失败时抛错且不改旧状态。
 *
 * @param thresholdBytes 默认 64 KiB，必须是正的安全整数
 * @returns 压缩结果说明；未达阈值时为 null
 */
export async function compactIfNeeded(
  session: Session,
  signal: AbortSignal,
  summarize: Summarize,
  thresholdBytes = 64 * 1024,
): Promise<string | null> {
  signal.throwIfAborted();

  // Number.isSafeInteger：能被 JS number 精确表示的整数（不含 Infinity / 小数）。
  if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes <= 0) {
    throw new Error("压缩阈值必须是正的安全整数");
  }

  const bytes = Buffer.byteLength(JSON.stringify(contextMessages(session, signal)), "utf8");

  if (bytes < thresholdBytes) return null;

  // ponytail: 按历史视图的 JSON 字节数触发，不估算提供商 token；
  // 需要模型窗口预算时，再接入经核验的容量和计数方式。
  return compactSession(session, signal, summarize);
}
