# Realtime Workflow Design

**Co-designed by Didier Martin and Claude — April 2026**

This document captures the architecture, UI design, and validated protocol for adding realtime audio workflows to the platform. It serves as the reference spec for implementation.

---

## 1. The Problem

The existing workflow system is batch-oriented: a PHP runner executes a graph of agents sequentially via HTTP, producing a final result. This works well for text-based tasks but cannot handle live audio conversations where agents must react in real time, hand off mid-call, and maintain a persistent voice session.

Realtime workflows are fundamentally event-driven, not data-driven. The graph doesn't describe "run A then B" — it describes "when event X happens in A, become B."

## 2. Design Principles

1. **The graph is the specification.** Users draw boxes and arrows. The system generates everything else — tool declarations, system prompt injections, handoff protocol, event routing.

2. **Implicit over explicit.** Arrows between agents mean "this agent can transfer to that agent." No labels needed in the common case. Return transitions are implicit (call-stack model). Explicit labels exist for advanced cases but are never required to get started.

3. **Same editor, different semantics.** The realtime editor uses the same Drawflow canvas, same drag-and-drop, same inspector panel as the batch editor. The differences are minimal: a session frame around the graph, a voice field on agents, and arrows that represent transitions instead of data flow.

4. **Separate runtimes, shared agents.** The PHP batch runner stays as-is. A new JavaScript realtime runner handles live audio workflows. Agent definitions (name, prompt, tools, MCP) are shared between both — the runtime determines how the agent is activated.

5. **Realtime calls batch, not the reverse.** Batch workflows can be exposed as tools inside realtime agents. The realtime runner invokes them via the existing backend API. This means the realtime runner doesn't need to re-implement batch capabilities.

## 3. Graph Vocabulary

### 3.1 Elements

The realtime editor reuses the same visual paradigm as the batch workflow editor: agent nodes are displayed as cards on the Drawflow canvas using the same layout and interaction patterns (drag-and-drop from the sidebar, click to open the inspector modal). **There are no arrows drawn between nodes.** Transitions between agents are configured inside each agent's inspector form via handoff targets and "when done" settings — the graph topology is implicit, not visual.

| Element | Visual | Meaning |
|---|---|---|
| **Start node** | Special box with ▶ Play button (same card style as batch Start) | Connection setup. Holds two WebSockets: one inbound (audio source), one outbound (LLM provider). Has a Test/Production mode switch. First agent listed after it greets the caller. |
| **Agent card** | Same rounded card as batch agents (with mic icon overlay for realtime) | A persona/state that can be active on the call. Click to open the inspector form. Contains: name, voice, system prompt, tools, handoff targets, "when done" behavior. Exactly one is active at any moment. |
| **End node** | Same card style as batch Output | The session endpoint. When any agent calls `end_session()`, the runtime closes both WebSockets, logs the session, and reports usage. Any agent can include End as a handoff target — it appears in the handoff targets multi-select alongside other agents. |
| **Handoff targets** | Configured inside the agent's inspector form (multi-select of other agents) | Replaces forward arrows. The system auto-generates `handoff_to("B")` tools for each selected target. The LLM decides when to call them. |
| **Event triggers** | Configured inside the agent's inspector form (optional section) | Replaces labeled arrows. Explicit triggers (timer, keyword match, tool result condition, observer event) are set per-agent, not drawn as connections. |
| **Tool list** | Checkboxes in the agent's inspector form (same as batch) | Functions available to this agent: code function, MCP tool, or batch workflow. |
| **Observer node** | Separate card in an "Always listening" section | Cross-cutting listener (safety, logging, sentiment). Not part of the state machine. Watches every turn regardless of active agent. **Not included in v1 — planned for a future version.** |
| **Session frame** | Border around the entire canvas | The call boundary. Everything inside exists while the caller is connected. |

### 3.2 Start Node

The Start node is the entry point of a realtime workflow. It owns the audio connections and has two operating modes controlled by a switch in its inspector.

