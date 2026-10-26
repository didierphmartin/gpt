"""Standalone Google ADK workflow: diamond

PROVENANCE
==========
  Workflow:   diamond (id 1)
  Target:     Google ADK (Python) -- LlmAgent per node, Sequential/Parallel layers
  Generated:  2026-01-01 00:00:00 UTC by the SynergyAI workflow editor
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
  7. run_workflow()                -- seeds the prompt (plus attached documents), runs the
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
A DISPATCHER node routes: it names one child from its menu and only that
child runs (its menu is nested under the dispatcher, not in a layer).
A PLAYBOOK node is an interpreter, not an agent: the model re-decides each
round from the running transcript of tool calls, and that transcript IS the
node output, published to session.state like any other node's result.

TO RUN
======
  # Requires Python 3.10+ (the generated code uses match statements)
  # google-adk 2.3.x: SequentialAgent/ParallelAgent still supported
  pip install "google-adk>=2.3,<3" "httpx>=0.27.0" litellm "python-dotenv>=1.0.0"
  # API keys read from ../.env for the providers this workflow uses:
  #   ANTHROPIC_API_KEY (claude)
  #   GOOGLE_API_KEY (gemini)
  python diamond_adk.py "your prompt here"
  # Output storage (Output node setting): OFF (the result is printed, not saved)
"""
import asyncio, json, os, subprocess, sys, threading, time, traceback, urllib.request
import httpx
from typing import Any

from dotenv import load_dotenv

# Provider keys and MCP headers come from .env: this folder's own first, then the runner's
# python/.env -- one level up for the single file in scripts/, two for the package in
# scripts/<folder>/. load_dotenv never overrides, so the nearest value wins.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _d in (_HERE, os.path.dirname(_HERE), os.path.dirname(os.path.dirname(_HERE))):
    load_dotenv(os.path.join(_d, ".env"))
PACKAGE_DIR = _HERE   # this program's folder: code/, skills/, start_documents/ and outputs/ are relative to it

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent, BaseAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.events import Event, EventActions
from google.genai import types

# Runtime "today" for date-grounding every agent instruction (evaluated at import).
_TODAY = time.strftime("%Y-%m-%d")


def _agent_instruction(prompt: str, parent_keys: list):
    """Return an ADK InstructionProvider (callable) for an agent node.

    A callable instruction makes ADK use the text VERBATIM
    (bypass_state_injection=True): a string instruction would be run through
    session-state templating, where every {name} is a placeholder and an
    unknown key raises KeyError -- so a prompt that says "Today is {date}"
    would crash the run. The parents' outputs are appended here from
    session.state (keys "node_<id>", written by each parent's output_key),
    which is what the {node_<id>} string placeholders used to do.
    """
    def _instr(ctx):
        text = ("Current date: " + _TODAY + ". Treat this as 'now'; "
                "prefer your tools for current data over memory.\n\n" + prompt)
        for key in parent_keys:
            text += "\n\n## Input from " + key + "\n" + str(ctx.state.get(key, ""))
        return text
    return _instr
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
    match p:
        case "gemini" | "google" | "google-genai":
            return model
        case "claude" | "anthropic":
            return LiteLlm(model=model if "/" in model else "anthropic/" + model)
        case "openai":
            return LiteLlm(model=model if "/" in model else "openai/" + model)
        case "grok" | "xai":
            return LiteLlm(
                model="openai/" + model,
                api_base=os.environ.get("XAI_BASE_URL") or "https://api.x.ai/v1",
                api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),
            )
        case "deepseek":
            kwargs = dict(
                model="openai/" + model,
                api_base=os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com",
                api_key=os.environ.get("DEEPSEEK_API_KEY"),
            )
            if model.startswith(("deepseek-v4", "deepseek-flash")):
                # The node form's Thinking attribute governs (platform parity):
                # 'off' -> disabled (form temperature accepted); 'on'/default ->
                # V4's server default stays ON (sampling params are dropped at the
                # config level by the generator in that case).
                _mode = "disabled" if thinking == "off" else "enabled"
                kwargs["extra_body"] = {"thinking": {"type": _mode}}
            return LiteLlm(**kwargs)
        case "kimi":
            kwargs = dict(
                model="openai/" + model,
                api_base=os.environ.get("KIMI_BASE_URL") or "https://api.moonshot.ai/v1",
                api_key=os.environ.get("KIMI_API_KEY"),
            )
            if model.startswith("kimi-k2"):
                # Thinking attribute governs; K2's sampling constraints per mode
                # are enforced at the config level by the generator.
                _mode = "enabled" if thinking == "on" else "disabled"
                kwargs["extra_body"] = {"thinking": {"type": _mode}}
            return LiteLlm(**kwargs)
        case "glm":
            # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible. Default: thinking off so it
            # answers directly; the node form's Thinking attribute can enable it.
            return LiteLlm(
                model="openai/" + model,
                api_base=os.environ.get("GLM_BASE_URL") or "https://api.z.ai/api/paas/v4",
                api_key=os.environ.get("GLM_API_KEY"),
                extra_body={"thinking": {"type": "enabled" if thinking == "on" else "disabled"}},
            )
        case _:
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
MCP_SERVER_SLUGS = {}   # registered URL -> slug: MCP_HEADERS_<SLUG> / MCP_URL_<SLUG> in .env
MCP_SLUGS = {v: k for k, v in MCP_SERVER_SLUGS.items()}   # slug -> URL (a code node's call_tool)

