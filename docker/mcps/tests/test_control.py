import base64
import http.client
import json
import shutil
import tempfile
import time
import threading
import unittest
from pathlib import Path

from mcphost import control, envfile
from mcphost.procs import Manager
from mcphost.registry import Registry

FIXTURES = Path(__file__).parent / "fixtures"
TOKEN = "t0ken"


def b64(data) -> str:
    return base64.b64encode(data if isinstance(data, bytes) else data.encode()).decode()


class Resp:
    def __init__(self, r):
        self.status, self.raw = r.status, r.read()

    def json(self):
        return json.loads(self.raw)


class SelectFilesTest(unittest.TestCase):
    def test_manifest_travels_even_when_include_leaves_it_out(self):
        got = control.select_server_files(["synergyai-mcp.json", "a.py", "x/synergyai-mcp.json"], {"include": ["*.py"]})
        self.assertEqual(got, ["synergyai-mcp.json", "a.py"])


class ControlTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.registry = Registry(self.root)
        self.manager = Manager(self.root, self.registry)
        self.srv = control.make_server(self.root, self.registry, self.manager, TOKEN, port=0)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.manager.stop_all()
        shutil.rmtree(self.root, ignore_errors=True)

    def call(self, method, path, body=None, token=TOKEN, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        h = {"Authorization": "Bearer " + token} if token else {}
        data = raw if raw is not None else (json.dumps(body) if body is not None else None)
        c.request(method, path, data, h)
        r = Resp(c.getresponse())
        c.close()
        return r

    def get(self, path, token=TOKEN): return self.call("GET", path, token=token)
    def put(self, path, body): return self.call("PUT", path, body)

    def fixture_files(self, name="ok_server", manifest_install=None):
        files = {str(p.relative_to(FIXTURES / name)): b64(p.read_bytes()) for p in (FIXTURES / name).rglob("*") if p.is_file()}
        if manifest_install is not None:
            m = json.loads((FIXTURES / name / "synergyai-mcp.json").read_text())
            m["install"] = manifest_install
            files["synergyai-mcp.json"] = b64(json.dumps(m))
        return files

    def install(self, folder, files=None, env=None, manifest_install=None, name="Fake"):
        files = self.fixture_files(manifest_install=manifest_install) if files is None else files
        return self.call("POST", f"/servers/{folder}/install", {"name": name, "installed_by": 7, "files": files, "env": env or {}})

    def test_needs_token(self):
        self.assertEqual(self.get("/servers", token=None).status, 401)
        self.assertEqual(self.get("/servers", token="wrong").status, 401)
        self.assertEqual(self.get("/servers").json(), [])

    def test_install_makes_scripts_and_start_executable(self):
        m = {"name": "x", "start": "./server"}
        files = {"synergyai-mcp.json": b64(json.dumps(m)), "server": b64("#!/bin/sh\nsleep 30\n"),
                 "run.sh": b64("#!/bin/sh\n"), "bin/x.sh": b64("#!/bin/sh\n"), "data.txt": b64("d")}
        self.assertEqual(self.install("ex", files=files).status, 201)
        d = self.root / "ex"
        for rel in ("server", "run.sh", "bin/x.sh"):
            self.assertTrue((d / rel).stat().st_mode & 0o111, rel)
        self.assertFalse((d / "data.txt").stat().st_mode & 0o111)
        for _ in range(50):
            if self.manager.state("ex") == "running":
                break
            time.sleep(0.1)
        self.assertEqual(self.manager.state("ex"), "running")

    def test_install_refuses_existing_and_unsafe(self):
        self.assertEqual(self.install("ok_server").status, 201)
        self.assertEqual(self.install("ok_server").status, 409)
        self.assertEqual(self.install("bad", files={"../x": b64("x")}).status, 400)
        self.assertFalse((self.root / "bad").exists())
        self.assertEqual(self.install(".hidden").status, 400)

    def test_install_lists_server(self):
        r = self.install("ok_server")
        self.assertEqual(set(r.json()), {"folder", "port", "state"})
        s = self.get("/servers").json()[0]
        self.assertEqual((s["folder"], s["name"], s["installed_by"], s["enabled"]), ("ok_server", "Fake", 7, True))

    def test_list_returns_runtime_and_source(self):
        self.registry.add("old", "Old", 1)
        self.registry._save({**self.registry.load(), "older": {"name": "O", "port": 9150, "enabled": True, "installed_by": 1}})
        src = {"url": "https://github.com/o/r", "owner": "o", "repo": "r", "ref": "main", "sha": "abc", "path": ""}
        self.registry.add("new", "New", 1, runtime="php", source=src)
        rows = {s["folder"]: s for s in self.get("/servers").json()}
        self.assertEqual((rows["older"]["runtime"], rows["older"]["source"]), ("python", None))
        self.assertEqual((rows["new"]["runtime"], rows["new"]["source"]), ("php", src))

    def test_install_php_manifest_without_start(self):
        files = {"synergyai-mcp.json": b64(json.dumps({"runtime": "php", "entry": "mcp.php"})), "mcp.php": b64("<?php\n")}
        src = {"url": "https://github.com/o/r", "owner": "o", "repo": "r", "ref": "main", "sha": "abc", "path": ""}
        r = self.call("POST", "/servers/phpx/install", {"name": "P", "installed_by": 7, "files": files, "env": {}, "source": src})
        self.assertEqual(r.status, 201)
        e = self.registry.get("phpx")
        self.assertEqual((e["runtime"], e["source"]), ("php", src))

    def test_install_rejects_non_object_source(self):
        r = self.call("POST", "/servers/bad/install", {"name": "P", "files": self.fixture_files(), "env": {}, "source": "x"})
        self.assertEqual(r.status, 400)
        self.assertFalse((self.root / "bad").exists())

    def test_failed_install_leaves_nothing(self):
        r = self.install("broken", files=self.fixture_files(manifest_install="echo boom; exit 3"))
        self.assertEqual(r.status, 422)
        self.assertEqual(r.json()["error"], "install-failed")
        self.assertIn("boom", r.json()["log"])
        self.assertFalse((self.root / "broken").exists())
        self.assertIsNone(self.registry.get("broken"))

    def test_concurrent_install_one_wins(self):
        files = self.fixture_files(manifest_install="sleep 1")
        out = []
        ts = [threading.Thread(target=lambda: out.append(self.install("same", files=files).status)) for _ in range(2)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(sorted(out), [201, 409])

    def test_installing_state_visible(self):
        files = self.fixture_files(manifest_install="sleep 1")
        t = threading.Thread(target=lambda: self.install("slow", files=files))
        t.start()
        try:
            end = time.monotonic() + 5
            states = []
            while time.monotonic() < end and "installing" not in states:
                time.sleep(0.01)
                states = [s["state"] for s in self.get("/servers").json() if s["folder"] == "slow"]
            self.assertIn("installing", states)
            self.assertEqual([s["installed_by"] for s in self.get("/servers").json() if s["folder"] == "slow"], [7])
        finally:
            t.join()

    def test_secrets_returned_for_the_eye_and_kept_when_blank(self):
        # The settings form shows a secret as dots with an eye to reveal it, so its value comes back too.
        self.install("ok_server", env={"FAKE_TOKEN": "s3cret", "FAKE_DB_PATH": "n"})
        body = self.get("/servers/ok_server/settings").json()
        sec = next(f for f in body["fields"] if f["name"] == "FAKE_TOKEN")
        self.assertEqual((sec["filled"], sec["secret"], sec["value"]), (True, True, "s3cret"))
        plain = next(f for f in body["fields"] if f["name"] == "FAKE_DB_PATH")
        self.assertEqual(plain["value"], "n")
        r = self.put("/servers/ok_server/settings", {"values": {"FAKE_TOKEN": "", "FAKE_DB_PATH": "m"}})
        self.assertEqual((r.status, r.json()), (200, {"missing": []}))
        self.assertEqual(envfile.parse((self.root / "ok_server/.env").read_text()), {"FAKE_TOKEN": "s3cret", "FAKE_DB_PATH": "m"})

    def test_settings_name_what_the_supervisor_overrides(self):
        self.install("ok_server")
        self.assertEqual(self.get("/servers/ok_server/settings").json()["overridden"], ["FAKE_HOST", "FAKE_PORT"])
        m = {"name": "m", "start": "./run.sh", "host_env": "BIND", "env": [
            {"name": "BIND", "required": True}, {"name": "A_HOST"}, {"name": "LISTEN", "required": True}]}
        self.install("named", files={"synergyai-mcp.json": b64(json.dumps(m)), "run.sh": b64("#!/bin/sh\nsleep 30\n")})
        self.assertEqual(self.get("/servers/named/settings").json()["overridden"], ["BIND"])
        r = self.put("/servers/named/settings", {"values": {"A_HOST": "x"}})
        self.assertEqual(r.json(), {"missing": ["LISTEN"]})   # BIND is set by the supervisor

    def test_missing_required_reported(self):
        m = {"name": "r", "start": "./run.sh", "env": [{"name": "NEED", "required": True}]}
        self.install("req", files={"synergyai-mcp.json": b64(json.dumps(m)), "run.sh": b64("#!/bin/sh\nsleep 30\n")})
        self.assertEqual(self.put("/servers/req/settings", {"values": {}}).json(), {"missing": ["NEED"]})

    def test_settings_list_replaced_keeping_the_manifest(self):
        m = {"name": "r", "start": "./run.sh", "env": [{"name": "OLD", "required": True}]}
        self.install("req", files={"synergyai-mcp.json": b64(json.dumps(m)), "run.sh": b64("#!/bin/sh\nsleep 30\n")})
        r = self.put("/servers/req/schema", {"env": [{"name": "NEW_ID", "label": "Id", "required": True},
                                                      {"name": "NEW_KEY", "secret": True, "group": "g"}]})
        self.assertEqual(r.status, 200)
        self.assertEqual([f["name"] for f in r.json()["fields"]], ["NEW_ID", "NEW_KEY"])
        saved = json.loads((self.root / "req/synergyai-mcp.json").read_text())
        self.assertEqual((saved["name"], saved["start"]), ("r", "./run.sh"))   # the other keys stay
        self.assertEqual(saved["env"], [{"name": "NEW_ID", "label": "Id", "required": True, "secret": False},
                                        {"name": "NEW_KEY", "secret": True, "group": "g"}])
        self.assertEqual(self.put("/servers/req/settings", {"values": {}}).json(), {"missing": ["NEW_ID"]})

    def test_settings_list_refused_when_bad(self):
        m = {"name": "r", "start": "./run.sh", "env": []}
        self.install("req", files={"synergyai-mcp.json": b64(json.dumps(m)), "run.sh": b64("#!/bin/sh\nsleep 30\n")})
        before = (self.root / "req/synergyai-mcp.json").read_text()
        for env in ([{"name": "A"}, {"name": "A"}], [{"name": "1X"}], [{"name": "A", "label": ["x"]}], "x"):
            self.assertEqual(self.put("/servers/req/schema", {"env": env}).status, 400, env)
        (self.root / "req/synergyai-mcp.json").write_text("{not json")
        self.assertEqual(self.put("/servers/req/schema", {"env": []}).status, 409)
        self.assertEqual((self.root / "req/synergyai-mcp.json").read_text(), "{not json")   # never overwritten
        self.assertNotEqual(before, "{not json")

    def test_source_excludes_private_files(self):
        self.install("ok_server", env={"FAKE_TOKEN": "x"})
        d = self.root / "ok_server"
        (d / ".venv").mkdir(); (d / ".venv/a.py").write_text("x")
        (d / "tests").mkdir(); (d / "tests/t.py").write_text("x")
        (d / "sub").mkdir(); (d / "sub/keep.py").write_text("k")
        (d / "server.log.1").write_text("old")
        files = self.get("/servers/ok_server/source").json()["files"]
        self.assertNotIn(".env", files)
        self.assertFalse(any(p.startswith((".venv/", "data/", "tests/")) or p.startswith("server.log") for p in files))
        self.assertIn("run.sh", files)
        self.assertEqual(base64.b64decode(files["sub/keep.py"]), b"k")

    def test_source_honours_include(self):
        m = {"name": "i", "start": "./run.sh", "include": ["run.sh", "synergyai-mcp.json"]}
        self.install("inc", files={"synergyai-mcp.json": b64(json.dumps(m)), "run.sh": b64("sleep 30"), "other.py": b64("x")})
        self.assertEqual(sorted(self.get("/servers/inc/source").json()["files"]), ["run.sh", "synergyai-mcp.json"])

    def test_enabled_restart_delete(self):
        self.install("ok_server")
        r = self.call("POST", "/servers/ok_server/enabled", {"enabled": False})
        self.assertEqual((r.status, self.registry.get("ok_server")["enabled"], self.manager.state("ok_server")), (200, False, "stopped"))
        self.call("POST", "/servers/ok_server/enabled", {"enabled": True})
        self.assertEqual(self.call("POST", "/servers/ok_server/restart").status, 200)
        self.assertEqual(self.call("DELETE", "/servers/ok_server").status, 200)
        self.assertFalse((self.root / "ok_server").exists())
        self.assertIsNone(self.registry.get("ok_server"))
        self.assertEqual(self.call("POST", "/servers/ok_server/restart").status, 404)

    def test_disabled_server_not_started_by_settings_or_restart(self):
        self.install("ok_server")
        self.call("POST", "/servers/ok_server/enabled", {"enabled": False})
        self.assertEqual(self.put("/servers/ok_server/settings", {"values": {"FAKE_DB_PATH": "z"}}).status, 200)
        self.assertEqual(self.manager.state("ok_server"), "stopped")
        r = self.call("POST", "/servers/ok_server/restart")
        self.assertEqual((r.status, r.json()["error"]), (409, "disabled"))
        self.assertEqual(self.manager.state("ok_server"), "stopped")

    def test_delete_keeps_registry_when_rmtree_fails(self):
        from unittest import mock
        self.install("ok_server")
        with mock.patch("mcphost.control.shutil.rmtree", side_effect=OSError("busy")):
            self.assertEqual(self.call("DELETE", "/servers/ok_server").status, 500)
        self.assertIsNotNone(self.registry.get("ok_server"))

    def test_bad_folder_and_body_limits(self):
        self.assertEqual(self.get("/servers/..%2Fx/settings").status, 400)
        self.assertEqual(self.call("DELETE", "/servers/.hid").status, 400)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/servers/x/install", None, {"Authorization": "Bearer " + TOKEN, "Content-Length": str(51 * 1024 * 1024)})
        self.assertEqual(c.getresponse().status, 413)
        self.assertEqual(self.call("POST", "/servers/x/install", raw="not json").status, 400)

    def test_no_free_port_is_507_and_leaves_nothing(self):
        from unittest import mock
        import mcphost.registry as registry
        with mock.patch.object(registry, "PORT_LAST", registry.PORT_FIRST):
            self.assertEqual(self.install("a").status, 201)
            r = self.install("b")
        self.assertEqual((r.status, r.json()), (507, {"error": "no free port"}))
        self.assertFalse((self.root / "b").exists())
        self.assertIsNone(self.registry.get("b"))


class LeftoverTest(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.root = Path(self._d.name)
        self.registry = Registry(self.root)

    def control(self):
        return control.Control(self.root, self.registry, Manager(self.root, self.registry))

    def test_unregistered_folders_are_removed_at_start(self):
        (self.root / "kept").mkdir()
        self.registry.add("kept", "Kept", 1)
        (self.root / "half_installed" / "sub").mkdir(parents=True)
        (self.root / ".hidden").mkdir()
        (self.root / "note.txt").write_text("x")
        self.control()
        self.assertTrue((self.root / "kept").is_dir())
        self.assertFalse((self.root / "half_installed").exists())
        self.assertTrue((self.root / ".hidden").is_dir())       # not a server folder name: left alone
        self.assertTrue((self.root / "note.txt").exists())
        self.assertTrue((self.root / "servers.json").exists())

    def test_odd_shaped_registry_removes_nothing(self):
        (self.root / "srv").mkdir()
        (self.root / "other").mkdir()
        (self.root / "servers.json").write_text('{"srv": {"name": "S", "port": 9101}, "other": 5}')
        self.control()
        self.assertTrue((self.root / "other").is_dir())

    def test_corrupt_registry_removes_nothing(self):
        import contextlib
        import io
        (self.root / "srv").mkdir()
        (self.root / "servers.json").write_text("{broken")
        with contextlib.redirect_stderr(io.StringIO()):
            self.control()
        self.assertTrue((self.root / "srv").is_dir())
