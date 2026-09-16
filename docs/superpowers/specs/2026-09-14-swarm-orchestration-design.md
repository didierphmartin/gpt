# Swarm orchestration — design

Date: 2026-09-14, revised 2026-09-15. Branch: feat/backend-python. Status: draft for review.

**Revision 2026-09-15.** Swarm membership changed from "a Dispatcher node that dissolves" to "the fan-out from Start", after two users independently proposed it on seeing the editor (§3). The same revision adds §3b, the session: a swarm accepts prompts continuously and keeps its active agent and transcript between them, where the first draft treated a swarm as a single run. v1(a) as built implements the turn but not the session.

Second architecture alongside the existing workflow (DAG) compiler. Scope of this spec: **LangGraph, modular packaging only**. The other frameworks are assessed in §9; multi-user and the workflow-mode history feature are separate specs and follow this one.

## 1. What we are building

A workflow drawn on the canvas can be compiled as a **swarm**: agents that hand control to one another, with the conversation carried between them automatically, instead of a fixed graph that decides who runs next.

Four decisions, taken with the owner, define it:

1. **An edge means "may hand off to."** You draw the allowed handoffs; an agent gets one handoff tool per outgoing edge. The topology stays reviewable and a handoff you did not draw is impossible rather than merely unlikely.
2. **The swarm is the fan-out from Start.** The agents connected to the Start node are the members; each gets a handoff tool for the others. There is no router node, nothing is added at compile time and nothing disappears — the drawing and the running system have the same members (§3). The Dispatcher tag stays what it has always been: a workflow-mode router.
3. **A swarm is a session, not a run.** Workflow mode injects one prompt and processes it to completion. Swarm mode is continuous: Start is an input line, prompts arrive one after another, and between them the swarm holds which agent is active and everything said so far (§3b). This is what makes a follow-up land on the right agent with the right context.
4. **Modular packaging only, at first.** Single file and A2A come later, once the semantics are proven.

This is a **bounded swarm**: the behaviour of a swarm, with the set of possible handoffs fixed in advance by the canvas.

## 2. Use `langgraph-swarm`

**Decision: adopt the library.** An earlier draft argued for hand-rolling the pattern on
`Command(goto=…)`; that was wrong, and the package itself settles it. `langgraph-swarm
0.1.0` is **411 lines of pure Python** and supplies precisely what we would otherwise
write:

```python
create_swarm(agents: list[Pregel], default_active_agent, state_schema=SwarmState)
create_handoff_tool(agent_name, description)
add_active_agent_router(...)        # entry routing from the persisted active_agent
class SwarmState(MessagesState):    # messages + active_agent
```

The objections that did not survive inspection: a dependency this small is not a cost
worth engineering around; `state_schema` is a parameter, so our fields extend `SwarmState`
rather than collide with it; and `active_agent` checkpointed in state under our own
`thread_id` is the behaviour we want, not a loss of control.

**Pinned** as `langgraph-swarm>=0.1,<0.2` in the runner requirements and in the generated
package's docstring. At 0.1.0 the API may move; the version pin plus §8's tests are the
guard, and the surface we depend on is three functions.

**What we still write ourselves:**

- **Handoff tool descriptions**, built from each target's display name so the model names
  a colleague rather than an id (`create_handoff_tool` takes a description).
- **Audit records.** Each handoff tool is wrapped so the `handoff` record — from, to,
  reason — reaches the audit sink; the library does not know about our trail.
- **The hop budget** (§3), which the library does not impose.

**The one structural change to agent modules.** `create_swarm` takes agents as `Pregel`
objects — what `create_react_agent` returns. Our modules build that *inside*
`run_node(request, trace)` and hand back text. In swarm mode a module exposes the compiled
agent instead, with its MCP tools, skills and provider settings unchanged. Mechanical, and
required under any approach.

## 3. Canvas semantics

**The swarm is what you drew from Start.** In swarm mode the agents fanned out from the
Start node *are* the swarm. There is no router node and nothing disappears at compile time:
the drawing and the running system have the same members.

| Canvas element | Workflow mode (today) | Swarm mode |
|---|---|---|
| Start → A, B, C (fan-out) | A, B and C run concurrently | A, B and C **are the swarm**; the session's first prompt goes to the first of them |
| Edge A → B | B runs after A | A gets a handoff tool for B |
| Dispatcher node | one forced `route_to`, one child runs | **refused** — a swarm routes itself, so there is nothing for a dispatcher to do (§3a) |
| Agent node | runs once when reached | an agent that may hold the turn any number of times |
| Output node | collects parents' outputs | where the current answer is shown |
| Playbook node | the playbook runtime, with gates | **not supported in v1** — see §7 |

