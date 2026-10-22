"""The mail pipeline components -- "Email -> PDF", "Save files to SharePoint", "Move email" -- each run through the
code node harness with a fake transport, and chained as the workflow chains them."""
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


CONVERT, CONVERT_META = load("email_to_pdf")
STORE, STORE_META = load("save_files_to_sharepoint")
MOVE, MOVE_META = load("move_email")

MAIL = {"id": "m1", "from": "ann@x.com", "subject": "Invoice 42", "received_at": "2026-10-09T08:15:00Z",
        "attempt": 1, "folder": "To SharePoint",
        "attachments": [{"id": "a1", "name": "inv.pdf", "content_type": "application/pdf", "is_inline": False},
                        {"id": "a2", "name": "logo.png", "content_type": "image/png", "is_inline": True}]}


def ok_result(data):
    return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}


class Fake:
    """Outlook + SharePoint. `fail` names one tool that answers an error; upload_file stores under the requested
    name unless `renamed` maps it."""

    def __init__(self, fail=None, renamed=None):
        self.fail, self.renamed, self.calls = fail, renamed or {}, []

    def __call__(self, server, tool, args):
        self.calls.append((f"{server}.{tool}", args))
        if f"{server}.{tool}" == self.fail:
            return {"isError": True, "content": [{"type": "text", "text": "boom"}]}
        match f"{server}.{tool}":
            case "sharepoint.upload_file":
                stored = self.renamed.get(args["name"], args["name"])
                return ok_result({"path": f"{args['folder']}/{stored}", "id": "3", "web_url": f"u/{stored}", "size": 3})
            case "outlook.get_attachment":
                return ok_result({"name": "x", "content_type": "", "size": 3, "base64": "QVRU"})
        return ok_result({
            "sharepoint.ensure_folder": {"path": "Didier", "id": "1", "created": []},
            "sharepoint.create_subfolder": {"path": f"Didier/{args.get('name')}", "id": "2"},
            "outlook.mail_to_pdf": {"name": "Email.pdf", "size": 3, "base64": "UERG"},
            "outlook.move_mail": {"id": "m1", "folder": args.get("folder"), "created": []},
        }[f"{server}.{tool}"])

    def names(self):
        return [c[0] for c in self.calls]


def run(source, meta, fake, input, args=None, servers=("outlook", "sharepoint")):
    r = h.execute(source, input, meta["exits"], list(servers), fake, 30, args=args or {})
    return r, (json.loads(r["output_text"]) if r.get("ok") and r.get("output_text") else None)


class EmailToPdf(unittest.TestCase):
    def test_lists_email_pdf_and_attachments_as_references_without_calling_anything(self):
        f = Fake()
        r, out = run(CONVERT, CONVERT_META, f, MAIL)
        self.assertEqual(r["route"], "done")
        self.assertEqual(f.calls, [])                     # references only: nothing is fetched here
        self.assertEqual(out["folder_name"], "2026-10-09 0815 - ann@x.com - Invoice 42")
        self.assertEqual(out["files"], [
            {"name": "Email.pdf", "from": {"server": "outlook", "tool": "mail_to_pdf", "args": {"mail_id": "m1"}}},
            {"name": "inv.pdf", "from": {"server": "outlook", "tool": "get_attachment",
                                         "args": {"mail_id": "m1", "attachment_id": "a1", "raw": True}}}])
        self.assertEqual(out["source"], {"mail_id": "m1", "folder": "To SharePoint"})
        self.assertNotIn("base64", json.dumps(out))

    def test_inline_pdf_kept_inline_images_dropped_cloud_links_listed(self):
        atts = [{"id": "a1", "name": "Photo.JPG", "content_type": "IMAGE/JPEG", "is_inline": True},
                {"id": "a2", "name": "scan.pdf", "content_type": "application/pdf", "is_inline": True},
                {"id": "a3", "name": "Budget.xlsx", "content_type": "", "is_inline": False, "kind": "reference"}]
        _, out = run(CONVERT, CONVERT_META, Fake(), dict(MAIL, attachments=atts))
        self.assertEqual([x["name"] for x in out["files"]], ["Email.pdf", "scan.pdf"])
        self.assertEqual(out["skipped"], ["Budget.xlsx"])

    def test_empty_and_long_subject(self):
        _, out = run(CONVERT, CONVERT_META, Fake(), dict(MAIL, subject=""))
        self.assertTrue(out["folder_name"].endswith("(no subject)"))
        _, out = run(CONVERT, CONVERT_META, Fake(), dict(MAIL, subject="x" * 100))
        self.assertTrue(out["folder_name"].endswith(" - " + "x" * 60))

    def test_json_text_input_and_bad_input(self):
        r, _ = run(CONVERT, CONVERT_META, Fake(), json.dumps(MAIL))
        self.assertEqual(r["route"], "done")
        for bad in ("", "hello", {}, {"subject": "x"}, [1]):
            r, out = run(CONVERT, CONVERT_META, Fake(), bad)
            self.assertEqual(r["route"], "error", bad)
            self.assertIn("no email in the input", out["reason"])

    def test_meta(self):
        h.check_code(CONVERT)
        self.assertEqual(CONVERT_META["exits"], ["done", "error"])


