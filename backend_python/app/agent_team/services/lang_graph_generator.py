"""Port of backend/src/AgentTeam/Services/LangGraphGenerator.php (3314 lines).

Generates a standalone Python LangGraph script from a saved workflow. The
generated file is fully independent of the backend: it connects directly to
MCP servers via JSON-RPC 2.0 over HTTP and needs only an API key env var and
a user prompt.

Two emission modes:
  - single-file (default): `generate()` returns {filename, code} -- one
    *_langgraph.py script embedding every agent/playbook node.
  - A2A (`options={'a2a': True}`): `generate()` returns {root, files} -- an
    orchestrator.py driving one self-contained A2A agent server per
    agent/playbook node (see a2aLayout()).

Byte-identical emission is the contract: every literal generated-Python-code
block below was extracted programmatically from the PHP nowdoc/heredoc
bodies (no manual transcription), and every dynamic emission path (AGENTS/
PLAYBOOKS dict building, docstrings, NODE literals) mirrors the PHP
source's string-building order field-for-field. `private function` ->
`_camelCase` (leading underscore), `private static function` ->
`@staticmethod _camelCase`; `a2aLayout()` stays public (no leading
underscore) because the oracle tests call it directly.
"""
from __future__ import annotations

import json
import re
import unicodedata

from app.agent_team.services.dispatch_routing import DispatchRouting
from app.agent_team.services.python_emit_helpers import PythonEmitHelpers
from app.agent_team.services.workflow_graph_analyzer import WorkflowGraphAnalyzer
from app.playbook.playbook_analyzer import PlaybookAnalyzer
from app.playbook.playbook_document import PlaybookDocument
from app.support.phpcompat import (
    PHP_TRIM_CHARS,
    php_coalesce as _coalesce,
    php_date,
    php_empty,
    php_intval,
    php_strval,
    php_trim,
)
from app.support.phpjson import dumps as _php_compact_json


def _rtrim(s: str) -> str:
    """PHP `rtrim($s)` (default charset: space, tab, newline, CR, NUL, VT)."""
    return str(s).rstrip(PHP_TRIM_CHARS)


def _jf(v) -> str:
    """PHP `json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)`
    -- the compact `$j = fn($v) => json_encode(...)` encoder used throughout
    the emitters for string/array/dict values. NEVER pass a bare float --
    those go through `_float_json` (PHP encodes a float differently, and this
    compact encoder is never called on one at any LangGraphGenerator site)."""
    return _php_compact_json(v)


def _float_json(v) -> str:
    """PHP `json_encode((float) $v)` under `serialize_precision=-1` (set for
    the whole request in analyzeForEmit(), PHP 695): shortest round-trip
    digits, but a WHOLE-NUMBER float prints WITHOUT a trailing '.0' --
    `json_encode((float) 1.0)` is `"1"`, not Python `repr()`'s `"1.0"`."""
    s = repr(float(v))
    if s.endswith('.0'):
        s = s[:-2]
    return s


def _ascii_translit(s: str) -> str:
    """Best-effort port of PHP `iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s)`:
    decompose accented characters to their ASCII base letter, drop anything
    with no ASCII equivalent. iconv's TRANSLIT table can differ from Unicode
    NFKD decomposition for exotic scripts/symbols; every current call site
    (agent/playbook display names) is plain ASCII, so this is not exercised
    by the byte-identical contract in practice."""
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')


def _php_wordwrap(text: str, width: int, brk: str = '\n', cut: bool = False) -> str:
    """Port of PHP `wordwrap($text, $width, $break, $cut)` (ext/standard/string.c
    `php_wordwrap`): break at the last space before `width` is exceeded, or
    (when `cut`) mid-word if a single word alone exceeds `width`. Every call
    site here passes a single already-`\\n`-free line (LangGraphGenerator
    explodes the source text on "\\n" before wrapping), so the '\\n' branch
    below is defensive, not exercised.

    PHP's `wordwrap`/`strlen`/`substr` are BYTE-oriented, not character-
    oriented -- a multibyte character (e.g. an em dash, 3 UTF-8 bytes) counts
    as multiple units toward `width`. This operates on the UTF-8 BYTES of
    `text` (verified against `php -r 'echo wordwrap(...)'` 2026-09-07 for a
    line containing an em dash: a character-counting port wraps one word
    later than PHP does). A cut (`cut=True`, a single "word" longer than
    `width`) could in principle split a multibyte character's byte sequence;
    `errors='replace'` on the final decode is defensive for that PHP-only-
    reachable edge case, not exercised by any current caller."""
    if text == '':
        return text
    if width <= 0:
        if cut:
            raise ValueError('wordwrap(): Argument #2 ($width) must be greater than 0 when Argument #4 ($cut_long_words) is true')
        return text
    b = text.encode('utf-8')
    brk_b = brk.encode('utf-8')
    textlen = len(b)
    laststart = 0
    lastspace = 0
    out: list[bytes] = []
    current = 0
    while current < textlen:
        c = b[current:current + 1]
        if c == b'\n':
            out.append(b[laststart:current + 1])
            laststart = lastspace = current + 1
        elif c == b' ':
            if current - laststart >= width:
                out.append(b[laststart:current])
                out.append(brk_b)
                laststart = current + 1
            lastspace = current
        elif current - laststart >= width and cut and laststart >= lastspace:
            out.append(b[laststart:current])
            out.append(brk_b)
            laststart = lastspace = current
        elif current - laststart >= width and current != lastspace:
            out.append(b[laststart:lastspace])
            out.append(brk_b)
            laststart = lastspace = lastspace + 1
        current += 1
    if laststart != current:
        out.append(b[laststart:current])
    return b''.join(out).decode('utf-8', errors='replace')


