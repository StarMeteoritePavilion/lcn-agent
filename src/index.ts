import OpenAI from "openai";
import { createInterface } from "node:readline/promises";

// --- 环境变量 ---

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return value;
}

const client = new OpenAI({
  apiKey: requireEnv("API_KEY"),
  baseURL: requireEnv("BASE_URL"),
});

const model = requireEnv("MODEL");

// --- echo 工具定义 ---
// 用 JSON Schema 描述工具参数，模型根据此定义决定何时调用、如何填参

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

// --- 工具执行 ---

function executeTool(name: string, args: Record<string, unknown>): string {
  if (name === "echo") {
    if (typeof args.text !== "string") {
      throw new Error("echo 工具参数 text 必须是 string");
    }
    return args.text;
  }

  throw new Error(`未知工具: ${name}`);
}

// --- 类型 ---

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
  if (line.trimStart().startsWith("```")) {
    markdown.inCodeBlock = !markdown.inCodeBlock;
    return "";
  }

  if (markdown.inCodeBlock) return `${ANSI_YELLOW}${line}${ANSI_RESET}`;

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) return `${ANSI_BOLD}${ANSI_CYAN}${heading[2]}${ANSI_RESET}`;

  const listItem = line.match(/^(\s*)[-*]\s+(.+)$/);
  const content = listItem ? `${listItem[1]}• ${listItem[2]}` : line;

  return content
    .replace(/\*\*(.+?)\*\*/g, `${ANSI_BOLD}$1${ANSI_RESET}`)
    .replace(/`([^`]+)`/g, `${ANSI_YELLOW}$1${ANSI_RESET}`);
}

function renderMarkdownDelta(state: UiState, text: string): void {
  state.markdown.pendingLine += text;

  let newlineIndex = state.markdown.pendingLine.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = state.markdown.pendingLine.slice(0, newlineIndex);
    state.markdown.pendingLine = state.markdown.pendingLine.slice(newlineIndex + 1);
    process.stdout.write(`${renderMarkdownLine(line, state.markdown)}\n`);
    newlineIndex = state.markdown.pendingLine.indexOf("\n");
  }
}

function flushMarkdown(state: UiState): void {
  if (!state.markdown.pendingLine) return;
  process.stdout.write(renderMarkdownLine(state.markdown.pendingLine, state.markdown));
  state.markdown.pendingLine = "";
}

function createUiRenderer(): EventHandler {
  const state: UiState = {
    message: "",
    round: 0,
    tool: null,
    status: "idle",
    markdown: { pendingLine: "", inCodeBlock: false },
  };

  return (event) => {
    switch (event.type) {
      case "text_delta":
        state.message += event.text;
        renderMarkdownDelta(state, event.text);
        break;
      case "model_end":
        flushMarkdown(state);
        console.log(`\nfinish_reason: ${event.finishReason}`);
        break;
      case "tool_start":
        state.status = "tool";
        state.tool = event.name;
        console.log(`\n  工具: ${event.name}(${event.arguments})`);
        break;
      case "tool_end":
        state.tool = null;
        console.log(event.success ? `  结果: ${event.output}` : `  失败: ${event.output}`);
        break;
      case "turn_start":
        state.round = event.round;
        state.status = "thinking";
        state.message = "";
        state.markdown.pendingLine = "";
        state.markdown.inCodeBlock = false;
        console.log(`--- 第 ${event.round} 轮 ---`);
        break;
      case "usage":
        printUsage(event.usage);
        break;
      case "agent_end":
        flushMarkdown(state);
        state.markdown.inCodeBlock = false;
        if (process.stdout.isTTY) process.stdout.write(ANSI_RESET);
        state.tool = null;
        if (event.reason === "completed") state.status = "completed";
        else if (event.reason === "cancelled") state.status = "cancelled";
        else if (event.reason === "truncated") state.status = "truncated";
        else if (event.reason === "loop_limit") state.status = "loop_limit";
        else state.status = "error";
        if (event.reason === "completed") console.log(`\n完成，共 ${event.round} 轮`);
        if (event.reason === "cancelled") console.log("\n请求已取消");
        if (event.reason === "truncated") console.log("\n响应因长度截断，不执行工具");
        if (event.reason === "loop_limit") console.log(`\n达到最大轮次限制: ${event.round}`);
        break;
      case "error":
        flushMarkdown(state);
        state.status = "error";
        console.error(`\n请求失败：${event.message}`);
        break;
    }
  };
}

// --- 流式请求 ---

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

    // 用量：最后一个 chunk 的 choices 为空，usage 有值
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) continue;

    // 文本增量：逐块输出到终端
    if (choice.delta.content) {
      // 通过回调接口将结果传输给调用方
      onEvent({
        type: "text_delta",
        text: choice.delta.content,
      });
      content += choice.delta.content;
    }

    // 工具调用增量：按 index 累积参数片段
    if (choice.delta.tool_calls) {
      for (const delta of choice.delta.tool_calls) {
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

    // 结束原因
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

// --- 用量显示 ---

function printUsage(usage: Usage | null): void {
  if (!usage) {
    console.log("用量：未报告");
    return;
  }
  console.log(
    `用量：prompt ${usage.promptTokens} + completion ${usage.completionTokens} = ${usage.totalTokens} tokens`,
  );
}

// --- Agent 循环 ---

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
      onEvent({
        type: "turn_start",
        round,
      });

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([userAbort.signal, timeout]);

      const steamChatResult = await streamChat(messages, signal, onEvent);

      if (signal.aborted) {
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
        continue;
      }

      messages.push({
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
        onEvent({
          type: "tool_start",
          name: tc.name,
          arguments: tc.arguments,
        });

        let output: string;

        try {
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
          role: "tool",
          tool_call_id: tc.id,
          content: output,
        });

        console.log("");
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
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let activeAbort: AbortController | null = null;
  let closed = false;

  const onSigint = (): void => {
    if (activeAbort) {
      activeAbort.abort();
    } else {
      input.close();
    }
  };

  const onClose = (): void => {
    closed = true;
    activeAbort?.abort();
  };

  const showPrompt = (): void => {
    if (!closed && process.stdin.isTTY && process.stdout.isTTY) input.prompt();
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

      console.log(`\n用户: ${userInput}\n`);

      const userAbort = new AbortController();
      activeAbort = userAbort;

      try {
        await runAgent(userInput, userAbort, createUiRenderer());
      } finally {
        activeAbort = null;
      }

      showPrompt();
    }
  } finally {
    input.close();
    input.off("SIGINT", onSigint);
    input.off("close", onClose);
    if (process.stdout.isTTY) process.stdout.write(ANSI_RESET);
    console.log("\n终端程序已退出");
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof OpenAI.APIUserAbortError) {
    console.log("请求已取消");
    process.exitCode = 0;
  } else {
    console.error(`\n请求失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
