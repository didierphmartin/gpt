import { sql } from 'kysely';
import { db } from '../db/pools';
import { WorkflowRepository, WorkflowGraphRepository, phpIntval } from './WorkflowRepository';
import { AgentRepository, agentToArray } from './AgentRepository';
import { WorkflowGraphAnalyzer } from './WorkflowGraphAnalyzer';
import {
  jsonToPython as sharedJsonToPython,
  pyStr,
  mcpClientBlock,
  skillDepsBlock,
  skillFsSyncBlock,
  documentConverterBlock,
} from './pythonEmitHelpers';
import { stateBlock, datetimeInjectorBlock, contextBuilderBlock, parentsChildrenBlock, runHeaderBlock } from './pyBlocks';

/**
 * LangGraph Generator — faithful TypeScript mirror of
 * src/AgentTeam/Services/LangGraphGenerator.php.
 *
 * Generates a standalone Python LangGraph script from a saved workflow. The
 * output is intended to be BYTE-FOR-BYTE identical to the PHP generator's
 * output (the PHP itself mirrors langchain_runner/code_generator.py).
 *
 * Byte-fidelity notes:
 *  - Static Python code blocks shared with ADK/MAF (MCP client, document converter, skill-deps
 *    install, skill filesystem sync) come from pythonEmitHelpers.ts (byte-verified vs PHP's
 *    PythonEmitHelpers.php in task 9). LangGraph-only blocks (state/datetime/context-builder/
 *    parents-children/run-header) live in pyBlocks.ts. The LangGraph-specific skill-step pipeline
 *    (RUN_SKILL_SCRIPT_TOOL/_run_skill_step) and the __main__ body (TOOL_BUILDER_PART_A/
 *    TOOL_BUILDER_LG_SPECIFIC/RUN_BODY_BLOCK below) are extracted verbatim from the PHP nowdoc
 *    <<<'PY' heredocs (each ends in exactly one '\n') directly into this file.
 *  - Graph topology (byId/order/edges/startNodeId) comes from the shared, byte-verified
 *    WorkflowGraphAnalyzer.analyzeGraph() rather than a local topoOrder() re-implementation.
 *  - Prompt wrapping is done in the BYTE domain (PHP strlen/wordwrap operate on
 *    bytes), so the result `code` is a Buffer.
 *  - json_encode is emulated to match PHP's JSON_UNESCAPED_SLASHES |
 *    JSON_UNESCAPED_UNICODE (plus PHP always escaping U+2028/U+2029).
 */

// ---------- byte / php helpers ----------

const NL = Buffer.from('\n');

/**
 * PHP always escapes U+2028 / U+2029 even with JSON_UNESCAPED_UNICODE; JS does not.
 *
 * Float precision note: PythonEmitHelpers::jsonToPython() (and every real PHP generator caller)
 * forces ini_set('serialize_precision', '-1') at the top of generate() -- shortest-round-trip
 * float formatting, exactly what JS's native JSON.stringify already produces. So no BigInt /
 * exact-decimal-expansion machinery is needed here; see pythonEmitHelpers.ts's header and the
 * task-9 report for the verified evidence (an earlier draft of this file implemented that
 * unnecessarily -- removed now that this generator imports the shared, verified module).
 */
function fixSep(s: string): string {
  return s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * PHP json_encode(..., JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), compact -- no pretty
 * print, no true/false/null -> True/False/None conversion. Matches the PHP call sites that use
 * plain json_encode() rather than PythonEmitHelpers::jsonToPython() (tool_names/display/provider/
 * model/temperature/skills in the AGENTS dict) -- none of those values contain JSON booleans, so
 * no Python-literal conversion is needed for them.
 */
function jsonEncode(v: any): string {
  return fixSep(JSON.stringify(v));
}

/** PythonEmitHelpers::jsonToPython($value, $forceObject) -- pretty-printed, True/False/None. */
function jsonToPython(value: any, forceObject = false): string {
  return sharedJsonToPython(value, forceObject);
}

/** Mirror json_decode($s,true) then json_encode: empty objects collapse to []. */
function phpAssocReencode(x: any): any {
  if (Array.isArray(x)) return x.map(phpAssocReencode);
  if (x !== null && typeof x === 'object') {
    const keys = Object.keys(x);
    if (keys.length === 0) return [];
    const o: any = {};
    for (const k of keys) o[k] = phpAssocReencode(x[k]);
    return o;
  }
  return x;
}

const PHP_WS = /[ \t\n\r\0\x0B]/;
function phpRtrim(s: string): string {
  let end = s.length;
  while (end > 0 && PHP_WS.test(s[end - 1])) end--;
  return s.slice(0, end);
}
function phpTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PHP_WS.test(s[start])) start++;
  while (end > start && PHP_WS.test(s[end - 1])) end--;
  return s.slice(start, end);
}

/** PHP (float) cast: parse leading numeric, else 0. */
function phpFloatval(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return 0;
  const m = String(v).match(/^[ \t\n\r\v\f]*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/);
  return m ? parseFloat(m[0]) : 0;
}

/** PHP empty() for arrays/strings (used for the few empty() checks here). */
function isEmpty(v: any): boolean {
  if (v === undefined || v === null) return false ? false : true;
  if (v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// ---------- byte-domain wordwrap (matches PHP byte-based wordwrap) ----------

function splitBuffer(buf: Buffer, delim: number): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === delim) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  parts.push(buf.subarray(start));
  return parts;
}

