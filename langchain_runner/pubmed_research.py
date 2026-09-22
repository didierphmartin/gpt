"""Standalone LangGraph workflow: Pubmed research

Auto-generated — backend-independent.
Connects directly to MCP servers via JSON-RPC 2.0 over HTTP.

ARCHITECTURE
============
This script was generated from a visual workflow editor. It embeds:
  - Agent system prompts and tool assignments (AGENTS dict)
  - MCP server URLs and tool schemas (MCP_SERVERS, TOOL_CATALOG)
  - Graph structure as edges + topological order (EDGES, ORDER)

At runtime it builds a LangGraph StateGraph where each workflow
node becomes a graph node. Agents use LangChain's ReAct pattern
(create_react_agent) which lets the LLM decide when to call tools.

DATA FLOW
=========
1. Start node stores the user prompt in shared state
2. Each agent node receives labeled context from its direct
   upstream predecessors (not all prior nodes — only edge parents)
3. The context message includes the original user prompt plus
   each predecessor's output under a ### header with source name
4. Output node collects its parents' outputs as final result

GRAPH NODES
===========
  461 (start): node_461
  462 (agent): PubMed Researcher — 1 tool(s)
  463 (agent): Research Verifier — 1 tool(s)
  464 (output): node_464

GRAPH EDGES
===========
  461 → 462
  462 → 463
  462 → 464
  463 → 464

TOOL EXECUTION
==============
Tools are called via the MCP protocol (Model Context Protocol).
Each tool invocation:
  1. Opens a JSON-RPC 2.0 session with the MCP server (initialize)
  2. Sends a tools/call request with tool name + arguments
  3. Parses the response (JSON or SSE format)
  4. Returns the text content to the LLM agent
Server URLs and tool schemas are baked in at generation time.

REQUIREMENTS
============
  pip install langchain langchain-anthropic langgraph httpx pydantic
  export ANTHROPIC_API_KEY=sk-ant-...

Usage: python pubmed_research.py 'your prompt here'
"""
from __future__ import annotations

import asyncio, json, os, sys, time
from typing import Annotated, Any, TypedDict

import httpx
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph
try:
    from langchain.agents import create_agent as create_react_agent
except ImportError:
    from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel, Field, create_model

# LLM model to use. Override via MODEL_NAME env var.
MODEL_NAME = os.environ.get('MODEL_NAME', 'claude-sonnet-4-5')

# ══════════════════════════════════════════════════════════════
# MCP SERVER REGISTRY
# Baked at generation time from the workflow editor's config.
# Maps server URL → metadata. If a server moves, update the URL here.
# ══════════════════════════════════════════════════════════════

MCP_SERVERS = {
    "http://localhost/finance/mcp-server.php": {
        "name": "Financial News"
    },
    "http://localhost/image-server/mcp": {
        "name": "Image-server"
    },
    "http://localhost/metals/public/mcp": {
        "name": "Metals News"
    },
    "https://synergyaichat.com/pubmed/mcp.php": {
        "name": "pubmed"
    },
    "http://localhost/tradingview/mcp": {
        "name": "TradingView"
    },
    "http://localhost/video-server/mcp": {
        "name": "video-server"
    }
}

# ══════════════════════════════════════════════════════════════
# TOOL CATALOG
# Each entry maps a tool name to its MCP server URL and
# JSON Schema for input validation. Only tools actually used
# by agents in this workflow are included.
# To add a tool: add an entry here AND reference it in the
# agent's tool_names list in the AGENTS dict below.
# ══════════════════════════════════════════════════════════════

TOOL_CATALOG = {
    "pubmed_search": {
        "server_url": "https://synergyaichat.com/pubmed/mcp.php",
        "description": "Search PubMed for biomedical literature. Returns article summaries including titles, authors, abstracts, and publication details. Supports MeSH terms and advanced query syntax.",
        "input_schema": {
            "type": "object",
            "required": [
                "query"
            ],
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query. Can use PubMed syntax like [MeSH Terms], [Title], [Author]. Use natural language with tags like [mesh:term], [title:text], [author:name]."
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Offset for pagination (default: 0)"
                },
                "max_results": {
                    "type": "integer",
                    "maximum": 10000,
                    "minimum": 1,
                    "description": "Maximum number of results to return (default: configured value)"
                },
                "include_abstracts": {
                    "type": "boolean",
                    "default": True,
                    "description": "Whether to fetch full abstracts (requires additional API call)"
                }
            }
        }
    }
}

