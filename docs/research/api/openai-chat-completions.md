# OpenAI Chat Completions 入参与返回值

OpenAI SDK 源码引用固定到 `openai@7.19.0` 对应的[提交 `15f6e40`](https://github.com/openai/openai-node/tree/15f6e408a0359df50ee7a996616957cc14988659)；字段与行号以该版本为准。

接口：`POST /v1/chat/completions`。必填入参为 `model` 和 `messages`，非流式回答位于 `choices[i].message`。[创建][创建]、[请求参数][请求参数]

以下示例仅展示结构；模型 ID 需替换为实际可用值。可选参数与返回字段的支持情况取决于模型和服务。[创建][创建]

## 1. 基础入参与返回值

### 1.1 最小文本请求

不同消息角色有不同字段约束：[消息联合][消息联合]

```json
{
  "model": "<OPENAI_MODEL 的实际值>",
  "messages": [{ "role": "user", "content": "请用中文打个招呼。" }]
}
```

| 入参路径                   | 含义与约束                                                                                              | 证据                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `model`                    | 实际使用的模型 ID；由配置、模型目录或服务方资料确认                                                     | [请求参数][请求参数]                                             |
| `messages`                 | 对话消息数组；多轮请求需把需要保留的历史作为输入                                                        | [请求参数][请求参数]                                             |
| `messages[i].role`         | 当前类型联合包含 `developer`、`system`、`user`、`assistant`、`tool` 和已弃用的 `function` 消息          | [消息联合][消息联合]                                             |
| `messages[i].content`      | `user` 可为文本或内容块数组；`system`、`developer` 为文本或文本块；`assistant` 带工具调用时可不提供文本 | [用户消息][用户消息]、[指令消息][指令消息]、[助手输入][助手输入] |
| `messages[i].name`         | 一部分消息角色可提供的参与者名称，用来区分同角色参与者；不是工具结果的关联 ID                           | [用户消息][用户消息]、[指令消息][指令消息]                       |
| `messages[i].tool_call_id` | `role: "tool"` 时必填，关联上一轮对应的工具调用                                                         | [工具结果][工具结果]                                             |

### 1.2 非流式响应

普通文本响应示例：[完整响应][完整响应]、[助手输出][助手输出]、[用量][用量]

```json
{
  "id": "chatcmpl-example",
  "object": "chat.completion",
  "created": 0,
  "model": "<OPENAI_MODEL 的实际值>",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "你好！", "refusal": null },
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": { "prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13 }
}
```

| 返回路径                     | 含义                                  | 是否固定有内容                                  | 证据                                       |
| ---------------------------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| `id`                         | 本次聊天补全的标识                    | SDK 完整响应类型必填                            | [完整响应][完整响应]                       |
| `object`                     | 完整响应固定为 `chat.completion`      | 必填                                            | [完整响应][完整响应]                       |
| `created`                    | 创建时间，Unix 秒；不是毫秒           | 必填                                            | [完整响应][完整响应]                       |
| `model`                      | 实际用于本次补全的模型                | 必填；读取响应中的值                            | [完整响应][完整响应]                       |
| `choices`                    | 生成结果数组                          | 必填；不能把数组长度固定为 1                    | [完整响应][完整响应]                       |
| `choices[i].index`           | 该结果的索引                          | 必填                                            | [完整响应][完整响应]                       |
| `choices[i].message.role`    | 输出消息角色，固定为 `assistant`      | 必填                                            | [助手输出][助手输出]                       |
| `choices[i].message.content` | 回答文本                              | 类型为 `string \| null`；不能总按非空字符串处理 | [助手输出][助手输出]                       |
| `choices[i].message.refusal` | 模型拒绝回答的说明                    | 类型为 `string \| null`                         | [助手输出][助手输出]                       |
| `choices[i].finish_reason`   | 该结果的生成停止原因                  | 完整响应非空；含义见下表                        | [完整响应][完整响应]                       |
| `choices[i].logprobs`        | 输出 token 的对数概率信息             | 未请求时通常为 `null`                           | [概率参数][概率参数]、[完整响应][完整响应] |
| `usage`                      | 请求级 token 用量，含输入、输出和合计 | SDK 标为可选；不要以其存在作为解析文本的前提    | [完整响应][完整响应]、[用量][用量]         |
| `service_tier`               | 实际使用的服务处理层级                | 可选；可能不同于请求值                          | [服务层级][服务层级]                       |
| `system_fingerprint`         | 模型后端配置指纹                      | 可选，当前 SDK 已标记弃用                       | [完整响应][完整响应]                       |
| `metadata`、`moderation`     | 对象元数据、请求及输出的审核信息      | 当前 SDK 声明的可选字段，见第 4 节              | [完整响应][完整响应]                       |

`finish_reason` 表示生成停止原因：[停止原因](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L430)

| 值               | 含义                                                    |
| ---------------- | ------------------------------------------------------- |
| `stop`           | 自然停止，或命中设置的停止序列                          |
| `length`         | 达到请求设置的生成 token 上限；回答或工具参数可能不完整 |
| `tool_calls`     | 模型产出了工具调用，调用方随后负责执行和回传            |
| `content_filter` | 内容过滤导致部分内容被省略                              |
| `function_call`  | 旧函数调用方式，已弃用                                  |

## 2. 追加参数与返回变化

参数可能新增字段、改变已有字段内容，或切换为流式返回。

| 追加或修改的入参                                                            | 返回值的具体变化                                                                                                            | 不应误解成什么                                                                  | 证据                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `stream: true`                                                              | 一次完整 JSON 改为 SSE 中的多份 `chat.completion.chunk`；`choices[i].message` 改为增量 `choices[i].delta`                   | 每个片段不是完整消息                                                            | [流式参数][流式参数]、[流式响应][流式响应]               |
| `stream_options: { "include_usage": true }`，同时 `stream: true`            | `[DONE]` 前增加请求级用量片段：`choices: []`、`usage` 为完整用量；其他片段的 `usage` 为 `null`                              | 中断或取消后不保证收到最后用量；不是逐片段新增 token 数                         | [流式选项][流式选项]                                     |
| `tools`，函数工具                                                           | 若模型调用工具，出现 `choices[i].message.tool_calls[j]`，含 `id`、`type: "function"`、`function.name`、`function.arguments` | `arguments` 是 JSON 字符串；声明工具不会自动执行它                              | [工具参数][工具参数]、[函数调用][函数调用]               |
| `tool_choice: "auto" / "required" / "none"` 或指定函数                      | 控制是否产出上述 `tool_calls`；`required` 要求一个或多个调用，`none` 禁止工具调用                                           | 不增加一个名为 `tool_choice` 的返回字段                                         | [工具参数][工具参数]                                     |
| `parallel_tool_calls: true / false`                                         | 控制是否允许一轮产生并行函数调用；同一 `message.tool_calls` 可包含多个条目                                                  | 不增加 `parallel_tool_calls` 返回字段，也不会替调用方并发执行函数               | [请求参数][请求参数]                                     |
| `response_format: { "type": "json_object" }`                                | `message.content` 改为 JSON 文本；须在消息中明确要求生成 JSON                                                               | 外层响应结构不变；不保证符合自定义业务 schema                                   | [JSON 格式][JSON 格式]                                   |
| `response_format: { "type": "json_schema", "json_schema": ... }`            | `message.content` 仍是字符串，按声明的 schema 生成 JSON；`strict: true` 使用支持的 JSON Schema 子集                         | HTTP 响应不会因此自动新增 `message.parsed`；拒绝、截断仍需处理                  | [JSON 格式][JSON 格式]、[SDK 解析][SDK 解析]             |
| `logprobs: true`                                                            | `choices[i].logprobs.content` 或 `.refusal` 内出现 token 及概率信息                                                         | 不是给整条答案评一个可靠性分数                                                  | [概率参数][概率参数]、[概率结构][概率结构]               |
| `top_logprobs: k`，同时 `logprobs: true`                                    | 每个 token 的 `top_logprobs` 列出最多 `k` 个高概率 token，包含 `token`、`logprob`、`bytes`；`k` 为 0–20                     | 实际返回项可少于 `k`；不是多份回答                                              | [工具参数][工具参数]、[概率结构][概率结构]               |
| `n: 2` 等                                                                   | `choices` 包含多个生成结果，分别有 `index`；用量统计覆盖本次请求                                                            | 不是每条输入消息各返回一个结果；按全部生成 token 计费                           | [请求参数][请求参数]、[完整响应][完整响应]               |
| `modalities: ["text", "audio"]` 与 `audio: { "voice": ..., "format": ... }` | 音频输出模型可返回 `message.audio`，含 `id`、`data`、`expires_at`、`transcript`                                             | `data` 是音频字节的 Base64 字符串，不是下载地址                                 | [音频参数][音频参数]、[音频输出][音频输出]               |
| 用户内容块 `type: "image_url"` 与 `image_url`                               | 增加图片输入；输出通常仍走 `message.content`；用量类型支持 `prompt_tokens_details.image_tokens`                             | 传入图片不代表输出会包含生成图片或新增 `message.image`                          | [图片输入][图片输入]、[用量][用量]、[助手输出][助手输出] |
| 用户内容块 `type: "input_audio"` 与 `input_audio`                           | 增加音频输入；用量类型支持 `prompt_tokens_details.audio_tokens`；是否输出音频取决于输出模态                                 | 音频输入本身不等于开启音频输出                                                  | [音频输入][音频输入]、[音频参数][音频参数]、[用量][用量] |
| `web_search_options`                                                        | 在支持网络搜索的模型和场景中，回答可附 `message.annotations`，类型为 `url_citation`                                         | Chat Completions 的此选项不是 Responses API 的 `tools: [{"type":"web_search"}]` | [搜索配置][搜索配置]、[搜索引用][搜索引用]               |
| `reasoning_effort`                                                          | 调整推理投入；`usage.completion_tokens_details.reasoning_tokens` 可记录推理 token 用量                                      | 不意味着 OpenAI 返回 `message.reasoning_content` 或可读思维链                   | [推理参数][推理参数]、[用量][用量]、[助手输出][助手输出] |
| `prediction: { "type": "content", "content": ... }`                         | 用静态预测内容辅助生成；用量可含 `accepted_prediction_tokens`、`rejected_prediction_tokens`                                 | 不新增 `message.prediction`，也不保证全部预测内容被采用                         | [预测内容][预测内容]、[用量][用量]                       |
| `service_tier`                                                              | 响应可包含 `service_tier`，表示实际使用的处理层级，可能不同于请求                                                           | 不能仅根据请求值判断实际层级                                                    | [服务层级][服务层级]                                     |

### 2.1 流式返回

追加 `stream: true` 和 `stream_options: { "include_usage": true, "include_obfuscation": false }` 后，返回 SSE；`[DONE]` 为结束标记。[流式响应][流式响应]、[流式选项][流式选项]、[SSE 解析][SSE 解析]

```text
data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":0,"model":"<OPENAI_MODEL 的实际值>","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}

data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":0,"model":"<OPENAI_MODEL 的实际值>","choices":[{"index":0,"delta":{"content":"你好！"},"finish_reason":null}],"usage":null}

data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":0,"model":"<OPENAI_MODEL 的实际值>","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}

data: {"id":"chatcmpl-example","object":"chat.completion.chunk","created":0,"model":"<OPENAI_MODEL 的实际值>","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}

data: [DONE]
```

解析时按 `choices[i].index` 分别累积 `delta.content`；`delta.role`、`content`、`refusal` 和 `tool_calls` 均为可选增量。工具调用还要按 `delta.tool_calls[j].index` 累积各自的 `function.arguments`，不能把分片直接当成完整 JSON。`finish_reason` 在生成期间可为 `null`，结束片段才给出原因；收到用量片段的 `choices: []` 时不能读取 `choices[0].delta`。[增量结构][增量结构]

`finalChatCompletion()` 是 SDK 在客户端聚合片段得到的完整对象。[SDK 聚合](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/ChatCompletionStream.ts#L1747)

### 2.2 工具调用

追加工具定义与调用策略：[工具参数][工具参数]

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "add",
        "description": "计算两个有限数字的和。",
        "strict": true,
        "parameters": {
          "type": "object",
          "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
          "required": ["a", "b"],
          "additionalProperties": false
        }
      }
    }
  ],
  "tool_choice": { "type": "function", "function": { "name": "add" } },
  "parallel_tool_calls": false
}
```

```json
{
  "index": 0,
  "message": {
    "role": "assistant",
    "content": null,
    "refusal": null,
    "tool_calls": [
      {
        "id": "call-example",
        "type": "function",
        "function": { "name": "add", "arguments": "{\"a\":2,\"b\":3}" }
      }
    ]
  },
  "finish_reason": "tool_calls",
  "logprobs": null
}
```

调用方校验并执行工具后，下一次请求保留助手工具调用消息，再追加 `{"role":"tool","tool_call_id":"call-example","content":"{\"ok\":true,\"sum\":5}"}`。`tool_call_id` 关联原调用；`content` 的业务结构由调用方定义。[助手输入][助手输入]、[工具结果][工具结果]、[函数调用][函数调用]

### 2.3 JSON 输出

追加 `response_format`，约束回答的 JSON 结构：[JSON 格式][JSON 格式]

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "summary",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "answer": { "type": "string" }, "language": { "type": "string" } },
        "required": ["answer", "language"],
        "additionalProperties": false
      }
    }
  }
}
```

