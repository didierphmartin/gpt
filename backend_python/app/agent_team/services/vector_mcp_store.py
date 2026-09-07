"""Read/write chunks to a registered vector-store MCP server (the LangChain
`mcp_qrant` server) through its provider-agnostic `store` / `find` tools. The
actual MCP call is injected (a callable) so this is unit-testable and so the
dispatch mechanism stays the single source of truth for how tools are invoked.

The injected dispatch returns the MCP `result` object -- the mcp_qrant
envelope `{content:[{type:text,text:"<json>"}]}`. Tool-level errors ride
INSIDE that payload as `{error:true,code?,message}` (not as JSON-RPC
isError), so we decode content[0].text and check `error` ourselves.

Ported from backend/src/AgentTeam/Services/VectorMcpStore.php. The dispatch
callable is injected by the caller (IngestionController, Task 6) -- this
class does no HTTP of its own.
"""
from __future__ import annotations

import json
from collections.abc import Callable

from app.support.phpcompat import (
    is_numeric,
    php_array_cast as _phpArrayCast,
    php_floatval,
    php_strval,
    php_trim,
    php_values,
)


def _isArrayLike(v) -> bool:
    """PHP is_array(): true for either JSON shape (list or dict)."""
    return isinstance(v, (dict, list))


class VectorMcpStore:
    def __init__(self, dispatch: Callable[[int, str, dict], dict]):
        self._dispatch = dispatch

    def store(self, serverId: int, chunks: list, cfg: dict) -> dict:
        """Store all chunks for one file in a SINGLE `store` call. Blank chunks
        are skipped; every stored chunk carries the same per-file metadata
        (provenance). The server self-embeds for providers with
        embeds_internally (Qdrant); for others the chosen `embedding` id is
        passed through and the MCP embeds.

        serverId: vector-store MCP server id (from store: "mcp:<id>")
        chunks: text chunks
        cfg: {provider, connection, collection, embedding?, metadata?}

        Returns {stored, errors, collection}.
        """
        collection = cfg.get('collection')
        metaRaw = cfg.get('metadata')
        metadata = metaRaw if _isArrayLike(metaRaw) else []

        items = []
        for chunk in chunks:
            text = php_strval(chunk)
            if php_trim(text) == '':
                continue
            items.append({'text': text, 'metadata': metadata})
        if not items:
            return {'stored': 0, 'errors': 0, 'collection': collection}

        provider = cfg.get('provider')
        args = {
            'provider': php_strval(provider if provider is not None else ''),
            'connection': _phpArrayCast(cfg.get('connection')),
            'collection': php_strval(collection if collection is not None else ''),
            'items': items,
        }
        embedding = cfg.get('embedding')
        if embedding is not None and embedding != '':
            args['embedding'] = php_strval(embedding)

        payload = self._decode(self._dispatch(serverId, 'store', args))
        if payload.get('error'):
            message = payload.get('message')
            raise RuntimeError(php_strval(message if message is not None else 'store failed'))
        # A valid store result MUST carry `stored`. Anything else (empty body,
        # a redirect/HTML page, a non-MCP response) is a transport/endpoint
        # failure -- surface it loudly instead of silently reporting 0 stored.
        if 'stored' not in payload:
            raise RuntimeError(
                'store: the vector MCP returned no {stored} field — likely a transport/endpoint problem '
                '(e.g. a redirect from a trailing-slash URL, a wrong endpoint, or a non-MCP response).'
            )
        stored = payload.get('stored')
        errors = payload.get('errors')
        return {
            'stored': int(stored) if stored is not None else 0,
            'errors': int(errors) if errors is not None else 0,
            'collection': collection,
        }

    def find(self, serverId: int, query: str, cfg: dict) -> dict:
        """Semantic search via `find`. Maps the payload's results to a
        normalized shape; tolerates a missing/non-numeric score.

        cfg: {provider, connection, collection, embedding?, limit?}
        Returns {results: [{text, metadata, score}]}.
        """
        provider = cfg.get('provider')
        collection = cfg.get('collection')
        limit = cfg.get('limit')
        args = {
            'provider': php_strval(provider if provider is not None else ''),
            'connection': _phpArrayCast(cfg.get('connection')),
            'collection': php_strval(collection if collection is not None else ''),
            'query': query,
            'limit': int(limit) if limit is not None else 5,
        }
        embedding = cfg.get('embedding')
        if embedding is not None and embedding != '':
            args['embedding'] = php_strval(embedding)

        payload = self._decode(self._dispatch(serverId, 'find', args))
        if payload.get('error'):
            message = payload.get('message')
            raise RuntimeError(php_strval(message if message is not None else 'find failed'))
        # A valid find result MUST carry `results`. Anything else is a
        # transport/endpoint failure -- surface it, don't return "0 matches".
        if 'results' not in payload:
            raise RuntimeError(
                'find: the vector MCP returned no {results} field — likely a transport/endpoint problem '
                '(e.g. a redirect from a trailing-slash URL, a wrong endpoint, or a non-MCP response).'
            )
        results = []
        rawResults = payload.get('results')
        for r in php_values(rawResults if rawResults is not None else []):
            if not isinstance(r, dict):
                continue
            score = r.get('score')
            text = r.get('text')
            metaRaw = r.get('metadata')
            results.append({
                'text': php_strval(text if text is not None else ''),
                'metadata': metaRaw if _isArrayLike(metaRaw) else [],
                'score': php_floatval(score) if (score is not None and is_numeric(score)) else None,
            })
        return {'results': results}

    def _decode(self, res: dict) -> dict:
        """Decode the mcp_qrant envelope: pull content[0].text and json-decode
        it to the payload. A transport/tool error already normalized to
        {error:true,...} passes through unchanged (callers check `error`). If
        there's no envelope, the input is returned as-is.
        """
        if not isinstance(res, dict):
            return {}
        if res.get('error'):
            return res
        content = res.get('content')
        text = None
        if isinstance(content, list) and content and isinstance(content[0], dict):
            text = content[0].get('text')
        if isinstance(text, str):
            try:
                decoded = json.loads(text)
            except ValueError:
                decoded = None
            if isinstance(decoded, dict):
                return decoded
        return res
