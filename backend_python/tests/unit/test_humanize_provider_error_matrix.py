import httpx
import pytest
from app.controllers.chat_controller import ChatController
from app.exceptions import ProviderException

PROVIDERS = ['claude', 'openai', 'grok', 'kimi', 'deepseek', 'gemini', 'glm']


def _status_error(status: int, reason: str) -> str:
    req = httpx.Request('POST', 'https://h.example/v1/x')
    resp = httpx.Response(status, request=req, text=reason)
    try:
        resp.raise_for_status()
    except httpx.HTTPStatusError as e:
        return str(e)
    raise AssertionError('no error')


@pytest.mark.parametrize('provider', PROVIDERS)
def test_every_provider_lands_in_the_intended_humanized_branch(provider):
    h = ChatController.humanizeProviderError
    assert h(str(ProviderException.rateLimited(provider))).startswith('⏳ Rate limit reached')
    assert h(str(ProviderException.authenticationFailed(provider))).startswith('🔑 Authentication failed')
    assert h(str(ProviderException.apiError(provider, _status_error(503, 'Service Unavailable'), 503))).startswith('⏳ The model provider is temporarily overloaded')
    assert h(str(ProviderException.apiError(provider, _status_error(502, 'Bad Gateway'), 502))).startswith('⏳ The model provider is temporarily overloaded')
    assert h(str(ProviderException.apiError(provider, 'This model\'s maximum context length is 8192 tokens', 400))).startswith('📏')
    assert h(str(ProviderException.apiError(provider, 'insufficient_quota: billing hard limit reached', 402))).startswith('💳')
    assert h(str(ProviderException.apiError(provider, 'Connection refused', 0))).startswith('🌐')
    generic = h(str(ProviderException.apiError(provider, 'something odd happened', 500)))
    assert generic == f'{provider} API error: something odd happened'
