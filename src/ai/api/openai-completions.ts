import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionChunk,
} from "openai/resources/chat/completions.js";
import type { AssistantMessage, Context, Model, StreamOptions, TextContent } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/** 接口结束原因映射后的消息状态及错误说明。 */
type FinishReasonResult = {
  /** 对外使用的消息结束状态。 */
  stopReason: AssistantMessage["stopReason"];
  /** 错误状态的说明；正常结束或达到令牌数上限时不设置。 */
  errorMessage?: string;
};

/** OpenAI 聊天补全请求使用的认证、生成参数与网络请求选项。 */
type OpenAICompletionsOptions = StreamOptions;

/**
 * 创建助手消息事件流，启动兼容 OpenAI 的流式聊天补全请求。
 * @param model - 模型标识、接口基础地址及用于标记输出消息的接口类型和服务提供方。
 * @param context - 可选的系统提示词及按原顺序发送的用户、助手历史消息。
 * @param options - 可选的请求配置；发起请求必须提供非空 apiKey，还可设置 maxTokens、temperature 和 fetch。
 * @returns 可异步迭代事件并通过 result() 等待最终助手消息的事件流。
 * @remarks
 * 本函数不等待请求完成；请求处理在返回事件流后异步继续执行。
 * 缺少密钥、请求失败或响应处理失败时，事件流发送 error 事件并结束，result() 完成后返回错误消息。
 * 正常结束或达到令牌数上限时发送 done 事件；length 结果可能包含截断文本，不自动续写。
 */
export function stream(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  // 使用 void 显式忽略返回的 Promise，让调用方立即获得事件流并消费后续事件。
  // void 不会捕获异常；请求和响应处理中的异常由 runStream 内部转换为 error 事件。
  void runStream(model, context, stream, options);
  return stream;
}

/**
 * 组织请求和响应处理，统一发送开始、完成或错误事件。
 * @param model - 请求使用的模型及接口地址，同时提供输出消息的 api、provider 和 model 标识。
 * @param context - 用于构建请求的系统提示词与历史消息。
 * @param stream - 接收增量事件、结束事件及最终助手消息的事件流。
 * @param options - 请求密钥、生成参数及自定义 fetch；apiKey 缺失或为空时转为错误结果。
 * @returns Promise 完成表示请求处理结束，且正常或错误结果已写入事件流。
 * @remarks
 * createCompletionStream 负责发起请求，consumeCompletionStream 负责文本事件及结束原因校验。
 * 成功获得响应流后发送 start，响应处理成功后发送 done；任一步骤失败时发送 error。
 * partial 引用同一个持续更新的输出对象；timestamp 为创建输出消息时的毫秒级时间戳。
 * try 块中的密钥校验、客户端初始化、请求及响应处理异常会转换为 error 事件，并保留已累积的文本。
 */
async function runStream(
  model: Model<"openai-completions">,
  context: Context,
  stream: AssistantMessageEventStream,
  options?: OpenAICompletionsOptions,
): Promise<void> {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "pending",
    timestamp: Date.now(),
  };

  try {
    const openaiStream = await createCompletionStream(model, context, options);

    stream.push({ type: "start", partial: output });

    const stopReason = await consumeCompletionStream(openaiStream, output, stream);

    stream.push({ type: "done", reason: stopReason, message: output });
    stream.end();
  } catch (error) {
    output.stopReason = "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
  }
}

/**
 * 校验密钥并发起流式聊天补全请求。
 * @param model - 请求使用的模型标识、接口基础地址及服务提供方。
 * @param context - 用于构建请求的系统提示词与历史消息。
 * @param options - 请求密钥、生成参数及自定义 fetch；必须提供非空 apiKey。
 * @returns Promise 完成后返回可异步迭代聊天补全分片的响应流。
 * @throws 密钥缺失、生成参数无效、客户端初始化失败或请求失败时拒绝 Promise，由 runStream 转换为 error 事件。
 * @remarks 每次调用创建独立客户端，请求禁用自动重试。
 */
