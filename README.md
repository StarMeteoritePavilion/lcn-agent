# lcn-agent

从零开始构建的可扩展终端 AI Agent。通过逐步学习 TypeScript 与 Agent 核心机制，最终实现一个具备工具循环、流式 TUI、会话恢复和扩展系统的本地 Agent 产品。

## 项目目标

构建一个本地运行的 Agent，具备：

- 工具循环与流式模型交互
- 终端用户界面（TUI）
- 会话保存与恢复
- 可扩展机制（默认扩展 + 外部扩展）
- 开箱即用的默认能力：文件操作、计划、待办、权限确认、Skills、MCP、子代理等

采用 **稳定核心 + 默认扩展 + 外部扩展** 的架构：

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

## 技术栈

- **语言**: TypeScript 7.0（严格模式）
- **运行时**: Node.js（ESM 模块）
- **构建**: TypeScript 编译器（tsc）
- **许可证**: Apache License 2.0

## 快速开始

### 前置条件

- Node.js >= 22
- npm

### 安装与运行

```bash
# 克隆项目
git clone https://github.com/StarMeteoritePavilion/lcn-agent.git
cd lcn-agent

# 安装依赖
npm install

# 编译 TypeScript
npx tsc

# 运行
node dist/index.js
```

### 常用命令

```bash
# 编译并运行
npx tsc && node dist/index.js

# 仅类型检查（不生成文件）
npx tsc --noEmit
```

## 项目结构

```
lcn-agent/
├── src/             # TypeScript 源码
│   └── index.ts     # 入口文件
├── dist/            # 编译输出（gitignored）
├── docs/            # 学习文档与开发计划
├── tsconfig.json    # TypeScript 编译配置
├── package.json     # 项目配置
└── LICENSE          # Apache License 2.0
```

## 开发计划

项目按 10 个阶段递进式开发，当前处于 **阶段 1**：

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 掌握链路所需的 TypeScript | 已完成 |
| 1 | 不依赖真实模型的 Agent 循环 | 进行中 |
| 2 | 真实流式模型与可靠取消 | 待开始 |
| 3 | 接入 TUI | 待开始 |
| 4 | 会话保存、恢复和运行诊断 | 待开始 |
| 5 | 可验证的扩展机制 | 待开始 |
| 6 | 默认工作流（文件操作、计划、权限等） | 待开始 |
| 7 | Skills、上下文压缩、项目记忆 | 待开始 |
| 8 | MCP 与网络能力集成 | 待开始 |
| 9 | 子代理、后台任务与可发布产品 | 待开始 |

详细开发计划见 [agent-development-learning-plan.md](docs/agent-development-learning-plan.md)。

## 相关文档

- [开发学习计划](docs/agent-development-learning-plan.md) - 完整的 10 阶段开发路线与验收标准
- [Agent 协作引导](docs/agent-coordination-guide.md) - AI Agent 接手工作的规则与约定
- [学习问答笔记](docs/qa-notes.md) - TypeScript 学习过程中的问答记录

## 许可证

[Apache License 2.0](LICENSE)