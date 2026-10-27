# SharePoint -- move. Moves what it receives into a SharePoint folder: the input is the function's source, the
# node's folder argument its destination.
# Input: {files, source?, document?, ...}. Each file is {"name", "base64"} or {"name", "from": {"server", "tool",
# "args"}} -- a tool call whose result has base64, made just before the upload (tick that server on the node).
# The folder argument may hold {mailbox} / {mailbox_name}, filled from document.meta (the VIP's address / safe
# folder name); if the email names no mailbox the node exits error and touches nothing in SharePoint.
# 1. stores the files in folder/<subfolder>, the subfolder named from document.meta when there is one
#    ("YYYY-MM-DD HHMM - sender - subject"), else straight in folder;
# 2. then runs source.release when there is one (e.g. the email leaves the Outlook drop folder) -- only after
#    every file is stored, so a failure leaves the source where it was, to be handed on again.
# Exits: ok {status, folder, files, web_urls, released}; no {status, reason}.
import json


def _error(reason, released=False):
    return {"route": "error", "output": {"status": "error", "reason": str(reason), "released": released}}


def _subfolder(document):
    meta = (document or {}).get("meta") if isinstance(document, dict) else None
    if not isinstance(meta, dict):
        return ""
    when = (meta.get("received_at") or "")[:16].replace("T", " ").replace(":", "")
    subject = (meta.get("subject") or "").strip()[:60] or "(no subject)"
    return f"{when} - {meta.get('from') or 'unknown sender'} - {subject}"


def _content(call_tool, f):
    if f.get("base64") is not None:
        return f["base64"]
    ref = f.get("from")
    if not isinstance(ref, dict) or not ref.get("server") or not ref.get("tool"):
        raise ValueError(f"file {f.get('name')!r} has neither base64 nor a from tool call")
    got = call_tool(ref["server"], ref["tool"], ref.get("args") or {})
    if not isinstance(got, dict) or got.get("base64") is None:
        raise ValueError(f"{ref['server']}.{ref['tool']} returned no base64 for {f.get('name')!r}")
    return got["base64"]


def run(input, call_tool):
    pkg = input
    if isinstance(pkg, str):
        try:
            pkg = json.loads(pkg)
        except ValueError:
            pkg = None
    if not isinstance(pkg, dict) or not isinstance(pkg.get("files"), list) or not pkg["files"]:
        return _error("no files in the input: expected {files: [...]}")
    destination = str(ARGS.get("folder") or "").strip()
    if not destination:
        return _error("set folder in this node's arguments (the SharePoint destination)")
    meta = (pkg.get("document") or {}).get("meta") if isinstance(pkg.get("document"), dict) else None
    for key in ("mailbox", "mailbox_name"):
        if "{" + key + "}" in destination:
            value = str((meta or {}).get(key) or "").strip() if isinstance(meta, dict) else ""
            if not value:
                return _error(f"the email names no mailbox (folder uses {{{key}}})")
            destination = destination.replace("{" + key + "}", value)
    try:
        folder = call_tool("sharepoint", "ensure_folder", {"path": destination})["path"]
        name = _subfolder(pkg.get("document"))
        if name:
            folder = call_tool("sharepoint", "create_subfolder", {"parent": folder, "name": name})["path"]
        stored, urls = [], []
        for f in pkg["files"]:
            up = call_tool("sharepoint", "upload_file",
                           {"folder": folder, "name": f.get("name") or "file", "base64": _content(call_tool, f)})
            stored.append(up["path"].rsplit("/", 1)[-1])   # the stored name: SharePoint renames on a clash
            urls.append(up.get("web_url") or "")
    except Exception as e:  # ToolError from call_tool (the harness class is not importable here), or a bad file
        return _error(e)
    release = (pkg.get("source") or {}).get("release") if isinstance(pkg.get("source"), dict) else None
    if isinstance(release, dict) and release.get("server") and release.get("tool"):
        try:
            call_tool(release["server"], release["tool"], release.get("args") or {})
        except Exception as e:
            # Stored but not released: the source is handed on again and stored a second time.
            return _error(f"files stored in {folder}, but the source was not released: {e}")
    return {"route": "moved", "output": {"status": "moved", "folder": folder, "files": stored, "web_urls": urls,
                                      "released": bool(release)}}
