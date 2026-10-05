import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { stream } from "../../src/ai/api/anthropic-messages.ts";
import { completion } from "../../src/ai/index.ts";
import type { AssistantMessageEvent, Context, Model } from "../../src/ai/types.ts";

/** 用于模拟协议事件的测试数据，允许省略本模块不读取的字段。 */
type MockEvent = { type: string; [key: string]: unknown };

const model: Model<"anthropic-messages"> = {
  api: "anthropic-messages",
  provider: "测试服务商",
  id: "测试模型",
  baseUrl: "https://example.invalid",
  maxTokens: 999,
};

/**
 * 将模拟协议事件编码为命名 SSE 响应。
 * @param events - 按协议发送顺序排列的事件。
 * @returns 可由 Anthropic 事件解析器读取的响应。
 */
function response(events: MockEvent[]): Response {
  let body = "";
  for (const event of events) {
    body += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * 验证请求参数、内容事件顺序、结束原因及错误后的内部字段清理。
 * @returns Promise 完成表示所有模拟响应均保持预期行为。
 * @throws 请求、事件、内容或结束状态不符时抛出断言错误。
 */
test("Anthropic 请求和响应处理保持文本、工具与错误事件行为", async (): Promise<void> => {
  const textEvents: MockEvent[] = [
    { type: "message_start", message: { content: [], stop_reason: null } },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "你好" } },
    { type: "content_block_stop", index: 2 },
  ];
  const toolEvents: MockEvent[] = [
    { type: "message_start", message: { content: [], stop_reason: null } },
    {
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "toolu_example", name: "add", input: {} },
    },
    {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"a":2,' },
    },
    {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '"b":3}' },
    },
    { type: "content_block_stop", index: 3 },
  ];
  const cases: {
    name: string;
    events: MockEvent[];
    stopReason: "stop" | "length" | "toolUse" | "error";
    eventTypes: AssistantMessageEvent["type"][];
    rawStopReason?: string;
    errorMessage?: string;
    tool?: boolean;
  }[] = [
    {
      name: "正常结束",
      events: [
        ...textEvents,
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ],
      stopReason: "stop",
      rawStopReason: "end_turn",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "done"],
    },
    {
      name: "令牌截断",
      events: [
        ...textEvents,
        { type: "message_delta", delta: { stop_reason: "max_tokens" } },
        { type: "message_stop" },
      ],
      stopReason: "length",
      rawStopReason: "max_tokens",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "done"],
    },
    {
      name: "工具调用",
      events: [
        ...toolEvents,
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      ],
      stopReason: "toolUse",
      rawStopReason: "tool_use",
      eventTypes: [
        "start",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ],
      tool: true,
    },
    {
      name: "缺少结束原因",
      events: [...textEvents, { type: "message_stop" }],
      stopReason: "error",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "error"],
      errorMessage: "Anthropic stream ended without a stop reason",
    },
    {
      name: "缺少消息结束事件",
      events: [
        ...toolEvents.slice(0, -1),
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
      ],
      stopReason: "error",
      rawStopReason: "tool_use",
      eventTypes: ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "error"],
      errorMessage: "Anthropic stream ended before message_stop",
      tool: true,
    },
    {
      name: "模型拒绝",
      events: [
        ...textEvents,
        {
          type: "message_delta",
          delta: { stop_reason: "refusal", stop_details: { explanation: "模拟拒绝" } },
        },
        { type: "message_stop" },
      ],
      stopReason: "error",
      rawStopReason: "refusal",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "error"],
      errorMessage: "模拟拒绝",
    },
    {
      name: "拒绝详情省略",
      events: [
        ...textEvents,
        { type: "message_delta", delta: { stop_reason: "refusal" } },
        { type: "message_stop" },
      ],
      stopReason: "error",
      rawStopReason: "refusal",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "error"],
      errorMessage: "The model refused to complete the request",
    },
    {
      name: "暂停回合",
      events: [
        ...textEvents,
        { type: "message_delta", delta: { stop_reason: "pause_turn" } },
        { type: "message_stop" },
      ],
      stopReason: "stop",
      rawStopReason: "pause_turn",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "done"],
    },
    {
      name: "停止序列",
      events: [
        ...textEvents,
        { type: "message_delta", delta: { stop_reason: "stop_sequence" } },
        { type: "message_stop" },
      ],
      stopReason: "stop",
      rawStopReason: "stop_sequence",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "done"],
    },
    {
      name: "敏感内容",
      events: [
        ...textEvents,
        { type: "message_delta", delta: { stop_reason: "sensitive" } },
        { type: "message_stop" },
      ],
      stopReason: "error",
      rawStopReason: "sensitive",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "error"],
      errorMessage: "Provider stopped with: sensitive",
    },
    {
      name: "未知停止原因",
      events: [
        ...textEvents,
        { type: "message_delta", delta: { stop_reason: "未支持原因" } },
        { type: "message_stop" },
      ],
      stopReason: "error",
      rawStopReason: "未支持原因",
      eventTypes: ["start", "text_start", "text_delta", "text_end", "error"],
      errorMessage: "Unhandled stop reason: 未支持原因",
    },
  ];

  const toolParameters = Type.Object({ a: Type.Number(), b: Type.Number() });
  for (const scenario of cases) {
    let requests = 0;
    const eventStream = stream(
      model,
      {
        systemPrompt: "使用中文回答",
        messages: [{ role: "user", content: "计算 2 加 3", timestamp: 0 }],
        tools: [
          {
            name: "add",
            description: "两数相加",
            parameters: toolParameters,
          },
        ],
      },
      {
        apiKey: "test-api-key",
        maxTokens: 100,
        temperature: 0,
        toolChoice: "auto",
        /**
         * 核对请求参数并返回本地模拟响应。
         * @param input - 客户端请求地址。
         * @param init - 包含请求头及序列化参数的选项。
         * @returns Promise 完成后返回模拟响应。
         * @throws 请求参数不符时抛出断言错误。
         */
        fetch: async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ): Promise<Response> => {
          requests += 1;
          assert.equal(String(input), "https://example.invalid/v1/messages?beta=true");
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("x-api-key"), "test-api-key");
          const body: unknown = JSON.parse(String(init?.body));
          assert.deepEqual(body, {
            model: model.id,
            messages: [{ role: "user", content: "计算 2 加 3" }],
            max_tokens: 100,
            stream: true,
            system: [{ type: "text", text: "使用中文回答" }],
            temperature: 0,
            tools: [
              {
                name: "add",
                description: "两数相加",
                eager_input_streaming: true,
                input_schema: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                  required: ["a", "b"],
                },
              },
            ],
            tool_choice: { type: "auto" },
          });
          return response(scenario.events);
        },
      },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of eventStream) {
      events.push(event);
    }
    const result = await eventStream.result();
    assert.equal(requests, 1, scenario.name);
    assert.equal(result.stopReason, scenario.stopReason, result.errorMessage);
    assert.equal(result.rawStopReason, scenario.rawStopReason, scenario.name);
    assert.equal(result.errorMessage, scenario.errorMessage, scenario.name);
    assert.deepEqual(
      result.content,
      scenario.tool
        ? [{ type: "toolCall", id: "toolu_example", name: "add", arguments: { a: 2, b: 3 } }]
        : [{ type: "text", text: "你好" }],
    );
    const types: AssistantMessageEvent["type"][] = [];
    for (const event of events) {
      types.push(event.type);
      if ("contentIndex" in event) {
        assert.equal(event.contentIndex, 0);
      }
      if ("partial" in event) {
        assert.equal(event.partial, result);
      }
      if (event.type === "text_delta") {
        assert.equal(event.delta, "你好");
      }
      if (event.type === "text_end") {
        assert.equal(event.content, "你好");
      }
      if (event.type === "toolcall_end") {
        assert.equal(event.toolCall, result.content[0]);
      }
      if (event.type === "done") {
        assert.equal(event.reason, scenario.stopReason);
        assert.equal(event.message, result);
      }
      if (event.type === "error") {
        assert.equal(event.error, result);
      }
    }
    assert.deepEqual(types, scenario.eventTypes, scenario.name);
  }
});

