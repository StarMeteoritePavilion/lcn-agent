import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkills } from "../dist/extensions/skills.js";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";

const cwd = mkdtempSync(join(tmpdir(), "lcn-skills-"));
try {
  const directory = join(cwd, ".agents", "skills", "demo");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    "---\nname: demo\ndescription: >\n  用于验证渐进加载。\n---\n正文验证标记\n",
  );

  const context = {
    cwd,
    model: "local-test",
    sessionFile: "a.jsonl",
    callId: "1",
    signal: new AbortController().signal,
    confirm: async () => false,
    ui: {
      notify() {},
      ask: async () => "",
    },
  };

  let allowed = false;
  const registry = createToolRegistry(() => allowed);
  const skills = createSkills(cwd);
  const dispose = mountExtension(registry, skills.register);

  // 未激活时只有目录，不包含正文。
  assert.ok(skills.prompt(context).includes("用于验证渐进加载"));
  assert.ok(!skills.prompt(context).includes("正文验证标记"));

  // 拒绝权限时不能保存激活状态。
  await assert.rejects(
    registry.execute("skill_activate", { name: "demo" }, context),
    /未获授权/,
  );
  assert.ok(!skills.prompt(context).includes("正文验证标记"));

  // 允许后正文出现一次；重复激活不改写状态文件。
  allowed = true;
  await registry.execute("skill_activate", { name: "demo" }, context);
  const statePath = join(cwd, ".lcn-agent", "skill_activations", "a.jsonl.json");
  const saved = readFileSync(statePath);
  await registry.execute("skill_activate", { name: "demo" }, context);
  assert.equal(skills.prompt(context).split("正文验证标记").length - 1, 1);
  assert.deepEqual(readFileSync(statePath), saved);

  // 重新创建模块后恢复快照；不同会话不串用。
  assert.equal(createSkills(cwd).prompt(context), skills.prompt(context));
  const other = { ...context, sessionFile: "b.jsonl" };
  assert.ok(!skills.prompt(other).includes("正文验证标记"));

  // 用户显式命令走同一激活逻辑，名称错误不补全。
  await registry.executeCommand("skill", "demo", other);
  assert.ok(skills.prompt(other).includes("正文验证标记"));
  await assert.rejects(registry.executeCommand("skill", "DEMO", other), /不存在/);

  // 损坏记录拒绝覆盖。
  writeFileSync(statePath, "{");
  await assert.rejects(
    registry.execute("skill_activate", { name: "demo" }, context),
    /损坏/,
  );
  assert.equal(readFileSync(statePath, "utf8"), "{");

  dispose();
  await assert.rejects(
    registry.execute("skill_activate", { name: "demo" }, context),
    /未知工具/,
  );

  console.log("Skills 基础检查通过");
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
