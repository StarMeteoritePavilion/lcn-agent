import {
  appendFileSync,
  constants,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type Message =
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      tool_calls?: ToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export type Session = {
  file: string;
  model: string;
  messages: Message[];
  pending: Set<string>;
};

/**
 * 会话持久化写入失败时抛出的特定错误类型。
 */
export class SessionWriteError extends Error {}

const directory = ".lcn-agent/sessions";

/**
 * 创建一个新会话。
 *
 * 在 `.lcn-agent/sessions` 目录下新建一个以 UUID 命名的 JSONL 文件，
 * 并在第一行写入会话头信息 `{ type: "session", version: 1, model }`。
 * 后续的消息记录会以“每行一个 JSON 对象”的形式追加到该文件中。
 *
 * @param model 本次会话使用的模型名称，会写入会话头并保存在返回的 Session 中
 * @returns 新建的 Session 对象：
 *   - file:    会话文件名（仅文件名，不含目录）
 *   - model:   使用的模型名称
 *   - messages: 消息历史，初始为空数组
 *   - pending:  待处理项集合（如尚未返回结果的 tool_call id），初始为空
 */
export function createSession(model: string): Session {
  // 确保会话目录存在。
  // recursive: true —— 递归创建所有缺失的父目录（类似 `mkdir -p`）；
  //                    目录已存在时也不会抛错。
  mkdirSync(directory, { recursive: true });

  // 用随机 UUID 作为文件名，保证每个会话文件唯一；
  // 扩展名 .jsonl 表示 JSON Lines 格式：每行一条独立的 JSON 记录。
  const file = `${randomUUID()}.jsonl`;

  appendFileSync(
    // 参数 1 path：要写入的文件完整路径，即 `.lcn-agent/sessions/<uuid>.jsonl`。
    // join 会按当前平台的路径分隔符拼接路径。
    join(directory, file),
    // 参数 2 data：要写入的内容。
    // 会话头记录：type 标识记录类型，version 为文件格式版本号（便于将来升级兼容），
    // model 为所用模型。末尾的 "\n" 是 JSONL 格式要求的行分隔符。
    JSON.stringify({ type: "session", version: 1, model }) + "\n",
    // 参数 3 options：写入选项。
    // - flag: "wx"  —— "w" 表示写入，"x" 表示独占创建：若文件已存在则抛出 EEXIST 错误，
    //                  防止（极小概率的）UUID 冲突时覆盖已有会话文件。
    // - mode: 0o600 —— 新建文件的权限：仅文件所有者可读写，其他用户无任何权限，
    //                  因为会话中可能包含敏感对话内容。（仅在创建文件时生效）
    // - flush: true —— 写入后立即调用 fsync 将数据刷到磁盘，
    //                  避免进程崩溃或断电导致会话头丢失。（需 Node.js v20.10+ / v21.1+）
    { flag: "wx", mode: 0o600, flush: true },
  );

  // 返回内存中的会话对象，消息历史与待处理集合均从空开始。
  return { file, model, messages: [], pending: new Set() };
}

/**
 * 列出所有已保存的会话文件。
 *
 * 读取 `.lcn-agent/sessions` 目录下的所有文件，
 * 筛选出以 `.jsonl` 结尾的文件，并按升序排序后返回文件名列表。
 *
 * @returns 排序后的会话文件名列表（如 `["uuid.jsonl", ...]`）
 */
export function listSessions(): string[] {
  // 确保会话目录存在（mkdirSync 的参数说明已在 createSession 中提供，此处跳过）。
  mkdirSync(directory, { recursive: true });

  return (
    readdirSync(
      // 参数 1 path：要读取的目标目录路径，即 `.lcn-agent/sessions`。
      // 未传递 options 参数时，默认返回该目录下所有文件和子目录的名称数组（string[]）。
      directory,
    )
      // filter 参数 callbackfn：筛选谓词函数。
      // 对目录下的每个文件名执行测试，仅保留以 ".jsonl" 结尾的会话文件。
      .filter((file) => file.endsWith(".jsonl"))
      // sort：对过滤后的文件名数组按 UTF-16 字符码点升序排序。
      .sort()
  );
}

/**
 * 从磁盘加载并恢复指定会话。
 *
 * 验证会话文件存在性、UTF-8 编码完整性以及每行 JSONL 记录的有效性，
 * 并校验首行会话头（版本与模型一致性）和后续消息的工具调用配对状态。
 *
 * @param file 会话文件名（如 `<uuid>.jsonl`），必须是来自会话列表的有效文件名
 * @param model 预期使用的模型名称，必须与会话头中记录的模型完全一致
 * @returns 恢复后的 Session 对象
 * @throws {Error} 文件不存在、非法 UTF-8、行未完整落盘、格式版本/模型不匹配、
 *                 记录格式非法或存在未配对工具调用时抛出错误
 */
export function loadSession(file: string, model: string): Session {
  // 名称必须来自实际目录清单，禁止将路径拼接或名称推断用作查找方式。
  const sessions = listSessions();
  // includes: 校验目标文件名是否在已知会话列表中，防范路径穿越等非法文件名访问。
  if (!sessions.includes(file)) {
    throw new Error("会话不存在，请使用 /sessions 查看完整文件名");
  }

  // readFileSync 同步读取文件全部内容：
  // - 参数 1 path: 文件的完整路径（join 的说明见前文，此处跳过）。
  // - 未传 options，默认返回原始二进制字节 Buffer。
  const bytes = readFileSync(join(directory, file));
  let text: string;
  try {
    // TextDecoder 用于将字节流解码为字符串：
    // - 参数 1 label: "utf-8" 指定字符编码。
    // - 参数 2 options: { fatal: true } 开启严格解码模式。若遇到非法的 UTF-8 字节序列直接抛出异常，
    //                   防止静默使用替换字符 U+FFFD 掩盖数据损坏。
    // - decode(bytes): 执行解码并返回 UTF-8 字符串。
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("会话包含无效 UTF-8，原文件保持不变");
  }

  // split: 以换行符 "\n" 分割文本为行数组。
  const lines = text.split("\n");
  // pop: 弹出并返回数组最后一个元素。
  // 合法的 JSONL 文件末尾必须以换行符结尾，因此正常情况下最后一行应为空字符串 ""。
  // 若末尾不为空字符串，说明最后一行写入中断、未完整落盘。
  if (lines.pop() !== "")
    throw new Error(`会话第 ${lines.length + 1} 行未完整落盘，拒绝恢复，原文件保持不变`);

  if (!lines.length) {
    throw new Error("会话缺少格式头");
  }

  const session: Session = { file, model, messages: [], pending: new Set() };

  for (let index = 0; index < lines.length; index++) {
    try {
      // JSON.parse: 将单行 JSON 字符串解析为 JS 对象。
      // - 参数 1 text: 待解析的 JSON 格式文本。
      const record: unknown = JSON.parse(lines[index]);
      if (!object(record)) {
        throw new Error("记录必须是对象");
      }
      if (index === 0) {
        // 第一行必须是会话头，校验类型、版本号与模型配置
        if (record.type !== "session" || record.version !== 1 || record.model !== model) {
          throw new Error("格式版本不支持或模型与当前配置不一致");
        }
      } else {
        // 后续行必须是消息记录
        if (record.type !== "message") {
          throw new Error("记录类型必须为 message");
        }
        const message = messageFrom(record.message);
        session.pending = nextPending(session.pending, message);
        session.messages.push(message);
      }
    } catch (error) {
      throw new Error(
        `会话第 ${index + 1} 行无效：${error instanceof Error ? error.message : "记录错误"}`,
      );
    }
  }

  if (session.pending.size) {
    throw new Error("会话存在未配对的工具调用，执行结果未知；拒绝恢复，不重放工具");
  }
  return session;
}

/**
 * 获取项目级会话写入独占锁。
 *
 * 同一项目同一时间只允许一个会话写入进程，避免多进程并发追加导致消息记录错乱或配对混乱。
 * （项目级独占锁；未来需要多会话并发写入时再细化为会话级锁）。
 *
 * @returns 解锁回调函数，调用时关闭文件描述符并删除锁文件
 * @throws {Error} 若锁文件已存在（EEXIST），说明已有其他写入进程在运行，抛出异常阻止并发
 */
export function lockSessions(): () => void {
  // 确保会话目录存在（mkdirSync 说明见 createSession，此处跳过）。
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".writer.lock");

  // openSync 同步打开或创建文件，返回底层文件描述符（fd）：
  // - 参数 1 path: 锁文件的完整路径。
  // - 参数 2 flags: "wx" —— "w" 表示写入，"x" 表示独占模式（O_CREAT | O_EXCL），
  //                  若锁文件已存在则立即抛出 EEXIST 错误，保证原子性互斥。
  // - 参数 3 mode: 0o600 —— 权限掩码，仅所有者可读写。
  const descriptor = openSync(path, "wx", 0o600);

  return () => {
    // closeSync: 关闭指定的文件描述符，释放操作系统句柄资源。
    // - 参数 1 fd: 要关闭的文件描述符数字。
    closeSync(descriptor);
    // unlinkSync: 同步删除指定文件，释放锁以供后续进程获取。
    // - 参数 1 path: 要删除的锁文件路径。
    unlinkSync(path);
  };
}

