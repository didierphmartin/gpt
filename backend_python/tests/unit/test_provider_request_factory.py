import pytest
from app.providers.provider_request_factory import ProviderRequestFactory as F
from app.providers.claude_provider import ClaudeProvider
from app.providers.openai_provider import OpenAIProvider
from app.providers.gemini_provider import GeminiProvider
from app.providers.grok_provider import GrokProvider
from app.providers.kimi_provider import KimiProvider
from app.providers.deepseek_provider import DeepSeekProvider
from app.providers.custom_provider import CustomProvider

MSGS = [{'role': 'user', 'content': 'hi'}]


def test_registry_names_and_families():
    assert F.getSupportedProviders() == ['claude', 'anthropic', 'gemini', 'google', 'openai', 'deepseek', 'grok', 'kimi', 'gamma4', 'glm']
    assert F.isSupported('Claude') and F.isSupported('GLM') and not F.isSupported('nope')
    assert [F.getApiFamily(n) for n in ('anthropic', 'google', 'openai', 'deepseek', 'grok', 'kimi', 'gamma4', 'nope')] == ['claude', 'gemini', 'openai', 'openai', 'openai', 'openai', 'openai', 'openai']


@pytest.mark.parametrize('name,cls,cfg', [
    ('anthropic', ClaudeProvider, {'api_key': 'K'}),
    ('google', GeminiProvider, {'api_key': 'K'}),
    ('openai', OpenAIProvider, {'api_key': 'K'}),
    ('grok', GrokProvider, {'api_key': 'K'}),
    ('kimi', KimiProvider, {'api_key': 'K'}),
    ('deepseek', DeepSeekProvider, {'api_key': 'K'}),
    ('glm', CustomProvider, {'api_key': 'K', 'base_url': 'https://h.example', 'chat_endpoint': '/c'}),
])
def test_build_and_parse_delegate_to_the_class(name, cls, cfg):
    assert F.buildRequest(name, 'm', MSGS, [], cfg, 50, 0.1) == cls.buildHttpRequest('m', MSGS, [], cfg, 50, 0.1)
    decoded = {'choices': [{'message': {'content': 'yo'}}], 'usage': {}, 'content': [{'type': 'text', 'text': 'yo'}], 'candidates': [{'content': {'parts': [{'text': 'yo'}]}}]}
    assert F.parseResponse(name, decoded) == cls.parseHttpResponse(decoded)


def test_unknown_provider_falls_back_to_openai_format():
    cfg = {'api_key': 'K'}
    assert F.buildRequest('mystery', 'm', MSGS, [], cfg, 50, 0.1) == OpenAIProvider.buildHttpRequest('m', MSGS, [], cfg, 50, 0.1)
    assert F.parseResponse('mystery', {'choices': [{'message': {'content': 'yo'}}], 'usage': {}})['text'] == 'yo'


def test_register_provider_and_non_builder_guard():
    class NotABuilder: pass
    F.registerProvider('Weird', NotABuilder)
    try:
        assert F.isSupported('weird')
        assert F.buildRequest('weird', 'm', MSGS, [], {}, 1, 0.0) is None
        assert F.parseResponse('weird', {}) == {'text': '', 'tool_calls': [], 'usage': None}
        assert F.getApiFamily('weird') == 'openai'
    finally:
        F._providerClasses.pop('weird', None)
