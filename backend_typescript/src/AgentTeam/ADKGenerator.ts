import { WorkflowRepository, WorkflowGraphRepository } from './WorkflowRepository';
import { AgentRepository } from './AgentRepository';
import { WorkflowGraphAnalyzer, AnalyzeResult, AnalyzedAgent } from './WorkflowGraphAnalyzer';
import {
  jsonToPython,
  pyStr,
  mcpClientBlock,
  skillDepsBlock,
  documentConverterBlock,
} from './pythonEmitHelpers';

/**
 * ADKGenerator
 *
 * Faithful TypeScript mirror of src/AgentTeam/Services/ADKGenerator.php.
 *
 * Generates a standalone Python Google ADK script from a saved workflow. The
 * generated file is fully independent of the PHP/TS backend -- it runs directly
 * against the Google ADK runtime using LiteLLM for multi-provider model support.
 *
 * `emitAdk()` is a pure function (no DB/I/O) so it can be tested without a database.
 * `generate()` does the DB lookup via WorkflowGraphAnalyzer and then delegates to
 * `emitAdk()`.
 *
 * Byte-fidelity notes:
 *  - Shared blocks (MCP client, document converter, skill-deps install) come from
 *    pythonEmitHelpers.ts (byte-verified vs PHP's PythonEmitHelpers.php) -- exactly
 *    the modules ADKGenerator.php itself reuses via PythonEmitHelpers::*.
 *  - Graph topology + agent/tool resolution comes from the shared, byte-verified
 *    WorkflowGraphAnalyzer.analyze() rather than any local re-implementation.
 *  - PHP's `$analyzed['agents']` / `$analyzed['byId']` are associative arrays that
 *    PRESERVE INSERTION ORDER regardless of whether keys look numeric. Their TS
 *    mirrors (`analyzed.agents`, `analyzed.byId`) are plain JS objects, which DO
 *    reorder purely-numeric string keys ascending on enumeration -- a real
 *    footgun for a topologically-ordered-but-not-ascending graph (e.g. a fan-out/
 *    fan-in workflow). Every loop below that PHP drives via `foreach ($analyzed[...])`
 *    is therefore rewritten here to iterate `analyzed.order` (a real array, whose
 *    sequence IS authoritative) and look up `analyzed.agents[id]` / `analyzed.byId[id]`
 *    inside the loop, per the porting brief.
 *  - ADKGenerator.php does not do any of the byte-domain wordwrap/safeVar gymnastics
 *    LangGraphGenerator.php needs for its docstring header -- its header is a plain
 *    heredoc with one `{$name}` interpolation, and its main() prompt default uses
 *    pyStr() directly (no wrapping). So this port works entirely in the JS string
 *    (UTF-16) domain; no Buffer/byte-domain machinery is needed, and `code` is a
 *    plain string (not a Buffer, unlike LangGraphGenerator's GenerateResult).
 */

export interface ADKGenerateResult {
  filename: string;
  code: string;
}

// ---------------------------------------------------------------------------
// PHP helpers ported for this file
// ---------------------------------------------------------------------------

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** PHP addslashes(): escapes \, ', ", and NUL -- backslash first so the newly-added
 * escaping backslashes are never themselves re-escaped by a later step. */
function phpAddslashes(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\u0000/g, '\\0');
}

/**
 * PHP: `preg_replace('/[^a-z0-9_]+/i', '_', $name)` -- byte-domain, case-insensitive
 * (matches [A-Za-z0-9_]), collapsing each RUN of non-matching bytes into a single '_'.
 * Used only for the generated filename (ADKGenerator::generate()).
 */
function collapseNonIdentBytes(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  const isSafe = (b: number) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 0x5f;
  const out: number[] = [];
  let inRun = false;
  for (const b of bytes) {
    if (isSafe(b)) {
      out.push(b);
      inRun = false;
    } else if (!inRun) {
      out.push(0x5f);
      inRun = true;
    }
  }
  return Buffer.from(out).toString('latin1');
}

