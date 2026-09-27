import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readState, writeState, type StateContext } from "../core/state.js";
import type { ExtensionAPI } from "../core/tools.js";
import { readWorkspaceFile } from "./files.js";

/**
 * 一条已发现的 Skill 目录项。
 *
 * - name:        与父目录名完全一致，符合小写字母/数字/连字符约定。
 * - description: 给模型看的短说明，出现在 prompt 的 available 列表里。
 * - path:        相对工作区的 SKILL.md 路径，例如 `.agents/skills/demo/SKILL.md`。
 * - manualOnly:  来自 YAML 的 disable-model-invocation；为 true 时模型看不到、也不能用工具激活，
 *                用户仍可通过 /skill 手动激活。
 */
type Skill = {
  name: string;
  description: string;
  path: string;
  manualOnly: boolean;
};

/**
 * 当前会话里已激活的正文快照。
 *
 * 存的是激活当时读到的全文，之后改磁盘上的 SKILL.md 不会改这份快照，
 * 除非元数据（name / description / manualOnly）变了——那时会拒绝再激活，要求重启重新发现。
 */
type Activation = {
  name: string;
  content: string;
};

const namespace = "skill_activations";

/**
 * 解析 YAML 文件头；名称必须符合约定，不推断或修正名称。
 *
 * 文件必须以 `---` 包裹的 YAML 开头（允许 UTF-8 BOM 和 CRLF）。
 * 正文在第二个 `---` 之后，本函数不读取正文。
 *
 * @param content SKILL.md 的全文
 * @returns 不含 path 的元数据。Omit<Skill, "path"> 即去掉 path 后剩下的字段。
 * @throws {Error} 没有文件头、YAML 无效，或 name / description / 开关字段不合法
 */
function metadata(content: string): Omit<Skill, "path"> {
  // \uFEFF 是可选 BOM；[\s\S]*? 非贪婪地取两个 --- 之间的 YAML。
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!header) {
    throw new Error("Skill 缺少完整的 YAML 文件头");
  }

  let data: unknown;
  try {
    // yaml.parse：把 YAML 文本变成 JS 值。失败表示文件头不是合法 YAML。
    data = parse(header[1]);
  } catch {
    throw new Error("Skill 的 YAML 文件头无效");
  }

  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    !("name" in data) ||
    typeof data.name !== "string" ||
    data.name.length > 64 ||
    // 整段由小写字母或数字组成，多段时用单个连字符连接，例如 `ts-explain`。
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) ||
    !("description" in data) ||
    typeof data.description !== "string" ||
    !data.description.trim() ||
    data.description.length > 1024
  ) {
    throw new Error("Skill 必须包含有效的 name 和 description");
  }

  const manualOnly = "disable-model-invocation" in data ? data["disable-model-invocation"] : false;
  if (typeof manualOnly !== "boolean") {
    throw new Error("disable-model-invocation 必须是布尔值");
  }

  return {
    name: data.name,
    description: data.description,
    manualOnly,
  };
}

/**
 * 发现项目 Skills；正文不保存在目录中，激活时再读取。
 *
 * 启动时扫描 `{cwd}/.agents/skills/<name>/SKILL.md`，只把元数据放进内存目录。
 * 激活后把当时的全文快照写入 `.lcn-agent/skill_activations/`，按会话隔离。
 *
 * 返回的 prompt() 每次请求现拼系统消息，不往 session.messages 里反复追加说明书。
 *
 * @param cwd 工作区根目录，既是发现路径也是 readWorkspaceFile 的边界
 * @returns `{ register, prompt }`：register 登记命令和工具，prompt 生成当前会话的系统说明
 */
