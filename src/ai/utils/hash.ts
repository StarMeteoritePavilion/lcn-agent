/**
 * 将字符串压缩为确定性的短标识，供 Responses 缩短超过 64 个字符的消息项标识。
 * @param str - 按 UTF-16 码元参与计算的原始字符串，允许为空。
 * @returns 两个无符号 32 位计算结果的 36 进制拼接字符串，相同输入得到相同结果。
 * @remarks 不提供密码学安全或唯一性保证，不用于认证或完整性校验。
 */
export function shortHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
