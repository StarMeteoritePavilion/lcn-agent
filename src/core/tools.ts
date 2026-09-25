import OpenAI from "openai";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
 * 一个可供用户在交互命令行中以 `/名称` 形式调用的命令。
 *
 * 与 Tool 的区别：Tool 由模型决定何时调用，参数是模型构造的 JSON；
 * Command 由用户直接输入触发，参数是斜杠后的原始字符串。
 */
export type Command = {
  /** 命令名（不含斜杠），必须匹配 /^[a-z][a-z0-9_]*$/ 的格式约定。 */
  name: string;
  /**
   * 命令执行函数。
   *
   * @param args 用户在命令名之后输入的原始文本（已去除命令名前缀）
   * @returns 执行结果字符串，输出给用户
   */
  execute: (args: string) => string;
};

/**
 * 扩展 API：扩展通过同一个入口对象注册工具和命令两种能力。
 *
 * - registerTool:    注册一个可被模型调用的工具（签名为 RegisterTool，返回 void）。
 * - registerCommand: 注册一个可被用户以 `/名称` 调用的命令（签名同样返回 void）。
 *
 * 扩展拿到的 API 只有"添加"能力，无法删除、覆盖或遍历已有注册项；
 * 卸载由宿主（mountExtension）统一管理。
 */
export type ExtensionAPI = {
  registerTool: RegisterTool;
  registerCommand: (command: Command) => void;
};

/**
 * 注册工具的函数签名。
 *
 * 扩展只获得注册能力，不接触注册表内部的可变集合。
 * 即：把这个函数交给扩展模块，扩展只能“添加工具”，无法删除、覆盖或遍历已有工具。
 */
export type RegisterTool = (tool: Tool) => void;

/**
 * 工具与命令注册表对外暴露的接口。
 *
 * 工具侧：
 * - register:    注册一个新工具，工具名重复时抛错；返回一个"撤销注册"函数，调用后删除该工具。
 * - definitions: 获取所有已注册工具的 definition 列表，用于随请求一起发给模型（即请求参数 `tools`）。
 * - execute:     按工具名找到对应工具并执行，用于处理模型返回的 tool_calls。
 *
 * 命令侧：
 * - registerCommand: 注册一个用户命令，命令名重复或与宿主保留命令冲突时抛错；返回撤销函数。
 * - executeCommand:  按命令名找到对应命令并执行，用于处理用户输入的 `/命令名` 交互指令。
 *
 * 注意 register 与 RegisterTool 的区别：
 * 宿主（如 mountExtension）拿到的是带返回值的 register，可以收集撤销函数统一卸载；
 * 交给扩展的是 RegisterTool（返回 void），扩展无法自行删除工具。
 * 由于"返回函数"的函数可以赋值给"返回 void"的函数类型，
 * registry.register 仍可直接当作 RegisterTool 传给扩展。
 * registerCommand 同理。
 */
export type ToolRegistry = {
  register: (tool: Tool) => () => void;
  definitions: () => OpenAI.Chat.Completions.ChatCompletionFunctionTool[];
  execute: (name: string, args: unknown) => string;
  registerCommand: (command: Command) => () => void;
  executeCommand: (name: string, args: string) => string;
};

/**
 * 创建一个工具与命令注册表。
 *
 * 典型使用流程（工具侧）：
 * 1. 启动时调用 register 注册所有工具；
 * 2. 每次请求模型时，把 definitions() 的结果作为 `tools` 参数传入，告诉模型有哪些工具可用；
 * 3. 模型回复中若包含 tool_calls，对每个调用执行 execute(call.function.name, 解析后的参数)，
 *    再把返回的字符串作为 role = "tool" 的消息回传给模型。
 *
 * 典型使用流程（命令侧）：
 * 1. 启动时调用 registerCommand 注册扩展命令；
 * 2. 用户在交互模式输入 `/命令名 参数` 时，调用 executeCommand 执行。
 *
 * 内部用闭包持有两个 Map 分别保存工具和命令，外部只能通过返回对象上的五个方法访问，
 * 无法直接修改这两份集合。
 *
 * @returns 新的 ToolRegistry 对象，初始不包含任何工具和命令
 */
