import { Kysely } from 'kysely';
import { DB } from '../../db/types';
import {
  JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, array_keys, asciiTranslit, entries, explode, has, implode,
  isEmptyArr, json_encode, keysOf, oarr, preg_match, preg_replace, str_replace, strtolower, strtoupper, strval, substr, toArr,
  toObject, trim, truthy, values,
} from './php';
import { GraphAnalyzer } from './GraphAnalyzer';
import { PythonEmitHelpers } from './PythonEmitHelpers';
import { LangGraphRuntime } from './LangGraphRuntime';
import { CompiledPackage } from './CompiledPackage';
import { DispatcherDecisionFacts } from './DispatcherDecisionFacts';
import { CodeNodeEmit } from '../CodeNodeEmit';
import { StartTriggerFacts } from '../StartTriggerFacts';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/** frontend/assets/py/code_node_harness.py (PHP: __DIR__ . '/../../../../frontend/...' from backend/src/AgentTeam/Services). */
export const CODE_NODE_HARNESS_PATH = path.resolve(__dirname, '../../../../frontend/assets/py/code_node_harness.py');

/** The analyzer calls analyzeRuntime makes (GraphAnalyzer's instance method; sync or async). */
export interface ServerIndexSource {
  serverIndex(userId?: string | null): any;
}

/** The repository calls DispatcherDecisionFacts makes (AgentRepository.findById). */
export interface AgentLookup {
  findById(id: number): any;
}

/** PHP `$a[$k][$k2] = $v` with $a[$k] maybe unset: the inner keyed array, created on first use. */
function slot(arr: any, k: string): any {
  if (!has(arr, k)) arr[k] = oarr();
  return arr[k];
}

/** isset($a[$k1][$k2]...) over any PHP array shape. */
function isset(v: any, ...ks: string[]): boolean {
  let cur = v;
  for (const k of ks) {
    if (!has(cur, k)) return false;
    cur = cur[k];
  }
  return true;
}

/** $a[$k1][$k2]... ?? null */
function dig(v: any, ...ks: string[]): any {
  let cur = v;
  for (const k of ks) {
    if (!has(cur, k)) return null;
    cur = cur[k];
  }
  return cur;
}

/** iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) ?: $s, then the marks the real call inserts stripped. */
function asciiOf(display: string): string {
  return str_replace(["'", '"', '`', '^', '~'], '', asciiTranslit(display) || display);
}

/**
 * The framework-free runtime a compiled ADK, MAF or NOOA program carries, emitted once for all of them: the MCP
 * client with each server's headers (MCP_HEADERS_<SLUG>), the code-node harness (a copy of the editor's), the
 * run events (runs/ and GET /live), the package's listener and CLI (LangGraph's cron / watch / listener code,
 * copied) and its common.py. Each target supplies its own graph runtime around it.
 * Mirrors backend/src/AgentTeam/Services/CompiledRuntimeEmit.php.
 */
export class CompiledRuntimeEmit
{
    /**
     * What a compiled program needs beyond WorkflowGraphAnalyzer::analyze() (+ 'playbooks'), read at compile
     * time only: 'code' (each code node's settings), 'serverSlugs' (url => slug, MCP_HEADERS_<SLUG>),
     * 'decisions' (each dispatcher's decision-model routing), and the Start's mode, schedule and trigger.
     * Returns a new array (the argument is not changed, as PHP passes it by value).
     */
    static async analyzeRuntime(analyzedIn: any, analyzer: ServerIndexSource, db: Kysely<DB> | null,
        agentRepo: AgentLookup | null, graphRaw: any, workflowId: number, userId: string | null): Promise<any> {
        const analyzed: any = oarr(entries(analyzedIn));
        const index: any = (await analyzer.serverIndex(userId)) ?? [];   // slug => {url, name}: the user's MCP servers
        // Code nodes (spec 2026-10-04): validated settings, exit -> children, the servers they call.
        const slugToUrl: Record<string, string> = {};
        for (const [slug, s] of entries(index)) slugToUrl[slug] = s['url'];
        const code: any = oarr();
        analyzed['code'] = code;
        const nodeIds = array_keys(toArr(analyzed['byId']));
        for (const nid of values(toArr(analyzed['order']))) {   // analyzeGraph()'s topological order
            const node = dig(analyzed, 'byId', strval(nid));
            if (node !== null && GraphAnalyzer.typeOf(node) === 'code') {
                code[strval(nid)] = CodeNodeEmit.nodeData(node, values(dig(graphRaw, 'edges') ?? []), slugToUrl, nodeIds);
            }
        }

        // MCP_SERVER_SLUGS: every URL this script calls -> its server's slug (MCP_HEADERS_<SLUG>).
        const urlName: any = oarr();
        for (const [surl, meta] of entries(toArr(analyzed['usedServers'] ?? []))) {
            const name = strval(dig(meta, 'name') ?? '');
            slot(urlName, strval(surl))[CodeNodeEmit.slug(name)] = name;
        }
        for (const pd of values(analyzed['playbooks'])) {
            for (const a of values(pd['actions'])) {
                if ((dig(a, 'kind') ?? '') === 'mcp') {
                    const slg = CodeNodeEmit.slug(explode('.', strval(a['target']), 2)[0]);
                    slot(urlName, strval(a['server_url']))[slg] = dig(index, slg, 'name') ?? slg;
                }
            }
        }
        for (const cd of values(code)) {
            for (const slg of values(cd['mcp_servers'])) {
                slot(urlName, strval(index[slg]['url']))[slg] = index[slg]['name'];
            }
        }
        analyzed['serverSlugs'] = CompiledRuntimeEmit.serverSlugs(urlName);
        // Each dispatcher's decision-model routing (Jev...), baked: the program never reads the database.
        const decisions: any = oarr();
        analyzed['decisions'] = decisions;
        for (const did of array_keys(GraphAnalyzer.dispatchMenus(analyzed)['menus'])) {
            decisions[strval(did)] = await DispatcherDecisionFacts.of(db, agentRepo,
                toArr(analyzed['byId'][did]), strval(analyzed['workflow']['name']));
        }
        const ordered = values(toArr(analyzed['order'])).map((id: any) => {
            const n: any = oarr([['id', strval(id)]]);
            for (const [k, v] of entries(toArr(analyzed['byId'][strval(id)]))) {
                if (k !== 'id') n[k] = v;
            }
            return n;
        });
        const slugsPlain: Record<string, string> = {};
        for (const [u, s] of entries(analyzed['serverSlugs'])) slugsPlain[u] = s;
        const start: any = await StartTriggerFacts.of(db, workflowId, ordered, slugsPlain);
        for (const [k, v] of Object.entries(start)) {
            if (!(k in analyzed)) analyzed[k] = v;   // $analyzed += ...: keys already set win
        }
        return analyzed;
    }

