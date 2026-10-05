import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { loadSettings } from "./base/settings.ts";
import { complete, stream } from "./ai/index.ts";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  KnownApi,
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
function loadRuntime(settingPath: string): { model: Model<KnownApi>; options: StreamOptions } {
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
  const model: Model<KnownApi> = {
    id: selectedModel.id,
    name: selectedModel.name,
    input: selectedModel.input,
    contextWindow: selectedModel.contextWindow,
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
 * @throws 模型返回 error 或 aborted、请求或工具执行失败，或第四轮仍包含工具调用时拒绝 Promise。
 * @remarks
 * 每轮先追加助手消息，再按内容顺序执行并追加全部工具结果；工具执行失败时保留此前已追加的历史。
 * 是否继续执行工具以消息中的 toolCall 内容块为准，不仅依据 stopReason。
 * 本函数等待每次请求的最终消息，不消费增量事件，也不输出终端内容。
 */
async function runToolCalls(
  model: Model<KnownApi>,
  context: Context,
  options: StreamOptions,
): Promise<AssistantMessage> {
  for (let turn = 0; turn < 4; turn++) {
    const assistantMessage = await runComplete(model, context, options);
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
 * 消费模型流并实时输出文本增量，返回最终助手消息。
 * @param model - 使用明确接口协议的模型配置。
 * @param context - 本次请求的对话上下文。
 * @param options - 请求认证及生成选项。
 * @returns Promise 完成后返回流的最终助手消息。
 * @throws 请求失败或中止时拒绝 Promise，已输出的文本不会撤回。
 * @remarks 仅将 text_delta 输出到标准输出，流结束后追加换行。
 */
async function runStream(
  model: Model<KnownApi>,
  context: Context,
  options: StreamOptions,
): Promise<AssistantMessage> {
  const events = stream(model, context, options);
  for await (const event of events) {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
    }
  }
  process.stdout.write("\n");
  const message = await events.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? "模型请求失败或中止。");
  }
  return message;
}

/**
 * 调用 complete 等待完整回复，并将模型失败或中止转换为异常。
 * @param model - 使用明确接口协议的模型配置。
 * @param context - 本次请求的对话上下文。
 * @param options - 请求认证及生成选项。
 * @returns Promise 完成后返回最终助手消息，允许 length 截断结果。
 * @throws 请求失败或中止时拒绝 Promise。
 */
async function runComplete(
  model: Model<KnownApi>,
  context: Context,
  options: StreamOptions,
): Promise<AssistantMessage> {
  const message = await complete(model, context, options);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? "模型请求失败或中止。");
  }
  return message;
}

/**
 * 将图片与识别提示一同提交给支持图片输入的模型。
 * @param model - input 明确包含 image 的模型配置。
 * @param image - 含纯 Base64 数据及准确 MIME 类型的图片内容。
 * @param options - 请求认证及生成选项。
 * @returns Promise 完成后返回图片识别的完整助手消息。
 * @throws 模型未声明图片支持、图片数据为空，或模型请求失败或中止时拒绝 Promise。
 */
async function runImageRecognition(
  model: Model<KnownApi>,
  image: ImageContent,
  options: StreamOptions,
): Promise<AssistantMessage> {
  if (!model.input.includes("image")) {
    throw new Error("所选模型未声明支持图片输入。");
  }
  if (image.type !== "image" || !image.data.trim() || !image.mimeType.trim()) {
    throw new Error("图片内容必须包含非空 Base64 数据及 MIME 类型。");
  }
  const context: Context = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "请描述这张图片中的内容，并识别可见文字。" }, image],
        timestamp: Date.now(),
      },
    ],
  };
  return runComplete(model, context, options);
}

/**
 * 依次演示同一模型的流式回复、完整回复、图片识别和加法工具调用。
 * @param model - 含准确能力声明及接口协议的完整模型配置。
 * @param image - 待识别图片的纯 Base64 数据及准确 MIME 类型。
 * @param options - 四项调用共用的认证及生成选项。
 * @returns Promise 完成后返回四项调用各自的最终助手消息。
 * @throws 任一请求、图片检查或工具执行失败，或工具对话超过四轮时拒绝 Promise。
 * @remarks 各功能使用独立上下文；按顺序执行，失败后停止后续调用；流式文本实时输出到标准输出。
 */
export async function runModelExamples(
  model: Model<KnownApi>,
  image: ImageContent,
  options: StreamOptions,
): Promise<{
  stream: AssistantMessage;
  complete: AssistantMessage;
  image: AssistantMessage;
  tools: AssistantMessage;
}> {
  const streamContext: Context = {
    messages: [{ role: "user", content: "请用一句话介绍你自己。", timestamp: Date.now() }],
  };
  const streamMessage = await runStream(model, streamContext, options);
  const completeContext: Context = {
    messages: [{ role: "user", content: "请用一句话解释什么是人工智能。", timestamp: Date.now() }],
  };
  const completeMessage = await runComplete(model, completeContext, options);
  const imageMessage = await runImageRecognition(model, image, options);
  const toolContext: Context = {
    tools: [tool],
    messages: [{ role: "user", content: "请调用 add 计算 17 加 25。", timestamp: Date.now() }],
  };
  const toolMessage = await runToolCalls(model, toolContext, options);
  return {
    stream: streamMessage,
    complete: completeMessage,
    image: imageMessage,
    tools: toolMessage,
  };
}

/**
 * 直接运行入口时加载模型和指定 PNG 图片，统一执行四项功能并输出结果。
 * @returns Promise 完成表示四项功能均已完成，或因非直接运行、配置加载或模型组装失败而提前返回。
 * @throws 图片读取或格式校验失败、模型请求或工具执行失败、第四轮仍包含工具调用时拒绝 Promise。
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

  const imageBuffer = await readFile("demo.png");
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!imageBuffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error("指定图片的内容不是 PNG 格式。");
  }
  const image: ImageContent = {
    type: "image",
    data: imageBuffer.toString("base64"),
    mimeType: "image/png",
  };
  const results = await runModelExamples(runtime.model, image, runtime.options);
  console.log("Completion回复：", results.complete.content);
  console.log("Steam回复:", results.stream.content);
  console.log("图片识别：", results.image.content);
  console.log("工具调用：", results.tools.content);
}

// main 内部负责直接运行判断；导入本模块时提前返回，不读取配置或发送请求。
await main();
