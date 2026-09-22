"""Standalone LangGraph workflow: test ingestion workflow

Auto-generated -- backend-independent.
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
   upstream predecessors (not all prior nodes -- only edge parents)
3. The context message includes the original user prompt plus
   each predecessor's output under a ### header with source name
4. Output node collects its parents' outputs as final result

GRAPH NODES
===========
  705 (start): node_705
  706 (): node_706
  707 (): node_707
  708 (): node_708
  709 (output): node_709

GRAPH EDGES
===========
  705 -> 706
  706 -> 707
  707 -> 708
  708 -> 709

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

  # Optional, install only formats you actually attach:
  pip install mammoth        # for .docx attachments
  pip install python-pptx    # for .pptx attachments
  pip install openpyxl       # for .xlsx attachments
  pip install pypdf          # for .pdf attachments

Usage: python test_ingestion_workflow.py 'your prompt here'
"""
from __future__ import annotations

import asyncio, json, os, sys, time
from typing import Annotated, Any, TypedDict

import httpx
# Provider-aware LLM wiring — each agent uses the LLM (provider/model)
# configured for it in the workflow editor. Imports are lazy inside
# _make_llm so a missing optional package only breaks the agents that
# actually use that provider, not the whole script.
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph
try:
    from langchain.agents import create_agent as create_react_agent
except ImportError:
    from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel, Field, create_model

# Optional global override: setting MODEL_NAME in the env forces every
# agent to use that model regardless of its per-agent setting. Useful for
# quick experiments. Leave unset to honour each agent's configured model.
MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()


def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096):
    """Build a LangChain chat model for the given provider/model.

    The (provider, model) pair was resolved by the generator: the
    agent's explicit model overrides the provider's default from
    system_llm_settings, and that result is what reaches this
    function. No hardcoded model fallbacks here — every value comes
    from the database, so changing a model in the editor propagates
    via the next Generate Python.

    Recognised providers (case-insensitive):
      claude     → langchain_anthropic.ChatAnthropic
      openai     → langchain_openai.ChatOpenAI
      gemini     → langchain_google_genai.ChatGoogleGenerativeAI
      grok       → ChatOpenAI on https://api.x.ai/v1
      deepseek   → ChatOpenAI on https://api.deepseek.com
      kimi       → ChatOpenAI on https://api.moonshot.ai/v1

    Reads API keys from the environment (loaded from .env at startup).
    """
    p = (provider or "claude").lower()
    if MODEL_NAME_OVERRIDE:
        model = MODEL_NAME_OVERRIDE
    if not model:
        raise RuntimeError(
            f"No model specified for provider {p!r}. "
            "Set a model name on the agent in the workflow editor, "
            "or set MODEL_NAME in .env."
        )
    if p == "claude":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)
    if p == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)
    if p == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)
    if p == "grok":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model,
            base_url="https://api.x.ai/v1",
            api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),
            temperature=temperature,
            max_tokens=max_tokens,
        )
    if p == "deepseek":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model,
            base_url="https://api.deepseek.com",
            api_key=os.environ.get("DEEPSEEK_API_KEY"),
            temperature=temperature,
            max_tokens=max_tokens,
        )
    if p == "kimi":
        from langchain_openai import ChatOpenAI
        # K2 models enforce non-thinking sampling values; mirror the
        # PHP KimiProvider so the API accepts the request. The
        # editor's temperature is overridden here (API requirement);
        # max_tokens is still honoured.
        kwargs = dict(
            model=model,
            base_url="https://api.moonshot.ai/v1",
            api_key=os.environ.get("KIMI_API_KEY"),
            max_tokens=max_tokens,
        )
        if model.startswith("kimi-k2"):
            kwargs["temperature"] = 0.6
            kwargs["top_p"] = 0.95
            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}
        else:
            kwargs["temperature"] = temperature
        return ChatOpenAI(**kwargs)
    raise RuntimeError(
        f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi."
    )

# ==============================================================
# MCP SERVER REGISTRY
# Baked at generation time from the workflow editor's config.
# Maps server URL -> metadata. If a server moves, update the URL here.
# ==============================================================

