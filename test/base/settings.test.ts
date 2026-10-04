import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { loadSettings } from "../../src/base/settings.ts";

// 子进程加载与当前测试文件相同格式的模块，兼容源码及编译产物。
const extension = extname(fileURLToPath(import.meta.url));
const configUrl = new URL(`../../src/base/settings${extension}`, import.meta.url);

/**
 * 创建测试配置及可选的环境文件，并注册清理。
 * @param t - 测试上下文。
 * @param value - 序列化为 JSON 的值，默认空对象。
 * @param env - 环境文件内容；省略时不创建文件。
 * @returns 配置文件绝对路径。
 * @throws 文件创建失败时抛出异常。
 */
function createConfig(t: TestContext, value: unknown = {}, env?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "lcn-config-"));
  /** 清理测试目录。 */
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "setting.json");
  writeFileSync(path, JSON.stringify(value));
  if (env !== undefined) {
    writeFileSync(join(directory, ".env"), env);
  }
  return path;
}

/**
 * 设置测试环境变量并注册恢复。
 * @param t - 测试上下文。
 * @param name - 精确使用的变量名。
 * @param value - 变量值；省略时删除变量。
 */
function setEnv(t: TestContext, name: string, value?: string): void {
  const previous = process.env[name];
  /** 恢复环境变量原值。 */
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
 * 构造完整配置，供公开加载接口验证使用。
 * @param id - 模型标识，可包含整值占位符。
 * @returns 包含嵌套供应商和模型数组的配置。
 */
function settings(id = "模型") {
  return {
    provider: "服务商",
    model: id,
    modelProviders: [
      {
        name: "服务商",
        baseUrl: "https://example.invalid/v1",
        apiKey: "${API_KEY}",
        models: [{ id }],
      },
    ],
  };
}

/**
 * 验证公开接口完成嵌套替换、环境优先级与模型选择校验。
 * @param t - 测试上下文。
 */
test("配置校验与环境替换统一完成", (t) => {
  setEnv(t, "API_KEY", "进程密钥");
  setEnv(t, "MODEL", "进程模型");
  const path = createConfig(t, settings("${MODEL}"), 'API_KEY="文件密钥"\nMODEL=');
  const loaded = loadSettings(path);
  assert.equal(loaded.model, "进程模型");
  assert.deepEqual(loaded.modelProviders[0].models, [{ id: "进程模型" }]);
  assert.equal(loaded.modelProviders[0].apiKey, "文件密钥");
  assert.equal(process.env.API_KEY, "进程密钥");
  assert.equal(process.env.MODEL, "进程模型");
  loaded.modelProviders[0].apiKey = "修改后的值";
  assert.equal(loadSettings(path).modelProviders[0].apiKey, "文件密钥");
  const second = createConfig(t, settings(), 'API_KEY="第二个文件密钥"');
  assert.equal(loadSettings(second).modelProviders[0].apiKey, "第二个文件密钥");
  const missingEnv = createConfig(t, settings());
  assert.equal(loadSettings(missingEnv).modelProviders[0].apiKey, "进程密钥");
});

/**
 * 验证整值匹配、变量名大小写及替换后不再次展开。
 * @param t - 测试上下文。
 */
test("精确替换并在使用边界拒绝未解析的值", (t) => {
  setEnv(t, "API_KEY", "有效密钥");
  setEnv(t, "api_key");
  const config = settings();
  const path = createConfig(t, config);
  for (const value of ["\\$MODEL", "$&", "$$", "$1", "前缀${MODEL}"]) {
    process.env.API_KEY = value;
    assert.equal(loadSettings(path).modelProviders[0].apiKey, value);
  }
  for (const value of ["", "${MODEL}"]) {
    process.env.API_KEY = value;
    /** 验证空变量或单次替换后仍为占位符时拒绝业务配置。 */
    assert.throws(() => loadSettings(path));
  }
  process.env.API_KEY = "有效密钥";
  config.modelProviders[0].apiKey = "${api_key}";
  writeFileSync(path, JSON.stringify(config));
  /** 验证不会将小写变量名匹配到大写变量名。 */
  assert.throws(() => loadSettings(path));
});

/**
 * 验证配置错误及读取错误通过公开接口传播。
 * @param t - 测试上下文。
 */
test("拒绝无效配置并传播文件错误", (t) => {
  const path = createConfig(t);
  for (const text of [
    "",
    "{",
    "null",
    "[]",
    "1",
    '"字符串"',
    "true",
    "{}",
    '{"a":1,}',
    "{/* 注释 */}",
  ]) {
    writeFileSync(path, text);
    /** 验证无效配置被拒绝。 */
    assert.throws(() => loadSettings(path));
  }
  /** 验证空路径被拒绝。 */
  assert.throws(() => loadSettings(""));
  /** 验证配置文件缺失的错误。 */
  assert.throws(() => loadSettings(join(dirname(path), "missing.json")), { code: "ENOENT" });
  /** 验证目录不能作为配置文件。 */
  assert.throws(() => loadSettings(dirname(path)), { code: "EISDIR" });
  writeFileSync(path, JSON.stringify(settings()));
  mkdirSync(join(dirname(path), ".env"));
  /** 验证环境文件读取错误不会被忽略。 */
  assert.throws(() => loadSettings(path), { code: "EISDIR" });
});

/**
 * 验证模块仅导出必要接口，导入无副作用且相对路径基于工作目录。
 * @param t - 测试上下文。
 */
test("公开接口和导入行为保持明确", (t) => {
  const path = createConfig(t, settings(), 'API_KEY="测试密钥"');
  const cwd = dirname(path);
  const loaded = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(configUrl.href)}); if (Object.keys(module).join() !== "loadSettings" || module.loadSettings("setting.json").model !== "模型") { process.exitCode = 1; }`,
    ],
    { cwd, encoding: "utf8" },
  );
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout, "");
  writeFileSync(path, "{");
  const imported = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(configUrl.href)});`],
    { cwd, encoding: "utf8" },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});

