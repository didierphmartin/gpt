# Skill Genesis: Recurrence-Gated Promotion of Conversations and Multi-Agent Workflows into Compiled, Eval-Guarded Skills

**Didier Martin** · SynergyAI
*Draft — July 19, 2026*

---

## Abstract

Large language model (LLM) agents solve procedural tasks every day and forget them by the next session: the procedure survives only as inert conversation history. A growing body of work addresses this by distilling agent experience into reusable artifacts — executable skill libraries [1], induced workflows [5], and procedural memory [17] — but published systems induce almost exclusively from benchmark task trajectories, verify against benchmark ground truth, and commit to a single skill representation chosen a priori. We present **Skill Genesis**, a production system that converts a user's own repeated behavior — chat conversations, and multi-agent workflows the user built and repeatedly ran — into standardized, human-editable skills. The system contributes: (i) a **three-class candidate taxonomy** with class-specific detection sensors, the cheapest of which is pure SQL over execution history and requires no LLM; (ii) a **knowledge ladder** in which each promotion step is paid for only after recurrence thresholds are met, under a server-authoritative budget and autonomy gate; (iii) **eval-first birth**: a skill must pass evaluation cases synthesized from the user's own accepted historical outputs before it exists; and (iv) **agents-as-skills promotion**: an entire multi-agent workflow graph is promoted into a single callable skill, with an explicit user choice between *interpreted* execution (the live workflow, run by reference) and *compiled* execution (a frozen, self-contained snapshot embedding the graph and an asynchronous scheduler, or ahead-of-time code generation targeting LangGraph, Google ADK, or the Microsoft Agent Framework). To our knowledge, the promotion of whole multi-agent workflow graphs into single compiled skills, and the use of user-accepted production outputs as the verification oracle, are not covered by the published literature, which treats workflow induction [5, 7] and trace-to-skill compilation [10] as separate problems.

---

## 1. Introduction

LLM agents are stateless learners. Within a session, an agent can plan, call tools, coordinate sub-agents, and satisfy a user; across sessions, none of that procedural competence persists. When the user needs the same outcome next week, the agent re-derives the procedure from scratch — at full token cost, with fresh opportunities for error — or the user re-explains it. The knowledge exists, but only as conversation history: episodic, unindexed, and unexecutable.

The research community has converged on a family of remedies under different names. *Skill library* approaches, beginning with Voyager [1], store verified executable code produced during exploration and retrieve it for composition into more complex behavior. *Workflow memory* approaches such as Agent Workflow Memory (AWM) [5] induce commonly reused routines from agent trajectories and re-inject them as guidance. *Procedural memory* frameworks such as Memp [17] treat the distillation of trajectories into step-level instructions and script-level abstractions as an explicit optimization target, with build, retrieve, and update phases. A 2026 survey [22] unifies these threads as **externalization**: capability gains come from moving cognition out of model weights into memory, skills, and protocols, where "skills externalize procedural expertise and convert implicit know-how into explicit reusable operating guidance."

These systems share three assumptions that limit their applicability to deployed, user-facing agent platforms. First, the **induction substrate** is nearly always a benchmark task trajectory — web navigation episodes, ALFWorld rollouts, Minecraft exploration — rather than the interaction history of a real user; among the works surveyed here, only AutoSkill [15] induces from dialogue traces. Second, **verification** is performed against benchmark ground truth (task success signals, unit tests), which does not exist in open-ended production use. Third, each system commits to a **single skill representation** — free text [2, 4], retrievable plans [3], or executable programs [1, 9, 10] — even though the evidence itself suggests representation should be a function of certainty: Agent Skill Induction (ASI) shows programs outperform text skills by 11.3% success on WebArena precisely because programs admit verification [9], while textual routines remain cheaper to produce and easier to revise.

