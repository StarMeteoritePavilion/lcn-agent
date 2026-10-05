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
  /** 模型的最大令牌数配置；当前 OpenAI 请求构建不读取此字段。 */
  maxTokens: number;
}

/** 流式请求的认证、生成参数及网络请求选项。 */
export interface StreamOptions {
  /** API 密钥；类型允许省略，但当前 OpenAI 请求实现要求非空密钥。 */
  apiKey?: string;
  /** 本次生成的令牌数上限，必须为非负有限整数；当前作为 max_completion_tokens 发送，省略或为 0 时不设置。 */
  maxTokens?: number;
  /** 生成温度，必须为 0 到 2 之间的有限数值；省略时不设置请求参数，显式传入 0 时会保留。 */
  temperature?: number;
  /** 自定义请求实现；省略时由 OpenAI 客户端使用全局 fetch。 */
  fetch?: typeof globalThis.fetch;
}

/** 用户或助手消息中的文本内容块。 */
export interface TextContent {
  /** 文本内容块的类型标识。 */
  type: "text";
  /** 文本原文；允许为空字符串。 */
  text: string;
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

/** 当前支持的模型接口类型。 */
export type Api = "openai-completions";

/** 消息状态：pending 为处理中，stop 为正常结束，length 为达到令牌数上限，error 为处理失败。 */
export type StopReason = "pending" | "stop" | "length" | "error";

/** 助手生成的文本、来源信息及处理状态；流式生成期间会持续更新同一消息对象。 */
export interface AssistantMessage {
  /** 助手消息的角色标识。 */
  role: "assistant";
  /** 按生成顺序排列的文本块；尚无文本或未生成文本时为空数组。 */
  content: TextContent[];
  /** 生成消息使用的接口类型。 */
  api: Api;
  /** 生成消息的服务提供方标识。 */
  provider: string;
  /** 生成消息使用的模型标识。 */
  model: string;
  /** 当前处理状态；length 表示文本可能被截断，不保证内容完整。 */
  stopReason: StopReason;
  /** 接口返回的原始非空结束原因；尚未收到时不设置，多个结束原因以最后一次为准。 */
  rawStopReason?: string;
  /** 请求或响应处理的错误说明；未记录错误时不设置。 */
  errorMessage?: string;
  /** 创建助手输出消息时的 Unix 时间戳，单位为毫秒，不随文本更新。 */
  timestamp: number;
}

/** 对话历史中的用户消息或助手消息。 */
export type Message = UserMessage | AssistantMessage;

/** 发起模型请求时使用的系统提示词和对话历史。 */
export interface Context {
  /** 系统提示词；当前请求转换在省略或为空字符串时不添加 system 消息。 */
  systemPrompt?: string;
  /** 按发送顺序排列的历史消息；允许为空数组。 */
  messages: Message[];
}

/**
 * 助手消息生成过程中的开始、文本增量及结束事件。
 * @remarks
 * partial、message 和 error 均引用消息对象，不是副本；partial 指向的对象会随后续处理更新。
 * contentIndex 为文本块在 partial.content 中从 0 开始的索引。
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
      /** 响应流已读取完毕，对应文本块结束；后续仍可能因结束原因校验失败而发送 error。 */
      type: "text_end";
      /** 已结束文本块的索引，从 0 开始。 */
      contentIndex: number;
      /** 对应文本块的累计文本；length 结束时可能被截断。 */
      content: string;
      /** 当前助手消息，其结束状态仍可能在后续校验中更新。 */
      partial: AssistantMessage;
    }
  | {
      /** 请求处理成功结束。 */
      type: "done";
      /** stop 为正常结束，length 为达到令牌数上限。 */
      reason: "stop" | "length";
      /** 用于完成事件流最终结果的助手消息。 */
      message: AssistantMessage;
    }
  | {
      /** 请求或响应处理失败，事件流结束。 */
      type: "error";
      /** 失败的结束状态。 */
      reason: "error";
      /** 携带错误说明及已累积文本的助手消息，作为最终结果返回。 */
      error: AssistantMessage;
    };
