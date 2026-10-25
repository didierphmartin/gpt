"""Ports of backend/tests/Unit/Automation/AutomationStoreTest.php and AutomationsControllerTest.php."""
from __future__ import annotations

import json
import sqlite3

import pytest

from app.agent_team.services.workflow_repository import WorkflowRepository
from app.automation.automation_error import AutomationError
from app.automation.automation_store import AutomationStore
from app.controllers.automations_controller import AutomationsController
from tests.unit.playbook.conftest import SqliteDb

SPEC = {'name': 'okta-reset', 'form': {'variables': [{'name': 'user_email', 'mandatory': True}, {'name': 'reason'}]}}

SCHEMA = [
    "CREATE TABLE automations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, automation_key TEXT NOT NULL,"
    " title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, spec_json TEXT NOT NULL, playbook_id INTEGER, workflow_id INTEGER,"
    " sn_scope TEXT, created_at TEXT, updated_at TEXT, UNIQUE (user_id, automation_key))",
    "CREATE TABLE automation_instances (automation_id INTEGER NOT NULL, mcp_server_id INTEGER NOT NULL, installed_version INTEGER,"
    " sn_item_sys_id TEXT, last_check_at TEXT, status TEXT NOT NULL DEFAULT 'not_installed', detail TEXT, PRIMARY KEY (automation_id, mcp_server_id))",
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT, url TEXT, headers TEXT, enabled INTEGER DEFAULT 1)',
    "CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, workspace_id INTEGER, name TEXT,"
    " description TEXT, steps TEXT, triggers TEXT, variables TEXT, enabled INTEGER DEFAULT 1, output_storage_enabled INTEGER DEFAULT 0,"
    " output_folder TEXT, orchestration TEXT DEFAULT 'workflow', created_at TEXT, updated_at TEXT, automation_id INTEGER)",
    'CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, pkey TEXT, title TEXT, text TEXT, updated_at TEXT, automation_id INTEGER)',
]


def schema(conn: sqlite3.Connection) -> None:
    for s in SCHEMA:
        conn.execute(s)
    conn.commit()


def make_db(path: str = ':memory:', cls=SqliteDb) -> SqliteDb:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.create_function('NOW', 0, lambda: '2026-10-20 10:00:00')
    return cls(conn)


@pytest.fixture
def db():
    d = make_db()
    schema(d.conn)
    return d


@pytest.fixture
def store(db):
    return AutomationStore(db)


def test_create_gives_version_one_and_same_key_bumps_keeping_the_id(db, store):
    a = store.save(3, 'okta-reset', 'Okta', SPEC)
    assert a['version'] == 1
    b = store.save(3, 'okta-reset', 'Okta v2', {**SPEC, 'x': 1})
    assert a['id'] == b['id']
    assert b['version'] == 2
    assert b['title'] == 'Okta v2'
    assert store.get(3, a['id'])['spec']['x'] == 1
    assert db.fetch_column('SELECT COUNT(*) FROM automations')[0] == 1


def test_another_users_key_is_independent(store):
    a = store.save(3, 'okta-reset', 'Okta', SPEC)
    b = store.save(4, 'okta-reset', 'Okta', SPEC)
    assert a['id'] != b['id']
    assert b['version'] == 1
    assert store.get(4, a['id']) is None


@pytest.mark.parametrize('k', ['Okta', 'a', '-x', 'has space', 'a' * 42, 'x_y'])
def test_bad_key_is_rejected(store, k):
    with pytest.raises(AutomationError) as e:
        store.save(3, k, 'T', SPEC)
    assert e.value.status == 400


def test_link_stamps_automation_id_and_refuses_foreign_rows(db, store):
    a = store.save(3, 'okta-reset', 'Okta', SPEC)
    db.execute("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'k', 't', 'x'), (4, 'k2', 't', 'x')")
    db.execute("INSERT INTO agent_workflows (user_id, name) VALUES (3, 'w')")
    r = store.link(3, a['id'], 1, 1)
    assert r['playbook_id'] == 1
    assert r['workflow_id'] == 1
    assert db.fetch_column('SELECT automation_id FROM playbooks WHERE id = 1')[0] == a['id']
    assert db.fetch_column('SELECT automation_id FROM agent_workflows WHERE id = 1')[0] == a['id']
    with pytest.raises(AutomationError) as e:
        store.link(3, a['id'], 2, None)
    assert e.value.status == 404
    assert db.fetch_column('SELECT automation_id FROM playbooks WHERE id = 2')[0] is None