**Skill Genesis** is our answer to these constraints, implemented in the SynergyAI agent platform. Its design premise is economic: *capture must be free, and every subsequent expenditure must be justified by demonstrated demand.* The system watches three sources of demonstrated demand — repeated multi-step chat procedures, repeatedly executed user-built multi-agent workflows, and recurring cross-session sequences that interleave both — and promotes each along a *knowledge ladder*: a cheap natural-language memory line, then a validated recurring candidate, then a durable skill artifact. Every born artifact is a `SKILL.md` package — the same standardized, human-editable format adopted by AutoSkill [15] and analyzed by the skill-engineering survey of [21] — discoverable by the agent's auto-routing layer and auditable by the user.

Two design decisions distinguish the system most sharply from prior work. The first is **eval-first birth**. Because no benchmark oracle exists for a user's private procedures, Skill Genesis synthesizes one from production history: *description evals* test that the skill triggers on real historical prompts (and does not trigger on other skills' prompts), and *body evals* replay the parameterized procedure against historical inputs, judging outputs against what the user actually accepted at the time. A skill that cannot pass its own history does not come into existence. The second is **agents-as-skills promotion with an explicit representation choice**. When a multi-agent workflow is promoted, the user chooses *interpreted* execution — the skill invokes the live workflow by reference, so later edits flow through — or *compiled* execution — the workflow graph is frozen into a self-contained snapshot that embeds the graph and its own asynchronous scheduler, or exported as standalone code for LangGraph, Google ADK, or the Microsoft Agent Framework. This surfaces, as a product decision, the flexibility-versus-determinism axis that the literature resolves silently and unilaterally.

The remainder of this paper reviews the relevant literature (§2), describes the Skill Genesis pipeline (§3) and the workflow-to-skill promotion path (§4), analyzes the distinctions from the state of the art (§5), and discusses limitations (§6).

---

## 2. Related Work

### 2.1 Skill libraries learned from experience

Voyager [1] established the founding pattern of this literature: an agent in Minecraft writes executable code for new behaviors, verifies it against environment feedback, and stores it in "an ever-growing skill library of executable code for storing and retrieving complex behaviors." Voyager's skills are temporally extended, interpretable, and compositional, and the learned library transfers to a new world to solve novel tasks — the first demonstration that experience-derived code skills generalize beyond the trajectories that produced them.

A parallel, non-compiled branch stores experience as *retrievable memory* rather than executable artifacts. ExpeL [2] pools trajectories and distills cross-task natural-language insights recalled at inference time. JARVIS-1 [3] keeps a multimodal key-value memory of scenarios and successful plans, reused as in-context demonstrations. CLIN [4] maintains a persistent textual memory of causal abstractions updated after each trial, whose contents transfer zero-shot to unseen environments (+4 points) and tasks (+13 points). These systems establish the experience-to-reuse mechanism but stop short of parameterization or compilation; in the terminology of §3, they occupy the lowest rung of the knowledge ladder.

### 2.2 Workflow induction and workflow-as-code

Agent Workflow Memory [5] is the direct precedent for mining recurring routines: it "induc[es] commonly reused routines, i.e., workflows, and selectively provid[es] workflows to the agent to guide subsequent generations," in both offline and online regimes, improving relative success by 24.6% on Mind2Web and 51.1% on WebArena. Where AWM *induces* workflows from trajectories, a second line *generates* them: AutoFlow [6] produces agent workflows as natural-language programs refined by reinforcement signals; AFlow [7] represents workflows as code-graphs of LLM-invoking nodes and searches the space with Monte-Carlo tree search, outperforming manual designs by 5.7%; and ADAS [8] generalizes furthest, framing entire agents as code artifacts discoverable by a meta-agent. These works treat the workflow as the *end product*. None of them, to our knowledge, closes the loop we require: taking a workflow that a *user* built and repeatedly ran, and packaging it as a callable skill inside a larger agent.

### 2.3 Skills as verified, parameterized programs

