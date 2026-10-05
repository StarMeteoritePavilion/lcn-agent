import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Content,
  type Part,
  FinishReason,
  FunctionCallingConfigMode,
} from "@google/genai";
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

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

/** Google 请求选项，工具选择使用精确的字符串策略。 */
interface GoogleOptions extends StreamOptions {
  /** 可选的自动选择、禁用或要求函数调用策略。 */
  toolChoice?: "auto" | "none" | "any";
}
let toolCallCounter = 0;

/**
 * 创建助手消息事件流并启动 Google 流式生成请求。
 * @param model - 请求模型、接口地址及输出消息的来源标识。
 * @param context - 系统提示词、对话历史与可选工具声明。
 * @param options - 请求密钥、生成参数及工具选择方式。
 * @returns 可异步迭代内容事件，并通过 result() 等待最终助手消息的事件流。
 * @remarks 启动处理后立即返回；请求和响应处理失败时通过 error 事件返回错误消息，不在本模块执行工具。
 */
export function stream(
  model: Model<"google-generative-ai">,
  context: Context,
  options?: GoogleOptions,
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
 * @param options - 请求密钥、生成参数及工具选择方式。
 * @returns Promise 完成表示正常或错误结果已写入事件流。
 * @throws 错误处理自身失败时拒绝 Promise，例如非 Error 异常无法 JSON 序列化。
 * @remarks 请求成功后发送 start；响应处理成功后发送 done，失败时发送 error 并保留累计内容。
 */
async function runStream(
  model: Model<"google-generative-ai">,
  context: Context,
  stream: AssistantMessageEventStream,
  options?: GoogleOptions,
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
    const googleStream = await createCompletionStream(model, context, options);

    stream.push({ type: "start", partial: output });
    const stopReason = await consumeCompletionStream(googleStream, output, stream);

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
 * 校验密钥和 fetch 限制，并发起 Google 流式生成请求。
 * @param model - 请求模型、接口地址及供应商标识。
 * @param context - 系统提示词、历史消息及工具声明。
 * @param options - 请求密钥、生成参数及工具选择方式。
 * @returns Promise 完成后返回可异步迭代的 Google 响应流。
 * @throws 提供不同于全局 fetch 的自定义实现、密钥缺失、生成参数无效、客户端初始化失败或请求失败时拒绝 Promise。
 * @remarks 使用原有的空 apiVersion 配置；异常交由 runStream 处理。
 */
async function createCompletionStream(
  model: Model<"google-generative-ai">,
  context: Context,
  options?: GoogleOptions,
): Promise<AsyncIterable<GenerateContentResponse>> {
  if (options?.fetch && options.fetch !== globalThis.fetch) {
    throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
  }
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { baseUrl: model.baseUrl, apiVersion: "" },
  });

  const params = buildParams(model, context, options);
  return client.models.generateContentStream(params);
}

/**
 * 将模型、上下文和选项组装为 Google 内容生成参数。
 * @param model - 本次请求模型及历史消息签名转换使用的来源信息。
 * @param context - 系统提示词、历史消息与可选工具声明。
 * @param options - 可选生成参数和工具选择方式，密钥及 fetch 不写入请求体。
 * @returns 包含 model、contents 和 config 的生成参数，沿用现有消息及工具转换规则。
 * @throws maxTokens 不是非负有限整数、temperature 不是 0 到 2 之间的有限数值，或 toolChoice 不是支持的精确值时抛出异常。
 * @remarks temperature 和 maxTokens 只在不为 undefined 时设置并保留 0；不读取 model.maxTokens。
 */
function buildParams(
  model: Model<"google-generative-ai">,
  context: Context,
  options?: GoogleOptions,
): GenerateContentParameters {
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
  const toolChoice = options?.toolChoice;
  if (
    toolChoice !== undefined &&
    toolChoice !== "auto" &&
    toolChoice !== "none" &&
    toolChoice !== "any"
  ) {
    throw new Error("toolChoice 必须是 auto、none 或 any。");
  }
  return {
    model: model.id,
    contents: convertMessages(model, context),
    config: {
      ...(context.systemPrompt && { systemInstruction: context.systemPrompt }),
      ...(temperature !== undefined && { temperature }),
      ...(maxTokens !== undefined && { maxOutputTokens: maxTokens }),
      ...(context.tools?.length && { tools: convertTools(context.tools) }),
      ...(toolChoice && {
        toolConfig: { functionCallingConfig: { mode: mapToolChoice(toolChoice) } },
      }),
    },
  };
}

/**
 * 将用户、助手和工具结果历史转换为 Google 内容参数。
 * @param model - 本次请求模型及供应商，用于决定签名复用和工具调用标识的回传规则。
 * @param context - 按对话顺序排列的历史消息。
 * @returns 保持顺序的 user 和 model 内容项；没有有效内容时返回空数组。
 * @remarks 仅复用相同供应商和模型的有效签名；连续工具结果合并到同一 user 项，错误结果使用 error 字段。
 */
