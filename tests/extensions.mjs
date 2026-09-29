import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExtensionSettings } from "../dist/core/extension-settings.js";
import { createToolRegistry } from "../dist/core/tools.js";
import { startDemoModel } from "../dist/core/demo.js";

/**
 * @file 项目级扩展启停管理（/extensions 与 extensions.json）集成测试。
 *
 * 验证目标：
 * 1. 严格语法与编号校验：编号必须精确匹配预设枚举（区分大小写），拒绝非法格式、未知扩展或路径注入；
 * 2. 规划模式只读防御：plan 模式下严格禁止执行修改扩展配置的命令；
 * 3. 启动快照与重启生效：当前运行中修改仅持久化磁盘，当前进程状态保持不变，新进程启动才装载变更；
 * 4. 损坏配置与软链接防御：非法 JSON、未知字段或包含符号链接（Symlink）时拒绝覆盖并报错；
 * 5. 真实终端交互与上下文隔离：通过真实子进程驱动 CLI，验证禁用模块后工具及命令彻底卸载，
 *    且不会触发已禁用模块（如损坏的 Skill 文件或坏项目记忆）的解析错误；
 * 6. 重新启用与恢复：通过命令重新启用并重启后，对应扩展模块与工具完整恢复正常。
 */

const cwd = mkdtempSync(join(tmpdir(), "lcn-extensions-"));
const file = join(cwd, ".lcn-agent/extensions.json");
const cli = resolve("dist/index.js");
const demo = await startDemoModel();
const env = { ...process.env };
for (const key of ["LCN_AGENT_EXTENSION", "LCN_AGENT_MCP_DEMO", "LCN_AGENT_MCP_HTTP_URL"]) delete env[key];
const children = new Set();

