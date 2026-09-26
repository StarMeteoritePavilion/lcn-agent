import OpenAI from "openai";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 宿主为单次调用确认工具名、参数快照和调用 ID；取消与超时通过 signal 传递。 */
export type ConfirmTool = (
  name: string,
  argumentsJson: string,
  callId: string,
  signal: AbortSignal,
) => Promise<boolean>;

/**
 * 工具执行时的上下文：宿主在每次执行工具调用时创建，提供只读的运行信息与取消信号。
 *
 * 与 CommandContext 的区别：
 * - 工具只会在 Agent 运行中被调用，此时一定已有会话，所以 sessionFile 不会是 null；
 * - 工具由模型触发，用户不在“对话框前”等待回答，因此没有通用 ui；仅提供宿主控制的 confirm 授权回调；
 * - 多了 callId，用于区分同一轮中的多次工具调用。
 *
 * - cwd:         当前工作目录。
 * - model:       当前使用的模型名称。
 * - sessionFile: 当前会话文件名。
 * - callId:      本次工具调用的 ID，即模型返回的 tool_call.id；与写入会话的 tool 消息一一对应。
 * - signal:      本轮的取消信号：用户按 Ctrl+C 或本轮超时时被触发。
 */
export type ToolContext = Readonly<{
  confirm: ConfirmTool;
  cwd: string;
  model: string;
  sessionFile: string;
  callId: string;
  // 与 CommandContext.signal 相同，由工具自行响应（说明见下方 CommandContext）。
  // 注意它是“本轮”的信号：模型请求与本轮所有工具调用共享同一个超时预算。
  signal: AbortSignal;
}>;

/**
 * 工具权限策略：在每次执行工具前被调用，决定这次调用是否允许执行。
 *
 * 策略由宿主提供，可自动允许、拒绝或请求用户逐次确认。
 * 宿主提供不可变的 JSON 参数快照；最终执行重新解析同一快照，确认期间参数不会漂移。
 *
 * 为什么需要它：工具由模型决定何时调用、传什么参数。扩展注册了工具，
 * 不代表宿主愿意让模型随意调用它——尤其是会写文件、发请求等有副作用的工具。
 * 权限策略把“能不能执行”的决定权留在宿主手里，而不是交给模型或扩展。
 *
 * @param name 本次要执行的工具名
 * @param argumentsJson 本次待执行的 JSON 参数快照，用于明确展示批准的内容
 * @param context 本次调用的上下文（见 ToolContext）；可用于按会话、按调用做判断，
 *                或把 context.signal 传给异步判定（例如等待用户确认）以支持取消
 * @returns 严格等于 true 才允许执行；false、其他值，或 Promise 最终不是 true 都会被拒绝。
 *          可以同步返回，也可以写成 async 函数（例如需要询问用户时）
 */
export type ToolPermission = (
  name: string,
  argumentsJson: string,
  context: ToolContext,
) => boolean | Promise<boolean>;

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
  //
  // context 是本次调用的上下文（见 ToolContext）；用不到时可以不声明这个参数，
  // 例如 echo 的 execute(args) —— 参数更少的函数可以赋值给参数更多的函数类型。
  //
  // 返回值既可以是字符串，也可以是 Promise<string>（写成 async 函数），宿主都会 await。
  // 耗时的异步工具应响应 context.signal，以便用户取消或超时时尽快停止。
  execute: (args: unknown, context: ToolContext) => string | Promise<string>;
};

/**
 * 运行结束事件的字段结构。
 *
 * 与 Agent 循环已有的运行结束事件保持一致。
 * - type:   固定为 "agent_end"，用于在事件联合类型中区分事件种类。
 * - reason: 结束原因 —— completed 正常完成、cancelled 用户取消、timeout 本轮超时、loop_limit 达到最大轮次、
 *           truncated 输出被截断、error 运行出错。
 * - round:  结束时所处的轮次。
 */