/**
 * 验证命名 SSE 的换行、网络分片、尾部事件与转义修复，并保留协议错误前的内容。
 * @returns Promise 完成表示合法响应正常结束，失败响应保留诊断信息且不会重试请求。
 * @throws 内容、事件、错误信息或请求次数不符时抛出断言错误。
 */
test("Anthropic SSE 解码支持分片并报告协议和请求错误", async (): Promise<void> => {
  const prefix = await response([
    { type: "message_start", message: { content: [], stop_reason: null } },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "你好" } },
  ]).text();
  const suffix = await response([
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]).text();
  const body = prefix + suffix;
  const cases: {
    name: string;
    body: string | null;
    text?: string;
    byteChunks?: boolean;
    status?: number;
    errorMessage?: RegExp;
    eventTypes?: AssistantMessageEvent["type"][];
  }[] = [
    { name: "LF 与 UTF-8 逐字节分片", body, byteChunks: true, text: "你好" },
    {
      name: "CR 逐字节分片及末尾 CR",
      body: body.replaceAll("\n", "\r").slice(0, -1),
      byteChunks: true,
      text: "你好",
    },
    {
      name: "CRLF 逐字节分片",
      body: body.replaceAll("\n", "\r\n"),
      byteChunks: true,
      text: "你好",
    },
    { name: "尾部省略空行和换行", body: body.slice(0, -2), text: "你好" },
    {
      name: "注释、未知命名事件与无名称事件跳过解析",
      body: `: 保活\nid: 7\nretry: 1000\n\nevent: ping\ndata: 非 JSON\n\ndata: 非 JSON\n\n${body}`,
      text: "你好",
    },
    {
      name: "CRLF 多行 data 与 UTF-8 分片合并后解析",
      body: body
        .replace(
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
          'data: {"type":"message_delta",\ndata: "delta":{"stop_reason":"end_turn"}}',
        )
        .replaceAll("\n", "\r\n"),
      byteChunks: true,
      text: "你好",
    },
    {
      name: "修复 JSON 字符串的非法反斜杠转义",
      body: body.replace('"你好"', String.raw`"C:\q"`),
      text: String.raw`C:\q`,
    },
    {
      name: "命名错误事件保留累计文本",
      body: `${prefix}event: error\ndata: {"error":{"message":"模拟协议错误"}}\n\n`,
      text: "你好",
      errorMessage: /^\{"error":\{"message":"模拟协议错误"\}\}$/,
      eventTypes: ["start", "text_start", "error"],
    },
    {
      name: "无法修复的 JSON 带原始事件诊断",
      body: `${prefix}event: content_block_delta\ndata: 非 JSON\n\n`,
      text: "你好",
      errorMessage: /Could not parse Anthropic SSE event content_block_delta:.*data=非 JSON; raw=/,
      eventTypes: ["start", "text_start", "error"],
    },
    {
      name: "没有响应正文",
      body: null,
      errorMessage: /Attempted to iterate over an Anthropic response with no body/,
      eventTypes: ["start", "error"],
    },
    {
      name: "限流响应不自动重试",
      body: '{"error":{"type":"rate_limit_error","message":"模拟限流"}}',
      status: 429,
      errorMessage: /429/,
      eventTypes: ["error"],
    },
  ];

  for (const scenario of cases) {
    let requests = 0;
    const eventStream = stream(
      model,
      { messages: [] },
      {
        apiKey: "test-api-key",
        /**
         * 返回原始 SSE 或 HTTP 错误响应，按场景提供逐字节网络分片。
         * @returns Promise 完成后返回模拟响应。
         */
        fetch: async (): Promise<Response> => {
          requests += 1;
          let responseBody: ConstructorParameters<typeof Response>[0] = scenario.body;
          if (scenario.byteChunks && scenario.body !== null) {
            const bytes = new TextEncoder().encode(scenario.body);
            responseBody = new ReadableStream<Uint8Array>({
              /**
               * 将正文逐字节入队，覆盖中文编码和 CRLF 跨分片的解码。
               * @param controller - 接收网络字节分片并结束正文的控制器。
               */
              start(controller: ReadableStreamDefaultController<Uint8Array>): void {
                for (const byte of bytes) {
                  controller.enqueue(Uint8Array.of(byte));
                }
                controller.close();
              },
            });
          }
          return new Response(responseBody, {
            status: scenario.status ?? 200,
            headers: {
              "content-type": scenario.status ? "application/json" : "text/event-stream",
            },
          });
        },
      },
    );
    const eventTypes: AssistantMessageEvent["type"][] = [];
    for await (const event of eventStream) {
      eventTypes.push(event.type);
    }
    const result = await eventStream.result();
    assert.equal(requests, 1, scenario.name);
    assert.equal(result.stopReason, scenario.errorMessage ? "error" : "stop", scenario.name);
    assert.deepEqual(
      result.content,
      scenario.text === undefined ? [] : [{ type: "text", text: scenario.text }],
      scenario.name,
    );
    assert.deepEqual(
      eventTypes,
      scenario.eventTypes ?? ["start", "text_start", "text_end", "done"],
      scenario.name,
    );
    if (scenario.errorMessage) {
      assert.match(result.errorMessage ?? "", scenario.errorMessage, scenario.name);
    } else {
      assert.equal(result.rawStopReason, "end_turn", scenario.name);
      assert.equal(result.errorMessage, undefined, scenario.name);
    }
  }
});

