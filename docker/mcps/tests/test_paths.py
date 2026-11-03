import unittest

from mcphost.paths import is_safe_rel_path, is_safe_segment


class PathsTest(unittest.TestCase):
    def test_rules(self):
        self.assertTrue(is_safe_rel_path("fonts/a.ttf"))
        for bad in ["../x", "a/../../b", "/etc/passwd", ".env", ".git/config", "a\\b", "", "a//b", "./a", "a/.hidden"]:
            self.assertFalse(is_safe_rel_path(bad), bad)
        self.assertTrue(is_safe_rel_path(".env.example"))
        self.assertTrue(is_safe_rel_path("sub/.env.example"))
        self.assertFalse(is_safe_segment("Share Point/.."))
        self.assertTrue(is_safe_segment("outlook_mcp"))
        for bad in ["", ".x", "a/b", "a\\b", "a..b"]:
            self.assertFalse(is_safe_segment(bad), bad)
