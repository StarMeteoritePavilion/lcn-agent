import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createToolRegistry } from "../dist/core/tools.js";
import { mountDemoMcp, mountHttpMcp } from "../dist/extensions/mcp.js";

const serverPath = fileURLToPath(new URL("../dist/mcp-http-demo-server.js", import.meta.url));
const child = spawn(process.execPath, [serverPath], { stdio: ["ignore", "pipe", "inherit"] });
// 提前登记关闭事件，避免退出发生在等待之前；正常与失败路径均有截止时间。
const exited = once(child, "close");
void exited.catch(() => {});
let mcp;
let stdio;
let timer;
try {
  const port = await new Promise((resolve, reject) => {
    let output = "";
    timer = setTimeout(() => reject(new Error("HTTP MCP 服务启动超时")), 5000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("HTTP MCP 服务提前退出")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /^MCP_HTTP_PORT=(\d+)\r?\n/m.exec(output);
      if (match) resolve(Number(match[1]));
    });
  });
  clearTimeout(timer);
  const address = `http://127.0.0.1:${port}/mcp`;
  let allowed = false;
  let confirmations = 0;
  const registry = createToolRegistry((name, json, context) =>
    context.confirm(name, json, context.callId, context.signal),
  );
  const context = {
    cwd: process.cwd(), model: "local-test", sessionFile: "http-check.jsonl", callId: "http_1",
    signal: new AbortController().signal,
    confirm: async () => { confirmations++; return allowed; },
  };
  for (const invalid of ["", "https://127.0.0.1:80/mcp", "http://localhost:80/mcp", `${address}?key=secret`]) {
    await assert.rejects(mountHttpMcp(registry, invalid), /MCP HTTP 地址/);
  }
  stdio = await mountDemoMcp(registry);
  mcp = await mountHttpMcp(registry, address);
  assert.deepEqual(mcp.names, ["mcp_http_http_status"]);
  assert.equal(registry.definitions().length, 2);
  assert.deepEqual(registry.definitions()[1].function.parameters, { type: "object", properties: {} });
  await assert.rejects(registry.execute(mcp.names[0], [], context), /Schema/);
  assert.equal(confirmations, 0);
  await assert.rejects(registry.execute(mcp.names[0], {}, context), /未获授权/);
  allowed = true;
  assert.equal(await registry.execute(mcp.names[0], {}, context), "本地 MCP Streamable HTTP 服务已连通");
  assert.equal(await registry.execute(stdio.names[0], {}, context), "本地 MCP 服务已连通");
  const count = confirmations;
  await assert.rejects(registry.execute(mcp.names[0], {}, { ...context, signal: AbortSignal.abort() }));
  assert.equal(confirmations, count);
  const commandContext = { ...context, ui: { notify() {}, ask: async () => "n" } };
  const resources = JSON.parse(await registry.executeCommand("mcp_http_resources", "", commandContext));
  assert.equal(resources[0].uri, "demo://notes");
  assert.match(await registry.executeCommand("mcp_http_resource", "demo://notes", commandContext), /MCP 演示资料/);
  assert.equal(JSON.parse(await mcp.prompt('{"name":"demo_summary"}', context.signal)).source, "mcp_http_");
  const disposal = mcp.dispose();
  assert.equal(mcp.dispose(), disposal);
  await disposal;
  assert.equal(registry.definitions().length, 1);
  // DELETE 后单会话演示服务返回 404，但监听进程仍由测试自己管理。
  const response = await fetch(address, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 404);
  await response.body?.cancel();
  console.log("HTTP MCP 宿主发现、Schema、审批、调用、stdio 共存与会话终止检查通过");
} finally {
  clearTimeout(timer);
  try {
    try { await mcp?.dispose(); } finally { await stdio?.dispose(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally {
      clearTimeout(killTimer);
    }
  }
}
