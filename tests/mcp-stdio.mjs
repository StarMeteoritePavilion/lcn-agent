import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createToolRegistry } from "../dist/core/tools.js";
import { mountDemoMcp } from "../dist/extensions/mcp.js";

/**
 * @file 本地 stdio MCP 协议与宿主接入集成测试脚本。
 *
 * 测试目标分为两个层次：
 * 1. 协议层基础通信：直接使用 MCP SDK 启动子进程，验证 stdio 握手、工具列表发现与原生调用。
 * 2. 宿主层集成能力：通过 `mountDemoMcp` 将工具接入宿主注册表，验证参数 Schema 强校验、
 *    用户授权拦截、真实执行与结果回填、协作式取消信号中断、工具命名冲突防护以及幂等卸载。
 */

const serverPath = fileURLToPath(new URL("../dist/mcp-demo-server.js", import.meta.url));

// ---------------------------------------------------------------------------
// 第一部分：原生 MCP SDK 协议通信检查（独立验证服务进程的基本可用性）
// ---------------------------------------------------------------------------

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

  // 验证服务端返回的元数据与能力声明（必须声明具备 tools 特性）
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

  // 验证返回结果没有业务错误，且包含预期的文本块
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: "本地 MCP 服务已连通",
    },
  ]);

  console.log("工具返回：本地 MCP 服务已连通");
} finally {
  // 服务连接属于异步资源，无论断言成功与否都必须等待关闭，避免残留孤儿进程。
  try {
    await client.close();
  } finally {
    await transport.close();
  }
}

console.log("本地 stdio MCP 基础检查通过");

// ---------------------------------------------------------------------------
// 第二部分：宿主注册表集成检查（验证挂载、Schema 先于授权、用户审批、取消、防重名与注销）
// ---------------------------------------------------------------------------

let allowed = false;
let confirmations = 0;

// 创建测试用工具注册表：策略配置为将所有待执行工具转发给 context.confirm 进行权限确认
const registry = createToolRegistry((name, json, context) =>
  context.confirm(name, json, context.callId, context.signal),
);

// 构造模拟的宿主调用上下文
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

// 执行挂载：连接本地 MCP 演示服务并将工具注册到 registry
const mcp = await mountDemoMcp(registry);
try {
  // 1. 验证工具定义：工具名被自动添加前缀 mcp_demo_，Schema 和参数结构正确透传
  const [definition] = registry.definitions();
  assert.equal(definition.function.name, "mcp_demo_demo_status");
  assert.deepEqual(definition.function.parameters, { type: "object", properties: {} });
  assert.deepEqual(mcp.names, [definition.function.name]);

  // 2. 关键安全设计：Schema 参数格式校验必须发生在授权检查之前！
  // 传入非法的空数组 [] 作为参数：应直接被 Ajv 拦截，confirmations 保持为 0，不骚扰用户授权
  await assert.rejects(registry.execute(mcp.names[0], [], context), /不符合 Schema/);
  assert.equal(confirmations, 0);

  // 3. 授权拦截：参数合法但用户拒绝（allowed = false），应拒绝执行，此时 confirmations 增为 1
  await assert.rejects(registry.execute(mcp.names[0], {}, context), /未获授权/);
  assert.equal(confirmations, 1);

  // 4. 正常授权执行：用户同意授权（allowed = true），成功调用外部服务并返回文本结果
  allowed = true;
  assert.equal(await registry.execute(mcp.names[0], {}, context), "本地 MCP 服务已连通");
  assert.equal(confirmations, 2);

  // 5. 协作取消信号拦截：
  // 语法说明：{ ...context, signal: AbortSignal.abort() } 利用对象展开（Spread）浅拷贝原 context 并
  // 替换其中的 signal 属性，相当于生成一个带取消信号的副本（类似 Java 不可变对象的 withSignal 方法）。
  // 传入已触发 abort 的 signal 时，应在执行前立即拒绝，且不发起新的确认。
  const aborted = { ...context, signal: AbortSignal.abort() };
  await assert.rejects(registry.execute(mcp.names[0], {}, aborted));
  assert.equal(confirmations, 2);

  // 6. 重名冲突防御：向同一注册表重复接入相同工具时必须报错回滚，不覆盖原有工具，现有工具仍可调用
  await assert.rejects(mountDemoMcp(registry), /工具重名/);
  assert.equal(await registry.execute(mcp.names[0], {}, context), "本地 MCP 服务已连通");
} finally {
  // 7. 退出前调用 dispose 关闭 MCP 连接与释放注册项
  await mcp.dispose();
}

// 8. 验证清理幂等性与注销完整性：再次 dispose 不会报错，注册表中工具被清空，再次调用报未知工具
await mcp.dispose();
assert.deepEqual(registry.definitions(), []);
await assert.rejects(registry.execute(mcp.names[0], {}, context), /未知工具/);
console.log("MCP 宿主注册、校验、授权、调用和卸载检查通过");
