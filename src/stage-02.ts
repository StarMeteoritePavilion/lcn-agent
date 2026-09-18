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

type Scenario = "text" | "normal" | "unknown" | "invalid" | "failure" | "loop";

type RuntimeEvent =
  | {
      type: "model_response";
      round: number;
      response: ModelResponse;
    }
  | {
      type: "tool_start";
      round: number;
      toolName: string;
    }
  | {
      type: "tool_end";
      round: number;
      result: ToolResult;
    }
  | {
      type: "final_answer";
      round: number;
      text: string;
    }
  | {
      type: "loop_limit";
      maxRounds: number;
    };

function emitEvent(event: RuntimeEvent): void {
  console.log("[运行事件]", event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    case "loop":
      return {
        name: "echo",
        arguments: {
          text: "继续调用工具",
        },
      };
    case "text":
      throw new Error("text 场景不应创建工具调用");
  }
}

async function mockModel(
  messages: Array<UserMessage | ToolResult>,
  scenario: Scenario,
): Promise<ModelResponse> {
  const lastMessage = messages[messages.length - 1];

  if (scenario === "text") {
    return {
      type: "text",
      text: "无需调用工具的回答",
    };
  }

  if (scenario === "loop" || lastMessage.role === "user") {
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

async function runAgent(scenario: Scenario, maxRounds: number): Promise<string> {
  const messages: Array<UserMessage | ToolResult> = [
    {
      role: "user",
      content: "你好, Agent",
    },
  ];

  let modelCallCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const response = await mockModel(messages, scenario);
    emitEvent({
      type: "model_response",
      round,
      response,
    });

    if (response.type === "text") {
      emitEvent({
        type: "final_answer",
        round,
        text: response.text,
      });
      return response.text;
    }

    emitEvent({
      type: "tool_start",
      round,
      toolName: response.toolCall.name,
    });

    const toolResult = executeTool(response.toolCall);
    emitEvent({
      type: "tool_end",
      round,
      result: toolResult,
    });

    messages.push(toolResult);
  }

  emitEvent({
    type: "loop_limit",
    maxRounds,
  });
  throw new Error(`达到最大轮次限制：${maxRounds}`);
}

async function main(): Promise<void> {
  const requestedScenario = process.argv[2] ?? "normal";
  const scenarios: Scenario[] = ["text", "normal", "unknown", "invalid", "failure", "loop"];

  if (!scenarios.includes(requestedScenario as Scenario)) {
    throw new Error(`用法: node dist/index.js [${scenarios.join("|")}]`);
  }

  const scenario = requestedScenario as Scenario;
  const answer = await runAgent(scenario, 3);

  console.log("最终回答:", answer);
}

await main();
