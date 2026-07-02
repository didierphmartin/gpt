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
        $lines[] = self::adkToolBuilderBlock();

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
import asyncio, json, os, subprocess, sys, threading, time, urllib.request
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
_LITELLM_PREFIX = {
    "claude": "anthropic/", "anthropic": "anthropic/",
    "openai": "openai/", "grok": "xai/", "xai": "xai/",
    "mistral": "mistral/", "groq": "groq/",
}

def _make_model(provider: str, model: str):
    p = (provider or "").lower()
    if p in ("gemini", "google", "google-genai", ""):
        return model or "gemini-2.5-pro"
    prefix = _LITELLM_PREFIX.get(p, p + "/")
    spec = model if "/" in model else prefix + model
    return LiteLlm(model=spec)
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
        return
            "async def main(user_prompt: str = {$sp}):\n" .
            "    session_service = InMemorySessionService()\n" .
            "    runner = Runner(agent=root_agent, app_name=\"workflow\", session_service=session_service)\n" .
            "    session = await session_service.create_session(app_name=\"workflow\", user_id=\"local\", state={})\n" .
            "    final = \"\"\n" .
            "    content = types.Content(role=\"user\", parts=[types.Part(text=user_prompt)])\n" .
            "    async for event in runner.run_async(user_id=\"local\", session_id=session.id, new_message=content):\n" .
            "        if event.is_final_response() and event.content and event.content.parts:\n" .
            "            final = event.content.parts[0].text or final\n" .
            "    os.makedirs(\"outputs\", exist_ok=True)\n" .
            "    print(final)\n" .
            "    return final\n" .
            "\n" .
            "if __name__ == \"__main__\":\n" .
            "    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else {$sp}))";
    }

    /**
     * Emit the ADK FunctionTool builder block.
     *
     * Returns a top-level `build_tools_from_catalog() -> dict` function that
     * iterates TOOL_CATALOG, resolves each tool's server URL from MCP_SERVERS,
     * and wraps a `_call_mcp_tool` closure as a `FunctionTool`.
     *
     * Uses a nowdoc (<<<'PY') — no PHP interpolation; Python at column 0.
     */
    private static function adkToolBuilderBlock(): string
    {
        return <<<'PY'
def build_tools_from_catalog() -> dict:
    tools = {}
    for name, spec in TOOL_CATALOG.items():
        url = spec.get("server_url", "")
        def _make(_name=name, _url=url):
            def _fn(**kwargs) -> str:
                """MCP tool proxy."""
                return _call_mcp_tool(_url, _name, kwargs)
            _fn.__name__ = _name
            _fn.__doc__ = TOOL_CATALOG.get(_name, {}).get("description", _name)
            return FunctionTool(_fn)
        tools[name] = _make()
    return tools
PY;
    }
}
