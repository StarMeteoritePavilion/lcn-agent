import assert from "node:assert/strict";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";
import registerSearch, { searchWeb } from "../dist/extensions/search.js";

/**
 * @file 受限网页搜索（search_web）单元与集成测试。
 *
 * 验证维度：
 * 1. Mock Fetch 请求规范：验证调用 Tavily API 时的鉴权头、POST 方法、重定向策略与固定参数；
 * 2. 宿主注册与权限拦截：验证 Schema 参数强校验先于用户授权、用户拒绝执行、授权成功执行；
 * 3. 结果脱敏与安全边界：验证输出不包含 API Key、空查询/预取消拦截、缺失凭据报错、HTTP 429 处理、
 *    非标准协议链接拦截、256 KiB 响应体积熔断，以及底层网络异常正文与凭据的脱敏隔离。
 */

// 保存全局原始 fetch 与环境变量，在测试结束的 finally 中完整复原，避免测试污染
const originalFetch = globalThis.fetch;
const originalKey = process.env.TAVILY_API_KEY;
const signal = new AbortController().signal;
let calls = 0;

// 默认模拟返回的正常搜索结果
let reply = () =>
  Response.json({
    results: [{ title: "Node.js", url: "https://nodejs.org/", content: "官方文档" }],
  });

try {
  // 设置测试用 API Key 并打桩替换全局 fetch
  process.env.TAVILY_API_KEY = "test-key";
  globalThis.fetch = async (url, options) => {
    calls++;
    // 严格校验发往 Tavily 接口的请求结构与安全配置
    assert.equal(url, "https://api.tavily.com/search");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error"); // 严禁重定向
    assert.equal(options.headers.Authorization, "Bearer test-key"); // 校验携带 Bearer Token
    assert.deepEqual(JSON.parse(options.body), {
      query: "Node.js",
      search_depth: "basic",
      max_results: 5,
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
    });
    return reply();
  };

  // ---------------------------------------------------------------------------
  // 第一部分：宿主注册表集成检查（Schema 先于授权、用户审批、执行与注销）
  // ---------------------------------------------------------------------------
  let approvals = 0;
  let allowed = false;

  // 创建测试注册表：记录进入授权回调的次数 approvals，并根据 allowed 状态决定是否放行
  const registry = createToolRegistry(() => {
    approvals++;
    return allowed;
  });
  const dispose = mountExtension(registry, registerSearch);
  const context = {
    cwd: process.cwd(),
    model: "test",
    sessionFile: "test.jsonl",
    callId: "1",
    signal,
    confirm: async () => false,
  };

  try {
    // 1. Schema 校验优先：传入非法类型 query（数字 1），应被 Ajv 直接拦截，approvals 为 0
    await assert.rejects(registry.execute("search_web", { query: 1 }, context), /Schema/);
    assert.equal(approvals, 0);

    // 2. 授权拦截：参数合法但用户拒绝（allowed = false），应报错未获授权，且不发起底层 fetch 调用
    await assert.rejects(registry.execute("search_web", { query: "Node.js" }, context), /未获授权/);
    assert.equal(calls, 0);

    // 3. 授权通过正常执行：用户同意授权（allowed = true），成功返回搜索摘要，且返回文本绝不能泄露密钥
    allowed = true;
    const output = await registry.execute("search_web", { query: "Node.js" }, context);
    assert.equal(JSON.parse(output).results[0].content, "官方文档");
    assert.ok(!output.includes("test-key"));
  } finally {
    // 释放扩展注册项
    dispose();
  }

  // 验证注销完整性：注册表中工具定义被清空
  assert.deepEqual(registry.definitions(), []);

  // ---------------------------------------------------------------------------
  // 第二部分：输入参数校验、凭据检查与预取消信号拦截
  // ---------------------------------------------------------------------------
  const before = calls;
  // 1. 预取消信号拦截：调用前已 abort 的信号，应在进入网络请求前直接抛错
  await assert.rejects(searchWeb("Node.js", AbortSignal.abort()));
  // 2. 空白或纯空格查询词校验拦截
  await assert.rejects(searchWeb(" ", signal), /查询词/);
  // 3. 环境变量缺失拦截：未配置 TAVILY_API_KEY 时必须明确提示配置
  delete process.env.TAVILY_API_KEY;
  await assert.rejects(searchWeb("Node.js", signal), /配置 TAVILY_API_KEY/);
  assert.equal(calls, before); // 以上失败均未发起实际网络调用
  process.env.TAVILY_API_KEY = "test-key";

  // ---------------------------------------------------------------------------
  // 第三部分：异常边界、体积限制与敏感错误脱敏校验
  // ---------------------------------------------------------------------------
  // 4. 空结果处理：服务返回空数组时能够正常解析并返回空列表
  reply = () => Response.json({ results: [] });
  assert.deepEqual(JSON.parse(await searchWeb("Node.js", signal)).results, []);

  // 5. 服务端 HTTP 状态码异常拦截：如收到 429 限流响应，抛出包含状态码的安全错误说明
  reply = () => new Response("PRIVATE_ERROR", { status: 429 });
  await assert.rejects(searchWeb("Node.js", signal), { message: "Tavily 请求失败：HTTP 429" });

  // 6. 链接协议白名单拦截：若搜索结果包含 file:/// 等私有协议，判定为非法结果并拒绝
  reply = () =>
    Response.json({
      results: [{ title: "x", url: "file:///private", content: "x" }],
    });
  await assert.rejects(searchWeb("Node.js", signal), /链接无效/);

  // 7. 响应体积超限熔断：响应体积超过 256 KiB 时立即主动中断流并报错
  reply = () =>
    new Response("x".repeat(256 * 1024 + 1), {
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(searchWeb("Node.js", signal), /256 KiB/);

  // 8. 错误正文脱敏验证：即使底层 fetch 抛出包含凭据的异常（PRIVATE_ERROR test-key），
  // 宿主向外抛出的异常中也绝不能包含该敏感信息，统一脱敏为通用连接失败错误
  reply = () => {
    throw new Error("PRIVATE_ERROR test-key");
  };
  await assert.rejects(searchWeb("Node.js", signal), {
    message: "Tavily 搜索连接失败或响应无效",
  });

  console.log("Tavily 参数、权限、模拟搜索、响应边界和错误脱敏检查通过");
} finally {
  // 还原全局打桩
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalKey;
}
