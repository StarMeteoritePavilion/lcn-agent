import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  FunctionTool,
  ResponseInput,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputText,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  OpenAIResponsesCompat,
  ProviderHeaders,
  StreamFunction,
  StreamOptions,
  StopReason,
  TextContent,
  TextSignatureV1,
  Tool,
  ToolCall,
  Context,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { transformMessages } from "./transform-messages.ts";
import { validateStreamOptions } from "../utils/validation.ts";
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
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
 * 读取模型的兼容选项并补齐默认值。
 * @param model - 本次请求的模型配置。
 * @returns 用于构建请求和处理结束状态的完整兼容选项。
 */
function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
  return {
    supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
    supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
  };
}
export interface OpenAIResponsesOptions extends StreamOptions {
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}
/**
 * 创建助手消息事件流并启动协议请求。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @returns 立即返回可异步迭代内容事件并通过 result() 等待最终消息的事件流。
 * @remarks 请求校验、网络和协议处理失败通过 error 事件返回；不执行工具，不自动续写或重试，partial 与最终消息共享引用。
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
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
        const request = client.responses.create(params, { maxRetries: 0 });
        const { data: openaiStream } = await request.withResponse();
        stream.push({ type: "start", partial: output });
        await processResponsesStream(openaiStream, output, stream);
        if (output.stopReason === "pending") {
          throw new Error("OpenAI Responses stream ended without a stop reason");
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        output.errorMessage = errorMessage;
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
  model: Model<"openai-responses">,
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
 * 组装 Responses 的流式请求参数。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @param compat - 模型的完整兼容配置。
 * @returns 不保存响应、包含转换后输入及可选生成参数的请求对象。
 * @throws 历史工具参数无法 JSON 序列化时抛出异常。
 * @remarks 正令牌上限至少为 16；maxTokens 为 0 或省略时不发送上限。
 */
function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options: OpenAIResponsesOptions | undefined,
  compat: Required<OpenAIResponsesCompat> = getCompat(model),
): ResponseCreateParamsStreaming {
  const messages = convertResponsesMessages(model, context);
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    store: false,
  };
  if (options?.maxTokens && compat.supportsMaxOutputTokens) {
    params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
  }
  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }
  if ((context.tools ?? []).length > 0) {
    params.tools = convertResponsesTools(context.tools ?? []);
  }
  if (options?.toolChoice !== undefined) {
    params.tool_choice = options.toolChoice;
  }
  return params;
}

/**
 * 将消息标识和可选阶段编码为版本 1 的文本签名。
 * @param id - Responses 消息项的标识。
 * @param phase - 可选的消息输出阶段。
 * @returns 包含 v、id 及非空 phase 的 JSON 字符串，用于回传助手历史。
 */
function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
  const payload: TextSignatureV1 = { v: 1, id };
  if (phase) {
    payload.phase = phase;
  }
  return JSON.stringify(payload);
}
/**
 * 读取文本签名中的消息标识及可选输出阶段。
 * @param signature - 版本化 JSON 签名或旧版纯字符串标识。
 * @returns 签名包含的标识和有效阶段；签名为空时返回 undefined。
 * @remarks 无法识别版本化结构或解析失败时，将整个原始签名作为旧版标识。
 */
function parseTextSignature(signature: string | undefined):
  | {
      id: string;
      phase?: TextSignatureV1["phase"];
    }
  | undefined {
  if (!signature) {
    return undefined;
  }
  if (signature.startsWith("{")) {
    try {
      const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
      if (parsed.v === 1 && typeof parsed.id === "string") {
        if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
          return { id: parsed.id, phase: parsed.phase };
        }
        return { id: parsed.id };
      }
    } catch {
      // 无法识别的 JSON 签名沿用旧版字符串标识。
    }
  }
  return { id: signature };
}
type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;
/**
 * 将工具结果转换为 Responses 文本或图文输出。
 * @param model - 本次请求的模型配置。
 * @param content - 按原顺序排列的文本和图片内容块。
 * @returns 有图片且模型支持图片时返回内容块数组，否则返回文本或固定占位。
 */