The members form a mesh: each can hand to any other. Two consequences follow, and both are
refusals or no-ops rather than special cases. An edge drawn *between* members **adds nothing
and is ignored** — everyone can already reach everyone, so the drawing is redundant, not
wrong. An agent connected to a member but **not** to Start is **refused**: admitting it
would make it reachable through one parent only, which is a partial mesh, and absorbing it
fully would make the edge the user drew mean exactly what `Start → that agent` already
means.

**Why the fan-out, and not a dispatcher.** An earlier draft of this spec had swarm mode
built around a node tagged Dispatcher that dissolved at compile time — you drew three
nodes and got two. Shown the editor, two users independently proposed the fan-out instead.
They were right, and the reason is worth recording: a drawing whose parts vanish is a
drawing you have to be taught to read. Start already means "this is where the prompt goes",
so "the agents on the other end of Start" is the swarm with no further explanation. It also
returns the Dispatcher tag to meaning exactly one thing, in exactly one mode.

**Every agent is told who its colleagues are.** In a workflow the routing knowledge belongs
to the dispatcher alone, because only the dispatcher routes. In a swarm any member may
branch, so that knowledge travels with the handoff tools. Each agent with colleagues gets a
generated block appended to its instructions:

```
## Colleagues you can hand this to
- Human resources — leave, PTO, payroll, personal matters
- IT claims — passwords, network access, technical support

Hand off when the request is theirs rather than yours; say why in the reason.
Answer directly when it is yours. Do not hand back what you were just handed
unless the subject has genuinely changed.
```

Each line's description is the target agent's **own** role summary — the first line of its
own instructions. There is no separate routing document and no shared "when to hand off"
prose: an agent that describes its own job well is already telling its colleagues when to
send work its way. This is the one capability the dissolved dispatcher used to supply, and
dropping it is deliberate; if real sessions route badly we add a shared guide then, with
evidence, rather than designing one now.

The last line of the block matters: without it two agents can volley the same request back
and forth until the hop budget ends the turn.

**Termination — a turn ends, a session does not.** These are different events and an
earlier draft conflated them, which is the kind of error that reaches the code.

- A **turn** ends when the agent holding it replies without calling a handoff tool. That
  reply is the answer to the prompt that started the turn. A hop budget (default 25
  handoffs) ends a turn that ping-pongs, with `status: "hop_budget_exhausted"` — the
  structural guarantee a DAG gets for free and a swarm does not.
- A **session** ends when the user closes it. Nothing the agents do ends a session.

### 3a. What swarm mode refuses

**Nothing here changes workflow mode.** Every pattern — fan-out, fan-in, chains,
dispatchers — keeps its current meaning when `orchestration = "workflow"`, which is the
default and what every existing workflow is.

| Canvas | Why it cannot be a swarm |
|---|---|
| Start connected to fewer than two agents | A one-agent swarm has nobody to hand to |
| Contains a node tagged Dispatcher | A swarm routes itself; the tag belongs to workflow mode. Connect the agents to Start directly |
| An agent not connected to Start | It is not in the swarm. Connect it to Start, or remove it |
| More than one Output node | A session shows one answer at a time |
| Contains a playbook node | Gates plus handoffs is unresolved in v1 (§7) |

Five refusals, where the dispatcher-based draft had seven. Three disappeared with the
dispatcher — "no dispatcher", "dispatcher with one child" and nested dispatchers, all
artefacts of requiring a node that no longer exists. A fourth, fan-in/merge, disappeared
with the full mesh: once every member can hand to every other, nothing arrives anywhere, so
there is nothing to merge. Two took their place: the Dispatcher tag itself, and an agent
that is not connected to Start.

**The error is a lesson, not a rejection.** It names what was found, what is needed, and
draws the target:

```
This workflow cannot run as a swarm.

Found:     "Newspaper Publisher" — Start is connected to one agent.
Needed:    Start connected to two or more agents.

A swarm looks like this:

      Start
     ╱  │  ╲
    ▼   ▼   ▼
   HR  IT  Devices      ← the swarm: each can hand to the others

The prompt you type goes to whichever agent is holding the turn.
```

### 3b. The session

