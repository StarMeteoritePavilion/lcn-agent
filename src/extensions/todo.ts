import type { StateContext } from "../core/state.js";
import type { ExtensionAPI } from "../core/tools.js";

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
 * 待办扩展的统一入口：按会话记录待办事项，提供三个用户命令及三个模型工具。
 *
 * - /todo_add [内容]：添加一条待办；不带内容时会通过 context.ui.ask 交互询问（演示异步提问）。
 * - /todo_list：列出当前会话的全部待办，[x] 表示已完成，[ ] 表示未完成。
 * - /todo_done 编号：把指定编号的待办标记为已完成。
 * - todo_list 工具：只读查看当前会话，参数必须为 {}。
 * - todo_add / todo_done 工具：宿主逐次确认后新增或完成；参数不允许指定会话或路径。
 *
 * 待办“按会话隔离”：每个会话文件对应一份独立的列表，
 * 切换会话（/new 或 /resume）后看到的是另一份列表，切回来时原列表仍在。
 *
 * 使用默认导出供组合入口和动态加载器共用；当前主入口已通过 workflow 默认装载。
 * 不要再用 LCN_AGENT_EXTENSION 重复加载本模块，否则会触发重名保护。
 *
 * 通过宿主状态接口读写 .lcn-agent/todos，沿用原有格式；保存成功后才报告修改完成。
 * @param api 宿主提供的注册及会话状态读写能力；命令和工具使用独立名称集合，因此可以同名
 */
export default function registerTodo({
  registerCommand,
  registerTool,
  readState,
  writeState,
}: ExtensionAPI): void {
  // 状态接口负责路径、JSON 和取消检查；待办扩展只校验版本及业务字段。
  function itemsFor(context: StateContext): Todo[] {
    const data = readState(context, "todos");
    if (data === undefined) return [];
    const invalid = () => new Error(`待办数据损坏或版本不支持：${context.sessionFile}`);

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

    return items;
  }

  function saveItems(context: StateContext, items: Todo[]): void {
    writeState(context, "todos", { version: 1, items });
  }

  // 命令和工具共用写入；读取时检查取消，保存成功后才返回成功提示。
  function addItem(text: string, context: StateContext): string {
    text = text.trim();
    if (!text) throw new Error("待办内容不能为空");
    const items = itemsFor(context);
    const item: Todo = { id: items.length + 1, text, done: false };
    saveItems(context, [...items, item]);
    return `已添加 #${item.id}：${item.text}`;
  }

  // 编号按字符串精确匹配，重复完成不重写文件。
  function doneItem(id: string, context: StateContext): string {
    const items = itemsFor(context);
    const item = items.find((item) => String(item.id) === id.trim());
    if (!item) throw new Error("请提供当前会话中存在的待办编号，例如 /todo_done 1");
    if (item.done) return `#${item.id} 已经完成`;
    saveItems(
      context,
      items.map((entry) => (entry.id === item.id ? { ...entry, done: true } : entry)),
    );
    return `已完成 #${item.id}：${item.text}`;
  }

  registerCommand({
    name: "todo_add",
    async execute(args, context) {
      // 提问前先检查会话与文件，回答后 addItem 会重新读取，避免使用等待前的旧数据。
      itemsFor(context);
      const text = args.trim() || (await context.ui.ask("请输入待办内容："));
      return addItem(text, context);
    },
  });

  // 命令与工具共用读取、校验和展示，避免两份列表逻辑产生差异。
  // 文件不存在时仅返回空列表，不创建文件；损坏时拒绝读取并保留原文件。
  function listItems(context: StateContext): string {
    const items = itemsFor(context);
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
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args).length !== 0
      ) {
        throw new Error("todo_list 参数必须是空对象 {}");
      }
      return listItems(context);
    },
  });

  registerCommand({
    name: "todo_done",
    execute(args, context) {
      return doneItem(args, context);
    },
  });

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "todo_add",
        description: "经用户确认后新增当前会话的待办",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args).length !== 1 ||
        !("text" in args) ||
        typeof args.text !== "string"
      ) {
        throw new Error("todo_add 参数必须仅包含字符串 text");
      }
      return addItem(args.text, context);
    },
  });

  registerTool({
    definition: {
      type: "function",
      function: {
        name: "todo_done",
        description: "经用户确认后完成当前会话的指定待办，id 使用列表中的编号字符串",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        Object.keys(args).length !== 1 ||
        !("id" in args) ||
        typeof args.id !== "string"
      ) {
        throw new Error("todo_done 参数必须仅包含字符串 id");
      }
      return doneItem(args.id, context);
    },
  });
}
