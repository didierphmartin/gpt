import pytest
from app.exceptions import (AIAssistantException, ProviderException, FunctionExecutionException,
                            PricingUnavailableException, StreamingException, ConfigurationException)


def test_provider_exception_factories_match_php_messages():
    e = ProviderException.apiError('claude', 'boom | Response: {}', 502)
    assert str(e) == 'claude API error: boom | Response: {}' and e.getHttpStatusCode() == 502 and e.getProvider() == 'claude'
    assert str(ProviderException.rateLimited('kimi')) == 'Rate limited by kimi. '
    assert str(ProviderException.rateLimited('kimi', 30)) == 'Rate limited by kimi. Retry after 30 seconds.'
    a = ProviderException.authenticationFailed('openai')
    assert str(a) == 'Authentication failed for openai. Please check your API key.' and a.getHttpStatusCode() == 401
    assert isinstance(a, AIAssistantException) and isinstance(a, Exception)


def test_function_execution_factories():
    assert str(FunctionExecutionException.notFound('x')) == "Function 'x' is not registered."
    e = FunctionExecutionException.executionFailed('x', 'bad')
    assert str(e) == "Function 'x' execution failed: bad" and e.getFunctionName() == 'x' and e.code == 500
    assert str(FunctionExecutionException.invalidParameters('x', 'd')) == "Invalid parameters for function 'x': d"


def test_streaming_and_context():
    assert str(StreamingException.connectionFailed('r')) == 'SSE connection failed: r'
    e = AIAssistantException.withContext('m', {'k': 1}, 3)
    assert e.getContext() == {'k': 1} and e.code == 3
    assert issubclass(PricingUnavailableException, RuntimeError) and issubclass(ConfigurationException, AIAssistantException)
