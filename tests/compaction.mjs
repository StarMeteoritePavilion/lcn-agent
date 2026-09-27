import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, saveMessage} from "../dist/core/session.js";
import {
  compactIfNeeded,
  compactSession,
  contextMessages,
} from "../dist/core/compaction.js";

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

  // 使用独立会话验证阈值边界，避免已有压缩状态影响结果。
  function thresholdSession() {
    const current = createSession("local-test");
    saveMessage(current, { role: "user", content: "保留用户约束" });
    saveMessage(current, {
      role: "assistant",
      content: "可压缩的旧说明".repeat(2000),
    });
    saveMessage(current, { role: "user", content: "当前问题" });
    return current;
  }

  const automatic = thresholdSession();
  const bytes = Buffer.byteLength(
    JSON.stringify(contextMessages(automatic, signal)),
    "utf8",
  );

  let summaryCalls = 0;
  const summarize = async () => {
    summaryCalls++;
    return "已讨论旧说明，用户约束仍适用。";
  };

  // 比阈值少一个字节：不触发。
  assert.equal(
    await compactIfNeeded(automatic, signal, summarize, bytes + 1),
    null,
  );
  assert.equal(summaryCalls, 0);

  // 恰好达到阈值：触发一次。
  const result = await compactIfNeeded(automatic, signal, summarize, bytes);
  assert.match(result, /压缩已保存/);
  assert.equal(summaryCalls, 1);
  assert.equal(contextMessages(automatic, signal).at(-1).content, "当前问题");

  // 压缩后低于同一阈值：不再请求摘要。
  assert.equal(
    await compactIfNeeded(automatic, signal, summarize, bytes),
    null,
  );
  assert.equal(summaryCalls, 1);

  // 达到阈值但摘要失败：视图保持不变。
  const failed = thresholdSession();
  const failedView = contextMessages(failed, signal);
  await assert.rejects(
    compactIfNeeded(
      failed,
      signal,
      async () => {
        throw new Error("阈值摘要失败");
      },
      1,
    ),
    /阈值摘要失败/,
  );
  assert.deepEqual(contextMessages(failed, signal), failedView);

  // 没有可切分的旧回合：不调用摘要。
  const short = createSession("local-test");
  saveMessage(short, { role: "user", content: "只有当前问题" });
  assert.match(
    await compactIfNeeded(short, signal, summarize, 1),
    /暂无可进一步压缩/,
  );
  assert.equal(summaryCalls, 1);

  await assert.rejects(
    compactIfNeeded(short, signal, summarize, 0),
    /阈值/,
  );

  console.log("手动与阈值压缩核心检查通过");
} finally {
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
}
