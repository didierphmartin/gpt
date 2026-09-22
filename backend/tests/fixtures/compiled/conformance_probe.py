"""Probe: every event the compiled runtime emits validates against the contract.

Drives the real production call sites wherever one exists -- build_playbook_tools()
+ StructuredTool.invoke(), the same pattern gate_probe.py uses -- rather than
re-typing the call-site literals (name=..., args=...) here: a hand-typed
`run.emit(type="tool_call", name="x", ...)` would stay green even if the real
wrap()/invoke() in LangGraphGenerator.php renamed or dropped a field, since it
duplicates the literal instead of exercising it.

tool_call/tool_result/message/note/gate_request are all produced this way,
through the native send_direct_message/leave_internal_note/request_approval
tools (no live MCP server needed -- those three are pure local closures in
build_playbook_tools()). round and final are the one exception: they are the
PHP interpreter's own vocabulary (see backend/schema/run-protocol-v1.json's note) --
grepping LangGraphGenerator.php's Python output finds no `emit(type="round"`
or `type="final"` call site at all, so there is nothing real to drive. Those
two stay hand-typed, only to prove the validation harness itself checks
arbitrary contract-shaped events, not to assert anything about production
behaviour.

argv[1] = compiled package root, argv[2] = run-protocol-v1.json
"""
import json, os, sys, importlib, threading

sys.path.insert(0, sys.argv[1])
contract = json.load(open(sys.argv[2]))
common = importlib.import_module("common")

seen = []
common.set_event_sink(seen.append)

playbook_hr = importlib.import_module("agents.playbook_hr")
run = common._PlaybookRun(False, {})
tools = common.build_playbook_tools(playbook_hr.NODE, run)
by_name = {t.name: t for t in tools}

# Real tool_call + message + tool_result, through wrap()/invoke().
by_name["send_direct_message"].invoke({"text": "hi", "sensitive": False})

# Real tool_call + note + tool_result, through wrap()/invoke().
by_name["leave_internal_note"].invoke({"text": "noted"})

# Real tool_call + gate_request + tool_result, through wrap()/invoke() and
# _playbook_gate()'s server-mode branch (a sink is installed, so that branch
# is taken). Threaded and answered via resolve_gate(), same as gate_probe.py,
# so this exercises the answered path rather than the timeout fallback.
os.environ["PLAYBOOK_GATE_TIMEOUT_S"] = "5"
gate_result = {}


def ask():
    gate_result["value"] = by_name["request_approval"].invoke(
        {"approver": "manager", "question": "q"})


t = threading.Thread(target=ask)
t.start()

gate = None
for _ in range(50):
    gate = next((e for e in seen if e.get("type") == "gate_request"), None)
    if gate:
        break
    threading.Event().wait(0.05)
if not gate:
    print(f"no gate_request emitted via the tool surface: {seen}")
    sys.exit(1)
common.resolve_gate(gate["tool_call_id"], {"decision": "approved", "comment": "go", "actor": "probe"})
t.join(5)
if t.is_alive():
    print("the gate did not resume after resolve_gate")
    sys.exit(1)

# round/final: no compiled-runtime call site exists to drive (see module
# docstring) -- hand-typed to check the validation harness itself, not
# production behaviour.
common.emit_event(type="round", round=1)
common.emit_event(type="final", status="resolved", leg=1)

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
