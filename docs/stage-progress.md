# 阶段功能记录

阶段 1、阶段 2、阶段 3、阶段 4 已完成。各节记录对应阶段交付时的行为；当前使用方式见 [README](../README.md)。

## stage-01：空白项目与最小聊天闭环

- 建立 TypeScript、ESM、npm 项目，配置格式检查、测试、构建和 CI。
- 从 `setting.json` 读取配置，支持 `${key}` 递归替换，优先使用同目录 `.env`，再使用进程环境变量。
- 通过 `provider` 匹配供应商 `name`，通过 `model` 匹配所选供应商的模型 `id`，校验必填字段和供应商名称唯一性。
- 使用 OpenAI SDK 调用 Chat Completions，传入配置中的接口地址、API 密钥和模型标识。
- 以 `stream: true` 接收响应，在内部累积文本，结束后返回完整字符串；阶段 1 的终端一次性输出回复。
- 入口发送固定消息“你可以做什么？”，配置或请求失败时输出中文提示并设置非零退出码，不打印密钥。
- 检查流的结束原因，接受 `stop` 和 `length`，拒绝其他非空结束原因及缺少结束原因的流。
- 补充配置加载和入口行为测试，支持直接运行 TypeScript 测试及编译后运行测试。

## stage-02：助手事件流与多轮对话演示

- 将补全入口改为 `completion(model, context, options)`，立即返回 `AssistantMessageEventStream`；请求在后台异步执行，调用方通过异步迭代读取事件，通过 `result()` 获取最终助手消息。
- 定义模型、上下文、用户与助手消息、文本块及流式选项，助手消息保留来源标识、毫秒级时间戳、结束状态、原始结束原因和错误说明。
- 发送 `start`、`text_start`、`text_delta`、`text_end`、`done` 和 `error` 事件；适配器累积最终文本，事件中的 `partial` 引用同一个持续更新的消息对象。
- 使用双数组 FIFO 队列缓存事件和等待者。多个迭代器共享队列、分摊事件；终结事件独立完成最终结果，生产者调用 `end()` 唤醒剩余等待者。
- 将系统提示词及用户、助手历史转换为 Chat Completions 请求消息，不修改传入上下文；当前仅支持文本，补全入口统一委托给 `openai-completions`。
- 支持 `apiKey`、`maxTokens`、`temperature` 和自定义 `fetch`。校验生成参数；正整数 `options.maxTokens` 发送为 `max_completion_tokens`，省略或为 0 时不设置，`model.maxTokens` 不作为请求上限。请求禁用自动重试。
- 接受 `stop`、`end` 和 `length`，其中 `end` 映射为 `stop`；其他非空结束原因及缺少结束原因的流转为错误结果，保留已累积文本。`done` 和 `error` 均正常完成 `result()`，调用方必须检查 `stopReason`。
- 入口依次发送“我正在学习流式调用。”“请根据上一句话给我一个建议。”“还有吗？”，实时输出文本增量。每轮成功后将助手消息加入共享历史，`length` 结果继续下一轮；错误结果抛出异常并中断对话，保留已输出文本。
- 新增补全接口及事件流测试，更新入口测试，覆盖请求参数、历史转换、事件顺序、共享引用、结束原因、错误结果、等待者唤醒和三轮对话。
- 补充 [事件流设计说明](desin/01-event-stream.md)，区分本地实现与 pi 学习基准中的扩展能力。交互输入、工具调用、多协议分发和取消请求尚未实现。

## stage-03：工具调用、参数校验与执行闭环

