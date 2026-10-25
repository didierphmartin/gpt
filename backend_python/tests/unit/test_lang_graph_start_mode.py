"""Port of backend/tests/Unit/LangGraphStartModeTest.php (spec 2026-10-15 langgraph standalone §2: the Start
decides the default mode)."""
from __future__ import annotations

import re

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.start_option_graph import StartOptionGraph
from tests.unit import lg_support as S

POLL = ("def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n")


def _db(cron: str | None = None, paused: bool = False):
    stmts = [*S.MCP_DDL, S.LLM_DDL,
             'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
             "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1)",
             "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
             "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')"]
    if cron is not None:
        stmts.append(f"INSERT INTO scheduled_workflows VALUES (1, 44, 'cron', '{cron}', '{'paused' if paused else 'pending'}', NULL)")
    return S.db(*stmts)


def _generate(graph: dict, options: dict | None = None, database=None, orchestration: str = 'workflow') -> dict:
    wf = Workflow({'id': 44, 'name': 'Email prototype', 'user_id': '3'}).setOrchestration(orchestration)
    return S.generator(database or _db(), graph, wf).generate(44, '3', options or {})


def _option_graph(watchServer: str = 'Outlook', startArgs: dict | None = None, passArgs: list | None = None) -> dict:
    start = {'type': 'start', 'start_option': 5, **({'start_args': startArgs} if startArgs else {})}
    raw = {'nodes': [
        {'id': '17', 'node_type': 'start', 'config': start},
        {'id': '18', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from_node_id': '17', 'to_node_id': '18', 'from_port': 'output_1'}]}
    return StartOptionGraph.expand(raw, lambda i: {'name': 'Outlook: get new email', 'code': POLL,
        'exits': ['new_mail', 'no_mail'], 'mcp_servers': ['Outlook'], 'timeout_s': 30,
        'start_trigger': {'label': 'Outlook: get new email', 'work_exit': 'new_mail', 'pass_args': passArgs or [],
                          'watch': {'server': watchServer, 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}}})


def _prompt_graph() -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'hi'}},
        {'id': '2', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from_node_id': '1', 'to_node_id': '2', 'from_port': 'output_1'}]}


def _flat(code: str) -> str:
    return re.sub(r'\s*\n\s*', ' ', re.sub(r'\{\s+', '{', re.sub(r'\s+\}', '}', code)))


def test_start_option_compiles_as_watch_with_its_own_trigger():
    code = _generate(_option_graph())['code']
    assert 'START_MODE = "watch"' in code
    assert 'WORK_EXIT = "new_mail"' in code
    assert 'TRIGGER_NODE_ID = "1000000017"' in code
    assert 'DEFAULT_WATCH = {"server": "outlook", "tool": "wait_for_new", "args": {"folder": "Inbox"}}' in _flat(code)


def test_lang_graph_default_watch_line_has_pass_args():
    code = _generate(_option_graph('Outlook', {'folder': 'Mail in', 'sharepoint_folder': 'D', 'tag': 't'}, ['folder']))['code']
    assert 'DEFAULT_WATCH = {"server": "outlook", "tool": "wait_for_new", "args": {"folder": "Mail in", "tag": "t"}}' in _flat(code)
    assert '"sharepoint_folder": "D"' not in code


def test_watch_server_name_is_slugged():
    assert '"server": "outlook"' in _generate(_option_graph('outlook'))['code']


def test_prompt_start():
    code = _generate(_prompt_graph())['code']
    assert 'START_MODE = "prompt"' in code
    assert 'WORK_EXIT = None' in code
    assert 'TRIGGER_NODE_ID = None' in code


def test_schedule_start_and_paused_schedule():
    assert 'START_MODE = "cron"' in _generate(_prompt_graph(), {}, _db('*/5 * * * *'))['code']
    assert 'START_MODE = "prompt"' in _generate(_prompt_graph(), {}, _db('*/5 * * * *', True))['code']


def test_modular_workflow_carries_the_mode():
    files = S.files_of(_generate(_option_graph(), {'modular': True}))
    assert 'START_MODE = "watch"' in files['workflow.py']


def test_start_option_refused_in_a_swarm():
    with pytest.raises(RuntimeError, match=re.escape('A Start option (Outlook: get new email) needs the single-file or modular format.')):
        _generate(_option_graph(), {'modular': True}, None, 'swarm')


def test_start_option_refused_in_a2_a():
    with pytest.raises(RuntimeError, match=re.escape('A Start option (Outlook: get new email) needs the single-file or modular format.')):
        _generate(_option_graph(), {'a2a': True})
