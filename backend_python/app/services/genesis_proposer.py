"""Port of Services/GenesisProposer.php (1-131).

Pure prompt-building + response-parsing for the one-shot "propose a skill from
this conversation / prompt" reflection (L0 of
docs/specs/2026-07-14-skill-genesis-design.md). The LLM call itself is made
by the caller (GenesisController via ChatController.agent) so provider
settings, user keys and quota checks apply uniformly.

Concern (report): the live PHP `GenesisProposer.php` (131 lines, confirmed via
`grep -n 'function '`) has ONLY `buildConversationPrompt`, `buildPromptLibraryPrompt`
and `parseProposal` (+ private `catalogBlock`/`truncate`) — there is no
`buildWorkflowPrompt`. `backend/tests/Unit/GenesisProposerTest.php` still
references `GenesisProposer::buildWorkflowPrompt(...)` in three test methods;
that method does not exist anywhere in `src/` (only in the stale test file).
`GenesisController::createProposal` (PHP 340-380) confirms the refactor: the
'workflow' source now builds its proposal DETERMINISTICALLY in the controller
(no LLM prompt, no GenesisProposer call at all) — see the comment there
("Nothing here needs LLM judgment — build the proposal DETERMINISTICALLY").
Per task instructions ("If a brief expectation is contradicted by PHP, keep
PHP"), this port omits `buildWorkflowPrompt` and does not port the three
stale test cases that reference it.
"""
from __future__ import annotations

import re

from app.support.phpcompat import mb_substr, php_bool, php_trim
from app.support.phpjson import dumps as _json_encode

# Cap transcript/run material so the reflection stays one cheap call.
MAX_TRANSCRIPT_CHARS = 12000
MAX_RUNS = 20

OUTPUT_CONTRACT = (
    'Respond with ONE JSON object only — no markdown fences, no commentary:\n'
    '{\n'
    '  "skill_name": "<kebab-case name, max 60 chars>",\n'
    '  "description": "<WHEN <trigger> DO <steps> — one paragraph, trigger-shaped, generalized (parameters, not literals)>",\n'
    '  "eval_queries": [{"query": "<realistic user prompt>", "should_trigger": true|false}, ...  6-12 items, mix of positives (paraphrases of the real trigger) and negatives (adjacent but out-of-scope)],\n'
    '  "parameter_schema": {"<param>": {"type": "string", "examples": ["..."], "default": "..."}} or null,\n'
    '  "merge_target": "<existing skill name from the catalog that already covers this>" or null,\n'
    '  "rationale": "<one sentence: why this is a repeatable procedure worth a skill>"\n'
    '}\n'
    'If an existing catalog skill already covers this procedure, you MUST set merge_target instead of inventing a near-duplicate name.\n'
    'The user EXPLICITLY requested this promotion — demand is already established, so do NOT judge whether the procedure is "worth" a skill. '
    'Generalize the best skill you can from the material (uniform run histories are fine: parameterize by inspecting the structure). '
    'Return {"skill_name": null} ONLY when the material is truly unusable — empty, or containing no identifiable action at all.'
)


