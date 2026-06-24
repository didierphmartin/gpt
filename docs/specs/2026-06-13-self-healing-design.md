# Self-Healing Architecture for SynergyAI — Design Study

**Date:** 2026-06-13
**Status:** Design (no implementation yet)
**Audience:** Human (Didier + Claude). A dense machine-oriented companion exists at
`2026-06-13-self-healing-spec.synth.txt`.

---

## 1. What this is, and what we learned

We want SynergyAI to *self-heal*: detect when something went wrong during a skill or
workflow run, diagnose it, and fix it — looping until resolved where it is safe to do so.

The hard lesson from a week of real debugging (provider naming, `$nodeSuccess`, Gemini
`thought_signature`, OpenAI `include_usage`, the parallel client-tool round-trip) is blunt:
**the fixes that mattered were almost all foundation *code* changes, not skill-text edits.**
A naïve "optimize the SKILL.md" healer would have fixed *none* of them.

That doesn't kill the idea — it *stratifies* it. Different kinds of artifact need different
kinds of healing, with different safety, cost, and autonomy. This document defines that
stratification, the shared data substrate that powers it, and the one piece worth building
first.

---

## 2. The organizing principle: *authorship × mutability*

The right axis is **not** "code vs. not-code." It is **who authors the artifact and how
safely it can be mutated.**

| Layer | Authored by | Mutated by | Blast radius | Cheap revert | Cheap validity gate | Self-heal style |
|---|---|---|---|---|---|---|
| **Skill** (`SKILL.md` + scripts) | LLM | LLM, auto | *all workflows using it* (medium) | `SKILL.md.preopt.bak` | `run_body_eval` | Self-Harness — **textual** |
| **Workflow** (DSL graph + per-node config) | LLM | LLM, auto | *one pipeline* (small) | `.dsl.bak` | `workflow-compile` validator | Self-Harness — **structural** |
| **Foundation** (PHP/JS runtime) | human + Claude | human-merged PR | *everything* (large) | git revert | tests/CI (mostly absent) | **diagnose → verified PR → human merge** |

Two consequences fall out of the table:

- **Blast-radius inversion.** A *skill* edit is shared, so it ripples wider than a *workflow*
  edit, which touches a single instance. Foundation edits are global. This ordering drives the
  healer's choice of *which layer to fix* (§5.4).
- **The validity gate is the real enabler.** Skills and workflows each have a cheap gate that
  rejects bad mutations (`run_body_eval`; the compiler validator). Foundation code has none —
  which is exactly why it cannot be auto-mutated in a loop.

---

## 3. The substrate: one per-execution trace

Everything downstream reads **one** record type: a **per-execution trace** — one structured
JSON per skill/agent execution. In a workflow that unit is a *node*; in chat it is a *skill
invocation*. A node is just the workflow's wrapper around an execution, so the record is
identical across environments.

### 3.1 Invocation modes (the same skill, three ways it can be fired)

| `invocation_mode` | How the skill was selected |
|---|---|
| `auto_discovery` | conversation mode — the LLM matched the **description** |
| `forced` | the skill badge was drag-dropped into the prompt — selection bypassed |
| `workflow_node` | bound to a node — selection fixed by the graph |

`invocation_mode` is **not** mere metadata. Comparing the *same* skill across modes is a
built-in ablation that separates **discovery** failures from **execution** failures:

