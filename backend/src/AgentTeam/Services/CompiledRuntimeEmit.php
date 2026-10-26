<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use RuntimeException;

/**
 * The framework-free runtime a compiled ADK, MAF or NOOA program carries, emitted once for all of them: the MCP
 * client with each server's headers (MCP_HEADERS_<SLUG>), the code-node harness (a copy of the editor's), the
 * run events (runs/ and GET /live), the package's listener and CLI (LangGraph's cron / watch / listener code,
 * copied) and its common.py. Each target supplies its own graph runtime around it.
 */
final class CompiledRuntimeEmit
{
    /**
     * What a compiled program needs beyond WorkflowGraphAnalyzer::analyze() (+ 'playbooks'), read at compile
     * time only: 'code' (each code node's settings), 'serverSlugs' (url => slug, MCP_HEADERS_<SLUG>),
     * 'decisions' (each dispatcher's decision-model routing), and the Start's mode, schedule and trigger.
     */
    public static function analyzeRuntime(array $analyzed, WorkflowGraphAnalyzer $analyzer, ?\PDO $db,
        ?AgentRepository $agentRepo, array $graphRaw, int $workflowId, ?string $userId): array
    {
        $index = $analyzer->serverIndex($userId);   // slug => {url, name}: the user's MCP servers
        // Code nodes (spec 2026-10-04): validated settings, exit -> children, the servers they call.
        $slugToUrl = array_map(fn($s) => $s['url'], $index);
        $analyzed['code'] = [];
        foreach ((array) $analyzed['order'] as $nid) {   // analyzeGraph()'s topological order
            $node = $analyzed['byId'][$nid] ?? null;
            if ($node !== null && WorkflowGraphAnalyzer::typeOf($node) === 'code') {
                $analyzed['code'][(string) $nid] = CodeNodeEmit::nodeData($node, $graphRaw['edges'] ?? [], $slugToUrl,
                    array_keys((array) $analyzed['byId']));
            }
        }

        // MCP_SERVER_SLUGS: every URL this script calls -> its server's slug (MCP_HEADERS_<SLUG>).
        $urlName = [];
        foreach ((array) ($analyzed['usedServers'] ?? []) as $surl => $meta) {
            $urlName[(string) $surl][CodeNodeEmit::slug((string) ($meta['name'] ?? ''))] = (string) ($meta['name'] ?? '');
        }
        foreach ($analyzed['playbooks'] as $pd) {
            foreach ($pd['actions'] as $a) {
                if (($a['kind'] ?? '') === 'mcp') {
                    $slg = CodeNodeEmit::slug(explode('.', (string) $a['target'], 2)[0]);
                    $urlName[(string) $a['server_url']][$slg] = $index[$slg]['name'] ?? $slg;
                }
            }
        }
        foreach ($analyzed['code'] as $cd) {
            foreach ($cd['mcp_servers'] as $slg) {
                $urlName[$index[$slg]['url']][$slg] = $index[$slg]['name'];
            }
        }
        $analyzed['serverSlugs'] = CompiledRuntimeEmit::serverSlugs($urlName);
        // Each dispatcher's decision-model routing (Jev...), baked: the program never reads the database.
        $analyzed['decisions'] = [];
        foreach (array_keys(WorkflowGraphAnalyzer::dispatchMenus($analyzed)['menus']) as $did) {
            $analyzed['decisions'][(string) $did] = DispatcherDecisionFacts::of($db, $agentRepo,
                (array) $analyzed['byId'][$did], (string) $analyzed['workflow']['name']);
        }
        $ordered = array_map(fn($id) => ['id' => (string) $id] + (array) $analyzed['byId'][$id], (array) $analyzed['order']);
        $analyzed += StartTriggerFacts::of($db, $workflowId, $ordered, $analyzed['serverSlugs']);
        return $analyzed;
    }

