import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * 状态读写所需的最小上下文；命令与工具均可传入，不依赖交互 UI。
 *
 * 扩展按“命名空间 + 会话”在磁盘上保存自己的数据（例如待办列表）。
 * 本类型只收录读写真正用到的字段，因此 CommandContext 和 ToolContext 都能当作它传入：
 * 多出来的 model、ui、callId 会被忽略，状态层也不需要它们。
 *
 * - cwd:         当前工作目录；状态文件写在 `{cwd}/.lcn-agent/{namespace}/` 下。
 * - sessionFile: 当前会话文件名（仅文件名，不含目录）；尚未选择会话时为 null，此时读写都会拒绝。
 * - signal:      取消信号。读写前会检查；writeState 在序列化之后还会再检查一次。
 */
export type StateContext = Readonly<{
  cwd: string;
  sessionFile: string | null;
  signal: AbortSignal;
}>;

/**
 * 按命名空间和会话拼出状态文件路径，并拒绝不安全的输入。
 *
 * 最终路径形如 `{cwd}/.lcn-agent/{namespace}/{sessionFile}.json`。
 * 例如会话文件是 `abc.jsonl`、命名空间是 `todos` 时，路径为 `.lcn-agent/todos/abc.jsonl.json`。
 * 文件名刻意沿用 `{sessionFile}.json`，以保留既有 todos 目录与文件名，不迁移或改写已有待办。
 *
 * 校验分三层，任何一层失败都抛错、不碰磁盘：
 * 1. 命名空间只能是小写字母开头、后接小写字母 / 数字 / 下划线；
 *    禁止 `sessions`、`diagnostics`，以免踩进宿主自己的目录。
 * 2. 必须已经选择会话（sessionFile 不为 null）。
 * 3. 会话文件名必须是单纯的 `.jsonl` 文件名，不能带路径片段（防止写出目录之外）。
 *
 * @param context 本次读写的上下文
 * @param namespace 扩展自己的命名空间，例如待办扩展使用 `"todos"`
 * @returns 状态文件的完整路径
 * @throws {Error} 已取消、命名空间不合法、尚未选择会话、或会话文件名不合法
 */
function statePath(context: StateContext, namespace: string): string {
  // throwIfAborted 说明见 tools.ts 的 CommandContext.signal：已取消时立即抛错，后面不再读写。
  context.signal.throwIfAborted();
  if (
    // test: 用正则检测整个字符串是否匹配。
    // ^[a-z] 必须以小写字母开头；[a-z0-9_]* 后面只能是小写字母、数字、下划线。
    // 不允许大写、连字符、点或斜杠，避免 namespace 变成 `../` 之类的路径片段。
    !/^[a-z][a-z0-9_]*$/.test(namespace) ||
    // sessions、diagnostics 是宿主在 .lcn-agent/ 下已经占用的目录名，扩展不能把状态写进去。
    namespace === "sessions" ||
    namespace === "diagnostics"
  ) {
    throw new Error("扩展状态命名空间不合法");
  }
  const file = context.sessionFile;
  // 状态按会话隔离：没有当前会话就无处落盘。提示用户先 /new 或 /resume。
  if (file === null) throw new Error("请先 /new 或 /resume 选择会话");
  // basename 取出路径的最后一段。若它与原字符串不同，说明 file 里含有 / 等分隔符。
  // 额外拒绝反斜杠：POSIX 上 basename("a\\b") 仍是 "a\\b"，不能单靠 basename 挡住 Windows 路径穿越。
  // 必须以 .jsonl 结尾，与会话文件的命名约定一致。
  if (!file || basename(file) !== file || file.includes("\\") || !file.endsWith(".jsonl")) {
    throw new Error("会话文件名不合法");
  }
  // 保留既有 todos 目录与文件名，不迁移或改写已有待办。
  return join(context.cwd, ".lcn-agent", namespace, `${file}.json`);
}

/**
 * 读取指定命名空间在当前会话下的状态。
 *
 * 每次都从磁盘读取，不在内存里缓存：扩展卸载再装载、或多个命令先后读写，看到的都是文件里的最新内容。
 * 文件不存在视为“还没写过”，返回 undefined，由扩展当作空数据；其他读失败原样抛出。
 * 能解码并解析时返回 unknown：版本号和业务字段由扩展自己校验（例如 todo.ts 检查 version === 1）。
 *
 * @param context 本次读取的上下文（见 StateContext）
 * @param namespace 扩展命名空间，会先经过 statePath 校验
 * @returns 解析后的 JSON 值；文件不存在时为 undefined
 * @throws {Error} 已取消、路径不合法、文件不是合法 UTF-8 JSON，或遇到文件不存在以外的读错误
 */
