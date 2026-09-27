import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(
  new URL("../dist/mcp-demo-server.js", import.meta.url),
);

const client = new Client({
  name: "lcn-stdio-check",
  version: "1.0.0",
});

const transport = new StdioClientTransport({
  // 使用当前 Node 的实际绝对路径，不猜测安装位置。
  command: process.execPath,
  args: [serverPath],
  stderr: "inherit",
});

try {
  // connect 会启动子进程并执行 MCP 初始化握手。
  await client.connect(transport, { timeout: 5000 });

  assert.equal(client.getServerVersion()?.name, "lcn-demo-server");
  assert.ok(client.getServerCapabilities()?.tools);

  // 工具名称和 Schema 从服务发现，不在客户端重写定义。
  const discovered = await client.listTools(undefined, { timeout: 5000 });
  assert.equal(discovered.nextCursor, undefined);
  assert.equal(discovered.tools.length, 1);

  const tool = discovered.tools[0];
  assert.equal(tool.name, "demo_status");
  assert.equal(tool.inputSchema.type, "object");

  console.log("已发现工具：", tool.name);
  console.log("服务返回的参数结构：", JSON.stringify(tool.inputSchema));

  // callTool 的第二个参数是可选结果 Schema，请求选项在第三个参数。
  const result = await client.callTool(
    { name: tool.name, arguments: {} },
    undefined,
    { timeout: 5000 },
  );

  assert.notEqual(result.isError, true);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "本地 MCP 服务已连通",
    },
  ]);

  console.log("工具返回：本地 MCP 服务已连通");
} finally {
  // 服务连接属于异步资源，必须等待关闭。
  try {
    await client.close();
  } finally {
    await transport.close();
  }
}

console.log("本地 stdio MCP 基础检查通过");
