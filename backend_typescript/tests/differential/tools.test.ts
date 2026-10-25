/**
 * PHP-vs-TS differential: ToolsController (backend/src/Controllers/ToolsController.php) — twin of
 * backend_python/tests/differential/test_tools.py.
 *
 * GET /tools must be EXACT: built-in tool definitions + MCP tools with schemas for user 3. A
 * mismatch here is a schema-serialization drift (`properties: {}` vs `[]`, key order) —
 * investigate and fix the port/serializer, never loosen the comparison.
 *
 * POST /tools/execute and POST /tools/classify-intent are exercised with deterministic validation
 * errors only — no external calls. The `serpapi_search` "no key configured" case does NOT apply:
 * SERPAPI_KEY is a real, live key in backend/.env, so executing serpapi_search would place a real
 * paid network call. This file uses "missing tool name" / "unknown tool" instead — both
 * deterministic and network-free.
 *
 * No case writes data.
 */
import { dtest, same } from './harness';

dtest('test_tools_list_exact_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/tools')));
});

dtest('test_tools_list_type_filter_and_search_parity', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/tools?type=builtin')));
  same(...(await hx.both('GET', '/api/v1/tools?type=mcp')));
  same(...(await hx.both('GET', '/api/v1/tools?type=bogus')));
  same(...(await hx.both('GET', '/api/v1/tools?search=search')));
});

dtest('test_tools_execute_missing_tool_name_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/tools/execute', { json: {} })));
});

dtest('test_tools_execute_unknown_tool_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/tools/execute', { json: { tool_name: 'no_such_tool_xyz_123' } })));
});

dtest('test_tools_classify_intent_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/tools/classify-intent', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/tools/classify-intent', { json: { transcript: '   ', tools: [{ name: 'done' }] } })));
  same(...(await hx.both('POST', '/api/v1/tools/classify-intent', { json: { transcript: 'hello', tools: [] } })));
});
