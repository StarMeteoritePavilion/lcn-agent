# Google Gemini 入参与返回值

接口：`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`。模型 ID 放在 URL，JSON 请求体必填 `contents`；非流式回答位于 `candidates[i].content.parts`。本文使用 Gemini Developer API 参考中的 REST 字段写法，SDK 的 `config` 层级见第 5 节。[创建][创建]、[内容结构][内容结构]

以下示例仅展示结构，模型 ID 需替换为实际可用值；参数、工具与输出模态的支持情况取决于模型。范围为 `generateContent` / `streamGenerateContent`，不包含 Interactions、Live 双向接口或独立的 Imagen、Veo 生成接口。[生成配置][生成配置]、[流式接口][流式接口]

## 1. 基础入参与返回值

### 1.1 最小文本请求

请求发送到 `models/{model}:generateContent`：[创建][创建]

```json
{
  "contents": [{ "role": "user", "parts": [{ "text": "请用中文打个招呼。" }] }]
}
```

| 入参路径                    | 含义与约束                                                                                   | 证据                 |
| --------------------------- | -------------------------------------------------------------------------------------------- | -------------------- |
| URL 中的 `{model}`          | 实际使用的模型 ID；不是 JSON 请求体中的 `model`                                              | [创建][创建]         |
| `contents`                  | 消息数组；多轮请求需包含要保留的历史与最新消息                                               | [创建][创建]         |
| `contents[i].role`          | 消息生产者为 `user` 或 `model`；单轮可省略，不使用 `assistant`、`tool` 角色                  | [内容结构][内容结构] |
| `contents[i].parts`         | 有序内容块数组，可组合文本、媒体、函数调用与函数结果                                         | [内容块][内容块]     |
| `contents[i].parts[j].text` | 当前内容块的文本                                                                             | [内容块][内容块]     |
| `systemInstruction`         | 顶层系统指令，结构为 `Content`，当前只支持文本；例如 `{"parts":[{"text":"请用中文回答。"}]}` | [创建][创建]         |
| `generationConfig`          | 生成与输出配置，包含采样、输出上限、结构化格式、思考和模态选项                               | [生成配置][生成配置] |

一个 `Part` 的数据类型互斥：`text`、`inlineData`、`fileData`、`functionCall` 等最多设置一个；`thought`、`thoughtSignature` 是附加信息，可与具体数据共存。[内容块][内容块]

### 1.2 非流式响应

普通文本响应示例；用量为结构示意值：[完整响应][完整响应]、[生成结果][生成结果]、[用量][用量]

```json
{
  "candidates": [
    {
      "content": { "role": "model", "parts": [{ "text": "你好！" }] },
      "finishReason": "STOP",
      "index": 0
    }
  ],
  "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 3, "totalTokenCount": 13 },
  "modelVersion": "<实际返回的模型版本>",
  "responseId": "response-example"
}
```

| 返回路径                              | 含义                                                  | 是否固定有内容                                   | 证据                                       |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| `candidates`                          | 生成结果数组                                          | 输入被拦截时可不返回结果；不能固定读取第一个元素 | [完整响应][完整响应]                       |
| `candidates[i].index`                 | 生成结果的索引                                        | 按实际返回读取；流式用于区分结果                 | [生成结果][生成结果]                       |
| `candidates[i].content.role`          | 模型消息角色 `model`                                  | 需先检查 `content` 是否存在                      | [内容结构][内容结构]、[生成结果][生成结果] |
| `candidates[i].content.parts`         | 模型输出的内容块数组                                  | 不保证只有文本，也不保证非空                     | [内容块][内容块]、[生成结果][生成结果]     |
| `candidates[i].content.parts[j].text` | 当前块的文本                                          | 可缺失；工具调用和媒体输出不放在此字段           | [内容块][内容块]                           |
| `candidates[i].finishReason`          | 生成停止原因                                          | 流式生成中可缺失，不能把缺失当作 `STOP`          | [生成结果][生成结果]                       |
| `candidates[i].finishMessage`         | 停止原因的补充说明                                    | 可选，在设置停止原因时提供                       | [生成结果][生成结果]                       |
| `candidates[i].safetyRatings`         | 输出安全评估，含 `category`、`probability`、`blocked` | 按实际返回读取                                   | [生成结果][生成结果]、[安全评估][安全评估] |
| `promptFeedback`                      | 输入过滤反馈，含 `blockReason`、`safetyRatings`       | 输入被拦截时重点检查；不是回答文本               | [输入反馈][输入反馈]                       |
| `usageMetadata`                       | 请求级 token 用量及细分                               | 字段可能缺失，不作为解析回答的前提               | [用量][用量]、[SDK 响应][SDK 响应]         |
| `modelVersion`、`responseId`          | 实际模型版本、响应标识                                | 按实际返回读取，不由请求值推导                   | [完整响应][完整响应]                       |
| `modelStatus`                         | 模型阶段、退役时间和说明                              | 补充状态字段，不是回答内容                       | [完整响应][完整响应]                       |

