# Mail drop -> SharePoint. Start args: folder (drop folder), sharepoint_folder (required), filed_folder.
# Files one dropped email into SharePoint (Email.pdf + original attachments in a per-email subfolder), then
# moves it to the filed folder. Any failure leaves the email in the drop folder, where the lease re-delivers it.

def _fail(reason, mail_id=None):
    return {"route": "error", "output": {"reason": str(reason), "mail_id": mail_id}}


def _arg(key, default=""):
    # Start args may be absent, empty, or an integer (the dialog stores digits-only values as numbers).
    return str(ARGS.get(key) or default).strip()


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
    folder = _arg("folder", "To SharePoint")
    target = _arg("sharepoint_folder")
    filed = _arg("filed_folder", "Filed")
    if not target:
        return _fail("set sharepoint_folder in the Start arguments")
    if _same_folder(filed, folder):
        return _fail(f"filed_folder must not be the drop folder ({folder}): the email would never leave it")
    mail_id = None
    try:
        # Preflight before any email is claimed: a wrong site/library, a missing permission or an unwritable
        # folder fails here, so no attempt is spent.
        target = call_tool("sharepoint", "ensure_folder", {"path": target})["path"]
        mail = call_tool("outlook", "poll_new_mail", {"folder": folder, "mode": "drop"}).get("mail")
        if not mail:
            return {"route": "idle", "output": None}
        mail_id = mail["id"]
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