MCP_SERVERS = {
    "http://localhost/image-server/mcp": {
        "name": "Image-server"
    },
    "http://localhost/video-server/mcp": {
        "name": "video-server"
    },
    "http://localhost/finance/mcp-server.php": {
        "name": "Financial News"
    },
    "http://localhost/metals/public/mcp": {
        "name": "Metals News"
    },
    "http://localhost/tradingview/mcp": {
        "name": "TradingView"
    },
    "https://synergyaichat.com/pubmed/mcp.php": {
        "name": "pubmed"
    },
    "http://localhost/cryptos/mcp.php": {
        "name": "Cryptos"
    },
    "http://localhost/battery/mcp.php": {
        "name": "Battery"
    },
    "http://localhost/googlemaps/mcp.php": {
        "name": "Google Map"
    }
}

# ==============================================================
# TOOL CATALOG
# Each entry maps a tool name to its MCP server URL and
# JSON Schema for input validation. Only tools actually used
# by agents in this workflow are included.
# To add a tool: add an entry here AND reference it in the
# agent's tool_names list in the AGENTS dict below.
# ==============================================================

TOOL_CATALOG = {}

# ==============================================================
# MCP CLIENT -- JSON-RPC 2.0 over HTTP
#
# The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.
# Each tool call requires:
#   1. URL normalization -- append /mcp if not present
#   2. Session initialization -- send 'initialize' + notification
#   3. Tool invocation -- send 'tools/call' with name + arguments
#   4. Response parsing -- handle plain JSON or SSE-wrapped JSON
#
# Some MCP servers return Server-Sent Events (SSE) instead of
# plain JSON. The parser handles both formats transparently.
# ==============================================================

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


# ==============================================================
# TOOL BUILDER
# Converts the baked TOOL_CATALOG into LangChain StructuredTool
# objects. Each tool gets a dynamically-built Pydantic model for
# input validation (from the JSON Schema), and a callable that
# invokes the MCP server. The LLM agent calls these like any
# other LangChain tool -- it doesn't know about MCP internals.
# ==============================================================

def _summarize_tool_result(result: str) -> str:
    """Short, informative summary of a tool result for logs.

    Parses JSON when possible and surfaces the most useful fields
    (article count + first PMIDs, error message, query text, etc.)
    so the log shows *what* came back, not just the raw first 120 chars.
    """
    try:
        parsed = json.loads(result)
    except Exception:
        s = result.strip().replace("\n", " ")
        return s[:160] + (" ..." if len(s) > 160 else "")
    if isinstance(parsed, dict):
        if "error" in parsed:
            return f"error: {str(parsed['error'])[:200]}"
        if isinstance(parsed.get("articles"), list):
            arts = parsed["articles"]
            pmids = [str(a.get("pmid", "?")) for a in arts[:5] if isinstance(a, dict)]
            more = "" if len(arts) <= 5 else f", +{len(arts) - 5} more"
            return f"{len(arts)} articles (PMIDs: {', '.join(pmids)}{more})"
        if isinstance(parsed.get("suggestions"), list):
            return f"{len(parsed['suggestions'])} suggestions"
        if isinstance(parsed.get("query"), str):
            q = parsed["query"]
            return f"query: {q[:200]}" + (" ..." if len(q) > 200 else "")
        if isinstance(parsed.get("items"), list):
            return f"{len(parsed['items'])} items"
        keys = ", ".join(list(parsed.keys())[:6])
        return f"keys: {keys}"
    if isinstance(parsed, list):
        return f"list of {len(parsed)} items"
    s = str(parsed)
    return s[:160] + (" ..." if len(s) > 160 else "")


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
                argv = json.dumps(kwargs, default=str)
                argv_preview = argv if len(argv) <= 250 else argv[:250] + f" ... +{len(argv) - 250} chars"
                print(f"  [tool] -> {n}({argv_preview})")
                t0 = time.monotonic()
                result = _call_mcp_tool(s, n, kwargs)
                dt = time.monotonic() - t0
                summary = _summarize_tool_result(result)
                print(f"  [tool] ← {n}: {summary} ({len(result)} chars, {dt:.1f}s)")
                return result
            return invoke

        catalog[name] = StructuredTool.from_function(
            func=make_fn(),
            name=name,
            description=info.get("description") or f"MCP tool {name}",
            args_schema=args_model,
        )
    return catalog


# ==============================================================
# LANGGRAPH STATE
#
# WFState is the shared state that flows through the graph.
# - user_prompt: the original user input (immutable after start)
# - node_outputs: dict of node_id -> {source, text} -- each node
#   writes its output here. Uses a merge reducer so parallel
#   branches can both contribute without conflicts.
# - final_output: set by the output node as the workflow result
# ==============================================================

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


