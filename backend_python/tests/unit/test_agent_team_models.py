"""Unit tests for the AgentTeam models (Agent, Team, Workflow, WorkflowSchema).

Agent cases are ported from backend/tests/Unit/AgentTeam/AgentTest.php (PHP oracle).
Team/Workflow/WorkflowSchema cases are new, written against the PHP source directly
(backend/src/AgentTeam/Models/{Team,Workflow,WorkflowSchema}.php — no PHP unit oracle
exists for these classes).
"""
import pytest

from app.agent_team.models import Agent, Team, Workflow, WorkflowSchema


# ================================================================
# Agent — ported from AgentTest.php
# ================================================================

@pytest.fixture
def standard_agent():
    return Agent({
        'id': 1,
        'user_id': 100,
        'name': 'Test Agent',
        'description': 'A test agent',
        'agent_type': 'standard',
        'provider': 'claude',
        'model': 'claude-sonnet-4-20250514',
        'instructions': 'You are a helpful assistant.',
        'tools': ['calculate', 'search'],
        'visibility': 'personal',
        'enabled': True,
    })


@pytest.fixture
def manager_agent():
    return Agent({
        'id': 2,
        'user_id': 100,
        'name': 'Manager Agent',
        'description': 'A manager agent',
        'agent_type': 'manager',
        'provider': 'claude',
        'tools': ['delegate_to_agent', 'list_available_agents'],
        'can_delegate_to': [10, 11, 12],
    })


@pytest.fixture
def worker_agent():
    return Agent({
        'id': 3,
        'user_id': 100,
        'name': 'Worker Agent',
        'description': 'A worker agent',
        'agent_type': 'worker',
        'provider': 'claude',
        'tools': ['pubmed_search'],
    })


# ---- Construction and Hydration ----

def test_can_create_agent_from_array():
    agent = Agent({'name': 'New Agent', 'user_id': 1})
    assert agent.getName() == 'New Agent'
    assert agent.getUserId() == 1


def test_default_values():
    agent = Agent({'name': 'Minimal'})
    assert agent.getAgentType() == 'standard'
    assert agent.getProvider() == 'claude'
    assert agent.getVisibility() == 'personal'
    assert agent.isEnabled() is True
    assert agent.getTools() == []
    assert agent.getCanDelegateTo() == []


def test_category_defaults_to_none():
    agent = Agent({'name': 'No Category'})
    assert agent.getCategory() is None


def test_hydrates_category():
    agent = Agent({'name': 'Foo', 'category': 'Research'})
    assert agent.getCategory() == 'Research'


def test_empty_string_category_hydrates_as_none():
    agent = Agent({'name': 'Foo', 'category': ''})
    assert agent.getCategory() is None


def test_set_category_accepts_none_and_empty():
    agent = Agent({'name': 'Foo', 'category': 'Old'})
    agent.setCategory('New')
    assert agent.getCategory() == 'New'
    agent.setCategory(None)
    assert agent.getCategory() is None
    agent.setCategory('Other')
    agent.setCategory('')
    assert agent.getCategory() is None


def test_category_appears_in_to_array_and_api_array():
    agent = Agent({'name': 'Foo', 'category': 'Reports'})
    assert agent.toArray()['category'] == 'Reports'
    assert agent.toApiArray()['category'] == 'Reports'


def test_hydrates_json_fields():
    agent = Agent({
        'name': 'JSON Test',
        'tools': '["tool1", "tool2"]',
        'can_delegate_to': '[1, 2, 3]',
        'settings': '{"temperature": 0.7}',
    })
    assert agent.getTools() == ['tool1', 'tool2']
    assert agent.getCanDelegateTo() == [1, 2, 3]
    assert agent.getSettings() == {'temperature': 0.7}


# ---- Getters ----

