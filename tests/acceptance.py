"""当前产品联合验收：真实 CLI/PTY + 本机模拟模型；不读取用户配置，不访问真实模型。"""
import json
import os
import pty
import select
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')
REQUESTS = []
RELEASE = threading.Event()
CONTENT = '文件正文：联合验收'
SKILL = 'SKILL_ACCEPTANCE_READ_ONLY'
CONSTRAINT = '约束：不得修改文件'


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        REQUESTS.append(body)
        if not body['stream']:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            value = {'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant',
                     'content': '验收模拟摘要；约束仍以用户原文为准。'}}]}
            self.wfile.write(json.dumps(value).encode())
            return
        last = body['messages'][-1]
        text = last.get('content', '')
        calls = {
            '读取临时文件': ('read_file', {'path': 'note.txt'}),
            '坏Schema': ('read_file', {'path': 123}),
            '拒绝写入': ('apply_edit', {'path': 'note.txt', 'before': CONTENT, 'after': '不应写入'}),
            '规划强制写入': ('apply_edit', {'path': 'note.txt', 'before': CONTENT, 'after': '不应写入'}),
            '保存待办': ('todo_add', {'text': '验收待办'}),
            '搜索缺配置': ('search_web', {'query': 'Node.js'}),
            '调用MCP': ('mcp_demo_demo_status', {}),
        }
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def chunk(delta, finish=None):
            value = {'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
            self.wfile.flush()

        try:
            if last['role'] == 'tool':
                chunk({'content': '实际工具结果：' + text}, 'stop')
            elif text in ('等待取消', '子任务等待'):
                chunk({'content': '等待中的片段\n'})
                RELEASE.wait(10)
                return
            elif text in calls or text == '坏JSON':
                name, args = calls.get(text, ('read_file', {}))
                arguments = '{invalid' if text == '坏JSON' else json.dumps(args)
                chunk({'tool_calls': [{'index': 0, 'id': 'acceptance-call', 'type': 'function',
                      'function': {'name': name, 'arguments': arguments}}]}, 'tool_calls')
            else:
                chunk({'content': '流式第一段。'})
                chunk({'content': 'L' * 70000 if text == '长回答' else '流式第二段。'}, 'stop')
            usage = {'choices': [], 'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5}}
            self.wfile.write(('data: ' + json.dumps(usage) + '\n\ndata: [DONE]\n\n').encode())
        except (BrokenPipeError, ConnectionResetError):
            pass


SERVER = ThreadingHTTPServer(('127.0.0.1', 0), Model)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()


def until(predicate, timeout=10):
    end = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < end, '等待状态超时'
        time.sleep(.02)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class Terminal:
    def __init__(self, cwd, extra=None, prelude=None):
        env = dict(os.environ)
        for key in ('LCN_AGENT_EXTENSION', 'LCN_AGENT_MCP_DEMO', 'LCN_AGENT_MCP_HTTP_URL', 'TAVILY_API_KEY'):
            env.pop(key, None)
        env.update(extra or {})
        self.output = bytearray()
        self.master, slave = pty.openpty()
        args = [NODE] + (['--import', str(prelude)] if prelude else []) + [str(ROOT / 'dist/cli.js')]
        self.child = subprocess.Popen(args, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        self.wait('生成中 Ctrl+C 取消')

    def wait(self, text, offset=0):
        end = time.monotonic() + 10
        while text.encode() not in self.output[offset:]:
            assert time.monotonic() < end, self.output.decode(errors='replace')[-2500:]
            if select.select([self.master], [], [], .1)[0]:
                try:
                    self.output.extend(os.read(self.master, 65536))
                except OSError:
                    raise AssertionError(self.output.decode(errors='replace')[-2500:])
        return self.output[offset:].decode(errors='replace')

    def send(self, text, expected):
        offset = len(self.output)
        os.write(self.master, (text + '\n').encode())
        return self.wait(expected, offset)

    def cancel(self):
        offset = len(self.output)
        os.write(self.master, b'\x03')
        return self.wait('已取消', offset)

    def close(self):
        try:
            self.send('/exit', '终端程序已退出')
            assert self.child.wait(timeout=5) == 0
        finally:
            self.abort()

    def abort(self):
        if self.child.poll() is None:
            self.child.kill()
            self.child.wait()
        if self.master is not None:
            os.close(self.master)
            self.master = None


def config(cwd, port=SERVER.server_port):
    (cwd / 'config.toml').write_text(
        f'apiKey="fixture-model-key"\nbaseURL="http://127.0.0.1:{port}/v1"\nmodel="fixture"\n')


def history(path):
    return [entry['message'] for line in path.read_text().splitlines()
            if (entry := json.loads(line))['type'] == 'message']


ui = None
try:
    with tempfile.TemporaryDirectory(prefix='lcn-acceptance-') as folder:
        cwd = Path(folder)
        config(cwd)
        (cwd / 'note.txt').write_text(CONTENT)
        skill_dir = cwd / '.agents/skills/acceptance'
        skill_dir.mkdir(parents=True)
        (skill_dir / 'SKILL.md').write_text(
            '---\nname: acceptance\ndescription: 联合验收只读说明\n---\n' + SKILL)
        extension = cwd / 'fixture.mjs'
        extension.write_text('''import { appendFileSync } from 'node:fs';
export default api => {
  api.registerCommand({ name: 'acceptance_extension', execute: () => '外部扩展可用' });
  api.onAgentEnd(() => appendFileSync('extension-events.txt', 'event\\n'));
};
''')
        extra = {'LCN_AGENT_EXTENSION': str(extension), 'LCN_AGENT_MCP_DEMO': '1'}
        ui = Terminal(cwd, extra)
        ui.send(CONSTRAINT, '完成，共 1 轮')
        first = REQUESTS[-1]
        assert SKILL not in json.dumps(first, ensure_ascii=False)
        defaults = {'echo', 'read_file', 'todo_add', 'read_web', 'search_web', 'run_subagent'}
        assert defaults.issubset({t['function']['name'] for t in first['tools']})
        response = ui.send('第二轮对话', '完成，共 1 轮')
        assert '流式第一段。流式第二段。' in response
        assert any(m['content'] == CONSTRAINT for m in REQUESTS[-1]['messages'])
        assert any(m['role'] == 'assistant' for m in REQUESTS[-1]['messages'])
        session = next((cwd / '.lcn-agent/sessions').glob('*.jsonl'))
        ui.send('读取临时文件', '[y/N]')
        ui.send('y', '完成，共 2 轮')
        assert REQUESTS[-1]['messages'][-1]['content'] == CONTENT
        assert CONTENT in ui.output.decode()
        for invalid in ('坏JSON', '坏Schema'):
            output = ui.send(invalid, '完成，共 2 轮')
            assert '[y/N]' not in output
            assert REQUESTS[-1]['messages'][-1]['role'] == 'tool'
            assert '失败' in REQUESTS[-1]['messages'][-1]['content']
        ui.send('拒绝写入', '[y/N]')
        ui.send('n', '完成，共 2 轮')
        assert '未获授权' in REQUESTS[-1]['messages'][-1]['content']
        assert (cwd / 'note.txt').read_text() == CONTENT
        ui.send('/mode plan', '当前模式：plan')
        output = ui.send('规划强制写入', '完成，共 2 轮')
        assert '[y/N]' not in output
        assert all(t['function']['name'] != 'apply_edit' for t in REQUESTS[-1]['tools'])
        assert '未获授权' in REQUESTS[-1]['messages'][-1]['content']
        assert (cwd / 'note.txt').read_text() == CONTENT
        ui.send('/mode execute', '当前模式：execute')
        ui.send('保存待办', '[y/N]')
        ui.send('y', '完成，共 2 轮')
        todo = cwd / '.lcn-agent/todos' / (session.name + '.json')
        saved_todo = todo.read_bytes()
        ui.send('调用MCP', '[y/N]')
        ui.send('y', '完成，共 2 轮')
        assert '本地 MCP 服务已连通' in REQUESTS[-1]['messages'][-1]['content']
        ui.send('搜索缺配置', '[y/N]')
        ui.send('y', '完成，共 2 轮')
        assert '请配置 TAVILY_API_KEY' in REQUESTS[-1]['messages'][-1]['content']
        ui.send('等待取消', '等待中的片段')
        count = len(REQUESTS)
        ui.cancel()
        assert len(REQUESTS) == count
        assert all('等待中的片段' not in m.get('content', '') for m in history(session))
        ui.send('取消后恢复', '完成，共 1 轮')
        before_resume = session.read_bytes()
        ui.close()
        ui = Terminal(cwd, extra)
        count = len(REQUESTS)
        ui.send('/resume ' + session.name, '已恢复：')
        ui.send('/todo_list', '验收待办')
        assert len(REQUESTS) == count and todo.read_bytes() == saved_todo
        assert session.read_bytes() == before_resume
        ui.send('恢复后继续', '完成，共 1 轮')
        assert any(m['content'] == CONSTRAINT for m in REQUESTS[-1]['messages'])
        print('通过 1–5、7–8、12：多轮/读取/非法参数/取消/恢复/计划权限/拒绝写入/缺配置提示', flush=True)

        # 独立长会话同时验证 Skills 渐进加载与压缩后保留约束，原 JSONL 不删改。
        ui.send('/new', '会话：')
        ui.send(CONSTRAINT, '完成，共 1 轮')
        ui.send('/skill acceptance', '已激活 Skill：acceptance')
        ui.send('长回答', '完成，共 1 轮')
        assert json.dumps(REQUESTS[-1], ensure_ascii=False).count(SKILL) == 1
        long_session = next(p for p in (cwd / '.lcn-agent/sessions').glob('*.jsonl') if p != session)
        original = long_session.read_bytes()
        offset = len(REQUESTS)
        ui.send('压缩后提问', '完成，共 1 轮')
        assert any(not r['stream'] for r in REQUESTS[offset:])
        sent = json.dumps(REQUESTS[-1]['messages'], ensure_ascii=False)
        assert SKILL in sent and CONSTRAINT in sent and '验收模拟摘要' in sent
        assert 'L' * 70000 not in sent
        assert long_session.read_bytes().startswith(original)
        assert any('L' * 70000 in m['content'] for m in history(long_session))
        print('通过 9：Skill 按需加载、阈值自动压缩、约束保留、原始历史完整', flush=True)

        ui.send('/task_limit 2', '并发上限：2')
        ui.send('/task_start 读取临时文件', '已启动后台任务：')
        state = cwd / '.lcn-agent/background_tasks' / (long_session.name + '.json')
        def tasks():
            return json.loads(state.read_text())['items']
        until(lambda: tasks()[0]['status'] == 'awaiting_approval')
        item = tasks()[0]
        ui.send('/task_start 子任务等待', '已启动后台任务：')
        until(lambda: len(tasks()) == 2 and tasks()[1].get('pid') is not None)
        wait_task = tasks()[1]
        ui.send('/task_start 第三个任务', '并发上限 2')
        assert len(tasks()) == 2
        ui.send('/task_approve ' + item['id'] + ' ' + item['pending']['approvalId'], '已批准本次读取')
        until(lambda: tasks()[0]['status'] == 'completed')
        assert CONTENT in json.loads(tasks()[0]['result'])['content']
        assert tasks()[0]['reportedUsage']['totalTokens'] == 10
        assert tasks()[0]['unreportedRounds'] == 0 and tasks()[0]['round'] == 2
        assert not alive(item['pid']) and alive(wait_task['pid'])
        ui.send('/task_cancel ' + wait_task['id'], '后台任务已停止并回收子进程')
        assert not alive(wait_task['pid']) and tasks()[1]['status'] == 'cancelled'
        records = [json.loads(line) for p in (cwd / '.lcn-agent/diagnostics').rglob('*.jsonl')
                   if p.is_file() for line in p.read_text().splitlines()]
        assert any(r.get('callId') == item['id'] and r.get('kind') == 'model' for r in records)
        print('通过 11：后台任务关联、双任务名额、审批、准确模拟用量、取消与 PID 回收', flush=True)

        # 外部扩展按现有重启装载契约验收；禁用后没有命令和订阅残留。
        ui.send('/extensions disable external', '已保存 external：禁用')
        ui.close()
        events = cwd / 'extension-events.txt'
        before = events.read_bytes()
        ui = Terminal(cwd, extra)
        ui.send('/acceptance_extension', '未知命令')
        ui.send('禁用扩展后对话', '完成，共 1 轮')
        assert events.read_bytes() == before
        ui.send('/extensions enable external', '已保存 external：启用')
        ui.close()
        for _ in range(2):
            ui = Terminal(cwd, extra)
            ui.send('/acceptance_extension', '外部扩展可用')
            before = events.read_text().splitlines()
            ui.send('重载后对话', '完成，共 1 轮')
            # 完成提示先于扩展通知输出；下一条命令返回才说明该轮的同步订阅已全部执行。
            ui.send('/acceptance_extension', '外部扩展可用')
            assert len(events.read_text().splitlines()) == len(before) + 1
            ui.close()
        ui = None
        assert not (cwd / '.lcn-agent/sessions/.writer.lock').exists()
        print('通过 6：外部模块装载、重启禁用无命令/订阅残留、多次重载无重复订阅', flush=True)

    # 复用已有网络夹具，额外验收真实终端 execute/plan 下恶意内容、失败与日志脱敏。
    for mode in ('execute', 'plan'):
        with tempfile.TemporaryDirectory(prefix='lcn-network-acceptance-') as folder:
            cwd = Path(folder)
            config(cwd, 1)
            ui = Terminal(cwd, prelude=ROOT / 'tests/network-fixture.mjs')
            if mode == 'plan':
                ui.send('/mode plan', '当前模式：plan')
            ui.send('网络联合验收', '[y/N]')
            ui.send('y', '[y/N]')
            ui.send('y', '[y/N]')
            if mode == 'execute':
                ui.send('n', '[y/N]')
            ui.send('y', '[y/N]')
            ui.send('y', '完成，共 5 轮')
            assert not (cwd / 'marker.txt').exists()
            for secret in ('PRIVATE_NETWORK_ERROR', 'fixture-search-key', 'fixture-model-key'):
                assert secret.encode() not in ui.output
            ui.close()
            ui = None
    print('通过 10：MCP 宿主调用；网页/搜索的恶意内容权限、双故障回填和日志脱敏', flush=True)
    print(f'十二项终端联合验收通过（本机模拟模型，共 {len(REQUESTS)} 次模型/摘要请求）', flush=True)
finally:
    if ui and ui.master is not None:
        ui.abort()
    RELEASE.set()
    SERVER.shutdown()
    SERVER.server_close()
