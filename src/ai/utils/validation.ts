import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

/** 按 Schema 对象引用复用编译结果；WeakMap 不会因缓存阻止 Schema 对象被回收。 */
const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

/**
 * 按名称精确查找工具，转换并校验工具调用的参数副本。
 * @param tools - 可调用的工具定义；同名工具存在多个时使用数组中的第一个。
 * @param toolCall - 模型生成的工具名称及参数；原始参数不被本函数修改。
 * @returns 通过工具 Schema 校验的参数副本，其属性值可能经过 TypeBox 转换。
 * @throws 工具不存在、参数无法克隆、Schema 处理失败或转换后参数仍不满足 Schema 时抛出异常。
 * @remarks 只验证调用参数，不执行工具，也不检查工具调用 id。
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): Record<string, unknown> {
  const tool = tools.find(
    /**
     * 判断工具名称是否与调用名称完全相同。
     * @param t - 当前遍历的工具定义。
     * @returns 名称完全相同时返回 true，否则返回 false。
     */
    (t: Tool): boolean => t.name === toolCall.name,
  );
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}

/**
 * 对参数深拷贝尝试原地类型转换，再校验副本并汇总失败原因。
 * @param tool - 提供参数 Schema 的工具定义。
 * @param toolCall - 提供原始参数及错误提示中工具名称的调用记录。
 * @returns 校验通过的深拷贝参数对象。
 * @throws 深拷贝、转换或 Schema 编译失败时传递异常；校验不通过时抛出包含错误路径和说明的异常。
 * @remarks 不填充默认值或移除额外字段；是否允许缺失或额外字段由 Schema 决定。
 */
function validateToolArguments(tool: Tool, toolCall: ToolCall): Record<string, unknown> {
  // Convert 会改写对象属性，先克隆避免转换过程改变对话历史中的模型原始参数。
  const args = structuredClone(toolCall.arguments);
  Value.Convert(tool.parameters, args);
  const validator = getValidator(tool.parameters);
  if (validator.Check(args)) {
    return args;
  }
  const validationErrors = validator.Errors(args);
  const errors =
    validationErrors
      .map(
        /**
         * 将单项校验错误转换为包含参数路径的提示行。
         * @param error - TypeBox 返回的本地化校验错误。
         * @returns 缩进后的错误路径和说明。
         */
        (error: TLocalizedValidationError): string =>
          `  - ${formatValidationPath(error)}: ${error.message}`,
      )
      .join("\n") || "Unknown validation error";
  throw new Error(`Validation failed for tool "${toolCall.name}":\n${errors}`);
}

/**
 * 获取 Schema 对应的缓存校验器，首次使用时编译并缓存。
 * @param schema - 工具参数的 TypeBox Schema 对象。
 * @returns 以该对象引用为键缓存的编译校验器。
 * @throws TypeBox 无法处理 Schema 时传递编译异常。
 * @remarks 相同内容但不同引用的 Schema 分别编译；Schema 首次编译后修改不会触发重新编译。
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
 * 将校验错误的位置转换为便于阅读的参数路径。
 * @param error - 含 instancePath、keyword 和 params 的 TypeBox 校验错误。
 * @returns 去掉首个斜杠并将其余斜杠替换为点的路径；空路径返回 root，必填错误优先追加首个缺失属性名。
 * @remarks 路径仅用于提示，不解码 JSON Pointer 的转义，也不作为实际字段访问表达式。
 */
function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (error.params as { requiredProperties?: string[] })
      .requiredProperties;
    const requiredProperty = requiredProperties?.[0];
    if (requiredProperty) {
      // 必填错误的 instancePath 指向父对象，需追加缺失字段才能定位到具体参数。
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}
