"""Ports of backend/tests/Unit/CodeComponent/CodeComponentStoreTest.php, CodeComponentExitRemapTest.php and
CodeComponentsControllerTest.php."""
from __future__ import annotations

import pytest

from app.code_component.code_component_error import CodeComponentError
from app.code_component.code_component_store import CodeComponentStore
from app.controllers.code_components_controller import CodeComponentsController
from tests.unit.code_component_schema import POLL, TRIGGER, jenc, schema_db


@pytest.fixture
def db():
    return schema_db()


@pytest.fixture
def store(db):
    return CodeComponentStore(db)


def error(fn) -> CodeComponentError:
    with pytest.raises(CodeComponentError) as e:
        fn()
    return e.value


ARGS = [{'name': 'folder', 'description': 'd', 'required': True}, {'name': 'subfolder', 'default': '{received}'}]


def test_save_and_read_args_provides(store):
    row = store.save(3, None, {**POLL, 'args': ARGS, 'provides': [{'name': 'from'}]})
    assert row['args'] == ARGS
    assert row['provides'] == [{'name': 'from'}]
    assert store.get(3, row['id'])['args'] == ARGS
    assert store.list(3)[0]['args'] == ARGS


def test_update_without_args_keeps_them(store):
    id = store.save(3, None, {**POLL, 'args': ARGS, 'provides': [{'name': 'from'}]})['id']
    row = store.save(3, id, {**POLL, 'description': 'changed'})
    assert row['args'] == ARGS
    assert row['provides'] == [{'name': 'from'}]
    row = store.save(3, id, {**POLL, 'args': [], 'provides': []})
    assert row['args'] == []
    assert row['provides'] == []


def test_create_without_args_stores_empty_lists(store, db):
    row = store.save(3, None, POLL)
    assert row['args'] == []
    assert row['provides'] == []
    assert db.fetch_one('SELECT args, provides FROM code_components WHERE id = ?', [row['id']]) == {'args': '[]', 'provides': '[]'}


def test_null_columns_read_as_empty_lists(store, db):
    id = store.save(3, None, POLL)['id']
    db.execute('UPDATE code_components SET args = NULL, provides = NULL')
    row = store.get(3, id)
    assert row['args'] == []
    assert row['provides'] == []


@pytest.mark.parametrize('extra', [
    pytest.param({'args': [{'name': '1x'}]}, id='digit first'),
    pytest.param({'args': [{'name': 'a'}, {'name': 'a'}]}, id='duplicate arg'),
    pytest.param({'provides': [{'name': 'a'}, {'name': 'a'}]}, id='duplicate provided'),
    pytest.param({'args': [{'name': 'a', 'required': 'yes'}]}, id='required not bool'),
    pytest.param({'args': [{'name': 'a', 'default': 3}]}, id='default not string'),
    pytest.param({'provides': [{'name': 'a', 'description': 3}]}, id='description not string'),
    pytest.param({'args': [{'name': f'a{i}'} for i in range(1, 22)]}, id='too many'),
    pytest.param({'args': 'x'}, id='not a list'),
    pytest.param({'provides': ['x']}, id='entry not an object'),
    pytest.param({'args': [{'name': 'a\n'}]}, id='trailing newline'),
    pytest.param({'args': None}, id='null'),
])
def test_rejects_bad_args(store, extra):
    e = error(lambda: store.save(3, None, {**POLL, **extra}))
    assert e.kind == 'invalid'
    assert e.status == 422


def test_bad_args_messages(store):
    def m(x):
        return str(error(lambda: store.save(3, None, {**POLL, **x})))
    assert m({'args': [{'name': '1x'}]}) == 'Argument and provided names are letters, digits and _, not starting with a digit (got "1x").'
    assert m({'args': [{'name': 'a'}, {'name': 'a'}]}) == 'Argument "a" is listed twice.'
    assert m({'provides': [{'name': 'a'}, {'name': 'a'}]}) == 'Provided name "a" is listed twice.'
    assert m({'args': 'x'}) == 'args must be a list of {name, description, default, required}.'
    assert m({'provides': ['x']}) == 'provides must be a list of {name, description}.'
    assert m({'args': [{'name': f'a{i}'} for i in range(1, 22)]}) == 'At most 20 arguments and 20 provided names.'


def test_declarations_keep_known_keys_only(store):
    row = store.save(3, None, {**POLL, 'args': [{'name': 'a', 'x': 1, 'required': False}], 'provides': {}})
    assert row['args'] == [{'name': 'a', 'required': False}]
    assert row['provides'] == []


