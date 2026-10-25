"""Port of backend/tests/Unit/AdkGeneratorEmitTest.php: what ADKGenerator.emitAdk() emits for hand-built
analyses (no database)."""
from __future__ import annotations

import re

from app.agent_team.services.adk_generator import ADKGenerator
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer


def _agent(name, prompt, provider='claude', model='m', **extra) -> dict:
    return {'name': name, 'systemPrompt': prompt, 'provider': provider, 'model': model, 'temperature': None,
            'max_tokens': None, 'tools': [], 'skill_content': '', 'output_schema_id': None, 'documents': [], **extra}


def analyzed() -> dict:
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'You are A',
                                                    'provider': 'claude', 'model': 'claude-sonnet-4-6', 'selectedTools': []}},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }
    return {**WorkflowGraphAnalyzer.analyzeGraph(graph),
            'workflow': {'id': 7, 'name': 'demo'},
            'agents': {'2': _agent('A', 'You are A', model='claude-sonnet-4-6')},
            'usedCatalog': {}, 'usedServers': {}, 'startPrompt': 'GO', 'startDocuments': []}


def _diamond(name: str, wf_id: int, b_provider: str, b_model: str) -> dict:
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 'A', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'B', 'systemPrompt': 'B', 'provider': b_provider, 'model': b_model, 'selectedTools': []}},
            {'id': '4', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '1', 'to': '3'}, {'from': '2', 'to': '4'}, {'from': '3', 'to': '4'}],
    }
    return {**WorkflowGraphAnalyzer.analyzeGraph(graph),
            'workflow': {'id': wf_id, 'name': name}, 'usedCatalog': {}, 'usedServers': {},
            'startPrompt': 'GO', 'startDocuments': [],
            'agents': {'2': _agent('A', 'A'), '3': _agent('B', 'B', provider=b_provider, model=b_model)}}


def test_header_and_imports():
    code = ADKGenerator.emitAdk(analyzed())
    assert 'google-adk' in code
    assert 'from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent' in code
    assert 'from google.adk.models.lite_llm import LiteLlm' in code


def test_model_factory_maps_providers():
    code = ADKGenerator.emitAdk(analyzed())
    assert 'def _make_model(provider: str, model: str, thinking: str | None = None)' in code
    assert 'return model' in code
    assert 'return LiteLlm(model=' in code


def test_mcp_tool_builder_emitted():
    a = analyzed()
    a['usedServers'] = {'http://localhost:9000/mcp': {'name': 'test-server'}}
    a['usedCatalog'] = {'search': {'server_url': 'http://localhost:9000/mcp', 'description': 'Search',
                                   'input_schema': {'type': 'object', 'properties': []}}}
    code = ADKGenerator.emitAdk(a)
    for s in ('MCP_SERVERS = {', 'TOOL_CATALOG = {', 'def _call_mcp_tool(', 'def build_tools_from_catalog()',
              'FunctionTool(', 'http://localhost:9000/mcp', 'def _tool_search()',
              '_call_mcp_tool("http://localhost:9000/mcp", "search"', '"search": FunctionTool(_tool_search)'):
        assert s in code, s
    assert re.search(r'"server_url":\s*"http://localhost:9000/mcp"', code)


def test_typed_function_tool_from_input_schema():
    a = analyzed()
    a['usedCatalog'] = {'search': {'server_url': 'http://localhost:9001/mcp', 'description': 'Web search', 'input_schema': {
        'type': 'object', 'properties': {'query': {'type': 'string', 'description': 'q'}, 'limit': {'type': 'integer'}},
        'required': ['query']}}}
    code = ADKGenerator.emitAdk(a)
    assert 'def _tool_search(query: str, limit: int = None) -> str:' in code
    assert 'Args:' in code
    assert 'query: q' in code
    assert '_call_mcp_tool("http://localhost:9001/mcp", "search"' in code
    assert '"search": FunctionTool(_tool_search)' in code