## 2. 追加参数与返回变化

以下路径均指 REST 请求体；流式通过更换接口实现，不是追加 `stream: true`。[创建][创建]、[流式接口][流式接口]

| 追加或修改的入参                                                               | 返回值的具体变化                                                                                             | 不应误解成什么                                                   | 证据                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| 改用 `:streamGenerateContent?alt=sse`                                          | 返回 SSE，每份 `data` 是一份 `GenerateContentResponse`，内容由多个片段组成                                   | 没有 OpenAI 的 `delta` 包装，也不使用其 `[DONE]` 结束标记        | [流式接口][流式接口]、[SDK 流解析][SDK 流解析]               |
| `tools: [{"functionDeclarations":[...]}]`                                      | 模型调用函数时出现 `parts[j].functionCall`，含 `name`、对象型 `args`，以及可选 `id`                          | 声明不会自动执行本地函数；`args` 不是 JSON 字符串                | [函数声明][函数声明]、[函数调用][函数调用]                   |
| `toolConfig.functionCallingConfig.mode`                                        | `AUTO` 自主选择；`ANY` 只输出函数调用；`NONE` 禁止调用；`VALIDATED` 在自然语言和受约束解码的函数调用之间选择 | 不新增同名输出字段，也不代表工具已经执行成功                     | [调用配置][调用配置]                                         |
| `toolConfig.functionCallingConfig.allowedFunctionNames`                        | 在 `ANY` / `VALIDATED` 下限制可调用的函数名称                                                                | 不用于关联某一次调用；名称须与声明一致                           | [调用配置][调用配置]                                         |
| `generationConfig.responseMimeType: "application/json"`                        | 文本块改为 JSON 文本，仍通过 `parts[j].text` 返回                                                            | 外层仍是生成响应，不会自动变成业务对象                           | [生成配置][生成配置]                                         |
| `generationConfig.responseJsonSchema` 或 `responseSchema`，配合 JSON MIME 类型 | 限制文本块中 JSON 的结构；两种 schema 参数互斥，支持范围有限                                                 | 不会新增 REST `parsed` 字段，也不保证业务语义正确                | [SDK 生成配置][SDK 生成配置]、[生成配置][生成配置]           |
| `generationConfig.thinkingConfig.thinkingBudget` / `.thinkingLevel`            | 控制模型思考投入，`usageMetadata.thoughtsTokenCount` 可记录思考用量                                          | 不表示所有思考都会以文本返回；可用值与限制依模型而定             | [思考配置][思考配置]、[用量][用量]                           |
| `generationConfig.thinkingConfig.includeThoughts: true`                        | 模型支持且有相应内容时，可出现 `thought: true` 的内容块                                                      | 不保证必有思考文本；不透明签名也不是可读思考                     | [思考配置][思考配置]、[内容块][内容块]                       |
| `generationConfig.candidateCount: 2` 等                                        | 增加 `candidates` 中的生成结果，用量覆盖全部结果                                                             | 不是每条输入消息对应一个回答；仅适用于支持的模型                 | [生成配置][生成配置]、[用量][用量]                           |
| `generationConfig.responseLogprobs: true`，可加 `logprobs: k`                  | 结果可含 `avgLogprobs`、`logprobsResult`；`k` 为 0–20，控制每个解码步骤的高概率 token 数                     | 不等于答案真实性评分，也不是生成多份完整回答                     | [生成配置][生成配置]、[概率结构][概率结构]                   |
| `tools: [{"googleSearch":{}}]`                                                 | 搜索参与回答时，结果可附 `groundingMetadata`，包含检索词、来源及引用对应关系                                 | 不等于自定义函数调用的 `functionCall` / `functionResponse` 流程  | [工具结构][工具结构]、[搜索依据][搜索依据]                   |
| `tools: [{"urlContext":{}}]`                                                   | URL 检索结果可附 `urlContextMetadata.urlMetadata`，含 `retrievedUrl` 与 `urlRetrievalStatus`                 | 不保证每个 URL 都成功读取；需检查检索状态                        | [工具结构][工具结构]、[URL 元数据][URL 元数据]               |
| `generationConfig.responseModalities`                                          | 支持的音频或图片输出可通过 `parts[j].inlineData` 返回，含 `mimeType` 与 Base64 `data`                        | 不会新增 OpenAI 的 `message.audio`；输入媒体与输出模态是不同设置 | [生成配置][生成配置]、[内容块][内容块]、[媒体数据][媒体数据] |
| `cachedContent: "cachedContents/..."`                                          | 使用已创建的缓存上下文；用量可含 `cachedContentTokenCount` 与 `cacheTokensDetails`                           | 不在成功响应中返回缓存全文；输入总用量已包含缓存部分             | [创建][创建]、[用量][用量]                                   |
| `safetySettings`                                                               | 调整指定安全类别的拦截阈值；反馈在 `promptFeedback` 或结果的 `safetyRatings`、`finishReason` 中              | HTTP 成功不代表有可展示文本；不会新增一条统一的拒绝消息          | [创建][创建]、[完整响应][完整响应]                           |

