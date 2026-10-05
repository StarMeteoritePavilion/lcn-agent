import type { Context, Model, StreamOptions } from "./types.ts";

import { stream as openaiCompletionsStream } from "./api/openai-completions.ts";
import { stream as anthropicMessageStream } from "./api/anthropic-messages.ts";
import { stream as openaiResponseStream } from "./api/openai-responses.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

/**
 * 按模型接口类型启动请求，并返回对应的助手消息事件流。
 * @param model - 模型标识、接口类型及服务提供方配置。
 * @param context - 系统提示词、对话历史与可选工具声明；本函数不追加历史。
 * @param options - 请求密钥、生成参数及自定义 fetch。
 * @returns Promise 完成后返回可异步迭代的事件流；此时不保证请求已结束或最终消息已生成。
 * @throws model.api 不属于支持的接口类型时拒绝 Promise。
 * @remarks
 * 本函数不等待模型生成完成，也不调用事件流的 result()；调用方可遍历增量事件，或调用 result() 等待最终消息。
 * 请求和响应处理异常由对应接口模块转换为 error 事件，result() 返回 stopReason 为 error 的消息。
 * 工具调用仅作为消息内容返回，工具执行、参数校验与结果回填由调用方负责。
 * @example
 * const stream = await completion(model, context, options);
 * const message = await stream.result();
 */
export async function completion(
  model: Model,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessageEventStream> {
  switch (model?.api) {
    case "openai-completions": {
      return openaiCompletionsStream(model as Model<"openai-completions">, context, options);
    }
    case "anthropic-messages": {
      return anthropicMessageStream(model as Model<"anthropic-messages">, context, options);
    }
    case "openai-responses": {
      return openaiResponseStream(model as Model<"openai-responses">, context, options);
    }
    default: {
      throw new Error("不支持的模型接口类型。");
    }
  }
}
