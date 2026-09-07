"""Fresh MAF emit tests testing LIVE PHP MAFGenerator behaviour (Phase 6, Task 3).

`backend/tests/Unit/MafGeneratorEmitTest.php` predates a full rewrite of
MAFGenerator.php: it asserts a `@workflow` decorator API (`from
agent_framework import Agent, workflow`, `_make_client`, `async def
_run_node(`) that no longer exists. Live PHP now emits `ProviderClients`,
the `WorkflowBuilder`/`Executor`/`add_edge` graph API, and
`AgentNodeExecutor` -- verified via `php -r` against current
MAFGenerator.php (see the Task 3 report). This file tests THAT behaviour
instead of porting the stale oracle's assertions 1:1.
"""
from __future__ import annotations

from app.agent_team.services.maf_generator import MAFGenerator


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


def test_header_and_imports():
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'from agent_framework import (' in code
    assert 'Agent,' in code
    assert 'WorkflowBuilder,' in code
    assert 'from agent_framework.anthropic import AnthropicClient' in code
    assert 'from agent_framework.openai import OpenAIChatCompletionClient' in code
    assert 'load_dotenv(' in code


def test_client_factory_uses_chat_completion_and_base_urls():
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'class ProviderClients:' in code
    assert 'def make(cls, provider: str, model: str):' in code
    assert 'AnthropicClient(model=model' in code
    assert 'OpenAIChatCompletionClient(**kwargs)' in code
    assert 'OpenAIChatClient(' not in code
    assert 'https://api.x.ai/v1' in code
    assert 'https://generativelanguage.googleapis.com/v1beta/openai/' in code


def test_agents_and_orchestration_emitted():
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'AGENTS = {' in code
    assert '"2": {' in code
    assert 'class AgentNodeExecutor(Executor):' in code
    assert 'Agent(client, instructions=' in code
    assert 'agent.run(' in code
    assert 'def create_workflow():' in code
    assert 'async def start(self, prompt: str, ctx: WorkflowContext[NodeMessage]) -> None:' in code
    assert 'WorkflowBuilder(start_executor=start_node, output_from=[output_node])' in code
    # Result API: agent-framework's WorkflowRunResult has NO .text -- get_outputs().
    assert '_result.get_outputs()' in code
    assert '_result.text' not in code


def test_start_prompt_and_storage_baked():
    a = _analyzed()
    a['outputStorageEnabled'] = True
    a['outputFolder'] = None
    code = MAFGenerator.emitMaf(a)
    assert 'Analyze example.com' in code
    assert 'OUTPUT_STORAGE_ENABLED = True' in code
    assert 'WORKFLOW_ID = 7' in code


def test_skill_runtime_emitted_when_skill_present():
    a = _analyzed()
    a['agents']['2']['skills'] = [{'dir': 'html'}]
    code = MAFGenerator.emitMaf(a)
    assert '_LAST_SKILL_OUTPUTS' in code
    assert 'def _run_skill_script(' in code
    assert 'SYNERGYAI_OUTPUT_DIR' in code
    assert 'async def run_step(cls, skill, prior, user_prompt, provider, model, max_tokens, temperature, thinking=None):' in code
    assert 'make_tool' in code
    assert '"dir": "html"' in code
    # Regression guard: MAF must NEVER pull in LangChain.
    block = MAFGenerator.skillRunnerBlockForTest()
    assert 'langchain' not in block
    assert 'StructuredTool' not in block
    assert 'RUN_SKILL_SCRIPT_TOOL' not in block
    assert 'create_model' not in block


def test_no_skill_runtime_when_no_skills():
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'def _run_skill_script(' not in code
    assert 'catalog = {}' in code
    assert 'catalog = build_tools_from_catalog()' not in code


def test_mcp_tools_emitted():
    a = _analyzed()
    a['usedServers'] = {'https://mcp.example/mcp': {'url': 'https://mcp.example/mcp'}}
    a['usedCatalog'] = {'web_search': {
        'server_url': 'https://mcp.example/mcp', 'tool_name': 'web_search',
        'input_schema': {'type': 'object', 'properties': {'q': {'type': 'string'}}, 'required': ['q']},
    }}
    a['agents']['2']['tools'] = ['web_search']
    code = MAFGenerator.emitMaf(a)
    assert 'MCP_SERVERS = {' in code
    assert 'def _call_mcp_tool(' in code
    assert 'def _tool_web_search(' in code
    assert 'catalog = build_tools_from_catalog()' in code
    assert "catalog = {}" not in code
    # MCP tools are bound as PLAIN callables (MAF auto-wraps), never ADK's
    # FunctionTool wrapper.
    assert 'FunctionTool(' not in code
    assert '"web_search": _tool_web_search' in code
