import OpenAI from "openai";
import type { Model, StreamOptions } from "./types.ts";

/**
 * 向兼容 OpenAI 的聊天补全接口发送单条用户消息，汇总流式响应中的文本。
 * @param model - 模型配置，使用 id 指定模型、baseUrl 指定接口基础地址，provider 用于缺少密钥时的错误提示。
 * @param text - 作为唯一一条 user 消息发送的文本。
 * @param options - 请求选项，默认空对象；调用时必须提供非空 apiKey，可通过 fetch 自定义请求实现。
 * @returns 流结束后得到的首个响应选项的累计文本；以 length 结束时文本可能被截断，允许的结束原因下没有文本时返回空字符串。
 * @throws apiKey 缺失或为空、非空结束原因既不是 stop 也不是 length，或流结束前未收到非空 finish_reason 时拒绝 Promise。
 * @throws 客户端初始化、接口请求或响应流读取失败时，向调用方传递异常。
 * @remarks
 * 每次调用创建独立客户端并发起网络请求，允许在浏览器中使用，且禁用本次请求的自动重试。
 * 仅处理每个分片的 choices[0]，忽略无效分片及缺少首个响应选项的分片。
 * 收到 stop 或 length 后仍继续读取流；其他非空结束原因会立即触发异常。
 * 当前不读取 model.api 或 model.maxTokens，也不在请求中设置令牌数上限。
 */
export async function openaiCompletions(
  model: Model,
  text: string,
  options: StreamOptions = {},
): Promise<string> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provided: ${model.provider}`);
  }

  const client = new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    // 允许 SDK 在浏览器及浏览器 Worker 中运行，跳过默认的环境保护检查。
    // 此选项不会保护 API 密钥；在浏览器中使用时，密钥可能通过前端代码或网络请求暴露。
    dangerouslyAllowBrowser: true,
    fetch: options.fetch,
  });

  const openaiStream = await client.chat.completions.create(
    {
      model: model.id,
      messages: [{ role: "user", content: text }],
      stream: true,
    },
    { maxRetries: 0 },
  );

  let content = "";
  let hasFinishReason = false;
  for await (const chunk of openaiStream) {
    if (!chunk || typeof chunk !== "object") {
      continue;
    }
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) {
      continue;
    }
    // choice.finish_reason 的取值及含义：
    // null：当前流式分片尚未提供结束原因，跳过下方结束检查。
    // stop：模型自然结束生成，或命中请求指定的停止序列。
    // length：生成达到令牌数上限而停止，返回文本可能被截断，内容不保证完整。
    // tool_calls：模型发起工具调用，需要由调用方处理工具调用信息。
    // content_filter：内容被过滤机制拦截，部分内容未返回。
    // function_call：模型发起函数调用，属于已弃用的结束原因，由 tool_calls 替代。
    if (choice.finish_reason) {
      hasFinishReason = true;
      // 仅接受 stop 和 length：两者都不匹配时抛出异常；接受 length 时保留已生成文本，不自动续写。
      if (choice.finish_reason !== "stop" && choice.finish_reason !== "length") {
        throw new Error(`Provider finish_reason: ${choice.finish_reason}`);
      }
    }

    if (choice.delta?.content) {
      content += choice.delta.content;
    }
  }

  if (!hasFinishReason) {
    throw new Error("Stream ended without finish_reason");
  }
  return content;
}
