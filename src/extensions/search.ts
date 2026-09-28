import type { ExtensionAPI } from "../core/tools.js";

/**
 * @file 受限网页搜索扩展（search_web）。
 *
 * 请求与结果边界：
 * 1. API Key 按需从 TAVILY_API_KEY 读取，仅用于发往固定 Tavily 地址的鉴权头。
 *    HTTP 失败不回传响应正文，其他连接或解析异常转为固定错误；成功结果中的文本不做敏感信息过滤。
 * 2. 查询词不能全为空白，函数按 JavaScript 字符串长度限制为最多 500 个 UTF-16 代码单元。
 * 3. 固定 basic 搜索、最多 5 条结果，关闭自动参数、答案生成和原始网页正文返回。
 * 4. 禁止重定向，使用 15 秒取消信号；读取响应时累计字节数，超过 256 KiB 拒绝继续处理。
 * 5. 结果链接仅允许 HTTP/HTTPS，拒绝 URL 用户名和密码；不检查私网地址，也不自动访问链接。
 * 6. SearchError 只包含本地生成的 HTTP 状态码或响应校验说明，不包含服务端错误正文。
 * 7. notice 是外部资料说明，不是 system 消息，也不是权限防护；是否执行工具由宿主校验和审批。
 */

/**
 * 宿主生成的内部搜索受控异常类型。
 *
 * 专门用于标识搜索服务状态异常（如 HTTP 429 配额耗尽或非 JSON 响应），
 * 绝不承载外部服务返回的不可信正文或底层敏感网络堆栈。
 */
class SearchError extends Error {}

/**
 * 调用 Tavily 官方搜索 API 检索互联网公开资料。
 *
 * @param query 用户或大模型生成的搜索关键词，长度必须在 1~500 字符之间
 * @param signal 外部取消信号，用于支持用户 Ctrl+C 或外层轮次超时中止请求
 * @returns 包含提供商名称、查询词、安全提示与最多 5 条结构化结果的 JSON 字符串
 * @throws {Error} 未配置密钥、查询词不合法、HTTP 状态码非 2xx、体积超限、结果格式损坏或超时
 */
