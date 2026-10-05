"""Port of backend/tests/Unit/AgentTeam/AgentPlaybookLinkTest.php: playbook agents
link to the collection by playbook_id, over a real in-memory sqlite (the repository
is not faked here, the link is stored in the agents table)."""
from __future__ import annotations

import pytest

from app.agent_team.controllers.agent_controller import AgentController
from app.playbook.playbook_store import PlaybookStore
from tests.unit.playbook.conftest import OKTA, SqliteDb, make_sqlite_db

AGENTS_DDL = (
    "CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER, "
    "category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER, "
    "can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT, "
    "playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT, "
    "created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))"
)
PLAYBOOKS_DDL = (
    'CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL, '
    'title TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, updated_at TEXT, UNIQUE (user_id, pkey))'
)


class _Db(SqliteDb):
    """The controller's constructor probes MySQL's SHOW TABLES; answer it as 'no such table'."""

    def fetch_all(self, sql, params=None):
        if sql.lstrip().upper().startswith('SHOW'):
            return []
        return super().fetch_all(sql, params)

    def fetch_one(self, sql, params=None):
        if sql.lstrip().upper().startswith('SHOW'):
            return None
        return super().fetch_one(sql, params)


@pytest.fixture
def db():
    d = _Db(make_sqlite_db().conn)
    d.execute(PLAYBOOKS_DDL)
    d.execute(AGENTS_DDL)
    return d


def ctl(db):
    return AgentController(db, {'auth': {'jwt_secret': 'S'}, 'database': {}, 'contexts_database': {}})


def create(db, body, user=3):
    return ctl(db).create({'user_id': user, 'body': body})


def update(db, id_, body, user=3):
    return ctl(db).update({'user_id': user, 'params': {'id': id_}, 'agent_id': id_, 'body': body}, id_)


def plain_agent(db, type_='playbook', **extra):
    r = create(db, {'name': 'A' + type_, 'agent_type': type_, **extra})
    assert r['success'] is True, r
    return int(r['data']['id'])


def test_a_playbook_agent_links_and_keeps_no_text(db):
    pb = PlaybookStore(db).save(3, None, OKTA, 'okta-reset')
    r = create(db, {'name': 'Okta agent', 'agent_type': 'playbook', 'playbook_id': pb['id']})
    assert r['success'] is True, r
    assert int(r['data']['playbook_id']) == pb['id']
    assert str(r['data']['instructions']) == ''


def test_an_unknown_playbook_is_refused(db):
    r = create(db, {'name': 'X', 'agent_type': 'playbook', 'playbook_id': 99})
    assert r['status_code'] == 404
    assert r['error'] == 'Playbook #99 not found'


def test_update_links_and_empties_instructions(db):
    pb = PlaybookStore(db).save(3, None, OKTA, 'okta-reset')
    id_ = plain_agent(db, 'playbook', instructions='old text')
    r = update(db, id_, {'playbook_id': pb['id']})
    assert r['success'] is True, r
    assert int(r['data']['playbook_id']) == pb['id']
    assert str(r['data']['instructions']) == ''


def test_update_with_unknown_or_foreign_playbook_is_404(db):
    foreign = PlaybookStore(db).save(9, None, OKTA, 'okta-reset')
    id_ = plain_agent(db)
    for bad in [99, foreign['id']]:
        r = update(db, id_, {'playbook_id': bad})
        assert r['status_code'] == 404
        assert r['error'] == f'Playbook #{bad} not found'


def test_linked_agent_keeps_instructions_empty_on_update(db):
    pb = PlaybookStore(db).save(3, None, OKTA, 'okta-reset')
    id_ = plain_agent(db, 'playbook', playbook_id=pb['id'])
    r = update(db, id_, {'instructions': 'stale text'})
    assert r['success'] is True, r
    assert str(r['data']['instructions']) == ''
    assert int(r['data']['playbook_id']) == pb['id']


def test_standard_agent_stores_no_link(db):
    pb = PlaybookStore(db).save(3, None, OKTA, 'okta-reset')
    r = create(db, {'name': 'S', 'agent_type': 'standard', 'playbook_id': pb['id']})
    assert r['success'] is True, r
    assert r['data']['playbook_id'] is None
    u = update(db, int(r['data']['id']), {'playbook_id': pb['id']})
    assert u['data']['playbook_id'] is None
