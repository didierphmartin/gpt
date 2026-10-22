# Mail drop -> SharePoint. Start args: folder (drop folder), sharepoint_folder (required), filed_folder.
# Files one dropped email into SharePoint (Email.pdf + original attachments in a per-email subfolder), then
# moves it to the filed folder. Any failure leaves the email in the drop folder, where the lease re-delivers it.

def _fail(reason, mail_id=None):
    return {"route": "error", "output": {"reason": str(reason), "mail_id": mail_id}}


def _subfolder_name(mail):
    when = (mail.get("received_at") or "")[:16].replace("T", " ").replace(":", "")
    subject = (mail.get("subject") or "").strip()[:60] or "(no subject)"
    return f"{when} - {mail.get('from') or 'unknown sender'} - {subject}"


def run(input, call_tool):
    folder = ARGS.get("folder", "To SharePoint")
    target = ARGS.get("sharepoint_folder", "")
    filed = ARGS.get("filed_folder", "Filed")
    if not target:
        return _fail("set sharepoint_folder in the Start arguments")
    mail_id = None
    try:
        call_tool("sharepoint", "whoami", {})
        mail = call_tool("outlook", "poll_new_mail", {"folder": folder, "mode": "drop"}).get("mail")
        if not mail:
            return {"route": "idle", "output": None}
        mail_id = mail["id"]
        call_tool("sharepoint", "ensure_folder", {"path": target})
        sub = call_tool("sharepoint", "create_subfolder", {"parent": target, "name": _subfolder_name(mail)})["path"]
        files = []
        pdf = call_tool("outlook", "mail_to_pdf", {"mail_id": mail_id})
        call_tool("sharepoint", "upload_file", {"folder": sub, "name": "Email.pdf", "base64": pdf["base64"]})
        files.append("Email.pdf")
        for att in mail.get("attachments") or []:
            if att.get("is_inline"):
                continue
            raw = call_tool("outlook", "get_attachment", {"mail_id": mail_id, "attachment_id": att["id"], "raw": True})
            call_tool("sharepoint", "upload_file", {"folder": sub, "name": raw["name"], "base64": raw["base64"]})
            files.append(raw["name"])
        call_tool("outlook", "move_mail", {"mail_id": mail_id, "folder": filed})
        return {"route": "filed", "output": {"folder": sub, "files": files}}
    except Exception as e:  # ToolError from call_tool (the harness class is not importable here)
        return _fail(e, mail_id)
