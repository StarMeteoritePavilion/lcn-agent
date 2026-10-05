# 配置指南

入口从当前工作目录读取 `setting.json`，再读取该文件同目录的 `.env`。通常应在项目根目录执行 `node dist/main.js`。

首次使用时复制 [配置示例](../setting.example.json) 和 [环境变量示例](../.env.example)。已有本地文件时仅合并需要的内容。

## 完整示例

```json
{
  "provider": "lcn29",
  "model": "gemini-3.8-flash-high",
  "modelProviders": [
    {
      "name": "lcn29",
      "api": "openai-completions",
      "models": [
        { "id": "gemini-3.8-flash-high", "maxTokens": 16384 },
        { "id": "gpt-6.1-sol", "maxTokens": 16384 }
      ],
      "baseUrl": "${BASE_URL}",
      "apiKey": "${API_KEY}"
    }
  ]
}
```

供应商名称是本地选择标识，模型标识必须使用服务实际支持的值。切换模型时修改顶层 `model`，并确保该标识已列入所选供应商的 `models`。新增供应商时向 `modelProviders` 添加完整对象，再将顶层 `provider` 设置为其 `name`。模型条目的 `maxTokens` 可省略，省略时补为 16384；显式提供时必须是正整数。示例显式设置的 16384 与配置省略时补齐的值相同，并不代表模型支持的实际上限。

在 `.env` 中填写接口基础地址和密钥：

```dotenv
API_KEY=
BASE_URL=https://example.invalid
```

这里的空密钥和示例地址不能直接用于请求。`BASE_URL` 应使用服务文档提供的基础地址，包括所需路径前缀；SDK 会按供应商的 `api` 构造对应协议的请求。

## 对照说明

下面带注释的版本仅用于阅读，实际 `setting.json` 必须使用上方不含注释的 JSON。

```jsonc
{
  // 选择 name 为 lcn29 的供应商，不按数组位置选择。
  "provider": "lcn29",
  // 选择该供应商 models 列表中的模型，请求时作为 model 发送。
  "model": "gemini-3.8-flash-high",
  "modelProviders": [
    {
      // 本地供应商标识，必须唯一，与顶层 provider 完全一致。
      "name": "lcn29",
      // 选择接口协议，同一供应商条目中的模型共享此值。
      "api": "openai-completions",
      // 声明模型及其默认生成令牌上限，不会自动查询服务端模型能力。
      "models": [
        { "id": "gemini-3.8-flash-high", "maxTokens": 16384 },
        { "id": "gpt-6.1-sol", "maxTokens": 16384 },
      ],
      // 从同目录 .env 或进程环境读取 BASE_URL 的完整值。
      "baseUrl": "${BASE_URL}",
      // 从同目录 .env 或进程环境读取 API_KEY 的完整值。
      "apiKey": "${API_KEY}",
    },
  ],
}
```

示例的选择过程是：`provider` → 找到 `name` 为 `lcn29` 的供应商 → 在其 `models` 中确认 `gemini-3.8-flash-high` 存在 → 使用该供应商的 `api`、`baseUrl` 和 `apiKey` 发起请求。列出两个模型不会同时调用两个模型，也不会失败后自动切换。

## 修改配置的例子

### 切换同一供应商的模型

在上方完整示例中，将顶层 `model` 从 `"gemini-3.8-flash-high"` 改成 `"gpt-6.1-sol"`，其余内容保持原样。该模型已经在 `lcn29` 的 `models` 中，不需要再添加条目。

如果使用列表之外的模型，必须同时将服务实际支持的精确标识写入顶层 `model` 和对应的 `models[].id`。只改顶层而不更新列表，会在请求前报配置错误。

### 配置多个供应商

以下示例将同一个接口分别配置为两个本地供应商，以演示数组结构和名称选择。两者共用同一组环境变量；接入不同服务时，应分别填写各自的地址和密钥，或使用在 `.env` 中明确声明的独立变量。

```json
{
  "provider": "其他服务商",
  "model": "gpt-6.1-sol",
  "modelProviders": [
    {
      "name": "lcn29",
      "api": "openai-completions",
      "models": [{ "id": "gemini-3.8-flash-high", "maxTokens": 16384 }],
      "baseUrl": "${BASE_URL}",
      "apiKey": "${API_KEY}"
    },
    {
      "name": "其他服务商",
      "api": "openai-completions",
      "models": [{ "id": "gpt-6.1-sol", "maxTokens": 16384 }],
      "baseUrl": "${BASE_URL}",
      "apiKey": "${API_KEY}"
    }
  ]
}
```

