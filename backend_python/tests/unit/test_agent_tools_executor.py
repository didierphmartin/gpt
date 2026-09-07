"""Unit tests for app.agent_team.services.agent_tools_executor.AgentToolsExecutor
(port of AgentTeam/Services/AgentToolsExecutor.php, 205 lines).

No PHP oracle test exists for this class (confirmed via `find backend/tests
-iname '*AgentToolsExecutor*'` returning nothing), so these are written
directly from the PHP source: execution routing (delegation vs base,
including the "not configured" / "unknown tool" / handler-exception
branches — PHP 64-100), hasFunction/getRegisteredFunctions/getToolDefinitions
merge order (PHP 113-155), getDelegationToolDefinitions (160-176), and the
thin pass-throughs (registerFunction/isMCPTool/getBaseExecutor).
"""
from __future__ import annotations

from app.agent_team.services.agent_tools_executor import DELEGATION_TOOLS, AgentToolsExecutor


class FakeBaseExecutor:
    def __init__(self):
        self.calls = []
        self.functions = ['base_tool']
        self.tool_defs = [{'name': 'base_tool', 'description': 'b', 'input_schema': {'type': 'object'}}]
        self.registered = []

    def execute(self, name, params, context=None):
        self.calls.append((name, params, context))
        return {'result': f'base:{name}'}

    def hasFunction(self, name):
        return name in self.functions

    def getRegisteredFunctions(self):
        return list(self.functions)

    def getToolDefinitions(self):
        return list(self.tool_defs)

    def registerFunction(self, name, handler, schema):
        self.registered.append((name, handler, schema))

    def isMCPTool(self, name):
        return name == 'mcp_thing'


class BaseExecutorWithoutIsMCPTool:
    """No `isMCPTool` attribute at all -- exercises AgentToolsExecutor's
    `hasattr` guard (PHP `method_exists`, PHP 190-196)."""

    def execute(self, name, params, context=None):
        return {}

    def hasFunction(self, name):
        return False

    def getRegisteredFunctions(self):
        return []

    def getToolDefinitions(self):
        return []

    def registerFunction(self, name, handler, schema):
        pass


class FakeDelegationFunctions:
    def __init__(self, include_run_parallel=True, raise_on='run_agents_parallel'):
        self.calls = []
        self._include_run_parallel = include_run_parallel
        self._raise_on = raise_on

    def getAllFunctions(self):
        funcs = {
            'delegate_to_agent': {
                'handler': self._delegate,
                'schema': {'description': 'Delegate a task', 'input_schema': {'type': 'object'}},
            },
            'list_available_agents': {
                'handler': self._list,
                'schema': {'description': 'List agents', 'input_schema': {'type': 'object'}},
            },
        }
        if self._include_run_parallel:
            funcs['run_agents_parallel'] = {
                'handler': self._parallel,
                'schema': {'description': 'Run in parallel', 'input_schema': {'type': 'object'}},
            }
        return funcs

    def _delegate(self, params, context):
        self.calls.append(('delegate_to_agent', params, context))
        if self._raise_on == 'delegate_to_agent':
            raise RuntimeError('boom')
        return {'delegated': True}

    def _list(self, params, context):
        self.calls.append(('list_available_agents', params, context))
        return {'listed': True}

    def _parallel(self, params, context):
        self.calls.append(('run_agents_parallel', params, context))
        if self._raise_on == 'run_agents_parallel':
            raise RuntimeError('boom')
        return {'ran': True}


# ---------------------------------------------------------------------------
# execute() routing
# ---------------------------------------------------------------------------

def test_execute_routes_delegation_tool_to_delegation_functions_using_stored_context():
    base = FakeBaseExecutor()
    deleg = FakeDelegationFunctions(raise_on=None)
    ex = AgentToolsExecutor(base, deleg)
    ex.setExecutionContext({'user_id': 7, 'current_agent_id': 1})

    # `context` argument (call-site context) is IGNORED for delegation tools
    # -- the stored executionContext is used instead (PHP 84-96 "Uses stored
    # executionContext instead of passed context").
    result = ex.execute('delegate_to_agent', {'task': 'x'}, context={'user_id': 999})

    assert result == {'delegated': True}
    assert deleg.calls == [('delegate_to_agent', {'task': 'x'}, {'user_id': 7, 'current_agent_id': 1})]
    assert base.calls == []


def test_execute_falls_back_to_base_executor_for_non_delegation_tool():
    base = FakeBaseExecutor()
    deleg = FakeDelegationFunctions()
    ex = AgentToolsExecutor(base, deleg)

    result = ex.execute('base_tool', {'a': 1}, context='ctx-passthrough')

    assert result == {'result': 'base:base_tool'}
    assert base.calls == [('base_tool', {'a': 1}, 'ctx-passthrough')]
    assert deleg.calls == []


def test_execute_delegation_tool_without_delegation_functions_configured():
    base = FakeBaseExecutor()
    ex = AgentToolsExecutor(base, None)

    result = ex.execute('delegate_to_agent', {'task': 'x'})

    assert result == {'error': 'Delegation functions not configured'}


