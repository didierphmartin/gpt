# Concurrent, optionally multi-user run servers — design

Date: 2026-09-13. Branch: feat/backend-python. Status: draft for review.

Builds on `2026-09-10-compiled-workflow-server-design.md`, which gave the LangGraph modular and A2A targets a run server. That design deliberately deferred two things: runs are serialised, and there is no notion of who is running them. This one removes both, and lays the ground for the other compile targets to follow.

## 1. Goal

1. **Concurrency, unconditionally.** Two runs of a compiled workflow proceed at the same time without leaking events, gates or timings into each other.
2. **Multi-user, optionally.** A checkbox in the code-generation form, chosen before compiling like the packaging mode. When on, a run belongs to its caller: you see and answer only your own.
3. **A shared, target-agnostic core.** The concurrency machinery lives in one file that knows nothing about LangGraph, so ADK, MAF and NOOA can adopt it without reimplementation (§9).

Non-goals here: durable runs across a server restart; a login story inside the generated server (identity comes from the deployment); the swarm architecture (its own spec).

Phase 1 deliberately excludes playbook nodes — see §1c.

## 1b. Terminology — one flag

There is **one user-facing setting: "Multi-user run server."** Everything below that
talks about per-run isolation is internal plumbing, not a second choice: without it
multi-user cannot work, and with it a single user gets two overlapping runs for free.
Nobody is ever asked to turn "concurrency" on.

| Multi-user | Owner of a run | Runs may overlap | History |
|---|---|---|---|
| off | the constant `"local"` | yes | one per thread |
| on | from the deployment (§5) | yes | one per user per thread |

## 1c. Phasing — dispatcher workflows first, playbooks after

**Phase 1 covers workflows with no playbook node**: a dispatcher and plain agent nodes.
**Phase 2 adds playbook nodes**, whose human gates are the genuinely hard part of
concurrency.

This is not arbitrary. Almost everything difficult about running two workflows at once
lives in the gate machinery: a rendezvous keyed by `tool_call_id`, a blocked thread
waiting on an answer, a timeout, and — in A2A — an agent server that serialises
specifically so its gate bridge can find "the run in progress" through a module-global
`_ACTIVE`. Take playbooks out of phase 1 and all of that goes with them.

What phase 1 still has to solve, and what it defers:

| | Phase 1 | Phase 2 |
|---|---|---|
| per-run event sink (replaces the global) | yes | — |
| per-run `NODE_DURATIONS` / `_RUN_T0` (else two runs blend one summary) | yes | — |
| run registry keyed by owner, ownership on every route | yes | — |
| history per `(owner, thread)` | yes | — |
| gate rendezvous per run | — | yes |
| A2A agent servers: drop `_ACTIVE` and `_RUN_LOCK` | — | yes |

**Until phase 2 lands, a workflow that contains a playbook node keeps today's
serialisation.** The generator already knows at emit time whether `playbookData` is
empty, so it emits `RUN_LOCK` only for those workflows, with a comment saying why. That
is two behaviours rather than one — accepted deliberately and temporarily, because the
alternative is blocking every concurrent run behind the hardest part of the problem.

Phase 1's test workflow is a dispatcher with two dispatched nodes, which exercises
routing, per-run sinks, ownership and history without a single gate.

## 2. Why per-run isolation is a fix, not a feature

Today the event sink is a module global:

```python
_SINK = None          # common.py
def emit_event(**ev):
    sink = _SINK
    if sink is not None: sink(dict(ev))
```

Two concurrent runs would cross-deliver each other's events, which is why `RUN_LOCK` serialises the graph. The lock is a workaround for the global, and both go.

Every emit site already has a per-run object in scope, so the sink can be threaded explicitly rather than found globally:

| Emit site | Per-run object available |
|---|---|
| `_run_node_module` → `round`, `message`, `final` | the run being driven |
| `_PlaybookRun.emit` tee → `message`, `tool_call`, `tool_result`, `note` | the run record itself |
| `_playbook_gate` → `gate_request` | receives `run` as its first argument |