    /**
     * ADK's own MCP client (PythonEmitHelpers::mcpClientBlock() stays for MAF and NOOA): per-server
     * headers from MCP_HEADERS_<SLUG>, a moved server from MCP_URL_<SLUG>, and a raw call for code nodes.
     */
    static mcpClientBlock(analyzed: any): string {
        let slugs: any, head: any;
        slugs = toArr((analyzed['serverSlugs'] ?? []));
        head = 'MCP_SERVER_SLUGS = ' + (isEmptyArr(slugs) ? '{}' : PythonEmitHelpers.jsonToPython(slugs, true))
            + '   # registered URL -> slug: MCP_HEADERS_<SLUG> / MCP_URL_<SLUG> in .env\n'
            + 'MCP_SLUGS = {v: k for k, v in MCP_SERVER_SLUGS.items()}   # slug -> URL (a code node\'s call_tool)\n\n';
        return head + `_MCP_BASE_HEADERS = {"Content-Type": "application/json",
                     "Accept": "application/json, text/event-stream, */*"}
_MCP_ENDPOINTS: dict = {}   # registered server URL -> endpoint that accepted the handshake


def _mcp_headers(server_url: str) -> dict:
    """The base headers plus the server's own from MCP_HEADERS_<SLUG> in .env (a JSON object).

    Header values (keys, account ids) never live in this script: the editor's MCP server
    entry holds them, and .env carries them to the compiled run.
    """
    slug = MCP_SERVER_SLUGS.get(server_url, "")
    var = f"MCP_HEADERS_{slug.upper()}"
    raw = os.environ.get(var, "") if slug else ""
    if not raw:
        return dict(_MCP_BASE_HEADERS)
    try:
        extra = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"{var} in .env is not valid JSON (expected e.g. {{\\"Header\\": \\"value\\"}})") from None
    if not isinstance(extra, dict):
        raise RuntimeError(f"{var} in .env must be a JSON object")
    for k, v in extra.items():
        if not isinstance(v, str) or "\\r" in v or "\\n" in v or "\\r" in str(k) or "\\n" in str(k):
            raise RuntimeError(f"{var} in .env: every header value must be a single-line string (check header {str(k)!r})")
    return {**_MCP_BASE_HEADERS, **{str(k): v for k, v in extra.items()}}


def _mcp_live_url(server_url: str) -> str:
    """Where the server answers: MCP_URL_<SLUG> from .env when set (the server moved), else the
    registered URL. The registered URL stays the key for headers and endpoints."""
    slug = MCP_SERVER_SLUGS.get(server_url, "")
    return (os.environ.get(f"MCP_URL_{slug.upper()}", "").strip() if slug else "") or server_url


def _mcp_candidates(url: str) -> list:
    """The endpoints to try, in order: the URL exactly as given, then with /mcp in its path
    (before any query string). A path already ending in /mcp or .php is the endpoint."""
    cut = min([i for i in (url.find("?"), url.find("#")) if i >= 0] or [len(url)])
    path, rest = url[:cut].rstrip("/"), url[cut:]
    if path.endswith("/mcp") or path.endswith(".php"):
        return [url]
    return [url, path + "/mcp" + rest]


def _parse_mcp_response(text: str) -> dict | None:
    """A JSON-RPC response as plain JSON, or the first parsable SSE \`data:\` line."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for line in text.split("\\n"):
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data:
                try:
                    return json.loads(data)
                except json.JSONDecodeError:
                    continue
    return None


def _init_mcp_session(server_url: str) -> str | None:
    """The initialize handshake; tries _mcp_candidates(live URL): as given, then with /mcp.
    Returns the endpoint that answered (remembered per server), or None."""
    h = _mcp_headers(server_url)   # outside the try: a bad MCP_HEADERS_<SLUG> stops the run
    init_req = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05",
                           "clientInfo": {"name": "ADK-Workflow", "version": "1.0.0"}, "capabilities": {}}}
    candidates = [_MCP_ENDPOINTS[server_url]] if server_url in _MCP_ENDPOINTS else []
    live = _mcp_live_url(server_url)
    for cand in _mcp_candidates(live):
        if cand not in candidates:
            candidates.append(cand)
    last_err = None
    for mcp_url in candidates:
        try:
            with httpx.Client(timeout=30) as c:
                r = c.post(mcp_url, json=init_req, headers=h)
                r.raise_for_status()
                data = _parse_mcp_response(r.text)
                if data is None or "error" in data:
                    last_err = (data or {}).get("error") if data else "invalid response"
                    continue
                c.post(mcp_url, json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, headers=h)
                _MCP_ENDPOINTS[server_url] = mcp_url
                return mcp_url
        except Exception as e:
            last_err = e
    print(f"[warn] MCP init failed for {server_url}: {last_err}")
    return None


def _call_mcp_tool_raw(server_url: str, tool_name: str, arguments: dict) -> dict:
    """tools/call; the raw MCP result {content, structuredContent?, isError?} (code nodes)."""
    mcp_url = _init_mcp_session(server_url) or _mcp_candidates(_mcp_live_url(server_url))[-1]
    request = {"jsonrpc": "2.0", "id": int(time.time()), "method": "tools/call",
               "params": {"name": tool_name, "arguments": arguments or {}}}
    try:
        with httpx.Client(timeout=180) as c:
            r = c.post(mcp_url, json=request, headers=_mcp_headers(server_url))
            r.raise_for_status()
            data = _parse_mcp_response(r.text)
    except Exception as e:   # refused, timed out, HTTP error
        return {"isError": True, "transport_error": True, "content": [{"type": "text", "text": str(e)}]}
    if data is None:
        return {"isError": True, "content": [{"type": "text", "text": "invalid response"}]}
    if "error" in data:
        return {"isError": True, "content": [{"type": "text", "text": data["error"].get("message", "unknown")}]}
    return data.get("result") or {}


def _call_mcp_tool(server_url: str, tool_name: str, arguments: dict) -> str:
    """tools/call for an agent's tool or a playbook #Action: the result's text items joined,
    the raw result as JSON when it has none, {"error": ...} on failure."""
    res = _call_mcp_tool_raw(server_url, tool_name, arguments)
    texts = [c.get("text", "") for c in res.get("content") or [] if isinstance(c, dict) and c.get("type") == "text"]
    if res.get("isError"):
        return json.dumps({"error": "\\n".join(t for t in texts if t) or "tool error"})
    return "\\n".join(t for t in texts if t) or json.dumps(res)[:8000]`;
    }