async function createCompletionStream(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
): Promise<AsyncIterable<ChatCompletionChunk>> {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    // 跳过 SDK 默认的浏览器环境保护检查；在浏览器中使用时，API 密钥可能暴露。
    dangerouslyAllowBrowser: true,
    fetch: options.fetch,
  });

  const params = buildParams(model, context, options);
  return client.chat.completions.create(params, { maxRetries: 0 });
}

/**
 * 读取响应分片，累积文本、发送文本事件并校验结束原因。
 * @param openaiStream - 请求返回的聊天补全响应流，仅处理每个分片的 choices[0]。
 * @param output - 持续更新的助手消息，文本及结束状态会写入同一对象。
 * @param stream - 接收 text_start、text_delta 和 text_end 事件的事件流。
 * @returns Promise 完成后返回 stop 或 length，供 runStream 发送 done 事件。
 * @throws 响应读取失败、结束状态为 error 或未收到有效结束原因时拒绝 Promise。
 * @remarks
 * 首个非空文本增量创建文本块并发送 text_start，后续增量复用同一文本块。
 * 读取完毕后先发送 text_end，再校验结束原因；读取途中抛出异常时不发送 text_end。
 * 本函数不发送 done 或 error，异常由 runStream 统一处理并保留已累积的文本。
 */
async function consumeCompletionStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<"stop" | "length"> {
  const blocks = output.content as TextContent[];
  let textBlock: TextContent | null = null;
  /**
   * 获取文本块在消息内容中的索引。
   * @param block - 需要定位的文本块。
   * @returns 按对象引用匹配的首个索引，从 0 开始；不存在时返回 -1。
   */
  const getContentIndex = (block: TextContent): number => blocks.indexOf(block);
  /**
   * 获取用于累积响应文本的文本块，首次调用时创建并发送 text_start 事件。
   * @returns 用于累积响应文本的文本块。
   * @remarks 新文本块会加入 output.content；后续调用复用同一对象，不重复发送 text_start。
   */
  const ensureTextBlock = (): TextContent => {
    if (!textBlock) {
      textBlock = { type: "text", text: "" };
      blocks.push(textBlock);
      stream.push({
        type: "text_start",
        contentIndex: getContentIndex(textBlock),
        partial: output,
      });
    }
    return textBlock;
  };

  let hasFinishReason = false;
  for await (const chunk of openaiStream) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;

    if (!choice) {
      continue;
    }

    // null 表示当前分片未提供结束原因，不进入映射；保留非空原值供调用方检查。
    // stop 为自然结束或命中停止序列，length 为达到令牌数上限；end 也映射为正常结束。
    // content_filter、network_error、tool_calls、已弃用的 function_call 及其他值映射为错误。
    // 此处只更新状态，继续读取流；若出现多个非空结束原因，后续分片会覆盖此前状态。
    if (choice.finish_reason) {
      output.rawStopReason = choice.finish_reason;
      const finishReasonResult = mapStopReason(choice.finish_reason);
      output.stopReason = finishReasonResult.stopReason;

      if (finishReasonResult.errorMessage) {
        output.errorMessage = finishReasonResult.errorMessage;
      }

      hasFinishReason = true;
    }

    if (choice.delta?.content) {
      const block = ensureTextBlock();
      block.text += choice.delta.content;
      stream.push({
        type: "text_delta",
        contentIndex: getContentIndex(block),
        delta: choice.delta.content,
        partial: output,
      });
    }
  }

  for (const block of blocks) {
    const contentIndex = getContentIndex(block);
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
    }
  }

  if (output.stopReason === "error") {
    throw new Error(output.errorMessage || "Provider returned an error stop reason");
  }

  if (!hasFinishReason || output.stopReason === "pending") {
    throw new Error("Stream ended without finish_reason");
  }

  return output.stopReason;
}

/**
 * 将模型、对话上下文和生成选项组装为流式聊天补全请求参数。
 * @param model - 提供请求中的模型标识；不读取 model.maxTokens。
 * @param context - 将转换为 messages 的系统提示词及历史消息。
 * @param options - 可选的生成参数；apiKey 和 fetch 不写入请求体。
 * @returns 启用 stream 的请求参数，包含模型标识、转换后的消息及显式传入的生成选项。
 * @throws maxTokens 不是非负有限整数，或 temperature 不是 0 到 2 之间的有限数值时抛出异常。
 * @remarks
 * maxTokens 为正整数时写入 max_completion_tokens，省略或为 0 时不设置。
 * temperature 仅在不为 undefined 时写入，因此 0 会保留。
 * 不设置默认令牌数上限或温度；具体模型的进一步限制由接口处理。
 */
function buildParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const maxTokens = options?.maxTokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 0)) {
    throw new Error("maxTokens 必须是非负有限整数。");
  }
  const temperature = options?.temperature;
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  ) {
    throw new Error("temperature 必须是 0 到 2 之间的有限数值。");
  }
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages: convertMessages(context),
    stream: true,
  };

  if (maxTokens) {
    params.max_completion_tokens = maxTokens;
  }

  if (temperature !== undefined) {
    params.temperature = temperature;
  }
  return params;
}

/**
 * 将系统提示词及用户、助手历史消息转换为 OpenAI 聊天补全消息数组。
 * @param context - 包含可选系统提示词和历史消息的对话上下文。
 * @returns 保持历史顺序的请求消息；非空系统提示词置于首项，没有可发送内容时返回空数组。
 * @remarks
 * 字符串形式的用户内容直接保留，包括空字符串；文本块形式仅保留 text 长度大于 0 的块。
 * 助手消息仅保留去除首尾空白后非空的文本块，但拼接时使用原文且不添加分隔符。
 * 过滤后无内容的文本块用户消息和助手消息会被跳过；时间戳、模型标识及结束状态等元数据不传入接口。
 */
function convertMessages(context: Context): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];
  if (context.systemPrompt) {
    params.push({ role: "system", content: context.systemPrompt });
  }

  for (const message of context.messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        params.push({ role: "user", content: message.content });
        continue;
      }
      const contents = message.content.filter(
        /**
         * 判断用户文本块是否包含至少一个字符。
         * @param item - 待检查的用户文本块。
         * @returns 文本长度大于 0 时返回 true；仅含空白字符的文本也会保留。
         */
        (item: TextContent): boolean => item.text.length > 0,
      );

      if (contents.length > 0) {
        params.push({ role: "user", content: contents });
      }
      continue;
    }

    if (message.role === "assistant") {
      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: null,
      };

      const assistantText = message.content
        .filter(
          /**
           * 筛选助手消息中的文本块。
           * @param block - 待检查的助手内容块。
           * @returns 内容块的 type 为 text 时返回 true。
           */
          (block: TextContent): block is TextContent => block.type === "text",
        )
        .filter(
          /**
           * 排除助手消息中为空或仅含空白字符的文本块。
           * @param block - 待检查的助手文本块。
           * @returns 去除首尾空白后仍有字符时返回 true；不修改原文。
           */
          (block: TextContent): block is TextContent => block.text.trim().length > 0,
        )
        .map(
          /**
           * 提取助手文本块的原文供后续拼接。
           * @param block - 通过过滤的助手文本块。
           * @returns 保留原有首尾空白的文本。
           */
          (block: TextContent): string => block.text,
        )
        .join("");

      if (assistantText.length > 0) {
        assistantMsg.content = assistantText;
      }
      if (!assistantMsg.content) {
        continue;
      }
      params.push(assistantMsg);
    }
  }

  return params;
}

/**
 * 将接口结束原因映射为助手消息结束状态及错误说明。
 * @param reason - SDK 定义的结束原因或服务提供方返回的其他字符串；null 按正常结束映射。
 * @returns stop、length 或 error 状态；error 状态附带包含原始结束原因的错误说明。
 * @remarks
 * stop、end 和 null 映射为 stop；length 映射为 length，表示文本可能因令牌数上限而截断。
 * content_filter、network_error 及其他字符串均映射为 error；当前不支持 tool_calls 和 function_call。
 * consumeCompletionStream 仅在 finish_reason 为真值时调用本函数，因此流中仅收到 null 不视为正常结束。
 */
function mapStopReason(
  reason: ChatCompletionChunk.Choice["finish_reason"] | string,
): FinishReasonResult {
  if (reason === null) {
    return { stopReason: "stop" };
  }
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
  }
}