**Test mode:**
- A **Play button** appears on the Start node in the editor.
- Clicking Play opens an overlay with mic/speaker access, a waveform visualizer, and a live transcript log.
- The runtime establishes the outbound WebSocket to the LLM provider, then **activates the first agent connected to the Start node** (this must be an agent node). That agent's system prompt, voice, tools, and auto-generated `handoff_to` declarations are pushed to the LLM session. The agent greets the caller.
- Audio flows: browser mic → Start node → LLM provider WebSocket. LLM audio → Start node → browser speaker.
- The agent graph runs live on the canvas — the active agent gets the orange halo + spinner, handoffs move them to the next card.
- Closing the overlay stops the session. The user can tweak prompts and Play again instantly.
- This replaces the need for separate test pages. Testing is built into the editor.

**Production mode:**
- The Play button is replaced by an inbound WebSocket configuration:
  - URL (e.g., `wss://pbx.company.com/calls`)
  - Protocol (SIP / WebRTC / raw PCM WebSocket)
  - Authentication (bearer token, API key, or none)
- Audio flows: external source (PBX, SIP gateway, WebRTC peer) → Start node → LLM provider WebSocket, and vice versa.
- The agent graph is identical — agents don't know whether audio comes from a developer's mic or a phone caller.

**Two WebSockets:**
```
Inbound WS:   caller audio ───▶ ┌───────┐
                                │ START  │
Outbound WS:  LLM audio ◀────▶ └───────┘ ◀────▶ Grok/Gemini
```
- Inbound: receives audio from the caller (test mode: browser mic via AudioStreamer; production: external WebSocket)
- Outbound: bidirectional connection to the LLM provider (Grok Realtime / Gemini Live)

**First connected agent:** The agent box connected to the Start node's output is the entry agent. When a session begins, this agent's system prompt and tools are pushed to the LLM, and the agent greets the caller.

### 3.3 Implicit Rules

**Implicit handoff:** When an agent lists another agent as a handoff target in its inspector form, the workflow runtime auto-generates a `handoff_to(target)` tool declaration (with the target names as enum values) and pushes it to the LLM provider as part of the agent's session config. The LLM sees this as a callable function — no different from any other tool. When the LLM determines from the conversation that a transfer is warranted, it emits a function call event (e.g., `handoff_to("billing")`). The runtime intercepts this event and executes the handoff protocol (swap agent config, move the active state). The LLM never executes the function itself — it only declares intent; the runtime is the executor. No arrows are drawn on the canvas — the topology is defined entirely by the handoff target selections in each agent's form.

**Implicit completion via "when done" property:** Every non-start agent has a "when done" field configured in its inspector form. Two options, mutually exclusive:

- **Return to caller** (default) — pops the agent stack, returns to whichever agent initiated the handoff. Like a function return.
- **Go to [specific agent]** — clears the stack and jumps directly to the named agent. Like a goto. Useful when a deep agent (e.g., Collections) should return directly to the Receptionist, skipping intermediate agents (e.g., Billing).

The LLM receives a single `done()` tool meaning "I'm finished helping this caller." It doesn't need to know whether the runtime will return or goto — that's configured on the agent node, not decided by the LLM. No return arrows or goto arrows clutter the canvas.

**Implicit transfer speech:** The system prompt instructs agents to verbally acknowledge a transfer before calling the handoff tool ("Sure, let me connect you with billing..."). The handoff executes only after the current turn's audio finishes playing.

### 3.4 Minimal Example

The receptionist scenario requires a Start node and three agent cards on the canvas. The configuration is: Start connected to Receptionist, Receptionist connected to both Billing and Sales.

