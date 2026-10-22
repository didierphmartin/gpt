"""The "Mail drop -> SharePoint" component, run through the code node harness with a fake transport."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import code_node_harness as h  # noqa: E402

COMP = HERE.parents[3] / "backend" / "resources" / "code_components"
SOURCE = (COMP / "mail_drop_sharepoint.py").read_text()
META = json.loads((COMP / "mail_drop_sharepoint.json").read_text())

MAIL = {"id": "m1", "from": "ann@x.com", "to": ["me@x.com"], "cc": [], "subject": "Invoice 42",
        "received_at": "2026-10-09T08:15:00Z", "body_text": "hi", "web_link": "", "attempt": 1,
        "attachments": [{"id": "a1", "name": "inv.pdf", "content_type": "application/pdf", "size": 3, "is_inline": False},
                        {"id": "a2", "name": "logo.png", "content_type": "image/png", "size": 3, "is_inline": True}]}


def ok_result(data):
    return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}


class Fake:
    def __init__(self, mail=MAIL, fail=None):
        self.mail, self.fail, self.calls = mail, fail, []

    def __call__(self, server, tool, args):
        self.calls.append((f"{server}.{tool}", args))
        if f"{server}.{tool}" == self.fail:
            return {"isError": True, "content": [{"type": "text", "text": "boom"}]}
        return ok_result({
            "sharepoint.whoami": {"account": "a", "tenant": "t", "connected_at": "now"},
            "outlook.poll_new_mail": {"mail": self.mail},
            "sharepoint.ensure_folder": {"path": "Didier", "id": "1", "created": False},
            "sharepoint.create_subfolder": {"path": "Didier/sub", "id": "2"},
            "outlook.mail_to_pdf": {"name": "Email.pdf", "size": 3, "base64": "UERG"},
            "outlook.get_attachment": {"name": "inv.pdf", "content_type": "application/pdf", "size": 3, "base64": "QVRU"},
            "sharepoint.upload_file": {"path": "p", "id": "3", "web_url": "u", "size": 3},
            "outlook.move_mail": {"id": "m1", "folder": "Filed", "created": False},
        }[f"{server}.{tool}"])

    def names(self):
        return [c[0] for c in self.calls]


def go(fake, args=None):
    args = {"sharepoint_folder": "Didier"} if args is None else args
    r = h.execute(SOURCE, None, META["exits"], ["outlook", "sharepoint"], fake, 30, args=args)
    return r, (json.loads(r["output_text"]) if r.get("ok") else None)


class MailDrop(unittest.TestCase):
    def test_source_passes_check_code(self):
        h.check_code(SOURCE)

    def test_filed_uploads_pdf_and_attachments_then_moves(self):
        f = Fake()
        r, out = go(f)
        self.assertEqual(r["route"], "filed")
        self.assertEqual(f.names(), ["sharepoint.whoami", "outlook.poll_new_mail", "sharepoint.ensure_folder",
                                     "sharepoint.create_subfolder", "outlook.mail_to_pdf", "sharepoint.upload_file",
                                     "outlook.get_attachment", "sharepoint.upload_file", "outlook.move_mail"])
        c = dict((n, a) for n, a in f.calls)
        self.assertEqual(c["sharepoint.create_subfolder"],
                         {"parent": "Didier", "name": "2026-10-09 0815 - ann@x.com - Invoice 42"})
        self.assertEqual(c["outlook.get_attachment"], {"mail_id": "m1", "attachment_id": "a1", "raw": True})
        self.assertEqual(c["outlook.move_mail"], {"mail_id": "m1", "folder": "Filed"})
        self.assertEqual(out, {"folder": "Didier/sub", "files": ["Email.pdf", "inv.pdf"]})

    def test_idle_when_no_mail(self):
        f = Fake(mail=None)
        r, _ = go(f)
        self.assertEqual(r["route"], "idle")
        self.assertEqual(f.names(), ["sharepoint.whoami", "outlook.poll_new_mail"])

    def test_preflight_failure_claims_nothing(self):
        f = Fake(fail="sharepoint.whoami")
        r, out = go(f)
        self.assertEqual(r["route"], "error")
        self.assertIsNone(out["mail_id"])
        self.assertNotIn("outlook.poll_new_mail", f.names())

    def test_upload_failure_is_error_without_move(self):
        f = Fake(fail="sharepoint.upload_file")
        r, out = go(f)
        self.assertEqual(r["route"], "error")
        self.assertEqual(out["mail_id"], "m1")
        self.assertIn("boom", out["reason"])
        self.assertNotIn("outlook.move_mail", f.names())

    def test_missing_sharepoint_folder_is_error_before_poll(self):
        f = Fake()
        r, out = go(f, args={})
        self.assertEqual(r["route"], "error")
        self.assertIn("set sharepoint_folder in the Start arguments", out["reason"])
        self.assertEqual(f.calls, [])

    def test_default_folder_matches_watch_default(self):
        f = Fake(mail=None)
        go(f)
        poll = [a for n, a in f.calls if n == "outlook.poll_new_mail"][0]
        self.assertEqual(poll, {"folder": META["start_trigger"]["watch"]["args"]["folder"], "mode": "drop"})

    def test_filed_folder_override(self):
        f = Fake()
        go(f, args={"sharepoint_folder": "Didier", "filed_folder": "Done"})
        self.assertEqual([a for n, a in f.calls if n == "outlook.move_mail"][0]["folder"], "Done")

    def test_empty_subject_and_long_subject(self):
        f = Fake(mail=dict(MAIL, subject="", attachments=[]))
        go(f)
        self.assertTrue([a for n, a in f.calls if n == "sharepoint.create_subfolder"][0]["name"].endswith("(no subject)"))
        f = Fake(mail=dict(MAIL, subject="x" * 100, attachments=[]))
        go(f)
        self.assertTrue([a for n, a in f.calls if n == "sharepoint.create_subfolder"][0]["name"].endswith(" - " + "x" * 60))


if __name__ == "__main__":
    unittest.main()
