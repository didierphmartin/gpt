"""Ports of backend/tests/Unit/CodeComponent/CodeComponentStartOptionTest.php, CodeComponentLinkResolutionTest.php and
StartOptionNodeTest.php."""
from __future__ import annotations

import json

import pytest

from app.agent_team.services.code_node_emit import CodeNodeEmit
from app.agent_team.services.start_option_graph import StartOptionGraph
from app.agent_team.services.workflow_graph_repository import WorkflowGraphRepository
from app.code_component.code_component_error import CodeComponentError
from app.code_component.code_component_store import CodeComponentStore
from tests.unit.code_component_schema import POLL, TRIGGER, jenc, schema_db


def error(fn) -> CodeComponentError:
    with pytest.raises(CodeComponentError) as e:
        fn()
    return e.value


def trig(**over) -> dict:
    t = json.loads(json.dumps(TRIGGER))
    t.update(over)
    return t


class Env:
    def __init__(self):
        self.db = schema_db()
        self.store = CodeComponentStore(self.db)
        self.id = self.store.save(3, None, POLL)['id']

    def col(self, sql):
        return self.db.fetch_column(sql)[0]


@pytest.fixture
def e():
    return Env()


def test_a_component_is_not_an_option_by_default(e):
    assert e.store.get(3, e.id)['start_trigger'] is None


def test_set_start_trigger_stores_the_normalised_trigger(e):
    row = e.store.setStartTrigger(3, e.id, trig(label='  New email '))
    assert row['start_trigger']['label'] == 'New email'
    assert row['start_trigger']['work_exit'] == 'new_mail'
    assert e.store.watchFor(3, e.id) == {'server': 'Outlook', 'tool': 'wait_for_new', 'args': {'args': {'folder': 'Inbox'}}}
    assert e.store.list(3)[0]['start_trigger']['label'] == 'New email'


def test_a_blank_label_becomes_the_component_name(e):
    assert e.store.setStartTrigger(3, e.id, trig(label=' '))['start_trigger']['label'] == 'Poll Inbox'


def test_empty_args_stay_an_object(e):
    t = trig()
    t['watch']['args'] = []
    e.store.setStartTrigger(3, e.id, t)
    assert '"args":{}' in e.col('SELECT start_trigger FROM code_components')


@pytest.mark.parametrize('t,needle', [
    (trig(watch={**TRIGGER['watch'], 'server': 'Gmail'}), 'Gmail'),
    (trig(watch={**TRIGGER['watch'], 'tool': ''}), 'tool'),
    (trig(watch={**TRIGGER['watch'], 'args': [1, 2]}), 'args'),
    (trig(work_exit='job'), 'job'),
    (trig(label='x' * 61), 'label'),
], ids=['server not among the component servers', 'no tool', 'args a list', 'work exit not an exit', 'label too long'])
def test_a_bad_trigger_is_refused(e, t, needle):
    err = error(lambda: e.store.setStartTrigger(3, e.id, t))
    assert err.kind == 'invalid'
    assert err.status == 422
    assert needle in str(err)


def test_another_users_component_is_not_found(e):
    assert error(lambda: e.store.setStartTrigger(4, e.id, TRIGGER)).kind == 'not_found'
    assert error(lambda: e.store.watchFor(4, e.id)).kind == 'not_found'


def test_watch_for_refuses_a_component_that_is_not_an_option(e):
    err = error(lambda: e.store.watchFor(3, e.id))
    assert err.kind == 'not_option'
    assert err.status == 422


