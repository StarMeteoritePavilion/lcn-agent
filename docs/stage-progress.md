# 阶段功能记录

阶段 1、阶段 2、阶段 3、阶段 4、阶段 5、阶段 6 已完成。各节记录对应阶段交付时的行为；当前使用方式见 [README](../README.md)。

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

## stage-05：OpenAI Responses 与输出项转换

- 新增 `openai-responses` 协议，配置加载及 `completion` 分发支持该精确值；补全入口仍返回 `Promise<AssistantMessageEventStream>`，最终消息通过事件流的 `result()` 获取。
- Responses 使用 OpenAI SDK 的 `responses.create`，转换上下文为 `input`，设置 `stream: true`、`store: false`，禁用自动重试；函数工具使用 `strict: false`，实际执行和参数校验仍由调用方负责。
- 校验请求上限为非负有限整数、温度为 0 到 2 之间的有限数值；正数上限发送为 `max_output_tokens` 并提升到至少 16，省略或为 0 时不设置，不读取 `Model.maxTokens`。生成上限统一规则仍保留在 [待办](../待办.md)。
- 按 `output_index` 保存文本或工具槽位，转换文本、拒绝文本和函数参数增量；最终参数替换累计原文，只在其包含原有前缀时补发剩余增量，内容结束时移除槽位及内部参数原文。
- 助手消息新增可选 `responseId`，文本新增可选 `textSignature`，保存版本 1 的消息项标识及 `phase`；历史转换接受版本化签名和旧版纯字符串标识，超过 64 字符的消息标识通过 `shortHash` 缩短。
- 工具调用标识保存为 `call_id|item.id`，结果发送为 `function_call_output`；仅在历史模型与请求模型标识相同且输出项标识以 `fc_` 开头时保留该输出项标识。
- 必须收到 Responses 终态事件；正常完成且包含工具调用时返回 `toolUse`，`incomplete.max_output_tokens` 返回 `length`，其他未完成原因及失败事件返回错误消息。正常工具终态仍留有内部参数原文时报告未结束调用，异常清理内部字段并保留累计内容。
- 新增 Responses 请求、事件、文本签名、工具补齐及错误路径测试，更新协议配置和入口分发的回归检查。当前只有一个 Responses 入口，消息转换、工具转换及事件处理保持模块私有，没有新增 shared 模块、Azure 或 Codex 请求入口。
- 补充 [Responses 文件组织说明](desin/02-openai-responses-shared.md)。推理与用量事件、服务端会话续接、取消请求和通用 Agent 执行循环尚未实现。

## stage-06：Google Generative AI 与工具思考签名

- 新增 `google-generative-ai` 协议，配置加载和 `completion` 支持该精确值；通过 Google SDK 的 `models.generateContentStream` 发起请求，公共事件流及最终结果读取方式保持不变。
- Google 客户端使用供应商的 `baseUrl` 和空 `apiVersion`，密钥发送为 `x-goog-api-key`；当前仅允许省略 `options.fetch` 或传入同一 `globalThis.fetch`，独立自定义实现返回错误消息。
- 请求上限校验为非负有限整数、温度为 0 到 2 之间的有限数值，二者显式 0 均保留；上限发送为 `maxOutputTokens`，省略时不设置，也不读取 `Model.maxTokens`。生成上限统一规则仍记录在 [待办](../待办.md)。
- 上下文转换为 `contents`，助手角色转换为 `model`，系统提示词使用 `systemInstruction`，工具声明使用 `functionDeclarations` 与 `parametersJsonSchema`。Google 协议模块的 `toolChoice` 精确接受 `auto`、`none`、`any`，分别映射为 SDK 的 `AUTO`、`NONE`、`ANY`。
- 工具结果通过 `functionResponse` 回填，正常结果使用 `output`，失败结果使用 `error`，连续结果合并到同一 `user` 内容项；接口模块只返回工具调用，不执行工具或替代本地参数校验。
- 忽略标记为 `thought: true` 的文本；普通文本的思考签名保存到 `textSignature`，工具签名保存到新增的 `ToolCall.thoughtSignature`。签名原文保留，历史回传要求供应商及模型标识完全一致，并通过非空、长度为 4 的倍数及 Base64 字符形式检查，不解码或验证真实性。
- Google 历史中的 `functionCall.id` 和 `functionResponse.id` 沿用模型兼容规则：原始标识以 `claude-` 或 `gpt-oss-` 开头，或 Gemini 主版本不低于 3 时回传；Gemini 版本提取先对内部副本转为小写，再匹配 `/^gemini(?:-live)?-(\d+)/`。此过程不修改发送给服务的模型标识，也不改变供应商及模型的精确选择。
- 每个函数调用创建独立内容块，接口调用标识缺失或与本轮已有工具块重复时生成本地标识，发送 `toolcall_start`、包含参数对象 JSON 字符串的 `toolcall_delta` 及 `toolcall_end`；调用前结束当前文本块，后续文本另建块，流结束时结束剩余文本块。
- 仅处理首项响应内容并保留首次响应标识；`STOP` 和 `CONTINUATION` 映射为 `stop`，含工具调用时改为 `toolUse`；`MAX_TOKENS` 映射为 `length`，过滤等其他已列出的原因映射为错误，未知原因或缺少结束原因也返回错误消息。当前不自动续写。
- 新增 Google 请求、文本与工具事件、签名、历史转换、参数边界及错误路径测试，同步四协议配置与使用说明。推理文本事件、用量事件、取消请求、交互输入和通用 Agent 执行循环尚未实现。
- 编译配置的 `lib` 加入 TypeScript 内置 `DOM` 类型，补齐 Google SDK 声明依赖的 `RequestInfo`、`ErrorEvent`、`CloseEvent` 和 `HeadersInit` 等 Web 类型；运行环境仍为 Node.js，没有启用跳过第三方类型校验。

## 阶段 6 后的编译配置整理

- 显式设置 `moduleResolution: "NodeNext"` 和 `allowImportingTsExtensions: true`，继续通过 `rewriteRelativeImportExtensions` 转换构建产物中的相对导入扩展名。
- 移除显式 `lib`，使用包含 `DOM` 的默认标准库；未设置 `skipLibCheck`，保留声明文件检查。源码、测试和运行环境保持原有职责。
