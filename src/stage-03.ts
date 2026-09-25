/**
 * 第三阶段：带工具调用、流式输出和终端交互的 Agent。
 *
 * 阅读顺序：文件末尾初始化 → main / runNonInteractive → runAgent → streamChat。
 * runAgent 决定下一步做什么，streamChat 收集模型响应，createUiRenderer 负责展示。
 * 一次用户输入可以包含多轮模型请求：模型请求工具 → 本地执行 → 回传结果 → 再请求模型。
 * RuntimeEvent 把这些过程通知展示层；事件不会自动发给模型，messages 才是模型上下文。
 * 每次 runAgent 都创建新的消息数组，因此这里不保留不同用户输入之间的对话历史。
 */

// OpenAI SDK：负责向兼容 OpenAI Chat Completions 接口的服务发送请求。
import OpenAI from "openai";
// readline 的光标操作函数：用于在交互输入时临时移开输入行，显示模型输出。
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
// readline/promises：提供支持 async iterator 的命令行输入接口。
import { createInterface } from "node:readline/promises";
// 读取并校验项目配置，例如 API Key、接口地址和模型名称。
import { loadConfig } from "./core/config.js";

// 在入口的错误边界内完成初始化，配置校验通过后才允许运行 Agent。
let client: OpenAI;
let model: string;

// 工具定义会发送给模型，说明可用工具和期望的参数结构；它不会替代本地运行时校验。
// 工具是否真正执行，由 Agent 核心根据模型返回的 finish_reason 决定。

const ECHO_TOOL = {
  // as const 让 TypeScript 将此值视为字面量类型 "function"，而非任意 string。
  // 它只影响类型检查，不会冻结对象，也不会执行工具。
  type: "function" as const,
  function: {
    name: "echo",
    description: "原样返回用户提供的文本",
    parameters: {
      // JSON Schema：参数应当是对象，例如 {"text":"你好"}。
      // properties 描述字段，required 表示调用时必须提供 text。
      type: "object",
      properties: {
        text: { type: "string", description: "要回显的文本" },
      },
      required: ["text"],
    },
  },
};

/**
 * 根据工具名称执行本地逻辑。
 *
 * @param name 模型提供的工具名，目前只支持 echo
 * @param args 解析后的参数；unknown 表示使用字段前需要检查实际类型
 * @returns echo 的 text 原文，包括其中的空格和换行
 * @throws 工具名不受支持或 text 不是字符串时抛错，由 runAgent 回填失败信息
 */
function executeTool(name: string, args: Record<string, unknown>): string {
  // 先按工具名路由，再校验边界参数；失败由 Agent 循环转换为工具失败结果。
  // 参数 1 name：模型请求执行的工具名称，用于选择具体的工具实现。
  // 参数 2 args：JSON.parse 后得到的工具参数对象，键名和值仍需在这里校验。
  if (name === "echo") {
    if (typeof args.text !== "string") {
      throw new Error("echo 工具参数 text 必须是 string");
    }
    return args.text;
  }

  throw new Error(`未知工具: ${name}`);
}

// RuntimeEvent 是核心与展示层之间的唯一运行时通信边界。

type PendingToolCall = {
  // 服务分配的调用 ID；回传工具结果时以 tool_call_id 引用它。
  id: string;
  // 本地 executeTool 用它选择工具实现。
  name: string;
  // 尚未解析的 JSON 文本，流式接收阶段必须先拼完整再解析。
  arguments: string;
};

// token 是模型处理文本的计量单位，不等同于字数或字符数。
// 三项数值直接取自服务，下面的 UI 只展示，不自行估算。
type Usage = {
  // 输入上下文的 token 数。
  promptTokens: number;
  // 模型生成内容的 token 数。
  completionTokens: number;
  // 服务报告的总 token 数。
  totalTokens: number;
};

// 一次模型请求的汇总结果；保留现有类型名 SteamChatResult。
type SteamChatResult = {
  content: string;
  toolCalls: PendingToolCall[];
  finishReason: string;
  usage: Usage | null;
};

