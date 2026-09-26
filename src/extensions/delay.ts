import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "../core/tools.js";

/**
 * 延迟回显扩展：注册一个异步、可取消的工具 delay_echo，用于演示 ToolContext 与取消信号。
 *
 * - 工具 delay_echo：等待 3 秒后原样返回模型传入的 text。
 *   等待期间用户按 Ctrl+C，或本轮超过超时预算，等待会立即中止，
 *   宿主向模型回填“工具调用中断”的结果，而不是傻等 3 秒结束。
 *
 * 与 echo.ts 的区别：echo 是同步工具，立即返回；delay_echo 是 async 工具，
 * 通过 context.signal 响应取消。写法上这里把定义直接内联在 registerTool 调用中，
 * 而 echo.ts 把 definition 与 execute 拆成独立常量，两种写法效果相同。
 *
 * 与 upper.ts 一样使用 export default，供 loadExtension 通过文件路径动态加载，例如：
 * LCN_AGENT_EXTENSION=dist/extensions/delay.js
 *
 * @param api 宿主提供的扩展 API；本扩展只注册工具，因此参数处只解构出 registerTool
 */
export default function registerDelay({ registerTool }: ExtensionAPI): void {
  registerTool({
    // 给模型看的说明书：工具名、用途，以及需要一个 string 类型的 text 参数。
    definition: {
      type: "function",
      function: {
        name: "delay_echo",
        description: "等待三秒后返回文本，支持取消",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    },

    // 写成 async 函数：内部要 await 等待，返回值会自动包装成 Promise<string>。
    // 第 2 个参数 context 是宿主为本次调用创建的 ToolContext，这里只用到其中的 signal。
    async execute(args, context) {
      // 参数来自模型，必须先校验（原因见 core/tools.ts 的 Tool.execute）。
      // 这里用 `"text" in args` 收窄类型：确认对象上有 text 属性后，TypeScript 才允许读取 args.text；
      // 效果与 echo.ts 中“先断言为 Record<string, unknown> 再解构”的写法相同。
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        !("text" in args) ||
        typeof args.text !== "string"
      ) {
        throw new Error("delay_echo 参数 text 必须是字符串");
      }

      // delay（即 timers/promises 的 setTimeout）的三个参数说明见 upper.ts 的 /wait 命令。
      // 传入 context.signal 后，用户取消或本轮超时会让这里立即以 AbortError 拒绝，
      // 下面的 return 不会执行；宿主据信号状态判断为“取消”或“超时”，而不是普通的执行失败。
      await delay(3000, undefined, { signal: context.signal });
      return args.text;
    },
  });
}
