# TypeScript 与 JavaScript 学习笔记

本文保留早期代码的学习示例。文中提到的 `src/ai`、`packages/ai` 和 `learning-materials` 已不在当前仓库中，相关路径仅记录历史来源；代码片段用于解释语言机制，不代表当前项目结构或可直接执行的入口。当前目录与运行方式见[项目说明](../../README.md)。

## 1. TypeScript 非空断言运算符（`!`）

在表达式后添加 `!`，表示向 TypeScript 编译器断言：该表达式的结果不会是 `null` 或 `undefined`。编译器会从表达式的类型中排除这两种类型。

例如，历史示例 `src/ai/utils/event-stream.ts` 中有以下代码：

```ts
while (this.incoming.length > 0) {
  this.outcoming.push(this.incoming.pop()!);
}
```

数组的 `pop()` 方法返回类型为 `T | undefined`，因为空数组调用 `pop()` 会返回 `undefined`。这里先通过 `this.incoming.length > 0` 确认数组非空，再调用 `pop()`，因此不会因数组为空而返回 `undefined`。

TypeScript 不会根据这里的数组长度检查自动排除 `pop()` 返回类型中的 `undefined`，所以代码使用后缀 `!` 进行非空断言。

**非空断言只影响类型检查，不会生成运行时检查，也不会改变实际值。** 如果断言不成立，实际结果仍然可能是 `null` 或 `undefined`。此外，数组非空只保证存在元素，不保证元素本身不是空值；如果 `T` 允许空值，仍需结合实际数据判断。

注意区分：后缀 `value!` 是 TypeScript 的非空断言，前缀 `!value` 是 JavaScript 的逻辑取反。

## 2. JavaScript 剩余参数与展开语法（`...`）

### 2.1 语法来源

剩余参数（Rest Parameters）是 JavaScript 在 ES2015（ES6）中引入的语法。它自动将剩余的实参收集为数组，可以理解为简化参数收集的语法糖。TypeScript 在此基础上增加类型标注。

以数组 `push()` 的 TypeScript 方法签名为例：

```ts
push(...items: T[]): number;
```

| 部分       | 含义                                                         |
| ---------- | ------------------------------------------------------------ |
| `...items` | JavaScript 剩余参数，收集传入的零个或多个参数                |
| `: T[]`    | TypeScript 类型标注，收集得到的数组中每个元素的类型为 `T`    |
| `: number` | TypeScript 返回值类型标注；`push()` 返回添加元素后的数组长度 |

### 2.2 剩余参数：声明时收集

`...items: T[]` 表示可以分别传入多个 `T` 类型的参数，并不要求调用方传入一个 `T[]` 数组。

```ts
const numbers: number[] = [];

numbers.push(1); // 传入一个元素，返回 1，数组变为 [1]
numbers.push(2, 3); // 传入两个元素，返回 3，数组变为 [1, 2, 3]
numbers.push(); // 不传元素，返回 3，数组保持不变
```

自定义函数也可以使用剩余参数：

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

sum(1, 2, 3); // 函数内部 values 为 [1, 2, 3]，返回 6
sum(); // 函数内部 values 为 []，返回 0
```

剩余参数必须位于参数列表的最后，一个函数只能有一个剩余参数。它得到的是真正的数组，可以直接使用数组方法。早期 JavaScript 常用 `arguments` 处理数量不固定的参数，但 `arguments` 是类数组对象，包含所有实参；剩余参数只收集其位置之后的实参，且箭头函数也支持剩余参数。

### 2.3 展开语法：调用时展开

如果已经有一个数组，想把它的元素分别作为参数传入，可以在调用时使用展开语法（Spread Syntax）：

```ts
const numbers: number[] = [1, 2, 3];
const moreNumbers: number[] = [4, 5];

numbers.push(...moreNumbers); // 相当于 numbers.push(4, 5)
// numbers 变为 [1, 2, 3, 4, 5]，返回值为 5
```

这里的 `...moreNumbers` 将数组展开成多个参数；方法声明中的 `...items` 则把多个参数收集为数组。

### 2.4 普通数组参数与剩余参数的区别

| 参数声明             | 调用时传入的内容 | 调用示例                                    |
| -------------------- | ---------------- | ------------------------------------------- |
| `items: number[]`    | 一个数字数组     | `method([1, 2, 3])`                         |
| `...items: number[]` | 零个或多个数字   | `method(1, 2, 3)` 或 `method(...[1, 2, 3])` |

对于 `number[]` 数组，直接调用 `numbers.push([4, 5])` 会产生类型错误，因为传入的是 `number[]`，而每个参数要求为 `number`。如果接收数组的元素类型本身就是数组，例如 `number[][]`，则可以直接 `push()` 一个 `number[]`。

### 2.5 对应历史示例中的用法

历史示例 `src/ai/utils/event-stream.ts` 中：

```ts
this.outcoming.push(this.incoming.pop()!);
```

执行顺序为：

1. `this.incoming.pop()` 取出并移除数组最后一个元素。
2. 后缀 `!` 在类型检查时排除 `null` 和 `undefined`，不改变运行时的值。
3. 将这个元素作为一个参数传给 `this.outcoming.push()`。
4. `push()` 将元素添加到 `this.outcoming` 末尾，返回新的数组长度；这里没有使用返回值。

复习要点：**声明时的 `...` 用于收集，调用时的 `...` 用于展开；`push(...items: T[])` 接收多个元素，不要求传入一个数组。**

## 3. 异步可迭代接口 `AsyncIterable` 与生成器

### 3.1 `AsyncIterable` 是接口

`AsyncIterable<T>` 是 TypeScript 接口，用于描述可以逐个异步获取 `T` 类型元素的对象。它要求对象提供 `[Symbol.asyncIterator]()` 方法，该方法返回异步迭代器。

历史示例中的声明为：

```ts
class EventStream<T, R = T> implements AsyncIterable<T>
```

其中，`EventStream` 是类，`implements AsyncIterable<T>` 表示该类遵守异步可迭代协议。接口只在类型检查时起作用，运行时的行为由实际方法实现。

事件可能陆续到达，读取下一个事件时允许等待，所以可以使用异步遍历：

```ts
// stream 表示已有的 EventStream 实例；代码位于允许使用 await 的上下文中。
for await (const event of stream) {
  console.log(event);
}
```

等待事件不会阻塞 JavaScript 线程，其他任务仍然可以执行。

### 3.2 `AsyncIterable`、`AsyncIterator` 与 `IteratorResult`

| 类型                | 职责               | 核心内容                        |
| ------------------- | ------------------ | ------------------------------- |
| `AsyncIterable<T>`  | 提供异步迭代入口   | `[Symbol.asyncIterator]()` 方法 |
| `AsyncIterator<T>`  | 逐次请求下一个元素 | `next()` 方法，返回 Promise     |
| `IteratorResult<T>` | 描述一次读取的结果 | `value` 和 `done` 字段          |

手动读取的核心过程为：

```ts
const iterator = stream[Symbol.asyncIterator]();
const result = await iterator.next();
```

迭代结果的典型形式为：

```ts
{ value: event, done: false }     // 取得一个元素，迭代尚未结束
{ value: undefined, done: true }  // 迭代结束，且没有结束返回值
```

`done: true` 表示整个迭代结束。如果只是暂时没有事件，应让读取的 Promise 保持等待，而不是返回结束结果。结束结果的 `value` 也可以携带生成器的最终返回值，但 `for await...of` 不会将它作为普通元素交给循环体。

### 3.3 生成器声明中的 `*`

生成器（Generator）是可以暂停执行、之后从暂停位置继续执行的函数。普通函数通过 `function` 声明，生成器函数通过 `function*` 声明。

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

const iterator = createSequence(); // 创建生成器对象，函数体尚未执行

iterator.next(); // { value: 10, done: false }
iterator.next(); // { value: 20, done: false }
iterator.next(); // { value: "结束", done: true }
iterator.next(); // { value: undefined, done: true }
```