def test_workflow_get_returns_automation_id_after_link(db, store):
    a = store.save(3, 'okta-reset', 'Okta', SPEC)
    db.execute("INSERT INTO agent_workflows (user_id, name) VALUES (3, 'w')")
    store.link(3, a['id'], None, 1)
    repo = WorkflowRepository(db)
    assert repo.findById(1).toArray()['automation_id'] == a['id']
    assert repo.findById(1).toApiArray()['automation_id'] == a['id']
    wf = repo.findById(1)
    repo.update(wf)   # a normal save must not clear the stamp
    assert repo.findById(1).toArray()['automation_id'] == a['id']


def test_replace_spec_does_not_bump_the_version(store):
    a = store.save(3, 'okta-reset', 'Okta', SPEC)
    store.replaceSpec(3, a['id'], {'name': 'okta-reset', 'changed': True})
    row = store.get(3, a['id'])
    assert row['version'] == 1
    assert row['spec']['changed'] is True


# ---------------------------------------------------------------- controller

class FakeMcp:
    def __init__(self):
        self.describe_answers = {}   # server name => callRaw-shaped answer
        self.installCalls = []
        self.installAnswer = {'ok': True, 'result': {'structuredContent': {'installed': True, 'scope': 'x_a'}}}
        self.duringInstall = None

    def describe(self, userId, serverName, key):
        return self.describe_answers.get(serverName, {'ok': False, 'error': 'unreachable'})

    def install(self, url, headerLines, args, timeoutSeconds):
        self.installCalls.append({'url': url, 'headerLines': headerLines, 'args': args, 'timeoutSeconds': timeoutSeconds})
        if self.duringInstall is not None:
            self.duringInstall()
        return self.installAnswer


class GoneAwayDb(SqliteDb):
    """A connection the server dropped while it sat idle (MySQL error 2006 after a minutes-long install)."""
    gone = False

    def _run(self, sql, params):
        if self.gone:
            raise RuntimeError('SQLSTATE[HY000]: General error: 2006 MySQL server has gone away')
        return super()._run(sql, params)


SERVERS = ("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES"
           " ('3', 'ServiceNow PDI', 'https://h/servicenow/pdi/jobs', '{\"Authorization\":\"Bearer SECRET\"}'),"
           " ('3', 'ServiceNow Prod', 'https://h/servicenow/prod/jobs/mcp', NULL),"
           " ('3', 'Outlook', 'https://h/outlook', NULL),"
           " ('4', 'ServiceNow Other', 'https://h/servicenow/o/jobs', NULL)")


class Env:
    def __init__(self):
        self.db = make_db()
        schema(self.db.conn)
        self.db.execute(SERVERS)
        self.mcp = FakeMcp()
        self.ctl = AutomationsController(self.db, {}, self.mcp)

    def create(self, user=3):
        return self.ctl.create(req({'key': 'okta-reset', 'title': 'Okta', 'spec': SPEC}, {}, user))


def req(body=None, params=None, user=3) -> dict:
    return {'user_id': user, 'body': body or {}, 'params': params or {}}


def ok(variables, version=1, env='dev') -> dict:
    return {'ok': True, 'result': {'structuredContent': {'environment': env,
            'item': {'sys_id': 'abc', 'name': 'Okta', 'version': version, 'variables': variables}}}}


@pytest.fixture
def e():
    return Env()


def by_server(r) -> dict:
    return {i['mcp_server_id']: i for i in r['data']['instances']}


def test_install_records_the_scope_on_a_fresh_connection_when_the_old_one_went_away(e, tmp_path):
    path = str(tmp_path / 'auto.db')
    old = make_db(path, GoneAwayDb)
    schema(old.conn)
    old.execute("INSERT INTO mcp_servers (user_id, name, url, headers) VALUES ('3', 'ServiceNow PDI', 'https://h/servicenow/pdi/jobs', NULL)")
    reconnects = {'n': 0}

    def reconnect():
        reconnects['n'] += 1
        return make_db(path)
    ctl = AutomationsController(old, {}, e.mcp, reconnect)
    ctl.create(req({'key': 'okta-reset', 'title': 'Okta', 'spec': SPEC}))

    def gone():
        old.gone = True
    e.mcp.duringInstall = gone
    r = ctl.install(req({'server_id': 1, 'scope': 'x_a', 'files': {'a': 'b'}}, {'id': 1}))
    assert r['status_code'] == 200, json.dumps(r)
    assert reconnects['n'] == 1
    assert make_db(path).fetch_column('SELECT sn_scope FROM automations WHERE id = 1')[0] == 'x_a'