/** PHP strtolower(): ASCII A-Z only, byte-wise (high bytes untouched). */
function phpStrtolowerAscii(s: string): string {
  const buf = Buffer.from(s, 'latin1');
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 65 && buf[i] <= 90) buf[i] += 32;
  }
  return buf.toString('latin1');
}

/**
 * PHP: `preg_replace('/[^A-Za-z0-9_]/', '_', $toolName)` -- byte-domain, EACH
 * non-matching byte replaced individually (no `+` quantifier, so runs are NOT
 * collapsed -- a multi-byte UTF-8 character becomes one '_' per byte, exactly
 * mirroring the PHP regex behaviour including its warts).
 */
function sanitizeToolFnNameBytes(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const ok = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 0x5f;
    out[i] = ok ? b : 0x5f;
  }
  return out.toString('latin1');
}

const PY_KEYWORDS = new Set<string>([
  'False', 'None', 'True',
  'and', 'as', 'assert',
  'async', 'await', 'break',
  'class', 'continue', 'def',
  'del', 'elif', 'else',
  'except', 'finally', 'for',
  'from', 'global', 'if',
  'import', 'in', 'is',
  'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise',
  'return', 'try', 'while',
  'with', 'yield',
]);

const JSON_TYPE_MAP: Record<string, string> = {
  string: 'str',
  integer: 'int',
  number: 'float',
  boolean: 'bool',
  array: 'list',
  object: 'dict',
};

export class ADKGenerator {
  constructor(
    private workflowRepo: WorkflowRepository,
    private graphRepo: WorkflowGraphRepository,
    private agentRepo: AgentRepository
  ) {}

  /**
   * Generate a Google ADK Python script for the given workflow.
   */
  async generate(workflowId: number, userId: string | null = null): Promise<ADKGenerateResult> {
    const analyzer = new WorkflowGraphAnalyzer(this.workflowRepo, this.graphRepo, this.agentRepo);
    const analyzed = await analyzer.analyze(workflowId, userId);
    const name = collapseNonIdentBytes(analyzed.workflow.name);
    return {
      filename: phpStrtolowerAscii(name) + '_adk.py',
      code: ADKGenerator.emitAdk(analyzed),
    };
  }

  /**
   * Pure emit entry-point. Takes an AnalyzeResult (from WorkflowGraphAnalyzer.analyze())
   * and returns the full Python source as a string. No DB/I/O.
   */
  static emitAdk(analyzed: AnalyzeResult): string {
    const lines: string[] = [];
    lines.push(ADKGenerator.headerBlock(analyzed));

    lines.push('# --- Model factory: map a node provider+model to an ADK model ---');
    lines.push(ADKGenerator.modelFactoryBlock());

    lines.push('# --- MCP: baked server list + tool catalog, an HTTP JSON-RPC client, and');
    lines.push('#     one FunctionTool per tool so the agents can call them ---');
    lines.push('MCP_SERVERS = ' + jsonToPython(analyzed.usedServers, true));
    lines.push('TOOL_CATALOG = ' + jsonToPython(analyzed.usedCatalog, true));
    lines.push(mcpClientBlock());
    lines.push('# --- Document converter: turn an attached file into markdown for the prompt ---');
    lines.push(documentConverterBlock());
    lines.push(ADKGenerator.adkToolBuilderBlock(analyzed));

    // Emit skill runner only when the workflow actually uses skills.
    let needsSkills = false;
    for (const agent of Object.values(analyzed.agents)) {
      if (agent.skills && agent.skills.length > 0) {
        needsSkills = true;
        break;
      }
    }
    if (needsSkills) {
      lines.push('# --- Skills: run a skill folder Python script as a subprocess in this env ---');
      lines.push(skillDepsBlock());
      lines.push(ADKGenerator.skillRunnerBlock());
    }

    // catalog must be defined after build_tools_from_catalog() (from adkToolBuilderBlock).
    lines.push('# --- The tool objects agents reference by name as catalog["<tool>"] ---');
    lines.push('catalog = build_tools_from_catalog()');
    // START_DOCUMENTS baked from the analyzed workflow; always present (empty list when none).
    lines.push('START_DOCUMENTS = ' + jsonToPython(analyzed.startDocuments));
    lines.push('# --- Agents: one LlmAgent per workflow node. Each writes its result to');
    lines.push('#     session.state["node_<id>"]; a child reads a parent via {node_<id>} ---');
    lines.push(ADKGenerator.agentsBlock(analyzed));

    const consolidators = ADKGenerator.outputConsolidatorsBlock(analyzed);
    if (consolidators !== '') {
      lines.push('# --- Output (fan-in) nodes: forward parent result(s) verbatim, no LLM (preserves HTML) ---');
      lines.push(ADKGenerator.passThroughAgentBlock());
      lines.push(consolidators);
    }
    lines.push('# --- Orchestration: each topological layer runs as a ParallelAgent (independent');
    lines.push('#     nodes concurrent), and the layers run in order inside a SequentialAgent ---');
    lines.push(ADKGenerator.rootBlock(analyzed));
    lines.push('# --- Entry point: seed prompt (+documents), run, stream trace, save to outputs/ ---');
    lines.push(ADKGenerator.mainBlock(analyzed));

    return lines.join('\n') + '\n';
  }

