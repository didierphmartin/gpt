# Skill Pipeline — ADK Compiler (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ADK compiler emit each skill as a **mandatory post-agent step** on the agent's result (an LLM following the skill's live `SKILL.md`, seeded by the prior output), instead of an optional `run_skill_script` tool the model may skip.

**Architecture:** The shared analyzer surfaces an ordered `skills` list per agent (dir-backed or legacy-inline). In the ADK emitter, a skill-bearing node compiles to `SequentialAgent(name="node_<id>", sub_agents=[node_<id>_agent, node_<id>_skill_1, …])`: the main agent (its `run_skill_script` tool removed) writes an intermediate state key; each skill step is an `LlmAgent` on the node's own model whose **callable instruction** returns the live `SKILL.md` (read from disk, no `{}`-templating) plus the prior step's output from `ctx.state`, with `run_skill_script` scoped to that skill's dir; the last skill writes the node's `output_key`. `rootBlock` is unchanged because it already references `node_<id>` (now the wrapper).

**Tech Stack:** PHP 8 (generators + PHPUnit), Python 3.13 + google-adk 2.3.0 (emitted target), LiteLLM.

## Global Constraints

- Skills are **mandatory** post-steps on the agent's result; never a model-chosen tool. The main agent must NOT carry `run_skill_script`.
- A skill step uses the **node's own model/provider** (`_make_model(provider, model)`), verbatim from the agent form — never overridden ([[feedback_no_override_form_params]]).
- Skill content is read **live from disk at runtime** by `dir_name` (`SKILLS_DIR/<dir>/SKILL.md`); the compiler embeds no skill body for dir-backed skills. Legacy inline `skill_content` (no dir) is carried as literal text.
- A skill step's instruction is a **callable** (`InstructionProvider`) so `SKILL.md` braces are used verbatim (ADK returns `bypass_state_injection=True` for callables — verified in google-adk 2.3.0).
- `run_skill_script` inside a skill step is **scoped to that skill's `dir_name`** (the step supplies the dir; the model only picks script + argv).
- Fix the generator, never its output ([[feedback_never_patch_compiled]]). After JS-free backend edits, regenerate the golden fixture and run the suite.
- Phase 1 = the single `bound_skill` per node, written **pipeline-ready** (a list of length 0/1). Multiple skills + ordering is a future task.

---

### Task 1: Analyzer surfaces an ordered `skills` list per agent

**Files:**
- Modify: `backend/src/AgentTeam/Services/WorkflowGraphAnalyzer.php` (agent assembly, ~lines 235–246)
- Test: `backend/tests/Unit/WorkflowGraphAnalyzerTest.php`

**Interfaces:**
- Produces: each entry of `$analyzed['agents'][$id]` gains `'skills' => array` — an ordered list of `['dir' => string]` (dir-backed) or `['inline' => string]` (legacy). Empty list when the node has no skill. `skill_content` remains for back-compat but is no longer the skill carrier.

- [ ] **Step 1: Write the failing test**

Add to `WorkflowGraphAnalyzerTest.php`:

```php
public function testAgentSurfacesBoundSkillDir(): void
{
    $graph = [
        'nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
            ['id' => '2', 'type' => 'agent', 'config' => [
                'type' => 'agent', 'agent_name' => 'A', 'systemPrompt' => 'do it',
                'provider' => 'claude', 'model' => 'm', 'selectedTools' => [],
                'bound_skill' => ['id' => null, 'source' => 'local', 'dir_name' => 'GEO/geo-report', 'name' => 'R'],
            ]],
        ],
        'edges' => [['from' => '1', 'to' => '2']],
    ];
    $a = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
    // analyzeGraph is structural; skills come from the config-aware path. Assert the helper directly:
    $skills = \AgentTeam\Services\WorkflowGraphAnalyzer::skillsFromConfig($graph['nodes'][1]['config']);
    $this->assertSame([['dir' => 'GEO/geo-report']], $skills);
}

public function testLegacyInlineSkillContentBecomesInlineEntry(): void
{
    $cfg = ['type' => 'agent', 'skill_content' => 'legacy instructions'];
    $this->assertSame([['inline' => 'legacy instructions']], \AgentTeam\Services\WorkflowGraphAnalyzer::skillsFromConfig($cfg));
}

public function testNoSkillYieldsEmptyList(): void
{
    $this->assertSame([], \AgentTeam\Services\WorkflowGraphAnalyzer::skillsFromConfig(['type' => 'agent']));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/WorkflowGraphAnalyzerTest.php`
