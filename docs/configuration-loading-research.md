# config.toml 与可选 .env 配置加载调研

调研日期：2026-09-21。以下保留实施前的调研快照；配置加载现已按此方案实现，未修改学习进度。
当前使用方式见 README，验证入口为 `npm test` 和 `tests/terminal-cancel.py`。

## 1. 结论

建议新增一个 `src/config.ts`，由应用内统一加载可选 `.env`，再读取并解析必填的 `config.toml`，
替换字符串中的 `${key}`，最后校验并返回配置。使用 Node 自带的 `loadEnvFile()`，只新增 TOML 解析依赖。

这里对前面讨论作一处调整：去掉启动命令的 `.env` 加载参数，把加载职责放进应用。
这样 `npm start`、直接执行 `node dist/index.js` 和 VS Code 调试都能走同一流程。
这是基于当前入口的方案选择，不是已经实现的能力。[L1][L2][L3]

## 2. 已核实的项目现状

| 位置 | 当前事实 | 修改影响 |
| --- | --- | --- |
| `src/index.ts` | `requireEnv()` 读取 `API_KEY`、`BASE_URL`、`MODEL`，客户端在顶层初始化 | 替换配置来源，保留模型请求和工具循环 |
| `package.json` | `start` 为 `tsc && node --env-file=.env dist/index.js`；运行依赖只有 `openai` | 去掉 CLI 环境文件加载；新增 TOML 库 |
| `tsconfig.json` | `module: NodeNext`、`strict: true`，只编译 `src/**/*.ts` | 新模块使用 ESM，项目内导入带 `.js` 后缀 |
| `README.md` | 声明 Node.js >= 22；给出直接运行 `node dist/index.js` 的命令 | 应用内加载可覆盖这个入口 |
| `.env.example` | 已有 `BASE_URL`、`API_KEY`、`MODEL` | 初次迁移保留这三个名称 |
| `.vscode/launch.json` | 单独设置 `envFile`，没有显式设置 `cwd` | 移除 `envFile`，显式指定仓库根目录 |
| `tests/terminal-cancel.py` | 注入上述三个环境变量，以仓库根目录直接执行 Node | 默认 TOML 保留三项引用可继续兼容 |
| `docs/agent-coordination-guide.md` | `src/index.ts` 是主实现，`stage-xx.ts` 仅作备份 | 不修改备份文件，不标记阶段完成 |

以上均来自当前文件，而非此前对话推断；没有读取真实 `.env` 内容。[L1][L2][L3][L4][L5][L6]

## 3. Node 与 TOML 的一手证据

| 核实项 | 官方事实 | 对本方案的意义 |
| --- | --- | --- |
| `--env-file-if-exists=file` | 自 Node v22.9.0 提供；文件缺失不抛错误，其他行为同 `--env-file` | 单改 CLI 也可支持可选文件，但不能覆盖直接 Node 入口 [S1] |
| `--env-file=file` | 文件缺失抛错；同名时已有环境变量优先 | 当前启动命令要求 `.env` 存在 [S1] |
| `loadEnvFile(path)` | 自 v20.12.0 / v21.7.0 提供，默认 `./.env`，加载至 `process.env` | 项目现有 Node >= 22 下可用，不需 `dotenv` [S2] |
| 应用内加载优先级 | Node 源码仅在环境变量不存在时设置文件值 | 空字符串也算已存在，不回退到 `.env` [S3] |
| Node 启动配置 | `loadEnvFile()` 加载的 `NODE_OPTIONS` 不影响已启动 Node；CLI 可以应用该值 | 本方案面向 Agent 配置；Node 启动参数放启动命令或外部环境 [S1][S2] |
| TOML 字符串 | TOML 定义字符串、转义、数组和表，不定义 `${key}` 环境变量插值 | 插值属于本项目契约，要在解析后实现 [S4] |
| TOML 库 | `smol-toml` 1.8.0 提供 `parse()`、ESM 导出和类型声明，要求 Node >= 18 | 符合当前 ESM / NodeNext 项目，不需要单独类型包 [S5][S6] |

官方库的最小调用形式是 `import { parse } from "smol-toml"`，然后 `parse(text)`。[S5]
本次已把官方 npm 1.8.0 发布包解压到临时目录，使用项目 TypeScript 编译器以
`--module NodeNext --target ES2022 --strict` 编译并运行；导入与解析通过，`${API_KEY}` 保持原字符串。
未给项目安装依赖、未改锁文件。这只验证库兼容性，不代表新配置模块通过测试。

