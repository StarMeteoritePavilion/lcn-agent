import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
  Tool as OpenAITool,
} from "openai/resources/responses/responses.js";
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
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { shortHash } from "../utils/hash.ts";

/** 附带尚未结束的参数原文的工具调用块。 */
type StreamingToolCall = ToolCall & { partialJson?: string };
/** 将协议输出项关联到本地内容块及其索引的槽位。 */
type ResponsesOutputSlot =
  | { type: "text"; block: TextContent; contentIndex: number }
  | { type: "toolCall"; block: StreamingToolCall; contentIndex: number };
/** 用于累积工具参数的输出槽位。 */
type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

/** Responses 请求选项，工具选择原样交给接口处理。 */
interface OpenAIResponsesOptions extends StreamOptions {
  /** 可选的工具选择策略或指定工具；本模块不校验与工具声明的对应关系。 */
  toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/** 保存 Responses 消息标识与输出阶段的版本化文本签名。 */
interface TextSignatureV1 {
  /** 当前签名格式版本。 */
  v: 1;
  /** Responses 消息项标识。 */
  id: string;
  /** 可选的说明或最终回答阶段。 */
  phase?: "commentary" | "final_answer";
}

/**
 * 创建助手消息事件流并启动 OpenAI Responses 请求。
 * @param model - 请求模型、接口地址及输出消息的来源标识。
 * @param context - 系统提示词、对话历史与可选工具声明。
 * @param options - 请求密钥、生成参数、自定义 fetch 及工具选择方式。
 * @returns 可异步迭代内容事件，并通过 result() 等待最终助手消息的事件流。
 * @remarks 启动处理后立即返回；请求和响应处理失败时通过 error 事件返回错误消息，不在本模块执行工具。
 */
export function stream(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  // 使用 void 显式忽略返回的 Promise，让调用方立即获得事件流并消费后续事件。
  // void 不捕获异常；请求和响应处理中的异常由 runStream 内部转换为 error 事件。
  void runStream(model, context, stream, options);
  return stream;
}

/**
 * 组织请求和响应处理，统一发送开始、完成或错误事件。
 * @param model - 请求模型及输出消息的接口、供应商和模型标识。
 * @param context - 用于构建请求的系统提示词、历史消息及工具声明。
 * @param stream - 接收内容事件与最终消息的事件流。
 * @param options - 请求密钥、生成参数、自定义 fetch 及工具选择方式。
 * @returns Promise 完成表示正常或错误结果已写入事件流。
 * @throws 错误处理自身失败时拒绝 Promise，例如非 Error 异常无法 JSON 序列化。
 * @remarks 请求成功后发送 start；响应处理成功后发送 done，失败时清理工具内部字段并发送 error，保留累计内容。
 */
async function runStream(
  model: Model<"openai-responses">,
  context: Context,
  stream: AssistantMessageEventStream,
  options?: OpenAIResponsesOptions,
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
    for (const block of output.content) {
      delete (block as { partialJson?: string }).partialJson;
    }
    output.stopReason = "error";
    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
  }
}

/**
 * 校验密钥并发起 OpenAI Responses 流式请求。
 * @param model - 请求使用的模型标识、接口地址及供应商标识。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 请求密钥、生成参数、自定义 fetch 及工具选择方式。
 * @returns Promise 完成后返回可异步迭代的 Responses 协议事件流。
 * @throws 密钥缺失、参数构建失败、客户端初始化失败或请求失败时拒绝 Promise。
 * @remarks 每次创建独立客户端，请求禁用自动重试，异常交由 runStream 处理。
 */
async function createCompletionStream(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): Promise<AsyncIterable<ResponseStreamEvent>> {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const client = new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    fetch: options?.fetch,
  });

  const params = buildParams(model, context, options);
  return client.responses.create(params, { maxRetries: 0 });
}

/**
 * 将模型、上下文和选项组装为 Responses 流式请求参数。
 * @param model - 请求模型及历史工具调用转换时使用的模型标识。
 * @param context - 系统提示词、历史消息和可选工具声明。
 * @param options - 生成参数和工具选择方式，密钥及 fetch 不写入请求体。
 * @returns 启用 stream 并关闭 store 的请求参数，保留现有消息、工具和生成参数转换规则。
 * @throws maxTokens 不是非负有限整数、temperature 不是 0 到 2 之间的有限数值，或历史工具参数无法 JSON 序列化时抛出异常。
 * @remarks maxTokens 为正整数时发送 max_output_tokens，低于 16 时提升到 16；省略或为 0 时不发送，也不读取 model.maxTokens。
 */
