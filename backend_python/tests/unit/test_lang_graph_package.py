"""Port of backend/tests/Unit/LangGraphPackageTest.php (spec 2026-10-15 langgraph standalone §5: the modular
package carries everything it runs on)."""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

import pytest

from app.agent_team.models.workflow import Workflow
from app.agent_team.services.lang_graph_package import LangGraphPackage
from app.agent_team.services.lang_graph_runtime import CODE_HARNESS_PATH, LangGraphRuntime
from app.agent_team.services.start_document_store import StartDocumentStore
from app.agent_team.services.start_option_graph import StartOptionGraph
from tests.unit import lg_support as S

VENV = S.VENV
POLL = ("def run(input, call_tool):\n    r = call_tool('outlook', 'poll_new_mail', {})\n"
        "    if r.get('mail') is None:\n        return {'route': 'no_mail', 'output': None}\n    return {'route': 'new_mail', 'output': r['mail']}\n")
PNG = b'\x89PNG\r\n\x1a\n\x00\xff'
HEADER_SECRET = 'hdr-secret-5521'


def _temp_dir(prefix: str) -> str:
    return tempfile.mkdtemp(prefix=prefix)


def _skills_root() -> str:
    """A skills root holding pdf-report (SKILL.md with a dependency, a script, a binary logo)."""
    root = _temp_dir('lgpkg_skills_')
    os.makedirs(f'{root}/pdf-report/__pycache__')
    Path(f'{root}/pdf-report/SKILL.md').write_text('---\nname: pdf-report\ndependencies: [pypdf]\n---\nRender a PDF.\n')
    Path(f'{root}/pdf-report/run.py').write_text("print('pdf')\n")
    Path(f'{root}/pdf-report/logo.png').write_bytes(PNG)
    Path(f'{root}/pdf-report/__pycache__/run.cpython-312.pyc').write_bytes(b'\x00junk')
    Path(f'{root}/pdf-report/.DS_Store').write_bytes(b'\x00junk')
    Path(f'{root}/pdf-report/.env').write_text('OPENAI_API_KEY=sk-skill-secret\n')
    Path(f'{root}/pdf-report/.env.local').write_text('OPENAI_API_KEY=sk-skill-secret\n')
    return root


def _db():
    return S.db('CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
                'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
                S.LLM_DDL,
                'CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY, workflow_id INTEGER, repeat_type TEXT, cron TEXT, status TEXT, event_trigger TEXT)',
                "INSERT INTO mcp_servers VALUES (7, '3', 'Outlook', 'http://127.0.0.1:8770/mcp', 1, '{\"Authorization\": \"Bearer " + HEADER_SECRET + "\"}')",
                "INSERT INTO mcp_server_tools VALUES (1, 7, 'poll_new_mail', 'Poll', '{}')",
                "INSERT INTO mcp_server_tools VALUES (2, 7, 'wait_for_new', 'Wait', '{}')",
                "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-5', 1)")


def _generator(graph: dict, skillsRoot: str, storage: bool = False, docs=None, outputFolder: str | None = None):
    wf = Workflow({'id': 44, 'name': 'Email prototype', 'user_id': '3',
                   'output_storage_enabled': storage or outputFolder is not None, 'output_folder': outputFolder})
    return S.generator(_db(), graph, wf, skillsRoot=skillsRoot, startDocuments=docs)


