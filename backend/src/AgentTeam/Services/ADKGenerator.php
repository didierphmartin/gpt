<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * ADKGenerator
 *
 * Generates a standalone Python Google ADK script from a saved workflow.
 * The generated file is fully independent of the PHP backend — it runs
 * directly against the Google ADK runtime using LiteLLM for multi-provider
 * model support.
 *
 * emitAdk() is a pure static method (no DB/I/O) so it can be unit-tested
 * without a database. generate() does the DB lookup via WorkflowGraphAnalyzer
 * and then delegates to emitAdk().
 */
class ADKGenerator
{
    public function __construct(
        private PDO $db,
        private WorkflowRepository $workflowRepo,
        private WorkflowGraphRepository $graphRepo,
        private AgentRepository $agentRepo
    ) {}

    /**
     * Generate a Google ADK Python script for the given workflow.
     *
     * @return array{filename: string, code: string}
     */
    public function generate(int $workflowId, ?string $userId = null): array
    {
        $analyzer = new WorkflowGraphAnalyzer($this->db, $this->workflowRepo, $this->graphRepo, $this->agentRepo);
        $analyzed = $analyzer->analyze($workflowId, $userId);
        $name = preg_replace('/[^a-z0-9_]+/i', '_', $analyzed['workflow']['name']);
        return [
            'filename' => strtolower($name) . '_adk.py',
            'code'     => self::emitAdk($analyzed),
        ];
    }

