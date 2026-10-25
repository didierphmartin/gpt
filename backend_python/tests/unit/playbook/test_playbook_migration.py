"""Port of backend/tests/Unit/Playbook/PlaybookMigrationTest.php."""
from __future__ import annotations

import json

import pytest

from app.playbook.playbook_migration import PlaybookMigration
from app.playbook.playbook_store import PlaybookStore


def text(title: str) -> str:
    return f'Title: {title}\nTrigger: When asked.\nInstructions:\n1. Do it.\n'


class Env:
    def __init__(self, db):
        self.db = db
        ins = "INSERT INTO agents (user_id, name, agent_type, instructions) VALUES (3, ?, 'playbook', ?)"
        self.firstAgent = db.insert(ins, ['A1', text('Okta password reset')])
        db.insert(ins, ['A2', text('Okta password reset')])
        self.badAgent = db.insert(ins, ['Bad', 'Trigger: x\nInstructions: y\n'])
        db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'WF')")
        for cfg in [
            {'name': 'N1', 'agent_id': self.firstAgent, 'playbook': 'stale'},
            {'name': 'N2', 'agent_id': self.firstAgent},
            {'name': 'N3', 'playbook': text('Leave')},
            {'name': 'N4', 'playbook': {
                'title': 'Json one', 'trigger': {'kind': 'request', 'description': 'Asked'},
                'instructions': '1. #Do It', 'tools_used': ['X', 'Y'], 'actions_used': ['#Do It'],
                'bindings': {'#Do It': 'x.y', '#Skip': None}}},
        ]:
            self.addNode(cfg)

    def n(self, sql) -> int:
        return int(self.db.fetch_column(sql)[0])

    def addNode(self, cfg) -> int:
        return self.db.insert("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', ?)", [json.dumps(cfg)])

    def cfg(self, id) -> dict:
        return json.loads(self.db.fetch_column(f'SELECT config FROM workflow_nodes WHERE id = {id}')[0])


@pytest.fixture
def e(pbc_db):
    return Env(pbc_db)


def test_dry_run_reports_and_changes_nothing(e):
    report = PlaybookMigration(e.db).run(False)
    assert e.n('SELECT COUNT(*) FROM playbooks') == 0
    assert e.n('SELECT COUNT(*) FROM agents WHERE playbook_id IS NOT NULL') == 0
    assert e.n("SELECT COUNT(*) FROM agents WHERE instructions <> ''") == 3
    assert e.n("""SELECT COUNT(*) FROM workflow_nodes WHERE config LIKE '%"playbook"%'""") == 3
    assert len(report['created']) == 4
    assert report['agents_linked'] == 2
    assert report['nodes_linked'] == 4


def test_write_moves_everything_into_the_collection(e):
    report = PlaybookMigration(e.db).run(True)
    assert e.n('SELECT COUNT(*) FROM playbooks') == 4
    assert e.db.fetch_column('SELECT pkey FROM playbooks ORDER BY id') == ['okta-password-reset', 'okta-password-reset-2', 'leave', 'json-one']
    assert report['suffixed'] == [{'title': 'Okta password reset', 'pkey': 'okta-password-reset-2'}]
    assert report['dropped_bindings'] == [{'title': 'Json one', 'action': '#Do It', 'tool': 'x.y'}]

    a1 = e.db.fetch_one("SELECT playbook_id, instructions FROM agents WHERE name = 'A1'")
    assert str(a1['instructions']) == ''
    cfgs = [json.loads(c) for c in e.db.fetch_column('SELECT config FROM workflow_nodes ORDER BY id')]
    assert cfgs[0]['playbook_id'] == int(a1['playbook_id'])
    assert cfgs[1]['playbook_id'] == cfgs[0]['playbook_id']
    for cfg in cfgs:
        assert 'playbook' not in cfg
        assert isinstance(cfg['playbook_id'], int)
    js = e.db.fetch_column("SELECT text FROM playbooks WHERE pkey = 'json-one'")[0]
    assert "Title: Json one\nTrigger: Asked\nInstructions:\n1. #Do It\nTools used: X; Y\nActions used: #Do It" in js

    assert len(report['errors']) == 1
    assert 'Title' in report['errors'][0]['error']
    bad = e.db.fetch_one(f'SELECT playbook_id, instructions FROM agents WHERE id = {e.badAgent}')
    assert bad['playbook_id'] is None
    assert bad['instructions'] == 'Trigger: x\nInstructions: y\n'
    assert report['agents_linked'] == 2
    assert report['nodes_linked'] == 4