# ==============================================================
# DATETIME INJECTOR
#
# LLMs have knowledge cutoffs and don't know the current date.
# inject_datetime() prepends a short context block to each agent's
# system prompt so the agent reasons with today's actual date.
# Also resolves any [date]/[weekday]/[year]/[time] placeholders
# that may exist inside the prompt text (legacy templating).
# ==============================================================

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


# ==============================================================
# CONTEXT BUILDER
#
# Each agent receives a structured message containing:
#   1. The original user request (for reference)
#   2. Labeled outputs from direct upstream agents only
# This matches the PHP backend's 'labeled' merge strategy.
# The agent's system prompt tells it what to DO with this input.
# ==============================================================

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
    return "\n".join(parts)


# ==============================================================
# DOCUMENT CONVERTER
#
# Reads a file at `path` and returns Markdown the LLM can read.
# Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/etc.) pass through
# verbatim. Binary office formats and PDFs are routed to their
# matching pure-Python library (mammoth / python-pptx / openpyxl /
# pypdf). Imports are lazy so the helper only pulls in heavy deps
# when a document of that format is actually attached.
#
# This mirrors the editor's frontend converter (Pyodide) so the
# generated script behaves the same way the workflow did at design
# time. Paths come from the doc.path field stored in the workflow
# config — make sure the file is reachable from wherever you run
# this script (absolute paths recommended).
# ==============================================================

def _convert_doc_to_markdown(path: str) -> str:
    """Read a file and return its contents as Markdown.

    Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/XML/source) are returned
    verbatim. Binary office formats and PDFs are routed to their matching
    pure-Python parser. Imports are lazy so the script doesn't pull in a
    library unless the corresponding format is actually attached.

    Raises FileNotFoundError if the path doesn't exist, ValueError for an
    unsupported extension, ImportError if the format's library is missing.
    """
    from pathlib import Path
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"document not found: {path}")
    ext = p.suffix.lower()

    text_native = {
        ".html", ".htm", ".md", ".markdown", ".txt", ".text",
        ".json", ".yaml", ".yml", ".xml", ".csv", ".tsv",
        ".css", ".scss", ".less",
        ".js", ".mjs", ".ts", ".tsx", ".jsx",
        ".py", ".rb", ".go", ".rs", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
        ".sh", ".bash", ".zsh", ".sql", ".log", ".rtf", ".ini", ".toml",
    }
    if ext in text_native:
        return p.read_text(encoding="utf-8", errors="replace")

    if ext == ".docx":
        import mammoth
        with p.open("rb") as f:
            return mammoth.convert_to_markdown(f).value

    if ext == ".pptx":
        from pptx import Presentation
        prs = Presentation(str(p))
        sections = [f"# {p.name}", f"_{len(prs.slides)} slide(s)_"]
        for i, slide in enumerate(prs.slides, start=1):
            layout = slide.slide_layout.name if slide.slide_layout else "?"
            sections.append(f"## Slide {i} -- {layout}")
            title_text = ""
            if slide.shapes.title and slide.shapes.title.has_text_frame:
                title_text = slide.shapes.title.text_frame.text.strip()
            if title_text:
                sections.append(f"### {title_text}")
            body = []
            for shape in slide.shapes:
                if shape == slide.shapes.title:
                    continue
                if not getattr(shape, "has_text_frame", False):
                    continue
                for para in shape.text_frame.paragraphs:
                    line = "".join(run.text or "" for run in para.runs).strip()
                    if not line and para.text:
                        line = para.text.strip()
                    if line:
                        indent = "  " * (para.level or 0)
                        body.append(f"{indent}- {line}")
            if body:
                sections.append("\n".join(body))
            if slide.has_notes_slide:
                notes = (slide.notes_slide.notes_text_frame.text or "").strip()
                if notes:
                    sections.append("### Notes")
                    sections.append(notes)
        return "\n\n".join(sections) + "\n"

    if ext in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        wb = load_workbook(str(p), data_only=True)
        sections = [f"# {p.name}", f"_{len(wb.sheetnames)} sheet(s)_"]
        max_rows = 200
        for name in wb.sheetnames:
            ws = wb[name]
            rows = []
            for row in ws.iter_rows(values_only=True):
                row_vals = list(row)
                while row_vals and (row_vals[-1] is None or row_vals[-1] == ""):
                    row_vals.pop()
                if row_vals or not rows:
                    rows.append(row_vals)
            while rows and not any(c not in (None, "") for c in rows[-1]):
                rows.pop()
            sections.append(f"## Sheet: {name}")
            sections.append(f"_{len(rows)} row(s) -- {ws.max_column} col(s)_")
            if not rows:
                sections.append("_(empty)_")
                continue
            width = max(len(r) for r in rows)
            rows = [list(r) + [""] * (width - len(r)) for r in rows]
            truncated = len(rows) > max_rows
            if truncated:
                rows = rows[:max_rows]
            def cell(v):
                return ("" if v is None else str(v)).replace("|", "\\|").replace("\n", " ")
            table = ["| " + " | ".join(cell(v) for v in rows[0]) + " |",
                     "| " + " | ".join(["---"] * width) + " |"]
            for r in rows[1:]:
                table.append("| " + " | ".join(cell(v) for v in r) + " |")
            if truncated:
                table.append(f"\n_(showing first {max_rows} rows)_")
            sections.append("\n".join(table))
        return "\n\n".join(sections) + "\n"

    if ext == ".pdf":
        from pypdf import PdfReader
        reader = PdfReader(str(p))
        parts = [f"# {p.name} -- {len(reader.pages)} page(s)"]
        for i, page in enumerate(reader.pages, start=1):
            try:
                t = (page.extract_text() or "").strip()
            except Exception as e:
                t = ""
            parts.append(f"## Page {i}")
            parts.append(t if t else "_(no extractable text)_")
        return "\n\n".join(parts) + "\n"

    raise ValueError(f"unsupported document format: {ext}")


