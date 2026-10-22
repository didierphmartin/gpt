# Move email. Input: any node output carrying source: {mail_id, folder} (e.g. "Save files to SharePoint").
# Arg: folder (default Filed; must differ from the drop folder, or the email would be handed on again).
# Moves the email, then passes the input on with moved_to added.
import json


def run(input, call_tool):
    data = input
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    source = data.get("source") if isinstance(data, dict) else None
    if not isinstance(source, dict) or not source.get("mail_id"):
        return {"route": "error", "output": {"reason": "no source.mail_id in the input: nothing to move"}}
    target = str(ARGS.get("folder") or "").strip() or "Filed"
    drop = str(source.get("folder") or "")
    if drop and target.strip(" /").lower() == drop.strip(" /").lower():
        return {"route": "error", "output": {
            "reason": f"folder must not be the drop folder ({drop}): the email would never leave it", "source": source}}
    try:
        call_tool("outlook", "move_mail", {"mail_id": source["mail_id"], "folder": target})
    except Exception as e:  # ToolError from call_tool (the harness class is not importable here)
        return {"route": "error", "output": {"reason": str(e), "source": source}}
    return {"route": "moved", "output": {**data, "moved_to": target}}