def test_an_edit_that_drops_the_work_exit_is_refused(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    err = error(lambda: e.store.save(3, e.id, {**POLL, 'exits': ['job', 'no_job']}))
    assert err.kind == 'start_exit'
    assert err.status == 422
    assert 'new_mail' in str(err)


def test_an_edit_that_drops_the_watched_server_is_refused(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    err = error(lambda: e.store.save(3, e.id, {**POLL, 'mcp_servers': []}))
    assert err.kind == 'start_exit'
    assert 'Outlook' in str(err)


def test_an_edit_that_keeps_the_work_exit_is_saved(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    row = e.store.save(3, e.id, {**POLL, 'timeout_s': 90})
    assert row['timeout_s'] == 90
    assert row['start_trigger']['work_exit'] == 'new_mail'


def seed_two_workflows(e):
    """Workflow 64 uses the option (schedule row + linked node after Start); 65 has only an unrelated schedule."""
    e.store.setStartTrigger(3, e.id, TRIGGER)
    e.db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (64, '3', 'email prototype'), (65, '3', 'AA test')")
    e.db.execute("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (64, 'code', ?)",
                 [jenc({'type': 'code', 'name': 'Email processing', 'code_component_id': e.id})])
    e.db.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)"
                 f" VALUES (3, 64, 'event', '{{}}', {e.id}, 'pending'), (3, 65, 'cron', NULL, NULL, 'pending'),"
                 f" (4, 99, 'event', '{{}}', {e.id}, 'pending')")


def test_impact_names_the_workflows(e):
    seed_two_workflows(e)
    assert e.store.startTriggerImpact(3, e.id) == [{'workflow_id': 64, 'workflow_name': 'email prototype'}]


def test_clear_removes_the_option_and_only_its_schedule_rows(e):
    seed_two_workflows(e)
    impact = e.store.clearStartTrigger(3, e.id)
    assert [i['workflow_id'] for i in impact] == [64]
    assert e.store.get(3, e.id)['start_trigger'] is None
    left = e.db.fetch_all('SELECT user_id, workflow_id FROM scheduled_workflows ORDER BY workflow_id')
    assert left == [{'user_id': 3, 'workflow_id': 65}, {'user_id': 4, 'workflow_id': 99}]
    # the graphs are not touched: the linked node stays (decision 6)
    assert e.col('SELECT COUNT(*) FROM workflow_nodes') == 1


def test_an_option_cannot_be_deleted_before_it_is_removed(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    err = error(lambda: e.store.delete(3, e.id))
    assert err.kind == 'is_option'
    assert err.status == 409
    e.store.clearStartTrigger(3, e.id)
    e.store.delete(3, e.id)
    assert e.store.get(3, e.id) is None


def test_schedule_body_fills_the_event_from_the_option(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    b = e.store.scheduleBody(3, {'workflow_id': 64, 'repeat_type': 'cron', 'cron': '* * * * *', 'trigger_component_id': str(e.id)})
    assert b['repeat_type'] == 'event'
    assert b['cron'] is None
    assert b['trigger_component_id'] == e.id
    assert b['event_trigger'] == TRIGGER['watch']


def start_node(e, wf, start_args: dict | None = None):
    cfg = {'type': 'start', 'start_option': e.id}
    if start_args is not None:
        cfg['start_args'] = start_args
    e.db.execute('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)', [wf, 'start', jenc(cfg)])


def test_schedule_body_adds_only_the_start_tag_to_the_watch(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    start_node(e, 64, {'tag': 'okta-reset', 'version': 2, 'hand_back_group': 'g'})
    b = e.store.scheduleBody(3, {'workflow_id': 64, 'trigger_component_id': str(e.id)})
    assert b['event_trigger']['args'] == {'args': {'folder': 'Inbox'}, 'tag': 'okta-reset'}
    # the update path has no workflow_id in its body: the caller names it
    b = e.store.scheduleBody(3, {'trigger_component_id': str(e.id)}, 64)
    assert b['event_trigger']['args']['tag'] == 'okta-reset'
    # another workflow, or a Start without a tag: the watch as stored
    b = e.store.scheduleBody(3, {'workflow_id': 65, 'trigger_component_id': str(e.id)})
    assert b['event_trigger'] == TRIGGER['watch']


def test_schedule_body_leaves_other_schedules_alone(e):
    body = {'workflow_id': 64, 'repeat_type': 'daily'}
    assert e.store.scheduleBody(3, body) == body


def test_schedule_body_refuses_a_foreign_or_non_option_component(e):
    assert error(lambda: e.store.scheduleBody(3, {'trigger_component_id': e.id})).kind == 'not_option'
    e.store.setStartTrigger(3, e.id, TRIGGER)
    assert error(lambda: e.store.scheduleBody(4, {'trigger_component_id': e.id})).kind == 'not_found'


def test_editing_the_watch_updates_the_schedules_using_the_option(e):
    seed_two_workflows(e)
    other = e.store.save(3, None, {**POLL, 'name': 'Poll Archive'})['id']
    e.db.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)"
                 f" VALUES (3, 66, 'event', '{{}}', {other}, 'pending')")
    t = trig()
    t['watch']['args'] = {'args': {'folder': 'Archive'}}
    e.store.setStartTrigger(3, e.id, t)
    by = {r['workflow_id']: r['event_trigger'] for r in
          e.db.fetch_all('SELECT user_id, workflow_id, event_trigger FROM scheduled_workflows ORDER BY workflow_id')}
    assert by[64] == '{"server":"Outlook","tool":"wait_for_new","args":{"args":{"folder":"Archive"}}}'
    assert by[65] is None
    assert by[66] == '{}'   # another component's schedule
    assert by[99] == '{}'   # another user's schedule


def test_editing_the_watch_keeps_each_schedules_tag(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    start_node(e, 64, {'tag': 'okta-reset'})
    e.db.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)"
                 f" VALUES (3, 64, 'event', '{{}}', {e.id}, 'pending'), (3, 65, 'event', '{{}}', {e.id}, 'pending')")
    t = trig()
    t['watch']['args'] = {'args': {'folder': 'Archive'}}
    e.store.setStartTrigger(3, e.id, t)
    by = {r['workflow_id']: r['event_trigger'] for r in e.db.fetch_all('SELECT workflow_id, event_trigger FROM scheduled_workflows')}
    assert json.loads(by[64])['args'] == {'args': {'folder': 'Archive'}, 'tag': 'okta-reset'}
    assert json.loads(by[65])['args'] == {'args': {'folder': 'Archive'}}


def test_the_start_tag_wins_over_the_components_own_tag(e):
    t = trig()
    t['watch']['args'] = {'tag': 'default'}
    e.store.setStartTrigger(3, e.id, t)
    start_node(e, 64, {'tag': 'okta-reset'})
    b = e.store.scheduleBody(3, {'workflow_id': 64, 'trigger_component_id': str(e.id)})
    assert b['event_trigger']['args']['tag'] == 'okta-reset'


def drop_trigger() -> dict:
    t = trig()
    t['watch']['args'] = {'poll': 'poll_new_mail', 'folder': 'To SharePoint'}
    return {'pass_args': ['folder'], **t}


def test_pass_args_reach_the_event_row_watch(e):
    e.store.setStartTrigger(3, e.id, drop_trigger())
    assert e.store.get(3, e.id)['start_trigger']['pass_args'] == ['folder']
    start_node(e, 64, {'folder': 'Mail in', 'sharepoint_folder': 'D'})
    b = e.store.scheduleBody(3, {'workflow_id': 64, 'trigger_component_id': str(e.id)})
    assert b['event_trigger']['args'] == {'poll': 'poll_new_mail', 'folder': 'Mail in'}
    e.db.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)"
                 f" VALUES (3, 64, 'event', '{{}}', {e.id}, 'pending')")
    e.store.setStartTrigger(3, e.id, drop_trigger())
    row = e.col('SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = 64')
    assert json.loads(row)['args'] == {'poll': 'poll_new_mail', 'folder': 'Mail in'}


