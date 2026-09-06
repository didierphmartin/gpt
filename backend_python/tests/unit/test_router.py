from app.support.router import Dispatcher

ROUTES = [
    ('GET', '/', ('RootController', 'index')),
    ('POST', '/api/v1/auth', ('AuthController', 'handleAction')),
    ('GET', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'get')),
    ('PUT', '/api/v1/prompts/{id:\\d+}', ('PromptLibraryController', 'update')),
    ('GET', '/api/v1/admin/llm-settings/{key}', ('SystemSettingsController', 'getLLMProvider')),
    ('GET', '/api/v1/workflows/runs/{runId:[a-f0-9]{32}}/events', ('AgentTeam:WorkflowController', 'runEvents')),
    ('GET', '/api/v1/workflows/{id:\\d+}/outputs/{filename}', ('AgentTeam:WorkflowController', 'getOutput')),
]


def test_found_with_typed_params():
    d = Dispatcher(ROUTES)
    r = d.dispatch('GET', '/api/v1/prompts/42')
    assert r.status == 'FOUND' and r.handler == ('PromptLibraryController', 'get') and r.params == {'id': '42'}
    r2 = d.dispatch('GET', '/api/v1/workflows/7/outputs/report.md')
    assert r2.params == {'id': '7', 'filename': 'report.md'}
    r3 = d.dispatch('GET', '/api/v1/workflows/runs/' + 'a' * 32 + '/events')
    assert r3.status == 'FOUND' and r3.params == {'runId': 'a' * 32}


def test_not_found_and_method_not_allowed():
    d = Dispatcher(ROUTES)
    assert d.dispatch('GET', '/api/v1/prompts/abc').status == 'NOT_FOUND'
    r = d.dispatch('DELETE', '/api/v1/prompts/42')
    assert r.status == 'METHOD_NOT_ALLOWED' and sorted(r.allowed) == ['GET', 'PUT']
    assert d.dispatch('GET', '/nope').status == 'NOT_FOUND'
    assert d.dispatch('GET', '/').status == 'FOUND'


def test_head_is_not_get():
    # FastRoute treats HEAD as GET fallback; index.php never receives HEAD from the frontend.
    # Mirror FastRoute: HEAD matches a GET route.
    d = Dispatcher(ROUTES)
    assert d.dispatch('HEAD', '/').status == 'FOUND'