ASI [9] provides the key representational evidence: agents that induce, verify, and reuse *program-based* skills online outperform a static baseline by 23.5% and a text-skill variant by 11.3% on WebArena, "mainly thanks to the programmatic verification guarantee during the induction phase." SkillWeaver [10a — see 11] has web agents autonomously discover, practice, and distill skills into plug-and-play APIs. TroVE [12] and ReGAL [13] supply the library-curation playbook: TroVE grows and trims a toolbox of verified, reusable functions; ReGAL refactors program corpora offline to discover shared abstractions. SKILL-DISCO [10] is the closest published analog of our compilation path: it formalizes procedural skills as reusable parameterized control-flow subgraphs that "can match multiple successful traces under parameter binding," compiles them into callable, executable, verifiable skills, and outperforms both AWM and ASI under identical splits (raising CodeAct's ALFWorld success from 96.3% to 99.3% and ReAct's WebArena success from 23.9% to 29.1% with GPT-4o). SkillSmith [14] addresses the execution layer, compiling skill specifications into inspectable, resumable workflow artifacts.

### 2.4 Skills from conversations and procedural memory

AutoSkill [15] is the only work we identified that induces from *dialogue*: a training-free framework that derives, maintains, and reuses skills from dialogue and interaction traces, materializing each as a standardized `SKILL.md` Agent Skill artifact in a local SkillBank retrieved by hybrid dense-plus-BM25 scoring. Its motivation — users repeatedly express stable procedures across sessions that are "seldom consolidated into reusable knowledge" — is precisely ours. In the multi-turn tool-use setting, the hybrid episodic-procedural memory of [16] shows that coarse whole-trajectory episodes prevent reuse, and extracts procedural routines from recurring tool-to-tool dependencies. Memp [17] treats procedural memory as an explicit object with dual granularity — "fine-grained, step-by-step instructions and higher-level, script-like abstractions" — and, critically, a lifelong regimen that "continuously updates, corrects, and deprecates its contents." Skill-Pro [18] frames skill acquisition as non-parametric policy improvement over accumulated experience. Recent surveys organize the space: the storage-to-experience evolution of agent memory [19], memory mechanisms and their evaluation [20], skill engineering and the `SKILL.md` packaging model [21], and the externalization framework [22], whose Section 7.1 names the bidirectional loop our architecture implements — "episodic traces can be clustered, abstracted, and promoted into skill artifacts without modifying base-model weights" (memory→skill), with skill executions recording traces back into memory (skill→memory).

Finally, a cautionary result: embedding-retrieved skill libraries of the Voyager style degrade by up to ~21% at roughly 200 skills due to retrieval interference ("skill shadowing") [23] — evidence that unconstrained skill accumulation is a liability, and that catalog governance is a first-class design problem.

---

## 3. Skill Genesis

Skill Genesis fills the *generative procedural* quadrant of our platform's learning architecture: declarative learning is handled by the platform's memory system, and corrective procedural repair (healing a skill that misfires) by a separate self-harness; Genesis is the component that brings *new* procedural artifacts into existence from demonstrated demand.

### 3.1 Three candidate classes, three sensors

The unit of detection is the *candidate*, and the central design rule is that each class of candidate gets the cheapest sensor that can detect it:

- **Class 2 — workflow habits** (built first, strongest signal). The user built a multi-agent workflow in the visual editor and ran it repeatedly. The sensor is **pure SQL over execution history** — a query over workflow run tables for graphs executed at least a threshold number of times within a rolling window and not already wrapped by a skill. No LLM is involved in detection. This ordering inverts the literature's default: where AWM [5] and SKILL-DISCO [10] pay an LLM to induce structure from unstructured trajectories, a user-built workflow already *is* the induced structure; only recurrence needs to be established, and counting is free.

- **Class 1 — chat procedures.** Repeated multi-step tool sequences inside conversations. The sensor is the platform's existing memory extractor, extended with a `PROCEDURES` scope that emits trigger-shaped lines of the form `WHEN <trigger> DO <steps> [PREFS ...]`. Re-observation of a known procedure is logged as a reinforcement event, making the event log itself the recurrence counter — no clustering pipeline and no candidate store are added. Cheap skip-checks gate LLM cost: turns with fewer than two tool calls, single-skill turns, and failed or verifier-flagged turns are never mined. Like Voyager [1] and SKILL-DISCO [10], Genesis learns only from success.