### 2.1 流式返回

把相同请求体发送到 `models/{model}:streamGenerateContent?alt=sse`。响应示意：[流式接口][流式接口]、[SDK 流解析][SDK 流解析]

```text
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你"}]},"index":0}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"好！"}]},"index":0}]}

data: {"candidates":[{"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"totalTokenCount":13}}
```

按 `index` 区分生成结果，按到达顺序拼接文本；每片段都要独立检查内容块类型、停止原因和输入反馈。一个片段未必包含 `content` 或 `text`；函数调用要读取 `functionCall` 对象，不按 OpenAI 的 `arguments` 字符串增量解析。SDK 逐份产出响应，并不自动把整个流变为一个最终响应。[生成结果][生成结果]、[内容块][内容块]、[SDK 流返回][SDK 流返回]

`usageMetadata` 是生成请求用量，不是声明为每片段新增用量的计数；保留服务端返回的统计，不能把所有片段直接相加。流中断时也不能依赖一定收到最终用量或停止原因。检索引用的 `groundingChunkIndices` 可指向整个流中的来源列表，须按顺序累积 `groundingChunks`。[用量][用量]、[引用对应][引用对应]、[SDK 流解析][SDK 流解析]

### 2.2 工具调用

追加函数声明与调用策略；`parametersJsonSchema` 使用 JSON Schema，对函数参数对象进行描述：[函数声明][函数声明]、[调用配置][调用配置]

```json
{
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "add",
          "description": "计算两个有限数字的和。",
          "parametersJsonSchema": {
            "type": "object",
            "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
            "required": ["a", "b"],
            "additionalProperties": false
          }
        }
      ]
    }
  ],
  "toolConfig": { "functionCallingConfig": { "mode": "ANY", "allowedFunctionNames": ["add"] } }
}
```

