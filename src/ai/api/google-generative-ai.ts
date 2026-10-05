import {
  type Content,
  FinishReason,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  GoogleGenAI,
  type Part,
} from "@google/genai";
import type {
  AssistantMessage,
  ImageContent,
  Model,
  ProviderHeaders,
  StreamFunction,
  StreamOptions,
  StopReason,
  TextContent,
  ToolCall,
  Context,
  Tool,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";

import { transformMessages } from "./transform-messages.ts";
import { validateStreamOptions } from "../utils/validation.ts";
export interface GoogleOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
}
let toolCallCounter = 0;
/**
 * 创建助手消息事件流并启动协议请求。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @returns 立即返回可异步迭代内容事件并通过 result() 等待最终消息的事件流。
 * @remarks 请求校验、网络和协议处理失败通过 error 事件返回；不执行工具，不自动续写或重试，partial 与最终消息共享引用。
 */
export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
  model: Model<"google-generative-ai">,
  context: Context,
  options?: GoogleOptions,
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
        if (options?.fetch && options.fetch !== globalThis.fetch) {
          throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
        }
        const apiKey = options?.apiKey;
        if (typeof apiKey !== "string" || !apiKey.trim()) {
          throw new Error(`No API key for provider: ${model.provider}`);
        }
        const client = createClient(model, apiKey, options?.headers);
        const params = buildParams(model, context, options);
        const googleStream = await client.models.generateContentStream(params);
        stream.push({ type: "start", partial: output });
        let currentBlock: TextContent | null = null;
        const blocks = output.content;
        /**
         * 读取当前内容块在输出消息中的索引。
         * @returns 最后一个内容块从 0 开始的索引，空数组返回 -1。
         */
        const blockIndex = (): number => blocks.length - 1;
        for await (const chunk of googleStream) {
          output.responseId ||= chunk.responseId;
          const responseChoice = chunk.candidates?.[0];
          if (responseChoice?.content?.parts) {
            for (const part of responseChoice.content.parts) {
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
                     * 检查工具标识是否已出现在输出消息中。
                     * @param b - 当前需要检查的协议内容块。
                     * @returns 存在相同标识的工具调用时返回 true。
                     */
                    (b: TextContent | ToolCall): boolean =>
                      b.type === "toolCall" && b.id === providedId,
                  );
                const toolCallId = needsNewId
                  ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                  : providedId;
                const toolCall: ToolCall = {
                  type: "toolCall",
                  id: toolCallId,
                  name: part.functionCall.name || "",
                  arguments: (part.functionCall.args as Record<string, any>) ?? {},
                  ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
                };
                output.content.push(toolCall);
                stream.push({
                  type: "toolcall_start",
                  contentIndex: blockIndex(),
                  partial: output,
                });
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
          if (responseChoice?.finishReason) {
            output.rawStopReason = responseChoice.finishReason;
            output.stopReason = mapStopReason(responseChoice.finishReason);
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
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          const errorMessage = output.rawStopReason
            ? `Provider stopped with: ${output.rawStopReason}`
            : "An unknown error occurred";
          throw new Error(errorMessage);
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        for (const block of output.content) {
          if ("index" in block) {
            delete (
              block as {
                index?: number;
              }
            ).index;
          }
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
 * 创建使用显式密钥和请求头的 Google 客户端。
 * @param model - 本次请求的模型配置。
 * @param apiKey - 本次请求的显式密钥。
 * @param optionsHeaders - 覆盖模型默认请求头的请求选项，null 值交由 SDK 处理。
 * @returns 本次请求使用的新 GoogleGenAI 客户端。
 * @throws SDK 初始化失败时抛出异常。
 * @remarks 显式 baseUrl 同时使用空 apiVersion，请求选项头覆盖模型同名请求头；Google 请求不支持自定义 fetch。
 */
function createClient(
  model: Model<"google-generative-ai">,
  apiKey?: string,
  optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
  const httpOptions: {
    baseUrl?: string;
    apiVersion?: string;
    headers?: Record<string, string>;
  } = {};
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl;
    httpOptions.apiVersion = "";
  }
  const headers = providerHeadersToRecord(model.headers, optionsHeaders);
  if (headers) {
    httpOptions.headers = headers;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
  });
}
/**
 * 将对话历史、工具声明和生成选项组装为 Google 请求参数。
 * @param model - 本次请求的模型配置。
 * @param context - 系统提示词、历史消息和工具声明。
 * @param options - 可选的认证、生成参数和工具选择配置。
 * @returns 含模型标识、转换后消息及请求配置的参数。
 * @throws 工具选择不属于 auto、none 或 any 时抛出异常。
 * @remarks 工具参数使用 parametersJsonSchema 保留结构；没有工具时不发送工具声明和选择模式。
 */
function buildParams(
  model: Model<"google-generative-ai">,
  context: Context,
  options: GoogleOptions = {},
): GenerateContentParameters {
  const toolChoice = options.toolChoice;
  if (
    toolChoice !== undefined &&
    toolChoice !== "auto" &&
    toolChoice !== "none" &&
    toolChoice !== "any"
  ) {
    throw new Error("toolChoice 必须是 auto、none 或 any。");
  }
  const contents = convertMessages(model, context);
  const currentTools = context.tools ?? [];
  const generationConfig: GenerateContentConfig = {};
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }
  const functionCallingMode =
    currentTools.length > 0
      ? options.toolChoice
        ? mapToolChoice(options.toolChoice)
        : undefined
      : undefined;
  const systemInstruction = context.systemPrompt ?? "";
  const config: GenerateContentConfig = {
    ...(Object.keys(generationConfig).length > 0 && generationConfig),
    ...(systemInstruction && { systemInstruction: systemInstruction }),
    ...(functionCallingMode !== undefined && {
      toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
    }),
  };
  if (currentTools.length > 0) {
    config.tools = [
      {
        functionDeclarations: currentTools.map(
          /**
           * 将项目工具转换为 Google SDK 函数声明。
           * @param tool - 工具的名称、描述及参数结构。
           * @returns 保留参数结构的函数声明。
           */
          (tool: Tool): FunctionDeclaration => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
          }),
        ),
      },
    ];
  }
  const params: GenerateContentParameters = {
    model: model.id,
    contents,
    config,
  };
  return params;
}

