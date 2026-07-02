"""Standalone Google ADK workflow: diamond
Auto-generated -- backend-independent. Self-contained: MCP + skills run
in this program's own Python environment.

requirements:
    pip install google-adk litellm httpx
"""
import asyncio, json, os, subprocess, sys, threading, time, urllib.request
import httpx
from typing import Any

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
_LITELLM_PREFIX = {
    "claude": "anthropic/", "anthropic": "anthropic/",
    "openai": "openai/", "grok": "xai/", "xai": "xai/",
    "mistral": "mistral/", "groq": "groq/",
}

def _make_model(provider: str, model: str):
    p = (provider or "").lower()
    if p in ("gemini", "google", "google-genai", ""):
        return model or "gemini-2.5-pro"
    prefix = _LITELLM_PREFIX.get(p, p + "/")
    spec = model if "/" in model else prefix + model
    return LiteLlm(model=spec)
MCP_SERVERS = {}
TOOL_CATALOG = {}
def _normalize_mcp_url(url: str) -> str:
    """Ensure the URL points to the MCP endpoint.

    - If it already ends with /mcp, leave it alone.
    - If it ends with a .php file, it IS the endpoint already (XAMPP-style
      MCP server scripts like mcp-server.php). Don't append anything.
    - Otherwise, append /mcp per the MCP convention.
    """
    url = url.rstrip("/")
    if url.endswith("/mcp") or url.endswith(".php"):
        return url
    return url + "/mcp"

def _init_mcp_session(url: str, headers: dict) -> bool:
    """Initialize an MCP session with the server.

    The MCP protocol requires a handshake before tool calls:
    1. Client sends 'initialize' with protocol version and capabilities
    2. Server responds with its capabilities
    3. Client sends 'notifications/initialized' to confirm

    Returns True on success, False on failure.
    """
    mcp_url = _normalize_mcp_url(url)
    init_req = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "LangGraph-Workflow", "version": "1.0.0"},
            "capabilities": {}
        }
    }
    try:
        with httpx.Client(timeout=30) as c:
            r = c.post(mcp_url, json=init_req, headers=headers)
            r.raise_for_status()
            data = _parse_mcp_response(r.text)
            if data is None or "error" in (data or {}):
                return False
            # Send initialized notification
            c.post(mcp_url, json={
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {}
            }, headers=headers)
            return True
    except Exception as e:
        print(f"[warn] MCP init failed for {url}: {e}")
        return False

def _parse_mcp_response(text: str) -> dict | None:
    """Parse a JSON-RPC response from an MCP server.

    MCP servers may respond in two formats:
    - Plain JSON: standard JSON-RPC response body
    - SSE (Server-Sent Events): lines prefixed with 'data:' containing JSON
    This function tries plain JSON first, then falls back to SSE parsing.
    """
    import json as _json
    try:
        return _json.loads(text)
    except _json.JSONDecodeError:
        pass
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data:
                try:
                    return _json.loads(data)
                except _json.JSONDecodeError:
                    continue
    return None

def _call_mcp_tool(server_url: str, tool_name: str,
                   arguments: dict) -> str:
    """Call a tool on an MCP server via JSON-RPC 2.0.

    Sequence: init session -> send tools/call -> parse response -> extract text.
    The MCP response contains a 'content' array; we extract all text items
    and join them. If no text is found, falls back to raw JSON.
    """
    mcp_url = _normalize_mcp_url(server_url)
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream, */*"}

    _init_mcp_session(server_url, headers)

    request = {
        "jsonrpc": "2.0", "id": int(time.time()),
        "method": "tools/call",
        "params": {"name": tool_name,
                   "arguments": arguments or {}}
    }
    try:
        with httpx.Client(timeout=180) as c:
            r = c.post(mcp_url, json=request, headers=headers)
            r.raise_for_status()
            data = _parse_mcp_response(r.text)
    except Exception as e:
        return json.dumps({"error": str(e)})

    if data is None:
        return json.dumps({"error": "invalid response"})
    if "error" in data:
        return json.dumps({"error": data["error"].get("message", "unknown")})

    content = (data.get("result") or {}).get("content", [])
    texts = [c.get("text", "") for c in content
             if isinstance(c, dict) and c.get("type") == "text"]
    return "\n".join(t for t in texts if t) or json.dumps(data.get("result"))[:8000]

def build_tools_from_catalog() -> dict:
    return {}
catalog = build_tools_from_catalog()
node_2 = LlmAgent(
    name="node_2",
    model=_make_model("claude", "m"),
    instruction="A",
    tools=[],
    output_key="node_2",
)

node_3 = LlmAgent(
    name="node_3",
    model=_make_model("gemini", "g"),
    instruction="B",
    tools=[],
    output_key="node_3",
)
node_4 = LlmAgent(
    name="node_4",
    model=_make_model("claude", "m"),
    instruction="Consolidate the following results into the final answer.\n\n{node_2}\n{node_3}",
    tools=[],
    output_key="node_4",
)
root_agent = SequentialAgent(
    name="workflow",
    sub_agents=[
    ParallelAgent(name="layer_1", sub_agents=[node_2, node_3]),
    node_4
    ],
)
async def main(user_prompt: str = "GO"):
    session_service = InMemorySessionService()
    runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)
    session = await session_service.create_session(app_name="workflow", user_id="local", state={})
    final = ""
    content = types.Content(role="user", parts=[types.Part(text=user_prompt)])
    async for event in runner.run_async(user_id="local", session_id=session.id, new_message=content):
        if event.is_final_response() and event.content and event.content.parts:
            final = event.content.parts[0].text or final
    os.makedirs("outputs", exist_ok=True)
    print(final)
    return final

if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "GO"))
