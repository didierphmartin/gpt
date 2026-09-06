"""Port of backend/src/AgentTeam/Services/UserMemoryEventsRepository.php.

Audit log for user memory changes.

Every write to user_memories (manual, auto-extract, revert, compact) is
recorded here with full before/after snapshots so the UI can show history
and revert to any prior state.
"""
from __future__ import annotations


class UserMemoryEventsRepository:
    SOURCE_MANUAL = 'manual'
    SOURCE_AUTO_EXTRACT = 'auto_extract'
    SOURCE_REVERT = 'revert'
    SOURCE_COMPACT = 'compact'

    def __init__(self, db):
        self.db = db
        self.tablesChecked = False

    def ensureTablesExist(self) -> None:
        # Tables exist in the schema; no runtime DDL is ported.
        self.tablesChecked = True

    def log(
        self,
        userId: int,
        scope: str,
        source: str,
        before: str,
        after: str,
        rationale: str | None = None,
        sessionId: str | None = None,
    ) -> int:
        self.ensureTablesExist()

        if before == after:
            return 0

        return self.db.insert(
            "INSERT INTO user_memory_events "
            "(user_id, scope, source, before_content, after_content, rationale, session_id) "
            "VALUES (:user_id, :scope, :source, :before, :after, :rationale, :session_id)",
            {
                'user_id': userId,
                'scope': scope,
                'source': source,
                'before': before,
                'after': after,
                'rationale': rationale,
                'session_id': sessionId,
            },
        )

    def list(self, userId: int, limit: int = 50) -> list:
        self.ensureTablesExist()
        limit = max(1, min(200, limit))

        rows = self.db.fetch_all(
            "SELECT id, scope, source, before_content, after_content, rationale, session_id, created_at "
            f"FROM user_memory_events WHERE user_id = ? ORDER BY id DESC LIMIT {limit}",
            [userId],
        )
        return rows or []

    def get(self, userId: int, eventId: int) -> dict | None:
        self.ensureTablesExist()
        row = self.db.fetch_one(
            "SELECT id, scope, source, before_content, after_content, rationale, session_id, created_at "
            "FROM user_memory_events WHERE id = ? AND user_id = ?",
            [eventId, userId],
        )
        return row or None

    def delete(self, userId: int, eventId: int) -> bool:
        """Remove an audit event. Used when a change is reverted — the entry
        should disappear from the recent-changes list rather than stick
        around with a "reverted" marker."""
        self.ensureTablesExist()
        return self.db.execute(
            "DELETE FROM user_memory_events WHERE id = ? AND user_id = ?",
            [eventId, userId],
        ) > 0

    def lastSource(self, userId: int, scope: str) -> str | None:
        """Returns the scope of the most recent event for the user, or null
        if there is none. Used by the UI to render the "auto" badge."""
        self.ensureTablesExist()
        row = self.db.fetch_one(
            "SELECT source FROM user_memory_events "
            "WHERE user_id = ? AND scope = ? ORDER BY id DESC LIMIT 1",
            [userId, scope],
        )
        return str(row['source']) if row else None
