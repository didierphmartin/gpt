"""Port of backend/tests/Unit/LangGraphJevDispatchTest.php.

LangGraph compiler: a dispatcher routes with a decision model (a provider row, e.g. TypeSafe's Jev) or
with the model, never both, the same way GraphWorkflowRunner does. Checked in every LangGraph mode that
runs a dispatcher; the emitted runtime is exercised by PHP's tests/fixtures/jev_dispatch_harness.py.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.dispatch_routing import DispatchRouting
from app.agent_team.services.lang_graph_generator import LangGraphGenerator
from tests.unit import lg_support as S

BLOCK_START = '# Decision-model routing (twin of DecisionProtocols.php'
BLOCK_END = '        return RouteDecision(text=text, route=chosen["id"], notes=notes, status="ok")'
NODE_START = 'class Node(ABC):'
NODE_END = '            raise ValueError(f"unknown node kind: {cfg[\'kind\']!r}")'


def _graph() -> dict:
    def agent(name, typ='standard', extra=None):
        return {**{'type': 'agent-template', 'agent_name': name, 'agent_type': typ,
                   'instructions': f'You are {name}.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-5',
                   'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096}}, **{k: v for k, v in (extra or {}).items()
                                                                                         if k not in ('type', 'agent_name')}}
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'My laptop will not boot'}},
            {'id': '2', 'node_type': '', 'config': agent('techBuddy', 'dispatcher', {'description': 'the front desk'})},
            {'id': '3', 'node_type': '', 'config': agent('IT claims', 'standard', {'description': 'Laptops and VPN.'})},
            {'id': '4', 'node_type': '', 'config': agent('Human resources')},
            {'id': '5', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '2', 'to': '4'},
                  {'from': '3', 'to': '5'}, {'from': '4', 'to': '5'}],
    }


class _Record:
    def __init__(self, arr: dict):
        self.arr = arr

    def toArray(self) -> dict:
        return dict(self.arr)


class _AnyAgentRepo:
    """createMock()->willReturn($record): the same record for every id."""
    def __init__(self, record):
        self.record = record

    def findById(self, id_):
        return self.record


def _generator(graph: dict | None = None, record=None, database=None) -> LangGraphGenerator:
    return LangGraphGenerator(database or S.demo_db(), S.WfRepo({'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'}),
                              S.GraphRepo(graph or _graph()), _AnyAgentRepo(record))


def _modes() -> dict:
    gen = _generator()
    single = gen.generate(44, '3')['code']
    mod = S.files_of(gen.generate(44, '3', {'modular': True}))
    a2a = S.files_of(gen.generate(44, '3', {'a2a': True}))
    return {
        'single': (single, single),
        'modular': (mod.get('common.py', ''), mod.get('agents/techbuddy.py', '')),
        'a2a': (a2a.get('agents/2_techbuddy.py', ''), a2a.get('agents/2_techbuddy.py', '')),
    }


def _j(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def test_every_mode_emits_the_jev_fast_path_and_its_data():
    question = DispatchRouting.defaultInstructions('techBuddy', 'the front desk', 'Dispatcher demo')
    assert question == ('You are "techBuddy", the front desk, an agent in the workflow "Dispatcher demo". '
                        'Handle the request you receive directly and completely, in the role your name implies.')
    for mode, (runtime, node) in _modes().items():
        assert runtime != '', f'{mode}: runtime file missing'
        for needle in ['    def route(self, request: str, targets: list[dict], question: str, floor: float = CONFIDENCE_FLOOR) -> DecisionResult:',
                       '    URL = "https://api.typesafe.ai/v1/systemone"', '    MODEL = "jev-latest"', '    CONFIDENCE_FLOOR = 0.6', '    TIMEOUT_S = 10',
                       '    LEGACY_KEY_ENV = "TYPESAFE_API_KEY"', 'DECISION_ADAPTERS = {"typesafe": JevRouter}',
                       '        match self.cfg.get("routing_mode", ""):', '        match self.mode():',
                       'self.cfg.get("decision_question", "")',
                       'ctx.load_verify_locations(certifi.where())',
                       "{key} routed to {chosen['name']!r}", 'decision-model dispatcher, no model fallback']:
            assert needle in runtime, f'{mode}: {needle}'
        assert 'asking the model' not in runtime, f'{mode}: no hybrid'
        assert 'Jev declined' not in runtime, f'{mode}: no hybrid'
        assert (runtime.index('return await self._via_decision(key, task)')
                < runtime.index('llm = make_llm().bind_tools([self._route_tool()], tool_choice="any")')), f'{mode}: the mode is decided first'
        assert '"routing_mode": "",' in node, f'{mode}: routing_mode'
        assert '"min_confidence": 0.6,' in node, f'{mode}: floor'
        assert ('"decision": [{"provider": "jev", "protocol": "typesafe", "url": "https://api.typesafe.ai/v1/systemone", '
                '"model": "jev-latest", "key_env": "JEV_API_KEY", "url_env": "JEV_BASE_URL"}],') in node, f'{mode}: decision'
        assert ('"dispatch": [{"id": "3", "name": "IT claims", "description": ""}, '
                '{"id": "4", "name": "Human resources", "description": ""}]') in node, f'{mode}: menu'
        assert '"decision_question": ' + _j(question) + ',' in node, f'{mode}: question'
        assert '# Optional: JEV_API_KEY for dispatchers' in node, f'{mode}: TO RUN note'


def _routing_data(graph: dict, record=None) -> dict:
    gen = _generator(graph, record)
    files = {
        'single': gen.generate(44, '3')['code'],
        'modular': S.files_of(gen.generate(44, '3', {'modular': True})).get('agents/techbuddy.py', ''),
        'a2a': S.files_of(gen.generate(44, '3', {'a2a': True})).get('agents/2_techbuddy.py', ''),
    }
    got = {}
    for mode, code in files.items():
        assert re.search(r'"routing_mode": "[a-z-]*",', code), f'{mode}: routing_mode'
        m1 = re.search(r'"routing_mode": ("[a-z-]*"),', code)
        m2 = re.search(r'"min_confidence": ([0-9.]+),', code)
        got[mode] = [m1.group(1) if m1 else None, m2.group(1) if m2 else None]
    return got


def _with_settings(settings: dict) -> dict:
    graph = _graph()
    graph['nodes'][1]['config']['settings'] = {**graph['nodes'][1]['config']['settings'], **settings}
    return graph


def test_routing_mode_and_floor_are_emitted_in_every_mode():
    cases = [
        ({'routing_mode': 'jev', 'jev_min_confidence': 0.85}, '"jev"', '0.85'),
        ({'routing_mode': 'llm'}, '"llm"', '0.6'),
        ({'routing_mode': 'bogus'}, '"bogus"', '0.6'),
        ({'routing_mode': ' jev '}, '"jev"', '0.6'),
        ({'routing_mode': ''}, '""', '0.6'),
        ({'routing_mode': 'jev', 'min_confidence': 0.8, 'jev_min_confidence': 0.3}, '"jev"', '0.8'),
        ({'routing_mode': 'jev', 'min_confidence': 0.75}, '"jev"', '0.75'),
        ({'routing_mode': 'jev', 'jev_min_confidence': 1.7}, '"jev"', '1.0'),
        ({'routing_mode': 'jev', 'jev_min_confidence': -2}, '"jev"', '0.0'),
        ({'routing_mode': 'jev', 'jev_min_confidence': '0.7'}, '"jev"', '0.7'),
        ({'routing_mode': 'jev', 'jev_min_confidence': 'high'}, '"jev"', '0.6'),
        ({'routing_mode': 'jev', 'jev_min_confidence': None}, '"jev"', '0.6'),
    ]
    for settings, mode, floor in cases:
        for m, got in _routing_data(_with_settings(settings)).items():
            assert got == [mode, floor], f'{m}: {settings}'


def test_saved_agent_record_settings_decide_the_routing_mode():
    graph = _with_settings({'routing_mode': 'jev', 'jev_min_confidence': 0.9})
    graph['nodes'][1]['config']['agent_id'] = 77

    def record(settings):
        return _Record({'id': 77, 'name': 'techBuddy', 'description': 'the front desk', 'agent_type': 'dispatcher',
                        'instructions': '', 'provider': 'claude', 'model': 'claude-sonnet-4-5', 'settings': settings})
    for settings, want in (({'routing_mode': 'llm', 'jev_min_confidence': 0.75}, ['"llm"', '0.75']), ({}, ['""', '0.6'])):
        for m, got in _routing_data(graph, record(settings)).items():
            assert got == want, f'{m}: {settings}'
    for m, got in _routing_data(graph, None).items():
        assert got == ['"jev"', '0.9'], m


def test_dispatcher_with_no_route_reaches_end_in_every_graph():
    gen = _generator(_with_settings({'routing_mode': 'jev'}))
    graphs = {
        'single': gen.generate(44, '3')['code'],
        'modular': S.files_of(gen.generate(44, '3', {'modular': True})).get('common.py', ''),
        'a2a': S.files_of(gen.generate(44, '3', {'a2a': True})).get('orchestrator.py', ''),
    }
    for mode, code in graphs.items():
        assert 'return lambda state: state.get("routes", {}).get(nid) or END' in code, mode
        assert 'sg.add_conditional_edges(nid, router, {t: t for t in menu} | {END: END})' in code, mode
        assert 'route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END' in code, mode


def test_to_run_note_follows_the_routing_mode():
    def doc(settings):
        return _generator(_with_settings(settings)).generate(44, '3')['code']
    unset = doc({})
    assert '# Optional: JEV_API_KEY for dispatchers with no routing mode saved (techBuddy):' in unset
    assert ('#   the first decision model whose key is set routes (else the model); once one is chosen, '
            'a request it cannot decide stops the run there (no model fallback).') in unset
    assert 'TypeSafe rows also read the legacy TYPESAFE_API_KEY / TYPESAFE_BASE_URL.' in unset
    assert '# Required: JEV_API_KEY' not in unset
    jev = doc({'routing_mode': 'jev'})
    assert '# Required: JEV_API_KEY for dispatchers (techBuddy);' in jev
    assert '# Optional: JEV_API_KEY' not in jev
    llm = doc({'routing_mode': 'llm'})
    assert 'JEV_API_KEY' not in llm
    assert 'TYPESAFE_API_KEY' not in llm
    assert '"decision": [],' in llm


def test_common_py_provides_lists_the_decision_runtime():
    common = S.files_of(_generator().generate(44, '3', {'modular': True})).get('common.py', '')
    assert '  DecisionResult, JevRouter,\n  DECISION_ADAPTERS, RouteDecision,\n  Dispatcher ' in common
    assert 'JevRouter, Dispatcher ' not in common
    for d in ('class DecisionResult', 'class JevRouter', 'DECISION_ADAPTERS = {', 'class RouteDecision', 'class Dispatcher'):
        assert d in common, 'PROVIDES lists only what is emitted'


def test_saved_agent_record_names_the_jev_question():
    graph = _graph()
    graph['nodes'][1]['config']['agent_id'] = 77
    record = _Record({'id': 77, 'name': 'Front Desk', 'description': 'routes every ticket', 'agent_type': 'dispatcher',
                      'instructions': '', 'provider': 'claude', 'model': 'claude-sonnet-4-5'})
    blank = _Record({'id': 78, 'name': '', 'description': '', 'agent_type': 'dispatcher'})
    for agent, want in ((record, DispatchRouting.defaultInstructions('Front Desk', 'routes every ticket', 'Dispatcher demo')),
                        (blank, DispatchRouting.defaultInstructions('techBuddy', 'the front desk', 'Dispatcher demo'))):
        code = _generator(graph, agent).generate(44, '3')['code']
        assert '"decision_question": ' + _j(want) + ',' in code


def test_interpreter_targets_carry_no_description():
    nodes = {2: {'node_type': 'agent', 'config': {'agent_name': 'A', 'description': 'role'}},
             3: {'node_type': 'agent', 'config': {'agent_name': 'B'}}}
    edges = [{'from_node_id': 1, 'to_node_id': 2}, {'from_node_id': 1, 'to_node_id': 3}]
    for t in DispatchRouting.targets(1, edges, nodes):
        assert 'description' not in t


def test_every_mode_compiles():
    for mode, (runtime, node) in _modes().items():
        seen = []
        for i, code in enumerate((runtime, node)):
            if code in seen:
                continue
            seen.append(code)
            S.assert_compiles(code, f'{mode}#{i}')


def test_emitted_runtime_routes_or_stops():
    py = 'python3'
    r = subprocess.run([py, '-c', 'import sys; assert sys.version_info >= (3, 10)'], capture_output=True)
    if r.returncode != 0:
        import pytest
        pytest.skip('python3 >= 3.10 not available')
    env = {k: v for k, v in os.environ.items() if k not in ('TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'JEV_API_KEY', 'JEV_BASE_URL')}
    for mode, (runtime, _) in _modes().items():
        a = runtime.index(BLOCK_START)
        b = runtime.index(BLOCK_END)
        block = runtime[a:b + len(BLOCK_END)] + '\n'
        k = runtime.index(NODE_START)
        kEnd = runtime.index(NODE_END)
        classes = runtime[k:kEnd + len(NODE_END)] + '\n'
        d = tempfile.mkdtemp(prefix='jev')
        with open(f'{d}/b.py', 'w', encoding='utf-8') as f:
            f.write(block)
        with open(f'{d}/b_nodes.py', 'w', encoding='utf-8') as f:
            f.write(classes)
        r = subprocess.run([py, str(S.PHP_FIXTURES / 'jev_dispatch_harness.py'), f'{d}/b.py', f'{d}/b_nodes.py'],
                           capture_output=True, text=True, env=env)
        out = [line for line in (r.stdout + r.stderr).split('\n') if line != '']
        assert r.returncode == 0, f'{mode}: ' + '\n'.join(out)
        assert out[-1] == 'OK 29 cases', mode


def test_each_dispatcher_carries_its_provider_and_env_names():
    database = S.demo_db()
    database.execute("INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order) "
                     "VALUES ('jev-eu', 'Jev EU', 'jev-latest', 'https://gw.corp/jev', 'router', 'typesafe', 1, 50)")
    graph = _graph()
    graph['nodes'][1]['config']['settings']['routing_mode'] = 'jev-eu'
    code = _generator(graph, None, database).generate(44)['code']
    assert '"routing_mode": "jev-eu"' in code
    assert '"key_env": "JEV_EU_API_KEY"' in code
    assert '"url": "https://gw.corp/jev"' in code
    assert code.count('class JevRouter') == 1, 'one adapter per protocol used'
    assert 'JEV_EU_API_KEY' in code, 'the TO RUN note names the per-row env var'


def test_an_unset_dispatcher_lists_every_provider_in_admin_order():
    database = S.demo_db()
    database.execute("INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order) "
                     "VALUES ('acme', 'Acme', 'jev-latest', NULL, 'router', 'typesafe', 1, 50)")
    code = _generator(_graph(), None, database).generate(44)['code']
    assert code.index('"provider": "acme"') < code.index('"provider": "jev"')


def test_a_node_naming_a_missing_provider_compiles_with_no_candidate():
    graph = _graph()
    graph['nodes'][1]['config']['settings']['routing_mode'] = 'gone'
    code = _generator(graph).generate(44)['code']
    assert '"routing_mode": "gone"' in code
    assert '"decision": []' in code
