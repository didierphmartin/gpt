"""Port of backend/tests/Unit/CodeNodeStepTest.php."""
from __future__ import annotations

from app.agent_team.services.code_node_step import CodeNodeStep

EDGES = [
    {'from_node_id': 1, 'to_node_id': 2, 'from_port': 'output_1'},
    {'from_node_id': 2, 'to_node_id': 3, 'from_port': 'output_1'},   # new_mail -> agent
    {'from_node_id': 3, 'to_node_id': 4, 'from_port': 'output_1'},   # agent -> output
]
NODES = {
    1: {'id': 1, 'node_type': 'start', 'config': {}},
    2: {'id': 2, 'node_type': 'code', 'config': {'name': 'Poll Outlook', 'exits': ['new_mail', 'no_mail', 'error']}},
    3: {'id': 3, 'node_type': 'agent', 'config': {'agent_name': 'Triage'}},
    4: {'id': 4, 'node_type': 'output', 'config': {}},
}


def test_parents_mirror_the_editor():
    p = CodeNodeStep.parents(2, EDGES, NODES, {1: {'type': 'start', 'output': 'go'}})
    assert p == [{'name': 'start', 'text': 'go', 'start': True}]
    assert CodeNodeStep.parents(2, EDGES, NODES, {1: {'output': ''}}) == []


def test_route_to_chosen_exit():
    data = {'exits': ['new_mail', 'no_mail', 'error'], 'exit_targets': {'new_mail': ['3'], 'no_mail': [], 'error': []}}
    r = CodeNodeStep.routeAfter(data, {'ok': True, 'route': 'new_mail', 'output_text': '{"id":"m1"}'}, [3])
    assert r == {'success': True, 'output': '{"id":"m1"}', 'exit': 'new_mail', 'chosen': [3], 'skip': []}
    r = CodeNodeStep.routeAfter(data, {'ok': True, 'route': 'no_mail', 'output_text': 'null'}, [3])
    assert r['chosen'] == []
    assert r['skip'] == [3]


def test_failed_run_skips_all_children():
    data = {'exits': ['next'], 'exit_targets': {'next': ['3']}}
    r = CodeNodeStep.routeAfter(data, {'ok': False, 'error': 'CodeNodeError: boom'}, [3])
    assert r['success'] is False
    assert r['output'] == 'Error: CodeNodeError: boom'
    assert r['skip'] == [3]


def _summarize(outputs, edges=EDGES, nodes=NODES):
    return CodeNodeStep.summarize(outputs, edges, nodes)


def test_quiet_and_drain():
    codeOnly = {1: {'type': 'start'}, 2: {'type': 'code', 'exit': 'no_mail', 'success': True}}
    assert _summarize(codeOnly) == {'quiet': True, 'drain': False}
    work = {1: {'type': 'start'}, 2: {'type': 'code', 'exit': 'new_mail', 'success': True},
            3: {'type': 'agent'}, 4: {'type': 'output'}}
    assert _summarize(work) == {'quiet': False, 'drain': True}
    plain = {1: {'type': 'start'}, 3: {'type': 'agent'}, 4: {'type': 'output'}}
    assert _summarize(plain) == {'quiet': False, 'drain': False}


def test_work_beside_the_poll_does_not_drain():
    # Start -> Poll(2) and Start -> Agent(5) in parallel; the poll found no mail.
    edges = EDGES + [{'from_node_id': 1, 'to_node_id': 5, 'from_port': 'output_1'}]
    nodes = {**NODES, 5: {'id': 5, 'node_type': 'agent', 'config': {'agent_name': 'Beside'}}}
    out = {1: {'type': 'start'}, 2: {'type': 'code', 'exit': 'no_mail', 'success': True}, 5: {'type': 'agent'}}
    assert _summarize(out, edges, nodes) == {'quiet': False, 'drain': False}
    # The same graph when the poll found mail: the agent behind new_mail drains.
    out = {1: {'type': 'start'}, 2: {'type': 'code', 'exit': 'new_mail', 'success': True},
           5: {'type': 'agent'}, 3: {'type': 'agent'}, 4: {'type': 'output'}}
    assert _summarize(out, edges, nodes) == {'quiet': False, 'drain': True}