| 操作            | 行为                                        |
| --------------- | ------------------------------------------- |
| 调用生成器函数  | 创建生成器对象，暂不执行函数体              |
| 第一次 `next()` | 开始执行，到第一个 `yield` 暂停             |
| 后续 `next()`   | 从暂停位置继续执行，保留局部变量和执行进度  |
| `yield value`   | 交出一个值，暂停，产生 `done: false` 的结果 |
| `return value`  | 结束生成器，产生 `done: true` 的结果        |
| 执行到函数末尾  | 结束生成器，结束值为 `undefined`            |

`Generator<number, string, unknown>` 的三个类型参数依次描述 `yield` 产生的值、`return` 返回的值、`next(value)` 传入的值。`function*` 和 `yield` 属于 JavaScript 语法，`Generator<...>` 属于 TypeScript 类型标注。

生成器对象同时具备迭代器和可迭代对象的能力，可以直接用于 `for...of`。循环只处理 `done: false` 的元素，所以上例遍历时只得到 10 和 20，不会得到结束返回值“结束”。

### 3.4 `next(value)` 可以向生成器传值

`yield` 是表达式：它向外交出值，恢复执行时还可以取得下一次 `next(value)` 传入的值。

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

iterator.next(); // { value: 1, done: false }
iterator.next(5); // { value: 10, done: false }
iterator.next(); // { value: undefined, done: true }
```

第一次执行 `const input = yield 1` 时，先交出 1 并暂停，赋值尚未完成。随后调用 `next(5)`，`yield 1` 表达式取得 5，完成 `input = 5`，再继续计算。

第一次 `next()` 用于启动生成器，此时尚没有暂停中的 `yield`，所以第一次调用传入的值会被忽略。历史示例中的 `EventStream` 没有使用向生成器传值的能力。

### 3.5 异步生成器与 `async *[Symbol.asyncIterator]()`

| 特性                   | 同步生成器   | 异步生成器                      |
| ---------------------- | ------------ | ------------------------------- |
| 函数声明               | `function*`  | `async function*`               |
| `next()` 返回值        | 迭代结果对象 | Promise，完成后得到迭代结果对象 |
| 函数体能否使用 `await` | 不能         | 能                              |
| 常用遍历方式           | `for...of`   | `for await...of`                |

历史示例中的方法声明为：

```ts
async *[Symbol.asyncIterator](): AsyncIterator<T>
```

| 部分                     | 含义                                            |
| ------------------------ | ----------------------------------------------- |
| `async`                  | 声明异步行为，可以使用 `await`                  |
| `*`                      | 声明生成器，可以使用 `yield`                    |
| `[Symbol.asyncIterator]` | 计算属性名，方法的键是异步迭代协议指定的 Symbol |
| `: AsyncIterator<T>`     | TypeScript 标注返回对象具备异步迭代器能力       |

类方法声明省略 `function`，所以 `*` 直接放在方法名前。JavaScript 自动创建的异步生成器对象已经具有 `next()`、`return()` 和 `throw()` 等方法，因此这里不需要手写 `next()`。

`await` 用于等待数据准备完成；`yield` 用于交出数据并暂停，等待后续读取请求。

### 3.6 `Symbol.asyncIterator`：标准异步迭代入口

`Symbol.asyncIterator` 是 JavaScript 内置的众所周知的 Symbol（well-known symbol），用于标识对象的异步迭代入口。它本身是 Symbol 值，不是函数，也不负责执行异步任务。

JavaScript 对象的属性键可以是字符串，也可以是 Symbol。例如：

```ts
const key = Symbol("说明");
const object = {
  [key]: 123,
};