def test_execute_unknown_delegation_tool_name():
    # run_agents_parallel IS in DELEGATION_TOOLS (isDelegationTool -> True)
    # but the fake's getAllFunctions() omits it -- exercises PHP 88-90's
    # "Unknown delegation tool" branch.
    base = FakeBaseExecutor()
    deleg = FakeDelegationFunctions(include_run_parallel=False)
    ex = AgentToolsExecutor(base, deleg)

    result = ex.execute('run_agents_parallel', {})

    assert result == {'error': 'Unknown delegation tool: run_agents_parallel'}


def test_execute_delegation_handler_exception_is_caught():
    base = FakeBaseExecutor()
    deleg = FakeDelegationFunctions(raise_on='delegate_to_agent')
    ex = AgentToolsExecutor(base, deleg)

    result = ex.execute('delegate_to_agent', {'task': 'x'})

    assert result == {'error': 'Delegation tool error: boom'}


# ---------------------------------------------------------------------------
# isDelegationTool / hasFunction / getRegisteredFunctions
# ---------------------------------------------------------------------------

def test_is_delegation_tool():
    ex = AgentToolsExecutor(FakeBaseExecutor(), None)
    for name in DELEGATION_TOOLS:
        assert ex.isDelegationTool(name) is True
    assert ex.isDelegationTool('base_tool') is False
    assert DELEGATION_TOOLS == ('delegate_to_agent', 'list_available_agents', 'run_agents_parallel')


def test_has_function_delegation_true_only_when_configured():
    base = FakeBaseExecutor()
    ex_with = AgentToolsExecutor(base, FakeDelegationFunctions())
    ex_without = AgentToolsExecutor(base, None)

    assert ex_with.hasFunction('delegate_to_agent') is True
    assert ex_without.hasFunction('delegate_to_agent') is False
    # Base tools always fall through to the base executor regardless.
    assert ex_with.hasFunction('base_tool') is True
    assert ex_with.hasFunction('nope') is False


def test_get_registered_functions_merges_base_and_delegation_names():
    base = FakeBaseExecutor()
    ex = AgentToolsExecutor(base, FakeDelegationFunctions())
    assert ex.getRegisteredFunctions() == ['base_tool'] + list(DELEGATION_TOOLS)


def test_get_registered_functions_base_only_without_delegation():
    base = FakeBaseExecutor()
    ex = AgentToolsExecutor(base, None)
    assert ex.getRegisteredFunctions() == ['base_tool']


# ---------------------------------------------------------------------------
# getToolDefinitions / getDelegationToolDefinitions
# ---------------------------------------------------------------------------

def test_get_tool_definitions_appends_delegation_tools_after_base():
    base = FakeBaseExecutor()
    deleg = FakeDelegationFunctions()
    ex = AgentToolsExecutor(base, deleg)

    defs = ex.getToolDefinitions()

    assert defs[0] == {'name': 'base_tool', 'description': 'b', 'input_schema': {'type': 'object'}}
    names = [d['name'] for d in defs]
    assert names == ['base_tool', 'delegate_to_agent', 'list_available_agents', 'run_agents_parallel']
    deleg_entry = defs[1]
    assert deleg_entry == {
        'name': 'delegate_to_agent',
        'description': 'Delegate a task',
        'input_schema': {'type': 'object'},
    }


def test_get_tool_definitions_base_only_without_delegation():
    base = FakeBaseExecutor()
    ex = AgentToolsExecutor(base, None)
    assert ex.getToolDefinitions() == base.tool_defs


def test_get_delegation_tool_definitions_empty_without_delegation():
    ex = AgentToolsExecutor(FakeBaseExecutor(), None)
    assert ex.getDelegationToolDefinitions() == []


def test_get_delegation_tool_definitions_only_delegation_names():
    ex = AgentToolsExecutor(FakeBaseExecutor(), FakeDelegationFunctions())
    names = [d['name'] for d in ex.getDelegationToolDefinitions()]
    assert names == ['delegate_to_agent', 'list_available_agents', 'run_agents_parallel']


# ---------------------------------------------------------------------------
# registerFunction / isMCPTool / getBaseExecutor / execution context
# ---------------------------------------------------------------------------

def test_register_function_delegates_to_base_and_returns_self():
    base = FakeBaseExecutor()
    ex = AgentToolsExecutor(base, None)

    def handler(params, ctx=None):
        return {}

    result = ex.registerFunction('new_tool', handler, {'description': 'x', 'input_schema': {}})

    assert result is ex
    assert base.registered == [('new_tool', handler, {'description': 'x', 'input_schema': {}})]


def test_is_mcp_tool_delegates_to_base_when_present():
    base = FakeBaseExecutor()
    ex = AgentToolsExecutor(base, None)
    assert ex.isMCPTool('mcp_thing') is True
    assert ex.isMCPTool('base_tool') is False


def test_is_mcp_tool_false_when_base_has_no_such_method():
    ex = AgentToolsExecutor(BaseExecutorWithoutIsMCPTool(), None)
    assert ex.isMCPTool('anything') is False


def test_get_base_executor_returns_the_base():
    base = FakeBaseExecutor()
    ex = AgentToolsExecutor(base, None)
    assert ex.getBaseExecutor() is base


def test_execution_context_default_empty_and_settable():
    ex = AgentToolsExecutor(FakeBaseExecutor(), None)
    assert ex.getExecutionContext() == {}
    result = ex.setExecutionContext({'user_id': 3})
    assert result is ex
    assert ex.getExecutionContext() == {'user_id': 3}
