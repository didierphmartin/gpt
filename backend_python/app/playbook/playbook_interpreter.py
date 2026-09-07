"""Port of backend/src/Playbook/PlaybookInterpreter.php (205 lines).

The A' interpreter loop: the LLM re-decides each round from the running
transcript of tool calls/results — there is no pre-computed action queue.
Each round: call the LLM with the current messages + tool defs; execute any
tool calls it asks for through the PlaybookActionSpace; append the results to
the message history; repeat until the LLM stops calling tools, a result is
terminal (resolve_request) / gate_ended_leg (Task 8), or the round budget is
exhausted.
"""
from __future__ import annotations

from typing import Callable, Optional

from app.support.phpcompat import php_array_cast, php_uniqid
from app.support.phpjson import dumps as _json_dumps

_SYSTEM_PROMPT_TEMPLATE = """You are a playbook interpreter for {domain}. Execute the PLAYBOOK below
for the current REQUEST, step by step, using ONLY the tools provided.
Rules:
- Never invent tool results, user input, or tools. If information from the requester
  is missing, you must obtain it through the provided tools; if an action has no
  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.
- Take parameters for later steps from earlier tool results.
- When the playbook says Stop or the work is complete, call resolve_request.
- Record what you did with leave_internal_note before resolving, as the playbook asks.
PLAYBOOK:
{instructions}
POLICY: {policy_json}
REQUESTER: {requester_json}
APPROVERS: {approvers_json}"""

_MESSAGE_TOOL_NAMES = ('send_direct_message', 'send_channel_message', 'send_email')


class PlaybookInterpreter:
    def __init__(self, space, state, transcript, llm: Callable, maxRounds: int = 40, onEvent: Optional[Callable] = None):
        self.space = space
        self.state = state
        self.transcript = transcript
        self.llm = llm
        self.maxRounds = maxRounds
        self.onEvent = onEvent

    def runLeg(self, runId: int, leg: int, doc, variables: dict, requester: dict, requestText: str) -> dict:
        toolDefs = self.space.toolDefinitions()

        messages = [
            {'role': 'system', 'content': self._buildSystemPrompt(doc, requester)},
            {'role': 'user', 'content': self._buildUserMessage(requestText, variables)},
        ]

        self.transcript.append(runId, {'type': 'leg_started', 'leg': leg})
        self.transcript.append(runId, {'type': 'prompt', 'leg': leg, 'text': requestText})

        for round_ in range(1, self.maxRounds + 1):
            self._emit({'type': 'round', 'leg': leg, 'round': round_})

            response = self.llm(messages, toolDefs)
            text = response.get('text')
            toolCalls = response.get('tool_calls') or []

            if not toolCalls:
                return self._endLeg(runId, leg, self._currentStatus(runId), text if text is not None else '')

            # Normalize once so the assistant message and its matching tool-result
            # message(s) below always agree on the same id, even if the LLM
            # closure omitted one (defensive — the real WorkflowLlmClient path
            # always supplies one via normalizeToolCalls()).
            toolCalls = list(toolCalls)
            for i, toolCall in enumerate(toolCalls):
                if 'id' not in toolCall:
                    toolCalls[i] = {**toolCall, 'id': php_uniqid('tc_')}

            messages.append(self._buildAssistantMessage(text, toolCalls))

            terminal = False
            for toolCall in toolCalls:
                name = str(toolCall['name'])
                # PHP: `(array)($toolCall['arguments'] ?? [])` (PlaybookInterpreter.php:88).
                args = php_array_cast(toolCall.get('arguments'))

                self.transcript.append(runId, {
                    'type': 'tool_call', 'leg': leg, 'round': round_, 'name': name, 'args': args,
                })
                self._emit({'type': 'tool_call', 'leg': leg, 'round': round_, 'name': name, 'args': args})

                if name in _MESSAGE_TOOL_NAMES:
                    # Live delivery gets the real text; only the DB copy (written by
                    # PlaybookNativeTools via the ActionSpace) is redacted when sensitive.
                    self._emit({
                        'type': 'message',
                        'text': str(args.get('text')) if args.get('text') is not None else '',
                        'sensitive': bool(args.get('sensitive', False)),
                    })

                result = self.space.execute(runId, leg, name, args)

                self.transcript.append(runId, {
                    'type': 'tool_result', 'leg': leg, 'round': round_, 'name': name, 'result': result,
                })
                self._emit({'type': 'tool_result', 'leg': leg, 'round': round_, 'name': name, 'result': result})

                messages.append({
                    'role': 'tool',
                    'tool_call_id': toolCall.get('id') if toolCall.get('id') is not None else php_uniqid('tc_'),
                    'name': name,
                    'content': _json_dumps(result),
                })

                if result.get('terminal') is True or result.get('gate_ended_leg') is True:
                    terminal = True

            if terminal:
                return self._endLeg(runId, leg, self._currentStatus(runId), text if text is not None else '')

        # Round budget exhausted.
        self.state.setStatus(runId, 'failed')
        self.space.execute(runId, leg, 'leave_internal_note', {
            'text': f'Round budget of {self.maxRounds} exhausted without resolving the request.',
        })
        return self._endLeg(runId, leg, 'failed', '')

    def _endLeg(self, runId: int, leg: int, status: str, output: str) -> dict:
        self.transcript.append(runId, {'type': 'leg_ended', 'leg': leg, 'status': status})
        self._emit({'type': 'final', 'leg': leg, 'status': status, 'text': output})
        return {'status': status, 'output': output}

    def _currentStatus(self, runId: int) -> str:
        run = self.state.getRun(runId)
        return str(run.get('status')) if run.get('status') is not None else 'failed'

    def _buildAssistantMessage(self, text: Optional[str], toolCalls: list) -> dict:
        calls = []
        for toolCall in toolCalls:
            calls.append({
                'id': toolCall.get('id') if toolCall.get('id') is not None else php_uniqid('tc_'),
                'type': 'function',
                'function': {
                    'name': toolCall['name'],
                    # PHP: `(array)($toolCall['arguments'] ?? [])` (PlaybookInterpreter.php:159-160) —
                    # a scalar/None argument casts to a wrapped/empty array, not silently to {}.
                    'arguments': _json_dumps(php_array_cast(toolCall.get('arguments'))),
                },
            })
        return {'role': 'assistant', 'content': text, 'tool_calls': calls}

    def _buildSystemPrompt(self, doc, requester: dict) -> str:
        # Domain is configurable (general-purpose interpreter): document field
        # 'domain' / 'Domain:' line, neutral default.
        policyJson = _json_dumps(doc.policy)
        requesterJson = _json_dumps(requester)
        # Empty object, not [], when the document has no approvers — {} reads
        # unambiguously to the model as "none", where [] could be misread as
        # a list placeholder still to be filled in.
        approversJson = '{}' if not doc.approvers else _json_dumps(doc.approvers)
        out = _SYSTEM_PROMPT_TEMPLATE
        out = out.replace('{domain}', doc.domain if doc.domain != '' else 'this organization')
        out = out.replace('{instructions}', doc.instructions)
        out = out.replace('{policy_json}', policyJson)
        out = out.replace('{requester_json}', requesterJson)
        out = out.replace('{approvers_json}', approversJson)
        return out

    def _buildUserMessage(self, requestText: str, variables: dict) -> str:
        lines = ['REQUEST:', requestText]
        if variables:
            lines.append('VARIABLES: ' + _json_dumps(variables))
        return "\n".join(lines)

    def _emit(self, event: dict) -> None:
        if self.onEvent is not None:
            self.onEvent(event)
