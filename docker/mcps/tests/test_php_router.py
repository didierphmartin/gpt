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
        (d / "datasheet.html").write_text("d")
        (d / "server.log").write_text("log")
        (d / "server.log.1").write_text("log")
        for n in ("token.json", "cache.sqlite", "app.log", "cert.pem", "client_secret.json", "Credentials.json", "a.key", "x.p12", "x.pfx", "cache.sqlite-wal"):
            (d / n).write_text("x")
        (d / "config").mkdir()
        (d / "config/pdi.env").write_text("SN_CLIENT_SECRET=x")
        (d / "config/pdi.env.example").write_text("SN_CLIENT_SECRET=")
        (d / "prod.env").write_text("KEY=x")
        (d / "data").mkdir()
        (d / "data/x.sqlite").write_text("x")
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
        self.assertEqual(self.get("/datasheet.html")[0], 200)
        self.assertEqual(self.get("/config/pdi.env.example")[0], 200)   # a template holds no values

    def test_settings_file_refused_whatever_its_name(self):
        for p in ("/config/pdi.env", "/prod.env", "/CONFIG/../config/pdi.env", "/config/PDI.ENV"):
            with self.subTest(p=p):
                self.assertEqual(self.get(p)[0], 404)

    def test_refused(self):
        for p in ("/.env", "/.htaccess", "/sub/.git/x", "/x/../.env", "/server.log", "/server.log.1", "/data/x.sqlite", "/sub/server.log", "/%2e%65nv", "/", "/token.json", "/cache.sqlite", "/app.log", "/cert.pem", "/client_secret.json", "/Credentials.json", "/a.key", "/x.p12", "/x.pfx", "/cache.sqlite-wal"):
            with self.subTest(p=p):
                self.assertEqual(self.get(p)[0], 404)
