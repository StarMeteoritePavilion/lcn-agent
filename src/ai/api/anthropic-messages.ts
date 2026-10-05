import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaStopReason,
  BetaTool,
  BetaRefusalStopDetails as RefusalStopDetails,
  BetaContentBlockParam as ContentBlockParam,
  BetaMessageParam as MessageParam,
  BetaRawMessageStreamEvent as RawMessageStreamEvent,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type {
  AssistantMessage,
  Context,
  Model,
  StopReason,
  StreamOptions,
  TextContent,
  Tool,
  ToolCall,
} from "../types.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);

/** Anthropic 请求配置，工具选择使用字符串策略或指定工具对象。 */
interface AnthropicOptions extends StreamOptions {
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

interface ServerSentEvent {
  event: string | null;
  data: string;
  raw: string[];
}

interface SseDecoderState {
  event: string | null;
  data: string[];
  raw: string[];
}

/**
 * 创建助手消息事件流并启动 Anthropic 流式请求。
 * @param model - 请求模型、接口地址及默认令牌上限。
 * @param context - 系统提示词、对话历史与可选工具声明。
 * @param options - 请求密钥、生成参数、自定义 fetch 与工具选择方式。
 * @returns 可异步迭代内容事件，并通过 result() 等待最终消息的事件流。
 * @remarks
 * 启动请求后立即返回，不等待响应完成；请求和响应处理失败时通过 error 事件返回错误消息。
 * 工具调用只作为消息内容返回，不在本模块执行；length 状态不触发自动续写。
 * partial 指向持续更新的消息对象；void 不捕获后台 Promise 的拒绝，错误处理自身失败时无法保证发送终结事件。
 */
export function stream(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  // 使用 void 显式忽略返回的 Promise，让调用方立即获得事件流并消费后续事件。
  // void 不会捕获异常；请求和响应处理中的异常由 runStream 内部转换为 error 事件。
  void runStream(model, context, stream, options);
  return stream;
}

/**
 * 组织请求和响应处理，统一发送开始、完成或错误事件。
 * @param model - 请求模型、接口地址及输出消息的来源标识。
 * @param context - 系统提示词、历史消息与工具声明。
 * @param stream - 接收内容事件及最终消息的事件流。
 * @param options - 请求密钥、生成参数、自定义 fetch 及工具选择方式。
 * @returns Promise 完成表示正常或错误结果已写入事件流。
 * @throws 错误处理自身失败时拒绝 Promise，例如非 Error 异常无法 JSON 序列化。
 * @remarks
 * createCompletionStream 负责发起请求，consumeCompletionStream 负责文本、工具调用事件及结束原因校验。
 * 成功获得响应流后发送 start，处理成功后发送 done；请求或处理失败时清理内部字段并发送 error。
 * partial 引用同一个持续更新的消息对象，错误结果保留已累积的内容。
 */
async function runStream(
  model: Model<"anthropic-messages">,
  context: Context,
  stream: AssistantMessageEventStream,
  options?: AnthropicOptions,
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
    const anthropicStream = await createCompletionStream(model, context, options);

    stream.push({ type: "start", partial: output });
    const stopReason = await consumeCompletionStream(anthropicStream, output, stream);

    stream.push({ type: "done", reason: stopReason, message: output });
    stream.end();
  } catch (error) {
    for (const block of output.content) {
      delete (block as { index?: number }).index;
      delete (block as { partialJson?: string }).partialJson;
    }
    output.stopReason = "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
  }
}

/**
 * 校验密钥并发起 Anthropic 流式消息请求。
 * @param model - 请求使用的模型、接口地址及默认令牌上限。
 * @param context - 用于构建请求的系统提示词、历史消息与工具声明。
 * @param options - 请求密钥及可选请求配置；必须提供非空 apiKey。
 * @returns Promise 完成后返回可异步迭代的 Anthropic 协议事件流。
 * @throws 模型标识、接口地址、密钥或请求参数无效，客户端初始化失败或请求失败时拒绝 Promise。
 * @remarks 保留原始 SSE 响应并使用现有解析器读取事件，请求禁用自动重试。
 */
