import OpenAI from "openai";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { AgentEndEvent, createToolRegistry, loadExtension, mountExtension } from "./core/tools.js";
import { registerEcho } from "./extensions/echo.js";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./core/config.js";
import { createDiagnostics, DiagnosticWriteError, showDiagnostics } from "./core/diagnostics.js";

import {
  createSession,
  listSessions,
  loadSession,
  lockSessions,
  saveMessage,
  type Session,
  SessionWriteError,
} from "./core/session.js";

// 在入口的错误边界内完成初始化，配置校验通过后才允许运行 Agent。
let client: OpenAI;
let model: string;

// 注册表由入口持有；扩展在启动时登记，Agent 循环统一查找和执行。
const toolRegistry = createToolRegistry();

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
  | AgentEndEvent
  | {
      type: "error";
      message: string;
    };

type EventHandler = (event: RuntimeEvent) => void;

type UiStatus =
  "idle" | "thinking" | "tool" | "completed" | "cancelled" | "truncated" | "loop_limit" | "error";

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
      tools: toolRegistry.definitions(),
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
  session: Session,
): Promise<void> {
  saveMessage(session, { role: "user", content: userInput });
  const messages = session.messages;
  const diagnostics = createDiagnostics(session);
  // 包装事件处理器：先交给展示层，再在运行结束时额外做两件事——
  // 1. 写入诊断结束记录；2. 通知扩展订阅的 onAgentEnd 监听器。
  // 监听器失败只返回提示文本，不会抛错，这里转成 error 事件交给展示层输出。
  const display = onEvent;
  onEvent = (event) => {
    if (event.type === "agent_end") {
      diagnostics.finish(event.reason, event.round);
    }
    display(event);

    if (event.type === "agent_end") {
      for (const message of toolRegistry.emitAgentEnd(event)) {
        display({ type: "error", message });
      }
    }
  };

  let round = 0;

  try {
    for (round = 1; round <= MAX_ROUNDS; round++) {
      // 每轮拥有自己的超时信号，同时接受用户 Ctrl+C 的取消信号。
      onEvent({ type: "turn_start", round });

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([userAbort.signal, timeout]);

      const operation = diagnostics.start("model", model, round);
      let steamChatResult: SteamChatResult;
      try {
        steamChatResult = await streamChat(messages, signal, onEvent);
      } catch (error) {
        const outcome = userAbort.signal.aborted
          ? "cancelled"
          : timeout.aborted
            ? "timeout"
            : "error";
        // 不持久化提供商的原始错误正文，避免其中夹带请求数据或凭据。
        const reason =
          outcome === "cancelled"
            ? "用户取消"
            : outcome === "timeout"
              ? "请求超时"
              : error instanceof OpenAI.APIError
                ? `HTTP ${error.status ?? "未知状态"} ${error.name}`
                : error instanceof Error
                  ? error.name
                  : "模型请求异常";
        diagnostics.end(operation, outcome, reason);
        throw error;
      }
      const outcome = userAbort.signal.aborted
        ? "cancelled"
        : timeout.aborted
          ? "timeout"
          : "success";
      diagnostics.end(
        operation,
        outcome,
        outcome === "success"
          ? steamChatResult.finishReason
          : outcome === "cancelled"
            ? "用户取消"
            : "请求超时",
        steamChatResult.usage,
      );

      if (signal.aborted) {
        // 请求结束后再次检查，避免超时或 Ctrl+C 后继续执行工具。
        onEvent({ type: "agent_end", reason: "cancelled", round });
        return;
      }

      onEvent({ type: "usage", usage: steamChatResult.usage });

      if (steamChatResult.finishReason === "stop") {
        saveMessage(session, {
          role: "assistant",
          content: steamChatResult.content,
        });
        onEvent({ type: "agent_end", reason: "completed", round });
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

      saveMessage(session, {
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
        // 开始记录先落盘，再执行工具；进程中断时仍能识别结果未知的调用。
        const operation = diagnostics.start("tool", tc.name, round, tc.id);
        onEvent({ type: "tool_start", name: tc.name, arguments: tc.arguments });
        let output: string;
        let success = true;
        let reason = "工具执行完成";
        try {
          // 核心解析 JSON，工具入口校验参数，失败仍由这里统一回填。
          const parsed: unknown = JSON.parse(tc.arguments);
          output = toolRegistry.execute(tc.name, parsed);
        } catch (error) {
          success = false;
          reason =
            error instanceof SyntaxError
              ? "工具参数不是合法 JSON"
              : error instanceof Error
                ? error.message
                : "工具执行异常";
          output = `执行失败：${reason}`;
        }
        // 写诊断的异常不能落入工具异常 catch，避免误判或重复记录。
        diagnostics.end(operation, success ? "success" : "error", reason);
        onEvent({ type: "tool_end", name: tc.name, output, success });
        saveMessage(session, {
          // 无论工具成功或失败，都把结果回填给下一轮模型请求。
          role: "tool",
          tool_call_id: tc.id,
          content: output,
        });
      }
    }

    onEvent({ type: "agent_end", reason: "loop_limit", round: MAX_ROUNDS });
  } catch (error) {
    if (error instanceof SessionWriteError || error instanceof DiagnosticWriteError) {
      throw error;
    }
    if (error instanceof OpenAI.APIUserAbortError) {
      onEvent({ type: "agent_end", reason: "cancelled", round });
      return;
    }

    onEvent({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    onEvent({ type: "agent_end", reason: "error", round });
  } finally {
    diagnostics.close();
  }
}

async function main(): Promise<void> {
  // 启动只创建内存引用；首次提问或 /new 时才创建会话文件。
  let session: Session | undefined;

  // 交互入口只负责读取输入、绑定取消信号和消费运行事件。
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 当前正在运行的任务（Agent 请求或扩展命令）的取消控制器；空闲时为 null。
  // 两类任务共用这一个变量，因此 Ctrl+C 与 stdin 关闭时的取消逻辑对二者都生效。
  let activeAbort: AbortController | null = null;
  let closed = false;
  let asking = false;

  const onSigint = (): void => {
    // 生成中（或命令执行中）取消当前任务；空闲时关闭 readline，让主循环自然退出。
    if (activeAbort) {
      activeAbort.abort();
    } else {
      input.close();
    }
  };

  const onClose = (): void => {
    // stdin 被外部关闭时，确保正在进行的模型请求或命令也收到取消信号。
    closed = true;
    activeAbort?.abort();
  };

  const showPrompt = (): void => {
    if (!closed && process.stdin.isTTY && process.stdout.isTTY) {
      input.prompt(true);
    }
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
  console.log("/new 新建，/sessions 列出，/resume 完整文件名 恢复，/history 查看历史。");
  console.log("/diagnostics 查看当前诊断；/diagnostics 完整会话文件名 查看指定会话诊断。");
  // 这里的“生成中”也包括扩展命令执行中：两者都会登记 activeAbort。
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

      // 命令仅在当前请求结束后处理，不与正在执行的工具并发切换会话。
      if (
        userInput === "/new" ||
        userInput === "/sessions" ||
        userInput === "/history" ||
        userInput === "/diagnostics" ||
        userInput.startsWith("/diagnostics ") ||
        userInput.startsWith("/resume ")
      ) {
        try {
          if (userInput === "/new") {
            session = createSession(model);
            writeOutput(`会话：${session.file}\n`);
          } else if (userInput === "/sessions") {
            writeOutput(listSessions().join("\n") + "\n");
          } else if (userInput === "/history") {
            writeOutput(JSON.stringify(session?.messages ?? [], null, 2) + "\n");
          } else if (userInput === "/diagnostics" || userInput.startsWith("/diagnostics ")) {
            const file =
              userInput === "/diagnostics"
                ? session?.file
                : userInput.slice("/diagnostics ".length);
            writeOutput(file ? showDiagnostics(file) : "尚未选择会话\n");
          } else {
            session = loadSession(userInput.slice("/resume ".length), model);
            writeOutput(`已恢复：${session.file}，${session.messages.length} 条消息\n`);
          }
        } catch (error) {
          writeOutput(
            `会话操作失败：${error instanceof Error ? error.message : String(error)}\n`,
            true,
          );
        }
        showPrompt();
        continue;
      }

      // 宿主命令优先；扩展命令及未知斜杠命令都不发送给模型。
      if (userInput.startsWith("/")) {
        // 每条命令拥有独立的取消控制器：
        // 登记为 activeAbort 后，用户按 Ctrl+C 会取消本条命令，而不是退出程序。
        const commandAbort = new AbortController();
        activeAbort = commandAbort;
        try {
          const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(userInput);
          if (!match) {
            throw new Error("命令不能为空");
          }
          const name = match[1];
          const args = match[2] ?? "";
          // 每次执行时读取当前状态，避免扩展一直引用旧会话。
          // Object.freeze 让扩展在运行时也无法改写上下文（CommandContext 的 Readonly 只在编译期生效）。
          const context = Object.freeze({
            cwd: process.cwd(),
            model,
            sessionFile: session?.file ?? null,
            signal: commandAbort.signal,
            ui: Object.freeze({
              notify: (message: string): void => {
                writeOutput(message + "\n");
              },
              ask: async (question: string): Promise<string> => {
                commandAbort.signal.throwIfAborted();

                if (closed) {
                  throw new Error("输入已关闭，无法提问");
                }
                if (!process.stdin.isTTY || !process.stdout.isTTY) {
                  throw new Error("交互提问需要终端输入和输出");
                }
                if (asking) {
                  throw new Error("已有提问正在等待回答");
                }
                asking = true;
                try {
                  return await input.question(`${question} `, {
                    signal: commandAbort.signal,
                  });
                } finally {
                  asking = false;
                }
              },
            }),
          });

          // executeCommand 总是返回 Promise，同步和异步命令都用 await 等待。
          // 等待期间输入循环暂停，与 runAgent 相同：新输入会缓存到命令结束后再处理。
          const output = await toolRegistry.executeCommand(name, args, context);

          // 即使命令没有及时响应取消，也不显示迟到的成功结果。
          // （命令可能忽略 signal 一直运行到结束；此时用户已按过 Ctrl+C，结果应视为作废。）
          // 这里抛出后会进入下方 catch，统一按“已取消”处理。
          commandAbort.signal.throwIfAborted();
          // 命令可以直接返回字符串，也可以只通过 context.ui.notify 输出而不返回。
          if (output !== undefined) {
            writeOutput(output + "\n");
          }
        } catch (error) {
          // 以信号状态而非错误类型判断是否为取消：
          // 取消时各 API 抛出的错误各不相同（AbortError、自定义错误等），
          // 只要信号已触发，就统一提示“已取消”，不把取消误报为执行失败。
          if (commandAbort.signal.aborted) {
            writeOutput("命令已取消\n");
          } else {
            writeOutput(
              `命令执行失败：${error instanceof Error ? error.message : String(error)}\n`,
              true,
            );
          }
        } finally {
          // 无论成功、失败还是取消，都解除“正在运行”状态，恢复 Ctrl+C 的退出行为。
          activeAbort = null;
        }

        showPrompt();
        continue;
      }

      if (!session) {
        session = createSession(model);
        writeOutput(`会话：${session.file}\n`);
      }

      writeOutput(`\n用户: ${userInput}\n\n`);

      const userAbort = new AbortController();
      activeAbort = userAbort;

      try {
        // await 会暂停当前输入循环，但 readline 仍会缓存用户已提交的后续行。
        await runAgent(userInput, userAbort, createUiRenderer(writeOutput), session);
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
    if (process.stdout.isTTY) {
      process.stdout.write(ANSI_RESET);
    }
    console.log("\n终端程序已退出");
  }
}

async function runNonInteractive(userInput: string): Promise<void> {
  // 非交互入口用于脚本和调试，复用同一 Agent 循环与事件渲染器。
  console.log(`用户: ${userInput}\n`);
  const session = createSession(model);
  // 打印当前会话文件名，便于非交互模式下追踪会话标识并在后续通过 /resume 恢复。
  console.log(`会话：${session.file}`);
  await runAgent(userInput, new AbortController(), createUiRenderer(), session);
  if (process.stdout.isTTY) {
    process.stdout.write(ANSI_RESET);
  }
}

const nonInteractiveInput = process.argv.slice(2).join(" ").trim();
let disposeExtension: (() => void) | undefined;
let disposeExternal: (() => void) | undefined;

try {
  // 内置扩展：代码中直接 import，同步装载。
  disposeExtension = mountExtension(toolRegistry, registerEcho);
  // 外部扩展（可选）：由环境变量 LCN_AGENT_EXTENSION 指定文件路径，运行时动态加载，
  // 例如 LCN_AGENT_EXTENSION=dist/extensions/upper.js。
  const extensionPath = process.env.LCN_AGENT_EXTENSION;
  if (extensionPath) {
    disposeExternal = await loadExtension(toolRegistry, extensionPath);
  }
  const config = loadConfig();
  client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  model = config.model;
  // 有命令行文本时单次运行，否则进入 readline 交互模式。
  const unlock = lockSessions();
  try {
    if (nonInteractiveInput) {
      await runNonInteractive(nonInteractiveInput);
    } else {
      await main();
    }
  } finally {
    unlock();
  }
} catch (error) {
  if (error instanceof OpenAI.APIUserAbortError) {
    console.log("请求已取消");
    process.exitCode = 0;
  } else {
    console.error(`\n请求失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} finally {
  // 按装载的逆序卸载：后装载的外部扩展先卸载。
  disposeExternal?.();
  disposeExtension?.();
}