  // -------------------------------------------------------------------------
  // Private emit helpers
  // -------------------------------------------------------------------------

  /** Emit the file header: module docstring + all top-level imports. */
  private static headerBlock(analyzed: AnalyzeResult): string {
    const name = analyzed.workflow.name;
    return `"""Standalone Google ADK workflow: ${name}

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
                                      stdout, and saves the final result under outputs/.

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
from google.genai import types`;
  }

  /** Emit the provider→model factory function. No interpolation needed (nowdoc). */
  private static modelFactoryBlock(): string {
    return `def _make_model(provider: str, model: str):
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
    return LiteLlm(model=model if "/" in model else p + "/" + model)`;
  }

  /** Test seam: exposes skillRunnerBlock() output for unit testing. */
  static skillRunnerBlockForTest(): string {
    return ADKGenerator.skillRunnerBlock();
  }

  /**
   * Emit the ADK-specific async skill runner. Called only when any agent uses
   * skills (see emitAdk()). Depends on pythonEmitHelpers.skillDepsBlock() being
   * emitted first (provides SKILLS_DIR + _ensure_skill_deps).
   *
   * PHP builds this as two concatenated nowdocs ($py .= <<<'PY' ... the second
   * one's body starts with two blank lines) -- reproduced here as one literal
   * with the same blank-line gap, so the emitted bytes match exactly.
   */
  private static skillRunnerBlock(): string {
    return `# Skills use the same virtual dirs the browser interpreter provides: "/outputs"
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
                    fh.write(content if isinstance(content, str) else str(content))
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
                + err.decode("utf-8", "replace") + "\\n" + result).strip()
    # Surface requested output files back to the model (interpreter parity) AND stash
    # them so the skill's capture step can use the produced document as the node output.
    _produced = []
    if isinstance(read_outputs, list):
        for rel in read_outputs:
            try:
                with open(_remap_virtual_path(rel, out_dir), "r", encoding="utf-8") as fh:
                    _content = fh.read()
                result += f"\\n\\n[output file {rel}]\\n" + _content
                _produced.append(_content)
            except Exception:
                pass
    if _produced:
        _LAST_SKILL_OUTPUTS[dir_name] = _produced
    return result

RUN_SKILL_SCRIPT_TOOL = FunctionTool(_run_skill_script)

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
        end = text.find("\\n---\\n", 3)
        if end != -1:
            nl = text.find("\\n", end + 1)
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
            "You are running the '" + dir_name + "' skill as a MANDATORY step in a compiled "
            "workflow. Follow the skill instructions below and APPLY THE SKILL to the INPUT. "
            "If the skill produces a document/file (e.g. an HTML report via a create/render "
            "script), you MUST call run_skill_script to generate it -- stage your authored "
            "content via input_files and pass the output path in read_outputs; the workflow "
            "captures that produced file as this node's output. If the skill has no script, "
            "return the transformed result as your response.\\n\\n"
            "=== SKILL INSTRUCTIONS ===\\n" + body +
            "\\n\\n=== INPUT (apply the skill to this) ===\\n" + str(prior)
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
        )`;
  }