def test_undeclared_start_args_stay_out(e):
    t = drop_trigger()
    del t['pass_args']
    e.store.setStartTrigger(3, e.id, t)
    assert e.store.get(3, e.id)['start_trigger']['pass_args'] == []   # absent = []
    start_node(e, 64, {'folder': 'Mail in', 'sharepoint_folder': 'D'})
    b = e.store.scheduleBody(3, {'workflow_id': 64, 'trigger_component_id': str(e.id)})
    assert b['event_trigger']['args'] == {'poll': 'poll_new_mail', 'folder': 'To SharePoint'}


def test_tag_still_merged_without_pass_args(e):
    e.store.setStartTrigger(3, e.id, TRIGGER)
    start_node(e, 64, {'tag': 'okta-reset', 'folder': 'Mail in'})
    b = e.store.scheduleBody(3, {'workflow_id': 64, 'trigger_component_id': str(e.id)})
    assert b['event_trigger']['args'] == {'args': {'folder': 'Inbox'}, 'tag': 'okta-reset'}


@pytest.mark.parametrize('passArgs', [['9x'], {'a': 'folder'}, 'folder', [1], [f'a{i}' for i in range(1, 22)]],
                         ids=['starts with a digit', 'not a list', 'a string', 'a number in it', 'more than 20'])
def test_pass_args_validation(e, passArgs):
    err = error(lambda: e.store.setStartTrigger(3, e.id, {'pass_args': passArgs, **TRIGGER}))
    assert err.kind == 'invalid'
    assert err.status == 422
    assert 'pass_args' in str(err)


