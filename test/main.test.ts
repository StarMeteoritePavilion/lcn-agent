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

// 只替换演示图片的读取，其他文件沿用 Node 原始行为。
const imageReadMock = `
import { promises as fsPromises } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalReadFile = fsPromises.readFile;
/**
 * 为指定演示图片提供模拟 PNG，避免依赖开发机的文件。
 * @param path - 待读取的文件路径。
 * @param options - 原始读取选项。
 * @returns 指定图片返回模拟字节；其他文件返回原始读取结果。
 * @throws 原始读取失败时传播其异常。
 * @remarks 不读取或改写用户图片；png_error 返回无效签名，image_read_error 模拟读取失败。
 */
fsPromises.readFile = async (path, options) => {
  if (path === "demo.png") {
    if (process.env.MOCK_MODE === "image_read_error") {
      throw new Error("模拟图片读取失败");
    }
    return process.env.MOCK_MODE === "png_error" ? Buffer.from("不是 PNG") :
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  }
  return originalReadFile(path, options);
};
syncBuiltinESMExports();
`;

/**
 * 验证统一入口的四项调用、流式增量、图片格式、工具历史以及失败边界。
 * @param t - 提供临时目录清理的测试上下文。
 * @throws 临时文件操作失败、请求参数或入口输出不符时抛出异常。
 * @remarks 使用独立进程及模拟 fetch，不发送真实网络请求，也不修改用户图片。
 */
