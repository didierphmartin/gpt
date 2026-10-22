# Email -> PDF. Input: an email from "Mail dropped in a folder". Output: the files to store, as references the
# storing node fetches when it uploads them (no bytes in the run record): Email.pdf rendered by Outlook, and the
# attachments in their original format. Inline images stay inside Email.pdf; cloud links are skipped and listed.
import json


def _subfolder_name(mail):
    when = (mail.get("received_at") or "")[:16].replace("T", " ").replace(":", "")
    subject = (mail.get("subject") or "").strip()[:60] or "(no subject)"
    return f"{when} - {mail.get('from') or 'unknown sender'} - {subject}"


def run(input, call_tool):
    mail = input
    if isinstance(mail, str):
        try:
            mail = json.loads(mail)
        except ValueError:
            mail = None
    if not isinstance(mail, dict) or not mail.get("id"):
        return {"route": "error", "output": {
            "reason": "no email in the input: link this node to the mail exit of \"Mail dropped in a folder\"",
            "source": None}}
    mail_id = mail["id"]
    files = [{"name": "Email.pdf", "from": {"server": "outlook", "tool": "mail_to_pdf", "args": {"mail_id": mail_id}}}]
    skipped = []
    for att in mail.get("attachments") or []:
        if att.get("kind") == "reference":                 # a cloud link: nothing to download, listed in Email.pdf
            skipped.append(att.get("name") or "")
            continue
        if att.get("is_inline") and (att.get("content_type") or "").lower().startswith("image/"):
            continue                                       # a picture in the body: Email.pdf has it
        files.append({"name": att.get("name") or "attachment", "from": {
            "server": "outlook", "tool": "get_attachment",
            "args": {"mail_id": mail_id, "attachment_id": att["id"], "raw": True}}})
    return {"route": "done", "output": {"folder_name": _subfolder_name(mail), "files": files, "skipped": skipped,
                                        "source": {"mail_id": mail_id, "folder": mail.get("folder") or ""}}}
