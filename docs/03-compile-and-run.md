# 第 3 步：配置编译并运行最小程序

这是原推进顺序中“安装 TypeScript，配置编译”的后半部分。

## 当前步骤目标

配置源码和编译输出目录，亲手编写并运行一个最小 TypeScript 程序，验证类型检查的作用。

前置条件：[TypeScript 安装与模块设置](02-install-typescript.md)已通过。

理解下面的运行链路：

```text
TypeScript 源码 → 类型检查与编译 → JavaScript → Node.js 执行
```

TypeScript 类型通常在编译后被擦除，不能代替运行时的数据校验。

## 执行一：配置编译器

在项目根目录创建 `tsconfig.json`，写入：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true,
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"],
    "noEmitOnError": true
  },
  "include": ["src/**/*.ts"]
}
```

| 配置 | 含义 |
| --- | --- |
| `target` | 输出使用 ES2022 级别的 JavaScript 语法 |
| `module` | 按 Node.js 的模块规则处理导入和导出，结合 `"type": "module"` 使用 ESM |
| `strict` | 开启严格类型检查 |
| `rootDir` | 源码根目录为 `src` |
| `outDir` | 编译结果输出到 `dist` |
| `types` | 加载 Node.js 的类型声明 |
| `noEmitOnError` | 有编译错误时，不生成新的 JavaScript |
| `include` | 将 `src` 下的 TypeScript 文件纳入编译 |

## 执行二：亲手编写最小入口

如果尚未创建源码目录，执行：

```bash
mkdir src
```

由学习者创建 `src/index.ts`，完成两个动作：

1. 声明一个明确标注为 `string` 类型的变量，内容自行决定。
2. 用 `console.log()` 输出它。

这里不提供完整实现，先自行尝试，不加入异步、工具或模型。

## 执行三：编译并运行

在项目根目录执行：

```bash
npx tsc
node dist/index.js
```

第一条命令读取 `tsconfig.json` 并编译源码；第二条命令运行生成的 JavaScript。

## 验证：观察类型检查

1. 确认终端输出了你设置的字符串。
2. 打开 `dist/index.js`，与源码比较，观察类型标注是否还存在。
3. 将源码中字符串变量的赋值改为数字，保留 `string` 类型标注，然后执行：

   ```bash
   npx tsc --noEmit
   ```

4. 记录类型错误信息，再将赋值改回字符串。
5. 再次执行 `npx tsc --noEmit`，确认类型检查通过。

`--noEmit` 表示只检查、不生成文件。
编译失败不会删除此前生成的 `dist/index.js`，因此旧文件仍能运行，不能据此判断新代码编译成功。

通过标准：

- 终端能输出你设置的字符串。
- 生成的 JavaScript 中没有 TypeScript 类型标注。
- 数字赋给字符串变量时报错，修正后检查通过。
- 能说明编译和运行分别由哪个命令完成。

## 提交反馈与当前进度

请将以下内容交给指导者检查：

- `src/index.ts` 的代码。
- 正常运行时的输出。
- 数字赋给字符串变量时的类型错误信息。

本步已给出指导，尚未收到上述验证结果，暂不标记通过。
完成后再进入事件类型的学习：用联合类型描述文本事件和工具事件。