async function createCompletionStream(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): Promise<AsyncIterable<RawMessageStreamEvent>> {
  const apiKey = options?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  if (model.api !== "anthropic-messages") {
    throw new Error("model.api 必须是 anthropic-messages。");
  }
  if (typeof model.provider !== "string" || !model.provider.trim()) {
    throw new Error("model.provider 必须是非空字符串。");
  }
  if (typeof model.id !== "string" || !model.id.trim()) {
    throw new Error("model.id 必须是非空字符串。");
  }
  if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
    throw new Error("model.baseUrl 必须是非空字符串。");
  }
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch: options?.fetch,
  });

  const params = buildParams(model, context, options);
  const response = await client.beta.messages.create(params, { maxRetries: 0 }).asResponse();
  return iterateAnthropicEvents(response);
}

/**
 * 读取协议事件，累积文本和工具调用并校验消息结束状态。
 * @param anthropicStream - 请求返回的 Anthropic 协议事件流。
 * @param output - 持续更新的助手消息，内容与结束状态会写入同一对象。
 * @param stream - 接收文本和工具调用的开始、增量与结束事件的事件流。
 * @returns Promise 完成后返回 stop、length 或 toolUse，供 runStream 发送 done 事件。
 * @throws 响应读取失败、未收到结束原因、停止原因不受支持或结束状态为 error 时拒绝 Promise。
 * @remarks
 * 按事件 index 关联内容块，在 content_block_stop 时发送对应内容结束事件并移除内部字段。
 * 工具参数增量累积后通过 parseStreamingJson 解析，本函数不执行工具。
 * 本函数不发送 done 或 error；异常交由 runStream 统一处理并清理未结束内容块的内部字段。
 */
async function consumeCompletionStream(
  anthropicStream: AsyncIterable<RawMessageStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<"stop" | "length" | "toolUse"> {
  type Block = (TextContent | (ToolCall & { partialJson?: string })) & { index?: number };

  const blocks = output.content as Block[];

  for await (const event of anthropicStream) {
    if (event.type === "content_block_start") {
      if (event.content_block.type === "text") {
        const block: Block = {
          type: "text",
          text: event.content_block.text ?? "",
          index: event.index,
        };
        output.content.push(block);
        stream.push({
          type: "text_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      } else if (event.content_block.type === "tool_use") {
        const block: Block = {
          type: "toolCall",
          id: event.content_block.id,
          name: event.content_block.name,
          arguments: (event.content_block.input as Record<string, unknown>) ?? {},
          partialJson: "",
          index: event.index,
        };
        output.content.push(block);
        stream.push({
          type: "toolcall_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      }
    } else if (event.type === "content_block_delta") {
      const index = blocks.findIndex(
        /**
         * 查找与协议事件索引对应的内容块。
         * @param b - 待检查的文本或工具调用块。
         * @returns 内容块保存的协议索引与事件索引相同时返回 true。
         */
        (b: Block): boolean => b.index === event.index,
      );
      const block = blocks[index];
      if (event.delta.type === "text_delta" && block?.type === "text") {
        block.text += event.delta.text;
        stream.push({
          type: "text_delta",
          contentIndex: index,
          delta: event.delta.text,
          partial: output,
        });
      } else if (event.delta.type === "input_json_delta" && block?.type === "toolCall") {
        block.partialJson = (block.partialJson ?? "") + event.delta.partial_json;
        block.arguments = parseStreamingJson(block.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: event.delta.partial_json,
          partial: output,
        });
      }
    } else if (event.type === "content_block_stop") {
      const index = blocks.findIndex(
        /**
         * 查找与协议事件索引对应的内容块。
         * @param b - 待检查的文本或工具调用块。
         * @returns 内容块保存的协议索引与事件索引相同时返回 true。
         */
        (b: Block): boolean => b.index === event.index,
      );
      const block = blocks[index];
      if (block) {
        delete block.index;
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: index,
            content: block.text,
            partial: output,
          });
        } else {
          block.arguments = parseStreamingJson(block.partialJson);
          delete block.partialJson;
          stream.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall: block,
            partial: output,
          });
        }
      }
    } else if (event.type === "message_delta" && event.delta.stop_reason) {
      output.rawStopReason = event.delta.stop_reason;
      const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
      output.stopReason = stopReasonResult.stopReason;
      if (stopReasonResult.errorMessage) {
        output.errorMessage = stopReasonResult.errorMessage;
      }
    }
  }

  if (output.stopReason === "pending") {
    throw new Error("Anthropic stream ended without a stop reason");
  }
  if (output.stopReason === "error") {
    throw new Error(output.errorMessage || "An unknown error occurred");
  }

  return output.stopReason;
}