/**
 * 验证外部配置中的类型错误和越界值在网络请求前被拒绝。
 * @returns Promise 完成表示所有无效配置均通过错误事件结束，且没有发送请求。
 * @throws 无效配置触发请求、错误信息或终结事件不符时抛出断言错误。
 */
test("Anthropic 无效配置在请求前被拒绝", async (): Promise<void> => {
  const cases: { field: string; values: unknown[]; target?: "model" }[] = [
    { field: "maxTokens", values: [-1, 1.5, NaN, Infinity, "100", null, true] },
    { field: "temperature", values: [-0.1, 2.1, NaN, Infinity, "1", null, true] },
    {
      field: "toolChoice",
      values: [
        "AUTO",
        "未知选项",
        null,
        true,
        [],
        {},
        { type: "auto" },
        { type: "tool" },
        { type: "tool", name: "" },
        { type: "tool", name: " " },
        { type: "tool", name: 1 },
      ],
    },
    { field: "apiKey", values: [undefined, "", " ", 123, true] },
    { field: "id", values: ["", " ", 123], target: "model" },
    { field: "baseUrl", values: ["", " ", 123], target: "model" },
    { field: "provider", values: ["", " ", 123], target: "model" },
    { field: "api", values: ["openai-completions", "未支持接口", null], target: "model" },
    { field: "maxTokens", values: [-1, NaN, "100", null], target: "model" },
  ];
  for (const scenario of cases) {
    for (const value of scenario.values) {
      let requests = 0;
      const currentModel = { ...model };
      const options = {
        apiKey: "test-api-key",
        /**
         * 记录不应发生的请求，返回正常响应以识别缺失的本地校验。
         * @returns Promise 完成后返回正常结束的模拟响应。
         */
        fetch: async (): Promise<Response> => {
          requests += 1;
          return response([
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]);
        },
      };
      Object.assign(scenario.target === "model" ? currentModel : options, {
        [scenario.field]: value,
      });
      const eventStream = stream(currentModel, { messages: [] }, options);
      const events: AssistantMessageEvent[] = [];
      for await (const event of eventStream) {
        events.push(event);
      }
      const result = await eventStream.result();
      assert.equal(requests, 0, scenario.field);
      assert.equal(result.stopReason, "error", scenario.field);
      assert.ok(result.errorMessage, scenario.field);
      assert.deepEqual(events, [{ type: "error", reason: "error", error: result }]);
    }
  }
});

