"""Port of backend/src/AgentTeam/Services/ADKGenerator.php (1203 lines).

Generates a standalone Python Google ADK script from a saved workflow. The
generated file is fully independent of the PHP/Python backend -- it runs
directly against the Google ADK runtime using LiteLLM for multi-provider
model support.

emitAdk() is a pure static method (no DB/I/O) so it can be unit-tested
without a database. generate() does the DB lookup via WorkflowGraphAnalyzer
and then delegates to emitAdk().

Byte-identical emission: every literal string below was extracted from
`php -r` runs against the live PHP ADKGenerator (see Phase 6 Task 3 report)
-- not retyped from the PHP source by eye.

Stale-oracle note (documented in the Task 3 report): `_make_model` gained a
`thinking` parameter after `AdkGeneratorEmitTest.php`/`adk_diamond.golden.py`
were written; this port matches LIVE PHP (`thinking=None` / `thinking="on"|"off"`
kwarg always present), not the stale oracle strings.
"""
from __future__ import annotations

import re

from app.agent_team.services.python_emit_helpers import PythonEmitHelpers, _phpFloatToken
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.support.logger import error_log
from app.support.phpcompat import php_empty, php_intval, php_strval

_NAME_SLUG_RE = re.compile(r'[^a-z0-9_]+', re.IGNORECASE | re.ASCII)
_IDENT_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
_LEADING_DIGIT_RE = re.compile(r'^[0-9]')
_NON_IDENT_RE = re.compile(r'[^A-Za-z0-9_]')

_PY_KEYWORDS = {
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
    'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
    'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
    'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
}

_TYPE_MAP = {
    'string': 'str', 'integer': 'int', 'number': 'float',
    'boolean': 'bool', 'array': 'list', 'object': 'dict',
}


def _coalesce(*vals):
    """PHP `??` chain: first argument that is not None, else None."""
    for v in vals:
        if v is not None:
            return v
    return None


def _json_num(v):
    """`json_encode()` of an int/float under `serialize_precision=-1`."""
    if isinstance(v, float):
        return _phpFloatToken(v)
    import json as _json
    return _json.dumps(v)


