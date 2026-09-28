import { createMcpContent } from "./mcp-content.js";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mountExtension, type ToolRegistry } from "../core/tools.js";

/** 只携带宿主生成的传输错误说明，不透传远端正文。 */
class McpHttpError extends Error {}

/**
 * @file 本地 stdio MCP（Model Context Protocol）扩展接入模块。
 *
 * 核心原理：
 * 1. 外部服务通信：通过 Node.js 子进程启动本地 MCP 演示服务（mcp-demo-server.js），
 *    使用标准输入输出（stdio）传输 JSON-RPC 消息，实现与外部进程的解耦交互。
 * 2. 动态工具发现：连接后通过协议握手获取服务端声明的能力，调用 `listTools` 动态获取
 *    服务端提供的工具名称、描述和参数 Schema，无需在客户端硬编码工具定义。
 * 3. 宿主注册与命名隔离：为避免外部工具与宿主内置工具同名冲突，为发现的工具名统一添加
 *    来源前缀后注册进宿主 ToolRegistry；而在实际向服务发起调用时，还原为原始名称。
 * 4. 健壮的生命周期与回滚：提供异步 `dispose()` 实现幂等安全清理（注销工具 → 关闭 Client →
 *    关闭 Transport 并等待子进程退出）。若初始化握手或发现失败，自动触发反向清理回滚。
 */

/**
 * 连接仓库内本地 stdio MCP 演示服务，并将实际发现的工具动态注册到宿主注册表中。
 *
 * 执行步骤：
 * 1. 创建 MCP Client 与基于 stdio 子进程的 StdioClientTransport。
 * 2. 异步发起连接握手，校验服务端是否支持工具能力（tools capability）。
 * 3. 请求工具列表，并检查是否有多页数据（当前演示阶段严格限制为单页）。
 * 4. 遍历工具定义，进行安全前缀转换和命名合法性校验，将其包装为宿主工具函数并注册。
 * 5. 将生成的工具别名清单与幂等异步释放函数 `dispose` 一同返回给宿主。
 *
 * @param registry 宿主工具注册表，用于将 MCP 工具注册到 Agent 统一调度中心
 * @returns 包含已成功注册到宿主的工具名称列表 `names` 以及异步释放方法 `dispose`
 * @throws {Error} 握手超时、服务未提供工具能力、存在不支持的分页或后台任务、名称不合法、或初始化失败
 */
export async function mountDemoMcp(registry: ToolRegistry) {

  // 建立基于标准输入输出（stdio）的传输层通道：
  // - command: 使用当前 Node.js 运行时可执行文件路径，确保跨平台环境一致性；
  // - args: 定位到编译后的 mcp-demo-server.js 真实文件路径：
  //   * import.meta.url 是 ESM 标准，表示当前模块文件的绝对 URL（类似 Java 的 getResource）；
  //   * fileURLToPath 将 file:// 格式 URL 转为操作系统本地路径，不依赖启动时的当前工作目录；
  // - stderr: "inherit" 让服务端的调试与错误日志直接打印到父进程控制台，不干扰 stdout 的协议流。
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp-demo-server.js", import.meta.url))],
    stderr: "inherit",
  });

  return mountMcp(registry, transport, "mcp_demo_");
}

/** 只连接显式指定的本机演示地址，不跟随重定向，不发送模型凭据。 */
export async function mountHttpMcp(registry: ToolRegistry, address: string) {
  if (!/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/.test(address)) {
    throw new Error("MCP HTTP 地址必须是 http://127.0.0.1:<端口>/mcp");
  }
  const url = new URL(address);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { redirect: "error" },
    // 每个 HTTP 请求有上限，尤其是没有 RequestOptions 的 DELETE 会话终止请求。
    fetch: async (input, init) => {
      const timeout = AbortSignal.timeout(5000);
      try {
        return await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), timeout]),
        });
      } catch (cause) {
        const message = timeout.aborted ? "MCP HTTP 请求超时（5 秒）" : "MCP HTTP 连接失败";
        throw new McpHttpError(message, { cause });
      }
    },
  });
  try {
    return await mountMcp(registry, transport, "mcp_http_", () => transport.terminateSession());
  } catch (cause) {
    // SDK HTTP 错误含响应正文；启动错误同样不能把它直接打印到终端。
    throw new Error("MCP HTTP 初始化失败，请检查服务状态与地址", { cause });
  }
}

