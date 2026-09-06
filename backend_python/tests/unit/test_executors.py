from app.services.tools_manager import ToolsManager
from app.services.combined_tools_executor import CombinedToolsExecutor
from app.services.filtered_tools_executor import FilteredToolsExecutor


class FakeLoader:
    def __init__(self): self.tools = {'mcp_x': {}}; self.calls = []
    def isMCPTool(self, n): return n in self.tools or ('mcp_' + n) in self.tools
    def executeTool(self, n, a): self.calls.append((n, a)); return {'result': 'ok'}
    def getTools(self): return self.tools
    def getToolDefinitions(self): return [{'name': 'mcp_x', 'description': '[MCP:s] x', 'input_schema': {'type': 'object', 'properties': {}}}]


def test_combined_routes_mcp_and_base():
    tm = ToolsManager(); tm.registerFunction('base', lambda p, c=None: {'b': 1}, {})
    ld = FakeLoader(); c = CombinedToolsExecutor(tm, ld)
    assert c.execute('mcp_x', {'q': 1}) == {'result': 'ok'} and ld.calls == [('mcp_x', {'q': 1})]
    assert c.execute('base', {}) == {'b': 1}
    assert c.hasFunction('mcp_x') and c.hasFunction('base') and c.isMCPTool('x') and not c.isMCPTool('base')
    assert c.getRegisteredFunctions() == ['base', 'mcp_x'] and [d['name'] for d in c.getToolDefinitions()] == ['base', 'mcp_x']
    assert c.getBaseExecutor() is tm and c.getMCPLoader() is ld


def test_filtered_only_filters_definitions():
    tm = ToolsManager()
    for n in ('a', 'b'): tm.registerFunction(n, lambda p, c=None: {}, {})
    f = FilteredToolsExecutor(tm)
    assert not f.isFiltering() and [d['name'] for d in f.getToolDefinitions()] == ['a', 'b']
    f.setAllowedTools(['b', 'zz'])
    assert f.isFiltering() and [d['name'] for d in f.getToolDefinitions()] == ['b'] and f.hasFunction('a')
    f.setAllowedTools([]); assert f.getToolDefinitions() == []