`choices[0].message.content` 仍是字符串，例如 `"{\"answer\":\"你好！\",\"language\":\"中文\"}"`。`message.parsed` 和工具的 `function.parsed_arguments` 由 SDK 本地追加。SDK `parse()` 在 `length`、`content_filter` 时抛出异常，拒绝回答时 `parsed` 为 `null`。[助手输出][助手输出]、[SDK 解析][SDK 解析]

## 3. 返回字段细分

| 返回路径                                         | 内容与注意事项                                                                                                                                             | 证据                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `choices[i].logprobs.content[k]` / `.refusal[k]` | 单个输出 token 信息：`token`、`logprob`、`bytes`、`top_logprobs`。`bytes` 可为 `null`；中文字符可能由多个 token 的 UTF-8 字节拼成，不能把 token 数当成字数 | [概率结构][概率结构] |
| `choices[i].message.annotations[j].url_citation` | `url`、`title`、`start_index`、`end_index`；索引关联回答中引用的位置，不是单独的搜索结果列表                                                               | [搜索引用][搜索引用] |
| `usage.prompt_tokens_details`                    | 当前 SDK 支持 `cached_tokens`、`audio_tokens`、`cache_write_tokens`、`image_tokens`、`text_tokens` 等可选细分                                              | [用量][用量]         |
| `usage.completion_tokens_details`                | 当前 SDK 支持 `reasoning_tokens`、`audio_tokens`、`text_tokens`、`accepted_prediction_tokens`、`rejected_prediction_tokens` 等可选细分                     | [用量][用量]         |

