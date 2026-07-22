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

        // Platform default model per provider (system_llm_settings) — an empty
        // node/agent model means "use the platform default" and must be resolved
        // at generation time (mirrors MAFGenerator; _make_model raises otherwise).
        $defaults = [];
        try {
            $rows = $this->db->query("SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1");
            foreach ($rows as $row) {
                if (!empty($row['model'])) {
                    $defaults[strtolower((string) $row['provider_key'])] = (string) $row['model'];
                }
            }
        } catch (\Throwable $e) {
            error_log('[ADKGenerator] could not load provider default models: ' . $e->getMessage());
        }
        $analyzed['providerDefaultModels'] = $defaults;

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
        // Force shortest round-tripping floats: the web SAPI's serialize_precision=100 makes
        // json_encode emit temperatures like 0.5999999999999999… which strict models reject
        // ("only 0.6 is allowed"). See MAFGenerator::emitMaf for the full note.
        ini_set('serialize_precision', '-1');
        $lines = [];
        $lines[] = self::headerBlock($analyzed);

        $lines[] = '# --- Model factory: map a node provider+model to an ADK model ---';
        $lines[] = self::modelFactoryBlock();

        $lines[] = '# --- MCP: baked server list + tool catalog, an HTTP JSON-RPC client, and';
        $lines[] = '#     one FunctionTool per tool so the agents can call them ---';
        $lines[] = 'MCP_SERVERS = ' . PythonEmitHelpers::jsonToPython($analyzed['usedServers'], true);
        $lines[] = 'TOOL_CATALOG = ' . PythonEmitHelpers::jsonToPython($analyzed['usedCatalog'], true);
        $lines[] = PythonEmitHelpers::mcpClientBlock();
        $lines[] = '# --- Document converter: turn an attached file into markdown for the prompt ---';
        $lines[] = PythonEmitHelpers::documentConverterBlock();
        $lines[] = self::adkToolBuilderBlock($analyzed);

        // Emit skill runner only when the workflow actually uses skills.
        // Gated on the analyzer's 'skills' list (set by WorkflowGraphAnalyzer::skillsFromConfig)
        // rather than the legacy skill_content/systemPrompt text check, so the helpers are
        // emitted iff at least one agent has a non-empty skills list.
        $needsSkills = false;
        foreach ($analyzed['agents'] as $agent) {
            if (!empty($agent['skills'])) { $needsSkills = true; break; }
        }
        if ($needsSkills) {
            $lines[] = '# --- Skills: run a skill folder Python script as a subprocess in this env ---';
            $lines[] = PythonEmitHelpers::skillDepsBlock();
            $lines[] = self::skillRunnerBlock();
        }

        // catalog must be defined after build_tools_from_catalog() (from adkToolBuilderBlock).
        $lines[] = '# --- The tool objects agents reference by name as catalog["<tool>"] ---';
        $lines[] = 'catalog = build_tools_from_catalog()';
        // START_DOCUMENTS baked from the analyzed workflow; always present (empty list when none).
        $lines[] = 'START_DOCUMENTS = ' . PythonEmitHelpers::jsonToPython($analyzed['startDocuments']);
        $lines[] = '# --- Agents: one LlmAgent per workflow node. Each writes its result to';
        $lines[] = '#     session.state["node_<id>"]; a child reads a parent via {node_<id>} ---';
        $lines[] = self::agentsBlock($analyzed);

        $consolidators = self::outputConsolidatorsBlock($analyzed);
        if ($consolidators !== '') {
            $lines[] = '# --- Output (fan-in) nodes: forward parent result(s) verbatim, no LLM (preserves HTML) ---';
            $lines[] = self::passThroughAgentBlock();
            $lines[] = $consolidators;
        }
        $lines[] = '# --- Orchestration: each topological layer runs as a ParallelAgent (independent';
        $lines[] = '#     nodes concurrent), and the layers run in order inside a SequentialAgent ---';
        $lines[] = self::rootBlock($analyzed);
        $lines[] = '# --- Entry point: seed prompt (+documents), run, stream trace, save to outputs/ ---';
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

Auto-generated from the visual workflow editor. Backend-independent and
self-contained: it calls the LLM providers, MCP servers, and folder-backed
skills entirely from this one file -- no dependency on the app that produced it.

