import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";
import type { TSchema } from "typebox";
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";
export type KnownApi =
  "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type Api = KnownApi | (string & {});
type KnownProvider = "anthropic" | "google" | "openai" | "deepseek";

type ProviderId = KnownProvider | string;

export type ProviderHeaders = Record<string, string | null>;
type FetchFunction = typeof globalThis.fetch;
interface ProviderRequestOptions {
  apiKey?: string;
  fetch?: FetchFunction;
  headers?: ProviderHeaders;
}
export interface StreamOptions extends ProviderRequestOptions {
  temperature?: number;
  maxTokens?: number;
}
interface ApiOptionsMap {
  "anthropic-messages": AnthropicOptions;
  "openai-completions": OpenAICompletionsOptions;
  "openai-responses": OpenAIResponsesOptions;
  "google-generative-ai": GoogleOptions;
}
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
  ? ApiOptionsMap[TApi]
  : StreamOptions & Record<string, unknown>;
/**
 * 按具体协议发起请求并立即提供助手事件流的函数签名。
 * @param model - 使用该协议的模型配置。
 * @param context - 对话历史及工具声明。
 * @param options - 协议支持的认证和生成选项。
 * @returns 可异步迭代并等待最终消息的助手事件流。
 */
export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;
export interface TextSignatureV1 {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
  thoughtSignature?: string;
  namespace?: string;
}
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = {
  [key: string]: JsonValue;
};
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue]
  ? [JsonValue] extends [T]
    ? true
    : false
  : false;
type IsJsonProperty<T> =
  IsAny<T> extends true
    ? false
    : unknown extends T
      ? false
      : [Exclude<T, undefined>] extends [never]
        ? true
        : IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
  [TKey in keyof T]-?: TKey extends string | number
    ? IsJsonProperty<T[TKey]> extends true
      ? never
      : TKey
    : TKey;
}[keyof T];
type IsJsonCompatible<T> =
  IsAny<T> extends true
    ? false
    : unknown extends T
      ? false
      : IsExactlyJsonValue<T> extends true
        ? true
        : T extends null | boolean | number | string
          ? true
          : T extends undefined
            ? false
            : T extends readonly (infer TItem)[]
              ? IsJsonCompatible<TItem>
              : T extends (...args: never[]) => unknown
                ? false
                : T extends object
                  ? [InvalidJsonKeys<T>] extends [never]
                    ? true
                    : false
                  : false;
type JsonRepresentation<T> =
  IsAny<T> extends true
    ? JsonValue
    : unknown extends T
      ? JsonValue
      : [T] extends [JsonValue]
        ? T
        : T extends readonly unknown[]
          ? {
              [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>>;
            }
          : T extends object
            ? {
                [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>>;
              }
            : never;
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  responseModel?: string;
  responseId?: string;
  stopReason: StopReason;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}
interface NestedToolCallRecord {
  id: string;
  name: string;
  arguments?: JsonObject;
  argumentsBytes?: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}
interface NestedToolCalls {
  calls: NestedToolCallRecord[];
  complete: boolean;
}
export type ToolResultMessage<TDetails = JsonValue> =
  IsJsonCompatible<TDetails> extends true
    ? {
        role: "toolResult";
        toolCallId: string;
        toolName: string;
        content: (TextContent | ImageContent)[];
        details?: JsonRepresentation<TDetails>;
        nestedCalls?: NestedToolCalls;
        isError: boolean;
        timestamp: number;
      }
    : never;
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
export type AssistantMessageEvent =
  | {
      type: "start";
      partial: AssistantMessage;
    }
  | {
      type: "text_start";
      contentIndex: number;
      partial: AssistantMessage;
    }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_start";
      contentIndex: number;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      error: AssistantMessage;
    };
export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsFinishReason?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
}
export interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;
  supportsMaxOutputTokens?: boolean;
}
export interface AnthropicMessagesCompat {
  supportsEagerToolInputStreaming?: boolean;
  supportsTemperature?: boolean;
}

interface ModelImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}
interface ModelImageInputLimits {
  resize?: ModelImageResizeOptions;
  maxPerMessage?: number;
  maxPerRequest?: number;
}
interface ModelInputLimits {
  maxRequestBytes?: number;
  images?: ModelImageInputLimits;
}
interface BaseModel<TApi extends string> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  input: ("text" | "image")[];
  inputLimits?: ModelInputLimits;
  headers?: Record<string, string>;
}
export interface Model<TApi extends Api> extends BaseModel<TApi> {
  type?: "chat";
  contextWindow: number;
  maxTokens: number;
  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends "openai-responses"
      ? OpenAIResponsesCompat
      : TApi extends "anthropic-messages"
        ? AnthropicMessagesCompat
        : never;
}