    /**
     * ADK's own MCP client (PythonEmitHelpers::mcpClientBlock() stays for MAF and NOOA): per-server
     * headers from MCP_HEADERS_<SLUG>, a moved server from MCP_URL_<SLUG>, and a raw call for code nodes.
     */
    public static function mcpClientBlock(array $analyzed): string
    {
        $slugs = (array) ($analyzed['serverSlugs'] ?? []);
        $head = 'MCP_SERVER_SLUGS = ' . ($slugs === [] ? '{}' : PythonEmitHelpers::jsonToPython($slugs, true))
            . "   # registered URL -> slug: MCP_HEADERS_<SLUG> / MCP_URL_<SLUG> in .env\n"
            . "MCP_SLUGS = {v: k for k, v in MCP_SERVER_SLUGS.items()}   # slug -> URL (a code node's call_tool)\n\n";
        return $head . <<<'PY'
_MCP_BASE_HEADERS = {"Content-Type": "application/json",
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
        raise RuntimeError(f"Environment variable {var} is not valid JSON (expected e.g. {{\"Header\": \"value\"}})") from None
    if not isinstance(extra, dict):
        raise RuntimeError(f"Environment variable {var} must be a JSON object")
    for k, v in extra.items():
        if not isinstance(v, str) or "\r" in v or "\n" in v or "\r" in str(k) or "\n" in str(k):
            raise RuntimeError(f"Environment variable {var}: every header value must be a single-line string (check header {str(k)!r})")
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
    """A JSON-RPC response as plain JSON, or the first parsable SSE `data:` line."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for line in text.split("\n"):
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
        return json.dumps({"error": "\n".join(t for t in texts if t) or "tool error"})
    return "\n".join(t for t in texts if t) or json.dumps(res)[:8000]
PY;
    }

    /**
     * The code-node contract as the editor runs it (frontend/assets/py/code_node_harness.py): the single
     * file embeds a copy, as LangGraph's single file does; the package imports its own copy, code_harness.py
     * in its folder (ADKPackage). Either way the compiled program reads nothing outside itself.
     */
    public static function codeHarnessBlock(bool $package): string
    {
        if ($package) {
            $load = "import code_harness as CODE_HARNESS   # code_harness.py in this folder\n\n\n";
        } else {
            $src = file_get_contents(__DIR__ . '/../../../../frontend/assets/py/code_node_harness.py');
            if ($src === false) {
                throw new RuntimeException('code node harness not found (frontend/assets/py/code_node_harness.py)');
            }
            $load = "import types as types_module   # google.genai's `types` already holds the name\n"
                . 'CODE_HARNESS_SOURCE = ' . json_encode($src, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n"
                . "CODE_HARNESS = types_module.ModuleType(\"code_node_harness\")\n"
                . "exec(CODE_HARNESS_SOURCE, CODE_HARNESS.__dict__)\n\n\n";
        }
        return $load
            . "def _code_transport(server: str, tool: str, args: dict) -> dict:\n"
            . "    \"\"\"call_tool's transport: the raw MCP result of server.tool(args).\"\"\"\n"
            . "    url = MCP_SLUGS.get(server)\n"
            . "    if not url:\n"
            . "        return {\"isError\": True, \"content\": [{\"type\": \"text\", \"text\": f\"MCP server {server!r} is not in this workflow\"}]}\n"
            . "    return _call_mcp_tool_raw(url, tool, args)\n";
    }

    /**
     * Run events (spec 2026-10-15 §4): each node's start and completion -- its exit for a code node, its
     * route for a dispatcher -- go to GRAPH_RECORDER, the run's recorder, which the package's listener sets
     * (runs/ and GET /live, what the editor's live canvas shows). None (the single file, a served run):
     * nothing is recorded. Agents are recorded through ADK's before/after agent callbacks, a dispatcher
     * by _DispatcherAgent itself (its chooser is not the node: the route is).
     */
    public static function recordingBlock(array $analyzed, bool $agentCallbacks = false): string
    {
        $menus = WorkflowGraphAnalyzer::dispatchMenus($analyzed)['menus'];
        $routed = [];
        foreach ($menus as $did => $targets) {
            foreach ($targets as $t) {
                if (self::menuNestable($analyzed, (string) $t['id'])) {
                    $routed[(string) $did] = true;   // a _DispatcherAgent stands for this node
                }
            }
        }
        $meta = [];
        $outputs = [];
        $start = null;
        foreach ((array) ($analyzed['order'] ?? []) as $id) {
            $id = (string) $id;
            $type = WorkflowGraphAnalyzer::typeOf($analyzed['byId'][$id] ?? []);
            $name = self::displayName($analyzed, $id);
            if ($type === 'start') {
                $start ??= [$id, $name === $id ? 'Start' : $name];
            } elseif (isset($analyzed['code'][$id])) {
                $meta["node_{$id}"] = [$id, 'code', $name];
            } elseif (isset($analyzed['playbooks'][$id])) {
                $meta["node_{$id}"] = [$id, 'playbook', $name];
            } elseif ($type === 'output') {
                $meta["node_{$id}"] = [$id, 'output', $name === $id ? 'Output' : $name];
                $outputs[] = "node_{$id}";
            } elseif (isset($analyzed['agents'][$id]) && !isset($routed[$id])) {
                $meta["node_{$id}"] = [$id, 'agent', $name];
            }
        }
        $metaPy = $meta === [] ? '{}' : PythonEmitHelpers::jsonToPython($meta);
        $startPy = $start === null ? 'None' : '[' . PythonEmitHelpers::pyStr($start[0]) . ', ' . PythonEmitHelpers::pyStr($start[1]) . ']';
        $outPy = '[' . implode(', ', array_map([PythonEmitHelpers::class, 'pyStr'], $outputs)) . ']';
        return "NODE_META = {$metaPy}   # agent name -> [node id, type, canvas name]: the nodes whose runs are recorded\n"
            . "START_NODE = {$startPy}   # [id, name] of the Start node\n"
            . 'DISPATCHER_IDS = [' . implode(', ', array_map([PythonEmitHelpers::class, 'pyStr'], array_map('strval', array_keys($routed))))
                . "]   # dispatchers record themselves; their choice is work (not a quiet poll)\n"
            . "OUTPUT_NODE_KEYS = {$outPy}   # the Output nodes: their answers are the workflow's answer\n"
            . <<<'PY'
GRAPH_RECORDER = None   # the run's RunRecorder (the package's listener sets it); None: nothing is recorded
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
        GRAPH_RECORDER.node_complete(nid, name, ntype, output=str(output or ""), **extra)
PY
            . ($agentCallbacks ? "\n\n\n" . <<<'PY'
def _rec_before(callback_context):
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
        _attach_recording(sub)
PY
            : '');
    }

    /**
     * The package's listener and CLI, as the LangGraph modular package has them: the Start's cron or watch
     * loop (LangGraph's framework-free cron / watch / listener blocks, copied in), each run recorded under
     * RUNS_DIR for GET /live, make_listener() for api.py (POST /listen), and the CLI's modes
     * (prompt: one run; --cron; --watch; --once). The single file keeps its one-prompt __main__.
     */
    /** The CLI hooks of a target whose run_workflow prints the answer and its summary itself (ADK). */
    public const CLI_HOOKS_SILENT = <<<'PY'
def _cli_begin(prompt: str) -> None:
    """Before a one-off CLI run (not --quiet): run_workflow prints its own banner."""


def _cli_end(output: str) -> None:
    """After a one-off CLI run (not --quiet): run_workflow printed the answer and the RUN SUMMARY."""

PY;

    public static function packageListenBlock(string $cliHooks = self::CLI_HOOKS_SILENT): string
    {
        $head = <<<'PY'
# ==============================================================
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

{CLI_HOOKS}
PY;
        $tail = <<<'PY'
RUNS_DIR = os.environ.get("RUNS_DIR") or os.path.join(PACKAGE_DIR, "runs")
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
    m = re.search(r"(?is)<!doctype html.*?</html\s*>", text) or re.search(r"(?is)<html[\s>].*?</html\s*>", text)
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
    """One run of the workflow on `prompt`, recorded by `recorder` (runs/ and `view`). Returns the answer
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
                 verbosity=view.verbosity).run_blocking()
PY;
        return str_replace('{CLI_HOOKS}', $cliHooks, $head) . LangGraphRuntime::cronBlock() . "\n\n" . LangGraphRuntime::watchBlock() . "\n\n"
            . LangGraphRuntime::listenerBlock() . "\n\n" . $tail;
    }

