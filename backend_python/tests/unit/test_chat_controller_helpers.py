import base64, hashlib, os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
from app.controllers.chat_controller import ChatController
from app.controllers.chat_sse_clients import VerificationSseClient, ComparisonSseClient


def test_snapshot_lists_what_was_sent():
    options = {'system_prompt': 'You are a dispatcher.', 'client_tools': [{'name': 'route_to', 'description': 'Route it', 'input_schema': {'type': 'object'}}], 'max_tokens': 4096, 'temperature': 0.7}
    server_tools = [{'name': 'mcp_lookup_users', 'description': 'Look up', 'input_schema': []}]
    history = [{'role': 'user', 'content': 'earlier'}, {'role': 'assistant', 'content': 'ok'}]
    snap = ChatController.buildLlmContextSnapshot('claude', 'claude-sonnet-4-5', options, server_tools, history, 'refund please')
    assert snap['provider'] == 'claude' and snap['model'] == 'claude-sonnet-4-5' and snap['system_prompt'] == 'You are a dispatcher.'
    assert snap['max_tokens'] == 4096 and snap['temperature'] == 0.7
    assert [m['role'] for m in snap['messages']] == ['user', 'assistant', 'user'] and snap['messages'][-1]['content'] == 'refund please'
    assert snap['tools'] == [{'name': 'mcp_lookup_users', 'description': 'Look up', 'source': 'server'}, {'name': 'route_to', 'description': 'Route it', 'source': 'client'}]
    assert snap['estimated_tokens'] > 0 and snap['memory_included'] is False
    assert list(snap) == ['provider', 'model', 'max_tokens', 'temperature', 'system_prompt', 'memory_included', 'memory_context', 'skill_included', 'skill_content', 'messages', 'tools', 'estimated_tokens']


def test_memory_and_skill_flags_are_reported():
    snap = ChatController.buildLlmContextSnapshot('openai', None, {'memory_context': 'likes tea', 'skill_content': '# Skill'}, [], [], 'hi')
    assert snap['memory_included'] is True and snap['memory_context'] == 'likes tea' and snap['skill_included'] is True and snap['skill_content'] == '# Skill'
    assert snap['tools'] == [] and snap['model'] is None


def test_humanize_provider_error_classes():
    h = ChatController.humanizeProviderError
    assert h('GET https://x?api_key=SECRET failed 503 Service Unavailable').startswith('⏳ The model provider is temporarily overloaded')
    assert h('no available server for model').startswith("🚫 This model's server is currently offline")
    assert h('HTTP 429 rate limit').startswith('⏳ Rate limit reached')
    assert h('401 invalid api key').startswith('🔑 Authentication failed')
    assert h('prompt is too long: context window exceeded').startswith('📏 The input is too large')
    assert h('insufficient credit balance').startswith('💳 The provider rejected')
    assert h('cURL error 7: connection refused').startswith("🌐 Couldn't reach the provider")
    assert h('plain message') == 'plain message'
    long = 'x' * 500
    assert h(long) == 'x' * 380 + '… (full error in server log)'
    assert '[REDACTED]' in h('https://h/?key=abc&x=1 something unrelated')