function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): ResponseCreateParamsStreaming {
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
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: convertResponsesMessages(model, context),
    stream: true,
    store: false,
  };
  if (maxTokens) {
    params.max_output_tokens = Math.max(maxTokens, 16);
  }
  if (temperature !== undefined) {
    params.temperature = temperature;
  }
  if (context.tools?.length) {
    params.tools = convertResponsesTools(context.tools);
  }
  if (options?.toolChoice !== undefined) {
    params.tool_choice = options.toolChoice;
  }
  return params;
}

/**
 * 将项目对话历史转换为 Responses 输入项。
 * @param model - 本次请求模型，用于判断能否复用历史工具调用的输出项标识。
 * @param context - 系统提示词及用户、助手和工具结果历史。
 * @returns 按历史顺序排列的输入项，没有可发送内容时返回空数组。
 * @throws 历史工具参数无法 JSON 序列化时抛出异常。
 * @remarks 保留文本签名中的消息标识和阶段；工具结果通过调用标识关联，空结果使用固定占位文本。
 */
function convertResponsesMessages(model: Model, context: Context): ResponseInput {
  const messages: ResponseInput = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  let msgIndex = 0;
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? [{ type: "input_text" as const, text: msg.content }]
          : msg.content.map(
              /**
               * 将用户文本块转换为 Responses 文本输入。
               * @param item - 用户的文本内容块。
               * @returns 保留文本原文的 input_text 输入块。
               */
              (item: TextContent): { type: "input_text"; text: string } => ({
                type: "input_text",
                text: item.text,
              }),
            );
      if (content.length > 0) {
        messages.push({ role: "user", content });
      }
    } else if (msg.role === "assistant") {
      let textBlockIndex = 0;
      for (const block of msg.content) {
        if (block.type === "text") {
          const parsedSignature = parseTextSignature(block.textSignature);
          const fallbackMessageId =
            textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
          textBlockIndex++;
          let msgId = parsedSignature?.id;
          if (!msgId) {
            msgId = fallbackMessageId;
          } else if (msgId.length > 64) {
            msgId = `msg_${shortHash(msgId)}`;
          }
          messages.push({
            type: "message",
            role: "assistant",
            status: "completed",
            id: msgId,
            phase: parsedSignature?.phase,
            content: [{ type: "output_text", text: block.text, annotations: [] }],
          });
        } else if (block.type === "toolCall") {
          const [callId, itemIdRaw] = block.id.split("|");
          let itemId: string | undefined = itemIdRaw;
          if (msg.model !== model.id || !itemId?.startsWith("fc_")) {
            itemId = undefined;
          }
          messages.push({
            type: "function_call",
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
    } else if (msg.role === "toolResult") {
      const [callId] = msg.toolCallId.split("|");
      const textResult = msg.content
        .map(
          /**
           * 提取工具结果文本块的原文。
           * @param block - 工具返回的文本块。
           * @returns 未修改的文本，后续以换行连接。
           */
          (block: TextContent): string => block.text,
        )
        .join("\n");
      messages.push({
        type: "function_call_output",
        call_id: callId,
        output: textResult || "(no tool output)",
      });
    }
    msgIndex++;
  }
  return messages;
}

/**
 * 读取文本签名中的消息标识及可选输出阶段。
 * @param signature - 版本化 JSON 签名或旧版纯字符串标识。
 * @returns 签名包含的标识和有效阶段；签名为空时返回 undefined。
 * @remarks 无法识别版本化结构或解析失败时，将整个原始签名作为旧版标识。
 */
function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
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
      // 继续使用旧的纯字符串签名。
    }
  }
  return { id: signature };
}

/**
 * 将项目工具声明转换为 Responses 函数工具。
 * @param tools - 工具名称、说明及参数结构列表。
 * @returns 关闭 strict 的函数工具列表；空列表返回空数组。
 */
function convertResponsesTools(tools: readonly Tool[]): OpenAITool[] {
  return tools.map(
    /**
     * 转换单个工具的声明字段。
     * @param tool - 待转换的项目工具。
     * @returns 保留参数结构原引用的 Responses 函数工具。
     */
    (tool: Tool): OpenAITool => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
      strict: false,
    }),
  );
}

