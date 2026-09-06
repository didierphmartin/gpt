"""Port of backend/src/AgentTeam/Services/UserMemoryRepository.php.

Backs Hermes-style "frozen" memory: two per-user markdown blocks (MEMORY:
project/environment facts, USER: user preferences) that are injected into
the system prompt on every workflow agent run.

No vector index. No semantic retrieval. Just always-on small blocks.
"""
from __future__ import annotations

import re

from app.support.logger import error_log
from app.support.phpcompat import mb_substr


class UserMemoryRepository:
    SCOPE_MEMORY = 'memory'
    SCOPE_USER = 'user'

    BUDGET_MEMORY = 2200
    BUDGET_USER = 1375

    def __init__(self, db):
        self.db = db
        self.tablesChecked = False

    def ensureTablesExist(self) -> None:
        # Tables exist in the schema (backend/schema/chatbot.sql); no runtime
        # DDL is ported (parity tracker: PHP's CREATE TABLE IF NOT EXISTS is
        # not mirrored here).
        self.tablesChecked = True

    def get(self, userId: int, scope: str) -> str:
        self.ensureTablesExist()
        row = self.db.fetch_one(
            "SELECT content FROM user_memories WHERE user_id = ? AND scope = ?",
            [userId, scope],
        )
        return str(row['content']) if row else ''

    def getBoth(self, userId: int) -> dict:
        """Return both scopes in a single call — used by the agent runner so we
        don't do two round-trips per node execution."""
        self.ensureTablesExist()
        rows = self.db.fetch_all(
            "SELECT scope, content FROM user_memories WHERE user_id = ?",
            [userId],
        )
        out = {self.SCOPE_MEMORY: '', self.SCOPE_USER: ''}
        for row in rows:
            out[row['scope']] = str(row['content'])
        return out

    def set(self, userId: int, scope: str, content: str) -> None:
        if scope != self.SCOPE_MEMORY and scope != self.SCOPE_USER:
            raise ValueError(f'Invalid scope: {scope}')
        self.ensureTablesExist()

        limit = self.BUDGET_MEMORY if scope == self.SCOPE_MEMORY else self.BUDGET_USER
        if len(content) > limit:
            content = mb_substr(content, 0, limit)

        self.db.execute(
            "INSERT INTO user_memories (user_id, scope, content) "
            "VALUES (:user_id, :scope, :content) "
            "ON DUPLICATE KEY UPDATE content = VALUES(content)",
            {'user_id': userId, 'scope': scope, 'content': content},
        )

    def budgetFor(self, scope: str) -> int:
        return self.BUDGET_MEMORY if scope == self.SCOPE_MEMORY else self.BUDGET_USER

    def buildMerged(self, current: str, additions: list) -> str:
        """Non-destructive append. Existing lines are preserved; new lines
        (one per addition) are appended. Returns the candidate string
        without writing — callers are responsible for compaction when
        the result exceeds budget.

        Deduplicates case-insensitive exact-line matches against current
        content so the extractor can safely propose the same fact twice.
        """
        current = current.rstrip()
        existingLines: dict = {}
        for line in re.split(r'\r?\n', current):
            key = line.strip().lower()
            if key != '':
                existingLines[key] = True

        newLines = []
        for addition in additions:
            addition = str(addition).strip()
            if addition == '':
                continue
            key = addition.lower()
            if key in existingLines:
                continue
            existingLines[key] = True
            newLines.append(addition)

        if not newLines:
            return current

        if current == '':
            return "\n".join(newLines)
        return current + "\n" + "\n".join(newLines)

    @staticmethod
    def buildMemoryBlock(db, userId: int) -> str:
        """Build a system-prompt-ready string containing both memory scopes,
        formatted with "## Memory" / "## User" section headers. Empty scopes
        are skipped. Returns '' when the user has no memory at all.

        Callers can pass this as `options['memory_context']` which every
        provider appends to its resolved system prompt (default or custom).
        """
        if userId <= 0:
            return ''
        repo = UserMemoryRepository(db)
        try:
            both = repo.getBoth(userId)
        except Exception as e:  # noqa: BLE001
            error_log(f'[UserMemoryRepository] buildMemoryBlock failed: {e}')
            return ''

        memory = (both.get(UserMemoryRepository.SCOPE_MEMORY) or '').strip()
        user = (both.get(UserMemoryRepository.SCOPE_USER) or '').strip()

        parts = []
        if memory != '':
            parts.append("## Memory\n" + memory)
        if user != '':
            parts.append("## User\n" + user)
        return "\n\n".join(parts)
