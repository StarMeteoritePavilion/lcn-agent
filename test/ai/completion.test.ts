import assert from "node:assert/strict";
import { test } from "node:test";
import { completion } from "../../src/ai/index.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "../../src/ai/types.ts";
import type { AssistantMessageEventStream } from "../../src/ai/utils/event-stream.ts";

test("无效生成参数通过错误事件结束且不发送请求" /**
 * 验证运行时类型错误、非有限数值及越界生成参数被请求边界拒绝。
 * @returns Promise 完成表示全部无效输入均未触发网络请求。
 * @throws 事件、最终错误或请求次数不符时抛出断言错误。
 */, async (): Promise<void> => {
  const cases: { field: "maxTokens" | "temperature"; values: unknown[] }[] = [
    { field: "maxTokens", values: [-1, 1.5, NaN, Infinity, -Infinity, "1", null, true, {}] },
    { field: "temperature", values: [-0.1, 2.1, NaN, Infinity, -Infinity, "1", null, true, {}] },
  ];
  for (const { field, values } of cases) {
    for (const value of values) {
      let requests = 0;
      const options = {
        apiKey: "test-api-key",
        /**
         * 记录不应发生的请求并提供正常结束响应。
         * @returns Promise 完成后返回模拟响应。
         */
        fetch: async (): Promise<Response> => {
          requests += 1;
          return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
        },
      };
      Object.assign(options, { [field]: value });
      const stream = completion(model, { messages: [] }, options);
      const events = await collect(stream);
      const result = await stream.result();
      assert.equal(requests, 0);
      assert.equal(result.stopReason, "error");
      assert.ok(result.errorMessage?.includes(field));
      assert.deepEqual(events, [{ type: "error", reason: "error", error: result }]);
    }
  }
});

test("合法生成参数边界保持原值传递" /**
 * 验证最小正整数令牌上限和温度区间两端及小数可正常发送。
 * @returns Promise 完成表示合法参数与正常结束结果均已验证。
 * @throws 请求参数、请求次数或最终状态不符时抛出断言错误。
 */, async (): Promise<void> => {
  for (const temperature of [0, 0.8, 2]) {
    let requests = 0;
    const stream = completion(
      model,
      { messages: [] },
      {
        apiKey: "test-api-key",
        maxTokens: 1,
        temperature,
        /**
         * 核对请求中的合法生成参数并返回正常结束响应。
         * @param _input - 客户端请求地址。
         * @param init - 包含序列化请求体的选项。
         * @returns Promise 完成后返回模拟响应。
         * @throws 请求参数不符时抛出断言错误。
         */
        fetch: async (
          _input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ): Promise<Response> => {
          requests += 1;
          const body: unknown = JSON.parse(String(init?.body));
          assert.deepEqual(body, {
            model: model.id,
            messages: [],
            stream: true,
            max_completion_tokens: 1,
            temperature,
          });
          return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
        },
      },
    );
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(requests, 1);
  }
});

const model: Model = {
  id: "测试模型",
  api: "openai-completions",
  provider: "测试服务商",
  baseUrl: "https://example.invalid/v1",
  maxTokens: 999,
};

/**
 * 将接口分片编码为可供 OpenAI 客户端读取的模拟响应。
 * @param chunks - 按发送顺序排列的响应分片，允许包含异常接口数据。
 * @returns 包含事件流响应头和结束标记的响应。
 */
function response(chunks: unknown[]): Response {
  let body = "";
  for (const chunk of chunks) {
    body += `data: ${JSON.stringify(chunk)}\n\n`;
  }
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * 收集助手事件流中的全部事件。
 * @param stream - 待消费的助手消息事件流。
 * @returns Promise 完成后返回按交付顺序排列的事件。
 */
async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/**
 * 构造带来源元数据的助手历史消息。
 * @param texts - 按原顺序保存的文本块内容。
 * @returns 用于验证历史消息转换的助手消息。
 */
function history(texts: string[]): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const text of texts) {
    content.push({ type: "text", text });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: "历史服务商",
    model: "历史模型",
    stopReason: "stop",
    timestamp: 1,
  };
}

