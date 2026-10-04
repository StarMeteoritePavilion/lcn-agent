import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { TomlDate } from "smol-toml";
import { loadConfig } from "../../src/base/config-load.ts";

const configUrl = new URL("../../src/base/config-load.js", import.meta.url);

/**
 * 创建独立的临时配置目录，并在测试结束后删除。
 * @param t - 注册清理回调的测试上下文。
 * @param toml - 要写入的 TOML 文本，默认空文件。
 * @param env - 要写入的 .env 文本；未传入时不创建 .env。
 * @returns 临时目录中的 config.toml 绝对路径。
 * @throws 临时目录创建或文件写入失败时抛出异常。
 */
function createConfig(t: TestContext, toml = "", env?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "lcn-config-"));
  /** 删除本次测试的临时目录及全部内容。 */
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.toml");
  writeFileSync(configPath, toml);
  if (env !== undefined) {
    writeFileSync(join(directory, ".env"), env);
  }
  return configPath;
}

/**
 * 临时设置进程环境变量，并在测试结束后恢复原值。
 * @param t - 注册恢复回调的测试上下文。
 * @param name - 原样使用的环境变量名。
 * @param value - 临时值；未传入时删除变量。
 * @remarks 同步测试中使用，避免并行修改进程环境。
 */
function setEnv(t: TestContext, name: string, value?: string): void {
  const previous = process.env[name];
  /** 恢复环境变量的原值，原先不存在时删除该变量。 */
  t.after(() => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  });
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/**
 * 验证 .env 优先、空值回退、空格有效以及加载过程不改写进程环境。
 * @param t - 提供临时文件和环境变量清理的测试上下文。
 */
test("按 .env、进程环境变量、原值的顺序替换", (t) => {
  setEnv(t, "API_KEY", "进程密钥");
  setEnv(t, "BASE_URL", "https://example.invalid");
  setEnv(t, "MODEL", "进程模型");
  const configPath = createConfig(
    t,
    'API_KEY = "${API_KEY}"\nBASE_URL = "${BASE_URL}"\nMODEL = "${MODEL}"',
    'API_KEY="文件密钥"\nBASE_URL=\nMODEL="   "',
  );
  const config = loadConfig(configPath);
  assert.equal(config.API_KEY, "文件密钥");
  assert.equal(config.BASE_URL, "https://example.invalid");
  assert.equal(config.MODEL, "   ");
  assert.equal(process.env.API_KEY, "进程密钥");
  assert.equal(process.env.BASE_URL, "https://example.invalid");
  assert.equal(process.env.MODEL, "进程模型");
});

/**
 * 验证空值和缺失变量保留原占位符，并且 .env 不向进程环境添加变量。
 * @param t - 提供临时文件和环境变量清理的测试上下文。
 */
test("空值与缺失变量保留原值", (t) => {
  setEnv(t, "API_KEY", "");
  setEnv(t, "BASE_URL");
  setEnv(t, "MODEL");
  const config = loadConfig(
    createConfig(
      t,
      'API_KEY = "${API_KEY}"\nBASE_URL = "${BASE_URL}"\nMODEL = "${MODEL}"',
      'API_KEY=\nMODEL="文件模型"',
    ),
  );
  assert.equal(config.API_KEY, "${API_KEY}");
  assert.equal(config.BASE_URL, "${BASE_URL}");
  assert.equal(config.MODEL, "文件模型");
  assert.equal(process.env.API_KEY, "");
  assert.equal(Object.hasOwn(process.env, "BASE_URL"), false);
  assert.equal(Object.hasOwn(process.env, "MODEL"), false);
});

/**
 * 验证整值匹配、名称精确查找和替换结果不再次展开。
 * @param t - 提供临时文件和环境变量清理的测试上下文。
 */
