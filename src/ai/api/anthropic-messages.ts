import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaStopReason,
  BetaTool,
  BetaContentBlockParam as ContentBlockParam,
  MessageCreateParamsStreaming,
  BetaMessageParam as MessageParam,
  BetaRawMessageStreamEvent as RawMessageStreamEvent,
  BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  ProviderHeaders,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";

import { transformMessages } from "./transform-messages.ts";
import { validateStreamOptions } from "../utils/validation.ts";
/**
 * 将工具结果内容转换为 Anthropic 文本或图文块。
 * @param content - 按原顺序排列的文本和图片内容块。
 * @returns 纯文本按换行拼接；包含图片时返回图文块数组。
 * @remarks 纯图片结果补充固定文本占位，不修改原始内容。
 */
function convertContentBlocks(
  content: (TextContent | ImageContent)[],
): string | Extract<ContentBlockParam, { type: "text" | "image" }>[] {
  const hasImages = content.some(
    /**
     * 检查内容块是否为图片。
     * @param c - 待检查或提取原文的内容块。
     * @returns type 为 image 时返回 true。
     */
    (c: TextContent | ImageContent): boolean => c.type === "image",
  );
  if (!hasImages) {
    return content
      .map(
        /**
         * 提取文本内容块的原文。
         * @param c - 待检查或提取原文的内容块。
         * @returns 未经修改的文本字符串。
         */
        (c: TextContent | ImageContent): string => (c as TextContent).text,
      )
      .join("\n");
  }
  const blocks = content.map(
    /**
     * 将工具结果文本或图片转换为 Anthropic 内容块。
     * @param block - 待检查或处理的内容块。
     * @returns 保留原文或图片数据的协议内容块。
     */
    (block: TextContent | ImageContent): Extract<ContentBlockParam, { type: "text" | "image" }> => {
      if (block.type === "text") {
        return {
          type: "text" as const,
          text: block.text,
        };
      }
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: block.data,
        },
      };
    },
  );
  const hasText = blocks.some(
    /**
     * 检查内容块是否为文本。
     * @param b - 当前需要检查的协议内容块。
     * @returns type 为 text 时返回 true。
     */
    (b: (typeof blocks)[number]): boolean => b.type === "text",
  );
  if (!hasText) {
    blocks.unshift({
      type: "text" as const,
      text: "(see attached image)",
    });
  }
  return blocks;
}
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
/**
 * 读取 Anthropic 兼容选项并补齐默认值。
 * @param model - 本次请求的模型配置。
 * @returns 工具输入增量与温度支持标志，未配置时均为 true。
 */
function getAnthropicCompat(model: Model<"anthropic-messages">): {
  supportsEagerToolInputStreaming: boolean;
  supportsTemperature: boolean;
} {
  return {
    supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
    supportsTemperature: model.compat?.supportsTemperature ?? true,
  };
}
export interface AnthropicOptions extends StreamOptions {
  toolChoice?:
    | "auto"
    | "any"
    | "none"
    | {
        type: "tool";
        name: string;
      };
}
/**
 * 按传入顺序合并请求头。
 * @param headerSources - 按覆盖顺序排列的请求头来源，undefined 来源跳过。
 * @returns 合并后的新对象，后续来源覆盖同名键。
 * @remarks 保留 null 值以沿用 SDK 删除默认请求头的规则。
 */
function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
  const merged: ProviderHeaders = {};
  for (const headers of headerSources) {
    if (headers) {
      Object.assign(merged, headers);
    }
  }
  return merged;
}

/**
 * 检查本次 Anthropic 请求是否提供非空密钥。
 * @param provider - 请求服务商标识，用于缺少密钥时的错误说明。
 * @param apiKey - 本次请求的显式密钥。
 * @throws 密钥不是非空字符串时抛出异常。
 */
function assertRequestAuth(provider: string, apiKey: string | undefined): void {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error(`No API key for provider: ${provider}`);
  }
}
class PiAnthropic extends Anthropic {
  /**
   * 禁用 Anthropic SDK 的默认凭据自动解析。
   * @returns 始终返回 false。
   * @remarks 认证仅使用创建客户端时显式传入的凭据。
   */
  protected override _shouldResolveDefaultCredentials(): boolean {
    return false;
  }
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
const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
]);
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
 * 从缓冲文本中取出首个完整行及未消费的剩余文本。
 * @param text - 当前缓冲的 SSE 文本。
 * @param endOfStream - 正文是否已读取完毕；默认 false，允许末尾 CR 等待后续分片。
 * @returns 去除首个换行符的行及剩余文本；尚未出现完整换行符时返回 null。
 * @remarks CRLF 作为一个换行符消费，单独的 CR 或 LF 也可终止一行；流未结束时保留末尾 CR，避免跨分片的 CRLF 被拆成两个换行符。
 */
