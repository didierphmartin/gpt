/**
 * The MCP tool catalog of a generated LangGraph script carries each tool's input_schema. On MySQL the
 * column is `json`: PDO answers its text, mysql2 parses it into an object unless it is selected as
 * CHAR. Real saved workflows hit that (fixtures on SQLite do not), and the script lost every schema.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './support/fakeDb';
import { sqlite, makeGenerator } from './support/lgFixturesB';

const SCHEMA = '{"type": "object", "required": ["query"], "properties": {"query": {"type": "string", "description": "Search terms"}}}';

const graph = {
  nodes: [
    { id: '1', node_type: 'start', config: { type: 'start', prompt: 'go' } },
    { id: '2', node_type: '', config: { type: 'agent-template', agent_name: 'Searcher', agent_type: 'standard',
      instructions: 'Search.', agent_provider: 'claude', model: 'claude-sonnet-4-6',
      tools: ['mcp_search'], settings: { temperature: 0.7, max_tokens: 4096 } } },
    { id: '3', node_type: 'output', config: { type: 'output' } },
  ],
  edges: [{ from: '1', to: '2', from_port: 'output_1' }, { from: '2', to: '3', from_port: 'output_1' }],
};

/** SQLite behind a driver that, like mysql2, parses the json column unless the query casts it. */
function mysqlLikeDb(): void {
  const d = sqlite([
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER, headers TEXT)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, model TEXT, enabled INTEGER)',
    "INSERT INTO mcp_servers VALUES (5, NULL, 'Search', 'http://localhost/search/mcp', 1, NULL)",
    `INSERT INTO mcp_server_tools VALUES (1, 5, 'search', 'Search', '${SCHEMA}')`,
    "INSERT INTO system_llm_settings VALUES ('claude', 'claude-sonnet-4-6', 1)",
  ]);
  installFakeDb((sqlText, params) => {
    const st = d.prepare(sqlText);
    const rows = st.all(...(params as any[])) as any[];
    if (/mcp_server_tools/i.test(sqlText) && !/CAST\(t\.input_schema AS CHAR\) AS input_schema/i.test(sqlText)) {
      for (const r of rows) if (typeof r.input_schema === 'string') r.input_schema = JSON.parse(r.input_schema);
    }
    return rows;
  });
}

test('the tool catalog keeps the input_schema of a json column', async () => {
  mysqlLikeDb();
  const code: string = (await makeGenerator({ workflow: { id: 7, name: 'Search', user_id: '3' }, graph }).generate(7, '3', {})).code;
  assert.ok(code.includes('"description": "Search terms"'), 'the schema reaches the script');
  assert.ok(!/"input_schema": \{\}/.test(code));
});
