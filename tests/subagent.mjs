import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";
import { registerSubagent } from "../dist/extensions/subagent.js";
import { runSubagent } from "../dist/core/subagent.js";
import { streamChat } from "../dist/core/model.js";
import registerFiles from "../dist/extensions/files.js";
import { createSession } from "../dist/core/session.js";
import { DiagnosticWriteError, showDiagnostics } from "../dist/core/diagnostics.js";

/**
 * @file 只读子代理（run_subagent）完整单元与集成测试。
 *
 * 验证维度：
 * 1. 委派入口防御：外层 Schema 参数校验与用户逐次授权拦截必须先于大模型调用；
 * 2. 独立上下文和只读边界：子任务拥有完全独立的上下文，仅开放只读文件工具，严禁写入、命令与递归；
 * 3. 授权不穿透：子代理的每次底层读取均经过独立的用户审批与子调用 ID（JSON 元组）配对；
 * 4. 边界与熔断：轮次上限、上下文超过 256 KiB、单次结果超过 64 KiB 及模型截断均安全阻断；
 * 5. 协作取消与串行互斥：审批中取消、并发冲突拦截、扩展注销自动中断；
 * 6. 诊断链路追踪与脱敏：验证父会话目录下生成专属日志文件，且敏感堆栈与错误密钥不泄露。
 */

