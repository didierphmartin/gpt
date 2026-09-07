"""Unit tests for WorkflowRunLog — port of backend/src/AgentTeam/Services/
WorkflowRunLog.php (79 lines). Mirrors
backend/tests/Unit/AgentTeam/WorkflowRunLogTest.php case-for-case.
"""
from __future__ import annotations

import os
import secrets

from app.agent_team.services.workflow_run_log import WorkflowRunLog


def _valid_run_id() -> str:
    return secrets.token_hex(16)  # 32 hex chars


def test_append_then_read_round_trips_events(tmp_path):
    log = WorkflowRunLog(str(tmp_path))
    run_id = _valid_run_id()

    log.append(run_id, {'type': 'workflow_start', 'run_id': run_id})
    log.append(run_id, {'type': 'node_start', 'node_id': 5, 'input': 'hello'})
    log.append(run_id, {'type': 'node_complete', 'node_id': 5, 'output': 'world'})

    events = log.read(run_id)
    assert isinstance(events, list)
    assert len(events) == 3
    assert events[1]['type'] == 'node_start'
    assert events[1]['input'] == 'hello'
    assert events[2]['output'] == 'world'


def test_read_missing_run_returns_none(tmp_path):
    log = WorkflowRunLog(str(tmp_path))
    assert log.read(_valid_run_id()) is None


def test_read_invalid_run_id_returns_none(tmp_path):
    log = WorkflowRunLog(str(tmp_path))
    assert log.read('../etc/passwd') is None


def test_append_invalid_run_id_is_no_op(tmp_path):
    log = WorkflowRunLog(str(tmp_path))
    log.append('not-a-valid-id', {'type': 'x'})  # must not raise
    assert not (os.path.isdir(str(tmp_path)) and os.listdir(str(tmp_path)))


def test_default_dir_from_config_override():
    assert WorkflowRunLog.defaultDir({'workflow_runs_dir': '/custom/runs'}) == '/custom/runs'


def test_default_dir_default_resolves_under_php_backend():
    d = WorkflowRunLog.defaultDir({})
    assert d.endswith('/backend/storage/workflow-runs')


def test_path_for():
    log = WorkflowRunLog('/tmp/runs')
    run_id = 'a' * 32
    assert log.pathFor(run_id) == f'/tmp/runs/{run_id}.jsonl'


def test_read_skips_non_json_and_non_array_lines(tmp_path):
    run_id = _valid_run_id()
    p = tmp_path / f'{run_id}.jsonl'
    p.write_text('{"type":"a"}\nnot json\n"just a string"\n{"type":"b"}\n\n')
    log = WorkflowRunLog(str(tmp_path))
    events = log.read(run_id)
    assert events == [{'type': 'a'}, {'type': 'b'}]


def test_base_dir_trailing_slash_is_stripped():
    log = WorkflowRunLog('/tmp/runs/')
    assert log.baseDir == '/tmp/runs'
