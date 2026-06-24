# Phase 0 — Per-Execution Trace Store + Classifier (implementation spec)

**Date:** 2026-06-13
**Parent:** `2026-06-13-self-healing-design.md` (§3, §4.1–4.2, §6)
**Goal:** capture one structured, classified, outcome-labelled record per skill/agent
execution — the substrate all three healers read. **No healing in this phase**; capture only.

---

## 1. Scope

**In:** the trace record; its assembly + persistence; a deterministic (no-LLM) weakness
classifier and outcome-quality labeller; minimal read queries; the cost-estimate helper that the
future approval overlay (design §4.4) will call.

**Out:** `mine_weaknesses.py`, any healer loop, any LLM judging, the overlay UI. Those are
Phase 1+.

**Guiding constraint:** reuse data already emitted this week (`node_complete` with
`provider`/`cost_usd`, `[BridgeUsage]`, the skill `stdout`/`log_messages` returned through the
client-tool round-trip, the node Logs tab). Phase 0 is plumbing, not new computation.

---

## 2. The record (canonical schema)

```
execution_trace {
  id, run_id, ts, latency_ms
  env            ENUM(chat, workflow)
  invocation_mode ENUM(auto_discovery, forced, workflow_node)
  workflow_id, node_id        NULL in chat
  provider, model
  skill_dir, script, argv     (argv as JSON)
  input_snapshot              TEXT (the task the execution received)
  tool_calls                  JSON [{name, input, round}]
  skill_exit_code, skill_stdout, skill_log_messages
  output_files                JSON [paths]
  final_text
  success                     BOOL  (mechanical)
  rounds, round_limit_hit, loop_detected   BOOL/INT
  tokens_in, tokens_out, cost_usd
  user_action                 ENUM(accept, retry, abort, none)  -- default none
  error_class                 ENUM(a_skill_prompt,b_skill_script,c_workflow_config,d_foundation_code,e_transient_external, ok)
  error_text
  outcome_quality             ENUM(good, degraded, failed, unknown)
}
```

`run_id` correlates a whole workflow run's nodes (one UUID per workflow execution / per chat
turn). This is the field most missing today.

---

## 3. Assembly & emit points

The backend is authoritative (the browser is untrusted). Two capture sites:

**3a. Workflow path — `GraphWorkflowRunner`.** A trace is finalized where `node_complete` is
emitted (both the main-loop site and the parallel site). Everything is already in hand there —
`provider`, `success`, `output`/`error`, `tokens`, `cost_usd` — **except the skill
stdout/log_messages**, which arrive earlier via the client-tool round-trip
(`$bridgeResult['output']['stdout'|'log_messages']`) in `runAgentWithClientToolBridge` /
`roundTripClientToolInParallel`. **One new wire:** stash that result on the run context keyed by
`node_id`, then attach it when building the trace at `node_complete`. `run_id` is generated once
at workflow-run start.

**3b. Chat path.** When a skill runs in conversation/forced mode, finalize a trace at the end of
that skill invocation. `invocation_mode` = `auto_discovery` if the skill was description-matched,
`forced` if it came from a dragged badge (the chat request already distinguishes these — the
forced path carries an explicit skill selection).

**Persistence:** one `insertTrace()` call at each site → the store (§5).

---

## 4. Deterministic classifier + outcome labeller (no LLM)

Run at insert time in PHP. Pure signature rules — this is what keeps mining free (design §6 L5).

**`error_class` rules (first match wins):**
| Signature in error_text / state | class |
|---|---|
| HTTP 429/503/500/overloaded/"rate limit"/"Service Unavailable" | `e_transient_external` |
| "not registered" / undefined var / "not found" provider / thought_signature / reasoning_content / usage-shape | `d_foundation_code` |
| skill_exit_code ≠ 0 / Python traceback in log_messages | `b_skill_script` |
| success but `loop_detected`/`round_limit_hit`/argv∈{-h,--help}/"I'm unable"/"cannot"/apology-regex | `a_skill_prompt` |
| env=workflow & node config anomaly (provider flaky here, parallel+client-tool) | `c_workflow_config` |
| else if success & clean | `ok` |

**`outcome_quality` rules (free signals only):**
| Condition | quality |
|---|---|
| success ∧ exit 0 ∧ output_files present ∧ ¬loop ∧ user_action≠abort/retry | `good` |
| success ∧ (loop_detected ∨ round_limit_hit ∨ apology-regex ∨ no output_files when expected) | `degraded` |
| ¬success | `failed` |
| else | `unknown` |

`user_action` is backfilled when the user later aborts/retries/accepts (a cheap UPDATE keyed on
`run_id`/`node_id`).

---

## 5. Store

**Recommended: a DB table `execution_traces`** (schema = §2). Rationale: the three readers
(design §3.3) all need to *aggregate and query* — by `skill_dir`, by `workflow_id`, by
`error_class` — which a table does natively and a flat file does not. Indices:
`(skill_dir)`, `(workflow_id, node_id)`, `(error_class)`, `(run_id)`, `(ts)`. Retention: prune
by `ts` (e.g. 90 days) — unlike `php_error_log`, this is bounded and structured.

*(Alternative: append-only JSONL under a `traces/` dir — simplest, zero migration, but every read
re-parses the whole file. The §2 schema maps to either; only the persistence layer differs.)*

---

## 6. Read surface (Phase 0 = queries only)

Three thin queries, matching the three aggregations:
- **skill:** `WHERE skill_dir=? AND outcome_quality IN (degraded,failed) GROUP BY error_class, invocation_mode`
- **workflow:** `WHERE workflow_id=? ORDER BY node_id` (per-node credit assignment)
- **foundation:** `WHERE error_class='d_foundation_code' GROUP BY error_signature ORDER BY count DESC`

No mutation, no LLM. These feed Phase 1's miner and the diagnosis read-outs.

---

## 7. Cost-estimate helper (for the future approval overlay)

A pure function `estimateHealCost(skill_dir, providers[], Q, R, I, eval_model)`:
```
calls = Q*R*2*(1+I) + I
tokens ≈ calls * avg_tokens_per_call   (calibrated from real traces' tokens_in/out)
usd    = price(eval_model)·eval_tokens + price(proposer_model)·proposer_tokens   // system_llm_settings
```
Reuses the `getProviderPricing()` added this week. Returns `{calls, tokens, usd, range}`. Phase 0
ships the function + a tiny endpoint; the overlay UI consuming it is Phase 1.

---

## 8. Acceptance (Phase 0 done when…)
1. Every workflow node run and every chat skill run inserts one `execution_trace` with all §2
   fields populated (stdout/log_messages included).
2. `error_class` and `outcome_quality` are set deterministically; the apology/loop/transient
   cases from this week's logs classify correctly on replay.
3. The three §6 queries return sane groupings.
4. `estimateHealCost()` returns a figure within ~±30% of a real SkillOpt run's measured spend.
5. Zero new LLM calls; negligible per-run overhead.
