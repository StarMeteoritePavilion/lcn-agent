import type { ProviderHeaders } from "../types.ts";
/**
 * 按 HTTP 头名称不区分大小写的规则依次合并请求头。
 * @param headerSources - 按优先级从低到高排列的头表，undefined 表示没有该来源。
 * @returns 保留最后一次名称原文的头表；合并后为空时返回 undefined。
 * @remarks 后续同名头覆盖已有值，null 删除同名头；不修改来源对象。
 */
export function providerHeadersToRecord(
  ...headerSources: (ProviderHeaders | undefined)[]
): Record<string, string> | undefined {
  const merged = new Map<string, [string, string]>();
  for (const source of headerSources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalizedName = name.toLowerCase();
      merged.delete(normalizedName);
      if (value !== null) {
        merged.set(normalizedName, [name, value]);
      }
    }
  }
  return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}
