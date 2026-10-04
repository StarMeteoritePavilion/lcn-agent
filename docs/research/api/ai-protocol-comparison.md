# 四种模型协议的入参与返回值比较

OpenAI SDK 源码引用固定到 `openai@7.19.0` 对应的[提交 `15f6e40`](https://github.com/openai/openai-node/tree/15f6e408a0359df50ee7a996616957cc14988659)；字段与行号以该版本为准。

对照文档：[OpenAI Chat Completions](./openai-chat-completions.md)、[OpenAI Responses](./openai-responses.md)、[Anthropic Messages](./anthropic-messages.md)、[Google Gemini](./google-gemini.md)。

下表比较服务端原始协议；SDK 便利字段单独说明。可选参数、工具和输出模态的支持情况取决于模型，不能仅凭字段存在推导所有模型均支持。

## 1. 基础请求与响应

| 对照项       | Chat Completions                       | Responses                                                                         | Anthropic Messages                                                   | Gemini Developer API                                       |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| 创建端点     | `POST /v1/chat/completions`            | `POST /v1/responses`                                                              | `POST /v1/messages`                                                  | `POST /v1beta/models/{model}:generateContent`              |
| 模型位置     | 正文 `model`                           | 正文 `model`                                                                      | 正文 `model`                                                         | URL 中的 `{model}`                                         |
| 普通文本输入 | `messages` 数组                        | `input` 字符串或条目数组                                                          | `messages` 数组                                                      | `contents` 数组                                            |
| 基础参数     | `model`、`messages` 必填               | 普通请求显式传 `model`、`input`；当前 SDK 类型将其标为可选                        | `model`、`messages`、`max_tokens` 必填                               | URL 模型与正文 `contents` 必填                             |
| 常规对话角色 | `user`、`assistant`                    | `user`、`assistant`；工具结果是独立条目                                           | `user`、`assistant`                                                  | `user`、`model`                                            |
| 系统指令     | `messages` 中的 `system` / `developer` | 顶层 `instructions`，或输入中的指令消息                                           | 顶层 `system`；当前角色类型也列出 `system`，常规系统提示采用顶层参数 | 顶层 `systemInstruction`，使用 `Content` 结构              |
| 输入文本块   | `{"type":"text","text":...}`           | `{"type":"input_text","text":...}`                                                | `{"type":"text","text":...}`                                         | `{"text":...}`，没有文本块 `type`                          |
| 输出容器     | `choices[i].message`                   | `output[i]`                                                                       | 顶层 `content[i]`                                                    | `candidates[i].content.parts[j]`                           |
| 文本位置     | `message.content`，字符串或 `null`     | `type: "message"` 条目内的 `content[j]`，选择 `type: "output_text"` 后读取 `text` | 选择 `type: "text"` 后读取 `text`                                    | 读取 `text`，展示答案时排除 `thought: true` 的块           |
| 多个生成结果 | `n` 控制 `choices` 数量                | `output` 是不同类型的生成条目，不是多份答案选项                                   | `content` 是同一消息的内容块，不是多份答案选项                       | `generationConfig.candidateCount` 控制结果数量             |
| 下一轮上下文 | 在 `messages` 中回传历史               | 回传 `input` 历史，或使用 `previous_response_id` / `conversation`                 | 在 `messages` 中回传历史                                             | 在 `contents` 中回传历史；`cachedContent` 可引用缓存上下文 |

依据：[Chat 请求与消息][聊天请求]、[Responses 请求][响应请求]、[Anthropic 请求][消息请求]、[Anthropic 角色][消息角色]、[Gemini 请求及内容][生成接口]、[Gemini SDK 文本提取][生成SDK文本]。

Responses 的 `previous_response_id` 与 `conversation` 不能同时使用；上一响应的 `instructions` 不会自动延续。响应 ID、缓存 ID 和工具调用 ID 用途不同，不能当作统一的“会话 ID”。[响应请求]

## 2. 同一需求如何追加参数

| 需求            | Chat Completions                                                                                     | Responses                                                             | Anthropic Messages                                                          | Gemini Developer API                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 限制输出预算    | `max_completion_tokens`                                                                              | `max_output_tokens`                                                   | `max_tokens`                                                                | `generationConfig.maxOutputTokens`                                                  |
| JSON 文本       | `response_format.type: "json_object"`                                                                | `text.format.type: "json_object"`                                     | 支持结构化 JSON 的 `output_config.format`；不要套用 OpenAI 的 `json_object` | `generationConfig.responseMimeType: "application/json"`                             |
| JSON Schema     | `response_format.type: "json_schema"`，`response_format.json_schema` 内含 `name`、`schema`、`strict` | `text.format`，内含 `type: "json_schema"`、`name`、`schema`、`strict` | `output_config.format`，内含 `type: "json_schema"`、`schema`                | `generationConfig.responseJsonSchema` 配合 JSON MIME 类型；与 `responseSchema` 互斥 |
| 调整思考投入    | `reasoning_effort`                                                                                   | `reasoning.effort`                                                    | `thinking` 与 `output_config.effort`，按模式和模型选择                      | `generationConfig.thinkingConfig.thinkingBudget` / `thinkingLevel`                  |
| 请求思考摘要    | 当前标准消息类型未声明通用可读思考字段                                                               | `reasoning.summary` → `output` 中 `reasoning.summary`                 | 思考配置可返回 `thinking` 块；`display` 控制展示                            | `thinkingConfig.includeThoughts: true` → 可返回 `thought: true` 的块                |
| 文本 token 概率 | `logprobs: true`，可加 `top_logprobs`                                                                | `include: ["message.output_text.logprobs"]`，可加 `top_logprobs`      | 本文所比较的标准创建参数未声明对应概率开关                                  | `generationConfig.responseLogprobs: true`，可加 `logprobs`                          |
| 网络搜索        | `web_search_options` → 消息 `annotations`                                                            | `tools` 中 `web_search` → 调用条目及文本注解                          | 版本化搜索工具 → `server_tool_use`、搜索结果及文本引用                      | `tools` 中 `googleSearch` → 结果的 `groundingMetadata`                              |
| 扩充返回数据    | 各功能参数分别控制                                                                                   | `include` 可请求搜索结果、推理密文、概率等数据                        | 引用、思考、缓存等功能参数分别控制                                          | 各功能配置控制媒体、概率、检索依据等数据                                            |

依据：[Chat 输出配置][聊天配置]、[Responses 输出配置][响应请求]、[Responses JSON 格式][响应JSON]、[Anthropic 输出配置][消息输出配置]、[Anthropic 思考][消息思考]、[Gemini 生成配置][生成接口]。

四种协议的结构化回答仍位于文本字段中，原始 HTTP 响应不会因此直接变成业务对象；拒绝或截断时也不能无条件解析 JSON。工具输入 schema 与最终回答 schema 是两套不同配置。[聊天配置]、[响应JSON]、[消息结构化]、[生成接口]

Gemini 的新 REST 配置为 `generationConfig.responseFormat.text`，JSON MIME 枚举为 `APPLICATION_JSON`；官方参考将 `responseSchema` 标为弃用。四篇文档所引用的 SDK 转换器仍支持 `responseJsonSchema`，尚未提供 `GenerateContentConfig.responseFormat`，不能将新 REST 对象直接套到 SDK `config` 中。[生成接口]、[生成SDK转换]

## 3. 函数工具调用与结果回传

以下比较调用方执行的函数工具；服务端搜索、代码解释器等工具有各自的结果结构。

| 对照项         | Chat Completions                                 | Responses                                                    | Anthropic Messages                                                                     | Gemini Developer API                                                         |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 函数定义位置   | `tools[i].function`，工具 `type: "function"`     | `tools[i]`，工具 `type: "function"`                          | `tools[i]`，使用 `name`、`input_schema`                                                | `tools[i].functionDeclarations[j]`                                           |
| 输入 schema 键 | `function.parameters`                            | `parameters`                                                 | `input_schema`                                                                         | `parameters` 或 `parametersJsonSchema`，互斥                                 |
| 自主调用       | `tool_choice: "auto"`                            | `tool_choice: "auto"`                                        | `tool_choice: {"type":"auto"}`                                                         | `toolConfig.functionCallingConfig.mode: "AUTO"`                              |
| 必须调用       | `tool_choice: "required"`                        | `tool_choice: "required"`                                    | `tool_choice: {"type":"any"}`，支持受模型与思考模式限制                                | 模式 `ANY`                                                                   |
| 指定函数       | `{"type":"function","function":{"name":...}}`    | `{"type":"function","name":...}`                             | `{"type":"tool","name":...}`                                                           | `ANY` 配合 `allowedFunctionNames`                                            |
| 禁止调用       | `tool_choice: "none"`                            | `tool_choice: "none"`                                        | `tool_choice: {"type":"none"}`                                                         | 模式 `NONE`                                                                  |
| 并行控制       | 顶层 `parallel_tool_calls`                       | 顶层 `parallel_tool_calls`                                   | `tool_choice.disable_parallel_tool_use`，开关含义相反                                  | 读取同轮多个 `functionCall`；不能套用左侧协议的并行开关                      |
| 返回调用位置   | `message.tool_calls[j]`                          | `output[i]` 中的 `function_call`                             | `content[i]` 中的 `tool_use`                                                           | `parts[j].functionCall`                                                      |
| 名称与参数     | `function.name`、`function.arguments`            | `name`、`arguments`                                          | `name`、`input`                                                                        | `name`、`args`                                                               |
| 最终参数形态   | JSON 字符串，需解析                              | JSON 字符串，需解析                                          | 结构化 JSON 值，仍需校验                                                               | JSON 对象，仍需校验                                                          |
| 结果关联       | 调用 `id` → `tool_call_id`                       | 调用 `call_id` → 结果 `call_id`；不能用条目 `id` 代替        | 调用 `id` → `tool_use_id`                                                              | 名称一致；调用提供 `id` 时，结果回传匹配的 `id`                              |
| 结果容器       | `messages` 中 `role: "tool"`，结果写入 `content` | `input` 中 `type: "function_call_output"`，结果写入 `output` | `messages[i].role: "user"`，`content[j].type: "tool_result"`，结果写入该块的 `content` | `contents[i].role: "user"`，`parts[j].functionResponse` 内的 `response` 对象 |
| 工具执行失败   | `content` 的业务数据表达错误                     | `output` 的业务数据表达错误                                  | `tool_result.is_error: true`                                                           | `functionResponse.response.error` 可携带错误                                 |

依据：[Chat 工具与结果][聊天工具]、[Responses 函数][响应工具]、[Responses 工具结果][响应工具结果]、[Anthropic 工具][消息工具]、[Anthropic 结果][消息工具结果]、[Gemini 函数结构][生成接口]、[Gemini 调用模式][生成调用模式]。

无论哪种协议，收到函数调用都不表示业务函数已经执行。工具参数生成完成、当前响应结束和工具闭环完成是三个不同状态。回传结果时保留上一轮模型内容；带推理上下文的响应还需按协议保留相关条目、签名或密文。[响应工具]、[消息处理工具]、[响应推理]、[生成接口]

Anthropic 的工具结果消息须紧接助手调用消息，同一用户消息内的工具结果块放在普通文本之前。Gemini 回传时保留原模型内容块和签名。[消息处理工具]、[生成接口]

## 4. 流式结构与完成信号

| 对照项       | Chat Completions                                                        | Responses                                                                                         | Anthropic Messages                                                | Gemini Developer API                                         |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| 开启方式     | 正文 `stream: true`                                                     | 正文 `stream: true`                                                                               | 正文 `stream: true`                                               | 改用 `:streamGenerateContent?alt=sse`                        |
| 事件结构     | SSE `data` 内为 `chat.completion.chunk`                                 | SSE 命名事件，负载带对应 `type`                                                                   | SSE 命名事件，负载带对应 `type`                                   | SSE `data` 内为 `GenerateContentResponse`                    |
| 文本增量     | `choices[i].delta.content`                                              | `response.output_text.delta` 的字符串 `delta`                                                     | `content_block_delta` 中 `delta.type: "text_delta"`、`delta.text` | 当前片段 `candidates[i].content.parts[j].text`               |
| 关联依据     | `choice.index`；工具另有调用 `index`                                    | `item_id`、`output_index`、`content_index`                                                        | 内容块 `index`                                                    | 生成结果 `index`，再按内容类型和到达顺序处理                 |
| 函数参数增量 | `delta.tool_calls[j].function.arguments`                                | `response.function_call_arguments.delta` 的 `delta`                                               | `input_json_delta.partial_json`                                   | 读取 `functionCall` 对象；不能套用前三者的参数字符串路径     |
| 结束判断     | 每个结果的 `finish_reason`；传输末尾 `[DONE]`                           | `response.completed` / `response.incomplete` / `response.failed`；文本 `.done` 不代表整个响应完成 | `message_delta` 更新停止原因，`message_stop` 结束消息             | 读取 `finishReason` 并处理流结束；没有 `[DONE]` 标记         |
| 用量获取     | `stream_options.include_usage: true` 请求最终用量片段，其 `choices: []` | 终态事件内 `response.usage`                                                                       | 开始事件及后续 `message_delta.usage`；后者为累计值                | 读取片段中的请求级 `usageMetadata`，不能把它当每片段新增用量 |
| SDK 最终对象 | `finalChatCompletion()`                                                 | `finalResponse()`，返回后仍需检查 `status`                                                        | `finalMessage()`                                                  | `generateContentStream()` 逐份产出响应，调用方聚合           |

依据：[Chat 流式][聊天流式]、[Responses 事件][响应事件]、[Responses SDK 聚合][响应SDK流]、[Anthropic 流式指南][消息流式]、[Gemini 流式及用量][生成接口]、[Gemini SDK 流][生成SDK流]。

用量片段、思考片段、调用片段可能没有回答文本。中断的流不能保证收到最终用量或正常终态；不要把流结束、HTTP 200 或已显示部分文本当成回答完整的充分条件。

## 5. 停止、思考与用量

| 对照项       | Chat Completions                                        | Responses                                                | Anthropic Messages                                                     | Gemini Developer API                                         |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| 正常完成     | `finish_reason: "stop"`                                 | `status: "completed"`                                    | `stop_reason: "end_turn"`                                              | `finishReason: "STOP"`                                       |
| 输出截断     | `finish_reason: "length"`                               | `status: "incomplete"`，查看 `incomplete_details.reason` | `stop_reason: "max_tokens"`                                            | `finishReason: "MAX_TOKENS"`                                 |
| 函数调用状态 | `finish_reason: "tool_calls"`                           | 查看 `output` 的 `function_call`，没有同名停止原因       | `stop_reason: "tool_use"`                                              | 查看 `functionCall`；没有专用 `tool_calls` 停止原因          |
| 拒绝或过滤   | `message.refusal`、`content_filter`                     | `refusal` 内容块、`error`、未完成详情                    | `refusal` 停止原因与 `stop_details`                                    | 输入 `promptFeedback` 或结果 `finishReason`、`safetyRatings` |
| 推理上下文   | 不应把兼容服务的 `reasoning_content` 当标准字段         | `reasoning` 条目的摘要及 `encrypted_content`             | `thinking` 的文本及 `signature`；`redacted_thinking.data`              | `thought: true` 标记及 `thoughtSignature`                    |
| 输入总量     | `usage.prompt_tokens`                                   | `usage.input_tokens`                                     | `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` | `usageMetadata.promptTokenCount`                             |
| 缓存读取     | `prompt_tokens_details.cached_tokens`，包含在输入总量内 | `input_tokens_details.cached_tokens`，包含在输入总量内   | `cache_read_input_tokens`，不含在 `input_tokens` 内                    | `cachedContentTokenCount`，包含在 `promptTokenCount` 内      |
| 输出计数     | `completion_tokens`，包含推理                           | `output_tokens`，包含推理                                | `output_tokens`，包含思考                                              | `candidatesTokenCount`；思考另报 `thoughtsTokenCount`        |
| 推理细分     | `completion_tokens_details.reasoning_tokens`            | `output_tokens_details.reasoning_tokens`                 | `output_tokens_details.thinking_tokens`                                | `thoughtsTokenCount`                                         |
| 请求总量     | `usage.total_tokens`                                    | `usage.total_tokens`                                     | 标准用量对象未声明 `total_tokens`；需按输入、输出口径统计              | `usageMetadata.totalTokenCount`，直接读取服务端值            |
| 缓存配置     | `prompt_cache_key` / `prompt_cache_options` 等          | `prompt_cache_key` / `prompt_cache_options` 等           | 顶层或块级 `cache_control`，TTL 为 `5m` / `1h`                         | 引用预先创建的 `cachedContent`                               |

依据：[Chat 用量][聊天用量]、[Responses 用量][响应用量]、[Responses 推理][响应推理]、[Anthropic 消息及用量][消息用量]、[Anthropic 思考细分][消息思考计数]、[Anthropic 缓存口径][消息缓存]、[Gemini 用量定义][生成SDK用量]。

OpenAI 与 Anthropic 的推理计数属于已报告输出的细分，不应再加到输出或请求总量中。Gemini 分别报告生成结果、思考及工具输入计数；所引用的 SDK 将总量定义为 `promptTokenCount + candidatesTokenCount + toolUsePromptTokenCount + thoughtsTokenCount`，不能只按输入加答案计数估算。[聊天用量]、[消息思考计数]、[生成SDK用量]

思考摘要、签名和加密内容不可互换。签名用于后续上下文，不等于可读思考；不要丢弃、修改或把它从原内容块移到别处。[响应推理]、[消息思考]、[生成接口]

## 6. 多模态、来源引用与 SDK 字段

| 对照项            | Chat Completions                      | Responses                                           | Anthropic Messages                                    | Gemini Developer API                                         |
| ----------------- | ------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| 图片输入          | `type: "image_url"`，`image_url.url`  | `type: "input_image"`，`image_url` / `file_id`      | `type: "image"`，`source` 提供 URL、Base64 或文件引用 | `inlineData` 或 `fileData`，配合 `mimeType`                  |
| 搜索引用位置      | `message.annotations[j].url_citation` | 文本块 `annotations[j]`，URL 等字段直接位于注解对象 | 文本块 `citations[j]`，字段依定位类型变化             | 结果的 `groundingMetadata`，以来源列表和支持片段关联         |
| SDK 文本便利字段  | 原响应已有 `message.content`          | 顶层 `output_text` 拼接所有消息文本块               | `finalText()` 拼接最终消息文本块                      | `text` 访问器读取首个结果的非思考文本                        |
| SDK JSON 解析字段 | `message.parsed`                      | 顶层 `output_parsed`、文本块 `parsed`               | 顶层及文本块 `parsed_output`                          | 本文所比较的生成响应没有对应 JSON 解析字段，调用方解析文本   |
| SDK 函数参数解析  | `function.parsed_arguments`           | 调用条目 `parsed_arguments`                         | 原始 `tool_use.input` 已是 JSON 值                    | `functionCalls` 提取原调用对象；`args` 已是 JSON 对象        |
| 请求标识包装      | `_request_id` 来自 `x-request-id`     | `_request_id` 来自 `x-request-id`                   | `_request_id` 来自 `request-id`                       | 协议含 `responseId`；SDK 的 `sdkHttpResponse` 保存 HTTP 信息 |

依据：[Chat 消息与图片][聊天媒体]、[Responses 消息及图片][响应媒体]、[Anthropic 内容类型][消息内容]、[Gemini 内容及引用][生成接口]、[Chat SDK 解析][聊天SDK解析]、[Responses SDK 解析][响应SDK解析]、[Anthropic SDK 解析][消息SDK解析]、[Gemini SDK 访问器][生成SDK文本]。

SDK 解析字段和便利访问器不是追加请求参数后服务端新增的原始 JSON 字段。OpenAI、Anthropic 的 `signal`、`timeout`、`maxRetries`，以及 Gemini 的 `config.abortSignal`、`config.httpOptions` 都属于客户端控制；取消客户端请求也不能统一解释为服务端已停止生成。[聊天请求选项]、[生成SDK配置]

跨协议适配时至少分别处理输入角色、输出内容类型、停止原因、调用关联、流式聚合、用量口径和原样回传的推理上下文。只改端点、模型名和字段大小写，无法完成这些结构转换。

[聊天请求]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2073
[聊天配置]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2267
[聊天工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1731
[聊天流式]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L812
[聊天用量]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/completions.ts#L122
[聊天媒体]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1284
[聊天SDK解析]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/parser.ts#L325
[聊天请求选项]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/internal/request-options.ts#L38
[响应请求]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10735
[响应JSON]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3246
[响应工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3597
[响应工具结果]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4464
[响应事件]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L8155
[响应SDK流]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/responses/ResponseStream.ts#L309
[响应用量]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L8516
[响应推理]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6989
[响应媒体]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4236
[响应SDK解析]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/ResponsesParser.ts#L108
[消息请求]: https://platform.claude.com/docs/en/api/messages/create
[消息角色]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2707-L2711
[消息输出配置]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2760-L2773
[消息工具]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3386-L3558
[消息工具结果]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3580-L3607
[消息处理工具]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
[消息结构化]: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
[消息思考]: https://platform.claude.com/docs/en/build-with-claude/thinking
[消息流式]: https://platform.claude.com/docs/en/build-with-claude/streaming
[消息用量]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2508-L2640
[消息思考计数]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2775-L2788
[消息缓存]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[消息内容]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2286-L2302
[消息SDK解析]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/parser.ts#L28-L123
[生成接口]: https://ai.google.dev/api/generate-content
[生成调用模式]: https://ai.google.dev/api/caching#FunctionCallingConfig
[生成SDK转换]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/converters/_models_converters.ts#L1466-L2063
[生成SDK文本]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3777-L3970
[生成SDK流]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/models.ts#L851-L895
[生成SDK用量]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3741-L3766
[生成SDK配置]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3095-L3104