def test_a_save_without_pass_args_keeps_the_stored_ones(e):
    e.store.setStartTrigger(3, e.id, drop_trigger())
    start_node(e, 64, {'folder': 'Mail in', 'sharepoint_folder': 'D'})
    e.db.execute("INSERT INTO scheduled_workflows (user_id, workflow_id, repeat_type, event_trigger, trigger_component_id, status)"
                 f" VALUES (3, 64, 'event', '{{}}', {e.id}, 'pending')")
    t = drop_trigger()
    del t['pass_args']
    e.store.setStartTrigger(3, e.id, {**t, 'label': 'Renamed'})
    assert e.store.get(3, e.id)['start_trigger']['pass_args'] == ['folder']
    row = e.col('SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = 64')
    assert json.loads(row)['args'] == {'poll': 'poll_new_mail', 'folder': 'Mail in'}
    e.store.setStartTrigger(3, e.id, {'pass_args': [], **t})
    assert e.store.get(3, e.id)['start_trigger']['pass_args'] == []
    row = e.col('SELECT event_trigger FROM scheduled_workflows WHERE workflow_id = 64')
    assert json.loads(row)['args'] == {'poll': 'poll_new_mail', 'folder': 'To SharePoint'}


# ---------------------------------------------------------------- link resolution

@pytest.fixture
def lr():
    db = schema_db()
    # getNodes also runs the playbook fill-in loop, which needs the table to exist.
    db.execute('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT)')
    db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Mail triage')")
    return db


def lr_node(db, type, cfg):
    db.execute('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, ?, ?)', [type, jenc(cfg)])


def test_hydrated_node_has_declaration_cache(lr):
    args = [{'name': 'folder', 'required': True}]
    id = CodeComponentStore(lr).save(3, None, {**POLL, 'args': args, 'provides': [{'name': 'from'}]})['id']
    lr_node(lr, 'code', {'name': 'Poll', 'code_component_id': id, 'arg_decls': [{'name': 'stale'}], 'provides': []})
    cfg = WorkflowGraphRepository(lr).getNodes(1)[0]['config']
    assert cfg['arg_decls'] == args
    assert cfg['provides'] == [{'name': 'from'}]


def test_save_strips_declaration_cache(lr):
    repo = WorkflowGraphRepository(lr)
    full = {'name': 'Poll', 'code_component_id': 7, 'arg_decls': [{'name': 'a'}], 'provides': [{'name': 'b'}], 'args': {'a': 'x'}}
    a = repo.createNode(1, {'node_type': 'code', 'config': full})
    b = repo.createNode(1, {'node_type': 'code', 'config': {'name': 'Poll', 'code_component_id': 7}})
    repo.updateNode(b, {'node_type': 'code', 'config': full})
    for id in (a, b):
        cfg = stored(lr, id)
        assert 'arg_decls' not in cfg
        assert 'provides' not in cfg
        assert cfg['args'] == {'a': 'x'}


def test_get_nodes_fills_the_component_for_the_owner(lr):
    id = CodeComponentStore(lr).save(3, None, POLL)['id']
    # Saved exits are stale (another workflow changed the component since): the component wins.
    lr_node(lr, 'code', {'name': 'Poll', 'code_component_id': id, 'exits': ['old'], 'code_component_missing': True})
    cfg = WorkflowGraphRepository(lr).getNodes(1)[0]['config']
    assert cfg['code'] == POLL['code']
    assert cfg['exits'] == ['new_mail', 'no_mail', 'error']
    assert cfg['mcp_servers'] == ['Outlook']
    assert cfg['timeout_s'] == 20
    assert 'code_component_missing' not in cfg
    assert cfg['name'] == 'Poll'


def test_missing_or_foreign_component_is_flagged(lr):
    foreign = CodeComponentStore(lr).save(4, None, POLL)['id']
    lr_node(lr, 'code', {'name': 'Gone', 'code_component_id': 99})
    lr_node(lr, 'code', {'name': 'Theirs', 'code_component_id': foreign})
    nodes = WorkflowGraphRepository(lr).getNodes(1)
    assert nodes[0]['config']['code_component_missing'] is True
    assert nodes[1]['config']['code_component_missing'] is True
    assert 'code' not in nodes[1]['config']


def test_unlinked_and_non_code_nodes_are_untouched(lr):
    lr_node(lr, 'code', {'name': 'Inline', 'code': 'x', 'exits': ['next']})
    lr_node(lr, 'agent', {'code_component_id': 5})
    nodes = WorkflowGraphRepository(lr).getNodes(1)
    assert nodes[0]['config'] == {'name': 'Inline', 'code': 'x', 'exits': ['next']}
    assert nodes[1]['config'] == {'code_component_id': 5}


def stored(db, id):
    return json.loads(db.fetch_column(f'SELECT config FROM workflow_nodes WHERE id = {id}')[0])