- fails in `auto_discovery` but succeeds in `forced`/`workflow_node` → the body is fine; the
  **description** is wrong (wasn't picked, or picked for the wrong query);
- fails in `forced` too → the failure is in the **body/scripts** (forcing removed the
  discovery variable);
- fails **only** in `workflow_node` → it is a **workflow-config / harness** issue.

This turns the long-standing "the discovery algorithm is bogus" intuition into a measurable
signal, and it *routes* directly to SkillOpt's two existing loops (§5.1).

### 3.2 Trace schema (target)

```
PerExecutionTrace {
  run_id          # correlates a full trajectory across log lines (MISSING today)
  ts, latency_ms
  invocation_mode # auto_discovery | forced | workflow_node
  env             # chat | workflow
  workflow_id, node_id          # null in chat
  provider, model
  skill_dir, script, argv
  input_snapshot                # exact input the execution received (MISSING today)
  tool_calls[]                  # name, input, round
  skill_exit_code, skill_stdout, skill_log_messages
  output_files[]                # paths written (for verification)
  final_text
  success                       # mechanical flag (NOT quality)
  error_class                   # see §4.1
  error_text
  rounds, round_limit_hit, loop_detected
  tokens_in, tokens_out, cost_usd
  user_action                   # accept | retry | abort  (implicit quality signal)
  outcome_quality               # derived label, see §4.2
}
```

### 3.3 Three readers, three aggregations

Collect one record; slice it three ways.

| Healer | Aggregate by | To find |
|---|---|---|
| **Skill** | `skill_dir` (across all workflows + chat) | general skill-prompt/script weaknesses (DRY) |
| **Workflow** | `workflow_id` + `node_id` | structural/config weaknesses **and** which node to blame |
| **Foundation** | `error_class` / code-site signature | recurring plumbing bugs to localize |

This is why the trace store is the cheap, shared **Phase-0** investment: it is *one* logging
system with three consumers, not three.

---

## 4. The diagnosis & localization layer (the safe, high-value core)

This layer is **read-only** and therefore always safe to run. It is ~80% of the cognitive work
and the single most valuable automatable piece — it is exactly what the instrumentation did by
hand this week.

### 4.1 Weakness classes (the classifier)

Every failure must be put in exactly one bucket, because the bucket decides the fix layer:

| Class | Meaning | Example (this session) | Fix layer |
|---|---|---|---|
| `a_skill_prompt` | model used the skill wrong / description mismatch | probes `-h`, ignores argv | Skill (text) |
| `b_skill_script` | the Python script is wrong | bad `gather_audits` scan | Skill (script — code, isolated) |
| `c_workflow_config` | node provider/topology/forcing/merge wrong | parallel flaky → use sequential | Workflow (config) |
| `d_foundation_code` | runtime/plumbing bug | `include_usage`, `$nodeSuccess`, thought_signature | Foundation (PR) |
| `e_transient_external` | provider outage / rate limit | Gemini 503, OpenAI 429 | none — retry/backoff |

Misclassifying `e` as `a/c` is the classic trap: you cannot fix a 503 with a prompt edit, and
trying wastes tokens. The classifier is what keeps the loop honest.

### 4.2 Outcome quality (because `success != good`)

`success=true` can still be a *bad* answer — the model that returns *"I can't run this, here's
an apology"* is `success:true`. So we derive `outcome_quality` from **free implicit signals**
first, and reserve an LLM judge for the ambiguous minority:

- **free signals:** `skill_exit_code`, `loop_detected`, `round_limit_hit`,
  `output_files` present?, `user_action` (abort/retry = bad; accept = good).
- **LLM judge:** only when `success=true` but a free signal is suspicious.

### 4.3 Localization & routing

The layer emits, per weakness cluster:
- **class** (§4.1) + **provider** + **invocation_mode**;
- **locus**: for code → file/function/line + root-cause hypothesis; for skills → description
  vs body; for workflows → node + knob;
- **`failure_patterns[]`** — the exact text shape SkillOpt's `improve_body` already consumes;
- **candidate eval cases** — a failing real run converted into a regression test (§5.1).

Routing rules:
- `invocation_mode = auto_discovery` → SkillOpt **`run_loop.py`** (description optimizer).
- `invocation_mode ∈ {forced, workflow_node}` & class `a` → SkillOpt **`run_body_loop.py`**.
- class `c` → **workflow healer** (§5.2).
- class `d` → **foundation diagnostician** → verified PR, human merge (§5.3).
- class `e` → retry/backoff; never "fix."
- **Prefer the cheapest *safe* layer that addresses the root cause.** General weakness → fix
  the skill (DRY). Pipeline-specific → fix the workflow. Plumbing → PR.
- **Surface, don't mask.** If a workflow weakness is auto-mitigated by config (e.g. switching a
  flaky parallel run to sequential) *but the root cause is class `d`*, emit a foundation PR
  anyway. Config-healing must never quietly paper over code rot.

### 4.4 The approval gate (cost control)

Diagnosis (§4) is read-only and runs automatically — it is free. **Healing is not.** Because a
healer loop spends real tokens (§7), **no loop runs without explicit user approval.** The system
is *opt-in per heal*.

Flow: `diagnose (auto, free) → estimate → approval overlay → [approve] → heal`.

When the diagnosis layer surfaces a healable weakness (class `a`/`c`), it computes a **pre-run
cost estimate** from the cost model — `calls = Q·R·2·(1+I)+I`, × avg-tokens/call, × the chosen
models' `system_llm_settings` pricing — and shows a brief **overlay dialog**:

- **what's wrong** — one line (e.g. *"`geo-schema` probes `-h` instead of running with the URL
  in `auto_discovery` mode — likely a description weakness"*) + class + provider(s);
- **what will run** — which loop (description / body / workflow), scope (1 vs N providers),
  eval model;