def test_getters(standard_agent):
    assert standard_agent.getId() == 1
    assert standard_agent.getUserId() == 100
    assert standard_agent.getName() == 'Test Agent'
    assert standard_agent.getDescription() == 'A test agent'
    assert standard_agent.getAgentType() == 'standard'
    assert standard_agent.getProvider() == 'claude'
    assert standard_agent.getModel() == 'claude-sonnet-4-20250514'
    assert standard_agent.getInstructions() == 'You are a helpful assistant.'
    assert standard_agent.getTools() == ['calculate', 'search']
    assert standard_agent.getVisibility() == 'personal'
    assert standard_agent.isEnabled() is True


# ---- Setters ----

def test_setters():
    agent = Agent({'name': 'Original'})

    agent.setName('Updated Name')
    assert agent.getName() == 'Updated Name'

    agent.setDescription('New description')
    assert agent.getDescription() == 'New description'

    agent.setAgentType('manager')
    assert agent.getAgentType() == 'manager'

    agent.setProvider('openai')
    assert agent.getProvider() == 'openai'

    agent.setModel('gpt-4')
    assert agent.getModel() == 'gpt-4'

    agent.setTools(['new_tool'])
    assert agent.getTools() == ['new_tool']

    agent.setEnabled(False)
    assert agent.isEnabled() is False


def test_fluent_setters():
    agent = Agent({'name': 'Fluent Test'})
    result = agent.setName('Chained').setDescription('Fluent description').setProvider('openai')
    assert result is agent
    assert agent.getName() == 'Chained'


def test_invalid_agent_type_raises():
    agent = Agent({'name': 'Foo'})
    with pytest.raises(ValueError, match="Invalid agent type: bogus"):
        agent.setAgentType('bogus')


def test_invalid_visibility_raises():
    agent = Agent({'name': 'Foo'})
    with pytest.raises(ValueError, match="Invalid visibility: bogus"):
        agent.setVisibility('bogus')


# ---- Agent Type ----

def test_is_manager(standard_agent, manager_agent, worker_agent):
    assert manager_agent.isManager() is True
    assert standard_agent.isManager() is False
    assert worker_agent.isManager() is False


def test_is_worker(standard_agent, manager_agent, worker_agent):
    assert worker_agent.isWorker() is True
    assert standard_agent.isWorker() is False
    assert manager_agent.isWorker() is False


def test_is_standard(standard_agent, manager_agent, worker_agent):
    assert standard_agent.isStandard() is True
    assert manager_agent.isStandard() is False
    assert worker_agent.isStandard() is False


# ---- Delegation ----

def test_can_delegate_to_agent_with_explicit_list(manager_agent):
    assert manager_agent.canDelegateToAgent(10) is True
    assert manager_agent.canDelegateToAgent(11) is True
    assert manager_agent.canDelegateToAgent(12) is True
    assert manager_agent.canDelegateToAgent(99) is False


def test_can_delegate_to_agent_with_empty_list():
    open_manager = Agent({'name': 'Open Manager', 'agent_type': 'manager', 'can_delegate_to': []})
    assert open_manager.canDelegateToAgent(1) is True
    assert open_manager.canDelegateToAgent(999) is True


def test_non_manager_cannot_delegate(standard_agent, worker_agent):
    assert standard_agent.canDelegateToAgent(1) is False
    assert worker_agent.canDelegateToAgent(1) is False
    assert standard_agent.getCanDelegateTo() == []
    assert worker_agent.getCanDelegateTo() == []


# ---- isAccessibleBy ----

def test_is_accessible_by_owner(standard_agent):
    assert standard_agent.isAccessibleBy(100) is True


def test_is_accessible_by_public():
    agent = Agent({'name': 'Foo', 'user_id': 1, 'visibility': 'public'})
    assert agent.isAccessibleBy(999) is True


def test_is_not_accessible_by_stranger():
    agent = Agent({'name': 'Foo', 'user_id': 1, 'visibility': 'personal'})
    assert agent.isAccessibleBy(999) is False


# ---- Serialization ----

