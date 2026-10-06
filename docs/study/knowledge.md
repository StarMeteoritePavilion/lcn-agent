# TypeScript 与 JavaScript 学习笔记

按知识主题维护，用于理解源码中的语法和运行机制。本文保留早期代码的学习示例；标为“历史示例”的 `src/ai`、`packages/ai` 和 `learning-materials` 路径仅记录来源，不代表当前项目结构。当前目录与运行方式见[项目说明](../../README.md)。各示例独立阅读，节选代码依赖原有上下文。

## 导航与追加约定

| 分类                                                    | 已收录主题                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| [JavaScript 基础语法](#javascript-基础语法)             | 剩余参数、展开语法、三元运算符、条件添加属性、箭头函数、`void` 运算符 |
| [TypeScript 接口与泛型](#typescript-接口与泛型)         | 接口、类型导入、类型组合、泛型默认值、泛型约束                        |
| [TypeScript 工具类型](#typescript-工具类型)             | `Extract`、条件类型、`Record`、函数类型、`ReturnType`、`Awaited`      |
| [TypeScript 类型检查与推断](#typescript-类型检查与推断) | 非空断言、`as`、`satisfies`、上下文类型、类型谓词、`never` 与穷尽检查 |
| [异步迭代与生成器](#异步迭代与生成器)                   | 生成器、迭代协议、Symbol 入口、事件流与结束通知                       |
| [Node.js 模块与进程](#nodejs-模块与进程)                | 入口文件判断、函数返回、进程退出与退出码                              |

后续维护方式：

- 二级标题表示分类，三级标题表示知识主题；不使用连续编号，插入主题时无需重排全文。
- 已有主题的新问题直接补充到该主题，避免重复解释；新主题加入对应分类，并更新上表。
- 每个主题优先保留“含义 → 示例 → 关键边界”，需要细分时使用四级标题。
- 引用源码时核实精确声明并标明来源；历史实现的行为与语言通用规则分别说明。跨主题引用使用标题链接。

## JavaScript 基础语法

### 剩余参数与展开语法 `...`

**声明时收集，使用时展开。** 两者都属于 JavaScript 语法，TypeScript 可以在其上增加类型标注。

| 位置       | 示例                           | 作用                                 |
| ---------- | ------------------------------ | ------------------------------------ |
| 参数声明   | `...items: T[]`                | 将剩余实参收集为一个数组             |
| 函数调用   | `numbers.push(...moreNumbers)` | 将可迭代对象中的元素分别作为实参传入 |
| 对象字面量 | `{ ...object }`                | 复制对象自身可枚举的属性             |

数组 `push()` 的 TypeScript 签名为：

```ts
push(...items: T[]): number;
```

`...items` 收集零个或多个实参，`: T[]` 约束元素类型，`: number` 表示返回添加元素后的数组长度。

```ts
const numbers: number[] = [];

numbers.push(1); // 返回 1，数组变为 [1]。
numbers.push(2, 3); // 返回 3，数组变为 [1, 2, 3]。
numbers.push(); // 返回 3，数组保持不变。

const moreNumbers: number[] = [4, 5];
numbers.push(...moreNumbers); // 等同于 numbers.push(4, 5)。
```

普通数组参数 `items: number[]` 接收一个数组，例如 `method([1, 2, 3])`；剩余参数 `...items: number[]` 接收多个数字，例如 `method(1, 2, 3)`。对 `number[]` 调用 `push([4, 5])` 会产生类型错误；如果接收方是 `number[][]`，则可以添加一个 `number[]`。

```ts
/**
 * 计算所有传入数字的总和。
 * @param values - 收集所有实参得到的数字数组。
 * @returns 所有数字的总和；未传入参数时返回 0。
 */
function sum(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

sum(1, 2, 3); // 返回 6。
sum(); // 返回 0。
```

剩余参数在 ES2015 中引入，必须位于参数列表末尾，一个函数只能有一个。它是真正的数组；旧式 `arguments` 是包含所有实参的类数组对象。箭头函数也支持剩余参数，但没有自己的 `arguments`。

### 三元运算符与条件添加属性

历史示例 `learning-materials` 的 OpenAI SDK 配置包含：

```ts
{
  apiKey: config.apiKey,
  baseURL: config.baseUrl,
  timeout: config.timeoutMs ?? 60000,
  maxRetries: 0,
  ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
}
```

**先通过 `条件 ? A : B` 选择对象，再通过 `...` 展开属性。**

| 条件                      | 选中的对象                    | 配置结果          |
| ------------------------- | ----------------------------- | ----------------- |
| `config.fetchImpl` 为真值 | `{ fetch: config.fetchImpl }` | 添加 `fetch` 属性 |
| `config.fetchImpl` 为假值 | `{}`                          | 不添加任何属性    |

这里判断的是真值，不只是检查 `undefined`。普通函数是真值，`undefined`、`null`、`false`、`0`、空字符串等是假值。传递的是 `config.fetchImpl` 函数本身，没有调用它。

省略属性与将属性设为 `undefined` 不同：

```ts
const omitted = {};
const present = { fetch: undefined };

"fetch" in omitted; // false，属性不存在。
"fetch" in present; // true，属性存在，值为 undefined。
```

这里的 `{}` 是运行时空对象；类型位置的 `{}` 含义见[联合类型与交叉类型](#联合类型与交叉类型)。

### 箭头函数的参数括号与隐式返回

**只有一个普通参数、且没有类型标注时，箭头函数可以省略参数括号。** 以下两种回调写法等价：

```ts
block => block.type === "text"
(block) => block.type === "text"
```

这是独立的语法片段；放入 `filter(...)` 时，参数类型可以从数组元素类型推断。省略括号不会改变运行结果或类型推断。

| 写法                                                     | 参数括号要求             |
| -------------------------------------------------------- | ------------------------ |
| `block => block.type === "text"`                         | 单个普通参数，可以省略   |
| `(block: TextContent) => block.type === "text"`          | 有参数类型标注，必须保留 |
| `(block): block is TextContent => block.type === "text"` | 有返回类型谓词，必须保留 |
| `(block, index) => index > 0`                            | 多个参数，必须保留       |
| `() => true`                                             | 没有参数，必须保留       |

`=>` 后直接写表达式，会隐式返回其结果；写成 `{ ... }` 函数体时，需要显式 `return`：

```ts
(block) => {
  return block.type === "text";
};
```

这里只返回比较得到的布尔值，`filter` 据此保留元素。若写了大括号却漏掉 `return`，回调返回 `undefined`，`filter` 不会保留该元素。类型谓词的作用见[类型谓词与筛选中的类型收窄](#类型谓词与筛选中的类型收窄)。

### `void` 运算符与忽略异步返回值

**`void 表达式` 会执行表达式，并将整个表达式的结果变成 `undefined`。** 它是 JavaScript 的一元运算符，不会阻止函数执行，也不会等待或取消异步任务。

[openai-completions.ts](../../src/ai/api/openai-completions.ts) 的历史 `stream()` 实现有以下节选；当前实现使用异步函数表达式启动后台请求：

```ts
const stream = new AssistantMessageEventStream();

void runStream(model, context, stream, options);

return stream;
```

`runStream` 是返回 `Promise<void>` 的异步函数。调用后会先执行到第一个暂停点，再异步继续处理响应；这里忽略它返回的 Promise，让外层函数无需等请求完成就返回事件流对象。后续数据通过 `stream.push(...)` 交付，调用方可以逐步读取。

| 写法                   | 行为                                              |
| ---------------------- | ------------------------------------------------- |
| `runStream(...)`       | 调用函数，不等待，返回值未被使用                  |
| `void runStream(...)`  | 调用函数，不等待，明确表达有意忽略返回值          |
| `await runStream(...)` | 等待 Promise 完成后再继续；拒绝时在等待处抛出异常 |

因此，这里的 `void` 并非必须，直接调用也不会自动等待。它主要表达意图；某些检查未处理 Promise 的代码规则允许这种写法，是否允许取决于规则配置。`void` 不创建新线程，函数的异步行为来自自身实现。

**忽略 Promise 不等于处理错误。** `void` 不捕获同步异常，也不为 Promise 注册拒绝处理；未处理的拒绝仍可能被运行环境报告。上述历史实现中的 `runStream` 自身用 `try/catch` 将请求与响应处理异常转换为 `error` 事件，并结束事件流。这是函数内部的处理，不是 `void` 的效果，也不保证 `catch` 自身再次出错时 Promise 不会拒绝。

注意区分两个位置的 `void`：

| 写法                  | 含义                                                     |
| --------------------- | -------------------------------------------------------- |
| `void runStream(...)` | 运行时运算符，执行调用并忽略表达式结果                   |
| `Promise<void>`       | TypeScript 类型，表示 Promise 完成后不提供有意义的结果值 |

即使返回类型是 `Promise<void>`，函数仍然返回 Promise，仍然可以被 `await` 等待完成。

## TypeScript 接口与泛型

### 接口声明与直接使用

**`interface` 描述数据结构，`export` 让其他模块可以导入这个类型。** 历史示例 `src/ai/types.ts` 中：

```ts
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

| 声明                     | 要求                                       |
| ------------------------ | ------------------------------------------ |
| `type: "text"`           | 必需属性，值只能为 `"text"`                |
| `text: string`           | 必需属性，值必须是字符串                   |
| `textSignature?: string` | 可选属性，可以省略；提供字符串值时符合要求 |

接口主要用于检查结构、复用类型，以及提供编辑器补全。声明后就可以给变量、函数参数和返回值标注类型，无需定义一个类或创建接口实例。

```ts
const content: TextContent = {
  type: "text",
  text: "你好",
};

const wrong: TextContent = {
  type: "text",
  text: 123, // 类型错误：text 应为字符串。
};
```

TypeScript 按结构判断兼容性，不要求普通对象显式声明自己实现了接口。同一模块内直接使用即可，不要求 `export`；供其他模块使用时，先导出，再通过 `import type` 等方式导入。

接口也可以先引用、后声明。历史示例中的 `AssistantMessage` 引用了后面声明的类型：

```ts
content: (TextContent | ThinkingContent | ToolCall)[];
```

这表示数组元素可以符合三种结构之一，只是在组合类型，没有创建数组。`interface` 编译后会被移除，不能执行 `new TextContent()`；`class` 则可以提供运行时实现并创建实例，类也可以用 `implements` 接受接口约束。

### 类型导入 `import type` 与普通 `import`

**只用于类型检查的依赖使用 `import type`；运行时需要调用函数、创建实例或读取常量时，使用普通 `import`。**

[main.ts](../../src/main.ts) 分别导入运行时函数和类型，下面节选其中两个名称：

```ts
import { loadSettings } from "./base/settings.ts";
import type { Context } from "./ai/types.ts";
```

`loadSettings` 需要在运行时调用；`Context` 用于类型标注，编译后不需要这个接口。

| 写法                                                | 用途           | 编译为 JavaScript 后     |
| --------------------------------------------------- | -------------- | ------------------------ |
| `import type { Context } from "./ai/types.ts"`      | 仅用于类型检查 | 整条导入被移除           |
| `import { loadSettings } from "./base/settings.ts"` | 获取运行时函数 | 当前配置下保留运行时导入 |

项目的 [tsconfig.json](../../tsconfig.json) 开启了 `verbatimModuleSyntax`：类型导入会被移除，普通导入会保留；仅有类型身份的接口等名称必须显式使用类型导入。保留的模块路径还会按项目编译配置处理。

#### 函数也可以只作为类型来源导入

`import type` 不只用于接口，还可以导入函数或类的名称，但导入后只能用于类型位置。例如，下面是独立的类型用法示例：

```ts
import type { loadSettings } from "./base/settings.ts";

type Config = ReturnType<typeof loadSettings>;
```

这里的 `typeof` 位于类型位置，不调用函数。如果随后执行 `loadSettings("setting.json")`，会产生类型错误，因为该名称通过 `import type` 导入，不能作为运行时值使用。同理，通过类型导入取得的类不能用于 `new` 或 `instanceof`。

同一模块同时导出值和类型时，可以使用 `import { 值名称, type 类型名称 } from "模块路径"` 合并导入。名称必须确实由该模块导出；当前 `settings.ts` 的 `SettingsConfig` 是内部接口，没有导出，不能直接导入它。

#### 模块执行与副作用

整条 `import type` 被移除，因此不会因这条导入而在运行时加载、执行目标模块；若其他地方存在普通导入，目标模块仍会被加载。普通导入会参与模块加载，并执行目标模块的顶层代码。

在 `verbatimModuleSyntax` 下，`import { type Context } from "./ai/types.ts"` 虽然移除了类型名称，仍会留下空的运行时导入 `import {} from "./ai/types.js"`。全部名称都仅用于类型时，使用整条 `import type`，可明确避免保留这条运行时依赖。

### 泛型参数、默认值与约束

**泛型让调用方传入类型，再由声明中的类型参数引用它。** `T`、`R`、`TApi` 都是类型参数名称，不是关键字或运行时变量。

#### 默认值 `R = T`

历史示例 `src/ai/utils/event-stream.ts` 中：

```ts
export class EventStream<T, R = T> implements AsyncIterable<T>
```

| 参数    | 职责                                                    |
| ------- | ------------------------------------------------------- |
| `T`     | `push(event: T)` 接收的事件类型，也是迭代输出的元素类型 |
| `R = T` | 最终业务结果类型；没有指定或推断出 `R` 时，默认使用 `T` |

```ts
type SameTypeStream = EventStream<string>; // 等同于 EventStream<string, string>。
type DifferentTypeStream = EventStream<string, number>; // 事件为 string，结果为 number。
```

默认值可以引用前面的类型参数；有默认值的参数可以省略，后面不能再放必需类型参数。调用泛型函数或用 `new` 创建泛型类实例时，类型参数还可以从实参推断，因此省略类型实参并不意味着一定使用默认值。

当前 `AssistantMessageEventStream` 继承 `EventStream<AssistantMessageEvent, AssistantMessage>`：迭代取得事件，`result()` 返回 `Promise<AssistantMessage>`。`R` 是该类自行管理的结果类型，`AsyncIterable<T>` 本身不管理它。

#### 约束与默认值组合 `TApi extends Api = Api`

历史示例 `doc/stage-05/reference/src/types.ts` 中：

```ts
export type Api = "openai-responses" | "anthropic-messages" | "openai-completions";

export interface Model<TApi extends Api = Api> {
  id: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  maxTokens: number;
}
```

| 部分          | 含义                               |
| ------------- | ---------------------------------- |
| `TApi`        | 调用方可以指定的类型参数           |
| `extends Api` | 约束：指定的类型必须能赋值给 `Api` |
| `= Api`       | 默认值：省略类型参数时使用 `Api`   |
| `api: TApi`   | 属性使用具体传入的类型             |

```ts
type AnyModel = Model; // 等同于 Model<Api>，api 允许上述三种值。
type ResponsesModel = Model<"openai-responses">; // api 只能为 "openai-responses"。
type InvalidModel = Model<number>; // 类型错误：number 不满足 Api 约束。
```

当前 `Model<TApi extends Api>` 没有泛型默认值，使用时必须提供具体协议或 `Api`、`KnownApi`；上面的省略写法只适用于历史示例。

直接写 `api: Api` 会允许全部 `Api` 值；使用 `api: TApi` 可以保留“这个模型使用哪一种接口”的具体类型。这里的 `extends` 表示泛型约束，`=` 表示类型默认值，均不会产生运行时赋值或自动转换。

### 联合类型与交叉类型

`A | B` 表示允许符合任一成员；`A & B` 表示同时符合两侧类型。历史示例 `src/ai/types.ts` 使用以下写法保留字符串补全：

```ts
export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-codex-responses";

export type Api = KnownApi | (string & {});
```

在严格空值检查下，类型 `{}` 表示非 `null`、非 `undefined` 的值，不只表示空对象。字符串本来就符合它，所以 `string & {}` 仍允许任意字符串；数字和布尔值虽然符合 `{}`，却不符合 `string`。

| 写法                        | 允许的值         | 已知值补全                   |
| --------------------------- | ---------------- | ---------------------------- |
| `KnownApi`                  | 仅已定义的字符串 | 保留                         |
| `KnownApi \| string`        | 任意字符串       | 通常因简化为 `string` 而丢失 |
| `KnownApi \| (string & {})` | 任意字符串       | 通常保留                     |

这个技巧让编译器保留字面量成员与交叉类型成员的区别；具体补全表现取决于编辑器、TypeScript 版本和使用位置。

```ts
const known: Api = "openai-responses";
const custom: Api = "custom-api"; // 仅展示允许自定义字符串，不代表已有对应实现。
```

允许任意字符串也意味着拼写错误可以通过类型检查。补全提示不验证运行时是否支持该接口。这里的 `Api` 与上一主题的阶段示例各自独立，取值范围不同。

## TypeScript 工具类型

### `Extract` 与分布式条件类型

**`Extract<T, U>` 保留 `T` 中能赋值给 `U` 的成员，没有匹配成员时得到 `never`。** 它是内置工具类型，其定义使用条件类型：

```ts
type Extract<T, U> = T extends U ? T : never;
```

条件类型中的 `extends` 判断可赋值关系。左侧直接使用类型参数 `T`，传入联合类型时，条件判断会分布到各成员上：

```ts
type Status = "success" | "error" | "loading";
type Result = Extract<Status, "success" | "error">; // "success" | "error"
type Missing = Extract<Status, "pending">; // never
```

```text
"success" → 符合条件 → "success"
"error"   → 符合条件 → "error"
"loading" → 不符合条件 → never
合并："success" | "error" | never → "success" | "error"
```

`never` 不会给联合类型增加可取的值。筛选依据是可赋值关系，不要求类型完全相同，例如 `Extract<"success" | 1, string>` 得到 `"success"`。

历史示例 `packages/ai/src/types.ts` 中：

```ts
export type Content =
  | { type: "text"; text: string }
  | { type: "refusal"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, JsonValue> };
```

`Extract<Content, { type: "toolCall" }>` 保留整个工具调用成员，包含 `type`、`id`、`name`、`arguments`，不只留下筛选条件中的 `type`。选择对象属性使用的是 `Pick<T, K>`。

### `Record`、函数映射与 `Promise<unknown>`

**`Record<键类型, 值类型>` 描述对象的键和值。** 键类型决定哪些属性受到约束：

| 写法                                  | 等价结构                            | 要求                                 |
| ------------------------------------- | ----------------------------------- | ------------------------------------ |
| `Record<string, number>`              | `{ [key: string]: number }`         | 字符串键对应数字，不指定必须存在的键 |
| `Record<"plain" \| "stream", number>` | `{ plain: number; stream: number }` | 两个指定属性都是必需的               |

指定键名不代表运行时对象绝对不能有其他属性；使用任意字符串键也不保证每个键实际存在。

历史示例 `learning-materials` 用它定义场景函数映射：

```ts
type ScenarioMap = Record<string, (config: DemoConfig) => Promise<unknown>>;
```

等价于：

```ts
type ScenarioMap = {
  [name: string]: (config: DemoConfig) => Promise<unknown>;
};
```

这里的 `=>` 位于类型声明中，描述函数类型，没有创建箭头函数：

- 键是场景名称，类型为 `string`。
- 值是接收 `DemoConfig` 参数的函数。
- 函数返回 `Promise<unknown>`，允许不同场景产生不同结构的结果。

`unknown` 不表示结果为空。通过 `await` 取得结果后，需要先检查或缩小类型，才能读取具体属性或调用方法；`any` 则会放宽这些检查。

`Record<string, ...>` 不保证场景名存在。历史入口通过 `Object.hasOwn(scenarios, scenario)` 进行运行时检查，再调用对应函数。

### `ReturnType` 与类型位置的 `typeof`

**`ReturnType<T>` 从函数类型 `T` 中提取返回值类型，用于复用已有类型，避免重复声明。** 名称大小写为 `ReturnType`，它是 TypeScript 内置工具类型。

```ts
type GetName = () => string;
type Name = ReturnType<GetName>; // string

type GetCount = () => number;
type Count = ReturnType<GetCount>; // number
```

对于已有函数，先通过类型位置的 `typeof` 取得函数类型，再提取返回类型。[main.ts](../../src/main.ts) 中：

```ts
let runtime: ReturnType<typeof loadRuntime>;
```

| 部分                 | 含义                               |
| -------------------- | ---------------------------------- |
| `let runtime: ...`   | 声明变量并标注类型，尚未给变量赋值 |
| `typeof loadRuntime` | 取得 `loadRuntime` 的函数类型      |
| `ReturnType<...>`    | 提取该函数类型的返回值类型         |

[main.ts](../../src/main.ts) 中，`loadRuntime` 的参数为 `settingPath: string`，显式返回类型为 `{ model: Model<KnownApi>; options: StreamOptions }`，因此上面的类型标注等价于 `let runtime: { model: Model<KnownApi>; options: StreamOptions }`。当函数的返回类型改变时，通过 `ReturnType` 引用的类型也会随之变化。

类型声明不会调用函数，也不会读取配置文件。实际执行发生在后续赋值时：

```ts
runtime = loadRuntime("setting.json");
```

**类型位置与表达式位置的 `typeof` 用途不同**：`typeof loadRuntime` 写在类型标注里时取得函数类型；写在运行时表达式里时得到字符串 `"function"`。

#### 异步返回值与 `Awaited`

`ReturnType` 保留函数实际声明的返回类型，不会自动展开 Promise：

```ts
type LoadName = () => Promise<string>;
type PendingName = ReturnType<LoadName>; // Promise<string>
type ResolvedName = Awaited<ReturnType<LoadName>>; // string
```

`Awaited<T>` 按照 `await` 的解析规则提取完成后的结果类型，包括递归展开嵌套 Promise；它本身不会执行异步等待。当前 `loadRuntime` 是同步函数，使用 `ReturnType<typeof loadRuntime>` 即可，无需额外添加 `Awaited`。当前 `stream` 同步返回 `AssistantMessageEventStream`；`complete` 返回 `Promise<AssistantMessage>`，因此 `Awaited<ReturnType<typeof complete>>` 提取的是最终助手消息类型。对已经创建的流，应通过同一流的 `result()` 等待结果。

## TypeScript 类型检查与推断

### 非空断言、类型断言与符合性检查

**以下写法都参与编译期类型检查，不会自动生成运行时数据校验，也不会修复或转换实际值。** 外部数据仍需要在使用边界校验。

| 写法                | 类型检查中的作用                               |
| ------------------- | ---------------------------------------------- |
| `value!`            | 从表达式类型中排除 `null` 和 `undefined`       |
| `value as T`        | 将表达式按断言的目标类型处理                   |
| `value as any`      | 将表达式视为 `any`，放宽类型检查               |
| `value satisfies T` | 检查符合目标类型，同时保留表达式的具体类型信息 |

#### 非空断言 `!`

历史示例 `src/ai/utils/event-stream.ts` 中：

```ts
while (this.incoming.length > 0) {
  this.outcoming.push(this.incoming.pop()!);
}
```

`pop()` 返回 `T | undefined`，空数组会返回 `undefined`。虽然前面检查了长度，TypeScript 不会据此自动排除返回类型中的 `undefined`，因此这里使用后缀 `!`。

这句依次执行 `pop()`、对结果进行类型断言、将元素传给 `push()`；`push()` 返回的新长度未被使用。数组非空只保证存在元素，不保证元素自身不是空值，仍需结合 `T` 判断。后缀 `value!` 是类型断言，前缀 `!value` 是运行时逻辑取反。

#### 类型断言 `as` 与 `as any`

`undefined as any` 的实际值仍为 `undefined`，只是表达式按 `any` 检查。它不证明该值符合接收方要求，也不改变接收变量原本声明的类型。

历史结束通知中的两句在运行时传入相同内容：

```ts
waiter({ value: undefined as any, done: true });
waiter({ value: undefined, done: true });
```

是否能删除断言，需要检查实际 `IteratorResult<T>` 定义中结束分支的 `value` 类型，并通过编译验证。本文未验证删除结果。结束通知的运行机制见[事件流中的数据交付与结束通知](#事件流中的数据交付与结束通知)。

`as` 也不是完全不检查：明显不兼容的类型直接断言仍可能报错。但断言被接受，不等于实际数据已经通过验证。

#### `satisfies` 与 `as` 对属性信息的影响

`satisfies` 在 TypeScript 4.9 引入。下面两个示例独立阅读：

```ts
const timeoutMs = {
  plain: 60000,
} satisfies Record<string, number>;

timeoutMs.plain; // 保留具体属性信息。
timeoutMs.stream; // 类型错误：对象没有 stream 属性。
```

```ts
const timeoutMs = {
  plain: 60000,
} as Record<string, number>;

timeoutMs.stream; // 索引签名允许访问，但运行时得到 undefined。
```

第一种检查属性值是数字，仍保留具体属性名；第二种把对象按字符串索引类型处理，却没有添加 `stream` 属性。启用 `noUncheckedIndexedAccess` 时，未声明键的索引读取类型还会包含 `undefined`。

历史场景入口使用 `(scenarios as ScenarioMap)[scenario](...)`，让字符串变量可以索引场景对象；调用前仍需用 `Object.hasOwn` 检查存在性。类型断言不承担这项检查。

### 上下文类型与参数推断

历史示例 `learning-materials` 的场景对象末尾使用 `satisfies ScenarioMap`，其中：

```ts
type ScenarioMap = Record<string, (config: DemoConfig) => Promise<unknown>>;
```

这个目标类型为对象方法提供**上下文类型**，所以 `async plain(config)` 即使不写 `config: DemoConfig`，参数类型也能从外层约束推断。

```text
satisfies ScenarioMap
  → 属性值应符合场景函数类型
  → 场景函数接收 DemoConfig
  → plain(config) 的参数被推断为 DemoConfig
```

| 写法                                        | 参数类型来源       | 对象类型信息                           |
| ------------------------------------------- | ------------------ | -------------------------------------- |
| 参数写 `config: DemoConfig`                 | 显式类型标注       | 对象与返回类型继续按实现推断           |
| 变量写 `const scenarios: ScenarioMap = ...` | 变量类型提供上下文 | 变量整体按 `ScenarioMap` 使用          |
| 对象末尾写 `satisfies ScenarioMap`          | 目标类型提供上下文 | 保留具体场景名及各方法推断出的返回类型 |

推断依据是类型约束，不是参数名称或方法体中读取的字段。`satisfies` 参与上下文推断，因此“保留具体类型”不代表目标类型对推断完全没有影响。

### 类型谓词与筛选中的类型收窄

**参数类型标注说明“接收什么类型”，类型谓词说明“判断结果如何帮助编译器缩小类型范围”。**

| 回调写法                                                 | 含义                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `(block: TextContent) => block.type === "text"`          | 参数必须已符合 `TextContent`，函数体返回布尔值                   |
| `(block): block is TextContent => block.type === "text"` | 参数由上下文推断；返回 `true` 时，向编译器声明它是 `TextContent` |
| `block => block.type === "text"`                         | 参数与返回类型由编译器推断                                       |

`block is TextContent` 位于参数括号之后，是**返回类型位置的类型谓词**；它不会自动生成运行时检查。实际执行的只有箭头右侧的条件：

```ts
(block): block is TextContent => block.type === "text";
```

移除 TypeScript 类型信息后，对应的 JavaScript 为：

```js
(block) => block.type === "text";
```

#### 当前 `convertMessages` 中的效果

[openai-completions.ts](../../src/ai/api/openai-completions.ts) 的 `convertMessages` 先用 `isTextContentBlock` 筛选文本，再过滤空白文本、构造协议内容块并拼接原文。以下是省略协议内容块构造后的等价筛选示意：

```ts
const assistantText = msg.content
  .filter(isTextContentBlock)
  .filter((block: TextContent): boolean => block.text.trim().length > 0)
  .map((block: TextContent): string => block.text)
  .join("");
```

[types.ts](../../src/ai/types.ts) 中，`AssistantMessage.content` 声明为 `(TextContent | ToolCall)[]`。`isTextContentBlock` 的返回类型是 `block is TextContent`，首个 `filter` 因此将元素收窄为 `TextContent`，后续回调才能直接读取 `text`。

第一个 `filter` 检查内容标识，第二个过滤空白文本，`map` 保留文本原文，`join("")` 无分隔地拼接文本。`trim()` 仅用于判断空白，不改变发送的文本。第二个条件只检查文本内容，不识别新的类型，无需写类型谓词；它也不会把 `string` 变成“非空字符串类型”。

如果数组元素是包含其他内容类型的联合类型，类型谓词可以帮助 `filter` 将结果收窄为 `TextContent[]`。反之，把回调参数直接限定为 `TextContent`，就无法接收联合类型中的其他成员，在严格函数类型检查下会产生类型不兼容。

省略显式谓词也不代表一定失去收窄：TypeScript 5.5 起可以对符合条件的函数体推断类型谓词，例如通过可辨识联合成员的 `type` 字段进行判断。能否推断取决于输入类型和判断逻辑，不能把所有返回布尔值的回调都视为类型谓词。

#### 为什么不能写 `typeof block === TextContent`

`TextContent` 是接口，编译后被移除，运行时没有可供比较的接口值。JavaScript 的 `typeof block` 返回 `"object"`、`"string"` 等字符串，不会返回接口名称，因此这种比较无法验证接口。

`block.type === "text"` 检查的是对象的 `type` 属性，只检查这一个字段，不会自动检查 `text` 是否存在或是否为字符串。对于已经正确建模的联合类型，可以借助标识字段收窄；对于未经校验的外部数据，需要另行检查完整结构。显式类型谓词也不会让编译器证明判断逻辑正确，声明与实际检查必须一致。

### `never` 与不可能出现的值

**`never` 表示没有任何可能取值的类型。** 它用于表达不会正常返回的函数、排除类型成员，以及检查是否处理了所有分支；不会在运行时创建一种特殊值。

| 类型        | 含义                                               |
| ----------- | -------------------------------------------------- |
| `never`     | 没有可取的值；作为函数返回类型时，表示不会正常返回 |
| `void`      | 函数可以正常返回，但不提供有意义的结果             |
| `undefined` | 包含实际值 `undefined`                             |
| `null`      | 包含实际值 `null`                                  |

#### 不会正常返回的函数

以下是用于说明语法的独立示例：

```ts
/**
 * 抛出错误并终止当前执行路径。
 * @param message - 错误说明。
 * @throws 始终抛出包含指定说明的错误。
 */
function fail(message: string): never {
  throw new Error(message);
}
```

始终抛出异常或始终循环且不会退出的函数，可以返回 `never`。它与“返回了 `undefined`”不同：后者仍然是正常返回。`never` 是静态类型，不会自动让函数抛错或停止执行，实际行为由函数体决定。

#### 在联合类型中排除成员

```ts
type Result = string | never; // 等价于 string。
```

`never` 不增加任何可取的值，因此在联合类型中会被消去。`Extract<T, U>` 利用这一点，将不符合条件的成员变为 `never`；具体筛选过程见 [`Extract` 与分布式条件类型](#extract-与分布式条件类型)。

#### 穷尽检查

当控制流已经排除联合类型的全部成员，剩余分支中的变量会收窄为 `never`。可以利用这一点，让遗漏分支变成编译错误：

```ts
type Status = "success" | "error";

/**
 * 将状态转换为中文说明，并检查所有状态是否均已处理。
 * @param status - 成功或失败状态。
 * @returns 状态对应的中文说明。
 * @throws 运行时收到未处理的状态时抛出错误。
 */
function describeStatus(status: Status): string {
  if (status === "success") {
    return "成功";
  }
  if (status === "error") {
    return "失败";
  }

  const unhandled: never = status;
  throw new Error(`未处理的状态：${unhandled}`);
}
```

当前两种状态都已处理，赋值给 `never` 可以通过检查。如果以后给 `Status` 增加 `"pending"`，却没有补充分支，最后的 `status` 就仍可能为 `"pending"`，不能赋给 `never`，编译器会报告错误。

穷尽检查帮助发现类型定义变化后的遗漏；外部数据仍需运行时校验，不能仅凭类型声明认定实际输入一定合法。

## 异步迭代与生成器

### 生成器的暂停、恢复与传值

**生成器在 `yield` 处交出值并暂停，由后续 `next()` 恢复执行。** `function*` 和 `yield` 属于 JavaScript 语法，`Generator<...>` 是 TypeScript 类型标注。

```ts
/**
 * 依次产生两个数字，并返回结束说明。
 * @returns 依次产生 10 和 20、结束时返回说明的生成器。
 */
function* createSequence(): Generator<number, string, unknown> {
  yield 10;
  yield 20;
  return "结束";
}

const iterator = createSequence(); // 只创建生成器对象，函数体尚未执行。
iterator.next(); // { value: 10, done: false }
iterator.next(); // { value: 20, done: false }
iterator.next(); // { value: "结束", done: true }
iterator.next(); // { value: undefined, done: true }
```

`Generator<number, string, unknown>` 的参数依次表示 `yield` 产生的值、`return` 返回的值和 `next(value)` 传入的值。执行到函数末尾也会结束，结束值为 `undefined`。

生成器对象同时是迭代器和可迭代对象，可以直接用于 `for...of`。循环只处理 `done: false` 的结果，不会将最终返回值作为普通元素交给循环体。

`yield` 还是表达式：恢复执行时，取得下一次 `next(value)` 传入的值。

```ts
/**
 * 先产生数字 1，再产生调用方传回数字的两倍。
 * @returns 接收数字并依次产生初始值和计算结果的生成器。
 */
function* doubleInput(): Generator<number, void, number> {
  const input = yield 1;
  yield input * 2;
}

const iterator = doubleInput();
iterator.next(); // 交出 1 并暂停，input 赋值尚未完成。
iterator.next(5); // input 得到 5，交出 10。
iterator.next(); // 结束，结果为 { value: undefined, done: true }。
```

第一次 `next()` 用于启动生成器，还没有暂停中的 `yield`，所以第一次传入的值会被忽略。

### 异步迭代协议与 Symbol 入口

| 类型                | 职责             | 核心内容                                  |
| ------------------- | ---------------- | ----------------------------------------- |
| `AsyncIterable<T>`  | 提供异步迭代入口 | `[Symbol.asyncIterator]()` 返回异步迭代器 |
| `AsyncIterator<T>`  | 逐次读取元素     | `next()` 返回 Promise                     |
| `IteratorResult<T>` | 表达一次读取结果 | `value` 与 `done`                         |

`done: false` 表示取得一个元素，`done: true` 表示整个迭代结束。暂时没有事件时应继续等待，而不是返回结束结果。

`Symbol.asyncIterator` 是 JavaScript 内置的标准 Symbol 值，用于标识异步迭代入口。方括号表示计算属性名：

```ts
stream[Symbol.asyncIterator]; // 取得方法。
stream[Symbol.asyncIterator](); // 调用方法，取得异步迭代器。
```

这里调用的是对象的方法，不是 Symbol 本身。普通字符串方法名 `asyncIterator` 或自行创建的 `Symbol("asyncIterator")` 都不能替代标准键；每次 `Symbol()` 都会创建不同的值，即使描述相同也不相等。

历史示例通过异步生成器实现入口：

```ts
async *[Symbol.asyncIterator](): AsyncIterator<T>
```

| 部分                     | 作用                           |
| ------------------------ | ------------------------------ |
| `async`                  | 函数体可以使用 `await`         |
| `*`                      | 声明生成器，可以使用 `yield`   |
| `[Symbol.asyncIterator]` | 使用标准键，让语言找到迭代入口 |
| `: AsyncIterator<T>`     | 标注返回对象的能力和元素类型   |

类方法省略 `function`，所以 `*` 放在方法名前。异步生成器自动提供 `next()`、`return()`、`throw()`；也可以通过普通方法手动返回异步迭代器，协议不强制使用生成器。

| 对比                   | 同步生成器   | 异步生成器                       |
| ---------------------- | ------------ | -------------------------------- |
| 函数声明               | `function*`  | `async function*`                |
| `next()` 返回值        | 迭代结果对象 | 完成后得到迭代结果对象的 Promise |
| 函数体能否使用 `await` | 否           | 是                               |
| 常用遍历方式           | `for...of`   | `for await...of`                 |

### `for await...of` 的读取与关闭

```ts
// stream 为已有的异步可迭代对象；代码位于允许 await 的上下文中。
for await (const event of stream) {
  console.log(event);
}
```

核心过程是取得迭代器，逐次等待 `next()`，直到结束：

```ts
const iterator = stream[Symbol.asyncIterator]();
while (true) {
  const result = await iterator.next();
  if (result.done) {
    break;
  }
  console.log(result.value);
}
```

等待不会阻塞 JavaScript 线程。实际 `for await...of` 还会处理提前退出：执行 `break` 时尝试调用迭代器的 `return()` 并等待关闭完成；能否取消底层等待，取决于具体实现。

如果对象没有异步入口，`for await...of` 会尝试 `Symbol.iterator` 同步入口并进行适配，因此也可以遍历普通数组；两种入口都没有则不能遍历。

### 事件流中的数据交付与结束通知

以下专指历史示例 `src/ai/utils/event-stream.ts`，用于说明其实现，不代表协议要求。

#### 读取流程与两层结果

1. 先检查 `this.done`；为 `true` 就执行 `return`。
2. 队列有数据时，执行 `yield this.queue.dequeue()!`，交出一个事件并暂停。
3. 队列为空时，创建内部 Promise，将其 `resolve` 保存到 `waiting`，通过 `await` 等待。
4. `push(event)` 取出等待者，调用 `waiter({ value: event, done: false })`。
5. 生成器恢复执行，检查内部结果；未结束则执行 `yield result.value`，等待下一次读取。

**内部等待结果由项目代码构造，消费者的迭代结果由生成器机制构造。**

```text
push(event)
  → waiter({ value: event, done: false })
  → 内部 Promise 完成，result 取得该对象
  → yield result.value
  → 生成器构造另一个 { value: event, done: false }
  → 消费者的 await iterator.next() 完成
```

两个结果对象结构相同，但不是同一个对象。`yield result.value` 只交出事件，避免把内部结果对象作为事件输出。队列已有数据时直接 `yield`，不经过内部等待 Promise。

#### 结束通知与实现边界

`end()` 通过保存的 `resolve` 唤醒内部等待：

```ts
waiter({ value: undefined as any, done: true });
```

`done: true` 表达结束，`undefined` 表示没有事件或结束返回值，`as any` 只放宽类型检查。生成器随后执行：

```ts
if (result.done) {
  return;
}
yield result.value;
```

因此消费者不会收到作为普通事件的 `undefined`，而是收到迭代结束结果。

这个历史实现还有以下边界：

- 优先检查 `this.done`，结束后不再消费队列中的剩余事件。
- `push()` 遇到完成事件时先设置 `this.done`，再尝试交付；有等待者时交给一个等待者，否则入队，但后续读取会因结束标记而退出。
- 完成事件分支只唤醒一个等待者，`end()` 才会遍历并结束所有等待者。
- `result()` 返回 `finalResultPromise`，读取最终业务结果；它与生成器的结束返回值是两种机制。

## Node.js 模块与进程

### ES 模块的入口文件判断

历史示例 `learning-materials` 在 `main()` 开头判断：

```ts
if (!process.argv[1] || import.meta.url !== pathToFileURL(resolve(process.argv[1])).href) {
  return;
}
```

**没有入口路径，或当前模块 URL 与入口路径转换后的 URL 不同，就结束函数。** 这样在被其他模块导入时可以跳过命令行入口逻辑。

| 部分                 | 含义                                                   |
| -------------------- | ------------------------------------------------------ |
| `process.argv[0]`    | Node.js 可执行文件路径                                 |
| `process.argv[1]`    | 通过文件启动时的入口文件路径                           |
| `process.argv[2]`    | 入口文件之后的第一个命令行参数                         |
| `import.meta.url`    | 当前 ES 模块的完整 URL；本地文件模块使用 `file://` URL |
| `resolve(...)`       | 来自 `node:path`，将路径解析为绝对路径                 |
| `pathToFileURL(...)` | 来自 `node:url`，转换为 URL 对象并处理路径中的特殊字符 |
| `.href`              | URL 对象的完整 URL 字符串                              |
| `!==`                | 严格不相等比较                                         |

`||` 会短路：缺少入口路径时不再执行右侧转换。路径转成 URL 后才能与 `import.meta.url` 使用相同表示比较。这里比较的是字符串，`resolve()` 不解析符号链接，不能保证所有指向同一物理文件的路径都被识别为相同入口。

判断写在 `main()` 内部，只有调用后才执行。历史示例在文件末尾使用 `await main()`：调用负责启动函数，入口判断决定是否继续业务逻辑。

### 函数返回、进程退出与退出码

| 写法                      | 效果                                           |
| ------------------------- | ---------------------------------------------- |
| `return;`                 | 结束当前函数，不主动终止进程或设置退出码       |
| `process.exit(1);`        | 立即终止整个进程，退出码为 `1`                 |
| `return process.exit(1);` | 先调用 `process.exit(1)`，前面的 `return` 多余 |
| `process.exitCode = 1;`   | 设置退出码，允许进程继续运行至自然退出         |

`return 表达式` 先求值，再返回；`process.exit()` 不会返回，所以再写 `return` 没有额外作用。异步函数中的 `return;` 结束函数体；没有后续异常或 `finally` 改变结果时，返回的 Promise 以 `undefined` 完成。

Node.js 通常在事件循环没有需要处理的任务或保持进程存活的资源时自然退出。`main()` 完成不代表整个进程结束，仅有一个未完成的 Promise 也不一定能保持进程存活。

强制退出不等待异步操作，可能截断尚未写完的标准输出。普通 `return` 从 `try` 或 `catch` 返回时会执行对应 `finally`，`process.exit()` 不会按这种方式执行后续清理。

退出码 `0` 通常表示成功，非零表示失败。正常显示帮助后可直接 `return`；出错时如需允许自然退出，可在函数内部使用：

```ts
process.exitCode = 1;
return;
```

**`return` 控制当前函数，`process.exit()` 控制整个进程，`process.exitCode` 设置最终退出码。**