# ══════════════════════════════════════════════════════════════
# MCP CLIENT — JSON-RPC 2.0 over HTTP
#
# The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.
# Each tool call requires:
#   1. URL normalization — append /mcp if not present
#   2. Session initialization — send 'initialize' + notification
#   3. Tool invocation — send 'tools/call' with name + arguments
#   4. Response parsing — handle plain JSON or SSE-wrapped JSON
#
# Some MCP servers return Server-Sent Events (SSE) instead of
# plain JSON. The parser handles both formats transparently.
# ══════════════════════════════════════════════════════════════

def _normalize_mcp_url(url: str) -> str:
    """Ensure the URL ends with /mcp (MCP convention)."""
    url = url.rstrip("/")
    if not url.endswith("/mcp"):
        url += "/mcp"
    return url

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

    Sequence: init session → send tools/call → parse response → extract text.
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


# ══════════════════════════════════════════════════════════════
# TOOL BUILDER
# Converts the baked TOOL_CATALOG into LangChain StructuredTool
# objects. Each tool gets a dynamically-built Pydantic model for
# input validation (from the JSON Schema), and a callable that
# invokes the MCP server. The LLM agent calls these like any
# other LangChain tool — it doesn't know about MCP internals.
# ══════════════════════════════════════════════════════════════

def build_tools_from_catalog() -> dict[str, StructuredTool]:
    """Build LangChain StructuredTool wrappers from TOOL_CATALOG.

    For each tool:
    1. Parse the JSON Schema into a Pydantic model (for LLM argument validation)
    2. Create a callable that sends the MCP JSON-RPC request
    3. Wrap both into a LangChain StructuredTool

    Returns: dict mapping tool_name → StructuredTool
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
                print(f"  [tool] → {n}({json.dumps(kwargs, default=str)[:120]})")
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


# ══════════════════════════════════════════════════════════════
# LANGGRAPH STATE
#
# WFState is the shared state that flows through the graph.
# - user_prompt: the original user input (immutable after start)
# - node_outputs: dict of node_id → {source, text} — each node
#   writes its output here. Uses a merge reducer so parallel
#   branches can both contribute without conflicts.
# - final_output: set by the output node as the workflow result
# ══════════════════════════════════════════════════════════════

def _merge(left: dict | None, right: dict | None) -> dict:
    """Reducer for node_outputs — merges dicts from parallel branches.

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


# ══════════════════════════════════════════════════════════════
# DATETIME INJECTOR
#
# LLMs have knowledge cutoffs and don't know the current date.
# inject_datetime() prepends a short context block to each agent's
# system prompt so the agent reasons with today's actual date.
# Also resolves any [date]/[weekday]/[year]/[time] placeholders
# that may exist inside the prompt text (legacy templating).
# ══════════════════════════════════════════════════════════════

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
        f"## Current Date & Time\n"
        f"Today is {weekday_str}, {date_str} ({time_str}).\n"
        f"Use this as the reference for any date-sensitive reasoning "
        f"(recent research, latest news, time-relative phrasing, etc.).\n\n"
    )
    return header + prompt


# ══════════════════════════════════════════════════════════════
# CONTEXT BUILDER
#
# Each agent receives a structured message containing:
#   1. The original user request (for reference)
#   2. Labeled outputs from direct upstream agents only
# This matches the PHP backend's 'labeled' merge strategy.
# The agent's system prompt tells it what to DO with this input.
# ══════════════════════════════════════════════════════════════

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
        parts.append("(no upstream inputs — respond to the original user request directly)")
    else:
        for pid, out in valid:
            parts += ["", f"### Input from: {out.get('source', pid)}", "", out.get("text", ""), "", "---"]
    return "\n".join(parts)


