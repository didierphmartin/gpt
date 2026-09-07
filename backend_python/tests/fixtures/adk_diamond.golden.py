"""Standalone Google ADK workflow: diamond

PROVENANCE
==========
  Workflow:   diamond (id 1)
  Target:     Google ADK (Python) -- LlmAgent per node, Sequential/Parallel layers
  Generated:  2026-09-07 19:11:18 CEST by the SynergyAI workflow editor
  This file is a frozen snapshot of the workflow. Edits made here are
  overwritten by the next Generate: change the workflow in the editor and
  re-generate instead.

GRAPH NODES  (id (type): name -- settings; topological order)
===========
  1 (start):  Start -- receives the user prompt -- default: "GO"
  2 (agent):  A -- claude/m, 0 tool(s)
  3 (agent):  B -- gemini/g, 0 tool(s)
  4 (output): Output -- merges its parents' outputs verbatim (no LLM) -- the workflow result

GRAPH EDGES  (from -> to)
===========
  Start (1) -> A (2)
  Start (1) -> B (3)
  A (2) -> Output (4)
  B (3) -> Output (4)

EXECUTION ORDER  (topological layers; nodes on one line run in PARALLEL)
===============
  layer 0:  Start
  layer 1:  A  ||  B   (run in PARALLEL)
  layer 2:  Output

DATA FLOW
=========
HOW THIS FILE IS ORGANISED (top to bottom):
  1. _make_model(provider, model)  -- maps a node's provider+model to an ADK model
                                      (Gemini = native string; every other provider goes
                                      through LiteLLM, Grok/Kimi/DeepSeek routed to their
                                      OpenAI-compatible API).
  2. MCP_SERVERS / TOOL_CATALOG    -- the MCP tools this workflow uses, baked in.
  3. _call_mcp_tool + build_tools_from_catalog()
                                   -- an HTTP JSON-RPC MCP client; each tool is wrapped
                                      as an ADK FunctionTool the model can call.
  4. Skill runner (only when the workflow uses skills)
                                   -- runs a skill folder Python script as a subprocess.
  5. node_<id> = LlmAgent(...)     -- ONE agent per workflow node. Each agent writes its
                                      answer to session.state["node_<id>"]; a downstream
                                      agent reads a parent's output through the literal
                                      {node_<id>} placeholder in its instruction (ADK
                                      "state templating" -- the runtime substitutes it).
  6. root_agent = SequentialAgent  -- the graph as TOPOLOGICAL LAYERS: independent nodes
                                      at the same depth run together in a ParallelAgent;
                                      the layers themselves run in order.
  7. main()                        -- seeds the prompt (plus attached documents), runs the
                                      graph via Runner, streams a [node]/[tool] trace,
                                      saves the result, and prints a RUN SUMMARY.

NODE-INTERNAL PIPELINE (fixed order):
    merged fan-in (parents' outputs via {node_<id>} state placeholders)
      ==> AGENT: the node's LlmAgent -- system prompt, MCP tools and sampling
          verbatim from the editor form (provider CONSTRAINT clamps only, each
          documented as an emitted comment). Instructions are grounded in
          today's date at import time.
      ==> SKILL step(s), each a SequentialAgent pair: an LLM turn whose system
          prompt is the skill's SKILL.md, then a capture agent that makes the
          node output the file the skill's script PRODUCED (else the LLM text).
    The Output node is a non-LLM pass-through: parents' text verbatim.
Dispatcher and playbook nodes are NOT executed by this target (see GRAPH NODES).

TO RUN
======
  pip install "google-adk>=2.3,<3" litellm httpx python-dotenv   # 2.3.x: SequentialAgent/ParallelAgent still supported
  # API keys read from ../.env for the providers this workflow uses:
  #   ANTHROPIC_API_KEY (claude)
  #   GOOGLE_API_KEY (gemini)
  python this_file.py "your prompt here"
  # Output storage (Output node setting): OFF (the result is printed, not saved)
"""
import asyncio, json, os, subprocess, sys, threading, time, traceback, urllib.request
import httpx
from typing import Any

