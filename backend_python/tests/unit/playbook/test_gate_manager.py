"""Port of backend/tests/Unit/Playbook/GateManagerTest.php (198 lines, 4 cases)."""
from __future__ import annotations

import json

from app.playbook.gate_manager import GateManager
from app.playbook.playbook_action_space import PlaybookActionSpace
from app.playbook.playbook_document import PlaybookDocument
from app.playbook.playbook_interpreter import PlaybookInterpreter
from app.playbook.playbook_native_tools import PlaybookNativeTools
from app.playbook.playbook_transcript import PlaybookTranscript
from tests.unit.playbook.fakes import FakeGateBridge, FakeMcpExecutor


def _doc():
    return PlaybookDocument.fromArray({
        'title': 'T',
        'trigger': {'kind': 'request', 'description': 'd'},
        'instructions': 'Ask for approval, then reset the password. Stop when resolved.',
        'policy': {'writes_enabled': True, 'on_unbound': 'prompt_handoff'},
    })


def _gate_row(pb_db, gateId):
    return pb_db.fetch_one('SELECT * FROM playbook_run_gates WHERE id = ?', [gateId])


def _last_gate_id(pb_db, runId):
    return pb_db.fetch_column('SELECT MAX(id) FROM playbook_run_gates WHERE run_id = ?', [runId])[0]


# ---------------------------------------------------------------------------
# redactSensitiveFields -- B3 (Phase 5 final-review wave). PHP:
# `(array)($args['fields'] ?? [])` (GateManager.php:152).
# ---------------------------------------------------------------------------

def test_redact_sensitive_fields_dict_args_redacts_matching_keys():
    decision = {'ssn': '123-45-6789', 'ok': True}
    args = {'fields': [{'name': 'ssn', 'sensitive': True}]}
    out = GateManager.redactSensitiveFields(args, decision)
    assert out == {'ssn': GateManager.REDACTED, 'ok': True}
    assert decision == {'ssn': '123-45-6789', 'ok': True}  # caller's copy untouched


def test_redact_sensitive_fields_none_fields_is_a_no_op():
    decision = {'a': 1}
    assert GateManager.redactSensitiveFields({}, decision) == decision


def test_redact_sensitive_fields_scalar_fields_casts_to_single_element_list_and_is_a_no_op():
    # (array)"oops" -> ["oops"]; not a dict, so the sensitive-field scan finds
    # nothing -- must not raise iterating characters of the string.
    decision = {'a': 1}
    assert GateManager.redactSensitiveFields({'fields': 'oops'}, decision) == decision


def test_redact_sensitive_fields_list_fields_passes_through_unchanged():
    decision = {'a': 1, 'b': 2}
    args = {'fields': [{'name': 'a', 'sensitive': True}, {'name': 'b', 'sensitive': False}]}
    out = GateManager.redactSensitiveFields(args, decision)
    assert out == {'a': GateManager.REDACTED, 'b': 2}


def test_approval_approved_transitions_status_and_closes_gate_with_actor(pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {'id': 'req1'}, {})
    answer = {'decision': 'approved', 'comment': 'looks fine', 'actor': 'mgr@example.com'}

    statusDuringAsk = {}

    def on_ask(runId, kind, payload):
        statusDuringAsk['status'] = pb_state.getRun(id_)['status']

    bridge = FakeGateBridge([answer], on_ask)
    gm = GateManager(pb_state, bridge)

    result = gm.execute(id_, 0, 'request_approval', {
        'approver': 'mgr', 'question': 'reset the password?', 'context': 'locked out',
    })

    assert result == {'ok': True, 'decision': answer}
    assert statusDuringAsk['status'] == 'awaiting_approval'
    assert pb_state.getRun(id_)['status'] == 'running'

    row = _gate_row(pb_db, _last_gate_id(pb_db, id_))
    assert row['kind'] == 'approval'
    assert row['asked_of'] == 'approver'
    assert row['closed_at'] is not None
    assert row['actor'] == 'mgr@example.com'
    assert json.loads(row['decision']) == answer


