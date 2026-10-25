"""Port of backend/tests/Unit/GraphWorkflowRunnerCodeNodeTest.php (+ GraphWorkflowRunnerUnsupportedNodeTest.php).

The server runner executes code nodes (real code_node_run.py harness in a subprocess, SQLite DB,
temp run-log dir): it follows the exit taken, records exit/success per code node, and a poll that
found nothing (quiet) leaves no execution row and no run log. Errors are never quiet.
Graph: Start(1) -> Code(2) ; exit 'work' (output_1) -> Output(3).
"""
from __future__ import annotations

import glob
import os
import re
import sys

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services import graph_workflow_runner as _gwr_module
from app.agent_team.services.graph_workflow_runner import GraphWorkflowRunner
from app.agent_team.services.workflow_run_log import WorkflowRunLog
from tests.unit.playbook.conftest import sqlite_db

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


class _NoAgents:
    def findById(self, i):
        raise AssertionError('no agent lookup expected')


def _python() -> str:
    return os.environ.get('CODE_NODE_PYTHON') or sys.executable


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(_gwr_module, '_sleep', lambda s: None)
    log: list = []
    monkeypatch.setattr(_gwr_module, 'error_log', lambda m: log.append(str(m)))
    db = sqlite_db(EXEC_DDL, MCP_DDL)
    runs = tmp_path / 'runs'
    runs.mkdir()
    return {'db': db, 'runs': str(runs), 'log': log}


def _deep_merge(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        out[k] = _deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def _run(env, code, exits, config=None, nodeConfig=None, edges=None, extraNodes=None):
    nodes = [
        {'id': 1, 'node_type': 'start', 'config': {}},
        {'id': 2, 'node_type': 'code', 'config': {'name': 'Poll', 'code': code, 'exits': exits,
                                                  'mcp_servers': [], 'timeout_s': 10, **(nodeConfig or {})}},
        {'id': 3, 'node_type': 'output', 'config': {}},
        *(extraNodes or []),
    ]
    if edges is None:
        edges = [
            {'from_node_id': 1, 'to_node_id': 2, 'from_port': 'output_1'},
            {'from_node_id': 2, 'to_node_id': 3, 'from_port': 'output_1'},
        ]
    cfg = _deep_merge({'workflow_runs_dir': env['runs'], 'code_nodes': {'python': _python()}}, config or {})
    runner = GraphWorkflowRunner(env['db'], _NoAgents(), _NoAgentRunner(), _Graph(nodes, edges), cfg)
    wf = Workflow()
    wf.setId(44)
    wf.setName('Poll test')
    return runner.run(wf, 3, {'prompt': 'go'})


def _rows(env):
    return env['db'].fetch_all('SELECT * FROM agent_workflow_executions')


def _run_logs(env):
    return glob.glob(env['runs'] + '/*.jsonl')


def _skip_old_python(out):
    err = str(out.get('error') or '')
    if 'needs Python 3.10+' in err:
        pytest.skip(err)


def test_a_poll_that_found_nothing_leaves_no_trace(env):
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'idle', 'output': 'none'}\n", ['work', 'idle'])
    _skip_old_python(out)
    assert out['success'] is True, out.get('error')
    assert out['quiet'] is True
    assert out['drain'] is False
    assert out['execution_id'] is None
    assert _rows(env) == [], 'quiet run deletes its execution row'
    assert _run_logs(env) == [], 'quiet run deletes its run log'
    assert 3 not in out['node_outputs'], 'the work branch was skipped'


def test_a_poll_that_found_work_runs_the_exit_and_asks_to_drain(env):
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'work', 'output': 'job 1'}\n", ['work', 'idle'])
    assert out['success'] is True, out.get('error')
    assert out['quiet'] is False
    assert out['drain'] is True
    assert out['output'] == 'job 1'
    assert out['node_outputs'][2] == {'type': 'code', 'output': 'job 1', 'exit': 'work', 'success': True}
    rows = _rows(env)
    assert len(rows) == 1
    assert rows[0]['status'] == 'completed'
    assert len(_run_logs(env)) == 1


def test_work_beside_the_poll_does_not_drain(env):
    # Start -> Code(2) and Start -> Output(3) in parallel: the Output runs every tick, the poll found nothing.
    edges = [
        {'from_node_id': 1, 'to_node_id': 2, 'from_port': 'output_1'},
        {'from_node_id': 1, 'to_node_id': 3, 'from_port': 'output_1'},
    ]
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'idle', 'output': 'none'}\n", ['work', 'idle'], edges=edges)
    assert out['success'] is True, out.get('error')
    assert 3 in out['node_outputs'], 'the Output beside the poll ran'
    assert out['quiet'] is False
    assert out['drain'] is False, 'work beside the poll must not make the scheduler re-run the workflow'


def test_output_takes_a_node_once_and_only_through_the_exit_it_took(env):
    # Both exits of Code(2) link to Output(3): the Output shows the result once, not once per link.
    edges = [
        {'from_node_id': 1, 'to_node_id': 2, 'from_port': 'output_1'},
        {'from_node_id': 2, 'to_node_id': 3, 'from_port': 'output_1'},
        {'from_node_id': 2, 'to_node_id': 3, 'from_port': 'output_2'},
    ]
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'ok', 'output': 'stored'}\n", ['ok', 'no'], edges=edges)
    assert out['success'] is True, out.get('error')
    assert out['output'] == 'stored'


