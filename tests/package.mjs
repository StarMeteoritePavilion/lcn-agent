import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDemoModel } from "../dist/core/demo.js";

/**
 * @file npm 打包、生产依赖安装与分发端到端集成测试。
 *
 * 验证目标：
 * 1. 发布文件清单校验：通过 npm pack 生成 tarball 并严格比对文件清单，防止源码、测试或敏感私有文件泄露；
 * 2. 纯净生产依赖安装：在临时隔离目录执行 npm install --omit=dev，验证不依赖开发依赖即可独立运行；
 * 3. CLI 快速响应与无配置拦截：验证 --help 和 --version 快速输出，无配置文件直接运行时明确拦截报错；
 * 4. 真实包内子进程 Worker 定位：验证作为全局/局部安装包时，子代理仍能从正确的安装路径找到 subagent-worker.js；
 * 5. 真实配置与 MCP 联动：验证安装包下的 config.example.toml 复制为真实配置后，MCP stdio 服务可正常拉起。
 */

const root = resolve(import.meta.dirname, "..");
const folder = mkdtempSync(join(tmpdir(), "lcn-package-"));
const install = join(folder, "install");
const cwd = join(folder, "workspace");
mkdirSync(cwd);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const exec = promisify(execFile);
const env = { ...process.env };
for (const key of ["LCN_AGENT_EXTENSION", "LCN_AGENT_MCP_DEMO", "LCN_AGENT_MCP_HTTP_URL"]) delete env[key];
let child;
let closed;
let demo;
try {
  const packed = await exec(npm, ["pack", "--json", "--pack-destination", folder], { cwd: root, timeout: 60000 });
  const [metadata] = JSON.parse(packed.stdout);
  const names = metadata.files.map((file) => file.path);
  const fixed = ["package.json", "README.md", "LICENSE", "config.example.toml", ".env.example",
    "dist/cli.js", "dist/index.js", "dist/subagent-worker.js", "dist/mcp-demo-server.js",
    "dist/mcp-http-demo-server.js"];
  for (const name of fixed) assert.ok(names.includes(name), `缺少发布文件：${name}`);
  for (const name of names) {
    assert.ok(fixed.includes(name) || /^dist\/(core|extensions)\/[^/]+\.js$/.test(name), `意外发布文件：${name}`);
  }
  console.log(`发布清单通过：${names.length} 个文件；开始在临时目录安装生产依赖`);
  await exec(npm, ["install", "--prefix", install, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
    join(folder, metadata.filename)], { cwd: folder, timeout: 120000 });
  const installed = join(install, "node_modules/lcn-agent");
  const cli = join(installed, "dist/cli.js");
  assert.equal(readFileSync(cli, "utf8").split("\n")[0], "#!/usr/bin/env node");
  assert.equal(existsSync(join(install, "node_modules/typescript")), false);
  const run = (args, extraEnv = {}) => exec(process.execPath, [cli, ...args],
    { cwd, env: { ...env, ...extraEnv }, timeout: 10000 });
  const manifest = JSON.parse(readFileSync(join(installed, "package.json")));
  assert.equal((await run(["--version"])).stdout.trim(), manifest.version);
  assert.match((await run(["--help"])).stdout, /用法：lcn-agent/);
  assert.match((await run(["-h"])).stdout, /config.toml/);
  assert.deepEqual(readdirSync(cwd), []);
  if (process.platform !== "win32") {
    const output = await exec(join(install, "node_modules/.bin/lcn-agent"), ["--help"], { cwd, env });
    assert.match(output.stdout, /用法：lcn-agent/);
  }
  await assert.rejects(run(["普通输入"]), (error) => error.code === 1 && /无法读取 config.toml/.test(error.stderr));
  assert.match((await run(["--demo", "回显 安装后演示成功"])).stdout, /工具实际返回：\n安装后演示成功/);

  // 验证安装目录内的子代理 worker，可从全新工作目录正确定位并完成真实文件读取。
  writeFileSync(join(cwd, "note.txt"), "已安装包的子进程读取正文");
  child = spawn(process.execPath, [cli, "--demo"], { cwd, env });
  closed = new Promise((resolve) => child.once("close", resolve));
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text) => { output += text; });
  child.stderr.setEncoding("utf8").on("data", (text) => { output += text; });
  async function until(predicate) {
    const end = Date.now() + 8000;
    while (!predicate()) {
      assert.ok(child.exitCode === null && Date.now() < end, output);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function send(text, expected) {
    const offset = output.length;
    child.stdin.write(text + "\n");
    await until(() => output.slice(offset).includes(expected));
  }
  await until(() => output.includes("生成中 Ctrl+C 取消"));
  await send("/new", "会话：");
  await send("/task_start 读取 note.txt", "已启动后台任务：");
  const directory = join(cwd, ".lcn-agent/background_tasks");
  const state = join(directory, readdirSync(directory)[0]);
  const task = () => JSON.parse(readFileSync(state)).items[0];
  await until(() => task().status === "awaiting_approval");
  const pending = task();
  await send(`/task_approve ${pending.id} ${pending.pending.approvalId}`, "已批准本次读取");
  await until(() => task().status === "completed");
  assert.match(JSON.parse(task().result).content, /已安装包的子进程读取正文/);
  assert.throws(() => process.kill(pending.pid, 0), (error) => error.code === "ESRCH");
  child.stdin.write("/exit\n");
  const exitTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { assert.equal(await closed, 0, output); }
  finally { clearTimeout(exitTimer); }
  child = undefined;

  // 真实配置入口连接本机模拟模型；stdio MCP 服务同样必须从安装位置启动。
  demo = await startDemoModel();
  writeFileSync(join(cwd, "config.toml"), readFileSync(join(installed, "config.example.toml")));
  const real = await run(["回显 安装配置入口成功"], {
    API_KEY: demo.config.apiKey, BASE_URL: demo.config.baseURL, MODEL: demo.config.model, LCN_AGENT_MCP_DEMO: "1",
  });
  assert.match(real.stdout, /已接入本地 MCP 工具：mcp_demo_demo_status/);
  assert.match(real.stdout, /工具实际返回：\n安装配置入口成功/);
  assert.equal(existsSync(join(installed, ".lcn-agent")), false);
  assert.equal(existsSync(join(cwd, ".lcn-agent/sessions/.writer.lock")), false);
  console.log("安装包检查通过：生产依赖安装、帮助/版本、独立目录演示、真实子代理/MCP 路径与配置缺失提示");
} finally {
  if (child) { child.kill("SIGKILL"); await closed; }
  await demo?.close();
  rmSync(folder, { recursive: true, force: true });
}