`smol-toml` 还支持 TOML 日期对象；遍历时只能递归数组和表，不要把日期对象当作普通表重建。
官方 README 明确列有日期合法性和整数精度限制；当前三个字符串字段不依赖这些能力。[S5]

## 4. 建议的配置契约

以下文件、导出函数和字段结构是本次提案，不是现有配置 API。
字段 `apiKey`、`baseURL` 对应当前 OpenAI 客户端参数；`model` 对应当前请求变量。[L1]

建议根目录新增 `config.toml`：

```toml
apiKey = "${API_KEY}"
baseURL = "${BASE_URL}"
model = "${MODEL}"
```

初次迁移保留已有三个变量名，不需要搬动真实密钥。之后可以把非敏感地址、模型名改成实际固定值。

建议 `src/config.ts` 导出 `loadConfig()`，其返回值只包含这三个经过校验的字符串。
规则如下：

1. 文件位置：以当前工作目录为基准读取 `.env` 和 `config.toml`；文档要求从仓库根目录启动。
   不增加向父目录搜索、用户目录覆盖、多环境合并等规则。
2. `.env` 可选：调用 `loadEnvFile(".env")`，只忽略 `ENOENT`；权限错误等其他读取失败必须终止。
   `config.toml` 必填；文件不存在、读取失败或 TOML 语法错误均终止启动。
3. 顺序：加载 `.env` → 解析 TOML → 替换字符串值 → 校验字段 → 初始化 OpenAI 客户端。
   先解析再替换，环境值中的引号、反斜杠和换行就不会改变 TOML 结构。[S4]
4. 引用：`${key}` 按其中原名查 `process.env`，不转换大小写、不改格式、不推测别名。
   对象键名不替换；数组和嵌套表中的字符串值可以替换；没有引用的值保持原样。
5. 插值只执行一次：支持字符串中的多个引用，环境值本身包含 `${...}` 时原样保留，不能递归展开。
   首版不增加默认值表达式、命令执行或二次模板解析。
6. 缺失与空值分开：引用不存在时直接报错；已设置空字符串不能回退到 `.env`。
   最终 `apiKey`、`baseURL`、`model` 必须是非空、非全空白的字符串；校验可用 `trim()` 判断，
   返回原值，不擅自修改密钥或其他配置内容。
7. 类型：环境值替换后仍是字符串，不自动转数字或布尔值。TOML 固定值不被同名环境变量覆盖。
8. 报错：只输出文件名、缺失变量名、字段名及安全位置，不打印配置对象、变量值或原始 TOML 行。
   不直接透传解析器错误消息，防止错误上下文包含内联密钥。

这不是“环境变量 > `.env` > TOML”的三层覆盖：TOML 决定是否引用变量；只有引用变量时才比较前两者。
例如 `apiKey = "固定值"` 会直接使用该固定值，不查询 `API_KEY`。

## 5. 具体修改清单与顺序

| 顺序 | 文件 | 修改内容 |
| --- | --- | --- |
| 1 | `package.json`、`package-lock.json` | 安装 `smol-toml` 1.8.0；`start` 改为 `tsc && node dist/index.js` |
| 2 | 新增 `config.toml` | 加入上面的三个占位符，作为可提交的默认配置 |
| 3 | 新增 `src/config.ts` | 实现 `loadConfig()`：可选环境文件、TOML 解析、插值、校验和安全错误信息 |
| 4 | `src/index.ts` | 移除 `requireEnv()`；导入 `./config.js`；客户端使用配置的 `apiKey`、`baseURL` 和 `model` |
| 5 | `.vscode/launch.json` | 移除 `envFile`；增加 `"cwd": "${workspaceFolder}"`；由应用完成加载 |
| 6 | 新增 `tests/config.test.mjs` | 用 Node 内置测试和临时目录验证配置加载，不访问真实模型 |
| 7 | `README.md`、`docs/vscode-debugging-guide.md` | 更新可选 `.env`、固定值与引用、优先级、启动目录和调试步骤 |

`tests/config.test.mjs` 是建议新增路径，不是已经存在的测试。
`.vscode/launch.json` 被忽略，调试指南需记录同样配置，保证其他检出也能复现。[L3][L6]
`.env.example` 可保留三个现有空值；`.gitignore` 中继续忽略真实 `.env`。[L4][L6]

