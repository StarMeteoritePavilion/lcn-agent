import assert from "node:assert/strict";
import OpenAI from "openai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDemoModel } from "../dist/core/demo.js";
import { streamChat } from "../dist/core/model.js";
import { createProcessSubagent } from "../dist/core/subagent-process.js";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";
import { createSession } from "../dist/core/session.js";
import registerFiles from "../dist/extensions/files.js";

/**
 * @file 零配置演示模式（--demo）单元与端到端集成测试。
 *
 * 验证目标：
 * 1. 模拟模型意图解析与工具触发：验证关键词正确映射为 read_file 等工具调用，以及无真实用量时 usage 为 null；
 * 2. 真实子代理（Runner）执行与结果回填：验证子进程真实读取文件正文并在第二轮将实际结果回填给模型；
 * 3. 授权边界与拒绝回填：验证用户拒绝授权时模型收到“未获授权”说明；
 * 4. SSE 协作式中断：验证“等待”延迟期间外部 abort 能够即刻中断流式响应；
 * 5. 非流式摘要响应：验证 stream: false 时返回会话压缩专用的固定声明摘要；
 * 6. 本机 HTTP 接口安全防御：验证缺少 Bearer Token 返回 403、带 Origin 返回 403、未知路径 404、畸形 JSON 400；
 * 7. CLI 端到端无配置启动：在无 .env、无 config.toml 且注入干扰环境变量的情况下，CLI 依然零配置秒级启动并完成演示。
 */

const originalCwd = process.cwd();
const cli = resolve("dist/index.js");
const demo = await startDemoModel();
const cwd = mkdtempSync(join(tmpdir(), "lcn-demo-"));
process.chdir(cwd);
const client = new OpenAI({ ...demo.config, maxRetries: 0 });
let allow = true;
let approvals = 0;
const registry = createToolRegistry(() => { approvals++; return allow; });
const dispose = mountExtension(registry, registerFiles);
const runner = createProcessSubagent(demo.config, registry);
const session = createSession(demo.config.model);
const context = { cwd, model: demo.config.model, sessionFile: session.file, signal: new AbortController().signal };
const definitions = registry.definitions();
const ask = (content, tools = definitions, signal = context.signal, onEvent = () => {}) =>
  streamChat(client, demo.config.model, [{ role: "user", content }], tools, signal, onEvent);

try {
  writeFileSync(join(cwd, "note.txt"), "演示文件正文");

  // 1. 验证模拟模型正确生成 read_file 工具调用参数，且不伪造 usage
  const call = await ask("读取 note.txt");
  assert.equal(call.toolCalls[0].name, "read_file");
  assert.equal(call.toolCalls[0].arguments, '{"path":"note.txt"}');
  assert.equal(call.usage, null);
  assert.match((await ask("读取 note.txt", [])).content, /未执行/);

  // 2. 验证子代理执行器（Runner）通过真实子进程读取文件并多轮闭环回填
  const result = JSON.parse(await runner.run("读取 note.txt", 5, context));
  assert.match(result.content, /工具实际返回：\n演示文件正文/);
  assert.equal(result.rounds, 2);
  assert.equal(approvals, 1);

  // 3. 验证用户拒绝授权时，真实错误文本被回填给模型
  allow = false;
  assert.match(JSON.parse(await runner.run("读取 note.txt", 5, context)).content, /未获授权/);

  // 4. 验证流式延迟场景下，外部取消信号能正确中断流式连接
  const controller = new AbortController();
  let sawWaiting = false;
  const started = Date.now();
  await ask("等待", [], controller.signal, (event) => {
    assert.notEqual(event.type, "model_end");
    if (event.type === "text_delta") { sawWaiting = true; controller.abort(); }
  });
  assert.ok(Date.now() - started < 5000);
  assert.equal(sawWaiting, true);
  assert.match((await ask("取消后继续")).content, /本地演示回答/);
  assert.match((await ask(null)).content, /本地演示回答/);

  // 5. 验证 stream: false 非流式调用返回固定摘要声明
  const summary = await client.chat.completions.create({
    model: demo.config.model, messages: [{ role: "user", content: "摘要" }], stream: false,
  });
  assert.match(summary.choices[0].message.content, /不包含真实语义总结/);

  // 6. 验证模拟服务端的 HTTP 协议级安全防御（403, 404, 400）
  const url = `${demo.config.baseURL}/chat/completions`;
  const headers = { Authorization: `Bearer ${demo.config.apiKey}`, "Content-Type": "application/json" };
  assert.equal((await fetch(url, { method: "POST" })).status, 403);
  assert.equal((await fetch(url, { method: "POST", headers: { ...headers, Origin: "null" } })).status, 403);
  assert.equal((await fetch(url, { headers })).status, 404);
  assert.equal((await fetch(url, { method: "POST", headers, body: "{}" })).status, 400);
  assert.equal((await fetch(url, { method: "POST", headers, body: "invalid" })).status, 400);

  // 7. CLI 端到端启动检查：无 config.toml/.env，且非法外部扩展与 MCP 配置必须被演示入口完全忽略
  const env = {
    ...process.env,
    API_KEY: "unused",
    BASE_URL: "invalid",
    MODEL: "unused",
    LCN_AGENT_EXTENSION: join(cwd, "missing.mjs"),
    LCN_AGENT_MCP_DEMO: "invalid",
    LCN_AGENT_MCP_HTTP_URL: "invalid",
  };
  const run = (input) =>
    promisify(execFile)(process.execPath, [cli, "--demo", input], { cwd, env, timeout: 10000 });

  assert.match((await run("回显 无配置启动成功")).stdout, /工具实际返回：\n无配置启动成功/);
  assert.match((await run("读取 note.txt")).stdout, /未获授权/);
  console.log("演示检查通过：无配置 CLI、真实子进程读取/拒绝、流取消、缺失用量、固定摘要及 HTTP 边界");
} finally {
  await runner.close();
  dispose();
  await demo.close();
  await demo.close();
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
}
