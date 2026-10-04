# lcn-agent

使用 TypeScript 开发的 Agent 项目，目前处于基础功能开发阶段。现有入口从本地配置选择模型，向兼容 OpenAI Chat Completions 的服务发送单条消息，并输出回复。

## 当前能力

- 从 `setting.json` 加载供应商和模型配置，支持 `${key}` 环境变量替换。
- 按供应商名称与模型标识精确选择模型。
- 通过 OpenAI SDK 接收流式响应，汇总文本后一次性输出。
- 提供配置与启动入口的自动化测试，无需真实 API 密钥。

目前发送的文本固定为“你可以做什么？”，不接收命令行提示词。交互聊天、工具调用、Agent 执行循环、终端界面、MCP 和 Skills 尚未实现。

## 快速启动

需要 Node.js 22 及以上版本。建议使用 [.node-version](.node-version) 指定的 Node.js 22.23.3，以及 [package.json](package.json) 指定的 npm 10.9.9。

1. 获取源码并安装依赖：

   ```sh
   git clone https://github.com/StarMeteoritePavilion/lcn-agent.git
   cd lcn-agent
   npm ci --ignore-scripts
   ```

2. 首次使用时创建本地配置。已有文件时仅合并需要的内容，不要覆盖：

   ```sh
   cp setting.example.json setting.json
   cp .env.example .env
   ```

3. 编辑 `.env`，填写服务提供方给出的 `BASE_URL` 和 `API_KEY`。示例地址 `https://example.invalid` 无法用于真实请求。编辑 `setting.json`，将顶层 `model` 和对应供应商的 `models[].id` 设置为该服务实际支持的模型标识。示例中的模型名称不保证被你的服务支持。

4. 在项目根目录构建并运行：

   ```sh
   npm run build
   node dist/main.js
   ```

成功时终端输出模型回复。配置加载或请求失败时输出中文提示，并以非零状态退出。运行入口会调用你配置的模型服务；自动化测试使用模拟响应。

## 配置

[setting.example.json](setting.example.json) 提供一个供应商和两个模型的示例。顶层 `provider` 对应 `modelProviders` 数组中的 `name`，顶层 `model` 对应该供应商 `models` 中的 `id`。

配置路径基于当前工作目录，入口读取 `setting.json`，环境文件从其同目录读取。环境变量优先级为同目录 `.env`、进程环境变量、原占位符；必填字段中的未解析占位符会导致校验失败。

字段说明、替换规则和排错步骤见 [配置指南](docs/configuration.md)。`setting.json` 和 `.env` 已加入 Git 忽略规则，仓库只维护示例。

## 开发与贡献

```sh
npm run verify
```

该命令依次检查格式、编译测试源码、运行测试并构建应用。[CI](.github/workflows/ci.yml) 在推送和拉取请求时运行相同检查。

提交问题、开发流程及代码规范见 [贡献指南](CONTRIBUTING.md)。

各阶段已实现的功能见 [阶段功能记录](docs/stage-progress.md)。

## 目录与规划

| 路径                   | 当前职责                             |
| ---------------------- | ------------------------------------ |
| `src/main.ts`          | 加载配置、调用模型并处理输出与失败   |
| `src/base/settings.ts` | 配置读取、环境变量替换及业务校验     |
| `src/ai/`              | 兼容 OpenAI 的模型请求与流式文本汇总 |
| `test/`                | 配置模块及入口的行为测试             |
| `docs/`                | 使用说明、协议研究及学习笔记         |

后续架构方向是由顶层装配独立能力模块，逐步加入 Agent 执行循环、终端界面及其他扩展能力。当前不提前建立未实现模块，也不作为 SDK 发布。

[模型协议比较](docs/research/api/ai-protocol-comparison.md) 和 [TypeScript 学习笔记](docs/study/knowledge.md) 是研究资料，不代表已实现功能。

## 许可证

[MIT](LICENSE)，版权持有人：lcn29。