- **estimate** — ~tokens and ~$ (a range; actuals vary);
- **actions** — Approve · Decline · *(optional)* **Approve cheaper** — drop to `R=1`, fewer
  iterations, or a cheaper eval model, showing the reduced estimate live.

On **Approve** → the healer activates. On **Decline** → the finding is still **recorded** (for
later batching / trend analysis) but **nothing is spent**. After the run, the **actual** spend is
reported from the per-node `cost_usd` (estimate vs actual), so the estimate **self-calibrates**
over time.

If several weaknesses are detected, the overlay lists them with per-item and **total** estimates,
so the user can approve selectively against a budget.

---

## 5. The three healers

### 5.1 Skill healer — *this already exists (SkillOpt)*

`Baseline → propose edit → re-eval against eval-set → strict regression gate → accept or
revert`. Two loops: `run_loop` (description) and `run_body_loop` (body). Proposer =
`improve_body` / `improve_description` (one optimizer LLM call/iteration). Gate =
`run_body_eval` (per case: capture transcript + LLM judge, majority-vote over `runs_per_query`).
Revert = `.preopt.bak`. UI = the SkillOpt panel.

**Self-Harness upgrade = swap the signal source, keep the engine.** Instead of failure_patterns
from a hand-authored eval-set, source them from **real traces** (§3) — per provider, and feed
the already-supported-but-unused `success_patterns` input with patterns from providers that
*succeeded* (contrastive learning: "Claude called the tool with the URL; Gemini probed `-h`").
Each mined weakness also becomes a new eval case → the eval-set grows itself (flywheel).

### 5.2 Workflow healer — *new, structural*

Self-Harness applies to workflows too, but the action space is **structural/config**, not
prose:

| Knob | Weakness it fixes |
|---|---|
| topology (parallel ↔ sequential) | flaky parallel round-trip → sequential |
| provider-per-node | Gemini 503-prone here → reassign to Kimi |
| tool_choice / first-round forcing | model probes `-h` → force `run_skill_script` round 1 |
| merge strategy | fan-in garbled → labeled/json |
| max_tool_rounds / budgets | hit round limit → adjust |
| skill binding | wrong skill bound |

Three things make it harder than skill-healing:
1. **action space is combinatorial** (structure, not a line edit);
2. **eval is expensive** — each eval runs the whole N-node pipeline × providers (the priciest
   tier);
3. **credit assignment** — which node caused the bad end-result? **Solved by the per-node
   trace** (node-level success/error/tokens), which also enables the key cost lever:
   **node-isolated re-eval** — re-run only the suspect node against the candidate config, not
   the entire pipeline.

Safety: `.dsl.bak` revert + the **`workflow-compile` validator** as a free structural gate
(it already rejects malformed graphs), plus an end-to-end quality eval for accept/reject.

### 5.3 Foundation diagnostician — *diagnose, don't auto-surgery*

A loop that edits live PHP on a shared backend is **not** recommended. Instead:
- **automate diagnosis & localization** (§4) — safe, high value;
- **draft a fix in an isolated git worktree**, run lint + tests, and **open a PR for human
  merge** — never auto-deploy;
- use **Claude Code / the Agent SDK** as the code-fix executor in the sandbox rather than
  reinventing a coding agent inside SynergyAI.

**Hard precondition: a reproduction + regression harness.** "Loop until fixed" is impossible
without an automated way to *trigger* the failing case and *verify* the fix. This draws the
feasibility boundary:
- **unit-testable PHP logic** (the alias, `$nodeSuccess`, `include_usage`) → a healer could
  realistically own once tests exist;
- **bugs needing a live browser + real provider** (parallel round-trip, 503s) → diagnose-only;
  cannot close the loop headlessly.

---

## 6. What's missing as inputs (the log-quality audit)

The data largely *exists* (much of it wired this week: `cost_usd`, provider, per-round
`[BridgeUsage]`, skill stdout in the node Logs tab). What's missing is *structure and labels*:

1. **No structured trace store** — it lives in flat, **interleaved** `php_error_log` text, with
   **no `run_id`** correlating a trajectory, **encoding** that breaks naïve parsing (the `awk
   multibyte` error), and **stdout truncated** at 2 000 chars.
2. **No outcome-quality signal** — `success != good` (§4.2).
3. **No weakness classifier** — `a/b/c/d/e` (§4.1).
4. **No clean per-provider attribution + the shared-SKILL.md problem** — one file serves all
   six providers, so a Gemini fix can regress Claude → need per-provider eval / conditional
   edits.
5. **No trace→eval-case conversion** — fixes need a regression test; converting failing runs
   into eval cases both validates and grows the suite.
