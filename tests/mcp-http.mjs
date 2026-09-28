import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const serverPath = fileURLToPath(new URL("../dist/mcp-http-demo-server.js", import.meta.url));

const child = spawn(process.execPath, [serverPath], {
  stdio: ["ignore", "pipe", "inherit"],
});

let port;
let output = "";
const client = new Client({
  name: "lcn-http-check",
  version: "1.0.0",
});
let transport;

child.stdout.setEncoding("utf8");

const onData = (chunk) => {
  output += chunk;
  const match = /MCP_HTTP_PORT=(\d+)/.exec(output);
  if (match) port = Number(match[1]);
};

child.stdout.on("data", onData);

try {
  await Promise.race([
    once(child.stdout, "data"),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("HTTP MCP 服务启动超时")), 5000);
    }),
  ]);

  while (port === undefined) {
    await once(child.stdout, "data");
  }

  transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  await client.connect(transport, { timeout: 5000 });

  const discovered = await client.listTools(undefined, { timeout: 5000 });
  assert.equal(discovered.nextCursor, undefined);
  assert.equal(discovered.tools.length, 1);
  assert.equal(discovered.tools[0].name, "http_status");
  assert.deepEqual(discovered.tools[0].inputSchema, {
    type: "object",
    properties: {},
  });

  const result = await client.callTool(
    { name: "http_status", arguments: {} },
    undefined,
    { timeout: 5000 },
  );
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "本地 MCP Streamable HTTP 服务已连通",
    },
  ]);

  console.log(`HTTP MCP 服务已监听：${port}`);
  console.log("HTTP MCP 工具发现和调用检查通过");
} finally {
  await client.close();
  await transport?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
}
