# Playbook Interpreter — Design Spec

2026-09-01. Validated through brainstorming + four stress tests against real Console playbooks.
Full exploration: `/Applications/XAMPP/xamppfiles/htdocs/Console ISTM/` (docs 06–08 and appendices).

## Goal

Execute Console-style ITSM **playbooks** — natural-language procedures whose steps reference actions as `#Action Name`
— inside SynergyAI. A playbook combines a trigger, prose instructions, a tool whitelist and action bindings; the
interpreter runs it with an LLM that decides each next action, while the engine enforces whitelists, policies, gates
and auditability.

## Decisions (all confirmed with Didier)

| # | Decision |
|---|---|
| D1 | Front door is an API/backend feature, not Slack; any front end supplies the playbook and renders run state. |
| D2 | All external services are reached through **MCP connectors**. |
| D3 | Human/time gates use **suspend + resume** (typed waiting statuses; wake endpoints). |
| D4 | Reuse the existing workflow engine (`GraphWorkflowRunner` loop, run persistence, `.jsonl` run log, `scheduled_workflows`, `MCPToolsLoader`). |
| D5 | Interpreter model **A′**: gates are tools; the run transcript is the checkpoint; resume happens at leg boundaries; a registration-time analyzer validates but never slices the prose. |
| D6 | We keep our **own request/run record**; native verbs act on it. Ticketing systems (Jira, ServiceNow, …) are optional MCP targets, mirroring later. |
| D7 | **Explicit bindings** `#Action → target`, LLM-proposed at registration, validated before any run. |
| D8 | Skill execution per host: PHP = existing client bridge (front end attached during the leg); Node = Pyodide in-process (P1); Python backend = CPython (P2). Host advertises `skills_server_side`. |
| D9 | **PHP backend first** (server constraint), with a browser open to run skill code when a playbook needs it. |
| D10 | Packaging: a **framework-neutral PHP class library**; contexts wrap it — **workflow node first**, then skill, standalone API, Python twin for compiled harnesses (LangGraph/ADK/NOOA). |
| D11 | Binding targets are **three kinds**: `server.tool` (MCP), native verbs (built-in), `agent.<name>` (invoke an existing AI agent from the workflow editor). |
| D12 | Testing uses **mock MCP servers with the real MCP interface** for every external service in the reference playbooks (Okta first, then Kandji, Slack, Google, GitHub, Datadog, AWS); webhook sources are mocked as HTTP POSTs. Swapping mock → real changes server internals only. |

## Vocabulary

**Run** = one execution of a playbook for one request. **Leg** = one agent-node execution inside a run, ending at a
gate or the end. **Native verb** = built-in action on the run record or a gate. **Binding** = `#Action → target` link.
**Gate** = tool call that suspends the run. **Wake** = requester message / approver decision / scheduler tick.
**Transcript** = provider-neutral event log, the checkpoint. **Ledger** = structured record of every executed action.
**Checklist** = analyzer's static list of expected actions, for validation and end-of-run coverage diff.

## Architecture

### Class library (framework-neutral PHP, `backend/src/Playbook/`)

| Class | Responsibility |
|---|---|
| `PlaybookDocument` | Parse/serialize the document (JSON or pasted Console text). |
| `PlaybookAnalyzer` | Registration-time validation: classify every `#Action` (native / bound / unbound), check connectors and agents exist, propose bindings via LLM (returned as warnings, never auto-applied), parse gates and schedule expressions, extract the expected-action checklist. Errors block, warnings don't. Never rewrites the prose. |
| `PlaybookInterpreter` | The A′ loop (below). |
| `PlaybookActionSpace` | Whitelist → executable tools: bound MCP tools (server-qualified), native verbs, gate tools, `agent.*` invocations. Enforces the whitelist and read/write policy again at execution. |
| `PlaybookRunState` | Variables, status, pending gate, transcript append/rehydrate, ledger, replay guard. |
| `PlaybookNativeTools` | The native verbs (below). |
| `GateManager` | Opens/closes gates, validates wake transitions (wrong wake → 409), computes `wait_until` times (business days, IANA timezones) in code — never the LLM. |

