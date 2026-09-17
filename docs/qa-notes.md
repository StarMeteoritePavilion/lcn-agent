# Q&A 学习笔记

---

## 2026-09-17-01 ESM 是什么

**问题：** ESM 是什么？

**答案：**

ESM（ECMAScript Modules）是 JavaScript 官方的模块系统，由 ES2015（ES6）引入，使用 `import` / `export` 语法。

### 对比 CommonJS（CJS）

| 对比点 | ESM | CommonJS |
|--------|-----|----------|
| 语法 | `import` / `export` | `require` / `module.exports` |
| 加载时机 | 静态，编译期解析 | 动态，运行时执行 |
| 加载方式 | 异步 | 同步 |
| `this` 顶层 | `undefined` | `module` 对象 |
| 文件扩展名 | `.mjs` 或 `.js`（需声明） | `.cjs` 或 `.js` |

### Node.js 中启用 ESM

```json
// package.json
{ "type": "module" }
```

或单文件使用 `.mjs` 扩展名。

### 核心特性

- **静态分析**：`import` 必须在顶层，路径不能是变量，因此支持 tree-shaking。
- **动态 import**：`await import('./utils.js')` 返回 Promise，运行时按需加载。

### TypeScript 项目配置

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler"
  }
}
```

**总结：** ESM 是 JS 官方模块标准，静态 import/export，支持 tree-shaking；CJS 是 Node.js 原有的动态 require，两者可共存但混用需注意兼容性。

---

## 2026-09-17-02 `npx tsc && node dist/index.js` 和 `echo $?` 是什么意思

**问题：** `npx tsc && node dist/index.js` 和 `echo $?` 这两个命令是什么意思？

**答案：**

### `npx tsc && node dist/index.js`

| 部分 | 含义 |
|------|------|
| `npx tsc` | 用项目本地的 TypeScript 编译器把 `.ts` 编译成 `.js` |
| `&&` | 前一条命令成功（退出码为 0）才执行下一条 |
| `node dist/index.js` | 用 Node.js 运行编译产物 |

整体意思：**先编译，编译成功才运行**。如果 `tsc` 报错（类型错误、语法错误），`node` 那行不会执行。

### `echo $?`

`$?` 是 shell 的特殊变量，保存**上一条命令的退出码**：
- `0` = 成功
- 非 `0` = 失败

所以 `echo $?` 就是打印上一条命令是否成功。两者组合常用于脚本中判断流程是否正常结束。

---

## 2026-09-17-03 npx 是什么原理

**问题：** npx 是什么原理？

**答案：**

`npx` 是 npm 5.2+ 内置的命令执行工具，核心作用：**运行一个可执行的 npm 包，不需要全局安装**。

### 执行流程

```
npx tsc
```

1. **先找本地** — 查 `./node_modules/.bin/tsc`，找到就直接运行
2. **再找全局** — 查全局 npm 安装的包
3. **都没有** — 临时从 npm registry 下载到缓存，运行完不保留

### 为什么用 `npx tsc` 而不是直接 `tsc`

直接敲 `tsc` 走系统 PATH，用的是**全局**安装的 TypeScript 版本。`npx tsc` 优先用**项目本地**版本（`node_modules/.bin/tsc`），确保团队所有人用同一个版本。

### `.bin` 目录的作用

安装有 CLI 的包时，npm 会在 `node_modules/.bin/` 里创建软链接：

```
node_modules/.bin/tsc -> ../typescript/bin/tsc
```

`npx` 本质就是把这个目录临时加到 PATH 里再执行。

**总结：** `npx` = 优先用本地包的可执行文件，没有就临时下载，解决版本隔离和"不想全局安装"的问题。
