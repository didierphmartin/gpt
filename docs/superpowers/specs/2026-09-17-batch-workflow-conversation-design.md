# Batch workflows hold a conversation — design

Date: 2026-09-17. Branch: feat/backend-python. Status: draft for review.

Ports the swarm's conversational surface to **batch (DAG) workflows**, and builds the piece
that makes it more than a surface: a shared conversation every agent can see. Scope: the
editor's interpreter **and** the LangGraph compiled target, for `orchestration = "workflow"`.

## 1. What we are building

Today a batch workflow is a one-shot. You press Run, fill in a prompt, the graph executes
Start → … → Output, a results modal shows the output and any document, and it is over. A second
prompt is a second, unrelated run: nothing of the first survives.

After this, a batch workflow is a **dialogue**. You type into the same conversation overlay the
swarm uses, the workflow runs, its answer comes back as one bubble, and you type again — with
every agent, the dispatcher included, seeing what was said before.

Three decisions, taken with the owner, define it:

1. **A prompt re-runs the whole graph.** Not the routed branch, not from the dispatcher down —
   the whole graph, every time. The dispatcher routes afresh on each prompt, so a second prompt
   about a different subject reaches a different branch.
2. **One bubble per turn, carrying what the end node produced** — verbatim. When the result is a
   document the end node simply says it produced one. Not one bubble per agent: the per-node
   trace stays in the node panes where it already lives.
3. **A document opens in its own overlay**, the viewer that exists today, lifted out of the
   results modal.

## 2. Why this is not just a UI port

The overlay is the easy half. The half that does not exist is the **conversation itself**.

A DAG terminates. There is no active node to resume, so "continue the conversation" can only
mean "run it again, knowing what was said". Without a shared transcript, a second prompt is
indistinguishable from a fresh run — the dispatcher would route *"make it 5 days"* on those four
words alone, with no idea what five days refers to.

This is the workflow-mode conversation history deferred during the swarm work, and the owner
described it then: *"a file that contains the whole conversation and use that as a context so
that the llms can understand even implicit prompts."* It is the same property a swarm gets free
from `langgraph-swarm`'s shared `messages` channel, built by hand for a graph that has no such
channel.

## 3. The conversation

### 3a. What the transcript holds

`[{role, content}]` — the same shape the backend's `conversation_history` already takes, and the
same shape the swarm session uses.

- **the user's prompt**, on every turn;
- **the end node's output** for that turn, as the assistant's reply.

**Not** every node's output. A batch workflow's internal data flow — node A's text becoming node
B's input — is the graph's plumbing, not the conversation. Putting it in the transcript would
balloon it, repeat the same content under several speakers, and teach the dispatcher to route on
intermediate artefacts it should not see. One turn in, one turn out.

### 3b. History is additional context, never a replacement for the graph's data flow

Each node still receives what the graph gives it: Start's prompt, or its parents' outputs. The
transcript is passed **alongside** that, as conversation history, exactly as
`_runNodeAsChatUnit(node, inputText, { history })` already supports for the swarm.

This distinction matters and is easy to get wrong: a node's `inputText` is what the graph routed
to it *this turn*; `history` is what the conversation said *before* this turn. Collapsing the two
would make a fan-in node read its siblings' work as dialogue.

### 3c. Every agent sees it, including the dispatcher

The dispatcher especially. Routing is the decision that most needs the prior exchange, and it is
the decision made first in the turn.

### 3d. The session

Mirrors the swarm's, because the owner has already tested that shape and it survived several
rounds of correction:

- a session id minted once when the conversation opens, sent with every prompt;
- **hiding the overlay does not end the session** — it resumes, and the feed replays;
- a session ends on a workflow change, an orchestration flip, or an explicit replacement;
- closing and reopening starts fresh.

## 4. What the overlay shows

The same whitelist the swarm arrived at, for the same reason — a debug trace is right for a
one-shot run and wrong for a conversation:

| shown | |
|---|---|
| the turn's reply | one bubble, the end node's output |
| a document produced | the end node's own words say so; the document opens in its own overlay |
| gate requests | a playbook node asking a human; hiding it would deadlock the turn |
| errors | a failed turn says so |

Everything else — per-node rounds, tool calls, tool results, routing decisions — keeps flowing
to the node Activity/Logs panes. That trace is valuable; it is simply not the dialogue.

**Routing is worth one line.** A dispatcher choosing a branch is the batch equivalent of a
handoff, and the swarm renders handoffs as a thin inline line. The same treatment here — *"routed
to IT claims — password reset"* — costs one line and answers "why did I get this answer".

## 5. Documents

When a turn produces an artifact, it opens in **its own overlay**, using the viewer that exists
today.

Today that viewer is not a separate thing: it is a second column inside the results modal,
deliberately, because the chat layout's artifact pane is not visible from the editor. Lifting it
out is part of this work.

The bubble carries **the end node's output, verbatim** — and when the result is a document, the
end node simply says it produced one. The UI does not compose a line naming the file, and does
not need to: the node already speaks for itself. This keeps the bubble the node's voice rather
than a mixture of the node's voice and the editor's.

A later turn producing another document replaces what the viewer shows; the conversation keeps
every turn's bubble, so the history of what was produced is in the dialogue even though the
viewer holds one document at a time.