/** Faithful port of PHP wordwrap(text, width, "\n", cut=true) operating on bytes. */
function phpWordwrapBytes(buf: Buffer, width: number, cut: boolean): Buffer {
  const out: number[] = [];
  let laststart = 0;
  let lastspace = 0;
  const BRK = 0x0a;
  const SP = 0x20;
  for (let current = 0; current < buf.length; current++) {
    const ch = buf[current];
    if (ch === BRK) {
      out.push(BRK);
      laststart = lastspace = out.length;
    } else if (ch === SP) {
      if (out.length - laststart >= width) {
        out.push(BRK);
        laststart = lastspace = out.length;
      } else {
        out.push(SP);
        lastspace = out.length - 1;
      }
    } else if (out.length - laststart >= width && cut && laststart >= lastspace) {
      out.push(BRK);
      laststart = lastspace = out.length;
      out.push(ch);
    } else if (out.length - laststart >= width && laststart < lastspace) {
      out[lastspace] = BRK;
      laststart = lastspace + 1;
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  return Buffer.from(out);
}

/** Escape a prompt for a triple-quoted Python string: '\\'->'\\\\', '"""'->'\"\"\"'. */
function escapePrompt(s: string): string {
  return s.split('\\').join('\\\\').split('"""').join('\\"\\"\\"');
}

/** Mirror the per-line strlen<=80 ? line : wordwrap(line,80) logic, on bytes. Returns Buffers. */
function wrapPromptToBuffers(escaped: string): Buffer[] {
  const buf = Buffer.from(escaped, 'utf8');
  const segs = splitBuffer(buf, 0x0a);
  return segs.map((seg) => (seg.length <= 80 ? seg : phpWordwrapBytes(seg, 80, true)));
}

// ---------- node helpers ----------

function asObj(v: any): any {
  return v !== null && typeof v === 'object' ? v : {};
}

function nodeType(n: any): string {
  const cfg = asObj(n.config);
  return String(n.node_type ?? n.type ?? (cfg.type ?? '') ?? '');
}

function nodeId(n: any): string {
  return String(n.id ?? n.drawflow_node_id ?? (n._id ?? ''));
}

function edgeFrom(e: any): string {
  return String(e.from_node_id ?? e.from ?? (e.source ?? ''));
}

function edgeTo(e: any): string {
  return String(e.to_node_id ?? e.to ?? (e.target ?? ''));
}

function displayName(node: any): string {
  const cfg = asObj(node.config);
  const name = cfg.agent_name ?? cfg.name ?? (node.name ?? null);
  if (name !== null && name !== undefined && name !== '') return String(name);
  return 'node_' + nodeId(node);
}

/**
 * PHP ctype_alnum() per-byte classification on the LIVE server (Apache) under the C locale:
 * ASCII-only. Every byte that is not ASCII [0-9A-Za-z] is non-alnum — so all UTF-8 high bytes
 * (e.g. 0xC3/0xE2 lead/continuation bytes of accented letters, em-dashes, middots) classify as
 * non-alnum and safeVar() maps each to '_'. (Earlier code kept Latin-1 lead bytes from a
 * C.UTF-8 CLI probe; the live Apache server uses the C locale, so that table was wrong.)
 */
function isPhpAlnumByte(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
}

/**
 * PHP (current): `strtolower(trim(preg_replace('/[^A-Za-z0-9]+/', '_', $name) ?? '', '_'))`.
 * The `+` quantifier COLLAPSES each run of consecutive non-alnum BYTES (which, for any
 * multi-byte UTF-8 character such as an em-dash, are all its bytes at once) into a SINGLE '_' --
 * this replaced an older byte-by-byte ctype_alnum() loop that mapped every non-alnum byte to its
 * own '_' (producing e.g. three underscores for one em-dash), which "kept a stray lead byte of a
 * multibyte char... producing invalid UTF-8 that broke py_compile of the emitted script" (PHP
 * source comment). Ported here as byte-domain run-collapsing to match exactly, including for
 * multi-byte UTF-8 sequences.
 */
function safeVar(name: string): string {
  const bytes = Buffer.from(name, 'utf8');
  const out: number[] = [];
  let inRun = false;
  for (const b of bytes) {
    if (isPhpAlnumByte(b)) {
      out.push(b);
      inRun = false;
    } else if (!inRun) {
      out.push(0x5f); // 0x5f = '_'
      inRun = true;
    }
  }
  // trim leading/trailing '_' (byte 0x5f)
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === 0x5f) start++;
  while (end > start && out[end - 1] === 0x5f) end--;
  const trimmed = Buffer.from(out.slice(start, end));
  // strtolower: ASCII A-Z only (PHP strtolower is byte-wise ASCII; high bytes unchanged).
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] >= 65 && trimmed[i] <= 90) trimmed[i] += 32;
  }
  return trimmed.toString('latin1');
}

function pythonListRepr(items: string[]): string {
  const parts = items.map((s) => "'" + String(s).split('\\').join('\\\\').split("'").join("\\'") + "'");
  return '[' + parts.join(', ') + ']';
}

function extractToolNames(raw: any[]): string[] {
  const out: string[] = [];
  for (const tool of raw) {
    let tname: any = null;
    if (typeof tool === 'string') tname = tool;
    else if (tool !== null && typeof tool === 'object') tname = tool.name ?? tool.tool_name ?? null;
    if (tname) {
      if (String(tname).indexOf('mcp_') === 0) tname = String(tname).substring(4);
      out.push(tname);
    }
  }
  return out;
}

interface AgentDatum {
  display: string;
  system_prompt: string;
  tool_names: string[];
  provider: string;
  model: string;
  temperature: number;
  max_tokens: number;
  skills: Array<Record<string, string>>;
}

export interface GenerateResult {
  filename: string;
  code: Buffer;
}


// ---------- LangGraph-specific skill pipeline blocks (verbatim from PHP LangGraphGenerator.php) ----------

/**
 * PHP: LangGraphGenerator::toolBuilderBlock()'s $partA -- _summarize_tool_result +
 * build_tools_from_catalog(). Concatenated with pythonEmitHelpers' skillDepsBlock() +
 * skillFsSyncBlock() + TOOL_BUILDER_LG_SPECIFIC below to reproduce toolBuilderBlock() exactly
 * (PHP: `$partA . PythonEmitHelpers::skillDepsBlock() . PythonEmitHelpers::skillFsSyncBlock() . $lgSpecific`).
 */
const TOOL_BUILDER_PART_A: string = "def _summarize_tool_result(result: str) -> str:\n    \"\"\"Short, informative summary of a tool result for logs.\n\n    Parses JSON when possible and surfaces the most useful fields\n    (article count + first PMIDs, error message, query text, etc.)\n    so the log shows *what* came back, not just the raw first 120 chars.\n    \"\"\"\n    try:\n        parsed = json.loads(result)\n    except Exception:\n        s = result.strip().replace(\"\\n\", \" \")\n        return s[:160] + (\" ...\" if len(s) > 160 else \"\")\n    if isinstance(parsed, dict):\n        if \"error\" in parsed:\n            return f\"error: {str(parsed['error'])[:200]}\"\n        if isinstance(parsed.get(\"articles\"), list):\n            arts = parsed[\"articles\"]\n            pmids = [str(a.get(\"pmid\", \"?\")) for a in arts[:5] if isinstance(a, dict)]\n            more = \"\" if len(arts) <= 5 else f\", +{len(arts) - 5} more\"\n            return f\"{len(arts)} articles (PMIDs: {', '.join(pmids)}{more})\"\n        if isinstance(parsed.get(\"suggestions\"), list):\n            return f\"{len(parsed['suggestions'])} suggestions\"\n        if isinstance(parsed.get(\"query\"), str):\n            q = parsed[\"query\"]\n            return f\"query: {q[:200]}\" + (\" ...\" if len(q) > 200 else \"\")\n        if isinstance(parsed.get(\"items\"), list):\n            return f\"{len(parsed['items'])} items\"\n        keys = \", \".join(list(parsed.keys())[:6])\n        return f\"keys: {keys}\"\n    if isinstance(parsed, list):\n        return f\"list of {len(parsed)} items\"\n    s = str(parsed)\n    return s[:160] + (\" ...\" if len(s) > 160 else \"\")\n\n\ndef build_tools_from_catalog() -> dict[str, StructuredTool]:\n    \"\"\"Build LangChain StructuredTool wrappers from TOOL_CATALOG.\n\n    For each tool:\n    1. Parse the JSON Schema into a Pydantic model (for LLM argument validation)\n    2. Create a callable that sends the MCP JSON-RPC request\n    3. Wrap both into a LangChain StructuredTool\n\n    Returns: dict mapping tool_name -> StructuredTool\n    \"\"\"\n    type_map = {\"string\": str, \"integer\": int, \"number\": float,\n                \"boolean\": bool, \"array\": list, \"object\": dict}\n    catalog = {}\n    for name, info in TOOL_CATALOG.items():\n        schema = info.get(\"input_schema\") or {}\n        props = schema.get(\"properties\", {}) if isinstance(schema, dict) else {}\n        required = set(schema.get(\"required\", []) if isinstance(schema, dict) else [])\n        fields = {}\n        for pname, pspec in props.items():\n            spec = pspec if isinstance(pspec, dict) else {}\n            ptype = type_map.get(spec.get(\"type\", \"string\"), str)\n            default = ... if pname in required else None\n            fields[pname] = (ptype, Field(default, description=spec.get(\"description\", \"\")))\n        args_model = create_model(f\"{name}Args\", **fields) if fields else create_model(f\"{name}Args\")\n\n        server_url = info[\"server_url\"]\n        def make_fn(n=name, s=server_url):\n            def invoke(**kwargs):\n                argv = json.dumps(kwargs, default=str)\n                argv_preview = argv if len(argv) <= 250 else argv[:250] + f\" ... +{len(argv) - 250} chars\"\n                print(f\"  [tool] -> {n}({argv_preview})\")\n                t0 = time.monotonic()\n                result = _call_mcp_tool(s, n, kwargs)\n                dt = time.monotonic() - t0\n                summary = _summarize_tool_result(result)\n                print(f\"  [tool] ← {n}: {summary} ({len(result)} chars, {dt:.1f}s)\")\n                return result\n            return invoke\n\n        catalog[name] = StructuredTool.from_function(\n            func=make_fn(),\n            name=name,\n            description=info.get(\"description\") or f\"MCP tool {name}\",\n            args_schema=args_model,\n        )\n    return catalog\n\n\n";

