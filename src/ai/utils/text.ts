import type { ImageContent, TextContent, ToolCall } from "../types.ts";
type Content = TextContent | ImageContent | ToolCall;
/**
 * 提取内容中的文本块并按指定分隔符拼接。
 * @param content - 原始字符串或文本、图片及工具调用内容块。
 * @param separator - 文本块之间的分隔符，默认使用换行符。
 * @returns 原始字符串或拼接的文本；没有文本块时返回空字符串。
 */
function contentText(content: string | readonly Content[], separator: string = "\n"): string {
  if (typeof content === "string") {
    return content;
  }
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      texts.push(block.text);
    }
  }
  return texts.join(separator);
}