/**
 * 将模型、对话上下文和选项组装为 Anthropic 流式请求参数。
 * @param model - 请求模型及默认令牌上限。
 * @param context - 系统提示词、历史消息和可选工具声明。
 * @param options - 可选生成参数及工具选择方式；密钥和 fetch 不写入请求体。
 * @returns 启用 stream 的请求参数，包含消息、令牌上限及显式提供的选项。
 * @throws maxTokens 不是非负有限整数、temperature 不在 StreamOptions 约定的有限数值范围 0 到 2 内，或 toolChoice 无效时抛出异常。
 * @remarks
 * max_tokens 优先使用 options.maxTokens，未提供时使用 model.maxTokens；令牌上限和 temperature 为 0 时均保留。
 * 工具输入结构保留 properties 和 required，缺失时分别使用空对象和空数组，并启用 eager_input_streaming。
 * 字符串工具选择转换为 type 对象，指定工具的对象原样发送；模型对生成参数和工具选择的进一步限制由接口处理。
 */
function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): MessageCreateParamsStreaming {
  const maxTokens = options?.maxTokens !== undefined ? options.maxTokens : model.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 0) {
    throw new Error("maxTokens 必须是非负有限整数。");
  }
  const temperature = options?.temperature;
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  ) {
    throw new Error("temperature 必须是 0 到 2 之间的有限数值。");
  }
  const toolChoice = options?.toolChoice;
  if (toolChoice !== undefined) {
    if (typeof toolChoice === "string") {
      if (toolChoice !== "auto" && toolChoice !== "any" && toolChoice !== "none") {
        throw new Error("toolChoice 必须是 auto、any、none 或指定工具的对象。");
      }
    } else if (
      !toolChoice ||
      typeof toolChoice !== "object" ||
      Array.isArray(toolChoice) ||
      toolChoice.type !== "tool" ||
      typeof toolChoice.name !== "string" ||
      !toolChoice.name.trim()
    ) {
      throw new Error("toolChoice 必须是 auto、any、none 或包含非空 name 的 tool 对象。");
    }
  }
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: convertMessages(context),
    max_tokens: maxTokens,
    stream: true,
  };

  if (context.systemPrompt) {
    params.system = [{ type: "text", text: context.systemPrompt }];
  }

  if (temperature !== undefined) {
    params.temperature = temperature;
  }

  if (context.tools?.length) {
    params.tools = context.tools.map(
      /**
       * 将项目工具声明转换为 Anthropic 工具定义。
       * @param tool - 工具名称、说明及参数结构。
       * @returns 包含对象参数结构并启用参数增量传输的工具定义。
       */
      (tool: Tool): BetaTool => {
        const schema = tool.parameters as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        return {
          name: tool.name,
          description: tool.description,
          eager_input_streaming: true,
          input_schema: {
            type: "object",
            properties: schema.properties ?? {},
            required: schema.required ?? [],
          },
        };
      },
    );
  }

  if (toolChoice !== undefined) {
    params.tool_choice = typeof toolChoice === "string" ? { type: toolChoice } : toolChoice;
  }

  return params;
}

/**
 * 将原始 SSE 响应解析为受支持的 Anthropic 协议事件。
 * @param response - 客户端返回的原始 HTTP 响应。
 * @returns 可异步迭代的协议事件；不属于 ANTHROPIC_MESSAGE_EVENTS 的命名事件会被跳过。
 * @throws 响应没有正文、流读取失败、收到 error 事件、JSON 解析失败，或消息开始后缺少 message_stop 时抛出异常。
 * @remarks JSON 解析使用现有转义修复规则；解析异常包含事件名称及原始数据，调用方应按需处理错误信息。
 */
