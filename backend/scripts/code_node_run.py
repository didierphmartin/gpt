#!/usr/bin/env python3
"""Run one code node for the server-side workflow runner (GraphWorkflowRunner via CodeNodeExecutor).

The contract is code_node_harness.py's -- the file the editor and compiled LangGraph run -- so a code
node behaves the same everywhere. argv[1] is the directory holding code_node_harness.py.

stdin:  {"source", "exits", "timeout_s", "parents", "user_prompt", "name", "servers": {slug: {"url", "headers"}}}
stdout: the harness result {"ok", "route"?, "output_text"?, "error"?, "stdout", "tool_calls"}

Needs Python 3.10+. This entry file stays free of 3.10-only syntax (the `match` code lives in
code_node_mcp.py, imported after the version check) so an old interpreter gets a clear JSON error.
"""
import json
import sys


def old_python_result(version, executable: str) -> str:
    """The error result printed when the interpreter is older than 3.10."""
    return json.dumps({
        "ok": False,
        "error": "code node runner needs Python 3.10+, but %s is %d.%d: "
                 "set CODE_NODE_PYTHON to a Python 3.10+ interpreter" % (executable, version[0], version[1]),
        "stdout": "", "tool_calls": [],
    })


def main() -> None:
    if sys.version_info < (3, 10):
        print(old_python_result(sys.version_info, sys.executable))
        sys.exit(1)
    sys.path.insert(0, sys.argv[1])
    sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")
    import code_node_harness as harness
    from code_node_mcp import McpTransport

    req = json.load(sys.stdin)
    servers = req.get("servers") or {}
    timeout_s = int(req["timeout_s"])
    value = harness.decode_input(req.get("parents") or [], req.get("user_prompt") or "")
    result = harness.execute(req["source"], value, req["exits"], list(servers),
                             McpTransport(servers, timeout_s), timeout_s, node_name=req.get("name") or "")
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