Expected: FAIL — `Call to undefined method …::skillsFromConfig()`.

- [ ] **Step 3: Implement**

Add a static helper to `WorkflowGraphAnalyzer.php` (near `typeOf`):

```php
/**
 * Ordered skill bindings for an agent node's config. Prefers the structured
 * bound_skill (dir-backed, read live from disk at runtime); falls back to the
 * legacy inline skill_content string. Returns [] when the node has no skill.
 * Phase 1 supports one skill; the return is a list so N skills need no change.
 */
public static function skillsFromConfig(array $config): array
{
    $out = [];
    $bs = $config['bound_skill'] ?? null;
    if (is_array($bs) && trim((string) ($bs['dir_name'] ?? '')) !== '') {
        $out[] = ['dir' => trim((string) $bs['dir_name'])];
    } elseif (trim((string) ($config['skill_content'] ?? '')) !== '') {
        $out[] = ['inline' => (string) $config['skill_content']];
    }
    return $out;
}
```

Then, in the `analyze()` agent-assembly block (~line 243, alongside `'skill_content' =>`), add:

```php
    'skills'           => self::skillsFromConfig($c),
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/WorkflowGraphAnalyzerTest.php`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/WorkflowGraphAnalyzer.php backend/tests/Unit/WorkflowGraphAnalyzerTest.php
git commit -m "feat(analyzer): surface ordered per-agent skills list (bound_skill dir or legacy inline)"
```

---

### Task 2: ADK runtime helpers — read live SKILL.md + dir-scoped skill tool + skill instruction provider

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php` (`skillRunnerBlock()`)
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Produces (in emitted Python): `_read_skill_md(dir_name) -> str`, `_skill_instruction(dir_name, input_key, inline_md)` returning an `InstructionProvider`, and `_make_skill_tool(dir_name) -> FunctionTool`. These are emitted by `skillRunnerBlock()` (already gated behind "needs skills").

- [ ] **Step 1: Write the failing test**

Add to `AdkGeneratorEmitTest.php`:

```php
public function testSkillRunnerEmitsLiveSkillHelpers(): void
{
    $code = \AgentTeam\Services\ADKGenerator::skillRunnerBlockForTest();
    $this->assertStringContainsString('def _read_skill_md(', $code);
    $this->assertStringContainsString('SKILLS_DIR', $code);          // reads from disk
    $this->assertStringContainsString('def _skill_instruction(', $code);
    $this->assertStringContainsString('def _make_skill_tool(', $code);
    // dir-scoped: the per-skill tool binds dir_name and only exposes script+argv
    $this->assertStringContainsString('return await _run_skill_script(dir_name, script, argv)', $code);
}
```

Add a tiny test seam to `ADKGenerator.php` (public passthrough, mirrors the existing test conventions):

```php
public static function skillRunnerBlockForTest(): string { return self::skillRunnerBlock(); }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillRunnerEmitsLiveSkillHelpers`
Expected: FAIL — helpers not present.

- [ ] **Step 3: Implement**

Append to the Python emitted by `skillRunnerBlock()` (after the existing `RUN_SKILL_SCRIPT_TOOL` definition), using a nowdoc so braces are literal:

```php
        $py .= <<<'PY'


def _read_skill_md(dir_name: str) -> str:
    """Read the live SKILL.md body for a skill dir (progressive disclosure:
    the skill's own instructions). Strips YAML frontmatter if present."""
    path = os.path.join(SKILLS_DIR, *str(dir_name).split("/"), "SKILL.md")
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return f"(SKILL.md not found for skill '{dir_name}' at {path})"
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            nl = text.find("\n", end + 1)
            text = text[nl + 1:] if nl != -1 else ""
    return text.strip()


def _skill_instruction(dir_name: str, input_key: str, inline_md: str = ""):
    """Return an ADK InstructionProvider (callable) for a skill step. Using a
    callable makes ADK use the text verbatim (bypass_state_injection=True), so
    SKILL.md braces are safe, and it can read the prior step's output from state."""
    def _instr(ctx):
        body = inline_md if inline_md else _read_skill_md(dir_name)
        prior = ctx.state.get(input_key, "")
        return body + "\n\n## Input to process (apply the skill to this)\n" + str(prior)
    return _instr


def _make_skill_tool(dir_name: str) -> FunctionTool:
    """run_skill_script scoped to one skill dir: the model chooses only the
    script within the skill and its argv; the dir is fixed to this skill.
    Async because _run_skill_script is async (mirrors RUN_SKILL_SCRIPT_TOOL)."""
    async def run_skill_script(script: str, argv: list[str] | None = None) -> str:
        return await _run_skill_script(dir_name, script, argv)
    return FunctionTool(run_skill_script)
PY;
```

(`SKILLS_DIR` and `_run_skill_script` are already defined by `PythonEmitHelpers::skillDepsBlock()` / the existing runner block; `os` and `FunctionTool` are already imported by the header.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillRunnerEmitsLiveSkillHelpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): emit live-SKILL.md reader, dir-scoped skill tool, and skill instruction provider"
```

---

### Task 3: ADK agentsBlock — skill node → SequentialAgent(main + skill steps); main agent loses the skill tool

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php` (`agentsBlock()`)
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Consumes: `$analyzed['agents'][$id]['skills']` (Task 1), `provider`/`model` (for `_make_model`).
- Produces: for a node with a non-empty `skills` list, emits `node_<id>_agent` (main `LlmAgent`, no `RUN_SKILL_SCRIPT_TOOL`), one `node_<id>_skill_<k>` `LlmAgent` per skill, and `node_<id> = SequentialAgent(name="node_<id>", sub_agents=[…])`. The last skill writes `output_key="node_<id>"`. Nodes without skills are unchanged (`node_<id>` = the bare `LlmAgent`).

- [ ] **Step 1: Write the failing test**

Add to `AdkGeneratorEmitTest.php` (uses the same analyzed-fixture style as `testRootLayeringAndMain`):

```php
public function testSkillNodeCompilesToSequentialWithMandatorySkillStep(): void
{
    $graph = [
        'nodes' => [
            ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
            ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'R',
                'systemPrompt' => 'write the report', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
        ],
        'edges' => [['from' => '1', 'to' => '2']],
    ];
    $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
    $a = array_merge($base, [
        'workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
        'startPrompt' => 'GO', 'startDocuments' => [],
        'agents' => [
            '2' => ['name' => 'R', 'systemPrompt' => 'write the report', 'provider' => 'claude', 'model' => 'm',
                'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '',
                'skills' => [['dir' => 'GEO/geo-report']], 'output_schema_id' => null, 'documents' => []],
        ],
    ]);
    $code = \AgentTeam\Services\ADKGenerator::emitAdk($a);

    // main agent is separate and has NO skill tool
    $this->assertStringContainsString('node_2_agent = LlmAgent(', $code);
    $this->assertStringNotContainsString('RUN_SKILL_SCRIPT_TOOL', $code);   // never given to the main agent
    // skill step: node model, dir-scoped tool, callable instruction seeded by the agent's result
    $this->assertStringContainsString('node_2_skill_1 = LlmAgent(', $code);
    $this->assertStringContainsString('_make_model("claude", "m")', $code);
    $this->assertStringContainsString('_make_skill_tool("GEO/geo-report")', $code);
    $this->assertStringContainsString('_skill_instruction("GEO/geo-report", "node_2_agent"', $code);
    $this->assertStringContainsString('output_key="node_2"', $code);       // last step writes the node key
    // wrapper the layering references
    $this->assertMatchesRegularExpression('/node_2 = SequentialAgent\(\s*name="node_2",\s*sub_agents=\[node_2_agent, node_2_skill_1\]/s', $code);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillNodeCompilesToSequentialWithMandatorySkillStep`
