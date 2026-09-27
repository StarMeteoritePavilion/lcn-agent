import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkSession } from "../dist/core/branch.js";
import {
  createSession,
  loadSession,
  saveMessage,
  listSessions,
} from "../dist/core/session.js";
import { readState } from "../dist/core/state.js";
import { addMemory, readMemories } from "../dist/core/memory.js";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";
import registerTodo from "../dist/extensions/todo.js";

const previousCwd = process.cwd();
const cwd = mkdtempSync(join(tmpdir(), "lcn-branch-"));
const signal = new AbortController().signal;

try {
  process.chdir(cwd);

  const parent = createSession("local-test");
  saveMessage(parent, { role: "user", content: "原始问题" });
  saveMessage(parent, { role: "assistant", content: "原始回答" });

  const registry = createToolRegistry();
  const dispose = mountExtension(registry, registerTodo);

  const context = (session) => ({
    cwd,
    model: session.model,
    sessionFile: session.file,
    signal,
    ui: { notify() {}, ask: async () => "" },
  });

  await registry.executeCommand("todo_add", "分支前的任务", context(parent));
  addMemory(cwd, "项目共享记忆", signal);

  const parentPath = join(cwd, ".lcn-agent", "sessions", parent.file);
  const parentBytes = readFileSync(parentPath);

  const child = forkSession(parent, signal);
  assert.notEqual(child.file, parent.file);
  assert.deepEqual(child.messages, parent.messages);
  assert.notEqual(child.messages, parent.messages);
  assert.deepEqual(readFileSync(parentPath), parentBytes);

  const header = JSON.parse(
    readFileSync(
      join(cwd, ".lcn-agent", "sessions", child.file),
      "utf8",
    ).split("\n")[0],
  );
  assert.equal(header.parentFile, parent.file);
  assert.equal(header.parentMessageCount, parent.messages.length);

  assert.deepEqual(
    readState(context(child), "todos"),
    readState(context(parent), "todos"),
  );

  // 只完成子分支待办，父分支仍未完成。
  await registry.executeCommand("todo_done", "1", context(child));
  assert.match(
    await registry.executeCommand("todo_list", "", context(child)),
    /\[x\]/,
  );
  assert.match(
    await registry.executeCommand("todo_list", "", context(parent)),
    /\[ \]/,
  );

  saveMessage(child, { role: "user", content: "子分支新增问题" });
  assert.deepEqual(readFileSync(parentPath), parentBytes);

  // 模拟切回两个会话，状态仍按各自文件名恢复。
  const restoredParent = loadSession(parent.file, parent.model);
  const restoredChild = loadSession(child.file, child.model);
  assert.equal(restoredParent.messages.length, 2);
  assert.equal(restoredChild.messages.length, 3);
  assert.match(
    await registry.executeCommand("todo_list", "", context(restoredParent)),
    /\[ \]/,
  );
  assert.match(
    await registry.executeCommand("todo_list", "", context(restoredChild)),
    /\[x\]/,
  );

  assert.equal(readMemories(cwd)[0].content, "项目共享记忆");

  const files = listSessions();
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => forkSession(parent, abort.signal));
  assert.deepEqual(listSessions(), files);

  parent.pending.add("未完成调用");
  assert.throws(() => forkSession(parent, signal), /未配对/);
  parent.pending.clear();

  parent.messages[0].content = "未落盘修改";
  assert.throws(() => forkSession(parent, signal), /不一致/);
  assert.deepEqual(listSessions(), files);

  dispose();
  console.log("会话分支核心检查通过");
} finally {
  process.chdir(previousCwd);
  rmSync(cwd, { recursive: true, force: true });
}
