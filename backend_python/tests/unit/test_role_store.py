"""Port of backend/tests/Unit/Services/RoleStoreTest.php."""
from __future__ import annotations

import json

import pytest

from app.services.role_store import RoleStore, RoleStoreError
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def db():
    d = sqlite_db(
        'CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER DEFAULT 0, capabilities TEXT, '
        'updated_at TEXT, updated_by INTEGER)',
        "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, role TEXT, kind TEXT DEFAULT 'person')")
    for r in ('guest', 'prospect', 'user', 'admin'):
        caps = json.dumps({'providers': [], 'sidebar': [], 'quota_tokens': 500 if r == 'user' else None})
        d.execute('INSERT INTO packages (role, name, builtin, capabilities) VALUES (?, ?, 1, ?)', [r, None, caps])
    return d


@pytest.fixture
def store(db):
    return RoleStore(db)


def refusal(fn) -> RoleStoreError:
    with pytest.raises(RoleStoreError) as e:
        fn()
    return e.value


def test_create_copies_another_roles_capabilities(store):
    row = store.create('it-ops-2', 'IT Ops', 'user')
    assert row['role'] == 'it-ops-2'
    assert row['name'] == 'IT Ops'
    assert row['builtin'] is False
    assert row['capabilities'] == store.get('user')['capabilities']
    assert store.exists('it-ops-2')


def test_invalid_key_is_422(store):
    e = refusal(lambda: store.create('IT Ops', 'IT Ops', None))
    assert [e.kind, e.status] == ['invalid_key', 422]
    e = refusal(lambda: store.create('a' * 65, 'x', None))
    assert e.kind == 'invalid_key'


def test_duplicate_is_409(store):
    e = refusal(lambda: store.create('user', 'Again', None))
    assert [e.kind, e.status] == ['exists', 409]


def test_rename(store):
    store.create('ops', 'Ops', None)
    assert store.rename('ops', 'Operators')['name'] == 'Operators'
    e = refusal(lambda: store.rename('nope', 'X'))
    assert [e.kind, e.status] == ['not_found', 404]


def test_built_in_cannot_be_deleted(store):
    e = refusal(lambda: store.delete('user'))
    assert [e.kind, e.status] == ['builtin', 409]
    assert str(e) == "Built-in roles can't be deleted"


def test_delete_refused_while_person_holds_it(db, store):
    store.create('ops', 'Ops', None)
    db.execute("INSERT INTO users (email, role) VALUES ('ann@x.test', 'ops')")
    e = refusal(lambda: store.delete('ops'))
    assert [e.kind, e.status] == ['in_use', 409]
    assert 'ann@x.test' in str(e)


def test_robot_holding_a_role_does_not_count(db, store):
    store.create('ops', 'Ops', None)
    db.execute("INSERT INTO users (email, role, kind) VALUES ('robot@synergyai.invalid', 'ops', 'service')")
    assert store.usersWith('ops') == []
    store.delete('ops')
    assert not store.exists('ops')


def test_list_puts_built_ins_first_with_names_and_usage(db, store):
    store.create('ops', 'Ops', None)
    db.execute("INSERT INTO users (email, role) VALUES ('a@x.test', 'user')")
    rows = store.list()
    assert [r['role'] for r in rows] == ['guest', 'prospect', 'user', 'admin', 'robot', 'ops']
    assert rows[2]['name'] == 'User'
    assert rows[2]['builtin'] is True
    assert rows[2]['used_by'] == 1
    assert rows[5]['used_by'] == 0


def test_is_valid_key():
    assert RoleStore.isValidKey('it-ops-2') and RoleStore.isValidKey('2024')
    assert not RoleStore.isValidKey('ops-') and not RoleStore.isValidKey('ops\n') and not RoleStore.isValidKey('a--b')
