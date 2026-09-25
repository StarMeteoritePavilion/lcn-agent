import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { parse, type TomlTable, type TomlValue } from "smol-toml";

/**
 * 对 TOML 解析后的值进行环境变量插值。
 *
 * 仅替换字符串值中的 `${VAR_NAME}` 占位符，不对替换后的结果进行二次展开；
 * 对数组和嵌套表递归处理；Date 实例和其他非字符串原始类型保持原样。
 *
 * @param value TOML 解析后的任意合法值（字符串、数字、布尔、日期、数组或表）
 * @returns 插值处理后的值，类型与输入一致
 * @throws {Error} 占位符引用的环境变量不存在时抛出错误
 */
function interpolate(value: TomlValue): TomlValue {
  if (typeof value === "string") {
    // replace 参数说明：
    // - 参数 1 pattern: 正则 /\$\{([^{}]+)\}/g 匹配所有 `${...}` 占位符，
    //                   捕获组 ([^{}]+) 提取花括号内的环境变量名。
    // - 参数 2 replacer: 回调函数，对每个匹配项执行替换。
    //   - _ : 完整匹配文本（未使用）。
    //   - key: 捕获组提取的环境变量名。
    return value.replace(/\$\{([^{}]+)\}/g, (_, key: string) => {
      // Object.hasOwn: 检查 process.env 自身是否拥有该属性（值可能为空字符串，但必须存在）。
      const replacement = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
      if (replacement === undefined) throw new Error(`缺少环境变量：${key}`);
      return replacement;
    });
  }
  // 数组：逐元素递归插值。
  if (Array.isArray(value)) return value.map(interpolate);
  // 嵌套表（排除 Date 实例）：逐键递归插值，直接原地修改。
  if (typeof value === "object" && !(value instanceof Date)) {
    for (const key of Object.keys(value)) value[key] = interpolate(value[key]);
  }
  return value;
}

/**
 * 从 TOML 配置表中提取指定键的非空字符串值。
 *
 * 仅使用 trim() 判断是否为空白，不修改返回值本身，避免意外裁剪密钥等敏感内容。
 *
 * @param config TOML 解析后的配置表对象
 * @param key 要提取的配置键名
 * @returns 原始字符串值（不做 trim）
 * @throws {Error} 值不存在、类型非字符串或仅含空白时抛出错误
 */
function requireString(config: TomlTable, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`config.toml 的 ${key} 必须是非空字符串`);
  return value;
}

/**
 * 从当前工作目录加载应用配置。
 *
 * 加载流程：
 * 1. 尝试加载 `.env` 文件注入环境变量（文件不存在时静默跳过，其他错误直接抛出）；
 * 2. 同步读取并解析 `config.toml`；
 * 3. 对解析后的 TOML 值进行环境变量插值（`${VAR_NAME}` 替换）；
 * 4. 提取并校验必需的配置项。
 *
 * @returns 包含三个必需配置项的对象：
 *   - apiKey:  API 密钥
 *   - baseURL: API 基础 URL
 *   - model:   使用的模型名称
 * @throws {Error} .env 读取异常（非 ENOENT）、config.toml 缺失或语法错误、
 *                 环境变量插值失败或必需配置项缺失/为空时抛出错误
 */
export function loadConfig(): { apiKey: string; baseURL: string; model: string } {
  try {
    // loadEnvFile: Node.js v20.12+ 内置方法，将 .env 文件中的键值对注入 process.env。
    // - 参数 1 path: .env 文件路径（相对于 cwd）。
    loadEnvFile(".env");
  } catch (error) {
    // .env 文件不存在（ENOENT）属于正常情况：用户可能直接在 shell 中设置了环境变量。
    // 其他错误（如权限不足、编码异常）则视为不可忽略的启动障碍。
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("无法读取 .env");
    }
  }

  let text: string;
  try {
    // readFileSync 同步读取 config.toml：
    // - 参数 1 path: 文件路径（相对于 cwd）。
    // - 参数 2 encoding: "utf8" 直接返回字符串而非 Buffer。
    text = readFileSync("config.toml", "utf8");
  } catch {
    throw new Error("无法读取 config.toml，请从包含该文件的项目根目录启动");
  }

  let config: TomlTable;
  try {
    // parse: smol-toml 提供的 TOML 解析器，将文本转换为嵌套的 JS 对象（TomlTable）。
    // - 参数 1 text: 待解析的 TOML 格式文本。
    config = parse(text);
  } catch {
    // 解析器错误可能包含原始配置行，因此不透传错误内容或 cause，防止泄露密钥等敏感信息。
    throw new Error("config.toml 格式错误，请检查 TOML 语法");
  }

  // 对整个配置表递归执行环境变量插值。
  interpolate(config);

  // 提取并校验三个必需的配置项，任一缺失或为空则抛出错误。
  return {
    apiKey: requireString(config, "apiKey"),
    baseURL: requireString(config, "baseURL"),
    model: requireString(config, "model"),
  };
}
