import { mcpClientBlock as _mcpClientBlock, documentConverterBlock as _documentConverterBlock } from './pyBlocks';

/**
 * PythonEmitHelpers
 *
 * Faithful TypeScript mirror of src/AgentTeam/Services/PythonEmitHelpers.php.
 *
 * Shared Python-code-emission helpers used by the LangGraph/ADK/MAF generators.
 * All functions are pure; no DB or state dependencies.
 *
 * Functions moved verbatim from PHP (matching LangGraphGenerator's emitted output):
 *   - jsonToPython()            PHP value -> Python literal (True/False/None)
 *   - mcpClientBlock()          MCP JSON-RPC client Python functions
 *   - skillDepsBlock()          SKILLS_DIR globals + _ensure_skill_deps Python function
 *   - skillFsSyncBlock()        Synchronous skill filesystem Python block
 *   - documentConverterBlock()  _convert_doc_to_markdown() Python function
 *
 * New helper (not previously in LangGraphGenerator):
 *   - pyStr()          TS string -> Python double-quoted string literal
 *
 * Byte-fidelity notes:
 *   - mcpClientBlock() and documentConverterBlock() are byte-identical to the
 *     LangGraph-shaped constants already ported to pyBlocks.ts (verified via
 *     diff against a live PHP dump of PythonEmitHelpers::mcpClientBlock() /
 *     ::documentConverterBlock()), so they are re-exported here rather than
 *     duplicated.
 *   - skillDepsBlock() and skillFsSyncBlock() have NO byte-identical
 *     equivalent in pyBlocks.ts (pyBlocks' toolBuilderBlock embeds a
 *     different, LangChain-specific variant of the skill-script runner --
 *     e.g. no env= kwarg on subprocess.run, no SYNERGYAI_* env exposure).
 *     Their string literals below were generated directly from a live PHP
 *     dump of PythonEmitHelpers::skillDepsBlock() / ::skillFsSyncBlock() to
 *     guarantee byte parity.
 *   - jsonToPython()/pyStr() replicate PHP's json_encode(JSON_PRETTY_PRINT |
 *     JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) plus the naive
 *     ": true"/": false"/": null" string-replace PHP uses to produce
 *     True/False/None -- including the quirk that only object-value booleans
 *     (preceded by ": ") get converted; bare list-element booleans do not.
 *
 *     Float formatting: PythonEmitHelpers::jsonToPython() itself has no
 *     ini_set() of its own -- json_encode's float precision follows whatever
 *     `serialize_precision` is ambient at call time. The web SAPI's php.ini
 *     defaults that to 100 (which would emit the full ~55-digit exact decimal
 *     expansion of the IEEE-754 double, e.g. 0.7 -> "0.69999...875"), BUT
 *     every current caller (LangGraphGenerator.php, ADKGenerator.php,
 *     MAFGenerator.php) explicitly does `ini_set('serialize_precision', '-1')`
 *     as the first line of generate() -- before any jsonToPython() call --
 *     specifically to force shortest-round-trip floats (e.g. "0.7", not the
 *     long expansion). Verified via `php -d serialize_precision=-1 -r
 *     'echo json_encode(0.7);'` -> "0.7", matching JS's native
 *     JSON.stringify number formatting (both are shortest-round-trip
 *     algorithms over the same IEEE-754 double). So this port targets the
 *     -1 behavior actually observed by every real caller, and needs no
 *     custom float formatting -- JSON.stringify's default is already correct.
 */

// ---------------------------------------------------------------------------
// jsonToPython / pyStr
// ---------------------------------------------------------------------------