def test_empty_catalog_builder_returns_empty_dict():
    code = ADKGenerator.emitAdk(analyzed())
    assert 'def build_tools_from_catalog() -> dict:' in code
    assert 'return {}' in code
    assert 'def _tool_' not in code


def _with_inline_skill() -> dict:
    a = analyzed()
    skill_md = "Use the skill: call run_skill_script with dir_name='html/create'"
    a['agents']['2']['skill_content'] = skill_md
    a['agents']['2']['skills'] = [{'inline': skill_md}]
    return a


def test_skill_runner_emitted_and_async_safe():
    code = ADKGenerator.emitAdk(_with_inline_skill())
    assert 'SKILLS_DIR' in code
    assert 'def _run_skill_script(' in code
    assert 'asyncio.create_subprocess_exec' in code
    assert 'RUN_SKILL_SCRIPT_TOOL = FunctionTool(' in code


def test_skill_runner_omitted_when_no_skills():
    code = ADKGenerator.emitAdk(analyzed())
    assert '_run_skill_script' not in code
    assert 'RUN_SKILL_SCRIPT_TOOL' not in code


def test_user_prompt_braces_are_escaped_but_node_placeholders_stay_live():
    a = analyzed()
    a['agents']['2']['systemPrompt'] = 'Today is {date} ({weekday}). The current year is {year}.'
    a['byId']['3'] = {'id': '3', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'B'}}
    a['agents']['3'] = {'name': 'B', **a['agents']['2']}   # PHP's `+`: the left operand's keys win
    a['agents']['3']['systemPrompt'] = 'Summarise {topic} using the input.'
    a['order'] = ['1', '2', '3']
    a['edges'].append({'from': '2', 'to': '3'})
    a['parents']['3'] = ['2']
    a['children']['2'] = ['3']
    a['layers'] = [['1'], ['2'], ['3']]
    code = ADKGenerator.emitAdk(a)
    assert 'def _agent_instruction(prompt: str, parent_keys: list):' in code
    assert 'instruction=_agent_instruction("Today is {date} ({weekday}). The current year is {year}.", []),' in code
    assert 'instruction=_agent_instruction("Summarise {topic} using the input.", ["node_2"]),' in code
    assert '{node_2}' not in code


def test_agent_emitted_with_output_key_and_parent_injection():
    code = ADKGenerator.emitAdk(analyzed())
    assert 'node_2 = LlmAgent(' in code
    assert 'output_key="node_2"' in code
    assert 'model=_make_model("claude", "claude-sonnet-4-6", thinking=' in code
    assert 'You are A' in code


def test_generate_content_config_typed():
    a = analyzed()
    a['agents']['2']['temperature'] = 0.7
    a['agents']['2']['max_tokens'] = 1024
    code = ADKGenerator.emitAdk(a)
    assert 'types.GenerateContentConfig(' in code
    assert 'temperature=0.7' in code
    assert 'max_output_tokens=1024' in code
    assert 'generate_content_config' not in ADKGenerator.emitAdk(analyzed())


def test_deep_seek_flash_gets_v4_thinking_rules():
    a = analyzed()
    a['agents']['2'].update(provider='deepseek', model='deepseek-flash', temperature=0.7)
    code = ADKGenerator.emitAdk(a)
    assert 'if model.startswith(("deepseek-v4", "deepseek-flash")):' in code
    assert 'temperature 0.7 dropped (deepseek-v4 thinking mode' in code
    assert 'temperature=0.7' not in code


def test_run_skill_script_tool_in_agent_tools_list():
    code = ADKGenerator.emitAdk(_with_inline_skill())
    assert 'node_2_agent = LlmAgent(' in code
    assert 'RUN_SKILL_SCRIPT_TOOL = FunctionTool(' in code
    assert 'RUN_SKILL_SCRIPT_TOOL' not in code[code.index('node_2_agent = LlmAgent('):]