/**
 * PHP: LangGraphGenerator::toolBuilderBlock()'s $lgSpecific -- RUN_SKILL_SCRIPT_TOOL,
 * _make_skill_tool, and _run_skill_step (the mandatory post-agent skill-step runner).
 * LangGraph-specific (uses StructuredTool/create_model), so it is NOT in the shared
 * pythonEmitHelpers module.
 */
const TOOL_BUILDER_LG_SPECIFIC: string = "\n\nRUN_SKILL_SCRIPT_TOOL = StructuredTool.from_function(\n    func=_run_skill_script,\n    name=\"run_skill_script\",\n    description=(\"Execute a folder-backed skill's Python script and return its \"\n                 \"stdout. Pass the dir_name/script/argv the skill instructions \"\n                 \"specify, e.g. dir_name='GEO/geo-llmstxt', \"\n                 \"script='scripts/llmstxt_signals.py', argv=['https://example.com'].\"),\n    args_schema=create_model(\n        \"RunSkillScriptArgs\",\n        dir_name=(str, ...),\n        script=(str, ...),\n        # list[str] (not bare list) so the generated JSON schema carries\n        # `items`. Gemini rejects array params without `items` (400\n        # INVALID_ARGUMENT); list[str] is valid for every provider. Leave\n        # input_files as a bare dict — Gemini accepted that, and dict[str,str]\n        # would add additionalProperties which Gemini may reject.\n        argv=(list[str], []),\n        input_files=(dict, {}),\n        read_outputs=(list[str], []),\n    ),\n)\n\n\ndef _make_skill_tool(dir_name: str):\n    \"\"\"run_skill_script scoped to ONE skill dir: the model picks only the script + argv\n    (and input_files/read_outputs); the dir is fixed to this skill.\"\"\"\n    def run_skill_script(script: str, argv=None, input_files=None, read_outputs=None) -> str:\n        return _run_skill_script(dir_name, script, argv, input_files, read_outputs)\n    return StructuredTool.from_function(\n        func=run_skill_script, name=\"run_skill_script\",\n        description=(f\"Run a script in the '{dir_name}' skill (dir fixed). Stage authored \"\n                     \"content via input_files and pass the output path in read_outputs.\"),\n        args_schema=create_model(\n            \"ScopedSkillArgs\",\n            script=(str, ...), argv=(list[str], []),\n            input_files=(dict, {}), read_outputs=(list[str], []),\n        ),\n    )\n\n\nasync def _run_skill_step(skill, prior, llm):\n    \"\"\"Run ONE skill as a mandatory step on `prior` (the previous stage's output). A\n    dir-backed skill = an LLM turn instructed by SKILL.md with run_skill_script scoped to\n    the dir; the step output becomes the skill's produced deliverable file (via\n    read_outputs) when it wrote one, else the LLM's text. Inline skill = an LLM transform.\"\"\"\n    dir_name = skill.get(\"dir\", \"\")\n    body = skill.get(\"inline\") or (_read_skill_md(dir_name) if dir_name else \"\")\n    system = (\n        \"You are running the '\" + (dir_name or \"inline\") + \"' skill as a MANDATORY step in \"\n        \"a compiled workflow. Follow the skill instructions below and APPLY THE SKILL to the \"\n        \"INPUT. If the skill produces a document/file (e.g. an HTML report via a create/\"\n        \"render script), you MUST call run_skill_script -- stage your authored content via \"\n        \"input_files and pass the output path in read_outputs; the workflow captures that \"\n        \"produced file as this node's output. If the skill has no script, return the \"\n        \"transformed result as your response.\\n\\n=== SKILL INSTRUCTIONS ===\\n\" + body\n    )\n    tools = [_make_skill_tool(dir_name)] if dir_name else []\n    if dir_name:\n        _LAST_SKILL_OUTPUTS.pop(dir_name, None)\n    agent = create_react_agent(llm, tools)\n    msgs = [SystemMessage(content=system),\n            HumanMessage(content=\"## INPUT (apply the skill to this)\\n\" + str(prior))]\n    result = await agent.ainvoke({\"messages\": msgs})\n    final = result[\"messages\"][-1]\n    text = final.content if isinstance(final, AIMessage) else str(final)\n    if isinstance(text, list):\n        text = \"\".join(b.get(\"text\", \"\") for b in text if isinstance(b, dict))\n    produced = _LAST_SKILL_OUTPUTS.pop(dir_name, None) if dir_name else None\n    return produced[-1] if produced else text\n";

/**
 * PHP: LangGraphGenerator::runBodyBlock(). Verbatim port including the mandatory
 * per-skill run loop (`for _skill in ad.get("skills", [])`) and the __main__ inline
 * <!doctype html>...</html> extraction + OUTPUT_STORAGE_ENABLED/OUTPUT_FOLDER handling
 * (replaces the old `from script_io import write_output` external-helper approach).
 */