from dotenv import load_dotenv

# Load provider API keys from the runner env's .env (one dir up from scripts/).
# Without this, a DIRECT terminal run has no credentials and every LiteLLM call
# fails with "Missing credentials … set the OPENAI_API_KEY" — runner-mediated
# runs only worked because main.py loads the same file and subprocesses inherit.
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent, BaseAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.events import Event, EventActions
from google.genai import types

# Runtime "today" for date-grounding every agent instruction (evaluated at import).
_TODAY = time.strftime("%Y-%m-%d")
# ==============================================================
# MODEL FACTORY
# Maps a node provider+model to an ADK model. Gemini is native;
# every other provider routes through LiteLLM (OpenAI-compatible
# endpoints for Grok/Kimi/DeepSeek/GLM). The node form Thinking
# attribute governs reasoning mode; hard API constraints only
# (kimi sampling, deepseek-v4 thinking rules) are applied here.
# To support a new provider: add a branch in _make_model.
# ==============================================================
def _make_model(provider: str, model: str, thinking: str | None = None):
    """Resolve a (provider, model) pair to an ADK model.

    Gemini -> native model string; everything else -> LiteLlm. Grok/DeepSeek/Kimi
    are OpenAI-compatible endpoints (mirrors the PHP providers / LangGraph runner),
    so they route through litellm's openai/ handler with a custom api_base. API keys
    come from the environment (.env). The (provider, model) pair is resolved by the
    generator — a blank model already fell back to the provider default upstream.
    """
    p = (provider or "claude").lower()
    if not model:
        raise RuntimeError(
            f"No model for provider {p!r}. Set a model on the agent in the editor, "
            "or a default in system_llm_settings."
        )
    if p in ("gemini", "google", "google-genai"):
        return model
    if p in ("claude", "anthropic"):
        return LiteLlm(model=model if "/" in model else "anthropic/" + model)
    if p == "openai":
        return LiteLlm(model=model if "/" in model else "openai/" + model)
    if p in ("grok", "xai"):
        return LiteLlm(
            model="openai/" + model,
            api_base="https://api.x.ai/v1",
            api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),
        )
    if p == "deepseek":
        kwargs = dict(
            model="openai/" + model,
            api_base="https://api.deepseek.com",
            api_key=os.environ.get("DEEPSEEK_API_KEY"),
        )
        if model.startswith("deepseek-v4"):
            # The node form's Thinking attribute governs (platform parity):
            # 'off' -> disabled (form temperature accepted); 'on'/default ->
            # V4's server default stays ON (sampling params are dropped at the
            # config level by the generator in that case).
            _mode = "disabled" if thinking == "off" else "enabled"
            kwargs["extra_body"] = {"thinking": {"type": _mode}}
        return LiteLlm(**kwargs)
    if p == "kimi":
        kwargs = dict(
            model="openai/" + model,
            api_base="https://api.moonshot.ai/v1",
            api_key=os.environ.get("KIMI_API_KEY"),
        )
        if model.startswith("kimi-k2"):
            # Thinking attribute governs; K2's sampling constraints per mode
            # are enforced at the config level by the generator.
            _mode = "enabled" if thinking == "on" else "disabled"
            kwargs["extra_body"] = {"thinking": {"type": _mode}}
        return LiteLlm(**kwargs)
    if p == "glm":
        # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible. Default: thinking off so it
        # answers directly; the node form's Thinking attribute can enable it.
        return LiteLlm(
            model="openai/" + model,
            api_base="https://api.z.ai/api/paas/v4",
            api_key=os.environ.get("GLM_API_KEY"),
            extra_body={"thinking": {"type": "enabled" if thinking == "on" else "disabled"}},
        )
    # Fallback: best-effort litellm prefixed spec.
    return LiteLlm(model=model if "/" in model else p + "/" + model)
