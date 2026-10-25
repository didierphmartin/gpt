"""Port of backend/tests/Unit/GraphWorkflowRunnerPlaybookNodeTest.php.

The server runner runs playbook nodes unattended and routes on the outcome.
Graph: Start(1) -> Code(2, fake output) -> Playbook(3) ; done (output_1) -> Out(4), failed (output_2) -> Out(5).
The code node runs the real harness in a subprocess; the playbook runner gets a scripted LLM, a fake MCP
executor and an in-memory SQLite DB (no MySQL, no network).
"""
from __future__ import annotations

import os
import sys
import time

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services import graph_workflow_runner as _gwr_module
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.playbook_node_runner import PlaybookNodeRunner
from tests.unit.playbook.conftest import PLAYBOOKS_DDL, make_sqlite_db
from tests.unit.playbook.fakes import FakeMcpExecutor, FakeNodeRunnerBridge

EXEC_DDL = ('CREATE TABLE agent_workflow_executions (id INTEGER PRIMARY KEY, workflow_id INTEGER, user_id INTEGER, '
            'input_variables TEXT, status TEXT, output TEXT, error_message TEXT, response_time_ms INTEGER, '
            'started_at TEXT, completed_at TEXT)')
MCP_DDL = 'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER)'


class _Graph:
    def __init__(self, nodes, edges):
        self.nodes, self.edges = nodes, edges

    def findStartNode(self, wid):
        return self.nodes[0]

    def getGraph(self, wid):
        return {'nodes': self.nodes, 'edges': self.edges}


class _NoAgentRunner:
    def run(self, *a, **k):
        raise AssertionError('no agent may run')


def _python() -> str:
    return os.environ.get('CODE_NODE_PYTHON') or sys.executable


def _scripted_llm(rounds):
    queue = [list(r) for r in rounds]
    n = {'i': 0}

    def llm(m, t):
        if not queue:
            return {'text': 'nothing left to do', 'tool_calls': []}
        calls = []
        for c in queue.pop(0):
            n['i'] += 1
            calls.append({'id': f"call_{n['i']}", 'name': c['name'], 'arguments': c.get('arguments', {})})
        return {'text': None, 'tool_calls': calls}
    return llm


def _playbook_doc():
    return {'title': 'Simple Resolve', 'trigger': {'kind': 'request', 'description': 't'},
            'instructions': '#Resolve Request.', 'actions_used': ['#Resolve Request'], 'policy': {'writes_enabled': True}}


RESOLVE = [[{'name': 'resolve_request', 'arguments': {'outcome': 'success', 'summary': 'done'}}]]


class _Env:
    def __init__(self, tmp_path):
        self.db = make_sqlite_db()
        self.db.conn.create_function('NOW', 0, lambda: time.strftime('%Y-%m-%d %H:%M:%S'))
        for ddl in [EXEC_DDL, MCP_DDL, *PLAYBOOKS_DDL, 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT)']:
            self.db.execute(ddl)
        self.db.execute("INSERT INTO users (kind) VALUES ('service')")
        self.runs = str(tmp_path / 'runs')
        os.makedirs(self.runs)
        self.factoryCalls = 0
        self.rounds: list = []

    def go(self, pbConfig: dict, codeOutput: str, withExits: bool = True):
        pbConfig = {**pbConfig, 'name': 'PB', **({'exits': ['done', 'failed']} if withExits else {})}
        nodes = [
            {'id': 1, 'node_type': 'start', 'config': {}},
            {'id': 2, 'node_type': 'code', 'config': {'name': 'Get', 'exits': ['next'], 'mcp_servers': [], 'timeout_s': 10,
             'code': "def run(input, call_tool):\n    return {'route': 'next', 'output': " + repr(codeOutput) + "}\n"}},
            {'id': 3, 'node_type': 'playbook', 'config': pbConfig},
            {'id': 4, 'node_type': 'output', 'config': {}},
            {'id': 5, 'node_type': 'output', 'config': {}},
        ]
        edges = [
            {'from_node_id': 1, 'to_node_id': 2, 'from_port': 'output_1'},
            {'from_node_id': 2, 'to_node_id': 3, 'from_port': 'output_1'},
            {'from_node_id': 3, 'to_node_id': 4, 'from_port': 'output_1'},
            {'from_node_id': 3, 'to_node_id': 5, 'from_port': 'output_2' if withExits else 'output_1'},
        ]

        def factory():
            self.factoryCalls += 1
            return PlaybookNodeRunner(
                config={'workflow_runs_dir': self.runs},
                llmFactory=lambda nodeConfig: _scripted_llm(self.rounds),
                mcpFactory=lambda db_, userId: FakeMcpExecutor(),
                bridgeFactory=lambda emit_: FakeNodeRunnerBridge(emit_),
                pdoFactory=lambda: self.db,
            )

        runner = GraphWorkflowRunner(self.db, object(), _NoAgentRunner(), _Graph(nodes, edges),
                                     {'workflow_runs_dir': self.runs, 'code_nodes': {'python': _python()}}, factory)
        wf = Workflow()
        wf.setId(55)
        wf.setName('PB test')
        out = runner.run(wf, 3, {'prompt': 'go'})
        return out, out.get('node_outputs') or {}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(_gwr_module, '_sleep', lambda s: None)
    monkeypatch.setattr(_gwr_module, 'error_log', lambda m: None)
    return _Env(tmp_path)


def _last_line(text: str) -> str:
    return text.rstrip().split('\n')[-1]