## 6. Compiled mode

Identical to the swarm, and mostly already built:

- the canvas dims behind a scrim while compiled code runs, with the toolbar above it and
  operable;
- the conversation overlay on top, movable;
- the three progress phases — generating the package, starting the run server, running — shown
  from the moment of the click.

### 6a. The conversation is client-owned, and travels with the prompt

**This is mainly client-side work.** The editor owns the transcript in both modes, and the
compiled server stays stateless for it.

- **Interpreter**: the browser runs each node, so it injects the history directly. Nothing
  leaves the client.
- **Compiled**: the client sends the conversation **with the prompt**, over the transport that
  already exists — `POST /runs` to start a turn, `GET /runs/{run_id}/events` streaming SSE back.
  No new channel, no server-side store.

So the generated DAG `run()` — which today accepts `session` and ignores it — gains the
conversation as an argument and passes it into each node's model call. That is a real generator
change but a contained one: threading a value through, not building and keying a store.

**This differs from the compiled swarm deliberately**, and the asymmetry is worth naming because
it looks like an inconsistency. A compiled swarm's conversation lives on the server, in
`langgraph-swarm`'s checkpointer, because the *active agent* has to persist between prompts and
only the graph knows it. A batch workflow has no active agent — it terminates every turn — so
there is nothing for the server to remember, and keeping the transcript client-side is both
simpler and truer to what a DAG is. `MemorySaver` and `active_agent` have no role here.

## 7. What is shared with the swarm, and what differs

**One overlay serves all three modes**, and the client-owned transcript is what makes that
possible: the interpreter, a compiled swarm and a compiled batch workflow all speak the same
`POST /runs` + SSE protocol, so the surface does not need to know which is behind it. A
server-side transcript for one mode and a client-side one for another would have forced the
overlay to branch on transport, and a surface that branches is a surface that drifts.

Shared, and must stay shared rather than forked:

- the conversation overlay, its composer, the movable window and its persisted geometry;
- the scrim and its three phases;
- the session lifecycle — mint once, hide does not end, end at one choke point;
- the feed whitelist.

Different, and the differences are the whole design:

| | swarm | batch |
|---|---|---|
| a turn | one active agent, control moves by handoff | the whole graph runs |
| the reply | whatever the answering agent said | what the end node produced |
| between turns | the active agent persists | nothing persists but the transcript |
| the transcript | the library's `messages` channel, server-side | client-owned, sent with each prompt |
| documents | not addressed | a first-class outcome, own overlay |

**The risk this creates** is a second implementation of the same surface drifting from the first.
Every shared item above is shared *code*, not a copy — if a change is worth making for one mode,
it must land in the place both use. The whitelist and the session lifecycle are the two most
likely to be duplicated by accident.

## 8. Out of scope

- **Swarm mode.** Untouched by this work.
- **The one-shot compiled DAG run.** The owner has asked for it to stay exactly as it is. The
  results modal remains its terminus — do not delete it because conversational mode stopped using
  it.
- **ADK, MAF and NOOA.** LangGraph first, as with the swarm.
- **Multi-user.** Its own spec; the session id here is per-overlay, not per-user.
- **Summarising a long conversation.** Same deferral as the swarm: the transcript grows, and the
  first complaint on a long dialogue will be context length.

## 9. Tests

### 9.1 The transcript, in the interpreter

Driven by a stubbed per-node executor, as the swarm's harness already is:

- a turn appends the user's prompt and the end node's output, in that order, and nothing else —
  specifically **not** each node's output;
- turn two's node calls carry turn one's exchange as `history`, and its `inputText` is still what
  the graph routed, not the conversation;
- **the dispatcher's call carries the history** — it is the decision that needs it most;
- a turn that errors still closes the transcript, so the next turn does not see an unanswered
  prompt (the swarm's finding 9, which will recur here if it is not designed out);
- ending the session clears it; hiding does not.

### 9.2 Documents

- a turn producing an artifact opens the viewer and names the document in the bubble;
- a turn producing none leaves the viewer alone and the bubble carries text;
- a second document replaces the viewer's content without disturbing earlier bubbles.

### 9.3 The compiled target

- the emitted DAG `run()` accepts the conversation sent with the prompt and threads it into every
  node's model call — and a node's own graph input is still what the graph routed, not the
  conversation;
- **workflow-mode output for a non-conversational run stays byte-identical** — this is a new
  behaviour on an existing, heavily pinned emit path, and the existing generator pins are the
  guard;
- `api.py` and `common.py` stay byte-identical between the DAG and swarm packages.

### 9.4 Manual, by the owner

The test that decides it, as in the swarm: **send a second prompt that only makes sense given the
first.** Then a third on a different subject, and confirm the dispatcher routes it elsewhere while
still understanding the context. Then the same against compiled code.

## 10. Sequencing

1. **The transcript in the interpreter** — the conversation, with the existing overlay. The half
   with no surface work and all the meaning.
2. **Documents into their own overlay**, lifted out of the results modal.
3. **The compiled target** — the client sending the conversation with each prompt, the emitted
   `run()` threading it into node calls, then the scrim and phases, which are already built and
   only need pointing at the batch path.

Taking the transcript first is deliberate: it is the part that can be wrong in a way nothing
visible reveals, and the swarm shipped twice with exactly that defect.
