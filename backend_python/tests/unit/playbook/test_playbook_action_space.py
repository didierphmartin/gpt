"""Port of backend/tests/Unit/Playbook/PlaybookActionSpaceTest.php (381 lines, 16 cases)."""
from __future__ import annotations

from app.playbook.gate_manager import GateManager
from app.playbook.playbook_action_space import PlaybookActionSpace
from app.playbook.playbook_document import PlaybookDocument
from app.playbook.playbook_native_tools import PlaybookNativeTools
from tests.unit.playbook.fakes import FakeGateBridge, FakeMcpExecutor


def _doc():
    return PlaybookDocument.fromArray({'title': 'T',
        'trigger': {'kind': 'request', 'description': 'd'}, 'instructions': '#Resolve Request.'})


def _actions():
    return [
        {'name': '#Search Okta User by Email', 'kind': 'bound', 'target': 'okta.search_users'},
        {'name': '#Reset Okta Password', 'kind': 'bound', 'target': 'okta.reset_password'},
        {'name': '#Reset User Factors Custom', 'kind': 'unbound', 'target': None},
        {'name': '#Resolve Request', 'kind': 'native', 'target': 'resolve_request'},
    ]


def _space(pb_state, actions, mcp, policy=None):
    native = PlaybookNativeTools(pb_state)
    p = {'writes_enabled': False, 'on_unbound': 'prompt_handoff'}
    p.update(policy or {})
    return PlaybookActionSpace(actions, native, mcp, pb_state, p)


def test_definitions_include_bound_and_unbound(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp)
    defs = space.toolDefinitions()
    names = [d['function']['name'] for d in defs]

    assert 'okta__search_users' in names
    assert 'unbound__reset_user_factors_custom' in names
    assert 'resolve_request' in names  # native tools still present

    searchDef = defs[names.index('okta__search_users')]
    assert '#Search Okta User by Email' in searchDef['function']['description']
    assert searchDef['function']['parameters']['properties'] == {'email': {'type': 'string'}}

    unboundDef = defs[names.index('unbound__reset_user_factors_custom')]
    assert 'NOT AVAILABLE' in unboundDef['function']['description']
    assert unboundDef['function']['parameters'] == {'type': 'object', 'properties': {}}


def test_whitelist_rejects_unknown_name(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp)
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'some_made_up_tool', {})
    assert result['ok'] is False

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'skipped'


def test_mcp_dispatch_maps_to_server_and_tool(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp)
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'okta__search_users', {'email': 'a@b.com'})
    assert result['ok'] is True
    assert len(mcp.calls) == 1
    assert mcp.calls[0]['server'] == 'okta'
    assert mcp.calls[0]['tool'] == 'search_users'
    assert mcp.calls[0]['args'] == {'email': 'a@b.com'}

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'ok'
    assert ledger[0]['tool'] == 'okta.search_users'


def test_replay_guard_avoids_second_mcp_call(pb_state):
    # Replay guard applies to write-classified tools only — reset_password
    # is a write (fails the read-verb allowlist), so it gets the guard.
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp, {'writes_enabled': True})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    first = space.execute(id_, 0, 'okta__reset_password', {'user_id': '123'})
    assert first['ok'] is True

    second = space.execute(id_, 1, 'okta__reset_password', {'user_id': '123'})
    assert second['ok'] is True
    assert second['outcome'] == 'replayed'

    # Fake recorded only ONE real call
    assert len(mcp.calls) == 1

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 2
    assert ledger[0]['outcome'] == 'ok'
    assert ledger[1]['outcome'] == 'replayed'


def test_read_tool_always_re_executes_no_replay_guard(pb_state):
    # okta.search_users matches the read allowlist (^search), so a repeated
    # call always re-executes rather than being served from the replay guard.
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp)
    id_ = pb_state.createRun(1, _doc(), {}, {})

    first = space.execute(id_, 0, 'okta__search_users', {'email': 'a@b.com'})
    assert first['ok'] is True

    second = space.execute(id_, 1, 'okta__search_users', {'email': 'a@b.com'})
    assert second['ok'] is True
    assert 'outcome' not in second

    # Both calls actually reached the MCP fake.
    assert len(mcp.calls) == 2

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 2
    assert ledger[0]['outcome'] == 'ok'
    assert ledger[1]['outcome'] == 'ok'


def test_write_policy_blocks_when_disabled(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp, {'writes_enabled': False})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'okta__reset_password', {'user_id': '123'})
    assert result['ok'] is False
    assert result['error'] == 'writes disabled by policy'
    assert len(mcp.calls) == 0

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'skipped'


def test_write_policy_allows_when_enabled(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp, {'writes_enabled': True})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'okta__reset_password', {'user_id': '123'})
    assert result['ok'] is True
    assert len(mcp.calls) == 1

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'ok'


def test_lookup_and_namespaced_list_classify_as_reads(pb_state):
    # Live run 38 regression: okta.lookup_users and
    # aws.iam_list_attached_user_policies are reads and must execute even
    # with writes disabled ('lookup' verb + one namespace token before a
    # read verb).
    mcp = FakeMcpExecutor()
    actions = _actions() + [
        {'name': '#Lookup Users', 'kind': 'bound', 'target': 'okta.lookup_users'},
        {'name': '#List IAM Policies', 'kind': 'bound', 'target': 'aws.iam_list_attached_user_policies'},
    ]
    space = _space(pb_state, actions, mcp, {'writes_enabled': False})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    assert space.execute(id_, 0, 'okta__lookup_users', {'email': 'a@b.com'})['ok'] is True
    assert space.execute(id_, 0, 'aws__iam_list_attached_user_policies', {'user_name': 'a'})['ok'] is True
    assert len(mcp.calls) == 2


