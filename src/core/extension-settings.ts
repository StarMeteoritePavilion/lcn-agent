import { mkdirSync, mkdtempSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkspaceFile } from "../extensions/files.js";

/**
 * @file 项目级扩展启停配置管理器（.lcn-agent/extensions.json）。
 *
 * 核心架构与设计目标：
 * 1. 项目级持久化：通过 `.lcn-agent/extensions.json` 文件持久化记录禁用的扩展模块编号，
 *    实现开发环境项目粒度的功能定制；
 * 2. 启动快照隔离（重启生效）：为保证运行稳定性，进程启动时读取一份不可变的启动快照 `startup`，
 *    运行期间用户执行 `/extensions enable|disable` 修改配置仅更新磁盘文件，当前进程的扩展装载状态
 *    保持不变，避免运行中热卸载导致后台正在执行的异步任务或模型调用崩溃；
 * 3. 严格的安全校验与防穿透：
 *    - 软链接防御：校验配置目录与配置文件绝不能是符号链接（Symlink），防止恶意指向敏感系统文件；
 *    - Schema 强校验：严格限制 JSON 根结构仅含 version: 1 与 disabled 数组，不允许未知属性；
 *    - 编号白名单校验：严格匹配 `extensions` 枚举，拒绝未知编号、非法字符或重复编号；
 *    - 损坏保护：若配置文件损坏或 JSON 格式非法，抛错拒绝覆盖原有文件，保留现场供人工排查；
 * 4. 事务性原子写入：采用“写入临时目录唯一文件（wx 独占模式，权限 0o600）→ 原子重命名 renameSync”发布机制，
 *    保证写入过程具备强原子性，杜绝半写入的空文件或损坏文件；
 * 5. 规划模式只读防护：在 plan 模式下执行修改命令时直接抛错拒绝，保证规划模式的纯只读边界。
 */

// 配置编号对应宿主现有装载组；workflow 内的工具仍一起启停。
const extensions = {
  echo: "回显工具",
  workflow: "默认工作流：文件、命令、待办、计划、记忆、网页和搜索",
  skills: "Skills 发现、激活和上下文注入",
  subagent: "只读子代理和后台任务",
  external: "可信外部扩展；来源 LCN_AGENT_EXTENSION",
  mcp_demo: "本地 stdio MCP；需 LCN_AGENT_MCP_DEMO=1",
  mcp_http: "本机 HTTP MCP；需 LCN_AGENT_MCP_HTTP_URL",
};

type ExtensionId = keyof typeof extensions;

// 配置文件相对项目根目录路径
const file = ".lcn-agent/extensions.json";

/**
 * 创建扩展配置管理器。
 *
 * @param cwd 项目工作目录绝对路径
 * @param isDemo 是否处于演示模式（--demo 模式下自动硬编码禁用 external 与 MCP 扩展）
 * @returns 包含 enabled 状态查询、markLoaded 装载标记与 command 命令处理函数的管理接口
 */