HOW THIS FILE IS ORGANISED (top to bottom):
  1. _make_model(provider, model)  -- maps a workflow node's provider+model to an
                                      ADK model (Gemini = native string; every other
                                      provider goes through LiteLLM, with Grok/Kimi/
                                      DeepSeek routed to their OpenAI-compatible API).
  2. MCP_SERVERS / TOOL_CATALOG    -- the MCP tools this workflow uses, baked in.
  3. _call_mcp_tool + build_tools_from_catalog()
                                   -- an HTTP JSON-RPC MCP client; each tool is wrapped
                                      as an ADK FunctionTool the model can call.
  4. Skill runner (only when the workflow uses skills)
                                   -- runs a skill folder Python script as a subprocess here.
  5. node_<id> = LlmAgent(...)     -- ONE agent per workflow node. Each agent writes its
                                      answer to session.state["node_<id>"]; a downstream
                                      agent reads a parent's output through the literal
                                      {node_<id>} placeholder in its instruction (that is
                                      ADK "state templating" -- the runtime substitutes it).
  6. root_agent = SequentialAgent([...])
                                   -- the workflow graph expressed as TOPOLOGICAL LAYERS:
                                      independent nodes at the same depth run together in a
                                      ParallelAgent; the layers themselves run in order.
  7. main()                        -- seeds the prompt (plus any attached documents), runs
                                      the graph via Runner, streams a [node]/[tool] trace to
                                      stdout, saves the final result under outputs/, and
                                      closes with a RUN SUMMARY (time per node, total
                                      wall-clock, document location).

