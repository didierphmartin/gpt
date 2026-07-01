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
 *   - jsonToPython()   PHP value → Python literal (True/False/None)
 *   - mcpClientBlock() MCP JSON-RPC client Python functions
 *   - skillDepsBlock() SKILLS_DIR globals + _ensure_skill_deps Python function
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
}
