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

## 2. Build it on LangGraph primitives, not on `langgraph-swarm`

`langgraph-swarm` is not installed; everything it is built from is — `langgraph 1.2.7` with `Command(goto=…)`, `StateGraph`, `MemorySaver` and `create_react_agent`.

We emit the pattern ourselves. Reasons, in order:

- **No dependency to install wherever the folder is deployed.** The package already runs on what the runner venv has.
- **We own `active_agent` persistence**, which has to interoperate with the history store and the audit trail rather than with a library's private state shape.
- **`langgraph-swarm` imposes its own state** (a messages channel plus its own active-agent key). Our runs carry `node_outputs`, `routes` and a run id; reconciling the two is more work than emitting ~60 lines of handoff plumbing.
- **The hand-rolled shape ports.** ADK and MAF will be hand-rolled against *their* primitives anyway (§9), so one mental model covers all three.

The trade accepted: we maintain the pattern. It is small and the tests pin it.

## 3. Canvas semantics

| Canvas element | Workflow mode (today) | Swarm mode |
|---|---|---|
| Edge A → B | B runs after A | A gets a `transfer_to_B` tool |
| Start → X | X is the first node | X is the **entry agent** |
| Dispatcher node | one forced `route_to`, one child runs | the entry agent, with handoff tools to its menu children |
| Agent node | runs once when reached | an agent that may hold the turn any number of times |
| Output node | collects parents' outputs | where the final answer is delivered when no agent hands off |
| Playbook node | the playbook runtime, with gates | **not supported in v1** — see §7 |

**Termination.** The swarm ends when the agent holding the turn replies without calling a handoff tool. That reply is the run's output. A hop budget (default 25 handoffs) ends a run that ping-pongs, with a `final` event carrying `status: "hop_budget_exhausted"` — the structural guarantee a DAG gets for free and a swarm does not.

**Validation at compile time.** A swarm canvas must have exactly one entry (one Start edge) and at least one agent; an agent with no outgoing edges is legal (a terminal specialist). A canvas whose agents form no reachable set from the entry is rejected with the unreachable names listed.

## 4. The generated package

Same layout as the workflow target, one file different:

```
workflow.py   the swarm: state, handoff tools, graph wiring, entry, CLI
common.py     unchanged — stateless runtime
runs.py       unchanged — run registry, sinks, history store, audit
api.py        unchanged — the run server
agents/*.py   one agent each: NODE + run_node(request, trace)
```

**State:**

```python
class SwarmState(TypedDict, total=False):
    messages: Annotated[list, add_messages]   # the shared conversation
    active_agent: str                         # who holds the turn
    handoffs: Annotated[list, operator.add]   # [{from, to, reason}] — audit and re-entry
```

**A handoff tool per drawn edge**, built from the target's display name so the model names a colleague rather than an id:

```python
def _handoff_tool(target_id: str, target_name: str):
    @tool(f"transfer_to_{slug(target_name)}",
          description=f"Hand the conversation to {target_name}. Use when the request is theirs, not yours.")
    def _t(reason: str = "") -> Command:
        return Command(goto=target_id, graph=Command.PARENT,
                       update={"active_agent": target_id,
                               "handoffs": [{"from": _THIS_NODE, "to": target_id, "reason": reason}]})
    return _t
```

**Graph wiring:** one node per agent; each node is that agent's ReAct loop over its own MCP tools *plus* its handoff tools. Entry is a conditional edge from START that reads `active_agent` — the entry agent on a fresh run, the persisted one on a resumed thread (§5).

**What is reused unchanged:** every agent module keeps the `run_node(request, trace)` contract, the MCP tool builder, the skills runtime, the provider factory, the run server and the event protocol. A swarm differs in who is called next, not in what an agent is.

## 5. Conversation history — the property that matters

This is the reason swarm was asked for, so it is not optional here: **a swarm carries its conversation automatically.**

- The shared `messages` channel *is* the history. An agent taking the turn sees what was said before, including the other agents' replies and tool results. Nothing has to be re-framed at a handoff, and nothing is lost in one.
- Persistence is a **checkpointer keyed by thread**: `graph.compile(checkpointer=…)`, invoked with `{"configurable": {"thread_id": f"{owner}:{thread}"}}` — the same `(owner, thread)` key the history store uses, so swarm and workflow threads live side by side without a second scheme.
- `active_agent` is checkpointed with the messages, so a follow-up resumes with the agent that handled the last turn. This is what makes *"actually make it 5 days"* reach HR without anyone re-routing it.

**Dependency note, to decide before building:** `MemorySaver` is installed and gives per-process history — lost on restart. Durable history needs `langgraph-checkpoint-sqlite`, which is **not installed**. The spec assumes SQLite for anything the user would call memory; if we ship with `MemorySaver` only, history dies with the server and the feature is half-delivered.

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

- **`MemorySaver` vs SQLite (§5).** Shipping in-memory only means history dies with the server, which users will read as "it forgot me". Decide before building; adding `langgraph-checkpoint-sqlite` to the runner requirements is the cheap answer.
- **Context growth is inherent** (§5). Not a bug to fix in v1, but it will be the first complaint on a long thread, and the mitigation should be specified before it is met rather than after.
- **Two architectures in one generator.** The analyzer and every shared emit helper now serve both. The guard is that swarm is a new emit path and the workflow output is pinned byte-identical.
- **A canvas means two different things** depending on the selector. Mitigated by the Run item naming the architecture, and by compile-time rejection of canvases that are invalid as swarms.
- **Hand-rolled handoff could drift from the ecosystem.** If `langgraph-swarm` becomes the obvious standard, §2's decision is worth revisiting — the pattern is small enough to swap.
