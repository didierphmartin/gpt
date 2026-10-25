"""Port of backend/tests/Unit/ADKPackageTest.php: the ADK package (generatePackage) of the Dispatcher demo,
built in an in-memory SQLite database (compiled_target_support), and the code-node package's own files."""
from __future__ import annotations

import os
import re
import secrets
import subprocess
import tempfile

from app.agent_team.services.adk_generator import ADKGenerator, ADKPackage
from tests.unit import compiled_target_support as demo
from tests.unit.lg_support import REPO, python3
from tests.unit.test_adk_code_node import code_analyzed


def _pkg() -> dict:
    return demo.generator(ADKGenerator, demo.pdo()).generatePackage(demo.WORKFLOW_ID)


def _files() -> dict:
    return {f['path']: f['code'] for f in _pkg()['files']}


def test_emits_the_package_files():
    assert sorted(f['path'] for f in _pkg()['files']) == [
        '.env.example', 'ARCHITECTURE.md', 'README.md', '__init__.py', 'agents/__init__.py', 'agents/human_resources.py',
        'agents/it_claims.py', 'agents/techbuddy.py', 'api.py', 'common.py', 'requirements.txt', 'workflow.py']


def test_workflow_exposes_the_contract():
    assert 'async def run_workflow(prompt: str, session: str | None = None) -> str:' in _files()['workflow.py']


def test_the_cli_entry_still_exists():
    assert 'if __name__ == "__main__":' in _files()['workflow.py']


def test_api_py_imports_the_contract():
    assert 'from workflow import run_workflow' in _files()['api.py']


def _run_workflow_body(wf: str) -> str:
    """run_workflow()'s own body: from its def to the next top-level statement."""
    at = wf.index('async def run_workflow(')
    m = re.compile(r'\n(?=\S)').search(wf, at + 1)
    return wf[at:m.start()]


def test_saving_stays_out_of_run_workflow():
    wf = _files()['workflow.py']
    assert 'OUTPUT_STORAGE_ENABLED' not in _run_workflow_body(wf), 'saving leaked into run_workflow'
    assert 'saved = _save_output(output)' in wf


def test_run_workflow_does_not_pre_strip_the_document():
    wf = _files()['workflow.py']
    assert wf.count('<!doctype html') == 1
    assert '<!doctype html' not in _run_workflow_body(wf), 'document extraction leaked into run_workflow'


def _code_package() -> dict:
    """A workflow with a code node on an MCP server, as the package emits it."""
    a = code_analyzed()
    a['package'] = True
    files = {f['path']: f['code'] for f in ADKPackage.files(a, tempfile.gettempdir())}
    files['workflow.py'] = ADKGenerator.emitAdk(a)
    return files


def test_code_node_package_carries_its_own_files():
    f = _code_package()
    assert f['code/2_c.py'] == "def run(input, call_tool):\n    return {'output': {'got': input}}\n"
    assert f['code_harness.py'] == (REPO / 'frontend/assets/py/code_node_harness.py').read_text(encoding='utf-8')
    assert 'fastapi\ngoogle-adk\nhttpx\nlitellm\npython-dotenv\nuvicorn\n' in f['requirements.txt']
    assert 'MCP_URL_OUTLOOK=http://localhost:8770' in f['.env.example']
    assert '# MCP_HEADERS_OUTLOOK=' in f['.env.example']
    assert 'reads .env from its own folder first, then from the folder two levels up' in f['.env.example']


def test_package_workflow_reads_its_code_from_the_folder():
    wf = _code_package()['workflow.py']
    assert 'source_file="code/2_c.py"' in wf
    assert 'import code_harness as CODE_HARNESS' in wf
    assert 'CODE_HARNESS_SOURCE' not in wf
    assert 'os.path.join(PACKAGE_DIR, "outputs")' in wf
    assert 'source_file="' not in ADKGenerator.emitAdk(code_analyzed())


def test_package_runs_from_its_own_folder():
    d = os.path.join(tempfile.gettempdir(), 'adkpkg_' + secrets.token_hex(4))
    for path, code in _code_package().items():
        os.makedirs(os.path.dirname(os.path.join(d, path)), exist_ok=True)
        with open(os.path.join(d, path), 'w', encoding='utf-8') as fh:
            fh.write(code)
    # the folder's own modules import, and its code file is the one read (no ADK needed for this check)
    r = subprocess.run([python3(), '-c', "import code_harness, ast; ast.parse(open('workflow.py').read()); "
                        "print(code_harness.check_code(open('code/2_c.py').read()))"], cwd=d, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_playbook_package_requires_the_interpreter():
    """Review I4: a playbook node runs the shared interpreter (langchain + langgraph): the package installs it."""
    a = code_analyzed()
    a['playbooks'] = {'7': {'provider': 'claude', 'display': 'P', 'actions': []}}
    req = {f['path']: f['code'] for f in ADKPackage.files(a, tempfile.gettempdir())}['requirements.txt']
    for pkg in ('langchain-core', 'langgraph', 'langchain-anthropic'):
        assert pkg in req.strip().split('\n')
