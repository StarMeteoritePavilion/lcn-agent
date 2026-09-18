type UserMessage = {
  role: "user";
  content: string;
};

type ToolCall = {
  name: string;
  arguments: unknown;
};

type ModelTextResponse = {
  type: "text";
  text: string;
};

type ModelToolResponse = {
  type: "tool_call";
  toolCall: ToolCall;
};

type ModelResponse = ModelTextResponse | ModelToolResponse;

type ToolResult = {
  role: "tool";
  toolName: string;
  output: string;
  success: boolean;
};

type Scenario = "normal" | "unknown" | "invalid" | "failure";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function validateEchoArguments(argumentsValue: unknown): string {
  if (!isRecord(argumentsValue) || typeof argumentsValue.text !== "string") {
    throw new Error("工具参数必须包含 string 类型的 text");
  }
  return argumentsValue.text;
}

function echoTool(argumentsValue: unknown): ToolResult {
  const text = validateEchoArguments(argumentsValue);

  if (text === "触发执行异常") {
    throw new Error("echo 工具执行失败");
  }

  return {
    role: "tool",
    toolName: "echo",
    output: text,
    success: true,
  };
}

function executeTool(toolCall: ToolCall): ToolResult {
  if (toolCall.name !== "echo") {
    return {
      role: "tool",
      toolName: toolCall.name,
      output: "未知工具",
      success: false,
    };
  }

  try {
    return echoTool(toolCall.arguments);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知执行错误";

    return {
      role: "tool",
      toolName: toolCall.name,
      output: message,
      success: false,
    };
  }
}

function createToolCall(scenario: Scenario): ToolCall {
  switch (scenario) {
    case "normal":
      return {
        name: "echo",
        arguments: {
          text: "你好, Agent",
        },
      };
    case "unknown":
      return {
        name: "missing_tool",
        arguments: {
          text: "你好, Agent",
        },
      };
    case "invalid":
      return {
        name: "echo",
        arguments: {
          text: 123,
        },
      };
    case "failure":
      return {
        name: "echo",
        arguments: {
          text: "触发执行异常",
        },
      };
  }
}

async function mockModel(
  messages: Array<UserMessage | ToolResult>,
  scenario: Scenario,
): Promise<ModelResponse> {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage.role === "user") {
    return {
      type: "tool_call",
      toolCall: createToolCall(scenario),
    };
  }

  return {
    type: "text",
    text: `工具结果：${lastMessage.output}`,
  };
}

async function runAgent(scenario: Scenario): Promise<string> {
  const messages: Array<UserMessage | ToolResult> = [
    {
      role: "user",
      content: "你好, Agent",
    },
  ];

  let modelCallCount = 0;

  while (true) {
    modelCallCount++;

    const response = await mockModel(messages, scenario);
    console.log(`第 ${modelCallCount} 次模型响应:`, response);

    if (response.type === "text") {
      return response.text;
    }

    const toolResult = executeTool(response.toolCall);
    console.log("工具执行结果:", toolResult);
    messages.push(toolResult);
  }
}

async function main(): Promise<void> {
  const requestedScenario = process.argv[2] ?? "normal";
  const scenarios: Scenario[] = ["normal", "unknown", "invalid", "failure"];

  if (!scenarios.includes(requestedScenario as Scenario)) {
    throw new Error("用法: node dist/index.js [normal|unknown|invalid|failure]");
  }

  const scenario = requestedScenario as Scenario;
  const answer = await runAgent(scenario);

  console.log("最终回答:", answer);

  if (scenario === "normal" && answer !== "工具结果：你好, Agent") {
    throw new Error("正常场景最终回答不正确");
  }
}

await main();