console.log(object[key]); // 123
```

每次调用 `Symbol()` 都会创建不同的 Symbol，即使描述文字相同也不相等：

```ts
Symbol("说明") === Symbol("说明"); // false
```

`Symbol.asyncIterator` 则是语言提供的标准键，对象和运行机制使用同一个约定来识别异步迭代方法，无需自行创建。

**方括号表示计算属性名。** 在历史示例的方法声明中，先求出 `Symbol.asyncIterator` 的值，再将它作为方法的键：

```ts
async *[Symbol.asyncIterator](): AsyncIterator<T>
```

读取和调用方法的区别为：

```ts
stream[Symbol.asyncIterator]; // 取得以该 Symbol 为键的方法
stream[Symbol.asyncIterator](); // 调用方法，取得异步迭代器
```

括号 `()` 调用的是 `stream` 上的方法，不是 `Symbol.asyncIterator` 本身。

当执行 `for await...of` 时，JavaScript 会查找对象的 `[Symbol.asyncIterator]` 方法，并调用它取得异步迭代器，然后逐次调用迭代器的 `next()`。普通字符串方法名 `asyncIterator`，或者自己创建的 `Symbol("asyncIterator")`，都不能替代这个标准键。

如果对象没有提供异步迭代方法，`for await...of` 还会尝试同步迭代入口 `Symbol.iterator`，并适配为异步读取，因此也可以遍历普通数组。如果两种入口都不存在，则不能通过这种方式遍历。

| 部分                     | 职责                                                     |
| ------------------------ | -------------------------------------------------------- |
| `[Symbol.asyncIterator]` | 标识异步迭代入口，让语言运行机制找到方法                 |
| `async *`                | 声明异步生成器，自动创建具有 `next()` 等方法的生成器对象 |
| `yield`                  | 交出一个元素并暂停，生成未结束的迭代结果                 |
| `AsyncIterator<T>`       | TypeScript 对返回对象能力及元素类型的约束                |

复习要点：**`Symbol.asyncIterator` 负责找到入口，`async *` 负责生成迭代器，`yield` 负责交出元素。** 异步迭代入口也可以通过普通方法手动返回迭代器，并不强制使用生成器；历史示例选择生成器来简化实现。

### 3.7 `for await...of` 的核心读取流程

下面代码展示核心过程，`stream` 表示已有的实例：

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

这段代码用于理解逐次读取。实际 `for await...of` 还会处理提前退出时的迭代器关闭，例如执行 `break` 时会尝试调用迭代器的 `return()`，并等待关闭完成。迭代器关闭是否能取消底层事件等待，取决于具体实现，不能仅凭接口推断。

### 3.8 `EventStream` 中的事件读取流程

当前实现先检查 `this.done`，再检查队列，最后进入等待：

1. 如果 `this.done` 为 `true`，执行 `return`，结束生成器。
2. 如果队列中有事件，执行 `yield this.queue.dequeue()!`，交出一个事件并暂停。
3. 消费者再次调用 `next()`，生成器恢复执行，进入下一轮循环。
4. 如果队列为空，创建内部 Promise，将它的 `resolve` 保存到 `waiting`，通过 `await` 等待。
5. `push(event)` 取出等待者并调用它，内部 Promise 完成。
6. 生成器检查内部结果的 `done`：结束则执行 `return`，否则执行 `yield result.value`。

外层的 `while (true)` 不会一次性输出所有事件：执行到 `yield` 就暂停，执行到未完成的 `await` 就等待。

### 3.9 `{ value, done }` 在哪里设置：区分两层结果

**消费者调用 `next()` 后得到的结果，由 JavaScript 生成器机制自动构造；内部等待 Promise 的结果，由示例代码显式构造。**

队列已有事件时，代码执行：

```ts
yield this.queue.dequeue()!;
```

如果出队的值是 `event`，生成器机制让本次 `next()` 的 Promise 完成为 `{ value: event, done: false }`。这里无需显式编写结果对象。

队列为空时，代码创建内部等待 Promise，并保存它的 `resolve`：

```ts
const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
```

之后 `push(event)` 中的代码显式设置内部结果：

```ts
const waiter = this.waiting.dequeue();
if (waiter) {
  waiter({ value: event, done: false });
  return;
}
```

`waiter` 就是保存的 `resolve`。调用它后，内部 Promise 完成，生成器中的 `result` 取得这个对象。随后执行：

```ts
yield result.value;
```

生成器只交出其中的事件，再由运行机制生成消费者的迭代结果：

```text
push(event)
  → waiter({ value: event, done: false })
  → 内部等待的 Promise 完成
  → result 得到手动构造的对象
  → yield result.value
  → 生成器自动构造迭代结果
  → 消费者的 await iterator.next() 得到 { value: event, done: false }