def test_save_round_trips_typed_fields(store):
    row = store.save(3, None, POLL)
    assert isinstance(row['id'], int)
    assert row['exits'] == ['new_mail', 'no_mail', 'error']
    assert row['mcp_servers'] == ['Outlook']
    assert row['timeout_s'] == 20
    assert store.get(3, row['id'])['code'] == POLL['code']


def test_create_with_an_existing_name_updates_that_row(store):
    a = store.save(3, None, POLL)
    b = store.save(3, None, {**POLL, 'code': 'def run(i, c):\\n    return 2'})
    assert a['id'] == b['id']
    assert len(store.list(3)) == 1
    assert 'return 2' in store.get(3, a['id'])['code']


def test_rename_onto_another_name_is_refused(store):
    store.save(3, None, POLL)
    other = store.save(3, None, {**POLL, 'name': 'Poll Support'})
    e = error(lambda: store.save(3, other['id'], POLL))
    assert e.kind == 'name_taken'
    assert e.status == 409


def test_names_are_scoped_per_user(store):
    mine = store.save(3, None, POLL)
    theirs = store.save(4, None, POLL)
    assert mine['id'] != theirs['id']
    assert store.get(3, theirs['id']) is None


@pytest.mark.parametrize('bad', [
    {'name': '  '}, {'exits': []}, {'exits': ['Bad-Exit']}, {'exits': ['a', 'a']},
    {'exits': [f'e{i}' for i in range(1, 10)]}, {'timeout_s': 0}, {'timeout_s': 301}, {'mcp_servers': 'Outlook'},
])
def test_validation(store, bad):
    e = error(lambda: store.save(3, None, {**POLL, **bad}))
    assert e.kind == 'invalid'
    assert e.status == 422


def test_validation_defaults(store):
    row = store.save(3, None, {k: v for k, v in POLL.items() if k not in ('timeout_s', 'description')})
    assert row['timeout_s'] == 30
    assert row['description'] == ''


def test_update_unknown_id_is_not_found(store):
    e = error(lambda: store.save(3, 99, POLL))
    assert e.kind == 'not_found'
    assert str(e) == 'Code component #99 not found'


def test_used_by_and_delete_guard(db, store):
    id = store.save(3, None, POLL)['id']
    db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'Mail triage')")
    db.execute("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'code', ?)",
               [jenc({'name': 'Poll', 'code_component_id': id})])
    db.execute("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'code', ?)",
               [jenc({'name': 'Other', 'code_component_id': 77})])
    db.execute("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'agent', ?)",
               [jenc({'code_component_id': id})])
    assert store.usedBy(3, id) == [{'workflow_id': 1, 'workflow_name': 'Mail triage', 'node_name': 'Poll'}]
    assert store.list(3)[0]['used_by'] == 1
    e = error(lambda: store.delete(3, id))
    assert e.kind == 'in_use'
    assert 'Mail triage' in str(e)
    db.execute('DELETE FROM workflow_nodes')
    store.delete(3, id)
    assert store.get(3, id) is None


# ---------------------------------------------------------------- exit remap

class Remap:
    def __init__(self):
        self.db = schema_db()
        self.store = CodeComponentStore(self.db)
        self.cid = self.store.save(3, None, POLL)['id']

    def workflow(self, userId: str, name: str) -> int:
        return self.db.insert('INSERT INTO agent_workflows (user_id, name) VALUES (?, ?)', [userId, name])

    def node(self, wf: int, type: str, config: dict) -> int:
        return self.db.insert('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)', [wf, type, jenc(config)])

    def edge(self, wf, frm, to, fromPort, toPort='input_1') -> int:
        return self.db.insert('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port, to_port) VALUES (?, ?, ?, ?, ?)',
                              [wf, frm, to, fromPort, toPort])

    def ports(self) -> dict:
        return {int(r['id']): r['from_port'] for r in self.db.fetch_all('SELECT id, from_port FROM workflow_edges ORDER BY id')}

    def linkedNodeWithThreeChildren(self, wf: int) -> list[int]:
        code = self.node(wf, 'code', {'name': 'Poll', 'code_component_id': self.cid})
        a = self.node(wf, 'agent', {})
        b = self.node(wf, 'agent', {})
        c = self.node(wf, 'agent', {})
        return [self.edge(wf, code, a, 'output_1'), self.edge(wf, code, b, 'output_2'), self.edge(wf, code, c, 'output_3')]

    def saveExits(self, exits):
        self.store.save(3, self.cid, {**POLL, 'exits': exits})


