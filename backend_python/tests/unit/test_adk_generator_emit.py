"""Port of backend/tests/Unit/AdkGeneratorEmitTest.php (Phase 6, Task 3).

Stale-oracle deviations (documented in the Task 3 report): `_make_model`
gained a `thinking` parameter after the PHP oracle was written, so live PHP
now always emits `_make_model("prov", "model", thinking=None|"on"|"off")` --
never the bare two-arg call the original PHP assertions expected. The
affected assertions below (`testModelFactoryMapsProviders`,
`testAgentEmittedWithOutputKeyAndParentInjection`,
`testSkillNodeCompilesToSequentialWithMandatorySkillStep`) are updated to
match LIVE PHP output (verified via `php -r` against the current
ADKGenerator.php), not the stale literal strings.
"""
from __future__ import annotations

import re

from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer


def _analyzed() -> dict:
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'You are A', 'provider': 'claude', 'model': 'claude-sonnet-4-6', 'selectedTools': []}},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    base.update({
        'workflow': {'id': 7, 'name': 'demo'},
        'agents': {'2': {'name': 'A', 'systemPrompt': 'You are A', 'provider': 'claude', 'model': 'claude-sonnet-4-6', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': []}},
        'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'GO', 'startDocuments': [],
    })
    return base


def test_header_and_imports():
    code = ADKGenerator.emitAdk(_analyzed())
    assert 'google-adk' in code
    assert 'from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent' in code
    assert 'from google.adk.models.lite_llm import LiteLlm' in code


def test_model_factory_maps_providers():
    code = ADKGenerator.emitAdk(_analyzed())
    # Stale-oracle fix: live PHP signature carries `thinking`.
    assert 'def _make_model(provider: str, model: str, thinking: str | None = None)' in code
    assert 'return model' in code           # gemini path
    assert 'return LiteLlm(model=' in code  # non-gemini path


def test_mcp_tool_builder_emitted():
    a = _analyzed()
    a['usedServers'] = {'http://localhost:9000/mcp': {'name': 'test-server'}}
    a['usedCatalog'] = {'search': {'server_url': 'http://localhost:9000/mcp', 'description': 'Search', 'input_schema': {'type': 'object', 'properties': {}}}}
    code = ADKGenerator.emitAdk(a)
    assert 'MCP_SERVERS = {' in code
    assert 'TOOL_CATALOG = {' in code
    assert 'def _call_mcp_tool(' in code
    assert 'def build_tools_from_catalog()' in code
    assert 'FunctionTool(' in code
    assert 'http://localhost:9000/mcp' in code
    assert 'def _tool_search()' in code
    assert '_call_mcp_tool("http://localhost:9000/mcp", "search"' in code
    assert '"search": FunctionTool(_tool_search)' in code
    assert re.search(r'"server_url":\s*"http://localhost:9000/mcp"', code)


def test_typed_function_tool_from_input_schema():
    a = _analyzed()
    a['usedCatalog'] = {
        'search': {
            'server_url': 'http://localhost:9001/mcp',
            'description': 'Web search',
            'input_schema': {
                'type': 'object',
                'properties': {'query': {'type': 'string', 'description': 'q'}, 'limit': {'type': 'integer'}},
                'required': ['query'],
            },
        },
    }
    code = ADKGenerator.emitAdk(a)
    assert 'def _tool_search(query: str, limit: int = None) -> str:' in code
    assert 'Args:' in code
    assert 'query: q' in code
    assert '_call_mcp_tool("http://localhost:9001/mcp", "search"' in code
    assert '"search": FunctionTool(_tool_search)' in code


def test_empty_catalog_builder_returns_empty_dict():
    code = ADKGenerator.emitAdk(_analyzed())
    assert 'def build_tools_from_catalog() -> dict:' in code
    assert 'return {}' in code
    assert 'def _tool_' not in code


def test_skill_runner_emitted_and_async_safe():
    a = _analyzed()
    skill_md = "Use the skill: call run_skill_script with dir_name='html/create'"
    a['agents']['2']['skill_content'] = skill_md
    a['agents']['2']['skills'] = [{'inline': skill_md}]
    code = ADKGenerator.emitAdk(a)
    assert 'SKILLS_DIR' in code
    assert 'def _run_skill_script(' in code
    assert 'asyncio.create_subprocess_exec' in code
    assert 'RUN_SKILL_SCRIPT_TOOL = FunctionTool(' in code


def test_skill_runner_omitted_when_no_skills():
    code = ADKGenerator.emitAdk(_analyzed())
    assert '_run_skill_script' not in code
    assert 'RUN_SKILL_SCRIPT_TOOL' not in code


def test_agent_emitted_with_output_key_and_parent_injection():
    a = _analyzed()
    code = ADKGenerator.emitAdk(a)
    assert 'node_2 = LlmAgent(' in code
    assert 'output_key="node_2"' in code
    # Stale-oracle fix: live PHP always passes thinking= to _make_model.
    assert 'model=_make_model("claude", "claude-sonnet-4-6", thinking=None)' in code
    assert 'You are A' in code


def test_generate_content_config_typed():
    a = _analyzed()
    a['agents']['2']['temperature'] = 0.7
    a['agents']['2']['max_tokens'] = 1024
    code = ADKGenerator.emitAdk(a)
    assert 'types.GenerateContentConfig(' in code
    assert 'temperature=0.7' in code
    assert 'max_output_tokens=1024' in code

    code2 = ADKGenerator.emitAdk(_analyzed())
    assert 'generate_content_config' not in code2


def test_run_skill_script_tool_in_agent_tools_list():
    a = _analyzed()
    skill_md = "Use the skill: call run_skill_script with dir_name='html/create'"
    a['agents']['2']['skill_content'] = skill_md
    a['agents']['2']['skills'] = [{'inline': skill_md}]
    code = ADKGenerator.emitAdk(a)
    assert 'node_2_agent = LlmAgent(' in code
    assert 'RUN_SKILL_SCRIPT_TOOL = FunctionTool(' in code
    agent_block = code[code.index('node_2_agent = LlmAgent('):]
    assert 'RUN_SKILL_SCRIPT_TOOL' not in agent_block


def test_root_layering_and_main():
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'B', 'systemPrompt': 'B', 'provider': 'gemini', 'model': 'g', 'selectedTools': []}},
            {'id': '4', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '1', 'to': '3'}, {'from': '2', 'to': '4'}, {'from': '3', 'to': '4'}],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    a = dict(base)
    a.update({
        'workflow': {'id': 1, 'name': 'w'}, 'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'GO', 'startDocuments': [],
        'agents': {
            '2': {'name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': []},
            '3': {'name': 'B', 'systemPrompt': 'B', 'provider': 'gemini', 'model': 'g', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': []},
        },
    })
    code = ADKGenerator.emitAdk(a)
    assert 'ParallelAgent(' in code
    assert 'root_agent = SequentialAgent(' in code
    assert 'node_4' in code
    assert 'async def main(' in code
    assert 'Runner(' in code
    assert '" ".join(sys.argv[1:])' in code
    assert 'main(sys.argv[1] if' not in code


def test_main_honors_output_storage_setting():
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 's', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)

    def mk(enabled, folder):
        d = dict(base)
        d.update({
            'workflow': {'id': 42, 'name': 'W'}, 'usedCatalog': {}, 'usedServers': {},
            'startPrompt': 'GO', 'startDocuments': [],
            'outputStorageEnabled': enabled, 'outputFolder': folder,
            'agents': {'2': {'name': 'A', 'systemPrompt': 's', 'provider': 'claude', 'model': 'm',
                              'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'skills': [],
                              'output_schema_id': None, 'documents': []}},
        })
        return d

    on = ADKGenerator.emitAdk(mk(True, None))
    assert 'WORKFLOW_ID = 42' in on
    assert 'OUTPUT_STORAGE_ENABLED = True' in on
    assert 'OUTPUT_FOLDER = None' in on
    assert 'if OUTPUT_STORAGE_ENABLED:' in on
    assert '~/Documents/synergyAI/outputs' in on
    assert 'os.path.join(_root, "workflow")' in on
    assert '{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}' in on
    assert 'os.path.join("outputs", f"{_slug}' not in on

    off = ADKGenerator.emitAdk(mk(False, None))
    assert 'OUTPUT_STORAGE_ENABLED = False' in off
    assert 'output storage is OFF' in off

    custom = ADKGenerator.emitAdk(mk(True, 'client-reports'))
    assert 'OUTPUT_FOLDER = "client-reports"' in custom
    assert 'os.path.join(_root, OUTPUT_FOLDER)' in custom


