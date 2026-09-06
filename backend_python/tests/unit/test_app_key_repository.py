import hashlib, hmac
import pytest
from app.agent_team.services.app_key_repository import AppKeyRepository


class FakeDb:
    def __init__(self, row=None): self.row = row; self.calls = []
    def fetch_one(self, sql, params=None): self.calls.append((sql, params)); return self.row
    def execute(self, sql, params=None): self.calls.append((sql, params)); return 1


def test_requires_secret():
    with pytest.raises(RuntimeError):
        AppKeyRepository(FakeDb(), '')


def test_find_by_key_rejects_bad_prefix_and_hash_mismatch():
    repo = AppKeyRepository(FakeDb(), 's')
    assert repo.findByKey('uak_xyz') is None
    assert repo.findByKey('ak_short') is None
    full = 'ak_' + 'aa' * 16
    db = FakeDb({'id': 1, 'user_id': 2, 'key_hash': 'nope', 'scopes': '[]', 'application_id': 'a',
                 'name': 'n', 'key_prefix': full[:12], 'created_at': 'c', 'last_used_at': None, 'revoked_at': None})
    assert AppKeyRepository(db, 's').findByKey(full) is None


def test_find_by_key_success_strips_hash_and_decodes_scopes():
    full = 'ak_' + 'aa' * 16
    h = hmac.new(b's', full.encode(), hashlib.sha256).hexdigest()
    db = FakeDb({'id': '1', 'user_id': '2', 'key_hash': h, 'scopes': '["a","b"]', 'application_id': 'app',
                 'name': 'n', 'key_prefix': full[:12], 'created_at': 'c', 'last_used_at': None, 'revoked_at': None})
    row = AppKeyRepository(db, 's').findByKey(full)
    assert row['id'] == 1 and row['user_id'] == 2 and row['scopes'] == ['a', 'b'] and 'key_hash' not in row
    assert db.calls[0][1] == {':prefix': full[:12]}
