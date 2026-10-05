import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { loadSettings } from "../../src/base/settings.ts";
import type { Api } from "../../src/ai/types.ts";

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
  const prefix = join(tmpdir(), "lcn-config-");
  const directory = mkdtempSync(prefix);
  /**
   * 清理测试目录。
   * @throws 删除临时目录失败时抛出异常。
   */
  t.after((): void => rmSync(directory, { recursive: true, force: true }));
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
 * @remarks 当前测试结束后恢复原值，不修改其他环境变量。
 */
function setEnv(t: TestContext, name: string, value?: string): void {
  const previous = process.env[name];
  /** 恢复环境变量原值。 */
  t.after((): void => {
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
 * @param api - 供应商使用的接口协议，默认使用 openai-completions。
 * @param maxTokens - 模型默认生成令牌上限，默认沿用原入口的 500000。
 * @returns 包含嵌套供应商和模型数组的配置。
 */
function settings(
  id: string = "模型",
  api: Api = "openai-completions",
  maxTokens: number = 500000,
): ReturnType<typeof loadSettings> {
  return {
    provider: "服务商",
    model: id,
    modelProviders: [
      {
        name: "服务商",
        api,
        baseUrl: "https://example.invalid/v1",
        apiKey: "${API_KEY}",
        models: [{ id, maxTokens }],
      },
    ],
  };
}

/**
 * 验证两种协议的模型默认生成上限均补齐为 16384，保留显式正整数并拒绝非法值。
 * @param t - 提供临时配置清理和环境恢复的测试上下文。
 * @throws 缺省值未补齐、显式上限未保留、非法值被接受或错误路径不符时抛出断言错误。
 */
test("模型默认令牌上限省略时补齐并校验正整数", (t: TestContext): void => {
  setEnv(t, "API_KEY", "测试密钥");
  const apis: Api[] = ["openai-completions", "anthropic-messages"];
  for (const api of apis) {
    const omitted = settings("模型", api);
    Object.assign(omitted.modelProviders[0], {
      models: [{ id: "模型" }, { id: "其他模型", maxTokens: 1234 }],
    });
    const omittedPath = createConfig(t, omitted);
    assert.deepEqual(loadSettings(omittedPath).modelProviders[0].models, [
      { id: "模型", maxTokens: 16384 },
      { id: "其他模型", maxTokens: 1234 },
    ]);
    for (const maxTokens of [1, 1234, 500000]) {
      const path = createConfig(t, settings("模型", api, maxTokens));
      assert.equal(loadSettings(path).modelProviders[0].models[0].maxTokens, maxTokens);
    }
  }
  const config = settings();
  const path = createConfig(t, config);
  for (const maxTokens of [0, -1, 1.5, null, "1234", true, {}, []]) {
    Object.assign(config.modelProviders[0].models[0], { maxTokens });
    writeFileSync(path, JSON.stringify(config));
    /**
     * 验证错误准确指向模型的令牌上限字段。
     * @throws 模型令牌上限无效时抛出配置校验异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    }, /modelProviders\[0\]\.models\[0\]\.maxTokens/u);
  }
  const unselected = settings();
  const other = { id: "其他模型", maxTokens: -1 };
  unselected.modelProviders[0].models.push(other);
  const unselectedPath = createConfig(t, unselected);
  /**
   * 验证未选中的模型显式提供上限时也必须通过校验。
   * @throws 未选中模型的令牌上限无效时抛出配置校验异常。
   */
  assert.throws((): void => {
    loadSettings(unselectedPath);
  }, /modelProviders\[0\]\.models\[1\]\.maxTokens/u);
});

/**
 * 验证供应商协议的精确枚举校验与环境变量替换。
 * @param t - 提供临时配置清理和环境恢复的测试上下文。
 * @throws 协议未保留、无效值未被拒绝或字段路径不符时抛出断言错误。
 */
test("供应商协议必填且只接受支持的精确值", (t: TestContext): void => {
  setEnv(t, "API_KEY", "测试密钥");
  const apis: Api[] = ["openai-completions", "anthropic-messages"];
  for (const api of apis) {
    const path = createConfig(t, settings("模型", api));
    assert.equal(loadSettings(path).modelProviders[0].api, api);
  }
  const config = settings();
  const path = createConfig(t, config);
  for (const api of [
    undefined,
    "",
    " ",
    "OPENAI-COMPLETIONS",
    "openai",
    "anthropic",
    null,
    1,
    true,
    {},
  ]) {
    Object.assign(config.modelProviders[0], { api });
    writeFileSync(path, JSON.stringify(config));
    /**
     * 验证缺失或无效协议准确指向供应商字段。
     * @throws 供应商协议缺失或不受支持时抛出配置校验异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    }, /modelProviders\[0\]\.api/u);
  }
  const other = { ...settings().modelProviders[0], name: "其他服务商" };
  Object.assign(other, { api: "未支持接口" });
  const unselectedPath = createConfig(t, {
    ...settings(),
    modelProviders: [settings().modelProviders[0], other],
  });
  /**
   * 验证未选中的供应商也必须声明有效协议。
   * @throws 未选中供应商的协议不受支持时抛出配置校验异常。
   */
  assert.throws((): void => {
    loadSettings(unselectedPath);
  }, /modelProviders\[1\]\.api/u);
  const replaced = settings();
  Object.assign(replaced.modelProviders[0], { api: "${MODEL_API}" });
  const replacedPath = createConfig(
    t,
    replaced,
    'API_KEY="测试密钥"\nMODEL_API="anthropic-messages"',
  );
  assert.equal(loadSettings(replacedPath).modelProviders[0].api, "anthropic-messages");
});

/**
 * 验证公开接口完成嵌套替换、环境优先级与模型选择校验。
 * @param t - 测试上下文。
 * @throws 配置读取失败、替换结果或进程环境不符时抛出异常。
 */
test("配置校验与环境替换统一完成", (t: TestContext): void => {
  setEnv(t, "API_KEY", "进程密钥");
  setEnv(t, "MODEL", "进程模型");
  const path = createConfig(t, settings("${MODEL}"), 'API_KEY="文件密钥"\nMODEL=');
  const loaded = loadSettings(path);
  assert.equal(loaded.model, "进程模型");
  assert.deepEqual(loaded.modelProviders[0].models, [{ id: "进程模型", maxTokens: 500000 }]);
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
 * @throws 配置替换结果不符或未按要求拒绝未解析的值时抛出异常。
 */
test("精确替换并在使用边界拒绝未解析的值", (t: TestContext): void => {
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
    /**
     * 验证空变量或单次替换后仍为占位符时拒绝业务配置。
     * @throws loadSettings 校验或读取失败时抛出异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    });
  }
  process.env.API_KEY = "有效密钥";
  config.modelProviders[0].apiKey = "${api_key}";
  writeFileSync(path, JSON.stringify(config));
  /**
   * 验证不会将小写变量名匹配到大写变量名。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws((): void => {
    loadSettings(path);
  });
});

/**
 * 验证配置错误及读取错误通过公开接口传播。
 * @param t - 测试上下文。
 * @throws 临时文件操作失败或预期配置读取异常未发生时抛出异常。
 */
test("拒绝无效配置并传播文件错误", (t: TestContext): void => {
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
    /**
     * 验证无效配置被拒绝。
     * @throws loadSettings 校验或读取失败时抛出异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    });
  }
  /**
   * 验证空路径被拒绝。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws((): void => {
    loadSettings("");
  });
  const directory = dirname(path);
  const missingPath = join(directory, "missing.json");
  /**
   * 验证配置文件缺失的错误。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws(
    (): void => {
      loadSettings(missingPath);
    },
    { code: "ENOENT" },
  );
  /**
   * 验证目录不能作为配置文件。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws(
    (): void => {
      loadSettings(directory);
    },
    { code: "EISDIR" },
  );
  const config = settings();
  writeFileSync(path, JSON.stringify(config));
  mkdirSync(join(directory, ".env"));
  /**
   * 验证环境文件读取错误不会被忽略。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws(
    (): void => {
      loadSettings(path);
    },
    { code: "EISDIR" },
  );
});

/**
 * 验证模块仅导出必要接口，导入无副作用且相对路径基于工作目录。
 * @param t - 测试上下文。
 * @throws 临时文件操作失败或子进程行为不符时抛出异常。
 */
test("公开接口和导入行为保持明确", (t: TestContext): void => {
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
 * @throws 供应商选择不符或非法结构未被拒绝时抛出异常。
 */
test("供应商数组按唯一名称选择", (t: TestContext): void => {
  const config = settings();
  const other = {
    ...config.modelProviders[0],
    name: "其他服务商",
    models: [{ id: "其他模型", maxTokens: 500000 }],
  };
  config.modelProviders.unshift(other);
  const path = createConfig(t, config, 'API_KEY="测试密钥"');
  assert.equal(loadSettings(path).provider, "服务商");
  config.modelProviders.push({ ...config.modelProviders[1] });
  writeFileSync(path, JSON.stringify(config));
  /**
   * 重复名称无法唯一定位供应商。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws((): void => {
    loadSettings(path);
  }, /name 不得重复/u);
  writeFileSync(path, JSON.stringify({ ...config, modelProviders: {} }));
  /**
   * 旧对象结构不再作为供应商列表接受。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws((): void => {
    loadSettings(path);
  }, /必须是供应商对象数组/u);
});

/**
 * 验证嵌套字段错误准确定位，并且不暴露配置值。
 * @param t - 测试上下文。
 * @throws 错误路径不符或错误信息泄露配置值时抛出断言错误。
 */
test("字段错误包含供应商及模型索引", (t: TestContext): void => {
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
    /**
     * 验证错误包含精确字段路径。
     * @throws loadSettings 校验或读取失败时抛出异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    }, expected);
    /**
     * 验证错误不会带出地址或密钥值。
     * @param error - 配置加载抛出的异常。
     * @returns 错误是否未包含敏感配置值。
     */
    const hidesValues = (error: unknown): boolean =>
      error instanceof Error && !/敏感地址|敏感密钥/u.test(error.message);
    /**
     * 验证错误消息未泄露配置值。
     * @throws loadSettings 校验或读取失败时抛出异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    }, hidesValues);
  }
});

/**
 * 验证模型选择受供应商约束，不能使用其他供应商的同名模型。
 * @param t - 测试上下文。
 * @throws 所选供应商未声明的模型被接受时抛出断言错误。
 */
test("拒绝仅存在于其他供应商的模型", (t: TestContext): void => {
  const config = settings("目标模型");
  config.modelProviders[0].models = [{ id: "其他模型", maxTokens: 500000 }];
  config.modelProviders.push({
    ...config.modelProviders[0],
    name: "其他服务商",
    models: [{ id: "目标模型", maxTokens: 500000 }],
  });
  const path = createConfig(t, config, 'API_KEY="测试密钥"');
  /**
   * 所选供应商未声明目标模型时必须拒绝配置。
   * @throws loadSettings 校验或读取失败时抛出异常。
   */
  assert.throws((): void => {
    loadSettings(path);
  }, /model 必须与所选供应商 models 中的 id 精确匹配/u);
});

/**
 * 验证必填字符串拒绝缺失、空白及未解析占位符，错误准确指向字段。
 * @param t - 提供临时配置清理和环境恢复的测试上下文。
 * @throws 非法字符串被接受或错误路径不符时抛出断言错误。
 */
test("必填字符串统一校验类型空白及未解析占位符", (t: TestContext): void => {
  setEnv(t, "API_KEY", "测试密钥");
  setEnv(t, "LCN_SETTINGS_MISSING");
  const config = settings();
  const provider = config.modelProviders[0];
  const path = createConfig(t, config);
  for (const value of [undefined, null, 0, false, "", " \t", "${LCN_SETTINGS_MISSING}"]) {
    const cases: [unknown, RegExp][] = [
      [{ ...config, provider: value }, /provider 必须是非空字符串/u],
      [{ ...config, model: value }, /model 必须是非空字符串/u],
      [{ ...config, modelProviders: [{ ...provider, name: value }] }, /modelProviders\[0\]\.name/u],
      [
        { ...config, modelProviders: [{ ...provider, baseUrl: value }] },
        /modelProviders\[0\]\.baseUrl/u,
      ],
      [
        { ...config, modelProviders: [{ ...provider, apiKey: value }] },
        /modelProviders\[0\]\.apiKey/u,
      ],
      [
        { ...config, modelProviders: [{ ...provider, models: [{ id: value }] }] },
        /modelProviders\[0\]\.models\[0\]\.id/u,
      ],
    ];
    for (const [invalid, expected] of cases) {
      writeFileSync(path, JSON.stringify(invalid));
      /**
       * 验证非法必填字符串按精确字段路径拒绝。
       * @throws loadSettings 校验或读取失败时抛出异常。
       */
      assert.throws((): void => {
        loadSettings(path);
      }, expected);
    }
  }
});

/**
 * 验证供应商和模型按原文精确选择，保留有效字符串的首尾空白。
 * @param t - 提供临时配置清理的测试上下文。
 * @throws 字符串被规范化或不匹配的选择被接受时抛出断言错误。
 */
test("名称和模型精确选择且不裁剪有效字符串", (t: TestContext): void => {
  const config = settings(" ExactModel ");
  config.provider = " ExactProvider ";
  config.modelProviders[0].name = config.provider;
  config.modelProviders[0].baseUrl = " https://example.invalid/v1 ";
  config.modelProviders[0].apiKey = " 测试密钥 ";
  const path = createConfig(t, config);
  assert.deepEqual(loadSettings(path), config);
  for (const provider of ["ExactProvider", " exactprovider "]) {
    writeFileSync(path, JSON.stringify({ ...config, provider }));
    /**
     * 验证供应商名称不忽略首尾空白或大小写。
     * @throws loadSettings 校验或读取失败时抛出异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    }, /provider 必须与 modelProviders 中的 name 精确匹配/u);
  }
  for (const model of ["ExactModel", " exactmodel "]) {
    writeFileSync(path, JSON.stringify({ ...config, model }));
    /**
     * 验证模型标识不忽略首尾空白或大小写。
     * @throws loadSettings 校验或读取失败时抛出异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    }, /model 必须与所选供应商 models 中的 id 精确匹配/u);
  }
});

/**
 * 验证环境占位符不会读取变量表的原型链属性。
 * @param t - 提供临时配置清理和环境恢复的测试上下文。
 * @throws 原型链属性被当作密钥接受时抛出断言错误。
 */
test("环境占位符只读取变量表自身属性", (t: TestContext): void => {
  for (const name of ["toString", "constructor", "__proto__"]) {
    setEnv(t, name);
    const config = settings();
    config.modelProviders[0].apiKey = "${" + name + "}";
    const path = createConfig(t, config);
    /**
     * 验证未显式配置的原型属性名保持未解析并被业务校验拒绝。
     * @throws loadSettings 校验或读取失败时抛出异常。
     */
    assert.throws((): void => {
      loadSettings(path);
    }, /modelProviders\[0\]\.apiKey/u);
  }
});