class SaveFilesToSharePoint(unittest.TestCase):
    def converted(self):
        return run(CONVERT, CONVERT_META, Fake(), MAIL)[1]

    def test_fetches_each_file_just_before_its_upload(self):
        f = Fake()
        r, out = run(STORE, STORE_META, f, self.converted(), {"sharepoint_folder": "Didier"})
        self.assertEqual(r["route"], "stored")
        self.assertEqual(f.names(), ["sharepoint.ensure_folder", "sharepoint.create_subfolder", "outlook.mail_to_pdf",
                                     "sharepoint.upload_file", "outlook.get_attachment", "sharepoint.upload_file"])
        ups = [a for n, a in f.calls if n == "sharepoint.upload_file"]
        self.assertEqual([(u["name"], u["base64"]) for u in ups], [("Email.pdf", "UERG"), ("inv.pdf", "QVRU")])
        sub = "Didier/2026-10-09 0815 - ann@x.com - Invoice 42"
        self.assertEqual(ups[0]["folder"], sub)
        self.assertEqual(out, {"status": "stored", "folder": sub, "files": ["Email.pdf", "inv.pdf"],
                               "web_urls": ["u/Email.pdf", "u/inv.pdf"], "skipped": [],
                               "source": {"mail_id": "m1", "folder": "To SharePoint"}})
        self.assertNotIn("UERG", json.dumps(out))         # no content in the output either

    def test_inline_base64_and_no_subfolder(self):
        f = Fake()
        r, out = run(STORE, STORE_META, f, {"files": [{"name": "a.txt", "base64": "QQ=="}]}, {"sharepoint_folder": "D"})
        self.assertEqual(r["route"], "stored")
        self.assertEqual(f.names(), ["sharepoint.ensure_folder", "sharepoint.upload_file"])
        self.assertEqual(out["folder"], "Didier")
        self.assertIsNone(out["source"])

    def test_stored_names_follow_sharepoint_renames(self):
        data = {"files": [{"name": "inv.pdf", "base64": "QQ=="}, {"name": "inv.pdf", "base64": "QQ=="}]}
        _, out = run(STORE, STORE_META, Fake(renamed={"inv.pdf": "inv 1.pdf"}), data, {"sharepoint_folder": "D"})
        self.assertEqual(out["files"], ["inv 1.pdf", "inv 1.pdf"])

    def test_failures_are_error_with_reason_and_source(self):
        for tool in ("sharepoint.ensure_folder", "sharepoint.create_subfolder", "outlook.mail_to_pdf",
                     "outlook.get_attachment", "sharepoint.upload_file"):
            r, out = run(STORE, STORE_META, Fake(fail=tool), self.converted(), {"sharepoint_folder": "Didier"})
            self.assertEqual(r["route"], "error", tool)
            self.assertIn("boom", out["reason"])
            self.assertEqual(out["source"]["mail_id"], "m1")

    def test_bad_file_entries_are_error(self):
        for files in ([{"name": "a"}], [{"name": "a", "from": {"server": "outlook"}}]):
            r, out = run(STORE, STORE_META, Fake(), {"files": files}, {"sharepoint_folder": "D"})
            self.assertEqual(r["route"], "error")
            self.assertIn("'a'", out["reason"])
        f = Fake()
        f_input = {"files": [{"name": "a", "from": {"server": "outlook", "tool": "move_mail", "args": {}}}]}
        r, out = run(STORE, STORE_META, f, f_input, {"sharepoint_folder": "D"})
        self.assertEqual(r["route"], "error")
        self.assertIn("returned no base64", out["reason"])

    def test_missing_args_and_input(self):
        r, out = run(STORE, STORE_META, Fake(), self.converted(), {"sharepoint_folder": "  "})
        self.assertEqual(r["route"], "error")
        self.assertIn("sharepoint_folder", out["reason"])
        for bad in ("", {}, {"files": []}, {"files": "x"}):
            f = Fake()
            r, out = run(STORE, STORE_META, f, bad, {"sharepoint_folder": "D"})
            self.assertEqual((r["route"], f.calls), ("error", []), bad)
            self.assertIn("no files in the input", out["reason"])

    def test_server_not_ticked_is_error(self):
        r, out = run(STORE, STORE_META, Fake(), self.converted(), {"sharepoint_folder": "Didier"},
                     servers=("sharepoint",))
        self.assertEqual(r["route"], "error")
        self.assertIn("outlook", out["reason"])

    def test_meta(self):
        h.check_code(STORE)
        self.assertEqual(STORE_META["exits"], ["stored", "error"])