/**
 * 读取 Responses 协议事件，累积文本和工具调用并校验结束状态。
 * @param openaiStream - 请求返回的 Responses 协议事件流。
 * @param output - 持续更新的助手消息，内容、响应标识及结束状态写入同一对象。
 * @param stream - 接收文本和工具调用的开始、增量与结束事件的事件流。
 * @returns Promise 完成后返回 stop、length 或 toolUse，供 runStream 发送 done 事件。
 * @throws 读取失败、协议错误、缺少终态事件、工具调用未结束或消息结束状态无效时拒绝 Promise。
 * @remarks
 * 按 output_index 关联内容块；内容完成事件保存文本签名或清理工具参数原文，本函数不发送 done 或 error。
 * length 允许保留未结束工具调用的部分参数，返回前移除内部原文，不补发工具结束事件。
 */
async function consumeCompletionStream(
  openaiStream: AsyncIterable<ResponseStreamEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<"stop" | "length" | "toolUse"> {
  let sawTerminalResponseEvent = false;
  const outputSlots = new Map<number, ResponsesOutputSlot>();
  /**
   * 根据消息项的最终回答阶段更新消息结束状态。
   * @param item - 当前处理的 Responses 输出项。
   */
  const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
    if (item.type === "message" && item.phase === "final_answer") {
      output.stopReason = "stop";
    }
  };
  /**
   * 按协议输出索引和内容类型获取已创建的槽位。
   * @param outputIndex - Responses 的输出项索引。
   * @param type - 调用方需要的槽位类型。
   * @returns 类型匹配的槽位；未创建或类型不符时返回 undefined。
   */
  const getSlot = <TType extends ResponsesOutputSlot["type"]>(
    outputIndex: number,
    type: TType,
  ): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
    const slot = outputSlots.get(outputIndex);
    return slot?.type === type
      ? (slot as Extract<ResponsesOutputSlot, { type: TType }>)
      : undefined;
  };
  /**
   * 为工具调用槽位发送参数增量事件。
   * @param slot - 接收参数增量的工具调用槽位。
   * @param delta - 参数原文增量；undefined 时不发送事件，空字符串仍会发送。
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
   * 为文本消息或函数调用创建内容块和槽位，并发送对应开始事件。
   * @param outputIndex - Responses 的输出项索引。
   * @param item - 接口返回的输出项。
   * @returns 新建的内容槽位；其他输出项类型返回 undefined。
   * @remarks 新内容块加入 output.content，槽位保存索引供后续增量和结束事件使用。
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
   * 根据终态响应更新响应标识、原始结束原因和项目消息状态。
   * @param response - 完成或未完成事件中携带的响应。
   * @remarks 标记已收到终态；正常完成且内容包含工具调用时改为 toolUse，并清除或更新错误说明。
   */
  const finalizeResponse = (
    response: Extract<
      ResponseStreamEvent,
      { type: "response.completed" | "response.incomplete" }
    >["response"],
  ): void => {
    sawTerminalResponseEvent = true;
    if (response?.id) {
      output.responseId = response.id;
    }

    const status = response?.status;
    const incompleteDetails = response?.incomplete_details as
      { reason?: unknown } | null | undefined;
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
    const hasToolCall = output.content.some(
      /**
       * 判断内容块是否为工具调用。
       * @param b - 助手消息中的文本或工具调用块。
       * @returns type 为 toolCall 时返回 true。
       */
      (b: TextContent | ToolCall): boolean => b.type === "toolCall",
    );
    if (hasToolCall && output.stopReason === "stop") {
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
        const texts = item.content?.map(
          /**
           * 提取完成消息中的回答或拒绝文本。
           * @param c - 已完成消息的文本或拒绝内容块。
           * @returns 该块的文本原文，后续直接拼接。
           */
          (c: ResponseOutputMessage["content"][number]): string =>
            c.type === "output_text" ? c.text : c.refusal,
        );
        slot.block.text = texts?.join("") || "";
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
      throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
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

  if (output.stopReason === "pending") {
    throw new Error("OpenAI Responses stream ended without a stop reason");
  }
  if (output.stopReason === "error") {
    throw new Error(output.errorMessage || "An unknown error occurred");
  }

  // 截断的工具调用可能没有收到输出项结束事件；保留部分参数，但不将内部拼接原文作为业务字段返回。
  for (const block of output.content) {
    if (block.type === "toolCall") {
      delete (block as StreamingToolCall).partialJson;
    }
  }

  return output.stopReason;
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
): { stopReason: StopReason; errorMessage?: string } {
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