```

两个结果对象结构相同，但不是同一个对象：前一个用于唤醒内部等待，后一个用于向消费者交付迭代结果。`yield result.value` 也避免了把整个内部结果对象当作事件输出。

`end()` 同样会手动给内部等待者传入 `done: true` 的结果。生成器发现 `result.done` 后执行 `return`，再由生成器机制完成消费者的结束读取。

### 3.10 当前实现的边界与复习要点

- `T` 是异步迭代输出的事件类型；`R` 是 `EventStream` 自行管理的最终业务结果类型。`AsyncIterable<T>` 本身不管理 `R`。
- `result()` 返回 `finalResultPromise`，用于单独读取最终业务结果，与生成器的结束返回值是两种机制。
- 当前实现优先检查 `this.done`，因此结束后不会继续消费队列中尚未交出的事件；这是该实现的行为，协议本身没有要求这样处理。
- `push()` 遇到完成事件时先设置 `this.done`，随后仍会尝试交付该事件。有等待者时会交给一个等待者；没有等待者时会入队，但后续读取会因 `this.done` 而直接结束。
- 完成事件分支只唤醒一个等待者；`end()` 才会遍历并结束所有等待者。
- 记忆链路：**`AsyncIterable` 提供入口，`AsyncIterator` 执行读取，`IteratorResult` 表达结果；`async *` 自动提供迭代器，`yield` 自动生成未结束结果，`return` 自动生成结束结果。**

## 4. TypeScript 类型断言 `as any` 与结束通知

### 4.1 `undefined as any` 的含义

`as` 是 TypeScript 的类型断言语法。`undefined as any` 表示实际值仍然是 `undefined`，但编译器按 `any` 类型检查这个表达式。

| 部分        | 含义                                         |
| ----------- | -------------------------------------------- |
| `undefined` | 运行时的实际值                               |
| `as any`    | 将表达式的静态类型断言为 `any`，放宽类型检查 |

`any` 可以赋给大多数其他类型，因此这种写法会绕过许多类型约束。它不会证明该值符合接收方的要求，也不会改变变量或属性原本声明的类型。

**类型断言不会转换实际值，也不会生成运行时检查。** 编译为 JavaScript 后，`as any` 会被移除。因此以下两句传入的内容在运行时相同：

```ts
waiter({ value: undefined as any, done: true });
waiter({ value: undefined, done: true });
```

### 4.2 对应 `EventStream.end()` 的作用

历史示例中的结束通知为：

```ts
waiter({ value: undefined as any, done: true });
```

- `done: true` 表示迭代结束。
- `value: undefined` 表示没有事件，也没有提供结束返回值。
- `as any` 仅影响 `value` 表达式的类型检查，不负责结束事件流。

`waiter` 是之前保存在 `waiting` 中的 Promise 的 `resolve` 函数。调用它会完成内部等待，让异步生成器恢复执行。

生成器收到结果后先判断：

```ts
if (result.done) {
  return;
}
yield result.value;
```

因为 `result.done` 为 `true`，生成器直接执行 `return`，不会执行后面的 `yield`，也不会把 `undefined` 当作事件交给消费者。

### 4.3 `as any` 是否必须保留

不能仅凭看到 `as any` 就认定它是必需的。应先检查接收方的精确类型，以及项目实际使用的类型定义和编译结果。

对于这段代码，需要确认的是 `IteratorResult<T>` 中 `done: true` 分支允许的 `value` 类型。如果该分支已经允许 `undefined`，直接写 `value: undefined` 即可，无需断言为 `any`。

本次笔记未通过项目编译验证删除该断言的结果，因此没有将“可以直接删除”作为已核实的项目结论。

### 4.4 与非空断言 `!` 的区别

| 写法           | 类型检查中的作用                         | 是否改变实际值 |
| -------------- | ---------------------------------------- | -------------- |
| `value!`       | 从表达式类型中排除 `null` 和 `undefined` | 否             |
| `value as any` | 将表达式视为 `any`，放宽类型检查         | 否             |

例如，`undefined as any` 不会变成一个非空值；`value!` 也不会自动修复实际存在的空值。

复习要点：**`as any` 改变编译器看待表达式的方式，不改变运行时的值；在结束通知中，`done: true` 才表达结束，`undefined` 表达没有返回值。**

## 5. TypeScript 内置工具类型 `Extract`

### 5.1 `Extract` 是类型别名，不是语法关键字

`Extract<T, U>` 是 TypeScript 内置的工具类型，用于从类型 `T` 中提取能赋值给类型 `U` 的成员。常见用途是筛选联合类型中的一部分成员。

| 部分            | 含义                                           |
| --------------- | ---------------------------------------------- |
| `T`             | 待筛选的类型，通常是联合类型                   |
| `U`             | 筛选条件，保留能赋值给它的成员                 |
| `Extract<T, U>` | 筛选得到的类型；没有符合条件的成员时为 `never` |

**`Extract` 本身不是语法关键字，而是基于条件类型实现的内置类型别名。** 它只在类型检查阶段生效，不会生成运行时代码，也不会过滤实际数组或对象。

### 5.2 筛选联合类型

```ts
type Status = "success" | "error" | "loading";

type Result = Extract<Status, "success" | "error">;
// 结果："success" | "error"

type Missing = Extract<Status, "pending">;
// 结果：never
```

`"success"` 和 `"error"` 都能赋值给 `"success" | "error"`，所以保留；`"loading"` 不能，所以排除。第二个示例没有符合条件的成员，结果为 `never`。

### 5.3 条件类型与分布行为

`Extract` 的定义为：

```ts
type Extract<T, U> = T extends U ? T : never;
```

这里的 `T extends U ? T : never` 是**条件类型**语法：如果 `T` 能赋值给 `U`，结果为 `T`；否则为 `never`。这里的 `extends` 用于判断类型的可赋值关系，不表示类继承。

因为条件左侧直接使用类型参数 `T`，当传入联合类型时，条件判断会分布到各个成员上。前面的示例可以理解为：

```text
"success" → 符合条件 → "success"
"error"   → 符合条件 → "error"
"loading" → 不符合条件 → never

合并结果："success" | "error" | never
最终类型："success" | "error"
```

`never` 在联合类型中不会增加任何可取的值，因此结果中只留下符合条件的成员。筛选依据是可赋值关系，不要求两个类型完全相同，例如 `Extract<"success" | 1, string>` 的结果为 `"success"`。

### 5.4 对应历史示例中的用法

历史示例 `packages/ai/src/types.ts` 中，`Content` 的声明为：

```ts
export type Content =
  | { type: "text"; text: string }
  | { type: "refusal"; text: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, JsonValue> };
```

工具调用结束事件中的 `toolCall` 字段使用：

```ts
Extract<Content, { type: "toolCall" }>;
```

这里逐个检查 `Content` 的成员是否能赋值给 `{ type: "toolCall" }`。只有工具调用成员符合条件，因此结果为：

```ts
{
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, JsonValue>;
}
```

筛选条件只写了 `type`，结果仍保留该成员的全部字段。**`Extract` 筛选的是整个类型成员，不是从对象中摘取指定属性。** 对象属性的选择由另一个工具类型 `Pick<T, K>` 表达。

复习要点：**`Extract<T, U>` 保留 `T` 中能赋值给 `U` 的成员；条件类型负责判断，分布行为负责逐个筛选，`never` 表示没有符合条件的成员。**

## 6. TypeScript 泛型参数默认值 `R = T`

### 6.1 `R = T` 的含义

历史示例 `src/ai/utils/event-stream.ts` 中的类声明为：

```ts
export class EventStream<T, R = T> implements AsyncIterable<T>
```

`R = T` 是 TypeScript 的**泛型参数默认值**语法，表示没有指定或推断出 `R` 时，默认使用 `T`。

| 部分                          | 含义                                           |
| ----------------------------- | ---------------------------------------------- |
| `T`                           | 没有默认值的类型参数                           |
| `R = T`                       | 带默认值的类型参数，默认使用前面声明的 `T`     |
| `implements AsyncIterable<T>` | 类遵守异步可迭代协议，迭代输出的元素类型为 `T` |

带默认值的类型参数可以省略；没有默认值的必需类型参数不能放在它后面。默认值可以引用前面已经声明的类型参数，因此这里可以使用 `T` 作为 `R` 的默认值。

### 6.2 省略与显式指定的区别

```ts
// 只指定 T，R 默认也是 string。
type SameTypeStream = EventStream<string>;

// 与上面的写法等价。
type ExplicitSameTypeStream = EventStream<string, string>;