`contextvars` was considered and rejected: LangChain dispatches the playbook's sync gate tools into an executor, and correctness would then rest on context propagation across a boundary we do not control. Explicit is cheaper to reason about and to test.

Concurrency is unconditional — it benefits a single user with two workflows open, and two concurrency behaviours would double the surface to test.

## 3. The code-generation option

The existing modal gains one checkbox beneath the three radios:

```
( ) Single file
(•) Agents in separate files
( ) A2A

  [x] Multi-user run server
      Runs belong to the caller: you only see and answer your own.
      Identity comes from the deployment (a JWT secret or an authenticating
      proxy); off, the server is single-user local.
```

- Disabled for **Single file**, which emits no `api.py`.
- Stored as `{mode, multiUser}` under `wf:<id>:codegen`, alongside the existing mode.
- Sent as `&multi_user=1`; the generator reads `$options['multi_user']`.
- New i18n keys in en/es/fr; cache-buster bump.

## 4. `runs.py` — the new module

A fourth file in the modular package, and the sibling of `orchestrator.py` in the A2A folder:

```
workflow.py   the graph
common.py     stateless runtime — LLM factory, MCP client, tools, skills, playbook engine
runs.py       NEW: run registry, per-run sink, gate rendezvous, ownership, replay
api.py        HTTP only: routes, SSE framing, identity
agents/*.py   one node each
```

**Layering, held strictly:**

- `common.py` holds no run state. `_SINK`, `_GATES` and the gate helpers move out; `_PlaybookRun` takes a `sink` constructor argument. It therefore imports nothing from `runs.py`.
- `runs.py` imports neither `workflow.py` nor `common.py`. It is state machinery: give it a run, it gives you a sink, a subscriber queue, and a gate to wait on. **It contains no LangGraph import and no framework dependency** — that is what makes §9 possible.
- `api.py` and `workflow.py` depend on `runs.py`; never the reverse.

**What `runs.py` owns:**

```python
class Run:              # id, owner, prompt, status, terminal flag
    def publish(name, payload)      # ring buffer + fan-out to subscribers
    def subscribe() / unsubscribe() # one queue per attached client
    def since(last_id)              # replay, with the truncated-gap signal
    def sink()                      # the callable handed to the graph
    def open_gate(tool_call_id)     # returns the Event the run blocks on
    def resolve_gate(id, answer)    # delivers a human answer to THIS run
    def take_gate_answer(id)

class RunRegistry:      # the only shared state in the process
    def create(owner, prompt) -> Run
    def get(owner, run_id) -> Run | None     # owner mismatch reads as missing
    def reap(older_than)                     # bounded growth
```

Gates move from a module-level `_GATES` dict to per-`Run` state, which is the change that makes two simultaneously-gated runs safe.

## 5. Identity and ownership (behind the flag)

**The run server uses the system's existing authentication.** No second login, no
separate credential: the browser already holds a session from the app, and the same
token identifies the caller to the compiled server.

The mechanism, read from `backend/src/Middleware/AuthMiddleware.php`:

- **HS256**, verified against the shared `JWT_SECRET`.
- The user id is the **`sub`** claim, cast to an int — the same `user_id` every
  controller in the app receives.

So the generated server does exactly what the PHP middleware does:

```python
payload = jwt.decode(token, WORKFLOW_API_JWT_SECRET, algorithms=["HS256"])
owner = str(payload["sub"])          # same identity the app uses
```

Resolution order with the flag on:

1. `Authorization: Bearer <token>` verified against `WORKFLOW_API_JWT_SECRET` → owner is `sub`.
2. `WORKFLOW_API_TRUST_HEADER=1` → owner is `X-Forwarded-User`, for a deployment behind
   a proxy that has already authenticated. Secondary, not the normal path.