def test_to_array(standard_agent):
    array = standard_agent.toArray()
    assert isinstance(array, dict)
    assert array['id'] == 1
    assert array['name'] == 'Test Agent'
    assert array['tools'] == ['calculate', 'search']
    assert 'instructions' in array
    assert 'settings' in array


def test_to_array_key_order(standard_agent):
    assert list(standard_agent.toArray().keys()) == [
        'id', 'user_id', 'team_id', 'category', 'name', 'description',
        'agent_type', 'parent_agent_id', 'can_delegate_to', 'display_order',
        'provider', 'model', 'instructions', 'tools', 'visibility', 'enabled',
        'settings', 'created_at', 'updated_at',
    ]


def test_to_api_array(standard_agent):
    api_array = standard_agent.toApiArray()
    assert isinstance(api_array, dict)
    assert 'id' in api_array
    assert 'name' in api_array
    assert 'description' in api_array
    # NOTE: the PHP oracle (AgentTest::testToApiArray) asserts these are absent,
    # but that assertion currently FAILS against Agent.php 136-154 (verified via
    # `php vendor/bin/phpunit tests/Unit/AgentTeam/AgentTest.php` — 1 failure,
    # "instructions" key present). toApiArray() does include them; ported as-is
    # per "PHP source wins" — see task-1-report.md.
    assert 'instructions' in api_array
    assert 'settings' in api_array


def test_to_api_array_key_order(standard_agent):
    assert list(standard_agent.toApiArray().keys()) == [
        'id', 'name', 'description', 'category', 'agent_type', 'display_order',
        'provider', 'model', 'instructions', 'tools', 'settings', 'visibility',
        'enabled', 'created_at',
    ]


def test_to_array_empty_json_fields_are_lists():
    """Empty decoded-JSON fields serialize as [] (PHP has no empty-dict/empty-list
    distinction) — see php_array() in app.support.phpcompat."""
    agent = Agent({'name': 'Foo'})
    array = agent.toArray()
    assert array['can_delegate_to'] == []
    assert array['tools'] == []
    assert array['settings'] == []


# ---- System Prompt ----

def test_build_system_prompt(standard_agent):
    prompt = standard_agent.buildSystemPrompt()
    assert isinstance(prompt, str)
    assert 'Test Agent' in prompt
    assert 'You are a helpful assistant' in prompt


def test_build_system_prompt_includes_description(standard_agent):
    prompt = standard_agent.buildSystemPrompt()
    assert 'A test agent' in prompt


def test_build_system_prompt_without_instructions():
    agent = Agent({'name': 'No Instructions Agent', 'description': 'Agent without custom instructions'})
    prompt = agent.buildSystemPrompt()
    assert 'No Instructions Agent' in prompt


def test_build_system_prompt_manager_includes_capabilities(manager_agent):
    prompt = manager_agent.buildSystemPrompt()
    assert 'Agent Capabilities' in prompt
    assert 'delegate_to_agent' in prompt


# ---- Edge Cases ----

def test_empty_agent_name():
    agent = Agent({})
    assert agent.getName() == ''


def test_null_model():
    agent = Agent({'name': 'Test', 'model': None})
    assert agent.getModel() is None


def test_boolean_enabled_from_int():
    agent = Agent({'name': 'Test', 'enabled': 0})
    assert agent.isEnabled() is False

    agent = Agent({'name': 'Test', 'enabled': 1})
    assert agent.isEnabled() is True


def test_settings_merge():
    """PHP name is misleading — setSettings() replaces wholesale, it doesn't merge."""
    agent = Agent({'name': 'Test', 'settings': {'temperature': 0.7, 'max_tokens': 1000}})
    agent.setSettings({'temperature': 0.9, 'top_p': 0.95})
    settings = agent.getSettings()
    assert settings['temperature'] == 0.9
    assert settings['top_p'] == 0.95


