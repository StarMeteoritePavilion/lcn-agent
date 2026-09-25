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

try:
    with tempfile.TemporaryDirectory(prefix='lcn-stage4-') as temporary:
        project = Path(temporary)
        source = project / 'src'
        source.mkdir()
        shutil.copy(root / 'src/index.ts', source / 'index.ts')
        shutil.copytree(root / 'src/core', source / 'core')
        (project / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
        (project / 'package.json').write_text('{"type":"module"}')
        subprocess.run([str(root / 'node_modules/.bin/tsc'), '--ignoreConfig', '--target', 'ES2022',
                        '--module', 'NodeNext', '--strict', '--outDir', str(project / 'dist'),
                        *map(str, source.rglob('*.ts'))], cwd=project, check=True)
        (project / 'config.toml').write_text(
            f'apiKey = "local-test"\nbaseURL = "http://127.0.0.1:{server.server_port}/v1"\nmodel = "local-test"\n')

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
        subprocess.run(['node', '--input-type=module', '-e', verification], cwd=project, check=True)

        def launch():
            child = subprocess.Popen(['node', 'dist/index.js'], cwd=project, stdin=subprocess.PIPE,
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
        child = subprocess.Popen(['node', 'dist/index.js'], cwd=project,
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
        result = subprocess.run(['node', 'dist/index.js', '单次入口'], cwd=project,
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
        result = subprocess.run(['node', 'dist/index.js', '等待超时'], cwd=project,
                                capture_output=True, text=True, timeout=40)
        assert '请求已取消' in result.stdout
        requests.get(timeout=5)
        timed_out = [json.loads(line) for file in (project / '.lcn-agent/diagnostics').glob('*/*.jsonl')
                     for line in file.read_text().splitlines()]
        assert any(record['type'] == 'end' and record['outcome'] == 'timeout'
                   and record['reason'] == '请求超时' and record['elapsedMs'] >= 29000 for record in timed_out)
        print('通过：真实 30 秒模型超时与独立超时原因', flush=True)

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
        subprocess.run(['node', '--input-type=module', '-e', diagnostic_verification], cwd=project, check=True)

finally:
    release.set()
    for child in children:
        if child.poll() is None:
            child.kill()
            child.wait()
    server.shutdown()
    server.server_close()