  /**
   * Emit one `LlmAgent` per agent node -- iterated via analyzed.order (topological
   * sequence; see file-header note on why the raw `agents` object can't be enumerated
   * directly). Mirrors ADKGenerator::agentsBlock() line for line.
   */
  private static agentsBlock(analyzed: AnalyzeResult): string {
    const out: string[] = [];
    for (const id of analyzed.order) {
      const ag: AnalyzedAgent | undefined = analyzed.agents[id];
      if (!ag) continue;

      let instr = ag.systemPrompt;
      // Only inject from parents that are themselves agent nodes.
      const agentParents = (analyzed.parents[id] ?? []).filter((p) =>
        Object.prototype.hasOwnProperty.call(analyzed.agents, p)
      );
      for (const p of agentParents) {
        instr += '\n\n## Input from node ' + p + '\n{node_' + p + '}';
      }

      const skills = ag.skills ?? [];
      const hasSkills = skills.length > 0;

      // The main agent NEVER carries the skill tool -- skills are separate steps now.
      const toolExprs = (ag.tools ?? []).map((t) => 'catalog["' + t + '"]');
      const toolsPy = '[' + toolExprs.join(', ') + ']';

      const model = '_make_model("' + ag.provider + '", "' + ag.model + '")';
      const agentVar = hasSkills ? `node_${id}_agent` : `node_${id}`;
      const agentOutKey = hasSkills ? `node_${id}_agent` : `node_${id}`;

      const agentComment = String(ag.name ?? '').split('\r').join(' ').split('\n').join(' ');
      let entry = `# Agent "${agentComment}" (${ag.provider}/${ag.model}) -- workflow node ${id}\n`;
      entry += `${agentVar} = LlmAgent(\n`;
      entry += `    name="${agentVar}",\n`;
      entry += `    model=${model},\n`;
      entry += '    instruction=' + pyStr(instr) + ',\n';
      entry += `    tools=${toolsPy},\n`;
      // Emit the agent-form values verbatim -- never override a form-stated parameter.
      if (ag.temperature !== null || ag.max_tokens !== null) {
        const kwargs: string[] = [];
        if (ag.temperature !== null) kwargs.push('temperature=' + JSON.stringify(ag.temperature));
        if (ag.max_tokens !== null) kwargs.push('max_output_tokens=' + JSON.stringify(ag.max_tokens));
        entry += '    generate_content_config=types.GenerateContentConfig(' + kwargs.join(', ') + '),\n';
      }
      entry += `    output_key="${agentOutKey}",\n`;
      entry += ')';

      if (hasSkills) {
        let prev = `node_${id}_agent`;
        const subAgents: string[] = [`node_${id}_agent`];
        skills.forEach((skill, k) => {
          const stepNo = k + 1;
          const isLast = stepNo === skills.length;
          const llmVar = `node_${id}_skill_${stepNo}_llm`;
          const capVar = `node_${id}_skill_${stepNo}`;
          const stepOut = isLast ? `node_${id}` : capVar;

          let dirLiteral: string;
          let instrExpr: string;
          let toolPy: string;
          if (Object.prototype.hasOwnProperty.call(skill, 'dir')) {
            const dir = phpAddslashes(skill.dir);
            dirLiteral = `"${dir}"`;
            instrExpr = `_skill_instruction("${dir}", "${prev}")`;
            toolPy = `[_make_skill_tool("${dir}")]`;
          } else {
            dirLiteral = '""';
            const inlineMd = pyStr(String(skill.inline ?? ''));
            instrExpr = `_skill_instruction("", "${prev}", inline_md=${inlineMd})`;
            toolPy = '[]';
          }

          entry += `\n\n# Skill step ${stepNo} for node ${id}: LLM applies the skill; capture makes the node output the produced deliverable (else the LLM text).\n`;
          entry += `${llmVar} = LlmAgent(\n`;
          entry += `    name="${llmVar}",\n`;
          entry += `    model=${model},\n`;
          entry += `    instruction=${instrExpr},\n`;
          entry += `    tools=${toolPy},\n`;
          entry += `    output_key="${llmVar}",\n`;
          entry += ')';
          entry += `\n${capVar} = _SkillCaptureAgent(name="${capVar}", skill_dir=${dirLiteral}, llm_key="${llmVar}", out_key="${stepOut}")`;
          subAgents.push(llmVar, capVar);
          prev = capVar;
        });
        const subList = subAgents.join(', ');
        entry += `\n\n# Node ${id}: agent then mandatory skill pipeline (LLM turn + capture per skill); this is what the layering references.\n`;
        entry += `node_${id} = SequentialAgent(\n    name="node_${id}",\n    sub_agents=[${subList}],\n)`;
      }

      out.push(entry);
    }
    return out.join('\n\n');
  }

