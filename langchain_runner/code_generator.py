"""Generate a standalone Python script from a workflow definition.

The generated file is fully independent of the PHP backend. It connects
directly to MCP servers via JSON-RPC 2.0 over HTTP. At runtime it only needs:
  - ANTHROPIC_API_KEY env var
  - A user prompt (CLI argument)
  - MCP servers to be reachable at the URLs baked into the file
"""
from __future__ import annotations

import json
import textwrap
from typing import Any

from workflow_loader import WorkflowLoader

# ---------- helpers (same as graph_builder.py) ----------

def _node_type(n: dict) -> str:
    return n.get("node_type") or n.get("type") or (n.get("config") or {}).get("type") or ""

def _node_id(n: dict) -> str:
    return str(n.get("id") or n.get("drawflow_node_id") or n.get("_id"))

def _edge_from(e: dict) -> str:
    return str(e.get("from_node_id") or e.get("from") or e.get("source"))

def _edge_to(e: dict) -> str:
    return str(e.get("to_node_id") or e.get("to") or e.get("target"))

def _children(nid: str, edges: list[dict]) -> list[str]:
    return [_edge_to(e) for e in edges if _edge_from(e) == nid]

def _parents(nid: str, edges: list[dict]) -> list[str]:
    return [_edge_from(e) for e in edges if _edge_to(e) == nid]

def _display_name(node: dict) -> str:
    cfg = node.get("config") or {}
    return cfg.get("agent_name") or cfg.get("name") or node.get("name") or f"node_{_node_id(node)}"

def _safe_var(name: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in name).strip("_").lower()

def _topo_order(start_id: str, edges: list[dict], by_id: dict) -> list[str]:
    reachable: set[str] = set()
    stack = [start_id]
    while stack:
        nid = stack.pop()
        if nid in reachable:
            continue
        reachable.add(nid)
        stack.extend(_children(nid, edges))
    in_deg = {nid: 0 for nid in reachable}
    for e in edges:
        f, t = _edge_from(e), _edge_to(e)
        if f in reachable and t in reachable:
            in_deg[t] += 1
    order: list[str] = []
    queue = [nid for nid, d in in_deg.items() if d == 0]
    while queue:
        nid = queue.pop(0)
        order.append(nid)
        for child in _children(nid, edges):
            if child not in in_deg:
                continue
            in_deg[child] -= 1
            if in_deg[child] == 0:
                queue.append(child)
    return order


def _json_to_python(obj: Any) -> str:
    """Serialize a dict/list to a Python-valid literal string.

    json.dumps produces 'true'/'false'/'null' which are not valid Python.
    This converts to 'True'/'False'/'None'.
    """
    raw = json.dumps(obj, indent=4, ensure_ascii=False)
    raw = raw.replace(": true", ": True")
    raw = raw.replace(": false", ": False")
    raw = raw.replace(": null", ": None")
    return raw


# ---------- main generator ----------

