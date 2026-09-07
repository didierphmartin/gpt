"""Port of backend/tests/Unit/Playbook/PlaybookNodeRunnerTest.php (133 lines, 2 cases).

Task 12: the server-side playbook node runner. Everything that would
otherwise hit MySQL or a real LLM provider is swapped for a fake via the
runner's constructor factories (llmFactory/mcpFactory/bridgeFactory/
pdoFactory) — see PlaybookNodeRunner's CONTROLLER RULING comment.
"""
from __future__ import annotations

from app.agent_team.services.playbook_node_runner import PlaybookNodeRunner
from tests.unit.playbook.conftest import make_sqlite_db
from tests.unit.playbook.fakes import FakeMcpExecutor, FakeNodeRunnerBridge


def _scripted_llm(rounds):
    queue = list(rounds)
    counter = {'n': 0}

    def llm(messages, toolDefs):
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

    return llm


def _simple_playbook():
    return {
        'title': 'Simple Resolve',
        'trigger': {'kind': 'request', 'description': 'test trigger'},
        'instructions': '#Send Direct Message to the requester, then #Leave Internal Note, then #Resolve Request.',
        'actions_used': ['#Send Direct Message', '#Leave Internal Note', '#Resolve Request'],
        'policy': {'writes_enabled': True},
    }


def test_t1_shaped_run_resolves():
    db = make_sqlite_db()
    emitted = []

    def emit(event):
        emitted.append(event)

    llm = _scripted_llm([
        [
            {'name': 'send_direct_message', 'arguments': {'text': 'All set.'}},
            {'name': 'leave_internal_note', 'arguments': {'text': 'Handled via test.'}},
            {'name': 'resolve_request', 'arguments': {'outcome': 'success', 'summary': 'done'}},
        ],
    ])

    runner = PlaybookNodeRunner(
        config={},
        llmFactory=lambda nodeConfig: llm,
        mcpFactory=lambda db_, userId: FakeMcpExecutor(),
        bridgeFactory=lambda emit_: FakeNodeRunnerBridge(emit_),
        pdoFactory=lambda: db,
    )

    result = runner.run(1, {'playbook': _simple_playbook()}, 'Please help me.', emit)

    assert result['status'] == 'resolved'
    assert isinstance(result['run_id'], int)
    assert f"[playbook run {result['run_id']}: resolved]" in result['output']

    row = db.fetch_one(f"SELECT status FROM playbook_runs WHERE id = {result['run_id']}")
    assert row['status'] == 'resolved'


def test_gate_request_emitted_and_approved_then_resolves():
    db = make_sqlite_db()
    emitted = []

    def emit(event):
        emitted.append(event)

    llm = _scripted_llm([
        [{'name': 'request_approval', 'arguments': {'approver': 'boss', 'question': 'OK to proceed?'}}],
        [
            {'name': 'leave_internal_note', 'arguments': {'text': 'Approved and handled.'}},
            {'name': 'resolve_request', 'arguments': {'outcome': 'success', 'summary': 'done'}},
        ],
    ])

    runner = PlaybookNodeRunner(
        config={},
        llmFactory=lambda nodeConfig: llm,
        mcpFactory=lambda db_, userId: FakeMcpExecutor(),
        bridgeFactory=lambda emit_: FakeNodeRunnerBridge(emit_),
        pdoFactory=lambda: db,
    )

    result = runner.run(1, {'playbook': _simple_playbook()}, 'Please help me.', emit)

    assert result['status'] == 'resolved'

    gateEvents = [e for e in emitted if e.get('type') == 'gate_request']
    assert len(gateEvents) == 1
    assert gateEvents[0]['kind'] == 'approval'
    assert gateEvents[0]['run_id'] == result['run_id']


# ---------------------------------------------------------------------------
# renderTranscript's gate_request 'reason' -- D1 (Phase 5 final-review wave).
# PHP `isset($p['reason'])`: False for an explicit JSON null, not just a
# missing key.
# ---------------------------------------------------------------------------

def _gate_request_event(payload):
    return {'type': 'gate_request', 'kind': 'approval', 'payload': payload}


def test_render_transcript_gate_reason_none_omits_the_dash_reason_suffix():
    out = PlaybookNodeRunner.renderTranscript(
        'T', [_gate_request_event({'team_or_person': 'Alice', 'reason': None})], '', 1, 'resolved')
    gate_line = next(line for line in out.splitlines() if line.startswith('- ✋'))
    assert gate_line == '- ✋ Approval requested: Alice'


def test_render_transcript_gate_reason_present_appends_the_dash_reason_suffix():
    out = PlaybookNodeRunner.renderTranscript(
        'T', [_gate_request_event({'team_or_person': 'Alice', 'reason': 'needs sign-off'})], '', 1, 'resolved')
    assert 'Alice — needs sign-off' in out
