import tempfile
import unittest
from pathlib import Path

from mcphost.registry import Registry, RegistryError


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.addCleanup(self._d.cleanup)
        self.tmp = Path(self._d.name)

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
