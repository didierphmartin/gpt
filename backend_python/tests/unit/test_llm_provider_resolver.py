from app.services.llm_provider_resolver import LLMProviderResolver


def test_build_provider_from_db_casts_and_skips_empties():
    row = {'display_name': 'Kimi', 'model': 'kimi-k2.6', 'api_key': '', 'base_url': 'https://api.moonshot.ai', 'chat_endpoint': None,
           'api_format': 'openai', 'max_tokens': '32768', 'temperature': '0.60', 'system_prompt': '', 'streaming': 1,
           'supports_tools': '0', 'supported_models': '["a","b"]'}
    assert LLMProviderResolver.buildProviderFromDb(row) == {
        'display_name': 'Kimi', 'model': 'kimi-k2.6', 'base_url': 'https://api.moonshot.ai', 'api_format': 'openai',
        'max_tokens': 32768, 'temperature': 0.6, 'streaming': True, 'supports_tools': False, 'supported_models': ['a', 'b']}


def test_apply_db_settings_merges_root_and_custom_providers():
    class Db:
        def fetch_all(self, sql, p=None):
            if 'SHOW TABLES' in sql: return [{'Tables_in_x': 'system_llm_settings'}]
            return [{'provider_key': 'claude', 'model': 'c-1', 'api_key': 'K'}, {'provider_key': 'kimi', 'base_url': 'u', 'model': 'k'}]
    cfg = LLMProviderResolver.applyDbSettings(Db(), {'claude': {'api_key': '', 'model': 'old'}})
    assert cfg['claude'] == {'api_key': 'K', 'model': 'c-1'} and cfg['providers']['kimi'] == {'model': 'k', 'base_url': 'u'}


def test_apply_db_settings_returns_config_when_table_missing_or_error():
    class NoTable:
        def fetch_all(self, sql, p=None): return []
    assert LLMProviderResolver.applyDbSettings(NoTable(), {'a': 1}) == {'a': 1}
    class Boom:
        def fetch_all(self, sql, p=None): raise RuntimeError('x')
    assert LLMProviderResolver.applyDbSettings(Boom(), {'a': 1}) == {'a': 1}