test("请求传递模型、认证、生成选项并按规则转换历史，不修改上下文" /**
 * 验证公开补全接口实际发出的请求及历史转换结果。
 * @returns Promise 完成表示模拟请求和最终结果均已验证。
 */, async (): Promise<void> => {
  const context: Context = {
    systemPrompt: "系统提示",
    messages: [
      { role: "user", content: "用户输入", timestamp: 1 },
      { role: "user", content: "", timestamp: 2 },
      {
        role: "user",
        content: [
          { type: "text", text: "" },
          { type: "text", text: " " },
          { type: "text", text: "文本块" },
        ],
        timestamp: 3,
      },
      { role: "user", content: [{ type: "text", text: "" }], timestamp: 4 },
      history(["", " \n", " 前段 ", "后段"]),
      history(["", " \n"]),
    ],
  };
  const original = structuredClone(context);
  let requests = 0;
  const stream = completion(model, context, {
    apiKey: "test-api-key",
    maxTokens: 123,
    temperature: 0,
    /**
     * 核对请求地址、认证头和完整请求体并返回正常结束的响应。
     * @param input - 客户端请求地址或请求对象。
     * @param init - 客户端请求选项。
     * @returns Promise 完成后返回模拟响应。
     * @throws 请求内容不符时抛出断言错误。
     */
    fetch: async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      requests += 1;
      assert.equal(String(input), "https://example.invalid/v1/chat/completions");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-api-key");
      assert.equal(init?.method, "POST");
      assert.equal(typeof init?.body, "string");
      const body: unknown = JSON.parse(String(init?.body));
      assert.deepEqual(body, {
        model: "测试模型",
        stream: true,
        messages: [
          { role: "system", content: "系统提示" },
          { role: "user", content: "用户输入" },
          { role: "user", content: "" },
          {
            role: "user",
            content: [
              { type: "text", text: " " },
              { type: "text", text: "文本块" },
            ],
          },
          { role: "assistant", content: " 前段 后段" },
        ],
        max_completion_tokens: 123,
        temperature: 0,
      });
      return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(requests, 1);
  assert.deepEqual(context, original);
});

test("省略生成选项及传入零上限时不使用模型默认上限，空系统提示不发送" /**
 * 验证省略参数和零值的请求语义。
 * @returns Promise 完成表示两组请求均已验证。
 */, async (): Promise<void> => {
  for (const maxTokens of [undefined, 0]) {
    const stream = completion(
      model,
      { systemPrompt: "", messages: [] },
      {
        apiKey: "test-api-key",
        maxTokens,
        /**
         * 核对未设置上限和温度的请求体。
         * @param _input - 客户端请求地址。
         * @param init - 客户端请求选项。
         * @returns Promise 完成后返回正常结束的模拟响应。
         * @throws 请求体不符时抛出断言错误。
         */
        fetch: async (
          _input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ): Promise<Response> => {
          const body: unknown = JSON.parse(String(init?.body));
          assert.deepEqual(body, { model: "测试模型", messages: [], stream: true });
          return response([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
        },
      },
    );
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
  }
});

test("文本分片按顺序发送事件并共享最终消息引用和来源元数据" /**
 * 验证空分片忽略、文本累积、事件顺序和消息引用。
 * @returns Promise 完成表示事件流和最终消息均已验证。
 */, async (): Promise<void> => {
  const before = Date.now();
  const stream = completion(
    model,
    { messages: [] },
    {
      apiKey: "test-api-key",
      /**
       * 返回含空分片、多项选择及两次文本增量的模拟响应。
       * @param _input - 客户端请求地址。
       * @returns Promise 完成后返回模拟响应。
       */
      fetch: async (_input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> =>
        response([
          { choices: [] },
          { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
          {
            choices: [
              { delta: { content: "第一段" }, finish_reason: null },
              { delta: { content: "忽略第二项" }, finish_reason: "length" },
            ],
          },
          { choices: [{ delta: { content: "第二段" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]),
    },
  );
  const events = await collect(stream);
  const result = await stream.result();
  assert.deepEqual(result.content, [{ type: "text", text: "第一段第二段" }]);
  assert.equal(result.role, "assistant");
  assert.equal(result.api, model.api);
  assert.equal(result.provider, model.provider);
  assert.equal(result.model, model.id);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.rawStopReason, "stop");
  assert.equal(result.errorMessage, undefined);
  assert.ok(result.timestamp >= before && result.timestamp <= Date.now());
  assert.deepEqual(events, [
    { type: "start", partial: result },
    { type: "text_start", contentIndex: 0, partial: result },
    { type: "text_delta", contentIndex: 0, delta: "第一段", partial: result },
    { type: "text_delta", contentIndex: 0, delta: "第二段", partial: result },
    { type: "text_end", contentIndex: 0, content: "第一段第二段", partial: result },
    { type: "done", reason: "stop", message: result },
  ]);
  for (const event of events) {
    if ("partial" in event) {
      assert.equal(event.partial, result);
    }
    if (event.type === "done") {
      assert.equal(event.message, result);
    }
  }
  assert.equal(await stream.result(), result);
});

for (const reason of ["stop", "end", "length"]) {
  test(`结束原因 ${reason} 返回正常完成事件并保留原值` /**
   * 验证无文本响应的结束原因映射，不创建空文本块。
   * @returns Promise 完成表示结束事件及最终结果均已验证。
   */, async (): Promise<void> => {
    const stream = completion(
      model,
      { messages: [] },
      {
        apiKey: "test-api-key",
        /**
         * 返回仅包含结束原因的模拟响应。
         * @param _input - 客户端请求地址。
         * @returns Promise 完成后返回模拟响应。
         */
        fetch: async (_input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> =>
          response([{ choices: [{ delta: {}, finish_reason: reason }] }]),
      },
    );
    const events = await collect(stream);
    const result = await stream.result();
    const expected = reason === "length" ? "length" : "stop";
    assert.equal(result.stopReason, expected);
    assert.equal(result.rawStopReason, reason);
    assert.deepEqual(result.content, []);
    assert.deepEqual(events, [
      { type: "start", partial: result },
      { type: "done", reason: expected, message: result },
    ]);
  });
}

test("缺失或空密钥通过错误事件完成结果且不发送请求" /**
 * 验证密钥校验失败不会访问网络或拒绝最终结果 Promise。
 * @returns Promise 完成表示两种无效密钥均已验证。
 */, async (): Promise<void> => {
  for (const apiKey of [undefined, ""]) {
    let requests = 0;
    const stream = completion(
      model,
      { messages: [] },
      {
        apiKey,
        /**
         * 记录不应发生的请求。
         * @param _input - 客户端请求地址。
         * @returns Promise 完成后返回模拟响应。
         */
        fetch: async (_input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
          requests += 1;
          return response([]);
        },
      },
    );
    const events = await collect(stream);
    const result = await stream.result();
    assert.equal(requests, 0);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "No API key for provider: 测试服务商");
    assert.deepEqual(result.content, []);
    assert.deepEqual(events, [{ type: "error", reason: "error", error: result }]);
    assert.equal(events[0].type, "error");
    if (events[0].type === "error") {
      assert.equal(events[0].error, result);
    }
  }
  const omitted = completion(model, { messages: [] });
  assert.equal((await omitted.result()).stopReason, "error");
});

for (const failure of ["network", "http"]) {
  test(`请求失败 ${failure} 仅发送错误事件且不自动重试` /**
   * 验证网络异常和可重试 HTTP 状态都只发起一次请求。
   * @returns Promise 完成表示错误事件和请求次数均已验证。
   */, async (): Promise<void> => {
    let requests = 0;
    const stream = completion(
      model,
      { messages: [] },
      {
        apiKey: "test-api-key",
        /**
         * 记录请求并模拟网络异常或 HTTP 服务器错误。
         * @param _input - 客户端请求地址。
         * @returns Promise 完成后返回 HTTP 错误响应。
         * @throws 模拟网络失败时拒绝 Promise。
         */
        fetch: async (_input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
          requests += 1;
          if (failure === "network") {
            throw new Error("模拟网络失败");
          }
          return new Response(JSON.stringify({ error: { message: "模拟接口失败" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    const events = await collect(stream);
    const result = await stream.result();
    assert.equal(requests, 1);
    assert.equal(result.stopReason, "error");
    assert.ok(result.errorMessage);
    assert.deepEqual(result.content, []);
    assert.deepEqual(events, [{ type: "error", reason: "error", error: result }]);
  });
}

for (const reason of [
  null,
  "content_filter",
  "network_error",
  "tool_calls",
  "function_call",
  "未知原因",
]) {
  test(`结束原因 ${reason ?? "缺失"} 返回错误并保留已输出文本` /**
   * 验证缺失和错误结束原因在文本结束事件之后报告错误。
   * @returns Promise 完成表示文本、事件顺序和错误说明均已验证。
   */, async (): Promise<void> => {
    const stream = completion(
      model,
      { messages: [] },
      {
        apiKey: "test-api-key",
        /**
         * 返回已生成文本及待验证的结束原因。
         * @param _input - 客户端请求地址。
         * @returns Promise 完成后返回模拟响应。
         */
        fetch: async (_input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> =>
          response([
            { choices: [{ delta: { content: "保留文本" }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: reason }] },
          ]),
      },
    );
    const events = await collect(stream);
    const result = await stream.result();
    assert.equal(result.stopReason, "error");
    assert.equal(result.rawStopReason, reason ?? undefined);
    const expectedError =
      reason === null ? "Stream ended without finish_reason" : `Provider finish_reason: ${reason}`;
    assert.equal(result.errorMessage, expectedError);
    assert.deepEqual(result.content, [{ type: "text", text: "保留文本" }]);
    assert.deepEqual(events, [
      { type: "start", partial: result },
      { type: "text_start", contentIndex: 0, partial: result },
      { type: "text_delta", contentIndex: 0, delta: "保留文本", partial: result },
      { type: "text_end", contentIndex: 0, content: "保留文本", partial: result },
      { type: "error", reason: "error", error: result },
    ]);
    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    if (last.type === "error") {
      assert.equal(last.error, result);
    }
  });
}
