"""Port of backend/tests/Unit/LangGraphGeneratorCodeNodeTest.php: code nodes (single file + modular),
refused by the A2A packaging."""
from __future__ import annotations

import copy
import os
import re
import subprocess
import tempfile

import pytest

from app.agent_team.services.start_option_graph import StartOptionGraph
from tests.unit import lg_support as S


def _db():
    return S.db(*S.MCP_DDL, S.LLM_DDL,
                "INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)",
                "INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)",
                "INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')",
                "INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')",
                "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
                "INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-v4-flash', 1)")


def _generate_with(graph: dict, options: dict, userId='3') -> dict:
    return S.generator(_db(), graph).generate(44, userId, options)


def _generate(graph: dict, userId='3') -> str:
    return _generate_with(graph, {}, userId)['code']


def _code_graph() -> dict:
    return {
        'nodes': [
            {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'poll'}},
            {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Poll ServiceNow',
                'code': "def run(input, call_tool):\n    r = call_tool('servicenow', 'poll_jobs', {})\n    if r.get('job') is None:\n        return {'route': 'no_job', 'output': None}\n    return {'route': 'job', 'output': r['job']}\n",
                'exits': ['job', 'no_job'], 'mcp_servers': ['ServiceNow'], 'timeout_s': 30}},
            {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
            {'id': '4', 'node_type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [
            {'from': '1', 'to': '2', 'from_port': 'output_1'},
            {'from': '2', 'to': '3', 'from_port': 'output_1'},
            {'from': '2', 'to': '4', 'from_port': 'output_2'},
        ],
    }


def test_single_file_bakes_the_code_node():
    code = _generate(_code_graph())
    assert 'CODE_NODES = {' in code
    assert '"exit_targets": {"job":["3"],"no_job":["4"]}' in code
    assert re.search(r'MCP_SLUGS = \{\s*"servicenow": "http://localhost/servicenow/\?profile=mock&toolset=jobs"\s*\}', code)
    assert 'class CodeNode(Node):' in code
    assert 'CODE_HARNESS = types.ModuleType("code_node_harness")' in code
    assert '"2": "code"' in code
    assert '{**AGENTS, **PLAYBOOKS, **CODE_NODES}' in code
    assert re.search(r'CODE_NODES = \{\n    # ---- node 2: Poll ServiceNow \(code\) -+\n    #   tools          : servicenow\.\*\n(    #[^\n]*\n)*    "2": \{', code)
    S.assert_compiles(code, 'single')


def test_workflows_without_code_nodes_are_unchanged():
    g = _code_graph()
    graph = {'nodes': [g['nodes'][0], g['nodes'][2]], 'edges': [{'from': '1', 'to': '3', 'from_port': 'output_1'}]}
    code = _generate(graph)
    assert 'CODE_HARNESS' not in code
    assert 'class CodeNode' not in code


def test_unsupported_packagings_refuse():
    with pytest.raises(RuntimeError) as e:
        _generate_with(_code_graph(), {'a2a': True})
    assert 'Code nodes are not supported by the A2A' in str(e.value)


def test_modular_bakes_a_code_module():
    byPath = S.files_of(_generate_with(_code_graph(), {'modular': True}))
    module = byPath.get('agents/poll_servicenow.py', '')
    assert '"kind": "code"' in module
    assert 'run_node = make_node(NODE).run' in module
    assert 'class CodeNode(Node):' in byPath['common.py']
    assert 'MCP_SLUGS = ' in byPath['common.py']
    assert '"exit_targets": {"job":["3"],"no_job":["4"]}' in byPath['workflow.py']