// 联合类型：每个分支的 type 字面量决定该事件附带哪些字段。
// text_delta：新增文本；model_end：一次模型流结束（不等于整个任务结束）；
// tool_start / tool_end：工具执行开始 / 结束；turn_start：新一轮请求开始；
// usage：本轮用量；agent_end：整个任务结束；error：用于展示的错误消息。
type RuntimeEvent =
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "model_end";
      finishReason: string;
    }
  | {
      type: "tool_start";
      name: string;
      arguments: string;
    }
  | {
      type: "tool_end";
      name: string;
      output: string;
      success: boolean;
    }
  | {
      type: "turn_start";
      round: number;
    }
  | {
      type: "usage";
      usage: Usage | null;
    }
  | {
      type: "agent_end";
      reason: "completed" | "cancelled" | "loop_limit" | "truncated" | "error";
      round: number;
    }
  | {
      type: "error";
      message: string;
    };

// 回调接收一个事件，不返回业务结果；发送方调用它时，展示层同步处理该事件。
type EventHandler = (event: RuntimeEvent) => void;

// 展示状态：空闲、思考、工具执行，以及完成、取消、截断、轮次耗尽、错误。
// 它只记录 UI 状态，runAgent 的流程由响应结果和取消信号决定。
type UiStatus =
  | "idle"
  | "thinking"
  | "tool"
  | "completed"
  | "cancelled"
  | "truncated"
  | "loop_limit"
  | "error";

type MarkdownState = {
  // 尚未遇到换行符的文本尾部；下一个文本增量到来时继续拼接。
  pendingLine: string;
  // true 表示已遇到开头代码围栏、尚未遇到结尾围栏。
  inCodeBlock: boolean;
};

type UiState = {
  // 当前模型轮次的原始文本；不含终端格式转换产生的控制字符。
  message: string;
  // 当前模型请求的轮次编号，从 1 开始。
  round: number;
  // 正在执行的工具名称；null 表示没有正在展示的工具。
  tool: string | null;
  status: UiStatus;
  markdown: MarkdownState;
};

// ANSI 是终端控制序列。字符串中的 \u001b 是 Unicode 转义，表示 ESC 字符。
// ESC 后的 [数字m 设置文字样式，终端解释它时不把这些字符作为正文显示。
// 模板字符串 `${常量}${正文}${ANSI_RESET}` 在正文前设置样式、正文后恢复默认。
const ANSI_RESET = "\u001b[0m"; // 0：清除颜色、粗体等样式，防止影响后续提示符。
const ANSI_BOLD = "\u001b[1m"; // 1：加粗或高亮，具体效果取决于终端。
const ANSI_CYAN = "\u001b[36m"; // 36：青色，用于标题。
const ANSI_YELLOW = "\u001b[33m"; // 33：黄色，用于代码块和行内代码。

/**
 * 将一行简化的 Markdown 转成带 ANSI 样式的终端文本。
 *
 * 按“围栏 → 代码块正文 → 标题 → 列表 → 行内格式”的顺序处理。
 * 这里不是完整的 Markdown 解析器：不处理链接、表格、反斜杠转义规则等。
 * 行内替换依次执行，也不实现嵌套样式恢复；不要把它当作通用 Markdown 渲染器。
 *
 * @param line 不含末尾换行符的一行文本，也可以是结束时冲刷的最后一段
 * @param markdown 跨行共享的状态；遇到代码围栏时会修改 inCodeBlock
 * @returns 用于终端显示的字符串；围栏行返回空字符串
 */