3. Neither configured → **refuse to start**, naming the variables. Confirmed with the
   owner: in multi-user mode users must be identified, so booting with everyone
   collapsed into one identity is not an acceptable fallback.

With the flag off, the owner is the constant `"local"`, no token is read, and every
route behaves exactly as it does today — byte-identical output.

**Two consequences to build deliberately:**

- **The editor must send its token to the run target when multi-user is on.** The
  current rule is the opposite — the run target never receives `getAuthHeaders()` —
  because the server had no identity. That rule becomes conditional: send the bearer
  token when the compiled server declares multi-user, never otherwise. `workflow.json`
  gains a `multi_user: true|false` field so the editor knows which it is talking to
  before the first run, rather than guessing from a 401.
- **The secret has to reach the server.** It is the app's `JWT_SECRET`, so the runner
  passes it in the child's environment when spawning `api.py`, reading it from the same
  `.env` it already loads for provider keys. A compiled folder handed to someone else
  therefore needs that variable set before multi-user works — which is correct: without
  the app's secret it cannot validate the app's users.

**Token expiry is the app's business.** The run server verifies `exp` as part of
`jwt.decode` and returns 401 on an expired token; the editor already refreshes sessions,
and a run in flight is unaffected because ownership was recorded when it started.

Route scoping when on:

- `POST /runs` records the owner from the dependency.
- `GET /runs/{id}/events` and `POST /runs/{id}/tool-result` return **404, not 403**, for
  a run the caller does not own — the server must not confirm that another user's run
  exists.
- `GET /.well-known/workflow.json` stays unauthenticated: it carries no run data, and
  the editor reads it (including the new `multi_user` field) before it has sent a token.

## 5b. Conversation history

History follows the same key as ownership, so the flag governs both with one rule:
**history is stored per `(owner, thread)`**, where `owner` is `"local"` when multi-user
is off. Flipping the checkbox changes what `owner` resolves to — never how history works
— so there is one storage shape to build and test, and history is useful on a single
laptop as well as on a shared server.

`runs.py` owns the store, because it already owns state keyed by owner:

```python
class HistoryStore:
    def load(owner, thread_id) -> dict | None
    def save(owner, thread_id, state) -> None
    def clear(owner, thread_id) -> None       # the editor's "start fresh"
```

The store treats the payload as **opaque**. That matters because the two architectures
put different things in it and read it differently:

| | Stored per thread | Read by |
|---|---|---|
| Workflow (today) | node outputs, which branch ran, gate answers | the agent whose branch is re-entered — scoped |
| Swarm (separate spec) | one shared message list | whoever is active — in full |

Keeping the payload opaque means neither architecture constrains the other, and the
store needs no change when the second one arrives.

Out of scope here, to be settled when history is implemented: what exactly a workflow
thread carries forward, when a thread expires, and how the editor surfaces "start fresh".

## 5c. Audit trail

**Purpose: debugging, not the UI.** The SSE stream is what the browser renders and is
deliberately lean — a 500-event ring buffer in memory that disappears with the process.
The audit trail is the durable record you read after the fact, and it answers the
question the stream cannot: *what did this node actually receive?*

**A superset of the stream, written by a second sink.** `runs.py` already hands the graph
one sink; it gains a second that appends every event to a file. Because it is a separate
consumer, the audit can record things the stream does not carry, and no protocol change
is needed — `docs/run-protocol-v1.json` stays exactly as it is.

One append-only JSONL file per run:

```
~/Documents/synergyAI/outputs/runs/<workflow>/<YYYYMMDD-HHMMSS>-<run_id>.jsonl
```

Chosen over the current temp file because that one is `unlink`ed when the server stops —
the moment you most want it. Surviving the process is the point.

**What each line carries**, beyond the streamed events:

| Record | Fields |
|---|---|
| `node_enter` | node id, display name, **the framed input verbatim**, its length, the parents it came from |
| `node_exit` | node id, output text, status, elapsed seconds, tokens if the provider reports them |
| `handoff` | from, to, reason/notes — the dispatcher's `route_to` today; every handoff in swarm mode |
| `active` | which agent holds the turn, emitted whenever it changes (swarm) |
| everything already streamed | `round`, `message`, `tool_call`, `tool_result`, `gate_request`, `final`, terminal |

`node_enter` is the one that pays for itself. A node that behaves oddly is usually
receiving something other than what you assumed, and today that framed input exists only
in flight.

**Redaction.** The trail contains prompts, tool arguments and gate answers. Anything the
protocol already marks `sensitive` is written as `"[redacted]"` with its length, matching
how the transcript treats it. A `WORKFLOW_AUDIT=off` env var disables the file entirely
for anyone who wants nothing on disk.

**Ownership and retention.** In multi-user mode the file records the owner, and lives
under that owner's directory, so one user's trail is not casually readable next to
another's. Retention is a count, not a duration — keep the most recent N runs per
workflow (default 50) and delete the rest on start, which bounds growth without a cron
job.

**Why it matters more in swarm mode.** A workflow's path is drawn on a canvas; when it
misbehaves you already know where to look. A swarm's path is decided at run time, so
`handoff` and `active` records are the only way to reconstruct why a message ended up
where it did. The trail is specified here because it is shared machinery, but the swarm
spec is where it earns its keep.

## 6. A2A

The A2A folder reuses `modularApiBlock()` and therefore inherits §4 and §5. Two further pieces are specific to it:

**The orchestrator** carries the same `_SINK`/`_GATES` globals plus `NODE_DURATIONS` and `_RUN_T0`, which would blend two runs' timings into one nonsense summary. All four become per-run state on the `Run` object. `AgentSupervisor` stays shared — one agent fleet serving many runs is correct — and `_ensure_agents` already makes its start once-only.

**The agent servers are the hard part — and they are phase 2**, because what they serialise for is the gate bridge. Each currently does:

```python
_ACTIVE: _NodeRun | None = None   # the run currently executing (one at a time)
_RUN_LOCK = asyncio.Lock()        # the gate bridge relies on a single active run
```

The gate bridge resumes a paused run by consulting `_ACTIVE`. With two workflow runs hitting one agent, that global is ambiguous, and the failure is not a clean error: one run's gate answer could resume the other's task. The agent already keeps `_RUNS[task_id]`, so the fix is to resolve the run from the incoming task's id and delete both `_ACTIVE` and `_RUN_LOCK`.

This is where bugs are most likely, and where §8 concentrates.

## 7. What stays out

- **Durability.** A run lives in memory; a restart loses it. Unchanged from the previous design.
- **Per-user resource limits.** Nothing stops one caller starting fifty runs. Worth revisiting if this ever faces more than a handful of people.
- **Cross-run memory.** Discussed separately; orthogonal to ownership.

## 8. Tests

Phase 1 only — no playbook nodes, therefore no gates. Every test below runs without a
model or an MCP server except where it says otherwise.

### 8.1 `runs.py`, on its own

The reason this file exists separately is that its invariants can be tested with no
graph, no LLM and no HTTP.

- two runs publish concurrently → each subscriber receives only its own run's frames, in
  order, exactly once;
- a run's ring buffer overflows → `since()` reports the gap rather than resuming silently;
- `get(owner, run_id)` returns `None` for a foreign owner, and the same value as `get`
  with the right owner otherwise;
- reaping removes a finished run and never a live one;
- **the import test:** the emitted `runs.py` imports nothing beyond the standard library.
  Written in step 1, not retrofitted — it is the only thing protecting §9.

### 8.2 The generated package, phase 1

Fixture: the dispatcher test workflow — one dispatcher, two dispatched nodes, no
playbook. `_make_llm` stubbed, so no provider is called.

