import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPrompt, listPrompts } from "../dist/core/prompts.js";

const cwd = mkdtempSync(join(tmpdir(), "lcn-prompts-"));
const signal = new AbortController().signal;

try {
  assert.deepEqual(listPrompts(cwd), []);
  assert.equal(expandPrompt("普通问题", cwd, signal), "普通问题");

  const directory = join(cwd, ".agents", "prompts");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "explain.md"), "解释：$ARGUMENTS\n");

  assert.deepEqual(listPrompts(cwd), ["explain.md"]);
  assert.equal(
    expandPrompt("/prompt explain.md a b", cwd, signal),
    "解释：a b\n",
  );

  // 参数中的替换符保持字面值，不发生递归展开。
  assert.equal(
    expandPrompt("/prompt explain.md $& $ARGUMENTS", cwd, signal),
    "解释：$& $ARGUMENTS\n",
  );

  assert.throws(() => expandPrompt("/prompt", cwd, signal), /用法/);
  assert.throws(() => expandPrompt("/prompt EXPLAIN.md", cwd, signal), /不存在/);
  assert.throws(() => expandPrompt("/prompt ../explain.md", cwd, signal), /不存在/);

  writeFileSync(join(directory, "empty.md"), "$ARGUMENTS");
  assert.throws(() => expandPrompt("/prompt empty.md", cwd, signal), /不能为空/);

  writeFileSync(join(directory, "invalid.md"), Buffer.from([255]));
  assert.throws(() => expandPrompt("/prompt invalid.md", cwd, signal), /UTF-8/);

  assert.throws(
    () => expandPrompt("/prompt explain.md " + "文".repeat(23000), cwd, signal),
    /64 KiB/,
  );

  // 展开结果不会被再次解释为宿主命令。
  writeFileSync(join(directory, "literal.md"), "/exit");
  assert.equal(expandPrompt("/prompt literal.md", cwd, signal), "/exit");

  const controller = new AbortController();
  controller.abort();
  assert.throws(() => expandPrompt("普通问题", cwd, controller.signal));

  console.log("提示模板检查通过");
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