// 显式指定 R 为 number，覆盖默认值。
type DifferentTypeStream = EventStream<string, number>;
```

`EventStream<string>` 中，`T` 和 `R` 都是 `string`；`EventStream<string, number>` 中，`T` 是 `string`，`R` 是 `number`。

**这里的 `=` 设置类型参数的默认值，不是运行时赋值，也不强制 `R` 必须等于 `T`。** 泛型参数会在编译为 JavaScript 时被移除，不会自动创建或转换任何实际值。

调用泛型函数或使用 `new` 创建泛型类实例时，TypeScript 还可以根据实参推断类型参数；默认值在没有指定或推断出对应类型参数时生效。因此，省略类型实参并不意味着一定使用默认值。

### 6.3 `EventStream` 中两个类型参数的职责

| 类型参数 | 历史示例中的用途                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------ |
| `T`      | `push(event: T)` 接收的事件类型，也是异步迭代输出的元素类型                                      |
| `R`      | `extractResult` 从完成事件中提取的业务结果类型，也是 `result()` 返回的 `Promise<R>` 中的结果类型 |

事件和最终结果类型相同时，可以使用默认值，少写一个类型参数；两者不同时，显式指定 `R`。

历史示例中的 `AssistantMessageEventStream` 使用了两个不同的类型：

```ts
export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
>
```

这里 `T` 为 `AssistantMessageEvent`，`R` 为 `AssistantMessage`：迭代时取得事件，调用 `result()` 时取得最终助手消息。由于明确指定了 `R`，不会使用 `R = T` 的默认值。

复习要点：**`R = T` 表示类型参数 `R` 默认使用 `T`；可以省略，也可以显式覆盖，默认值不限制两者必须相同。**

## 7. TypeScript 交叉类型 `string & {}` 与字符串补全

### 7.1 `string & {}` 的含义

历史示例 `src/ai/types.ts` 中的类型声明为：

```ts
export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-codex-responses";

export type Api = KnownApi | (string & {});
```

`string & {}` 使用 TypeScript 的**交叉类型**语法。`&` 要求一个值同时符合两侧的类型；外层的 `|` 则表示允许联合类型中的任意一种类型。

| 部分          | 含义                                             |
| ------------- | ------------------------------------------------ |
| `KnownApi`    | 示例已定义的字符串字面量联合类型                 |
| `string`      | 任意字符串                                       |
| `{}`          | 非 `null`、非 `undefined` 的值，不只表示空对象   |
| `string & {}` | 同时符合 `string` 和 `{}` 的值，仍允许任意字符串 |

字符串本来就符合 `{}` 的要求，所以这里没有增加字符串取值上的限制。数字和布尔值也符合 `{}`，但不符合 `string`，因此不能赋给 `string & {}`。

### 7.2 为什么不直接使用 `KnownApi | string`

如果直接声明：

```ts
type PlainApi = KnownApi | string;
```

`KnownApi` 中的所有字符串字面量已经包含在 `string` 中，因此这个联合类型会被简化为 `string`，编辑器通常不再专门提示这些已知值。

使用 `KnownApi | (string & {})` 可以让 TypeScript 保留已知字面量成员和交叉类型成员的区别。这是一种常用写法，用于**允许任意字符串，同时保留已知字符串的编辑器补全提示**。具体补全展示取决于编辑器、TypeScript 版本和使用位置。

| 写法       | 是否接受任意字符串   | 已知值的补全提示 |
| ---------- | -------------------- | ---------------- |
| `KnownApi` | 否，只接受已定义的值 | 保留             |
| `KnownApi  | string`              | 是               | 通常因简化为 `string` 而丢失 |
| `KnownApi  | (string & {})`       | 是               | 通常保留                     |

### 7.3 使用示例与边界

```ts
// 示例已定义的值，可以获得补全提示。
const known: Api = "openai-responses";

// 示例自定义值，也符合 Api 的类型要求。
const custom: Api = "custom-api";
```

`"custom-api"` 只是展示类型行为的示例，不代表项目已经实现了对应接口。由于 `Api` 允许任意字符串，已知接口名称的拼写错误也可能通过类型检查；补全提示不等于限制只能使用已知值。

**`string & {}` 只影响类型检查和编辑器体验，不会生成运行时检查，也不会把字符串转换成对象。** 实际接口是否受支持，仍由运行时代码决定。

复习要点：**`&` 表示同时符合两侧类型；`string & {}` 仍接受任意字符串，在与字符串字面量联合使用时，可保留已知值的补全提示。**

## 8. JavaScript 三元运算符与对象条件展开

### 8.1 条件添加对象属性

历史示例 `learning-materials` 中，创建 OpenAI SDK 客户端的配置包含：

```ts
...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
```

这行代码表示：**如果 `config.fetchImpl` 为真值，就向当前配置对象添加 `fetch` 属性；否则不添加任何属性。** 它组合了 JavaScript 的三元运算符和对象展开语法，不是 TypeScript 特有的类型语法。

| 部分                            | 含义                                       |
| ------------------------------- | ------------------------------------------ |
| `config.fetchImpl`              | 三元运算符的判断条件，按真值或假值选择分支 |
| `? { fetch: config.fetchImpl }` | 条件为真值时，创建带有 `fetch` 属性的对象  |
| `: {}`                          | 条件为假值时，创建空对象                   |
| `...`                           | 将选中对象自身可枚举的属性展开到当前对象中 |

### 8.2 先选择对象，再展开属性

执行时先计算括号中的三元表达式，再展开所得对象的属性。

```ts
// config.fetchImpl 为真值时，选中并展开：
...{ fetch: config.fetchImpl }

// config.fetchImpl 为假值时，选中并展开：
...{}
```

上面的片段用于展示展开来源，需要放在对象字面量中使用。第一种情况添加 `fetch` 属性，属性值为 `config.fetchImpl`；第二种情况中，空对象没有属性可供展开，因此不会添加属性。

三元运算符检查的是真值，而不只是判断是否为 `undefined`。普通函数是真值；`undefined`、`null`、`false`、`0` 和空字符串等是假值。

### 8.3 对应历史示例中的配置

历史示例中传给 `new OpenAI(...)` 的配置对象为：

```ts
{
  apiKey: config.apiKey,
  baseURL: config.baseUrl,
  timeout: config.timeoutMs ?? 60000,
  maxRetries: 0,
  ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
}
```

提供自定义请求函数时，配置对象增加 `fetch: config.fetchImpl`，将该函数传给 OpenAI SDK。条件为假值时，配置对象只有前面显式声明的属性，不包含 `fetch` 属性。

对象展开只复制属性值，不会调用 `config.fetchImpl`；这里传递的是函数本身，而不是函数执行后的结果。

### 8.4 省略属性与设置为 `undefined` 的区别

下面两种写法并不产生完全相同的对象结构：

```ts
const omitted = {};
const present = { fetch: undefined };

