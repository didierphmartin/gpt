<?php
declare(strict_types=1);

namespace AgentTeam\Services;

use PDO;

/**
 * Compiles a workflow DSL into a self-contained Microsoft Agent Framework
 * (Functional API) Python program. Third backend beside ADKGenerator /
 * LangGraphGenerator; reuses WorkflowGraphAnalyzer + PythonEmitHelpers.
 */
class MAFGenerator
{
    public function __construct(
        private PDO $db,
        private WorkflowRepository $workflowRepo,
        private WorkflowGraphRepository $graphRepo,
        private AgentRepository $agentRepo
    ) {}

    public function generate(int $workflowId, ?string $userId = null): array
    {
        $analyzer = new WorkflowGraphAnalyzer($this->db, $this->workflowRepo, $this->graphRepo, $this->agentRepo);
        $analyzed = $analyzer->analyze($workflowId, $userId);
        $name = preg_replace('/[^a-z0-9_]+/i', '_', $analyzed['workflow']['name']);
        return [
            'filename' => strtolower($name) . '_maf.py',
            'code'     => self::emitMaf($analyzed),
        ];
    }

    public static function emitMaf(array $analyzed): string
    {
        $parts = [];
        $parts[] = self::headerBlock($analyzed);
        $parts[] = self::clientFactoryBlock();
        if (!empty($analyzed['usedCatalog'])) {
            $parts[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($analyzed['usedServers'], true);
            $parts[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($analyzed['usedCatalog'], true);
            $parts[] = PythonEmitHelpers::mcpClientBlock();
            $parts[] = self::mcpToolBuilderBlock($analyzed);
            $parts[] = 'catalog = build_tools_from_catalog()';
        } else {
            $parts[] = 'catalog = {}';
        }
        $parts[] = PythonEmitHelpers::documentConverterBlock();
        // Skill runtime: emit BEFORE agentsBlock so _run_skill_step is defined
        // when _run_node calls it. Gate on any agent having a non-empty skills list.
        $needsSkills = false;
        foreach ($analyzed['agents'] as $ag) {
            if (!empty($ag['skills'])) { $needsSkills = true; break; }
        }
        if ($needsSkills) {
            $parts[] = PythonEmitHelpers::skillDepsBlock();   // SKILLS_DIR + _ensure_skill_deps
            $parts[] = self::skillRunnerBlock();
        }
        $parts[] = self::agentsBlock($analyzed);
        // globalsBlock MUST precede orchestrationBlock: DEFAULT_PROMPT is used as
        // the default parameter value in `main()`'s signature, which Python resolves
        // at def-execution time (when the `async def main` line runs), so it must
        // exist before that line executes.
        $parts[] = self::globalsBlock($analyzed);
        $parts[] = self::orchestrationBlock($analyzed);
        $parts[] = self::entryBlock();
        return implode("\n\n", $parts) . "\n";
    }

    /** Expose skillRunnerBlock for test/inspection (test seam). */
    public static function skillRunnerBlockForTest(): string { return self::skillRunnerBlock(); }

    /**
     * Emit concrete _tool_* functions + build_tools_from_catalog() for MAF.
     *
     * Ported from ADKGenerator::adkToolBuilderBlock() with ONE change:
     * catalog entries map to the **plain function** (MAF auto-wraps callables),
     * NOT FunctionTool(_tool_x). i.e. `catalog["name"] = _tool_fn` (no wrapper).
     */
    private static function mcpToolBuilderBlock(array $analyzed): string
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
            // MAF auto-wraps plain callables — no FunctionTool wrapper needed.
            $catalogEntries[] = "        {$pyToolName}: {$fnName}";
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

    private static function headerBlock(array $analyzed): string
    {
        $name = str_replace(['"""', "\\"], ["'''", "\\\\"], (string) $analyzed['workflow']['name']);
        return <<<PY
        """Standalone Microsoft Agent Framework workflow: {$name}

        Auto-generated from the visual workflow editor. Backend-independent and
        self-contained: it calls the LLM providers, MCP servers, and folder-backed
        skills entirely from this one file.

        TO RUN:
            pip install "agent-framework>=1.10,<2" httpx python-dotenv
            # keys are read from ../.env (ANTHROPIC_API_KEY, OPENAI_API_KEY,
            #   GOOGLE_API_KEY, XAI_API_KEY, KIMI_API_KEY, DEEPSEEK_API_KEY)
            python this_file.py "your prompt here"
        """
        import asyncio
        import json
        import os
        import subprocess
        import sys
        import threading
        import time
        import traceback
        import urllib.request

        import httpx
        from dotenv import load_dotenv
        from agent_framework import Agent, workflow
        from agent_framework.anthropic import AnthropicClient
        from agent_framework.openai import OpenAIChatCompletionClient

        # MAF does not auto-load .env; load the runner's .env (one dir up from scripts/).
        load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
        PY;
    }

    private static function clientFactoryBlock(): string
    {
        return <<<'PY'
        def _make_client(provider: str, model: str):
            """Build a MAF chat client for the given provider/model. Claude uses the
            native AnthropicClient; everyone else uses OpenAIChatCompletionClient (the
            /chat/completions client) -- OpenAIChatClient targets /responses and 404s
            on OpenAI-compatible endpoints (Gemini/Grok/Kimi/DeepSeek)."""
            p = (provider or "claude").lower()
            if p == "claude":
                return AnthropicClient(model=model, api_key=os.environ.get("ANTHROPIC_API_KEY"))
            if p == "openai":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("OPENAI_API_KEY"))
            if p in ("gemini", "google"):
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("GOOGLE_API_KEY"),
                    base_url="https://generativelanguage.googleapis.com/v1beta/openai/")
            if p == "grok":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("XAI_API_KEY"),
                    base_url="https://api.x.ai/v1")
            if p == "kimi":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("KIMI_API_KEY"),
                    base_url="https://api.moonshot.ai/v1")
            if p == "deepseek":
                return OpenAIChatCompletionClient(model=model, api_key=os.environ.get("DEEPSEEK_API_KEY"),
                    base_url="https://api.deepseek.com")
            raise RuntimeError(f"Unknown provider {provider!r} for model {model!r}")
        PY;
    }

    /**
     * Emit the MAF skill runtime block.
     *
     * Structure:
     *  1. PythonEmitHelpers::skillFsSyncBlock() — shared, LangChain-free sync skill FS
     *     (globals, bucketed dirs, argv remap, input_files staging, read_outputs → stash,
     *     _read_skill_md). Depends on SKILLS_DIR + _ensure_skill_deps from
     *     skillDepsBlock() which is emitted immediately before this block.
     *  2. MAF-specific _make_skill_tool (plain callable — MAF auto-wraps) and
     *     _run_skill_step (async, provider/model explicit, captures deliverable
     *     via _LAST_SKILL_OUTPUTS).
     *
     * No LangChain imports — MAF uses plain callables, not StructuredTool.
     */
    private static function skillRunnerBlock(): string
    {
        // MAF-specific: _make_skill_tool (plain callable auto-wrapped by MAF) +
        // _run_skill_step (async, provider/model explicit, captures deliverable).
        // Two leading blank lines complete the two-blank-line separator after
        // _read_skill_md (skillFsSyncBlock ends with a single \n).
        $mafSpecific = <<<'PY'


def _make_skill_tool(dir_name: str):
    """run_skill_script bound to ONE skill dir. Plain callable — MAF auto-wraps it."""
    def run_skill_script(script: str, argv=None, input_files=None, read_outputs=None) -> str:
        return _run_skill_script(dir_name, script, argv, input_files, read_outputs)
    run_skill_script.__name__ = "run_skill_script"
    run_skill_script.__doc__ = (
        "Run a script in the '" + dir_name + "' skill (dir fixed). Stage authored "
        "content via input_files and pass the output path(s) in read_outputs.")
    return run_skill_script


async def _run_skill_step(skill, prior, provider, model):
    """Mandatory skill step on `prior` (previous stage output). A dir-backed skill
    is a MAF Agent instructed by SKILL.md with a dir-scoped run_skill_script tool;
    the step output becomes the produced deliverable file (via _LAST_SKILL_OUTPUTS)
    when it wrote one, else the LLM text. Inline skill = an LLM transform."""
    dir_name = skill.get("dir", "")
    body = skill.get("inline") or (_read_skill_md(dir_name) if dir_name else "")
    system = (
        "You are running the '" + (dir_name or "inline") + "' skill as a MANDATORY "
        "step. Apply the skill to the INPUT. If the skill produces a document/file "
        "(e.g. HTML via a create/render script), you MUST call run_skill_script -- "
        "stage authored content via input_files and pass the output path in "
        "read_outputs; the workflow captures that produced file as this node's "
        "output. If the skill has no script, return the transformed result.\n\n"
        "=== SKILL INSTRUCTIONS ===\n" + body)
    tools = [_make_skill_tool(dir_name)] if dir_name else []
    if dir_name:
        _LAST_SKILL_OUTPUTS.pop(dir_name, None)
    agent = Agent(_make_client(provider, model), instructions=system,
                  name="skill_step", tools=tools)
    text = (await agent.run("## INPUT (apply the skill to this)\n" + str(prior))).text or ""
    produced = _LAST_SKILL_OUTPUTS.pop(dir_name, None) if dir_name else None
    return produced[-1] if produced else text
PY;

        return PythonEmitHelpers::skillFsSyncBlock() . $mafSpecific;
    }

    /** Bake AGENTS metadata dict + the per-node async runner + fan-in helper. */
    private static function agentsBlock(array $analyzed): string
    {
        $entries = [];
        foreach ($analyzed['agents'] as $id => $ag) {
            $instr = (string) ($ag['systemPrompt'] ?? '');
            $tools = array_map(fn($t) => 'catalog.get(' . PythonEmitHelpers::pyStr($t) . ')', $ag['tools'] ?? []);
            $toolsPy = '[' . implode(', ', array_filter($tools)) . ']';
            // Skills baked for Task 3; empty list here is harmless.
            $skillsPy = PythonEmitHelpers::jsonToPython($ag['skills'] ?? []);
            $entries[] = '    ' . PythonEmitHelpers::pyStr((string) $id) . ': {'
                . '"provider": ' . PythonEmitHelpers::pyStr((string) ($ag['provider'] ?? 'claude')) . ', '
                . '"model": ' . PythonEmitHelpers::pyStr((string) ($ag['model'] ?? '')) . ', '
                . '"instructions": ' . PythonEmitHelpers::pyStr($instr) . ', '
                . '"tools": ' . $toolsPy . ', '
                . '"skills": ' . $skillsPy . '},';
        }
        $agents = "AGENTS = {\n" . implode("\n", $entries) . "\n}";

        $runner = <<<'PY'
        async def _run_node(nid, _input):
            """Run one node: the output node is a pass-through (returns its merged input);
            an agent node runs its LLM, then its mandatory skill pipeline (Task 3)."""
            ad = AGENTS.get(nid)
            if ad is None:                      # output / pass-through node
                return _input
            client = _make_client(ad["provider"], ad["model"])
            agent = Agent(client, instructions=ad["instructions"],
                          name=f"node_{nid}", tools=ad["tools"])
            text = (await agent.run(_input)).text or ""
            for _skill in ad.get("skills", []):
                text = await _run_skill_step(_skill, text, ad["provider"], ad["model"])
            return text


        def _build_input(parents, node_outputs, user_prompt):
            """Merge parent outputs (fan-in) as this node's input; the start node's
            children get the user prompt."""
            parts = []
            for p in parents:
                if p in node_outputs:
                    parts.append(str(node_outputs[p]))
            if not parts:
                return user_prompt
            if len(parts) == 1:
                return parts[0]
            return "\n\n---\n\n".join(parts)
        PY;
        return $agents . "\n\n\n" . $runner;
    }

    /** DEFAULT_PROMPT + workflow/storage globals.
     *  MUST be emitted before orchestrationBlock because DEFAULT_PROMPT is
     *  used as a default parameter value in `async def main`'s signature. */
    private static function globalsBlock(array $analyzed): string
    {
        $sp      = PythonEmitHelpers::pyStr((string) $analyzed['startPrompt']);
        $wfName  = PythonEmitHelpers::pyStr((string) $analyzed['workflow']['name']);
        $wfId    = (int) $analyzed['workflow']['id'];
        $enabled = !empty($analyzed['outputStorageEnabled']) ? 'True' : 'False';
        $folder  = $analyzed['outputFolder'] ? PythonEmitHelpers::pyStr((string) $analyzed['outputFolder']) : 'None';
        return "DEFAULT_PROMPT = {$sp}\n"
             . "WORKFLOW_NAME = {$wfName}\n"
             . "WORKFLOW_ID = {$wfId}\n"
             . "OUTPUT_STORAGE_ENABLED = {$enabled}\n"
             . "OUTPUT_FOLDER = {$folder}";
    }

    /** Topological LAYERS + PARENTS + OUTPUT_NODE_ID + the @workflow main function. */
    private static function orchestrationBlock(array $analyzed): string
    {
        $layers  = PythonEmitHelpers::jsonToPython(array_values($analyzed['layers']));
        $parents = PythonEmitHelpers::jsonToPython($analyzed['parents'], true);
        // First node whose type == 'output' is the fan-in sink.
        $outId = '';
        foreach ($analyzed['byId'] as $id => $node) {
            $t = $node['type'] ?? ($node['config']['type'] ?? '');
            if ($t === 'output') { $outId = (string) $id; break; }
        }
        return "LAYERS = {$layers}\n"
             . "PARENTS = {$parents}\n"
             . 'OUTPUT_NODE_ID = ' . PythonEmitHelpers::pyStr($outId) . "\n\n\n"
             . <<<'PY'
        @workflow
        async def main(user_prompt: str = DEFAULT_PROMPT) -> str:
            node_outputs = {}
            # Layer 0 is the start node; its prompt seeds the children via _build_input.
            for layer in LAYERS[1:]:
                ids = [n for n in layer if n in AGENTS or n == OUTPUT_NODE_ID]
                if not ids:
                    continue
                inputs = [_build_input(PARENTS.get(n, []), node_outputs, user_prompt) for n in ids]
                results = await asyncio.gather(*[_run_node(n, inp) for n, inp in zip(ids, inputs)])
                for n, r in zip(ids, results):
                    node_outputs[n] = r
                    print(f"[node] {n}: {len(str(r))} chars", flush=True)
            return node_outputs.get(OUTPUT_NODE_ID, "")
        PY;
    }

    /** __main__ entry: read prompt from CLI args or DEFAULT_PROMPT, run, optionally save. */
    private static function entryBlock(): string
    {
        return <<<'PY'
        if __name__ == "__main__":
            _prompt = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else DEFAULT_PROMPT
            _result = asyncio.run(main.run(_prompt))
            _text = _result.text or ""
            print("\n=== FINAL OUTPUT ===\n" + _text)
            if OUTPUT_STORAGE_ENABLED:
                _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
                _dir = OUTPUT_FOLDER or os.path.join(_root, "workflow")
                os.makedirs(_dir, exist_ok=True)
                _low = _text.lstrip().lower()
                _ext = "html" if _low.startswith("<!doctype html") or _low.startswith("<html") else "md"
                _slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]
                _ts = time.strftime("%Y%m%d-%H%M%S")
                _path = os.path.join(_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")
                with open(_path, "w", encoding="utf-8") as _fh:
                    _fh.write(_text)
                print(f"[output] saved to {_path}")
        PY;
    }
}
