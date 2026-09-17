
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

async function* createEventStream(): AsyncGenerator<AgentEvent> {
    await setTimeout(300);
    yield {
        "type": "text",
        "text": "正在分析你的问题"
    };

    await setTimeout(300);
    yield {
        "type": "tool_start",
        "toolName": "read_file"
    }
}

async function main(): Promise<void> {
    try {
        console.log("开始消费事件流");

        let eventCount = 0;
        for await (const event of createEventStream()) {
            eventCount += 1;
            console.log(formatEvent(event));
        }

        console.assert(eventCount === 2, "事件梳理不正确");
        console.log("事件流消费完成");

    } catch (error) {
        if (error instanceof Error) {
            console.error(`处理失败: ${error.message}`)
        } else {
            console.error("处理失败", error);
        }
        process.exitCode = 1;
    }
}

await main();
