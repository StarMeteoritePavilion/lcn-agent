import OpenAI from "openai";

/**
 * 一个可供模型调用的工具。
 *
 * 由两部分组成：
 * - definition：发给模型看的“说明书”（工具名、用途描述、参数 JSON Schema），
 *               模型据此决定是否调用、以及如何构造参数。
 * - execute:    本地真正执行工具逻辑的函数，返回值会作为 tool 消息的 content 回传给模型。
 */
export type Tool = {
  // ChatCompletionFunctionTool 是 OpenAI SDK 定义的函数工具结构：
  // { type: "function", function: { name, description?, parameters? } }。
  // 其中 function.name 是工具的唯一标识，注册表以它作为查找键。
  definition: OpenAI.Chat.Completions.ChatCompletionFunctionTool;
  // 参数来自模型，必须在执行具体操作前完成运行时校验。
  // 类型写成 unknown 而非具体结构，就是为了强制实现方先校验再使用：
  // 模型可能漏传字段、传错类型，甚至编造不存在的参数。
  execute: (args: unknown) => string;
};

/**
 * 注册工具的函数签名。
 *
 * 扩展只获得注册能力，不接触注册表内部的可变集合。
 * 即：把这个函数交给扩展模块，扩展只能“添加工具”，无法删除、覆盖或遍历已有工具。
 */
export type RegisterTool = (tool: Tool) => void;

/**
 * 工具注册表对外暴露的接口。
 *
 * - register:    注册一个新工具，工具名重复时抛错；返回一个“撤销注册”函数，调用后删除该工具。
 * - definitions: 获取所有已注册工具的 definition 列表，用于随请求一起发给模型（即请求参数 `tools`）。
 * - execute:     按工具名找到对应工具并执行，用于处理模型返回的 tool_calls。
 *
 * 注意 register 与 RegisterTool 的区别：
 * 宿主（如 mountExtension）拿到的是带返回值的 register，可以收集撤销函数统一卸载；
 * 交给扩展的是 RegisterTool（返回 void），扩展无法自行删除工具。
 * 由于“返回函数”的函数可以赋值给“返回 void”的函数类型，
 * registry.register 仍可直接当作 RegisterTool 传给扩展。
 */
export type ToolRegistry = {
  register: (tool: Tool) => () => void;
  definitions: () => OpenAI.Chat.Completions.ChatCompletionFunctionTool[];
  execute: (name: string, args: unknown) => string;
};

/**
 * 创建一个工具注册表。
 *
 * 典型使用流程：
 * 1. 启动时调用 register 注册所有工具；
 * 2. 每次请求模型时，把 definitions() 的结果作为 `tools` 参数传入，告诉模型有哪些工具可用；
 * 3. 模型回复中若包含 tool_calls，对每个调用执行 execute(call.function.name, 解析后的参数)，
 *    再把返回的字符串作为 role = "tool" 的消息回传给模型。
 *
 * 内部用闭包持有一个 Map 保存工具，外部只能通过返回对象上的三个方法访问，
 * 无法直接修改这份集合。
 *
 * @returns 新的 ToolRegistry 对象，初始不包含任何工具
 */
export function createToolRegistry(): ToolRegistry {
  // Map<工具名, 工具>：以 definition.function.name 为键。
  // 选用 Map 而非普通对象：键查找语义明确，且不会与 Object 原型上的属性名（如 "toString"）冲突。
  const tools = new Map<string, Tool>();

  /**
   * 注册一个工具。
   *
   * @param tool 要注册的工具
   * @returns 撤销注册函数：调用后从注册表删除该工具；重复调用无副作用
   * @throws {Error} 已存在同名工具时抛出。同名覆盖会让模型看到的说明书与实际执行的逻辑对不上，
   *                 因此直接拒绝，而不是静默替换。
   */
  const register: ToolRegistry["register"] = (tool) => {
    const name = tool.definition.function.name;

    // has: 判断 Map 中是否已存在该键。
    if (tools.has(name)) {
      throw new Error(`工具重名: ${name}`);
    }

    // set: 以工具名为键写入 Map。
    tools.set(name, tool);

    // 状态属于本次注册；即使重新注册同一个对象，旧撤销函数也不能误删它。
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      // delete: 按键删除 Map 中的条目。
      tools.delete(name);
    };
  };

  return {
    register,

    // 模型定义与执行路由都来自同一份集合，避免注册后漏发给模型。
    // （若分开维护“定义列表”和“执行映射”两份数据，很容易出现注册了却没告诉模型、
    //   或告诉了模型却找不到执行函数的情况。）
    //
    // Array.from 从可迭代对象创建新数组：
    // - 参数 1 iterable: tools.values()，按插入顺序遍历所有 Tool。
    // - 参数 2 mapFn:    对每个元素做映射，这里只取出 definition 部分。
    // 每次调用都返回新数组，调用方修改该数组不会影响注册表本身。
    definitions: () => Array.from(tools.values(), (tool) => tool.definition),

    /**
     * 按名称执行工具。
     *
     * @param name 工具名，通常来自模型返回的 tool_call.function.name
     * @param args 工具参数，通常是对 tool_call.function.arguments（JSON 字符串）解析后的结果；
     *             未经校验，由具体工具的 execute 自行校验
     * @returns 工具执行结果字符串，作为 tool 消息的 content 回传给模型
     * @throws {Error} 找不到对应工具时抛出（模型可能“幻觉”出一个不存在的工具名）；
     *                 工具自身执行抛出的错误也会原样向上传递
     */
    execute(name: string, args: unknown): string {
      // get: 按键取值，不存在时返回 undefined。
      const tool = tools.get(name);
      if (!tool) {
        throw new Error(`未知工具: ${name}`);
      }
      // ponytail: 本节点仅支持同步工具；接入异步工具时再贯通 await 与取消信号。
      return tool.execute(args);
    },
  };
}

/**
 * 装载一个同步静态扩展，将其工具注册归为同一批资源。
 * 返回值用于在当前运行结束后卸载；初始化抛错时自动撤销本次注册。
 */
export function mountExtension(
  registry: ToolRegistry,
  setup: (register: RegisterTool) => void,
): () => void {
  const disposers: Array<() => void> = [];
  let active = true;

  const dispose = (): void => {
    if (!active) return;
    active = false;
    // 按注册的逆序释放。本节点只收集宿主返回的工具删除函数。
    for (const cleanup of disposers.reverse()) {
      cleanup();
    }
    disposers.length = 0;
  };

  try {
    setup((tool) => {
      // 扩展可能保留注册函数；失效后也不允许向旧实例继续登记。
      if (!active) {
        throw new Error("扩展已卸载，不能继续注册工具");
      }
      disposers.push(registry.register(tool));
    });
  } catch (error) {
    dispose();
    throw error;
  }

  // ponytail: 仅管理同步工具注册；监听器、定时器等接入时再扩展资源清理协议。
  return dispose;
}
