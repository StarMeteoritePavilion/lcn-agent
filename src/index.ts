import OpenAI from "openai";

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

// --- 流式工具调用累加器 ---
// 流式响应中工具参数是 JSON 字符串的增量片段，必须拼完才能 JSON.parse

type PendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type SteamChatResult = {
  content: string;
  toolCalls: PendingToolCall[];
  finishReason: string;
};

// --- 流式请求 ---
async function streamChat(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): Promise<SteamChatResult> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: [ECHO_TOOL],
    stream: true,
  });

  let content = "";
  let finishReason = "";
  const toolCalls: PendingToolCall[] = [];

  for await (const chunk of stream) {
    //console.log(`\n--- chunk ---\n${JSON.stringify(chunk, null, 2)}`);
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

  return { content, toolCalls, finishReason };
}

// --- Agent 循环 ---

const MAX_ROUNDS = 5;

async function main(): Promise<void> {
  const userInput = process.argv[2] ?? '请用 echo 工具回显"你好，Agent"，然后总结你做了什么。';

  console.log(`模型: ${model}`);
  console.log(`用户: ${userInput}\n`);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: userInput },
  ];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`--- 第 ${round} 轮 ---`);

    const steamChatResult = await streamChat(messages);

    console.log(`\nfinish_reason: ${steamChatResult.finishReason}`);

    // 文本结束
    if (steamChatResult.finishReason === "stop") {
      console.log(`\n完成，共 ${round} 轮`);
      return;
    }

    // 长度截断：参数可能不完整，不执行工具
    if (steamChatResult.finishReason === "length") {
      console.log("\n响应因长度截断，不执行工具");
      return;
    }

    // 工具调用
    if (steamChatResult.finishReason === "tool_calls") {
      // 1. 把 assistant 的完整消息（含 tool_calls）加入历史
      messages.push({
        role: "assistant",
        content: steamChatResult.content,
        tool_calls: steamChatResult.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      // 2. 逐个执行工具，把结果作为 tool 消息回填
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

  console.log(`\n达到最大轮次限制: ${MAX_ROUNDS}`);
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`\n请求失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
