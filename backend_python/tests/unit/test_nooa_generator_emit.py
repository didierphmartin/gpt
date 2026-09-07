"""Port of backend/tests/Unit/NooaGeneratorEmitTest.php (Phase 6, Task 3).

No stale-oracle deviations here -- this oracle passes against live PHP
NOOAGenerator as written; ported 1:1.
"""
from __future__ import annotations

from app.agent_team.services.nooa_generator import NOOAGenerator


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


def _diamond() -> dict:
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
            '2': {'name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [], 'documents': []},
            '3': {'name': 'B', 'systemPrompt': 'B', 'provider': 'openai', 'model': 'gpt-4o', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [], 'documents': []},
            '4': {'name': 'C', 'systemPrompt': 'C', 'provider': 'gemini', 'model': 'gemini-2.5-flash', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [], 'documents': []},
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
    assert 'https://api.x.ai/v1' in code
    assert 'https://generativelanguage.googleapis.com/v1beta/openai/' in code
    assert 'https://api.moonshot.ai/v1' in code


def test_node_class_emitted():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'class A(Agent, llm=make_llm("claude", "claude-sonnet-4-6"' in code
    assert '"You are A."' in code
    assert 'async def respond(self, prompt: str) -> str:' in code
    assert 'AGENTS = {' in code
    assert 'async def run_agent(' in code
    assert 'Original user request:' in code


def test_driver_and_globals():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'async def main(' in code
    assert 'DEFAULT_PROMPT = "Analyze example.com"' in code
    assert 'WORKFLOW_ID = 7' in code
    assert 'OUTPUT_STORAGE_ENABLED = False' in code
    assert 'asyncio.run(main(' in code
    assert 'asyncio.gather(' not in code
    assert 'MCPManager' not in code
    assert '_run_skill_script' not in code


def test_mcp_emission():
    a = _analyzed()
    a['usedServers'] = {'https://mcp.example/mcp': {'name': 'Example Server'}}
    a['usedCatalog'] = {'web_search': {
        'server_url': 'https://mcp.example/mcp', 'tool_name': 'web_search',
        'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}, 'required': ['q']},
    }}
    a['agents']['2']['tools'] = ['mcp_web_search']
    code = NOOAGenerator.emitNooa(a)
    assert 'from nooa.mcp import MCPManager' in code
    assert 'from datetime import timedelta' in code
    assert 'MCP_SERVERS = {' in code
    assert 'MCPManager.create_from_server(' in code
    assert 'transport="streamable-http"' in code
    assert 'mcp_0 = MCP["https://mcp.example/mcp"]' in code
    assert 'Tools selected for this node: web_search' in code


def test_mcp_url_normalized():
    a = _analyzed()
    a['usedServers'] = {'https://vector.example.com': {'name': 'Vector'}}
    a['usedCatalog'] = {'find': {
        'server_url': 'https://vector.example.com', 'tool_name': 'find',
        'input_schema': {},
    }}
    a['agents']['2']['tools'] = ['find']
    code = NOOAGenerator.emitNooa(a)
    assert 'url="https://vector.example.com/mcp"' in code
    assert 'MCP["https://vector.example.com"]' in code


def test_skill_runtime_emitted_when_skill_present():
    a = _analyzed()
    a['agents']['2']['skills'] = [{'dir': 'html'}]
    code = NOOAGenerator.emitNooa(a)
    assert 'class SkillStepAgent(Agent):' in code
    assert 'async def run_skill(' in code
    assert 'def _run_skill_script(' in code
    assert '_LAST_SKILL_OUTPUTS' in code
    assert 'SYNERGYAI_OUTPUT_DIR' in code
    assert '"dir": "html"' in code
    assert 'text = await run_skill(_skill, text, request, ad)' in code
    block = NOOAGenerator.skillBlockForTest()
    assert 'langchain' not in block
    assert 'StructuredTool' not in block


def test_no_skill_runtime_when_no_skills():
    code = NOOAGenerator.emitNooa(_analyzed())
    assert 'SkillStepAgent' not in code
    assert 'run_skill(' not in code
    assert 'def _run_skill_script(' not in code


def test_diamond_parallel_layer():
    code = NOOAGenerator.emitNooa(_diamond())
    assert 'asyncio.gather(' in code
    assert 'run_agent("2"' in code
    assert 'run_agent("3"' in code
    assert 'OUTPUT_STORAGE_ENABLED = True' in code
    assert 'WORKFLOW_ID = 9' in code