def test_get_and_set_setting():
    agent = Agent({'name': 'Test'})
    assert agent.getSetting('missing') is None
    assert agent.getSetting('missing', 'fallback') == 'fallback'
    agent.setSetting('temperature', 0.5)
    assert agent.getSetting('temperature') == 0.5


def test_add_and_remove_tool():
    agent = Agent({'name': 'Test', 'tools': ['a']})
    agent.addTool('b')
    assert agent.getTools() == ['a', 'b']
    agent.addTool('a')  # no duplicate
    assert agent.getTools() == ['a', 'b']
    agent.removeTool('a')
    assert agent.getTools() == ['b']


# ================================================================
# Team
# ================================================================

def test_team_hydrate_full_row():
    team = Team({
        'id': 5, 'user_id': 10, 'workspace_id': 2, 'name': 'Research',
        'description': 'A team', 'created_at': '2026-01-01 00:00:00',
        'updated_at': '2026-01-02 00:00:00',
    })
    assert team.getId() == 5
    assert team.getUserId() == 10
    assert team.getWorkspaceId() == 2
    assert team.getName() == 'Research'
    assert team.getDescription() == 'A team'
    assert team.getCreatedAt() == '2026-01-01 00:00:00'
    assert team.getUpdatedAt() == '2026-01-02 00:00:00'


def test_team_hydrate_minimal_row_defaults():
    team = Team({'name': 'Solo'})
    assert team.getId() is None
    assert team.getUserId() == 0
    assert team.getWorkspaceId() is None
    assert team.getDescription() == ''
    assert team.getCreatedAt() is None
    assert team.getAgents() == []


def test_team_to_array_key_order():
    team = Team({'id': 1, 'name': 'X'})
    assert list(team.toArray().keys()) == [
        'id', 'user_id', 'workspace_id', 'name', 'description', 'created_at', 'updated_at',
    ]


def test_team_to_api_array_key_order():
    team = Team({'id': 1, 'name': 'X'})
    assert list(team.toApiArray().keys()) == ['id', 'name', 'description', 'created_at']


def test_team_to_array_with_agents_fallback():
    team = Team({'id': 1, 'name': 'X'})
    a1 = Agent({'id': 1, 'name': 'A1'})
    a2 = Agent({'id': 2, 'name': 'A2'})
    team.setAgents([a1, a2])
    data = team.toArrayWithAgents()
    assert [a['name'] for a in data['agents']] == ['A1', 'A2']
    assert 'instructions' in data['agents'][0]  # toApiArray (which does include it — see above)
    assert 'user_id' not in data['agents'][0]  # toApiArray, not toArray (toArray has user_id)


def test_team_to_array_with_pipeline_info():
    team = Team({'id': 1, 'name': 'X'})
    a1 = Agent({'id': 1, 'name': 'A1'})
    team.setAgentsWithPipelineInfo([
        {'agent': a1, 'pipeline_position': 0, 'pipeline_label': 'Step 1',
         'is_pipeline_head': True, 'is_pipeline_tail': False, 'can_reorder': True},
    ])
    data = team.toArrayWithAgents()
    assert data['agents'][0]['name'] == 'A1'
    assert data['agents'][0]['pipeline_position'] == 0
    assert data['agents'][0]['pipeline_label'] == 'Step 1'
    assert data['agents'][0]['is_pipeline_head'] is True
    assert data['agents'][0]['is_pipeline_tail'] is False
    assert data['agents'][0]['can_reorder'] is True
    # backwards-compatible plain agents array is also populated
    assert team.getAgents() == [a1]


# ================================================================
# Workflow
# ================================================================