export type AgentEndEventFields = {
  type: "agent_end";
  reason: "completed" | "cancelled" | "timeout" | "loop_limit" | "truncated" | "error";
  round: number;
};

// Readonly: 把所有字段变为只读，监听器只能读取事件，不能修改它。
export type AgentEndEvent = Readonly<AgentEndEventFields>;

export type AgentEndListener = (event: AgentEndEvent) => void;

/**
 * 命令执行时的上下文：宿主提供给命令的只读运行信息与输入输出能力。
 *
 * 每次命令执行时由宿主创建，不暴露可修改的会话对象。
 * （每次执行都新建，因此命令总能读到最新的会话状态，而不是注册时的旧值。）
 *
 * - cwd:         当前工作目录。
 * - model:       当前使用的模型名称。
 * - sessionFile: 当前会话文件名；尚未创建会话时为 null。
 * - signal:      本次命令的取消信号（AbortSignal），用户按 Ctrl+C 时被触发。
 * - ui.notify:   向用户输出一行消息。适合需要输出多行、或边执行边输出的命令。
 * - ui.ask:      向用户提问并等待回答，返回 Promise<用户输入的一行文本>；需在 async 命令中 await。
 *                以下情况 Promise 会被拒绝：命令已取消（含等待回答时按 Ctrl+C）、
 *                输入已关闭、不是终端环境、或已有另一个提问正在等待回答。
 */
export type CommandContext = Readonly<{
  cwd: string;
  model: string;
  sessionFile: string | null;
  // 由宿主发出取消信号，异步命令负责响应。
  // “响应”指：把 signal 传给支持取消的 API（如 fetch、timers/promises 的 setTimeout），
  // 或在耗时步骤之间检查 signal.aborted / 调用 signal.throwIfAborted()。
  // 宿主无法强行中断正在执行的 JS 代码，不响应信号的命令会一直运行到结束。
  signal: AbortSignal;
  ui: Readonly<{
    notify: (message: string) => void;
    // 等待用户提交一行回答；取消或无法交互时拒绝 Promise。
    ask: (question: string) => Promise<string>;
  }>;
}>;

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
   * @param context 本次执行的上下文（工作目录、模型、会话文件、取消信号与输出能力），见 CommandContext
   * @returns 返回字符串时，宿主把它输出给用户；
   *          不返回（void）时宿主不额外输出，适合已通过 context.ui.notify 自行输出的命令。
   *          既可以同步返回，也可以写成 async 函数返回 Promise，宿主都会 await 等待结果；
   *          耗时的异步命令应响应 context.signal，以便用户按 Ctrl+C 取消。
   */
  execute: (args: string, context: CommandContext) => string | void | Promise<string | void>;
};

/**
 * 扩展 API：扩展通过同一个入口对象注册工具、命令和事件监听三种能力。
 *
 * - registerTool:    注册一个可被模型调用的工具（签名为 RegisterTool，返回 void）。
 * - registerCommand: 注册一个可被用户以 `/名称` 调用的命令（签名同样返回 void）。
 * - onAgentEnd:      订阅“一次 Agent 运行结束”事件（同样返回 void，不给扩展取消订阅的函数）。
 *
 * 扩展拿到的 API 只有"添加"能力，无法删除、覆盖或遍历已有注册项；
 * 卸载由宿主（mountExtension）统一管理。
 */
export type ExtensionAPI = {
  registerTool: RegisterTool;
  registerCommand: (command: Command) => void;
  onAgentEnd: (listener: AgentEndListener) => void;
};

/**
 * 注册工具的函数签名。
 *
 * 扩展只获得注册能力，不接触注册表内部的可变集合。
 * 即：把这个函数交给扩展模块，扩展只能“添加工具”，无法删除、覆盖或遍历已有工具。
 */
export type RegisterTool = (tool: Tool) => void;

