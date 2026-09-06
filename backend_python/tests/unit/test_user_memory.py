from app.agent_team.services.user_memory_repository import UserMemoryRepository
from app.agent_team.services.user_memory_events_repository import UserMemoryEventsRepository
from app.agent_team.services.user_memory_settings_repository import UserMemorySettingsRepository


class Db:
    def __init__(self, rows=None, one=None): self.rows = rows or []; self.one = one; self.calls = []
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return self.rows
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return self.one
    def execute(self, s, p=None): self.calls.append((s, p)); return 1
    def insert(self, s, p=None): self.calls.append((s, p)); return 5


def test_memory_block_and_merge():
    db = Db(rows=[{'scope': 'memory', 'content': ' repo uses pytest '}, {'scope': 'user', 'content': 'likes tea'}])
    assert UserMemoryRepository.buildMemoryBlock(db, 3) == '## Memory\nrepo uses pytest\n\n## User\nlikes tea'
    assert UserMemoryRepository.buildMemoryBlock(Db(), 3) == '' and UserMemoryRepository.buildMemoryBlock(db, 0) == ''
    r = UserMemoryRepository(Db())
    assert r.buildMerged('A\nb', ['a', 'B', ' c ', '']) == 'A\nb\nc' and r.buildMerged('', ['x']) == 'x' and r.buildMerged('A', ['a']) == 'A'
    assert r.budgetFor('memory') == 2200 and r.budgetFor('user') == 1375


def test_set_truncates_and_validates():
    import pytest
    db = Db(); r = UserMemoryRepository(db)
    r.set(3, 'user', 'x' * 2000)
    assert len(db.calls[-1][1]['content']) == 1375
    with pytest.raises(ValueError, match='Invalid scope: bogus'):
        r.set(3, 'bogus', 'x')
    assert not any('CREATE TABLE' in s for s, _ in db.calls)


def test_events_and_settings():
    db = Db(); ev = UserMemoryEventsRepository(db)
    assert ev.log(3, 'memory', 'auto_extract', 'same', 'same') == 0 and not db.calls
    assert ev.log(3, 'memory', 'auto_extract', 'a', 'b', 'why', 's1') == 5
    assert db.calls[-1][1] == {'user_id': 3, 'scope': 'memory', 'source': 'auto_extract', 'before': 'a', 'after': 'b', 'rationale': 'why', 'session_id': 's1'}
    assert UserMemorySettingsRepository(Db(one=None)).get(3) == {'enabled': True, 'model': 'claude-haiku-4-5-20251001'}
    assert UserMemorySettingsRepository(Db(one={'auto_update_enabled': 0, 'auto_update_model': 'claude-3-haiku-20240307'})).get(3) == {'enabled': False, 'model': 'claude-3-haiku-20240307'}