const RUN_BODY_BLOCK: string = "    # One LLM instance per agent — provider/model come from the AGENTS\n    # dict, which the generator baked from each agent's workflow config.\n    # Built eagerly (not per-call) so we fail fast on missing API keys.\n    LLMS = {\n        nid: _make_llm(\n            ad.get(\"provider\", \"claude\"),\n            ad.get(\"model\", \"\"),\n            float(ad.get(\"temperature\", 0.7)),\n            int(ad.get(\"max_tokens\", 4096)),\n        )\n        for nid, ad in AGENTS.items()\n    }\n    sg = StateGraph(WFState)\n\n    for nid in ORDER:\n        ntype = NODE_TYPES.get(nid, \"\")\n\n        if ntype == \"start\":\n            def make_start(n=nid):\n                def _run(state):\n                    text = state.get(\"user_prompt\", \"\")\n                    if START_DOCUMENTS:\n                        doc_parts = []\n                        for doc in START_DOCUMENTS:\n                            name = doc.get(\"name\", \"Document\")\n                            path = doc.get(\"path\", \"\")\n                            if not path:\n                                doc_parts.append(f\"### {name}\\n\\n_(no path on attachment record)_\")\n                                continue\n                            try:\n                                md = _convert_doc_to_markdown(path)\n                                doc_parts.append(f\"### {name}\\n\\n{md}\")\n                            except Exception as e:\n                                doc_parts.append(f\"### {name}\\n\\n_(conversion failed: {e})_\")\n                        if doc_parts:\n                            text = (\n                                \"## Attached Documents\\n\\n\"\n                                + \"\\n\\n---\\n\\n\".join(doc_parts)\n                                + \"\\n\\n---\\n\\n\"\n                                + text\n                            )\n                    print(f\"[node] [{n}] start -- {len(text)} chars\")\n                    return {\"node_outputs\": {n: {\"source\": \"start\", \"text\": text}}}\n                return _run\n            sg.add_node(nid, make_start())\n\n        elif ntype in (\"agent\", \"agent-template\"):\n            def make_agent(n=nid):\n                async def _run(state):\n                    from pathlib import Path\n                    from datetime import datetime as _dt\n                    ad = AGENTS[n]\n                    tool_names = ad[\"tool_names\"]\n                    tools = [catalog[t] for t in tool_names if t in catalog]\n                    print(f\"[node] [{n}] {ad['display']!r} -- {len(tools)} tools \"\n                          f\"(provider={ad.get('provider', '?')}, model={ad.get('model', '?')})\")\n\n                    ctx = build_context(state.get(\"user_prompt\", \"\"), parents(n), state.get(\"node_outputs\", {}))\n                    sys_chars = len(ad[\"system_prompt\"]) if ad.get(\"system_prompt\") else 0\n                    print(f\"[node] [{n}] inputs: system={sys_chars} chars, context={len(ctx)} chars\", flush=True)\n\n                    msgs = []\n                    if ad[\"system_prompt\"]:\n                        msgs.append(SystemMessage(content=inject_datetime(ad[\"system_prompt\"])))\n                    msgs.append(HumanMessage(content=ctx))\n\n                    # Per-agent LLM. Each agent uses the provider/model\n                    # it was configured with in the workflow editor.\n                    agent = create_react_agent(LLMS[n], tools)\n                    t0 = time.monotonic()\n                    result = await agent.ainvoke({\"messages\": msgs})\n                    dt = time.monotonic() - t0\n\n                    final = result[\"messages\"][-1]\n                    text = final.content if isinstance(final, AIMessage) else str(final)\n                    if isinstance(text, list):\n                        text = \"\".join(b.get(\"text\", \"\") for b in text if isinstance(b, dict))\n\n                    msgs_out = result.get(\"messages\", [])\n                    llm_rounds = sum(1 for m in msgs_out if isinstance(m, AIMessage))\n                    tool_results = sum(\n                        1 for m in msgs_out\n                        if getattr(m, \"type\", None) == \"tool\"\n                        or m.__class__.__name__ == \"ToolMessage\"\n                    )\n                    print(f\"[node] [{n}] done -- {len(text)} chars \"\n                          f\"({llm_rounds} LLM rounds, {tool_results} tool results, {dt:.1f}s)\")\n                    # Preview of what the agent produced, so the log shows the\n                    # actual answer without opening the _debug dump.\n                    print(f\"[node] [{n}] output head: {text[:240]!r}\", flush=True)\n                    # High-signal red flag: a tool-bound agent that ran ZERO\n                    # tools almost certainly fabricated its answer (the exact\n                    # failure that produced \"Missing /llms.txt\"). Surface it.\n                    if tools and tool_results == 0:\n                        print(f\"[node] [{n}] ⚠ answered with 0 tool calls despite \"\n                              f\"{len(tools)} tool(s) available — likely fabricated; \"\n                              f\"check the skill ran\", flush=True)\n\n                    try:\n                        script_root = Path(__file__).resolve().parent.parent\n                        debug_dir = script_root / \"outputs\" / \"_debug\"\n                        debug_dir.mkdir(parents=True, exist_ok=True)\n                        ts = _dt.now().strftime(\"%Y%m%d-%H%M%S\")\n                        stem = Path(__file__).stem\n                        dump_path = debug_dir / f\"{stem}_{n}_{ts}.json\"\n                        entries = []\n                        for m in msgs_out:\n                            content = m.content\n                            if isinstance(content, list):\n                                content = [\n                                    (b if isinstance(b, dict) else {\"type\": \"text\", \"text\": str(b)})\n                                    for b in content\n                                ]\n                            entries.append({\n                                \"role\": m.__class__.__name__,\n                                \"content\": content,\n                                \"tool_calls\": getattr(m, \"tool_calls\", None),\n                                \"tool_call_id\": getattr(m, \"tool_call_id\", None),\n                                \"name\": getattr(m, \"name\", None),\n                            })\n                        dump_path.write_text(\n                            json.dumps(entries, default=str, indent=2, ensure_ascii=False),\n                            encoding=\"utf-8\",\n                        )\n                        print(f\"[debug] [{n}] message history → outputs/_debug/{dump_path.name}\")\n                    except Exception as e:\n                        print(f\"[debug] [{n}] failed to dump message history: {e}\")\n\n                    # Mandatory skill pipeline: each attached skill runs on the agent's\n                    # result in order; the last skill's produced deliverable (e.g. the html\n                    # skill's rendered HTML file) becomes this node's output.\n                    for _skill in ad.get(\"skills\", []):\n                        text = await _run_skill_step(_skill, text, LLMS[n])\n                        print(f\"[node] [{n}] after skill {_skill.get('dir') or 'inline'!r}: \"\n                              f\"{len(text)} chars\", flush=True)\n\n                    return {\"node_outputs\": {n: {\"source\": ad[\"display\"], \"text\": text}}}\n                return _run\n            sg.add_node(nid, make_agent())\n\n        elif ntype == \"output\":\n            def make_output(n=nid):\n                def _run(state):\n                    pids = parents(n)\n                    outs = state.get(\"node_outputs\", {})\n                    if len(pids) == 1 and pids[0] in outs:\n                        final = outs[pids[0]][\"text\"]\n                    else:\n                        blocks = [f\"## {outs[p]['source']}\\n\\n{outs[p]['text']}\" for p in pids if p in outs]\n                        final = \"\\n\\n---\\n\\n\".join(blocks)\n                    print(f\"[node] [{n}] output -- {len(final)} chars\")\n                    return {\"final_output\": final}\n                return _run\n            sg.add_node(nid, make_output())\n\n        else:\n            sg.add_node(nid, lambda s: {})\n\n    # Wire edges\n    pos = {n: i for i, n in enumerate(ORDER)}\n    sg.add_edge(START, ORDER[0])\n    for nid in ORDER:\n        for child in children(nid):\n            if child in pos and pos[child] > pos[nid]:\n                sg.add_edge(nid, child)\n    for nid in ORDER:\n        if not children(nid):\n            sg.add_edge(nid, END)\n\n    graph = sg.compile()\n    print(\"[info] Running...\")\n    result = await graph.ainvoke({\"user_prompt\": user_prompt, \"node_outputs\": {}})\n    return result.get(\"final_output\", \"\")\n\n\nif __name__ == \"__main__\":\n    prompt = \" \".join(sys.argv[1:]) or DEFAULT_PROMPT or \"Hello\"\n    print(f\"[info] Prompt: {prompt[:100]}{'...' if len(prompt) > 100 else ''}\")\n    output = asyncio.run(run(prompt))\n    print(\"\\n\" + \"=\" * 60)\n    print(\"FINAL OUTPUT\")\n    print(\"=\" * 60)\n    print(output)\n\n    # Honour the Output node's storage setting: when ON, save the final result where the\n    # app stores it (~/Documents/synergyAI/outputs/workflow/ by default, overridable via\n    # SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, don't save.\n    if OUTPUT_STORAGE_ENABLED:\n        try:\n            import os, time\n            import re as _re2\n            _mm = _re2.search(r\"(?is)<!doctype html.*?</html\\s*>\", output) or _re2.search(r\"(?is)<html[\\s>].*?</html\\s*>\", output)\n            if _mm:\n                output = _mm.group(0)  # strip narration/fences around a full HTML doc\n                _ext = \"html\"\n            else:\n                _ext = \"md\"\n            _slug = \"\".join(c if c.isalnum() else \"_\" for c in WORKFLOW_NAME).strip(\"_\")[:60] or \"workflow\"\n            _ts = time.strftime(\"%Y%m%d-%H%M%S\")\n            _root = os.environ.get(\"SYNERGYAI_OUTPUT_ROOT\") or os.path.expanduser(\"~/Documents/synergyAI/outputs\")\n            if OUTPUT_FOLDER:\n                _cf = os.path.expanduser(OUTPUT_FOLDER)\n                _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)\n            else:\n                _save_dir = os.path.join(_root, \"workflow\")\n            os.makedirs(_save_dir, exist_ok=True)\n            _out = os.path.join(_save_dir, f\"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}\")\n            with open(_out, \"w\", encoding=\"utf-8\") as _f:\n                _f.write(output)\n            print(f\"\\nResult saved to: {os.path.abspath(_out)}\")\n        except Exception as e:\n            print(f\"\\n[warn] failed to save result: {e}\")\n    else:\n        print(\"\\n[info] output storage is OFF -- result printed above, not saved\")\n";