export function createToolRegistry(): ToolRegistry {
  // Map<工具名, 工具>：以 definition.function.name 为键。
  // 选用 Map 而非普通对象：键查找语义明确，且不会与 Object 原型上的属性名（如 "toString"）冲突。
  const tools = new Map<string, Tool>();

  // Map<命令名, 命令>：以 command.name 为键，存储所有已注册的扩展命令。
  const commands = new Map<string, Command>();
  // 宿主保留命令集合：这些命令名由宿主（index.ts）直接处理，扩展不可覆盖。
  const reserved = new Set(["exit", "new", "sessions", "history", "diagnostics", "resume"]);

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

    /**
     * 注册一个用户命令。
     *
     * @param command 要注册的命令对象
     * @returns 撤销注册函数：调用后从注册表删除该命令；重复调用无副作用
     * @throws {Error} 命令名不符合 /^[a-z][a-z0-9_]*$/ 格式约定时抛出
     * @throws {Error} 命令名与宿主保留命令冲突时抛出
     * @throws {Error} 已存在同名命令时抛出
     */
    registerCommand(command: Command): () => void {
      const { name } = command;

      // 正则校验：命令名必须以小写字母开头，仅含小写字母、数字和下划线；不带斜杠前缀。
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        throw new Error(`命令名不合法: ${name}`);
      }
      // has: 检查 Set 中是否包含该值（说明同 Map.has）。
      if (reserved.has(name)) {
        throw new Error(`宿主命令不可覆盖: ${name}`);
      }
      if (commands.has(name)) {
        throw new Error(`命令重名: ${name}`);
      }

      commands.set(name, command);

      // 状态属于本次注册，旧清理函数不能删除后续注册（逻辑同 register 的 active 守卫）。
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        commands.delete(name);
      };
    },

    /**
     * 按名称执行命令。
     *
     * @param name 命令名（不含斜杠前缀），通常来自用户交互输入
     * @param args 命令参数，即用户在命令名之后输入的原始文本
     * @returns 命令执行结果字符串，输出给用户
     * @throws {Error} 找不到对应命令时抛出
     */
    executeCommand(name: string, args: string): string {
      const command = commands.get(name);
      if (!command) throw new Error(`未知命令: /${name}`);
      return command.execute(args);
    },
  };
}

/**
 * 装载一个同步静态扩展，将其注册的工具和命令归为同一批资源。
 *
 * "扩展"就是一个接收 ExtensionAPI 的普通函数（如 registerEcho），
 * 它在内部通过 api.registerTool / api.registerCommand 注册工具和命令。
 * mountExtension 负责在中间"记账"：扩展每注册一个工具或命令，就把对应的撤销函数记下来，
 * 这样之后可以一次性卸载这个扩展注册的全部工具和命令，而不影响其他扩展。
 *
 * 典型用法：
 * ```ts
 * const dispose = mountExtension(registry, (api) => {
 *   api.registerTool({ definition, execute });
 *   api.registerCommand({ name: "greet", execute: () => "hello" });
 * });
 * // ……运行期间扩展注册的工具和命令可用……
 * dispose(); // 卸载：该扩展注册的全部工具和命令从注册表移除
 * ```
 *
 * 要点：
 * - 全有或全无：setup 执行中途抛错时，已注册的工具和命令会全部撤销，不会残留"注册了一半"的扩展。
 * - 卸载后失效：扩展若偷偷保存了 api 对象、卸载后再调用注册方法，会直接抛错。
 * - 返回的 dispose 可重复调用，只有第一次生效。
 *
 * @param registry 工具和命令要注册到的目标注册表
 * @param setup 扩展的注册函数，接收一个 ExtensionAPI 对象，通过它登记工具和命令；必须是同步函数
 * @returns 卸载函数：调用后按注册的逆序撤销该扩展注册的所有工具和命令
 * @throws {Error} setup 抛出的错误会在撤销已注册项后原样向上传递（包括工具/命令重名错误）
 */
