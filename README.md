# lcn-agent

从零开始构建的可扩展终端 AI Agent。目前实现流式模型、工具循环、基础终端交互、JSONL 会话保存与恢复、运行诊断，以及工具扩展注册、清理和外部 JavaScript 模块加载。

> **项目状态：** 阶段 0～7 已完成所记录基础范围的本地验收，阶段 7 已留档。阶段 8 已接入 stdio 与本机 Streamable HTTP MCP、resources/prompts、受限网页读取及 Tavily 搜索，并完成记录范围的验证；恶意搜索结果、HTML 与两项模拟网络失败的权限和日志联合验收已通过。阶段 8 已完成所记录基础范围的本地验收，入口已留档为 `src/stage/stage-08.ts`；阶段 9 已完成独立流式通信、只读子代理、独立子模型进程、后台任务和显式有界并发的本地模拟验收；产品配置、打包、演示模式和最终联合验收尚未完成。

## 目标特性

- 工具循环与流式模型交互
- 终端用户界面（TUI）
- 会话保存与恢复
- 可扩展机制（默认扩展 + 外部扩展）
- 开箱即用的默认能力：文件操作、计划、待办、权限确认、Skills、MCP、子代理等

**目标架构概览：**

```
终端界面 / 非交互输出
  └── 会话协调
        └── Agent 循环与运行状态
              ├── 模型通信模块
              └── 工具执行与权限判定
                    ├── 默认扩展
                    │     └── MCP 客户端与外部工具
                    └── 外部扩展
```

## 快速开始

### 前置条件

- Node.js >= 22
- npm

### 安装

```bash
git clone https://github.com/StarMeteoritePavilion/lcn-agent.git
cd lcn-agent
npm install
```

### 模型配置

从仓库根目录启动。`config.toml` 必须存在，默认引用以下变量：

```toml
apiKey = "${API_KEY}"
baseURL = "${BASE_URL}"
model = "${MODEL}"
```

可以直接设置进程环境变量，也可以复制 `.env.example` 为 `.env` 并填写实际值。
`.env` 是可选文件；同名时进程环境变量优先，包括已设置的空字符串。
普通配置可以直接写成 TOML 字符串，固定值不会被环境变量覆盖。不要把真实密钥提交到仓库。

程序先解析 TOML，再按原名替换字符串值中的 `${key}`，支持数组和嵌套表；
替换只执行一次，不展开环境值中的引用、不自动转换类型、不改写键名。
引用不存在，或 `apiKey`、`baseURL`、`model` 缺失、非字符串、为空或全空白时，启动失败。
文件读取和 TOML 语法错误也会终止启动，只有 `.env` 不存在可以忽略。

### 配置设计依据

加载统一放在 [src/core/config.ts](src/core/config.ts)，使 npm、直接 Node 启动和调试走同一流程。
Node 原生 `loadEnvFile()` 已满足环境文件加载需求，TOML 解析使用现有 `smol-toml`。
先解析再替换可防止环境值中的引号和换行改变 TOML 结构；日期对象不参与递归替换。
必填校验只用 `trim()` 判断空白，返回原值；解析错误不透传原始配置行，避免泄露密钥。
`loadEnvFile()` 不会让 `NODE_OPTIONS` 影响已经启动的 Node，启动参数应放在外部环境或启动命令中。

