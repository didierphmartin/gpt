"""Port of backend/tests/Unit/Playbook/PlaybookInterpreterTest.php (247 lines, 3 cases)."""
from __future__ import annotations

import json

from app.playbook.playbook_action_space import PlaybookActionSpace
from app.playbook.playbook_document import PlaybookDocument
from app.playbook.playbook_interpreter import PlaybookInterpreter
from app.playbook.playbook_native_tools import PlaybookNativeTools
from app.playbook.playbook_transcript import PlaybookTranscript
from app.support.phpjson import dumps as _json_dumps
from tests.unit.playbook.fakes import FakeMcpExecutor


def _doc(policy=None):
    p = {'writes_enabled': True, 'on_unbound': 'prompt_handoff'}
    p.update(policy or {})
    return PlaybookDocument.fromArray({
        'title': 'Password Reset',
        'trigger': {'kind': 'request', 'description': 'user locked out'},
        'instructions': "Search for the user. Check their recent activity and factors. "
                         "Verify their identity with security questions. Reset the password and email them. "
                         "Tell the requester it is done. Stop when resolved.",
        'policy': p,
    })


def _actions():
    return [
        {'name': '#Search Okta User by Email', 'kind': 'bound', 'target': 'okta.search_users'},
        {'name': '#Search Okta System Log', 'kind': 'bound', 'target': 'okta.search_system_log'},
        {'name': '#List User Factors', 'kind': 'bound', 'target': 'okta.list_user_factors'},
        {'name': '#Verify Security Answers', 'kind': 'bound', 'target': 'okta.verify_security_answers'},
        {'name': '#Reset Okta Password', 'kind': 'bound', 'target': 'okta.reset_password'},
        {'name': '#Send Direct Message', 'kind': 'native', 'target': 'send_direct_message'},
        {'name': '#Leave Internal Note', 'kind': 'native', 'target': 'leave_internal_note'},
        {'name': '#Resolve Request', 'kind': 'native', 'target': 'resolve_request'},
    ]


def _space(pb_state, policy=None):
    mcp = FakeMcpExecutor()
    native = PlaybookNativeTools(pb_state)
    p = {'writes_enabled': True, 'on_unbound': 'prompt_handoff'}
    p.update(policy or {})
    space = PlaybookActionSpace(_actions(), native, mcp, pb_state, p)
    return space, mcp


def _scripted_llm(rounds):
    """@param rounds queue of rounds; each round is a list of tool calls
    (>1 entry = "parallel" tool_calls in one LLM turn)."""
    queue = list(rounds)
    counter = {'n': 0}
    captured = []

    def llm(messages, toolDefs):
        captured.append(messages)
        if not queue:
            return {'text': 'nothing left to do', 'tool_calls': []}
        round_ = queue.pop(0)
        toolCalls = []
        for call in round_:
            counter['n'] += 1
            toolCalls.append({
                'id': f"call_{counter['n']}",
                'name': call['name'],
                'arguments': call.get('arguments', {}),
            })
        return {'text': None, 'tool_calls': toolCalls}

    return llm, captured