def test_unrecognized_tool_name_fails_closed_as_write(pb_state):
    # okta.deactivate_user matches neither a write verb nor our read
    # allowlist — the fail-closed policy must still block it.
    mcp = FakeMcpExecutor()
    actions = _actions() + [
        {'name': '#Deactivate Okta User', 'kind': 'bound', 'target': 'okta.deactivate_user'},
    ]
    space = _space(pb_state, actions, mcp, {'writes_enabled': False})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'okta__deactivate_user', {'user_id': '123'})
    assert result['ok'] is False
    assert result['error'] == 'writes disabled by policy'
    assert len(mcp.calls) == 0

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'skipped'


def test_native_verb_executable_even_when_not_in_actions_used(pb_state):
    # Spec: native verbs are built-in and executable unconditionally — this
    # action list never mentions #Leave Internal Note, yet the LLM must
    # still be able to call it.
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp)
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'leave_internal_note', {'text': 'noted'})
    assert result['ok'] is True

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'ok'
    assert ledger[0]['tool'] == 'leave_internal_note'


def test_unbound_execute_returns_guidance(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp, {'on_unbound': 'prompt_handoff'})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'unbound__reset_user_factors_custom', {})
    assert result['ok'] is False
    assert result['unbound'] is True
    assert result['policy'] == 'prompt_handoff'
    assert 'hand off to a human' in result['guidance']

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'skipped'


def test_unbound_policy_skip_returns_skipped_guidance(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp, {'on_unbound': 'skip'})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'unbound__reset_user_factors_custom', {})
    assert result['ok'] is False
    assert result['unbound'] is True
    assert result['skipped'] is True
    assert 'skip it' in result['guidance']

    ledger = pb_state.ledgerAll(id_)
    assert ledger[0]['outcome'] == 'skipped'


def test_unbound_policy_fail_returns_fatal_guidance(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp, {'on_unbound': 'fail'})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'unbound__reset_user_factors_custom', {})
    assert result['ok'] is False
    assert result['unbound'] is True
    assert result['fatal'] is True
    assert 'fail' in result['guidance']

    # Ledger records the same 'skipped' outcome regardless of policy arm.
    ledger = pb_state.ledgerAll(id_)
    assert ledger[0]['outcome'] == 'skipped'


def test_native_tool_still_executes_through_action_space(pb_state):
    mcp = FakeMcpExecutor()
    space = _space(pb_state, _actions(), mcp)
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'resolve_request', {'outcome': 'success', 'summary': 'done'})
    assert result['ok'] is True

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'ok'
    assert ledger[0]['tool'] == 'resolve_request'


def test_native_verb_never_blocked_by_write_policy(pb_state):
    # Controller ruling: the write policy governs MCP/connector writes only. Native verbs
    # act on our own run record and must never be blocked, even with writes_enabled=false.
    mcp = FakeMcpExecutor()
    actions = _actions() + [
        {'name': '#Send Direct Message', 'kind': 'native', 'target': 'send_direct_message'},
    ]
    space = _space(pb_state, actions, mcp, {'writes_enabled': False})
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'send_direct_message', {'text': 'hello'})
    assert result['ok'] is True

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'ok'


def test_sensitive_native_args_are_redacted_in_ledger(pb_state):
    mcp = FakeMcpExecutor()
    actions = _actions() + [
        {'name': '#Send Direct Message', 'kind': 'native', 'target': 'send_direct_message'},
    ]
    space = _space(pb_state, actions, mcp)
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'send_direct_message', {
        'text': 'Secret token 12345',
        'sensitive': True,
    })
    assert result['ok'] is True

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert int(ledger[0]['sensitive']) == 1
    assert 'Secret token' not in ledger[0]['args']
    assert '«redacted»' in ledger[0]['args']
    assert ledger[0]['result_summary'] == '«redacted»'


def test_agent_bound_target_treated_as_unbound_for_now(pb_state):
    mcp = FakeMcpExecutor()
    actions = [
        {'name': '#Escalate to Triage Agent', 'kind': 'bound', 'target': 'agent.triage'},
    ]
    space = _space(pb_state, actions, mcp)
    defs = space.toolDefinitions()
    names = [d['function']['name'] for d in defs]
    assert 'unbound__escalate_to_triage_agent' in names

    id_ = pb_state.createRun(1, _doc(), {}, {})
    result = space.execute(id_, 0, 'unbound__escalate_to_triage_agent', {})
    assert result['ok'] is False
    assert result['unbound'] is True


def test_gate_timeout_is_ledgered_as_failed_not_ok(pb_state):
    mcp = FakeMcpExecutor()
    native = PlaybookNativeTools(pb_state)
    bridge = FakeGateBridge([])  # empty queue => ask() returns None (timeout)
    gates = GateManager(pb_state, bridge)
    space = PlaybookActionSpace(_actions(), native, mcp, pb_state, {
        'writes_enabled': False, 'on_unbound': 'prompt_handoff',
    }, gates)
    id_ = pb_state.createRun(1, _doc(), {}, {})

    result = space.execute(id_, 0, 'request_approval', {
        'approver': 'mgr', 'question': 'reset the password?',
    })

    assert result['ok'] is False
    assert result['timeout'] is True
    assert result['gate'] is True

    ledger = pb_state.ledgerAll(id_)
    assert len(ledger) == 1
    assert ledger[0]['outcome'] == 'failed'
    assert 'timeout' in ledger[0]['result_summary']
