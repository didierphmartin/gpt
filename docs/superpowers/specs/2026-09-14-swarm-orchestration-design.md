# Swarm orchestration — design

Date: 2026-09-14. Branch: feat/backend-python. Status: draft for review.

Second architecture alongside the existing workflow (DAG) compiler. Scope of this spec: **LangGraph, modular packaging only**. The other frameworks are assessed in §9; multi-user and the workflow-mode history feature are separate specs and follow this one.

## 1. What we are building

A workflow drawn on the canvas can be compiled as a **swarm**: agents that hand control to one another, with the conversation carried between them automatically, instead of a fixed graph that decides who runs next.

Three decisions, taken with the owner, define it:

1. **An edge means "may hand off to."** You draw the allowed handoffs; an agent gets one handoff tool per outgoing edge. The topology stays reviewable and a handoff you did not draw is impossible rather than merely unlikely.
2. **A dispatcher node dissolves.** A swarm routes by itself, so the dispatcher is scaffolding: it is not compiled as an agent. Its children become the swarm, wired to each other, and its system prompt becomes the handoff guide every member carries (§3b).
3. **Modular packaging only, at first.** Single file and A2A come later, once the semantics are proven.

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

| Canvas element | Workflow mode (today) | Swarm mode |
|---|---|---|
| Edge A → B | B runs after A | A gets a `transfer_to_B` tool |
| Start → X | X is the first node | X is the **entry agent** |
| Dispatcher node | one forced `route_to`, one child runs | **dissolved** — not an agent; its children become a mesh and its prompt becomes their shared handoff guide (§3b) |
| Agent node | runs once when reached | an agent that may hold the turn any number of times |
| Output node | collects parents' outputs | where the final answer is delivered when no agent hands off |
| Playbook node | the playbook runtime, with gates | **not supported in v1** — see §7 |

**Every agent that can hand off is told how to.** In a workflow the routing knowledge
belongs to the dispatcher alone, because only the dispatcher routes. In a swarm any member
may branch, so that knowledge has to travel with the handoff tools. Each agent with
outgoing edges gets a generated block appended to its instructions:

```
## Colleagues you can hand this to
- Human resources — leave, PTO, payroll, personal matters
- IT claims — passwords, network access, technical support

Hand off when the request is theirs rather than yours; say why in the reason.
Answer directly when it is yours. Do not hand back what you were just handed
unless the subject has genuinely changed.
```

The list comes from the drawn edges; each line's description is the target agent's own
role summary (the first line of its instructions). **When the canvas has a dispatcher, its
routing prompt is the best statement of that mapping the workflow contains** — it already
says which subjects belong to whom — so it is carried into this block for every agent, not
left with the entry agent alone. The dispatcher keeps its own persona as its instructions;
what is shared is the routing knowledge, not the greeting.

The last line of the block matters: without it two agents can volley the same request back
and forth until the hop budget ends the run.

**Termination.** The swarm ends when the agent holding the turn replies without calling a handoff tool. That reply is the run's output. A hop budget (default 25 handoffs) ends a run that ping-pongs, with a `final` event carrying `status: "hop_budget_exhausted"` — the structural guarantee a DAG gets for free and a swarm does not.

### 3a. Swarm mode requires one shape

**Nothing here changes workflow mode.** Every pattern — fan-out, fan-in, chains,
dispatchers, playbooks — keeps compiling exactly as it does today when the workflow's
orchestration is `workflow`. That path is untouched and pinned byte-identical.

**Swarm mode accepts exactly one structure:** a node tagged **Dispatcher**, fanning out to
**two or more agents**. Anything else is an error, raised the moment the setting is
flipped rather than at Run.

```
   valid                          compiles to

   Start                          Start
     │                              │
     ▼                              ▼
  Dispatcher  (tagged)              A ◀──▶ B ◀──▶ C
   │    │    │                   (mesh, each carrying the
   ▼    ▼    ▼                    dispatcher's routing prompt)
   A    B    C
```

The rule is deliberately narrow. The alternatives — a bare chain, a worker fanning out —
are *structurally* expressible as handoffs, but they mean something different from what the
same drawing means in workflow mode, and a difference that silent is worse than a refusal.
One shape also makes the feature teachable: this is how you draw a swarm.