/**
 * 验证默认令牌上限、合法零值及未知接口的处理。
 * @returns Promise 完成表示合法请求均返回最终助手消息，并保留预期请求参数。
 * @throws 参数传递、结束结果或未知接口处理不符时抛出断言错误。
 */
test("completion 分发 Anthropic 请求并提供最终结果，拒绝未知接口", async (): Promise<void> => {
  for (const maxTokens of [undefined, 0, 1]) {
    const eventStream = await completion(
      model,
      { messages: [] },
      {
        apiKey: "test-api-key",
        maxTokens,
        temperature: 0,
        /**
         * 核对令牌上限和温度后返回正常结束响应。
         * @param _input - 请求地址。
         * @param init - 序列化请求选项。
         * @returns Promise 完成后返回模拟响应。
         * @throws 请求参数不符时抛出断言错误。
         */
        fetch: async (
          _input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ): Promise<Response> => {
          const body: { max_tokens: unknown; temperature: unknown } = JSON.parse(
            String(init?.body),
          );
          assert.equal(body.max_tokens, maxTokens ?? model.maxTokens);
          assert.equal(body.temperature, 0);
          return response([
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]);
        },
      },
    );
    const result = await eventStream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, []);
  }
  const invalidModel = { ...model };
  Object.assign(invalidModel, { api: "未支持接口" });
  await assert.rejects(completion(invalidModel, { messages: [] }), /不支持的模型接口类型/);
});

