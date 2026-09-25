import type { ExtensionAPI, Tool } from "../core/tools.js";

// 第 1 部分：给模型看的说明书。
// 告诉模型：有个叫 echo 的工具，需要一个 string 类型的 text 参数。
const definition: Tool["definition"] = {
  type: "function",
  function: {
    name: "echo",
    description: "原样返回用户提供的文本",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要回显的文本" },
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
    throw new Error("echo 工具参数必须是对象");
  }

  // 已确认是对象，但字段类型仍未知，所以先当作“任意键、值未知”的对象读取。
  const { text } = args as Record<string, unknown>;

  // 校验 2：text 必须是字符串。
  if (typeof text !== "string") {
    throw new Error("echo 工具参数 text 必须是 string");
  }

  return text;
}

/**
 * 第 3 部分：把说明书和执行逻辑组合成一个工具，通过 ExtensionAPI 交给注册表。
 *
 * echo 是内嵌扩展（命名导出），由宿主直接 import 后通过 mountExtension 装载；
 * 不使用 export default，因此不通过 loadExtension 动态加载。
 *
 * @param api 宿主提供的扩展 API，此处解构出 registerTool 用于注册工具
 */
export function registerEcho({ registerTool: register }: ExtensionAPI): void {
  register({ definition, execute });
}
