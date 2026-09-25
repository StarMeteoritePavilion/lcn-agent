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
import { createToolRegistry } from "./dist/core/tools.js";
import { registerEcho } from "./dist/extensions/echo.js";

const registry = createToolRegistry();
assert.deepEqual(registry.definitions(), []);
registerEcho({ registerTool: registry.register, registerCommand: registry.registerCommand });
assert.deepEqual(registry.definitions().map((tool) => tool.function.name), ["echo"]);
assert.equal(registry.execute("echo", { text: "中文回显" }), "中文回显");
assert.equal(registry.execute("echo", { text: "" }), "");
for (const args of [null, [], "文本", 1, true, {}, { text: 1 }]) {
  assert.throws(() => registry.execute("echo", args), /echo 工具参数/);
}
assert.throws(() => registry.execute("Echo", { text: "值" }), /未知工具: Echo/);
assert.throws(() => registry.execute("toString", {}), /未知工具: toString/);
assert.throws(() => registerEcho({ registerTool: registry.register, registerCommand: registry.registerCommand }), /工具重名: echo/);
assert.equal(registry.execute("echo", { text: "原工具仍可用" }), "原工具仍可用");

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
assert.throws(() => registry.execute("lesson_probe", {}), /实验执行异常/);
assert.equal(calls, 1);
assert.deepEqual(createToolRegistry().definitions(), []);
console.log("通过：定义发现、参数校验、未知工具、重名保护、新工具注册、异常传播与实例隔离");
'''
        subprocess.run(['node', '--input-type=module', '-e', registry_verification], cwd=project, env=test_env, check=True)

        lifecycle_verification = r'''
import assert from "node:assert/strict";
import { createToolRegistry, mountExtension } from "./dist/core/tools.js";
import { registerEcho } from "./dist/extensions/echo.js";

const registry = createToolRegistry();
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
assert.throws(() => registry.execute("echo", {}), /未知工具/);

