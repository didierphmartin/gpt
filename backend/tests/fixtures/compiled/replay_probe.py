"""Probe: dropping the stream mid-run and reattaching with Last-Event-ID
replays exactly the frames that were missed, then continues live.

Drives the app in-process so the run, both streams and the release below all
share one event loop -- no threads, no races.

That ruled out httpx.ASGITransport as the driver for the two GET streams:
httpx 0.28's ASGITransport (see `_transports/asgi.py::handle_async_request`)
awaits the whole ASGI call -- `await self.app(scope, receive, send)` -- before
returning any Response at all, buffering the *entire* SSE body first. A
client using it can never observe partial progress from a still-running
request; `client.stream(...)`'s `__aenter__` would simply block until the run
reaches "done", which is the same full-buffering problem `api_probe.py`
documents for starlette's TestClient (a different transport, same limit) --
switching transports doesn't lift it. So the two GET streams below call the
route's own `stream_events()` coroutine directly (the exact function FastAPI
would otherwise dispatch to) and pull frames by hand from the
StreamingResponse's `body_iterator` -- the same async generator a real
request would drive, just driven here without a buffering transport in the
way. POST /runs still goes over httpx + ASGITransport: that call doesn't
stream, so the buffering is invisible.

A client that drops a connection doesn't tell the server so -- the server
keeps driving that request's generator (Starlette's own send loop keeps
calling `body_iterator.__anext__()`) until it separately notices the
disconnect, which for a real dropped socket can lag well behind the app
still producing events. So the first stream here is never explicitly closed;
it's left running in the background exactly like that ghost connection,
and the reconnect is proven to get every frame despite it still being
attached.

argv[1] is a compiled modular package root.
"""
import asyncio, json, sys, importlib

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")
workflow = importlib.import_module("workflow")

gate = asyncio.Event()


async def fake_run(prompt: str) -> str:
    common.emit_event(type="round", round=1)
    common.emit_event(type="message", text="first", sensitive=False)
    await gate.wait()                       # hold the run open across the reconnect
    common.emit_event(type="message", text="second", sensitive=False)
    return "done"


workflow.run = fake_run
api = importlib.import_module("api")
api.run_workflow = fake_run

import httpx
from starlette.requests import Request


def _parse(frame: str):
    """One `_frame()` string -> (seq, event name, payload)."""
    seq = name = payload = None
    for line in frame.split("\n"):
        if line.startswith("id:"):
            seq = int(line.split(":", 1)[1].strip())
        elif line.startswith("event:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            payload = json.loads(line.split(":", 1)[1].strip())
    return seq, name, payload


async def attach(run_id: str, last_event_id: int | None = None):
    """Call the SSE route directly, exactly as FastAPI would for a GET
    /runs/{run_id}/events, and return its live (undriven) body iterator."""
    headers = [] if last_event_id is None else [(b"last-event-id", str(last_event_id).encode())]
    request = Request({"type": "http", "headers": headers, "method": "GET", "path": f"/runs/{run_id}/events"})
    resp = await api.stream_events(run_id, request)
    assert resp.status_code == 200, resp.status_code
    return resp.body_iterator


async def ghost(gen) -> None:
    """Keep pulling from a dropped client's generator, same as Starlette's own
    send loop would while it hasn't yet noticed the disconnect."""
    try:
        async for _ in gen:
            pass
    except Exception:
        pass


async def main():
    transport = httpx.ASGITransport(app=api.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as client:
        run_id = (await client.post("/runs", json={"prompt": "x"})).json()["run_id"]

        gen1 = await attach(run_id)
        first = [_parse(await gen1.__anext__()), _parse(await gen1.__anext__())]
        assert [f[2]["type"] for f in first] == ["round", "message"], first
        last_seq = first[-1][0]

        # The client "reloads": nothing here closes gen1. It keeps running in
        # the background -- a ghost subscriber -- exactly like a connection
        # the server hasn't yet noticed is gone.
        ghost_task = asyncio.create_task(ghost(gen1))
        await asyncio.sleep(0)   # let the ghost reach its own live wait

        gate.set()
        gen2 = await attach(run_id, last_event_id=last_seq)
        rest = []
        async for frame in gen2:
            parsed = _parse(frame)
            rest.append(parsed)
            if parsed[1] in ("done", "error"):
                break

        seqs = [f[0] for f in rest]
        assert min(seqs) == last_seq + 1, f"replayed a frame the client already had: {seqs}"
        assert rest[-1][1] == "done", rest
        assert any(f[1] == "message" and f[2].get("text") == "second" for f in rest), rest
        assert rest[-1][2]["status"] == "completed", rest

        await asyncio.wait_for(ghost_task, timeout=5)

    print("OK")


asyncio.run(main())
