"""Port of AgentTeam/Services/SessionSearchService.php.

Session Search Service.

Implements Hermes Layer 3: lexical (FULLTEXT) search over the user's past
chat conversations stored in the `conversation_contexts` table (separate
`contexts_database` connection), followed by LLM summarization of the hits
before returning to the calling agent.

Deliberately not touched by LangGraphGenerator — this is runtime-only.

Ruling (Python port): PHP's registerAsTool opens a dedicated PDO at
registration time and never closes it (request-scoped process). Here the
handler closure opens Db.connect(config['contexts_database']) when the tool
is actually called and closes it in `finally`; if the connect config is
missing/invalid at registration time the function returns False exactly as
PHP does (validated without connecting).
"""
from __future__ import annotations

import json
import re

from app.db import Db
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval


class SessionSearchService:
    DEFAULT_LIMIT = 5
    MAX_LIMIT = 15
    SNIPPET_CHARS = 600
    SUMMARY_MAX_TOKENS = 400

    def __init__(self, contextsDb, config: dict | None = None):
        self.contextsDb = contextsDb
        self.config = config if config is not None else {}

    @staticmethod
    def connectFromConfig(config: dict) -> Db:
        """Build a Db connection to the contexts_database from config."""
        cfg = config.get('contexts_database')
        if not isinstance(cfg, dict) or php_empty(cfg.get('host')) or php_empty(cfg.get('database')):
            raise RuntimeError('contexts_database config missing')
        return Db.connect({
            'host': cfg['host'],
            'database': cfg['database'],
            'username': cfg.get('username') if cfg.get('username') is not None else '',
            'password': cfg.get('password') if cfg.get('password') is not None else '',
            'charset': cfg.get('charset') if cfg.get('charset') is not None else 'utf8mb4',
        })

    @staticmethod
    def registerAsTool(tools, userId: int, config: dict) -> bool:
        """Register `session_search` as a regular tool on the given ToolsManager.

        The handler closure captures userId so the search is always scoped
        to the current request's user (can't be spoofed by the LLM).

        Returns True on success, False if the contexts_database config is
        missing/invalid. Safe to call multiple times — duplicate
        registration just overwrites the closure binding.
        """
        if userId <= 0:
            return False

        cfg = config.get('contexts_database')
        if not isinstance(cfg, dict) or php_empty(cfg.get('host')) or php_empty(cfg.get('database')):
            error_log('[SessionSearchService] registerAsTool: contexts_database unavailable — contexts_database config missing')
            return False

        def handler(params: dict, ctx=None) -> dict:
            query = str(params.get('query') if params.get('query') is not None else '').strip()
            limit = php_intval(params['limit']) if params.get('limit') is not None else 5
            if query == '':
                return {'error': 'query is required'}

            db = None
            try:
                db = SessionSearchService.connectFromConfig(config)
                service = SessionSearchService(db, config)
                hits = service.search(userId, query, limit)
                return {
                    'query': query,
                    'hit_count': len(hits),
                    'hits': hits,
                }
            finally:
                if db is not None:
                    db.close()

        tools.registerFunction(
            'session_search',
            handler,
            {
                'description': (
                    "Search the current user's past chat conversations (lexical / BM25-ranked "
                    "full-text search) and return the most relevant sessions with short snippets. "
                    "Use this when you need to recall what the user said or decided in prior "
                    "discussions. The search is keyword-based, so pick words likely to appear "
                    "literally in a past transcript."
                ),
                'input_schema': {
                    'type': 'object',
                    'properties': {
                        'query': {
                            'type': 'string',
                            'description': 'Keywords to match in past conversations (e.g. "GLP-1 heart failure", "auth microservice Redis").',
                        },
                        'limit': {
                            'type': 'integer',
                            'description': 'Max number of sessions to return (default 5, max 15).',
                            'minimum': 1,
                            'maximum': 15,
                        },
                    },
                    'required': ['query'],
                },
            },
        )
        return True

    def search(self, userId: int, query: str, limit: int = DEFAULT_LIMIT) -> list:
        """Run a FULLTEXT search over the user's conversations.

        Returns rows of shape:
          [{id, title, created_at, updated_at, provider, message_count,
            score, snippet}]
        """
        query = query.strip()
        if query == '':
            return []
        limit = max(1, min(limit, self.MAX_LIMIT))

        sql = f"""
            SELECT id, title, created_at, updated_at, provider, message_count,
                   MATCH(context_data) AGAINST(:q IN NATURAL LANGUAGE MODE) AS score,
                   context_data
            FROM conversation_contexts
            WHERE user_id = :uid
              AND MATCH(context_data) AGAINST(:q IN NATURAL LANGUAGE MODE)
            ORDER BY score DESC
            LIMIT {limit}
        """

        try:
            rows = self.contextsDb.fetch_all(sql, {':uid': userId, ':q': query})
        except Exception as e:
            error_log(f'[SessionSearchService] search failed: {e}')
            return []

        # Build plain-text snippets around the query terms; drop raw
        # context_data from the returned payload to keep it small.
        terms = self._queryTerms(query)
        results = []
        for row in rows:
            plain = self._extractPlainText(str(row['context_data']))
            results.append({
                'id': php_intval(row['id']),
                'title': str(row.get('title') if row.get('title') is not None else ''),
                'created_at': str(row['created_at']),
                'updated_at': str(row['updated_at']),
                'provider': str(row.get('provider') if row.get('provider') is not None else ''),
                'message_count': php_intval(row.get('message_count') if row.get('message_count') is not None else 0),
                'score': float(row['score']),
                'snippet': self._buildSnippet(plain, terms, self.SNIPPET_CHARS),
            })
        return results

    @staticmethod
    def _extractPlainText(json_str: str) -> str:
        """Return the best-effort plain-text version of a context_data JSON blob.

        Concatenates every `content` field it can find, in order.
        """
        try:
            decoded = json.loads(json_str)
        except (ValueError, TypeError):
            decoded = None
        if not isinstance(decoded, (dict, list)):
            return json_str

        # conversation_contexts stores messages either as the root array or
        # under a "messages" key — handle both shapes.
        if isinstance(decoded, dict) and decoded.get('messages') is not None:
            messages = decoded['messages']
        else:
            messages = decoded
        if not isinstance(messages, (dict, list)):
            return json_str

        iterable = messages.values() if isinstance(messages, dict) else messages

        parts = []
        for m in iterable:
            if not isinstance(m, dict):
                continue
            content = m.get('content')
            if isinstance(content, str) and content != '':
                role = (m['role'] + ': ') if m.get('role') is not None else ''
                parts.append(role + content)
            elif isinstance(content, list):
                # Claude-style content blocks: [{type: "text", text: "..."}]
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get('text'), str):
                        role = m.get('role') if m.get('role') is not None else ''
                        parts.append(f"{role}: {block['text']}")
        return "\n".join(parts)

    @staticmethod
    def _queryTerms(q: str) -> list:
        q = q.lower()
        tokens = re.split(r'\W+', q, flags=re.UNICODE) or []
        return [t for t in tokens if len(t) >= 3]

    @staticmethod
    def _buildSnippet(text: str, terms: list, maxChars: int) -> str:
        """Build a window of text around the first matching term, falling back
        to the head of the transcript if no term matches."""
        length = len(text)
        if length <= maxChars:
            return text

        lower = text.lower()
        hitPos = None
        for t in terms:
            pos = lower.find(t)
            if pos != -1:
                hitPos = pos
                break

        if hitPos is None:
            return text[:maxChars] + '…'

        half = maxChars // 2
        start = max(0, hitPos - half)
        snippet = text[start:start + maxChars]
        return ('…' if start > 0 else '') + snippet + ('…' if start + maxChars < length else '')
