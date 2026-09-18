type UserMessage = {
  role: "user";
  content: string;
};

type ToolCall = {
  name: "echo";
  arguments: {
    text: string;
  };
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
};

type EcholTool = (text: string) => ToolResult;

async function mockModel(messages: Array<UserMessage | ToolResult>): Promise<ModelResponse> {
  const lastMessage = messages[messages.length - 1];

  if (lastMessage.role === "user") {
    return {
      type: "tool_call",
      toolCall: {
        name: "echo",
        arguments: {
          text: lastMessage.content,
        },
      },
    };
  }

  return {
    type: "text",
    text: `工具返回：${lastMessage.output}`,
  };
}

function echoTool(text: string): ToolResult {
  return {
    role: "tool",
    toolName: "echo",
    output: text,
  };
}

async function main(): Promise<void> {
  const messages: Array<UserMessage | ToolResult> = [
    {
      role: "user",
      content: "你好, Agent",
    },
  ];

  const firstResponse = await mockModel(messages);
  console.log("第一次模型响应：", firstResponse);

  if (firstResponse.type !== "tool_call") {
    throw new Error("第一次模型响应应该是工具调用");
  }

  const toolResult = echoTool(firstResponse.toolCall.arguments.text);

  console.log("工具执行结果：", toolResult);

  messages.push(toolResult);

  const secondResponse = await mockModel(messages);
  console.log("第二次模型响应：", secondResponse);

  if (secondResponse.type !== "text") {
    throw new Error("第二次模型响应应该是最终文本");
  }

  console.log("最终回答：", secondResponse.text);
}

await main();