# ==============================================================
# MCP SERVER REGISTRY
# Baked at generation time from the workflow editor config.
# Maps server URL -> metadata. If a server moves, update the URL here.
# ==============================================================
MCP_SERVERS = {}
# ==============================================================
# TOOL CATALOG
# Each entry maps a tool name to its MCP server URL and JSON Schema.
# Only tools actually used by agents in this workflow are included.
# To add a tool: add an entry here AND reference it in the agent
# definitions below (catalog["<tool>"]).
# ==============================================================
TOOL_CATALOG = {}
# ==============================================================
# MCP CLIENT
# HTTP JSON-RPC client used by every generated _tool_* function.
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

_MCP_ENDPOINTS: dict = {}   # registered server URL -> endpoint that accepted the handshake

def _init_mcp_session(url: str, headers: dict) -> str | None:
    """Initialize an MCP session with the server.

    The MCP protocol requires a handshake before tool calls:
    1. Client sends 'initialize' with protocol version and capabilities
    2. Server responds with its capabilities
    3. Client sends 'notifications/initialized' to confirm

    Tries the /mcp-normalised URL first, then the URL exactly as registered
    (servers mounted at their bare URL, e.g. PHP mock servers, answer there
    and 404 or error on /mcp). The endpoint that answers is remembered.
    Returns that endpoint URL, or None when no candidate accepted the handshake.
    """
    init_req = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "clientInfo": {"name": "LangGraph-Workflow", "version": "1.0.0"},
            "capabilities": {}
        }
    }
    candidates = [_MCP_ENDPOINTS[url]] if url in _MCP_ENDPOINTS else []
    for cand in (_normalize_mcp_url(url), url):
        if cand not in candidates:
            candidates.append(cand)
    last_err = None
    for mcp_url in candidates:
        try:
            with httpx.Client(timeout=30) as c:
                r = c.post(mcp_url, json=init_req, headers=headers)
                r.raise_for_status()
                data = _parse_mcp_response(r.text)
                if data is None or "error" in (data or {}):
                    last_err = (data or {}).get("error") if data else "invalid response"
                    continue
                # Send initialized notification
                c.post(mcp_url, json={
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                    "params": {}
                }, headers=headers)
                _MCP_ENDPOINTS[url] = mcp_url
                return mcp_url
        except Exception as e:
            last_err = e
    print(f"[warn] MCP init failed for {url}: {last_err}")
    return None

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
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream, */*"}

    mcp_url = _init_mcp_session(server_url, headers) or _normalize_mcp_url(server_url)

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
# DOCUMENT CONVERTER
# Turns a start-node attachment into markdown for the prompt.
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
# TOOL WRAPPERS
# One typed FunctionTool per catalog entry; ADK introspects each
# function signature to build the tool schema the model sees.
# ==============================================================
def build_tools_from_catalog() -> dict:
    return {}
# The tool objects agents reference by name as catalog["<tool>"].
catalog = build_tools_from_catalog()
START_DOCUMENTS = []
# ==============================================================
# AGENTS — ONE LlmAgent PER WORKFLOW NODE
# Each agent writes its result to session.state["node_<id>"]; a
# child reads a parent through the literal {node_<id>} placeholder
# in its instruction (ADK state templating). Provider/model/tools/
# sampling come verbatim from the editor forms (constraint clamps
# are documented as comments on the affected node). To change a
# node: edit the workflow in the editor and re-generate.
# ==============================================================
# ---- node 2: A (agent) -----------------------------------------------------
#   provider/model : claude / m   thinking default
#   tools          : (none)
#   skills         : (none)
#   parents        : Start (1)
#   children       : Output (4)
node_2 = LlmAgent(
    name="node_2",
    model=_make_model("claude", "m", thinking=None),
    instruction=("Current date: " + _TODAY + ". Treat this as 'now'; "
                 "prefer your tools for current data over memory.\n\n"
                 + "A"),
    tools=[],
    include_contents='none',
    output_key="node_2",
)

# ---- node 3: B (agent) -----------------------------------------------------
#   provider/model : gemini / g   thinking default
#   tools          : (none)
#   skills         : (none)
#   parents        : Start (1)
#   children       : Output (4)
node_3 = LlmAgent(
    name="node_3",
    model=_make_model("gemini", "g", thinking=None),
    instruction=("Current date: " + _TODAY + ". Treat this as 'now'; "
                 "prefer your tools for current data over memory.\n\n"
                 + "B"),
    tools=[],
    include_contents='none',
    output_key="node_3",
)
# ==============================================================
# OUTPUT (FAN-IN) NODES
# Non-LLM pass-throughs: forward parent result(s) VERBATIM so
# formatting such as HTML is never reworded by another model.
# ==============================================================
class _PassThroughAgent(BaseAgent):
    """Output (fan-in) node: emit the parent(s) result VERBATIM -- no LLM -- so
    formatting such as HTML is preserved. A single parent is passed through
    unchanged; multiple parents are joined with a separator. (An LlmAgent here
    would re-summarise the parent and lose its original formatting, e.g. turning
    a finished HTML report back into plain markdown.)
    """
    source_keys: list = []

    async def _run_async_impl(self, ctx):
        vals = [str(ctx.session.state.get(k, "")) for k in self.source_keys]
        vals = [v for v in vals if v]
        text = vals[0] if len(vals) == 1 else "\n\n---\n\n".join(vals)
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            actions=EventActions(state_delta={self.name: text}),
            turn_complete=True,
        )
# Output (fan-in) node 4 -- forwards its parent(s) result verbatim (no LLM),
# so formatting such as HTML is preserved. Single parent = pass-through.
node_4 = _PassThroughAgent(name="node_4", source_keys=["node_2", "node_3"])
# ==============================================================
# ORCHESTRATION
# The workflow graph as TOPOLOGICAL LAYERS: independent nodes at
# the same depth run together in a ParallelAgent; the layers run
# in order inside a SequentialAgent. This mirrors the canvas.
# ==============================================================
root_agent = SequentialAgent(
    name="workflow",
    sub_agents=[
    ParallelAgent(name="layer_1", sub_agents=[node_2, node_3]),
    node_4
    ],
)
# ==============================================================
# CLI ENTRY
# Seeds the prompt (+ attached documents), runs the graph via
# Runner, streams a [node]/[tool] trace, saves the result per the
# Output node storage setting, and closes with a RUN SUMMARY
# (time per node, total wall-clock, document location).
# ==============================================================
WORKFLOW_NAME = "diamond"
WORKFLOW_ID = 1
OUTPUT_STORAGE_ENABLED = False
OUTPUT_FOLDER = None
NODE_NAMES = {
    "2": "A",
    "3": "B"
}  # node id -> human name (for readable logs)

async def main(user_prompt: str = "GO"):
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
            user_prompt = (
                "## Attached Documents\n\n"
                + "\n\n---\n\n".join(doc_parts)
                + "\n\n---\n\n"
                + user_prompt
            )
    print(f"[workflow] {WORKFLOW_NAME} starting", flush=True)
    print(f"[workflow] prompt: {user_prompt[:200]!r}", flush=True)
    session_service = InMemorySessionService()
    runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)
    session = await session_service.create_session(app_name="workflow", user_id="local", state={})
    final = ""
    t0 = time.monotonic()
    seen = set()
    _t_first, _t_last = {}, {}  # per-node timing for the RUN SUMMARY
    content = types.Content(role="user", parts=[types.Part(text=user_prompt)])
    try:
        async for event in runner.run_async(user_id="local", session_id=session.id, new_message=content):
            author = getattr(event, "author", "?")
            if isinstance(author, str) and author.startswith("node_"):
                _nk = author.split("_")[1] if "_" in author else author
                _t_first.setdefault(_nk, time.monotonic())
                _t_last[_nk] = time.monotonic()
            if author and author not in seen:
                seen.add(author)
                if isinstance(author, str) and author.startswith("node_"):
                    _ap = author.split("_")
                    _nid = _ap[1] if len(_ap) > 1 else author
                    _kind = "skill step" if "skill" in author else "agent"
                    print(f"[node {_nid}] {NODE_NAMES.get(_nid, _nid)!r} \u2192 {_kind} active", flush=True)
                else:
                    print(f"[node] > {author}", flush=True)
            parts = (event.content.parts if event.content else None) or []
            for p in parts:
                fc = getattr(p, "function_call", None)
                fr = getattr(p, "function_response", None)
                if fc is not None:
                    _a = str(getattr(fc, "args", ""))[:200]
                    print(f"[tool] -> {fc.name}({_a})", flush=True)
                elif fr is not None:
                    _r = str(getattr(fr, "response", ""))[:200]
                    print(f"[tool] <- {fr.name}: {_r}", flush=True)
                else:
                    txt = (getattr(p, "text", None) or "").strip()
                    if txt:
                        print(f"[{author}] {txt[:240]}", flush=True)
            if event.is_final_response() and event.content and event.content.parts:
                final = event.content.parts[0].text or final
        print(f"[workflow] done in {time.monotonic() - t0:.1f}s, {len(final)} chars", flush=True)
    except Exception:
        print("[workflow] ERROR:", flush=True)
        traceback.print_exc()
        raise
    import re as _re
    _mm = _re.search(r"(?is)<!doctype html.*?</html\s*>", final) or _re.search(r"(?is)<html[\s>].*?</html\s*>", final)
    if _mm:
        final = _mm.group(0)  # strip narration/fences around a full HTML doc
        _ext = "html"
    else:
        _ext = "md"
    _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"
    _ts = time.strftime("%Y%m%d-%H%M%S")
    # Honour the Output node's storage setting: when ON, persist the final result
    # where the app stores it (~/Documents/synergyAI/outputs/workflow/ by default,
    # overridable via SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, skip.
    _saved_path = None
    if OUTPUT_STORAGE_ENABLED:
        _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
        if OUTPUT_FOLDER:
            _cf = os.path.expanduser(OUTPUT_FOLDER)
            _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)
        else:
            _save_dir = os.path.join(_root, "workflow")
        os.makedirs(_save_dir, exist_ok=True)
        _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")
        with open(_out, "w", encoding="utf-8") as _f:
            _f.write(final)
        _saved_path = os.path.abspath(_out)
    print(final)
    # Closing RUN SUMMARY (printed LAST): time per node, total, document location.
    print("\n" + "=" * 74, flush=True)
    print("RUN SUMMARY", flush=True)
    print("-" * 74, flush=True)
    # Only named agent nodes (skip output pass-throughs: ~0s, no display name).
    _durs = {NODE_NAMES[k]: _t_last[k] - _t_first[k] for k in _t_first if k in _t_last and k in NODE_NAMES}
    if _durs:
        _w = max(len(n) for n in _durs)
        print("  Time per node:", flush=True)
        for _n, _s in sorted(_durs.items(), key=lambda kv: -kv[1]):
            print(f"    {_n:<{_w}}   {_s:7.1f}s", flush=True)
    print(f"  Total wall-clock: {time.monotonic() - t0:.1f}s", flush=True)
    print(f"  Final output: {len(final)} chars", flush=True)
    if _saved_path:
        print(f"  Document saved to: {_saved_path}", flush=True)
    else:
        print("  Document not saved (output storage is OFF in the workflow settings) -- "
              "the output is printed above.", flush=True)
    print("=" * 74, flush=True)
    return final

if __name__ == "__main__":
    # Join ALL argv (a prompt is one string even with spaces) -- the runner
    # passes it space-split; sys.argv[1] alone would keep only the first word.
    asyncio.run(main(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else "GO"))
