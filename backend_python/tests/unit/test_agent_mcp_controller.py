"""Unit tests for AgentMCPController -- port of
backend/src/AgentTeam/Controllers/AgentMCPController.php (501 lines), the
MCP (Model Context Protocol) JSON-RPC endpoint mounted at
`POST /api/v1/mcp/agents`.

The repository is faked entirely (FakeAgentRepository below, same pattern as
tests/unit/test_agent_controller.py's) so this file exercises only the
controller's own JSON-RPC dispatch, validation, id-precedence, and response
shaping. `runner` (AgentRunner) is swapped for FakeAgentRunner for
`agents/run`/`tools/list`/`tools/call`.

PHP-truth strings pinned here:
  - "Invalid Request: missing jsonrpc 2.0"           (89)
  - "Method not found: {method}"                     (109)
  - "agent_id is required"                     (181, 205, 259, 283, 291*)
    (*agents/run's own agent_id-required check, PHP 296)
  - "Agent not found"                                (188, 305)
  - "Agent not found or access denied"                (211, 291)
  - "name is required"                                (203)
  - "input is required"                               (299)
  - "Agent is disabled"                               (309)
  - "Tool name is required"                           (391)
  - "Tool not found: {name}"                          (399)

JSON-RPC error codes (PHP jsonRpcError call sites):
  - -32600 invalid/missing jsonrpc version            (89)
  - -32601 every \\InvalidArgumentException            (105)
  - -32603 any other \\Exception                       (107)
"""
from __future__ import annotations

import pytest

from app.agent_team.controllers.agent_mcp_controller import AgentMCPController
from app.agent_team.models.agent import Agent

CFG = {'auth': {'jwt_secret': 'S'}, 'database': {}, 'contexts_database': {}}

AGENT_ROW = {
    'id': 5, 'user_id': 3, 'team_id': None, 'category': None, 'name': 'Alice',
    'description': 'desc', 'agent_type': 'standard', 'parent_agent_id': None,
    'can_delegate_to': '[]', 'display_order': 0, 'provider': 'claude', 'model': None,
    'instructions': 'be nice', 'tools': '[]', 'visibility': 'personal', 'enabled': 1,
    'settings': '[]', 'created_at': 'c', 'updated_at': 'u',
}


def agent(**overrides) -> Agent:
    return Agent({**AGENT_ROW, **overrides})


class FakeDb:
    """Constructor-time-only: AgentMCPController.__init__ fires the same
    `SHOW TABLES LIKE 'system_llm_settings'` probe AgentController's/
    WorkflowController's constructors do (LLMProviderResolver.
    applyDbSettings) -- answered here directly with an empty result."""

    def fetch_all(self, sql, params=None):
        return []

    def fetch_one(self, sql, params=None):
        return None


class FakeAgentRepository:
    def __init__(self):
        self.calls = []
        self.agents_by_id: dict = {}
        self.access: dict = {}
        self.owner: dict = {}
        self.accessible_agents: list = []
        self.create_result = None
        self.create_exception = None
        self.update_result = None
        self.delete_exception = None

    def _log(self, name, *args):
        self.calls.append((name, args))

    def findAccessibleByUser(self, user_id, filters):
        self._log('findAccessibleByUser', user_id, filters)
        return self.accessible_agents

    def canUserAccess(self, user_id, agent_id):
        self._log('canUserAccess', user_id, agent_id)
        return self.access.get(agent_id, False)

    def isOwner(self, user_id, agent_id):
        self._log('isOwner', user_id, agent_id)
        return self.owner.get(agent_id, False)

    def findById(self, agent_id):
        self._log('findById', agent_id)
        return self.agents_by_id.get(agent_id)

    def create(self, a):
        self._log('create', a)
        if self.create_exception:
            raise self.create_exception
        return self.create_result if self.create_result is not None else a

    def update(self, a):
        self._log('update', a)
        return self.update_result if self.update_result is not None else a

    def delete(self, agent_id):
        self._log('delete', agent_id)
        if self.delete_exception:
            raise self.delete_exception
        return True