/** PHP always escapes U+2028 / U+2029 even with JSON_UNESCAPED_UNICODE; JS does not. */
function fixSep(s: string): string {
  return s.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * PHP json_encode(value, JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES)
 * emulation (under serialize_precision=-1; see file header). JSON.stringify already matches
 * JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE byte-for-byte (no \/ escaping, raw unicode) and
 * uses shortest-round-trip float formatting; only U+2028/U+2029 need a manual fixup afterwards.
 */
function phpJsonStringify(value: any, pretty: boolean): string {
  const s = pretty ? JSON.stringify(value, null, 4) : JSON.stringify(value);
  return fixSep(s);
}

/** PHP str_replace on ': true'/': false'/': null' (global, including inside strings -- a quirk). */
function boolToPy(s: string): string {
  return s.split(': true').join(': True').split(': false').join(': False').split(': null').join(': None');
}

/** Mirrors PHP (object) cast of an array: index-keyed object, e.g. [1,2] -> {"0":1,"1":2}. */
function phpArrayToObject(arr: any[]): Record<string, any> {
  const o: Record<string, any> = {};
  arr.forEach((v, i) => {
    o[String(i)] = v;
  });
  return o;
}

/**
 * Serialize a value to a Python-valid literal string.
 *
 * json_encode produces 'true'/'false'/'null' which are not valid Python.
 * This converts to 'True'/'False'/'None'. Uses 4-space indent matching
 * Python's json.dumps(indent=4) output.
 *
 * forceObject casts a top-level array to an object so empty arrays encode as {}
 * and (index-keyed) arrays encode as object literals -- mirroring PHP's
 * `$forceObject && is_array($value) ? (object) $value : $value`.
 */
export function jsonToPython(value: any, forceObject = false): string {
  if (forceObject && Array.isArray(value)) {
    value = phpArrayToObject(value);
  }
  return boolToPy(phpJsonStringify(value, true));
}

/**
 * Render a string as a Python double-quoted string literal.
 *
 * Escapes backslashes, double-quotes, newlines, carriage returns,
 * and tabs so the result is a valid Python string expression.
 *
 * Example: pyStr('line1\nquote"x') -> '"line1\\nquote\\"x"'
 */
export function pyStr(s: string): string {
  let out = s.split('\\').join('\\\\');
  out = out.split('"').join('\\"');
  out = out.split('\n').join('\\n');
  out = out.split('\r').join('\\r');
  out = out.split('\t').join('\\t');
  return '"' + out + '"';
}

// ---------------------------------------------------------------------------
// Embedded Python blocks
// ---------------------------------------------------------------------------

/**
 * Emit the MCP JSON-RPC client Python block.
 *
 * Returns the three functions: _normalize_mcp_url, _init_mcp_session,
 * _parse_mcp_response, and _call_mcp_tool.
 *
 * Byte-identical to PythonEmitHelpers::mcpClientBlock() (verified against a
 * live PHP dump); re-exported from pyBlocks.ts rather than duplicated.
 */
export function mcpClientBlock(): string {
  return _mcpClientBlock;
}

/**
 * Emit the skill-dependency-install Python block.
 *
 * Returns: SKILLS_DIR constant, _INSTALLED_DEPS/_DEPS_LOCK globals,
 * and the _ensure_skill_deps() function that reads SKILL.md YAML
 * frontmatter and pip-installs declared dependencies on first use.
 *
 * Byte-identical to PythonEmitHelpers::skillDepsBlock() (generated from a
 * live PHP dump). ADKGenerator/MAFGenerator call this too so the emitted
 * Python is identical across code paths.
 */
export function skillDepsBlock(): string {
  return "# ---------------------------------------------------------------------------\n# Local run_skill_script — execute a folder-backed skill's Python script as a\n# subprocess. Skills are real CPython (the browser runs them in Pyodide; here\n# we shell out). Registered into the catalog at startup so skill-bound agents\n# actually run their skill instead of fabricating output.\n# ---------------------------------------------------------------------------\nSKILLS_DIR = os.environ.get(\n    \"SYNERGYAI_SKILLS_DIR\",\n    os.path.join(os.path.expanduser(\"~\"), \"Documents\", \"synergyAI\", \"skills\"),\n)\n\n# Skills declare their PyPI deps in SKILL.md frontmatter\n# (e.g. `dependencies: [beautifulsoup4]`). The browser installs them via\n# micropip; here we pip-install missing ones into the runner venv on first\n# use. Cached + lock-guarded because parallel branches call skills at once.\n_INSTALLED_DEPS = set()\n_DEPS_LOCK = threading.Lock()\n\n\ndef _ensure_skill_deps(skill_dir: str) -> None:\n    md = os.path.join(skill_dir, \"SKILL.md\")\n    if not os.path.isfile(md):\n        return\n    deps = []\n    try:\n        lines = open(md, encoding=\"utf-8\").read().splitlines()\n    except Exception:\n        return\n    # Only the YAML frontmatter (between leading '---' fences) is authoritative;\n    # a 'dependencies:' line in the prose body is not a real declaration.\n    if not lines or lines[0].strip() != \"---\":\n        return\n    for line in lines[1:]:\n        s = line.strip()\n        if s == \"---\":\n            break\n        if s.lower().startswith(\"dependencies:\"):\n            val = s.split(\":\", 1)[1].strip().strip(\"[]\")\n            deps = [d.strip().strip(\"'\").strip('\"') for d in val.split(\",\") if d.strip()]\n            break\n    with _DEPS_LOCK:\n        for d in deps:\n            if d in _INSTALLED_DEPS:\n                continue\n            _INSTALLED_DEPS.add(d)\n            try:\n                print(f\"  [run_skill_script] ensuring dependency: {d}\", flush=True)\n                r = subprocess.run([sys.executable, \"-m\", \"pip\", \"install\", \"-q\", d],\n                                   capture_output=True, text=True, timeout=600)\n                if r.returncode != 0:\n                    print(f\"  [run_skill_script] pip install {d} FAILED: \"\n                          f\"{(r.stderr or '')[-300:]}\", flush=True)\n            except Exception as e:\n                print(f\"  [run_skill_script] pip install {d} error: {e}\", flush=True)\n";
}

/**
 * Emit the synchronous skill filesystem Python block.
 *
 * Returns: SKILL_OUTPUTS_ROOT / SKILL_SCRATCH_DIR / _LAST_SKILL_OUTPUTS globals,
 * _skill_output_dir(), _remap_virtual_path(), _run_skill_script() (synchronous
 * subprocess.run with bucketed dirs, argv remap, input_files staging, SYNERGYAI_*
 * env, and read_outputs -> _LAST_SKILL_OUTPUTS stash), and _read_skill_md().
 *
 * Framework-agnostic -- contains NO LangChain/langchain_core symbols. Depends on
 * SKILLS_DIR + _ensure_skill_deps from skillDepsBlock() being emitted first.
 *
 * Byte-identical to PythonEmitHelpers::skillFsSyncBlock() (generated from a
 * live PHP dump). Shared by LangGraphGenerator and MAFGenerator.
 */
export function skillFsSyncBlock(): string {
  return "\n\n# Skill filesystem (mirrors the browser interpreter + ADK): real bucketed /outputs and\n# /scratch dirs, virtual-path remap, env exposure, and a deliverable stash so a skill's\n# produced file (not the model's chatter) can become the node output.\nSKILL_OUTPUTS_ROOT = os.environ.get(\"SYNERGYAI_OUTPUT_ROOT\") or os.path.join(os.path.dirname(SKILLS_DIR), \"outputs\")\nSKILL_SCRATCH_DIR = os.environ.get(\"SYNERGYAI_SCRATCH_DIR\") or os.path.join(os.path.dirname(SKILLS_DIR), \"scratch\")\n_LAST_SKILL_OUTPUTS = {}\n\n\ndef _skill_output_dir(dir_name: str) -> str:\n    group = dir_name.split(\"/\")[0] if \"/\" in dir_name else \"\"\n    if group and all(c.isalnum() or c in \"._-\" for c in group):\n        return os.path.join(SKILL_OUTPUTS_ROOT, group)\n    return SKILL_OUTPUTS_ROOT\n\n\ndef _remap_virtual_path(p, out_dir: str) -> str:\n    p = str(p)\n    for virt, real in ((\"/outputs\", out_dir), (\"/scratch\", SKILL_SCRATCH_DIR)):\n        if p == virt:\n            return real\n        if p.startswith(virt + \"/\"):\n            return os.path.join(real, p[len(virt) + 1:])\n    return p\n\n\ndef _run_skill_script(dir_name: str, script: str, argv=None,\n                      input_files=None, read_outputs=None) -> str:\n    if isinstance(argv, str):\n        try:\n            argv = json.loads(argv)\n        except Exception:\n            argv = [argv]\n    argv = list(argv) if argv else []\n    skill_dir = os.path.join(SKILLS_DIR, *str(dir_name).split(\"/\"))\n    script_path = os.path.join(skill_dir, *str(script).split(\"/\"))\n    if not os.path.isfile(script_path):\n        return f\"ERROR: skill script not found: {dir_name}/{script} (looked in {script_path})\"\n    _ensure_skill_deps(skill_dir)\n    out_dir = _skill_output_dir(dir_name)\n    os.makedirs(out_dir, exist_ok=True)\n    os.makedirs(SKILL_SCRATCH_DIR, exist_ok=True)\n    # Remap the interpreter's virtual /outputs & /scratch in argv to real dirs.\n    argv = [_remap_virtual_path(a, out_dir) for a in argv]\n    # Stage input_files (e.g. HTML the skill will render) at their remapped paths.\n    if isinstance(input_files, dict):\n        for raw_path, content in input_files.items():\n            try:\n                target = _remap_virtual_path(raw_path, out_dir)\n                os.makedirs(os.path.dirname(target) or \".\", exist_ok=True)\n                with open(target, \"w\", encoding=\"utf-8\") as fh:\n                    fh.write(content if isinstance(content, str) else str(content))\n            except Exception as e:\n                print(f\"  [run_skill_script] could not stage {raw_path}: {e}\")\n    env = dict(\n        os.environ,\n        SYNERGYAI_OUTPUT_DIR=out_dir,\n        SYNERGYAI_SCRATCH_DIR=SKILL_SCRATCH_DIR,\n        SYNERGYAI_SKILL_DIR_NAME=dir_name,\n        SYNERGYAI_SKILL_GROUP=(dir_name.split(\"/\")[0] if \"/\" in dir_name else \"\"),\n    )\n    cmd = [sys.executable, script_path] + [str(a) for a in argv]\n    print(f\"  [run_skill_script] → {dir_name}/{script} argv={argv}\", flush=True)\n    _t0 = time.monotonic()\n    try:\n        proc = subprocess.run(cmd, cwd=skill_dir, env=env, capture_output=True,\n                              text=True, timeout=300)\n    except subprocess.TimeoutExpired:\n        print(f\"  [run_skill_script] ← {dir_name}/{script}: TIMEOUT after 300s\", flush=True)\n        return f\"ERROR: skill {dir_name}/{script} timed out after 300s\"\n    _dt = time.monotonic() - _t0\n    out = proc.stdout or \"\"\n    _stderr = (proc.stderr or \"\").strip()\n    _head = out.replace(chr(10), \" \")[:160]\n    print(f\"  [run_skill_script] ← {dir_name}/{script}: exit={proc.returncode}, \"\n          f\"{len(out)} chars stdout, {_dt:.1f}s | {_head}\", flush=True)\n    if proc.returncode != 0 and _stderr:\n        print(f\"  [run_skill_script]   stderr tail: {_stderr[-400:]}\", flush=True)\n    if proc.returncode != 0:\n        out = (out + f\"\\n[run_skill_script exit {proc.returncode}]\\n\"\n               + _stderr[-2000:]).strip()\n    # Read back requested outputs AND stash them so the skill step can use the produced\n    # document as the node output.\n    _produced = []\n    if isinstance(read_outputs, list):\n        for rel in read_outputs:\n            try:\n                with open(_remap_virtual_path(rel, out_dir), \"r\", encoding=\"utf-8\") as fh:\n                    _content = fh.read()\n                out += f\"\\n\\n[output file {rel}]\\n\" + _content\n                _produced.append(_content)\n            except Exception:\n                pass\n    if _produced:\n        _LAST_SKILL_OUTPUTS[dir_name] = _produced\n    return out or \"(skill produced no stdout)\"\n\n\ndef _read_skill_md(dir_name: str) -> str:\n    \"\"\"The live SKILL.md body (progressive disclosure); frontmatter stripped.\"\"\"\n    path = os.path.join(SKILLS_DIR, *str(dir_name).split(\"/\"), \"SKILL.md\")\n    try:\n        with open(path, \"r\", encoding=\"utf-8\") as f:\n            text = f.read()\n    except OSError:\n        return f\"(SKILL.md not found for skill '{dir_name}')\"\n    if text.startswith(\"---\"):\n        end = text.find(\"\\n---\\n\", 3)\n        if end != -1:\n            nl = text.find(\"\\n\", end + 1)\n            text = text[nl + 1:] if nl != -1 else \"\"\n    return text.strip()\n";
}

/**
 * Emit the document-to-markdown converter Python function.
 *
 * Returns _convert_doc_to_markdown(path) which reads a file and returns
 * its contents as Markdown. Text-native formats pass through verbatim;
 * binary office formats and PDFs are routed to their matching pure-Python
 * parser with lazy imports.
 *
 * Byte-identical to PythonEmitHelpers::documentConverterBlock() (verified
 * against a live PHP dump); re-exported from pyBlocks.ts rather than
 * duplicated.
 */
export function documentConverterBlock(): string {
  return _documentConverterBlock;
}
