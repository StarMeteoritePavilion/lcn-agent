import assert from "node:assert/strict";
import { createToolRegistry, mountExtension } from "../dist/core/tools.js";
import registerWeb, { readWeb } from "../dist/extensions/web.js";

/**
 * @file 受限网页读取（read_web）单元与集成测试。
 *
 * 验证维度：
 * 1. 严格 URL 预检：协议、域名伪造、私有 IP、端口、身份凭据、查询参数和片段必须在发起网络请求前被拦截；
 * 2. 取消信号优先拦截：调用前已 abort 的信号必须立即中断，不产生网络开销；
 * 3. 宿主注册集成：Schema 参数校验先于授权确认，未授权拒绝，注销后工具彻底清除。
 */

const signal = new AbortController().signal;
const url = "https://nodejs.org/api/http.html";

// ---------------------------------------------------------------------------
// 第一部分：URL 合法性预检（必须在发起底层网络连接之前直接报错拒绝）
// ---------------------------------------------------------------------------
for (const invalid of [
  "http://nodejs.org/api/http.html", // 协议降级（仅允许 https）
  "https://nodejs.org.evil/api/http.html", // 域名欺骗/钓鱼
  "https://127.0.0.1/api/http.html", // 私有 IP 直连
  "https://nodejs.org:8443/api/http.html", // 非标准端口
  "https://user:password@nodejs.org/api/http.html", // 携带凭据信息
  `${url}?token=test`, // 携带查询参数
  `${url}#section`, // 携带 URL 片段
]) {
  await assert.rejects(readWeb(invalid, signal));
}

// ---------------------------------------------------------------------------
// 第二部分：预取消与信号响应拦截
// ---------------------------------------------------------------------------
// 传入已触发取消的 AbortSignal，应在进入底层网络请求前立即抛出异常
await assert.rejects(readWeb(url, AbortSignal.abort()));

// ---------------------------------------------------------------------------
// 第三部分：宿主注册表集成（Schema 拦截先于权限确认、未授权拦截与卸载清理）
// ---------------------------------------------------------------------------
let approvals = 0;
// 创建测试注册表：默认拒绝所有授权，并记录是否进入了授权回调
const registry = createToolRegistry(() => {
  approvals++;
  return false;
});
const dispose = mountExtension(registry, registerWeb);
const context = {
  cwd: process.cwd(),
  model: "local-test",
  sessionFile: "web-check.jsonl",
  callId: "web_1",
  signal,
  confirm: async () => false,
};

try {
  // 1. Schema 校验优先：传入非法的参数类型（如 url: 123 数字），直接被 Ajv 拦截，
  // 此时 approvals 保持为 0，绝不进入用户授权审批流程。
  await assert.rejects(registry.execute("read_web", { url: 123 }, context), /Schema/);
  assert.equal(approvals, 0);

  // 2. 授权拦截：参数合法但用户拒绝（approvals 递增为 1），正确报错拒绝执行。
  await assert.rejects(registry.execute("read_web", { url }, context), /未获授权/);
  assert.equal(approvals, 1);
} finally {
  // 3. 注销扩展：释放注册项
  dispose();
}

// 4. 验证清理完整性：工具定义被彻底清空
assert.deepEqual(registry.definitions(), []);
console.log("网页来源、预取消、参数校验、权限拒绝和卸载检查通过");