test("仅匹配完整占位符且只替换一次", (t) => {
  setEnv(t, "API_KEY");
  setEnv(t, "api_key");
  const config = loadConfig(
    createConfig(
      t,
      [
        'API_KEY = "${API_KEY}"',
        'BASE_URL = "https://${API_KEY}"',
        'MODEL = "${API_KEY}${BASE_URL}"',
        'lower = "${api_key}"',
        'spaces = "${ API_KEY }"',
        'newline = "${API_KEY}\\n"',
        'empty = "${}"',
        'plain = "API_KEY"',
        'prototype = "${toString}"',
        '"${API_KEY}" = "${API_KEY}"',
      ].join("\n"),
      'API_KEY="${MODEL}"\nMODEL="文件模型"',
    ),
  );
  assert.equal(config.API_KEY, "${MODEL}");
  assert.equal(config.BASE_URL, "https://${API_KEY}");
  assert.equal(config.MODEL, "${API_KEY}${BASE_URL}");
  assert.equal(config.lower, "${api_key}");
  assert.equal(config.spaces, "${ API_KEY }");
  assert.equal(config.newline, "${API_KEY}\n");
  assert.equal(config.empty, "${}");
  assert.equal(config.plain, "API_KEY");
  assert.equal(config.prototype, "${toString}");
  assert.equal(config["${API_KEY}"], "${MODEL}");
});

/**
 * 验证替换时原样保留变量值中的占位符、反斜杠和美元符号。
 * @param t - 提供临时文件和环境变量清理的测试上下文。
 */
test("替换时保留变量值原文", (t) => {
  setEnv(t, "API_KEY");
  setEnv(t, "MODEL", "不应被展开的模型");
  const configPath = createConfig(t, 'API_KEY = "${API_KEY}"');
  for (const value of [
    "${MODEL}",
    "${API_KEY}",
    "\\$MODEL",
    "\\\\${MODEL}",
    "$&",
    "$$",
    "$1",
    "${MODEL:-默认值}",
  ]) {
    process.env.API_KEY = value;
    assert.equal(loadConfig(configPath).API_KEY, value);
  }
});

/**
 * 验证嵌套表、数组和表数组中的替换，并保留数字、布尔值和全部日期时间类型。
 * @param t - 提供临时目录清理的测试上下文。
 */
test("递归替换并保留 TOML 类型", (t) => {
  const toml = [
    'values = ["${API_KEY}", ["${MODEL}"], { MODEL = "${MODEL}" }, 42, true]',
    "integer = 7",
    "float = 1.5",
    "enabled = false",
    "datetime = 2026-10-04T12:00:00Z",
    "local_datetime = 2026-10-04T12:00:00",
    "date = 2026-10-04",
    "time = 12:00:00",
    "[nested.inner]",
    'API_KEY = "${API_KEY}"',
    "[[models]]",
    'MODEL = "${MODEL}"',
  ].join("\n");
  const config = loadConfig(createConfig(t, toml, 'API_KEY="文件密钥"\nMODEL="文件模型"'));
  assert.deepEqual(config.values, [
    "文件密钥",
    ["文件模型"],
    Object.assign(Object.create(null), { MODEL: "文件模型" }),
    42,
    true,
  ]);
  assert.equal(config.integer, 7);
  assert.equal(config.float, 1.5);
  assert.equal(config.enabled, false);
  for (const [key, expected] of [
    ["datetime", "2026-10-04T12:00:00.000Z"],
    ["local_datetime", "2026-10-04T12:00:00.000"],
    ["date", "2026-10-04"],
    ["time", "12:00:00.000"],
  ]) {
    const value = config[key];
    assert.ok(value instanceof TomlDate);
    assert.equal(value.toISOString(), expected);
  }
  assert.equal(JSON.stringify(config.nested), '{"inner":{"API_KEY":"文件密钥"}}');
  assert.equal(JSON.stringify(config.models), '[{"MODEL":"文件模型"}]');
});

/**
 * 验证同一文件中的 model 和 mcp 配置块独立保留结构并完成变量替换。
 * @param t - 提供临时文件和环境变量清理的测试上下文。
 * @remarks 配置块中的字段仅用于测试通用加载行为，不定义后续模块的业务配置契约。
 */
test("同一文件支持多个模块配置块", (t) => {
  setEnv(t, "API_KEY", "进程密钥");
  setEnv(t, "MODEL", "进程模型");
  setEnv(t, "BASE_URL");
  const toml = [
    "[model]",
    'API_KEY = "${API_KEY}"',
    'MODEL = "${MODEL}"',
    "[mcp]",
    'API_KEY = "${API_KEY}"',
    'BASE_URL = "${BASE_URL}"',
  ].join("\n");
  const configPath = createConfig(t, toml, 'API_KEY="文件密钥"');
  const config = loadConfig(configPath);
  const expectedModel = Object.assign(Object.create(null), {
    API_KEY: "文件密钥",
    MODEL: "进程模型",
  });
  const expectedMcp = Object.assign(Object.create(null), {
    API_KEY: "文件密钥",
    BASE_URL: "${BASE_URL}",
  });
  assert.deepEqual(Object.keys(config), ["model", "mcp"]);
  assert.deepEqual(config.model, expectedModel);
  assert.deepEqual(config.mcp, expectedMcp);
});

