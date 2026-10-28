import {
    F, JSON_PRETTY_PRINT, JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, array_key_exists, array_unique, count, date, elvis, empty,
    entries, explode, has, implode, in_array, intval, is_array, json_encode, mb_strimwidth, oarr, preg_match, rtrim, str_pad, str_repeat,
    str_replace, strlen, strtolower, strval, toArr, toObject, trim, truthy, values,
} from './php';

/**
 * PythonEmitHelpers
 *
 * Shared Python-code-emission helpers used by LangGraphGenerator and
 * (from Task 5 onwards) ADKGenerator.
 *
 * All methods are pure static; no DB or state dependencies.
 *
 * Methods moved verbatim from LangGraphGenerator:
 *   - jsonToPython()            PHP value → Python literal (True/False/None)
 *   - mcpClientBlock()          MCP JSON-RPC client Python functions
 *   - skillDepsBlock()          SKILLS_DIR globals + _ensure_skill_deps Python function
 *   - documentConverterBlock()  _convert_doc_to_markdown() Python function
 *
 * New helpers (not previously in LangGraphGenerator):
 *   - pyStr()          PHP string → Python double-quoted string literal
 */
export class PythonEmitHelpers
{
    /**
     * Serialize a value to a Python-valid literal string.
     *
     * json_encode produces 'true'/'false'/'null' which are not valid Python.
     * This converts to 'True'/'False'/'None'. Uses 4-space indent matching
     * Python's json.dumps(indent=4) output.
     *
     * @param mixed $value
     */
    static jsonToPython(value: any, forceObject: boolean = false): string {
        let raw: string;
        if (forceObject && is_array(value)) {
            // Cast top-level array to object so empty arrays encode as {}
            // and associative arrays encode as object literals.
            value = toObject(value);
        }
        raw = json_encode(value, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        raw = str_replace(': true', ': True', raw);
        raw = str_replace(': false', ': False', raw);
        raw = str_replace(': null', ': None', raw);
        return raw;
    }

    /**
     * A value as a one-line Python literal: compact JSON with the bare true / false / null
     * (never those words inside a string) spelled True / False / None.
     */
    static pyLiteral(value: any): string {
        const raw = json_encode(value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        const words: Record<string, string> = { true: 'True', false: 'False', null: 'None' };
        return raw.replace(/"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b/g, (m: string) => words[m] ?? m);
    }

    /**
     * Render a PHP string as a Python double-quoted string literal.
     *
     * Escapes backslashes, double-quotes, newlines, carriage returns,
     * and tabs so the result is a valid Python string expression.
     *
     * Example: pyStr("line1\nquote\"x") → '"line1\\nquote\\"x"'
     */
    static pyStr(s: string): string {
        s = str_replace('\\', '\\\\', s);
        s = str_replace('"', '\\"', s);
        s = str_replace('\n', '\\n', s);
        s = str_replace('\r', '\\r', s);
        s = str_replace('\t', '\\t', s);
        return '"' + s + '"';
    }

    /**
     * Emit the MCP JSON-RPC client Python block.
     *
     * Returns the functions: _mcp_candidates, _init_mcp_session,
     * _parse_mcp_response, and _call_mcp_tool.
     *
     * Moved verbatim from LangGraphGenerator::mcpClientBlock().
     */
    static mcpClientBlock(): string {
        return `def _mcp_candidates(url: str) -> list:
    """The endpoints to try for a registered MCP server URL, in order.

    - The URL exactly as registered first (servers addressed by query or
      mounted at their bare URL answer there, e.g. PHP endpoints).
    - Then with /mcp inserted into the path, before any query string.
    - A path already ending in /mcp or .php is the endpoint: no fallback.
    """
    cut = min([i for i in (url.find("?"), url.find("#")) if i >= 0] or [len(url)])
    path, rest = url[:cut].rstrip("/"), url[cut:]
    if path.endswith("/mcp") or path.endswith(".php"):
        return [url]
    return [url, path + "/mcp" + rest]

_MCP_ENDPOINTS: dict = {}   # registered server URL -> endpoint that accepted the handshake

def _init_mcp_session(url: str, headers: dict) -> str | None:
    """Initialize an MCP session with the server.

    The MCP protocol requires a handshake before tool calls:
    1. Client sends 'initialize' with protocol version and capabilities
    2. Server responds with its capabilities
    3. Client sends 'notifications/initialized' to confirm

    Tries _mcp_candidates(url) in order: the URL exactly as registered, then
    with /mcp in its path. The endpoint that answers is remembered.
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
    for cand in _mcp_candidates(url):
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
    headers = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream, */*"}

    mcp_url = _init_mcp_session(server_url, headers) or _mcp_candidates(server_url)[-1]

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
`;
    }

    /**
     * Emit the skill-dependency-install Python block.
     *
     * Returns: SKILLS_DIR constant, _INSTALLED_DEPS/_DEPS_LOCK globals,
     * and the _ensure_skill_deps() function that reads SKILL.md YAML
     * frontmatter and pip-installs declared dependencies on first use.
     *
     * Extracted verbatim from LangGraphGenerator::toolBuilderBlock().
     * ADKGenerator calls this too so the emitted Python is identical
     * across both code paths.
     */
    static skillDepsBlock(): string {
        return `# ---------------------------------------------------------------------------
# Local run_skill_script — execute a folder-backed skill's Python script as a
# subprocess. Skills are real CPython (the browser runs them in Pyodide; here
# we shell out). Registered into the catalog at startup so skill-bound agents
# actually run their skill instead of fabricating output.
# ---------------------------------------------------------------------------
SKILLS_DIR = os.environ.get(
    "SYNERGYAI_SKILLS_DIR",
    os.path.join(os.path.expanduser("~"), "Documents", "synergyAI", "skills"),
)

# Skills declare their PyPI deps in SKILL.md frontmatter
# (e.g. \`dependencies: [beautifulsoup4]\`). The browser installs them via
# micropip; here we pip-install missing ones into the runner venv on first
# use. Cached + lock-guarded because parallel branches call skills at once.
_INSTALLED_DEPS = set()
_DEPS_LOCK = threading.Lock()


def _ensure_skill_deps(skill_dir: str) -> None:
    md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(md):
        return
    deps = []
    try:
        lines = open(md, encoding="utf-8").read().splitlines()
    except Exception:
        return
    # Only the YAML frontmatter (between leading '---' fences) is authoritative;
    # a 'dependencies:' line in the prose body is not a real declaration.
    if not lines or lines[0].strip() != "---":
        return
    for line in lines[1:]:
        s = line.strip()
        if s == "---":
            break
        if s.lower().startswith("dependencies:"):
            val = s.split(":", 1)[1].strip().strip("[]")
            deps = [d.strip().strip("'").strip('"') for d in val.split(",") if d.strip()]
            break
    with _DEPS_LOCK:
        for d in deps:
            if d in _INSTALLED_DEPS:
                continue
            _INSTALLED_DEPS.add(d)
            try:
                print(f"  [run_skill_script] ensuring dependency: {d}", flush=True)
                r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", d],
                                   capture_output=True, text=True, timeout=600)
                if r.returncode != 0:
                    print(f"  [run_skill_script] pip install {d} FAILED: "
                          f"{(r.stderr or '')[-300:]}", flush=True)
            except Exception as e:
                print(f"  [run_skill_script] pip install {d} error: {e}", flush=True)
`;
    }

    /**
     * Emit the synchronous skill filesystem Python block.
     *
     * Returns: SKILL_OUTPUTS_ROOT / SKILL_SCRATCH_DIR / _LAST_SKILL_OUTPUTS globals,
     * _skill_output_dir(), _remap_virtual_path(), _run_skill_script() (synchronous
     * subprocess.run with bucketed dirs, argv remap, input_files staging, SYNERGYAI_*
     * env, and read_outputs → _LAST_SKILL_OUTPUTS stash), and _read_skill_md().
     *
     * Framework-agnostic — contains NO LangChain/langchain_core symbols. LangGraph no
     * longer emits this block: LangGraphRuntime::skillRuntimeBlock() carries its own copy.
     *
     * Depends on SKILLS_DIR + _ensure_skill_deps from skillDepsBlock() being emitted
     * first. Shared by MAFGenerator and NOOAGenerator.
     */
    static skillFsSyncBlock(): string {
        return `

# Skill filesystem (mirrors the browser interpreter + ADK): real bucketed /outputs and
# /scratch dirs, virtual-path remap, env exposure, and a deliverable stash so a skill's
# produced file (not the model's chatter) can become the node output.
SKILL_OUTPUTS_ROOT = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(SKILLS_DIR), "outputs")
SKILL_SCRATCH_DIR = os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(os.path.dirname(SKILLS_DIR), "scratch")
_LAST_SKILL_OUTPUTS = {}


def _skill_output_dir(dir_name: str) -> str:
    group = dir_name.split("/")[0] if "/" in dir_name else ""
    if group and all(c.isalnum() or c in "._-" for c in group):
        return os.path.join(SKILL_OUTPUTS_ROOT, group)
    return SKILL_OUTPUTS_ROOT


def _remap_virtual_path(p, out_dir: str) -> str:
    p = str(p)
    for virt, real in (("/outputs", out_dir), ("/scratch", SKILL_SCRATCH_DIR)):
        if p == virt:
            return real
        if p.startswith(virt + "/"):
            return os.path.join(real, p[len(virt) + 1:])
    return p


def _fix_overescaped(text):
    """Repair JSON-style over-escaping in model-carried document content.

    Models (Claude especially) sometimes emit large documents inside tool
    arguments as an escaped single-line string: literal \\\\n / \\\\" sequences
    and ZERO real newlines. Written verbatim, the HTML/CSS is broken and the
    page renders unstyled (a live report shipped with 1131 literal \\\\n).
    Mirrors the platform chat's _coerceInputFiles over-escape recovery.
    Detection is conservative: many escape sequences AND no real newlines."""
    s = str(text)
    if s.count("\\\\n") > 5 and s.count("\\n") == 0:
        print("  [stage] repairing over-escaped content ("
              + str(s.count("\\\\n")) + " literal escape sequences)", flush=True)
        s = (s.replace("\\\\\\\\", "\\x00").replace("\\\\n", "\\n").replace("\\\\t", "\\t")
              .replace("\\\\r", "").replace('\\\\"', '"').replace("\\\\'", "'").replace("\\x00", "\\\\"))
    return s


def _run_skill_script(dir_name: str, script: str, argv=None,
                      input_files=None, read_outputs=None) -> str:
    if isinstance(argv, str):
        try:
            argv = json.loads(argv)
        except Exception:
            argv = [argv]
    argv = list(argv) if argv else []
    skill_dir = os.path.join(SKILLS_DIR, *str(dir_name).split("/"))
    script_path = os.path.join(skill_dir, *str(script).split("/"))
    if not os.path.isfile(script_path):
        return f"ERROR: skill script not found: {dir_name}/{script} (looked in {script_path})"
    _ensure_skill_deps(skill_dir)
    out_dir = _skill_output_dir(dir_name)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(SKILL_SCRATCH_DIR, exist_ok=True)
    # Remap the interpreter's virtual /outputs & /scratch in argv to real dirs.
    argv = [_remap_virtual_path(a, out_dir) for a in argv]
    # Stage input_files (e.g. HTML the skill will render) at their remapped paths.
    if isinstance(input_files, dict):
        for raw_path, content in input_files.items():
            try:
                target = _remap_virtual_path(raw_path, out_dir)
                os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                with open(target, "w", encoding="utf-8") as fh:
                    fh.write(_fix_overescaped(content))
            except Exception as e:
                print(f"  [run_skill_script] could not stage {raw_path}: {e}")
    env = dict(
        os.environ,
        SYNERGYAI_OUTPUT_DIR=out_dir,
        SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR,
        SYNERGYAI_SKILL_DIR_NAME=dir_name,
        SYNERGYAI_SKILL_GROUP=(dir_name.split("/")[0] if "/" in dir_name else ""),
    )
    cmd = [sys.executable, script_path] + [str(a) for a in argv]
    print(f"  [run_skill_script] → {dir_name}/{script} argv={argv}", flush=True)
    _t0 = time.monotonic()
    try:
        proc = subprocess.run(cmd, cwd=skill_dir, env=env, capture_output=True,
                              text=True, timeout=300)
    except subprocess.TimeoutExpired:
        print(f"  [run_skill_script] ← {dir_name}/{script}: TIMEOUT after 300s", flush=True)
        return f"ERROR: skill {dir_name}/{script} timed out after 300s"
    _dt = time.monotonic() - _t0
    out = proc.stdout or ""
    _stderr = (proc.stderr or "").strip()
    _head = out.replace(chr(10), " ")[:160]
    print(f"  [run_skill_script] ← {dir_name}/{script}: exit={proc.returncode}, "
          f"{len(out)} chars stdout, {_dt:.1f}s | {_head}", flush=True)
    if proc.returncode != 0 and _stderr:
        print(f"  [run_skill_script]   stderr tail: {_stderr[-400:]}", flush=True)
    if proc.returncode != 0:
        out = (out + f"\\n[run_skill_script exit {proc.returncode}]\\n"
               + _stderr[-2000:]).strip()
    # Read back requested outputs AND stash them so the skill step can use the produced
    # document as the node output.
    _produced = []
    if isinstance(read_outputs, list):
        for rel in read_outputs:
            try:
                with open(_remap_virtual_path(rel, out_dir), "r", encoding="utf-8") as fh:
                    _content = fh.read()
                out += f"\\n\\n[output file {rel}]\\n" + _content
                _produced.append(_content)
            except Exception:
                pass
    if _produced:
        _LAST_SKILL_OUTPUTS[dir_name] = _produced
    return out or "(skill produced no stdout)"


def _read_skill_md(dir_name: str) -> str:
    """The live SKILL.md body (progressive disclosure); frontmatter stripped."""
    path = os.path.join(SKILLS_DIR, *str(dir_name).split("/"), "SKILL.md")
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return f"(SKILL.md not found for skill '{dir_name}')"
    if text.startswith("---"):
        end = text.find("\\n---\\n", 3)
        if end != -1:
            nl = text.find("\\n", end + 1)
            text = text[nl + 1:] if nl != -1 else ""
    return text.strip()
`;
    }

    /**
     * Event sink + gate rendezvous. Inert unless a host (the generated api.py)
     * installs a sink, so CLI runs behave exactly as before. Gates block a
     * worker thread on a threading.Event rather than an asyncio.Future: the
     * playbook's gate tools are sync callables that LangChain runs in an
     * executor, so the server's event loop stays free to serve the POST that
     * answers them.
     *
     * THE CALLER MUST SUPPLY `import threading`. This block uses
     * threading.Lock()/threading.Event() and imports nothing itself, so emitted
     * on its own it dies at import with a NameError. The import is not in here
     * because LangGraph's common.py header already imports threading for an
     * unrelated reason: adding it to the block would duplicate that import and
     * move LangGraph's pinned emitted bytes. RunServerEmitter::commonBlock() is
     * the standalone caller and prepends the import — do the same in any new one.
     */
    static eventSinkBlock(): string {
        return `# ==============================================================
# EVENT SINK + GATE RENDEZVOUS
# Inert until a host installs a sink (see api.py). With no sink the
# generated code prints its trace lines and nothing else changes.
# ==============================================================
_SINK = None            # callable(dict) -> None, or None
_GATES = {}             # tool_call_id -> {"event": threading.Event, "answer": dict | None}
_GATES_LOCK = threading.Lock()


def set_event_sink(fn):
    """Install (or clear with None) the run-event sink. Returns the previous one."""
    global _SINK
    prev, _SINK = _SINK, fn
    return prev


def emit_event(**ev):
    """Publish one protocol event. A no-op when no sink is installed."""
    sink = _SINK
    if sink is not None:
        sink(dict(ev))


def open_gate(tool_call_id: str):
    """Register a pending gate and return the Event the waiter blocks on."""
    with _GATES_LOCK:
        slot = {"event": threading.Event(), "answer": None}
        _GATES[tool_call_id] = slot
    return slot["event"]


def resolve_gate(tool_call_id: str, answer: dict) -> bool:
    """Deliver a human answer to a waiting gate. False when no gate is waiting."""
    with _GATES_LOCK:
        slot = _GATES.get(tool_call_id)
    if slot is None:
        return False
    slot["answer"] = dict(answer or {})
    slot["event"].set()
    return True


def take_gate_answer(tool_call_id: str):
    """Pop a resolved gate's answer (None when unanswered), clearing the slot."""
    with _GATES_LOCK:
        slot = _GATES.pop(tool_call_id, None)
    return slot["answer"] if slot else None
`;
    }

    /**
     * Emit the document-to-markdown converter Python function.
     *
     * Returns _convert_doc_to_markdown(path) which reads a file and returns
     * its contents as Markdown. Text-native formats pass through verbatim;
     * binary office formats and PDFs are routed to their matching pure-Python
     * parser with lazy imports.
     *
     * Moved verbatim from LangGraphGenerator::documentConverterBlock().
     * Both generators call this so the emitted Python is identical.
     */
    static documentConverterBlock(): string {
        return `def _convert_doc_to_markdown(path: str) -> str:
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
                    sections.append("\\n".join(body))
                if slide.has_notes_slide:
                    notes = (slide.notes_slide.notes_text_frame.text or "").strip()
                    if notes:
                        sections.append("### Notes")
                        sections.append(notes)
            return "\\n\\n".join(sections) + "\\n"

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
                    return ("" if v is None else str(v)).replace("|", "\\\\|").replace("\\n", " ")
                table = ["| " + " | ".join(cell(v) for v in rows[0]) + " |",
                         "| " + " | ".join(["---"] * width) + " |"]
                for r in rows[1:]:
                    table.append("| " + " | ".join(cell(v) for v in r) + " |")
                if truncated:
                    table.append(f"\\n_(showing first {max_rows} rows)_")
                sections.append("\\n".join(table))
            return "\\n\\n".join(sections) + "\\n"

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
            return "\\n\\n".join(parts) + "\\n"

        case _:
            raise ValueError(f"unsupported document format: {ext}")
`;
    }

    // ------------------------------------------------------------------
    // Generated-script documentation (shared by every compile target)
    // ------------------------------------------------------------------

    /** Env var that carries the API key of each LLM provider (as the runner's .env names them). */
    static readonly PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
        claude: 'ANTHROPIC_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY', gemini: 'GOOGLE_API_KEY', google: 'GOOGLE_API_KEY',
        grok: 'XAI_API_KEY', xai: 'XAI_API_KEY', kimi: 'KIMI_API_KEY', moonshot: 'KIMI_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY', glm: 'GLM_API_KEY',
    };

    /** Env var that carries the API key of a provider (as the runner's .env names them). */
    static providerKeyEnv(provider: string): string | null {
        const k = strtolower(provider);
        return Object.prototype.hasOwnProperty.call(PythonEmitHelpers.PROVIDER_KEY_ENV, k) ? PythonEmitHelpers.PROVIDER_KEY_ENV[k] : null;
    }

    /** One-line summary of a node descriptor (see WorkflowGraphAnalyzer::docNodes). */
    private static nodeSummary(n: any): string {
        const t = n['type'];
        if (t === 'start') {
            const p = trim(strval(n['prompt'] ?? ''));
            return 'receives the user prompt' + (p !== '' ? ' -- default: ' + json_encode(mb_strimwidth(p, 0, 70, '…'), JSON_UNESCAPED_UNICODE) : '');
        }
        if (t === 'output') {
            return 'merges its parents\' outputs verbatim (no LLM) -- the workflow result';
        }
        const bits: string[] = [];
        if ((n['provider'] ?? '') !== '' || (n['model'] ?? '') !== '') {
            bits.push(strval(elvis(n['provider'], '?')) + '/' + (n['model'] !== '' ? strval(n['model']) : '(platform default)'));
        }
        if ((n['temperature'] ?? null) !== null) bits.push('temp ' + json_encode(F(n['temperature'])));
        if ((n['max_tokens'] ?? null) !== null) bits.push('max_tokens ' + intval(n['max_tokens']));
        if (in_array(n['thinking'] ?? null, ['on', 'off'], true)) bits.push('thinking ' + n['thinking']);
        if ((n['playbook'] ?? null) !== null) {
            const pb = n['playbook'];
            let s = 'playbook ' + json_encode(strval(pb['title'] ?? ''), JSON_UNESCAPED_UNICODE);
            if ((pb['bound'] ?? null) !== null) s += `, ${strval(pb['bound'])} bound / ` + intval(pb['unbound'] ?? 0) + ' unbound action(s)';
            s += ', writes ' + (!empty(pb['writes']) ? 'ON' : 'OFF');
            bits.push(s);
        } else {
            bits.push(count(n['tools']) + ' tool(s)');
            if (truthy(n['skills'])) bits.push(count(n['skills']) + ' skill(s): ' + implode(', ', n['skills']));
        }
        if (truthy(n['dispatch'])) bits.push('DISPATCHER -> one of: ' + implode(' | ', n['dispatch']));
        let s = bits.join(', ');
        if (truthy(n['dispatch']) && empty(n['dispatch_supported'])) {
            s += ' (menu NOT honoured by this target: all children run)';
        }
        if (empty(n['supported'])) {
            s += ' -- NOT RUN BY THIS TARGET (' + strval(t) + ' nodes are not supported here; the node is skipped)';
        }
        return s;
    }

    /**
     * The uniform documentation body every generated script carries in its
     * module docstring: provenance, graph nodes, graph edges, execution
     * order, target data flow, how to run. Same sections for every target
     * and every workflow shape. Returned WITHOUT the surrounding quotes.
     *
     * $doc keys: target, workflow{id,name}, nodes (docNodes; an optional
     * 'marker' key on one node is appended after its GRAPH NODES summary
     * only -- GRAPH EDGES/EXECUTION ORDER use 'name' unmodified), edges
     * [[from,to]], layers [[ids]], data_flow (target text),
     * run{deps[],usage,extra[],env_path (default '../.env')},
     * storage{enabled,folder}.
     */
    static workflowDocBlock(doc: any): string {
        const nodes: any[] = values(doc['nodes']);
        const byId = oarr<any>();
        for (const n of nodes) byId[strval(n['id'])] = n;
        const lbl = (id: string): string => (has(byId, id) ? strval(byId[id]['name']) : 'node') + ` (${id})`;
        const dispatchers = oarr<boolean>();
        for (const n of nodes) if (truthy(n['dispatch'])) dispatchers[strval(n['id'])] = true;
        // Only LangGraph turns a dispatcher's fan-out into a choice today; the other
        // targets run the menu children in parallel, and the doc must say so.
        const dispatchOk = !empty(doc['dispatch_supported']);
        const menuNote = dispatchOk ? '   (dispatcher menu: one of)' : '   (dispatcher menu: NOT honoured by this target -- runs in parallel)';
        const L: string[] = [];
        L.push('PROVENANCE');
        L.push('==========');
        L.push(`  Workflow:   ${strval(doc['workflow']['name'])} (id ${strval(doc['workflow']['id'])})`);
        L.push(`  Target:     ${strval(doc['target'])}`);
        L.push('  Generated:  ' + strval(doc['generated_at'] ?? date('Y-m-d H:i:s T')) + ' by the SynergyAI workflow editor');
        L.push('  This file is a frozen snapshot of the workflow. Edits made here are');
        L.push('  overwritten by the next Generate: change the workflow in the editor and');
        L.push('  re-generate instead.');
        L.push('');
        L.push('GRAPH NODES  (id (type): name -- settings; topological order)');
        L.push('===========');
        let w = 0;
        for (const n of nodes) w = Math.max(w, strlen(`${strval(n['id'])} (${strval(n['type'])}):`));
        for (const n of nodes) {
            // $n + ['dispatch_supported' => $dispatchOk]: the node's own key wins.
            const withFlag = array_key_exists('dispatch_supported', n) ? n : { ...plainCopy(n), dispatch_supported: dispatchOk };
            L.push('  ' + str_pad(`${strval(n['id'])} (${strval(n['type'])}):`, w) + ' ' + strval(n['name']) + ' -- ' + PythonEmitHelpers.nodeSummary(withFlag)
                + ((n['marker'] ?? '') !== '' ? '   ' + strval(n['marker']) : ''));
        }
        L.push('');
        L.push('GRAPH EDGES  (from -> to)');
        L.push('===========');
        if (empty(doc['edges'])) L.push('  (none)');
        for (const e of values(doc['edges'])) {
            const f = strval(e[0]);
            const t = strval(e[1]);
            L.push('  ' + lbl(f) + ' -> ' + lbl(t) + (has(dispatchers, f) && has(byId, t) && byId[t]['type'] !== 'output' ? menuNote : ''));
        }
        L.push('');
        L.push('EXECUTION ORDER  (topological layers; nodes on one line run in PARALLEL)');
        L.push('===============');
        values(doc['layers'] ?? []).forEach((layer: any, i: number) => {
            const ids = values(toArr(layer)).map((x: any) => strval(x));
            const names = ids.map((id) => (has(byId, id) ? strval(byId[id]['name']) : `node_${id}`));
            let line = `  layer ${i}:  ` + names.join('  ||  ');
            let viaDispatcher = false;
            // `$n['id'] === $id`: strict, so an int node id never matches the strval'd layer id.
            for (const id of ids) for (const n of nodes) if (n['id'] === id) for (const p of values(n['parents'])) {
                const m: string[] = [];
                if (preg_match('/\\((\\S+)\\)$/', p, m) && has(dispatchers, m[1])) viaDispatcher = true;
            }
            if (ids.length > 1) {
                line += (viaDispatcher && dispatchOk) ? '   (dispatcher: only the chosen one runs)'
                    : (viaDispatcher ? '   (run in PARALLEL -- dispatcher menu not honoured by this target)' : '   (run in PARALLEL)');
            }
            L.push(line);
        });
        L.push('');
        L.push('DATA FLOW');
        L.push('=========');
        for (const dl of explode('\n', rtrim(strval(doc['data_flow'] ?? '')))) L.push(dl);
        L.push('');
        L.push('TO RUN');
        L.push('======');
        L.push('  # Requires Python 3.10+ (the generated code uses match statements)');
        const run = doc['run'] ?? null;
        for (const dep of values(toArr(run?.['deps'] ?? []))) L.push('  ' + strval(dep));
        const keys = oarr<string[]>();
        for (const n of nodes) {
            if ((n['provider'] ?? '') === '' || empty(n['supported'])) continue;
            const k = PythonEmitHelpers.providerKeyEnv(strval(n['provider']));
            if (k !== null) {
                if (keys[k] === undefined) keys[k] = [];
                keys[k].push(strtolower(n['provider']));
            }
        }
        const envPath = (run?.['env_path'] ?? '') !== '' ? strval(run['env_path']) : '../.env';
        if (count(keys) > 0) {
            L.push(`  # API keys read from ${envPath} for the providers this workflow uses:`);
            for (const [k, provs] of entries<string[]>(keys)) L.push(`  #   ${k} (` + implode(', ', array_unique(provs)) + ')');
        } else {
            L.push('  # No LLM provider is used by a runnable node of this workflow.');
        }
        L.push('  ' + strval(run?.['usage'] ?? 'python this_file.py "your prompt here"'));
        for (const x of values(toArr(run?.['extra'] ?? []))) L.push('  ' + strval(x));
        let hasPlaybook = false;
        for (const n of nodes) if ((n['playbook'] ?? null) !== null && !empty(n['supported'])) hasPlaybook = true;
        if (hasPlaybook) {
            L.push('  # Human gates (playbook nodes): on a terminal the script asks on the console;');
            L.push('  #   otherwise PLAYBOOK_GATE_MODE=auto (default: approve/acknowledge) | deny | prompt.');
        }
        const st = doc['storage'] ?? [];
        L.push('  # Output storage (Output node setting): ' + (!empty(st['enabled'])
            ? 'ON -> ' + ((st['folder'] ?? '') !== '' ? strval(st['folder']) : strval(st['default'] ?? '~/Documents/synergyAI/outputs/workflow/'))
            : 'OFF (the result is printed, not saved)'));
        return L.join('\n');
    }

    /**
     * The uniform comment block that precedes every node definition in the
     * generated code (same fields in every target).
     */
    static nodeCommentBlock(n: any, indent: string = ''): string {
        const head = `# ---- node ${strval(n['id'])}: ${strval(n['name'])} (${strval(n['type'])}) `;
        const L: string[] = [indent + head + str_repeat('-', Math.max(4, 78 - strlen(head)))];
        const row = (k: string, v: string): string => indent + '#   ' + str_pad(k, 15) + ': ' + v;
        if ((n['provider'] ?? '') !== '' || (n['model'] ?? '') !== '') {
            let s = strval(elvis(n['provider'], '?')) + ' / ' + (n['model'] !== '' ? strval(n['model']) : '(platform default)');
            if ((n['temperature'] ?? null) !== null) s += '   temp ' + json_encode(F(n['temperature']));
            if ((n['max_tokens'] ?? null) !== null) s += '   max_tokens ' + intval(n['max_tokens']);
            s += '   thinking ' + (in_array(n['thinking'] ?? null, ['on', 'off'], true) ? n['thinking'] : 'default');
            L.push(row('provider/model', s));
        }
        if ((n['playbook'] ?? null) !== null) {
            const pb = n['playbook'];
            let s = json_encode(strval(pb['title'] ?? ''), JSON_UNESCAPED_UNICODE);
            if ((pb['bound'] ?? null) !== null) s += ` -- ${strval(pb['bound'])} bound / ` + intval(pb['unbound'] ?? 0) + ' unbound action(s)';
            s += ', writes ' + (!empty(pb['writes']) ? 'ON' : 'OFF');
            L.push(row('playbook', s));
        } else {
            L.push(row('tools', truthy(n['tools']) ? implode(', ', n['tools']) : '(none)'));
            L.push(row('skills', truthy(n['skills']) ? implode(', ', n['skills']) : '(none)'));
        }
        if (truthy(n['dispatch'])) L.push(row('dispatcher', 'routes to one of: ' + implode(' | ', n['dispatch'])));
        L.push(row('parents', truthy(n['parents']) ? implode(' | ', n['parents']) : '(none)'));
        L.push(row('children', truthy(n['children']) ? implode(' | ', n['children']) : '(none)'));
        if (empty(n['supported'])) L.push(row('NOTE', 'not run by this target'));
        return L.join('\n');
    }
}

/** A node descriptor's fields as a plain record (to add one key, as PHP's `$n + [...]`). */
function plainCopy(n: any): Record<string, any> {
    const o: Record<string, any> = {};
    for (const [k, v] of entries(n)) o[k] = v;
    return o;
}
