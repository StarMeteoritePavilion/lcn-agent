# 当前工作交接

更新日期：2026-09-29。当前已实现 stdio 与本机 Streamable HTTP MCP、resources/prompts、受限网页读取和 Tavily 搜索。
路线和历史证据见[学习计划](agent-development-learning-plan.md)，协作方式见[协作引导](agent-coordination-guide.md)。

## 当前停靠点与提交状态

阶段 8 已完成所记录基础范围的验收和入口留档，收尾提交为 `7ac5dcb`。
2026-09-29 用户要求先 commit 再推进；模型通信提取已提交为 `18c16ab`，没有 push。
只读子代理与独立子模型进程、后台任务管理已在用户 Review 后共同提交为 `988f94b`，没有 push。
显式有界并发已按“先 commit、再推进”的顺序提交为 `9b9e980`，没有 push。
/task_limit 查看或调整前后台共享上限：默认 1、允许 1～4，跨会话保持，重启恢复 1；模型不能调整。
满额拒绝启动，不排队；进程回收后释放名额。各后台任务按 UUID 独立审批、计时、用量和取消，
存储故障停止全部后台任务。完整测试和临时 PTY 验证已通过，具体范围与限制见学习计划。
无付费模型演示模式已在 Review 后提交为 `b792536`，没有 push。
扩展配置入口已在 Review 后提交为 `dff8bc2`：`/extensions` 查看七个现有装载组，`enable|disable 完整编号` 保存启停设置。
设置写入 `.lcn-agent/extensions.json`，只在重启后生效；plan 不允许修改，演示限制不能被设置绕过。
禁用 workflow/skills 时对应的上下文注入也停止；不删除会话、待办或后台任务记录。
`npm run check`、完整 `npm test`、`git diff --check` 及隔离目录 PTY 均通过，具体范围见学习计划。
安装包和启动说明已提交为 `5b3c2e7`：`npm pack` 生成本地 `.tgz`，`lcn-agent` 使用当前工作目录，
`--help` / `--version` 不初始化宿主；发布文件使用白名单，打包前清理并重建 dist。
`npm run check`、完整 `npm test`、`npm run test:package` 和 diff 检查通过；
临时安装后的 CLI、子代理/MCP 路径与退出清理已验证，不修改全局安装或发布 registry。
最终十二项联合验收已完成：新增 `tests/acceptance.py`，通过真实 PTY、SDK、磁盘和子进程串起产品流程。
统一入口 `npm run test:acceptance` 包含类型检查、完整回归、PTY/Skills/压缩及安装包验证。
十二项本地模拟范围通过，具体输入、事件、副作用与证据见学习计划第 7 节；未请求真实模型、Tavily 或公网网页；安装测试可能访问 npm registry。
外部扩展按重启装载契约验证，不包含运行中热重载；macOS 实测，其他平台未验。
阶段 9 入口现已留档为 `src/stage/stage-09.ts`，仅调整 core/extensions 相对导入，反向还原后与主入口逐字一致。
快照已通过类型检查、构建及隔离目录 --demo 工具调用/退出/锁释放检查。
阶段 0～9 所记录范围的本地验收及入口留档完成；用户已明确授权 commit，本次提交保存联合验收与阶段 9 收尾基线，不 push。
当前学习路线已收尾；真实模型抽查、其他平台和 registry 发布均未执行，后续按用户新需求推进。
`src/stage/stage-08.ts` 来自阶段 8 收尾时的 `src/index.ts`，只调整 core/extensions 的相对导入；不要继续修改历史入口。
快照共享独立模块，不等于完整版本冻结。此前功能基线为 `100305a`（受限网页读取与 Tavily 搜索）。
此前安装包基线为 `5b3c2e7`；联合验收脚本、阶段 9 快照和文档由本次收尾提交保存，准确提交号通过 git log 查询。
进入下一节点前先保存本节点基线；本次已先提交安装包，再推进联合验收；后续提交仍需用户明确指令，不执行 push。

## 接手顺序

1. 阅读协作引导、学习计划的当前进度、阶段 9、当前节点与验收记录。
2. 核对 `git status --short`、`git log -5 --oneline`；保留用户尚未提交的修改。
3. 当前先核对 `tests/acceptance.py`、`tests/network-fixture.mjs`、`package.json` 的 test:acceptance 及学习计划十二项表；安装包见 `src/cli.ts` 和 `tests/package.mjs`；子代理相关文件为 `src/core/subagent.ts`、`src/core/subagent-process.ts`、`src/subagent-worker.ts`、`src/extensions/tasks.ts`、`tests/subagent-process.mjs`、`tests/subagent-concurrency.mjs` 及宿主退出清理；再按需核对 `src/index.ts`、阶段 8 快照、`src/extensions/mcp.ts`、`mcp-content.ts`、`web.ts`、`search.ts` 与对应测试；网络联合验收入口为 `tests/network-fixture.mjs`。
4. 运行 `npm run test:acceptance`、`git diff --check`；不要仅凭本文认定当前代码通过。