async function* iterateAnthropicEvents(response: Response): AsyncGenerator<RawMessageStreamEvent> {
  if (!response.body) {
    throw new Error("Attempted to iterate over an Anthropic response with no body");
  }

  let sawMessageStart = false;
  let sawMessageEnd = false;

  for await (const sse of iterateSseMessages(response.body)) {
    if (sse.event === "error") {
      throw new Error(sse.data);
    }

    if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
      continue;
    }

    try {
      const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
      if (event.type === "message_start") {
        sawMessageStart = true;
      } else if (event.type === "message_stop") {
        sawMessageEnd = true;
      }
      yield event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
      );
    }
  }

  if (sawMessageStart && !sawMessageEnd) {
    throw new Error("Anthropic stream ended before message_stop");
  }
}

/**
 * 按 SSE 行协议解码响应正文并逐个交付事件。
 * @param body - 包含 UTF-8 编码 SSE 文本的响应正文流。
 * @returns 可异步迭代的 SSE 事件，包括正文末尾没有空行终止的剩余事件。
 * @throws 无法获取读取器或读取正文失败时抛出异常。
 * @remarks 支持 LF、CR 和 CRLF 换行；结束或异常退出时释放读取器锁。
 */
async function* iterateSseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: SseDecoderState = { event: null, data: [], raw: [] };
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let consumed = consumeLine(buffer);
      while (consumed) {
        buffer = consumed.rest;
        const event = decodeSseLine(consumed.line, state);
        if (event) {
          yield event;
        }
        consumed = consumeLine(buffer);
      }
    }

    buffer += decoder.decode();
    let consumed = consumeLine(buffer, true);
    while (consumed) {
      buffer = consumed.rest;
      const event = decodeSseLine(consumed.line, state);
      if (event) {
        yield event;
      }
      consumed = consumeLine(buffer, true);
    }

    if (buffer.length > 0) {
      const event = decodeSseLine(buffer, state);
      if (event) {
        yield event;
      }
    }

    const trailingEvent = flushSseEvent(state);
    if (trailingEvent) {
      yield trailingEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 从缓冲文本中取出首个完整行及未消费的剩余文本。
 * @param text - 当前缓冲的 SSE 文本。
 * @param endOfStream - 正文是否已读取完毕；默认 false，允许末尾 CR 等待后续分片。
 * @returns 去除首个换行符的行及剩余文本；尚未出现完整换行符时返回 null。
 * @remarks CRLF 作为一个换行符消费，单独的 CR 或 LF 也可终止一行；流未结束时保留末尾 CR，避免跨分片的 CRLF 被拆成两个换行符。
 */
function consumeLine(
  text: string,
  endOfStream: boolean = false,
): { line: string; rest: string } | null {
  const lineBreakIndex = nextLineBreakIndex(text);
  if (lineBreakIndex === -1) {
    return null;
  }

  let nextIndex = lineBreakIndex + 1;
  if (text[lineBreakIndex] === "\r" && nextIndex === text.length && !endOfStream) {
    return null;
  }
  if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
    nextIndex += 1;
  }

  return {
    line: text.slice(0, lineBreakIndex),
    rest: text.slice(nextIndex),
  };
}

/**
 * 定位文本中最早出现的 CR 或 LF 字符。
 * @param text - 需要查找换行符的文本。
 * @returns 换行字符从 0 开始的索引；没有换行符时返回 -1。
 */
function nextLineBreakIndex(text: string): number {
  const carriageReturnIndex = text.indexOf("\r");
  const newlineIndex = text.indexOf("\n");
  if (carriageReturnIndex === -1) {
    return newlineIndex;
  }
  if (newlineIndex === -1) {
    return carriageReturnIndex;
  }
  return Math.min(carriageReturnIndex, newlineIndex);
}

/**
 * 将单行 SSE 文本写入解码状态，遇到空行时输出累计事件。
 * @param line - 已去除行尾换行符的原始行。
 * @param state - 当前事件的累计状态，调用中会更新。
 * @returns 空行终止的累计事件；事件尚未结束或状态为空时返回 null。
 * @remarks 仅解析 event 和 data 字段；注释行和其他字段保留在 raw 中，不作为事件数据。
 */