This is the part that distinguishes swarm mode from a run, and the part an earlier draft
missed entirely.

**Workflow mode injects a prompt once.** You press Run, the graph processes that prompt to
completion, and the run is over. A second prompt is a second run with no memory of the
first.

**Swarm mode is continuous.** The Start node is an input line, not a trigger. You type a
prompt, it lands on whichever agent is currently active, that agent answers or hands off,
and then you type the next one. The swarm sits between prompts holding two things:

| Session state | What it is for |
|---|---|
| `activeAgent` | which member holds the turn, so the next prompt goes there rather than back to the beginning |
| `transcript` | every turn so far, as `{role, content}`, handed to whichever agent takes the next turn |

Those two together are what make a follow-up work. *"Make it 5 days"* is a **second
prompt**: it reaches HR because HR was active when the previous turn ended, and it makes
sense to HR because the transcript carries what the 5 days refer to. Sharing a transcript
only *within* one turn buys none of that — it is the session that matters.

- **The first prompt of a session** has no previously active agent, so it goes to the first
  agent connected to Start. The order is the canvas order, so it is stable and visible.
- **Every later prompt** goes to the agent that ended the previous turn.
- **Closing the session** discards both. Reopening starts a fresh conversation.

**v1(a) needs no storage for this.** The session lives in the editor, in memory, for as
long as it is open — the same place the rest of the run state lives. Persisting a session
across a page reload, or across the compiled server's restart, is the checkpointer question
in §5, and it is staged separately.

## 4. The generated package

Same layout as the workflow target, one file different:

```
workflow.py   the swarm: state, handoff tools, graph wiring, entry, CLI
common.py     unchanged — stateless runtime
runs.py       unchanged — run registry, sinks, history store, audit
api.py        unchanged — the run server
agents/*.py   one agent each: NODE + the compiled agent (swarm) / run_node (workflow)
```

**State** extends the library's schema rather than replacing it:

```python
class SwarmState(_SwarmState):        # messages + active_agent from langgraph-swarm
    handoffs: Annotated[list, operator.add]   # [{from, to, reason}] — audit and re-entry
```

**Handoff tools** come from `create_handoff_tool(agent_name=<target display>, description=…)`,
one per drawn edge, each wrapped to emit the audit record before returning the library's
`Command`.

**Graph** is `create_swarm(agents, default_active_agent=<entry agent>, state_schema=SwarmState)`,
compiled with the checkpointer (§5). `add_active_agent_router` inside the library handles
resuming a thread with whoever held the turn — the behaviour §5 depends on.

**What is reused unchanged:** the MCP tool builder, the skills runtime, the provider
factory, the run server, the event protocol and every agent's `NODE` definition. A swarm
differs in who is called next, not in what an agent is.

**What differs, and only here:** the agent module's export. In workflow mode it exposes
`run_node(request, trace)` — run this node on this text, return text. In swarm mode it
exposes the **compiled agent** plus its handoff tools, because the library composes
`Pregel` objects into one graph. Both are emitted from the same node facts, so the two
architectures share everything except this one function per module.

## 5. Conversation history — the property that matters

This is the reason swarm was asked for, so it is not optional here: **a swarm carries its conversation automatically.**

- The shared `messages` channel *is* the history. An agent taking the turn sees what was said before, including the other agents' replies and tool results. Nothing has to be re-framed at a handoff, and nothing is lost in one.
- Persistence is a **checkpointer keyed by thread**: `graph.compile(checkpointer=…)`, invoked with `{"configurable": {"thread_id": f"{owner}:{thread}"}}` — the same `(owner, thread)` key the history store uses, so swarm and workflow threads live side by side without a second scheme.
- `active_agent` is checkpointed with the messages, so a follow-up resumes with the agent that handled the last turn. This is what makes *"actually make it 5 days"* reach HR without anyone re-routing it.

**A session is required from v1(a); only its *persistence* is staged.** These are different
things, and an earlier draft ran them together — it listed "one prompt, handoffs, an answer"
as the whole of v1, which is a turn, not a session (§3b). Multi-prompt continuity is the
feature, not an enhancement to it.

What differs between the two paths is only where the session is kept:

| Goal | What is required |
|---|---|
| A session in the editor's interpreter — **v1(a) and the test workflow** | nothing: the active agent and transcript live in memory for as long as the overlay is open |
| A session in the compiled server, while it is up | `MemorySaver`, in-process, zero configuration |
| A session surviving a reload, a restart, or shared across servers | a database |

