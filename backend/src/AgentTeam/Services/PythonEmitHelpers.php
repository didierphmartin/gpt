<?php

declare(strict_types=1);

namespace AgentTeam\Services;

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
class PythonEmitHelpers
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
    public static function jsonToPython($value, bool $forceObject = false): string
    {
        if ($forceObject && is_array($value)) {
            // Cast top-level array to object so empty arrays encode as {}
            // and associative arrays encode as object literals.
            $value = (object) $value;
        }
        $raw = json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $raw = str_replace(': true', ': True', $raw);
        $raw = str_replace(': false', ': False', $raw);
        $raw = str_replace(': null', ': None', $raw);
        return $raw;
    }

    /**
     * Render a PHP string as a Python double-quoted string literal.
     *
     * Escapes backslashes, double-quotes, newlines, carriage returns,
     * and tabs so the result is a valid Python string expression.
     *
     * Example: pyStr("line1\nquote\"x") → '"line1\\nquote\\"x"'
     */
    public static function pyStr(string $s): string
    {
        $s = str_replace('\\', '\\\\', $s);
        $s = str_replace('"', '\\"', $s);
        $s = str_replace("\n", '\\n', $s);
        $s = str_replace("\r", '\\r', $s);
        $s = str_replace("\t", '\\t', $s);
        return '"' . $s . '"';
    }

    /**
     * Emit the MCP JSON-RPC client Python block.
     *
     * Returns the three functions: _normalize_mcp_url, _init_mcp_session,
     * _parse_mcp_response, and _call_mcp_tool.
     *
     * Moved verbatim from LangGraphGenerator::mcpClientBlock().
     */
    public static function mcpClientBlock(): string
    {
        return <<<'PY'
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

PY;
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
    public static function skillDepsBlock(): string
    {
        return <<<'PY'
# ---------------------------------------------------------------------------
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
# (e.g. `dependencies: [beautifulsoup4]`). The browser installs them via
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

PY;
    }

    /**
     * Emit the synchronous skill filesystem Python block.
     *
     * Returns: SKILL_OUTPUTS_ROOT / SKILL_SCRATCH_DIR / _LAST_SKILL_OUTPUTS globals,
     * _skill_output_dir(), _remap_virtual_path(), _run_skill_script() (synchronous
     * subprocess.run with bucketed dirs, argv remap, input_files staging, SYNERGYAI_*
     * env, and read_outputs → _LAST_SKILL_OUTPUTS stash), and _read_skill_md().
     *
     * Framework-agnostic — contains NO LangChain/langchain_core symbols.
     * LangGraphGenerator emits RUN_SKILL_SCRIPT_TOOL (StructuredTool wrapper) in its
     * own LangChain-specific $lgSpecific block, immediately after this shared block.
     *
     * Depends on SKILLS_DIR + _ensure_skill_deps from skillDepsBlock() being emitted
     * first. Shared by LangGraphGenerator and MAFGenerator.
     */
    public static function skillFsSyncBlock(): string
    {
        return <<<'PY'


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
    arguments as an escaped single-line string: literal \\n / \\" sequences
    and ZERO real newlines. Written verbatim, the HTML/CSS is broken and the
    page renders unstyled (a live report shipped with 1131 literal \\n).
    Mirrors the platform chat's _coerceInputFiles over-escape recovery.
    Detection is conservative: many escape sequences AND no real newlines."""
    s = str(text)
    if s.count("\\n") > 5 and s.count("\n") == 0:
        print("  [stage] repairing over-escaped content ("
              + str(s.count("\\n")) + " literal escape sequences)", flush=True)
        s = (s.replace("\\\\", "\x00").replace("\\n", "\n").replace("\\t", "\t")
              .replace("\\r", "").replace('\\"', '"').replace("\\'", "'").replace("\x00", "\\"))
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
        out = (out + f"\n[run_skill_script exit {proc.returncode}]\n"
               + _stderr[-2000:]).strip()
    # Read back requested outputs AND stash them so the skill step can use the produced
    # document as the node output.
    _produced = []
    if isinstance(read_outputs, list):
        for rel in read_outputs:
            try:
                with open(_remap_virtual_path(rel, out_dir), "r", encoding="utf-8") as fh:
                    _content = fh.read()
                out += f"\n\n[output file {rel}]\n" + _content
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
        end = text.find("\n---\n", 3)
        if end != -1:
            nl = text.find("\n", end + 1)
            text = text[nl + 1:] if nl != -1 else ""
    return text.strip()

PY;
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
    public static function documentConverterBlock(): string
    {
        return <<<'PY'
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

PY;
    }

    // ------------------------------------------------------------------
    // Generated-script documentation (shared by every compile target)
    // ------------------------------------------------------------------

    /** Env var that carries the API key of a provider (as the runner's .env names them). */
    public static function providerKeyEnv(string $provider): ?string
    {
        return [
            'claude' => 'ANTHROPIC_API_KEY', 'anthropic' => 'ANTHROPIC_API_KEY',
            'openai' => 'OPENAI_API_KEY', 'gemini' => 'GOOGLE_API_KEY', 'google' => 'GOOGLE_API_KEY',
            'grok' => 'XAI_API_KEY', 'xai' => 'XAI_API_KEY', 'kimi' => 'KIMI_API_KEY', 'moonshot' => 'KIMI_API_KEY',
            'deepseek' => 'DEEPSEEK_API_KEY', 'glm' => 'GLM_API_KEY',
        ][strtolower($provider)] ?? null;
    }

    /** One-line summary of a node descriptor (see WorkflowGraphAnalyzer::docNodes). */
    private static function nodeSummary(array $n): string
    {
        $t = $n['type'];
        if ($t === 'start') {
            $p = trim((string) ($n['prompt'] ?? ''));
            return 'receives the user prompt' . ($p !== '' ? ' -- default: ' . json_encode(mb_strimwidth($p, 0, 70, '…'), JSON_UNESCAPED_UNICODE) : '');
        }
        if ($t === 'output') {
            return 'merges its parents\' outputs verbatim (no LLM) -- the workflow result';
        }
        $bits = [];
        if (($n['provider'] ?? '') !== '' || ($n['model'] ?? '') !== '') {
            $bits[] = ($n['provider'] ?: '?') . '/' . ($n['model'] !== '' ? $n['model'] : '(platform default)');
        }
        if (($n['temperature'] ?? null) !== null) $bits[] = 'temp ' . json_encode((float) $n['temperature']);
        if (($n['max_tokens'] ?? null) !== null) $bits[] = 'max_tokens ' . (int) $n['max_tokens'];
        if (in_array($n['thinking'] ?? null, ['on', 'off'], true)) $bits[] = 'thinking ' . $n['thinking'];
        if ($n['playbook'] !== null) {
            $pb = $n['playbook'];
            $s = 'playbook ' . json_encode((string) ($pb['title'] ?? ''), JSON_UNESCAPED_UNICODE);
            if (($pb['bound'] ?? null) !== null) $s .= ", {$pb['bound']} bound / " . (int) ($pb['unbound'] ?? 0) . ' unbound action(s)';
            $s .= ', writes ' . (!empty($pb['writes']) ? 'ON' : 'OFF');
            $bits[] = $s;
        } else {
            $bits[] = count($n['tools']) . ' tool(s)';
            if ($n['skills']) $bits[] = count($n['skills']) . ' skill(s): ' . implode(', ', $n['skills']);
        }
        if ($n['dispatch']) $bits[] = 'DISPATCHER -> one of: ' . implode(' | ', $n['dispatch']);
        $s = implode(', ', $bits);
        if ($n['dispatch'] && empty($n['dispatch_supported'])) {
            $s .= ' (menu NOT honoured by this target: all children run)';
        }
        if (empty($n['supported'])) {
            $s .= " -- NOT RUN BY THIS TARGET (" . $t . " nodes are not supported here; the node is skipped)";
        }
        return $s;
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
    public static function workflowDocBlock(array $doc): string
    {
        $nodes = $doc['nodes'];
        $byId = [];
        foreach ($nodes as $n) $byId[$n['id']] = $n;
        $lbl = fn(string $id) => (isset($byId[$id]) ? $byId[$id]['name'] : 'node') . " ({$id})";
        $dispatchers = [];
        foreach ($nodes as $n) if ($n['dispatch']) $dispatchers[$n['id']] = true;
        // Only LangGraph turns a dispatcher's fan-out into a choice today; the other
        // targets run the menu children in parallel, and the doc must say so.
        $dispatchOk = !empty($doc['dispatch_supported']);
        $menuNote = $dispatchOk ? '   (dispatcher menu: one of)' : '   (dispatcher menu: NOT honoured by this target -- runs in parallel)';
        $L = [];
        $L[] = 'PROVENANCE';
        $L[] = '==========';
        $L[] = "  Workflow:   {$doc['workflow']['name']} (id {$doc['workflow']['id']})";
        $L[] = "  Target:     {$doc['target']}";
        $L[] = "  Generated:  " . ($doc['generated_at'] ?? date('Y-m-d H:i:s T')) . ' by the SynergyAI workflow editor';
        $L[] = '  This file is a frozen snapshot of the workflow. Edits made here are';
        $L[] = '  overwritten by the next Generate: change the workflow in the editor and';
        $L[] = '  re-generate instead.';
        $L[] = '';
        $L[] = 'GRAPH NODES  (id (type): name -- settings; topological order)';
        $L[] = '===========';
        $w = 0;
        foreach ($nodes as $n) $w = max($w, strlen("{$n['id']} ({$n['type']}):"));
        foreach ($nodes as $n) {
            $L[] = '  ' . str_pad("{$n['id']} ({$n['type']}):", $w) . ' ' . $n['name'] . ' -- ' . self::nodeSummary($n + ['dispatch_supported' => $dispatchOk])
                . (($n['marker'] ?? '') !== '' ? '   ' . $n['marker'] : '');
        }
        $L[] = '';
        $L[] = 'GRAPH EDGES  (from -> to)';
        $L[] = '===========';
        if (empty($doc['edges'])) $L[] = '  (none)';
        foreach ($doc['edges'] as $e) {
            [$f, $t] = [(string) $e[0], (string) $e[1]];
            $L[] = '  ' . $lbl($f) . ' -> ' . $lbl($t) . (isset($dispatchers[$f]) && isset($byId[$t]) && $byId[$t]['type'] !== 'output' ? $menuNote : '');
        }
        $L[] = '';
        $L[] = 'EXECUTION ORDER  (topological layers; nodes on one line run in PARALLEL)';
        $L[] = '===============';
        foreach (array_values($doc['layers'] ?? []) as $i => $layer) {
            $ids = array_map('strval', (array) $layer);
            $names = array_map(fn($id) => isset($byId[$id]) ? $byId[$id]['name'] : "node_{$id}", $ids);
            $line = "  layer {$i}:  " . implode('  ||  ', $names);
            $viaDispatcher = false;
            foreach ($ids as $id) foreach ($nodes as $n) if ($n['id'] === $id) foreach ($n['parents'] as $p) {
                if (preg_match('/\((\S+)\)$/', $p, $m) && isset($dispatchers[$m[1]])) $viaDispatcher = true;
            }
            if (count($ids) > 1) {
                $line .= ($viaDispatcher && $dispatchOk) ? '   (dispatcher: only the chosen one runs)'
                    : ($viaDispatcher ? '   (run in PARALLEL -- dispatcher menu not honoured by this target)' : '   (run in PARALLEL)');
            }
            $L[] = $line;
        }
        $L[] = '';
        $L[] = 'DATA FLOW';
        $L[] = '=========';
        foreach (explode("\n", rtrim((string) ($doc['data_flow'] ?? ''))) as $dl) $L[] = $dl;
        $L[] = '';
        $L[] = 'TO RUN';
        $L[] = '======';
        foreach ((array) ($doc['run']['deps'] ?? []) as $dep) $L[] = '  ' . $dep;
        $keys = [];
        foreach ($nodes as $n) {
            if (($n['provider'] ?? '') === '' || empty($n['supported'])) continue;
            $k = self::providerKeyEnv($n['provider']);
            if ($k !== null) $keys[$k][] = strtolower($n['provider']);
        }
        $envPath = ($doc['run']['env_path'] ?? '') !== '' ? $doc['run']['env_path'] : '../.env';
        if ($keys) {
            $L[] = "  # API keys read from {$envPath} for the providers this workflow uses:";
            foreach ($keys as $k => $provs) $L[] = "  #   {$k} (" . implode(', ', array_unique($provs)) . ')';
        } else {
            $L[] = '  # No LLM provider is used by a runnable node of this workflow.';
        }
        $L[] = '  ' . ($doc['run']['usage'] ?? 'python this_file.py "your prompt here"');
        foreach ((array) ($doc['run']['extra'] ?? []) as $x) $L[] = '  ' . $x;
        $hasPlaybook = false;
        foreach ($nodes as $n) if ($n['playbook'] !== null && !empty($n['supported'])) $hasPlaybook = true;
        if ($hasPlaybook) {
            $L[] = '  # Human gates (playbook nodes): on a terminal the script asks on the console;';
            $L[] = '  #   otherwise PLAYBOOK_GATE_MODE=auto (default: approve/acknowledge) | deny | prompt.';
        }
        $st = $doc['storage'] ?? [];
        $L[] = '  # Output storage (Output node setting): ' . (!empty($st['enabled'])
            ? 'ON -> ' . (($st['folder'] ?? '') !== '' ? $st['folder'] : '~/Documents/synergyAI/outputs/workflow/')
            : 'OFF (the result is printed, not saved)');
        return implode("\n", $L);
    }

    /**
     * The uniform comment block that precedes every node definition in the
     * generated code (same fields in every target).
     */
    public static function nodeCommentBlock(array $n, string $indent = ''): string
    {
        $head = "# ---- node {$n['id']}: {$n['name']} ({$n['type']}) ";
        $L = [$indent . $head . str_repeat('-', max(4, 78 - strlen($head)))];
        $row = fn(string $k, string $v) => $indent . '#   ' . str_pad($k, 15) . ': ' . $v;
        if (($n['provider'] ?? '') !== '' || ($n['model'] ?? '') !== '') {
            $s = ($n['provider'] ?: '?') . ' / ' . ($n['model'] !== '' ? $n['model'] : '(platform default)');
            if (($n['temperature'] ?? null) !== null) $s .= '   temp ' . json_encode((float) $n['temperature']);
            if (($n['max_tokens'] ?? null) !== null) $s .= '   max_tokens ' . (int) $n['max_tokens'];
            $s .= '   thinking ' . (in_array($n['thinking'] ?? null, ['on', 'off'], true) ? $n['thinking'] : 'default');
            $L[] = $row('provider/model', $s);
        }
        if ($n['playbook'] !== null) {
            $pb = $n['playbook'];
            $s = json_encode((string) ($pb['title'] ?? ''), JSON_UNESCAPED_UNICODE);
            if (($pb['bound'] ?? null) !== null) $s .= " -- {$pb['bound']} bound / " . (int) ($pb['unbound'] ?? 0) . ' unbound action(s)';
            $s .= ', writes ' . (!empty($pb['writes']) ? 'ON' : 'OFF');
            $L[] = $row('playbook', $s);
        } else {
            $L[] = $row('tools', $n['tools'] ? implode(', ', $n['tools']) : '(none)');
            $L[] = $row('skills', $n['skills'] ? implode(', ', $n['skills']) : '(none)');
        }
        if ($n['dispatch']) $L[] = $row('dispatcher', 'routes to one of: ' . implode(' | ', $n['dispatch']));
        $L[] = $row('parents', $n['parents'] ? implode(' | ', $n['parents']) : '(none)');
        $L[] = $row('children', $n['children'] ? implode(' | ', $n['children']) : '(none)');
        if (empty($n['supported'])) $L[] = $row('NOTE', 'not run by this target');
        return implode("\n", $L);
    }
}