    /**
     * The code-node contract as the editor runs it (frontend/assets/py/code_node_harness.py): the single
     * file embeds a copy, as LangGraph's single file does; the package imports its own copy, code_harness.py
     * in its folder (ADKPackage). Either way the compiled program reads nothing outside itself.
     */
    static codeHarnessBlock(package_: boolean): string {
        let load: string, src: string;
        if (package_) {
            load = 'import code_harness as CODE_HARNESS   # code_harness.py in this folder\n\n\n';
        } else {
            try {
                src = readFileSync(CODE_NODE_HARNESS_PATH, 'utf8');
            } catch {
                throw new Error('code node harness not found (frontend/assets/py/code_node_harness.py)');
            }
            load = 'import types as types_module   # google.genai\'s `types` already holds the name\n'
                + 'CODE_HARNESS_SOURCE = ' + json_encode(src, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) + '\n'
                + 'CODE_HARNESS = types_module.ModuleType("code_node_harness")\n'
                + 'exec(CODE_HARNESS_SOURCE, CODE_HARNESS.__dict__)\n\n\n';
        }
        return load
            + 'def _code_transport(server: str, tool: str, args: dict) -> dict:\n'
            + '    """call_tool\'s transport: the raw MCP result of server.tool(args)."""\n'
            + '    url = MCP_SLUGS.get(server)\n'
            + '    if not url:\n'
            + '        return {"isError": True, "content": [{"type": "text", "text": f"MCP server {server!r} is not in this workflow"}]}\n'
            + '    return _call_mcp_tool_raw(url, tool, args)\n';
    }

