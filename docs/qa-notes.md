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

## 2026-09-17-02 npx 是什么 & 命令解析

**问题：** `npx tsc && node dist/index.js` 和 `echo $?` 是什么意思？npx 的原理是什么？

**答案：**

### 命令解析

| 部分 | 含义 |
|------|------|
| `npx tsc` | 用项目本地的 TypeScript 编译器把 `.ts` 编译成 `.js` |
| `&&` | 前一条命令成功（退出码为 0）才执行下一条 |
| `node dist/index.js` | 用 Node.js 运行编译产物 |

整体意思：**先编译，编译成功才运行**。如果 `tsc` 报错，`node` 那行不会执行。

`$?` 是 shell 特殊变量，保存上一条命令的退出码（`0` = 成功，非 `0` = 失败）。`echo $?` 常用于脚本中判断流程是否正常结束。

### npx 原理

`npx` 是 npm 5.2+ 内置的命令执行工具，核心作用：**运行可执行的 npm 包，不需要全局安装**。

执行 `npx tsc` 时的查找顺序：

1. **先找本地** — `./node_modules/.bin/tsc`，找到就直接运行
2. **再找全局** — 查全局 npm 安装的包
3. **都没有** — 临时从 npm registry 下载到缓存，运行完不保留

### 为什么用 `npx tsc` 而不是直接 `tsc`

直接敲 `tsc` 走系统 PATH，用全局版本。`npx tsc` 优先用项目本地版本（`node_modules/.bin/tsc`），确保团队所有人用同一个版本。

安装有 CLI 的包时，npm 会在 `node_modules/.bin/` 里创建软链接：

```
node_modules/.bin/tsc -> ../typescript/bin/tsc
```

`npx` 本质就是把这个目录临时加到 PATH 里再执行。

**总结：** `npx` = 优先用本地包的可执行文件，没有就临时下载，解决版本隔离和"不想全局安装"的问题。

---

## 2026-09-17-03 AsyncGenerator 类型标注与底层操作

**问题：** `async function*` 的返回值只能是 `AsyncGenerator` 吗？`.next()` / `.return()` / `.throw()` 怎么使用？

**答案：**

### 类型标注

`async function*` 运行时永远返回 `AsyncGenerator`，但类型标注可以是它实现的任意上层接口：

```
AsyncIterable<T>
       ↑
AsyncIterator<T>
       ↑
AsyncIterableIterator<T>
       ↑
AsyncGenerator<T, TReturn, TNext>  ← 运行时实际类型
```

| 场景 | 推荐类型 |
|------|----------|
| 给调用方用 `for await...of` 消费 | `AsyncIterable<T>` |
| 需要手动 `.next()` / `.return()` / `.throw()` | `AsyncGenerator<T>` |
| 不写类型 | 省略，TS 自动推断 |

**最常见做法是标 `AsyncIterable<T>`**，调用方只需 `for await...of`，也更容易换成其他实现。

### 底层三个方法

这三个是手动控制 Generator 的底层 API，`for await...of` 内部调的就是它们，通常不直接使用。

**`.next(value?)`** — 推进到下一个 yield，可向内部传值：

```ts
async function* gen() {
    const input = yield "第一次暂停";
    console.log("收到:", input);
    yield "第二次暂停";
}
const g = gen();
await g.next();          // { value: "第一次暂停", done: false }
await g.next("hello");   // 打印"收到: hello"，{ value: "第二次暂停", done: false }
await g.next();          // { value: undefined, done: true }
```

> 第一次 `.next()` 传的值会被丢弃，因为还没走到任何 yield。

**`.return(value)`** — 强制终止，就像提前 return（`for await...of` 的 `break` 内部调的就是它）：

```ts
await g.next();       // { value: 1, done: false }
await g.return(99);   // { value: 99, done: true }
```

**`.throw(error)`** — 向内部抛异常，可被内部 `try/catch` 捕获：

```ts
async function* gen() {
    try {
        yield 1;
    } catch (e) {
        console.log("内部捕获:", e.message);
        yield 99;
    }
}
const g = gen();
await g.next();                       // { value: 1, done: false }
await g.throw(new Error("出错了"));  // 打印"内部捕获: 出错了"，{ value: 99, done: false }
```

| 方法 | 作用 | 常见场景 |
|------|------|---------|
| `.next(v)` | 推进，可传值进去 | 双向通信 |
| `.return(v)` | 强制结束 | 提前取消、`break` |
| `.throw(e)` | 向内部抛异常 | 错误注入、取消信号 |

**总结：** 运行时永远是 `AsyncGenerator`，类型标注标接口更灵活；三个底层方法通常由 `for await...of` 代劳，需要手动调的场景是自实现消费器或双向通信。