// 驱动真实宿主命令，逐条等待结果，避免把多行输入提前塞进尚未开始读取的 readline。
async function terminal(args = ["--demo"], extraEnv = {}) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...env, ...extraEnv } });
  children.add(child);
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  async function wait(text, offset = 0) {
    const until = Date.now() + 8000;
    while (!output.slice(offset).includes(text)) {
      assert.ok(child.exitCode === null && Date.now() < until, output);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return output.slice(offset);
  }
  await wait("生成中 Ctrl+C 取消");
  return {
    async send(text, expected) {
      const offset = output.length;
      child.stdin.write(text + "\n");
      return wait(expected, offset);
    },
    async close() {
      child.stdin.write("/exit\n");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { assert.equal(await closed, 0, output); }
      finally { clearTimeout(timeout); children.delete(child); }
    },
  };
}
try {
  const settings = createExtensionSettings(cwd, false);
  settings.markLoaded("echo");
  assert.match(settings.command("", "plan"), /echo \| 当前：已装载 \| 下次设置：启用/);
  assert.throws(() => settings.command("disable echo", "plan"), /plan 模式/);
  for (const args of ["disable Echo", "enable toString", "disable echo extra", "disable workflow/../echo"]) {
    assert.throws(() => settings.command(args, "execute"), /用法/);
  }
  settings.command("disable echo", "execute");
  assert.equal(settings.enabled("echo"), true);
  assert.equal(createExtensionSettings(cwd, false).enabled("echo"), false);
  assert.match(settings.command("", "execute"), /echo \| 当前：已装载 \| 下次设置：禁用/);
  settings.command("enable echo", "execute");
  assert.equal(createExtensionSettings(cwd, true).enabled("external"), false);
  assert.deepEqual(JSON.parse(readFileSync(file)), { version: 1, disabled: [] });
  assert.deepEqual(readdirSync(join(cwd, ".lcn-agent")), ["extensions.json"]);
  assert.throws(() => createToolRegistry().registerCommand({ name: "extensions", execute() {} }), /不可覆盖/);

  // 坏配置不覆盖、不忽略；大小写、未知键、重复编号和版本都精确校验。
  for (const bad of ["broken", '{"version":2,"disabled":[]}', '{"version":1,"disabled":["Echo"]}',
    '{"version":1,"disabled":["echo","echo"]}', '{"version":1,"disabled":[],"unknown":true}',
    Buffer.from([255]), "x".repeat(65537)]) {
    writeFileSync(file, bad);
    const before = readFileSync(file);
    assert.throws(() => settings.command("disable echo", "execute"));
    assert.throws(() => createExtensionSettings(cwd, false));
    assert.deepEqual(readFileSync(file), before);
  }
  rmSync(file);
  symlinkSync(join(cwd, "missing.json"), file);
  assert.throws(() => createExtensionSettings(cwd, false), /符号链接/);
  rmSync(file);

  let ui = await terminal();
  const initial = await ui.send("/extensions", "用法：/extensions");
  assert.match(initial, /workflow \| 当前：已装载/);
  assert.match(initial, /mcp_demo \| 当前：演示模式禁用/);
  assert.equal(readdirSync(join(cwd, ".lcn-agent/sessions")).filter((name) => name.endsWith(".jsonl")).length, 0);
  await ui.send("/mode plan", "当前模式：plan");
  await ui.send("/extensions disable echo", "plan 模式不允许");
  await ui.send("/mode execute", "当前模式：execute");
  for (const id of ["echo", "workflow", "skills", "subagent"]) {
    await ui.send(`/extensions disable ${id}`, `已保存 ${id}：禁用`);
  }
  await ui.send("回显 当前进程仍可调用", "完成，共 2 轮");
  await ui.close();

  // 禁用后不发现坏 Skill，也不读取坏项目记忆；管理入口本身始终可用。
  mkdirSync(join(cwd, ".agents/skills/broken"), { recursive: true });
  writeFileSync(join(cwd, ".agents/skills/broken/SKILL.md"), "broken");
  writeFileSync(join(cwd, ".lcn-agent/memory.json"), "broken");
  ui = await terminal();
  assert.match(await ui.send("/extensions", "用法：/extensions"), /echo \| 当前：已禁用/);
  const noEcho = await ui.send("回显 不应调用", "完成，共 1 轮");
  assert.match(noEcho, /当前模式没有提供 echo，未执行/);
  await ui.send("/todo_list", "未知命令");
  await ui.send("/skills", "未知命令");
  await ui.send("/task_start 等待", "未知命令");
  await ui.send("/extensions enable echo", "已保存 echo：启用");
  await ui.close();
  ui = await terminal();
  await ui.send("回显 重启恢复", "完成，共 2 轮");
  await ui.close();

  // 真实配置入口同样遵守禁用设置，不能装载无效外部路径或连接无效 MCP 地址。
  settings.command("disable external", "execute");
  settings.command("disable mcp_demo", "execute");
  settings.command("disable mcp_http", "execute");
  writeFileSync(join(cwd, "config.toml"), Object.entries(demo.config)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"));
  ui = await terminal([], { LCN_AGENT_EXTENSION: "missing.mjs", LCN_AGENT_MCP_DEMO: "invalid",
    LCN_AGENT_MCP_HTTP_URL: "invalid" });
  assert.match(await ui.send("/extensions", "用法：/extensions"), /external \| 当前：已禁用/);
  await ui.send("回显 真实入口", "完成，共 2 轮");
  await ui.send("/extensions enable external", "已保存 external：启用");
  await ui.send("/extensions enable mcp_demo", "已保存 mcp_demo：启用");
  await ui.close();
  const extension = join(cwd, "fixture.mjs");
  writeFileSync(extension, 'export default api => api.registerCommand({name:"fixture",execute:()=>"扩展已运行"});');
  ui = await terminal([], { LCN_AGENT_EXTENSION: extension, LCN_AGENT_MCP_DEMO: "1" });
  const enabled = await ui.send("/extensions", "用法：/extensions");
  assert.match(enabled, /external \| 当前：已装载/);
  assert.match(enabled, /mcp_demo \| 当前：已装载/);
  await ui.send("/fixture", "扩展已运行");
  await ui.close();
  assert.ok(!readdirSync(join(cwd, ".lcn-agent/sessions")).includes(".writer.lock"));
  console.log("扩展配置检查通过：严格校验、原子保存、宿主管理入口、plan 拦截、重启启停与上下文隔离");
} finally {
  for (const child of children) child.kill("SIGKILL");
  await demo.close();
  rmSync(cwd, { recursive: true, force: true });
}
