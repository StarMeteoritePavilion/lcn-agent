import type { ExtensionAPI } from "../core/tools.js";
import registerUpper from "./upper.js";
import registerTodo from "./todo.js";
import registerFiles from "./files.js";
import registerCommands from "./commands.js";
import registerPlan from "./plan.js";
import registerMemory from "./memory.js";
import registerWeb from "./web.js";
import registerSearch from "./search.js";

/**
 * 默认工作流扩展：把提问、待办、受限文件、前台命令、会话计划、项目记忆、受限网页读取与受限搜索
 * 装到同一次宿主装卸里。
 *
 * 宿主统一装卸，共用注册和状态接口。子扩展都使用同一份 ExtensionAPI：
 * 工具名、命令名冲突时仍由注册表报重名；待办和计划仍按各自命名空间落盘。
 *
 * 当前组合：
 * - upper.ts：演示命令、上下文、异步等待与提问；
 * - todo.ts：按会话持久化待办，提供命令和模型工具；
 * - files.ts：经宿主确认后读取、搜索、列目录，以及预览/保存小文本编辑；
 * - commands.ts：经宿主确认后，用绝对路径在工作目录运行前台程序；
 * - plan.ts：按会话保存当前计划；plan_show 只读，plan_set 须逐次确认；
 * - memory.ts：项目级记忆，只提供用户命令，不给模型写入工具；
 * - web.ts：经宿主确认后安全读取 Node.js 官方 API 文档（受限白名单与防 SSRF）；
 * - search.ts：经宿主确认后使用 Tavily 检索公网资料（最多 5 条、256 KiB 限制与凭据防泄漏）。
 *
 * echo 不在这里：它是内嵌命名导出，由入口单独 registerEcho。
 * delay_echo 也不在这里：默认需用 LCN_AGENT_EXTENSION 按路径加载。
 *
 * @param api 宿主提供的扩展 API，原样交给各个子扩展
 */
export default function registerWorkflow(api: ExtensionAPI): void {
  registerUpper(api);
  registerTodo(api);
  registerFiles(api);
  registerCommands(api);
  registerPlan(api);
  registerMemory(api);
  registerWeb(api);
  registerSearch(api);
}
