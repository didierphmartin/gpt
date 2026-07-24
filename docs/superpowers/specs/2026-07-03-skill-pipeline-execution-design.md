# Skill Pipeline Execution — Design Spec

**Date:** 2026-07-03
**Status:** Approved (design)
**Scope:** How a workflow agent node executes its skill(s), across the browser **interpreter**, the **LangGraph** compiler, and the **ADK** compiler.

---

## Goal

Make skills execute as **mandatory, ordered post-processing steps on the agent's result** — the same behavior in all three targets — instead of the current "optional tool the model may skip." One sentence: *a skill is not a tool the agent chooses; it is a guaranteed step that runs after the agent's functions and transforms the agent's output.*

---

## Grounding: the Agent Skills spec

A skill is a folder whose only required file is `SKILL.md`; everything else is optional and loaded on demand:

```
<skill-dir>/
├── SKILL.md        # REQUIRED — YAML frontmatter + markdown instructions
├── scripts/        # optional — executable code (RUN, not read into context)
├── references/     # optional — extra .md docs (READ on demand)
└── assets/         # optional — templates/resources
```

`SKILL.md` = YAML frontmatter (**required:** `name` kebab-case, `description`; **optional:** `license`) + a markdown instruction body.

**Progressive disclosure — three levels:**
1. **Metadata** (`name`/`description`) — discovery/triggering only.
2. **`SKILL.md` body** — loaded into context only when the skill is active; the instructions.
3. **Bundled resources** — `references/*.md` are read into context on demand; `scripts/*.py` are executed without being read into context — *only when `SKILL.md` calls for them*.

Implication: a skill is **always** an LLM following `SKILL.md` that *may* pull a reference or run a script exactly when its own instructions say to. There is no separate "markdown-only vs script" path.

---

## The execution algorithm (the contract)

For **every** node:

1. **System prompt** (from the agent form) → context. If the node ends a **fan-in**, the **merged parent content** is included too.
2. **Functions / MCP tools** — the agent LLM runs and *may* call its selected tools (the agent's **choice**, unchanged). Produces the agent's **result**.
3. **Skill step(s)** — a **guaranteed** stage on the agent's result. Each skill is one step: an LLM on the **node's own model**, instructed by the skill's live `SKILL.md`, **seeded by the previous stage's output**, able to run that skill's `scripts/` and read its `references/` on demand. Multiple skills = a **pipeline** (step 1 out → step 2 in → …); the last output is the **node's result**.

**"Mandatory" means** step 3 always runs and always consumes the agent's result. Whether a script fires inside a step is driven by that skill's `SKILL.md` — nothing is force-called, so **no `tool_choice` forcing is needed** (this is why it is implementable in ADK, whose LiteLLM adapter has no tool-forcing).

**Why this fixes GEO:** today the HTML/skill step is an optional tool the model ignored → markdown output. As a guaranteed post-step seeded by the agent's result, the HTML skill always renders → HTML.

---

## Current state and the gaps

- A node stores a **single** `bound_skill` on `config`: `{ id, source, dir_name, name, description }` (`workflow-editor.js:13098`, save `:13887`). No list, no order today.
- New saves write `skill_content: ''` — `bound_skill` is the source of truth (`workflow-editor.js:13893`). Persisted in `workflow_nodes.config` JSON (`WorkflowGraphRepository.php:116`).
- Skill files live on disk at `synergy/skills/<dir>/` — `synergy` is the browser's W3C File-System-Access root (= the tree the runner already reads via `SKILLS_DIR`).
- **Gap 1:** `WorkflowGraphAnalyzer.php:243` surfaces only `skill_content` (a string, now empty) and is **blind to `bound_skill`** — the compiler can't see the skill.
- **Gap 2:** both compilers add `run_skill_script` to the model's `tools=[…]` as an **optional** tool (verified) — never a mandatory post-step.
- **Gap 3:** the interpreter makes the skill mandatory but in the **wrong place** — forces `tool_choice=run_skill_script` on the model's *first* turn (`ChatController.php:1578-1610`), so the skill runs before the result, not on it.

---

## Scope & phasing

- **Phase 1 (this update):** the **single** `bound_skill` a node supports today, executed as a mandatory post-agent step in all three targets. Written **pipeline-ready** (an ordered list of length 1) so N skills need no engine rework.
- **Phase 2 (separate, future):** agent-form UI to attach **multiple** skills with **priority/order**; it writes an ordered list; the engines already handle N.

---

## Design

### A. Analyzer — surface the skill binding (dir only)

Each agent carries an **ordered list of skill dirs** (length 1 today):

```
'skills' => [ 'GEO/geo-report' ]      // from bound_skill.dir_name (Phase 2: bound_skills[])
```

- Read `config.bound_skill.dir_name` (Phase 2: `config.bound_skills[].dir_name`, in order).
- **No content resolution** — the compiler needs only the `dir_name`. Legacy `skill_content` (old inlined workflows) maps to a synthetic single entry that carries its text inline instead of a dir.

### B. Skill content source — resolved: read live from disk at runtime

Following progressive disclosure, the generated program **does not embed skill content**. Each skill step reads the live `SKILL.md` from `synergy/skills/<dir>/SKILL.md` at runtime as its instruction, and runs `scripts/` / reads `references/` on demand from the same folder — which the Python env already has (`SKILLS_DIR`). Editing a `SKILL.md` is reflected without recompiling. No `client_skills` needed at the generate endpoints.

### C. Per-framework execution (idiomatic per target)

**Shared skill-step shape:** an LLM on the node's model, `instruction = <live SKILL.md for dir>`, tool = `run_skill_script` **scoped to that dir**, input = previous stage's output, output = its result. A skill with no `scripts/` simply never calls one.

- **ADK** → skill node compiles to `SequentialAgent([ main_agent, skill_1, …, skill_N ])`. `main_agent` = current `LlmAgent` **without** `RUN_SKILL_SCRIPT_TOOL`. Each `skill_k` = an `LlmAgent` (node model), instruction read from `SKILL.md` at construction, `tools=[<dir-scoped run_skill_script>]`, reads prior `session.state`, writes `output_key`; the last writes the node's `output_key`. No `tool_config`/forcing.
- **LangGraph** → the node function runs `main_agent` (minus the skill tool), then threads the result through each skill step in order (LLM with `SKILL.md` as system + dir-scoped `run_skill_script`), returning the last output as the node's channel value.
- **Interpreter** → run the main agent with system prompt + functions **only** (drop the forced first-turn `run_skill_script`); then run the skill pipeline on its result — each skill an LLM turn instructed by its `SKILL.md`, dir-scoped `run_skill_script`, seeded by the prior output.

### D. `run_skill_script` scoping

Inside a skill step the tool is bound to that skill's `dir_name`, so the LLM only picks *which script within the skill* and *with what args*, per the markdown. (Today `run_skill_script(dir_name, script, argv)` — the step supplies `dir_name`.)

---

## Non-goals / future

- Multi-skill attach + ordering UI in the agent form (Phase 2).
- Changing what individual skill scripts read as input beyond "the previous stage's output, delivered framework-optimally."
- Gathering-style skills needing a raw external parameter not present in the flow — treated separately if a real case arises.

---

## Resolved decisions

1. **Skill source:** read live from disk at runtime by `dir_name`; analyzer surfaces only `bound_skill.dir_name`. No embedding, no `client_skills` at generate.
2. **MD-only skill model:** the skill step uses the **node's own model/provider**.
3. **Phasing:** Phase 1 = single skill, built pipeline-ready; multi-skill + priority deferred to the future form-UI task.
