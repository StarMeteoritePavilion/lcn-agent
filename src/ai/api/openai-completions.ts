import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  OpenAICompletionsCompat,
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
import { parseStreamingJson } from "../utils/json-parse.ts";

import { transformMessages } from "./transform-messages.ts";
import { validateStreamOptions } from "../utils/validation.ts";
/**
 * 校验并返回本次请求的显式 API 密钥。
 * @param provider - 请求服务商标识，用于缺少密钥时的错误说明。
 * @param apiKey - 本次请求的显式密钥。
 * @returns 非空密钥原文。
 * @throws 密钥不是非空字符串时抛出异常。
 */
function getClientApiKey(provider: string, apiKey: string | undefined): string {
  if (typeof apiKey === "string" && apiKey.trim()) {
    return apiKey;
  }
  throw new Error(`No API key for provider: ${provider}`);
}
/**
 * 检查历史是否包含工具调用或工具结果。
 * @param messages - 按对话顺序排列的历史消息。
 * @returns 存在工具历史时返回 true，否则返回 false。
 */
function hasToolHistory(messages: Message[]): boolean {
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "assistant") {
      if (
        msg.content.some(
          /**
           * 检查内容块是否为工具调用。
           * @param block - 待检查或处理的内容块。
           * @returns type 为 toolCall 时返回 true。
           */
          (block: TextContent | ToolCall): boolean => block.type === "toolCall",
        )
      ) {
        return true;
      }
    }
  }
  return false;
}
/**
 * 判断内容块是否为文本并收窄其类型。
 * @param block - 待检查或处理的内容块。
 * @returns type 为 text 时返回 true。
 */
function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}
/**
 * 判断内容块是否为工具调用并收窄其类型。
 * @param block - 待检查或处理的内容块。
 * @returns type 为 toolCall 时返回 true。
 */
function isToolCallBlock(block: { type: string }): block is ToolCall {
  return block.type === "toolCall";
}
/**
 * 判断内容块是否为图片并收窄其类型。
 * @param block - 待检查或处理的内容块。
 * @returns type 为 image 时返回 true。
 */
function isImageContentBlock(block: { type: string }): block is ImageContent {
  return block.type === "image";
}
export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
}
type ResolvedOpenAICompletionsCompat = Required<OpenAICompletionsCompat>;

