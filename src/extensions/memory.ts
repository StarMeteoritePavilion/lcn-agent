import type { ExtensionAPI } from "../core/tools.js";
import { addMemory, deleteMemory, readMemories } from "../core/memory.js";

/**
 * 项目记忆只提供用户命令，不注册模型写入工具。
 *
 * - /memory：列出当前项目记忆；不能带参数。
 * - /memory_add 正文：追加一条；规划模式下列入禁止名单。
 * - /memory_delete 编号：按完整 UUID 删除。
 *
 * 记忆按项目落盘，切换会话仍能看到同一份列表。
 * 由 workflow.ts 默认装载。
 *
 * @param api 此处只解构 registerCommand
 */
export default function registerMemory({ registerCommand }: ExtensionAPI): void {
  registerCommand({
    name: "memory",
    execute(args, context) {
      if (args.trim()) throw new Error("用法：/memory");
      context.signal.throwIfAborted();
      const items = readMemories(context.cwd);
      return items.length ? JSON.stringify(items, null, 2) : "当前项目暂无记忆";
    },
  });

  registerCommand({
    name: "memory_add",
    execute(args, context) {
      // args 是 `/memory_add` 后面的整段文本，原样交给 addMemory。
      return addMemory(context.cwd, args, context.signal);
    },
  });

  registerCommand({
    name: "memory_delete",
    execute(args, context) {
      return deleteMemory(context.cwd, args.trim(), context.signal);
    },
  });
}
