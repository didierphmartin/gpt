"""Port of backend/tests/Unit/LangGraphOutputStructureTest.php.

The LangGraph compiler's output as a whole -- single file, modular package, A2A -- checked statically
(names, imports, docstrings, readability), for the documentation it must keep, and by running the emitted
code against a stub chat model. The checkers and the probe are PHP's own fixtures
(backend/tests/fixtures/lg_static_checks.py, lg_run_probe.py, lg_doc_baseline/), used from there.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from tests.unit import lg_support as S

FIXTURES = S.PHP_FIXTURES
DOC_BASELINE = FIXTURES / 'lg_doc_baseline'


@pytest.fixture(autouse=True)
def _cleanup():
    S_TEMP.clear()
    yield
    for p in S_TEMP:
        shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else (os.path.exists(p) and os.unlink(p))


S_TEMP: list = []
_skills_root = {'value': None}


def _temp_path(prefix: str, suffix: str = '') -> str:
    p = os.path.join(tempfile.gettempdir(), prefix + os.urandom(4).hex() + suffix)
    S_TEMP.append(p)
    return p


def _files(graph: dict, mode: str, withApi: bool = False) -> dict:
    gen = S.generator(S.demo_db(), graph, skillsRoot=_skills_root['value'] or S.skills_root())
    if mode == 'single':
        r = gen.generate(44, '3')
        return {r['filename']: r['code']}
    out = {}
    for f in gen.generate(44, '3', {mode: True})['files']:
        if not f['path'].endswith('.py') or f['path'].startswith('skills/'):
            continue
        if withApi or f['path'] != 'api.py':
            out[f['path']] = f['code']
    return out


def _write(files: dict) -> dict:
    """Write under <tmp>/lgos_<hex>/python/scripts/wf, the runner's layout."""
    root = _temp_path('lgos_') + '/python/scripts/wf'
    paths = {}
    for rel, code in files.items():
        paths[rel] = root + '/' + rel
        os.makedirs(os.path.dirname(paths[rel]), exist_ok=True)
        Path(paths[rel]).write_text(code, encoding='utf-8')
    return {'root': root, 'paths': paths}


def _static_check(check: str, paths: dict) -> list:
    r = subprocess.run(['python3', str(FIXTURES / 'lg_static_checks.py'), check, *paths.values()],
                       capture_output=True, text=True)
    out = (r.stdout + r.stderr)
    assert r.returncode == 0, out
    return [line for line in out.split('\n') if line != '']


def test_every_baseline_documentation_line_survives():
    reworded = json.loads((DOC_BASELINE / 'reworded.json').read_text(encoding='utf-8')) or {}
    for mode in ('single', 'modular', 'a2a'):
        now = _static_check('docs', _write(_files(S.graphs()['dispatcher_demo'], mode))['paths'])
        baseline = [line for line in (DOC_BASELINE / f'{mode}.txt').read_text(encoding='utf-8').split('\n') if line != '']
        assert baseline, f'{mode}: documentation baseline is empty, so it would pass vacuously'
        have = set(now)
        lost = []
        for line in baseline:
            r = reworded.get(line)
            ok = (line in have or (r is not None and 'now' in r
                                   and ((r['now'] is None and str(r.get('why') or '').strip() != '')
                                        or (r['now'] is not None and r['now'] in have))))
            if not ok:
                lost.append(line)
        assert lost == [], f'{mode}: documentation lost -- move it with its code, or record the rewording in reworded.json'


def test_no_lang_graph_file_references_an_undefined_global():
    allowed = ['__file__']
    for name, graph in S.graphs().items():
        for mode in ('single', 'modular', 'a2a'):
            w = _write(_files(graph, mode, True))
            found = [line for line in _static_check('undefined', w['paths']) if line[line.rfind(' ') + 1:] not in allowed]
            assert found == [], f'{name}/{mode}'


def test_no_lang_graph_file_imports_an_unused_name():
    for name, graph in S.graphs().items():
        for mode in ('single', 'modular', 'a2a'):
            assert _static_check('unused', _write(_files(graph, mode))['paths']) == [], f'{name}/{mode}'


def test_every_lang_graph_class_and_public_function_has_a_docstring():
    for name, graph in S.graphs().items():
        for mode in ('single', 'modular', 'a2a'):
            assert _static_check('docstrings', _write(_files(graph, mode))['paths']) == [], f'{name}/{mode}'


def test_node_type_and_routing_mode_are_match_statements():
    for mode in ('single', 'modular', 'a2a'):
        allc = '\n'.join(_files(S.graphs()['dispatcher_demo'], mode).values())
        assert 'match ntype:' in allc, mode
        assert 'if ntype == "start":' not in allc, mode
        assert '        match self.mode():' in allc, mode
        assert '    if mode == "jev":' not in allc, mode