So v1(a) ships with an in-memory session and no checkpointer at all, `MemorySaver` is the
compiled path's one-line equivalent, and the database is a separable step taken when a
session must outlive a process. The generated code is written so the saver is a single
injection point, not a shape the graph depends on.

**When a database is wanted, it is the MySQL the app already uses.**
`langgraph-checkpoint-mysql 3.0.0` exists and fits: `AIOMySQLSaver` over the `aiomysql`
extra, matching the async server. It creates and migrates five tables itself —
`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`, `store`.

Three consequences, to settle when that step is taken rather than now:

1. **Which schema owns those five tables.** They are the library's, migrated by the
   library. Recommendation: a dedicated schema, not the app's — compiled output should not
   become a schema owner alongside users and agents.
2. **Hold the connection open.** A checkpointer writes every turn, and fresh connections to
   the CONTEXTS database are known to stall for minutes here; the saver is opened once at
   startup and pooled, so a stall costs one slow start rather than a frozen conversation.
3. **The folder stops being self-contained** when a DSN is configured. Environment decides,
   as with identity: `WORKFLOW_CHECKPOINT_DSN` → MySQL; unset → SQLite beside the package
   (`langgraph-checkpoint-sqlite 3.1.1`); neither → in-memory, with the docstring saying
   plainly that history dies with the process.

**The cost, stated plainly.** Every turn carries the whole conversation. Token cost grows with conversation length rather than with the work done, and a long thread eventually meets the model's context limit. This is the opposite of the lean-node property the workflow target was tuned for (16.5s → 10.9s), and it is inherent to the architecture, not a defect. Mitigation is deferred: a summarisation step when a thread exceeds a configurable message count, specified only when a real thread gets long enough to need it.

## 6. Run server, protocol and audit

The server, the SSE stream and `docs/run-protocol-v1.json` are **unchanged**. A swarm emits the same events: `round` per turn, `message` per agent reply, `tool_call` / `tool_result`, `final` at the end.

The **audit trail** (concurrency spec §5c) is where swarm earns its records, and both its swarm-specific rows now carry weight:

- `handoff` — from, to, reason — reconstructs a path that no canvas can show, because it was decided at run time;
- `active` — who holds the turn, written whenever it changes;
- `node_enter` — what the agent actually received, which in a swarm is the shared conversation rather than a framed input.

### 6b. Cases the canvas raises

Five situations the drawing permits, each needing a decision rather than an accident.

**Skills on a swarm agent — run only on the turn that ends the run.** In workflow mode a
skill is a mandatory post-agent step: the agent produces text, the skill turns it into the
deliverable. In a swarm a turn does one of two things, and only one of them produces a
deliverable:

| The turn | Skills |
|---|---|
| hands off | **do not run** — there is no deliverable yet, and a layout or document skill on an intermediate handoff is wasted work and a wasted LLM call |
| answers without handing off | **run**, on that reply, and the result is the run's output |

The skills that run are those of the **agent that answered**, not of every agent that held
the turn. A skill belongs to the agent that produced the deliverable. If the hop budget
ends a run, no turn answered, so no skill runs and the output is the budget message.

**Start-node attachments — into the shared conversation.** Documents dropped on Start are
converted to Markdown and prepended to the first human message. Because that message is in
the shared channel, **every agent that later holds the turn sees them** — which is the
behaviour you want: an attachment is context for the conversation, not for whoever happens
to go first. It also needs no special mechanism; it falls out of the swarm's shared state.

The cost is worth stating: a swarm's context grows with the conversation anyway, and
attachments make it start large rather than grow into it. A canvas with attachments above
a threshold warns at flip time, pointing at the same summarisation question §5 defers.

**A member's own children — part of the swarm.** An agent connected to a swarm member but
not to Start joins the swarm through its parent: it is a member, and it is reachable only
from the agent that points at it. The member walk is transitive, so a chain A → C → E puts
all of A, C and E in the swarm; stopping at one level would leave E as a handoff target
with no agent behind it.

**More than one Output node — refused in v1.** A swarm produces one final answer, from the
turn that stopped handing off. Two outputs would need a rule for which receives it, and
inventing one before anyone wants it is guessing. Refused, naming both.

**Swarm with multi-user — already aligned, and worth pinning.** The concurrency spec keys
history by `(owner, thread)`; a swarm's checkpointer is invoked with
`thread_id = f"{owner}:{thread}"`. So a swarm thread is owned exactly like a run, one
user's conversation is invisible to another, and no second scheme is needed. The seam gets
one test rather than a design: two owners, one workflow, same `thread` value, and neither
sees the other's messages.

