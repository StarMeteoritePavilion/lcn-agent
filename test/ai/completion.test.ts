import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { stream as streamCompletion } from "../../src/ai/api/openai-completions.ts";
import { completion } from "../../src/ai/index.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "../../src/ai/types.ts";
import type { AssistantMessageEventStream } from "../../src/ai/utils/event-stream.ts";

/**
 * 验证运行时类型错误、非有限数值及越界生成参数被请求边界拒绝。
 * @returns Promise 完成表示全部无效输入均未触发网络请求。
 * @throws 事件、最终错误或请求次数不符时抛出断言错误。
 */

test("无效生成参数通过错误事件结束且不发送请求", async (): Promise<void> => {
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
      const stream = streamCompletion(model, { messages: [] }, options);
      const events = await collect(stream);
      const result = await stream.result();
      assert.equal(requests, 0);
      assert.equal(result.stopReason, "error");
      assert.ok(result.errorMessage?.includes(field));
      assert.deepEqual(events, [{ type: "error", reason: "error", error: result }]);
    }
  }
});

/**
 * 验证最小正整数令牌上限和温度区间两端及小数可正常发送。
 * @returns Promise 完成表示合法参数与正常结束结果均已验证。
 * @throws 请求参数、请求次数或最终状态不符时抛出断言错误。
 */

