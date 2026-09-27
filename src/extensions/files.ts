import { constants, openSync, fstatSync, readSync, closeSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ToolContext } from "../core/tools.js";

// 64 KiB：限制读入内存并回传给模型的体积，避免一次工具结果撑爆上下文。
const MAX_BYTES = 64 * 1024;

/**
 * 确认 target 落在 root 目录之内。
 *
 * 拒绝工作区外路径；必须按路径段判断，不能使用字符串前缀。
 * 例如仅检查目标路径 startsWith("/workspace")，会误放行相邻目录 /workspace-secret。
 *
 * relative(root, target) 给出从 root 走到 target 的相对路径：
 * - 在内部时是 `subdir/file.txt`，或空字符串（二者是同一路径）；
 * - 走出 root 时是 `..` 或以 `..` 路径段开头；
 * - Windows 上若跨盘符，结果会是绝对路径，所以还要拦 isAbsolute。
 *
 * @param root 已经 realpath 过的工作区根目录
 * @param target 待检查的绝对路径
 * @throws {Error} target 不在 root 之内
 */
function checkInside(root: string, target: string): void {
  const path = relative(root, target);
  // sep 是当前平台的路径分隔符（POSIX 为 `/`，Windows 为 `\`）。
  // 只拦 `..` 和 `..${sep}`，避免把合法文件名 `..foo` 误判为越界。
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("只能读取当前工作区内的文件");
  }
}

/**
 * 有界读取普通文件，严格解码 UTF-8；任何情况下都关闭文件描述符。
 *
 * 顺序：拒绝绝对路径 → 规范化工作区 → 解析前检查 `..` →
 * realpath 后再检查（挡住符号链接逃逸）→ 打开、限大小、读入、按 UTF-8 解码。
 *
 * @param path 模型给出的相对路径，原样使用（不用 trim 改文件名）
 * @param context 本次工具调用的上下文，使用 cwd 定位工作区、用 signal 响应取消
 * @returns 文件的 UTF-8 文本
 * @throws {Error} 路径越界、不是普通文件、超过 64 KiB、不是合法 UTF-8，或已取消
 */
function readWorkspaceFile(path: string, context: ToolContext): string {
  context.signal.throwIfAborted();
  // 绝对路径能直接指向工作区外，也绕过“相对工作区”的约定，一律拒绝。
  if (isAbsolute(path)) {
    throw new Error("请使用相对于工作区的路径");
  }

  // realpathSync 解析 `.` / `..` 和符号链接，得到规范绝对路径。
  // 先规范化 cwd，避免工作区本身是链接时，后续相对计算对不上。
  const root = realpathSync(context.cwd);
  // resolve 把相对 path 拼到 root 上，得到尚未跟随最终链接的绝对路径。
  const requested = resolve(root, path);
  // 解析符号链接之前先挡掉 `../`，越界路径不必再访问磁盘。
  checkInside(root, requested);

  // realpath 会解析符号链接，防止工作区内链接指向外部文件。
  const target = realpathSync(requested);
  checkInside(root, target);
  // 上面两次 realpath 可能较慢；读文件前再确认本轮尚未取消。
  context.signal.throwIfAborted();

  // 不跟随最终路径上的新符号链接；非阻塞打开，避免误遇管道时一直等待。
  // openSync 参数 1 path: 已经 realpath 过的目标。
  // 参数 2 flags: 三个标志按位或组合（同时生效）：
  // - O_RDONLY：只读打开。
  // - O_NOFOLLOW：若最终路径在 realpath 之后被换成符号链接，则打开失败。
  //   仅保护最终路径分量，不能防止其他进程在检查后替换父目录。
  // - O_NONBLOCK：遇到管道 / FIFO 时不要阻塞等待另一端。
  const descriptor = openSync(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );

  try {
    // fstatSync 按已打开的描述符取状态，避免再按路径 stat 时文件被替换。
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("只能读取普通文件");
    if (stat.size > MAX_BYTES) throw new Error("文件超过 64 KiB 读取上限");

    // 多读一个字节，用于检测检查大小后文件继续增长的情况。
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;

    while (length < bytes.length) {
      context.signal.throwIfAborted();
      // readSync 参数 1 fd:     已打开的描述符。
      // 参数 2 buffer: 读入的目标缓冲区。
      // 参数 3 offset: 从 buffer 的这个位置开始写。
      // 参数 4 length: 本次最多读多少字节。
      // 参数 5 position: null 表示从当前文件偏移继续读（循环累加）。
      // 返回值是本次实际读到的字节数；0 表示已经到文件末尾。
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }

    if (length > MAX_BYTES) throw new Error("文件超过 64 KiB 读取上限");
    context.signal.throwIfAborted();

    try {
      // TextDecoder 说明见 session.ts：fatal: true 让非法 UTF-8 直接失败。
      // subarray 只解码已读入的前 length 个字节，不把缓冲区里多出来的 0 算进去。
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new Error("文件不是有效的 UTF-8 文本");
    }
  } finally {
    // 无论成功、越界还是解码失败，都要关掉描述符，避免泄漏。
    closeSync(descriptor);
  }
}

/**
 * 受限读文件扩展：注册工具 read_file，只读当前工作区内不超过 64 KiB 的 UTF-8 普通文件。
 *
 * 本扩展提供路径边界检查和有界读取，不是文件系统沙箱；是否执行由宿主权限入口决定
 * （index.ts 里 read_file 走逐次确认，不在自动允许名单中）。
 *
 * 使用默认导出供组合入口复用，当前由 workflow.ts 默认装载；不要重复配置外部加载。
 *
 * @param api 宿主提供的扩展 API；本扩展只注册工具，因此只解构 registerTool
 */
export default function registerFiles({ registerTool }: ExtensionAPI): void {
  registerTool({
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description: "经用户确认后读取工作区内不超过 64 KiB 的 UTF-8 普通文件",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "相对于当前工作区的文件路径",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      // 参数来自模型，必须先校验（原因见 core/tools.ts 的 Tool.execute）。
      // additionalProperties: false 只是给模型看的 Schema，运行时仍可能多传字段。
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args).length !== 1 ||
        !("path" in args) ||
        typeof args.path !== "string" ||
        !args.path.trim()
      ) {
        throw new Error("read_file 参数必须仅包含非空字符串 path");
      }

      // 只用 trim 判断空白，不修改真实文件名。
      return readWorkspaceFile(args.path, context);
    },
  });
}