    /**
     * Run events (spec 2026-10-15 §4): each node's start and completion -- its exit for a code node, its
     * route for a dispatcher -- go to GRAPH_RECORDER, the run's recorder, which the package's listener sets
     * (runs/ and GET /live, what the editor's live canvas shows). None (the single file, a served run):
     * nothing is recorded. Agents are recorded through ADK's before/after agent callbacks, a dispatcher
     * by _DispatcherAgent itself (its chooser is not the node: the route is).
     */
    static recordingBlock(analyzed: any, agentCallbacks: boolean = false): string {
        const menus = GraphAnalyzer.dispatchMenus(analyzed)['menus'];
        const routed: any = oarr();
        for (const [did, targets] of entries(menus)) {
            for (const t of values(targets)) {
                if (CompiledRuntimeEmit.menuNestable(analyzed, strval(t['id']))) {
                    routed[strval(did)] = true;   // a _DispatcherAgent stands for this node
                }
            }
        }
        const meta: any = oarr();
        const outputs: string[] = [];
        let start: [string, string] | null = null;
        for (const rawId of values(toArr(analyzed['order'] ?? []))) {
            const id = strval(rawId);
            const type = GraphAnalyzer.typeOf(dig(analyzed, 'byId', id) ?? []);
            const name = CompiledRuntimeEmit.displayName(analyzed, id);
            if (type === 'start') {
                start ??= [id, name === id ? 'Start' : name];
            } else if (isset(analyzed, 'code', id)) {
                meta[`node_${id}`] = [id, 'code', name];
            } else if (isset(analyzed, 'playbooks', id)) {
                meta[`node_${id}`] = [id, 'playbook', name];
            } else if (type === 'output') {
                meta[`node_${id}`] = [id, 'output', name === id ? 'Output' : name];
                outputs.push(`node_${id}`);
            } else if (isset(analyzed, 'agents', id) && !has(routed, id)) {
                meta[`node_${id}`] = [id, 'agent', name];
            }
        }
        const metaPy = isEmptyArr(meta) ? '{}' : PythonEmitHelpers.jsonToPython(meta);
        const startPy = start === null ? 'None' : '[' + PythonEmitHelpers.pyStr(start[0]) + ', ' + PythonEmitHelpers.pyStr(start[1]) + ']';
        const outPy = '[' + outputs.map((o) => PythonEmitHelpers.pyStr(o)).join(', ') + ']';
        return `NODE_META = ${metaPy}   # agent name -> [node id, type, canvas name]: the nodes whose runs are recorded\n`
            + `START_NODE = ${startPy}   # [id, name] of the Start node\n`
            + 'DISPATCHER_IDS = [' + keysOf(routed).map((k) => PythonEmitHelpers.pyStr(strval(k))).join(', ')
                + ']   # dispatchers record themselves; their choice is work (not a quiet poll)\n'
            + `OUTPUT_NODE_KEYS = ${outPy}   # the Output nodes: their answers are the workflow's answer\n`
            + `GRAPH_RECORDER = None   # the run's RunRecorder (the package's listener sets it); None: nothing is recorded
_RUN = {"ran": [], "routes": {}, "open": {}, "unrouted": ""}   # this run: nodes that ran, code exits, nodes
#   started not completed, and why a dispatcher did not route (the answer when nothing reached the Output)


def _set_recorder(recorder) -> None:
    """The run's recorder: the listener's run_once sets it for a run and resets it after. A setter, not an
    assignment from outside, so a package that keeps this in common.py still records."""
    global GRAPH_RECORDER
    GRAPH_RECORDER = recorder


def _current_recorder():
    return GRAPH_RECORDER


def _run_reset() -> None:
    _RUN["ran"], _RUN["routes"], _RUN["open"], _RUN["unrouted"] = [], {}, {}, ""


def _rec_node_start(nid: str, name: str, ntype: str) -> None:
    _RUN["open"][nid] = (name, ntype)
    if GRAPH_RECORDER is not None:
        GRAPH_RECORDER.node_start(nid, name, ntype)


def _rec_node_complete(nid: str, name: str, ntype: str, output: str = "", **extra) -> None:
    _RUN["open"].pop(nid, None)
    _RUN["ran"].append(nid)
    if "exit" in extra:
        _RUN["routes"][nid] = extra["exit"]
    if GRAPH_RECORDER is not None:
        GRAPH_RECORDER.node_complete(nid, name, ntype, output=str(output or ""), **extra)`
            + (agentCallbacks ? '\n\n\n' + `def _rec_before(callback_context):
    meta = NODE_META.get(callback_context.agent_name)
    if meta:
        _rec_node_start(meta[0], meta[2], meta[1])
    return None


def _rec_after(callback_context):
    meta = NODE_META.get(callback_context.agent_name)
    if meta:
        nid, ntype, name = meta
        extra = {"exit": callback_context.state.get("route_" + nid)} if ntype == "code" else {}
        _rec_node_complete(nid, name, ntype, output=callback_context.state.get("node_" + nid, ""), **extra)
    return None


def _attach_recording(agent) -> None:
    """Every recorded node's agent gets the before/after callbacks, wherever it sits in the tree."""
    if agent.name in NODE_META:
        agent.before_agent_callback = _rec_before
        agent.after_agent_callback = _rec_after
    for sub in getattr(agent, "sub_agents", None) or []:
        _attach_recording(sub)`
            : '');
    }

    /**
     * The package's listener and CLI, as the LangGraph modular package has them: the Start's cron or watch
     * loop (LangGraph's framework-free cron / watch / listener blocks, copied in), each run recorded under
     * RUNS_DIR for GET /live, make_listener() for api.py (POST /listen), and the CLI's modes
     * (prompt: one run; --cron; --watch; --once). The single file keeps its one-prompt __main__.
     */
    /** The CLI hooks of a target whose run_workflow prints the answer and its summary itself (ADK). */
    static readonly CLI_HOOKS_SILENT = `def _cli_begin(prompt: str) -> None:
    """Before a one-off CLI run (not --quiet): run_workflow prints its own banner."""


def _cli_end(output: str) -> None:
    """After a one-off CLI run (not --quiet): run_workflow printed the answer and the RUN SUMMARY."""
`;

