import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings } from "./base/settings.ts";
import { openaiCompletions } from "./ai/index.ts";
import type { Model } from "./ai/types.ts";

/**
 * 加载所选模型，发送固定文本并输出完整回复。
 * @returns 完成表示请求结果或失败提示已输出。
 * @remarks 失败时设置非零退出码，不输出配置、密钥或服务端错误详情。
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

  /**
   * 按名称定位已校验的供应商。
   * @param provider - 待匹配的供应商配置。
   * @returns 名称是否与顶层选择一致。
   */
  const selected = config.modelProviders.find((provider) => provider.name === config.provider);
  if (!selected) {
    console.error("未找到所选供应商配置。");
    process.exitCode = 1;
    return;
  }
  const model: Model = {
    api: "openai-completions",
    provider: config.provider,
    id: config.model,
    baseUrl: selected.baseUrl,
  };
  const text = "你可以做什么？";
  try {
    const response = await openaiCompletions(model, text, { apiKey: selected.apiKey });
    console.log(response);
  } catch {
    console.error("模型请求失败，请检查接口地址、密钥、模型权限及网络连接。");
    process.exitCode = 1;
  }
}

await main();
