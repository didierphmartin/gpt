-- 2026-09-02_mcp_servers_is_mock.sql — flag mock MCP servers explicitly.
-- Until now the only signals were the URL (/mockokta/, /mockstack/) and a
-- description starting with "Mock"; scripts/register_mock_*.php set this
-- column from here on. Backfills the rows already registered.
ALTER TABLE mcp_servers
  ADD COLUMN is_mock TINYINT(1) NOT NULL DEFAULT 0 AFTER enabled;

UPDATE mcp_servers
   SET is_mock = 1
 WHERE url LIKE '%/mockokta/%' OR url LIKE '%/mockstack/%';