# ==============================================================
# START NODE
#
# The start node feeds the prompt into the workflow.
# DEFAULT_PROMPT is baked from the workflow's start node config.
# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.
# If the workflow has documents attached to the start node,
# they're read from doc.path, converted to Markdown via
# _convert_doc_to_markdown(), and prepended to the prompt.
# ==============================================================

DEFAULT_PROMPT = """

""".strip()

START_DOCUMENTS = []

# ==============================================================
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
# ==============================================================

AGENTS = {
}

# ==============================================================
# GRAPH STRUCTURE
#
# EDGES: directed connections as (from_node_id, to_node_id) tuples.
# ORDER: topological execution order (Kahn's algorithm).
#        Guarantees every node runs after all its predecessors.
# NODE_TYPES: maps node_id -> type ('start', 'agent', 'output').
# ==============================================================

EDGES = [
    [
        "705",
        "706"
    ],
    [
        "706",
        "707"
    ],
    [
        "707",
        "708"
    ],
    [
        "708",
        "709"
    ]
]
ORDER = [
    "705",
    "706",
    "707",
    "708",
    "709"
]

def parents(nid: str) -> list[str]:
    """Get direct predecessor node IDs (nodes with edges INTO this node)."""
    return [f for f, t in EDGES if t == nid]

def children(nid: str) -> list[str]:
    """Get direct successor node IDs (nodes this node has edges TO)."""
    return [t for f, t in EDGES if f == nid]

NODE_TYPES = {
    "705": "start",
    "706": "",
    "707": "",
    "708": "",
    "709": "output"
}

