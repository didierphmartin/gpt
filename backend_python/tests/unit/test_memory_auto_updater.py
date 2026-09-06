from app.agent_team.services.memory_auto_updater import MemoryAutoUpdater


class Db:
    def __init__(self): self.calls = []; self.memory = {'memory': 'old fact', 'user': ''}
    def fetch_all(self, s, p=None): self.calls.append((s, p)); return [{'scope': k, 'content': v} for k, v in self.memory.items()]
    def fetch_one(self, s, p=None): self.calls.append((s, p)); return None
    def execute(self, s, p=None): self.calls.append((s, p)); return 1
    def insert(self, s, p=None): self.calls.append((s, p)); return 1


class FakeExtractor:
    def __init__(self, api_key): pass
    def extract(self, model, mem, user, u, a): return {'memory_additions': ['new fact'], 'user_additions': [], 'reason': 'r'}
    def filterDuplicates(self, model, current, adds): return adds
    def compact(self, *a): return None


def test_run_writes_memory_and_logs_event(monkeypatch):
    monkeypatch.setattr('app.agent_team.services.memory_auto_updater.MemoryExtractor', FakeExtractor)
    db = Db()
    out = MemoryAutoUpdater(db, 'K').run(3, 'sess', 'a sufficiently long user message', 'reply')
    assert out == {'reason': 'r', 'written': ['memory']}
    upsert = next(p for s, p in db.calls if 'INSERT INTO user_memories' in s)
    assert upsert['content'] == 'old fact\nnew fact'
    assert any('INSERT INTO user_memory_events' in s for s, _ in db.calls)


def test_run_guards():
    db = Db()
    assert MemoryAutoUpdater(db, '').run(3, 's', 'x' * 30, 'a') is None
    assert MemoryAutoUpdater(db, 'K').run(3, 's', 'short', 'a') is None and not db.calls
