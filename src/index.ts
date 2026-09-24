import OpenAI from "openai";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";

// 在入口的错误边界内完成初始化，配置校验通过后才允许运行 Agent。
let client: OpenAI;
let model: string;

// 工具定义同时发送给模型和约束工具参数；工具是否执行由 Agent 核心决定。

const ECHO_TOOL = {
  type: "function" as const,
  function: {
    name: "echo",
    description: "原样返回用户提供的文本",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要回显的文本" },
      },
      required: ["text"],
    },
  },
};

// 工具执行只发生在 Agent 循环中，UI 层不会调用此函数。

function executeTool(name: string, args: Record<string, unknown>): string {
  // 先按工具名路由，再校验边界参数；失败由 Agent 循环转换为工具失败结果。
  if (name === "echo") {
    if (typeof args.text !== "string") {
      throw new Error("echo 工具参数 text 必须是 string");
    }
    return args.text;
  }

  throw new Error(`未知工具: ${name}`);
}

// RuntimeEvent 是核心与展示层之间的唯一运行时通信边界。

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

type SteamChatResult = {
  content: string;
  toolCalls: PendingToolCall[];
  finishReason: string;
  usage: Usage | null;
};

type RuntimeEvent =
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "model_end";
      finishReason: string;
    }
  | {
      type: "tool_start";
      name: string;
      arguments: string;
    }
  | {
      type: "tool_end";
      name: string;
      output: string;
      success: boolean;
    }
  | {
      type: "turn_start";
      round: number;
    }
  | {
      type: "usage";
      usage: Usage | null;
    }
  | {
      type: "agent_end";
      reason: "completed" | "cancelled" | "loop_limit" | "truncated" | "error";
      round: number;
    }
  | {
      type: "error";
      message: string;
    };

type EventHandler = (event: RuntimeEvent) => void;

type UiStatus =
  | "idle"
  | "thinking"
  | "tool"
  | "completed"
  | "cancelled"
  | "truncated"
  | "loop_limit"
  | "error";

type MarkdownState = {
  pendingLine: string;
  inCodeBlock: boolean;
};

type UiState = {
  message: string;
  round: number;
  tool: string | null;
  status: UiStatus;
  markdown: MarkdownState;
};

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_YELLOW = "\u001b[33m";