**Canvas layout:**
```
┌─────────┐       ┌──────────────┐       ┌──────────────┐
│ ▶ START │──────▶│ Receptionist │──────▶│   Billing    │
│ [Play]  │       │   voice: Ara │──┐    │  voice: Rex  │
└─────────┘       └──────────────┘  │    └──────────────┘
                         │          │    ┌──────────────┐
                         │           ──▶│    Sales     │
                         │              │  voice: Eve  │
                         │              └──────────────┘
                         │          ┌──────────────┐
                          ─────────▶│     END      │
                                    └──────────────┘
```

**Inspector form configuration:**

| Agent | Handoff targets | When done |
|---|---|---|
| Receptionist | Billing, Sales, **End** | *(start agent — no "when done")* |
| Billing | *(none)* | Return to caller |
| Sales | *(none)* | Return to caller |

- Receptionist's handoff targets generate tools: `handoff_to("billing")`, `handoff_to("sales")`, `end_session()`
- End is a special target available to any agent. When the LLM determines the conversation is over (caller says goodbye, issue resolved, etc.), it calls `end_session()`. The runtime closes both WebSockets (inbound and outbound), logs the session, and reports usage.
- Billing and Sales each get a `done()` tool configured as "return to caller"
- Any agent can include End in its handoff targets — it's not exclusive to the start agent. A billing specialist who resolves an issue can end the call directly without returning to the receptionist first.
- The topology is fully defined by the form fields — nothing drawn between cards

**Batch vs. Realtime — same layout, different meaning:**

This configuration illustrates the key semantic difference between the two runtime modes. One agent connected to two agents means something fundamentally different depending on the mode:

| | Batch interpretation | Realtime interpretation |
|---|---|---|
| Receptionist → Billing, Sales | **Parallel execution**: both Billing and Sales run simultaneously, each receiving Receptionist's output as input | **State transition possibilities**: the LLM decides which ONE to activate based on the conversation. "I want to check my bill" → Billing. "I want to buy something" → Sales. Only one is active at a time. |
| Execution model | All paths run | One path chosen per event |
| Data flow | Receptionist's output is duplicated to both | No data flows — the caller's audio stream is redirected |

**A deeper example with goto:**

| Agent | Handoff targets | When done |
|---|---|---|
| Receptionist | Billing | *(start agent)* |
| Billing | Collections | Return to caller |
| Collections | *(none)* | Go to: Receptionist |

- Collections is configured as "when done → goto Receptionist"
- When the LLM in Collections calls `done()`, the stack clears and jumps directly to Receptionist, skipping Billing
- Billing is configured as "when done → return to caller" (goes back to Receptionist since Receptionist called it)

### 3.5 Agent Stack (Call Model)

The runtime maintains a stack of active agents:

```
Start:              [Receptionist]
Handoff to Billing: [Receptionist, Billing]       ← push
Billing done:       [Receptionist]                 ← pop (return)
Handoff to Sales:   [Receptionist, Sales]          ← push
Sales done:         [Receptionist]                 ← pop (return)
```

Nesting works naturally:
```
[Receptionist, Billing, Collections]   ← two levels deep
Collections done (goto Receptionist):  [Receptionist]   ← stack cleared
```

**Return** pops one frame. **Goto** clears the stack to just the target agent. If Billing has a handoff target to Sales (configured in its form), calling `handoff_to("sales")` pushes Sales: `[Receptionist, Billing, Sales]`. When Sales calls `done()` with "return to caller," it pops back to Billing: `[Receptionist, Billing]`.

## 4. Auto-Generated System Prompt

The system generates prompt additions from the graph topology. For the receptionist example:

**Receptionist gets:**
```
You have access to a handoff function. Call it when the caller
needs to be transferred to a specific department:
  - handoff_to("billing") — transfer to Billing Specialist
  - handoff_to("sales") — transfer to Sales Representative

Before calling handoff_to, always verbally tell the caller you
are transferring them. Never transfer silently.
```

**Billing Specialist gets:**
```
You have access to a completion function:
  - done() — call this when you have finished helping the caller
    with their billing question, or when they request to speak
    to someone else.

Before calling done(), verbally let the caller know you are
transferring them back.
```