def test_create_returns_shape_and_servers(e):
    r = e.create()
    assert r['status_code'] == 201
    d = r['data']
    assert {k: d[k] for k in ('id', 'key', 'version', 'playbook_id', 'workflow_id')} == \
        {'id': 1, 'key': 'okta-reset', 'version': 1, 'playbook_id': None, 'workflow_id': None}
    assert d['servers'] == [{'id': 1, 'name': 'ServiceNow PDI', 'environment': None},
                            {'id': 2, 'name': 'ServiceNow Prod', 'environment': None}]
    again = e.create()
    assert again['data']['version'] == 2
    assert again['data']['id'] == 1


def test_create_validates(e):
    assert e.ctl.create(req({'key': 'Bad Key', 'title': 'T', 'spec': []}))['status_code'] == 400
    assert e.ctl.create(req({'key': 'okta-reset', 'title': '', 'spec': {'a': 1}}))['status_code'] == 400
    assert e.ctl.create({'body': {}})['status_code'] == 401


def test_update_links_and_replaces_spec_without_bump(e):
    e.create()
    e.db.execute("INSERT INTO playbooks (user_id, pkey, title, text) VALUES (3, 'k', 't', 'x')")
    r = e.ctl.update(req({'playbook_id': 1, 'spec': {'name': 'okta-reset', 'n': 2}}, {'id': 1}))
    assert r['status_code'] == 200
    assert r['data']['playbook_id'] == 1
    assert r['data']['version'] == 1
    assert 'servers' in r['data']
    assert json.loads(e.db.fetch_column('SELECT spec_json FROM automations')[0])['n'] == 2
    assert e.ctl.update(req({'workflow_id': 5}, {'id': 1}))['status_code'] == 404
    assert e.ctl.update(req({'playbook_id': 1}, {'id': 1}, 4))['status_code'] == 404


def test_check_in_sync_missing_variable_not_installed_and_forbidden(e):
    e.create()
    vars = [{'name': 'user_email', 'type': '6', 'mandatory': True}, {'name': 'reason', 'type': '6', 'mandatory': False}]
    e.mcp.describe_answers['ServiceNow PDI'] = ok(vars)
    e.mcp.describe_answers['ServiceNow Prod'] = {'ok': True, 'result': {'structuredContent': {'environment': 'prod', 'item': None}}}
    r = e.ctl.check(req({}, {'id': 1}))
    by = by_server(r)
    assert by[1]['status'] == 'in_sync'
    assert by[1]['installed_version'] == 1
    assert by[1]['sn_item_sys_id'] == 'abc'
    assert by[1]['environment'] == 'dev'
    assert by[2]['status'] == 'not_installed'
    # servers now carry the environment from the latest check
    assert r['data']['servers'][0]['environment'] == 'dev'
    assert r['data']['servers'][1]['environment'] == 'prod'

    # drift: reason missing, mandatory flipped, older version
    e.mcp.describe_answers['ServiceNow PDI'] = ok([{'name': 'user_email', 'type': '6', 'mandatory': False},
                                                   {'name': 'extra', 'type': '6', 'mandatory': False}], 0)
    by = by_server(e.ctl.check(req({}, {'id': 1})))
    assert by[1]['status'] == 'out_of_sync'
    for needle in ('reason', 'extra', 'user_email', 'version'):
        assert needle in by[1]['detail']
    assert e.db.fetch_column('SELECT COUNT(*) FROM automation_instances WHERE mcp_server_id = 1')[0] == 1

    e.mcp.describe_answers['ServiceNow PDI'] = {'ok': True, 'result': {'isError': True, 'structuredContent': {
        'error': {'code': 'forbidden', 'message': 'no read'}}}}
    del e.mcp.describe_answers['ServiceNow Prod']
    by = by_server(e.ctl.check(req({}, {'id': 1})))
    assert by[1]['status'] == 'out_of_sync'
    assert by[1]['detail'] == 'cannot check: forbidden'
    assert by[2]['status'] == 'out_of_sync'
    assert by[2]['detail'] == 'cannot check: unreachable'