def test_create_and_update_store_only_the_link(lr):
    repo = WorkflowGraphRepository(lr)
    full = {'name': 'Poll', 'code_component_id': 7, 'code': 'x', 'exits': ['a'], 'mcp_servers': ['O'],
            'timeout_s': 5, 'code_component_missing': True, 'disabled': False}
    nodeId = repo.createNode(1, {'node_type': 'code', 'config': full})
    assert list(stored(lr, nodeId).items()) == [('name', 'Poll'), ('code_component_id', 7), ('disabled', False), ('type', 'code')]
    repo.updateNode(nodeId, {'node_type': 'code', 'config': full})
    assert list(stored(lr, nodeId).items()) == [('name', 'Poll'), ('code_component_id', 7), ('disabled', False), ('type', 'code')]
    # An unlinked code node keeps its own code.
    inline = repo.createNode(1, {'node_type': 'code', 'config': {'code': 'y', 'exits': ['next']}})
    assert stored(lr, inline)['code'] == 'y'


def test_args_and_start_args_survive_save_and_update(lr):
    repo = WorkflowGraphRepository(lr)
    code = {'name': 'Poll', 'code_component_id': 7, 'args': {'q': ['a', 1]}}
    start = {'start_option': 7, 'start_args': {'mailbox': 'x'}}
    c = repo.createNode(1, {'node_type': 'code', 'config': code})
    s = repo.createNode(1, {'node_type': 'start', 'config': start})
    assert stored(lr, c)['args'] == {'q': ['a', 1]}
    assert stored(lr, s)['start_args'] == {'mailbox': 'x'}
    repo.updateNode(c, {'node_type': 'code', 'config': code})
    repo.updateNode(s, {'node_type': 'start', 'config': start})
    assert stored(lr, c)['args'] == {'q': ['a', 1]}
    assert stored(lr, s)['start_args'] == {'mailbox': 'x'}


def test_compile_refuses_a_missing_component_naming_the_node():
    with pytest.raises(RuntimeError, match=r'Code component #99 not found \(node Gone\)\.'):
        CodeNodeEmit.nodeData({'id': '5', 'config': {'name': 'Gone', 'code_component_id': 99, 'code_component_missing': True}}, [], {})


def test_a_code_node_whose_column_lost_its_type_is_still_resolved_and_counted(lr):
    store = CodeComponentStore(lr)
    id = store.save(3, None, POLL)['id']
    lr_node(lr, '', {'type': 'code', 'name': 'Poll', 'code_component_id': id})
    cfg = WorkflowGraphRepository(lr).getNodes(1)[0]['config']
    assert cfg['code'] == POLL['code']
    assert store.usedBy(3, id) == [{'workflow_id': 1, 'workflow_name': 'Mail triage', 'node_name': 'Poll'}]
    assert store.list(3)[0]['used_by'] == 1


def test_a_non_code_config_type_with_an_empty_column_is_not_resolved(lr):
    id = CodeComponentStore(lr).save(3, None, POLL)['id']
    lr_node(lr, '', {'type': 'agent', 'code_component_id': id})
    assert WorkflowGraphRepository(lr).getNodes(1)[0]['config'] == {'type': 'agent', 'code_component_id': id}
    assert CodeComponentStore(lr).usedBy(3, id) == []


# ---------------------------------------------------------------- Start option node

class StartEnv:
    def __init__(self):
        self.db = schema_db()
        self.db.execute('CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT)')
        self.store = CodeComponentStore(self.db)
        self.cid = self.store.save(3, None, POLL)['id']
        self.store.setStartTrigger(3, self.cid, trig(label='Outlook: Get New Email'))
        self.db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (1, '3', 'Mail triage')")
        self.start = self.node('start', {'type': 'start', 'start_option': self.cid})
        self.edges = []
        for port in ('output_1', 'output_2', 'output_3'):
            to = self.node('agent', {'type': 'agent'})
            self.edges.append(self.db.insert('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port)'
                                             ' VALUES (1, ?, ?, ?, ?)', [self.start, to, port, 'input_1']))

    def node(self, type, cfg) -> int:
        return self.db.insert('INSERT INTO workflow_nodes (workflow_id, node_type, config, pos_x, pos_y) VALUES (1, ?, ?, 100, 50)',
                              [type, jenc(cfg)])

    def ports(self) -> dict:
        return {int(r['id']): r['from_port'] for r in self.db.fetch_all('SELECT id, from_port FROM workflow_edges ORDER BY id')}

    def startConfig(self) -> dict:
        return json.loads(self.db.fetch_column('SELECT config FROM workflow_nodes WHERE id = ?', [self.start])[0])