## 7. Out of scope for v1

- **Playbook nodes in a swarm.** Gates plus handoffs is a combination worth understanding separately; a playbook agent inside a swarm raises "who holds the turn while a human is being asked?", and nothing answers that yet. The compiler rejects a swarm canvas containing a playbook node, naming it.
- **Single-file and A2A packaging.** A2A swarm is genuinely interesting — handoffs crossing the network between agent servers — and genuinely novel; it waits until the in-process semantics are proved.
- **Multi-user.** Its own spec, which this one is deliberately compatible with: the checkpointer key already begins with the owner.
- **Summarisation of long threads** (§5).

## 8. Tests

Staged as the work is (§10): the interpreter first, the compiler second. The subject in
both cases is the owner's swarm test workflow — **Start fanning out to two agents**, no
dispatcher, no playbook, with visibly different outputs per branch.

### 8.1 The rewrite — shared fixture, both implementations

A JSON fixture of canvases in and expected rewritten graphs out, run by the PHP suite and
by a JS check, so the two implementations (§10) cannot diverge. This file is the contract:
a change to it must make both sides pass or neither.

- Start → 2 agents → 2 members, mesh A↔B;
- Start → 3 agents → 3 members, full mesh (A↔B, A↔C, B↔C);
- each member's composed instructions = its own prompt + the colleague list, where each
  colleague line is **that colleague's own** role summary;
- a member's edge to an agent not connected to Start extends the swarm to it, transitively,
  so no handoff target is ever missing from the member set;
- the first agent connected to Start is the session's first responder, deterministically,
  across repeated runs;
- ordering is by node id in both languages, never by insertion order — PHP preserves
  insertion order and JS does not, and a divergence there is a defect even when each side
  is individually defensible;
- duplicated and self-referential edges change nothing: a doubled Start→A edge does not make
  a one-agent swarm legal, and a self-edge does not give an agent a handoff to itself;
- **every refusal in §3a**, each naming the offending nodes: Start with fewer than two
  agents; a node tagged Dispatcher; fan-in/merge; two Output nodes; a playbook node.

Beyond the fixture's own assertions, the two implementations are diffed **whole**: the full
rewrite output of every case, through both languages, compared byte for byte — including
the composed instruction text the fixture only spot-checks. Truncation, trimming and sort
tiebreaks have all diverged between the two in practice; only a whole-output diff catches
that class.

### 8.2 v1(a) — the interpreter

The session is the thing under test, and it cannot be reached by the rewrite's fixture.

- **A turn**: the active agent answers without handing off → the turn ends, that reply is
  the answer, and only that agent's skill runs.
- **A handoff**: the active agent calls the handoff tool → control moves, and the agent
  that hands off runs no skill, because it produced no deliverable.
- **The session, which is the point**: prompt 1 goes to the first agent connected to Start;
  it hands to B; prompt 2 goes to **B**, not back to A, and B's call carries a transcript
  containing prompt 1 and the handoff. This is the *"make it 5 days"* case, and it is a
  two-prompt test — a single-prompt test cannot distinguish a working session from a broken
  one.
- **Every call carries a non-empty message.** The backend rejects an empty message unless
  the last history entry is a tool result, which a swarm transcript never is. This is worth
  its own assertion because it is exactly the assumption that broke the first build.
- **The hop budget** terminates two agents that hand to each other forever, at the budget,
  with `hop_budget_exhausted` and no skill run.
- **Closing a session** discards the active agent and the transcript; the next session
  starts at the first agent again.
- **Workflow mode is unchanged.** Every existing workflow runs exactly as before. The
  shared per-node execution path is on both modes' hot path, so any option added for the
  swarm must default to today's behaviour, and that default is asserted.

These are drivable with a stubbed per-node executor returning a scripted sequence — hand
off, hand off, answer — which is how the loop gets tested without live LLM calls.

### 8.3 v1(b) — the compiler

Everything in 8.2, against the generated package with `_make_llm` stubbed, plus:

- the emitted package contains one agent module per swarm member and no router module;
- `create_swarm` is called with `default_active_agent` = the first agent connected to Start;
- **workflow-mode output is byte-identical** to today's for single-file, modular and A2A —
  swarm is a new emit path and must not disturb the existing ones (the current pins cover
  this).

