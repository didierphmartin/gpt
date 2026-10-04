"""SynergyAI code node harness: the whole contract of a code node, in one file.

Used verbatim by the workflow editor (run in a Pyodide worker) and by compiled
LangGraph scripts (embedded by the generator), so both runtimes behave alike.
Spec: docs/superpowers/specs/2026-10-04-code-node-design.md §3.
"""
import ast
import functools
import io
import json
import sys
import threading
import time

STDOUT_LIMIT = 20000
# Network and process access go through call_tool; these stdlib modules would bypass it.
FORBIDDEN_MODULES = frozenset({"subprocess", "socket", "ctypes", "multiprocessing", "threading", "asyncio",
                               "urllib", "http", "ftplib", "smtplib"})


class ToolError(Exception):
    """A call_tool failure: undeclared tool, transport failure, or a tool result with isError."""


class CodeNodeError(Exception):
    """The code broke the contract: bad import, no run(), bad return value, timeout."""


def check_code(source: str) -> None:
    """Parse the code and refuse imports outside the standard library (or of FORBIDDEN_MODULES)."""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise CodeNodeError(f"syntax error line {e.lineno}: {e.msg}") from None
    stdlib = getattr(sys, "stdlib_module_names", frozenset())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                raise CodeNodeError("relative imports are not allowed")
            names = [node.module or ""]
        else:
            continue
        for name in names:
            top = name.split(".")[0]
            if top in FORBIDDEN_MODULES or top not in stdlib:
                raise CodeNodeError(f"import of '{top}' is not allowed: standard library only, "
                                    f"and network or process access goes through call_tool")
    if not any(isinstance(n, ast.FunctionDef) and n.name == "run" for n in tree.body):
        raise CodeNodeError("code must define run(input, call_tool)")


def _decode(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return text


def decode_input(parents: list, user_prompt: str):
    """input for run(): the prompt (no parent), one parent's output, or {name: output} (spec §3.1)."""
    if not parents:
        return user_prompt
    value = lambda p: p["text"] if p.get("start") else _decode(p["text"])
    if len(parents) == 1:
        return value(parents[0])
    out = {}
    for p in parents:
        name, base, k = p["name"], p["name"], 2
        while name in out:
            name, k = f"{base} ({k})", k + 1
        out[name] = value(p)
    return out


def _text_of(raw: dict) -> str:
    return "\n".join(c.get("text", "") for c in raw.get("content") or []
                     if isinstance(c, dict) and c.get("type") == "text").strip()


def _result_of(raw: dict):
    if raw.get("structuredContent") is not None:
        return raw["structuredContent"]
    return _decode(_text_of(raw))


def _make_call_tool(allowed: set, transport, calls: list, deadline: float, timeout_s: int):
    def call_tool(server: str, tool: str, args: dict = None):
        key = f"{server}.{tool}"
        if key not in allowed:
            raise ToolError(f"tool {key} is not declared on this node")
        if time.monotonic() > deadline:
            raise CodeNodeError(f"timed out after {timeout_s}s")
        args = dict(args or {})
        t0, ok = time.monotonic(), False
        try:
            try:
                raw = transport(server, tool, args)
            except ToolError:
                raise
            except Exception as e:
                raise ToolError(f"{key}: {e}") from None
            if not isinstance(raw, dict):
                raise ToolError(f"{key}: unexpected tool result")
            if raw.get("isError"):
                raise ToolError(f"{key}: {_text_of(raw) or 'tool error'}")
            ok = True
            return _result_of(raw)
        finally:
            calls.append({"server": server, "tool": tool, "args": args, "ok": ok,
                          "ms": int((time.monotonic() - t0) * 1000)})
    return call_tool


def _route_output(value, exits: list):
    shaped = isinstance(value, dict) and "route" in value and set(value) <= {"route", "output"}
    if len(exits) > 1:
        if not shaped or value["route"] not in exits:
            raise CodeNodeError(f"run() must return {{'route': ..., 'output': ...}} with route in {exits}")
        return value["route"], value.get("output")
    if shaped:
        if value["route"] != exits[0]:
            raise CodeNodeError(f"route must be {exits[0]!r}, the node's only exit")
        return exits[0], value.get("output")
    return exits[0], value


def _to_text(output) -> str:
    if isinstance(output, str):
        return output
    try:
        return json.dumps(output, ensure_ascii=False)
    except (TypeError, ValueError) as e:
        raise CodeNodeError(f"output is not JSON-serialisable: {e}") from None


def _with_timeout(fn, timeout_s: int):
    box = {}

    def target():
        try:
            box["value"] = fn()
        except BaseException as e:  # noqa: BLE001 -- re-raised in the caller's thread
            box["error"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        raise CodeNodeError(f"timed out after {timeout_s}s")
    if "error" in box:
        raise box["error"]
    return box["value"]


def execute(source: str, input, exits: list, allowed_tools: list, transport, timeout_s: int,
            threaded: bool = True) -> dict:
    """Run the code's run(input, call_tool) once under the contract (spec §3).

    threaded=True (CPython): run() runs in a daemon thread that is abandoned after timeout_s.
    threaded=False (Pyodide, no threads): the deadline is checked at each call_tool and after run().
    """
    if not exits:
        return {"ok": False, "error": "CodeNodeError: the node has no exits", "stdout": "", "tool_calls": []}
    calls, buf = [], io.StringIO()
    deadline = time.monotonic() + timeout_s
    call_tool = _make_call_tool(set(allowed_tools), transport, calls, deadline, timeout_s)

    def body():
        check_code(source)
        ns = {"__name__": "code_node", "print": functools.partial(print, file=buf)}
        exec(compile(source, "<code node>", "exec"), ns)
        run = ns.get("run")
        if not callable(run):
            raise CodeNodeError("code must define run(input, call_tool)")
        value = run(input, call_tool)
        if time.monotonic() > deadline:
            raise CodeNodeError(f"timed out after {timeout_s}s")
        route, output = _route_output(value, exits)
        return route, _to_text(output)

    try:
        route, text = _with_timeout(body, timeout_s) if threaded else body()
        return {"ok": True, "route": route, "output_text": text,
                "stdout": buf.getvalue()[:STDOUT_LIMIT], "tool_calls": calls}
    except (Exception, SystemExit) as e:
        err = f"{type(e).__name__}: {e}"
        if "error" in exits:
            return {"ok": True, "route": "error", "output_text": json.dumps({"error": err}, ensure_ascii=False),
                    "stdout": buf.getvalue()[:STDOUT_LIMIT], "tool_calls": calls}
        return {"ok": False, "error": err, "stdout": buf.getvalue()[:STDOUT_LIMIT], "tool_calls": calls}
