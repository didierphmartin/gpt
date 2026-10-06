"""Port of backend/tests/Unit/Playbook/PlaybookPublishTest.php."""
from __future__ import annotations

import pytest

from app.playbook.playbook_store import PlaybookStore, PlaybookStoreError
from tests.unit.playbook.conftest import OKTA

ROBOT = 99


@pytest.fixture
def store(pbc_db):
    pbc_db.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, first_name TEXT, last_name TEXT)')
    pbc_db.execute("INSERT INTO users VALUES (3, 'ann@x.test', 'Ann', 'Lee'), (4, 'bob@x.test', '', ''), "
                   "(99, 'robot@synergyai.invalid', 'SynergyAI', 'Operations')")
    return PlaybookStore(pbc_db)


def error(fn) -> PlaybookStoreError:
    with pytest.raises(PlaybookStoreError) as e:
        fn()
    return e.value


def test_first_publish_copies_text_and_key_and_stamps_the_columns(store):
    src = store.save(3, None, OKTA, None)
    row = store.publish(3, src['id'], ROBOT, False)
    assert row['pkey'] == src['pkey']
    assert row['text'] == OKTA
    assert int(row['source_id']) == src['id']
    assert int(row['published_by']) == 3
    assert row['published_at']
    assert store.getByKey(3, 'x') is None
    assert len(store.list(3)) == 1
    assert store.list(4) == []


def test_republish_replaces_in_place_and_status_tracks_changes(store):
    src = store.save(3, None, OKTA, None)
    first = store.publish(3, src['id'], ROBOT, False)
    assert store.publishStatus(3, ROBOT) == {src['id']: 'published'}
    edited = OKTA.replace('locked out', 'locked out of Okta')
    store.save(3, src['id'], edited, None)
    assert store.get(ROBOT, first['id'])['text'] == OKTA
    assert store.publishStatus(3, ROBOT) == {src['id']: 'changed'}
    again = store.publish(3, src['id'], ROBOT, False)
    assert again['id'] == first['id']
    assert again['text'] == edited
    assert store.publishStatus(3, ROBOT) == {src['id']: 'published'}


def test_a_different_source_needs_confirmation(store):
    a = store.save(3, None, OKTA, None)
    b = store.save(4, None, OKTA, None)
    first = store.publish(3, a['id'], ROBOT, False)
    e = error(lambda: store.publish(4, b['id'], ROBOT, False))
    assert e.kind == 'replaces'
    assert e.status == 409
    assert e.data['published_by'] == 'Ann Lee'
    assert e.data['published_at'] == first['published_at']
    row = store.publish(4, b['id'], ROBOT, True)
    assert row['id'] == first['id']
    assert int(row['source_id']) == b['id']
    assert int(row['published_by']) == 4
    # The new publisher is named by email when they have no name.
    e = error(lambda: store.publish(3, a['id'], ROBOT, False))
    assert e.data['published_by'] == 'bob@x.test'


def test_a_key_from_a_deleted_source_needs_confirmation(store):
    a = store.save(3, None, OKTA, None)
    store.publish(3, a['id'], ROBOT, False)
    store.delete(3, a['id'])
    b = store.save(3, None, OKTA, None)
    e = error(lambda: store.publish(3, b['id'], ROBOT, False))
    assert e.kind == 'replaces'
    assert e.data['published_by'] == 'Ann Lee'
    assert int(store.publish(3, b['id'], ROBOT, True)['source_id']) == b['id']


def test_unpublish_deletes_the_robot_row(store):
    a = store.save(3, None, OKTA, None)
    row = store.publish(3, a['id'], ROBOT, False)
    lst = store.robotList(ROBOT)
    assert lst[0]['published_by_name'] == 'Ann Lee'
    assert lst[0]['source_title'] == 'Okta password reset'
    store.unpublish(ROBOT, row['id'])
    assert store.robotList(ROBOT) == []
    assert store.get(3, a['id']) is not None
    assert error(lambda: store.unpublish(ROBOT, row['id'])).status == 404


def test_publishing_someone_elses_playbook_is_not_found(store):
    a = store.save(3, None, OKTA, None)
    e = error(lambda: store.publish(4, a['id'], ROBOT, False))
    assert e.status == 404
    assert str(e) == f"Playbook #{a['id']} not found"


def test_renaming_the_key_then_republishing_moves_the_single_copy(store):
    a = store.save(3, None, OKTA, None)
    first = store.publish(3, a['id'], ROBOT, False)
    store.save(3, a['id'], OKTA, 'okta-renamed')
    again = store.publish(3, a['id'], ROBOT, False)
    assert again['id'] == first['id']
    lst = store.robotList(ROBOT)
    assert len(lst) == 1
    assert lst[0]['pkey'] == 'okta-renamed'
    assert store.publishStatus(3, ROBOT) == {a['id']: 'published'}


def test_renaming_onto_another_published_key_needs_confirmation_then_replaces_it(store):
    a = store.save(3, None, OKTA, None)
    b = store.save(4, None, OKTA, 'okta-other')
    store.publish(3, a['id'], ROBOT, False)
    theirs = store.publish(4, b['id'], ROBOT, False)
    store.save(3, a['id'], OKTA, 'okta-other')
    e = error(lambda: store.publish(3, a['id'], ROBOT, False))
    assert e.kind == 'replaces'
    assert e.data['published_by'] == 'bob@x.test'
    assert len(store.robotList(ROBOT)) == 2
    row = store.publish(3, a['id'], ROBOT, True)
    lst = store.robotList(ROBOT)
    assert len(lst) == 1
    assert lst[0]['pkey'] == 'okta-other'
    assert int(lst[0]['source_id']) == a['id']
    assert lst[0]['id'] == row['id']
    assert store.get(ROBOT, theirs['id']) is None


def test_a_failed_publish_rolls_back(store, pbc_db, monkeypatch):
    # The delete of the replaced copy and the save of ours are one transaction.
    a = store.save(3, None, OKTA, None)
    b = store.save(4, None, OKTA, 'okta-other')
    store.publish(3, a['id'], ROBOT, False)
    store.publish(4, b['id'], ROBOT, False)
    store.save(3, a['id'], OKTA, 'okta-other')

    def boom(*args, **kwargs):
        raise RuntimeError('disk full')
    monkeypatch.setattr(store, 'save', boom)
    with pytest.raises(RuntimeError):
        store.publish(3, a['id'], ROBOT, True)
    assert len(store.robotList(ROBOT)) == 2
