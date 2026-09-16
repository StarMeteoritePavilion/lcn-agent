
type TextEvent = {
    type: "text";
    text: string;
};

type ToolStartEvent = {
    type: "tool_start";
    toolName: string;
};

type AgentEvent = TextEvent | ToolStartEvent;

const textEvent: AgentEvent = {
    type: "text",
    text: "正在分析你的问题"
};

const toolStartEvent: AgentEvent = {
    type: "tool_start",
    toolName: "read_file"
};

console.log(textEvent);
console.log(toolStartEvent);