No class knows its calling context. Contexts: **workflow node (v1)**; skill, standalone HTTP API, Python interpreter
twin for compiled harnesses (later).

### The interpreter loop (A′) — explicitly not a queue

Each **leg**: the LLM receives the runner's fixed system prompt + the **whole playbook prose** + policy, the run
variables and requester context, the **transcript so far** rehydrated as prior turns (secrets redacted), the wake
event, and the playbook's tool set — nothing else. It proposes tool calls (parallel allowed); the engine validates
each (whitelist, write policy), executes it, appends to ledger + transcript, returns results; repeat. A **gate tool
call ends the leg** with a typed status. Round budget per leg (default 40); exhaustion → handoff with the ledger.
There is **no decoded action queue**: "what's next" is recomputed each round from prose + transcript, because
parameters come from earlier results and branches depend on data. Determinism is recovered after the fact by diffing
the ledger against the checklist (coverage report).

### Gates and statuses

| Gate tool | Waits as | Woken by |
|---|---|---|
| `trigger_form {prompt, fields}` | `awaiting_requester` | requester message (form answers). Fields may be marked `sensitive: true`: rendered masked, stored as `«redacted»` in transcript/ledger, passed only to the consuming tool call, never echoed. Missing mid-run user input is always requested this way — the model must never invent it. In a headless leg (no requester present) a form falls back to the `on_unbound`-style policy (handoff + note) until durable `awaiting_requester` lands (slice 1c). |
| `await_message {prompt, timeout_hours?}` | `awaiting_requester` | requester message |
| `request_approval {approver, question, context}` | `awaiting_approval` | approver decision (approved/denied + comment; actor recorded) |
| `prompt_handoff {team_or_person, reason, summary}` | `handed_off` | operator (`handoff_done`/`cancelled`) |
| `wait_until {anchor, offset_days?, offset_business_days?, weekday?, local_time?, timezone}` | `waiting` | scheduler (`scheduled_workflows` + existing cron endpoint) |
| `escalate_to_playbook {playbook, reason}` | terminal `escalated` | — |
| `resolve_request {outcome, summary}` / `stop` | terminal `resolved`/`stopped` | — |

Statuses: `pending → running → (awaiting_requester | awaiting_approval | handed_off | waiting)* → resolved | stopped |
escalated | failed | cancelled`. Only the wake matching the current status is accepted. In the **workflow context v1**,
immediate gates (form, message, live approval) are answered in the browser run UI; durable wakes (absent approver,
`wait_until`) require the run-record persistence and arrive in slice 1c.

### Native verbs (built-in, no binding)

`send_direct_message` (to requester; `sensitive` flag), `send_channel_message`, `send_email` (recorded; delivery is
the caller's or a connector's job), `leave_internal_note`, `set_priority` / `reroute` / `assign`, `search_requests`,
`resolve_request`, plus the gate tools above. They act on the run record.

### Bindings

`"#Reset Password (Okta)": "okta.reset_user_password"` — targets: `server.tool` (MCP, **server-qualified names**;
the flat `mcp_` prefix collides across servers and gains a qualified alias), `agent.<name>` (load that user's agent,
run it on the sub-task with its own provider/instructions/tools, return its result into the transcript), later
`skills.<name>` where the host profile allows. Unbound actions (missing, `null`, dangling, or capabilities mentioned
without a `#`) are listed at registration; at run time policy `on_unbound` = `handoff` (default) | `skip` | `fail`.

### Playbook document