/**
 * 工具、命令与运行结束事件注册表对外暴露的接口。
 *
 * 工具侧：
 * - register:    注册一个新工具，工具名重复时抛错；返回一个"撤销注册"函数，调用后删除该工具。
 * - definitions: 获取所有已注册工具的 definition 列表，用于随请求一起发给模型（即请求参数 `tools`）。
 * - execute:     按工具名找到对应工具并执行，用于处理模型返回的 tool_calls；
 *                宿主需传入本次调用的 ToolContext。执行前会先经过权限策略判定，未获授权则拒绝。
 *                与 executeCommand 一样始终返回 Promise。
 *
 * 命令侧：
 * - registerCommand: 注册一个用户命令，命令名重复或与宿主保留命令冲突时抛错；返回撤销函数。
 * - executeCommand:  按命令名找到对应命令并执行，用于处理用户输入的 `/命令名` 交互指令；
 *                    宿主需传入本次执行的 CommandContext。始终返回 Promise，
 *                    因此同步命令和异步命令对宿主而言用法一致（都用 await 获取结果）。
 *
 * 运行结束事件侧：
 * - onAgentEnd:   订阅运行结束事件；返回取消订阅函数。
 * - emitAgentEnd: 由宿主在每次 Agent 运行结束时调用，通知所有订阅者；返回监听器失败提示列表。
 *
 * 注意 register 与 RegisterTool 的区别：
 * 宿主（如 mountExtension）拿到的是带返回值的 register，可以收集撤销函数统一卸载；
 * 交给扩展的是 RegisterTool（返回 void），扩展无法自行删除工具。
 * 由于"返回函数"的函数可以赋值给"返回 void"的函数类型，
 * registry.register 仍可直接当作 RegisterTool 传给扩展。
 * registerCommand、onAgentEnd 同理。
 */
export type ToolRegistry = {
  register: (tool: Tool) => () => void;
  definitions: () => OpenAI.Chat.Completions.ChatCompletionFunctionTool[];
  execute: (name: string, args: unknown, context: ToolContext) => Promise<string>;
  registerCommand: (command: Command) => () => void;
  executeCommand: (name: string, args: string, context: CommandContext) => Promise<string | void>;
  onAgentEnd: (listener: AgentEndListener) => () => void;
  emitAgentEnd: (event: AgentEndEvent) => string[];
};

/**
 * 创建一个工具、命令与运行结束事件的注册表。
 *
 * 典型使用流程（工具侧）：
 * 1. 启动时调用 register 注册所有工具；
 * 2. 每次请求模型时，把 definitions() 的结果作为 `tools` 参数传入，告诉模型有哪些工具可用；
 * 3. 模型回复中若包含 tool_calls，宿主为每个调用创建 ToolContext，
 *    执行 await execute(call.function.name, 解析后的参数, context)，
 *    再把返回的字符串作为 role = "tool" 的消息回传给模型。
 *    execute 内部会先调用创建注册表时传入的 permit 判定是否允许执行。
 *
 * 注意“注册”与“授权”是两回事：
 * - 注册（register）决定工具是否存在：注册后 definitions() 会把它发给模型，模型就可能调用它；
 * - 授权（permit）决定调用时能否真正执行：未授权的工具被调用时，execute 抛出“工具未获授权”，
 *   宿主把这条错误作为工具结果回填，模型就知道这次调用没有执行。
 *
 * 典型使用流程（命令侧）：
 * 1. 启动时调用 registerCommand 注册扩展命令；
 * 2. 用户在交互模式输入 `/命令名 参数` 时，宿主创建本次的 AbortController 与 CommandContext，
 *    调用 await executeCommand(命令名, 参数, context) 执行；用户按 Ctrl+C 时宿主触发取消信号。
 *
 * 典型使用流程（运行结束事件）：
 * 1. 扩展调用 onAgentEnd 订阅“一次 Agent 运行结束”的通知；
 * 2. 宿主在每次运行结束时调用 emitAgentEnd，依次通知所有订阅者。
 *
 * 代码结构：
 * - 开头声明内部数据（Map / Set），它们只存在于本函数的闭包中；
 * - 中间按“工具 / 命令 / 运行结束事件”三组定义具名函数；
 * - 结尾把 7 个函数组装成对象返回。外部只能通过这 7 个函数操作数据，拿不到 Map / Set 本身。
 *
 * @param permit 工具权限策略（见 ToolPermission），每次执行工具前调用。
 *               默认值 `() => false` 拒绝一切工具：不传策略时，任何工具都不会被执行。
 *               这叫“默认拒绝”——忘记配置权限时宁可工具用不了，也不能让模型随意执行。
 * @returns 新的 ToolRegistry 对象，初始不包含任何工具、命令和监听器
 */
