import assert from "node:assert/strict";
import { createToolRegistry } from "../dist/core/tools.js";
import { createMcpContent } from "../dist/extensions/mcp-content.js";
import { mountDemoMcp } from "../dist/extensions/mcp.js";

const registry = createToolRegistry();
const mcp = await mountDemoMcp(registry);
const context = {
  cwd: process.cwd(), model: "test", sessionFile: null, signal: new AbortController().signal,
  ui: { notify() {}, ask: async () => { throw new Error("不应自行提问"); } },
};
try {
  const resources = JSON.parse(await registry.executeCommand("mcp_demo_resources", "", context));
  assert.equal(resources[0].uri, "demo://notes");
  const resource = JSON.parse(await registry.executeCommand("mcp_demo_resource", resources[0].uri, context));
  assert.equal(resource.contents[0].text, "MCP 演示资料：工具调用必须经过宿主审批。");
  await assert.rejects(registry.executeCommand("mcp_demo_resource", "demo://NOTES", context), /不在当前清单/);
  const prompts = JSON.parse(await registry.executeCommand("mcp_demo_prompts", "", context));
  assert.equal(prompts[0].name, "demo_summary");
  const text = await mcp.prompt('{"name":"demo_summary","arguments":{}}', context.signal);
  assert.equal(JSON.parse(text).messages[0].content.text, "请解释 MCP 资源、提示与工具的区别。");
  await assert.rejects(mcp.prompt('{"name":"DEMO_SUMMARY"}', context.signal), /不在当前清单/);
  await assert.rejects(mcp.prompt('{"name":"demo_summary","arguments":{"extra":"x"}}', context.signal));
  await assert.rejects(mcp.prompt('{"name":"demo_summary"}', AbortSignal.abort()));
  assert.deepEqual(registry.definitions().map((tool) => tool.function.name), ["mcp_demo_demo_status"]);
} finally {
  await mcp.dispose();
}
await assert.rejects(registry.executeCommand("mcp_demo_resources", "", context), /未知命令/);
await assert.rejects(mcp.prompt('{"name":"demo_summary"}', context.signal), /已卸载/);
console.log("MCP 内容目录、资源、提示、精确选择、取消和卸载检查通过");

// 边界响应由固定桩提供，断言宿主拒绝不完整清单、二进制、超量内容和缺失能力。
let result = { prompts: [{ name: "p", arguments: [{ name: "topic", required: true }] }] };
let messages = [{ role: "user", content: { type: "text", text: "ok" } }];
const fake = {
  getServerCapabilities: () => ({ prompts: {} }),
  listPrompts: async () => result,
  getPrompt: async () => ({ messages }),
};
const content = createMcpContent(fake, "test_", () => true);
await assert.rejects(content.prompt('{"name":"p"}', context.signal), /参数缺失/);
messages = [{ role: "user", content: { type: "image", data: "x", mimeType: "image/png" } }];
await assert.rejects(content.prompt('{"name":"p","arguments":{"topic":"x"}}', context.signal), /纯文本/);
messages = [{ role: "user", content: { type: "text", text: "x".repeat(65536) } }];
await assert.rejects(content.prompt('{"name":"p","arguments":{"topic":"x"}}', context.signal), /64 KiB/);
result = { prompts: [], nextCursor: "more" };
await assert.rejects(content.prompt('{"name":"p"}', context.signal), /分页/);
fake.getServerCapabilities = () => ({});
await assert.rejects(content.prompt('{"name":"p"}', context.signal), /prompts 能力/);
console.log("MCP 提示参数、内容类型、大小、分页与能力边界检查通过");
