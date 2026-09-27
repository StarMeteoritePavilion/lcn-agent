import { constants, openSync, fstatSync, readSync, closeSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { opendir } from "node:fs/promises";
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
 * 按行搜索区分大小写的字面文本，最多返回 50 个匹配行；复用读取边界。
 *
 * 先走 readWorkspaceFile，因此路径边界检查、64 KiB 上限、UTF-8 校验与取消检查都相同。
 * 搜索是 String.includes 字面匹配，不是正则：query 里的 `.` 只匹配点，不匹配任意字符。
 *
 * @param path 相对工作区的文件路径，原样交给 readWorkspaceFile
 * @param query 要查找的非空、不含换行的字面文本；空格有含义，不做 trim
 * @param context 本次工具调用的上下文，循环中继续响应 signal
 * @returns JSON 字符串：`{ matches: [{ line, text }], truncated }`
 *          line 从 1 起算；truncated 为 true 表示还有更多匹配未返回
 * @throws {Error} 与 readWorkspaceFile 相同的读失败，或搜索过程中被取消
 */
function searchWorkspaceFile(path: string, query: string, context: ToolContext): string {
  // `\r?\n` 同时切开 Unix 的 `\n` 和 Windows 的 `\r\n`，避免 `\r` 留在行尾干扰匹配。
  const lines = readWorkspaceFile(path, context).split(/\r?\n/);
  const matches: Array<{ line: number; text: string }> = [];
  let truncated = false;

  for (let index = 0; index < lines.length; index++) {
    // 大文件按行扫描可能较慢，每行检查一次取消。
    context.signal.throwIfAborted();
    const line = lines[index];
    if (!line.includes(query)) {
      continue;
    }

    // 发现第 51 个匹配行才标记截断，避免恰好 50 行时误报。
    if (matches.length === 50) {
      truncated = true;
      break;
    }
    // index 从 0 起，展示给模型的行号从 1 起，与常见编辑器一致。
    matches.push({ line: index + 1, text: line });
  }

  // 原文件已限制为 64 KiB；JSON 输出可明确区分换行、制表符等字符。
  return JSON.stringify({ matches, truncated });
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
    if (!stat.isFile()) {
      throw new Error("只能读取普通文件");
    }
    if (stat.size > MAX_BYTES) {
      throw new Error("文件超过 64 KiB 读取上限");
    }

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
      if (count === 0) {
        break;
      }
      length += count;
    }

    if (length > MAX_BYTES) {
      throw new Error("文件超过 64 KiB 读取上限");
    }
    context.signal.throwIfAborted();

    try {
      // TextDecoder 说明见 session.ts：fatal: true 让非法 UTF-8 直接失败。
      // subarray 只解码已读入的前 length 个字节，不把缓冲区里多出来的 0 算进去。
      // ignoreBOM: true 保留 BOM 字符，保证编辑预览不静默丢失文件头。
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } catch {
      throw new Error("文件不是有效的 UTF-8 文本");
    }
  } finally {
    // 无论成功、越界还是解码失败，都要关掉描述符，避免泄漏。
    closeSync(descriptor);
  }
}

/**
 * 列出目录的直接子项，最多返回 100 项，不递归或跟随子项链接。
 *
 * 路径检查与 readWorkspaceFile 相同：相对路径、realpath、工作区边界。
 * 只打开这一层目录，不进入子目录；指向目录的符号链接也只报成 symlink。
 *
 * @param path 相对工作区的目录路径；`.` 表示工作区根目录
 * @param context 本次工具调用的上下文，枚举过程中继续响应 signal
 * @returns Promise，完成后得到 JSON：`{ entries: [{ name, type }], truncated }`
 *          type 为 symlink / directory / file / other；truncated 表示还有未列出的项
 * @throws {Error} 路径越界、不是目录、打开失败，或已取消
 */
async function listWorkspaceFiles(path: string, context: ToolContext): Promise<string> {
  context.signal.throwIfAborted();
  if (isAbsolute(path)) {
    throw new Error("请使用相对于工作区的路径");
  }

  const root = realpathSync(context.cwd);
  const requested = resolve(root, path);
  checkInside(root, requested);

  const target = realpathSync(requested);
  checkInside(root, target);
  context.signal.throwIfAborted();

  const entries: Array<{ name: string; type: string }> = [];
  let truncated = false;

  // opendir 打开目录，返回异步迭代器，一次读一个 Dirent，不必一次载入全部文件名。
  // 参数 1 path: 已经 realpath 过的目录。若 target 不是目录，这里会抛错。
  const directory = await opendir(target);

  // for await 在正常结束、break 或抛错时都会关闭目录句柄。
  for await (const entry of directory) {
    context.signal.throwIfAborted();

    // 只有发现第 101 项才标记截断。
    if (entries.length === 100) {
      truncated = true;
      break;
    }

    entries.push({
      name: entry.name,
      // 先判断符号链接：指向目录的链接仍报 symlink，避免把链接目标当成直接子目录。
      type: entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : entry.isFile()
            ? "file"
            : "other",
    });
  }

  // 空目录没有进入循环，也需检查等待期间是否发生取消。
  context.signal.throwIfAborted();
  return JSON.stringify({ entries, truncated });
}