这次选择数组中的第二项。切回第一项时，同时将 `provider` 改为 `"lcn29"`、`model` 改为 `"gemini-3.8-flash-high"`。两个供应商的 `name` 不能重复。

### 选择接口协议

每个供应商条目必须配置 `api`，只接受以下三个精确值：

| api                  | 接口实现                         | 基础地址与请求路径示例                                |
| -------------------- | -------------------------------- | ----------------------------------------------------- |
| `openai-completions` | OpenAI Chat Completions 兼容接口 | `https://example.invalid/v1` → `/v1/chat/completions` |
| `openai-responses`   | OpenAI Responses 兼容接口        | `https://example.invalid/v1` → `/v1/responses`        |
| `anthropic-messages` | Anthropic Messages 兼容接口      | `https://example.invalid` → `/v1/messages?beta=true`  |

表中的地址仅用于展示 SDK 的路径拼接，实际基础地址、模型和协议必须由服务提供方确认。切换协议时同步检查 `baseUrl`，不能只改字段后沿用不对应的路径前缀。

同一个服务需要多种协议时，可配置成名称不同的供应商条目，分别设置 `api` 和 `baseUrl`。顶层 `provider` 决定使用哪一组配置，模型条目中不重复声明协议。

已有配置需要为每个供应商补齐 `api`；缺失、大小写不符或使用其他值时，在发起请求前报告配置错误，不自动推断或回退。

### 设置模型默认生成上限

在 `modelProviders[].models[]` 中设置 `maxTokens`，每个模型独立配置。例如：

```json
{ "id": "gpt-6.1-sol", "maxTokens": 16384 }
```

配置中的 `maxTokens` 可省略，例如 `{ "id": "gpt-6.1-sol" }`；`loadSettings()` 在校验时补为 16384。显式提供时必须是正整数，0、null、字符串和小数会被拒绝。默认预算定义在 `src/base/settings.ts` 的模块私有常量 `DEFAULT_MODEL_MAX_TOKENS` 中。

入口按顶层 `model` 精确选择模型条目，将补齐后的 `maxTokens` 写入运行时 `Model.maxTokens`。运行时字段保持必填；模型服务仍会检查请求上限是否符合模型支持的范围。

- Anthropic：未提供单次请求的 `options.maxTokens` 时使用模型配置，发送为 `max_tokens`；提供时使用单次请求值，0 也会保留。
- Chat Completions：不读取 `Model.maxTokens`，仅将显式提供的正整数 `options.maxTokens` 发送为 `max_completion_tokens`；省略或为 0 时不发送上限字段。
- Responses：不读取 `Model.maxTokens`，正整数 `options.maxTokens` 发送为 `max_output_tokens`，低于 16 时提升为 16；省略或为 0 时不发送上限字段。

三种协议的上限统一规则尚未确定，后续确认事项见 [待办](../待办.md)。模型配置与单次请求选项分别校验：模型配置要求正整数，`options.maxTokens` 仍允许非负整数，并按以上协议规则处理 0。默认预算 16384 不代表模型的上下文窗口大小或实际能力。数值配置需直接写入 JSON，环境变量替换产生字符串，不自动转换为数字。

### 环境变量如何对应

| setting.json 中的写法                  | 对应值与结果                                                  |
| -------------------------------------- | ------------------------------------------------------------- |
| `"baseUrl": "${BASE_URL}"`             | 读取 `.env` 中的 `BASE_URL`；没有非空值时读取进程中的同名变量 |
| `"apiKey": "${API_KEY}"`               | 读取 `.env` 中的 `API_KEY`；两处均没有非空值时配置校验失败    |
| `"baseUrl": "https://example.invalid"` | 按原文使用，不执行环境变量查找；此地址仅供展示                |
| `"baseUrl": "${BASE_URL}/v1"`          | 不执行替换；如需路径前缀，应将完整地址写入环境变量            |

例如 `.env` 中设置 `BASE_URL=https://example.invalid/v1` 后，`"${BASE_URL}"` 的替换结果就是 `"https://example.invalid/v1"`。这里仍使用不可请求的示例地址；实际值以服务提供方说明为准。

## 字段