_MCP_BASE_HEADERS = {"Content-Type": "application/json",
                     "Accept": "application/json, text/event-stream, */*"}
_MCP_ENDPOINTS: dict = {}   # registered server URL -> endpoint that accepted the handshake


def _mcp_headers(server_url: str) -> dict:
    """The base headers plus the server's own from MCP_HEADERS_<SLUG> in .env (a JSON object).

    Header values (keys, account ids) never live in this script: the editor's MCP server
    entry holds them, and .env carries them to the compiled run.
    """
    slug = MCP_SERVER_SLUGS.get(server_url, "")
    var = f"MCP_HEADERS_{slug.upper()}"
    raw = os.environ.get(var, "") if slug else ""
    if not raw:
        return dict(_MCP_BASE_HEADERS)
    try:
        extra = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"{var} in .env is not valid JSON (expected e.g. {{\"Header\": \"value\"}})") from None
    if not isinstance(extra, dict):
        raise RuntimeError(f"{var} in .env must be a JSON object")
    for k, v in extra.items():
        if not isinstance(v, str) or "\r" in v or "\n" in v or "\r" in str(k) or "\n" in str(k):
            raise RuntimeError(f"{var} in .env: every header value must be a single-line string (check header {str(k)!r})")
    return {**_MCP_BASE_HEADERS, **{str(k): v for k, v in extra.items()}}


def _mcp_live_url(server_url: str) -> str:
    """Where the server answers: MCP_URL_<SLUG> from .env when set (the server moved), else the
    registered URL. The registered URL stays the key for headers and endpoints."""
    slug = MCP_SERVER_SLUGS.get(server_url, "")
    return (os.environ.get(f"MCP_URL_{slug.upper()}", "").strip() if slug else "") or server_url


def _mcp_candidates(url: str) -> list:
    """The endpoints to try, in order: the URL exactly as given, then with /mcp in its path
    (before any query string). A path already ending in /mcp or .php is the endpoint."""
    cut = min([i for i in (url.find("?"), url.find("#")) if i >= 0] or [len(url)])
    path, rest = url[:cut].rstrip("/"), url[cut:]
    if path.endswith("/mcp") or path.endswith(".php"):
        return [url]
    return [url, path + "/mcp" + rest]