需要同时处理初始化错误边界：当前客户端创建和 `model` 读取位于入口末尾 `try` 之外。[L1]
应在配置加载的初始化边界捕获安全错误、输出简短说明并非零退出，确保失败时尚未创建客户端。
不要认为现有交互执行的 `try` 会自动捕获顶层初始化失败，也不要把敏感原始异常作为 `cause` 再打印。

模型调用、流式读取、工具执行、交互和非交互双入口继续使用现有代码；本次只更换配置来源。

## 6. 验证方案与已完成证据

实施后建议执行：

```bash
npm run check
npm run build
node --test tests/config.test.mjs
python3 tests/terminal-cancel.py
```

其中配置测试尚不存在，上述为实施后的命令清单，不是本次执行结果。
配置测试在临时目录生成不含真实密钥的文件，使用独立子进程隔离 `process.env`，至少覆盖：

| 场景 | 预期 |
| --- | --- |
| 有 `.env`，未设置同名环境变量 | 使用文件值 |
| 两处设置同名变量 | 环境变量优先；包括空字符串优先，随后由必填校验拒绝 |
| 无 `.env`，环境变量完整 | 配置加载成功 |
| 无 `.env`，TOML 三项均为固定字符串 | 配置加载成功 |
| 引用变量缺失 | 非零退出，提示变量名，无网络请求 |
| 字段遗漏、数字类型、空串或全空白 | 拒绝配置，提示字段名 |
| 环境值含引号、反斜杠、换行或 `${...}` | 原样保留，不破坏 TOML、不递归展开 |
| 多引用、嵌套表和数组 | 替换字符串值，其他类型保持原样 |
| TOML 缺失、语法错误；`.env` 读取错误 | 终止启动；仅 `.env` 的 `ENOENT` 被忽略 |
| 原始配置中含测试密钥且解析失败 | stdout/stderr 不含测试密钥 |

本次实际做了两类临时验证：

- Node v25.9.0：文件加载、环境变量覆盖、空串保留、仅忽略 `ENOENT`、缺失文件的 CLI 行为均已确认。
  `--env-file-if-exists` 在无文件时继续运行，但会向 stderr 输出 `.env not found. Continuing without it.`。
- `smol-toml` 1.8.0：NodeNext 严格编译、ESM 导入、TOML 解析和占位符原样保留通过。

这些是隔离实验，不是仓库内可复跑测试；配置模块和完整入口集成仍待实施验收。没有请求真实模型。

## 7. 来源

### 项目一手文件

- [L1] [当前入口](../src/index.ts)：`requireEnv()`、客户端构造、`model` 与顶层错误边界。
- [L2] [package.json](../package.json)、[tsconfig.json](../tsconfig.json)、[README](../README.md)。
- [L3] [本机调试配置](../.vscode/launch.json)、[调试指南](vscode-debugging-guide.md)。
- [L4] [.env.example](../.env.example)、[终端取消测试](../tests/terminal-cancel.py)。
- [L5] [Agent 协作引导](agent-coordination-guide.md)、[学习计划](agent-development-learning-plan.md)。
- [L6] [.gitignore](../.gitignore)。

### 外部一手来源

- [S1] Node.js v25.9.0 CLI 文档：
  [环境文件参数及版本记录](https://github.com/nodejs/node/blob/v25.9.0/doc/api/cli.md#--env-file-if-existsfile)。
- [S2] Node.js v25.9.0 Process 文档：
  [`process.loadEnvFile(path)`](https://github.com/nodejs/node/blob/v25.9.0/doc/api/process.md#processloadenvfilepath)。
- [S3] Node.js v25.9.0 源码：
  [`Dotenv::SetEnvironment`](https://github.com/nodejs/node/blob/v25.9.0/src/node_dotenv.cc#L69)。
- [S4] TOML 官方规范：
  [TOML 字符串、数组及表](https://github.com/toml-lang/toml/blob/main/toml.md#string)。
- [S5] smol-toml 作者仓库：
  [官方 README、parse 用法及已知限制](https://github.com/squirrelchat/smol-toml/blob/mistress/README.md)。
- [S6] smol-toml 1.8.0 作者发布元数据：
  [npm 官方 Registry](https://registry.npmjs.org/smol-toml/1.8.0)。
