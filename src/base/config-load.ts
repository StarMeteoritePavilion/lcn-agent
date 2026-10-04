import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { parse, TomlDate, type TomlTable, type TomlValue } from "smol-toml";

/**
 * 递归替换 TOML 值中的整值占位符，并保留其他类型及未找到变量的字符串。
 * @param value - 待处理的 TOML 值。
 * @param fileEnv - 从配置文件旁的 .env 解析出的变量。
 * @returns 完成一次替换的值；表和数组会在原对象上更新。
 * @remarks .env 优先于进程环境变量，空字符串视为未配置；不修改进程环境或继续展开替换结果。
 */
function replaceEnv(value: TomlValue, fileEnv: NodeJS.Dict<string>): TomlValue {
  if (typeof value === "string") {
    const match = /^\$\{([^{}]+)\}$/u.exec(value);
    if (!match || match[0] !== value) {
      return value;
    }
    const name = match[1];
    const fileValue = Object.hasOwn(fileEnv, name) ? fileEnv[name] : undefined;
    const processValue = Object.hasOwn(process.env, name) ? process.env[name] : undefined;
    return fileValue || processValue || value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = replaceEnv(value[index], fileEnv);
    }
  } else if (typeof value === "object" && !(value instanceof TomlDate)) {
    for (const [key, entry] of Object.entries(value)) {
      value[key] = replaceEnv(entry, fileEnv);
    }
  }
  return value;
}

/**
 * 同步读取 TOML 配置及其旁边的 .env，返回完成环境变量替换的配置表。
 * @param configPath - 配置文件路径，默认使用当前工作目录的 config.toml；相对路径基于当前工作目录。
 * @returns 解析并完成替换的配置表；空 TOML 文件返回空表。
 * @throws 配置文件读取失败、TOML 格式错误，或 .env 发生文件不存在之外的读取错误时抛出异常。
 * @remarks
 * 每次调用独立加载指定文件及其同目录 .env，不合并或缓存其他文件的配置。
 * 不限定文件名、配置块名称或业务字段；由对应模块进行业务校验和使用。
 * .env 不存在时仅使用进程环境变量；不修改 process.env，不写回任何文件。
 */
export function loadConfig(configPath: string = "config.toml"): TomlTable {
  const absolutePath = resolve(configPath);
  const configText = readFileSync(absolutePath, "utf8");
  const config = parse(configText);
  const envPath = join(dirname(absolutePath), ".env");
  let fileEnv: NodeJS.Dict<string> = {};
  try {
    fileEnv = parseEnv(readFileSync(envPath, "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  replaceEnv(config, fileEnv);
  return config;
}
