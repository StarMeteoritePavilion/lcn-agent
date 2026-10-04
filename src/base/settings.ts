import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

/** 配置文件中的模型条目。 */
interface ModelConfig {
  /** 请求使用的模型标识。 */
  id: string;
}

/** 配置文件中的供应商信息。 */
interface ProviderConfig {
  /** 唯一的供应商名称，用于与 provider 精确匹配。 */
  name: string;
  /** 接口基础地址，格式及协议由请求方处理。 */
  baseUrl: string;
  /** 完成环境变量替换的 API 密钥。 */
  apiKey: string;
  /** 可选择的模型列表。 */
  models: ModelConfig[];
}

/** setting.json 中经运行时校验的业务配置。 */
interface SettingsConfig {
  /** 所选供应商的名称，与 modelProviders 中的 name 精确匹配。 */
  provider: string;
  /** 所选供应商模型列表中的模型标识。 */
  model: string;
  /** 按配置顺序保存的供应商列表，名称不得重复。 */
  modelProviders: ProviderConfig[];
}

/**
 * 校验配置值为 JSON 对象。
 * @param value - 待校验的配置值。
 * @returns 是否为非空、非数组的配置对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取必填字符串，拒绝空值和未替换的环境变量占位符。
 * @param value - 原始配置值。
 * @param field - 用于错误提示的字段路径。
 * @returns 校验通过的原始字符串，不改变内容。
 * @throws 值无效时抛出仅包含字段路径的错误。
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /^\$\{[^{}]+\}$/u.test(value)) {
    throw new Error(`${field} 必须是非空字符串，且环境变量占位符必须完成替换。`);
  }
  return value;
}

/**
 * 校验单个供应商及其模型列表，并构造业务配置。
 * @param value - 未校验的供应商配置。
 * @param field - 供应商在配置数组中的路径，用于定位错误。
 * @returns 字段已校验的供应商配置，保留模型顺序。
 * @throws 字段类型无效、字符串为空或占位符未替换时抛出包含字段路径的错误。
 */
function parseProvider(value: unknown, field: string): ProviderConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} 必须是供应商对象。`);
  }
  const name = requireString(value.name, `${field}.name`);
  if (!Array.isArray(value.models)) {
    throw new Error(`${field}.models 必须是模型对象数组。`);
  }
  const models: ModelConfig[] = [];
  for (const [index, entry] of value.models.entries()) {
    const modelField = `${field}.models[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${modelField} 必须是模型对象。`);
    }
    const id = requireString(entry.id, `${modelField}.id`);
    models.push({ id });
  }

  const baseUrl = requireString(value.baseUrl, `${field}.baseUrl`);
  const apiKey = requireString(value.apiKey, `${field}.apiKey`);
  return { name, baseUrl, apiKey, models };
}

/**
 * 递归替换 JSON 值中的整值占位符，并保留其他类型及未找到变量的字符串。
 * @param value - 待处理的 JSON 值。
 * @param fileEnv - 从配置文件旁的 .env 解析出的变量。
 * @returns 完成一次替换的值；表和数组会在原对象上更新。
 * @remarks .env 优先于进程环境变量，空字符串视为未配置；不修改进程环境或继续展开替换结果。
 */
function replaceEnv(value: unknown, fileEnv: NodeJS.Dict<string>): unknown {
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
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      value[key] = replaceEnv(entry, fileEnv);
    }
  }
  return value;
}

/**
 * 同步读取 JSON 配置及其旁边的 .env，返回完成环境变量替换的配置表。
 * @param settingPath - 配置文件路径, 相对路径基于当前工作目录。
 * @returns 解析并完成替换的配置对象；空对象保持为空对象。
 * @throws 配置文件读取失败、JSON 格式错误、顶层不是对象，或 .env 发生文件不存在之外的读取错误时抛出异常。
 * @remarks 每次独立读取；缺失 .env 时使用进程变量，不修改环境或文件。业务校验由 loadSettings 完成。
 */
function loadSettingsFromFile(settingPath: string): Record<string, unknown> {
  if (!settingPath) {
    throw new Error("必须提供配置文件路径");
  }
  const absolutePath = resolve(settingPath);
  const configText = readFileSync(absolutePath, "utf8");
  const config: unknown = JSON.parse(configText);
  if (!isRecord(config)) {
    throw new Error("JSON 配置的顶层必须是对象。");
  }
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

/**
 * 读取指定配置文件，校验全部供应商字段以及所选模型是否存在。
 * @param settingPath - 配置文件路径，相对路径基于当前工作目录。
 * @returns 保持原始字段名的已校验配置，仅包含业务使用的配置字段。
 * @throws 文件无法读取、配置字段无效、供应商名称重复或所选供应商及模型不存在时抛出异常。
 * @remarks 读取同目录 .env；不输出配置或密钥，不通过类型断言跳过校验。
 */
export function loadSettings(settingPath: string): SettingsConfig {
  const settingConfig = loadSettingsFromFile(settingPath);

  const provider = requireString(settingConfig.provider, "provider");
  const id = requireString(settingConfig.model, "model");
  const providers = settingConfig.modelProviders;
  if (!Array.isArray(providers)) {
    throw new Error("modelProviders 必须是供应商对象数组。");
  }

  const validatedProviders: ProviderConfig[] = [];
  const names = new Set<string>();
  let selected: ProviderConfig | undefined;
  // 校验全部供应商，确保返回配置中的每一项都符合接口约定。
  for (const [index, value] of providers.entries()) {
    const field = `modelProviders[${index}]`;
    const validated = parseProvider(value, field);
    if (names.has(validated.name)) {
      throw new Error(`${field}.name 不得重复。`);
    }
    names.add(validated.name);
    validatedProviders.push(validated);
    if (validated.name === provider) {
      selected = validated;
    }
  }
  if (!selected) {
    throw new Error("provider 必须与 modelProviders 中的 name 精确匹配。");
  }
  // 模型必须属于所选供应商，不能仅凭其他供应商存在同名模型就接受配置。
  /**
   * 判断模型标识是否与顶层选择一致。
   * @param entry - 所选供应商的模型条目。
   * @returns 模型标识是否精确匹配。
   */
  const found = selected.models.some((entry) => entry.id === id);
  if (!found) {
    throw new Error("model 必须与所选供应商 models 中的 id 精确匹配。");
  }
  return { provider, model: id, modelProviders: validatedProviders };
}