    static packageListenBlock(cliHooks: string = CompiledRuntimeEmit.CLI_HOOKS_SILENT): string {
        let head: any, tail: any;
        head = `# ==============================================================
# LISTENER -- the Start's schedule or event trigger
# The cron / watch / listener code below is the LangGraph package's,
# copied in as is: it has no framework in it. Each run is recorded
# under RUNS_DIR (runs/), which api.py streams as GET /live.
# ==============================================================
import argparse, re, signal
from datetime import datetime, timedelta
from typing import Callable

from common import RUN_OUT, NULL_RECORDER, RunRecorder, ConsoleView, is_quiet


class _McpShim:
    """The watch trigger's MCP calls (WatchTrigger.wait), through this program's MCP client."""
    call_tool_raw = staticmethod(_call_mcp_tool_raw)


MCP = _McpShim()

{CLI_HOOKS}`;
        tail = `RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")
NODE_TYPES = {meta[0]: meta[1] for meta in NODE_META.values()}   # node id -> type (the quiet rule)
for _did in DISPATCHER_IDS:
    NODE_TYPES[_did] = "agent"   # a dispatcher's choice, routed or not, is work
if START_NODE:
    NODE_TYPES[START_NODE[0]] = "start"


class ErrorExitTaken(Exception):
    """A code node took its error exit: the run failed although nothing raised."""


def _save_output(text: str) -> str | None:
    """The Output node's storage rule: when ON, the answer goes to outputs/ in this folder (SYNERGYAI_OUTPUT_ROOT
    overrides) or the workflow's custom folder; returns the file's path, or None when OFF."""
    if not OUTPUT_STORAGE_ENABLED:
        return None
    m = re.search(r"(?is)<!doctype html.*?</html\\s*>", text) or re.search(r"(?is)<html[\\s>].*?</html\\s*>", text)
    text, ext = (m.group(0), "html") if m else (text, "md")
    slug = "".join(c if c.isalnum() else "_" for c in WORKFLOW_NAME).strip("_")[:60] or "workflow"
    root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")
    if OUTPUT_FOLDER:
        cf = os.path.expanduser(OUTPUT_FOLDER)
        save_dir = cf if os.path.isabs(cf) else os.path.join(root, OUTPUT_FOLDER)
    else:
        save_dir = os.path.join(root, "workflow")
    os.makedirs(save_dir, exist_ok=True)
    out = os.path.join(save_dir, f"{WORKFLOW_ID}-{slug}_{time.strftime('%Y%m%d-%H%M%S')}.{ext}")
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    return os.path.abspath(out)


def make_run_once(prompt: str, runs: RunLoop, view: ConsoleView, recorder: RunRecorder, *,
                  loop_mode: bool = False) -> Callable[[], str]:
    """One run of the workflow on \`prompt\`, recorded by \`recorder\` (runs/ and \`view\`). Returns the answer
    ('' when no Output node ran). A quiet run (a code node's non-error exit, no agent, playbook or output
    node ran) leaves no run file. Raises ErrorExitTaken when a code node took its error exit."""
    def run_once() -> str:
        ev_loop = runs.loop   # this run's event loop, read once: drain() may give later runs a fresh one
        this_run = recorder.begin()
        _set_recorder(recorder)
        RUN_OUT.begin("hold" if loop_mode else "drop" if view.verbosity == "quiet" else "print")
        try:
            output = ev_loop.run_until_complete(run_workflow(prompt))
            kinds = {nid: {"kind": t} for nid, t in NODE_TYPES.items()}
            if is_quiet(NODE_TYPES, _RUN["routes"], kinds, _RUN["ran"]):
                view.discard()
                RUN_OUT.release(False)
                recorder.end(quiet=True)
                return ""
            RUN_OUT.release(loop_mode and view.verbosity == "verbose")
            if output:
                saved = _save_output(output)
                if saved:
                    print(f"  Document saved to: {saved}", flush=True)
            failed = [nid for nid, ex in _RUN["routes"].items() if ex == "error"]
            if failed:
                raise ErrorExitTaken(f"code node {failed[0]} took its error exit")
        except BaseException as e:
            RUN_OUT.release(loop_mode and view.verbosity == "verbose")
            recorder.complete(success=False, error=f"{type(e).__name__}: {e}" if str(e) else type(e).__name__)
            recorder.end(quiet=False)
            raise
        finally:
            # Back to no recorder -- only while this run still owns it: a run abandoned at the cap that
            # ends late must not reset the run that replaced it.
            if _current_recorder() is recorder and recorder.run_id == this_run:
                RUN_OUT.begin("print")
                _set_recorder(NULL_RECORDER)
        recorder.complete(success=True, output=output)
        recorder.end(quiet=False)
        return output
    return run_once


def _refuse(message: str):
    """make_listener's parser error: a usage error becomes a ValueError instead of an exit."""
    raise ValueError(message)


def make_listener(state: LoopState) -> Listener | None:
    """The Start's cron or watch loop for api.py (POST /listen), not yet started; None when the Start
    takes a prompt. ValueError: the Start's schedule or trigger is missing or bad."""
    if START_MODE not in ("cron", "watch"):
        return None
    ap = argparse.ArgumentParser()
    ap.error = _refuse
    cron = CronExpression.from_cli(ap, "" if START_MODE == "cron" else None, DEFAULT_CRON)
    watch = WatchTrigger.from_cli(ap, "" if START_MODE == "watch" else None, DEFAULT_WATCH)
    runs = RunLoop()
    view = ConsoleView("quiet")
    recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])
    run_once = make_run_once(DEFAULT_PROMPT or "Hello", runs, view, recorder, loop_mode=True)
    drains = "code" in NODE_TYPES.values()
    return Listener(START_MODE, run_once, drains=drains, loop=runs, cron_expr=cron, trigger=watch, state=state,
                    lock_path=os.path.join(PACKAGE_DIR, ".run.lock"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=f"ADK workflow {WORKFLOW_NAME!r}", allow_abbrev=False)
    ap.add_argument("prompt", nargs="*", help="the request (default: the Start node prompt)")
    when = ap.add_mutually_exclusive_group()
    when.add_argument("--once", action="store_true", help="run once, even when the Start listens or is scheduled")
    when.add_argument("--cron", nargs="?", const="", default=None, metavar="EXPR",
                      help="run on a cron schedule until Ctrl-C (default: the Start node's schedule)")
    when.add_argument("--watch", nargs="?", const="", default=None, metavar="TRIGGER",
                      help="run whenever an MCP tool says something new arrived, until Ctrl-C "
                           "(default: the Start option's trigger; or 'server.tool {json args}')")
    talk = ap.add_mutually_exclusive_group()
    talk.add_argument("--quiet", action="store_true", help="print only each run's done / failed line")
    talk.add_argument("--verbose", action="store_true", help="also print each node's output")
    a = ap.parse_args()
    mode = choose_mode(a, START_MODE)
    prompt = " ".join(a.prompt) or DEFAULT_PROMPT or "Hello"
    runs = RunLoop()
    view = ConsoleView("quiet" if a.quiet else "verbose" if a.verbose else "normal")
    recorder = RunRecorder(RUNS_DIR, WORKFLOW_ID, WORKFLOW_NAME, listeners=[view])
    run_once = make_run_once(prompt, runs, view, recorder, loop_mode=mode != "once")
    cron = CronExpression.from_cli(ap, a.cron if a.cron is not None else ("" if mode == "cron" else None), DEFAULT_CRON)
    watch = WatchTrigger.from_cli(ap, a.watch if a.watch is not None else ("" if mode == "watch" else None), DEFAULT_WATCH)
    if mode == "once":
        if not a.quiet:
            _cli_begin(prompt)
        try:
            output = run_once()
        except ErrorExitTaken as e:
            sys.exit(1 if a.quiet else f"[error] {e}")
        if not a.quiet:
            _cli_end(output)
    else:
        Listener(mode, run_once, drains="code" in NODE_TYPES.values(), loop=runs, cron_expr=cron, trigger=watch,
                 state=LoopState(), lock_path=os.path.join(PACKAGE_DIR, ".run.lock"),
                 verbosity=view.verbosity).run_blocking()`;
        return str_replace('{CLI_HOOKS}', cliHooks, head) + LangGraphRuntime.cronBlock() + '\n\n' + LangGraphRuntime.watchBlock() + '\n\n'
            + LangGraphRuntime.listenerBlock() + '\n\n' + tail;
    }

