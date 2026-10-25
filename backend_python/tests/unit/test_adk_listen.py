"""Port of backend/tests/Unit/AdkListenTest.php: the Start's mode (StartTriggerFacts), the run events ADK
records, and the listening package (POST /listen, GET /live)."""
from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import subprocess
import tempfile

import pytest

from app.agent_team.services.adk_generator import ADKGenerator, ADKPackage
from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.run_server_emitter import RunServerEmitter
from app.agent_team.services.start_trigger_facts import StartTriggerFacts
from tests.unit.lg_support import VENV, python3
from tests.unit.playbook.conftest import SqliteDb
from tests.unit.test_adk_code_node import code_analyzed, wf64_analyzed


def _trigger_nodes(server: str = 'Outlook') -> list:
    return [
        {'id': '1', 'type': 'start', 'config': {'type': 'start'}},
        {'id': '1000000001', 'type': 'code', 'config': {'type': 'code', 'name': 'T', 'start_trigger': {
            'label': 'T', 'work_exit': 'new_mail',
            'watch': {'server': server, 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}}}},
    ]


def test_trigger_node_makes_the_start_watch():
    f = StartTriggerFacts.of(None, 64, _trigger_nodes(), {'http://x': 'outlook'})
    assert f['startMode'] == 'watch'
    assert f['defaultWatch'] == {'server': 'outlook', 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}
    assert f['triggerNodeId'] == '1000000001'


def test_compiled_watch_merges_pass_args_and_tag():
    nodes = _trigger_nodes()
    nodes[1]['config']['start_trigger']['pass_args'] = ['folder']
    nodes[1]['config']['args'] = {'folder': 'Mail in', 'tag': 't', 'sharepoint_folder': 'D'}
    f = StartTriggerFacts.of(None, 64, nodes, {'http://x': 'outlook'})
    assert f['defaultWatch']['args'] == {'folder': 'Mail in', 'tag': 't'}


def test_watch_args_merges_only_the_named_start_args():
    assert StartTriggerFacts.watchArgs({'poll': 'p', 'folder': 'To SharePoint'}, {'folder': 'Mail in', 'x': 1}, ['folder']) \
        == {'poll': 'p', 'folder': 'Mail in'}
    assert StartTriggerFacts.watchArgs({'folder': 'To SharePoint'}, {'folder': '', 'tag': '', 'x': 1}, ['folder', 'y']) \
        == {'folder': 'To SharePoint'}


def test_watch_on_an_unused_server_is_refused():
    with pytest.raises(Exception, match='which no node of this workflow uses'):
        StartTriggerFacts.of(None, 64, _trigger_nodes('Gmail'), {'http://x': 'outlook'})


def test_no_trigger_no_schedule_is_a_prompt_start():
    db = SqliteDb(sqlite3.connect(':memory:'))   # no scheduled_workflows table
    f = StartTriggerFacts.of(db, 64, [{'id': '1', 'type': 'start', 'config': {'type': 'start'}}], {})
    assert f == {'startMode': 'prompt', 'defaultCron': None, 'defaultWatch': None, 'triggerNodeId': None}


def test_script_bakes_the_start_mode():
    a = code_analyzed()
    a['startMode'] = 'watch'
    a['defaultWatch'] = {'server': 'outlook', 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}
    code = ADKGenerator.emitAdk(a)
    assert 'START_MODE = "watch"' in code
    assert 'DEFAULT_CRON = None' in code
    assert re.search(r'DEFAULT_WATCH = \{\s*"server": "outlook",\s*"tool": "wait_for_new",\s*"args": \{\s*"folder": "Inbox"\s*\}\s*\}', code)
    assert 'START_MODE = "prompt"' in ADKGenerator.emitAdk(code_analyzed())


def test_recording_covers_nodes_but_not_the_dispatcher_chooser():
    code = ADKGenerator.emitAdk(wf64_analyzed())
    assert re.search(r'NODE_META = \{.*"node_10": \[\s*"10",\s*"code",\s*"T"\s*\]', code, re.S)
    assert re.search(r'"node_5": \[\s*"5",\s*"output",\s*"Output"\s*\]', code, re.S)
    assert '"node_2": [' not in code   # the chooser: _DispatcherAgent records node 2
    assert 'START_NODE = ["1", "Start"]' in code
    assert 'OUTPUT_NODE_KEYS = ["node_5"]' in code
    assert '_attach_recording(root_agent)' in code
    assert 'node_id="2",\n    display="D",' in code


