import type { TSchema } from "typebox";

/** 当前支持的模型接口类型。 */
export type Api =
  "openai-completions" | "anthropic-messages" | "openai-responses" | "google-generative-ai";

/** 模型标识、接口类型及服务提供方配置；TApi 用于限定支持的接口类型。 */
export interface Model<TApi extends Api = Api> {
  /** 发送给接口的模型标识。 */
  id: string;
  /** 模型使用的接口类型。 */
  api: TApi;
  /** 服务提供方标识，用于输出消息的来源信息及错误提示。 */
  provider: string;
  /** 传入接口客户端的基础地址。 */
  baseUrl: string;
  /** 运行时必填的模型默认生成令牌上限；仅 Anthropic 未设置 options.maxTokens 时使用，其他协议不读取此字段。 */
  maxTokens: number;
}

/** 流式请求的认证、生成参数及网络请求选项。 */
export interface StreamOptions {
  /** API 密钥；类型允许省略，但各协议的请求实现均要求提供密钥，Anthropic 另行拒绝纯空白字符串。 */
  apiKey?: string;
  /** 本次生成的非负有限整数令牌上限；Anthropic 发送 max_tokens，缺省用模型值并保留 0；Google 发送 maxOutputTokens 并保留 0；Chat Completions 发送 max_completion_tokens；Responses 发送 max_output_tokens 且正值至少为 16；后两者省略或为 0 时不设置。 */
  maxTokens?: number;
  /** 生成温度，必须为 0 到 2 之间的有限数值；省略时不设置请求参数，显式传入 0 时会保留。 */
  temperature?: number;
  /** 自定义请求实现；Google 仅允许省略或传入当前全局 fetch，其他协议支持独立实现。 */
  fetch?: typeof globalThis.fetch;
}

/** 用户或助手消息中的文本内容块。 */
export interface TextContent {
  /** 文本内容块的类型标识。 */
  type: "text";
  /** 文本原文；允许为空字符串。 */
  text: string;
  /** Responses 保存消息项标识与可选 phase 的 JSON 签名，也接受旧版纯字符串；Google 保存原始思考签名，历史回传需来源一致且格式有效。 */
  textSignature?: string;
}

/** 模型请求执行的工具调用；参数由响应解析得到，执行前仍需按工具声明校验。 */
export interface ToolCall {
  /** 工具调用内容块的类型标识。 */
  type: "toolCall";
  /** 用于关联 ToolResultMessage.toolCallId；Responses 使用 call_id|输出项id，Google 缺失或重复时生成本地标识，Chat Completions 流式开始时可能为空字符串。 */
  id: string;
  /** 模型选择的工具名称，用于与 Tool.name 精确匹配；流式开始时可能尚未收到。 */
  name: string;
  /** 已解析的工具参数；流式处理中可能不完整或回退为空对象，类型声明不代表已通过运行时校验。 */
  arguments: Record<string, unknown>;
  /** Google 工具调用的原始思考签名；历史回传时检查供应商、模型及 Base64 字符形式。 */
  thoughtSignature?: string;
}

/** 向模型声明的工具名称、用途和 TypeBox 参数结构；不包含工具执行函数。 */
export interface Tool<TParameters extends TSchema = TSchema> {
  /** 工具名称，调用校验按原字符串精确匹配；当前校验器选择首个同名声明。 */
  name: string;
  /** 发送给模型的工具用途说明。 */
  description: string;
  /** 发送给模型并用于本地校验的参数结构；TParameters 保留具体结构类型。 */
  parameters: TParameters;
}

/** 用户输入消息及其时间信息。 */
export interface UserMessage {
  /** 用户消息的角色标识。 */
  role: "user";
  /** 用户输入的完整字符串或按顺序排列的文本块。 */
  content: string | TextContent[];
  /** 消息的时间戳；当前请求转换不读取或发送此字段。 */
  timestamp: number;
}

/** 调用方执行工具后写入对话历史的结果消息，用调用标识关联助手的工具调用。 */
export interface ToolResultMessage {
  /** 工具结果的角色标识；Chat Completions 转为 tool，Responses 转为 function_call_output，Anthropic 转为 user 中的 tool_result，Google 转为 user 中的 functionResponse。 */
  role: "toolResult";
  /** 对应 ToolCall.id；Chat Completions 转为 tool_call_id，Anthropic 转为 tool_use_id，Responses 取 call_id，Google 按模型规则决定是否发送 functionResponse.id。 */
  toolCallId: string;
  /** 已执行的工具名称；Google 发送为 functionResponse.name，其他协议不发送此字段。 */
  toolName: string;
  /** 工具输出文本块；发送时以换行连接，OpenAI 的空结果使用 (no tool output) 占位，Anthropic 和 Google 保留空字符串。 */
  content: TextContent[];
  /** 工具执行是否失败；Anthropic 发送为 is_error，Google 据此选用 response.error 或 response.output，OpenAI 不发送此字段。 */
  isError: boolean;
  /** 工具结果的时间戳；当前示例使用毫秒值，请求转换不读取或发送此字段。 */
  timestamp: number;
}

/**
 * 助手消息的处理和结束状态。
 * @remarks
 * pending 为处理中；stop 为正常结束；length 为达到令牌数上限，内容可能被截断。
 * toolUse 表示接口结束原因为工具调用，调用方仍需检查内容并执行工具；error 为请求或响应处理失败。
 */
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error";