/**
 * 验证合法工具选择、温度边界及可选字段的省略和工具结构默认值。
 * @returns Promise 完成表示选项原值与默认工具结构均已发送且生成正常结束。
 * @throws 请求参数或最终消息状态不符时抛出断言错误。
 */
test("Anthropic 保留合法工具选择和温度并补齐可选工具结构", async (): Promise<void> => {
  const cases: {
    toolChoice?: NonNullable<Parameters<typeof stream>[2]>["toolChoice"];
    temperature?: number;
  }[] = [
    {},
    { toolChoice: "auto", temperature: 0 },
    { toolChoice: "any", temperature: 0.8 },
    { toolChoice: "none", temperature: 2 },
    { toolChoice: { type: "tool", name: "add" } },
  ];
  for (const options of cases) {
    const optionalNumber = Type.Optional(Type.Number());
    const eventStream = stream(
      model,
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            name: "add",
            description: "可选参数工具",
            parameters: Type.Object({ a: optionalNumber }),
          },
        ],
      },
      {
        ...options,
        apiKey: "test-api-key",
        /**
         * 核对工具结构及可选生成参数，返回正常结束响应。
         * @param _input - 客户端请求地址。
         * @param init - 包含序列化请求参数的选项。
         * @returns Promise 完成后返回模拟响应。
         * @throws 请求参数不符时抛出断言错误。
         */
        fetch: async (
          _input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ): Promise<Response> => {
          const expected: Record<string, unknown> = {
            model: model.id,
            messages: [],
            max_tokens: model.maxTokens,
            stream: true,
            tools: [
              {
                name: "add",
                description: "可选参数工具",
                eager_input_streaming: true,
                input_schema: {
                  type: "object",
                  properties: { a: { type: "number" } },
                  required: [],
                },
              },
            ],
          };
          if (options.temperature !== undefined) {
            expected.temperature = options.temperature;
          }
          if (options.toolChoice !== undefined) {
            expected.tool_choice =
              typeof options.toolChoice === "string"
                ? { type: options.toolChoice }
                : options.toolChoice;
          }
          const body: unknown = JSON.parse(String(init?.body));
          assert.deepEqual(body, expected);
          return response([
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]);
        },
      },
    );
    const result = await eventStream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
  }
});

/**
 * 验证历史消息转换保留有效文本和工具调用，并合并连续工具结果。
 * @returns Promise 完成表示消息顺序、工具结果关联和上下文不变均已验证。
 * @throws 请求消息或原上下文不符时抛出断言错误。
 */
test("Anthropic 历史转换保留消息顺序并合并连续工具结果", async (): Promise<void> => {
  const context: Context = {
    messages: [
      { role: "user", content: " ", timestamp: 0 },
      {
        role: "user",
        content: [
          { type: "text", text: "\n" },
          { type: "text", text: " 问题 " },
        ],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: " 调用工具 " },
          { type: "toolCall", id: "toolu_example", name: "add", arguments: { a: 2, b: 3 } },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "toolUse",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_example",
        toolName: "add",
        isError: false,
        content: [
          { type: "text", text: "第一行" },
          { type: "text", text: "第二行" },
        ],
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_error",
        toolName: "add",
        isError: true,
        content: [],
        timestamp: 0,
      },
      { role: "user", content: "继续", timestamp: 0 },
    ],
  };
  const original = structuredClone(context);
  const eventStream = await completion(model, context, {
    apiKey: "test-api-key",
    /**
     * 核对转换后的历史消息并返回正常结束响应。
     * @param _input - 客户端请求地址。
     * @param init - 包含序列化请求体的选项。
     * @returns Promise 完成后返回模拟响应。
     * @throws 消息转换结果不符时抛出断言错误。
     */
    fetch: async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      const body: { messages: unknown } = JSON.parse(String(init?.body));
      assert.deepEqual(body.messages, [
        { role: "user", content: [{ type: "text", text: " 问题 " }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: " 调用工具 " },
            { type: "tool_use", id: "toolu_example", name: "add", input: { a: 2, b: 3 } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_example",
              content: "第一行\n第二行",
              is_error: false,
            },
            { type: "tool_result", tool_use_id: "toolu_error", content: "", is_error: true },
          ],
        },
        { role: "user", content: "继续" },
      ]);
      return response([
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]);
    },
  });
  const result = await eventStream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(context, original);
});
