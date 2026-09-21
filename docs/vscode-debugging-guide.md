# VSCode 断点调试配置指南

本文档记录如何在 VSCode 中对本项目（Node.js + TypeScript）进行断点调试。

原理：你在 `src/*.ts` 上打断点，Node 实际执行的是 `dist/*.js`，两者靠 `tsc` 生成的 `.js.map` 对上。这和 Java 里对 `.java` 打断点、实际跑 `.class` 一样。

## 前置条件

- 用 VS Code **打开仓库根目录** `lcn-agent/`，不要只打开 `src/`。`${workspaceFolder}` 必须指向根目录，否则 `program`、`cwd` 都会找错路径。
- 已执行 `npm install`
- 项目根目录有 `config.toml`；其中的引用由环境变量或可选 `.env` 提供，环境变量优先。
- 新版 VS Code 自带 JavaScript Debugger，一般不用另装

`.vscode/` 已被 `.gitignore` 忽略，`launch.json` 不会提交。每个人在本机创建一份即可。

## 仓库里已经就绪的部分

`tsconfig.json` 已开启 source map，`package.json` 已有编译脚本，这两项不用改：

```json
{
  "compilerOptions": {
    "sourceMap": true,
    "rootDir": "src",
    "outDir": "dist"
  }
}
```

```json
{
  "scripts": {
    "build": "tsc"
  }
}
```

开启 `sourceMap` 后，`tsc` 会在 `dist/` 下生成 `.js.map`。`dist/` 也被 gitignore，第一次调试由 `preLaunchTask` 现场编译。

## 配置步骤

### 1. 创建 `.vscode/launch.json`