# ══════════════════════════════════════════════════════════════
# START NODE
#
# The start node feeds the prompt into the workflow.
# DEFAULT_PROMPT is baked from the workflow's start node config.
# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.
# If the workflow has documents attached to the start node,
# they are prepended to the prompt (matching the editor behavior).
# ══════════════════════════════════════════════════════════════

DEFAULT_PROMPT = """
make a short report on the link between vitamin D and the immune system
""".strip()

START_DOCUMENTS = []

# ══════════════════════════════════════════════════════════════
# AGENT DEFINITIONS
#
# Each agent is identified by its workflow node ID.
#   display:       Human-readable name (for logs and context labels)
#   system_prompt: The agent's persona/instructions (sent as SystemMessage)
#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)
#
# To modify an agent: edit its system_prompt or tool_names here.
# To add a new agent: add an entry, create edges in EDGES, and
# include the node ID in ORDER at the right topological position.
# ══════════════════════════════════════════════════════════════

AGENTS = {
    "462": {
        "display": "PubMed Researcher",
        "system_prompt": """
# System Prompt — PubMed Researcher Agent

## Scope
  This agent ONLY handles queries related to biology and biomedical science.
  Any questions outside this domain should be politely declined with a brief
explanation that this agent specializes  exclusively in biology and biomedical
science.

## Role & Identity
You are the **PubMed Researcher**, a specialized scientific literature agent.
Your
expertise lies in querying PubMed and synthesizing peer-reviewed biomedical and
life
science literature into clear, accurate, and well-structured research documents.

You operate within a multi-agent pipeline. You receive research requests from
the
**Manager Agent** and return a structured markdown document containing your
findings.
You do not interact with the end user directly.

## Core Responsibilities

### On Receiving a Request
When the Manager Agent forwards a research query to you:
1. Identify the key biomedical concepts, keywords, and scope of the question.
2. Formulate appropriate PubMed search queries (using MeSH terms and Boolean
   operators where relevant).
3. Retrieve and synthesize findings from relevant, recent, and high-quality
   peer-reviewed publications.
4. Prioritize systematic reviews, meta-analyses, and RCTs when available.
5. Assemble your findings into a well-structured markdown research document
   (see format below).

### Output Format
Return a single markdown document using the following structure:
```markdown
# Research Report: [Topic]

## Summary
A concise paragraph (3–5 sentences) summarizing the key findings.

## Background
Contextual information to frame the topic.

## Key Findings
Detailed synthesis of findings from the literature, organized thematically
or chronologically as appropriate. Cite sources inline using this format:
(Author et al., Year, PMID: XXXXXXXX).

## Evidence Table (optional)
| Study | Design | Population | Key Result |
|-------|--------|------------|------------|

## Limitations & Gaps
Known limitations in the current evidence base.

## Conclusion
A brief, evidence-based conclusion.

## References
- Author et al. (Year). Title. *Journal*. PMID: XXXXXXXX.
```

## Quality Standards
- Only reference peer-reviewed literature accessible via PubMed.
- Do not fabricate PMIDs, author names, or study findings. If evidence is
  limited, explicitly state so.
- Maintain scientific objectivity — do not editorialize or overstate findings.
- Flag conflicting evidence when it exists.
- Aim for depth and accuracy over brevity.

## Persona
You are methodical, scientifically rigorous, and precise. You approach every
query
as a trained biomedical researcher would, prioritizing evidence quality and
intellectual honesty above all else.
Today is [date] ([weekday]).
  The current year is [year].   
""",
        "tool_names": ["pubmed_search"],
    },
    "463": {
        "display": "Research Verifier",
        "system_prompt": """
You are a Research Verifier. Your job is to verify research accuracy.

  ## HOW TO VERIFY
  1. For each PMID mentioned, use pubmed_search to confirm it exists
  2. Check that the study summaries match the actual abstracts
  3. Flag any PMIDs that cannot be found or have incorrect information

  ## RESPONSE FORMAT
  - List verified PMIDs with ✓
  - List unverified/incorrect PMIDs with ✗
  - End with: "VERIFICATION COMPLETE"

  Do NOT tell the manager to redo research. Just report your findings and mark
complete.'
""",
        "tool_names": ["pubmed_search"],
    },
}

