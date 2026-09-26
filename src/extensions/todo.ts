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
 * 待办扩展的统一入口：按会话记录待办事项，提供三个用户命令。
 *
 * - /todo_add [内容]：添加一条待办；不带内容时会通过 context.ui.ask 交互询问（演示异步提问）。
 * - /todo_list：列出当前会话的全部待办，[x] 表示已完成，[ ] 表示未完成。
 * - /todo_done 编号：把指定编号的待办标记为已完成。
 *
 * 待办“按会话隔离”：每个会话文件对应一份独立的列表，
 * 切换会话（/new 或 /resume）后看到的是另一份列表，切回来时原列表仍在。
 *
 * 与 upper.ts 一样使用 export default，供 loadExtension 通过文件路径动态加载，例如：
 * LCN_AGENT_EXTENSION=dist/extensions/todo.js
 *
 * @param api 宿主提供的扩展 API；本扩展只注册命令，因此参数处只解构出 registerCommand
 */
export default function registerTodo({ registerCommand }: ExtensionAPI): void {
  // ponytail: 仅保存在本次装载的内存中；下一节点接入会话持久化。
  // （程序退出或扩展卸载后待办全部丢失；重新装载会得到一个全新的空 Map。）
  //
  // Map<会话文件名, 该会话的待办列表>：以 context.sessionFile 为键，实现按会话隔离。
  // sessions 定义在 registerTodo 内部，被下面三个命令的 execute 通过闭包共享。
  const sessions = new Map<string, Todo[]>();

  /**
   * 获取当前会话的待办列表；该会话第一次使用时创建空列表。
   *
   * 三个命令都先调用它，因此“检查取消”和“检查是否已选择会话”这两步集中写在这里。
   *
   * @param context 本次命令执行的上下文，从中读取取消信号和当前会话文件名
   * @returns 当前会话的待办数组。返回的是 Map 中保存的同一个数组（引用），
   *          调用方对它 push 或修改元素，会直接反映到 Map 里，无需再 set 回去
   * @throws {Error} 命令已被取消时抛出取消原因（AbortError）
   * @throws {Error} 尚未选择会话（sessionFile 为 null）时抛出
   */
  function itemsFor(context: CommandContext): Todo[] {
    // 已取消时不再继续（throwIfAborted 说明见 core/tools.ts 的 executeCommand）。
    context.signal.throwIfAborted();

    // 待办需要挂在某个会话上；启动后尚未提问、也没 /new 或 /resume 时还没有会话文件。
    if (context.sessionFile === null) {
      throw new Error("请先 /new 或 /resume 选择会话");
    }

    // “查不到就创建并存入”的常见写法：
    // get 不存在时返回 undefined，此时新建空数组并用 set 保存，下次即可直接取到。
    let items = sessions.get(context.sessionFile);
    if (!items) {
      items = [];
      sessions.set(context.sessionFile, items);
    }
    return items;
  }

  // 命令 /todo_add：添加待办。
  // 写成 async 函数，是因为用户没带内容时要 await 等待用户输入回答。
  registerCommand({
    name: "todo_add",
    async execute(args, context) {
      // 先确认已选择会话，再去提问；避免用户输入了内容才发现没有会话可以保存。
      const items = itemsFor(context);

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
      if (!text) throw new Error("待办内容不能为空");

      // 本节点不删除条目，长度加一可作为会话内连续编号。
      // （若以后支持删除，长度会变小，新编号可能与旧编号重复，届时需改为单独维护计数器。）
      const item: Todo = {
        id: items.length + 1,
        text,
        done: false,
      };
      // items 就是 Map 中保存的数组，push 后 Map 里的数据同步更新（见 itemsFor 的说明）。
      items.push(item);

      return `已添加 #${item.id}：${item.text}`;
    },
  });

  // 命令 /todo_list：列出当前会话的全部待办。
  // 不需要等待任何异步操作，所以是普通（同步）函数；宿主对同步和异步命令一视同仁。
  registerCommand({
    name: "todo_list",
    // _args：此命令不需要参数，下划线表示有意忽略（说明见 upper.ts 的 /context）。
    execute(_args, context) {
      const items = itemsFor(context);

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
      // find: 返回数组中第一个满足条件的元素，找不到时返回 undefined。
      // 用户输入的编号是字符串，所以把 item.id 转成字符串后再比较。
      // 这是精确的文本比较：输入 "1" 能匹配，"01"、"1.0" 或 "#1" 都不能匹配。
      const item = itemsFor(context).find((item) => String(item.id) === args.trim());

      // 没提供编号、编号不是数字、或该编号不存在，都会走到这里。
      if (!item) {
        throw new Error("请提供当前会话中存在的待办编号，例如 /todo_done 1");
      }
      // 重复完成不算错误，只提示一下，不抛错。
      if (item.done) return `#${item.id} 已经完成`;

      // item 是数组中那个对象本身（引用），直接修改它的属性即可，列表里的数据会同步更新。
      item.done = true;
      return `已完成 #${item.id}：${item.text}`;
    },
  });
}
