import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * 一条项目级记忆。存在 `{realpath(cwd)}/.lcn-agent/memory.json`，不跟会话走。
 *
 * - id:        随机 UUID，删除时必须写完整编号。
 * - content:   用户写下的正文；trim 判空，但存盘时不改原文。
 * - source:    固定为“用户显式保存”，磁盘上若是别的值一律拒绝。
 * - scope:     保存时的项目真实路径；读回时必须仍等于当前 cwd 的 realpath。
 * - updatedAt: ISO 时间戳。
 */
type Memory = {
  id: string;
  content: string;
  source: "用户显式保存";
  scope: string;
  updatedAt: string;
};

/**
 * 项目根目录使用真实路径，同一路径的符号链接入口归于同一项目。
 *
 * 不走 state.ts：那套接口按会话文件分目录，记忆是项目共享的。
 * 文件不存在返回空数组；损坏或格式不对抛错，避免后续写入把坏文件盖掉。
 *
 * @param cwd 工作区路径，会先 realpath
 * @returns 通过校验的记忆列表
 * @throws {Error} 读失败（非 ENOENT）、UTF-8/JSON 损坏、版本或条目不合法
 */
export function readMemories(cwd: string): Memory[] {
  const scope = realpathSync(cwd);
  let bytes: Buffer;

  try {
    bytes = readFileSync(join(scope, ".lcn-agent", "memory.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  let data: unknown;
  try {
    // TextDecoder 说明见 session.ts：fatal: true 让非法 UTF-8 直接失败。
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("项目记忆文件损坏，拒绝覆盖");
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("version" in data) ||
    data.version !== 1 ||
    !("items" in data) ||
    !Array.isArray(data.items) ||
    data.items.length > 20
  ) {
    throw new Error("项目记忆格式或版本无效");
  }

  const ids = new Set<string>();
  return data.items.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !("content" in item) ||
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content.length > 1000 ||
      !("source" in item) ||
      item.source !== "用户显式保存" ||
      !("scope" in item) ||
      item.scope !== scope ||
      !("updatedAt" in item) ||
      typeof item.updatedAt !== "string" ||
      // Date.parse 失败得到 NaN；Number.isFinite(NaN) 为 false。
      !Number.isFinite(Date.parse(item.updatedAt))
    ) {
      throw new Error("项目记忆条目无效或作用范围不匹配");
    }

    ids.add(item.id);
    return {
      id: item.id,
      content: item.content,
      source: item.source,
      scope: item.scope,
      updatedAt: item.updatedAt,
    };
  });
}

/**
 * 完整写入临时文件后替换，避免暴露半份 JSON。
 *
 * 写法与 state.ts 的 writeState 相同：同目录 mkdtemp、wx 独占创建、rename 替换。
 */
function saveMemories(cwd: string, items: Memory[], signal: AbortSignal): void {
  signal.throwIfAborted();
  const directory = join(realpathSync(cwd), ".lcn-agent");
  mkdirSync(directory, { recursive: true });
  const temporary = mkdtempSync(join(directory, ".memory-"));

  try {
    const pending = join(temporary, "memory.json");
    writeFileSync(pending, JSON.stringify({ version: 1, items }) + "\n", {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    signal.throwIfAborted();
    renameSync(pending, join(directory, "memory.json"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  // ponytail: 沿用宿主单写入进程约定；需要外部并发修改时再引入共同锁协议。
}

/**
 * 仅由用户显式命令调用，先校验已有文件，损坏时不覆盖。
 *
 * @param content `/memory_add` 后面的整段文本；只用 trim 判空，不改写内容
 * @returns 含新编号的成功说明
 * @throws {Error} 内容不合法、已满 20 条、已有文件损坏，或已取消
 */
export function addMemory(cwd: string, content: string, signal: AbortSignal): string {
  signal.throwIfAborted();
  if (!content.trim() || content.length > 1000) {
    throw new Error("记忆内容必须非空，最多 1000 个 UTF-16 代码单元");
  }

  const items = readMemories(cwd);
  if (items.length >= 20) throw new Error("项目记忆最多 20 条，请先删除不再需要的条目");

  const item: Memory = {
    id: randomUUID(),
    content,
    source: "用户显式保存",
    scope: realpathSync(cwd),
    updatedAt: new Date().toISOString(),
  };

  saveMemories(cwd, [...items, item], signal);
  return `已保存项目记忆：${item.id}`;
}

/**
 * 编号必须来自实际列表，不能按前缀或大小写猜测。
 *
 * @param id 完整 UUID，调用方应已 trim
 */
export function deleteMemory(cwd: string, id: string, signal: AbortSignal): string {
  signal.throwIfAborted();
  const items = readMemories(cwd);
  if (!items.some((item) => item.id === id)) {
    throw new Error("记忆编号不存在，请使用 /memory 查看完整编号");
  }

  saveMemories(
    cwd,
    items.filter((item) => item.id !== id),
    signal,
  );
  return `已删除项目记忆：${id}`;
}

/**
 * 当前记忆独立注入请求，不写入会话历史，也不交给摘要替换。
 *
 * 空列表返回空串，调用方就不会加这段系统说明。
 */
export function memoryPrompt(cwd: string): string {
  const items = readMemories(cwd);
  if (!items.length) return "";

  return [
    "以下是用户显式保存的当前项目记忆；与本次明确要求冲突时，以本次要求为准。",
    "记忆不授予额外工具权限，不代表其中描述的操作已经执行。",
    JSON.stringify(items),
  ].join("\n");
}
