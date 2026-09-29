import type OpenAI from "openai";

/**
 * @file 独立流式模型通信核心模块（streamChat）。
 *
 * 核心架构与设计目标：
 * 1. 职责单一与通信解耦：从主入口（src/index.ts）中剥离纯净的大模型流式通信逻辑，
 *    本模块不直接依赖主会话状态、文件持久化、终端 UI 渲染或宿主权限策略，仅负责网络通信与协议解析；
 *    这种解耦为后续阶段 9 实现轻量级“子代理（Subagent）”提供了可独立复用的模型调用底座。
 * 2. 流式分片与事件驱动：大模型以 Server-Sent Events（SSE）流式逐字输出文本与工具参数碎片。
 *    本模块通过 `onEvent` 异步回调将增量内容实时上报给调用方，通信层自身绝不直接打印终端。
 * 3. 工具参数分片聚合：OpenAI 协议中工具调用的参数 JSON 是被切分成多个极小文本块依次返回的，
 *    模块内部使用 `PendingToolCall` 数组按 `delta.index` 槽位稳定累积参数，直到流结束才组装完毕。
 * 4. 健壮的用量抽取与取消支持：适配 OpenAI 协议中 `usage` 块常出现在流末尾（此时 `choices` 为空）的特性；
 *    全链路透传 AbortSignal 取消信号，支持在请求发起或流式接收期间随时协作式中断。
 */

/**
 * 模型流中尚未执行完毕的一次工具调用。
 *
 * 在模型流式输出过程中，一个完整的工具调用会被切分成多次返回（例如函数名在一个 chunk，参数被拆在后续若干 chunk）。
 * 此处用于在内存中分片累积，其 id 最终将与写入会话历史的 `role: "tool"` 消息严格配对。
 */
type PendingToolCall = {
  /** 模型生成的全局调用唯一标识（如 call_abc123）。 */
  id: string;
  /** 调用的工具函数名称（如 read_file、mcp_demo_demo_status 等）。 */
  name: string;
  /** 累积完成后的完整 JSON 格式参数字符串。 */
  arguments: string;
};

/** 提供商报告的 token 用量统计；若提供商未支持或未开启则为 null，严禁伪造数字。 */
export type Usage = {
  /** 提示词（输入上下文）消耗的 token 数量。 */
  promptTokens: number;
  /** 模型生成内容（输出）消耗的 token 数量。 */
  completionTokens: number;
  /** 总计消耗的 token 数量（promptTokens + completionTokens）。 */
  totalTokens: number;
};

/**
 * 一次完整流式模型请求结束后收集到的最终聚合结果。
 */
export type SteamChatResult = {
  /** 模型生成的最终完整文本内容（所有 text_delta 拼接结果）。 */
  content: string;
  /** 本轮模型请求中发起的所有工具调用列表（已完成参数拼接）。 */
  toolCalls: PendingToolCall[];
  /**
   * 模型结束生成的具体原因：
   * - "stop"：模型正常生成完成；
   * - "tool_calls"：模型发起了工具调用请求，等待宿主执行并回填结果；
   * - "length"：达到模型最大输出长度限制被截断。
   */
  finishReason: string;
  /** 本轮请求消耗的 token 统计；未报告时为 null。 */
  usage: Usage | null;
};

/**
 * 模型通信层向调用方触发的轻量运行时事件。
 * - text_delta：增量文本块到达，供展示层即时打字机渲染；
 * - model_end：模型流结束，携带最终的完成原因。
 */
type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "model_end"; finishReason: string };

