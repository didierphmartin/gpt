"""Port of backend/tests/Unit/AdkCodeNodeE2ETest.php as a reusable base: a compiled script with code nodes
RUNS (the runner venv) against a fake MCP server (backend/tests/fixtures/fake_mcp_server.py).

Opt-in, as in PHP: each target's subclass names its env flag (ADK_E2E, MAF_E2E, NOOA_E2E) and overrides the
hooks emit / packageFiles / packageSources / a2aPackage / generatorClass; the scenarios are the same.
"""
from __future__ import annotations

import glob
import json
import os
import random
import re
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request

import pytest

from app.agent_team.services.agent_repository import AgentRepository
from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.run_server_emitter import RunServerEmitter
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.agent_team.services.workflow_graph_repository import WorkflowGraphRepository
from app.agent_team.services.workflow_repository import WorkflowRepository
from tests.unit.lg_support import PHP_FIXTURES, VENV
from tests.unit.playbook.conftest import SqliteDb

PY = VENV
FILE = ("def run(input, call_tool):\n    call_tool('outlook', 'move_mail', {'id': input['id'], 'folder': 'Inbox/' + NODE_NAME})\n"
        "    return {'output': 'filed ' + input['subject']}\n")
TRIGGER = ("def run(input, call_tool):\n    m = call_tool('outlook', 'next_mail', {})\n"
           "    return {'route': 'new_mail' if m else 'no_mail', 'output': m}\n")


def _tmp(prefix: str) -> str:
    d = os.path.join(tempfile.gettempdir(), prefix + secrets.token_hex(4))
    os.makedirs(d, exist_ok=True)
    return d