def test_done_routes_to_done_branch(env):
    env.rounds = RESOLVE
    out, o = env.go({'playbook': _playbook_doc()}, 'hello')
    assert out['success'] is True, out.get('error')
    assert o[3]['exit'] == 'done'
    assert 4 in o, 'Out-done ran'
    assert 5 not in o, 'Out-failed skipped'
    assert '[playbook run' in o[3]['output']
    assert 'Playbook failed' not in o[3]['output']
    assert 'code_route' not in o[3]


def test_from_input_node_ends_with_the_job_line(env):
    job = '{"playbook": "nope", "task": "INC0001", "u": "é/x"}'
    out, o = env.go({'playbook_source': 'input'}, job)
    assert out['success'] is True, out.get('error')
    assert o[3]['exit'] == 'failed'
    assert 5 in o
    assert 4 not in o
    # unknown key: failed with the resolution reason, and the Job line carries the parent's JSON compactly
    assert o[5]['output'].startswith('Playbook failed: playbook_not_found:nope')
    assert _last_line(o[3]['output']) == 'Job: {"playbook":"nope","task":"INC0001","u":"é/x"}'


def test_fixed_node_with_exits_ends_with_the_job_line_when_its_parent_is_a_job(env):
    # an automation's workflow: fixed playbook, the job JSON from the get-new-job node, then complete job
    env.rounds = RESOLVE
    out, o = env.go({'playbook': _playbook_doc()}, '{"task": "T1", "number": "SCTASK1"}')
    assert out['success'] is True, out.get('error')
    assert o[3]['exit'] == 'done'
    assert _last_line(o[3]['output']) == 'Job: {"task":"T1","number":"SCTASK1"}'


def test_gate_ends_the_run_as_failed_with_gate_reason(env):
    env.rounds = [
        [{'name': 'request_approval', 'arguments': {'approver': 'boss', 'question': 'OK?'}}],
        [{'name': 'resolve_request', 'arguments': {'outcome': 'success', 'summary': 'done'}}],
    ]
    out, o = env.go({'playbook': _playbook_doc()}, 'hello')
    assert o[3]['exit'] == 'failed'
    assert o[5]['output'].startswith('Playbook failed: gate:approval')
    assert 'Job: ' not in o[3]['output'], 'fixed source adds no Job line'


def test_from_input_unknown_key_routes_to_failed_without_running(env):
    out, o = env.go({'playbook_source': 'input'}, '{"playbook":"nope"}')
    assert o[3]['exit'] == 'failed'
    assert 5 in o
    assert 4 not in o
    assert env.factoryCalls == 0, 'the playbook runner was never built'


def test_from_input_bad_input_omits_the_job_line(env):
    out, o = env.go({'playbook_source': 'input'}, 'not json at all')
    assert o[3]['exit'] == 'failed'
    assert o[3]['output'].startswith('Playbook failed: bad_input')
    assert 'Job: ' not in o[3]['output']
    assert env.factoryCalls == 0


def test_legacy_playbook_node_without_exits_runs_all_children(env):
    env.rounds = RESOLVE
    out, o = env.go({'playbook': _playbook_doc()}, 'hello', False)
    assert out['success'] is True, out.get('error')
    assert 4 in o
    assert 5 in o
    assert 'exit' not in o[3]


def test_from_input_resolved_key_runs_the_published_copy_and_ends_with_the_job_line(env):
    env.db.execute('INSERT INTO playbooks (user_id, pkey, title, text) VALUES (1, ?, ?, ?)',
                   ['pubpb', 'Pub', 'Title: Published Copy\nTrigger: a job\nInstructions: #Resolve Request.\nActions used: #Resolve Request'])
    env.rounds = RESOLVE
    out, o = env.go({'playbook_source': 'input', 'writes_enabled': True}, '{"playbook":"pubpb","task":"INC0002"}')
    assert out['success'] is True, out.get('error')
    assert o[3]['exit'] == 'done'
    assert 4 in o
    assert 5 not in o
    assert env.factoryCalls == 1
    assert '# Playbook: Published Copy' in o[3]['output'], 'the published text ran'
    assert _last_line(o[3]['output']) == 'Job: {"playbook":"pubpb","task":"INC0002"}'


def test_from_input_missing_field_is_bad_input_but_keeps_the_job_line(env):
    out, o = env.go({'playbook_source': 'input'}, '{"task":"INC0001"}')
    assert o[3]['exit'] == 'failed'
    assert o[3]['output'].startswith('Playbook failed: bad_input')
    assert _last_line(o[3]['output']) == 'Job: {"task":"INC0001"}'
    assert env.factoryCalls == 0


def test_from_input_json_list_has_no_job_line(env):
    out, o = env.go({'playbook_source': 'input'}, '[1,2]')
    assert o[3]['output'].startswith('Playbook failed: bad_input')
    assert 'Job: ' not in o[3]['output']


def test_an_error_reason_stays_on_one_line(env):
    # An unparsable stored playbook makes the run throw a multi-line message (it names the missing section).
    env.db.execute("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (1, 'badpb', 'Bad', 'Title: only a title')")
    out, o = env.go({'playbook_source': 'input'}, '{"playbook":"badpb"}')
    assert o[3]['exit'] == 'failed'
    first = o[3]['output'].split('\n')[0]
    assert first.startswith('Playbook failed: error:')
    assert 'Instructions' in first


def test_from_input_node_without_exits_fails_the_run_on_failure(env):
    out, o = env.go({'playbook_source': 'input'}, '{"playbook":"nope","task":"INC0001"}', False)
    assert out['success'] is False, 'a legacy one-output node has no failed exit: the run fails'
    assert 'playbook_not_found:nope' in str(out.get('error') or '')
    assert 4 not in o
    assert 5 not in o
