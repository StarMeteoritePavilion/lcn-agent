import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// 直接运行源码时使用 .ts，运行编译产物时使用 .js。
const extension = extname(fileURLToPath(import.meta.url));
const mainUrl = new URL(`../src/main${extension}`, import.meta.url);

/**
 * 验证入口无导入副作用、精确选择模型、传递认证及安全处理配置和请求失败。
 * @param t - 提供临时目录清理的测试上下文。
 */
test("入口选择非首项供应商并输出回复", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lcn-main-"));
  /** 删除测试临时文件。 */
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, "setting.json");
  const mockPath = join(cwd, "mock.mjs");
  writeFileSync(
    mockPath,
    `
import assert from "node:assert/strict";
/**
 * 拦截模型请求，验证参数并返回模拟流。
 * @param input - 请求地址或请求对象。
 * @param init - 请求选项。
 * @returns 模拟的流式响应。
 * @throws 请求参数与配置不符时抛出断言错误。
 */
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://example.invalid/v1/chat/completions");
  assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-api-key");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "你可以做什么？");
  if (process.env.MOCK_FAIL === "1") {
    throw new Error("测试密钥不得输出");
  }
  const chunk = { choices: [{ delta: { content: "模拟回复" }, finish_reason: "stop" }] };
  return new Response("data: " + JSON.stringify(chunk) + "\\n\\ndata: [DONE]\\n\\n", {
    headers: { "content-type": "text/event-stream" },
  });
};
`,
  );
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(mainUrl.href)});`],
    { cwd, encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  const config = JSON.stringify({
    provider: "lcn29",
    model: "gpt-6.1-sol",
    modelProviders: [
      {
        name: "其他服务商",
        baseUrl: "https://other.example.invalid/v1",
        apiKey: "other-api-key",
        models: [{ id: "gpt-6.1-sol" }],
      },
      {
        name: "lcn29",
        baseUrl: "https://example.invalid/v1",
        apiKey: "${API_KEY}",
        models: [{ id: "gemini-3.8-flash-high" }, { id: "gpt-6.1-sol" }],
      },
    ],
  });
  writeFileSync(configPath, config);
  writeFileSync(join(cwd, ".env"), 'API_KEY="test-api-key"');
  /**
   * 在独立进程中运行入口，所有请求均由模拟实现处理。
   * @param fail - 是否模拟网络失败。
   * @returns 入口进程的退出状态和输出。
   */
  function run(fail = false) {
    return spawnSync(process.execPath, ["--import", mockPath, fileURLToPath(mainUrl)], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, MOCK_FAIL: fail ? "1" : "0" },
    });
  }
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, "模拟回复\n");
  assert.equal(success.stderr, "");
  const failure = run(true);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, "");
  assert.equal(failure.stderr, "模型请求失败，请检查接口地址、密钥、模型权限及网络连接。\n");
  for (const invalid of [
    config.replace('"provider":"lcn29"', '"provider":"LCN29"'),
    config.replace('"model":"gpt-6.1-sol"', '"model":"未配置模型"'),
    config.replace('"apiKey":"${API_KEY}"', '"apiKey":""'),
    config.replace('"apiKey":"${API_KEY}"', '"apiKey":"${未配置密钥}"'),
    config.replace('"id":"gpt-6.1-sol"', '"id":1'),
    config.replace('"name":"lcn29"', '"name":123'),
    config.replace('"modelProviders":[', '"modelProviders":[{},'),
    'model = "未闭合',
  ]) {
    writeFileSync(configPath, invalid);
    const result = run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。\n",
    );
  }
  rmSync(configPath);
  assert.equal(run().status, 1);
});

/**
 * 验证无效配置在发起外部请求之前结束进程。
 * @param t - 提供临时目录清理的测试上下文。
 */
test("配置校验失败时不发送模型请求", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lcn-main-invalid-"));
  /** 清理测试目录。 */
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const mockPath = join(cwd, "network.mjs");
  writeFileSync(
    mockPath,
    `
/**
 * 报告不应发生的外部请求，不访问网络。
 * @returns 始终拒绝的 Promise。
 * @throws 任何请求均抛出异常。
 */
globalThis.fetch = async () => {
  console.error("检测到不应发生的模型请求");
  throw new Error("禁止外部请求");
};
`,
  );
  const config = {
    provider: "服务商",
    model: "未声明模型",
    modelProviders: [
      {
        name: "服务商",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-secret-key",
        models: [{ id: "已声明模型" }],
      },
    ],
  };
  writeFileSync(join(cwd, "setting.json"), JSON.stringify(config));
  const result = spawnSync(process.execPath, ["--import", mockPath, fileURLToPath(mainUrl)], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。\n",
  );
});
