"""Port of backend/tests/Unit/EventWorker/ProcRunSpawnerTest.php: the spawner reports exit codes and kills a run
past its limit. Stand-in `scheduler.run_schedule` / `scheduler.run_scheduled_workflows` modules in a temp dir."""
from __future__ import annotations

import sys
import time

import pytest

from app.agent_team.services.proc_run_spawner import ProcRunSpawner


@pytest.fixture
def dir(tmp_path):
    (tmp_path / 'scheduler').mkdir()
    (tmp_path / 'scheduler' / '__init__.py').write_text('')
    # id 7 exits 3, id 9 sleeps 30 s, others exit 0.
    (tmp_path / 'scheduler' / 'run_schedule.py').write_text(
        'import sys, time\nid = int(sys.argv[1])\nif id == 9:\n    time.sleep(30)\nsys.exit(3 if id == 7 else 0)\n')
    (tmp_path / 'scheduler' / 'run_scheduled_workflows.py').write_text('import sys\nsys.exit(0)\n')
    return tmp_path


def wait_for(s: ProcRunSpawner, key: int, seen: dict, maxS: float = 5.0):
    end = time.time() + maxS
    while time.time() < end:
        seen.update(s.done())
        if key in seen:
            return seen[key]
        time.sleep(0.05)
    return None


def test_exit_codes(dir):
    s = ProcRunSpawner(sys.executable, str(dir))
    seen = {}
    s.start(1, 5)
    s.start(2, 7)
    assert wait_for(s, 1, seen) == 0
    assert wait_for(s, 2, seen) == 3


def test_a_run_past_its_limit_is_killed(dir):
    s = ProcRunSpawner(sys.executable, str(dir), 1)
    s.start(1, 9)
    code = wait_for(s, 1, {})
    assert code is not None
    assert code != 0


def test_a_live_run_is_not_overwritten(dir):
    lines = []
    s = ProcRunSpawner(sys.executable, str(dir), 1, lines.append)
    s.start(1, 9)     # sleeps
    with pytest.raises(RuntimeError):
        s.start(1, 5)     # refused: key 1 still runs
    assert len(lines) == 1
    code = wait_for(s, 1, {})
    assert code != 0   # it was the sleeping run, killed at the limit
    s.stopAll(1)


def test_a_hung_scheduler_tick_is_killed(dir):
    (dir / 'scheduler' / 'run_scheduled_workflows.py').write_text('import time\ntime.sleep(30)\n')
    lines = []
    s = ProcRunSpawner(sys.executable, str(dir), 1, lines.append)
    s.scheduleTick()
    end = time.time() + 5
    while not lines and time.time() < end:
        s.done()
        time.sleep(0.05)
    assert len(lines) == 1
    assert 'tick' in lines[0]
    s.scheduleTick()   # a fresh tick may start now
    s.stopAll(0)
