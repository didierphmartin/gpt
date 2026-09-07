"""Port of backend/scripts/register_mock_stack.php — registers the full mock
MCP stack for the New Hire Provisioning playbook: the (extended) mock Okta
plus the mockstack services — each as its own mcp_servers row so playbook
auto-binding sees distinct server slugs (okta.create_user,
github.invite_user_to_org, aws.iam_..., etc.).

Idempotent, same mechanics as register_mock_okta.py: upsert by
(user_id, name), then DELETE + re-INSERT the tool cache from a live
tools/list. Uses the CONTEXTS database config (never the primary `database`
block).

Usage: .venv/bin/python -m scripts.register_mock_stack [user_id]

Deviations from the PHP source:
  - PHP never wraps `new PDO(...)` in try/catch for this script, so a
    connection failure is an UNCAUGHT PDOException -> PHP CLI's fatal-error
    handler prints a trace and exits **255**. `__main__` calls `run()`
    (not `main()`) to reproduce that exit code for the same un-caught path.
  - The curl call is ported to `httpx` (tests inject a client via
    `main(..., http_client=...)`, using `httpx.MockTransport` — no real
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

# PHP `$servers` array (register_mock_stack.php ~19-29) — order and content
# ported verbatim, including the header comment's stale "seven mockstack
# services" count (the literal array below has 9 entries: Okta + 8).
SERVERS = [
    {'name': 'Okta', 'url': 'http://localhost/mockokta/',
     'desc': 'Mock Okta identity server (extended: lookup/create/activate/groups).'},
    {'name': 'Google Workspace', 'url': 'http://localhost/mockstack/index.php/google_workspace',
     'desc': 'Mock Google Workspace groups.'},
    {'name': 'Google Calendar', 'url': 'http://localhost/mockstack/index.php/google_calendar',
     'desc': 'Mock Google Calendar (list/create events).'},
    {'name': 'Slack', 'url': 'http://localhost/mockstack/index.php/slack',
     'desc': 'Mock Slack channel invites.'},
    {'name': 'Kandji', 'url': 'http://localhost/mockstack/index.php/kandji',
     'desc': 'Mock Kandji ADE device assignment.'},
    {'name': 'GitHub', 'url': 'http://localhost/mockstack/index.php/github',
     'desc': 'Mock GitHub org/team management.'},
    {'name': 'Datadog', 'url': 'http://localhost/mockstack/index.php/datadog',
     'desc': 'Mock Datadog user invites.'},
    {'name': 'AWS', 'url': 'http://localhost/mockstack/index.php/aws',
     'desc': 'Mock AWS IAM (sandbox).'},
    {'name': 'Workday', 'url': 'http://localhost/mockstack/index.php/workday',
     'desc': 'Mock Workday time-off (balances, blackout, team calendar, submit).'},
]


def stack_fetch_tools(url: str, client: httpx.Client | None = None) -> list:
    """PHP `stack_fetch_tools()` (~50-64). Note: Content-Type header only —
    unlike register_mock_okta.php's `_fetch_tools`, no Accept header."""
    request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}
    headers = {'Content-Type': 'application/json'}

    owns_client = client is None
    client = client or httpx.Client(timeout=15.0)
    try:
        try:
            response = client.post(url, json=request, headers=headers)
        except httpx.RequestError as e:
            raise RuntimeError(f"unreachable ({e})") from e
    finally:
        if owns_client:
            client.close()

    decoded = php_json_decode(response.text)
    tools = None
    if isinstance(decoded, dict):
        result = decoded.get('result')
        if isinstance(result, dict):
            tools = result.get('tools')
    if not isinstance(tools, list) or tools == []:
        raise RuntimeError(f"no tools in response: {response.text}")

    return tools


def main(argv: list[str] | None = None, *, http_client: httpx.Client | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]

    try:
        config = load_config()
    except ConfigError as e:
        print(str(e), file=sys.stderr)
        return 1

    db_config = config.get('contexts_database')
    if not db_config or php_empty(db_config.get('database')):
        print("ERROR: no usable 'contexts_database' config", file=sys.stderr)
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
            print("ERROR: no user_id and no users", file=sys.stderr)
            return 1
        user_id = str(row['id'])
        print(f"No user id given — defaulting to first user: {user_id}")
    # PHP has no `else` branch here — no announce line when user_id is given.

    for srv in SERVERS:
        try:
            tools = stack_fetch_tools(srv['url'], http_client)
        except RuntimeError as e:
            print(f"SKIP {srv['name']}: {e}", file=sys.stderr)
            continue

        db.execute(
            "INSERT INTO mcp_servers (user_id, name, url, description, headers, enabled, is_mock)\n"
            "    VALUES (:u, :n, :url, :d, NULL, 1, 1)\n"
            "    ON DUPLICATE KEY UPDATE url = VALUES(url), description = VALUES(description), "
            "enabled = 1, is_mock = 1",
            {'u': user_id, 'n': srv['name'], 'url': srv['url'], 'd': srv['desc']},
        )
        server_row = db.fetch_one(
            "SELECT id FROM mcp_servers WHERE user_id = :u AND name = :n",
            {'u': user_id, 'n': srv['name']},
        )
        # PHP: `(int)$findId->fetch()['id']` — a missing row makes `fetch()`
        # return `false`, and `false['id']` is a PHP warning (not a fatal),
        # evaluating to null, so `(int)` of that is 0 and execution
        # continues with serverId=0. Mirrored here rather than raising on
        # `server_row['id']` for a `None` row.
        server_id = php_intval(server_row['id']) if server_row else 0
        db.execute("DELETE FROM mcp_server_tools WHERE server_id = :s", {'s': server_id})

        for t in tools:
            input_schema = t.get('inputSchema')
            if input_schema is None:
                input_schema = {'type': 'object', 'properties': {}}
            db.execute(
                "INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, "
                "has_ui, ui_resource_uri)\n"
                "    VALUES (:s, :tn, :td, :sc, 0, NULL)",
                {
                    's': server_id,
                    'tn': t.get('name'),
                    'td': t.get('description') if t.get('description') is not None else '',
                    'sc': php_json_encode(input_schema),
                },
            )

        print(f"{srv['name']:<17} server id={server_id} — {len(tools)} tools")

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
