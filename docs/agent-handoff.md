# 当前工作交接

更新日期：2026-09-28。当前已实现 stdio 与本机 Streamable HTTP MCP、resources/prompts、受限网页读取和 Tavily 搜索。
路线和历史证据见[学习计划](agent-development-learning-plan.md)，协作方式见[协作引导](agent-coordination-guide.md)。

## 接手顺序

1. 阅读协作引导、学习计划的当前进度、阶段 8、当前节点与验收记录。
2. 核对 `git status --short`、`git log -5 --oneline`；保留用户尚未提交的修改。
3. 阅读 `src/extensions/mcp.ts`、`src/index.ts`、两个演示服务与 `tests/mcp-stdio.mjs`、`tests/mcp-http.mjs`。
4. 运行 `npm run check`、`npm test`、`git diff --check`；不要仅凭本文认定当前代码通过。

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
阶段 0～7 入口保存在 src/stage/，不再修改；独立模块历史以 Git 提交为准。

## 验证证据与限制

stdio 宿主真实模型调用已有用户终端证据：确认 y，返回“本地 MCP 服务已连通”，第二轮完成。
HTTP 仓库脚本验证地址拒绝、Schema 先于审批、拒绝/允许、前置取消、两种传输共存、幂等清理、
DELETE 后服务返回 404，以及由测试停止服务后正常退出。npm test 包含两个脚本并先构建。

HTTP 真实入口另用临时隔离项目、模拟模型和 PTY 验证允许/拒绝、规划模式、审批中取消、
未启用、按调用 ID 回填、工具诊断及客户端退出不停止服务。临时脚本未入库。
本轮没有真实模型请求、没有 push；故障覆盖已补齐至下文记录范围，未实现重连。

## MCP 故障验收与紧邻下一步

新增 tests/mcp-failures.mjs，由 npm test 运行。覆盖 HTTP 调用中取消、预算信号、服务收到取消通知、
5 秒无响应头超时、连接断开、业务错误、无自动重放、初始化正文脱敏及 DELETE 失败后的清理。
传输错误在宿主按 error 记录，原因区分 HTTP 请求超时/连接失败；用户取消、宿主预算超时优先。
SSE 流中断仍可能等待 MCP 请求或宿主 30 秒期限，不承诺立即检测断连。
临时隔离项目/模拟模型/PTY 已验证调用中取消和真实 30 秒预算、剩余工具未执行、配对及诊断。
远端副作用不保证撤销，故障后不自动重连或重试工具。具体覆盖与限制以学习计划为准。

## 当前内容入口与紧邻下一步

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
下一节点为阶段 8 的恶意外部内容与权限联合验收，含认证信息不写入会话日志；仍由用户手敲。
正文抽取尚未实现。搜索结果 URL 只检查协议及凭据，不过滤私网地址；这些链接不会被自动访问。
搜索注释已按实际实现修正：不宣称过滤私网链接、清洗成功结果或由 notice 防止越权；权限边界仍由宿主执行。
学习计划已补勾三项有验收证据的 MCP/来源检查节点；阶段 8 最后一项联合验收仍未完成。
resources/prompts 不代表完整协议支持；资源模板、分页、非文本消息仍未实现。

## 授权和数据边界

用户最新要求恢复手敲：下一节点由用户编写，Agent 只提供准确改动、解释、命令和验收实验。
后续“继续”按教学推进，不代写实现；用户另行明确授权的修改除外。
节点验收后更新文档并保留工作区改动；commit 时机由用户决定，仅在用户明确要求时提交。
此前自动提交授权已撤销，“继续”不授权 commit；push 仍需明确指令。
不读取 .env 密钥，不清理用户 .lcn-agent 数据或运行中的写入锁，测试使用隔离项目。