The `done()` tool is identical for every non-start agent. The runtime decides what happens when it's called (return to previous agent, or goto a specific agent) based on the agent's "when done" configuration — the LLM doesn't need to know the difference.

These prompt fragments are injected automatically. The user only writes the agent's core personality and domain instructions.

## 5. Event Detection (Six Mechanisms)

Events are how the system recognizes that a state transition should occur.

### 5.1 Mechanism Priority (cheapest first)

| # | Mechanism | Cost | Latency | Used for |
|---|---|---|---|---|
| 1 | Transcript pattern match | Zero | Instant | Keywords, phrases |
| 2 | Provider VAD/turn signals | Zero | Instant | Silence, interruption, speech start/stop |
| 3 | LLM tool calls | Zero (rides on existing inference) | ~1-2s | Intent detection, handoffs, state progression |
| 4 | Tool result predicates | Zero | Instant | Conditions on function return values |
| 5 | Timers | Zero | Configurable | Idle timeout, session max duration |
| 6 | Observer classifier | Low (cheap model) | ~500ms | Safety, sentiment, escalation, language switch |

### 5.2 Default Mechanism

For unlabeled arrows (the common case), **Mechanism 3 is the default**. The LLM receives a `handoff_to` tool and decides when to call it based on its understanding of the conversation. No separate classifier, no keyword list, no rules — the LLM's language understanding is the event detector. This was validated in testing: the LLM correctly inferred "I want to check my bill" → `handoff_to("billing")` without any explicit intent mapping.

### 5.3 Explicit Labels

When Mechanism 3 isn't sufficient, the user adds an explicit label to the arrow. The arrow label dialog offers options grouped by mechanism:

**Free, instant, deterministic:**
- Keyword/phrase in transcript (Mechanism 1)
- Silence timeout (Mechanism 2+5)
- Tool result condition (Mechanism 4)
- Timer elapsed (Mechanism 5)

**Free, conversational (default):**
- Agent decides via tool call (Mechanism 3)

**Opt-in, costs extra:**
- Observer event (Mechanism 6)

## 6. Validated Protocol (Spike Results)

Two spike tests validated the core protocol on both providers.

### 6.1 Grok Voice Agent (xAI)

**Test file:** `frontend/test-grok-realtime-tools.html`

**Protocol:**
- Endpoint: `wss://api.x.ai/v1/realtime`
- Auth: ephemeral client secret from `/api/v1/voice/token`
- Tool declaration: `session.update` with `tools[]` array
- Tool call event: `response.function_call_arguments.done` with `name`, `call_id`, `arguments`
- Tool result: `conversation.item.create` with `function_call_output`
- Resume: `response.create`
- Handoff: `session.update` with new `instructions` + `voice` + `tools`

**Validated handoff sequence:**
```
1. function_call_output     → return tool result
2. session.update           → push new agent personality + voice + tools
3. wait for session.updated → server confirms config change
4. response.create          → trigger new agent to speak
```

**Results:**
- Tool calling: PASS
- Mid-session handoff: PASS
- Voice swap (Ara → Rex → Eve): PASS
- Transfer speech before handoff: PASS
- Handoff latency: ~0ms (same session)

### 6.2 Gemini Live (Google)

**Test file:** `frontend/test-gemini-realtime-tools.html`

**Protocol:**
- Library: `@google/genai` SDK via CDN
- Auth: API key directly
- Tool declaration: `BidiGenerateContentSetup` with `tools[].functionDeclarations`
- Tool call event: `message.toolCall.functionCalls[]`
- Tool result: `session.sendToolResponse({ functionResponses })`
- Handoff: close session + reconnect with new voice/config

**Validated handoff sequence:**
```
1. sendToolResponse         → return tool result
2. wait for turn complete   → let transfer speech finish
3. session.close()          → close current session
4. ai.live.connect(...)     → open new session with new voice + prompt
5. sendClientContent(...)   → nudge new agent to introduce itself
```

