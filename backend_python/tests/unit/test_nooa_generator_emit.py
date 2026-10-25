"""Port of backend/tests/Unit/NooaGeneratorEmitTest.php, plus the NOOA halves of
LangGraphGeneratorPlaybookTest.php (playbook refusals) and EmittedMcpEndpointTest.php (the live probe, opt-in:
it needs the connector at localhost/servicenow and the runner venv, skipped otherwise as in PHP)."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile

import httpx
import pytest

from app.agent_team.services.compiled_runtime_emit import CompiledRuntimeEmit
from app.agent_team.services.compiler_text import nooa_generator as T
from app.agent_team.services.nooa_generator import NOOAGenerator
from tests.unit import lg_support as S
from tests.unit.test_lang_graph_generator_playbook import _db, _fixed_exits_graph, _from_input_graph, _robot_db


def _analyzed() -> dict:
    """Minimal analyzed shape: start -> A(claude) -> output."""
    return {
        'workflow': {'id': 7, 'name': 'Demo Flow'},
        'byId': {
            '1': {'id': '1', 'type': 'start', 'config': {}},
            '2': {'id': '2', 'type': 'agent', 'config': {}},
            '3': {'id': '3', 'type': 'output', 'config': {}},
        },
        'layers': [['1'], ['2'], ['3']],
        'parents': {'2': ['1'], '3': ['2']},
        'startNodeId': '1',
        'agents': {
            '2': {'name': 'A', 'systemPrompt': 'You are A.', 'provider': 'claude',
                  'model': 'claude-sonnet-4-6', 'temperature': None, 'max_tokens': None,
                  'tools': [], 'skill_content': '', 'skills': [], 'documents': []},
        },
        'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'Analyze example.com', 'startDocuments': [],
        'outputStorageEnabled': False, 'outputFolder': None,
    }


def _agent(name, prompt, provider, model):
    return {'name': name, 'systemPrompt': prompt, 'provider': provider, 'model': model, 'temperature': None,
            'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [], 'documents': []}


def diamond() -> dict:
    """Diamond: start -> (A || B) -> C -> output."""
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
            '2': _agent('A', 'A', 'claude', 'm'),
            '3': _agent('B', 'B', 'openai', 'gpt-4o'),
            '4': _agent('C', 'C', 'gemini', 'gemini-2.5-flash'),
        },
        'usedCatalog': {}, 'usedServers': {}, 'startPrompt': 'go', 'startDocuments': [],
        'outputStorageEnabled': True, 'outputFolder': None,
    }


def test_header_imports_and_factory():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'from nooa import Agent' in code
    assert 'from nooa.unifiedllm.registry import get_llm_client' in code
    assert 'def make_llm(provider' in code
    assert 'load_dotenv(' in code
    # Provider table parity with the MAF backend.
    assert 'https://api.x.ai/v1' in code
    assert 'https://generativelanguage.googleapis.com/v1beta/openai/' in code
    assert 'https://api.moonshot.ai/v1' in code


def test_deep_seek_flash_gets_v4_thinking_rules():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'elif p == "deepseek" and str(model).startswith(("deepseek-v4", "deepseek-flash")):' in code


def test_node_class_emitted():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'class A(Agent, llm=make_llm("claude", "claude-sonnet-4-6"' in code
    assert '"You are A."' in code          # docstring = system prompt
    assert 'async def respond(self, prompt: str) -> str:' in code
    assert 'AGENTS = {' in code
    assert 'async def run_agent(' in code
    assert 'Original user request:' in code


def test_driver_and_globals():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'async def run_workflow(prompt: str, session: str | None = None) -> str:' in code
    assert 'DEFAULT_PROMPT = "Analyze example.com"' in code
    assert 'WORKFLOW_ID = 7' in code
    assert 'OUTPUT_STORAGE_ENABLED = False' in code
    assert 'asyncio.run(run_workflow(' in code
    # Linear graph: one node per layer (GRAPH is the canvas as data; the driver runs each layer).
    assert re.search(r'"layers": \[\s*\[\s*"2"\s*\]\s*\]', code)
    # No MCP, no skills in this fixture.
    assert 'MCPManager' not in code
    assert '_run_skill_script' not in code


def test_mcp_emission():
    a = _analyzed()
    a['usedServers'] = {'https://mcp.example/mcp': {'name': 'Example Server'}}
    a['usedCatalog'] = {'web_search': {
        'server_url': 'https://mcp.example/mcp', 'tool_name': 'web_search',
        'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}, 'required': ['q']},
    }}
    a['agents']['2']['tools'] = ['mcp_web_search']   # runtime prefix must be stripped
    code = NOOAGenerator.emitNooa(a)
    assert 'from nooa.mcp import MCPManager' in code
    assert 'from datetime import timedelta' in code
    assert 'MCP_SERVERS = {' in code
    assert 'MCPManager.create_from_server(' in code
    assert 'transport="streamable-http"' in code
    assert 'mcp_0 = MCP["https://mcp.example/mcp"]' in code
    assert 'Tools selected for this node: web_search' in code


def test_mcp_url_tried_as_given_then_with_mcp():
    a = _analyzed()
    a['usedServers'] = {'https://vector.example.com': {'name': 'Vector'}}
    a['usedCatalog'] = {'find': {'server_url': 'https://vector.example.com', 'tool_name': 'find', 'input_schema': {}}}
    a['agents']['2']['tools'] = ['find']
    code = NOOAGenerator.emitNooa(a)
    # MCPManager does no URL normalization: the endpoint is probed at import, after MCP_URL_<SLUG> is applied --
    # the URL as given first, then with /mcp in its path -- and the server's headers come from MCP_HEADERS_<SLUG>.
    assert 'url=_mcp_endpoint("https://vector.example.com"),' in code
    assert 'def _mcp_endpoint(server_url: str) -> str:' in code
    assert 'headers=_mcp_headers("https://vector.example.com"),' in code
    # The dict key stays the raw catalog URL (agent attrs look it up verbatim).
    assert 'MCP["https://vector.example.com"]' in code


def test_mcp_query_url_keeps_its_query():
    url = 'http://localhost/servicenow/?profile=mock&toolset=jobs'
    a = _analyzed()
    a['usedServers'] = {url: {'name': 'ServiceNow'}}
    a['usedCatalog'] = {'poll_jobs': {'server_url': url, 'tool_name': 'poll_jobs', 'input_schema': {}}}
    a['agents']['2']['tools'] = ['poll_jobs']
    code = NOOAGenerator.emitNooa(a)
    # The candidates come from the live URL at import; _mcp_candidates puts /mcp into the path, before the query.
    assert 'url=_mcp_endpoint("' + url + '"),' in code
    assert 'path + "/mcp" + rest' in code


def test_mcp_endpoint_url_is_baked_as_is():
    a = _analyzed()
    a['usedServers'] = {'https://mcp.example/mcp': {'name': 'Example Server'}}
    a['usedCatalog'] = {'web_search': {'server_url': 'https://mcp.example/mcp', 'tool_name': 'web_search', 'input_schema': {}}}
    a['agents']['2']['tools'] = ['web_search']
    code = NOOAGenerator.emitNooa(a)
    assert 'url=_mcp_endpoint("https://mcp.example/mcp"),' in code
    # A path already ending in /mcp is the endpoint: one candidate, nothing to probe.
    assert 'if path.endswith("/mcp") or path.endswith(".php"):' in code


def test_skill_runtime_emitted_when_skill_present():
    a = _analyzed()
    a['agents']['2']['skills'] = [{'dir': 'html'}]
    code = NOOAGenerator.emitNooa(a)
    assert 'class SkillStepAgent(Agent):' in code
    assert 'async def run_skill(' in code
    assert 'def _run_skill_script(' in code   # shared FS layer
    assert '_LAST_SKILL_OUTPUTS' in code
    assert 'SYNERGYAI_OUTPUT_DIR' in code
    assert '"dir": "html"' in code            # baked into AGENTS
    # run_agent gains the mandatory skill loop.
    assert 'text = await run_skill(_skill, text, request, ad)' in code
    # Regression guard: the NOOA runtime must never pull in LangChain.
    block = NOOAGenerator.skillBlockForTest()
    assert 'langchain' not in block
    assert 'StructuredTool' not in block


def test_no_skill_runtime_when_no_skills():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'SkillStepAgent' not in code
    assert 'run_skill(' not in code
    assert 'def _run_skill_script(' not in code


def test_diamond_parallel_layer():
    code = NOOAGenerator.emitNooa(diamond())
    # B and C share a layer: the driver gathers the reached nodes of a layer.
    assert re.search(r'"layers": \[\s*\[\s*"2",\s*"3"\s*\]', code)
    assert 'await asyncio.gather(*(run_node(nid) for nid in ready))' in code
    assert 'text = await run_agent(nid, parent_texts, prompt)' in code
    assert 'OUTPUT_STORAGE_ENABLED = True' in code
    assert 'WORKFLOW_ID = 9' in code


# ---- LangGraphGeneratorPlaybookTest.php, the NOOA half ----

def _generate_nooa(graph: dict, database) -> str:
    wf = {'id': 44, 'name': 'Dispatcher demo', 'user_id': '3'}
    gen = NOOAGenerator(database, S.WfRepo(wf), S.GraphRepo(graph), S.AgentRepo())
    return gen.generate(44, '3')['code']


def test_wired_failed_exit_refused():
    with pytest.raises(RuntimeError) as e:
        _generate_nooa(_fixed_exits_graph(True), _db())
    assert str(e.value) == 'Playbook node "Playbook HR": the "failed" exit is supported by the LangGraph target only.'
    # Only "done" wired: compiles as before.
    assert _generate_nooa(_fixed_exits_graph(False), _db()) != ''


def test_from_input_refused():
    with pytest.raises(RuntimeError) as e:
        _generate_nooa(_from_input_graph(), _robot_db())
    assert str(e.value) == 'Playbook node "Run job playbook": "from input" is supported by the LangGraph target only.'


# ---- EmittedMcpEndpointTest.php: testNooaProbePicksTheAnsweringEndpointLive (opt-in by availability) ----

def test_nooa_probe_picks_the_answering_endpoint_live():
    python = os.path.expanduser('~/Documents/synergyAI/python/.venv/bin/python')
    try:
        httpx.head('http://localhost/servicenow/', timeout=2)
        up = True
    except Exception:  # noqa: BLE001
        up = False
    if not up or not os.access(python, os.X_OK):
        pytest.skip('needs the connector at localhost/servicenow and the runner venv')
    # _mcp_candidates as the shared compiled runtime emits it; the live URL and headers stubbed.
    m = re.search(r'^def _mcp_candidates\(.*?(?=^\S)', CompiledRuntimeEmit.mcpClientBlock({}), re.M | re.S)
    prelude = ('import httpx\n' + m.group(0) + '\n_mcp_live_url = lambda u: u\n'
               "_mcp_headers = lambda u: {'Accept': 'application/json, text/event-stream'}\n")
    with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False) as fh:
        fh.write(prelude + T.mcpEndpointFn__ret
                 + "\nprint(_mcp_endpoint('http://localhost/servicenow/?profile=mock&toolset=jobs'))"
                 + "\nprint(_mcp_endpoint('http://localhost/servicenow?profile=mock&toolset=jobs'))\n")
        path = fh.name
    try:
        r = subprocess.run([python, path], capture_output=True, text=True, timeout=60)
    finally:
        os.unlink(path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.splitlines() == [
        'http://localhost/servicenow/?profile=mock&toolset=jobs',      # answers as given
        'http://localhost/servicenow/mcp?profile=mock&toolset=jobs',   # 301 as given -> the /mcp form
    ]
