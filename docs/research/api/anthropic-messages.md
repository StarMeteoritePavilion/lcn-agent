# Anthropic Messages 入参与返回值

接口：`POST /v1/messages`。必填入参为 `model`、`messages` 和 `max_tokens`，非流式结果位于 `content` 数组，按内容块的 `type` 区分文本、思考和工具调用。[创建][创建]、[请求参数][请求参数]、[输出联合][输出联合]

以下示例仅展示结构，省略部分响应字段；模型 ID 需替换为实际可用值。可选参数、工具与返回内容的支持情况取决于模型；思考模式和工具版本不能跨模型直接套用。[请求参数][请求参数]、[思考模式][思考模式]

## 1. 基础入参与返回值

### 1.1 最小文本请求

`messages[i].content` 可为字符串或内容块数组；字符串等价于单个 `text` 块。[请求参数][请求参数]

```json
{
  "model": "<实际可用的模型 ID>",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "请用中文打个招呼。" }]
}
```

| 入参路径              | 含义与约束                                                                                                          | 证据                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `model`               | 生成消息的模型 ID，必填                                                                                             | [请求参数][请求参数]                       |
| `max_tokens`          | 本次生成 token 的上限，必填；模型可提前停止，思考 token 也占用此上限                                                | [请求参数][请求参数]、[手动思考][手动思考] |
| `messages`            | 对话历史数组，必填；接口支持无状态多轮对话，需要传入要保留的历史                                                    | [创建][创建]、[请求参数][请求参数]         |
| `messages[i].role`    | 当前参数类型列出 `user`、`assistant`、`system`；常规对话使用 `user` / `assistant`，系统指令优先放顶层 `system`      | [消息输入][消息输入]、[请求参数][请求参数] |
| `messages[i].content` | 字符串或内容块数组；常见输入块为 `text`、`image`、`document`，历史还可包含 `thinking`、`tool_use`、`tool_result` 等 | [消息输入][消息输入]、[输入联合][输入联合] |
| `system`              | 顶层系统指令，可为字符串或 `text` 块数组；不属于普通用户消息                                                        | [请求参数][请求参数]                       |

相邻同角色的 `user` / `assistant` 消息会合并为一个回合。文本块使用 `{"type":"text","text":"描述这张图片。"}`；工具结果使用 `user` 消息中的 `tool_result` 块。[请求参数][请求参数]、[工具结果][工具结果]

### 1.2 非流式响应

普通文本响应的主要字段如下；示例表示未产生思考或工具调用的情况：[完整响应][完整响应]、[文本输出][文本输出]、[用量][用量]

```json
{
  "id": "msg_example",
  "type": "message",
  "role": "assistant",
  "model": "<实际可用的模型 ID>",
  "content": [{ "type": "text", "text": "你好！", "citations": null }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 10,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 3
  }
}
```

| 返回路径                      | 含义                                           | 是否固定有内容                    | 证据                                       |
| ----------------------------- | ---------------------------------------------- | --------------------------------- | ------------------------------------------ |
| `id`、`type`                  | 消息标识；`type` 固定为 `message`              | 必填；ID 的格式和长度不保证固定   | [完整响应][完整响应]                       |
| `role`、`model`               | 输出角色固定为 `assistant`，以及本次使用的模型 | 必填；模型值读取响应              | [完整响应][完整响应]                       |
| `content`                     | 生成的内容块数组；可混合文本、思考和工具调用   | 必填；不能假定第一块就是回答文本  | [完整响应][完整响应]、[输出联合][输出联合] |
| `content[i].text`             | `type: "text"` 块的回答文本                    | 仅文本块具有此字段                | [文本输出][文本输出]                       |
| `content[i].citations`        | 文本块的来源引用                               | 数组或 `null`；按引用 `type` 读取 | [文本输出][文本输出]、[引用联合][引用联合] |
| `stop_reason`                 | 消息生成停止原因，含义见第 3 节                | 非流式非空；流式开始时为 `null`   | [完整响应][完整响应]                       |
| `stop_sequence`               | 命中的自定义停止序列                           | 未命中时为 `null`                 | [完整响应][完整响应]                       |
| `usage`                       | 输入、输出、缓存及服务工具等用量               | 必填；部分细分字段可为 `null`     | [完整响应][完整响应]、[用量][用量]         |
| `container`                   | 本次使用的托管容器信息                         | 未使用容器工具时为 `null`         | [完整响应][完整响应]                       |
| `stop_details`、`diagnostics` | 停止原因详情、请求诊断信息                     | 可为 `null`，见第 3、4 节         | [完整响应][完整响应]                       |

