import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { StreamOptions, Tool, ToolCall } from "../types.ts";
const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject | JsonSchemaObject[];
  additionalProperties?: boolean | JsonSchemaObject;
  allOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
}
/**
 * 读取 JSON Schema 显式声明的类型列表。
 * @param schema - 当前参数的 Schema。
 * @returns 声明的字符串类型列表；没有类型声明时返回空数组。
 */
function getSchemaTypes(schema: JsonSchemaObject): string[] {
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter(
      /**
       * 保留 Schema 中的字符串类型声明。
       * @param type - 当前类型声明。
       * @returns 字符串返回 true，其余值返回 false。
       */
      (type: string): type is string => typeof type === "string",
    );
  }
  return [];
}
/**
 * 判断值是否已满足指定 JSON 基础类型。
 * @param value - 待检查的参数值。
 * @param type - Schema 明确声明的类型名称。
 * @returns 满足类型时返回 true；未知类型返回 false。
 */
function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}
/**
 * 获取组合 Schema 分支的校验器，编译失败时允许继续检查其他分支。
 * @param schema - 当前分支的 Schema。
 * @returns 编译校验器；无法编译时返回 undefined。
 */
function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
  try {
    return getValidator(schema as Tool["parameters"]);
  } catch {
    return undefined;
  }
}
/**
 * 按 Schema 明确声明的基础类型尝试转换参数值。
 * @param value - 待转换的值。
 * @param type - 目标基础类型名称。
 * @returns 转换后的值；无法转换时保留原值，最终约束由校验器检查。
 * @remarks 不转换对象或数组；空字符串不转数值，null 转为对应基础类型的零值。
 */
function coercePrimitiveByType(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "integer": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) {
          return parsed;
        }
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "boolean": {
      if (value === null) {
        return false;
      }
      if (typeof value === "string") {
        if (value === "true") {
          return true;
        }
        if (value === "false") {
          return false;
        }
      }
      if (typeof value === "number") {
        if (value === 1) {
          return true;
        }
        if (value === 0) {
          return false;
        }
      }
      return value;
    }
    case "string": {
      if (value === null) {
        return "";
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }
    case "null": {
      if (value === "" || value === 0 || value === false) {
        return null;
      }
      return value;
    }
    default:
      return value;
  }
}
/**
 * 按对象 Schema 转换已存在的属性和显式允许的额外属性。
 * @param value - 待原地转换的参数副本。
 * @param schema - 对象属性及额外属性的声明。
 * @remarks 不补默认值，不增删属性；嵌套值按各自 Schema 递归转换。
 */
function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
  const properties = schema.properties;
  const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!(key in value)) {
        continue;
      }
      value[key] = coerceWithJsonSchema(value[key], propertySchema);
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    for (const [key, propertyValue] of Object.entries(value)) {
      if (definedKeys.has(key)) {
        continue;
      }
      value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
    }
  }
}
/**
 * 按数组 Schema 原地转换已有元素。
 * @param value - 待转换的数组副本。
 * @param schema - 元组或统一元素类型的声明。
 * @remarks 没有对应元素 Schema 时保留该元素，不改变数组长度。
 */
function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const itemSchema = schema.items[index];
      if (!itemSchema) {
        continue;
      }
      value[index] = coerceWithJsonSchema(value[index], itemSchema);
    }
    return;
  }
  if (schema.items && typeof schema.items === "object") {
    for (let index = 0; index < value.length; index++) {
      value[index] = coerceWithJsonSchema(value[index], schema.items);
    }
  }
}
/**
 * 优先保留已满足组合分支的值，再尝试每个分支的转换。
 * @param value - 待转换的参数值。
 * @param schemas - 按声明顺序排列的组合分支。
 * @returns 首个通过分支校验的转换值；所有分支失败时保留原值。
 * @throws 分支尝试深拷贝无法克隆的值时抛出异常。
 * @remarks 每个转换分支使用独立副本，不污染其他分支尝试。
 */
function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
  for (const schema of schemas) {
    const validator = getSubSchemaValidator(schema);
    if (validator?.Check(value)) {
      return value;
    }
  }
  for (const schema of schemas) {
    const clonedValue = structuredClone(value);
    const coerced = coerceWithJsonSchema(clonedValue, schema);
    const validator = getSubSchemaValidator(schema);
    if (validator?.Check(coerced)) {
      return coerced;
    }
  }
  return value;
}
/**
 * 依据普通 JSON Schema 递归转换参数副本。
 * @param value - 待转换的参数值。
 * @param schema - 明确声明基础类型、组合及嵌套结构的 Schema。
 * @returns 转换后的值；不支持的约束仅交由最终校验器检查。
 * @throws 组合分支中的深拷贝失败时抛出异常。
 * @remarks 对象和数组会原地转换，最终仍需检查完整 Schema。
 */
