from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


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


def _move(folder, meta=None, calls=None):
    calls = calls if calls is not None else []

    def call_tool(server, tool, args):
        calls.append((server, tool, args))
        if tool == "ensure_folder":
            return {"path": args["path"]}
        if tool == "create_subfolder":
            return {"path": args["parent"] + "/" + args["name"]}
        if tool == "upload_file":
            return {"path": args["folder"] + "/" + args["name"], "web_url": "u"}
        return {}
    pkg = {"files": [{"name": "a.pdf", "base64": "QQ=="}]}
    if meta is not None:
        pkg["document"] = {"meta": meta}
    return _load("sharepoint_move", {"folder": folder})(pkg, call_tool), calls


def test_folder_placeholder_filled():
    res, calls = _move("VIP/{mailbox_name}", {"mailbox_name": "Alice Martin", "mailbox": "alice@vip.com"})
    assert calls[0] == ("sharepoint", "ensure_folder", {"path": "VIP/Alice Martin"})
    assert res["route"] == "moved"
    res, calls = _move("{mailbox}/in", {"mailbox_name": "Alice Martin", "mailbox": "alice@vip.com"})
    assert calls[0][2] == {"path": "alice@vip.com/in"}


def test_missing_placeholder_value_is_error_and_uploads_nothing():
    for meta in (None, {}, {"mailbox_name": ""}, {"mailbox_name": "  "}):
        res, calls = _move("VIP/{mailbox_name}", meta)
        assert res["route"] == "error"
        assert res["output"]["reason"] == "the email names no mailbox (folder uses {mailbox_name})"
        assert calls == []


def test_folder_without_placeholder_unchanged():
    res, calls = _move("VIP/Fixed", {"mailbox_name": "Alice Martin"})
    assert calls[0] == ("sharepoint", "ensure_folder", {"path": "VIP/Fixed"})
    assert res["route"] == "moved"
