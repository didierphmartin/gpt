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

`terminal_publish_race()` below covers a third, narrower case: a subscriber
attaching in the exact window where `_drive()` has set `state.status` but
not yet published the terminal frame (deferred one loop tick via
`call_soon_threadsafe`, for FIFO ordering against the sink). That window is
real but timing-dependent to hit by racing real code, so it drives a
`RunState` directly instead.

argv[1] is a compiled modular package root.
"""
import asyncio, json, sys, importlib

sys.path.insert(0, sys.argv[1])
common = importlib.import_module("common")
workflow = importlib.import_module("workflow")

gate = asyncio.Event()


async def fake_run(prompt: str, session: str | None = None) -> str:
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


async def terminal_publish_race():
    """A subscriber attaching in the window where _drive() has already set
    state.status = "completed"/"failed" but the terminal frame itself has
    only been *scheduled* (call_soon_threadsafe, not yet run) must still get
    it -- not be cut off because a guard read state.status instead of
    "has the terminal frame actually been published".

    That window is real but timing-dependent in a live run, so it's driven
    directly here instead of raced: construct a RunState by hand, flip
    status the way _drive() does, but withhold the terminal publish() the
    same way call_soon_threadsafe withholds it for one loop tick, attach a
    subscriber, THEN publish it -- and prove it arrives.
    """
    state = api.RunState("race-run", "x")
    api.RUNS[state.id] = state
    try:
        state.publish("message", {"type": "message", "text": "before", "sensitive": False})
        state.status = "completed"          # set synchronously in _drive(), same as a real run
        assert not state.terminal, "probe setup is wrong: terminal must still be False here"

        gen = await attach(state.id)
        first = _parse(await gen.__anext__())
        assert first[1] == "message" and first[2]["text"] == "before", first

        # Drive the generator past the replay loop and the terminal guard
        # WHILE state.terminal is still False, so it reaches the real drain
        # (`await q.get()`) and genuinely suspends there -- the exact moment
        # the race is about. A status-based guard would already have
        # returned by now (state.status == "completed" the whole time), so
        # this __anext__() would finish (raise StopAsyncIteration) instead
        # of blocking; asyncio.sleep(0) lets it run to its own next
        # suspension point before we check.
        pending = asyncio.ensure_future(gen.__anext__())
        await asyncio.sleep(0)
        assert not pending.done(), (
            "the subscriber's stream already ended before the terminal frame "
            "was published -- a status-based guard would cut it off here and "
            "drop \"done\": " + repr(pending.exception() if pending.done() else None))

        # NOW the deferred terminal publish() finally runs.
        state.publish("done", {"run_id": state.id, "status": "completed", "output": "x", "seconds": 0.0})

        second = _parse(await asyncio.wait_for(pending, timeout=2))
        assert second[1] == "done", second
    finally:
        del api.RUNS[state.id]


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
        assert seqs == list(range(last_seq + 1, last_seq + 1 + len(seqs))), \
            f"expected a contiguous run starting at {last_seq + 1}, got: {seqs}"
        assert rest[-1][1] == "done", rest
        assert any(f[1] == "message" and f[2].get("text") == "second" for f in rest), rest
        assert rest[-1][2]["status"] == "completed", rest

        await asyncio.wait_for(ghost_task, timeout=5)

    await terminal_publish_race()

    print("OK")


asyncio.run(main())