def test_a_dispatchers_code_child_is_on_its_menu():
    g = _code_graph()
    g['nodes'].append({'id': '9', 'node_type': '', 'config': {'type': 'agent-template', 'agent_name': 'Front desk',
        'agent_type': 'dispatcher', 'instructions': 'Route.', 'agent_provider': 'claude', 'model': 'claude-sonnet-4-6',
        'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096}}})
    g['edges'] = [{'from': '1', 'to': '9', 'from_port': 'output_1'}, {'from': '9', 'to': '2', 'from_port': 'output_1'},
                  {'from': '2', 'to': '3', 'from_port': 'output_1'}, {'from': '2', 'to': '4', 'from_port': 'output_2'}]
    code = _generate(g)
    assert '"dispatch": [{"id": "2", "name": "Poll ServiceNow", "description": ""}]' in code
    byPath = S.files_of(_generate_with(g, {'modular': True}))
    assert '"dispatch": [{"id":"2","name":"Poll ServiceNow"}]' in byPath['workflow.py']


def test_arguments_are_compiled_in():
    g = _code_graph()
    g['nodes'][1]['config']['args'] = {'folder': 'Didier'}
    assert '"args": {"folder":"Didier"}' in _generate(g)
    raw = {'nodes': [
        {'id': '17', 'node_type': 'start', 'config': {'type': 'start', 'start_option': 5,
                                                        'start_args': {'folder': 'To SharePoint', 'done_folder': 'Filed'}}},
        {'id': '18', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from_node_id': '17', 'to_node_id': '18', 'from_port': 'output_1'}]}
    opt = StartOptionGraph.expand(raw, lambda i: {'name': 'Outlook: get dropped email',
        'code': "def run(input, call_tool):\n    return {'route': 'mail', 'output': ARGS}\n",
        'exits': ['mail', 'no_mail'], 'mcp_servers': ['ServiceNow'], 'timeout_s': 30,
        'start_trigger': {'label': 'Outlook: get dropped email', 'work_exit': 'mail'}})
    assert '"args": {"folder":"To SharePoint","done_folder":"Filed"}' in _generate(opt)


def test_node_literal_has_arg_decls_and_execute_passes_meta():
    """The argument declarations are compiled in as Python (a "required": true declaration imports: no NameError
    on true), in both packagings, and the node's run fills ARGS from its parents' meta and the declared default."""
    g = _code_graph()
    g['nodes'][1]['config']['arg_decls'] = [{'name': 'folder', 'required': True}, {'name': 'note', 'default': None}]
    g['nodes'][1]['config']['args'] = {'flag': False}
    code = _generate(g)
    assert '"arg_decls": [{"name":"folder","required":True},{"name":"note","default":None}]' in code
    assert '"args": {"flag":False}' in code
    assert 'meta=CODE_HARNESS.received_meta(' in code
    assert '"arg_decls": []' in _generate(_code_graph())
    files = {'single/wf.py': code}
    files.update({'modular/' + p: c for p, c in S.files_of(_generate_with(g, {'modular': True})).items() if p.endswith('.py')})
    for p, c in files.items():
        compile(c, p, 'exec')   # a SyntaxError fails the test
    # the NODE literal evaluates: the declarations come back as Python values
    m = re.search(r'"arg_decls": (\[.*\]),   #', code)
    assert eval(m.group(1)) == [{'name': 'folder', 'required': True}, {'name': 'note', 'default': None}]


def test_the_compiled_run_applies_a_declared_default():
    """A compiled node whose argument is required and declared with a default runs with that default in ARGS."""
    S.venv()
    g = _code_graph()
    g['nodes'][1]['config'] = {'type': 'code', 'name': 'Echo args', 'exits': ['next'], 'mcp_servers': [],
                               'timeout_s': 30, 'args': {},
                               'arg_decls': [{'name': 'folder', 'default': 'Inbox', 'required': True}],
                               'code': "def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n"}
    g['edges'] = [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]
    g['nodes'].pop()
    rc, out = _run_once(_generate(g))
    assert rc == 0, out
    assert 'folder=Inbox' in out


def _run_once(code: str) -> tuple:
    venv = S.venv()
    d = tempfile.mkdtemp(prefix='lgout')
    with open(f'{d}/wf.py', 'w', encoding='utf-8') as f:
        f.write(code)
    r = subprocess.run([venv, 'wf.py', '--once', 'go'], cwd=d, capture_output=True, text=True,
                       env={**os.environ, 'RUNS_DIR': f'{d}/runs'})
    return r.returncode, r.stdout + r.stderr


def test_the_compiled_code_reads_its_arguments():
    S.venv()
    g = _code_graph()
    g['nodes'][1]['config'] = {'type': 'code', 'name': 'Echo args', 'exits': ['next'], 'mcp_servers': [],
                               'timeout_s': 30, 'args': {'folder': 'Didier'},
                               'code': "def run(input, call_tool):\n    return 'folder=' + str(ARGS.get('folder'))\n"}
    g['edges'] = [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]
    g['nodes'].pop()
    rc, out = _run_once(_generate(g))
    assert rc == 0, out
    assert 'folder=Didier' in out


def _code(route: str, text: str, exits=('done', 'error')) -> dict:
    return {'type': 'code', 'exits': list(exits), 'mcp_servers': [], 'timeout_s': 30,
            'code': f"def run(input, call_tool):\n    return {{'route': '{route}', 'output': '{text}'}}\n"}


def test_the_output_takes_a_node_once_and_only_through_the_exit_it_took():
    S.venv()
    g = {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
        {'id': '2', 'node_type': 'code', 'config': {'name': 'Convert', **_code('done', 'PACKAGE')}},
        {'id': '5', 'node_type': 'code', 'config': {'name': 'Store', **_code('done', 'STORED')}},
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [
        {'from': '1', 'to': '2', 'from_port': 'output_1'},
        {'from': '2', 'to': '5', 'from_port': 'output_1'},
        {'from': '2', 'to': '3', 'from_port': 'output_2'},
        {'from': '5', 'to': '3', 'from_port': 'output_1'},
        {'from': '5', 'to': '3', 'from_port': 'output_2'},
    ]}
    rc, text = _run_once(_generate(g))
    assert rc == 0, text
    assert re.search(r'FINAL OUTPUT\n=+\nSTORED\n', text)
    assert 'PACKAGE' not in text[text.index('FINAL OUTPUT'):]


def test_a_branch_not_taken_is_not_a_parent_of_the_output():
    S.venv()
    g = {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
        {'id': '2', 'node_type': 'code', 'config': {'name': 'Check', **_code('no_mail', 'NO MAIL', ('new_mail', 'no_mail'))}},
        {'id': '5', 'node_type': 'code', 'config': {'name': 'File', **_code('next', 'FILED', ('next',))}},
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [
        {'from': '1', 'to': '2', 'from_port': 'output_1'},
        {'from': '2', 'to': '5', 'from_port': 'output_1'},
        {'from': '2', 'to': '3', 'from_port': 'output_2'},
        {'from': '5', 'to': '3', 'from_port': 'output_1'},
    ]}
    rc, text = _run_once(_generate(g))
    assert rc == 0, text
    assert re.search(r'FINAL OUTPUT\n=+\nNO MAIL\n', text)