    /**
     * Pure emit entry-point.  Takes an AnalyzedGraph (from WorkflowGraphAnalyzer)
     * and returns the full Python source as a string.  No DB/I/O.
     *
     * Later tasks append blocks (MCP client, skill runner, tools, model factory,
     * agents, layering/root, __main__) into this method.
     */
    public static function emitAdk(array $analyzed): string
    {
        $lines = [];
        $lines[] = self::headerBlock($analyzed);
        $lines[] = self::modelFactoryBlock();
        $lines[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($analyzed['usedServers'], true);
        $lines[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($analyzed['usedCatalog'], true);
        $lines[] = PythonEmitHelpers::mcpClientBlock();
        $lines[] = PythonEmitHelpers::documentConverterBlock();
        $lines[] = self::adkToolBuilderBlock($analyzed);

        // Emit skill runner only when the workflow actually uses skills.
        // Mirror LangGraphGenerator's auto-detect: non-empty skill_content
        // on any agent, OR any agent's systemPrompt already references
        // run_skill_script (assembled by WorkflowGraphAnalyzer).
        $needsSkills = false;
        foreach ($analyzed['agents'] as $agent) {
            if (!empty($agent['skill_content'])) {
                $needsSkills = true;
                break;
            }
            if (strpos((string) ($agent['systemPrompt'] ?? ''), 'run_skill_script') !== false) {
                $needsSkills = true;
                break;
            }
        }
        if ($needsSkills) {
            $lines[] = PythonEmitHelpers::skillDepsBlock();
            $lines[] = self::skillRunnerBlock();
        }

        // catalog must be defined after build_tools_from_catalog() (from adkToolBuilderBlock).
        $lines[] = 'catalog = build_tools_from_catalog()';
        // START_DOCUMENTS baked from the analyzed workflow; always present (empty list when none).
        $lines[] = 'START_DOCUMENTS = ' . PythonEmitHelpers::jsonToPython($analyzed['startDocuments']);
        $lines[] = self::agentsBlock($analyzed);

        $consolidators = self::outputConsolidatorsBlock($analyzed);
        if ($consolidators !== '') {
            $lines[] = $consolidators;
        }
        $lines[] = self::rootBlock($analyzed);
        $lines[] = self::mainBlock($analyzed);

        return implode("\n", $lines) . "\n";
    }

    // -------------------------------------------------------------------------
    // Private emit helpers
    // -------------------------------------------------------------------------

    /**
     * Emit the file header: module docstring + all top-level imports.
     *
     * Uses a heredoc (<<<PY) with column-0 content — same convention as
     * PythonEmitHelpers::mcpClientBlock() — so the emitted Python lines carry
     * no stray PHP indentation.
     */
    private static function headerBlock(array $analyzed): string
    {
        $name = $analyzed['workflow']['name'];
        return <<<PY
"""Standalone Google ADK workflow: {$name}
Auto-generated -- backend-independent. Self-contained: MCP + skills run
in this program's own Python environment.

requirements:
    pip install google-adk litellm httpx
"""
import asyncio, json, os, subprocess, sys, threading, time, traceback, urllib.request
import httpx
from typing import Any

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
PY;
    }

    /**
     * Emit the provider→model factory function.
     *
     * Gemini/google/empty providers return a bare model string (ADK native).
     * All other providers are mapped via LiteLlm with a known prefix table;
     * unknown providers default to "<provider>/" as a passthrough prefix.
     * If the model string already contains "/" it is used as-is (no prefix).
     *
     * Uses a nowdoc (<<<'PY') — no PHP interpolation needed.
     */
    private static function modelFactoryBlock(): string
    {
        return <<<'PY'
def _make_model(provider: str, model: str):
    """Resolve a (provider, model) pair to an ADK model.

    Gemini -> native model string; everything else -> LiteLlm. Grok/DeepSeek/Kimi
    are OpenAI-compatible endpoints (mirrors the PHP providers / LangGraph runner),
    so they route through litellm's openai/ handler with a custom api_base. API keys
    come from the environment (.env). The (provider, model) pair is resolved by the
    generator — a blank model already fell back to the provider default upstream.
    """
    p = (provider or "claude").lower()
    if not model:
        raise RuntimeError(
            f"No model for provider {p!r}. Set a model on the agent in the editor, "
            "or a default in system_llm_settings."
        )
    if p in ("gemini", "google", "google-genai"):
        return model
    if p in ("claude", "anthropic"):
        return LiteLlm(model=model if "/" in model else "anthropic/" + model)
    if p == "openai":
        return LiteLlm(model=model if "/" in model else "openai/" + model)
    if p in ("grok", "xai"):
        return LiteLlm(
            model="openai/" + model,
            api_base="https://api.x.ai/v1",
            api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),
        )
    if p == "deepseek":
        return LiteLlm(
            model="openai/" + model,
            api_base="https://api.deepseek.com",
            api_key=os.environ.get("DEEPSEEK_API_KEY"),
        )
    if p == "kimi":
        kwargs = dict(
            model="openai/" + model,
            api_base="https://api.moonshot.ai/v1",
            api_key=os.environ.get("KIMI_API_KEY"),
        )
        if model.startswith("kimi-k2"):
            # K2 enforces non-thinking sampling; mirror the PHP KimiProvider.
            kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
        return LiteLlm(**kwargs)
    # Fallback: best-effort litellm prefixed spec.
    return LiteLlm(model=model if "/" in model else p + "/" + model)
PY;
    }

    /**
     * Emit the ADK-specific async skill runner.
     *
     * Called only when any agent uses skills (see emitAdk()).
     * Depends on PythonEmitHelpers::skillDepsBlock() being emitted first
     * (provides SKILLS_DIR + _ensure_skill_deps).
     *
     * Uses asyncio.create_subprocess_exec so skill calls inside a
     * ParallelAgent layer don't block the event loop (contrast: the
     * LangGraphGenerator path uses blocking subprocess.run).
     *
     * Uses a nowdoc (<<<'PY') — no PHP interpolation; Python at column 0.
     */
    private static function skillRunnerBlock(): string
    {
        return <<<'PY'
async def _run_skill_script(dir_name: str, script: str, argv: list[str] | None = None,
                            input_files: dict | None = None, read_outputs: bool = True) -> str:
    """Run a skill's Python script as a subprocess in THIS environment."""
    argv = argv or []
    skill_path = os.path.join(SKILLS_DIR, dir_name)
    _ensure_skill_deps(skill_path)  # ported: parse SKILL.md frontmatter, pip install once
    script_path = os.path.join(skill_path, script)
    proc = await asyncio.create_subprocess_exec(
        sys.executable, script_path, *[str(a) for a in argv],
        cwd=skill_path,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        return f"[skill error rc={proc.returncode}] {err.decode('utf-8', 'replace')}"
    return out.decode("utf-8", "replace")

RUN_SKILL_SCRIPT_TOOL = FunctionTool(_run_skill_script)
PY;
    }

    /**
     * Emit one `LlmAgent` per agent node in $analyzed['agents'].
     *
     * Instruction assembly:
     *  1. systemPrompt
     *  2. If skill_content non-empty: append "\n\n## Skill\n" + skill_content
     *  3. For each parent that is itself an agent: append "\n\n## Input from node {p}\n{node_{p}}"
     *     The `{node_<p>}` is an ADK state placeholder and must survive into the emitted Python
     *     as a literal brace expression — PythonEmitHelpers::pyStr() produces a non-f-string, so
     *     braces are safe.
     *
     * Tools: map each tool name to catalog["<name>"]; if instruction references run_skill_script,
     * also add RUN_SKILL_SCRIPT_TOOL.
     *
     * generate_content_config is emitted only when temperature or max_tokens is non-null.
     *
     * All nodes emitted at column 0.
     */
    private static function agentsBlock(array $analyzed): string
    {
        $out = [];
        foreach ($analyzed['agents'] as $id => $ag) {
            $instr = $ag['systemPrompt'];
            if ($ag['skill_content'] !== '') {
                $instr .= "\n\n## Skill\n" . $ag['skill_content'];
            }
            // Only inject from parents that are themselves agent nodes.
            $agentParents = array_values(array_filter(
                $analyzed['parents'][$id] ?? [],
                fn($p) => isset($analyzed['agents'][$p])
            ));
            foreach ($agentParents as $p) {
                // PHP: {node_{$p}} → literal "{node_2}" (PHP only interpolates {$...}, not {word_{$...}}).
                $instr .= "\n\n## Input from node {$p}\n{node_{$p}}";
            }

            $toolExprs = [];
            foreach ($ag['tools'] as $t) {
                $toolExprs[] = 'catalog["' . $t . '"]';
            }
            if (strpos($instr, 'run_skill_script') !== false) {
                $toolExprs[] = 'RUN_SKILL_SCRIPT_TOOL';
            }
            $toolsPy = '[' . implode(', ', $toolExprs) . ']';

            $model = '_make_model("' . $ag['provider'] . '", "' . $ag['model'] . '")';

            $entry  = "node_{$id} = LlmAgent(\n";
            $entry .= "    name=\"node_{$id}\",\n";
            $entry .= "    model={$model},\n";
            $entry .= "    instruction=" . PythonEmitHelpers::pyStr($instr) . ",\n";
            $entry .= "    tools={$toolsPy},\n";
            // Emit the agent-form values verbatim — never override a form-stated
            // parameter. If a value is invalid for a model (e.g. Kimi K2 requires
            // temperature 0.6), that's surfaced to the user to fix in the form.
            if ($ag['temperature'] !== null || $ag['max_tokens'] !== null) {
                $kwargs = [];
                if ($ag['temperature'] !== null) {
                    $kwargs[] = "temperature=" . json_encode($ag['temperature']);
                }
                if ($ag['max_tokens'] !== null) {
                    $kwargs[] = "max_output_tokens=" . json_encode($ag['max_tokens']);
                }
                $entry .= "    generate_content_config=types.GenerateContentConfig(" . implode(", ", $kwargs) . "),\n";
            }
            $entry .= "    output_key=\"node_{$id}\",\n";
            $entry .= ")";

            $out[] = $entry;
        }
        return implode("\n\n", $out);
    }

    /**
     * Emit LlmAgent consolidators for each `output` node.
     *
     * Each output node gets a dedicated LlmAgent whose instruction asks the model
     * to consolidate all parent results.  The `{node_<p>}` tokens are ADK state
     * placeholders; PythonEmitHelpers::pyStr() emits a non-f-string so braces
     * survive into the generated Python verbatim.
     *
     * Returns an empty string when the workflow has no output nodes.
     */
    private static function outputConsolidatorsBlock(array $analyzed): string
    {
        $out = [];
        foreach ($analyzed['byId'] as $id => $node) {
            $id = (string) $id;
            if (WorkflowGraphAnalyzer::typeOf($node) !== 'output') {
                continue;
            }
            $parents = $analyzed['parents'][$id] ?? [];
            $instr = "Consolidate the following results into the final answer.\n\n";
            foreach ($parents as $p) {
                // {$p} is PHP interpolation (gives e.g. "2").  The surrounding
                // { and } are literal characters — not PHP interpolation — because
                // there is no $ immediately after the opening {.
                $instr .= "{node_{$p}}\n";
            }
            $instr = rtrim($instr);

            // Derive consolidator model from first agent parent; fall back to Gemini default.
            $consolidatorModel = '_make_model("", "")';
            foreach ($parents as $p) {
                if (isset($analyzed['agents'][$p])) {
                    $ag = $analyzed['agents'][$p];
                    $prov = addslashes($ag['provider']);
                    $mod  = addslashes($ag['model']);
                    $consolidatorModel = "_make_model(\"{$prov}\", \"{$mod}\")";
                    break;
                }
            }

            $entry  = "node_{$id} = LlmAgent(\n";
            $entry .= "    name=\"node_{$id}\",\n";
            $entry .= "    model={$consolidatorModel},\n";
            $entry .= "    instruction=" . PythonEmitHelpers::pyStr($instr) . ",\n";
            $entry .= "    tools=[],\n";
            $entry .= "    output_key=\"node_{$id}\",\n";
            $entry .= ")";
            $out[] = $entry;
        }
        return implode("\n\n", $out);
    }

    /**
     * Build `root_agent = SequentialAgent(...)` from the topological layers.
     *
     * Layer 0 (start node) is skipped because the start node only seeds state
     * and is not itself an LlmAgent.  For each subsequent layer:
     *  - Collect `node_<id>` var names of runnable nodes (agent / agent-template / output).
     *  - A layer with exactly one runnable → use that var directly.
     *  - A layer with >1 runnables → wrap in ParallelAgent.
     * Empty layers (all structural nodes) are skipped.
     */
    private static function rootBlock(array $analyzed): string
    {
        $isRunnable = function (string $id) use ($analyzed): bool {
            $t = WorkflowGraphAnalyzer::typeOf($analyzed['byId'][$id]);
            return in_array($t, ['agent', 'agent-template', 'output'], true);
        };
        $layerExprs = [];
        foreach ($analyzed['layers'] as $k => $layer) {
            $vars = [];
            foreach ($layer as $id) {
                if ($isRunnable($id)) {
                    $vars[] = "node_{$id}";
                }
            }
            if (!$vars) {
                continue;
            }
            if (count($vars) === 1) {
                $layerExprs[] = $vars[0];
            } else {
                $layerExprs[] = "ParallelAgent(name=\"layer_{$k}\", sub_agents=[" . implode(', ', $vars) . "])";
            }
        }
        $body = implode(",\n    ", $layerExprs);
        return "root_agent = SequentialAgent(\n    name=\"workflow\",\n    sub_agents=[\n    {$body}\n    ],\n)";
    }

    /**
     * Emit `async def main(...)` + `if __name__ == "__main__"` block.
     *
     * Key correctness points:
     *  - `await session_service.create_session(...)` — InMemorySessionService.create_session
     *    is a coroutine; missing await causes "coroutine was never awaited".
     *  - State is seeded via InMemorySessionService; user prompt is passed as
     *    a types.Content message to runner.run_async().
     *  - `from google.genai import types` is already in the header; the local
     *    import here is harmless (re-importing a cached module is a no-op).
     *
     * Uses explicit string concatenation (column 0, no heredoc ambiguity).
     */
    private static function mainBlock(array $analyzed): string
    {
        $sp = PythonEmitHelpers::pyStr($analyzed['startPrompt']);
        $name = PythonEmitHelpers::pyStr($analyzed['workflow']['name']);
        return
            "WORKFLOW_NAME = {$name}\n" .
            "\n" .
            "async def main(user_prompt: str = {$sp}):\n" .
            "    if START_DOCUMENTS:\n" .
            "        doc_parts = []\n" .
            "        for doc in START_DOCUMENTS:\n" .
            "            name = doc.get(\"name\", \"Document\")\n" .
            "            path = doc.get(\"path\", \"\")\n" .
            "            if not path:\n" .
            "                doc_parts.append(f\"### {name}\\n\\n_(no path on attachment record)_\")\n" .
            "                continue\n" .
            "            try:\n" .
            "                md = _convert_doc_to_markdown(path)\n" .
            "                doc_parts.append(f\"### {name}\\n\\n{md}\")\n" .
            "            except Exception as e:\n" .
            "                doc_parts.append(f\"### {name}\\n\\n_(conversion failed: {e})_\")\n" .
            "        if doc_parts:\n" .
            "            user_prompt = (\n" .
            "                \"## Attached Documents\\n\\n\"\n" .
            "                + \"\\n\\n---\\n\\n\".join(doc_parts)\n" .
            "                + \"\\n\\n---\\n\\n\"\n" .
            "                + user_prompt\n" .
            "            )\n" .
            "    print(f\"[workflow] {WORKFLOW_NAME} starting\", flush=True)\n" .
            "    print(f\"[workflow] prompt: {user_prompt[:200]!r}\", flush=True)\n" .
            "    session_service = InMemorySessionService()\n" .
            "    runner = Runner(agent=root_agent, app_name=\"workflow\", session_service=session_service)\n" .
            "    session = await session_service.create_session(app_name=\"workflow\", user_id=\"local\", state={})\n" .
            "    final = \"\"\n" .
            "    t0 = time.monotonic()\n" .
            "    seen = set()\n" .
            "    content = types.Content(role=\"user\", parts=[types.Part(text=user_prompt)])\n" .
            "    try:\n" .
            "        async for event in runner.run_async(user_id=\"local\", session_id=session.id, new_message=content):\n" .
            "            author = getattr(event, \"author\", \"?\")\n" .
            "            if author and author not in seen:\n" .
            "                seen.add(author)\n" .
            "                print(f\"[node] > {author}\", flush=True)\n" .
            "            parts = (event.content.parts if event.content else None) or []\n" .
            "            for p in parts:\n" .
            "                fc = getattr(p, \"function_call\", None)\n" .
            "                fr = getattr(p, \"function_response\", None)\n" .
            "                if fc is not None:\n" .
            "                    _a = str(getattr(fc, \"args\", \"\"))[:200]\n" .
            "                    print(f\"[tool] -> {fc.name}({_a})\", flush=True)\n" .
            "                elif fr is not None:\n" .
            "                    _r = str(getattr(fr, \"response\", \"\"))[:200]\n" .
            "                    print(f\"[tool] <- {fr.name}: {_r}\", flush=True)\n" .
            "                else:\n" .
            "                    txt = (getattr(p, \"text\", None) or \"\").strip()\n" .
            "                    if txt:\n" .
            "                        print(f\"[{author}] {txt[:240]}\", flush=True)\n" .
            "            if event.is_final_response() and event.content and event.content.parts:\n" .
            "                final = event.content.parts[0].text or final\n" .
            "        print(f\"[workflow] done in {time.monotonic() - t0:.1f}s, {len(final)} chars\", flush=True)\n" .
            "    except Exception:\n" .
            "        print(\"[workflow] ERROR:\", flush=True)\n" .
            "        traceback.print_exc()\n" .
            "        raise\n" .
            "    os.makedirs(\"outputs\", exist_ok=True)\n" .
            "    _head = final[:500].lower()\n" .
            "    _ext = \"html\" if (\"<!doctype\" in _head or \"<html\" in _head) else \"md\"\n" .
            "    _slug = \"\".join(c if c.isalnum() else \"_\" for c in WORKFLOW_NAME).strip(\"_\")[:60] or \"workflow\"\n" .
            "    _ts = time.strftime(\"%Y%m%d-%H%M%S\")\n" .
            "    _out = os.path.join(\"outputs\", f\"{_slug}_{_ts}.{_ext}\")\n" .
            "    with open(_out, \"w\", encoding=\"utf-8\") as _f:\n" .
            "        _f.write(final)\n" .
            "    print(f\"[workflow] result saved to {os.path.abspath(_out)}\", flush=True)\n" .
            "    print(final)\n" .
            "    return final\n" .
            "\n" .
            "if __name__ == \"__main__\":\n" .
            "    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else {$sp}))";
    }

    /**
     * Emit concrete typed FunctionTool functions from TOOL_CATALOG input_schema.
     *
     * For each tool in $analyzed['usedCatalog'] we emit a concrete Python
     * function `_tool_<sanitized>` whose signature is derived from the tool's
     * `input_schema.properties`.  ADK introspects the function signature to
     * build the tool's parameter schema, so a concrete signature is required
     * for the model to pass structured arguments.
     *
     * JSON type → Python hint: string→str, integer→int, number→float,
     * boolean→bool, array→list, object→dict, unknown→str.
     * Required properties have no default; optional properties default to None.
     * Required params are emitted before optional params (Python signature rule).
     * Property names that are not valid Python identifiers are collected into
     * a trailing **extra parameter (rare).
     *
     * A Google-style docstring (description + Args section) is emitted so ADK
     * surfaces per-parameter descriptions to the model.
     *
     * The server URL is baked as a literal per-function (via pyStr()) so no
     * closure binding is needed.
     *
     * `build_tools_from_catalog()` returns a plain dict keyed by the REAL tool
     * name mapping to FunctionTool(<fn>).  When usedCatalog is empty, it
     * returns {}.
     */
    private static function adkToolBuilderBlock(array $analyzed): string
    {
        $typeMap = [
            'string'  => 'str',
            'integer' => 'int',
            'number'  => 'float',
            'boolean' => 'bool',
            'array'   => 'list',
            'object'  => 'dict',
        ];

        $functions      = [];
        $catalogEntries = [];

        foreach ($analyzed['usedCatalog'] as $toolName => $spec) {
            $description = (string) ($spec['description'] ?? $toolName);
            $inputSchema = is_array($spec['input_schema'] ?? null) ? $spec['input_schema'] : [];
            $properties  = is_array($inputSchema['properties'] ?? null)
                            ? (array) $inputSchema['properties'] : [];
            $required    = is_array($inputSchema['required'] ?? null)
                            ? $inputSchema['required'] : [];
            $serverUrl   = (string) ($spec['server_url'] ?? '');

            // Sanitize tool name to a valid Python identifier for the function name.
            $safeName = preg_replace('/[^A-Za-z0-9_]/', '_', $toolName);
            if (preg_match('/^[0-9]/', $safeName)) {
                $safeName = '_' . $safeName;
            }
            $fnName = '_tool_' . $safeName;

            $requiredSet = array_flip($required);

            // Python reserved words: a property named after a keyword cannot be a named
            // parameter (e.g. `def f(in: str)` is a SyntaxError).  Route them to **extra.
            static $pyKeywords = [
                'False' => true, 'None' => true, 'True' => true,
                'and' => true, 'as' => true, 'assert' => true,
                'async' => true, 'await' => true, 'break' => true,
                'class' => true, 'continue' => true, 'def' => true,
                'del' => true, 'elif' => true, 'else' => true,
                'except' => true, 'finally' => true, 'for' => true,
                'from' => true, 'global' => true, 'if' => true,
                'import' => true, 'in' => true, 'is' => true,
                'lambda' => true, 'nonlocal' => true, 'not' => true,
                'or' => true, 'pass' => true, 'raise' => true,
                'return' => true, 'try' => true, 'while' => true,
                'with' => true, 'yield' => true,
            ];

            // Split properties into valid-identifier required vs optional.
            // Properties whose names are not valid Python identifiers OR are Python
            // keywords fall into **extra.
            $validRequired = [];
            $validOptional = [];
            $hasExtra      = false;

            foreach ($required as $pname) {
                $pname = (string) $pname;
                if (!array_key_exists($pname, $properties)) {
                    continue;
                }
                if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $pname) && !isset($pyKeywords[$pname])) {
                    $validRequired[$pname] = is_array($properties[$pname]) ? $properties[$pname] : [];
                } else {
                    $hasExtra = true;
                }
            }

            foreach ($properties as $pname => $pspec) {
                $pname = (string) $pname;
                if (isset($requiredSet[$pname])) {
                    continue; // already handled
                }
                if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $pname) && !isset($pyKeywords[$pname])) {
                    $validOptional[$pname] = is_array($pspec) ? $pspec : [];
                } else {
                    $hasExtra = true;
                }
            }

