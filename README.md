# lcn-agent

从零开始构建的可扩展终端 AI Agent。目前实现流式模型、工具循环、基础终端交互、JSONL 会话保存与恢复、运行诊断，以及工具扩展注册、清理和外部 JavaScript 模块加载。

> **项目状态：** 阶段 0～4 已完成；阶段 5 已验收至通用扩展会话状态接口，待办已接入。下一节点：用户提问与待办扩展的完整集成。

## 目标特性

- 工具循环与流式模型交互
- 终端用户界面（TUI）
- 会话保存与恢复
- 可扩展机制（默认扩展 + 外部扩展）
- 开箱即用的默认能力：文件操作、计划、待办、权限确认、Skills、MCP、子代理等

**目标架构概览：**

```
终端界面 / 非交互输出
  └── 会话协调
        └── Agent 循环与运行状态
              ├── 模型通信模块
              └── 工具执行与权限判定
                    ├── 默认扩展
                    │     └── MCP 客户端与外部工具
                    └── 外部扩展
```

## 快速开始

### 前置条件

- Node.js >= 22
- npm

### 安装

```bash
git clone https://github.com/StarMeteoritePavilion/lcn-agent.git
cd lcn-agent
npm install
```

### 模型配置

从仓库根目录启动。`config.toml` 必须存在，默认引用以下变量：

```toml
apiKey = "${API_KEY}"
baseURL = "${BASE_URL}"
model = "${MODEL}"
```

可以直接设置进程环境变量，也可以复制 `.env.example` 为 `.env` 并填写实际值。
`.env` 是可选文件；同名时进程环境变量优先，包括已设置的空字符串。
普通配置可以直接写成 TOML 字符串，固定值不会被环境变量覆盖。不要把真实密钥提交到仓库。

程序先解析 TOML，再按原名替换字符串值中的 `${key}`，支持数组和嵌套表；
替换只执行一次，不展开环境值中的引用、不自动转换类型、不改写键名。
引用不存在，或 `apiKey`、`baseURL`、`model` 缺失、非字符串、为空或全空白时，启动失败。
文件读取和 TOML 语法错误也会终止启动，只有 `.env` 不存在可以忽略。

### 配置设计依据

加载统一放在 [src/core/config.ts](src/core/config.ts)，使 npm、直接 Node 启动和调试走同一流程。
Node 原生 `loadEnvFile()` 已满足环境文件加载需求，TOML 解析使用现有 `smol-toml`。
先解析再替换可防止环境值中的引号和换行改变 TOML 结构；日期对象不参与递归替换。
必填校验只用 `trim()` 判断空白，返回原值；解析错误不透传原始配置行，避免泄露密钥。
`loadEnvFile()` 不会让 `NODE_OPTIONS` 影响已经启动的 Node，启动参数应放在外部环境或启动命令中。