def test_sanitizers():
    assert ChatController.sanitizeSkillMetadata({'dir_name': 'docx', 'scripts': ['scripts/create.py', '/abs.py', '../x', 'scripts/create.py']}) == {'dir_name': 'docx', 'scripts': ['scripts/create.py']}
    assert ChatController.sanitizeSkillMetadata({'dir_name': 'bad..name', 'scripts': ['a']}) is None
    assert ChatController.sanitizeSkillMetadata({'dir_name': 'docx', 'scripts': []}) is None
    skills = ChatController.sanitizeAvailableSkills([{'dir_name': 'a', 'description': ' d ', 'scripts': ['s.py']}, {'dir_name': 'a', 'scripts': ['t.py']}, {'dir_name': 'b', 'scripts': []}, 'x'])
    assert skills == [{'dir_name': 'a', 'description': 'd', 'scripts': ['s.py']}]
    ct = ChatController.sanitizeClientTools([{'name': 'webmcp_go', 'description': 'D', 'input_schema': {'type': 'object', 'properties': {}}},
                                             {'name': 'evil', 'input_schema': {}}, {'name': 'route_to', 'input_schema': 'nope'}, {'name': 'save_playbook_agent', 'input_schema': {'properties': {'p': {'properties': {}}}}}])
    assert ct == [{'name': 'webmcp_go', 'description': 'D', 'input_schema': {'type': 'object', 'properties': {}}},
                  {'name': 'save_playbook_agent', 'description': '', 'input_schema': {'properties': {'p': {'properties': {}}}}}]
    assert ChatController.stripVisualNoiseFromHistory([{'role': 'assistant', 'content': 'a <svg x="1"><g/></svg> b'}]) == [{'role': 'assistant', 'content': 'a [SVG illustration omitted] b'}]


def test_tool_builders_match_php_text():
    t = ChatController.buildRunSkillScriptTool({'dir_name': 'docx', 'scripts': ['scripts/create.py', 'scripts/edit.py']})
    assert t['name'] == 'run_skill_script' and t['description'].startswith('Execute one of the Python scripts bundled with the active skill "docx".')
    assert 'Available scripts: scripts/create.py, scripts/edit.py.\n\nRUNTIME CONTRACT:' in t['description']
    assert t['input_schema']['properties']['script']['enum'] == ['scripts/create.py', 'scripts/edit.py'] and t['input_schema']['required'] == ['script']
    task = ChatController.buildTaskTool()
    assert task['name'] == 'Task' and task['input_schema']['required'] == ['description', 'subagent_type', 'prompt'] and task['input_schema']['properties']['provider']['enum'] == ['claude', 'openai', 'grok', 'gemini', 'deepseek', 'kimi']
    ms = ChatController.buildMultiSkillTool([{'dir_name': 'docx', 'description': '', 'scripts': ['s.py']}])
    assert '  • docx — (no description) | scripts: s.py' in ms['description'] and ms['input_schema']['properties']['dir_name']['enum'] == ['docx'] and ms['input_schema']['required'] == ['dir_name', 'script']
    ds = ChatController.buildDiscoverSkillTool([{'dir_name': 'docx'}, {'dir_name': 'docx'}, {'dir_name': 'html'}])
    assert ds['name'] == 'discover_skill' and ds['input_schema']['properties']['dir_name']['enum'] == ['docx', 'html']


class Db:
    def __init__(self, scripted): self.scripted = list(scripted); self.calls = []
    def _next(self, sql, p):
        self.calls.append((sql, p)); return self.scripted.pop(0) if self.scripted else None
    def fetch_one(self, s, p=None): return self._next(s, p)
    def fetch_all(self, s, p=None): r = self._next(s, p); return r if r is not None else []
    def fetch_column(self, s, p=None): r = self._next(s, p); return r if r is not None else []
    def execute(self, s, p=None): self.calls.append((s, p)); return 1


def _enc(plain: str, secret: str) -> str:
    key = hashlib.sha256(secret.encode()).digest(); iv = os.urandom(16)
    padder = padding.PKCS7(128).padder(); padded = padder.update(plain.encode()) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return base64.b64encode(iv + enc.update(padded) + enc.finalize()).decode()