export function createToolRegistry(permit: ToolPermission = () => false): ToolRegistry {
  // ── 内部数据：只在本函数内可见 ──

  // Map<工具名, 工具>：以 definition.function.name 为键。
  // 选用 Map 而非普通对象：键查找语义明确，且不会与 Object 原型上的属性名（如 "toString"）冲突。
  const tools = new Map<string, Tool>();

  // Map<命令名, 命令>：以 command.name 为键，存储所有已注册的扩展命令。
  const commands = new Map<string, Command>();
  // 宿主保留命令集合：这些命令名由宿主（index.ts）直接处理，扩展不可覆盖。
  const reserved = new Set(["exit", "new", "sessions", "history", "diagnostics", "resume"]);

  // 运行结束事件的订阅者集合。Set 会保持插入顺序，因此通知顺序即订阅顺序。
  const listeners = new Set<AgentEndListener>();

  // ── 工具 ──

  /**
   * 注册一个工具。
   *
   * @param tool 要注册的工具
   * @returns 撤销注册函数：调用后从注册表删除该工具；重复调用无副作用
   * @throws {Error} 已存在同名工具时抛出。同名覆盖会让模型看到的说明书与实际执行的逻辑对不上，
   *                 因此直接拒绝，而不是静默替换。
   */
  function register(tool: Tool): () => void {
    const name = tool.definition.function.name;

    // has: 判断 Map 中是否已存在该键。
    if (tools.has(name)) {
      throw new Error(`工具重名: ${name}`);
    }

    // set: 以工具名为键写入 Map。
    tools.set(name, tool);

    // 状态属于本次注册；即使重新注册同一个对象，旧撤销函数也不能误删它。
    // once 保证撤销函数只在第一次调用时生效（见文件末尾的 once）。
    // delete: 按键删除 Map 中的条目。
    return once(() => tools.delete(name));
  }

  /**
   * 获取所有已注册工具的定义，用于随请求发给模型（请求参数 `tools`）。
   *
   * 模型定义与执行路由都来自同一份集合，避免注册后漏发给模型。
   * （若分开维护“定义列表”和“执行映射”两份数据，很容易出现注册了却没告诉模型、
   *   或告诉了模型却找不到执行函数的情况。）
   *
   * @returns 按注册顺序排列的 definition 新数组；调用方修改该数组不会影响注册表本身
   */
  function definitions(): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
    // Array.from 从可迭代对象创建新数组：
    // - 参数 1 iterable: tools.values()，按插入顺序遍历所有 Tool。
    // - 参数 2 mapFn:    对每个元素做映射，这里只取出 definition 部分。
    return Array.from(tools.values(), (tool) => tool.definition);
  }

  /**
   * 按名称执行工具。
   *
   * 执行顺序：查找工具 → 检查取消 → 权限判定 → 再次检查取消 → 执行工具。
   * 任何一步不通过都会抛错，后面的步骤不再进行。
   *
   * @param name 工具名，通常来自模型返回的 tool_call.function.name
   * @param args 工具参数，通常是对 tool_call.function.arguments（JSON 字符串）解析后的结果；
   *             未经校验，由具体工具的 execute 自行校验
   * @param context 本次调用的上下文，传给权限策略 permit 和工具的 execute
   * @returns Promise，完成后得到工具执行结果字符串，作为 tool 消息的 content 回传给模型
   * @throws {Error} 以下情况 Promise 会被拒绝（reject）：
   *   - 找不到对应工具（模型可能“幻觉”出一个不存在的工具名）；
   *   - 执行前或权限判定后 context.signal 已被触发（用户取消或本轮超时）；
   *   - 权限策略自身抛错（“工具权限判定失败”）或未返回 true（“工具未获授权”）；
   *   - 工具自身抛错，或异步工具响应取消信号而中止。
   */
  async function execute(name: string, args: unknown, context: ToolContext): Promise<string> {
    // 写成 async 函数的原因同 executeCommand：同步和异步工具对宿主而言都返回 Promise。
    // get: 按键取值，不存在时返回 undefined。
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`未知工具: ${name}`);
    }
    // 已取消或超时时不做权限判定、也不启动工具（throwIfAborted 说明见 executeCommand）。
    context.signal.throwIfAborted();

    // 参数来自核心解析后的 JSON。审批及最终执行共用字符串快照，避免等待期间原对象被改写。
    const argumentsJson = JSON.stringify(args);
    if (argumentsJson === undefined) throw new Error("工具参数必须是 JSON 值");
    let allowed: boolean;
    try {
      // await 同时兼容同步和异步策略：对普通值 await 会直接得到该值。
      allowed = await permit(name, argumentsJson, context);
    } catch {
      // 取消优先；其他策略异常阻止执行，不透传任意异常正文。
      // - 取消优先：若策略是因为响应取消信号而抛错，就按取消处理（抛出取消原因），
      //   宿主会据此显示“用户取消 / 本轮超时”，而不是误报为权限问题；
      // - 策略出错时“失败即拒绝”：判定不出结果就不执行，不能当作允许；
      // - 不透传原始错误正文：策略的异常信息可能包含内部细节，只返回统一提示给模型。
      context.signal.throwIfAborted();
      throw new Error(`工具权限判定失败: ${name}`);
    }

    // 等待判定期间可能发生取消，执行前必须再次检查。
    // （例如策略需要询问用户，用户在确认期间按了 Ctrl+C。）
    context.signal.throwIfAborted();

    // 用 !== true 而非 !allowed：只有明确返回 true 才放行。
    // 策略若因 bug 返回了 "yes"、1 等“真值”，也一律拒绝，避免误放行。
    if (allowed !== true) {
      throw new Error(`工具未获授权: ${name}`);
    }

    return tool.execute(JSON.parse(argumentsJson), context);
  }

  // ── 命令 ──

  /**
   * 注册一个用户命令。
   *
   * @param command 要注册的命令对象
   * @returns 撤销注册函数：调用后从注册表删除该命令；重复调用无副作用
   * @throws {Error} 命令名不符合 /^[a-z][a-z0-9_]*$/ 格式约定时抛出
   * @throws {Error} 命令名与宿主保留命令冲突时抛出
   * @throws {Error} 已存在同名命令时抛出
   */
  function registerCommand(command: Command): () => void {
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

    // 状态属于本次注册，旧清理函数不能删除后续注册（逻辑同 register）。
    return once(() => commands.delete(name));
  }

  /**
   * 按名称执行命令。
   *
   * @param name 命令名（不含斜杠前缀），通常来自用户交互输入
   * @param args 命令参数，即用户在命令名之后输入的原始文本
   * @param context 本次执行的上下文，原样传给命令的 execute
   * @returns Promise，完成后得到命令返回的字符串（由宿主输出给用户）；命令不返回时为 undefined
   * @throws {Error} 以下情况 Promise 会被拒绝（reject）：
   *   - 找不到对应命令；
   *   - 执行前 context.signal 已被取消（抛出的是信号的取消原因，默认为 AbortError）；
   *   - 命令自身抛错，或异步命令响应取消信号而中止。
   */
  async function executeCommand(
    name: string,
    args: string,
    context: CommandContext,
  ): Promise<string | void> {
    // async 函数总是返回 Promise：
    // - 命令同步返回值时，会被自动包装成已完成的 Promise；
    // - 命令返回 Promise 时，直接沿用它的结果；
    // - 函数内的 throw（包括同步命令抛出的错误）会变成被拒绝的 Promise，由调用方的 await 抛出。
    const command = commands.get(name);
    if (!command) {
      throw new Error(`未知命令: /${name}`);
    }
    // 已取消时不启动命令；执行中的取消由命令响应信号。
    // throwIfAborted: 若信号已被触发则立即抛出取消原因（signal.reason），否则什么也不做。
    context.signal.throwIfAborted();
    return command.execute(args, context);
  }

  // ── 运行结束事件 ──

  /**
   * 订阅“一次 Agent 运行结束”事件。
   *
   * @param listener 运行结束时被调用的回调，会收到只读的事件对象
   * @returns 取消订阅函数：调用后不再收到通知；重复调用无副作用
   */
  function onAgentEnd(listener: AgentEndListener): () => void {
    // 每次订阅独立包装，同一个回调多次订阅也能分别清理。
    // 原因：Set 会自动去重。若直接 add(listener)，同一个函数订阅两次只会存一份，
    // 其中任意一次取消订阅都会把它删掉，另一次订阅就“莫名失效”了。
    // 包一层新函数后，每次订阅在 Set 中都是不同的成员，互不影响。
    const subscription: AgentEndListener = (event) => listener(event);
    listeners.add(subscription);

    return () => {
      // Set.delete 对不存在的成员直接返回 false，本身就可重复调用，无需 once。
      listeners.delete(subscription);
    };
  }

  /**
   * 广播运行结束事件，按订阅顺序依次通知所有监听器。
   *
   * @param event 本次运行结束事件
   * @returns 监听器执行失败的提示列表；全部成功时为空数组。
   *          单个监听器失败不会抛出，也不会阻止后续监听器执行，由宿主决定如何展示这些提示。
   */
  function emitAgentEnd(event: AgentEndEvent): string[] {
    const errors: string[] = [];

    // 浅拷贝并冻结事件对象，所有监听器拿到的都是同一份不可修改的快照。
    // Readonly 类型只在编译期生效；Object.freeze 在运行时也阻止修改，
    // 防止某个监听器改动事件后，后面的监听器看到被篡改的数据。
    const snapshot = Object.freeze({ ...event });

    // 按订阅顺序通知，本轮新增的监听器留到下次。
    // [...listeners] 先把 Set 复制成数组再遍历：
    // 若直接遍历 Set，监听器在回调中新增的订阅也会在本轮被遍历到。
    for (const listener of [...listeners]) {
      // 复制出的数组是遍历开始时的名单；若某监听器在本轮被前面的回调取消订阅，
      // 它已不在 Set 中，此处跳过，不再通知。
      if (!listeners.has(listener)) {
        continue;
      }

      try {
        listener(snapshot);
      } catch {
        // 观察回调失败不阻止其他监听器，不透传任意异常正文。
        errors.push("运行结束监听器执行失败");
      }
    }

    return errors;
  }

  // ── 对外只暴露这 7 个函数；上面的 Map / Set 外部拿不到 ──
  return {
    register,
    definitions,
    execute,
    registerCommand,
    executeCommand,
    onAgentEnd,
    emitAgentEnd,
  };
}

