import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CommandContext, ExtensionAPI } from "../core/tools.js";

/**
 * 一条待办事项。
 *
 * - id:   会话内的编号，从 1 开始连续递增；用户通过它指定要完成的待办。
 * - text: 待办内容。
 * - done: 是否已完成。
 */
type Todo = {
  id: number;
  text: string;
  done: boolean;
};

/**
 * 待办扩展的统一入口：按会话记录待办事项并保存到磁盘，提供三个用户命令。
 *
 * - /todo_add [内容]：添加一条待办；不带内容时会通过 context.ui.ask 交互询问（演示异步提问）。
 * - /todo_list：列出当前会话的全部待办，[x] 表示已完成，[ ] 表示未完成。
 * - /todo_done 编号：把指定编号的待办标记为已完成。
 *
 * 待办“按会话隔离”：每个会话文件对应一个独立的待办文件，
 * 切换会话（/new 或 /resume）后看到的是另一份列表，切回来时原列表仍在。
 *
 * 存储方式：
 * - 位置：`<工作目录>/.lcn-agent/todos/<会话文件名>.json`，
 *   例如会话 `abc.jsonl` 对应 `.lcn-agent/todos/abc.jsonl.json`。
 * - 格式：`{ "version": 1, "items": [{ "id": 1, "text": "买牛奶", "done": false }, ...] }`。
 *   version 是文件格式版本号，便于将来升级格式时识别旧文件。
 * - 每条命令执行时都重新读取文件、修改后整体写回；扩展本身不在内存中缓存待办，
 *   因此程序重启、扩展重新装载后，待办仍然存在。
 *
 * 与 upper.ts 一样使用 export default，供 loadExtension 通过文件路径动态加载，例如：
 * LCN_AGENT_EXTENSION=dist/extensions/todo.js
 *
 * @param api 宿主提供的扩展 API；本扩展只注册命令，因此参数处只解构出 registerCommand
 */