            // Build parameter list: required first (no default), optional second (default=None).
            $params = [];
            foreach ($validRequired as $pname => $pspec) {
                $type     = $typeMap[$pspec['type'] ?? ''] ?? 'str';
                $params[] = "{$pname}: {$type}";
            }
            foreach ($validOptional as $pname => $pspec) {
                $type     = $typeMap[$pspec['type'] ?? ''] ?? 'str';
                $params[] = "{$pname}: {$type} = None";
            }
            if ($hasExtra) {
                $params[] = '**extra';
            }

            $paramStr      = implode(', ', $params);
            $allValidProps = array_merge($validRequired, $validOptional);

            // Build Google-style docstring.
            $safeDesc = str_replace('"""', '\\"\\"\\"', $description);
            $doc = "    \"\"\"{$safeDesc}";
            if ($allValidProps) {
                $doc .= "\n\n    Args:";
                foreach ($allValidProps as $pname => $pspec) {
                    $pDesc = (string) ($pspec['description'] ?? '');
                    $doc  .= "\n        {$pname}: {$pDesc}";
                }
            }
            $doc .= "\n    \"\"\"";

            // Build body: assemble _args (omit None optional values), then call MCP.
            $pyUrl  = PythonEmitHelpers::pyStr($serverUrl);
            $pyName = PythonEmitHelpers::pyStr($toolName);

