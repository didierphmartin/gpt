"""Ports of backend/tests/Unit/LiveFeedTest.php, LiveStreamTest.php and StartOptionGraphTest.php."""
from __future__ import annotations

import pytest

from app.agent_team.services.live_feed import LiveFeed, LiveStream
from app.agent_team.services.start_option_graph import StartOptionGraph
from app.agent_team.services.workflow_run_log import WorkflowRunLog

A = 'a' * 32
B = 'b' * 32


@pytest.fixture
def log(tmp_path):
    return WorkflowRunLog(str(tmp_path))


def append(log, id, types):
    """A bare node_start/node_complete stands for a work node's event; a dict is appended as given."""
    for t in types:
        log.append(id, t if isinstance(t, dict) else (
            {'type': t, 'node_id': 2598, 'node_type': 'agent', 'drawflow_id': '18'}
            if t in ('node_start', 'node_complete') else {'type': t}))


def start_run(log, id, types):
    log.markCurrent(64, id)
    append(log, id, types)


def quiet():
    """What a quiet poll writes before its .jsonl is unlinked: Start, then the Start option's trigger node."""
    return [
        {'type': 'workflow_start', 'workflow_id': 64},
        {'type': 'node_start', 'node_id': 2597, 'node_type': 'start', 'drawflow_id': '17'},
        {'type': 'node_complete', 'node_id': 2597, 'node_type': 'start', 'drawflow_id': '17'},
        {'type': 'node_start', 'node_id': '1000002597', 'node_type': 'code', 'drawflow_id': None},
        {'type': 'node_log', 'node_id': '1000002597', 'message': 'outlook.poll_new_mail ok=true (218 ms)'},
        {'type': 'node_complete', 'node_id': '1000002597', 'node_type': 'code', 'drawflow_id': None},
    ]


def types(r):
    return [e['type'] for e in r['events']]


def test_the_pointer_names_the_latest_run(log):
    assert log.current(64) is None
    log.markCurrent(64, A)
    log.markCurrent(64, B)
    assert log.current(64) == B
    assert log.current(65) is None


def test_no_pointer_no_events(log):
    assert LiveFeed.next(log, 64, None) == {'events': [], 'cursor': None}


def test_first_connect_skips_a_finished_run(log):
    start_run(log, A, ['workflow_start', 'node_start', 'workflow_complete'])
    r = LiveFeed.next(log, 64, None)
    assert r['events'] == []
    assert r['cursor'] == A + ':3'


def test_first_connect_replays_a_run_in_progress(log):
    start_run(log, A, ['workflow_start', 'node_start'])
    r = LiveFeed.next(log, 64, None)
    assert types(r) == ['workflow_start', 'node_start']
    assert r['cursor'] == A + ':2'


def test_follows_the_lines_after_the_cursor(log):
    start_run(log, A, ['workflow_start', 'node_start'])
    log.append(A, {'type': 'node_complete'})
    r = LiveFeed.next(log, 64, A + ':2')
    assert types(r) == ['node_complete']
    assert r['cursor'] == A + ':3'
    assert LiveFeed.next(log, 64, r['cursor'])['events'] == []


def test_a_new_run_is_read_from_the_start(log):
    start_run(log, A, ['workflow_start', 'workflow_complete'])
    start_run(log, B, ['workflow_start', 'node_start', 'workflow_complete'])
    r = LiveFeed.next(log, 64, A + ':2')
    assert types(r) == ['workflow_start', 'node_start', 'workflow_complete']
    assert r['cursor'] == B + ':3'


def test_a_failed_run_is_finished(log):
    start_run(log, A, ['workflow_start', 'workflow_error'])
    assert LiveFeed.next(log, 64, None)['events'] == []


def test_a_deleted_quiet_run_is_skipped(log):
    start_run(log, A, ['workflow_start', 'workflow_complete'])
    log.markCurrent(64, B)   # its .jsonl was never kept (a quiet poll)
    assert LiveFeed.next(log, 64, A + ':2') == {'events': [], 'cursor': A + ':2'}


