"""PHP `$request` array + index.php response conventions."""
from __future__ import annotations

import json
from urllib.parse import parse_qsl

from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.support.phpjson import dumps

BASE_PATH = '/gpt/backend'   # MiddlewareProcessor::buildRequest strips this prefix


class Ctx(dict):
    """dict subclass so ported code reads request['body'] exactly like PHP."""


class PhpJSONResponse(JSONResponse):
    def render(self, content) -> bytes:
        return dumps(content).encode('utf-8')


def json_response(status: int, body: dict, headers: dict | None = None) -> PhpJSONResponse:
    return PhpJSONResponse(body, status_code=status, headers=headers)


def build_ctx(request: Request, raw_body: bytes) -> Ctx:
    uri = request.url.path
    if uri.startswith(BASE_PATH):
        uri = uri[len(BASE_PATH):]
    if not uri or uri[0] != '/':
        uri = '/' + uri
    raw = raw_body.decode('utf-8', errors='replace')
    try:
        body = json.loads(raw) if raw else {}
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    # PHP $_GET: last value wins for repeated keys (arrays via foo[] are not used by this API)
    query = dict(parse_qsl(request.url.query, keep_blank_values=True))
    return Ctx(
        method=request.method,
        uri=uri,
        headers=request.headers,
        query=query,
        body=body,
        raw_body=raw,
        params={},
        user_id=None,
        authenticated=False,
        remote_addr=(request.client.host if request.client else ''),
    )


def render(result: dict) -> Response | None:
    """The FOUND branch of index.php. Returns None when the controller already streamed."""
    status = int(result.get('status_code', 200))
    if result.get('streaming_handled') is True:
        return None
    ctype = result.get('content_type')
    if isinstance(ctype, str) and 'text/html' in ctype:
        body = result.get('html', result.get('error', ''))
        return _raw(body, status, {'Content-Type': ctype, 'Cache-Control': 'no-cache'})
    if ctype == 'text/plain':
        return _raw(result.get('error', 'Unknown error'), status, {'Content-Type': 'text/plain'})
    if 'raw_body' in result:
        return _raw(result['raw_body'], status, dict(result.get('headers') or {}))
    body = {k: v for k, v in result.items() if k not in ('status_code', 'content_type')}
    return json_response(status, body)


def _raw(content, status: int, headers: dict) -> Response:
    if isinstance(content, str):
        content = content.encode('utf-8')
    return Response(content=content, status_code=status, headers=headers, media_type=None)
