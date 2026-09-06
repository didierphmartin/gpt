from app.config_.configuration import Configuration


def test_defaults_and_dot_get():
    c = Configuration({})
    assert c.get('claude.model') == 'claude-sonnet-4-5-20250929'
    assert c.get('claude.max_tokens') == 4000 and c.get('default_provider') == 'claude'
    assert c.get('missing.key', 'd') == 'd' and c.has('sse.enabled') and not c.has('nope')
    assert c.isProviderConfigured('claude') is False


def test_merge_is_recursive_for_dicts_and_overrides_scalars():
    c = Configuration({'claude': {'api_key': 'k'}, 'providers': {'kimi': {'base_url': 'u'}}, 'default_provider': 'kimi'})
    assert c.get('claude.api_key') == 'k' and c.get('claude.model') == 'claude-sonnet-4-5-20250929'
    assert c.get('providers.kimi.base_url') == 'u' and c.getDefaultProvider() == 'kimi'
    assert c.isProviderConfigured('claude') is True
    c.set('a.b.c', 1)
    assert c.get('a.b') == {'c': 1}
    assert c.toArray()['claude']['api_key'] == 'k'


def test_validate_provider_raises_php_message():
    import pytest
    from app.exceptions import ConfigurationException
    with pytest.raises(ConfigurationException, match="Provider 'openai' is not configured. Please set the API key."):
        Configuration({}).validateProvider('openai')