### 8.4 Persisting a session — only when it is built (§5)

The session itself is v1(a) and is covered in 8.2; what is staged is making it **survive**
a reload or a restart. Not part of v1: an in-memory session needs no checkpointer.

- two turns on one thread after a restart: the second turn's agent sees the first turn's
  messages;
- the second turn begins with the agent that ended the first, restored from the
  checkpointer rather than reset to the first responder;
- two threads do not see each other's messages;
- with a persistent checkpointer, a thread survives a process restart;
- with multi-user, two owners using the same `thread` value see nothing of each other
  (§6b's seam test).

### 8.5 Manual, by the owner

Run the swarm test workflow and confirm, in order:

1. The **first agent connected to Start** takes the first prompt.
2. Ask something belonging to the other agent: a handoff happens and the overlay names both
   agents and the reason.
3. **Send a second prompt that only makes sense given the first** — *"make it 5 days"*. It
   must land on the agent that just answered, and that agent must understand it without
   being told the context again. This single step is the whole point of the feature; if it
   fails, nothing else passing matters.
4. The context display for each agent shows its own prompt plus the labelled colleague list.
5. Close and reopen the session: it starts fresh, at the first agent, with no memory.
6. Switch the same canvas to `workflow` mode and run it: Start's fan-out runs concurrently,
   one prompt, one result — so the difference between the modes is visible on one drawing.

## 9. The other frameworks

Assessed against the installed packages, not from memory.

| Framework | Handoff primitive | Conversation history | Verdict |
|---|---|---|---|
| **LangGraph 1.2.7** | `Command(goto=…)` — hand-rolled per §2 | checkpointer per thread | ✅ this spec |
| **Google ADK 2.3.0** | agent transfer with sub-agents (`transfer_to_agent`) | `InMemorySessionService` + `InMemoryMemoryService` — sessions and memory are framework features | ✅ **port first.** The closest fit of the three; history is built in rather than assembled |
| **Microsoft Agent Framework 1.10.0** | `HandoffBuilder`, `HandoffConfiguration`, `HandoffAgentExecutor`, `clean_conversation_for_handoff` — a purpose-built handoff orchestration | `InMemoryHistoryProvider` ("stores messages in session.state"), `FileCheckpointStorage` | ✅ **supported**, but note: the current MAF generator emits `WorkflowBuilder`/`Executor`/`add_edge`. Swarm mode targets a *different* MAF API, so it is a new emit path rather than an extension of the existing one |
| **NVIDIA NOOA 0.0.8** | **none** — `Agent(llm, truncation, render_config, context, event_query, storage)`, no sub-agents, no transfer, no orchestration module | context blocks + storage + a summarization helper, so history alone is feasible | ❌ **not a swarm target.** Multi-agent handoff would have to be written from scratch — a loop deciding who is active and interpreting output as a handoff — sharing no semantics with the other three, on an API at 0.0.8 that is likely to move. Recommendation: the architecture selector greys swarm out for NOOA, the way Single file greys out the multi-user checkbox. Revisit if NOOA grows multi-agent primitives |

Order: LangGraph (this spec) → ADK → MAF → NOOA excluded.

## 10. Where the setting lives, and the live interpreter

**Architecture is a property of the workflow, not of the build.** Packaging (single file /
separate files / A2A) answers "how do we ship this"; architecture answers "what does this
drawing mean". The same canvas is a pipeline or a swarm depending on it, and the **live
interpreter needs to know it just as much as the compiler does** — so it is stored with
the workflow, beside `output_storage_enabled` and friends:

```
workflow.orchestration = "workflow" | "swarm"      default "workflow"
```

Set in the workflow's settings panel in the editor, where it is visible while you draw —
which matters, because the same canvas is legal under `workflow` and may be refused under
`swarm` (§3a), and because the same fan-out from Start means two different things under the
two modes.

The code-generation modal keeps **packaging and multi-user only**, and shows the
architecture read-only so there is one source of truth:

```
Architecture:  Swarm            ← from the workflow's settings, not editable here
Packaging:     ( ) Single file        ← greyed out for Swarm in v1
               (•) Agents in separate files
               ( ) A2A                ← greyed out for Swarm in v1
  [ ] Multi-user run server
```

`{mode, multiUser}` stays in `wf:<id>:codegen`; `orchestration` is persisted on the
workflow row and travels with it — export, import, and every compile target read the same
value. The Run menu item names both: `Run (swarm · separate files)`.

**Order reversed on the owner's call: the interpreter goes first.** The earlier draft
sequenced the compiler first, on the grounds that `langgraph-swarm` would supply proven
semantics. That was the wrong instinct. The risky part of this design is not execution but
**interpretation** — which agents are members, mesh synthesis, colleague-list composition,
which canvases are refused, and how a session carries its state from one prompt to the next
— and the interpreter exercises exactly those with the fastest feedback and the
least scaffolding: press ▶ and watch, with no Generate, no runner, no spawned server, no
files. The compiler would validate the same rules through the slowest possible loop.

It is also the smaller step: no `langgraph-swarm`, no run server, no checkpointer, no
multi-user.

**v1(a) — the interpreter**

1. `workflow.orchestration` persisted on the workflow row, set in the editor's settings
   panel.
2. **The rewrite**: members are Start's fan-out plus whatever they reach, synthesise the
   mesh, compose each agent's colleague list, validate the pattern (§3a) — a pure
   `graph → graph` function, defined once and pinned by a shared fixture.
3. **The turn**: handoff tools per agent, loop while a handoff is returned, hop budget,
   skills only on the turn that answers.
4. **The session**: a persistent active agent and transcript, and a surface that keeps
   accepting prompts (§3b). This is the half an earlier draft missed, and it is the half
   the feature is judged on.
5. The owner runs one canvas in both modes, and sends a **second** prompt in swarm mode.

**v1(b) — the LangGraph compiler**, built against rules already validated in (a), then the
other frameworks (§9).

**The risk this ordering introduces, and its mitigation.** The interpreter's loop is
hand-written, so the compiler must later agree with it — the same drift risk, inverted.
Mitigation: the rewrite is defined **once**, as a pure function with a shared fixture both
paths are tested against. One implementation, server-side in the analyzer, with the editor
requesting the effective graph when `orchestration = "swarm"`; the alternative (JS for the
interpreter, PHP for the compiler) is two implementations of the one rule this design
turns on.

**Where the rewrite lives: both sides, one fixture.** The compiler must have it in PHP —
it emits from there. The editor must have it in JS — the visual feedback below updates as
you draw, and a round trip per canvas edit is the wrong trade. So it is implemented twice,
as a pure `graph → graph` function of perhaps fifty lines, and pinned by a **shared JSON
fixture**: canvases in, expected rewritten graphs out, run by both the PHP test suite and a
JS check. The same discipline `run-protocol-v1.json` already applies to three
implementations of the event protocol. A round-trip endpoint was considered and rejected:
it buys one implementation at the cost of latency on every edit and a failure mode while
drawing.

### Visual feedback — both modes

Swarm mode still shows less than it runs — handoffs nobody drew, a prompt assembled from
two places, and an active agent that moves. None of that may be invisible. The fan-out
shape removes the worst of it: there is no longer a node on the canvas that does not run.

**On the canvas, in swarm mode:**

- the **synthesised mesh is drawn**, distinctly from edges the user drew (dashed, say), so
  A↔B is visible rather than implied;
- the **active agent is marked** during a session, because "where does my next prompt go"
  is the one question a swarm raises that a DAG never does;
- a canvas the mode refuses is marked **when the session opens**, not when the setting is
  flipped — flipping the toggle states an intention and makes no claim about a canvas that may
  not be drawn yet, so it never refuses; the refusal names the offending nodes when the user
  actually acts on the mode.

**In the agent's context display — the important one.** Wherever the editor shows an
agent's prompt, swarm mode shows the **composed** context, because that is what the model
will actually receive:

```
┌─ Human resources — context (swarm) ─────────────────────┐
│ System prompt                            [editable]     │
│   You are the HR specialist at Intact…                  │
│                                                          │
│ ── appended in swarm mode ──────────────  [read-only]   │
│ ## Colleagues you can hand this to                       │
│ - IT claims — passwords, network access, support         │
│ - Devices management — repairs, laptops, tickets         │
│ Hand off when the request is theirs rather than yours…   │
│ Answer directly when it is yours.                        │
└──────────────────────────────────────────────────────────┘
```

The agent's own prompt stays editable; the appended block is read-only and labelled, so its
source is never a guess. Each colleague line is that colleague's own role summary, which
means an agent's description of itself is what its teammates read — worth showing, because
it makes a vague first line visibly costly. Switch the workflow back to `workflow`
mode and the block disappears — the same display then shows exactly what runs there too.

This is the editor-side twin of the audit trail's `node_enter` record (concurrency spec
§5c): one shows what an agent *will* receive, the other what it *did*.