export class LangGraphGenerator {
  protected workflowRepo: WorkflowRepository;
  protected graphRepo: WorkflowGraphRepository;
  protected agentRepo: AgentRepository;

  constructor(workflowRepo: WorkflowRepository, graphRepo: WorkflowGraphRepository, agentRepo: AgentRepository) {
    this.workflowRepo = workflowRepo;
    this.graphRepo = graphRepo;
    this.agentRepo = agentRepo;
  }

  /** Provider default models from system_llm_settings (lowercased provider_key -> model). */
  protected async loadProviderDefaults(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const rows = (
        await sql<any>`SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1`.execute(db)
      ).rows;
      for (const row of rows) {
        map.set(String(row.provider_key ?? '').toLowerCase(), String(row.model ?? ''));
      }
    } catch (_e) {
      // table missing/unreadable — fall through with empty map (matches PHP catch).
    }
    return map;
  }

  /** Fetch MCP tools with server info (url, name), matching list_mcp_tools_with_servers(). */
  protected async loadMcpToolsWithServers(): Promise<any[]> {
    const rows = (
      await sql<any>`
        SELECT t.*, s.name AS server_name, s.url AS server_url
        FROM mcp_server_tools t
        JOIN mcp_servers s ON t.server_id = s.id
        WHERE s.enabled = 1 AND s.user_id IS NULL`.execute(db)
    ).rows;

    const out: any[] = [];
    for (const row of rows) {
      const schemaRaw = row.input_schema ?? null;
      let schema: any = null;
      if (typeof schemaRaw === 'string') {
        if (schemaRaw !== '') {
          try {
            schema = JSON.parse(schemaRaw);
          } catch {
            schema = null;
          }
        }
      } else if (schemaRaw !== null && schemaRaw !== undefined) {
        schema = schemaRaw; // mysql2 already parsed the json column
      }
      row.input_schema = schema;
      out.push(row);
    }
    return out;
  }

  async generate(workflowId: number, _userId: string | null = null): Promise<GenerateResult> {
    const workflow = await this.workflowRepo.findById(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found.`);
    }
    const rawName = workflow.name;
    const wfName = rawName === '' || rawName === '0' || rawName == null ? 'workflow_' + workflowId : rawName;
    let safeName = safeVar(wfName);
    if (safeName === '') {
      safeName = 'workflow_' + workflowId;
    }

    const graph = await this.graphRepo.getGraph(workflowId);
    // Route pure graph analysis through the shared WorkflowGraphAnalyzer (byte-verified against
    // PHP in task 9): byId, order (Kahn topo), edges (normalised), startNodeId.
    const gdata = WorkflowGraphAnalyzer.analyzeGraph(graph);
    const byId: Record<string, any> = gdata.byId;
    const order: string[] = gdata.order;
    const startId = gdata.startNodeId;
    if (startId === '') {
      throw new Error('No start node found.');
    }
    // Normalised edges ({from, to}) are compatible with edgeFrom()/edgeTo().
    const edges: any[] = gdata.edges;
    const startNode = byId[startId];
    const startCfg = asObj(startNode.config ?? startNode.data ?? {});
    const startPrompt = startCfg.prompt === undefined || startCfg.prompt === null ? '' : String(startCfg.prompt);
    let startDocuments: any = startCfg.documents ?? [];
    if (startDocuments === null || typeof startDocuments !== 'object') startDocuments = [];

    const providerDefaults = await this.loadProviderDefaults();
    const mcpTools = await this.loadMcpToolsWithServers();

    // server registry + tool catalog (insertion order preserved by plain objects; keys are non-numeric).
    const serverRegistry: Record<string, any> = {};
    const toolCatalog: Record<string, any> = {};
    for (const t of mcpTools) {
      const surl = String(t.server_url ?? '');
      const sname = String(t.server_name ?? '');
      const tname = String(t.tool_name ?? t.name ?? '');
      if (surl === '' || tname === '') continue;
      if (!Object.prototype.hasOwnProperty.call(serverRegistry, surl)) {
        serverRegistry[surl] = { name: sname };
      }
      let desc = t.tool_description ?? t.description ?? '';
      if (desc === null || desc === undefined) desc = '';
      let schema = t.input_schema ?? null;
      if (schema === null || schema === undefined) schema = {};
      toolCatalog[tname] = { server_url: surl, description: desc, input_schema: schema };
    }

    // resolve agent data per agent node
    const agentData = new Map<string, AgentDatum>();
    const allNeededTools = new Map<string, boolean>();
    for (const nid of order) {
      const node = byId[nid];
      const ntype = nodeType(node);
      if (ntype !== 'agent' && ntype !== 'agent-template') continue;
      const cfg = asObj(node.config);
      const agentId = node.agent_id ?? cfg.agent_id ?? null;
      let systemPrompt = String(cfg.systemPrompt ?? cfg.instructions ?? '');

      let rawTools: any = cfg.selectedTools ?? cfg.tools ?? [];
      if (rawTools === null || typeof rawTools !== 'object') rawTools = [];
      const rawToolsArr = Array.isArray(rawTools) ? rawTools : Object.values(rawTools);
      let toolNames = extractToolNames(rawToolsArr);

      let agentProvider = '';
      let agentModel = '';
      if (agentId !== null && agentId !== '') {
        try {
          const agent = await this.agentRepo.findById(phpIntval(agentId));
          if (agent !== null) {
            const agentArr = agentToArray(agent);
            if (systemPrompt === '') {
              systemPrompt = String(
                agentArr.instructions ?? (agentArr as any).system_prompt ?? (agentArr as any).prompt ?? ''
              );
            }
            agentProvider = String(agentArr.provider ?? '');
            agentModel = String(agentArr.model ?? '');
            const agentTools = agentArr.tools ?? null;
            if (toolNames.length === 0 && agentTools !== null && typeof agentTools === 'object') {
              const toolsIter = Array.isArray(agentTools) ? agentTools : Object.values(agentTools);
              toolNames = toolNames.concat(extractToolNames(toolsIter));
            }
          }
        } catch (_e) {
          // swallow (matches PHP broad except).
        }
      }

      const nodeProvider = String(cfg.llm_provider ?? cfg.provider ?? cfg.agent_provider ?? '');
      const nodeModel = String(cfg.model ?? '');
      if (nodeProvider !== '') agentProvider = nodeProvider;
      if (nodeModel !== '') agentModel = nodeModel;
      if (agentProvider === '') agentProvider = 'claude';
      if (agentModel === '') agentModel = providerDefaults.get(agentProvider.toLowerCase()) ?? '';

      // Skills are mandatory POST-agent steps (not prompt text, not an optional tool): the main
      // agent runs, then each skill runs on its result and the last skill's produced deliverable
      // becomes the node output. Surface the ordered skill bindings; skill_content is NO LONGER
      // appended to the prompt. Mirrors ADK/PHP (bde5afb).
      const skills = WorkflowGraphAnalyzer.skillsFromConfig(cfg);

      const pl = systemPrompt.toLowerCase();
      const wantsHtml =
        pl.indexOf('output only the html') !== -1 ||
        pl.indexOf('production-quality html') !== -1 ||
        pl.indexOf('<!doctype') !== -1 ||
        (pl.indexOf('self-contained') !== -1 && pl.indexOf('<style') !== -1);
      // Only nudge the MAIN agent to emit HTML when the node has NO skill to render it. When a
      // skill (e.g. html) is attached, that skill step produces the HTML deliverable, so the main
      // agent should just write the report content.
      if (wantsHtml && skills.length === 0) {
        systemPrompt =
          phpRtrim(systemPrompt) +
          '\n\n## Output format (CRITICAL — read carefully)\n' +
          'Your FINAL message MUST be the complete, self-contained HTML ' +
          'document itself: start with `<!DOCTYPE html>` and end with ' +
          '`</html>`. Output ONLY the raw HTML — no Markdown, no triple-backtick ' +
          'code fences, no preamble, and no commentary before or after. Do NOT ' +
          'narrate what you are about to do; produce the HTML directly as your ' +
          'answer. The runtime saves your final message verbatim to an .html ' +
          'file, so anything that is not HTML breaks the deliverable.';
      }

      // Per-agent sampling/limits saved by the editor under `settings`. max_tokens comes from the
      // agent form VERBATIM -- no substitution. If a node's output truncates, raise it in that
      // node's form; the compiler never overrides a form-stated value.
      const cfgSettings = asObj(cfg.settings);
      const agentTemperature = phpFloatval(cfgSettings.temperature ?? 0.7);
      const agentMaxTokens = phpIntval(cfgSettings.max_tokens ?? 4096);

      // NOTE: the main agent NEVER gets run_skill_script -- skills run as separate mandatory
      // steps after it (see the skill loop in RUN_BODY_BLOCK's agent node function).

      for (const tn of toolNames) allNeededTools.set(tn, true);
      agentData.set(nid, {
        display: displayName(node),
        system_prompt: systemPrompt,
        tool_names: toolNames,
        provider: agentProvider.toLowerCase(),
        model: agentModel,
        temperature: agentTemperature,
        max_tokens: agentMaxTokens,
        skills,
      });
    }

    // filter catalog/servers to what's actually used
    const usedCatalog: Record<string, any> = {};
    for (const k of Object.keys(toolCatalog)) {
      if (allNeededTools.has(k)) usedCatalog[k] = toolCatalog[k];
    }
    const usedServers: Record<string, any> = {};
    for (const entry of Object.values(usedCatalog)) {
      const surl = entry.server_url ?? '';
      if (surl !== '' && Object.prototype.hasOwnProperty.call(serverRegistry, surl)) {
        usedServers[surl] = serverRegistry[surl];
      }
    }
    const missing: string[] = [];
    for (const tn of allNeededTools.keys()) {
      if (tn === 'run_skill_script') continue;
      if (!Object.prototype.hasOwnProperty.call(toolCatalog, tn)) missing.push(tn);
    }
    missing.sort(); // SORT_STRING (ASCII tool names — byte order == UTF-16 order)

    const edgeList: string[][] = [];
    for (const e of edges) edgeList.push([edgeFrom(e), edgeTo(e)]);

    // ---- emit ----
    const lines: Array<string | Buffer> = [];
    const push = (s: string | Buffer) => lines.push(s);

    const nodeDescs: string[] = [];
    for (const nid of order) {
      const node = byId[nid];
      const ntype = nodeType(node);
      const name = displayName(node);
      const ad = agentData.get(nid);
      if (ad) {
        const tc = ad.tool_names.length;
        nodeDescs.push(`  ${nid} (${ntype}): ${name} -- ${tc} tool(s)`);
      } else {
        nodeDescs.push(`  ${nid} (${ntype}): ${name}`);
      }
    }
    const edgeDescs: string[] = [];
    for (const e of edges) edgeDescs.push('  ' + edgeFrom(e) + ' -> ' + edgeTo(e));

    const sep = '# ' + '='.repeat(62);

    push('"""Standalone LangGraph workflow: ' + wfName);
    push('');
    push('Auto-generated -- backend-independent.');
    push('Connects directly to MCP servers via JSON-RPC 2.0 over HTTP.');
    push('');
    push('ARCHITECTURE');
    push('============');
    push('This script was generated from a visual workflow editor. It embeds:');
    push('  - Agent system prompts and tool assignments (AGENTS dict)');
    push('  - MCP server URLs and tool schemas (MCP_SERVERS, TOOL_CATALOG)');
    push('  - Graph structure as edges + topological order (EDGES, ORDER)');
    push('');
    push('At runtime it builds a LangGraph StateGraph where each workflow');
    push("node becomes a graph node. Agents use LangChain's ReAct pattern");
    push('(create_react_agent) which lets the LLM decide when to call tools.');
    push('');
    push('DATA FLOW');
    push('=========');
    push('1. Start node stores the user prompt in shared state');
    push('2. Each agent node receives labeled context from its direct');
    push('   upstream predecessors (not all prior nodes -- only edge parents)');
    push('3. The context message includes the original user prompt plus');
    push("   each predecessor's output under a ### header with source name");
    push("4. Output node collects its parents' outputs as final result");
    push('');
    push('GRAPH NODES');
    push('===========');
    for (const nd of nodeDescs) push(nd);
    push('');
    push('GRAPH EDGES');
    push('===========');
    for (const ed of edgeDescs) push(ed);
    push('');
    push('TOOL EXECUTION');
    push('==============');
    push('Tools are called via the MCP protocol (Model Context Protocol).');
    push('Each tool invocation:');
    push('  1. Opens a JSON-RPC 2.0 session with the MCP server (initialize)');
    push('  2. Sends a tools/call request with tool name + arguments');
    push('  3. Parses the response (JSON or SSE format)');
    push('  4. Returns the text content to the LLM agent');
    push('Server URLs and tool schemas are baked in at generation time.');
    push('');
    push('REQUIREMENTS');
    push('============');
    push('  pip install langchain langchain-anthropic langgraph httpx pydantic');
    push('  export ANTHROPIC_API_KEY=sk-ant-...');
    push('');
    push('  # Optional, install only formats you actually attach:');
    push('  pip install mammoth        # for .docx attachments');
    push('  pip install python-pptx    # for .pptx attachments');
    push('  pip install openpyxl       # for .xlsx attachments');
    push('  pip install pypdf          # for .pdf attachments');
    push('');
    // safeName may carry raw (latin1) high bytes from a non-ASCII workflow name — push as a Buffer
    // so the join's utf8 encoding doesn't re-encode them (PHP keeps the raw bytes).
    push(
      Buffer.concat([
        Buffer.from('Usage: python ', 'utf8'),
        Buffer.from(safeName, 'latin1'),
        Buffer.from(".py 'your prompt here'", 'utf8'),
      ])
    );
    if (missing.length > 0) {
      push('');
      push('WARNING: These tools are NOT available as MCP servers');
      push('and will be missing at runtime: ' + pythonListRepr(missing));
      push('Convert them to MCP servers to enable full functionality.');
    }
    push('"""');
    push('from __future__ import annotations');
    push('');
    push('import asyncio, json, os, subprocess, sys, threading, time');
    push('from typing import Annotated, Any, TypedDict');
    push('');
    push('import httpx');
    push('# Provider-aware LLM wiring — each agent uses the LLM (provider/model)');
    push('# configured for it in the workflow editor. Imports are lazy inside');
    push('# _make_llm so a missing optional package only breaks the agents that');
    push('# actually use that provider, not the whole script.');
    push('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage');
    push('from langchain_core.tools import StructuredTool');
    push('from langgraph.graph import END, START, StateGraph');
    push('try:');
    push('    from langchain.agents import create_agent as create_react_agent');
    push('except ImportError:');
    push('    from langgraph.prebuilt import create_react_agent');
    push('from pydantic import BaseModel, Field, create_model');
    push('');
    push('# Optional global override: setting MODEL_NAME in the env forces every');
    push('# agent to use that model regardless of its per-agent setting. Useful for');
    push("# quick experiments. Leave unset to honour each agent's configured model.");
    push("MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()");
    push('');
    push('');
    push('def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096):');
    push('    """Build a LangChain chat model for the given provider/model.');
    push('');
    push('    The (provider, model) pair was resolved by the generator: the');
    push("    agent's explicit model overrides the provider's default from");
    push('    system_llm_settings, and that result is what reaches this');
    push('    function. No hardcoded model fallbacks here — every value comes');
    push('    from the database, so changing a model in the editor propagates');
    push('    via the next Generate Python.');
    push('');
    push('    Recognised providers (case-insensitive):');
    push('      claude     → langchain_anthropic.ChatAnthropic');
    push('      openai     → langchain_openai.ChatOpenAI');
    push('      gemini     → langchain_google_genai.ChatGoogleGenerativeAI');
    push('      grok       → ChatOpenAI on https://api.x.ai/v1');
    push('      deepseek   → ChatOpenAI on https://api.deepseek.com');
    push('      kimi       → ChatOpenAI on https://api.moonshot.ai/v1');
    push('');
    push('    Reads API keys from the environment (loaded from .env at startup).');
    push('    """');
    push('    p = (provider or "claude").lower()');
    push('    if MODEL_NAME_OVERRIDE:');
    push('        model = MODEL_NAME_OVERRIDE');
    push('    if not model:');
    push('        raise RuntimeError(');
    push('            f"No model specified for provider {p!r}. "');
    push('            "Set a model name on the agent in the workflow editor, "');
    push('            "or set MODEL_NAME in .env."');
    push('        )');
    push('    if p == "claude":');
    push('        from langchain_anthropic import ChatAnthropic');
    push('        return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)');
    push('    if p == "openai":');
    push('        from langchain_openai import ChatOpenAI');
    push('        return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)');
    push('    if p == "gemini":');
    push('        from langchain_google_genai import ChatGoogleGenerativeAI');
    push('        return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)');
    push('    if p == "grok":');
    push('        from langchain_openai import ChatOpenAI');
    push('        return ChatOpenAI(');
    push('            model=model,');
    push('            base_url="https://api.x.ai/v1",');
    push('            api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),');
    push('            temperature=temperature,');
    push('            max_tokens=max_tokens,');
    push('        )');
    push('    if p == "deepseek":');
    push('        from langchain_openai import ChatOpenAI');
    push('        return ChatOpenAI(');
    push('            model=model,');
    push('            base_url="https://api.deepseek.com",');
    push('            api_key=os.environ.get("DEEPSEEK_API_KEY"),');
    push('            temperature=temperature,');
    push('            max_tokens=max_tokens,');
    push('        )');
    push('    if p == "kimi":');
    push('        from langchain_openai import ChatOpenAI');
    push('        # Kimi is OpenAI-compatible. temperature/max_tokens come straight from');
    push('        # the agent form -- never overridden. K2 defaults to thinking mode; disable');
    push('        # it (not a form parameter) to match the PHP KimiProvider.');
    push('        kwargs = dict(');
    push('            model=model,');
    push('            base_url="https://api.moonshot.ai/v1",');
    push('            api_key=os.environ.get("KIMI_API_KEY"),');
    push('            temperature=temperature,');
    push('            max_tokens=max_tokens,');
    push('        )');
    push('        if model.startswith("kimi-k2"):');
    push('            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}');
    push('        return ChatOpenAI(**kwargs)');
    push('    raise RuntimeError(');
    push('        f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi."');
    push('    )');
    push('');

    // ---- MCP server registry ----
    push(sep);
    push('# MCP SERVER REGISTRY');
    push("# Baked at generation time from the workflow editor's config.");
    push('# Maps server URL -> metadata. If a server moves, update the URL here.');
    push(sep);
    push('');
    push('MCP_SERVERS = ' + jsonToPython(usedServers, true));
    push('');

    // ---- tool catalog ----
    push(sep);
    push('# TOOL CATALOG');
    push('# Each entry maps a tool name to its MCP server URL and');
    push('# JSON Schema for input validation. Only tools actually used');
    push('# by agents in this workflow are included.');
    push('# To add a tool: add an entry here AND reference it in the');
    push("# agent's tool_names list in the AGENTS dict below.");
    push(sep);
    push('');
    push('TOOL_CATALOG = ' + jsonToPython(usedCatalog, true));
    push('');

    // ---- MCP client ----
    push(sep);
    push('# MCP CLIENT -- JSON-RPC 2.0 over HTTP');
    push('#');
    push('# The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.');
    push('# Each tool call requires:');
    push('#   1. URL normalization -- append /mcp if not present');
    push("#   2. Session initialization -- send 'initialize' + notification");
    push("#   3. Tool invocation -- send 'tools/call' with name + arguments");
    push('#   4. Response parsing -- handle plain JSON or SSE-wrapped JSON');
    push('#');
    push('# Some MCP servers return Server-Sent Events (SSE) instead of');
    push('# plain JSON. The parser handles both formats transparently.');
    push(sep);
    push('');
    push(mcpClientBlock());

    // ---- tool builder ----
    push('');
    push(sep);
    push('# TOOL BUILDER');
    push('# Converts the baked TOOL_CATALOG into LangChain StructuredTool');
    push('# objects. Each tool gets a dynamically-built Pydantic model for');
    push('# input validation (from the JSON Schema), and a callable that');
    push('# invokes the MCP server. The LLM agent calls these like any');
    push("# other LangChain tool -- it doesn't know about MCP internals.");
    push(sep);
    push('');
    // PHP: self::toolBuilderBlock() = $partA . PythonEmitHelpers::skillDepsBlock() .
    // PythonEmitHelpers::skillFsSyncBlock() . $lgSpecific. skillDepsBlock/skillFsSyncBlock are the
    // shared (ADK/MAF-reusable) blocks ported in task 9; TOOL_BUILDER_PART_A/LG_SPECIFIC are
    // LangGraph-only (StructuredTool/create_react_agent), so they stay local to this file.
    push(TOOL_BUILDER_PART_A + skillDepsBlock() + skillFsSyncBlock() + TOOL_BUILDER_LG_SPECIFIC);

    // ---- state ----
    push('');
    push(sep);
    push('# LANGGRAPH STATE');
    push('#');
    push('# WFState is the shared state that flows through the graph.');
    push('# - user_prompt: the original user input (immutable after start)');
    push('# - node_outputs: dict of node_id -> {source, text} -- each node');
    push('#   writes its output here. Uses a merge reducer so parallel');
    push('#   branches can both contribute without conflicts.');
    push('# - final_output: set by the output node as the workflow result');
    push(sep);
    push('');
    push(stateBlock);

    // ---- datetime injector ----
    push('');
    push(sep);
    push('# DATETIME INJECTOR');
    push('#');
    push("# LLMs have knowledge cutoffs and don't know the current date.");
    push("# inject_datetime() prepends a short context block to each agent's");
    push("# system prompt so the agent reasons with today's actual date.");
    push('# Also resolves any [date]/[weekday]/[year]/[time] placeholders');
    push('# that may exist inside the prompt text (legacy templating).');
    push(sep);
    push('');
    push(datetimeInjectorBlock);

    // ---- context builder ----
    push('');
    push(sep);
    push('# CONTEXT BUILDER');
    push('#');
    push('# Each agent receives a structured message containing:');
    push('#   1. The original user request (for reference)');
    push('#   2. Labeled outputs from direct upstream agents only');
    push("# This matches the PHP backend's 'labeled' merge strategy.");
    push("# The agent's system prompt tells it what to DO with this input.");
    push(sep);
    push('');
    push(contextBuilderBlock);

    // ---- document converter ----
    push('');
    push(sep);
    push('# DOCUMENT CONVERTER');
    push('#');
    push('# Reads a file at `path` and returns Markdown the LLM can read.');
    push('# Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/etc.) pass through');
    push('# verbatim. Binary office formats and PDFs are routed to their');
    push('# matching pure-Python library (mammoth / python-pptx / openpyxl /');
    push('# pypdf). Imports are lazy so the helper only pulls in heavy deps');
    push('# when a document of that format is actually attached.');
    push('#');
    push("# This mirrors the editor's frontend converter (Pyodide) so the");
    push('# generated script behaves the same way the workflow did at design');
    push('# time. Paths come from the doc.path field stored in the workflow');
    push('# config — make sure the file is reachable from wherever you run');
    push('# this script (absolute paths recommended).');
    push(sep);
    push('');
    push(documentConverterBlock());

    // ---- start node config ----
    push('');
    push(sep);
    push('# START NODE');
    push('#');
    push('# The start node feeds the prompt into the workflow.');
    push("# DEFAULT_PROMPT is baked from the workflow's start node config.");
    push('# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.');
    push('# If the workflow has documents attached to the start node,');
    push("# they're read from doc.path, converted to Markdown via");
    push('# _convert_doc_to_markdown(), and prepended to the prompt.');
    push(sep);
    push('');
    const promptEscaped = escapePrompt(startPrompt);
    push('DEFAULT_PROMPT = """');
    for (const seg of wrapPromptToBuffers(promptEscaped)) push(seg);
    push('""".strip()');
    push('');
    // Output-node storage setting baked in so the compiled script persists the final result where
    // the app does (~/Documents/synergyAI/outputs/workflow/, or a custom folder) only when storage
    // is enabled. Mirrors the ADK generator.
    const ofolder = workflow.outputFolder;
    push('WORKFLOW_ID = ' + String(phpIntval(workflowId)));
    push('WORKFLOW_NAME = ' + pyStr(wfName));
    push('OUTPUT_STORAGE_ENABLED = ' + (workflow.outputStorageEnabled ? 'True' : 'False'));
    push('OUTPUT_FOLDER = ' + (ofolder !== null && ofolder !== undefined && ofolder !== '' ? pyStr(String(ofolder)) : 'None'));
    push('');
    if (!isEmpty(startDocuments)) {
      push('START_DOCUMENTS = ' + jsonToPython(phpAssocReencode(startDocuments)));
    } else {
      push('START_DOCUMENTS = []');
    }
    push('');

    // ---- agent definitions ----
    push(sep);
    push('# AGENT DEFINITIONS');
    push('#');
    push('# Each agent is identified by its workflow node ID.');
    push('#   display:       Human-readable name (for logs and context labels)');
    push("#   system_prompt: The agent's persona/instructions (sent as SystemMessage)");
    push('#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)');
    push('#');
    push('# To modify an agent: edit its system_prompt or tool_names here.');
    push('# To add a new agent: add an entry, create edges in EDGES, and');
    push('# include the node ID in ORDER at the right topological position.');
    push(sep);
    push('');
    push('AGENTS = {');
    for (const [nid, ad] of agentData) {
      let toolsList = jsonEncode(ad.tool_names);
      if (toolsList === '[]') toolsList = '[]';
      const promptText = escapePrompt(ad.system_prompt);
      const wrappedSegs = wrapPromptToBuffers(promptText);
      const displayJson = jsonEncode(ad.display);
      const providerJson = jsonEncode(String(ad.provider ?? 'claude'));
      const modelJson = jsonEncode(String(ad.model ?? ''));
      const temperatureLit = jsonEncode(phpFloatval(ad.temperature ?? 0.7));
      const maxTokensLit = String(phpIntval(ad.max_tokens ?? 4096));
      push('    "' + nid + '": {');
      push('        "display": ' + displayJson + ',');
      push('        "provider": ' + providerJson + ',');
      push('        "model": ' + modelJson + ',');
      push('        "temperature": ' + temperatureLit + ',');
      push('        "max_tokens": ' + maxTokensLit + ',');
      push('        "system_prompt": """');
      for (const seg of wrappedSegs) push(seg);
      push('""",');
      const skillsJson = jsonEncode(ad.skills ?? []);
      push('        "tool_names": ' + toolsList + ',');
      // Ordered skill bindings ([{"dir": "..."}] / [{"inline": "..."}]) -- the node runs each as
      // a mandatory post-agent step; the last produces the node output.
      push('        "skills": ' + skillsJson + ',');
      push('    },');
    }
    push('}');
    push('');

    // ---- edge data ----
    push(sep);
    push('# GRAPH STRUCTURE');
    push('#');
    push('# EDGES: directed connections as (from_node_id, to_node_id) tuples.');
    push("# ORDER: topological execution order (Kahn's algorithm).");
    push('#        Guarantees every node runs after all its predecessors.');
    push("# NODE_TYPES: maps node_id -> type ('start', 'agent', 'output').");
    push(sep);
    push('');
    push('EDGES = ' + jsonToPython(edgeList));
    push('ORDER = ' + jsonToPython(order));
    push('');
    push(parentsChildrenBlock);

    const typeMap: Record<string, string> = {};
    for (const nid of order) typeMap[nid] = nodeType(byId[nid]);
    push('NODE_TYPES = ' + jsonToPython(typeMap, true));
    push('');

    // ---- main ----
    push(sep);
    push('# MAIN EXECUTION');
    push('#');
    push('# run() builds the LangGraph, wires edges, and executes it.');
    push('# Each node type has a factory function (make_start, make_agent,');
    push('# make_output) that returns a callable for LangGraph to invoke.');
    push('#');
    push("# Agent nodes use LangChain's ReAct pattern: the LLM receives");
    push('# the system prompt + upstream context, and can call tools in a');
    push('# loop until it produces a final answer.');
    push(sep);
    push('');
    push(runHeaderBlock);

    if (missing.length > 0) {
      push('    print("[warn] Missing tools (not MCP): ' + pythonListRepr(missing) + '")');
      push('');
    }

    push(RUN_BODY_BLOCK);

    // join (implode("\n", lines)) in the byte domain
    const bufs: Buffer[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) bufs.push(NL);
      const p = lines[i];
      bufs.push(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
    }
    const code = Buffer.concat(bufs);
    // Suffix the runtime so the file is identifiable alongside *_adk.py / *_maf.py (LangGraph was
    // the original default and previously had no suffix).
    const filename = `${safeName}_langgraph.py`;
    return { filename, code };
  }
}
