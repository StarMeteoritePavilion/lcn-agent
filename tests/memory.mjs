import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMemory,
  deleteMemory,
  memoryPrompt,
  readMemories,
} from "../dist/core/memory.js";
import registerMemory from "../dist/extensions/memory.js";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";

const root = mkdtempSync(join(tmpdir(), "lcn-memory-"));
const first = join(root, "first");
const second = join(root, "second");
mkdirSync(first);
mkdirSync(second);

const signal = new AbortController().signal;

try {
  assert.deepEqual(readMemories(first), []);
  assert.equal(memoryPrompt(first), "");

  addMemory(first, "项目说明使用中文", signal);
  const [item] = readMemories(first);
  assert.equal(item.content, "项目说明使用中文");
  assert.equal(item.source, "用户显式保存");
  assert.ok(Number.isFinite(Date.parse(item.updatedAt)));
  assert.ok(memoryPrompt(first).includes("项目说明使用中文"));
  assert.deepEqual(readMemories(second), []);

  const path = join(first, ".lcn-agent", "memory.json");
  const saved = readFileSync(path);

  // 已取消的新增和错误编号删除都不能修改原文件。
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => addMemory(first, "不应保存", abort.signal));
  assert.throws(() => deleteMemory(first, "错误编号", signal), /不存在/);
  assert.deepEqual(readFileSync(path), saved);

  // 复制到其他项目后，scope 不匹配，拒绝串用。
  mkdirSync(join(second, ".lcn-agent"));
  writeFileSync(join(second, ".lcn-agent", "memory.json"), saved);
  assert.throws(() => readMemories(second), /作用范围/);

  // 命令不依赖会话，不注册模型工具。
  const registry = createToolRegistry();
  const dispose = mountExtension(registry, registerMemory);
  const context = {
    cwd: first,
    model: "local-test",
    sessionFile: null,
    signal,
    ui: { notify() {}, ask: async () => "" },
  };

  assert.deepEqual(registry.definitions(), []);
  assert.match(await registry.executeCommand("memory", "", context), /项目说明使用中文/);
  await registry.executeCommand("memory_delete", item.id, context);
  assert.deepEqual(readMemories(first), []);
  assert.equal(memoryPrompt(first), "");

  // 损坏记录不能被新增操作覆盖。
  writeFileSync(path, "{");
  assert.throws(() => addMemory(first, "不应覆盖", signal), /损坏/);
  assert.equal(readFileSync(path, "utf8"), "{");

  dispose();
  await assert.rejects(
    registry.executeCommand("memory", "", context),
    /未知命令/,
  );

  console.log("项目记忆核心检查通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