export function createExtensionSettings(cwd: string, isDemo: boolean) {
  const directory = join(cwd, ".lcn-agent");
  const path = join(cwd, file);
  const signal = new AbortController().signal;

  /** 从磁盘读取已禁用的扩展 ID 集合，并进行严格的安全与格式校验。 */
  function read(): Set<ExtensionId> {
    let text: string;
    try {
      // 安全防线：配置目录与文件均不能是符号链接，防止攻击者利用软链接跨目录越权或覆盖敏感文件
      if (lstatSync(directory).isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
        throw new Error("扩展配置目录或文件不能是符号链接");
      }
      text = readWorkspaceFile(file, { cwd, signal });
    } catch (error) {
      // 配置文件不存在视为全新环境（默认全部启用）
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
      throw error;
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("扩展配置不是有效 JSON，拒绝覆盖");
    }

    // 格式合法性校验：根对象必须包含 version: 1 与 disabled 数组，不允许未知键，且编号必须在白名单内无重复
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 1 ||
      !("disabled" in data) ||
      !Array.isArray(data.disabled) ||
      Object.keys(data).some((key) => key !== "version" && key !== "disabled") ||
      !data.disabled.every((id) => typeof id === "string" && Object.hasOwn(extensions, id)) ||
      new Set(data.disabled).size !== data.disabled.length
    ) {
      throw new Error("扩展配置格式或版本无效，拒绝覆盖");
    }

    return new Set(data.disabled as ExtensionId[]);
  }

  // 读取启动快照：进程启动时捕获，运行中保持不变
  const startup = read();
  // 记录当前进程中已实际成功装载的扩展模块集合
  const loaded = new Set<ExtensionId>();
  // 演示模式禁用集合：--demo 下强制关闭外部扩展与外部 MCP 进程
  const demoBlocked = new Set<ExtensionId>(isDemo ? ["external", "mcp_demo", "mcp_http"] : []);

  return {
    /** 检查指定扩展是否允许装载（需同时满足未被启动快照禁用，且未被演示模式拦截）。 */
    enabled: (id: ExtensionId): boolean => !startup.has(id) && !demoBlocked.has(id),

    /** 只有实际装载成功后才记录，用于在 /extensions 列表中准确区分“允许装载”与“已装载”。 */
    markLoaded(id: ExtensionId): void {
      loaded.add(id);
    },

    /**
     * 响应用户 `/extensions` 与 `/extensions enable|disable <id>` 命令。
     *
     * @param args 用户在命令后输入的参数字符串
     * @param mode 当前终端工作模式（plan 或 execute）
     * @returns 供终端渲染的说明或保存提示文本
     */
    command(args: string, mode: "plan" | "execute"): string {
      // 每次执行命令时重新从磁盘读取最新配置
      const disabled = read();

      // 无参数时：格式化输出扩展列表、当前装载状态与下次启动设置
      if (!args) {
        const rows = Object.entries(extensions).map(([name, description]) => {
          const id = name as ExtensionId;
          const current = loaded.has(id)
            ? "已装载"
            : demoBlocked.has(id)
              ? "演示模式禁用"
              : startup.has(id)
                ? "已禁用"
                : "未配置来源";
          return `${id} | 当前：${current} | 下次设置：${disabled.has(id) ? "禁用" : "启用"} | ${description}`;
        });
        return [
          "扩展配置（启用不授予工具权限；更改重启后生效）",
          ...rows,
          "用法：/extensions enable|disable 完整编号；可选扩展仍需原有环境配置。",
        ].join("\n");
      }

      // 带参数时：解析操作动词（enable/disable）与目标扩展编号
      const match = /^(enable|disable) ([a-z][a-z_]*)$/.exec(args);
      if (!match || !Object.hasOwn(extensions, match[2])) {
        throw new Error("用法：/extensions [enable|disable 完整编号]；编号见 /extensions，区分大小写");
      }

      // 规划模式只读防线：禁止在 plan 模式下修改扩展设置
      if (mode === "plan") {
        throw new Error("plan 模式不允许修改扩展配置，请先 /mode execute");
      }

      const id = match[2] as ExtensionId;
      if (match[1] === "disable") disabled.add(id);
      else disabled.delete(id);

      // 原子发布机制：先写临时文件，flush 刷盘后原子 rename 覆盖目标路径
      mkdirSync(directory, { recursive: true });
      const temporary = mkdtempSync(join(directory, ".extensions-"));
      try {
        const pending = join(temporary, "extensions.json");
        const text = JSON.stringify({ version: 1, disabled: [...disabled] }, null, 2) + "\n";
        writeFileSync(pending, text, { flag: "wx", mode: 0o600, flush: true });
        renameSync(pending, path);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }

      // ponytail: 复用宿主单写入锁；不支持外部进程同时手改配置，重启代替运行中热卸载。
      return `已保存 ${id}：${match[1] === "disable" ? "禁用" : "启用"}；重启后生效，当前装载保持不变。`;
    },
  };
}