- **Class 3 — meta-procedures** (weakest signal, strictest gate). Recurring ordered sequences that span chat and workflow runs, detected by correlating session traces. Candidates factor into graphs whose nodes *reference* existing workflows and skills. Because the evidence is weakest and the blast radius largest, this class carries the strictest thresholds and can never be promoted without explicit user approval.

### 3.2 The knowledge ladder and the reflection job

Knowledge ascends a ladder — natural-language memory line → validated recurring candidate → durable skill — and each rung's cost is paid only after the prior rung proves demand. Promotion proposals are generated by a **weekly reflection job**: one long-context model pass per active user consuming the `PROCEDURES` block, reinforcement events, the current skill catalog, conversation summaries, and Class-2 candidates, and emitting at most three proposals, each carrying a name, description, evaluation queries, an optional parameter schema, an optional merge target, and a cost estimate. A **merge-router** rule protects the catalog: if an existing skill already covers the procedure, the model must return a merge target — the new evidence becomes additional evaluation cases for the existing skill — rather than a new name. This is our answer to the catalog-bloat and retrieval-interference problem quantified by [23] and managed reactively by TroVE's grow-and-trim cycle [12] and Memp's update-and-deprecate regimen [17]: Genesis deduplicates at *proposal time*, before the artifact exists.

### 3.3 Parameterization by diff

Class-2 candidates are parameterized by **diffing runs**: a reflection pass compares input variables and node configurations across the recorded executions; fields that *varied* become parameters (with observed values retained as documentation examples), fields that were *constant* stay baked in. When run history is too uniform to reveal parameters, a second source applies: because the workflow is a declarative DSL, the model *reads* node instructions and lifts hardcoded literals into candidate parameters — an inspection, not a reverse-engineering step. This is the same abstraction criterion as SKILL-DISCO's requirement that a skill "match multiple successful traces under parameter binding" [10] and ReGAL's discovery of shared abstractions by refactoring [13], but applied to a *declarative graph the user authored* rather than to opaque traces, which makes the constant/variable split directly observable.

### 3.4 Eval-first birth

A proposed skill must pass a synthesized evaluation set *before it is born*. **Description evals** test discoverability: positive cases are real historical prompts that triggered the procedure (plus paraphrases); negative cases are drawn from *other* skills' triggers, so a new skill cannot cannibalize the catalog. **Body evals** test behavior: the parameterized procedure is replayed on historical inputs and judged against the outputs the user actually accepted at the time, and a default-parameter replay must reproduce the unparameterized workflow's behavior — an invariance check on the parameterization itself. This transplants ASI's induction-time verification guarantee [9] and SKILL-DISCO's verifiable-compilation requirement [10] into a setting with no benchmark: the oracle is the user's own accepted history.

### 3.5 Governance: budget gate, progressive autonomy, pointer rewrite

All spending decisions flow through a single server-side pure decision function that enforces the user's mode, per-run cost estimate against remaining budget, a spend ceiling, and a weekly birth throttle; the client can never spend. Autonomy is progressive per class — `off → suggest → ask → auto` — proportional to blast radius, and Class 3 rejects `auto` unconditionally. After a Class-1 skill is born, its `PROCEDURES` memory line is **rewritten to a pointer** ("… DO use skill *name*"), converting an always-paid context-resident memory into a pay-on-use artifact — the concrete mechanics of the memory→skill promotion the externalization survey describes abstractly [22]. Proposals live in a single state machine (`proposed → approved → building → born | merged | dismissed | failed`), and all Genesis spend is metered in the same ledger as the platform's healing spend.

Every born artifact is a `SKILL.md` package — the format's polyglot nature is the point: markdown addresses the LLM (intent and discovery), the workflow DSL addresses the workflow engine (structure fixed, parameters free), Python addresses the sandbox (determinism), and a mermaid diagram addresses human review. The catalog lives in the browser's local filesystem via the File System Access API; the server never reads it.