左侧 **Run and Debug**（`⇧⌘D`）→ **create a launch.json file** → 选 **Node.js**，把内容改成：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "调试 lcn-agent",
      "type": "node",
      "request": "launch",
      "preLaunchTask": "npm: build",
      "program": "${workspaceFolder}/dist/index.js",
      "cwd": "${workspaceFolder}",
      "sourceMaps": true,
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "skipFiles": ["<node_internals>/**"],
      "console": "integratedTerminal"
    }
  ]
}
```

各字段说明：

| 字段 | 作用 |
|------|------|
| `type` | 调试器类型，Node.js 项目使用 `node` |
| `request` | `launch` 表示启动新进程，`attach` 表示附加到已运行的进程 |
| `preLaunchTask` | 调试前自动执行 `npm run build`（即 `tsc`），确保代码最新 |
| `program` | 要执行的入口文件（编译后的 JS） |
| `cwd` | 设置工作目录；应用从这里读取 `config.toml` 和可选 `.env` |
| `sourceMaps` | 启用 source map，可在 `.ts` 文件中打断点 |
| `outFiles` | 告诉调试器编译输出位置，用来定位 source map |
| `skipFiles` | 单步时跳过 Node 内部实现，避免 `F11` 进运行时源码 |
| `console` | 使用集成终端，支持交互式输入输出 |

`preLaunchTask: "npm: build"` 依赖 VS Code 默认开启的 npm 任务自动检测。若 F5 报找不到任务，用 `⌘⇧P` → `Tasks: Run Task` 确认是否能看到 `npm: build`；或把该项改成 `tsc: build - tsconfig.json`。

### 2. 调试其他 stage 文件（可选）

在 `configurations` 数组中追加，改 `program` 即可。阶段 0 需要命令行参数时用 `args`：

```json
{
  "name": "调试 stage-00",
  "type": "node",
  "request": "launch",
  "preLaunchTask": "npm: build",
  "program": "${workspaceFolder}/dist/stage-00.js",
  "args": ["normal"],
  "sourceMaps": true,
  "outFiles": ["${workspaceFolder}/dist/**/*.js"],
  "skipFiles": ["<node_internals>/**"],
  "console": "integratedTerminal"
}
```

```json
{
  "name": "调试 stage-01",
  "type": "node",
  "request": "launch",
  "preLaunchTask": "npm: build",
  "program": "${workspaceFolder}/dist/stage-01.js",
  "envFile": "${workspaceFolder}/.env",
  "sourceMaps": true,
  "outFiles": ["${workspaceFolder}/dist/**/*.js"],
  "skipFiles": ["<node_internals>/**"],
  "console": "integratedTerminal"
}
```

`args` 取值：`normal`、`cancel`、`error`，对应阶段 0 的三种模式。不需要环境变量的入口可以省略 `envFile`。

## 使用方法

不要用 `npm start` 打断点。那是普通运行，不会进入调试器。必须用下面的 Launch 配置，或在 **JavaScript Debug Terminal** 里再执行 `node dist/index.js`。

1. 打开 `src/` 下的 `.ts` 文件（不要打开 `dist/*.js`）
2. 在**确定会执行**的行，点击行号左侧空白设断点（实心红点），或光标停在该行按 `F9`
3. 打开 Run and Debug，顶部下拉框选 **调试 lcn-agent**
4. 按 `F5`。VS Code 会先跑 `tsc`，再启动 `node dist/index.js`
5. 程序在断点处暂停，那一行高亮。确认标签页停在 `src/*.ts`，而不是 `dist/*.js`
6. 左侧查看变量、监视表达式、调用堆栈；用调试栏控制执行

条件断点：红点上右键 → Edit Breakpoint，例如 `count === 3`。  
只打印不停住：行号右键 → Add Logpoint，例如 `value is {fullText}`。

## 快捷键速查表

> 以下快捷键基于 macOS。Windows/Linux 将 `Cmd` 替换为 `Ctrl`，`Option` 替换为 `Alt`。

### 启动与停止

| 快捷键 | 功能 |
|--------|------|
| `F5` | 启动调试 / 继续执行到下一个断点 |
| `Shift + F5` | 停止调试 |
| `Cmd + Shift + F5` | 重启调试 |

### 执行控制

| 快捷键 | 功能 |
|--------|------|
| `F10` | 单步跳过（Step Over）—— 执行当前行，不进入函数内部 |
| `F11` | 单步进入（Step Into）—— 进入当前行调用的函数内部 |
| `Shift + F11` | 单步跳出（Step Out）—— 执行完当前函数，返回调用处 |

### 断点管理

| 快捷键 | 功能 |
|--------|------|
| `F9` | 切换断点（在当前行添加或移除断点） |
| `Shift + F9` | 内联断点（一行有多个表达式时，选其中一个） |

启用/禁用已有断点（保留位置但不暂停）：在左侧断点列表右键，或 `⌘⇧P` 搜 `Enable/Disable Breakpoint`。该命令默认不一定绑快捷键。

### 面板与视图

| 快捷键 | 功能 |
|--------|------|
| `Cmd + Shift + D` | 打开"运行和调试"侧边栏 |
| `Cmd + Shift + Y` | 打开调试控制台（Debug Console） |
| `` Ctrl + ` `` | 打开/关闭集成终端 |

### 调试控制台

| 快捷键 | 功能 |
|--------|------|
| `Cmd + Shift + Y` | 聚焦调试控制台 |
| 在调试控制台直接输入表达式 | 实时求值（可查看变量值、调用函数等） |

## 断点类型

除了普通断点外，VSCode 还支持以下断点类型（右键断点红点可选择）：

| 类型 | 说明 |
|------|------|
| **条件断点** | 右键行号 > "添加条件断点"，输入条件表达式（如 `i > 10`），仅条件为 true 时暂停 |
| **日志断点** | 右键行号 > "添加日志点"，输入消息模板（如 `value is {variable}`），不暂停，仅在调试控制台打印 |
| **命中次数断点** | 右键行号 > "添加条件断点" > 选"命中次数"，指定触发次数（如 `5`，第 5 次命中时暂停） |
| **异常断点** | 在"运行和调试"面板底部的"断点"区域，勾选"未捕获的异常"或"所有异常" |
| **函数断点** | 在"断点"区域点击 `+`，输入函数名，调用该函数时暂停 |

## 常见问题

### 断点显示为灰色空心圆，无法命中

- 确认断点打在 `src/*.ts`，不是 `dist/*.js`
- 确认打开的是仓库根目录
- 检查 `tsconfig.json` 是否开启了 `"sourceMap": true`
- 检查 `launch.json` 中 `sourceMaps` 和 `outFiles` 是否配置正确
- 确认那一行确实会执行
- 重新编译（`npm run build`）后再 `F5`

### 按 F5 报找不到任务 `npm: build`

VS Code 的 npm 任务自动检测可能被关掉。`⌘⇧P` → `Tasks: Run Task`，若列表里没有 `npm: build`，把 `preLaunchTask` 改成 `tsc: build - tsconfig.json`。

### 暂停后跳进了 `dist/*.js`

source map 没接上。确认 `dist/` 里有对应的 `.js.map`，且 `outFiles` 指向 `dist/**/*.js`。

### 变量显示为 undefined 或不可见

TypeScript 编译优化可能导致部分变量被内联。尝试将变量赋值给一个 `const` 以确保调试器可以捕获。

### 环境变量未加载 / 报缺少 `API_KEY`

确认 `cwd` 指向仓库根目录，并检查 `config.toml` 中引用的变量是否已设置。
主入口由应用加载可选 `.env`，不设置 `envFile`；环境变量优先，空值不会回退到 `.env`。
`stage-xx.ts` 是历史备份，仍沿用原来的配置方式。

### 程序直接跑完、不停在断点

- 用的是 `npm start` 而不是 Launch 配置
- 断点打在不会走到的分支
- 下拉框选错了配置（例如想调 `index.ts` 却选了 stage）
