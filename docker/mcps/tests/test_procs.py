import shutil
import tempfile
import time
import unittest
from pathlib import Path

from mcphost.procs import Manager
from mcphost.registry import Registry

FIXTURES = Path(__file__).parent / "fixtures"


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, s):
        self.now += s


def wait_until(fn, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if fn():
            return True
        time.sleep(0.02)
    raise AssertionError("condition not met in time")


def run_until_exit(m, folder):
    """Wait for the child to exit, then run one supervision pass that reaps it."""
    wait_until(lambda: m._procs[folder].poll() is not None)
    m.tick()


class ProcsTest(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.root = Path(self._d.name)
        for name in ("ok_server", "dies"):
            shutil.copytree(FIXTURES / name, self.root / name)
        self.reg = Registry(self.root)
        self.reg.add("ok_server", "OK", 1)     # port 9101
        self.reg.add("dies", "Dies", 1)
        self.clock = FakeClock()
        self.m = Manager(self.root, self.reg, clock=self.clock)
        self.addCleanup(self.m.stop_all)

    def test_overrides_reach_the_server(self):
        self.m.start("ok_server")
        wait_until(lambda: "FAKE_PORT=9101" in "\n".join(self.m.log_tail("ok_server")))
        self.assertEqual(self.m.state("ok_server"), "running")
        log = "\n".join(self.m.log_tail("ok_server"))
        self.assertIn("FAKE_HOST=127.0.0.1", log)
        self.assertIn("FAKE_DB_PATH=" + str(self.root / "ok_server/data/fake_db_path.sqlite"), log)

    def test_env_file_beats_container_but_not_overrides(self):
        (self.root / "ok_server/.env").write_text("FAKE_TOKEN=from-file\nFAKE_DB_PATH=/elsewhere/x.sqlite\nFAKE_PORT=1\n")
        self.m.start("ok_server")
        wait_until(lambda: "FAKE_PORT=" in "\n".join(self.m.log_tail("ok_server")))
        log = "\n".join(self.m.log_tail("ok_server"))
        self.assertIn("FAKE_TOKEN=from-file", log)
        self.assertIn("FAKE_DB_PATH=/elsewhere/x.sqlite", log)   # .env value kept when set
        self.assertIn("FAKE_PORT=9101", log)                      # port always the registry's

    def test_crash_loop_ends_crashed_and_others_run(self):
        self.m.start("dies")
        self.m.start("ok_server")
        for _ in range(5):
            run_until_exit(self.m, "dies")
            self.clock.advance(400)
            self.m.tick()
        self.assertEqual(self.m.state("dies"), "crashed")
        self.assertEqual(self.m.state("ok_server"), "running")
        self.m.restart("dies")
        self.assertIn(self.m.state("dies"), ("starting", "running", "crashed"))

    def test_backoff_doubles(self):
        self.m.start("dies")
        seen = []
        for _ in range(3):
            run_until_exit(self.m, "dies")
            delay = self.m.next_start("dies") - self.clock.now
            self.assertEqual(self.m._next_start["dies"] - self.clock.now, delay)
            seen.append(delay)
            self.assertEqual(self.m.state("dies"), "starting")
            self.clock.advance(delay)
            self.m.tick()
        self.assertEqual(seen, [1, 2, 4])

    def test_long_run_resets_failures(self):
        self.m.start("dies")
        run_until_exit(self.m, "dies")
        self.clock.advance(1)
        self.m.tick()                      # second attempt
        self.clock.advance(601)            # it "lived" long enough
        run_until_exit(self.m, "dies")
        self.assertEqual(self.m.next_start("dies") - self.clock.now, 1)

    def test_stop_and_restart(self):
        self.m.start("ok_server")
        wait_until(lambda: self.m.state("ok_server") == "running")
        pid = self.m._procs["ok_server"].pid
        self.m.stop("ok_server")
        self.assertEqual(self.m.state("ok_server"), "stopped")
        self.assertIsNone(self.m.next_start("ok_server"))
        self.m.tick()
        self.assertEqual(self.m.state("ok_server"), "stopped")
        self.m.restart("ok_server")
        self.assertEqual(self.m.state("ok_server"), "running")
        self.assertNotEqual(self.m._procs["ok_server"].pid, pid)

    def test_start_all_only_enabled(self):
        self.reg.set_enabled("dies", False)
        self.m.start_all()
        self.assertEqual(self.m.state("ok_server"), "running")
        self.assertEqual(self.m.state("dies"), "stopped")

    def test_log_rotates(self):
        import mcphost.procs as procs
        self.addCleanup(setattr, procs, "LOG_MAX", procs.LOG_MAX)
        procs.LOG_MAX = 20
        self.m.start("dies")
        for _ in range(3):
            run_until_exit(self.m, "dies")
            self.clock.advance(400)
            self.m.tick()
        run_until_exit(self.m, "dies")
        self.assertTrue((self.root / "dies/server.log.1").exists())

    def test_missing_start_is_crashed(self):
        (self.root / "dies/synergyai-mcp.json").write_text("{}")
        self.m.start("dies")
        self.assertEqual(self.m.state("dies"), "crashed")
        self.assertTrue(any("start" in l for l in self.m.log_tail("dies")))


if __name__ == "__main__":
    unittest.main()
