import shutil
import tempfile
import time
import unittest
from pathlib import Path

from mcphost.procs import Manager, start_command
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
        for name in ("ok_server", "dies", "stubborn"):
            shutil.copytree(FIXTURES / name, self.root / name)
        self.reg = Registry(self.root)
        self.reg.add("ok_server", "OK", 1)     # port 9101
        self.reg.add("dies", "Dies", 1)
        self.reg.add("stubborn", "Stubborn", 1)
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

    def test_slow_stop_does_not_block_other_servers(self):
        import threading
        import mcphost.procs as procs
        self.addCleanup(setattr, procs, "STOP_GRACE", procs.STOP_GRACE)
        procs.STOP_GRACE = 3
        self.m.start("stubborn")
        self.m.start("ok_server")
        wait_until(lambda: "ready" in self.m.log_tail("stubborn"))
        t = threading.Thread(target=self.m.stop, args=("stubborn",))
        t.start()
        time.sleep(0.3)
        self.assertTrue(t.is_alive())      # still waiting out the grace period
        t0 = time.monotonic()
        self.m.tick()
        self.assertEqual(self.m.state("ok_server"), "running")
        self.assertIsNone(self.m.next_start("ok_server"))
        self.assertLess(time.monotonic() - t0, 1.0)
        t.join(10)
        self.assertEqual(self.m.state("stubborn"), "stopped")

    def test_missing_start_is_crashed(self):
        (self.root / "dies/synergyai-mcp.json").write_text("{}")
        self.m.start("dies")
        self.assertEqual(self.m.state("dies"), "crashed")
        self.assertTrue(any("start" in l for l in self.m.log_tail("dies")))


    def test_malformed_manifest_values_are_crashed_not_raised(self):
        for manifest in ('{"start": "./run.sh", "host_env": 5}',
                         '{"start": "./run.sh", "data_env": [3]}',
                         '[1, 2]'):
            (self.root / "dies/synergyai-mcp.json").write_text(manifest)
            self.m.start("dies")     # must not raise
            self.assertEqual(self.m.state("dies"), "crashed", manifest)
            self.assertTrue(any(l.startswith("[supervisor]") for l in self.m.log_tail("dies")), manifest)

    def test_start_all_keeps_going_past_a_failing_server(self):
        real = self.m.start

        def start(folder):
            if folder == "dies":
                raise RuntimeError("boom")
            real(folder)
        self.m.start = start
        self.reg.set_enabled("stubborn", False)
        import contextlib
        import io
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.m.start_all()
        self.assertIn("boom", err.getvalue())
        self.assertEqual(self.m.state("ok_server"), "running")

if __name__ == "__main__":
    unittest.main()


class StartCommandTest(unittest.TestCase):
    R = Path("/r.php")

    def test_start_command_php(self):
        self.assertEqual(start_command({"runtime": "php", "entry": "mcp.php"}, 9105, self.R),
                         "exec php -S 127.0.0.1:9105 /r.php")

    def test_start_command_python_default_runtime(self):
        self.assertEqual(start_command({"start": "./run.sh"}, 9105, self.R), "./run.sh")

    def test_start_command_php_without_entry(self):
        with self.assertRaisesRegex(ValueError, "a php server needs an entry file"):
            start_command({"runtime": "php"}, 9105, self.R)

    def test_start_command_python_without_start(self):
        with self.assertRaisesRegex(ValueError, "the server's manifest has no start command"):
            start_command({}, 9105, self.R)

    def test_php_env_has_workers_and_entry(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "p").mkdir()
            reg = Registry(root)
            reg.add("p", "P", 1)
            env = Manager(root, reg)._env("p", {"runtime": "php", "entry": "mcp.php"})
            self.assertEqual(env["PHP_CLI_SERVER_WORKERS"], "4")
            self.assertEqual(env["MCP_ENTRY"], "mcp.php")
