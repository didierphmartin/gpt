"""Port of backend/tests/Unit/Playbook/PlaybookStoreTest.php."""
from __future__ import annotations

import pytest

from app.playbook.playbook_store import PlaybookStore, PlaybookStoreError
from tests.unit.playbook.conftest import OKTA


@pytest.fixture
def store(pbc_db):
    return PlaybookStore(pbc_db)


def error(fn) -> PlaybookStoreError:
    with pytest.raises(PlaybookStoreError) as e:
        fn()
    return e.value


def test_key_from_title_and_format():
    assert PlaybookStore.keyFromTitle('Okta password reset') == 'okta-password-reset'
    assert PlaybookStore.keyFromTitle('  Time off & leave!! ') == 'time-off-leave'
    assert PlaybookStore.keyFromTitle('###') == 'playbook'
    assert len(PlaybookStore.keyFromTitle('abcd' * 20)) == 64
    assert PlaybookStore.isValidKey('okta-reset')
    for bad in ['Okta', 'okta--reset', '-okta', 'okta_reset', '', 'a' * 65]:
        assert not PlaybookStore.isValidKey(bad), bad


def test_save_keeps_the_text_verbatim_and_copies_the_title(store):
    row = store.save(3, None, OKTA, None)
    assert row['pkey'] == 'okta-password-reset'
    assert row['title'] == 'Okta password reset'
    assert store.get(3, int(row['id']))['text'] == OKTA


def test_a_title_rename_never_changes_the_key(store):
    row = store.save(3, None, OKTA, 'okta-reset')
    renamed = OKTA.replace('Title: Okta password reset', 'Title: Okta reset v2')
    again = store.save(3, int(row['id']), renamed, None)
    assert again['pkey'] == 'okta-reset'
    assert again['title'] == 'Okta reset v2'


def test_unparsable_text_is_refused(store):
    e = error(lambda: store.save(3, None, "Trigger: x\n", None))
    assert e.kind == 'invalid_text'
    assert e.status == 422
    assert 'Title' in str(e)


def test_keys_are_unique_per_user_only(store):
    store.save(3, None, OKTA, 'okta-reset')
    e = error(lambda: store.save(3, None, OKTA, 'okta-reset'))
    assert e.kind == 'key_taken'
    assert e.status == 409
    other = store.save(4, None, OKTA, 'okta-reset')  # another user may use the same key
    assert other['pkey'] == 'okta-reset'
    assert store.get(3, int(other['id'])) is None    # and it is invisible to user 3
    assert len(store.list(3)) == 1


def test_an_invalid_key_is_refused(store):
    e = error(lambda: store.save(3, None, OKTA, 'Okta Reset'))
    assert e.kind == 'invalid_key'


def test_get_by_key_and_not_found(store):
    row = store.save(3, None, OKTA, 'okta-reset')
    assert int(store.getByKey(3, 'okta-reset')['id']) == int(row['id'])
    assert store.getByKey(4, 'okta-reset') is None
    e = error(lambda: store.save(3, 999, OKTA, None))
    assert e.kind == 'not_found'
    assert str(e) == 'Playbook #999 not found'


def test_used_by_and_delete_refused_while_in_use(store, pbc_db):
    id_ = int(store.save(3, None, OKTA, 'okta-reset')['id'])
    pbc_db.execute(f"INSERT INTO agents (user_id, name, agent_type, playbook_id) VALUES (3, 'Okta agent', 'playbook', {id_})")
    pbc_db.execute("INSERT INTO agent_workflows (user_id, name) VALUES ('3', 'ServiceNow bridge')")
    pbc_db.execute(f"INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{{\"name\":\"Reset\",\"playbook_id\":{id_}}}')")
    pbc_db.execute("INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (1, 'playbook', '{\"name\":\"Other\",\"playbook_id\":77}')")
    used = store.usedBy(3, id_)
    assert used['agents'] == [{'id': 1, 'name': 'Okta agent'}]
    assert used['nodes'] == [{'workflow_id': 1, 'workflow_name': 'ServiceNow bridge', 'node_name': 'Reset'}]
    assert store.list(3)[0]['used_by'] == 2
    e = error(lambda: store.delete(3, id_))
    assert e.kind == 'in_use'
    assert 'Okta agent' in str(e)
    assert 'ServiceNow bridge' in str(e)


def test_delete_an_unused_playbook(store):
    id_ = int(store.save(3, None, OKTA, 'okta-reset')['id'])
    store.delete(3, id_)
    assert store.get(3, id_) is None
