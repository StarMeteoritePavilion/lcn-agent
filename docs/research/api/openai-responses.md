# OpenAI Responses 入参与返回值

OpenAI SDK 源码引用固定到 `openai@7.19.0` 对应的[提交 `15f6e40`](https://github.com/openai/openai-node/tree/15f6e408a0359df50ee7a996616957cc14988659)；字段与行号以该版本为准。

接口：`POST /v1/responses`。普通文本请求显式提供 `model` 和 `input`，两者在当前 SDK 创建参数中均为可选。非流式结果位于 `output` 数组，按条目的 `type` 区分文本、工具调用和推理内容。[创建][创建]、[请求参数][请求参数]、[输出联合][输出联合]

以下示例仅展示结构，省略部分响应字段；模型 ID 需替换为实际可用值。可选参数、工具与返回内容的支持情况取决于模型和服务。[创建][创建]、[工具联合][工具联合]

## 1. 基础入参与返回值

### 1.1 最小文本请求

`input` 可直接使用字符串，也可提供消息及其他输入条目的数组。[请求参数][请求参数]、[输入联合][输入联合]

```json
{
  "model": "<实际可用的模型 ID>",
  "input": "请用中文打个招呼。"
}
```

| 入参路径           | 含义与约束                                                                                 | 证据                                       |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `model`            | 生成响应的模型 ID；普通文本请求显式指定                                                    | [请求参数][请求参数]                       |
| `input`            | 字符串或输入条目数组；数组不只包含消息，也可包含历史输出、工具结果等                       | [请求参数][请求参数]、[输入联合][输入联合] |
| `input[i].role`    | 简化消息的角色为 `user`、`assistant`、`system`、`developer`                                | [简化消息][简化消息]                       |
| `input[i].content` | 简化消息可为字符串，或 `input_text`、`input_image`、`input_file` 内容块数组                | [简化消息][简化消息]、[内容联合][内容联合] |
| `instructions`     | 当前请求的系统或开发者指令；使用 `previous_response_id` 时，上一响应的此项指令不会自动延续 | [请求参数][请求参数]                       |
| `input[i].type`    | 简化消息可省略；提供时为 `message`，其他条目按自身 `type` 填写                             | [输入联合][输入联合]                       |

等价的消息形式为 `"input": [{"role":"user","content":"请用中文打个招呼。"}]`。多模态文本块使用 `{"type":"input_text","text":"描述这张图片。"}`。[简化消息][简化消息]、[文本输入][文本输入]

### 1.2 非流式响应

普通文本响应的主要字段如下：[完整响应][完整响应]、[输出消息][输出消息]、[用量][用量]

```json
{
  "id": "resp_example",
  "object": "response",
  "created_at": 0,
  "model": "<实际可用的模型 ID>",
  "status": "completed",
  "error": null,
  "incomplete_details": null,
  "output": [
    {
      "id": "msg_example",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [{ "type": "output_text", "text": "你好！", "annotations": [] }]
    }
  ],
  "usage": {
    "input_tokens": 10,
    "input_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0 },
    "output_tokens": 3,
    "output_tokens_details": { "reasoning_tokens": 0 },
    "total_tokens": 13
  }
}
```

| 返回路径                                      | 含义                                                         | 是否固定有内容                                    | 证据                                       |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------ |
| `id`、`object`                                | 响应标识；`object` 固定为 `response`                         | SDK 完整响应类型必填                              | [完整响应][完整响应]                       |
| `created_at`、`completed_at`                  | 创建、完成时间，Unix 秒；不是毫秒                            | 创建时间必填；完成时间仅在 `completed` 时提供     | [完整响应][完整响应]                       |
| `model`                                       | 本次实际使用的模型                                           | 必填；读取响应中的值                              | [完整响应][完整响应]                       |
| `status`                                      | 响应生成状态，含义见第 3 节                                  | SDK 标为可选；后台及流式过程可能尚未完成          | [状态][状态]                               |
| `output`                                      | 生成的条目数组，长度及顺序取决于响应                         | 必填；不能假定 `output[0]` 总是文本消息           | [完整响应][完整响应]、[输出联合][输出联合] |
| `output[i].content[j].text`                   | `type: "message"` 条目内，`type: "output_text"` 内容块的文本 | 仅文本块具有此字段                                | [输出消息][输出消息]、[文本输出][文本输出] |
| `output[i].content[j].refusal`                | `type: "refusal"` 内容块内的拒绝说明                         | 拒绝使用单独内容类型，不是文本块的 `refusal` 属性 | [拒绝输出][拒绝输出]                       |
| `error`、`incomplete_details`                 | 生成失败、未完成的详情                                       | 可为 `null`；不能只判断 HTTP 请求是否成功         | [完整响应][完整响应]、[生成错误][生成错误] |
| `usage`                                       | 输入、输出、合计 token 用量及细分                            | SDK 标为可选；处理中不能要求用量已经完整          | [状态][状态]、[用量][用量]                 |
| `tools`、`tool_choice`、`parallel_tool_calls` | 工具定义、选择方式及并行设置                                 | SDK 完整响应类型必填；不是模型实际调用的列表      | [完整响应][完整响应]                       |
| `instructions`、`metadata`                    | 指令、附加键值对                                             | 类型可为 `null`                                   | [完整响应][完整响应]                       |
| `text`、`reasoning`、`service_tier` 等        | 文本配置、推理配置、实际服务层级                             | SDK 标为可选；不等于新生成内容                    | [响应配置][响应配置]                       |

SDK 的顶层 `output_text` 是把所有消息中的 `output_text` 文本块拼接得到的便利字段；不能把 SDK 声明当成 HTTP 响应必返此字段的依据。直接解析协议时，应遍历 `output` 及消息的 `content`。[SDK 文本聚合][SDK 文本聚合]

## 2. 追加参数与返回变化

参数可能新增输出条目、扩充条目字段、改变文本内容，或切换为流式返回。

| 追加或修改的入参                                                            | 返回值的具体变化                                                                                 | 不应误解成什么                                                   | 证据                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `stream: true`                                                              | 完整 JSON 改为 SSE 命名事件，如 `response.output_text.delta`、`response.completed`               | 不使用 `choices[i].delta`；文本增量的 `delta` 是字符串           | [流式参数][流式参数]、[文本增量][文本增量]、[完成事件][完成事件]                 |
| `tools: [{"type":"function", ...}]`                                         | 若模型调用函数，`output` 出现 `function_call`，含 `name`、`call_id`、JSON 字符串 `arguments`     | 声明函数不自动执行；响应完成也不代表业务函数已经执行             | [函数定义][函数定义]、[函数调用][函数调用]                                       |
| `tool_choice: "auto" / "required" / "none"` 或指定函数                      | 控制是否产生调用；`required` 要求一个或多个工具调用                                              | 此配置可回传，但实际调用仍应读取 `output`                        | [工具选择][工具选择]、[完整响应][完整响应]                                       |
| `parallel_tool_calls: true / false`                                         | 控制是否允许并行工具调用；`output` 可出现多个调用条目                                            | 不替调用方执行本地函数                                           | [请求参数][请求参数]、[函数定义][函数定义]                                       |
| `tools: [{"type":"web_search"}]`                                            | 调用后可出现 `web_search_call`；回答文本的 `annotations` 可带 `url_citation`                     | 调用条目、搜索来源和回答引用是不同结构                           | [网页搜索工具][网页搜索工具]、[网页搜索调用][网页搜索调用]、[文本输出][文本输出] |
| `tools: [{"type":"file_search","vector_store_ids":[...]}]`                  | 调用后可出现 `file_search_call`；文本可带 `file_citation`                                        | 搜索结果正文不保证默认返回；需按下表追加 `include`               | [文件搜索工具][文件搜索工具]、[文件搜索调用][文件搜索调用]、[文本输出][文本输出] |
| `tools: [{"type":"code_interpreter","container":{"type":"auto"}}]`          | 可出现 `code_interpreter_call`，含 `code`、`container_id`、执行状态；可包含日志或图片输出        | 此工具在托管容器运行，不是返回一个函数名称让本地代码执行         | [代码解释器工具][代码解释器工具]、[代码解释器调用][代码解释器调用]               |
| `text.format: {"type":"json_object"}`                                       | `output_text` 内容块的 `text` 改为 JSON 字符串；还需在输入指令中明确要求生成 JSON                | 外层仍是响应对象；不保证自定义 schema                            | [文本配置][文本配置]、[JSON 模式][JSON 模式]                                     |
| `text.format: {"type":"json_schema","name":...,"schema":...,"strict":true}` | 文本按 schema 生成；严格模式仅支持 JSON Schema 子集                                              | 不新增 HTTP `output_parsed`；仍需处理拒绝和未完成状态            | [JSON 格式][JSON 格式]、[拒绝输出][拒绝输出]、[SDK 解析][SDK 解析]               |
| `include: ["message.output_text.logprobs"]`，可同时设置 `top_logprobs: k`   | 文本块可增加 `logprobs`；`k` 为 0–20，控制各位置最多返回多少高概率 token                         | 不是多份答案，也不是整条回答的可靠性评分                         | [扩充字段][扩充字段]、[文本输出][文本输出]、[概率参数][概率参数]                 |
| `reasoning.effort`                                                          | 调整推理投入；用量的 `output_tokens_details.reasoning_tokens` 反映推理 token 数                  | 不保证新增可读推理正文；支持的投入级别依模型而定                 | [推理配置][推理配置]、[用量][用量]                                               |
| `reasoning.summary: "auto" / "concise" / "detailed"`                        | 可返回 `type: "reasoning"` 条目的 `summary`，内含 `summary_text`                                 | 摘要不是完整内部思维链，也不是最终回答                           | [推理配置][推理配置]、[推理条目][推理条目]                                       |
| `text.verbosity: "low" / "medium" / "high"`                                 | 调整文本详细程度；响应可含 `text` 配置                                                           | 不新增消息内容块的 `verbosity` 属性                              | [文本配置][文本配置]、[响应配置][响应配置]                                       |
| `store: true / false`                                                       | 控制是否保存响应供后续检索；省略时默认 `true`                                                    | 不新增回答内容；当前响应类型没有 `store` 字段                    | [流式参数][流式参数]、[完整响应][完整响应]                                       |
| `previous_response_id`                                                      | 续接上一响应；响应可带对应关联 ID                                                                | 不能与 `conversation` 同用；上一响应的 `instructions` 不自动延续 | [请求参数][请求参数]、[响应配置][响应配置]                                       |
| `conversation`                                                              | 自动读取会话既有条目，并在完成后加入此次输入、输出；响应可带 `conversation.id`                   | 不要求响应再次返回完整会话历史                                   | [请求参数][请求参数]、[响应配置][响应配置]                                       |
| `background: true`                                                          | 后台生成；首次返回可能为 `queued` / `in_progress`，随后按响应 ID 检索最新对象                    | 首次 HTTP 请求结束不等于生成完成                                 | [后台参数][后台参数]、[检索][检索]、[状态][状态]                                 |
| `max_output_tokens`                                                         | 限制可见输出与推理 token 的总预算；达到限制可为 `status: "incomplete"`、原因 `max_output_tokens` | 不使用 `finish_reason: "length"`；文本或工具参数可能尚未完整     | [请求参数][请求参数]、[未完成详情][未完成详情]                                   |
| `service_tier`                                                              | 响应可返回实际使用的 `service_tier`                                                              | 实际值应读取响应，不只看请求配置                                 | [服务层级][服务层级]                                                             |

`include` 用来扩充已有条目的数据，不会单独触发对应工具：[扩充字段][扩充字段]、[追加数据参数][追加数据参数]

| `include` 中追加的值                                                     | 可扩充的数据                                                                                   | 证据                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `file_search_call.results`                                               | 文件搜索结果的 `file_id`、`filename`、`score`、`text`、`attributes` 等                         | [文件搜索调用][文件搜索调用]                       |
| `web_search_call.action.sources`                                         | 网页搜索动作中的来源列表，条目含 `type: "url"`、`url`                                          | [网页搜索调用][网页搜索调用]                       |
| `code_interpreter_call.outputs`                                          | 代码执行日志 `{"type":"logs","logs":...}` 或图片 `{"type":"image","url":...}`                  | [代码解释器调用][代码解释器调用]                   |
| `reasoning.encrypted_content`                                            | 推理条目的加密内容，用于后续上下文；当前类型说明创建响应默认填充，此选项不能解释为唯一获取方式 | [推理条目][推理条目]、[追加数据参数][追加数据参数] |
| `message.input_image.image_url`、`computer_call_output.output.image_url` | 输入消息图片、计算机工具结果截图的地址；不等于生成图片                                         | [追加数据参数][追加数据参数]                       |

当前类型联合还声明 `web_search_call.results`，但当前 `ResponseFunctionWebSearch` 未声明同名 `results` 结构；读取搜索来源时，使用上表已明确结构的 `web_search_call.action.sources`。[扩充字段][扩充字段]、[网页搜索调用][网页搜索调用]

### 2.1 流式返回

追加 `stream: true`，可再设置 `stream_options: {"include_obfuscation":false}`。下例仅展示文本增量、文本完成和响应完成事件，终止事件内的 `response` 省略其他字段：[流式参数][流式参数]、[流式选项][流式选项]、[文本增量][文本增量]、[文本完成][文本完成]、[完成事件][完成事件]

```text
event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_example","output_index":0,"content_index":0,"delta":"你好！","logprobs":[],"sequence_number":3}

event: response.output_text.done
data: {"type":"response.output_text.done","item_id":"msg_example","output_index":0,"content_index":0,"text":"你好！","logprobs":[],"sequence_number":4}

event: response.completed
data: {"type":"response.completed","sequence_number":7,"response":{"id":"resp_example","status":"completed","usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0},"output_tokens":3,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":13}}}
```

按 `item_id` / `output_index` 关联输出条目，再按 `content_index` 累积文本；不要把不同消息混成一个内容块。`response.output_text.done` 只表示该文本块完成，响应终态应处理 `response.completed`、`response.incomplete`、`response.failed`；用量读取终态事件的 `response.usage`，没有 Chat Completions 的 `include_usage` 选项。[文本增量][文本增量]、[文本完成][文本完成]、[流式事件联合][流式事件联合]、[流式选项][流式选项]

函数参数通过 `response.function_call_arguments.delta` 累积，在 `.done` 或对应 `response.output_item.done` 中取得完整参数后再解析。推理摘要使用 `response.reasoning_summary_text.delta` 等独立事件。[函数参数事件][函数参数事件]、[条目完成事件][条目完成事件]、[摘要事件][摘要事件]

### 2.2 工具调用

Responses 的函数定义直接放在工具对象上，指定函数时 `name` 也直接位于 `tool_choice`，结构如下：[函数定义][函数定义]、[指定函数][指定函数]

```json
{
  "model": "<实际可用的模型 ID>",
  "input": "计算 2 加 3。",
  "tools": [
    {
      "type": "function",
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
  ],
  "tool_choice": { "type": "function", "name": "add" },
  "parallel_tool_calls": false
}
```

响应 `output` 中的函数调用条目：[函数调用][函数调用]

```json
{
  "id": "fc_example",
  "type": "function_call",
  "call_id": "call_example",
  "name": "add",
  "arguments": "{\"a\":2,\"b\":3}",
  "status": "completed"
}
```

调用方校验并执行函数后，使用 `call_id` 回传结果，不能用条目 `id` 代替。以下请求续接产生调用的 `resp_example`；工具结果中的业务 JSON 由调用方定义。[函数调用][函数调用]、[函数结果输入][函数结果输入]、[请求参数][请求参数]

```json
{
  "model": "<实际可用的模型 ID>",
  "previous_response_id": "resp_example",
  "input": [
    {
      "type": "function_call_output",
      "call_id": "call_example",
      "output": "{\"ok\":true,\"sum\":5}"
    }
  ]
}
```

若采用手动历史，将上一响应的输出条目连同工具结果作为 `input` 传入，推理模型还应保留相关推理条目。`function_call_output.output` 也可使用文本、图片、文件内容块数组。[请求参数][请求参数]、[输入联合][输入联合]、[推理条目][推理条目]、[函数结果输入][函数结果输入]

### 2.3 JSON 输出

追加 `text.format`，schema 字段直接位于格式对象内：[JSON 格式][JSON 格式]

```json
{
  "text": {
    "format": {
      "type": "json_schema",
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

消息的文本块仍为 `{"type":"output_text","text":"{\"answer\":\"你好！\",\"language\":\"中文\"}","annotations":[]}`。SDK `responses.parse()` 本地增加内容块的 `parsed`、顶层 `output_parsed` 及函数调用的 `parsed_arguments`；`output_parsed` 取第一个成功解析的文本块，未完成响应不会直接解析成业务结果，拒绝内容也不按 schema 解析。[文本输出][文本输出]、[SDK 解析][SDK 解析]

## 3. 返回字段细分

| 返回路径                                              | 内容与注意事项                                                                                                          | 证据                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `status`                                              | `completed`、`failed`、`in_progress`、`cancelled`、`queued`、`incomplete`；响应状态和每个输出条目的状态分开读取         | [状态值][状态值]、[输出消息][输出消息]     |
| `incomplete_details.reason`                           | 当前联合为 `max_output_tokens`、`max_messages`、`content_filter`、`steered`；其中 `steered` 对应 WebSocket 中途追加输入 | [未完成详情][未完成详情]                   |
| `error.code`、`error.message`                         | 响应生成失败的错误码及说明；独立于非成功 HTTP 状态的错误负载                                                            | [生成错误][生成错误]、[错误处理][错误处理] |
| `usage.input_tokens`、`output_tokens`、`total_tokens` | 请求用量；输出包含推理 token，不能把 token 数当成可见字数                                                               | [请求参数][请求参数]、[用量][用量]         |
| `usage.input_tokens_details`                          | 当前类型声明 `cached_tokens`、`cache_write_tokens`，分别为缓存读取、写入 token 数                                       | [用量][用量]                               |
| `usage.output_tokens_details.reasoning_tokens`        | 推理 token 数，不等于返回的摘要文本长度                                                                                 | [用量][用量]、[推理条目][推理条目]         |
| `output[i].content[j].annotations`                    | 按类型区分 `url_citation`、`file_citation`、`container_file_citation`、`file_path`；网页引用字段直接位于注解对象中      | [文本输出][文本输出]                       |
| `output[i].content[j].logprobs[k]`                    | 文本 token 的 `token`、`bytes`、`logprob`、`top_logprobs`                                                               | [文本输出][文本输出]                       |
| `output[i].summary`、`.encrypted_content`             | 推理条目的摘要及加密上下文；加密字符串不是可读推理正文                                                                  | [推理条目][推理条目]                       |

`completed` 表示这一响应已完成；如果 `output` 只给出函数调用，应用仍需执行函数并提交结果后才能继续获得模型回答。协议使用 `status` 和 `incomplete_details` 判断终态，没有 Chat Completions 的 `choices` / `finish_reason`。[完整响应][完整响应]、[函数定义][函数定义]、[函数调用][函数调用]

## 4. 其他参数

### 4.1 生成与控制参数

| 入参                                                      | 作用及返回变化                                                                                                           | 证据                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `temperature`、`top_p`                                    | 控制采样，通常只调整其中一项；改变文本内容，响应类型也有对应配置字段                                                     | [请求参数][请求参数]、[完整响应][完整响应]                       |
| `truncation`                                              | `auto` 在超出上下文窗口时丢弃对话开头条目；`disabled` 默认在超限时返回 400；当前请求类型标记弃用，不能与输出截断混为一谈 | [概率参数][概率参数]、[响应配置][响应配置]                       |
| `metadata`                                                | 最多 16 个字符串键值对，键最多 64 字符、值最多 512 字符；响应有顶层 `metadata`                                           | [请求参数][请求参数]、[完整响应][完整响应]                       |
| `prompt`                                                  | 引用提示词模板的 `id`、可选 `version`、`variables`；响应可带模板配置，不新增回答类型                                     | [提示词模板][提示词模板]、[响应配置][响应配置]                   |
| `prompt_cache_key`                                        | 辅助缓存命中；响应可带该键，用量观察 `cached_tokens`                                                                     | [请求参数][请求参数]、[响应配置][响应配置]、[用量][用量]         |
| `prompt_cache_options` 与内容块 `prompt_cache_breakpoint` | 控制缓存模式、断点与 TTL；`comparison_response_id` 可请求 `prompt_cache_diagnostics`；支持范围依模型与功能开关           | [缓存选项][缓存选项]、[文本输入][文本输入]、[响应配置][响应配置] |
| `safety_identifier`                                       | 用户安全标识，最长 64 字符；不新增回答内容，响应类型声明同名可选字段                                                     | [服务层级][服务层级]、[响应配置][响应配置]                       |
| `moderation`                                              | 设置审核模型及策略；响应可带输入、输出的顶层 `moderation` 信息                                                           | [审核参数][审核参数]、[响应配置][响应配置]                       |
| `input[i].content[j].type: "input_image"`                 | 增加图片输入，提供 `image_url` 或 `file_id` 以及 `detail`；本身不开启图片生成                                            | [图片输入][图片输入]、[图片生成工具][图片生成工具]               |
| `input[i].content[j].type: "input_file"`                  | 增加文件输入，可带 `file_id`、`file_data`、`file_url` 等；不自动开启 `file_search`                                       | [文件输入][文件输入]、[文件搜索工具][文件搜索工具]               |

`reasoning.generate_summary` 已由 `reasoning.summary` 替代；`user` 已由 `safety_identifier` / `prompt_cache_key` 替代；当前 SDK 还将 `prompt_cache_retention` 标记弃用，指向 `prompt_cache_options.ttl`。[推理配置][推理配置]、[请求参数][请求参数]

### 4.2 补充工具及流式参数

| 追加入参                                  | 支持的返回变化或行为                                                                                                          | 证据                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `tools[j].type: "image_generation"`       | 调用条目为 `image_generation_call`，`result` 为生成图片的 Base64 字符串或 `null`；可返回格式、尺寸、改写后的提示词等          | [图片生成工具][图片生成工具]、[图片生成调用][图片生成调用]                   |
| 图片生成工具的 `partial_images`，同时流式 | 可增加 `response.image_generation_call.partial_image` 事件，含 `partial_image_b64`、`partial_image_index`；当前数量范围为 0–3 | [图片生成工具][图片生成工具]、[部分图片事件][部分图片事件]                   |
| `tools[j].type: "mcp"`                    | 可返回 `mcp_list_tools`、`mcp_call` 或 `mcp_approval_request`；远端调用结果在 `mcp_call.output`，错误在 `.error`              | [MCP 工具][MCP 工具]、[MCP 输出][MCP 输出]                                   |
| MCP 工具的 `require_approval`             | 需要审批时先给出审批条目；下一轮用 `mcp_approval_response` 的 `approval_request_id`、`approve` 回应                           | [MCP 工具][MCP 工具]、[MCP 输出][MCP 输出]                                   |
| `tools[j].type: "custom"`                 | 返回 `custom_tool_call` 的 `name`、`call_id`、字符串 `input`；回传使用 `custom_tool_call_output`，不按函数 JSON 参数处理      | [自定义工具][自定义工具]、[自定义调用][自定义调用]、[自定义结果][自定义结果] |
| `computer` / `computer_use_preview` 工具  | 返回 `computer_call`，含动作及 `call_id`；调用方执行动作，再回传 `computer_call_output` 截图和关联 ID                         | [计算机工具][计算机工具]、[计算机调用][计算机调用]、[计算机结果][计算机结果] |
| `tool_choice.type: "allowed_tools"`       | 用同层 `mode`、`tools` 限定可选工具子集；实际调用仍在 `output`                                                                | [限定工具][限定工具]                                                         |
| `stream_options.include_obfuscation`      | 控制增量事件中的随机填充 `obfuscation`；默认开启，设 `false` 可省略，不属于回答内容                                           | [流式选项][流式选项]                                                         |

后台响应通过 `GET /v1/responses/{response_id}` 检索；只有 `background: true` 创建的响应可通过 `POST /v1/responses/{response_id}/cancel` 取消。检索时 `stream: true` 可继续流式返回，并用 `starting_after` 指定从哪个事件序号之后开始。[检索][检索]、[取消][取消]、[检索参数][检索参数]

## 5. SDK 选项与错误响应

`signal`、`timeout`、`maxRetries` 属于 SDK 请求选项或客户端配置，不是 Responses JSON 入参；它们控制请求取消、超时和重试，不新增成功响应字段。[请求选项][请求选项]

`responses.stream().finalResponse()` 在客户端聚合事件，流正常结束时也可能返回未完成响应，仍需检查 `status`。`output_text`、`output_parsed`、`content[].parsed`、`parsed_arguments` 是 SDK 便利或解析字段。`_request_id` 来自 `x-request-id` 响应头；`.withResponse()` 的 `data`、`response`、`request_id` 属于 SDK 包装。[SDK 聚合][SDK 聚合]、[SDK 文本聚合][SDK 文本聚合]、[SDK 解析][SDK 解析]、[请求标识][请求标识]、[HTTP 包装][HTTP 包装]

非成功 HTTP 请求的错误负载读取 `error.message`、`error.type`、`error.param`、`error.code`，字段可缺失；SSE 的 `type: "error"` 事件则直接包含 `code`、`message`、`param`、`sequence_number`。不要将它们与完整响应内的生成错误对象混用。[错误处理][错误处理]、[流式错误][流式错误]、[生成错误][生成错误]

[创建]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L98
[请求参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10735
[完整响应]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L1042
[响应配置]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L1175
[状态]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L1303
[状态值]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L7622
[未完成详情]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L1360
[生成错误]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L2959
[输出联合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6085
[输入联合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4337
[简化消息]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L703
[内容联合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4110
[文本输入]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L5339
[图片输入]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4236
[文件输入]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4115
[输出消息]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6567
[拒绝输出]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6606
[文本输出]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6621
[用量]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L8516
[流式参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10938
[流式选项]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L11163
[流式事件联合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L8155
[文本增量]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L8253
[文本完成]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L8331
[完成事件]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L2105
[函数参数事件]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3283
[条目完成事件]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6542
[摘要事件]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L7174
[函数定义]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L828
[函数调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3597
[函数结果输入]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4464
[工具选择]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10514
[指定函数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10480
[限定工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10420
[工具联合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10030
[网页搜索工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10656
[网页搜索调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3758
[文件搜索工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L735
[文件搜索调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3160
[代码解释器工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10224
[代码解释器调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L1963
[JSON 格式]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3246
[JSON 模式]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/shared.ts#L371
[文本配置]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L8223
[推理配置]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/shared.ts#L308
[推理条目]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6989
[扩充字段]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4041
[追加数据参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10755
[概率参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L11018
[服务层级]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10899
[后台参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10735
[检索]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L139
[取消]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L212
[检索参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L11212
[提示词模板]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6944
[缓存选项]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L11120
[审核参数]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L11067
[图片生成工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10283
[图片生成调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6195
[部分图片事件]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3943
[MCP 工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L10057
[MCP 输出]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L6343
[自定义工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L658
[自定义调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L2745
[自定义结果]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L2886
[计算机工具]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L541
[计算机调用]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L2127
[计算机结果]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L4421
[SDK 文本聚合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/ResponsesParser.ts#L347
[SDK 解析]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/ResponsesParser.ts#L108
[SDK 聚合]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/lib/responses/ResponseStream.ts#L309
[请求选项]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/internal/request-options.ts#L38
[请求标识]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/internal/parse.ts#L119
[HTTP 包装]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/core/api-promise.ts#L69
[错误处理]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/core/error.ts#L6
[流式错误]: https://github.com/openai/openai-node/blob/15f6e408a0359df50ee7a996616957cc14988659/src/resources/responses/responses.ts#L3033