def test_check_reads_the_loaders_text_answer(e):
    e.create()
    live = json.loads('{"content":[{"type":"text","text":"{\\"environment\\":\\"dev\\",\\"item\\":null}"}],'
                      '"structuredContent":{"environment":"dev","item":null},"isError":false}')
    e.mcp.describe_answers['ServiceNow PDI'] = {'ok': True, 'result': live}
    by = by_server(e.ctl.check(req({}, {'id': 1})))
    assert by[1]['status'] == 'not_installed'
    assert by[1]['environment'] == 'dev'


def test_check_reads_a_garbled_describe_answer_as_bad_answer(e):
    e.create()
    e.mcp.describe_answers['ServiceNow PDI'] = {'ok': True, 'result': {'structuredContent': {'environment': 'dev'}}}
    e.mcp.describe_answers['ServiceNow Prod'] = {'ok': True, 'result': {'structuredContent': {'environment': 'prod', 'item': 'abc'}}}
    by = by_server(e.ctl.check(req({}, {'id': 1})))
    for sid in (1, 2):
        assert by[sid]['status'] == 'out_of_sync'
        assert by[sid]['detail'] == 'cannot check: bad_answer'


def test_check_ignores_other_users_and_automations(e):
    e.create()
    assert e.ctl.check(req({}, {'id': 1}, 4))['status_code'] == 404


def test_list_includes_instances_and_servers(e):
    e.create()
    e.mcp.describe_answers['ServiceNow PDI'] = ok([])
    e.ctl.check(req({}, {'id': 1}))
    r = e.ctl.index(req())
    assert len(r['data']) == 1
    assert len(r['data'][0]['instances']) == 2
    assert len(r['data'][0]['servers']) == 2
    assert e.ctl.index(req({}, {}, 4))['data'] == []


def test_deploy_url_derivation():
    assert AutomationsController.deployUrl('https://h/servicenow/pdi/jobs') == 'https://h/servicenow/pdi/deploy'
    assert AutomationsController.deployUrl('https://h/servicenow/pdi/jobs/mcp') == 'https://h/servicenow/pdi/deploy'
    assert AutomationsController.deployUrl('https://h/servicenow/pdi/jobs/') == 'https://h/servicenow/pdi/deploy'
    assert AutomationsController.deployUrl('https://h/servicenow/pdi/other') is None


def test_install_sends_stored_headers_and_never_returns_them(e):
    e.create()
    r = e.ctl.install(req({'server_id': 1, 'scope': 'x_a', 'files': {'package.json': '{}'}}, {'id': 1}))
    assert r['status_code'] == 200
    call = e.mcp.installCalls[0]
    assert call['url'] == 'https://h/servicenow/pdi/deploy'
    assert 'Authorization: Bearer SECRET' in call['headerLines']
    assert call['timeoutSeconds'] == 900
    assert call['args'] == {'scope': 'x_a', 'files': {'package.json': '{}'}}
    assert 'SECRET' not in json.dumps(r)
    assert e.db.fetch_column('SELECT sn_scope FROM automations')[0] == 'x_a'


def test_install_errors_map_to_statuses(e):
    e.create()
    body = {'server_id': 1, 'scope': 'x_a', 'files': {'a': 'b'}}
    e.mcp.installAnswer = {'ok': True, 'result': {'isError': True, 'structuredContent': {'error': {'code': 'not_allowed', 'message': 'prod'}}}}
    r = e.ctl.install(req(body, {'id': 1}))
    assert r['status_code'] == 409
    assert r['code'] == 'not_allowed'
    # the connector's message (for install_failed: the step and its log tail) reaches the caller
    e.mcp.installAnswer = {'ok': True, 'result': {'isError': True, 'structuredContent': {'error': {
        'code': 'install_failed', 'message': 'exit 1 from npx now-sdk install: 401 Unauthorized'}}}}
    r = e.ctl.install(req(body, {'id': 1}))
    assert r['code'] == 'install_failed'
    assert r['message'] == 'exit 1 from npx now-sdk install: 401 Unauthorized'
    e.mcp.installAnswer = {'ok': False, 'error': 'unreachable'}
    assert e.ctl.install(req(body, {'id': 1}))['status_code'] == 502
    # a server of another user, a non-ServiceNow URL, a bad body
    assert e.ctl.install(req({**body, 'server_id': 4}, {'id': 1}))['status_code'] == 404
    assert e.ctl.install(req({**body, 'server_id': 3}, {'id': 1}))['status_code'] == 400
    assert e.ctl.install(req({**body, 'files': []}, {'id': 1}))['status_code'] == 400