class GenesisProposer:
    """Static/pure helpers — no instance state (mirrors the PHP `final class` of
    static methods)."""

    MAX_TRANSCRIPT_CHARS = MAX_TRANSCRIPT_CHARS
    MAX_RUNS = MAX_RUNS
    OUTPUT_CONTRACT = OUTPUT_CONTRACT

    @staticmethod
    def buildConversationPrompt(messages, catalog) -> str:
        """@param messages: list[{role, content}]"""
        lines = []
        # PHP `foreach ($messages as $m)` iterates VALUES for both a list and an
        # associative (string-keyed) array — a dict here must iterate .values(),
        # not its keys, to match.
        if isinstance(messages, dict):
            iterable = messages.values()
        elif isinstance(messages, list):
            iterable = messages
        else:
            iterable = []
        for m in iterable:
            m = m if isinstance(m, dict) else {}
            role = str(m['role'] if m.get('role') is not None else 'user').upper()
            content = m.get('content')
            if not isinstance(content, str):
                content = _json_encode(content if content is not None else '')
            if php_trim(content) == '':
                continue
            lines.append(f'{role}: {content}')
        transcript = GenesisProposer._truncate('\n\n'.join(lines), GenesisProposer.MAX_TRANSCRIPT_CHARS)

        return (
            'You analyse ONE conversation between a user and an AI assistant and decide whether it '
            'contains a repeatable multi-step PROCEDURE the user is likely to want again — and if so, '
            'propose a skill that encapsulates it.\n\n'
            'EXISTING SKILL CATALOG (name — description):\n' + GenesisProposer._catalogBlock(catalog) + '\n\n'
            'CONVERSATION TRANSCRIPT:\n---\n' + transcript + '\n---\n\n'
            + GenesisProposer.OUTPUT_CONTRACT
        )

    @staticmethod
    def buildPromptLibraryPrompt(name: str, content: str, catalog) -> str:
        """A saved, reused prompt is a proto-skill: its text is the trigger material."""
        return (
            "You analyse ONE saved prompt from the user's prompt library — a prompt they saved to reuse — "
            'and propose a skill that encapsulates the procedure it invokes.\n'
            'The prompt text is the best possible evidence of the trigger: derive the WHEN from how the '
            'prompt is phrased, and the DO from what it instructs. Lift concrete values (topics, formats, '
            'currencies, counts) into parameters with the observed values as defaults/examples.\n\n'
            'SAVED PROMPT "' + name + '":\n---\n'
            + GenesisProposer._truncate(content, GenesisProposer.MAX_TRANSCRIPT_CHARS) + '\n---\n\n'
            'EXISTING SKILL CATALOG (name — description):\n' + GenesisProposer._catalogBlock(catalog) + '\n\n'
            + GenesisProposer.OUTPUT_CONTRACT
        )

    @staticmethod
    def parseProposal(llmText: str) -> dict | None:
        """Parse + validate the LLM's proposal. None = no usable proposal."""
        import json

        m = re.search(r'\{.*\}', llmText, re.DOTALL)
        if not m:
            return None
        try:
            data = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            return None
        if not isinstance(data, dict):
            return None

        rawMerge = data.get('merge_target')
        mergeTarget = rawMerge if isinstance(rawMerge, str) and rawMerge != '' else None

        rawSkillName = data.get('skill_name')
        hasSkillName = isinstance(rawSkillName, str) and rawSkillName != ''
        isMerge = not hasSkillName and mergeTarget is not None

        if not hasSkillName and not isMerge:
            return None  # includes the explicit {"skill_name": null} no-procedure answer
        description = data.get('description')
        if not isinstance(description, str) or php_trim(description) == '':
            return None

        # Merge proposals carry the name in merge_target; non-merge proposals carry it in skill_name.
        rawName = mergeTarget if isMerge else rawSkillName
        name = php_trim(rawName).lower()
        name = re.sub(r'[^a-z0-9]+', '-', name)
        name = re.sub(r'-+', '-', name).strip('-')
        name = name[:60]
        if name == '':
            return None

        rawEvals = data.get('eval_queries')
        if isinstance(rawEvals, dict):
            rawEvals = list(rawEvals.values())
        if not isinstance(rawEvals, list):
            rawEvals = []
        evals = []
        for q in rawEvals:
            if isinstance(q, dict) and 'query' in q and 'should_trigger' in q and isinstance(q['query'], str):
                evals.append({'query': q['query'], 'should_trigger': php_bool(q['should_trigger'])})

        rawSchema = data.get('parameter_schema')
        parameterSchema = rawSchema if isinstance(rawSchema, (dict, list)) else None

        rationale = data.get('rationale')
        rationale = rationale if isinstance(rationale, str) else ''

        return {
            'skill_name': name,
            'description': php_trim(description),
            'eval_queries': evals,
            'parameter_schema': parameterSchema,
            'merge_target': mergeTarget,
            'rationale': rationale,
            'is_merge': isMerge,
        }

    @staticmethod
    def _catalogBlock(catalog) -> str:
        if not catalog:
            return '(catalog empty)'
        lines = []
        for s in catalog:
            if not isinstance(s, dict) or not s.get('name'):
                continue
            descr = s.get('description') if s.get('description') is not None else ''
            lines.append('- ' + str(s['name']) + ' — ' + str(descr))
        return '\n'.join(lines) if lines else '(catalog empty)'

    @staticmethod
    def _truncate(text: str, max_: int) -> str:
        if len(text) <= max_:
            return text
        return mb_substr(text, 0, max_) + '\n[…truncated…]'