def test_a_code_node_that_took_no_exit_did_not_run():
    # A disabled code node: the generic sentinel, no exit taken. Neither quiet nor drain.
    disabled = {1: {'type': 'start'}, 2: {'type': 'code', 'output': 'disabled node', 'success': True}}
    assert _summarize(disabled) == {'quiet': False, 'drain': False}
    disabledThenWork = {**disabled, 3: {'type': 'agent'}, 4: {'type': 'output'}}
    assert _summarize(disabledThenWork) == {'quiet': False, 'drain': False}


def test_error_exit_is_never_quiet_and_does_not_drain():
    errored = {1: {'type': 'start'}, 2: {'type': 'code', 'exit': 'error'}}
    assert _summarize(errored) == {'quiet': False, 'drain': False}
    failed = {1: {'type': 'start'}, 2: {'type': 'code', 'success': False}}
    assert _summarize(failed) == {'quiet': False, 'drain': False}
    erroredThenWork = {**errored, 3: {'type': 'agent'}}
    assert _summarize(erroredThenWork) == {'quiet': False, 'drain': False}


def test_error_exit_reason_is_one_bounded_line():
    # Parity with the compiled ErrorExitTaken.reason: whitespace collapsed, cut at 200 characters (…).
    assert CodeNodeStep.reason("  mailbox down:\n\t retry   later \n") == 'mailbox down: retry later'
    assert CodeNodeStep.reason('é' * 250) == 'é' * 200 + '…'
    assert CodeNodeStep.reason('a' * 200) == 'a' * 200


def test_empty_agent_name_falls_through_to_name():
    nodes = {3: {'config': {'agent_name': '', 'name': 'Triage'}}, 2: NODES[2]}
    edges = [{'from_node_id': 3, 'to_node_id': 2, 'from_port': 'output_1'}]
    p = CodeNodeStep.parents(2, edges, nodes, {3: {'output': 'x'}})
    assert p[0]['name'] == 'Triage'


def test_a_dispatcher_parent_passes_on_what_it_received():
    # Start(1) -> Poll(4) -> dispatcher(3) -> claims(2): the branch gets the email, not the framed context.
    nodes = {1: {'node_type': 'start', 'config': {}}, 4: {'node_type': 'code', 'config': {'name': 'Poll'}},
             3: {'node_type': 'agent', 'config': {'agent_name': 'triage'}}, 2: NODES[2]}
    edges = [{'from_node_id': 1, 'to_node_id': 4}, {'from_node_id': 4, 'to_node_id': 3},
             {'from_node_id': 3, 'to_node_id': 2}]
    outputs = {1: {'output': 'poll'}, 4: {'type': 'code', 'output': '{"id":"m1"}'},
               3: {'type': 'agent', 'output': '### Input from: Poll\n{"id":"m1"}', 'route': {'id': 2, 'name': 'claims'}}}
    assert CodeNodeStep.parents(2, edges, nodes, outputs) == [{'name': 'Poll', 'text': '{"id":"m1"}', 'start': False}]


def test_error_exits_name_each_code_node():
    """errorExits (GraphWorkflowRunnerCodeNodeTest's error_message line), unit-level."""
    outputs = {2: {'type': 'code', 'exit': 'error', 'output': "mailbox\n down"}, 3: {'type': 'code', 'exit': 'ok'}}
    nodes = {2: {'config': {'name': 'Poll'}}, 3: {'config': {}}}
    assert CodeNodeStep.errorExits(outputs, nodes) == ["code node 'Poll' took its error exit: mailbox down"]
    assert CodeNodeStep.errorExits({2: {'type': 'code', 'exit': 'error', 'output': ''}}, {2: {'config': {}}}) == \
        ["code node 'Code' took its error exit"]