type GoogleApiType = "google-generative-ai" | "google-vertex";
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
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
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
 * 按现有模型标识规则检查工具结果的图文支持。
 * @param modelId - 请求使用的原始模型标识。
 * @returns Gemini 主版本不低于 3 或非 Gemini 标识时返回 true。
 * @remarks 沿用当前版本判断规则，不修改请求发送的模型标识。
 */
function supportsMultimodalFunctionResponse(modelId: string): boolean {
  const geminiMajorVersion = getGeminiMajorVersion(modelId);
  if (geminiMajorVersion !== undefined) {
    return geminiMajorVersion >= 3;
  }
  return true;
}
/**
 * 将用户、助手和工具结果历史转换为 Google 内容参数。
 * @param model - 本次请求模型及供应商，用于决定签名复用和工具调用标识的回传规则。
 * @param context - 按对话顺序排列的历史消息。
 * @returns 保持顺序的 user 和 model 内容项；没有有效内容时返回空数组。
 * @remarks 仅复用相同供应商和模型的有效签名；连续工具结果合并到同一 user 项，错误结果使用 error 字段。
 */
function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
  const contents: Content[] = [];
  const transformedMessages = transformMessages(context.messages, model);
  for (const msg of transformedMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        contents.push({
          role: "user",
          parts: [{ text: msg.content }],
        });
      } else {
        const parts: Part[] = msg.content.map(
          /**
           * 将用户文本或图片转换为协议内容块。
           * @param item - 用户消息中的文本或图片内容块。
           * @returns 保留原文或图片数据的协议内容块。
           */
          (item: TextContent | ImageContent): Part => {
            if (item.type === "text") {
              return { text: item.text };
            } else {
              return {
                inlineData: {
                  mimeType: item.mimeType,
                  data: item.data,
                },
              };
            }
          },
        );
        if (parts.length === 0) {
          continue;
        }
        contents.push({
          role: "user",
          parts,
        });
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
          parts.push({
            text: block.text,
            ...(thoughtSignature && { thoughtSignature }),
          });
        } else if (block.type === "toolCall") {
          const thoughtSignature = resolveThoughtSignature(
            isSameProviderAndModel,
            block.thoughtSignature,
          );
          const part: Part = {
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              ...(requiresToolCallId(model.id) ? { id: block.id } : {}),
            },
            ...(thoughtSignature && { thoughtSignature }),
          };
          parts.push(part);
        }
      }
      if (parts.length === 0) {
        continue;
      }
      contents.push({
        role: "model",
        parts,
      });
    } else if (msg.role === "toolResult") {
      const textContent = msg.content.filter(
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
      const imageContent = model.input.includes("image")
        ? msg.content.filter(
            /**
             * 检查内容块是否为图片。
             * @param c - 待检查或提取原文的内容块。
             * @returns type 为 image 时返回 true。
             */
            (c: TextContent | ImageContent): c is ImageContent => c.type === "image",
          )
        : [];
      const hasText = textResult.length > 0;
      const hasImages = imageContent.length > 0;
      const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);
      const responseValue = hasText ? textResult : hasImages ? "(see attached image)" : "";
      const imageParts: Part[] = imageContent.map(
        /**
         * 将工具结果图片转换为 Google 内联图片片段。
         * @param imageBlock - 工具结果中的图片媒体类型和 Base64 数据。
         * @returns 保留媒体类型和 Base64 数据的图片片段。
         */
        (imageBlock: ImageContent): Part => ({
          inlineData: {
            mimeType: imageBlock.mimeType,
            data: imageBlock.data,
          },
        }),
      );
      const includeId = requiresToolCallId(model.id);
      const functionResponsePart: Part = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseValue } : { output: responseValue },
          ...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
          ...(includeId ? { id: msg.toolCallId } : {}),
        },
      };
      const lastContent = contents[contents.length - 1];
      if (
        lastContent?.role === "user" &&
        lastContent.parts?.some(
          /**
           * 检查 Google 内容片段是否含工具结果。
           * @param p - 需要检查的 Google 内容片段。
           * @returns 存在函数响应时返回 true。
           */
          (p: Part): boolean => p.functionResponse !== undefined,
        )
      ) {
        lastContent.parts.push(functionResponsePart);
      } else {
        contents.push({
          role: "user",
          parts: [functionResponsePart],
        });
      }
      if (hasImages && !modelSupportsMultimodalFunctionResponse) {
        contents.push({
          role: "user",
          parts: [{ text: "Tool result image:" }, ...imageParts],
        });
      }
    }
  }
  return contents;
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
