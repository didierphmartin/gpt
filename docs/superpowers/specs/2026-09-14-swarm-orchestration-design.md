# Swarm orchestration — design

Date: 2026-09-14. Branch: feat/backend-python. Status: draft for review.

Second architecture alongside the existing workflow (DAG) compiler. Scope of this spec: **LangGraph, modular packaging only**. The other frameworks are assessed in §9; multi-user and the workflow-mode history feature are separate specs and follow this one.

## 1. What we are building

A workflow drawn on the canvas can be compiled as a **swarm**: agents that hand control to one another, with the conversation carried between them automatically, instead of a fixed graph that decides who runs next.

Three decisions, taken with the owner, define it:

1. **An edge means "may hand off to."** You draw the allowed handoffs; an agent gets one handoff tool per outgoing edge. The topology stays reviewable and a handoff you did not draw is impossible rather than merely unlikely.
2. **A dispatcher node becomes the entry agent.** It is an ordinary swarm agent that happens to start, with handoff tools to the children on its menu, and its routing prompt carried over as its instructions. Existing dispatcher workflows therefore convert without being rewritten.
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
| Dispatcher node | one forced `route_to`, one child runs | the entry agent — **and its routing rules become the team's shared handoff guide** (below) |
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

### 3b. The four canvas patterns

The same canvas means different things under the two architectures, and not every pattern
survives the translation. Compiling a swarm therefore classifies the canvas first:

| Pattern | Workflow mode | Swarm mode | Verdict |
|---|---|---|---|
| **Dispatcher + connected agents** | dispatcher routes once, one branch runs | entry agent + handoff tools — routing decided per turn, and reversible | ✅ **canonical**. What swarm is for |
| **Connected agents in a chain** (A → B → C) | all three run, in order | A holds the turn and *may* hand to B; it may also answer and stop | ⚠️ **valid but different** — warn, do not reject |
| **Fan-out / fan-in** (Start → A, B → C) — the newspaper publisher | A and B run in parallel, C merges both outputs | a swarm has one entry and one active agent: no parallelism, no merge | ❌ **rejected** |
| **Anything containing a playbook node** | playbook runtime with human gates | who holds the turn while a human is being asked? Unanswered | ❌ **rejected in v1** |

**Why fan-out is rejected rather than degraded.** It could be mapped — A entry, hands to
B, B hands to C — but that silently converts a parallel, aggregating pipeline into a
sequential chain: different latency, different cost, and C merging two inputs becomes C
receiving one conversation. A workflow whose whole point is "these two run at once and the
third combines them" is not a swarm, and compiling it into something that looks similar
and behaves differently is worse than refusing. The message names the node with more than
one Start edge, and the merge node with more than one parent.

**Why the chain only warns.** It is structurally legal — one entry, handoffs along the
drawn edges — so the compiler emits it, but the editor says plainly what changed: *"In
swarm mode each agent decides whether to hand on. B and C may never run."* In a workflow
the chain is a guarantee; in a swarm it is a possibility. That difference is invisible in
the picture, which is exactly why it is worth saying out loud.

**Validation at compile time.** A swarm canvas must have exactly one entry (one Start edge) and at least one agent; an agent with no outgoing edges is legal (a terminal specialist). A canvas whose agents form no reachable set from the entry is rejected with the unreachable names listed.

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

## 10. UI

The code-generation modal gains an architecture choice above the packaging radios:

```
Architecture:  (•) Workflow      ( ) Swarm
Packaging:     ( ) Single file        ← greyed out for Swarm in v1
               (•) Agents in separate files
               ( ) A2A                ← greyed out for Swarm in v1
```

Stored as `{architecture, mode, multiUser}` under the existing `wf:<id>:codegen` key; sent as `&architecture=swarm`; default stays `workflow`. New i18n keys in en/es/fr, cache-buster bump. The Run menu item already names the packaging mode and gains the architecture: `Run (swarm · separate files)`.

## 11. Risks and decisions

- **The checkpointer owns five tables** (§5). `langgraph-checkpoint-mysql` migrates its own schema, so the generated server becomes a schema owner wherever it points. Recommendation: a dedicated schema, not the app's. Decide before building.
- **A stalled connection stalls a conversation** (§5). The checkpointer writes every turn, and this deployment has a history of fresh connections hanging; the saver is opened once and pooled for exactly that reason.
- **Context growth is inherent** (§5). Not a bug to fix in v1, but it will be the first complaint on a long thread, and the mitigation should be specified before it is met rather than after.
- **Two architectures in one generator.** The analyzer and every shared emit helper now serve both. The guard is that swarm is a new emit path and the workflow output is pinned byte-identical.
- **A canvas means two different things** depending on the selector. Mitigated by the Run item naming the architecture, and by compile-time rejection of canvases that are invalid as swarms.
- **`langgraph-swarm` is at 0.1.0.** A pre-1.0 dependency on the critical path; pinned `>=0.1,<0.2`, and the surface used is three functions, so a breaking release is a contained fix rather than a rewrite. The 411-line source is small enough to vendor if the project ever stalls.