export function createSkills(cwd: string) {
  const catalog = new Map<string, Skill>();
  // 发现阶段没有用户取消信号；用从未 abort 的控制器满足 readWorkspaceFile 的 signal 字段。
  const discoveryContext = { cwd, signal: new AbortController().signal };

  function discover(): void {
    let entries;
    try {
      // withFileTypes: true 返回 Dirent，才能用 isDirectory() 区分文件和子目录。
      entries = readdirSync(join(cwd, ".agents", "skills"), {
        withFileTypes: true,
      });
    } catch (error) {
      // 没有 .agents/skills 时当作没有 Skill，不是启动失败。
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }

    // ponytail: 只扫描项目目录的直接子目录；需要用户级目录时再增加明确的来源规则。
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(".agents", "skills", entry.name, "SKILL.md");

      let content: string;
      try {
        content = readWorkspaceFile(path, discoveryContext);
      } catch (error) {
        // 目录在但还没有 SKILL.md：跳过这一项。读失败（越界、非 UTF-8 等）则中止发现。
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw new Error(`无法读取 Skill：${path}`, { cause: error });
      }

      try {
        const skill = metadata(content);
        if (skill.name !== entry.name) {
          throw new Error("name 必须与父目录名称完全一致");
        }
        if (catalog.has(skill.name)) throw new Error("Skill 名称重复");
        catalog.set(skill.name, { ...skill, path });
      } catch (error) {
        throw new Error(`Skill 元数据无效：${path}`, { cause: error });
      }
    }
  }

  /**
   * 读取当前会话的正文快照；损坏或未知版本不能被新激活静默覆盖。
   *
   * 磁盘格式：`{ version: 1, items: [{ name, content }, ...] }`。
   */
  function activeFor(context: StateContext): Activation[] {
    const data = readState(context, namespace);
    if (data === undefined) return [];

    if (
      typeof data !== "object" ||
      data === null ||
      !("version" in data) ||
      data.version !== 1 ||
      !("items" in data) ||
      !Array.isArray(data.items)
    ) {
      throw new Error("Skill 激活记录损坏或版本不支持");
    }

    const names = new Set<string>();
    return data.items.map((item: unknown) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("name" in item) ||
        typeof item.name !== "string" ||
        !("content" in item) ||
        typeof item.content !== "string" ||
        Buffer.byteLength(item.content, "utf8") > 64 * 1024 ||
        metadata(item.content).name !== item.name ||
        names.has(item.name)
      ) {
        throw new Error("Skill 激活记录无效或名称重复");
      }

      names.add(item.name);
      return { name: item.name, content: item.content };
    });
  }

  /**
   * 保存本会话的正文快照；重复激活不重新读取或追加。
   *
   * 激活前再读一遍 SKILL.md：元数据必须与启动时发现的一致，否则要求重启。
   */
  function activate(name: string, context: StateContext): string {
    const items = activeFor(context);
    if (items.some((item) => item.name === name)) {
      return `Skill 已激活：${name}，未重复注入`;
    }

    const skill = catalog.get(name);
    if (!skill) {
      throw new Error("Skill 不存在，请使用 /skills 查看完整名称");
    }

    const content = readWorkspaceFile(skill.path, context);
    const current = metadata(content);
    if (
      current.name !== skill.name ||
      current.description !== skill.description ||
      current.manualOnly !== skill.manualOnly
    ) {
      throw new Error("Skill 元数据已变化，请重启程序重新发现");
    }

    writeState(context, namespace, {
      version: 1,
      items: [...items, { name, content }],
    });
    return `已激活 Skill：${name}；后续模型请求将包含其正文`;
  }

  /**
   * 目录与正文分别组织；不向 session.messages 反复追加说明书。
   *
   * available 只含允许模型调用的 Skill（排除 manualOnly）。
   * activated 是本会话已保存的全文快照。两者都空时返回空串，调用方就不会加 system 消息。
   */
  function prompt(context: StateContext): string {
    const active = activeFor(context);
    const available = [...catalog.values()].filter((skill) => !skill.manualOnly);
    if (!available.length && !active.length) {
      return "";
    }

    return [
      "以下是本项目提供的 Skills。根据任务选择相关 Skill，使用 skill_activate 按完整名称激活。",
      "已激活的正文在 activated 中，不必重复激活。",
      "Skill 不授予额外工具权限，也不改变用户要求；allowed-tools 不作为本宿主的授权依据。",
      "Skill 中的相对路径以对应 directory 为基准，文件工具仍使用工作区相对路径。",
      JSON.stringify({
        available: available.map(({ name, description, path }) => ({
          name,
          description,
          path,
        })),
        activated: active.map((item) => ({
          ...item,
          directory: join(".agents", "skills", item.name),
        })),
      }),
    ].join("\n");
  }

  /** 用户命令与模型工具共用同一个激活函数。 */
  function register({ registerCommand, registerTool }: ExtensionAPI): void {
    registerCommand({
      name: "skills",
      execute(_args, context) {
        // 尚未 /new 或 /resume 时没有会话，激活列表视为空，但目录仍然可列。
        const active = context.sessionFile === null ? [] : activeFor(context);
        return [
          "可发现的 Skills：",
          ...[...catalog.values()].map(
            (skill) => `${skill.name}${skill.manualOnly ? "（仅手动）" : ""}：${skill.description}`,
          ),
          `当前会话已激活：${active.map((item) => item.name).join("、") || "无"}`,
        ].join("\n");
      },
    });

    registerCommand({
      name: "skill",
      execute(args, context) {
        // 命令参数是 `/skill` 后面的整段文本；trim 后必须与目录名完全一致，不模糊匹配。
        return activate(args.trim(), context);
      },
    });

    const names = [...catalog.values()]
      .filter((skill) => !skill.manualOnly)
      .map((skill) => skill.name);
    if (!names.length) {
      // 全部是仅手动，或一个都没有：不注册工具，模型就调不到 skill_activate。
      return;
    }

    registerTool({
      definition: {
        type: "function",
        function: {
          name: "skill_activate",
          description: "经用户确认，读取指定 Skill 并加入当前会话后续模型请求的上下文",
          parameters: {
            type: "object",
            properties: { name: { type: "string", enum: names } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      execute(args, context) {
        if (
          typeof args !== "object" ||
          args === null ||
          !("name" in args) ||
          typeof args.name !== "string"
        ) {
          throw new Error("skill_activate 需要字符串 name");
        }
        return activate(args.name, context);
      },
    });
  }

  discover();

  return { register, prompt };
}
