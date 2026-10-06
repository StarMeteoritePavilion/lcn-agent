import type { Api, ImageContent, Message, Model, TextContent } from "../types.ts";
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
/**
 * 将图片替换为文本占位并合并连续相同占位。
 * @param content - 按原顺序排列的文本和图片内容块。
 * @param placeholder - 替换图片时使用的固定文本。
 * @returns 保留文本顺序的新数组；连续图片仅产生一个占位。
 * @remarks 文本块保留原对象引用，不修改原数组。
 */
function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}
/**
 * 根据模型输入能力替换用户消息和工具结果中的图片。
 * @param messages - 按对话顺序排列的历史消息。
 * @param model - 本次请求的模型配置。
 * @returns 支持图片时返回原消息数组，否则返回转换后的消息数组。
 * @remarks 助手消息保持不变，原始消息和内容数组不被修改。
 */
function downgradeUnsupportedImages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
): Message[] {
  if (model.input.includes("image")) {
    return messages;
  }
  return messages.map(
    /**
     * 替换单条用户消息或工具结果中的不支持图片。
     * @param msg - 按历史顺序处理的单条消息。
     * @returns 新消息或不需要转换的原消息。
     */
    (msg: Message): Message => {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
        };
      }
      if (msg.role === "toolResult") {
        return {
          ...msg,
          content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
        };
      }
      return msg;
    },
  );
}
/**
 * 归一化空内容并按模型输入能力转换历史图片。
 * @param messages - 按对话顺序排列的历史消息。
 * @param model - 本次请求的模型配置。
 * @returns 按原顺序排列的消息，没有输入消息时返回空数组。
 * @remarks null 或 undefined 内容归一化为空数组；不支持图片时使用固定占位，不修改输入消息。
 */
export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
): Message[] {
  const normalizedMessages = messages.map(
    /**
     * 将单条消息的空内容归一化为空数组。
     * @param msg - 按历史顺序处理的单条消息。
     * @returns 空内容对应的新消息，其余消息保留原引用。
     */
    (msg: Message): Message => (msg.content == null ? { ...msg, content: [] } : msg),
  );
  return downgradeUnsupportedImages(normalizedMessages, model);
}