---

## 4. Agents-as-Skills: Promoting a Workflow into a Skill

When a Class-2 promotion is approved, the user makes an explicit **execution-mode choice** that the literature makes silently:

**Interpreted (default).** The skill body is a thin dispatcher that runs the *live* workflow by reference through the platform's workflow engine. Editor changes to the workflow flow through automatically; the workflow is referenced, never copied. The dispatcher is fire-and-notify — it starts the run and exits rather than holding the serialized Python runtime, with the final output posted into the conversation on completion. Referencing (not copying) also cleanly partitions repair: faults in the skill's *description* route to the description-optimization loop, faults in the workflow's *structure* route to the workflow's own validation and revert path.

**Compiled.** The workflow graph is frozen at promotion time into a **self-contained Pyodide snapshot**. The build distills the workflow definition into a minimal node-and-edge graph (per agent node: provider, model, instructions, bound-skill directory), bundles the scripts of any bound skills, and emits a `run.py` that embeds the graph JSON *plus an asyncio execution engine*: topological layer scheduling, concurrent execution of each parallel layer, each agent node realized as one chat conversation looping over tool rounds, and nested skill-script calls dispatched to a sandboxed worker pool. The artifact is fully self-contained — no external runner, and provider keys stay server-side — at the cost of staleness: workflow edits do not flow through, and the user re-promotes to refresh.

A sibling export path performs full ahead-of-time compilation of the same DSL graph into standalone multi-agent programs for three external frameworks — **LangGraph**, **Google ADK**, and the **Microsoft Agent Framework** — from a shared graph analyzer and emission core, one generator per target. Where AFlow [7] and ADAS [8] *search* for workflow code, these generators *transcribe* a user-validated graph into it; correctness derives from the source artifact's run history rather than from search.

The interpreted/compiled choice is the concrete instantiation of an axis the evidence in §2 only implies: promotion moves knowledge down the flexibility↔determinism spectrum — natural-language memory line, then declarative graph with free parameters, then exact frozen script — *as certainty rises*, rather than committing the whole system to text (cheap, revisable, weak [2, 4]) or to programs (verified, strong, rigid [1, 9, 10]) in advance.

---

## 5. Distinctions from the State of the Art

**(1) Induction substrate: the user's own production history.** Every system in §2 except AutoSkill [15] induces from benchmark task trajectories. AutoSkill induces from dialogue, as our Class 1 does — and independently converges on the same `SKILL.md` artifact, local skill bank, and training-free stance — but has no analog of our Class 2 or Class 3: it does not mine *user-built workflow executions*, which are our strongest demand signal precisely because the user already invested in authoring the structure.

**(2) Detection without an LLM.** The literature's induction step is itself an LLM pass over trajectories [5, 10, 15]. Our Class-2 sensor is a SQL query; our Class-1 recurrence counter is an event log written by an extraction pass the platform already runs for other purposes. The LLM is reserved for the weekly reflection job, whose output volume is throttled. We are not aware of published work that makes *detection cost* a design axis; the closest concern is Memp's interest in memory-update efficiency [17].

**(3) Verification oracle: user-accepted outputs, not benchmarks.** ASI [9] and SKILL-DISCO [10] verify against environment success signals; TroVE [12] against test cases. No published system we identified synthesizes its oracle from *outputs the user accepted in production*, nor tests catalog-level discoverability with cross-skill negative cases, nor requires a default-parameter invariance check on the parameterization. Eval-first birth is, to our knowledge, novel as a *precondition of artifact existence*.

**(4) Agents-as-skills: workflow graphs promoted into single compiled skills.** The literature covers workflow induction [5], workflow generation [6, 7, 8], and trace-to-skill compilation [10, 14] as separate problems. We found no published work that promotes a *multi-agent workflow graph* into a *single callable skill* — let alone one offering both by-reference interpretation and frozen self-contained compilation, plus code export to three external agent frameworks. The deep-research pass that grounded this paper flagged exactly this as the thinnest area of the corpus; we believe this contribution is currently ahead of the published state of the art.