def test_a_node_never_links_to_another_users_agent(e):
    other = e.db.insert("INSERT INTO agents (user_id, name, agent_type, instructions) VALUES (4, 'Other', 'playbook', 'Title: Theirs\nInstructions: x\n')")
    own = e.addNode({'name': 'Own', 'agent_id': other, 'playbook': text('Mine')})
    none = e.addNode({'name': 'None', 'agent_id': other})
    report = PlaybookMigration(e.db).run(True)
    theirs = int(e.db.fetch_column('SELECT id FROM playbooks WHERE user_id = 4')[0])
    mine = e.db.fetch_one("SELECT id, user_id FROM playbooks WHERE pkey = 'mine'")
    assert int(mine['user_id']) == 3
    assert e.cfg(own)['playbook_id'] == int(mine['id'])
    assert e.cfg(own)['playbook_id'] != theirs
    assert 'playbook_id' not in e.cfg(none)
    assert f'node #{none} "None" in workflow "WF"' in [x['from'] for x in report['errors']]


def test_a_node_takes_the_playbook_of_an_already_linked_agent(e):
    pb = PlaybookStore(e.db).save(3, None, text('Linked'), None)
    agent = e.db.insert(f"INSERT INTO agents (user_id, name, agent_type, instructions, playbook_id) VALUES (3, 'L', 'playbook', '', {pb['id']})")
    node = e.addNode({'name': 'L1', 'agent_id': agent, 'playbook': text('Linked')})
    PlaybookMigration(e.db).run(True)
    assert e.cfg(node)['playbook_id'] == pb['id']
    assert 'playbook' not in e.cfg(node)
    assert e.n("SELECT COUNT(*) FROM playbooks WHERE title = 'Linked'") == 1


def test_a_failure_mid_run_leaves_the_database_unchanged(e):
    def snap():
        return [e.db.fetch_all('SELECT * FROM playbooks'), e.db.fetch_all('SELECT * FROM agents'),
                e.db.fetch_all('SELECT * FROM workflow_nodes')]
    before = snap()

    class Boom(PlaybookMigration):
        seen = 0

        def nodeLinked(self, nodeId):
            self.seen += 1
            if self.seen == 2:
                raise RuntimeError('boom')
    with pytest.raises(RuntimeError, match='boom'):
        Boom(e.db).run(True)
    assert snap() == before
    assert e.db.inTransaction() is False


def test_a_json_node_keeps_its_policy_and_approvers_on_the_node_and_the_report_says_so(e):
    node = e.addNode({'name': 'P', 'playbook': {
        'title': 'Gated', 'instructions': '1. Do it.',
        'policy': {'writes_enabled': True, 'on_failure': 'stop'}, 'approvers': ['alice']}})
    report = PlaybookMigration(e.db).run(True)
    policy = {'writes_enabled': True, 'on_unbound': 'handoff', 'on_failure': 'stop'}
    assert report['dropped_policy'] == [{'title': 'Gated', 'policy': policy, 'approvers': ['alice']}]
    cfg = e.cfg(node)
    assert isinstance(cfg['playbook_id'], int)
    assert cfg['policy'] == policy
    assert cfg['approvers'] == ['alice']
    # A JSON node with the default policy and no approvers reports nothing (N4 of setUp).
    assert 'Json one' not in [x['title'] for x in report['dropped_policy']]


def test_a_node_falls_back_to_its_agent_id_column(e):
    node = e.db.insert("INSERT INTO workflow_nodes (workflow_id, node_type, agent_id, config) VALUES (1, 'playbook', ?, ?)",
                       [e.firstAgent, json.dumps({'name': 'Col'})])
    PlaybookMigration(e.db).run(True)
    a1 = int(e.db.fetch_column(f'SELECT playbook_id FROM agents WHERE id = {e.firstAgent}')[0])
    assert e.cfg(node)['playbook_id'] == a1
