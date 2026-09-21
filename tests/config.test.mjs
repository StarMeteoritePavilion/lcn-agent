import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const moduleURL = new URL("../dist/config.js", import.meta.url).href;
const entryPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const references = 'apiKey = "${API_KEY}"\nbaseURL = "${BASE_URL}"\nmodel = "${MODEL}"';
const fixed = 'apiKey = "test-secret"\nbaseURL = "http://127.0.0.1:1/v1"\nmodel = "test-model"';
const values = { API_KEY: "test-secret", BASE_URL: "http://127.0.0.1:1/v1", MODEL: "test-model" };
const expected = { apiKey: values.API_KEY, baseURL: values.BASE_URL, model: values.MODEL };
const special = 'quote"\\\n${DO_NOT_EXPAND} $&';

// 子进程隔离环境和工作目录，所有文件只包含测试值。
function run({ config = references, env = {}, dotenv, envDirectory = false, entry = false }) {
  const directory = mkdtempSync(join(tmpdir(), "lcn-config-"));
  try {
    if (config !== null) writeFileSync(join(directory, "config.toml"), config);
    if (dotenv !== undefined) writeFileSync(join(directory, ".env"), dotenv);
    if (envDirectory) mkdirSync(join(directory, ".env"));
    const source = `import { loadConfig } from ${JSON.stringify(moduleURL)};
      try { console.log(JSON.stringify(loadConfig())); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const args = entry ? [entryPath] : ["--input-type=module", "-e", source];
    const result = spawnSync(process.execPath, args, {
      cwd: directory,
      env,
      input: "/exit\n",
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(result.error);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("配置来源、插值和校验", () => {
  const dotenv = Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
  for (const options of [{ dotenv }, { env: values }, { config: fixed }, { dotenv, env: values }]) {
    const result = run(options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  const override = run({ dotenv, env: { API_KEY: "override" } });
  assert.equal(override.status, 0, override.stderr);
  assert.equal(JSON.parse(override.stdout).apiKey, "override");
  const literal = run({ config: fixed, env: { API_KEY: "ignored" } });
  assert.deepEqual(JSON.parse(literal.stdout), expected);
  const preserved = run({ env: { ...values, API_KEY: special } });
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(JSON.parse(preserved.stdout).apiKey, special);
  const combined = run({ config: fixed.replace("test-model", "${MODEL}/${MODEL}"), env: values });
  assert.equal(JSON.parse(combined.stdout).model, "test-model/test-model");

  const invalid = [
    [{}, "缺少环境变量：API_KEY"],
    [{ dotenv, env: { API_KEY: "" } }, "apiKey 必须是非空字符串"],
    [{ env: { ...values, API_KEY: "  " } }, "apiKey 必须是非空字符串"],
    [{ config: fixed.replace('apiKey = "test-secret"', "apiKey = 42") }, "apiKey 必须是非空字符串"],
    [{ config: fixed.replace('model = "test-model"', "") }, "model 必须是非空字符串"],
    [{ config: null }, "无法读取 config.toml"],
    [{ config: fixed + '\nbroken = "DO_NOT_LEAK' }, "config.toml 格式错误"],
    [{ config: fixed, envDirectory: true }, "无法读取 .env"],
    [{ config: fixed + '\n[extra]\nitems = [{ value = "${MISSING}" }]' }, "缺少环境变量：MISSING"],
    [{ config: fixed.replace("test-secret", "${api_key}"), env: values }, "缺少环境变量：api_key"],
  ];
  for (const [options, message] of invalid) {
    const result = run(options);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.ok(!result.stderr.includes("DO_NOT_LEAK"));
    assert.ok(!result.stderr.includes("test-secret"));
  }
  const nested = fixed + '\n[extra]\nitems = ["${MODEL}", 3, true, 2026-09-21, { a = "${API_KEY}" }]';
  const result = run({ config: nested, env: values });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("真实入口在无 .env 时可启动，错误配置安全退出", () => {
  const result = run({ env: values, entry: true });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("终端程序已退出"));
  const failure = run({ config: fixed + '\nbroken = "DO_NOT_LEAK', entry: true });
  assert.equal(failure.status, 1);
  assert.ok(failure.stderr.includes("config.toml 格式错误"));
  assert.ok(!failure.stderr.includes("DO_NOT_LEAK"));
  assert.equal(failure.stdout, "");
});