"fetch" in omitted; // false，属性不存在。
"fetch" in present; // true，属性存在，值为 undefined。
```

所以条件展开中的 `...{}` 表示省略属性，而不是添加 `fetch: undefined`。接收方如何处理这两种情况，取决于具体实现。

这里的 `{}` 是运行时创建的空对象；第 7 节 `string & {}` 中的 `{}` 则位于类型位置，表示类型。相同符号在不同上下文中用途不同。

复习要点：**三元运算符先选择要展开的对象，`...` 再复制它的属性；选择空对象就不添加属性，选择 `{ fetch: config.fetchImpl }` 就添加 `fetch`。**

## 9. Node.js 中 `return`、`process.exit()` 与退出码

### 9.1 结束函数与终止进程

**`return` 只结束当前函数；`process.exit(1)` 立即终止整个 Node.js 进程，并将退出码设置为 `1`。**

| 写法                      | 实际效果                                                |
| ------------------------- | ------------------------------------------------------- |
| `return;`                 | 结束当前函数，不主动终止进程，也不设置退出码            |
| `process.exit(1);`        | 强制终止整个进程，以退出码 `1` 表示失败                 |
| `return process.exit(1);` | 先调用 `process.exit(1)` 终止进程，前面的 `return` 多余 |
| `process.exitCode = 1;`   | 设置退出码，不立即终止进程                              |

`return 表达式` 会先求出表达式的值，再从函数返回。但 `process.exit()` 不会返回，因此 `return process.exit(1)` 的效果与直接调用 `process.exit(1)` 相同。

对于历史示例中的 `async function main(): Promise<void>`，执行 `return;` 会结束函数体；如果没有需要继续执行的 `finally` 或其他异常，返回的 Promise 会以 `undefined` 完成。其他任务仍然可以继续执行。

### 9.2 自然退出与强制退出

`main()` 结束不代表整个进程立即结束。Node.js 通常会在事件循环没有需要继续处理的任务或保持进程存活的资源时自然退出；仅有一个未完成的 Promise，并不一定能让进程继续存活。

`process.exit()` 则不等待尚未完成的异步操作。标准输出也可能采用异步写入，因此紧接在 `console.log()` 后强制退出，可能导致输出尚未写完就被截断。

普通 `return` 从 `try` 或 `catch` 返回时，仍会执行对应的 `finally`；`process.exit()` 强制退出不会按这种方式执行后续的 `finally` 清理。

退出码 `0` 通常表示成功，非零退出码表示失败。`return` 本身不改变退出码；没有设置失败退出码、也没有其他导致失败的情况时，进程自然退出通常使用 `0`。

### 9.3 对应历史示例中的场景列表

历史示例 `learning-materials` 的 `main()` 中：

```ts
const scenario = process.argv[2] ?? "list";
if (scenario === "list" || scenario === "--help") {
  console.log("Chat Completions 场景：" + Object.keys(scenarios).join("、"));
  return;
}
```

显示场景列表或帮助属于正常行为，因此输出后直接 `return`，结束入口函数即可，无需设置失败退出码。

如果遇到错误，需要报告失败并允许进程自然退出，可以在函数内部使用：

```ts
process.exitCode = 1;
return;
```

复习要点：**`return` 管当前函数，`process.exit()` 管整个进程，`process.exitCode` 只设置最终退出码。**

## 10. Node.js ES 模块的入口文件判断

### 10.1 判断当前文件是否为启动入口

历史示例 `learning-materials` 的 `main()` 开头为：

```ts
if (!process.argv[1] || import.meta.url !== pathToFileURL(resolve(process.argv[1])).href) {
  return;
}
```

这段代码表示：**没有入口文件路径，或者当前模块的 URL 与入口文件路径转换后的 URL 不同，就结束 `main()`。** 这样可以在文件被其他模块导入时跳过命令行入口逻辑。

### 10.2 各部分的含义

| 部分                       | 含义                                                   |
| -------------------------- | ------------------------------------------------------ |
| `process.argv[0]`          | Node.js 可执行文件的路径                               |
| `process.argv[1]`          | 通过文件启动时的入口文件路径                           |
| `process.argv[2]`          | 入口文件之后的第一个命令行参数；历史示例用它读取场景名 |
| `import.meta.url`          | 当前 ES 模块的完整 URL；本地文件模块使用 `file://` URL |
| `resolve(process.argv[1])` | 将入口文件路径解析为绝对路径                           |
| `pathToFileURL(...)`       | 将文件系统路径转换为 URL 对象，处理路径中的特殊字符    |
| `.href`                    | 取得 URL 对象的完整 URL 字符串                         |
| `!==`                      | 严格不相等比较；两边 URL 字符串不同时返回 `true`       |

`resolve` 来自 `node:path`，`pathToFileURL` 来自 `node:url`。它们将入口文件路径转换成与 `import.meta.url` 相同的 URL 表示形式，避免直接拿文件系统路径与 URL 比较。

前面的 `!process.argv[1]` 使用逻辑取反检查入口路径。`||` 会短路：入口路径不存在时，左侧已经为 `true`，不会继续执行右侧的路径转换。

### 10.3 直接执行与被导入的区别

| 情况                                          | 当前模块与入口文件的关系 | 判断结果                          |
| --------------------------------------------- | ------------------------ | --------------------------------- |
| 直接执行当前文件，且两边转换后的 URL 一致     | 当前模块就是启动入口     | 条件为 `false`，继续执行 `main()` |
| 由另一个入口文件导入当前文件，且两边 URL 不同 | 当前模块是被导入的模块   | 条件为 `true`，执行 `return`      |
| 没有 `process.argv[1]`                        | 缺少可用于比较的入口路径 | 条件为 `true`，执行 `return`      |

这个判断比较的是 URL 字符串。`resolve()` 不会解析符号链接，因此它不保证不同路径写法指向同一个物理文件时也能识别为相同入口。

### 10.4 入口判断与调用 `main()` 是两件事

