import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStreamingJson } from "../../../src/ai/utils/json-parse.ts";

/**
 * 验证空参数或无法解析的内容返回空对象。
 * @throws 解析结果不符时抛出断言错误。
 */
test("流式 JSON 空值和无效内容返回空对象", (): void => {
  for (const input of [undefined, "", "  ", "无效JSON"]) {
    assert.deepEqual(parseStreamingJson(input), {});
  }
});

/**
 * 验证完整 JSON 值与未完成的工具参数保留已解析内容。
 * @throws 解析结果不符时抛出断言错误。
 */
test("流式 JSON 保留完整对象和已到达的参数", (): void => {
  assert.deepEqual(parseStreamingJson('{"a":17,"b":25}'), { a: 17, b: 25 });
  assert.deepEqual(parseStreamingJson('{"a":17,"b":'), { a: 17 });
  assert.deepEqual(parseStreamingJson('{"items":[1,2'), { items: [1, 2] });
  assert.deepEqual(parseStreamingJson('{"value":null,"items":[1,true]}'), {
    value: null,
    items: [1, true],
  });
  for (const value of [null, false, 0, "文本", [1, 2]]) {
    const json = JSON.stringify(value);
    assert.deepEqual(parseStreamingJson<unknown>(json), value);
  }
});

/**
 * 验证合法转义保持含义，并修复字符串中的控制字符和非法转义。
 * @throws 修复或部分解析结果不符时抛出断言错误。
 * @remarks 未闭合字符串按原文部分解析结果返回，非法或未完成的转义尾部可能暂不保留。
 */
test("流式 JSON 正确保留和修复字符串转义", (): void => {
  const escaped = String.raw`{"text":"\u4f60\n\"\\"}`;
  assert.deepEqual(parseStreamingJson(escaped), {
    text: '你\n"\\',
  });
  assert.deepEqual(parseStreamingJson('{"text":"行一\n行二"}'), { text: "行一\n行二" });
  const invalidEscape = String.raw`{"text":"值\q"}`;
  assert.deepEqual(parseStreamingJson(invalidEscape), { text: "值\\q" });
  const controls = "\b\f\n\r\t\u0000\u001f";
  assert.deepEqual(parseStreamingJson(`{"text":"${controls}"}`), { text: controls });
  // 原文部分解析先于修复后的部分解析；partial-json 对未闭合字符串截去尚未解析的转义尾部。
  const unfinishedEscape = String.raw`{"text":"值\q`;
  assert.deepEqual(parseStreamingJson(unfinishedEscape), { text: "值" });
  assert.deepEqual(parseStreamingJson('{"text":"路径\\'), { text: "路径" });
});