模型输出调用的结构示例。`id` 可缺失；下面展示存在 `id` 的情况：[函数调用][函数调用]

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          { "functionCall": { "id": "call-example", "name": "add", "args": { "a": 2, "b": 3 } } }
        ]
      },
      "finishReason": "STOP",
      "index": 0
    }
  ]
}
```

调用方校验并执行函数后，把原始模型 `content` 加入历史，再用 `user` 内容块回传 `functionResponse`；名称与调用一致，返回的 `id` 有值时原样关联。保留模型消息中的其他内容及 `thoughtSignature`，不要只重建函数名称与参数。下一轮通常用 `AUTO` 允许模型基于结果回答；持续使用 `ANY` 会继续约束为函数调用。[函数结果][函数结果]、[内容结构][内容结构]、[调用配置][调用配置]、[内容块][内容块]

```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "请计算 2 加 3。" }] },
    {
      "role": "model",
      "parts": [
        { "functionCall": { "id": "call-example", "name": "add", "args": { "a": 2, "b": 3 } } }
      ]
    },
    {
      "role": "user",
      "parts": [
        { "functionResponse": { "id": "call-example", "name": "add", "response": { "result": 5 } } }
      ]
    }
  ]
}
```

上面只展示下一轮的 `contents`，工具配置沿用并调整调用策略。每个函数调用都应有对应结果；一轮可以出现多个函数调用块。失败结果可通过 `functionResponse.response.error` 告知模型，和 HTTP / API 错误分别处理。`parameters` 使用 API 的 `Schema` 类型与 OpenAPI 子集；`parametersJsonSchema` 使用 JSON Schema，两者不能同时填写。[函数结果][函数结果]、[函数声明][函数声明]、[SDK 工具结构][SDK 工具结构]

### 2.3 JSON 输出

在基础请求中追加以下配置，文本块中的输出遵循 schema；此处使用 SDK 与 REST 转换器都明确支持的 `responseJsonSchema`：[SDK 生成配置][SDK 生成配置]、[SDK 参数转换][SDK 参数转换]

```json
{
  "generationConfig": {
    "responseMimeType": "application/json",
    "responseJsonSchema": {
      "type": "object",
      "properties": { "answer": { "type": "string" } },
      "required": ["answer"],
      "additionalProperties": false
    }
  }
}
```

返回仍是 `candidates[i].content.parts[j].text`，例如 `{"text":"{\"answer\":\"你好！\"}"}`；调用方提取并解析 JSON，再做业务校验。截断、安全拦截与工具调用仍需按停止原因和内容类型处理，不能无条件对第一块执行 JSON 解析。[内容块][内容块]、[停止原因][停止原因]

API 参考已将 `responseSchema` 标为弃用，推荐 `generationConfig.responseFormat`；新的 REST JSON 配置形状为 `{"text":{"mimeType":"APPLICATION_JSON","schema":{...}}}`。这里的 MIME 值是枚举 `APPLICATION_JSON`，不同于 `responseMimeType` 的字符串 `application/json`；本文引用的 SDK `GenerateContentConfig` 及转换器尚未提供 `responseFormat`，不能直接写成 `config.responseFormat`。[生成配置][生成配置]、[输出格式][输出格式]、[SDK 生成配置][SDK 生成配置]

## 3. 返回字段细分

| 返回路径或取值                                                                                                     | 内容与注意事项                                                                                         | 证据                                           |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `finishReason: "STOP"`                                                                                             | 自然停止或命中停止序列；函数调用也通过内容块判断，协议没有专用的 `tool_calls` 停止原因                 | [停止原因][停止原因]、[函数调用][函数调用]     |
| `finishReason: "MAX_TOKENS"`                                                                                       | 达到生成上限，回答或 JSON 可能不完整                                                                   | [停止原因][停止原因]                           |
| `finishReason: "SAFETY" / "BLOCKLIST" / "PROHIBITED_CONTENT" / "SPII"`                                             | 输出触发安全、禁用词、禁止内容或敏感个人信息限制                                                       | [停止原因][停止原因]                           |
| `finishReason: "RECITATION" / "LANGUAGE" / "OTHER"`                                                                | 复述限制、不支持的语言或其他停止原因                                                                   | [停止原因][停止原因]                           |
| `finishReason: "MALFORMED_FUNCTION_CALL" / "UNEXPECTED_TOOL_CALL" / "TOO_MANY_TOOL_CALLS"`                         | 函数结构不合法、未启用工具却调用工具，或连续工具调用过多                                               | [停止原因][停止原因]                           |
| `finishReason: "IMAGE_SAFETY" / "IMAGE_PROHIBITED_CONTENT" / "IMAGE_RECITATION" / "IMAGE_OTHER" / "NO_IMAGE"`      | 图片安全或生成限制；`NO_IMAGE` 表示期待图片但未生成                                                    | [停止原因][停止原因]                           |
| `promptFeedback.blockReason`                                                                                       | 输入拦截原因，例如 `SAFETY`、`BLOCKLIST`、`PROHIBITED_CONTENT`；出现时不返回生成结果                   | [输入反馈][输入反馈]                           |
| `usageMetadata.promptTokenCount`                                                                                   | 有效输入总量，包含缓存输入；不要再加缓存读取 token                                                     | [用量][用量]                                   |
| `usageMetadata.cachedContentTokenCount`                                                                            | 输入中使用缓存的 token 数，是输入的细分                                                                | [用量][用量]                                   |
| `usageMetadata.candidatesTokenCount`                                                                               | 所有生成结果的输出 token 合计                                                                          | [用量][用量]                                   |
| `usageMetadata.thoughtsTokenCount`                                                                                 | 思考模型的思考用量，不等于可见思考文本的长度                                                           | [用量][用量]、[思考配置][思考配置]             |
| `usageMetadata.toolUsePromptTokenCount`                                                                            | 工具使用提示词的 token 数                                                                              | [用量][用量]                                   |
| `usageMetadata.totalTokenCount`                                                                                    | 服务端提供的请求总用量；直接读取，不能仅按输入加可见文本估算                                           | [用量][用量]                                   |
| `usageMetadata.promptTokensDetails`、`cacheTokensDetails`、`candidatesTokensDetails`、`toolUsePromptTokensDetails` | 按 `modality` 与 `tokenCount` 细分不同模态用量                                                         | [用量][用量]                                   |
| `parts[j].thought`                                                                                                 | 标记该块是否为模型思考；提取展示答案时需与普通文本区分                                                 | [内容块][内容块]、[SDK 文本提取][SDK 文本提取] |
| `parts[j].thoughtSignature`                                                                                        | 不透明 Base64 签名，用于后续请求复用；可能附在函数调用或最终响应块上，不能解码为可读思考或迁移到别的块 | [内容块][内容块]、[思考指南][思考指南]         |
| `groundingMetadata.groundingChunks`、`.groundingSupports`                                                          | 来源列表及回答片段与来源的对应关系；不是直接附在每个文本块上的 URL 数组                                | [搜索依据][搜索依据]、[引用对应][引用对应]     |
| `groundingSupports[j].segment`                                                                                     | `partIndex` 指向内容块，`startIndex` / `endIndex` 是字节偏移，左闭右开；不能直接当 JavaScript 字符索引 | [引用对应][引用对应]                           |
| `citationMetadata.citationSources`                                                                                 | 训练素材复述等来源引用；与工具检索的 `groundingMetadata` 分别读取                                      | [生成结果][生成结果]、[引用元数据][引用元数据] |
| `logprobsResult.chosenCandidates`、`.topCandidates`                                                                | 每个解码步骤的选中 token 和高概率 token，包含 `token`、`tokenId`、`logProbability`                     | [概率结构][概率结构]                           |

## 4. 其他参数

### 4.1 生成与控制参数

| 入参                                                   | 作用及返回变化                                                                              | 证据                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `generationConfig.temperature`、`topP`、`topK`         | 调整采样内容；默认值和可用范围依模型，不新增同名返回字段                                    | [生成配置][生成配置]                               |
| `generationConfig.maxOutputTokens`                     | 限制单个生成结果的 token 数；达到上限时检查 `MAX_TOKENS`                                    | [生成配置][生成配置]、[停止原因][停止原因]         |
| `generationConfig.stopSequences`                       | 最多 5 个停止字符串；命中的字符串不包含在返回文本中，停止原因为 `STOP`                      | [生成配置][生成配置]                               |
| `generationConfig.seed`                                | 设置解码随机种子；SDK 说明只尽力复现，不保证完全确定                                        | [生成配置][生成配置]、[SDK 生成配置][SDK 生成配置] |
| `generationConfig.presencePenalty`、`frequencyPenalty` | 调整已出现或重复 token 的概率，改变文本内容，不新增输出字段                                 | [生成配置][生成配置]                               |
| `generationConfig.thinkingConfig.thinkingBudget`       | token 预算；SDK 定义 `0` 为关闭、`-1` 为自动，允许值与能否关闭依模型                        | [SDK 思考配置][SDK 思考配置]                       |
| `generationConfig.thinkingConfig.thinkingLevel`        | `MINIMAL`、`LOW`、`MEDIUM`、`HIGH` 等深度枚举；推荐 Gemini 3 及以后模型，更早模型使用会报错 | [思考配置][思考配置]                               |
| `generationConfig.mediaResolution`                     | 控制媒体处理分辨率，影响理解与用量；不是输出图片尺寸配置                                    | [生成配置][生成配置]                               |

### 4.2 补充输入与工具能力

| 追加入参                                                                | 支持的返回变化或行为                                                                                             | 证据                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `contents[i].parts[j].inlineData`                                       | 用 `mimeType` 和 Base64 `data` 提供图片、音频、视频等媒体；输出仍取决于请求模态与模型能力                        | [内容块][内容块]、[媒体数据][媒体数据]     |
| `contents[i].parts[j].fileData`                                         | 用 `fileUri` 与 `mimeType` 引用媒体；不是 OpenAI 的 `image_url` 内容块                                           | [文件数据][文件数据]                       |
| `contents[i].parts[j].videoMetadata`                                    | 配合视频数据设置片段起止与帧率；视频输入不意味着生成视频                                                         | [内容块][内容块]                           |
| `generationConfig.responseModalities: ["AUDIO"]`、`speechConfig`        | 在支持语音生成的模型上请求音频输出、配置声音；从 `inlineData.mimeType` 识别音频格式，不能把 Base64 当 URL        | [生成配置][生成配置]、[媒体数据][媒体数据] |
| `generationConfig.responseModalities: ["TEXT", "IMAGE"]`、`imageConfig` | 在支持图片输出的模型上请求文本与图片、控制图片配置；逐块读取文本及媒体                                           | [生成配置][生成配置]、[内容块][内容块]     |
| `tools: [{"codeExecution":{}}]`                                         | 服务端执行模型代码；可返回 `executableCode`（`language`、`code`）与 `codeExecutionResult`（`outcome`、`output`） | [代码执行][代码执行]                       |
| `tools: [{"fileSearch":{...}}]`                                         | 使用文件搜索；回答可带检索依据与来源，不代表返回全部文件内容                                                     | [工具结构][工具结构]、[搜索依据][搜索依据] |

媒体返回需保留各块的 MIME 类型；音频容器、编码及是否需要封装由实际 MIME 和对应模型决定。Veo 视频任务返回、Live 双向事件以及 Interactions 的 `steps` 不能套用这里的 `candidates` 结构。[媒体数据][媒体数据]、[完整响应][完整响应]、[思考指南][思考指南]

## 5. SDK 选项与错误响应

`@google/genai` 的调用参数为 `{model, contents, config}`；`model` 转入 URL，`config.systemInstruction`、`tools`、`toolConfig`、`safetySettings`、`cachedContent` 转成 REST 顶层字段，`config.temperature`、`responseMimeType`、`thinkingConfig` 等转入 `generationConfig`。不能把完整 SDK `config` 原样作为 REST 顶层 JSON。[SDK 参数转换][SDK 参数转换]

`generateContent()` 返回 SDK 响应对象；`generateContentStream()` 返回异步迭代器。`response.text` 拼接第一份结果中非 `thought` 文本，无文本时为 `undefined`；`response.functionCalls` 提取第一份结果的函数调用，无调用时为 `undefined`；`response.data` 合并第一份结果的内联字节并返回 Base64。它们都是客户端便利访问器，不是 REST 顶层字段；需要完整内容时读取 `candidates[i].content.parts`。[SDK 文本提取][SDK 文本提取]、[SDK 工具提取][SDK 工具提取]、[SDK 媒体提取][SDK 媒体提取]、[SDK 流返回][SDK 流返回]

REST 的 `citationMetadata.citationSources` 在 SDK 中转换为 `citationMetadata.citations`，读取字段时应明确所在层级。[SDK 引用转换][SDK 引用转换]

`sdkHttpResponse` 保存客户端收到的 HTTP 信息；`automaticFunctionCallingHistory` 是 SDK 自动工具调用的本地历史。自动调用取决于 SDK 可执行工具配置，普通 `functionDeclarations` 仍由调用方执行。`config.abortSignal`、`config.httpOptions.timeout`、`config.httpOptions.retryOptions` 控制客户端取消、超时和重试，不新增成功响应字段；`timeout` 的单位为毫秒。鉴权头 `x-goog-api-key` 不属于 JSON 入参。[SDK 响应][SDK 响应]、[SDK 调用实现][SDK 调用实现]、[SDK HTTP 选项][SDK HTTP 选项]、[创建][创建]

Google REST 错误使用 `error.code`（HTTP 状态码）、`error.status`（状态名称）、`error.message` 和可选 `error.details`，例如 `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"请求超过可用配额。"}}`。SDK 对 HTTP 400–599 抛出 `ApiError`，`status` 是数字状态码，`message` 保存序列化错误内容；网络或客户端错误不一定属于 `ApiError`。[Google 错误模型][Google 错误模型]、[SDK 错误处理][SDK 错误处理]

流式请求可能在传输中途失败，不能把已收到的片段视作完整回答；HTTP 错误、输入拦截的 `promptFeedback`、输出停止限制的 `finishReason` 与本地函数失败的 `functionResponse.response.error` 是不同层面的结果，分别检查。[SDK 流解析][SDK 流解析]、[输入反馈][输入反馈]、[停止原因][停止原因]、[函数结果][函数结果]

[创建]: https://ai.google.dev/api/generate-content#method:-models.generatecontent
[流式接口]: https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
[完整响应]: https://ai.google.dev/api/generate-content#generatecontentresponse
[输入反馈]: https://ai.google.dev/api/generate-content#PromptFeedback
[用量]: https://ai.google.dev/api/generate-content#UsageMetadata
[生成结果]: https://ai.google.dev/api/generate-content#Candidate
[停止原因]: https://ai.google.dev/api/generate-content#FinishReason
[内容结构]: https://ai.google.dev/api/generate-content#content
[内容块]: https://ai.google.dev/api/generate-content#Part
[媒体数据]: https://ai.google.dev/api/generate-content#Blob
[函数调用]: https://ai.google.dev/api/generate-content#FunctionCall
[函数结果]: https://ai.google.dev/api/generate-content#FunctionResponse
[函数声明]: https://ai.google.dev/api/generate-content#FunctionDeclaration
[调用配置]: https://ai.google.dev/api/caching#FunctionCallingConfig
[工具结构]: https://ai.google.dev/api/generate-content#tool
[生成配置]: https://ai.google.dev/api/generate-content#GenerationConfig
[输出格式]: https://ai.google.dev/api/generate-content#ResponseFormatConfig
[思考配置]: https://ai.google.dev/api/generate-content#ThinkingConfig
[思考指南]: https://ai.google.dev/gemini-api/docs/thinking
[搜索依据]: https://ai.google.dev/api/generate-content#GroundingMetadata
[引用对应]: https://ai.google.dev/api/generate-content#GroundingSupport
[概率结构]: https://ai.google.dev/api/generate-content#LogprobsResult
[URL 元数据]: https://ai.google.dev/api/generate-content#UrlContextMetadata
[安全评估]: https://ai.google.dev/api/generate-content#safetyrating
[引用元数据]: https://ai.google.dev/api/generate-content#citationmetadata
[文件数据]: https://ai.google.dev/api/generate-content#FileData
[代码执行]: https://ai.google.dev/api/generate-content#CodeExecution
[Google 错误模型]: https://cloud.google.com/apis/design/errors#http_mapping
[SDK 生成配置]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3095-L3261
[SDK 思考配置]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L2939-L2949
[SDK 工具结构]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L2016-L2114
[SDK 响应]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3777-L3807
[SDK 文本提取]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3808-L3860
[SDK 媒体提取]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3862-L3907
[SDK 工具提取]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L3909-L3970
[SDK 参数转换]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/converters/_models_converters.ts#L1466-L2063
[SDK 流返回]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/models.ts#L851-L895
[SDK 流解析]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/_api_client.ts#L699-L800
[SDK 调用实现]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/models.ts#L89-L286
[SDK HTTP 选项]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/types.ts#L2339-L2387
[SDK 错误处理]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/_api_client.ts#L1086-L1117
[SDK 引用转换]: https://github.com/googleapis/js-genai/blob/f6b85db43db2cb88705f60af9c394fee308ac497/src/converters/_models_converters.ts#L168-L187
