import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE.parents[2] / "frontend" / "assets" / "py"))
import code_node_harness as h  # noqa: E402


def _load(name, args):
    ns = {"ARGS": args}
    exec(compile((HERE / f"{name}.py").read_text(), name, "exec"), ns)
    return ns["run"]


def _mail(**extra):
    return {"id": "m1", "from": "a@x.com", "to": "b@x.com", "cc": "", "subject": "Hi",
            "received_at": "2026-10-26T09:30:00Z", "web_link": "http://w", "body_text": "t",
            "attachments": [], "attempt": 1, **extra}


def _drop(mail):
    def call_tool(server, tool, args):
        return {"mail": mail}
    return _load("mail_drop", {"folder": "Drop", "done_folder": "Filed"})({}, call_tool)


def test_mail_drop_passes_mailbox_through():
    out = _drop(_mail(mailbox="alice@vip.com", mailbox_name="Alice Martin"))["output"]
    for part in (out["document"]["meta"], out["source"]):
        assert part["mailbox"] == "alice@vip.com"
        assert part["mailbox_name"] == "Alice Martin"


def test_mail_drop_without_mailbox_unchanged():
    out = _drop(_mail())["output"]
    assert set(out["document"]["meta"]) == {"from", "to", "cc", "subject", "received_at", "web_link"}
    assert set(out["source"]) == {"server", "id", "folder", "attempt", "release"}


def test_mail_drop_provides_meta():
    out = _drop(_mail(mailbox="alice@vip.com", mailbox_name="Alice Martin"))["output"]
    assert out["meta"] == {"mailbox": "alice@vip.com", "mailbox_name": "Alice Martin", "from": "a@x.com",
                           "subject": "Hi", "received_at": "2026-10-26T09:30:00Z", "received": "2026-10-26 0930"}


def test_mail_drop_meta_fallbacks():
    meta = _drop(_mail(**{"from": "", "subject": "  "}))["output"]["meta"]
    assert meta["from"] == "unknown sender"
    assert meta["subject"] == "(no subject)"
    assert "mailbox" not in meta and "mailbox_name" not in meta


MOVE_DECLS = json.loads((HERE / "sharepoint_move.json").read_text())["args"]
FULL_META = {"mailbox": "alice@vip.com", "mailbox_name": "Alice Martin", "from": "a@x.com", "subject": "Hi",
             "received_at": "2026-10-26T09:30:00Z", "received": "2026-10-26 0930"}


def _move(args, meta):
    def transport(server, tool, a):
        data = {}
        if tool == "ensure_folder":
            data = {"path": a["path"]}
        elif tool == "create_subfolder":
            data = {"path": a["parent"] + "/" + a["name"]}
        elif tool == "upload_file":
            data = {"path": a["folder"] + "/" + a["name"], "web_url": "u"}
        return {"content": [{"type": "text", "text": json.dumps(data)}], "structuredContent": data}
    pkg = {"files": [{"name": "a.pdf", "base64": "QQ=="}]}
    r = h.execute((HERE / "sharepoint_move.py").read_text(), pkg, ["moved", "error"], ["sharepoint", "outlook"],
                  transport, 10, args=args, arg_decls=MOVE_DECLS, meta=meta)
    return r, [(c["tool"], c["args"]) for c in r["tool_calls"]]


def test_move_files_under_filled_folder_and_default_subfolder():
    r, calls = _move({"folder": "VIP/{mailbox_name}"}, FULL_META)
    assert r["route"] == "moved"
    assert calls[0] == ("ensure_folder", {"path": "VIP/Alice Martin"})
    assert calls[1] == ("create_subfolder", {"parent": "VIP/Alice Martin", "name": "2026-10-26 0930 - a@x.com - Hi"})


def test_move_missing_mailbox_touches_nothing():
    meta = {k: v for k, v in FULL_META.items() if k != "mailbox_name"}
    r, calls = _move({"folder": "VIP/{mailbox_name}"}, meta)
    assert r["route"] == "error"
    assert calls == []
    assert "placeholder {mailbox_name} has no value" in r["output_text"]


def test_move_custom_subfolder():
    r, calls = _move({"folder": "F", "subfolder": "{from}"}, FULL_META)
    assert r["route"] == "moved"
    assert calls[1] == ("create_subfolder", {"parent": "F", "name": "a@x.com"})
