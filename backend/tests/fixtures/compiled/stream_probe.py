"""Probe: the server streams frames as the run produces them -- it does not
buffer the whole SSE body until the run finishes.

The other probes deliberately avoid real HTTP for good reasons (see their own
docstrings), which means nothing else in the suite would catch a regression
that made the server collect every frame and flush them all at once: every
other test would stay green while a real browser saw nothing until the run
was already over. So this one runs the compiled package's actual api.py
under a real `uvicorn.Server` on a real loopback socket, in a background
thread, and reads it with a default (real-transport) httpx.AsyncClient --
genuine TCP, no ASGI in-process transport involved.

argv[1] is a compiled modular package root.
"""
import asyncio, json, socket, sys, threading, importlib

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")
workflow = importlib.import_module("workflow")


# Stub the graph: two events, then a REAL gate (threading.Event, answered via
# resolve_gate/the /tool-result endpoint) -- same shape as api_probe.py's
# fake_run, reused here because it already exercises the executor hop
# correctly (see that file's comment on why the gate must not be awaited
# directly on the loop thread).
async def fake_run(prompt: str, session: str | None = None) -> str:
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

import httpx
import uvicorn

config = uvicorn.Config(api.app, host="127.0.0.1", port=0, log_level="warning")
server = uvicorn.Server(config)
server_thread = threading.Thread(target=server.run, daemon=True)
server_thread.start()

for _ in range(200):
    if server.started:
        break
    threading.Event().wait(0.02)
else:
    raise AssertionError("uvicorn did not start within 4s")
port = server.servers[0].sockets[0].getsockname()[1]


async def sse_events(lines):
    """Turn a shared `resp.aiter_lines()` iterator into (event name, payload)
    pairs. httpx raises StreamConsumed if `aiter_lines()` is called more than
    once on the same response, so every phase below must keep pulling from
    the SAME iterator rather than re-entering it."""
    name = "message"
    async for line in lines:
        if line.startswith("event:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            yield name, json.loads(line.split(":", 1)[1].strip())


async def main():
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
        run_id = (await client.post("/runs", json={"prompt": "hello"})).json()["run_id"]

        async with client.stream("GET", f"/runs/{run_id}/events") as resp:
            assert resp.status_code == 200, resp.status_code
            events = sse_events(resp.aiter_lines())

            got = []
            async for _, payload in events:
                got.append(payload)
                # The run is blocked on a real threading.Event gate at this
                # point -- nothing has touched it yet. Getting these two
                # frames off the wire here, before anything below releases
                # that gate, is what proves the connection is genuinely
                # streaming rather than buffering until the run (which
                # cannot finish without our help) completes.
                if len(got) == 2:
                    break
            assert [e["type"] for e in got] == ["round", "message"], got

            gate_id = None
            async for _, payload in events:
                if payload.get("type") == "gate_request":
                    gate_id = payload["tool_call_id"]
                    break
            assert gate_id, "no gate_request arrived on the stream"

            answered = await client.post(f"/runs/{run_id}/tool-result",
                                          json={"tool_call_id": gate_id, "decision": "approved", "comment": "go"})
            assert answered.status_code == 200, answered.text

            done = None
            async for name, payload in events:
                if name == "done":
                    done = payload
                    break
            assert done, "no done frame arrived"
            assert done["status"] == "completed", done
            assert done["output"] == "decision=approved", done

    print("OK")


try:
    asyncio.run(asyncio.wait_for(main(), timeout=20))
finally:
    server.should_exit = True
    server_thread.join(timeout=5)
