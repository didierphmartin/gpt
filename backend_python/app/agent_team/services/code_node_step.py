"""Port of backend/src/AgentTeam/Services/CodeNodeStep.php.

The server runner's code-node rules, as pure functions. Twins of code-node.js
(parentsFor, routeAfter) so the browser and server run paths cannot drift.
"""
from __future__ import annotations

import re

from app.support.phpcompat import php_empty, php_intval, php_strval, php_trim
from app.support.phpjson import php_json_encode

# PCRE's \s without UCP: ASCII whitespace only (Python's \s would also match e.g. U+00A0).
_WS_RE = re.compile(r'[ \t\n\r\f\v]+')


def _cfg(node) -> dict:
    cfg = node.get('config') if isinstance(node, dict) else None
    return cfg if isinstance(cfg, dict) else {}


def _truthy_str(v) -> str:
    """`(string) ($v ?? '')` for a `?:` chain: '' when absent."""
    return php_strval(v) if v is not None else ''


class CodeNodeStep:
    # Node types whose execution means the run did real work (not a quiet poll).
    WORK_TYPES = ('agent', 'playbook', 'output')

    # Characters of an error exit's output kept in its log line (the compiled ErrorExitTaken.REASON_MAX).
    REASON_MAX = 200

    @staticmethod
    def reason(out: str) -> str:
        """An error exit's output as one line of at most REASON_MAX characters (ErrorExitTaken.reason)."""
        line = php_trim(_WS_RE.sub(' ', out))
        return line if len(line) <= CodeNodeStep.REASON_MAX else line[:CodeNodeStep.REASON_MAX] + '…'

    @staticmethod
    def parents(nodeId: int, edges: list, nodes: dict, nodeOutputs: dict, seen: dict | None = None) -> list:
        """run()'s parents: executed parents with a non-empty output; Start flagged (CodeNode.parentsFor).
        A dispatcher parent (its output carries the 'route' it chose) stands for its own parents: a
        branch receives what the dispatcher received (the email), not the agent-framed context."""
        seen = seen if seen is not None else {}
        out = []
        for e in edges:
            if php_intval(e.get('to_node_id')) != nodeId:
                continue
            u = php_intval(e.get('from_node_id'))
            o = nodeOutputs.get(u)
            o = o if isinstance(o, dict) else {}
            if o.get('route') is not None:
                if u not in seen:
                    out.extend(CodeNodeStep.parents(u, edges, nodes, nodeOutputs, {**seen, u: True}))
                continue
            text = o.get('output')
            if text is None or text == '':
                continue
            node = nodes.get(u)
            node = node if isinstance(node, dict) else {}
            start = node.get('node_type', '') == 'start'
            cfg = _cfg(node)
            if start:
                name = 'start'
            else:
                name = _truthy_str(cfg.get('agent_name'))
                if php_empty(name):
                    name = _truthy_str(cfg.get('name'))
                if php_empty(name):
                    name = f'node_{u}'
            out.append({'name': name,
                        'text': text if isinstance(text, str) else php_json_encode(text),
                        'start': start})
        return out

    @staticmethod
    def routeAfter(data: dict, result: dict, children: list) -> dict:
        """What a code node's result means for the run (CodeNode.routeAfter): its output, the children on
        the exit it took, and the children to skip. A failed run skips every child; an exit with no edge
        ends that branch, which is not a failure."""
        children = [php_intval(c) for c in children]
        if php_empty(result.get('ok')):
            err = result.get('error') if result.get('error') is not None else 'code node failed'
            return {'success': False, 'output': 'Error: ' + php_strval(err),
                    'exit': None, 'chosen': [], 'skip': children}
        targets = data.get('exit_targets') or {}
        route = result.get('route')
        chosenRaw = targets.get(route) if isinstance(route, str) and isinstance(targets, dict) else None
        chosen = [php_intval(c) for c in (chosenRaw if chosenRaw is not None else [])]
        out = result.get('output_text')
        return {'success': True, 'output': php_strval(out if out is not None else ''), 'exit': route,
                'chosen': chosen, 'skip': [c for c in children if c not in chosen]}

    @staticmethod
    def errorExits(nodeOutputs: dict, nodes: dict) -> list:
        """One line per code node that took its error exit: "code node '<name>' took its error exit: <reason>"."""
        lines = []
        for id_, o in nodeOutputs.items():
            if not isinstance(o, dict):
                continue
            if (o.get('type') if o.get('type') is not None else '') == 'code' and o.get('exit') == 'error':
                name = php_trim(_truthy_str(_cfg(nodes.get(id_)).get('name')))
                name = name if not php_empty(name) else 'Code'
                reason = CodeNodeStep.reason(_truthy_str(o.get('output')))
                lines.append(f"code node '{name}' took its error exit" + (f': {reason}' if reason != '' else ''))
        return lines

    @staticmethod
    def summarize(nodeOutputs: dict, edges: list, nodes: dict) -> dict:
        """quiet: a code node ran, did not error, and no work node ran. drain: a code node ran, a work node
        downstream of the exit it took ran, and nothing errored (a work node beside the poll, fed by Start,
        runs every tick and must not make a no-work run drain). A code node "ran" only when it took an
        exit: a disabled one (no exit) neither quiets nor drains the run. An error exit or a failed code
        node is never quiet and never drains: errors are always recorded."""
        codeRan = False
        errored = False
        worked = False
        behindExit: dict = {}   # node ids downstream of an exit a code node took
        for id_, o in nodeOutputs.items():
            o = o if isinstance(o, dict) else {}
            type_ = o.get('type') if o.get('type') is not None else ''
            if type_ in CodeNodeStep.WORK_TYPES:
                worked = True
            if type_ != 'code':
                continue
            success = o.get('success') if o.get('success') is not None else True
            if o.get('exit') == 'error' or success is False:
                errored = True
            elif isinstance(o.get('exit'), str):
                codeRan = True
                for k in CodeNodeStep._downstreamOfExit(php_intval(id_), o['exit'], edges, nodes):
                    behindExit.setdefault(k, True)
        workedBehindExit = False
        for id_ in behindExit:
            o = nodeOutputs.get(id_)
            t = o.get('type') if isinstance(o, dict) and o.get('type') is not None else ''
            if t in CodeNodeStep.WORK_TYPES:
                workedBehindExit = True
        return {'quiet': codeRan and not errored and not worked,
                'drain': codeRan and not errored and workedBehindExit}

    @staticmethod
    def _downstreamOfExit(id_: int, exit_: str, edges: list, nodes: dict) -> dict:
        """Every node reachable from the children on code node id_'s exit port (ids as keys)."""
        exits = _cfg(nodes.get(id_)).get('exits')
        if exits is None:
            exits = ['next']
        exits = list(exits.values()) if isinstance(exits, dict) else (exits if isinstance(exits, list) else [exits])
        if exit_ not in exits:
            return {}
        port = 'output_' + str(exits.index(exit_) + 1)
        todo = []
        for e in edges:
            fromPort = e.get('from_port') if e.get('from_port') is not None else 'output_1'
            if php_intval(e.get('from_node_id')) == id_ and fromPort == port:
                todo.append(php_intval(e.get('to_node_id')))
        seen: dict = {}
        while todo:
            n = todo.pop()
            if n in seen:
                continue
            seen[n] = True
            for e in edges:
                if php_intval(e.get('from_node_id')) == n:
                    todo.append(php_intval(e.get('to_node_id')))
        return seen