Expected: FAIL — no `node_2_agent`/`node_2_skill_1`/`SequentialAgent` wrapper.

- [ ] **Step 3: Implement**

In `agentsBlock()`, replace the current per-node emission so it branches on `skills`. Current code builds `$instr`, `$toolExprs` (adding `RUN_SKILL_SCRIPT_TOOL` when the instruction mentions `run_skill_script`), then `$entry = "node_{$id} = LlmAgent(\n…"`. Change to:

```php
            $skills = $ag['skills'] ?? [];
            $hasSkills = count($skills) > 0;

            // The main agent NEVER carries the skill tool. (Drop the old
            // run_skill_script auto-add entirely — skills are separate steps now.)
            $toolExprs = [];
            foreach ($ag['tools'] as $t) {
                $toolExprs[] = 'catalog["' . $t . '"]';
            }
            $toolsPy = '[' . implode(', ', $toolExprs) . ']';

            $model = '_make_model("' . $ag['provider'] . '", "' . $ag['model'] . '")';
            $agentVar = $hasSkills ? "node_{$id}_agent" : "node_{$id}";
            $agentOutKey = $hasSkills ? "node_{$id}_agent" : "node_{$id}";

            $agentComment = str_replace(["\r", "\n"], ' ', (string) $ag['name']);
            $entry  = "# Agent \"{$agentComment}\" ({$ag['provider']}/{$ag['model']}) -- workflow node {$id}\n";
            $entry .= "{$agentVar} = LlmAgent(\n";
            $entry .= "    name=\"{$agentVar}\",\n";
            $entry .= "    model={$model},\n";
            $entry .= "    instruction=" . PythonEmitHelpers::pyStr($instr) . ",\n";
            $entry .= "    tools={$toolsPy},\n";
            // (existing generate_content_config block stays, unchanged)
            // … emit temperature/max_tokens config here as today …
            $entry .= "    output_key=\"{$agentOutKey}\",\n";
            $entry .= ")";

            if ($hasSkills) {
                $prev = "node_{$id}_agent";
                $subAgents = ["node_{$id}_agent"];
                foreach ($skills as $k => $skill) {
                    $stepNo = $k + 1;
                    $isLast = ($stepNo === count($skills));
                    $stepVar = "node_{$id}_skill_{$stepNo}";
                    $stepOut = $isLast ? "node_{$id}" : $stepVar;
                    if (isset($skill['dir'])) {
                        $dir = addslashes($skill['dir']);
                        $instrExpr = "_skill_instruction(\"{$dir}\", \"{$prev}\")";
                        $toolPy    = "[_make_skill_tool(\"{$dir}\")]";
                    } else {
                        $inlineMd = PythonEmitHelpers::pyStr((string) $skill['inline']);
                        $instrExpr = "_skill_instruction(\"\", \"{$prev}\", inline_md={$inlineMd})";
                        $toolPy    = "[]"; // legacy inline skill: no script folder
                    }
                    $entry .= "\n\n# Skill step {$stepNo} for node {$id} (mandatory; applies the skill to the prior result)\n";
                    $entry .= "{$stepVar} = LlmAgent(\n";
                    $entry .= "    name=\"{$stepVar}\",\n";
                    $entry .= "    model={$model},\n";
                    $entry .= "    instruction={$instrExpr},\n";
                    $entry .= "    tools={$toolPy},\n";
                    $entry .= "    output_key=\"{$stepOut}\",\n";
                    $entry .= ")";
                    $subAgents[] = $stepVar;
                    $prev = $stepVar;
                }
                $subList = implode(', ', $subAgents);
                $entry .= "\n\n# Node {$id}: agent then mandatory skill pipeline (this is what the layering references)\n";
                $entry .= "node_{$id} = SequentialAgent(\n    name=\"node_{$id}\",\n    sub_agents=[{$subList}],\n)";
            }
```