- 将 `completion(model, context, options)` 改为返回 `Promise<AssistantMessage>`，直接等待最终消息；增量消费使用 `openai-completions.ts` 的 `stream` 和同一流的 `result()`。
- 新增 `Tool`、`ToolCall` 和 `ToolResultMessage`，上下文支持工具声明，助手内容支持文本与工具调用；请求转换支持 `tools`、历史 `tool_calls` 和通过 `tool_call_id` 关联的工具结果。
- 新增 `toolcall_start`、`toolcall_delta` 和 `toolcall_end` 事件，按接口的 `index`、其次按 `id` 关联分片并累积参数；事件的 `contentIndex` 是本地内容块索引。
- 新增 `parseStreamingJson`，尝试完整解析、修复字符串转义和部分 JSON 解析；解析失败回退为空对象，解析结果不代表通过工具参数校验。
- 新增 `validateToolCall`，精确查找工具名称，深拷贝参数后使用 TypeBox 转换和校验，保留原始参数；校验失败抛出包含字段路径的异常。
- `tool_calls` 和 `function_call` 结束原因映射为 `toolUse`；当前只处理 `delta.tool_calls`，不解析旧版 `delta.function_call`。接口模块返回调用内容，不执行工具。
- 入口发送“请调用 add 计算 17 加 25。”，按声明校验每个调用后执行加法，依次保存助手消息和全部工具结果，最多请求四次；不含工具调用时输出内容数组，第四轮仍有调用则报错。入口不再消费增量事件。
- 更新补全和入口测试，补充工具分片、历史转换、Promise 返回、工具执行与轮次上限的检查，新增 JSON 参数解析与 TypeBox 校验测试。通用 Agent 执行循环、交互输入、多协议分发和取消请求尚未实现。

## stage-04：Anthropic 接入与双协议配置

- 新增 `anthropic-messages` 实现，使用 Anthropic SDK 发起 Messages 流式请求，将文本、工具调用及结束状态转换为既有助手事件；请求禁用自动重试。
- `completion(model, context, options)` 按 `model.api` 分发至 `openai-completions` 或 `anthropic-messages`，返回 `Promise<AssistantMessageEventStream>`；调用方取得事件流后可读取增量，或通过 `result()` 等待最终助手消息。不支持的接口类型会使 Promise 拒绝。
- 供应商配置新增必填 `api`，仅接受上述两种协议的精确值；模型条目新增可选 `maxTokens`，省略时补为 16384，显式值必须是正整数。入口按精确标识选取模型条目，并将该值传入运行时 `Model.maxTokens`。
- Anthropic 将非空系统提示词发送为 `system`，助手工具调用转换为 `tool_use`，连续工具结果合并到一条 `user` 消息中的 `tool_result`，保留 `tool_use_id` 和 `is_error`；工具声明使用 `input_schema` 并启用 `eager_input_streaming`。
- Anthropic 通过本地 SSE 解析器处理命名事件、UTF-8 网络分片、LF／CR／CRLF、多行 `data` 及尾部剩余事件，复用导出的 `parseJsonWithRepair` 修复 JSON 字符串转义；流错误、解析失败或消息开始后缺少 `message_stop` 均转为错误结果，保留累计内容。
- Anthropic 按协议 `index` 关联内容块，在 `content_block_stop` 时发送内容结束事件；`end_turn`、`pause_turn` 和 `stop_sequence` 映射为 `stop`，`max_tokens` 映射为 `length`，`tool_use` 映射为 `toolUse`，拒绝、敏感内容及未支持的结束原因返回错误消息。不自动续写暂停或截断的回合。
- Anthropic 的 `max_tokens` 使用 `options.maxTokens`，省略时使用模型上限，显式 0 保留；OpenAI 仍仅发送显式正整数请求上限，省略或为 0 时不发送 `max_completion_tokens`，不读取模型上限。统一规则保留在 [待办](../待办.md)，尚未完成。
- 入口将配置组装、加法工具执行和有界对话拆为内部函数，沿用最多四轮、按实际工具内容逐个执行并回填结果的行为；第四轮工具结果仍会加入历史，随后报告轮次上限。取得不含工具调用的消息后输出内容数组，不消费增量事件。
- 新增 Anthropic 请求、历史转换、SSE 解码及错误路径测试，更新配置、协议分发、入口、参数解析与校验的回归测试。通用 Agent 执行循环、交互输入、推理与用量事件、取消请求尚未实现。
