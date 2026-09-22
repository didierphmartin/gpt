"""Probe: a REAL compiled graph streams at least one frame per node.

Every other probe here replaces workflow.run with a fake, which is why the
generator emitting nothing per node stayed invisible to a green suite: the
fakes emitted their own events, so the stream was never empty. This one runs
the graph the compiler actually emitted -- workflow.run, _run_node_module,
the agent modules -- and only the chat model is stubbed.

The stub sits at the lowest boundary that removes the network: common._make_llm,
patched BEFORE workflow is imported (each agent module does `from common import
_make_llm` at import time, so the patch has to land first). Everything above it
is the generated code, unmodified.

The assertion: before the terminal `done`, the stream carries a frame
attributable to EACH agent node -- a message naming the node and a `final`
carrying its id as `leg`. A node that runs silently fails this.

argv[1] is a compiled modular package root (see CompiledRunServerTest::writeLinearPackage).
"""
import json, sys, importlib

sys.path.insert(0, sys.argv[1])

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult


class StubChatModel(BaseChatModel):
    """The smallest thing create_agent() will drive: one canned answer, no network."""

    @property
    def _llm_type(self) -> str:
        return "stub"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        # Echo the last human turn so the second node's output is visibly its own.
        last = messages[-1].content if messages else ""
        text = f"answer to: {str(last)[-40:]}"
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])


common = importlib.import_module("common")
common._make_llm = lambda *a, **k: StubChatModel()

workflow = importlib.import_module("workflow")
api = importlib.import_module("api")

# The graph really is the two-agent one, and api.py really is driving it.
assert [n for n, t in workflow.NODE_TYPES.items() if t == "agent"] == ["2", "3"], workflow.NODE_TYPES
assert api.run_workflow is workflow.run, "api.py is not driving the compiled graph"

from starlette.testclient import TestClient

with TestClient(api.app) as client:
    run_id = client.post("/runs", json={"prompt": "write something"}).json()["run_id"]

    events, done = [], None
    with client.stream("GET", f"/runs/{run_id}/events") as resp:
        assert resp.status_code == 200, resp.status_code
        name = "message"
        for line in resp.iter_lines():
            if line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                payload = json.loads(line.split(":", 1)[1].strip())
                if name == "done":
                    done = payload
                    break
                if name == "error":
                    raise AssertionError(f"run errored: {payload}")
                events.append(payload)

assert done is not None, "no done frame"
assert done["status"] == "completed", done

# --- one frame per node, before the terminal frame ---------------------------
messages = [e for e in events if e.get("type") == "message"]
legs = [e.get("leg") for e in events if e.get("type") == "final"]
rounds = [e.get("round") for e in events if e.get("type") == "round"]

for display in ("Researcher", "Writer"):
    assert any(display in (m.get("text") or "") for m in messages), \
        f"nothing on the stream is attributable to node {display!r}: {events}"

assert set(legs) == {"2", "3"}, f"expected a final per agent node, got legs {legs}"
assert rounds == [workflow.ORDER.index("2"), workflow.ORDER.index("3")], \
    f"expected one round per node in ORDER order, got {rounds}"

# The run's own narration reaches the stream. Every target prints "[node] ..."
# lines; the run server tees stdout so a conversation can show what is
# happening instead of sitting silent for minutes. Without this assertion the
# tee could be dropped and only a human watching an overlay would notice.
traces = [e.get("text") or "" for e in events if e.get("type") == "trace"]
assert traces, f"no trace frames: the run server is not teeing stdout: {events}"
assert any("[node]" in t for t in traces), f"traces carry no node narration: {traces}"
assert all(isinstance(t, str) and t == t.strip() and "\n" not in t for t in traces), \
    f"traces must be whole, stripped, single lines: {traces}"

# Every frame must still be one the contract describes -- emitting per-node
# progress is not a licence to invent event types.
contract = json.load(open(__file__.rsplit("/", 1)[0] + "/../../../../docs/run-protocol-v1.json"))
for e in events:
    spec = contract["events"].get(e["type"])
    assert spec, f"undescribed event type {e['type']!r}"
    for key in spec["required"]:
        assert key in e, f"{e['type']} is missing {key}: {e}"
    extra = set(e) - set(spec["required"]) - set(spec["optional"])
    assert not extra, f"{e['type']} has undescribed fields {sorted(extra)}: {e}"

print("OK")