def _graph(skillDir: str = 'pdf-report', documents: list | None = None) -> dict:
    raw = {'nodes': [
        {'id': '17', 'node_type': 'start', 'config': {'type': 'start', 'start_option': 5, 'documents': documents or []}},
        {'id': '19', 'node_type': '', 'config': {'type': 'agent-template', 'agent_name': 'Reporter',
                                                  'agent_type': 'standard', 'instructions': 'Summarize the mail.', 'agent_provider': 'claude',
                                                  'model': 'claude-sonnet-4-5', 'tools': [], 'settings': {'temperature': 0.7, 'max_tokens': 4096},
                                                  'bound_skill': {'dir_name': skillDir}}},
        {'id': '18', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [
        {'from_node_id': '17', 'to_node_id': '19', 'from_port': 'output_1'},
        {'from_node_id': '19', 'to_node_id': '18', 'from_port': 'output_1'},
    ]}
    return StartOptionGraph.expand(raw, lambda i: {'name': 'Outlook: get new email', 'code': POLL,
        'exits': ['new_mail', 'no_mail'], 'mcp_servers': ['Outlook'], 'timeout_s': 30,
        'start_trigger': {'label': 'Outlook: get new email', 'work_exit': 'new_mail',
                          'watch': {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'folder': 'Inbox'}}}})


def _files(skillDir: str = 'pdf-report', documents: list | None = None, docs=None) -> dict:
    result = _generator(_graph(skillDir, documents), _skills_root(), False, docs).generate(44, '3', {'modular': True})
    return {f['path']: f for f in result['files']}


def _bytes(f: dict) -> bytes:
    return base64.b64decode(f['code']) if f.get('encoding') == 'base64' else f['code'].encode('utf-8')


def test_package_files():
    files = _files()
    assert files['code/start_outlook_get_new_email.py']['code'] == POLL
    assert 'code_harness.py' in files
    assert files['code_harness.py']['code'] == Path(CODE_HARNESS_PATH).read_text(encoding='utf-8')
    assert 'pypdf\n' in files['requirements.txt']['code']
    assert 'fastapi\n' in files['requirements.txt']['code']
    assert 'MCP_URL_OUTLOOK=http://127.0.0.1:8770/mcp' in files['.env.example']['code']
    assert 'MCP_HEADERS_OUTLOOK=' in files['.env.example']['code']
    assert 'ANTHROPIC_API_KEY' in files['.env.example']['code']
    assert 'launchd' in files['README.md']['code']
    assert files['skills/pdf-report/logo.png']['encoding'] == 'base64'
    assert base64.b64decode(files['skills/pdf-report/logo.png']['code']) == PNG
    assert 'encoding' not in files['skills/pdf-report/run.py']
    assert files['skills/pdf-report/run.py']['code'] == "print('pdf')\n"
    assert 'skills/pdf-report/SKILL.md' in files
    for p in files:
        assert '__pycache__' not in p
        assert '.DS_Store' not in p


def test_requirements_are_sorted_and_unique():
    lines = _files()['requirements.txt']['code'].rstrip('\n').split('\n')
    assert sorted(lines, key=lambda s: s.encode()) == lines
    assert list(dict.fromkeys(lines)) == lines
    for pkg in ('langchain', 'langchain-anthropic', 'langchain-openai', 'langgraph', 'httpx', 'pydantic', 'python-dotenv',
                'fastapi', 'uvicorn', 'pypdf'):
        assert pkg in lines


def test_env_example_and_readme():
    files = _files()
    env = files['.env.example']['code']
    assert '# JSON object of HTTP headers, e.g. {"Authorization": "Bearer …"}' in env
    for needle in ('# MODEL_NAME=', '# SYNERGYAI_OUTPUT_ROOT=./outputs', '# RUNS_DIR=./runs'):
        assert needle in env
    readme = files['README.md']['code']
    for needle in ('python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt', 'cp .env.example .env',
                   '<string>ai.synergy.email-prototype</string>', 'Restart=always', 'python api.py', 'outputs/', 'runs/', 'code/'):
        assert needle in readme
    assert re.search(r'\| `python workflow\.py --watch[^\n]*\(default\)', readme), "this workflow's START_MODE is marked default"
    assert readme.count('(default)') == 1


def test_env_example_sets_nothing_empty():
    env = _files()['.env.example']['code']
    for line in env.split('\n'):
        if line.strip() == '' or line.lstrip().startswith('#'):
            continue
        assert re.match(r'^[A-Z0-9_]+=\S', line), f'.env.example sets an empty value: {line}'
    assert '# MCP_HEADERS_OUTLOOK=' in env
    assert '# ANTHROPIC_API_KEY=' in env


def test_the_launchd_log_is_in_the_package_folder():
    readme = _files()['README.md']['code']
    assert readme.count('<string>/path/to/email_prototype_modular/service.log</string>') == 2, readme
    assert 'runs/service.log' not in readme


def test_code_module_reads_its_file():
    files = _files()
    mod = files.get('agents/outlook_get_new_email.py', {}).get('code')
    assert mod is not None
    assert '"source_file": "code/start_outlook_get_new_email.py"' in mod
    assert 'poll_new_mail' not in mod
    assert 'import code_harness as CODE_HARNESS' in files['common.py']['code']
    assert 'CODE_HARNESS_SOURCE' not in files['common.py']['code']
    assert 'PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))' in files['common.py']['code']


def test_code_file_names():
    assert LangGraphPackage.codeFile('1000000017', {'display': 'Outlook: get new email', 'source': 'x'}, True) == \
        {'path': 'code/start_outlook_get_new_email.py', 'code': 'x'}
    assert LangGraphPackage.codeFile('4', {'display': 'Check mail', 'source': 'y'}, False) == {'path': 'code/4_check_mail.py', 'code': 'y'}


def test_single_file_keeps_embedding_and_says_where_skills_come_from():
    code = _generator(_graph(), _skills_root()).generate(44, '3')['code']
    assert 'poll_new_mail' in code
    assert 'CODE_HARNESS_SOURCE = ' in code
    assert ('Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills); '
            'use the modular package for a self-contained copy.') in code


def test_package_defaults_point_inside_the_package():
    common = _files()['common.py']['code']
    assert 'SKILLS_DIR = os.environ.get("SYNERGYAI_SKILLS_DIR") or os.path.join(PACKAGE_DIR, "skills")' in common
    assert 'os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")' in common
    assert 'os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(PACKAGE_DIR, "scratch")' in common


def test_start_documents_are_copied_only_from_the_users_storage():
    root = _temp_dir('lgpkg_storage_')
    mine = f'{root}/synergyaichatroot/user_3/workflow_docs/44'
    os.makedirs(mine)
    os.makedirs(f'{root}/synergyaichatroot/user_4')
    Path(f'{mine}/doc_1_brief.txt').write_text('the brief\n')
    Path(f'{mine}/doc_2_scan.pdf').write_bytes(b'%PDF-1.4\n\x00\xff\xfe')
    Path(f'{root}/synergyaichatroot/user_4/secret.txt').write_text("user 4's file\n")
    outside = _temp_dir('lgpkg_outside_') + '/server.env'
    Path(outside).write_text('DB_PASS=hunter2\n')
    os.symlink(outside, f'{mine}/doc_3_link.txt')
    store = StartDocumentStore('user_3', None, root)
    files = _files('pdf-report', [
        {'name': 'brief.txt', 'path': 'workflow_docs/44/doc_1_brief.txt', 'fullPath': 'synergyaichatroot/user_3/workflow_docs/44/doc_1_brief.txt'},
        {'name': 'scan.pdf', 'path': 'workflow_docs/44/doc_2_scan.pdf'},
        {'name': 'server.env', 'path': outside},
        {'name': 'escape.txt', 'path': 'workflow_docs/../../user_4/secret.txt'},
        {'name': 'link.txt', 'path': 'workflow_docs/44/doc_3_link.txt'},
        {'name': 'mine.txt', 'path': 'workflow_docs/44/doc_1_brief.txt', 'storage': 'local'},
        {'name': 'gone.txt', 'path': 'workflow_docs/44/gone.txt'},
    ], store)
    assert files['start_documents/doc_1_brief.txt']['code'] == 'the brief\n'
    assert files['start_documents/doc_2_scan.pdf']['encoding'] == 'base64'
    assert [p for p in files if p.startswith('start_documents/')] == ['start_documents/doc_1_brief.txt', 'start_documents/doc_2_scan.pdf']
    for path, f in files.items():
        assert b'hunter2' not in _bytes(f), path
        assert b"user 4's file" not in _bytes(f), path
    wf = files['workflow.py']['code']
    assert '"path": "start_documents/doc_1_brief.txt"' in wf
    assert 'synergyaichatroot/user_3' not in wf, 'the copy drops fullPath'
    assert '"path": "' + outside + '"' in wf, 'a path outside storage is left as is'
    assert '"path": "workflow_docs/../../user_4/secret.txt"' in wf
    assert 'pypdf\n' in files['requirements.txt']['code']


def test_without_a_store_no_document_is_copied():
    outside = _temp_dir('lgpkg_outside_') + '/brief.txt'
    Path(outside).write_text('x\n')
    files = _files('pdf-report', [{'name': 'brief.txt', 'path': outside}])
    assert [p for p in files if p.startswith('start_documents/')] == []


def test_store_refuses_unsafe_paths():
    for bad in ('', '/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a//b', 'a\\b', 'a\0b'):
        assert StartDocumentStore.safeSegments(bad) is None, json.dumps(bad)
    assert StartDocumentStore.safeSegments('workflow_docs/44/doc_1_a.txt') == ['workflow_docs', '44', 'doc_1_a.txt']
    assert StartDocumentStore('../user_4', None, tempfile.gettempdir()).read({'path': 'secret.txt'}) is None


def test_nothing_points_back_at_synergy_ai():
    for path, f in _files().items():
        if path in ('.env.example', 'README.md') or f.get('encoding') == 'base64':
            continue
        for needle in ('synergyAI/', '/api/v1/', 'netfo587', 'localhost/gpt'):
            assert needle not in f['code'], path


def _assert_self_contained(files: dict, label: str) -> None:
    for path, f in files.items():
        code = f['code'] if isinstance(f, dict) else f
        if isinstance(f, dict) and f.get('encoding') == 'base64':
            continue
        assert HEADER_SECRET not in code, f'{label} {path}: header value'
        assert 'sekret-conn-key' not in code, f'{label} {path}: header value'
        assert '/api/v1/' not in code, f'{label} {path}'
        assert 'netfo587' not in code, f'{label} {path}'
        assert 'localhost/gpt' not in code, f'{label} {path}'
        if path in ('.env.example', 'README.md'):
            for line in code.split('\n'):
                if not line.lstrip().startswith('#') or path == 'README.md':
                    assert 'synergyAI/' not in line, f'{label} {path}: {line}'
        elif label.endswith('single'):
            for line in code.split('\n'):
                if '# Single file: skills are read from SYNERGYAI_SKILLS_DIR (default ~/Documents/synergyAI/skills)' not in line:
                    assert 'synergyAI/' not in line, f'{label} {path}: {line}'
        elif path != 'ARCHITECTURE.md' and not label.endswith('a2a'):
            assert 'synergyAI/' not in code, f'{label} {path}'


def _by_path(result: dict) -> dict:
    if 'files' not in result:
        return {result['filename']: result['code']}
    return {f['path']: f for f in result['files']}


def test_nothing_points_back_at_synergy_ai_across_fixtures():
    for mode, opts in (('single', {}), ('modular', {'modular': True}), ('a2a', {'a2a': True})):
        _assert_self_contained(_by_path(S.demo_generator().generate(44, '3', opts)), f'dispatcher_demo {mode}')
    files = _by_path(_generator(_graph(), _skills_root(), False, None, 'reports/weekly').generate(44, '3', {'modular': True}))
    _assert_self_contained(files, 'custom folder modular')
    assert 'OUTPUT_FOLDER = "reports/weekly"' in files['workflow.py']['code']
    for mode, opts in (('single', {}), ('modular', {'modular': True})):
        _assert_self_contained(_by_path(_generator(_graph(), _skills_root()).generate(44, '3', opts)), f'header {mode}')


def test_output_storage_on_stays_self_contained():
    for mode, opts in (('single', {}), ('modular', {'modular': True})):
        files = _by_path(_generator(_graph(), _skills_root(), True).generate(44, '3', opts))
        _assert_self_contained(files, f'storage on {mode}')
        entry = list(files.values())[0] if mode == 'single' else files['workflow.py']['code']
        assert 'OUTPUT_STORAGE_ENABLED = True' in entry, mode
        assert ('# Output storage (Output node setting): ON -> outputs/workflow/ '
                + ('next to this script' if mode == 'single' else 'in this folder') + ' (SYNERGYAI_OUTPUT_ROOT overrides)') in entry, mode
    single = _generator(_graph(), _skills_root(), True).generate(44, '3')['code']
    assert 'root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")' in single
    assert 'SKILLS_DIR = os.environ.get(\n    "SYNERGYAI_SKILLS_DIR",' in single, 'the single file keeps the skills default (spec §5)'
    custom = _by_path(_generator(_graph(), _skills_root(), True, None, 'reports/weekly').generate(44, '3', {'modular': True}))
    assert '# Output storage (Output node setting): ON -> reports/weekly' in custom['workflow.py']['code']


def test_missing_skill_folder_is_an_error():
    with pytest.raises(RuntimeError) as e:
        _files('nope')
    assert str(e.value) == 'Skill folder "nope" is not available on this server, so it can\'t be packaged.'


def test_unsafe_skill_dir_names_are_refused():
    for bad in ('.', '..', '../pdf-report', 'pdf-report/..', 'GEO/../x', './x', 'GEO//x', 'a\\b', '/tmp'):
        with pytest.raises(RuntimeError) as e:
            _files(bad)
        assert str(e.value) == 'Skill folder "' + bad + '" is not available on this server, so it can\'t be packaged.'
        assert tempfile.gettempdir() not in str(e.value)


def test_dot_directories_are_neither_named_nor_copied():
    root = _skills_root()
    for bad in ('.git', '.superpowers', 'GEO/.hidden', '.x/pdf-report'):
        os.makedirs(f'{root}/{bad}', exist_ok=True)
        Path(f'{root}/{bad}/SKILL.md').write_text('---\nname: x\n---\n')
        with pytest.raises(RuntimeError) as e:
            _generator(_graph(bad), root).generate(44, '3', {'modular': True})
        assert str(e.value) == 'Skill folder "' + bad + '" is not available on this server, so it can\'t be packaged.'
    os.makedirs(f'{root}/pdf-report/.git')
    os.makedirs(f'{root}/pdf-report/.pytest_cache/v')
    os.makedirs(f'{root}/pdf-report/assets/.cache')
    Path(f'{root}/pdf-report/.git/config').write_text('[remote]\n')
    Path(f'{root}/pdf-report/.pytest_cache/v/x').write_text('1')
    Path(f'{root}/pdf-report/assets/.cache/y').write_text('2')
    Path(f'{root}/pdf-report/assets/style.css').write_text('p{}')
    Path(f'{root}/pdf-report/.gitignore').write_text('*.pyc\n')
    paths = [f['path'] for f in _generator(_graph(), root).generate(44, '3', {'modular': True})['files']]
    assert sorted(p for p in paths if p.startswith('skills/')) == [
        'skills/pdf-report/.gitignore', 'skills/pdf-report/SKILL.md', 'skills/pdf-report/assets/style.css',
        'skills/pdf-report/logo.png', 'skills/pdf-report/run.py']


def test_a_grouped_skill_is_packaged_under_its_group():
    root = _skills_root()
    os.makedirs(f'{root}/GEO/geo-report/scripts')
    Path(f'{root}/GEO/geo-report/SKILL.md').write_text('---\nname: geo-report\ndependencies: [beautifulsoup4]\n---\nReport.\n')
    Path(f'{root}/GEO/geo-report/scripts/make.py').write_text("print('geo')\n")
    result = _generator(_graph('GEO/geo-report'), root).generate(44, '3', {'modular': True})
    files = {f['path']: f for f in result['files']}
    assert files['skills/GEO/geo-report/scripts/make.py']['code'] == "print('geo')\n"
    assert 'skills/GEO/geo-report/SKILL.md' in files
    assert 'beautifulsoup4\n' in files['requirements.txt']['code']
    assert '| `skills/GEO/geo-report/` |' in result['architecture']


def test_store_reads_through_the_users_adapter():
    class Adapter:
        def __init__(self):
            self.reads = []

        def read(self, path):   # the Python adapter returns the bytes (PHP: readStream)
            self.reads.append(path)
            if path != '/synergyaichatroot/user_3/workflow_docs/44/doc_1_a.txt':
                raise RuntimeError('not found')
            return b'from the adapter\n'
    adapter = Adapter()
    connects = []
    store = StartDocumentStore('user_3', lambda: connects.append(1) or adapter, None)
    assert store.read({'path': 'workflow_docs/44/doc_1_a.txt', 'fullPath': 'synergyaichatroot/user_4/secret.txt'}) == b'from the adapter\n'
    assert store.read({'path': 'workflow_docs/44/gone.txt'}) is None
    assert store.read({'path': '../user_4/secret.txt'}) is None
    assert store.read({'path': 'workflow_docs/44/doc_1_a.txt', 'storage': 'local'}) is None
    assert adapter.reads == ['/synergyaichatroot/user_3/workflow_docs/44/doc_1_a.txt', '/synergyaichatroot/user_3/workflow_docs/44/gone.txt'], \
        'unsafe and local documents never reach the adapter; fullPath is ignored'
    assert len(connects) == 1, 'the adapter is connected once'


def test_env_files_of_a_skill_are_not_copied():
    files = _files()
    assert 'skills/pdf-report/.env' not in files
    assert 'skills/pdf-report/.env.local' not in files
    for path, f in files.items():
        assert 'sk-skill-secret' not in f['code'], path


def test_ensure_deps_installs_only_what_is_missing_and_warns():
    d = _temp_dir('lgpkg_deps_')
    os.makedirs(f'{d}/skills/s')
    Path(f'{d}/skills/s/SKILL.md').write_text('---\nname: s\ndependencies: [json, zz-not-installed-pkg>=1.0]\n---\n')
    py = ('from __future__ import annotations\nimport os, sys, subprocess, threading, json, re, time, asyncio, shutil\nfrom functools import cached_property\n'
          'def node_print(line):\n    print(line, flush=True)\n'
          f'PACKAGE_DIR = {d!r}\n'
          + LangGraphRuntime.skillRuntimeBlock(True) + '\n'
          + '''calls = []
class R:
    returncode, stderr = 0, ""
subprocess.run = lambda argv, **kw: calls.append(argv[-1]) or R()
SKILLS.ensure_deps(os.path.join(SKILLS_DIR, "s"))
SKILLS.ensure_deps(os.path.join(SKILLS_DIR, "s"))   # once per process
print("pip", calls)''')
    Path(f'{d}/probe.py').write_text(py)
    r = subprocess.run(['python3', f'{d}/probe.py'], capture_output=True, text=True)
    out = [line for line in (r.stdout + r.stderr).split('\n') if line != '']
    assert r.returncode == 0, '\n'.join(out)
    assert out == ['[warn] installing zz-not-installed-pkg>=1.0 (not in requirements.txt)', "pip ['zz-not-installed-pkg>=1.0']"]


def test_every_python_file_of_the_package_compiles():
    d = _temp_dir('lgpkg_compile_')
    for path, f in _files().items():
        os.makedirs(os.path.dirname(f'{d}/{path}'), exist_ok=True)
        Path(f'{d}/{path}').write_bytes(_bytes(f))
        if path.endswith('.py'):
            r = subprocess.run(['python3', '-m', 'py_compile', f'{d}/{path}'], capture_output=True, text=True)
            assert r.returncode == 0, f'{path}: {r.stdout}{r.stderr}'


def test_editing_a_code_file_takes_effect_on_the_next_run():
    if not os.path.isfile(VENV):
        pytest.skip('venv python missing')
    graph = {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'go'}},
        {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Check',
                                                      'code': "def run(input, call_tool):\n    return {'route': 'work', 'output': 'first'}\n",
                                                      'exits': ['work'], 'mcp_servers': [], 'timeout_s': 30}},
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [{'from': '1', 'to': '2', 'from_port': 'output_1'}, {'from': '2', 'to': '3', 'from_port': 'output_1'}]}
    files = _generator(graph, _skills_root(), True).generate(44, '3', {'modular': True})['files']
    d = _temp_dir('lgpkg_run_')
    for f in files:
        os.makedirs(os.path.dirname(f"{d}/{f['path']}"), exist_ok=True)
        Path(f"{d}/{f['path']}").write_bytes(_bytes(f))
    assert os.path.isfile(f'{d}/code/2_check.py')
    driver = ("import importlib.util, sys\nspec = importlib.util.spec_from_file_location('prog', 'workflow.py')\n"
              "m = importlib.util.module_from_spec(spec)\nsys.modules['prog'] = m\nspec.loader.exec_module(m)\n"
              "view = m.ConsoleView('quiet')\nrec = m.RunRecorder(m.RUNS_DIR, m.WORKFLOW_ID, m.WORKFLOW_NAME, listeners=[view])\n"
              "run = m.make_run_once('go', m.RunLoop(), view, rec, loop_mode=True)\n"
              "print('RESULT', run())\n"
              "open('code/2_check.py', 'w').write(\"def run(input, call_tool):\\n    return {'route': 'work', 'output': 'second'}\\n\")\n"
              "print('RESULT', run())\n")
    Path(f'{d}/drive.py').write_text(driver)
    r = subprocess.run([VENV, 'drive.py'], cwd=d, capture_output=True, text=True,
                       env={'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', '')})
    text = r.stdout + r.stderr
    assert r.returncode == 0, text
    assert 'RESULT first\n' in text
    assert 'RESULT second\n' in text
    assert os.path.isdir(f'{d}/outputs'), 'save_output writes inside the package by default'