/**
 * 创建助手消息事件流并启动协议请求。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @returns 立即返回可异步迭代内容事件并通过 result() 等待最终消息的事件流。
 * @remarks 请求校验、网络和协议处理失败通过 error 事件返回；不执行工具，不自动续写或重试，partial 与最终消息共享引用。
 */
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
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
        const apiKey = getClientApiKey(model.provider, options?.apiKey);
        const compat = getCompat(model);
        const client = createClient(model, apiKey, options?.headers, options?.fetch);
        const params = buildParams(model, context, options, compat);
        const request = client.chat.completions.create(params, { maxRetries: 0 });
        const { data: openaiStream } = await request.withResponse();
        stream.push({ type: "start", partial: output });
        interface StreamingToolCallBlock extends ToolCall {
          partialArgs?: string;
          streamIndex?: number;
        }
        type StreamingBlock = TextContent | StreamingToolCallBlock;
        type StreamingToolCallDelta = {
          index?: number;
          id?: string;
          type?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        };
        let textBlock: TextContent | null = null;
        let hasFinishReason = false;
        const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
        const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
        const blocks = output.content as StreamingBlock[];
        /**
         * 查找内容块在最终消息中的位置。
         * @param block - 待检查或处理的内容块。
         * @returns 从 0 开始的索引，内容块不存在时返回 -1。
         */
        const getContentIndex = (block: StreamingBlock): number => blocks.indexOf(block);
        /**
         * 结束内容块并发送对应内容结束事件。
         * @param block - 待检查或处理的内容块。
         * @remarks 工具参数从累计原文解析，发送事件前删除内部拼接和索引字段。
         */
        const finishBlock = (block: StreamingBlock): void => {
          const contentIndex = getContentIndex(block);
          if (contentIndex === -1) {
            return;
          }
          if (block.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex,
              content: block.text,
              partial: output,
            });
          } else if (block.type === "toolCall") {
            block.arguments = parseStreamingJson(block.partialArgs);
            delete block.partialArgs;
            delete block.streamIndex;
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall: block,
              partial: output,
            });
          }
        };
        /**
         * 复用文本块或创建文本块并发送开始事件。
         * @returns 可继续更新且与最终消息内容共享引用的文本块。
         * @remarks 新块追加到输出消息，已有块保持当前位置。
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
        /**
         * 将工具增量关联到已有调用或创建调用并发送开始事件。
         * @param toolCall - 当前工具调用增量。
         * @returns 可继续更新的工具调用块。
         * @remarks 优先按 index 查找，再按 id 查找；补齐新增标识和缺失名称。
         */
        const ensureToolCallBlock = (toolCall: StreamingToolCallDelta): StreamingToolCallBlock => {
          const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
          const name = toolCall.function?.name ?? "";
          let block =
            streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
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
        for await (const chunk of openaiStream) {
          if (!chunk || typeof chunk !== "object") {
            continue;
          }
          output.responseId ||= chunk.id;
          if (
            typeof chunk.model === "string" &&
            chunk.model.length > 0 &&
            chunk.model !== model.id
          ) {
            output.responseModel ||= chunk.model;
          }
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
          if (!choice) {
            continue;
          }
          if (choice.finish_reason) {
            output.rawStopReason = choice.finish_reason;
            const finishReasonResult = mapStopReason(choice.finish_reason);
            output.stopReason = finishReasonResult.stopReason;
            if (finishReasonResult.errorMessage) {
              output.errorMessage = finishReasonResult.errorMessage;
            }
            hasFinishReason = true;
          }
          if (choice.delta) {
            if (
              choice.delta.content !== null &&
              choice.delta.content !== undefined &&
              choice.delta.content.length > 0
            ) {
              const block = ensureTextBlock();
              block.text += choice.delta.content;
              stream.push({
                type: "text_delta",
                contentIndex: getContentIndex(block),
                delta: choice.delta.content,
                partial: output,
              });
            }
            if (choice?.delta?.tool_calls) {
              for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
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
                  block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
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
        }
        for (const block of blocks) {
          finishBlock(block);
        }
        if (output.stopReason === "aborted") {
          throw new Error("Request was aborted");
        }
        if (!hasFinishReason && !compat.supportsFinishReason) {
          output.stopReason = output.content.some(
            /**
             * 检查内容块是否为工具调用。
             * @param block - 待检查或处理的内容块。
             * @returns type 为 toolCall 时返回 true。
             */
            (block: TextContent | ToolCall): boolean => block.type === "toolCall",
          )
            ? "toolUse"
            : "stop";
        }
        if (output.stopReason === "error") {
          throw new Error(output.errorMessage || "Provider returned an error stop reason");
        }
        if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
          throw new Error("Stream ended without finish_reason");
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
              partialArgs?: string;
            }
          ).partialArgs;
          delete (
            block as {
              streamIndex?: number;
            }
          ).streamIndex;
        }
        output.stopReason = "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        const rawMetadata = (error as any)?.error?.metadata?.raw;
        if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
          output.errorMessage += `\n${rawMetadata}`;
        }
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
  model: Model<"openai-completions">,
  apiKey: string,
  optionsHeaders?: ProviderHeaders,
  fetch?: typeof globalThis.fetch,
): OpenAI {
  const headers: ProviderHeaders = { ...model.headers };
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }
  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch,
    defaultHeaders: headers,
  });
}
/**
 * 组装聊天补全的流式请求参数。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @param compat - 模型的完整兼容配置。
 * @returns 包含转换后消息和可选生成参数的请求对象。
 * @throws 历史工具参数无法 JSON 序列化时抛出异常。
 * @remarks maxTokens 为 0 或省略时不发送上限；工具历史存在时保留空工具声明。
 */
function buildParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  compat: ResolvedOpenAICompletionsCompat = getCompat(model),
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  const messages = convertMessages(model, context, compat);
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages,
    stream: true,
  };
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    if (compat.maxTokensField === "max_tokens") {
      (
        params as {
          max_tokens?: number;
        }
      ).max_tokens = options.maxTokens;
    } else {
      params.max_completion_tokens = options.maxTokens;
    }
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if ((context.tools ?? []).length > 0) {
    params.tools = convertTools(context.tools ?? []);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  return params;
}
/**
 * 按模型能力与兼容配置转换聊天补全历史。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param compat - 模型的完整兼容配置。
 * @returns 保持历史顺序的请求消息；无有效内容时返回空数组。
 * @throws 历史工具参数无法 JSON 序列化时抛出异常。
 * @remarks 不修改上下文；工具图片转换为后续用户消息，必要时在工具结果后插入助手消息。
 */
function convertMessages(
  model: Model<"openai-completions">,
  context: Context,
  compat: ResolvedOpenAICompletionsCompat,
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];
  if (context.systemPrompt) {
    params.push({ role: "system", content: context.systemPrompt });
  }
  const transformedMessages = transformMessages(context.messages, model);
  let lastRole: string | null = null;
  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i];
    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      msg.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({
          role: "user",
          content: msg.content,
        });
      } else {
        const content: ChatCompletionContentPart[] = msg.content
          .filter(
            /**
             * 过滤空文本块并保留图片。
             * @param item - 用户消息中的文本或图片内容块。
             * @returns 图片或非空文本块返回 true。
             */
            (item: TextContent | ImageContent): boolean =>
              item.type !== "text" || item.text.length > 0,
          )
          .map(
            /**
             * 将用户文本或图片转换为协议内容块。
             * @param item - 用户消息中的文本或图片内容块。
             * @returns 保留原文或图片数据的协议内容块。
             */
            (item: TextContent | ImageContent): ChatCompletionContentPart => {
              if (item.type === "text") {
                return {
                  type: "text",
                  text: item.text,
                } satisfies ChatCompletionContentPartText;
              } else {
                return {
                  type: "image_url",
                  image_url: {
                    url: `data:${item.mimeType};base64,${item.data}`,
                  },
                } satisfies ChatCompletionContentPartImage;
              }
            },
          );
        if (content.length === 0) {
          continue;
        }
        params.push({
          role: "user",
          content,
        });
      }
    } else if (msg.role === "assistant") {
      const assistantMsg: ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };
      const assistantTextBlocks = msg.content.filter(isTextContentBlock);
      const assistantTextParts = assistantTextBlocks
        .filter(
          /**
           * 检查文本内容是否包含非空白字符。
           * @param block - 待检查或处理的内容块。
           * @returns 去除两端空白后仍有内容时返回 true。
           */
          (block: TextContent): boolean => block.text.trim().length > 0,
        )
        .map(
          /**
           * 将助手文本转换为聊天补全文本块。
           * @param block - 待检查或处理的内容块。
           * @returns 保留文本原文的协议内容块。
           */
          (block: TextContent): ChatCompletionContentPartText =>
            ({
              type: "text",
              text: block.text,
            }) satisfies ChatCompletionContentPartText,
        );
      const assistantText = assistantTextParts
        .map(
          /**
           * 提取文本内容块的原文。
           * @param part - 待提取原文的聊天补全文本块。
           * @returns 未经修改的文本字符串。
           */
          (part: ChatCompletionContentPartText): string => part.text,
        )
        .join("");
      const toolCalls = msg.content.filter(isToolCallBlock);
      if (assistantText.length > 0) {
        assistantMsg.content = assistantText;
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(
          /**
           * 将历史工具调用转换为聊天补全函数调用。
           * @param tc - 需要转换的历史工具调用。
           * @returns 保留标识和名称、序列化参数的函数调用。
           * @throws 历史工具参数无法 JSON 序列化时抛出异常。
           */
          (tc: ToolCall): ChatCompletionMessageToolCall => {
            return {
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            };
          },
        );
      }
      const content = assistantMsg.content;
      const hasContent = content !== null && content !== undefined && content.length > 0;
      if (!hasContent && !assistantMsg.tool_calls) {
        continue;
      }
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      const imageBlocks: Array<{
        type: "image_url";
        image_url: {
          url: string;
        };
      }> = [];
      let j = i;
      for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
        const toolMsg = transformedMessages[j] as ToolResultMessage;
        const textBlocks = toolMsg.content.filter(isTextContentBlock);
        const textResult = textBlocks
          .map(
            /**
             * 提取文本内容块的原文。
             * @param block - 待检查或处理的内容块。
             * @returns 未经修改的文本字符串。
             */
            (block: TextContent): string => block.text,
          )
          .join("\n");
        const hasImages = toolMsg.content.some(
          /**
           * 检查内容块是否为图片。
           * @param c - 待检查或提取原文的内容块。
           * @returns type 为 image 时返回 true。
           */
          (c: TextContent | ImageContent): boolean => c.type === "image",
        );
        const hasText = textResult.length > 0;
        const toolResultText = hasText
          ? textResult
          : hasImages
            ? "(see attached image)"
            : "(no tool output)";
        const toolResultMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          content: toolResultText,
          tool_call_id: toolMsg.toolCallId,
        };
        if (compat.requiresToolResultName && toolMsg.toolName) {
          (toolResultMsg as any).name = toolMsg.toolName;
        }
        params.push(toolResultMsg);
        if (hasImages && model.input.includes("image")) {
          for (const block of toolMsg.content) {
            if (isImageContentBlock(block)) {
              imageBlocks.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.mimeType};base64,${block.data}`,
                },
              });
            }
          }
        }
      }
      i = j - 1;
      if (imageBlocks.length > 0) {
        if (compat.requiresAssistantAfterToolResult) {
          params.push({
            role: "assistant",
            content: "I have processed the tool results.",
          });
        }
        params.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Attached image(s) from tool result:",
            },
            ...imageBlocks,
          ],
        });
        lastRole = "user";
      } else {
        lastRole = "toolResult";
      }
      continue;
    }
    lastRole = msg.role;
  }
  return params;
}
/**
 * 将项目工具声明转换为聊天补全函数工具。
 * @param tools - 工具名称、说明和参数结构列表。
 * @returns 保留名称、说明和参数结构的工具数组，没有工具时为空数组。
 */
function convertTools(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map(
    /**
     * 将单个工具声明转换为协议函数工具。
     * @param tool - 需要转换的工具名称、说明和参数结构。
     * @returns 保留名称、说明和参数结构的函数工具。
     */
    (tool: Tool): OpenAI.Chat.Completions.ChatCompletionTool => {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
        },
      };
    },
  );
}
/**
 * 将接口结束原因映射为助手消息结束状态及错误说明。
 * @param reason - SDK 定义的结束原因或服务提供方返回的其他字符串；null 按正常结束映射。
 * @returns stop、length、toolUse 或 error 状态；error 状态附带包含原始结束原因的错误说明。
 * @remarks
 * stop、end 和 null 映射为 stop；length 映射为 length，表示文本可能因令牌数上限而截断。
 * tool_calls 和 function_call 映射为 toolUse；content_filter、network_error 及其他字符串均映射为 error。
 * 流读取流程仅在 finish_reason 为真值时调用本函数，因此流中仅收到 null 不视为正常结束。
 */
function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
  stopReason: StopReason;
  errorMessage?: string;
} {
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
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}
/**
 * 返回聊天补全接口的默认兼容选项。
 * @returns 支持存储和结束原因、使用 max_completion_tokens 的默认选项。
 */
function detectCompat(): ResolvedOpenAICompletionsCompat {
  return {
    supportsStore: true,
    supportsDeveloperRole: true,
    supportsFinishReason: true,
    maxTokensField: "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
  };
}
/**
 * 读取模型的兼容选项并补齐默认值。
 * @param model - 本次请求的模型配置。
 * @returns 用于构建请求和处理结束状态的完整兼容选项。
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
  const detected = detectCompat();
  if (!model.compat) {
    return detected;
  }
  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
  };
}