Console's fields (Title, Trigger, Instructions, Tools used, Actions used) + `bindings`, `policy`
(`writes_enabled`, `on_unbound`, `on_failure` = `continue_then_handoff` default | `stop`), `approvers` (selector →
resolution, e.g. `requestersManager: requester.manager_email`). Pasted Console text is accepted; the analyzer converts
and proposes bindings. Trigger kinds: `request` (v1, the node's prompt), `webhook` (payload→variable mapping, scoped
app key), `schedule` (v2).

### Data model (new tables; transcript reuses `WorkflowRunLog` `.jsonl`)

`playbooks` (document + validation json, versioned) · `playbook_runs` (status, requester, variables, pending_gate,
current_leg, coverage) · `playbook_run_messages` (direction, audience, sensitive) · `playbook_run_notes` ·
`playbook_run_ledger` (leg, seq, action, tool, args redacted, outcome ok|failed|skipped|replayed, returned ids) ·
`playbook_run_gates` (kind, args, asked_of, decision, actor). Engine's `agent_workflow_executions` row still written
per leg.

### Safety

Whitelist enforced at exposure *and* execution. Playbooks are read-only unless `policy.writes_enabled`; MCP tools carry
a `read|write` tag (unknown ⇒ `write`). Gates are engine-owned — the model cannot satisfy one. Sensitive outputs are
redacted from ledger/transcript and delivered only in the addressed message; never rehydrated except as `«redacted»`.
Replay guard: identical (tool, args) already `ok` in this run returns the stored result (`replayed`). Unresolvable or
failed actions end in a human's hands (`on_unbound` / `on_failure` defaults), never silently dropped.

### Engine changes (PHP)

Per-node round budget (today 10, client path 3 → configurable, playbook default 40); server-qualified MCP tool alias +
collision detection in `MCPToolsLoader`; the playbook node type in the workflow editor + `GraphWorkflowRunner`
dispatch; native-tools service; run-log event kinds (`leg_started`, `gate_opened`, `gate_closed`, `wake`, …) + a
rehydration renderer; `scheduled_workflows` row type "wake playbook run"; `read|write` tag in the MCP tool catalog.

## v1 scope and test plan

**Slice 1a** — library skeleton (`PlaybookDocument`, `Analyzer` minimal, `Interpreter`, `ActionSpace`, `RunState`,
`NativeTools` without gates), the **playbook workflow node**, the **mock Okta MCP server** (real MCP interface:
`search_users`, `search_system_log`, `list_user_factors`, `reset_password`, `reset_factor`, `unlock_user`;
fixture-backed), and the **Low-risk path** of the *Okta Password / MFA Reset* reference playbook end-to-end in a
workflow (no gate needed), with ledger + transcript + whitelist proven.

**Slice 1b** — immediate gates (`trigger_form`, `request_approval`, `prompt_handoff`, `await_message`) answered in the
browser run UI; the Medium/High/deny branches of MFA Reset via three fixtures (clean user; 4 resets in 30 days;
odd-IP logins).

