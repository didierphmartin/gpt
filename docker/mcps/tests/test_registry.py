import tempfile
import unittest
from pathlib import Path

from mcphost.registry import Registry, RegistryError


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.tmp = Path(self._d.name)

    def test_corrupt_file_loads_empty_and_is_kept(self):
        import contextlib
        import io
        (self.tmp / "servers.json").write_text("{not json")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(Registry(self.tmp).load(), {})
        self.assertIn("servers.json", err.getvalue())
        self.assertEqual((self.tmp / "servers.json").read_text(), "{not json")

    def test_corrupt_or_odd_file_is_never_overwritten(self):
        import contextlib
        import io
        for text in ("{not json", "[1, 2]", '{"a": 5, "b": {"name": "B", "port": 9101}}'):
            (self.tmp / "servers.json").write_text(text)
            r = Registry(self.tmp)
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(RegistryError):
                    r.add("new", "New", 1)
                with self.assertRaises(RegistryError):
                    r.remove("b")
                with self.assertRaises(ValueError):
                    r.load(strict=True)
            self.assertEqual((self.tmp / "servers.json").read_text(), text)

    def test_non_dict_entries_are_ignored(self):
        (self.tmp / "servers.json").write_text('{"a": 5, "b": {"name": "B", "port": 9101}}')
        self.assertEqual(list(Registry(self.tmp).load()), ["b"])

    def test_ports_are_lowest_free_and_kept(self):
        r = Registry(self.tmp)
        self.assertEqual(r.add("outlook_mcp", "Outlook", 3)["port"], 9101)
        self.assertEqual(r.add("sharepoint_mcp", "SharePoint", 3)["port"], 9102)
        r.remove("outlook_mcp")
        self.assertEqual(r.add("jira_mcp", "Jira", 3)["port"], 9101)
        self.assertEqual(Registry(self.tmp).get("sharepoint_mcp")["port"], 9102)

    def test_folder_taken_refused(self):
        r = Registry(self.tmp)
        r.add("x", "X", 1)
        with self.assertRaises(RegistryError):
            r.add("x", "X", 1)

    def test_full_refused(self):
        r = Registry(self.tmp)
        for i in range(99):
            r.add(f"s{i}", "S", 1)
        with self.assertRaises(RegistryError):
            r.add("extra", "S", 1)

    def test_enabled_toggle_and_get_missing(self):
        r = Registry(self.tmp)
        self.assertIsNone(r.get("nope"))
        r.add("x", "X", 1)
        r.set_enabled("x", False)
        self.assertFalse(Registry(self.tmp).get("x")["enabled"])

    def test_concurrent_adds_get_distinct_ports(self):
        import json
        import threading
        r = Registry(self.tmp)
        errors = []

        def work(i):
            try:
                r.add(f"s{i}", "S", 1)
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        ts = [threading.Thread(target=work, args=(i,)) for i in range(20)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(errors, [])
        data = json.loads((self.tmp / "servers.json").read_text())
        self.assertEqual(len(data), 20)
        self.assertEqual(len({s["port"] for s in data.values()}), 20)
