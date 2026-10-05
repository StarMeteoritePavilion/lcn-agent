import type { AssistantMessage, Context, Model, StreamOptions } from "./types.ts";

import { stream } from "./api/openai-completions.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/**
 * 发起聊天补全请求，立即返回可消费文本增量及最终消息的助手事件流。
 * @param model - 请求使用的模型标识、接口基础地址和服务提供方配置。
 * @param context - 本次请求使用的系统提示词及按顺序排列的用户、助手历史消息。
 * @param options - 可选的认证、生成参数和网络请求选项；当前实现要求提供非空 apiKey。
 * @returns 助手消息事件流，可通过异步迭代接收事件，或调用 result() 等待最终助手消息。
 * @remarks
 * 当前统一委托给 openai-completions 的 stream，不按 model.api 分发到其他实现。
 * 请求异步继续执行；本函数不等待生成完成，也不将回复追加到 context.messages。
 * done 和 error 事件均会完成 result()；调用方应检查最终消息的 stopReason 和 errorMessage。
 * length 表示达到令牌数上限，结果可能被截断；model.maxTokens 不作为请求上限，需通过 options.maxTokens 设置。
 */
export function completion(
  model: Model,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return stream(model, context, options);
}