def _parse_mcp_response(text: str) -> dict | None:
    """A JSON-RPC response as plain JSON, or the first parsable SSE `data:` line."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data:
                try:
                    return json.loads(data)
                except json.JSONDecodeError:
                    continue
    return None


def _init_mcp_session(server_url: str) -> str | None:
    """The initialize handshake; tries _mcp_candidates(live URL): as given, then with /mcp.
    Returns the endpoint that answered (remembered per server), or None."""
    h = _mcp_headers(server_url)   # outside the try: a bad MCP_HEADERS_<SLUG> stops the run
    init_req = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05",
                           "clientInfo": {"name": "ADK-Workflow", "version": "1.0.0"}, "capabilities": {}}}
    candidates = [_MCP_ENDPOINTS[server_url]] if server_url in _MCP_ENDPOINTS else []
    live = _mcp_live_url(server_url)
    for cand in _mcp_candidates(live):
        if cand not in candidates:
            candidates.append(cand)
    last_err = None
    for mcp_url in candidates:
        try:
            with httpx.Client(timeout=30) as c:
                r = c.post(mcp_url, json=init_req, headers=h)
                r.raise_for_status()
                data = _parse_mcp_response(r.text)
                if data is None or "error" in data:
                    last_err = (data or {}).get("error") if data else "invalid response"
                    continue
                c.post(mcp_url, json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, headers=h)
                _MCP_ENDPOINTS[server_url] = mcp_url
                return mcp_url
        except Exception as e:
            last_err = e
    print(f"[warn] MCP init failed for {server_url}: {last_err}")
    return None


def _call_mcp_tool_raw(server_url: str, tool_name: str, arguments: dict) -> dict:
    """tools/call; the raw MCP result {content, structuredContent?, isError?} (code nodes)."""
    mcp_url = _init_mcp_session(server_url) or _mcp_candidates(_mcp_live_url(server_url))[-1]
    request = {"jsonrpc": "2.0", "id": int(time.time()), "method": "tools/call",
               "params": {"name": tool_name, "arguments": arguments or {}}}
    try:
        with httpx.Client(timeout=180) as c:
            r = c.post(mcp_url, json=request, headers=_mcp_headers(server_url))
            r.raise_for_status()
            data = _parse_mcp_response(r.text)
    except Exception as e:   # refused, timed out, HTTP error
        return {"isError": True, "transport_error": True, "content": [{"type": "text", "text": str(e)}]}
    if data is None:
        return {"isError": True, "content": [{"type": "text", "text": "invalid response"}]}
    if "error" in data:
        return {"isError": True, "content": [{"type": "text", "text": data["error"].get("message", "unknown")}]}
    return data.get("result") or {}


def _call_mcp_tool(server_url: str, tool_name: str, arguments: dict) -> str:
    """tools/call for an agent's tool or a playbook #Action: the result's text items joined,
    the raw result as JSON when it has none, {"error": ...} on failure."""
    res = _call_mcp_tool_raw(server_url, tool_name, arguments)
    texts = [c.get("text", "") for c in res.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"]
    if res.get("isError"):
        return json.dumps({"error": "\n".join(t for t in texts if t) or "tool error"})
    return "\n".join(t for t in texts if t) or json.dumps(res)[:8000]
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
    match ext:
        case _ if ext in text_native:
            return p.read_text(encoding="utf-8", errors="replace")

        case ".docx":
            import mammoth
            with p.open("rb") as f:
                return mammoth.convert_to_markdown(f).value

        case ".pptx":
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

        case ".xlsx" | ".xlsm":
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

        case ".pdf":
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

        case _:
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
    instruction=_agent_instruction("A", []),
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
    instruction=_agent_instruction("B", []),
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
    took: dict = {}   # parent key -> [route key, exits leading here]: a code parent counts only through the exit it took

    async def _run_async_impl(self, ctx):
        st = ctx.session.state
        keys = [k for k in self.source_keys if k not in self.took or st.get(self.took[k][0]) in self.took[k][1]]
        vals = [str(st.get(k, "")) for k in keys]
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
# RUN EVENTS
# Each node's start and completion (a code node's exit, a
# dispatcher's route) go to GRAPH_RECORDER when the package's
# listener set one: runs/ and GET /live, the editor's live canvas.
# ==============================================================
NODE_META = {
    "node_2": [
        "2",
        "agent",
        "A"
    ],
    "node_3": [
        "3",
        "agent",
        "B"
    ],
    "node_4": [
        "4",
        "output",
        "Output"
    ]
}   # agent name -> [node id, type, canvas name]: the nodes whose runs are recorded
START_NODE = ["1", "Start"]   # [id, name] of the Start node
DISPATCHER_IDS = []   # dispatchers record themselves; their choice is work (not a quiet poll)
OUTPUT_NODE_KEYS = ["node_4"]   # the Output nodes: their answers are the workflow's answer
GRAPH_RECORDER = None   # the run's RunRecorder (the package's listener sets it); None: nothing is recorded
_RUN = {"ran": [], "routes": {}, "open": {}, "unrouted": ""}   # this run: nodes that ran, code exits, nodes
#   started not completed, and why a dispatcher did not route (the answer when nothing reached the Output)


def _set_recorder(recorder) -> None:
    """The run's recorder: the listener's run_once sets it for a run and resets it after. A setter, not an
    assignment from outside, so a package that keeps this in common.py still records."""
    global GRAPH_RECORDER
    GRAPH_RECORDER = recorder


def _current_recorder():
    return GRAPH_RECORDER


def _run_reset() -> None:
    _RUN["ran"], _RUN["routes"], _RUN["open"], _RUN["unrouted"] = [], {}, {}, ""


def _rec_node_start(nid: str, name: str, ntype: str) -> None:
    _RUN["open"][nid] = (name, ntype)
    if GRAPH_RECORDER is not None:
        GRAPH_RECORDER.node_start(nid, name, ntype)


def _rec_node_complete(nid: str, name: str, ntype: str, output: str = "", **extra) -> None:
    _RUN["open"].pop(nid, None)
    _RUN["ran"].append(nid)
    if "exit" in extra:
        _RUN["routes"][nid] = extra["exit"]
    if GRAPH_RECORDER is not None:
        GRAPH_RECORDER.node_complete(nid, name, ntype, output=str(output or ""), **extra)


def _rec_before(callback_context):
    meta = NODE_META.get(callback_context.agent_name)
    if meta:
        _rec_node_start(meta[0], meta[2], meta[1])
    return None


def _rec_after(callback_context):
    meta = NODE_META.get(callback_context.agent_name)
    if meta:
        nid, ntype, name = meta
        extra = {"exit": callback_context.state.get("route_" + nid)} if ntype == "code" else {}
        _rec_node_complete(nid, name, ntype, output=callback_context.state.get("node_" + nid, ""), **extra)
    return None


def _attach_recording(agent) -> None:
    """Every recorded node's agent gets the before/after callbacks, wherever it sits in the tree."""
    if agent.name in NODE_META:
        agent.before_agent_callback = _rec_before
        agent.after_agent_callback = _rec_after
    for sub in getattr(agent, "sub_agents", None) or []:
        _attach_recording(sub)
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
_attach_recording(root_agent)   # run events for every recorded node (see RUN EVENTS)
# ==============================================================
# CLI ENTRY
# Seeds the prompt (+ attached documents), runs the graph via
# Runner, streams a [node]/[tool] trace, saves the result per the
# Output node storage setting, and closes with a RUN SUMMARY
# (time per node, total wall-clock, document location).
# ==============================================================
WORKFLOW_NAME = "diamond"
WORKFLOW_ID = 1
START_MODE = "prompt"
DEFAULT_CRON = None
DEFAULT_WATCH = None
DEFAULT_PROMPT = "GO"
OUTPUT_STORAGE_ENABLED = False
OUTPUT_FOLDER = None
NODE_NAMES = {
    "2": "A",
    "3": "B"
}  # node id -> human name (for readable logs)
OUTPUT_IDS = [
    "4"
]  # the Output nodes: named "Output" in the logs, not timed in the summary