  /**
   * The _PassThroughAgent class definition -- a non-LLM fan-in used by output
   * nodes. Emitted once, before the output nodes that instantiate it.
   */
  private static passThroughAgentBlock(): string {
    return `class _PassThroughAgent(BaseAgent):
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
        text = vals[0] if len(vals) == 1 else "\\n\\n---\\n\\n".join(vals)
        yield Event(
            author=self.name,
            content=types.Content(role="model", parts=[types.Part(text=text)]),
            actions=EventActions(state_delta={self.name: text}),
            turn_complete=True,
        )`;
  }

  /**
   * Emit each `output` node as a non-LLM _PassThroughAgent that forwards its
   * parent(s) output from session.state verbatim. Returns '' when the workflow
   * has no output nodes. Iterated via analyzed.order (see file-header note).
   */
  private static outputConsolidatorsBlock(analyzed: AnalyzeResult): string {
    const out: string[] = [];
    for (const id of analyzed.order) {
      const node = analyzed.byId[id];
      if (WorkflowGraphAnalyzer.typeOf(node) !== 'output') continue;
      const parents = analyzed.parents[id] ?? [];
      const keys = parents.map((p) => '"node_' + p + '"');
      const keysPy = '[' + keys.join(', ') + ']';
      let entry = `# Output (fan-in) node ${id} -- forwards its parent(s) result verbatim (no LLM),\n`;
      entry += `# so formatting such as HTML is preserved. Single parent = pass-through.\n`;
      entry += `node_${id} = _PassThroughAgent(name="node_${id}", source_keys=${keysPy})`;
      out.push(entry);
    }
    return out.join('\n\n');
  }

  /**
   * Build `root_agent = SequentialAgent(...)` from the topological layers.
   * Layer 0 (start node) is skipped because the start node only seeds state.
   */
  private static rootBlock(analyzed: AnalyzeResult): string {
    const isRunnable = (id: string): boolean => {
      const t = WorkflowGraphAnalyzer.typeOf(analyzed.byId[id]);
      return t === 'agent' || t === 'agent-template' || t === 'output';
    };
    const layerExprs: string[] = [];
    analyzed.layers.forEach((layer, k) => {
      const vars = layer.filter(isRunnable).map((id) => `node_${id}`);
      if (vars.length === 0) return;
      if (vars.length === 1) {
        layerExprs.push(vars[0]);
      } else {
        layerExprs.push(`ParallelAgent(name="layer_${k}", sub_agents=[${vars.join(', ')}])`);
      }
    });
    const body = layerExprs.join(',\n    ');
    return `root_agent = SequentialAgent(\n    name="workflow",\n    sub_agents=[\n    ${body}\n    ],\n)`;
  }

