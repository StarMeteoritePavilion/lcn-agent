# Q&A 学习笔记

## 目录

### Node.js 工具链
- [01 ESM 是什么](#2026-09-17-01-esm-是什么)
- [02 npx 是什么 & 命令解析](#2026-09-17-02-npx-是什么--命令解析)

### TypeScript / JavaScript 语法
- [03 AsyncGenerator 类型标注与底层操作](#2026-09-17-03-asyncgenerator-类型标注与底层操作)
- [04 对象字面量属性名引号与尾逗号](#2026-09-17-04-对象字面量属性名引号与尾逗号)
- [05 函数类型别名的语义与用法](#2026-09-18-05-函数类型别名的语义与用法)
- [06 对象字面量属性简写与自定义 key](#2026-09-18-06-对象字面量属性简写与自定义-key)

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

---

## 2026-09-17-04 对象字面量属性名引号与尾逗号

**问题：** 对象字面量属性名加 `""` 和不加有区别吗？开源项目中主流写法是哪种？尾逗号是默认行为吗？

**答案：**

### 属性名引号

在 JavaScript/TypeScript 中，对象字面量的属性名如果是**合法标识符**（字母、数字、`_`、`$` 开头，不含特殊字符），加不加引号效果完全一致，编译后的 JS 也相同。

只有属性名**不是合法标识符**时必须加引号：

```ts
const obj = {
  "Content-Type": "application/json",   // 含 `-`
  "my key": 123,                        // 含空格
  "123abc": true,                       // 数字开头
};
```

### 尾逗号

ES5+ 合法语法。好处是增删元素时 git diff 更干净（只改一行而不是两行）。

### 开源社区主流惯例

| 惯例 | 主流做法 | 典型工具默认值 |
|------|---------|--------------|
| 属性名引号 | **不加** | ESLint `quote-props: "as-needed"` |
| 尾逗号 | **加** | Prettier `trailingComma: "all"` |

大多数开源项目通过 Prettier 强制尾逗号，属性名不加引号。

**总结：** 不加引号 + 加尾逗号是当前开源社区的事实标准。合法标识符加引号仅在从 JSON 复制粘贴时常见，实际 TS/JS 代码中不推荐。

---

## 2026-09-18-05 函数类型别名的语义与用法

**问题：** `type EcholTool = (text: string) => ToolResult;` 这种写法展开说明一下，实际语义是什么？

**答案：**

### 语法结构

```ts
type EcholTool = (text: string) => ToolResult;
//   ^^^^^^^^    ^^^^^^^^^^^^^^    ^^^^^^^^^^
//   类型名       参数列表            返回值类型
```

这是 TypeScript 的**函数类型别名（Function Type Alias）**。实际语义：定义了一个类型，描述"接收一个 `string` 参数、返回 `ToolResult` 的函数"的形状。它本身不创建任何函数，只是一个"合同模板"。

### 类比 Java

对应 Java 中的函数式接口：

```java
@FunctionalInterface
interface EchoTool {
    ToolResult apply(String text);
}
```

### 用法

任何签名匹配的函数都能赋给这个类型的变量：

```ts
const tool: EcholTool = echoTool;  // ✅ 签名匹配
const result = tool("hello");      // 等价于 echoTool("hello")
```

不匹配的函数会报编译错误：

```ts
const bad1: EcholTool = (n: number) => ({ ... });  // ❌ 参数类型不对
const bad2: EcholTool = (text: string) => text;    // ❌ 返回 string 不是 ToolResult
```

### 典型使用场景：工具注册表

函数类型别名最常见的用途是作为参数或注册表的类型约束：

```ts
type ToolFn = (text: string) => ToolResult;

const echo: ToolFn = (text) => ({
  role: "tool", toolName: "echo", output: text,
});
const upper: ToolFn = (text) => ({
  role: "tool", toolName: "upper", output: text.toUpperCase(),
});

// 注册表：工具名 → 执行函数
const registry: Record<string, ToolFn> = { echo, upper };

// Agent 循环中根据模型返回的工具名动态调用
function executeTool(name: string, text: string): ToolResult {
  const tool = registry[name];
  if (!tool) return { role: "tool", toolName: name, output: "未知工具" };
  return tool(text);
}
```

### 另一种等价写法

除了箭头函数语法，还可以用对象形式的 call signature：

```ts
type EcholTool = {
  (text: string): ToolResult;
};
```

效果完全一样，箭头写法是社区主流。对象形式一般在需要同时描述属性和可调用时才用：

```ts
type EcholTool = {
  (text: string): ToolResult;
  description: string;  // 函数上还挂了一个属性
};
```

### 关键区别：结构化类型 vs 名义类型

| 概念 | TypeScript | Java |
|------|-----------|------|
| 函数类型别名 | `type F = (x: string) => R` | `@FunctionalInterface interface F` |
| 匹配方式 | 结构化类型（签名匹配即可） | 名义类型（必须 implements） |

TypeScript 是结构化类型系统（duck typing），只要函数签名匹配就行，不需要显式声明 `implements`。

**总结：** 函数类型别名定义函数的"形状"，对应 Java 的函数式接口。核心价值在于约束一组函数遵守同一签名，使 Agent 循环可以不关心具体工具、统一 `tool(text)` 调用。

---

## 2026-09-18-06 对象字面量属性简写与自定义 key

**问题：** `Record<string, ToolFn>` 中用 `{ echo, upper, reverse }` 注册工具，key 就是变量名吗？有办法主动声明为别的吗？

**答案：**

### 属性简写（Shorthand Property）

`{ echo, upper, reverse }` 是 ES6 的属性简写，等价于：

```ts
{ echo: echo, upper: upper, reverse: reverse }
```

变量名直接变成 key。

### 显式指定 key

要用别的名字，显式写 key：

```ts
const registry: Record<string, ToolFn> = {
  "回声": echo,
  "大写转换": upper,
  "文本反转": reverse,
};
registry["回声"]("hello");  // 调用的是 echo 函数
```

也可以混用：

```ts
const registry: Record<string, ToolFn> = {
  echo,                    // 简写，key 是 "echo"
  "to-upper": upper,       // 自定义 key（含连字符，必须加引号）
  rev: reverse,            // 自定义 key，合法标识符不用加引号
};
```

### 动态 key（计算属性名）

key 还可以是变量或表达式，用 `[]` 包裹：

```ts
const toolName = "echo_v2";
const registry: Record<string, ToolFn> = {
  [toolName]: echo,                    // key 是 "echo_v2"
  [`${toolName}_backup`]: echo,        // key 是 "echo_v2_backup"
};
```

对应 Java 就是 `map.put(toolName, echo)` —— 运行时决定 key。

### 四种写法汇总

| 写法 | key 值 | 说明 |
|------|--------|------|
| `{ echo }` | `"echo"` | 简写，变量名就是 key |
| `{ myName: echo }` | `"myName"` | 显式指定 key |
| `{ "my-name": echo }` | `"my-name"` | 非合法标识符需加引号 |
| `{ [variable]: echo }` | 变量的值 | 动态计算 key |

**总结：** 属性简写以变量名为 key；显式写 `key: value` 或用 `[expr]` 计算属性名可以自定义任意 key。