class FakeToolsManager:
    def __init__(self):
        self.definitions: list = []
        self.functions: dict = {}
        self.execute_calls: list = []

    def getToolDefinitions(self):
        return self.definitions

    def hasFunction(self, name):
        return name in self.functions

    def execute(self, name, args, context=None):
        self.execute_calls.append((name, args, context))
        return self.functions[name](args, context)


class FakeMcpLoader:
    def __init__(self, definitions=None):
        self.definitions = definitions if definitions is not None else []

    def getToolDefinitions(self):
        return self.definitions


class FakeAgentRunner:
    def __init__(self):
        self.run_calls = []
        self.run_result = {'success': True, 'text': 'hi', 'execution_id': 9}
        self.tools_manager = FakeToolsManager()
        self.mcp_loader = FakeMcpLoader()

    def run(self, agent_, input_, conversation_history, user_id):
        self.run_calls.append((agent_, input_, conversation_history, user_id))
        return dict(self.run_result)

    def getToolsManager(self):
        return self.tools_manager

    def getMCPToolsLoader(self):
        return self.mcp_loader


def controller(monkeypatch, repo=None):
    repo = repo if repo is not None else FakeAgentRepository()
    monkeypatch.setattr('app.agent_team.controllers.agent_mcp_controller.AgentRepository', lambda db: repo)
    c = AgentMCPController(FakeDb(), CFG)
    fake_runner = FakeAgentRunner()
    c.runner = fake_runner
    return c, repo, fake_runner


def rpc(method, params=None, id_=1, jsonrpc='2.0'):
    body = {'jsonrpc': jsonrpc, 'id': id_, 'method': method}
    if params is not None:
        body['params'] = params
    return {'user_id': 3, 'body': body}


# ============================================================================
# handle() -- envelope / dispatch
# ============================================================================

