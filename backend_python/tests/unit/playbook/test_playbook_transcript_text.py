"""Port of backend/tests/Unit/Playbook/PlaybookTranscriptTextTest.php (51 lines, 1 case).

A playbook node hands the NEXT node the same story the run overlay shows:
tool calls with their outcome, the messages the playbook sent, the human
gates with their decision, and the final result/status — not just the
interpreter's last sentence.
"""
from __future__ import annotations

from app.agent_team.services.playbook_node_runner import PlaybookNodeRunner


def test_transcript_mirrors_the_overlay():
    events = [
        {'type': 'round', 'round': 1},
        {'type': 'tool_call', 'name': 'okta__lookup_users', 'args': {'email': 'a@b'}},
        {'type': 'tool_result', 'name': 'okta__lookup_users', 'result': {'ok': True, 'id': 'u-1'}},
        {'type': 'gate_request', 'kind': 'approval', 'payload': {'question': 'Approve PTO for Didier?', 'context': '5 days'}},
        # GateManager wraps the whole answer under 'decision' — the renderer must unwrap it.
        {'type': 'tool_result', 'name': 'request_approval', 'result': {'ok': True, 'decision': {'tool_call_id': 'x', 'decision': 'approved', 'comment': 'fine', 'actor': 'me'}}},
        {'type': 'message', 'text': "Hi Marcus,\nApproved."},
        {'type': 'message', 'text': 'secret', 'sensitive': True},
        {'type': 'tool_call', 'name': 'workday__submit_time_off', 'args': {}},
        {'type': 'tool_result', 'name': 'workday__submit_time_off', 'result': {'ok': False, 'error': 'boom'}},
        {'type': 'final', 'leg': 0, 'status': 'resolved'},
    ]
    t = PlaybookNodeRunner.renderTranscript('Time Off & Leave Requests', events, 'Request TO-1 submitted.', 41, 'resolved')

    assert '# Playbook: Time Off & Leave Requests' in t
    assert 'run 41' in t
    assert 'okta__lookup_users ✓' in t
    assert 'workday__submit_time_off ✗' in t
    assert 'Approval requested: Approve PTO for Didier?' in t
    assert '→ approved (fine)' in t
    assert 'tool_call_id' not in t
    assert "Hi Marcus,\n  Approved." in t  # message body indented under its bullet
    assert 'secret' not in t
    assert '(message redacted)' in t
    assert 'Request TO-1 submitted.' in t
    assert 'resolved' in t
    # chronological: lookup before approval before submit
    assert t.index('okta__lookup_users') < t.index('Approval requested')
    assert t.index('Approval requested') < t.index('workday__submit_time_off')
