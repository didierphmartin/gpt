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
    def close(self): pass


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


class TrackingExtractor(FakeExtractor):
    instances: list = []

    def __init__(self, api_key):
        super().__init__(api_key)
        self.closed = False
        TrackingExtractor.instances.append(self)

    def close(self):
        self.closed = True


def test_run_closes_extractor_after_success(monkeypatch):
    monkeypatch.setattr('app.agent_team.services.memory_auto_updater.MemoryExtractor', TrackingExtractor)
    TrackingExtractor.instances.clear()
    MemoryAutoUpdater(Db(), 'K').run(3, 'sess', 'a sufficiently long user message', 'reply')
    assert len(TrackingExtractor.instances) == 1 and TrackingExtractor.instances[-1].closed is True


def test_run_closes_extractor_even_when_extract_returns_none(monkeypatch):
    class NoneExtractor(TrackingExtractor):
        def extract(self, *a): return None
    monkeypatch.setattr('app.agent_team.services.memory_auto_updater.MemoryExtractor', NoneExtractor)
    TrackingExtractor.instances.clear()
    out = MemoryAutoUpdater(Db(), 'K').run(3, 'sess', 'a sufficiently long user message', 'reply')
    assert out is None
    assert len(TrackingExtractor.instances) == 1 and TrackingExtractor.instances[-1].closed is True
