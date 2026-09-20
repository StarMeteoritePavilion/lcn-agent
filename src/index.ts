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

// --- 流式请求 ---

const REQUEST_TIMEOUT_MS = 30_000;

async function streamChat(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  signal: AbortSignal,
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
      // 将结果输出到控制台
      process.stdout.write(choice.delta.content);
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

async function main(): Promise<void> {
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`模型: ${model}`);
  console.log(`输入内容后回车，输入 /exit 退出。\n`);

  try {
    for await (const line of input) {
      const userInput = line.trim();

      if (userInput === "/exit") {
        break;
      }

      if (!userInput) {
        continue;
      }

      console.log(`\n用户: ${userInput}\n`);

      const userAbort = new AbortController();
      const onSigint = (): void => {
        console.log("\n\n用户取消 (Ctrl+C)");
        userAbort.abort();
      };

      input.on("SIGINT", onSigint);

      try {
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: "user", content: userInput },
        ];

        let completed = false;

        try {
          for (let round = 1; round <= MAX_ROUNDS; round++) {
            console.log(`--- 第 ${round} 轮 ---`);

            const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
            const signal = AbortSignal.any([userAbort.signal, timeout]);

            const steamChatResult = await streamChat(messages, signal);

            if (signal.aborted) {
              console.log("\n请求已取消");
              completed = true;
              break;
            }

            console.log(`\nfinish_reason: ${steamChatResult.finishReason}`);
            printUsage(steamChatResult.usage);

            if (steamChatResult.finishReason === "stop") {
              console.log(`\n完成，共 ${round} 轮`);
              completed = true;
              break;
            }

            if (steamChatResult.finishReason === "length") {
              console.log("\n响应因长度截断，不执行工具");
              completed = true;
              break;
            }

            if (steamChatResult.finishReason === "tool_calls") {
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
                console.log(`\n  工具: ${tc.name}(${tc.arguments})`);

                let output: string;

                try {
                  const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
                  output = executeTool(tc.name, parsed);
                  console.log(`  结果: ${output}`);
                } catch (error) {
                  output = `执行失败：${error instanceof Error ? error.message : String(error)}`;
                  console.log(`  失败: ${output}`);
                }

                messages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  content: output,
                });

                console.log("");
              }
            }
          }
        } catch (error) {
          if (error instanceof OpenAI.APIUserAbortError) {
            console.log("请求已取消");
            completed = true;
          } else {
            throw error;
          }
        }
      } finally {
        input.off("SIGINT", onSigint);
      }
    }
  } finally {
    input.close();
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