条件写在 `main()` 内部，只有调用 `main()` 后才会执行。仅声明函数不会自动运行入口逻辑。

历史示例 `learning-materials` 在文件末尾通过以下代码启动入口：

```ts
await main();
```

调用负责启动函数，入口判断负责决定是否继续运行场景。即使导入模块时执行了这句调用，入口判断也可以让 `main()` 提前返回。

复习要点：**`import.meta.url` 表示当前模块，`process.argv[1]` 表示启动入口；先将路径转换为 URL，再比较是否相同。**

## 11. TypeScript 工具类型 `Record` 与场景函数映射

### 11.1 `Record` 的作用

**`Record<键类型, 值类型>` 用于描述对象的键类型和值类型。** 它是 TypeScript 内置的工具类型，不是独立的语法关键字；可以把它理解为一种简化对象类型声明的写法。

例如，下面的类型表示字符串键对应数字值：

```ts
Record<string, number>;
```

等价的字符串索引签名写法为：

```ts
{
  [key: string]: number;
}
```

这两段都是类型表达式，不会创建实际对象。

### 11.2 指定键名与任意字符串键的区别

如果键类型是字符串字面量联合，`Record` 会要求对象包含这些指定属性：

```ts
Record<"plain" | "stream", number>;
```

等价于：

```ts
{
  plain: number;
  stream: number;
}
```

这里的数字值只用于展示类型规则，不代表项目场景函数的实际类型。`plain` 和 `stream` 都是必需属性，但这个类型本身不保证对象在运行时没有其他属性。

| 键类型   | 对象类型的含义                                       |
| -------- | ---------------------------------------------------- |
| `string` | 使用字符串索引签名约束属性值，不指定必须存在的场景名 |
| `"plain" | "stream"`                                            | 要求包含 `plain` 和 `stream`，并约束两者的值类型 |

### 11.3 拆解历史示例中的 `ScenarioMap`

历史示例 `learning-materials` 中的声明为：

```ts
type ScenarioMap = Record<string, (config: DemoConfig) => Promise<unknown>>;
```

它给“场景名称对应异步场景函数”的对象结构定义了类型别名。

| 部分                     | 含义                                                  |
| ------------------------ | ----------------------------------------------------- |
| `type ScenarioMap = ...` | 定义名为 `ScenarioMap` 的类型别名                     |
| `Record<string, ...>`    | 对象的键使用字符串，属性值符合第二个类型参数          |
| `(config: DemoConfig)`   | 每个场景函数接收名为 `config`、类型为 `Config` 的参数 |
| `=> Promise<unknown>`    | 函数返回 Promise，其完成结果按 `unknown` 类型处理     |

等价的写法为：

```ts
type ScenarioMap = {
  [name: string]: (config: DemoConfig) => Promise<unknown>;
};
```

这里的 `=>` 位于类型声明中，描述函数的参数和返回值，不是在创建箭头函数。

### 11.4 `Promise<unknown>` 的含义

`Promise<unknown>` 表示异步完成后的结果类型是 `unknown`。它没有规定结果必须是文本、数字或某个具体对象，也不表示结果一定为空。

调用方可以通过 `await` 取得结果，但若要读取其具体属性或调用方法，需要先检查或缩小类型。它与 `any` 不同：`unknown` 不允许未经检查就任意操作结果。

这个返回类型让不同场景可以返回不同结构的结果，而入口可以统一等待它们完成。

### 11.5 类型约束与运行时检查

`Record`、类型别名和函数类型都只在类型检查阶段起作用，不会生成对象、调用场景函数或检查运行时数据。

尤其是 `Record<string, ...>`，它不保证任意字符串对应的属性都实际存在。项目入口仍通过 `Object.hasOwn(scenarios, scenario)` 检查场景名，不能只凭类型声明就认为场景存在。

复习要点：**`Record` 简洁地表达键和值的类型；`ScenarioMap` 的键是场景名，值是接收 `Config` 并返回 Promise 的函数。类型声明不替代运行时存在性检查。**

## 12. TypeScript `satisfies` 与上下文类型推断

### 12.1 `satisfies` 的语法和作用

`satisfies` 是 TypeScript 4.9 引入的类型校验运算符，语法为：

```ts
表达式 satisfies 类型;
```

**它检查表达式是否符合目标类型，同时保留表达式自身的具体类型信息，而不是直接把表达式的类型替换为目标类型。**

例如，下面是用于说明语法的数字配置对象，不是项目的场景实现：

```ts
const timeoutMs = {
  plain: 60000,
  stream: 60000,
} satisfies Record<string, number>;
```

编译器检查属性值是否为数字，同时仍知道对象具体包含 `plain` 和 `stream`。若把其中一个值改为字符串，会产生类型错误。

### 12.2 为什么 `plain(config)` 不写参数类型也能推断

历史示例 `learning-materials` 的 `scenarios` 对象末尾使用：

```ts
} satisfies ScenarioMap;
```

而 `ScenarioMap` 的定义为：

```ts
type ScenarioMap = Record<string, (config: DemoConfig) => Promise<unknown>>;
```

目标类型为对象方法提供了**上下文类型**。因此，方法声明中的 `async plain(config)` 即使没有显式写 `config: DemoConfig`，编译器也能根据外层约束推断出参数类型。

```text
satisfies ScenarioMap
  → 对象的属性值应符合场景函数类型
  → 场景函数接收 DemoConfig 参数
  → plain(config) 中的 config 被推断为 DemoConfig
```

推断依据是外层类型，不是参数名 `config`，也不是靠方法体中读取的属性猜测配置结构。

### 12.3 三种指定参数类型的方式

| 写法                                        | 参数类型的来源                     | 对象的类型信息                         |
| ------------------------------------------- | ---------------------------------- | -------------------------------------- |
| 方法参数写 `config: DemoConfig`             | 参数的显式类型标注                 | 对象和返回类型继续按实现推断           |
| 变量写 `const scenarios: ScenarioMap = ...` | 变量类型为方法提供上下文类型       | 变量整体按 ScenarioMap 使用            |
| 对象末尾写 `satisfies ScenarioMap`          | satisfies 的目标类型提供上下文类型 | 保留具体场景名及各方法推断出的返回类型 |