async def run_workflow(prompt: str, session: str | None = None) -> str:
    if START_DOCUMENTS:
        doc_parts = []
        for doc in START_DOCUMENTS:
            name = doc.get("name", "Document")
            path = doc.get("path", "")
            if path and not os.path.isabs(path):
                path = os.path.join(PACKAGE_DIR, path)   # start_documents/ in the package
            if not path:
                doc_parts.append(f"### {name}\n\n_(no path on attachment record)_")
                continue
            try:
                md = _convert_doc_to_markdown(path)
                doc_parts.append(f"### {name}\n\n{md}")
            except Exception as e:
                doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
        if doc_parts:
            prompt = (
                "## Attached Documents\n\n"
                + "\n\n---\n\n".join(doc_parts)
                + "\n\n---\n\n"
                + prompt
            )
    print(f"[workflow] {WORKFLOW_NAME} starting", flush=True)
    print(f"[workflow] prompt: {prompt[:200]!r}", flush=True)
    session_service = InMemorySessionService()
    runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)
    adk_session = await session_service.create_session(app_name="workflow", user_id="local", state={"user_prompt": prompt})
    _run_reset()
    if START_NODE:
        _rec_node_start(START_NODE[0], START_NODE[1], "start")
        _rec_node_complete(START_NODE[0], START_NODE[1], "start", output=prompt)
    outputs = {}   # the Output nodes' answers (the workflow's answer, when it has Output nodes)
    final = ""
    t0 = time.monotonic()
    seen = set()
    _t_first, _t_last = {}, {}  # per-node timing for the RUN SUMMARY
    content = types.Content(role="user", parts=[types.Part(text=prompt)])
    try:
        async for event in runner.run_async(user_id="local", session_id=adk_session.id, new_message=content):
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
                    _kind = "skill step" if "skill" in author else "node"
                    print(f"[node {_nid}] {NODE_NAMES.get(_nid, 'Output' if _nid in OUTPUT_IDS else _nid)!r} \u2192 {_kind} active", flush=True)
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
                if author in OUTPUT_NODE_KEYS:
                    outputs[author] = event.content.parts[0].text or ""
        if OUTPUT_NODE_KEYS:   # the answer is what the Output nodes gave: none ran (nothing to do) = ""
            final = "\n\n---\n\n".join(v for v in outputs.values() if v)
        final = final or _RUN["unrouted"]   # nothing reached the Output: why the dispatcher did not route
        print(f"[workflow] done in {time.monotonic() - t0:.1f}s, {len(final)} chars", flush=True)
    except Exception as e:
        for _nid, (_name, _type) in list(_RUN["open"].items()):   # a node that failed mid-run ends as failed
            _rec_node_complete(_nid, _name, _type, success=False, error=f"{type(e).__name__}: {e}")
        print("[workflow] ERROR:", flush=True)
        traceback.print_exc()
        raise
    print(final)
    # Closing RUN SUMMARY (printed LAST): time per node, total wall-clock.
    # Where the document was saved is NOT part of this block: saving belongs
    # to __main__ (see below), so the CLI entry prints that line itself right
    # after this one.
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
    print("=" * 74, flush=True)
    return final

