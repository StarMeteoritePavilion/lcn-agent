# lcn-agent

使用 TypeScript 开发的 Agent 项目，已完成阶段 4 的双协议请求与配置接入。现有入口从本地配置选择模型，按供应商配置选择 OpenAI Chat Completions 或 Anthropic Messages 协议发送加法请求，校验并执行模型返回的工具调用，携带工具结果继续请求，最后输出助手内容。

## 当前能力

- 从 `setting.json` 加载供应商和模型配置，支持 `${key}` 环境变量替换。
- 按供应商名称与模型标识精确选择模型，供应商通过 `api` 显式选择接口协议，模型通过 `maxTokens` 配置默认生成预算。
- 使用 OpenAI 或 Anthropic SDK 发起流式请求，Anthropic 响应由本地 SSE 解析器读取，将文本及工具调用的开始、增量、结束和请求终态转换为助手事件。
- `completion(model, context, options)` 按 `model.api` 分发请求，返回 `Promise<AssistantMessageEventStream>`；获得事件流后可读取增量事件，或调用 `result()` 等待最终消息。
- 声明工具参数，容错解析累积的 JSON 参数，执行前按工具名称精确查找并使用 TypeBox 转换、校验参数副本。
- 入口执行 `add` 工具，将助手消息和带 `toolCallId` 的结果加入历史，最多请求四轮。
- 提供配置、启动入口、两种协议的补全接口、事件流、参数解析和校验的自动化测试，无需真实 API 密钥。

目前发送固定提示“请调用 add 计算 17 加 25。”，不接收命令行提示词。入口等待最终消息，不实时输出增量；交互聊天、通用 Agent 执行循环、终端界面、MCP 和 Skills 尚未实现。

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

3. 编辑 `.env`，填写服务提供方给出的 `BASE_URL` 和 `API_KEY`。示例域名 `example.invalid` 无法用于真实请求。编辑 `setting.json`，将顶层 `model` 和对应供应商的 `models[].id` 设置为该服务实际支持的模型标识。为每个供应商设置 `api`，使用 `openai-completions` 或 `anthropic-messages`，基础地址须与所选协议对应。模型条目的 `maxTokens` 可省略，省略时补为 16384；显式提供时必须是正整数。示例中的模型名称不保证被你的服务支持。

4. 在项目根目录构建并运行：

   ```sh
   npm run build
   node dist/main.js
   ```

成功时终端输出首个不含工具调用的助手内容数组。配置加载失败时输出中文提示；请求失败、工具不存在、参数校验失败或第四轮仍包含工具调用时抛出异常，由 Node.js 输出错误并以非零状态退出。运行入口会调用你配置的模型服务；自动化测试使用模拟响应。

## 配置

[setting.example.json](setting.example.json) 提供一个供应商和两个模型的示例。顶层 `provider` 对应 `modelProviders` 数组中的 `name`，顶层 `model` 对应该供应商 `models` 中的 `id`，该供应商的 `api` 决定请求协议，模型条目的 `maxTokens` 提供默认生成预算，省略时使用 16384。Anthropic 在未提供请求上限时使用该预算；OpenAI 仅发送显式提供的正整数 `options.maxTokens`。

配置路径基于当前工作目录，入口读取 `setting.json`，环境文件从其同目录读取。环境变量优先级为同目录 `.env`、进程环境变量、原占位符；必填字段中的未解析占位符会导致校验失败。

字段说明、替换规则和排错步骤见 [配置指南](docs/configuration.md)。两种协议生成上限规则的后续评估见 [待办](待办.md)。`setting.json` 和 `.env` 已加入 Git 忽略规则，仓库只维护示例。

## 开发与贡献

```sh
npm run verify
```

该命令依次检查格式、编译测试源码、运行测试并构建应用。[CI](.github/workflows/ci.yml) 在推送和拉取请求时运行相同检查。

提交问题、开发流程及代码规范见 [贡献指南](CONTRIBUTING.md)。

各阶段已实现的功能见 [阶段功能记录](docs/stage-progress.md)。

## 目录与规划

| 路径                               | 当前职责                                   |
| ---------------------------------- | ------------------------------------------ |
| `src/main.ts`                      | 加载配置、校验并执行加法工具、输出最终内容 |
| `src/base/settings.ts`             | 配置读取、环境变量替换及业务校验           |
| `src/ai/index.ts`                  | 按协议分发请求，提供助手消息事件流         |
| `src/ai/api/anthropic-messages.ts` | 处理 Anthropic 消息请求和 SSE 协议事件     |
| `src/ai/api/openai-completions.ts` | 转换历史、请求模型并产生助手事件           |
| `src/ai/types.ts`                  | 模型、上下文、消息、选项及事件类型         |
| `src/ai/utils/event-stream.ts`     | 事件队列、异步迭代及最终结果 Promise       |
| `src/ai/utils/json-parse.ts`       | 流式工具参数的容错解析                     |
| `src/ai/utils/validation.ts`       | 工具名称匹配、参数转换及校验               |
| `test/`                            | 配置、入口、补全接口、事件流及工具参数测试 |
| `docs/`                            | 使用说明、设计学习资料及协议研究           |

后续架构方向是由顶层装配独立能力模块，逐步加入 Agent 执行循环、终端界面及其他扩展能力。当前不提前建立未实现模块，也不作为 SDK 发布。

[事件流设计说明](docs/desin/01-event-stream.md) 解释事件交付和最终结果的关系，其中 pi 学习基准的扩展能力不代表本项目已实现。[模型协议比较](docs/research/api/ai-protocol-comparison.md) 和 [TypeScript 学习笔记](docs/study/knowledge.md) 是研究资料，不代表已实现功能。

## 许可证

[MIT](LICENSE)，版权持有人：lcn29。