function renderMarkdownLine(line: string, markdown: MarkdownState): string {
  // 参数 1 line：已切分出的文本行，或结束时剩余的最后一段。
  // 参数 2 markdown：当前 Markdown 状态，用于记录是否位于代码块中。
  // 返回值：转换后的终端文本；代码围栏本身返回空字符串。
  // 流式分块可能把 Markdown 标记拆开，因此只在完整行上处理格式。
  // trimStart() 只用于识别时去掉行首空白，不会修改原来的 line。
  // startsWith("```") 检查是否以三个反引号开头，也能识别 ```ts 这样的行。
  // 这里不提取语言名，也不识别 ~~~ 围栏；所有以 ``` 开头的行都切换状态。
  if (line.trimStart().startsWith("```")) {
    // 代码围栏只切换状态，不把围栏本身输出到终端。
    markdown.inCodeBlock = !markdown.inCodeBlock;
    return "";
  }

  // 代码块正文直接着色并返回，因此其中的 #、*、反引号不会再被当作行内格式。
  if (markdown.inCodeBlock) return `${ANSI_YELLOW}${line}${ANSI_RESET}`;

  // /.../ 是正则表达式字面量，不是字符串。^ / $ 分别限定行首 / 行尾。
  // (#{1,6})：捕获 1～6 个 #；\s+：至少一个空白字符；(.+)：捕获非空正文。
  // match 返回 null 或匹配数组；[0] 是整段匹配，[1]、[2] 是两组捕获内容。
  // 例如 "## 标题" 得到 ["## 标题", "##", "标题"]，最终仅显示加粗青色的“标题”。
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  // 提前 return：标题正文不会继续经过下面的粗体、行内代码替换。
  if (heading) return `${ANSI_BOLD}${ANSI_CYAN}${heading[2]}${ANSI_RESET}`;

  // (\s*)：捕获零个或多个缩进空白；[-*]：匹配一个减号或星号。
  // 字符类中位于首位的 - 表示减号本身；这里的 * 也表示星号本身。
  // 后面的 \s+ 要求列表符号与正文之间有空白，(.+) 捕获正文。
  // 例如 "  - 项目"：保留 [1] 的两个空格，将符号换成 •，再拼上 [2] 的“项目”。
  const listItem = line.match(/^(\s*)[-*]\s+(.+)$/);
  // 列表符号和行内标记只做终端展示转换，原始消息仍保存在 state.message。
  const content = listItem ? `${listItem[1]}• ${listItem[2]}` : line;

  // 第一次 replace：\* 表示字面量星号，因为正则中的裸 * 原本是重复量词。
  // 两边的 \*\* 匹配 **；(.+?) 用非贪婪匹配取最近的结束 ** 之前的非空内容。
  // 例如 "**甲** 和 **乙**" 会分别处理两处；g 表示替换所有匹配，而非仅第一处。
  // 替换字符串里的 $1 是正则第一组正文，${ANSI_BOLD} 则是模板字符串的变量插值。
  // 第二次 replace：反引号包围行内代码；[^`] 表示“不是反引号的字符”，+ 表示至少一个。
  // 例如 `text` 去掉两侧反引号后显示为黄色。两次 replace 都返回新字符串。
  return content
    .replace(/\*\*(.+?)\*\*/g, `${ANSI_BOLD}$1${ANSI_RESET}`)
    .replace(/`([^`]+)`/g, `${ANSI_YELLOW}$1${ANSI_RESET}`);
}

/**
 * 拼接文本增量，逐行输出已经完整的内容。
 *
 * 例如先收到 "**你"，后收到 "好**\n尾部"：第一次不输出，第二次输出粗体“你好”，
 * 并把“尾部”留在 pendingLine 中。这是按行缓冲，收到文本不代表会立刻显示。
 *
 * @param state 本次任务的展示状态，保存跨增量的 Markdown 缓冲
 * @param text 新收到的一段文本，可以包含零个、一个或多个换行符
 * @param write 输出回调；在 createUiRenderer 中传入的是暂存文本的 append
 */
function renderMarkdownDelta(state: UiState, text: string, write: (text: string) => void): void {
  // 参数 1 state：当前 UI 状态，函数会更新其中的 Markdown 缓冲区。
  // 参数 2 text：本次从模型流收到的文本增量，可能只包含半行内容。
  // 参数 3 write：输出回调，接收已经准备好的终端文本。
  // 缓存最后一个不完整行，避免半个标题或代码标记被提前渲染。
  state.markdown.pendingLine += text;

  // "\n" 是字符串里的换行转义，运行时是一个字符，不是反斜杠加字母 n。
  // indexOf 返回第一个换行符的位置；找不到时返回 -1。
  let newlineIndex = state.markdown.pendingLine.indexOf("\n");
  while (newlineIndex >= 0) {
    // slice(start, end) 包含 start、不包含 end，因此这一段不含换行符。
    const line = state.markdown.pendingLine.slice(0, newlineIndex);
    // 从换行符后一个字符开始，留下其余内容，避免下一轮重复处理同一行。
    state.markdown.pendingLine = state.markdown.pendingLine.slice(newlineIndex + 1);
    // 参数 1 line：刚取出的行；参数 2 markdown：与上一行共享的代码块状态。
    // 外层 write 补回换行符；围栏虽返回空字符串，这里仍会输出一个空行。
    write(`${renderMarkdownLine(line, state.markdown)}\n`);
    // 一个增量里可以含多行，每处理一行后重新寻找剩余内容中的换行符。
    newlineIndex = state.markdown.pendingLine.indexOf("\n");
  }
}

/**
 * 在结束、取消或报错时，输出未以换行符结尾的残余文本。
 * @param state 含 pendingLine 的展示状态；输出后清空该字段以免重复显示
 * @param write 接收渲染后文本的回调；此函数不会额外补换行符
 */
function flushMarkdown(state: UiState, write: (text: string) => void): void {
  // 参数 1 state：当前 UI 状态，函数会清空尚未输出的最后一行。
  // 参数 2 write：实际写入终端的回调函数。
  // 模型取消、报错或结束时都要冲刷缓存，避免丢失最后一段文字。
  if (!state.markdown.pendingLine) return;
  write(renderMarkdownLine(state.markdown.pendingLine, state.markdown));
  state.markdown.pendingLine = "";
}

/**
 * 为一次用户任务创建独立的事件渲染器。
 *
 * 返回的函数通过“闭包”持续访问 state：创建函数结束后，这份状态仍然保留，
 * 同一任务中的后续事件会继续更新它；再次调用 createUiRenderer 则创建另一份状态。
 *
 * @param write 输出函数，参数为文本和错误标记；默认按标记选择 stdout / stderr
 * @returns 接收 RuntimeEvent 的函数，负责更新状态并合并输出
 */
function createUiRenderer(
  write: (text: string, isError: boolean) => void = (text, isError) =>
    (isError ? process.stderr : process.stdout).write(text),
): EventHandler {
  // 参数 write：可选的输出函数，接收“文本内容”和“是否为错误”两个参数。
  // 未传入时，普通文本写 stdout，错误文本写 stderr。
  // 返回值：事件处理函数；Agent 核心每产生一个 RuntimeEvent 就调用它。
  // 展示层只更新状态和输出事件内容，不参与消息、工具或轮次决策。
  const state: UiState = {
    message: "",
    round: 0,
    tool: null,
    status: "idle",
    markdown: { pendingLine: "", inCodeBlock: false },
  };

  return (event) => {
    // 同一事件的输出合并后交给终端，避免半行冲刷与提示符互相穿插。
    let output = "";
    const append = (text: string): void => {
      output += text;
    };
    switch (event.type) {
      case "text_delta":
        // 原文累加用于记录，Markdown 缓冲用于显示，两者用途不同。
        state.message += event.text;
        renderMarkdownDelta(state, event.text, append);
        break;
      case "model_end":
        // 一次模型请求已经读完，先输出没有换行的尾部，再显示结束原因。
        flushMarkdown(state, append);
        append(`\nfinish_reason: ${event.finishReason}\n`);
        break;
      case "tool_start":
        state.status = "tool";
        state.tool = event.name;
        append(`\n  工具: ${event.name}(${event.arguments})\n`);
        break;
      case "tool_end":
        state.tool = null;
        append((event.success ? `  结果: ${event.output}` : `  失败: ${event.output}`) + "\n");
        break;
      case "turn_start":
        // 每轮模型输出从干净的 Markdown 状态开始，不沿用上一轮未闭合的代码块。
        state.round = event.round;
        state.status = "thinking";
        state.message = "";
        state.markdown.pendingLine = "";
        state.markdown.inCodeBlock = false;
        append(`--- 第 ${event.round} 轮 ---\n`);
        break;
      case "usage":
        // 参数 event.usage：本轮用量；append：把格式化结果加入本事件的输出缓冲。
        printUsage(event.usage, append);
        break;
      case "agent_end":
        // 整个任务终止：冲刷尾部、退出代码块状态，并清除终端样式和工具标记。
        flushMarkdown(state, append);
        state.markdown.inCodeBlock = false;
        if (process.stdout.isTTY) append(ANSI_RESET);
        state.tool = null;
        if (event.reason === "completed") state.status = "completed";
        else if (event.reason === "cancelled") state.status = "cancelled";
        else if (event.reason === "truncated") state.status = "truncated";
        else if (event.reason === "loop_limit") state.status = "loop_limit";
        else state.status = "error";
        if (event.reason === "completed") append(`\n完成，共 ${event.round} 轮\n`);
        if (event.reason === "cancelled") append("\n请求已取消\n");
        if (event.reason === "truncated") append("\n响应因长度截断，不执行工具\n");
        if (event.reason === "loop_limit") append(`\n达到最大轮次限制: ${event.round}\n`);
        break;
      case "error":
        flushMarkdown(state, append);
        state.status = "error";
        append(`\n请求失败：${event.message}\n`);
        break;
    }
    // 参数 1 output：本事件累计的所有文本；参数 2：仅 error 事件标记为错误。
    // 工具执行失败是 tool_end 事件，仍走普通输出。没有可显示文本时不调用 write。
    if (output) write(output, event.type === "error");
  };
}

// 读取一次模型流：收集完整响应，同时把文本增量和模型结束事件立即上报。

// 每轮请求的超时值，单位毫秒：30_000 等于 30000，即 30 秒。
// 数字中的下划线只是便于阅读；每轮重新创建信号，不是整个多轮任务共享 30 秒。
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 请求一次模型并读完整个响应流，把碎片汇总成一个结果。
 * @param messages 当前任务已累积的消息，将原样放入请求体
 * @param signal 本轮共享的取消信号，传给 SDK 控制请求
 * @param onEvent 文本增量和模型流结束时调用的事件处理函数
 * @returns 汇总对象，包含原文、工具调用、结束原因和本轮用量
 */
async function streamChat(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  signal: AbortSignal,
  onEvent: EventHandler,
): Promise<SteamChatResult> {
  // 参数 1 messages：发送给模型的完整上下文，包括用户、助手和工具消息。
  // 参数 2 signal：本次请求的取消信号，超时或 Ctrl+C 时会终止请求。
  // 参数 3 onEvent：流式事件回调，用于立即把文本和结束状态交给 UI。
  // 返回值：完整响应，以及拼接后的文本、工具调用、结束原因和用量。
  const stream = await client.chat.completions.create(
    {
      // 参数 1 request：Chat Completions 请求体。
      // model：要调用的模型；messages：本轮上下文；tools：允许模型选择的工具。
      // stream：true 表示服务以增量 chunk 返回结果，而不是等待完整响应。
      model,
      messages,
      tools: [ECHO_TOOL],
      stream: true,
      // include_usage: true 请求服务在流中附带用量；需要服务提供商支持。
      // 本地 usage 初始为 null，未收到用量数据时保持 null。
      stream_options: { include_usage: true },
    },
    // 参数 2 options：SDK 请求选项；signal 用于取消正在进行的 HTTP 请求。
    { signal },
  );

  let content = "";
  let finishReason = "";
  let usage: Usage | null = null;
  const toolCalls: PendingToolCall[] = [];

  // stream 是异步可迭代对象；每次循环拿到服务返回的一个增量数据块。
  for await (const chunk of stream) {
    //console.log(`\n--- chunk ---\n${JSON.stringify(chunk, null, 2)}`);

    // 用量通常位于最后一个 choices 为空的 chunk，缺失时保持 null。
    if (chunk.usage) {
      // usage chunk 可能没有 choices，因此必须先单独读取再处理 choice。
      usage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }

    // choices 是本块的响应选项数组；此处只处理下标 0，即第一个响应。
    // delta 表示新增内容，并非完整文本，所以下面要使用 += 拼接。
    const choice = chunk.choices[0];
    if (!choice) continue;

    // 文本只通过事件交给展示层，通信层不直接写终端。
    if (choice.delta.content) {
      // 通过回调接口将结果传输给调用方
      onEvent({
        type: "text_delta",
        text: choice.delta.content,
      });
      content += choice.delta.content;
    }

    // 工具参数也按调用索引累积，直到 finish_reason 表示 tool_calls 才执行。
    if (choice.delta.tool_calls) {
      for (const delta of choice.delta.tool_calls) {
        // 同一个 index 会跨多个 chunk 到达，第一次出现时先创建累积槽位。
        if (!toolCalls[delta.index]) {
          // index 是当前响应中的调用序号，不是工具 ID；多个工具的碎片可交错到达。
          // ?. 是可选链：function 不存在时得到 undefined，而不是访问属性时报错。
          // ?? 是空值合并：左侧为 null 或 undefined 时使用右侧空字符串。
          // 此实现仅在首次创建槽位时记录 id / name，后续只追加 arguments。
          toolCalls[delta.index] = {
            id: delta.id ?? "",
            name: delta.function?.name ?? "",
            arguments: "",
          };
        }
        if (delta.function?.arguments) {
          // 例如依次收到 '{"text":' 和 '"你好"}'，拼接后才形成可解析的 JSON。
          toolCalls[delta.index].arguments += delta.function.arguments;
        }
      }
    }

    // stop 表示回答完成，length 表示截断，tool_calls 表示需要回填工具结果。
    // stop: 文本结束
    // length: 响应因长度截断
    // tool_calls: 工具调用结束
    // 记录原因后仍继续读流，以接收后续独立的 usage 数据块。
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  if (!signal.aborted) {
    onEvent({
      type: "model_end",
      finishReason,
    });
  }

  return { content, toolCalls, finishReason, usage };
}

// 用量显示保留提供商原始结果；没有报告时不伪造数值。

function printUsage(usage: Usage | null, write: (text: string) => void): void {
  // 参数 1 usage：模型服务返回的 token 用量；null 表示服务没有提供用量。
  // 参数 2 write：负责把格式化后的用量文本输出到终端。
  if (!usage) {
    write("用量：未报告\n");
    return;
  }
  write(
    `用量：prompt ${usage.promptTokens} + completion ${usage.completionTokens} = ${usage.totalTokens} tokens\n`,
  );
}

// Agent 核心循环：请求模型、回填工具结果，再决定结束或进入下一轮。

// 一次用户任务最多请求模型 5 轮，防止持续调用工具形成无休止的循环。
// 一轮可以执行多个工具，因此这个值不是工具调用次数上限。
const MAX_ROUNDS = 5;

/**
 * 执行一次用户任务，循环完成“模型请求 → 工具执行 → 回填结果”。
 *
 * stop 结束任务；length 表示内容截断，直接结束；tool_calls 进入工具执行；
 * 其他结束原因进入下一轮。每轮均发出事件供 UI 展示，最多执行 MAX_ROUNDS 轮。
 *
 * @param userInput 入口整理后的用户文本，作为第一条 user 消息
 * @param userAbort 用户取消控制器，其 signal 与每轮超时信号组合
 * @param onEvent 整个任务共用的事件回调，包含模型文本事件和工具执行事件
 * @returns 任务结束时完成的 Promise；普通请求错误在内部转换为错误事件
 */
async function runAgent(
  userInput: string,
  userAbort: AbortController,
  onEvent: EventHandler,
): Promise<void> {
  // 参数 1 userInput：入口已去除首尾空白的用户文本。
  // 参数 2 userAbort：由外层创建的取消控制器，Ctrl+C 时通过它取消当前请求。
  // 参数 3 onEvent：接收轮次、文本、工具和结束事件的处理函数。
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: userInput },
  ];

  let round = 0;

  try {
    for (round = 1; round <= MAX_ROUNDS; round++) {
      // 每轮拥有自己的超时信号，同时接受用户 Ctrl+C 的取消信号。
      onEvent({
        type: "turn_start",
        round,
      });

      // 参数 REQUEST_TIMEOUT_MS：请求最长允许执行的毫秒数。
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      // 参数 1 signals：多个 AbortSignal；任意一个取消，组合信号就会取消。
      const signal = AbortSignal.any([userAbort.signal, timeout]);

      // 参数依次是消息历史、组合取消信号、展示回调；await 等待整个模型流读完。
      // 等待期间 streamChat 仍会调用 onEvent 推送文本，而非读完后才统一显示。
      const steamChatResult = await streamChat(messages, signal, onEvent);

      if (signal.aborted) {
        // 请求结束后再次检查，避免超时或 Ctrl+C 后继续执行工具。
        onEvent({ type: "agent_end", reason: "cancelled", round });
        return;
      }

      onEvent({
        type: "usage",
        usage: steamChatResult.usage,
      });

      if (steamChatResult.finishReason === "stop") {
        onEvent({
          type: "agent_end",
          reason: "completed",
          round,
        });
        return;
      }

      if (steamChatResult.finishReason === "length") {
        onEvent({ type: "agent_end", reason: "truncated", round });
        return;
      }

      if (steamChatResult.finishReason !== "tool_calls") {
        // 未知结束原因不执行工具，交给下一轮或最终轮次限制处理。
        // continue 只跳过当前轮剩余代码；这里没有追加消息，下一轮仍发送已有上下文。
        continue;
      }

      messages.push({
        // 先保存模型的 tool_calls 消息，工具结果才能与调用 ID 配对。
        role: "assistant",
        content: steamChatResult.content,
        // map 对每个内部工具调用生成一个协议对象，返回新数组。
        // 箭头函数的 ({ ... }) 表示直接返回对象；id 用来关联后面的工具结果。
        tool_calls: steamChatResult.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        })),
      });

      // 按数组顺序逐个执行工具；本实现没有并行执行工具。
      for (const tc of steamChatResult.toolCalls) {
        // 先发出开始事件，再在核心层校验参数并执行工具。
        onEvent({
          type: "tool_start",
          name: tc.name,
          arguments: tc.arguments,
        });

        let output: string;

        try {
          // JSON 解析和参数校验都在核心层完成，UI 不参与工具决策。
          // 参数 1 text：模型返回的 JSON 字符串；解析失败会进入 catch 并回填失败结果。
          const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
          // as 仅是 TypeScript 类型断言，不会把数字或 null 转成对象，也不校验 JSON 结构。
          // executeTool 检查 text 的类型；解析、字段访问或工具执行抛错都会进入下面的 catch。
          // 参数 1 tc.name：工具名；参数 2 parsed：刚解析出的值。
          output = executeTool(tc.name, parsed);

          onEvent({
            type: "tool_end",
            name: tc.name,
            output,
            success: true,
          });
        } catch (error) {
          // JavaScript 可以抛出任意值。Error 实例取 message，否则用 String 转成文本。
          // 这里只处理当前工具失败，不终止整个任务，让模型在下一轮读取失败结果。
          output = `执行失败：${error instanceof Error ? error.message : String(error)}`;

          onEvent({
            type: "tool_end",
            name: tc.name,
            output,
            success: false,
          });
        }

        messages.push({
          // 无论工具成功或失败，都把结果回填给下一轮模型请求。
          role: "tool",
          tool_call_id: tc.id,
          content: output,
        });
      }
      // 所有工具结果追加完毕后，由 for 循环进入下一轮，让模型根据结果继续回答。
    }

    // 循环自然耗尽时 round 已自增到 6，事件仍用 MAX_ROUNDS 报告实际执行的 5 轮。
    // 第 5 轮若请求工具，这些工具仍会执行，但本次任务不会再请求第 6 轮解释结果。
    onEvent({ type: "agent_end", reason: "loop_limit", round: MAX_ROUNDS });
  } catch (error) {
    if (error instanceof OpenAI.APIUserAbortError) {
      onEvent({ type: "agent_end", reason: "cancelled", round });
      return;
    }

    onEvent({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    onEvent({ type: "agent_end", reason: "error", round });
  }
}

/**
 * 运行交互式终端：逐行读取输入，为每次任务绑定取消控制器，结束时清理终端。
 * @returns 输入结束、输入 /exit 或空闲时按 Ctrl+C 后完成的 Promise
 */
async function main(): Promise<void> {
  // 交互入口只负责读取输入、绑定取消信号和消费运行事件。
  // 参数 options：绑定标准输入和标准输出，创建可异步遍历的 readline 实例。
  const input = createInterface({
    // input：从标准输入读取键盘输入（也能读取管道输入）。
    input: process.stdin,
    // output：readline 用来显示提示符并重绘编辑行的输出流。
    output: process.stdout,
  });

  // 控制器可主动调用 abort()；signal 供请求端监听，两者不是同一个对象。
  // null 表示当前没有执行任务，Ctrl+C 此时应退出程序。
  let activeAbort: AbortController | null = null;
  // 记录输入接口是否已关闭，防止关闭后再次显示提示符。
  let closed = false;

  const onSigint = (): void => {
    // 生成中取消当前请求；空闲时关闭 readline，让主循环自然退出。
    if (activeAbort) {
      activeAbort.abort();
    } else {
      input.close();
    }
  };

  const onClose = (): void => {
    // stdin 被外部关闭时，确保正在进行的模型请求也收到取消信号。
    closed = true;
    activeAbort?.abort();
  };

  const showPrompt = (): void => {
    // isTTY 表示流连接到终端；重定向到文件或管道时不显示交互提示符。
    // prompt(true) 的 true 是 preserveCursor，要求重绘时保留输入光标位置。
    if (!closed && process.stdin.isTTY && process.stdout.isTTY) input.prompt(true);
  };

  // 在完整编辑行上方插入输出，再让 readline 按原光标位置重绘输入。
  const writeOutput = (text: string, isError = false): void => {
    // text 是本次完整输出；isError 默认 false，非交互分支用它选择 stderr / stdout。
    // 下方交互分支统一通过 stdout 做光标控制与输出，不按 isError 分流。
    if (closed || !process.stdin.isTTY || !process.stdout.isTTY) {
      (isError ? process.stderr : process.stdout).write(text);
      return;
    }
    // getCursorPos() 返回编辑区光标位置；rows 是相对提示符起点的行偏移。
    // 用户输入太长发生自动换行时，rows 可大于 0，不能只清理光标所在的一行。
    const { rows } = input.getCursorPos();
    // 参数依次为输出流、水平偏移、垂直偏移；0 不横移，-rows 上移到编辑区首行。
    moveCursor(process.stdout, 0, -rows);
    // 参数 1 为输出流，参数 2 为目标列 0；省略纵坐标表示留在当前行。
    cursorTo(process.stdout, 0);
    // 参数为输出流：清除光标处及其下方内容，暂时移除提示符和已输入的文字。
    clearScreenDown(process.stdout);
    // write 不自动添加换行，text 中的换行由事件渲染器组织。
    process.stdout.write(text);
    // readline 重绘时会上移原光标行数，先留出同样的行数以保留输出。
    // repeat(rows) 生成 rows 个换行符，给 readline 接下来的重绘留出对应位置。
    process.stdout.write("\n".repeat(rows));
    showPrompt();
  };

  // 参数 1 event：监听的事件名称；参数 2 listener：事件发生时执行的回调。
  input.on("SIGINT", onSigint);
  input.on("close", onClose);
  // 参数 prompt：每次等待用户输入时显示的提示符。
  input.setPrompt("> ");

  console.log(`模型: ${model}`);
  console.log("输入内容后回车，输入 /exit 退出。");
  console.log("生成中 Ctrl+C 取消，空闲时 Ctrl+C 退出。\n");
  showPrompt();

  try {
    // input 是异步可迭代对象；每次循环得到用户提交的一整行文本。
    for await (const line of input) {
      if (closed) break;

      // trim() 去掉首尾空白；/exit 必须整行匹配；空白行仅重新显示提示符。
      const userInput = line.trim();
      if (userInput === "/exit") break;

      if (!userInput) {
        showPrompt();
        continue;
      }

      writeOutput(`\n用户: ${userInput}\n\n`);

      const userAbort = new AbortController();
      activeAbort = userAbort;

      try {
        // await 会暂停当前输入循环，但 readline 仍会缓存用户已提交的后续行。
        // 第三个参数先调用 createUiRenderer(writeOutput)，得到持有独立 UI 状态的回调。
        // writeOutput 会保护用户正在编辑的输入行；runAgent 再通过该回调展示事件。
        await runAgent(userInput, userAbort, createUiRenderer(writeOutput));
      } finally {
        // 无论完成、失败还是取消，都必须解除“正在运行”状态。
        activeAbort = null;
      }

      showPrompt();
    }
  } finally {
    // 统一清理监听器和终端 ANSI 状态，避免退出后影响用户的 Shell。
    input.close();
    // off 参数依次为事件名和原回调引用；解除此前 on 注册的同一个监听器。
    input.off("SIGINT", onSigint);
    input.off("close", onClose);
    if (process.stdout.isTTY) process.stdout.write(ANSI_RESET);
    console.log("\n终端程序已退出");
  }
}

/**
 * 执行来自命令行参数的一次任务，然后返回。
 * @param userInput 命令行参数拼接并去掉首尾空白后的文本
 */
async function runNonInteractive(userInput: string): Promise<void> {
  // 参数 userInput：命令行参数拼接出的单次用户输入，不进入 readline 交互模式。
  // 非交互入口用于脚本和调试，复用同一 Agent 循环与事件渲染器。
  console.log(`用户: ${userInput}\n`);
  // 新控制器供核心取得 signal；这里没有 main 中的 readline Ctrl+C 监听器。
  // createUiRenderer() 不传参数，使用默认输出函数，无需重绘编辑行。
  await runAgent(userInput, new AbortController(), createUiRenderer());
  if (process.stdout.isTTY) process.stdout.write(ANSI_RESET);
}

// argv[0] 是 Node 可执行文件路径，argv[1] 是入口脚本路径，slice(2) 取其后所有参数。
// join(" ") 用空格把参数拼成一句话，trim() 去掉首尾空白；空字符串进入交互模式。
const nonInteractiveInput = process.argv.slice(2).join(" ").trim();

try {
  // loadConfig 无参数：从项目配置来源读取并校验运行所需配置。
  const config = loadConfig();
  // 参数 1 options：OpenAI 客户端配置；apiKey 用于鉴权，baseURL 指定服务地址。
  client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  model = config.model;
  // 有命令行文本时单次运行，否则进入 readline 交互模式。
  if (nonInteractiveInput) await runNonInteractive(nonInteractiveInput);
  else await main();
} catch (error) {
  // 入口错误边界处理配置、初始化及入口抛出的异常；runAgent 通常已在内部处理请求错误。
  // exitCode 设置自然退出时的状态码；0 表示成功，1 表示失败，不会立刻强制结束进程。
  if (error instanceof OpenAI.APIUserAbortError) {
    console.log("请求已取消");
    process.exitCode = 0;
  } else {
    console.error(`\n请求失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