/** 两种传输共用发现、注册、权限后的执行与回滚；HTTP 在关闭连接前终止会话。 */
async function mountMcp(registry: ToolRegistry, transport: Transport, prefix: string, terminate?: () => Promise<void>) {
  const client = new Client({ name: "lcn-agent", version: "1.0.0" });
  let unmount: (() => void) | undefined;
  let disposal: Promise<void> | undefined;

  // 监听传输层的底层真实关闭事件：
  // MCP SDK 在初始化失败或主动关闭时会触发该事件。将其封装为 Promise，
  // 便于清理时配合 Promise.race 确认子进程确实已经终止，防止残留僵尸进程。
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve;
  });

  /**
   * 异步释放 MCP 相关的全部运行时资源。
   *
   * 清理顺序严格按照依赖的反向执行：
   * 1. unmount?.(): 可选链调用（Optional Chaining），若 unmount 存在才执行，等价于 if (unmount) unmount()；
   *    从宿主注册表中注销所有已注册的 MCP 工具，防止 Agent 继续调用；
   * 2. client.close(): 关闭当前 transport（并不发送通用的断开通知）；
   * 3. transport.close(): 关闭 stdio 数据流管道，向子进程发送终止信号。
   *
   * 容错设计：每一步均采用独立 try-catch 包裹，确保前一步失败不会阻断后续资源的释放；
   * 最后通过 Promise.race 等待底层子进程退出（最多等待 5 秒超时），如有失败统一汇总抛出。
   */
  async function cleanup(): Promise<void> {
    const errors: unknown[] = [];
    for (const action of [() => unmount?.(), () => terminate?.(), () => client.close(), () => transport.close()]) {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    }

    // 最多等待 5 秒确认底层子进程完全退出，避免因为子进程挂起导致宿主退出时永久卡死。
    // 注：Promise<never> 中 never 是 TS 泛型，表示该分支绝不会正常 resolve 成功，只会因超时而 reject 失败；
    // 回调首参数下划线 _ 表示接收但忽略未使用的 resolve 函数。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("未确认 MCP 传输关闭")), 5000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
    }
    // 若任一释放阶段产生错误，抛出 AggregateError 汇总全部异常（Node.js 标准聚合异常，
    // 类似于 Java 中把多个 Suppressed Exception 包装后一次性抛出），便于排查哪些环节未彻底释放。
    if (errors.length) {
      throw new AggregateError(errors, "MCP 清理失败，部分资源可能尚未释放");
    }
  }

  /**
   * 幂等的对外清理入口。
   *
   * 语法解析：
   * `??=` 为空值合并赋值运算符（Nullish Coalescing Assignment）。
   * 等价于：if (disposal === null || disposal === undefined) disposal = cleanup();
   * 用于懒加载并缓存同一个清理 Promise，保证无论并发还是多次调用 dispose() 都只执行一次清理，
   * 且所有调用方都等待同一个清理过程并保留初次结果（类似 Java 的单例/双重检查锁）。
   */
  function dispose(): Promise<void> {
    return (disposal ??= cleanup());
  }

  try {
    // 发起连接与协议握手，设置 5 秒超时时间，避免服务不存在或无响应时一直阻塞。
    await client.connect(transport, { timeout: 5000 });
    // 获取服务端提供的所有工具清单；同样配置 5 秒超时保护。
    const discovered = client.getServerCapabilities()?.tools
      ? await client.listTools(undefined, { timeout: 5000 }) : { tools: [], nextCursor: undefined };

    // ponytail: 本步仅接固定演示服务；收到分页明确拒绝，接通用服务时再遍历游标。
    if (discovered.nextCursor !== undefined) {
      throw new Error("本地演示接入暂不支持工具分页");
    }

    const names: string[] = [];

    // mountExtension 会管理扩展在宿主中的注册生命周期，返回的 unmount 函数可一次性注销该扩展的所有工具。
    const content = createMcpContent(client, prefix, () => disposal === undefined);
    unmount = mountExtension(registry, (api) => {
      for (const tool of discovered.tools) {
        // 宿主命名规范：stdio 使用 mcp_demo_，HTTP 使用 mcp_http_；原名称不变。
        // 调用远程服务时，依然透传服务原名 tool.name。
        const name = `${prefix}${tool.name}`;
        // 校验工具名是否满足 OpenAI Function Calling 及宿主的命名安全字符集限制（字母数字下划线减号，1-64 位）。
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
          throw new Error("MCP 工具名不符合宿主命名限制");
        }
        // 阶段 8 约束：目前仅支持同步调用，暂不支持 MCP 规范中需要长时间运行的后台任务工具。
        if (tool.execution?.taskSupport === "required") {
          throw new Error("暂不支持 MCP 后台任务工具");
        }

        // 向宿主注册工具：包括 OpenAI 格式的函数定义与异步执行函数。
        api.registerTool({
          definition: {
            type: "function",
            function: { name, description: tool.description, parameters: tool.inputSchema },
          },
          async execute(args, context) {
            // 防御性校验：模型传入并经 Schema 校验后的参数必须是普通对象，不能是数组或 null。
            if (typeof args !== "object" || args === null || Array.isArray(args)) {
              throw new Error("MCP 工具参数必须是对象");
            }
            // 执行前检查取消信号：若用户在授权阶段或排队期间已按 Ctrl+C 或发生超时，立即中止。
            context.signal.throwIfAborted();
            // 语法说明：Awaited<ReturnType<Client["callTool"]>> 是 TypeScript 高级类型推导：
            // - Client["callTool"] 取出 SDK 中 callTool 方法的函数签名；
            // - ReturnType 提取该方法的返回值类型（即 Promise<CallToolResult>）；
            // - Awaited 剥离 Promise 外壳，得到异步方法完成后的实际返回数据结构，无需手工写繁琐的 interface。
            let result: Awaited<ReturnType<Client["callTool"]>>;

            try {
              // 实际通过 MCP Client 调用远程/子进程工具：
              // - 传入服务端真实工具名 tool.name 和参数对象；
              // - args as Record<string, unknown>：Record<string, unknown> 相当于 Java 中的 Map<String, Object>，
              //   as 是 TypeScript 类型断言（强转），告诉编译器已知 args 为普通键值对对象；
              // - 透传宿主的 context.signal 实现协作式网络/子进程请求取消；
              // - 设置 30 秒超时上限，防止外部工具无限期挂起阻塞 Agent。
              result = await client.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { signal: context.signal, timeout: 30_000 },
              );
            } catch (cause) {
              // 若本次调用是被主动取消打断，优先响应 AbortError。
              context.signal.throwIfAborted();
              // 错误脱敏：外部进程或网络异常可能包含内部敏感路径或未格式化堆栈，统一转换为受控业务错误。
              const reason = cause instanceof McpHttpError
                ? cause.message
                : cause instanceof McpError && cause.code === ErrorCode.RequestTimeout
                  ? "MCP 请求超时（30 秒）"
                  : "MCP 调用失败";
              throw new Error(`${reason}：${name}；已发生的副作用不保证撤销`, { cause });
            }

            // 调用返回后再次检查取消信号，避免在取消后仍向下解析和返回结果。
            context.signal.throwIfAborted();
            // MCP 协议规定服务端业务失败通过 isError: true 显式标识。
            if (result.isError === true) {
              throw new Error(`MCP 工具报告失败：${name}`);
            }

            // 结果格式校验：当前阶段仅支持标准的纯文本内容块，结构化或二进制内容暂不接入。
            if (!Array.isArray(result.content)) {
              throw new Error("MCP 响应缺少内容列表");
            }
            if (result.structuredContent !== undefined) {
              throw new Error("本步暂不支持 MCP 结构化结果");
            }
            // 提取所有文本块的内容并以换行符拼接，作为工具输出返回给模型上下文。
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
      content.register(api);
    });

    return { names: Object.freeze(names), dispose, prompt: content.prompt };
  } catch (error) {
    // 事务性安全保证：初始化期间无论在握手、发现还是注册环节出现任何异常，
    // 都必须自动执行反向清理并等待关闭，杜绝子进程遗留或半注册状态。
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "MCP 初始化与清理均失败");
    }
    throw error;
  }
}