# ============================== CLI ENTRY =================================
# Extracting the deliverable and saving it both live HERE, not in
# run_workflow(): the run server calls run_workflow() once per
# conversational turn, and a turn must not write a file per prompt.
# run_workflow() returns the answer UN-STRIPPED for the same reason --
# the editor runs this same extraction on what it receives, so narration
# wrapped around a document (or a second document, which the non-greedy
# regex would discard) must still be there when the answer arrives.
if __name__ == "__main__":
    # argparse would fight the prompt's own spaces; the runner
    # passes it space-split; sys.argv[1] alone would keep only the first word.
    _text = asyncio.run(run_workflow(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else "GO"))
    # Honour the Output node's storage setting: when ON, persist the final result
    # where the app stores it (~/Documents/synergyAI/outputs/workflow/ by default,
    # overridable via SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, skip.
    _saved_path = None
    if OUTPUT_STORAGE_ENABLED:
        import re as _re
        _mm = _re.search(r"(?is)<!doctype html.*?</html\s*>", _text) or _re.search(r"(?is)<html[\s>].*?</html\s*>", _text)
        if _mm:
            _text = _mm.group(0)  # strip narration/fences around a full HTML doc
            _ext = "html"
        else:
            _ext = "md"
        _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"
        _ts = time.strftime("%Y%m%d-%H%M%S")
        _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
        if OUTPUT_FOLDER:
            _cf = os.path.expanduser(OUTPUT_FOLDER)
            _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)
        else:
            _save_dir = os.path.join(_root, "workflow")
        os.makedirs(_save_dir, exist_ok=True)
        _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")
        with open(_out, "w", encoding="utf-8") as _f:
            _f.write(_text)
        _saved_path = os.path.abspath(_out)
    if _saved_path:
        print(f"  Document saved to: {_saved_path}", flush=True)
    else:
        print("  Document not saved (output storage is OFF in the workflow settings) -- "
              "the output is printed above.", flush=True)
