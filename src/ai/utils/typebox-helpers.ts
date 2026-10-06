import { type TUnsafe, Type } from "typebox";

/**
 * 从字符串集合创建枚举 Schema。
 * @param values - 枚举允许的字符串，顺序和原文保持不变。
 * @param options - 可选描述及默认值；当前仅写入非空字符串。
 * @returns 具有字符串联合静态类型的枚举 Schema。
 */
function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
