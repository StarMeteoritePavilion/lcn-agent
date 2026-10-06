import * as completions from "./api/openai-completions.ts";
import * as responses from "./api/openai-responses.ts";
import * as anthropic from "./api/anthropic-messages.ts";
import * as google from "./api/google-generative-ai.ts";
import type {
  ApiStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
} from "./types.ts";
const apis = {
  "openai-completions": completions,
  "openai-responses": responses,
  "anthropic-messages": anthropic,
  "google-generative-ai": google,
};
/**
 * 按模型声明的协议立即返回助手事件流。
 * @param model - 使用已支持接口协议的模型配置，不按名称推断协议。
 * @param context - 本次请求的历史消息及可选工具声明。
 * @param options - 所选协议的认证及生成选项。
 * @returns 可异步迭代的助手事件流，也可通过 result 等待最终消息。
 * @throws 模型声明的接口协议不受支持时同步抛出异常。
 * @remarks 请求失败或中止通过 error 事件及最终消息表达，调用方须检查 stopReason。
 */
export function stream<T extends keyof typeof apis>(
  model: Model<T>,
  context: Context,
  options?: ApiStreamOptions<T>,
): AssistantMessageEventStream {
  if (!Object.hasOwn(apis, model.api)) {
    throw new Error(`不支持的模型接口类型：${model.api}`);
  }
  return apis[model.api].stream(model as never, context, options as never);
}
/**
 * 发起请求并等待最终助手消息，无需消费增量事件。
 * @param model - 使用已支持接口协议的模型配置。
 * @param context - 本次请求的历史消息及可选工具声明。
 * @param options - 所选协议的认证及生成选项。
 * @returns Promise 完成后返回最终助手消息，包括 error 或 aborted 状态。
 * @throws 接口协议不受支持时拒绝 Promise。
 * @remarks 普通请求失败不会拒绝 Promise，调用方须检查 stopReason 和 errorMessage。
 */
export async function complete<T extends keyof typeof apis>(
  model: Model<T>,
  context: Context,
  options?: ApiStreamOptions<T>,
): Promise<AssistantMessage> {
  return stream(model, context, options).result();
}