**What is refused, and why:**

| Canvas | Why it cannot be a swarm |
|---|---|
| No Dispatcher node at all | Nothing supplies the routing knowledge every member needs |
| Dispatcher with one child | A one-agent swarm has nobody to hand to |
| Worker fanning out to agents | A worker's fan-out means "run these concurrently"; a swarm has one active agent |
| Fan-in / merge (B, C → D) | One conversation reaches one agent — nothing merges |
| Two Start edges | A swarm has exactly one first turn |
| Contains a playbook node | Gates plus handoffs is unresolved in v1 (§7) |

**The error is a lesson, not a rejection.** It names what was found, what is needed, and
draws the target:

```
This workflow cannot run as a swarm.

Found:     "Newspaper Publisher" — 2 agents feeding one merge node,
           no Dispatcher node.
Needed:    one agent tagged Dispatcher, connected to 2 or more agents.

A swarm looks like this:

        Start
          │
          ▼
    ┌─────────────┐
    │  Dispatcher │  ← tag an agent as Dispatcher; its system prompt
    └──┬───┬───┬──┘    says which subjects belong to which colleague
       ▼   ▼   ▼
      HR  IT  Devices  ← the swarm: each can hand to the others

In swarm mode the Dispatcher is not an agent — its prompt becomes the
handoff guide every member carries.

  [ Keep workflow mode ]   [ Show me how to tag an agent ]
```

The message states the diagnosis first (what is in *this* canvas), then the requirement,
then the picture — so it teaches the shape rather than only refusing the current one. The
second button opens the node form at the agent-type field.


### 3b. Dissolving the dispatcher

A dispatcher exists so that *something* decides where a request goes. A swarm makes that
decision continuously, so the node has no work left: it is not compiled as an agent.
`Dispatcher + A + B` compiles to a **two-agent swarm**, not three.

```
   canvas                        compiled swarm

   Start                         Start
     │                             │
     ▼                             ▼
  Dispatcher                       A ◀────────▶ B
   │      │                    (each holds the other's
   ▼      ▼                     handoff tool, and both
   A      B                     carry the dispatcher's
                                 routing prompt)
```

**The rewrite, precisely:**

1. **Remove the dispatcher node.** It contributes no agent, no LLM call, no turn.
2. **Its children become a fully connected mesh.** Every child gets a handoff tool for
   every other child — with three children, A↔B, A↔C, B↔C. This is the one place edges are
   *synthesised* rather than read from the canvas, and it is the faithful reading: the
   dispatcher's menu was the set of agents allowed to receive the conversation, so they may
   now pass it among themselves.
