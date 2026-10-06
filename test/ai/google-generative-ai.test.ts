import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Type } from "typebox";
import { stream } from "../../src/ai/api/google-generative-ai.ts";
import { stream as streamModel } from "../../src/ai/index.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "../../src/ai/types.ts";

/** 回放 SDK 实际读取的响应字段，允许省略其他协议字段。 */
type MockChunk = { [key: string]: unknown };

const model: Model<"google-generative-ai"> = {
  api: "google-generative-ai",
  provider: "测试服务商",
  id: "gemini-3.8-flash-high",
  baseUrl: "https://example.invalid",
  name: "测试模型",
  input: ["text", "image"],
  contextWindow: 1000000,
  headers: {
    "X-Test-Override": "model-value",
    "X-Test-Keep": "keep-value",
    "X-Test-Remove": "remove-value",
  },
  maxTokens: 999,
};

/**
 * 验证 Google 请求参数、首项文本和工具事件、结束原因及错误处理。
 * @param t - 提供全局 fetch 恢复的测试上下文。
 * @returns Promise 完成表示所有模拟场景均已验证。
 * @throws 请求参数、事件、内容或结束状态不符时抛出断言错误。
 * @remarks 仅在本测试内替换全局 fetch，不访问真实模型服务。
 */
test("Google 请求与响应事件保持现有行为", async (t: TestContext): Promise<void> => {
  const originalFetch = globalThis.fetch;
  /** 恢复测试前的全局网络请求实现。 */
  t.after((): void => {
    globalThis.fetch = originalFetch;
  });
  const cases: {
    name: string;
    chunks: MockChunk[];
    reason: AssistantMessage["stopReason"];
    content: AssistantMessage["content"];
    types: AssistantMessageEvent["type"][];
    error?: string;
    noKey?: boolean;
    customFetch?: boolean;
  }[] = [
    {
      name: "文本与思考签名",
      chunks: [
        {
          responseId: "resp_first",
          candidates: [
            {
              content: {
                parts: [
                  { text: "隐藏思考", thought: true },
                  { text: "你", thoughtSignature: "c2ln" },
                ],
              },
            },
            { content: { parts: [{ text: "忽略次项" }] } },
          ],
        },
        {
          responseId: "resp_second",
          candidates: [{ content: { parts: [{ text: "好" }] }, finishReason: "STOP" }],
        },
      ],
      reason: "stop",
      content: [{ type: "text", text: "你好", textSignature: "c2ln" }],
      types: ["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
    },
    {
      name: "文本和工具交替",
      chunks: [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: "前" },
                  {
                    functionCall: { id: "call_example", name: "add", args: { a: 2, b: 3 } },
                    thoughtSignature: "c2ln",
                  },
                  { text: "后" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ],
      reason: "toolUse",
      content: [
        { type: "text", text: "前", textSignature: undefined },
        {
          type: "toolCall",
          id: "call_example",
          name: "add",
          arguments: { a: 2, b: 3 },
          thoughtSignature: "c2ln",
        },
        { type: "text", text: "后", textSignature: undefined },
      ],
      types: [
        "start",
        "text_start",
        "text_delta",
        "text_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ],
    },
    {
      name: "令牌截断",
      chunks: [
        {
          candidates: [{ content: { parts: [{ text: "截断文本" }] }, finishReason: "MAX_TOKENS" }],
        },
      ],
      reason: "length",
      content: [{ type: "text", text: "截断文本", textSignature: undefined }],
      types: ["start", "text_start", "text_delta", "text_end", "done"],
    },
    {
      name: "空内容完成",
      chunks: [{ candidates: [{ finishReason: "STOP" }] }],
      reason: "stop",
      content: [],
      types: ["start", "done"],
    },
    {
      name: "继续状态",
      chunks: [{ candidates: [{ finishReason: "CONTINUATION" }] }],
      reason: "stop",
      content: [],
      types: ["start", "done"],
    },
    {
      name: "安全过滤",
      chunks: [{ candidates: [{ finishReason: "SAFETY" }] }],
      reason: "error",
      content: [],
      types: ["start", "error"],
      error: "Provider stopped with: SAFETY",
    },
    {
      name: "缺少结束原因",
      chunks: [{ candidates: [{ content: { parts: [{ text: "保留文本" }] } }] }],
      reason: "error",
      content: [{ type: "text", text: "保留文本", textSignature: undefined }],
      types: ["start", "text_start", "text_delta", "text_end", "error"],
      error: "Google stream ended without a finish reason",
    },
    {
      name: "缺少密钥",
      chunks: [],
      noKey: true,
      reason: "error",
      content: [],
      types: ["error"],
      error: "No API key for provider: 测试服务商",
    },
    {
      name: "自定义 fetch",
      chunks: [],
      customFetch: true,
      reason: "error",
      content: [],
      types: ["error"],
      error: "Custom fetch is not supported by the Google Generative AI adapter",
    },
  ];
  for (const scenario of cases) {
    let requests = 0;
    /**
     * 核对 SDK 生成的请求并回放本地 SSE 响应。
     * @param input - SDK 传入的请求对象或地址。
     * @param init - 可选的请求初始化参数。
     * @returns Promise 完成后返回模拟响应。
     * @throws 请求地址、认证或参数不符时抛出断言错误。
     */
    globalThis.fetch = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      requests++;
      const request = new Request(input, init);
      assert.equal(
        request.url,
        "https://example.invalid/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse",
      );
      assert.equal(request.headers.get("x-goog-api-key"), "test-api-key");
      assert.equal(request.headers.get("x-test-override"), "request-value");
      assert.equal(request.headers.get("x-test-keep"), "keep-value");
      assert.equal(request.headers.has("x-test-remove"), false);
      const body = await request.json();
      assert.deepEqual(body, {
        contents: [{ role: "user", parts: [{ text: "测试" }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 0 },
        systemInstruction: { parts: [{ text: "中文回答" }], role: "user" },
      });
      let data = "";
      for (const chunk of scenario.chunks) {
        data += `data: ${JSON.stringify(chunk)}\n\n`;
      }
      return new Response(data, { headers: { "content-type": "text/event-stream" } });
    };
    /**
     * 提供与全局 fetch 不同的实现，以验证接口限制。
     * @returns Promise 完成后返回空响应；正常测试不会执行到这里。
     */
    const customFetch = async (): Promise<Response> => new Response();
    const eventStream = stream(
      model,
      { systemPrompt: "中文回答", messages: [{ role: "user", content: "测试", timestamp: 0 }] },
      {
        apiKey: scenario.noKey ? undefined : "test-api-key",
        maxTokens: 0,
        temperature: 0,
        toolChoice: "none",
        headers: { "x-test-override": "request-value", "x-test-remove": null },
        fetch: scenario.customFetch ? customFetch : globalThis.fetch,
      },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of eventStream) {
      events.push(event);
    }
    const result = await eventStream.result();
    assert.equal(requests, scenario.noKey || scenario.customFetch ? 0 : 1, scenario.name);
    assert.equal(result.stopReason, scenario.reason, result.errorMessage);
    assert.equal(result.errorMessage, scenario.error, scenario.name);
    assert.deepEqual(result.content, scenario.content, scenario.name);
    const types: AssistantMessageEvent["type"][] = [];
    for (const event of events) {
      types.push(event.type);
      if ("partial" in event) {
        assert.equal(event.partial, result);
      }
    }
    assert.deepEqual(types, scenario.types, scenario.name);
    if (scenario.name === "文本与思考签名") {
      assert.equal(result.responseId, "resp_first");
    }
  }
});

/**
 * 验证无效生成参数和工具选择在网络请求前被拒绝。
 * @param t - 提供全局 fetch 恢复的测试上下文。
 * @returns Promise 完成表示全部无效输入均通过错误事件结束，且未发送请求。
 * @throws 请求次数、错误信息或终结事件不符时抛出断言错误。
 * @remarks 临时替换全局 fetch，仅返回本地响应，不访问模型服务。
 */
test("Google 无效生成参数和工具选择在请求前被拒绝", async (t: TestContext): Promise<void> => {
  const originalFetch = globalThis.fetch;
  /** 恢复测试前的全局网络请求实现。 */
  t.after((): void => {
    globalThis.fetch = originalFetch;
  });
  let requests = 0;
  /**
   * 记录不应发生的请求并提供正常结束响应。
   * @returns Promise 完成后返回正常完成的模拟 SSE 响应。
   */
  globalThis.fetch = async (): Promise<Response> => {
    requests++;
    return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const cases: { field: string; values: unknown[]; message: string }[] = [
    {
      field: "maxTokens",
      values: [-1, 1.5, NaN, Infinity, -Infinity, "1", null, true, {}],
      message: "maxTokens 必须是非负有限整数。",
    },
    {
      field: "temperature",
      values: [-0.1, 2.1, NaN, Infinity, -Infinity, "1", null, true, {}],
      message: "temperature 必须是 0 到 2 之间的有限数值。",
    },
    {
      field: "toolChoice",
      values: ["AUTO", "未知选项", "", null, true, {}, []],
      message: "toolChoice 必须是 auto、none 或 any。",
    },
  ];
  for (const scenario of cases) {
    for (const value of scenario.values) {
      const options = { apiKey: "test-api-key" };
      Object.assign(options, { [scenario.field]: value });
      const eventStream = stream(model, { messages: [] }, options);
      const events: AssistantMessageEvent[] = [];
      for await (const event of eventStream) {
        events.push(event);
      }
      const result = await eventStream.result();
      assert.equal(requests, 0, scenario.field);
      assert.equal(result.stopReason, "error");
      assert.equal(result.errorMessage, scenario.message);
      assert.deepEqual(events, [{ type: "error", reason: "error", error: result }]);
    }
  }
});

/**
 * 验证 stream 分发 Google 请求，历史回传只复用同来源有效签名并合并工具结果。
 * @param t - 提供全局 fetch 恢复的测试上下文。
 * @returns Promise 完成表示历史、工具声明、缺省生成选项及上下文不变均已验证。
 * @throws 请求字段、消息转换或原始上下文不符时抛出断言错误。
 * @remarks 临时替换全局 fetch，使用 SDK 的本地请求序列化，不访问模型服务。
 */
test("Google 历史转换保留工具签名与调用关联并合并结果", async (t: TestContext): Promise<void> => {
  const originalFetch = globalThis.fetch;
  /** 恢复测试前的全局网络请求实现。 */
  t.after((): void => {
    globalThis.fetch = originalFetch;
  });
  const context: Context = {
    tools: [
      {
        name: "add",
        description: "计算两个数字之和",
        parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
      },
    ],
    messages: [
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "toolUse",
        timestamp: 0,
        content: [
          { type: "text", text: "", textSignature: "c2ln" },
          { type: "text", text: " " },
          { type: "text", text: "无效签名", textSignature: "invalid" },
          {
            type: "toolCall",
            id: "call_example",
            name: "add",
            arguments: { a: 17, b: 25 },
            thoughtSignature: "c2ln",
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_example",
        toolName: "add",
        content: [{ type: "text", text: "42" }],
        isError: false,
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call_error",
        toolName: "add",
        content: [{ type: "text", text: "工具错误" }],
        isError: true,
        timestamp: 0,
      },
      {
        role: "assistant",
        api: model.api,
        provider: "其他服务商",
        model: model.id,
        stopReason: "stop",
        timestamp: 0,
        content: [{ type: "text", text: "跨供应商文本", textSignature: "c2ln" }],
      },
    ],
  };
  const original = structuredClone(context);
  let requests = 0;
  /**
   * 核对 SDK 请求中的历史签名、工具结果及工具参数结构。
   * @param input - SDK 传入的请求对象或地址。
   * @param init - 可选的请求初始化参数。
   * @returns Promise 完成后返回空内容完成响应。
   * @throws 请求地址、历史或工具声明不符时抛出断言错误。
   */
  globalThis.fetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    requests++;
    const request = new Request(input, init);
    assert.equal(
      request.url,
      "https://example.invalid/models/gemini-3.8-flash-high:streamGenerateContent?alt=sse",
    );
    const body: unknown = await request.json();
    assert.deepEqual(body, {
      generationConfig: {},
      contents: [
        {
          role: "model",
          parts: [
            { text: "", thoughtSignature: "c2ln" },
            { text: "无效签名" },
            {
              functionCall: { id: "call_example", name: "add", args: { a: 17, b: 25 } },
              thoughtSignature: "c2ln",
            },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { id: "call_example", name: "add", response: { output: "42" } } },
            {
              functionResponse: { id: "call_error", name: "add", response: { error: "工具错误" } },
            },
          ],
        },
        { role: "model", parts: [{ text: "跨供应商文本" }] },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "add",
              description: "计算两个数字之和",
              parametersJsonSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
            },
          ],
        },
      ],
    });
    return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const eventStream = streamModel(model, context, { apiKey: "test-api-key" });
  const result = await eventStream.result();
  assert.equal(requests, 1);
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(context, original);
});