/** 预览一次唯一的字面替换，不修改文件。 */
function previewWorkspaceEdit(
  path: string,
  oldText: string,
  newText: string,
  context: ToolContext,
): string {
  const before = readWorkspaceFile(path, context);
  const index = before.indexOf(oldText);

  if (index === -1) {
    throw new Error("未找到待替换文本");
  }
  // 从下一字符继续查找，重叠匹配也算多个，避免替换位置不明确。
  if (before.indexOf(oldText, index + 1) !== -1) {
    throw new Error("待替换文本出现多次，请提供更完整的上下文");
  }

  if (oldText === newText) {
    throw new Error("替换前后相同，没有实际修改");
  }
  const after = before.slice(0, index) + newText + before.slice(index + oldText.length);

  // 按 UTF-8 字节数限制，不用字符串长度代替文件大小。
  if (Buffer.byteLength(after, "utf8") > MAX_BYTES) {
    throw new Error("修改后的文件超过 64 KiB 上限");
  }

  context.signal.throwIfAborted();
  return JSON.stringify({ path, before, after });
}

/**
 * 受限文件扩展：read_file 读取文本，search_file 按行搜索，list_files 列出直接子项，preview_edit 预览替换但不落盘。
 *
 * read_file / search_file 共用 64 KiB 及路径限制；list_files 共用路径限制，最多 100 项且不递归。
 * 本扩展提供路径边界检查和有界读取，不是文件系统沙箱；是否执行由宿主权限入口决定
 * （index.ts 里这四个工具都走逐次确认，不在自动允许名单中）。
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

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "search_file",
        description:
          "经用户确认，在工作区内不超过 64 KiB 的 UTF-8 文件中搜索字面文本，区分大小写，最多返回 50 个匹配行",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "工作区相对文件路径" },
            query: { type: "string", description: "要查找的字面文本，不支持跨行搜索" },
          },
          required: ["path", "query"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      // 参数来自模型，必须先校验（原因见 core/tools.ts 的 Tool.execute）。
      // 只允许恰好两个字段：path 与 query。多出来的键一律拒绝。
      // query 用 length === 0 判断空串，而不是 trim：空格本身可以是要搜的内容。
      // 含 `\r` / `\n` 的 query 无法按行匹配，也禁止拿来做跨行搜索。
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args).length !== 2 ||
        !("path" in args) ||
        typeof args.path !== "string" ||
        !args.path.trim() ||
        !("query" in args) ||
        typeof args.query !== "string" ||
        args.query.length === 0 ||
        /[\r\n]/.test(args.query)
      ) {
        throw new Error("search_file 参数须仅包含有效 path 和非空、无换行的 query");
      }

      // 查询中的空格有实际含义，不使用 trim 修改查询内容。
      return searchWorkspaceFile(args.path, args.query, context);
    },
  });

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description: "经用户确认，列出工作区内指定目录的直接子项，最多 100 项，不递归",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "工作区相对目录路径；使用 . 表示工作区根目录",
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
        throw new Error("list_files 参数必须仅包含非空字符串 path");
      }

      // 只用 trim 判断空白，不修改真实目录名；`.` 表示工作区根目录。
      return listWorkspaceFiles(args.path, context);
    },
  });

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "preview_edit",
        description:
          "经用户确认，预览工作区内小型 UTF-8 文件的一次唯一字面替换，返回修改前后文本，不写入文件",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "工作区相对文件路径" },
            oldText: { type: "string", description: "必须唯一出现的非空原文" },
            newText: { type: "string", description: "替换文本；空字符串表示删除" },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args).length !== 3 ||
        !("path" in args) ||
        typeof args.path !== "string" ||
        !args.path.trim() ||
        !("oldText" in args) ||
        typeof args.oldText !== "string" ||
        args.oldText.length === 0 ||
        !("newText" in args) ||
        typeof args.newText !== "string"
      ) {
        throw new Error("preview_edit 参数须仅包含有效 path、非空 oldText 和字符串 newText");
      }

      return previewWorkspaceEdit(args.path, args.oldText, args.newText, context);
    },
  });
}