`max_completion_tokens` 包含可见输出与推理 token；`rejected_prediction_tokens` 也计入生成用量的计费与限制。[上限参数][上限参数]、[用量][用量]

`reasoning_content`、`reasoning`、`reasoning_text`、`reasoning_details` 属于兼容服务扩展，不是这里列出的 OpenAI 标准响应字段。[助手输出][助手输出]、[增量结构][增量结构]

## 4. 其他参数

### 4.1 生成与控制参数

| 入参                                                  | 作用                                                        | 对返回结构的影响                                                        | 证据                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temperature`、`top_p`                                | 控制采样；官方 SDK 建议通常调整其中一个                     | 改变生成内容，不新增同名响应字段                                        | [采样及控制][采样及控制]                                                                                                                                                |
| `presence_penalty`、`frequency_penalty`、`logit_bias` | 调整重复倾向或指定 token 的选择概率                         | 改变生成内容，不等于开启 `logprobs`                                     | [请求参数][请求参数]                                                                                                                                                    |
| `max_completion_tokens`                               | 约束输出与推理 token 总预算                                 | 可能导致 `finish_reason: "length"`；不回传一个同名上限字段              | [上限参数][上限参数]、[完整响应][完整响应]                                                                                                                              |
| `stop`                                                | 最多四个停止序列；生成文本不包含命中的停止序列              | 可能得到 `finish_reason: "stop"`；支持情况依模型而定                    | [采样及控制][采样及控制]                                                                                                                                                |
| `verbosity`                                           | 调整回答详细程度，类型值为 `low`、`medium`、`high`          | 主要改变文本长度和内容，不新增 `message.verbosity`                      | [其余参数][其余参数]                                                                                                                                                    |
| `store: true`                                         | 请求保存补全；SDK 的检索、列表等接口用于已保存的补全        | 不新增 `store` 布尔返回字段；保存后的管理操作属于另一组请求             | [流式参数][流式参数]、[存储检索](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L89) |
| `metadata`                                            | 附加最多 16 个字符串键值对；键最多 64 字符，值最多 512 字符 | 当前完整响应类型含可选顶层 `metadata`；不能保证每次创建响应即时完整回显 | [请求参数][请求参数]、[完整响应][完整响应]                                                                                                                              |
| `safety_identifier`                                   | 稳定的用户安全标识                                          | 当前响应类型没有同名字段，不增加业务回答内容                            | [推理参数][推理参数]、[完整响应][完整响应]                                                                                                                              |
| `seed`                                                | 尽力提供确定性采样，不能保证完全确定；已标记弃用            | 可结合可选 `system_fingerprint` 观察后端变化；不能据此保证回答一致      | [推理参数][推理参数]、[完整响应][完整响应]                                                                                                                              |
| `prompt_cache_key`                                    | 辅助相似请求的缓存命中                                      | 用量可反映 `cached_tokens`；类型没有保证回显该键                        | [请求参数][请求参数]、[用量][用量]                                                                                                                                      |

已弃用字段：`max_tokens` → `max_completion_tokens`；`functions` / `function_call` → `tools` / `tool_choice`；`user` → `safety_identifier` / `prompt_cache_key`。[请求参数][请求参数]、[其余参数][其余参数]

### 4.2 补充参数

| 追加入参                                                            | 支持的返回变化或行为                                                                                                                                                | 证据                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools[j].type: "custom"`，带 `custom.name`、可选 `custom.format`   | 工具调用可为 `type: "custom"`，返回 `custom.name` 与字符串 `custom.input`，而非 `function.arguments`；格式可为自由文本或语法约束                                    | [自定义工具][自定义工具]、[自定义调用](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1694)                                                                                                                                                 |
| `tool_choice.type: "allowed_tools"`                                 | `allowed_tools.mode` 和 `.tools` 限定允许调用的工具子集；返回仍使用 `message.tool_calls`                                                                            | [限定工具](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L645) · [配置结构](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2041)                        |
| `stream_options.include_obfuscation`                                | 流片段可带 `obfuscation` 随机字符，用于规范化片段大小；当前 SDK 说明默认包含，设置 `false` 时省略；它不属于回答内容                                                 | [流式选项][流式选项]、[流式响应][流式响应]                                                                                                                                                                                                                                                                                      |
| `moderation`，含 `model` 及可选 `policy`                            | 完整响应可有顶层 `moderation`；流式响应可在审核片段带 `moderation`，承载输入和输出审核信息                                                                          | [审核参数](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2478) · [审核返回](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L470) · [流式响应][流式响应] |
| `prompt_cache_options`，以及内容块上的 `prompt_cache_breakpoint`    | 控制显式/隐式缓存断点及生存时间；可观察用量中的缓存读取/写入计数，不产生新回答消息。SDK 说明模型支持范围和当前 `ttl: "30m"`；旧 `prompt_cache_retention` 已标记弃用 | [缓存选项](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2233) · [断点输入](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1395) · [用量][用量]        |
| 用户内容块 `type: "file"`，带 `file.file_id` 或 `file.file_data` 等 | 增加文件输入，输出仍走已有助手消息结构；支持情况依模型和文件输入能力核实                                                                                            | [文件输入](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1220)                                                                                                                                                                             |

