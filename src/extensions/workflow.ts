import type { ExtensionAPI } from "../core/tools.js";
import registerUpper from "./upper.js";
import registerTodo from "./todo.js";

/** 组合现有提问与待办能力，共用宿主提供的注册和状态接口。 */
export default function registerWorkflow(api: ExtensionAPI): void {
  registerUpper(api);
  registerTodo(api);
}
