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
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        last = messages[-1]
        if last['role'] == 'user' and last['content'] == '等待取消':
            partial = {'choices': [{'index': 0, 'delta': {'content': '未完成的回答'}, 'finish_reason': None}]}
            self.wfile.write(('data: ' + json.dumps(partial) + '\n\n').encode())
            self.wfile.flush()
            started.set()
            release.wait(10)
            return
        if last['role'] == 'user' and last['content'] == '调用工具':
            tool_requests += 1
            delta = {'tool_calls': [{'index': 0, 'id': 'call_1', 'type': 'function',
                                    'function': {'name': 'echo', 'arguments': '{"text":"回显"}'}}]}
            reason = 'tool_calls'
        else:
            delta = {'content': '完整回答\n'}
            reason = 'stop'
        for chunk in [dict(delta=delta, finish_reason=None), dict(delta={}, finish_reason=reason)]:
            self.wfile.write(('data: ' + json.dumps({'choices': [dict(index=0, **chunk)]}) + '\n\n').encode())
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
        for name in ('index.ts', 'session.ts'):
            shutil.copy(root / 'src' / name, source / name)
        shutil.copy(root / 'src/config.ts', source / 'config.ts')
        (project / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
        (project / 'package.json').write_text('{"type":"module"}')
        subprocess.run([str(root / 'node_modules/.bin/tsc'), '--ignoreConfig', '--target', 'ES2022',
                        '--module', 'NodeNext', '--strict', '--outDir', str(project / 'dist'),
                        *map(str, source.glob('*.ts'))], cwd=project, check=True)
        (project / 'config.toml').write_text(
            f'apiKey = "local-test"\nbaseURL = "http://127.0.0.1:{server.server_port}/v1"\nmodel = "local-test"\n')

        # 直接验证持久化边界，所有损坏均写在临时目录，比较原始字节不被恢复操作修改。
        verification = r'''
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createSession, saveMessage, loadSession, lockSessions, SessionWriteError } from "./dist/session.js";
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
finally:
    release.set()
    for child in children:
        if child.poll() is None:
            child.kill()
            child.wait()
    server.shutdown()
    server.server_close()
