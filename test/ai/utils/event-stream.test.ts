import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, AssistantMessageEvent, StopReason } from "../../../src/ai/types.ts";
import {
  EventStream,
  createAssistantMessageEventStream,
} from "../../../src/ai/utils/event-stream.ts";

/**
 * 创建以负数为终结事件的数字流。
 * @returns 数字事件流，最终结果为终结事件本身。
 */
function createNumberStream(): EventStream<number> {
  return new EventStream(
    /**
     * 判断数字是否标记流结束。
     * @param event - 待发送的数字。
     * @returns 负数返回 true，其余数字返回 false。
     */
    (event: number): boolean => event < 0,
    /**
     * 将终结数字作为最终结果。
     * @param event - 终结事件中的数字。
     * @returns 传入的数字。
     */
    (event: number): number => event,
  );
}

/**
 * 创建具有指定结束状态的助手消息。
 * @param stopReason - 助手消息的结束状态。
 * @returns 用于验证结果引用的助手消息。
 */
function createMessage(stopReason: StopReason): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "测试回复" }],
    api: "openai-completions",
    provider: "测试服务商",
    model: "测试模型",
    stopReason,
    timestamp: 0,
  };
}

/**
 * 验证消费期间继续入队时仍按发送顺序交付事件。
 * @returns 所有队列顺序断言完成后结束。
 */
test("事件按入队顺序交付，消费期间追加的事件排列在队尾", async (): Promise<void> => {
  const stream = createNumberStream();
  const iterator = stream[Symbol.asyncIterator]();
  stream.push(1);
  stream.push(2);
  assert.deepEqual(await iterator.next(), { value: 1, done: false });
  stream.push(3);
  stream.push(4);
  stream.end(0);

  for (const value of [2, 3, 4]) {
    assert.deepEqual(await iterator.next(), { value, done: false });
  }
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

/**
 * 验证多个迭代器按等待顺序分享事件，终结事件仅唤醒一个等待者。
 * @returns 显式结束流后所有等待者完成。
 */
test("push 按等待顺序唤醒单个迭代器，end 唤醒剩余等待者", async (): Promise<void> => {
  const stream = createNumberStream();
  const firstIterator = stream[Symbol.asyncIterator]();
  const secondIterator = stream[Symbol.asyncIterator]();
  const first = firstIterator.next();
  const second = secondIterator.next();
  stream.push(1);
  stream.push(2);
  assert.deepEqual(await first, { value: 1, done: false });
  assert.deepEqual(await second, { value: 2, done: false });

  const terminal = firstIterator.next();
  const thirdIterator = stream[Symbol.asyncIterator]();
  let remainingSettled = false;
  const remaining = secondIterator.next().then(
    /**
     * 记录第二个等待者是否已完成。
     * @param result - 第二个迭代器返回的事件或结束状态。
     * @returns 原始迭代结果。
     */
    (result: IteratorResult<number>): IteratorResult<number> => {
      remainingSettled = true;
      return result;
    },
  );
  const third = thirdIterator.next();
  stream.push(-1);
  assert.deepEqual(await terminal, { value: -1, done: false });
  assert.equal(remainingSettled, false);
  stream.end();
  assert.deepEqual(await remaining, { value: undefined, done: true });
  assert.deepEqual(await third, { value: undefined, done: true });
  assert.deepEqual(await firstIterator.next(), { value: undefined, done: true });
});

/**
 * 验证最终结果先于事件消费完成，终结事件仍交付且之后的事件被忽略。
 * @returns 最终结果与终结事件断言完成后结束。
 */
test("终结事件独立完成 result，并禁止后续 push", async (): Promise<void> => {
  const stream = createNumberStream();
  const result = stream.result();
  assert.strictEqual(stream.result(), result);
  stream.push(1);
  stream.push(-2);
  stream.push(3);
  assert.equal(await result, -2);
  stream.end(4);
  assert.equal(await stream.result(), -2);

  const events: number[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  assert.deepEqual(events, [1, -2]);
});

/**
 * 验证显式结束不会丢弃排队事件或替换第一次提供的结果。
 * @returns 队列保留与结果保留断言完成后结束。
 */
test("end 保留已缓存事件和首次结果", async (): Promise<void> => {
  const stream = createNumberStream();
  stream.push(1);
  stream.push(2);
  stream.end(0);
  stream.push(3);
  stream.end(4);
  assert.equal(await stream.result(), 0);

  const events: number[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  assert.deepEqual(events, [1, 2]);
});

/**
 * 验证省略结果的结束调用只结束事件迭代，之后仍可提供最终结果。
 * @returns 后续显式结果完成 Promise 后结束。
 */
test("end 未提供结果时 result 保持等待", async (): Promise<void> => {
  const stream = createNumberStream();
  let resultSettled = false;
  const result = stream.result().then(
    /**
     * 记录最终结果是否已完成。
     * @param value - 流的最终结果。
     * @returns 原始最终结果。
     */
    (value: number): number => {
      resultSettled = true;
      return value;
    },
  );
  stream.end();
  stream.end(undefined);
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(resultSettled, false);
  stream.end(5);
  assert.equal(await result, 5);
});

/**
 * 验证提前退出消费不结束生产者，后续事件和最终结果仍可交付。
 * @returns Promise 完成表示退出后继续发送、消费与结果获取均已验证。
 * @throws 事件或最终结果不符时抛出断言错误。
 */
test("提前退出迭代后生产者仍可继续发送事件", async (): Promise<void> => {
  const stream = createNumberStream();
  stream.push(1);
  for await (const event of stream) {
    assert.equal(event, 1);
    break;
  }
  stream.push(2);
  stream.push(-1);
  stream.end();
  assert.equal(await stream.result(), -1);
  const events: number[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  assert.deepEqual(events, [2, -1]);
});

/**
 * 验证助手完成和错误事件均返回消息引用，并保留终结事件。
 * @returns 所有助手终结事件断言完成后结束。
 * @throws 消息引用、事件或迭代结束状态不符时抛出断言错误。
 */
test("助手 done 和 error 事件以消息引用完成 result", async (): Promise<void> => {
  const stoppedMessage = createMessage("stop");
  const limitedMessage = createMessage("length");
  const toolMessage = createMessage("toolUse");
  toolMessage.content = [
    { type: "toolCall", id: "call_add", name: "add", arguments: { a: 17, b: 25 } },
  ];
  const errorMessage = createMessage("error");
  errorMessage.errorMessage = "测试错误";
  const terminalEvents: Extract<AssistantMessageEvent, { type: "done" | "error" }>[] = [
    { type: "done", reason: "stop", message: stoppedMessage },
    { type: "done", reason: "length", message: limitedMessage },
    { type: "done", reason: "toolUse", message: toolMessage },
    { type: "error", reason: "error", error: errorMessage },
  ];

  for (const event of terminalEvents) {
    const stream = createAssistantMessageEventStream();
    const expectedMessage = event.type === "done" ? event.message : event.error;
    const start: AssistantMessageEvent = { type: "start", partial: expectedMessage };
    stream.push(start);
    stream.push(event);
    stream.push(start);
    assert.strictEqual(await stream.result(), expectedMessage);

    const iterator = stream[Symbol.asyncIterator]();
    assert.strictEqual((await iterator.next()).value, start);
    assert.strictEqual((await iterator.next()).value, event);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  }
});