    /**
     * "Agents in separate files": one module per node a target defines on its own (agent, dispatcher, playbook,
     * code), named as LangGraph's modularLayout() names them -- the display name slugged to an identifier, else
     * node_<id>_<slug> (also on a clash, or with common / workflow / agents).
     *
     * @return array<string, array{name:string, file:string, module:string, display:string}> node id => module
     */
    static moduleLayout(analyzed: any): any {
        const used: Record<string, boolean> = { common: true, workflow: true, agents: true };
        const out: any = oarr();
        for (const rawNid of values(toArr(analyzed['order'] ?? []))) {
            const nid = strval(rawNid);
            const display = dig(analyzed, 'code', nid, 'display') ?? dig(analyzed, 'playbooks', nid, 'display')
                ?? dig(analyzed, 'agents', nid, 'name') ?? null;
            if (display === null) {
                continue;
            }
            const ascii = asciiOf(strval(display));
            const slug = strtolower(trim(strval(preg_replace('/[^a-z0-9]+/i', '-', ascii)), '-'));
            let name = str_replace('-', '_', substr(slug !== '' ? slug : 'node', 0, 40));
            if (!preg_match('/^[a-z_][a-z0-9_]*$/', name) || Object.hasOwn(used, name)) {
                name = `node_${nid}_${name}`;
            }
            used[name] = true;
            out[nid] = { name: name, file: `agents/${name}.py`, module: `agents.${name}`, display: strval(display) };
        }
        return out;
    }