# --- literal generated-Python-code / doc-text blocks, extracted byte-exact
# from backend/src/AgentTeam/Services/LangGraphGenerator.php heredocs (each
# constant's value is the PHP nowdoc body verbatim -- no manual transcription).
_DATA_FLOW_DOC = 'The script embeds the agents (AGENTS), playbooks (PLAYBOOKS), the MCP\nservers and tool schemas (MCP_SERVERS, TOOL_CATALOG) and the graph\n(EDGES, ORDER, NODE_TYPES), then builds a LangGraph StateGraph at run time.\n\n  1. The Start node stores the user prompt (plus any attached documents,\n     converted to Markdown) in the shared state.\n  2. An AGENT node receives the original prompt plus the output of each of\n     its direct parents under a "### Input from" header, then runs LangChain\'s\n     ReAct loop (create_react_agent): the model decides when to call its MCP\n     tools. Bound skills then run as mandatory post-steps; the last skill\'s\n     produced file (or its text) becomes the node output.\n  3. A DISPATCHER agent does not answer: it must call route_to with the name\n     of ONE child; that child alone runs (state["routes"] drives a conditional\n     edge) and receives the original input plus the dispatcher\'s notes. Its\n     siblings are skipped.\n  4. A PLAYBOOK node interprets its Console-style playbook step by step with\n     the playbook runtime: native verbs (messages, notes, resolve), human\n     gates (approval, form, handoff, await), one tool per bound #Action\n     (write-policed unless "writes enabled") and a stub per unbound #Action.\n     Its output is the run transcript (timeline, messages, gate decisions,\n     result) exactly as the editor\'s run overlay shows it.\n  5. The Output node merges its parents\' outputs verbatim (no LLM) into the\n     final result.\n\nTools are called over the MCP protocol: initialize handshake (the /mcp\nendpoint first, then the URL as registered), tools/call, JSON or SSE\nresponse, text content back to the model.'
_STATE_BLOCK = 'def _merge(left: dict | None, right: dict | None) -> dict:\n    """Reducer for node_outputs -- merges dicts from parallel branches.\n\n    When two nodes run in parallel (e.g., diamond graph), both write to\n    node_outputs. LangGraph needs a reducer to combine them. This does a\n    shallow merge where the right (newer) value wins on key conflicts.\n    """\n    out = dict(left or {})\n    out.update(right or {})\n    return out\n\nclass WFState(TypedDict, total=False):\n    """Shared state for the workflow graph.\n\n    Attributes:\n        user_prompt: The original user input, set once at the start.\n        node_outputs: Each node stores its output as {source, text}.\n                      Annotated with _merge so parallel nodes don\'t conflict.\n        final_output: The final text result, set by the output node.\n    """\n    user_prompt: str\n    node_outputs: Annotated[dict[str, dict[str, str]], _merge]\n    routes: Annotated[dict[str, str], _merge]\n    final_output: str\n'
_DATETIME_INJECTOR_BLOCK = 'def inject_datetime(system_prompt: str) -> str:\n    """Inject current date/time into a system prompt.\n\n    Prepends a dated header so the LLM knows "today" relative to its\n    knowledge cutoff. Also replaces [date], [weekday], [year], [time]\n    placeholders in the prompt body with live values.\n    """\n    from datetime import datetime as _dt\n    now = _dt.now()\n    date_str = now.strftime("%Y-%m-%d")\n    weekday_str = now.strftime("%A")\n    year_str = now.strftime("%Y")\n    time_str = now.strftime("%H:%M")\n    iso_str = now.strftime("%Y-%m-%d %H:%M %Z").strip()\n\n    prompt = system_prompt\n    prompt = prompt.replace("[date]", date_str)\n    prompt = prompt.replace("[weekday]", weekday_str)\n    prompt = prompt.replace("[year]", year_str)\n    prompt = prompt.replace("[time]", time_str)\n\n    header = (\n        f"## Current Date & Time\\n"\n        f"Today is {weekday_str}, {date_str} ({time_str}).\\n"\n        f"Use this as the reference for any date-sensitive reasoning "\n        f"(recent research, latest news, time-relative phrasing, etc.).\\n\\n"\n    )\n    return header + prompt\n'
_CONTEXT_BUILDER_BLOCK = 'def build_context(user_prompt: str, parent_ids: list[str], outputs: dict) -> str:\n    """Build the HumanMessage content for an agent node.\n\n    Args:\n        user_prompt: The original user request\n        parent_ids: Node IDs of direct predecessors (from EDGES)\n        outputs: Current node_outputs state dict\n\n    Returns:\n        Formatted string with labeled inputs from each predecessor.\n        The agent sees this as a single HumanMessage alongside its\n        SystemMessage (the agent\'s instructions/persona).\n    """\n    parts = [f\'Original user request: "{user_prompt}"\', "",\n             "You are receiving the following inputs from upstream agents in this workflow.",\n             "Use them as source material to perform your task as defined in your system prompt.",\n             "", "---"]\n    valid = [(p, outputs[p]) for p in parent_ids if p in outputs]\n    if not valid:\n        parts.append("(no upstream inputs -- respond to the original user request directly)")\n    else:\n        for pid, out in valid:\n            parts += ["", f"### Input from: {out.get(\'source\', pid)}", "", out.get("text", ""), "", "---"]\n    return "\\n".join(parts)\n'
_PARENTS_CHILDREN_BLOCK = 'def parents(nid: str) -> list[str]:\n    """Get direct predecessor node IDs (nodes with edges INTO this node)."""\n    return [f for f, t in EDGES if t == nid]\n\ndef children(nid: str) -> list[str]:\n    """Get direct successor node IDs (nodes this node has edges TO)."""\n    return [t for f, t in EDGES if f == nid]\n'
_RUN_HEADER_BLOCK = 'async def run(user_prompt: str):\n    """Execute the workflow with the given user prompt.\n\n    Steps:\n    1. Build LangChain tools from the embedded TOOL_CATALOG\n    2. Initialize the LLM (Anthropic Claude)\n    3. Construct a LangGraph StateGraph with nodes from ORDER\n    4. Wire edges from EDGES (respecting topological order)\n    5. Compile and invoke the graph\n    6. Return the final output text\n    """\n    print("[info] Building tools from embedded catalog...")\n    catalog = build_tools_from_catalog()\n    # Local (non-MCP) tool: lets skill-bound agents run their folder-backed\n    # skill as a subprocess. Always registered; only agents whose tool_names\n    # include it (skill agents) actually receive it.\n    catalog["run_skill_script"] = RUN_SKILL_SCRIPT_TOOL\n    print(f"[info] {len(catalog)} tools ready: {sorted(catalog.keys())}")\n'
_RUN_BODY_BLOCK = '    # One LLM instance per agent — provider/model come from the AGENTS\n    # dict, which the generator baked from each agent\'s workflow config.\n    # Built eagerly (not per-call) so we fail fast on missing API keys.\n    LLMS = {\n        nid: _make_llm(\n            ad.get("provider", "claude"),\n            ad.get("model", ""),\n            float(ad.get("temperature", 0.7)),\n            int(ad.get("max_tokens", 4096)),\n            thinking=ad.get("thinking"),\n        )\n        for nid, ad in {**AGENTS, **PLAYBOOKS}.items()\n    }\n    sg = StateGraph(WFState)\n\n    for nid in ORDER:\n        ntype = NODE_TYPES.get(nid, "")\n\n        if ntype == "start":\n            def make_start(n=nid):\n                def _run(state):\n                    text = state.get("user_prompt", "")\n                    if START_DOCUMENTS:\n                        doc_parts = []\n                        for doc in START_DOCUMENTS:\n                            name = doc.get("name", "Document")\n                            path = doc.get("path", "")\n                            if not path:\n                                doc_parts.append(f"### {name}\\n\\n_(no path on attachment record)_")\n                                continue\n                            try:\n                                md = _convert_doc_to_markdown(path)\n                                doc_parts.append(f"### {name}\\n\\n{md}")\n                            except Exception as e:\n                                doc_parts.append(f"### {name}\\n\\n_(conversion failed: {e})_")\n                        if doc_parts:\n                            text = (\n                                "## Attached Documents\\n\\n"\n                                + "\\n\\n---\\n\\n".join(doc_parts)\n                                + "\\n\\n---\\n\\n"\n                                + text\n                            )\n                    print(f"[node] [{n}] start -- {len(text)} chars")\n                    return {"node_outputs": {n: {"source": "start", "text": text}}}\n                return _run\n            sg.add_node(nid, make_start())\n\n        elif ntype in ("agent", "agent-template"):\n            def make_agent(n=nid):\n                async def _run(state):\n                    from pathlib import Path\n                    from datetime import datetime as _dt\n                    ad = AGENTS[n]\n                    tool_names = ad["tool_names"]\n                    tools = [catalog[t] for t in tool_names if t in catalog]\n                    print(f"[node] [{n}] {ad[\'display\']!r} -- {len(tools)} tools "\n                          f"(provider={ad.get(\'provider\', \'?\')}, model={ad.get(\'model\', \'?\')})")\n\n                    ctx = build_context(state.get("user_prompt", ""), parents(n), state.get("node_outputs", {}))\n                    sys_chars = len(ad["system_prompt"]) if ad.get("system_prompt") else 0\n                    print(f"[node] [{n}] inputs: system={sys_chars} chars, context={len(ctx)} chars", flush=True)\n\n                    msgs = []\n                    if ad["system_prompt"]:\n                        msgs.append(SystemMessage(content=inject_datetime(ad["system_prompt"])))\n                    msgs.append(HumanMessage(content=ctx))\n                    # Dispatcher: one forced route_to call picks the child; no ReAct loop.\n                    if ad.get("dispatch"):\n                        return await _run_dispatcher(n, ad, state, msgs, LLMS[n])\n                    # Per-agent LLM. Each agent uses the provider/model\n                    # it was configured with in the workflow editor.\n                    agent = create_react_agent(LLMS[n], tools)\n                    t0 = time.monotonic()\n                    result = await agent.ainvoke({"messages": msgs})\n                    dt = time.monotonic() - t0\n\n                    final = result["messages"][-1]\n                    text = final.content if isinstance(final, AIMessage) else str(final)\n                    if isinstance(text, list):\n                        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))\n\n                    msgs_out = result.get("messages", [])\n                    llm_rounds = sum(1 for m in msgs_out if isinstance(m, AIMessage))\n                    tool_results = sum(\n                        1 for m in msgs_out\n                        if getattr(m, "type", None) == "tool"\n                        or m.__class__.__name__ == "ToolMessage"\n                    )\n                    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt\n                    print(f"[node] [{n}] done -- {len(text)} chars "\n                          f"({llm_rounds} LLM rounds, {tool_results} tool results, {dt:.1f}s)")\n                    # Preview of what the agent produced, so the log shows the\n                    # actual answer without opening the _debug dump.\n                    print(f"[node] [{n}] output head: {text[:240]!r}", flush=True)\n                    # High-signal red flag: a tool-bound agent that ran ZERO\n                    # tools almost certainly fabricated its answer (the exact\n                    # failure that produced "Missing /llms.txt"). Surface it.\n                    if tools and tool_results == 0:\n                        print(f"[node] [{n}] ⚠ answered with 0 tool calls despite "\n                              f"{len(tools)} tool(s) available — likely fabricated; "\n                              f"check the skill ran", flush=True)\n\n                    try:\n                        script_root = Path(__file__).resolve().parent.parent\n                        debug_dir = script_root / "outputs" / "_debug"\n                        debug_dir.mkdir(parents=True, exist_ok=True)\n                        ts = _dt.now().strftime("%Y%m%d-%H%M%S")\n                        stem = Path(__file__).stem\n                        dump_path = debug_dir / f"{stem}_{n}_{ts}.json"\n                        entries = []\n                        for m in msgs_out:\n                            content = m.content\n                            if isinstance(content, list):\n                                content = [\n                                    (b if isinstance(b, dict) else {"type": "text", "text": str(b)})\n                                    for b in content\n                                ]\n                            entries.append({\n                                "role": m.__class__.__name__,\n                                "content": content,\n                                "tool_calls": getattr(m, "tool_calls", None),\n                                "tool_call_id": getattr(m, "tool_call_id", None),\n                                "name": getattr(m, "name", None),\n                            })\n                        dump_path.write_text(\n                            json.dumps(entries, default=str, indent=2, ensure_ascii=False),\n                            encoding="utf-8",\n                        )\n                        print(f"[debug] [{n}] message history → outputs/_debug/{dump_path.name}")\n                    except Exception as e:\n                        print(f"[debug] [{n}] failed to dump message history: {e}")\n\n                    # Mandatory skill pipeline: each attached skill runs on the agent\'s\n                    # result in order; the last skill\'s produced deliverable (e.g. the html\n                    # skill\'s rendered HTML file) becomes this node\'s output.\n                    for _skill in ad.get("skills", []):\n                        text = await _run_skill_step(_skill, text, LLMS[n])\n                        print(f"[node] [{n}] after skill {_skill.get(\'dir\') or \'inline\'!r}: "\n                              f"{len(text)} chars", flush=True)\n\n                    return {"node_outputs": {n: {"source": ad["display"], "text": text}}}\n                return _run\n            sg.add_node(nid, make_agent())\n\n        elif ntype == "playbook":\n            def make_playbook(n=nid):\n                async def _run(state):\n                    pb = PLAYBOOKS[n]\n                    run = _PlaybookRun(bool(pb.get("writes_enabled")), pb.get("policy") or {})\n                    tools = build_playbook_tools(pb, run)\n                    print(f"[node] [{n}] {pb[\'display\']!r} playbook -- {len(tools)} tools "\n                          f"(provider={pb.get(\'provider\', \'?\')}, model={pb.get(\'model\', \'?\')}, "\n                          f"writes={\'on\' if run.writes_enabled else \'off\'})", flush=True)\n                    outs = state.get("node_outputs", {})\n                    inputs = [outs[p]["text"] for p in parents(n) if p in outs]\n                    request = "\\n\\n".join(inputs) or state.get("user_prompt", "")\n                    system = PLAYBOOK_SYSTEM_PROMPT.format(\n                        domain=pb.get("domain") or "this organization",\n                        instructions=pb["instructions"],\n                        policy_json=json.dumps(run.policy, ensure_ascii=False),\n                        requester_json=json.dumps(pb.get("requester") or {}, ensure_ascii=False),\n                        approvers_json=json.dumps(pb["approvers"], ensure_ascii=False) if pb.get("approvers") else "{}",\n                    )\n                    msgs = [SystemMessage(content=inject_datetime(system)),\n                            HumanMessage(content="REQUEST:\\n" + request)]\n                    agent = create_react_agent(LLMS[n], tools)\n                    t0 = time.monotonic()\n                    text = ""\n                    try:\n                        result = await agent.ainvoke({"messages": msgs},\n                                                     config={"recursion_limit": 2 * PLAYBOOK_MAX_ROUNDS + 1})\n                        final = result["messages"][-1]\n                        text = final.content if isinstance(final, AIMessage) else str(final)\n                        if isinstance(text, list):\n                            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))\n                    except Exception as e:\n                        run.status = "failed"\n                        run.emit(type="note", text=f"Round budget of {PLAYBOOK_MAX_ROUNDS} exhausted or run failed: {e}")\n                        print(f"[node] [{n}] ⚠ playbook failed: {e}", flush=True)\n                    dt = time.monotonic() - t0\n                    NODE_DURATIONS[pb["display"]] = NODE_DURATIONS.get(pb["display"], 0.0) + dt\n                    print(f"[node] [{n}] done -- status={run.status} ({len(run.events)} events, {dt:.1f}s)", flush=True)\n                    transcript = render_playbook_transcript(pb["title"], run.events, text, run.status)\n                    return {"node_outputs": {n: {"source": pb["display"], "text": transcript}}}\n                return _run\n            sg.add_node(nid, make_playbook())\n        elif ntype == "output":\n            def make_output(n=nid):\n                def _run(state):\n                    pids = parents(n)\n                    outs = state.get("node_outputs", {})\n                    if len(pids) == 1 and pids[0] in outs:\n                        final = outs[pids[0]]["text"]\n                    else:\n                        blocks = [f"## {outs[p][\'source\']}\\n\\n{outs[p][\'text\']}" for p in pids if p in outs]\n                        final = "\\n\\n---\\n\\n".join(blocks)\n                    print(f"[node] [{n}] output -- {len(final)} chars")\n                    return {"final_output": final}\n                return _run\n            sg.add_node(nid, make_output())\n\n        else:\n            sg.add_node(nid, lambda s: {})\n\n    # Wire edges. A dispatcher\'s menu children hang off a conditional edge:\n    # only the child named in state["routes"] runs (siblings are skipped).\n    pos = {n: i for i, n in enumerate(ORDER)}\n    sg.add_edge(START, ORDER[0])\n    for nid in ORDER:\n        menu = {t["id"] for t in AGENTS.get(nid, {}).get("dispatch", [])}\n        for child in children(nid):\n            if child in pos and pos[child] > pos[nid] and child not in menu:\n                sg.add_edge(nid, child)\n        if menu:\n            def make_router(n=nid):\n                def _route(state):\n                    return state.get("routes", {}).get(n) or END\n                return _route\n            sg.add_conditional_edges(nid, make_router(), {t: t for t in menu} | {END: END})\n    for nid in ORDER:\n        if not children(nid):\n            sg.add_edge(nid, END)\n\n    graph = sg.compile()\n    print("[info] Running...")\n    global _RUN_T0\n    _RUN_T0 = time.monotonic()\n    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})\n    return result.get("final_output", "")\n\n\nNODE_DURATIONS = {}   # display name -> seconds of LLM+skill work (RUN SUMMARY)\n_RUN_T0 = None\n\n\nif __name__ == "__main__":\n    prompt = " ".join(sys.argv[1:]) or DEFAULT_PROMPT or "Hello"\n    print(f"[info] Prompt: {prompt[:100]}{\'...\' if len(prompt) > 100 else \'\'}")\n    output = asyncio.run(run(prompt))\n    print("\\n" + "=" * 60)\n    print("FINAL OUTPUT")\n    print("=" * 60)\n    print(output)\n\n    # Honour the Output node\'s storage setting: when ON, save the final result where the\n    # app stores it (~/Documents/synergyAI/outputs/workflow/ by default, overridable via\n    # SYNERGYAI_OUTPUT_ROOT) or the workflow\'s custom folder; when OFF, don\'t save.\n    if OUTPUT_STORAGE_ENABLED:\n        try:\n            import os, time\n            import re as _re2\n            _mm = _re2.search(r"(?is)<!doctype html.*?</html\\s*>", output) or _re2.search(r"(?is)<html[\\s>].*?</html\\s*>", output)\n            if _mm:\n                output = _mm.group(0)  # strip narration/fences around a full HTML doc\n                _ext = "html"\n            else:\n                _ext = "md"\n            _slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"\n            _ts = time.strftime("%Y%m%d-%H%M%S")\n            _root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")\n            if OUTPUT_FOLDER:\n                _cf = os.path.expanduser(OUTPUT_FOLDER)\n                _save_dir = _cf if os.path.isabs(_cf) else os.path.join(_root, OUTPUT_FOLDER)\n            else:\n                _save_dir = os.path.join(_root, "workflow")\n            os.makedirs(_save_dir, exist_ok=True)\n            _out = os.path.join(_save_dir, f"{WORKFLOW_ID}-{_slug}_{_ts}.{_ext}")\n            with open(_out, "w", encoding="utf-8") as _f:\n                _f.write(output)\n            _saved_path = os.path.abspath(_out)\n        except Exception as e:\n            _saved_path = None\n            print(f"\\n[warn] failed to save result: {e}")\n    else:\n        _saved_path = None\n\n    # Closing RUN SUMMARY (printed LAST): time per node, total, document location.\n    import time as _t2\n    print("\\n" + "=" * 74)\n    print("RUN SUMMARY")\n    print("-" * 74)\n    if NODE_DURATIONS:\n        _w = max(len(k) for k in NODE_DURATIONS)\n        print("  Time per node:")\n        for _n, _s in sorted(NODE_DURATIONS.items(), key=lambda kv: -kv[1]):\n            print(f"    {_n:<{_w}}   {_s:7.1f}s")\n    if _RUN_T0 is not None:\n        print(f"  Total wall-clock: {_t2.monotonic() - _RUN_T0:.1f}s")\n    print(f"  Final output: {len(output)} chars")\n    if _saved_path:\n        print(f"  Document saved to: {_saved_path}")\n    else:\n        print("  Document not saved (output storage is OFF in the workflow settings) -- "\n              "the output is printed above.")\n    print("=" * 74)\n'
_DISPATCH_BLOCK = 'async def _run_dispatcher(n, ad, state, msgs, llm):\n    """Dispatcher agent (twin of DispatchRouting in the PHP runner): the model\n    MUST call route_to with one of the menu names; that child alone runs. The\n    child receives the dispatcher\'s original input plus the notes."""\n    targets = ad["dispatch"]\n    names = [t["name"] for t in targets]\n    route_args = create_model(\n        "RouteToArgs",\n        target=(Literal[tuple(names)], Field(..., description="Name of the agent to route to. MUST be one of the listed values.")),\n        notes=(str, Field("", description="Optional short note for the target agent (what you understood, what to focus on).")),\n    )\n    route_tool = StructuredTool.from_function(\n        func=lambda target, notes="": "routed",\n        name="route_to",\n        description=("REQUIRED tool to hand the request to exactly one downstream agent. Pick the agent "\n                     "whose role matches the request. Available targets: " + ", ".join(names)\n                     + ". The chosen agent receives the original request, plus your notes."),\n        args_schema=route_args,\n    )\n    llm = llm.bind_tools([route_tool], tool_choice="any")\n    t0 = time.monotonic()\n    resp = await llm.ainvoke(msgs)\n    dt = time.monotonic() - t0\n    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt\n    chosen, notes = None, ""\n    for call in getattr(resp, "tool_calls", None) or []:\n        if call.get("name") != "route_to":\n            continue\n        args = call.get("args") or {}\n        want = str(args.get("target", "")).strip().lower()\n        for t in targets:\n            if t["name"].strip().lower() == want:\n                chosen, notes = t, str(args.get("notes", "") or "").strip()\n                break\n        if chosen:\n            break\n    outs = state.get("node_outputs", {})\n    inputs = [outs[p]["text"] for p in parents(n) if p in outs]\n    task = "\\n\\n".join(inputs) or state.get("user_prompt", "")\n    if chosen is None:\n        msg = (f"Error: dispatcher {ad[\'display\']!r} did not route the request. "\n               f"Expected route_to with one of: {\', \'.join(names)}.")\n        print(f"[node] [{n}] ⚠ {msg}", flush=True)\n        return {"node_outputs": {n: {"source": ad["display"], "text": msg}}, "routes": {n: END}, "final_output": msg}\n    print(f"[node] [{n}] {ad[\'display\']!r} routed to {chosen[\'name\']!r} ({dt:.1f}s)"\n          + (f" -- notes: {notes[:120]!r}" if notes else ""), flush=True)\n    text = task + (f"\\n\\n## Dispatcher notes\\n{notes}" if notes else "")\n    return {"node_outputs": {n: {"source": ad["display"], "text": text}}, "routes": {n: chosen["id"]}}\n\n'
_PLAYBOOK_RUNTIME_BLOCK = '# ---------------------------------------------------------------------------\n# PLAYBOOK RUNTIME\n#\n# The LLM re-decides each round from the running transcript of tool calls\n# (no pre-computed action queue). Tools it sees: the native verbs, the human\n# gates, one tool per bound #Action (MCP, write-policed) and a stub per\n# unbound #Action. The node output is the same Markdown transcript the app\'s\n# run overlay shows, so downstream nodes get the story either way.\n# ---------------------------------------------------------------------------\nPLAYBOOK_MAX_ROUNDS = 40\n\nPLAYBOOK_SYSTEM_PROMPT = """You are a playbook interpreter for {domain}. Execute the PLAYBOOK below\nfor the current REQUEST, step by step, using ONLY the tools provided.\nRules:\n- Never invent tool results, user input, or tools. If information from the requester\n  is missing, you must obtain it through the provided tools; if an action has no\n  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.\n- Take parameters for later steps from earlier tool results.\n- When the playbook says Stop or the work is complete, call resolve_request.\n- Record what you did with leave_internal_note before resolving, as the playbook asks.\nPLAYBOOK:\n{instructions}\nPOLICY: {policy_json}\nREQUESTER: {requester_json}\nAPPROVERS: {approvers_json}"""\n\n# Fail-closed write classifier: a tool is a WRITE unless its name is recognizably read-only.\n_PB_READ_VERB_RE = re.compile(r"^(?:[a-z0-9]+_)?(get|list|search|read|find|describe|verify|check|lookup)(_|$)", re.I)\n\n_PB_GATES = {\n    "trigger_form": ("form", "Present a form to the requester and wait for it to be submitted"),\n    "request_approval": ("approval", "Ask an approver to approve or deny an action and wait for their decision"),\n    "prompt_handoff": ("handoff", "Hand off to a human team or person and wait for their response"),\n    "await_message": ("await_message", "Wait for a message from the requester before continuing"),\n}\n_PB_GATE_FIELDS = {\n    "trigger_form": {"prompt": (str, True, "Instructions shown above the form"),\n                     "fields": (list[dict], True, "Form fields to collect: [{name, label, type, options?, sensitive?}]")},\n    "request_approval": {"approver": (str, True, "Who must approve"), "question": (str, True, "What is being approved"),\n                         "context": (str, False, "Supporting context for the decision")},\n    "prompt_handoff": {"team_or_person": (str, True, "Who to hand off to"), "reason": (str, True, "Why this needs a human"),\n                       "summary": (str, False, "Summary of the situation so far")},\n    "await_message": {"prompt": (str, True, "What to wait for")},\n}\n\n\nclass _PlaybookRun:\n    """Per-node run record: event timeline (twin of the run overlay), status, write ledger."""\n    def __init__(self, writes_enabled: bool, policy: dict):\n        self.events = []\n        self.status = "running"\n        self.writes_enabled = writes_enabled\n        self.policy = policy\n        self.ledger = {}\n\n    def emit(self, **ev):\n        self.events.append(ev)\n\n\ndef _playbook_gate(run, kind: str, name: str, args: dict) -> dict:\n    """Human gate. On an interactive terminal the question is asked on the console.\n    Otherwise (runner / batch) PLAYBOOK_GATE_MODE decides: auto (default) approves\n    approvals and acknowledges handoffs, deny denies, prompt forces the console."""\n    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or ("prompt" if sys.stdin.isatty() else "auto")\n    what = args.get("question") or args.get("prompt") or args.get("reason") or ""\n    run.emit(type="gate_request", kind=kind, payload=dict(args))\n    if mode == "prompt":\n        print(f"\\n✋ [{kind}] {what}", flush=True)\n        if kind == "approval":\n            ans = input("approve/deny [comment]: ").strip()\n            decision = "denied" if ans.lower().startswith("d") else "approved"\n            comment = ans.split(" ", 1)[1] if " " in ans else ""\n            return {"ok": True, "decision": {"decision": decision, "comment": comment, "actor": "console"}}\n        ans = input("your answer: ").strip()\n        return {"ok": True, "decision": {"decision": "answered", "comment": ans, "actor": "console"}}\n    if mode == "deny":\n        return {"ok": True, "decision": {"decision": "denied", "comment": "denied by PLAYBOOK_GATE_MODE=deny", "actor": "policy"}}\n    if kind == "approval":\n        return {"ok": True, "decision": {"decision": "approved", "comment": "auto-approved (non-interactive run)", "actor": "policy"}}\n    if kind == "handoff":\n        return {"ok": True, "decision": {"decision": "acknowledged", "comment": "handed off; no human available in this non-interactive run", "actor": "policy"}}\n    return {"ok": False, "timeout": True,\n            "guidance": "No human is available in this non-interactive run. Continue with what you already know "\n                        "and note the gap with leave_internal_note."}\n\n\ndef build_playbook_tools(pb: dict, run: _PlaybookRun) -> list:\n    """The whitelisted tool surface for one playbook run (twin of PlaybookActionSpace)."""\n    type_map = {"string": str, "integer": int, "number": float, "boolean": bool, "array": list, "object": dict}\n    tools = []\n\n    def model(name, fields):\n        return create_model(name + "Args", **{p: (t, Field(... if req else None, description=d))\n                                              for p, (t, req, d) in fields.items()})\n\n    def wrap(name, fn, description, args_model):\n        def invoke(**kwargs):\n            run.emit(type="tool_call", name=name, args=kwargs)\n            preview = json.dumps(kwargs, default=str, ensure_ascii=False)\n            print(f"  [playbook] -> {name}({preview[:200]}{\'...\' if len(preview) > 200 else \'\'})", flush=True)\n            result = fn(**kwargs)\n            run.emit(type="tool_result", name=name, result=result)\n            ok = result.get("ok", True) is not False\n            detail = str(result.get("error") or result.get("guidance") or result.get("decision") or "")\n            print(f"  [playbook] <- {name}: {\'✓\' if ok else \'✗\'} {detail[:160]}", flush=True)\n            return json.dumps(result, default=str, ensure_ascii=False)\n        return StructuredTool.from_function(func=invoke, name=name, description=description, args_schema=args_model)\n\n    # Native verbs: always available, no binding needed.\n    def message(**a):\n        run.emit(type="message", text=str(a.get("text", "")), sensitive=bool(a.get("sensitive", False)))\n        return {"ok": True}\n    tools.append(wrap("send_direct_message", message, "Send a direct message to the requester",\n                      model("SendDirectMessage", {"text": (str, True, "Message text"),\n                                                  "sensitive": (bool, False, "Mark as sensitive for redaction")})))\n    tools.append(wrap("send_channel_message", message, "Post a message in a channel",\n                      model("SendChannelMessage", {"channel": (str, True, "Channel name"), "text": (str, True, "Message text")})))\n    tools.append(wrap("send_email", message, "Send an email",\n                      model("SendEmail", {"to": (str, True, "Email recipient"), "subject": (str, True, "Email subject"),\n                                          "text": (str, True, "Email body")})))\n\n    def note(**a):\n        run.emit(type="note", text=str(a.get("text", "")))\n        return {"ok": True}\n    tools.append(wrap("leave_internal_note", note, "Leave an internal note on the request record",\n                      model("LeaveInternalNote", {"text": (str, True, "Note text")})))\n\n    def priority(**a):\n        run.emit(type="note", text=f"priority → {a.get(\'priority\', \'\')}: {a.get(\'reason\', \'\')}")\n        return {"ok": True}\n    tools.append(wrap("set_priority", priority, "Set the request priority (escalation)",\n                      model("SetPriority", {"priority": (str, True, "Priority level"), "reason": (str, True, "Reason for priority")})))\n\n    def resolve(**a):\n        run.status = "resolved"\n        return {"ok": True, "terminal": True}\n    tools.append(wrap("resolve_request", resolve, "Mark the request as resolved",\n                      model("ResolveRequest", {"outcome": (str, True, "Resolution outcome"), "summary": (str, True, "Resolution summary")})))\n\n    # Human gates.\n    for gname, (kind, desc) in _PB_GATES.items():\n        def gate_fn(_kind=kind, _name=gname, **a):\n            return _playbook_gate(run, _kind, _name, a)\n        tools.append(wrap(gname, gate_fn, desc, model(gname, _PB_GATE_FIELDS[gname])))\n\n    # Bound MCP actions (write-policed) and unbound stubs.\n    for act in pb.get("actions", []):\n        if act.get("kind") != "mcp":\n            def unbound_fn(**a):\n                pol = run.policy.get("on_unbound", "handoff")\n                if pol == "skip":\n                    return {"ok": False, "unbound": True, "skipped": True,\n                            "guidance": "This action is unavailable and the policy says skip it: note it in the internal record and continue with the rest of the playbook."}\n                if pol == "fail":\n                    return {"ok": False, "unbound": True, "fatal": True,\n                            "guidance": "This action is unavailable and the policy says fail: leave an internal note and resolve the request as not completed."}\n                return {"ok": False, "unbound": True, "policy": pol,\n                        "guidance": "This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done."}\n            tools.append(wrap(act["llm_name"], unbound_fn,\n                              f"{act[\'action_name\']}: NOT AVAILABLE — calling this applies the on_unbound policy",\n                              create_model(act["llm_name"] + "Args")))\n            continue\n        schema = act.get("input_schema") or {}\n        props = schema.get("properties", {}) if isinstance(schema, dict) else {}\n        required = set(schema.get("required", []) if isinstance(schema, dict) else [])\n        fields = {}\n        for pname, pspec in props.items():\n            spec = pspec if isinstance(pspec, dict) else {}\n            fields[pname] = (type_map.get(spec.get("type", "string"), str), pname in required, spec.get("description", ""))\n        is_write = _PB_READ_VERB_RE.match(act["tool"]) is None\n\n        def mcp_fn(_act=act, _write=is_write, **a):\n            key = _act["target"] + "|" + json.dumps(a, sort_keys=True, default=str)\n            if _write and key in run.ledger:\n                return {"ok": True, "outcome": "replayed", "result": run.ledger[key]}\n            if _write and not run.writes_enabled:\n                return {"ok": False, "error": "writes disabled by policy"}\n            raw = _call_mcp_tool(_act["server_url"], _act["tool"], a)\n            try:\n                parsed = json.loads(raw)\n            except Exception:\n                parsed = raw\n            error = parsed.get("error") if isinstance(parsed, dict) else None\n            if error:\n                return {"ok": False, "error": str(error)}\n            if _write:\n                run.ledger[key] = parsed\n            return {"ok": True, "result": parsed}\n        desc = act["action_name"] + (" — " + act["description"] if act.get("description") else "")\n        tools.append(wrap(act["llm_name"], mcp_fn, desc, model(act["llm_name"], fields)))\n    return tools\n\n\ndef render_playbook_transcript(title: str, events: list, final: str, status: str) -> str:\n    """Markdown transcript, twin of PlaybookNodeRunner::renderTranscript() (PHP)."""\n    gate_titles = {"approval": "Approval requested", "form": "Form request", "handoff": "Handed off to a human",\n                   "await_message": "Waiting for the requester", "wait": "Waiting"}\n    gate_tools = {"request_approval", "trigger_form", "prompt_handoff", "await_message", "wait_until"}\n    lines, pending = [], {}\n\n    def s(v):\n        if isinstance(v, str):\n            return v.strip()\n        return "" if v is None else json.dumps(v, ensure_ascii=False)\n\n    for ev in events:\n        t = ev.get("type")\n        if t == "tool_call":\n            name = ev.get("name", "tool")\n            if name in gate_tools:\n                continue\n            lines.append(f"- 🔧 {name} …")\n            pending[name] = len(lines) - 1\n        elif t == "tool_result":\n            name = ev.get("name", "tool")\n            res = ev.get("result") if isinstance(ev.get("result"), dict) else {}\n            if name in gate_tools:\n                d = res.get("decision", res.get("status", ""))\n                if isinstance(d, dict):\n                    res = {**d, **res}\n                    d = d.get("decision", d.get("status", d.get("outcome", "answered")))\n                decision, comment = s(d), s(res.get("comment", ""))\n                if decision:\n                    lines.append(f"  → {decision}" + (f" ({comment})" if comment else ""))\n                continue\n            ok = res.get("ok", True) is not False\n            mark = "✓" if ok else "✗"\n            suffix = (" — " + s(res.get("error"))) if (not ok and res.get("error")) else ""\n            if name in pending:\n                lines[pending.pop(name)] = f"- 🔧 {name} {mark}{suffix}"\n            else:\n                lines.append(f"- 🔧 {name} {mark}")\n        elif t == "message":\n            text = "(message redacted)" if ev.get("sensitive") else s(ev.get("text", ""))\n            if text:\n                lines.append("- 💬 Playbook:\\n" + "\\n".join("  " + l for l in text.split("\\n")))\n        elif t == "gate_request":\n            kind = ev.get("kind", "gate")\n            p = ev.get("payload") or {}\n            what = s(p.get("question") or p.get("prompt")\n                     or (s(p.get("team_or_person", "")) + (" — " + s(p.get("reason")) if p.get("reason") else "")))\n            lines.append("- ✋ " + gate_titles.get(kind, kind.capitalize()) + (f": {what}" if what else ""))\n    out = f"# Playbook: {title} ({status})\\n\\n## Timeline\\n" + ("\\n".join(lines) if lines else "- (no steps recorded)")\n    if final.strip():\n        out += "\\n\\n## Result\\n" + final.strip()\n    return out + f"\\n\\n[playbook run: {status}]"\n\n'
_A2A_ORCHESTRATOR_DATA_FLOW_DOC = "The orchestrator owns the graph and the human; the agents own the models,\ntools and playbooks. Every agent node is one A2A task on that node's\nserver: the orchestrator sends the framed input (original prompt + labelled\nparent outputs), relays status updates, answers gates, and takes the\n'result' artifact as the node output. A dispatcher's chosen child comes back\nin the artifact's data part and drives a LangGraph conditional edge, so only\nthat child runs. Start and Output nodes are local (no LLM)."
_A2A_ORCHESTRATOR_BLOCK = '# ==============================================================\n# AGENT SUPERVISOR\n# Starts one python process per local agent, relays its stdout with a\n# [<agent>] prefix, waits for the Agent Card, stops them at the end.\n# ==============================================================\ndef agent_url(nid: str) -> str:\n    """The agent\'s base URL: env A2A_AGENT_<id>_URL wins, else the baked port shifted\n    by A2A_BASE_PORT. AGENTS[nid]["port"] (8701 + index, baked at generation time) is\n    authoritative; A2A_BASE_PORT - 8701 is added so overriding the env var still moves\n    the WHOLE range together instead of only affecting agents with no baked port."""\n    env = os.environ.get(f"A2A_AGENT_{nid}_URL", "").strip()\n    if env:\n        return env\n    port = AGENTS[nid]["port"] + (A2A_BASE_PORT - 8701)\n    return f"http://127.0.0.1:{port}/"\n\n\ndef _is_local(url: str) -> bool:\n    """True when `url` is a loopback address the supervisor can spawn and own."""\n    return url.startswith("http://127.0.0.1") or url.startswith("http://localhost")\n\n\nclass AgentSupervisor:\n    """Owns the agent subprocesses for one run."""\n    def __init__(self, spawn: bool = True):\n        self.spawn = spawn\n        self.procs: dict[str, subprocess.Popen] = {}\n\n    def start(self) -> None:\n        """Spawn every local agent whose URL is ours to serve, then wait for all cards (60 s).\n\n        Two checks guard against silently adopting an orphaned/stale process on\n        what should be OUR port:\n          1. proc.poll() is checked BEFORE trusting any 200 from the card\n             endpoint. If we spawned this agent and it has already exited, the\n             port was unusable (most likely already bound by something else)\n             -- raise immediately naming the agent, its exit code and the port,\n             instead of a 200 we did not send being mistaken for readiness.\n          2. When a card DOES answer 200, its "version" field is compared to\n             WORKFLOW_VERSION (the same literal every agent file bakes via\n             a2aVersion() -- see emitA2AAgentFile). A mismatch means the port\n             is already serving a different generation of this workflow (or a\n             leftover process from before a regenerate); raise instead of\n             running the graph against stale agent code.\n        """\n        for nid, ad in AGENTS.items():\n            url = agent_url(nid)\n            if not (self.spawn and _is_local(url)):\n                continue\n            port = int(url.rsplit(":", 1)[1].strip("/"))\n            path = os.path.join(_HERE, ad["file"])\n            proc = subprocess.Popen([sys.executable, "-u", path, "--port", str(port)], cwd=_HERE,\n                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)\n            self.procs[nid] = proc\n            threading.Thread(target=self._relay, args=(ad["display"], proc), daemon=True).start()\n        deadline = time.monotonic() + 60\n        for nid in AGENTS:\n            url = agent_url(nid)\n            port = int(url.rstrip("/").rsplit(":", 1)[1])\n            while True:\n                proc = self.procs.get(nid)\n                if proc is not None and proc.poll() is not None:\n                    # Checked BEFORE the http GET below: a spawned child that already\n                    # exited means the port was busy (or the agent crashed) -- a 200\n                    # from that port, if one ever came, would be someone else\'s server.\n                    raise RuntimeError(f"agent {AGENTS[nid][\'display\']!r} exited with code {proc.returncode} before serving {url} (port {port} may already be in use)")\n                status, card = None, None\n                try:\n                    resp = httpx.get(url.rstrip("/") + "/.well-known/agent-card.json", timeout=2)\n                    status = resp.status_code\n                    if status == 200:\n                        card = resp.json() or {}\n                except Exception:\n                    pass\n                if status == 200:\n                    served = card.get("version") if card else None\n                    if served != WORKFLOW_VERSION:\n                        raise RuntimeError(f"port {port} is already serving a different agent version ({served} != {WORKFLOW_VERSION}); stop the stale process")\n                    break\n                if time.monotonic() > deadline:\n                    raise RuntimeError(f"agent {AGENTS[nid][\'display\']!r} did not serve its card at {url} within 60s")\n                time.sleep(0.3)\n            print(f"[supervisor] {AGENTS[nid][\'display\']!r} ready at {url}", flush=True)\n\n    @staticmethod\n    def _relay(name: str, proc: subprocess.Popen) -> None:\n        """Copy an agent\'s stdout to ours, line by line, prefixed with its name."""\n        for line in proc.stdout:\n            print(f"[{name}] {line.rstrip()}", flush=True)\n\n    def stop(self) -> None:\n        """Terminate the agents we started (5 s grace, then kill)."""\n        for nid, proc in self.procs.items():\n            if proc.poll() is None:\n                proc.terminate()\n        for nid, proc in self.procs.items():\n            try:\n                proc.wait(5)\n            except subprocess.TimeoutExpired:\n                proc.kill()\n        if self.procs:\n            print("[supervisor] agents stopped", flush=True)\n\n\n# ==============================================================\n# GATE HANDLER\n# An agent\'s input-required status reaches the human here. Terminal:\n# ask on the console. Otherwise PLAYBOOK_GATE_MODE: auto (default) approves\n# approvals and acknowledges handoffs, forms/await are \'unavailable\';\n# deny denies; prompt forces the console. Every gate and answer is also\n# printed as a JSON line so the app can render them.\n# ==============================================================\ndef _handle_gate(agent_name: str, task_id: str, gate: dict) -> dict:\n    """Return the answer data part for one gate: {decision, comment, fields?}."""\n    kind = str(gate.get("gate") or "gate")\n    args = gate.get("args") or {}\n    question = args.get("question") or args.get("prompt") or args.get("reason") or kind\n    print("[gate] " + json.dumps({"agent": agent_name, "task": task_id, "kind": kind, "question": question, "args": args}, ensure_ascii=False), flush=True)\n    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or ("prompt" if sys.stdin.isatty() else "auto")\n    if mode == "prompt":\n        print(f"\\n✋ [{agent_name}] {kind}: {question}", flush=True)\n        if kind == "approval":\n            ans = input("approve/deny [comment]: ").strip()\n            answer = {"decision": "denied" if ans.lower().startswith("d") else "approved",\n                      "comment": ans.split(" ", 1)[1] if " " in ans else "", "actor": "console"}\n        elif kind == "form":\n            fields = {}\n            for f in args.get("fields") or []:\n                if isinstance(f, dict) and f.get("name"):\n                    fields[f["name"]] = input(f"  {f.get(\'label\') or f[\'name\']}: ").strip()\n            answer = {"decision": "submitted", "fields": fields, "actor": "console"}\n        else:\n            answer = {"decision": "answered", "comment": input("your answer: ").strip(), "actor": "console"}\n    elif mode == "deny":\n        answer = {"decision": "denied", "comment": "denied by PLAYBOOK_GATE_MODE=deny", "actor": "policy"}\n    elif kind == "approval":\n        answer = {"decision": "approved", "comment": "auto-approved (non-interactive run)", "actor": "policy"}\n    elif kind == "handoff":\n        answer = {"decision": "acknowledged", "comment": "handed off; no human available in this non-interactive run", "actor": "policy"}\n    else:\n        answer = {"decision": "unavailable", "comment": "no human available in this non-interactive run", "actor": "policy"}\n    print("[gate-answer] " + json.dumps({"agent": agent_name, "task": task_id, **answer}, ensure_ascii=False), flush=True)\n    return answer\n\n\n# ==============================================================\n# REMOTE NODE RUNNER\n# One A2A task per agent node: send, stream, answer gates, collect the\n# \'result\' artifact.\n# ==============================================================\ndef _stream_kind(ev: "T.StreamResponse") -> str:\n    """Which oneof field is set on this streaming response, or "" if none is."""\n    for k in ("task", "message", "status_update", "artifact_update"):\n        if ev.HasField(k):\n            return k\n    return ""\n\n\nasync def _run_remote_node(nid: str, request_text: str) -> dict:\n    """Run node `nid` on its A2A server. Returns {"text", "route", "notes", "status"}."""\n    ad = AGENTS[nid]\n    url = agent_url(nid)\n    t0 = time.monotonic()\n    text_parts: list[str] = []\n    data: dict = {}\n    async with httpx.AsyncClient(timeout=None) as hc:\n        client = await create_client(url, ClientConfig(streaming=True, httpx_client=hc))\n        req = T.SendMessageRequest(message=T.Message(message_id=str(uuid.uuid4()), role=T.Role.ROLE_USER, parts=[T.Part(text=request_text)]))\n        task_id = ctx_id = None\n        pending = req\n        while pending is not None:\n            gate_payload = None\n            async for ev in client.send_message(pending):\n                kind = _stream_kind(ev)\n                if kind == "task":\n                    task_id, ctx_id = ev.task.id, ev.task.context_id\n                elif kind == "status_update":\n                    su = ev.status_update\n                    task_id, ctx_id = su.task_id, su.context_id\n                    if su.status.HasField("message"):\n                        for line in get_text_parts(su.status.message.parts):\n                            if line and su.status.state != T.TaskState.TASK_STATE_INPUT_REQUIRED:\n                                print(f"[{ad[\'display\']}] {line}", flush=True)\n                    if su.status.state == T.TaskState.TASK_STATE_INPUT_REQUIRED:\n                        parts = get_data_parts(su.status.message.parts) if su.status.HasField("message") else []\n                        gate_payload = dict(parts[0]) if parts and isinstance(parts[0], dict) else {"gate": "gate", "args": {}}\n                        break\n                    if su.status.state in (T.TaskState.TASK_STATE_FAILED, T.TaskState.TASK_STATE_CANCELED, T.TaskState.TASK_STATE_REJECTED):\n                        raise RuntimeError(f"agent {ad[\'display\']!r} task {task_id} ended in {T.TaskState.Name(su.status.state)}")\n                elif kind == "artifact_update":\n                    art = ev.artifact_update.artifact\n                    text_parts.extend(get_text_parts(art.parts))\n                    for d in get_data_parts(art.parts):\n                        if isinstance(d, dict):\n                            data.update(d)\n            if gate_payload is None:\n                pending = None\n            else:\n                answer = _handle_gate(ad["display"], task_id, gate_payload)\n                pending = T.SendMessageRequest(message=T.Message(message_id=str(uuid.uuid4()), task_id=task_id, context_id=ctx_id, role=T.Role.ROLE_USER,\n                                                                 parts=[T.Part(text=str(answer.get("decision", ""))), new_data_part(answer)]))\n        await client.close()\n    dt = time.monotonic() - t0\n    NODE_DURATIONS[ad["display"]] = NODE_DURATIONS.get(ad["display"], 0.0) + dt\n    print(f"[node] [{nid}] {ad[\'display\']!r} done over A2A -- {sum(len(t) for t in text_parts)} chars ({dt:.1f}s)", flush=True)\n    return {"text": "\\n".join(text_parts), "route": str(data.get("route") or ""), "notes": str(data.get("notes") or ""), "status": str(data.get("status") or "ok")}\n\n\n# ==============================================================\n# MAIN EXECUTION -- the LangGraph state graph over A2A tasks\n# ==============================================================\nNODE_DURATIONS = {}   # display name -> seconds of A2A round trip (RUN SUMMARY)\n_RUN_T0 = None\n\n\nasync def run(user_prompt: str) -> str:\n    """Build the graph (agent nodes call their A2A servers), run it, return the final output."""\n    sg = StateGraph(WFState)\n    for nid in ORDER:\n        ntype = NODE_TYPES.get(nid, "")\n        if ntype == "start":\n            def make_start(n=nid):\n                def _run(state):\n                    text = state.get("user_prompt", "")\n                    if START_DOCUMENTS:\n                        doc_parts = []\n                        for doc in START_DOCUMENTS:\n                            name = doc.get("name", "Document")\n                            path = doc.get("path", "")\n                            try:\n                                doc_parts.append(f"### {name}\\n\\n{_convert_doc_to_markdown(path)}")\n                            except Exception as e:\n                                doc_parts.append(f"### {name}\\n\\n_(conversion failed: {e})_")\n                        text = "## Attached Documents\\n\\n" + "\\n\\n---\\n\\n".join(doc_parts) + "\\n\\n---\\n\\n" + text\n                    print(f"[node] [{n}] start -- {len(text)} chars", flush=True)\n                    return {"node_outputs": {n: {"source": "start", "text": text}}}\n                return _run\n            sg.add_node(nid, make_start())\n        elif ntype in ("agent", "playbook"):\n            def make_remote(n=nid):\n                async def _run(state):\n                    ad = AGENTS[n]\n                    outs = state.get("node_outputs", {})\n                    if ad["kind"] == "playbook":\n                        inputs = [outs[p]["text"] for p in parents(n) if p in outs]\n                        request = "\\n\\n".join(inputs) or state.get("user_prompt", "")\n                    else:\n                        request = build_context(state.get("user_prompt", ""), parents(n), outs)\n                    out = await _run_remote_node(n, request)\n                    result = {"node_outputs": {n: {"source": ad["display"], "text": out["text"]}}}\n                    if ad["dispatch"]:\n                        # Dispatcher: the agent chose a child (or none) -> conditional edge input.\n                        route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END\n                        if route == END:\n                            print(f"[node] [{n}] ⚠ dispatcher did not route; ending the run", flush=True)\n                            result["final_output"] = out["text"]\n                        result["routes"] = {n: route}\n                    return result\n                return _run\n            sg.add_node(nid, make_remote())\n        elif ntype == "output":\n            def make_output(n=nid):\n                def _run(state):\n                    pids = parents(n)\n                    outs = state.get("node_outputs", {})\n                    if len(pids) == 1 and pids[0] in outs:\n                        final = outs[pids[0]]["text"]\n                    else:\n                        blocks = [f"## {outs[p][\'source\']}\\n\\n{outs[p][\'text\']}" for p in pids if p in outs]\n                        final = "\\n\\n---\\n\\n".join(blocks)\n                    print(f"[node] [{n}] output -- {len(final)} chars", flush=True)\n                    return {"final_output": final}\n                return _run\n            sg.add_node(nid, make_output())\n        else:\n            sg.add_node(nid, lambda s: {})\n    # Wire edges; a dispatcher\'s menu children hang off a conditional edge (only the chosen one runs).\n    pos = {n: i for i, n in enumerate(ORDER)}\n    sg.add_edge(START, ORDER[0])\n    for nid in ORDER:\n        menu = {t["id"] for t in AGENTS.get(nid, {}).get("dispatch", [])}\n        for child in children(nid):\n            if child in pos and pos[child] > pos[nid] and child not in menu:\n                sg.add_edge(nid, child)\n        if menu:\n            def make_router(n=nid):\n                def _route(state):\n                    return state.get("routes", {}).get(n) or END\n                return _route\n            sg.add_conditional_edges(nid, make_router(), {t: t for t in menu} | {END: END})\n    for nid in ORDER:\n        if not children(nid):\n            sg.add_edge(nid, END)\n    graph = sg.compile()\n    print("[info] Running...", flush=True)\n    global _RUN_T0\n    _RUN_T0 = time.monotonic()\n    result = await graph.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})\n    return result.get("final_output", "")\n\n\ndef _save_output(output: str) -> str | None:\n    """Honour the Output node\'s storage setting (same rule as the single-file script)."""\n    if not OUTPUT_STORAGE_ENABLED:\n        return None\n    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")\n    folder = OUTPUT_FOLDER or os.path.join(root, "workflow")\n    if not os.path.isabs(folder):\n        folder = os.path.join(root, folder)\n    os.makedirs(folder, exist_ok=True)\n    m = re.search(r"(?is)<!doctype html.*?</html\\s*>", output) or re.search(r"(?is)<html[\\s>].*?</html\\s*>", output)\n    ext = "html" if m else "md"\n    slug = "".join(c if c.isalnum() else "-" for c in WORKFLOW_NAME.lower()).strip("-")[:40]\n    path = os.path.join(folder, f"{WORKFLOW_ID}-{slug}_{time.strftime(\'%Y%m%d-%H%M%S\')}.{ext}")\n    with open(path, "w", encoding="utf-8") as fh:\n        fh.write(m.group(0) if m else output)\n    return path\n\n\nif __name__ == "__main__":\n    ap = argparse.ArgumentParser(description=f"A2A orchestrator for workflow {WORKFLOW_NAME!r}")\n    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")\n    ap.add_argument("--keep-serving", action="store_true", help="leave the agent servers running after the run")\n    ap.add_argument("--no-spawn", action="store_true", help="do not start agents; expect their URLs to be reachable")\n    a = ap.parse_args()\n    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"\n    print(f"[info] Prompt: {prompt[:100]}{\'...\' if len(prompt) > 100 else \'\'}", flush=True)\n    sup = AgentSupervisor(spawn=not a.no_spawn)\n    try:\n        sup.start()\n        output = asyncio.run(run(prompt))\n    finally:\n        if not a.keep_serving:\n            sup.stop()\n    print("\\n" + "=" * 60 + "\\nFINAL OUTPUT\\n" + "=" * 60 + "\\n" + output, flush=True)\n    saved = _save_output(output)\n    print("\\n" + "=" * 74 + "\\nRUN SUMMARY\\n" + "-" * 74, flush=True)\n    if NODE_DURATIONS:\n        w = max(len(n) for n in NODE_DURATIONS)\n        print("  Time per node (A2A round trip):", flush=True)\n        for name, secs in sorted(NODE_DURATIONS.items(), key=lambda kv: -kv[1]):\n            print(f"    {name:<{w}}   {secs:7.1f}s", flush=True)\n    print(f"  Total wall-clock: {time.monotonic() - _RUN_T0:.1f}s" if _RUN_T0 else "  Total wall-clock: n/a", flush=True)\n    print(f"  Final output: {len(output)} chars", flush=True)\n    print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)\n    print("=" * 74, flush=True)'
_A2A_AGENT_DATA_FLOW_DOC = 'This file serves ONE node of the workflow as an A2A agent. The orchestrator\n(orchestrator.py in the parent folder) builds the node input, sends it as a\ntask, streams the status updates, answers gates, and reads the result\nartifact. Inside this process the node runs exactly as in the single-file\nscript: an AGENT node = LangChain ReAct loop over its MCP tools plus\nmandatory skill steps; a DISPATCHER node = one forced route_to call whose\nchoice travels back as the artifact\'s "route"; a PLAYBOOK node = the playbook\nruntime (native verbs, gates, write-policed MCP actions), whose transcript is\nthe text part of the result.'
_A2A_NODE_LOGIC_BLOCK = '# ==============================================================\n# NODE LOGIC\n# run_node() executes this node once for one request text and returns\n# {"text", "route", "notes", "status"}. It is the single-file script\'s\n# node function with the LangGraph state replaced by plain arguments.\n# ==============================================================\nPLAYBOOK_MAX_ROUNDS = 40\n\n\ndef _llm():\n    """The chat model for this node, built from NODE (provider/model/sampling/thinking)."""\n    return _make_llm(NODE["provider"], NODE["model"], float(NODE["temperature"]), int(NODE["max_tokens"]), thinking=NODE.get("thinking"))\n\n\nasync def run_node(request_text: str, trace) -> dict:\n    """Run the node on `request_text` (the orchestrator\'s framed input).\n\n    trace(line) is an async callback that reports progress to the A2A client.\n    Returns {"text": str, "route": str|"" , "notes": str, "status": str}.\n    Exceptions propagate to the executor, which fails the task.\n    """\n    kind = NODE["kind"]\n    if kind == "playbook":\n        return await _run_playbook_kind(request_text, trace)\n    catalog = build_tools_from_catalog()\n    catalog["run_skill_script"] = RUN_SKILL_SCRIPT_TOOL   # local (non-MCP) tool, same as the single-file script\n    tools = [catalog[t] for t in NODE["tool_names"] if t in catalog]\n    msgs = [SystemMessage(content=inject_datetime(NODE["system_prompt"])), HumanMessage(content=request_text)]\n    await trace(f"{NODE[\'display\']!r} -- {len(tools)} tools (provider={NODE[\'provider\']}, model={NODE[\'model\']})")\n    if kind == "dispatcher":\n        return await _run_dispatcher_kind(request_text, msgs)\n    agent = create_react_agent(_llm(), tools)\n    result = await agent.ainvoke({"messages": msgs})\n    final = result["messages"][-1]\n    text = final.content if isinstance(final, AIMessage) else str(final)\n    if isinstance(text, list):\n        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))\n    for skill in NODE.get("skills", []):\n        text = await _run_skill_step(skill, text, _llm())\n        await trace(f"after skill {skill.get(\'dir\') or \'inline\'!r}: {len(text)} chars")\n    return {"text": text, "route": "", "notes": "", "status": "ok"}\n\n\nasync def _run_dispatcher_kind(request_text: str, msgs) -> dict:\n    """Dispatcher: one forced route_to call; the chosen child id travels back as "route"."""\n    ad = {"display": NODE["display"], "dispatch": NODE["dispatch"]}\n    state = {"node_outputs": {}, "user_prompt": request_text}\n    out = await _run_dispatcher("self", ad, state, msgs, _llm())\n    route = out.get("routes", {}).get("self", "")\n    text = out["node_outputs"]["self"]["text"]\n    notes = text.split("## Dispatcher notes\\n", 1)[1] if "## Dispatcher notes\\n" in text else ""\n    return {"text": text, "route": "" if route == END else str(route), "notes": notes, "status": "ok" if route != END else "unrouted"}\n\n\nasync def _run_playbook_kind(request_text: str, trace) -> dict:\n    """Playbook: the playbook runtime; gates go through _a2a_gate (see the A2A block)."""\n    run = _PlaybookRun(bool(NODE.get("writes_enabled")), NODE.get("policy") or {})\n    tools = build_playbook_tools(NODE, run)\n    await trace(f"{NODE[\'display\']!r} playbook -- {len(tools)} tools (writes={\'on\' if run.writes_enabled else \'off\'})")\n    system = PLAYBOOK_SYSTEM_PROMPT.format(\n        domain=NODE.get("domain") or "this organization", instructions=NODE["instructions"],\n        policy_json=json.dumps(run.policy, ensure_ascii=False),\n        requester_json=json.dumps(NODE.get("requester") or {}, ensure_ascii=False),\n        approvers_json=json.dumps(NODE["approvers"], ensure_ascii=False) if NODE.get("approvers") else "{}")\n    msgs = [SystemMessage(content=inject_datetime(system)), HumanMessage(content="REQUEST:\\n" + request_text)]\n    agent = create_react_agent(_llm(), tools)\n    text = ""\n    try:\n        result = await agent.ainvoke({"messages": msgs}, config={"recursion_limit": 2 * PLAYBOOK_MAX_ROUNDS + 1})\n        final = result["messages"][-1]\n        text = final.content if isinstance(final, AIMessage) else str(final)\n        if isinstance(text, list):\n            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))\n    except Exception as e:\n        run.status = "failed"\n        run.emit(type="note", text=f"Round budget of {PLAYBOOK_MAX_ROUNDS} exhausted or run failed: {e}")\n    transcript = render_playbook_transcript(NODE["title"], run.events, text, run.status)\n    return {"text": transcript, "route": "", "notes": "", "status": run.status}\n\n'
_A2A_AGENT_SERVER_BLOCK = '# ==============================================================\n# A2A SERVING\n# Agent Card, the AgentExecutor (one task = one node run, paused at\n# gates), the gate bridge used by the playbook runtime, and the uvicorn\n# entry point. Verified against a2a-sdk 1.1.0.\n# ==============================================================\nA2A_GATE_TIMEOUT_S = int(os.environ.get("A2A_GATE_TIMEOUT_S", "900"))   # how long a gate waits for the orchestrator\'s answer\n\n\ndef build_agent_card(url: str) -> "T.AgentCard":\n    """The Agent Card served at /.well-known/agent-card.json: what this node is and how to talk to it.\n\n    The card advertises ONE skill (this node\'s role); tools, prompts and credentials stay private.\n    """\n    desc = (NODE.get("system_prompt") or NODE.get("instructions") or "").strip().replace("\\n", " ")\n    return T.AgentCard(\n        name=NODE["display"],\n        description=(desc[:300] + ("…" if len(desc) > 300 else "")) or f"Workflow node {NODE[\'id\']}",\n        version=WORKFLOW_VERSION,\n        supported_interfaces=[T.AgentInterface(url=url, protocol_binding="JSONRPC", protocol_version="1.0")],\n        capabilities=T.AgentCapabilities(streaming=True),\n        default_input_modes=["text/plain"], default_output_modes=["text/plain"],\n        skills=[T.AgentSkill(id=f"node-{NODE[\'id\']}", name=NODE["display"],\n                             description=f"{NODE[\'kind\']} node of workflow {WORKFLOW_NAME!r}",\n                             tags=[NODE["kind"], NODE["provider"]])],\n    )\n\n\nclass _NodeRun:\n    """One node run that may pause at gates.\n\n    `updater` is swapped on every A2A leg (first request, then each follow-up)\n    so events go to the queue of the request currently being served -- the\n    SDK closes a request\'s queue as soon as execute() returns.\n    """\n    def __init__(self, updater: TaskUpdater):\n        self.updater = updater\n        self.answer: asyncio.Future | None = None   # pending gate answer\n        self.paused = asyncio.Event()                # set when the run enters input-required\n        self.task: asyncio.Task | None = None\n        self.loop = asyncio.get_event_loop()\n\n    async def gate(self, kind: str, name: str, args: dict) -> dict:\n        """Raise a gate: publish input-required, wait for the answer, resume. Returns the single-file gate result shape.\n\n        On a timeout (A2A_GATE_TIMEOUT_S with no answer) the node run itself\n        continues -- it gets the guidance below back from this call, same as\n        any other gate result -- but the run\'s FINAL artifact can no longer be\n        delivered: no A2A request is in flight to carry it (the client that\n        would have answered already gave up), so the task stays stuck in\n        input-required. Re-sending on the same task id to pick the result back\n        up is not supported yet; the caller must start a new task.\n        """\n        self.answer = self.loop.create_future()\n        question = args.get("question") or args.get("prompt") or args.get("reason") or name\n        print(f"[gate] {kind}: {question}", flush=True)\n        await self.updater.requires_input(self.updater.new_agent_message(\n            [T.Part(text=str(question)), new_data_part({"gate": kind, "tool": name, "args": args})]))\n        self.paused.set()\n        try:\n            ans = await asyncio.wait_for(self.answer, A2A_GATE_TIMEOUT_S)\n        except asyncio.TimeoutError:\n            # The run continues below, but its eventual artifact has nowhere to\n            # go: the task is still parked in input-required and there is no\n            # supported way to resume it after this point (see the docstring).\n            self.answer = None\n            return {"ok": False, "timeout": True,\n                    "guidance": "No answer arrived in time. Leave an internal note and resolve as uncompleted."}\n        self.answer = None\n        await self.updater.start_work()\n        decision = str(ans.get("decision") or "answered")\n        if decision == "unavailable":\n            return {"ok": False, "timeout": True,\n                    "guidance": "No human is available for this run. Continue with what you already know and note the gap with leave_internal_note."}\n        d = {"decision": decision, "comment": str(ans.get("comment") or ""), "actor": str(ans.get("actor") or "a2a-client")}\n        if isinstance(ans.get("fields"), dict):\n            d["fields"] = ans["fields"]\n        return {"ok": True, "decision": d}\n\n\n_ACTIVE: _NodeRun | None = None      # the run currently executing (one at a time, see _RUN_LOCK)\n_RUNS: dict[str, _NodeRun] = {}      # task id -> paused/active run\n_RUN_LOCK = asyncio.Lock()           # serialises node runs: the gate bridge relies on a single active run\n\n\ndef _a2a_gate(run, kind: str, name: str, args: dict) -> dict:\n    """Gate bridge for the playbook runtime (called from a tool, i.e. a worker thread):\n    forwards to the active run\'s async gate and blocks the thread until the answer arrives."""\n    active = _ACTIVE\n    if active is None:\n        return {"ok": False, "timeout": True, "guidance": "No A2A task is active for this gate."}\n    fut = asyncio.run_coroutine_threadsafe(active.gate(kind, name, args), active.loop)\n    return fut.result(timeout=A2A_GATE_TIMEOUT_S + 5)\n\n\nif NODE["kind"] == "playbook":\n    _playbook_gate = _a2a_gate   # the playbook runtime calls _playbook_gate(run, kind, name, args)\n\n\nclass NodeExecutor(AgentExecutor):\n    """A2A executor: a new task starts a node run; a follow-up message answers its gate."""\n\n    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:\n        """Handle one A2A request: either start a node run or resume one paused at a gate.\n\n        A first request (no run recorded for this task, or a run with no pending\n        gate answer) enqueues the initial Task when context.current_task is None,\n        then starts the node run as a background asyncio task. A follow-up message\n        on a run that is waiting at a gate is a resume leg: its data part is handed\n        to the paused run as the gate\'s answer instead of starting a new run.\n\n        Returns as soon as the run pauses at the next gate or finishes -- the SDK\n        closes this request\'s event queue right after this method returns, so a\n        still-running node keeps making progress in the background and reports on\n        the NEXT request (another gate pause, or the terminal task update). If the\n        run itself raised, run.task.result() re-raises here so the SDK marks the\n        task failed instead of leaving it stuck in "working".\n        """\n        global _ACTIVE\n        tid, cid = context.task_id, context.context_id\n        run = _RUNS.get(tid)\n        if run is not None and run.answer is not None and not run.answer.done():\n            # Resume leg: point the run at this request\'s queue and hand over the answer.\n            run.updater = TaskUpdater(event_queue, tid, cid)\n            run.paused.clear()\n            data = get_data_parts(context.message.parts)\n            answer = dict(data[0]) if data and isinstance(data[0], dict) else {"decision": context.get_user_input() or "answered"}\n            run.answer.set_result(answer)\n        else:\n            if context.current_task is not None:\n                # A follow-up on an existing task, but no run is paused waiting for it:\n                # the run already completed, failed, or expired. Reject instead of\n                # silently starting a second run under the same task id.\n                updater = TaskUpdater(event_queue, tid, cid)\n                await updater.failed(updater.new_agent_message(\n                    [T.Part(text=f"task {tid} is not waiting for input")]))\n                return\n            # SDK 1.x: the executor enqueues the initial Task itself (submitted, history = the user message).\n            await event_queue.enqueue_event(new_task_from_user_message(context.message))\n            run = _NodeRun(TaskUpdater(event_queue, tid, cid))\n            _RUNS[tid] = run\n            await run.updater.start_work()\n            request_text = context.get_user_input()\n            run.task = asyncio.create_task(self._serve(run, request_text))\n        # Return when the run pauses at a gate or finishes; the SDK closes this request\'s queue after that.\n        pause = asyncio.create_task(run.paused.wait())\n        done, _ = await asyncio.wait({run.task, pause}, return_when=asyncio.FIRST_COMPLETED)\n        pause.cancel()\n        if run.task in done:\n            _RUNS.pop(tid, None)\n            run.task.result()   # re-raise a failure so the SDK marks the task failed\n\n    async def _serve(self, run: _NodeRun, request_text: str) -> None:\n        """Run the node under the lock, publish progress, deliver the result artifact."""\n        global _ACTIVE\n        async with _RUN_LOCK:\n            _ACTIVE = run\n            t0 = time.monotonic()\n            try:\n                async def trace(line: str):\n                    print(f"[node] {line}", flush=True)\n                    await run.updater.update_status(T.TaskState.TASK_STATE_WORKING, run.updater.new_agent_message([T.Part(text=line)]))\n                out = await run_node(request_text, trace)\n                await run.updater.add_artifact(\n                    [T.Part(text=out["text"]), new_data_part({"route": out["route"], "notes": out["notes"], "status": out["status"]})],\n                    name="result")\n                await run.updater.complete()\n                print(f"[node] done -- {len(out[\'text\'])} chars, status={out[\'status\']} ({time.monotonic() - t0:.1f}s)", flush=True)\n            except Exception as e:\n                print(f"[node] FAILED: {e}", flush=True)\n                await run.updater.failed(run.updater.new_agent_message([T.Part(text=f"node failed: {e}")]))\n                raise\n            finally:\n                _ACTIVE = None\n\n    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:\n        """Cancel the run behind a task (the SDK marks the task canceled)."""\n        run = _RUNS.pop(context.task_id, None)\n        if run and run.task:\n            run.task.cancel()\n\n\ndef main() -> None:\n    """CLI entry: `python <this file> --host 127.0.0.1 --port 8701` (env A2A_HOST / A2A_PORT are the defaults)."""\n    ap = argparse.ArgumentParser(description=f"A2A agent server for workflow node {NODE[\'id\']} ({NODE[\'display\']})")\n    ap.add_argument("--host", default=os.environ.get("A2A_HOST", "127.0.0.1"))\n    ap.add_argument("--port", type=int, default=int(os.environ.get("A2A_PORT", "8700")))\n    a = ap.parse_args()\n    url = f"http://{a.host}:{a.port}/"\n    card = build_agent_card(url)\n    handler = DefaultRequestHandler(agent_executor=NodeExecutor(), task_store=InMemoryTaskStore(), agent_card=card)\n    app = Starlette(routes=create_agent_card_routes(card) + create_jsonrpc_routes(handler, rpc_url="/"))\n    print(f"[agent {NODE[\'display\']}] serving {url}", flush=True)\n    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")\n\n'
_TOOL_BUILDER_PART_A = 'def _summarize_tool_result(result: str) -> str:\n    """Short, informative summary of a tool result for logs.\n\n    Parses JSON when possible and surfaces the most useful fields\n    (article count + first PMIDs, error message, query text, etc.)\n    so the log shows *what* came back, not just the raw first 120 chars.\n    """\n    try:\n        parsed = json.loads(result)\n    except Exception:\n        s = result.strip().replace("\\n", " ")\n        return s[:160] + (" ..." if len(s) > 160 else "")\n    if isinstance(parsed, dict):\n        if "error" in parsed:\n            return f"error: {str(parsed[\'error\'])[:200]}"\n        if isinstance(parsed.get("articles"), list):\n            arts = parsed["articles"]\n            pmids = [str(a.get("pmid", "?")) for a in arts[:5] if isinstance(a, dict)]\n            more = "" if len(arts) <= 5 else f", +{len(arts) - 5} more"\n            return f"{len(arts)} articles (PMIDs: {\', \'.join(pmids)}{more})"\n        if isinstance(parsed.get("suggestions"), list):\n            return f"{len(parsed[\'suggestions\'])} suggestions"\n        if isinstance(parsed.get("query"), str):\n            q = parsed["query"]\n            return f"query: {q[:200]}" + (" ..." if len(q) > 200 else "")\n        if isinstance(parsed.get("items"), list):\n            return f"{len(parsed[\'items\'])} items"\n        keys = ", ".join(list(parsed.keys())[:6])\n        return f"keys: {keys}"\n    if isinstance(parsed, list):\n        return f"list of {len(parsed)} items"\n    s = str(parsed)\n    return s[:160] + (" ..." if len(s) > 160 else "")\n\n\ndef build_tools_from_catalog() -> dict[str, StructuredTool]:\n    """Build LangChain StructuredTool wrappers from TOOL_CATALOG.\n\n    For each tool:\n    1. Parse the JSON Schema into a Pydantic model (for LLM argument validation)\n    2. Create a callable that sends the MCP JSON-RPC request\n    3. Wrap both into a LangChain StructuredTool\n\n    Returns: dict mapping tool_name -> StructuredTool\n    """\n    type_map = {"string": str, "integer": int, "number": float,\n                "boolean": bool, "array": list, "object": dict}\n    catalog = {}\n    for name, info in TOOL_CATALOG.items():\n        schema = info.get("input_schema") or {}\n        props = schema.get("properties", {}) if isinstance(schema, dict) else {}\n        required = set(schema.get("required", []) if isinstance(schema, dict) else [])\n        fields = {}\n        for pname, pspec in props.items():\n            spec = pspec if isinstance(pspec, dict) else {}\n            ptype = type_map.get(spec.get("type", "string"), str)\n            default = ... if pname in required else None\n            fields[pname] = (ptype, Field(default, description=spec.get("description", "")))\n        args_model = create_model(f"{name}Args", **fields) if fields else create_model(f"{name}Args")\n\n        server_url = info["server_url"]\n        def make_fn(n=name, s=server_url):\n            def invoke(**kwargs):\n                argv = json.dumps(kwargs, default=str)\n                argv_preview = argv if len(argv) <= 250 else argv[:250] + f" ... +{len(argv) - 250} chars"\n                print(f"  [tool] -> {n}({argv_preview})")\n                t0 = time.monotonic()\n                result = _call_mcp_tool(s, n, kwargs)\n                dt = time.monotonic() - t0\n                summary = _summarize_tool_result(result)\n                print(f"  [tool] ← {n}: {summary} ({len(result)} chars, {dt:.1f}s)")\n                return result\n            return invoke\n\n        catalog[name] = StructuredTool.from_function(\n            func=make_fn(),\n            name=name,\n            description=info.get("description") or f"MCP tool {name}",\n            args_schema=args_model,\n        )\n    return catalog\n\n\n'
_TOOL_BUILDER_LG_SPECIFIC = '\n\nRUN_SKILL_SCRIPT_TOOL = StructuredTool.from_function(\n    func=_run_skill_script,\n    name="run_skill_script",\n    description=("Execute a folder-backed skill\'s Python script and return its "\n                 "stdout. Pass the dir_name/script/argv the skill instructions "\n                 "specify, e.g. dir_name=\'GEO/geo-llmstxt\', "\n                 "script=\'scripts/llmstxt_signals.py\', argv=[\'https://example.com\']."),\n    args_schema=create_model(\n        "RunSkillScriptArgs",\n        dir_name=(str, ...),\n        script=(str, ...),\n        # list[str] (not bare list) so the generated JSON schema carries\n        # `items`. Gemini rejects array params without `items` (400\n        # INVALID_ARGUMENT); list[str] is valid for every provider. Leave\n        # input_files as a bare dict — Gemini accepted that, and dict[str,str]\n        # would add additionalProperties which Gemini may reject.\n        argv=(list[str], []),\n        input_files=(dict, {}),\n        read_outputs=(list[str], []),\n    ),\n)\n\n\ndef _make_skill_tool(dir_name: str):\n    """run_skill_script scoped to ONE skill dir: the model picks only the script + argv\n    (and input_files/read_outputs); the dir is fixed to this skill."""\n    def run_skill_script(script: str, argv=None, input_files=None, read_outputs=None) -> str:\n        return _run_skill_script(dir_name, script, argv, input_files, read_outputs)\n    return StructuredTool.from_function(\n        func=run_skill_script, name="run_skill_script",\n        description=(f"Run a script in the \'{dir_name}\' skill (dir fixed). Stage authored "\n                     "content via input_files and pass the output path in read_outputs."),\n        args_schema=create_model(\n            "ScopedSkillArgs",\n            script=(str, ...), argv=(list[str], []),\n            input_files=(dict, {}), read_outputs=(list[str], []),\n        ),\n    )\n\n\nasync def _run_skill_step(skill, prior, llm):\n    """Run ONE skill as a mandatory step on `prior` (the previous stage\'s output). A\n    dir-backed skill = an LLM turn instructed by SKILL.md with run_skill_script scoped to\n    the dir; the step output becomes the skill\'s produced deliverable file (via\n    read_outputs) when it wrote one, else the LLM\'s text. Inline skill = an LLM transform."""\n    dir_name = skill.get("dir", "")\n    body = skill.get("inline") or (_read_skill_md(dir_name) if dir_name else "")\n    system = (\n        "You are running the \'" + (dir_name or "inline") + "\' skill as a MANDATORY step in "\n        "a compiled workflow. Follow the skill instructions below and APPLY THE SKILL to the "\n        "INPUT. If the skill produces a document/file (e.g. an HTML report via a create/"\n        "render script), you MUST call run_skill_script -- stage your authored content via "\n        "input_files and pass the output path in read_outputs; the workflow captures that "\n        "produced file as this node\'s output. If the skill has no script, return the "\n        "transformed result as your response.\\n\\n=== SKILL INSTRUCTIONS ===\\n" + body\n    )\n    tools = [_make_skill_tool(dir_name)] if dir_name else []\n    if dir_name:\n        _LAST_SKILL_OUTPUTS.pop(dir_name, None)\n    agent = create_react_agent(llm, tools)\n    msgs = [SystemMessage(content=system),\n            HumanMessage(content="## INPUT (apply the skill to this)\\n" + str(prior))]\n    result = await agent.ainvoke({"messages": msgs})\n    final = result["messages"][-1]\n    text = final.content if isinstance(final, AIMessage) else str(final)\n    if isinstance(text, list):\n        text = "".join(b.get("text", "") for b in text if isinstance(b, dict))\n    produced = _LAST_SKILL_OUTPUTS.pop(dir_name, None) if dir_name else None\n    return produced[-1] if produced else text\n'
_LLM_FACTORY_TEXT = 'def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096, thinking=None):\n    """Build a LangChain chat model for the given provider/model.\n\n    The (provider, model) pair was resolved by the generator: the\n    agent\'s explicit model overrides the provider\'s default from\n    system_llm_settings, and that result is what reaches this\n    function. No hardcoded model fallbacks here — every value comes\n    from the database, so changing a model in the editor propagates\n    via the next Generate Python.\n\n    Recognised providers (case-insensitive):\n      claude     → langchain_anthropic.ChatAnthropic\n      openai     → langchain_openai.ChatOpenAI\n      gemini     → langchain_google_genai.ChatGoogleGenerativeAI\n      grok       → ChatOpenAI on https://api.x.ai/v1\n      deepseek   → ChatOpenAI on https://api.deepseek.com\n      kimi       → ChatOpenAI on https://api.moonshot.ai/v1\n      glm        → ChatOpenAI on https://api.z.ai/api/paas/v4\n\n    Reads API keys from the environment (loaded from .env at startup).\n    """\n    p = (provider or "claude").lower()\n    if MODEL_NAME_OVERRIDE:\n        model = MODEL_NAME_OVERRIDE\n    if not model:\n        raise RuntimeError(\n            f"No model specified for provider {p!r}. "\n            "Set a model name on the agent in the workflow editor, "\n            "or set MODEL_NAME in .env."\n        )\n    if p == "claude":\n        from langchain_anthropic import ChatAnthropic\n        return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)\n    if p == "openai":\n        from langchain_openai import ChatOpenAI\n        return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)\n    if p == "gemini":\n        from langchain_google_genai import ChatGoogleGenerativeAI\n        return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)\n    if p == "grok":\n        from langchain_openai import ChatOpenAI\n        return ChatOpenAI(\n            model=model,\n            base_url="https://api.x.ai/v1",\n            api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),\n            temperature=temperature,\n            max_tokens=max_tokens,\n        )\n    if p == "deepseek":\n        from langchain_openai import ChatOpenAI\n        kwargs = dict(\n            model=model,\n            base_url="https://api.deepseek.com",\n            api_key=os.environ.get("DEEPSEEK_API_KEY"),\n            temperature=temperature,\n            max_tokens=max_tokens,\n        )\n        if model.startswith("deepseek-v4"):\n            # The node form Thinking attribute governs (platform parity):\n            # off -> disabled, form temperature kept; on/default -> V4 thinking\n            # stays enabled and the API rejects sampling params, so temperature\n            # is dropped (set Thinking=Off on the node to use a temperature).\n            if thinking == "off":\n                kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}\n            else:\n                kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "enabled"}}}\n                if "temperature" in kwargs:\n                    print(f"[info] deepseek {model}: temperature dropped (thinking mode)", flush=True)\n                    kwargs.pop("temperature", None)\n        return ChatOpenAI(**kwargs)\n    if p == "kimi":\n        from langchain_openai import ChatOpenAI\n        # Kimi is OpenAI-compatible. The node form Thinking attribute governs\n        # K2 reasoning mode (default off, matching the PHP KimiProvider); the\n        # API then constrains sampling: thinking OFF -> temperature MUST be 0.6,\n        # thinking ON -> 1.0 (provider CONSTRAINT, not a preference override).\n        _k2 = model.startswith("kimi-k2")\n        if _k2:\n            _want = 1.0 if thinking == "on" else 0.6\n            if temperature != _want:\n                print(f"[info] kimi {model}: temperature {temperature} -> {_want} (model constraint)", flush=True)\n                temperature = _want\n        kwargs = dict(\n            model=model,\n            base_url="https://api.moonshot.ai/v1",\n            api_key=os.environ.get("KIMI_API_KEY"),\n            temperature=temperature,\n            max_tokens=max_tokens,\n        )\n        if _k2:\n            _mode = "enabled" if thinking == "on" else "disabled"\n            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": _mode}}}\n        return ChatOpenAI(**kwargs)\n    if p == "glm":\n        from langchain_openai import ChatOpenAI\n        # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible.\n        return ChatOpenAI(\n            model=model,\n            base_url="https://api.z.ai/api/paas/v4",\n            api_key=os.environ.get("GLM_API_KEY"),\n            temperature=temperature,\n            max_tokens=max_tokens,\n            # GLM 5.2 defaults to heavy reasoning; disable thinking for direct answers.\n            model_kwargs={"extra_body": {"thinking": {"type": "disabled"}}},\n        )\n    raise RuntimeError(\n        f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi, glm."\n    )'