**Why the interpreter carries this well.** `runWorkflow()` / `_runNodeAsChatUnit()` already
executes agents with tools, already handles routing through `dispatchTargets`, and already
streams into the run overlay. A turn is *less* machinery than the DAG it runs today:
handoff tools on each agent, a loop while a handoff is returned, and the member set from
§3. What is genuinely new is the session — state that outlives a single press of Run — and
that has no precedent in either run path.

**The surface.** A session needs somewhere to keep accepting prompts. That is the existing
**run overlay**, with a prompt box at its foot — not a new pane. The overlay already shows
the per-node trace this design insists on, and already knows how to render input cards from
the playbook gate work. A second conversational surface in the same product would be the
wrong trade, and the trace and the conversation belong in one place anyway.

Two consequences follow, and both contradict how a DAG run ends:

- **The results modal is not the terminus.** A swarm produces a conversation, not "the
  workflow output". A turn's answer is shown in the overlay; what, if anything, gets saved
  as a workflow output is the last answer of a session, not each turn's.
- **"Run" is the wrong verb.** In swarm mode the control opens a session. The Run menu item
  reads accordingly.

**What v1(a) must not make harder.** Two obligations toward the compiler in v1(b):

1. `orchestration` is stored on the workflow row, so both paths read one value.
2. The rewrite is a pure `graph → graph` function pinned by a shared fixture, implemented in
   PHP for the compiler and JS for the editor, and **diffed whole** between the two (§8.1).
   Which agents are members and how a colleague list is composed is then decided once, for
   both paths, rather than twice with a drift risk.

