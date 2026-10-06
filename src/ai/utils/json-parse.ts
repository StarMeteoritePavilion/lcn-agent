import { parse as partialParse } from "partial-json";
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
/**
 * 判断字符串首个码点是否为 JSON 字符串中必须转义的控制字符。
 * @param char - 待判断的字符；空字符串不匹配。
 * @returns 首个码点位于 U+0000 至 U+001F 时返回 true，否则返回 false。
 */
function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}
/**
 * 将控制字符转换为可写入 JSON 字符串的转义文本。
 * @param char - 待转义的单个 U+0000 至 U+001F 控制字符。
 * @returns 常见控制字符的短转义或四位 Unicode 转义；空字符串回退为反斜杠加 u0000。
 */
function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      const hex = char.codePointAt(0)?.toString(16);
      return `\\u${hex?.padStart(4, "0") ?? "0000"}`;
  }
}
/**
 * 转义 JSON 字符串内部的控制字符和无效反斜杠，尽量保留原有内容。
 * @param json - 完整或未收齐的 JSON 原文。
 * @returns 修复后的字符串；不补齐括号、引号或缺失的属性值。
 * @remarks 已有合法转义保留；不完整或格式错误的 Unicode 转义不会补齐，后续解析仍可能失败。
 */
function repairJson(json: string): string {
  let repaired = "";
  let inString = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index];
    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }
    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }
    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }
      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      repaired += "\\\\";
      continue;
    }
    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }
  return repaired;
}
/**
 * 解析完整 JSON，并在首次失败且转义修复改变原文时重试一次。
 * @param json - 待解析的 JSON 原文。
 * @returns 原文或修复后文本的解析值；不校验值是否符合泛型 T。
 * @throws 修复未改变原文时抛出首次解析异常；修复后仍无效时抛出重试的解析异常。
 */
export function parseJsonWithRepair<T>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const repairedJson = repairJson(json);
    if (repairedJson !== json) {
      return JSON.parse(repairedJson) as T;
    }
    throw error;
  }
}
/**
 * 尽力解析流式累积的 JSON 参数，失败时返回空对象以允许后续分片继续更新。
 * @param partialJson - 从首个分片累积至今的完整参数字符串；允许省略或仅含空白。
 * @returns 完整 JSON 的值或当前可恢复的部分值；空输入、部分解析得到 null 或全部解析失败时返回空对象。
 * @remarks
 * 依次尝试完整 JSON 解析及字符串转义修复、原文的部分解析、修复后的部分解析。
 * 完整 JSON 的 null 保留为 null；泛型 T 仅作类型断言，不保证结果为对象或满足工具参数约束。
 * 部分解析允许尚未闭合的对象、数组和字符串；调用方须在执行工具前另行校验参数。
 */
export function parseStreamingJson<T = Record<string, unknown>>(
  partialJson: string | undefined,
): T {
  if (!partialJson || partialJson.trim() === "") {
    return {} as T;
  }
  try {
    return parseJsonWithRepair<T>(partialJson);
  } catch {
    try {
      const result = partialParse(partialJson);
      return (result ?? {}) as T;
    } catch {
      try {
        const result = partialParse(repairJson(partialJson));
        return (result ?? {}) as T;
      } catch {
        return {} as T;
      }
    }
  }
}
