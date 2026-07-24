# Skill Genesis — Three-Class Procedural Learning over the Knowledge Ladder

**Date:** 2026-07-14 (v3 — reorganizes v2 around the three candidate classes; v1 "episode miner"
remains rejected, see §13)
**Status:** Design (no implementation yet)
**Audience:** Human (Didier + Claude).
**Companions:** `2026-06-13-self-healing-design.md` (Self-Harness), `2026-06-13-phase0-trace-store.md`,
the Hermes memory stack (`MemoryAutoUpdater` / `MemoryExtractor` / `UserMemoryRepository`), the
SkillOpt loop (`skills/skill-creator/scripts/`), and the workflow DSL + editor test runtime
(`workflow-compile`, `GraphWorkflowRunner`).

---

## 1. What this is

The platform's learning mechanisms cover two of four quadrants:

|  | **Corrective** (fix what exists) | **Generative** (create what's new) |
|---|---|---|
| **Declarative** (facts, preferences) | Hermes merge/compact | ✅ Hermes memory auto-extraction |
| **Procedural** (how to do things) | ✅ Self-Harness (SkillOpt heal loop) | ❌ **this document** |

Skill genesis fills the empty quadrant by **promotion, not by a new learning stack**: knowledge
climbs a ladder — cheap capture → demonstrated demand → durable, executable, eval-guarded
artifact — and only pays each rung's cost after proving itself on the previous one.

```
capture      (free / near-free)      →  validate (recurrence)  →  encapsulate (skill/workflow)
memory line, run-history row, session pattern → candidate      →  SKILL.md [+ workflow DSL]
```

Division of labor is exact: capture + validation are new (small); creation, storage/execution,
and maintenance are the existing skill-creator, catalog/Pyodide, `GraphWorkflowRunner`, and
Self-Harness — untouched.

**Three representations, one path:** memory lines are the *capture* representation, the workflow
DSL is the *procedural* representation (declarative, parameterizable, agent-node-rich), and
SKILL.md is the *discovery* representation (auto-routing triggers on skill descriptions — nothing
else in the system is auto-discovered). Every born artifact is therefore a SKILL.md, whose body is
either a script or a reference to a (possibly newborn) workflow.

**The end-state view — the polyglot skill.** A skill in this architecture is a bundle of
declarative artifacts, each interpreted by a different engine, with the LLM as the binder that
reads them all: markdown → the LLM (intent, discovery), DSL → the workflow engine (structure
fixed, parameters free), Python → the Pyodide sandbox (deterministic computation), mermaid → both
humans and models (the shared explanation view). Each representation sits at an altitude on the
flexibility↔determinism axis, and **promotion is the act of moving knowledge down that axis as
certainty increases** (NL line → DSL graph → exact script). Discipline that keeps eval guarantees
intact: wrapped DSL is a *template* — parameter injection into declared placeholders only, at run
time; **structure changes go exclusively through promotion/healing where evals gate them**. A
skill must never arbitrarily rewrite its DSL at run time.

### 1.1 Why promotion beats memory-only learning (the case for building this)

Hermes-style memory — also where competing assistants' memory features stop — tops out at
*remembered advice*. Promotion converts learning into things a memory system categorically cannot
produce:

1. **Capability, not advice.** A memory line is prose the model may follow loosely, differently
   per provider, or drop under context pressure. A born skill is sandboxed code; a born class-2
   skill is a proven workflow graph executing server-side.
2. **Learning that escapes the context budget.** Memory pays for every learned line on every turn,
   forever, inside a budget cap (~a dozen procedures, total). Skills load on demand — the class-1
   pointer rewrite literally converts always-paid tokens into pay-on-use artifacts. Memory
   learning *saturates*; promoted learning *compounds*.
3. **A QA loop.** A memory line is never tested and never improves. A born skill passes evals
   before existing, accumulates mined eval cases from continued usage, and is maintained by
   Self-Harness when it degrades — validated at birth, monitored in life.
4. **Behavioral ground truth.** Memory learns from what the user *said*; the class-2 sensor learns
   from what the user *did repeatedly*. That signal exists here only because the learning system
   sits next to an execution substrate (run history, traces).
5. **Reach.** A memory line exists inside one user's chat prompt. A born skill works in chat,
   workflow nodes, agents, the scheduler, and the API — and is one policy decision away from
   team-shareable (enterprise angle: "turns your team's repeated work into governed, auditable
   automations" is a differentiated claim; assistant memory is not).

The flywheel this enables — use → learn → automate → the automation itself is used, learned from,
healed, and composed into larger procedures (class 3) — is the strategic payoff. Hermes remains
better at immediacy, zero cost, and everything declarative, which is exactly why it is the capture
rung rather than a competitor: **Hermes learns knowledge; promotion compounds it into capability.**

---

## 2. The three candidate classes — the organizing frame

|  | **Class 2 — workflow habit** (build FIRST) | **Class 1 — chat procedure** | **Class 3 — meta-procedure** (build LAST) |
|---|---|---|---|
| What recurs | manual runs of an existing workflow | improvised multi-step tool use in chat | a routine *spanning* artifacts: workflow run → follow-up prompts → maybe another workflow |
| Sensor | **SQL over run history — free, no LLM** | Hermes extractor (per-turn, free-rides the existing memory call) | session-level correlation of chat traces + workflow runs |
| Demand evidence | strongest (user *built and repeatedly ran* it) | medium (inferred from prose) | weakest (interleaving has many one-off causes) |
| Generalization | **diff across runs → parameters** | paraphrase → `WHEN/DO` line | factor the recurring *sequence* into a graph |
| Born artifact | skill **wrapping the parameterized existing workflow** | plain skill (script body) | **new workflow** whose nodes reference existing workflows/skills, + wrapper SKILL.md |
| Autonomy ceiling | `auto` (after proving) | `auto` (after proving) | **`ask` permanently** |
| Phase | **L1** | L2 | L3 |

Phasing is deliberately inverted from discovery order: class 2 has the cheapest sensor and the
strongest signal, so it proves the shared promotion pipeline (§6) before any Hermes extension or
correlation mining exists.

---

## 3. Class 2 — workflow-habit candidates (L1)

### 3.1 Sensor — one query, no LLM

`agent_workflow_executions` + `workflow_node` traces already record every run per user, per
workflow, with timestamps and `input_variables` (JSON — the parameterize-by-diff input). A
candidate is:

```
runs of workflow W ≥ genesis_promotion_threshold within genesis_promotion_window_days
AND W not already wrapped by a born skill
```

**All trigger origins count — no cron/manual distinction.** A scheduled workflow is demand
*already crystallized into automation*; promoting it is still valuable because promotion is what
upgrades it from fixed behavior to a versatile, parameterized artifact. The benefit lands at
**prompt-writing time**: once wrapped, a plain chat prompt auto-discovers the skill and runs the
workflow with parameters extracted from the prompt — no editor, no manual trigger (and the wrapper
is equally referenceable from agent nodes). The only exclusion is "already wrapped", which the
born-skill check covers — so no trigger-origin column is required (implementation-fitness win:
`createExecution` stores no origin today, and now doesn't need to).

### 3.2 Generalization — parameterize by diff

The reflection pass (same weekly job as §4.3, but for this class it has structured input) diffs
the node configs and input prompts across W's recent runs:

- **varied across runs** (research topic, sources, tone, output length…) → parameters, each with
  the observed value set as examples;
- **constant across runs** (graph shape, merge strategies, publisher format…) → stays baked in.

**Uniform run histories (typical for cron-triggered workflows) give the diff nothing** — so
parameterization has a second source: **graph inspection**. Because the workflow is a declarative
DSL document (not opaque code), the reflection model can read the node instructions and lift
hardcoded literals into candidate parameters ("research *crypto and biomed* news" → param
`topics`, default = the current literals). Variance-based parameters are high-confidence
(observed); inspection-based ones are proposals the approval overlay marks as such. This is the
concrete payoff of the declarative representation: generalization is a *read*, not a
reverse-engineering exercise.

Output: a parameter schema + per-node injection map ("param `topic` → node 3 instructions
placeholder"). The DSL is already declarative and agent-node-rich enough to carry this; no DSL
changes required. The workflow itself is edited only by *adding placeholders* — behavior with
default parameters must equal current behavior (validated in §3.4).

### 3.3 Born artifact — thin skill over the proven graph

```
skills/<name>/
  SKILL.md        ← description mined from the runs' actual trigger phrasings
                    ("WHEN asked to compose a newsletter/digest about a topic …");
                    documents parameters (name, type, examples, default)
  scripts/run.py  ← extract parameters from prompt/argv → inject into node configs →
                    compile-validate → submit (realtime or deferred) → relay output
  workflow_ref    ← REFERENCE to workflow_id W (never a copy)
```

Reference-not-copy keeps editor edits flowing through and splits healing cleanly: description
faults → `run_loop` (textual); execution faults → the workflow's own structural path
(`workflow-compile` validator + editor test runtime + `.dsl.bak` revert — the Self-Harness
"structural" row, exactly as stratified in the 2026-06-13 design). Guard against parameter drift
(an editor edit removes a parameterized node): `run.py` compile-validates before every submission
and fails with a "re-promote me" message rather than running a broken injection.

### 3.4 Eval-first birth — against production history

The strongest eval story of the three classes, because ground truth exists:

- **description evals:** positives = the real prompts/inputs of the historical runs (plus light
  paraphrases); negatives = other skills' trigger queries + recent non-matching messages. Standard
  `run_loop.py` `{query, should_trigger}` contract, unchanged.
- **body eval:** replay the parameterized workflow in the editor's test runtime on 2–3 historical
  inputs; judge output against rubrics derived from the outputs the user actually accepted.
  Additionally: default-parameter replay must match the unparameterized workflow's output shape
  (the §3.2 invariant).

---

## 4. Class 1 — chat-procedure candidates (L2)

### 4.1 Rung 1: the PROCEDURES scope (Hermes extension)

`UserMemoryRepository` gains a third scope beside `memory` (2200) and `user` (1375):

```php
public const SCOPE_PROCEDURES = 'procedures';
public const BUDGET_PROCEDURES = 1800;   // ~12–15 lines
```

Same table, budgets/compaction, audit trail (`user_memory_events`), manual editability. Line
shape (the extractor is prompted to produce it; `WHEN` is trigger-shaped on purpose — it seeds the
future skill description and makes eval synthesis mechanical):

```
- WHEN <trigger paraphrase> DO <step; step; step> [PREFS <user-specific constants>]
```

`MemoryExtractor` stage-1 gains the classification rule (style of the existing "biographical →
USER" rule): a repeatable multi-step procedure (≥ 2 tool/skill/analysis steps chained toward an
outcome likely to recur) goes to PROCEDURES, **generalized** (parameters, not literals). Stage-2
treats a re-observed procedure as **reinforcement** — merge into the existing line, write a
`user_memory_events` row with `source='auto_procedure_reinforce'`. **The events table is the
recurrence counter** — no new tables, no clusterer. Implementation-fitness note: this needs two
ENUM extensions (`scope` += `'procedures'`, `source` += `'auto_procedure_reinforce'`) **plus a
`line_prefix VARCHAR(160) NULL` column** — events store before/after content blobs today, so
per-line counting without the column would mean diffing blobs.

Free skip-checks before any LLM cost: < 2 tool/skill invocations → skip; the turn was one existing
skill doing its whole job → skip (heal's territory); run failed or the verifier flagged the
response → skip (genesis learns from *success* — the exact complement of the heal sensor).

Injection: the PROCEDURES block joins MEMORY and USER in the chat system prompt (Layer 1). Effect
is immediate — the next conversation follows the recorded procedure with no skill existing yet.
Workflow runs do NOT inject PROCEDURES (agents have explicit configs). Rung 1 has **no gate on
purpose**: it spends nothing beyond the extractor call Hermes already makes and mutates only a
budget-capped, user-visible, clearable block. Risk lives at promotion; controls live there.

### 4.2 Validation

A line is validated by *surviving*, not by being counted at birth: it stayed through compaction
(budget pressure evicts weak lines — the existing compactor is the forgetting mechanism) and its
reinforcements reached `genesis_promotion_threshold` within the window.

### 4.3 The weekly reflection job

One strong-model pass per active user (`SchedulerController`, both backends;
`genesis_reflection_provider`, default the long-context model):

```
input : PROCEDURES block + reinforcement events (window) + skill catalog (names+descriptions)
        + last-week conversation summaries — NOTE: no standing per-conversation summary store
          exists; reuse SessionSearchService's 400-token summarizer at reflection time (bounded:
          ~400 tokens × active conversations; this is the dominant token term of the job)
        + class-2 candidates (structured: workflow, run count, config diffs)
        + class-3 session patterns when L3 is live
output: up to 3 promotion proposals
        { class, line_prefix|workflow_id|sequence, skill_name, description,
          eval_queries: [{query, should_trigger}], parameter_schema?, merge_target?, est_cost_usd }
```

**Merge-router rule (all classes):** if an existing skill already covers the procedure, the model
MUST return `merge_target` instead of a new name — the eval queries are appended to that skill's
eval set and surfaced in the SkillOpt panel ("+N eval cases mined from your usage — re-optimize?").
No new skill. This is what protects auto-discovery from catalog bloat.

Born class-1 skills: after PASS, the PROCEDURES line is **rewritten to a pointer**
("- WHEN … DO use skill <name>") — freeing budget and preventing re-proposal.

---

## 5. Class 3 — meta-procedure candidates (L3)

The elaborate case: the user's routine spans artifacts — e.g. run the newsletter workflow, then
prompt-critique the draft against style notes, then regenerate the intro.

- **Sensor:** session-level correlation. Chat traces and workflow runs share session/run
  correlation ids; a recurring *sequence signature* (ordered multiset of workflow-ids +
  chat-procedure line-prefixes within a session, repeated across ≥ `threshold+1` sessions with
  high sequence similarity) becomes a candidate. This sensor has the weakest signal-to-noise —
  interleaving has many one-off causes — hence the stricter constants below.
- **Generalization:** factor the sequence into a graph. Each stage becomes a node **referencing**
  the existing piece: a node wrapping workflow W (class-2 mechanics), an agent node carrying the
  recurring critique prompt, etc. The merge-router runs *per node* — a stage either references an
  existing skill/workflow or (rarely, gated) births a small one. Emit simplified JSON →
  `compile.py` → DSL.
- **Born artifact:** a new workflow + wrapper SKILL.md (class-2 shape, §3.3).
- **Constraints (permanent, not phase-gated):** `ask` only — never `auto`; recurrence threshold
  `genesis_meta_threshold` (default 5, always ≥ class-1/2 threshold + 2); the correct failure mode
  is "suggested and dismissed," never "auto-built." Eval: description evals standard; body eval =
  staged test-runtime replay per node against per-stage rubrics (weakest of the three — another
  reason for the permanent `ask`).

---

## 6. Shared promotion machinery (all classes)

**No changes to `skills/skill-creator/scripts/*`.** Client-orchestrated (`genesis-panel.js`,
sibling of `heal-panel.js`), exactly like a heal run:

```
proposal(approved) → POST /genesis/authorize {promotion_id, estimate_usd}
                       └ gate: mode, daily budget (kind='genesis'), per-skill ceiling,
                         weekly born-count throttle, class-3 ask-only
  → scaffold : stage /scratch/<name>/ (SKILL.md draft; script stub or run.py wrapper;
               class-2/3: parameter injection map), then create_skill.py --name <name>
  → harden   : run_loop.py with the synthesized eval set; body gate per class
               (§3.4 / run_body_loop.py / §5) — providers + iterations from the EXISTING
               heal_proposer/eval/judge settings (not duplicated)
  → verdict  : PASS → install to catalog, status='born' (+ class-1 pointer rewrite)
               FAIL → status='failed', /scratch artifacts kept, spend recorded
  → POST /genesis/record {promotion_id, actual_usd, outcome}
  → audit    : user_memory_events row → the unified learning timeline
```

One new table serves all classes:

```sql
CREATE TABLE skill_promotions (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NOT NULL,
  class          TINYINT NOT NULL,             -- 1 | 2 | 3
  status         ENUM('proposed','approved','building','born','merged','dismissed','failed')
                 NOT NULL DEFAULT 'proposed',
  source_ref     VARCHAR(191) NOT NULL,        -- line_prefix | workflow_id | sequence signature
  skill_name     VARCHAR(120) NOT NULL,
  description    TEXT NOT NULL,
  eval_queries   JSON NOT NULL,
  parameter_schema JSON NULL,                  -- class 2/3
  merge_target   VARCHAR(120) NULL,
  est_cost_usd   DECIMAL(8,4) NULL,
  born_skill_dir VARCHAR(120) NULL,
  created_at     DATETIME NOT NULL,
  decided_at     DATETIME NULL,
  UNIQUE KEY uq_user_skill (user_id, skill_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Manual on-ramp (L0, ships before everything):** conversation context-menu "Create skill from
this conversation" — the §6 pipeline seeded from one transcript (reflection prompt run once, on
demand). Zero learning infrastructure; labels which procedures users consider skill-worthy.
Its class-2 twin: a "Promote to skill…" button on the workflow editor's run panel.

---

## 7. Server enforcement (both backends)

`HealController` generalizes: `authorize/record/status` gain `kind ∈ {heal, genesis}` (default
`heal`); the ledger gains the column:

```sql
ALTER TABLE heal_spend ADD COLUMN kind ENUM('heal','genesis') NOT NULL DEFAULT 'heal';
```

Routes (PHP first, TS mirror, same envelopes):

```
GET  /api/v1/genesis/promotions               list (panel + suggest mode; ?class= filter)
POST /api/v1/genesis/authorize                {promotion_id, estimate_usd, approved?}
POST /api/v1/genesis/record                   {promotion_id, actual_usd, outcome}
POST /api/v1/genesis/promotions/{id}/dismiss
GET  /api/v1/settings/genesis
POST /api/v1/settings/genesis
```

`authorize` is authoritative (a client bug can never spend): mode ≠ off; `ask` requires
`approved:true` on the second call (heal-overlay two-step); `auto` additionally requires estimate
≤ ceiling, day-spend + estimate ≤ budget, born-this-week < throttle — and **class 3 rejects
`auto` unconditionally**. The weekly reflection call meters into the same ledger; if reflection
alone would exceed 20% of the daily budget it is skipped that day — the sensor must never starve
the factory.

---

## 8. Settings — the Auto tab "Self-learning" block

New `users.genesis_*` columns (lazy ALTER probe in PHP `SettingsController`, the heal pattern; TS
reads only). The tab reads as three sections with autonomy proportional to blast radius: **Heal**
(exists) · **Learn** · **Promote**.

| Column | Default | UI |
|---|---|---|
| `genesis_learn_procedures` | 1 | **Procedural memory [ON/OFF]** — master switch for class-1 capture. OFF: extraction into PROCEDURES stops; lines stop growing, remain clearable in the memory panel. |
| `genesis_mode` | `off` | **Skill promotion** `off \| suggest \| ask \| auto` — governs ALL classes (class 3 capped at `ask` by the server regardless). Independent of `heal_mode`; recommended pairing heal=auto, genesis=ask. `suggest` = list proposals, never build. When `off`, the class-2 SQL sensor and reflection job do not run. |
| `genesis_daily_budget_usd` | 3.00 | reflection + scaffold + harden, per day |
| `genesis_per_skill_ceiling_usd` | 1.50 | `auto` builds only under this estimate |
| `genesis_promotion_threshold` | 3 | recurrences before promotable (classes 1–2) |
| `genesis_meta_threshold` | 5 | class-3 recurrence floor (server-enforced ≥ threshold+2) |
| `genesis_promotion_window_days` | 30 | recurrence window |
| `genesis_max_skills_per_week` | 2 | catalog-growth throttle |
| `genesis_reflection_provider` | `kimi` | long-context model for the weekly job |

Not duplicated: proposer/eval/judge providers and iteration counts — rung-3 hardening reads the
existing `heal_*` settings. UI note: `genesis_learn_procedures` OFF grays the promotion section
only for class-1 sources; class-2 (workflow habit) promotion remains available since its sensor is
usage history, not memory capture.

---

## 9. Frontend

1. **Settings → Auto tab:** the Self-learning block (§8), same visual grammar as heal; i18n
   `genesis.*` (en/fr/es).
2. **Memory panel:** PROCEDURES block shown like the other scopes (edit, clear, events history).
3. **`genesis-panel.js`** (new; shared overlay/toast helpers extracted to `heal-ui-common.js`):
   promotion list grouped by class ("`composed-newsletter` — workflow ran 9×, est $0.90 · class 2"),
   approve/dismiss overlay, build progress via the SkillOpt Pyodide monitor.
   `window.genesisSystem = { scan, buildOne, dismiss }`.
4. **`skillopt-panel.js`:** "+N eval cases mined from your usage" on merge-target skills, with a
   re-optimize shortcut.
5. **On-ramps:** conversation context-menu "Create skill from this conversation"; workflow editor
   run-panel "Promote to skill…".
6. **Unified learning timeline:** memory events + procedure reinforcements + births + heals in one
   history view.

---

## 10. Backend build plan (PHP first — source of truth; TS mirrors)

**PHP:** class-2 sensor query + `GenesisController` (§7 routes) + `skill_promotions` +
`heal_spend.kind` + `users.genesis_*` migrations · `ReflectionJob` (scheduler task) ·
`UserMemoryRepository` third scope + `MemoryExtractor` prompt/merge rules + `MemoryAutoUpdater`
skip-checks + `ChatController` PROCEDURES injection (L2) · session-correlation query (L3) ·
`HealController` `kind` generalization · `SettingsController` genesis block.

**TypeScript:** ports of the above. Standing prerequisites (already on the known-gaps list):
`POST /api/v1/agent` (the Pyodide improve/create scripts call it — hard prerequisite for rung 3
and for heal on Node) and the post-`res.end()` fire-and-forget hook (build once; shared with the
pending Hermes chat-memory port, which is itself the carrier for L2 on Node).

Implementation-fitness notes (from the 2026-07-14 code review of this spec):
- `improve_description.py` hardcodes `AGENT_ENDPOINT = "/gpt/backend/api/v1/agent"` — porting
  `/agent` to Node is necessary but NOT sufficient; the pyodide-runner bridge must inject the
  active API base or Node-mode heal/genesis silently calls PHP.
- `SchedulerController` is a cron trigger for scheduled *workflows*, not a generic job framework —
  the weekly reflection needs a new task type (or its own cron-hit endpoint), both backends.

Shared MySQL: settings, promotions, ledger, and the PROCEDURES block work identically from either
backend the moment both expose the routes.

---

## 11. Phasing

- **L0 — manual on-ramps (weekend-sized).** The two buttons (§6). No learning infrastructure;
  proves the §6 pipeline end-to-end and labels real demand.
- **L1 — class 2.** SQL sensor + parameterize-by-diff + wrapper birth + gate/ledger +
  genesis-panel. Cheapest sensor, strongest signal — proves promotion on production truth.
- **L2 — class 1.** PROCEDURES scope + extractor changes + injection + ON/OFF toggle + weekly
  reflection + `suggest → ask → auto` progression. Two weeks of L2 data answers: *do reinforced
  procedure lines actually accumulate?*
- **L3 — class 3.** Session-correlation sensor, per-node merge-router, `ask`-only. Build only if
  L1+L2 usage shows real cross-artifact routines.

---

## 12. Risks and controls

| Risk | Control |
|---|---|
| Catalog bloat degrades auto-discovery for all skills | merge-router at proposal (and per-node in class 3); weekly throttle; eval-set negatives at birth; class-1 pointer rewrite |
| Hallucinated / wrong skills | eval-first birth for every class; class-2/3 evals replay production history; `ask` default; class-3 `ask` permanent |
| Wrong procedure lines polluting prompts | budget compaction; user-visible/editable block; ON/OFF master switch |
| Parameter drift (editor edits break a wrapper) | `run.py` compile-validates before every submission; fails with "re-promote" instead of running broken injection |
| Cost creep | class-2 sensor is free SQL; class-1 capture free-rides the existing extractor call; one weekly reflection with a 20% budget cap; hard gate on builds |
| Privacy | class-1 knowledge lives in the user's own memory block; class-2/3 sensors read the user's own run history; everything per-user, nothing cross-user |
| Class-3 false patterns | strictest threshold, sequence-similarity requirement, permanent `ask`; "suggested and dismissed" is the designed failure mode |
| Model ignores procedure lines under context pressure | acceptable at rung 1 — that is what promotion fixes |

---

## 13. Lineage

**Kept from v1/v2:** eval-first birth; the merge-router; the gate/ledger pattern (`kind` column,
authorize/record two-step); heal=auto + genesis=ask pairing; SkillOpt scripts reused unchanged;
the `/api/v1/agent` + post-response-hook prerequisites; the PROCEDURES scope and reflection job
(v2). **v3 adds:** the three-class taxonomy as the organizing frame; class 2 (workflow habit —
SQL sensor, parameterize-by-diff, wrapper-over-reference) and its promotion to first place in
phasing; class 3 (meta-procedures) with permanent `ask`; the workflow-editor on-ramp.
**Rejected (v1):** the per-turn episode miner + embedding clusterer + `procedural_episodes` /
`skill_candidates` tables — paid per-turn LLM+embedding cost for a signal Hermes reinforcement and
run history produce free; clustered worse than a long-context reflection pass; stored raw
transcripts (worse privacy than user-visible memory lines); guessed demand instead of demonstrating
it. If L2 data shows procedures too diverse for single memory lines, a miner can return as a
rung-2 refinement without changing the promotions table or gate.

## 14. Open questions

1. Merge proposals: auto-heal the target skill in `auto` mode, or always surface in the SkillOpt
   panel? (Leaning: surface in `ask`, auto-heal in `auto` — one knob.)
2. Class-2/3 approval overlay content: show the parameter diff table ("these varied across your
   9 runs") plus the proposed graph rendered as a **mermaid diagram** (`mermaid-renderer.js`
   already ships) — the human-review view of the same structure the engine will interpret.
   (Leaning: yes to both — best possible explanation of what is being approved, essentially free.)
3. Cross-provider hardening for newborns: default provider only, or the provider mix observed in
   the source runs/conversations? (Leaning: observed mix — matches the heal loop's
   "failing provider as evaluator" principle.)
4. Should Verify-mode verdicts gate class-1 capture (don't learn from flagged responses)?
   (Leaning: yes — free skip-check, already listed in §4.1.)
5. Scheduler interplay: a born class-2 skill makes its workflow one prompt away — should the
   approval overlay also offer "…or schedule it weekly" (existing scheduled-workflow feature) when
   run timestamps show periodicity? (Cheap, high-delight.)
