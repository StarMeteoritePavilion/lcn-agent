# lcn-agent

从零开始构建的可扩展终端 AI Agent。目前实现流式模型、echo 工具循环和基础终端交互；会话恢复与扩展系统是后续目标。

> **项目状态：** 早期开发中（阶段 3 两项交互缺陷已修复，20 项检查通过，完整体验边界仍待补齐；阶段 4 尚未开始）

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

### 项目结构

```
lcn-agent/
├── src/             # TypeScript 源码
│   └── index.ts     # 入口文件
├── dist/            # 编译输出（gitignored）
├── docs/            # 开发计划与学习文档
├── .editorconfig    # 跨编辑器基础规范
├── .prettierrc      # Prettier 格式化规则
├── tsconfig.json    # TypeScript 编译配置
├── package.json     # 项目配置
└── LICENSE          # Apache License 2.0
```

## 开发计划

项目按 10 个阶段递进式开发：

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 掌握链路所需的 TypeScript | 已完成 |
| 1 | 不依赖真实模型的 Agent 循环 | 已完成 |
| 2 | 真实流式模型与可靠取消 | 已完成 |
| 3 | 接入 TUI | 两项交互缺陷已修复，20 项检查通过，完整体验仍待验收 |
| 4 | 会话保存、恢复和运行诊断 | 待开始 |
| 5 | 可验证的扩展机制 | 待开始 |
| 6 | 默认工作流（文件操作、计划、权限等） | 待开始 |
| 7 | Skills、上下文压缩、项目记忆 | 待开始 |
| 8 | MCP 与网络能力集成 | 待开始 |
| 9 | 子代理、后台任务与可发布产品 | 待开始 |

详细计划见 [开发学习计划](docs/agent-development-learning-plan.md)。

## 文档

- [开发学习计划](docs/agent-development-learning-plan.md) - 完整的 10 阶段开发路线与验收标准
- [Agent 协作引导](docs/agent-coordination-guide.md) - AI Agent 接手工作的规则与约定
- [学习问答笔记](docs/qa-notes.md) - TypeScript 学习过程中的问答记录

## 许可证

[Apache License 2.0](LICENSE)

## 配置与终端回归验证

```bash
npm run check
npm test
python3 tests/terminal-cancel.py
```

`npm test` 编译后运行配置测试；终端测试适用于 macOS/Linux。
测试使用隔离的测试值和本地模拟服务，不请求真实模型。

2026-09-24 阶段 3 交互修复：原两项失败已修复，20 项检查全部通过；完整体验边界见验收报告。
新增 `tests/terminal-interaction.py` 使用 PTY 和 `pyte==0.8.2` 检查输入、屏幕和终端恢复。
安装、重跑命令、具体失败与覆盖边界见 [阶段 3 验收报告](docs/stage-03-acceptance.md)。