/**
 * 包装一个函数，使它只在第一次调用时生效，之后的调用什么也不做。
 *
 * 用于撤销注册函数：第一次调用删除条目；之后即使同名条目被重新注册，
 * 再调用旧的撤销函数也不会误删新条目。
 *
 * @param fn 只需执行一次的操作
 * @returns 包装后的函数
 */
function once(fn: () => void): () => void {
  // called 保存在闭包中，每次调用 once 都会得到一份独立的状态。
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    fn();
  };
}

/**
 * 装载一个同步静态扩展，将其注册的工具、命令和事件订阅归为同一批资源。
 *
 * "扩展"就是一个接收 ExtensionAPI 的普通函数（如 registerEcho），
 * 它在内部通过 api.registerTool / api.registerCommand / api.onAgentEnd 注册工具、命令和订阅事件。
 * mountExtension 负责在中间"记账"：扩展每注册一项，就把对应的撤销函数记下来，
 * 这样之后可以一次性卸载这个扩展注册的全部内容，而不影响其他扩展。
 *
 * 典型用法：
 * ```ts
 * const dispose = mountExtension(registry, (api) => {
 *   api.registerTool({ definition, execute });
 *   api.registerCommand({ name: "greet", execute: () => "hello" });
 *   api.onAgentEnd((event) => console.log(event.reason));
 * });
 * // ……运行期间扩展注册的工具、命令和订阅均生效……
 * dispose(); // 卸载：该扩展注册的全部工具、命令和订阅从注册表移除
 * ```
 *
 * 要点：
 * - 全有或全无：setup 执行中途抛错时，已注册的内容会全部撤销，不会残留"注册了一半"的扩展。
 * - 卸载后失效：扩展若偷偷保存了 api 对象、卸载后再调用注册或订阅方法，会直接抛错。
 * - 返回的 dispose 可重复调用，只有第一次生效。
 *
 * @param registry 工具、命令和订阅要注册到的目标注册表
 * @param setup 扩展的注册函数，接收一个 ExtensionAPI 对象，通过它登记工具、命令和订阅；必须是同步函数
 *              （“同步”只针对注册过程本身；注册进来的工具和命令的执行函数都可以是 async）
 * @returns 卸载函数：调用后按注册的逆序撤销该扩展注册的所有内容
 * @throws {Error} setup 抛出的错误会在撤销已注册项后原样向上传递（包括工具/命令重名错误）
 */
