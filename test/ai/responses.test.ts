import assert from "node:assert/strict";
import { test } from "node:test";
import { stream } from "../../src/ai/api/openai-responses.ts";
import { completion } from "../../src/ai/index.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "../../src/ai/types.ts";

/** 用于回放实际处理字段的 Responses 协议事件。 */
type MockEvent = { type: string; [key: string]: unknown };

const model: Model<"openai-responses"> = {
  api: "openai-responses",
  provider: "测试服务商",
  id: "测试模型",
  baseUrl: "https://example.invalid/v1",
  maxTokens: 999,
};

/**
 * 验证 Responses 请求参数、文本和工具事件、终态及错误清理。
 * @returns Promise 完成表示全部模拟响应和错误场景均已验证。
 * @throws 请求参数、事件顺序、最终内容或结束原因不符时抛出断言错误。
 */
test("Responses 请求与响应事件保持现有行为", async (): Promise<void> => {
  const message = {
    type: "message",
    id: "msg_example",
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text: "你好", annotations: [] }],
  };
  const textEvents: MockEvent[] = [
    { type: "response.created", response: { id: "resp_example" } },
    { type: "response.output_item.added", output_index: 2, item: { ...message, content: [] } },
    { type: "response.output_text.delta", output_index: 2, delta: "你好" },
    { type: "response.output_item.done", output_index: 2, item: message },
  ];
  const tool = {
    type: "function_call",
    id: "fc_example",
    call_id: "call_example",
    name: "add",
    arguments: "",
  };
  const toolEvents: MockEvent[] = [
    { type: "response.output_item.added", output_index: 3, item: tool },
    { type: "response.function_call_arguments.delta", output_index: 3, delta: '{"a":2' },
    { type: "response.function_call_arguments.done", output_index: 3, arguments: '{"a":2,"b":3}' },
    {
      type: "response.output_item.done",
      output_index: 3,
      item: { ...tool, arguments: '{"a":2,"b":3}' },
    },
  ];
  const completed: MockEvent = {
    type: "response.completed",
    response: { id: "resp_example", status: "completed" },
  };
  const textContent: AssistantMessage["content"] = [
    {
      type: "text",
      text: "你好",
      textSignature: JSON.stringify({ v: 1, id: "msg_example", phase: "final_answer" }),
    },
  ];
  const toolContent: AssistantMessage["content"] = [
    { type: "toolCall", id: "call_example|fc_example", name: "add", arguments: { a: 2, b: 3 } },
  ];
  const textTypes: AssistantMessageEvent["type"][] = [
    "start",
    "text_start",
    "text_delta",
    "text_end",
  ];
  const cases: {
    name: string;
    events: MockEvent[];
    reason: AssistantMessage["stopReason"];
    content: AssistantMessage["content"];
    types: AssistantMessageEvent["type"][];
    error?: string;
    noKey?: boolean;
    fail?: boolean;
  }[] = [
    {
      name: "文本完成",
      events: [...textEvents, completed],
      reason: "stop",
      content: textContent,
      types: [...textTypes, "done"],
    },
    {
      name: "工具完成",
      events: [...toolEvents, completed],
      reason: "toolUse",
      content: toolContent,
      types: [
        "start",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ],
    },
    {
      name: "令牌截断",
      events: [
        ...textEvents,
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ],
      reason: "length",
      content: textContent,
      types: [...textTypes, "done"],
    },
    {
      name: "工具参数截断",
      events: [
        ...toolEvents.slice(0, 2),
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        },
      ],
      reason: "length",
      content: [
        { type: "toolCall", id: "call_example|fc_example", name: "add", arguments: { a: 2 } },
      ],
      types: ["start", "toolcall_start", "toolcall_delta", "done"],
    },
    {
      name: "过滤错误",
      events: [
        ...textEvents,
        {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
        },
      ],
      reason: "error",
      content: textContent,
      types: [...textTypes, "error"],
      error: "Response incomplete: content_filter",
    },
    {
      name: "缺少终态",
      events: textEvents,
      reason: "error",
      content: textContent,
      types: [...textTypes, "error"],
      error: "OpenAI Responses stream ended before a terminal response event",
    },
    {
      name: "工具未结束",
      events: [...toolEvents.slice(0, -1), completed],
      reason: "error",
      content: toolContent,
      types: ["start", "toolcall_start", "toolcall_delta", "toolcall_delta", "error"],
      error:
        "OpenAI Responses stream completed with an unfinished tool call: add (call_example|fc_example)",
    },
    {
      name: "失败终态",
      events: [
        ...textEvents,
        {
          type: "response.failed",
          response: { status: "failed", error: { code: "test_error", message: "模拟失败" } },
        },
      ],
      reason: "error",
      content: textContent,
      types: [...textTypes, "error"],
      error: "test_error: 模拟失败",
    },
    {
      name: "空内容完成",
      events: [completed],
      reason: "stop",
      content: [],
      types: ["start", "done"],
    },
    {
      name: "缺少密钥",
      events: [],
      noKey: true,
      reason: "error",
      content: [],
      types: ["error"],
      error: "No API key for provider: 测试服务商",
    },
    {
      name: "网络失败",
      events: [],
      fail: true,
      reason: "error",
      content: [],
      types: ["error"],
      error: "Connection error.",
    },
  ];
  for (const scenario of cases) {
    let requests = 0;
    const eventStream = stream(
      model,
      { systemPrompt: "中文回答", messages: [{ role: "user", content: "测试", timestamp: 0 }] },
      {
        apiKey: scenario.noKey ? undefined : "test-api-key",
        maxTokens: 1,
        temperature: 0,
        toolChoice: "none",
        /**
         * 验证请求参数并回放本地事件，不访问网络。
         * @param input - 请求地址。
         * @param init - 包含认证和序列化请求参数的选项。
         * @returns Promise 完成后返回 SSE 响应。
         * @throws 参数不符或场景指定请求失败时抛出异常。
         */
        fetch: async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ): Promise<Response> => {
          requests++;
          assert.equal(String(input), "https://example.invalid/v1/responses");
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), "Bearer test-api-key");
          const bodyParams: unknown = JSON.parse(String(init?.body));
          assert.deepEqual(bodyParams, {
            model: model.id,
            input: [
              { role: "system", content: "中文回答" },
              { role: "user", content: [{ type: "input_text", text: "测试" }] },
            ],
            stream: true,
            store: false,
            max_output_tokens: 16,
            temperature: 0,
            tool_choice: "none",
          });
          if (scenario.fail) {
            throw new Error("模拟网络失败");
          }
          let body = "";
          for (const event of scenario.events) {
            body += `data: ${JSON.stringify(event)}\n\n`;
          }
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
      },
    );
    const types: AssistantMessageEvent["type"][] = [];
    const events: AssistantMessageEvent[] = [];
    for await (const event of eventStream) {
      types.push(event.type);
      events.push(event);
    }
    const result = await eventStream.result();
    for (const event of events) {
      if ("partial" in event) {
        assert.equal(event.partial, result);
      }
    }
    assert.equal(requests, scenario.noKey ? 0 : 1, scenario.name);
    assert.equal(result.stopReason, scenario.reason, result.errorMessage);
    assert.equal(result.errorMessage, scenario.error, scenario.name);
    assert.deepEqual(result.content, scenario.content, scenario.name);
    assert.deepEqual(types, scenario.types, scenario.name);
  }
});