function convertToolResultOutput<TApi extends Api>(
  model: Model<TApi>,
  content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
  const textContent = content.filter(
    /**
     * 检查内容块是否为文本。
     * @param c - 待检查或提取原文的内容块。
     * @returns type 为 text 时返回 true。
     */
    (c: TextContent | ImageContent): c is TextContent => c.type === "text",
  );
  const textResult = textContent
    .map(
      /**
       * 提取文本内容块的原文。
       * @param c - 待检查或提取原文的内容块。
       * @returns 未经修改的文本字符串。
       */
      (c: TextContent): string => c.text,
    )
    .join("\n");
  const images = content.filter(
    /**
     * 检查内容块是否为图片。
     * @param c - 待检查或提取原文的内容块。
     * @returns type 为 image 时返回 true。
     */
    (c: TextContent | ImageContent): c is ImageContent => c.type === "image",
  );
  const hasText = textResult.length > 0;
  if (images.length === 0 || !model.input.includes("image")) {
    return hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)";
  }
  const output: ToolResultOutputContent = [];
  if (hasText) {
    output.push({ type: "input_text", text: textResult });
  }
  for (const image of images) {
    output.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return output;
}
/**
 * 将项目对话历史转换为 Responses 输入项。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @returns 按历史顺序排列的输入项，没有可发送内容时返回空数组。
 * @throws 历史工具参数无法 JSON 序列化时抛出异常。
 * @remarks 保留文本签名的标识和阶段，工具结果按调用标识关联；不修改上下文。
 */
function convertResponsesMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
): ResponseInput {
  const messages: ResponseInput = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  const transformedMessages = transformMessages(context.messages, model);
  for (let msgIndex = 0; msgIndex < transformedMessages.length; msgIndex++) {
    const msg = transformedMessages[msgIndex];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else {
        const content: ResponseInputContent[] = msg.content.map(
          /**
           * 将用户文本或图片转换为协议内容块。
           * @param item - 用户消息中的文本或图片内容块。
           * @returns 保留原文或图片数据的协议内容块。
           */
          (item: TextContent | ImageContent): ResponseInputContent => {
            if (item.type === "text") {
              return {
                type: "input_text",
                text: item.text,
              } satisfies ResponseInputText;
            }
            return {
              type: "input_image",
              detail: "auto",
              image_url: `data:${item.mimeType};base64,${item.data}`,
            } satisfies ResponseInputImage;
          },
        );
        if (content.length === 0) {
          continue;
        }
        messages.push({
          role: "user",
          content,
        });
      }
    } else if (msg.role === "assistant") {
      const output: ResponseInput = [];
      const assistantMsg = msg as AssistantMessage;
      const isSameProviderAndApi =
        assistantMsg.provider === model.provider && assistantMsg.api === model.api;
      const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
      const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
      let textBlockIndex = 0;
      for (const block of msg.content) {
        if (block.type === "text") {
          const textBlock = block as TextContent;
          const parsedSignature = parseTextSignature(textBlock.textSignature);
          const fallbackMessageId =
            textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
          textBlockIndex++;
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = fallbackMessageId;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          output.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: textBlock.text, annotations: [] }],
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase,
          } satisfies ResponseOutputMessage);
        } else if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          const [callId, itemIdRaw] = toolCall.id.split("|");
          let itemId: string | undefined = itemIdRaw;
          const itemIdPrefix = "fc_";
          if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
            itemId = undefined;
          }
          output.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
            ...(isSameModel && toolCall.namespace !== undefined
              ? { namespace: toolCall.namespace }
              : {}),
          });
        }
      }
      if (output.length === 0) {
        continue;
      }
      messages.push(...output);
    } else if (msg.role === "toolResult") {
      const [callId] = msg.toolCallId.split("|");
      const output = convertToolResultOutput(model, msg.content);
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
    }
  }
  return messages;
}
/**
 * 将项目工具声明转换为 Responses 函数工具。
 * @param tools - 工具名称、说明和参数结构列表。
 * @returns 保留名称、说明和参数结构且关闭 strict 的工具数组，没有工具时为空数组。
 */
function convertResponsesTools(tools: readonly Tool[]): FunctionTool[] {
  return tools.map(
    /**
     * 将单个工具声明转换为关闭严格模式的 Responses 函数工具。
     * @param tool - 需要转换的工具名称、说明和参数结构。
     * @returns 保留名称、说明和参数结构，strict 为 false 的函数工具。
     */
    (tool: Tool): FunctionTool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      strict: false,
    }),
  );
}
type StreamingToolCall = ToolCall & {
  partialJson?: string;
};
type ResponsesOutputSlot =
  | {
      type: "text";
      block: TextContent;
      contentIndex: number;
    }
  | {
      type: "toolCall";
      block: StreamingToolCall;
      contentIndex: number;
    };
type ToolCallOutputSlot = Extract<
  ResponsesOutputSlot,
  {
    type: "toolCall";
  }
>;
/**
 * 读取 Responses 协议流并写入文本、工具调用及结束状态。
 * @param openaiStream - 本次请求返回的 Responses 协议事件流。
 * @param output - 持续更新的最终助手消息。
 * @param stream - 接收文本和工具调用内容事件的事件流。
 * @returns Promise 完成表示协议流已处理，内容及结束状态写入 output。
 * @throws 协议报错、缺少终结响应或正常结束时仍有未完成工具调用时拒绝 Promise。
 * @remarks 发送内容事件，不发送整体终结事件；保留截断参数并清理内部原文。
 */
