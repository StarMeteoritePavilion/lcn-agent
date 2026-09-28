import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI } from "../core/tools.js";

/** MCP 内容只由用户选择；资源仅展示，提示由宿主预览确认后作为用户消息应用。 */
export function createMcpContent(client: Client, prefix: string, active: () => boolean) {
  async function request<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (!active()) throw new Error("MCP 已卸载");
    let result: T;
    try {
      result = await operation();
    } catch (cause) {
      signal.throwIfAborted();
      throw new Error("MCP 内容请求失败或超时", { cause });
    }
    signal.throwIfAborted();
    if (!active()) throw new Error("MCP 已卸载");
    return result;
  }

  function display(value: unknown): string {
    const text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("MCP 内容超过 64 KiB");
    return text;
  }

  async function resources(signal: AbortSignal) {
    if (!client.getServerCapabilities()?.resources) throw new Error("服务未提供 resources 能力");
    const result = await request(signal, () => client.listResources(undefined, { signal, timeout: 5000 }));
    if (result.nextCursor !== undefined) throw new Error("暂不支持资源分页，未展示不完整清单");
    display(result.resources);
    return result.resources;
  }

  async function prompts(signal: AbortSignal) {
    if (!client.getServerCapabilities()?.prompts) throw new Error("服务未提供 prompts 能力");
    const result = await request(signal, () => client.listPrompts(undefined, { signal, timeout: 5000 }));
    if (result.nextCursor !== undefined) throw new Error("暂不支持提示分页，未展示不完整清单");
    display(result.prompts);
    return result.prompts;
  }

  async function prompt(input: string, signal: AbortSignal): Promise<string> {
    const args: unknown = JSON.parse(input);
    if (typeof args !== "object" || args === null || Array.isArray(args) || !("name" in args)
      || typeof args.name !== "string" || Object.keys(args).some((key) => !["name", "arguments"].includes(key))) {
      throw new Error('参数必须为 {"name":"完整名称","arguments":{}}');
    }
    const values = "arguments" in args ? args.arguments : {};
    if (typeof values !== "object" || values === null || Array.isArray(values)
      || Object.values(values).some((value) => typeof value !== "string")) {
      throw new Error("提示参数必须为字符串对象");
    }
    const listed = (await prompts(signal)).find((item) => item.name === args.name);
    if (!listed) throw new Error("提示名称不在当前清单中");
    const fields = listed.arguments ?? [];
    if (Object.keys(values).some((key) => !fields.some((field) => field.name === key))
      || fields.some((field) => field.required && !Object.hasOwn(values, field.name))) {
      throw new Error("提示参数缺失或包含未声明字段");
    }
    const result = await request(signal, () => client.getPrompt(
      { name: listed.name, arguments: values as Record<string, string> }, { signal, timeout: 5000 },
    ));
    if (!result.messages.length || result.messages.some((message) => message.content.type !== "text")) {
      throw new Error("仅支持非空的纯文本提示消息");
    }
    // 保留服务来源与消息角色作为数据，不把外部 assistant 消息伪装为宿主历史或 system 指令。
    return display({ source: prefix, prompt: listed.name, messages: result.messages });
  }

  function register(api: ExtensionAPI): void {
    api.registerCommand({
      name: `${prefix}resources`,
      async execute(args, context) {
        if (args) throw new Error("列资源命令不接受参数");
        return display(await resources(context.signal));
      },
    });
    api.registerCommand({
      name: `${prefix}resource`,
      async execute(uri, context) {
        const listed = await resources(context.signal);
        if (!listed.some((resource) => resource.uri === uri)) throw new Error("资源 URI 不在当前清单中");
        const result = await request(context.signal, () => client.readResource(
          { uri }, { signal: context.signal, timeout: 5000 },
        ));
        if (result.contents.some((item) => !("text" in item))) throw new Error("暂不支持二进制资源");
        return display({ source: prefix, requestedUri: uri, contents: result.contents });
      },
    });
    api.registerCommand({
      name: `${prefix}prompts`,
      async execute(args, context) {
        if (args) throw new Error("列提示命令不接受参数");
        return display(await prompts(context.signal));
      },
    });
  }
  return { register, prompt };
}