export function readState(context: StateContext, namespace: string): unknown {
  const path = statePath(context, namespace);
  let bytes: Buffer;
  try {
    // readFileSync 同步读取全部字节；未传 options 时返回 Buffer。说明见 session.ts。
    bytes = readFileSync(path);
  } catch (error) {
    // ENOENT：文件不存在。对状态来说这是正常的“尚未保存过”，不是错误。
    // code 是 Node.js 系统错误上的字段，普通 Error 没有，所以先用 `"code" in error` 收窄类型。
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    // TextDecoder 说明见 session.ts：fatal: true 让非法 UTF-8 直接失败，而不是 silently 替换成 U+FFFD。
    // JSON.parse 把文本变成 JS 值；失败（语法错误等）与解码失败一样，统一报“文件损坏”。
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`扩展状态文件损坏：${path}`);
  }
}

/**
 * 把 value 序列化成 JSON 后原子替换到状态文件；函数成功返回才表示保存完成。
 *
 * 扩展负责传入可用 JSON 表达的数据及版本；不支持 undefined 根值、循环引用和 BigInt。
 * 同名空间由可信扩展协调使用，不是扩展间的安全隔离；卸载不删除持久状态。
 *
 * “原子替换”指：先写到同目录下的临时文件，再 rename 成正式路径。
 * 同一文件系统内 rename 会替换目标文件，读者要么看到旧文件，要么看到完整新文件，不会读到写到一半的 JSON。
 *
 * @param context 本次写入的上下文（见 StateContext）
 * @param namespace 扩展命名空间，会先经过 statePath 校验
 * @param value 要保存的数据；扩展应自己带上 version 等字段，本函数原样序列化
 * @throws {Error} 已取消、路径不合法、value 不能 JSON.stringify，或目录 / 文件写入失败
 */
export function writeState(context: StateContext, namespace: string, value: unknown): void {
  const path = statePath(context, namespace);
  // stringify 在 value 为 undefined 时返回 undefined（不是字符串 "undefined"）；
  // 遇到循环引用或 BigInt 会抛 TypeError，由调用方感知。
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("扩展状态必须是可序列化的 JSON 值");
  // 序列化可能调用对象的 toJSON；再次检查，避免其中触发取消后仍然落盘。
  context.signal.throwIfAborted();
  // dirname 取出路径中的目录部分，即 `.lcn-agent/{namespace}`。
  const directory = dirname(path);
  // recursive: true 类似 mkdir -p：父目录缺失时一并创建，已存在时不报错。
  mkdirSync(directory, { recursive: true });
  // mkdtempSync 在指定前缀后追加随机后缀，创建一个尚未存在的空目录。
  // 把临时文件放进这个独占目录，后面才能用 flag "wx" 创建（文件必须还不存在）。
  const temporary = mkdtempSync(join(directory, ".state-"));
  try {
    const pending = join(temporary, "state.json");
    // 参数 1 path: 临时文件路径。
    // 参数 2 data: JSON 文本加末尾换行，与项目里其他 JSONL / JSON 落盘格式一致。
    // 参数 3 options:
    // - flag: "wx"  —— 独占创建，防止意外覆盖已有文件。
    // - mode: 0o600 —— 仅所有者可读写（状态里可能有用户数据）。
    // - flush: true —— 写入后 fsync，降低进程崩溃时只留下空文件的概率。
    writeFileSync(pending, text + "\n", { flag: "wx", mode: 0o600, flush: true });
    // 同一文件系统内替换，正式文件不会暴露半份 JSON。
    renameSync(pending, path);
  } finally {
    // 无论成功还是失败，都删掉临时目录，避免 .state-xxxx 残留。
    // recursive + force：目录非空也删，路径不存在也不抛错。
    rmSync(temporary, { recursive: true, force: true });
  }
  // ponytail: 依赖宿主单写入进程；不保证外部并发写入或断电后的目录项持久性。
}