Notes for the implementer:
- Keep the existing `$instr` assembly for the main agent, BUT remove the line that appends `## Skill\n{skill_content}` to it (the skill is now a separate step, not prompt text). Also remove the `strpos($instr, 'run_skill_script')` → `RUN_SKILL_SCRIPT_TOOL` addition.
- Keep the existing `generate_content_config` (temperature/max_tokens) emission for the main agent exactly as today; the skill steps deliberately omit it (they run on the node's model with default sampling).
- `rootBlock()` needs no change: it already emits `node_<id>`, which is now the `SequentialAgent` wrapper for skill nodes.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillNodeCompilesToSequentialWithMandatorySkillStep`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): skill node compiles to SequentialAgent(main + mandatory skill steps), main agent loses skill tool"
```

---

### Task 4: `needsSkills` detection via the `skills` field

**Files:**
- Modify: `backend/src/AgentTeam/Services/ADKGenerator.php` (`emitAdk()` skill-detect loop)
- Test: `backend/tests/Unit/AdkGeneratorEmitTest.php`

**Interfaces:**
- Consumes: `$analyzed['agents'][$id]['skills']`.
- Produces: the skill runner block (Task 2 helpers) is emitted iff some agent has a non-empty `skills` list.

- [ ] **Step 1: Write the failing test**

```php
public function testSkillHelpersEmittedWhenAgentHasSkillsList(): void
{
    $graph = ['nodes' => [
        ['id' => '1', 'type' => 'start', 'config' => ['type' => 'start', 'prompt' => 'GO']],
        ['id' => '2', 'type' => 'agent', 'config' => ['type' => 'agent', 'agent_name' => 'R',
            'systemPrompt' => 's', 'provider' => 'claude', 'model' => 'm', 'selectedTools' => []]],
    ], 'edges' => [['from' => '1', 'to' => '2']]];
    $base = \AgentTeam\Services\WorkflowGraphAnalyzer::analyzeGraph($graph);
    $a = array_merge($base, ['workflow' => ['id' => 1, 'name' => 'w'], 'usedCatalog' => [], 'usedServers' => [],
        'startPrompt' => 'GO', 'startDocuments' => [], 'agents' => [
        '2' => ['name' => 'R', 'systemPrompt' => 's', 'provider' => 'claude', 'model' => 'm',
            'temperature' => null, 'max_tokens' => null, 'tools' => [], 'skill_content' => '',
            'skills' => [['dir' => 'GEO/geo-report']], 'output_schema_id' => null, 'documents' => []]]]);
    $code = \AgentTeam\Services\ADKGenerator::emitAdk($a);
    $this->assertStringContainsString('def _make_skill_tool(', $code);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillHelpersEmittedWhenAgentHasSkillsList`
Expected: FAIL — helpers absent (old detection checks `skill_content`/systemPrompt only).

- [ ] **Step 3: Implement**

Replace the `$needsSkills` loop in `emitAdk()`:

```php
        $needsSkills = false;
        foreach ($analyzed['agents'] as $agent) {
            if (!empty($agent['skills'])) { $needsSkills = true; break; }
        }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && php vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php --filter testSkillHelpersEmittedWhenAgentHasSkillsList`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/AgentTeam/Services/ADKGenerator.php backend/tests/Unit/AdkGeneratorEmitTest.php
git commit -m "feat(adk): gate skill-runner emission on the analyzer skills list"
```

---

### Task 5: Regenerate golden, full suite, and end-to-end verify against real ADK

**Files:**
- Modify: `backend/tests/fixtures/adk_diamond.golden.py` (regenerated artifact)
- Verify only: emitted GEO script

**Interfaces:** none new — this is the integration gate.

- [ ] **Step 1: Regenerate the golden fixture**

```bash
cd backend && php -r 'require "vendor/autoload.php"; require "tests/Unit/AdkGeneratorCompileTest.php";
$m=new ReflectionMethod("Quantis\\AIPortfolioAssistant\\Tests\\Unit\\AdkGeneratorCompileTest","diamondAnalyzed");
$m->setAccessible(true);
file_put_contents("tests/fixtures/adk_diamond.golden.py", AgentTeam\Services\ADKGenerator::emitAdk($m->invoke(null)));'
```
(The diamond fixture has no skills, so the golden should be unchanged except where intended. Inspect `git diff` — expect no diff, confirming non-skill nodes are untouched.)

- [ ] **Step 2: Run the full ADK/analyzer suite**

Run:
```bash
cd backend && php vendor/bin/phpunit tests/Unit/AdkGeneratorEmitTest.php tests/Unit/AdkGeneratorCompileTest.php \
  tests/Unit/WorkflowGraphAnalyzerTest.php tests/Unit/WorkflowGraphAnalyzerAnalyzeTest.php \
  tests/Unit/PythonEmitHelpersPinTest.php tests/Unit/LangGraphParityTest.php
```
Expected: OK (all green).

- [ ] **Step 3: Generate the real GEO script and py_compile it**

Run (reuse the existing generation probe used this session, `/tmp/adk_clean.php`, which writes `/tmp/geo_adk.py`):
```bash
cd backend && php /tmp/adk_clean.php && python3 -m py_compile /tmp/geo_adk.py && echo "py_compile OK"
```
Expected: `py_compile OK`. Confirm the GEO Report node emitted `node_1419 = SequentialAgent(... node_1419_agent, node_1419_skill_1 ...)` and no `RUN_SKILL_SCRIPT_TOOL` on the main agent:
```bash
grep -nE "node_1419 = SequentialAgent|node_1419_skill_1|_make_skill_tool|_skill_instruction" /tmp/geo_adk.py
grep -c "RUN_SKILL_SCRIPT_TOOL" /tmp/geo_adk.py   # expect a definition only, never inside an LlmAgent tools=[…]
```

- [ ] **Step 4: Import the emitted module under real ADK**

Run:
```bash
cp /tmp/geo_adk.py ~/Documents/synergyAI/python/scripts/_geo_skill_test.py
~/Documents/synergyAI/python/.venv/bin/python -c "import importlib.util; s=importlib.util.spec_from_file_location('m','/Users/didierphmartin/Documents/synergyAI/python/scripts/_geo_skill_test.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print('root_agent=', type(m.root_agent).__name__)"
rm -f ~/Documents/synergyAI/python/scripts/_geo_skill_test.py
```
Expected: `root_agent= SequentialAgent` and no import error (confirms the `SequentialAgent`-per-node wrapper, callable instructions, and dir-scoped tools all construct under google-adk 2.3.0).

- [ ] **Step 5: Commit**

```bash
git add backend/tests/fixtures/adk_diamond.golden.py
git commit -m "test(adk): regenerate golden + verify skill-pipeline GEO compiles and imports under ADK"
```

---

## Self-review notes

- **Spec coverage:** analyzer `skills` list (Task 1) ✓; read-live-from-disk + dir-scoped tool + callable instruction (Task 2) ✓; SequentialAgent(main + mandatory skill steps), main agent loses skill tool (Task 3) ✓; detection (Task 4) ✓; golden + real-ADK verification (Task 5) ✓. Interpreter and LangGraph are **out of scope** for Plan A (Plans C and B).
- **Legacy path:** inline `skill_content` (no `bound_skill`) still becomes a skill step (via `inline_md`), so old workflows keep working while gaining the mandatory-post-step semantics.
- **Non-goal reminder:** multi-skill lists already flow through Task 3's `foreach ($skills …)`, but only length-1 is reachable until the future form UI — do not build multi-skill UI here.
