import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * @file 本地 MCP Streamable HTTP 演示服务端。
 *
 * 核心设计与学习目标：
 * 1. 跨进程/跨网络通信：相比 stdio（父子进程标准输入输出管道），HTTP 传输层允许 MCP 服务作为
 *    独立 Web 服务运行，支持远程、跨容器乃至跨机部署，协议层基于 Streamable HTTP 规范交互。
 * 2. 独立服务进程：本文件为完全独立的服务入口，不依赖本仓库的 core/extensions 业务代码，
 *    可通过 `node dist/mcp-http-demo-server.js` 单独启动。
 * 3. 极简有状态验证：当前阶段验证 HTTP 连接、工具发现与调用的基本闭环，使用一个内存会话。
 */

// 初始化 MCP 服务端实例，声明服务标识与版本号（用于 initialize 握手阶段告知客户端）
const server = new McpServer({
  name: "lcn-http-demo-server",
  version: "1.0.0",
});

// 向 MCP 服务注册可被模型或客户端调用的工具
server.registerTool(
  // 参数 1 name: 工具名称，客户端与大模型通过该名称发现和调用
  "http_status",
  // 参数 2 config: 工具配置与描述（给大模型阅读的说明书）；本工具无需参数，未配置 parameters
  {
    description: "返回本地 MCP Streamable HTTP 演示服务的固定状态",
  },
  // 参数 3 handler: 工具实际执行函数；返回符合 MCP 协议的内容块列表（Content Array）
  async () => ({
    content: [
      {
        type: "text",
        text: "本地 MCP Streamable HTTP 服务已连通",
      },
    ],
  }),
);

// 初始化 Streamable HTTP 服务端传输层：为客户端生成一个内存会话 ID。
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: randomUUID,
});

// 将传输层连接到 MCP Server，完成底层消息分发与协议绑定的初始化
await server.connect(transport);

// SDK 自行读取并限制请求体，避免手工解析绕过其体积限制。
const httpServer = createServer(async (request, response) => {
  // 简单路由隔离：仅处理挂载在 /mcp 路径下的请求，其他路径统一返回 404 Not Found
  if (request.url !== "/mcp") {
    response.statusCode = 404;
    response.end("Not Found");
    return;
  }

  const address = httpServer.address();
  const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
  if (request.headers.host !== host || request.headers.origin !== undefined) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    await transport.handleRequest(request, response);
  } catch {
    // 异常容错保护：若发生未处理异常且响应头尚未发送（headersSent 为 false），则安全返回 500
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end("MCP 请求失败");
    } else {
      response.destroy();
    }
  }
});

// 启动 HTTP 服务监听：
// - 端口传 0：由操作系统自动分配一个随机空闲端口，避免固定端口被占用，支持并行测试；
// - 主机传 "127.0.0.1"：严格限定仅监听本机环回地址，避免在开发与测试期间对外暴露未授权网络服务。
httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();

  // 类型防御保护：在 TCP 监听模式下 address 为 AddressInfo 对象，若为 null 或 string 则表明监听异常
  if (address === null || typeof address === "string") {
    throw new Error("无法取得 HTTP 服务端口");
  }

  // 关键协议输出：将实际分配的动态端口通过 stdout 打印给控制台或父进程，
  // 外部测试脚本或宿主正是通过解析 `MCP_HTTP_PORT=<port>` 获知通信端口的。
  console.log(`MCP_HTTP_PORT=${address.port}`);
});

/**
 * 优雅关闭服务：先关闭 MCP 传输层，再关闭底层 HTTP 服务器，释放占用的端口与连接。
 */
async function close(): Promise<void> {
  await transport.close();

  // 将基于回调的 httpServer.close() 封装为 Promise，便于以 async/await 顺序等待其完全释放
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// 注册操作系统终止信号监听，在收到退出指令时先执行异步优雅关闭，再正常退出进程：
// 语法说明：`void close()` 中 void 运算符用于显式忽略异步 Promise 的返回值，表明无需在此处 await。
process.once("SIGTERM", () => {
  void close().catch(() => {
    console.error("HTTP MCP 服务关闭失败");
    process.exitCode = 1;
    httpServer.closeAllConnections();
  });
});

process.once("SIGINT", () => {
  void close().catch(() => {
    console.error("HTTP MCP 服务关闭失败");
    process.exitCode = 1;
    httpServer.closeAllConnections();
  });
});
