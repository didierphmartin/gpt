"""Port of backend/tests/Unit/CodeNodeExecutorTest.php.

Runs the real runner (backend/scripts/code_node_run.py + frontend/assets/py, the files the PHP
backend runs) in a subprocess -- a local process, no MCP server or network needed for these cases.
The interpreter is CODE_NODE_PYTHON, else this test's own (3.10+) interpreter.
"""
from __future__ import annotations

import os
import stat
import sys
import time

import pytest

from app.agent_team.services.code_node_executor import CodeNodeExecutor
from tests.unit.playbook.conftest import sqlite_db

MCP_DDL = 'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER)'


def _python() -> str:
    return os.environ.get('CODE_NODE_PYTHON') or sys.executable


def _db():
    db = sqlite_db(MCP_DDL)
    db.execute("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES "
               "('3', 'Outlook', 'http://127.0.0.1:9/mcp', '{\"X-Outlook-Account\":\"k\"}', 1)")
    return db


def _exec(config=None) -> CodeNodeExecutor:
    return CodeNodeExecutor(_db(), {**(config or {}), 'code_nodes': {'python': _python()}})


def _assert_ran(out):
    err = str(out['result'].get('error') or '')
    if not out['result']['ok'] and 'needs Python 3.10+' in err:
        pytest.skip(err)
    assert out['result']['ok'], err


def _node(code: str, servers=None, exits=None) -> dict:
    return {'id': 2, 'node_type': 'code', 'config': {'name': 'C', 'code': code, 'exits': exits or ['a', 'b'],
                                                     'mcp_servers': servers or [], 'timeout_s': 5}}


def test_runs_the_harness():
    code = "def run(input, call_tool):\n    return {'route': 'b', 'output': input.upper()}\n"
    out = _exec().run(_node(code), [], [2], '3', [{'name': 'start', 'text': 'hi', 'start': True}], 'hi')
    _assert_ran(out)
    assert out['result']['route'] == 'b'
    assert out['result']['output_text'] == 'HI'


def test_config_args_reach_the_code_as_the_args_global():
    code = "def run(input, call_tool):\n    return {'route': 'a', 'output': [ARGS.get('tag'), ARGS.get('version') + 1]}\n"
    node = _node(code)
    node['config']['args'] = {'tag': 'okta-reset', 'version': 2}
    out = _exec().run(node, [], [2], '3', [], '')
    _assert_ran(out)
    assert out['result']['output_text'] == '["okta-reset", 3]'
    out = _exec().run(_node("def run(i, c):\n    return {'route': 'a', 'output': ARGS}\n"), [], [2], '3', [], '')
    _assert_ran(out)
    assert out['result']['output_text'] == '{}'


def test_unknown_server_is_refused_before_running():
    with pytest.raises(RuntimeError, match='is not one of your MCP servers'):
        _exec().run(_node("def run(i, c):\n    return {'route': 'a', 'output': 1}\n", ['Nope']), [], [2], '3', [], '')


def test_switched_off():
    assert CodeNodeExecutor.enabled({}) is True
    assert CodeNodeExecutor.enabled({'code_nodes': {'server_side': False}}) is False


def test_own_server_beats_global_on_name_clash():
    db = sqlite_db(MCP_DDL)
    db.execute("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES (NULL, 'Outlook', 'http://global/mcp', NULL, 1)")
    db.execute("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES ('3', 'Outlook', 'http://own/mcp', NULL, 1)")
    db.execute("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES (NULL, 'Shared', 'http://shared/mcp', NULL, 1)")
    db.execute("INSERT INTO mcp_servers (user_id, name, url, headers, enabled) VALUES ('9', 'Other', 'http://other/mcp', NULL, 1)")
    servers = CodeNodeExecutor(db, {})._servers('3')
    assert servers['outlook']['url'] == 'http://own/mcp'
    assert servers['shared']['url'] == 'http://shared/mcp'
    assert 'other' not in servers


def test_runner_failure_becomes_an_error_result():
    out = CodeNodeExecutor(_db(), {'code_nodes': {'python': '/usr/bin/false'}}).run(
        _node("def run(i, c):\n    return {'route': 'a', 'output': 1}\n"), [], [2], '3', [], '')
    assert out['result']['ok'] is False
    assert 'code node runner failed' in out['result']['error']


def test_runaway_code_is_stopped_with_a_timeout_error():
    node = _node("def run(i, c):\n    while True:\n        pass\n")
    node['config']['timeout_s'] = 1
    t = time.time()
    out = _exec().run(node, [], [2], '3', [], '')
    if not out['result']['ok'] and 'needs Python 3.10+' in str(out['result'].get('error')):
        pytest.skip(out['result']['error'])
    assert out['result']['ok'] is False
    assert 'time' in out['result']['error'].lower()
    assert time.time() - t < 10


def test_child_that_never_stops_is_killed_by_the_executor(tmp_path):
    stub = tmp_path / 'python'
    stub.write_text('#!/bin/sh\nexec sleep 30\n')
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    node = _node("def run(i, c):\n    return {'route': 'a', 'output': 1}\n")
    node['config']['timeout_s'] = 1
    t = time.time()
    out = CodeNodeExecutor(_db(), {'code_nodes': {'python': str(stub)}}).run(node, [], [2], '3', [], '')
    assert out['result']['ok'] is False
    assert '(process killed)' in out['result']['error']
    assert time.time() - t < 1 + 5 + 2