export default function registerTodo({ registerCommand }: ExtensionAPI): void {
  /**
   * 读取当前会话的待办文件，并校验其内容。
   *
   * 三个命令都先调用它，因此“检查取消”“检查会话”“读取并校验文件”集中写在这里。
   *
   * @param context 本次命令执行的上下文，从中读取取消信号、工作目录和当前会话文件名
   * @returns 对象，包含两个字段：
   *   - path:  待办文件的完整路径，供调用方随后传给 saveItems 写回；
   *   - items: 从文件读出的待办数组；文件不存在（该会话还没有待办）时为空数组。
   *            这是新建的数组，修改它不会影响磁盘，必须调用 saveItems 才会保存
   * @throws {Error} 命令已被取消时抛出取消原因（AbortError）
   * @throws {Error} 尚未选择会话，或会话文件名不合法时抛出
   * @throws {Error} 文件存在但读取失败（如没有权限）时，原样抛出系统错误
   * @throws {Error} 文件内容不是合法 UTF-8 / JSON、版本号不是 1、或任意条目格式不对时抛出
   */
  function itemsFor(context: CommandContext): { path: string; items: Todo[] } {
    // 已取消时不再继续（throwIfAborted 说明见 core/tools.ts 的 executeCommand）。
    context.signal.throwIfAborted();

    const file = context.sessionFile;
    // 待办需要挂在某个会话上；启动后尚未提问、也没 /new 或 /resume 时还没有会话文件。
    if (file === null) {
      throw new Error("请先 /new 或 /resume 选择会话");
    }
    // 文件名会拼进路径，必须先校验，防止写到 todos 目录以外（路径穿越）：
    // - !file：排除空字符串；
    // - basename(file) !== file：basename 取路径最后一段（如 "a/b.jsonl" → "b.jsonl"）。
    //   二者不相等说明带有目录部分，例如 "../x.jsonl"，拒绝；
    // - 必须以 .jsonl 结尾，与会话文件的命名规则一致。
    if (!file || basename(file) !== file || !file.endsWith(".jsonl")) {
      throw new Error("会话文件名不合法");
    }

    // join: 按当前平台的分隔符拼接路径，得到 <cwd>/.lcn-agent/todos/<会话文件名>.json。
    const path = join(context.cwd, ".lcn-agent", "todos", `${file}.json`);
    let bytes: Buffer;

    try {
      // readFileSync 未传编码时返回原始字节 Buffer，稍后再严格按 UTF-8 解码。
      bytes = readFileSync(path);
    } catch (error) {
      // 只有文件不存在才视为尚无待办，其他读取错误必须报告。
      // ENOENT 是 Node.js 表示“文件或目录不存在”的错误码（Error NO ENTry）。
      // 权限不足（EACCES）等其他错误若也当成“没有待办”，
      // 下次写入就会用空列表覆盖原有数据，所以必须向上抛出。
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { path, items: [] };
      }
      throw error;
    }

    // 工厂函数：每次调用都新建一个 Error，让各处校验失败时抛出同样的提示。
    const invalid = () => new Error(`待办文件损坏或版本不支持：${path}`);

    let data: unknown;
    try {
      // TextDecoder 的 { fatal: true } 遇到非法 UTF-8 字节直接抛错（说明见 core/session.ts 的 loadSession），
      // 解码成功后再用 JSON.parse 解析。两步中任一步失败都视为文件损坏。
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw invalid();
    }

    // 校验文件的外层结构：必须是 { version: 1, items: [...] }。
    // `"version" in data` 用于确认对象上有这个属性，之后 TypeScript 才允许读取 data.version。
    if (
      typeof data !== "object" ||
      data === null ||
      !("version" in data) ||
      data.version !== 1 ||
      !("items" in data) ||
      !Array.isArray(data.items)
    ) {
      throw invalid();
    }

    // 逐条校验并转换为规范的 Todo 对象；任意一条不合格，整个文件都视为损坏。
    // map 回调的第 2 个参数 index 是元素下标（从 0 开始）。
    const items: Todo[] = data.items.map((value: unknown, index: number) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        // 编号必须等于“下标 + 1”：保证编号从 1 开始连续且不重复，
        // 这样 /todo_add 用“长度 + 1”生成新编号时不会与已有编号冲突。
        value.id !== index + 1 ||
        !("text" in value) ||
        typeof value.text !== "string" ||
        // 内容不能为空或只含空白，与 /todo_add 的输入要求一致。
        !value.text.trim() ||
        !("done" in value) ||
        typeof value.done !== "boolean"
      ) {
        throw invalid();
      }

      // 只取出需要的三个字段重新组装，文件里多余的字段会被丢弃。
      return { id: index + 1, text: value.text, done: value.done };
    });

    return { path, items };
  }

  /**
   * 把待办列表整体写入文件（覆盖原内容）。
   *
   * 采用“先写临时文件，再改名替换”的方式：
   * 如果直接写正式文件，写到一半时程序崩溃或断电，文件里就只剩半份 JSON，下次读取会报“文件损坏”。
   * 同一文件系统内改名替换，正常运行时读者看到的是完整的旧文件或新文件。
   * 未对父目录执行 fsync，不承诺断电后的目录项持久性；仍依赖宿主单写入进程约定。
   *
   * @param path 待办文件的完整路径（来自 itemsFor 的返回值）
   * @param items 要保存的完整待办列表
   * @throws {Error} 创建目录、写入或改名失败时抛出系统错误，替换前失败不修改正式文件。
   *                 若替换成功后临时目录清理失败，也会抛错，但新内容此时已保存。
   */
  function saveItems(path: string, items: Todo[]): void {
    // dirname: 取路径的目录部分，即 <cwd>/.lcn-agent/todos。
    const directory = dirname(path);
    // 确保目录存在（recursive 说明见 core/session.ts 的 createSession）。
    mkdirSync(directory, { recursive: true });

    // mkdtempSync: 创建一个名称唯一的临时目录并返回其路径。
    // - 参数 1 prefix: 目录名前缀；Node.js 会在后面追加 6 个随机字符，如 ".todo-a1B2c3"。
    // 临时目录建在 todos 目录内部，保证与正式文件位于同一文件系统，rename 才是原子的。
    const temporary = mkdtempSync(join(directory, ".todo-"));
    try {
      const pending = join(temporary, "state.json");

      // writeFileSync 写入完整内容：
      // - 参数 1 file:    临时文件路径。
      // - 参数 2 data:    JSON 文本，末尾补换行符。
      // - 参数 3 options:
      //   - flag: "wx"  —— 独占创建，文件已存在时抛错，防止误写到别人的文件；
      //   - mode: 0o600 —— 仅所有者可读写，待办可能包含私人内容；
      //   - flush: true —— 写完立即刷到磁盘，确保改名前内容已完整落盘。
      // （三个选项的详细说明见 core/session.ts 的 createSession。）
      writeFileSync(pending, JSON.stringify({ version: 1, items }) + "\n", {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });

      // 同一文件系统内替换，正式文件不会暴露半份 JSON。
      // renameSync: 把临时文件移动为正式文件；目标已存在时直接覆盖。
      renameSync(pending, path);
    } finally {
      // 无论成功还是失败都删除临时目录：
      // - 成功时 state.json 已被移走，删除的是空目录；
      // - 失败时连同写了一半的 state.json 一起删除，不留垃圾文件。
      // rmSync 选项：recursive 递归删除目录内容；force 目标不存在时不报错。
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  // 命令 /todo_add：添加待办。
  // 写成 async 函数，是因为用户没带内容时要 await 等待用户输入回答。
  registerCommand({
    name: "todo_add",
    async execute(args, context) {
      // 先确认已选择会话、且待办文件可以正常读取，再去提问；
      // 避免用户输入了内容才发现没有会话或文件已损坏、无法保存。
      const { path, items } = itemsFor(context);

      // 取得待办内容，分两种情况：
      // 1. 用户输入 `/todo_add 买牛奶`：args 为 "买牛奶"，trim 后非空，直接使用；
      // 2. 用户只输入 `/todo_add`：args.trim() 是空字符串 ""（假值），
      //    || 才会计算右侧，调用 context.ui.ask 提问并等待回答。
      // ||：左侧为假值时取右侧；左侧为真值时右侧根本不会执行（短路），所以有内容时不会提问。
      // 最外层再 trim 一次，去掉用户回答前后的空白。
      // ask 在非终端环境、输入已关闭或已有提问等待时会抛错，错误由宿主输出为“命令执行失败”。
      const text = (args.trim() || (await context.ui.ask("请输入待办内容："))).trim();

      // 回答返回后再检查，取消时不能追加待办。
      // （await 期间用户可能按了 Ctrl+C；若不检查，被取消的命令仍会把待办写入文件。）
      context.signal.throwIfAborted();
      // 用户直接回车或只输入空格时，trim 后为空字符串。
      if (!text) {
        throw new Error("待办内容不能为空");
      }

      // 本节点不删除条目，长度加一可作为会话内连续编号。
      // （若以后支持删除，长度会变小，新编号可能与旧编号重复，届时需改为单独维护计数器，
      //   并同步放宽 itemsFor 中“编号等于下标 + 1”的校验。）
      const item: Todo = {
        id: items.length + 1,
        text,
        done: false,
      };
      // [...items, item]：展开原数组再追加新条目，得到一个新数组，不修改 items 本身。
      // 修改只有写入磁盘才算数，所以直接把新列表交给 saveItems 保存。
      saveItems(path, [...items, item]);

      return `已添加 #${item.id}：${item.text}`;
    },
  });

  // 命令 /todo_list：列出当前会话的全部待办。
  // 不需要等待任何异步操作，所以是普通（同步）函数；宿主对同步和异步命令一视同仁。
  registerCommand({
    name: "todo_list",
    // _args：此命令不需要参数，下划线表示有意忽略（说明见 upper.ts 的 /context）。
    execute(_args, context) {
      // 只读取不修改，因此只需要 items，不需要 path。
      const { items } = itemsFor(context);

      // 三元表达式：items.length 为 0（假值）时返回提示文本，否则拼接列表。
      // map 把每条待办转成一行文本，例如 "[x] #1 买牛奶"；join("\n") 用换行把各行连成一个字符串。
      return items.length
        ? items.map((item) => `${item.done ? "[x]" : "[ ]"} #${item.id} ${item.text}`).join("\n")
        : "当前会话暂无待办";
    },
  });

  // 命令 /todo_done：把指定编号的待办标记为已完成。
  registerCommand({
    name: "todo_done",
    execute(args, context) {
      const { path, items } = itemsFor(context);
      // find: 返回数组中第一个满足条件的元素，找不到时返回 undefined。
      // 用户输入的编号是字符串，所以把 item.id 转成字符串后再比较。
      // 这是精确的文本比较：输入 "1" 能匹配，"01"、"1.0" 或 "#1" 都不能匹配。
      const item = items.find((item) => String(item.id) === args.trim());

      // 没提供编号、编号不是数字、或该编号不存在，都会走到这里。
      if (!item) {
        throw new Error("请提供当前会话中存在的待办编号，例如 /todo_done 1");
      }
      // 重复完成不算错误，只提示一下，也不必重写文件。
      if (item.done) return `#${item.id} 已经完成`;

      // 生成一份新列表：目标条目替换为 done: true 的副本，其余条目原样保留；再整体写回文件。
      // { ...entry, done: true }：复制 entry 的全部字段，再用 done: true 覆盖 done 字段。
      saveItems(
        path,
        items.map((entry) => (entry.id === item.id ? { ...entry, done: true } : entry)),
      );
      return `已完成 #${item.id}：${item.text}`;
    },
  });
}
