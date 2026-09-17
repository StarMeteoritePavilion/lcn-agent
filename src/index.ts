
import { setTimeout } from "node:timers/promises";

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

function formatEvent(event: AgentEvent): string {
    if (event.type === "text") {
        // 模板字符串
        return `[文本] ${event.text}`;
    }
    return `[工具开始] ${event.toolName}`;
}

async function createTextEvent(): Promise<TextEvent> {
    await setTimeout(500);
    return {
        "type": "text",
        "text": "正在分析你的问题"
    }
}

async function main(): Promise<void> {
    try {
        console.log("开始等待文本事件");
        const textEvent = await createTextEvent();
        console.assert(formatEvent(textEvent) === "[文本] 正在分析你的问题", "文本事件格式不正确");
        console.log(formatEvent(textEvent));

        const toolStartEvent: ToolStartEvent = {
            type: "tool_start",
            toolName: "read_file"
        }

        console.assert(formatEvent(toolStartEvent) === "[工具开始] read_file", "工具开始事件格式不正确");
        console.log(formatEvent(toolStartEvent));
        console.log("处理完成");

    } catch (error) {
        if (error instanceof Error) {
            console.error(`处理失败: ${error.message}`)
        } else {
            console.error("处理失败", error)
        }
        process.exitCode = 1;
    }
}

await main();