## 当前实现和启用方式

- `LCN_AGENT_MCP_DEMO=1` 启用仓库 stdio 服务，Node 路径取 process.execPath。
- 用户已确认新增 `LCN_AGENT_MCP_HTTP_URL`，仅接受 `http://127.0.0.1:<端口>/mcp`。
  未设置不连接，空值或其他地址拒绝，禁止重定向；不读取或发送模型凭据到 MCP 服务。
- HTTP 服务单独执行 `node dist/mcp-http-demo-server.js`，端口来自 stdout 的 `MCP_HTTP_PORT=`。
  绑定本机随机端口，单个内存会话；拒绝不符的 Host 与含 Origin 的请求，SDK 负责限量读取请求体。
- stdio 原名 demo_status，宿主名 mcp_demo_demo_status；HTTP 原名 http_status，宿主名 mcp_http_http_status。
  两者 Schema 均来自 listTools；注册表拒绝重名及不支持的 Schema，不改写名称大小写或参数。
- 两种传输共用 mountMcp 的发现、注册、结果解析和失败回滚；只接单页、文本结果。
  权限策略匹配成功注册的准确名称，逐次确认；规划模式禁止，非交互拒绝。
- HTTP dispose 先撤销工具，再 DELETE 终止会话，最后关闭传输；每步失败仍尝试后续清理。
  HTTP 请求有 5 秒传输预算，失败作为工具错误记录；宿主仍有 30 秒预算和用户取消信号。
- HTTP 客户端退出不停止独立服务进程。演示服务的会话终止后不接受新连接，需重启服务并使用新端口。
  多会话、远程地址、鉴权和重连均未实现，不能把演示服务视为生产服务。
- 同步 onDispose 契约不变，MCP 异步 dispose 由宿主显式 await。

SDK 固定 @modelcontextprotocol/sdk@1.30.1，签名以本地声明及实现为准。
SDK 无状态 transport 不可跨请求复用；此前共享无状态实例的教学代码已修正为单内存会话。
阶段 0～9 入口保存在 src/stage/，不再修改；独立模块历史以 Git 提交为准。

## 验证证据与限制

stdio 宿主真实模型调用已有用户终端证据：确认 y，返回“本地 MCP 服务已连通”，第二轮完成。
HTTP 仓库脚本验证地址拒绝、Schema 先于审批、拒绝/允许、前置取消、两种传输共存、幂等清理、
DELETE 后服务返回 404，以及由测试停止服务后正常退出。npm test 包含两个脚本并先构建。

HTTP 真实入口另用临时隔离项目、模拟模型和 PTY 验证允许/拒绝、规划模式、审批中取消、
未启用、按调用 ID 回填、工具诊断及客户端退出不停止服务。临时脚本未入库。
本轮没有真实模型请求、没有 push；故障覆盖已补齐至下文记录范围，未实现重连。

## MCP 故障验收

新增 tests/mcp-failures.mjs，由 npm test 运行。覆盖 HTTP 调用中取消、预算信号、服务收到取消通知、
5 秒无响应头超时、连接断开、业务错误、无自动重放、初始化正文脱敏及 DELETE 失败后的清理。
传输错误在宿主按 error 记录，原因区分 HTTP 请求超时/连接失败；用户取消、宿主预算超时优先。
SSE 流中断仍可能等待 MCP 请求或宿主 30 秒期限，不承诺立即检测断连。
临时隔离项目/模拟模型/PTY 已验证调用中取消和真实 30 秒预算、剩余工具未执行、配对及诊断。
远端副作用不保证撤销，故障后不自动重连或重试工具。具体覆盖与限制以学习计划为准。

## 内容入口与网络验收

resources/prompts 已接入：src/extensions/mcp-content.ts 处理清单、精确选择与文本校验。
两个演示服务新增 demo://notes 固定资源和 demo_summary 无参数提示；README 有完整命令。
资源读取只显示，不进入模型。/mcp_prompt demo|http 后接 JSON 选择，预览确认后才作为 user 消息发送。
外部角色仅作为数据，不注入 system，不绕过规划模式或工具审批。命令随 MCP 扩展卸载。
纯 resources/prompts 服务无需声明 tools；缺少相应能力时明确报错。只支持单页固定资源与文本提示。
内容 JSON 上限 64 KiB，发生在响应接收后；SDK 请求 5 秒，预览确认 30 秒，支持取消。
仓库测试覆盖两个传输内容入口、参数/分页/能力/类型/大小/卸载边界。
临时隔离 PTY 与模拟模型检查拒绝、取消、应用、规划模式及保存内容；未请求真实模型。

