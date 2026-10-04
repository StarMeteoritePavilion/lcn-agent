import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const mainUrl = new URL("../src/main.js", import.meta.url);

/**
 * 验证导入入口无副作用，以及启动成功或失败时均不输出配置内容和环境变量中的密钥。
 * @param t - 提供临时目录清理的测试上下文。
 */
test("直接启动加载配置并安全报告结果", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lcn-main-"));
  /** 删除入口测试创建的临时目录及全部内容。 */
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, "config.toml");
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(mainUrl.href)});`],
    { cwd, encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  writeFileSync(configPath, 'API_KEY = "${API_KEY}"');
  writeFileSync(join(cwd, ".env"), 'API_KEY="测试密钥"');
  const success = spawnSync(process.execPath, [fileURLToPath(mainUrl)], { cwd, encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, "配置加载成功。\n");
  assert.equal(success.stderr, "");
  writeFileSync(configPath, 'API_KEY = "测试密钥');
  const failure = spawnSync(process.execPath, [fileURLToPath(mainUrl)], { cwd, encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, "");
  assert.equal(
    failure.stderr,
    "配置加载失败，请检查 config.toml 和同目录 .env 的内容及读取权限。\n",
  );
  rmSync(configPath);
  const missing = spawnSync(process.execPath, [fileURLToPath(mainUrl)], { cwd, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, failure.stderr);
});