6. **No input snapshot / output-file verification** — needed to replay and judge.

> The biggest missing input is not an algorithm — it is a **structured, classified, per-run
> trace with an outcome label.** Its quality sets the cost (§7).

---

## 7. Cost model (a primary decision factor)

From the code, `run_body_eval` does **2 LLM calls per run** (transcript + judge):

```
calls(skill, provider) = Q·R·2·(1+I) + I
  Q = eval-set size   R = runs_per_query   I = max_iterations
```

Worked example (defaults Q=10, R=3, I=3): `10·3·2·4 + 3 = 243` calls per skill·provider.
**The eval/gate loop is ~99% of calls; the proposer is 3.**

| Configuration | ~Tokens | All-Sonnet | Cheap eval model |
|---|---|---|---|
| 1 skill · 1 provider | ~1.0M | ~$5 | **~$0.6** |
| 1 skill · 6 providers | ~6M | ~$30 | **~$3–4** |
| + per-trace LLM judging (N=200) | +~1M | +$3 | +$0.5 |

**Cost levers, ranked:**
1. **Cheap eval model** (Haiku/Flash/DeepSeek for transcript+judge; strong model only for the
   proposer) — 5–10×, the biggest lever.
2. `R=1` inner iterations, `R=3` only on the final candidate — 2–3×.
3. small targeted eval-sets (trace-driven needs only weakness + regression cases).
4. selective per-provider (optimize only providers with a recurring class-`a/c` weakness).
5. **deterministic mining** — free *iff* traces are structured + error-signatured; otherwise an
   LLM reads raw logs (expensive + noisy). **This is the log-quality ↔ cost link.**
6. **implicit outcome signals** — free; reserve the judge for the ambiguous minority.
7. **node-isolated re-eval** (workflows) + cached baseline + SkillOpt's existing early-exits.

**Cost ordering:** skill-healing cheap · workflow-healing expensive (mitigate via credit
assignment + node-isolated re-eval) · foundation-healing is *not a loop at all*.

This same formula computes the **pre-run estimate** shown in the approval overlay (§4.4); the
**actual** spend is reconciled afterward from per-node `cost_usd`, so estimates self-calibrate.

---

## 8. Safety invariants

1. Every auto-mutated artifact has a **cheap revert** (`.preopt.bak`, `.dsl.bak`).
2. Every auto-mutation passes a **cheap validity gate** before the quality gate
   (`run_body_eval`; compiler validator).
3. **Foundation code is never auto-applied** — diagnosis + PR + human merge only.
4. **Config-healing must surface masked foundation bugs** — mitigation never hides root cause.
5. Prefer **auditable text/structure diffs** over opaque parameters (this is why SIA's
   weight-updates are rejected, §10).
6. Class-`e` (transient/external) is **never** "fixed" — only retried.
7. **No healer loop runs without explicit user approval** (§4.4) — every spend is gated by an
   overlay showing the problem and a token/$ estimate. Declines cost nothing and are still
   recorded. Diagnosis is exempt (free, read-only).

---

## 9. Phasing & recommendation

- **Phase 0 — enabling (cheap, do first):** the **per-execution trace store** + **classifier**
  + **implicit outcome labels**. Pure plumbing over data we already emit; unlocks cheap
  deterministic mining and powers all three healers.
- **Phase 1 — skill self-harness:** `mine_weaknesses.py` → provider-tagged `failure_patterns`
  → existing `improve_body`; single-provider; **dry-run** (propose, don't apply); `run_loop`
  vs `run_body_loop` routed by `invocation_mode`. Ships the **approval overlay** (§4.4) — the
  first point at which a loop could spend.
- **Phase 2 — breadth:** per-provider loop + provider-conditional edits + `success_patterns`
  contrastive hook + trace→eval-case flywheel; then the **workflow structural healer**.
- **Phase 3 — foundation diagnostician (gated):** localize → verified PR via Claude Code /
  Agent SDK in a sandbox; **requires the reproduction + regression harness** first.

**Recommendation:** build Phase 0 now. It is the cheapest, safest slice; it reuses the
`cost_usd`/provider/log data already wired in; and it is the bottleneck this week exposed —
without a structured, classified, labeled trace, *nothing* downstream is affordable or
trustworthy.

---

## 10. Why not SIA (harness weight updates)

SIA tunes opaque numeric "harness weights" instead of editing text/structure. For a *product*
this trades away the one property that makes the rest safe: **auditable diffs + cheap revert.**
Weights are hard to inspect, hard to roll back, and drift-prone. Self-Harness (textual for
skills, structural for workflows) is the right model; SIA is research, not production.
