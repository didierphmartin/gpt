"""Port of backend/src/AgentTeam/Services/SwarmRewriter.php -- turns a swarm canvas into the graph that runs.

A swarm is exactly the agents fanned out directly from Start, wired into a full mesh with each other and
nothing else. An agent not connected to Start is refused rather than absorbed; the Dispatcher tag belongs
to workflow mode and is refused wherever it appears. Pure: no I/O, no randomness, no state. The JS twin
(frontend/assets/js/swarm-rewrite.js) and backend/tests/fixtures/swarm/rewrite-cases.json are the contract.
"""
from __future__ import annotations

import functools
import re

_PHP_TRIM = ' \t\n\r\x00\x0b'
_DIGITS = re.compile(r'^\d+$', re.ASCII)


def _by_id(lst: list) -> list:
    """Order by node id: numeric ids numerically, anything else by byte order (strcmp)."""
    def cmp(a, b) -> int:
        a_s, b_s = str(a), str(b)
        if _DIGITS.match(a_s) and _DIGITS.match(b_s):
            return (int(a_s) > int(b_s)) - (int(a_s) < int(b_s))
        ab, bb = a_s.encode('utf-8'), b_s.encode('utf-8')
        return (ab > bb) - (ab < bb)
    return sorted(lst, key=functools.cmp_to_key(cmp))


class SwarmRewriter:
    # Handoffs beyond this end a run; mirrored in the interpreter.
    HOP_BUDGET = 25

    @classmethod
    def rewrite(cls, graph: dict) -> dict:
        """ok: {ok, agents, entry} | refusal: {ok: False, error, nodes}."""
        nodes: dict = {}
        ids: list = []
        for n in graph.get('nodes') or []:
            i = str(n['id'])
            nodes[i] = n
            ids.append(i)
        edges = []
        for e in graph.get('edges') or []:
            f = e.get('from') if e.get('from') is not None else e.get('from_node_id')
            t = e.get('to') if e.get('to') is not None else e.get('to_node_id')
            edges.append((str(f if f is not None else ''), str(t if t is not None else '')))

        def children(i: str) -> list:
            return [t for f, t in edges if f == i]

        def cfg(n: dict) -> dict:
            c = n.get('config')
            return c if isinstance(c, dict) else {}

        def typeOf(n: dict) -> str:
            v = cfg(n).get('type')
            if v is None:
                v = n.get('node_type')
            return '' if v is None else str(v)

        def isAgent(n: dict) -> bool:
            return typeOf(n) in ('agent', 'agent-template')

        def isDispatcher(n: dict) -> bool:
            return (cfg(n).get('agent_type') or '') == 'dispatcher'

        # --- refusals, in the order a user is most likely to hit them ---
        playbooks = [i for i in ids if typeOf(nodes[i]) == 'playbook']
        outputs = [i for i in ids if typeOf(nodes[i]) == 'output']
        if playbooks:
            return {'ok': False, 'error': 'playbook_unsupported', 'nodes': _by_id(playbooks)}
        if len(outputs) > 1:
            return {'ok': False, 'error': 'multiple_outputs', 'nodes': _by_id(outputs)}
        tagged = [i for i in ids if isAgent(nodes[i]) and isDispatcher(nodes[i])]
        if tagged:
            return {'ok': False, 'error': 'dispatcher_in_swarm', 'nodes': _by_id(tagged)}

        menu: list = []
        for i in ids:
            if typeOf(nodes[i]) != 'start':
                continue
            for c in children(i):
                if c in nodes and isAgent(nodes[c]) and c not in menu:
                    menu.append(c)   # a doubled edge must not double a member
        menu = _by_id(menu)
        if len(menu) < 2:
            return {'ok': False, 'error': 'start_needs_two_agents', 'nodes': []}

        notOnStart = [i for i in ids if isAgent(nodes[i]) and i not in menu]
        if notOnStart:
            return {'ok': False, 'error': 'agent_not_on_start', 'nodes': _by_id(notOnStart)}

        seen: dict = {}
        dupes: dict = {}
        for i in menu:
            key = cls._displayName(nodes, i).strip(_PHP_TRIM).lower()
            if key in seen:
                dupes[seen[key]] = True
                dupes[i] = True
            else:
                seen[key] = i
        if dupes:
            return {'ok': False, 'error': 'duplicate_agent_names', 'nodes': _by_id([str(k) for k in dupes])}

        members = menu

        def roleOf(i: str) -> str:
            text = str(cfg(nodes[i]).get('instructions') or '').strip(_PHP_TRIM)
            first = text.split('\n')[0].strip(_PHP_TRIM)
            return first[:120]

        agents: dict = {}
        for i in members:
            handoffs = _by_id([o for o in menu if o != i])
            colleagues = [{'name': cls._displayName(nodes, h), 'role': roleOf(h)} for h in handoffs]
            own = cfg(nodes[i]).get('instructions')
            own = '' if own is None else str(own)
            guide = '' if not colleagues else cls.handoffGuide(colleagues)
            skills = cfg(nodes[i]).get('bound_skill')
            agents[i] = {
                'id': i,
                'name': cls._displayName(nodes, i),
                'instructions': own if guide == '' else own.rstrip(_PHP_TRIM) + '\n\n' + guide,
                'tools': cls._toolList(cfg(nodes[i]).get('tools')),
                'skills': [skills] if cls._hasSkill(skills) else [],
                'handoffs': handoffs,
            }
        return {'ok': True, 'agents': agents, 'entry': menu[0]}

    @staticmethod
    def _displayName(nodes: dict, i: str) -> str:
        """The display name a handoff would use: a non-empty string agent_name / name, else "node <id>"."""
        c = nodes[i].get('config') if isinstance(nodes[i].get('config'), dict) else {}
        for k in ('agent_name', 'name'):
            v = c.get(k)
            if isinstance(v, str) and v != '':
                return v
        return f'node {i}'

    @staticmethod
    def _toolList(v) -> list:
        """A genuine list, or nothing."""
        return v if isinstance(v, list) else []

    @staticmethod
    def _hasSkill(v) -> bool:
        """Presence, not truthiness."""
        return v is not None and v != '' and v is not False

    @staticmethod
    def handoffGuide(colleagues: list) -> str:
        lines = ['## Colleagues you can hand this to']
        for c in colleagues:
            role = str(c['role']).strip(_PHP_TRIM)
            lines.append('- ' + c['name'] + (' — ' + role if role != '' else ''))
        lines.append('')
        lines.append('Hand off when the request is theirs rather than yours, and say why in the reason.')
        lines.append('Answer directly when it is yours.')
        lines.append('Do not hand back what you were just handed unless the subject has genuinely changed.')
        return '\n'.join(lines)