const originalCwd = process.cwd();
const cwd = mkdtempSync(join(tmpdir(), "lcn-subagent-"));
const requests = [];
const approvals = [];
let replies = [];
let approved = true;
let permissionFails = false;
let writes = 0;
const client = {
  chat: { completions: {
    async create(body, { signal }) {
      signal.throwIfAborted();
      requests.push(structuredClone(body));
      const reply = replies.shift();
      assert.ok(reply, "模拟响应不足");
      return (async function* () {
        if (typeof reply === "function") yield* reply(signal);
        else for (const chunk of reply) yield chunk;
      })();
    },
  } },
};
const registry = createToolRegistry((name, json, context) => {
  if (permissionFails && name === "read_file") throw new Error("PRIVATE_PERMISSION_ERROR");
  return context.confirm(name, json, context.callId, context.signal);
});
const context = {
  cwd, model: "fixture-model", sessionFile: "parent.jsonl", callId: "parent-call",
  signal: new AbortController().signal,
  confirm: async (name, json, id) => {
    approvals.push({ name, args: JSON.parse(json), id });
    return approved;
  },
};
function text(content) {
  return [{ choices: [{ delta: { content }, finish_reason: "stop" }] }];
}
function calls(items, finish = "tool_calls") {
  return [{ choices: [{ delta: { tool_calls: items.map(([name, args, id], index) => ({
    index, id, function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  })) }, finish_reason: finish }] }];
}
function invoke(task = "读取文件", options = {}, toolContext = context) {
  return registry.execute("run_subagent", { task, ...options }, toolContext);
}
function lastToolMessages() {
  return requests.at(-1).messages.filter((message) => message.role === "tool");
}
let disposeFiles;
let disposeAgent;
let disposeWrite;
try {
  process.chdir(cwd);
  context.sessionFile = createSession(context.model).file;
  writeFileSync("note.txt", "可核验文件内容");
  disposeFiles = mountExtension(registry, registerFiles);
  disposeWrite = registry.register({
    definition: { type: "function", function: { name: "write_probe", parameters: { type: "object" } } },
    execute: () => { writes++; return "unexpected"; },
  });
  disposeAgent = mountExtension(registry, (api) => registerSubagent(api, (task, rounds, context) => runSubagent(
    (messages, tools, signal) => streamChat(client, context.model, messages, tools, signal, () => {}),
    registry, task, rounds, context,
  )));

  // 外层 Schema 和审批在请求模型之前生效。
  await assert.rejects(invoke("测试", { maxRounds: 6 }), /Schema/);
  await assert.rejects(invoke("   "), /任务为空/);
  approved = false;
  await assert.rejects(invoke(), /未获授权/);
  assert.equal(requests.length, 0);
  approved = true;
  await assert.rejects(invoke("测试", {}, { ...context, signal: AbortSignal.abort() }));
  assert.equal(requests.length, 0);

  // 一个真实文件读取，单独批准；第二轮拿到按原始子调用 ID 配对的结果。
  replies = [calls([["read_file", { path: "note.txt" }, "read-1"]]), text("子任务结论")];
  replies[0].push({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  const result = JSON.parse(await invoke());
  assert.deepEqual(result, { content: "子任务结论", rounds: 2 });
  assert.equal(requests[0].messages.length, 2);
  assert.equal(requests[0].messages[1].content, "读取文件");
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), ["read_file", "search_file", "list_files"]);
  assert.deepEqual(lastToolMessages(), [{ role: "tool", tool_call_id: "read-1", content: "可核验文件内容" }]);
  const readApproval = approvals.find((item) => item.name === "read_file");
  assert.deepEqual(JSON.parse(readApproval.id), ["parent-call", 1, "read-1"]);
  assert.deepEqual(readApproval.args, { path: "note.txt" });

  replies = [text("独立结果")];
  await invoke("另一个独立任务");
  assert.equal(requests.at(-1).messages.length, 2);
  assert.equal(requests.at(-1).messages[1].content, "另一个独立任务");
  assert.ok(!JSON.stringify(requests.at(-1)).includes("可核验文件内容"));

  // 单轮多项读取逐个审批、串行回填，搜索和目录工具复用现有实现。
  replies = [calls([
    ["search_file", { path: "note.txt", query: "文件" }, "search"],
    ["list_files", { path: "." }, "list"],
  ]), text("检索完成")];
  await invoke();
  assert.deepEqual(lastToolMessages().map((message) => message.tool_call_id), ["search", "list"]);
  assert.match(lastToolMessages()[0].content, /可核验文件内容/);
  assert.match(lastToolMessages()[1].content, /note.txt/);

  replies = [calls([["read_file", { path: "note.txt" }, "user-denied"]]), text("用户拒绝读取")];
  await invoke("拒绝读取", {}, { ...context, confirm: async (name) => name === "run_subagent" });
  assert.match(lastToolMessages()[0].content, /未获授权/);

  // 模型即使伪造写入、命令或递归调用，也不会进入父工具执行入口。
  replies = [calls([
    ["apply_edit", { path: "note.txt", before: "可核验文件内容", after: "写入" }, "write-1"],
    ["run_subagent", { task: "递归" }, "recursive-1"],
    ["run_command", {}, "command-1"],
    ["write_probe", {}, "write-2"],
  ]), text("已拒绝")];
  const approvalStart = approvals.length;
  await invoke();
  assert.equal(approvals.length, approvalStart + 1);
  assert.ok(lastToolMessages().every((message) => message.content.startsWith("未执行：")));
  assert.equal(readFileSync("note.txt", "utf8"), "可核验文件内容");
  assert.equal(writes, 0);

  // 无效参数和权限策略抛错不会绕过校验或泄漏异常正文。
  replies = [calls([["read_file", { path: 42 }, "bad-schema"]]), text("参数已拒绝")];
  const beforeInvalid = approvals.length;
  await invoke();
  assert.equal(approvals.length, beforeInvalid + 1);
  permissionFails = true;
  replies = [calls([["read_file", { path: "note.txt" }, "denied"]]), text("读取未获授权")];
  await invoke();
  assert.ok(!JSON.stringify(lastToolMessages()).includes("PRIVATE_PERMISSION_ERROR"));
  assert.match(lastToolMessages()[0].content, /未获授权/);
  permissionFails = false;

  // 截断、无效结束原因、最后一轮和重复 ID 均在执行工具前失败。
  for (const [reply, options, pattern] of [
    [calls([["read_file", { path: "note.txt" }, "truncated"]], "length"), {}, /截断/],
    [calls([["read_file", { path: "note.txt" }, "limit"]]), { maxRounds: 1 }, /轮次上限/],
    [calls([["read_file", {}, "same"], ["read_file", {}, "same"]]), {}, /标识无效/],
    [[{ choices: [{ delta: {}, finish_reason: "content_filter" }] }], {}, /响应无效/],
  ]) {
    replies = [reply];
    const count = approvals.length;
    await assert.rejects(invoke("边界", options), pattern);
    assert.equal(approvals.length, count + 1);
  }
  replies = [text("x".repeat(64 * 1024))];
  await assert.rejects(invoke(), /结果超过/);
  replies = [async function* () { throw new Error("PRIVATE_MODEL_ERROR"); }];
  await assert.rejects(invoke(), (error) => error.message === "子代理模型请求失败");

  writeFileSync("large.txt", "x".repeat(64 * 1024));
  replies = [calls(Array.from({ length: 5 }, (_, index) => ["read_file", { path: "large.txt" }, `large-${index}`]))];
  const beforeLarge = requests.length;
  await assert.rejects(invoke("过大上下文"), /上下文超过/);
  assert.equal(requests.length, beforeLarge + 1);
  await assert.rejects(invoke("字".repeat(32 * 1024)), /任务为空或超过/);
  assert.equal(requests.length, beforeLarge + 1);

  // 在第一项读取审批期间取消，不执行同轮第二项，不再请求下一轮模型。
  const abort = new AbortController();
  replies = [calls([["read_file", { path: "note.txt" }, "a"], ["read_file", { path: "note.txt" }, "b"]])];
  let readCount = 0;
  const cancelledContext = { ...context, signal: abort.signal, confirm: async (name) => {
    if (name === "read_file") { readCount++; abort.abort(); }
    return true;
  } };
  const beforeCancel = requests.length;
  await assert.rejects(invoke("取消", {}, cancelledContext));
  assert.equal(readCount, 1);
  assert.equal(requests.length, beforeCancel + 1);

  // 卸载和父信号都能中断进行中的模型流，并拒绝并发执行。
  for (const kind of ["cancel", "timeout", "dispose"]) {
    const parent = new AbortController();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    replies = [async function* (signal) {
      started();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }];
    const pending = invoke("等待", {}, { ...context, signal: parent.signal });
    const rejected = assert.rejects(pending);
    await ready;
    await assert.rejects(invoke("并发任务"), /串行/);
    if (kind === "dispose") disposeAgent();
    else parent.abort(kind === "timeout" ? new DOMException("预算耗尽", "TimeoutError") : undefined);
    await rejected;
  }
  disposeAgent();
  await assert.rejects(invoke(), /未知工具/);
  disposeAgent = mountExtension(registry, (api) => registerSubagent(api, (task, rounds, context) => runSubagent(
    (messages, tools, signal) => streamChat(client, context.model, messages, tools, signal, () => {}),
    registry, task, rounds, context,
  )));
  replies = [text("重新装载成功")];
  assert.equal(JSON.parse(await invoke()).content, "重新装载成功");

  // 诊断写入失败必须穿透，不能继续请求模型或当作普通读取失败。
  const append = fs.appendFileSync;
  const beforeLogFailure = requests.length;
  try {
    fs.appendFileSync = () => { throw new Error("PRIVATE_LOG_ERROR"); };
    syncBuiltinESMExports();
    await assert.rejects(invoke("日志故障"), DiagnosticWriteError);
    assert.equal(requests.length, beforeLogFailure);
  } finally {
    fs.appendFileSync = append;
    syncBuiltinESMExports();
  }

  writeFileSync(join(cwd, ".lcn-agent/diagnostics/blocked.jsonl"), "blocked");
  await assert.rejects(invoke("无法创建日志", {}, { ...context, sessionFile: "blocked.jsonl" }), DiagnosticWriteError);
  assert.equal(requests.length, beforeLogFailure);

  const folder = join(cwd, ".lcn-agent/diagnostics", context.sessionFile);
  const logFiles = readdirSync(folder);
  const logText = logFiles.map((file) => readFileSync(join(folder, file), "utf8")).join("");
  const logs = logText.trim().split("\n").map(JSON.parse);
  assert.ok(logs.some((item) => item.kind === "model" && item.callId === "parent-call"));
  assert.ok(logs.some((item) => item.usage?.totalTokens === 5));
  assert.ok(logs.some((item) => item.outcome === "cancelled"));
  assert.ok(logs.some((item) => item.outcome === "timeout"));
  assert.ok(!logText.includes("PRIVATE_MODEL_ERROR"));
  assert.ok(!logText.includes("PRIVATE_PERMISSION_ERROR"));
  assert.ok(!logText.includes("PRIVATE_LOG_ERROR"));
  assert.ok(!showDiagnostics(context.sessionFile).includes("格式头不合法"));
  console.log("子代理检查通过：独立上下文、只读边界、逐次审批、轮次、截断、取消、串行、卸载与诊断");
} finally {
  disposeAgent?.();
  disposeWrite?.();
  disposeFiles?.();
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
}
