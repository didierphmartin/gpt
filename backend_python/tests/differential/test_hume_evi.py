"""PHP-vs-Python differential: HumeToolController + EVIWebhookController
(backend/src/Controllers/HumeToolController.php, EVIWebhookController.php).

Scope note (brief deviation, PHP-first): HUME_API_KEY and hume_evi.config_id
are BOTH genuinely configured in backend/.env (shared by both backends, see
app/config.py's env-file fallback) — there is no "key not configured"
validation-only branch to hit for `sync`, `getStatus`, `testConnection` or
`getConfig` in this environment; every one of those would place a REAL call
to the Hume API. Per the task's "never calls Hume" rule this file does not
exercise them at all (not even for a 400/500 validation shape). Only `list`
(pure local data, no external call) and `execute` (validation + one
read-only, DB-backed tool) are compared.

`POST /evi/webhook`: PHP's EVIWebhookController has no signature/HMAC
verification of any kind (grep confirms no hash_hmac/X-Hume-Signature
anywhere under backend/src) despite being a public, unauthenticated
callback route — see evi_webhook_controller.py's module docstring for the
full citation. There is therefore no "invalid signature" / "missing
signature" case to compare; this file instead compares the one
deterministic, network-free path: the "missing tool_name" 400 validation.
A payload with a valid tool_name IS compared, but only for STATUS + BODY
SHAPE (not exact message text): EVIWebhookController.php:53/63 call two
methods (`getAvailableTools()`, `executeTool()`) that do not exist on
ToolsManager, so every such payload throws in PHP today (an uncaught "Call
to undefined method" \\Error, caught by index.php's outer
`catch (Throwable $e)`) -- verified live:
  PHP: 500 {"success":false,"error":"Call to undefined method
       Quantis\\AIPortfolioAssistant\\Services\\ToolsManager::getAvailableTools()"}
  Py:  500 {"success":false,"error":"'ToolsManager' object has no attribute
       'getAvailableTools'"}
Same status code, same {success, error} shape, `success=False` both sides --
the message text is inherently language-specific (PHP's undefined-method
wording vs Python's AttributeError wording) and not a meaningful byte-parity
target, so `test_evi_webhook_valid_tool_name_500_shape_parity` below asserts
shape, not `same()`.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_hume_tools_list_exact_parity(both):
    same(*both('GET', '/api/v1/hume/tools/list'))


def test_hume_tools_execute_missing_toolcallid_or_toolname_parity(both):
    same(*both('POST', '/api/v1/hume/tools/execute', json={}))
    same(*both('POST', '/api/v1/hume/tools/execute', json={'toolCallId': 'tc1'}))
    same(*both('POST', '/api/v1/hume/tools/execute', json={'toolName': 'get_asset_sentiment'}))


def test_hume_tools_execute_unknown_tool_parity(both):
    same(*both('POST', '/api/v1/hume/tools/execute',
                json={'toolCallId': 'tc1', 'toolName': 'no_such_tool_xyz_123'}))


def test_hume_tools_execute_read_only_tool_parity(both):
    # get_asset_sentiment (Functions/AnalysisFunctions.php, ported at
    # app/functions/analysis_functions.py): read-only, purely computed from
    # params, no DB and no external HTTP call -- deterministic on both
    # backends. NOT a DB-backed tool (get_portfolios/get_user_watchlist etc)
    # as the brief suggests: this shared environment's DB has none of
    # portfolios/watchlist/assets (SHOW TABLES confirms all three missing),
    # so any DB-backed read hits a pre-existing, out-of-scope Phase 2c gap --
    # PHP's PDOException::getMessage() ("SQLSTATE[42S02]: Base table or view
    # not found: 1146 Table '...' doesn't exist") vs Python's bare
    # str(pymysql.err.Error) ("(1146, \"Table '...' doesn't exist\")") format
    # differently in PortfolioFunctions.php/portfolio_functions.py's
    # `catch (\Throwable $e) { return ['error' => $e->getMessage()]; }` /
    # `except Exception as e: return {'error': str(e)}` paths -- outside this
    # task's file scope (Phase 2c, not HumeToolController/EVIWebhookController).
    same(*both('POST', '/api/v1/hume/tools/execute',
                json={'toolCallId': 'tc1', 'toolName': 'get_asset_sentiment', 'parameters': {'symbol': 'aapl'}}))


def test_evi_webhook_missing_tool_name_parity(both):
    # Public route (no auth) both sides.
    same(*both('POST', '/api/v1/evi/webhook', json={}, auth=False))
    same(*both('POST', '/api/v1/evi/webhook', json={'parameters': {}}, auth=False))


def test_evi_webhook_valid_tool_name_500_shape_parity(both):
    # See module docstring: PHP's undefined-method bug means ANY tool_name
    # that clears validation crashes to a 500 on both backends today. Status
    # + body SHAPE must match exactly; the message text is language-specific
    # and intentionally excluded from the comparison.
    a, b = both('POST', '/api/v1/evi/webhook', json={'tool_name': 'get_portfolios', 'parameters': {}}, auth=False)
    assert a.status_code == b.status_code == 500, (a.status_code, b.status_code, a.text, b.text)
    ja, jb = a.json(), b.json()
    assert set(ja.keys()) == set(jb.keys()) == {'success', 'error'}, (ja, jb)
    assert ja['success'] is False and jb['success'] is False
    assert isinstance(ja['error'], str) and isinstance(jb['error'], str) and ja['error'] and jb['error']
