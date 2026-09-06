"""Port of backend/src/AgentTeam/Services/MemoryAutoUpdater.php.

Orchestrates the post-turn memory auto-update:
  skip cheap cases → extract → merge per scope → compact if over budget → write + event row.

Designed to be called after the response is already delivered to the user
so the extractor call never adds latency. Any failure is swallowed and
logged — the assistant's response has already been delivered.
"""
from __future__ import annotations

from app.agent_team.services.memory_extractor import MemoryExtractor
from app.agent_team.services.user_memory_events_repository import UserMemoryEventsRepository
from app.agent_team.services.user_memory_repository import UserMemoryRepository
from app.agent_team.services.user_memory_settings_repository import UserMemorySettingsRepository
from app.support.logger import error_log
from app.support.phpcompat import php_empty


class MemoryAutoUpdater:
    MIN_USER_MSG_CHARS = 20

    def __init__(self, db, apiKey: str):
        self.db = db
        self.apiKey = apiKey
        self.memoryRepo = UserMemoryRepository(db)
        self.eventsRepo = UserMemoryEventsRepository(db)
        self.settingsRepo = UserMemorySettingsRepository(db)

    def run(self, userId: int, sessionId: str, lastUserMsg: str, lastAssistantMsg: str) -> dict | None:
        """Run the auto-update flow for one chat turn. Returns a dict describing
        what happened (for tests/debug) or None if short-circuited."""
        if userId <= 0 or self.apiKey == '':
            return None
        if len(lastUserMsg.strip()) < self.MIN_USER_MSG_CHARS:
            return None

        settings = self.settingsRepo.get(userId)
        if not settings['enabled']:
            return None

        current = self.memoryRepo.getBoth(userId)
        currentMemory = current[UserMemoryRepository.SCOPE_MEMORY]
        currentUser = current[UserMemoryRepository.SCOPE_USER]

        extractor = MemoryExtractor(self.apiKey)
        try:
            result = extractor.extract(
                settings['model'],
                currentMemory,
                currentUser,
                lastUserMsg,
                lastAssistantMsg,
            )

            if result is None:
                return None

            written: list = []

            # Second-stage guard: filter paraphrased/implied duplicates against current content.
            # Only runs when there are candidates, so no overhead on the common empty case.
            memoryAdditions = (
                extractor.filterDuplicates(settings['model'], currentMemory, result['memory_additions'])
                if not php_empty(result['memory_additions'])
                else []
            )
            userAdditions = (
                extractor.filterDuplicates(settings['model'], currentUser, result['user_additions'])
                if not php_empty(result['user_additions'])
                else []
            )

            if not php_empty(memoryAdditions):
                self._applyScope(
                    userId,
                    UserMemoryRepository.SCOPE_MEMORY,
                    currentMemory,
                    memoryAdditions,
                    result['reason'],
                    sessionId,
                    settings['model'],
                    extractor,
                    written,
                )

            if not php_empty(userAdditions):
                self._applyScope(
                    userId,
                    UserMemoryRepository.SCOPE_USER,
                    currentUser,
                    userAdditions,
                    result['reason'],
                    sessionId,
                    settings['model'],
                    extractor,
                    written,
                )

            return {
                'reason': result['reason'],
                'written': written,
            }
        finally:
            # Python-only addition: PHP has no equivalent — Guzzle clients
            # die with the request. Release the extractor's httpx client
            # regardless of how run() exits (early return, exception).
            extractor.close()

    def _applyScope(
        self,
        userId: int,
        scope: str,
        current: str,
        additions: list,
        reason: str,
        sessionId: str,
        model: str,
        extractor: MemoryExtractor,
        written: list,
    ) -> None:
        budget = self.memoryRepo.budgetFor(scope)
        candidate = self.memoryRepo.buildMerged(current, additions)

        if candidate == current:
            return  # all additions dedup'd away

        if len(candidate) <= budget:
            self.memoryRepo.set(userId, scope, candidate)
            self.eventsRepo.log(
                userId,
                scope,
                UserMemoryEventsRepository.SOURCE_AUTO_EXTRACT,
                current,
                candidate,
                reason,
                sessionId,
            )
            written.append(scope)
            return

        # Over budget — ask the model to compact, preserving the new additions verbatim.
        compacted = extractor.compact(model, candidate, budget, additions)
        if compacted is None or compacted == '':
            error_log(f'[MemoryAutoUpdater] compact returned empty for user={userId} scope={scope}; skipping write')
            return

        self.memoryRepo.set(userId, scope, compacted)
        self.eventsRepo.log(
            userId,
            scope,
            UserMemoryEventsRepository.SOURCE_COMPACT,
            current,
            compacted,
            reason,
            sessionId,
        )
        written.append(scope)
