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
A payload whose tool_name the webhook's tool set does not register
(get_portfolios: the webhook's assistant has no database, so only the
search functions) is compared exactly: 404 "Tool not found" on both.
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


def test_evi_webhook_unregistered_tool_name_parity(both):
    same(*both('POST', '/api/v1/evi/webhook', json={'tool_name': 'get_portfolios', 'parameters': {}}, auth=False))
