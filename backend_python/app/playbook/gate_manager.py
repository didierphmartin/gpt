"""Port of backend/src/Playbook/GateManager.php (169 lines).

Immediate-mode human gates (slice 1b): trigger_form / request_approval /
prompt_handoff / await_message. execute() opens a playbook_run_gates row,
moves the run into the matching waiting status, blocks on the bridge, then
closes the row and returns the run to 'running' before handing the decision
back to the interpreter loop as an ordinary tool result.
"""
from __future__ import annotations

from app.playbook.gate_bridge_interface import GateBridgeInterface
from app.playbook.playbook_run_state import PlaybookRunState
from app.support.phpcompat import php_array_cast


class GateManager:
    REDACTED = '«redacted»'

    _KIND_MAP = {
        'trigger_form': {'kind': 'form', 'asked_of': 'requester', 'status': 'awaiting_requester'},
        'request_approval': {'kind': 'approval', 'asked_of': 'approver', 'status': 'awaiting_approval'},
        'prompt_handoff': {'kind': 'handoff', 'asked_of': 'operator', 'status': 'handed_off'},
        'await_message': {'kind': 'await_message', 'asked_of': 'requester', 'status': 'awaiting_requester'},
    }

    def __init__(self, state: PlaybookRunState, bridge: GateBridgeInterface, timeoutMs: int = 900000):
        self.state = state
        self.bridge = bridge
        self.timeoutMs = timeoutMs

    def definitions(self) -> list:
        """PHP 29-108."""
        return [
            {
                'type': 'function',
                'function': {
                    'name': 'trigger_form',
                    'description': 'Present a form to the requester and wait for it to be submitted',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'prompt': {'type': 'string', 'description': 'Instructions shown above the form'},
                            'fields': {
                                'type': 'array',
                                'description': 'Form fields to collect',
                                'items': {
                                    'type': 'object',
                                    'properties': {
                                        'name': {'type': 'string'},
                                        'label': {'type': 'string'},
                                        'type': {'type': 'string'},
                                        'options': {'type': 'array', 'items': {'type': 'string'}},
                                        'sensitive': {'type': 'boolean', 'description': "Redact this field's value when stored"},
                                    },
                                    'required': ['name', 'label', 'type'],
                                },
                            },
                        },
                        'required': ['prompt', 'fields'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'request_approval',
                    'description': 'Ask an approver to approve or deny an action and wait for their decision',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'approver': {'type': 'string', 'description': 'Who must approve'},
                            'question': {'type': 'string', 'description': 'What is being approved'},
                            'context': {'type': 'string', 'description': 'Supporting context for the decision'},
                        },
                        'required': ['approver', 'question'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'prompt_handoff',
                    'description': 'Hand off to a human team or person and wait for their response',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'team_or_person': {'type': 'string', 'description': 'Who to hand off to'},
                            'reason': {'type': 'string', 'description': 'Why this needs a human'},
                            'summary': {'type': 'string', 'description': 'Summary of the situation so far'},
                        },
                        'required': ['team_or_person', 'reason'],
                    },
                },
            },
            {
                'type': 'function',
                'function': {
                    'name': 'await_message',
                    'description': 'Wait for a message from the requester before continuing',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'prompt': {'type': 'string', 'description': 'What to wait for'},
                        },
                        'required': ['prompt'],
                    },
                },
            },
        ]

    def execute(self, runId: int, leg: int, name: str, args: dict) -> dict:
        """PHP 110-142."""
        mapping = self._KIND_MAP.get(name)
        if mapping is None:
            return {'ok': False, 'error': f'Unknown gate: {name}'}

        gateId = self.state.gateOpen(runId, leg, mapping['kind'], args, mapping['asked_of'])
        self.state.setStatus(runId, mapping['status'])

        # Human gates can block for minutes; the remote DB drops idle
        # connections long before that. Drop ours on purpose and let the
        # post-gate writes reconnect fresh (PlaybookRunState.disconnect()).
        self.state.disconnect()

        answer = self.bridge.ask(runId, mapping['kind'], args, self.timeoutMs)

        if answer is None:
            self.state.gateClose(gateId, {'decision': 'timeout'}, '')
            self.state.setStatus(runId, 'running')
            return {
                'ok': False,
                'timeout': True,
                'guidance': 'No human answered in time. Leave an internal note and resolve as uncompleted.',
            }

        actor = answer.get('actor') if answer.get('actor') is not None else ''
        self.state.gateClose(gateId, self.redactSensitiveFields(args, answer), str(actor))
        self.state.setStatus(runId, 'running')

        return {'ok': True, 'decision': answer}

    @staticmethod
    def redactSensitiveFields(args: dict, decision: dict) -> dict:
        """Replace values of any `fields[].sensitive === true` name inside
        decision with the redaction marker. Used both for what GateManager
        stores and for what PlaybookActionSpace ledgers — the caller always
        still gets `decision` verbatim. PHP 149-168."""
        # PHP: `(array)($args['fields'] ?? [])` (GateManager.php:152) -- a
        # scalar `fields` value casts to a single-element array, not the
        # PHP-`empty()`-style `or []` fallback this used to reproduce.
        sensitiveNames = []
        for field in php_array_cast(args.get('fields')):
            if isinstance(field, dict) and field.get('sensitive'):
                sensitiveNames.append(field.get('name') if field.get('name') is not None else '')
        if not sensitiveNames:
            return decision

        redacted = dict(decision)
        for fieldName in sensitiveNames:
            if fieldName in redacted:
                redacted[fieldName] = GateManager.REDACTED
        return redacted