export function mountExtension(
  registry: ToolRegistry,
  setup: (api: ExtensionAPI) => void,
): () => void {
  // 本扩展每注册一个工具或命令，就把 registry.register / registry.registerCommand 返回的撤销函数存到这里。
  const disposers: Array<() => void> = [];
  // 扩展是否仍处于装载状态；dispose 后置为 false，之后的注册请求一律拒绝。
  let active = true;

  /**
   * 卸载本扩展注册的全部工具和命令。重复调用时直接返回，不会重复撤销。
   */
  const dispose = (): void => {
    if (!active) return;
    active = false;
    // 按注册的逆序释放。本节点收集宿主返回的工具和命令删除函数。
    // （逆序是资源清理的惯例：后申请的资源可能依赖先申请的，先释放后者更安全。）
    //
    // reverse: 原地反转数组并返回该数组本身；此处数组随后即被清空，原地修改无副作用。
    for (const cleanup of disposers.reverse()) {
      cleanup();
    }
    // 把数组长度设为 0 即清空数组，释放对撤销函数的引用。
    disposers.length = 0;
  };

  try {
    // 工具和命令的撤销函数归属于同一个扩展实例。
    setup({
      registerTool(tool) {
        if (!active) {
          throw new Error("扩展已卸载，不能继续注册工具");
        }
        disposers.push(registry.register(tool));
      },
      registerCommand(command) {
        if (!active) {
          throw new Error("扩展已卸载，不能继续注册命令");
        }
        disposers.push(registry.registerCommand(command));
      },
    });
  } catch (error) {
    // 初始化失败：撤销本次已经注册成功的工具和命令，再把原错误抛给调用方。
    dispose();
    throw error;
  }

  // ponytail: 仅管理同步工具和命令注册；监听器、定时器等接入时再扩展资源清理协议。
  return dispose;
}

/**
 * 从磁盘文件动态加载一个扩展并装载到注册表。
 *
 * 与 mountExtension 的区别：mountExtension 接收的是代码里已经 import 好的函数，
 * loadExtension 接收的是文件路径，在运行时才去导入模块，适合加载用户自定义的扩展文件。
 *
 * 对扩展文件的要求：必须用 `export default` 默认导出注册函数，该函数接收 ExtensionAPI 对象，例如：
 * ```ts
 * export default function (api) {
 *   api.registerTool({ definition, execute });
 *   api.registerCommand({ name: "greet", execute: () => "hello" });
 * }
 * ```
 *
 * @param registry 工具和命令要注册到的目标注册表
 * @param file 扩展文件路径，可以是相对路径（相对于当前工作目录 process.cwd()）或绝对路径；
 *             Node.js 需要能直接执行该文件（通常是 .js / .mjs）
 * @returns Promise，完成后得到卸载函数（即 mountExtension 的返回值）
 * @throws {Error} 文件不存在、模块执行出错、未默认导出函数、或注册过程出错时抛出；
 *                 错误信息统一带上扩展的绝对路径，原始错误保存在 cause 中便于排查
 */
export async function loadExtension(registry: ToolRegistry, file: string): Promise<() => void> {
  // resolve: 把路径转换为绝对路径。
  // - 参数 1 path: 若为相对路径，则以当前工作目录（process.cwd()）为基准拼接。
  // 转成绝对路径后，报错信息能明确指出是哪个文件，不受工作目录变化影响。
  const absolutePath = resolve(file);

  try {
    // import(): 动态导入模块，返回 Promise，完成后得到模块命名空间对象
    //           （所有导出都挂在它上面，默认导出在 .default 属性）。
    // 与文件顶部的静态 import 不同，动态 import 可以在运行时根据变量决定加载哪个文件。
    //
    // pathToFileURL: 把文件系统路径转换为 file:// URL 对象，.href 取其字符串形式。
    // - 参数 1 path: 要转换的绝对路径。
    // ESM 的 import() 需要 URL 形式的模块标识；直接传路径在 Windows 上会失败
    // （如 "C:\\ext.js" 会被误认为协议名为 "c:" 的 URL），路径中的空格、中文等特殊字符也会被正确编码。
    const extension = await import(pathToFileURL(absolutePath).href);

    // 默认导出是宿主与外部扩展约定的统一入口，不依赖扩展内部的具体函数名。
    // export default function registerUpper 对应 extension.default；
    // export function registerUpper 则对应 extension.registerUpper，不能直接满足当前约定。
    // 运行时检查只确认入口可调用；其参数契约以及同步注册要求仍由扩展实现遵守。
    if (typeof extension.default !== "function") {
      throw new Error("扩展必须默认导出注册函数");
    }
    return mountExtension(registry, extension.default);
  } catch (error) {
    // 统一包装错误：无论是导入失败、校验失败还是注册失败，都在消息里附上扩展路径。
    // throw 的值不一定是 Error 实例（JS 允许 throw 任意值），所以先判断再取 message。
    const reason = error instanceof Error ? error.message : String(error);
    // Error 构造函数：
    // - 参数 1 message: 错误描述。
    // - 参数 2 options: { cause } 记录引发本错误的原始错误，保留完整的错误链与堆栈，便于调试。
    throw new Error(`加载扩展失败（${absolutePath}）：${reason}`, { cause: error });
  }
}
