"""Port of backend/tests/Unit/Controllers/FileStoragePathTest.php.

Storage paths stay inside the user's own folder. Refusals return before any file is opened."""
from __future__ import annotations

import pytest

from app.controllers.file_storage_controller import FileStorageController
from tests.unit.playbook.conftest import sqlite_db


@pytest.fixture
def c(tmp_path):
    db = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, storage_provider TEXT, storage_folder TEXT)')
    db.execute("INSERT INTO users VALUES (1, 'local', 'alice'), (2, 'local', '../..')")
    return FileStorageController(db, {'storage_path': str(tmp_path / 'no-such-storage')})


@pytest.mark.parametrize('path', ['..', '../../backend', 'a/../../b', './x', 'a\0b'])
def test_list_refuses_dot_dot(c, path):
    r = c.listFiles({'user_id': 1, 'query': {'path': path}})
    assert r['success'] is False
    assert r['error'] == 'Invalid path'


@pytest.mark.parametrize('file_id', [
    '../../backend/.env',
    '/etc/passwd',
    'synergyaichatroot/bob/x.txt',
    'synergyaichatroot/alice/../bob/x.txt',
    'synergyaichatroot/alice',
    'synergyaichatroot/alicex/x.txt',
])
def test_read_refuses_paths_outside_the_users_folder(c, file_id):
    assert c.readFile({'user_id': 1, 'query': {'fileId': file_id}}) == {'success': False, 'error': 'File not found'}


def test_a_dot_dot_storage_folder_setting_counts_as_none(c):
    r = c.readFile({'user_id': 2, 'query': {'fileId': 'synergyaichatroot/x.txt'}})
    assert r['error'] == 'File not found'
    r = c.listFiles({'user_id': 2, 'query': {}})
    assert r['items'] == []
    assert r['userFolder'] == ''


def test_read_finds_a_listed_path_under_the_storage_root(tmp_path):
    db = sqlite_db('CREATE TABLE users (id INTEGER PRIMARY KEY, storage_provider TEXT, storage_folder TEXT)')
    db.execute("INSERT INTO users VALUES (1, 'local', 'alice')")
    (tmp_path / 'synergyaichatroot' / 'alice').mkdir(parents=True)
    (tmp_path / 'synergyaichatroot' / 'alice' / 'a.txt').write_text('inside')
    r = FileStorageController(db, {'storage_path': str(tmp_path)}).readFile(
        {'user_id': 1, 'query': {'fileId': '/synergyaichatroot/alice/a.txt'}})
    assert r['success'] is True and r['content'] == 'inside'
