# Save files to SharePoint. Input: {folder_name?, files, source?, skipped?} from a converter node. Each file is
# {"name", "base64"} or {"name", "from": {"server", "tool", "args"}} -- a tool call whose result carries the
# content as base64, made just before the upload. Arg: sharepoint_folder (required). Uploads into
# sharepoint_folder/folder_name (a new subfolder; " (2)" on a clash), or into sharepoint_folder itself.
# source and skipped pass through untouched for the next node.
import json


def _fail(reason, source=None):
    return {"route": "error", "output": {"reason": str(reason), "source": source}}


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
    data = input
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    if not isinstance(data, dict) or not isinstance(data.get("files"), list) or not data["files"]:
        return _fail("no files in the input: link this node after a converter that outputs {files: [...]}")
    source = data.get("source")
    target = str(ARGS.get("sharepoint_folder") or "").strip()
    if not target:
        return _fail("set sharepoint_folder in this node's arguments", source)
    try:
        folder = call_tool("sharepoint", "ensure_folder", {"path": target})["path"]
        name = str(data.get("folder_name") or "").strip()
        if name:
            folder = call_tool("sharepoint", "create_subfolder", {"parent": folder, "name": name})["path"]
        stored, urls = [], []
        for f in data["files"]:
            up = call_tool("sharepoint", "upload_file",
                           {"folder": folder, "name": f.get("name") or "file", "base64": _content(call_tool, f)})
            stored.append(up["path"].rsplit("/", 1)[-1])   # the stored name: SharePoint renames on a clash
            urls.append(up.get("web_url") or "")
    except Exception as e:  # ToolError from call_tool (the harness class is not importable here), or a bad file
        return _fail(e, source)
    return {"route": "stored", "output": {"status": "stored", "folder": folder, "files": stored, "web_urls": urls,
                                          "skipped": data.get("skipped") or [], "source": source}}