@pytest.fixture
def se():
    return StartEnv()


def test_start_reads_the_options_exits_and_label(se):
    start = WorkflowGraphRepository(se.db).getNodes(1)[0]
    assert start['config']['exits'] == ['new_mail', 'no_mail', 'error']
    assert start['config']['start_option_label'] == 'Outlook: Get New Email'
    assert 'start_option_missing' not in start['config']


def test_saving_start_stores_only_the_option(se):
    WorkflowGraphRepository(se.db).updateNode(se.start, {'node_type': 'start', 'config': {
        'type': 'start', 'start_option': se.cid, 'exits': ['x'], 'start_option_label': 'x', 'start_option_missing': True}})
    assert se.startConfig() == {'type': 'start', 'start_option': se.cid}


def test_the_graph_runs_the_component_after_start(se):
    g = WorkflowGraphRepository(se.db).getGraph(1)
    code = str(StartOptionGraph.ID_OFFSET + se.start)
    node = [n for n in g['nodes'] if str(n['id']) == code][0]
    assert node['node_type'] == 'code'
    assert node['config']['name'] == 'Outlook: Get New Email'
    assert node['config']['code_component_id'] == se.cid
    assert node['config']['exits'] == ['new_mail', 'no_mail', 'error']
    assert node['config']['mcp_servers'] == ['Outlook']
    frm = [[str(e['from_node_id']), e['from_port']] for e in g['edges']]
    assert frm == [[code, 'output_1'], [code, 'output_2'], [code, 'output_3'], [str(se.start), 'output_1']]
    assert str(g['edges'][-1]['to_node_id']) == code


def test_expanded_start_carries_arg_decls(se):
    args = [{'name': 'folder', 'required': True}]
    se.store.save(3, se.cid, {**POLL, 'args': args})
    g = WorkflowGraphRepository(se.db).getGraph(1)
    code = str(StartOptionGraph.ID_OFFSET + se.start)
    node = [n for n in g['nodes'] if str(n['id']) == code][0]
    assert node['config']['arg_decls'] == args


def test_a_plain_start_is_not_expanded():
    graph = {'nodes': [{'id': 5, 'node_type': 'start', 'config': {'type': 'start'}}],
             'edges': [{'id': 1, 'from_node_id': 5, 'to_node_id': 6, 'from_port': 'output_1'}]}

    def no_lookup(id):
        raise AssertionError('no lookup')
    assert StartOptionGraph.expand(graph, no_lookup) == graph


def test_a_start_whose_option_is_gone_is_not_expanded():
    graph = {'nodes': [{'id': 5, 'node_type': 'start', 'config': {'type': 'start', 'start_option': 9}}], 'edges': []}
    assert StartOptionGraph.expand(graph, lambda id: None) == graph
    assert StartOptionGraph.expand(graph, lambda id: {**POLL, 'start_trigger': None}) == graph


def test_used_by_lists_the_start(se):
    assert se.store.usedBy(3, se.cid) == [{'workflow_id': 1, 'workflow_name': 'Mail triage', 'node_name': 'Start'}]


def test_reordering_exits_moves_starts_links(se):
    se.store.save(3, se.cid, {**POLL, 'exits': ['no_mail', 'new_mail', 'error']})
    e1, e2, e3 = se.edges
    assert se.ports() == {e1: 'output_2', e2: 'output_1', e3: 'output_3'}


def test_removing_an_exit_with_links_on_start_asks_first(se):
    err = error(lambda: se.store.save(3, se.cid, {**POLL, 'exits': ['new_mail', 'no_mail']}))
    assert err.data == [{'workflow_id': 1, 'workflow_name': 'Mail triage', 'node_name': 'Start', 'exit': 'error', 'count': 1}]
    se.store.save(3, se.cid, {**POLL, 'exits': ['new_mail', 'no_mail'], 'confirm_drop_links': True})
    e1, e2, _ = se.edges
    assert se.ports() == {e1: 'output_1', e2: 'output_2'}


def test_removing_the_option_turns_start_back_into_a_plain_start(se):
    impact = se.store.clearStartTrigger(3, se.cid)
    assert impact == [{'workflow_id': 1, 'workflow_name': 'Mail triage'}]
    assert se.ports() == {se.edges[0]: 'output_1'}   # the work exit's link stays
    assert se.startConfig() == {'type': 'start'}