function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
  let nextValue = value;
  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) {
      nextValue = coerceWithJsonSchema(nextValue, nested);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
  }
  if (Array.isArray(schema.oneOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
  }
  const schemaTypes = getSchemaTypes(schema);
  const matchesUnionMember =
    schemaTypes.length > 1 &&
    schemaTypes.some(
      /**
       * 检查当前值是否已匹配联合类型的一项。
       * @param schemaType - 当前类型名称。
       * @returns 当前值满足该类型时返回 true。
       */
      (schemaType: string): boolean => matchesJsonType(nextValue, schemaType),
    );
  if (schemaTypes.length > 0 && !matchesUnionMember) {
    for (const schemaType of schemaTypes) {
      const convertedValue = coercePrimitiveByType(nextValue, schemaType);
      if (convertedValue !== nextValue) {
        nextValue = convertedValue;
        break;
      }
    }
  }
  if (
    schemaTypes.includes("object") &&
    typeof nextValue === "object" &&
    nextValue !== null &&
    !Array.isArray(nextValue)
  ) {
    applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
  }
  if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
    applySchemaArrayCoercion(nextValue, schema);
  }
  return nextValue;
}
/**
 * 按 Schema 对象引用获取或缓存编译校验器。
 * @param schema - 工具参数的 Schema。
 * @returns 与该 Schema 对象对应的编译校验器。
 * @throws Schema 无法编译时传递异常。
 * @remarks 首次编译后修改 Schema 不会使缓存失效。
 */
function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
  const key = schema as object;
  const cached = validatorCache.get(key);
  if (cached) {
    return cached;
  }
  const validator = Compile(schema);
  validatorCache.set(key, validator);
  return validator;
}
/**
 * 将校验错误路径转换为便于阅读的字段提示。
 * @param error - TypeBox 返回的校验错误。
 * @returns 点分隔的字段路径；顶层错误返回 root，必填错误追加首个缺失属性。
 * @remarks 路径只用于提示，不作为访问参数的键或路径。
 */
function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (
      error.params as {
        requiredProperties?: string[];
      }
    ).requiredProperties;
    const requiredProperty = requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}
/**
 * 按精确工具名转换并校验参数副本。
 * @param tools - 可调用的工具列表，同名时使用首个定义。
 * @param toolCall - 原始工具调用，不会被修改。
 * @returns 通过工具 Schema 校验的参数副本。
 * @throws 工具未声明、参数无法克隆、Schema 无效或转换后校验失败时抛出异常。
 * @remarks 不执行工具、不补默认值，也不删除额外字段。
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): Record<string, unknown> {
  const tool = tools.find(
    /**
     * 精确匹配声明与调用的工具名称。
     * @param t - 当前工具定义。
     * @returns 名称相同时返回 true。
     */
    (t: Tool): boolean => t.name === toolCall.name,
  );
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}
/**
 * 转换参数深拷贝并统一检查完整 Schema。
 * @param tool - 工具定义及参数 Schema。
 * @param toolCall - 原始调用参数及错误提示使用的工具名。
 * @returns 校验通过的参数副本。
 * @throws 克隆、转换或 Schema 编译失败时传递异常，校验失败时提供路径及原始参数。
 * @remarks TypeBox 使用自身转换器；普通 JSON Schema 使用基础类型转换，均保留原始参数。
 */
function validateToolArguments(tool: Tool, toolCall: ToolCall): Record<string, unknown> {
  const clonedArgs = structuredClone(toolCall.arguments);
  let args = Value.Convert(tool.parameters, clonedArgs);
  const validator = getValidator(tool.parameters);
  // TypeBox 1.x 在 Schema 上使用非枚举的 ~kind，具体声明见依赖的 type/types/schema.mjs。
  if (!Object.hasOwn(tool.parameters, "~kind")) {
    args = coerceWithJsonSchema(args, tool.parameters as JsonSchemaObject);
  }
  if (validator.Check(args)) {
    return args as Record<string, unknown>;
  }
  const validationErrors = validator.Errors(args);
  const errors =
    validationErrors
      .map(
        /**
         * 格式化单项参数校验错误。
         * @param error - TypeBox 返回的错误。
         * @returns 包含字段路径及错误说明的提示行。
         */
        (error: TLocalizedValidationError): string =>
          `  - ${formatValidationPath(error)}: ${error.message}`,
      )
      .join("\n") || "Unknown validation error";
  const errorMessage =
    `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n` +
    JSON.stringify(toolCall.arguments, null, 2);
  throw new Error(errorMessage);
}

/**
 * 在发送请求前校验四种协议共用的生成选项。
 * @param options - 可选的生成选项，undefined 表示全部使用协议默认值。
 * @throws maxTokens 不是非负有限整数，或 temperature 不是 0 到 2 之间的有限数值时抛出异常。
 * @remarks 不修改选项；认证、模型及工具选择由所选协议单独校验。
 */
export function validateStreamOptions(options?: StreamOptions): void {
  const maxTokens = options?.maxTokens;
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 0)
  ) {
    throw new Error("maxTokens 必须是非负有限整数。");
  }
  const temperature = options?.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== "number" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  ) {
    throw new Error("temperature 必须是 0 到 2 之间的有限数值。");
  }
}