/** 助手生成的文本、工具调用、来源信息及处理状态；流式处理持续更新同一消息对象。 */
export interface AssistantMessage {
  /** 助手消息的角色标识。 */
  role: "assistant";
  /** 按内容块首次创建顺序排列的文本与工具调用；不同分片可继续更新已有块，尚无内容时为空数组。 */
  content: (TextContent | ToolCall)[];
  /** 生成消息使用的接口类型。 */
  api: Api;
  /** 生成消息的服务提供方标识。 */
  provider: string;
  /** 生成消息使用的模型标识。 */
  model: string;
  /** Responses 或 Google 的响应标识；Google 保留首个非空标识，其他协议或未收到时不设置，不作为历史请求参数发送。 */
  responseId?: string;
  /** 当前处理状态；length 表示文本可能被截断，不保证内容完整。 */
  stopReason: StopReason;
  /** 接口返回的原始非空结束原因；尚未收到时不设置，多个结束原因以最后一次为准。 */
  rawStopReason?: string;
  /** 请求或响应处理的错误说明；未记录错误时不设置。 */
  errorMessage?: string;
  /** 创建助手输出消息时的 Unix 时间戳，单位为毫秒，不随文本更新。 */
  timestamp: number;
}

/** 对话历史中的用户消息、助手消息或工具执行结果。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 发起模型请求时使用的系统提示词、对话历史和工具声明。 */
export interface Context {
  /** 系统提示词；OpenAI 添加 system 消息，Anthropic 设置 system 参数，Google 设置 systemInstruction；省略或为空字符串时均不发送。 */
  systemPrompt?: string;
  /** 按发送顺序排列的历史消息；允许为空数组。 */
  messages: Message[];
  /** 可供模型选择的工具声明；省略或为空数组时不设置请求的 tools 字段，也不会自动执行工具。 */
  tools?: Tool[];
}

/**
 * 助手消息生成过程中的开始、文本及工具调用增量、内容结束与请求结束事件。
 * @remarks
 * partial、message 和 error 均引用消息对象，不是副本；partial 指向的对象会随后续处理更新。
 * contentIndex 为文本块或工具调用块在 partial.content 中从 0 开始的索引，不是接口的工具调用 index。
 * 内容块结束事件只表示对应块结束，不保证工具参数有效或整个请求成功；模型请求模块不执行工具。
 * Chat Completions 在响应流读取完毕后发送内容结束事件，Anthropic 在 content_block_stop 时发送，Responses 在 response.output_item.done 时发送。
 * Google 在遇到工具调用或响应流读取完毕时结束文本块，完整工具调用收到后立即发送其开始、增量和结束事件。
 * done 和 error 是终结事件，均用于完成事件流的 result()；错误结果通过消息返回。
 */
export type AssistantMessageEvent =
  | {
      /** 已成功获得接口响应流，开始处理助手消息。 */
      type: "start";
      /** 持续更新的助手消息。 */
      partial: AssistantMessage;
    }
  | {
      /** 已创建用于累积文本的内容块。 */
      type: "text_start";
      /** 新文本块在消息内容中的索引，从 0 开始。 */
      contentIndex: number;
      /** 持续更新的助手消息。 */
      partial: AssistantMessage;
    }
  | {
      /** 已将本次文本增量加入内容块。 */
      type: "text_delta";
      /** 接收增量的文本块索引，从 0 开始。 */
      contentIndex: number;
      /** 本次新增文本，不包含该块此前累积的内容。 */
      delta: string;
      /** 已包含本次增量、仍会继续更新的助手消息。 */
      partial: AssistantMessage;
    }
  | {
      /** 对应文本块结束；后续仍可能因响应读取、工具块处理或结束原因校验失败而发送 error。 */
      type: "text_end";
      /** 已结束文本块的索引，从 0 开始。 */
      contentIndex: number;
      /** 对应文本块的累计文本；length 结束时可能被截断。 */
      content: string;
      /** 当前助手消息，其结束状态仍可能在后续校验中更新。 */
      partial: AssistantMessage;
    }
  | {
      /** 已创建工具调用块，其名称、标识和参数可能尚不完整。 */
      type: "toolcall_start";
      /** 新工具调用块在消息内容中的索引，从 0 开始。 */
      contentIndex: number;
      /** 持续更新的助手消息。 */
      partial: AssistantMessage;
    }
  | {
      /** 已处理一个工具调用分片，并按需更新标识、名称或参数。 */
      type: "toolcall_delta";
      /** 被更新的工具调用块索引，从 0 开始。 */
      contentIndex: number;
      /** 参数原文增量；Google 为完整参数的 JSON 字符串，其他协议可为不完整片段，仅提供标识或名称时可为空字符串。 */
      delta: string;
      /** 包含当前工具参数解析结果、仍会继续更新的助手消息。 */
      partial: AssistantMessage;
    }
  | {
      /** 对应工具调用块结束；此时尚未执行工具或校验参数，整个请求仍可能失败。 */
      type: "toolcall_end";
      /** 已结束工具调用块在消息内容中的索引，从 0 开始。 */
      contentIndex: number;
      /** 去除内部拼接字段后的工具调用对象；Google 参数来自结构化响应，其他协议容错解析，均不保证符合工具声明。 */
      toolCall: ToolCall;
      /** 当前助手消息，结束状态仍可能因后续校验失败而更新。 */
      partial: AssistantMessage;
    }
  | {
      /** 接口响应处理成功结束；包含工具调用时仍需由调用方执行工具。 */
      type: "done";
      /** stop 为正常结束，length 为达到令牌数上限，toolUse 为工具调用结束。 */
      reason: "stop" | "length" | "toolUse";
      /** 包含累计文本和工具调用的最终助手消息，作为 result() 的结果。 */
      message: AssistantMessage;
    }
  | {
      /** 请求或响应处理失败，事件流结束。 */
      type: "error";
      /** 失败的结束状态。 */
      reason: "error";
      /** 携带错误说明及已累积文本、工具调用的助手消息，作为最终结果返回。 */
      error: AssistantMessage;
    };