NODE-INTERNAL PIPELINE (fixed order):
    merged fan-in (parents' outputs via {node_<id>} state placeholders)
      ==> AGENT: the node's LlmAgent — its system prompt, MCP tools and
          sampling settings come verbatim from the editor form (provider
          CONSTRAINT clamps only, each documented as an emitted comment:
          kimi-k2 temperature 0.6; anthropic 16384 non-streaming ceiling).
          Instructions are grounded in today's date at import time.
      ==> SKILL step(s), each a SequentialAgent pair: an LLM turn whose
          system prompt is the skill's SKILL.md (fresh context; the node's
          budget so document-carrying tool calls don't truncate), then a
          capture agent that makes the node output the file the skill's
          script PRODUCED (else the LLM text). Staged input_files are
          repaired if a model delivers them JSON-over-escaped.
    The Output node is a non-LLM pass-through: parents' text verbatim.

TO RUN:
    pip install "google-adk>=2.3,<3" litellm httpx   # 2.3.x: SequentialAgent/ParallelAgent still supported
    # provide the API keys for the providers used, via the environment / a .env, e.g.:
    #   ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, XAI_API_KEY, KIMI_API_KEY, DEEPSEEK_API_KEY
    python this_file.py "your prompt here"
"""
import asyncio, json, os, subprocess, sys, threading, time, traceback, urllib.request
import httpx
from typing import Any

from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent, BaseAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import FunctionTool
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.events import Event, EventActions
from google.genai import types

# Runtime "today" for date-grounding every agent instruction (evaluated at import).
_TODAY = time.strftime("%Y-%m-%d")
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
        kwargs = dict(
            model="openai/" + model,
            api_base="https://api.deepseek.com",
            api_key=os.environ.get("DEEPSEEK_API_KEY"),
        )
        if model.startswith("deepseek-v4"):
            # V4 runs thinking-ON by default SERVER-side and rejects sampling
            # params in that mode; disable explicitly (mirrors the platform's
            # DeepSeekProvider fix) so the form's temperature is accepted.
            kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
        return LiteLlm(**kwargs)
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
    if p == "glm":
        # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible. Defaults to heavy reasoning; disable
        # thinking so it answers directly instead of burning the token budget on reasoning.
        return LiteLlm(
            model="openai/" + model,
            api_base="https://api.z.ai/api/paas/v4",
            api_key=os.environ.get("GLM_API_KEY"),
            extra_body={"thinking": {"type": "disabled"}},
        )
    # Fallback: best-effort litellm prefixed spec.
    return LiteLlm(model=model if "/" in model else p + "/" + model)
PY;
    }

    /** Test seam: exposes skillRunnerBlock() output for unit testing. */
    public static function skillRunnerBlockForTest(): string { return self::skillRunnerBlock(); }

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
        $py = <<<'PY'
# Skills use the same virtual dirs the browser interpreter provides: "/outputs"
# (persisted, mounted to the host outputs folder, bucketed per skill group) and
# "/scratch" (staging for input files). Standalone Python has neither, so we (a) create
# REAL outputs/scratch dirs, (b) remap "/outputs/..." and "/scratch/..." paths in argv
# onto them, (c) stage input_files at those real paths before the run, and (d) export
# SYNERGYAI_OUTPUT_DIR/SCRATCH_DIR/SKILL_DIR_NAME/SKILL_GROUP for scripts that read the
# env. Without this a skill that hardcodes e.g. "-i /scratch/x -o /outputs/y" (like the
# html skill's create.py) fails against the read-only filesystem root.
SKILL_OUTPUTS_ROOT = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(SKILLS_DIR), "outputs")
SKILL_SCRATCH_DIR = os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(os.path.dirname(SKILLS_DIR), "scratch")

# Deliverable files a skill produced this step (via run_skill_script read_outputs),
# keyed by skill dir_name. The skill's capture step reads this so the NODE OUTPUT is
# the produced document (e.g. the html skill's rendered HTML), not the model's chatter.
_LAST_SKILL_OUTPUTS = {}


def _skill_output_dir(dir_name: str) -> str:
    group = dir_name.split("/")[0] if "/" in dir_name else ""
    if group and all(c.isalnum() or c in "._-" for c in group):
        return os.path.join(SKILL_OUTPUTS_ROOT, group)
    return SKILL_OUTPUTS_ROOT


def _remap_virtual_path(p, out_dir: str) -> str:
    """Map the interpreter's virtual "/outputs" and "/scratch" onto real host dirs so a
    skill's hardcoded absolute paths resolve in standalone Python."""
    p = str(p)
    for virt, real in (("/outputs", out_dir), ("/scratch", SKILL_SCRATCH_DIR)):
        if p == virt:
            return real
        if p.startswith(virt + "/"):
            return os.path.join(real, p[len(virt) + 1:])
    return p


def _fix_overescaped(text):
    """Repair JSON-style over-escaping in model-carried document content
    (literal \\n / \\" sequences, zero real newlines — a known model behavior
    that ships broken HTML/CSS; mirrors the platform chat's recovery).
    Conservative: only fires on many escapes AND no real newlines."""
    s = str(text)
    if s.count("\\n") > 5 and s.count("\n") == 0:
        print("  [skill] repairing over-escaped staged content", flush=True)
        s = (s.replace("\\\\", "\x00").replace("\\n", "\n").replace("\\t", "\t")
              .replace("\\r", "").replace('\\"', '"').replace("\\'", "'").replace("\x00", "\\"))
    return s


async def _run_skill_script(dir_name: str, script: str, argv: list[str] | None = None,
                            input_files: dict | None = None,
                            read_outputs: list[str] | None = None) -> str:
    """Run a skill's Python script as a subprocess, mirroring the interpreter's skill
    filesystem: real bucketed /outputs + /scratch, input_files staged first, requested
    outputs read back after."""
    argv = list(argv) if argv else []
    skill_path = os.path.join(SKILLS_DIR, dir_name)
    _ensure_skill_deps(skill_path)  # parse SKILL.md frontmatter, pip install once
    script_path = os.path.join(skill_path, script)
    out_dir = _skill_output_dir(dir_name)
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(SKILL_SCRATCH_DIR, exist_ok=True)
    argv = [_remap_virtual_path(a, out_dir) for a in argv]
    if isinstance(input_files, dict):
        for raw_path, content in input_files.items():
            try:
                target = _remap_virtual_path(raw_path, out_dir)
                os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                with open(target, "w", encoding="utf-8") as fh:
                    fh.write(_fix_overescaped(content))
            except Exception as e:
                print(f"[skill] could not stage {raw_path}: {e}", flush=True)
    group = dir_name.split("/")[0] if "/" in dir_name else ""
    env = dict(
        os.environ,
        SYNERGYAI_OUTPUT_DIR=out_dir,
        SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR,
        SYNERGYAI_SKILL_DIR_NAME=dir_name,
        SYNERGYAI_SKILL_GROUP=group,
    )
    proc = await asyncio.create_subprocess_exec(
        sys.executable, script_path, *[str(a) for a in argv],
        cwd=skill_path, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    result = out.decode("utf-8", "replace")
    if proc.returncode != 0:
        return (f"[skill error rc={proc.returncode}] "
                + err.decode("utf-8", "replace") + "\n" + result).strip()
    # Surface requested output files back to the model (interpreter parity) AND stash
    # them so the skill's capture step can use the produced document as the node output.
    _produced = []
    if isinstance(read_outputs, list):
        for rel in read_outputs:
            try:
                with open(_remap_virtual_path(rel, out_dir), "r", encoding="utf-8") as fh:
                    _content = fh.read()
                result += f"\n\n[output file {rel}]\n" + _content
                _produced.append(_content)
            except Exception:
                pass
    if _produced:
        _LAST_SKILL_OUTPUTS[dir_name] = _produced
    return result

RUN_SKILL_SCRIPT_TOOL = FunctionTool(_run_skill_script)
PY;
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
        end = text.find("\n---\n", 3)
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
        return (
            "Current date: " + _TODAY + ".\n"
            "You are running the '" + dir_name + "' skill as a MANDATORY step in a compiled "
            "workflow. Follow the skill instructions below and APPLY THE SKILL to the INPUT. "
            "If the skill produces a document/file (e.g. an HTML report via a create/render "
            "script), you MUST call run_skill_script to generate it -- stage your authored "
            "content via input_files and pass the output path in read_outputs; the workflow "
            "captures that produced file as this node's output. If the skill has no script, "
            "return the transformed result as your response.\n\n"
            "=== SKILL INSTRUCTIONS ===\n" + body +
            "\n\n=== INPUT (apply the skill to this) ===\n" + str(prior)
        )
    return _instr


def _make_skill_tool(dir_name: str) -> FunctionTool:
    """run_skill_script scoped to one skill dir: the model chooses the script within the
    skill, its argv, and optionally input_files (staged before the run, e.g. the HTML a
    skill will render) and read_outputs (surfaced after); the dir is fixed to this skill."""
    async def run_skill_script(script: str, argv: list[str] | None = None,
                               input_files: dict | None = None,
                               read_outputs: list[str] | None = None) -> str:
        return await _run_skill_script(dir_name, script, argv, input_files, read_outputs)
    return FunctionTool(run_skill_script)


class _SkillCaptureAgent(BaseAgent):
    """Resolves a skill step's output: the NODE OUTPUT becomes the document the skill just
    produced (captured via run_skill_script read_outputs -- e.g. the html skill's rendered
    HTML) when it wrote one; otherwise the skill LLM's text. This is what makes a
    file-producing skill (html/docx/pptx/xlsx) yield the actual deliverable as the node
    result instead of the model's chatter. Follows the skill LLM in the SequentialAgent."""
    skill_dir: str = ""
    llm_key: str = ""
    out_key: str = ""

    async def _run_async_impl(self, ctx):
        produced = _LAST_SKILL_OUTPUTS.pop(self.skill_dir, None)
        final = produced[-1] if produced else str(ctx.session.state.get(self.llm_key, ""))
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=final)]),
            actions=EventActions(state_delta={self.out_key: final}),
            turn_complete=True,
        )