test("统一入口依次执行 stream、complete、图片识别和工具调用", (t: TestContext): void => {
  const prefix = join(tmpdir(), "lcn-main-");
  const cwd = mkdtempSync(prefix);
  /**
   * 删除测试生成的配置和请求模拟文件。
   * @throws 临时目录删除失败时抛出异常。
   */
  t.after((): void => rmSync(cwd, { recursive: true, force: true }));
  const configPath = join(cwd, "setting.json");
  const mockPath = join(cwd, "mock.mjs");
  writeFileSync(
    mockPath,
    `
import assert from "node:assert/strict";
${imageReadMock}
const mode = process.env.MOCK_MODE;
let requests = 0;
const writes = [];
const originalWrite = process.stdout.write.bind(process.stdout);
/**
 * 记录每次标准输出写入，以验证流式文本按增量分别输出。
 * @param chunk - 本次输出的数据。
 * @param encoding - 字符串编码或完成回调。
 * @param callback - 输出完成回调。
 * @returns 原始写入操作的背压状态。
 */
process.stdout.write = (chunk, encoding, callback) => {
  writes.push(String(chunk));
  return originalWrite(chunk, encoding, callback);
};
/**
 * 核对调用次数以及流式增量，确保失败后停止后续功能。
 * @throws 调用次数或增量写入不符时抛出断言错误。
 */
process.on("exit", () => {
  const counts = {
    stream_error: 1, complete_error: 2, image_error: 3, image_unsupported: 2,
    validation_error: 4, unknown_tool: 4, content_filter: 4, no_tools: 4,
    limit: 7, fourth_final: 7,
  };
  const expectedCount = ["config_error", "png_error", "image_read_error"].includes(mode) ? 0 : counts[mode] ?? 5;
  assert.equal(requests, expectedCount);
  if (requests > 0 && mode !== "stream_error") {
    assert.ok(writes.includes("流式"));
    assert.ok(writes.includes("增量"));
    assert.equal(writes.includes("流式增量"), false);
  }
});
const expectedTools = [{ role: "user", content: "请调用 add 计算 17 加 25。" }];
/**
 * 验证四项功能的请求，返回含工具调用或文本增量的模拟 SSE。
 * @param input - 请求地址。
 * @param init - 请求认证及序列化选项。
 * @returns 不访问网络的模拟流式响应。
 * @throws 请求参数不符或指定模拟请求失败时抛出异常。
 */
globalThis.fetch = async (input, init) => {
  requests++;
  assert.equal(String(input), "https://example.invalid/v1/chat/completions");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer test-api-key");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "gpt-6.1-sol");
  assert.equal(body.stream, true);
  assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
  const failedStage = { stream_error: 1, complete_error: 2, image_error: 3 }[mode];
  if (requests === failedStage) {
    throw new Error("模拟网络失败");
  }
  let deltas;
  let reason = "stop";
  if (requests <= 3) {
    assert.equal(Object.hasOwn(body, "tools"), false);
    if (requests === 1) {
      assert.deepEqual(body.messages, [{ role: "user", content: "请用一句话介绍你自己。" }]);
      deltas = [{ content: "流式" }, { content: "增量" }];
    } else if (requests === 2) {
      assert.deepEqual(body.messages, [{ role: "user", content: "请用一句话解释什么是人工智能。" }]);
      deltas = [{ content: "完整回复" }];
    } else {
      assert.equal(body.messages.length, 1);
      assert.equal(body.messages[0].role, "user");
      const parts = body.messages[0].content;
      assert.equal(parts.length, 2);
      assert.deepEqual(parts[0], { type: "text", text: "请描述这张图片中的内容，并识别可见文字。" });
      assert.equal(parts[1].type, "image_url");
      const url = parts[1].image_url.url;
      assert.ok(url.startsWith("data:image/png;base64,"));
      const bytes = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      deltas = [{ content: "图片识别回复" }];
    }
  } else {
    assert.deepEqual(body.tools, [{
      type: "function",
      function: {
        name: "add", description: "计算两个数字之和",
        parameters: {
          type: "object", required: ["a", "b"],
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
      },
    }]);
    assert.deepEqual(body.messages, expectedTools);
    const round = requests - 3;
    if ((round === 1 && mode !== "no_tools" && mode !== "content_filter") ||
      mode === "limit" || (mode === "fourth_final" && round < 4)) {
      const name = mode === "unknown_tool" ? "subtract" : "add";
      const args = mode === "validation_error" ? { a: 17 } :
        mode === "converted" ? { a: "17", b: "25" } : { a: 17, b: 25 };
      const call = {
        id: "call_" + round, type: "function",
        function: { name, arguments: JSON.stringify(args) },
      };
      const calls = [call];
      if (mode === "multiple_tools") {
        calls.push({ id: "call_second", type: "function",
          function: { name: "add", arguments: JSON.stringify({ a: 1, b: 2 }) } });
      }
      const toolDeltas = [];
      for (const [index, toolCall] of calls.entries()) {
        toolDeltas.push({ index, ...toolCall });
      }
      deltas = [{ tool_calls: toolDeltas }];
      reason = mode === "tool_length" ? "length" : "tool_calls";
      expectedTools.push({ role: "assistant", content: null, tool_calls: calls });
      expectedTools.push({ role: "tool", content: "42", tool_call_id: call.id });
      if (mode === "multiple_tools") {
        expectedTools.push({ role: "tool", content: "3", tool_call_id: "call_second" });
      }
    } else {
      deltas = [{ content: "17 加 25 等于 42。" }];
      reason = mode === "length" ? "length" : mode === "content_filter" ? "content_filter" :
        mode === "no_tools" ? "tool_calls" : "stop";
    }
  }
  let data = "";
  for (const delta of deltas) {
    data += "data: " + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + "\\n\\n";
  }
  data += "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] }) +
    "\\n\\ndata: [DONE]\\n\\n";
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
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
        models: [
          {
            id: "gpt-6.1-sol",
            name: "gpt-6.1-sol",
            input: ["text", "image"],
            contextWindow: 1000000,
            maxTokens: 500000,
          },
        ],
      },
      {
        name: "lcn29",
        api: "openai-completions",
        baseUrl: "https://example.invalid/v1",
        apiKey: "${API_KEY}",
        models: [
          {
            id: "gemini-3.8-flash-high",
            name: "gemini-3.8-flash-high",
            input: ["text", "image"],
            contextWindow: 1000000,
          },
          {
            id: "gpt-6.1-sol",
            name: "gpt-6.1-sol",
            input: ["text", "image"],
            contextWindow: 1000000,
            maxTokens: 500000,
          },
        ],
      },
    ],
  });
  writeFileSync(configPath, config);
  writeFileSync(join(cwd, ".env"), 'API_KEY="test-api-key"');
  /**
   * 在独立进程中运行统一入口，所有请求均由模拟 fetch 处理。
   * @param mode - 模拟正常回复、阶段失败或工具调用边界的场景名称。
   * @returns 入口进程的退出状态及标准输出、错误输出。
   */
  function run(mode: string = "stop"): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, ["--import", mockPath, fileURLToPath(mainUrl)], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, MOCK_MODE: mode },
    });
  }
  const expectedOutput =
    "流式增量\n" +
    "Completion回复： [ { type: 'text', text: '完整回复' } ]\n" +
    "Steam回复: [ { type: 'text', text: '流式增量' } ]\n" +
    "图片识别： [ { type: 'text', text: '图片识别回复' } ]\n" +
    "工具调用： [ { type: 'text', text: '17 加 25 等于 42。' } ]\n";
  for (const mode of [
    "stop",
    "length",
    "tool_length",
    "converted",
    "multiple_tools",
    "fourth_final",
    "no_tools",
  ]) {
    const result = run(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expectedOutput);
    assert.equal(result.stderr, "");
  }
  for (const [mode, message] of [
    ["stream_error", /Error: Connection error\./u],
    ["complete_error", /Error: Connection error\./u],
    ["image_error", /Error: Connection error\./u],
    ["content_filter", /Error: Provider finish_reason: content_filter/u],
    ["validation_error", /Validation failed for tool "add":/u],
    ["unknown_tool", /Tool "subtract" not found/u],
    ["limit", /示例达到四轮上限；请检查调用记录/u],
  ] as const) {
    const result = run(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, mode === "stream_error" ? "\n" : "流式增量\n");
    assert.match(result.stderr, message);
  }
  const invalidImage = run("png_error");
  assert.equal(invalidImage.error, undefined);
  assert.equal(invalidImage.status, 1);
  assert.equal(invalidImage.stdout, "");
  assert.match(invalidImage.stderr, /指定图片的内容不是 PNG 格式。/u);

  const unreadableImage = run("image_read_error");
  assert.equal(unreadableImage.error, undefined);
  assert.equal(unreadableImage.status, 1);
  assert.equal(unreadableImage.stdout, "");
  assert.match(unreadableImage.stderr, /模拟图片读取失败/u);

  writeFileSync(configPath, config.replaceAll('["text","image"]', '["text"]'));
  const unsupported = run("image_unsupported");
  assert.equal(unsupported.error, undefined);
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.stdout, "流式增量\n");
  assert.match(unsupported.stderr, /所选模型未声明支持图片输入。/u);

  for (const invalid of [
    config.replace('"provider":"lcn29"', '"provider":"LCN29"'),
    config.replace('"model":"gpt-6.1-sol"', '"model":"未配置模型"'),
    config.replace('"apiKey":"${API_KEY}"', '"apiKey":""'),
    config.replace('"apiKey":"${API_KEY}"', '"apiKey":"${未配置密钥}"'),
    config.replace('"name":"lcn29"', '"name":123'),
    config.replace('"contextWindow":1000000', '"contextWindow":0'),
    config.replace('"name":"gpt-6.1-sol",', ""),
    config.replace('["text","image"]', '["audio"]'),
    'model = "未闭合',
  ]) {
    writeFileSync(configPath, invalid);
    const result = run("config_error");
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。\n",
    );
  }
  rmSync(configPath);
  const missingConfig = run("config_error");
  assert.equal(missingConfig.error, undefined);
  assert.equal(missingConfig.status, 1);
  assert.equal(missingConfig.stdout, "");
  assert.equal(
    missingConfig.stderr,
    "模型配置加载或校验失败，请检查 setting.json、同目录 .env 及模型选择配置。\n",
  );
});

/**
 * 验证其他三种协议在统一入口中的分发、认证、图片输入和生成预算。
 * @param t - 提供临时目录清理的测试上下文。
 * @throws 请求协议、认证、预算或四项功能的输出不符时抛出断言错误。
 * @remarks 每次独立进程均模拟图片和全部 fetch，工具阶段返回不含工具调用的正常终态。
 */
test("统一入口按配置调用 Anthropic、Responses 和 Google 协议", (t: TestContext): void => {
  const prefix = join(tmpdir(), "lcn-main-protocols-");
  const cwd = mkdtempSync(prefix);
  /**
   * 删除协议测试的临时配置和请求模拟文件。
   * @throws 临时目录删除失败时抛出异常。
   */
  t.after((): void => rmSync(cwd, { recursive: true, force: true }));
  const mockPath = join(cwd, "protocols.mjs");
  writeFileSync(
    mockPath,
    `
import assert from "node:assert/strict";
${imageReadMock}
const api = process.env.MOCK_API;
let requests = 0;
/**
 * 验证统一入口在所选协议上完成四次请求。
 * @throws 实际请求次数不符时抛出断言错误。
 */
process.on("exit", () => {
  assert.equal(requests, 4);
});
/**
 * 核对指定协议的认证、输入及生成预算，并返回正常结束的 SSE。
 * @param input - SDK 请求对象或地址。
 * @param init - 可选的认证及序列化请求选项。
 * @returns 不访问网络的协议响应。
 * @throws 地址、认证、图片数据、工具声明或预算不符时抛出断言错误。
 */
globalThis.fetch = async (input, init) => {
  requests++;
  const request = new Request(input, init);
  const body = await request.json();
  const prompts = ["请用一句话介绍你自己。", "请用一句话解释什么是人工智能。",
    "请描述这张图片中的内容，并识别可见文字。", "请调用 add 计算 17 加 25。"];
  const prompt = prompts[requests - 1];
  const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  let events;
  if (api === "anthropic-messages") {
    assert.equal(request.url, "https://example.invalid/v1/messages?beta=true");
    assert.equal(request.headers.get("x-api-key"), "test-api-key");
    assert.equal(body.model, "gpt-6.1-sol");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, Number(process.env.EXPECTED_MAX_TOKENS));
    assert.deepEqual(body.messages, [{ role: "user", content: requests === 3 ? [
      { type: "text", text: prompt },
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
    ] : prompt }]);
    if (requests === 4) {
      assert.equal(body.tools[0].name, "add");
    } else {
      assert.equal(Object.hasOwn(body, "tools"), false);
    }
    events = [
      { type: "message_start", message: { content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "协议选择正确" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
  } else if (api === "openai-responses") {
    assert.equal(request.url, "https://example.invalid/v1/responses");
    assert.equal(request.headers.get("authorization"), "Bearer test-api-key");
    assert.equal(body.model, "gpt-6.1-sol");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(Object.hasOwn(body, "max_output_tokens"), false);
    const content = [{ type: "input_text", text: prompt }];
    if (requests === 3) {
      content.push({ type: "input_image", image_url: "data:image/png;base64," + base64,
        detail: "auto" });
    }
    assert.deepEqual(body.input, [{ role: "user", content }]);
    if (requests === 4) {
      assert.equal(body.tools[0].name, "add");
      assert.equal(body.tools[0].strict, false);
    } else {
      assert.equal(Object.hasOwn(body, "tools"), false);
    }
    events = [{ type: "response.completed", response: { status: "completed" } }];
  } else {
    assert.equal(api, "google-generative-ai");
    assert.equal(request.url,
      "https://example.invalid/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse");
    assert.equal(request.headers.get("x-goog-api-key"), "test-api-key");
    assert.deepEqual(body.generationConfig, {});
    const parts = [{ text: prompt }];
    if (requests === 3) {
      parts.push({ inlineData: { mimeType: "image/png", data: base64 } });
    }
    assert.deepEqual(body.contents, [{ role: "user", parts }]);
    if (requests === 4) {
      assert.equal(body.tools[0].functionDeclarations[0].name, "add");
    } else {
      assert.equal(Object.hasOwn(body, "tools"), false);
    }
    return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\\n\\n', {
      headers: { "content-type": "text/event-stream" },
    });
  }
  let data = "";
  for (const event of events) {
    if (api === "anthropic-messages") {
      data += "event: " + event.type + "\\n";
    }
    data += "data: " + JSON.stringify(event) + "\\n\\n";
  }
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
};
`,
  );
  for (const api of ["anthropic-messages", "openai-responses", "google-generative-ai"]) {
    for (const maxTokens of api === "anthropic-messages" ? [1234, undefined] : [undefined]) {
      const model = api === "google-generative-ai" ? "gemini-3.8-flash-high" : "gpt-6.1-sol";
      const config = {
        provider: "服务商",
        model,
        modelProviders: [
          {
            name: "服务商",
            api,
            baseUrl:
              api === "openai-responses" ? "https://example.invalid/v1" : "https://example.invalid",
            apiKey: "test-api-key",
            models: [
              {
                id: model,
                name: model,
                input: ["text", "image"],
                contextWindow: 1000000,
                maxTokens,
              },
            ],
          },
        ],
      };
      writeFileSync(join(cwd, "setting.json"), JSON.stringify(config));
      const result = spawnSync(process.execPath, ["--import", mockPath, fileURLToPath(mainUrl)], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          MOCK_API: api,
          MOCK_MODE: "stop",
          EXPECTED_MAX_TOKENS: String(maxTokens ?? 16384),
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const content =
        api === "anthropic-messages" ? "[ { type: 'text', text: '协议选择正确' } ]" : "[]";
      const streamOutput = api === "anthropic-messages" ? "协议选择正确\n" : "\n";
      assert.equal(
        result.stdout,
        streamOutput +
          `Completion回复： ${content}\nSteam回复: ${content}\n图片识别： ${content}\n工具调用： ${content}\n`,
      );
    }
  }
});