**Later slices** (order fixed, not in this spec's implementation plan): 1c durable wakes + `wait_until` + webhook
trigger; 1d analyzer hardening (LLM binding proposals, coverage report, write policy, secrets, `requires_client`);
1e SSE/notify/gate-token gateway; 1f skills via the client bridge; then Device Recovery → Provisioning → Onboarding
tests with their mock servers; real connectors (Jira, ServiceNow, Okta) replacing mock internals.

## Acceptance test — the reference playbook, verbatim

The system test for v1 is the real Console playbook **Okta Password / MFA Reset** (Console library `it-5`; annotated
in `Console ISTM/04-sample-playbook-okta-mfa-reset.md`). It is registered unchanged and run inside a workflow through
the playbook node against the mock Okta MCP server.

**Document under test** (instructions abridged here; the run uses the full text from `Console ISTM/06 Appendix A`):

> **Title:** Okta Password / MFA Reset
> **Trigger:** Requester reports being locked out, lost MFA device, needs a password or factor reset.
> **Instructions:** #Search Okta User by Email … #Search Okta System Log Custom … #List User Factors … risk score
> (3+ resets/30d → High; new-country/odd-IP login → High; known device → Low; suspicious log → Medium) …
> Low → inline security questions; Medium → #Request Approval (requestersManager); High → #Prompt for Handoff …
> denied → DM + #sec-alerts + #Resolve Request, Stop … reset per issue type (#Reset Password (Okta) sendEmail=true /
> #Reset User Factor with the factor ID from step 3 / #Reset User Factors (Custom) / #custom Okta Unlock User) …
> confirmation DM … High or 3+ resets → #Send Channel Message #sec-alerts … #Leave Internal Note … #Resolve Request.
> **Tools used:** Okta

**Bindings:** `#Search Okta User by Email → okta.search_users`, `#Search Okta System Log Custom →
okta.search_system_log`, `#List User Factors → okta.list_user_factors`, `#Reset Password (Okta) →
okta.reset_password`, `#Reset User Factor → okta.reset_factor`, `#Reset User Factors (Custom) → null` (unbound on
purpose), `#custom Okta Unlock User → okta.unlock_user`, and the Low-path "custom action to check answers against profile" → `okta.verify_security_answers` (mock-only tool); the rest are native verbs.

**Mock fixtures** (one Okta user each): `low@test` — clean history, known device; `medium@test` — recent logins from
an unusual IP; `high@test` — 4 password-reset events in the last 30 days.

**Test cases and assertions:**

| # | Request | Expected run |
|---|---|---|
| T1 (slice 1a) | `low@test`: "forgot my password" — the request context includes the security-question answers, so the leg needs no interactive gate (asking them via `trigger_form` is exercised in slice 1b) | Ledger contains, in order: `okta.search_users` → `okta.search_system_log` → `okta.list_user_factors` → `okta.verify_security_answers` (ok) → `okta.reset_password` with `send_email=true` → `send_direct_message` → `leave_internal_note` (mentions risk Low + method) → `resolve_request`. Status `resolved`; no `#sec-alerts` message; coverage report all-green. |
| T2 (slice 1b) | `medium@test`: "locked out" | Gate `request_approval` opens with approver = resolved `requestersManager`; status `awaiting_approval`. **T2a** approve → reset executes, status `resolved`. **T2b** deny → `send_direct_message` (next steps) + `send_channel_message` to `#sec-alerts` + `resolve_request`; no Okta write in the ledger. |
| T3 (slice 1b) | `high@test`: "lost my phone with Authenticator" | Gate `prompt_handoff` (security) opens; status `handed_off`. After `handoff_done`: lost-device branch reaches the **unbound** `#Reset User Factors (Custom)` → `on_unbound=handoff` policy fires (ledger `skipped` + second handoff), no invented tool call. `#sec-alerts` message present (High). |
| T4 (slice 1a) | any fixture, playbook registered with a binding to a nonexistent tool | Registration fails with a blocking error naming the action; no run is created. |
| T5 (slice 1a) | replay: re-run T1's leg after an injected crash between reset and resolve | `okta.reset_password` with identical args is `replayed` from the ledger, not re-executed by the mock (mock asserts single execution). |

Pass criterion: T1/T4/T5 green closes slice 1a; T2/T3 green closes slice 1b. The same harness (mock server + fixtures
+ ledger assertions) is then reused for Device Recovery, Provisioning and Onboarding as their slices land.

## Out of scope

UI (callers render everything); Slack/Teams; playbook library with intent matching; Jira/ServiceNow mirroring;
compiling playbooks themselves to LangGraph/ADK/NOOA (the Python interpreter twin is the future path); Node (P1) and
Python backend (P2) tracks — see `Console ISTM/08-infrastructure-prerequisites.md`.

## Reference material

`Console ISTM/07-interpretation-architecture.md` (full design, §§1–22), `06-…-options.md` (options + 4 stress tests +
the 4 playbooks as appendices), `04-…` (annotated MFA Reset), `03-…` (how Console itself interprets playbooks).