/**
 * 向指定会话追加保存一条新消息。
 *
 * 先对消息进行格式校验与工具调用配对检查，
 * 随后以 JSONL 格式追加写入磁盘并立即刷盘（fsync）；
 * 仅在磁盘写入成功后才更新内存中的会话状态，保证内存与磁盘的一致性。
 *
 * @param session 当前要追加消息的会话对象
 * @param value 要保存的消息对象（用户消息、模型回复或工具调用结果）
 * @throws {SessionWriteError} 磁盘写入失败时抛出，防止内存与磁盘状态产生分歧
 * @throws {Error} 消息格式非法或工具调用配对状态异常时抛出
 */
export function saveMessage(session: Session, value: Message): void {
  const message = messageFrom(value);
  const pending = nextPending(session.pending, message);
  try {
    // 只打开已有文件并追加，不使用 O_CREAT；文件丢失时必须报错。
    const descriptor = openSync(join(directory, session.file), constants.O_WRONLY | constants.O_APPEND);
    try {
      appendFileSync(descriptor, JSON.stringify({ type: "message", message }) + "\n", { flush: true });
    } finally {
      closeSync(descriptor);
    }
  } catch {
    throw new SessionWriteError("会话写入失败，停止运行以保留磁盘记录；请检查存储路径和权限");
  }

  // 磁盘成功后才修改内存；写入失败绝不假装保存成功。
  session.messages.push(message);
  session.pending = pending;
}