    /**
     * "Agents in separate files": one module per node a target defines on its own (agent, dispatcher, playbook,
     * code), named as LangGraph's modularLayout() names them -- the display name slugged to an identifier, else
     * node_<id>_<slug> (also on a clash, or with common / workflow / agents).
     *
     * @return array<string, array{name:string, file:string, module:string, display:string}> node id => module
     */
    public static function moduleLayout(array $analyzed): array
    {
        $used = ['common' => true, 'workflow' => true, 'agents' => true];
        $out = [];
        foreach ((array) ($analyzed['order'] ?? []) as $nid) {
            $nid = (string) $nid;
            $display = $analyzed['code'][$nid]['display'] ?? $analyzed['playbooks'][$nid]['display']
                ?? $analyzed['agents'][$nid]['name'] ?? null;
            if ($display === null) {
                continue;
            }
            $ascii = str_replace(["'", '"', '`', '^', '~'], '', iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', (string) $display) ?: (string) $display);
            $slug = strtolower(trim((string) preg_replace('/[^a-z0-9]+/i', '-', $ascii), '-'));
            $name = str_replace('-', '_', substr($slug !== '' ? $slug : 'node', 0, 40));
            if (!preg_match('/^[a-z_][a-z0-9_]*$/', $name) || isset($used[$name])) {
                $name = "node_{$nid}_{$name}";
            }
            $used[$name] = true;
            $out[$nid] = ['name' => $name, 'file' => "agents/{$name}.py", 'module' => "agents.{$name}", 'display' => (string) $display];
        }
        return $out;
    }

    /**
     * Agents in separate files, for a target whose runtime reads node tables (MAF, NOOA): [workflow.py,
     * common.py, agents/ files]. common.py is the runtime with empty tables plus the run server's shared pieces;
     * agents/<name>.py holds one node's entries ($tables: VAR => [TABLE, literals by id]), after its $preludes
     * source when it has one (NOOA's Agent class); workflow.py fills the tables from them, then the $assembly.
     */
    public static function tablePackage(array $analyzed, array $common, array $assembly, array $tables, array $preludes,
        string $title, string $nodeRole, string $runtimeRole): array
    {
        $layout = self::moduleLayout($analyzed);
        $wfName = json_encode((string) $analyzed['workflow']['name'], JSON_UNESCAPED_UNICODE);
        $q = '"""';
        $files = [['path' => 'agents/__init__.py', 'code' => "{$q}The workflow's nodes, one module each (imported by workflow.py).{$q}\n"]];
        $imports = [];
        $fills = [];
        foreach ($layout as $nid => $m) {
            $body = isset($preludes[$nid]) ? [$preludes[$nid]] : [];
            foreach ($tables as $var => [$table, $literals]) {
                if (isset($literals[$nid])) {
                    $body[] = "{$var} = " . $literals[$nid] . "   # {$table}[\"{$nid}\"]";
                    $fills[$table][] = '    ' . PythonEmitHelpers::pyStr((string) $nid) . ": _node_{$nid}.{$var},";
                }
            }
            if ($body === []) {
                continue;
            }
            $display = str_replace([$q, "\n"], ["'''", ' '], $m['display']);
            $files[] = ['path' => $m['file'], 'code' => "{$q}Node {$nid} ({$display}) of the workflow {$wfName}: {$nodeRole}.\n\n"
                . "Imported by workflow.py. To change the node, edit the workflow in the editor and re-generate.{$q}\n"
                . "from common import *  # noqa: F401,F403 -- the runtime\n\n\n"
                . implode("\n\n\n", $body) . "\n"];
            // Under a private alias: a node named like a module (time, json, re...) must not shadow it here.
            $imports[] = "from agents import {$m['name']} as _node_{$nid}  # {$display}";
        }
        $fill = '';
        foreach ($fills as $table => $lines) {
            $fill .= "{$table}.update({\n" . implode("\n", $lines) . "\n})\n";
        }
        $workflow = "{$q}Workflow {$wfName} -- {$title}, agents in separate files.\n\n"
            . "common.py holds the runtime ({$runtimeRole}), agents/ one module per node; this file fills the node\n"
            . "tables, then builds and runs the workflow: run_workflow(), the Start's listener and the CLI.\n{$q}\n"
            . "from common import *  # noqa: F401,F403 -- the runtime\n"
            . implode("\n", $imports) . "\n\n"
            . $fill . "\n\n"
            . implode("\n\n", $assembly) . "\n";
        return [$workflow, self::packageCommonWithRuntime($common), $files];
    }

    /**
     * The package's common.py when the target's runtime lives there too (agents in separate files): the
     * runtime's first part (its docstring and imports) first, then the run server's shared pieces
     * (packageCommonBlock), then the rest of the runtime, then __all__ so `from common import *` brings every
     * name, the _-prefixed ones included.
     */
    public static function packageCommonWithRuntime(array $runtimeParts): string
    {
        $head = array_shift($runtimeParts);
        $server = preg_replace('/\\A"""[^\\n]*"""\\n/', '', self::packageCommonBlock());   // its docstring: the runtime's comes first
        return $head . "\n" . $server . "\n" . implode("\n", $runtimeParts) . "\n\n"
            . "__all__ = [n for n in dir() if not n.startswith(\"__\")]   # agents/ and workflow.py import it all (_ names too)\n";
    }

    /** The package's common.py: the run server's event sink, and the run records, live feed and console view (LangGraph's, copied). */
    public static function packageCommonBlock(): string
    {
        return "\"\"\"Shared by workflow.py and api.py: the event sink, run records (runs/), the live feed (GET /live), the console view.\"\"\"\n"
            . "import json, os, re, threading, time, uuid\n"
            . "from datetime import datetime\n"
            . "from typing import Callable\n\n"
            . PythonEmitHelpers::eventSinkBlock() . "\n\n"
            . LangGraphRuntime::runRecordBlock() . "\n\n"
            . LangGraphRuntime::liveFeedBlock() . "\n\n"
            . LangGraphRuntime::consoleBlock() . "\n";
    }

    /** @param array<string, array<string,string>> $urlName url => [slug => name]; returns url => slug */
    public static function serverSlugs(array $urlName): array
    {
        $out = [];
        $owner = [];
        foreach ($urlName as $url => $names) {
            $names = array_filter($names, fn($n, $s) => $s !== '', ARRAY_FILTER_USE_BOTH);
            if ($names === []) {
                continue;
            }
            if (count($names) > 1) {
                $n = array_values($names);
                throw new RuntimeException('MCP servers "' . $n[0] . '" and "' . $n[1] . '" share the URL ' . $url
                    . '; a compiled script supports one connection per MCP URL. For a second mailbox (or account), run a second'
                    . ' server instance on its own URL and register that.');
            }
            $slug = (string) array_key_first($names);
            if (isset($owner[$slug]) && $owner[$slug] !== $url) {
                throw new RuntimeException('Two MCP servers both map to MCP_HEADERS_' . strtoupper($slug)
                    . '; rename one so each server has its own header variable.');
            }
            $owner[$slug] = (string) $url;
            $out[(string) $url] = $slug;
        }
        return $out;
    }

    /** Display name of a node: a code node's, an agent's, a playbook's, else its canvas name, else its id. */
    public static function displayName(array $analyzed, string $id): string
    {
        $cfg = (array) ($analyzed['byId'][$id]['config'] ?? []);
        $own = trim((string) ($cfg['name'] ?? $cfg['agent_name'] ?? ''));
        return (string) ($analyzed['code'][$id]['display'] ?? $analyzed['agents'][$id]['name']
            ?? $analyzed['playbooks'][$id]['display'] ?? ($own !== '' ? $own : $id));
    }

    /** A dispatcher menu child this target nests under the dispatcher: an agent or a code node. */
    public static function menuNestable(array $analyzed, string $cid): bool
    {
        return isset($analyzed['agents'][$cid]) || isset($analyzed['code'][$cid]);
    }

    /** CODE_NODES = {id: {display, exits, mcp_servers, timeout_s, exit_targets, args, source | source_file}}. */
    /** Each code node's CODE_NODES entry as a Python dict literal, by node id (agents in separate files). */
    public static function codeNodeLiterals(array $analyzed): array
    {
        $out = [];
        foreach ((array) ($analyzed['code'] ?? []) as $id => $cd) {
            $out[(string) $id] = PythonEmitHelpers::jsonToPython(self::codeNodeEntry($analyzed, (string) $id, $cd));
        }
        return $out;
    }

    /** One CODE_NODES entry: display, exits, MCP servers, timeout, exit targets, arguments, the code or its file. */
    private static function codeNodeEntry(array $analyzed, string $id, array $cd): array
    {
        $entry = ['display' => $cd['display'], 'exits' => $cd['exits'], 'mcp_servers' => $cd['mcp_servers'],
            'timeout_s' => $cd['timeout_s'],
            'exit_targets' => (object) array_map(fn($ids) => array_map('strval', $ids), $cd['exit_targets']),
            'args' => (object) ($cd['args'] ?? [])];
        if (!empty($analyzed['package'])) {
            $entry['source_file'] = CompiledPackage::codePath($analyzed, $id);   // code/<file>, read at each run
        } else {
            $entry['source'] = $cd['source'];
        }
        return $entry;
    }

    public static function codeNodesLiteral(array $analyzed): string
    {
        $out = [];
        foreach ((array) $analyzed['code'] as $id => $cd) {
            $out[(string) $id] = self::codeNodeEntry($analyzed, (string) $id, $cd);
        }
        if (!empty($analyzed['split'])) {
            return "CODE_NODES = {}   # node id -> settings and code, filled by workflow.py from agents/";
        }
        return 'CODE_NODES = ' . PythonEmitHelpers::jsonToPython($out);
    }

    /** DecisionResult, the decision adapters (copied), DECISIONS and the routing-mode rule. */
    public static function decisionBlock(array $analyzed): string
    {
        $protocols = [];
        $decisions = [];
        foreach ((array) ($analyzed['decisions'] ?? []) as $did => $d) {
            foreach ($d['decision'] as $c) {
                $protocols[$c['protocol']] = true;
            }
            $decisions[(string) $did] = $d;
        }
        $known = array_values(array_intersect(array_keys($protocols), array_keys(LangGraphRuntime::ADAPTER_CLASSES)));
        return "from dataclasses import dataclass, field\nfrom functools import cached_property\n\n"
            . LangGraphRuntime::decisionAdaptersBlock($known) . "\n\n"
            . 'DECISIONS = ' . (!empty($analyzed['split']) ? '{}   # dispatcher id -> decision routing, filled by workflow.py from agents/'
                : ($decisions === [] ? '{}' : PythonEmitHelpers::jsonToPython($decisions))) . "\n\n\n"
            . <<<'PY'
def _decision_router(dec: dict, provider: str):
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
    return "llm"
PY;
    }

    /** _rec_start / _rec_done: run events by node id, for a target whose own runtime records its nodes (MAF, NOOA). */
    public static function idRecordingHelpers(): string
    {
        return <<<'PY'
def _rec_start(nid: str) -> None:
    """node_start for a node NODE_META knows (an agent, code, playbook or output node)."""
    meta = NODE_META.get("node_" + str(nid))
    if meta:
        _rec_node_start(meta[0], meta[2], meta[1])


def _rec_done(nid: str, output: str, **extra) -> None:
    """node_complete for a node NODE_META knows."""
    meta = NODE_META.get("node_" + str(nid))
    if meta:
        _rec_node_complete(meta[0], meta[2], meta[1], output=output, **extra)
PY;
    }
}