def test_a_partial_last_line_waits(log):
    start_run(log, A, ['workflow_start', 'node_start'])
    with open(log.pathFor(A), 'a', encoding='utf-8') as fh:
        fh.write('{"type":"node_co')
    r = LiveFeed.next(log, 64, None)
    assert types(r) == ['workflow_start', 'node_start']
    assert r['cursor'] == A + ':2'


def test_a_bad_cursor_counts_as_a_first_connect(log):
    start_run(log, A, ['workflow_start', 'node_start'])
    assert types(LiveFeed.next(log, 64, 'nonsense')) == ['workflow_start', 'node_start']


def test_a_quiet_run_is_held_back(log):
    start_run(log, A, ['workflow_start', 'node_start', 'workflow_complete'])
    start_run(log, B, quiet())
    assert LiveFeed.next(log, 64, A + ':3') == {'events': [], 'cursor': A + ':3'}
    assert LiveFeed.next(log, 64, None) == {'events': [], 'cursor': None}


def test_a_held_back_run_is_returned_from_its_first_line_once_a_work_node_runs(log):
    start_run(log, A, ['workflow_start', 'node_start', 'workflow_complete'])
    start_run(log, B, quiet())
    LiveFeed.next(log, 64, A + ':3')
    append(log, B, ['node_start'])
    r = LiveFeed.next(log, 64, A + ':3')
    assert len(r['events']) == 7
    assert r['events'][0]['type'] == 'workflow_start'
    assert r['events'][6]['node_id'] == 2598
    assert r['cursor'] == B + ':7'


def test_a_run_that_fails_after_the_trigger_is_returned(log):
    start_run(log, A, ['workflow_start', 'node_start', 'workflow_complete'])
    start_run(log, B, quiet())
    append(log, B, [{'type': 'workflow_error', 'error': 'boom'}])
    r = LiveFeed.next(log, 64, A + ':3')
    assert len(r['events']) == 7
    assert r['events'][6]['type'] == 'workflow_error'
    assert r['cursor'] == B + ':7'


def test_the_tail_of_the_cursors_run_is_sent_before_the_next_run(log):
    start_run(log, A, ['workflow_start', 'node_start'])
    append(log, A, [{'type': 'workflow_complete', 'output': 'the answer'}])
    start_run(log, B, ['workflow_start', 'node_start'])
    r = LiveFeed.next(log, 64, A + ':2')
    assert types(r) == ['workflow_complete', 'workflow_start', 'node_start']
    assert r['events'][0]['output'] == 'the answer'
    assert r['cursor'] == B + ':2'


def test_the_tail_of_the_cursors_run_is_sent_while_the_next_run_is_held_back(log):
    start_run(log, A, ['workflow_start', 'node_start', 'workflow_complete'])
    start_run(log, B, quiet())
    r = LiveFeed.next(log, 64, A + ':2')
    assert types(r) == ['workflow_complete']
    assert r['cursor'] == A + ':3'


# ---------------------------------------------------------------- LiveStream

def drive(feeds: list, cursor=None, maxS: float = 50.0, aborted=None) -> dict:
    """A fake clock that advances by each sleep; feeds is what next() returns per call (then nothing)."""
    clock = {'t': 0.0}
    out = []
    calls = []

    def nxt(c):
        calls.append(c)
        return feeds.pop(0) if feeds else {'events': [], 'cursor': c}

    def sleep(s):
        clock['t'] += s
    final = LiveStream.run(nxt, lambda: {'workflow_id': 64, 'watch_state': 'waiting'},
                           lambda event, data: out.append([event, data, clock['t']]), sleep, lambda: clock['t'],
                           aborted or (lambda: False), cursor, maxS)
    return {'out': out, 'final': final, 'calls': calls}