function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
  if (line === "") {
    return flushSseEvent(state);
  }

  state.raw.push(line);
  if (line.startsWith(":")) {
    return null;
  }

  const delimiterIndex = line.indexOf(":");
  const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
  let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }

  if (fieldName === "event") {
    state.event = value;
  } else if (fieldName === "data") {
    state.data.push(value);
  }

  return null;
}

/**
 * 输出累计 SSE 事件并清空解码状态。
 * @param state - 当前事件的累计状态。
 * @returns 当前事件的名称、以换行连接的数据及原始行副本；没有名称和数据时返回 null。
 * @remarks 返回事件时重置 event、data 和 raw；返回 null 时保持原状态。
 */
function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
  if (!state.event && state.data.length === 0) {
    return null;
  }

  const event: ServerSentEvent = {
    event: state.event,
    data: state.data.join("\n"),
    raw: [...state.raw],
  };
  state.event = null;
  state.data = [];
  state.raw = [];
  return event;
}

/**
 * 将用户、助手和工具结果历史转换为 Anthropic 消息参数。
 * @param context - 包含按对话顺序排列的历史消息的上下文。
 * @returns 保持历史顺序的消息；没有可发送内容时返回空数组，连续工具结果合并为一条 user 消息。
 * @remarks
 * 用户和助手文本为空或仅含空白时跳过，保留有效文本的原有首尾空白。
 * 助手工具调用转换为 tool_use，工具结果转换为带 tool_use_id 和 is_error 的 tool_result。
 * 工具结果文本以换行连接，允许空内容；系统提示词由 buildParams 单独设置。
 */
function convertMessages(context: Context): MessageParam[] {
  const params: MessageParam[] = [];
  for (let i = 0; i < context.messages.length; i++) {
    const msg = context.messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length === 0) {
          continue;
        }
        params.push({ role: "user", content: msg.content });
        continue;
      }
      const blocks = msg.content.filter(
        /**
         * 判断用户文本块是否包含非空白内容。
         * @param block - 待检查的用户文本块。
         * @returns 去除首尾空白后仍有字符时返回 true，不修改文本。
         */
        (block: TextContent): boolean => block.text.trim().length > 0,
      );
      if (blocks.length === 0) {
        continue;
      }
      params.push({ role: "user", content: blocks });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) {
            continue;
          }
          blocks.push({ type: "text", text: block.text });
          continue;
        }
        if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
      }
      if (blocks.length === 0) {
        continue;
      }
      params.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role !== "toolResult") {
      continue;
    }
    const toolResults: ContentBlockParam[] = [];
    let j = i;
    while (j < context.messages.length && context.messages[j].role === "toolResult") {
      const toolMsg = context.messages[j];
      if (toolMsg.role !== "toolResult") {
        break;
      }
      const texts = toolMsg.content.map(
        /**
         * 提取工具结果文本块的原文。
         * @param block - 工具返回的文本块。
         * @returns 未修改的文本，后续以换行连接。
         */
        (block: TextContent): string => block.text,
      );
      const content = texts.join("\n");
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolMsg.toolCallId,
        content,
        is_error: toolMsg.isError,
      });
      j++;
    }
    i = j - 1;
    params.push({ role: "user", content: toolResults });
  }
  return params;
}

/**
 * 将 Anthropic 停止原因映射为项目消息状态。
 * @param reason - SDK 定义的停止原因或服务提供方返回的其他字符串。
 * @param stopDetails - 可选拒绝详情，用于读取 refusal 的错误说明。
 * @returns stop、length、toolUse 或 error 状态；拒绝和敏感内容停止时附带错误说明。
 * @throws reason 不属于当前支持的停止原因时抛出异常。
 * @remarks end_turn、pause_turn 和 stop_sequence 均映射为 stop，不自动续写暂停的回合。
 */
function mapStopReason(
  reason: BetaStopReason | string,
  stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "end_turn":
      return { stopReason: "stop" };
    case "max_tokens":
      return { stopReason: "length" };
    case "tool_use":
      return { stopReason: "toolUse" };
    case "refusal":
      return {
        stopReason: "error",
        errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
      };
    case "pause_turn":
      return { stopReason: "stop" };
    case "stop_sequence":
      return { stopReason: "stop" };
    case "sensitive":
      return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
    default:
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}