def test_approval_timeout_returns_timeout_guidance_and_closes_gate(pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {'id': 'req1'}, {})
    bridge = FakeGateBridge([])  # empty queue => ask() returns None
    gm = GateManager(pb_state, bridge)

    result = gm.execute(id_, 0, 'request_approval', {
        'approver': 'mgr', 'question': 'reset the password?',
    })

    assert result == {
        'ok': False,
        'timeout': True,
        'guidance': 'No human answered in time. Leave an internal note and resolve as uncompleted.',
    }

    row = _gate_row(pb_db, _last_gate_id(pb_db, id_))
    assert row['closed_at'] is not None
    assert json.loads(row['decision']) == {'decision': 'timeout'}
    assert pb_state.getRun(id_)['status'] == 'running'


def test_sensitive_form_field_is_redacted_in_stored_decision_but_intact_in_return(pb_state, pb_db):
    id_ = pb_state.createRun(1, _doc(), {'id': 'req1'}, {})
    answer = {'password': 'hunter2', 'username': 'bob', 'actor': 'req1'}
    bridge = FakeGateBridge([answer])
    gm = GateManager(pb_state, bridge)

    args = {
        'prompt': 'Set your new password',
        'fields': [
            {'name': 'password', 'label': 'New password', 'type': 'text', 'sensitive': True},
            {'name': 'username', 'label': 'Username', 'type': 'text'},
        ],
    }

    result = gm.execute(id_, 0, 'trigger_form', args)

    # Returned to the caller verbatim.
    assert result['decision'] == answer
    assert result['decision']['password'] == 'hunter2'

    # Stored decision has the sensitive field redacted; other fields intact.
    row = _gate_row(pb_db, _last_gate_id(pb_db, id_))
    stored = json.loads(row['decision'])
    assert stored['password'] == GateManager.REDACTED
    assert stored['username'] == 'bob'


# --- Interpreter-level: request_approval then, after 'approved', okta__reset_password ---

def _scripted_llm(rounds):
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


def test_interpreter_runs_approval_gate_before_reset_and_feeds_decision_forward(pb_state, pb_dir):
    mcp = FakeMcpExecutor()
    native = PlaybookNativeTools(pb_state)
    bridge = FakeGateBridge([
        {'decision': 'approved', 'comment': 'go ahead', 'actor': 'mgr@example.com'},
    ])
    gates = GateManager(pb_state, bridge)

    actions = [
        {'name': '#Reset Okta Password', 'kind': 'bound', 'target': 'okta.reset_password'},
        {'name': '#Resolve Request', 'kind': 'native', 'target': 'resolve_request'},
    ]
    space = PlaybookActionSpace(actions, native, mcp, pb_state, {
        'writes_enabled': True, 'on_unbound': 'prompt_handoff',
    }, gates)

    doc = _doc()
    id_ = pb_state.createRun(1, doc, {'id': 'req1'}, {})

    rounds = [
        [{'name': 'request_approval', 'arguments': {'approver': 'mgr', 'question': 'reset password for u1?'}}],
        [{'name': 'okta__reset_password', 'arguments': {'user_id': 'u1'}}],
        [{'name': 'resolve_request', 'arguments': {'outcome': 'success', 'summary': 'reset after approval'}}],
    ]

    llm, captured = _scripted_llm(rounds)
    transcript = PlaybookTranscript(pb_dir)
    interpreter = PlaybookInterpreter(space, pb_state, transcript, llm, 40, None)

    result = interpreter.runLeg(id_, 0, doc, {}, {'id': 'req1'}, 'Reset u1 password, needs approval first.')

    assert result['status'] == 'resolved'

    # Gate ran before the reset, in the order the LLM asked for them.
    ledger = pb_state.ledgerAll(id_)
    toolSequence = [row['tool'] for row in ledger]
    assert toolSequence == ['request_approval', 'okta.reset_password', 'resolve_request']
    assert ledger[0]['outcome'] == 'ok'

    # The gate result did not end the leg (v1 immediate-mode contract): the loop
    # carried straight on into the reset, no 'gate_ended_leg' short-circuit.
    assert len(captured) == 3

    # Round 2 (post-gate) messages must carry the approval decision forward as the
    # tool result the LLM sees before it calls okta__reset_password.
    round2Messages = captured[1]
    toolMessages = [m for m in round2Messages if m['role'] == 'tool' and m['name'] == 'request_approval']
    assert toolMessages
    decoded = json.loads(toolMessages[0]['content'])
    assert decoded['ok'] is True
    assert decoded['gate'] is True
    assert decoded['decision']['decision'] == 'approved'
    assert decoded['decision']['actor'] == 'mgr@example.com'
