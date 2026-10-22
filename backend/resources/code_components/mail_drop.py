# Mail dropped in a folder (a Start option). Start arg: folder (the drop folder).
# Takes the next email dragged into the folder and hands it on: its id, sender, subject, received time and
# attachment list, plus the drop folder's name. What happens to it is the next node's business. An email the
# next node does not move out is re-delivered once its lease runs out (up to 3 attempts).

def run(input, call_tool):
    folder = str(ARGS.get("folder") or "").strip() or "Drop"
    try:
        mail = call_tool("outlook", "poll_new_mail", {"folder": folder, "mode": "drop"}).get("mail")
    except Exception as e:  # ToolError from call_tool (the harness class is not importable here)
        return {"route": "error", "output": {"reason": str(e), "mail_id": None}}
    if not mail:
        return {"route": "idle", "output": None}
    return {"route": "mail", "output": {**mail, "folder": folder}}
