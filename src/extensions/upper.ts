import { RegisterTool, Tool } from "../core/tools.js";

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
 * 第 3 部分：扩展的统一入口，把工具定义和执行函数交给宿主注册。
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
 * 这里沿用入口组织方式；参数仍是本项目的 RegisterTool，不代表兼容 Pi 的 ExtensionAPI。
 */
export default function registerUpper(register: RegisterTool): void {
  register({ definition, execute });
}