  /**
   * Emit `async def main(...)` + `if __name__ == "__main__"` block.
   * Reproduced as an array of logical lines joined with '\n' (matching the PHP
   * string-concatenation source line-for-line); the final line intentionally has
   * no trailing newline (mirrors PHP's mainBlock(), which doesn't append one --
   * emitAdk() adds the file's single trailing "\n" itself).
   */
  private static mainBlock(analyzed: AnalyzeResult): string {
    const sp = pyStr(analyzed.startPrompt);
    const name = pyStr(analyzed.workflow.name);
    const wfId = analyzed.workflow.id | 0;
    const storageEnabled = analyzed.outputStorageEnabled ? 'True' : 'False';
    const folder = analyzed.outputFolder ?? null;
    const folderPy = folder !== null && folder !== '' ? pyStr(String(folder)) : 'None';

    const nodeNames: Record<string, string> = {};
    for (const nid of analyzed.order) {
      const ag = analyzed.agents[nid];
      if (!ag) continue;
      nodeNames[String(nid)] = String(ag.name ?? 'node ' + nid);
    }
    const nodeNamesPy = jsonToPython(nodeNames);

    const body = [
      `WORKFLOW_NAME = ${name}`,
      `WORKFLOW_ID = ${wfId}`,
      `OUTPUT_STORAGE_ENABLED = ${storageEnabled}`,
      `OUTPUT_FOLDER = ${folderPy}`,
      `NODE_NAMES = ${nodeNamesPy}  # node id -> human name (for readable logs)`,
      '',
      `async def main(user_prompt: str = ${sp}):`,
      '    if START_DOCUMENTS:',
      '        doc_parts = []',
      '        for doc in START_DOCUMENTS:',
      '            name = doc.get("name", "Document")',
      '            path = doc.get("path", "")',
      '            if not path:',
      '                doc_parts.append(f"### {name}\\n\\n_(no path on attachment record)_")',
      '                continue',
      '            try:',
      '                md = _convert_doc_to_markdown(path)',
      '                doc_parts.append(f"### {name}\\n\\n{md}")',
      '            except Exception as e:',
      '                doc_parts.append(f"### {name}\\n\\n_(conversion failed: {e})_")',
      '        if doc_parts:',
      '            user_prompt = (',
      '                "## Attached Documents\\n\\n"',
      '                + "\\n\\n---\\n\\n".join(doc_parts)',
      '                + "\\n\\n---\\n\\n"',
      '                + user_prompt',
      '            )',
      '    print(f"[workflow] {WORKFLOW_NAME} starting", flush=True)',
      '    print(f"[workflow] prompt: {user_prompt[:200]!r}", flush=True)',
      '    session_service = InMemorySessionService()',
      '    runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)',
      '    session = await session_service.create_session(app_name="workflow", user_id="local", state={})',
      '    final = ""',
      '    t0 = time.monotonic()',
      '    seen = set()',
      '    content = types.Content(role="user", parts=[types.Part(text=user_prompt)])',
      '    try:',
      '        async for event in runner.run_async(user_id="local", session_id=session.id, new_message=content):',
      '            author = getattr(event, "author", "?")',
      '            if author and author not in seen:',
      '                seen.add(author)',
      '                if isinstance(author, str) and author.startswith("node_"):',
      '                    _ap = author.split("_")',
      '                    _nid = _ap[1] if len(_ap) > 1 else author',
      '                    _kind = "skill step" if "skill" in author else "agent"',
      '                    print(f"[node {_nid}] {NODE_NAMES.get(_nid, _nid)!r} \\u2192 {_kind} active", flush=True)',
      '                else:',
      '                    print(f"[node] > {author}", flush=True)',
      '            parts = (event.content.parts if event.content else None) or []',
      '            for p in parts:',
      '                fc = getattr(p, "function_call", None)',
      '                fr = getattr(p, "function_response", None)',
      '                if fc is not None:',
      '                    _a = str(getattr(fc, "args", ""))[:200]',
      '                    print(f"[tool] -> {fc.name}({_a})", flush=True)',
      '                elif fr is not None:',
      '                    _r = str(getattr(fr, "response", ""))[:200]',
      '                    print(f"[tool] <- {fr.name}: {_r}", flush=True)',
      '                else:',
      '                    txt = (getattr(p, "text", None) or "").strip()',
      '                    if txt:',
      '                        print(f"[{author}] {txt[:240]}", flush=True)',
      '            if event.is_final_response() and event.content and event.content.parts:',
      '                final = event.content.parts[0].text or final',
      '        print(f"[workflow] done in {time.monotonic() - t0:.1f}s, {len(final)} chars", flush=True)',
      '    except Exception:',
      '        print("[workflow] ERROR:", flush=True)',
      '        traceback.print_exc()',
      '        raise',
      '    import re as _re',
      '    _mm = _re.search(r"(?is)<!doctype html.*?</html\\s*>", final) or _re.search(r"(?is)<html[\\s>].*?</html\\s*>", final)',
      '    if _mm:',
      '        final = _mm.group(0)  # strip narration/fences around a full HTML doc',
      '        _ext = "html"',
      '    else:',
      '        _ext = "md"',
      '    _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"',
      '    _ts = time.strftime("%Y%m%d-%H%M%S")',
      "    # Honour the Output node's storage setting: when ON, persist the final result",
      '    # where the app stores it (~/Documents/synergyAI/outputs/workflow/ by default,',
      "    # overridable via SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, skip.",
      '    if OUTPUT_STORAGE_ENABLED:',
      '        _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")',
      '        if OUTPUT_FOLDER:',
      '            _cf = os.path.expanduser(OUTPUT_FOLDER)',
      '            _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)',
      '        else:',
      '            _save_dir = os.path.join(_root, "workflow")',
      '        os.makedirs(_save_dir, exist_ok=True)',
      '        _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")',
      '        with open(_out, "w", encoding="utf-8") as _f:',
      '            _f.write(final)',
      '        print(f"[workflow] result saved to {os.path.abspath(_out)}", flush=True)',
      '    else:',
      '        print("[workflow] output storage is OFF -- result printed below, not saved", flush=True)',
      '    print(final)',
      '    return final',
      '',
      'if __name__ == "__main__":',
      '    # Join ALL argv (a prompt is one string even with spaces) -- the runner',
      '    # passes it space-split; sys.argv[1] alone would keep only the first word.',
      `    asyncio.run(main(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else ${sp}))`,
    ];
    return body.join('\n');
  }

