# Mail dropped in a folder (a Start option). Start args: folder (the drop folder), done_folder (where the email
# goes once a later node has finished with it). Takes the next email dragged into the folder and packages it as
# a document with its attachments:
#   document     the email: its metadata, body text, and how to render it as a PDF (a tool call)
#   attachments  the files attached to it, each with how to fetch it in its original format (a tool call);
#                pictures inside the body are not attachments here (the rendered email has them)
#   source       where it came from, and `release`: the tool call that takes it out of the drop folder, made by
#                the node that finishes the job. Until then the email stays and is handed on again after its
#                10-minute lease (up to 3 attempts).
# File content is never in the package: each part says how to fetch it, so run records stay small.

def _attachment(mail_id, att):
    return {"name": att.get("name") or "attachment", "content_type": att.get("content_type") or "",
            "size": att.get("size"), "from": {"server": "outlook", "tool": "get_attachment",
                                              "args": {"mail_id": mail_id, "attachment_id": att["id"], "raw": True}}}


def run(input, call_tool):
    folder = str(ARGS.get("folder") or "").strip() or "Drop"
    done = str(ARGS.get("done_folder") or "").strip() or "Filed"
    if done.strip(" /").lower() == folder.strip(" /").lower():
        return {"route": "error", "output": {
            "reason": f"done_folder must not be the drop folder ({folder}): the email would never leave it"}}
    try:
        mail = call_tool("outlook", "poll_new_mail", {"folder": folder, "mode": "drop"}).get("mail")
    except Exception as e:  # ToolError from call_tool (the harness class is not importable here)
        return {"route": "error", "output": {"reason": str(e)}}
    if not mail:
        return {"route": "no_mail", "output": None}
    mail_id, attachments, cloud = mail["id"], [], []
    for att in mail.get("attachments") or []:
        if att.get("kind") == "reference":                 # a cloud link: no content to fetch (the email lists it)
            cloud.append(att.get("name") or "")
        elif not (att.get("is_inline") and (att.get("content_type") or "").lower().startswith("image/")):
            attachments.append(_attachment(mail_id, att))
    document = {
        "kind": "email", "name": "Email",
        "meta": {k: mail.get(k) for k in ("from", "to", "cc", "subject", "received_at", "web_link")},
        "text": mail.get("body_text") or "",
        "renditions": {"pdf": {"server": "outlook", "tool": "mail_to_pdf", "args": {"mail_id": mail_id}}},
    }
    source = {"server": "outlook", "id": mail_id, "folder": folder, "attempt": mail.get("attempt"),
              "release": {"server": "outlook", "tool": "move_mail", "args": {"mail_id": mail_id, "folder": done}}}
    return {"route": "dropped_mail", "output": {"document": document, "attachments": attachments,
                                       "not_fetched": cloud, "source": source}}