def test_output_ignores_an_earlier_nodes_untaken_error_exit(env):
    # Convert(2): done -> Store(4), error -> Output(3); Store(4): ok -> Output(3). Convert took done, so the
    # Output is Store's message alone -- not Convert's package next to it.
    store = {'id': 4, 'node_type': 'code', 'config': {'name': 'Store', 'exits': ['ok', 'no'],
             'code': "def run(input, call_tool):\n    return {'route': 'ok', 'output': 'stored'}\n",
             'mcp_servers': [], 'timeout_s': 10}}
    edges = [
        {'from_node_id': 1, 'to_node_id': 2, 'from_port': 'output_1'},
        {'from_node_id': 2, 'to_node_id': 4, 'from_port': 'output_1'},
        {'from_node_id': 2, 'to_node_id': 3, 'from_port': 'output_2'},
        {'from_node_id': 4, 'to_node_id': 3, 'from_port': 'output_1'},
        {'from_node_id': 4, 'to_node_id': 3, 'from_port': 'output_2'},
    ]
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'done', 'output': 'package'}\n", ['done', 'error'],
               edges=edges, extraNodes=[store])
    assert out['success'] is True, out.get('error')
    assert out['output'] == 'stored'
    assert out['node_outputs'][4]['exit'] == 'ok'


def test_an_unwired_error_exit_is_kept_and_never_quiet(env):
    out = _run(env, "def run(input, call_tool):\n    raise ValueError('mailbox down')\n", ['work', 'idle', 'error'])
    assert out['success'] is True, out.get('error')
    assert out['quiet'] is False
    assert out['drain'] is False
    assert out['node_outputs'][2]['exit'] == 'error'
    assert 'mailbox down' in out['node_outputs'][2]['output']
    rows = _rows(env)
    assert len(rows) == 1
    assert 'mailbox down' in str(rows[0]['output'])
    with open(_run_logs(env)[0], encoding='utf-8') as f:
        assert 'took its error exit' in f.read()


def test_an_error_exit_run_is_recorded_but_neither_saved_nor_archived(env):
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'error', 'output': 'mailbox down'}\n", ['work', 'idle', 'error'])
    assert out['success'] is True, out.get('error')
    assert out['storage'] is None, 'no output storage for an error exit'
    assert not any('Archive to conversation_contexts' in m for m in env['log']), 'no archive attempt'
    rows = _rows(env)
    assert len(rows) == 1
    assert rows[0]['error_message'] == "code node 'Poll' took its error exit: mailbox down"


def test_a_normal_run_is_saved_and_archived(env):
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'work', 'output': 'job 1'}\n", ['work', 'idle', 'error'])
    assert out['success'] is True, out.get('error')
    assert isinstance(out['storage'], dict), 'output storage was attempted'
    # No contexts_database in the test config: the attempt fails (best effort) and says so.
    assert any('Archive to conversation_contexts failed' in m for m in env['log'])
    assert _rows(env)[0]['error_message'] is None


def test_the_error_exit_reason_is_logged_as_one_bounded_line(env):
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'error', 'output': 'tool page\\n\\n  says ' + 'x' * 300}\n",
               ['work', 'idle', 'error'])
    assert out['success'] is True, out.get('error')
    with open(_run_logs(env)[0], encoding='utf-8') as f:
        log = f.read()
    assert re.search(r'took its error exit: tool page says x{185}…"', log)


def test_a_failed_code_node_fails_the_run_and_keeps_the_row(env):
    out = _run(env, "def run(input, call_tool):\n    raise ValueError('mailbox down')\n", ['work', 'idle'])
    assert out['success'] is False
    assert 'quiet' not in out, 'a failed run is never reported quiet'
    assert 'drain' not in out, 'a failed run never drains'
    assert 'mailbox down' in out['error']
    assert out['partial_outputs'][2]['success'] is False
    rows = _rows(env)
    assert len(rows) == 1
    assert rows[0]['status'] == 'failed'
    assert 'mailbox down' in str(rows[0]['error_message'])


def test_a_disabled_code_node_neither_drains_nor_goes_quiet(env):
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'idle', 'output': 'x'}\n", ['work', 'idle'],
               nodeConfig={'disabled': True})
    assert out['success'] is True, out.get('error')
    assert out['quiet'] is False
    assert out['drain'] is False, 'a disabled code node must not make the scheduler re-run the workflow'
    assert 3 in out['node_outputs'], 'the downstream Output ran'
    rows = _rows(env)
    assert len(rows) == 1
    assert rows[0]['status'] == 'completed'
    assert len(_run_logs(env)) == 1


def test_switched_off_code_nodes_fail_the_run(env):
    out = _run(env, "def run(input, call_tool):\n    return {'route': 'idle', 'output': 'x'}\n", ['work', 'idle'],
               config={'code_nodes': {'server_side': False}})
    assert out['success'] is False
    assert 'CODE_NODES_SERVER_SIDE' in out['error']
    assert len(_rows(env)) == 1


# --- GraphWorkflowRunnerUnsupportedNodeTest --------------------------------------------------

def test_code_nodes_run_unless_switched_off():
    assert GraphWorkflowRunner.unsupportedNodeMessage('code') is None
    assert 'CODE_NODES_SERVER_SIDE' in GraphWorkflowRunner.unsupportedNodeMessage('code', {'code_nodes': {'server_side': False}})
    assert GraphWorkflowRunner.unsupportedNodeMessage('playbook') is None
    assert GraphWorkflowRunner.unsupportedNodeMessage('agent') is None


def test_run_log_dir_is_the_configured_one(env):
    """Sanity for the fixtures above: the runner logs where the config says (WorkflowRunLog.defaultDir)."""
    assert WorkflowRunLog.defaultDir({'workflow_runs_dir': env['runs']}) == env['runs']