read_web 已由用户手敲：默认注册、规划模式可见并逐次审批；仅 nodejs.org/api/ HTML，
IPv4 地址过滤、禁止跳转、10 秒期限、1 MiB 上限，返回来源与原始 HTML。
本次类型检查、现有 npm test、独立 node tests/web.mjs 与真实页面直接读取通过。
package.json 已将 tests/web.mjs 纳入 npm test；重新构建及全部脚本通过，退出 0。
用户报告验证通过，但未提供具体终端审批记录，本次不将恶意网页越权防护记为完整验收。
search_web 已由用户手敲并注册，使用 POST https://api.tavily.com/search、Bearer 鉴权与 TAVILY_API_KEY。
规划模式允许但仍逐次审批；固定 basic、最多 5 条结果，禁止跳转，15 秒期限与 256 KiB 响应上限。
返回标题、链接和摘要，不自动访问结果链接；缺密钥明确报错，不回传服务错误正文或底层异常。
2026-09-28 复跑 npm run check、npm test、git diff --check 全部退出 0，tests/search.mjs 已纳入入口。
模拟测试覆盖请求契约、Schema 先于审批、允许/拒绝、卸载、预取消、缺密钥、空结果、协议与体积限制、错误脱敏。
用户报告实测成功；本次未读取密钥、未调用真实 Tavily，也未独立验证搜索终端审批与会话日志。
tests/network-fixture.mjs 已按授权加入恶意 HTML 和两项失败模拟：第二次搜索抛连接异常，第二次网页流中断。
两个错误都包含假密钥，用于断言原始错误与凭据不会进入模型消息、会话、诊断或终端。
临时 Python PTY 在独立目录运行当前仓库脚本：execute 与 plan 模式均五轮完成、退出 0，无 marker.txt。
读取逐次审批；execute 拒绝命令，plan 直接拦截命令；两个失败调用同轮串行执行，按 ID 回填受控错误。
HTML 来源、类型、字节数和正文断言通过，类型检查、完整 npm test 和 diff 检查通过。
网络响应全部模拟；不验证真实 DNS、TLS、网络取消、超时或物理断连，未读取真实密钥。
该脚本需以 node --import 在隔离目录加载，不直接运行或加入 npm test；临时 PTY 驱动未入库。
阶段 8 已完成所记录基础范围的本地验收和入口留档；阶段 9 当前节点见本文顶部。
正文抽取尚未实现。搜索结果 URL 只检查协议及凭据，不过滤私网地址；这些链接不会被自动访问。
搜索注释已按实际实现修正：不宣称过滤私网链接、清洗成功结果或由 notice 防止越权；权限边界仍由宿主执行。
学习计划已按现有证据勾选阶段 8 的六项清单，入口留档已完成，随本次收尾提交保存。
resources/prompts 不代表完整协议支持；资源模板、分页、非文本消息仍未实现。

## 授权和数据边界

用户已要求“你直接修改，我 review”，随后要求先 commit 再推进；模型通信已提交，子代理及后台任务由 Agent 实现并验收，前两个节点已完成 Review 并提交；并发节点已提交，演示模式已完成 Review 并提交，扩展配置节点已完成 Review 并按用户明确授权提交；安装包节点已按用户明确授权提交；当前联合验收与阶段 9 留档收尾已完成，用户已明确授权本次 commit。
当前直接修改后 Review 的协作方式沿用本次用户授权；后续按用户最新指令推进。
节点验收后更新文档并保留工作区改动；commit 时机由用户决定，仅在用户明确要求时提交。
此前自动提交授权已撤销，“继续”不授权 commit；push 仍需明确指令。
不读取 .env 密钥，不清理用户 .lcn-agent 数据或运行中的写入锁，测试使用隔离项目。

阶段 8 收尾检查：`npm run check`、完整 `npm test`、`git diff --check` 通过；快照反向还原导入后逐字一致，隔离启动与退出通过，无模型请求。

## 复跑网络联合验收

`npm test` 不运行交互辅助文件。以下命令从项目根目录执行，只在新建临时目录写入假配置和会话：

```bash
npm run build
network_repo="$PWD"
network_case="$(mktemp -d)"
cd "$network_case"
cat > config.toml <<'EOF'
apiKey = "fixture-model-key"
baseURL = "http://127.0.0.1:1/v1"
model = "fixture-model"
EOF
node --import "$network_repo/tests/network-fixture.mjs" "$network_repo/dist/index.js"
```

execute：输入“验证”，依次批准搜索和网页，拒绝命令，再批准搜索失败、网页失败两项调用。
完成五轮后输入 `/exit`，必须看到“外部内容权限、网络失败回填及日志脱敏检查通过”且退出码为 0。
再次启动同一命令，先输入 `/mode plan` 再输入“验证”；四次读取均批准，命令应直接拒绝而不出现审批。
不要直接运行辅助文件，也不要在真实项目配置目录加载它；它是替换网络响应的测试入口。
网络异常是模拟抛错，不代表已验证真实 DNS、TLS、网页/搜索调用中取消或实际超时。
真实模型是否服从恶意内容没有在这里测试；验证的是即便模型请求执行，宿主仍保持审批和模式限制。
