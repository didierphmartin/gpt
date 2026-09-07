"""Port of backend/src/Playbook/PlaybookDocument.php (110 lines)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from app.support.phpcompat import php_array_cast, php_bool, php_strval, php_trim


@dataclass(frozen=True)
class PlaybookDocument:
    title: str
    trigger: dict
    instructions: str
    toolsUsed: list
    actionsUsed: list
    bindings: dict
    policy: dict
    approvers: dict
    domain: str = ''

    # Section header: optional "1." / "-" / "##" / "**" prefix, keyword, colon.
    # PHP: '/^\s*(\d+[.)]|[-*•]|#{1,6})?\s*\**(Title|Trigger|Instructions|Tools used|Actions used|Domain)\**\s*:\**\s*(.*)$/i'
    SECTION_HEADER_RE = re.compile(
        r'^\s*(\d+[.)]|[-*•]|#{1,6})?\s*\**(Title|Trigger|Instructions|Tools used|Actions used|Domain)\**\s*:\**\s*(.*)$',
        re.IGNORECASE,
    )

    @staticmethod
    def fromArray(a: dict) -> 'PlaybookDocument':
        """PHP 20-48."""
        a = a if isinstance(a, dict) else {}
        title = php_trim(php_strval(a.get('title')) if a.get('title') is not None else '')
        instructions = php_trim(php_strval(a.get('instructions')) if a.get('instructions') is not None else '')
        if title == '' or instructions == '':
            missing = []
            if title == '':
                missing.append('title')
            if instructions == '':
                missing.append('instructions')
            raise ValueError(
                'Playbook JSON is missing the required "' + '" and "'.join(missing) + '" field'
                + ('s' if len(missing) > 1 else '') + ' (or it is empty).'
            )
        trigger = a.get('trigger') if a.get('trigger') is not None else {}
        if not isinstance(trigger, dict):
            trigger = {}
        # PHP: `(array)($a['tools_used'] ?? [])` / `(array)($a['actions_used']
        # ?? [])` (PlaybookDocument.php:37-38) -- a scalar value here (e.g. a
        # bare string) casts to a single-element array, not an iterable of
        # its characters.
        tools_used = php_array_cast(a.get('tools_used') if a.get('tools_used') is not None else [])
        actions_used = php_array_cast(a.get('actions_used') if a.get('actions_used') is not None else [])
        bindings = a.get('bindings') if a.get('bindings') is not None else {}
        policy_in = a.get('policy') if isinstance(a.get('policy'), dict) else {}
        approvers = a.get('approvers') if a.get('approvers') is not None else {}
        return PlaybookDocument(
            title,
            {
                'kind': php_strval(trigger.get('kind')) if trigger.get('kind') is not None else 'request',
                'description': php_strval(trigger.get('description')) if trigger.get('description') is not None else '',
            },
            instructions,
            [php_trim(v) for v in (tools_used.values() if isinstance(tools_used, dict) else tools_used)],
            [php_trim(v) for v in (actions_used.values() if isinstance(actions_used, dict) else actions_used)],
            bindings,
            {
                'writes_enabled': php_bool(policy_in.get('writes_enabled')),
                'on_unbound': php_strval(policy_in.get('on_unbound')) if policy_in.get('on_unbound') is not None else 'handoff',
                'on_failure': php_strval(policy_in.get('on_failure')) if policy_in.get('on_failure') is not None else 'continue_then_handoff',
            },
            approvers,
            php_trim(php_strval(a.get('domain')) if a.get('domain') is not None else ''),
        )

    @staticmethod
    def fromConsoleText(text: str) -> 'PlaybookDocument':
        """Parse the Console library format: "Title: …", "Trigger: …",
        "Instructions: …", "Tools used: a; b", "Actions used: #A; #B". PHP 54-98."""
        sections = {'title': '', 'trigger': '', 'instructions': '', 'tools used': '', 'actions used': '', 'domain': ''}
        current: Optional[str] = None
        for line in re.split(r'\r?\n', text):
            m = PlaybookDocument.SECTION_HEADER_RE.match(line)
            if m:
                current = m.group(2).lower()
                marker_prefix = m.group(1) or ''
                marker = marker_prefix + ' ' if re.match(r'^\d', marker_prefix) else ''
                rest = m.group(3)
                sections[current] = '' if rest == '' else marker + rest
            elif current is not None:
                sections[current] += "\n" + line

        def semi_list(s: str) -> list:
            return [x for x in (v.strip() for v in s.split(';')) if x != '']

        missing = []
        if sections['title'].strip() == '':
            missing.append('Title')
        if sections['instructions'].strip() == '':
            missing.append('Instructions')
        if missing:
            found = []
            for k, label in [('title', 'Title'), ('trigger', 'Trigger'), ('instructions', 'Instructions'),
                              ('tools used', 'Tools used'), ('actions used', 'Actions used'), ('domain', 'Domain')]:
                if sections[k].strip() != '':
                    found.append(label)
            raise ValueError(
                'Missing "%s:" section. Recognized sections: %s. Each section must start on its own line as "%s: …" '
                '(a list number, "##" or "**" before the keyword is fine).' % (
                    ':" and "'.join(missing),
                    'none' if not found else ', '.join(found),
                    missing[0],
                )
            )
        return PlaybookDocument.fromArray({
            'title': sections['title'].strip(),
            'trigger': {'kind': 'request', 'description': sections['trigger'].strip()},
            'instructions': sections['instructions'].strip(),
            'tools_used': semi_list(sections['tools used']),
            'actions_used': semi_list(sections['actions used']),
            'domain': sections['domain'].strip(),
        })

    def toArray(self) -> dict:
        """PHP 100-109."""
        return {
            'title': self.title, 'trigger': self.trigger,
            'instructions': self.instructions, 'tools_used': self.toolsUsed,
            'actions_used': self.actionsUsed, 'bindings': self.bindings,
            'policy': self.policy, 'approvers': self.approvers,
            'domain': self.domain,
        }