PY;
        return $py;
    }

    /**
     * Emit one `LlmAgent` per agent node in $analyzed['agents'].
     *
     * Instruction assembly:
     *  1. systemPrompt (skill_content is NO LONGER appended here — skills are
     *     now separate SequentialAgent steps, not prompt text)
     *  2. For each parent that is itself an agent: append "\n\n## Input from node {p}\n{node_{p}}"
     *     The `{node_<p>}` is an ADK state placeholder and must survive into the emitted Python
     *     as a literal brace expression — PythonEmitHelpers::pyStr() produces a non-f-string, so
     *     braces are safe.
     *
     * Tools: map each tool name to catalog["<name>"]. The main agent NEVER receives
     * RUN_SKILL_SCRIPT_TOOL — skills are mandatory post-agent SequentialAgent steps.
     *
     * For nodes with a non-empty `skills` list:
     *  - The main agent variable is renamed to `node_<id>_agent` with output_key="node_<id>_agent".
     *  - One `node_<id>_skill_<k>` LlmAgent is emitted per skill (using the node's provider/model).
     *    The last skill step writes output_key="node_<id>"; intermediate steps write their own key.
     *  - A `node_<id> = SequentialAgent(name="node_<id>", sub_agents=[...])` wrapper is emitted so
     *    rootBlock() can reference `node_<id>` as before.
     *
     * generate_content_config is emitted only when temperature or max_tokens is non-null.
     * Skill steps deliberately omit generate_content_config (default sampling).
     *
     * All nodes emitted at column 0.
     */
    private static function agentsBlock(array $analyzed): string
    {
        $out = [];
        foreach ($analyzed['agents'] as $id => $ag) {
            $instr = $ag['systemPrompt'];
            // NOTE: ## Skill / skill_content is NOT appended — skills are now
            // separate SequentialAgent steps, not prompt text.

            // Only inject from parents that are themselves agent nodes.
            $agentParents = array_values(array_filter(
                $analyzed['parents'][$id] ?? [],
                fn($p) => isset($analyzed['agents'][$p])
            ));
            foreach ($agentParents as $p) {
                // PHP: {node_{$p}} → literal "{node_2}" (PHP only interpolates {$...}, not {word_{$...}}).
                $instr .= "\n\n## Input from node {$p}\n{node_{$p}}";
            }

            $skills = $ag['skills'] ?? [];
            $hasSkills = count($skills) > 0;

            // Empty model = "platform default": resolve at generation time
            // (aliases share their canonical provider's default). Mirrors MAF.
            $defaults = (array) ($analyzed['providerDefaultModels'] ?? []);
            $provKey  = strtolower((string) ($ag['provider'] ?? 'claude'));
            $canon    = ['anthropic' => 'claude', 'google' => 'gemini'][$provKey] ?? $provKey;
            $modelStr = (string) ($ag['model'] ?? '');
            if ($modelStr === '') {
                $modelStr = (string) ($defaults[$canon] ?? $defaults[$provKey] ?? '');
            }
            $ag['model'] = $modelStr;

            // Provider CONSTRAINT clamps (not preference overrides — these values
            // are hard API rules; the emitted comment documents each adjustment):
            //  * kimi-k2.* accepts ONLY temperature 0.6 with thinking off.
            //  * anthropic non-streaming SDK refuses budgets implying >10min
            //    responses; 16384 is the safe ceiling (see MAFGenerator).
            $clampNotes = [];
            if ($provKey === 'kimi' && str_starts_with($modelStr, 'kimi-k2')
                && $ag['temperature'] !== null && (float) $ag['temperature'] !== 0.6) {
                $clampNotes[] = "temperature {$ag['temperature']} -> 0.6 (kimi-k2 API constraint)";
                $ag['temperature'] = 0.6;
            }
            if (in_array($provKey, ['claude', 'anthropic'], true)
                && $ag['max_tokens'] !== null && (int) $ag['max_tokens'] > 16384) {
                $clampNotes[] = "max_tokens {$ag['max_tokens']} -> 16384 (anthropic non-streaming SDK limit)";
                $ag['max_tokens'] = 16384;
            }

            // The main agent NEVER carries the skill tool. (Drop the old
            // run_skill_script auto-add entirely — skills are separate steps now.)
            $toolExprs = [];
            foreach ($ag['tools'] as $t) {
                // Node forms store the runtime 'mcp_' prefix; the catalog is keyed
                // on the UNPREFIXED DB tool_name (the analyzer's normalization).
                // Without stripping, catalog["mcp_…"] raises KeyError at import.
                $t = (string) $t;
                if (strpos($t, 'mcp_') === 0) $t = substr($t, 4);
                $toolExprs[] = 'catalog["' . $t . '"]';
            }
            $toolsPy = '[' . implode(', ', $toolExprs) . ']';

            $model = '_make_model("' . $ag['provider'] . '", "' . $ag['model'] . '")';
            $agentVar    = $hasSkills ? "node_{$id}_agent" : "node_{$id}";
            $agentOutKey = $hasSkills ? "node_{$id}_agent" : "node_{$id}";

            $agentComment = str_replace(["\r", "\n"], ' ', (string) $ag['name']);
            $entry  = "# Agent \"{$agentComment}\" ({$ag['provider']}/{$ag['model']}) -- workflow node {$id}\n";
            foreach ($clampNotes as $cn) {
                $entry .= "# constraint clamp: {$cn}\n";
            }
            $entry .= "{$agentVar} = LlmAgent(\n";
            $entry .= "    name=\"{$agentVar}\",\n";
            $entry .= "    model={$model},\n";
            // Ground the model in TODAY (runtime date, evaluated at import) — without
            // it research agents anchor on their training era (see MAF fix).
            $entry .= "    instruction=(\"Current date: \" + _TODAY + \". Treat this as 'now'; \"\n"
                    . "                 \"prefer your tools for current data over memory.\\n\\n\"\n"
                    . "                 + " . PythonEmitHelpers::pyStr($instr) . "),\n";
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
            $entry .= "    output_key=\"{$agentOutKey}\",\n";
            $entry .= ")";

            if ($hasSkills) {
                $prev      = "node_{$id}_agent";
                $subAgents = ["node_{$id}_agent"];
                foreach ($skills as $k => $skill) {
                    $stepNo  = $k + 1;
                    $isLast  = ($stepNo === count($skills));
                    $llmVar  = "node_{$id}_skill_{$stepNo}_llm";       // the skill's LLM turn
                    $capVar  = "node_{$id}_skill_{$stepNo}";           // capture = the step's output
                    $stepOut = $isLast ? "node_{$id}" : $capVar;       // last capture writes the node key
                    if (isset($skill['dir'])) {
                        $dir        = addslashes($skill['dir']);
                        $dirLiteral = "\"{$dir}\"";
                        $instrExpr  = "_skill_instruction(\"{$dir}\", \"{$prev}\")";
                        $toolPy     = "[_make_skill_tool(\"{$dir}\")]";
                    } else {
                        $dirLiteral = "\"\""; // inline skill: no dir to look up in the deliverable stash
                        $inlineMd   = PythonEmitHelpers::pyStr((string) $skill['inline']);
                        $instrExpr  = "_skill_instruction(\"\", \"{$prev}\", inline_md={$inlineMd})";
                        $toolPy     = "[]"; // legacy inline skill: no script folder
                    }
                    // (a) the skill's LLM turn: applies the skill to the prior result, runs its script if any.
                    $entry .= "\n\n# Skill step {$stepNo} for node {$id}: LLM applies the skill; capture makes the node output the produced deliverable (else the LLM text).\n";
                    $entry .= "{$llmVar} = LlmAgent(\n";
                    $entry .= "    name=\"{$llmVar}\",\n";
                    $entry .= "    model={$model},\n";
                    $entry .= "    instruction={$instrExpr},\n";
                    $entry .= "    tools={$toolPy},\n";
                    // Documents flow through this step's OUTPUT (authored text and
                    // tool-call arguments both count) — inherit the node's budget so
                    // provider-default caps don't truncate document-carrying calls.
                    if ($ag['temperature'] !== null || $ag['max_tokens'] !== null) {
                        $skwargs = [];
                        if ($ag['temperature'] !== null) $skwargs[] = "temperature=" . json_encode($ag['temperature']);
                        if ($ag['max_tokens'] !== null)  $skwargs[] = "max_output_tokens=" . json_encode($ag['max_tokens']);
                        $entry .= "    generate_content_config=types.GenerateContentConfig(" . implode(", ", $skwargs) . "),\n";
                    }
                    $entry .= "    output_key=\"{$llmVar}\",\n";
                    $entry .= ")";
                    // (b) capture: node output = the produced file (via run_skill_script read_outputs), else the LLM text.
                    $entry .= "\n{$capVar} = _SkillCaptureAgent(name=\"{$capVar}\", skill_dir={$dirLiteral}, llm_key=\"{$llmVar}\", out_key=\"{$stepOut}\")";
                    $subAgents[] = $llmVar;
                    $subAgents[] = $capVar;
                    $prev        = $capVar;   // next skill reads the capture's output
                }
                $subList = implode(', ', $subAgents);
                $entry .= "\n\n# Node {$id}: agent then mandatory skill pipeline (LLM turn + capture per skill); this is what the layering references.\n";
                $entry .= "node_{$id} = SequentialAgent(\n    name=\"node_{$id}\",\n    sub_agents=[{$subList}],\n)";
            }

            $out[] = $entry;
        }
        return implode("\n\n", $out);
    }

    /**
     * The _PassThroughAgent class definition — a non-LLM fan-in used by output
     * nodes. Emitted once, before the output nodes that instantiate it. Verified
     * against google-adk 2.3.0: a custom BaseAgent yielding a content Event with
     * turn_complete=True is captured by main()'s is_final_response() loop.
     */
    private static function passThroughAgentBlock(): string
    {
        return <<<'PY'
class _PassThroughAgent(BaseAgent):
    """Output (fan-in) node: emit the parent(s) result VERBATIM -- no LLM -- so
    formatting such as HTML is preserved. A single parent is passed through
    unchanged; multiple parents are joined with a separator. (An LlmAgent here
    would re-summarise the parent and lose its original formatting, e.g. turning
    a finished HTML report back into plain markdown.)
    """
    source_keys: list = []

    async def _run_async_impl(self, ctx):
        vals = [str(ctx.session.state.get(k, "")) for k in self.source_keys]
        vals = [v for v in vals if v]
        text = vals[0] if len(vals) == 1 else "\n\n---\n\n".join(vals)
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            actions=EventActions(state_delta={self.name: text}),
            turn_complete=True,
        )