def test_workflow_hydrate_full_row():
    wf = Workflow({
        'id': 1, 'user_id': 2, 'workspace_id': 3, 'name': 'WF', 'description': 'desc',
        'steps': '[{"id":"s1","type":"agent"}]',
        'triggers': '{"schedule":{"enabled":true}}',
        'variables': '{"x":"y"}',
        'enabled': True, 'created_at': 'c', 'updated_at': 'u',
        'output_storage_enabled': True, 'output_folder': '/out',
    })
    assert wf.getId() == 1
    assert wf.getSteps() == [{'id': 's1', 'type': 'agent'}]
    assert wf.getTriggers() == {'schedule': {'enabled': True}}
    assert wf.getVariables() == {'x': 'y'}
    assert wf.isOutputStorageEnabled() is True
    assert wf.getOutputFolder() == '/out'
    assert wf.isScheduleEnabled() is True


def test_workflow_hydrate_minimal_row_defaults():
    wf = Workflow({'name': 'Solo'})
    assert wf.getId() is None
    assert wf.getUserId() == 0
    assert wf.getSteps() == []
    assert wf.getTriggers() == []
    assert wf.getVariables() == []
    assert wf.isEnabled() is True
    assert wf.isOutputStorageEnabled() is False
    assert wf.getOutputFolder() is None
    assert wf.isScheduleEnabled() is False
    assert wf.getScheduleConfig() is None
    assert wf.hasGraph() is False


def test_workflow_to_array_key_order_no_graph():
    wf = Workflow({'name': 'X'})
    assert list(wf.toArray().keys()) == [
        'id', 'user_id', 'workspace_id', 'name', 'description', 'steps', 'triggers',
        'variables', 'enabled', 'created_at', 'updated_at', 'output_storage_enabled',
        'output_folder',
    ]


def test_workflow_to_array_includes_graph_when_set():
    wf = Workflow({'name': 'X'})
    wf.setGraph({'nodes': [{'id': 'n1'}], 'edges': []})
    array = wf.toArray()
    assert list(array.keys())[-1] == 'graph'
    assert array['graph'] == {'nodes': [{'id': 'n1'}], 'edges': []}


def test_workflow_to_api_array_key_order_and_computed_fields():
    wf = Workflow({'name': 'X'})
    keys = list(wf.toApiArray().keys())
    assert keys == [
        'id', 'name', 'description', 'steps', 'triggers', 'variables', 'enabled',
        'created_at', 'output_storage_enabled', 'output_folder', 'schedule_enabled',
        'runtime_mode',
    ]
    assert wf.toApiArray()['runtime_mode'] == 'batch'


def test_workflow_empty_json_fields_serialize_as_lists():
    wf = Workflow({'name': 'X'})
    array = wf.toArray()
    assert array['steps'] == []
    assert array['triggers'] == []
    assert array['variables'] == []


# ---- detectRuntimeMode / runtime_mode ----

def test_detect_runtime_mode_batch_no_graph():
    wf = Workflow({'name': 'X'})
    assert wf.toApiArray()['runtime_mode'] == 'batch'


def test_detect_runtime_mode_realtime_from_type_prefix():
    wf = Workflow({'name': 'X'})
    wf.setGraph({'nodes': [{'type': 'realtime-voice'}]})
    assert wf.toApiArray()['runtime_mode'] == 'realtime'


def test_detect_runtime_mode_realtime_from_node_type_field():
    wf = Workflow({'name': 'X'})
    wf.setGraph({'nodes': [{'node_type': 'realtime-chat'}]})
    assert wf.toApiArray()['runtime_mode'] == 'realtime'


def test_detect_runtime_mode_realtime_from_config_type():
    wf = Workflow({'name': 'X'})
    wf.setGraph({'nodes': [{'config': {'type': 'realtime-x'}}]})
    assert wf.toApiArray()['runtime_mode'] == 'realtime'


def test_detect_runtime_mode_realtime_from_config_runtime_mode():
    wf = Workflow({'name': 'X'})
    wf.setGraph({'nodes': [{'config': {'runtime_mode': 'realtime'}}]})
    assert wf.toApiArray()['runtime_mode'] == 'realtime'


