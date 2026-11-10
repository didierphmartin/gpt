import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from mcphost.procs import ROUTER


@unittest.skipUnless(shutil.which("php"), "php not installed")
class PhpRouterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._d = tempfile.TemporaryDirectory()
        d = Path(cls._d.name)
        (d / "mcp.php").write_text('<?php echo "ok";')
        (d / ".env").write_text("SECRET=1")
        (d / ".htaccess").write_text("x")
        (d / "app.html").write_text("<p>hi</p>")
        (d / "sub/.git").mkdir(parents=True)
        (d / "sub/.git/x").write_text("x")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            cls.port = s.getsockname()[1]
        cls.proc = subprocess.Popen(["php", "-S", f"127.0.0.1:{cls.port}", str(ROUTER)], cwd=d,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        end = time.monotonic() + 5
        while time.monotonic() < end:
            try:
                socket.create_connection(("127.0.0.1", cls.port), 0.2).close()
                break
            except OSError:
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait()
        cls._d.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, ""

    def test_served(self):
        self.assertEqual(self.get("/mcp.php"), (200, "ok"))
        self.assertEqual(self.get("/app.html")[0], 200)

    def test_refused(self):
        for p in ("/.env", "/.htaccess", "/sub/.git/x", "/x/../.env", "/%2e%65nv", "/"):
            with self.subTest(p=p):
                self.assertEqual(self.get(p)[0], 404)
