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


def test_php_null_coalesce_in_getClaude_getOpenAI():
    """PHP ?? operator: None value substitutes default (not missing key, which merges with defaults)."""
    # Configuration always merges with defaults, so claude key always exists unless explicitly set to None
    # When config['claude'] is explicitly set to None, getClaude returns {}
    c = Configuration({'claude': None})
    assert c.getClaude() == {}  # None value → default {}

    # When config['openai'] is explicitly set to None, getOpenAI returns {}
    c = Configuration({'openai': None})
    assert c.getOpenAI() == {}  # None value → default {}

    # When key exists with value, returns the value
    c = Configuration({'claude': {'api_key': 'k'}})
    claude = c.getClaude()
    assert claude['api_key'] == 'k'  # merges with defaults, so has all default fields too
    assert claude['model'] == 'claude-sonnet-4-5-20250929'  # defaults preserved


def test_returned_dicts_are_deep_copies_not_mutable_references():
    """PHP arrays are value types: mutations don't affect Configuration."""
    c = Configuration({'claude': {'api_key': 'original', 'model': 'claude'}})

    # Mutate the dict returned by getClaude
    claude_config = c.getClaude()
    claude_config['api_key'] = 'mutated'
    claude_config['new_key'] = 'added'

    # Original should be unchanged
    assert c.get('claude.api_key') == 'original'
    assert c.get('claude.new_key') is None

    # toArray also returns a deep copy
    arr = c.toArray()
    arr['claude']['api_key'] = 'mutated_array'
    assert c.get('claude.api_key') == 'original'


def test_fromEnvironment_debug_flag_php_semantics():
    """PHP (bool) getenv('AI_DEBUG'): '0' and '' are false, any non-empty string is true."""
    import os

    # Test with "0" → false
    os.environ['AI_DEBUG'] = '0'
    c = Configuration.fromEnvironment()
    assert c.isDebugEnabled() is False

    # Test with empty string → false
    os.environ['AI_DEBUG'] = ''
    c = Configuration.fromEnvironment()
    assert c.isDebugEnabled() is False

    # Test with "1" → true
    os.environ['AI_DEBUG'] = '1'
    c = Configuration.fromEnvironment()
    assert c.isDebugEnabled() is True

    # Test with any non-empty string → true
    os.environ['AI_DEBUG'] = 'yes'
    c = Configuration.fromEnvironment()
    assert c.isDebugEnabled() is True

    # Clean up
    if 'AI_DEBUG' in os.environ:
        del os.environ['AI_DEBUG']


def test_fromFile_missing_path_raises():
    import pytest
    from app.exceptions import ConfigurationException
    with pytest.raises(ConfigurationException, match="Configuration file not found: /no/such/path.json"):
        Configuration.fromFile('/no/such/path.json')


def test_fromFile_non_object_json_raises(tmp_path):
    import json
    import pytest
    from app.exceptions import ConfigurationException
    p = tmp_path / 'list.json'
    p.write_text(json.dumps(['claude', 'openai']))
    with pytest.raises(ConfigurationException, match="Configuration file must return an array"):
        Configuration.fromFile(str(p))


def test_fromFile_object_json_loads_config(tmp_path):
    import json
    p = tmp_path / 'config.json'
    p.write_text(json.dumps({'claude': {'api_key': 'K'}}))
    c = Configuration.fromFile(str(p))
    assert c.get('claude.api_key') == 'K'