PY;
    }

    /**
     * Emit each `output` node as a non-LLM _PassThroughAgent that forwards its
     * parent(s) output from session.state verbatim (single parent = pass-through,
     * multiple = joined), preserving formatting like HTML. Returns '' when the
     * workflow has no output nodes.
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
            $keys = [];
            foreach ($parents as $p) {
                $keys[] = '"node_' . $p . '"';
            }
            $keysPy = '[' . implode(', ', $keys) . ']';

            $entry  = "# Output (fan-in) node {$id} -- forwards its parent(s) result verbatim (no LLM),\n";
            $entry .= "# so formatting such as HTML is preserved. Single parent = pass-through.\n";
            $entry .= "node_{$id} = _PassThroughAgent(name=\"node_{$id}\", source_keys={$keysPy})";
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
        $wfId = (int) ($analyzed['workflow']['id'] ?? 0);
        $storageEnabled = !empty($analyzed['outputStorageEnabled']) ? 'True' : 'False';
        $folder = $analyzed['outputFolder'] ?? null;
        $folderPy = ($folder !== null && $folder !== '') ? PythonEmitHelpers::pyStr((string) $folder) : 'None';
        $nodeNames = [];
        foreach (($analyzed['agents'] ?? []) as $nid => $ag) {
            $nodeNames[(string) $nid] = (string) ($ag['name'] ?? ('node ' . $nid));
        }
        $nodeNamesPy = PythonEmitHelpers::jsonToPython($nodeNames);
        return
            "WORKFLOW_NAME = {$name}\n" .
            "WORKFLOW_ID = {$wfId}\n" .
            "OUTPUT_STORAGE_ENABLED = {$storageEnabled}\n" .
            "OUTPUT_FOLDER = {$folderPy}\n" .
            "NODE_NAMES = {$nodeNamesPy}  # node id -> human name (for readable logs)\n" .
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
            "    _t_first, _t_last = {}, {}  # per-node timing for the RUN SUMMARY\n" .
            "    content = types.Content(role=\"user\", parts=[types.Part(text=user_prompt)])\n" .
            "    try:\n" .
            "        async for event in runner.run_async(user_id=\"local\", session_id=session.id, new_message=content):\n" .
            "            author = getattr(event, \"author\", \"?\")\n" .
            "            if isinstance(author, str) and author.startswith(\"node_\"):\n" .
            "                _nk = author.split(\"_\")[1] if \"_\" in author else author\n" .
            "                _t_first.setdefault(_nk, time.monotonic())\n" .
            "                _t_last[_nk] = time.monotonic()\n" .
            "            if author and author not in seen:\n" .
            "                seen.add(author)\n" .
            "                if isinstance(author, str) and author.startswith(\"node_\"):\n" .
            "                    _ap = author.split(\"_\")\n" .
            "                    _nid = _ap[1] if len(_ap) > 1 else author\n" .
            "                    _kind = \"skill step\" if \"skill\" in author else \"agent\"\n" .
            "                    print(f\"[node {_nid}] {NODE_NAMES.get(_nid, _nid)!r} \\u2192 {_kind} active\", flush=True)\n" .
            "                else:\n" .
            "                    print(f\"[node] > {author}\", flush=True)\n" .
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
            "    import re as _re\n" .
            "    _mm = _re.search(r\"(?is)<!doctype html.*?</html\\s*>\", final) or _re.search(r\"(?is)<html[\\s>].*?</html\\s*>\", final)\n" .
            "    if _mm:\n" .
            "        final = _mm.group(0)  # strip narration/fences around a full HTML doc\n" .
            "        _ext = \"html\"\n" .
            "    else:\n" .
            "        _ext = \"md\"\n" .
            "    _slug = \"\".join(c if c.isalnum() else \"_\" for c in WORKFLOW_NAME).strip(\"_\")[:60] or \"workflow\"\n" .
            "    _ts = time.strftime(\"%Y%m%d-%H%M%S\")\n" .
            "    # Honour the Output node's storage setting: when ON, persist the final result\n" .
            "    # where the app stores it (~/Documents/synergyAI/outputs/workflow/ by default,\n" .
            "    # overridable via SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, skip.\n" .
            "    _saved_path = None\n" .
            "    if OUTPUT_STORAGE_ENABLED:\n" .
            "        _root = os.environ.get(\"SYNERGYAI_OUTPUT_ROOT\") or os.path.expanduser(\"~/Documents/synergyAI/outputs\")\n" .
            "        if OUTPUT_FOLDER:\n" .
            "            _cf = os.path.expanduser(OUTPUT_FOLDER)\n" .
            "            _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)\n" .
            "        else:\n" .
            "            _save_dir = os.path.join(_root, \"workflow\")\n" .
            "        os.makedirs(_save_dir, exist_ok=True)\n" .
            "        _out = os.path.join(_save_dir, f\"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}\")\n" .
            "        with open(_out, \"w\", encoding=\"utf-8\") as _f:\n" .
            "            _f.write(final)\n" .
            "        _saved_path = os.path.abspath(_out)\n" .
            "    print(final)\n" .
            "    # Closing RUN SUMMARY (printed LAST): time per node, total, document location.\n" .
            "    print(\"\\n\" + \"=\" * 74, flush=True)\n" .
            "    print(\"RUN SUMMARY\", flush=True)\n" .
            "    print(\"-\" * 74, flush=True)\n" .
            "    _durs = {NODE_NAMES.get(k, k): _t_last[k] - _t_first[k] for k in _t_first if k in _t_last}\n" .
            "    if _durs:\n" .
            "        _w = max(len(n) for n in _durs)\n" .
            "        print(\"  Time per node:\", flush=True)\n" .
            "        for _n, _s in sorted(_durs.items(), key=lambda kv: -kv[1]):\n" .
            "            print(f\"    {_n:<{_w}}   {_s:7.1f}s\", flush=True)\n" .
            "    print(f\"  Total wall-clock: {time.monotonic() - t0:.1f}s\", flush=True)\n" .
            "    print(f\"  Final output: {len(final)} chars\", flush=True)\n" .
            "    if _saved_path:\n" .
            "        print(f\"  Document saved to: {_saved_path}\", flush=True)\n" .
            "    else:\n" .
            "        print(\"  Document not saved (output storage is OFF in the workflow settings) -- \"\n" .
            "              \"the output is printed above.\", flush=True)\n" .
            "    print(\"=\" * 74, flush=True)\n" .
            "    return final\n" .
            "\n" .
            "if __name__ == \"__main__\":\n" .
            "    # Join ALL argv (a prompt is one string even with spaces) -- the runner\n" .
            "    # passes it space-split; sys.argv[1] alone would keep only the first word.\n" .
            "    asyncio.run(main(\" \".join(sys.argv[1:]) if len(sys.argv) > 1 else {$sp}))";
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
