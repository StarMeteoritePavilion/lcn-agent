/** 兼容 OpenAI 的聊天补全模型配置。 */
export interface Model {
  /** 接口类型标识；当前 openaiCompletions 不读取此字段。 */
  api: "openai-completions";
  /** 服务提供方标识，用于缺少 API 密钥时的错误提示。 */
  provider: string;
  /** 发送给聊天补全接口的模型标识，对应请求中的 model 字段。 */
  id: string;
  /** 传入 OpenAI 客户端 baseURL 选项的接口基础地址。 */
  baseUrl: string;
  /** 可选的最大令牌数配置；省略时不指定上限，当前 openaiCompletions 不读取此字段，也不据此限制生成长度。 */
  maxTokens?: number;
}

/** 调用流式聊天补全时使用的认证与网络请求选项。 */
export interface StreamOptions {
  /** API 密钥；类型允许省略，但 openaiCompletions 会拒绝缺失或为空字符串的密钥。 */
  apiKey?: string;
  /** 自定义请求实现；省略时由 OpenAI 客户端使用全局 fetch。 */
  fetch?: typeof globalThis.fetch;
}