// 旧清理函数不能删除新实例中重新注册的同名工具。
const reload = mountExtension(registry, registerEcho);
unload();
assert.equal(registry.execute("echo", { text: "新实例" }), "新实例");
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
assert.equal(registry.execute("keep", {}), "keep");

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
assert.equal(registry.execute("again", {}), "again");
removeNew();
keep();
assert.deepEqual(names(), []);
// 同一个工具对象复用时，也必须按注册次数隔离清理状态。
const shared = tool("shared");
const oldDispose = registry.register(shared);
oldDispose();
const newDispose = registry.register(shared);
oldDispose();
assert.equal(registry.execute("shared", {}), "shared");
newDispose();
newDispose();
assert.deepEqual(names(), []);
console.log("通过：扩展卸载、三次重载、失败回滚、失效注册拒绝及同一对象重注册隔离");
'''
        subprocess.run(['node', '--input-type=module', '-e', lifecycle_verification], cwd=project, env=test_env, check=True)

        external_verification = r'''
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createToolRegistry, mountExtension, loadExtension } from "./dist/core/tools.js";
import { registerEcho } from "./dist/extensions/echo.js";
const registry = createToolRegistry();
const close = mountExtension(registry, registerEcho);
for (let i = 0; i < 3; i++) {
  const dispose = await loadExtension(registry, "dist/extensions/upper.js");
  assert.equal(registry.execute("upper", { text: "hello" }), "HELLO");
  assert.equal(registry.executeCommand("upper", "hello  world"), "HELLO  WORLD");
  assert.equal(registry.execute("echo", { text: "hello" }), "hello");
  for (const args of [null, [], {}, {text: 1}]) {
    assert.throws(() => registry.execute("upper", args), /upper 工具参数/);
  }
  await assert.rejects(loadExtension(registry, "dist/extensions/upper.js"), /工具重名: upper/);
  dispose(); dispose();
  assert.throws(() => registry.execute("upper", {}), /未知工具/);
  assert.throws(() => registry.executeCommand("upper", ""), /未知命令/);
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
import { createToolRegistry, mountExtension } from "./dist/core/tools.js";
const r = createToolRegistry();
const command = { name: "sample", execute: text => text };
for (const name of ["exit", "new", "sessions", "history", "diagnostics", "resume"]) {
  assert.throws(() => r.registerCommand({ ...command, name }), /宿主命令不可覆盖/);
}
for (const name of ["", "/bad", "bad name", "Upper", "1bad"]) {
  assert.throws(() => r.registerCommand({ ...command, name }), /命令名不合法/);
}
const old = r.registerCommand(command);
assert.throws(() => r.registerCommand(command), /命令重名/);
assert.equal(r.executeCommand("sample", "保留  空格"), "保留  空格");
old();
const fresh = r.registerCommand(command);
old();
assert.equal(r.executeCommand("sample", "新注册"), "新注册");
fresh(); fresh();
assert.throws(() => r.executeCommand("sample", ""), /未知命令/);
let saved;
const failure = new Error("注册中断");
assert.throws(() => mountExtension(r, api => {
  saved = api;
  api.registerTool({ definition: { type: "function", function: {name: "partial"} }, execute: () => "" });
  api.registerCommand(command);
  throw failure;
}), error => error === failure);
assert.deepEqual(r.definitions(), []);
assert.throws(() => r.executeCommand("sample", ""), /未知命令/);
assert.throws(() => saved.registerCommand(command), /扩展已卸载/);
const keep = r.registerCommand(command);
assert.throws(() => mountExtension(r, api => {
  api.registerCommand({ ...command, name: "partial" });
  api.registerCommand(command);
}), /命令重名/);
assert.throws(() => r.executeCommand("partial", ""), /未知命令/);
assert.equal(r.executeCommand("sample", "原命令"), "原命令");
keep();
const close = mountExtension(r, api => {
  saved = api;
  api.registerCommand({name: "fail", execute() { throw failure; }});
});
assert.throws(() => r.executeCommand("fail", ""), error => error === failure);
close(); close();
assert.throws(() => saved.registerCommand(command), /扩展已卸载/);
console.log("通过：命令名称与宿主保护、重名、错误传播、混合注册回滚、失效拒绝及清理隔离");
'''
        subprocess.run(['node', '--input-type=module', '-e', command_verification],
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
        assert [tool['function']['name'] for tool in definitions] == ['echo']
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
        assert '请求已取消' in result.stdout
        requests.get(timeout=5)
        timed_out = [json.loads(line) for file in (project / '.lcn-agent/diagnostics').glob('*/*.jsonl')
                     for line in file.read_text().splitlines()]
        assert any(record['type'] == 'end' and record['outcome'] == 'timeout'
                   and record['reason'] == '请求超时' and record['elapsedMs'] >= 29000 for record in timed_out)
        print('通过：真实 30 秒模型超时与独立超时原因', flush=True)

        # 将真实编译产物放到项目目录外，验证入口的路径选择和完整工具回填。
        with tempfile.TemporaryDirectory(prefix='lcn-外部 # ') as external:
            external_file = Path(external) / 'upper.mjs'
            shutil.copy(project / 'dist/extensions/upper.js', external_file)
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
            assert [t['function']['name'] for t in tool_definitions.get(timeout=5)] == ['echo', 'upper']
            assert requests.empty()
            missing = Path(external) / '不存在.mjs'
            result = subprocess.run(['node', 'dist/index.js', '不应请求模型'], cwd=project,
                                    env={**test_env, 'LCN_AGENT_EXTENSION': str(missing)},
                                    capture_output=True, text=True, timeout=5)
            assert result.returncode == 1 and str(missing) in result.stderr
            assert requests.empty(), '扩展加载失败时不得请求模型'
        print('通过：项目外特殊字符路径、入口加载、模型工具发现与结果回填、加载失败不请求模型')

        # 交互命令不请求模型、不创建会话，错误后仍能继续使用终端。
        before = set((project / '.lcn-agent/sessions').glob('*.jsonl'))
        child, lines = launch({**test_env, 'LCN_AGENT_EXTENSION': './dist/extensions/upper.js'})
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
