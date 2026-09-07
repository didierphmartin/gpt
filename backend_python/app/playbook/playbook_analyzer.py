"""Port of backend/src/Playbook/PlaybookAnalyzer.php (196 lines)."""
from __future__ import annotations

import re
from typing import Optional

from app.support.phpcompat import php_trim

from app.playbook.playbook_document import PlaybookDocument

_PHP_INT_MAX = 2 ** 63 - 1

_ACTION_RE = re.compile(r"#[A-Z][\w'’]*(?: [A-Z][\w'’]*){0,5}(?: \([A-Za-z ]+\))?", re.UNICODE)
_STEP_RE = re.compile(r'^\s*(\d+(?:\.\d+)*)[.)]?\s')
_NUMBERED_RE = re.compile(r'^\d+(?:\.\d+)*[.)]?\s')
_LEADING_DIGIT_RE = re.compile(r'^\d')
_TOKEN_SPLIT_RE = re.compile(r'[^a-z0-9]+')


class PlaybookAnalyzer:
    """#Action name (case-insensitive, trimmed) => native tool id."""
    NATIVE_VERBS = {
        '#send direct message': 'send_direct_message',
        '#send channel message': 'send_channel_message',
        '#send email': 'send_email',
        '#leave internal note': 'leave_internal_note',
        '#resolve request': 'resolve_request',
        '#escalate request': 'set_priority',
        '#request approval': 'request_approval',
        '#prompt for handoff': 'prompt_handoff',
        '#trigger form': 'trigger_form',
    }
    _GATE_BY_NATIVE = {
        'request_approval': 'approval', 'prompt_handoff': 'handoff', 'trigger_form': 'form',
    }

    def analyze(self, doc: PlaybookDocument, availableTools: list, availableAgents: Optional[list] = None) -> dict:
        """PHP 24-120. @param availableTools "server.tool" ids @param availableAgents agent names"""
        availableAgents = availableAgents if availableAgents is not None else []
        actions = []
        gates = []
        errors = []
        warnings = []
        notices = []

        # Checklist = #Actions in prose order. Find positions longest-name-first
        # on a working copy of the instructions, masking each match (blanking it
        # out) as it's found, so a shorter name occurring only as a prefix/substring
        # of a longer one isn't mistaken for its own, earlier occurrence.
        names = sorted(doc.actionsUsed, key=len, reverse=True)
        working = doc.instructions
        positions: dict = {}
        for name in names:
            pos = working.lower().find(name.lower())
            positions[name] = pos if pos != -1 else _PHP_INT_MAX
            if pos != -1:
                working = working[:pos] + (' ' * len(name)) + working[pos + len(name):]
        ordered = sorted(doc.actionsUsed, key=lambda a: positions[a])

        # "where" = the step/line of the Instructions the action first appears
        # on, quoted, so the author can find and fix the faulty statement.
        def where(name: str) -> str:
            return self._locate(doc.instructions, name)

        # #Actions written in the prose but absent from "Actions used" never
        # get an action-space entry (they silently fall to the unbound
        # policy at run time) — point at the exact line.
        listed = [n.lower().strip() for n in doc.actionsUsed]
        seen: dict = {}
        step = ''
        for i, line in enumerate(re.split(r'\r?\n', doc.instructions)):
            step = self._stepOf(line, step)
            found_matches = _ACTION_RE.findall(line)
            if not found_matches:
                continue
            for found in _ACTION_RE.finditer(line):
                found_text = found.group(0)
                k = found_text.lower()
                if k in seen:
                    continue
                covered = False
                for l in listed:
                    if l.startswith(k) or k.startswith(l):
                        covered = True
                        break
                if covered:
                    continue
                seen[k] = True
                warnings.append(
                    f'{found_text} is used in the Instructions but not listed under "Actions used", '
                    f'so it will not be bound — {self._describeLine(i, line, step)}.'
                )

        for name in ordered:
            if positions[name] == _PHP_INT_MAX:
                notices.append(f'{name} is listed under "Actions used" but never appears in the Instructions.')
            key = name.lower().strip()
            if key in self.NATIVE_VERBS:
                native = self.NATIVE_VERBS[key]
                actions.append({'name': name, 'kind': 'native', 'target': native, 'auto': False})
                if native in self._GATE_BY_NATIVE:
                    gates.append(self._GATE_BY_NATIVE[native])
                continue
            hasExplicit = name in doc.bindings
            target = doc.bindings.get(name) if hasExplicit else None
            if target is None:
                # Markdown/Console text is the source format: when the author
                # gave NO binding (key absent), translate the #Action to a
                # connected tool by name-matching. An explicit null stays
                # deliberately unbound.
                auto = None if hasExplicit else self._autoBind(name, availableTools)
                if auto is not None:
                    actions.append({'name': name, 'kind': 'bound', 'target': auto, 'auto': True})
                    notices.append(f'Auto-bound {name} → {auto} (matched by name; add an explicit binding to override).')
                    continue
                actions.append({'name': name, 'kind': 'unbound', 'target': None, 'auto': False})
                warnings.append(f"Unbound action {name}: at run time the '{doc.policy['on_unbound']}' policy applies{where(name)}.")
                continue
            if target.startswith('agent.'):
                agent = target[6:]
                if agent in availableAgents:
                    actions.append({'name': name, 'kind': 'bound', 'target': target, 'auto': False})
                else:
                    actions.append({'name': name, 'kind': 'unbound', 'target': target, 'auto': False})
                    errors.append(f'{name} is bound to {target} but no such agent exists{where(name)}.')
                continue
            if target in availableTools:
                actions.append({'name': name, 'kind': 'bound', 'target': target, 'auto': False})
            else:
                actions.append({'name': name, 'kind': 'unbound', 'target': target, 'auto': False})
                errors.append(f'{name} is bound to {target} but that tool is not available on any connected MCP server{where(name)}.')

        seen_gates = []
        for g in gates:
            if g not in seen_gates:
                seen_gates.append(g)
        return {'actions': actions, 'gates': seen_gates,
                'checklist': ordered, 'errors': errors, 'warnings': warnings, 'notices': notices}

    @staticmethod
    def _locate(instructions: str, name: str) -> str:
        """" — step 7: \"7. #Foo …\"" for the first Instructions line containing name, else ""."""
        step = ''
        for i, line in enumerate(re.split(r'\r?\n', instructions)):
            step = PlaybookAnalyzer._stepOf(line, step)
            if name.lower() in line.lower():
                return ' — ' + PlaybookAnalyzer._describeLine(i, line, step)
        return ''

    @staticmethod
    def _stepOf(line: str, current: str) -> str:
        """The author's step number on this line ("7", "2.1"), else the enclosing one carried in."""
        m = _STEP_RE.match(line)
        return m.group(1) if m else current

    @staticmethod
    def _describeLine(index: int, line: str, step: str) -> str:
        """'step 7: "…"' on a numbered line; 'step 4, line 7: "…"' for a sub-line; 'line N: "…"' outside any step."""
        t = php_trim(line)
        numbered = _NUMBERED_RE.match(t) is not None
        if numbered:
            label = f'step {step}'
        elif step != '':
            label = f'step {step}, line {index + 1}'
        else:
            label = f'Instructions line {index + 1}'
        if len(t) > 90:
            t = t[:87] + '…'
        return label + ': "' + t + '"'

    def _autoBind(self, actionName: str, availableTools: list) -> Optional[str]:
        """Deterministic name-match of a prose #Action to one connected
        "server.tool". Tokens are lowercased, de-pluralized words; a match
        needs score >= 2 and a strictly unique best candidate. Server-name
        tokens in the action name weigh double. Returns the tool id or None."""
        stop = ['custom', 'the', 'a', 'an', 'by', 'for', 'to', 'and', 'of', 'action']

        def tok(t: str) -> list:
            words = _TOKEN_SPLIT_RE.split(t.lower())
            out = []
            for w in words:
                if w == '' or w in stop:
                    continue
                stripped = w.rstrip('s')
                out.append(stripped if stripped else w)
            seen_local = []
            for w in out:
                if w not in seen_local:
                    seen_local.append(w)
            return seen_local

        actionTokens = tok(actionName)
        if not actionTokens:
            return None

        best = None
        bestScore = 0
        tie = False
        for id_ in availableTools:
            dot = id_.find('.')
            server = '' if dot == -1 else id_[:dot]
            tool = id_ if dot == -1 else id_[dot + 1:]
            score = 0
            for st in tok(server):
                if st in actionTokens:
                    score += 4
            toolTokens = tok(tool)
            toolHits = 0
            for tt in toolTokens:
                if tt in actionTokens:
                    toolHits += 1
            score += 2 * toolHits
            if toolTokens and toolHits == len(toolTokens):
                score += 1
            if score > bestScore:
                best = id_
                bestScore = score
                tie = False
            elif score == bestScore and score > 0:
                tie = True
        return best if (bestScore >= 4 and not tie) else None
