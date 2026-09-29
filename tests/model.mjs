import assert from "node:assert/strict";
import { streamChat } from "../dist/core/model.js";

/**
 * @file 独立流式模型通信模块（streamChat）单元测试。
 *
 * 验证目标：
 * 1. 独立请求与参数透传：验证 client、model、messages、tools 及 signal 正确传入底层 SDK；
 * 2. 文本分片流式拼接：验证连续 text_delta 正确触发回调并最终聚合成完整字符串；
 * 3. 独立用量块（Usage Chunk）捕获：验证位于流末尾 choices 为空的 usage 正确解析；
 * 4. 工具调用参数分片累加：验证同一 index 跨多个 chunk 到达的 JSON 碎片能正确拼装；
 * 5. 异常与取消信号拦截：验证底层流中断异常正常向上抛出，已取消的 signal 不会派发多余事件。
 */

// 捕获发给打桩客户端的所有请求记录
const requests = [];
// 当前轮次模拟返回的 SSE 分块列表
let chunks = [];
// 模拟中途抛出的异常
let failure;

// 构造模拟 OpenAI Client 客户端，使用异步生成器（async function*）模拟底层的流式响应
const client = {
  chat: {
    completions: {
      async create(body, options) {
        requests.push({ body, options });
        return (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
          if (failure) {
            throw failure;
          }
        })();
      },
    },
  },
};

const signal = new AbortController().signal;
const messages = [{ role: "user", content: "独立任务" }];
const tools = [];
const events = [];

// ---------------------------------------------------------------------------
// 第一部分：正常文本流与末尾用量块测试
// ---------------------------------------------------------------------------
chunks = [
  // 第 1 块：返回首字 "你"
  { choices: [{ delta: { content: "你" }, finish_reason: null }] },
  // 第 2 块：返回尾字 "好"，完成原因为 stop
  { choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
  // 第 3 块：典型 OpenAI usage 格式（choices 为空数组，携带 token 统计）
  { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
];

const result = await streamChat(
  client,
  "test-model",
  messages,
  tools,
  signal,
  (event) => events.push(event),
);

// 验证最终聚合结果
assert.deepEqual(result, {
  content: "你好",
  toolCalls: [],
  finishReason: "stop",
  usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
});

// 验证流式派发的事件序列（两次文本增量 + 一次模型结束）
assert.deepEqual(events, [
  { type: "text_delta", text: "你" },
  { type: "text_delta", text: "好" },
  { type: "model_end", finishReason: "stop" },
]);

// 验证透传给底层 SDK 的参数完全一致
assert.equal(requests[0].body.messages, messages);
assert.equal(requests[0].body.tools, tools);
assert.equal(requests[0].options.signal, signal);
assert.equal(requests[0].body.model, "test-model");
// 验证通信层未对传入的原始消息数组造成就地修改
assert.deepEqual(messages, [{ role: "user", content: "独立任务" }]);

// ---------------------------------------------------------------------------
// 第二部分：工具调用参数跨分片（JSON Chunks）拼接测试
// ---------------------------------------------------------------------------
chunks = [
  // 分片 1：携带函数名 echo 与部分参数 '{"text":'
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: "call-1", function: { name: "echo", arguments: '{"text":' } }],
        },
        finish_reason: null,
      },
    ],
  },
  // 分片 2：携带剩余参数 '"ok"}'，完成原因为 tool_calls
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
];

const second = await streamChat(client, "test-model", [], tools, signal, () => {});
// 验证工具参数已无缝拼接为合法的 JSON 字符串
assert.deepEqual(second, {
  content: "",
  finishReason: "tool_calls",
  usage: null,
  toolCalls: [{ id: "call-1", name: "echo", arguments: '{"text":"ok"}' }],
});
assert.deepEqual(requests[1].body.messages, []);

// ---------------------------------------------------------------------------
// 第三部分：流中断异常传播与预取消信号拦截测试
// ---------------------------------------------------------------------------
chunks = [];
failure = new Error("模拟流中断");
// 1. 流读取中途抛错：应直接原样抛出，调用方可捕获
await assert.rejects(
  streamChat(client, "test-model", [], tools, signal, () => {}),
  (error) => error === failure,
);
failure = undefined;

// 2. 预取消信号拦截：传入已 abort 的 signal
const aborted = AbortSignal.abort();
const cancelledEvents = [];
await streamChat(client, "test-model", [], tools, aborted, (event) => cancelledEvents.push(event));
assert.equal(requests.at(-1).options.signal, aborted);
// 验证因 signal 已被取消，绝不向外派发任何 model_end 事件
assert.deepEqual(cancelledEvents, []);

console.log("模型通信检查通过：消息隔离、文本、工具分片、用量、异常与取消信号透传");