**Results:**
- Tool calling: PASS
- Handoff via reconnect: PASS
- Voice swap (Kore → Puck): PASS
- Transfer speech before handoff: PASS
- Reconnect latency: **131ms**

### 6.3 Provider Comparison

| Capability | Grok | Gemini |
|---|---|---|
| Handoff mechanism | Native `session.update` | Close + reconnect |
| Voice swap | Atomic, same session | Via reconnect (131ms gap) |
| Async tool calling | Not supported | Supported (`NON_BLOCKING`) |
| Server-side tools | `web_search`, `x_search`, `file_search`, `mcp` | `googleSearch` |
| Mid-session config update | Full support | Not supported (one-time setup) |
| Ephemeral token flow | Yes (backend mints) | No (API key directly) |

**Recommendation:** Start with Grok for the pilot. Cleaner handoff protocol, native voice swap, existing ephemeral token infrastructure. Add Gemini as a second adapter for its async tool calling advantage (useful for slow batch-workflow-as-tool calls).

## 7. Runtime Architecture

### 7.1 Overview

```
┌──────────────────────────────────────────────────────┐
│                    Browser                           │
│                                                      │
│  ┌──────────────┐    ┌────────────────────────────┐  │
│  │ Drawflow     │───▶│ Graph JSON                 │  │
│  │ Editor       │    │ {nodes, edges, agents}     │  │ 
│  └──────────────┘    └──────────┬─────────────────┘  │  
│                                 │                    │
│                                 ▼                    │
│                    ┌───────────────────-───┐         │
│                    │ WorkflowRealtimeRunner│         │
│                    │                       │         │
│                    │ - Agent stack         │         │
│                    │ - Event bus           │         │
│                    │ - Local rule engine   │         │
│                    │ - Tool dispatcher     │         │
│                    └──────────┬───────────┘          │
│                               │                      │
│                    ┌──────────┴───────────┐          │
│                    │   Provider Adapter   │          │
│                    │   (Grok / Gemini)    │          │
│                    └──────────┬───────────┘          │
│                               │                      │
│              ┌────────────────┼───────────────┐      │
│              ▼                ▼               ▼      │
│         AudioStreamer    WebSocket to      fetch()   │
│         (mic/speaker)   Grok/Gemini       to PHP     │
│                                           backend    │
└──────────────────────────────────────────────────────┘
```

### 7.2 Provider Adapter Interface

```javascript
class ProviderAdapter {
    connect(config)              // Open session with agent config
    disconnect()                 // Close session
    sendAudio(base64)            // Pipe mic audio to provider
    configureAgent(agent, tools) // Push new personality + tools (Grok: session.update, Gemini: reconnect)
    returnToolResult(callId, result) // Send function_call_output / toolResponse
    resumeAfterTool()            // Trigger next response (Grok: response.create, Gemini: sendClientContent)

    // Events emitted:
    onToolCall(name, args, callId)
    onTranscript(text, isFinal, direction)
    onAudio(base64)
    onTurnComplete()
    onInterrupted()
    onSessionReady()
    onError(error)
    onClose()
}
```

### 7.3 Handoff Protocol (Generic)

```
1. LLM calls handoff_to("target") or return_to_caller()
2. Runner receives tool call via adapter.onToolCall
3. Runner sends tool result via adapter.returnToolResult
4. Runner waits for adapter.onTurnComplete (transfer speech finishes)
5. Runner updates agent stack (push for handoff, pop for return)
6. Runner calls adapter.configureAgent(newAgent, newTools)
7. Runner waits for adapter.onSessionReady
8. Runner calls adapter.resumeAfterTool (new agent speaks)
```

## 8. Composability: Realtime Calls Batch

Batch workflows can be exposed as tools inside realtime agents. From the LLM's perspective, it's just another function call. From the runner's perspective:

**Synchronous mode** (fast workflows, < 10s):
- Tool call blocks until the batch workflow completes
- Result returned to LLM as tool output
- Agent speaks the result

**Async mode** (slow workflows, Gemini only):
- Tool declared as `NON_BLOCKING`
- LLM continues speaking while workflow runs
- Result delivered with `scheduling: "INTERRUPT"` or `"WHEN_IDLE"`

**Grok workaround for async:**
- Tool returns immediately with `{status: "started"}`
- Background poll/SSE waits for completion
- Result injected as a synthetic conversation item
- Agent's prompt instructs it to speak the result when it arrives

## 9. UI Design

### 9.1 What Changes vs. Batch Editor

The realtime editor reuses the same canvas layout, card styling, connectors, and inspector forms as the batch editor. Both modes have connectors between nodes drawn on the Drawflow canvas, but with different visual styles and meanings.

| Element | Batch | Realtime |
|---|---|---|
| Mode indicator | (none) | "Realtime" badge in toolbar |
| Canvas | Open | Wrapped in session frame |
| Node cards | Same card layout | Same card layout (+ mic icon overlay) |
| Connectors | **Solid lines** — data flow (output of A becomes input of B) | **Dashed lines** — state transition possibilities (A can hand off to B; the LLM decides when) |
| Agent inspector | Prompt, model, tools, temperature, max tokens, output schema, input content, output response, statistics | Same form reused. Added fields: voice selector, previous state, handoff targets, "when done" behavior. Unused batch fields hidden in realtime mode. |
| Run button | "Run" → PHP backend | "Run" → browser-side JS runner |
| Live feedback | Orange halo + spinning circle on active node | Orange halo + spinning circle on active node (identical visual treatment) |

### 9.2 Agent Inspector Form Reuse

