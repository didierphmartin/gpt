/**
 * PHP-vs-TS differential: HumeToolController + EVIWebhookController — twin of
 * backend_python/tests/differential/test_hume_evi.py.
 *
 * HUME_API_KEY and hume_evi.config_id are both configured in backend/.env, so `sync`, `getStatus`,
 * `testConnection` and `getConfig` would place REAL Hume API calls; per the "never calls Hume" rule
 * they are not exercised. Only `list` (local data) and `execute` (validation + one read-only,
 * computed tool) are compared.
 *
 * `POST /evi/webhook`: PHP's EVIWebhookController has no signature verification, so there is no
 * signature case. Compared: the "missing tool_name" 400, and an unregistered tool_name (the webhook's
 * assistant has no database, so only the search functions: get_portfolios is a 404).
 *
 * Read-only.
 */
import { dtest, same, assert } from './harness';

dtest('test_hume_tools_list_exact_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/hume/tools/list')));
});

dtest('test_hume_tools_execute_missing_toolcallid_or_toolname_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/hume/tools/execute', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/hume/tools/execute', { json: { toolCallId: 'tc1' } })));
  same(...(await hx.both('POST', '/api/v1/hume/tools/execute', { json: { toolName: 'get_asset_sentiment' } })));
});

dtest('test_hume_tools_execute_unknown_tool_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/hume/tools/execute', { json: { toolCallId: 'tc1', toolName: 'no_such_tool_xyz_123' } })));
});

dtest('test_hume_tools_execute_read_only_tool_parity', async (hx) => {
  // get_asset_sentiment (Functions/AnalysisFunctions.php): read-only, computed from params, no DB
  // and no external HTTP call. Not a DB-backed tool: this environment's DB lacks the
  // portfolios/watchlist/assets tables, so DB-backed reads compare driver error texts.
  same(...(await hx.both('POST', '/api/v1/hume/tools/execute', {
    json: { toolCallId: 'tc1', toolName: 'get_asset_sentiment', parameters: { symbol: 'aapl' } },
  })));
});

dtest('test_evi_webhook_missing_tool_name_parity', async (hx) => {
  // Public route (no auth) both sides.
  same(...(await hx.both('POST', '/api/v1/evi/webhook', { json: {}, auth: false })));
  same(...(await hx.both('POST', '/api/v1/evi/webhook', { json: { parameters: {} }, auth: false })));
});

dtest('test_evi_webhook_unregistered_tool_name_parity', async (hx) => {
  // The webhook's assistant has no database, so only the search functions: get_portfolios is a 404.
  same(...(await hx.both('POST', '/api/v1/evi/webhook', { json: { tool_name: 'get_portfolios', parameters: {} }, auth: false })));
});
