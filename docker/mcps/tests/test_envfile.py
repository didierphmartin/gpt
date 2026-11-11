import unittest

from mcphost.envfile import fields, merge, missing, parse


class EnvFileTest(unittest.TestCase):
    def test_group_kept_and_missing(self):
        fl = fields({"env": [{"name": "ID", "required": True}, {"name": "T", "group": " org "}, {"name": "G", "group": "org"},
                             {"name": "P", "group": ""}]}, "")
        self.assertEqual([f.get("group") for f in fl], [None, "org", "org", None])
        self.assertEqual(missing(fl, {}), ["ID"])                         # group untouched: not needed
        self.assertEqual(missing(fl, {"ID": "x", "T": "t"}), ["G"])       # group started: the rest is needed
        self.assertEqual(missing(fl, {"ID": "x", "T": "t", "G": "g"}), [])
        self.assertEqual(missing(fl, {"T": "t"}, skip=("ID",)), ["G"])    # supervisor-set names are skipped

    def test_merge_keeps_other_lines(self):
        self.assertEqual(merge("# c\nA=1\nB=2\n", {"B": "x y"}), '# c\nA=1\nB="x y"\n')

    def test_merge_appends_and_empty(self):
        self.assertEqual(merge("A=1\n", {"C": "3"}), "A=1\nC=3\n")
        self.assertEqual(merge("", {"A": 'q"\\\n'}), 'A="q\\"\\\\\\n"\n')

    def test_merge_invalid_name(self):
        with self.assertRaises(ValueError):
            merge("", {"1bad": "x"})

    def test_parse_quoted_and_semicolons(self):
        self.assertEqual(parse('E="Endpoint=sb://h;Key=k"\n# x\n'), {"E": "Endpoint=sb://h;Key=k"})

    def test_parse_roundtrip_and_single_quotes(self):
        text = merge("", {"A": 'a "b" \\ c\nd'})
        self.assertEqual(parse(text), {"A": 'a "b" \\ c\nd'})
        self.assertEqual(parse("B='x y'\nC=v # note\n"), {"B": "x y", "C": "v"})

    def test_fields_manifest_wins_and_secret_flag(self):
        f = fields({"env": [{"name": "OUTLOOK_SECRET_KEY", "required": True}]}, "IGNORED=1\n")
        self.assertEqual(f, [{"name": "OUTLOOK_SECRET_KEY", "label": "", "required": True, "secret": True, "default": ""}])

    def test_fields_skip_malformed_manifest_entries(self):
        f = fields({"env": ["A", 3, None, {"label": "no name"}, {"name": 7}, {"name": "B"}]}, "")
        self.assertEqual([x["name"] for x in f], ["B"])

    def test_fields_from_example(self):
        f = fields(None, "# Tenant id\n# of the app\nTENANT=abc\n\nAPI_TOKEN=\"x\"\n")
        self.assertEqual(f[0], {"name": "TENANT", "label": "Tenant id of the app", "required": False, "secret": False, "default": "abc"})
        self.assertTrue(f[1]["secret"])
        self.assertEqual(f[1]["default"], "x")

    def test_connection_is_secret(self):
        self.assertTrue(fields(None, "EVENTHUB_CONNECTION=\n")[0]["secret"])