## 11. Risks and decisions

- **The checkpointer owns five tables** (§5). `langgraph-checkpoint-mysql` migrates its own schema, so the generated server becomes a schema owner wherever it points. Recommendation: a dedicated schema, not the app's. Decide before building.
- **A stalled connection stalls a conversation** (§5). The checkpointer writes every turn, and this deployment has a history of fresh connections hanging; the saver is opened once and pooled for exactly that reason.
- **Context growth is inherent** (§5). Not a bug to fix in v1, but it will be the first complaint on a long thread, and the mitigation should be specified before it is met rather than after.
- **Two architectures in one generator.** The analyzer and every shared emit helper now serve both. The guard is that swarm is a new emit path and the workflow output is pinned byte-identical.
- **A canvas means two different things** depending on the selector — but the overlap is narrower than it first looks, and users report the remainder reads naturally. `Start → one agent` is unambiguous by construction: it is the ordinary workflow opening, and swarm mode refuses it outright (`start_needs_two_agents`). Only `Start → two or more` is legal under both, meaning "run these concurrently" in workflow mode and "these are the swarm" in swarm mode. Users shown the editor reported reading a fan-out from Start as a swarm and a single link as a workflow, which is the mapping this design already has. Treat that as a report rather than a measurement — it has not been checked against the real workflow corpus, which lives in the database. This is accepted rather than mitigated away, because the alternative — a shape that is only legal in one mode — is what the dispatcher draft did, and two users rejected it. The mitigations are that the mode is an explicit workflow-level setting, the Run item names the architecture, the canvas marks the synthesised mesh and the active agent (§10), and a canvas invalid as a swarm is refused at flip time rather than at Run.
- **The mode semantics were validated with users, the surface was not.** The fan-out shape came from showing the editor to two people, and the two-mode reading was then checked back with them and confirmed: a fan-out from Start distributes the prompt to every connected agent in workflow mode, and in swarm mode names the members while the prompt goes to one active agent that changes by handoff. The implicit default active agent — the first agent connected to Start — was confirmed in the same pass. That is real evidence for the canvas semantics and none at all for the session surface.
- **Two users, one sample.** The shape came from showing the editor to two people, not from testing it. It is a better shape by the arguments in §3, but "clearer to two users who saw a canvas" is weaker evidence than it sounds, and the owner's manual pass (§8.5) is the first real use. Expect the session surface, not the canvas shape, to be what needs revision.
- **`langgraph-swarm` is at 0.1.0.** A pre-1.0 dependency on the critical path; pinned `>=0.1,<0.2`, and the surface used is three functions, so a breaking release is a contained fix rather than a rewrite. The 411-line source is small enough to vendor if the project ever stalls.