def test_output_node_is_non_llm_pass_through():
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'B', 'systemPrompt': 'B', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '4', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '1', 'to': '3'}, {'from': '2', 'to': '4'}, {'from': '3', 'to': '4'}],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    a = dict(base)
    a.update({
        'workflow': {'id': 2, 'name': 'diamond'}, 'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'GO', 'startDocuments': [],
        'agents': {
            '2': {'name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': []},
            '3': {'name': 'B', 'systemPrompt': 'B', 'provider': 'claude', 'model': 'm', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': []},
        },
    })
    code = ADKGenerator.emitAdk(a)
    assert 'class _PassThroughAgent(BaseAgent):' in code
    assert re.search(r'node_4 = _PassThroughAgent\(name="node_4", source_keys=\[[^\]]*"node_2"[^\]]*"node_3"[^\]]*\]\)', code)
    assert 'node_4 = LlmAgent(' not in code
    assert 'Consolidate the following results' not in code
    assert 'from google.adk.events import Event, EventActions' in code


def test_header_imports_httpx_and_time():
    code = ADKGenerator.emitAdk(_analyzed())
    assert re.search(r'^import httpx$', code, re.M)
    assert re.search(r'^import .*\btime\b', code, re.M)
    assert '"google-adk>=2.3,<3" litellm httpx' in code


def test_required_param_ordered_before_optional_regardless_of_schema_order():
    a = _analyzed()
    a['usedCatalog'] = {
        'search': {
            'server_url': 'http://localhost:9002/mcp',
            'description': 'Search',
            'input_schema': {
                'type': 'object',
                'properties': {'limit': {'type': 'integer'}, 'query': {'type': 'string'}},
                'required': ['query'],
            },
        },
    }
    code = ADKGenerator.emitAdk(a)
    assert 'def _tool_search(query: str, limit: int = None)' in code
    assert 'def _tool_search(limit:' not in code


def test_invalid_identifier_and_keyword_properties_routed_to_extra():
    a = _analyzed()
    a['usedCatalog'] = {
        'lookup': {
            'server_url': 'http://localhost:9003/mcp',
            'description': 'Lookup',
            'input_schema': {
                'type': 'object',
                'properties': {'user-id': {'type': 'string'}, 'in': {'type': 'string'}, 'query': {'type': 'string'}},
                'required': ['query'],
            },
        },
    }
    code = ADKGenerator.emitAdk(a)
    assert 'query: str' in code
    assert '**extra' in code
    assert not re.search(r'def _tool_lookup\([^)]*\bin:', code)
    assert not re.search(r'def _tool_lookup\([^)]*user-id:', code)


def test_document_converter_block_always_emitted():
    code = ADKGenerator.emitAdk(_analyzed())
    assert 'def _convert_doc_to_markdown(' in code
    assert 'START_DOCUMENTS = []' in code


def test_start_documents_non_empty_baked_and_prepended():
    a = _analyzed()
    a['startDocuments'] = [{'name': 'spec.md', 'path': '/uploads/spec.md'}]
    code = ADKGenerator.emitAdk(a)
    assert 'START_DOCUMENTS = [' in code
    assert '"path": "/uploads/spec.md"' in code
    assert 'def _convert_doc_to_markdown(' in code
    assert 'if START_DOCUMENTS:' in code
    assert '_convert_doc_to_markdown(path)' in code
    assert '"## Attached Documents\\n\\n"' in code


def test_empty_start_documents_emits_empty_list_and_guard():
    code = ADKGenerator.emitAdk(_analyzed())
    assert 'START_DOCUMENTS = []' in code
    assert 'if START_DOCUMENTS:' in code


def test_skill_runner_emits_live_skill_helpers():
    code = ADKGenerator.skillRunnerBlockForTest()
    assert 'def _read_skill_md(' in code
    assert 'SKILLS_DIR' in code
    assert 'def _skill_instruction(' in code
    assert 'def _make_skill_tool(' in code
    assert 'return await _run_skill_script(dir_name, script, argv, input_files, read_outputs)' in code
    assert 'SKILL_OUTPUTS_ROOT' in code
    assert 'def _skill_output_dir(' in code
    assert 'os.makedirs(out_dir' in code
    assert 'SYNERGYAI_OUTPUT_DIR=out_dir' in code
    assert 'SYNERGYAI_SKILL_DIR_NAME=dir_name' in code
    assert 'SYNERGYAI_SKILL_GROUP=group' in code
    assert 'cwd=skill_path, env=env' in code
    assert 'SKILL_SCRATCH_DIR' in code
    assert 'def _remap_virtual_path(' in code
    assert 'SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR' in code
    assert '_remap_virtual_path(raw_path, out_dir)' in code
    assert '[output file ' in code


def test_skill_node_compiles_to_sequential_with_mandatory_skill_step():
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'R',
                'systemPrompt': 'write the report', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
        ],
        'edges': [{'from': '1', 'to': '2'}],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    a = dict(base)
    a.update({
        'workflow': {'id': 1, 'name': 'w'}, 'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'GO', 'startDocuments': [],
        'agents': {
            '2': {'name': 'R', 'systemPrompt': 'write the report', 'provider': 'claude', 'model': 'm',
                  'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '',
                  'skills': [{'dir': 'GEO/geo-report'}], 'output_schema_id': None, 'documents': []},
        },
    })
    code = ADKGenerator.emitAdk(a)

    assert 'node_2_agent = LlmAgent(' in code
    main_start = code.index('node_2_agent = LlmAgent(')
    main_block = code[main_start:code.index('\n)', main_start)]
    assert 'RUN_SKILL_SCRIPT_TOOL' not in main_block
    assert 'node_2_skill_1_llm = LlmAgent(' in code
    # Stale-oracle fix: live PHP always passes thinking= to _make_model.
    assert '_make_model("claude", "m", thinking=None)' in code
    assert '_make_skill_tool("GEO/geo-report")' in code
    assert '_skill_instruction("GEO/geo-report", "node_2_agent"' in code
    assert ('node_2_skill_1 = _SkillCaptureAgent(name="node_2_skill_1", skill_dir="GEO/geo-report", '
            'llm_key="node_2_skill_1_llm", out_key="node_2")') in code
    assert re.search(r'node_2 = SequentialAgent\(\s*name="node_2",\s*sub_agents=\[node_2_agent, node_2_skill_1_llm, node_2_skill_1\]', code, re.S)


