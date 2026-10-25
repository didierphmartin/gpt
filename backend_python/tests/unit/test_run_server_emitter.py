"""Port of backend/tests/Unit/RunServerEmitterTest.php: the run server, emitted for four targets from one place."""
from __future__ import annotations

from app.agent_team.services.run_server_emitter import RunServerEmitter


def test_emits_the_run_protocol_routes():
    out = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"')
    assert '@app.post("/runs")' in out
    assert '@app.get("/runs/{run_id}/events")' in out
    assert '@app.get("/.well-known/workflow.json")' in out


def test_listen_routes_only_when_asked():
    with_ = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"', listen=True)
    assert '@app.post("/listen")' in with_
    assert '@app.get("/live")' in with_
    assert '"--listen"' in with_
    without = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"')
    for needle in ('/listen', '/live', '--listen', 'make_listener'):
        assert needle not in without, needle


def test_carries_the_callers_import_line_verbatim():
    line = 'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME'
    assert line in RunServerEmitter.emit('Demo', 'doc body', line, 'WORKFLOW_VERSION = "1"')


def test_the_version_line_is_always_defined():
    out = RunServerEmitter.emit('Demo', 'doc body', 'from workflow import run_workflow', 'WORKFLOW_VERSION = "1"')
    assert '\nWORKFLOW_VERSION = "1"\n' in out
    assert '{WORKFLOW_VERSION}' in out


def test_common_block_gives_the_sink_api_py_imports():
    common = RunServerEmitter.commonBlock()
    assert 'def set_event_sink(' in common
    assert 'def emit_event(' in common
    assert 'def resolve_gate(' in common


def test_package_emits_the_same_four_files_for_every_target():
    for suffix in ('adk', 'maf', 'nooa'):
        pkg = RunServerEmitter.package({'code': '# workflow'}, 'Dispatcher demo', suffix, f'{suffix} run server')
        assert pkg['root'] == f'dispatcher_demo_{suffix}'
        files = {f['path']: f['code'] for f in pkg['files']}
        assert list(files) == ['__init__.py', 'workflow.py', 'common.py', 'api.py']
        assert files['workflow.py'] == '# workflow'
        assert 'import threading' in files['common.py']
        assert 'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME' in files['api.py']
        assert 'WORKFLOW_VERSION = "1"' in files['api.py']
        assert f'{suffix} run server' in files['api.py']
