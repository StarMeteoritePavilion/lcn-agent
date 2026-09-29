import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessSubagent } from "../dist/core/subagent-process.js";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";
import { createSession } from "../dist/core/session.js";
import { readState, writeState } from "../dist/core/state.js";
import { registerTasks } from "../dist/extensions/tasks.js";
import registerFiles from "../dist/extensions/files.js";

/**
 * @file 子代理与后台任务有界并发（1～4 限制）集成测试。
 *
 * 验证目标：
 * 1. 默认单任务串行与容量查询：默认并发上限为 1，/task_limit 显式支持 1～4 整数配置，非法值报错；
 * 2. 同步名额预占与并发满载拦截：满载时立即同步拦截新任务，前台委派与后台任务共享名额池；
 * 3. 独立 PID 与审批隔离：并发运行的多个任务拥有独立的操作系统子进程 PID 与审批 ID，互不串扰；
 * 4. 会话隔离机制：跨会话的任务不能相互查看、审批或取消；
 * 5. 全量安全回收：关闭执行器或管理器时，所有运行中的真实子进程均被 SIGKILL 彻底回收，无僵尸进程；
 * 6. 存储故障熔断：任何一个后台任务状态落盘失败，立即中止所有正在运行的后台任务防失控。
 */

const cwd = mkdtempSync(join(tmpdir(), "lcn-concurrency-"));
const originalCwd = process.cwd();
const requests = [];
const sockets = new Set();
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const body = JSON.parse(text);
  requests.push(body);
  const task = body.messages.find((message) => message.role === "user").content;
  if (task.startsWith("WAIT")) return;
  const first = body.messages.at(-1).role === "user";
  const delta = first
    ? {
        tool_calls: [
          {
            index: 0,
            id: "read",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: `${task}.txt` }) },
          },
        ],
      }
    : { content: `${task}:${body.messages.at(-1).content}` };
  const choices = [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }];
  const usage = { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices })}\n\ndata: ${JSON.stringify(usage)}\n\ndata: [DONE]\n\n`);
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const config = { apiKey: "fake-key", model: "fixture", baseURL: `http://127.0.0.1:${server.address().port}/v1` };
const registry = createToolRegistry((name, json, context) =>
  context.confirm(name, json, context.callId, context.signal),
);
const disposeFiles = mountExtension(registry, registerFiles);
let runner;
let manager;
let disposeTasks;
let context;
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
  const end = Date.now() + 8000;
  while (!(await predicate())) {
    assert.ok(Date.now() < end, "等待并发场景超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function command(name, args = "", owner = context) {
  return registry.executeCommand(name, args, {
    ...owner,
    ui: {
      notify() {},
      ask() {
        throw Error();
      },
    },
  });
}
async function list(owner = context) {
  return JSON.parse(await command("tasks", "", owner));
}
async function find(task, owner = context) {
  return (await list(owner)).find((item) => item.task === task);
}
async function waiting(task, owner = context) {
  await until(async () => (await find(task, owner))?.status === "awaiting_approval");
  return find(task, owner);
}
function mount() {
  disposeTasks = mountExtension(registry, (api) => {
    manager = registerTasks(api, runner);
  });
}
try {
  process.chdir(cwd);
  for (const task of ["A", "B", "C", "D", "E", "F", "G", "H", "X", "Y", "M", "N"]) {
    writeFileSync(`${task}.txt`, `data-${task}`);
  }
  context = {
    cwd,
    sessionFile: createSession(config.model).file,
    model: config.model,
    callId: "parent",
    signal: new AbortController().signal,
    confirm: async () => true,
  };
  runner = createProcessSubagent(config, registry);
  mount();
  assert.deepEqual(runner.status(), { limit: 1, running: 0 });
  assert.match(await command("task_limit"), /并发上限：1/);
  assert.ok(!registry.definitions().some((tool) => tool.function.name === "task_limit"));
  for (const invalid of ["0", "5", "2.0", "02", "+2", "2 extra", "NaN"]) {
    await assert.rejects(command("task_limit", invalid), /用法/);
    assert.equal(runner.status().limit, 1);
  }
  for (const invalid of [0, 5, 1.5, NaN, Infinity]) assert.throws(() => runner.setLimit(invalid), /整数/);

  await command("task_limit", "2");
  await Promise.all([command("task_start", "A"), command("task_start", "B")]);
  assert.deepEqual(runner.status(), { limit: 2, running: 2 });
  await assert.rejects(command("task_start", "C"), /并发上限/);
  assert.equal((await list()).length, 2);
  const [a, b] = await Promise.all([waiting("A"), waiting("B")]);
  assert.notEqual(a.pid, b.pid);
  assert.notEqual(a.pending.approvalId, b.pending.approvalId);
  await assert.rejects(command("task_limit", "1"), /小于运行/);
  assert.ok(alive(a.pid) && alive(b.pid));
  await assert.rejects(command("task_approve", `${a.id} ${b.pending.approvalId}`), /审批已失效/);
  await command("task_approve", `${a.id} ${a.pending.approvalId}`);
  await until(async () => (await find("A")).status === "completed");
  assert.equal(alive(a.pid), false);
  assert.equal((await find("B")).status, "awaiting_approval");
  assert.equal(JSON.parse(JSON.parse(await command("task_show", a.id)).result).content, "A:data-A");
  assert.equal((await find("A")).reportedUsage.totalTokens, 6);
  assert.equal((await find("B")).reportedUsage.totalTokens, 3);
  await command("task_start", "C");
  const c = await waiting("C");
  await command("task_cancel", b.id);
  assert.equal(alive(b.pid), false);
  assert.ok(alive(c.pid));
  await command("task_approve", `${c.id} ${c.pending.approvalId}`);
  await until(async () => (await find("C")).status === "completed");
  assert.equal((await find("B")).status, "cancelled");

  // 前台和后台共享名额；取消其中一个不影响另一个。
  await command("task_start", "D");
  const d = await waiting("D");
  const abort = new AbortController();
  let foregroundPid;
  const foreground = runner.run("WAIT_FOREGROUND", 5, { ...context, signal: abort.signal }, (event) => {
    if (event.pid) foregroundPid = event.pid;
  });
  const foregroundRejected = assert.rejects(foreground);
  assert.throws(() => runner.run("WAIT_EXTRA", 5, context), /并发上限/);
  await assert.rejects(command("task_start", "E"), /并发上限/);
  await until(() => requests.some((body) => body.messages[1].content === "WAIT_FOREGROUND"));
  abort.abort();
  await foregroundRejected;
  assert.equal(alive(foregroundPid), false);
  assert.ok(alive(d.pid));
  await command("task_cancel", d.id);

  const other = { ...context, sessionFile: createSession(config.model).file };
  await Promise.all([command("task_start", "X"), command("task_start", "Y", other)]);
  const [x, y] = await Promise.all([waiting("X"), waiting("Y", other)]);
  assert.equal((await list(other)).length, 1);
  await assert.rejects(command("task_cancel", y.id), /当前会话/);
  await command("task_cancel", x.id);
  assert.ok(alive(y.pid));
  await command("task_cancel", y.id, other);

  // 上限四个真实子进程；关闭等待全部回收，不能丢失同一状态文件中的其他任务。
  await command("task_limit", "4");
  await Promise.all(["E", "F", "G", "H"].map((task) => command("task_start", task)));
  await assert.rejects(command("task_start", "M"), /并发上限/);
  const four = await Promise.all(["E", "F", "G", "H"].map((task) => waiting(task)));
  assert.equal(new Set(four.map((item) => item.pid)).size, 4);
  const saved = readState(context, "background_tasks");
  await manager.close();
  for (const item of four) assert.equal(alive(item.pid), false);
  assert.equal(runner.status().running, 0);
  const finished = readState(context, "background_tasks");
  assert.ok(four.every((item) => finished.items.find((row) => row.id === item.id).status === "cancelled"));
  disposeTasks();
  await runner.close();
  runner = createProcessSubagent(config, registry);
  writeState(context, "background_tasks", saved);
  mount();
  assert.equal(runner.status().limit, 1);
  const beforeRestart = requests.length;
  const recovered = await list();
  assert.ok(four.every((item) => recovered.find((row) => row.id === item.id).status === "interrupted"));
  assert.equal(requests.length, beforeRestart);

  // 一个后台状态故障会停下所有后台任务；坏数据不被并发收尾覆盖。
  await command("task_limit", "2");
  await Promise.all([command("task_start", "M"), command("task_start", "N")]);
  const [m, n] = await Promise.all([waiting("M"), waiting("N")]);
  writeState(context, "background_tasks", { version: 99, items: [] });
  await assert.rejects(command("task_approve", `${m.id} ${m.pending.approvalId}`), /状态保存失败/);
  await assert.rejects(manager.close(), /状态保存失败/);
  assert.equal(alive(m.pid), false);
  assert.equal(alive(n.pid), false);
  assert.deepEqual(readState(context, "background_tasks"), { version: 99, items: [] });
  manager = undefined;
  disposeTasks();
  disposeTasks = undefined;

  // 执行器自身 close 也负责回收多个未归属后台管理器的任务。
  const pids = [];
  const jobs = ["WAIT_ONE", "WAIT_TWO"].map((task) =>
    runner.run(task, 5, context, (event) => {
      if (event.pid) pids.push(event.pid);
    }),
  );
  const rejected = jobs.map((job) => assert.rejects(job));
  await until(() => pids.length === 2);
  await runner.close();
  await Promise.all(rejected);
  assert.ok(pids.every((pid) => !alive(pid)));
  assert.equal(runner.status().running, 0);
  assert.throws(() => runner.run("A", 5, context), /已关闭/);
  console.log("有界并发检查通过：默认单任务、显式上限、同步占位、审批/状态隔离、共享名额、独立取消与全量回收");
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