**(5) Economics as architecture.** Recurrence thresholds, per-class progressive autonomy, a server-authoritative budget gate, weekly birth throttling, and pointer rewrite (context-resident memory converted to pay-on-use artifacts) have no counterpart in the surveyed papers, which uniformly assume an unmetered inducer. In a deployed multi-tenant product, the metering *is* the design.

**(6) Governance at proposal time.** The merge-router deduplicates before an artifact exists; the literature curates after the fact (grow-and-trim [12], update-and-deprecate [17]) — and the skill-shadowing result [23] suggests post-hoc curation arrives too late at realistic catalog sizes.

---

## 6. Limitations and Future Work

Skill Genesis is deployed incrementally: the manual on-ramps and the full Class-2 path (both interpreted and compiled) are implemented; the Class-1 `PROCEDURES` sensor and the Class-3 correlation sensor are designed but not yet built. We report no controlled benchmark comparison — our verification target is fidelity to each user's accepted history, which is by construction not a public benchmark; constructing a shareable evaluation for conversation-derived skills is open, and the field would benefit from one (AutoSkill's evaluation [15] is a starting point). Several of the closest comparison systems [10, 14, 15, 21, 22] are 2026 preprints whose results are self-reported and not yet peer-validated. Finally, our merge-router mitigates but does not eliminate catalog-scaling risk; whether proposal-time deduplication defers the ~200-skill interference wall reported by [23], and by how much, is an empirical question we have not yet reached in production.

---

## 7. Conclusion

The literature has established, piecewise, everything Skill Genesis needs to exist: that experience-derived code skills compound and transfer [1], that recurring workflows can be induced from history [5], that programs beat prose when verification is possible [9], that repetition under parameter binding is the right abstraction criterion [10], that dialogue is a viable induction substrate and `SKILL.md` a viable artifact [15], and that all of it is one loop — memory promoted to skills, skills recording back to memory [22]. What the literature has not yet assembled is the loop *as a product*: detection priced at zero, promotion gated on demonstrated demand and budget, birth gated on evals synthesized from the user's own accepted history, and — in the step we believe is ahead of published work — whole multi-agent workflows promoted into single skills whose representation on the flexibility↔determinism axis is an explicit, revisable choice. Skill Genesis is that assembly.

---

## References

*Author lists for 2026 arXiv preprints (marked †) are omitted here pending verification against the arXiv records; complete them before any external submission.*

[1] G. Wang, Y. Xie, Y. Jiang, A. Mandlekar, C. Xiao, Y. Zhu, L. Fan, A. Anandkumar. **Voyager: An Open-Ended Embodied Agent with Large Language Models.** arXiv:2305.16291, 2023. https://arxiv.org/abs/2305.16291

[2] A. Zhao, D. Huang, Q. Xu, M. Lin, Y.-J. Liu, G. Huang. **ExpeL: LLM Agents Are Experiential Learners.** AAAI 2024; arXiv:2308.10144. https://arxiv.org/abs/2308.10144

[3] Z. Wang et al. **JARVIS-1: Open-World Multi-task Agents with Memory-Augmented Multimodal Language Models.** arXiv:2311.05997, 2023. https://arxiv.org/abs/2311.05997

[4] B. P. Majumder et al. **CLIN: A Continually Learning Language Agent for Rapid Task Adaptation and Generalization.** arXiv:2310.10134, 2023. https://arxiv.org/abs/2310.10134

[5] Z. Z. Wang, J. Mao, D. Fried, G. Neubig. **Agent Workflow Memory.** ICML 2025; arXiv:2409.07429. https://arxiv.org/abs/2409.07429

[6] Z. Li, S. Xu, K. Mei, et al. **AutoFlow: Automated Workflow Generation for Large Language Model Agents.** arXiv:2407.12821, 2024. https://arxiv.org/abs/2407.12821