function consumeLine(
  text: string,
  endOfStream: boolean = false,
): {
  line: string;
  rest: string;
} | null {
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
 * 创建助手消息事件流并启动协议请求。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @returns 立即返回可异步迭代内容事件并通过 result() 等待最终消息的事件流。
 * @remarks 请求校验、网络和协议处理失败通过 error 事件返回；不执行工具，不自动续写或重试，partial 与最终消息共享引用。
 */
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  void (
    /**
     * 处理协议请求并将完成结果或错误写入助手事件流。
     * @returns Promise 完成表示终结事件已写入且事件流已结束。
     * @remarks 启动后异步执行；错误转换为 error 事件并保留已累积内容。
     */
    async (): Promise<void> => {
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
        validateStreamOptions(options);
        const apiKey = options?.apiKey;
        assertRequestAuth(model.provider, apiKey);
        if (model.api !== "anthropic-messages") {
          throw new Error("model.api 必须是 anthropic-messages。");
        }
        for (const field of ["provider", "id", "baseUrl"] as const) {
          if (typeof model[field] !== "string" || !model[field].trim()) {
            throw new Error(`model.${field} 必须是非空字符串。`);
          }
        }
        const client = createClient(model, apiKey, options?.headers, options?.fetch);
        const params = buildParams(model, context, options);
        const request = client.beta.messages.create(params, { maxRetries: 0 });
        const response = await request.asResponse();
        stream.push({ type: "start", partial: output });
        type Block = (
          | TextContent
          | (ToolCall & {
              partialJson: string;
            })
        ) & {
          index: number;
        };
        const blocks = output.content as Block[];
        for await (const event of iterateAnthropicEvents(response)) {
          if (event.type === "message_start") {
            output.responseId = event.message.id;
            const responseModel = event.message.model;
            if (responseModel !== model.id) {
              output.responseModel = responseModel;
            }
          } else if (event.type === "content_block_start") {
            if (event.content_block.type === "fallback") {
              if (output.content.length > 0) {
                throw new Error("Anthropic performed an unsupported mid-output model fallback");
              }
              continue;
            }
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
                arguments: (event.content_block.input as Record<string, any>) ?? {},
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
            if (event.delta.type === "text_delta") {
              const index = blocks.findIndex(
                /**
                 * 检查流式内容块是否对应当前协议索引。
                 * @param b - 当前需要检查的协议内容块。
                 * @returns 索引与当前事件相同时返回 true。
                 */
                (b: Block): boolean => b.index === event.index,
              );
              const block = blocks[index];
              if (block && block.type === "text") {
                block.text += event.delta.text;
                stream.push({
                  type: "text_delta",
                  contentIndex: index,
                  delta: event.delta.text,
                  partial: output,
                });
              }
            } else if (event.delta.type === "input_json_delta") {
              const index = blocks.findIndex(
                /**
                 * 检查流式内容块是否对应当前协议索引。
                 * @param b - 当前需要检查的协议内容块。
                 * @returns 索引与当前事件相同时返回 true。
                 */
                (b: Block): boolean => b.index === event.index,
              );
              const block = blocks[index];
              if (block && block.type === "toolCall") {
                block.partialJson += event.delta.partial_json;
                block.arguments = parseStreamingJson(block.partialJson);
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: index,
                  delta: event.delta.partial_json,
                  partial: output,
                });
              }
            }
          } else if (event.type === "content_block_stop") {
            const index = blocks.findIndex(
              /**
               * 检查流式内容块是否对应当前协议索引。
               * @param b - 当前需要检查的协议内容块。
               * @returns 索引与当前事件相同时返回 true。
               */
              (b: Block): boolean => b.index === event.index,
            );
            const block = blocks[index];
            if (block) {
              delete (block as any).index;
              if (block.type === "text") {
                stream.push({
                  type: "text_end",
                  contentIndex: index,
                  content: block.text,
                  partial: output,
                });
              } else if (block.type === "toolCall") {
                block.arguments = parseStreamingJson(block.partialJson);
                delete (
                  block as {
                    partialJson?: string;
                  }
                ).partialJson;
                stream.push({
                  type: "toolcall_end",
                  contentIndex: index,
                  toolCall: block,
                  partial: output,
                });
              }
            }
          } else if (event.type === "message_delta") {
            if (event.delta.stop_reason) {
              output.rawStopReason = event.delta.stop_reason;
              const stopReasonResult = mapStopReason(
                event.delta.stop_reason,
                event.delta.stop_details,
              );
              output.stopReason = stopReasonResult.stopReason;
              if (stopReasonResult.errorMessage) {
                output.errorMessage = stopReasonResult.errorMessage;
              }
            }
          }
        }
        if (output.stopReason === "pending") {
          throw new Error("Anthropic stream ended without a stop reason");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error(output.errorMessage || "An unknown error occurred");
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        for (const block of output.content) {
          delete (
            block as {
              index?: number;
            }
          ).index;
          delete (
            block as {
              partialJson?: string;
            }
          ).partialJson;
        }
        output.stopReason = "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    }
  )();
  return stream;
};
/**
 * 创建使用显式认证和合并请求头的协议客户端。
 * @param model - 本次请求的模型配置。
 * @param apiKey - 本次请求的显式密钥。
 * @param optionsHeaders - 覆盖模型默认请求头的请求选项，null 值交由 SDK 处理。
 * @param fetch - 可选的网络请求实现。
 * @returns 本次请求使用的新客户端。
 * @throws SDK 初始化失败时抛出异常。
 * @remarks 不读取环境凭据；请求选项请求头覆盖模型同名请求头。
 */
