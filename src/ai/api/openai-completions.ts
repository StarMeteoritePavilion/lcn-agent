import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionChunk,
} from "openai/resources/chat/completions.js";
import type {
  AssistantMessage,
  Context,
  Model,
  StreamOptions,
  TextContent,
  Tool,
  ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";

/** 接口结束原因映射后的消息状态及错误说明。 */
type FinishReasonResult = {
  /** 对外使用的消息结束状态。 */
  stopReason: AssistantMessage["stopReason"];
  /** 错误状态的说明；正常结束、达到令牌数上限或请求工具调用时不设置。 */
  errorMessage?: string;
};

/** 聊天补全请求选项，额外支持指定模型的工具选择方式。 */
interface OpenAICompletionsOptions extends StreamOptions {
  /** 原样写入 tool_choice；none 禁用工具，auto 由模型决定，required 要求工具调用，也可指定具体工具。 */
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
}

/**
 * 创建助手消息事件流，启动兼容 OpenAI 的流式聊天补全请求。
 * @param model - 模型标识、接口基础地址及用于标记输出消息的接口类型和服务提供方。
 * @param context - 可选的系统提示词、工具定义及按原顺序发送的用户、助手和工具结果历史消息。
 * @param options - 可选的请求配置；发起请求必须提供非空 apiKey，还可设置生成参数、fetch 和 toolChoice。
 * @returns 可异步迭代事件并通过 result() 等待最终助手消息的事件流。
 * @remarks
 * 本函数启动请求处理后立即返回事件流，不等待请求完成；消费者无需先等待整个响应。
 * 缺少密钥、请求失败或响应处理失败时，事件流发送 error 事件并结束，result() 完成后返回错误消息。
 * 正常结束、达到令牌数上限或请求工具调用时发送 done 事件；length 可能包含截断内容，不自动续写。
 * 工具调用只作为消息内容返回，本模块不执行工具，也不验证工具参数是否符合定义。
 * void 不处理后台 Promise 的拒绝；若错误处理自身失败，例如非 Error 异常无法 JSON 序列化，则无法保证发送终结事件。
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
 * @param context - 用于构建请求的系统提示词、历史消息与工具定义。
 * @param stream - 接收增量事件、结束事件及最终助手消息的事件流。
 * @param options - 请求密钥、生成参数、自定义 fetch 及工具选择方式；apiKey 缺失或为空时转为错误结果。
 * @returns Promise 完成表示请求处理结束，且正常或错误结果已写入事件流。
 * @throws 错误处理自身失败时拒绝 Promise，例如非 Error 异常包含循环引用而无法 JSON 序列化。
 * @remarks
 * createCompletionStream 负责发起请求，consumeCompletionStream 负责文本、工具调用事件及结束原因校验。
 * 成功获得响应流后发送 start，响应处理成功后发送 done；任一步骤失败时发送 error。
 * partial 引用同一个持续更新的输出对象；timestamp 为创建输出消息时的毫秒级时间戳。
 * try 块中的密钥校验、客户端初始化、请求及响应处理异常会转换为 error 事件，并保留已累积的内容。
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
    // 读取途中出错时不会走正常的内容结束流程，也要移除工具参数原文等内部字段，避免作为业务字段输出。
    for (const block of output.content) {
      delete (block as { partialArgs?: string }).partialArgs;
      delete (block as { streamIndex?: number }).streamIndex;
    }
    output.stopReason = "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
  }
}

/**
 * 校验密钥并发起流式聊天补全请求。
 * @param model - 请求使用的模型标识、接口基础地址及服务提供方。
 * @param context - 用于构建请求的系统提示词、历史消息及工具定义。
 * @param options - 请求密钥、生成参数、自定义 fetch 和工具选择方式；必须提供非空 apiKey。
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
 * 读取响应分片，累积文本和工具调用、发送内容事件并校验结束原因。
 * @param openaiStream - 请求返回的聊天补全响应流，仅处理每个分片的 choices[0]。
 * @param output - 持续更新的助手消息，文本、工具调用及结束状态会写入同一对象。
 * @param stream - 接收文本及工具调用的开始、增量和结束事件的事件流。
 * @returns Promise 完成后返回 stop、length 或 toolUse，供 runStream 发送 done 事件。
 * @throws 响应读取失败、结束状态为 error 或未收到有效结束原因时拒绝 Promise。
 * @remarks
 * 首个非空文本增量创建文本块并发送 text_start，后续增量复用同一文本块。
 * 文本与工具调用内容块按首次出现顺序保存；所有文本增量共用一个文本块，即使中途出现工具调用。
 * 工具调用增量优先按 index、其次按 id 关联内容块；缺少二者且无法关联时创建新块。
 * 参数片段累积后容错解析，不验证参数结构；无内容或解析失败时可得到空对象。
 * 仅读取 delta.content 和 delta.tool_calls；不处理旧版 delta.function_call、自定义工具内容或拒绝说明。
 * 读取完毕后先发送 text_end 或 toolcall_end，再校验结束原因；读取途中抛出异常时不发送内容结束事件。
 * 本函数不发送 done 或 error，异常由 runStream 统一处理并保留已累积的内容。
 */
async function consumeCompletionStream(
  openaiStream: AsyncIterable<ChatCompletionChunk>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<"stop" | "length" | "toolUse"> {
  /** 附带内部拼接状态的工具调用块，结束后恢复为对外的 ToolCall 内容。 */
  interface StreamingToolCallBlock extends ToolCall {
    /** 尚在累积的 JSON 参数原文，内容结束或出错时移除。 */
    partialArgs?: string;
    /** 接口给出的工具调用索引，用于跨分片关联；与事件的 contentIndex 不同。 */
    streamIndex?: number;
  }

  /** 读取响应期间使用的文本块或带内部状态的工具调用块。 */
  type StreamingBlock = TextContent | StreamingToolCallBlock;

  /** 工具调用分片中实际读取的字段；后续分片允许省略标识和函数信息。 */
  type StreamingToolCallDelta = {
    /** 接口中工具调用的序号，用于定位已有内容块。 */
    index?: number;
    /** 工具调用标识，缺少可匹配的 index 时用作关联依据。 */
    id?: string;
    /** 函数名及本次新增的 JSON 参数原文，均可跨分片补齐。 */
    function?: { name?: string; arguments?: string };
  };

  const blocks = output.content as StreamingBlock[];

  /**
   * 获取文本或工具调用块在消息内容中的索引。
   * @param block - 需要定位的内容块。
   * @returns 按对象引用匹配的首个索引，从 0 开始；不存在时返回 -1。
   */
  const getContentIndex = (block: StreamingBlock): number => blocks.indexOf(block);

  let textBlock: TextContent | null = null;
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

  const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
  const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
  /**
   * 将工具分片关联到已有工具调用块，或创建新块并发送 toolcall_start。
   * @param toolCall - 当前工具调用增量，允许只包含参数片段。
   * @returns 可继续更新的工具调用块，与 output.content 中的对象相同。
   * @remarks 优先按 index 查找，再按 id 查找；新出现的标识会补入映射，函数名仅在现有值为空时补齐。
   */
  const ensureToolCallBlock = (toolCall: StreamingToolCallDelta): StreamingToolCallBlock => {
    const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
    const name = toolCall.function?.name ?? "";
    let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;

    // 后续分片通常只保留 index；同时记录 id，才能把只带 id 的分片接回同一个调用。
    if (!block && toolCall.id) {
      block = toolCallBlocksById.get(toolCall.id);
    }

    if (!block) {
      block = {
        type: "toolCall",
        id: toolCall.id || "",
        name,
        arguments: {},
        partialArgs: "",
        streamIndex,
      };
      if (streamIndex !== undefined) {
        toolCallBlocksByIndex.set(streamIndex, block);
      }
      if (toolCall.id) {
        toolCallBlocksById.set(toolCall.id, block);
      }
      blocks.push(block);
      stream.push({
        type: "toolcall_start",
        contentIndex: getContentIndex(block),
        partial: output,
      });
    }

    if (streamIndex !== undefined && block.streamIndex === undefined) {
      block.streamIndex = streamIndex;
      toolCallBlocksByIndex.set(streamIndex, block);
    }
    if (toolCall.id) {
      toolCallBlocksById.set(toolCall.id, block);
    }
    if (!block.name && name) {
      block.name = name;
    }
    return block;
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
    // tool_calls 表示模型请求工具调用，function_call 为已弃用的函数调用结束原因，均映射为 toolUse。
    // content_filter 表示内容因过滤被省略；它与兼容接口返回的 network_error 及其他值均映射为错误。
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

    if (choice.delta?.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        const block = ensureToolCallBlock(toolCall);
        if (!block.id && toolCall.id) {
          block.id = toolCall.id;
          toolCallBlocksById.set(toolCall.id, block);
        }
        const name = toolCall.function?.name;
        if (!block.name && name) {
          block.name = name;
        }
        let delta = "";
        if (toolCall.function?.arguments) {
          delta = toolCall.function.arguments;
          block.partialArgs = (block.partialArgs ?? "") + delta;
          // 单个参数分片通常不是完整 JSON；解析累计原文，供消费者查看阶段性参数，而不把半截 JSON 当作请求错误。
          block.arguments = parseStreamingJson(block.partialArgs);
        }
        stream.push({
          type: "toolcall_delta",
          contentIndex: getContentIndex(block),
          delta,
          partial: output,
        });
      }
    }
  }

  for (const block of blocks) {
    const contentIndex = getContentIndex(block);
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      continue;
    }

    // 流读取完才结束各内容块；工具块保留解析结果，移除仅用于跨分片拼接和关联的字段。
    block.arguments = parseStreamingJson(block.partialArgs);
    delete block.partialArgs;
    delete block.streamIndex;
    stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
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
 * @param context - 将转换为 messages 的系统提示词、历史消息，以及可选工具定义。
 * @param options - 可选的生成参数与工具选择方式；apiKey 和 fetch 不写入请求体。
 * @returns 启用 stream 的请求参数，包含模型标识、转换后的消息及显式传入的生成和工具选项。
 * @throws maxTokens 不是非负有限整数、temperature 不在有限数值范围 0 到 2 内，或历史工具参数无法序列化时抛出异常。
 * @remarks
 * maxTokens 为正整数时写入 max_completion_tokens，省略或为 0 时不设置。
 * temperature 仅在不为 undefined 时写入，因此 0 会保留。
 * 不设置默认令牌数上限或温度；具体模型的进一步限制由接口处理。
 * 仅在 tools 非空时写入函数工具定义，toolChoice 只要提供就原样发送；本函数不校验工具定义与选择是否匹配。
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
    // 温度 0 是有效设置，不能像 maxTokens 一样用真值判断，否则会丢掉调用方明确传入的 0。
    params.temperature = temperature;
  }

  if (context.tools?.length) {
    params.tools = context.tools.map(
      /**
       * 将项目工具定义转换为接口的函数工具定义。
       * @param tool - 工具名称、说明及 TypeBox 参数结构。
       * @returns 保留参数结构原引用的函数工具定义；此处不执行工具或校验结构。
       */
      (tool: Tool): OpenAI.Chat.Completions.ChatCompletionFunctionTool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
        },
      }),
    );
  }

  if (options?.toolChoice !== undefined) {
    params.tool_choice = options.toolChoice;
  }

  return params;
}

