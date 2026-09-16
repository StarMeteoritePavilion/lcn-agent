# 第 2 步：安装 TypeScript 并设置模块类型

这是原推进顺序中“安装 TypeScript，配置编译”的前半部分，编译配置单独放在下一篇。

## 当前步骤目标

安装 TypeScript 编译器和 Node.js 类型声明，将项目设置为 ESM 模块模式。

前置条件：[项目初始化](01-initialize-project.md)已通过。

## 执行

在项目根目录执行：

```bash
npm install --save-dev typescript @types/node
npm pkg set type=module
```

| 内容 | 用途 |
| --- | --- |
| `typescript` | 提供 TypeScript 编译器 `tsc` |
| `@types/node` | 让类型检查器认识 Node.js 的 API，例如 `process` |
| `--save-dev` | 将依赖记录在 `devDependencies` 中，供开发和编译使用 |
| `"type": "module"` | 使用 ESM 模块规则，后续通过 `import`、`export` 组织代码 |

安装后生成：

- `node_modules/`：本地安装的依赖。
- `package-lock.json`：记录解析后的依赖版本，供后续安装复用。

`@types/node` 提供类型信息，不负责安装或切换 Node.js 运行时。

## 验证

```bash
npx tsc --version
npm ls --depth=0
npm pkg get type devDependencies
```

`npx tsc` 在这里调用项目已安装的 TypeScript 编译器。
`npm ls --depth=0` 查看直接依赖，不展开各依赖内部的依赖树。

通过标准：

- `tsc` 能输出版本号。
- 依赖列表包含 `typescript` 和 `@types/node`，没有依赖错误。
- `type` 为 `module`，两个依赖都记录在 `devDependencies` 中。

## 已确认的结果

根据学习者提供的终端输出，本步已通过：

| 项目 | 实际结果 |
| --- | --- |
| TypeScript 编译器 | `7.0.2` |
| 安装的 `typescript` | `7.0.2` |
| 安装的 `@types/node` | `22.20.3` |
| 模块类型 | `module` |

`package.json` 中的配置为：

```json
{
  "type": "module",
  "devDependencies": {
    "@types/node": "^22.20.3",
    "typescript": "^7.0.2"
  }
}
```

这是与本步相关的配置片段，不是要求覆盖整个 `package.json`。
记录中的版本是当次安装结果，不表示不带版本参数的安装命令始终得到这些版本。

下一步：[配置编译并运行最小程序](03-compile-and-run.md)。