def test_root_layering_and_main():
    code = ADKGenerator.emitAdk(_diamond('w', 1, 'gemini', 'g'))
    assert 'ParallelAgent(' in code
    assert 'root_agent = SequentialAgent(' in code
    assert 'node_4' in code
    assert 'async def run_workflow(' in code
    assert 'Runner(' in code
    assert '" ".join(sys.argv[1:])' in code
    assert 'run_workflow(sys.argv[1] if' not in code


def test_main_honors_output_storage_setting():
    graph = {
        'nodes': [
            {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
            {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'A', 'systemPrompt': 's', 'provider': 'claude', 'model': 'm', 'selectedTools': []}},
            {'id': '3', 'type': 'output', 'config': {'type': 'output'}},
        ],
        'edges': [{'from': '1', 'to': '2'}, {'from': '2', 'to': '3'}],
    }

    def mk(enabled, folder):
        return {**WorkflowGraphAnalyzer.analyzeGraph(graph),
                'workflow': {'id': 42, 'name': 'W'}, 'usedCatalog': {}, 'usedServers': {},
                'startPrompt': 'GO', 'startDocuments': [], 'outputStorageEnabled': enabled, 'outputFolder': folder,
                'agents': {'2': _agent('A', 's', skills=[])}}

    on = ADKGenerator.emitAdk(mk(True, None))
    for s in ('WORKFLOW_ID = 42', 'OUTPUT_STORAGE_ENABLED = True', 'OUTPUT_FOLDER = None', 'if OUTPUT_STORAGE_ENABLED:',
              '~/Documents/synergyAI/outputs', 'os.path.join(_root, "workflow")', '{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}'):
        assert s in on, s
    assert 'os.path.join("outputs", f"{_slug}' not in on
    off = ADKGenerator.emitAdk(mk(False, None))
    assert 'OUTPUT_STORAGE_ENABLED = False' in off
    assert 'output storage is OFF' in off
    custom = ADKGenerator.emitAdk(mk(True, 'client-reports'))
    assert 'OUTPUT_FOLDER = "client-reports"' in custom
    assert 'os.path.join(_root, OUTPUT_FOLDER)' in custom


def test_output_node_is_non_llm_pass_through():
    code = ADKGenerator.emitAdk(_diamond('diamond', 2, 'claude', 'm'))
    assert 'class _PassThroughAgent(BaseAgent):' in code
    assert re.search(r'node_4 = _PassThroughAgent\(name="node_4", source_keys=\[[^\]]*"node_2"[^\]]*"node_3"[^\]]*\]\)', code)
    assert 'node_4 = LlmAgent(' not in code
    assert 'Consolidate the following results' not in code
    assert 'from google.adk.events import Event, EventActions' in code


def test_header_imports_httpx_and_time():
    code = ADKGenerator.emitAdk(analyzed())
    assert re.search(r'^import httpx$', code, re.M)
    assert re.search(r'^import .*\btime\b', code, re.M)
    assert '"google-adk>=2.3,<3" litellm httpx' in code


def test_required_param_ordered_before_optional_regardless_of_schema_order():
    a = analyzed()
    a['usedCatalog'] = {'search': {'server_url': 'http://localhost:9002/mcp', 'description': 'Search', 'input_schema': {
        'type': 'object', 'properties': {'limit': {'type': 'integer'}, 'query': {'type': 'string'}}, 'required': ['query']}}}
    code = ADKGenerator.emitAdk(a)
    assert 'def _tool_search(query: str, limit: int = None)' in code
    assert 'def _tool_search(limit:' not in code


def test_invalid_identifier_and_keyword_properties_routed_to_extra():
    a = analyzed()
    a['usedCatalog'] = {'lookup': {'server_url': 'http://localhost:9003/mcp', 'description': 'Lookup', 'input_schema': {
        'type': 'object', 'properties': {'user-id': {'type': 'string'}, 'in': {'type': 'string'}, 'query': {'type': 'string'}},
        'required': ['query']}}}
    code = ADKGenerator.emitAdk(a)
    assert 'query: str' in code
    assert '**extra' in code
    assert not re.search(r'def _tool_lookup\([^)]*\bin:', code)
    assert not re.search(r'def _tool_lookup\([^)]*user-id:', code)