def _venv_python() -> str:
    py = os.environ.get('LANGGRAPH_TEST_PYTHON') or (os.environ.get('HOME', '') + '/Documents/synergyAI/python/.venv/bin/python')
    try:
        r = subprocess.run([py, '-c', 'import langchain_core, langgraph'], capture_output=True)
    except OSError:
        pytest.skip(f'runner venv python not usable: {py}')
    if r.returncode != 0:
        pytest.skip(f'runner venv python not usable: {py}')
    return py


def _probe(args: list, env: dict | None = None) -> tuple:
    """Run lg_run_probe.py; returns (decoded RESULT, full console)."""
    e = {k: v for k, v in os.environ.items() if k not in ('TYPESAFE_API_KEY', 'MODEL_NAME', 'PLAYBOOK_GATE_MODE')}
    e.update(env or {})
    r = subprocess.run([_venv_python(), str(FIXTURES / 'lg_run_probe.py'), *args], capture_output=True, text=True, env=e)
    out = (r.stdout + r.stderr).rstrip('\n').split('\n')
    console = '\n'.join(out)
    assert r.returncode == 0, console
    line = out[-1]
    assert line.startswith('RESULT '), console
    return json.loads(line[7:]), console


def test_every_node_kind_runs_through_make_node():
    files = _files(S.graphs()['dispatcher_demo'], 'modular')
    assert 'class Node(ABC):' in files['common.py']
    assert 'def make_node(cfg: dict) -> Node:' in files['common.py']
    for p in ('agents/techbuddy.py', 'agents/it_claims.py', 'agents/playbook_hr.py'):
        assert 'run_node = make_node(NODE).run' in files[p], p
        assert 'async def ' not in files[p], f'{p}: node logic lives in common.py'
    root = _write(files)['root']
    r, _ = _probe(['node', 'module', root, 'agents.techbuddy', 'my laptop will not boot'], {'STUB_ROUTE_TO': 'IT claims'})
    assert r == {'text': 'my laptop will not boot', 'route': '3', 'notes': '', 'status': 'ok'}
    r, log = _probe(['node', 'module', root, 'agents.human_resources', 'two days off'])
    assert r['status'] == 'ok'
    assert 'answer to: two days off' in r['text']
    assert 'inputs: system=' in log
    r, _ = _probe(['node', 'module', root, 'agents.playbook_hr', 'two days off'], {'PLAYBOOK_GATE_MODE': 'auto'})
    assert r['text'].startswith('# Playbook: Time Off (')


def test_playbook_only_workflow_runs_in_every_mode():
    graph = S.graphs()['playbook_only']
    single = _write(_files(graph, 'single'))
    r, _ = _probe(['workflow', 'single', list(single['paths'].values())[0], 'I want two days off'], {'PLAYBOOK_GATE_MODE': 'auto'})
    assert r['output'].startswith('# Playbook: Time Off (')
    r, _ = _probe(['workflow', 'modular', _write(_files(graph, 'modular'))['root'], 'I want two days off'], {'PLAYBOOK_GATE_MODE': 'auto'})
    assert r['output'].startswith('# Playbook: Time Off (')
    a2a = _write(_files(graph, 'a2a'))
    r, _ = _probe(['node', 'a2a', a2a['paths']['agents/2_playbook-hr.py'], 'I want two days off'], {'PLAYBOOK_GATE_MODE': 'auto'})
    assert r['text'].startswith('# Playbook: Time Off (')


def test_missing_provider_package_fails_only_that_node():
    path = list(_write(_files(S.graphs()['linear'], 'single'))['paths'].values())[0]
    cfg = json.dumps({'id': '9', 'kind': 'agent', 'display': 'G', 'provider': 'gemini', 'model': 'gemini-x',
                      'temperature': 0.7, 'max_tokens': 100, 'thinking': None, 'system_prompt': 'x', 'tool_names': [], 'skills': []},
                     separators=(',', ':'))
    r, _ = _probe(['llm', path, cfg], {'STUB_BLOCK_IMPORT': 'langchain_google_genai'})
    assert str(r['error']).startswith('ImportError'), 'import and make_node() succeed; only .llm fails'
    assert "node 9 'G'" in str(r['error'])
    assert "'gemini'" in str(r['error'])
    r, _ = _probe(['llm', path, cfg.replace('"gemini-x"', '""')])
    assert str(r['error']).startswith('RuntimeError')
    assert "node 9 'G'" in str(r['error'])
    assert "'gemini'" in str(r['error'])


