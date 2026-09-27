import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadSession, type Session } from "./session.js";
import { readState } from "./state.js";
import { contextMessages } from "./compaction.js";

/**
 * 从当前完整末尾创建独立分支，不重放工具或修改父会话。
 *
 * 新会话是一份拷贝：历史消息写进新的 `.jsonl`，并把当前会话的
 * todos / plans / skill_activations / compactions 按新文件名各存一份。
 * 项目记忆、诊断日志不复制。父会话文件保持不动。
 *
 * 发布顺序：先写临时会话文件 → 再写各状态文件 → 最后用硬链接挂出正式会话名。
 * 任一步失败就按创建顺序的反序删除本次新建的路径。
 *
 * @param current 内存中的当前会话，必须与磁盘一致、且没有未配对的 tool_call
 * @param signal 取消检查；调用方若传入从未 abort 的信号，分叉过程就不会被 Ctrl+C 打断
 * @returns 已从磁盘加载的新会话，调用方再决定是否切换过去
 * @throws {Error} 未配对工具、内存与磁盘不一致、压缩状态不可用、或文件创建失败
 */
export function forkSession(current: Session, signal: AbortSignal): Session {
  signal.throwIfAborted();
  if (current.pending.size) {
    throw new Error("存在未配对工具调用，不能创建分支");
  }

  // 重新读取已落盘历史，拒绝内存与磁盘已经分歧的会话。
  const parent = loadSession(current.file, current.model);
  if (JSON.stringify(parent.messages) !== JSON.stringify(current.messages)) {
    throw new Error("当前会话与磁盘历史不一致，请先检查会话");
  }

  // 已有压缩状态必须能用于当前历史。
  contextMessages(parent, signal);

  const cwd = process.cwd();
  const context = { cwd, sessionFile: parent.file, signal };

  // 只复制已经明确属于会话的状态，不扫描整个 .lcn-agent。
  const states = ["todos", "plans", "skill_activations", "compactions"].map((namespace) => ({
    namespace,
    value: readState(context, namespace),
  }));

  const file = `${randomUUID()}.jsonl`;
  const directory = join(cwd, ".lcn-agent", "sessions");
  const temporary = mkdtempSync(join(directory, ".branch-"));
  const created: string[] = [];

  /**
   * 独占创建状态文件；只清理本次确实创建成功的路径。
   *
   * openSync 的 "wx" 在文件已存在时失败，此时还没推进 created。
   * 打开成功后立刻登记路径，这样写到一半失败也能在 catch 里删掉空文件。
   */
  function createState(path: string, text: string): void {
    // 参数 1 path、参数 2 flags "wx"：独占创建只写；参数 3 mode：仅所有者可读写。
    const descriptor = openSync(path, "wx", 0o600);
    created.push(path);

    try {
      writeFileSync(descriptor, text, { flush: true });
    } finally {
      closeSync(descriptor);
    }
  }

  try {
    const pending = join(temporary, "session.jsonl");

    const records = [
      {
        type: "session",
        version: 1,
        model: parent.model,
        parentFile: parent.file,
        forkedAt: new Date().toISOString(),
        parentMessageCount: parent.messages.length,
      },
      ...parent.messages.map((message) => ({
        type: "message",
        message,
      })),
    ];

    writeFileSync(pending, records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });

    for (const { namespace, value } of states) {
      signal.throwIfAborted();
      if (value === undefined) {
        continue;
      }

      const folder = join(cwd, ".lcn-agent", namespace);
      mkdirSync(folder, { recursive: true });
      createState(join(folder, `${file}.json`), JSON.stringify(value) + "\n");
    }

    signal.throwIfAborted();

    // 状态就绪后才发布完整会话文件；目标已存在时失败，不覆盖。
    // linkSync 打硬链接：临时文件和正式名指向同一份数据；finally 删临时目录后正式名仍在。
    const target = join(directory, file);
    linkSync(pending, target);
    created.push(target);

    return loadSession(file, parent.model);
  } catch (error) {
    const errors: unknown[] = [error];

    for (const path of created.reverse()) {
      try {
        unlinkSync(path);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, "创建分支失败，且部分文件清理失败");
    }
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