export function mountExtension(
  registry: ToolRegistry,
  setup: (api: ExtensionAPI) => void,
): () => void {
  // 本扩展每注册一项（工具、命令或订阅），就把注册表返回的撤销函数存到这里。
  const disposers: Array<() => void> = [];
  // 扩展是否仍处于装载状态；dispose 后置为 false，之后的注册请求一律拒绝。
  let active = true;

  /**
   * 卸载本扩展注册的全部工具、命令和订阅。重复调用时直接返回，不会重复撤销。
   */
  const dispose = (): void => {
    if (!active) return;
    active = false;
    // 按注册的逆序释放。本节点收集宿主返回的工具、命令删除函数和取消订阅函数。
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
    // 工具、命令和订阅的撤销函数归属于同一个扩展实例。
    // 交给扩展的每个方法都包了一层：先检查是否已卸载，再把撤销函数收进 disposers；
    // 方法本身返回 void，扩展拿不到撤销函数，无法自行删除。
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
      onAgentEnd(listener) {
        if (!active) {
          throw new Error("扩展已卸载，不能继续订阅事件");
        }
        disposers.push(registry.onAgentEnd(listener));
      },
    });
  } catch (error) {
    // 初始化失败：撤销本次已经注册成功的工具、命令和订阅，再把原错误抛给调用方。
    dispose();
    throw error;
  }

  // ponytail: 仅管理同步注册的工具、命令和运行结束订阅；定时器等其他资源接入时再扩展清理协议。
  // 注意：卸载只会移除注册项，不会取消已在执行中的异步工具或命令；取消由宿主通过 context.signal 负责。
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
 *   api.onAgentEnd((event) => console.log(event.reason));
 * }
 * ```
 *
 * @param registry 工具、命令和订阅要注册到的目标注册表
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