def test_detect_runtime_mode_batch_with_nongraph_nodes():
    wf = Workflow({'name': 'X'})
    wf.setGraph({'nodes': [{'type': 'agent'}]})
    assert wf.toApiArray()['runtime_mode'] == 'batch'


def test_has_graph():
    wf = Workflow({'name': 'X'})
    assert wf.hasGraph() is False
    wf.setGraph({'nodes': []})
    assert wf.hasGraph() is False
    wf.setGraph({'nodes': [{'id': 'n1'}]})
    assert wf.hasGraph() is True


# ---- validateSteps ----

def test_validate_steps_empty():
    wf = Workflow({'name': 'X'})
    assert wf.validateSteps() == ['Workflow must have at least one step']


def test_validate_steps_missing_id():
    wf = Workflow({'name': 'X', 'steps': [{'type': 'agent'}]})
    errors = wf.validateSteps()
    assert "Step 0: missing 'id'" in errors


def test_validate_steps_missing_type():
    wf = Workflow({'name': 'X', 'steps': [{'id': 's1'}]})
    errors = wf.validateSteps()
    assert "Step 0: missing 'type'" in errors
    assert "Step 0: invalid type ''" in errors


def test_validate_steps_invalid_type():
    wf = Workflow({'name': 'X', 'steps': [{'id': 's1', 'type': 'bogus'}]})
    errors = wf.validateSteps()
    assert errors == ["Step 0: invalid type 'bogus'"]


def test_validate_steps_valid():
    wf = Workflow({'name': 'X', 'steps': [
        {'id': 's1', 'type': 'agent'}, {'id': 's2', 'type': 'condition'}, {'id': 's3', 'type': 'transform'},
    ]})
    assert wf.validateSteps() == []


def test_validate_steps_index_in_message_for_second_step():
    wf = Workflow({'name': 'X', 'steps': [{'id': 's1', 'type': 'agent'}, {'type': 'agent'}]})
    errors = wf.validateSteps()
    assert "Step 1: missing 'id'" in errors


# ---- getStep / getDependentSteps / getEntrySteps ----

def test_get_step_found_and_missing():
    wf = Workflow({'name': 'X', 'steps': [{'id': 's1', 'type': 'agent'}, {'id': 's2', 'type': 'agent'}]})
    assert wf.getStep('s2') == {'id': 's2', 'type': 'agent'}
    assert wf.getStep('nope') is None


def test_get_dependent_steps():
    wf = Workflow({'name': 'X', 'steps': [
        {'id': 's1', 'type': 'agent'},
        {'id': 's2', 'type': 'agent', 'depends_on': ['s1']},
        {'id': 's3', 'type': 'agent', 'depends_on': ['s1', 's2']},
    ]})
    dependents = wf.getDependentSteps('s1')
    assert [s['id'] for s in dependents] == ['s2', 's3']
    assert wf.getDependentSteps('s2') == [{'id': 's3', 'type': 'agent', 'depends_on': ['s1', 's2']}]


def test_get_entry_steps():
    wf = Workflow({'name': 'X', 'steps': [
        {'id': 's1', 'type': 'agent'},
        {'id': 's2', 'type': 'agent', 'depends_on': ['s1']},
        {'id': 's3', 'type': 'agent', 'depends_on': []},
    ]})
    entries = wf.getEntrySteps()
    assert [s['id'] for s in entries] == ['s1', 's3']


# ---- interpolateVariables ----

def test_interpolate_variables_from_workflow_variables():
    wf = Workflow({'name': 'X', 'variables': {'name': 'World'}})
    assert wf.interpolateVariables('Hello {{name}}!') == 'Hello World!'


def test_interpolate_variables_context_overrides_workflow_variables():
    wf = Workflow({'name': 'X', 'variables': {'name': 'World'}})
    assert wf.interpolateVariables('Hello {{name}}!', {'name': 'Context'}) == 'Hello Context!'


def test_interpolate_variables_unmatched_placeholder_kept_verbatim():
    wf = Workflow({'name': 'X', 'variables': {}})
    assert wf.interpolateVariables('Hi {{missing}}') == 'Hi {{missing}}'