def _free_port() -> int:
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _env(extra: dict | None = None) -> dict:
    return {'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''), **(extra or {})}


def _write_files(d: str, files: list) -> None:
    for f in files:
        path = os.path.join(d, f['path'])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(f['code'])


class CompiledE2EBase:
    """The scenarios; a subclass named Test... runs them for one target."""
    ENV_FLAG = 'ADK_E2E'

    # ---- the target under test (MAF / NOOA subclasses override these) ----

    def emit(self, analyzed: dict) -> str:
        raise NotImplementedError

    def packageFiles(self, analyzed: dict) -> list:
        raise NotImplementedError

    def packageSources(self, analyzed: dict) -> list:
        """[workflow.py, common.py, agents/ files] of the package ("agents in separate files")."""
        raise NotImplementedError

    def a2aPackage(self, analyzed: dict) -> dict:
        raise NotImplementedError

    def generatorClass(self):
        raise NotImplementedError

    # ---- fixtures ----

    @pytest.fixture(autouse=True)
    def _setup(self):
        if os.environ.get(self.ENV_FLAG) != '1':
            pytest.skip(f'Set {self.ENV_FLAG}=1 to run.')
        if not os.path.isfile(PY):
            pytest.skip('venv python missing')
        self.server = None
        self.api = None
        self.log = ''
        self.url = ''
        yield
        for p in (self.api, self.server):
            if p is not None:
                p.kill()
                p.wait()

    def startServer(self, empty: bool = False, mode: str = '') -> None:
        port = _free_port()
        self.log = os.path.join(tempfile.gettempdir(), f'adk_e2e_{secrets.token_hex(4)}.jsonl')
        args = ['python3', str(PHP_FIXTURES / 'fake_mcp_server.py'), str(port), self.log]
        if empty or mode != '':
            args.append('empty' if empty else mode)
        self.server = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.url = f'http://127.0.0.1:{port}'
        for _ in range(50):
            try:
                socket.create_connection(('127.0.0.1', port), 0.1).close()
                return
            except OSError:
                time.sleep(0.1)
        pytest.fail('fake MCP server did not start')

    def analyzed(self, branchCode: str) -> dict:
        """Start -> trigger T (new_mail | no_mail) -> branch B (on new_mail) -> Output; no LLM node."""
        graph = {'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
            {'id': '10', 'type': 'code', 'config': {'type': 'code', 'name': 'T', 'code': TRIGGER,
                                                    'exits': ['new_mail', 'no_mail'], 'mcp_servers': ['Outlook'], 'timeout_s': 30}},
            {'id': '3', 'type': 'code', 'config': {'type': 'code', 'name': 'B', 'code': branchCode,
                                                   'exits': ['next'], 'mcp_servers': ['Outlook'], 'timeout_s': 30}},
            {'id': '5', 'type': 'output', 'config': {'type': 'output'}},
        ], 'edges': [
            {'from': '1', 'to': '10', 'from_port': 'output_1'},
            {'from': '10', 'to': '3', 'from_port': 'output_1'},
            {'from': '3', 'to': '5', 'from_port': 'output_1'},
        ]}
        a = {**WorkflowGraphAnalyzer.analyzeGraph(graph),
             'workflow': {'id': 99, 'name': 'adk e2e'}, 'usedCatalog': {}, 'usedServers': {},
             'serverSlugs': {self.url: 'outlook'}, 'startPrompt': 'go', 'startDocuments': [],
             'agents': {}, 'playbooks': {}}
        by_id = {n['id']: n for n in graph['nodes']}
        a['code'] = {cid: CodeNodeEmit.nodeData(by_id[cid], graph['edges'], {'outlook': self.url}, ['1', '10', '3', '5'])
                     for cid in ('10', '3')}
        return a

    def run_(self, analyzed: dict, env_text: str = 'MCP_HEADERS_OUTLOOK={"X-Outlook-Account":"acc-1"}\n') -> tuple:
        d = _tmp('adk_e2e_')
        with open(os.path.join(d, 'workflow.py'), 'w', encoding='utf-8') as f:
            f.write(self.emit(analyzed))
        with open(os.path.join(d, '.env'), 'w', encoding='utf-8') as f:
            f.write(env_text)
        r = subprocess.run([PY, 'workflow.py', 'go'], cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=_env())
        print(f'\n--- E2E output ({d}) ---\n{r.stdout}\n')
        return r.returncode, r.stdout

    def calls(self) -> list:
        if not os.path.isfile(self.log):
            return []   # no request yet: no log file
        with open(self.log, encoding='utf-8') as f:
            return [json.loads(line) for line in f if line.strip()]

    def _moves(self) -> list:
        return [c for c in self.calls() if c.get('tool') == 'move_mail']

    @staticmethod
    def finalAnswer(text: str) -> str:
        """The run's answer as printed: after "FINAL OUTPUT" (MAF, NOOA) or "[workflow] done" (ADK), up to RUN SUMMARY."""
        i = text.rfind('FINAL OUTPUT')
        i = i if i != -1 else text.rfind('[workflow] done')
        assert i != -1, f'no final answer in:\n{text}'
        j = text.find('RUN SUMMARY', i)
        return text[i:(j if j != -1 else len(text))]

    # ---- the single file ----

    def test_routes_files_and_sends_headers(self):
        self.startServer()
        rc, text = self.run_(self.analyzed(FILE))
        assert rc == 0, text
        assert 'filed test 50' in text
        moves = self._moves()
        assert len(moves) == 1
        assert moves[0]['args']['folder'] == 'Inbox/B'
        for c in self.calls():
            assert (c.get('headers') or {}).get('x-outlook-account') == 'acc-1', json.dumps(c)

    def test_the_code_reads_its_arguments(self):
        """A node's arguments (a component's settings, a Start option's Start args) reach its code as ARGS."""
        self.startServer()
        a = self.analyzed("def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n")
        a['code']['3']['args'] = {'folder': 'Didier'}
        rc, text = self.run_(a)
        assert rc == 0, text
        assert 'folder=Didier' in text

    def test_the_output_takes_a_node_once_and_only_through_the_exit_it_took(self):
        def code(name, txt):
            return {'type': 'code', 'name': name, 'exits': ['done', 'error'], 'mcp_servers': [], 'timeout_s': 30,
                    'code': f"def run(input, call_tool):\n    return {{'route': 'done', 'output': '{txt}'}}\n"}
        graph = {'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
            {'id': '2', 'type': 'code', 'config': code('Convert', 'PACKAGE')},
            {'id': '5', 'type': 'code', 'config': code('Store', 'STORED')},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ], 'edges': [
            {'from': '1', 'to': '2', 'from_port': 'output_1'},
            {'from': '2', 'to': '5', 'from_port': 'output_1'},
            {'from': '2', 'to': '3', 'from_port': 'output_2'},
            {'from': '5', 'to': '3', 'from_port': 'output_1'},
            {'from': '5', 'to': '3', 'from_port': 'output_2'},
        ]}
        a = {**WorkflowGraphAnalyzer.analyzeGraph(graph),
             'workflow': {'id': 99, 'name': 'adk e2e'}, 'usedCatalog': {}, 'usedServers': {},
             'serverSlugs': {}, 'startPrompt': 'go', 'startDocuments': [], 'agents': {}, 'playbooks': {}}
        by_id = {n['id']: n for n in graph['nodes']}
        a['code'] = {cid: CodeNodeEmit.nodeData(by_id[cid], graph['edges'], {}, ['1', '2', '5', '3']) for cid in ('2', '5')}
        rc, text = self.run_(a)
        assert rc == 0, text
        assert 'STORED' in text
        assert 'PACKAGE' not in self.finalAnswer(text), text
        assert self.finalAnswer(text).count('STORED') == 1, text

    def test_no_mail_skips_everything_downstream(self):
        self.startServer(True)
        rc, text = self.run_(self.analyzed(FILE))
        assert rc == 0, text
        assert 'skipped (its branch was not taken)' in text
        assert re.search(r'\[workflow\] done in [0-9.]+s, 0 chars|Final output: 0 chars', text)
        assert self._moves() == []

    def test_failing_code_stops_the_run(self):
        self.startServer()
        rc, text = self.run_(self.analyzed("def run(input, call_tool):\n    return call_tool('other', 'x', {})\n"))
        assert rc != 0, text
        assert "code node 'B' failed" in text

    # ---- the listening package ----

    def writeListeningPackage(self, a: dict | None = None, startMode: str = 'watch') -> str:
        """The E2E graph as a listening package (watch on outlook.wait_for_new), written to a folder."""
        if a is None:
            # the branch takes 3 s, as a real one does: /live sends a run it sees in progress
            a = self.analyzed('import time\n' + FILE + '\n# slow\n')
            a['code']['3']['source'] = a['code']['3']['source'].replace(
                'def run(input, call_tool):\n', 'def run(input, call_tool):\n    time.sleep(3)\n')
        a['startMode'] = startMode
        a['defaultWatch'] = {'server': 'outlook', 'tool': 'wait_for_new', 'args': []}
        a['package'] = True
        workflowPy, commonPy, nodeFiles = self.packageSources(a)
        pkg = RunServerEmitter.package({'code': workflowPy}, 'adk e2e', 'e2e', 'run server', commonPy, True)
        d = _tmp('adk_listen_')
        _write_files(d, list(pkg['files']) + list(nodeFiles) + list(self.packageFiles(a)))
        with open(os.path.join(d, '.env'), 'w', encoding='utf-8') as f:
            f.write('MCP_HEADERS_OUTLOOK={"X-Outlook-Account":"acc-1"}\nJEV_API_KEY=jev-test-key\n')
        return d

    def startApi(self, d: str) -> str:
        port = _free_port()
        log = open(os.path.join(d, 'api.log'), 'w')
        self.api = subprocess.Popen([PY, 'api.py', '--port', str(port)], cwd=d, stdout=log, stderr=log, env=_env())
        base = f'http://127.0.0.1:{port}'
        for _ in range(100):
            try:
                urllib.request.urlopen(f'{base}/.well-known/workflow.json', timeout=2).read()
                return base
            except Exception:  # noqa: BLE001
                time.sleep(0.2)
        pytest.fail('api.py did not start:\n' + open(os.path.join(d, 'api.log')).read())

    @staticmethod
    def post(url: str, body: dict) -> tuple:
        req = urllib.request.Request(url, data=json.dumps(body or {}).encode() if body else b'{}',
                                     headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read() or b'null')
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b'null')
            except ValueError:
                return e.code, None

    @staticmethod
    def live(base: str, seconds: int) -> str:
        """GET /live for `seconds`: the SSE text (curl: the stream is chunked and never ends on its own)."""
        r = subprocess.run(['curl', '-s', '-N', '-m', str(seconds), f'{base}/live'], capture_output=True, text=True)
        return r.stdout

    @staticmethod
    def runEvents(d: str) -> list:
        out = []
        for f in glob.glob(f'{d}/runs/*.jsonl'):
            with open(f, encoding='utf-8') as fh:
                out += [json.loads(line) for line in fh if line.strip()]
        return out

    def test_package_listens_records_and_stops(self):
        self.startServer()
        d = self.writeListeningPackage()
        base = self.startApi(d)
        live_out = open(os.path.join(d, 'live.txt'), 'w')
        live = subprocess.Popen(['curl', '-s', '-N', '-m', '20', f'{base}/live'], stdout=live_out)
        time.sleep(0.5)
        code, r = self.post(f'{base}/listen', {})
        assert code == 200, json.dumps(r)
        assert r['listening'] is True
        events = []
        for _ in range(150):
            events = self.runEvents(d)
            if 'workflow_complete' in [e['type'] for e in events]:
                break
            time.sleep(0.2)
        done = [e for e in events if e['type'] == 'workflow_complete']
        assert done, 'no completed run:\n' + open(os.path.join(d, 'api.log')).read()
        assert done[0]['success'] is True, json.dumps(done[0])
        for _ in range(50):
            if len(glob.glob(f'{d}/runs/*.jsonl')) == 1:
                break
            time.sleep(0.2)
        completed: dict = {}
        for e in self.runEvents(d):
            if e['type'] == 'node_complete':
                completed[str(e['node_id'])] = e
        assert list(completed) == ['1', '10', '3', '5']
        assert completed['10']['exit'] == 'new_mail'
        assert completed['1']['node_type'] == 'start'
        for _ in range(50):
            if len(glob.glob(f'{d}/runs/*.jsonl')) == 1:
                break
            time.sleep(0.2)
        assert len(glob.glob(f'{d}/runs/*.jsonl')) == 1, "the drain's second, quiet run leaves no file"
        assert len(self._moves()) == 1
        live.wait()   # curl ends at -m 20
        live_out.close()
        stream = open(os.path.join(d, 'live.txt')).read()
        assert re.search(r'event: run\ndata: .*"node_id":\s*"10"', stream)
        assert re.search(r'"type":\s*"workflow_complete"', stream)
        code, _ = self.post(f'{base}/runs', {'prompt': 'x'})
        assert code == 409
        self.post(f'{base}/listen', {'stop': True})
        state = ''
        for _ in range(10):
            if 'Not listening: stopped' in state:
                break
            time.sleep(1)
            state = self.live(base, 2)
        assert 'Not listening: stopped' in state

    def test_quiet_wake_leaves_no_run(self):
        self.startServer(True)
        d = self.writeListeningPackage()
        base = self.startApi(d)
        self.post(f'{base}/listen', {})
        for _ in range(50):
            if [c for c in self.calls() if c.get('tool') == 'next_mail']:
                break
            time.sleep(0.2)
        time.sleep(2)   # the run after the wake has ended
        assert glob.glob(f'{d}/runs/*.jsonl') == [], 'a quiet run leaves no run file'
        assert re.search(r'"listening":\s*true', self.live(base, 2))

    # ---- Jev routing ----

    def jevAnalyzed(self, unclearBranch: str = '') -> dict:
        """Start -> trigger T -> dispatcher D (Jev) -> code A | code B -> Output; no LLM turn at all."""
        file = ("def run(input, call_tool):\n    call_tool('outlook', 'move_mail', {'id': input['id'], 'folder': 'Inbox/' + NODE_NAME})\n"
                "    return 'filed ' + input['subject']\n")

        def code(id_, name, src, exits):
            return {'id': id_, 'type': 'code', 'config': {'type': 'code', 'name': name, 'code': src, 'exits': exits,
                                                         'mcp_servers': ['Outlook'], 'timeout_s': 30}}
        graph = {'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
            code('10', 'T', TRIGGER, ['new_mail', 'no_mail']),
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'D', 'agent_type': 'dispatcher', 'provider': 'claude', 'model': 'm'}},
            code('3', 'A', file, ['next']),
            code('4', 'B', file, ['next']),
            {'id': '5', 'type': 'output', 'config': {'type': 'output'}},
        ], 'edges': [
            {'from': '1', 'to': '10', 'from_port': 'output_1'}, {'from': '10', 'to': '2', 'from_port': 'output_1'},
            {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'}, {'from': '3', 'to': '5'}, {'from': '4', 'to': '5'},
        ]}
        a = {**WorkflowGraphAnalyzer.analyzeGraph(graph),
             'workflow': {'id': 98, 'name': 'adk jev'}, 'usedCatalog': {}, 'usedServers': {},
             'serverSlugs': {self.url: 'outlook'}, 'startPrompt': 'go', 'startDocuments': [], 'playbooks': {},
             'agents': {'2': {'name': 'D', 'systemPrompt': 'Route the email.', 'provider': 'claude', 'model': 'm',
                              'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '',
                              'output_schema_id': None, 'documents': []}},
             'decisions': {'2': {'decision_question': 'Which team handles this email?', 'routing_mode': 'jev',
                                 'unclear_branch': unclearBranch, 'min_confidence': 0.6,
                                 'decision': [{'provider': 'jev', 'protocol': 'typesafe', 'url': self.url + '/systemone',
                                               'model': 'jev-latest', 'key_env': 'JEV_API_KEY', 'url_env': 'JEV_BASE_URL'}]}}}
        by_id = {n['id']: n for n in graph['nodes']}
        a['code'] = {cid: CodeNodeEmit.nodeData(by_id[cid], graph['edges'], {'outlook': self.url}, list(by_id))
                     for cid in ('10', '3', '4')}
        return a

    def runJev(self, analyzed: dict) -> tuple:
        return self.run_(analyzed, 'MCP_HEADERS_OUTLOOK={"X-Outlook-Account":"acc-1"}\nJEV_API_KEY=jev-test-key\n')

    def test_jev_routes_without_an_llm_turn(self):
        self.startServer(False, 'claim')
        rc, text = self.runJev(self.jevAnalyzed())
        assert rc == 0, text
        assert "jev routed to 'B' (confidence 0.97" in text
        jev = [c for c in self.calls() if c.get('method') == 'jev']
        assert len(jev) == 1
        assert jev[0]['headers']['authorization'] == 'Bearer jev-test-key'
        assert jev[0]['criteria'] == ['A', 'B', 'unclear']
        assert 'my car claim' in jev[0]['request']
        moves = self._moves()
        assert moves[0]['args'].get('folder') == 'Inbox/B'
        assert len(moves) == 1

    def test_unclear_stops_as_not_classified(self):
        self.startServer()
        rc, text = self.runJev(self.jevAnalyzed())
        assert rc == 0, text
        assert 'Not classified: dispatcher "D" did not route the request (jev: unclear' in text
        assert self._moves() == []

    def test_unclear_goes_to_the_unclear_branch(self):
        self.startServer()
        rc, text = self.runJev(self.jevAnalyzed('A'))
        assert rc == 0, text
        assert "sent to the unclear branch 'A'" in text
        assert self._moves()[0]['args'].get('folder') == 'Inbox/A'

    def completedRun(self, d: str) -> list:
        """Waits for a completed, recorded run in the package's runs/; returns its events."""
        for _ in range(150):
            for f in glob.glob(f'{d}/runs/*.jsonl'):
                with open(f, encoding='utf-8') as fh:
                    ev = [json.loads(line) for line in fh if line.strip()]
                if 'workflow_complete' in [e['type'] for e in ev]:
                    return ev
            time.sleep(0.2)
        pytest.fail('no recorded run:\n' + open(os.path.join(d, 'api.log')).read())

    def test_listening_not_classified_is_recorded(self):
        self.startServer()
        d = self.writeListeningPackage(self.jevAnalyzed())
        base = self.startApi(d)
        self.post(f'{base}/listen', {})
        ev = self.completedRun(d)
        done = [e for e in ev if e['type'] == 'workflow_complete'][0]
        assert done['success'] is True
        assert 'Not classified: dispatcher "D"' in str(done['output'])
        dn = [e for e in ev if e['type'] == 'node_complete' and str(e['node_id']) == '2']
        assert dn[0]['success'] is True

    def test_listening_jev_error_is_recorded(self):
        self.startServer(False, 'claim')
        a = self.jevAnalyzed()
        a['decisions']['2']['decision'] = []   # routing names jev, but no jev provider was compiled in
        d = self.writeListeningPackage(a)
        base = self.startApi(d)
        self.post(f'{base}/listen', {})
        ev = self.completedRun(d)
        dn = [e for e in ev if e['type'] == 'node_complete' and str(e['node_id']) == '2']
        assert dn[0]['success'] is False
        assert 'Error: dispatcher "D" did not route the request (jev: unavailable' in str(dn[0]['error'])
        done = [e for e in ev if e['type'] == 'workflow_complete'][0]
        assert 'Error: dispatcher "D"' in str(done['output'])

    def test_other_parent_still_reaches_the_node(self):
        """Review I2: a node runs when one parent reached it, even if another parent's exit went elsewhere."""
        self.startServer()

        def code(id_, name, src, exits):
            return {'id': id_, 'type': 'code', 'config': {'type': 'code', 'name': name, 'code': src, 'exits': exits,
                                                         'mcp_servers': [], 'timeout_s': 30}}
        graph = {'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
            code('10', 'T', "def run(input, call_tool):\n    return {'route': 'a', 'output': 'from T'}\n", ['a', 'b']),
            code('11', 'U', "def run(input, call_tool):\n    return 'from U'\n", ['next']),
            code('12', 'X', "def run(input, call_tool):\n    return 'X ran'\n", ['next']),
            {'id': '5', 'type': 'output', 'config': {'type': 'output'}},
        ], 'edges': [
            {'from': '1', 'to': '10', 'from_port': 'output_1'}, {'from': '1', 'to': '11', 'from_port': 'output_1'},
            {'from': '10', 'to': '12', 'from_port': 'output_2'}, {'from': '11', 'to': '12', 'from_port': 'output_1'},
            {'from': '12', 'to': '5', 'from_port': 'output_1'},
        ]}
        a = {**WorkflowGraphAnalyzer.analyzeGraph(graph),
             'workflow': {'id': 97, 'name': 'two parents'}, 'usedCatalog': {}, 'usedServers': {}, 'serverSlugs': {},
             'startPrompt': 'go', 'startDocuments': [], 'agents': {}, 'playbooks': {}}
        by_id = {n['id']: n for n in graph['nodes']}
        a['code'] = {cid: CodeNodeEmit.nodeData(by_id[cid], graph['edges'], {}, list(by_id)) for cid in ('10', '11', '12')}
        rc, text = self.run_(a)
        assert rc == 0, text
        assert 'X ran' in text

    def test_package_cli_prints_the_answer(self):
        """Review I3: the package's CLI prints the answer of a one-off run."""
        self.startServer()
        d = self.writeListeningPackage(self.analyzed(FILE), 'prompt')
        r = subprocess.run([PY, 'workflow.py', 'go'], cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=_env())
        assert r.returncode == 0, r.stdout
        assert 'filed test 50' in r.stdout

    # ---- A2A ----

    def a2aAnalyzed(self) -> dict:
        """Start -> dispatcher D (Jev) -> agent A | agent B -> Output, every model the fake one ("answer from <model>")."""
        def agent(id_, name, extra=None):
            return {'id': id_, 'type': 'agent', 'config': {**(extra or {}), 'type': 'agent', 'agent_name': name,
                                                          'provider': 'deepseek', 'model': 'fake-' + name.lower()}}
        graph = {'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'my car claim'}},
            agent('2', 'D', {'agent_type': 'dispatcher'}), agent('3', 'A'), agent('4', 'B'),
            {'id': '5', 'type': 'output', 'config': {'type': 'output'}},
        ], 'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
                     {'from': '3', 'to': '5'}, {'from': '4', 'to': '5'}]}

        def ag(name, prompt):
            return {'name': name, 'systemPrompt': prompt, 'provider': 'deepseek', 'model': 'fake-' + name.lower(),
                    'temperature': None, 'max_tokens': None, 'tools': [], 'skills': [], 'skill_content': '',
                    'output_schema_id': None, 'documents': []}
        return {**WorkflowGraphAnalyzer.analyzeGraph(graph),
                'workflow': {'id': 96, 'name': 'a2a e2e'}, 'usedCatalog': {}, 'usedServers': {}, 'serverSlugs': {},
                'startPrompt': 'my car claim', 'playbooks': {}, 'code': {},
                'startDocuments': [{'name': 'note.txt', 'path': 'start_documents/note.txt'}],
                'outputStorageEnabled': True, 'outputFolder': None,
                'agents': {'2': ag('D', 'Route the request.'), '3': ag('A', 'Handle it as A.'), '4': ag('B', 'Handle it as B.')},
                'decisions': {'2': {'decision_question': 'Which agent handles this?', 'routing_mode': 'jev', 'unclear_branch': '',
                                    'min_confidence': 0.6, 'decision': [{'provider': 'jev', 'protocol': 'typesafe',
                                                                         'url': self.url + '/systemone', 'model': 'jev-latest',
                                                                         'key_env': 'JEV_API_KEY', 'url_env': 'JEV_BASE_URL'}]}}}

    def test_a2a_routes_over_agent_servers(self):
        self.startServer()
        pkg = self.a2aPackage(self.a2aAnalyzed())
        d = _tmp('adk_e2e_a2a_')
        _write_files(d, pkg['files'])
        with open(os.path.join(d, '.env'), 'w', encoding='utf-8') as f:
            f.write(f'JEV_API_KEY=jev-test-key\nDEEPSEEK_API_KEY=fake\nDEEPSEEK_BASE_URL={self.url}/v1\n')
        os.makedirs(os.path.join(d, 'start_documents'), exist_ok=True)
        with open(os.path.join(d, 'start_documents/note.txt'), 'w') as f:
            f.write('The policy number is PN-4242.')
        r = subprocess.run([PY, 'orchestrator.py', 'my car claim'], cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           text=True, env=_env({'A2A_BASE_PORT': str(random.randint(21000, 29000)),
                                                'SYNERGYAI_OUTPUT_ROOT': f'{d}/out'}))
        text = r.stdout
        print(f'\n--- A2A output ({d}) ---\n{text}\n')
        assert r.returncode == 0, text
        assert 'answer from fake-b' in text
        llm = [c for c in self.calls() if c.get('method') == 'llm']
        assert list(dict.fromkeys(c['model'] for c in llm)) == ['fake-b'], json.dumps(llm)
        assert 'my car claim' in ' '.join(llm[0]['messages'])
        assert 'PN-4242' in ' '.join(llm[0]['messages'])
        saved = glob.glob(f'{d}/out/workflow/*')
        assert len(saved) == 1, 'the answer is saved under SYNERGYAI_OUTPUT_ROOT'
        assert open(saved[0]).read().strip().startswith('answer from fake-b')
        jev = [c for c in self.calls() if c.get('method') == 'jev']
        assert len(jev) == 1
        assert 'my car claim' in jev[0]['request']

    # ---- playbooks (compiled through the generator, from an in-memory database) ----

    def playbookGenerator(self):
        """Start -> playbook PB (deepseek "fake-pb", one #Request Approval) -> Output, in an in-memory workflow database."""
        import sqlite3
        pb = ('Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. Say hello.\n2. #Request Approval from the manager then finish.\n\n'
              'Actions used: #Request Approval\n')
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        for ddl in (
            "CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY, user_id INTEGER, workspace_id INTEGER, name TEXT, description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, output_storage_enabled INTEGER DEFAULT 0, output_folder TEXT, orchestration TEXT DEFAULT 'workflow')",
            'CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY, workflow_id INTEGER, node_type TEXT, agent_id INTEGER, config TEXT, pos_x INTEGER DEFAULT 0, pos_y INTEGER DEFAULT 0, drawflow_node_id TEXT, created_at TEXT)',
            "CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY, workflow_id INTEGER, from_node_id INTEGER, to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1', condition_expr TEXT, created_at TEXT)",
            'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
            'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
            'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
            "INSERT INTO agent_workflows (id, user_id, name, description, steps, orchestration) VALUES (74, 3, 'Playbook e2e', 'x', '[]', 'workflow')",
        ):
            conn.execute(ddl)
        ins = 'INSERT INTO workflow_nodes (id, workflow_id, node_type, agent_id, config, drawflow_node_id) VALUES (?, 74, ?, NULL, ?, ?)'
        conn.execute(ins, (1, 'start', json.dumps({'type': 'start', 'prompt': 'go'}), '1'))
        conn.execute(ins, (2, 'playbook', json.dumps({'type': 'playbook', 'name': 'PB', 'playbook': pb, 'agent_provider': 'deepseek',
                                                      'model': 'fake-pb', 'writes_enabled': True}), '2'))
        conn.execute(ins, (3, 'output', json.dumps({'type': 'output'}), '3'))
        conn.execute('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id) VALUES (74, 1, 2), (74, 2, 3)')
        conn.commit()
        db = SqliteDb(conn)
        return self.generatorClass()(db, WorkflowRepository(db), WorkflowGraphRepository(db), AgentRepository(db))

    def writeTo(self, files: list, prefix: str) -> str:
        d = _tmp(f'adk_e2e_{prefix}_')
        _write_files(d, files)
        with open(os.path.join(d, '.env'), 'w', encoding='utf-8') as f:
            f.write(f'DEEPSEEK_API_KEY=fake\nDEEPSEEK_BASE_URL={self.url}/v1\nPLAYBOOK_GATE_MODE=auto\n')
        return d

    @staticmethod
    def runIn(d: str, argv: list, env: dict | None = None) -> tuple:
        r = subprocess.run([PY, *argv], cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=_env(env))
        print(f'\n--- output ({d}) ---\n{r.stdout}\n')
        return r.returncode, r.stdout

    def test_playbook_tool_call_runs_in_the_package(self):
        """Review C1: a playbook's tool calls (its approval gate) run in a package -- the runtime lives in common.py there."""
        self.startServer()
        d = self.writeTo(self.playbookGenerator().generatePackage(74)['files'], 'pbmod')
        rc, text = self.runIn(d, ['workflow.py', 'go'])
        assert rc == 0, text
        assert 'RecursionError' not in text
        assert 'answer from fake-pb after tool' in text

    def test_playbook_tool_call_runs_over_a2a(self):
        """Review C1: the same over A2A (the gate goes to the orchestrator, answered by PLAYBOOK_GATE_MODE=auto)."""
        self.startServer()
        d = self.writeTo(self.playbookGenerator().generateA2A(74)['files'], 'pba2a')
        rc, text = self.runIn(d, ['orchestrator.py', 'go'], {'A2A_BASE_PORT': str(random.randint(21000, 29000)),
                                                             'PLAYBOOK_GATE_MODE': 'auto'})
        assert rc == 0, text
        assert 'RecursionError' not in text
        assert 'answer from fake-pb after tool' in text