/**
 * 验证按名称选择数组中的供应商，并拒绝重名及旧对象结构。
 * @param t - 测试上下文。
 */
test("供应商数组按唯一名称选择", (t) => {
  const config = settings();
  const other = { ...config.modelProviders[0], name: "其他服务商", models: [{ id: "其他模型" }] };
  config.modelProviders.unshift(other);
  const path = createConfig(t, config, 'API_KEY="测试密钥"');
  assert.equal(loadSettings(path).provider, "服务商");
  config.modelProviders.push({ ...config.modelProviders[1] });
  writeFileSync(path, JSON.stringify(config));
  /** 重复名称无法唯一定位供应商。 */
  assert.throws(() => loadSettings(path), /name 不得重复/u);
  writeFileSync(path, JSON.stringify({ ...config, modelProviders: {} }));
  /** 旧对象结构不再作为供应商列表接受。 */
  assert.throws(() => loadSettings(path), /必须是供应商对象数组/u);
});

/**
 * 验证嵌套字段错误准确定位，并且不暴露配置值。
 * @param t - 测试上下文。
 */
test("字段错误包含供应商及模型索引", (t) => {
  const config = settings();
  const provider = config.modelProviders[0];
  const cases: [unknown, RegExp][] = [
    [null, /modelProviders\[1\] 必须是供应商对象/u],
    [{ ...provider, name: 42 }, /modelProviders\[1\]\.name/u],
    [{ ...provider, models: null }, /modelProviders\[1\]\.models/u],
    [{ ...provider, models: [null] }, /modelProviders\[1\]\.models\[0\]/u],
    [{ ...provider, models: [{ id: 42 }] }, /modelProviders\[1\]\.models\[0\]\.id/u],
    [{ ...provider, baseUrl: 42 }, /modelProviders\[1\]\.baseUrl/u],
    [{ ...provider, apiKey: { secret: "敏感密钥" } }, /modelProviders\[1\]\.apiKey/u],
  ];
  for (const [invalid, expected] of cases) {
    const path = createConfig(
      t,
      { ...config, modelProviders: [provider, invalid] },
      'API_KEY="测试密钥"',
    );
    /** 验证错误包含精确字段路径。 */
    assert.throws(() => loadSettings(path), expected);
    /**
     * 验证错误不会带出地址或密钥值。
     * @param error - 配置加载抛出的异常。
     * @returns 错误是否未包含敏感配置值。
     */
    const hidesValues = (error: unknown): boolean =>
      error instanceof Error && !/敏感地址|敏感密钥/u.test(error.message);
    /** 验证错误消息未泄露配置值。 */
    assert.throws(() => loadSettings(path), hidesValues);
  }
});

/**
 * 验证模型选择受供应商约束，不能使用其他供应商的同名模型。
 * @param t - 测试上下文。
 */
test("拒绝仅存在于其他供应商的模型", (t) => {
  const config = settings("目标模型");
  config.modelProviders[0].models = [{ id: "其他模型" }];
  config.modelProviders.push({
    ...config.modelProviders[0],
    name: "其他服务商",
    models: [{ id: "目标模型" }],
  });
  const path = createConfig(t, config, 'API_KEY="测试密钥"');
  /** 所选供应商未声明目标模型时必须拒绝配置。 */
  assert.throws(() => loadSettings(path), /model 必须与所选供应商 models 中的 id 精确匹配/u);
});