  /**
   * Emit concrete typed FunctionTool functions from TOOL_CATALOG input_schema.
   * Mirrors ADKGenerator::adkToolBuilderBlock() exactly, including the (deliberately
   * non-collapsing) byte-domain tool-name sanitizer and the required-before-optional
   * Python-signature ordering.
   */
  private static adkToolBuilderBlock(analyzed: AnalyzeResult): string {
    const functions: string[] = [];
    const catalogEntries: string[] = [];

    for (const [toolName, specRaw] of Object.entries(analyzed.usedCatalog)) {
      const spec = isPlainObject(specRaw) ? specRaw : {};
      const description = String(spec.description ?? toolName);
      // PHP quirk (verified against live output, not documented anywhere -- replicated for
      // byte parity): WorkflowGraphAnalyzer::loadMcpToolsWithServers() decodes the schema via
      // `json_decode($schemaRaw)` WITHOUT the `$assoc = true` flag, so a `{...}` JSON schema
      // (the normal shape) becomes a PHP stdClass, never an array. ADKGenerator::adkToolBuilderBlock()
      // then gates on `is_array($spec['input_schema'] ?? null)`, which is false for a stdClass --
      // so in practice PHP treats EVERY tool's input_schema as empty and emits zero-parameter
      // `_tool_*` functions (`_call_mcp_tool(url, name, {})`) regardless of the tool's real schema.
      // JS's JSON.parse has no object/array type distinction to lose, so `analyzed.usedCatalog[
      // toolName].input_schema` here is a plain object for a real schema -- Array.isArray() on it
      // mirrors PHP's is_array()-on-stdClass-is-always-false behaviour exactly (a JSON schema is
      // essentially never a top-level JSON array, so this is always false in practice, matching PHP).
      const inputSchema: Record<string, any> = Array.isArray(spec.input_schema) ? spec.input_schema : {};
      const properties = isPlainObject(inputSchema.properties) ? inputSchema.properties : {};
      const required: string[] = Array.isArray(inputSchema.required) ? inputSchema.required.map(String) : [];
      const serverUrl = String(spec.server_url ?? '');

      let safeName = sanitizeToolFnNameBytes(toolName);
      if (/^[0-9]/.test(safeName)) safeName = '_' + safeName;
      const fnName = '_tool_' + safeName;

      const requiredSet = new Set(required);

      const validRequired = new Map<string, Record<string, any>>();
      const validOptional = new Map<string, Record<string, any>>();
      let hasExtra = false;

      for (const pname of required) {
        if (!Object.prototype.hasOwnProperty.call(properties, pname)) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(pname) && !PY_KEYWORDS.has(pname)) {
          validRequired.set(pname, isPlainObject(properties[pname]) ? properties[pname] : {});
        } else {
          hasExtra = true;
        }
      }
      for (const [pnameRaw, pspecRaw] of Object.entries(properties)) {
        const pname = String(pnameRaw);
        if (requiredSet.has(pname)) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(pname) && !PY_KEYWORDS.has(pname)) {
          validOptional.set(pname, isPlainObject(pspecRaw) ? pspecRaw : {});
        } else {
          hasExtra = true;
        }
      }

