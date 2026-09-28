import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mountExtension, type ToolRegistry } from "../core/tools.js";

/** 连接仓库内演示服务，再将实际发现的工具装入宿主；连接由返回的 dispose 异步关闭。 */
export async function mountDemoMcp(registry: ToolRegistry) {
  const client = new Client({ name: "lcn-agent", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp-demo-server.js", import.meta.url))],
    stderr: "inherit",
  });

  let unmount: (() => void) | undefined;
  let disposal: Promise<void> | undefined;

  // SDK 初始化失败时会自行发起关闭；另等真实 close 通知，避免第二次 close 提前返回。
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });

  /** 先移除注册项，再关闭连接；每一步都尝试，最后汇总错误。 */
  async function cleanup(): Promise<void> {
    const errors: unknown[] = [];
    for (const action of [() => unmount?.(), () => client.close(), () => transport.close()]) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("未确认 MCP 子进程关闭")), 5000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
    }
    if (errors.length) {
      throw new AggregateError(errors, "MCP 清理失败，部分资源可能尚未释放");
    }
  }

  // 缓存 Promise：重复或并发清理都等待同一次操作，也保留第一次清理的失败结果。
  function dispose(): Promise<void> {
    return (disposal ??= cleanup());
  }

  try {
    await client.connect(transport, { timeout: 5000 });
    if (!client.getServerCapabilities()?.tools) {
      throw new Error("MCP 服务未声明工具能力");
    }
    const discovered = await client.listTools(undefined, { timeout: 5000 });

    // ponytail: 本步仅接固定演示服务；收到分页明确拒绝，接通用服务时再遍历游标。
    if (discovered.nextCursor !== undefined) {
      throw new Error("本地演示接入暂不支持工具分页");
    }

    const names: string[] = [];

    unmount = mountExtension(registry, (api) => {
      for (const tool of discovered.tools) {
        // 新增宿主命名约定：加固定来源前缀，原始名称不改写；调用服务时仍用 tool.name。
        const name = `mcp_demo_${tool.name}`;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
          throw new Error("MCP 工具名不符合宿主命名限制");
        }
        if (tool.execution?.taskSupport === "required") {
          throw new Error("暂不支持 MCP 后台任务工具");
        }

        api.registerTool({
          definition: {
            type: "function",
            function: { name, description: tool.description, parameters: tool.inputSchema },
          },
          async execute(args, context) {
            if (typeof args !== "object" || args === null || Array.isArray(args)) {
              throw new Error("MCP 工具参数必须是对象");
            }
            context.signal.throwIfAborted();
            let result: Awaited<ReturnType<Client["callTool"]>>;

            try {
              result = await client.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { signal: context.signal, timeout: 30_000 },
              );
            } catch (cause) {
              context.signal.throwIfAborted();
              // 不把 SDK 或外部服务的任意错误正文写入会话和诊断。
              throw new Error(`MCP 调用失败：${name}`, { cause });
            }

            context.signal.throwIfAborted();
            if (result.isError === true) {
              throw new Error(`MCP 工具报告失败：${name}`);
            }

            if (!Array.isArray(result.content)) {
              throw new Error("MCP 响应缺少内容列表");
            }
            if (result.structuredContent !== undefined) {
              throw new Error("本步暂不支持 MCP 结构化结果");
            }
            return result.content
              .map((block) => {
                if (block.type !== "text" || typeof block.text !== "string") {
                  throw new Error("本步暂不支持 MCP 非文本结果");
                }
                return block.text;
              })
              .join("\n");
          },
        });
        names.push(name);
      }
    });

    return { names, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MCP 初始化与清理均失败");
    }
    throw error;
  }
}