def test_apply_user_api_keys_decrypts_and_applies_models_only_for_owned_keys():
    cfg = {'auth': {'jwt_secret': 'S'}, 'claude': {'api_key': 'old', 'model': 'm0'}, 'providers': {'kimi': {'api_key': '', 'model': 'k0'}}}
    db = Db([[{'Tables_in_x': 'user_api_keys'}],                                    # SHOW TABLES user_api_keys
             [{'provider': 'claude', 'api_key': _enc('sk-new', 'S'), 'system_prompt': ' P '}],
             [{'Tables_in_x': 'user_model_selections'}],                            # SHOW TABLES user_model_selections
             [{'provider': 'claude', 'model': 'm1'}, {'provider': 'kimi', 'model': 'k1'}]])
    out = ChatController(db, cfg)._applyUserApiKeys(cfg, '3')
    assert out['claude'] == {'api_key': 'sk-new', 'model': 'm1', 'system_prompt': ' P '} and out['providers']['kimi'] == {'api_key': '', 'model': 'k0'}
    assert ChatController(Db([]), cfg)._applyUserApiKeys(cfg, 'demo-user') == cfg


def test_apply_package_defaults_and_quota():
    cfg = {'claude': {'api_key': '', 'model': 'm'}, 'providers': {'kimi': {'api_key': 'x'}}}
    db = Db([{'role': 'user'}, {'capabilities': '{"providers":{"claude":{"enabled":true,"default_api_key":" K ","default_model":"M"},"kimi":{"enabled":false,"default_api_key":"Z"},"ghost":{"enabled":true,"default_api_key":"G"}}}', 'updated_at': None}])
    out = ChatController(db, cfg)._applyPackageDefaults(cfg, '3')
    assert out['claude'] == {'api_key': 'K', 'model': 'M'} and out['providers']['kimi'] == {'api_key': 'x'}
    q = ChatController(Db([{'plan': 'free', 'role': 'user'}, {'role': 'user'}, {'capabilities': '{"quota_tokens":1000}', 'updated_at': None},
                           [{'Tables_in_x': 'llm_usage_balance'}], {'total': 1500}]), cfg)._checkFreeTrialQuota('3')
    assert q == {'success': False, 'error': 'Token quota reached. You have used 1,500 of 1,000 tokens. Please upgrade your plan to continue.', 'code': 'QUOTA_EXCEEDED',
                 'usage': {'total_tokens': 1500, 'quota': 1000}, 'status_code': 403}
    assert ChatController(Db([{'plan': 'premium', 'role': 'user'}]), cfg)._checkFreeTrialQuota('3') is None
    assert ChatController(Db([{'plan': 'free', 'role': 'admin'}]), cfg)._checkFreeTrialQuota('3') is None
    assert ChatController(Db([]), cfg)._checkFreeTrialQuota('demo-user') is None


def test_enabled_provider_keys_fallback():
    assert ChatController(Db([[]]), {})._getEnabledProviderKeys() == ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi']
    c = ChatController(Db([['claude', 'kimi', 'claude']]), {})
    assert c._getEnabledProviderKeys() == ['claude', 'kimi'] and c._getEnabledProviderKeys() == ['claude', 'kimi']


def test_sse_client_classes_prefix_events():
    ev = []
    v = VerificationSseClient(lambda e, d: ev.append((e, d)))
    v.sendProgress('p'); v.sendChunk('c'); v.sendResponse({'r': 1}); v.sendError('e', 400); v.sendCustomEvent('client_tool_call', {'x': 1}); v.complete()
    assert ev == [('verification_progress', 'p'), ('verifier_chunk', 'c'), ('verification_response', {'r': 1}), ('verification_error', {'message': 'e', 'code': 400}), ('client_tool_call', {'x': 1})]
    assert v.getSessionId().startswith('verify_') and v.isConnected()
    ev.clear(); c = ComparisonSseClient(lambda e, d: ev.append((e, d)))
    c.sendChunk('c'); c.sendCustomEvent('client_tool_call', {'x': 1}); c.sendCustomEvent('mcp_ui', {'y': 2})
    assert ev == [('compare_chunk', 'c'), ('compare_client_tool_call', {'x': 1}), ('mcp_ui', {'y': 2})] and c.getSessionId().startswith('compare_')
