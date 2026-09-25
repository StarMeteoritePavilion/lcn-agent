import type { ExtensionAPI, Tool } from "../core/tools.js";

// 第 1 部分：给模型看的说明书。
// 告诉模型：有个叫 upper 的工具，需要一个 string 类型的 text 参数。
const definition: Tool["definition"] = {
  type: "function",
  function: {
    name: "upper",
    description: "将用户提供的文本转换为大写",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要转换的文本" },
      },
      required: ["text"],
    },
  },
};

// 第 2 部分：真正执行的逻辑。
// Schema 只描述参数；JSON.parse 和 TypeScript 类型都不会替我们验证它，
// 参数来自模型，可能缺字段或类型不对，所以先校验再使用。
function execute(args: unknown): string {
  // 校验 1：必须是普通对象（排除 null 和数组，二者的 typeof 也是 "object"）。
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("upper 工具参数必须是对象");
  }

  // 已确认是对象，但字段类型仍未知，所以先当作“任意键、值未知”的对象读取。
  const { text } = args as Record<string, unknown>;

  // 校验 2：text 必须是字符串。
  if (typeof text !== "string") {
    throw new Error("upper 工具参数 text 必须是 string");
  }

  return text.toUpperCase();
}

/**
 * 第 3 部分：扩展的统一入口，通过 ExtensionAPI 向宿主注册本扩展提供的全部能力：
 * - 命令 /context：展示当前工作目录、模型和会话文件（演示 CommandContext 的用法）；
 * - 命令 /runs：展示本次装载以来已结束的 Agent 运行次数（演示 onAgentEnd 订阅）；
 * - 工具 upper：供模型调用，把文本转为大写；
 * - 命令 /upper：供用户直接调用，效果同上但不经过模型。
 *
 * 为什么使用 export default：
 * - 外部扩展通过路径动态加载，宿主事先不知道本文件中的函数叫什么。
 * - loadExtension() 获取模块对象后统一读取 extension.default，再交给 mountExtension() 调用。
 * - 因此不同扩展可以分别命名为 registerUpper、registerEcho，宿主都通过同一个 default 入口装载。
 *   默认导出的是注册函数，不是工具执行结果；装载时登记工具，模型请求调用时才执行 execute。
 *
 * default 与 registerUpper 各自的作用：
 * - default 是模块的默认导出名；一个模块最多有一个默认导出，也可以同时有多个命名导出。
 * - registerUpper 是函数自身的名字，便于阅读和在调试堆栈中定位，不会额外产生同名的命名导出。
 * - 如果只改为 export function registerUpper，模块将提供 extension.registerUpper，
 *   当前加载器读取的 extension.default 就不存在，需要同步修改双方的入口约定。
 *
 * 默认导出与命名导出都是标准 ESM 语法，并不存在默认导出普遍更规范的规则。
 * 本项目为“一个外部扩展的主入口”选择默认导出；核心模块的多个公共函数使用命名导出。
 * Pi 在本项目参考版本中的扩展入口也采用默认导出工厂函数，加载器按该约定取得入口。
 * 这里沿用入口组织方式；参数是本项目的 ExtensionAPI，通过它注册工具、命令和订阅事件。
 *
 * @param api 宿主提供的扩展 API。参数处直接解构出三个方法；
 *            `registerTool: register` 是解构时重命名的写法，表示取出 registerTool 并命名为 register。
 */
export default function registerUpper({
  registerTool: register,
  registerCommand,
  onAgentEnd,
}: ExtensionAPI): void {
  // 命令 /context：不返回值，而是通过 context.ui.notify 逐行输出。
  // 命令执行函数返回 void 时，宿主不会再额外输出内容。
  registerCommand({
    name: "context",
    // _args：用不到的参数习惯以下划线开头，表示“有意忽略”。
    // 仍需写出它，因为 context 是第 2 个参数，只能按位置接收。
    execute(_args, context) {
      context.ui.notify(`工作目录：${context.cwd}`);
      context.ui.notify(`模型：${context.model}`);
      // ??：左侧为 null 或 undefined 时取右侧值（尚未创建会话时 sessionFile 为 null）。
      context.ui.notify(`当前会话：${context.sessionFile ?? "尚未创建"}`);
    },
  });

  // runs 保存在本函数的闭包中，属于“这一次装载”的私有状态：
  // 订阅回调负责累加，/runs 命令负责读取；扩展卸载后重新装载会从 0 开始计数。
  let runs = 0;
  // 每次 Agent 运行结束（无论完成、取消还是出错）都会调用一次该回调。
  onAgentEnd(() => {
    runs++;
  });

  // 命令 /runs：直接返回字符串，由宿主负责输出给用户。
  registerCommand({
    name: "runs",
    execute: () => `本次装载已结束运行：${runs}`,
  });

  // 工具 upper：由模型决定何时调用，参数是模型构造的 JSON（见上方 definition 与 execute）。
  register({ definition, execute });

  // 用户直接输入命令时执行，不经过模型。
  registerCommand({
    name: "upper",
    execute: (args) => args.toUpperCase(),
  });
}