def test_document_converter_block_always_emitted():
    code = ADKGenerator.emitAdk(analyzed())
    assert 'def _convert_doc_to_markdown(' in code
    assert 'START_DOCUMENTS = []' in code


def test_start_documents_non_empty_baked_and_prepended():
    a = analyzed()
    a['startDocuments'] = [{'name': 'spec.md', 'path': '/uploads/spec.md'}]
    code = ADKGenerator.emitAdk(a)
    for s in ('START_DOCUMENTS = [', '"path": "/uploads/spec.md"', 'def _convert_doc_to_markdown(',
              'if START_DOCUMENTS:', '_convert_doc_to_markdown(path)', '"## Attached Documents\\n\\n"'):
        assert s in code, s


def test_empty_start_documents_emits_empty_list_and_guard():
    code = ADKGenerator.emitAdk(analyzed())
    assert 'START_DOCUMENTS = []' in code
    assert 'if START_DOCUMENTS:' in code


def test_skill_runner_emits_live_skill_helpers():
    code = ADKGenerator.skillRunnerBlockForTest()
    for s in ('def _read_skill_md(', 'SKILLS_DIR', 'def _skill_instruction(', 'def _make_skill_tool(',
              'return await _run_skill_script(dir_name, script, argv, input_files, read_outputs)',
              'SKILL_OUTPUTS_ROOT', 'def _skill_output_dir(', 'os.makedirs(out_dir', 'SYNERGYAI_OUTPUT_DIR=out_dir',
              'SYNERGYAI_SKILL_DIR_NAME=dir_name', 'SYNERGYAI_SKILL_GROUP=group', 'cwd=skill_path, env=env',
              'SKILL_SCRATCH_DIR', 'def _remap_virtual_path(', 'SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR',
              '_remap_virtual_path(raw_path, out_dir)', '[output file '):
        assert s in code, s


def _skill_dir_analyzed(prompt: str) -> dict:
    graph = {'nodes': [
        {'id': '1', 'type': 'start', 'config': {'type': 'start', 'prompt': 'GO'}},
        {'id': '2', 'type': 'agent', 'config': {'type': 'agent', 'agent_name': 'R', 'systemPrompt': prompt,
                                                'provider': 'claude', 'model': 'm', 'selectedTools': []}},
    ], 'edges': [{'from': '1', 'to': '2'}]}
    return {**WorkflowGraphAnalyzer.analyzeGraph(graph),
            'workflow': {'id': 1, 'name': 'w'}, 'usedCatalog': {}, 'usedServers': {},
            'startPrompt': 'GO', 'startDocuments': [],
            'agents': {'2': _agent('R', prompt, skills=[{'dir': 'GEO/geo-report'}])}}


def test_skill_node_compiles_to_sequential_with_mandatory_skill_step():
    code = ADKGenerator.emitAdk(_skill_dir_analyzed('write the report'))
    assert 'node_2_agent = LlmAgent(' in code
    start = code.index('node_2_agent = LlmAgent(')
    assert 'RUN_SKILL_SCRIPT_TOOL' not in code[start:code.index('\n)', start)]
    assert 'node_2_skill_1_llm = LlmAgent(' in code
    assert '_make_model("claude", "m", thinking=' in code
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
    a = {**WorkflowGraphAnalyzer.analyzeGraph(graph),
         'workflow': {'id': 1, 'name': 'w'}, 'usedCatalog': {}, 'usedServers': {},
         'startPrompt': 'GO', 'startDocuments': [],
         'agents': {'2': _agent('A', 'A'), '3': _agent('B', 'B reads A')}}
    code = ADKGenerator.emitAdk(a)
    assert '_agent_instruction(' in code
    assert '["node_2"]' in code


def test_skill_helpers_emitted_when_agent_has_skills_list():
    assert 'def _make_skill_tool(' in ADKGenerator.emitAdk(_skill_dir_analyzed('s'))
