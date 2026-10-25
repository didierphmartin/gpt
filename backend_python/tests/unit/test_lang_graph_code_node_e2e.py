"""Port of backend/tests/Unit/LangGraphCodeNodeE2ETest.php. Opt-in (CODE_NODE_E2E=1): compiled code-node workflows
RUN with real Python + LangGraph against the mock ServiceNow MCP."""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import urllib.request

import pytest

from tests.unit import lg_support as S

PY = S.VENV
MCP = 'http://localhost/servicenow/?profile=mock&toolset=jobs'


@pytest.fixture(autouse=True)
def _opt_in():
    if os.environ.get('CODE_NODE_E2E') != '1':
        pytest.skip('Set CODE_NODE_E2E=1 to run.')
    if not os.path.isfile(PY):
        pytest.skip('venv python missing')
    req = urllib.request.Request(MCP, data=b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}', method='POST',
                                 headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req, timeout=5).read()
    except urllib.error.HTTPError:
        pass
    except OSError:
        pytest.skip('mock connector not answering')


def _db():
    return S.db(*S.MCP_DDL, S.LLM_DDL,
                "INSERT INTO mcp_servers VALUES (85, '3', 'ServiceNow', 'http://localhost/servicenow/?profile=mock&toolset=jobs', 1)",
                "INSERT INTO mcp_servers VALUES (9, NULL, 'Global News', 'http://localhost/news/', 1)",
                "INSERT INTO mcp_server_tools VALUES (1, 85, 'poll_jobs', 'Poll', '{}')",
                "INSERT INTO mcp_server_tools VALUES (3, 9, 'get_news', 'News', '{}')",
                "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
                "INSERT INTO system_llm_settings VALUES ('deepseek', 'deepseek-v4-flash', 1)")


def _generate_with(graph: dict, options: dict) -> dict:
    return S.generator(_db(), graph).generate(44, '3', options)


def _graph(code: str, servers: list) -> dict:
    return {'nodes': [
        {'id': '1', 'node_type': 'start', 'config': {'type': 'start', 'prompt': 'poll'}},
        {'id': '2', 'node_type': 'code', 'config': {'type': 'code', 'name': 'Poll ServiceNow jobs',
                                                      'code': code, 'exits': ['job', 'no_job'], 'mcp_servers': servers, 'timeout_s': 30}},
        {'id': '3', 'node_type': 'output', 'config': {'type': 'output'}},
        {'id': '4', 'node_type': 'output', 'config': {'type': 'output'}},
    ], 'edges': [
        {'from': '1', 'to': '2', 'from_port': 'output_1'},
        {'from': '2', 'to': '3', 'from_port': 'output_1'},
        {'from': '2', 'to': '4', 'from_port': 'output_2'},
    ]}


def _poll_graph() -> dict:
    return _graph("def run(input, call_tool):\n    r = call_tool('servicenow', 'poll_jobs', {})\n    if r.get('job') is None:\n"
                  "        return {'route': 'no_job', 'output': None}\n    return {'route': 'job', 'output': r['job']}\n", ['ServiceNow'])


def _no_job_graph() -> dict:
    return _graph("def run(input, call_tool):\n    return {'route': 'no_job', 'output': None}\n", [])


def _run_script(gen: dict) -> tuple:
    d = tempfile.mkdtemp(prefix='lgcn_e2e_')
    files = S.files_of(gen) if 'files' in gen else {'workflow.py': gen['code']}
    for path, code in files.items():
        os.makedirs(os.path.dirname(f'{d}/{path}'), exist_ok=True)
        with open(f'{d}/{path}', 'w', encoding='utf-8') as fh:
            fh.write(code)
    env = {'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', ''), 'ANTHROPIC_API_KEY': 'dummy',
           'OPENAI_API_KEY': 'dummy', 'DEEPSEEK_API_KEY': 'dummy'}
    try:
        r = subprocess.run([PY, 'workflow.py', 'poll'], cwd=d, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                           env=env, timeout=90)
        rc, text = r.returncode, r.stdout
    except subprocess.TimeoutExpired as e:
        rc, text = -1, (e.stdout or b'').decode() + '\n[timed out]'
    sys.stderr.write(f'\n--- E2E output ({d}) ---\n{text}\n')
    return rc, text


def _assert_job(gen: dict) -> None:
    rc, text = _run_script(gen)
    assert rc == 0, text
    assert 'SCTASK0000101' in text
    assert 'poll_jobs' in text
    assert re.search(r"exit '?job'?", text)


def test_single_file_takes_the_job_exit():
    _assert_job(_generate_with(_poll_graph(), {}))


def test_modular_takes_the_job_exit():
    _assert_job(_generate_with(_poll_graph(), {'modular': True}))


def test_no_job_exit_reaches_output_b():
    for opts in ({}, {'modular': True}):
        rc, text = _run_script(_generate_with(_no_job_graph(), opts))
        assert rc == 0, text
        assert 'SCTASK0000101' not in text
        assert re.search(r"exit '?no_job'?", text)
        assert '[4] output' in text
        assert '[3] output' not in text


def test_bad_code_stops_the_script_before_any_node_runs():
    bad = _graph("import requests\n\ndef run(input, call_tool):\n    return {'route': 'job', 'output': 1}\n", [])
    for opts in ({}, {'modular': True}):
        rc, text = _run_script(_generate_with(bad, opts))
        assert rc != 0, text
        assert "import of 'requests' is not allowed" in text
        assert '[info] Running' not in text
