import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readWorkspaceFile } from "../extensions/files.js";

/**
 * 列出项目模板的完整文件名；缺少目录表示尚无模板。
 *
 * 只看 `{cwd}/.agents/prompts/` 下一层的 `.md` 文件，不递归子目录。
 * 返回的是文件名（如 `explain.md`），不是完整路径，供 /prompts 展示、/prompt 按名查找。
 *
 * @param cwd 工作区根目录
 * @returns 排序后的文件名列表；目录不存在时为空数组，不是错误
 * @throws {Error} 目录存在但无法读取（权限等）时原样抛出
 */
export function listPrompts(cwd: string): string[] {
  try {
    return readdirSync(join(cwd, ".agents", "prompts"), {
      // withFileTypes: true 返回 Dirent，才能用 isFile() 排除子目录。
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // ENOENT：还没有建 prompts 目录，当作没有模板。
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * 展开一次模板；普通输入原样返回，不解释参数中的命令或占位符。
 *
 * 仅当整行以 `/prompt` 开头（后面是空格或结束）时才展开。
 * `/promptfoo` 不会被当成模板命令。
 * 展开结果当作用户消息送给模型，因此 /prompt 不能走扩展命令入口。
 *
 * 模板里的 `$ARGUMENTS` 全部替换成 `/prompt 文件名` 后面的剩余文本；
 * 没有这段文本时替换成空字符串。替换只做一次扫描，参数里的 `$ARGUMENTS` 不会再展开。
 *
 * @param input 用户输入的一整行（调用方已 trim）
 * @param cwd 工作区根目录，用于列出模板和有界读取
 * @param signal 取消信号，原样传给 readWorkspaceFile
 * @returns 非 /prompt 行原样返回；/prompt 行返回展开后的模板正文
 * @throws {Error} 用法不对、模板不存在、读失败、展开后为空或超过 64 KiB
 */
export function expandPrompt(input: string, cwd: string, signal: AbortSignal): string {
  signal.throwIfAborted();
  if (!/^\/prompt(?:\s|$)/.test(input)) {
    return input;
  }

  const match = /^\/prompt\s+(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!match) {
    throw new Error("用法：/prompt 完整文件名 [参数文本]");
  }

  const file = match[1];
  const argumentsText = match[2] ?? "";
  // 必须出现在 listPrompts 的结果里：既确认文件存在，也挡住 `../` 等路径片段。
  if (!listPrompts(cwd).includes(file)) {
    throw new Error("模板不存在，请使用 /prompts 查看完整文件名");
  }

  const template = readWorkspaceFile(join(".agents", "prompts", file), { cwd, signal });

  // 回调返回的参数按字面插入，参数中的 $& 等不会被解释成替换语法。
  const expanded = template.replaceAll("$ARGUMENTS", () => argumentsText);

  if (!expanded.trim()) {
    throw new Error("模板展开后的内容不能为空");
  }
  if (Buffer.byteLength(expanded, "utf8") > 64 * 1024) {
    throw new Error("模板展开后的内容超过 64 KiB");
  }

  return expanded;
}
