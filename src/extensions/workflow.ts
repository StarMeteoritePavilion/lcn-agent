import type { ExtensionAPI } from "../core/tools.js";
import registerUpper from "./upper.js";
import registerTodo from "./todo.js";
import registerFiles from "./files.js";

/**
 * 默认工作流扩展：把提问、待办和受限文件读取与搜索装到同一次宿主装卸里。
 *
 * 宿主统一装卸，共用注册和状态接口。三个子扩展都使用同一份 ExtensionAPI：
 * 工具名、命令名冲突时仍由注册表报重名；待办状态仍按各自命名空间落盘。
 *
 * 当前组合：
 * - upper.ts：演示命令、上下文、异步等待与提问；
 * - todo.ts：按会话持久化待办，提供命令和模型工具；
 * - files.ts：经宿主确认后读取或搜索工作区内的小文本文件。
 *
 * echo 不在这里：它是内嵌命名导出，由入口单独 registerEcho。
 * delay_echo 也不在这里：默认需用 LCN_AGENT_EXTENSION 按路径加载。
 *
 * @param api 宿主提供的扩展 API，原样交给三个子扩展
 */
export default function registerWorkflow(api: ExtensionAPI): void {
  registerUpper(api);
  registerTodo(api);
  registerFiles(api);
}
