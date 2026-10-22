"""The "File email to SharePoint" component, run through the code node harness with a fake transport."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import code_node_harness as h  # noqa: E402

COMP = HERE.parents[3] / "backend" / "resources" / "code_components"
SOURCE = (COMP / "file_mail_to_sharepoint.py").read_text()
META = json.loads((COMP / "file_mail_to_sharepoint.json").read_text())

MAIL = {"id": "m1", "from": "ann@x.com", "to": ["me@x.com"], "cc": [], "subject": "Invoice 42",
        "received_at": "2026-10-09T08:15:00Z", "body_text": "hi", "web_link": "", "attempt": 1, "folder": "To SharePoint",
        "attachments": [{"id": "a1", "name": "inv.pdf", "content_type": "application/pdf", "size": 3, "is_inline": False},
                        {"id": "a2", "name": "logo.png", "content_type": "image/png", "size": 3, "is_inline": True}]}


def ok_result(data):
    return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}


class Fake:
    """The two servers. upload_file stores under the requested name unless `renamed` maps it to another one
    (SharePoint's conflictBehavior=rename); get_attachment answers each attachment's own name."""

    def __init__(self, mail=MAIL, fail=None, renamed=None):
        self.mail, self.fail, self.renamed, self.calls = mail, fail, renamed or {}, []
        self.input = mail

    def __call__(self, server, tool, args):
        self.calls.append((f"{server}.{tool}", args))
        if f"{server}.{tool}" == self.fail:
            return {"isError": True, "content": [{"type": "text", "text": "boom"}]}
        match f"{server}.{tool}":
            case "outlook.get_attachment":
                att = next(a for a in self.mail["attachments"] if a["id"] == args["attachment_id"])
                return ok_result({"name": att["name"], "content_type": att["content_type"], "size": 3, "base64": "QVRU"})
            case "sharepoint.upload_file":
                stored = self.renamed.get(args["name"], args["name"])
                return ok_result({"path": f"{args['folder']}/{stored}", "id": "3", "web_url": "u", "size": 3})
        return ok_result({
            "sharepoint.ensure_folder": {"path": "Didier", "id": "1", "created": []},
            "sharepoint.create_subfolder": {"path": "Didier/sub", "id": "2"},
            "outlook.mail_to_pdf": {"name": "Email.pdf", "size": 3, "base64": "UERG"},
            "outlook.move_mail": {"id": "m1", "folder": "Filed", "created": []},
        }[f"{server}.{tool}"])

    def names(self):
        return [c[0] for c in self.calls]


def go(fake, args=None, input=None):
    args = {"sharepoint_folder": "Didier"} if args is None else args
    r = h.execute(SOURCE, fake.input if input is None else input, META["exits"], ["outlook", "sharepoint"], fake, 30,
                  args=args)
    return r, (json.loads(r["output_text"]) if r.get("ok") else None)


class FileMailToSharePoint(unittest.TestCase):
    def test_source_passes_check_code(self):
        h.check_code(SOURCE)

    def test_filed_uploads_pdf_and_attachments_then_moves(self):
        f = Fake()
        r, out = go(f)
        self.assertEqual(r["route"], "filed")
        self.assertEqual(f.names(), ["sharepoint.ensure_folder", "sharepoint.create_subfolder", "outlook.mail_to_pdf",
                                     "sharepoint.upload_file", "outlook.get_attachment", "sharepoint.upload_file",
                                     "outlook.move_mail"])
        c = dict((n, a) for n, a in f.calls)
        self.assertEqual(c["sharepoint.create_subfolder"],
                         {"parent": "Didier", "name": "2026-10-09 0815 - ann@x.com - Invoice 42"})
        self.assertEqual(c["outlook.get_attachment"], {"mail_id": "m1", "attachment_id": "a1", "raw": True})
        self.assertEqual(c["outlook.move_mail"], {"mail_id": "m1", "folder": "Filed"})
        self.assertEqual(out, {"folder": "Didier/sub", "files": ["Email.pdf", "inv.pdf"], "skipped": []})

    def test_mail_as_json_text_is_accepted(self):
        f = Fake()
        r, _ = go(f, input=json.dumps(MAIL))
        self.assertEqual(r["route"], "filed")

    def test_no_mail_in_input_is_error_before_any_call(self):
        for bad in (None, "", "hello", {}, {"subject": "x"}, [1]):
            f = Fake()
            r, out = go(f, input=bad if bad is not None else "")
            self.assertEqual(r["route"], "error", bad)
            self.assertIn("no email in the input", out["reason"])
            self.assertEqual(f.calls, [])

    def test_ensure_folder_failure_is_error_without_move(self):
        f = Fake(fail="sharepoint.ensure_folder")
        r, out = go(f)
        self.assertEqual(r["route"], "error")
        self.assertEqual(out["mail_id"], "m1")
        self.assertEqual(f.names(), ["sharepoint.ensure_folder"])

    def test_upload_failure_is_error_without_move(self):
        f = Fake(fail="sharepoint.upload_file")
        r, out = go(f)
        self.assertEqual(r["route"], "error")
        self.assertEqual(out["mail_id"], "m1")
        self.assertIn("boom", out["reason"])
        self.assertNotIn("outlook.move_mail", f.names())

    def test_missing_sharepoint_folder_is_error_before_any_call(self):
        f = Fake()
        r, out = go(f, args={})
        self.assertEqual(r["route"], "error")
        self.assertIn("set sharepoint_folder in this node's arguments", out["reason"])
        self.assertEqual(out["mail_id"], "m1")
        self.assertEqual(f.calls, [])

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

    def test_target_folder_is_ensured_once_and_its_path_is_the_parent(self):
        f = Fake()
        go(f, args={"sharepoint_folder": "didier"})
        self.assertEqual(f.names().count("sharepoint.ensure_folder"), 1)
        self.assertEqual([a for n, a in f.calls if n == "sharepoint.ensure_folder"][0], {"path": "didier"})
        self.assertEqual([a for n, a in f.calls if n == "sharepoint.create_subfolder"][0]["parent"], "Didier")

    def test_inline_image_skipped_but_inline_pdf_uploaded(self):
        atts = [{"id": "a1", "name": "logo.png", "content_type": "image/png", "size": 3, "is_inline": True},
                {"id": "a2", "name": "scan.pdf", "content_type": "application/pdf", "size": 3, "is_inline": True},
                {"id": "a3", "name": "Photo.JPG", "content_type": "IMAGE/JPEG", "size": 3, "is_inline": True}]
        f = Fake(mail=dict(MAIL, attachments=atts))
        r, out = go(f)
        self.assertEqual(r["route"], "filed")
        self.assertEqual([a["attachment_id"] for n, a in f.calls if n == "outlook.get_attachment"], ["a2"])
        self.assertEqual(out["files"], ["Email.pdf", "scan.pdf"])

    def test_cloud_link_attachments_are_skipped_and_reported(self):
        atts = [{"id": "a1", "name": "inv.pdf", "content_type": "application/pdf", "size": 3, "is_inline": False,
                 "kind": "file"},
                {"id": "a2", "name": "Budget.xlsx", "content_type": "", "size": 0, "is_inline": False,
                 "kind": "reference"}]
        f = Fake(mail=dict(MAIL, attachments=atts))
        r, out = go(f)
        self.assertEqual(r["route"], "filed")
        self.assertEqual([a["attachment_id"] for n, a in f.calls if n == "outlook.get_attachment"], ["a1"])
        self.assertEqual(out, {"folder": "Didier/sub", "files": ["Email.pdf", "inv.pdf"], "skipped": ["Budget.xlsx"]})
        self.assertIn("outlook.move_mail", f.names())

    def test_filed_folder_equal_to_drop_folder_is_error_before_any_call(self):
        for filed in ("to sharepoint", " /To SharePoint/ ", "TO SHAREPOINT"):
            f = Fake()
            r, out = go(f, args={"sharepoint_folder": "Didier", "filed_folder": filed})
            self.assertEqual(r["route"], "error", filed)
            self.assertIn("filed_folder", out["reason"])
            self.assertEqual(f.calls, [])
        f = Fake(mail=dict(MAIL, folder="Inbox/Drop"))
        r, _ = go(f, args={"sharepoint_folder": "Didier", "filed_folder": "/inbox/drop"})
        self.assertEqual((r["route"], f.calls), ("error", []))
        f = Fake(mail={k: v for k, v in MAIL.items() if k != "folder"})
        r, _ = go(f, args={"sharepoint_folder": "Didier", "filed_folder": "To SharePoint"})
        self.assertEqual(r["route"], "filed")              # no drop folder named: nothing to compare against

    def test_empty_and_integer_args(self):
        f = Fake()
        r, _ = go(f, args={"sharepoint_folder": 1234, "filed_folder": ""})
        self.assertEqual(r["route"], "filed")
        self.assertEqual([a for n, a in f.calls if n == "sharepoint.ensure_folder"][0], {"path": "1234"})
        self.assertEqual([a for n, a in f.calls if n == "outlook.move_mail"][0]["folder"], "Filed")
        f = Fake()
        go(f, args={"sharepoint_folder": " Didier ", "filed_folder": "   "})
        self.assertEqual([a for n, a in f.calls if n == "outlook.move_mail"][0]["folder"], "Filed")
        self.assertEqual([a for n, a in f.calls if n == "sharepoint.ensure_folder"][0], {"path": "Didier"})
        f = Fake()
        r, out = go(f, args={"sharepoint_folder": "  "})
        self.assertEqual((r["route"], f.calls), ("error", []))

    def test_files_lists_the_stored_names(self):
        atts = [{"id": "a1", "name": "inv.pdf", "content_type": "application/pdf", "size": 3, "is_inline": False},
                {"id": "a2", "name": "inv.pdf", "content_type": "application/pdf", "size": 3, "is_inline": False}]
        f = Fake(mail=dict(MAIL, attachments=atts), renamed={"inv.pdf": "inv 1.pdf"})
        _, out = go(f)
        self.assertEqual(out["files"], ["Email.pdf", "inv 1.pdf", "inv 1.pdf"])


if __name__ == "__main__":
    unittest.main()
