<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The run server every compiled target serves, emitted once.
 *
 * `api.py`'s runtime half — RunState, the four routes, the SSE stream with its
 * ring buffer and Last-Event-ID replay, the uvicorn entry point — has no
 * framework in it. It calls one function and publishes what comes back. Only
 * the module docstring and the import line differ between targets, so those are
 * the parameters and everything else is shared.
 *
 * Extracted from LangGraphGenerator, whose emitted bytes must not move: the
 * existing generator pins are the proof of that.
 */
final class RunServerEmitter
{
    /**
     * @param string $workflowName For the docstring's first line.
     * @param string $docBody      Already composed AND escaped by the caller.
     * @param string $importLine   How this target's workflow module is imported.
     * @param string $versionLine  The `WORKFLOW_VERSION = ...` statement. REQUIRED,
     *                             and not merely for the identity route: the
     *                             `__main__` startup print reads WORKFLOW_VERSION
     *                             before uvicorn.run, so a server emitted without
     *                             it raises NameError and exits before binding.
     *                             Targets with no version of their own pass
     *                             `WORKFLOW_VERSION = "1"`.
     */
    public static function emit(string $workflowName, string $docBody, string $importLine, string $versionLine): string
    {
        $L = [];
        $L[] = '"""Run server for workflow ' . json_encode($workflowName, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $L[] = '';
        foreach (explode("\n", $docBody) as $dl) {
            $L[] = $dl;
        }
        $L[] = '"""';
        $L[] = 'from __future__ import annotations';
        $L[] = '';
        $L[] = 'import argparse, asyncio, json, os, sys, time, uuid   # sys: _TraceTee swaps stdout for the run';
        $L[] = '';
        $L[] = 'from fastapi import FastAPI, HTTPException, Request';
        $L[] = 'from fastapi.middleware.cors import CORSMiddleware';
        $L[] = 'from fastapi.responses import StreamingResponse';
        $L[] = 'import uvicorn';
        $L[] = '';
        $L[] = 'from common import set_event_sink, resolve_gate';
        $L[] = $importLine;
        $L[] = '';
        $L[] = $versionLine;
        $L[] = '';
        $L[] = self::runtimeBlock();
        return rtrim(implode("\n", $L), "\n") . "\n";
    }

    /**
     * The whole compiled package for a single-script target: ADK, MAF and NOOA
     * differ only in the folder suffix and one line of the api.py docstring.
     *
     * This lives here rather than being repeated in three generatePackage()
     * methods because what they share is not just shape — it is the FILE SET,
     * the `from workflow import …` line api.py depends on, and the version
     * literal the runtime block reads. Any of those drifting in one target
     * alone is a broken server, and nothing compared the three copies.
     *
     * LangGraph does not use this: its packages are multi-file with their own
     * layout, and it calls emit() directly.
     *
     * @param array  $single  What generate() returned: at least ['code' => …].
     * @param string $name    The workflow's display name (folder + docstring).
     * @param string $suffix  Folder suffix: 'adk' | 'maf' | 'nooa'.
     * @param string $docLine The api.py docstring's "what this is" line.
     * @return array{root: string, files: list<array{path: string, code: string}>}
     */
    public static function package(array $single, string $name, string $suffix, string $docLine): array
    {
        return [
            'root' => preg_replace('/[^a-z0-9_]+/i', '_', strtolower($name)) . '_' . $suffix,
            'files' => [
                // A regular `agents/` package elsewhere on sys.path (openai-agents)
                // beats a local namespace portion under PEP 420. Without this
                // marker the emitted package loses to an installed one.
                ['path' => '__init__.py', 'code' => "\n"],
                ['path' => 'workflow.py', 'code' => (string) ($single['code'] ?? '')],
                ['path' => 'common.py',   'code' => self::commonBlock()],
                ['path' => 'api.py',      'code' => self::emit(
                    $name,
                    $docLine,
                    'from workflow import run_workflow, DEFAULT_PROMPT, WORKFLOW_ID, WORKFLOW_NAME',
                    // These targets carry no version of their own; the identity
                    // route and the startup print both need the name defined.
                    'WORKFLOW_VERSION = "1"'
                )],
            ],
        ];
    }

    /**
     * What a non-LangGraph target's common.py contains: the event sink and the
     * gate rendezvous, inert until api.py installs a sink. ADK, MAF and NOOA do
     * not call emit_event yet — this is the seam their swarm ports will use.
     */
    public static function commonBlock(): string
    {
        // eventSinkBlock() uses threading.Lock()/threading.Event() but has never
        // imported threading itself -- its only caller until now was LangGraph,
        // whose own common.py header already imports threading for an unrelated
        // reason, so the block could get away with assuming it. common.py here
        // is a fresh standalone module with no such neighbour import, so the
        // import has to be added at this call site, not inside the block itself
        // (putting it in eventSinkBlock() would duplicate LangGraph's import and
        // move its already-pinned emitted bytes).
        return "import threading\n\n" . PythonEmitHelpers::eventSinkBlock();
    }

    /**
     * api.py's runtime half: run state, the four routes, the uvicorn entry point.
     *
     * Public: besides emit() above, LangGraphGenerator::emitA2AApi() also needs
     * this block verbatim (its api.py has an A2A-specific preamble -- the agent
     * supervisor lifecycle -- ahead of the same shared runtime), so this cannot
     * stay private to emit().
     */
    public static function runtimeBlock(): string
    {
        return <<<'PY'
# ==============================================================
# RUN STATE
# One RunState per POST /runs. The graph runs as an asyncio task; its
# events fan out to one queue per attached client, and land in a ring
# buffer so a reconnecting client can replay what it missed (see
# Last-Event-ID).
# ==============================================================
RING = 500          # events kept per run for replay
RUNS = {}           # run_id -> RunState
RUN_LOCK = None     # asyncio.Lock, created on first use (see _drive)


class RunState:
    """One run: its status, its event history and one queue per attached client."""

    def __init__(self, run_id: str, prompt: str, session: str | None = None):
        self.id = run_id
        self.prompt = prompt
        self.session = session            # thread_id to resume (swarm only; ignored elsewhere)
        self.status = "running"
        self.output = ""
        self.error = ""
        self.seq = 0
        self.events = []                  # [(seq, name, payload)] capped at RING
        self.terminal = False             # True once the done/error frame is PUBLISHED
        self.subscribers = []             # list[asyncio.Queue] -- one per attached client
        self.task = None

    def publish(self, name: str, payload: dict) -> None:
        """Record one frame and hand it to every attached client."""
        self.seq += 1
        frame = (self.seq, name, payload)
        self.events.append(frame)
        if len(self.events) > RING:
            del self.events[0]
        if name in ("done", "error"):
            self.terminal = True
        for q in list(self.subscribers):
            q.put_nowait(frame)

    def since(self, last_id: int):
        """Frames after `last_id`, for a client that reconnected."""
        return [f for f in self.events if f[0] > last_id]

    def subscribe(self) -> asyncio.Queue:
        """Attach a client. Returns its own queue of frames."""
        q = asyncio.Queue()
        self.subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        """Detach a client (stream closed, browser gone)."""
        if q in self.subscribers:
            self.subscribers.remove(q)


# ==============================================================
# THE APP
# No authentication by design: this server has no users and no session.
# Bind it to 127.0.0.1 or a trusted LAN interface.
#
# CORS is therefore the only thing standing between this server and any
# page the user happens to have open: starting a run here spends real API
# credit and performs real tool side effects, and the event stream carries
# the run's transcript. Loopback origins on any port are allowed (that is
# the local frontend); a LAN-hosted frontend adds itself with
# WORKFLOW_API_ALLOW_ORIGIN=http://host:port (comma-separated for several).
# ==============================================================
_EXTRA_ORIGINS = [o.strip() for o in os.environ.get("WORKFLOW_API_ALLOW_ORIGIN", "").split(",") if o.strip()]

app = FastAPI(title=f"{WORKFLOW_NAME} run server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_EXTRA_ORIGINS,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/.well-known/workflow.json")
async def identity() -> dict:
    """Who this server is. The editor checks it before trusting a port."""
    return {"workflow_id": WORKFLOW_ID, "name": WORKFLOW_NAME,
            "version": WORKFLOW_VERSION, "protocol": "run/1"}


@app.post("/runs")
async def start_run(body: dict | None = None) -> dict:
    """Start a run and return its id. Does not stream -- GET its events next.

    `session` in the body is forwarded to run_workflow() as the conversation
    to resume. Only the swarm target's run() acts on it -- the modular and
    A2A targets accept and ignore it -- so a caller can pass the same
    session across every target without knowing which one is behind this
    server.
    """
    prompt = str((body or {}).get("prompt") or "").strip() or DEFAULT_PROMPT or "Hello"
    session = (body or {}).get("session") or None
    state = RunState(uuid.uuid4().hex, prompt, session)
    RUNS[state.id] = state
    state.task = asyncio.create_task(_drive(state))
    return {"run_id": state.id, "status": state.status}


class _TraceTee:
    """Mirror what the workflow PRINTS into the run's event stream.

    Every compiled target already narrates itself on stdout -- "[node] 'IT
    claims' done -- 812 chars (6.1s)", "[tool] okta__lookup_users", the
    playbook's round-by-round lines. Only LangGraph also emits those as
    protocol events, so on the other targets a conversation sat silent for
    minutes with nothing to show that anything was happening. Teeing stdout
    gives every target the same live feedback without asking four generators to
    emit it four ways.

    Writes still reach the real stdout, so the server's console log is
    unchanged. Lines are published whole (partial writes are buffered until the
    newline) and truncated, because a node that prints a whole document would
    otherwise push it through the event stream a second time.
    """
    MAX = 400

    def __init__(self, real, publish):
        self._real = real
        self._publish = publish
        self._buf = ""

    def write(self, s):
        self._real.write(s)
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            line = line.strip()
            if line:
                try:
                    self._publish(line[:self.MAX] + ("…" if len(line) > self.MAX else ""))
                except Exception:
                    pass   # a broken stream must never break the run
        return len(s)

    def flush(self):
        self._real.flush()

    def isatty(self):
        return False   # a served run is never interactive; keep gates off the console

    def __getattr__(self, name):
        return getattr(self._real, name)


def _error_text(exc: BaseException) -> str:
    """The failure a human can act on, not the wrapper it arrived in.

    Frameworks that fan agents out concurrently (ADK's ParallelAgent, anyio
    task groups) raise an ExceptionGroup, whose str() is "unhandled errors in
    a TaskGroup (1 sub-exception)" -- true, useless, and the only thing the
    browser overlay used to show for a run that died of an expired API key or
    an exhausted quota. Flattening walks to the leaves and reports those
    instead. Duck-typed on `.exceptions` rather than isinstance against
    BaseExceptionGroup so it behaves the same on Python 3.10, where that name
    does not exist.
    """
    parts: list[str] = []

    def walk(e: BaseException) -> None:
        subs = getattr(e, "exceptions", None)
        if isinstance(subs, (list, tuple)) and subs:
            for sub in subs:
                walk(sub)
            return
        text = str(e).strip()
        parts.append(f"{type(e).__name__}: {text}" if text else type(e).__name__)

    walk(exc)
    seen = set()
    unique = [p for p in parts if not (p in seen or seen.add(p))]
    return " | ".join(unique) if unique else str(exc)


async def _drive(state: RunState) -> None:
    """Run the graph with the event sink installed, then publish the terminal frame.

    Runs are serialised. The sink is a module global and the playbook's gate
    tools are sync callables LangChain runs in an executor -- which does not
    carry a ContextVar across -- so two concurrent runs would cross-deliver
    each other's events. A second run waits here rather than corrupting both
    transcripts; different workflows run in different processes anyway.
    """
    global RUN_LOCK
    loop = asyncio.get_running_loop()
    app.state.loop = loop
    if RUN_LOCK is None:
        RUN_LOCK = asyncio.Lock()

    def sink(ev: dict) -> None:
        # Called from graph code that may be on a worker thread (sync tools),
        # so hop back onto the loop before fanning it out to subscribers.
        loop.call_soon_threadsafe(state.publish, "message", ev)

    async with RUN_LOCK:
        # A2A only: the agent servers start with the first run. Not present in
        # the modular package (no globals() hit -> no-op there). The hook itself
        # is a blocking call (AgentSupervisor.start() polls each agent's card
        # for up to 60s), so it is hopped to a worker thread rather than run
        # inline -- run inline it would stall this loop, and everyone on it,
        # for that whole window. Inside RUN_LOCK so two runs racing to start it
        # can't double-spawn the agents.
        ensure_agents = globals().get("_ensure_agents")
        if ensure_agents is not None:
            await asyncio.to_thread(ensure_agents)
        prev = set_event_sink(sink)
        # Tee stdout for the duration of the run (runs are serialised by
        # RUN_LOCK, so there is never a second run's output mixed in here).
        _real_stdout = sys.stdout
        sys.stdout = _TraceTee(_real_stdout, lambda ln: sink({"type": "trace", "text": ln}))
        t0 = time.monotonic()
        try:
            state.output = await run_workflow(state.prompt, state.session)
            state.status = "completed"
            # Publish the terminal frame through the same call_soon_threadsafe
            # hop as every sink-driven event, not directly: the graph's last
            # emit_event() can still have a publish() pending on the loop's
            # ready queue when run_workflow() returns (it was only scheduled,
            # not yet run). A direct call here would jump the queue and hand
            # out "done" before that trailing event -- so a client can see
            # "done" and stop, and the still-unpublished event that "done"
            # skipped ahead of never gets delivered at all.
            loop.call_soon_threadsafe(state.publish, "done", {"run_id": state.id, "status": state.status,
                                   "output": state.output, "seconds": round(time.monotonic() - t0, 1)})
        except Exception as e:
            state.status = "failed"
            state.error = _error_text(e)
            loop.call_soon_threadsafe(state.publish, "error", {"run_id": state.id, "error": state.error})
        finally:
            sys.stdout = _real_stdout
            set_event_sink(prev)


@app.get("/runs/{run_id}/events")
async def stream_events(run_id: str, request: Request) -> StreamingResponse:
    """SSE stream of one run. Replays from Last-Event-ID when reconnecting."""
    state = RUNS.get(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")
    try:
        last_id = int(request.headers.get("last-event-id") or 0)
    except ValueError:
        last_id = 0

    async def frames():
        # Subscribe before replaying: publish() puts every frame in BOTH the
        # ring buffer and every attached subscriber's own queue, so an event
        # published between the subscribe below and the end of the replay
        # loop lands in this client's queue and is skipped as a duplicate --
        # not lost, and not delivered to some other client's queue instead.
        # Track the highest seq the replay loop already sent so the queue
        # loop skips those stale duplicates instead of re-yielding them.
        # Clamped to state.seq: an id ahead of the run (a stale tab, a
        # reconnect against the wrong run) must not suppress a frame the
        # run still goes on to publish -- including the terminal one, which
        # would hang the stream. That only holds while the run is still
        # producing frames, though: once the terminal frame has been
        # published nothing more ever will be, so a reconnect at or past
        # it must not fall through to the drain below -- see the
        # state.terminal check after the replay loop.
        q = state.subscribe()
        try:
            sent_through = min(last_id, state.seq)
            since = state.since(last_id)
            if since and since[0][0] > last_id + 1:
                # More than RING events have been published since last_id --
                # the gap itself was evicted from the ring buffer, not just
                # not-yet-seen. Say so up front instead of silently resuming
                # mid-stream as though nothing were missing.
                yield _frame(last_id, "message",
                             {"type": "truncated", "from": last_id, "resumed_at": since[0][0]})
            for seq, name, payload in since:
                yield _frame(seq, name, payload)
                sent_through = seq
                if name in ("done", "error"):
                    return
            if state.terminal:
                # The terminal frame has already been PUBLISHED (not just
                # "the run isn't running" -- state.status flips to
                # completed/failed synchronously in _drive(), but the
                # terminal publish() is only *scheduled* via
                # call_soon_threadsafe right after, same as every
                # sink-driven event, for FIFO ordering; state.status alone
                # would wrongly match during that window and cut off a
                # subscriber who just subscribed *before* the publish that
                # was meant to reach it). Once true, nothing more will ever
                # be published, so there is nothing to wait for.
                # EventSource auto-reconnects whenever the server closes the
                # stream, including after a completed run, unless the page
                # calls .close() -- without this check that reconnect would
                # subscribe and then block on q.get() forever.
                return
            while True:
                seq, name, payload = await q.get()
                if seq <= sent_through:
                    continue
                yield _frame(seq, name, payload)
                sent_through = seq
                if name in ("done", "error"):
                    return
        finally:
            state.unsubscribe(q)

    return StreamingResponse(frames(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _frame(seq: int, name: str, payload: dict) -> str:
    """One SSE frame. `id:` is what a reconnecting client sends back."""
    return f"id: {seq}\nevent: {name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.post("/runs/{run_id}/tool-result")
async def tool_result(run_id: str, body: dict | None = None) -> dict:
    """Answer a gate. Body is flat: {tool_call_id, ...answer} -- the same shape
    the app backend's /workflows/tool-result takes."""
    if run_id not in RUNS:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id}")
    payload = dict(body or {})
    tool_call_id = str(payload.pop("tool_call_id", ""))
    if not tool_call_id:
        raise HTTPException(status_code=400, detail="tool_call_id is required")
    if not resolve_gate(tool_call_id, payload):
        raise HTTPException(status_code=409, detail=f"no gate waiting for {tool_call_id}")
    return {"ok": True}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"Run server for workflow {WORKFLOW_NAME!r}")
    ap.add_argument("--host", default=os.environ.get("WORKFLOW_API_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("WORKFLOW_API_PORT", "8710")))
    a = ap.parse_args()
    print(f"[api] {WORKFLOW_NAME!r} serving http://{a.host}:{a.port}/ (workflow {WORKFLOW_ID}, {WORKFLOW_VERSION})", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")
PY;
    }
}
