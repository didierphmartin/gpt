"""MCP transport for code_node_run.py: call_tool's JSON-RPC client, sending each server's stored headers.

Header values come from mcp_servers.headers and are never printed or logged here.
"""
import json
import urllib.error
import urllib.request


class McpTransport:
    BASE_HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}

    def __init__(self, servers: dict, timeout_s: int):
        self.servers = servers
        self.timeout_s = timeout_s
        self.endpoints = {}   # slug -> (endpoint url, headers incl. session id)

    @staticmethod
    def parse(text: str):
        """Plain JSON-RPC, or SSE lines 'data: {...}'."""
        try:
            return json.loads(text)
        except ValueError:
            pass
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    return json.loads(line[5:].strip())
                except ValueError:
                    continue
        return None

    def post(self, url: str, headers: dict, body: dict):
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
            return r.headers.get("Mcp-Session-Id"), r.read().decode("utf-8", "replace")

    def connect(self, slug: str):
        """Handshake once per server: the /mcp-normalised URL first, then the URL as registered."""
        if slug in self.endpoints:
            return self.endpoints[slug]
        srv = self.servers[slug]
        base = srv["url"].rstrip("/")
        candidates = [base] if base.endswith(("/mcp", ".php")) else [base + "/mcp", base]
        headers = {**self.BASE_HEADERS, **{str(k): str(v) for k, v in (srv.get("headers") or {}).items()}}
        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "synergyai-code-node", "version": "1.0"}}}
        last = None
        for url in candidates:
            try:
                sid, text = self.post(url, headers, init)
            except (urllib.error.URLError, OSError, ValueError) as e:
                last = e
                continue
            data = self.parse(text)
            if not isinstance(data, dict) or "error" in data:
                last = data.get("error") if isinstance(data, dict) else "invalid response"
                continue
            session = {**headers, **({"Mcp-Session-Id": sid} if sid else {})}
            self.post(url, session, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
            self.endpoints[slug] = (url, session)
            return self.endpoints[slug]
        raise ConnectionError(f"MCP server {slug!r} did not accept the handshake: {last}")

    def __call__(self, server: str, tool: str, args: dict) -> dict:
        if server not in self.servers:
            return {"isError": True, "content": [{"type": "text", "text": f"MCP server {server!r} is not in this workflow"}]}
        url, headers = self.connect(server)
        _, text = self.post(url, headers, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                           "params": {"name": tool, "arguments": args or {}}})
        match self.parse(text):
            case {"error": {"message": message}}:
                return {"isError": True, "content": [{"type": "text", "text": str(message)}]}
            case {"result": dict() as result}:
                return result
            case _:
                return {"isError": True, "content": [{"type": "text", "text": "invalid response"}]}