def test_missing_jsonrpc_key_returns_dash32600(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle({'user_id': 3, 'body': {'id': 1, 'method': 'ping'}})
    assert r == {'jsonrpc': '2.0', 'id': None,
                 'error': {'code': -32600, 'message': 'Invalid Request: missing jsonrpc 2.0'}}


def test_wrong_jsonrpc_version_returns_dash32600(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('ping', jsonrpc='1.0'))
    assert r['error'] == {'code': -32600, 'message': 'Invalid Request: missing jsonrpc 2.0'}


def test_unknown_method_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/frobnicate', id_=42))
    assert r == {'jsonrpc': '2.0', 'id': 42,
                 'error': {'code': -32601, 'message': 'Method not found: agents/frobnicate'}}


def test_ping_returns_pong(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('ping', id_='abc'))
    assert r == {'jsonrpc': '2.0', 'id': 'abc', 'result': {'pong': True}}


def test_unexpected_exception_returns_dash32603(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.access[5] = True

    def boom(agent_id):
        raise RuntimeError('db exploded')

    repo.findById = boom
    r = c.handle(rpc('agents/get', {'id': 5}))
    assert r == {'jsonrpc': '2.0', 'id': 1, 'error': {'code': -32603, 'message': 'db exploded'}}


# ============================================================================
# initialize
# ============================================================================

def test_initialize_returns_protocol_and_capabilities(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('initialize', {}))
    assert r == {
        'jsonrpc': '2.0', 'id': 1,
        'result': {
            'protocolVersion': '2024-11-05',
            'capabilities': {
                'tools': {'listChanged': True},
                'resources': {'subscribe': True, 'listChanged': True},
                'prompts': {'listChanged': True},
            },
            'serverInfo': {'name': 'AgentTeam', 'version': '1.0.0'},
        },
    }


# ============================================================================
# agents/list
# ============================================================================

def test_agents_list_defaults_limit_100_and_drops_null_filters(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.accessible_agents = [agent()]
    r = c.handle(rpc('agents/list', {}))
    assert repo.calls[0] == ('findAccessibleByUser', (3, {'limit': 100}))
    assert r['result']['count'] == 1
    assert r['result']['agents'] == [{
        'id': 5, 'name': 'Alice', 'description': 'desc', 'type': 'standard',
        'provider': 'claude', 'model': None, 'visibility': 'personal', 'tools': [],
    }]


def test_agents_list_maps_type_provider_limit_filters(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/list', {'type': 'manager', 'provider': 'openai', 'limit': 5}))
    assert repo.calls[0] == ('findAccessibleByUser', (3, {'agent_type': 'manager', 'provider': 'openai', 'limit': 5}))
    assert r['result']['count'] == 0


# ============================================================================
# agents/get
# ============================================================================

def test_agents_get_missing_id_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/get', {}))
    assert r['error'] == {'code': -32601, 'message': 'agent_id is required'}


def test_agents_get_id_takes_precedence_over_agent_id(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    r = c.handle(rpc('agents/get', {'id': 5, 'agent_id': 999}))
    assert r['result']['agent']['id'] == 5


def test_agents_get_falls_back_to_agent_id(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.access[7] = True
    repo.agents_by_id[7] = agent(id=7)
    r = c.handle(rpc('agents/get', {'agent_id': 7}))
    assert r['result']['agent']['id'] == 7


def test_agents_get_not_accessible_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/get', {'id': 5}))
    assert r['error'] == {'code': -32601, 'message': 'Agent not found'}


def test_agents_get_success_returns_toArray(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    r = c.handle(rpc('agents/get', {'id': 5}))
    assert r['result'] == {'agent': agent().toArray()}


# ============================================================================
# agents/create
# ============================================================================

def test_agents_create_missing_name_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/create', {}))
    assert r['error'] == {'code': -32601, 'message': 'name is required'}


def test_agents_create_success_uses_defaults(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/create', {'name': 'Bob'}))
    created_agent = repo.calls[-1][1][0]
    assert created_agent.getUserId() == 3
    assert created_agent.getName() == 'Bob'
    assert created_agent.getDescription() == ''
    assert created_agent.getAgentType() == 'standard'
    assert created_agent.getProvider() == 'claude'
    assert created_agent.getInstructions() == ''
    assert created_agent.getTools() == []
    assert created_agent.getCanDelegateTo() == []
    assert created_agent.getVisibility() == 'personal'
    assert r['result']['message'] == 'Agent created successfully'
    assert r['result']['agent']['name'] == 'Bob'


def test_agents_create_passes_explicit_fields(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    c.handle(rpc('agents/create', {
        'name': 'Carl', 'description': 'd', 'agent_type': 'manager', 'provider': 'openai',
        'model': 'gpt-5', 'instructions': 'go', 'tools': ['t1'], 'can_delegate_to': [1, 2],
        'visibility': 'workspace', 'settings': {'k': 'v'},
    }))
    created_agent = repo.calls[-1][1][0]
    assert created_agent.getAgentType() == 'manager'
    assert created_agent.getProvider() == 'openai'
    assert created_agent.getModel() == 'gpt-5'
    assert created_agent.getInstructions() == 'go'
    assert created_agent.getTools() == ['t1']
    assert created_agent.getCanDelegateTo() == [1, 2]
    assert created_agent.getVisibility() == 'workspace'


# ============================================================================
# agents/update
# ============================================================================

def test_agents_update_missing_id_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/update', {}))
    assert r['error'] == {'code': -32601, 'message': 'agent_id is required'}


def test_agents_update_not_owner_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/update', {'id': 5}))
    assert r['error'] == {'code': -32601, 'message': 'Agent not found or access denied'}


def test_agents_update_applies_only_present_fields(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent()
    r = c.handle(rpc('agents/update', {'id': 5, 'name': 'Renamed'}))
    updated = repo.calls[-1][1][0]
    assert updated.getName() == 'Renamed'
    assert updated.getDescription() == 'desc'  # untouched
    assert r['result']['message'] == 'Agent updated successfully'


def test_agents_update_explicit_null_is_not_applied(monkeypatch):
    """isset() is false for an explicit JSON null -- field left untouched."""
    c, repo, _ = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent()
    c.handle(rpc('agents/update', {'id': 5, 'name': None}))
    updated = repo.calls[-1][1][0]
    assert updated.getName() == 'Alice'  # unchanged


def test_agents_update_enabled_and_settings(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.owner[5] = True
    repo.agents_by_id[5] = agent()
    c.handle(rpc('agents/update', {'id': 5, 'enabled': False, 'settings': {'x': 1}}))
    updated = repo.calls[-1][1][0]
    assert updated.isEnabled() is False
    assert updated.getSettings() == {'x': 1}


# ============================================================================
# agents/delete
# ============================================================================

def test_agents_delete_missing_id_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/delete', {}))
    assert r['error'] == {'code': -32601, 'message': 'agent_id is required'}


def test_agents_delete_not_owner_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/delete', {'id': 5}))
    assert r['error'] == {'code': -32601, 'message': 'Agent not found or access denied'}


def test_agents_delete_success(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.owner[5] = True
    r = c.handle(rpc('agents/delete', {'id': 5}))
    assert ('delete', (5,)) in repo.calls
    assert r['result'] == {'deleted': True, 'message': 'Agent deleted successfully'}


# ============================================================================
# agents/run -- note the REVERSED `agent_id ?? id` precedence vs get/
# update/delete's `id ?? agent_id` above (PHP 282 vs 178/232/276).
# ============================================================================

def test_agents_run_agent_id_takes_precedence_over_id(monkeypatch):
    c, repo, runner = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    r = c.handle(rpc('agents/run', {'agent_id': 5, 'id': 999, 'input': 'hi'}))
    assert runner.run_calls[0][0].getId() == 5
    assert r['result']['agent']['id'] == 5


def test_agents_run_missing_agent_id_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/run', {'input': 'hi'}))
    assert r['error'] == {'code': -32601, 'message': 'agent_id is required'}


def test_agents_run_missing_input_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/run', {'agent_id': 5, 'input': '   '}))
    assert r['error'] == {'code': -32601, 'message': 'input is required'}


def test_agents_run_message_key_used_when_input_absent(monkeypatch):
    c, repo, runner = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    c.handle(rpc('agents/run', {'agent_id': 5, 'message': 'from-message'}))
    assert runner.run_calls[0][1] == 'from-message'


def test_agents_run_not_accessible_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('agents/run', {'agent_id': 5, 'input': 'hi'}))
    assert r['error'] == {'code': -32601, 'message': 'Agent not found'}


def test_agents_run_disabled_returns_dash32601(monkeypatch):
    c, repo, _ = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent(enabled=0)
    r = c.handle(rpc('agents/run', {'agent_id': 5, 'input': 'hi'}))
    assert r['error'] == {'code': -32601, 'message': 'Agent is disabled'}


def test_agents_run_success_shapes_response(monkeypatch):
    c, repo, runner = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    runner.run_result = {
        'text': 'hello', 'success': True, 'usage': {'tokens': 10},
        'tools_used': ['t1'], 'execution_id': 42,
    }
    r = c.handle(rpc('agents/run', {'agent_id': 5, 'input': 'hi', 'conversation_history': [{'role': 'user'}]}))
    assert r['result'] == {
        'response': {
            'text': 'hello', 'success': True, 'error': None, 'usage': {'tokens': 10},
            'tools_used': ['t1'], 'execution_id': 42,
        },
        'agent': {'id': 5, 'name': 'Alice'},
    }
    assert runner.run_calls[0] == (repo.agents_by_id[5], 'hi', [{'role': 'user'}], 3)


def test_agents_run_defaults_missing_result_fields(monkeypatch):
    c, repo, runner = controller(monkeypatch)
    repo.access[5] = True
    repo.agents_by_id[5] = agent()
    runner.run_result = {}
    r = c.handle(rpc('agents/run', {'agent_id': 5, 'input': 'hi'}))
    assert r['result']['response'] == {
        'text': '', 'success': False, 'error': None, 'usage': [], 'tools_used': [], 'execution_id': None,
    }


# ============================================================================
# tools/list
# ============================================================================

def test_tools_list_combines_builtin_mcp_and_delegation(monkeypatch):
    c, _, runner = controller(monkeypatch)
    runner.tools_manager.definitions = [
        {'name': 'search', 'description': 'Search the web', 'input_schema': {'type': 'object'}},
    ]
    runner.mcp_loader.definitions = [{'name': 'mcp_tool'}]
    r = c.handle(rpc('tools/list', {}))
    names = [t['name'] for t in r['result']['tools']]
    assert names == ['search', 'mcp_tool', 'delegate_to_agent', 'list_available_agents', 'run_agents_parallel']
    assert r['result']['count'] == 5
    builtin = r['result']['tools'][0]
    assert builtin == {
        'name': 'search', 'description': 'Search the web', 'inputSchema': {'type': 'object'}, 'type': 'builtin',
    }
    mcp_tool = r['result']['tools'][1]
    # Missing input_schema -> PHP's `?? []`, which json_encodes as `[]`, not
    # `{}` -- php_array() reproduces that (PHP-truth pinned live, see
    # test_mcp_agents_tools_list_parity in the differential suite).
    assert mcp_tool == {'name': 'mcp_tool', 'description': '', 'inputSchema': [], 'type': 'mcp'}
    list_agents_tool = next(t for t in r['result']['tools'] if t['name'] == 'list_available_agents')
    assert list_agents_tool['inputSchema'] == {'type': 'object', 'properties': []}


def test_tools_list_no_mcp_loader_skips_mcp_tools(monkeypatch):
    c, _, runner = controller(monkeypatch)
    runner.mcp_loader = None
    r = c.handle(rpc('tools/list', {}))
    names = [t['name'] for t in r['result']['tools']]
    assert 'mcp_tool' not in names
    assert r['result']['count'] == 3  # delegation tools only


# ============================================================================
# tools/call
# ============================================================================

def test_tools_call_missing_name_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('tools/call', {}))
    assert r['error'] == {'code': -32601, 'message': 'Tool name is required'}


def test_tools_call_unknown_tool_returns_dash32601(monkeypatch):
    c, _, _ = controller(monkeypatch)
    r = c.handle(rpc('tools/call', {'name': 'ghost'}))
    assert r['error'] == {'code': -32601, 'message': 'Tool not found: ghost'}


def test_tools_call_success_dict_result_pretty_printed(monkeypatch):
    c, _, runner = controller(monkeypatch)
    runner.tools_manager.functions['echo'] = lambda args, ctx: {'echoed': args}
    r = c.handle(rpc('tools/call', {'name': 'echo', 'arguments': {'a': 1}}))
    assert r['result']['isError'] is False
    content = r['result']['content']
    assert content[0]['type'] == 'text'
    assert '"echoed"' in content[0]['text']
    assert '\n' in content[0]['text']  # pretty-printed (indent=4)
    # execute() is called with userId as the third positional arg (PHP:
    # $toolsManager->execute($toolName, $arguments, $userId)).
    assert runner.tools_manager.execute_calls[0] == ('echo', {'a': 1}, 3)


def test_tools_call_error_result_sets_isError(monkeypatch):
    c, _, runner = controller(monkeypatch)
    runner.tools_manager.functions['fail'] = lambda args, ctx: {'error': 'nope'}
    r = c.handle(rpc('tools/call', {'name': 'fail'}))
    assert r['result']['isError'] is True
