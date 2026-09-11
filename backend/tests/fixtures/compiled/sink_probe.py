"""Probe: the generated common.py sink is inert by default and tees run events.

argv[1] is a compiled modular package root. Exits non-zero with a message on
failure; prints OK on success.
"""
import sys, importlib

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")

# 1. Inert with no sink installed: emitting must not raise.
common.emit_event(type="message", text="ignored")

# 2. Installed sink receives events, including a playbook run's own emits.
seen = []
prev = common.set_event_sink(seen.append)
assert prev is None, "set_event_sink should return the previous sink"
common.emit_event(type="round", round=1)
run = common._PlaybookRun(False, {})
run.emit(type="message", text="hello", sensitive=False)

assert seen[0] == {"type": "round", "round": 1}, seen
assert seen[1] == {"type": "message", "text": "hello", "sensitive": False}, seen
# The run's own timeline is unaffected by the tee.
assert run.events == [{"type": "message", "text": "hello", "sensitive": False}], run.events

# 3. Uninstalling restores inertness.
common.set_event_sink(None)
common.emit_event(type="round", round=2)
assert len(seen) == 2, seen

print("OK")
