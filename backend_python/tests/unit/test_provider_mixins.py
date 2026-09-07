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
    # PHP array_map('strval', ...) semantics: True -> '1', 1.0 -> '1' (not 'True'/'1.0')
    b = M.fixSchemaForGemini({'type': 'string', 'enum': [True, 1.0, 'x']})
    assert b == {'type': 'string', 'description': "Allowed values: 1, 1, x"}


def test_normalize_usage_list_shaped_behaves_like_empty_dict():
    """B2 -- a PHP-array decode of `{}` comes back `[]` (phpjson.php_array);
    normalizeUsage must treat that the same as an empty dict (PHP `?? 0`
    yields 0), not raise on `.get()`, for every provider branch."""
    M = ProviderRequestBuilderMixin
    assert M.normalizeUsage([], 'claude') == {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
    assert M.normalizeUsage([], 'anthropic') == {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
    assert M.normalizeUsage([], 'gemini') == {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
    assert M.normalizeUsage([], 'google') == {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
    assert M.normalizeUsage([], 'openai') == {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}
    assert M.normalizeUsage([], 'kimi') == {'prompt_tokens': 0, 'completion_tokens': 0, 'total_tokens': 0}


def test_client_side_tools():
    p = P()
    assert p.isClientSideTool('Task') and not p.isClientSideTool('webmcp_x')
    p.setPerRequestClientSideToolNames(['webmcp_x', '', 3])
    assert p.isClientSideTool('webmcp_x')
    marker = p.emitClientToolCallEvent([{'id': '1', 'name': 'Task', 'input': {}}], 'txt', {'assistant_reasoning': 'r'})
    assert p.sseClient.events[-1] == ('client_tool_call', {'assistant_reasoning': 'r', 'assistant_text': 'txt', 'tool_calls': [{'id': '1', 'name': 'Task', 'input': {}}]})
    assert marker == {'_pending_client_tool_call': True, '_pending_tool_calls': [{'id': '1', 'name': 'Task', 'input': {}}], '_pending_assistant_text': 'txt', '_pending_assistant_reasoning': 'r'}


def test_gemini_override_wins_over_the_trait_when_called_through_the_class():
    """PHP: `self::fixSchemaForGemini` inside a trait resolves to the using
    class, so GeminiProvider's override runs. Both must be classmethods
    recursing through `cls.` for that late binding to survive the port."""
    from app.providers.gemini_provider import GeminiProvider

    seen = []

    def marker(cls, schema):
        seen.append(schema)
        return {'type': 'MARKER'}

    orig = GeminiProvider.__dict__['fixSchemaForGemini']
    GeminiProvider.fixSchemaForGemini = classmethod(marker)
    try:
        out = GeminiProvider.convertToolsToGeminiFormat([{'name': 'a', 'input_schema': {'type': 'object'}}])
    finally:
        GeminiProvider.fixSchemaForGemini = orig
    assert out == [{'functionDeclarations': [{'name': 'a', 'description': '', 'parameters': {'type': 'MARKER'}}]}]
    assert seen == [{'type': 'object'}]


def test_gemini_build_http_request_routes_nested_enums_through_the_override():
    from app.providers.gemini_provider import GeminiProvider

    seen = []
    real = GeminiProvider.__dict__['fixSchemaForGemini'].__func__

    def spy(cls, schema):
        seen.append(cls)
        return real(cls, schema)

    orig = GeminiProvider.__dict__['fixSchemaForGemini']
    GeminiProvider.fixSchemaForGemini = classmethod(spy)
    try:
        r = GeminiProvider.buildHttpRequest(
            'gemini-2.5-flash', [{'role': 'user', 'content': 'hi'}],
            [{'name': 't', 'input_schema': {'type': 'object', 'properties': {'x': {'type': 'string', 'enum': [True, 1.0]}}}}],
            {'api_key': 'K'}, 50, 0.1)
    finally:
        GeminiProvider.fixSchemaForGemini = orig
    assert seen and all(c is GeminiProvider for c in seen)      # late binding: never the mixin
    props = r['payload']['tools'][0]['functionDeclarations'][0]['parameters']['properties']
    assert props['x']['description'] == 'Allowed values: 1, 1'