读取回答时遍历 `content`，选择 `type: "text"` 的块；完整响应没有 `choices` 或协议级顶层 `output_text` 字段。[完整响应][完整响应]、[文本输出][文本输出]

## 2. 追加参数与返回变化

参数可能新增内容块、扩充文本块字段、改变停止原因，或切换为流式返回。

| 追加或修改的入参                                                                 | 返回值的具体变化                                                                                                                                     | 不应误解成什么                                                                              | 证据                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `stream: true`                                                                   | 完整 JSON 改为 SSE 命名事件，包括 `message_start`、`content_block_delta`、`message_delta`、`message_stop`                                            | 每个事件不是完整消息；文本增量位于 `delta.text`                                             | [流式返回][流式返回]、[流式类型][流式类型]                               |
| `tools: [{"name":...,"input_schema":...}]`，自定义客户端工具                     | 若模型调用工具，`content` 出现 `tool_use`，含 `id`、`name`、`input`；通常以 `stop_reason: "tool_use"` 交还执行权                                     | `input` 是结构化 JSON 值，不是 JSON 字符串；声明工具不会自动执行                            | [工具定义][工具定义]、[工具调用][工具调用]、[完整响应][完整响应]         |
| `tool_choice: {"type":"auto" / "any" / "none"}`，或 `{"type":"tool","name":...}` | `auto` 自行决定，`any` 要求使用工具，`none` 禁止调用，`tool` 指定工具                                                                                | `any` / `tool` 的支持受模型和思考模式限制；不会新增响应 `tool_choice`                       | [工具选择][工具选择]、[定义工具][定义工具]                               |
| `tool_choice.disable_parallel_tool_use: true`                                    | `auto` 下最多一次工具调用；支持强制调用的 `any` / `tool` 下恰好一次                                                                                  | 参数位于 `tool_choice` 内，不是顶层 `parallel_tool_calls`；不替调用方执行工具               | [工具选择][工具选择]                                                     |
| 自定义工具的 `strict: true`                                                      | 在支持严格工具调用的模型上，工具名称和 `input` 符合声明的 schema                                                                                     | 不保证工具必定被调用，也不改变工具调用内容块类型                                            | [工具定义][工具定义]、[结构化输出][结构化输出]                           |
| `output_config.format: {"type":"json_schema","schema":...}`                      | 文本块的 `text` 改为符合 schema 的 JSON 字符串                                                                                                       | 外层仍是 Message；不是直接返回业务对象，拒绝和 token 截断需另行处理                         | [JSON 格式][JSON 格式]、[结构化输出][结构化输出]                         |
| `thinking: {"type":"enabled","budget_tokens":...}`                               | 支持手动思考的模型可增加 `thinking` 块，含 `thinking` 和 `signature`；思考占用 `max_tokens`                                                          | 普通手动模式预算至少 1024 且小于 `max_tokens`，交错思考另有预算规则；不是所有模型接受此模式 | [思考类型][思考类型]、[手动思考][手动思考]                               |
| `thinking: {"type":"adaptive"}`                                                  | 支持自适应思考的模型自行决定是否及思考多少；可产生 `thinking` 块                                                                                     | 不需要 `budget_tokens`；不保证每次都有非空思考文本，部分模型默认已开启                      | [思考类型][思考类型]、[思考模式][思考模式]                               |
| `thinking.display: "summarized" / "omitted"`                                     | 前者返回思考摘要；后者返回空的 `thinking` 文本并保留 `signature`                                                                                     | 隐藏文本不等于关闭思考，不降低该部分计费；默认值依模型而定                                  | [思考模式][思考模式]、[流式返回][流式返回]                               |
| `output_config.effort`                                                           | 调整生成投入；支持的值包括 `low`、`medium`、`high`、`xhigh`、`max`，范围依模型而定                                                                   | 不是固定 token 预算，不新增响应 `effort` 字段                                               | [输出配置][输出配置]、[投入控制][投入控制]                               |
| 顶层 `cache_control: {"type":"ephemeral"}`，或工具 / 内容块上的同名字段          | 自动缓存最后可缓存块之前的前缀，或设置显式缓存断点；`usage` 体现缓存写入和读取 token 数                                                              | 不是缓存回答；不足模型缓存最小长度时不会因此命中缓存                                        | [缓存][缓存]、[缓存类型][缓存类型]、[用量][用量]                         |
| `stop_sequences: ["..."]`                                                        | 命中时为 `stop_reason: "stop_sequence"`，`stop_sequence` 返回命中的字符串                                                                            | 自定义序列与自然结束的 `end_turn` 是不同原因                                                | [请求参数][请求参数]、[完整响应][完整响应]                               |
| `max_tokens`                                                                     | 限制总生成预算；达到上限时可为 `stop_reason: "max_tokens"`                                                                                           | 文本或工具输入可能尚未完整；不是只限制可见答案                                              | [请求参数][请求参数]、[手动思考][手动思考]、[处理工具][处理工具]         |
| `tools: [{"type":"web_search_20250305","name":"web_search"}]` 等搜索工具         | 可增加 `server_tool_use`、`web_search_tool_result`；文本可带 `web_search_result_location` 引用，`usage.server_tool_use.web_search_requests` 记录次数 | 由服务端执行；调用、搜索结果、最终答案引用是不同结构                                        | [网页搜索][网页搜索]、[搜索类型][搜索类型]、[服务工具用量][服务工具用量] |
| `document` 块的 `citations: {"enabled":true}`                                    | 回答文本可增加 `citations`，按文档类型给出页码、字符或内容块定位                                                                                     | 传入文档本身不会自动开启引用；与严格 JSON 输出不能同时使用                                  | [文档输入][文档输入]、[文档引用][文档引用]、[结构化输出][结构化输出]     |
| `service_tier: "auto" / "standard_only"`                                         | 控制是否使用优先容量；实际处理层级在 `usage.service_tier`                                                                                            | 不是顶层响应 `service_tier`，也不是请求值的原样回显                                         | [请求参数][请求参数]、[用量][用量]                                       |