function convertMessages(model: Model<"google-generative-ai">, context: Context): Content[] {
  const contents: Content[] = [];
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts: Part[] =
        typeof msg.content === "string"
          ? [{ text: msg.content }]
          : msg.content.map(
              /**
               * 将用户文本块转换为 Google 文本片段。
               * @param item - 用户的文本内容块。
               * @returns 保留原文的文本片段。
               */
              (item: TextContent): Part => ({ text: item.text }),
            );
      if (parts.length > 0) {
        contents.push({ role: "user", parts });
      }
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
      for (const block of msg.content) {
        if (block.type === "text") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.textSignature,
          );
          if ((!block.text || block.text.trim() === "") && !thoughtSignature) {
            continue;
          }
          parts.push({ text: block.text, ...(thoughtSignature && { thoughtSignature }) });
        } else if (block.type === "toolCall") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.thoughtSignature,
          );
          parts.push({
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
            },
            ...(thoughtSignature && { thoughtSignature }),
          });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
    } else if (msg.role === "toolResult") {
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
      const functionResponsePart: Part = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: textResult } : { output: textResult },
          ...(requiresToolCallId(model.id) ? { id: msg.toolCallId } : {}),
        },
      };
      const lastContent = contents[contents.length - 1];
      if (
        lastContent?.role === "user" &&
        lastContent.parts?.some(
          /**
           * 判断片段是否已包含工具结果。
           * @param p - 最后一项用户内容中的片段。
           * @returns functionResponse 为真值时返回 true。
           */
          (p: Part): boolean => Boolean(p.functionResponse),
        )
      ) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({ role: "user", parts: [functionResponsePart] });
      }
    }
  }
  return contents;
}

/**
 * 按来源一致性和签名格式决定是否回传思考签名。
 * @param isSameProviderAndModel - 历史消息与当前请求是否使用相同供应商和模型。
 * @param signature - 历史内容块保存的签名。
 * @returns 来源一致且格式有效时返回原签名，否则返回 undefined。
 */
function resolveThoughtSignature(
  isSameProviderAndModel: boolean,
  signature: string | undefined,
): string | undefined {
  return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * 检查签名是否满足当前 Base64 格式规则。
 * @param signature - 待检查的签名字符串。
 * @returns 非空、长度为 4 的倍数且匹配 base64SignaturePattern 时返回 true。
 * @remarks 仅检查字符形式，不解码签名或验证服务端真实性。
 */
function isValidThoughtSignature(signature: string | undefined): boolean {
  if (!signature) {
    return false;
  }
  if (signature.length % 4 !== 0) {
    return false;
  }
  return base64SignaturePattern.test(signature);
}

/**
 * 按现有模型标识规则判断是否回传工具调用标识。
 * @param modelId - 请求使用的原始模型标识。
 * @returns claude-、gpt-oss- 前缀或 Gemini 主版本不低于 3 时返回 true。
 */
function requiresToolCallId(modelId: string): boolean {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    (geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
  );
}

/**
 * 按现有 Gemini 标识正则读取主版本号。
 * @param modelId - 需要检查的模型标识。
 * @returns 匹配到的十进制主版本；未匹配时返回 undefined。
 * @remarks 沿用原实现的内部小写匹配规则，不修改发送给接口的原始标识。
 */
function getGeminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
  if (!match) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * 将项目工具声明转换为 Google 函数声明列表。
 * @param tools - 工具名称、用途和参数结构列表。
 * @returns 包含 functionDeclarations 的工具列表；没有工具时返回 undefined。
 */
function convertTools(
  tools: Tool[],
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map(
        /**
         * 将单个工具声明转换为 Google 函数声明。
         * @param tool - 待转换的项目工具。
         * @returns 名称、说明和保留原引用的 parametersJsonSchema。
         */
        (tool: Tool): Record<string, unknown> => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.parameters,
        }),
      ),
    },
  ];
}

/**
 * 将项目工具选择字符串映射为 SDK 函数调用模式。
 * @param choice - auto、none、any 或其他运行时字符串。
 * @returns 对应的函数调用模式；其他字符串沿用原规则返回 AUTO。
 */
function mapToolChoice(choice: string): FunctionCallingConfigMode {
  switch (choice) {
    case "auto":
      return FunctionCallingConfigMode.AUTO;
    case "none":
      return FunctionCallingConfigMode.NONE;
    case "any":
      return FunctionCallingConfigMode.ANY;
    default:
      return FunctionCallingConfigMode.AUTO;
  }
}

