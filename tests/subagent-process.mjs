import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessSubagent, isModelResult } from "../dist/core/subagent-process.js";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";
import { createSession } from "../dist/core/session.js";
import { registerTasks } from "../dist/extensions/tasks.js";
import { readState, writeState } from "../dist/core/state.js";
import registerFiles from "../dist/extensions/files.js";

/**
 * @file 子进程隔离与后台任务（process subagent & tasks）集成测试。
 *
 * 验证目标：
 * 1. 独立子进程生命周期：通过 PID 验证真实子进程启动、通信与退出后 PID 确认消亡；
 * 2. 进程取消与异常回收：测试超时、外部中止或主动杀死进程时，父进程安全捕获异常且子进程不残留；
 * 3. IPC 模型结果防御校验（isModelResult）：验证严格校验格式、字段完备性与负数用量拦截；
 * 4. 后台任务生命周期流转：测试 /task_start 启动、/tasks 概览、/task_show 详情、/task_cancel 取消；
 * 5. 显式命令审批机制：验证 /task_approve 与 /task_reject，以及快照对比防磁盘篡改；
 * 6. 离线中断恢复：模拟宿主重启后，遗留的 running 任务自动标记为 interrupted，绝不根据旧 PID 误杀新进程。
 */

const cwd = mkdtempSync(join(tmpdir(), "lcn-process-"));
const originalCwd = process.cwd();
const requests = [];
const sockets = new Set();
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body);
  requests.push(data);
  const task = data.messages.find((message) => message.role === "user").content;
  if (task === "等待取消") return;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const reading = data.messages.at(-1).role === "user" && task !== "直接完成";
  const delta = reading
    ? {
        tool_calls: [
          {
            index: 0,
            id: "read-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"note.txt"}' },
          },
        ],
      }
    : { content: "已完成只读任务" };
  if (reading && task === "两次读取") {
    delta.tool_calls.push({ ...delta.tool_calls[0], index: 1, id: "read-2" });
  }
  const choice = { index: 0, delta, finish_reason: reading ? "tool_calls" : "stop" };
  const usageChunk = { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  const usage = task === "两次读取" ? `data: ${JSON.stringify(usageChunk)}\n\n` : "";
  response.end(`data: ${JSON.stringify({ choices: [choice] })}\n\n${usage}data: [DONE]\n\n`);
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const registry = createToolRegistry((name, json, context) =>
  context.confirm(name, json, context.callId, context.signal),
);
const disposeFiles = mountExtension(registry, registerFiles);
const config = { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture" };
let manager;
let disposeTasks;
let runner;
let context;
const progress = [];
const approvals = [];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, "等待状态超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function command(name, args = "", override = {}) {
  const ui = {
    notify() {},
    ask() {
      throw Error();
    },
  };
  return registry.executeCommand(name, args, { ...context, ...override, ui });
}
async function tasks() {
  return JSON.parse(await command("tasks"));
}
try {
  process.chdir(cwd);
  writeFileSync("note.txt", "文件正文");
  const session = createSession(config.model);
  context = {
    cwd,
    model: config.model,
    sessionFile: session.file,
    callId: "parent-call",
    signal: new AbortController().signal,
    confirm: async (...args) => {
      approvals.push(args);
      return true;
    },
  };
  runner = createProcessSubagent(config, registry);
  const result = JSON.parse(await runner.run("读取文件", 5, context, (event) => progress.push(event)));
  assert.deepEqual(result, { content: "已完成只读任务", rounds: 2 });
  const pid = progress.find((event) => event.pid !== undefined).pid;
  assert.notEqual(pid, process.pid);
  assert.equal(alive(pid), false);
  assert.equal(requests.length, 2);
  assert.equal(approvals.length, 1);
  assert.equal(requests[1].messages.at(-1).content, "文件正文");
  assert.ok(progress.some((event) => event.round === 2));
  assert.ok(progress.some((event) => event.usage === null));

  const abort = new AbortController();
  let waitingPid;
  const waiting = runner.run("等待取消", 5, { ...context, signal: abort.signal }, (event) => {
    if (event.pid !== undefined) waitingPid = event.pid;
  });
  const rejected = assert.rejects(waiting);
  await until(() => requests.length === 3);
  assert.throws(() => runner.run("并发", 5, context), /串行/);
  abort.abort();
  await rejected;
  assert.equal(alive(waitingPid), false);
  await runner.run("直接完成", 5, context);

  let killedPid;
  const killed = runner.run("等待取消", 5, context, (event) => {
    if (event.pid) killedPid = event.pid;
  });
  const killedResult = assert.rejects(killed, /模型请求失败|进程/);
  await until(() => requests.length === 5);
  process.kill(killedPid, "SIGKILL");
  await killedResult;
  assert.equal(alive(killedPid), false);

  assert.equal(isModelResult({ content: "", finishReason: "stop", toolCalls: [], usage: null }), true);
  assert.equal(isModelResult({ content: 3, finishReason: "stop", toolCalls: [], usage: null }), false);
  assert.equal(isModelResult({ content: "", finishReason: "stop", toolCalls: [null], usage: null }), false);
  assert.equal(isModelResult({ content: "", finishReason: "stop", toolCalls: [], usage: { totalTokens: -1 } }), false);

  disposeTasks = mountExtension(registry, (api) => {
    manager = registerTasks(api, runner.run);
  });
  await assert.rejects(command("task_start", "读取文件", { sessionFile: null }), /选择会话/);
  await command("task_start", "读取文件");
  await until(async () => (await tasks())[0]?.status === "awaiting_approval");
  let item = (await tasks())[0];
  assert.equal(item.pending.name, "read_file");
  assert.equal(item.pending.argumentsJson, '{"path":"note.txt"}');
  assert.equal(alive(item.pid), true);
  await assert.rejects(command("task_start", "第二个任务"), /已有后台任务/);
  await assert.rejects(
    command("task_approve", `${item.id} ${item.pending.approvalId}`, { sessionFile: "other.jsonl" }),
    /当前会话/,
  );
  await assert.rejects(command("task_approve", `${item.id} stale`), /审批已失效/);
  await command("task_approve", `${item.id} ${item.pending.approvalId}`);
  await until(async () => (await tasks())[0].status === "completed");
  assert.equal(alive(item.pid), false);
  item = JSON.parse(await command("task_show", item.id));
  assert.equal(JSON.parse(item.result).content, "已完成只读任务");
  assert.equal(item.unreportedRounds, 2);
  assert.equal(item.round, 2);

  await command("task_start", "读取文件");
  await until(async () => (await tasks())[1]?.status === "awaiting_approval");
  item = (await tasks())[1];
  await command("task_reject", `${item.id} ${item.pending.approvalId}`);
  await until(async () => (await tasks())[1].status === "completed");
  assert.match(requests.at(-1).messages.at(-1).content, /未获授权/);

  await command("task_start", "等待取消");
  await until(async () => (await tasks())[2]?.pid !== undefined);
  item = (await tasks())[2];
  await command("task_cancel", item.id);
  assert.equal((await tasks())[2].status, "cancelled");
  assert.equal(alive(item.pid), false);

  // 重新装载后，遗留 running 记录显示 interrupted，绝不根据旧 PID 杀进程或重跑。
  await manager.close();
  disposeTasks();
  const saved = readState(context, "background_tasks");
  saved.items[0].status = "running";
  saved.items[0].pid = process.pid;
  writeState(context, "background_tasks", saved);
  const beforeRestart = requests.length;
  disposeTasks = mountExtension(registry, (api) => {
    manager = registerTasks(api, runner.run);
  });
  assert.equal((await tasks())[0].status, "interrupted");
  assert.equal(requests.length, beforeRestart);
  assert.equal(alive(process.pid), true);
  await command("task_start", "等待取消");
  await until(async () => (await tasks())[3]?.pid !== undefined);
  item = (await tasks())[3];
  await manager.close();
  assert.equal(alive(item.pid), false);
  assert.equal(readState(context, "background_tasks").items[3].status, "cancelled");
  disposeTasks();
  disposeTasks = mountExtension(registry, (api) => {
    manager = registerTasks(api, runner.run);
  });
  await command("task_start", "两次读取");
  await until(async () => (await tasks()).at(-1)?.status === "awaiting_approval");
  item = (await tasks()).at(-1);
  const oldApproval = `${item.id} ${item.pending.approvalId}`;
  assert.equal(item.reportedUsage.totalTokens, 3);
  assert.equal(item.unreportedRounds, 0);
  await command("task_approve", oldApproval);
  await until(async () => {
    const latest = (await tasks()).at(-1);
    return latest.status === "awaiting_approval" && latest.pending.approvalId !== item.pending.approvalId;
  });
  await assert.rejects(command("task_approve", oldApproval), /审批已失效/);
  await command("task_cancel", item.id);
  assert.equal(alive(item.pid), false);

  // 坏版本拒绝覆盖；运行中状态损坏也会取消进程并明确报告保存失败。
  await command("task_start", "等待取消");
  await until(async () => (await tasks()).at(-1)?.pid !== undefined);
  item = (await tasks()).at(-1);
  writeState(context, "background_tasks", { version: 2, items: [] });
  const path = join(cwd, ".lcn-agent/background_tasks", `${context.sessionFile}.json`);
  const corrupt = readFileSync(path);
  await assert.rejects(command("tasks"), /损坏或版本/);
  await assert.rejects(command("task_cancel", item.id), /状态保存失败/);
  assert.equal(alive(item.pid), false);
  assert.deepEqual(readFileSync(path), corrupt);
  await assert.rejects(manager.close(), /状态保存失败/);
  manager = undefined;
  disposeTasks();
  // 审批编号相同但磁盘参数被改写时，也不能放行原读取。
  writeState(context, "background_tasks", { version: 1, items: [] });
  disposeTasks = mountExtension(registry, (api) => { manager = registerTasks(api, runner.run); });
  await command("task_start", "读取文件");
  await until(async () => (await tasks())[0]?.status === "awaiting_approval");
  item = (await tasks())[0];
  const altered = readState(context, "background_tasks");
  altered.items[0].pending.argumentsJson = '{"path":"different.txt"}';
  writeState(context, "background_tasks", altered);
  await assert.rejects(command("task_approve", `${item.id} ${item.pending.approvalId}`), /状态保存失败/);
  await until(() => !alive(item.pid));
  await assert.rejects(manager.close(), /状态保存失败/);
  manager = undefined;
  disposeTasks();
  disposeTasks = undefined;
  assert.equal(readFileSync("note.txt", "utf8"), "文件正文");
  console.log("进程与后台任务检查通过：独立 PID、工具审批、结果、取消/异常回收、串行、进度、重启中断和退出清理");
} finally {
  await manager?.close();
  await runner?.close();
  disposeTasks?.();
  disposeFiles();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
}
