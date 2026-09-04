-- 2026-09-04_mcp_servers_transport.sql — per-server MCP transport.
-- 'http'  = Streamable HTTP (JSON-RPC POST, default, existing behaviour)
-- 'sse'   = legacy SSE servers; the proxy POSTs to their /mcp sibling endpoint.
ALTER TABLE mcp_servers
  ADD COLUMN transport ENUM('http','sse') NOT NULL DEFAULT 'http' AFTER headers;
