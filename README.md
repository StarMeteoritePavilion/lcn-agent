# lcn-agent

采用独立能力包与顶层统一装配架构的 Agent 项目。

> 正式源码统一存放在 `src`。当前已实现配置加载与顶层启动入口，Agent 执行循环和终端界面尚未实现。协议研究与学习笔记存放在 `docs`。

## 架构方向

- `base`：基础能力，配置加载封装在 `src/base/config-load.ts`，由顶层入口调用。
- `ai`：模型请求、供应商协议及流式响应解析。
- `agent`：执行循环、运行消息、工具校验与调度、授权约束及取消。
- `tui`：终端输入、渲染及终端生命周期。
- 其他能力包提供 MCP、Skills、存储等独立能力。
- 下层包互不引用，包括类型依赖；顶层 `lcn-agent` 负责扩展宿主、统一装配及必要适配。
- 具体功能通过顶层扩展接入，不绕过内核执行约束。
- 不要求对外发布 SDK，不提前建立空包或占位接口。

## 开发基础

项目运行要求为 Node.js 22 及以上；日常开发和 CI 统一使用 [.node-version](.node-version) 中的 Node.js 22.23.3，以及 `package.json` 的 `packageManager` 声明的 npm 10.9.9。先将本地环境切换到这组版本，再安装依赖。

使用 npm 管理根目录项目依赖，通过 [.npmrc](.npmrc) 统一使用官方 npm registry。当前运行依赖只有 TOML 解析器 `smol-toml`；模型 SDK 在对应模块接入时再添加。研究文档按各自标注的 SDK 版本引用公开源码，不依赖本地安装这些 SDK。

```sh
npm ci --ignore-scripts
npm run format
npm run verify
```

`npm run format` 使用现有 Prettier 配置统一排版；`npm run format:check` 只检查、不修改文件。两者自动遵循 `.gitignore`，跳过依赖、构建产物和本地配置。`npm run verify` 依次执行格式检查、测试和构建；测试准备阶段已检查全部源码与测试的类型，是提交前的统一验证入口。

也可以分别执行：

```sh
npm run check
npm run build
npm test
```

[GitHub Actions 工作流](.github/workflows/ci.yml) 在推送和拉取请求时触发，在 Ubuntu 上读取 `.node-version` 配置 Node.js，再执行 `npm ci --ignore-scripts` 和 `npm run verify`。工作流使用只读仓库权限，官方 Actions 固定到已核实版本对应的提交。

`npm run check` 和 `npm run build` 分别执行类型检查和源码编译。构建前自动清理 `dist`，避免保留已删除源码的产物。`tsconfig.json` 仅包含 `src/**/*.ts`，使用 ES2022 标准库与 Node.js 类型，并要求显式标记类型导入。编译后按源码目录结构输出 JavaScript 和源码映射到项目根目录的 `dist`，例如 `src/main.ts` 对应 `dist/main.js`。当前作为应用开发，不生成 SDK 类型声明文件。

测试放在根目录 `test`，目录结构与 `src` 对应，文件使用 `.test.ts` 后缀，通过 Node.js 内置的 `node:test` 覆盖配置加载与启动入口。

`npm test` 自动先执行 `pretest`：清理 `.build/test`，再使用 `tsconfig.test.json` 将全部源码与测试编译到该目录。随后 `test` 进入该目录运行 `node --test`，递归发现测试。新增测试子目录无需修改命令，也不会执行已删除测试的残留产物。测试使用临时配置文件，不需要真实 API 密钥，不发送外部请求。

参考资料包括 [模型协议比较](docs/research/api/ai-protocol-comparison.md) 和 [TypeScript 学习笔记](docs/study/knowledge.md)。研究文档与学习示例用于理解设计和协议，不代表当前已实现的功能。

文档与说明使用中文。项目维护的 TypeScript 函数必须提供中文 TSDoc，具体要求见 [开发规范](AGENTS.md)。

## 本地配置

首次使用时，将 [config.example.toml](config.example.toml) 复制为 `config.toml`，将 [.env.example](.env.example) 复制为 `.env`。已有这两个文件时保留原内容，仅合并需要的配置。实际密钥写入 `.env`；两个本地配置文件均由 Git 忽略，仓库只维护示例文件。

示例只演示现有加载器支持的 `API_KEY`、`BASE_URL`、`MODEL` 占位符替换，不定义未来模型模块的业务字段。`BASE_URL` 使用不可用作真实服务的示例地址；入口仅验证配置能够加载，不会发起模型请求。

`src/base/config-load.ts` 导出同步函数 `loadConfig(configPath?: string)`，由 `src/main.ts` 直接导入调用。默认读取当前工作目录的 `config.toml`，也可传入绝对路径或相对于当前工作目录的路径。`.env` 始终从配置文件所在目录读取。配置加载测试位于 `test/base/config-load.test.ts`，入口测试位于 `test/main.test.ts`。

后续 `model`、`mcp` 等模块使用独立配置文件，由顶层入口分别向 `loadConfig(configPath)` 传入各文件路径，再将加载结果传给对应模块。每次调用独立读取指定 TOML 文件及其同目录 `.env`，不自动合并文件、不共享配置缓存。加载器不限定文件名、配置块名称或业务字段；各模块负责定义并校验自身配置。当前入口仍只加载 `config.toml`，后续模块的文件路径与业务字段在接入时确定。

TOML 字符串值写成 `"${API_KEY}"`、`"${BASE_URL}"` 或 `"${MODEL}"` 时，使用花括号内的原始变量名精确查找，区分大小写，不转换名称。读取顺序为：同目录 `.env` → 进程环境变量 → 原配置值。空字符串视为未配置；仅包含空格的值仍然有效。

仅整个字符串为 `${变量名}` 时才替换，字符串中的内嵌占位符保持原样。匹配后直接按变量名读取值，无需额外的变量展开依赖。替换会遍历嵌套表和数组，不修改字段名、数字、布尔值或日期时间；替换结果不再展开。环境变量的值保持字符串类型，反斜杠和美元符号按原值保留。

`.env` 使用 Node.js 内置 `parseEnv` 解析，不向 `process.env` 写入变量。`.env` 不存在时仍可加载配置；配置文件不存在、TOML 格式错误和其他文件读取错误会抛出异常。空 TOML 文件返回空配置表。

执行 `npm run build` 后，在项目根目录运行 `node dist/main.js` 会加载配置，成功时仅输出“配置加载成功。”，不输出配置内容或替换后的环境变量值；失败时输出中文提示并以非零状态退出。导入入口或配置模块不会自动读取配置，也不会发起模型请求。现有 `.env` 和 `config.toml` 内容保持原样。

## 许可证

[MIT](LICENSE)，版权持有人：lcn29。
