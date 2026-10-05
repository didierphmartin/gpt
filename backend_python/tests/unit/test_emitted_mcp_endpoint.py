"""The emitted MCP client (LangGraph, ADK, MAF, playbook) follows the backend's
endpoint rule (McpEndpoint): the registered URL as given first, then with
"/mcp" inserted into its path before any query string.

Port of backend/tests/Unit/EmittedMcpEndpointTest.php (the offline case)."""
from __future__ import annotations

import json
import subprocess
import sys

from app.agent_team.services.python_emit_helpers import PythonEmitHelpers


def _run(body: str) -> str:
    src = ("import json, sys, time, types\n"
           "try:\n    import httpx\nexcept ImportError:\n    httpx = types.ModuleType('httpx')\n"
           + PythonEmitHelpers.mcpClientBlock() + "\n" + body)
    r = subprocess.run([sys.executable, '-c', src], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout


def test_candidates_as_given_first_then_mcp_before_the_query():
    out = _run('''print(json.dumps([
    _mcp_candidates("https://x.test"),
    _mcp_candidates("http://h/srv/"),
    _mcp_candidates("http://localhost/servicenow/?profile=mock&toolset=jobs"),
    _mcp_candidates("http://h/x?a=1#f"),
    _mcp_candidates("https://x.test/mcp/"),
    _mcp_candidates("http://h/s.php?k=1"),
]))''')
    assert json.loads(out) == [
        ['https://x.test', 'https://x.test/mcp'],
        ['http://h/srv/', 'http://h/srv/mcp'],
        ['http://localhost/servicenow/?profile=mock&toolset=jobs', 'http://localhost/servicenow/mcp?profile=mock&toolset=jobs'],
        ['http://h/x?a=1#f', 'http://h/x/mcp?a=1#f'],
        ['https://x.test/mcp/'],
        ['http://h/s.php?k=1'],
    ]
