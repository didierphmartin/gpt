"""Port of backend/scripts/register_mock_okta.php — registers the mock Okta
MCP server (Task 9, htdocs/mockokta/) in the mcp_servers / mcp_server_tools
tables so the real MCPToolsLoader plumbing (and, via LoaderMcpExecutor, the
playbook interpreter) can call it.

Idempotent: upserts the `mcp_servers` row by (user_id, name) — the schema's
own unique key — then DELETEs and re-INSERTs its `mcp_server_tools` rows
from a live `tools/list` call, so re-running (including with a different
user id) is always safe.

Usage:
  .venv/bin/python -m scripts.register_mock_okta [user_id]

When user_id is omitted, the first row of `users` (ORDER BY id LIMIT 1) in
the CONTEXTS database is used, and the script prints which id it picked.

Uses the same `contexts_database` config block as MCPServerController /
MCPToolsLoader — NOT the primary `database` block (MEMORY: "Backend DB
topology").

Deviations from the PHP source:
  - PHP never wraps `new PDO(...)` in try/catch for this script, so a
    connection failure is an UNCAUGHT PDOException -> PHP CLI's fatal-error
    handler prints a trace and exits **255**. `__main__` calls `run()`
    (not `main()`) to reproduce that exit code for the same un-caught path.
  - The curl call is ported to `httpx` (tests inject a client via
    `_fetch_tools(url, client=...)`, using `httpx.MockTransport` — no real
    network access in tests).
"""
from __future__ import annotations

import sys
import traceback

import httpx

from app.config import ConfigError, load_config
from app.db import Db
from app.support.phpcompat import php_empty, php_intval
from app.support.phpjson import php_json_decode, php_json_encode

MOCK_OKTA_URL = 'http://localhost/mockokta/'
MOCK_OKTA_NAME = 'Okta'


def _fetch_tools(url: str, client: httpx.Client | None = None) -> list:
    """PHP's curl block (register_mock_okta.php ~62-95): POST a JSON-RPC
    `tools/list` request, return the `result.tools` array. Raises
    `RuntimeError` with PHP's own message text on every PHP `exit(1)` path
    here so `main()` can print the identical stderr line and return 1."""
    request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}

    owns_client = client is None
    client = client or httpx.Client(timeout=15.0)
    try:
        try:
            response = client.post(url, json=request, headers=headers)
        except httpx.RequestError as e:
            raise RuntimeError(f"ERROR: could not reach {url}: {e}") from e
    finally:
        if owns_client:
            client.close()

    if response.status_code >= 400:
        raise RuntimeError(f"ERROR: mock Okta server returned HTTP {response.status_code}: {response.text}")

    decoded = php_json_decode(response.text)
    tools = None
    if isinstance(decoded, dict):
        result = decoded.get('result')
        if isinstance(result, dict):
            tools = result.get('tools')
    if not isinstance(tools, list) or tools == []:
        raise RuntimeError(f"ERROR: tools/list returned no tools. Raw response:\n{response.text}")

    return tools


def main(argv: list[str] | None = None, *, http_client: httpx.Client | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]

    try:
        config = load_config()
    except ConfigError as e:
        print(str(e), file=sys.stderr)
        return 1

    # PHP: $dbConfig = $config['contexts_database'] ?? null (NO fallback to
    # $config['database'] — this script only ever talks to the contexts DB).
    db_config = config.get('contexts_database')
    if not db_config or php_empty(db_config.get('database')):
        print("ERROR: no usable 'contexts_database' section in config/ai_config.php", file=sys.stderr)
        return 1

    # PHP has no try/catch around `new PDO(...)` here — an uncaught
    # PDOException is a PHP fatal error (exit 255), reproduced by `run()`.
    db = Db.connect(db_config)
    try:
        return _run(db, argv, http_client)
    finally:
        db.close()


def _run(db, argv: list[str], http_client: httpx.Client | None) -> int:
    user_id = argv[0] if len(argv) > 0 and argv[0] != '' else None
    if user_id is None:
        row = db.fetch_one('SELECT id FROM users ORDER BY id LIMIT 1')
        if not row:
            print("ERROR: no user_id given and no rows in `users` to default to", file=sys.stderr)
            return 1
        user_id = str(row['id'])
        print(f"No user id given — defaulting to first user in `users`: {user_id}")
    else:
        print(f"Using user id: {user_id}")

    try:
        tools = _fetch_tools(MOCK_OKTA_URL, http_client)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1

    print(f"Fetched {len(tools)} tools from mock Okta server")

    db.execute(
        "INSERT INTO mcp_servers (user_id, name, url, description, headers, enabled, is_mock)\n"
        "    VALUES (:user_id, :name, :url, :description, NULL, 1, 1)\n"
        "    ON DUPLICATE KEY UPDATE url = VALUES(url), description = VALUES(description), "
        "enabled = 1, is_mock = 1",
        {
            'user_id': user_id,
            'name': MOCK_OKTA_NAME,
            'url': MOCK_OKTA_URL,
            'description': 'Mock Okta identity/MFA server (Task 9 fixture) for playbook interpreter testing.',
        },
    )

    server_row = db.fetch_one(
        "SELECT id FROM mcp_servers WHERE user_id = :user_id AND name = :name",
        {'user_id': user_id, 'name': MOCK_OKTA_NAME},
    )
    if not server_row:
        print("ERROR: failed to upsert/find mcp_servers row for Okta", file=sys.stderr)
        return 1
    server_id = php_intval(server_row['id'])
    print(f"Upserted mcp_servers row id={server_id} (user_id={user_id}, url={MOCK_OKTA_URL})")

    db.execute("DELETE FROM mcp_server_tools WHERE server_id = :server_id", {'server_id': server_id})

    for tool in tools:
        input_schema = tool.get('inputSchema')
        if input_schema is None:
            input_schema = {'type': 'object', 'properties': {}}
        db.execute(
            "INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, "
            "has_ui, ui_resource_uri)\n"
            "    VALUES (:server_id, :tool_name, :tool_description, :input_schema, 0, NULL)",
            {
                'server_id': server_id,
                'tool_name': tool.get('name'),
                'tool_description': tool.get('description') if tool.get('description') is not None else '',
                'input_schema': php_json_encode(input_schema),
            },
        )

    print(f"Inserted {len(tools)} rows into mcp_server_tools for server id={server_id}")
    print("Done.")

    return 0


def run(argv: list[str] | None = None) -> None:
    """Entry point used by `__main__`: reproduces PHP's uncaught-exception
    exit code (255) for the DB-connect failure this module deliberately
    does not catch (see module docstring)."""
    try:
        sys.exit(main(argv))
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 — mirrors PHP CLI's fatal-error handler
        traceback.print_exc()
        sys.exit(255)


if __name__ == '__main__':
    run()