def test_a2_a_agent_files_run_their_node_through_make_node():
    a2a = _write(_files(S.graphs()['dispatcher_demo'], 'a2a'))
    r, _ = _probe(['node', 'a2a', a2a['paths']['agents/2_techbuddy.py'], 'I need vacation'], {'STUB_ROUTE_TO': 'Human resources'})
    assert r['route'] == '4'
    r, _ = _probe(['node', 'a2a', a2a['paths']['agents/4_human-resources.py'], 'I need vacation'])
    assert {k: v for k, v in r.items() if k != 'text'} == {'route': '', 'notes': '', 'status': 'ok'}
    r, _ = _probe(['node', 'a2a', a2a['paths']['agents/5_playbook-hr.py'], 'I need vacation'], {'PLAYBOOK_GATE_MODE': 'auto'})
    assert r['text'].startswith('# Playbook: Time Off (')


def test_emitted_classes_follow_the_readability_rule():
    for name, graph in S.graphs().items():
        for mode in ('single', 'modular', 'a2a'):
            assert _static_check('readability', _write(_files(graph, mode))['paths']) == [], f'{name}/{mode}'


def test_dispatcher_is_a_class_and_the_fake_state_is_gone():
    for mode in ('single', 'modular', 'a2a'):
        allc = '\n'.join(_files(S.graphs()['dispatcher_demo'], mode).values())
        assert 'class JevRouter:' in allc, mode
        assert 'class Dispatcher:' in allc, mode
        for gone in ('def parents(_n)', 'state = {"node_outputs": {}, "user_prompt": request}', 'def _jev_route('):
            assert gone not in allc, f'{mode}: {gone}'


def test_single_file_and_package_send_the_same_prompts_and_save_under_the_same_name():
    graph = S.graphs()['dispatcher_demo']
    long = 'Always answer politely and route vacation requests to Human resources. ' * 3
    graph['nodes'][2]['config']['instructions'] = long
    graph['nodes'][0]['config']['prompt'] = long
    single = '\n'.join(_files(graph, 'single').values())
    pkg = _files(graph, 'modular')
    assert long.rstrip() in single, 'single file: system prompt and DEFAULT_PROMPT verbatim'
    assert long.rstrip() in pkg['agents/it_claims.py']
    assert 'def save_output(' in single
    assert 'def save_output(' in pkg['common.py']
    root = _temp_path('lgsave_')
    names = {}
    for mode, target in (('single', list(_write(_files(graph, 'single'))['paths'].values())[0]), ('modular', _write(pkg)['root'])):
        r, _ = _probe(['save', target, 'hello'], {'SYNERGYAI_OUTPUT_ROOT': root})
        names[mode] = re.sub(r'_\d{8}-\d{6}\.', '_<ts>.', os.path.basename(str(r['path'])))
    assert names == {'single': '44-dispatcher-demo_<ts>.md', 'modular': '44-dispatcher-demo_<ts>.md'}


def test_linear_workflow_runs_the_same_in_single_and_modular():
    graph = S.graphs()['linear']
    single = _files(graph, 'single')
    assert 'class WorkflowGraph:' in '\n'.join(single.values())
    a, logA = _probe(['workflow', 'single', list(_write(single)['paths'].values())[0], 'write something'])
    b, _ = _probe(['workflow', 'modular', _write(_files(graph, 'modular'))['root'], 'write something'])
    assert a['output'] == b['output']
    assert a['output'].startswith('answer to:')
    assert '[node] [4] output -- ' in logA


def test_one_graph_implementation_in_every_mode():
    for mode in ('single', 'modular', 'a2a'):
        allc = '\n'.join(_files(S.graphs()['dispatcher_demo'], mode).values())
        assert allc.count('class WorkflowGraph:') == 1, mode
        assert allc.count('def make_start(') == 0, mode
        assert allc.count('def _save_output(') == 0, mode


def test_skill_step_output_becomes_the_node_output():
    base = _temp_path('lgskill_')
    os.makedirs(f'{base}/skills/lgtest/scripts', exist_ok=True)
    Path(f'{base}/skills/lgtest/SKILL.md').write_text('---\nname: lgtest\n---\nRender the input with scripts/make.py.\n')
    Path(f'{base}/skills/lgtest/scripts/make.py').write_text(
        "import sys\nopen(sys.argv[1], 'w', encoding='utf-8').write('<html>made by the skill</html>')\nprint('ok')\n")
    graph = S.graphs()['linear']
    graph['nodes'][2]['config']['bound_skill'] = {'dir_name': 'lgtest'}
    _skills_root['value'] = f'{base}/skills'
    try:
        root = _write(_files(graph, 'modular'))['root']
    finally:
        _skills_root['value'] = None
    r, log = _probe(['node', 'module', root, 'agents.writer', 'write something'], {
        'SYNERGYAI_SKILLS_DIR': f'{base}/skills', 'SYNERGYAI_OUTPUT_ROOT': f'{base}/outputs',
        'STUB_SKILL_CALL': json.dumps({'script': 'scripts/make.py', 'argv': ['/outputs/report.html'],
                                       'read_outputs': ['/outputs/report.html']}, separators=(',', ':')),
    })
    assert r['text'] == '<html>made by the skill</html>', log
    assert "after skill 'lgtest'" in log


