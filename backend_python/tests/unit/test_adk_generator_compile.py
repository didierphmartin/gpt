"""Port of backend/tests/Unit/AdkGeneratorCompileTest.php: emitAdk() always produces syntactically valid
Python (py_compile gate, skipped without python3 on PATH as in PHP), and the diamond fixture matches the
committed golden byte for byte (tests/fixtures/adk_diamond.golden.py, a copy of PHP's
backend/tests/fixtures/adk_diamond.golden.py; the analysis pins generated_at as PHP's does)."""
from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import tempfile

import pytest

from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer

FIXTURES_DIR = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'


def _python3() -> str:
    py = shutil.which('python3')
    if py is None:
        pytest.skip('python3 not found on PATH -- skipping py_compile gate')
    return py


def _py_compile(code: str, suffix: str = 'test') -> tuple[int, str]:
    py = _python3()
    with tempfile.NamedTemporaryFile(mode='w', suffix=f'_{suffix}.py', delete=False) as f:
        f.write(code)
        path = f.name
    try:
        proc = subprocess.run([py, '-m', 'py_compile', path], capture_output=True, text=True)
        return proc.returncode, (proc.stdout + proc.stderr)
    finally:
        pathlib.Path(path).unlink(missing_ok=True)


def _diamond_analyzed() -> dict:
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'B', 'systemPrompt': 'B', 'provider': 'gemini', 'model': 'g', 'selectedTools': []}},
            {'id': '4', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [
            {'from': '1', 'to': '2'}, {'from': '1', 'to': '3'},
            {'from': '2', 'to': '4'}, {'from': '3', 'to': '4'},
        ],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    base.update({
        'workflow': {'id': 1, 'name': 'diamond'},
        'generated_at': '2026-01-01 00:00:00 UTC',
        'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'GO', 'startDocuments': [],
        'agents': {
            '2': {'name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm',
                  'temperature': None, 'max_tokens': None, 'tools': [],
                  'skill_content': '', 'output_schema_id': None, 'documents': []},
            '3': {'name': 'B', 'systemPrompt': 'B', 'provider': 'gemini', 'model': 'g',
                  'temperature': None, 'max_tokens': None, 'tools': [],
                  'skill_content': '', 'output_schema_id': None, 'documents': []},
        },
    })
    return base


def _full_featured_analyzed() -> dict:
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'Analyse the market'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'Researcher',
                'systemPrompt': "Research and call run_skill_script with dir_name='html/create'",
                'provider': 'claude', 'model': 'claude-sonnet-4-6', 'selectedTools': ['search']}},
            {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'Writer',
                'systemPrompt': 'Write report', 'provider': 'gemini', 'model': 'gemini-2.5-pro',
                'selectedTools': []}},
            {'id': '4', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}, {'from': '3', 'to': '4'}],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    base.update({
        'workflow': {'id': 99, 'name': 'full_featured'},
        'usedServers': {'http://localhost:9001/mcp': {'name': 'mcp-server'}},
        'usedCatalog': {
            'search': {
                'server_url': 'http://localhost:9001/mcp',
                'description': 'Web search',
                'input_schema': {'type': 'object', 'properties': {'query': {'type': 'string'}}},
            },
        },
        'startPrompt': 'Analyse the market',
        'startDocuments': [],
        'agents': {
            '2': {
                'name': 'Researcher',
                'systemPrompt': "Research and call run_skill_script with dir_name='html/create'",
                'provider': 'claude', 'model': 'claude-sonnet-4-6',
                'temperature': 0.5, 'max_tokens': 2048, 'tools': ['search'],
                'skill_content': '', 'skills': [{'dir': 'html/create'}],
                'output_schema_id': None, 'documents': [],
            },
            '3': {
                'name': 'Writer', 'systemPrompt': 'Write report',
                'provider': 'gemini', 'model': 'gemini-2.5-pro',
                'temperature': None, 'max_tokens': None, 'tools': [],
                'skill_content': '', 'output_schema_id': None, 'documents': [],
            },
        },
    })
    return base


def test_diamond_fixture_compiles():
    code = ADKGenerator.emitAdk(_diamond_analyzed())
    rc, out = _py_compile(code, 'diamond')
    assert rc == 0, f"Diamond fixture failed py_compile:\n{out}"


def test_diamond_matches_golden():
    golden_path = FIXTURES_DIR / 'adk_diamond.golden.py'
    if not golden_path.exists():
        pytest.skip(f"Golden fixture not found at {golden_path}")
    code = ADKGenerator.emitAdk(_diamond_analyzed())
    assert code == golden_path.read_text(encoding='utf-8'), (
        'emitAdk() output diverged from adk_diamond.golden.py -- regenerate the golden (from PHP) '
        'if the emitter change was intentional.')


def test_full_featured_fixture_compiles():
    code = ADKGenerator.emitAdk(_full_featured_analyzed())

    assert '_run_skill_script' in code
    assert '_make_skill_tool("html/create")' in code
    assert 'node_2 = SequentialAgent(' in code
    assert 'http://localhost:9001/mcp' in code
    assert 'FunctionTool(' in code
    assert 'temperature=0.5' in code
    assert 'max_output_tokens=2048' in code
    assert '_make_model("claude", "claude-sonnet-4-6", thinking=' in code
    assert '_make_model("gemini", "gemini-2.5-pro", thinking=' in code

    rc, out = _py_compile(code, 'full_featured')
    assert rc == 0, f"Full-featured fixture failed py_compile:\n{out}"


def test_with_start_documents_compiles():
    base = WorkflowGraphAnalyzer.analyzeGraph({
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'Summarise the document'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'Summariser',
                'systemPrompt': 'Summarise the attached document.', 'provider': 'claude',
                'model': 'claude-sonnet-4-6', 'selectedTools': []}},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    })
    a = dict(base)
    a.update({
        'workflow': {'id': 42, 'name': 'doc_summary'},
        'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'Summarise the document',
        'startDocuments': [{'name': 'report.pdf', 'path': '/uploads/reports/report.pdf'}],
        'agents': {
            '2': {
                'name': 'Summariser', 'systemPrompt': 'Summarise the attached document.',
                'provider': 'claude', 'model': 'claude-sonnet-4-6',
                'temperature': None, 'max_tokens': None, 'tools': [],
                'skill_content': '', 'output_schema_id': None, 'documents': [],
            },
        },
    })

    code = ADKGenerator.emitAdk(a)

    assert 'def _convert_doc_to_markdown(' in code
    assert re.search(r'START_DOCUMENTS = \[', code)
    assert '"path": "/uploads/reports/report.pdf"' in code
    assert 'if START_DOCUMENTS:' in code

    rc, out = _py_compile(code, 'with_docs')
    assert rc == 0, f"With-start-documents fixture failed py_compile:\n{out}"
