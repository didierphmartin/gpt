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
A payload with a valid tool_name is NOT compared here because
EVIWebhookController.php:53/63 call two methods (`getAvailableTools()`,
`executeTool()`) that do not exist on ToolsManager — every such payload
throws in PHP today (an uncaught "Call to undefined method" \\Error whose
exact message text is not meaningfully portable) and is out of scope for
byte-identical comparison.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_hume_tools_list_exact_parity(both):
    same(*both('GET', '/api/v1/hume/tools/list'))


def test_hume_tools_execute_missing_toolcallid_or_toolname_parity(both):
    same(*both('POST', '/api/v1/hume/tools/execute', json={}))
    same(*both('POST', '/api/v1/hume/tools/execute', json={'toolCallId': 'tc1'}))
    same(*both('POST', '/api/v1/hume/tools/execute', json={'toolName': 'get_portfolios'}))


def test_hume_tools_execute_unknown_tool_parity(both):
    same(*both('POST', '/api/v1/hume/tools/execute',
                json={'toolCallId': 'tc1', 'toolName': 'no_such_tool_xyz_123'}))


def test_hume_tools_execute_read_only_tool_parity(both):
    # get_portfolios: read-only, DB-backed (Functions/PortfolioFunctions.php,
    # ported at app/functions/portfolio_functions.py), no external HTTP call.
    # Both backends hit the SAME database for the same admin user, so the
    # response — including row content — must match exactly.
    same(*both('POST', '/api/v1/hume/tools/execute',
                json={'toolCallId': 'tc1', 'toolName': 'get_portfolios'}))


def test_evi_webhook_missing_tool_name_parity(both):
    # Public route (no auth) both sides.
    same(*both('POST', '/api/v1/evi/webhook', json={}, auth=False))
    same(*both('POST', '/api/v1/evi/webhook', json={'parameters': {}}, auth=False))