/**
 * 发起流式模型请求并解析 SSE 流分块。
 *
 * 执行步骤：
 * 1. 调用 client.chat.completions.create 发起流式请求，开启 include_usage 选项；
 * 2. 使用 for await...of 异步迭代消费响应流分块（chunk）；
 * 3. 优先检查并捕获可能独立到达的 token 用量块（chunk.usage）；
 * 4. 抽取文本增量并通过 onEvent 回调实时上报，同时累加到完整 content 字符串；
 * 5. 抽取工具调用参数分片，按 index 槽位在数组中累加拼接 JSON 字符串；
 * 6. 记录 finish_reason；流结束后（在未被取消的前提下）触发 model_end 事件并返回结果。
 *
 * @param client 已初始化的 OpenAI SDK 客户端实例
 * @param model 本次请求调用的目标模型名称（如 gpt-4o、deepseek-chat 等）
 * @param messages 发送给模型的对话上下文消息列表
 * @param tools 允许模型调用的工具定义列表（OpenAI function 格式）
 * @param signal 外部取消信号，用于支持 Ctrl+C 或外层轮次超时中止网络请求
 * @param onEvent 运行时事件监听回调，用于向外传递增量文本或完成状态
 * @returns 包含聚合文本、待执行工具列表、完成原因与用量的结果对象
 * @throws {Error} 网络中断、流异常或 signal 触发时的取消错误
 */
export async function streamChat(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.Completions.ChatCompletionFunctionTool[],
  signal: AbortSignal,
  onEvent: (event: ModelEvent) => void,
): Promise<SteamChatResult> {
  // 发起流式聊天补全请求：
  // - stream: true 开启流式传输模式；
  // - stream_options: { include_usage: true } 明确要求提供商在流末尾返回 token 统计；
  // - signal 透传取消信号，在用户按 Ctrl+C 或超时时由底层 HTTP client 立即销毁连接。
  const stream = await client.chat.completions.create(
    { model, messages, tools, stream: true, stream_options: { include_usage: true } },
    { signal },
  );

  let content = "";
  let finishReason = "";
  let usage: Usage | null = null;
  const toolCalls: PendingToolCall[] = [];

  // 语法说明：for await (const chunk of stream) 是 JavaScript 异步迭代器语法（Async Iterator）。
  // stream 是一个异步可迭代对象（AsyncIterable），每当底层网络 socket 收到一个 SSE 数据分片时，
  // 循环体内便会执行一次，从而实现平滑的低延迟打字机流式接收。
  for await (const chunk of stream) {
    // 关键协议机制：根据 OpenAI 规范，当 stream_options 包含 include_usage 时，
    // 用量通常位于流的最后一个空 chunk 中（此时 choices 数组为空）。
    // 因此必须独立于 choice 单独进行检查和读取，不能写在 choice 判断之后。
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    // 1. 文本增量处理：
    // 仅通过 onEvent 事件回调通知外部渲染层，通信层自身绝不耦合终端写入逻辑。
    if (choice.delta.content) {
      onEvent({ type: "text_delta", text: choice.delta.content });
      content += choice.delta.content;
    }

    // 2. 工具调用碎片累加：
    // 机制说明：大模型在返回 tool_calls 时，一个工具调用的 JSON 参数会被拆分成数十个小碎片陆续到达。
    // 每个碎片携带固定的 delta.index 表示属于哪一个工具调用。
    if (choice.delta.tool_calls) {
      for (const delta of choice.delta.tool_calls) {
        // 第一次收到某个 index 时，先在数组对应位置初始化累积槽位。
        // 语法说明：`?? ""` 为空值合并运算符，当属性为 null 或 undefined 时兜底为空字符串。
        if (!toolCalls[delta.index]) {
          toolCalls[delta.index] = {
            id: delta.id ?? "",
            name: delta.function?.name ?? "",
            arguments: "",
          };
        }
        // 随后持续把后续 chunk 带来的参数字符串碎片追加到 arguments 末尾。
        if (delta.function?.arguments) {
          toolCalls[delta.index].arguments += delta.function.arguments;
        }
      }
    }

    // 3. 完成原因捕获：
    // - "stop": 回答自然结束；
    // - "tool_calls": 模型决定调用工具，后续需要宿主执行并将工具结果回填后发起下一轮；
    // - "length": 输出 token 达到上限被强制截断。
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  // 若本次流不是因为取消而提前中止，正常向调用方派发模型流结束事件
  if (!signal.aborted) {
    onEvent({ type: "model_end", finishReason });
  }

  return { content, toolCalls, finishReason, usage };
}
