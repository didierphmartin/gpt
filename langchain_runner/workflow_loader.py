"""Fetch workflow definitions from the PHP backend."""
from __future__ import annotations

import httpx
from typing import Any


class WorkflowLoader:
    def __init__(self, backend_url: str, jwt: str):
        self.backend_url = backend_url.rstrip("/")
        self.headers = {"Authorization": f"Bearer {jwt}"}

    async def list_workflows(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{self.backend_url}/api/v1/workflows",
                headers=self.headers,
            )
            r.raise_for_status()
            payload = r.json()
        items = payload.get("data") or payload.get("workflows") or payload
        return items if isinstance(items, list) else []

    async def get_workflow(self, workflow_id: int) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{self.backend_url}/api/v1/workflows/{workflow_id}",
                headers=self.headers,
                params={"include_graph": "true"},
            )
            r.raise_for_status()
            payload = r.json()
        return payload.get("data") or payload

    async def list_all_tools(self) -> list[dict[str, Any]]:
        """All tools — built-in PHP + MCP — via the unified tools endpoint.

        Each item: {name, description, type ('builtin'|'mcp'), input_schema, ...}
        """
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{self.backend_url}/api/v1/tools",
                headers=self.headers,
                params={"type": "all"},
            )
            r.raise_for_status()
            payload = r.json()
        return payload.get("tools", [])

    async def list_mcp_servers(self) -> list[dict[str, Any]]:
        """Enabled MCP servers with URLs and tool counts."""
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{self.backend_url}/api/v1/mcp/servers",
                headers=self.headers,
            )
            r.raise_for_status()
            payload = r.json()
        return payload.get("servers", [])

    async def list_mcp_tools_with_servers(self) -> list[dict[str, Any]]:
        """MCP tools with server_url and server_name per tool."""
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{self.backend_url}/api/v1/mcp/servers/all-tools",
                headers=self.headers,
            )
            r.raise_for_status()
            payload = r.json()
        return payload.get("tools", [])

    async def get_agent(self, agent_id: int) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(
                f"{self.backend_url}/api/v1/agents/{agent_id}",
                headers=self.headers,
            )
            r.raise_for_status()
            payload = r.json()
        return payload.get("data") or payload
