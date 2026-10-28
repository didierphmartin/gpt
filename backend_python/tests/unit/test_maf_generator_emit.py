"""Port of backend/tests/Unit/MafGeneratorEmitTest.php: MAFGenerator.emitMaf() on a minimal analysis."""
from __future__ import annotations

import re

from app.agent_team.services.maf_generator import MAFGenerator
from tests.unit.test_adk_code_node import code_analyzed


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
    assert "from agent_framework import (\n    Agent," in code
    assert "    WorkflowBuilder,\n" in code
    assert 'from agent_framework.anthropic import AnthropicClient' in code
    assert 'from agent_framework.openai import OpenAIChatCompletionClient' in code
    assert 'load_dotenv(' in code


def test_deepseek_reasoning_content_is_round_tripped():
    """DeepSeek V4 thinking mode needs `reasoning_content` replayed on assistant tool-call turns."""
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'class ReasoningRoundTripClient(OpenAIChatCompletionClient):' in code
    assert 'def _parse_response_from_openai(self, response, options):' in code
    assert 'def _prepare_message_for_openai(self, message):' in code
    assert '"reasoning_content"' in code
    assert re.search(r'if m\.get\("role"\) == "assistant":\s*m\["reasoning_content"\]', code)
    assert 'return ReasoningRoundTripClient(**kwargs)' in code
    assert 'return OpenAIChatCompletionClient(**kwargs)' not in code


def test_deepseek_flash_gets_v4_thinking_rules():
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'elif p == "deepseek" and str(model).startswith(("deepseek-v4", "deepseek-flash")):' in code


def test_client_factory_uses_chat_completion_and_base_urls():
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'def make(cls, provider: str, model: str)' in code   # ProviderClients
    assert 'AnthropicClient(model=model' in code
    # OpenAI-compatible providers MUST use ChatCompletion (the reasoning round-trip subclass), never OpenAIChatClient
    assert 'class ReasoningRoundTripClient(OpenAIChatCompletionClient)' in code
    assert 'kwargs = {"model": model' in code
    assert 'OpenAIChatClient(' not in code
    assert 'https://api.x.ai/v1' in code
    assert 'https://generativelanguage.googleapis.com/v1beta/openai/' in code


def test_agents_and_orchestration_emitted():
    code = MAFGenerator.emitMaf(_analyzed())
    assert 'AGENTS = {' in code
    assert '"2": {' in code            # agent node baked
    # one executor per canvas node, assembled by create_workflow() on WorkflowBuilder
    assert 'class AgentNodeExecutor(Executor):' in code
    assert 'Agent(client, instructions=' in code
    assert '.run(' in code
    assert 'def create_workflow():' in code
    assert 'builder = WorkflowBuilder(start_executor=start_node, output_from=[output_node])' in code
    assert 'async def run_workflow(prompt: str' in code
    assert 'asyncio.run(run_workflow(' in code
    # Parity with LangGraph build_context: every agent node sees the original prompt.
    assert 'def _framed_input(self)' in code
    assert 'Original user request:' in code
    assert 'class OutputNodeExecutor(Executor):' in code
    # Result API: agent-framework's WorkflowRunResult has NO .text -- use get_outputs().
    assert '_result.get_outputs()' in code
    assert '_result.text' not in code


def test_start_prompt_and_storage_baked():
    a = _analyzed()
    a['outputStorageEnabled'] = True
    a['outputFolder'] = None
    code = MAFGenerator.emitMaf(a)
    assert 'Analyze example.com' in code      # start prompt baked
    assert 'OUTPUT_STORAGE_ENABLED = True' in code
    assert 'WORKFLOW_ID = 7' in code


def test_skill_runtime_emitted_when_skill_present():
    a = _analyzed()
    a['agents']['2']['skills'] = [{'dir': 'html'}]
    code = MAFGenerator.emitMaf(a)
    assert '_LAST_SKILL_OUTPUTS' in code
    assert 'def _run_skill_script(' in code
    assert 'SYNERGYAI_OUTPUT_DIR' in code
    assert 'async def run_step(cls, skill' in code   # SkillRuntime
    assert 'def make_tool(cls, dir_name: str)' in code   # SkillRuntime's dir-scoped skill tool
    assert '"dir": "html"' in code   # baked into AGENTS (json_to_python pretty-prints)
    # Regression guard: MAF must NEVER pull in LangChain.
    block = MAFGenerator.skillRunnerBlockForTest()
    assert 'langchain' not in block
    assert 'StructuredTool' not in block
    assert 'RUN_SKILL_SCRIPT_TOOL' not in block
    assert 'create_model' not in block


def test_no_skill_runtime_when_no_skills():
    code = MAFGenerator.emitMaf(_analyzed())  # no skills, no tools
    assert 'def _run_skill_script(' not in code
    # Tool-free workflow: the catalog placeholder fallback is emitted (no MCP block).
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
    assert 'catalog = {}' not in code   # placeholder replaced
    # MCP tools are bound as PLAIN callables (MAF auto-wraps), never ADK's FunctionTool wrapper.
    assert 'FunctionTool(' not in code
    assert '"web_search": _tool_web_search' in code


def test_code_node_carries_arg_decls_and_passes_meta():
    """A code node's CODE_NODES entry carries its argument declarations; its run fills ARGS from the parents' meta."""
    a = code_analyzed()
    a['code']['2']['arg_decls'] = [{'name': 'folder', 'required': True}]
    code = MAFGenerator.emitMaf(a)
    assert 'meta=CODE_HARNESS.received_meta(parents)' in code
    assert 'arg_decls=cfg.get("arg_decls")' in code
    assert re.search(r'"arg_decls": \[\s*\{\s*"name": "folder",\s*"required": True\s*\}\s*\]', code)