The existing batch agent inspector form (modal with tabs: Paramètres, Schéma de sortie, Contenu d'entrée, Réponse de sortie, Statistiques) is reused for realtime agents. The following fields carry over directly:

**Shared fields (same behavior):**
- Type (Travailleur / worker)
- Nom (Name)
- Description
- Fournisseur (Provider) — filtered to realtime-capable providers (Grok, Gemini)
- Modèle (Model) — filtered to realtime-capable models
- Prompt système (System prompt)
- Outils (Tools) — same checkbox grid
- Température (Temperature)
- Tokens maximum (Max tokens)
- Enregistrer comme modèle (Save as template)

**Added fields for realtime:**
- Voice selector (provider-specific voice list)
- Previous state (read-only, computed) — shows which agent(s) list this one as a handoff target. Derived automatically by scanning all other agents' handoff targets. If multiple agents can hand off here, all are listed. Displayed next to "when done" to make the return destination concrete (e.g., "Previous state: Receptionist" + "When done: return to caller" → user sees clearly that done() goes back to Receptionist).
- Handoff targets (multi-select of other agents in the workflow — replaces arrows)
- "When done" behavior (return to caller / go to specific agent)
- Event triggers (optional: keyword, timer, tool result condition)

**Hidden/disabled in realtime mode:**
- Schéma de sortie tab (output schema — not applicable to streaming audio)
- Contenu d'entrée tab (input content — audio is streamed, not batched)
- Stratégie de fusion des entrées (input merge strategy)
- Réponse de sortie tab (output response — realtime is conversational, not document-based)

### 9.3 Progressive Disclosure

- **Simple** (1 agent): Just a voice-enabled agent. Looks like a batch workflow with a mic icon. Toggle "Realtime" and hit Run.
- **Intermediate** (2-3 agents): The receptionist scenario. Add agents, configure handoff targets in each agent's form. Implicit returns handle the rest.
- **Advanced** (event triggers, observers): Full statechart with explicit events configured per-agent. Only needed for complex routing logic. **Planned for a future version.**

### 9.4 Runtime View

The same canvas becomes a live dashboard during execution:

- **Orange halo + spinning circle** on the active agent card — the orange halo indicates which agent is currently on the audio/text stream; the spinning circle (top-right, same as batch's "executing" spinner) indicates it is actively processing/listening. Users already associate the spinner with "this node is working" from the batch editor — combined with the halo, it clearly communicates "this agent is live and on the mic." Both indicators move together to the next card when a handoff fires. Only one card has them at any moment.
- **Tool call pulses** on the active card when the LLM calls a function.
- **Collapsible event log** along the bottom — shows transcript, handoff events, tool calls with timestamps.
- **Post-session timeline scrubber** for replay — drag through the session and watch the halo move between cards.

The active state in realtime is the direct equivalent of the batch editor's "currently executing" spinner — the agent whose system prompt, tools, and voice are loaded in the LLM provider session, currently sending and receiving audio (or text) with the caller.

## 10. Workflow Creation Entry Point

The existing sidebar already has a "Workflows" section with a "+ Nouveau Workflow" button. When clicked, this button now presents a choice popup (same UI pattern as the existing "Save" button's dropdown in the batch editor):

- **Batch Workflow** — opens the existing batch editor (current behavior)
- **Audio Workflow** — opens the realtime editor with a session frame, Start node, and realtime-specific agent palette

This is the only user-facing entry point change. The `runtime_mode` field (`batch` | `realtime`) is set automatically based on which option the user picks. The PHP runner refuses `realtime` workflows; the JS runner refuses `batch` workflows.

## 11. Implementation Stages

### Stage 0 — Schema + guardrails (no user-visible change)
- Add `runtime_mode` to `agent_workflows` table (`batch` | `realtime`)
- PHP runner refuses `realtime` graphs with a clear error
- Node-type registry stubs for realtime types

### Stage 1 — Realtime runner prototype
- `frontend/assets/js/workflow-realtime-runner.js`
- Grok adapter only (cleanest protocol)
- Supports: agent stack, `handoff_to`, `done()`, auto-generated prompts from graph topology
- Run from the Start node's Play button (test mode overlay with mic/speaker)

### Stage 2 — Editor integration
- Realtime node palette in Drawflow (Start, Agent, End)
- Session frame rendering
- Dashed connectors between nodes representing state transition possibilities
- Voice selector, previous state, handoff targets, and "when done" fields in agent inspector
- Start node with Play button for test mode, WebSocket config for production mode
- Workflow creation entry point: "Batch Workflow" / "Audio Workflow" choice on "+ Nouveau Workflow" button

### Stage 3 — Gemini adapter
- Second provider adapter (close + reconnect handoff with voice swap)
- Functions/tools shared with batch (same MCP tools, same code functions available in both modes)

### Stage 4 — Observers + advanced events (future version)
- Observer nodes
- Explicit event triggers per-agent (keyword, timer, tool result predicates)
- Local rule engine
- Optional parallel classifier (Mechanism 6)

### Stage 5 — Cost + observability
- Short-lived token renewal (60s cycle)
- Per-session usage meter (every 5s to `/voice/usage`)
- Session replay log (events + timestamps, optional audio recording)

### Stage 6 — Unattended deployment (optional)
- Node.js sidecar running `workflow-realtime-runner.js`
- Audio adapters for SIP/Twilio
- Scheduled outbound calls

## 12. Open Questions

1. **Concurrent callers:** Can two callers run the same realtime workflow simultaneously? Yes — each call is an independent runner instance with its own agent stack and provider session. No shared state between calls.

2. **Session recording:** Store events by default (text is cheap). Audio recording opt-in per workflow due to storage costs and privacy.

3. **Max session duration:** Enforced both client-side (runner timer) and server-side (ephemeral token expiry). Recommend 30-minute default, configurable per workflow.

4. **Agent library:** Should agents be reusable across workflows? Current batch system keeps agents local to their workflow. Reusable agents (a shared "Billing Specialist" used by multiple workflows) would require a new "Agent Library" feature. Defer to a future stage.