/**
 * 将系统提示词及用户、助手和工具结果历史消息转换为聊天补全消息数组。
 * @param context - 包含可选系统提示词及按对话顺序保存的历史消息的上下文。
 * @returns 保持历史顺序的请求消息；非空系统提示词置于首项，没有可发送内容时返回空数组。
 * @throws 助手工具调用参数包含循环引用等无法 JSON 序列化的内容时抛出异常。
 * @remarks
 * 字符串形式的用户内容直接保留，包括空字符串；文本块形式仅保留 text 长度大于 0 的块。
 * 助手消息仅保留去除首尾空白后非空的文本块，但拼接时使用原文且不添加分隔符。
 * 助手工具调用转为 tool_calls，参数序列化为 JSON 字符串；仅包含工具调用时保留 content: null。
 * 工具结果的文本块以换行符拼接，结果为空时发送固定文本；仅发送 toolCallId，不发送 toolName、isError。
 * 过滤后无内容的文本块用户消息及既无文本又无工具调用的助手消息会被跳过；时间戳、模型标识和结束状态不发送。
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

      const textBlocks = message.content
        .filter(
          /**
           * 筛选助手消息中的文本块。
           * @param block - 待检查的助手内容块。
           * @returns 内容块的 type 为 text 时返回 true。
           */
          (block: TextContent | ToolCall): block is TextContent => block.type === "text",
        )
        .filter(
          /**
           * 排除助手消息中为空或仅含空白字符的文本块。
           * @param block - 待检查的助手文本块。
           * @returns 去除首尾空白后仍有字符时返回 true；不修改原文。
           */
          (block: TextContent): block is TextContent => block.text.trim().length > 0,
        );
      const assistantText = textBlocks
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
      const toolCalls = message.content.filter(
        /**
         * 筛选助手历史消息中的工具调用块。
         * @param block - 待检查的助手内容块。
         * @returns 内容块的 type 为 toolCall 时返回 true，并收窄为工具调用类型。
         */
        (block: TextContent | ToolCall): block is ToolCall => block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(
          /**
           * 将历史工具调用转换为接口的函数调用消息。
           * @param tc - 包含调用标识、函数名及已解析参数的工具调用。
           * @returns 参数已序列化为 JSON 字符串的函数调用消息。
           * @throws 参数无法 JSON 序列化时抛出异常。
           */
          (tc: ToolCall): OpenAI.Chat.Completions.ChatCompletionMessageToolCall => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }),
        );
      }

      if (!assistantMsg.content && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
      continue;
    }

    if (message.role === "toolResult") {
      const textResult = message.content
        .map(
          /**
           * 提取工具结果文本块的原文。
           * @param block - 工具返回的文本块，允许包含空字符串。
           * @returns 未修改的文本，后续以换行符拼接。
           */
          (block: TextContent): string => block.text,
        )
        .join("\n");
      // tool_call_id 将结果关联到助手的工具调用；toolName 和 isError 不是本次转换的请求字段。
      params.push({
        role: "tool",
        content: textResult || "(no tool output)",
        tool_call_id: message.toolCallId,
      });
    }
  }

  return params;
}

/**
 * 将接口结束原因映射为助手消息结束状态及错误说明。
 * @param reason - SDK 定义的结束原因或服务提供方返回的其他字符串；null 按正常结束映射。
 * @returns stop、length、toolUse 或 error 状态；error 状态附带包含原始结束原因的错误说明。
 * @remarks
 * stop、end 和 null 映射为 stop；length 映射为 length，表示文本可能因令牌数上限而截断。
 * tool_calls 和 function_call 映射为 toolUse；content_filter、network_error 及其他字符串均映射为 error。
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
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
  }
}