function createClient(
  model: Model<"anthropic-messages">,
  apiKey: string | undefined,
  optionsHeaders?: ProviderHeaders,
  fetch?: typeof globalThis.fetch,
): Anthropic {
  const defaultHeaders = mergeHeaders(
    {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    model.headers,
    optionsHeaders,
  );
  const client = new PiAnthropic({
    apiKey: apiKey ?? null,
    authToken: null,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    defaultHeaders,
  });
  return client;
}
/**
 * 读取请求头中的 Anthropic 测试功能或补充工具增量功能。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @returns 去重后的功能名称；显式 null 禁用全部功能。
 * @remarks 请求选项的请求头覆盖模型同名请求头配置。
 */
function getBetaFeatures(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): NonNullable<MessageCreateParamsStreaming["betas"]> {
  let configuredFeatures: string | null | undefined;
  for (const headers of [model.headers, options?.headers]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (name.toLowerCase() === "anthropic-beta") {
        configuredFeatures = value;
      }
    }
  }
  if (configuredFeatures === null) {
    return [];
  }
  if (configuredFeatures !== undefined) {
    const configuredNames = configuredFeatures.split(",");
    const nonEmptyNames = configuredNames
      .map(
        /**
         * 去除测试功能名称两端的空白。
         * @param feature - 请求头中拆分出的测试功能名称。
         * @returns 修剪后的功能名称。
         */
        (feature: string): string => feature.trim(),
      )
      .filter(
        /**
         * 检查测试功能名称是否非空。
         * @param feature - 请求头中拆分出的测试功能名称。
         * @returns 名称非空时返回 true。
         */
        (feature: string): boolean => feature.length > 0,
      );
    return [...new Set(nonEmptyNames)];
  }
  const features: NonNullable<MessageCreateParamsStreaming["betas"]> = [];
  if (shouldUseFineGrainedToolStreamingBeta(model, context)) {
    features.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  }
  return [...new Set(features)];
}
/**
 * 组装并校验 Anthropic 流式请求参数。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @returns 包含模型、消息、令牌上限和可选工具的流式参数。
 * @throws 令牌上限或工具选择无效时抛出异常。
 * @remarks 令牌上限默认采用 model.maxTokens；兼容标志决定是否发送温度和工具增量声明。
 */
function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
): MessageCreateParamsStreaming {
  const maxTokens = options?.maxTokens ?? model.maxTokens;
  if (!Number.isFinite(maxTokens) || !Number.isInteger(maxTokens) || maxTokens < 0) {
    throw new Error("maxTokens 必须是非负有限整数。");
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
  const compat = getAnthropicCompat(model);
  const initialSystemText = context.systemPrompt ?? "";
  const transformedMessages = transformMessages(context.messages, model);
  const converted = convertMessages(transformedMessages);
  const betaFeatures = getBetaFeatures(model, context, options);
  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: converted,
    max_tokens: maxTokens,
    stream: true,
    ...(betaFeatures.length > 0 ? { betas: betaFeatures } : {}),
  };
  if (initialSystemText) {
    params.system = [
      {
        type: "text",
        text: initialSystemText,
      },
    ];
  }
  if (options?.temperature !== undefined && compat.supportsTemperature) {
    params.temperature = options.temperature;
  }
  const tools = context.tools ?? [];
  if (tools.length > 0) {
    params.tools = convertTools(tools, compat.supportsEagerToolInputStreaming);
  }
  if (options?.toolChoice) {
    if (typeof options.toolChoice === "string") {
      params.tool_choice = { type: options.toolChoice };
    } else {
      params.tool_choice = options.toolChoice;
    }
  }
  return params;
}
/**
 * 将单条工具结果转换为 Anthropic 工具结果块。
 * @param msg - 按历史顺序处理的单条消息。
 * @returns 保留调用标识、内容和错误标志的协议块。
 */