# ==============================================================
# MAIN EXECUTION
#
# run() builds the LangGraph, wires edges, and executes it.
# Each node type has a factory function (make_start, make_agent,
# make_output) that returns a callable for LangGraph to invoke.
#
# Agent nodes use LangChain's ReAct pattern: the LLM receives
# the system prompt + upstream context, and can call tools in a
# loop until it produces a final answer.
# ==============================================================

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

    # One LLM instance per agent — provider/model come from the AGENTS
    # dict, which the generator baked from each agent's workflow config.
    # Built eagerly (not per-call) so we fail fast on missing API keys.
    LLMS = {
        nid: _make_llm(
            ad.get("provider", "claude"),
            ad.get("model", ""),
            float(ad.get("temperature", 0.7)),
            int(ad.get("max_tokens", 4096)),
        )
        for nid, ad in AGENTS.items()
    }
    sg = StateGraph(WFState)

    for nid in ORDER:
        ntype = NODE_TYPES.get(nid, "")

        if ntype == "start":
            def make_start(n=nid):
                def _run(state):
                    text = state.get("user_prompt", "")
                    if START_DOCUMENTS:
                        doc_parts = []
                        for doc in START_DOCUMENTS:
                            name = doc.get("name", "Document")
                            path = doc.get("path", "")
                            if not path:
                                doc_parts.append(f"### {name}\n\n_(no path on attachment record)_")
                                continue
                            try:
                                md = _convert_doc_to_markdown(path)
                                doc_parts.append(f"### {name}\n\n{md}")
                            except Exception as e:
                                doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
                        if doc_parts:
                            text = (
                                "## Attached Documents\n\n"
                                + "\n\n---\n\n".join(doc_parts)
                                + "\n\n---\n\n"
                                + text
                            )
                    print(f"[node] [{n}] start -- {len(text)} chars")
                    return {"node_outputs": {n: {"source": "start", "text": text}}}
                return _run
            sg.add_node(nid, make_start())

        elif ntype in ("agent", "agent-template"):
            def make_agent(n=nid):
                async def _run(state):
                    from pathlib import Path
                    from datetime import datetime as _dt
                    ad = AGENTS[n]
                    tool_names = ad["tool_names"]
                    tools = [catalog[t] for t in tool_names if t in catalog]
                    print(f"[node] [{n}] {ad['display']!r} -- {len(tools)} tools "
                          f"(provider={ad.get('provider', '?')}, model={ad.get('model', '?')})")

                    ctx = build_context(state.get("user_prompt", ""), parents(n), state.get("node_outputs", {}))
                    sys_chars = len(ad["system_prompt"]) if ad.get("system_prompt") else 0
                    print(f"[node] [{n}] inputs: system={sys_chars} chars, context={len(ctx)} chars", flush=True)

                    msgs = []
                    if ad["system_prompt"]:
                        msgs.append(SystemMessage(content=inject_datetime(ad["system_prompt"])))
                    msgs.append(HumanMessage(content=ctx))

                    # Per-agent LLM. Each agent uses the provider/model
                    # it was configured with in the workflow editor.
                    agent = create_react_agent(LLMS[n], tools)
                    t0 = time.monotonic()
                    result = await agent.ainvoke({"messages": msgs})
                    dt = time.monotonic() - t0

                    final = result["messages"][-1]
                    text = final.content if isinstance(final, AIMessage) else str(final)
                    if isinstance(text, list):
                        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))

                    msgs_out = result.get("messages", [])
                    llm_rounds = sum(1 for m in msgs_out if isinstance(m, AIMessage))
                    tool_results = sum(
                        1 for m in msgs_out
                        if getattr(m, "type", None) == "tool"
                        or m.__class__.__name__ == "ToolMessage"
                    )
                    print(f"[node] [{n}] done -- {len(text)} chars "
                          f"({llm_rounds} LLM rounds, {tool_results} tool results, {dt:.1f}s)")

                    try:
                        script_root = Path(__file__).resolve().parent.parent
                        debug_dir = script_root / "outputs" / "_debug"
                        debug_dir.mkdir(parents=True, exist_ok=True)
                        ts = _dt.now().strftime("%Y%m%d-%H%M%S")
                        stem = Path(__file__).stem
                        dump_path = debug_dir / f"{stem}_{n}_{ts}.json"
                        entries = []
                        for m in msgs_out:
                            content = m.content
                            if isinstance(content, list):
                                content = [
                                    (b if isinstance(b, dict) else {"type": "text", "text": str(b)})
                                    for b in content
                                ]
                            entries.append({
                                "role": m.__class__.__name__,
                                "content": content,
                                "tool_calls": getattr(m, "tool_calls", None),
                                "tool_call_id": getattr(m, "tool_call_id", None),
                                "name": getattr(m, "name", None),
                            })
                        dump_path.write_text(
                            json.dumps(entries, default=str, indent=2, ensure_ascii=False),
                            encoding="utf-8",
                        )
                        print(f"[debug] [{n}] message history → outputs/_debug/{dump_path.name}")
                    except Exception as e:
                        print(f"[debug] [{n}] failed to dump message history: {e}")

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
    prompt = " ".join(sys.argv[1:]) or DEFAULT_PROMPT or "Hello"
    print(f"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
    output = asyncio.run(run(prompt))
    print("\n" + "=" * 60)
    print("FINAL OUTPUT")
    print("=" * 60)
    print(output)

    # Save via script_io.write_output -- writes to <install>/outputs/
    # with auto HTML/MD detection. The scripts/ folder stays scripts-only.
    try:
        from script_io import write_output
        result_file = write_output(output, __file__, prompt=prompt)
        print(f"\nResult saved to: {result_file}")
    except Exception as e:
        print(f"\n[warn] failed to save result via script_io: {e}")
