# 贡献指南

项目仍处于基础功能开发阶段。提交变更前，请先了解 [README](README.md) 中的当前能力和 [开发规范](AGENTS.md)。

## 提交问题与建议

通过 [GitHub Issues](https://github.com/StarMeteoritePavilion/lcn-agent/issues) 提交问题。故障报告请包含：

- 使用的提交版本、操作系统、Node.js 和 npm 版本。
- 最短复现步骤、预期行为与实际行为。
- 相关错误提示，以及删除密钥后的最小配置示例。

功能建议请说明使用场景、希望改善的行为及预期结果。范围较大的架构调整适合先讨论，再提交实现。

## 准备开发环境

使用 [.node-version](.node-version) 指定的 Node.js 22.23.3，以及 [package.json](package.json) 指定的 npm 10.9.9。

```sh
npm ci --ignore-scripts
npm run verify
```

本地运行应用的方法见 [快速启动](README.md#快速启动)。测试不需要创建真实 `.env` 或配置模型服务。

## 常用命令

| 命令                   | 用途                                                    |
| ---------------------- | ------------------------------------------------------- |
| `npm run check`        | 检查应用源码类型                                        |
| `npm test`             | 编译源码与测试，然后使用 Node.js 内置测试运行器执行测试 |
| `npm run build`        | 清理 `dist` 后编译应用                                  |
| `npm run format`       | 格式化仓库文件，会修改文件                              |
| `npm run format:check` | 只检查格式                                              |
| `npm run verify`       | 执行提交前的格式、测试和构建检查                        |

测试源码位于 `test`，与 `src` 对应，文件名以 `.test.ts` 结尾。`pretest` 清理 `.build/test` 并将源码和测试编译到该目录，避免执行旧产物。构建生成 `dist`，不生成 SDK 类型声明。

[tsconfig.json](tsconfig.json) 使用 `ES2022` 编译目标，省略 `lib`，采用 TypeScript 默认标准库，其中包含 Google SDK 声明所需的 `DOM` 类型。`types: ["node"]` 加载 Node.js 类型，不排除默认标准库。项目未启用 `skipLibCheck`，保留声明文件检查，运行环境仍为 Node.js。

`module` 和 `moduleResolution` 均显式设置为 `NodeNext`。`allowImportingTsExtensions` 允许源码使用 `.ts` 导入路径，`rewriteRelativeImportExtensions` 在构建时将这些相对路径转换为 `.js`；测试配置继承上述选项。

## 编写变更

- 文档、代码注释和 TSDoc 使用中文，代码标识符保持原样。
- 判断语句保留大括号，优先使用卫语句，避免超过两层的方法调用嵌套。
- 只导出调用方需要的接口，类型依赖显式使用 `import type`。
- 模块导入不触发文件读取、请求或业务执行；外部配置在使用边界进行运行时校验。
- 所有项目维护的 TypeScript 函数及回调遵循 [TSDoc 规范](AGENTS.md#typescript-函数文档注释规范)。当前没有独立注释检查命令，提交前需要人工检查。

测试应通过公开边界验证行为：配置模块调用 `loadSettings`；统一接口调用 `stream` 检查协议分发和同步事件流返回，通过同一事件流的 `result()` 检查最终消息，并调用 `complete` 检查最终消息的 Promise；四种协议分别调用 `stream` 检查请求参数和事件，OpenAI 与 Anthropic 通过 `options.fetch` 模拟响应，Google 测试替换并恢复 `globalThis.fetch`，检查自定义 fetch 限制、工具签名和历史转换；Responses 还检查文本签名、调用标识、输出槽位、最终参数补齐及缺少终态的错误处理；工具参数通过 `parseStreamingJson`、`parseJsonWithRepair` 和 `validateToolCall` 检查解析、转义修复、转换与校验；事件流检查公开的 `push`、`end`、异步迭代及 `result()`；入口通过独立进程检查工具调用历史、结果回填、轮次上限、输出和退出状态。使用临时配置，在网络边界模拟响应，不为测试暴露私有函数，也不调用真实模型服务。

修复缺陷时先添加能复现问题的测试，再做最小修复。对已有正确行为补充回归测试时，测试直接通过是正常结果，不需要人为制造业务错误。

## 提交拉取请求

1. Fork 仓库并创建用于本次变更的分支。
2. 保持变更聚焦，同步更新受到影响的配置示例、文档和测试。
3. 运行 `npm run verify`，人工检查新增或修改函数的 TSDoc。
4. 检查差异，确认没有真实密钥、本地配置和构建产物。
5. 在 PR 中说明解决的问题、行为变化和验证结果；有对应 Issue 时附上链接。

[CI](.github/workflows/ci.yml) 使用 Ubuntu 和 `.node-version` 指定的 Node.js 版本执行 `npm ci --ignore-scripts` 与 `npm run verify`。本地检查通过后仍需关注 CI 结果。