| 字段路径                              | 类型     | 规则                                                                    |
| ------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `provider`                            | 字符串   | 必填，与某个供应商的 `name` 精确匹配                                    |
| `model`                               | 字符串   | 必填，与所选供应商某个模型的 `id` 精确匹配                              |
| `modelProviders`                      | 对象数组 | 必填，必须包含所选供应商                                                |
| `modelProviders[].api`                | 字符串   | 必填，只接受 openai-completions、anthropic-messages 或 openai-responses |
| `modelProviders[].name`               | 字符串   | 必填，供应商之间不可重名                                                |
| `modelProviders[].baseUrl`            | 字符串   | 必填，接口基础地址；格式和协议在请求阶段处理                            |
| `modelProviders[].apiKey`             | 字符串   | 必填，建议使用环境变量占位符                                            |
| `modelProviders[].models`             | 对象数组 | 必填，所选供应商的列表必须包含顶层指定的模型                            |
| `modelProviders[].models[].maxTokens` | 数字     | 可选，正整数；省略时补为 16384                                          |
| `modelProviders[].models[].id`        | 字符串   | 必填，发送给模型服务的标识                                              |

所有必填字符串均拒绝空字符串、纯空白和未解析的整值占位符。字段名、供应商名称和模型标识均区分大小写，不自动去除首尾空白或转换名称。

配置模块校验全部供应商，未选中的供应商也必须提供有效字段。返回的业务配置仅包含上述字段。JSON 顶层必须是对象，不支持注释、尾随逗号或空文件。

## 环境变量替换

只有整个字符串恰好为 `${key}` 时才替换，例如 `"${API_KEY}"`。变量名按原文精确查找，优先级如下：

1. 配置文件同目录 `.env` 中的非空值。
2. 进程环境变量中的非空值。
3. 两处均无有效值时保留原占位符，再由业务校验拒绝必填字段中的未解析占位符。

替换递归遍历对象和数组，保留键名、数字、布尔值及 `null`。环境变量值始终作为字符串处理，不继续展开替换结果；`"前缀${API_KEY}"` 不会执行局部替换。

空字符串会回退到下一来源；纯空白在替换阶段保留，但用于必填字符串时仍会被业务校验拒绝。`.env` 缺失时使用进程环境变量，加载过程不修改 `process.env`，也不写回配置文件。

## 排查错误

| 现象                                 | 检查内容                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| 提示“模型配置加载或校验失败”         | 工作目录、`setting.json` 是否存在、JSON 语法、文件读取权限、同目录 `.env` 是否可读         |
| 文件存在且 JSON 正确，仍提示配置失败 | 必填字段、占位符是否有值、供应商名称是否重复、`provider` 和 `model` 是否精确匹配           |
| 请求过程中输出异常并退出             | 基础地址及路径前缀、密钥、模型权限、网络连接，以及服务是否支持所选协议的流式响应和工具调用 |
| 回复被截断                           | 服务以 `length` 结束时当前实现返回已收到文本，不自动续写                                   |

配置加载或校验失败时，入口输出统一中文提示并设置非零退出码，不打印配置或密钥。配置模块本身的字段校验异常包含路径，例如 `modelProviders[0].models[1].id`。

请求失败时，`stream` 通过 `error` 事件完成 `result()`，`completion` 的 Promise 返回事件流，调用其 `result()` 后获得最终消息；不支持的 `model.api` 会直接使 `completion` 拒绝。入口检查 `stopReason` 后使用 `errorMessage` 抛出异常，由 Node.js 输出错误详情并以非零状态退出，不再执行工具或发送下一轮请求。工具名称未声明、参数校验失败或第四轮仍包含工具调用也会使入口抛出异常。第四轮返回的工具仍会先执行并追加结果，随后因没有剩余请求轮次而报错；是否执行工具按消息内容中的 `toolCall` 判断，`length` 结果也遵循此规则。

入口发送“请调用 add 计算 17 加 25。”，校验并执行 `add`，将结果回填后继续请求，最多四轮；取得不含工具调用的助手消息后输出内容数组。入口未设置 `options.maxTokens` 或 `options.temperature`。`Model.maxTokens` 来自所选模型的 `models[].maxTokens`，配置省略时由加载器补为 16384；在 Anthropic 请求中作为未设置 `options.maxTokens` 时的令牌上限，OpenAI 请求不读取该字段。调用补全接口可通过 `StreamOptions` 设置单次请求参数；服务端仍会校验模型的可用上限。

## 开发接口

[src/base/settings.ts](../src/base/settings.ts) 仅导出 `loadSettings(settingPath: string)`，返回完成替换和校验的配置。路径必须显式提供，相对路径基于调用进程的当前工作目录；每次调用独立加载，不缓存或合并其他文件。导入模块不会读取配置。

当前配置使用 JSON；旧 `config.toml`、`model.toml` 以及旧字段名不再被入口读取。
