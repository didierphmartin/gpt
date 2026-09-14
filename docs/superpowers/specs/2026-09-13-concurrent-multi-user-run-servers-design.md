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

## 8. Testing

`runs.py` is testable without a model, an MCP server or a graph — that is the main reason it exists as its own file.

**Unit (`runs.py` alone):**
- two runs publish concurrently; each subscriber receives only its own run's frames, in order, exactly once;
- two runs block on gates simultaneously and are answered **out of order**; each resumes with its own answer;
- an answer for run A's `tool_call_id` presented to run B resolves nothing;
- `get(owner, run_id)` returns None for a foreign owner;
- reaping removes finished runs and never a live one.

**Generated modular package (phase 1 — dispatcher + two dispatched nodes, no playbook):**
- two runs of that workflow proceed concurrently end to end (LLM stubbed at `_make_llm`), asserting no event crosses between streams, both terminal frames arrive, and each run's `NODE_DURATIONS` reflects only its own nodes;
- the two runs route to *different* branches, so a crossed sink would show up as a node appearing in the wrong stream;
- with the flag on: an unowned `GET /events` is 404; an unowned `tool-result` is 404; `workflow.json` stays 200 without a token;
- with the flag off: output byte-identical to today's (pinned, as the single-file target already is).

**A2A:** two runs against one agent fleet, both parked on gates at the same agent, answered out of order — the case `_ACTIVE` cannot express.

**Two-user verification — automated.** A probe that starts the generated server with a
**test** `WORKFLOW_API_JWT_SECRET` (never the real one) and signs two tokens itself,
`sub=1` and `sub=2`, with PyJWT:

- both users start a run; each `GET /events` returns only that user's frames;
- user 2 requests user 1's run id → **404**, and the same for `tool-result`;
- `workflow.json` answers 200 with `multi_user: true` and no token;
- an expired token → 401; a token signed with the wrong secret → 401;
- with the flag off, the same probe's unauthenticated calls all succeed, proving the
  single-user path is untouched.

`PyJWT 2.13` is already installed in the runner's venv, so the emitted server adds no
new dependency to install; `pyjwt` joins the requirements line in the generated
docstring for anyone deploying the folder elsewhere. The app signs with
`firebase/php-jwt` HS256, which PyJWT verifies natively — same algorithm, same claims.

**Two-user verification — manual, and it is the part that matters.** The automated probe
proves the server; only a browser proves the whole chain. What the human pass adds:

- **two real accounts, in two browser profiles** (or one normal and one private window) —
  the session token lives in per-profile storage, so two tabs of one profile are the same
  user and test concurrency, not isolation;
- each user runs the dispatcher test workflow at the same time and sees only their own
  overlay filling in;
- the editor is actually sending the bearer token — visible as the run surviving at all,
  since without it the server answers 401;
- and the negative case worth trying deliberately: copy a run id from one profile's
  network tab, ask for it from the other, and confirm 404 rather than someone else's
  transcript.

**Conformance:** `docs/run-protocol-v1.json` is unchanged by this work; the existing test must stay green, since none of this adds or alters an event.

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
