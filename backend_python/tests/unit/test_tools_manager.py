import pytest
from app.services.tools_manager import ToolsManager
from app.exceptions import FunctionExecutionException


def test_register_execute_and_definitions():
    tm = ToolsManager()
    tm.registerFunction('echo', lambda p, ctx=None: {'got': p, 'ctx': ctx}, {'description': 'Echo', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': ['x']}})
    tm.registerFunction('scalar', lambda p, ctx=None: 42, {})
    assert tm.execute('echo', {'x': 1}, 'u3') == {'got': {'x': 1}, 'ctx': 'u3'}
    assert tm.execute('scalar', {}) == {'result': 42}
    assert tm.getRegisteredFunctions() == ['echo', 'scalar'] and tm.hasFunction('echo') and not tm.isMCPTool('echo')
    defs = tm.getToolDefinitions()
    assert defs[0] == {'name': 'echo', 'description': 'Echo', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string'}}, 'required': ['x']}}
    assert defs[1] == {'name': 'scalar', 'description': 'Execute scalar', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}}
    assert tm.getToolDefinitions() is defs                       # cached until registration changes
    tm.removeFunction('scalar')
    assert [d['name'] for d in tm.getToolDefinitions()] == ['echo']


def test_execute_errors_map_to_php_exceptions():
    tm = ToolsManager()
    with pytest.raises(FunctionExecutionException, match="Function 'nope' is not registered."):
        tm.execute('nope', {})
    tm.registerFunction('bad', lambda p, c=None: 1 / 0, {})
    with pytest.raises(FunctionExecutionException, match="Function 'bad' execution failed: division by zero"):
        tm.execute('bad', {})


def test_register_functions_bulk_and_load_json(tmp_path):
    tm = ToolsManager()
    tm.registerFunctions({'a': {'handler': lambda p, c=None: {}, 'schema': {'description': 'A'}}})
    assert tm.getSchema('a') == {'description': 'A'}
    p = tmp_path / 't.json'; p.write_text('[{"name":"j","description":"J"}]')
    tm.loadFromJson(str(p))
    assert tm.getSchema('j') == {'description': 'J', 'input_schema': {'type': 'object', 'properties': {}, 'required': []}}