function convertToolResult(msg: ToolResultMessage): ContentBlockParam {
  return {
    type: "tool_result",
    tool_use_id: msg.toolCallId,
    content: convertContentBlocks(msg.content),
    is_error: msg.isError,
  };
}
/**
 * 将归一化历史转换为 Anthropic 请求消息。
 * @param transformedMessages - 已经归一化的历史消息。
 * @returns 保留有效文本与工具调用、合并连续工具结果的消息数组。
 * @remarks 空白文本消息和空内容块跳过；不修改原历史。
 */
function convertMessages(transformedMessages: Message[]): MessageParam[] {
  const params: MessageParam[] = [];
  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({
            role: "user",
            content: msg.content,
          });
        }
      } else {
        const blocks: ContentBlockParam[] = msg.content.map(
          /**
           * 将用户文本或图片转换为协议内容块。
           * @param item - 用户消息中的文本或图片内容块。
           * @returns 保留原文或图片数据的协议内容块。
           */
          (item: TextContent | ImageContent): ContentBlockParam => {
            if (item.type === "text") {
              return {
                type: "text",
                text: item.text,
              };
            } else {
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: item.mimeType as
                    "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                  data: item.data,
                },
              };
            }
          },
        );
        const filteredBlocks = blocks.filter(
          /**
           * 过滤 Anthropic 空白文本并保留其他内容块。
           * @param b - 当前需要检查的协议内容块。
           * @returns 非空白文本或其他内容块返回 true。
           */
          (b: ContentBlockParam): boolean => {
            if (b.type === "text") {
              return b.text.trim().length > 0;
            }
            return true;
          },
        );
        if (filteredBlocks.length === 0) {
          continue;
        }
        params.push({
          role: "user",
          content: filteredBlocks,
        });
      }
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim().length === 0) {
            continue;
          }
          blocks.push({
            type: "text",
            text: block.text,
          });
        } else if (block.type === "toolCall") {
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
      params.push({
        role: "assistant",
        content: blocks,
      });
    } else if (msg.role === "toolResult") {
      const toolResults: ContentBlockParam[] = [];
      let j = i;
      while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
        toolResults.push(convertToolResult(transformedMessages[j] as ToolResultMessage));
        j++;
      }
      i = j - 1;
      params.push({
        role: "user",
        content: toolResults,
      });
    }
  }
  return params;
}
/**
 * 判断是否需要启用 Anthropic 工具参数增量测试功能。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @returns 存在工具且未启用 eager_input_streaming 时返回 true。
 */
function shouldUseFineGrainedToolStreamingBeta(
  model: Model<"anthropic-messages">,
  context: Context,
): boolean {
  return (
    (context.tools ?? []).length > 0 && !getAnthropicCompat(model).supportsEagerToolInputStreaming
  );
}
/**
 * 将项目工具声明转换为 Anthropic 工具结构。
 * @param tools - 工具名称、说明和参数结构列表。
 * @param supportsEagerToolInputStreaming - 是否为工具声明启用输入增量传输。
 * @returns 含对象输入结构和可选输入增量标志的工具数组。
 * @remarks 缺省 properties 和 required 分别补为空对象和空数组。
 */
function convertTools(tools: Tool[], supportsEagerToolInputStreaming: boolean): BetaTool[] {
  if (!tools) {
    return [];
  }
  return tools.map(
    /**
     * 将单个工具声明转换为 Anthropic 工具结构。
     * @param tool - 需要转换的工具名称、说明和参数结构。
     * @returns 保留名称和说明、补齐对象输入结构的工具。
     */
    (tool: Tool): BetaTool => {
      const parameters = tool.parameters;
      const schema = parameters as {
        properties?: unknown;
        required?: string[];
      };
      const legacyInputSchema = {
        type: "object" as const,
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      };
      return {
        name: tool.name,
        description: tool.description,
        ...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
        input_schema: legacyInputSchema,
      };
    },
  );
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
): {
  stopReason: StopReason;
  errorMessage?: string;
} {
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
