import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createToolRegistry } from "../dist/core/tools.js";
import { mountDemoMcp } from "../dist/extensions/mcp.js";

const serverPath = fileURLToPath(new URL("../dist/mcp-demo-server.js", import.meta.url));

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
  const result = await client.callTool({ name: tool.name, arguments: {} }, undefined, {
    timeout: 5000,
  });

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

let allowed = false;
let confirmations = 0;
const registry = createToolRegistry((name, json, context) =>
  context.confirm(name, json, context.callId, context.signal),
);
const context = {
  cwd: process.cwd(),
  model: "local-test",
  sessionFile: "mcp-check.jsonl",
  callId: "mcp_1",
  signal: new AbortController().signal,
  confirm: async () => {
    confirmations++;
    return allowed;
  },
};
const mcp = await mountDemoMcp(registry);
try {
  const [definition] = registry.definitions();
  assert.equal(definition.function.name, "mcp_demo_demo_status");
  assert.deepEqual(definition.function.parameters, { type: "object", properties: {} });
  assert.deepEqual(mcp.names, [definition.function.name]);

  await assert.rejects(registry.execute(mcp.names[0], [], context), /不符合 Schema/);
  assert.equal(confirmations, 0);
  await assert.rejects(registry.execute(mcp.names[0], {}, context), /未获授权/);
  assert.equal(confirmations, 1);

  allowed = true;
  assert.equal(await registry.execute(mcp.names[0], {}, context), "本地 MCP 服务已连通");
  assert.equal(confirmations, 2);

  const aborted = { ...context, signal: AbortSignal.abort() };
  await assert.rejects(registry.execute(mcp.names[0], {}, aborted));
  assert.equal(confirmations, 2);

  // 第二次接入发生重名时必须失败，不能覆盖第一次注册的工具。
  await assert.rejects(mountDemoMcp(registry), /工具重名/);
  assert.equal(await registry.execute(mcp.names[0], {}, context), "本地 MCP 服务已连通");
} finally {
  await mcp.dispose();
}
await mcp.dispose();
assert.deepEqual(registry.definitions(), []);
await assert.rejects(registry.execute(mcp.names[0], {}, context), /未知工具/);
console.log("MCP 宿主注册、校验、授权、调用和卸载检查通过");