/**
 * 类型守卫：判断输入值是否为非 null、非数组的普通对象。
 *
 * @param value 待检查的未知类型值
 * @returns 若为普通对象结构则返回 true，并将 TypeScript 类型收窄为 Record<string, unknown>
 */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验并规范化未知输入为合法的 Message 结构。
 *
 * 验证规则：
 * 1. 基础校验：必须为对象且 content 必须为字符串。
 * 2. role = "user"：仅需 content 字段。
 * 3. role = "tool"：必须包含非空的字符串 tool_call_id。
 * 4. role = "assistant"：
 *    - 若无 tool_calls，则只保留 content；
 *    - 若有 tool_calls，必须为非空数组，且每个工具调用需符合 ToolCall 规范，不允许存在重复的 id。
 *
 * @param value 待校验的原始数据（来自内存传入或反序列化的 JSON 记录）
 * @returns 规范化后的 Message 对象
 * @throws {Error} 当格式不符合规范时抛出具体错误信息
 */
function messageFrom(value: unknown): Message {
  if (!object(value) || typeof value.content !== "string") {
    throw new Error("消息必须包含文本 content");
  }

  if (value.role === "user") {
    return { role: "user", content: value.content };
  }

  if (value.role === "tool" && typeof value.tool_call_id === "string" && value.tool_call_id) {
    return { role: "tool", tool_call_id: value.tool_call_id, content: value.content };
  }

  if (value.role !== "assistant") {
    throw new Error("不支持的消息 role 或工具调用 ID");
  }

  if (value.tool_calls === undefined) {
    return { role: "assistant", content: value.content };
  }

  if (!Array.isArray(value.tool_calls) || value.tool_calls.length === 0) {
    throw new Error("工具调用列表不能为空");
  }

  // map: 对工具调用列表逐项校验并转换为规范的 ToolCall 对象。
  // - 参数 callbackfn：处理每个调用条目的转换函数。
  const calls: ToolCall[] = value.tool_calls.map((call: unknown) => {
    if (
      !object(call) ||
      typeof call.id !== "string" ||
      !call.id ||
      call.type !== "function" ||
      !object(call.function) ||
      typeof call.function.name !== "string" ||
      !call.function.name ||
      typeof call.function.arguments !== "string"
    ) {
      throw new Error("工具调用结构不合法");
    }

    return {
      id: call.id,
      type: "function",
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    };
  });

  // 利用 Set 统计唯一 ID 数量，若小于数组长度说明存在重复 ID。
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new Error("工具调用 ID 重复");
  }
  return { role: "assistant", content: value.content, tool_calls: calls };
}

/**
 * 计算并校验消息流转后的待处理工具调用 ID 集合。
 *
 * 保存和恢复共用配对校验逻辑：
 * 1. 当消息为 tool 结果时：从 pending 集合中核销对应的 tool_call_id，若该 ID 不存在则视为非法调用结果；
 * 2. 当消息为 user 或 assistant 时：前置要求 pending 集合为空（即所有工具调用必须已得到响应）；
 *    若 assistant 携带有新的 tool_calls，则将其所有 call.id 加入 pending 集合。
 *
 * @param pending 当前未完成的工具调用 ID 集合
 * @param message 即将处理的新消息
 * @returns 状态转移后的新 pending 集合副本（保持不可变性）
 * @throws {Error} 工具结果未对应未完成调用，或仍有未决工具调用时加入新消息
 */
function nextPending(pending: Set<string>, message: Message): Set<string> {
  // 浅拷贝当前集合，避免直接修改传入的原 Set
  const next = new Set(pending);
  if (message.role === "tool") {
    // delete: 从集合中移除指定的 tool_call_id。
    // 返回 true 表示成功删除；返回 false 说明原集合中无此 ID，即该结果没有匹配的未完成调用。
    if (!next.delete(message.tool_call_id)) {
      throw new Error("工具结果没有对应的未完成调用");
    }
  } else {
    if (next.size) {
      throw new Error("存在未配对的工具调用，不能追加新消息");
    }
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        // add: 向集合中添加新发起的工具调用 ID，等待后续 tool 消息响应
        next.add(call.id);
      }
    }
  }
  return next;
}