def test_t_shaped_scenario_resolves_in_order_with_transcript_and_message_event(pb_state, pb_db, pb_dir):
    space, mcp = _space(pb_state)
    doc = _doc()
    id_ = pb_state.createRun(1, doc, {'id': 'req1'}, {})

    rounds = [
        [{'name': 'okta__search_users', 'arguments': {'email': 'a@b.com'}}],
        [
            {'name': 'okta__search_system_log', 'arguments': {'user_id': 'u1'}},
            {'name': 'okta__list_user_factors', 'arguments': {'user_id': 'u1'}},
        ],
        [{'name': 'okta__verify_security_answers', 'arguments': {'user_id': 'u1', 'answers': ['a', 'b']}}],
        [{'name': 'okta__reset_password', 'arguments': {'user_id': 'u1', 'send_email': True}}],
        [{'name': 'send_direct_message', 'arguments': {'text': 'Your password has been reset.', 'sensitive': True}}],
        [
            {'name': 'leave_internal_note', 'arguments': {'text': 'Reset password for u1 after verifying identity.'}},
            {'name': 'resolve_request', 'arguments': {'outcome': 'success', 'summary': 'Password reset and requester notified.'}},
        ],
    ]

    events = []

    def on_event(e):
        events.append(e)

    llm, captured = _scripted_llm(rounds)
    transcript = PlaybookTranscript(pb_dir)
    interpreter = PlaybookInterpreter(space, pb_state, transcript, llm, 40, on_event)

    result = interpreter.runLeg(id_, 0, doc, {}, {'id': 'req1'}, 'I am locked out of my account.')

    assert result['status'] == 'resolved'

    ledger = pb_state.ledgerAll(id_)
    toolSequence = [row['tool'] for row in ledger]
    assert toolSequence == [
        'okta.search_users',
        'okta.search_system_log',
        'okta.list_user_factors',
        'okta.verify_security_answers',
        'okta.reset_password',
        'send_direct_message',
        'leave_internal_note',
        'resolve_request',
    ]

    # send_email=true made it through to the reset args.
    resetRow = ledger[4]
    assert '"send_email":true' in resetRow['args']

    # Transcript: leg_started first, leg_ended last.
    events2 = transcript.read(id_)
    assert events2
    assert events2[0]['type'] == 'leg_started'
    assert events2[-1]['type'] == 'leg_ended'
    assert events2[1]['type'] == 'prompt'
    assert events2[1]['text'] == 'I am locked out of my account.'

    # onEvent 'message' fired with the REAL (unredacted) text, even though the
    # ledger/db copy is redacted because sensitive=true.
    messageEvents = [e for e in events if e['type'] == 'message']
    assert len(messageEvents) == 1
    assert messageEvents[0]['text'] == 'Your password has been reset.'
    assert messageEvents[0]['sensitive'] is True

    # DB copy of the message is redacted.
    row = pb_db.fetch_one('SELECT text, sensitive FROM playbook_run_messages WHERE run_id = ?', [id_])
    assert int(row['sensitive']) == 1
    assert 'Your password has been reset.' not in row['text']

    # System prompt is the verbatim constant with {instructions}/{policy_json}/
    # {requester_json}/{approvers_json} filled in.
    template = """You are a playbook interpreter for this organization. Execute the PLAYBOOK below
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
    expectedSystemPrompt = (
        template
        .replace('{instructions}', doc.instructions)
        .replace('{policy_json}', _json_dumps(doc.policy))
        .replace('{requester_json}', _json_dumps({'id': 'req1'}))
        .replace('{approvers_json}', '{}')
    )
    assert captured[0][0]['content'] == expectedSystemPrompt
    assert captured[0][0]['role'] == 'system'


def test_round_budget_exhaustion_marks_failed_and_leaves_note(pb_state, pb_db, pb_dir):
    space, mcp = _space(pb_state)
    doc = _doc()
    id_ = pb_state.createRun(1, doc, {'id': 'req1'}, {})

    # Always calls a (non-terminal) tool, never resolves.
    def llm(messages, toolDefs):
        return {
            'text': None,
            'tool_calls': [
                {'id': 'call_x', 'name': 'leave_internal_note', 'arguments': {'text': 'still working'}},
            ],
        }

    transcript = PlaybookTranscript(pb_dir)
    interpreter = PlaybookInterpreter(space, pb_state, transcript, llm, 2, None)

    result = interpreter.runLeg(id_, 0, doc, {}, {'id': 'req1'}, 'Help me.')

    assert result['status'] == 'failed'
    assert pb_state.getRun(id_)['status'] == 'failed'

    notes = pb_db.fetch_column('SELECT text FROM playbook_run_notes WHERE run_id = ? ORDER BY id ASC', [id_])
    # 2 rounds of "still working" plus a final exhaustion note.
    assert len(notes) == 3
    assert 'exhausted' in notes[2].lower()


def test_second_round_messages_include_first_round_tool_result(pb_state, pb_dir):
    space, mcp = _space(pb_state)
    doc = _doc()
    id_ = pb_state.createRun(1, doc, {'id': 'req1'}, {})

    rounds = [
        [{'name': 'okta__search_users', 'arguments': {'email': 'a@b.com'}}],
        [{'name': 'resolve_request', 'arguments': {'outcome': 'success', 'summary': 'done'}}],
    ]

    llm, captured = _scripted_llm(rounds)
    transcript = PlaybookTranscript(pb_dir)
    interpreter = PlaybookInterpreter(space, pb_state, transcript, llm, 40, None)

    result = interpreter.runLeg(id_, 0, doc, {}, {'id': 'req1'}, 'Find and help this user.')
    assert result['status'] == 'resolved'

    assert len(captured) == 2
    round2Messages = captured[1]

    # round 2 messages must include the assistant tool_calls message from round 1
    # and the resulting role:'tool' message carrying round 1's result JSON.
    roles = [m['role'] for m in round2Messages]
    assert 'assistant' in roles
    assert 'tool' in roles

    toolMessages = [m for m in round2Messages if m['role'] == 'tool']
    assert toolMessages
    decoded = json.loads(toolMessages[0]['content'])
    assert isinstance(decoded, dict)
    assert toolMessages[0]['name'] == 'okta__search_users'


# ---------------------------------------------------------------------------
# runLeg's `args = php_array_cast(toolCall.get('arguments'))` -- B3 (Phase 5
# final-review wave). PHP: `(array)($toolCall['arguments'] ?? [])`
# (PlaybookInterpreter.php:88). A `FakeSpace` (rather than the real
# PlaybookActionSpace/PlaybookNativeTools) records the exact `args` value
# `execute()` receives, sidestepping native-tool handlers that assume a
# dict shape downstream of this cast.
# ---------------------------------------------------------------------------

class _RecordingSpace:
    def __init__(self):
        self.calls = []

    def toolDefinitions(self):
        return []

    def execute(self, runId, leg, name, args):
        self.calls.append(args)
        return {'terminal': True}


def _run_one_call(pb_state, pb_dir, arguments):
    space = _RecordingSpace()
    doc = _doc()
    id_ = pb_state.createRun(1, doc, {'id': 'req1'}, {})
    rounds = [[{'name': 'anything', 'arguments': arguments}]]
    llm, _ = _scripted_llm(rounds)
    transcript = PlaybookTranscript(pb_dir)
    interpreter = PlaybookInterpreter(space, pb_state, transcript, llm, 40, None)
    interpreter.runLeg(id_, 0, doc, {}, {'id': 'req1'}, 'hi')
    return space.calls[0]


def test_run_leg_arguments_dict_passes_through_unchanged(pb_state, pb_dir):
    assert _run_one_call(pb_state, pb_dir, {'a': 1}) == {'a': 1}


def test_run_leg_arguments_none_casts_to_empty_list(pb_state, pb_dir):
    assert _run_one_call(pb_state, pb_dir, None) == []


def test_run_leg_arguments_scalar_casts_to_single_element_list(pb_state, pb_dir):
    assert _run_one_call(pb_state, pb_dir, 'oops') == ['oops']


def test_run_leg_arguments_list_passes_through_unchanged(pb_state, pb_dir):
    assert _run_one_call(pb_state, pb_dir, ['x', 'y']) == ['x', 'y']