- two runs proceed concurrently end to end; no event crosses between the streams, both
  terminal frames arrive;
- the two runs are made to route to **different** branches, so a crossed sink shows up as
  a node appearing in the wrong stream rather than as a subtle ordering difference;
- each run's `NODE_DURATIONS` reflects only its own nodes;
- a workflow **with** a playbook node still emits `RUN_LOCK` and still serialises (the
  phase-1 boundary, pinned so it cannot regress silently);
- flag off → output byte-identical to today's, pinned the way the single-file target
  already is.

### 8.3 Multi-user, automated

The probe starts the server with a **test** `WORKFLOW_API_JWT_SECRET` — never the real
one — and signs its own tokens with PyJWT (2.13, already in the runner venv; the app
signs HS256 via `firebase/php-jwt`, so the claims match).

- `sub=1` and `sub=2` each start a run; each `GET /events` yields only that user's frames;
- user 2 requests user 1's run id → **404**; same for `tool-result`;
- `workflow.json` → 200 with `multi_user: true`, no token required;
- expired token → 401; token signed with the wrong secret → 401; no token → 401;
- flag off → the same calls succeed unauthenticated, proving the single-user path is
  untouched.

### 8.4 Multi-user, manual — the tester's runbook

The automated probe proves the server. Only a browser proves the chain: that the editor
reads `multi_user` from `workflow.json`, sends the bearer token, and shows each user
their own run. This part is performed by a person; everything it needs is listed first
so nothing is discovered halfway through.

**What must be in place before starting**

| # | Requirement | Why it is needed | How to check |
|---|---|---|---|
| 1 | **Two user accounts** in the app | One account cannot demonstrate isolation — both sessions would be the same owner | Log into each once, separately |
| 2 | **Two browser profiles** — Chrome A + Chrome B, or normal + incognito, or Chrome + Safari | The session token lives in per-profile storage. **Two incognito windows share one Chrome session** and would both carry the same token | Each window shows a different user in the app header |
| 3 | **The runner running**, and left running | It spawns the workflow server and passes `JWT_SECRET` into its environment | `curl -s localhost:8765/health` → 200 |
| 4 | **`JWT_SECRET` readable by the runner** — the app's value, in the `.env` the runner already loads | Without it the server cannot verify the app's tokens and every call is 401 | The server starts instead of refusing (§5) |
| 5 | **The test workflow saved**: a dispatcher and two dispatched nodes, **no playbook node**, branches with visibly different output | A playbook pulls phase-2 gate machinery into a phase-1 test; visibly different branches make a crossed stream obvious rather than subtle | Open it in the editor |
| 6 | **Generated with "Multi-user run server" ticked**, mode *Agents in separate files* | The flag is compiled in; an old package is single-user whatever the browser does | The generated `api.py` contains the identity dependency |
| 7 | **Both windows on the same workflow** | Two different workflows get different servers on different ports and cannot leak into each other — a pass that proves nothing | Same workflow name in both |

**What to do**

1. In **window A**, press Run. The prompt box appears; run it. The overlay opens and the
   badge reads `compiled · 127.0.0.1:<port> · user <A's id>`.
2. While A is still running, in **window B** press Run on the same workflow. B's overlay
   opens with **its own** badge naming B.
3. Watch both. Each overlay should fill only with its own run's nodes. With visibly
   different branch outputs, a crossed stream is immediately obvious.
4. When both finish, check each transcript belongs to the user who started it.
5. **The ownership check — the one that actually proves it.** In window A, open the
   browser's network tab and copy the `run_id` from the `POST /runs` response. In window
   B's console, request it directly:
   `fetch('<base>/runs/<A's run id>/events', {headers:{Authorization:'Bearer '+<B's token>}}).then(r=>r.status)`
   Expected: **404**. Anything else — 200, a transcript, even 403 — is a failure.
