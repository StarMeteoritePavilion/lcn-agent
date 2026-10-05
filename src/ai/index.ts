import type { AssistantMessage, Context, Model, StreamOptions } from "./types.ts";

import { stream } from "./api/openai-completions.ts";

/**
 * 发起聊天补全请求，等待并返回最终助手消息。
 * @param model - 请求使用的模型标识、接口基础地址及服务提供方配置。
 * @param context - 系统提示词、历史消息及可供模型选择的工具声明；本函数不追加历史消息。
 * @param options - 可选的认证、生成参数和网络请求选项；当前请求实现要求提供非空 apiKey。
 * @returns Promise 完成后返回包含文本、工具调用及结束状态的助手消息；未生成内容时 content 为空数组。
 * @remarks
 * 当前统一调用 openai-completions 的 stream，不按 model.api 分发到其他实现。
 * 此接口等待最终结果；需要逐个消费增量事件时，应直接调用对应接口模块的 stream。
 * 请求和响应处理异常由接口模块转换为 stopReason 为 error 的消息，调用方应检查 stopReason 和 errorMessage。
 * 若接口模块的错误处理自身抛错，后台请求可能未能发送终结事件，此 Promise 也无法获得最终结果。
 * toolUse 仅表示模型结束于工具调用，工具执行、参数校验及结果回填均由调用方负责。
 * length 结果可能被截断；请求令牌数上限通过 options.maxTokens 设置，不读取 model.maxTokens。
 */
export async function completion(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessage> {
  // 最终结果由 done 或 error 事件完成，不需要先遍历事件流才能获得结果。
  return stream(model, context, options).result();
}
