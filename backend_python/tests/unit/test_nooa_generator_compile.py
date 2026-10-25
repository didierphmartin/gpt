"""Port of backend/tests/Unit/NooaGeneratorCompileTest.php: the emitted NOOA program passes py_compile."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

import pytest

from app.agent_team.services.nooa_generator import NOOAGenerator
from tests.unit.test_nooa_generator_emit import diamond

pytestmark = pytest.mark.skipif(shutil.which('python3') is None, reason='python3 not on PATH')


def _py_compile(code: str, suffix: str = 'test') -> tuple:
    with tempfile.NamedTemporaryFile('w', prefix=f'nooa_{suffix}_', suffix='.py', delete=False, encoding='utf-8') as fh:
        fh.write(code)
        path = fh.name
    try:
        r = subprocess.run(['python3', '-m', 'py_compile', path], capture_output=True, text=True)
    finally:
        os.unlink(path)
    return r.returncode, r.stdout + r.stderr


def test_diamond_compiles():
    rc, out = _py_compile(NOOAGenerator.emitNooa(diamond()), 'diamond')
    assert rc == 0, f'Diamond NOOA failed py_compile:\n{out}'


def test_mcp_fixture_compiles():
    a = diamond()
    a['usedServers'] = {'https://mcp.example/mcp': {'name': 'Example Server'}}
    a['usedCatalog'] = {'web_search': {
        'server_url': 'https://mcp.example/mcp', 'tool_name': 'web_search',
        'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}, 'required': ['q']},
    }}
    a['agents']['2']['tools'] = ['web_search']
    rc, out = _py_compile(NOOAGenerator.emitNooa(a), 'mcp')
    assert rc == 0, f'MCP NOOA failed py_compile:\n{out}'


def test_skill_fixture_compiles():
    a = diamond()
    a['agents']['4']['skills'] = [{'dir': 'html'}]   # consolidator renders HTML
    rc, out = _py_compile(NOOAGenerator.emitNooa(a), 'skill')
    assert rc == 0, f'Skill NOOA failed py_compile:\n{out}'


def test_start_documents_fixture_compiles():
    a = diamond()
    a['startDocuments'] = [{'name': 'Spec', 'path': '/tmp/spec.docx'}]
    rc, out = _py_compile(NOOAGenerator.emitNooa(a), 'docs')
    assert rc == 0, f'Start-documents NOOA failed py_compile:\n{out}'