    /**
     * Agents in separate files, for a target whose runtime reads node tables (MAF, NOOA): [workflow.py,
     * common.py, agents/ files]. common.py is the runtime with empty tables plus the run server's shared pieces;
     * agents/<name>.py holds one node's entries ($tables: VAR => [TABLE, literals by id]), after its $preludes
     * source when it has one (NOOA's Agent class); workflow.py fills the tables from them, then the $assembly.
     */
    static tablePackage(analyzed: any, common: any, assembly: any, tables: any, preludes: any,
        title: string, nodeRole: string, runtimeRole: string): [string, string, Array<{ path: string; code: string }>] {
        const layout = CompiledRuntimeEmit.moduleLayout(analyzed);
        const wfName = json_encode(strval(analyzed['workflow']['name']), JSON_UNESCAPED_UNICODE);
        const q = '"""';
        const files: Array<{ path: string; code: string }> = [{ path: 'agents/__init__.py', code: `${q}The workflow's nodes, one module each (imported by workflow.py).${q}\n` }];
        const imports: string[] = [];
        const fills: any = oarr();
        for (const [nid, m] of entries(layout)) {
            const body: string[] = has(preludes, nid) ? [preludes[nid]] : [];
            for (const [var_, pair] of entries(tables)) {
                const [table, literals] = values(pair);
                if (has(literals, nid)) {
                    body.push(`${var_} = ` + strval(literals[nid]) + `   # ${table}["${nid}"]`);
                    if (!has(fills, table)) fills[table] = [];
                    fills[table].push('    ' + PythonEmitHelpers.pyStr(strval(nid)) + `: _node_${nid}.${var_},`);
                }
            }
            if (body.length === 0) {
                continue;
            }
            const display = str_replace([q, '\n'], ["'''", ' '], m['display']);
            files.push({ path: m['file'], code: `${q}Node ${nid} (${display}) of the workflow ${wfName}: ${nodeRole}.\n\n`
                + `Imported by workflow.py. To change the node, edit the workflow in the editor and re-generate.${q}\n`
                + 'from common import *  # noqa: F401,F403 -- the runtime\n\n\n'
                + body.join('\n\n\n') + '\n' });
            // Under a private alias: a node named like a module (time, json, re...) must not shadow it here.
            imports.push(`from agents import ${m['name']} as _node_${nid}  # ${display}`);
        }
        let fill = '';
        for (const [table, lines] of entries(fills)) {
            fill += `${table}.update({\n` + implode('\n', lines) + '\n})\n';
        }
        const workflow = `${q}Workflow ${wfName} -- ${title}, agents in separate files.\n\n`
            + `common.py holds the runtime (${runtimeRole}), agents/ one module per node; this file fills the node\n`
            + `tables, then builds and runs the workflow: run_workflow(), the Start's listener and the CLI.\n${q}\n`
            + 'from common import *  # noqa: F401,F403 -- the runtime\n'
            + imports.join('\n') + '\n\n'
            + fill + '\n\n'
            + implode('\n\n', assembly) + '\n';
        return [workflow, CompiledRuntimeEmit.packageCommonWithRuntime(common), files];
    }

    /**
     * The package's common.py when the target's runtime lives there too (agents in separate files): the
     * runtime's first part (its docstring and imports) first, then the run server's shared pieces
     * (packageCommonBlock), then the rest of the runtime, then __all__ so `from common import *` brings every
     * name, the _-prefixed ones included.
     */
    static packageCommonWithRuntime(runtimeParts: any): string {
        const parts = values<string>(runtimeParts);
        const head = parts.length > 0 ? strval(parts[0]) : '';
        const rest = parts.slice(1);
        const server = preg_replace('/\\A"""[^\\n]*"""\\n/', '', CompiledRuntimeEmit.packageCommonBlock());   // its docstring: the runtime's comes first
        return head + '\n' + server + '\n' + implode('\n', rest) + '\n\n'
            + '__all__ = [n for n in dir() if not n.startswith("__")]   # agents/ and workflow.py import it all (_ names too)\n';
    }

    /** The package's common.py: the run server's event sink, and the run records, live feed and console view (LangGraph's, copied). */
    static packageCommonBlock(): string {
        return '"""Shared by workflow.py and api.py: the event sink, run records (runs/), the live feed (GET /live), the console view."""\n'
            + 'import json, os, re, threading, time, uuid\n'
            + 'from datetime import datetime\n'
            + 'from typing import Callable\n\n'
            + PythonEmitHelpers.eventSinkBlock() + '\n\n'
            + LangGraphRuntime.runRecordBlock() + '\n\n'
            + LangGraphRuntime.liveFeedBlock() + '\n\n'
            + LangGraphRuntime.consoleBlock() + '\n';
    }

    /** @param urlName url => [slug => name]; returns url => slug */
    static serverSlugs(urlName: any): any {
        const out: any = oarr();
        const owner: Record<string, string> = {};
        for (const [url, allNames] of entries(urlName)) {
            const names = entries(allNames).filter(([s]) => s !== '');
            if (names.length === 0) {
                continue;
            }
            if (names.length > 1) {
                throw new Error('MCP servers "' + strval(names[0][1]) + '" and "' + strval(names[1][1]) + '" share the URL ' + url
                    + '; a compiled script supports one connection per MCP URL. For a second mailbox (or account), run a second'
                    + ' server instance on its own URL and register that.');
            }
            const slug = names[0][0];
            if (Object.hasOwn(owner, slug) && owner[slug] !== url) {
                throw new Error('Two MCP servers both map to MCP_HEADERS_' + strtoupper(slug)
                    + '; rename one so each server has its own header variable.');
            }
            owner[slug] = url;
            out[url] = slug;
        }
        return out;
    }