3. **Its system prompt becomes the handoff guide**, appended to every child (§3, "Every
   agent that can hand off is told how to"). The dispatcher's persona — *"greet callers
   warmly"* — is routing scaffolding too, and is dropped; what is kept is the mapping of
   subjects to agents.
4. **The Start edge moves to the entry agent** (below).
5. **Edges from a child to a non-dispatcher node are preserved** as ordinary handoffs.

**What survives the dissolution, and what does not.** The dispatcher stops being an agent,
so everything that only makes sense for an agent goes with it:

| On the Dispatcher node | In swarm mode |
|---|---|
| system prompt — the **routing rules** | ✅ becomes the handoff guide every member carries |
| system prompt — persona, greeting, tone | ✗ dropped: nothing speaks with that voice |
| **MCP tools / servers** | ✗ dropped: it takes no turn, so nothing would ever call them |
| **Skills** | ✗ dropped: it produces no deliverable to transform |
| provider, model, temperature, max_tokens | ✗ dropped: it makes no LLM call |
| display name | kept in the warning below and in the audit trail |

The connected agents are untouched: **their** MCP tools, skills, providers and sampling
settings work exactly as in workflow mode. Swarm changes who is called next, not what an
agent is.

**A dispatcher carrying tools or skills warns at flip time**, because dropping them
silently is indistinguishable from a bug:

```
"techBuddy" is tagged Dispatcher and carries 3 MCP tools and 1 skill.

In swarm mode the Dispatcher is not an agent, so those are never called —
only its routing rules are used, as the team's handoff guide.

If those tools are needed, move them to the agents that use them.

  [ Keep workflow mode ]   [ Continue — I'll move them ]
```

This is also the practical reason a dispatcher's prompt should say *which subjects belong
to whom* and little else: everything else on that node is discarded.

**Which child is the entry.** With the dispatcher gone, someone must hold the first turn.
The rule: **the first child in canvas order** (lowest node id), recorded in the generated
docstring so it is never a mystery. Because every member carries the routing guide, a
first turn that lands on the wrong agent is self-correcting — it hands off immediately —
at the cost of one extra LLM turn. A future refinement is an "entry" marker in the editor;
it is not needed for v1 and would add UI for a case the routing guide already handles.

**What the user sees, and must be told.** The compiled swarm has *fewer agents than the
canvas shows*, and the run overlay and audit trail will name only the children. The
Generate step says so plainly: *"In swarm mode the Dispatcher node is not an agent. Its
prompt becomes the team's handoff guide, and its 2 connected agents form the swarm."*
Without that line the missing node reads as a bug.

**A canvas with a dispatcher and only one child** is rejected: a one-agent swarm has
nobody to hand to, and the dispatcher was doing nothing to begin with.

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

**Persistence is staged, and v1 needs none.** The checkpointer buys continuity *between*
runs and nothing else — within a single run the messages and `active_agent` live in state,
and handoffs work with no checkpointer configured at all.

| Goal | What is required |
|---|---|
| One prompt, handoffs, an answer — **v1 and the test workflow** | nothing |
| A follow-up in the same session, while the server is up | `MemorySaver`, in-process, zero configuration |
| Follow-ups surviving a restart, or shared across servers | a database |

So v1 ships without a checkpointer, `MemorySaver` is a one-line follow-up, and the
database is a separable step taken when threads must outlive a process. The generated code
is written so the saver is a single injection point, not a shape the graph depends on.

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

**Nested dispatchers — refused in v1.** A dispatcher among a dispatcher's children raises
a question nothing answers yet: may an inner member hand to an outer one, or is the inner
group sealed? Two defensible answers, no evidence for either, so the canvas is refused
naming both dispatcher nodes. Revisit when someone has a real workflow shaped that way.

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

Fixture: the owner's swarm test workflow — a dispatcher and two agents, drawn as a swarm.

**Generated package, no model (LLM stubbed at `_make_llm`, handoff tools invoked directly):**
- an agent calling `transfer_to_X` moves the turn to X and appends a `handoffs` record;
- an agent replying without a handoff ends the run, and its reply is the output;
- an agent has a handoff tool for **exactly** its drawn edges — no more, no fewer;
- the hop budget ends a deliberate ping-pong with `status: "hop_budget_exhausted"`;
- a canvas with a playbook node is rejected at compile time, naming the node;
- a canvas whose agents are unreachable from the entry is rejected, naming them.

**History:**
- two turns on one `thread_id`: the second turn's agent sees the first turn's messages;
- the second turn begins with the agent that ended the first — asserted by the entry condition, not by luck;
- two different `thread_id`s do not see each other's messages;
- with a SQLite checkpointer, history survives a process restart (the test that decides the §5 dependency question).

**Manual, by the owner:** run the swarm workflow, confirm the dispatcher agent starts, watch a handoff happen in the overlay, then send a follow-up that implicitly refers to the first turn and confirm it reaches the right agent without re-routing.

**Must stay green:** the whole workflow-mode suite. Swarm is a new emit path; it must not alter single-file, modular or A2A output. The existing byte-identical pins cover this.

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
which matters, because a chain drawn under `swarm` promises something different from the
same chain under `workflow` (§3b).

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
**interpretation** — dissolution, mesh synthesis, handoff-guide composition, which canvases
are refused — and the interpreter exercises exactly those with the fastest feedback and the
least scaffolding: press ▶ and watch, with no Generate, no runner, no spawned server, no
files. The compiler would validate the same rules through the slowest possible loop.

It is also the smaller step: no `langgraph-swarm`, no run server, no checkpointer, no
multi-user.

**v1(a) — the interpreter**

1. `workflow.orchestration` persisted on the workflow row, set in the editor's settings
   panel.
2. **The rewrite, in the analyzer**: dissolve the dispatcher, synthesise the mesh among its
   children, compose each agent's handoff guide, validate the pattern (§3b) — a pure
   `graph → graph` function.
3. The live run path consuming the rewritten graph: handoff tools per agent, one shared
   message array, loop while a handoff is returned, hop budget.
4. The owner runs one canvas in both modes and compares.

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

A swarm hides more than a workflow does: a node that is not an agent, edges that were never
drawn, and a prompt assembled from two places. None of that may be invisible.

**On the canvas, in swarm mode:**

- the **dispatcher node is greyed** with a note — *"Not an agent in swarm mode. Its prompt
  is the team's handoff guide."* — so a node that does not run says so;
- the **synthesised mesh is drawn**, distinctly from edges the user drew (dashed, say), so
  A↔B is visible rather than implied;
- a canvas the mode refuses is marked **when the setting is flipped**, not at Run — you
  find out while looking at the graph. The offending nodes are named (the merge and its
  parents, or the second Start edge).

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
│                                                          │
│ ## When to hand off      ← from the Dispatcher's prompt  │
│ When the caller mentions Repairs, service tickets…       │
│ Hand off when the request is theirs rather than yours…   │
└──────────────────────────────────────────────────────────┘
```

The agent's own prompt stays editable; the appended block is read-only and labelled with
where it came from, so its source is never a guess. Switch the workflow back to `workflow`
mode and the block disappears — the same display then shows exactly what runs there too.

This is the editor-side twin of the audit trail's `node_enter` record (concurrency spec
§5c): one shows what an agent *will* receive, the other what it *did*.

**Why the interpreter could always have done this.** `runWorkflow()` /
`_runNodeAsChatUnit()` already executes agents with tools, already handles dispatcher
routing through `dispatchTargets`/`routedBy`, and already streams into the overlay. Swarm
is *less* machinery than the DAG it runs today: handoff tools on each agent, one shared
message array, a loop while a handoff is returned, and the same dissolution rule from §3b.

It is **not in v1**, for one reason worth stating: it would be a third implementation of
swarm semantics (the Python library, this JavaScript, then ADK and MAF), and this codebase
already has two run paths that drift. Sequencing it after the compiled target means the
compiled behaviour is the reference, and the interpreter is written against something
proven rather than alongside it.

**What v1 must not do is make that later work harder.** Two concrete obligations:

1. Store `orchestration` on the workflow **now**, even though only the compiler reads it in
   v1 — so the interpreter has nothing to migrate.
2. Keep the dissolution rule (§3b) and the handoff-guide composition (§3) in the **PHP
   analyzer**, shared by both paths, rather than inside the LangGraph emitter. The
   interpreter then consumes the same rewritten graph the compiler does, and "dispatcher
   disappears in swarm mode" is decided in one place for both.

Obligation 2 is the one that makes interpreter-swarm a small job later instead of a
reimplementation.

## 11. Risks and decisions

- **The checkpointer owns five tables** (§5). `langgraph-checkpoint-mysql` migrates its own schema, so the generated server becomes a schema owner wherever it points. Recommendation: a dedicated schema, not the app's. Decide before building.
- **A stalled connection stalls a conversation** (§5). The checkpointer writes every turn, and this deployment has a history of fresh connections hanging; the saver is opened once and pooled for exactly that reason.
- **Context growth is inherent** (§5). Not a bug to fix in v1, but it will be the first complaint on a long thread, and the mitigation should be specified before it is met rather than after.
- **Two architectures in one generator.** The analyzer and every shared emit helper now serve both. The guard is that swarm is a new emit path and the workflow output is pinned byte-identical.
- **A canvas means two different things** depending on the selector. Mitigated by the Run item naming the architecture, and by compile-time rejection of canvases that are invalid as swarms.
- **`langgraph-swarm` is at 0.1.0.** A pre-1.0 dependency on the critical path; pinned `>=0.1,<0.2`, and the surface used is three functions, so a breaking release is a contained fix rather than a rewrite. The 411-line source is small enough to vendor if the project ever stalls.