配置调研的原始依据（2026-09-21 核对）：
[Node 加载 API](https://github.com/nodejs/node/blob/v25.9.0/doc/api/process.md#processloadenvfilepath)、
[环境变量优先级源码](https://github.com/nodejs/node/blob/v25.9.0/src/node_dotenv.cc#L69)、
[TOML 规范](https://github.com/toml-lang/toml/blob/main/toml.md#string)、
[smol-toml 文档](https://github.com/squirrelchat/smol-toml/blob/mistress/README.md)。
配置加载实现见 [src/core/config.ts](src/core/config.ts)。

### 构建与运行

```bash
# 编译并启动（应用统一加载配置）
npm start

# 编译 TypeScript
npx tsc

# 运行
node dist/index.js

# 编译并运行（组合命令）
npx tsc && node dist/index.js

# 仅类型检查（不生成文件）
npx tsc --noEmit

# 格式化所有源码
npx prettier --write "src/**/*.ts"
```

### 会话使用

| 命令 | 用途 |
| --- | --- |
| `/new` | 新建会话 |
| `/sessions` | 列出已保存的完整文件名 |
| `/resume 完整文件名` | 加载指定会话，模型须与当前配置一致 |
| `/history` | 查看当前消息历史 |
| `/diagnostics` | 查看当前会话诊断 |
| `/diagnostics 完整会话文件名` | 查看指定会话诊断，无需先恢复会话 |
| `/exit` | 退出；生成中 Ctrl+C 取消当前请求，空闲时 Ctrl+C 退出 |

交互模式首次提问时创建会话；非交互入口每次创建新会话。
记录保存在 `.lcn-agent/sessions`，已被 Git 忽略。恢复只读取历史，不重放工具。
取消和截断时只保留完整消息；损坏记录、缺少末尾换行或未配对工具调用会导致恢复被拒绝，原文件不变。
已有文件丢失时保存报错，不会自动重建。同一项目只允许一个会话写入进程。
诊断文件按会话保存在 `.lcn-agent/diagnostics`，记录模型与工具耗时、用量、结束原因；无结束记录显示结果未知。
强制结束后若残留 `.lcn-agent/sessions/.writer.lock`，确认项目没有 Agent 进程运行后再手动删除锁。

## 开发指南

### 技术栈

| 类别 | 工具 |
| --- | --- |
| 语言 | TypeScript 7.0（严格模式） |
| 运行时 | Node.js（ESM 模块） |
| 构建 | TypeScript 编译器（tsc） |
| 格式化 | Prettier |
| 编辑规范 | EditorConfig |

### 编辑器配置

项目使用 `.editorconfig` 统一基础编辑规范（缩进、编码、换行符），使用 `.prettierrc` 统一代码格式。所有主流编辑器均支持 EditorConfig。

**VS Code 用户：**

安装以下插件：

| 插件 | ID | 必要性 |
| --- | --- | --- |
| Prettier - Code formatter | `esbenp.prettier-vscode` | 必装 |
| EditorConfig for VS Code | `editorconfig.editorconfig` | 必装 |
| Error Lens | `usernamehw.errorlens` | 推荐 |

在项目根目录创建 `.vscode/settings.json`（已被 `.gitignore` 忽略，不会提交）：

```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "[markdown]": {
    "editor.formatOnSave": false
  }
}
```

### VS Code 断点调试

用 VS Code 打开仓库根目录，在本机 `.vscode/launch.json` 中配置：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "调试 lcn-agent",
      "type": "node",
      "request": "launch",
      "preLaunchTask": "npm: build",
      "program": "${workspaceFolder}/dist/index.js",
      "cwd": "${workspaceFolder}",
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "skipFiles": ["<node_internals>/**"],
      "console": "integratedTerminal"
    }
  ]
}
```

在 `src/*.ts` 上设断点，选“调试 lcn-agent”并按 F5；编译生成的 source map 将 JS 映射回 TS。
配置仍由应用加载 `config.toml` 和可选 `.env`，不另设 `envFile`。
找不到 `npm: build` 时检查 npm 任务自动检测；断点空心时检查 `cwd`、`sourceMap`、`outFiles` 并重新编译。

### 项目结构

```
lcn-agent/
├── src/             # TypeScript 源码
│   ├── index.ts     # 当前学习阶段入口
│   ├── core/        # 配置、会话、诊断、扩展注册与状态存储模块
│   ├── extensions/  # 回显、大写、延迟回显与待办扩展
│   └── stage-xx.ts  # 已完成阶段的入口快照
├── dist/            # 编译输出（gitignored）
├── docs/            # 开发计划与学习文档
├── .editorconfig    # 跨编辑器基础规范
├── .prettierrc      # Prettier 格式化规则
├── tsconfig.json    # TypeScript 编译配置
├── package.json     # 项目配置
└── LICENSE          # Apache License 2.0
```

## 开发计划

按阶段逐步学习 TypeScript、Agent 循环、终端、会话、扩展与默认工作流。
完整路线、当前进度、验收结论和下一节点统一见 [开发学习计划](docs/agent-development-learning-plan.md)。

## 文档

- [开发学习计划](docs/agent-development-learning-plan.md) - 完整的 10 阶段开发路线与验收标准
- [Agent 协作引导](docs/agent-coordination-guide.md) - AI Agent 接手工作的规则与约定
- [学习问答笔记](docs/qa-notes.md) - TypeScript 学习过程中的问答记录

## 许可证

[Apache License 2.0](LICENSE)

## 当前阶段验收

```bash
npm run check
npm test
```

`npm run check` 对当前实现和阶段留档进行类型检查。
`npm test` 运行当前唯一的验收脚本 `tests/session-persistence.py`：在临时目录编译当前源码，
检查扩展命令分发与保护、静态工具注册、参数校验、重名保护、卸载与失败回滚、同一对象重注册隔离、外部加载错误与项目外路径、实际请求中的工具定义及回填，并通过本地模拟服务验证会话保存恢复、工具配对、存储异常和运行诊断；包含模型、工具和用户确认各一次真实 30 秒超时，完整运行约两分钟。
需要 Python 3、Node.js 和已安装的 npm 依赖；PTY 验证适用于 macOS/Linux，不需要 pyte，也不请求真实模型。

项目按阶段学习：`src/index.ts` 是当前入口，`src/stage-xx.ts` 保存已完成阶段。
测试只维护当前学习节点；阶段完成后记录验收结论，旧测试可移除，下一阶段更换 `npm test` 入口。
若阶段依赖独立模块，仅复制入口不能冻结完整实现，应使用 Git 提交标记该阶段的完整状态。
历史结论和覆盖限制见 [学习计划](docs/agent-development-learning-plan.md#验收记录)。
