import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createToolRegistry } from "../dist/core/tools.js";
import { mountHttpMcp } from "../dist/extensions/mcp.js";

// 每个场景启动独立服务，故障不污染其他会话；使用真实 HTTP 和 SDK。
for (const scenario of ["cancel", "budget", "timeout", "disconnect", "business"]) {
  const server = new McpServer({ name: "failure-check", version: "1.0.0" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  let cancelled = false;
  server.registerTool("probe", {}, async (extra) => {
    calls++;
    started();
    if (scenario === "business") return { isError: true, content: [{ type: "text", text: "PRIVATE_ERROR" }] };
    try {
      await delay(60_000, undefined, { signal: extra.signal });
    } catch {
      cancelled = true;
    }
    return { content: [{ type: "text", text: "迟到结果" }] };
  });
  await server.connect(transport);
  const http = createServer((req, res) => {
    void transport.handleRequest(req, res).catch(() => res.destroy());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const registry = createToolRegistry(() => true);
  const mcp = await mountHttpMcp(registry, `http://127.0.0.1:${http.address().port}/mcp`);
  const abort = new AbortController();
  const context = { cwd: process.cwd(), model: "test", sessionFile: "test.jsonl", callId: "1",
    confirm: async () => true, signal: abort.signal };
  try {
    const result = registry.execute(mcp.names[0], {}, context).catch((error) => error);
    await entered;
    if (scenario === "cancel") abort.abort(new Error("用户取消"));
    if (scenario === "budget") abort.abort(new DOMException("本轮预算耗尽", "TimeoutError"));
    if (scenario === "disconnect") http.closeAllConnections();
    const error = await result;
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("PRIVATE_ERROR"));
    if (scenario === "cancel" || scenario === "budget") {
      assert.equal(error, abort.signal.reason);
      for (let i = 0; i < 100 && !cancelled; i++) await delay(10);
      assert.equal(cancelled, true, "服务应收到取消通知");
    } else {
      const expected = { timeout: /MCP HTTP 请求超时/, disconnect: /MCP HTTP 连接失败/, business: /工具报告失败/ };
      assert.match(error.message, expected[scenario]);
    }
    assert.equal(calls, 1, "不能自动重放工具");
    console.log(`MCP 故障检查通过：${scenario}`);
  } finally {
    try {
      await mcp.dispose();
      assert.deepEqual(registry.definitions(), []);
    } finally {
      await server.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  }
}

// 初始化错误不泄露服务正文；清理失败也必须撤销全部注册项并保持幂等。
for (const scenario of ["initialize", "delete"]) {
  const server = new McpServer({ name: "cleanup-check", version: "1.0.0" });
  server.registerTool("probe", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);
  const http = createServer((req, res) => {
    if (scenario === "initialize" || req.method === "DELETE") {
      res.writeHead(503).end("PRIVATE_ERROR");
    } else {
      void transport.handleRequest(req, res).catch(() => res.destroy());
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const registry = createToolRegistry(() => true);
  try {
    const address = `http://127.0.0.1:${http.address().port}/mcp`;
    if (scenario === "initialize") {
      await assert.rejects(mountHttpMcp(registry, address), (error) => {
        assert.ok(!error.message.includes("PRIVATE_ERROR"));
        return true;
      });
    } else {
      const mcp = await mountHttpMcp(registry, address);
      const disposal = mcp.dispose();
      await assert.rejects(disposal, /MCP 清理失败/);
      assert.equal(mcp.dispose(), disposal);
    }
    assert.deepEqual(registry.definitions(), []);
    console.log(`MCP 故障检查通过：${scenario}`);
  } finally {
    await server.close();
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
}