_REC_PROBE = '''
class Rec:
    def __init__(self): self.ev = []
    def node_start(self, *a): self.ev.append(["start", *a])
    def node_complete(self, *a, **k): self.ev.append(["complete", *a, k])
class Ctx:
    def __init__(self, name, state): self.agent_name, self.state = name, state
class Agent:
    def __init__(self, name, subs=()): self.name, self.sub_agents = name, list(subs)
GRAPH_RECORDER = Rec()
_run_reset()
root = Agent("workflow", [Agent("node_10"), Agent("gate_2", [Agent("node_2__dispatch", [Agent("node_2"), Agent("node_3")])])])
_attach_recording(root)
t = root.sub_agents[0]
assert t.before_agent_callback is _rec_before and not hasattr(root.sub_agents[1].sub_agents[0].sub_agents[0], "before_agent_callback")
st = {"node_10": '{"subject": "hi"}', "route_10": "new_mail"}
_rec_before(Ctx("node_10", st)); _rec_after(Ctx("node_10", st))
_rec_node_start("3", "A", "code")   # then the run fails: run_workflow closes it
for nid, (name, typ) in list(_RUN["open"].items()):
    _rec_node_complete(nid, name, typ, success=False, error="RuntimeError: boom")
import json
print(json.dumps([GRAPH_RECORDER.ev, _RUN["ran"], _RUN["routes"]]))'''


def test_recording_helpers_emit_the_run_events():
    """The RUN EVENTS helpers, run with a fake recorder and fake callback contexts."""
    code = ADKGenerator.emitAdk(wf64_analyzed())
    start = code.index('NODE_META = ')
    end = code.index('# =====', start)
    path = os.path.join(tempfile.gettempdir(), f'adkrec_{secrets.token_hex(4)}.py')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(code[start:end] + _REC_PROBE)
    r = subprocess.run([python3(), path], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    ev, ran, routes = json.loads(r.stdout.strip().split('\n')[-1])
    assert ev[0] == ['start', '10', 'T', 'code']
    assert ev[1] == ['complete', '10', 'T', 'code', {'output': '{"subject": "hi"}', 'exit': 'new_mail'}]
    assert ev[3] == ['complete', '3', 'A', 'code', {'output': '', 'success': False, 'error': 'RuntimeError: boom'}]
    assert ran == ['10', '3']
    assert routes == {'10': 'new_mail'}


def listening_package(url: str = 'http://localhost:8770') -> dict:
    """The wf 64-shaped package as files (no DB): workflow.py, common.py, api.py and ADKPackage's."""
    a = wf64_analyzed()
    a['serverSlugs'] = {url: 'outlook'}
    a['startMode'] = 'watch'
    a['defaultWatch'] = {'server': 'outlook', 'tool': 'wait_for_new', 'args': []}
    a['package'] = True
    pkg = RunServerEmitter.package({'code': ADKGenerator.emitAdk(a)}, 'wf64', 'adk', 'ADK run server',
                                   CompiledRuntimeEmit.packageCommonBlock(), True)
    files = {f['path']: f['code'] for f in pkg['files']}
    for f in ADKPackage.files(a, tempfile.gettempdir()):
        files[f['path']] = f['code']
    return files


def test_package_serves_listen_and_live():
    f = listening_package()
    assert '@app.post("/listen")' in f['api.py']
    assert 'from workflow import make_listener, RUNS_DIR, START_MODE, LoopState' in f['api.py']
    assert 'class RunRecorder' in f['common.py']
    assert 'def live_next(' in f['common.py']
    assert 'def make_listener(state' in f['workflow.py']
    assert 'MCP = _McpShim()' in f['workflow.py']
    assert 'class Listener:' in f['workflow.py']


def test_package_imports_under_the_runner_venv():
    if not os.path.isfile(VENV):
        pytest.skip('runner venv missing')
    d = os.path.join(tempfile.gettempdir(), 'adklisten_' + secrets.token_hex(4))
    for path, code in listening_package().items():
        os.makedirs(os.path.dirname(os.path.join(d, path)), exist_ok=True)
        with open(os.path.join(d, path), 'w', encoding='utf-8') as fh:
            fh.write(code)
    r = subprocess.run([VENV, '-c', 'import common, workflow, api; l = workflow.make_listener(workflow.LoopState()); '
                        'print(type(l).__name__, workflow.START_MODE)'], cwd=d, capture_output=True, text=True,
                       env={**os.environ, 'ANTHROPIC_API_KEY': 'x'})
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.strip().split('\n')[-1] == 'Listener watch'


def test_env_example_names_the_decision_keys():
    a = wf64_analyzed()
    a['decisions'] = {'2': {'decision_question': 'q', 'routing_mode': 'jev', 'unclear_branch': '', 'min_confidence': 0.6,
                            'decision': [{'provider': 'jev', 'protocol': 'typesafe', 'url': 'https://x', 'model': 'jev-latest',
                                          'key_env': 'JEV_API_KEY', 'url_env': 'JEV_BASE_URL'}]}}
    env = {f['path']: f['code'] for f in ADKPackage.files(a, tempfile.gettempdir())}['.env.example']
    assert '# JEV_API_KEY=\n# JEV_BASE_URL=' in env
    code = ADKGenerator.emitAdk(a)
    assert 'routing_mode="jev",' in code
    assert 'class JevRouter:' in code
    assert 'DECISION_ADAPTERS = {' in code
