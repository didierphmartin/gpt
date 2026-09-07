"""Dispatcher routing for batch workflows — the batch twin of the voice
runner's handoff_to (frontend/assets/js/workflow-realtime-runner.js).

For an agent of type 'dispatcher', its outgoing edges are a MENU of
branches the model may pick from by name, not a parallel fan-out. The
model calls route_to(target) once; exactly that branch runs and every
node reachable only through the unchosen branches is skipped.

Pure functions over the graph shape used by GraphWorkflowRunner
(nodes indexed by id with node_type/config; edges with from_node_id /
to_node_id). No I/O, so both run paths can be reasoned about here.

Ported from backend/src/AgentTeam/Services/DispatchRouting.php.
"""
from __future__ import annotations

from app.support.phpcompat import php_intval, php_strval, php_trim

_ASCII_UPPER_TO_LOWER = str.maketrans(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'
)


def _strtolower(s: str) -> str:
    """PHP strtolower(): byte-wise, ASCII A-Z only — unlike Python's .lower()
    it never touches non-ASCII letters (accents, etc.)."""
    return s.translate(_ASCII_UPPER_TO_LOWER)


class DispatchRouting:
    TOOL_NAME = 'route_to'

    @staticmethod
    def targets(nodeId: int, edges: list, nodes: dict) -> list:
        """Downstream agent nodes of nodeId as [{'id': int, 'name': str}, …] in edge order."""
        out = []
        for edge in edges:
            if php_intval(edge.get('from_node_id')) != nodeId:
                continue
            toId = php_intval(edge.get('to_node_id'))
            node = nodes.get(toId)
            if not node or node.get('node_type', '') != 'agent':
                continue
            cfg = node.get('config')
            cfg = cfg if isinstance(cfg, dict) else {}
            name = cfg.get('agent_name')
            if name is None:
                name = cfg.get('name')
            if name is None:
                name = f'Agent {toId}'
            out.append({'id': toId, 'name': php_strval(name)})
        return out

    @staticmethod
    def toolDefinition(targets: list) -> dict:
        """Tool definition in the Claude shape ({name, description, input_schema}) — the
        common denominator AgentRunner's extra_tools use; other providers translate it."""
        names = [t['name'] for t in targets]
        return {
            'name': DispatchRouting.TOOL_NAME,
            'description': 'REQUIRED tool to hand the request to exactly one downstream agent. '
                'Pick the agent whose role matches the request. Available targets: '
                + ', '.join(names) + '. The chosen agent receives the original request, plus your notes.',
            'input_schema': {
                'type': 'object',
                'properties': {
                    'target': {
                        'type': 'string',
                        'enum': names,
                        'description': 'Name of the agent to route to. MUST be one of the listed values.',
                    },
                    'notes': {
                        'type': 'string',
                        'description': 'Optional short note for the target agent (what you understood, what to focus on).',
                    },
                },
                'required': ['target'],
            },
        }

    @staticmethod
    def defaultInstructions(agentName: str, description: str, workflowName: str) -> str:
        """Instructions for a node the author left blank. Without this the chat
        endpoint falls back to the user's CONVERSATION persona (Context tab,
        2026-09-02) — a workflow node must never inherit that."""
        desc = php_trim(description)
        return (f'You are "{agentName}"' + (f', {desc}' if desc != '' else '')
                + f', an agent in the workflow "{workflowName}". '
                + 'Handle the request you receive directly and completely, in the role your name implies.')

    @staticmethod
    def routedPrompt(targetName: str, fromName: str, notes: str) -> str:
        """Fragment appended to the CHOSEN target's instructions (the batch twin of
        the voice prompt "the caller has been transferred to you for billing help")."""
        n = php_trim(notes)
        return ('## Routed request\n'
                f'The dispatcher "{fromName}" reviewed this request and routed it to you, "{targetName}", '
                'because it falls under your responsibility. Handle it yourself as '
                f'"{targetName}". '
                'Do not redirect the requester to another department or agent, and do not ask who should handle it.'
                + (f'\nNotes from the dispatcher: {n}' if n != '' else ''))

    @staticmethod
    def routedBy(nodeId: int, edges: list, outputs: dict) -> dict | None:
        """{'from': dispatcherName, 'notes': …} when an upstream dispatcher's
        output routed to nodeId, else None. outputs = nodeOutputs by node id."""
        for edge in edges:
            if php_intval(edge.get('to_node_id')) != nodeId:
                continue
            out = outputs.get(php_intval(edge.get('from_node_id')))
            route = out.get('route') if isinstance(out, dict) else None
            route = route if isinstance(route, dict) else None
            if route is not None and php_intval(route.get('id', 0)) == nodeId:
                agent_name = out.get('agent_name') if isinstance(out, dict) else None
                return {
                    'from': php_strval(agent_name if agent_name is not None else 'dispatcher'),
                    'notes': php_strval(route.get('notes', '')),
                }
        return None

    @staticmethod
    def promptBlock(targets: list) -> str:
        """Prompt fragment appended to the dispatcher's instructions (mirrors the voice TRANSFER RULES)."""
        lines = [f"  - {t['name']}" for t in targets]
        return ('## Routing\n'
                'You are a dispatcher. Your only job is to decide which ONE of these agents should handle the request:\n'
                + '\n'.join(lines) + '\n'
                + 'Read the request, then call the route_to function with target set to that agent\'s exact name '
                + '(optionally add notes). You MUST call route_to — answering in prose does not route the request. '
                + 'Never call it more than once.')

    @staticmethod
    def resolve(toolCalls: list, targets: list) -> dict | None:
        """The chosen target from the model's tool calls, as
        {'id': int, 'name': str, 'notes': str}, or None when no
        route_to call names a known target."""
        for call in toolCalls:
            if call.get('name', '') != DispatchRouting.TOOL_NAME:
                continue
            input_ = call.get('input')
            if not isinstance(input_, dict):
                arguments = call.get('arguments')
                input_ = arguments if isinstance(arguments, dict) else {}
            want = _strtolower(php_trim(php_strval(input_.get('target', ''))))
            for t in targets:
                if _strtolower(php_trim(t['name'])) == want:
                    return {
                        'id': t['id'],
                        'name': t['name'],
                        'notes': php_trim(php_strval(input_.get('notes', ''))),
                    }
        return None

    @staticmethod
    def skipSet(unchosenIds: list, edges: list) -> list:
        """Node ids to skip given the unchosen direct targets: those nodes plus,
        transitively, any node ALL of whose predecessors are skipped. A node
        fed by at least one live predecessor stays runnable. Ascending order."""
        skipped = {php_intval(x): True for x in unchosenIds}
        preds: dict[int, list] = {}
        for edge in edges:
            preds.setdefault(php_intval(edge.get('to_node_id')), []).append(php_intval(edge.get('from_node_id')))
        grew = True
        while grew:
            grew = False
            for nodeId, froms in preds.items():
                if nodeId in skipped:
                    continue
                allSkipped = all(p in skipped for p in froms)
                if allSkipped:
                    skipped[nodeId] = True
                    grew = True
        return sorted(skipped.keys())
