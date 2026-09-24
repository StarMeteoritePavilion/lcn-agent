"""阶段 3 验收：先 npm run build，再使用安装了 pyte==0.8.2 的 Python 运行。"""
import codecs
import fcntl
import json
import os
import pty
import queue
import select
import shlex
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pyte


requests = queue.Queue()
release = threading.Event()
started = threading.Event()
failures = []
entry = Path(__file__).resolve().parent.parent / 'dist/index.js'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.put(request['messages'])
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def chunk(delta, reason=None):
            data = {'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
            self.wfile.write(('data: ' + json.dumps(data) + '\n\n').encode())
            self.wfile.flush()

        if request['messages'][0]['content'] == '生成期间编辑':
            started.set()
            release.wait(10)
            chunk({'content': '模型输出第一行\n模型输出第二行\n'})
        elif request['messages'][0]['content'] == '调用工具' and len(request['messages']) == 1:
            chunk({'tool_calls': [{'index': 0, 'id': 'call_test', 'type': 'function',
                                  'function': {'name': 'echo', 'arguments': '{"text":"工具中文"}'}}]})
            chunk({}, 'tool_calls')
            self.wfile.write(b'data: [DONE]\n\n')
            return
        else:
            chunk({'content': '# 中文标题\n**加粗** 与 `代码`\n'})
        chunk({}, 'stop')
        self.wfile.write(b'data: [DONE]\n\n')


def check(name, condition, detail=''):
    print(('通过：' if condition else '失败：') + name, flush=True)
    if not condition:
        failures.append(name)
        print(detail, flush=True)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

with tempfile.TemporaryDirectory(prefix='lcn-terminal-') as directory:
    # 独立工作目录和固定测试配置，不读取项目的真实 .env。
    Path(directory, 'config.toml').write_text(
        f'apiKey = "local-test"\nbaseURL = "http://127.0.0.1:{server.server_port}/v1"\n'
        'model = "local-test"\n')
    env = dict(os.environ, TERM='xterm-256color', PS1='验收Shell> ', PROMPT_COMMAND='')
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(directory)
        os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], env)

    screen = pyte.Screen(80, 30)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder('utf-8')()
    output = ''

    def pump(seconds=0.15):
        global output
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.02)[0]:
                text = decoder.decode(os.read(master, 65536))
                output += text
                stream.feed(text)

    def wait_for(text, offset):
        deadline = time.monotonic() + 5
        while text not in output[offset:] and time.monotonic() < deadline:
            pump()
        assert text in output[offset:], repr(output[offset:])
        return output[offset:]

    def send(text):
        for index in range(0, len(text), 64):
            os.write(master, text[index:index + 64].encode())
            pump(0.01)

    def receive():
        deadline = time.monotonic() + 5
        while requests.empty() and time.monotonic() < deadline:
            pump()
        return requests.get_nowait()

    def resize(columns):
        screen.resize(lines=30, columns=columns)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, columns, 0, 0))
        os.killpg(os.tcgetpgrp(master), signal.SIGWINCH)
        pump()

    def run_input(text, count=1):
        offset = len(output)
        send(text + '\n')
        received = [receive() for _ in range(count)]
        wait_for('完成，共', offset)
        pump()
        return received, output[offset:]

    try:
        wait_for('验收Shell> ', 0)
        resize(80)
        before = termios.tcgetattr(master)
        offset = len(output)
        send('node ' + shlex.quote(str(entry)) + '\n')
        wait_for('生成中 Ctrl+C', offset)
        pump()

        received, _ = run_input('中文输入测试')
        check('中文输入精确传输', received[0] == [{'role': 'user', 'content': '中文输入测试'}])
        check('中文标题渲染及显示宽度', any('中文标题' in line for line in screen.display)
              and any(screen.buffer[y][0].bold and screen.buffer[y][0].fg == 'cyan'
                      and screen.buffer[y][0].data == '中' and screen.buffer[y][2].data == '文'
                      for y, line in enumerate(screen.display) if '中文标题' in line))

        long_line = '长行' * 1050
        received, _ = run_input(long_line)
        check('2100 字符长行精确传输', received[0][0]['content'] == long_line)

        received, _ = run_input('粘贴第一行\n粘贴第二行', 2)
        check('多行粘贴逐行排队且内容完整',
              [item[0]['content'] for item in received] == ['粘贴第一行', '粘贴第二行'])

        # 验证缩放后重新绘制的编辑行及实际提交内容，不用进程存活代替显示断言。
        send('缩放编辑测试')
        pump()
        resize(40)
        resize(100)
        current = screen.display[screen.cursor.y].rstrip()
        check('缩放后短编辑行及光标位置', current == '> 缩放编辑测试'
              and screen.cursor.x == 14, repr((current, screen.cursor.x)))
        received, _ = run_input('\x7f完成')
        check('缩放后中文退格与提交', received[0][0]['content'] == '缩放编辑测完成')

        long_edit = '长编辑' * 25
        send(long_edit)
        pump()
        resize(40)
        resize(100)
        rows = screen.display[screen.cursor.y - 1:screen.cursor.y + 1]
        check('长编辑行缩放后内容及光标', ''.join(row.rstrip() for row in rows) == '> ' + long_edit
              and screen.cursor.x == 52, repr((rows, screen.cursor.x)))
        received, _ = run_input('\x7f改')
        check('长编辑行缩放后退格提交', received[0][0]['content'] == long_edit[:-1] + '改')

        offset = len(output)
        send('生成期间编辑\n')
        assert started.wait(5), '模拟服务未收到生成请求'
        receive()
        send('下一条错')
        pump()
        release.set()
        wait_for('完成，共 1 轮', offset)
        pump()
        current = screen.display[screen.cursor.y].rstrip()
        check('生成结束后保留正在编辑的输入', current == '> 下一条错', repr(screen.display))
        check('生成输出不混入编辑行', any(line.rstrip() == '模型输出第一行' for line in screen.display),
              repr(screen.display))
        received, _ = run_input('\x7f对')
        check('生成期间编辑和退格后的输入精确传输', received[0][0]['content'] == '下一条对',
              repr(received[0]))

        started.clear()
        release.clear()
        offset = len(output)
        send('生成期间编辑\n')
        receive()
        assert started.wait(5), '模拟服务未收到生成请求'
        send(long_edit + '\x1b[D\x1b[D')
        pump()
        release.set()
        wait_for('完成，共 1 轮', offset)
        pump()
        rows = screen.display[screen.cursor.y - 1:screen.cursor.y + 1]
        check('生成后长编辑行及中间光标保留', ''.join(row.rstrip() for row in rows) == '> ' + long_edit
              and screen.cursor.x == 48, repr((rows, screen.cursor.x)))
        check('长编辑行不覆盖模型输出', '模型输出第一行' in [line.rstrip() for line in screen.display])
        received, _ = run_input('插入')
        check('生成后从长编辑行中间插入', received[0][0]['content'] == long_edit[:-2] + '插入' + long_edit[-2:],
              repr(received[0]))

        received, rendered = run_input('调用工具', 2)
        check('工具开始、结果及第二轮状态', '工具: echo' in rendered and '结果: 工具中文' in rendered
              and '完成，共 2 轮' in rendered)
        check('工具调用与结果按 ID 配对', received[1][1]['tool_calls'][0]['id'] == 'call_test'
              and received[1][2] == {'role': 'tool', 'tool_call_id': 'call_test', 'content': '工具中文'})

        offset = len(output)
        send('/exit\n')
        wait_for('验收Shell> ', offset)
        check('/exit 后终端属性恢复', termios.tcgetattr(master) == before)
        # 通过文件副作用证明 Shell 真正执行，并测试退出后的退格。
        offset = len(output)
        send("printf '%s' 已恢复 > shell-proofX\x7f\n")
        wait_for('验收Shell> ', offset)
        proof = Path(directory, 'shell-proof')
        check('退出后 Shell 命令执行且退格有效', proof.exists() and proof.read_text() == '已恢复')

        offset = len(output)
        send('node ' + shlex.quote(str(entry)) + '\n')
        wait_for('生成中 Ctrl+C', offset)
        pump()
        offset = len(output)
        send('\x03')
        wait_for('验收Shell> ', offset)
        check('空闲 Ctrl+C 后终端属性恢复', termios.tcgetattr(master) == before)

        result = subprocess.run(['node', str(entry), '命令行', '中文'], cwd=directory, env=env,
                                capture_output=True, text=True, timeout=5)
        received = requests.get(timeout=5)
        check('非交互入口参数和退出状态', result.returncode == 0
              and received == [{'role': 'user', 'content': '命令行 中文'}]
              and '输入内容后回车' not in result.stdout and '完成，共 1 轮' in result.stdout)
    finally:
        release.set()
        foreground = os.tcgetpgrp(master)
        if foreground != pid:
            os.killpg(foreground, signal.SIGKILL)
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(master)
        server.shutdown()
        server.server_close()

print(f'验收结束：{len(failures)} 项失败。')
raise SystemExit(1 if failures else 0)
