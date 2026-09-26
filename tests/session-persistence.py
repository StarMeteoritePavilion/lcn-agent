"""在隔离目录编译并验收当前源码：python3 tests/session-persistence.py。"""
import json
import os
import pty
import queue
import select
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parents[1]
requests = queue.Queue()
tool_definitions = queue.Queue()
started = threading.Event()
release = threading.Event()
tool_requests = 0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global tool_requests
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages = body['messages']
        requests.put(messages)
        tool_definitions.put(body.get('tools'))
        if messages[-1]['content'] == '模型错误验证':
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': {'message': '不应落盘的错误正文'}}).encode())
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        last = messages[-1]
        if last['role'] == 'user' and last['content'] == '等待超时':
            threading.Event().wait(35)
            return
        if last['role'] == 'user' and last['content'] == '等待取消':
            partial = {'choices': [{'index': 0, 'delta': {'content': '未完成的回答'}, 'finish_reason': None}]}
            self.wfile.write(('data: ' + json.dumps(partial) + '\n\n').encode())
            self.wfile.flush()
            started.set()
            release.wait(10)
            return
        if last['role'] == 'user' and last['content'] in ('调用工具', '工具参数错误'):
            tool_requests += 1
            delta = {'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function',
                                    'function': {'name': 'echo', 'arguments': '{"text":"回显"}'}}]}
            if last['content'] == '工具参数错误':
                delta['tool_calls'][0]['function']['arguments'] = '{坏JSON'
            reason = 'tool_calls'
        elif last['role'] == 'user' and last['content'] == '待办工具验证':
            delta = {'tool_calls': [{'index': 0, 'id': 'todo_read_1', 'type': 'function',
                                    'function': {'name': 'todo_list', 'arguments': '{}'}}]}
            reason = 'tool_calls'
        elif last['role'] == 'user' and last['content'] in ('模型新增待办', '模型完成待办'):
            name = 'todo_add' if last['content'] == '模型新增待办' else 'todo_done'
            arguments = '{"text":"审批任务"}' if name == 'todo_add' else '{"id":"1"}'
            delta = {'tool_calls': [{'index': 0, 'id': 'todo_write_1', 'type': 'function',
                                    'function': {'name': name, 'arguments': arguments}}]}
            reason = 'tool_calls'
        elif last['role'] == 'user' and last['content'] == '确认工具验证':
            delta = {'tool_calls': [{'index': 0, 'id': 'confirm_1', 'type': 'function',
                                    'function': {'name': 'delay_echo', 'arguments': '{"text":"确认内容"}'}}]}
            reason = 'tool_calls'
        elif last['role'] == 'user' and last['content'] == '权限拒绝验证':
            delta = {'tool_calls': [{'index': 0, 'id': 'denied_1', 'type': 'function',
                                    'function': {'name': 'denied_probe', 'arguments': '{}'}}]}
            reason = 'tool_calls'
        elif last['role'] == 'user' and last['content'] == '工具超时验证':
            delta = {'tool_calls': [
                {'index': 0, 'id': 'slow_1', 'type': 'function',
                 'function': {'name': 'delay_echo', 'arguments': '{}'}},
                {'index': 1, 'id': 'skipped_2', 'type': 'function',
                 'function': {'name': 'echo', 'arguments': '{"text":"不应执行"}'}}]}
            reason = 'tool_calls'
        elif last['role'] == 'user' and last['content'] == '外部工具验证':
            delta = {'tool_calls': [{'index': 0, 'id': 'upper_1', 'type': 'function',
                                    'function': {'name': 'upper', 'arguments': '{"text":"hello"}'}}]}
            reason = 'tool_calls'
        else:
            delta = {'content': '完整回答\n'}
            reason = 'stop'
        for chunk in [dict(delta=delta, finish_reason=None), dict(delta={}, finish_reason=reason)]:
            self.wfile.write(('data: ' + json.dumps({'choices': [dict(index=0, **chunk)]}) + '\n\n').encode())
        usage = {'choices': [], 'usage': {'prompt_tokens': 7, 'completion_tokens': 1, 'total_tokens': 8}}
        if last['content'] != '用量缺失':
            self.wfile.write(('data: ' + json.dumps(usage) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
children = []
test_env = os.environ.copy()
test_env.pop('LCN_AGENT_EXTENSION', None)

try:
    with tempfile.TemporaryDirectory(prefix='lcn-stage4-') as temporary:
        project = Path(temporary)
        source = project / 'src'
        source.mkdir()
        shutil.copy(root / 'src/index.ts', source / 'index.ts')
        shutil.copytree(root / 'src/core', source / 'core')
        shutil.copytree(root / 'src/extensions', source / 'extensions')
        (project / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
        (project / 'package.json').write_text('{"type":"module"}')
        subprocess.run([str(root / 'node_modules/.bin/tsc'), '--ignoreConfig', '--target', 'ES2022',
                        '--module', 'NodeNext', '--strict', '--outDir', str(project / 'dist'),
                        *map(str, source.rglob('*.ts'))], cwd=project, env=test_env, check=True)
        (project / 'config.toml').write_text(
            f'apiKey = "local-test"\nbaseURL = "http://127.0.0.1:{server.server_port}/v1"\nmodel = "local-test"\n')

        registry_verification = r'''
import assert from "node:assert/strict";
const toolContext = Object.freeze({cwd:process.cwd(), model:"local-test", sessionFile:"test.jsonl",
 callId:"test_call", signal:new AbortController().signal});
import { createToolRegistry } from "./dist/core/tools.js";
import { registerEcho } from "./dist/extensions/echo.js";

const registry = createToolRegistry(() => true);
assert.deepEqual(registry.definitions(), []);
registerEcho({ registerTool: registry.register, registerCommand: registry.registerCommand });
assert.deepEqual(registry.definitions().map((tool) => tool.function.name), ["echo"]);
assert.equal(await registry.execute("echo", { text: "中文回显" }, toolContext), "中文回显");
assert.equal(await registry.execute("echo", { text: "" }, toolContext), "");
for (const args of [null, [], "文本", 1, true, {}, { text: 1 }]) {
  await assert.rejects(() => registry.execute("echo", args, toolContext), /echo 工具参数/);
}
await assert.rejects(() => registry.execute("Echo", { text: "值" }, toolContext), /未知工具: Echo/);
await assert.rejects(() => registry.execute("toString", {}, toolContext), /未知工具: toString/);
assert.throws(() => registerEcho({ registerTool: registry.register, registerCommand: registry.registerCommand }), /工具重名: echo/);
assert.equal(await registry.execute("echo", { text: "原工具仍可用" }, toolContext), "原工具仍可用");

// 实验工具只用于验证新增注册，无需修改核心路由。
let calls = 0;
registry.register({
  definition: {
    type: "function",
    function: { name: "lesson_probe", description: "注册实验", parameters: { type: "object" } },
  },
  execute() {
    calls++;
    throw new Error("实验执行异常");
  },
});
assert.equal(calls, 0);
assert.deepEqual(registry.definitions().map((tool) => tool.function.name), ["echo", "lesson_probe"]);
await assert.rejects(() => registry.execute("lesson_probe", {}, toolContext), /实验执行异常/);
assert.equal(calls, 1);
assert.deepEqual(createToolRegistry(() => true).definitions(), []);
console.log("通过：定义发现、参数校验、未知工具、重名保护、新工具注册、异常传播与实例隔离");
'''
        subprocess.run(['node', '--input-type=module', '-e', registry_verification], cwd=project, env=test_env, check=True)

        lifecycle_verification = r'''
import assert from "node:assert/strict";
const toolContext = Object.freeze({cwd:process.cwd(), model:"local-test", sessionFile:"test.jsonl",
 callId:"test_call", signal:new AbortController().signal});
import { createToolRegistry, mountExtension } from "./dist/core/tools.js";
import { registerEcho } from "./dist/extensions/echo.js";

const registry = createToolRegistry(() => true);
const tool = (name) => ({
  definition: {
    type: "function",
    function: { name, parameters: { type: "object" } },
  },
  execute: () => name,
});
const names = () => registry.definitions().map((entry) => entry.function.name);
const keep = registry.register(tool("keep"));
const unload = mountExtension(registry, registerEcho);
assert.deepEqual(names(), ["keep", "echo"]);
unload();
unload();
assert.deepEqual(names(), ["keep"]);
await assert.rejects(() => registry.execute("echo", {}, toolContext), /未知工具/);

// 旧清理函数不能删除新实例中重新注册的同名工具。
const reload = mountExtension(registry, registerEcho);
unload();
assert.equal(await registry.execute("echo", { text: "新实例" }, toolContext), "新实例");
reload();
for (let i = 0; i < 3; i++) {
  const dispose = mountExtension(registry, registerEcho);
  assert.deepEqual(names(), ["keep", "echo"]);
  dispose();
  assert.deepEqual(names(), ["keep"]);
}

const failure = new Error("初始化失败");
assert.throws(
  () =>
    mountExtension(registry, (api) => {
      api.registerTool(tool("partial"));
      throw failure;
    }),
  (error) => error === failure,
);
assert.deepEqual(names(), ["keep"]);
assert.throws(
  () =>
    mountExtension(registry, (api) => {
      api.registerTool(tool("partial"));
      api.registerTool(tool("keep"));
    }),
  /工具重名: keep/,
);
assert.deepEqual(names(), ["keep"]);
assert.equal(await registry.execute("keep", {}, toolContext), "keep");

let savedApi;
const close = mountExtension(registry, (api) => {
  savedApi = api;
});
close();
assert.throws(() => savedApi.registerTool(tool("late")), /扩展已卸载/);
const remove = registry.register(tool("again"));
remove();
const removeNew = registry.register(tool("again"));
remove();
assert.equal(await registry.execute("again", {}, toolContext), "again");
removeNew();
keep();
assert.deepEqual(names(), []);
// 同一个工具对象复用时，也必须按注册次数隔离清理状态。
const shared = tool("shared");
const oldDispose = registry.register(shared);
oldDispose();
const newDispose = registry.register(shared);
oldDispose();
assert.equal(await registry.execute("shared", {}, toolContext), "shared");
newDispose();
newDispose();
assert.deepEqual(names(), []);
console.log("通过：扩展卸载、三次重载、失败回滚、失效注册拒绝及同一对象重注册隔离");
'''
        subprocess.run(['node', '--input-type=module', '-e', lifecycle_verification], cwd=project, env=test_env, check=True)

        external_verification = r'''
import assert from "node:assert/strict";
const toolContext = Object.freeze({cwd:process.cwd(), model:"local-test", sessionFile:"test.jsonl",
 callId:"test_call", signal:new AbortController().signal});
const context = Object.freeze({
  cwd: process.cwd(), model: "local-test", sessionFile: null, signal: new AbortController().signal,
  ui: Object.freeze({ notify: () => {} }),
});
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createToolRegistry, mountExtension, loadExtension } from "./dist/core/tools.js";
import { registerEcho } from "./dist/extensions/echo.js";
const registry = createToolRegistry(() => true);
const close = mountExtension(registry, registerEcho);
for (let i = 0; i < 3; i++) {
  const dispose = await loadExtension(registry, "dist/extensions/upper.js");
  assert.equal(await registry.execute("upper", { text: "hello" }, toolContext), "HELLO");
  assert.equal(await registry.executeCommand("upper", "hello  world", context), "HELLO  WORLD");
  assert.equal(await registry.execute("echo", { text: "hello" }, toolContext), "hello");
  for (const args of [null, [], {}, {text: 1}]) {
    await assert.rejects(() => registry.execute("upper", args, toolContext), /upper 工具参数/);
  }
  await assert.rejects(loadExtension(registry, "dist/extensions/upper.js"), /命令重名: context/);
  dispose(); dispose();
  await assert.rejects(() => registry.execute("upper", {}, toolContext), /未知工具/);
  await assert.rejects(() => registry.executeCommand("upper", "", context), /未知命令/);
}
for (const [file, source, message] of [
  ["invalid.mjs", "export default 1;", "默认导出注册函数"],
  ["named.mjs", "export function setup() {}", "默认导出注册函数"],
  ["throws.mjs", "throw new Error('模块执行失败');", "模块执行失败"],
  ["partial.mjs", `export default function(api) {
    api.registerTool({definition:{type:"function",function:{name:"partial"}},execute:()=>""});
    throw new Error("注册失败");
  }`, "注册失败"],
  ["missing.mjs", null, "Cannot find module"],
]) {
  if (source !== null) writeFileSync(file, source);
  await assert.rejects(loadExtension(registry, file), error =>
    error.message.includes(resolve(file)) && error.message.includes(message) && error.cause instanceof Error);
  assert.deepEqual(registry.definitions().map(t => t.function.name), ["echo"]);
}
close();
console.log("通过：外部模块加载、参数校验、重名保护、错误定位、失败回滚与三次装载清理");
'''
        subprocess.run(['node', '--input-type=module', '-e', external_verification],
                       cwd=project, env=test_env, check=True)

        command_verification = r'''
import assert from "node:assert/strict";
const context = Object.freeze({
  cwd: process.cwd(), model: "local-test", sessionFile: null, signal: new AbortController().signal,
  ui: Object.freeze({ notify: () => {} }),
});
import { createToolRegistry, mountExtension } from "./dist/core/tools.js";
const r = createToolRegistry(() => true);
const command = { name: "sample", execute: text => text };
for (const name of ["exit", "new", "sessions", "history", "diagnostics", "resume"]) {
  assert.throws(() => r.registerCommand({ ...command, name }), /宿主命令不可覆盖/);
}
for (const name of ["", "/bad", "bad name", "Upper", "1bad"]) {
  assert.throws(() => r.registerCommand({ ...command, name }), /命令名不合法/);
}
const old = r.registerCommand(command);
assert.throws(() => r.registerCommand(command), /命令重名/);
assert.equal(await r.executeCommand("sample", "保留  空格", context), "保留  空格");
old();
const fresh = r.registerCommand(command);
old();
assert.equal(await r.executeCommand("sample", "新注册", context), "新注册");
fresh(); fresh();
await assert.rejects(() => r.executeCommand("sample", "", context), /未知命令/);
let saved;
const failure = new Error("注册中断");
assert.throws(() => mountExtension(r, api => {
  saved = api;
  api.registerTool({ definition: { type: "function", function: {name: "partial"} }, execute: () => "" });
  api.registerCommand(command);
  throw failure;
}), error => error === failure);
assert.deepEqual(r.definitions(), []);
await assert.rejects(() => r.executeCommand("sample", "", context), /未知命令/);
assert.throws(() => saved.registerCommand(command), /扩展已卸载/);
const keep = r.registerCommand(command);
assert.throws(() => mountExtension(r, api => {
  api.registerCommand({ ...command, name: "partial" });
  api.registerCommand(command);
}), /命令重名/);
await assert.rejects(() => r.executeCommand("partial", "", context), /未知命令/);
assert.equal(await r.executeCommand("sample", "原命令", context), "原命令");
keep();
const close = mountExtension(r, api => {
  saved = api;
  api.registerCommand({name: "fail", execute() { throw failure; }});
});
await assert.rejects(() => r.executeCommand("fail", "", context), error => error === failure);
close(); close();
assert.throws(() => saved.registerCommand(command), /扩展已卸载/);
console.log("通过：命令名称与宿主保护、重名、错误传播、混合注册回滚、失效拒绝及清理隔离");
'''
        subprocess.run(['node', '--input-type=module', '-e', command_verification],
                       cwd=project, env=test_env, check=True)

        event_verification = r'''
import assert from "node:assert/strict";
const context = Object.freeze({
  cwd: process.cwd(), model: "local-test", sessionFile: null, signal: new AbortController().signal,
  ui: Object.freeze({ notify: () => {} }),
});
import {createToolRegistry, mountExtension, loadExtension} from "./dist/core/tools.js";
const r = createToolRegistry(() => true);
const event = {type:"agent_end", reason:"completed", round:1};
const order = [];
const a = mountExtension(r, api => api.onAgentEnd(() => order.push(1)));
const b = mountExtension(r, api => api.onAgentEnd(e => { e.round = 99; }));
const c = mountExtension(r, api => api.onAgentEnd(e => { order.push(2); assert.equal(e.round,1); }));
assert.deepEqual(r.emitAgentEnd(event), ["运行结束监听器执行失败"]);
assert.deepEqual(order,[1,2]); assert.equal(event.round,1);
a(); b(); c();
let count = 0;
const same = () => count++;
const old = r.onAgentEnd(same); const other = r.onAgentEnd(same);
old(); old(); r.emitAgentEnd(event); assert.equal(count,1); other();
const fresh = r.onAgentEnd(same); old(); r.emitAgentEnd(event); assert.equal(count,2); fresh();
let saved;
assert.throws(() => mountExtension(r, api => {
 saved = api; api.onAgentEnd(same); throw new Error("失败");
}), /失败/);
r.emitAgentEnd(event); assert.equal(count,2);
assert.throws(() => saved.onAgentEnd(same), /已卸载/);
const dispose = mountExtension(r, api => { saved=api; api.onAgentEnd(same); });
dispose();dispose();assert.throws(() => saved.onAgentEnd(same),/已卸载/);
let removeLater;
let added;
const stop = r.onAgentEnd(() => {
 removeLater();
 if (!added) added=r.onAgentEnd(same);
});
removeLater = r.onAgentEnd(() => { throw new Error("已移除者不能执行"); });
assert.deepEqual(r.emitAgentEnd(event), []); assert.equal(count,2);
r.emitAgentEnd(event); assert.equal(count,3);stop();added();
for(let i=0;i<3;i++) {
 const close=await loadExtension(r,"dist/extensions/upper.js");
 assert.equal(await r.executeCommand("runs", "", context),"本次装载已结束运行：0");
 await assert.rejects(loadExtension(r,"dist/extensions/upper.js"),/命令重名: context/);
 r.emitAgentEnd(event);
 assert.equal(await r.executeCommand("runs", "", context),"本次装载已结束运行：1");
 close();close();assert.deepEqual(r.emitAgentEnd(event),[]);
 await assert.rejects(() => r.executeCommand("runs", "", context),/未知命令/);
}
console.log("通过：事件顺序、只读快照、异常隔离、分发期间增删、回滚与三次装载计数");
'''
        subprocess.run(['node', '--input-type=module', '-e', event_verification],
                       cwd=project, env=test_env, check=True)

        cleanup_verification = r'''
import assert from "node:assert/strict";
import {createToolRegistry,mountExtension} from "./dist/core/tools.js";
const r=createToolRegistry();const order=[];let saved;let calls=0;
const failure=Error("清理失败");
const context={signal:new AbortController().signal};
const close=mountExtension(r,api=>{
 saved=api;
 api.registerCommand({name:"cleanup_probe",execute:()=>"已注册"});
 api.onAgentEnd(()=>calls++);
 const timer=setInterval(()=>{},1000);
 api.onDispose(()=>{clearInterval(timer);order.push(1)});
 api.onDispose(()=>{order.push(2);throw failure});
 api.onDispose(()=>{order.push(3);close()});
});
assert.throws(close,e=>e instanceof AggregateError&&e.errors[0]===failure);
assert.deepEqual(order,[3,2,1]);close();assert.deepEqual(order,[3,2,1]);
assert.throws(()=>saved.onDispose(()=>{}),/已卸载/);
await assert.rejects(r.executeCommand("cleanup_probe","",context),/未知命令/);
r.emitAgentEnd({type:"agent_end",reason:"completed",round:1});assert.equal(calls,0);
const original=Error("初始化失败");
assert.throws(()=>mountExtension(r,api=>{
 const timer=setInterval(()=>{},1000);api.onDispose(()=>clearInterval(timer));throw original;
}),e=>e===original);
assert.throws(()=>mountExtension(r,api=>{
 saved=api;const timer=setInterval(()=>{},1000);
 api.onDispose(()=>clearInterval(timer));api.onDispose(()=>{throw failure});throw original;
}),e=>e instanceof AggregateError&&e.cause===original&&e.errors[0]===original&&e.errors[1].errors[0]===failure);
assert.throws(()=>saved.onDispose(()=>{}),/已卸载/);
console.log("通过：同步资源逆序清理、异常隔离、重入幂等、初始化双重错误保留及定时器释放");
'''
        subprocess.run(['node', '--input-type=module', '-e', cleanup_verification],
                       cwd=project, env=test_env, check=True, timeout=5)

        # 真实入口创建有引用的定时器：未清理会导致进程不能在限定时间自然退出。
        cleanup_probe = project / 'cleanup-probe.mjs'
        cleanup_probe.write_text('''
import {appendFileSync} from "node:fs";
export default function(api) {
 const timer=setInterval(()=>{},1000);
 api.onDispose(()=>{clearInterval(timer);appendFileSync("cleanup-marker","已释放\\n")});
 if(process.env.CLEANUP_FAIL==="1") api.onDispose(()=>{throw Error("测试清理异常")});
 if(process.env.CLEANUP_INIT_FAIL==="1") throw Error("测试初始化异常");
}
''')
        for fail, init_fail, expected in [('0','0',0), ('1','0',1), ('0','1',1), ('1','1',1)]:
            marker_path = project / 'cleanup-marker'
            marker_path.unlink(missing_ok=True)
            result = subprocess.run(['node', 'dist/index.js'], cwd=project,
                                    env={**test_env, 'LCN_AGENT_EXTENSION': str(cleanup_probe),
                                         'CLEANUP_FAIL': fail, 'CLEANUP_INIT_FAIL': init_fail},
                                    input='/exit\n', capture_output=True, text=True, timeout=5)
            assert result.returncode == expected, result.stderr
            assert marker_path.read_text() == '已释放\n'
            if fail == '1' and init_fail == '0':
                assert '扩展清理失败' in result.stderr
            assert not (project / '.lcn-agent/sessions/.writer.lock').exists()
            assert requests.empty()
        print('通过：真实入口正常退出、清理异常退出码、初始化回滚及定时器自然退出')

        workflow_verification = r'''
import assert from "node:assert/strict";
import {createToolRegistry,loadExtension,mountExtension} from "./dist/core/tools.js";
import workflow from "./dist/extensions/workflow.js";
const r=createToolRegistry(()=>true);
const context={cwd:process.cwd(),sessionFile:null,signal:new AbortController().signal,ui:{notify(){},async ask(){return "组合回答"}}};
const event={type:"agent_end",reason:"completed",round:1};
// 捕获真实注册的监听器并计数，确认卸载后旧闭包不再被通知。
const subscribe=r.onAgentEnd;let notifications=0;
r.onAgentEnd=listener=>subscribe(event=>{notifications++;listener(event)});
const commands=["context","runs","upper","wait","ask","todo_add","todo_list","todo_done"];
for(let i=0;i<3;i++) {
 const close=await loadExtension(r,"dist/extensions/workflow.js");
 assert.deepEqual(r.definitions().map(t=>t.function.name),["upper","todo_list","todo_add","todo_done"]);
 assert.equal(await r.executeCommand("ask","",context),"回答：组合回答");
 assert.equal(await r.executeCommand("upper","hello",context),"HELLO");
 await assert.rejects(r.executeCommand("todo_list","",context),/先 \/new/);
 r.emitAgentEnd(event);assert.equal(notifications,i+1);
 assert.equal(await r.executeCommand("runs","",context),"本次装载已结束运行：1");
 close();close();assert.deepEqual(r.definitions(),[]);
 r.emitAgentEnd(event);assert.equal(notifications,i+1);
 for(const name of commands) await assert.rejects(r.executeCommand(name,"",context),/未知命令/);
}
// 让待办注册中途冲突，检查此前 upper 及待办已注册部分全部回滚，原有命令不被删除。
const keep=r.registerCommand({name:"todo_list",execute:()=>"原命令"});
await assert.rejects(loadExtension(r,"dist/extensions/workflow.js"),/命令重名: todo_list/);
assert.deepEqual(r.definitions(),[]);
assert.equal(await r.executeCommand("todo_list","",context),"原命令");
for(const name of commands.filter(n=>n!=="todo_list")) await assert.rejects(r.executeCommand(name,"",context),/未知命令/);
r.emitAgentEnd(event);assert.equal(notifications,3);keep();
const close=mountExtension(r,workflow);assert.equal(await r.executeCommand("ask","",context),"回答：组合回答");close();
console.log("通过：组合扩展内外装载、三次装卸、命令工具清理、事件无残留及中途冲突回滚");
'''
        subprocess.run(['node', '--input-type=module', '-e', workflow_verification],
                       cwd=project, env=test_env, check=True)

        async_verification = r'''
import assert from "node:assert/strict";
import {createToolRegistry,loadExtension} from "./dist/core/tools.js";
const r=createToolRegistry(() => true);const close=await loadExtension(r,"dist/extensions/upper.js");
const controller=new AbortController();
const context={cwd:process.cwd(),model:"local-test",sessionFile:null,signal:controller.signal,ui:{notify(){}}};
assert.equal(await r.executeCommand("upper","abc",context),"ABC");
const pending=r.executeCommand("wait","",context);controller.abort();
await assert.rejects(pending,{name:"AbortError"});
let calls=0;
r.registerCommand({name:"probe",execute(){calls++;return "执行";}});
await assert.rejects(r.executeCommand("probe","",context),{name:"AbortError"});
assert.equal(calls,0);
const failure=new Error("异步失败");
r.registerCommand({name:"asyncfail",async execute(){throw failure;}});
await assert.rejects(r.executeCommand("asyncfail","",{...context,signal:new AbortController().signal}),e=>e===failure);
close();console.log("通过：异步异常、执行中取消、已取消信号阻止执行与同步命令兼容");
'''
        subprocess.run(['node', '--input-type=module', '-e', async_verification],
                       cwd=project, env=test_env, check=True)

        todo_verification = r'''
import assert from "node:assert/strict";
import {createToolRegistry,loadExtension,mountExtension} from "./dist/core/tools.js";
import todo from "./dist/extensions/todo.js";
const r=createToolRegistry(() => true);let close=await loadExtension(r,"dist/extensions/todo.js");
const controller=new AbortController();
const ctx={cwd:process.cwd(),model:"test",sessionFile:null,signal:controller.signal,ui:{notify(){},async ask(){return "提问新增"}}};
await assert.rejects(r.executeCommand("todo_add","任务",ctx),/先 \/new/);
const a={...ctx,sessionFile:"a.jsonl"},b={...ctx,sessionFile:"b.jsonl"};
assert.equal(await r.executeCommand("todo_add","任务一",a),"已添加 #1：任务一");
assert.equal(await r.executeCommand("todo_add","",a),"已添加 #2：提问新增");
assert.equal(await r.executeCommand("todo_list","",b),"当前会话暂无待办");
assert.match(await r.executeCommand("todo_done","1",a),/已完成/);
assert.equal(await r.executeCommand("todo_done","1",a),"#1 已经完成");
for(const id of ["", "1x", "01", "99"]) await assert.rejects(r.executeCommand("todo_done",id,a),/编号/);
const before=await r.executeCommand("todo_list","",a);
await assert.rejects(r.executeCommand("todo_add","",{...a,ui:{...a.ui,async ask(){return "  "}}}),/不能为空/);
await assert.rejects(r.executeCommand("todo_add","",{...a,ui:{...a.ui,async ask(){controller.abort();return "迟到"}}}),{name:"AbortError"});
assert.equal(await r.executeCommand("todo_list","",{...a,signal:new AbortController().signal}),before);
close();
await assert.rejects(r.executeCommand("todo_list","",a),/未知命令/);
close=mountExtension(r,todo);
assert.equal(await r.executeCommand("todo_list","",{...a,signal:new AbortController().signal}),before);close();
console.log("通过：新增、提问、完成、重入、编号校验、取消不写入、会话隔离、卸载及内外共用入口");
'''
        subprocess.run(['node', '--input-type=module', '-e', todo_verification],
                       cwd=project, env=test_env, check=True)

        state_verification = r'''
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,mkdirSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createToolRegistry,mountExtension} from "./dist/core/tools.js";
const cwd=mkdtempSync(join(tmpdir(),"lcn-state-"));
const context={cwd,sessionFile:"a.jsonl",signal:new AbortController().signal};
const registry=createToolRegistry();let api;
const dispose=mountExtension(registry,value=>{api=value});
const path=join(cwd,".lcn-agent/notes/a.jsonl.json");
try {
 assert.equal(api.readState(context,"notes"),undefined);
 assert(!existsSync(join(cwd,".lcn-agent")));
 for(const namespace of ["", "../escape", "/absolute", "a/b", "a\\b", "sessions", "diagnostics", "Notes"]) {
  assert.throws(()=>api.readState(context,namespace),/命名空间/);
  assert.throws(()=>api.writeState(context,namespace,{}),/命名空间/);
 }
 for(const file of ["", "../escape.jsonl", "a\\b.jsonl", "a.txt"]) {
  assert.throws(()=>api.readState({...context,sessionFile:file},"notes"),/文件名/);
  assert.throws(()=>api.writeState({...context,sessionFile:file},"notes",{}),/文件名/);
 }
 assert.throws(()=>api.readState({...context,sessionFile:null},"notes"),/先 \/new/);
 assert.throws(()=>api.writeState({...context,sessionFile:null},"notes",{}),/先 \/new/);
 assert(!existsSync(join(cwd,".lcn-agent")));
 api.writeState(context,"notes",{version:1,text:"原状态"});
 const good=readFileSync(path);
 assert.equal(api.readState({...context,sessionFile:"b.jsonl"},"notes"),undefined);
 assert.equal(api.readState(context,"todos"),undefined);
 api.writeState({...context,sessionFile:"b.jsonl"},"notes",["另一会话"]);
 api.writeState(context,"todos",null);
 assert.equal(api.readState(context,"todos"),null);
 assert.deepEqual(readFileSync(path),good);
 const value=api.readState(context,"notes");value.text="内存修改";
 assert.equal(api.readState(context,"notes").text,"原状态");
 for(const bad of [undefined,1n,(()=>{const x={};x.self=x;return x})()]) {
  assert.throws(()=>api.writeState(context,"notes",bad));
  assert.deepEqual(readFileSync(path),good);
 }
 const controller=new AbortController();controller.abort();
 assert.throws(()=>api.readState({...context,signal:controller.signal},"notes"),{name:"AbortError"});
 assert.throws(()=>api.writeState({...context,signal:controller.signal},"notes",{}),{name:"AbortError"});
 const during=new AbortController();
 assert.throws(()=>api.writeState({...context,signal:during.signal},"notes",{toJSON(){during.abort();return {}}}),{name:"AbortError"});
 assert.deepEqual(readFileSync(path),good);
 for(const broken of [Buffer.from("{"),Buffer.from([255])]) {
  writeFileSync(path,broken);assert.throws(()=>api.readState(context,"notes"),/损坏/);
  assert.deepEqual(readFileSync(path),broken);
 }
 rmSync(path);mkdirSync(path);writeFileSync(join(path,"保留"),good);
 assert.throws(()=>api.readState(context,"notes"));
 assert.throws(()=>api.writeState(context,"notes",{}));
 assert.deepEqual(readFileSync(join(path,"保留")),good);
 assert(!readdirSync(join(cwd,".lcn-agent/notes")).some(n=>n.startsWith(".state-")));
 rmSync(path,{recursive:true});writeFileSync(path,good);
 const saved=api;dispose();dispose();
 assert.throws(()=>saved.readState(context,"notes"),/已卸载/);
 assert.throws(()=>saved.writeState(context,"notes",{}),/已卸载/);
 const close=mountExtension(registry,value=>{api=value});
 assert.deepEqual(api.readState(context,"notes"),{version:1,text:"原状态"});close();
 let failed;
 assert.throws(()=>mountExtension(registry,value=>{failed=value;throw Error("初始化失败")}),/初始化失败/);
 assert.throws(()=>failed.readState(context,"notes"),/已卸载/);
 assert.throws(()=>failed.writeState(context,"notes",{}),/已卸载/);
 assert.deepEqual(readFileSync(path),good);
 console.log("通过：通用状态命名空间与会话隔离、路径保护、序列化失败、取消、损坏保留、替换清理与卸载失效");
} finally {dispose();rmSync(cwd,{recursive:true,force:true});}
'''
        subprocess.run(['node', '--input-type=module', '-e', state_verification],
                       cwd=project, env=test_env, check=True)

        todo_storage_verification = r'''
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createToolRegistry,loadExtension} from "./dist/core/tools.js";
const cwd=mkdtempSync(join(tmpdir(),"lcn-todo-data-"));
const context={cwd,sessionFile:"a.jsonl",model:"test",signal:new AbortController().signal,ui:{notify(){},async ask(){return "提问"}}};
let r=createToolRegistry(() => true);let close=await loadExtension(r,"dist/extensions/todo.js");
const file=join(cwd,".lcn-agent/todos/a.jsonl.json");
try {
 await r.executeCommand("todo_add","第一项",context);
 await r.executeCommand("todo_done","1",context);
 close();r=createToolRegistry(() => true);close=await loadExtension(r,"dist/extensions/todo.js");
 assert.equal(await r.executeCommand("todo_list","",context),"[x] #1 第一项");
 assert.equal(await r.executeCommand("todo_list","",{...context,sessionFile:"b.jsonl"}),"当前会话暂无待办");
 const good=readFileSync(file);
 for (const name of ["../outside.jsonl", "", "a.txt"]) {
  await assert.rejects(r.executeCommand("todo_add","拒绝",{...context,sessionFile:name}),/文件名不合法/);
 }
 for (const item of [null, {id:1,text:" ",done:false}, {id:1,text:"值",done:"false"}, {id:1,text:3,done:false}]) {
  const broken=Buffer.from(JSON.stringify({version:1,items:[item]}));writeFileSync(file,broken);
  await assert.rejects(r.executeCommand("todo_done","1",context),/损坏/);
  assert.deepEqual(readFileSync(file),broken);
 }
 writeFileSync(file,good);
 for (const broken of [Buffer.from("{"),Buffer.from([255]),Buffer.from('{"version":2,"items":[]}'),Buffer.from('{"version":1,"items":[{"id":2,"text":"值","done":false}]}')]) {
  writeFileSync(file,broken);
  for(const command of ["todo_list","todo_add","todo_done"]) await assert.rejects(r.executeCommand(command,"1",context),/损坏/);
  assert.deepEqual(readFileSync(file),broken);
 }
 writeFileSync(file,good);
 const controller=new AbortController();
 await assert.rejects(r.executeCommand("todo_add","",{...context,signal:controller.signal,ui:{notify(){},async ask(){controller.abort();return "迟到"}}}),{name:"AbortError"});
 assert.deepEqual(readFileSync(file),good);
 // 在提问期间将目标替换为目录，让最终 rename 确定失败。
 await assert.rejects(r.executeCommand("todo_add","",{...context,ui:{notify(){},async ask(){rmSync(file);mkdirSync(file);writeFileSync(join(file,"保留"),good);return "不能保存"}}}));
 assert.deepEqual(readFileSync(join(file,"保留")),good);
 assert(!readdirSync(join(cwd,".lcn-agent/todos")).some(n=>n.startsWith(".state-")));
 rmSync(file,{recursive:true});writeFileSync(file,good);
 assert.equal(await r.executeCommand("todo_add","第二项",context),"已添加 #2：第二项");
 console.log("通过：重装恢复、完成保存、会话隔离、损坏拒绝且原文保留、取消不写入及替换失败清理");
} finally {close();rmSync(cwd,{recursive:true,force:true});}
'''
        subprocess.run(['node', '--input-type=module', '-e', todo_storage_verification],
                       cwd=project, env=test_env, check=True)

        todo_read_verification = r'''
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createToolRegistry,loadExtension} from "./dist/core/tools.js";
const cwd=mkdtempSync(join(tmpdir(),"todo-read-data-"));const r=createToolRegistry(() => true);
const close=await loadExtension(r,"dist/extensions/todo.js");
const ctx={cwd,sessionFile:"a.jsonl",signal:new AbortController().signal,model:"test",callId:"call",ui:{notify(){},async ask(){return "任务"}}};
try {
 assert.equal(await r.execute("todo_list",{},ctx),"当前会话暂无待办");
 assert(!existsSync(join(cwd,".lcn-agent")));
 await r.executeCommand("todo_add","阅读",ctx);
 await r.executeCommand("todo_done","1",ctx);
 const file=join(cwd,".lcn-agent/todos/a.jsonl.json");const before=readFileSync(file);
 assert.equal(await r.execute("todo_list",{},ctx),"[x] #1 阅读");
 assert.equal(await r.execute("todo_list",{},ctx),await r.executeCommand("todo_list","",ctx));
 for (const args of [null,[],"",{sessionFile:"b.jsonl"}]) await assert.rejects(r.execute("todo_list",args,ctx),/空对象/);
 assert.deepEqual(readFileSync(file),before);
 assert.equal(await r.execute("todo_list",{},{...ctx,sessionFile:"b.jsonl"}),"当前会话暂无待办");
 writeFileSync(file,"{");await assert.rejects(r.execute("todo_list",{},ctx),/损坏/);assert.equal(readFileSync(file,"utf8"),"{");
 close();await assert.rejects(r.execute("todo_list",{},ctx),/未知工具/);
 console.log("通过：命令工具共用读取、无写入、参数拒绝、会话隔离、损坏保留与卸载");
} finally {close();rmSync(cwd,{recursive:true,force:true});}
'''
        subprocess.run(['node', '--input-type=module', '-e', todo_read_verification],
                       cwd=project, env=test_env, check=True)

        permission_verification = r'''
import assert from "node:assert/strict";
import {createToolRegistry} from "./dist/core/tools.js";
let calls=0;const tool={definition:{type:"function",function:{name:"probe"}},execute(){calls++;return "成功"}};
const base={cwd:process.cwd(),model:"test",sessionFile:"test.jsonl",callId:"call",signal:new AbortController().signal};
for(const [policy,message] of [[undefined,/未获授权/],[()=>false,/未获授权/],[()=>{throw Error("私密正文")},/判定失败/],[async()=>{throw Error("私密正文")},/判定失败/],[()=>"true",/未获授权/]]) {
 const r=policy?createToolRegistry(policy):createToolRegistry();r.register(tool);
 await assert.rejects(r.execute("probe",{},base),message);assert.equal(calls,0);
}
const allow=createToolRegistry(async()=>true);allow.register(tool);assert.equal(await allow.execute("probe",{},base),"成功");assert.equal(calls,1);
const controller=new AbortController();const cancel=createToolRegistry(async()=>{controller.abort();return true});cancel.register(tool);
await assert.rejects(cancel.execute("probe",{},{...base,signal:controller.signal}),{name:"AbortError"});assert.equal(calls,1);
console.log("通过：默认拒绝、允许执行、同步及异步判定异常、非布尔拒绝、判定期间取消且无副作用");
'''
        subprocess.run(['node', '--input-type=module', '-e', permission_verification],
                       cwd=project, env=test_env, check=True)

        confirm_verification = r'''
import assert from "node:assert/strict";
import {createToolRegistry} from "./dist/core/tools.js";
let calls=0;const original={text:"审批值"};let approved;
const r=createToolRegistry(async(name,json,context)=>{
 approved=json;original.text="改写值";return context.confirm(name,json,context.callId,context.signal);
});r.register({definition:{type:"function",function:{name:"probe"}},execute(args){calls++;return args.text}});
const ctx={cwd:process.cwd(),model:"test",sessionFile:"test.jsonl",callId:"1",signal:new AbortController().signal,confirm:async()=>true};
assert.equal(await r.execute("probe",original,ctx),"审批值");assert.equal(approved,'{"text":"审批值"}');assert.equal(calls,1);
await assert.rejects(r.execute("probe",{}, {...ctx,confirm:async()=>false}),/未获授权/);assert.equal(calls,1);
console.log("通过：确认与最终参数绑定、异步等待期间原对象修改不影响执行、拒绝不执行");

const aborted = new AbortController();
await assert.rejects(r.execute("probe",{}, {...ctx,signal:aborted.signal,confirm:async()=>{aborted.abort();return true;}}),{name:"AbortError"});
assert.equal(calls,1);
await assert.rejects(r.execute("probe",{}, {...ctx,confirm:async()=>{throw Error("确认失败");}}),/权限判定失败/);
assert.equal(calls,1);
'''
        subprocess.run(['node', '--input-type=module', '-e', confirm_verification],
                       cwd=project, env=test_env, check=True)

        todo_write_verification = r'''
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createToolRegistry,loadExtension} from "./dist/core/tools.js";
const cwd=mkdtempSync(join(tmpdir(),"todo-approved-"));
let permit=false;const approved=[];
const r=createToolRegistry((name,json,ctx)=>name==="todo_list"||ctx.confirm(name,json,ctx.callId,ctx.signal));
const ctx={cwd,model:"test",sessionFile:"s.jsonl",callId:"1",signal:new AbortController().signal,confirm:async(n,j)=>{approved.push([n,j]);return permit}};
const close=await loadExtension(r,"dist/extensions/todo.js");
const file=join(cwd,".lcn-agent/todos/s.jsonl.json");
try {
 await assert.rejects(r.execute("todo_add",{text:"任务"},ctx),/未获授权/);assert(!existsSync(file));
 permit=true;assert.equal(await r.execute("todo_add",{text:"任务"},ctx),"已添加 #1：任务");
 const before=readFileSync(file);permit=false;
 await assert.rejects(r.execute("todo_done",{id:"1"},ctx),/未获授权/);assert.deepEqual(readFileSync(file),before);
 permit=true;
 for(const args of [{id:1},{id:"1",extra:1},{id:"01"}]) await assert.rejects(r.execute("todo_done",args,ctx));
 assert.deepEqual(readFileSync(file),before);
 assert.equal(await r.execute("todo_done",{id:"1"},ctx),"已完成 #1：任务");
 assert.equal(await r.execute("todo_list",{},ctx),"[x] #1 任务");
 const controller=new AbortController();controller.abort();const saved=readFileSync(file);
 await assert.rejects(r.execute("todo_add",{text:"取消"},{...ctx,signal:controller.signal}),{name:"AbortError"});assert.deepEqual(readFileSync(file),saved);
 console.log("通过：审批允许/拒绝、参数校验、取消不写入及命令工具共用存储");
} finally {close();rmSync(cwd,{recursive:true,force:true});}
'''
        subprocess.run(['node', '--input-type=module', '-e', todo_write_verification],
                       cwd=project, env=test_env, check=True)

        # 直接验证持久化边界，所有损坏均写在临时目录，比较原始字节不被恢复操作修改。
        verification = r'''
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createSession, saveMessage, loadSession, lockSessions, SessionWriteError } from "./dist/core/session.js";
const s = createSession("local-test");
saveMessage(s, { role: "user", content: "问题" });
saveMessage(s, { role: "assistant", content: "回答" });
assert.deepEqual(loadSession(s.file, s.model).messages, s.messages);
const path = `.lcn-agent/sessions/${s.file}`;
const good = readFileSync(path);
for (const broken of [Buffer.concat([good, Buffer.from('{"type":')]),
                      Buffer.from(good.toString().replace('"问题"', '错误JSON'))]) {
  writeFileSync(path, broken);
  assert.throws(() => loadSession(s.file, s.model), /行/);
  assert.deepEqual(readFileSync(path), broken);
}
writeFileSync(path, good);
assert.throws(() => loadSession(s.file, "另一个模型"), /模型/);
assert.throws(() => loadSession("../外部.jsonl", s.model), /不存在/);
saveMessage(s, { role: "assistant", content: "", tool_calls: [
  { id: "call", type: "function", function: { name: "echo", arguments: "{}" } },
] });
assert.throws(() => loadSession(s.file, s.model), /执行结果未知/);
assert.throws(() => saveMessage(s, { role: "tool", tool_call_id: "错", content: "值" }), /对应/);
saveMessage(s, { role: "tool", tool_call_id: "call", content: "结果" });
assert.deepEqual(loadSession(s.file, s.model).messages, s.messages);
const count = s.messages.length;
rmSync(path);
mkdirSync(path);
assert.throws(() => saveMessage(s, { role: "user", content: "不能写" }), SessionWriteError);
assert.equal(s.messages.length, count);
rmSync(path, { recursive: true });
// 已有文件丢失时不能隐式重建，内存和配对状态也必须保持不变。
assert.throws(() => saveMessage(s, { role: "user", content: "下一问" }), SessionWriteError);
assert.equal(existsSync(path), false, "不得重建丢失文件");
assert.equal(s.messages.length, count, "保存失败时不能追加内存历史");
assert.equal(s.pending.size, 0, "保存失败时配对状态不变");
const unlock = lockSessions();
assert.throws(() => lockSessions(), /EEXIST/);
unlock();
console.log("通过：保存恢复、损坏定位、原文件保护、工具配对、写入失败、文件丢失和独占锁");
'''
        subprocess.run(['node', '--input-type=module', '-e', verification], cwd=project, env=test_env, check=True)

        def launch(env=None):
            child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, env=test_env if env is None else env, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            children.append(child)
            lines = queue.Queue()
            def read():
                for line in child.stdout:
                    lines.put(line)
            threading.Thread(target=read, daemon=True).start()
            return child, lines

        def send(child, text):
            child.stdin.write(text + '\n')
            child.stdin.flush()

        def expect(lines, text):
            seen = ''
            while text not in seen:
                seen += lines.get(timeout=5)
            return seen

        def ask(child, lines, question):
            send(child, question)
            expect(lines, '完成，共')
            return requests.get(timeout=5)

        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        assert len(ask(child, lines, '第一问')) == 1
        definitions = tool_definitions.get(timeout=5)
        assert [tool['function']['name'] for tool in definitions] == ['echo', 'upper', 'todo_list', 'todo_add', 'todo_done']
        assert definitions[0]['function']['parameters']['required'] == ['text']
        history = ask(child, lines, '第二问')
        assert [m['role'] for m in history] == ['user', 'assistant', 'user']
        assert history[0]['content'] == '第一问'
        send(child, '/sessions')
        session_file = next((project / '.lcn-agent/sessions').glob('*.jsonl')).name
        expect(lines, session_file)
        send(child, '/exit')
        assert child.wait(timeout=5) == 0

        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + session_file)
        expect(lines, '已恢复：')
        assert len(ask(child, lines, '重启第三问')) == 5
        ask(child, lines, '调用工具')
        tool_history = requests.get(timeout=5)
        assert tool_history[-1] == {'role': 'tool', 'tool_call_id': 'call_1', 'content': '回显'}
        send(child, '/history')
        expect(lines, 'tool_call_id')
        send(child, '/exit')
        assert child.wait(timeout=5) == 0

        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + session_file)
        expect(lines, '已恢复：')
        assert any(m['role'] == 'tool' for m in ask(child, lines, '恢复后提问'))
        assert tool_requests == 1
        send(child, '/new')
        expect(lines, '会话：')
        assert len(ask(child, lines, '新会话')) == 1
        send(child, '/exit')
        assert child.wait(timeout=5) == 0
        print('通过：连续提问、退出重启、查看历史、新会话隔离、恢复不重放工具')

        # 取消必须通过真实终端输入触发 readline 的 SIGINT 事件。
        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, env=test_env,
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child)
        os.close(slave)

        def terminal_expect(text):
            output = b''
            deadline = time.monotonic() + 5
            while text.encode() not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)
            assert text.encode() in output, repr(output)

        try:
            terminal_expect('生成中 Ctrl+C')
            original_files = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
            os.write(master, '等待取消\n'.encode())
            assert started.wait(5), '模拟请求未开始'
            requests.get(timeout=5)
            os.write(master, b'\x03')
            terminal_expect('请求已取消')
            cancelled_file = (set((project / '.lcn-agent/sessions').glob('*.jsonl')) - original_files).pop()
            records = [json.loads(line) for line in cancelled_file.read_text().splitlines()]
            assert records[1:] == [{'type': 'message', 'message': {'role': 'user', 'content': '等待取消'}}]
            release.set()
            os.write(master, b'/exit\n')
            terminal_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
        finally:
            os.close(master)
            release.set()

        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + cancelled_file.name)
        expect(lines, '已恢复：')
        history = ask(child, lines, '取消后恢复')
        assert history == [{'role': 'user', 'content': '等待取消'}, {'role': 'user', 'content': '取消后恢复'}]
        send(child, '/exit')
        assert child.wait(timeout=5) == 0
        result = subprocess.run(['node', 'dist/index.js', '单次入口'], cwd=project, env=test_env,
                                capture_output=True, text=True, timeout=5)
        assert result.returncode == 0 and '完成，共 1 轮' in result.stdout
        assert requests.get(timeout=5) == [{'role': 'user', 'content': '单次入口'}]
        print('通过：终端取消、取消后重启恢复、非交互入口')

        def diagnosis_records(file):
            return [[json.loads(line) for line in path.read_text().splitlines()]
                    for path in (project / '.lcn-agent/diagnostics' / file).glob('*.jsonl')]

        runs = diagnosis_records(session_file)
        assert len(runs) == 5, len(runs)
        ends = [record for run in runs for record in run if record['type'] == 'end']
        assert all(isinstance(record['elapsedMs'], (int, float)) and record['elapsedMs'] >= 0 for record in ends)
        assert any(record['usage'] == {'promptTokens': 7, 'completionTokens': 1, 'totalTokens': 8} for record in ends)
        tools = [record for run in runs for record in run if record['type'] == 'start' and record['kind'] == 'tool']
        assert len(tools) == 1 and tools[0]['callId'] == 'call_1'
        cancelled = [record for run in diagnosis_records(cancelled_file.name) for record in run]
        assert any(record['type'] == 'end' and record['outcome'] == 'cancelled' for record in cancelled)

        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + session_file)
        expect(lines, '已恢复：')
        send(child, '/diagnostics')
        expect(lines, '运行结束：completed')
        assert requests.empty(), '查看诊断不能请求模型'
        ask(child, lines, '工具参数错误')
        requests.get(timeout=5)
        ask(child, lines, '用量缺失')
        absent_runs = diagnosis_records(session_file)
        assert any(len(run) == 4 and run[2]['type'] == 'end' and run[2]['usage'] is None
                   and run[2]['outcome'] == 'success' for run in absent_runs)
        send(child, '模型错误验证')
        expect(lines, '请求失败：')
        requests.get(timeout=5)
        send(child, '/exit')
        assert child.wait(timeout=5) == 0
        records = [record for run in diagnosis_records(session_file) for record in run]
        assert any(record['type'] == 'end' and record['reason'] == '工具参数不是合法 JSON'
                   and record['outcome'] == 'error' for record in records)
        assert any(record['type'] == 'end' and record['usage'] is None for record in records)
        assert any(record['type'] == 'end' and record['reason'].startswith('HTTP 400') for record in records)
        assert '不应落盘的错误正文' not in json.dumps(records, ensure_ascii=False)
        print('通过：诊断耗时、用量、调用关联、模型和工具错误、取消及查看不重放')

        # 使用主实现的真实 30 秒超时，不修改生产常量。
        result = subprocess.run(['node', 'dist/index.js', '等待超时'], cwd=project, env=test_env,
                                capture_output=True, text=True, timeout=40)
        assert '请求超时' in result.stdout and '请求已取消' not in result.stdout, result.stdout
        requests.get(timeout=5)
        timed_out = [json.loads(line) for file in (project / '.lcn-agent/diagnostics').glob('*/*.jsonl')
                     for line in file.read_text().splitlines()]
        assert any(record['type'] == 'end' and record['outcome'] == 'timeout'
                   and record['reason'] == '请求超时' and record['elapsedMs'] >= 29000 for record in timed_out)
        assert any(record['type'] == 'finish' and record['reason'] == 'timeout' for record in timed_out)
        print('通过：真实 30 秒超时、明确界面提示及 timeout 运行结束原因', flush=True)

        # 将真实编译产物放到项目目录外，验证入口的路径选择和完整工具回填。
        with tempfile.TemporaryDirectory(prefix='lcn-外部 # ') as external:
            external_file = Path(external) / 'delay.mjs'
            shutil.copy(project / 'dist/extensions/delay.js', external_file)
            external_env = {**test_env, 'LCN_AGENT_EXTENSION': str(external_file)}
            while not tool_definitions.empty():
                tool_definitions.get_nowait()
            result = subprocess.run(['node', 'dist/index.js', '外部工具验证'], cwd=project,
                                    env=external_env, capture_output=True, text=True, timeout=5)
            assert result.returncode == 0 and '完成，共 2 轮' in result.stdout, result.stderr
            first = requests.get(timeout=5)
            assert first[-1]['content'] == '外部工具验证'
            history = requests.get(timeout=5)
            assert history[-1] == {'role': 'tool', 'tool_call_id': 'upper_1', 'content': 'HELLO'}
            assert [t['function']['name'] for t in tool_definitions.get(timeout=5)] == ['echo', 'upper', 'todo_list', 'todo_add', 'todo_done', 'delay_echo']
            assert requests.empty()
            missing = Path(external) / '不存在.mjs'
            result = subprocess.run(['node', 'dist/index.js', '不应请求模型'], cwd=project,
                                    env={**test_env, 'LCN_AGENT_EXTENSION': str(missing)},
                                    capture_output=True, text=True, timeout=5)
            assert result.returncode == 1 and str(missing) in result.stderr
            assert requests.empty(), '扩展加载失败时不得请求模型'
        print('通过：项目外特殊字符路径、入口加载、模型工具发现与结果回填、加载失败不请求模型')

        # 默认装配后，重复加载任一已包含模块必须失败，不能悄悄重复注册。
        for module in ['upper', 'todo', 'workflow']:
            before = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
            result = subprocess.run(['node', 'dist/index.js', '不应请求模型'], cwd=project,
                                    env={**test_env, 'LCN_AGENT_EXTENSION': f'./dist/extensions/{module}.js'},
                                    capture_output=True, text=True, timeout=5)
            assert result.returncode == 1 and '重名' in result.stderr, result.stderr
            assert set((project / '.lcn-agent/sessions').glob('*.jsonl')) == before
            assert not (project / '.lcn-agent/sessions/.writer.lock').exists()
            assert requests.empty()
        print('通过：默认扩展重复加载明确失败，不创建会话、不遗留锁、不请求模型')

        # 交互命令不请求模型、不创建会话，错误后仍能继续使用终端。
        before = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        for text, expected in [('/upper hello  world', 'HELLO  WORLD'),
                               ('/upper\thello', 'HELLO'),
                               ('/unknow', '未知命令: /unknow'),
                               ('/', '命令不能为空'),
                               ('/upper again', 'AGAIN')]:
            send(child, text)
            expect(lines, expected)
        send(child, '/exit')
        assert child.wait(timeout=5) == 0
        assert requests.empty(), '命令不能请求模型'
        assert set((project / '.lcn-agent/sessions').glob('*.jsonl')) == before
        print('通过：交互命令分发、空格与 Tab 参数、错误后继续、无模型请求及无新会话')

        # 验证真实入口发出结束事件，命令不计数，切换会话不重置装载状态。
        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        send(child, '/runs'); expect(lines, '本次装载已结束运行：0')
        ask(child, lines, '事件计数验证')
        send(child, '/runs'); expect(lines, '本次装载已结束运行：1')
        send(child, '/upper hello'); expect(lines, 'HELLO')
        send(child, '/new'); expect(lines, '会话：')
        send(child, '/runs'); expect(lines, '本次装载已结束运行：1')
        send(child, '模型错误验证'); expect(lines, '请求失败：')
        requests.get(timeout=5)
        send(child, '/runs'); expect(lines, '本次装载已结束运行：2')
        send(child, '/exit'); assert child.wait(timeout=5) == 0
        assert requests.empty()
        print('通过：入口成功与错误结束计数、命令不计数及跨会话保留')

        # 使用真实入口创建上下文，测试快照冻结与会话切换，扩展只读取公开字段。
        probe = project / 'context-probe.mjs'
        probe.write_text('''
import assert from "node:assert/strict";
export default function(api) {
  api.registerCommand({ name: "parallelask", async execute(args, context) {
    const first = context.ui.ask("第一问：");
    await assert.rejects(context.ui.ask("不应显示的第二问："), /已有提问/);
    return `并发保护通过：${await first}`;
  }});
  api.registerCommand({ name: "asyncfail", async execute() {
    await Promise.resolve();
    throw new Error("异步命令拒绝");
  }});
  api.registerCommand({ name: "late", async execute(args, context) {
    context.ui.notify("忽略信号的实验已开始");
    await new Promise(resolve => setTimeout(resolve, 300));
    return "不应显示的迟到结果";
  }});
  api.registerCommand({ name: "probe", execute(args, context) {
    assert(Object.isFrozen(context));
    assert(Object.isFrozen(context.ui));
    assert.throws(() => { context.sessionFile = "篡改"; }, TypeError);
    assert.throws(() => { context.ui.notify = () => {}; }, TypeError);
    context.ui.notify("上下文只读验证通过");
  }});
}
''')
        env = {**test_env, 'LCN_AGENT_EXTENSION': str(probe)}
        child, lines = launch(env)
        expect(lines, '生成中 Ctrl+C')
        before = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
        send(child, '/context')
        output = expect(lines, '当前会话：尚未创建')
        assert f'工作目录：{project.resolve()}' in output and '模型：local-test' in output, repr(output)
        assert 'undefined' not in output
        send(child, '/probe'); expect(lines, '上下文只读验证通过')
        assert set((project / '.lcn-agent/sessions').glob('*.jsonl')) == before
        files = []
        for _ in range(2):
            send(child, '/new')
            output = expect(lines, '会话：')
            file = output.split('会话：')[-1].strip()
            files.append(file)
            send(child, '/context'); expect(lines, '当前会话：' + file)
        assert files[0] != files[1]
        send(child, '/exit'); assert child.wait(timeout=5) == 0
        child, lines = launch(env)
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + files[0]); expect(lines, '已恢复：')
        send(child, '/context'); expect(lines, '当前会话：' + files[0])
        send(child, '/upper hello'); expect(lines, 'HELLO')
        send(child, '/exit'); assert child.wait(timeout=5) == 0
        assert requests.empty(), '上下文命令不得请求模型'
        print('通过：真实入口上下文冻结、通知输出、无会话、连续新建、重启恢复及旧命令兼容')

        # PTY 验证命令取消后仍可操作，并检查运行期间提交的下一条输入串行执行。
        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project,
                                 env=env,
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child)
        os.close(slave)
        def command_expect(text, timeout=8):
            output = b''
            deadline = time.monotonic() + timeout
            while text.encode() not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 65536)
            assert text.encode() in output, repr(output)
            return output
        try:
            command_expect('生成中 Ctrl+C')
            before_ask = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
            for answer in ['中文答案', '', '/exit']:
                os.write(master, b'/ask\n')
                command_expect('请输入回答：')
                os.write(master, (answer + '\n').encode())
                command_expect('回答：' + answer)
            os.write(master, b'/parallelask\n')
            command_expect('第一问：')
            os.write(master, '一次回答\n'.encode())
            command_expect('并发保护通过：一次回答')
            os.write(master, b'/ask\n')
            command_expect('请输入回答：')
            os.write(master, b'\x03')
            command_expect('命令已取消')
            os.write(master, b'/ask\n')
            command_expect('请输入回答：')
            os.write(master, '恢复后的回答\n'.encode())
            command_expect('回答：恢复后的回答')
            assert requests.empty(), '提问与回答不得进入模型请求'
            assert set((project / '.lcn-agent/sessions').glob('*.jsonl')) == before_ask
            os.write(master, b'/asyncfail\n')
            command_expect('命令执行失败：异步命令拒绝')
            os.write(master, b'/late\n')
            command_expect('忽略信号的实验已开始')
            os.write(master, b'\x03')
            output = command_expect('命令已取消')
            assert '不应显示的迟到结果'.encode() not in output
            os.write(master, b'/wait\n')
            command_expect('等待 3 秒')
            os.write(master, b'\x03')
            output = command_expect('命令已取消')
            assert '等待完成'.encode() not in output
            os.write(master, b'/upper after\n')
            command_expect('AFTER')
            os.write(master, b'/wait\n')
            command_expect('等待 3 秒')
            os.write(master, b'/upper queued\n')
            output = command_expect('QUEUED')
            assert output.index('等待完成'.encode()) < output.index(b'QUEUED')
            os.write(master, b'/exit\n')
            command_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
            assert requests.empty()
        finally:
            os.close(master)
        print('通过：真实终端异步正常完成、Ctrl+C 取消、取消后继续、排队顺序和退出')

        # 同一个真实终端交替使用两个扩展，验证回答路由、取消恢复及重启持久化。
        workflow_env = test_env
        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, env=workflow_env,
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child); os.close(slave)
        try:
            command_expect('生成中 Ctrl+C')
            before = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
            os.write(master, b'/ask\n'); command_expect('请输入回答：')
            os.write(master, '组合回答\n'.encode()); command_expect('回答：组合回答')
            assert set((project / '.lcn-agent/sessions').glob('*.jsonl')) == before
            os.write(master, b'/new\n'); command_expect('会话：')
            file = (set((project / '.lcn-agent/sessions').glob('*.jsonl')) - before).pop()
            os.write(master, b'/todo_add\n'); command_expect('请输入待办内容：')
            os.write(master, '组合任务\n'.encode()); command_expect('已添加 #1：组合任务')
            todo_path = project / '.lcn-agent/todos' / (file.name + '.json')
            saved = todo_path.read_bytes()
            os.write(master, b'/ask\n'); command_expect('请输入回答：')
            os.write(master, b'\x03'); command_expect('命令已取消')
            os.write(master, b'/todo_list\n'); command_expect('[ ] #1 组合任务')
            os.write(master, b'/todo_add\n'); command_expect('请输入待办内容：')
            os.write(master, b'\x03'); command_expect('命令已取消')
            assert todo_path.read_bytes() == saved
            os.write(master, b'/ask\n'); command_expect('请输入回答：')
            os.write(master, '取消后回答\n'.encode()); command_expect('回答：取消后回答')
            os.write(master, b'/upper hello\n'); command_expect('HELLO')
            os.write(master, b'/todo_done 1\n'); command_expect('已完成 #1：组合任务')
            os.write(master, b'/new\n'); command_expect('会话：')
            os.write(master, b'/todo_list\n'); command_expect('当前会话暂无待办')
            os.write(master, b'/exit\n'); command_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
            assert requests.empty(), '组合命令及回答不得请求模型'
            assert len(file.read_text().splitlines()) == 1, '提问回答不写入对话历史'
        finally:
            os.close(master)
        child, lines = launch(workflow_env)
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + file.name); expect(lines, '已恢复：')
        send(child, '/todo_list'); expect(lines, '[x] #1 组合任务')
        send(child, '/ask'); expect(lines, '交互提问需要终端输入和输出')
        send(child, '/upper after'); expect(lines, 'AFTER')
        send(child, '/exit'); assert child.wait(timeout=5) == 0
        assert requests.empty()
        print('通过：组合入口 PTY 提问、交叉取消恢复、无模型请求、会话隔离、重启恢复及非终端拒绝')

        # 空编辑行 Ctrl+D 关闭终端输入，等待中的提问必须退出。
        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, env=env,
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child)
        os.close(slave)
        try:
            command_expect('生成中 Ctrl+C')
            os.write(master, b'/ask\n')
            command_expect('请输入回答：')
            os.write(master, b'\x04')
            command_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
        finally:
            os.close(master)
        child, lines = launch(env)
        expect(lines, '生成中 Ctrl+C')
        send(child, '/ask')
        expect(lines, '交互提问需要终端输入和输出')
        send(child, '/upper after')
        expect(lines, 'AFTER')
        send(child, '/exit')
        assert child.wait(timeout=5) == 0
        assert requests.empty()
        print('通过：提问中文/空/斜杠回答、并发拒绝、取消恢复、输入关闭、非终端拒绝及无模型请求')

        child, lines = launch(env)
        expect(lines, '生成中 Ctrl+C')
        send(child, '/wait')
        expect(lines, '等待 3 秒')
        child.stdin.close()
        output = expect(lines, '终端程序已退出')
        assert '命令已取消' in output and '等待完成' not in output
        assert child.wait(timeout=5) == 0
        assert requests.empty()
        print('通过：异步拒绝后恢复、忽略信号的迟到返回值抑制及输入关闭取消退出')

        # 从当前源码编译的真实待办扩展检查会话切换与重启后的持久化状态。
        todo_env = test_env
        child, lines = launch(todo_env)
        expect(lines, '生成中 Ctrl+C')
        send(child, '/todo_list'); expect(lines, '请先 /new 或 /resume')
        send(child, '/new')
        first = expect(lines, '会话：').split('会话：')[-1].strip()
        send(child, '/todo_add 阅读会话模块'); expect(lines, '已添加 #1：阅读会话模块')
        send(child, '/todo_add 吃饭'); expect(lines, '已添加 #2：吃饭')
        send(child, '/todo_done 1'); expect(lines, '已完成 #1')
        todo_path = project / '.lcn-agent/todos' / (first + '.json')
        original_todo = todo_path.read_bytes()
        while not tool_definitions.empty():
            tool_definitions.get_nowait()
        ask(child, lines, '待办工具验证')
        history = requests.get(timeout=5)
        assert history[-1] == {'role':'tool', 'tool_call_id':'todo_read_1',
                               'content':'[x] #1 阅读会话模块\n[ ] #2 吃饭'}
        assert [tool['function']['name'] for tool in tool_definitions.get(timeout=5)] == ['echo', 'upper', 'todo_list', 'todo_add', 'todo_done']
        assert todo_path.read_bytes() == original_todo
        assert requests.empty()
        print('通过：模型发现待办工具、列表正确回填且待办文件字节不变')

        send(child, '/todo_list')
        output = expect(lines, '[ ] #2 吃饭')
        assert '[x] #1 阅读会话模块' in output
        send(child, '/new')
        second = expect(lines, '会话：').split('会话：')[-1].strip()
        assert first != second
        send(child, '/todo_list'); expect(lines, '当前会话暂无待办')
        send(child, '/resume ' + first); expect(lines, '已恢复：')
        send(child, '/todo_list')
        output = expect(lines, '[ ] #2 吃饭')
        assert '[x] #1 阅读会话模块' in output
        send(child, '/exit'); assert child.wait(timeout=5) == 0
        child, lines = launch(todo_env)
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + first); expect(lines, '已恢复：')
        send(child, '/todo_list')
        output = expect(lines, '[ ] #2 吃饭')
        assert '[x] #1 阅读会话模块' in output
        send(child, '/exit'); assert child.wait(timeout=5) == 0

        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, env=todo_env,
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child)
        os.close(slave)
        try:
            command_expect('生成中 Ctrl+C')
            os.write(master, b'/new\n'); command_expect('会话：')
            os.write(master, b'/todo_add\n'); command_expect('请输入待办内容：')
            os.write(master, '提问创建\n'.encode()); command_expect('已添加 #1：提问创建')
            os.write(master, b'/todo_add\n'); command_expect('请输入待办内容：')
            os.write(master, b'\x03'); command_expect('命令已取消')
            os.write(master, b'/todo_add after\n'); command_expect('已添加 #2：after')
            os.write(master, b'/todo_list\n')
            output = command_expect('[ ] #2 after')
            assert '[ ] #1 提问创建'.encode() in output
            os.write(master, b'/exit\n'); command_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
        finally:
            os.close(master)
        assert requests.empty(), '待办命令不得请求模型'
        print('通过：待办真实入口会话隔离、切回恢复、重启持久化、PTY 提问与取消不占编号')

        # 使用真实的每轮 30 秒预算，覆盖工具等待中的超时分类与后续调用配对。
        slow = project / 'slow-probe.mjs'
        slow.write_text('''
import {setTimeout as delay} from "node:timers/promises";
export default function(api) {
  api.registerTool({
    definition: {type:"function",function:{name:"delay_echo",parameters:{type:"object"}}},
    async execute(args, context) {
      await delay(35000, undefined, {signal:context.signal});
      return "不应返回";
    }
  });
}
''')
        before = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project,
                                 env={**test_env, 'LCN_AGENT_EXTENSION': str(slow)},
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child); os.close(slave)
        try:
            command_expect('生成中 Ctrl+C')
            os.write(master, '工具超时验证\n'.encode()); command_expect('[y/N]')
            os.write(master, b'y\n')
            output = command_expect('请求超时：本轮超过 30 秒预算', timeout=35)
            assert '请求已取消'.encode() not in output
            os.write(master, b'/exit\n'); command_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
        finally:
            os.close(master)
        requests.get(timeout=5)
        assert requests.empty(), '工具超时后不能继续请求模型'
        file = (set((project / '.lcn-agent/sessions').glob('*.jsonl')) - before).pop()
        messages = [json.loads(line)['message'] for line in file.read_text().splitlines()[1:]]
        assert messages[-2]['tool_call_id'] == 'slow_1'
        assert '本轮超时' in messages[-2]['content']
        assert messages[-1] == {'role':'tool', 'tool_call_id':'skipped_2', 'content':'未执行：本轮超时'}
        runs = diagnosis_records(file.name)
        assert runs[0][-1]['type'] == 'finish' and runs[0][-1]['reason'] == 'timeout'
        child, lines = launch()
        expect(lines, '生成中 Ctrl+C')
        send(child, '/resume ' + file.name); expect(lines, '已恢复：')
        send(child, '/diagnostics'); expect(lines, '运行结束：timeout')
        send(child, '/exit'); assert child.wait(timeout=5) == 0
        print('通过：真实 30 秒工具超时、未执行结果配对、停止后续请求及恢复诊断')

        denied = project / 'denied-probe.mjs'
        denied.write_text('''
import {writeFileSync} from "node:fs";
export default function(api) {
  api.registerTool({definition:{type:"function",function:{name:"denied_probe"}},
    execute(){writeFileSync("不应创建", "已执行");return "不应执行";}});
}
''')
        result = subprocess.run(['node', 'dist/index.js', '权限拒绝验证'], cwd=project,
                                env={**test_env, 'LCN_AGENT_EXTENSION': str(denied)},
                                capture_output=True, text=True, timeout=5)
        assert result.returncode == 0 and '工具未获授权: denied_probe' in result.stdout
        requests.get(timeout=5)
        history = requests.get(timeout=5)
        assert history[-1] == {'role':'tool','tool_call_id':'denied_1',
                               'content':'执行失败：工具未获授权: denied_probe'}
        assert not (project / '不应创建').exists()
        assert requests.empty()
        print('通过：真实入口权限拒绝、工具副作用未发生及拒绝结果配对回填')

        # 包装真实 delay 扩展记录执行次数，直接证明拒绝和取消时没有进入执行函数。
        confirmed = project / 'confirm-probe.mjs'
        confirmed.write_text('''
import registerDelay from "./dist/extensions/delay.js";
import {appendFileSync} from "node:fs";
export default function(api) {
  registerDelay({...api, registerTool(tool) {
    api.registerTool({...tool, async execute(args, context) {
      appendFileSync("confirmed-calls", "执行\\n");
      return tool.execute(args, context);
    }});
  }});
}
''')
        confirm_env = {**test_env, 'LCN_AGENT_EXTENSION': str(confirmed)}
        def confirmed_count():
            marker = project / 'confirmed-calls'
            return len(marker.read_text().splitlines()) if marker.exists() else 0
        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, env=confirm_env,
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child); os.close(slave)
        try:
            command_expect('生成中 Ctrl+C')
            for answer in ['y', 'n', '', 'Y']:
                os.write(master, '确认工具验证\n'.encode())
                output = command_expect('[y/N]')
                assert b'delay_echo' in output and b'confirm_1' in output
                assert '确认内容'.encode() in output
                os.write(master, (answer + '\n').encode())
                command_expect('完成，共 2 轮')
                requests.get(timeout=5)
                history = requests.get(timeout=5)
                expected = '确认内容' if answer == 'y' else '执行失败：工具未获授权: delay_echo'
                assert history[-1]['content'] == expected
                assert history[-1]['tool_call_id'] == 'confirm_1'
                assert confirmed_count() == 1
            os.write(master, '确认工具验证\n'.encode()); command_expect('[y/N]')
            os.write(master, b'\x03'); command_expect('请求已取消')
            requests.get(timeout=5); assert requests.empty() and confirmed_count() == 1
            os.write(master, '确认工具验证\n'.encode()); command_expect('[y/N]')
            command_expect('请求超时：本轮超过 30 秒预算', timeout=35)
            requests.get(timeout=5); assert requests.empty() and confirmed_count() == 1
            os.write(master, b'/exit\n'); command_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
        finally:
            os.close(master)
        result = subprocess.run(['node', 'dist/index.js', '确认工具验证'], cwd=project,
                                env=confirm_env, capture_output=True, text=True, timeout=5)
        assert result.returncode == 0 and '工具未获授权: delay_echo' in result.stdout
        requests.get(timeout=5); history = requests.get(timeout=5)
        assert '未获授权' in history[-1]['content'] and confirmed_count() == 1
        assert requests.empty()
        print('通过：真实终端确认允许/拒绝/默认拒绝、取消、真实超时及非交互拒绝均无额外执行')

        # 真实宿主确认待办写入：拒绝/取消比较文件字节，同意检查实际状态和模型回填。
        master, slave = pty.openpty()
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, env=todo_env,
                                 stdin=slave, stdout=slave, stderr=slave)
        children.append(child); os.close(slave)
        try:
            command_expect('生成中 Ctrl+C')
            before = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
            os.write(master, b'/new\n'); command_expect('会话：')
            file = (set((project / '.lcn-agent/sessions').glob('*.jsonl')) - before).pop()
            todo_path = project / '.lcn-agent/todos' / (file.name + '.json')
            for question, answer, expected in [
                ('模型新增待办', 'n', '执行失败：工具未获授权: todo_add'),
                ('模型新增待办', 'y', '已添加 #1：审批任务'),
                ('模型完成待办', 'n', '执行失败：工具未获授权: todo_done'),
                ('模型完成待办', 'y', '已完成 #1：审批任务'),
            ]:
                original = todo_path.read_bytes() if todo_path.exists() else None
                os.write(master, (question + '\n').encode()); command_expect('[y/N]')
                os.write(master, (answer + '\n').encode()); command_expect('完成，共 2 轮')
                requests.get(timeout=5); history = requests.get(timeout=5)
                assert history[-1] == {'role':'tool','tool_call_id':'todo_write_1','content':expected}
                if answer == 'n':
                    assert (todo_path.read_bytes() if todo_path.exists() else None) == original
                else:
                    items = json.loads(todo_path.read_text())['items']
                    assert items == [{'id':1,'text':'审批任务','done':question == '模型完成待办'}]
            original = todo_path.read_bytes()
            os.write(master, '模型新增待办\n'.encode()); command_expect('[y/N]')
            os.write(master, b'\x03'); command_expect('请求已取消')
            requests.get(timeout=5); assert requests.empty()
            assert todo_path.read_bytes() == original
            os.write(master, b'/exit\n'); command_expect('终端程序已退出')
            assert child.wait(timeout=5) == 0
        finally:
            os.close(master)
        before = {p.name: p.read_bytes() for p in (project / '.lcn-agent/todos').glob('*.json')}
        result = subprocess.run(['node', 'dist/index.js', '模型新增待办'], cwd=project,
                                env=todo_env, capture_output=True, text=True, timeout=5)
        assert result.returncode == 0 and '工具未获授权: todo_add' in result.stdout
        requests.get(timeout=5); requests.get(timeout=5)
        assert {p.name:p.read_bytes() for p in (project / '.lcn-agent/todos').glob('*.json')} == before
        assert requests.empty()
        print('通过：待办新增/完成逐次审批、拒绝与取消文件不变、结果回填及非交互拒绝')

        diagnostic_verification = r'''
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { createDiagnostics, showDiagnostics } from "./dist/core/diagnostics.js";
import { createSession } from "./dist/core/session.js";
const s = createSession("local-test");
const d = createDiagnostics(s);
d.start("tool", "echo", 1, "interrupted_call");
d.close();
assert.match(showDiagnostics(s.file), /结果未知/);
assert.match(showDiagnostics(s.file), /不自动重试/);
const folder = `.lcn-agent/diagnostics/${s.file}`;
const path = `${folder}/${readdirSync(folder)[0]}`;
appendFileSync(path, '{"type":');
const original = readFileSync(path);
assert.match(showDiagnostics(s.file), /未完整写入/);
assert.match(showDiagnostics(s.file), /结果未知/);
assert.deepEqual(readFileSync(path), original);
rmSync(folder, { recursive: true });
assert.match(showDiagnostics(s.file), /暂无诊断/);
rmSync(".lcn-agent/diagnostics", { recursive: true });
appendFileSync(".lcn-agent/diagnostics", "阻止创建子目录");
assert.throws(() => createDiagnostics(s));
console.log("通过：中断操作显示未知、损坏记录保持原文件、无日志兼容及日志路径失败");
'''
        subprocess.run(['node', '--input-type=module', '-e', diagnostic_verification], cwd=project, env=test_env, check=True)

finally:
    release.set()
    for child in children:
        if child.poll() is None:
            child.kill()
            child.wait()
    server.shutdown()
    server.server_close()