def test_tools_and_skills_are_lang_graph_owned_classes():
    for mode in ('single', 'modular', 'a2a'):
        files = _files(S.graphs()['dispatcher_demo'], mode)
        allc = '\n'.join(files.values())
        for n in ('class ToolCatalog:', 'class SkillRuntime:', 'TOOLS = ToolCatalog(TOOL_CATALOG)', 'SKILLS = SkillRuntime('):
            assert n in allc, f'{mode}: {n}'
        for gone in ('def build_tools_from_catalog', 'def _run_skill_script(', 'RUN_SKILL_SCRIPT_TOOL', 'def _summarize_tool_result'):
            assert gone not in allc, f'{mode}: {gone}'
        for path, code in files.items():
            if 'class ToolCatalog:' in code:
                assert code.count('type_map = ') + code.count('TYPE_MAP = ') == 1, f'{mode} {path}: one schema->pydantic helper'


def test_playbook_runtime_is_lang_graphs_own_classes():
    for mode in ('single', 'modular', 'a2a'):
        allc = '\n'.join(_files(S.graphs()['dispatcher_demo'], mode).values())
        for n in ('class RunEvents:', 'class PlaybookRun:', 'class PlaybookToolset:', 'EVENTS = RunEvents()'):
            assert n in allc, f'{mode}: {n}'
        for gone in ('_pb_sink_active', 'except NameError', 'globals().get(', 'def build_playbook_tools('):
            assert gone not in allc, f'{mode}: {gone}'


def test_mcp_client_is_lang_graphs_own_class():
    for mode in ('single', 'modular', 'a2a'):
        allc = '\n'.join(_files(S.graphs()['dispatcher_demo'], mode).values())
        assert 'class McpClient:' in allc, mode
        assert 'MCP = McpClient()' in allc, mode
        assert 'def _init_mcp_session(' not in allc, mode
        assert 'import json as _json' not in allc, mode


def test_mcp_client_talks_json_rpc_and_sse():
    path = list(_write(_files(S.graphs()['linear'], 'single'))['paths'].values())[0]
    r, _ = _probe(['mcp', path])
    assert r == {'texts': ['news ok', 'news ok'], 'initialize': 2}, 'SSE parsed; one handshake per call, as today'


def test_attachments_go_through_the_document_converter():
    graph = S.graphs()['linear']
    doc = _temp_path('lgdoc_', '.md')
    Path(doc).write_text('# Brief\nWrite about tides.')
    graph['nodes'][0]['config']['documents'] = [{'name': 'brief.md', 'path': doc}, {'name': 'lost.pdf', 'path': ''}]
    pkg = _files(graph, 'modular')
    assert 'class DocumentConverter:' in pkg['common.py']
    assert '_convert_doc_to_markdown' not in '\n'.join(pkg.values())
    assert '"path": "' + doc + '"' in pkg['workflow.py']
    _, log = _probe(['workflow', 'modular', _write(pkg)['root'], 'go'])
    start = ('## Attached Documents\n\n### brief.md\n\n# Brief\nWrite about tides.\n\n---\n\n'
             '### lost.pdf\n\n_(no path on attachment record)_\n\n---\n\ngo')
    assert '[node] [1] start -- ' + str(len(start.encode('utf-8'))) + ' chars' in log


def test_llm_factory_is_lang_graphs_own_function():
    for mode in ('single', 'modular', 'a2a'):
        allc = '\n'.join(_files(S.graphs()['dispatcher_demo'], mode).values())
        for n in ('def _claude(', 'def _deepseek(', 'def _kimi(', 'def _glm('):
            assert n in allc, f'{mode}: {n}'
        assert '            return _deepseek(model, temperature, max_tokens, thinking)' in allc, mode


def test_llm_factory_passes_the_same_provider_arguments():
    path = list(_write(_files(S.graphs()['linear'], 'single'))['paths'].values())[0]
    r, _ = _probe(['llm-args', path])
    assert r[0]['model_kwargs']['extra_body']['thinking'] == {'type': 'enabled'}
    assert 'temperature' not in r[0], 'deepseek v4 in thinking mode drops temperature'
    assert r[1]['model_kwargs']['extra_body']['thinking'] == {'type': 'disabled'}
    assert r[1]['temperature'] == 0.7
    assert r[2]['temperature'] == 0.6, 'kimi k2, thinking off -> 0.6 (provider constraint)'
    assert r[3] == {'model': 'claude-x', 'temperature': 0.5, 'max_tokens': 100}