def test_events_carry_the_cursor_and_the_loop_ends_with_bye():
    r = drive([{'events': [{'type': 'workflow_start'}, {'type': 'node_start'}], 'cursor': 'c2'}], None, 2.0)
    run = [o[1] for o in r['out'] if o[0] == 'run']
    assert run == [{'cursor': 'c2', 'event': {'type': 'workflow_start'}}, {'cursor': 'c2', 'event': {'type': 'node_start'}}]
    assert r['out'][-1][:2] == ['bye', {'cursor': 'c2'}]
    assert r['final'] == 'c2'
    assert r['calls'][:2] == [None, 'c2']   # the cursor is carried into the next read


def test_state_first_then_every_five_seconds_and_pings_every_fifteen():
    r = drive([], 'c0', 31.0)
    state = [o[2] for o in r['out'] if o[0] == 'state']
    ping = [o[2] for o in r['out'] if o[0] == 'ping']
    assert state == [0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0]
    assert ping == [15.0, 30.0]
    assert r['out'][0][1] == {'active': {'workflow_id': 64, 'watch_state': 'waiting'}}


def test_an_aborted_client_ends_the_loop_without_bye():
    n = {'v': 0}

    def aborted():
        n['v'] += 1
        return n['v'] > 3
    r = drive([], 'c0', 50.0, aborted)
    assert 'bye' not in [o[0] for o in r['out']]
    assert (r['out'][-1][2] if r['out'] else 0.0) < 3.0


# ---------------------------------------------------------------- StartOptionGraph

def test_expanded_node_carries_the_start_trigger():
    t = {'label': 'L', 'work_exit': 'new_mail', 'watch': {'server': 'Outlook', 'tool': 'wait_for_new', 'args': []}}
    g = StartOptionGraph.expand({'nodes': [{'id': '3', 'node_type': 'start', 'config': {'type': 'start', 'start_option': 9}}],
                                 'edges': []},
                                lambda id: {'name': 'C', 'code': 'x', 'exits': ['new_mail'], 'mcp_servers': [],
                                            'timeout_s': 30, 'start_trigger': t})
    assert g['nodes'][1]['config']['start_trigger'] == t


def test_expanded_node_carries_the_start_args():
    t = {'label': 'L', 'work_exit': 'w', 'watch': {'server': 'S', 'tool': 't', 'args': []}}
    args = {'tag': 'okta-reset', 'version': 2}

    def comp(id):
        return {'name': 'C', 'code': 'x', 'exits': ['w'], 'mcp_servers': [], 'timeout_s': 30, 'start_trigger': t}
    g = StartOptionGraph.expand({'nodes': [{'id': '3', 'node_type': 'start',
                                            'config': {'type': 'start', 'start_option': 9, 'start_args': args}}],
                                 'edges': []}, comp)
    assert g['nodes'][1]['config']['args'] == args
    g = StartOptionGraph.expand({'nodes': [{'id': '3', 'node_type': 'start',
                                            'config': {'type': 'start', 'start_option': 9}}], 'edges': []}, comp)
    assert g['nodes'][1]['config']['args'] == []


# ---------------------------------------------------------------- WorkflowController.live

class FakeSse:
    def __init__(self):
        self.frames = []
        self.aborted = False

    def send(self, event, data):
        self.frames.append((event, data))

    def send_raw(self, frame):
        self.frames.append(('raw', frame))


def test_live_refuses_without_a_user_or_access():
    from tests.unit.test_workflow_controller import FakeDb, ctx, wc
    c = wc(FakeDb())
    sse = FakeSse()
    request = ctx(params={'id': 64}, user_id=None)
    request['sse'] = sse
    assert c.live(request) == {'streaming_handled': True}
    assert sse.frames == [('error', {'error': 'Authentication required'})]
    sse = FakeSse()
    request = ctx(params={'id': 64}, user_id=3)
    request['sse'] = sse
    c.workflowRepository.canUserAccess = lambda u, w: False
    c.live(request)
    assert sse.frames == [('error', {'error': 'Workflow not found or access denied'})]