    /** Display name of a node: a code node's, an agent's, a playbook's, else its canvas name, else its id. */
    static displayName(analyzed: any, id: string): string {
        const cfg = toArr(dig(analyzed, 'byId', id, 'config') ?? []);
        const own = trim(strval(dig(cfg, 'name') ?? dig(cfg, 'agent_name') ?? ''));
        return strval(dig(analyzed, 'code', id, 'display') ?? dig(analyzed, 'agents', id, 'name')
            ?? dig(analyzed, 'playbooks', id, 'display') ?? (own !== '' ? own : id));
    }

    /** A dispatcher menu child this target nests under the dispatcher: an agent or a code node. */
    static menuNestable(analyzed: any, cid: string): boolean {
        return isset(analyzed, 'agents', cid) || isset(analyzed, 'code', cid);
    }

    /** CODE_NODES = {id: {display, exits, mcp_servers, timeout_s, exit_targets, args, source | source_file}}. */
    /** Each code node's CODE_NODES entry as a Python dict literal, by node id (agents in separate files). */
    static codeNodeLiterals(analyzed: any): any {
        const out: any = oarr();
        for (const [id, cd] of entries(toArr(analyzed['code'] ?? []))) {
            out[strval(id)] = PythonEmitHelpers.jsonToPython(CompiledRuntimeEmit.codeNodeEntry(analyzed, strval(id), cd));
        }
        return out;
    }

    /** One CODE_NODES entry: display, exits, MCP servers, timeout, exit targets, arguments, the code or its file. */
    private static codeNodeEntry(analyzed: any, id: string, cd: any): any {
        const exitTargets: any = oarr();
        for (const [x, ids] of entries(cd['exit_targets'])) exitTargets[x] = values(ids).map((v) => strval(v));
        const entry: any = { display: cd['display'], exits: cd['exits'], mcp_servers: cd['mcp_servers'],
            timeout_s: cd['timeout_s'],
            exit_targets: toObject(exitTargets),
            args: toObject(dig(cd, 'args') ?? []) };
        if (truthy(dig(analyzed, 'package'))) {
            entry['source_file'] = CompiledPackage.codePath(analyzed, id);   // code/<file>, read at each run
        } else {
            entry['source'] = cd['source'];
        }
        return entry;
    }

    static codeNodesLiteral(analyzed: any): string {
        const out: any = oarr();
        for (const [id, cd] of entries(toArr(analyzed['code']))) {
            out[strval(id)] = CompiledRuntimeEmit.codeNodeEntry(analyzed, strval(id), cd);
        }
        if (truthy(dig(analyzed, 'split'))) {
            return 'CODE_NODES = {}   # node id -> settings and code, filled by workflow.py from agents/';
        }
        return 'CODE_NODES = ' + PythonEmitHelpers.jsonToPython(out);
    }

    /** DecisionResult, the decision adapters (copied), DECISIONS and the routing-mode rule. */
    static decisionBlock(analyzed: any): string {
        const protocols: any = oarr();
        const decisions: any = oarr();
        for (const [did, d] of entries(toArr(analyzed['decisions'] ?? []))) {
            for (const c of values(d['decision'])) {
                protocols[strval(c['protocol'])] = true;
            }
            decisions[strval(did)] = d;
        }
        const adapterKeys = keysOf(LangGraphRuntime.ADAPTER_CLASSES);
        const known = keysOf(protocols).filter((p) => adapterKeys.includes(p));
        return 'from dataclasses import dataclass, field\nfrom functools import cached_property\n\n'
            + LangGraphRuntime.decisionAdaptersBlock(known) + '\n\n'
            + 'DECISIONS = ' + (truthy(dig(analyzed, 'split')) ? '{}   # dispatcher id -> decision routing, filled by workflow.py from agents/'
                : (isEmptyArr(decisions) ? '{}' : PythonEmitHelpers.jsonToPython(decisions))) + '\n\n\n'
            + `def _decision_router(dec: dict, provider: str):
    """The decision adapter for one compiled provider, None when it was not compiled in or has no adapter."""
    c = next((c for c in dec.get("decision", []) if c["provider"] == provider), None)
    cls = DECISION_ADAPTERS.get(c["protocol"]) if c else None
    return cls(key_env=c["key_env"], url_env=c["url_env"], url=c["url"], model=c["model"]) if cls else None


def _decision_mode(dec: dict) -> str:
    """"llm", or the decision provider this run routes with (GraphWorkflowRunner's rule): a key routes with that
    provider only (no model fallback); unset takes the first compiled provider whose key is set."""
    if dec.get("routing_mode"):
        return dec["routing_mode"]
    for c in dec.get("decision", []):
        r = _decision_router(dec, c["provider"])
        if r is not None and r.available():
            return c["provider"]
    return "llm"`;
    }

    /** _rec_start / _rec_done: run events by node id, for a target whose own runtime records its nodes (MAF, NOOA). */
    static idRecordingHelpers(): string {
        return `def _rec_start(nid: str) -> None:
    """node_start for a node NODE_META knows (an agent, code, playbook or output node)."""
    meta = NODE_META.get("node_" + str(nid))
    if meta:
        _rec_node_start(meta[0], meta[2], meta[1])


def _rec_done(nid: str, output: str, **extra) -> None:
    """node_complete for a node NODE_META knows."""
    meta = NODE_META.get("node_" + str(nid))
    if meta:
        _rec_node_complete(meta[0], meta[2], meta[1], output=output, **extra)`;
    }
}

