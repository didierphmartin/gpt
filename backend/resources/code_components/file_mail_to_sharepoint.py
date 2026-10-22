# File email to SharePoint. Input: an email from "Mail dropped in a folder". Args: sharepoint_folder (required),
# filed_folder. Files the email into SharePoint (Email.pdf + original attachments in a per-email subfolder), then
# moves it to the filed folder. Any failure leaves the email where it is, so the drop folder hands it on again.
import json


def _fail(reason, mail_id=None):
    return {"route": "error", "output": {"reason": str(reason), "mail_id": mail_id}}


def _arg(key, default=""):
    # Args may be absent, empty, or an integer (the dialog stores digits-only values as numbers).
    return str(ARGS.get(key) or "").strip() or default


def _same_folder(a, b):
    return a.strip(" /").lower() == b.strip(" /").lower()


def _subfolder_name(mail):
    when = (mail.get("received_at") or "")[:16].replace("T", " ").replace(":", "")
    subject = (mail.get("subject") or "").strip()[:60] or "(no subject)"
    return f"{when} - {mail.get('from') or 'unknown sender'} - {subject}"


def _upload(call_tool, folder, name, data):
    stored = call_tool("sharepoint", "upload_file", {"folder": folder, "name": name, "base64": data})
    return stored["path"].rsplit("/", 1)[-1]           # the stored name: SharePoint renames on a clash


def run(input, call_tool):
    mail = input
    if isinstance(mail, str):
        try:
            mail = json.loads(mail)
        except ValueError:
            mail = None
    if not isinstance(mail, dict) or not mail.get("id"):
        return _fail("no email in the input: link this node to the mail exit of \"Mail dropped in a folder\"")
    mail_id = mail["id"]
    target = _arg("sharepoint_folder")
    filed = _arg("filed_folder", "Filed")
    if not target:
        return _fail("set sharepoint_folder in this node's arguments", mail_id)
    if mail.get("folder") and _same_folder(filed, mail["folder"]):
        return _fail(f"filed_folder must not be the drop folder ({mail['folder']}): the email would never leave it",
                     mail_id)
    try:
        target = call_tool("sharepoint", "ensure_folder", {"path": target})["path"]
        sub = call_tool("sharepoint", "create_subfolder", {"parent": target, "name": _subfolder_name(mail)})["path"]
        pdf = call_tool("outlook", "mail_to_pdf", {"mail_id": mail_id})
        files, skipped = [_upload(call_tool, sub, "Email.pdf", pdf["base64"])], []
        for att in mail.get("attachments") or []:
            if att.get("kind") == "reference":             # a cloud link: nothing to download, listed in Email.pdf
                skipped.append(att.get("name") or "")
                continue
            if att.get("is_inline") and (att.get("content_type") or "").lower().startswith("image/"):
                continue                                   # a picture in the body: Email.pdf has it
            raw = call_tool("outlook", "get_attachment", {"mail_id": mail_id, "attachment_id": att["id"], "raw": True})
            files.append(_upload(call_tool, sub, raw["name"], raw["base64"]))
        call_tool("outlook", "move_mail", {"mail_id": mail_id, "folder": filed})
        return {"route": "filed", "output": {"folder": sub, "files": files, "skipped": skipped}}
    except Exception as e:  # ToolError from call_tool (the harness class is not importable here)
        return _fail(e, mail_id)
