#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * @file CLI 统一可执行入口脚本（package.json bin 指向此文件）。
 *
 * 核心架构与设计目标：
 * 1. 轻量前置路由：将 `--help`、`-h` 和 `--version` 放在最顶层拦截处理，
 *    无需读取任何 `config.toml` 或 `.env` 配置文件，不创建会话锁，不加载重量级业务依赖，实现零依赖毫秒级响应；
 * 2. 动态懒加载宿主：当用户真正发起交互或单次命令时，通过 `await import("./index.js")` 动态加载宿主逻辑，
 *    保证主入口的庞大类型、扩展注册表、大模型 SDK 和会话系统仅在实际运行时才被解析与执行；
 * 3. 跨平台兼容性：首行 `#!/usr/bin/env node` 适配 Linux/macOS 全局 bin 软链接执行权限。
 */

// 帮助和版本不加载宿主，因此无需模型配置，也不会创建会话、锁或启动扩展。
const option = process.argv[2];
if (option === "--help" || option === "-h") {
  console.log(`用法：lcn-agent [--demo] [输入内容]

无参数进入交互终端；提供输入内容则运行一次。
  --demo       使用本机模拟模型，必须放在输入内容之前，无需 API Key
  --help, -h   显示帮助
  --version    显示版本

真实模型模式从当前工作目录读取 config.toml 和可选的 .env。
会话、扩展启停设置与诊断保存在当前目录的 .lcn-agent 中。
演示示例：lcn-agent --demo "回显 你好"
终端输入 /extensions 查看扩展，/exit 退出。`);
} else if (option === "--version") {
  // 读取安装包内的 package.json 获取版本号，不硬编码版本字符串
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(manifest.version);
} else {
  // 仅在实际运行交互或非交互 Agent 时才动态加载完整的核心循环
  await import("./index.js");
}