`satisfies` 会参与上下文类型推断，因此“保留自身类型”不表示目标类型对推断完全没有影响；它不会像变量类型标注那样，把整个变量统一声明为 `ScenarioMap`。

复习要点：**`satisfies` 检查类型符合性，也能为函数参数提供上下文类型；`google-gemini.ts` 中的 `config` 类型来自 `ScenarioMap`。**

## 13. TypeScript `satisfies` 与类型断言 `as` 的区别

### 13.1 校验符合性与断言类型

**`satisfies` 用来检查“表达式是否符合这个类型”；`as` 用来告诉编译器“按这个类型看待表达式”。**

| 对比项                   | `satisfies`                  | `as`                 |
| ------------------------ | ---------------------------- | -------------------- |
| 主要用途                 | 校验表达式符合目标类型       | 断言表达式的类型     |
| 表达式最终的类型         | 保留自身推断出的具体类型信息 | 按断言的目标类型处理 |
| 是否证明实际运行数据正确 | 否                           | 否                   |
| 是否生成运行时校验代码   | 否                           | 否                   |

`as` 并非完全不做编译期检查：明显不兼容的类型直接断言仍可能报错。但断言被接受不代表实际数据已通过目标类型的完整校验。

### 13.2 对属性信息的影响

下面两个示例分别使用 `satisfies` 和 `as`，应独立阅读。

使用 `satisfies`：

```ts
const timeoutMs = {
  plain: 60000,
} satisfies Record<string, number>;

timeoutMs.plain; // 已知属性，可以访问。
timeoutMs.stream; // 类型错误：对象没有 stream 属性。
```

使用 `as`：

```ts
const timeoutMs = {
  plain: 60000,
} as Record<string, number>;

timeoutMs.stream; // 字符串索引签名允许访问，但运行时得到 undefined。
```

第二种写法将表达式按 `Record<string, number>` 处理，但没有实际添加 `stream` 属性。启用 `noUncheckedIndexedAccess` 时，未声明键的索引读取类型还会包含 `undefined`；无论编译选项如何，运行时缺失属性仍返回 `undefined`。

### 13.3 对应历史示例中的用法

定义 `scenarios` 时使用 `satisfies ScenarioMap`，可以检查各方法是否符合场景函数类型，同时保留具体场景名和实现推断出的返回类型。

参考文件入口中还使用了：

```ts
await (scenarios as ScenarioMap)[scenario]({
  // 本次运行的配置。
});
```

这段是原调用结构的节选，省略了实际配置属性，不是完整可执行示例。`as ScenarioMap` 让对象按字符串索引类型处理，以便通过字符串变量 `scenario` 访问场景方法；调用结果按 `unknown` 类型处理。

这个断言不会检查场景名是否存在。入口在调用前通过 `Object.hasOwn(scenarios, scenario)` 校验场景名，类型断言不能替代这项运行时检查。

`satisfies` 和 `as` 在编译为 JavaScript 后都会被移除，不会转换实际值，也不会修复缺失属性。

复习要点：**定义对象并校验结构时使用 `satisfies`；`as` 改变编译器看待表达式的方式，需要有依据，不能用它替代数据校验。**

## 14. TypeScript 接口声明 `export interface` 与使用方式

### 14.1 `export interface` 的含义

`interface` 是 TypeScript 的接口声明语法，用于描述对象应具备的属性、方法等结构；前面的 `export` 表示导出接口，供其他模块导入并使用。

历史示例 `src/ai/types.ts` 中的定义为：

```ts
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

| 部分                     | 含义                                       |
| ------------------------ | ------------------------------------------ |
| `export`                 | 导出接口，供其他模块使用                   |
| `interface`              | 声明接口，描述数据结构                     |
| `TextContent`            | 接口名称，用作类型                         |
| `type: "text"`           | 必需属性，值只能是字符串字面量 `"text"`    |
| `text: string`           | 必需属性，值必须是字符串                   |
| `textSignature?: string` | 可选属性，可以省略；提供字符串值时符合要求 |

### 14.2 定义接口的作用

接口规定数据结构，让 TypeScript 在开发阶段检查代码是否符合约定，主要用于：

- **检查结构**：发现缺少必需属性、属性类型错误等问题。
- **复用类型**：多个变量、函数参数和返回值可以使用同一个接口，不必重复描述结构。
- **提供编辑器提示**：访问对象时，提示可用属性及其类型。

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

这个示例用于对比正确与错误的类型标注，第二个对象会产生类型错误。

### 14.3 声明后可以直接使用

**接口声明后就能作为类型使用，不需要实现一个类，也不需要创建接口实例。** 对象字面量 `{ ... }` 创建实际对象，接口只负责规定它应符合的结构。

TypeScript 主要按结构判断兼容性：对象符合接口要求即可，不要求对象显式声明自己实现了接口。

| 使用场景                 | 导出与导入要求                                                    |
| ------------------------ | ----------------------------------------------------------------- |
| 同一个模块文件内使用接口 | 直接使用，不需要导入，也不要求导出                                |
| 其他模块使用该接口       | 定义文件通过 `export` 导出，使用文件通过 `import type` 等方式导入 |

接口也可以先引用、后声明。同一作用域中的接口引用不要求按照运行时代码的执行顺序排列。

### 14.4 在其他接口中组合使用

历史示例中的 `AssistantMessage` 接口包含以下属性声明：

```ts
content: (TextContent | ThinkingContent | ToolCall)[];
```

这表示 `content` 是数组，每个元素可以符合 `TextContent`、`ThinkingContent` 或 `ToolCall` 中的一种结构。这里只是在组合类型，没有创建数组或消息对象。

`AssistantMessage` 在文件中位于 `TextContent` 等接口的前面，但可以直接引用这些后续声明的接口。

### 14.5 接口与运行时对象、类的区别

**接口定义约定，实际对象承载数据。** 接口不会创建对象，也不会自动检查运行时收到的接口响应或其他外部数据；编译成 JavaScript 后，接口声明会被移除。

类 `class` 可以提供运行时实现，并通过 `new` 创建实例；接口只描述结构，因此不能执行 `new TextContent()`。类可以通过 `implements` 接受接口约束，但使用接口标注普通对象并不要求定义类。

复习要点：**`interface` 描述结构，`export` 允许其他模块使用；接口可以声明后直接引用，只参与类型检查，不创建对象，也不提供运行时数据校验。**
