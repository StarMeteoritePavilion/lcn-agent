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
 * 待办扩展的统一入口：按会话记录待办事项，提供三个用户命令及一个模型只读工具。
 *
 * - /todo_add [内容]：添加一条待办；不带内容时会通过 context.ui.ask 交互询问（演示异步提问）。
 * - /todo_list：列出当前会话的全部待办，[x] 表示已完成，[ ] 表示未完成。
 * - /todo_done 编号：把指定编号的待办标记为已完成。
 * - todo_list 工具：由模型调用，只读取宿主指定的当前会话，参数必须为 {}。
 *
 * 待办“按会话隔离”：每个会话文件对应一份独立的列表，
 * 切换会话（/new 或 /resume）后看到的是另一份列表，切回来时原列表仍在。
 *
 * 与 upper.ts 一样使用 export default，供 loadExtension 通过文件路径动态加载，例如：
 * LCN_AGENT_EXTENSION=dist/extensions/todo.js
 *
 * 状态保存在 .lcn-agent/todos，每次操作重新读取；保存成功后才报告修改完成。
 * @param api 宿主提供的注册能力；命令和工具使用独立名称集合，因此可以同名
 */
export default function registerTodo({ registerCommand, registerTool }: ExtensionAPI): void {
  // Pick 只要求读取所需的字段，命令与工具上下文均可传入，不依赖交互 UI。
  function itemsFor(
    context: Pick<CommandContext, "cwd" | "sessionFile" | "signal">,
  ): { path: string; items: Todo[] } {
    context.signal.throwIfAborted();

    const file = context.sessionFile;
    if (file === null) {
      throw new Error("请先 /new 或 /resume 选择会话");
    }
    if (!file || basename(file) !== file || !file.endsWith(".jsonl")) {
      throw new Error("会话文件名不合法");
    }

    const path = join(context.cwd, ".lcn-agent", "todos", `${file}.json`);
    let bytes: Buffer;

    try {
      bytes = readFileSync(path);
    } catch (error) {
      // 只有文件不存在才视为尚无待办，其他读取错误必须报告。
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { path, items: [] };
      }
      throw error;
    }

    const invalid = () => new Error(`待办文件损坏或版本不支持：${path}`);

    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw invalid();
    }

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

    const items: Todo[] = data.items.map((value: unknown, index: number) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        value.id !== index + 1 ||
        !("text" in value) ||
        typeof value.text !== "string" ||
        !value.text.trim() ||
        !("done" in value) ||
        typeof value.done !== "boolean"
      ) {
        throw invalid();
      }

      return { id: index + 1, text: value.text, done: value.done };
    });

    return { path, items };
  }

  function saveItems(path: string, items: Todo[]): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });

    const temporary = mkdtempSync(join(directory, ".todo-"));
    try {
      const pending = join(temporary, "state.json");

      writeFileSync(pending, JSON.stringify({ version: 1, items }) + "\n", {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });

      // 同一文件系统内替换，正式文件不会暴露半份 JSON。
      renameSync(pending, path);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  // 命令 /todo_add：添加待办。
  // 写成 async 函数，是因为用户没带内容时要 await 等待用户输入回答。
  registerCommand({
    name: "todo_add",
    async execute(args, context) {
      // 先确认已选择会话，再去提问；避免用户输入了内容才发现没有会话可以保存。
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
      // （await 期间用户可能按了 Ctrl+C；若不检查，被取消的命令仍会把待办加进去。）
      context.signal.throwIfAborted();
      // 用户直接回车或只输入空格时，trim 后为空字符串。
      if (!text) {
        throw new Error("待办内容不能为空");
      }

      // 本节点不删除条目，长度加一可作为会话内连续编号。
      // （若以后支持删除，长度会变小，新编号可能与旧编号重复，届时需改为单独维护计数器。）
      const item: Todo = {
        id: items.length + 1,
        text,
        done: false,
      };
      // 生成新列表并保存；失败时抛错，不返回新增成功。
      saveItems(path, [...items, item]);

      return `已添加 #${item.id}：${item.text}`;
    },
  });

  // 命令与工具共用读取、校验和展示，避免两份列表逻辑产生差异。
  // 文件不存在时仅返回空列表，不创建文件；损坏时拒绝读取并保留原文件。
  function listItems(
    context: Pick<CommandContext, "cwd" | "sessionFile" | "signal">,
  ): string {
    const { items } = itemsFor(context);
    return items.length
      ? items.map((item) => `${item.done ? "[x]" : "[ ]"} #${item.id} ${item.text}`).join("\n")
      : "当前会话暂无待办";
  }

  registerCommand({
    name: "todo_list",
    execute(_args, context) {
      return listItems(context);
    },
  });

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "todo_list",
        description: "只读查看当前会话的待办及完成状态，不修改数据",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    execute(args, context) {
      // Schema 不代替运行时校验；会话只能来自宿主，拒绝模型传入路径等额外参数。
      if (typeof args !== "object" || args === null || Array.isArray(args) || Object.keys(args).length !== 0) {
        throw new Error("todo_list 参数必须是空对象 {}");
      }
      return listItems(context);
    },
  });

  // 命令 /todo_done：把指定编号的待办标记为已完成。
  registerCommand({
    name: "todo_done",
    execute(args, context) {
      // find: 返回数组中第一个满足条件的元素，找不到时返回 undefined。
      // 用户输入的编号是字符串，所以把 item.id 转成字符串后再比较。
      // 这是精确的文本比较：输入 "1" 能匹配，"01"、"1.0" 或 "#1" 都不能匹配。
      const { path, items } = itemsFor(context);
      const item = items.find((item) => String(item.id) === args.trim());

      // 没提供编号、编号不是数字、或该编号不存在，都会走到这里。
      if (!item) {
        throw new Error("请提供当前会话中存在的待办编号，例如 /todo_done 1");
      }
      // 重复完成不算错误，只提示一下，不抛错。
      if (item.done) return `#${item.id} 已经完成`;

      // 生成目标条目的副本并保存，正式文件替换成功后才报告完成。
      saveItems(
        path,
        items.map((entry) => (entry.id === item.id ? { ...entry, done: true } : entry)),
      );
      return `已完成 #${item.id}：${item.text}`;
    },
  });
}
