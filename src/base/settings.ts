import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { Api } from "../ai/types.ts";

/** 配置省略模型上限时使用的默认生成预算，不代表服务端模型能力。 */
const DEFAULT_MODEL_MAX_TOKENS = 16384;

/** 已校验并补齐默认值的模型配置条目。 */
interface ModelConfig {
  /** 请求使用的模型标识。 */
  id: string;
  /** 模型默认生成令牌上限，必须是正整数；配置省略时补为 16384，服务端仍校验模型支持的上限。 */
  maxTokens: number;
}

/** 配置文件中的供应商信息。 */
interface ProviderConfig {
  /** 唯一的供应商名称，用于与 provider 精确匹配。 */
  name: string;
  /** 本供应商全部模型使用的接口协议。 */
  api: Api;
  /** 接口基础地址，格式及协议由请求方处理。 */
  baseUrl: string;
  /** 经校验的非空 API 密钥；若使用整值环境变量占位符，必须完成替换。 */
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
 * @returns 值为非 null 且非数组的对象时返回 true；空对象也会通过，不检查对象原型。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取必填字符串，拒绝空值和未替换的环境变量占位符。
 * @param value - 原始配置值。
 * @param field - 用于错误提示的字段路径。
 * @returns 校验通过的原始字符串，保留首尾空白。
 * @throws 值不是字符串、去除首尾空白后为空，或原值仍是整值环境变量占位符时抛出包含字段路径的错误，不包含配置值。
 * @remarks trim 仅用于检查空白，不用于修改名称；嵌入其他文本的占位符不会被此函数拒绝。
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /^\$\{[^{}]+\}$/u.test(value)) {
    throw new Error(`${field} 必须是非空字符串，且环境变量占位符必须完成替换。`);
  }
  return value;
}

/**
 * 校验单个供应商的接口协议、连接字段及模型列表，并构造业务配置。
 * @param value - 未校验的供应商配置。
 * @param field - 供应商在配置数组中的路径，用于定位错误。
 * @returns 仅包含声明字段的供应商配置，保留原始字符串与模型顺序。
 * @throws 字段类型无效、接口协议不受支持、模型上限不是正整数、字符串为空或占位符未替换时抛出包含字段路径的错误。
 * @remarks 模型配置省略 maxTokens 时补为 16384；显式提供的值必须通过校验，null 不视为省略。
 */
function parseProvider(value: unknown, field: string): ProviderConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} 必须是供应商对象。`);
  }
  const name = requireString(value.name, `${field}.name`);
  const api = value.api;
  if (api !== "openai-completions" && api !== "anthropic-messages") {
    throw new Error(`${field}.api 必须是 openai-completions 或 anthropic-messages。`);
  }
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
    const maxTokens = entry.maxTokens === undefined ? DEFAULT_MODEL_MAX_TOKENS : entry.maxTokens;
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new Error(`${modelField}.maxTokens 必须是正整数。`);
    }
    models.push({ id, maxTokens });
  }

  const baseUrl = requireString(value.baseUrl, `${field}.baseUrl`);
  const apiKey = requireString(value.apiKey, `${field}.apiKey`);
  return { name, api, baseUrl, apiKey, models };
}

/**
 * 递归替换 JSON 值中的整值占位符，并保留其他类型及未找到变量的字符串。
 * @param value - 待处理的 JSON 值。
 * @param fileEnv - 从配置文件旁的 .env 解析出的变量。
 * @returns 完成一次替换的值；对象和数组在原引用上更新，未找到非空变量值时保留占位符原文。
 * @remarks
 * 仅替换完整的 ${变量名} 字符串，变量名区分大小写，不替换嵌入其他文本的占位符。
 * 非空 .env 值优先于进程环境变量；空字符串视为未配置，纯空白变量值仍会参与替换。
 * 不修改进程环境，也不再次展开替换结果中的占位符；未解决的必填字段由后续业务校验拒绝。
 */
function replaceEnv(value: unknown, fileEnv: NodeJS.Dict<string>): unknown {
  if (typeof value === "string") {
    const match = /^\$\{([^{}]+)\}$/u.exec(value);
    if (!match || match[0] !== value) {
      return value;
    }
    const name = match[1];
    // 只接受变量表自身的键，避免将原型链属性当成配置；逻辑或让空文件变量回退到进程变量。
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
 * @param settingPath - 非空配置文件路径，相对路径基于当前工作目录。
 * @returns 解析并完成替换的配置对象；空对象保持为空对象。
 * @throws 路径为空、配置文件读取失败、JSON 格式错误、顶层不是对象，或 .env 发生文件不存在之外的读取错误时抛出异常。
 * @remarks 每次独立读取并解析；缺失 .env 时仅从进程环境读取变量，不修改环境或文件。业务校验由 loadSettings 完成。
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
    // .env 是可选文件，只忽略文件不存在；权限错误、目录路径等情况仍需让调用方处理。
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  replaceEnv(config, fileEnv);
  return config;
}

/**
 * 读取指定配置文件，校验全部供应商字段以及所选模型是否存在。
 * @param settingPath - 非空配置文件路径，相对路径基于当前工作目录。
 * @returns 新建的已校验配置，仅包含业务声明字段，保留供应商和模型顺序及原始字符串。
 * @throws 路径为空、配置或 .env 读取失败、JSON 格式错误、配置字段无效、供应商名称重复或所选供应商及模型不存在时抛出异常。
 * @remarks
 * 读取配置同目录 .env，每次调用重新加载，不缓存配置或修改进程环境。
 * 对全部供应商做运行时校验，再按原字符串精确选择供应商和模型，不转换大小写或去除首尾空白。
 * 供应商名称必须唯一；所选供应商必须包含所选模型，模型列表本身不检查重复标识。
 * 每个供应商必须显式声明 api，只接受 openai-completions 或 anthropic-messages，不按名称或模型推断协议。
 * 每个模型的 maxTokens 可省略，省略时补为 16384；显式值必须是正整数，返回配置始终包含此字段。
 * maxTokens 作为模型的默认生成预算，不推断服务端的模型能力。
 * 本模块不输出配置或密钥；字段校验错误只描述字段路径和约束，文件读取及 JSON 解析异常按原样传递。
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
  const found = selected.models.some((entry: ModelConfig): boolean => entry.id === id);
  if (!found) {
    throw new Error("model 必须与所选供应商 models 中的 id 精确匹配。");
  }
  return { provider, model: id, modelProviders: validatedProviders };
}