      const params: string[] = [];
      for (const [pname, pspec] of validRequired) {
        const type = JSON_TYPE_MAP[pspec.type ?? ''] ?? 'str';
        params.push(`${pname}: ${type}`);
      }
      for (const [pname, pspec] of validOptional) {
        const type = JSON_TYPE_MAP[pspec.type ?? ''] ?? 'str';
        params.push(`${pname}: ${type} = None`);
      }
      if (hasExtra) params.push('**extra');

      const paramStr = params.join(', ');
      const allValidProps = new Map<string, Record<string, any>>([...validRequired, ...validOptional]);

      const safeDesc = description.split('"""').join('\\"\\"\\"');
      let doc = `    """${safeDesc}`;
      if (allValidProps.size > 0) {
        doc += '\n\n    Args:';
        for (const [pname, pspec] of allValidProps) {
          const pDesc = String(pspec?.description ?? '');
          doc += `\n        ${pname}: ${pDesc}`;
        }
      }
      doc += '\n    """';

      const pyUrl = pyStr(serverUrl);
      const pyName = pyStr(toolName);

      let body: string;
      if (allValidProps.size > 0 || hasExtra) {
        const argPairs: string[] = [];
        for (const pname of allValidProps.keys()) {
          argPairs.push(`"${pname}": ${pname}`);
        }
        let argDict: string;
        if (hasExtra) {
          const innerDict = '{' + argPairs.join(', ') + '}';
          argDict = `{**${innerDict}, **extra}`;
        } else {
          argDict = '{' + argPairs.join(', ') + '}';
        }
        body = `    _args = {k: v for k, v in ${argDict}.items() if v is not None}\n`;
        body += `    return _call_mcp_tool(${pyUrl}, ${pyName}, _args)`;
      } else {
        body = `    return _call_mcp_tool(${pyUrl}, ${pyName}, {})`;
      }

      functions.push(`def ${fnName}(${paramStr}) -> str:\n${doc}\n${body}`);
      catalogEntries.push(`        ${pyName}: FunctionTool(${fnName})`);
    }

    let out = '';
    if (functions.length > 0) {
      out += functions.join('\n\n') + '\n\n';
    }

    if (catalogEntries.length > 0) {
      out += 'def build_tools_from_catalog() -> dict:\n';
      out += '    return {\n';
      out += catalogEntries.join(',\n') + ',\n';
      out += '    }';
    } else {
      out += 'def build_tools_from_catalog() -> dict:\n';
      out += '    return {}';
    }

    return out;
  }
}
