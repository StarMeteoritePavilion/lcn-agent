import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { parse, type TomlTable, type TomlValue } from "smol-toml";

// 只替换解析后的字符串值；环境值不再次展开，日期与其他类型保持原样。
function interpolate(value: TomlValue): TomlValue {
  if (typeof value === "string") {
    return value.replace(/\$\{([^{}]+)\}/g, (_, key: string) => {
      const replacement = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
      if (replacement === undefined) throw new Error(`缺少环境变量：${key}`);
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (typeof value === "object" && !(value instanceof Date)) {
    for (const key of Object.keys(value)) value[key] = interpolate(value[key]);
  }
  return value;
}

// 只用 trim 判断空白，不修改返回值，避免改变密钥内容。
function requireString(config: TomlTable, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`config.toml 的 ${key} 必须是非空字符串`);
  return value;
}

// 所有启动方式都从当前工作目录加载配置，仅允许 .env 文件缺失。
export function loadConfig(): { apiKey: string; baseURL: string; model: string } {
  try {
    loadEnvFile(".env");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("无法读取 .env");
    }
  }

  let text: string;
  try {
    text = readFileSync("config.toml", "utf8");
  } catch {
    throw new Error("无法读取 config.toml，请从包含该文件的项目根目录启动");
  }

  let config: TomlTable;
  try {
    config = parse(text);
  } catch {
    // 解析器错误可能包含原始配置行，因此不透传错误内容或 cause。
    throw new Error("config.toml 格式错误，请检查 TOML 语法");
  }
  interpolate(config);
  return {
    apiKey: requireString(config, "apiKey"),
    baseURL: requireString(config, "baseURL"),
    model: requireString(config, "model"),
  };
}
