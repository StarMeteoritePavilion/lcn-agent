import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { Tool, ToolCall } from "../../../src/ai/types.ts";
import { validateToolCall } from "../../../src/ai/utils/validation.ts";

const tool: Tool = {
  name: "add",
  description: "计算两个数字之和",
  parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
};

/**
 * 验证校验转换数字字符串，返回独立对象且不修改原始工具调用参数。
 * @throws 转换结果、对象引用或原始调用内容不符时抛出断言错误。
 */
test("工具参数转换后返回副本，重复使用同一结构仍校验参数", (): void => {
  const call: ToolCall = {
    type: "toolCall",
    id: "call_add",
    name: "add",
    arguments: { a: "17", b: "25" },
  };
  const original = structuredClone(call);
  const result = validateToolCall([tool], call);
  assert.deepEqual(result, { a: 17, b: 25 });
  assert.notStrictEqual(result, call.arguments);
  result.a = 0;
  assert.deepEqual(call, original);
  assert.deepEqual(validateToolCall([tool], { ...call, arguments: { a: 1, b: 2 } }), {
    a: 1,
    b: 2,
  });
});

/**
 * 验证工具名精确匹配，未声明工具不会进入参数校验。
 * @throws 校验未按要求拒绝工具调用时抛出断言错误。
 */
test("工具参数校验拒绝未声明或大小写不同的工具名", (): void => {
  for (const name of ["ADD", "未声明工具"]) {
    const call: ToolCall = { type: "toolCall", id: "call_add", name, arguments: { a: 17, b: 25 } };
    assert.throws(
      /**
       * 校验工具名不存在时的异常。
       * @throws 工具未声明时抛出异常。
       */
      (): void => {
        validateToolCall([tool], call);
      },
      { message: `Tool "${name}" not found` },
    );
  }
});

/**
 * 验证参数错误提供工具名及字段路径，且拒绝无法转换的数值。
 * @throws 错误路径或原始调用内容不符时抛出断言错误。
 */
test("工具参数校验报告缺失字段和无效字段路径", (): void => {
  const cases: { arguments: Record<string, unknown>; expected: RegExp }[] = [
    { arguments: { a: 17 }, expected: /Validation failed for tool "add":\n  - b:/u },
    { arguments: { a: "无效", b: 25 }, expected: /Validation failed for tool "add":\n  - a:/u },
  ];
  for (const { arguments: args, expected } of cases) {
    const call: ToolCall = { type: "toolCall", id: "call_add", name: "add", arguments: args };
    const original = structuredClone(call);
    assert.throws(
      /**
       * 校验工具调用中的无效参数。
       * @throws 缺少必填字段或数值无效时抛出异常。
       */
      (): void => {
        validateToolCall([tool], call);
      },
      expected,
    );
    assert.deepEqual(call, original);
  }
});

/**
 * 验证嵌套参数转换使用深拷贝，缺失字段提示包含完整父级路径。
 * @throws 转换结果、对象引用、错误路径或原始参数不符时抛出断言错误。
 */
test("嵌套工具参数转换不修改原值并报告嵌套缺失路径", (): void => {
  const inputParameters = Type.Object({ value: Type.Number() });
  const nestedTool: Tool = {
    name: "nested",
    description: "读取嵌套参数",
    parameters: Type.Object({ input: inputParameters }),
  };
  const call: ToolCall = {
    type: "toolCall",
    id: "call_nested",
    name: "nested",
    arguments: { input: { value: "42" } },
  };
  const result = validateToolCall([nestedTool], call);
  assert.deepEqual(result, { input: { value: 42 } });
  assert.notStrictEqual(result.input, call.arguments.input);
  assert.deepEqual(call.arguments, { input: { value: "42" } });
  assert.throws(
    /**
     * 校验缺失嵌套字段时的完整错误路径。
     * @throws 缺少 input.value 时抛出异常。
     */
    (): void => {
      validateToolCall([nestedTool], { ...call, arguments: { input: {} } });
    },
    /Validation failed for tool "nested":\n  - input\.value:/u,
  );
});
