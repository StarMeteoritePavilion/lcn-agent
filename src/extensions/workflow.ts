import type { ExtensionAPI } from "../core/tools.js";
import registerUpper from "./upper.js";
import registerTodo from "./todo.js";

/** 默认组合提问与待办能力；宿主统一装卸，共用注册和状态接口。 */
export default function registerWorkflow(api: ExtensionAPI): void {
  registerUpper(api);
  registerTodo(api);
}