6. **Flag-off sanity.** Regenerate with the checkbox cleared and run once in a single
   window. Everything behaves exactly as it does today, no token required.

**What a failure looks like**

- A node from B's branch appearing in A's overlay → crossed event sink (§2 not fixed).
- Both badges naming the same user → the editor is not sending the token, or the server
  is not reading it.
- Step 5 returning 200 or a transcript → ownership is not enforced on the stream route.
- Either overlay hanging with no frames while the other runs → the runs are still
  serialised; `RUN_LOCK` was not removed, or the workflow contains a playbook node
  (which is expected to serialise until phase 2).
- The server refusing to start → `JWT_SECRET` is not reaching it (requirement 4).

### 8.5 Must stay green

- `docs/run-protocol-v1.json` is unchanged by this work — no event is added or altered —
  so `RunProtocolConformanceTest` must pass untouched.
- The existing compiled-server suite (`CompiledRunServerTest`), the modular and A2A
  generator suites, and the runner's pytest suite.
- The 25 pre-existing failures in `tests/Unit` stay at 25, name for name.

## 8b. Delivery order

Confirmed with the owner: **LangGraph first, proved by running it, then one framework at
a time.** Nothing about ADK, MAF or NOOA is built or designed in detail until the
LangGraph phase 1 is working in the editor against the dispatcher test workflow.

1. **LangGraph modular, phase 1** — `runs.py`, per-run sinks, ownership, history, the
   multi-user checkbox. Verified with a real two-user run, not only by tests.
2. **LangGraph A2A, phase 1** — the orchestrator's globals become per-run; the agent
   servers are untouched until phase 2 (they serialise for the gate bridge).
3. **LangGraph phase 2** — playbook gates per run, then the A2A agent servers.
4. **The other frameworks**, one at a time, in the order of §9 — each reusing `runs.py`
   unchanged, which is the only reason this is a small job rather than three.

The one thing that must be right before step 4 begins is that `runs.py` stayed
framework-free. §10's import test is what protects that, and it should be written in
step 1 rather than retrofitted.

## 9. The other targets — planned, not built here

ADK, MAF and NOOA are today **single-file only** (714, 778 and 425 lines for the Dispatcher demo), have **no run server**, and document playbook nodes as NOT RUN. Bringing them to parity means three things each, in this order:

1. **Modular packaging** — the same `<workflow>_modular/` split this repo already does for LangGraph: a graph module, a shared runtime, one file per agent. Mechanical, and the layout is proven.
2. **A run server** — `api.py` emitting the same protocol, reusing **the same `runs.py`**. This is the payoff of keeping that file framework-free: each target needs only the thin part that drives its own graph and feeds the sink. The routes, SSE framing, replay, ownership and gate rendezvous are already written.
3. **A2A packaging**, where the target has a natural agent-server decomposition.

The blocker to be honest about: **gates only exist where playbooks run**, and playbooks do not run in these three. So their first run servers would stream progress and deliver a final result, but have nothing to pause for. The interactive half of the feature arrives only when the playbook runtime is ported to each — a larger job than the packaging, and the right sequencing question to answer before starting.

Recommended order: ADK first (closest runtime model and already the second-most exercised target), then MAF, then NOOA.

## 10. Risks and decisions

- **Removing `RUN_LOCK` removes a safety net.** It has been masking the global sink; delete the global first, then the lock, and let the concurrency tests be the gate.
- **The A2A agent `_ACTIVE` removal is the riskiest change** in the branch. A wrong fix resumes the wrong task, and the symptom is a gate answer appearing in someone else's run — the tests in §8 exist to catch precisely that.
- **Two identity modes could diverge.** Mitigated by the flag-off path being byte-identical to today's output and pinned by a test.
- **`runs.py` must stay framework-free** or §9 collapses into three reimplementations. Enforced by a test asserting the emitted `runs.py` imports nothing beyond the standard library.