[7] J. Zhang et al. **AFlow: Automating Agentic Workflow Generation.** arXiv:2410.10762, 2024. https://arxiv.org/abs/2410.10762

[8] S. Hu, C. Lu, J. Clune. **Automated Design of Agentic Systems.** arXiv:2408.08435, 2024. https://www.semanticscholar.org/paper/c9537f656e7d9713fd4108ce7bf512290f48e562

[9] Z. Z. Wang, A. Gandhi, G. Neubig, D. Fried. **Inducing Programmatic Skills for Agentic Tasks (Agent Skill Induction, ASI).** arXiv:2504.06821, 2025. https://arxiv.org/abs/2504.06821

[10] † **SKILL-DISCO: Distilling and Compiling Agent Traces into Reusable Procedural Skills.** arXiv:2606.26669, 2026. https://arxiv.org/abs/2606.26669

[11] B. Zheng et al. **SkillWeaver: Web Agents Can Self-Improve by Discovering and Honing Skills.** arXiv:2504.07079, 2025. https://arxiv.org/abs/2504.07079

[12] Z. Wang, D. Fried, G. Neubig. **TroVE: Inducing Verifiable and Efficient Toolboxes for Solving Programmatic Tasks.** ICML 2024; arXiv:2401.12869. https://arxiv.org/abs/2401.12869

[13] E. Stengel-Eskin, A. Prasad, M. Bansal. **ReGAL: Refactoring Programs to Discover Generalizable Abstractions.** ICML 2024; arXiv:2401.16467. https://arxiv.org/abs/2401.16467

[14] † **SkillSmith: Compiling Agent Skills into Boundary-Guided Runtime Interfaces.** arXiv:2605.15215, 2026. https://arxiv.org/abs/2605.15215

[15] † **AutoSkill: Experience-Driven Lifelong Learning via Skill Extraction from Dialogue and Interaction Traces.** arXiv:2603.01145, 2026. https://arxiv.org/abs/2603.01145

[16] † **Experience-Evolving Multi-Turn Tool-Use Agent with Hybrid Episodic-Procedural Memory.** ICML 2026; arXiv:2512.07287. https://arxiv.org/abs/2512.07287

[17] **Memp: Exploring Agent Procedural Memory.** arXiv:2508.06433, 2025. https://arxiv.org/abs/2508.06433

[18] † **Skill-Pro: Learning Reusable Skills from Experience via Non-Parametric PPO for LLM Agents.** arXiv:2602.01869, 2026. https://arxiv.org/abs/2602.01869

[19] † **From Storage to Experience: A Survey on the Evolution of LLM Agent Memory.** arXiv:2605.06716, 2026. https://arxiv.org/abs/2605.06716

[20] † **Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers.** arXiv:2603.07670, 2026. https://arxiv.org/abs/2603.07670

[21] † **Agent Skills for Large Language Models: Architecture, Acquisition, Security, and the Path Forward.** arXiv:2602.12430, 2026. https://arxiv.org/abs/2602.12430

[22] † **Externalization in LLM Agents: Memory, Skills, Protocols, and Harness Engineering.** arXiv:2604.08224, 2026. https://arxiv.org/abs/2604.08224

[23] † **Skill shadowing in large agent skill libraries** (title to verify). arXiv:2605.24050, 2026. https://arxiv.org/abs/2605.24050

---

*System documentation referenced: `docs/specs/2026-07-14-skill-genesis-design.md` (design), `docs/superpowers/plans/2026-07-14-skill-genesis-l0.md` (implementation plan), and the ADK/MAF generator specs under `docs/superpowers/specs/`. All quantitative claims about external papers in this draft were verified verbatim against the cited sources via a 3-vote adversarial verification pass on 2026-07-19; one commonly repeated claim (a four-way Authored/Distilled/Discovered/Composed taxonomy attributed to [22]) failed verification and is deliberately not used.*