def test_interpolate_variables_non_string_value_cast():
    wf = Workflow({'name': 'X', 'variables': {'count': 3}})
    assert wf.interpolateVariables('n={{count}}') == 'n=3'


def test_interpolate_variables_multiple_placeholders():
    wf = Workflow({'name': 'X', 'variables': {'a': '1', 'b': '2'}})
    assert wf.interpolateVariables('{{a}}-{{b}}-{{a}}') == '1-2-1'


# ================================================================
# WorkflowSchema
# ================================================================

def test_workflow_schema_hydrate_full_row():
    schema = WorkflowSchema({
        'id': 1, 'user_id': 2, 'name': 'my-schema', 'description': 'desc',
        'schema_json': '{"type":"object","properties":{"x":{"type":"string"}}}',
        'strict': False, 'created_at': 'c', 'updated_at': 'u',
    })
    assert schema.getId() == 1
    assert schema.getUserId() == 2
    assert schema.getName() == 'my-schema'
    assert schema.getSchemaJson() == {'type': 'object', 'properties': {'x': {'type': 'string'}}}
    assert schema.isStrict() is False


def test_workflow_schema_hydrate_minimal_row_defaults():
    schema = WorkflowSchema({'name': 'x'})
    assert schema.getId() is None
    assert schema.getUserId() == 0
    assert schema.getDescription() == ''
    assert schema.getSchemaJson() == []
    assert schema.isStrict() is True


def test_workflow_schema_to_array_key_order():
    schema = WorkflowSchema({'name': 'x'})
    assert list(schema.toArray().keys()) == [
        'id', 'user_id', 'name', 'description', 'schema_json', 'strict', 'created_at', 'updated_at',
    ]


def test_workflow_schema_to_api_array_key_order():
    schema = WorkflowSchema({'name': 'x'})
    assert list(schema.toApiArray().keys()) == [
        'id', 'name', 'description', 'schema_json', 'strict', 'created_at', 'updated_at',
    ]


def test_workflow_schema_to_output_schema():
    schema = WorkflowSchema({
        'name': 'my-schema', 'description': 'desc', 'strict': True,
        'schema_json': {'type': 'object', 'properties': {}},
    })
    assert schema.toOutputSchema() == {
        'name': 'my-schema', 'description': 'desc', 'strict': True,
        'schema': {'type': 'object', 'properties': {}},
    }


def test_workflow_schema_validate_empty_name_gives_both_errors():
    schema = WorkflowSchema({'name': ''})
    errors = schema.validate()
    assert 'Schema name is required' in errors
    assert 'Schema name must contain only letters, numbers, dashes and underscores' in errors


def test_workflow_schema_validate_bad_name_chars():
    schema = WorkflowSchema({'name': 'bad name!'})
    errors = schema.validate()
    assert 'Schema name must contain only letters, numbers, dashes and underscores' in errors
    assert 'Schema name is required' not in errors


def test_workflow_schema_validate_missing_schema_json():
    schema = WorkflowSchema({'name': 'ok-name'})
    assert schema.validate() == ['schema_json is required']


def test_workflow_schema_validate_wrong_top_level_type():
    schema = WorkflowSchema({'name': 'ok-name', 'schema_json': {'type': 'array', 'properties': {}}})
    errors = schema.validate()
    assert errors == ['Top-level schema type must be "object"']


def test_workflow_schema_validate_missing_properties():
    schema = WorkflowSchema({'name': 'ok-name', 'schema_json': {'type': 'object'}})
    errors = schema.validate()
    assert errors == ['Schema must have a "properties" object']


def test_workflow_schema_validate_valid():
    schema = WorkflowSchema({
        'name': 'ok-name',
        'schema_json': {'type': 'object', 'properties': {'x': {'type': 'string'}}},
    })
    assert schema.validate() == []