# ══════════════════════════════════════════════════════════════
# GRAPH STRUCTURE
#
# EDGES: directed connections as (from_node_id, to_node_id) tuples.
# ORDER: topological execution order (Kahn's algorithm).
#        Guarantees every node runs after all its predecessors.
# NODE_TYPES: maps node_id → type ('start', 'agent', 'output').
# ══════════════════════════════════════════════════════════════

EDGES = [
    [
        "461",
        "462"
    ],
    [
        "462",
        "463"
    ],
    [
        "462",
        "464"
    ],
    [
        "463",
        "464"
    ]
]
ORDER = [
    "461",
    "462",
    "463",
    "464"
]

def parents(nid: str) -> list[str]:
    """Get direct predecessor node IDs (nodes with edges INTO this node)."""
    return [f for f, t in EDGES if t == nid]

def children(nid: str) -> list[str]:
    """Get direct successor node IDs (nodes this node has edges TO)."""
    return [t for f, t in EDGES if f == nid]

NODE_TYPES = {
    "461": "start",
    "462": "agent",
    "463": "agent",
    "464": "output"
}

# ══════════════════════════════════════════════════════════════
# MAIN EXECUTION
#
# run() builds the LangGraph, wires edges, and executes it.
# Each node type has a factory function (make_start, make_agent,
# make_output) that returns a callable for LangGraph to invoke.
#
# Agent nodes use LangChain's ReAct pattern: the LLM receives
# the system prompt + upstream context, and can call tools in a
# loop until it produces a final answer.
# ══════════════════════════════════════════════════════════════

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
    print("[info] Building tools from embedded catalog…")
    catalog = build_tools_from_catalog()
    print(f"[info] {len(catalog)} MCP tools ready: {sorted(catalog.keys())}")

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
                        doc_parts = ["## Attached Documents\n"]
                        for doc in START_DOCUMENTS:
                            doc_parts.append(f"### {doc.get('name', 'Document')}\n")
                        text = "\n".join(doc_parts) + "\n---\n\n" + text
                    print(f"[node] [{n}] start — {len(text)} chars")
                    return {"node_outputs": {n: {"source": "start", "text": text}}}
                return _run
            sg.add_node(nid, make_start())

        elif ntype in ("agent", "agent-template"):
            def make_agent(n=nid):
                async def _run(state):
                    ad = AGENTS[n]
                    tool_names = ad["tool_names"]
                    tools = [catalog[t] for t in tool_names if t in catalog]
                    print(f"[node] [{n}] {ad['display']!r} — {len(tools)} tools")

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
                    print(f"[node] [{n}] done — {len(text)} chars")
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
                        blocks = [f"## {outs[p]['source']}\n\n{outs[p]['text']}" for p in pids if p in outs]
                        final = "\n\n---\n\n".join(blocks)
                    print(f"[node] [{n}] output — {len(final)} chars")
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
    print("[info] Running…")
    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})
    return result.get("final_output", "")


if __name__ == "__main__":
    from pathlib import Path
    from datetime import datetime

    prompt = " ".join(sys.argv[1:]) or DEFAULT_PROMPT or "Hello"
    print(f"[info] Prompt: {prompt[:100]}{'…' if len(prompt) > 100 else ''}")
    output = asyncio.run(run(prompt))
    print("\n" + "=" * 60)
    print("FINAL OUTPUT")
    print("=" * 60)
    print(output)

    # Save the result through the runner's shared output helper, which
    # writes to outputs/ with frontmatter linking the file back to this
    # script. UI picks up new entries from /api/outputs.
    from script_io import write_output
    script_stem = Path(__file__).stem
    body = (
        f"# {script_stem} — Result\n\n"
        f"**Date:** {datetime.now().isoformat()}\n\n"
        f"---\n\n{output}\n"
    )
    result_file = write_output(body, __file__, prompt=prompt)
    print(f"\nResult saved to: {result_file}")
