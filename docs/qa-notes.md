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
- [07 类型谓词与类型收窄机制](#2026-09-18-07-类型谓词与类型收窄机制)
- [08 TypeScript 枚举写法与字符串联合类型的选择](#2026-09-18-08-typescript-枚举写法与字符串联合类型的选择)

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