配置调研的原始依据（2026-09-21 核对）：
[Node 加载 API](https://github.com/nodejs/node/blob/v25.9.0/doc/api/process.md#processloadenvfilepath)、
[环境变量优先级源码](https://github.com/nodejs/node/blob/v25.9.0/src/node_dotenv.cc#L69)、
[TOML 规范](https://github.com/toml-lang/toml/blob/main/toml.md#string)、
[smol-toml 文档](https://github.com/squirrelchat/smol-toml/blob/mistress/README.md)。
配置加载实现见 [src/core/config.ts](src/core/config.ts)。

### 构建与运行

```bash
# 编译并启动（应用统一加载配置）
npm start

# 编译 TypeScript
npx tsc

# 运行
node dist/index.js

# 编译并运行（组合命令）
npx tsc && node dist/index.js

# 仅类型检查（不生成文件）
npx tsc --noEmit

# 格式化所有源码
npx prettier --write "src/**/*.ts"
```

### 会话使用

| 命令 | 用途 |
| --- | --- |
| `/new` | 新建会话 |
| `/fork` | 从当前完整末尾复制会话及已知会话状态，并切换到分支 |
| `/sessions` | 列出已保存的完整文件名 |
| `/resume 完整文件名` | 加载指定会话，模型须与当前配置一致 |
| `/history` | 查看完整原始消息历史，压缩后仍可回查 |
| `/memory` | 查看当前项目记忆及完整编号、来源、范围和更新时间 |
| `/memory_add 内容` | 用户显式保存项目记忆，规划模式禁止 |
| `/memory_delete 完整编号` | 删除项目记忆，规划模式禁止 |
| `/compact` | 手动请求摘要并保存上下文视图，保留原始历史，可取消 |
| `/diagnostics` | 查看当前会话诊断 |
| `/diagnostics 完整会话文件名` | 查看指定会话诊断，无需先恢复会话 |
| `/exit` | 退出；生成中 Ctrl+C 取消当前请求，空闲时 Ctrl+C 退出 |
| `/ask [问题]` | 提问并等待一行回答，需要交互终端 |
| `/todo_add [内容]` | 新增待办；省略内容时交互询问，须先选择会话 |
| `/mode、/mode plan、/mode execute` | 查看或切换当前进程模式；plan 禁止业务写入 |
| `/plan` | 查看当前会话的目标与计划步骤 |
| `/prompts` | 列出项目 `.agents/prompts/` 的直接子文件模板 |
| `/prompt 完整文件名 [参数文本]` | 单次替换 `$ARGUMENTS`，将展开后的文本作为用户消息 |
| `/skills` | 查看项目 Skills 目录及当前会话已激活项 |
| `/skill 完整名称` | 显式激活指定 Skill，按会话保存正文快照 |
| `/todo_list` | 查看当前会话待办 |
| `/todo_done 编号` | 完成指定待办 |

上述扩展命令默认可用，另保留 `/upper`、`/context`、`/runs`、`/wait` 学习命令。
模型可发现 echo、upper、三个待办工具及 read_file、search_file、list_files、preview_edit、apply_edit、run_command、plan_show、plan_set；待办写入、文件工具、命令执行及计划替换均须逐次确认，非交互模式拒绝执行。
宿主使用 Ajv 在审批前校验参数 Schema；校验不转换类型、填默认值或删除字段。业务约束继续由工具检查。
read_file 仅接受工作区相对路径，读取不超过 64 KiB 的 UTF-8 普通文件，拒绝越界符号链接。
search_file 在指定文件中按行匹配字面文本，区分大小写，不支持跨行或目录递归；最多返回 50 个匹配行及截断标记。
list_files 列出指定目录的直接子项，最多 100 项；子项链接只展示不跟随，不递归、不保证顺序。
preview_edit 返回唯一字面替换的 before / after，保留 BOM 和换行，不写入文件；预览确认不代表授权落盘。
apply_edit 重新确认完整 before / after，原文不一致时拒绝保存；使用同目录临时文件替换，保留普通权限，拒绝多硬链接文件。
最后检查与替换之间仍有并发窗口；不保留所有权、ACL 或扩展属性，不承诺跨进程并发写入安全。
规划模式只提供宿主名单中的只读工具，并拦截写入工具和直接扩展写入命令；读取类工具仍保留原有审批。
模式只由用户通过 /mode 切换，跨会话保持、重启恢复 execute；会话和诊断日志仍正常保存。
plan_set 经确认整体替换会话计划，plan_show 与 /plan 只读查看；计划按会话持久化，损坏时拒绝覆盖。保存计划不执行步骤，也不标记任务完成。
run_command 使用绝对程序路径与参数数组，经确认后在工作目录执行；最长 10 秒，stdout/stderr 各限 64 KiB，支持取消。
不自动经过 Shell，但继承进程环境，工作目录不是沙箱；终止针对直接子进程，不保证回收派生进程或撤销副作用。
文件内容和目录结果会回传模型；路径检查不是沙箱，不保证抵御其他进程并发替换父目录。
可用 `LCN_AGENT_EXTENSION=./dist/extensions/delay.js node dist/index.js` 额外加载延迟回显。
不要再指定 upper.js、todo.js 或 workflow.js：它们已经默认装载，重复加载会报重名。

Skills 启动时扫描项目 `.agents/skills/` 的直接子目录，读取 `SKILL.md` 元数据；未激活正文不发送给模型。
模型使用 `skill_activate` 须逐次确认；用户可用 `/skill` 显式激活。正文快照按会话保存，每次请求只注入一次，重启恢复原快照。
`disable-model-invocation: true` 仅允许手动激活。规划模式也允许激活及保存这类会话辅助记录。

交互模式首次提问时创建会话；非交互入口每次创建新会话。
记录保存在 `.lcn-agent/sessions`，已被 Git 忽略。恢复只读取历史，不重放工具。
取消和截断时只保留完整消息；损坏记录、缺少末尾换行或未配对工具调用会导致恢复被拒绝，原文件不变。
已有文件丢失时保存报错，不会自动重建。同一项目只允许一个会话写入进程。
诊断文件按会话保存在 `.lcn-agent/diagnostics`，记录模型与工具耗时、用量、结束原因；无结束记录显示结果未知。
强制结束后若残留 `.lcn-agent/sessions/.writer.lock`，确认项目没有 Agent 进程运行后再手动删除锁。

## 开发指南

### 技术栈

| 类别 | 工具 |
| --- | --- |
| 语言 | TypeScript 7.0（严格模式） |
| 运行时 | Node.js（ESM 模块） |
| 构建 | TypeScript 编译器（tsc） |
| 格式化 | Prettier |
| 编辑规范 | EditorConfig |

### 编辑器配置

项目使用 `.editorconfig` 统一基础编辑规范（缩进、编码、换行符），使用 `.prettierrc` 统一代码格式。所有主流编辑器均支持 EditorConfig。

**VS Code 用户：**

安装以下插件：

| 插件 | ID | 必要性 |
| --- | --- | --- |
| Prettier - Code formatter | `esbenp.prettier-vscode` | 必装 |
| EditorConfig for VS Code | `editorconfig.editorconfig` | 必装 |
| Error Lens | `usernamehw.errorlens` | 推荐 |

在项目根目录创建 `.vscode/settings.json`（已被 `.gitignore` 忽略，不会提交）：

```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "[markdown]": {
    "editor.formatOnSave": false
  }
}
```

### VS Code 断点调试

用 VS Code 打开仓库根目录，在本机 `.vscode/launch.json` 中配置：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "调试 lcn-agent",
      "type": "node",
      "request": "launch",
      "preLaunchTask": "npm: build",
      "program": "${workspaceFolder}/dist/index.js",
      "cwd": "${workspaceFolder}",
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "skipFiles": ["<node_internals>/**"],
      "console": "integratedTerminal"
    }
  ]
}
```

在 `src/*.ts` 上设断点，选“调试 lcn-agent”并按 F5；编译生成的 source map 将 JS 映射回 TS。
配置仍由应用加载 `config.toml` 和可选 `.env`，不另设 `envFile`。
找不到 `npm: build` 时检查 npm 任务自动检测；断点空心时检查 `cwd`、`sourceMap`、`outFiles` 并重新编译。

### 项目结构

```
lcn-agent/
├── src/             # TypeScript 源码
│   ├── index.ts     # 当前学习阶段入口
│   ├── core/        # 配置、会话、诊断、扩展注册与状态存储模块
│   ├── extensions/  # 回显、大写、延迟回显与待办扩展
│   └── stage/       # 已完成阶段的入口快照（stage-xx.ts）
├── dist/            # 编译输出（gitignored）
├── docs/            # 开发计划与学习文档
├── .editorconfig    # 跨编辑器基础规范
├── .prettierrc      # Prettier 格式化规则
├── tsconfig.json    # TypeScript 编译配置
├── package.json     # 项目配置
└── LICENSE          # Apache License 2.0
```

## 开发计划

按阶段逐步学习 TypeScript、Agent 循环、终端、会话、扩展与默认工作流。
完整路线、当前进度、验收结论和下一节点统一见 [开发学习计划](docs/agent-development-learning-plan.md)。

## 文档

- [当前交接](docs/agent-handoff.md) - 新 Agent 接手入口、当前验证证据与下一步

- [开发学习计划](docs/agent-development-learning-plan.md) - 完整的 10 阶段开发路线与验收标准
- [Agent 协作引导](docs/agent-coordination-guide.md) - AI Agent 接手工作的规则与约定
- [学习问答笔记](docs/qa-notes.md) - TypeScript 学习过程中的问答记录

## 许可证

[Apache License 2.0](LICENSE)

每次用户提问的第一轮请求前，历史视图 JSON 达到 64 KiB 时自动尝试压缩一次。摘要与首轮回答共享 30 秒预算；失败、取消或超时停止本次提问。无可压缩范围时继续使用原视图。此阈值不计 Skills 和工具定义，不代表模型 token 容量。

## MCP 演示服务

stdio：`LCN_AGENT_MCP_DEMO=1 npm start`，工具为 `mcp_demo_demo_status`。

HTTP：先执行 `npm run build`，再在一个终端运行 `node dist/mcp-http-demo-server.js`。
服务打印 `MCP_HTTP_PORT=实际端口`，另一个终端用该端口设置 `LCN_AGENT_MCP_HTTP_URL` 后运行 `npm start`。
地址必须完整写为 `http://127.0.0.1:实际端口/mcp`；工具为 `mcp_http_http_status`。
此变量是本项目新增约定，未设置则不连接，空值/其他地址报错；禁止重定向，不发送模型凭据。
两种入口可同时启用，均逐次审批；规划模式禁止，非交互模式拒绝执行。

HTTP 演示服务只承载一个内存会话；宿主退出时发送 DELETE 终止会话，不停止服务进程。
再次连接前需在服务终端退出并重启服务，读取新端口。HTTP 请求受 5 秒传输预算限制；
传输失败记为工具错误，宿主 30 秒预算和用户取消仍由原有执行循环处理。
调用中取消会发送 MCP 取消通知；服务需协作响应，不保证撤销已发生的副作用。
请求未收到响应头而触发 5 秒期限时提示“HTTP 请求超时”，连接错误提示“HTTP 连接失败”；
已开始的 SSE 流中断仍可能等待 MCP 请求或宿主 30 秒期限后结束，不承诺立即识别。
宿主取消/预算超时会停止后续轮次；传输错误按工具 error 记录受控原因，可回填给模型。
服务 isError 单独标记为业务失败。初始化错误不打印服务响应正文，清理失败也会撤销注册项。
本步不支持远程地址、鉴权、多会话重连、分页或非文本结果。

## MCP 资源与提示

启用服务后使用以下用户命令（`demo` 对应 stdio，`http` 对应 HTTP）：

| 命令 | 用途 |
| --- | --- |
| `/mcp_demo_resources`、`/mcp_http_resources` | 列出资源的准确 URI |
| `/mcp_demo_resource 完整URI`、`/mcp_http_resource 完整URI` | 读取并展示文本资源，不发送模型 |
| `/mcp_demo_prompts`、`/mcp_http_prompts` | 列出提示名称、说明与参数 |
| `/mcp_prompt demo {"name":"demo_summary","arguments":{}}` | 获取 stdio 提示，预览后输入 y 才应用 |
| `/mcp_prompt http {"name":"demo_summary","arguments":{}}` | 同样选择 HTTP 提示 |

演示资源为 `demo://notes`，提示为 `demo_summary`。名称、URI 和参数键区分大小写，不做补全。
提示参数只接受已声明的字符串字段；资源模板、分页、二进制资源和非文本提示尚不支持。
展示或应用内容的 JSON 上限为 64 KiB（收到响应后检查，不是网络下载上限）。
所有内容操作有 5 秒 SDK 请求期限；预览确认共享 30 秒预算，并支持 Ctrl+C。
确认后的提示带来源和角色说明，作为普通 user 消息进入历史，不插入 system 指令或伪造 assistant 历史。
资源内容不自动注入模型，列目录不自动读取正文，应用提示仍遵守现有工具审批和规划模式。
提示应用仅支持交互入口；拒绝、取消、取回失败均不保存新的用户消息，不触发模型。

## 受限网页读取

read_web 已默认注册，只接受 https://nodejs.org/api/ 下无凭据、查询参数和片段的 .html URL。
每次调用须确认，规划模式同样审批。仅 IPv4，拒绝指定内网/保留网段，不跟随重定向；
接受 UTF-8、非压缩 HTML，最多 1 MiB、10 秒，输出来源和 HTML 原文。notice 不代替权限校验。
独立检查：`npm run build && node tests/web.mjs`；该脚本已纳入 npm test，完整测试通过。

## Tavily 搜索

`search_web` 已默认注册，使用环境变量 `TAVILY_API_KEY`，未配置时明确报错。
每次搜索都须确认，规划模式同样审批；查询词会发送至 Tavily。
请求固定为 `POST https://api.tavily.com/search`，使用 Bearer 鉴权与 basic 搜索，最多返回 5 条标题、链接和摘要。
禁止重定向，期限 15 秒，JSON 响应上限 256 KiB；不自动访问结果链接，也不获取原始网页正文。
结果链接仅校验 HTTP/HTTPS 协议及无 URL 凭据，不保证链接指向公网；外部内容不授予工具权限。
`tests/search.mjs` 使用模拟响应检查请求契约、审批与错误边界，不需要真实密钥或消耗搜索额度。

`tests/network-fixture.mjs` 是交互验收辅助文件，不属于 `npm test`。
在隔离临时目录配置假模型凭据后，以 `node --import` 加载它再启动当前构建的入口，
可模拟恶意搜索结果、HTML、搜索连接异常和网页流中断，检查 execute/plan 权限、来源及错误脱敏。
共五轮：批准搜索、网页读取；execute 模式拒绝命令（plan 直接拒绝）；再批准两项失败调用，最后 /exit 检查日志。
它接管 fetch 与 https.request，不调用真实模型、Tavily 或网站；不验证 DNS、TLS 或网络取消。

## 只读子代理

`run_subagent` 默认注册为模型工具，参数为 `task` 和可选的 `maxRounds`（1～5，默认 5）。
例如可要求模型“用只读子代理检查 README.md，汇总当前项目目的”，在委派审批出现后确认。
规划模式也可使用；批准委派不等于批准读取，子任务的每一次读取仍需单独确认，非交互模式拒绝。

子任务使用相同模型和工作目录，仅接收显式任务文本，不自动继承父会话历史、记忆或 Skills。
只开放 `read_file`、`search_file`、`list_files`，执行时再次检查名单，并复用父宿主的 Schema 与权限入口。
写入、命令、MCP 和递归子代理调用均拒绝。前台工具调用仍串行等待结果；它与后台任务共用并发名额。

前台子任务各轮共享父模型当前轮次剩余的 30 秒预算；Ctrl+C 或卸载会中止并回收子进程。
最后一轮若仍要求工具调用，会在执行前失败；截断、空结果和无效响应也不会作为完成结果回传。
任务文本上限 64 KiB；模型聚合结果上限 64 KiB，请求前的消息 JSON 上限 256 KiB。
这些大小检查发生在组装或接收后，不是流式下载限制，也不代表模型 token 窗口。

成功结果为包含 `content` 与 `rounds` 的 JSON，作为父工具结果保存。子消息历史仅存于内存。
子模型用量、工具结果状态和结束原因记录到父会话目录下的独立诊断文件，`/diagnostics` 可查看；
模型开始记录的 `callId` 对应父委派调用。日志故障停止宿主，不回传原始异常正文。
每个任务的模型请求由独立 Node.js 子进程处理，工具循环、审批、文件读取和诊断留在父进程。
子进程仅经 IPC 接收模型配置，不继承宿主环境变量、调试参数或预加载脚本，不自行加载配置文件。
任务返回或失败前等待子进程退出；父进程强制退出后，子进程在 IPC 断开时自行退出。
当前仍是可信代码，进程拆分不提供文件系统或网络沙箱。

## 后台只读任务

先用 `/new` 或 `/resume` 选择会话，然后使用以下命令。规划模式同样可用。

| 命令 | 用途 |
| --- | --- |
| `/task_limit [1\|2\|3\|4]` | 查看或显式调整前后台共用的并发上限 |
| `/task_start 任务文本` | 显式启动后台只读任务，立即返回任务编号 |
| `/tasks` | 查看当前会话任务、轮次、PID、已报告用量与待审批参数 |
| `/task_show 完整任务编号` | 查看一个任务的完整记录和最终结果 |
| `/task_approve 完整任务编号 完整审批编号` | 批准清单中显示的这一次读取 |
| `/task_reject 完整任务编号 完整审批编号` | 拒绝这一次读取 |
| `/task_cancel 完整任务编号` | 取消并等待子进程回收 |

后台读取需要审批时状态变为 `awaiting_approval`，不会抢占前台输入。
先用 `/tasks` 查看 `pending` 中的工具、参数和 `approvalId`，再输入批准或拒绝命令；
每次读取使用新审批编号，旧编号或发生变化的审批参数记录不能放行后续读取。
后台等待时仍可正常聊天；前台 Ctrl+C 取消当前前台请求，后台任务需通过 `/task_cancel` 取消。

默认合计最多运行一个子模型进程。用户可执行 `/task_limit 2`（或 1、3、4）显式调整前后台共用的名额，
不带参数查看上限和当前运行数。配置属于当前进程，跨会话保持、重启恢复为 1；模型没有修改上限的工具。
满额时拒绝启动，不生成新后台任务记录、不自动排队；进程完成回收后才释放名额。
调低上限不能低于当前运行数，不会强行取消已有任务。每个后台任务仍独立审批、计时、记录用量和取消，
批准或取消一个任务不会影响另一个；状态存储故障会停止全部后台任务，避免继续执行无法记录的工作。
后台任务最多 5 轮，总预算为从启动起 30 秒，包含进程启动、模型请求和审批等待；前台新请求不会重置该预算。
`reportedUsage` 只累加模型实际报告的用量；`unreportedRounds` 记录未报告用量的已结束轮次，运行中的请求尚未计入。
任务成功、失败、取消或超时后保留记录。状态文件按会话保存在 `.lcn-agent/background_tasks/`，不随 `/fork` 复制。
切换会话不停止原任务，但只能在所属会话查看、审批或取消；退出应用会等待所有子任务停止后释放会话写锁。

重启后第一次查看任务时，将遗留的 `running` 或 `awaiting_approval` 记录标为 `interrupted`，不重跑任务、
不根据旧 PID 发送信号。强杀宿主留下的会话写锁仍按前文说明人工处理。状态损坏时保留原文件并拒绝覆盖，
运行中无法保存进度则停止全部后台任务并报告失败。当前没有后台自动重试、自动恢复执行或模型自动创建并发任务。

## 当前阶段验收

```bash
npm run check
npm test
```

`npm run check` 对当前实现和阶段留档进行类型检查。
`npm test` 先编译当前源码，运行 `tests/model.mjs` 验证流式通信的独立请求、分片、用量、异常与取消信号透传，并运行 `tests/subagent.mjs` 验证子代理上下文、权限、预算、取消、卸载与诊断边界，以及 `tests/subagent-process.mjs` 验证真实子进程、后台审批、进度、状态与回收，`tests/subagent-concurrency.mjs` 验证共享名额、并发审批与状态隔离、取消和批量回收，再运行 `tests/mcp-stdio.mjs`、`tests/mcp-http.mjs` 、`tests/mcp-failures.mjs` 和 `tests/mcp-content.mjs`，分别启动本地 stdio 与 Streamable HTTP 演示子进程，验证握手、工具发现、固定文本调用及关闭流程。另运行 `tests/web.mjs` 与 `tests/search.mjs` 检查网页来源限制、搜索模拟请求及权限边界。需要 Node.js 与已安装依赖，不请求真实模型或 Tavily。
此前脚本 `tests/branch.mjs`、`tests/memory.mjs`、`tests/compaction.mjs`、`tests/prompts.mjs`、`tests/skills.mjs` 和 `tests/session-persistence.py` 保留，当前测试入口不运行它们；本次额外的终端与请求集成验证范围见学习计划验收记录。

项目按阶段学习：`src/index.ts` 是当前入口，`src/stage/stage-xx.ts` 保存已完成阶段。
阶段 8 入口已留档为 `src/stage/stage-08.ts`，仅调整相对导入。独立模块仍共享当前代码；完整版本由本次阶段收尾提交保存。
测试只维护当前学习节点；阶段完成后记录验收结论，旧测试可移除，下一阶段更换 `npm test` 入口。
若阶段依赖独立模块，仅复制入口不能冻结完整实现，应使用 Git 提交标记该阶段的完整状态。
历史结论和覆盖限制见 [学习计划](docs/agent-development-learning-plan.md#验收记录)。
