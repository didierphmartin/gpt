from app.providers.traits.provider_request_builder import ProviderRequestBuilderMixin
from app.providers.traits.client_side_tools import ClientSideToolsMixin


class Rec:
    def __init__(self): self.events = []
    def sendCustomEvent(self, n, d): self.events.append((n, d))


class P(ProviderRequestBuilderMixin, ClientSideToolsMixin):
    def __init__(self): self.sseClient = Rec(); self.model = 'm'; self.maxTokens = 10; self._init_client_side_tools()
    def getName(self): return 'claude'
    def getContextWindow(self): return 100
    def getDefaultSystemPrompt(self): return '  default'


def test_build_system_prompt_and_warnings():
    p = P()
    s = p.buildSystemPrompt({'memory_context': 'M', 'skill_content': 'S'})
    assert s.startswith('Current date: ') and s.endswith('default\n\nM\n\nS') and '(' in s.split('\n')[0]
    assert p.buildSystemPrompt({'system_prompt': ' X '}).endswith('\n\nX ')
    p.emitUsageWarningIfTruncated('max_tokens', 5); p.emitUsageWarningIfTruncated('stop', 5); p.emitUsageWarningIfTruncated('length', 0)
    p.emitContextWarningIfHigh(80); p.emitContextWarningIfHigh(10)
    assert p.sseClient.events == [('usage_warning', {'reason': 'output_truncated', 'provider': 'claude', 'model': 'm', 'max_tokens': 10, 'output_tokens': 5}),
                                  ('usage_warning', {'reason': 'context_high', 'provider': 'claude', 'model': 'm', 'input_tokens': 80, 'context_window': 100, 'percent': 80})]


def test_static_converters():
    M = ProviderRequestBuilderMixin
    assert M.convertEmptyArraysToObjects({'a': [], 'b': {'c': []}}) == {'a': {}, 'b': {'c': {}}}
    assert M.convertEmptyArraysToObjectsForClaude({'properties': [], 'required': []}) == {'properties': {}, 'required': []}
    assert M.normalizeUsage({'input_tokens': 1, 'output_tokens': 2}, 'claude') == {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}
    assert M.normalizeUsage({'promptTokenCount': 1, 'candidatesTokenCount': 2, 'totalTokenCount': 3}, 'gemini') == {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}
    assert M.normalizeUsage({'prompt_tokens': 1, 'completion_tokens': 2}, 'kimi') == {'prompt_tokens': 1, 'completion_tokens': 2, 'total_tokens': 3}
    assert M.normalizeUsage(None, 'x') is None
    assert M.convertToolsToOpenAIFormat([{'name': 'a', 'input_schema': {'type': 'object'}}]) == [{'type': 'function', 'function': {'name': 'a', 'description': '', 'parameters': {'type': 'object'}}}]
    g = M.fixSchemaForGemini({'type': 'object', 'properties': {'x': {'type': 'string', 'enum': ['a', 'b'], 'format': 'x'}}, 'required': [], 'additionalProperties': False})
    assert g == {'type': 'object', 'properties': {'x': {'type': 'string', 'description': 'Allowed values: a, b'}}}
    assert M.fixSchemaForGemini({}) == {'type': 'string'} and M.fixSchemaForGemini({'type': 'array'}) == {'type': 'array', 'items': {'type': 'string'}}
    assert M.convertToolsToGeminiFormat([{'name': 'a', 'input_schema': {}}]) == [{'functionDeclarations': [{'name': 'a', 'description': '', 'parameters': {'type': 'string'}}]}]


def test_client_side_tools():
    p = P()
    assert p.isClientSideTool('Task') and not p.isClientSideTool('webmcp_x')
    p.setPerRequestClientSideToolNames(['webmcp_x', '', 3])
    assert p.isClientSideTool('webmcp_x')
    marker = p.emitClientToolCallEvent([{'id': '1', 'name': 'Task', 'input': {}}], 'txt', {'assistant_reasoning': 'r'})
    assert p.sseClient.events[-1] == ('client_tool_call', {'assistant_reasoning': 'r', 'assistant_text': 'txt', 'tool_calls': [{'id': '1', 'name': 'Task', 'input': {}}]})
    assert marker == {'_pending_client_tool_call': True, '_pending_tool_calls': [{'id': '1', 'name': 'Task', 'input': {}}], '_pending_assistant_text': 'txt', '_pending_assistant_reasoning': 'r'}