def test_parent_outputs_injected_into_instruction():
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'B', 'systemPrompt': 'B reads A', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    a = dict(base)
    a.update({
        'workflow': {'id': 1, 'name': 'w'}, 'usedCatalog': {}, 'usedServers': {},
        'startPrompt': 'GO', 'startDocuments': [],
        'agents': {
            '2': {'name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': []},
            '3': {'name': 'B', 'systemPrompt': 'B reads A', 'provider': 'claude', 'model': 'm', 'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': []},
        },
    })
    code = ADKGenerator.emitAdk(a)
    assert '{node_2}' in code


def test_skill_helpers_emitted_when_agent_has_skills_list():
    graph = {'nodes': [
        {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
        {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'R',
            'systemPrompt': 's', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
    ], 'edges': [{'from': '1', 'to': '2'}]}
    base = WorkflowGraphAnalyzer.analyzeGraph(graph)
    a = dict(base)
    a.update({'workflow': {'id': 1, 'name': 'w'}, 'usedCatalog': {}, 'usedServers': {},
              'startPrompt': 'GO', 'startDocuments': [], 'agents': {
        '2': {'name': 'R', 'systemPrompt': 's', 'provider': 'claude', 'model': 'm',
              'temperature': None, 'max_tokens': None, 'tools': [], 'skill_content': '',
              'skills': [{'dir': 'GEO/geo-report'}], 'output_schema_id': None, 'documents': []}}})
    code = ADKGenerator.emitAdk(a)
    assert 'def _make_skill_tool(' in code
