"""Port of backend/tests/Unit/LangGraphStandaloneE2ETest.php. Opt-in (CODE_NODE_E2E=1): the modular package of a
Start-option workflow runs with real Python against a fake Outlook MCP server (PHP's fixtures/compiled/
fake_outlook_mcp.py): it catches the event, routes it with a code node (no LLM), records one run, and stays
quiet on the empty poll that follows."""
from __future__ import annotations

import base64
import glob
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from collections import Counter

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.start_option_graph import StartOptionGraph
from tests.unit import lg_support as S

VENV = S.VENV
FAKE = str(S.PHP_FIXTURES / 'compiled' / 'fake_outlook_mcp.py')
POLL = ("def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n")
CLASSIFY = "def run(input, call_tool):\n    return {'route': 'claim' if 'Claim' in input else 'other', 'output': input}\n"


@pytest.fixture(autouse=True)
def _opt_in():
    if os.environ.get('CODE_NODE_E2E') != '1':
        pytest.skip('Set CODE_NODE_E2E=1 to run.')
    if not os.path.isfile(VENV):
        pytest.skip('venv python missing')


def _db():
    return S.db('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
                'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
                S.LLM_DDL,
                'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
                "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1, NULL)",
                "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
                "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')",
                "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)")


def _graph() -> dict:
    raw = {'nodes': [
        {'id': '17', 'node_type': 'start', 'config': {'type': 'start', 'start_option': 5}},
        {'id': '19', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Classify',
                                                       'code': CLASSIFY, 'exits': ['claim', 'other'], 'mcp_servers': [], 'timeout_s': 30}},
        {'id': '18', 'node_type': 'output', 'config': {'type': 'output'}},
        {'id': '20', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [
        {'from_node_id': '17', 'to_node_id': '19', 'from_port': 'output_1'},
        {'from_node_id': '19', 'to_node_id': '18', 'from_port': 'output_1'},
        {'from_node_id': '19', 'to_node_id': '20', 'from_port': 'output_2'},
    ]}
    return StartOptionGraph.expand(raw, lambda i: {'name': 'Outlook: get new email', 'code': POLL,
        'exits': ['new_mail', 'no_mail'], 'mcp_servers': ['Outlook'], 'timeout_s': 30,
        'start_trigger': {'label': 'Outlook: get new email', 'work_exit': 'new_mail',
                          'watch': {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}}})


def _generate(options: dict | None = None) -> dict:
    wf = Workflow({'id': 44, 'name': 'Email triage', 'user_id': '3', 'output_storage_enabled': True})
    return S.generator(_db(), _graph(), wf).generate(44, '3', {'modular': True} if options is None else options)


def _free_port() -> int:
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _start_fake(callLog: str, *extra) -> tuple:
    port = _free_port()
    fake = subprocess.Popen([VENV, FAKE, str(port), callLog, *extra], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(('127.0.0.1', port), timeout=1).close()
            return fake, port
        except OSError:
            time.sleep(0.1)
    fake.kill()
    pytest.fail('the fake Outlook server never started listening')


class _Reader:
    """Collects a process's merged output in a background thread (PHP's non-blocking stream reads)."""
    def __init__(self, proc):
        self.text = ''
        self._t = threading.Thread(target=self._read, args=(proc,), daemon=True)
        self._t.start()

    def _read(self, proc):
        for chunk in iter(lambda: proc.stdout.read(1), ''):
            self.text += chunk

    def join(self):
        self._t.join(10)


def _calls(path: str, skip: int = 0) -> Counter:
    if not os.path.isfile(path):
        return Counter()
    return Counter(line for line in open(path).read().split('\n')[skip:] if line != '')


def test_quiet_wakes_of_the_single_file_print_nothing():
    d = tempfile.mkdtemp(prefix='lgstandalone_')
    fake = wf = None
    try:
        single = _generate({})
        with open(f"{d}/{single['filename']}", 'w', encoding='utf-8') as fh:
            fh.write(single['code'])
        fake, port = _start_fake(f'{d}/calls.log', 'always-ready')
        for flags in ([], ['--quiet']):
            wf = subprocess.Popen([VENV, single['filename'], *flags], cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                  env={'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''),
                                       'MCP_URL_OUTLOOK': f'http://127.0.0.1:{port}/mcp', 'SYNERGYAI_OUTPUT_ROOT': f'{d}/outputs',
                                       'PYTHONUNBUFFERED': '1'})
            reader = _Reader(wf)
            before = len([x for x in open(f'{d}/calls.log').read().split('\n') if x]) if os.path.isfile(f'{d}/calls.log') else 0
            until = time.monotonic() + 20
            now = Counter()
            while time.monotonic() < until:
                now = _calls(f'{d}/calls.log', before)
                if now['poll_new_mail'] >= 5:
                    break
                time.sleep(0.1)
            time.sleep(0.3)
            wf.send_signal(signal.SIGTERM)
            wf.wait(10)
            reader.join()
            text = reader.text
            wf = None
            print(f"\n--- single file {' '.join(flags)} ---\n{text}------------------")
            lines = [line for line in text.split('\n') if line.strip() != '']
            assert now['poll_new_mail'] >= 5, text
            assert len(lines) == 3, text
            assert lines[0].startswith('Listening for events: outlook.wait_for_new {"folder":"Inbox"} (Ctrl-C to stop)')
            assert re.match(r'^\[watch \d\d:\d\d\] Listening for events$', lines[1])
            assert lines[2] == '[watch] stopped.'
        assert glob.glob(f'{d}/runs/*.jsonl') == [], 'quiet runs leave no log'
        assert not os.path.isdir(f'{d}/outputs')
    finally:
        for p in (wf, fake):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait()
        shutil.rmtree(d, ignore_errors=True)


def test_a_compiled_watch_workflow_catches_an_event_routes_it_and_stays_quiet_afterwards():
    import json
    d = tempfile.mkdtemp(prefix='lgstandalone_')
    os.makedirs(f'{d}/pkg')
    fake = wf = None
    try:
        for f in _generate()['files']:
            os.makedirs(os.path.dirname(f"{d}/pkg/{f['path']}"), exist_ok=True)
            data = base64.b64decode(f['code']) if f.get('encoding') == 'base64' else f['code'].encode('utf-8')
            with open(f"{d}/pkg/{f['path']}", 'wb') as fh:
                fh.write(data)
        fake, port = _start_fake(f'{d}/calls.log')
        with open(f'{d}/pkg/.env', 'w') as fh:
            fh.write(f'MCP_URL_OUTLOOK=http://127.0.0.1:{port}/mcp\n')
        wf = subprocess.Popen([VENV, 'workflow.py'], cwd=f'{d}/pkg', stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                              env={'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''),
                                   'SYNERGYAI_OUTPUT_ROOT': f'{d}/outputs', 'PYTHONUNBUFFERED': '1'})
        reader = _Reader(wf)
        until = time.monotonic() + 20
        doneAt = None
        while time.monotonic() < until:
            if doneAt is None and 'Done in' in reader.text:
                doneAt = time.monotonic()
            if doneAt is not None and time.monotonic() - doneAt > 1.5:
                break
            time.sleep(0.1)
        wf.send_signal(signal.SIGTERM)
        wf.wait(10)
        reader.join()
        text = reader.text
        wf = None
        print(f'\n--- E2E stdout ---\n{text}------------------')
        assert 'Listening for events: outlook.wait_for_new' in text
        assert re.search(r'\[\d\d:\d\d\] New event — From: jane@acme\.com · Subject: Claim for water damage', text)
        assert '  ✓ Classify' in text
        assert '[watch] stopped.' in text
        logs = glob.glob(f'{d}/pkg/runs/*.jsonl')
        assert len(logs) == 1, f'one run only; the empty poll is quiet\n{text}'
        events = [json.loads(line) for line in open(logs[0]).read().split('\n') if line]
        done = [e for e in events if e['type'] == 'node_complete' and e.get('node_name') == 'Classify']
        assert len(done) == 1
        assert done[0]['exit'] == 'claim'
        assert events[-1]['type'] == 'workflow_complete'
        assert events[-1]['success'] is True
        assert len(glob.glob(f'{d}/outputs/*/*')) == 1, 'one saved output'
        calls = _calls(f'{d}/calls.log')
        assert calls['poll_new_mail'] == 2, 'one poll with mail, one quiet poll'
        assert calls['wait_for_new'] >= 1
        assert os.path.isfile(f'{d}/pkg/.run.lock'), 'the program took the run lock'
        lock = 'import fcntl, sys\nfh = open(sys.argv[1], "a+")\nfcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)\nprint("LOCKED")\n'
        r = subprocess.run([VENV, '-c', lock, f'{d}/pkg/.run.lock'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert S.exec_lines(r.stdout) == ['LOCKED'], 'the run lock is free after exit'
    finally:
        for p in (wf, fake):
            if p is not None and p.poll() is None:
                p.kill()
                p.wait()
        shutil.rmtree(d, ignore_errors=True)
