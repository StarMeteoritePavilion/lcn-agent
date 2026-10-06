import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { JsonObject, Tool, ToolCall } from "../../../src/ai/types.ts";
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
  const cases: { arguments: JsonObject; expected: RegExp }[] = [
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

/**
 * 验证校验器不填充默认值或删除额外属性，字段约束以工具 Schema 为准。
 * @throws 参数内容、Schema 约束或原始调用内容不符时抛出断言错误。
 */
test("工具参数校验保留额外字段且不自动填充默认值", (): void => {
  const defaultTool: Tool = {
    name: "defaults",
    description: "验证默认值与额外字段规则",
    parameters: Type.Object({ value: Type.Number({ default: 42 }) }),
  };
  const call: ToolCall = {
    type: "toolCall",
    id: "call_defaults",
    name: "defaults",
    arguments: { value: "17", extra: "保留" },
  };
  assert.deepEqual(validateToolCall([defaultTool], call), { value: 17, extra: "保留" });
  const strictTool: Tool = {
    ...defaultTool,
    parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
  };
  assert.throws(
    /**
     * 校验严格 Schema 不允许的额外属性。
     * @throws 额外属性不满足 Schema 时抛出校验异常。
     */
    (): void => {
      validateToolCall([strictTool], call);
    },
    /Validation failed for tool "defaults":/u,
  );
  assert.deepEqual(call.arguments, { value: "17", extra: "保留" });
  const missing: ToolCall = { ...call, arguments: {} };
  assert.throws(
    /**
     * 校验存在默认值但未提供必填字段的参数。
     * @throws 不填充默认值导致缺失 value 时抛出校验异常。
     */
    (): void => {
      validateToolCall([defaultTool], missing);
    },
    /Validation failed for tool "defaults":\n  - value:/u,
  );
  assert.deepEqual(missing.arguments, {});
});

/**
 * 验证同名工具采用首个声明，并定位顶层参数类型错误。
 * @throws 首个 Schema 未生效或顶层错误路径不符时抛出断言错误。
 */
test("同名工具只使用首个声明并报告顶层参数错误", (): void => {
  const second: Tool = {
    ...tool,
    parameters: Type.Object({ a: Type.String(), b: Type.String() }),
  };
  const call: ToolCall = {
    type: "toolCall",
    id: "call_add",
    name: "add",
    arguments: { a: "17", b: "25" },
  };
  assert.deepEqual(validateToolCall([tool, second], call), { a: 17, b: 25 });
  assert.deepEqual(validateToolCall([second, tool], call), { a: "17", b: "25" });
  // 参数来自外部 JSON，类型声明不能保证运行时一定是对象。
  const invalidArguments: JsonObject = JSON.parse("null");
  assert.throws(
    /**
     * 校验运行时并非对象的工具参数。
     * @throws 参数顶层类型不符合工具 Schema 时抛出校验异常。
     */
    (): void => {
      validateToolCall([tool], { ...call, arguments: invalidArguments });
    },
    /Validation failed for tool "add":\n  - root:/u,
  );
});

/**
 * 验证普通 JSON Schema 转换嵌套数组与额外字段，并保留已符合联合类型的原值。
 * @throws 转换结果、原始参数或无效字段的拒绝行为不符时抛出断言错误。
 */
test("普通 JSON Schema 转换嵌套参数且不修改原始调用", (): void => {
  const jsonTool: Tool = {
    name: "json",
    description: "校验普通 JSON Schema 参数",
    parameters: {
      type: "object",
      properties: {
        values: { type: "array", items: { type: "integer" } },
        input: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
        selection: { anyOf: [{ type: "number" }, { type: "string" }] },
      },
      required: ["values", "input", "selection"],
      additionalProperties: { type: "number" },
    },
  };
  const call: ToolCall = {
    type: "toolCall",
    id: "call_json",
    name: "json",
    arguments: { values: ["17", "25"], input: { enabled: "false" }, selection: "42", extra: "7" },
  };
  const original = structuredClone(call.arguments);
  assert.deepEqual(validateToolCall([jsonTool], call), {
    values: [17, 25],
    input: { enabled: false },
    selection: "42",
    extra: 7,
  });
  assert.deepEqual(call.arguments, original);
  assert.throws(
    /**
     * 校验无法转换为整数的数组参数。
     * @throws 数组项不符合整数约束时抛出校验异常。
     */
    (): void => {
      validateToolCall([jsonTool], { ...call, arguments: { ...original, values: ["1.5"] } });
    },
    /Validation failed for tool "json":\n  - values\.0:/u,
  );
});

/**
 * 验证普通 JSON Schema 联合类型逐项转换后仍必须满足数值范围。
 * @throws 转换结果、约束错误或原始调用参数不符时抛出断言错误。
 */
test("普通 JSON Schema 联合转换继续校验数值约束", (): void => {
  const unionTool: Tool = {
    name: "union",
    description: "校验联合类型及数值范围",
    parameters: {
      type: "object",
      properties: { value: { anyOf: [{ type: "number", minimum: 10 }, { type: "boolean" }] } },
      required: ["value"],
    },
  };
  const call: ToolCall = {
    type: "toolCall",
    id: "call_union",
    name: "union",
    arguments: { value: "17" },
  };
  assert.deepEqual(validateToolCall([unionTool], call), { value: 17 });
  assert.deepEqual(call.arguments, { value: "17" });
  const invalid = { ...call, arguments: { value: "2" } };
  assert.throws(
    /**
     * 校验可转换数值仍低于联合 Schema 的最小值时拒绝。
     * @throws 转换后所有联合分支均不满足约束时抛出校验异常。
     */
    (): void => {
      validateToolCall([unionTool], invalid);
    },
    /Validation failed for tool "union":/u,
  );
  assert.deepEqual(invalid.arguments, { value: "2" });
});