手动 `enabled` 思考在 Claude 4.6 上已弃用，Claude 4.7 及之后的模型不接受此模式；Claude 4.5 的三种模型不接受 `adaptive`。手动思考不支持强制 `any` / `tool`；部分较新模型也直接拒绝强制工具调用。具体配置按模型能力选择。[手动思考][手动思考]、[思考模式][思考模式]、[定义工具][定义工具]

### 2.1 流式返回

追加 `stream: true` 后，下例展示一个文本块的完整事件顺序，省略部分可选及细分字段：[流式返回][流式返回]

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_example","type":"message","role":"assistant","model":"<实际可用的模型 ID>","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好！"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}

event: message_stop
data: {"type":"message_stop"}
```

按 `index` 关联内容块，按 `delta.type` 处理增量：`text_delta.text` 拼接文本，`input_json_delta.partial_json` 拼接工具输入后再解析 JSON，`thinking_delta.thinking` 拼接思考，`signature_delta.signature` 保存签名，`citations_delta.citation` 追加引用。工具输入分片不保证本身是有效 JSON，应等对应 `content_block_stop` 后解析。[流式返回][流式返回]、[内容增量][内容增量]

`message_delta.usage` 是累计值，不能把各事件计数相加；保留 `message_start` 的输入用量，并用后续事件更新用量和停止原因。`message_stop` 表示消息结束，没有 `[DONE]` 标记或 `include_usage` 选项。流中还可能穿插 `ping`、出现 `error` 事件；HTTP 200 不保证后续流成功。[流式返回][流式返回]、[请求参数][请求参数]、[API 错误][API 错误]

### 2.2 工具调用

工具 schema 位于 `input_schema`，工具选择使用对象；下例允许模型自行决定是否调用，并关闭并行工具调用。[工具定义][工具定义]、[工具选择][工具选择]

```json
{
  "model": "<实际可用的模型 ID>",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "使用 add 计算 2 加 3。" }],
  "tools": [
    {
      "name": "add",
      "description": "计算两个有限数字的和。",
      "input_schema": {
        "type": "object",
        "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
        "required": ["a", "b"],
        "additionalProperties": false
      }
    }
  ],
  "tool_choice": { "type": "auto", "disable_parallel_tool_use": true }
}
```

若模型调用工具，响应的主要内容如下；调用块的 `input` 已是 JSON 值。[工具调用][工具调用]、[完整响应][完整响应]

```json
{
  "id": "msg_tool_example",
  "type": "message",
  "role": "assistant",
  "model": "<实际可用的模型 ID>",
  "content": [
    { "type": "tool_use", "id": "toolu_example", "name": "add", "input": { "a": 2, "b": 3 } }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null
}
```

调用方校验并执行工具后，把原有历史、上一条完整 `assistant.content` 和关联结果一起传回。以下省略重复的工具定义；再次发起请求时应保留对应 `tools`。结果中的业务 JSON 由调用方定义。[请求参数][请求参数]、[工具结果][工具结果]、[处理工具][处理工具]

```json
{
  "model": "<实际可用的模型 ID>",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "使用 add 计算 2 加 3。" },
    {
      "role": "assistant",
      "content": [
        { "type": "tool_use", "id": "toolu_example", "name": "add", "input": { "a": 2, "b": 3 } }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_example",
          "content": "{\"ok\":true,\"sum\":5}"
        }
      ]
    }
  ]
}
```

`tool_result.tool_use_id` 对应调用块的 `id`；工具结果消息必须紧接该助手消息，且同一用户消息内的工具结果块放在普通文本之前。并行调用的结果放在同一条 `user` 消息中。执行失败通过 `tool_result.is_error: true` 及 `content` 回传；`content` 也可为文本、图片、文档等受支持块的数组。[处理工具][处理工具]、[并行工具][并行工具]、[工具结果][工具结果]

包含思考的工具调用应保留整条助手内容及其思考块顺序，原样回传 `thinking` / `signature` 和 `redacted_thinking.data`；不能只取 `tool_use` 后丢弃关联上下文。[思考输出][思考输出]、[隐藏思考][隐藏思考]、[思考模式][思考模式]

### 2.3 JSON 输出

追加 `output_config.format`；`schema` 直接位于格式对象内，没有 OpenAI 格式中的 `name` 或格式级 `strict` 字段。[JSON 格式][JSON 格式]

```json
{
  "output_config": {
    "format": {
      "type": "json_schema",
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

回答仍为 `{"type":"text","text":"{\"answer\":\"你好！\",\"language\":\"中文\"}","citations":null}`。严格输出使用受支持的 JSON Schema 子集；`stop_reason: "refusal"` 的拒绝文本可不符合 schema，`max_tokens` 截断可使 JSON 不完整，解析前应先检查停止原因。[结构化输出][结构化输出]

旧版顶层 `output_format` 已迁移为 `output_config.format`；继续使用旧入口需要 `structured-outputs-2025-11-13` beta 头，当前入口不需要该 beta 头。Python SDK 的 `messages.parse(output_format=...)` 是本地辅助入口，会转换为 `output_config.format`，不能据此把 `output_format` 写入标准 HTTP 请求体。[结构化输出][结构化输出]

## 3. 返回字段细分

| 返回路径                                       | 内容与注意事项                                                                                                                              | 证据                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `stop_reason: "end_turn"`                      | 模型自然结束当前助手回合                                                                                                                    | [完整响应][完整响应]                       |
| `stop_reason: "max_tokens"`                    | 达到请求的 `max_tokens` 或模型生成上限；输出可能不完整                                                                                      | [完整响应][完整响应]、[处理工具][处理工具] |
| `stop_reason: "stop_sequence"`                 | 命中自定义序列，具体值读取 `stop_sequence`                                                                                                  | [完整响应][完整响应]                       |
| `stop_reason: "tool_use"`                      | 模型发出一个或多个工具调用；客户端工具需执行后回传结果                                                                                      | [完整响应][完整响应]、[处理工具][处理工具] |
| `stop_reason: "pause_turn"`                    | 服务端暂停长运行回合；可把返回内容原样加入下一轮历史继续生成                                                                                | [完整响应][完整响应]                       |
| `stop_reason: "refusal"`                       | 流式分类器介入处理潜在政策违规，模型拒绝输出                                                                                                | [完整响应][完整响应]                       |
| `stop_reason: "model_context_window_exceeded"` | 达到模型上下文窗口限制                                                                                                                      | [完整响应][完整响应]                       |
| `stop_details`                                 | 拒绝详情，含 `type: "refusal"`、可空的 `category` 与 `explanation`；不能按稳定文案解析                                                      | [拒绝详情][拒绝详情]                       |
| `usage.input_tokens`                           | 不含缓存写入、读取的输入 token；总输入为此值加 `cache_creation_input_tokens`、`cache_read_input_tokens`                                     | [完整响应][完整响应]、[用量][用量]         |
| `usage.output_tokens`                          | 输出总用量，包含思考；不与可见文本长度一一对应，空文本也可能有输出用量                                                                      | [完整响应][完整响应]、[思考模式][思考模式] |
| `usage.output_tokens_details.thinking_tokens`  | 原始内部思考的 token 细分；不等于返回摘要的 token 数，细分对象可为 `null`                                                                   | [思考用量][思考用量]、[用量][用量]         |
| `usage.cache_creation`                         | 可空的缓存写入细分，含 `ephemeral_5m_input_tokens`、`ephemeral_1h_input_tokens`                                                             | [缓存类型][缓存类型]、[用量][用量]         |
| `usage.server_tool_use`                        | 可空的服务工具用量，含 `web_search_requests`、`web_fetch_requests`                                                                          | [服务工具用量][服务工具用量]、[用量][用量] |
| `content[i].thinking`、`.signature`            | `thinking` 块的思考文本或摘要与不透明签名；摘要可为空，签名需原样保留                                                                       | [思考输出][思考输出]、[思考模式][思考模式] |
| `content[i].data`                              | `redacted_thinking` 块的不透明加密内容，无法当作文本思考解析                                                                                | [隐藏思考][隐藏思考]                       |
| `content[i].citations[j]`                      | 类型包括 `char_location`、`page_location`、`content_block_location`、`web_search_result_location`、`search_result_location`；字段随类型改变 | [引用联合][引用联合]                       |

PDF 引用使用 `start_page_number` / `end_page_number`，纯文本引用使用 `start_char_index` / `end_char_index`；网页引用使用 `url`、`title`、`cited_text` 和 `encrypted_index`。应按引用类型读取，而非统一套用 URL 或字符偏移结构。[文档定位][文档定位]、[网页定位][网页定位]

`end_turn` 表示当前助手回合结束；`message_stop` 表示流式消息传输结束。二者均不能代替工具调用业务的执行结果。协议没有 `finish_reason`、`total_tokens` 或 OpenAI 的 `completion_tokens_details.reasoning_tokens` 字段。[完整响应][完整响应]、[用量][用量]、[流式返回][流式返回]

## 4. 其他参数

### 4.1 生成与控制参数

| 入参                              | 作用及返回变化                                                                                                                                            | 证据                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `temperature`、`top_p`、`top_k`   | 采样参数，改变生成内容；当前 SDK 标为弃用。Opus 4.6 之后的模型不支持调节：`temperature` 仅兼容 `1.0`，`top_p` 仅兼容不小于 `0.99`，`top_k` 任意值均被拒绝 | [请求参数][请求参数]                       |
| `metadata.user_id`                | 调用方的用户标识，应使用 UUID、哈希等不透明值；不是任意键值元数据，也不回传为回答内容                                                                     | [元数据][元数据]                           |
| `cache_control.ttl`               | `5m` / `1h`；默认 5 分钟，作用于缓存前缀而非消息保存期限                                                                                                  | [缓存类型][缓存类型]、[缓存][缓存]         |
| `diagnostics.previous_message_id` | 请求与指定历史消息比较缓存前缀；发生缓存差异时可返回 `diagnostics.cache_miss_reason`                                                                      | [诊断][诊断]、[请求参数][请求参数]         |
| `inference_geo`                   | 指定推理处理地区；实际处理地区可在 `usage.inference_geo` 中读取                                                                                           | [请求参数][请求参数]、[用量][用量]         |
| `max_tokens: 0`                   | 预热提示词缓存而不生成回答；不能与需要正数预算的手动思考同用                                                                                              | [请求参数][请求参数]、[手动思考][手动思考] |

### 4.2 补充输入与工具能力

| 追加入参                                                             | 支持的返回变化或行为                                                                                                     | 证据                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `messages[i].content[j].type: "image"`                               | 增加图片输入；`source` 可为 URL、Base64 或文件引用，Base64 格式含 `media_type`、`data`；本身不增加图片生成输出块         | [图片输入][图片输入]、[Base64 输入][Base64 输入]、[输出联合][输出联合]   |
| `messages[i].content[j].type: "document"`                            | 增加 PDF、纯文本或其他支持的文档来源；PDF Base64 使用 `media_type: "application/pdf"`，URL 来源使用 `type: "url"`、`url` | [文档输入][文档输入]、[Base64 输入][Base64 输入]、[PDF 输入][PDF 输入]   |
| `document.citations: {"enabled":true}`、`search_result.citations`    | 开启文档或调用方搜索结果的引用；回答可带对应来源定位                                                                     | [文档输入][文档输入]、[搜索结果输入][搜索结果输入]、[文档引用][文档引用] |
| `tools[j].type: "web_fetch_20250910"`，`name: "web_fetch"`           | 服务端抓取网页；可返回 `server_tool_use` 与 `web_fetch_tool_result`，结果通过 `tool_use_id` 关联调用                     | [网页抓取][网页抓取]、[抓取类型][抓取类型]                               |
| `tools[j].type: "code_execution_20250522"`，`name: "code_execution"` | 在服务端容器执行代码，可返回 `server_tool_use`、`code_execution_tool_result`；响应 `container` 提供容器信息              | [代码工具][代码工具]、[输出联合][输出联合]、[完整响应][完整响应]         |
| `tools[j].eager_input_streaming`，配合流式请求                       | 支持细粒度工具输入流；参数在尚未形成完整 JSON 时就可能返回，仍需拼接并校验                                               | [工具定义][工具定义]、[流式返回][流式返回]                               |

工具版本需与模型匹配，文件引用及 beta 能力须满足对应接口要求。[请求参数][请求参数]、[输入联合][输入联合]、[Beta 头][Beta 头]

## 5. SDK 选项与错误响应

`signal`、`timeout`、`maxRetries` 属于 TypeScript SDK 请求选项或客户端配置，不是 Messages JSON 入参；它们控制取消、超时和重试，不新增成功响应字段。[请求选项][请求选项]

`messages.stream().finalMessage()` 在客户端聚合事件；`finalText()` 提取最后一条消息的文本块并以空格拼接，无文本块时会拒绝。`messages.parse()` 增加顶层及文本块上的 `parsed_output`，属于 SDK 本地解析字段，不是 HTTP 协议新增字段。[SDK 聚合][SDK 聚合]、[SDK 解析][SDK 解析]

`_request_id` 来自 `request-id` 响应头；`.withResponse()` 的 `data`、`response`、`request_id`、`workspace_id` 是 SDK 包装。鉴权使用 `Authorization: Bearer <token>`，也支持 `x-api-key`；API 版本通过 `anthropic-version` 指定，例如 `2023-06-01`。这些字段及 `anthropic-beta` 都是 HTTP 头，不是 JSON 入参；beta SDK 的 `betas` 参数会生成 beta 头。[API 概览][API 概览]、[API 错误][API 错误]、[HTTP 包装][HTTP 包装]、[Beta 头][Beta 头]

HTTP 错误响应的结构示意为 `{"type":"error","error":{"type":"invalid_request_error","message":"请求参数不合法。"},"request_id":"req_example"}`；读取 `error.type`、`error.message` 与请求标识。常见状态为 400 参数错误、401 鉴权错误、403 权限错误、429 限流、500 服务错误、529 过载。[API 错误][API 错误]

SSE 中途错误使用 `event: error` 及 `{"type":"error","error":{"type":"overloaded_error","message":"服务暂时过载。"}}`。客户端工具失败通过 `tool_result.is_error` 回传；服务端搜索失败可能出现在 `web_search_tool_result.content` 的 `web_search_tool_result_error.error_code`，即使 HTTP 200 也需检查。它们分别是传输或 API 错误、工具执行错误，不能混为一种成功响应字段。[流式返回][流式返回]、[处理工具][处理工具]、[搜索类型][搜索类型]

[创建]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L40-L73
[请求参数]: https://platform.claude.com/docs/en/api/messages/create
[完整响应]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2508-L2640
[消息输入]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2707-L2711
[输入联合]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2286-L2302
[输出联合]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2272-L2284
[文本输出]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3104-L3117
[用量]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3905-L3955
[工具定义]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3386-L3462
[工具选择]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3497-L3558
[工具调用]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3854-L3869
[工具结果]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3580-L3607
[定义工具]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
[处理工具]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
[并行工具]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
[流式返回]: https://platform.claude.com/docs/en/build-with-claude/streaming
[流式类型]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2806-L2911
[内容增量]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2806-L2811
[思考模式]: https://platform.claude.com/docs/en/build-with-claude/thinking
[手动思考]: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
[思考类型]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3313-L3373
[思考输出]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3272-L3311
[隐藏思考]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2913-L2941
[输出配置]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2760-L2773
[投入控制]: https://platform.claude.com/docs/en/build-with-claude/effort
[JSON 格式]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2466-L2473
[结构化输出]: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
[缓存]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[缓存类型]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1200-L1228
[服务工具用量]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3009-L3019
[网页搜索]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
[搜索类型]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L4428-L4691
[文档引用]: https://platform.claude.com/docs/en/build-with-claude/citations
[引用联合]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3132-L3137
[文档定位]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1286-L1410
[网页定位]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L1527-L1539
[拒绝详情]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2946-L2981
[思考用量]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2775-L2788
[元数据]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2721-L2732
[诊断]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2316-L2339
[图片输入]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2423-L2446
[文档输入]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2364-L2381
[Base64 输入]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L209-L223
[PDF 输入]: https://platform.claude.com/docs/en/build-with-claude/pdf-support
[搜索结果输入]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L2983-L2994
[网页抓取]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool
[抓取类型]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/resources/messages/messages.ts#L3983-L4058
[代码工具]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
[请求选项]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/internal/request-options.ts#L8-L105
[SDK 聚合]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/MessageStream.ts#L339-L377
[SDK 解析]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/parser.ts#L28-L123
[HTTP 包装]: https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/core/api-promise.ts#L50-L82
[API 概览]: https://platform.claude.com/docs/en/api/overview
[Beta 头]: https://platform.claude.com/docs/en/api/beta-headers
[API 错误]: https://platform.claude.com/docs/en/api/errors
