"""Probe: every event the compiled runtime emits validates against the contract.

argv[1] = compiled package root, argv[2] = run-protocol-v1.json
"""
import json, sys, importlib, threading

sys.path.insert(0, sys.argv[1])
contract = json.load(open(sys.argv[2]))
common = importlib.import_module("common")

seen = []
common.set_event_sink(seen.append)

run = common._PlaybookRun(False, {})
run.emit(type="message", text="hi", sensitive=False)
run.emit(type="tool_call", name="get_pto_balance", args={"email": "a@b"})
run.emit(type="tool_result", name="get_pto_balance", result={"ok": True})
run.emit(type="note", text="noted")
common.emit_event(type="round", round=1)
common.emit_event(type="final", status="resolved", leg=1)

import os
os.environ["PLAYBOOK_GATE_TIMEOUT_S"] = "1"
common._playbook_gate(run, "approval", "request_approval", {"question": "q"})

problems = []
for ev in seen:
    spec = contract["events"].get(ev.get("type"))
    if spec is None:
        problems.append(f"undescribed event type: {ev.get('type')} ({ev})")
        continue
    for key in spec["required"]:
        if key not in ev:
            problems.append(f"{ev['type']} is missing required field {key}: {ev}")
    extra = set(ev) - set(spec["required"]) - set(spec["optional"])
    if extra:
        problems.append(f"{ev['type']} has undescribed fields {sorted(extra)}: {ev}")

if problems:
    print("\n".join(problems))
    sys.exit(1)
print("OK")
