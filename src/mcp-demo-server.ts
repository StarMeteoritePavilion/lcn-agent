import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * 本地 MCP 演示服务：用 stdio 和宿主交换 JSON-RPC，先验证通信是否接通。
 *
 * MCP（Model Context Protocol）让外部进程向 Agent 提供工具。
 * 本文件是独立进程的入口，不 import 本仓库的 core/extensions。
 * 单独启动，例如：node dist/mcp-demo-server.js
 *
 * 本节点只验证通信，工具返回固定文本，不访问文件或网络。
 */
const server = new McpServer({
  // name / version 会出现在 MCP initialize 握手里，方便宿主识别这是哪个服务。
  name: "lcn-demo-server",
  version: "1.0.0",
});

// 本项目新增演示内容：固定资源和无参数提示，用于验证用户显式选择。
server.registerResource("demo_notes", "demo://notes", { mimeType: "text/plain" }, async (uri) => ({
  contents: [{ uri: uri.href, text: "MCP 演示资料：工具调用必须经过宿主审批。" }],
}));
server.registerPrompt("demo_summary", { description: "总结 MCP 演示资料" }, async () => ({
  messages: [{ role: "user", content: { type: "text", text: "请解释 MCP 资源、提示与工具的区别。" } }],
}));

server.registerTool(
  // 参数 1 name: 工具名，宿主把它登记成可被模型调用的名字。
  "demo_status",
  {
    // 参数 2 config: 给模型看的说明书。这里没有 parameters，调用时不传参。
    description: "返回本地 MCP 演示服务的固定状态",
  },
  // 参数 3 handler: 被调用时执行。返回 MCP 内容列表，不是普通字符串。
  async () => ({
    content: [
      {
        type: "text",
        text: "本地 MCP 服务已连通",
      },
    ],
  }),
);

// stdout 专门传输 MCP 消息，普通日志只能写 stderr。
// StdioServerTransport：从 stdin 读请求、往 stdout 写响应，直到进程退出。
await server.connect(new StdioServerTransport());