test("合法生成参数边界保持原值传递", async (): Promise<void> => {
  for (const temperature of [0, 0.8, 2]) {
    let requests = 0;
    const stream = streamCompletion(
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
 * 验证读取响应途中失败时保留累计内容、清理工具内部字段并完成错误结果。
 * @returns Promise 完成表示读取异常的事件与最终消息均已验证。
 * @throws 累计内容、事件或内部字段清理不符时抛出断言错误。
 */
test("响应读取失败保留工具参数并清理内部拼接字段", async (): Promise<void> => {
  const chunk = {
    choices: [
      {
        delta: {
          content: "已生成文本",
          tool_calls: [
            { index: 0, id: "call_add", function: { name: "add", arguments: '{"a":17' } },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
  let sent = false;
  const stream = streamCompletion(
    model,
    { messages: [] },
    {
      apiKey: "test-api-key",
      /**
       * 返回收到首个分片后读取失败的模拟响应。
       * @returns Promise 完成后返回随后读取报错的响应。
       */
      fetch: async (): Promise<Response> =>
        new Response(
          new ReadableStream<Uint8Array>({
            /**
             * 首次读取提供文本和工具参数，随后让响应读取失败。
             * @param controller - 提供分片入队及读取异常的响应流控制器。
             */
            pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
              if (sent) {
                controller.error(new Error("模拟响应读取失败"));
                return;
              }
              sent = true;
              controller.enqueue(bytes);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    },
  );
  const events = await collect(stream);
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "模拟响应读取失败");
  assert.deepEqual(result.content, [
    { type: "text", text: "已生成文本" },
    { type: "toolCall", id: "call_add", name: "add", arguments: { a: 17 } },
  ]);
  const types: AssistantMessageEvent["type"][] = [];
  for (const event of events) {
    types.push(event.type);
  }
  assert.deepEqual(types, [
    "start",
    "text_start",
    "text_delta",
    "toolcall_start",
    "toolcall_delta",
    "error",
  ]);
  assert.deepEqual(events[events.length - 1], { type: "error", reason: "error", error: result });
});

/**
 * 验证补全包装接口无需消费事件即可获得完整消息。
 * @returns Promise 完成表示公开接口的返回类型和最终消息均已验证。
 * @throws 返回值或消息内容不符时抛出断言错误。
 */

test("completion 返回 Promise 并直接完成最终助手消息", async (): Promise<void> => {
  const pending = completion(
    model,
    { messages: [] },
    {
      apiKey: "test-api-key",
      /**
       * 返回连续文本分片和正常结束原因。
       * @returns Promise 完成后返回模拟响应。
       */
      fetch: async (): Promise<Response> =>
        response([
          { choices: [{ delta: { content: "第一段" }, finish_reason: null }] },
          { choices: [{ delta: { content: "第二段" }, finish_reason: "stop" }] },
        ]),
    },
  );
  assert.ok(pending instanceof Promise);
  const result = await pending;
  assert.deepEqual(result.content, [{ type: "text", text: "第一段第二段" }]);
  assert.equal(result.stopReason, "stop");
  assert.equal(result.rawStopReason, "stop");
});

/**
 * 验证文本与两个工具调用交错时保持内容索引、参数及事件顺序。
 * @returns Promise 完成表示工具合并、结束事件及临时字段清理均已验证。
 * @throws 内容、事件或引用不符时抛出断言错误。
 */

test("交错工具分片按索引和标识合并参数并发送工具结束事件", async (): Promise<void> => {
  const stream = streamCompletion(
    model,
    { messages: [] },
    {
      apiKey: "test-api-key",
      /**
       * 返回工具调用缺省字段、后补标识及交错参数增量。
       * @returns Promise 完成后返回模拟响应。
       */
      fetch: async (): Promise<Response> =>
        response([
          { choices: [{ delta: { content: "调用工具" }, finish_reason: null }] },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 1, id: "call-second", function: { name: "add", arguments: '{"a":3' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-first", function: { name: "add", arguments: '17,"b":' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content: "完成",
                  tool_calls: [{ id: "call-second", function: { arguments: ',"b":4}' } }],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: "25}" } }] },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 1 }] }, finish_reason: "tool_calls" }] },
        ]),
    },
  );
  const events = await collect(stream);
  const result = await stream.result();
  const first = { type: "toolCall", id: "call-first", name: "add", arguments: { a: 17, b: 25 } };
  const second = { type: "toolCall", id: "call-second", name: "add", arguments: { a: 3, b: 4 } };
  assert.deepEqual(result.content, [{ type: "text", text: "调用工具完成" }, first, second]);
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.rawStopReason, "tool_calls");
  assert.deepEqual(events, [
    { type: "start", partial: result },
    { type: "text_start", contentIndex: 0, partial: result },
    { type: "text_delta", contentIndex: 0, delta: "调用工具", partial: result },
    { type: "toolcall_start", contentIndex: 1, partial: result },
    { type: "toolcall_delta", contentIndex: 1, delta: '{"a":', partial: result },
    { type: "toolcall_start", contentIndex: 2, partial: result },
    { type: "toolcall_delta", contentIndex: 2, delta: '{"a":3', partial: result },
    { type: "toolcall_delta", contentIndex: 1, delta: '17,"b":', partial: result },
    { type: "text_delta", contentIndex: 0, delta: "完成", partial: result },
    { type: "toolcall_delta", contentIndex: 2, delta: ',"b":4}', partial: result },
    { type: "toolcall_delta", contentIndex: 1, delta: "25}", partial: result },
    { type: "toolcall_delta", contentIndex: 2, delta: "", partial: result },
    { type: "text_end", contentIndex: 0, content: "调用工具完成", partial: result },
    { type: "toolcall_end", contentIndex: 1, toolCall: first, partial: result },
    { type: "toolcall_end", contentIndex: 2, toolCall: second, partial: result },
    { type: "done", reason: "toolUse", message: result },
  ]);
  for (const event of events) {
    if (event.type === "toolcall_end") {
      assert.equal(event.toolCall, result.content[event.contentIndex]);
      assert.equal(event.partial, result);
    }
  }
});

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

/**
 * 验证流式接口实际发出的请求、工具定义及历史转换结果。
 * @returns Promise 完成表示模拟请求和最终结果均已验证。
 * @throws 请求次数、最终状态或上下文不符时抛出断言错误。
 */

test("请求传递模型、认证、生成选项并按规则转换历史，不修改上下文", async (): Promise<void> => {
  const context: Context = {
    systemPrompt: "系统提示",
    tools: [
      {
        name: "add",
        description: "计算两个数字之和",
        parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
      },
    ],
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
      {
        ...history(["调用说明"]),
        content: [
          { type: "text", text: "调用说明" },
          { type: "toolCall", id: "call-add", name: "add", arguments: { a: 17, b: 25 } },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-add",
        toolName: "add",
        content: [
          { type: "text", text: "42" },
          { type: "text", text: "计算完成" },
        ],
        isError: false,
        timestamp: 5,
      },
      {
        ...history([]),
        content: [{ type: "toolCall", id: "call-empty", name: "add", arguments: {} }],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call-empty",
        toolName: "add",
        content: [],
        isError: true,
        timestamp: 6,
      },
    ],
  };
  const original = structuredClone(context);
  let requests = 0;
  const stream = streamCompletion(model, context, {
    apiKey: "test-api-key",
    maxTokens: 123,
    temperature: 0,
    toolChoice: "required",
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
          {
            role: "assistant",
            content: "调用说明",
            tool_calls: [
              {
                id: "call-add",
                type: "function",
                function: { name: "add", arguments: '{"a":17,"b":25}' },
              },
            ],
          },
          { role: "tool", content: "42\n计算完成", tool_call_id: "call-add" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call-empty", type: "function", function: { name: "add", arguments: "{}" } },
            ],
          },
          { role: "tool", content: "(no tool output)", tool_call_id: "call-empty" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "add",
              description: "计算两个数字之和",
              parameters: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
            },
          },
        ],
        tool_choice: "required",
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

/**
 * 验证省略参数和零值的请求语义。
 * @returns Promise 完成表示两组请求均已验证。
 * @throws 最终状态不符时抛出断言错误。
 */

test("省略生成选项及传入零上限时不使用模型默认上限，空系统提示不发送", async (): Promise<void> => {
  for (const maxTokens of [undefined, 0]) {
    const stream = streamCompletion(
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

/**
 * 验证空分片忽略、文本累积、事件顺序和消息引用。
 * @returns Promise 完成表示事件流和最终消息均已验证。
 * @throws 事件顺序、消息内容或引用不符时抛出断言错误。
 */

test("文本分片按顺序发送事件并共享最终消息引用和来源元数据", async (): Promise<void> => {
  const before = Date.now();
  const stream = streamCompletion(
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

for (const reason of ["stop", "end", "length", "tool_calls", "function_call"]) {
  /**
   * 验证无文本响应的结束原因映射，不创建空文本块。
   * @returns Promise 完成表示结束事件及最终结果均已验证。
   * @throws 结束状态、原始原因或事件不符时抛出断言错误。
   */
  test(`结束原因 ${reason} 返回正常完成事件并保留原值`, async (): Promise<void> => {
    const stream = streamCompletion(
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
    const expected =
      reason === "length"
        ? "length"
        : reason === "tool_calls" || reason === "function_call"
          ? "toolUse"
          : "stop";
    assert.equal(result.stopReason, expected);
    assert.equal(result.rawStopReason, reason);
    assert.deepEqual(result.content, []);
    assert.deepEqual(events, [
      { type: "start", partial: result },
      { type: "done", reason: expected, message: result },
    ]);
  });
}

/**
 * 验证密钥校验失败不会访问网络或拒绝最终结果 Promise。
 * @returns Promise 完成表示两种无效密钥及省略选项均已验证。
 * @throws 错误说明、事件或请求次数不符时抛出断言错误。
 */

test("缺失或空密钥通过错误事件完成结果且不发送请求", async (): Promise<void> => {
  for (const apiKey of [undefined, ""]) {
    let requests = 0;
    const stream = streamCompletion(
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
  assert.ok(omitted instanceof Promise);
  const omittedResult = await omitted;
  assert.equal(omittedResult.stopReason, "error");
  assert.equal(omittedResult.errorMessage, "No API key for provider: 测试服务商");
});

for (const failure of ["network", "http"]) {
  /**
   * 验证网络异常和可重试 HTTP 状态都只发起一次请求。
   * @returns Promise 完成表示错误事件和请求次数均已验证。
   * @throws 错误状态、事件或请求次数不符时抛出断言错误。
   */
  test(`请求失败 ${failure} 仅发送错误事件且不自动重试`, async (): Promise<void> => {
    let requests = 0;
    const stream = streamCompletion(
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

for (const reason of [null, "content_filter", "network_error", "未知原因"]) {
  /**
   * 验证缺失和错误结束原因在文本结束事件之后报告错误。
   * @returns Promise 完成表示文本、事件顺序和错误说明均已验证。
   * @throws 文本、事件或错误说明不符时抛出断言错误。
   */
  test(`结束原因 ${reason ?? "缺失"} 返回错误并保留已输出文本`, async (): Promise<void> => {
    const stream = streamCompletion(
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
