
type TextEvent = {
    // 对象字段, 类似于常量值
    type: "text";
    text: string;
};

type ToolStartEvent = {
    type: "tool_start";
    toolName: string;
};

// 联合类型, 值可以符合这两种类型中的任意一种
type AgentEvent = TextEvent | ToolStartEvent;

const textEvent: AgentEvent = {
    type: "text",
    text: "正在分析你的问题"
};

const toolStartEvent: AgentEvent = {
    type: "tool_start",
    toolName: "read_file"
};

console.assert(formatEvent(textEvent) === "[文本] 正在分析你的问题", "文本事件格式不正确");
console.assert(formatEvent(toolStartEvent) === "[工具开始] read_file", "工具开始事件格式不正确");


console.log(formatEvent(textEvent));
console.log(formatEvent(toolStartEvent));

function formatEvent(event: AgentEvent): string {
    if (event.type === "text") {
        // 模板字符串
        return `[文本] ${event.text}`;
    }
    return `[工具开始] ${event.toolName}`;
}
