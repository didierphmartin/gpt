"""The mail drop workflow's components -- "Mail dropped in a folder" (Start), "Document -> PDF", "SharePoint -- move"
-- each run through the code node harness with a fake transport, and chained as the workflow chains them."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import code_node_harness as h  # noqa: E402

COMP = HERE.parents[3] / "backend" / "resources" / "code_components"


def load(name):
    return (COMP / f"{name}.py").read_text(), json.loads((COMP / f"{name}.json").read_text())


START, START_META = load("mail_drop")
CONVERT, CONVERT_META = load("document_to_pdf")
MOVE, MOVE_META = load("sharepoint_move")

MAIL = {"id": "m1", "from": "ann@x.com", "to": ["me@x.com"], "cc": [], "subject": "Invoice 42",
        "received_at": "2026-10-09T08:15:00Z", "body_text": "hi", "web_link": "w", "attempt": 1,
        "attachments": [{"id": "a1", "name": "inv.pdf", "content_type": "application/pdf", "size": 3,
                         "is_inline": False, "kind": "file"},
                        {"id": "a2", "name": "logo.png", "content_type": "image/png", "size": 3, "is_inline": True},
                        {"id": "a3", "name": "Budget.xlsx", "content_type": "", "size": 0, "is_inline": False,
                         "kind": "reference"}]}


def ok_result(data):
    return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}


class Fake:
    """Outlook + SharePoint. `fail` names one tool that answers an error; upload_file stores under the requested
    name unless `renamed` maps it."""

    def __init__(self, mail=MAIL, fail=None, renamed=None):
        self.mail, self.fail, self.renamed, self.calls = mail, fail, renamed or {}, []

    def __call__(self, server, tool, args):
        self.calls.append((f"{server}.{tool}", args))
        if f"{server}.{tool}" == self.fail:
            return {"isError": True, "content": [{"type": "text", "text": "boom"}]}
        match f"{server}.{tool}":
            case "sharepoint.upload_file":
                stored = self.renamed.get(args["name"], args["name"])
                return ok_result({"path": f"{args['folder']}/{stored}", "id": "3", "web_url": f"u/{stored}", "size": 3})
            case "sharepoint.create_subfolder":
                return ok_result({"path": f"{args['parent']}/{args['name']}", "id": "2"})
        return ok_result({
            "outlook.poll_new_mail": {"mail": self.mail},
            "outlook.get_attachment": {"name": "x", "content_type": "", "size": 3, "base64": "QVRU"},
            "outlook.mail_to_pdf": {"name": "Email.pdf", "size": 3, "base64": "UERG"},
            "outlook.move_mail": {"id": "m1", "folder": args.get("folder"), "created": []},
            "sharepoint.ensure_folder": {"path": "Didier", "id": "1", "created": []},
        }[f"{server}.{tool}"])

    def names(self):
        return [c[0] for c in self.calls]


def run(source, meta, fake, input, args=None, servers=("outlook", "sharepoint")):
    r = h.execute(source, input, meta["exits"], list(servers), fake, 30, args=args or {})
    return r, (json.loads(r["output_text"]) if r.get("ok") and r.get("output_text") else None)


def start(fake=None, args=None):
    return run(START, START_META, fake or Fake(), "", {"folder": "To SharePoint"} if args is None else args)


class MailDroppedInAFolder(unittest.TestCase):
    def test_packages_document_attachments_and_source(self):
        f = Fake()
        r, out = start(f)
        self.assertEqual(r["route"], "dropped_mail")
        self.assertEqual(f.calls, [("outlook.poll_new_mail", {"folder": "To SharePoint", "mode": "drop"})])
        self.assertEqual(out["document"], {
            "kind": "email", "name": "Email",
            "meta": {"from": "ann@x.com", "to": ["me@x.com"], "cc": [], "subject": "Invoice 42",
                     "received_at": "2026-10-09T08:15:00Z", "web_link": "w"},
            "text": "hi",
            "renditions": {"pdf": {"server": "outlook", "tool": "mail_to_pdf", "args": {"mail_id": "m1"}}}})
        self.assertEqual(out["attachments"], [{"name": "inv.pdf", "content_type": "application/pdf", "size": 3,
                                               "from": {"server": "outlook", "tool": "get_attachment",
                                                        "args": {"mail_id": "m1", "attachment_id": "a1", "raw": True}}}])
        self.assertEqual(out["not_fetched"], ["Budget.xlsx"])     # a cloud link; the inline logo is simply left out
        self.assertEqual(out["source"], {"server": "outlook", "id": "m1", "folder": "To SharePoint", "attempt": 1,
                                         "release": {"server": "outlook", "tool": "move_mail",
                                                     "args": {"mail_id": "m1", "folder": "Filed"}}})
        self.assertNotIn("base64", json.dumps(out))

    def test_inline_pdf_is_an_attachment_inline_images_are_not(self):
        atts = [{"id": "a1", "name": "Photo.JPG", "content_type": "IMAGE/JPEG", "is_inline": True},
                {"id": "a2", "name": "scan.pdf", "content_type": "application/pdf", "is_inline": True}]
        _, out = start(Fake(mail=dict(MAIL, attachments=atts)))
        self.assertEqual([a["name"] for a in out["attachments"]], ["scan.pdf"])

    def test_idle_error_and_done_folder(self):
        self.assertEqual(start(Fake(mail=None))[0]["route"], "no_mail")
        r, out = start(Fake(fail="outlook.poll_new_mail"))
        self.assertEqual(r["route"], "error")
        self.assertIn("boom", out["reason"])
        _, out = start(args={"folder": "To SharePoint", "done_folder": "Archived "})
        self.assertEqual(out["source"]["release"]["args"]["folder"], "Archived")
        for same in ("to sharepoint", " /To SharePoint/ "):
            f = Fake()
            r, out = start(f, {"folder": "To SharePoint", "done_folder": same})
            self.assertEqual((r["route"], f.calls), ("error", []), same)
            self.assertIn("done_folder", out["reason"])

    def test_default_folder_matches_watch_default(self):
        for args in ({}, {"folder": ""}, {"folder": "  "}):
            f = Fake(mail=None)
            start(f, args)
            self.assertEqual(f.calls[0][1], {"folder": START_META["start_trigger"]["watch"]["args"]["folder"],
                                             "mode": "drop"})

    def test_meta(self):
        h.check_code(START)
        self.assertEqual(START_META["start_trigger"]["work_exit"], "dropped_mail")
        self.assertEqual(START_META["start_trigger"]["pass_args"], ["folder"])


class DocumentToPdf(unittest.TestCase):
    def test_document_becomes_pdf_attachments_untouched_rest_passes_through(self):
        _, pkg = start()
        f = Fake()
        r, out = run(CONVERT, CONVERT_META, f, pkg)
        self.assertEqual(r["route"], "converted")
        self.assertEqual(f.calls, [])                       # references only: the storing node fetches
        self.assertEqual(out["files"], [
            {"name": "Email.pdf", "from": {"server": "outlook", "tool": "mail_to_pdf", "args": {"mail_id": "m1"}}},
            {"name": "inv.pdf", "from": pkg["attachments"][0]["from"]}])
        for k in ("document", "attachments", "source", "not_fetched"):
            self.assertEqual(out[k], pkg[k])

    def test_pdf_document_and_inline_content(self):
        pkg = {"document": {"name": "Letter.pdf", "content_type": "application/pdf", "base64": "UERG"},
               "attachments": [{"name": "Contract.docx", "base64": "RE9D", "content_type": "x"}]}
        r, out = run(CONVERT, CONVERT_META, Fake(), json.dumps(pkg))
        self.assertEqual(r["route"], "converted")
        self.assertEqual(out["files"], [{"base64": "UERG", "name": "Letter.pdf"},
                                        {"name": "Contract.docx", "base64": "RE9D"}])

    def test_unconvertible_and_bad_input(self):
        r, out = run(CONVERT, CONVERT_META, Fake(), {"document": {"kind": "fax"}, "source": {"id": "s"}})
        self.assertEqual(r["route"], "error")
        self.assertIn("cannot convert a fax to PDF", out["reason"])
        self.assertEqual(out["source"], {"id": "s"})
        for bad in ("", "hello", {}, {"attachments": []}, [1]):
            r, out = run(CONVERT, CONVERT_META, Fake(), bad)
            self.assertEqual(r["route"], "error", bad)
            self.assertIn("no document in the input", out["reason"])

    def test_meta(self):
        h.check_code(CONVERT)
        self.assertEqual(CONVERT_META["exits"], ["converted", "error"])


class SharePointMove(unittest.TestCase):
    def converted(self):
        return run(CONVERT, CONVERT_META, Fake(), start()[1])[1]

    def test_stores_then_releases_the_source(self):
        f = Fake()
        r, out = run(MOVE, MOVE_META, f, self.converted(), {"folder": "Didier"})
        self.assertEqual(r["route"], "moved")
        self.assertEqual(f.names(), ["sharepoint.ensure_folder", "sharepoint.create_subfolder", "outlook.mail_to_pdf",
                                     "sharepoint.upload_file", "outlook.get_attachment", "sharepoint.upload_file",
                                     "outlook.move_mail"])
        ups = [a for n, a in f.calls if n == "sharepoint.upload_file"]
        self.assertEqual([(u["name"], u["base64"]) for u in ups], [("Email.pdf", "UERG"), ("inv.pdf", "QVRU")])
        sub = "Didier/2026-10-09 0815 - ann@x.com - Invoice 42"
        self.assertEqual({u["folder"] for u in ups}, {sub})
        self.assertEqual(f.calls[-1], ("outlook.move_mail", {"mail_id": "m1", "folder": "Filed"}))
        self.assertEqual(out, {"status": "moved", "folder": sub, "files": ["Email.pdf", "inv.pdf"],
                               "web_urls": ["u/Email.pdf", "u/inv.pdf"], "released": True})

    def test_any_failure_is_no_and_the_source_stays(self):
        for tool in ("sharepoint.ensure_folder", "sharepoint.create_subfolder", "outlook.mail_to_pdf",
                     "outlook.get_attachment", "sharepoint.upload_file"):
            f = Fake(fail=tool)
            r, out = run(MOVE, MOVE_META, f, self.converted(), {"folder": "Didier"})
            self.assertEqual(r["route"], "error", tool)
            self.assertEqual((out["status"], out["released"]), ("error", False))
            self.assertIn("boom", out["reason"])
            self.assertNotIn("outlook.move_mail", f.names(), tool)

    def test_release_failure_is_no_after_storing(self):
        r, out = run(MOVE, MOVE_META, Fake(fail="outlook.move_mail"), self.converted(), {"folder": "Didier"})
        self.assertEqual(r["route"], "error")
        self.assertIn("not released", out["reason"])

    def test_without_document_or_source_it_just_stores(self):
        f = Fake()
        r, out = run(MOVE, MOVE_META, f, {"files": [{"name": "a.txt", "base64": "QQ=="}]}, {"folder": "D"})
        self.assertEqual(r["route"], "moved")
        self.assertEqual(f.names(), ["sharepoint.ensure_folder", "sharepoint.upload_file"])
        self.assertEqual((out["folder"], out["released"]), ("Didier", False))

    def test_stored_names_follow_sharepoint_renames(self):
        data = {"files": [{"name": "inv.pdf", "base64": "QQ=="}, {"name": "inv.pdf", "base64": "QQ=="}]}
        _, out = run(MOVE, MOVE_META, Fake(renamed={"inv.pdf": "inv 1.pdf"}), data, {"folder": "D"})
        self.assertEqual(out["files"], ["inv 1.pdf", "inv 1.pdf"])

    def test_bad_files_args_and_input(self):
        for files in ([{"name": "a"}], [{"name": "a", "from": {"server": "outlook"}}]):
            r, out = run(MOVE, MOVE_META, Fake(), {"files": files}, {"folder": "D"})
            self.assertEqual(r["route"], "error")
            self.assertIn("'a'", out["reason"])
        r, out = run(MOVE, MOVE_META, Fake(), {"files": [{"name": "a", "from": {"server": "outlook",
                                                                                 "tool": "move_mail"}}]}, {"folder": "D"})
        self.assertIn("returned no base64", out["reason"])
        f = Fake()
        r, out = run(MOVE, MOVE_META, f, self.converted(), {"folder": "  "})
        self.assertEqual((r["route"], f.calls), ("error", []))
        self.assertIn("folder in this node's arguments", out["reason"])
        for bad in ("", {}, {"files": []}, {"files": "x"}):
            f = Fake()
            r, out = run(MOVE, MOVE_META, f, bad, {"folder": "D"})
            self.assertEqual((r["route"], f.calls), ("error", []), bad)

    def test_server_not_ticked_is_no(self):
        r, out = run(MOVE, MOVE_META, Fake(), self.converted(), {"folder": "Didier"}, servers=("sharepoint",))
        self.assertEqual(r["route"], "error")
        self.assertIn("outlook", out["reason"])

    def test_meta(self):
        h.check_code(MOVE)
        self.assertEqual(MOVE_META["exits"], ["moved", "error"])


class Chain(unittest.TestCase):
    def test_drop_to_sharepoint_end_to_end_through_json_text(self):
        f = Fake()
        r, pkg = start(f)
        r, converted = run(CONVERT, CONVERT_META, f, json.dumps(pkg))
        r, done = run(MOVE, MOVE_META, f, json.dumps(converted), {"folder": "Didier"})
        self.assertEqual((r["route"], done["files"], done["released"]), ("moved", ["Email.pdf", "inv.pdf"], True))
        self.assertEqual(f.names()[0], "outlook.poll_new_mail")
        self.assertEqual(f.names()[-1], "outlook.move_mail")


if __name__ == "__main__":
    unittest.main()