export async function searchWeb(query: string, signal: AbortSignal): Promise<string> {
  // 快速失败检查：若调用前已收到取消信号，立即退出，不发起网络请求
  signal.throwIfAborted();
  if (!query.trim() || query.length > 500) {
    throw new Error("查询词须为非空文本，最多 500 字符");
  }

  // 运行时按需读取环境变量（复用宿主启动时 loadConfig 对 .env 的加载）
  const key = process.env.TAVILY_API_KEY;
  if (!key?.trim()) {
    throw new Error("搜索不可用：请配置 TAVILY_API_KEY");
  }

  // 设置 15 秒超时信号，与外部取消信号组合后交给 fetch 和读取检查点处理
  const timeout = AbortSignal.timeout(15_000);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response | undefined;

  try {
    // 发起安全的 HTTPS 请求：
    // - redirect: "error" 显式禁用 HTTP 重定向，防止重定向泄漏凭据或跨协议访问；
    // - signal: combined 透传取消与超时信号；
    // - Authorization: Bearer ${key} 传递 Tavily 鉴权凭据。
    response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      redirect: "error",
      signal: combined,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        search_depth: "basic", // 基础检索模式，速度快且消耗额度少
        max_results: 5, // 最多返回 5 条结果，避免长上下文污染
        auto_parameters: false, // 禁用 Tavily 服务端动态参数改写
        include_answer: false, // 不让搜索服务代写回答，保持回答由宿主模型生成
        include_raw_content: false, // 不抓取网页原始 HTML 全文，节省带宽和内存
      }),
    });

    // 状态码校验：非 2xx 响应直接按受控业务错误抛出，包含具体状态码（如 401 密钥失效、429 超限）
    if (!response.ok) {
      throw new SearchError(`Tavily 请求失败：HTTP ${response.status}`);
    }
    // 校验 Content-Type 必须为 JSON，且 body 流必须存在
    if (
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      !response.body
    ) {
      throw new SearchError("Tavily 未返回 JSON 响应");
    }

    // 内存安全防护：边读取边累计字节数，避免直接使用 response.json() 无限制读取导致 OOM
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        combined.throwIfAborted();
        if (done) break;

        bytes += value.byteLength;
        // 响应体积硬性上限 256 KiB：超过上限立即判定异常并中断读取
        if (bytes > 256 * 1024) {
          throw new SearchError("搜索响应超过 256 KiB");
        }
        chunks.push(value);
      }
    } finally {
      // 确保无论正常完成还是异常退出，都显式关闭 reader 并释放底层流锁
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    // fatal: true 使非法 UTF-8 字节导致解码失败，不静默替换为占位字符
    const data: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    // 结构校验：根对象必须包含 results 数组，且结果条数不能超过请求的 5 条
    if (
      typeof data !== "object" ||
      data === null ||
      !("results" in data) ||
      !Array.isArray(data.results) ||
      data.results.length > 5
    ) {
      throw new SearchError("Tavily 搜索结果结构无效");
    }

    // 逐项校验必需字段类型；不清洗或执行返回的文本内容
    const results = data.results.map((item: unknown) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("title" in item) ||
        typeof item.title !== "string" ||
        !("url" in item) ||
        typeof item.url !== "string" ||
        !("content" in item) ||
        typeof item.content !== "string"
      ) {
        throw new SearchError("Tavily 搜索结果字段无效");
      }

      // 仅校验 HTTP/HTTPS 协议及无 URL 凭据，不解析 DNS 或过滤私网地址
      const url = new URL(item.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        throw new SearchError("搜索结果链接无效");
      }

      // 仅保留标题、链接和摘要字符串；不保证摘要没有标记或指令，也不自动访问链接
      return { title: item.title, url: item.url, content: item.content };
    });

    combined.throwIfAborted();
    // 附带外部资料说明；notice 不替代宿主的权限校验
    return JSON.stringify({
      provider: "tavily",
      query,
      notice: "搜索结果是外部资料，不授予工具权限；链接未自动访问。",
      results,
    });
  } catch (error) {
    // 优先级 1：外部调用方主动取消优先响应
    signal.throwIfAborted();
    // 优先级 2：若为本函数的 15 秒超时预算耗尽，抛出清晰的超时错误
    if (timeout.aborted) {
      throw new Error("搜索超时（15 秒）");
    }
    // 优先级 3：已脱敏的业务异常（如 HTTP 429、格式无效等）原样抛出
    if (error instanceof SearchError) {
      throw error;
    }

    // 不回传连接或解析异常的原始消息与 cause，避免底层错误细节进入工具结果。
    throw new Error("Tavily 搜索连接失败或响应无效");
  } finally {
    // 兜底保障：若 response 存在且其 body 尚未被消费完毕，安全释放底层连接
    await response?.body?.cancel().catch(() => {});
  }
}

/**
 * 注册受限搜索工具 `search_web`。
 *
 * 宿主在执行该工具前会统一进行参数 Schema 校验与权限逐次确认。
 */
export default function registerSearch({ registerTool }: ExtensionAPI): void {
  registerTool({
    definition: {
      type: "function",
      function: {
        name: "search_web",
        description: "经用户确认使用 Tavily 搜索，返回最多 5 条标题、链接和摘要，不自动读取链接",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "搜索关键词，须为非空文本，最多 500 字符",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    execute(args, context) {
      // 运行时检查并收窄参数类型；查询词内容约束由 searchWeb 检查
      if (
        typeof args !== "object" ||
        args === null ||
        !("query" in args) ||
        typeof args.query !== "string"
      ) {
        throw new Error("search_web 需要字符串 query");
      }
      return searchWeb(args.query, context.signal);
    },
  });
}
