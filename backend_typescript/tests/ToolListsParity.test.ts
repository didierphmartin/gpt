import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { AgentController } from '../src/Controllers/AgentController';
import { AgentMCPController } from '../src/Controllers/AgentMCPController';
import { ProviderController } from '../src/Controllers/ProviderController';
import { ToolsController } from '../src/Controllers/ToolsController';
import { Ctx } from '../src/Support/Http';

/**
 * The tool lists of /api/v1/providers, /api/v1/tools, /api/v1/agents/tools and /api/v1/mcp/agents
 * tools/list against PHP: which built-ins each one carries, whose MCP servers it loads and through
 * which package allowlist, and the delegation tools.
 */

const BUILTINS = [
  'serpapi_search', 'brave_search', 'search_assets', 'get_trending_assets', 'get_top_gainers', 'get_top_losers',
  'get_sec_filings', 'get_sec_filing_document',
  'get_portfolios', 'get_portfolio_assets_with_discovery', 'get_portfolio_diversification', 'get_all_transactions',
  'get_user_watchlist', 'get_watchlist_with_market_data', 'add_to_watchlist', 'remove_from_watchlist',
  'get_analyst_ratings', 'get_financial_ratios', 'get_price_targets', 'get_company_profile', 'get_asset_sentiment',
];

const tool = (server: string, name: string, userId: string | null = null) => ({
  tool_name: name, tool_description: 'd', input_schema: '{"type":"object","properties":{}}', has_ui: 0, ui_resource_uri: null,
  server_id: server === 'A' ? 1 : server === 'B' ? 2 : 3, server_url: 'http://x', server_name: server, server_user_id: userId, server_headers: null,
});

beforeEach(() => {
  // Guest package: only server A, only the openai provider. Server B is global, P is private to user 3.
  installFakeDb((sql, params) => {
    if (/FROM packages/i.test(sql)) return [{ capabilities: { mcp_servers: ['A'], providers: { openai: { enabled: true }, claude: { enabled: false } } }, updated_at: null }];
    if (/from `mcp_server_tools`/i.test(sql)) {
      const rows = [tool('A', 'a1'), tool('B', 'b1')];
      return params.includes('3') ? [...rows, tool('P', 'p1', '3')] : rows;
    }
    if (/from `system_llm_settings`/i.test(sql)) {
      return ['openai', 'claude'].map((k) => ({ provider_key: k, display_name: k, model: 'm', supported_models: '[]', max_tokens: 1, api_format: 'openai', kind: 'chat' }));
    }
    return [];
  });
});

const ctx = (userId: number | null = null, query: Record<string, unknown> = {}): Ctx => ({
  method: 'GET', uri: '/', headers: {}, query, body: {}, user_id: userId, auth_type: 'jwt', params: {}, remote_addr: '',
});

test('/agents/tools lists the runner built-ins, no MCP tools, and the delegation tools', async () => {
  const r: any = await new AgentController().listTools(ctx(3));
  assert.deepEqual(r.tools.builtin.map((t: any) => t.name), BUILTINS);
  assert.deepEqual(r.counts, { builtin: 21, mcp: 0, delegation: 3, total: 24 });
});

test('/mcp/agents tools/list: the runner built-ins + delegation, list_available_agents properties []', async () => {
  const res: any = await new AgentMCPController().handle({ ...ctx(3), method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  const tools = res.result.tools;
  assert.equal(res.result.count, 24);
  assert.deepEqual(tools.map((t: any) => t.name), [...BUILTINS, 'delegate_to_agent', 'list_available_agents', 'run_agents_parallel']);
  assert.deepEqual(tools.find((t: any) => t.name === 'list_available_agents').inputSchema, { type: 'object', properties: [] });
});

test('/providers lists global MCP tools through the package allowlist, then the delegation tools', async () => {
  const r: any = await new ProviderController().list(ctx(null));
  assert.deepEqual(r.functions.slice(-4), ['mcp_a1', 'delegate_to_agent', 'list_available_agents', 'run_agents_parallel']);
  assert.ok(!r.functions.includes('mcp_b1') && !r.functions.includes('mcp_p1'));
  assert.equal(r.function_count, r.functions.length);
  assert.deepEqual(r.providers.map((p: any) => p.name), ['openai']);
});

test('/tools applies the package MCP allowlist', async () => {
  const r: any = await new ToolsController().list(ctx(null, { type: 'mcp' }));
  assert.deepEqual(r.tools.map((t: any) => t.name), ['mcp_a1']);
  assert.ok(queries.some((q) => /FROM packages/i.test(q.sql)));
});
