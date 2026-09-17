# Batch workflows in the conversation overlay — design

Date: 2026-09-17. Branch: feat/backend-python. Status: draft for review.

Gives **batch (DAG) workflows** the surface the swarm uses — the movable conversation overlay,
the canvas scrim, the progress phases, a document overlay — **without** giving them a
conversation, because a batch workflow does not have one. Scope: the editor's interpreter and the
LangGraph compiled target, for `orchestration = "workflow"`.

## 1. What we are building, and what we are deliberately not

A batch workflow runs Start → … → Output and terminates. It is a one-shot, which is why it has
always been called batch.

**We are porting the surface, not the semantics.** After this:

- Run opens the conversation overlay instead of the results modal.
- You type a prompt; the whole graph runs; **one bubble** shows what the end node produced.
- You type another prompt: **the previous response is cleared**, the new prompt goes into the
  workflow, and a new result replaces it.
- A document opens in its own overlay, the viewer that exists today.
- Compiled runs get the scrim, the operable toolbar and the three progress phases already built
  for the swarm.

**There is no transcript, and no conversation history.** An earlier draft of this spec designed
one — re-running the graph with every prior turn injected into every agent. The owner rejected
it, correctly: it would have meant a client-side transcript, a generator change threading it
through every node's model call, and the context-length question, all to simulate a continuity a
DAG cannot use. Each prompt stands alone.

This is recorded rather than deleted, because "why doesn't batch mode remember?" is a question
someone will ask, and the answer is that it was considered and declined.

## 2. Why the overlay is still worth it

If each prompt is independent, the overlay buys nothing a modal could not — except the things the
owner actually asked for, which the modal cannot give:

- **one surface for every mode**: interpreter swarm, compiled swarm, batch. A user learns it once;
- the window is **movable and resizable**, so the canvas stays visible behind it — which matters
  more here than for a swarm, because a batch run lights up nodes as it walks the graph;
- the **scrim** says the canvas is inert while compiled code runs, with the toolbar still live;
- the **progress phases** explain the wait from the moment of the click;
- the **document overlay** replaces a column crammed into a results modal.

## 3. The interaction

### 3a. One turn at a time

Each prompt:

1. **clears the previous response** from the feed;
2. runs the whole graph, the dispatcher routing on this prompt alone;
3. renders **one bubble**: the end node's output, verbatim.

Clearing is deliberate, and must be **visible**. Silently replacing one answer with another, in a
surface that looks exactly like the swarm's conversation, invites the user to type a follow-up and
receive a non-sequitur — the dispatcher having seen four words with no referent.

### 3b. Say so, in the surface

The overlay must make the one-shot rule evident rather than leave it to be discovered:

- the composer says what it does — that each prompt runs the workflow fresh;
- the feed visibly clears on send, rather than the old answer quietly vanishing under a new one.

This is the one place the batch overlay should look *different* from the swarm's, and it should,
because it behaves differently. A surface that is identical but does not behave identically is
worse than one that is visibly its own thing.

### 3c. What the feed shows

The same whitelist the swarm arrived at:

| shown | |
|---|---|
| the turn's reply | one bubble, the end node's output, verbatim |
| a document produced | the end node's own words say so; the document opens in its own overlay |
| gate requests | a playbook node asking a human; hiding it would deadlock the run |
| errors | a failed run says so |

Per-node rounds, tool calls and tool results keep flowing to the node Activity/Logs panes. That
trace is valuable — it is simply not the answer.

**Routing is worth one line.** A dispatcher choosing a branch is why you got this answer rather
than another: *"routed to IT claims — password reset"*, rendered thin and inline, the way the
swarm renders a handoff.

## 4. Documents

When a run produces an artifact, it opens in **its own overlay**, using the viewer that exists
today.

That viewer is currently not a separate thing: it is a second column inside the results modal,
deliberately, because the chat layout's artifact pane is not visible from the editor. Lifting it
out is part of this work.

The bubble carries **the end node's output verbatim** — when the result is a document, the end
node simply says it produced one. The UI composes nothing; the node speaks for itself.

## 5. Compiled mode

Reuses what the swarm already has, pointed at the batch path:

- the canvas dims behind the scrim, the toolbar stays above it and operable;
- the conversation overlay on top, movable;
- the three phases — generating the package, starting the run server, running — from the click.

### 5a. What the compiled path does *not* need

**The generated DAG `run()` keeps ignoring `session`.** It accepts the parameter only so `api.py`
stays byte-identical between the DAG and swarm packages, and with no conversation to resume there
is nothing for it to do. No generator change, no server-side store, no `MemorySaver`.

The transport is unchanged and already built: `POST /runs` starts a turn, `GET /runs/{run_id}/events`
streams the result back over SSE. One protocol, three modes, one overlay.

### 5b. The one-shot compiled DAG run stays exactly as it is

The owner has asked for this explicitly, twice. The results modal remains its terminus. It would
be easy to delete once conversational mode stops using it, and wrong.

## 6. What is shared, and the risk in sharing it

Shared **code**, not copies — the overlay and its composer, the movable window and its persisted
geometry, the scrim and its phases, the feed whitelist, the document overlay.

| | swarm | batch |
|---|---|---|
| a turn | one active agent, control moves by handoff | the whole graph runs |
| the reply | whatever the answering agent said | what the end node produced |
| between turns | active agent and transcript persist | **nothing persists** |
| a new prompt | continues the conversation | clears the previous answer, starts fresh |

**The risk is the surface drifting into two implementations.** The whitelist and the window
lifecycle are the two most likely to be duplicated by accident. If a change is worth making for
one mode it lands in the shared place, or the modes diverge by neglect rather than by decision.

**The second risk is the user, not the code**: the same window with different rules. §3b exists to
answer it.

## 7. Out of scope

- **A conversation for batch workflows.** Considered, declined — see §1.
- **Swarm mode.** Untouched.
- **ADK, MAF, NOOA.** LangGraph first, as with the swarm.
- **Multi-user.** Its own spec.

## 8. Tests

### 8.1 The interaction, in the interpreter

Drivable with a stubbed graph runner, as the swarm's harness is:

- a prompt renders exactly one bubble, carrying the end node's output;
- a second prompt **clears the first response** before rendering its own;
- **nothing is carried between prompts** — the second run's node calls receive no history, and the
  dispatcher's call carries only the new prompt. This is the assertion that stops a transcript
  creeping back in later "for consistency with the swarm";
- a failed run renders an error in the feed;
- hiding the overlay and reopening does not resurrect a previous answer.

### 8.2 Documents

- a run producing an artifact opens the viewer; a run producing none leaves it alone;
- a later run replaces the viewer's content.

### 8.3 The compiled target

- **workflow-mode generated output is byte-identical** — this spec changes no emitter, so the
  existing generator pins are the whole test, and any movement in them means someone has changed a
  shared path;
- the scrim, phases and overlay behave as they do for a swarm.

### 8.4 Manual, by the owner

Run a dispatcher workflow in the overlay. Send a prompt, read the bubble. Send a second prompt on
a different subject and confirm the dispatcher routes elsewhere and the previous answer is gone.
Produce a document and confirm it opens in its own overlay. Then the same against compiled code,
watching the three phases and the dimmed canvas.

## 9. Sequencing

1. **The overlay for the batch interpreter** — Run opens it, one bubble per prompt, the feed
   clearing visibly, the composer saying why.
2. **The document overlay**, lifted out of the results modal.
3. **Compiled mode** — pointing the existing scrim, phases and overlay at the batch path.

No step needs the generator. That is the measure of how much simpler this became.
