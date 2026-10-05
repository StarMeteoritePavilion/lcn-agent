import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { loadSettings } from "./base/settings.ts";
import { completion } from "./ai/index.ts";
import type {
  AssistantMessage,
  Context,
  Model,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "./ai/types.ts";
import { validateToolCall } from "./ai/utils/validation.ts";

/** 供模型选择的加法工具声明；这里只描述参数，具体计算由 executeToolCall 执行。 */
const tool: Tool = {
  name: "add",
  description: "计算两个数字之和",
  parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
};

/**
 * 加载配置并按精确名称和标识组装所选模型及请求选项。
 * @param settingPath - 配置文件路径，相对路径基于当前工作目录。
 * @returns 所选模型及包含 API 密钥的请求选项；模型上限已由配置加载器补齐。
 * @throws 配置加载或校验失败、所选供应商或模型不存在时抛出异常。
 * @remarks
 * 环境变量替换及业务校验由 loadSettings 完成；本函数不输出配置或错误提示。
 * 模型接口协议取自所选供应商的 api，同一供应商条目中的模型共享该协议和连接配置。
 * 模型默认生成上限取自所选模型条目的 maxTokens；请求选项不设置 maxTokens 或 temperature。
 */
function loadRuntime(settingPath: string): { model: Model; options: StreamOptions } {
  const config = loadSettings(settingPath);
  const selected = config.modelProviders.find(
    /**
     * 判断已校验的供应商名称是否与顶层选择精确匹配。
     * @param provider - 待匹配的供应商配置。
     * @returns 名称与 config.provider 完全一致时返回 true，否则返回 false。
     * @remarks 不转换大小写，也不修改名称或选择配置。
     */
    (provider: (typeof config.modelProviders)[number]): boolean =>
      provider.name === config.provider,
  );
  if (!selected) {
    throw new Error("未找到所选供应商配置。");
  }
  const selectedModel = selected.models.find(
    /**
     * 按精确标识定位已校验的模型配置。
     * @param entry - 所选供应商的模型条目。
     * @returns 模型标识与 config.model 完全一致时返回 true。
     */
    (entry: (typeof selected.models)[number]): boolean => entry.id === config.model,
  );
  if (!selectedModel) {
    throw new Error("未找到所选模型配置。");
  }
  const model: Model = {
    id: selectedModel.id,
    api: selected.api,
    provider: config.provider,
    baseUrl: selected.baseUrl,
    // stream() 方法中: Anthropic 在 options.maxTokens 为 undefined 时使用 model.maxTokens；OpenAI 请求不读取 model.maxTokens。
    maxTokens: selectedModel.maxTokens,
  };
  return { model, options: { apiKey: selected.apiKey } };
}

/**
 * 校验并执行加法工具调用，返回可追加到对话历史的工具结果。
 * @param call - 模型返回的工具名称、调用标识及未校验参数。
 * @returns 包含加法结果文本、原调用标识及毫秒时间戳的工具结果消息。
 * @throws 工具不存在、参数校验失败，或校验后 a 或 b 不是数字时抛出异常。
 * @remarks 复用 validateToolCall 转换并校验参数副本，不修改模型的原始参数，也不追加对话历史。
 */
function executeToolCall(call: ToolCall): ToolResultMessage {
  const args = validateToolCall([tool], call);
  if (typeof args.a !== "number" || typeof args.b !== "number") {
    throw new Error("校验后的参数类型错误");
  }
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: String(args.a + args.b) }],
    isError: false,
    timestamp: Date.now(),
  };
}

/**
 * 执行最多四轮模型请求及加法工具调用，返回首个不含工具调用的助手消息。
 * @param model - 请求使用的模型及接口连接配置。
 * @param context - 对话上下文，助手消息及工具结果会按顺序追加到其 messages 中。
 * @param options - 每轮请求共用的认证及生成选项。
 * @returns Promise 完成后返回首个不含工具调用的助手消息；length 结果也可正常返回。
 * @throws 模型返回 error、请求或工具执行失败，或第四轮仍包含工具调用时拒绝 Promise。
 * @remarks
 * 每轮先追加助手消息，再按内容顺序执行并追加全部工具结果；工具执行失败时保留此前已追加的历史。
 * 是否继续执行工具以消息中的 toolCall 内容块为准，不仅依据 stopReason。
 * 本函数等待每次请求的最终消息，不消费增量事件，也不输出终端内容。
 */
async function runConversation(
  model: Model,
  context: Context,
  options: StreamOptions,
): Promise<AssistantMessage> {
  for (let turn = 0; turn < 4; turn++) {
    const assistantMessageEventStream = await completion(model, context, options);
    const assistantMessage = await assistantMessageEventStream.result();

    if (assistantMessage.stopReason === "error") {
      throw new Error(assistantMessage.errorMessage);
    }
    // 先记录模型的调用消息，再追加带相同 toolCallId 的结果，下一轮接口才能关联调用和执行结果。
    context.messages.push(assistantMessage);
    const calls = assistantMessage.content.filter(
      /**
       * 从混合内容中筛选需要本地执行的工具调用。
       * @param block - 助手生成的文本块或工具调用块。
       * @returns type 为 toolCall 时返回 true，并将该块收窄为 ToolCall。
       */
      (block: AssistantMessage["content"][number]): block is ToolCall => block.type === "toolCall",
    );
    if (calls.length === 0) {
      return assistantMessage;
    }

    for (const call of calls) {
      const result = executeToolCall(call);
      context.messages.push(result);
    }
  }

  // 四轮请求均包含工具调用时，明确报告未获得最终答复。
  throw new Error("示例达到四轮上限；请检查调用记录");
}

/**
 * 直接运行入口时初始化模型及上下文，执行工具对话并输出最终助手内容。
 * @returns Promise 完成表示已输出最终助手内容，或因非直接运行、配置加载或模型组装失败而提前返回。
 * @throws 模型请求或工具执行失败、第四轮仍包含工具调用时拒绝 Promise。
 * @remarks
 * 从当前工作目录加载 setting.json，加载或组装失败时输出固定提示并设置 process.exitCode 为 1。
 * 对话异常向顶层 await 传递；导入本模块时不读取配置或发送请求。
 */
async function main(): Promise<void> {
  if (!process.argv[1] || import.meta.url !== pathToFileURL(resolve(process.argv[1])).href) {
    return;
  }

  let runtime: ReturnType<typeof loadRuntime>;
  try {
    runtime = loadRuntime("setting.json");
  } catch {
    console.error("模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。");
    process.exitCode = 1;
    return;
  }

  const context: Context = {
    tools: [tool],
    messages: [{ role: "user", content: "请调用 add 计算 17 加 25。", timestamp: Date.now() }],
  };
  const message = await runConversation(runtime.model, context, runtime.options);
  console.log(message.content);
}

// main 内部负责直接运行判断；导入本模块时提前返回，不读取配置或发送请求。
await main();
