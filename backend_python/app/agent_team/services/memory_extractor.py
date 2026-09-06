"""Port of backend/src/AgentTeam/Services/MemoryExtractor.php.

Decides whether anything from a chat turn is worth saving as durable
memory, and emits proposed additions for the two scopes.

Single non-streaming Claude API call. Designed to be called from the
tail of a request so latency doesn't affect the user. Returns None on any
failure — callers must be OK with "no update this turn" as a normal
outcome.
"""
from __future__ import annotations

import json
import math
import re

import httpx

from app.support.logger import error_log
from app.support.phpcompat import mb_substr, php_empty

_SYSTEM_PROMPT = """You are a memory curator for a long-running conversational assistant.

After each turn, you decide whether anything in the user's message or the assistant's reply is worth saving as durable memory for future conversations.

Two scopes exist:

USER — **anything about the person themselves**:
  - role, profession, expertise, areas of study
  - personal biographical facts: age, location, timezone, languages spoken, family status, life circumstances
  - hobbies, lifestyle, physical activities, habits
  - communication preferences, persistent likes/dislikes
  - tools they personally prefer to use
  Rule of thumb: if it describes WHO the user is or how they live, it goes here.

MEMORY — **facts about the user's projects, work, or environment**:
  - codebases, tech stack, conventions, tools in use on a specific project
  - ongoing work, milestones, decisions, constraints
  - systems, services, or data they reference
  - domain-specific facts relevant to their professional work
  Rule of thumb: if it describes WHAT the user is working on or the environment they operate in, it goes here.

When a fact could arguably fit both (e.g. "I'm a cardiology resident" — profession AND work context), prefer USER.
Never put biographical facts (age, location, hobbies, lifestyle, languages, family) into MEMORY.

**IMPORTANT**: classify each new fact by its nature, NOT by imitating where similar facts appear in the existing blocks. Previous turns may have misclassified items — do not perpetuate those mistakes. A biographical fact always goes to USER, even if the current MEMORY block already contains biographical lines.

Rules:
- Save only facts that are non-obvious AND likely useful across future conversations.
- **Aggressive duplicate rejection**: before adding anything, read the CURRENT MEMORY and CURRENT USER blocks line by line. If the new fact is already stated there — even in different words, even as a subset, even as a near-paraphrase — DO NOT propose it. When in doubt, omit.
  Examples of what counts as duplicate:
    existing: "User is a polymath interested in biomedical and computer science topics"
    proposed: "User has research interests across health and CS" → DUPLICATE, reject
    existing: "User prefers concise answers without hedging"
    proposed: "User likes direct replies, no fillers" → DUPLICATE, reject
- Skip transient task details ("I'm about to run X", "the error said Y") — those belong in the conversation, not memory.
- Each addition is a short single-line statement, no bullets, no preamble.
- If nothing genuinely new is worth saving, return empty arrays. That is the normal, expected outcome for most turns.

Respond with ONLY a JSON object, no markdown fences, no prose:
{
  "memory_additions": ["short fact 1", "short fact 2"],
  "user_additions":   ["short preference 1"],
  "reason": "one short phrase explaining what you saved, or 'nothing worth saving'"
}"""


def _first_text(body: dict) -> str:
    """body['content'][0]['text'] ?? ''"""
    content = body.get('content') if isinstance(body, dict) else None
    if isinstance(content, list) and content and isinstance(content[0], dict):
        text = content[0].get('text')
        if isinstance(text, str):
            return text
    return ''


def _to_array(v):
    """PHP (array) cast."""
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return list(v.values())
    if v is None:
        return []
    return [v]