## 5. SDK 选项与错误响应

`signal`、`timeout`、`maxRetries` 属于 SDK 请求选项或客户端配置，不是聊天 JSON 入参，也不新增成功响应字段。[请求选项](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/internal/request-options.ts#L38)

`_request_id` 来自响应头 `x-request-id`，由 SDK 本地附加；`.withResponse()` 返回的 `data`、`response`、`request_id` 同样是 SDK 包装信息。[请求标识](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/internal/parse.ts#L119) · [HTTP 包装](https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/core/api-promise.ts#L69)

错误响应读取 `error.message`、`error.type`、`error.param`、`error.code`，字段可缺失。常见状态为 400 参数错误、401 认证错误、403 权限错误、404 未找到、429 限流、5xx 服务错误；流式阶段也可返回错误负载。[错误处理][错误处理]、[SSE 解析][SSE 解析]

[创建]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L37
[完整响应]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L335
[请求参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2073
[消息联合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1773
[用户消息]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2020
[指令消息]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1523
[助手输入]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L660
[助手输出]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1587
[工具结果]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1999
[用量]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/completions.ts#L122
[服务层级]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2316
[流式响应]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L812
[流式参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2353
[流式选项]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1877
[增量结构]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L916
[工具参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2381
[函数调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1731
[JSON 格式]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/shared.ts#L367
[SDK 解析]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/parser.ts#L325
[概率参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2143
[概率结构]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1923
[音频参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2181
[音频输出]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L738
[图片输入]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1284
[音频输入]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1330
[搜索配置]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2564
[搜索引用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1627
[推理参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2267
[预测内容]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1838
[上限参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2154
[采样及控制]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2340
[其余参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L2420
[自定义工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/chat/completions/completions.ts#L1423
[错误处理]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/core/error.ts#L6
[SSE 解析]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/core/streaming.ts#L102
