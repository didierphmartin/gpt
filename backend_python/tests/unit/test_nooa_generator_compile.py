"""Port of backend/tests/Unit/NooaGeneratorCompileTest.php (Phase 6, Task 3)."""
from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

from app.agent_team.services.nooa_generator import NOOAGenerator


def _py_compile(code: str, suffix: str = 'test') -> tuple[int, str]:
    with tempfile.NamedTemporaryFile(mode='w', suffix=f'_{suffix}.py', delete=False) as f:
        f.write(code)
        path = f.name
    try:
        proc = subprocess.run([sys.executable, '-m', 'py_compile', path], capture_output=True, text=True)
        return proc.returncode, (proc.stdout + proc.stderr)
    finally:
        pathlib.Path(path).unlink(missing_ok=True)


def _diamond_analyzed() -> dict:
    return {
        'workflow': {'id': 9, 'name': 'Diamond'},
        'byId': {
            '1': {'id': '1', 'type': 'start', 'config': {}},
            '2': {'id': '2', 'type': 'agent', 'config': {}},
            '3': {'id': '3', 'type': 'agent', 'config': {}},
            '4': {'id': '4', 'type': 'agent', 'config': {}},
            '5': {'id': '5', 'type': 'output', 'config': {}},
        },
        'layers': [['1'], ['2', '3'], ['4'], ['5']],
        'parents': {'2': ['1'], '3': ['1'], '4': ['2', '3'], '5': ['4']},
        'startNodeId': '1',
        'agents': {
            '2': {'name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [], 'documents': []},
            '3': {'name': 'B', 'systemPrompt': 'B', 'provider': 'openai', 'model': 'gpt-4o', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [], 'documents': []},
            '4': {'name': 'C', 'systemPrompt': 'C', 'provider': 'gemini', 'model': 'gemini-2.5-flash', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [], 'documents': []},
        },
        'usedCatalog': {}, 'usedServers': {}, 'startPrompt': 'go', 'startDocuments': [],
        'outputStorageEnabled': True, 'outputFolder': None,
    }


def test_diamond_compiles():
    rc, out = _py_compile(NOOAGenerator.emitNooa(_diamond_analyzed()), 'diamond')
    assert rc == 0, f"Diamond NOOA failed py_compile:\n{out}"


def test_mcp_fixture_compiles():
    a = _diamond_analyzed()
    a['usedServers'] = {'https://mcp.example/mcp': {'name': 'Example Server'}}
    a['usedCatalog'] = {'web_search': {
        'server_url': 'https://mcp.example/mcp', 'tool_name': 'web_search',
        'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}, 'required': ['q']},
    }}
    a['agents']['2']['tools'] = ['web_search']
    rc, out = _py_compile(NOOAGenerator.emitNooa(a), 'mcp')
    assert rc == 0, f"MCP NOOA failed py_compile:\n{out}"


def test_skill_fixture_compiles():
    a = _diamond_analyzed()
    a['agents']['4']['skills'] = [{'dir': 'html'}]
    rc, out = _py_compile(NOOAGenerator.emitNooa(a), 'skill')
    assert rc == 0, f"Skill NOOA failed py_compile:\n{out}"


def test_start_documents_fixture_compiles():
    a = _diamond_analyzed()
    a['startDocuments'] = [{'name': 'Spec', 'path': '/tmp/spec.docx'}]
    rc, out = _py_compile(NOOAGenerator.emitNooa(a), 'docs')
    assert rc == 0, f"Start-documents NOOA failed py_compile:\n{out}"
