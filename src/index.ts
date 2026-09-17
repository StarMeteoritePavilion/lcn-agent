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

type ToolEndEvent = {
  type: "tool_end";
  toolName: string;
  success: boolean;
};

// 联合类型, 值可以符合这两种类型中的任意一种
type AgentEvent = TextEvent | ToolStartEvent | ToolEndEvent;

function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case "text":
      return `[文本] ${event.text}`;
    case "tool_start":
      return `[工具开始] ${event.toolName}`;
    case "tool_end":
      return `[工具结束] ${event.toolName} ${event.success ? "成功" : "失败"}`;
  }
}

// 事件列表，模拟一个较长的 Agent 执行过程
const EVENTS: AgentEvent[] = [
  { type: "text", text: "正在分析你的问题" },
  { type: "tool_start", toolName: "read_file" },
  { type: "tool_end", toolName: "read_file", success: true },
  { type: "text", text: "已读取文件内容" },
  { type: "tool_start", toolName: "write_file" },
  { type: "tool_end", toolName: "write_file", success: true },
  { type: "text", text: "任务完成" },
];

async function* createEventStream(
  signal: AbortSignal,
  shouldFail: boolean,
): AsyncGenerator<AgentEvent> {
  for (let i = 0; i < EVENTS.length; i++) {
    if (signal.aborted) {
      console.log("  (事件流检测到取消信号，停止产生新事件)");
      return;
    }

    // 模拟异常：在第 3 个事件后抛出错误
    if (shouldFail && i === 3) {
      throw new Error("模拟的工具执行异常：文件不存在");
    }

    await setTimeout(300, undefined, { signal });
    yield EVENTS[i];
  }
}

async function runNormal(signal: AbortSignal): Promise<void> {
  console.log("=== 正常模式：完整执行所有事件 ===\n");

  let count = 0;
  for await (const event of createEventStream(signal, false)) {
    count += 1;
    console.log(`  #${count} ${formatEvent(event)}`);
  }

  console.log(`\n完成，共 ${count} 个事件`);
}

async function runCancel(signal: AbortSignal): Promise<void> {
  console.log("=== 取消模式：600ms 后取消 ===\n");

  const controller = new AbortController();

  // 父信号取消时也取消子信号
  signal.addEventListener("abort", () => controller.abort(), { once: true });

  // 600ms 后取消，预期在第 2 个事件之后、第 3 个事件之前
  const cancelTimer = globalThis.setTimeout(() => {
    console.log("  (用户发出取消信号)");
    controller.abort();
  }, 600);

  try {
    let count = 0;
    for await (const event of createEventStream(controller.signal, false)) {
      count += 1;
      console.log(`  #${count} ${formatEvent(event)}`);
    }
    console.log(`\n取消后正常结束，共 ${count} 个事件（少于 ${EVENTS.length}）`);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log("\n事件流已被取消");
    } else {
      throw error;
    }
  } finally {
    clearTimeout(cancelTimer);
  }
}

async function runError(signal: AbortSignal): Promise<void> {
  console.log("=== 异常模式：第 3 个事件后抛出异常 ===\n");

  let count = 0;
  for await (const event of createEventStream(signal, true)) {
    count += 1;
    console.log(`  #${count} ${formatEvent(event)}`);
  }

  console.log(`\n完成，共 ${count} 个事件`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "normal";

  // 顶层 AbortController，真实场景中用于接收进程信号
  const controller = new AbortController();

  try {
    switch (mode) {
      case "normal":
        await runNormal(controller.signal);
        break;
      case "cancel":
        await runCancel(controller.signal);
        break;
      case "error":
        await runError(controller.signal);
        break;
      default:
        console.log("用法: node dist/index.js [normal|cancel|error]");
        break;
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n处理失败: ${error.message}`);
    } else {
      console.error("\n处理失败", error);
    }
    process.exitCode = 1;
  }
}

await main();
