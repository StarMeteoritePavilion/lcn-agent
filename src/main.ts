import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings } from "./base/settings.ts";
import { completion } from "./ai/index.ts";
import type { Context, Model } from "./ai/types.ts";

/**
 * 直接运行入口时加载所选模型，依次发送三条固定提示并输出每轮文本增量。
 * @returns Promise 完成表示三轮对话均已输出，或因非直接运行、配置失败或供应商缺失而提前结束。
 * @throws 最终助手消息的 stopReason 为 error 时，使用 errorMessage 创建异常并拒绝 Promise；事件消费等流程中的异常也会向上传递。
 * @remarks
 * 仅在当前模块路径与进程入口路径一致时读取当前工作目录的 setting.json 及其同目录 .env。
 * 配置加载或校验失败、所选供应商缺失时输出固定提示，设置 process.exitCode 为 1 并返回。
 * 每轮先将用户消息加入共享上下文，再实时输出 text_delta；成功后追加助手消息并输出换行，供下一轮携带完整历史。
 * length 结果仍会加入历史并继续下一轮；error 结果中断对话，此前已输出的文本不会撤回。
 * 模型请求错误在此函数中不捕获，由顶层 await 继续向运行环境传递。
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

  const promptArray = ["我正在学习流式调用。", "请根据上一句话给我一个建议。", "还有吗？"];
  const context: Context = { messages: [] };
  for (const prompt of promptArray) {
    // 每轮复用历史消息，时间戳使用 Date.now() 返回的毫秒值。
    context.messages.push({ role: "user", content: prompt, timestamp: Date.now() });
    const events = completion(model, context, { apiKey: selected.apiKey });
    for await (const event of events) {
      if (event.type === "text_delta") {
        process.stdout.write(event.delta);
      }
    }
    // error 事件也会正常完成 result()，必须检查消息状态后再决定是否加入历史。
    const message = await events.result();
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage);
    }
    context.messages.push(message);
    process.stdout.write("\n");
  }
}

// main 内部负责直接运行判断；导入本模块时提前返回，不读取配置或发送请求。
await main();
