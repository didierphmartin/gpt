"""Port of Controllers/McpTestController.php.

MCP Test tab: relays one JSON-RPC message to a server and returns the raw
outcome. Access rules live here (the relay does none): stored headers are
only ever sent to the stored server's URL (or its /mcp sibling) and are
never returned.

Python's json.loads keeps {} as {}, so the parsed body already carries the
message verbatim (PHP has to re-decode it from the raw body).
"""
from __future__ import annotations

import re

from app.controllers.requires_admin import require_admin
from app.services.mcp_endpoint import McpEndpoint
from app.services.mcp_test_relay import McpTestRelay
from app.support.phpcompat import php_empty


class McpTestController:
    def __init__(self, db, config: dict, relay: McpTestRelay | None = None):
        self.db = db
        self.config = config
        self.relay = relay or McpTestRelay()

    def test(self, request) -> dict:
        userId = str(request.get('user_id') or '')
        if userId == '':
            return self._fail('Authentication required', 401)
        return self._run(request, userId, False)

    def adminTest(self, request) -> dict:
        err = require_admin(self.db, request)
        if err is not None:
            return err
        return self._run(request, '', True)

    @staticmethod
    def endpointFor(url: str, transport: str, sibling: bool) -> str | None:
        if transport == 'sse':
            found = (McpEndpoint.candidates(url, 'sse') or [None])[0]
        elif sibling:
            c = McpEndpoint.candidates(url, 'http')
            found = c[1] if len(c) > 1 else None
        else:
            found = url
        return None if found is None else McpEndpoint.internal(found)

    def _run(self, request, userId: str, admin: bool) -> dict:
        body = request.get('body')
        in_ = body if isinstance(body, dict) else {}
        message = in_.get('message')
        if not isinstance(message, (dict, list)) or len(message) == 0:
            return self._fail('message is required', 400)
        # Optional: initialize is sent before any version is negotiated.
        version = in_['protocol_version'] if isinstance(in_.get('protocol_version'), str) else ''
        sessionId = in_['session_id'] if isinstance(in_.get('session_id'), str) else None
        sibling = not php_empty(in_.get('sibling'))
        transport = 'sse' if in_.get('transport', 'http') == 'sse' else 'http'

        serverId = in_.get('server_id')
        if serverId is not None and serverId != '':
            try:
                sid = int(serverId)
            except (TypeError, ValueError):
                sid = 0
            if admin:
                row = self.db.fetch_one('SELECT url, headers, transport FROM mcp_servers WHERE id = :id', {':id': sid})
            else:
                row = self.db.fetch_one(
                    'SELECT url, headers, transport FROM mcp_servers WHERE id = :id AND (user_id IS NULL OR user_id = :uid)',
                    {':id': sid, ':uid': userId},
                )
            if not row:
                return self._fail('Unknown MCP server', 404)
            url = str(row['url'])
            headers = McpEndpoint.decodeStoredHeaders(row.get('headers'))
            transport = 'sse' if (row.get('transport') or 'http') == 'sse' else 'http'
            if 'transport' in in_:
                transport = 'sse' if in_['transport'] == 'sse' else 'http'
        elif admin:
            return self._fail('server_id is required', 400)
        else:
            url = in_.get('server_url')
            if not isinstance(url, str) or url == '':
                return self._fail('server_id or server_url is required', 400)
            headers = {}
            given = in_.get('headers')
            if isinstance(given, dict):
                for n, v in given.items():
                    if isinstance(n, str) and n != '' and isinstance(v, (str, int, float, bool)):
                        sv = ('1' if v else '') if isinstance(v, bool) else str(v)
                        headers[re.sub(r'[\r\n:]', '', n)] = re.sub(r'[\r\n]', '', sv)

        endpoint = self.endpointFor(url, transport, sibling)
        if endpoint is None:
            return self._fail('No sibling /mcp endpoint for this URL', 400)
        return {'success': True, 'relay': self.relay.relay(endpoint, headers, message, sessionId, version)}

    @staticmethod
    def _fail(error: str, status: int) -> dict:
        return {'success': False, 'error': error, 'status_code': status}
