import type { ExtensionAPI, Tool } from "../core/tools.js";

// 第 1 部分：给模型看的说明书。
// 告诉模型：有个叫 echo 的工具，需要一个 string 类型的 text 参数。
// Tool["definition"] 取出 Tool 类型里 definition 字段的类型，不必把整段结构再抄一遍。
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

/**
 * 第 2 部分：真正执行的逻辑。
 *
 * 宿主先按 Schema 校验参数；JSON.parse 和 TypeScript 类型本身不提供运行时校验。
 * 此处保留类型检查，使本函数独立收窄 unknown 后再使用参数。
 *
 * 不声明第 2 个参数 context：echo 不读文件、不等待，用不到 cwd / signal。
 * 参数更少的函数可以赋给 Tool.execute（见 core/tools.ts）。
 *
 * @param args 宿主对 tool_call.function.arguments 做 JSON.parse 后的值，类型未知
 * @returns 原样返回的 text，作为 tool 消息的 content 回传给模型
 * @throws {Error} args 不是对象，或 text 不是字符串
 */
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

  // 只要求有字符串 text；多出来的字段忽略，不在这里拒绝。
  return text;
}

/**
 * 第 3 部分：把说明书和执行逻辑组合成一个工具，通过 ExtensionAPI 交给注册表。
 *
 * echo 是最简单的同步工具：无副作用、不读上下文，宿主把它放进自动允许名单
 * （见 index.ts 的 allowedTools），调用时不必逐次确认。
 *
 * echo 是内嵌扩展（命名导出），由宿主直接 import 后通过 mountExtension 装载；
 * 不使用 export default，因此不通过 loadExtension 动态加载。
 * 与 delay.ts / upper.ts 的 default 入口不同：那些文件可能被路径加载，宿主事先不知道函数名。
 *
 * @param api 宿主提供的扩展 API，此处解构出 registerTool 用于注册工具。
 *            `registerTool: register` 是解构时重命名：取出 registerTool 并命名为 register。
 */
export function registerEcho({ registerTool: register }: ExtensionAPI): void {
  register({ definition, execute });
}