class MoveEmail(unittest.TestCase):
    STORED = {"status": "stored", "folder": "Didier/s", "files": ["Email.pdf"], "web_urls": ["u"], "skipped": [],
              "source": {"mail_id": "m1", "folder": "To SharePoint"}}

    def test_moves_and_passes_the_summary_on(self):
        f = Fake()
        r, out = run(MOVE, MOVE_META, f, self.STORED)
        self.assertEqual(r["route"], "moved")
        self.assertEqual(f.calls, [("outlook.move_mail", {"mail_id": "m1", "folder": "Filed"})])
        self.assertEqual(out, {**self.STORED, "moved_to": "Filed"})

    def test_folder_arg_blank_and_drop_folder(self):
        f = Fake()
        run(MOVE, MOVE_META, f, self.STORED, {"folder": "  "})
        self.assertEqual(f.calls[0][1]["folder"], "Filed")
        for same in ("to sharepoint", " /To SharePoint/ "):
            f = Fake()
            r, out = run(MOVE, MOVE_META, f, self.STORED, {"folder": same})
            self.assertEqual((r["route"], f.calls), ("error", []), same)
            self.assertIn("drop folder", out["reason"])

    def test_move_failure_and_missing_source(self):
        r, out = run(MOVE, MOVE_META, Fake(fail="outlook.move_mail"), self.STORED)
        self.assertEqual(r["route"], "error")
        self.assertIn("boom", out["reason"])
        for bad in ("", {}, {"source": None}, {"source": {"folder": "x"}}):
            f = Fake()
            r, out = run(MOVE, MOVE_META, f, bad)
            self.assertEqual((r["route"], f.calls), ("error", []), bad)

    def test_meta(self):
        h.check_code(MOVE)
        self.assertEqual(MOVE_META["exits"], ["moved", "error"])


class Chain(unittest.TestCase):
    def test_mail_to_filed_end_to_end(self):
        f = Fake()
        _, converted = run(CONVERT, CONVERT_META, f, MAIL)
        r, stored = run(STORE, STORE_META, f, json.dumps(converted), {"sharepoint_folder": "Didier"})
        self.assertEqual(r["route"], "stored")
        r, moved = run(MOVE, MOVE_META, f, json.dumps(stored), {"folder": "Filed"})
        self.assertEqual(r["route"], "moved")
        self.assertEqual(moved["files"], ["Email.pdf", "inv.pdf"])
        self.assertEqual(f.names()[-1], "outlook.move_mail")

    def test_store_failure_never_reaches_move(self):
        f = Fake(fail="sharepoint.upload_file")
        _, converted = run(CONVERT, CONVERT_META, f, MAIL)
        r, _ = run(STORE, STORE_META, f, converted, {"sharepoint_folder": "Didier"})
        self.assertEqual(r["route"], "error")
        self.assertNotIn("outlook.move_mail", f.names())


if __name__ == "__main__":
    unittest.main()