class MemoryExtractor:
    ENDPOINT = 'https://api.anthropic.com/v1/messages'
    API_VERSION = '2023-06-01'
    MAX_TOKENS = 512

    def __init__(self, apiKey: str):
        self.apiKey = apiKey
        self.http = httpx.Client(timeout=30)

    def extract(
        self,
        model: str,
        currentMemory: str,
        currentUser: str,
        lastUserMsg: str,
        lastAssistantMsg: str,
    ) -> dict | None:
        if self.apiKey == '':
            return None

        system = self._buildSystemPrompt()
        userContent = self._buildUserContent(currentMemory, currentUser, lastUserMsg, lastAssistantMsg)

        try:
            response = self.http.post(
                self.ENDPOINT,
                headers={
                    'x-api-key': self.apiKey,
                    'anthropic-version': self.API_VERSION,
                    'content-type': 'application/json',
                },
                json={
                    'model': model,
                    'max_tokens': self.MAX_TOKENS,
                    'system': system,
                    'messages': [{'role': 'user', 'content': userContent}],
                },
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as e:
            error_log(f'[MemoryExtractor] API call failed: {e}')
            return None

        text = _first_text(body)
        if text == '':
            return None

        return self._parseJson(text)

    def filterDuplicates(self, model: str, currentContent: str, additions: list) -> list:
        """Second-stage semantic guard: given current memory and candidate additions,
        drop any addition that is already covered — even as a paraphrase or subset —
        by the existing content. Returns a filtered list (may be empty).

        Runs only when the first-stage extractor proposed additions, so no cost
        on the common "nothing to save" turns.
        """
        if self.apiKey == '' or php_empty(additions) or currentContent.strip() == '':
            return additions

        system = (
            "You decide which candidate facts are genuinely new vs. already covered by existing memory. "
            "A candidate is ALREADY COVERED if the existing memory states it — even using different words, "
            "even as a subset, even as a near-paraphrase, even if the existing line is more general. "
            "Default to COVERED when in doubt. Respond with ONLY a JSON array of the 0-based indices of "
            "candidates that are GENUINELY NEW (not covered). Example: [0, 2] means candidates 0 and 2 are new. "
            "Empty array means none are new."
        )

        candidateLines = [f"[{i}] {a}" for i, a in enumerate(additions)]
        userContent = f"EXISTING MEMORY:\n{currentContent}\n\nCANDIDATES:\n" + "\n".join(candidateLines)

        try:
            response = self.http.post(
                self.ENDPOINT,
                headers={
                    'x-api-key': self.apiKey,
                    'anthropic-version': self.API_VERSION,
                    'content-type': 'application/json',
                },
                json={
                    'model': model,
                    'max_tokens': 128,
                    'system': system,
                    'messages': [{'role': 'user', 'content': userContent}],
                },
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as e:
            error_log(f'[MemoryExtractor] filterDuplicates call failed: {e}')
            return additions

        text = _first_text(body).strip()
        if text == '':
            return additions

        if text.startswith('```'):
            text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.M)
            text = text.strip()

        # Haiku sometimes emits the array followed by an explanation. Pluck the first JSON array.
        m = re.search(r'\[(?:\s*\d+\s*(?:,\s*\d+\s*)*)?\]', text)
        if m:
            text = m.group(0)

        try:
            indices = json.loads(text)
        except ValueError:
            indices = None
        if not isinstance(indices, list):
            error_log(f'[MemoryExtractor] filterDuplicates non-JSON: {mb_substr(text, 0, 200)}')
            return additions

        kept = []
        for i in indices:
            if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(additions):
                kept.append(additions[i])
        return kept

    def compact(self, model: str, content: str, budget: int, mustKeep: list | None = None) -> str | None:
        """Compact content to fit within a budget while preserving required lines.

        mustKeep: lines the extractor already decided to keep — never drop these.
        """
        if mustKeep is None:
            mustKeep = []
        if self.apiKey == '' or content == '':
            return None

        system = (
            f"You are a memory compactor. Rewrite the given memory block so it fits within {budget} characters. "
            "Preserve facts in the REQUIRED section verbatim. Drop the oldest or least-useful lines from the EXISTING section to make room. "
            "Merge duplicate or near-duplicate lines. Output ONLY the compacted text, no preamble, no quotes, no markdown fences."
        )

        requiredBlock = '(none)' if php_empty(mustKeep) else "\n".join(mustKeep)
        userContent = f"REQUIRED (keep verbatim):\n{requiredBlock}\n\nEXISTING (may be trimmed):\n{content}"

        try:
            response = self.http.post(
                self.ENDPOINT,
                headers={
                    'x-api-key': self.apiKey,
                    'anthropic-version': self.API_VERSION,
                    'content-type': 'application/json',
                },
                json={
                    'model': model,
                    'max_tokens': math.ceil(budget / 2),
                    'system': system,
                    'messages': [{'role': 'user', 'content': userContent}],
                },
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as e:
            error_log(f'[MemoryExtractor] compact call failed: {e}')
            return None

        text = _first_text(body).strip()
        if text == '':
            return None

        if len(text) > budget:
            text = mb_substr(text, 0, budget)
        return text

    def _buildSystemPrompt(self) -> str:
        return _SYSTEM_PROMPT

    def _buildUserContent(
        self,
        currentMemory: str,
        currentUser: str,
        lastUserMsg: str,
        lastAssistantMsg: str,
    ) -> str:
        currentMemory = currentMemory if currentMemory != '' else '(empty)'
        currentUser = currentUser if currentUser != '' else '(empty)'
        lastAssistantMsg = mb_substr(lastAssistantMsg, 0, 4000)
        lastUserMsg = mb_substr(lastUserMsg, 0, 4000)

        return (
            "=== CURRENT MEMORY ===\n"
            f"{currentMemory}\n"
            "\n"
            "=== CURRENT USER ===\n"
            f"{currentUser}\n"
            "\n"
            "=== LAST USER MESSAGE ===\n"
            f"{lastUserMsg}\n"
            "\n"
            "=== LAST ASSISTANT REPLY ===\n"
            f"{lastAssistantMsg}"
        )

    def _parseJson(self, text: str) -> dict | None:
        text = text.strip()
        if text.startswith('```'):
            text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text, flags=re.M)
            text = text.strip()

        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if not isinstance(data, (dict, list)):
            error_log(f'[MemoryExtractor] non-JSON response: {mb_substr(text, 0, 200)}')
            return None

        rawMemory = data.get('memory_additions') if isinstance(data, dict) else None
        rawMemory = rawMemory if rawMemory is not None else []
        memoryAdditions = [v for v in _to_array(rawMemory) if isinstance(v, str) and v.strip() != '']

        rawUser = data.get('user_additions') if isinstance(data, dict) else None
        rawUser = rawUser if rawUser is not None else []
        userAdditions = [v for v in _to_array(rawUser) if isinstance(v, str) and v.strip() != '']

        reasonRaw = data.get('reason') if isinstance(data, dict) else None
        reason = reasonRaw if isinstance(reasonRaw, str) else ''

        return {
            'memory_additions': memoryAdditions,
            'user_additions': userAdditions,
            'reason': mb_substr(reason, 0, 255),
        }
