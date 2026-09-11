"""Probe: server gate mode emits gate_request, blocks, and resumes on an answer.

argv[1] is a compiled modular package root.
"""
import os, sys, threading, importlib

os.environ["PLAYBOOK_GATE_TIMEOUT_S"] = "5"
sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")

seen = []
common.set_event_sink(seen.append)
run = common._PlaybookRun(False, {})

# 1. A gate blocks until answered, and returns the human's decision.
result = {}


def ask():
    result["value"] = common._playbook_gate(
        run, "approval", "request_approval",
        {"approver": "manager", "question": "Approve the PTO?"})


t = threading.Thread(target=ask)
t.start()

gate = None
for _ in range(50):
    gate = next((e for e in seen if e.get("type") == "gate_request"), None)
    if gate:
        break
    threading.Event().wait(0.05)
assert gate, f"no gate_request emitted: {seen}"
assert gate["kind"] == "approval", gate
assert gate["payload"]["question"] == "Approve the PTO?", gate
assert gate["tool_call_id"], gate
assert t.is_alive(), "the gate must block until answered"

assert common.resolve_gate(gate["tool_call_id"], {"decision": "denied", "comment": "not now", "actor": "me@x"})
t.join(5)
assert not t.is_alive(), "the gate did not resume after resolve_gate"
assert result["value"]["ok"] is True, result
assert result["value"]["decision"]["decision"] == "denied", result
assert result["value"]["decision"]["comment"] == "not now", result

# 2. An unanswered gate times out to the policy answer (PLAYBOOK_GATE_TIMEOUT_S=5).
seen.clear()
timed = common._playbook_gate(run, "approval", "request_approval",
                              {"approver": "manager", "question": "Nobody home?"})
assert timed["ok"] is True, timed
assert timed["decision"]["actor"] == "policy", timed

# 3. PLAYBOOK_GATE_MODE still wins over the sink.
os.environ["PLAYBOOK_GATE_MODE"] = "deny"
denied = common._playbook_gate(run, "approval", "request_approval", {"question": "x"})
assert denied["decision"]["decision"] == "denied", denied
assert denied["decision"]["actor"] == "policy", denied
del os.environ["PLAYBOOK_GATE_MODE"]

print("OK")