function renderMarkdownLine(line: string, markdown: MarkdownState): string {
  // 流式分块可能把 Markdown 标记拆开，因此只在完整行上处理格式。
  if (line.trimStart().startsWith("```")) {
    // 代码围栏只切换状态，不把围栏本身输出到终端。
    markdown.inCodeBlock = !markdown.inCodeBlock;
    return "";
  }

  if (markdown.inCodeBlock) return `${ANSI_YELLOW}${line}${ANSI_RESET}`;

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) return `${ANSI_BOLD}${ANSI_CYAN}${heading[2]}${ANSI_RESET}`;

  const listItem = line.match(/^(\s*)[-*]\s+(.+)$/);
  // 列表符号和行内标记只做终端展示转换，原始消息仍保存在 state.message。
  const content = listItem ? `${listItem[1]}• ${listItem[2]}` : line;

  return content
    .replace(/\*\*(.+?)\*\*/g, `${ANSI_BOLD}$1${ANSI_RESET}`)
    .replace(/`([^`]+)`/g, `${ANSI_YELLOW}$1${ANSI_RESET}`);
}

function renderMarkdownDelta(state: UiState, text: string, write: (text: string) => void): void {
  // 缓存最后一个不完整行，避免半个标题或代码标记被提前渲染。
  state.markdown.pendingLine += text;

  let newlineIndex = state.markdown.pendingLine.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = state.markdown.pendingLine.slice(0, newlineIndex);
    state.markdown.pendingLine = state.markdown.pendingLine.slice(newlineIndex + 1);
    write(`${renderMarkdownLine(line, state.markdown)}\n`);
    newlineIndex = state.markdown.pendingLine.indexOf("\n");
  }
}

function flushMarkdown(state: UiState, write: (text: string) => void): void {
  // 模型取消、报错或结束时都要冲刷缓存，避免丢失最后一段文字。
  if (!state.markdown.pendingLine) return;
  write(renderMarkdownLine(state.markdown.pendingLine, state.markdown));
  state.markdown.pendingLine = "";
}

function createUiRenderer(
  write: (text: string, isError: boolean) => void = (text, isError) =>
    (isError ? process.stderr : process.stdout).write(text),
): EventHandler {
  // 展示层只更新状态和输出事件内容，不参与消息、工具或轮次决策。
  const state: UiState = {
    message: "",
    round: 0,
    tool: null,
    status: "idle",
    markdown: { pendingLine: "", inCodeBlock: false },
  };

  return (event) => {
    // 同一事件的输出合并后交给终端，避免半行冲刷与提示符互相穿插。
    let output = "";
    const append = (text: string): void => {
      output += text;
    };
    switch (event.type) {
      case "text_delta":
        state.message += event.text;
        renderMarkdownDelta(state, event.text, append);
        break;
      case "model_end":
        flushMarkdown(state, append);
        append(`\nfinish_reason: ${event.finishReason}\n`);
        break;
      case "tool_start":
        state.status = "tool";
        state.tool = event.name;
        append(`\n  工具: ${event.name}(${event.arguments})\n`);
        break;
      case "tool_end":
        state.tool = null;
        append((event.success ? `  结果: ${event.output}` : `  失败: ${event.output}`) + "\n");
        break;
      case "turn_start":
        state.round = event.round;
        state.status = "thinking";
        state.message = "";
        state.markdown.pendingLine = "";
        state.markdown.inCodeBlock = false;
        append(`--- 第 ${event.round} 轮 ---\n`);
        break;
      case "usage":
        printUsage(event.usage, append);
        break;
      case "agent_end":
        flushMarkdown(state, append);
        state.markdown.inCodeBlock = false;
        if (process.stdout.isTTY) append(ANSI_RESET);
        state.tool = null;
        if (event.reason === "completed") state.status = "completed";
        else if (event.reason === "cancelled") state.status = "cancelled";
        else if (event.reason === "truncated") state.status = "truncated";
        else if (event.reason === "loop_limit") state.status = "loop_limit";
        else state.status = "error";
        if (event.reason === "completed") append(`\n完成，共 ${event.round} 轮\n`);
        if (event.reason === "cancelled") append("\n请求已取消\n");
        if (event.reason === "truncated") append("\n响应因长度截断，不执行工具\n");
        if (event.reason === "loop_limit") append(`\n达到最大轮次限制: ${event.round}\n`);
        break;
      case "error":
        flushMarkdown(state, append);
        state.status = "error";
        append(`\n请求失败：${event.message}\n`);
        break;
    }
    if (output) write(output, event.type === "error");
  };
}

// 读取一次模型流：收集完整响应，同时把文本增量和模型结束事件立即上报。

const REQUEST_TIMEOUT_MS = 30_000;

async function streamChat(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  signal: AbortSignal,
  onEvent: EventHandler,
): Promise<SteamChatResult> {
  const stream = await client.chat.completions.create(
    {
      model,
      messages,
      tools: [ECHO_TOOL],
      stream: true,
      // openai SDK 的 stream: true 默认不返回 usage。需要加 stream_options: { include_usage: true }
      // 这个还需要产商支持的
      stream_options: { include_usage: true },
    },
    { signal },
  );

  let content = "";
  let finishReason = "";
  let usage: Usage | null = null;
  const toolCalls: PendingToolCall[] = [];

  for await (const chunk of stream) {
    //console.log(`\n--- chunk ---\n${JSON.stringify(chunk, null, 2)}`);

    // 用量通常位于最后一个 choices 为空的 chunk，缺失时保持 null。
    if (chunk.usage) {
      // usage chunk 可能没有 choices，因此必须先单独读取再处理 choice。
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    // 文本只通过事件交给展示层，通信层不直接写终端。
    if (choice.delta.content) {
      // 通过回调接口将结果传输给调用方
      onEvent({
        type: "text_delta",
        text: choice.delta.content,
      });
      content += choice.delta.content;
    }

    // 工具参数也按调用索引累积，直到 finish_reason 表示 tool_calls 才执行。
    if (choice.delta.tool_calls) {
      for (const delta of choice.delta.tool_calls) {
        // 同一个 index 会跨多个 chunk 到达，第一次出现时先创建累积槽位。
        if (!toolCalls[delta.index]) {
          toolCalls[delta.index] = {
            id: delta.id ?? "",
            name: delta.function?.name ?? "",
            arguments: "",
          };
        }
        if (delta.function?.arguments) {
          toolCalls[delta.index].arguments += delta.function.arguments;
        }
      }
    }

    // stop 表示回答完成，length 表示截断，tool_calls 表示需要回填工具结果。
    // stop: 文本结束
    // length: 响应因长度截断
    // tool_calls: 工具调用结束
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  if (!signal.aborted) {
    onEvent({
      type: "model_end",
      finishReason,
    });
  }

  return { content, toolCalls, finishReason, usage };
}

// 用量显示保留提供商原始结果；没有报告时不伪造数值。

function printUsage(usage: Usage | null, write: (text: string) => void): void {
  if (!usage) {
    write("用量：未报告\n");
    return;
  }
  write(
    `用量：prompt ${usage.promptTokens} + completion ${usage.completionTokens} = ${usage.totalTokens} tokens\n`,
  );
}

// Agent 核心循环：请求模型、回填工具结果，再决定结束或进入下一轮。

const MAX_ROUNDS = 5;

async function runAgent(
  userInput: string,
  userAbort: AbortController,
  onEvent: EventHandler,
): Promise<void> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: userInput },
  ];

  let round = 0;

  try {
    for (round = 1; round <= MAX_ROUNDS; round++) {
      // 每轮拥有自己的超时信号，同时接受用户 Ctrl+C 的取消信号。
      onEvent({
        type: "turn_start",
        round,
      });

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([userAbort.signal, timeout]);

      const steamChatResult = await streamChat(messages, signal, onEvent);

      if (signal.aborted) {
        // 请求结束后再次检查，避免超时或 Ctrl+C 后继续执行工具。
        onEvent({ type: "agent_end", reason: "cancelled", round });
        return;
      }

      onEvent({
        type: "usage",
        usage: steamChatResult.usage,
      });

      if (steamChatResult.finishReason === "stop") {
        onEvent({
          type: "agent_end",
          reason: "completed",
          round,
        });
        return;
      }

      if (steamChatResult.finishReason === "length") {
        onEvent({ type: "agent_end", reason: "truncated", round });
        return;
      }

      if (steamChatResult.finishReason !== "tool_calls") {
        // 未知结束原因不执行工具，交给下一轮或最终轮次限制处理。
        continue;
      }

      messages.push({
        // 先保存模型的 tool_calls 消息，工具结果才能与调用 ID 配对。
        role: "assistant",
        content: steamChatResult.content,
        tool_calls: steamChatResult.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })),
      });

      for (const tc of steamChatResult.toolCalls) {
        // 先发出开始事件，再在核心层校验参数并执行工具。
        onEvent({
          type: "tool_start",
          name: tc.name,
          arguments: tc.arguments,
        });

        let output: string;

        try {
          // JSON 解析和参数校验都在核心层完成，UI 不参与工具决策。
          const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
          output = executeTool(tc.name, parsed);

          onEvent({
            type: "tool_end",
            name: tc.name,
            output,
            success: true,
          });
        } catch (error) {
          output = `执行失败：${error instanceof Error ? error.message : String(error)}`;

          onEvent({
            type: "tool_end",
            name: tc.name,
            output,
            success: false,
          });
        }

        messages.push({
          // 无论工具成功或失败，都把结果回填给下一轮模型请求。
          role: "tool",
          tool_call_id: tc.id,
          content: output,
        });
      }
    }

    onEvent({ type: "agent_end", reason: "loop_limit", round: MAX_ROUNDS });
  } catch (error) {
    if (error instanceof OpenAI.APIUserAbortError) {
      onEvent({ type: "agent_end", reason: "cancelled", round });
      return;
    }

    onEvent({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    onEvent({ type: "agent_end", reason: "error", round });
  }
}

async function main(): Promise<void> {
  // 交互入口只负责读取输入、绑定取消信号和消费运行事件。
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let activeAbort: AbortController | null = null;
  let closed = false;

  const onSigint = (): void => {
    // 生成中取消当前请求；空闲时关闭 readline，让主循环自然退出。
    if (activeAbort) {
      activeAbort.abort();
    } else {
      input.close();
    }
  };

  const onClose = (): void => {
    // stdin 被外部关闭时，确保正在进行的模型请求也收到取消信号。
    closed = true;
    activeAbort?.abort();
  };

  const showPrompt = (): void => {
    if (!closed && process.stdin.isTTY && process.stdout.isTTY) input.prompt(true);
  };

  // 在完整编辑行上方插入输出，再让 readline 按原光标位置重绘输入。
  const writeOutput = (text: string, isError = false): void => {
    if (closed || !process.stdin.isTTY || !process.stdout.isTTY) {
      (isError ? process.stderr : process.stdout).write(text);
      return;
    }
    const { rows } = input.getCursorPos();
    moveCursor(process.stdout, 0, -rows);
    cursorTo(process.stdout, 0);
    clearScreenDown(process.stdout);
    process.stdout.write(text);
    // readline 重绘时会上移原光标行数，先留出同样的行数以保留输出。
    process.stdout.write("\n".repeat(rows));
    showPrompt();
  };

  input.on("SIGINT", onSigint);
  input.on("close", onClose);
  input.setPrompt("> ");

  console.log(`模型: ${model}`);
  console.log("输入内容后回车，输入 /exit 退出。");
  console.log("生成中 Ctrl+C 取消，空闲时 Ctrl+C 退出。\n");
  showPrompt();

  try {
    for await (const line of input) {
      if (closed) break;

      const userInput = line.trim();
      if (userInput === "/exit") break;

      if (!userInput) {
        showPrompt();
        continue;
      }

      writeOutput(`\n用户: ${userInput}\n\n`);

      const userAbort = new AbortController();
      activeAbort = userAbort;

      try {
        // await 会暂停当前输入循环，但 readline 仍会缓存用户已提交的后续行。
        await runAgent(userInput, userAbort, createUiRenderer(writeOutput));
      } finally {
        // 无论完成、失败还是取消，都必须解除“正在运行”状态。
        activeAbort = null;
      }

      showPrompt();
    }
  } finally {
    // 统一清理监听器和终端 ANSI 状态，避免退出后影响用户的 Shell。
    input.close();
    input.off("SIGINT", onSigint);
    input.off("close", onClose);
    if (process.stdout.isTTY) process.stdout.write(ANSI_RESET);
    console.log("\n终端程序已退出");
  }
}

async function runNonInteractive(userInput: string): Promise<void> {
  // 非交互入口用于脚本和调试，复用同一 Agent 循环与事件渲染器。
  console.log(`用户: ${userInput}\n`);
  await runAgent(userInput, new AbortController(), createUiRenderer());
  if (process.stdout.isTTY) process.stdout.write(ANSI_RESET);
}

const nonInteractiveInput = process.argv.slice(2).join(" ").trim();

try {
  const config = loadConfig();
  client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  model = config.model;
  // 有命令行文本时单次运行，否则进入 readline 交互模式。
  if (nonInteractiveInput) await runNonInteractive(nonInteractiveInput);
  else await main();
} catch (error) {
  if (error instanceof OpenAI.APIUserAbortError) {
    console.log("请求已取消");
    process.exitCode = 0;
  } else {
    console.error(`\n请求失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
