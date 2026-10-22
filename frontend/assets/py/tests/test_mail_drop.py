"""The "Mail dropped in a folder" Start option, run through the code node harness with a fake transport."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import code_node_harness as h  # noqa: E402

COMP = HERE.parents[3] / "backend" / "resources" / "code_components"
SOURCE = (COMP / "mail_drop.py").read_text()
META = json.loads((COMP / "mail_drop.json").read_text())

MAIL = {"id": "m1", "from": "ann@x.com", "subject": "Invoice 42", "received_at": "2026-10-09T08:15:00Z",
        "attempt": 1, "attachments": [{"id": "a1", "name": "inv.pdf", "is_inline": False}]}


class Fake:
    def __init__(self, mail=MAIL, fail=False):
        self.mail, self.fail, self.calls = mail, fail, []

    def __call__(self, server, tool, args):
        self.calls.append((f"{server}.{tool}", args))
        if self.fail:
            return {"isError": True, "content": [{"type": "text", "text": "boom"}]}
        data = {"mail": self.mail}
        return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}


def go(fake, args=None):
    r = h.execute(SOURCE, "", META["exits"], ["outlook"], fake, 30, args={} if args is None else args)
    return r, (json.loads(r["output_text"]) if r.get("ok") and r.get("output_text") else None)


class MailDrop(unittest.TestCase):
    def test_source_passes_check_code(self):
        h.check_code(SOURCE)

    def test_hands_on_the_mail_with_its_drop_folder(self):
        f = Fake()
        r, out = go(f, {"folder": "To SharePoint"})
        self.assertEqual(r["route"], "mail")
        self.assertEqual(f.calls, [("outlook.poll_new_mail", {"folder": "To SharePoint", "mode": "drop"})])
        self.assertEqual(out, {**MAIL, "folder": "To SharePoint"})

    def test_idle_when_no_mail(self):
        r, _ = go(Fake(mail=None))
        self.assertEqual(r["route"], "idle")

    def test_poll_failure_is_error(self):
        r, out = go(Fake(fail=True))
        self.assertEqual(r["route"], "error")
        self.assertIn("boom", out["reason"])
        self.assertIsNone(out["mail_id"])

    def test_default_folder_matches_watch_default(self):
        for args in ({}, {"folder": ""}, {"folder": "  "}):
            f = Fake(mail=None)
            go(f, args)
            self.assertEqual(f.calls[0][1], {"folder": META["start_trigger"]["watch"]["args"]["folder"], "mode": "drop"})

    def test_work_exit_is_mail_and_folder_is_passed(self):
        self.assertEqual(META["start_trigger"]["work_exit"], "mail")
        self.assertEqual(META["start_trigger"]["pass_args"], ["folder"])
        self.assertIn("mail", META["exits"])


if __name__ == "__main__":
    unittest.main()
