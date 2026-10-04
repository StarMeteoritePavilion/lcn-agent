import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./base/config-load.ts";

/**
 * 直接运行入口时加载配置并报告结果，导入模块时跳过启动逻辑。
 * @remarks 成功时仅输出加载成功提示；失败时输出中文提示并设置非零退出码，不输出配置内容。
 */
function main(): void {
  if (!process.argv[1] || import.meta.url !== pathToFileURL(resolve(process.argv[1])).href) {
    return;
  }
  try {
    loadConfig();
    console.log("配置加载成功。");
  } catch {
    console.error("配置加载失败，请检查 config.toml 和同目录 .env 的内容及读取权限。");
    process.exitCode = 1;
  }
}

main();
