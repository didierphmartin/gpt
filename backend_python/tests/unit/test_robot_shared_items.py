"""Port of backend/tests/Unit/Services/RobotSharedItemsTest.php: components, playbooks and agents owned by the robot
are shared with every robot-permitted user."""
from __future__ import annotations

import json

import pytest

from app.agent_team.controllers.agent_controller import AgentController
from app.agent_team.services.workflow_graph_repository import WorkflowGraphRepository
from app.agent_team.services.workflow_ref_resolver import UnresolvedRefsException, WorkflowRefResolver
from app.code_component.code_component_error import CodeComponentError
from app.code_component.code_component_store import CodeComponentStore
from app.playbook.playbook_store import PlaybookStore, PlaybookStoreError
from tests.unit.playbook.conftest import OKTA, sqlite_db


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv('GPT_EDITION', 'individual')
    d = sqlite_db(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT, role TEXT, kind TEXT NOT NULL DEFAULT 'person')",
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)',
        'CREATE TABLE code_components (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,'
        ' description TEXT, code TEXT NOT NULL, exits TEXT NOT NULL, mcp_servers TEXT NOT NULL, timeout_s INTEGER NOT NULL DEFAULT 30,'
        ' start_trigger TEXT, args TEXT, provides TEXT, created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))',
        'CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,'
        ' title TEXT NOT NULL, text TEXT NOT NULL, automation_id INTEGER, published_by INTEGER, published_at TEXT, source_id INTEGER,'
        ' created_at TEXT, updated_at TEXT, UNIQUE (user_id, pkey))',
        'CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)',
        'CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER,'
        ' config TEXT, pos_x INTEGER, pos_y INTEGER, drawflow_node_id TEXT)',
        "CREATE TABLE workflow_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, from_node_id INTEGER,"
        " to_node_id INTEGER, from_port TEXT DEFAULT 'output_1', to_port TEXT DEFAULT 'input_1', condition_expr TEXT, created_at TEXT)",
        "CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER,"
        " category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER,"
        " can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT,"
        " playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT,"
        " created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))")
    d.execute("INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}')")
    d.execute("INSERT INTO users (id, email, role, kind) VALUES (3, 'p@x.test', 'user', 'person'), (4, 'q@x.test', 'user', 'person'),"
              " (120, 'r@x.test', 'robot', 'service')")
    return d


def component(db, owner, name):
    return CodeComponentStore(db).save(owner, None, {'name': name, 'code': 'def run(i, c): return "ok"', 'exits': ['done'],
                                                     'mcp_servers': []})['id']


def node(db, wf, type_, cfg, id=None):
    if id is None:
        return db.insert('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)', [wf, type_, json.dumps(cfg)])
    return db.insert('INSERT INTO workflow_nodes (id, workflow_id, node_type, config) VALUES (?, ?, ?, ?)', [id, wf, type_, json.dumps(cfg)])


def count(db, table):
    return db.fetch_one(f'SELECT COUNT(*) AS n FROM {table}')['n']


def test_personal_workflow_keeps_linked_robot_component_and_playbook(db):
    cid = component(db, 120, 'robot_comp')
    pid = PlaybookStore(db).save(120, None, OKTA, 'okta-reset')['id']
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine')")
    node(db, 9, 'code', {'type': 'code', 'code_component_id': cid})
    node(db, 9, 'playbook', {'type': 'playbook', 'playbook_id': pid})
    nodes = WorkflowGraphRepository(db).getGraph(9)['nodes']
    assert nodes[0]['config']['code'] == 'def run(i, c): return "ok"'
    assert 'code_component_missing' not in nodes[0]['config']
    assert 'playbook_missing' not in nodes[1]['config']
    assert nodes[1]['config']['playbook']


def test_list_includes_robot_rows_only_when_the_robot_id_is_given(db):
    component(db, 120, 'robot_comp')
    component(db, 3, 'mine')
    store = CodeComponentStore(db)
    with_ = store.list(3, 120)
    assert [r['name'] for r in with_] == ['mine', 'robot_comp']
    assert [r['is_robot'] for r in with_] == [False, True]
    assert [r['name'] for r in store.list(3)] == ['mine']
    assert store.list(4) == []


def test_playbook_list_and_get_carry_robot_rows(db):
    pid = PlaybookStore(db).save(120, None, OKTA, 'okta-reset')['id']
    s = PlaybookStore(db)
    assert s.list(3, 120)[0]['is_robot'] is True
    assert s.get(3, pid, 120)['is_robot'] is True
    assert s.list(3) == []
    assert s.get(3, pid) is None


def test_saving_a_robot_component_updates_the_robots_row(db):
    cid = component(db, 120, 'robot_comp')
    store = CodeComponentStore(db)
    row = store.save(3, cid, {'name': 'robot_comp', 'code': 'x = 1', 'exits': ['done'], 'mcp_servers': []}, 120)
    assert (row['id'], row['is_robot'], row['code']) == (cid, True, 'x = 1')
    assert count(db, 'code_components') == 1
    assert store.save(3, None, {'name': 'fresh', 'code': '', 'exits': ['done'], 'mcp_servers': []}, 120)['is_robot'] is False


