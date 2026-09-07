"""PHP-vs-Python differential: ToolsController (backend/src/Controllers/ToolsController.php).

GET /tools must be EXACT: built-in tool definitions + MCP tools with schemas
for user 3. A mismatch here is a schema-serialization drift (`properties: {}`
vs `[]`, key order) — investigate and fix the port/serializer, never loosen
the comparison (constraints.md).

POST /tools/execute and POST /tools/classify-intent are exercised with
deterministic validation errors only — no external calls. Note: the task
brief's suggested `serpapi_search` "no key configured" case does NOT apply
in this environment — SERPAPI_KEY is a real, live key in backend/.env (both
backends read it, see app/config.py), so actually executing serpapi_search
would place a real paid network call. Per the task's own "no external calls"
rule, this file instead uses "missing tool name" / "unknown tool" — both
deterministic and network-free — for /tools/execute parity.
"""
import pytest

from tests.differential.conftest import same

pytestmark = pytest.mark.differential


def test_tools_list_exact_parity(both):
    same(*both('GET', '/api/v1/tools'))


def test_tools_list_type_filter_and_search_parity(both):
    same(*both('GET', '/api/v1/tools?type=builtin'))
    same(*both('GET', '/api/v1/tools?type=mcp'))
    same(*both('GET', '/api/v1/tools?type=bogus'))
    same(*both('GET', '/api/v1/tools?search=search'))


def test_tools_execute_missing_tool_name_parity(both):
    same(*both('POST', '/api/v1/tools/execute', json={}))


def test_tools_execute_unknown_tool_parity(both):
    same(*both('POST', '/api/v1/tools/execute', json={'tool_name': 'no_such_tool_xyz_123'}))


def test_tools_classify_intent_validation_parity(both):
    same(*both('POST', '/api/v1/tools/classify-intent', json={}))
    same(*both('POST', '/api/v1/tools/classify-intent', json={'transcript': '   ', 'tools': [{'name': 'done'}]}))
    same(*both('POST', '/api/v1/tools/classify-intent', json={'transcript': 'hello', 'tools': []}))
