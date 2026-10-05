import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

// 直接运行源码时使用 .ts，运行编译产物时使用 .js。
const extension = extname(fileURLToPath(import.meta.url));
const mainUrl = new URL(`../src/main${extension}`, import.meta.url);

/**
 * 验证入口无导入副作用、精确选择模型、执行工具并传播调用与校验错误。
 * @param t - 提供临时目录清理的测试上下文。
 * @throws 临时文件操作失败、入口行为或进程输出不符时抛出异常。
 * @remarks 创建临时配置和模拟请求模块，在独立进程中运行入口；测试结束后清理临时目录。
 */
test("入口选择非首项供应商并执行工具后携带结果输出回复", (t: TestContext): void => {
  const prefix = join(tmpdir(), "lcn-main-");
  const cwd = mkdtempSync(prefix);
  /** 删除测试临时文件。 */
  t.after((): void => rmSync(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, "setting.json");
  const mockPath = join(cwd, "mock.mjs");
  writeFileSync(
    mockPath,
    `
import assert from "node:assert/strict";
const mode = process.env.MOCK_MODE;
let round = 0;
const expected = [{ role: "user", content: "请调用 add 计算 17 加 25。" }];
/**
 * 核对运行入口的实际请求轮数；配置失败时无需请求。
 * @throws 请求轮数不符时抛出断言错误。
 */
process.on("exit", () => {
  if (round === 0) {
    return;
  }
  const expectedRounds = ["limit", "fourth_final"].includes(mode) ? 4 :
    ["network_error", "validation_error", "unknown_tool", "no_tools"].includes(mode) ? 1 : 2;
  assert.equal(round, expectedRounds);
});
/**
 * 验证工具声明和完整历史，返回工具调用或最终文本的模拟流。
 * @param input - 请求地址或请求对象。
 * @param init - 请求选项。
 * @returns 模拟的流式响应。
 * @throws 请求参数不符或模拟网络失败时抛出异常。
 */
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://example.invalid/v1/chat/completions");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-api-key");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.stream, true);
  assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
  assert.deepEqual(body.tools, [{
    type: "function",
    function: {
      name: "add",
      description: "计算两个数字之和",
      parameters: {
        type: "object",
        required: ["a", "b"],
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
    },
  }]);
  assert.deepEqual(body.messages, expected);
  round++;
  assert.ok(round <= (["limit", "fourth_final"].includes(mode) ? 4 : 2));
  if (mode === "network_error") {
    throw new Error("模拟网络失败");
  }
  let delta;
  let reason;
  if ((round === 1 && mode !== "no_tools") || mode === "limit" ||
    (mode === "fourth_final" && round < 4)) {
    const name = mode === "unknown_tool" ? "subtract" : "add";
    const args = mode === "validation_error" ? { a: 17 } :
      mode === "converted" ? { a: "17", b: "25" } : { a: 17, b: 25 };
    const toolCall = {
      id: "call_" + round,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
    if (mode === "multiple_tools") {
      const secondCall = {
        id: "call_second",
        type: "function",
        function: { name: "add", arguments: JSON.stringify({ a: 1, b: 2 }) },
      };
      delta = {
        content: "执行两个加法",
        tool_calls: [{ index: 0, ...toolCall }, { index: 1, ...secondCall }],
      };
      reason = "stop";
      expected.push({ role: "assistant", content: "执行两个加法", tool_calls: [toolCall, secondCall] });
      expected.push({ role: "tool", content: "42", tool_call_id: toolCall.id });
      expected.push({ role: "tool", content: "3", tool_call_id: secondCall.id });
    } else {
      delta = { tool_calls: [{ index: 0, ...toolCall }] };
      reason = mode === "tool_length" ? "length" : "tool_calls";
      expected.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      expected.push({ role: "tool", content: "42", tool_call_id: toolCall.id });
    }
  } else {
    delta = { content: "17 加 25 等于 42。" };
    reason = mode === "length" ? "length" : mode === "content_filter" ? "content_filter" :
      mode === "no_tools" ? "tool_calls" : "stop";
  }
  const chunk = { choices: [{ delta, finish_reason: reason }] };
  const data = "data: " + JSON.stringify(chunk) + "\\n\\ndata: [DONE]\\n\\n";
  return new Response(data, {
    headers: { "content-type": "text/event-stream" },
  });
};
`,
  );
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(mainUrl.href)});`],
    { cwd, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(imported.error, undefined);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  const config = JSON.stringify({
    provider: "lcn29",
    model: "gpt-6.1-sol",
    modelProviders: [
      {
        name: "其他服务商",
        api: "anthropic-messages",
        baseUrl: "https://other.example.invalid/v1",
        apiKey: "other-api-key",
        models: [{ id: "gpt-6.1-sol", maxTokens: 500000 }],
      },
      {
        name: "lcn29",
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        apiKey: "${API_KEY}",
        models: [
          { id: "gemini-3.8-flash-high", maxTokens: 500000 },
          { id: "gpt-6.1-sol", maxTokens: 500000 },
        ],
      },
    ],
  });
  writeFileSync(configPath, config);
  writeFileSync(join(cwd, ".env"), 'API_KEY="test-api-key"');
  /**
   * 在独立进程中运行入口，所有请求均由模拟实现处理。
   * @param mode - 模拟结束状态、单轮多工具、第四轮答复、参数转换及请求或工具错误。
   * @returns 入口进程的退出状态和输出。
   */
  function run(
    mode:
      | "stop"
      | "length"
      | "tool_length"
      | "converted"
      | "multiple_tools"
      | "fourth_final"
      | "no_tools"
      | "network_error"
      | "content_filter"
      | "validation_error"
      | "unknown_tool"
      | "limit" = "stop",
  ): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ["--import", mockPath, fileURLToPath(mainUrl)], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, MOCK_MODE: mode },
    });
  }
  const success = run();
  assert.equal(success.error, undefined);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, "[ { type: 'text', text: '17 加 25 等于 42。' } ]\n");
  assert.equal(success.stderr, "");
  const limited = run("length");
  assert.equal(limited.error, undefined);
  assert.equal(limited.status, 0, limited.stderr);
  assert.equal(limited.stdout, success.stdout);
  assert.equal(limited.stderr, "");
  for (const mode of [
    "tool_length",
    "converted",
    "multiple_tools",
    "fourth_final",
    "no_tools",
  ] as const) {
    const result = run(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, success.stdout);
    assert.equal(result.stderr, "");
  }
  const failure = run("network_error");
  assert.equal(failure.error, undefined);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /Error: Connection error\./u);
  const filtered = run("content_filter");
  assert.equal(filtered.error, undefined);
  assert.equal(filtered.status, 1);
  assert.equal(filtered.stdout, "");
  assert.match(filtered.stderr, /Error: Provider finish_reason: content_filter/u);

  for (const [mode, message] of [
    ["validation_error", /Validation failed for tool "add":/u],
    ["unknown_tool", /Tool "subtract" not found/u],
    ["limit", /示例达到四轮上限；请检查调用记录/u],
  ] as const) {
    const result = run(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    if (mode === "validation_error") {
      assert.match(result.stderr, /- b:/u);
    }
  }
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
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。\n",
    );
  }
  rmSync(configPath);
  const missingConfig = run();
  assert.equal(missingConfig.error, undefined);
  assert.equal(missingConfig.status, 1);
  assert.equal(missingConfig.stdout, "");
  assert.equal(
    missingConfig.stderr,
    "模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。\n",
  );
});

/**
 * 验证无效配置在发起外部请求之前结束进程。
 * @param t - 提供临时目录清理的测试上下文。
 * @throws 临时文件操作失败或入口未在请求前失败时抛出异常。
 * @remarks 创建临时配置并在独立进程中运行入口，测试结束后清理临时目录。
 */
test("配置校验失败时不发送模型请求", (t: TestContext): void => {
  const prefix = join(tmpdir(), "lcn-main-invalid-");
  const cwd = mkdtempSync(prefix);
  /** 清理测试目录。 */
  t.after((): void => rmSync(cwd, { recursive: true, force: true }));
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
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-secret-key",
        models: [{ id: "已声明模型", maxTokens: 500000 }],
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

/**
 * 验证入口按所选供应商的 api 分发到 Anthropic 协议并传递显式或缺省生成预算。
 * @param t - 提供临时目录清理的测试上下文。
 * @throws 入口未使用配置协议、认证不符或最终文本不符时抛出断言错误。
 * @remarks 创建临时配置和模拟请求模块，在独立进程运行入口，测试结束后清理临时目录。
 */
test("入口按供应商配置选择 Anthropic 协议", (t: TestContext): void => {
  const prefix = join(tmpdir(), "lcn-main-anthropic-");
  const cwd = mkdtempSync(prefix);
  /**
   * 清理测试目录及模拟配置。
   * @throws 删除临时目录失败时抛出异常。
   */
  t.after((): void => rmSync(cwd, { recursive: true, force: true }));
  const mockPath = join(cwd, "mock.mjs");
  writeFileSync(
    mockPath,
    `
import assert from "node:assert/strict";
/**
 * 核对 Anthropic 请求并返回命名 SSE 文本事件。
 * @param input - 请求地址。
 * @param init - 请求头及序列化参数。
 * @returns 正常结束的模拟响应。
 * @throws 协议地址、认证或模型选择不符时抛出断言错误。
 */
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), "https://example.invalid/v1/messages?beta=true");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("x-api-key"), "test-api-key");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, Number(process.env.EXPECTED_MAX_TOKENS));
  assert.equal(body.tools[0].name, "add");
  const events = [
    { type: "message_start", message: { content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "协议选择正确" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
  let data = "";
  for (const event of events) {
    data += "event: " + event.type + "\\ndata: " + JSON.stringify(event) + "\\n\\n";
  }
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
};
`,
  );
  const config = {
    provider: "服务商",
    model: "gpt-6.1-sol",
    modelProviders: [
      {
        name: "服务商",
        api: "anthropic-messages",
        baseUrl: "https://example.invalid",
        apiKey: "test-api-key",
        models: [
          { id: "gemini-3.8-flash-high", maxTokens: 999 },
          { id: "gpt-6.1-sol", maxTokens: 1234 },
        ],
      },
    ],
  };
  const configPath = join(cwd, "setting.json");
  for (const maxTokens of [1234, undefined]) {
    Object.assign(config.modelProviders[0].models[1], { maxTokens });
    writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(process.execPath, ["--import", mockPath, fileURLToPath(mainUrl)], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, EXPECTED_MAX_TOKENS: String(maxTokens ?? 16384) },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "[ { type: 'text', text: '协议选择正确' } ]\n");
  }
});
