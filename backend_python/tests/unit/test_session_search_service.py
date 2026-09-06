from app.agent_team.services.session_search_service import SessionSearchService
from app.services.tools_manager import ToolsManager


def test_snippet_terms_and_plain_text():
    text = 'role: ' + 'a' * 700 + ' redis ' + 'b' * 700
    snip = SessionSearchService._buildSnippet(text, ['redis'], 600)
    assert 'redis' in snip and snip.startswith('…') and snip.endswith('…') and len(snip) <= 602
    assert SessionSearchService._queryTerms('Auth Microservice, Redis!') == ['auth', 'microservice', 'redis']
    js = '{"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"text":"yo"}]}]}'
    assert SessionSearchService._extractPlainText(js) == 'user: hi\nassistant: yo'


def test_register_as_tool_schema_and_guard():
    tm = ToolsManager()
    assert SessionSearchService.registerAsTool(tm, 0, {}) is False
    assert SessionSearchService.registerAsTool(tm, 3, {}) is False               # no contexts_database config
    ok = SessionSearchService.registerAsTool(tm, 3, {'contexts_database': {'host': 'h', 'database': 'd', 'username': 'u', 'password': 'p'}})
    assert ok is True and tm.hasFunction('session_search')
    d = tm.getToolDefinitions()[0]
    assert d['name'] == 'session_search' and d['input_schema']['required'] == ['query'] and d['input_schema']['properties']['limit']['maximum'] == 15
    assert tm.execute('session_search', {'query': ''}) == {'error': 'query is required'}