/**
 * 读取 Google 首项响应，累积文本和工具调用并校验结束状态。
 * @param googleStream - 请求返回的 Google 内容生成响应流。
 * @param output - 持续更新的助手消息，内容、响应标识和结束状态写入同一对象。
 * @param stream - 接收文本和工具调用的开始、增量及结束事件的事件流。
 * @returns Promise 完成后返回 stop、length 或 toolUse，供 runStream 发送 done 事件。
 * @throws 读取失败、结束原因不受支持、未收到结束原因或结束状态为 error 时拒绝 Promise。
 * @remarks 忽略 thought 为 true 的文本片段，保留普通文本及工具调用的思考签名；工具调用会结束当前文本块，后续文本另建内容块。
 */
async function consumeCompletionStream(
  googleStream: AsyncIterable<GenerateContentResponse>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): Promise<"stop" | "length" | "toolUse"> {
  let currentBlock: TextContent | null = null;
  const blocks = output.content;
  /**
   * 获取当前最后一个内容块的本地索引。
   * @returns 从 0 开始的最后一项索引，内容为空时返回 -1。
   */
  const blockIndex = (): number => blocks.length - 1;
  for await (const chunk of googleStream) {
    output.responseId ||= chunk.responseId;
    const firstChoice = chunk.candidates?.[0];
    if (firstChoice?.content?.parts) {
      for (const part of firstChoice.content.parts) {
        if (part.text !== undefined && part.thought !== true) {
          if (!currentBlock) {
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
          }
          currentBlock.text += part.text;
          currentBlock.textSignature = retainThoughtSignature(
            currentBlock.textSignature,
            part.thoughtSignature,
          );
          stream.push({
            type: "text_delta",
            contentIndex: blockIndex(),
            delta: part.text,
            partial: output,
          });
        }
        if (part.functionCall) {
          if (currentBlock) {
            stream.push({
              type: "text_end",
              contentIndex: blockIndex(),
              content: currentBlock.text,
              partial: output,
            });
            currentBlock = null;
          }
          const providedId = part.functionCall.id;
          const needsNewId =
            !providedId ||
            output.content.some(
              /**
               * 判断接口给出的工具标识是否已被使用。
               * @param b - 助手消息中的文本或工具调用块。
               * @returns 当前工具调用块使用 providedId 时返回 true。
               */
              (b: TextContent | ToolCall): boolean => b.type === "toolCall" && b.id === providedId,
            );
          const toolCallId = needsNewId
            ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
            : providedId;
          const toolCall: ToolCall = {
            type: "toolCall",
            id: toolCallId,
            name: part.functionCall.name || "",
            arguments: part.functionCall.args ?? {},
            ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
          };
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: JSON.stringify(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall,
            partial: output,
          });
        }
      }
    }
    if (firstChoice?.finishReason) {
      output.rawStopReason = firstChoice.finishReason;
      output.stopReason = mapStopReason(firstChoice.finishReason);
      const hasToolCall = output.content.some(
        /**
         * 判断生成内容是否包含工具调用。
         * @param b - 助手消息中的文本或工具调用块。
         * @returns 内容块类型为 toolCall 时返回 true。
         */
        (b: TextContent | ToolCall): boolean => b.type === "toolCall",
      );
      if (hasToolCall && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }
    }
  }
  if (currentBlock) {
    stream.push({
      type: "text_end",
      contentIndex: blockIndex(),
      content: currentBlock.text,
      partial: output,
    });
  }

  if (output.stopReason === "pending") {
    throw new Error("Google stream ended without a finish reason");
  }
  if (output.stopReason === "error") {
    throw new Error(
      output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "Unknown error",
    );
  }

  return output.stopReason;
}

/**
 * 优先保留本次收到的非空签名，否则沿用已有签名。
 * @param existing - 当前文本块已保存的签名。
 * @param incoming - 当前片段提供的可选签名。
 * @returns 本次非空签名或已有签名；两者均未提供时返回 undefined。
 * @remarks 生成响应中的签名按原文保存，历史回传时另行检查格式。
 */
function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) {
    return incoming;
  }
  return existing;
}

/**
 * 将 Google 的生成结束原因映射为项目消息状态。
 * @param reason - SDK 定义的生成结束原因。
 * @returns STOP 和 CONTINUATION 映射为 stop，MAX_TOKENS 映射为 length，其他已列出的原因映射为 error。
 * @throws reason 不属于当前 SDK 定义的结束原因时抛出异常。
 */
function mapStopReason(reason: FinishReason): StopReason {
  switch (reason) {
    case FinishReason.STOP:
    case FinishReason.CONTINUATION:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "length";
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.SAFETY:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_OTHER:
    case FinishReason.RECITATION:
    case FinishReason.FINISH_REASON_UNSPECIFIED:
    case FinishReason.OTHER:
    case FinishReason.LANGUAGE:
    case FinishReason.MALFORMED_FUNCTION_CALL:
    case FinishReason.UNEXPECTED_TOOL_CALL:
    case FinishReason.TOO_MANY_TOOL_CALLS:
    case FinishReason.NO_IMAGE:
      return "error";
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unhandled stop reason: ${_exhaustive}`);
    }
  }
}
