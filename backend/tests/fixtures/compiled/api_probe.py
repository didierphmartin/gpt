"""Probe: the generated api.py serves a run end to end with a stubbed graph.

The graph itself is replaced so no LLM or MCP server is needed: this asserts
the SERVER contract (run id, event stream, gate answering, done frame), which
is what the frontend depends on.

argv[1] is a compiled modular package root.
"""
import asyncio, json, sys, importlib, threading

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")
workflow = importlib.import_module("workflow")


# Stub the graph: emit one message, raise one gate, return the answer as output.
#
# _playbook_gate() blocks synchronously on a threading.Event -- fine in real
# runs because LangChain dispatches sync tool calls to an executor thread, but
# fatal if awaited straight on the server's single event-loop thread (it would
# starve every other coroutine, including the SSE route delivering the very
# gate_request this is waiting to be answered). Route it through an executor
# here too, the same way the real graph does.
async def fake_run(prompt: str) -> str:
    common.emit_event(type="round", round=1)
    common.emit_event(type="message", text=f"echo: {prompt}", sensitive=False)
    run = common._PlaybookRun(False, {})
    loop = asyncio.get_running_loop()
    decision = await loop.run_in_executor(
        None, common._playbook_gate, run, "approval", "request_approval", {"question": "ok?"})
    return "decision=" + decision["decision"]["decision"]


workflow.run = fake_run
api = importlib.import_module("api")
api.run_workflow = fake_run

from starlette.testclient import TestClient

# `with` matters: starlette's TestClient opens a fresh event-loop portal per
# request unless entered as a context manager (see _portal_factory), and that
# per-request portal blocks its caller until the ENTIRE ASGI call -- our
# fire-and-forget `_drive` task included -- finishes. A bare `TestClient(app)`
# would make POST /runs itself hang forever waiting on the run it just started.
with TestClient(api.app) as client:
    card = client.get("/.well-known/workflow.json").json()
    assert card["workflow_id"] == 44, card
    assert card["protocol"] == "run/1", card

    started = client.post("/runs", json={"prompt": "hello"}).json()
    run_id = started["run_id"]
    assert run_id, started

    gate_id = {}

    def answer_when_asked():
        """Answer the gate as soon as the run shows it waiting (the browser's job).

        Watches the run's own server-side event log (api.RUNS[run_id].events),
        not the client-visible SSE response: this TestClient transport fully
        buffers one ASGI call -- including the whole SSE body -- before
        returning any of it, so the stream read below never observes partial
        progress. The server-side log updates live as the graph runs, which is
        exactly the signal a real browser gets incrementally over the wire.
        """
        for _ in range(200):
            state = api.RUNS.get(run_id)
            g = next((p for _, n, p in state.events if n == "message" and p.get("type") == "gate_request"), None) if state else None
            if g:
                gate_id["v"] = g["tool_call_id"]
                client.post(f"/runs/{run_id}/tool-result",
                            json={"tool_call_id": g["tool_call_id"], "decision": "approved", "comment": "go"})
                return
            threading.Event().wait(0.05)

    threading.Thread(target=answer_when_asked, daemon=True).start()

    done = None
    events = []
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

    kinds = [e["type"] for e in events]
    assert kinds.count("round") == 1 and kinds.count("message") == 1 and kinds.count("gate_request") == 1, kinds
    assert gate_id.get("v"), "the gate was never answered"
    assert done["status"] == "completed", done
    assert done["output"] == "decision=approved", done
    assert done["run_id"] == run_id, done

    # A tool-result for an unknown run is refused, not silently swallowed.
    assert client.post("/runs/nope/tool-result", json={"tool_call_id": "x"}).status_code == 404

    # A body with no tool_call_id is a 400, not a KeyError or a silent no-op.
    assert client.post(f"/runs/{run_id}/tool-result", json={}).status_code == 400

    # A tool_call_id nobody is waiting on (the run's gate already answered
    # above) is a 409, not a silently-accepted no-op.
    assert client.post(f"/runs/{run_id}/tool-result",
                        json={"tool_call_id": "no-such-gate"}).status_code == 409

print("OK")
