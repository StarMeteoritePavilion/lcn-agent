"""Run after npm run build: python3 tests/terminal-cancel.py (macOS/Linux)."""
import json
import os
import pty
import select
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

started = threading.Event()
release = threading.Event()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        text = '未换行的文本' if request['messages'][0]['content'] == 'long' else 'Hello!'
        chunk = {'choices': [{'index': 0, 'delta': {'content': text}, 'finish_reason': None}]}
        self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
        self.wfile.flush()
        if text == '未换行的文本':
            started.set()
            release.wait(10)
            return
        chunk['choices'][0].update(delta={}, finish_reason='stop')
        self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())
        self.wfile.flush()


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
master, slave = pty.openpty()
env = dict(os.environ, API_KEY='local-test', MODEL='local-test',
           BASE_URL=f'http://127.0.0.1:{server.server_port}/v1')
process = subprocess.Popen(['node', 'dist/index.js'], stdin=slave, stdout=slave, stderr=slave,
                           env=env, cwd=Path(__file__).resolve().parent.parent)
os.close(slave)


def expect(text):
    output = b''
    deadline = time.monotonic() + 5
    while text.encode() not in output and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            output += os.read(master, 65536)
    assert text.encode() in output, repr(output)
    return output.decode()


try:
    expect('> ')
    os.write(master, b'\n')
    expect('> ')
    os.write(master, b'long\n')
    assert started.wait(5), 'Mock stream did not start'
    time.sleep(0.1)
    os.write(master, b'\x03')
    # 生成期间也会重绘提示符，必须等待取消事件，不能把提示符当作结束证据。
    cancelled = expect('请求已取消')
    assert '未换行的文本' in cancelled and '请求已取消' in cancelled, cancelled
    os.write(master, b'hi\n')
    completed = expect('完成，共 1 轮')
    assert 'Hello!' in completed and '完成，共 1 轮' in completed, completed
    assert '未换行的文本' not in completed, completed
    os.write(master, b'\x03')
    expect('终端程序已退出')
    assert process.wait(timeout=5) == 0
    result = subprocess.run(['node', 'dist/index.js'], input='/exit\n', text=True,
                            capture_output=True, env=env, cwd=Path(__file__).resolve().parent.parent, timeout=5)
    assert result.returncode == 0 and '终端程序已退出' in result.stdout, result
    assert '> ' not in result.stdout, result.stdout
    print('PASS: blank input, cancellation flush, next request, idle Ctrl+C, /exit')
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
    release.set()
    server.shutdown()
    server.server_close()
