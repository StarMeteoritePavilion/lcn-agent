import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { loadSettings } from "./base/settings.ts";
import { completion } from "./ai/index.ts";
import type { AssistantMessage, Context, Model, Tool, ToolCall } from "./ai/types.ts";
import { validateToolCall } from "./ai/utils/validation.ts";

/** 供模型选择的加法工具声明；这里只描述参数，具体计算在 main 中执行。 */
const tool: Tool = {
  name: "add",
  description: "计算两个数字之和",
  parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
};

/**
 * 直接运行入口时加载模型，演示加法工具调用并输出最终助手内容。
 * @returns Promise 完成表示已输出首个不含工具调用的助手内容，或因非直接运行、配置失败或供应商缺失而提前返回。
 * @throws 模型返回 error、工具不存在、工具参数校验失败、校验后 a 或 b 不是数字，或第四轮仍包含工具调用时拒绝 Promise。
 * @remarks
 * 配置路径为当前工作目录的 setting.json，环境变量替换及业务校验由 loadSettings 完成。
 * 配置加载或供应商定位失败时输出固定提示并设置 process.exitCode 为 1；模型和工具处理异常向顶层 await 传递。
 * 最多请求模型四次，每轮将助手消息及全部工具结果按顺序加入同一上下文。
 * 是否继续执行工具以消息中的 toolCall 内容块为准，不仅依据 stopReason；length 结果也按同样规则处理。
 * 本入口等待每次请求的最终消息，并通过 console.log 输出内容数组，不消费文本增量事件。
 */
async function main(): Promise<void> {
  if (!process.argv[1] || import.meta.url !== pathToFileURL(resolve(process.argv[1])).href) {
    return;
  }

  let config: ReturnType<typeof loadSettings>;
  try {
    config = loadSettings("setting.json");
  } catch {
    console.error("模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。");
    process.exitCode = 1;
    return;
  }

  const selected = config.modelProviders.find(
    /**
     * 判断已校验的供应商名称是否与顶层选择精确匹配。
     * @param provider - 待匹配的供应商配置。
     * @returns 名称与 config.provider 完全一致时返回 true，否则返回 false。
     * @remarks 不转换大小写，也不修改名称或选择配置。
     */
    (provider: (typeof config.modelProviders)[number]): boolean =>
      provider.name === config.provider,
  );
  if (!selected) {
    console.error("未找到所选供应商配置。");
    process.exitCode = 1;
    return;
  }
  const model: Model = {
    id: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: selected.baseUrl,
    // 此字段仅记录模型配置；请求上限需通过 options.maxTokens 传入，本入口未设置该选项。
    maxTokens: 500000,
  };

  const context: Context = {
    tools: [tool],
    messages: [{ role: "user", content: "请调用 add 计算 17 加 25。", timestamp: Date.now() }],
  };

  for (let turn = 0; turn < 4; turn++) {
    const assistantMessage = await completion(model, context, { apiKey: selected.apiKey });

    if (assistantMessage.stopReason === "error") {
      throw new Error(assistantMessage.errorMessage);
    }
    // 先记录模型的调用消息，再追加带相同 toolCallId 的结果，下一轮接口才能关联调用和执行结果。
    context.messages.push(assistantMessage);
    const calls = assistantMessage.content.filter(
      /**
       * 从混合内容中筛选需要本地执行的工具调用。
       * @param block - 助手生成的文本块或工具调用块。
       * @returns type 为 toolCall 时返回 true，并将该块收窄为 ToolCall。
       */
      (block: AssistantMessage["content"][number]): block is ToolCall => block.type === "toolCall",
    );
    if (calls.length === 0) {
      console.log(assistantMessage.content);
      break;
    }

    for (const call of calls) {
      // 模型给出的参数属于外部输入，先按工具声明校验；通过后仍检查数字类型，供 TypeScript 安全参与运算。
      const args = validateToolCall([tool], call);
      if (typeof args.a !== "number" || typeof args.b !== "number") {
        throw new Error("校验后的参数类型错误");
      }
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: String(args.a + args.b) }],
        isError: false,
        timestamp: Date.now(),
      });
    }

    // 有界循环避免模型持续请求工具；第四轮仍有调用时，明确报告未获得最终答复。
    if (turn === 3) {
      throw new Error("示例达到四轮上限；请检查调用记录");
    }
  }
}

// main 内部负责直接运行判断；导入本模块时提前返回，不读取配置或发送请求。
await main();
