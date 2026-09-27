import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ToolContext } from "../core/tools.js";

/**
 * 启动一个经过宿主审批的前台程序。
 *
 * 使用绝对路径指定程序，参数逐项传递，不自动经过 Shell。
 * 最长运行 10 秒，stdout 和 stderr 分别限制为 64 KiB。
 * 不走 Shell 是为了避免 `executable` 或 `args` 被拼成 `rm -rf /` 这类注入。
 *
 * @param executable 可执行文件的绝对路径
 * @param args 逐项传给程序的参数，不会被拼成一行命令
 * @param context 本次工具调用的上下文，使用 cwd 作为工作目录、用 signal 取消
 * @returns Promise，完成后得到 JSON：`{ exitCode, stdout, stderr }`
 *          非零退出码仍算“正常跑完”，会写在 exitCode 里而不是抛错
 * @throws {Error} 启动失败、被信号杀掉、输出超限、超时，或已取消
 */
function runCommand(executable: string, args: string[], context: ToolContext): Promise<string> {
  context.signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    // execFile 直接执行文件，不经过 /bin/sh。
    // 参数 1 file: 可执行文件路径。
    // 参数 2 args: 参数数组，原样传给进程，不会做 Shell 转义。
    // 参数 3 options:
    // - cwd:        子进程工作目录，使用当前 Agent 工作区。
    // - shell:      明确关掉 Shell，即使以后改默认值也不会悄悄打开。
    // - encoding:   stdout / stderr 按 UTF-8 解码成字符串。
    // - timeout:    10 秒后杀掉子进程。
    // - maxBuffer:  任一输出流超过 64 KiB 就终止。
    // - signal:     用户取消或本轮超时时中止子进程。
    // - killSignal: 超时或取消时用 SIGKILL，避免程序忽略 SIGTERM 后继续跑。
    // 参数 4 callback: 进程结束后调用。
    const child = execFile(
      executable,
      args,
      {
        cwd: context.cwd,
        shell: false,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        signal: context.signal,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        // 取消优先，交给宿主按用户取消或本轮超时分类。
        if (context.signal.aborted) {
          reject(context.signal.reason);
          return;
        }

        // 数字 code 表示程序正常结束但返回非零退出码。
        // 启动失败、被信号终止或输出超限不能当作正常退出。
        // （ENOENT、SIGKILL、maxBuffer 等情况下 code 不是 number。）
        if (error && typeof error.code !== "number") {
          reject(
            new Error(`命令未正常完成：${error.code ?? error.signal ?? "执行异常"}`, {
              cause: error,
            }),
          );
          return;
        }

        resolve(
          JSON.stringify({
            exitCode: error?.code ?? 0,
            stdout,
            stderr,
          }),
        );
      },
    );

    // 当前工具不支持交互输入，立即关闭 stdin，避免程序等待输入。
    child.stdin?.end();
  });
}

/**
 * 前台命令扩展：注册工具 run_command，在工作目录运行用户确认过的程序。
 *
 * 本扩展只负责绝对路径、参数数组和超时；是否真正执行由宿主权限入口决定
 * （index.ts 里 run_command 走逐次确认，不在自动允许名单中）。
 *
 * 使用默认导出供组合入口复用，当前由 workflow.ts 默认装载；不要重复配置外部加载。
 *
 * @param api 宿主提供的扩展 API；本扩展只注册工具，因此只解构 registerTool
 */
export default function registerCommands({ registerTool }: ExtensionAPI): void {
  registerTool({
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "经用户确认，在当前工作目录运行指定程序；须提供可执行文件绝对路径和参数数组，最长 10 秒",
        parameters: {
          type: "object",
          properties: {
            executable: {
              type: "string",
              minLength: 1,
              description: "可执行文件的绝对路径",
            },
            args: {
              type: "array",
              items: { type: "string" },
              maxItems: 64,
              description: "逐项传递的参数，不拼接为 Shell 命令",
            },
          },
          required: ["executable", "args"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      // 宿主已经校验 Schema；这里收窄 unknown，并检查路径及空字符。
      // Schema 保证形状，不能替我们判断“是不是绝对路径、有没有 \0”。
      if (
        typeof args !== "object" ||
        args === null ||
        !("executable" in args) ||
        typeof args.executable !== "string" ||
        !("args" in args) ||
        !Array.isArray(args.args)
      ) {
        throw new Error("run_command 参数必须包含 executable 和 args");
      }

      const executable = args.executable;
      // 相对路径会依赖 PATH / cwd，容易跑到工作区外的程序；\0 会截断 C 字符串路径。
      if (!isAbsolute(executable) || executable.includes("\0")) {
        throw new Error("executable 必须是无空字符的绝对路径");
      }

      const commandArgs = args.args.map((value: unknown) => {
        if (typeof value !== "string" || value.includes("\0")) {
          throw new Error("命令参数必须是无空字符的字符串");
        }
        return value;
      });

      return runCommand(executable, commandArgs, context);
    },
  });
}
