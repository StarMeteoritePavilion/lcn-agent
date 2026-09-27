import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactSession, contextMessages } from "../dist/core/compaction.js";
import { createSession, saveMessage } from "../dist/core/session.js";

const originalCwd = process.cwd();
const cwd = mkdtempSync(join(tmpdir(), "lcn-compaction-"));
const signal = new AbortController().signal;

try {
  process.chdir(cwd);
  const session = createSession("local-test");

  saveMessage(session, { role: "user", content: "约束：不得修改业务文件" });
  saveMessage(session, { role: "assistant", content: "旧说明".repeat(2000) });
  saveMessage(session, { role: "user", content: "执行只读检查" });
  saveMessage(session, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: "call_1",
      type: "function",
      function: { name: "echo", arguments: '{"text":"只读"}' },
    }],
  });
  saveMessage(session, {
    role: "tool",
    tool_call_id: "call_1",
    content: "只读",
  });
  saveMessage(session, { role: "assistant", content: "检查完成" });

  const path = join(cwd, ".lcn-agent", "sessions", session.file);
  const original = readFileSync(path);
  const before = contextMessages(session, signal);

  await assert.rejects(
    compactSession(session, signal, async () => {
      throw new Error("模拟摘要失败");
    }),
    /模拟摘要失败/,
  );
  assert.deepEqual(contextMessages(session, signal), before);

  await compactSession(session, signal, async () => "旧说明已讨论，业务文件未修改。");
  const view = contextMessages(session, signal);

  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(view[0], session.messages[0]);
  assert.deepEqual(view.slice(-4), session.messages.slice(-4));
  assert.ok(!JSON.stringify(view).includes("旧说明".repeat(2000)));

  // 换一个内存对象仍从磁盘读取同一份压缩状态。
  assert.deepEqual(contextMessages({ ...session }, signal), view);

  // 同一边界不能反复调用摘要模型。
  let called = false;
  await compactSession(session, signal, async () => {
    called = true;
    return "不应调用";
  });
  assert.equal(called, false);

  // 取消时保留已保存的压缩状态。
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    compactSession(session, abort.signal, async () => "不应保存"),
  );
  assert.deepEqual(contextMessages(session, signal), view);

  console.log("手动压缩核心检查通过");
} finally {
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
}