def test_used_by_finds_the_robots_workflows_too(db):
    cid = component(db, 3, 'mine')
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (75, '120', 'Robot wf')")
    node(db, 75, 'code', {'type': 'code', 'code_component_id': cid})
    store = CodeComponentStore(db)
    assert len(store.usedBy(3, cid)) == 0
    assert len(store.usedBy(3, cid, 120)) == 1


def agent_update(db, user, edition, id, body):
    return AgentController(db, {'edition': edition}).update({'user_id': user, 'params': {'id': id}, 'agent_id': id, 'body': body}, id)


def test_robot_permitted_user_updates_a_robot_agent_in_place(db):
    db.execute("INSERT INTO agents (id, user_id, name, instructions) VALUES (50, 120, 'Robot agent', 'old')")
    r = agent_update(db, 3, 'individual', 50, {'instructions': 'new'})
    assert r['success'] is True, r
    row = db.fetch_one('SELECT user_id, instructions FROM agents WHERE id = 50')
    assert (int(row['user_id']), row['instructions']) == (120, 'new')
    assert count(db, 'agents') == 1


def test_user_without_robot_permission_gets_404(db):
    db.execute("INSERT INTO agents (id, user_id, name, instructions) VALUES (50, 120, 'Robot agent', 'old')")
    r = agent_update(db, 4, 'corporate', 50, {'instructions': 'new'})
    assert r['status_code'] == 404
    assert db.fetch_one('SELECT instructions FROM agents WHERE id = 50')['instructions'] == 'old'


def link_from_personal_workflow(db, cid):
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine')")
    node(db, 9, 'code', {'type': 'code', 'code_component_id': cid}, id=1)


def test_a_robot_component_linked_by_a_personal_workflow_cannot_be_deleted(db):
    cid = component(db, 120, 'robot_comp')
    link_from_personal_workflow(db, cid)
    store = CodeComponentStore(db)
    assert len(store.usedBy(3, cid, 120)) == 1
    with pytest.raises(CodeComponentError) as e:
        store.delete(3, cid, 120)
    assert e.value.kind == 'in_use'


def test_exit_change_on_a_robot_component_remaps_personal_workflow_edges(db):
    store = CodeComponentStore(db)
    cid = store.save(120, None, {'name': 'rc', 'code': '', 'exits': ['a', 'b'], 'mcp_servers': []})['id']
    link_from_personal_workflow(db, cid)
    db.execute("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (9, 1, 2, 'output_2')")
    store.save(3, cid, {'name': 'rc', 'code': '', 'exits': ['b', 'c'], 'mcp_servers': [], 'confirm_drop_links': True}, 120)
    assert db.fetch_one('SELECT from_port FROM workflow_edges')['from_port'] == 'output_1'


def test_a_workflow_of_a_user_without_robot_permission_never_resolves_robot_rows(db, monkeypatch):
    monkeypatch.setenv('GPT_EDITION', 'corporate')
    cid = component(db, 120, 'robot_comp')
    link_from_personal_workflow(db, cid)
    cfg = WorkflowGraphRepository(db).getGraph(9)['nodes'][0]['config']
    assert cfg['code_component_missing'] is True
    assert 'code' not in cfg


def test_robot_permitted_user_edits_and_deletes_a_robot_playbook_in_place(db):
    s = PlaybookStore(db)
    pid = s.save(120, None, OKTA, 'okta-reset')['id']
    row = s.save(3, pid, OKTA, None, 120)
    assert (row['id'], row['is_robot']) == (pid, True)
    assert count(db, 'playbooks') == 1
    assert s.save(3, None, OKTA, 'mine', 120)['is_robot'] is False
    s.delete(3, pid, 120)
    assert count(db, 'playbooks') == 1
    with pytest.raises(PlaybookStoreError):
        s.delete(4, pid)


def published_copy(db):
    s = PlaybookStore(db)
    src = s.save(3, None, OKTA, 'okta-reset')['id']
    return s.publish(3, src, 120, False)['id']


def test_the_robots_published_copies_are_not_shared_rows(db):
    copy = published_copy(db)
    s = PlaybookStore(db)
    assert [r for r in s.list(4, 120) if r['id'] == copy] == []
    assert s.get(4, copy, 120) is None
    for write in (lambda: s.save(4, copy, OKTA, None, 120), lambda: s.delete(4, copy, 120)):
        with pytest.raises(PlaybookStoreError) as e:
            write()
        assert e.value.kind == 'not_found'
    # the publish mechanism still sees it
    assert [r['id'] for r in s.robotList(120)] == [copy]
    assert s.publishStatus(3, 120) == {1: 'published'}
    assert s.get(120, copy) is not None