@pytest.fixture
def r():
    return Remap()


def test_reorder_swaps_ports_in_every_linked_workflow(r):
    e1, e2, e3 = r.linkedNodeWithThreeChildren(r.workflow('3', 'First'))
    f1, f2, f3 = r.linkedNodeWithThreeChildren(r.workflow('3', 'Second'))
    r.saveExits(['no_mail', 'new_mail', 'error'])
    assert r.ports() == {e1: 'output_2', e2: 'output_1', e3: 'output_3', f1: 'output_2', f2: 'output_1', f3: 'output_3'}


def test_insert_keeps_later_exits_on_their_names(r):
    e1, e2, e3 = r.linkedNodeWithThreeChildren(r.workflow('3', 'First'))
    r.saveExits(['new_mail', 'skip', 'no_mail', 'error'])
    assert r.ports() == {e1: 'output_1', e2: 'output_3', e3: 'output_4'}


def test_removed_exit_drops_its_edges_once_confirmed(r):
    e1, _, e3 = r.linkedNodeWithThreeChildren(r.workflow('3', 'First'))
    r.store.save(3, r.cid, {**POLL, 'exits': ['new_mail', 'error'], 'confirm_drop_links': True})
    assert r.ports() == {e1: 'output_1', e3: 'output_2'}


def test_removing_a_linked_exit_is_refused_until_confirmed(r):
    e1, e2, e3 = r.linkedNodeWithThreeChildren(r.workflow('3', 'First'))
    e = error(lambda: r.saveExits(['new_mail', 'error']))
    assert e.kind == 'links_dropped'
    assert e.status == 409
    assert e.data == [{'workflow_id': 1, 'workflow_name': 'First', 'node_name': 'Poll', 'exit': 'no_mail', 'count': 1}]
    assert r.store.get(3, r.cid)['exits'] == ['new_mail', 'no_mail', 'error']
    assert r.ports() == {e1: 'output_1', e2: 'output_2', e3: 'output_3'}


def test_removing_an_unlinked_exit_needs_no_confirmation(r):
    wf = r.workflow('3', 'First')
    code = r.node(wf, 'code', {'name': 'Poll', 'code_component_id': r.cid})
    e1 = r.edge(wf, code, r.node(wf, 'agent', {}), 'output_1')
    r.saveExits(['new_mail', 'error'])
    assert r.ports() == {e1: 'output_1'}


def test_collapse_to_one_exit_moves_all_to_output1_and_drops_duplicates(r):
    wf = r.workflow('3', 'First')
    code = r.node(wf, 'code', {'name': 'Poll', 'code_component_id': r.cid})
    a = r.node(wf, 'agent', {})
    b = r.node(wf, 'agent', {})
    e1 = r.edge(wf, code, a, 'output_1')
    r.edge(wf, code, a, 'output_2')             # same target as e1: a duplicate once collapsed
    e3 = r.edge(wf, code, b, 'output_3')
    e4 = r.edge(wf, code, a, 'output_3', 'input_2')   # same node, other input: kept
    r.saveExits(['done'])
    assert r.ports() == {e1: 'output_1', e3: 'output_1', e4: 'output_1'}


def test_unchanged_exits_touch_no_edges(r):
    wf = r.workflow('3', 'First')
    code = r.node(wf, 'code', {'name': 'Poll', 'code_component_id': r.cid})
    a = r.node(wf, 'agent', {})
    e1 = r.edge(wf, code, a, 'output_2')
    e2 = r.edge(wf, code, a, 'output_9')
    r.store.save(3, r.cid, {**POLL, 'code': 'def run(i, c):\\n    return 2'})
    assert r.ports() == {e1: 'output_2', e2: 'output_9'}


def test_port_beyond_old_exits_is_left_alone(r):
    wf = r.workflow('3', 'First')
    code = r.node(wf, 'code', {'name': 'Poll', 'code_component_id': r.cid})
    a = r.node(wf, 'agent', {})
    e1 = r.edge(wf, code, a, 'output_7')
    r.saveExits(['error', 'new_mail'])
    assert r.ports() == {e1: 'output_7'}