# PHP 970-978: the HTML-output nudge appended to a main agent's system prompt
# when it strongly signals an HTML deliverable and carries no skill to render
# one. Single literal string (PHP builds it via '.'-concatenation).
_HTML_NUDGE = (
    "\n\n## Output format (CRITICAL — read carefully)\n"
    "Your FINAL message MUST be the complete, self-contained HTML "
    "document itself: start with `<!DOCTYPE html>` and end with "
    "`</html>`. Output ONLY the raw HTML — no Markdown, no triple-backtick "
    "code fences, no preamble, and no commentary before or after. Do NOT "
    "narrate what you are about to do; produce the HTML directly as your "
    "answer. The runtime saves your final message verbatim to an .html "
    "file, so anything that is not HTML breaks the deliverable."
)


class LangGraphGenerator:
    """Port of `AgentTeam\\Services\\LangGraphGenerator` (PHP 23-3314)."""

    def __init__(self, db, workflowRepo, graphRepo, agentRepo):
        """PHP 30-40 (promoted constructor properties)."""
        self.db = db
        self.workflowRepo = workflowRepo
        self.graphRepo = graphRepo
        self.agentRepo = agentRepo

    # ---------- helpers (same as Python generator) ----------

    @staticmethod
    def _nodeType(n: dict) -> str:
        """PHP 44-58."""
        cfg = n.get('config')
        cfg = cfg if isinstance(cfg, dict) else {}
        for t in (n.get('node_type'), n.get('type'), cfg.get('type')):
            if t is not None and php_strval(t) != '':
                return php_strval(t)
        return ''

    @staticmethod
    def _serverSlug(serverName: str) -> str:
        """PHP 60-64. `"<server slug>.<tool>"` ids the playbook analyzer binds
        against -- twin of LoaderMcpExecutor::slug()."""
        return re.sub(r'[^a-z0-9]+', '_', serverName, flags=re.IGNORECASE).lower()

    @staticmethod
    def _nodeId(n: dict) -> str:
        """PHP 66-69."""
        v = _coalesce(n.get('id'), n.get('drawflow_node_id'), n.get('_id'))
        return php_strval(v if v is not None else '')

    @staticmethod
    def _edgeFrom(e: dict) -> str:
        """PHP 71-74."""
        v = _coalesce(e.get('from_node_id'), e.get('from'), e.get('source'))
        return php_strval(v if v is not None else '')

    @staticmethod
    def _edgeTo(e: dict) -> str:
        """PHP 76-79."""
        v = _coalesce(e.get('to_node_id'), e.get('to'), e.get('target'))
        return php_strval(v if v is not None else '')

    @staticmethod
    def _children(nid, edges: list) -> list[str]:
        """PHP 81-91."""
        nid = php_strval(nid)
        return [LangGraphGenerator._edgeTo(e) for e in edges if LangGraphGenerator._edgeFrom(e) == nid]

    @staticmethod
    def _providerMaxTokensDefault(provider: str) -> int:
        """PHP 100-117. Not called by any current path (ported for fidelity --
        PHP source has no call site either)."""
        if provider in ('claude', 'anthropic'):
            return 32000
        if provider in ('openai', 'grok'):
            return 16000
        return 8000

    @staticmethod
    def _displayName(node: dict) -> str:
        """PHP 119-130."""
        cfg = node.get('config')
        cfg = cfg if isinstance(cfg, dict) else {}
        name = _coalesce(cfg.get('agent_name'), cfg.get('name'), node.get('name'))
        if name is not None and name != '':
            return php_strval(name)
        return 'node_' + LangGraphGenerator._nodeId(node)

    @staticmethod
    def _safeVar(name: str) -> str:
        """PHP 132-141."""
        out = re.sub(r'[^A-Za-z0-9]+', '_', name)
        return out.strip('_').lower()

    @staticmethod
    def _topoOrder(startId: str, edges: list) -> list[str]:
        """PHP 143-201 (Kahn's algorithm restricted to nodes reachable from
        start). Not called by any current path (`generate()` routes through
        WorkflowGraphAnalyzer.analyzeGraph instead) -- ported for fidelity."""
        reachable: dict[str, bool] = {}
        stack = [startId]
        while stack:
            nid = php_strval(stack.pop())
            if nid in reachable:
                continue
            reachable[nid] = True
            for child in LangGraphGenerator._children(nid, edges):
                stack.append(php_strval(child))
        inDeg = {nid: 0 for nid in reachable}
        for e in edges:
            f, t = LangGraphGenerator._edgeFrom(e), LangGraphGenerator._edgeTo(e)
            if f in reachable and t in reachable:
                inDeg[t] = inDeg.get(t, 0) + 1
        order: list[str] = []
        queue = [nid for nid, d in inDeg.items() if d == 0]
        while queue:
            nid = queue.pop(0)
            order.append(nid)
            for child in LangGraphGenerator._children(nid, edges):
                child = php_strval(child)
                if child not in inDeg:
                    continue
                inDeg[child] -= 1
                if inDeg[child] == 0:
                    queue.append(child)
        return order

    def _loadMcpToolsWithServers(self, userId: str | None = None) -> list[dict]:
        """PHP 211-238. Fetch MCP tools with server info (url, name, headers),
        matching the Python loader.list_mcp_tools_with_servers() shape.

        PHP decodes the schema with plain `json_decode($schemaRaw)` -- NO
        `true` second argument, unlike WorkflowGraphAnalyzer's OWN copy of
        this method (which needs assoc-array `is_array()` checks and says so
        in its own docstring). Here the decoded value is only ever carried
        through into TOOL_CATALOG/MCP_SERVERS and re-serialised via
        PythonEmitHelpers.jsonToPython() -- never introspected -- so an empty
        JSON OBJECT must decode as `{}` (PHP stdClass) and stay `{}` on
        re-encode, not collapse to `[]` the way an assoc-mode decode would
        (verified against `php -r` 2026-09-07: swapping in `php_json_decode`
        here turned `"input_schema": {}` into `"input_schema": []` for a tool
        whose schema is the literal string '{}'). Plain `json.loads`
        preserves Python's own dict/list distinction, matching PHP's
        object/array distinction under non-assoc decode."""
        sql = ("SELECT t.*, s.name AS server_name, s.url AS server_url\n"
               "                FROM mcp_server_tools t\n"
               "                JOIN mcp_servers s ON t.server_id = s.id\n"
               "                WHERE s.enabled = 1 AND (s.user_id IS NULL"
               + (" OR s.user_id = :uid" if userId is not None and userId != '' else '')
               + ")")
        params = {'uid': userId} if userId is not None and userId != '' else {}
        rows = self.db.fetch_all(sql, params)

        out: list[dict] = []
        for row in rows:
            row = dict(row)
            schemaRaw = row.get('input_schema')
            schema = None
            if isinstance(schemaRaw, str) and schemaRaw != '':
                try:
                    schema = json.loads(schemaRaw)
                except ValueError:
                    schema = None
            row['input_schema'] = schema
            out.append(row)
        return out

    # ---------- single-file emission ----------

    def generate(self, workflowId: int, userId: str | None = None, options: dict | None = None) -> dict:
        """PHP 245-681. Generate a standalone Python script from a workflow.
        Returns {filename, code} (single-file) or, with options={'a2a': True},
        {root, files} (see _generateA2A)."""
        options = options or {}
        facts = self._analyzeForEmit(workflowId, userId)
        if options.get('a2a'):
            return self._generateA2A(facts)

        workflow = facts['workflow']
        wfName = facts['wfName']
        safeName = facts['safeName']
        gdata = facts['gdata']
        byId = facts['byId']
        order = facts['order']
        edges = facts['edges']
        startPrompt = facts['startPrompt']
        startDocuments = facts['startDocuments']
        usedCatalog = facts['usedCatalog']
        usedServers = facts['usedServers']
        agentData = facts['agentData']
        playbookData = facts['playbookData']
        missing = facts['missing']
        edgeList = facts['edgeList']

        lines: list[str] = []
        sep = '# ' + ('=' * 62)

        # ---- module docstring: the uniform documentation every target carries ----
        docAgents: dict = {}
        for nid, ad in agentData.items():
            docAgents[nid] = {'name': ad['display'], 'provider': ad['provider'], 'model': ad['model'],
                               'temperature': ad['temperature'], 'max_tokens': ad['max_tokens'], 'thinking': ad['thinking'],
                               'tools': ad['tool_names'], 'skills': ad['skills']}
        docExtra: dict = {}
        for nid, targets in facts['dispatchTargets'].items():
            docExtra.setdefault(nid, {})['dispatch'] = [t['name'] for t in targets]
        for nid, pd in playbookData.items():
            mcpCount = sum(1 for a in pd['actions'] if a.get('kind') == 'mcp')
            docExtra.setdefault(nid, {})['playbook'] = {'title': pd['title'], 'writes': pd['writes_enabled'],
                                                          'bound': mcpCount, 'unbound': len(pd['actions']) - mcpCount}
            docAgents[nid] = {'name': pd['display'], 'provider': pd['provider'], 'model': pd['model'],
                               'temperature': pd['temperature'], 'max_tokens': pd['max_tokens'], 'thinking': pd['thinking'],
                               'tools': [], 'skills': []}
        docNodes = WorkflowGraphAnalyzer.docNodes(byId, order, edges, docAgents, docExtra,
                                                   ['start', 'agent', 'agent-template', 'playbook', 'output'])
        docById = {dn['id']: dn for dn in docNodes}
        docBody = PythonEmitHelpers.workflowDocBlock({
            'target': 'LangGraph (Python) -- langgraph StateGraph + LangChain ReAct agents',
            'dispatch_supported': True,
            'workflow': {'id': workflowId, 'name': wfName},
            'nodes': docNodes,
            'edges': edgeList,
            'layers': gdata.get('layers') or [],
            'data_flow': _DATA_FLOW_DOC,
            'run': {
                'deps': ['pip install langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv',
                         '# optional, only for the attachment formats you use:',
                         '#   pip install mammoth (.docx)  python-pptx (.pptx)  openpyxl (.xlsx)  pypdf (.pdf)'],
                'usage': f'python {safeName}_langgraph.py "your prompt here"',
                'extra': (['# WARNING: these tools are NOT available as MCP servers and will be missing at runtime: '
                            + LangGraphGenerator._pythonListRepr(missing)] if missing else []),
            },
            'storage': {'enabled': workflow.isOutputStorageEnabled(), 'folder': workflow.getOutputFolder()},
        })
        lines.append('"""Standalone LangGraph workflow: ' + wfName)
        lines.append('')
        lines.extend(docBody.replace('\\', '\\\\').replace('"""', "'''").split('\n'))
        lines.append('"""')
        lines.append('from __future__ import annotations')
        lines.append('')
        lines.append('import asyncio, json, os, re, subprocess, sys, threading, time')
        lines.append('')
        lines.append('from dotenv import load_dotenv')
        lines.append('')
        lines.append('# Load provider API keys from the runner env .env (one dir up from scripts/).')
        lines.append('# Without this a DIRECT terminal run has no credentials and every provider')
        lines.append('# call fails; runner-mediated runs only worked because main.py loads the')
        lines.append('# same file and subprocesses inherit the environment.')
        lines.append('load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))')
        lines.append('from typing import Annotated, Any, Literal, TypedDict')
        lines.append('')
        lines.append('import httpx')
        lines.append('# Provider-aware LLM wiring — each agent uses the LLM (provider/model)')
        lines.append('# configured for it in the workflow editor. Imports are lazy inside')
        lines.append('# _make_llm so a missing optional package only breaks the agents that')
        lines.append('# actually use that provider, not the whole script.')
        lines.append('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage')
        lines.append('from langchain_core.tools import StructuredTool')
        lines.append('from langgraph.graph import END, START, StateGraph')
        lines.append('try:')
        lines.append('    from langchain.agents import create_agent as create_react_agent')
        lines.append('except ImportError:')
        lines.append('    from langgraph.prebuilt import create_react_agent')
        lines.append('from pydantic import BaseModel, Field, create_model')
        lines.append('')
        lines.append('# Optional global override: setting MODEL_NAME in the env forces every')
        lines.append("# agent to use that model regardless of its per-agent setting. Useful for")
        lines.append("# quick experiments. Leave unset to honour each agent's configured model.")
        lines.append("MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()")
        lines.append('')
        lines.append('')
        lines.append(_LLM_FACTORY_TEXT)
        lines.append('')

        # ---------- MCP server registry (baked) ----------
        lines.append(sep)
        lines.append('# MCP SERVER REGISTRY')
        lines.append("# Baked at generation time from the workflow editor's config.")
        lines.append("# Maps server URL -> metadata. If a server moves, update the URL here.")
        lines.append(sep)
        lines.append('')
        lines.append('MCP_SERVERS = ' + PythonEmitHelpers.jsonToPython(usedServers, True))
        lines.append('')

        # ---------- tool catalog (baked) ----------
        lines.append(sep)
        lines.append('# TOOL CATALOG')
        lines.append('# Each entry maps a tool name to its MCP server URL and')
        lines.append('# JSON Schema for input validation. Only tools actually used')
        lines.append('# by agents in this workflow are included.')
        lines.append('# To add a tool: add an entry here AND reference it in the')
        lines.append("# agent's tool_names list in the AGENTS dict below.")
        lines.append(sep)
        lines.append('')
        lines.append('TOOL_CATALOG = ' + PythonEmitHelpers.jsonToPython(usedCatalog, True))
        lines.append('')

        # ---------- MCP JSON-RPC client ----------
        lines.append(sep)
        lines.append("# MCP CLIENT -- JSON-RPC 2.0 over HTTP")
        lines.append('#')
        lines.append('# The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.')
        lines.append('# Each tool call requires:')
        lines.append("#   1. URL normalization -- append /mcp if not present")
        lines.append("#   2. Session initialization -- send 'initialize' + notification")
        lines.append("#   3. Tool invocation -- send 'tools/call' with name + arguments")
        lines.append("#   4. Response parsing -- handle plain JSON or SSE-wrapped JSON")
        lines.append('#')
        lines.append('# Some MCP servers return Server-Sent Events (SSE) instead of')
        lines.append('# plain JSON. The parser handles both formats transparently.')
        lines.append(sep)
        lines.append('')
        lines.append(PythonEmitHelpers.mcpClientBlock())

        # ---------- tool builder ----------
        lines.append('')
        lines.append(sep)
        lines.append('# TOOL BUILDER')
        lines.append('# Converts the baked TOOL_CATALOG into LangChain StructuredTool')
        lines.append('# objects. Each tool gets a dynamically-built Pydantic model for')
        lines.append('# input validation (from the JSON Schema), and a callable that')
        lines.append('# invokes the MCP server. The LLM agent calls these like any')
        lines.append("# other LangChain tool -- it doesn't know about MCP internals.")
        lines.append(sep)
        lines.append('')
        lines.append(LangGraphGenerator._toolBuilderBlock())
        lines.append(LangGraphGenerator._dispatchBlock())
        if playbookData:
            lines.append(LangGraphGenerator._playbookRuntimeBlock())

        # ---------- state ----------
        lines.append('')
        lines.append(sep)
        lines.append('# LANGGRAPH STATE')
        lines.append('#')
        lines.append('# WFState is the shared state that flows through the graph.')
        lines.append("# - user_prompt: the original user input (immutable after start)")
        lines.append("# - node_outputs: dict of node_id -> {source, text} -- each node")
        lines.append('#   writes its output here. Uses a merge reducer so parallel')
        lines.append('#   branches can both contribute without conflicts.')
        lines.append("# - final_output: set by the output node as the workflow result")
        lines.append(sep)
        lines.append('')
        lines.append(_STATE_BLOCK)

        # ---------- datetime injector ----------
        lines.append('')
        lines.append(sep)
        lines.append('# DATETIME INJECTOR')
        lines.append('#')
        lines.append("# LLMs have knowledge cutoffs and don't know the current date.")
        lines.append("# inject_datetime() prepends a short context block to each agent's")
        lines.append("# system prompt so the agent reasons with today's actual date.")
        lines.append('# Also resolves any [date]/[weekday]/[year]/[time] placeholders')
        lines.append('# that may exist inside the prompt text (legacy templating).')
        lines.append(sep)
        lines.append('')
        lines.append(_DATETIME_INJECTOR_BLOCK)

        # ---------- context builder ----------
        lines.append('')
        lines.append(sep)
        lines.append('# CONTEXT BUILDER')
        lines.append('#')
        lines.append('# Each agent receives a structured message containing:')
        lines.append('#   1. The original user request (for reference)')
        lines.append('#   2. Labeled outputs from direct upstream agents only')
        lines.append("# This matches the PHP backend's 'labeled' merge strategy.")
        lines.append("# The agent's system prompt tells it what to DO with this input.")
        lines.append(sep)
        lines.append('')
        lines.append(_CONTEXT_BUILDER_BLOCK)

        # ---------- document converter ----------
        lines.append('')
        lines.append(sep)
        lines.append('# DOCUMENT CONVERTER')
        lines.append('#')
        lines.append("# Reads a file at `path` and returns Markdown the LLM can read.")
        lines.append('# Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/etc.) pass through')
        lines.append('# verbatim. Binary office formats and PDFs are routed to their')
        lines.append('# matching pure-Python library (mammoth / python-pptx / openpyxl /')
        lines.append('# pypdf). Imports are lazy so the helper only pulls in heavy deps')
        lines.append('# when a document of that format is actually attached.')
        lines.append('#')
        lines.append("# This mirrors the editor's frontend converter (Pyodide) so the")
        lines.append('# generated script behaves the same way the workflow did at design')
        lines.append('# time. Paths come from the doc.path field stored in the workflow')
        lines.append('# config — make sure the file is reachable from wherever you run')
        lines.append('# this script (absolute paths recommended).')
        lines.append(sep)
        lines.append('')
        lines.append(PythonEmitHelpers.documentConverterBlock())

        # ---------- start node config ----------
        lines.append('')
        lines.append(sep)
        lines.append('# START NODE')
        lines.append('#')
        lines.append('# The start node feeds the prompt into the workflow.')
        lines.append("# DEFAULT_PROMPT is baked from the workflow's start node config.")
        lines.append('# CLI arguments override it; if neither is provided, DEFAULT_PROMPT is used.')
        lines.append('# If the workflow has documents attached to the start node,')
        lines.append("# they're read from doc.path, converted to Markdown via")
        lines.append('# _convert_doc_to_markdown(), and prepended to the prompt.')
        lines.append(sep)
        lines.append('')
        promptEscaped = startPrompt.replace('\\', '\\\\').replace('"""', '\\"\\"\\"')
        lines.append('DEFAULT_PROMPT = """')
        for pline in promptEscaped.split('\n'):
            if len(pline.encode('utf-8')) <= 80:
                lines.append(pline)
            else:
                lines.append(_php_wordwrap(pline, 80, '\n', True))
        lines.append('""".strip()')
        lines.append('')
        ofolder = workflow.getOutputFolder()
        lines.append('WORKFLOW_ID = ' + str(php_intval(workflowId)))
        lines.append('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(wfName))
        lines.append('OUTPUT_STORAGE_ENABLED = ' + ('True' if workflow.isOutputStorageEnabled() else 'False'))
        lines.append('OUTPUT_FOLDER = ' + (PythonEmitHelpers.pyStr(str(ofolder)) if ofolder else 'None'))
        lines.append('')
        if startDocuments:
            lines.append('START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(startDocuments))
        else:
            lines.append('START_DOCUMENTS = []')
        lines.append('')

        # ---------- embedded agent definitions ----------
        lines.append(sep)
        lines.append('# AGENT DEFINITIONS')
        lines.append('#')
        lines.append('# Each agent is identified by its workflow node ID.')
        lines.append("#   display:       Human-readable name (for logs and context labels)")
        lines.append("#   system_prompt: The agent's persona/instructions (sent as SystemMessage)")
        lines.append('#   tool_names:    List of tool names this agent can call (from TOOL_CATALOG)')
        lines.append('#')
        lines.append('# To modify an agent: edit its system_prompt or tool_names here.')
        lines.append('# To add a new agent: add an entry, create edges in EDGES, and')
        lines.append('# include the node ID in ORDER at the right topological position.')
        lines.append(sep)
        lines.append('')
        lines.append('AGENTS = {')
        for nid, ad in agentData.items():
            toolsList = _jf(ad['tool_names']) or '[]'
            promptText = ad['system_prompt'].replace('\\', '\\\\').replace('"""', '\\"\\"\\"')
            wrappedLines: list[str] = []
            for pline in promptText.split('\n'):
                if len(pline.encode('utf-8')) <= 80:
                    wrappedLines.append(pline)
                else:
                    wrappedLines.extend(_php_wordwrap(pline, 80, '\n', True).split('\n'))
            displayJson = _jf(ad['display'])
            providerJson = _jf(php_strval(_coalesce(ad.get('provider'), 'claude')))
            modelJson = _jf(php_strval(_coalesce(ad.get('model'), '')))
            temperatureLit = _float_json(_coalesce(ad.get('temperature'), 0.7))
            maxTokensLit = php_intval(_coalesce(ad.get('max_tokens'), 4096))
            if nid in docById:
                lines.append(PythonEmitHelpers.nodeCommentBlock(docById[nid], '    '))
            lines.append('    "' + nid + '": {')
            lines.append('        "display": ' + displayJson + ',')
            lines.append('        "provider": ' + providerJson + ',')
            lines.append('        "model": ' + modelJson + ',')
            lines.append('        "temperature": ' + temperatureLit + ',')
            lines.append('        "max_tokens": ' + str(maxTokensLit) + ',')
            thinkLit = ('"' + ad['thinking'] + '"') if ad.get('thinking') in ('on', 'off') else 'None'
            lines.append('        "thinking": ' + thinkLit + ',  # node form Thinking attribute')
            lines.append('        "system_prompt": """')
            lines.extend(wrappedLines)
            lines.append('""",')
            skillsJson = _jf(ad.get('skills') or [])
            lines.append('        "tool_names": ' + toolsList + ',')
            lines.append('        "skills": ' + skillsJson + ',')
            if ad.get('dispatch'):
                dispatch_parts = ', '.join(
                    '{"id": ' + _jf(php_strval(t['id'])) + ', "name": ' + _jf(php_strval(t['name'])) + '}'
                    for t in ad['dispatch'])
                lines.append('        "dispatch": [' + dispatch_parts + '],')
            lines.append('    },')
        lines.append('}')
        lines.append('')
        lines.append(sep)
        lines.append('# PLAYBOOK DEFINITIONS')
        lines.append('#')
        lines.append('# A playbook node runs the Console-style playbook text through the')
        lines.append('# playbook runtime below: native verbs (messages, notes, resolve), human')
        lines.append("# gates, and the MCP tools its #Actions were bound to at generation time.")
        lines.append('#   actions:        bound MCP actions (llm_name -> server_url/tool) and')
        lines.append('#                   unbound stubs (the on_unbound policy applies)')
        lines.append('#   writes_enabled: node toggle; write tools are blocked when False')
        lines.append(sep)
        lines.append('')
        if not playbookData:
            lines.append('PLAYBOOKS = {}')
        else:
            lines.append('PLAYBOOKS = {')
            for nid, pd in playbookData.items():
                if nid in docById:
                    lines.append(PythonEmitHelpers.nodeCommentBlock(docById[nid], '    '))
                lines.append('    "' + nid + '": {')
                lines.append('        "display": ' + _jf(pd['display']) + ',')
                lines.append('        "title": ' + _jf(pd['title']) + ',')
                lines.append('        "domain": ' + _jf(pd['domain']) + ',')
                lines.append('        "provider": ' + _jf(pd['provider']) + ',')
                lines.append('        "model": ' + _jf(pd['model']) + ',')
                lines.append('        "temperature": ' + _float_json(pd['temperature']) + ',')
                lines.append('        "max_tokens": ' + str(php_intval(pd['max_tokens'])) + ',')
                lines.append('        "thinking": ' + ('"' + pd['thinking'] + '"' if pd.get('thinking') is not None else 'None') + ',')
                lines.append('        "writes_enabled": ' + ('True' if pd['writes_enabled'] else 'False') + ',')
                lines.append('        "policy": ' + PythonEmitHelpers.jsonToPython(pd['policy'], True) + ',')
                lines.append('        "approvers": ' + PythonEmitHelpers.jsonToPython(pd['approvers'], True) + ',')
                lines.append('        "requester": ' + PythonEmitHelpers.jsonToPython(pd['requester'], True) + ',')
                lines.append('        "instructions": """')
                instrEscaped = pd['instructions'].replace('\\', '\\\\').replace('"""', '\\"\\"\\"')
                lines.extend(instrEscaped.split('\n'))
                lines.append('""",')
                lines.append('        "actions": ' + PythonEmitHelpers.jsonToPython(pd['actions'], False) + ',')
                lines.append('    },')
            lines.append('}')
        lines.append('')

        # ---------- edge data ----------
        lines.append(sep)
        lines.append('# GRAPH STRUCTURE')
        lines.append('#')
        lines.append('# EDGES: directed connections as (from_node_id, to_node_id) tuples.')
        lines.append("# ORDER: topological execution order (Kahn's algorithm).")
        lines.append('#        Guarantees every node runs after all its predecessors.')
        lines.append("# NODE_TYPES: maps node_id -> type ('start', 'agent', 'playbook', 'output').")
        lines.append(sep)
        lines.append('')
        lines.append('EDGES = ' + PythonEmitHelpers.jsonToPython(edgeList))
        lines.append('ORDER = ' + PythonEmitHelpers.jsonToPython(order))
        lines.append('')
        lines.append(_PARENTS_CHILDREN_BLOCK)

        typeMap = {nid: LangGraphGenerator._nodeType(byId[nid]) for nid in order}
        lines.append('NODE_TYPES = ' + PythonEmitHelpers.jsonToPython(typeMap, True))
        lines.append('')

        # ---------- main function ----------
        lines.append(sep)
        lines.append('# MAIN EXECUTION')
        lines.append('#')
        lines.append('# run() builds the LangGraph, wires edges, and executes it.')
        lines.append('# Each node type has a factory function (make_start, make_agent,')
        lines.append('# make_output) that returns a callable for LangGraph to invoke.')
        lines.append('#')
        lines.append("# Agent nodes use LangChain's ReAct pattern: the LLM receives")
        lines.append('# the system prompt + upstream context, and can call tools in a')
        lines.append('# loop until it produces a final answer.')
        lines.append(sep)
        lines.append('')
        lines.append(_RUN_HEADER_BLOCK)

        if missing:
            lines.append('    print("[warn] Missing tools (not MCP): ' + LangGraphGenerator._pythonListRepr(missing) + '")')
            lines.append('')

        lines.append(_RUN_BODY_BLOCK)

        code = '\n'.join(lines)
        # Suffix the runtime so the file is identifiable alongside *_adk.py / *_maf.py
        # (LangGraph was the original default and previously had no suffix).
        filename = f"{safeName}_langgraph.py"
        return {'filename': filename, 'code': code}

    # ---------- fact-gathering (shared by single-file and A2A emitters) ----------

    def _analyzeForEmit(self, workflowId: int, userId: str | None) -> dict:
        """PHP 690-1103. Everything the emitters need, computed once: workflow
        identity, graph (byId/order/edges/layers), start node, provider
        defaults, the MCP registry and per-agent tool catalog, dispatcher
        targets, agent and playbook definitions, documentation descriptors.
        No Python is produced here."""
        workflow = self.workflowRepo.findById(workflowId)
        if not workflow:
            raise RuntimeError(f"Workflow {workflowId} not found.")
        wfName = workflow.getName() or f'workflow_{workflowId}'
        safeName = LangGraphGenerator._safeVar(wfName)
        if safeName == '':
            safeName = f'workflow_{workflowId}'

        graph = self.graphRepo.getGraph(workflowId)
        gdata = WorkflowGraphAnalyzer.analyzeGraph(graph)
        byId = gdata['byId']
        order = gdata['order']
        startId = gdata['startNodeId']
        if startId == '':
            raise RuntimeError('No start node found.')
        edges = gdata['edges']
        startNode = byId[startId]
        startCfg = _coalesce(startNode.get('config'), startNode.get('data'), {})
        if not isinstance(startCfg, dict):
            startCfg = {}
        startPrompt = php_strval(startCfg.get('prompt')) if startCfg.get('prompt') is not None else ''
        startDocuments = startCfg.get('documents')
        if not isinstance(startDocuments, list):
            startDocuments = []

        providerDefaults: dict[str, str] = {}
        try:
            for rowP in self.db.fetch_all("SELECT provider_key, model FROM system_llm_settings WHERE enabled = 1"):
                providerDefaults[php_strval(rowP.get('provider_key')).lower()] = php_strval(rowP.get('model'))
        except Exception:
            pass

        mcpTools = self._loadMcpToolsWithServers(userId)

        serverRegistry: dict = {}
        toolCatalog: dict = {}
        for t in mcpTools:
            surl = php_strval(t.get('server_url'))
            sname = php_strval(t.get('server_name'))
            tname = php_strval(_coalesce(t.get('tool_name'), t.get('name')))
            if surl == '' or tname == '':
                continue
            if surl not in serverRegistry:
                serverRegistry[surl] = {'name': sname}
            desc = _coalesce(t.get('tool_description'), t.get('description'))
            if desc is None:
                desc = ''
            schema = t.get('input_schema')
            if schema is None:
                schema = {}
            toolCatalog[tname] = {'server_url': surl, 'description': desc, 'input_schema': schema}

        availableById: dict = {}
        for t in mcpTools:
            surl = php_strval(t.get('server_url'))
            tname = php_strval(_coalesce(t.get('tool_name'), t.get('name')))
            if surl == '' or tname == '':
                continue
            schema = t.get('input_schema')
            availableById[LangGraphGenerator._serverSlug(php_strval(t.get('server_name'))) + '.' + tname] = {
                'server_url': surl, 'tool': tname,
                'description': php_strval(_coalesce(t.get('tool_description'), t.get('description'), '')),
                'input_schema': schema if schema is not None else {},
            }

        agentTypeCache: dict = {}

        def agentTypeOf(node: dict) -> str:
            cfg = node.get('config')
            cfg = cfg if isinstance(cfg, dict) else {}
            t = php_strval(cfg.get('agent_type')) if cfg.get('agent_type') is not None else ''
            if t != '':
                return t
            aid = _coalesce(node.get('agent_id'), cfg.get('agent_id'))
            if aid is None or aid == '':
                return 'standard'
            aid = php_intval(aid)
            if aid not in agentTypeCache:
                try:
                    a = self.agentRepo.findById(aid)
                    if a is not None:
                        aArr = a.toArray()
                        agentTypeCache[aid] = php_strval(_coalesce(aArr.get('agent_type'), 'standard'))
                    else:
                        agentTypeCache[aid] = 'standard'
                except Exception:
                    agentTypeCache[aid] = 'standard'
            return agentTypeCache[aid]

        # Dispatcher agents: their fan-out is a MENU, not a parallel fan-out.
        dispatchTargets: dict = {}
        routedBy: dict = {}
        for nid in order:
            node = byId[nid]
            if LangGraphGenerator._nodeType(node) not in ('agent', 'agent-template') or agentTypeOf(node) != 'dispatcher':
                continue
            targets = []
            for e in edges:
                if LangGraphGenerator._edgeFrom(e) != nid:
                    continue
                childId = LangGraphGenerator._edgeTo(e)
                child = byId.get(childId)
                if not child or LangGraphGenerator._nodeType(child) not in ('agent', 'agent-template', 'playbook'):
                    continue
                targets.append({'id': childId, 'name': LangGraphGenerator._displayName(child)})
                routedBy[childId] = LangGraphGenerator._displayName(node)
            if targets:
                dispatchTargets[nid] = targets

        # Resolve agent data for each agent node.
        agentData: dict = {}
        allNeededTools: dict = {}
        for nid in order:
            node = byId[nid]
            ntype = LangGraphGenerator._nodeType(node)
            if ntype not in ('agent', 'agent-template'):
                continue
            cfg = node.get('config')
            cfg = cfg if isinstance(cfg, dict) else {}
            agentId = _coalesce(node.get('agent_id'), cfg.get('agent_id'))
            systemPrompt = php_strval(_coalesce(cfg.get('systemPrompt'), cfg.get('instructions'), ''))
            rawTools = _coalesce(cfg.get('selectedTools'), cfg.get('tools'), [])
            if isinstance(rawTools, dict):
                rawTools = list(rawTools.values())
            elif not isinstance(rawTools, list):
                rawTools = []
            toolNames: list[str] = []
            for tool in rawTools:
                tname = None
                if isinstance(tool, str):
                    tname = tool
                elif isinstance(tool, dict):
                    tname = _coalesce(tool.get('name'), tool.get('tool_name'))
                if tname:
                    if tname.startswith('mcp_'):
                        tname = tname[4:]
                    toolNames.append(tname)

            agentProvider = ''
            agentModel = ''
            if agentId is not None and agentId != '':
                try:
                    agent = self.agentRepo.findById(php_intval(agentId))
                    if agent is not None:
                        agentArr = agent.toArray()
                        if systemPrompt == '':
                            systemPrompt = php_strval(_coalesce(
                                agentArr.get('instructions'), agentArr.get('system_prompt'), agentArr.get('prompt'), ''))
                        agentProvider = php_strval(_coalesce(agentArr.get('provider'), ''))
                        agentModel = php_strval(_coalesce(agentArr.get('model'), ''))
                        agentTools = agentArr.get('tools')
                        if php_empty(toolNames) and isinstance(agentTools, list):
                            for tool in agentTools:
                                tname = None
                                if isinstance(tool, str):
                                    tname = tool
                                elif isinstance(tool, dict):
                                    tname = _coalesce(tool.get('name'), tool.get('tool_name'))
                                if tname:
                                    if tname.startswith('mcp_'):
                                        tname = tname[4:]
                                    toolNames.append(tname)
                except Exception:
                    pass

            nodeProvider = php_strval(_coalesce(cfg.get('llm_provider'), cfg.get('provider'), cfg.get('agent_provider'), ''))
            nodeModel = php_strval(_coalesce(cfg.get('model'), ''))
            if nodeProvider != '':
                agentProvider = nodeProvider
            if nodeModel != '':
                agentModel = nodeModel
            if agentProvider == '':
                agentProvider = 'claude'
            if agentModel == '':
                agentModel = providerDefaults.get(agentProvider.lower(), '')

            # Skills are mandatory POST-agent steps.
            skills = WorkflowGraphAnalyzer.skillsFromConfig(cfg)

            # HTML-output nudge.
            pl = systemPrompt.lower()
            wantsHtml = ('output only the html' in pl or 'production-quality html' in pl
                         or '<!doctype' in pl or ('self-contained' in pl and '<style' in pl))
            if wantsHtml and php_empty(skills):
                systemPrompt = _rtrim(systemPrompt) + _HTML_NUDGE

            # Dispatcher routing (twin of GraphWorkflowRunner).
            if systemPrompt == '':
                systemPrompt = DispatchRouting.defaultInstructions(
                    LangGraphGenerator._displayName(node),
                    php_strval(cfg.get('description')) if cfg.get('description') is not None else '', wfName)
            dispatch = dispatchTargets.get(nid, [])
            if dispatch:
                systemPrompt = _rtrim(systemPrompt) + "\n\n" + DispatchRouting.promptBlock(dispatch)
            if nid in routedBy:
                systemPrompt = _rtrim(systemPrompt) + "\n\n" + DispatchRouting.routedPrompt(
                    LangGraphGenerator._displayName(node), routedBy[nid], '')

            cfgSettings = cfg.get('settings')
            cfgSettings = cfgSettings if isinstance(cfgSettings, dict) else {}
            agentTemperature = float(_coalesce(cfgSettings.get('temperature'), 0.7))
            # max_tokens comes from the agent form VERBATIM -- no substitution.
            agentMaxTokens = php_intval(_coalesce(cfgSettings.get('max_tokens'), 4096))

            for tn in toolNames:
                allNeededTools[tn] = True
            agentData[nid] = {
                'display': LangGraphGenerator._displayName(node),
                'system_prompt': systemPrompt,
                'tool_names': toolNames,
                'provider': agentProvider.lower(),
                'model': agentModel,
                'temperature': agentTemperature,
                'max_tokens': agentMaxTokens,
                'thinking': cfgSettings.get('thinking') if cfgSettings.get('thinking') in ('on', 'off') else None,
                'skills': skills,
                'dispatch': dispatch,
            }

        # Playbook nodes: bind the playbook's #Actions against the registry.
        playbookData: dict = {}
        playbookServerUrls: dict = {}
        for nid in order:
            node = byId[nid]
            if LangGraphGenerator._nodeType(node) != 'playbook':
                continue
            pd = self._playbookData(node, availableById, providerDefaults, userId)
            playbookData[nid] = pd
            for a in pd['actions']:
                if a.get('kind') == 'mcp':
                    playbookServerUrls[a['server_url']] = True

        # Filter catalog to only tools actually used by agents.
        usedCatalog = {k: v for k, v in toolCatalog.items() if k in allNeededTools}
        usedServers: dict = {}
        for entry in usedCatalog.values():
            surl = entry.get('server_url') or ''
            if surl != '' and surl in serverRegistry:
                usedServers[surl] = serverRegistry[surl]
        for surl in playbookServerUrls:
            if surl in serverRegistry:
                usedServers[surl] = serverRegistry[surl]

        # Flag tools that agents need but aren't available as MCP.
        missing = sorted(tn for tn in allNeededTools if tn != 'run_skill_script' and tn not in toolCatalog)

        edgeList = [[LangGraphGenerator._edgeFrom(e), LangGraphGenerator._edgeTo(e)] for e in edges]

        return {
            'workflow': workflow, 'workflowId': workflowId, 'userId': userId, 'wfName': wfName, 'safeName': safeName,
            'gdata': gdata, 'byId': byId, 'order': order, 'edges': edges,
            'startPrompt': startPrompt, 'startDocuments': startDocuments, 'providerDefaults': providerDefaults,
            'serverRegistry': serverRegistry, 'toolCatalog': toolCatalog, 'availableById': availableById,
            'dispatchTargets': dispatchTargets, 'routedBy': routedBy, 'agentData': agentData, 'playbookData': playbookData,
            'usedCatalog': usedCatalog, 'usedServers': usedServers, 'missing': missing, 'edgeList': edgeList,
        }

    @staticmethod
    def _slug(name: str) -> str:
        """PHP 1105-1110. Kebab-case ASCII slug for file names (max 40 chars)."""
        translit = _ascii_translit(name) or name
        s = re.sub(r'[^a-z0-9]+', '-', translit, flags=re.IGNORECASE).strip('-').lower()
        return (s if s != '' else 'node')[:40]

    @staticmethod
    def _a2aVersion(facts: dict) -> str:
        """PHP 1227-1236. The single WORKFLOW_VERSION literal baked into both
        the orchestrator and every agent file, so the supervisor's version
        check can never see them drift."""
        return f"{facts['workflowId']}-{php_date('Ymd')}"

    @staticmethod
    def a2aLayout(facts: dict) -> dict:
        """PHP 1243-1263 (public -- called directly by the oracle tests). File
        names, ports and kinds of the A2A agents, in ORDER: one per
        agent/playbook node. Port = A2A base (8701) + index."""
        agents: dict = {}
        i = 0
        for nid in facts['order']:
            if nid in facts['agentData']:
                ad = facts['agentData'][nid]
                kind = 'dispatcher' if ad.get('dispatch') else 'agent'
                display = ad['display']
            elif nid in facts['playbookData']:
                kind = 'playbook'
                display = facts['playbookData'][nid]['display']
            else:
                continue
            slug = LangGraphGenerator._slug(display)
            agents[nid] = {'file': f"agents/{nid}_{slug}.py", 'slug': slug,
                            'port': 8701 + i, 'display': display, 'kind': kind}
            i += 1
        return {'root': facts['safeName'] + '_a2a', 'agents': agents}

    def _generateA2A(self, facts: dict) -> dict:
        """PHP 1266-1274. A2A mode: orchestrator first, then one agent file
        per agent/playbook node (see a2aLayout)."""
        layout = LangGraphGenerator.a2aLayout(facts)
        files = [{'path': 'orchestrator.py', 'code': self._emitA2AOrchestrator(facts, layout)}]
        for nid, e in layout['agents'].items():
            files.append({'path': e['file'], 'code': self._emitA2AAgentFile(facts, layout, str(nid))})
        return {'root': layout['root'], 'files': files}

    def _emitA2AOrchestrator(self, facts: dict, layout: dict) -> str:
        """PHP 1277-1370. orchestrator.py: the graph, the agent endpoint
        table, the supervisor and the A2A node runner."""
        sep = '# ' + ('=' * 62)
        nodes = self._a2aDocNodes(facts, layout)
        docById = {dn['id']: dn for dn in nodes}
        endpoints = []
        for nid, e in layout['agents'].items():
            endpoints.append('  %-6s %-24s %-32s http://127.0.0.1:%d/   (env A2A_AGENT_%s_URL)' % (
                nid, e['display'], e['file'], e['port'], nid))
        body = PythonEmitHelpers.workflowDocBlock({
            'target': 'LangGraph A2A orchestrator (Python) -- StateGraph over A2A tasks, one agent process per node',
            'dispatch_supported': True,
            'workflow': {'id': facts['workflowId'], 'name': facts['wfName']},
            'nodes': nodes, 'edges': facts['edgeList'], 'layers': facts['gdata'].get('layers') or [],
            'data_flow': _A2A_ORCHESTRATOR_DATA_FLOW_DOC,
            'run': {'deps': ['pip install "a2a-sdk[http-server]>=1.1,<2" langgraph langchain-core httpx python-dotenv'],
                    'usage': 'python orchestrator.py "your prompt here"   [--keep-serving] [--no-spawn]',
                    'extra': ['# A2A_BASE_PORT (default 8701) moves the port range; A2A_AGENT_<id>_URL points one agent elsewhere.'],
                    'env_path': '../../.env'},
            'storage': {'enabled': facts['workflow'].isOutputStorageEnabled(), 'folder': facts['workflow'].getOutputFolder()},
        })
        body += ("\n\nAGENT ENDPOINTS  (id, name, file, default URL; env override)\n===============\n"
                 + '\n'.join(endpoints)
                 + "\n\nA2A RUN\n=======\n"
                 + "  1. AgentSupervisor starts every local agent (python <file> --port N) and waits for its card.\n"
                 + "  2. Each agent node = one A2A task: the framed input goes in as text, status updates are\n"
                 + "     relayed as [<agent>] lines, an input-required status is a GATE (answered on the console,\n"
                 + "     or by PLAYBOOK_GATE_MODE when no terminal), the 'result' artifact is the node output\n"
                 + "     (+ data {route, notes, status}; a dispatcher's route drives the conditional edge).\n"
                 + "  3. Start and Output run locally; the Output merges parent outputs verbatim.\n"
                 + "  4. Agents are stopped at the end unless --keep-serving; --no-spawn expects them reachable.")

        L: list[str] = []
        L.append('"""A2A orchestrator for workflow ' + _jf(facts['wfName']))
        L.append('')
        L.extend(body.replace('\\', '\\\\').replace('"""', "'''").split('\n'))
        L.append('"""')
        L.append('from __future__ import annotations')
        L.append('')
        L.append('import argparse, asyncio, json, os, re, subprocess, sys, threading, time, uuid')
        L.append('from typing import Annotated, Any, TypedDict')
        L.append('')
        L.append('from dotenv import load_dotenv')
        L.append('# This file lives in <root>/; the runner .env is two levels up (python/.env).')
        L.append('_HERE = os.path.dirname(os.path.abspath(__file__))')
        L.append('load_dotenv(os.path.join(os.path.dirname(os.path.dirname(_HERE)), ".env"))')
        L.append('')
        L.append('import httpx')
        L.append('from langgraph.graph import END, START, StateGraph')
        L.append('from a2a import types as T')
        L.append('from a2a.client import create_client, ClientConfig')
        L.append('from a2a.helpers.proto_helpers import new_data_part, get_data_parts, get_text_parts')
        L.append('')
        L.append('WORKFLOW_ID = ' + str(php_intval(facts['workflowId'])))
        L.append('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(facts['wfName']))
        L.append('WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(LangGraphGenerator._a2aVersion(facts)))
        L.append('OUTPUT_STORAGE_ENABLED = ' + ('True' if facts['workflow'].isOutputStorageEnabled() else 'False'))
        ofolder = facts['workflow'].getOutputFolder()
        L.append('OUTPUT_FOLDER = ' + (PythonEmitHelpers.pyStr(str(ofolder)) if ofolder else 'None'))
        L.append('DEFAULT_PROMPT = ' + PythonEmitHelpers.pyStr(facts['startPrompt']))
        L.append('START_DOCUMENTS = ' + PythonEmitHelpers.jsonToPython(facts['startDocuments'] or []))
        L.append('A2A_BASE_PORT = int(os.environ.get("A2A_BASE_PORT", "8701"))   # agent i listens on A2A_BASE_PORT + i')
        L.append('')
        L.append(sep)
        L.append('# AGENTS -- the endpoint table (one A2A server per agent/playbook node)')
        L.append(sep)
        L.append('AGENTS = {')
        i = 0
        for nid, e in layout['agents'].items():
            L.append(PythonEmitHelpers.nodeCommentBlock(docById[nid], '    '))
            dispatch = ([{'id': php_strval(t['id']), 'name': t['name']} for t in facts['agentData'][nid]['dispatch']]
                        if e['kind'] == 'dispatcher' else [])
            L.append('    ' + _jf(php_strval(nid)) + ': {"display": ' + _jf(e['display']) + ', "file": ' + _jf(e['file'])
                      + ', "kind": ' + _jf(e['kind']) + ', "port": ' + str(e['port']) + ', "index": ' + str(i)
                      + ', "dispatch": ' + _jf(dispatch) + '},')
            i += 1
        L.append('}')
        L.append('')
        L.append(sep)
        L.append('# GRAPH STRUCTURE (same shape as the single-file script)')
        L.append(sep)
        L.append('EDGES = ' + PythonEmitHelpers.jsonToPython(facts['edgeList']))
        L.append('ORDER = ' + PythonEmitHelpers.jsonToPython(facts['order']))
        typeMap = {}
        for nid in facts['order']:
            if nid in layout['agents']:
                typeMap[nid] = 'playbook' if layout['agents'][nid]['kind'] == 'playbook' else 'agent'
            else:
                typeMap[nid] = LangGraphGenerator._nodeType(facts['byId'][nid])
        L.append('NODE_TYPES = ' + PythonEmitHelpers.jsonToPython(typeMap, True))
        L.append('')
        L.append(_PARENTS_CHILDREN_BLOCK)
        L.append(_STATE_BLOCK)
        L.append(_DATETIME_INJECTOR_BLOCK)
        L.append(_CONTEXT_BUILDER_BLOCK)
        L.append(PythonEmitHelpers.documentConverterBlock())
        L.append(_A2A_ORCHESTRATOR_BLOCK)
        return '\n'.join(L) + '\n'

    def _emitA2AAgentFile(self, facts: dict, layout: dict, nid: str) -> str:
        """PHP 1746-1887. One self-contained A2A agent server for node `nid`."""
        entry = layout['agents'][nid]
        kind = entry['kind']
        isPlaybook = kind == 'playbook'
        d = facts['playbookData'][nid] if isPlaybook else facts['agentData'][nid]
        wfName = facts['wfName']
        sep = '# ' + ('=' * 62)

        catalog: dict = {}
        if not isPlaybook:
            for tn in d['tool_names']:
                if tn in facts['usedCatalog']:
                    catalog[tn] = facts['usedCatalog'][tn]
        servers: dict = {}
        for c in catalog.values():
            if c['server_url'] in facts['serverRegistry']:
                servers[c['server_url']] = facts['serverRegistry'][c['server_url']]
        if isPlaybook:
            for a in d['actions']:
                if a.get('kind') == 'mcp' and a['server_url'] in facts['serverRegistry']:
                    servers[a['server_url']] = facts['serverRegistry'][a['server_url']]

        L: list[str] = []
        L.append('"""A2A agent ' + _jf(entry['display']) + f" -- node {nid} of workflow " + _jf(wfName))
        L.append('')
        docBody = self._a2aDocBody(facts, layout, nid)
        L.extend(docBody.replace('\\', '\\\\').replace('"""', "'''").split('\n'))
        L.append('"""')
        L.append('from __future__ import annotations')
        L.append('')
        L.append('import argparse, asyncio, json, os, re, subprocess, sys, threading, time')
        L.append('from typing import Literal')
        L.append('')
        L.append('from dotenv import load_dotenv')
        L.append('# This file lives in <root>/agents/; the runner .env is three levels up (python/.env).')
        L.append('_HERE = os.path.dirname(os.path.abspath(__file__))')
        L.append('load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(_HERE))), ".env"))')
        L.append('')
        L.append('import httpx')
        L.append('import uvicorn')
        L.append('from starlette.applications import Starlette')
        L.append('from langchain_core.messages import AIMessage, HumanMessage, SystemMessage')
        L.append('from langchain_core.tools import StructuredTool')
        L.append('from langgraph.graph import END')
        L.append('try:')
        L.append('    from langchain.agents import create_agent as create_react_agent')
        L.append('except ImportError:')
        L.append('    from langgraph.prebuilt import create_react_agent')
        L.append('from pydantic import BaseModel, Field, create_model')
        L.append('from a2a import types as T')
        L.append('from a2a.server.agent_execution import AgentExecutor, RequestContext')
        L.append('from a2a.server.events import EventQueue')
        L.append('from a2a.server.request_handlers import DefaultRequestHandler')
        L.append('from a2a.server.tasks import InMemoryTaskStore, TaskUpdater')
        L.append('from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes')
        L.append('from a2a.helpers.proto_helpers import new_task_from_user_message, new_data_part, get_data_parts, get_text_parts')
        L.append('')
        L.append("MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()")
        L.append('')
        L.append('# This file is SELF-CONTAINED on purpose: the LLM factory, MCP client, tool')
        L.append('# builder, skill and playbook blocks below are the same code the single-file')
        L.append('# script carries, duplicated here so this agent can be copied to another host')
        L.append('# alone.')
        L.append(sep)
        L.append('# LLM FACTORY')
        L.append('# Provider/model -> LangChain chat model (same rules as the single-file script).')
        L.append(sep)
        L.append(_LLM_FACTORY_TEXT)
        L.append('')
        L.append(sep)
        L.append('# MCP SERVER REGISTRY + TOOL CATALOG (this node only)')
        L.append(sep)
        L.append('MCP_SERVERS = ' + PythonEmitHelpers.jsonToPython(servers, True))
        L.append('TOOL_CATALOG = ' + PythonEmitHelpers.jsonToPython(catalog, True))
        L.append('')
        L.append(sep)
        L.append('# MCP CLIENT -- JSON-RPC 2.0 over HTTP (shared block)')
        L.append(sep)
        L.append(PythonEmitHelpers.mcpClientBlock())
        L.append(sep)
        L.append('# TOOL BUILDER + SKILL RUNTIME (shared blocks)')
        L.append(sep)
        L.append(LangGraphGenerator._toolBuilderBlock())
        L.append(LangGraphGenerator._dispatchBlock())
        L.append(_DATETIME_INJECTOR_BLOCK)
        if isPlaybook:
            L.append(LangGraphGenerator._playbookRuntimeBlock())
        L.append('NODE_DURATIONS = {}   # display name -> seconds (kept for the shared dispatcher block)')
        L.append('def parents(_n):')
        L.append('    """Always []: this file has no graph, only one node. Exists so the reused')
        L.append("    _run_dispatcher() (which looks up parent outputs via parents(n)) finds none")
        L.append('    and falls back to state["user_prompt"] -- the orchestrator\'s framed input --')
        L.append('    instead of raising on a missing function."""')
        L.append('    return []')
        L.append('')
        L.append(sep)
        L.append('# NODE DEFINITION -- frozen from the workflow editor')
        L.append(sep)
        docNodes = self._a2aDocNodes(facts, layout)
        for dn in docNodes:
            if dn['id'] == nid:
                L.append(PythonEmitHelpers.nodeCommentBlock(dn))
        L.append('NODE = {')
        L.append('    "id": ' + _jf(nid) + ',')
        L.append('    "kind": ' + _jf(kind) + ',')
        L.append('    "display": ' + _jf(entry['display']) + ',')
        L.append('    "provider": ' + _jf(d['provider']) + ',')
        L.append('    "model": ' + _jf(d['model']) + ',')
        L.append('    "temperature": ' + _float_json(d['temperature']) + ',')
        L.append('    "max_tokens": ' + str(php_intval(d['max_tokens'])) + ',')
        L.append('    "thinking": ' + ('"' + d['thinking'] + '"' if d.get('thinking') in ('on', 'off') else 'None') + ',')
        if isPlaybook:
            L.append('    "title": ' + _jf(d['title']) + ',')
            L.append('    "domain": ' + _jf(d['domain']) + ',')
            L.append('    "writes_enabled": ' + ('True' if d['writes_enabled'] else 'False') + ',')
            L.append('    "policy": ' + PythonEmitHelpers.jsonToPython(d['policy'], True) + ',')
            L.append('    "approvers": ' + PythonEmitHelpers.jsonToPython(d['approvers'], True) + ',')
            L.append('    "requester": ' + PythonEmitHelpers.jsonToPython(d['requester'], True) + ',')
            L.append('    "instructions": """')
            instrEscaped = d['instructions'].replace('\\', '\\\\').replace('"""', '\\"\\"\\"')
            L.extend(instrEscaped.split('\n'))
            L.append('""",')
            L.append('    "actions": ' + PythonEmitHelpers.jsonToPython(d['actions'], False) + ',')
        else:
            L.append('    "system_prompt": """')
            spEscaped = d['system_prompt'].replace('\\', '\\\\').replace('"""', '\\"\\"\\"')
            L.extend(spEscaped.split('\n'))
            L.append('""",')
            L.append('    "tool_names": ' + _jf(list(d['tool_names'])) + ',')
            L.append('    "skills": ' + _jf(d.get('skills') or []) + ',')
            dispatch_parts = ', '.join(
                '{"id": ' + _jf(php_strval(t['id'])) + ', "name": ' + _jf(t['name']) + '}'
                for t in (d.get('dispatch') or []))
            L.append('    "dispatch": [' + dispatch_parts + '],')
        L.append('}')
        L.append('')
        L.append(_A2A_NODE_LOGIC_BLOCK)
        L.append(_A2A_AGENT_SERVER_BLOCK)
        L.append('WORKFLOW_NAME = ' + PythonEmitHelpers.pyStr(wfName))
        L.append('WORKFLOW_VERSION = ' + PythonEmitHelpers.pyStr(LangGraphGenerator._a2aVersion(facts)))
        L.append('# Default card (port from A2A_PORT or the layout); main() rebuilds it for the real host/port.')
        L.append('AGENT_CARD = build_agent_card(f"http://127.0.0.1:{os.environ.get(\'A2A_PORT\', \'' + str(entry['port']) + '\')}/")')
        L.append('')
        L.append('if __name__ == "__main__":')
        L.append('    main()')
        return '\n'.join(L) + '\n'

    def _a2aDocNodes(self, facts: dict, layout: dict) -> list[dict]:
        """PHP 1890-1908. docNodes descriptors for the A2A layout: every node,
        with the agent file recorded under 'file'."""
        docAgents: dict = {}
        docExtra: dict = {}
        for n, ad in facts['agentData'].items():
            docAgents[n] = {'name': ad['display'], 'provider': ad['provider'], 'model': ad['model'], 'temperature': ad['temperature'],
                             'max_tokens': ad['max_tokens'], 'thinking': ad['thinking'], 'tools': ad['tool_names'], 'skills': ad['skills']}
            if ad.get('dispatch'):
                docExtra.setdefault(n, {})['dispatch'] = [t['name'] for t in ad['dispatch']]
        for n, pd in facts['playbookData'].items():
            mcp = sum(1 for a in pd['actions'] if a.get('kind') == 'mcp')
            docExtra.setdefault(n, {})['playbook'] = {'title': pd['title'], 'writes': pd['writes_enabled'],
                                                        'bound': mcp, 'unbound': len(pd['actions']) - mcp}
            docAgents[n] = {'name': pd['display'], 'provider': pd['provider'], 'model': pd['model'], 'temperature': pd['temperature'],
                             'max_tokens': pd['max_tokens'], 'thinking': pd['thinking'], 'tools': [], 'skills': []}
        nodes = WorkflowGraphAnalyzer.docNodes(facts['byId'], facts['order'], facts['edges'], docAgents, docExtra,
                                                ['start', 'agent', 'agent-template', 'playbook', 'output'])
        for n in nodes:
            n['file'] = layout['agents'].get(n['id'], {}).get('file', '')
        return nodes

    def _a2aDocBody(self, facts: dict, layout: dict, nid: str) -> str:
        """PHP 1911-1942. Module-docstring body of an agent file: standard
        sections + NODE + A2A SERVING + TO RUN."""
        nodes = self._a2aDocNodes(facts, layout)
        # 'marker' (not 'name') so the "<== this agent" tag appears only on the
        # GRAPH NODES line -- GRAPH EDGES and EXECUTION ORDER read 'name' as-is.
        for n in nodes:
            if n['id'] == nid:
                n['marker'] = '<== this agent'
        entry = layout['agents'][nid]
        body = PythonEmitHelpers.workflowDocBlock({
            'target': 'LangGraph A2A agent (Python) -- one A2A server for this node; the orchestrator drives the graph',
            'dispatch_supported': True,
            'workflow': {'id': facts['workflowId'], 'name': facts['wfName']},
            'nodes': nodes, 'edges': facts['edgeList'], 'layers': facts['gdata'].get('layers') or [],
            'data_flow': _A2A_AGENT_DATA_FLOW_DOC,
            'run': {'deps': ['pip install "a2a-sdk[http-server]>=1.1,<2" langchain langchain-anthropic langchain-openai langgraph httpx pydantic python-dotenv uvicorn'],
                    'usage': f"python {entry['file']} --port {entry['port']}   # from the workflow folder; A2A_HOST/A2A_PORT also honoured",
                    'extra': [f"# Card: http://127.0.0.1:{entry['port']}/.well-known/agent-card.json  --  JSON-RPC at /"],
                    'env_path': '../../../.env'},
            'storage': {'enabled': False, 'folder': None},
        })
        return body + ("\n\nA2A SERVING\n===========\n"
                        f"  Skill id:   node-{nid}\n"
                        "  Task in:    one text part = the node input the orchestrator built (original prompt + parent outputs)\n"
                        "  Task out:   artifact 'result' = text part (node output) + data part {route, notes, status}\n"
                        "  Gates:      the task moves to input-required with data {gate, tool, args}; the orchestrator answers on\n"
                        "              the same task with data {decision, comment, fields}; the run resumes in memory.\n"
                        "              After A2A_GATE_TIMEOUT_S (default 900 s) with no answer the node run continues with\n"
                        "              timeout guidance, but its final artifact can no longer be delivered -- no A2A request\n"
                        "              is in flight to carry it, so the task stays stuck in input-required. Re-sending on the\n"
                        "              same task id to pick the result back up is not supported yet.\n"
                        "  One task at a time: runs are serialised with a lock; a second task waits for the first.")

    def _playbookData(self, node: dict, availableById: dict, providerDefaults: dict, userId: str | None) -> dict:
        """PHP 2455-2524. Bake one playbook node: parse + analyze the playbook
        against the registry ids and describe what the emitted runtime needs."""
        nid = LangGraphGenerator._nodeId(node)
        cfg = node.get('config')
        cfg = cfg if isinstance(cfg, dict) else {}
        raw = cfg.get('playbook')
        if isinstance(raw, str) and php_trim(raw) != '':
            doc = PlaybookDocument.fromConsoleText(raw)
        elif isinstance(raw, dict):
            doc = PlaybookDocument.fromArray(raw)
        else:
            raise RuntimeError(f"Playbook node {nid} has no playbook text.")
        writesEnabled = not php_empty(cfg.get('writes_enabled'))
        policy = dict(doc.policy)
        if writesEnabled:
            policy['writes_enabled'] = True
        analysis = PlaybookAnalyzer().analyze(doc, list(availableById.keys()), [])
        if analysis.get('errors'):
            raise RuntimeError(f"Playbook node {nid} has unresolved bindings: " + '; '.join(analysis['errors']))
        actions = []
        for a in analysis['actions']:
            name = php_strval(a.get('name')) if a.get('name') is not None else ''
            kind = php_strval(a.get('kind')) if a.get('kind') is not None else ''
            target = a.get('target')
            if kind == 'native':
                continue
            if (kind == 'bound' and isinstance(target, str) and '.' in target
                    and not target.startswith('agent.') and target in availableById):
                info = availableById[target]
                llmName = re.sub(r'[^a-z0-9_]+', '_', target.replace('.', '__'), flags=re.IGNORECASE).lower()
                actions.append({
                    'llm_name': llmName, 'kind': 'mcp', 'action_name': name, 'target': target,
                    'server_url': info['server_url'], 'tool': info['tool'],
                    'description': info['description'], 'input_schema': info['input_schema'],
                })
                continue
            slug = re.sub(r'[^a-z0-9]+', '_', name, flags=re.IGNORECASE).lower().strip('_')
            actions.append({'llm_name': 'unbound__' + slug, 'kind': 'unbound', 'action_name': name, 'target': target})
        provider = php_strval(_coalesce(cfg.get('agent_provider'), cfg.get('provider'), cfg.get('llm_provider'), '')).lower()
        if provider == '':
            provider = 'claude'
        model = php_strval(_coalesce(cfg.get('model'), ''))
        if model == '':
            model = providerDefaults.get(provider, '')
        settings = cfg.get('settings')
        settings = settings if isinstance(settings, dict) else {}
        return {
            'display': php_strval(_coalesce(cfg.get('name'), cfg.get('agent_name'), doc.title)),
            'title': doc.title, 'domain': doc.domain, 'instructions': doc.instructions,
            'policy': policy, 'approvers': doc.approvers,
            'requester': {'id': php_strval(userId) if userId is not None else ''},
            'provider': provider, 'model': model,
            'temperature': float(_coalesce(settings.get('temperature'), 0.7)),
            'max_tokens': php_intval(_coalesce(settings.get('max_tokens'), 4096)),
            'thinking': settings.get('thinking') if settings.get('thinking') in ('on', 'off') else None,
            'writes_enabled': writesEnabled, 'actions': actions,
        }

    # ---------- static Python code blocks ----------
    # mcpClientBlock() / skillDepsBlock() / skillFsSyncBlock() / documentConverterBlock()
    # -> PythonEmitHelpers (Task 1/2).

    @staticmethod
    def _toolBuilderBlock() -> str:
        """PHP 2275-2447."""
        return _TOOL_BUILDER_PART_A + PythonEmitHelpers.skillDepsBlock() + PythonEmitHelpers.skillFsSyncBlock() + _TOOL_BUILDER_LG_SPECIFIC

    @staticmethod
    def _dispatchBlock() -> str:
        """PHP 2527-2581. Dispatcher node runtime: one forced route_to call
        over the menu, result in state["routes"]."""
        return _DISPATCH_BLOCK

    @staticmethod
    def _playbookRuntimeBlock() -> str:
        """PHP 2589-2841. Playbook node runtime: twin of the PHP interpreter
        stack. Emitted only when the workflow has a playbook node."""
        return _PLAYBOOK_RUNTIME_BLOCK

    @staticmethod
    def _pythonListRepr(items: list) -> str:
        """PHP 2257-2266. Render a list of strings the way Python's
        repr(sorted([...])) does."""
        parts = []
        for s in items:
            esc = php_strval(s).replace('\\', '\\\\').replace("'", "\\'")
            parts.append("'" + esc + "'")
        return '[' + ', '.join(parts) + ']'