class ADKGenerator:
    def __init__(self, db, workflowRepo, graphRepo, agentRepo):
        self.db = db
        self.workflowRepo = workflowRepo
        self.graphRepo = graphRepo
        self.agentRepo = agentRepo

    def generate(self, workflowId: int, userId: str | None = None) -> dict:
        """PHP 35-61."""
        analyzer = WorkflowGraphAnalyzer(self.db, self.workflowRepo, self.graphRepo, self.agentRepo)
        analyzed = analyzer.analyze(workflowId, userId)

        defaults: dict[str, str] = {}
        try:
            for row in self.db.fetch_all("SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1"):
                if not php_empty(row.get('model')):
                    defaults[php_strval(row.get('provider_key')).lower()] = php_strval(row.get('model'))
        except Exception as e:
            error_log('[ADKGenerator] could not load provider default models: ' + str(e))
        analyzed['providerDefaultModels'] = defaults

        name = _NAME_SLUG_RE.sub('_', php_strval(analyzed['workflow']['name']))
        return {
            'filename': name.lower() + '_adk.py',
            'code': ADKGenerator.emitAdk(analyzed),
        }

    @staticmethod
    def emitAdk(analyzed: dict) -> str:
        """PHP 70-164."""
        lines: list[str] = []
        lines.append(ADKGenerator._headerBlock(analyzed))

        lines.append(ADKGenerator._banner(
            'MODEL FACTORY',
            'Maps a node provider+model to an ADK model. Gemini is native;',
            'every other provider routes through LiteLLM (OpenAI-compatible',
            'endpoints for Grok/Kimi/DeepSeek/GLM). The node form Thinking',
            'attribute governs reasoning mode; hard API constraints only',
            '(kimi sampling, deepseek-v4 thinking rules) are applied here.',
            'To support a new provider: add a branch in _make_model.'))
        lines.append(ADKGenerator._modelFactoryBlock())

        lines.append(ADKGenerator._banner(
            'MCP SERVER REGISTRY',
            'Baked at generation time from the workflow editor config.',
            'Maps server URL -> metadata. If a server moves, update the URL here.'))
        lines.append('MCP_SERVERS = ' + PythonEmitHelpers.jsonToPython(analyzed['usedServers'], True))
        lines.append(ADKGenerator._banner(
            'TOOL CATALOG',
            'Each entry maps a tool name to its MCP server URL and JSON Schema.',
            'Only tools actually used by agents in this workflow are included.',
            'To add a tool: add an entry here AND reference it in the agent',
            'definitions below (catalog["<tool>"]).'))
        lines.append('TOOL_CATALOG = ' + PythonEmitHelpers.jsonToPython(analyzed['usedCatalog'], True))
        lines.append(ADKGenerator._banner(
            'MCP CLIENT',
            'HTTP JSON-RPC client used by every generated _tool_* function.'))
        lines.append(PythonEmitHelpers.mcpClientBlock())
        lines.append(ADKGenerator._banner(
            'DOCUMENT CONVERTER',
            'Turns a start-node attachment into markdown for the prompt.'))
        lines.append(PythonEmitHelpers.documentConverterBlock())
        lines.append(ADKGenerator._banner(
            'TOOL WRAPPERS',
            'One typed FunctionTool per catalog entry; ADK introspects each',
            'function signature to build the tool schema the model sees.'))
        lines.append(ADKGenerator._adkToolBuilderBlock(analyzed))

        needsSkills = False
        for agent in analyzed['agents'].values():
            if not php_empty(agent.get('skills')):
                needsSkills = True
                break
        if needsSkills:
            lines.append(ADKGenerator._banner(
                'SKILL RUNTIME',
                'Runs folder-backed skills (SKILL.md + scripts) as mandatory',
                'post-agent SequentialAgent steps: an LLM turn instructed by',
                'SKILL.md, then a capture agent that makes the node output the',
                'file the script PRODUCED (else the LLM text). Staged',
                'input_files are repaired if a model delivers them',
                'JSON-over-escaped. Scripts run as async subprocesses here.'))
            lines.append(PythonEmitHelpers.skillDepsBlock())
            lines.append(ADKGenerator._skillRunnerBlock())

        lines.append('# The tool objects agents reference by name as catalog["<tool>"].')
        lines.append('catalog = build_tools_from_catalog()')
        lines.append('START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(analyzed['startDocuments']))
        lines.append(ADKGenerator._banner(
            'AGENTS — ONE LlmAgent PER WORKFLOW NODE',
            'Each agent writes its result to session.state["node_<id>"]; a',
            "child reads a parent through the literal {node_<id>} placeholder",
            "in its instruction (ADK state templating). Provider/model/tools/",
            'sampling come verbatim from the editor forms (constraint clamps',
            'are documented as comments on the affected node). To change a',
            'node: edit the workflow in the editor and re-generate.'))
        lines.append(ADKGenerator._agentsBlock(analyzed))

        consolidators = ADKGenerator._outputConsolidatorsBlock(analyzed)
        if consolidators != '':
            lines.append(ADKGenerator._banner(
                'OUTPUT (FAN-IN) NODES',
                'Non-LLM pass-throughs: forward parent result(s) VERBATIM so',
                'formatting such as HTML is never reworded by another model.'))
            lines.append(ADKGenerator._passThroughAgentBlock())
            lines.append(consolidators)
        lines.append(ADKGenerator._banner(
            'ORCHESTRATION',
            'The workflow graph as TOPOLOGICAL LAYERS: independent nodes at',
            'the same depth run together in a ParallelAgent; the layers run',
            'in order inside a SequentialAgent. This mirrors the canvas.'))
        lines.append(ADKGenerator._rootBlock(analyzed))
        lines.append(ADKGenerator._banner(
            'CLI ENTRY',
            'Seeds the prompt (+ attached documents), runs the graph via',
            'Runner, streams a [node]/[tool] trace, saves the result per the',
            'Output node storage setting, and closes with a RUN SUMMARY',
            '(time per node, total wall-clock, document location).'))
        lines.append(ADKGenerator._mainBlock(analyzed))

        return '\n'.join(lines) + '\n'

    # -------------------------------------------------------------------------
    # Private emit helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def _headerBlock(analyzed: dict) -> str:
        """PHP 177-222."""
        def esc(s: str) -> str:
            return s.replace('"""', "'''").replace('\\', '\\\\')

        name = esc(php_strval(analyzed['workflow']['name']))
        docBody = esc(PythonEmitHelpers.workflowDocBlock({
            'target': 'Google ADK (Python) -- LlmAgent per node, Sequential/Parallel layers',
            'workflow': analyzed['workflow'],
            'nodes': ADKGenerator._docNodes(analyzed),
            'edges': [[e['from'], e['to']] for e in (analyzed.get('edges') or [])],
            'layers': analyzed.get('layers') or [],
            'data_flow': ADKGenerator._dataFlowDoc(),
            'run': {
                'deps': ['pip install "google-adk>=2.3,<3" litellm httpx python-dotenv   # 2.3.x: SequentialAgent/ParallelAgent still supported'],
                'usage': 'python this_file.py "your prompt here"',
            },
            'storage': {'enabled': not php_empty(analyzed.get('outputStorageEnabled')), 'folder': analyzed.get('outputFolder')},
        }))
        return (
            '"""Standalone Google ADK workflow: ' + name + '\n'
            '\n'
            + docBody + '\n'
            '"""\n'
            'import asyncio, json, os, subprocess, sys, threading, time, traceback, urllib.request\n'
            'import httpx\n'
            'from typing import Any\n'
            '\n'
            'from dotenv import load_dotenv\n'
            '\n'
            "# Load provider API keys from the runner env's .env (one dir up from scripts/).\n"
            '# Without this, a DIRECT terminal run has no credentials and every LiteLLM call\n'
            '# fails with "Missing credentials … set the OPENAI_API_KEY" — runner-mediated\n'
            '# runs only worked because main.py loads the same file and subprocesses inherit.\n'
            'load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))\n'
            '\n'
            'from google.adk.agents import LlmAgent, SequentialAgent, ParallelAgent, BaseAgent\n'
            'from google.adk.models.lite_llm import LiteLlm\n'
            'from google.adk.tools import FunctionTool\n'
            'from google.adk.runners import Runner\n'
            'from google.adk.sessions import InMemorySessionService\n'
            'from google.adk.events import Event, EventActions\n'
            'from google.genai import types\n'
            '\n'
            '# Runtime "today" for date-grounding every agent instruction (evaluated at import).\n'
            '_TODAY = time.strftime("%Y-%m-%d")'
        )

    @staticmethod
    def _modelFactoryBlock() -> str:
        """PHP 234-302."""
        return '''def _make_model(provider: str, model: str, thinking: str | None = None):
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
            # The node form's Thinking attribute governs (platform parity):
            # 'off' -> disabled (form temperature accepted); 'on'/default ->
            # V4's server default stays ON (sampling params are dropped at the
            # config level by the generator in that case).
            _mode = "disabled" if thinking == "off" else "enabled"
            kwargs["extra_body"] = {"thinking": {"type": _mode}}
        return LiteLlm(**kwargs)
    if p == "kimi":
        kwargs = dict(
            model="openai/" + model,
            api_base="https://api.moonshot.ai/v1",
            api_key=os.environ.get("KIMI_API_KEY"),
        )
        if model.startswith("kimi-k2"):
            # Thinking attribute governs; K2's sampling constraints per mode
            # are enforced at the config level by the generator.
            _mode = "enabled" if thinking == "on" else "disabled"
            kwargs["extra_body"] = {"thinking": {"type": _mode}}
        return LiteLlm(**kwargs)
    if p == "glm":
        # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible. Default: thinking off so it
        # answers directly; the node form's Thinking attribute can enable it.
        return LiteLlm(
            model="openai/" + model,
            api_base="https://api.z.ai/api/paas/v4",
            api_key=os.environ.get("GLM_API_KEY"),
            extra_body={"thinking": {"type": "enabled" if thinking == "on" else "disabled"}},
        )
    # Fallback: best-effort litellm prefixed spec.
    return LiteLlm(model=model if "/" in model else p + "/" + model)'''

    @staticmethod
    def skillRunnerBlockForTest() -> str:
        """PHP 305. Test seam: exposes skillRunnerBlock() output for unit testing."""
        return ADKGenerator._skillRunnerBlock()

    @staticmethod
    def _banner(title: str, *lines: str) -> str:
        """PHP 312-321. LangGraph-style boxed section banner."""
        bar = '# ' + '=' * 62
        out = [bar, '# ' + title]
        for l in lines:
            out.append('# ' + l)
        out.append(bar)
        return '\n'.join(out)

    @staticmethod
    def _skillRunnerBlock() -> str:
        """PHP 336-519. ADK-specific async skill runner (two nowdocs concatenated)."""
        py = r'''# Skills use the same virtual dirs the browser interpreter provides: "/outputs"
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

RUN_SKILL_SCRIPT_TOOL = FunctionTool(_run_skill_script)'''
        py += '''

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
            "Current date: " + _TODAY + ".\\n"
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
        )'''
        return py

    @staticmethod
    def _docNodes(analyzed: dict) -> list[dict]:
        """PHP 550-553. Uniform node descriptors."""
        return WorkflowGraphAnalyzer.docNodesFromAnalyzed(analyzed)

    @staticmethod
    def _dataFlowDoc() -> str:
        """PHP 558-593. DATA FLOW section of the module docstring."""
        return (
            "HOW THIS FILE IS ORGANISED (top to bottom):\n"
            "  1. _make_model(provider, model)  -- maps a node's provider+model to an ADK model\n"
            "                                      (Gemini = native string; every other provider goes\n"
            "                                      through LiteLLM, Grok/Kimi/DeepSeek routed to their\n"
            "                                      OpenAI-compatible API).\n"
            "  2. MCP_SERVERS / TOOL_CATALOG    -- the MCP tools this workflow uses, baked in.\n"
            "  3. _call_mcp_tool + build_tools_from_catalog()\n"
            "                                   -- an HTTP JSON-RPC MCP client; each tool is wrapped\n"
            "                                      as an ADK FunctionTool the model can call.\n"
            "  4. Skill runner (only when the workflow uses skills)\n"
            "                                   -- runs a skill folder Python script as a subprocess.\n"
            "  5. node_<id> = LlmAgent(...)     -- ONE agent per workflow node. Each agent writes its\n"
            '                                      answer to session.state["node_<id>"]; a downstream\n'
            "                                      agent reads a parent's output through the literal\n"
            "                                      {node_<id>} placeholder in its instruction (ADK\n"
            '                                      "state templating" -- the runtime substitutes it).\n'
            "  6. root_agent = SequentialAgent  -- the graph as TOPOLOGICAL LAYERS: independent nodes\n"
            "                                      at the same depth run together in a ParallelAgent;\n"
            "                                      the layers themselves run in order.\n"
            "  7. main()                        -- seeds the prompt (plus attached documents), runs the\n"
            "                                      graph via Runner, streams a [node]/[tool] trace,\n"
            "                                      saves the result, and prints a RUN SUMMARY.\n"
            "\n"
            "NODE-INTERNAL PIPELINE (fixed order):\n"
            "    merged fan-in (parents' outputs via {node_<id>} state placeholders)\n"
            "      ==> AGENT: the node's LlmAgent -- system prompt, MCP tools and sampling\n"
            "          verbatim from the editor form (provider CONSTRAINT clamps only, each\n"
            "          documented as an emitted comment). Instructions are grounded in\n"
            "          today's date at import time.\n"
            "      ==> SKILL step(s), each a SequentialAgent pair: an LLM turn whose system\n"
            "          prompt is the skill's SKILL.md, then a capture agent that makes the\n"
            "          node output the file the skill's script PRODUCED (else the LLM text).\n"
            "    The Output node is a non-LLM pass-through: parents' text verbatim.\n"
            "Dispatcher and playbook nodes are NOT executed by this target (see GRAPH NODES)."
        )

    @staticmethod
    def _agentsBlock(analyzed: dict) -> str:
        """PHP 596-769."""
        out: list[str] = []
        docById: dict[str, dict] = {}
        for dn in ADKGenerator._docNodes(analyzed):
            docById[dn['id']] = dn
        for id_, ag in analyzed['agents'].items():
            ag = dict(ag)
            instr = ag.get('systemPrompt')

            agentParents = [p for p in (analyzed['parents'].get(id_) or []) if p in analyzed['agents']]
            for p in agentParents:
                instr += '\n\n## Input from node ' + php_strval(p) + '\n{node_' + php_strval(p) + '}'

            skills = ag.get('skills') or []
            hasSkills = len(skills) > 0

            defaults = analyzed.get('providerDefaultModels') or {}
            provKey = php_strval(_coalesce(ag.get('provider'), 'claude')).lower()
            canon = {'anthropic': 'claude', 'google': 'gemini'}.get(provKey, provKey)
            modelStr = php_strval(_coalesce(ag.get('model'), ''))
            if modelStr == '':
                modelStr = php_strval(_coalesce(defaults.get(canon), defaults.get(provKey), ''))
            ag['model'] = modelStr

            thinking = _coalesce(ag.get('thinking'), None)
            clampNotes: list[str] = []
            if provKey == 'kimi' and modelStr.startswith('kimi-k2'):
                want = 1.0 if thinking == 'on' else 0.6
                if ag.get('temperature') is not None and float(ag['temperature']) != want:
                    clampNotes.append(
                        'temperature ' + php_strval(ag['temperature']) + ' -> ' + php_strval(want)
                        + ' (kimi-k2 ' + ('thinking' if thinking == 'on' else 'non-thinking') + ' constraint)')
                    ag['temperature'] = want
            if (provKey == 'deepseek' and modelStr.startswith('deepseek-v4')
                    and thinking != 'off' and ag.get('temperature') is not None):
                clampNotes.append(
                    'temperature ' + php_strval(ag['temperature']) + ' dropped (deepseek-v4 thinking mode '
                    "rejects sampling params; set the node's Thinking attribute to Off to keep it)")
                ag['temperature'] = None
            if provKey in ('claude', 'anthropic') and ag.get('max_tokens') is not None and php_intval(ag['max_tokens']) > 16384:
                clampNotes.append('max_tokens ' + php_strval(ag['max_tokens']) + ' -> 16384 (anthropic non-streaming SDK limit)')
                ag['max_tokens'] = 16384

            toolExprs: list[str] = []
            for t in (ag.get('tools') or []):
                t = php_strval(t)
                if t.startswith('mcp_'):
                    t = t[4:]
                toolExprs.append('catalog["' + t + '"]')
            toolsPy = '[' + ', '.join(toolExprs) + ']'

            thinkPy = '"' + thinking + '"' if thinking in ('on', 'off') else 'None'
            model = '_make_model("' + php_strval(ag.get('provider')) + '", "' + php_strval(ag.get('model')) + '", thinking=' + thinkPy + ')'
            agentVar = 'node_' + php_strval(id_) + '_agent' if hasSkills else 'node_' + php_strval(id_)
            agentOutKey = agentVar

            entry = (PythonEmitHelpers.nodeCommentBlock(docById[php_strval(id_)]) + '\n') if php_strval(id_) in docById else ''
            for cn in clampNotes:
                entry += '# constraint clamp: ' + cn + '\n'
            entry += agentVar + ' = LlmAgent(\n'
            entry += '    name="' + agentVar + '",\n'
            entry += '    model=' + model + ',\n'
            entry += ('    instruction=("Current date: " + _TODAY + ". Treat this as \'now\'; "\n'
                      '                 "prefer your tools for current data over memory.\\n\\n"\n'
                      '                 + ' + PythonEmitHelpers.pyStr(instr) + '),\n')
            entry += '    tools=' + toolsPy + ',\n'
            if ag.get('temperature') is not None or ag.get('max_tokens') is not None:
                kwargs = []
                if ag.get('temperature') is not None:
                    kwargs.append('temperature=' + _json_num(ag['temperature']))
                if ag.get('max_tokens') is not None:
                    kwargs.append('max_output_tokens=' + _json_num(ag['max_tokens']))
                entry += '    generate_content_config=types.GenerateContentConfig(' + ', '.join(kwargs) + '),\n'
            entry += "    include_contents='none',\n"
            entry += '    output_key="' + agentOutKey + '",\n'
            entry += ')'

            if hasSkills:
                prev = 'node_' + php_strval(id_) + '_agent'
                subAgents = ['node_' + php_strval(id_) + '_agent']
                for k, skill in enumerate(skills):
                    stepNo = k + 1
                    isLast = stepNo == len(skills)
                    llmVar = 'node_' + php_strval(id_) + '_skill_' + str(stepNo) + '_llm'
                    capVar = 'node_' + php_strval(id_) + '_skill_' + str(stepNo)
                    stepOut = 'node_' + php_strval(id_) if isLast else capVar
                    if skill.get('dir') is not None:
                        dirName = skill['dir'].replace('\\', '\\\\').replace('"', '\\"').replace("'", "\\'")
                        dirLiteral = '"' + dirName + '"'
                        instrExpr = '_skill_instruction("' + dirName + '", "' + prev + '")'
                        toolPy = '[_make_skill_tool("' + dirName + '")]'
                    else:
                        dirLiteral = '""'
                        inlineMd = PythonEmitHelpers.pyStr(php_strval(skill.get('inline')))
                        instrExpr = '_skill_instruction("", "' + prev + '", inline_md=' + inlineMd + ')'
                        toolPy = '[]'
                    entry += ('\n\n# Skill step ' + str(stepNo) + ' for node ' + php_strval(id_)
                              + ': LLM applies the skill; capture makes the node output the produced deliverable (else the LLM text).\n')
                    entry += llmVar + ' = LlmAgent(\n'
                    entry += '    name="' + llmVar + '",\n'
                    entry += '    model=' + model + ',\n'
                    entry += '    instruction=' + instrExpr + ',\n'
                    entry += '    tools=' + toolPy + ',\n'
                    if ag.get('temperature') is not None or ag.get('max_tokens') is not None:
                        skwargs = []
                        if ag.get('temperature') is not None:
                            skwargs.append('temperature=' + _json_num(ag['temperature']))
                        if ag.get('max_tokens') is not None:
                            skwargs.append('max_output_tokens=' + _json_num(ag['max_tokens']))
                        entry += '    generate_content_config=types.GenerateContentConfig(' + ', '.join(skwargs) + '),\n'
                    entry += "    include_contents='none',\n"
                    entry += '    output_key="' + llmVar + '",\n'
                    entry += ')'
                    entry += ('\n' + capVar + ' = _SkillCaptureAgent(name="' + capVar + '", skill_dir=' + dirLiteral
                              + ', llm_key="' + llmVar + '", out_key="' + stepOut + '")')
                    subAgents.append(llmVar)
                    subAgents.append(capVar)
                    prev = capVar
                subList = ', '.join(subAgents)
                entry += ('\n\n# Node ' + php_strval(id_)
                          + ': agent then mandatory skill pipeline (LLM turn + capture per skill); this is what the layering references.\n')
                entry += 'node_' + php_strval(id_) + ' = SequentialAgent(\n    name="node_' + php_strval(id_) + '",\n    sub_agents=[' + subList + '],\n)'

            out.append(entry)
        return '\n\n'.join(out)

    @staticmethod
    def _passThroughAgentBlock() -> str:
        """PHP 777-800."""
        return '''class _PassThroughAgent(BaseAgent):
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
        )'''

    @staticmethod
    def _outputConsolidatorsBlock(analyzed: dict) -> str:
        """PHP 808-829."""
        out: list[str] = []
        for id_, node in analyzed['byId'].items():
            id_ = php_strval(id_)
            if WorkflowGraphAnalyzer.typeOf(node) != 'output':
                continue
            parents = analyzed['parents'].get(id_) or []
            keys = ['"node_' + php_strval(p) + '"' for p in parents]
            keysPy = '[' + ', '.join(keys) + ']'
            entry = ("# Output (fan-in) node " + id_ + " -- forwards its parent(s) result verbatim (no LLM),\n"
                     "# so formatting such as HTML is preserved. Single parent = pass-through.\n"
                     'node_' + id_ + ' = _PassThroughAgent(name="node_' + id_ + '", source_keys=' + keysPy + ')')
            out.append(entry)
        return '\n\n'.join(out)

    @staticmethod
    def _rootBlock(analyzed: dict) -> str:
        """PHP 841-866."""
        def isRunnable(id_: str) -> bool:
            t = WorkflowGraphAnalyzer.typeOf(analyzed['byId'][id_])
            return t in ('agent', 'agent-template', 'output')

        layerExprs: list[str] = []
        for k, layer in enumerate(analyzed['layers']):
            varsL = ['node_' + php_strval(id_) for id_ in layer if isRunnable(php_strval(id_))]
            if not varsL:
                continue
            if len(varsL) == 1:
                layerExprs.append(varsL[0])
            else:
                layerExprs.append('ParallelAgent(name="layer_' + str(k) + '", sub_agents=[' + ', '.join(varsL) + '])')
        body = ',\n    '.join(layerExprs)
        return 'root_agent = SequentialAgent(\n    name="workflow",\n    sub_agents=[\n    ' + body + '\n    ],\n)'

    @staticmethod
    def _mainBlock(analyzed: dict) -> str:
        """PHP 881-1020."""
        sp = PythonEmitHelpers.pyStr(analyzed['startPrompt'])
        name = PythonEmitHelpers.pyStr(analyzed['workflow']['name'])
        wfId = php_intval(_coalesce(analyzed['workflow'].get('id'), 0))
        storageEnabled = 'True' if not php_empty(analyzed.get('outputStorageEnabled')) else 'False'
        folder = analyzed.get('outputFolder')
        folderPy = PythonEmitHelpers.pyStr(php_strval(folder)) if folder is not None and folder != '' else 'None'
        nodeNames = {}
        for nid, ag in (analyzed.get('agents') or {}).items():
            nodeNames[php_strval(nid)] = php_strval(_coalesce(ag.get('name'), 'node ' + php_strval(nid)))
        nodeNamesPy = PythonEmitHelpers.jsonToPython(nodeNames)
        return (
            'WORKFLOW_NAME = ' + name + '\n'
            'WORKFLOW_ID = ' + str(wfId) + '\n'
            'OUTPUT_STORAGE_ENABLED = ' + storageEnabled + '\n'
            'OUTPUT_FOLDER = ' + folderPy + '\n'
            'NODE_NAMES = ' + nodeNamesPy + '  # node id -> human name (for readable logs)\n'
            '\n'
            'async def main(user_prompt: str = ' + sp + '):\n'
            '    if START_DOCUMENTS:\n'
            '        doc_parts = []\n'
            '        for doc in START_DOCUMENTS:\n'
            '            name = doc.get("name", "Document")\n'
            '            path = doc.get("path", "")\n'
            '            if not path:\n'
            '                doc_parts.append(f"### {name}\\n\\n_(no path on attachment record)_")\n'
            '                continue\n'
            '            try:\n'
            '                md = _convert_doc_to_markdown(path)\n'
            '                doc_parts.append(f"### {name}\\n\\n{md}")\n'
            '            except Exception as e:\n'
            '                doc_parts.append(f"### {name}\\n\\n_(conversion failed: {e})_")\n'
            '        if doc_parts:\n'
            '            user_prompt = (\n'
            '                "## Attached Documents\\n\\n"\n'
            '                + "\\n\\n---\\n\\n".join(doc_parts)\n'
            '                + "\\n\\n---\\n\\n"\n'
            '                + user_prompt\n'
            '            )\n'
            '    print(f"[workflow] {WORKFLOW_NAME} starting", flush=True)\n'
            '    print(f"[workflow] prompt: {user_prompt[:200]!r}", flush=True)\n'
            '    session_service = InMemorySessionService()\n'
            '    runner = Runner(agent=root_agent, app_name="workflow", session_service=session_service)\n'
            '    session = await session_service.create_session(app_name="workflow", user_id="local", state={})\n'
            '    final = ""\n'
            '    t0 = time.monotonic()\n'
            '    seen = set()\n'
            '    _t_first, _t_last = {}, {}  # per-node timing for the RUN SUMMARY\n'
            '    content = types.Content(role="user", parts=[types.Part(text=user_prompt)])\n'
            '    try:\n'
            '        async for event in runner.run_async(user_id="local", session_id=session.id, new_message=content):\n'
            '            author = getattr(event, "author", "?")\n'
            '            if isinstance(author, str) and author.startswith("node_"):\n'
            '                _nk = author.split("_")[1] if "_" in author else author\n'
            '                _t_first.setdefault(_nk, time.monotonic())\n'
            '                _t_last[_nk] = time.monotonic()\n'
            '            if author and author not in seen:\n'
            '                seen.add(author)\n'
            '                if isinstance(author, str) and author.startswith("node_"):\n'
            '                    _ap = author.split("_")\n'
            '                    _nid = _ap[1] if len(_ap) > 1 else author\n'
            '                    _kind = "skill step" if "skill" in author else "agent"\n'
            '                    print(f"[node {_nid}] {NODE_NAMES.get(_nid, _nid)!r} \\u2192 {_kind} active", flush=True)\n'
            '                else:\n'
            '                    print(f"[node] > {author}", flush=True)\n'
            '            parts = (event.content.parts if event.content else None) or []\n'
            '            for p in parts:\n'
            '                fc = getattr(p, "function_call", None)\n'
            '                fr = getattr(p, "function_response", None)\n'
            '                if fc is not None:\n'
            '                    _a = str(getattr(fc, "args", ""))[:200]\n'
            '                    print(f"[tool] -> {fc.name}({_a})", flush=True)\n'
            '                elif fr is not None:\n'
            '                    _r = str(getattr(fr, "response", ""))[:200]\n'
            '                    print(f"[tool] <- {fr.name}: {_r}", flush=True)\n'
            '                else:\n'
            '                    txt = (getattr(p, "text", None) or "").strip()\n'
            '                    if txt:\n'
            '                        print(f"[{author}] {txt[:240]}", flush=True)\n'
            '            if event.is_final_response() and event.content and event.content.parts:\n'
            '                final = event.content.parts[0].text or final\n'
            '        print(f"[workflow] done in {time.monotonic() - t0:.1f}s, {len(final)} chars", flush=True)\n'
            '    except Exception:\n'
            '        print("[workflow] ERROR:", flush=True)\n'
            '        traceback.print_exc()\n'
            '        raise\n'
            '    import re as _re\n'
            '    _mm = _re.search(r"(?is)<!doctype html.*?</html\\s*>", final) or _re.search(r"(?is)<html[\\s>].*?</html\\s*>", final)\n'
            '    if _mm:\n'
            '        final = _mm.group(0)  # strip narration/fences around a full HTML doc\n'
            '        _ext = "html"\n'
            '    else:\n'
            '        _ext = "md"\n'
            '    _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"\n'
            '    _ts = time.strftime("%Y%m%d-%H%M%S")\n'
            "    # Honour the Output node's storage setting: when ON, persist the final result\n"
            "    # where the app stores it (~/Documents/synergyAI/outputs/workflow/ by default,\n"
            "    # overridable via SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, skip.\n"
            '    _saved_path = None\n'
            '    if OUTPUT_STORAGE_ENABLED:\n'
            '        _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")\n'
            '        if OUTPUT_FOLDER:\n'
            '            _cf = os.path.expanduser(OUTPUT_FOLDER)\n'
            '            _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)\n'
            '        else:\n'
            '            _save_dir = os.path.join(_root, "workflow")\n'
            '        os.makedirs(_save_dir, exist_ok=True)\n'
            '        _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")\n'
            '        with open(_out, "w", encoding="utf-8") as _f:\n'
            '            _f.write(final)\n'
            '        _saved_path = os.path.abspath(_out)\n'
            '    print(final)\n'
            '    # Closing RUN SUMMARY (printed LAST): time per node, total, document location.\n'
            '    print("\\n" + "=" * 74, flush=True)\n'
            '    print("RUN SUMMARY", flush=True)\n'
            '    print("-" * 74, flush=True)\n'
            '    # Only named agent nodes (skip output pass-throughs: ~0s, no display name).\n'
            '    _durs = {NODE_NAMES[k]: _t_last[k] - _t_first[k] for k in _t_first if k in _t_last and k in NODE_NAMES}\n'
            '    if _durs:\n'
            '        _w = max(len(n) for n in _durs)\n'
            '        print("  Time per node:", flush=True)\n'
            '        for _n, _s in sorted(_durs.items(), key=lambda kv: -kv[1]):\n'
            '            print(f"    {_n:<{_w}}   {_s:7.1f}s", flush=True)\n'
            '    print(f"  Total wall-clock: {time.monotonic() - t0:.1f}s", flush=True)\n'
            '    print(f"  Final output: {len(final)} chars", flush=True)\n'
            '    if _saved_path:\n'
            '        print(f"  Document saved to: {_saved_path}", flush=True)\n'
            '    else:\n'
            '        print("  Document not saved (output storage is OFF in the workflow settings) -- "\n'
            '              "the output is printed above.", flush=True)\n'
            '    print("=" * 74, flush=True)\n'
            '    return final\n'
            '\n'
            'if __name__ == "__main__":\n'
            '    # Join ALL argv (a prompt is one string even with spaces) -- the runner\n'
            '    # passes it space-split; sys.argv[1] alone would keep only the first word.\n'
            '    asyncio.run(main(" ".join(sys.argv[1:]) if len(sys.argv) > 1 else ' + sp + '))'
        )

    @staticmethod
    def _adkToolBuilderBlock(analyzed: dict) -> str:
        """PHP 1048-1202."""
        functions: list[str] = []
        catalogEntries: list[str] = []

        for toolName, spec in analyzed['usedCatalog'].items():
            description = php_strval(_coalesce(spec.get('description'), toolName))
            inputSchema = spec.get('input_schema') if isinstance(spec.get('input_schema'), dict) else {}
            properties = inputSchema.get('properties') if isinstance(inputSchema.get('properties'), dict) else {}
            required = inputSchema.get('required') if isinstance(inputSchema.get('required'), list) else []
            serverUrl = php_strval(_coalesce(spec.get('server_url'), ''))

            safeName = _NON_IDENT_RE.sub('_', toolName)
            if _LEADING_DIGIT_RE.match(safeName):
                safeName = '_' + safeName
            fnName = '_tool_' + safeName

            requiredSet = set(php_strval(r) for r in required)

            validRequired: dict[str, dict] = {}
            validOptional: dict[str, dict] = {}
            hasExtra = False

            for pname in required:
                pname = php_strval(pname)
                if pname not in properties:
                    continue
                if _IDENT_RE.match(pname) and pname not in _PY_KEYWORDS:
                    validRequired[pname] = properties[pname] if isinstance(properties[pname], dict) else {}
                else:
                    hasExtra = True

            for pname, pspec in properties.items():
                pname = php_strval(pname)
                if pname in requiredSet:
                    continue
                if _IDENT_RE.match(pname) and pname not in _PY_KEYWORDS:
                    validOptional[pname] = pspec if isinstance(pspec, dict) else {}
                else:
                    hasExtra = True

            params: list[str] = []
            for pname, pspec in validRequired.items():
                ptype = _TYPE_MAP.get(pspec.get('type'), 'str')
                params.append(pname + ': ' + ptype)
            for pname, pspec in validOptional.items():
                ptype = _TYPE_MAP.get(pspec.get('type'), 'str')
                params.append(pname + ': ' + ptype + ' = None')
            if hasExtra:
                params.append('**extra')

            paramStr = ', '.join(params)
            allValidProps: dict[str, dict] = {**validRequired, **validOptional}

            safeDesc = description.replace('"""', '\\"\\"\\"')
            doc = '    """' + safeDesc
            if allValidProps:
                doc += '\n\n    Args:'
                for pname, pspec in allValidProps.items():
                    pDesc = php_strval(_coalesce(pspec.get('description'), ''))
                    doc += '\n        ' + pname + ': ' + pDesc
            doc += '\n    """'

            pyUrl = PythonEmitHelpers.pyStr(serverUrl)
            pyName = PythonEmitHelpers.pyStr(toolName)

            if allValidProps or hasExtra:
                argPairs = ['"' + pname + '": ' + pname for pname in allValidProps]
                if hasExtra:
                    innerDict = '{' + ', '.join(argPairs) + '}'
                    argDict = '{**' + innerDict + ', **extra}'
                else:
                    argDict = '{' + ', '.join(argPairs) + '}'
                body = '    _args = {k: v for k, v in ' + argDict + '.items() if v is not None}\n'
                body += '    return _call_mcp_tool(' + pyUrl + ', ' + pyName + ', _args)'
            else:
                body = '    return _call_mcp_tool(' + pyUrl + ', ' + pyName + ', {})'

            functions.append('def ' + fnName + '(' + paramStr + ') -> str:\n' + doc + '\n' + body)
            pyToolName = PythonEmitHelpers.pyStr(toolName)
            catalogEntries.append('        ' + pyToolName + ': FunctionTool(' + fnName + ')')

        out = ''
        if functions:
            out += '\n\n'.join(functions) + '\n\n'

        if catalogEntries:
            out += 'def build_tools_from_catalog() -> dict:\n'
            out += '    return {\n'
            out += ',\n'.join(catalogEntries) + ',\n'
            out += '    }'
        else:
            out += 'def build_tools_from_catalog() -> dict:\n'
            out += '    return {}'

        return out