def test_links_never_resolve_to_a_published_copy(db):
    copy = published_copy(db)
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '4', 'Theirs')")
    node(db, 9, 'playbook', {'type': 'playbook', 'playbook_id': copy})
    assert WorkflowGraphRepository(db).getGraph(9)['nodes'][0]['config']['playbook_missing'] is True
    with pytest.raises(UnresolvedRefsException) as e:
        WorkflowRefResolver(db).resolve(4, [{'id': '1', 'config': {'playbook_ref': 'okta-reset'}}], [], 120)
    assert e.value.missing == ["playbook 'okta-reset'"]
    # usedBy of the copy is not the robot fallback's every-user scan
    assert PlaybookStore(db).usedBy(3, copy, 120)['nodes'] == []


def linked_everywhere(db):
    """A robot component (exits a, b, c) linked from user 3's wf 9, user 4's wf 10 and the robot's wf 75, each with an edge on b."""
    cid = CodeComponentStore(db).save(120, None, {'name': 'rc', 'code': '', 'exits': ['a', 'b', 'c'], 'mcp_servers': []})['id']
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine'), (10, '4', 'Secret of 4'), (75, '120', 'Robot wf')")
    for wf in (9, 10, 75):
        n = node(db, wf, 'code', {'type': 'code', 'name': f'N{wf}', 'code_component_id': cid})
        db.execute("INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (?, ?, 99, 'output_2')", [wf, n])
    return cid


def test_other_users_workflows_are_counted_not_named(db):
    cid = linked_everywhere(db)
    store = CodeComponentStore(db)
    used = store.usedBy(3, cid, 120)
    assert [u['workflow_name'] for u in used[:2]] == ['Mine', 'Robot wf']
    assert used[2] == {'others': 1}
    assert 'Secret' not in json.dumps(used)
    assert store.list(3, 120)[0]['used_by'] == 3   # the count is every link
    with pytest.raises(CodeComponentError) as e:
        store.delete(3, cid, 120)
    assert e.value.kind == 'in_use'
    assert '"Mine"' in str(e.value) and '1 other workflow' in str(e.value) and 'Secret' not in str(e.value)
    with pytest.raises(CodeComponentError) as e:
        store.save(3, cid, {'name': 'rc', 'code': '', 'exits': ['a', 'c'], 'mcp_servers': []}, 120)
    assert e.value.kind == 'links_dropped'
    assert [l['workflow_name'] for l in e.value.data[:2]] == ['Mine', 'Robot wf']
    assert e.value.data[2] == {'others': 1, 'count': 1}
    assert 'Secret' not in str(e.value) + json.dumps(e.value.data)


def test_start_option_impact_counts_other_users_workflows(db):
    db.execute('CREATE TABLE scheduled_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workflow_id INTEGER,'
               ' event_trigger TEXT, trigger_component_id INTEGER)')
    store = CodeComponentStore(db)
    cid = store.save(120, None, {'name': 'poll', 'code': '', 'exits': ['new_mail', 'none'], 'mcp_servers': ['Outlook']})['id']
    store.setStartTrigger(120, cid, {'label': 'New', 'work_exit': 'new_mail',
                                     'watch': {'server': 'Outlook', 'tool': 'wait_for_new', 'args': []}})
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine'), (10, '4', 'Secret of 4')")
    db.execute(f'INSERT INTO scheduled_workflows (user_id, workflow_id, trigger_component_id) VALUES (4, 10, {cid})')
    node(db, 9, 'start', {'type': 'start', 'start_option': cid})
    assert store.startTriggerImpact(3, cid, 120) == [{'workflow_id': 9, 'workflow_name': 'Mine'}, {'others': 1}]


def test_playbook_used_by_counts_other_users_links(db):
    s = PlaybookStore(db)
    pid = s.save(120, None, OKTA, 'okta-reset')['id']
    db.execute("INSERT INTO agent_workflows (id, user_id, name) VALUES (9, '3', 'Mine'), (10, '4', 'Secret of 4')")
    for wf in (9, 10):
        node(db, wf, 'playbook', {'type': 'playbook', 'name': f'P{wf}', 'playbook_id': pid})
    db.execute(f"INSERT INTO agents (user_id, name, playbook_id) VALUES (4, 'Secret agent', {pid}), (3, 'My agent', {pid})")
    used = s.usedBy(3, pid, 120)
    assert [[a['name'] for a in used['agents']], [n['workflow_name'] for n in used['nodes']], used['others']] == [['My agent'], ['Mine'], 2]
    assert s.list(3, 120)[0]['used_by'] == 4
    with pytest.raises(PlaybookStoreError) as e:
        s.delete(3, pid, 120)
    m = str(e.value)
    assert '"Mine"' in m and '1 other workflow' in m and '1 other agent' in m and 'Secret' not in m
