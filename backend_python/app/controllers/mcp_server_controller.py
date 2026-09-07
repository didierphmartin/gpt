"""Port of Controllers/MCPServerController.php (15-721).

MCP Server Controller

Read-only access to global MCP servers for users.
Server management is done via AdminController.
"""
from __future__ import annotations

import pymysql

from app.services.package_resolver import PackageResolver
from app.support.db_presence import DbPresence
from app.support.logger import error_log
from app.support.phpcompat import (
    filter_validate_url as _filter_validate_url,
    is_numeric,
    php_bool,
    php_empty,
    php_intval,
    php_strval,
    php_trim,
)
from app.support.phpjson import php_json_decode, php_json_encode

# `_filter_validate_url` (filter_var($url, FILTER_VALIDATE_URL)) now lives in
# app.support.phpcompat.filter_validate_url (Phase 7 final-review wave, B2 —
# it was previously duplicated verbatim here and in admin_controller.py);
# imported above under its old module-private name so existing call sites and
# tests keep working unchanged.


class MCPServerController:
    #: Allowed MCP transports. Kept here so the proxy and tests share one source.
    TRANSPORTS = ['http', 'sse']

    def __init__(self, db, config: dict):
        self.db = db
        self.config = config
        self._presence = DbPresence(db, 'MCPServerController')
        self.ensureTablesExist()
        self.ensureMcpSettingsTableExists()

    # ─── statics ───────────────────────────────────────────────────────────

    @staticmethod
    def normalizeTransport(value):
        """Normalize a request-supplied transport. null/empty => 'http' (default);
        a known value (case-insensitive) => canonical; anything else => null.
        """
        if value is None:
            return 'http'
        if not isinstance(value, str):
            return None
        v = php_trim(value).lower()
        if v == '':
            return 'http'
        return v if v in MCPServerController.TRANSPORTS else None

    @staticmethod
    def deriveServerType(uiToolCount: int) -> str:
        """'mcp_app' when at least one cached tool exposes a UI resource, else 'mcp'."""
        return 'mcp_app' if php_intval(uiToolCount) > 0 else 'mcp'

    # ─── endpoints ─────────────────────────────────────────────────────────

    def list(self, request) -> dict:
        """List enabled MCP servers visible to the caller: every global server
        (user_id IS NULL) plus the caller's own per-user servers.
        """
        query = request['query'] if request.get('query') is not None else {}
        userId = php_strval(
            query['user_id'] if query.get('user_id') is not None
            else (request['user_id'] if request.get('user_id') is not None else '')
        )
        # The sidebar needs disabled private servers too (to re-enable them);
        # chat-side callers keep the enabled-only default.
        includeDisabled = not php_empty(query.get('include_disabled'))

        enabledClause = '1=1' if includeDisabled else 's.enabled = 1'
        uidClause = ' OR s.user_id = :uid' if userId != '' else ''
        sql = f"""
            SELECT s.*,
                   COUNT(t.id) as tool_count,
                   SUM(CASE WHEN t.has_ui = 1 THEN 1 ELSE 0 END) as ui_tool_count
            FROM mcp_servers s
            LEFT JOIN mcp_server_tools t ON s.id = t.server_id
            WHERE {enabledClause} AND (s.user_id IS NULL{uidClause})
            GROUP BY s.id
            ORDER BY s.name ASC
        """
        servers = self.db.fetch_all(sql, {':uid': userId} if userId != '' else None)

        # Apply the caller's package MCP allowlist: hide servers the role isn't permitted to use.
        servers = self.applyPackageAllowlist(servers, userId)

        for s in servers:
            s['tool_count'] = php_intval(s['tool_count'] if s.get('tool_count') is not None else 0)
            s['ui_tool_count'] = php_intval(s['ui_tool_count'] if s.get('ui_tool_count') is not None else 0)
            s['enabled'] = php_intval(s['enabled'] if s.get('enabled') is not None else 1)
            s['is_mock'] = php_intval(s['is_mock'] if s.get('is_mock') is not None else 0)
            transport = self.normalizeTransport(s['transport'] if s.get('transport') is not None else None)
            s['transport'] = transport if transport is not None else 'http'
            s['server_type'] = self.deriveServerType(s['ui_tool_count'])
            # Never expose a global server's headers to users — they may
            # contain admin-managed credentials (e.g. Authorization). Only
            # the caller's own private servers get their headers decoded.
            isGlobal = (s['user_id'] if s.get('user_id') is not None else None) is None
            if not isGlobal and s.get('headers') is not None and isinstance(s['headers'], str):
                decoded = self._jsonDecode(s['headers'])
                s['headers'] = decoded if not php_empty(decoded) else None
            else:
                s['headers'] = None

        return {
            'success': True,
            'servers': servers,
            'status_code': 200,
        }

    def isServerEffective(self, serverId: int, serverName, isPrivate: bool, userIdInt) -> bool:
        """Resolve whether a single (server_id, server_name, is_private) combo is
        effective for the caller. Used by getTools() and getAllTools() so they
        stay aligned with list() / MCPToolsLoader on the cascade.
        """
        try:
            if userIdInt is not None:
                row = self.db.fetch_one(
                    "SELECT allowed FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?",
                    [userIdInt, serverId])
                if row is not None:
                    return php_bool(row['allowed'])
            if isPrivate:
                return True
            allow = PackageResolver(self.db).allowedMcpServers(userIdInt)
            if allow is None:
                return True
            return serverName is not None and serverName in allow
        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            error_log('[MCPServerController] isServerEffective failed: ' + str(e))
            return True  # fail open

    def applyPackageAllowlist(self, rows: list, userId: str) -> list:
        """Apply the cascade — package allowlist, then per-user overrides — to a
        list of MCP server rows. Rows must contain `name`, `id`, and `user_id`.

        - Per-user override (allowed=true|false) wins when present.
        - Otherwise: caller's own per-user servers always pass; globals are
          gated by the package's mcp_servers allowlist (null = unrestricted).
        """
        try:
            userIdInt = php_intval(userId) if is_numeric(userId) else None

            # Pull per-user overrides keyed by server_id.
            overrides: dict[int, bool] = {}
            if userIdInt is not None:
                for row in self.db.fetch_all(
                        "SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?", [userIdInt]):
                    overrides[php_intval(row['server_id'])] = php_bool(row['allowed'])

            resolver = PackageResolver(self.db)
            allow = resolver.allowedMcpServers(userIdInt)

            def _keep(row: dict) -> bool:
                serverId = php_intval(row['id'] if row.get('id') is not None else 0)
                isPrivate = (row['user_id'] if row.get('user_id') is not None else None) is not None

                if serverId in overrides:
                    return overrides[serverId]
                if isPrivate:
                    return True
                if allow is None:
                    return True
                return (row['name'] if row.get('name') is not None else '') in allow

            return [row for row in rows if _keep(row)]
        except Exception as e:  # noqa: BLE001 — PHP catches \Exception here
            error_log('[MCPServerController] Cascade filter failed: ' + str(e))
            return rows  # fail open

    def getTools(self, request) -> dict:
        """Get tools for a specific global server."""
        query = request['query'] if request.get('query') is not None else {}
        serverId = query['server_id'] if query.get('server_id') is not None else None

        if php_empty(serverId):
            return {
                'success': True,
                'tools': [],
                'status_code': 200,
            }

        # Verify server is an enabled server owned globally or by the caller
        userId = php_strval(
            query['user_id'] if query.get('user_id') is not None
            else (request['user_id'] if request.get('user_id') is not None else '')
        )
        sql = ("SELECT id, name, user_id FROM mcp_servers WHERE id = ? AND enabled = 1 AND (user_id IS NULL"
               + (" OR user_id = ?" if userId != '' else "") + ")")
        params = [serverId]
        if userId != '':
            params.append(userId)
        row = self.db.fetch_one(sql, params)
        if php_empty(row):
            return {
                'success': False,
                'error': 'Server not found',
                'status_code': 404,
            }

        # Enforce the full cascade (package + per-user override) — a server
        # the admin overrode off should look 404 to the chat-side picker.
        isPrivate = (row['user_id'] if row.get('user_id') is not None else None) is not None
        userIdInt = php_intval(userId) if is_numeric(userId) else None
        if not self.isServerEffective(php_intval(row['id']),
                                      row['name'] if row.get('name') is not None else None,
                                      isPrivate, userIdInt):
            return {
                'success': False,
                'error': 'Server not found',
                'status_code': 404,
            }

        tools = self.db.fetch_all("""
            SELECT * FROM mcp_server_tools WHERE server_id = ? ORDER BY tool_name ASC
        """, [serverId])

        # Parse JSON fields
        for tool in tools:
            tool['input_schema'] = self._jsonDecode(tool['input_schema'])

        return {
            'success': True,
            'tools': tools,
            'status_code': 200,
        }

    def getAllTools(self, request) -> dict:
        """Get all tools from all enabled global servers."""
        # Get tools from all enabled servers visible to the caller
        query = request['query'] if request.get('query') is not None else {}
        userId = php_strval(
            query['user_id'] if query.get('user_id') is not None
            else (request['user_id'] if request.get('user_id') is not None else '')
        )
        sql = ("SELECT t.*, s.name as server_name, s.url as server_url, s.user_id as server_user_id\n"
               "                FROM mcp_server_tools t\n"
               "                JOIN mcp_servers s ON t.server_id = s.id\n"
               "                WHERE s.enabled = 1 AND (s.user_id IS NULL"
               + (" OR s.user_id = :uid" if userId != '' else "") + ")\n"
               "                ORDER BY s.name ASC, t.tool_name ASC")
        tools = self.db.fetch_all(sql, {':uid': userId} if userId != '' else None)

        # Parse JSON fields
        for tool in tools:
            tool['input_schema'] = self._jsonDecode(tool['input_schema'])

        # Apply the full cascade (package + per-user override) so chat-side
        # tool listings match what MCPToolsLoader will actually load at chat
        # time. Without this, the picker would show tools the LLM never sees.
        userIdInt = php_intval(userId) if is_numeric(userId) else None

        def _effective(t: dict) -> bool:
            serverId = php_intval(t['server_id'] if t.get('server_id') is not None else 0)
            isPrivate = (t['server_user_id'] if t.get('server_user_id') is not None else None) is not None
            return self.isServerEffective(serverId, t['server_name'] if t.get('server_name') is not None else None,
                                          isPrivate, userIdInt)

        tools = [t for t in tools if _effective(t)]

        return {
            'success': True,
            'tools': tools,
            'status_code': 200,
        }

    def create(self, request) -> dict:
        """Add a new MCP server."""
        input_ = request['body']
        userId = (input_['user_id'] if input_.get('user_id') is not None
                  else (request['user_id'] if request.get('user_id') is not None else 'demo-user'))

        name = php_trim(input_['name'] if input_.get('name') is not None else '')
        url = php_trim(input_['url'] if input_.get('url') is not None else '')
        description = php_trim(input_['description'] if input_.get('description') is not None else '')

        # Optional custom headers (e.g. Authorization) for authenticated servers.
        # Empty/absent => NULL => no headers => existing behavior unchanged.
        headers = input_['headers'] if input_.get('headers') is not None else None
        headersJson = php_json_encode(headers) if (isinstance(headers, (list, dict)) and headers) else None

        transport = self.normalizeTransport(input_['transport'] if input_.get('transport') is not None else None)
        if transport is None:
            return {
                'success': False,
                'error': 'Invalid transport (expected "http" or "sse")',
                'status_code': 400,
            }

        if php_empty(name) or php_empty(url):
            return {
                'success': False,
                'error': 'Name and URL are required',
                'status_code': 400,
            }

        # Validate URL format
        if not _filter_validate_url(url):
            return {
                'success': False,
                'error': 'Invalid URL format',
                'status_code': 400,
            }

        try:
            serverId = self.db.insert("""
                INSERT INTO mcp_servers (user_id, name, url, description, headers, transport)
                VALUES (?, ?, ?, ?, ?, ?)
            """, [userId, name, url, description, headersJson, transport])

            # PDO::lastInsertId() returns a *string*; json_encode therefore quotes it.
            serverId = php_strval(serverId)

            return {
                'success': True,
                'server_id': serverId,
                'message': 'Server added successfully',
                'status_code': 200,
            }
        except pymysql.err.IntegrityError:  # PDOException with SQLSTATE 23000
            return {
                'success': False,
                'error': 'A server with this name already exists',
                'status_code': 409,
            }

    def update(self, request) -> dict:
        """Update an existing MCP server."""
        input_ = request['body']
        userId = (input_['user_id'] if input_.get('user_id') is not None
                  else (request['user_id'] if request.get('user_id') is not None else 'demo-user'))

        serverId = input_['server_id'] if input_.get('server_id') is not None else None
        name = php_trim(input_['name'] if input_.get('name') is not None else '')
        url = php_trim(input_['url'] if input_.get('url') is not None else '')
        description = php_trim(input_['description'] if input_.get('description') is not None else '')

        if php_empty(serverId):
            return {
                'success': False,
                'error': 'Server ID required',
                'status_code': 400,
            }

        if php_empty(name) or php_empty(url):
            return {
                'success': False,
                'error': 'Name and URL are required',
                'status_code': 400,
            }

        sets = ['name = ?', 'url = ?', 'description = ?']
        params = [name, url, description]

        # Transport is only touched when the key is present in the body —
        # omitting it (e.g. the Settings-modal MCP tab, which doesn't send
        # transport) must not silently reset SSE servers to 'http'.
        if 'transport' in input_:
            transport = self.normalizeTransport(input_['transport'])
            if transport is None:
                return {
                    'success': False,
                    'error': 'Invalid transport (expected "http" or "sse")',
                    'status_code': 400,
                }
            sets.append('transport = ?')
            params.append(transport)

        # Headers are only touched when the key is present in the body:
        # {} or null clears them, an object replaces them.
        if 'headers' in input_:
            headers = input_['headers']
            sets.append('headers = ?')
            params.append(php_json_encode(headers) if (isinstance(headers, (list, dict)) and headers) else None)

        params.append(serverId)
        params.append(userId)
        rowCount = self.db.execute(
            "UPDATE mcp_servers SET " + ', '.join(sets) + " WHERE id = ? AND user_id = ?", params)

        if rowCount == 0:
            return {
                'success': False,
                'error': 'Server not found',
                'status_code': 404,
            }

        # Clear cached tools when URL changes
        self.db.execute("DELETE FROM mcp_server_tools WHERE server_id = ?", [serverId])

        return {
            'success': True,
            'message': 'Server updated successfully',
            'status_code': 200,
        }

    def toggle(self, request) -> dict:
        """Toggle server enabled/disabled state."""
        input_ = request['body']
        userId = (input_['user_id'] if input_.get('user_id') is not None
                  else (request['user_id'] if request.get('user_id') is not None else 'demo-user'))

        serverId = input_['server_id'] if input_.get('server_id') is not None else None
        enabled = input_['enabled'] if input_.get('enabled') is not None else True

        if php_empty(serverId):
            return {
                'success': False,
                'error': 'Server ID required',
                'status_code': 400,
            }

        self.db.execute("""
            UPDATE mcp_servers SET enabled = ? WHERE id = ? AND user_id = ?
        """, [1 if php_bool(enabled) else 0, serverId, userId])

        return {
            'success': True,
            'message': 'Server enabled' if php_bool(enabled) else 'Server disabled',
            'status_code': 200,
        }

    def delete(self, request) -> dict:
        """Delete an MCP server."""
        query = request['query'] if request.get('query') is not None else {}
        serverId = query['server_id'] if query.get('server_id') is not None else None
        userId = (query['user_id'] if query.get('user_id') is not None
                  else (request['user_id'] if request.get('user_id') is not None else 'demo-user'))

        if php_empty(serverId):
            return {
                'success': False,
                'error': 'Server ID required',
                'status_code': 400,
            }

        rowCount = self.db.execute("""
            DELETE FROM mcp_servers WHERE id = ? AND user_id = ?
        """, [serverId, userId])

        if rowCount == 0:
            return {
                'success': False,
                'error': 'Server not found',
                'status_code': 404,
            }

        return {
            'success': True,
            'message': 'Server deleted successfully',
            'status_code': 200,
        }

    def isMasterEnabled(self, userId: int) -> bool:
        """True unless the user has an explicit mcp_enabled=0 row. Missing table/row => true."""
        try:
            row = self.db.fetch_one("SELECT mcp_enabled FROM user_mcp_settings WHERE user_id = ?", [userId])
            return True if row is None else php_bool(row['mcp_enabled'])
        except pymysql.err.Error:  # PDOException: table absent / transient error => default enabled
            return True

    def setMasterSetting(self, request) -> dict:
        """PUT /api/v1/me/mcp-settings  body: { "mcp_enabled": bool }"""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        body = request['body'] if request.get('body') is not None else []
        if 'mcp_enabled' not in body:
            return {'success': False, 'error': 'Field "mcp_enabled" is required (boolean).', 'status_code': 400}
        enabled = 1 if php_bool(body['mcp_enabled']) else 0
        self.db.execute("""
            INSERT INTO user_mcp_settings (user_id, mcp_enabled) VALUES (:uid, :en)
            ON DUPLICATE KEY UPDATE mcp_enabled = VALUES(mcp_enabled), updated_at = CURRENT_TIMESTAMP
        """, {':uid': userId, ':en': enabled})
        return {'success': True, 'mcp_enabled': php_bool(enabled), 'status_code': 200}

    def serverAllowedForUser(self, server: dict, allowlist) -> bool:
        """True if the caller may see this server: private-owned always; global gated by allowlist."""
        isGlobal = (server['user_id'] if server.get('user_id') is not None else None) is None
        if not isGlobal:
            return True  # user-private (already scoped to this user by the query)
        if allowlist is None:
            return True  # package unrestricted
        return server['name'] in allowlist

    def listMine(self, request) -> dict:
        """GET /api/v1/me/mcp-servers — the caller's filtered, effective MCP list + master flag."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}

        allowlist = PackageResolver(self.db).allowedMcpServers(userId)  # null = all

        # Globals + this user's private servers, with tool counts.
        sql = ("SELECT s.id, s.name, s.url, s.user_id, s.enabled, s.is_mock, COUNT(t.id) AS tool_count\n"
               "                FROM mcp_servers s\n"
               "                LEFT JOIN mcp_server_tools t ON t.server_id = s.id\n"
               "                WHERE s.user_id IS NULL OR s.user_id = :uid\n"
               "                GROUP BY s.id\n"
               "                ORDER BY (s.user_id IS NULL) DESC, s.name ASC")
        rows = self.db.fetch_all(sql, {':uid': php_strval(userId)})

        # Overrides for this user.
        overrides: dict[int, bool] = {}
        for r in self.db.fetch_all("SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ?", [userId]):
            overrides[php_intval(r['server_id'])] = php_bool(r['allowed'])

        servers = []
        for row in rows:
            if not self.serverAllowedForUser(row, allowlist):
                continue  # package-denied globals never shown
            isGlobal = row['user_id'] is None
            id_ = php_intval(row['id'])
            # Effective on: private => server.enabled; global => override if set, else on (package grants it).
            if isGlobal:
                effective = overrides[id_] if id_ in overrides else True
            else:
                effective = php_bool(row['enabled'])
            servers.append({
                'id': id_,
                'name': row['name'],
                'url': row['url'],
                'is_global': isGlobal,
                'is_mock': php_bool(row['is_mock'] if row.get('is_mock') is not None else False),
                'tool_count': php_intval(row['tool_count']),
                'effective_on': php_bool(effective),
            })

        return {
            'success': True,
            'mcp_enabled': self.isMasterEnabled(userId),
            'servers': servers,
            'status_code': 200,
        }

    def findVisibleServer(self, userId: int, serverId: int):
        """Look up a single visible server for the caller, or null. Enforces the filtered set."""
        row = self.db.fetch_one(
            "SELECT id, name, user_id FROM mcp_servers WHERE id = ? AND (user_id IS NULL OR user_id = ?)",
            [serverId, userId])
        if php_empty(row):
            return None
        allowlist = PackageResolver(self.db).allowedMcpServers(userId)
        return row if self.serverAllowedForUser(row, allowlist) else None

    def setMyOverride(self, request, serverId: int) -> dict:
        """PUT /api/v1/me/mcp-servers/{id}/override  body: { "allowed": false }  (deny-only)."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        body = request['body'] if request.get('body') is not None else []
        if 'allowed' not in body:
            return {'success': False, 'error': 'Field "allowed" is required (boolean).', 'status_code': 400}
        if php_bool(body['allowed']) is not False:
            # Deny-only: re-enabling is done by clearing the override, not force-allow.
            return {'success': False, 'error': 'Only disabling is allowed here; DELETE the override to re-enable.',
                    'status_code': 400}
        if self.findVisibleServer(userId, serverId) is None:
            return {'success': False, 'error': 'MCP server not available to you', 'status_code': 404}
        self.db.execute("""
            INSERT INTO user_mcp_overrides (user_id, server_id, allowed) VALUES (:uid, :sid, 0)
            ON DUPLICATE KEY UPDATE allowed = 0, updated_at = CURRENT_TIMESTAMP
        """, {':uid': userId, ':sid': serverId})
        return {'success': True, 'server_id': serverId, 'allowed': False, 'status_code': 200}

    def clearMyOverride(self, request, serverId: int) -> dict:
        """DELETE /api/v1/me/mcp-servers/{id}/override — revert to package default (re-enable)."""
        userId = php_intval(request['user_id'] if request.get('user_id') is not None else 0)
        if userId <= 0:
            return {'success': False, 'error': 'Authentication required', 'status_code': 401}
        rowCount = self.db.execute("DELETE FROM user_mcp_overrides WHERE user_id = ? AND server_id = ?",
                                   [userId, serverId])
        return {'success': True, 'server_id': serverId, 'cleared': rowCount > 0, 'status_code': 200}

    # ─── table bootstrap (PHP CREATEs on demand; the port never issues DDL) ─

    def ensureTablesExist(self) -> None:
        """PHP `CREATE TABLE IF NOT EXISTS mcp_servers / mcp_server_tools`."""
        self._presence.table('mcp_servers')
        self._presence.table('mcp_server_tools')

    def ensureMcpSettingsTableExists(self) -> None:
        """Idempotently create user_mcp_settings (per-user MCP master switch)."""
        self._presence.table('user_mcp_settings')

    # ─── helpers ───────────────────────────────────────────────────────────

    @staticmethod
    def _jsonDecode(raw):
        """json_decode($s, true) — null on invalid JSON.

        The `true` flag makes PHP build *arrays*, so an empty JSON object comes
        back as `[]` and json_encode() re-emits it as `[]`, not `{}` — hence
        php_array() at every depth (app.support.phpjson.php_json_decode).
        (MCPToolsLoader.php:151 decodes WITHOUT the flag and keeps stdClass
        objects, which is why /tools is unaffected.)
        """
        return php_json_decode(raw)