async def generate_code(
    workflow_id: int,
    loader: WorkflowLoader,
) -> dict[str, str]:
    """Return {"filename": ..., "code": ...} for a standalone Python script."""

    workflow = await loader.get_workflow(workflow_id)
    wf_name = workflow.get("name", f"workflow_{workflow_id}")
    safe_name = _safe_var(wf_name) or f"workflow_{workflow_id}"

    graph = workflow.get("graph") or {}
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []

    by_id = {_node_id(n): n for n in nodes}
    start_nodes = [n for n in nodes if _node_type(n) == "start"]
    if not start_nodes:
        raise RuntimeError("No start node found.")
    start_node = start_nodes[0]
    start_id = _node_id(start_node)
    start_cfg = start_node.get("config") or start_node.get("data") or {}
    start_prompt = start_cfg.get("prompt") or ""
    start_documents = start_cfg.get("documents") or []
    order = _topo_order(start_id, edges, by_id)

    # Fetch MCP tools with server info (url, name, headers)
    mcp_tools = await loader.list_mcp_tools_with_servers()

    # Build server registry: server_url -> {name, headers}
    # and tool catalog: tool_name -> {server_url, description, input_schema}
    server_registry: dict[str, dict[str, Any]] = {}
    tool_catalog: dict[str, dict[str, Any]] = {}
    for t in mcp_tools:
        surl = t.get("server_url", "")
        sname = t.get("server_name", "")
        tname = t.get("tool_name") or t.get("name", "")
        if not surl or not tname:
            continue
        if surl not in server_registry:
            server_registry[surl] = {"name": sname}
        tool_catalog[tname] = {
            "server_url": surl,
            "description": t.get("tool_description") or t.get("description") or "",
            "input_schema": t.get("input_schema") or {},
        }

    # Resolve agent data for each agent node
    agent_data: dict[str, dict] = {}
    all_needed_tools: set[str] = set()
    for nid in order:
        node = by_id[nid]
        if _node_type(node) not in ("agent", "agent-template"):
            continue
        cfg = node.get("config") or {}
        agent_id = node.get("agent_id") or cfg.get("agent_id")
        system_prompt = cfg.get("systemPrompt") or cfg.get("instructions") or ""
        tool_names: list[str] = list(cfg.get("selectedTools") or [])

        if agent_id:
            try:
                agent = await loader.get_agent(int(agent_id))
                if not system_prompt:
                    system_prompt = (
                        agent.get("instructions")
                        or agent.get("system_prompt")
                        or agent.get("prompt")
                        or ""
                    )
                if not tool_names and isinstance(agent.get("tools"), list):
                    for t in agent["tools"]:
                        tname = t if isinstance(t, str) else (
                            t.get("name") or t.get("tool_name")
                            if isinstance(t, dict) else None
                        )
                        if tname:
                            if tname.startswith("mcp_"):
                                tname = tname[4:]
                            tool_names.append(tname)
            except Exception:
                pass

        all_needed_tools.update(tool_names)
        agent_data[nid] = {
            "display": _display_name(node),
            "system_prompt": system_prompt,
            "tool_names": tool_names,
        }

    # Filter catalog to only tools actually used by agents
    used_catalog = {k: v for k, v in tool_catalog.items() if k in all_needed_tools}
    # Flag tools that agents need but aren't available as MCP
    missing = all_needed_tools - set(tool_catalog.keys())

    edge_list = [(str(_edge_from(e)), str(_edge_to(e))) for e in edges]

    # ---- emit code ----
    lines: list[str] = []
    # Build node descriptions for the architecture doc
    node_descs: list[str] = []
    for nid in order:
        node = by_id[nid]
        ntype = _node_type(node)
        name = _display_name(node)
        if nid in agent_data:
            tc = len(agent_data[nid]["tool_names"])
            node_descs.append(f"  {nid} ({ntype}): {name} -- {tc} tool(s)")
        else:
            node_descs.append(f"  {nid} ({ntype}): {name}")
    edge_descs = [f"  {_edge_from(e)} -> {_edge_to(e)}" for e in edges]

    lines.append(f'"""Standalone LangGraph workflow: {wf_name}')
    lines.append("")
    lines.append("Auto-generated -- backend-independent.")
    lines.append("Connects directly to MCP servers via JSON-RPC 2.0 over HTTP.")
    lines.append("")
    lines.append("ARCHITECTURE")
    lines.append("============")
    lines.append("This script was generated from a visual workflow editor. It embeds:")
    lines.append("  - Agent system prompts and tool assignments (AGENTS dict)")
    lines.append("  - MCP server URLs and tool schemas (MCP_SERVERS, TOOL_CATALOG)")
    lines.append("  - Graph structure as edges + topological order (EDGES, ORDER)")
    lines.append("")
    lines.append("At runtime it builds a LangGraph StateGraph where each workflow")
    lines.append("node becomes a graph node. Agents use LangChain's ReAct pattern")
    lines.append("(create_react_agent) which lets the LLM decide when to call tools.")
    lines.append("")
    lines.append("DATA FLOW")
    lines.append("=========")
    lines.append("1. Start node stores the user prompt in shared state")
    lines.append("2. Each agent node receives labeled context from its direct")
    lines.append("   upstream predecessors (not all prior nodes -- only edge parents)")
    lines.append("3. The context message includes the original user prompt plus")
    lines.append("   each predecessor's output under a ### header with source name")
    lines.append("4. Output node collects its parents' outputs as final result")
    lines.append("")
    lines.append("GRAPH NODES")
    lines.append("===========")
    for nd in node_descs:
        lines.append(nd)
    lines.append("")
    lines.append("GRAPH EDGES")
    lines.append("===========")
    for ed in edge_descs:
        lines.append(ed)
    lines.append("")
    lines.append("TOOL EXECUTION")
    lines.append("==============")
    lines.append("Tools are called via the MCP protocol (Model Context Protocol).")
    lines.append("Each tool invocation:")
    lines.append("  1. Opens a JSON-RPC 2.0 session with the MCP server (initialize)")
    lines.append("  2. Sends a tools/call request with tool name + arguments")
    lines.append("  3. Parses the response (JSON or SSE format)")
    lines.append("  4. Returns the text content to the LLM agent")
    lines.append("Server URLs and tool schemas are baked in at generation time.")
    lines.append("")
    lines.append("REQUIREMENTS")
    lines.append("============")
    lines.append("  pip install langchain langchain-anthropic langgraph httpx pydantic")
    lines.append("  export ANTHROPIC_API_KEY=sk-ant-...")
    lines.append("")
    lines.append(f"Usage: python {safe_name}.py 'your prompt here'")
    if missing:
        lines.append("")
        lines.append(f"WARNING: These tools are NOT available as MCP servers")
        lines.append(f"and will be missing at runtime: {sorted(missing)}")
        lines.append("Convert them to MCP servers to enable full functionality.")
    lines.append('"""')
    lines.append("from __future__ import annotations")
    lines.append("")
    lines.append("import asyncio, json, os, sys, time")
    lines.append("from typing import Annotated, Any, TypedDict")
    lines.append("")
    lines.append("import httpx")
    lines.append("from langchain_anthropic import ChatAnthropic")
    lines.append("from langchain_core.messages import AIMessage, HumanMessage, SystemMessage")
    lines.append("from langchain_core.tools import StructuredTool")
    lines.append("from langgraph.graph import END, START, StateGraph")
    lines.append("try:")
    lines.append("    from langchain.agents import create_agent as create_react_agent")
    lines.append("except ImportError:")
    lines.append("    from langgraph.prebuilt import create_react_agent")
    lines.append("from pydantic import BaseModel, Field, create_model")
    lines.append("")
    lines.append("# LLM model to use. Override via MODEL_NAME env var.")
    lines.append("MODEL_NAME = os.environ.get('MODEL_NAME', 'claude-sonnet-4-5')")
    lines.append("")

    # ---------- MCP server registry (baked) ----------
    lines.append("# ==============================================================")
    lines.append("# MCP SERVER REGISTRY")
    lines.append("# Baked at generation time from the workflow editor's config.")
    lines.append("# Maps server URL -> metadata. If a server moves, update the URL here.")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(f"MCP_SERVERS = {_json_to_python(server_registry)}")
    lines.append("")

    # ---------- tool catalog (baked) ----------
    lines.append("# ==============================================================")
    lines.append("# TOOL CATALOG")
    lines.append("# Each entry maps a tool name to its MCP server URL and")
    lines.append("# JSON Schema for input validation. Only tools actually used")
    lines.append("# by agents in this workflow are included.")
    lines.append("# To add a tool: add an entry here AND reference it in the")
    lines.append("# agent's tool_names list in the AGENTS dict below.")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(f"TOOL_CATALOG = {_json_to_python(used_catalog)}")
    lines.append("")

    # ---------- MCP JSON-RPC client ----------
    lines.append("# ==============================================================")
    lines.append("# MCP CLIENT -- JSON-RPC 2.0 over HTTP")
    lines.append("#")
    lines.append("# The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.")
    lines.append("# Each tool call requires:")
    lines.append("#   1. URL normalization -- append /mcp if not present")
    lines.append("#   2. Session initialization -- send 'initialize' + notification")
    lines.append("#   3. Tool invocation -- send 'tools/call' with name + arguments")
    lines.append("#   4. Response parsing -- handle plain JSON or SSE-wrapped JSON")
    lines.append("#")
    lines.append("# Some MCP servers return Server-Sent Events (SSE) instead of")
    lines.append("# plain JSON. The parser handles both formats transparently.")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(textwrap.dedent('''\
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
        for line in text.split("\\n"):
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
        return "\\n".join(t for t in texts if t) or json.dumps(data.get("result"))[:8000]
    '''))

    # ---------- tool builder ----------
    lines.append("")
    lines.append("# ==============================================================")
    lines.append("# TOOL BUILDER")
    lines.append("# Converts the baked TOOL_CATALOG into LangChain StructuredTool")
    lines.append("# objects. Each tool gets a dynamically-built Pydantic model for")
    lines.append("# input validation (from the JSON Schema), and a callable that")
    lines.append("# invokes the MCP server. The LLM agent calls these like any")
    lines.append("# other LangChain tool -- it doesn't know about MCP internals.")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(textwrap.dedent('''\
    def build_tools_from_catalog() -> dict[str, StructuredTool]:
        """Build LangChain StructuredTool wrappers from TOOL_CATALOG.

        For each tool:
        1. Parse the JSON Schema into a Pydantic model (for LLM argument validation)
        2. Create a callable that sends the MCP JSON-RPC request
        3. Wrap both into a LangChain StructuredTool

        Returns: dict mapping tool_name -> StructuredTool
        """
        type_map = {"string": str, "integer": int, "number": float,
                    "boolean": bool, "array": list, "object": dict}
        catalog = {}
        for name, info in TOOL_CATALOG.items():
            schema = info.get("input_schema") or {}
            props = schema.get("properties", {}) if isinstance(schema, dict) else {}
            required = set(schema.get("required", []) if isinstance(schema, dict) else [])
            fields = {}
            for pname, pspec in props.items():
                spec = pspec if isinstance(pspec, dict) else {}
                ptype = type_map.get(spec.get("type", "string"), str)
                default = ... if pname in required else None
                fields[pname] = (ptype, Field(default, description=spec.get("description", "")))
            args_model = create_model(f"{name}Args", **fields) if fields else create_model(f"{name}Args")

            server_url = info["server_url"]
            def make_fn(n=name, s=server_url):
                def invoke(**kwargs):
                    print(f"  [tool] -> {n}({json.dumps(kwargs, default=str)[:120]})")
                    result = _call_mcp_tool(s, n, kwargs)
                    print(f"  [tool] ← {n}: {result[:120]}")
                    return result
                return invoke

            catalog[name] = StructuredTool.from_function(
                func=make_fn(),
                name=name,
                description=info.get("description") or f"MCP tool {name}",
                args_schema=args_model,
            )
        return catalog
    '''))

    # ---------- state ----------
    lines.append("")
    lines.append("# ==============================================================")
    lines.append("# LANGGRAPH STATE")
    lines.append("#")
    lines.append("# WFState is the shared state that flows through the graph.")
    lines.append("# - user_prompt: the original user input (immutable after start)")
    lines.append("# - node_outputs: dict of node_id -> {source, text} -- each node")
    lines.append("#   writes its output here. Uses a merge reducer so parallel")
    lines.append("#   branches can both contribute without conflicts.")
    lines.append("# - final_output: set by the output node as the workflow result")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(textwrap.dedent('''\
    def _merge(left: dict | None, right: dict | None) -> dict:
        """Reducer for node_outputs -- merges dicts from parallel branches.

        When two nodes run in parallel (e.g., diamond graph), both write to
        node_outputs. LangGraph needs a reducer to combine them. This does a
        shallow merge where the right (newer) value wins on key conflicts.
        """
        out = dict(left or {})
        out.update(right or {})
        return out

    class WFState(TypedDict, total=False):
        """Shared state for the workflow graph.

        Attributes:
            user_prompt: The original user input, set once at the start.
            node_outputs: Each node stores its output as {source, text}.
                          Annotated with _merge so parallel nodes don't conflict.
            final_output: The final text result, set by the output node.
        """
        user_prompt: str
        node_outputs: Annotated[dict[str, dict[str, str]], _merge]
        final_output: str
    '''))

    # ---------- datetime injector ----------
    lines.append("")
    lines.append("# ==============================================================")
    lines.append("# DATETIME INJECTOR")
    lines.append("#")
    lines.append("# LLMs have knowledge cutoffs and don't know the current date.")
    lines.append("# inject_datetime() prepends a short context block to each agent's")
    lines.append("# system prompt so the agent reasons with today's actual date.")
    lines.append("# Also resolves any [date]/[weekday]/[year]/[time] placeholders")
    lines.append("# that may exist inside the prompt text (legacy templating).")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(textwrap.dedent('''\
    def inject_datetime(system_prompt: str) -> str:
        """Inject current date/time into a system prompt.

        Prepends a dated header so the LLM knows "today" relative to its
        knowledge cutoff. Also replaces [date], [weekday], [year], [time]
        placeholders in the prompt body with live values.
        """
        from datetime import datetime as _dt
        now = _dt.now()
        date_str = now.strftime("%Y-%m-%d")
        weekday_str = now.strftime("%A")
        year_str = now.strftime("%Y")
        time_str = now.strftime("%H:%M")
        iso_str = now.strftime("%Y-%m-%d %H:%M %Z").strip()

        prompt = system_prompt
        prompt = prompt.replace("[date]", date_str)
        prompt = prompt.replace("[weekday]", weekday_str)
        prompt = prompt.replace("[year]", year_str)
        prompt = prompt.replace("[time]", time_str)

        header = (
            f"## Current Date & Time\\n"
            f"Today is {weekday_str}, {date_str} ({time_str}).\\n"
            f"Use this as the reference for any date-sensitive reasoning "
            f"(recent research, latest news, time-relative phrasing, etc.).\\n\\n"
        )
        return header + prompt
    '''))

    # ---------- context builder ----------
    lines.append("")
    lines.append("# ==============================================================")
    lines.append("# CONTEXT BUILDER")
    lines.append("#")
    lines.append("# Each agent receives a structured message containing:")
    lines.append("#   1. The original user request (for reference)")
    lines.append("#   2. Labeled outputs from direct upstream agents only")
    lines.append("# This matches the PHP backend's 'labeled' merge strategy.")
    lines.append("# The agent's system prompt tells it what to DO with this input.")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(textwrap.dedent('''\
    def build_context(user_prompt: str, parent_ids: list[str], outputs: dict) -> str:
        """Build the HumanMessage content for an agent node.

        Args:
            user_prompt: The original user request
            parent_ids: Node IDs of direct predecessors (from EDGES)
            outputs: Current node_outputs state dict

        Returns:
            Formatted string with labeled inputs from each predecessor.
            The agent sees this as a single HumanMessage alongside its
            SystemMessage (the agent's instructions/persona).
        """
        parts = [f'Original user request: "{user_prompt}"', "",
                 "You are receiving the following inputs from upstream agents in this workflow.",
                 "Use them as source material to perform your task as defined in your system prompt.",
                 "", "---"]
        valid = [(p, outputs[p]) for p in parent_ids if p in outputs]
        if not valid:
            parts.append("(no upstream inputs -- respond to the original user request directly)")
        else:
            for pid, out in valid:
                parts += ["", f"### Input from: {out.get('source', pid)}", "", out.get("text", ""), "", "---"]
        return "\\n".join(parts)
    '''))

    # ---------- start node config ----------
    lines.append("")
    lines.append("# ==============================================================")
    lines.append("# START NODE")
    lines.append("#")
    lines.append("# The start node feeds the prompt into the workflow.")
    lines.append("# DEFAULT_PROMPT is baked from the workflow's start node config.")
    lines.append("# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.")
    lines.append("# If the workflow has documents attached to the start node,")
    lines.append("# they are prepended to the prompt (matching the editor behavior).")
    lines.append("# ==============================================================")
    lines.append("")
    prompt_escaped = start_prompt.replace('\\', '\\\\').replace('"""', '\\"\\"\\"')
    lines.append('DEFAULT_PROMPT = """')
    for pline in prompt_escaped.split("\n"):
        if len(pline) <= 80:
            lines.append(pline)
        else:
            lines.append(textwrap.fill(pline, width=80))
    lines.append('""".strip()')
    lines.append("")
    if start_documents:
        lines.append(f"START_DOCUMENTS = {_json_to_python(start_documents)}")
    else:
        lines.append("START_DOCUMENTS = []")
    lines.append("")

    # ---------- embedded agent definitions ----------
    lines.append("# ==============================================================")
    lines.append("# AGENT DEFINITIONS")
    lines.append("#")
    lines.append("# Each agent is identified by its workflow node ID.")
    lines.append("#   display:       Human-readable name (for logs and context labels)")
    lines.append("#   system_prompt: The agent's persona/instructions (sent as SystemMessage)")
    lines.append("#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)")
    lines.append("#")
    lines.append("# To modify an agent: edit its system_prompt or tool_names here.")
    lines.append("# To add a new agent: add an entry, create edges in EDGES, and")
    lines.append("# include the node ID in ORDER at the right topological position.")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append("AGENTS = {")
    for nid, ad in agent_data.items():
        tools_list = json.dumps(ad["tool_names"])
        prompt_text = ad["system_prompt"].replace('\\', '\\\\').replace('"""', '\\"\\"\\"')
        wrapped_lines: list[str] = []
        for pline in prompt_text.split("\n"):
            if len(pline) <= 80:
                wrapped_lines.append(pline)
            else:
                wrapped_lines.extend(textwrap.fill(pline, width=80).split("\n"))
        lines.append(f'    "{nid}": {{')
        lines.append(f'        "display": {json.dumps(ad["display"])},')
        lines.append(f'        "system_prompt": """')
        for wl in wrapped_lines:
            lines.append(wl)
        lines.append('""",')
        lines.append(f'        "tool_names": {tools_list},')
        lines.append(f'    }},')
    lines.append("}")
    lines.append("")

    # ---------- edge data ----------
    lines.append("# ==============================================================")
    lines.append("# GRAPH STRUCTURE")
    lines.append("#")
    lines.append("# EDGES: directed connections as (from_node_id, to_node_id) tuples.")
    lines.append("# ORDER: topological execution order (Kahn's algorithm).")
    lines.append("#        Guarantees every node runs after all its predecessors.")
    lines.append("# NODE_TYPES: maps node_id -> type ('start', 'agent', 'output').")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(f"EDGES = {_json_to_python(edge_list)}")
    lines.append(f"ORDER = {_json_to_python(order)}")
    lines.append("")
    lines.append(textwrap.dedent('''\
    def parents(nid: str) -> list[str]:
        """Get direct predecessor node IDs (nodes with edges INTO this node)."""
        return [f for f, t in EDGES if t == nid]

    def children(nid: str) -> list[str]:
        """Get direct successor node IDs (nodes this node has edges TO)."""
        return [t for f, t in EDGES if f == nid]
    '''))

    type_map: dict[str, str] = {}
    for nid in order:
        type_map[nid] = _node_type(by_id[nid])

    lines.append(f"NODE_TYPES = {_json_to_python(type_map)}")
    lines.append("")

    # ---------- main function ----------
    lines.append("# ==============================================================")
    lines.append("# MAIN EXECUTION")
    lines.append("#")
    lines.append("# run() builds the LangGraph, wires edges, and executes it.")
    lines.append("# Each node type has a factory function (make_start, make_agent,")
    lines.append("# make_output) that returns a callable for LangGraph to invoke.")
    lines.append("#")
    lines.append("# Agent nodes use LangChain's ReAct pattern: the LLM receives")
    lines.append("# the system prompt + upstream context, and can call tools in a")
    lines.append("# loop until it produces a final answer.")
    lines.append("# ==============================================================")
    lines.append("")
    lines.append(textwrap.dedent('''\
    async def run(user_prompt: str):
        """Execute the workflow with the given user prompt.

        Steps:
        1. Build LangChain tools from the embedded TOOL_CATALOG
        2. Initialize the LLM (Anthropic Claude)
        3. Construct a LangGraph StateGraph with nodes from ORDER
        4. Wire edges from EDGES (respecting topological order)
        5. Compile and invoke the graph
        6. Return the final output text
        """
        print("[info] Building tools from embedded catalog...")
        catalog = build_tools_from_catalog()
        print(f"[info] {len(catalog)} MCP tools ready: {sorted(catalog.keys())}")
    '''))

    if missing:
        lines.append(f'    print("[warn] Missing tools (not MCP): {sorted(missing)}")')
        lines.append("")

    lines.append(textwrap.dedent('''\
        llm = ChatAnthropic(model=MODEL_NAME, temperature=0)
        sg = StateGraph(WFState)

        for nid in ORDER:
            ntype = NODE_TYPES.get(nid, "")

            if ntype == "start":
                def make_start(n=nid):
                    def _run(state):
                        text = state.get("user_prompt", "")
                        # Prepend attached documents (baked from workflow)
                        if START_DOCUMENTS:
                            doc_parts = ["## Attached Documents\\n"]
                            for doc in START_DOCUMENTS:
                                doc_parts.append(f"### {doc.get('name', 'Document')}\\n")
                            text = "\\n".join(doc_parts) + "\\n---\\n\\n" + text
                        print(f"[node] [{n}] start -- {len(text)} chars")
                        return {"node_outputs": {n: {"source": "start", "text": text}}}
                    return _run
                sg.add_node(nid, make_start())

            elif ntype in ("agent", "agent-template"):
                def make_agent(n=nid):
                    async def _run(state):
                        ad = AGENTS[n]
                        tool_names = ad["tool_names"]
                        tools = [catalog[t] for t in tool_names if t in catalog]
                        print(f"[node] [{n}] {ad['display']!r} -- {len(tools)} tools")

                        ctx = build_context(state.get("user_prompt", ""), parents(n), state.get("node_outputs", {}))
                        msgs = []
                        if ad["system_prompt"]:
                            msgs.append(SystemMessage(content=inject_datetime(ad["system_prompt"])))
                        msgs.append(HumanMessage(content=ctx))

                        agent = create_react_agent(llm, tools)
                        result = await agent.ainvoke({"messages": msgs})
                        final = result["messages"][-1]
                        text = final.content if isinstance(final, AIMessage) else str(final)
                        if isinstance(text, list):
                            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
                        print(f"[node] [{n}] done -- {len(text)} chars")
                        return {"node_outputs": {n: {"source": ad["display"], "text": text}}}
                    return _run
                sg.add_node(nid, make_agent())

            elif ntype == "output":
                def make_output(n=nid):
                    def _run(state):
                        pids = parents(n)
                        outs = state.get("node_outputs", {})
                        if len(pids) == 1 and pids[0] in outs:
                            final = outs[pids[0]]["text"]
                        else:
                            blocks = [f"## {outs[p]['source']}\\n\\n{outs[p]['text']}" for p in pids if p in outs]
                            final = "\\n\\n---\\n\\n".join(blocks)
                        print(f"[node] [{n}] output -- {len(final)} chars")
                        return {"final_output": final}
                    return _run
                sg.add_node(nid, make_output())

            else:
                sg.add_node(nid, lambda s: {})

        # Wire edges
        pos = {n: i for i, n in enumerate(ORDER)}
        sg.add_edge(START, ORDER[0])
        for nid in ORDER:
            for child in children(nid):
                if child in pos and pos[child] > pos[nid]:
                    sg.add_edge(nid, child)
        for nid in ORDER:
            if not children(nid):
                sg.add_edge(nid, END)

        graph = sg.compile()
        print("[info] Running...")
        result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})
        return result.get("final_output", "")


    if __name__ == "__main__":
        from pathlib import Path
        from datetime import datetime

        prompt = " ".join(sys.argv[1:]) or DEFAULT_PROMPT or "Hello"
        print(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
        output = asyncio.run(run(prompt))
        print("\\n" + "=" * 60)
        print("FINAL OUTPUT")
        print("=" * 60)
        print(output)

        # Save result to file in the same directory as this script
        script_dir = Path(__file__).parent
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        script_stem = Path(__file__).stem
        result_file = script_dir / f"{script_stem}_result_{ts}.md"
        result_file.write_text(
            f"# {script_stem} -- Result\\n\\n"
            f"**Prompt:** {prompt}\\n\\n"
            f"**Date:** {datetime.now().isoformat()}\\n\\n"
            f"---\\n\\n{output}\\n",
            encoding="utf-8",
        )
        print(f"\\nResult saved to: {result_file}")
    '''))

    code = "\n".join(lines)
    filename = f"{safe_name}.py"
    return {"filename": filename, "code": code}
