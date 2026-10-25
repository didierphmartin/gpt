"""Port of backend/src/AgentTeam/Services/WatchCall.php.

The event worker's call to a Start option's waiting tool (spec 2026-10-14 event-worker §3): which server, the
JSON-RPC request (the one MCPToolsLoader::callMCPServer sends), and what the answer means. A waiting tool answers
{"status": "ready"|"timeout", "via"?, "events"?} -- Outlook's wait_for_new, or any later event source.
"""
from __future__ import annotations

import json
import re

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.support.phpcompat import php_strval

_DATA_LINE = re.compile(r'^data:\s?(.*)$', re.M)


def _decode(s):
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return None


class WatchCall:
    @staticmethod
    def server(db, userId: int, name: str) -> dict | None:
        """The user's enabled server named `name` (by slug, as code nodes match it); the user's own row wins over a global one."""
        rows = db.fetch_all('SELECT name, url, headers, user_id FROM mcp_servers WHERE enabled = 1 AND (user_id IS NULL OR user_id = ?)',
                            [userId])
        found = None
        for r in rows:
            if (CodeNodeEmit.slug(php_strval(r['name'])) == CodeNodeEmit.slug(name)
                    and (found is None or r['user_id'] is not None)):
                found = r
        if found is None:
            return None
        headers = _decode(found['headers']) if isinstance(found.get('headers'), str) else None
        if isinstance(headers, list):
            headers = dict(enumerate(headers))
        return {'url': php_strval(found['url']),
                'headers': {k: php_strval(v) for k, v in headers.items()} if isinstance(headers, dict) else {}}

    @staticmethod
    def request(server: dict, watch: dict, id: int) -> tuple[str, list[str], str]:
        """[url, header lines, body]: the stored URL byte-for-byte, the stored headers, watch.tool with watch.args as stored."""
        args = watch.get('args') if watch.get('args') is not None else []
        body = json.dumps({'jsonrpc': '2.0', 'id': id, 'method': 'tools/call',
                           'params': {'name': php_strval(watch.get('tool') if watch.get('tool') is not None else ''),
                                      'arguments': {} if args in ([], {}) else args}},
                          separators=(',', ':'))
        lines = ['Content-Type: application/json', 'Accept: application/json, text/event-stream']
        for k, v in server['headers'].items():
            lines.append(f'{k}: {v}')
        return server['url'], lines, body

    @staticmethod
    def answer(body, http: int, curlError: str) -> dict:
        def error(m: str) -> dict:
            return {'status': 'error', 'message': m}
        if body is False or body is None or curlError != '':
            return error('unreachable')
        if http >= 400:
            return error('http_' + str(http))
        rpc = _decode(WatchCall._lastData(body))
        if not isinstance(rpc, (dict, list)):
            return error('bad_answer')
        if isinstance(rpc, list):
            rpc = dict(enumerate(rpc))
        if rpc.get('error') is not None:
            return error('rpc_error')
        result = rpc.get('result') if rpc.get('result') is not None else {}
        result = result if isinstance(result, dict) else {}
        structured = result.get('structuredContent')
        if isinstance(structured, (dict, list)):
            payload = structured
        else:
            content = result.get('content')
            first = content[0] if isinstance(content, list) and content else None
            text = first.get('text') if isinstance(first, dict) else None
            payload = _decode(php_strval(text if text is not None else ''))
        if not isinstance(payload, (dict, list)):
            return error('bad_answer')
        if isinstance(payload, list):
            payload = dict(enumerate(payload))
        if payload.get('error') is not None:
            e = payload['error']   # a string, or {code, message} (the ServiceNow connector)
            if isinstance(e, (dict, list)):
                e = dict(enumerate(e)) if isinstance(e, list) else e
                return error(php_strval(e.get('code') if e.get('code') is not None else 'tool_error'))
            return error(php_strval(e))
        status = payload.get('status')
        if status != 'ready' and status != 'timeout':
            return error('bad_answer')
        return {'status': status, 'via': payload.get('via'), 'events': payload.get('events')}

    @staticmethod
    def _lastData(body: str) -> str:
        """A plain JSON body as is; an SSE body's last "data:" line."""
        m = _DATA_LINE.findall(body)
        if not m:
            return body
        return php_strval(m[-1])