/**
 * 验证不同文件独立读取各自目录的 .env，并在再次加载时返回独立配置对象。
 * @param t - 提供临时文件和环境变量清理的测试上下文。
 * @remarks 文件中的字段仅用于测试通用加载行为，不定义后续模块的业务配置契约。
 */
test("独立配置文件使用各自的环境变量且互不影响", (t) => {
  setEnv(t, "API_KEY", "进程密钥");
  const firstPath = createConfig(t, 'API_KEY = "${API_KEY}"', 'API_KEY="第一个文件密钥"');
  const secondPath = createConfig(t, 'API_KEY = "${API_KEY}"', 'API_KEY="第二个文件密钥"');
  const first = loadConfig(firstPath);
  const second = loadConfig(secondPath);
  assert.equal(first.API_KEY, "第一个文件密钥");
  assert.equal(second.API_KEY, "第二个文件密钥");
  first.API_KEY = "修改后的值";
  assert.equal(second.API_KEY, "第二个文件密钥");
  assert.equal(loadConfig(firstPath).API_KEY, "第一个文件密钥");
  assert.equal(process.env.API_KEY, "进程密钥");

  const sharedDirectoryPath = join(dirname(firstPath), "second.toml");
  writeFileSync(sharedDirectoryPath, 'API_KEY = "${API_KEY}"');
  assert.equal(loadConfig(sharedDirectoryPath).API_KEY, "第一个文件密钥");
});

/**
 * 验证 .env 缺失时读取进程变量，并接受空 TOML 文件。
 * @param t - 提供临时文件和环境变量清理的测试上下文。
 */
test("允许缺失 .env 和空 TOML", (t) => {
  setEnv(t, "MODEL", "进程模型");
  assert.equal(loadConfig(createConfig(t, 'MODEL = "${MODEL}"')).MODEL, "进程模型");
  assert.deepEqual(Object.keys(loadConfig(createConfig(t))), []);
});

/**
 * 验证文件缺失、TOML 格式错误以及目录被当作文件读取时均抛出异常。
 * @param t - 提供临时目录清理的测试上下文。
 */
test("读取失败和无效 TOML 抛出异常", (t) => {
  const configPath = createConfig(t, 'API_KEY = "未闭合');
  /**
   * 尝试加载无效 TOML，以验证解析失败向调用方传播。
   * @throws TOML 字符串未闭合时抛出解析异常。
   */
  assert.throws(() => {
    loadConfig(configPath);
  });
  /**
   * 尝试加载不存在的文件，以验证读取失败向调用方传播。
   * @throws 配置文件不存在时抛出 ENOENT 读取异常。
   */
  assert.throws(
    () => {
      loadConfig(join(dirname(configPath), "missing.toml"));
    },
    { code: "ENOENT" },
  );
  /**
   * 尝试将目录作为配置文件读取，以验证配置读取错误向调用方传播。
   * @throws 将目录作为文件读取时抛出 EISDIR 读取异常。
   */
  assert.throws(
    () => {
      loadConfig(dirname(configPath));
    },
    { code: "EISDIR" },
  );
  writeFileSync(configPath, "");
  mkdirSync(join(dirname(configPath), ".env"));
  /**
   * 尝试加载无法作为文件读取的 .env，以验证该错误不会被忽略。
   * @throws .env 为目录时抛出 EISDIR 读取异常。
   */
  assert.throws(
    () => {
      loadConfig(configPath);
    },
    { code: "EISDIR" },
  );
});

/**
 * 验证导入不会自动加载配置，并且默认路径相对于当前工作目录。
 * @param t - 提供临时目录清理的测试上下文。
 */
test("导入无副作用且默认读取当前工作目录", (t) => {
  const configPath = createConfig(t, 'MODEL = "未闭合');
  const cwd = dirname(configPath);
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(configUrl.href)});`],
    { cwd, encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
  writeFileSync(configPath, 'MODEL = "测试模型"');
  const loaded = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { loadConfig } = await import(${JSON.stringify(configUrl.href)}); if (loadConfig().MODEL !== "测试模型") { process.exitCode = 1; }`,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, "");
  assert.equal(loaded.stderr, "");
});