async function processResponsesStream(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<void> {
  let sawTerminalResponseEvent = false;
  const outputSlots = new Map<number, ResponsesOutputSlot>();
  /**
   * 将最终回答阶段标记为正常结束。
   * @param item - 服务端的响应输出项。
   * @remarks 仅 message 类型且 phase 为 final_answer 时更新输出消息。
   */
  const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
    if (item.type === "message" && item.phase === "final_answer") {
      output.stopReason = "stop";
    }
  };
  /**
   * 按输出项索引查找指定类型的内容槽。
   * @param outputIndex - 服务端输出项的索引。
   * @param type - 需要查找的内容槽类型。
   * @returns 匹配类型的内容槽，不存在或类型不匹配时返回 undefined。
   */
  const getSlot = <TType extends ResponsesOutputSlot["type"]>(
    outputIndex: number,
    type: TType,
  ):
    | Extract<
        ResponsesOutputSlot,
        {
          type: TType;
        }
      >
    | undefined => {
    const slot = outputSlots.get(outputIndex);
    return slot?.type === type
      ? (slot as Extract<
          ResponsesOutputSlot,
          {
            type: TType;
          }
        >)
      : undefined;
  };
  /**
   * 发送工具调用参数的增量事件。
   * @param slot - 对应工具调用的内容槽。
   * @param delta - 需要发送的参数原文增量。
   * @remarks delta 为 undefined 时不发送事件，其余值保持原文。
   */
  const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
    if (delta === undefined) {
      return;
    }
    stream.push({
      type: "toolcall_delta",
      contentIndex: slot.contentIndex,
      delta,
      partial: output,
    });
  };
  /**
   * 为文本或工具输出项创建内容槽并发送开始事件。
   * @param outputIndex - 服务端输出项的索引。
   * @param item - 服务端的响应输出项。
   * @returns 创建的内容槽，其他输出项类型返回 undefined。
   * @remarks 内容块追加到最终消息，槽按服务端输出项索引登记。
   */
  const createSlot = (
    outputIndex: number,
    item: ResponseOutputItem,
  ): ResponsesOutputSlot | undefined => {
    if (item.type === "message") {
      applyMessagePhaseStopReason(item);
      const block: TextContent = { type: "text", text: "" };
      output.content.push(block);
      const slot = {
        type: "text",
        block,
        contentIndex: output.content.length - 1,
      } satisfies ResponsesOutputSlot;
      outputSlots.set(outputIndex, slot);
      stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item.type === "function_call") {
      const block: StreamingToolCall = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: {},
        ...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
        partialJson: item.arguments || "",
      };
      output.content.push(block);
      const slot = {
        type: "toolCall",
        block,
        contentIndex: output.content.length - 1,
      } satisfies ResponsesOutputSlot;
      outputSlots.set(outputIndex, slot);
      stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    return undefined;
  };

  /**
   * 从终结响应更新输出标识、结束原因和错误说明。
   * @param response - 服务端的终结响应。
   * @throws 响应状态不属于 SDK 定义时抛出异常。
   * @remarks 标记已经收到终结事件；正常结束且存在工具调用时改为 toolUse。
   */
  const finalizeResponse = (
    response: Extract<
      ResponseStreamEvent,
      {
        type: "response.completed" | "response.incomplete";
      }
    >["response"],
  ): void => {
    sawTerminalResponseEvent = true;
    if (response?.id) {
      output.responseId = response.id;
    }
    const status = response?.status;
    const incompleteDetails = response?.incomplete_details as
      | {
          reason?: unknown;
        }
      | null
      | undefined;
    const incompleteReason =
      typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
    output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
    const mappedStop = mapStopReason(status, incompleteReason);
    output.stopReason = mappedStop.stopReason;
    if (mappedStop.errorMessage === undefined) {
      delete output.errorMessage;
    } else {
      output.errorMessage = mappedStop.errorMessage;
    }
    if (
      output.content.some(
        /**
         * 检查内容块是否为工具调用。
         * @param b - 当前需要检查的协议内容块。
         * @returns type 为 toolCall 时返回 true。
         */
        (b: TextContent | ToolCall): boolean => b.type === "toolCall",
      ) &&
      output.stopReason === "stop"
    ) {
      output.stopReason = "toolUse";
    }
  };
  for await (const event of openaiStream) {
    if (event.type === "response.created") {
      output.responseId = event.response.id;
    } else if (event.type === "response.output_item.added") {
      createSlot(event.output_index, event.item);
    } else if (event.type === "response.output_text.delta") {
      const slot = getSlot(event.output_index, "text");
      if (!slot) {
        continue;
      }
      slot.block.text += event.delta;
      stream.push({
        type: "text_delta",
        contentIndex: slot.contentIndex,
        delta: event.delta,
        partial: output,
      });
    } else if (event.type === "response.refusal.delta") {
      const slot = getSlot(event.output_index, "text");
      if (!slot) {
        continue;
      }
      slot.block.text += event.delta;
      stream.push({
        type: "text_delta",
        contentIndex: slot.contentIndex,
        delta: event.delta,
        partial: output,
      });
    } else if (event.type === "response.function_call_arguments.delta") {
      const slot = getSlot(event.output_index, "toolCall");
      if (!slot || slot.block.partialJson === undefined) {
        continue;
      }
      slot.block.partialJson += event.delta;
      slot.block.arguments = parseStreamingJson(slot.block.partialJson);
      pushToolCallDelta(slot, event.delta);
    } else if (event.type === "response.function_call_arguments.done") {
      const slot = getSlot(event.output_index, "toolCall");
      if (!slot || slot.block.partialJson === undefined) {
        continue;
      }
      const previousPartialJson = slot.block.partialJson;
      slot.block.partialJson = event.arguments;
      slot.block.arguments = parseStreamingJson(slot.block.partialJson);
      if (event.arguments.startsWith(previousPartialJson)) {
        const delta = event.arguments.slice(previousPartialJson.length);
        if (delta.length > 0) {
          pushToolCallDelta(slot, delta);
        }
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item;
      applyMessagePhaseStopReason(item);
      const slot = outputSlots.get(event.output_index) ?? createSlot(event.output_index, item);
      if (item.type === "message" && slot?.type === "text") {
        slot.block.text =
          item.content
            ?.map(
              /**
               * 读取 Responses 文本或拒绝内容的原文。
               * @param c - 待检查或提取原文的内容块。
               * @returns 文本输出或拒绝说明。
               */
              (c: ResponseOutputMessage["content"][number]): string =>
                c.type === "output_text" ? c.text : c.refusal,
            )
            .join("") || "";
        slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
        stream.push({
          type: "text_end",
          contentIndex: slot.contentIndex,
          content: slot.block.text,
          partial: output,
        });
        outputSlots.delete(event.output_index);
      } else if (
        item.type === "function_call" &&
        slot?.type === "toolCall" &&
        slot.block.partialJson !== undefined
      ) {
        slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
        if (item.namespace !== undefined) {
          slot.block.namespace = item.namespace;
        }
        delete slot.block.partialJson;
        stream.push({
          type: "toolcall_end",
          contentIndex: slot.contentIndex,
          toolCall: slot.block,
          partial: output,
        });
        outputSlots.delete(event.output_index);
      }
    } else if (event.type === "response.completed" || event.type === "response.incomplete") {
      finalizeResponse(event.response);
    } else if (event.type === "error") {
      throw new Error(`Error Code ${event.code}: ${event.message}`);
    } else if (event.type === "response.failed") {
      sawTerminalResponseEvent = true;
      output.rawStopReason = event.response?.status;
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const msg = error
        ? `${error.code || "unknown"}: ${error.message || "no message"}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : "Unknown error (no error details in response)";
      throw new Error(msg);
    }
  }
  if (!sawTerminalResponseEvent) {
    throw new Error("OpenAI Responses stream ended before a terminal response event");
  }
  if (output.stopReason === "toolUse") {
    for (const block of output.content) {
      if (block.type !== "toolCall") {
        continue;
      }
      const toolCall = block as StreamingToolCall;
      if (toolCall.partialJson !== undefined) {
        throw new Error(
          `OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`,
        );
      }
    }
  }
  for (const block of output.content) {
    if (block.type === "toolCall") {
      delete (block as StreamingToolCall).partialJson;
    }
  }
}
/**
 * 将 Responses 状态及未完成原因映射为项目消息结束状态。
 * @param status - 接口响应状态；省略时按 stop 映射。
 * @param incompleteReason - 未完成响应的原因，max_output_tokens 映射为 length。
 * @returns 消息结束状态及可选错误说明。
 * @throws status 不属于 SDK 定义的状态时抛出异常。
 * @remarks queued 和 in_progress 沿用现有规则映射为 stop；其他未完成原因映射为 error。
 */
function mapStopReason(
  status: OpenAI.Responses.ResponseStatus | undefined,
  incompleteReason?: string,
): {
  stopReason: StopReason;
  errorMessage?: string;
} {
  if (!status) {
    return { stopReason: "stop" };
  }
  switch (status) {
    case "completed":
      return { stopReason: "stop" };
    case "incomplete":
      if (incompleteReason === "max_output_tokens") {
        return { stopReason: "length" };
      }
      return {
        stopReason: "error",
        errorMessage: incompleteReason
          ? `Response incomplete: ${incompleteReason}`
          : "Response incomplete without a provider reason",
      };
    case "failed":
    case "cancelled":
      return { stopReason: "error" };
    case "in_progress":
    case "queued":
      return { stopReason: "stop" };
    default: {
      const _exhaustive: never = status;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}
