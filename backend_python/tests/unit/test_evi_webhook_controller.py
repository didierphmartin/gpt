"""Unit tests for EVIWebhookController — port of Controllers/EVIWebhookController.php (1-79).

PHP-truth strings copied verbatim:
  - "Invalid webhook payload: missing tool_name"   (EVIWebhookController.php:39)
  - "Tool not found: {toolName}"                   (EVIWebhookController.php:57)
  - "[EVIWebhookController] Error: "                (EVIWebhookController.php:71, error_log prefix)

No signature/HMAC check exists anywhere in the PHP source for this route (see
the controller module docstring) — there is nothing to unit-test there; this
file instead documents that absence and focuses on payload validation and the
documented undefined-method PHP bug (getAvailableTools()/executeTool() do not
exist on ToolsManager) that makes every payload past validation end in a 500.
"""
from app.controllers.evi_webhook_controller import EVIWebhookController

CFG = {'auth': {'jwt_secret': 'S'}, 'database': {}, 'contexts_database': {}}


class Db:
    def fetch_all(self, sql, params=None): raise AssertionError(f'unexpected query: {sql}')
    def fetch_one(self, sql, params=None): raise AssertionError(f'unexpected query: {sql}')


def req(body=None):
    return {'body': body if body is not None else {}}


class FakeToolsManager:
    """A ToolsManager stand-in that DOES implement getAvailableTools()/executeTool(),
    representing the 'if the PHP bug were fixed' behaviour some tests exercise
    to pin the shape callers would see once someone fixes EVIWebhookController.php."""
    def __init__(self, available=(), exec_fn=None):
        self._available = list(available)
        self._exec_fn = exec_fn

    def getAvailableTools(self):
        return self._available

    def executeTool(self, name, arguments):
        return self._exec_fn(name, arguments)


def make_fake_assistant_class(tools_manager, closed=None):
    class FakeAssistant:
        def __init__(self, config):
            self.config = config

        def getToolsManager(self):
            return tools_manager

        def close(self):
            if closed is not None:
                closed.append(True)

    return FakeAssistant


def patch_common(monkeypatch, assistant_class):
    monkeypatch.setattr('app.controllers.evi_webhook_controller.LLMProviderResolver.applyDbSettings',
                         staticmethod(lambda db, cfg: cfg))
    monkeypatch.setattr('app.controllers.evi_webhook_controller.AIPortfolioAssistant', assistant_class)


# ─── validation ──────────────────────────────────────────────────────────────

def test_empty_payload_is_400():
    ctl = EVIWebhookController(Db(), CFG)
    assert ctl.handleWebhook(req(body={})) == {
        'success': False, 'error': 'Invalid webhook payload: missing tool_name', 'status_code': 400,
    }


def test_missing_tool_name_key_is_400():
    ctl = EVIWebhookController(Db(), CFG)
    assert ctl.handleWebhook(req(body={'parameters': {'x': 1}})) == {
        'success': False, 'error': 'Invalid webhook payload: missing tool_name', 'status_code': 400,
    }


def test_null_tool_name_is_400():
    ctl = EVIWebhookController(Db(), CFG)
    assert ctl.handleWebhook(req(body={'tool_name': None})) == {
        'success': False, 'error': 'Invalid webhook payload: missing tool_name', 'status_code': 400,
    }


# ─── the real ToolsManager has neither getAvailableTools() nor executeTool() ──
# (PHP: an undefined-method \Error, uncaught by `catch (Exception $e)`, that
# propagates to index.php's outer Throwable handler for the SAME 500 shape;
# Python's AttributeError IS caught locally here — see the controller docstring).

def test_real_toolsmanager_lacks_getavailabletools_yields_500(monkeypatch):
    from app.services.tools_manager import ToolsManager
    closed = []
    assistant_cls = make_fake_assistant_class(ToolsManager(), closed=closed)
    patch_common(monkeypatch, assistant_cls)

    ctl = EVIWebhookController(Db(), CFG)
    r = ctl.handleWebhook(req(body={'tool_name': 'anything', 'parameters': {}}))
    assert r['success'] is False and r['status_code'] == 500
    assert 'getAvailableTools' in r['error']
    assert closed == [True]  # assistant still closed on the exception path


# ─── behaviour once getAvailableTools()/executeTool() exist (pins the intended shape) ──

def test_tool_not_found_is_404_when_toolsmanager_supports_lookup(monkeypatch):
    tm = FakeToolsManager(available=['other_tool'])
    assistant_cls = make_fake_assistant_class(tm)
    patch_common(monkeypatch, assistant_cls)

    ctl = EVIWebhookController(Db(), CFG)
    r = ctl.handleWebhook(req(body={'tool_name': 'missing_tool'}))
    assert r == {'success': False, 'error': 'Tool not found: missing_tool', 'status_code': 404}


def test_known_tool_executes_and_returns_result(monkeypatch):
    seen = {}

    def exec_fn(name, arguments):
        seen['name'] = name
        seen['arguments'] = arguments
        return {'echo': arguments}

    tm = FakeToolsManager(available=['echo_tool'], exec_fn=exec_fn)
    closed = []
    assistant_cls = make_fake_assistant_class(tm, closed=closed)
    patch_common(monkeypatch, assistant_cls)

    ctl = EVIWebhookController(Db(), CFG)
    r = ctl.handleWebhook(req(body={'tool_name': 'echo_tool', 'parameters': {'a': 1}}))
    assert r == {'success': True, 'result': {'echo': {'a': 1}}, 'status_code': 200}
    assert seen == {'name': 'echo_tool', 'arguments': {'a': 1}}
    assert closed == [True]


def test_parameters_default_to_empty_dict_when_absent(monkeypatch):
    seen = {}

    def exec_fn(name, arguments):
        seen['arguments'] = arguments
        return {}

    tm = FakeToolsManager(available=['no_params_tool'], exec_fn=exec_fn)
    patch_common(monkeypatch, make_fake_assistant_class(tm))

    ctl = EVIWebhookController(Db(), CFG)
    ctl.handleWebhook(req(body={'tool_name': 'no_params_tool'}))
    assert seen['arguments'] == {}


def test_execution_exception_returns_500_with_message(monkeypatch):
    def exec_fn(name, arguments):
        raise RuntimeError('downstream failure')

    tm = FakeToolsManager(available=['bad_tool'], exec_fn=exec_fn)
    closed = []
    patch_common(monkeypatch, make_fake_assistant_class(tm, closed=closed))

    ctl = EVIWebhookController(Db(), CFG)
    r = ctl.handleWebhook(req(body={'tool_name': 'bad_tool'}))
    assert r['success'] is False and r['status_code'] == 500 and 'downstream failure' in r['error']
    assert closed == [True]