/**
 * 验证无效生成参数在请求边界拒绝，不会发送模型请求。
 * @returns Promise 完成表示所有无效输入均通过错误事件结束且请求次数为零。
 * @throws 无效参数触发请求、错误说明或终结事件不符时抛出断言错误。
 */
test("Responses 无效生成参数在请求前被拒绝", async (): Promise<void> => {
  const cases: { field: "maxTokens" | "temperature"; values: unknown[]; message: string }[] = [
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
  ];
  for (const scenario of cases) {
    for (const value of scenario.values) {
      let requests = 0;
      const options = {
        apiKey: "test-api-key",
        /**
         * 记录不应发生的模型请求并返回空内容完成响应。
         * @returns Promise 完成后返回正常结束的模拟响应。
         */
        fetch: async (): Promise<Response> => {
          requests++;
          return new Response(
            'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      };
      Object.assign(options, { [scenario.field]: value });
      const eventStream = stream(model, { messages: [] }, options);
      const events: AssistantMessageEvent[] = [];
      for await (const event of eventStream) {
        events.push(event);
      }
      const result = await eventStream.result();
      assert.equal(requests, 0, scenario.field);
      assert.equal(result.errorMessage, scenario.message);
      assert.equal(result.stopReason, "error");
      assert.deepEqual(events, [{ type: "error", reason: "error", error: result }]);
    }
  }
});

/**
 * 验证 completion 分发 Responses 请求，历史转换压缩长签名并保留阶段和工具结果关联。
 * @returns Promise 完成表示历史转换、上下文不变和零值或省略生成上限的语义均已验证。
 * @throws 请求内容、原始上下文或最终状态不符时抛出断言错误。
 */
test("Responses 历史转换保留签名和工具关联并压缩长消息标识", async (): Promise<void> => {
  const longId = "长消息标识".repeat(20);
  const context: Context = {
    messages: [
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "toolUse",
        timestamp: 0,
        content: [
          {
            type: "text",
            text: "调用说明",
            textSignature: JSON.stringify({ v: 1, id: longId, phase: "commentary" }),
          },
          { type: "text", text: "旧签名", textSignature: "msg_legacy" },
          { type: "text", text: "无签名" },
          {
            type: "toolCall",
            id: "call_example|fc_example",
            name: "add",
            arguments: { a: 17, b: 25 },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_example|fc_example",
        toolName: "add",
        content: [{ type: "text", text: "42" }],
        isError: false,
        timestamp: 0,
      },
    ],
  };
  const original = structuredClone(context);
  for (const maxTokens of [undefined, 0]) {
    const eventStream = await completion(model, context, {
      apiKey: "test-api-key",
      maxTokens,
      /**
       * 核对 Responses 请求的完整历史及上限字段，并返回正常结束响应。
       * @param input - 客户端请求地址。
       * @param init - 包含序列化请求参数的选项。
       * @returns Promise 完成后返回空内容完成响应。
       * @throws 请求地址、历史转换或生成参数不符时抛出断言错误。
       */
      fetch: async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ): Promise<Response> => {
        assert.equal(String(input), "https://example.invalid/v1/responses");
        const body: unknown = JSON.parse(String(init?.body));
        assert.deepEqual(body, {
          model: model.id,
          stream: true,
          store: false,
          input: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              id: "msg_1iahpygg6zdlg",
              phase: "commentary",
              content: [{ type: "output_text", text: "调用说明", annotations: [] }],
            },
            {
              type: "message",
              role: "assistant",
              status: "completed",
              id: "msg_legacy",
              content: [{ type: "output_text", text: "旧签名", annotations: [] }],
            },
            {
              type: "message",
              role: "assistant",
              status: "completed",
              id: "msg_pi_0_2",
              content: [{ type: "output_text", text: "无签名", annotations: [] }],
            },
            {
              type: "function_call",
              id: "fc_example",
              call_id: "call_example",
              name: "add",
              arguments: '{"a":17,"b":25}',
            },
            { type: "function_call_output", call_id: "call_example", output: "42" },
          ],
        });
        return new Response(
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const result = await eventStream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(context, original);
  }
});
