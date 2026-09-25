# Q&A 学习笔记

## 目录

### Node.js 工具链
- [01 ESM 是什么](#2026-09-17-01-esm-是什么)
- [02 npx 是什么 & 命令解析](#2026-09-17-02-npx-是什么--命令解析)
- [09 npm start 与 npm run 的区别](#2026-09-19-09-npm-start-与-npm-run-的区别)

### TypeScript / JavaScript 语法
- [03 AsyncGenerator 类型标注与底层操作](#2026-09-17-03-asyncgenerator-类型标注与底层操作)
- [04 对象字面量属性名引号与尾逗号](#2026-09-17-04-对象字面量属性名引号与尾逗号)
- [05 函数类型别名的语义与用法](#2026-09-18-05-函数类型别名的语义与用法)
- [06 对象字面量属性简写与自定义 key](#2026-09-18-06-对象字面量属性简写与自定义-key)
- [07 类型谓词与类型收窄机制](#2026-09-18-07-类型谓词与类型收窄机制)
- [08 TypeScript 枚举写法与字符串联合类型的选择](#2026-09-18-08-typescript-枚举写法与字符串联合类型的选择)
- [10 字面量类型 widening 与 as const](#2026-09-19-10-字面量类型-widening-与-as-const)
- [12 JavaScript falsy 值与空字符串判断](#2026-09-20-12-javascript-falsy-值与空字符串判断)
- [17 解构赋值中的冒号重命名](#2026-09-25-17-解构赋值中的冒号重命名)

### ESM 模块
- [16 export function 与 export default function 的区别](#2026-09-25-16-export-function-与-export-default-function-的区别)

### Node.js 运行时
- [13 readline.on/off 信号监听与 SIGINT 处理](#2026-09-20-13-readlineonoff-信号监听与-sigint-处理)

### Agent 与会话
- [15 运行诊断与中断状态](#2026-09-25-15-运行诊断与中断状态)
- [14 消息历史与 JSONL 会话恢复](#2026-09-25-14-消息历史与-jsonl-会话恢复)

### 工程与调试
- [11 VS Code 断点调试配置](#2026-09-19-11-vs-code-断点调试配置)

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

---

## 2026-09-18-07 类型谓词与类型收窄机制

**问题：** `function isRecord(value: unknown): value is Record<string, unknown>` 这个是什么语法？`value is Type` 是否只能在返回值为 boolean 时使用？返回 object 的方法能否这样写？

**答案：**

这是 TypeScript 的**类型谓词（Type Predicate）**，也叫用户自定义类型守卫（User-Defined Type Guard）。

### 语法结构

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
//                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//                                 返回值位置写 "参数名 is 类型"
  return typeof value === "object" && value != null;
}
```

| 部分 | 含义 |
|------|------|
| `value` | 指向参数名，告诉编译器"我在断言哪个变量" |
| `is` | TypeScript 专用关键字 |
| `Record<string, unknown>` | 断言的目标类型 |

运行时返回的还是 `boolean`，但 `is` 语法额外告诉编译器：如果返回 `true`，那 `value` 在后续代码中可以当作 `Record<string, unknown>` 来用。

### 对比普通 boolean 返回值

```ts
// ❌ 普通 boolean，编译器不知道 true 意味着什么
function isRecord(value: unknown): boolean { ... }
if (isRecord(data)) {
  console.log(data.name);  // ❌ data 仍然是 unknown
}

// ✅ 类型谓词，编译器在 true 分支自动收窄
function isRecord(value: unknown): value is Record<string, unknown> { ... }
if (isRecord(data)) {
  console.log(data.name);  // ✅ data 被收窄为 Record<string, unknown>
}
```

### 类比 Java

最接近的是 `instanceof` 配合模式匹配（Java 16+）：

```java
if (data instanceof Map<?, ?> map) {
    System.out.println(map.get("name"));
}
```

区别是 Java 的 `instanceof` 是语言内置的，TypeScript 的 `instanceof` 只能判断 class 实例。对于结构化类型判断（比如"是不是非 null 对象"）必须自己写函数 + 类型谓词。

### 为什么需要这个函数

JavaScript 中 `typeof null === "object"` 是历史遗留 bug，所以判断"真正的对象"必须同时排除 `null`：

```ts
typeof value === "object" && value != null
```

封装成带类型谓词的函数后，所有调用处都能自动享受类型收窄。

### is 只能用在 boolean 返回值上

`value is Type` 限定返回 `boolean`，因为它在回答一个是/否问题——"这个值是不是某类型？"编译器需要明确的 `true`/`false` 来决定在哪个分支收窄。返回对象的函数无法表达这种二元判断。

TypeScript 提供了另外两种机制来覆盖其他场景：

### asserts：断言不通过就抛异常

如果函数不返回值，而是"校验失败就抛异常"，可以用 assertion function：

```ts
function assertIsRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value == null) {
    throw new Error("不是对象");
  }
}

const data: unknown = { name: "test" };
assertIsRecord(data);
console.log(data.name);  // ✅ data 已收窄为 Record<string, unknown>
```

对比 Java 就是常用的断言工具方法：

```java
Objects.requireNonNull(data);  // 过了这行，编译器知道 data 非 null
```

### 函数重载：返回对象时根据输入推断类型

```ts
function parse(input: "number"): number;
function parse(input: "string"): string;
function parse(input: string): number | string {
  if (input === "number") return 42;
  return "hello";
}

const a = parse("number");  // 编译器知道 a 是 number
const b = parse("string");  // 编译器知道 b 是 string
```

### 三种机制对比

| 机制 | 返回值 | 用法 | 场景 |
|------|--------|------|------|
| `value is Type` | `boolean` | `if (isX(v)) { ... }` | 条件分支里收窄 |
| `asserts value is Type` | `void`（失败抛异常） | 调用后直接收窄 | 前置校验，不满足就中断 |
| 函数重载 | 任意类型 | 根据参数类型推断返回类型 | 不同输入返回不同类型 |

**总结：** 类型谓词 `value is Type` 限定 boolean 返回值，在 true 分支自动收窄；`asserts` 适用于 void 前置校验；函数重载适用于不同输入返回不同类型。三者互补，覆盖不同的类型收窄场景。

---

## 2026-09-18-08 TypeScript 枚举写法与字符串联合类型的选择

**问题：** TypeScript 有类似 Java 的枚举写法吗？`type Scenario = "text" | "normal" | "unknown" | "invalid" | "failure" | "loop"` 推荐怎么写比较好？

**答案：**

### TypeScript 原生 enum

TypeScript 有 `enum` 关键字，但能力比 Java 枚举弱很多，只是常量映射，不能挂方法和自定义字段：

```ts
// 数字枚举（默认从 0 递增）
enum Direction { Up, Down, Left, Right }

// 字符串枚举
enum Status { Active = "ACTIVE", Inactive = "INACTIVE" }
```

### 三种模拟 Java 枚举的方式

**1. 字符串联合类型（最主流）** — 纯分支判断时用：

```ts
type Scenario = "text" | "normal" | "unknown" | "invalid" | "failure" | "loop";
```

**2. const 对象 + as const** — 需要挂字段时升级：

```ts
const Scenarios = {
  text:    { description: "纯文本响应", maxTurns: 1 },
  normal:  { description: "正常工具调用", maxTurns: 5 },
  unknown: { description: "未知工具", maxTurns: 1 },
} as const;

type Scenario = keyof typeof Scenarios;
// 等价于 "text" | "normal" | "unknown"
```

**3. class + static** — 需要方法时用，最像 Java 枚举：

```ts
class Planet {
  static readonly Mercury = new Planet("Mercury", 3.303e23, 2.4397e6);
  static readonly Earth   = new Planet("Earth",   5.976e24, 6.37814e6);
  static readonly values  = [Planet.Mercury, Planet.Earth] as const;

  private constructor(
    readonly name: string,
    readonly mass: number,
    readonly radius: number,
  ) {}

  surfaceGravity(): number {
    return (6.673e-11 * this.mass) / (this.radius * this.radius);
  }
}
```

### 选择标准

| 场景 | 推荐 |
|------|------|
| 纯分支判断（switch/if） | 字符串联合类型 |
| 需要挂描述、配置等字段 | `const + as const` |
| 需要挂方法 | `class + static` |
| 不推荐 | TS 原生 `enum` |

### 为什么不推荐原生 enum

TS 社区正在远离原生 `enum`，因为它是 TypeScript 少数会生成运行时代码的类型特性，与"类型擦除"原则矛盾。

### Scenario 的结论

当前 `type Scenario = "text" | "normal" | ...` 就是最地道的写法。只用于分支判断，不需要更重的方案。等将来需要挂字段时，升级为 `const + as const`，类型从 `keyof typeof` 自动推导，不用手动维护两份。

**总结：** 字符串联合类型是 TS 中最常用的"枚举"替代方案，纯分支判断场景下比 enum、const 对象、class 都更简洁。按需升级即可。

---

## 2026-09-19-09 npm start 与 npm run 的区别

**问题：** `package.json` 里面为什么其他的指令都是 `npm run xxx`，`start` 不需要 `run`？

**答案：**

### npm 的两类脚本

| 类型 | 例子 | 运行方式 | 说明 |
|------|------|----------|------|
| 内置快捷命令 | `start`, `test`, `stop`, `restart` | `npm start` | npm 直接识别，不需要 `run` |
| 自定义脚本 | `build`, `dev`, `lint`, `format` 等 | `npm run build` | 必须加 `run` |

```bash
npm start        # ✅ 等价于 npm run start
npm test         # ✅ 等价于 npm run test
npm build        # ❌ 这不是内置命令，会报错
npm run build    # ✅ 正确
```

### 本质区别

`npm run` 是通用的脚本执行器，能执行 `scripts` 里的任意脚本。`npm start`、`npm test` 这几个是 npm 专门注册的顶层命令，内部就是 `npm run start` 的别名。

两种写法完全等价：

```bash
npm start          # 快捷方式
npm run start      # 通用方式
```

### 为什么只有这几个有快捷方式

npm 沿用的 Node.js 项目约定——`start`（启动）、`test`（测试）、`stop`（停止）是几乎所有项目都有的标准生命周期，用得太频繁了，所以给了快捷方式省掉 `run`。

自定义脚本名（`build`、`dev`、`lint`）每个项目不一样，npm 不可能提前注册，所以必须通过通用入口 `npm run` 来调用。

### 类比 Java（Maven）

类似 Maven 的内置阶段和自定义插件目标：

```bash
mvn compile        # 内置生命周期阶段，直接用
mvn test           # 内置
mvn flyway:migrate # 自定义插件目标，必须带插件前缀
```

**总结：** `npm start` = `npm run start` 的快捷别名。内置快捷命令只有 `start`、`test`、`stop`、`restart` 四个，其他自定义脚本一律 `npm run xxx`。

---

## 2026-09-19-10 字面量类型 widening 与 as const

**问题：** 写 `type: "function"` 时 TypeScript 推断为 `string`，不满足 SDK 要求的字面量 `"function"`。加 `as const` 后类型收窄到字面量。这和阶段 0 的字面量类型收窄是不是同一机制？对象字面量属性默认 widening 是什么？widening 本身是什么？

**答案：**

这是 TypeScript 的**字面量类型拓宽（literal widening）**。运行时值没变，变的是编译器推断出的类型。

### 字面量类型 vs `string`

`"function"` 有两层身份：只能是这一个值的字面量类型，以及任意字符串的 `string`。窄类型能赋给宽类型，反过来不行：

```ts
const a: string = "function";     // ✅ "function" ⊂ string
const b: "function" = "hello";    // ❌ string ⊄ "function"
```

OpenAI SDK 的工具类型是判别联合，和阶段 0 的 `AgentEvent` 同一套机制：

```ts
interface ChatCompletionFunctionTool {
  type: "function";   // 字面量，不是 string
  function: FunctionDefinition;
}
type ChatCompletionTool = ChatCompletionFunctionTool | ChatCompletionCustomTool;
```

```ts
type TextEvent = { type: "text"; text: string };
type AgentEvent = TextEvent | ToolStartEvent | ToolEndEvent;
```

`type` 是判别字段。写成 `string` 就无法判别，赋不进 SDK 类型。

### 什么是 widening

**Widening（拓宽）** 是 TypeScript 把更窄的类型自动当成更宽的类型来用，方向是具体 → 笼统：

```
"function"  →  string
1           →  number
true        →  boolean
{ type: "function" }  →  { type: string }
```

它和阶段 0 的 **narrowing（收窄）** 正好相反：

| | widening | narrowing |
|--|----------|-----------|
| 方向 | 具体 → 笼统 | 笼统 → 具体 |
| 时机 | 推断可变值的类型时 | `if` / `switch` / 类型谓词之后 |
| 谁触发 | 编译器默认行为 | 你写的控制流 |
| 例子 | `{ type: "function" }` 变成 `{ type: string }` | `event.type === "text"` 后变成 `TextEvent` |

规则可以记成：**能改 → 放宽；不能改或你指定了 → 保持字面量。**

### 对象字面量属性为什么默认 widening

单独的 `const` 字符串会保留字面量；一放进可变对象，属性以后可能被改写，TS 按 `let` 处理，故意拓宽成 `string`：

```ts
const kind = "function";              // "function"（不能再赋）
let kind = "function";                // string（还能改）
const obj = { type: "function" };     // type: string（属性还能改）
```

| 写法 | 推断类型 | 原因 |
|------|---------|------|
| `const x = "function"` | `"function"` | 不能再赋值 |
| `let x = "function"` | `string` | 还能改成别的字符串 |
| `{ type: "function" }` | `{ type: string }` | 属性可变，按 `let` 处理 |

数组同理：`["function", "custom"]` 推断为 `string[]`，不是 `("function" | "custom")[]`。

这是保守推断：优先保证后续赋值合法，而不是把当前值钉死。

### 和阶段 0 的关系：同一机制，不同触发点

阶段 0 没写 `as const` 也能过，因为左边有上下文类型 `AgentEvent[]`，编译器知道 `type` 只能是 `"text" | "tool_start" | "tool_end"`，所以不会拓宽。

`ECHO_TOOL` 没有标注目标类型，只能从右往左推断，于是走 widening。

```
阶段 0：    目标类型已知  →  上下文收窄  →  "text" 保持字面量
ECHO_TOOL： 没有目标类型  →  可变对象拓宽 →  "function" 变成 string  →  需要 as const
```

### `as const` 和另外三种写法

`as const` 是常量断言：告诉编译器这个值不会再变，按最窄的字面量来。只修编译错误、不想 import SDK 类型时用属性级 `as const` 即可。

```ts
// ① 属性级 as const
const ECHO_TOOL = { type: "function" as const, function: { ... } };

// ② 整对象 as const（全部变成 readonly + 字面量）
const ECHO_TOOL = { type: "function", function: { ... } } as const;

// ③ 显式标注 SDK 类型（和阶段 0 一样走上下文收窄）
const ECHO_TOOL: ChatCompletionFunctionTool = { type: "function", function: { ... } };

// ④ satisfies：既校验结构，又保留推断
const ECHO_TOOL = { type: "function", function: { ... } } satisfies ChatCompletionFunctionTool;
```

给 SDK 用，③ 或 ④ 更干净：目标类型已知，根本不会 widening。

**总结：** widening 是 TS 在可变位置把字面量放宽成 `string`/`number`/`boolean`。对象属性默认按 `let` 推断，所以 `type: "function"` 会变成 `string`，对不上 SDK 判别联合要求的字面量。`as const`、类型标注、`satisfies` 都是在阻止这次拓宽；阶段 0 没踩这个坑，是因为上下文类型已经把字面量钉死了。

---

## 2026-09-19-11 VS Code 断点调试配置

**问题：** TypeScript 源码如何与运行中的 JavaScript 断点对应？

`tsc` 生成 `dist/*.js` 和 source map，调试器据此映射到 `src/*.ts`。
类似 Java 在 `.java` 上打断点、运行 `.class`。使用 Launch 配置按 F5 启动；普通 `npm start` 不会自动进入调试器。
项目的最小配置与排查步骤见 [README](../README.md#vs-code-断点调试)。

---

## 2026-09-20-12 JavaScript falsy 值与空字符串判断

**问题：** `if (!userInput) { break; }` 在什么情况下会进入？

**答案：**

`userInput` 是 `line.trim()` 的结果，类型是 `string`。JavaScript 中空字符串 `""` 是 falsy 值，`!""` 为 `true`。

所以 `!userInput` 为 `true` 就是用户直接按了回车，没有输入任何内容（或只输入了空格/Tab，被 `trim()` 去掉后变成空字符串）。

### JavaScript falsy 值完整清单

| 值 | `!value` | 说明 |
|------|----------|------|
| `""` | `true` | 空字符串 |
| `0` / `-0` | `true` | 零 |
| `NaN` | `true` | 非数字 |
| `null` | `true` | 空引用 |
| `undefined` | `true` | 未定义 |
| `false` | `true` | 布尔假 |
| **其他所有值** | `false` | 包括 `" "`、`"0"`、`[]`、`{}` |

### 对比 Java

Java 中空字符串不能直接当 boolean 用：

```java
String input = "";
if (!input) { }          // ❌ 编译报错
if (input.isEmpty()) { } // ✅ Java 的做法
```

TypeScript/JavaScript 的隐式 falsy 转换省了 `.isEmpty()`，但需要注意：空字符串 `""` 和 `null`/`undefined` 在 `!` 下行为相同，都是 `true`。

**总结：** `!userInput` 在 `userInput` 为空字符串时为 `true`，即用户按了空回车。JavaScript 的 falsy 值有 6 个，空字符串是其中之一，这与 Java 必须显式调用 `.isEmpty()` 不同。

---

## 2026-09-20-13 readline.on/off 信号监听与 SIGINT 处理

**问题：** `input.on("SIGINT", onSigint)` 和 `input.off("SIGINT", onSigint)` 有什么作用？

**答案：**

### 基本作用

```ts
input.on("SIGINT", onSigint);   // 注册：用户按 Ctrl+C 时执行 onSigint
input.off("SIGINT", onSigint);  // 注销：移除这个处理函数
```

| 方法 | 作用 | Java 类比 |
|------|------|-----------|
| `input.on("SIGINT", fn)` | 注册 readline 监听器 | `Runtime.getRuntime().addShutdownHook(thread)` |
| `input.off("SIGINT", fn)` | 移除 readline 监听器 | `Runtime.getRuntime().removeShutdownHook(thread)` |

### SIGINT 是什么

`SIGINT`（Signal Interrupt）是操作系统级别的中断信号，用户在终端按 Ctrl+C 时触发。使用 `readline` 时，终端输入接口会先发出 `SIGINT` 事件；注册了 `input.on("SIGINT", fn)` 后，程序可以执行处理函数（如触发 `AbortController` 取消请求）。

### 为什么要 off

如果只 `on` 不 `off`，每次循环都注册新监听器，会导致：

1. **重复执行**：按一次 Ctrl+C，多个监听器同时触发
2. **内存泄漏**：超过 10 个监听器时 Node.js 警告 `MaxListenersExceededWarning`
3. **引用过期**：旧监听器引用已用完的 `AbortController`

正确模式是成对使用：

```ts
input.on("SIGINT", onSigint);
try {
  await streamChat(messages, signal);
} finally {
  input.off("SIGINT", onSigint);
}
```

### on/off 是 EventEmitter 的通用 API

`readline.Interface` 也是 `EventEmitter`，`on`/`off` 不是 SIGINT 专用的：

| 方法 | 作用 |
|------|------|
| `emitter.on(event, fn)` | 注册监听器 |
| `emitter.off(event, fn)` | 移除监听器（`removeListener` 的别名） |
| `emitter.once(event, fn)` | 注册只触发一次的监听器 |
| `emitter.emit(event, ...args)` | 手动触发事件 |

**总结：** `input.on("SIGINT", fn)` 注册 readline 的 Ctrl+C 处理器实现优雅取消；`input.off("SIGINT", fn)` 在操作结束后注销避免泄漏。成对使用是固定模式，底层是 Node.js EventEmitter API。

---

## 2026-09-25-14 消息历史与 JSONL 会话恢复

**问题：** 为什么保存完整消息，而不是直接保存 `RuntimeEvent`？

消息历史是下次模型请求的上下文；运行事件负责通知界面或记录诊断。
会话持有消息数组，`runAgent()` 追加用户输入、完整 assistant 回答、工具调用和结果。
`text_delta` 只是片段，不作为完整回答恢复；用量、耗时等属于后续诊断记录。

工具交互顺序是 user → assistant 的 tool_calls → 对应 ID 的 tool 结果 → assistant 最终回答。
恢复只读取这些消息，不调用 `executeTool()`。缺少工具结果表示执行结果未知，不能假定失败并重试。

**问题：** JSONL 怎样保存多轮消息？

每行是独立 JSON 对象；`JSON.stringify()` 将消息内部换行编码为 `\n`，真实换行分隔记录。
第一行声明格式版本和模型，后续行保存完整消息：

```jsonl
{"type":"session","version":1,"model":"local-test"}
{"type":"message","message":{"role":"user","content":"你好"}}
{"type":"message","message":{"role":"assistant","content":"你好！"}}
```

实现见 [src/core/session.ts](../src/core/session.ts) 和 [src/index.ts](../src/index.ts)：

- `Message` 用 `role` 区分消息；磁盘 JSON 先作为 `unknown`，由 `messageFrom()` 校验，类型断言不能代替校验。
- `nextPending()` 用 `Set<string>` 跟踪尚未收到结果的调用 ID，拒绝未配对结果或中途插入普通消息。
- `saveMessage()` 先写入并刷盘，再更新内存；`O_WRONLY | O_APPEND` 只打开已有文件，不隐式创建。
  不先做文件存在性检查，避免检查与写入之间的竞态。打开后被外部删除或替换仍不在此保证内。
- `loadSession()` 检查 UTF-8、格式头、模型、逐行内容及配对关系，成功后才替换当前会话。
- `lockSessions()` 通过 `wx` 独占创建项目级锁，`finally` 清理；强制结束进程会留下需要人工处理的锁。

取消时保留已经完整保存的消息，丢弃未完成 assistant 文本，因此可能出现相邻的两条 user 消息。
同步文件 API 适用于当前学习规模；需要高吞吐或大历史时再评估异步写入。

复习实验：备份仅含测试数据的会话，在末尾追加不完整 JSON，再尝试恢复。
应报告行号且不改写原文件；还原备份后应可加载。正式验证见 `tests/session-persistence.py`。

---

## 2026-09-25-15 运行诊断与中断状态

**问题：** 会话已经保存消息，为什么还需要诊断记录？

完整消息回答“下次给模型什么上下文”；诊断记录回答“哪个操作执行过、耗时多久、怎样结束”。
诊断不会发送给模型，也不应把文本增量重复写入日志。以下设计已接入主实现，2026-09-25 通过当前源码的本地模拟验收。

**当前实现：** 每次提问生成独立运行文件，放在 `.lcn-agent/diagnostics/<完整会话文件名>/` 下，
文件名由 `randomUUID()` 生成。文件采用 JSONL，首行为版本 1 的 `run` 记录，包含会话文件名和模型；
后续为 `start`、`end` 和 `finish`。保留原会话格式与旧会话兼容。

| 字段或记录 | 含义 |
| --- | --- |
| `at` | ISO 时间，用于定位发生时间 |
| `operationId` | 单次操作的独立 UUID，用于开始与结束配对 |
| `kind`、`name`、`round` | 模型或工具、名称、模型轮次 |
| `callId` | 工具调用的原始 ID，模型操作为 null |
| `elapsedMs` | `performance.now()` 的差值；不通过系统日期计算耗时 |
| `outcome` | success、error、cancelled 或 timeout |
| `reason` | 结束原因；模型错误只保留 HTTP 状态及错误类型，不写提供商原始正文 |
| `usage` | 提供商报告的用量；缺失或不适用为 null，不填零冒充实际用量 |
| `finish` | 本次提问的 Agent 结束原因及轮次 |

`Date.now()` 对应系统时间，校时会改变它；`performance.now()` 适合测量同一进程内的时间间隔。
耗时从开始记录落盘后计时，到操作返回或抛异常结束；模型 SDK 自身重试的时间包含在内。

**问题：** 为什么先写开始记录，再执行工具？

若进程在执行中退出，磁盘上的开始记录仍可定位该操作。只有开始、没有有效结束时，
展示“结果未知”，不自动认定失败或重试。结束记录只证明执行器已经取得结果，
不等于对应会话消息一定保存成功；会话与诊断之间没有跨文件事务。

记录在每次追加后刷盘。写入错误直接终止当前运行，不把它当作工具失败继续执行。
工具结果的诊断写入放在工具执行的 try/catch 之外，避免捕获日志异常后伪造工具失败。

`/diagnostics` 查看当前会话，`/diagnostics 完整会话文件名` 查看指定会话；
后者无需成功恢复会话，便于查看有未配对工具调用的中断会话。文件名必须来自实际会话清单。
读取遇到损坏行会报告位置、停止解析其后记录并保留原文件；无诊断的旧会话显示暂无记录。
显示时按运行文件名排列，不承诺不同运行之间按开始时间排序。

**复习实验：** 在仅含测试数据的诊断文件中移除一个工具的 end 记录，执行查看命令。
应出现“结果未知”，不会请求模型或重做工具；恢复备份后应显示原来的执行结果。

本节点不引入日志库、数据库、自动重试或扩展框架。当前 echo 工具的错误理由可直接记录；
新增可能携带凭据的工具时，需按该工具的错误结构制定脱敏规则，不直接保存任意异常正文。

---

## 2026-09-25-16 export function 与 export default function 的区别

**问题：** `export function` 和 `export default function` 有什么区别？`src/extensions/upper.ts` 的 `export default` 是否需要修改？

**答案：**

### 两种导出方式

**命名导出（Named Export）：**

```ts
export function add(a: number, b: number) { return a + b; }
```

导入时必须用花括号，名字要对上：

```ts
import { add } from "./utils.js";
import { add as plus } from "./utils.js";  // 重命名
```

一个文件可以有任意多个命名导出。

**默认导出（Default Export）：**

```ts
export default function log(msg: string) { console.log(msg); }
```

导入时不用花括号，名字随便取：

```ts
import log from "./logger.js";
import myLogger from "./logger.js";  // 叫什么都行
```

一个文件只能有一个 `default`。

### 对比

| | 命名导出 | 默认导出 |
|--|---|---|
| 数量 | 一个文件可以有多个 | 一个文件只能有一个 |
| 导入语法 | `import { name }` | `import name`（无花括号） |
| 名字 | 必须匹配（或用 `as` 重命名） | 导入方随意命名 |
| 重构友好 | IDE 全局重命名能追踪 | 每个导入方名字不同，难追踪 |

社区倾向优先用命名导出。默认导出常见于框架约定（React 组件、Next.js 页面等）。

### upper.ts 的问题

同一目录下两个扩展文件风格不一致：

```ts
// echo.ts — 命名导出
export function registerEcho(register: RegisterTool): void { ... }

// upper.ts — 默认导出
export default function registerUpper(register: RegisterTool): void { ... }
```

`echo.ts` 在 `index.ts` 里的导入是 `import { registerEcho } from "./extensions/echo.js"`。如果 `upper.ts` 保持默认导出，导入就会变成无花括号的 `import registerUpper from "./extensions/upper.js"`，和 echo 不一致。

建议去掉 `default`，改成命名导出：

```ts
export function registerUpper(register: RegisterTool): void {
  register({ definition, execute });
}
```

**总结：** 命名导出用花括号、名字固定、可以多个；默认导出无花括号、名字随意、只能一个。同一目录的扩展文件应保持统一风格，`upper.ts` 应改为命名导出以和 `echo.ts` 一致。

---

## 2026-09-25-17 解构赋值中的冒号重命名

**问题：** `export function registerEcho({ registerTool: register }: ExtensionAPI): void` 中 `registerTool: register` 是什么写法？

**答案：**

这是**解构赋值 + 重命名**，一步完成"从参数对象里取出属性"和"在函数内部换个名字用"。

### 语法结构

```ts
function registerEcho({ registerTool: register }: ExtensionAPI): void {
//                      ^^^^^^^^^^^^  ^^^^^^^^    ^^^^^^^^^^^^
//                      原属性名       本地变量名    参数的类型标注
  register({ definition, execute });
}
```

`ExtensionAPI` 的定义：

```ts
type ExtensionAPI = {
  registerTool: RegisterTool;
  registerCommand: (command: Command) => void;
};
```

等价于分开写：

```ts
function registerEcho(api: ExtensionAPI): void {
  const register = api.registerTool;
  register({ definition, execute });
}
```

### 冒号在解构里是重命名，不是类型标注

| 上下文 | 冒号含义 | 例子 |
|--------|---------|------|
| 变量声明 | 类型标注 | `const x: string = "hi"` |
| 解构赋值 | 重命名 | `const { registerTool: register } = api` |

### 不重命名的写法

如果不需要换名字，直接用属性名当变量：

```ts
function registerEcho({ registerTool }: ExtensionAPI): void {
  registerTool({ definition, execute });
}
```

选择重命名成 `register`，是因为函数内部只关心"注册"这个动作，用短名字更简洁。

**总结：** `{ registerTool: register }` 是从参数对象里取出 `registerTool` 属性，在函数内部叫 `register`。冒号在解构里是重命名，不是类型标注。