            if ($allValidProps || $hasExtra) {
                $argPairs = [];
                foreach ($allValidProps as $pname => $pspec) {
                    $argPairs[] = "\"{$pname}\": {$pname}";
                }
                if ($hasExtra) {
                    $innerDict = '{' . implode(', ', $argPairs) . '}';
                    $argDict   = "{**{$innerDict}, **extra}";
                } else {
                    $argDict = '{' . implode(', ', $argPairs) . '}';
                }
                $body  = "    _args = {k: v for k, v in {$argDict}.items() if v is not None}\n";
                $body .= "    return _call_mcp_tool({$pyUrl}, {$pyName}, _args)";
            } else {
                // No properties — empty-schema tool; pass empty dict.
                $body = "    return _call_mcp_tool({$pyUrl}, {$pyName}, {})";
            }

            $functions[]      = "def {$fnName}({$paramStr}) -> str:\n{$doc}\n{$body}";
            $pyToolName       = PythonEmitHelpers::pyStr($toolName);
            $catalogEntries[] = "        {$pyToolName}: FunctionTool({$fnName})";
        }

        // Emit concrete _tool_* functions at module scope before build_tools_from_catalog.
        $out = '';
        if ($functions) {
            $out .= implode("\n\n", $functions) . "\n\n";
        }

        // build_tools_from_catalog always present; returns {} when no tools.
        if ($catalogEntries) {
            $out .= "def build_tools_from_catalog() -> dict:\n";
            $out .= "    return {\n";
            $out .= implode(",\n", $catalogEntries) . ",\n";
            $out .= "    }";
        } else {
            $out .= "def build_tools_from_catalog() -> dict:\n";
            $out .= "    return {}";
        }

        return $out;
    }
}