def test_other_users_and_unlinked_nodes_are_untouched(r):
    theirs = r.workflow('4', 'Theirs')
    code4 = r.node(theirs, 'code', {'name': 'Poll', 'code_component_id': r.cid})
    a4 = r.node(theirs, 'agent', {})
    t1 = r.edge(theirs, code4, a4, 'output_1')
    t2 = r.edge(theirs, code4, a4, 'output_2')
    mine = r.workflow('3', 'Mine')
    plain = r.node(mine, 'code', {'name': 'Inline', 'exits': ['new_mail', 'no_mail', 'error']})
    other = r.node(mine, 'code', {'name': 'Other', 'code_component_id': r.cid + 100})
    agentLinked = r.node(mine, 'agent', {'code_component_id': r.cid})
    a = r.node(mine, 'agent', {})
    p1 = r.edge(mine, plain, a, 'output_1')
    p2 = r.edge(mine, other, a, 'output_2')
    p3 = r.edge(mine, agentLinked, a, 'output_1')
    r.saveExits(['no_mail', 'error'])
    assert r.ports() == {t1: 'output_1', t2: 'output_2', p1: 'output_1', p2: 'output_2', p3: 'output_1'}


def test_remap_rolls_back_with_the_update_on_error(r):
    e1, e2, e3 = r.linkedNodeWithThreeChildren(r.workflow('3', 'First'))
    r.db.execute("CREATE TRIGGER boom BEFORE UPDATE ON workflow_edges BEGIN SELECT RAISE(ABORT, 'boom'); END")
    with pytest.raises(Exception, match='boom'):
        r.saveExits(['no_mail', 'new_mail', 'error'])
    assert r.db.inTransaction() is False
    assert r.store.get(3, r.cid)['exits'] == ['new_mail', 'no_mail', 'error']
    assert r.ports() == {e1: 'output_1', e2: 'output_2', e3: 'output_3'}


# ---------------------------------------------------------------- controller

@pytest.fixture
def ctl(db):
    db.execute("CREATE TABLE active_workflows (user_id INTEGER PRIMARY KEY, workflow_id INTEGER NOT NULL, mode TEXT NOT NULL,"
               " trigger_component_id INTEGER, activated_at TEXT NOT NULL, watch_state TEXT NOT NULL DEFAULT 'starting',"
               " watch_message TEXT, watch_checked_at TEXT)")
    db.execute('ALTER TABLE agent_workflows ADD COLUMN enabled INTEGER DEFAULT 1')   # the sweep after clearStartOption reads both
    return CodeComponentsController(db, {})


def req(body=None, params=None, user=3) -> dict:
    return {'user_id': user, 'body': body or {}, 'query': {}, 'params': params or {}}


def test_crud_round_trip(ctl):
    r = ctl.create(req(POLL))
    assert r['success'] is True
    id = r['data']['id']
    assert ctl.show(req({}, {'id': id}))['data']['name'] == 'Poll Inbox'
    assert ctl.index(req())['data'][0]['used_by'] == 0
    u = ctl.update(req({**POLL, 'timeout_s': 60}, {'id': id}))
    assert u['data']['timeout_s'] == 60
    assert ctl.usedBy(req({}, {'id': id}))['data'] == []
    assert ctl.destroy(req({}, {'id': id}))['success'] is True


def test_errors_carry_kind_and_status(ctl):
    r = ctl.show(req({}, {'id': 9}))
    assert [r['kind'], r['status_code']] == ['not_found', 404]
    r = ctl.create(req({**POLL, 'exits': []}))
    assert [r['kind'], r['status_code']] == ['invalid', 422]
    r = ctl.index({'user_id': 0, 'body': {}, 'query': {}, 'params': {}})
    assert r['status_code'] == 401


def test_another_users_component_is_not_found(ctl):
    id = ctl.create(req(POLL, {}, 4))['data']['id']
    assert ctl.show(req({}, {'id': id}))['status_code'] == 404
    assert ctl.usedBy(req({}, {'id': id}))['status_code'] == 404


def test_start_option_round_trip(ctl):
    id = ctl.create(req(POLL))['data']['id']
    s = ctl.setStartOption(req(TRIGGER, {'id': id}))
    assert s['success'] is True
    assert s['data']['start_trigger']['label'] == 'New email'
    assert ctl.startOptionImpact(req({}, {'id': id}))['data'] == []
    d = ctl.destroy(req({}, {'id': id}))
    assert [d['kind'], d['status_code']] == ['is_option', 409]
    assert ctl.clearStartOption(req({}, {'id': id}))['data'] == []
    assert ctl.destroy(req({}, {'id': id}))['success'] is True


def test_a_bad_start_option_is_422(ctl):
    id = ctl.create(req(POLL))['data']['id']
    r = ctl.setStartOption(req({**TRIGGER, 'work_exit': 'job'}, {'id': id}))
    assert [r['success'], r['kind'], r['status_code']] == [False, 'invalid', 422]
