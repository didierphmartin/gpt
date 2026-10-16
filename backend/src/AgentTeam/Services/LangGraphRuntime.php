<?php

declare(strict_types=1);

namespace AgentTeam\Services;

/**
 * The Python runtime blocks the LangGraph compiler owns.
 *
 * Every mode LangGraph emits -- the single file, the modular package's common.py and
 * each self-contained A2A agent server -- concatenates these same blocks, so a class
 * is written once here and runs identically everywhere. The blocks are LangGraph's
 * alone: ADK, MAF and NOOA never call this class (the compile targets are independent
 * harnesses), so a change here cannot reach their output.
 *
 * Each method returns one family of emitted Python classes as a string.
 */
final class LangGraphRuntime
{
    /**
     * Node, its three subclasses, NodeKind and make_node(): one class per node kind,
     * run from the node's frozen editor settings (a NODE, AGENTS or PLAYBOOKS entry).
     *
     * PlaybookNode and make_node()'s playbook arm are emitted only when $withPlaybook,
     * because only then does the file carry the playbook runtime they call. The single
     * file and common.py pass `playbookData !== []`; an A2A agent file passes
     * `kind === 'playbook'`.
     *
     * The classes look their collaborators up as module globals at call time
     * (_make_llm, TOOLS, SKILLS, Dispatcher, the playbook runtime, ...),
     * which is why a test that patches common._make_llm after import still reaches them.
     */
    public static function nodeClassesBlock(bool $withPlaybook, bool $withCode = false): string
    {
        $base = <<<'PY'
# ==============================================================
# NODE LOGIC
# Node.run() executes a node once for one request text and returns
# {"text", "route", "notes", "status"}. It is the single-file script's
# node function with the LangGraph state replaced by plain arguments.
# ==============================================================


class Node(ABC):
    """One workflow node, run from its frozen editor settings (a NODE, AGENTS or PLAYBOOKS entry).

    Holds what every kind of node needs once per process: its chat model and its catalog
    tools, both built on first use (a missing provider package fails only this node).
    """

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.display = cfg["display"]

    @cached_property
    def llm(self):
        """The chat model for this node, built from its settings (provider/model/sampling/thinking).

        Built on first use, so a missing provider package or key fails this node when it
        runs, not the whole file at start; the error names the node and its provider.
        """
        c = self.cfg
        where = f"node {c['id']} {self.display!r} cannot build its {c['provider']!r} model"
        try:
            return _make_llm(c["provider"], c["model"], float(c["temperature"]), int(c["max_tokens"]), thinking=c.get("thinking"))
        except ImportError as e:   # the provider's package is not installed
            raise ImportError(f"{where}: {e}") from e
        except Exception as e:     # no model name, an unknown provider, an SDK refusing a missing key
            raise RuntimeError(f"{where}: {e}") from e

    @cached_property
    def tools(self) -> list:
        """The catalog tools this node names, looked up once (run_skill_script is a local, non-MCP tool)."""
        return TOOLS.tools_for(self.cfg.get("tool_names", []))

    @staticmethod
    def _messages(system: str | None, human: str) -> list:
        """The turn a node sends: its dated system prompt (when it has one) and the request."""
        msgs = [SystemMessage(content=inject_datetime(system))] if system else []
        return msgs + [HumanMessage(content=human)]

    @staticmethod
    def _final_text(result: dict) -> str:
        """The agent's last message as plain text; content blocks are joined."""
        final = result["messages"][-1]
        text = final.content if isinstance(final, AIMessage) else str(final)
        if isinstance(text, list):
            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
        return text

    @abstractmethod
    async def run(self, request: str, trace) -> dict:
        """Run the node once on `request` (the graph's framed input for it).

        trace(line) is an async callback that reports progress: a print in a package, a task status update in an A2A agent server.
        Returns {"text": str, "route": str ("" when none), "notes": str, "status": str}.
        Exceptions propagate to the caller (workflow.py's node runner, or the A2A executor, which fails the task).
        """


class AgentNode(Node):
    """An agent node: a ReAct loop over its tools, then its mandatory skill steps in order."""

    async def run(self, request: str, trace) -> dict:
        """Run the agent's ReAct loop on `request`, then each attached skill on its answer."""
        c = self.cfg
        await trace(f"{self.display!r} -- {len(self.tools)} tools (provider={c.get('provider', '?')}, model={c.get('model', '?')})")
        await trace(f"inputs: system={len(c.get('system_prompt') or '')} chars, context={len(request)} chars")
        # Per-agent LLM. Each agent uses the provider/model
        # it was configured with in the workflow editor.
        agent = create_react_agent(self.llm, self.tools)
        t0 = time.monotonic()
        result = await agent.ainvoke({"messages": self._messages(c.get("system_prompt"), request)})
        dt = time.monotonic() - t0
        text = self._final_text(result)

        msgs_out = result.get("messages", [])
        llm_rounds = sum(1 for m in msgs_out if isinstance(m, AIMessage))
        tool_results = sum(
            1 for m in msgs_out
            if getattr(m, "type", None) == "tool"
            or m.__class__.__name__ == "ToolMessage"
        )
        await trace(f"done -- {len(text)} chars ({llm_rounds} LLM rounds, {tool_results} tool results, {dt:.1f}s)")
        # Preview of what the agent produced, so the log shows the
        # actual answer without opening the _debug dump.
        await trace(f"output head: {text[:240]!r}")
        # High-signal red flag: a tool-bound agent that ran ZERO
        # tools almost certainly fabricated its answer (the exact
        # failure that produced "Missing /llms.txt"). Surface it.
        if self.tools and tool_results == 0:
            await trace(f"⚠ answered with 0 tool calls despite {len(self.tools)} tool(s) available — likely fabricated; "
                        f"check the skill ran")
        self._dump_history(msgs_out)

        # Mandatory skill pipeline: each attached skill runs on the agent's
        # result in order; the last skill's produced deliverable (e.g. the html
        # skill's rendered HTML file) becomes this node's output.
        for skill in c.get("skills", []):
            text = await SKILLS.run_step(skill, text, self.llm)
            await trace(f"after skill {skill.get('dir') or 'inline'!r}: {len(text)} chars")
        return {"text": text, "route": "", "notes": "", "status": "ok"}

    def _dump_history(self, messages: list) -> None:
        """Write the agent's message history to <runner>/outputs/_debug/ so an answer can be traced to its turns."""
        from datetime import datetime as _dt
        nid = self.cfg["id"]
        try:
            debug_dir = Path(RUNNER_DIR) / "outputs" / "_debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            ts = _dt.now().strftime("%Y%m%d-%H%M%S")
            dump_path = debug_dir / f"{DEBUG_STEM}_{nid}_{ts}.json"
            entries = []
            for m in messages:
                content = m.content
                if isinstance(content, list):
                    content = [
                        (b if isinstance(b, dict) else {"type": "text", "text": str(b)})
                        for b in content
                    ]
                entries.append({
                    "role": m.__class__.__name__,
                    "content": content,
                    "tool_calls": getattr(m, "tool_calls", None),
                    "tool_call_id": getattr(m, "tool_call_id", None),
                    "name": getattr(m, "name", None),
                })
            dump_path.write_text(
                json.dumps(entries, default=str, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            print(f"[debug] [{nid}] message history → outputs/_debug/{dump_path.name}")
        except Exception as e:
            print(f"[debug] [{nid}] failed to dump message history: {e}")


class DispatcherNode(Node):
    """A dispatcher node: routes the request to exactly one child of its menu (a decision model or one forced route_to call)."""

    @cached_property
    def dispatcher(self) -> Dispatcher:
        """This node's Dispatcher, built once per process so its decision adapters -- and their
        cached SSL contexts -- are reused by every run of the node instead of rebuilt per request."""
        return Dispatcher(self.cfg)

    async def run(self, request: str, trace) -> dict:
        """Dispatcher: a decision model or one forced route_to call (Dispatcher); the chosen child id travels back as "route"."""
        c = self.cfg
        await trace(f"{self.display!r} -- {len(self.tools)} tools (provider={c.get('provider', '?')}, model={c.get('model', '?')})")
        await trace(f"inputs: system={len(c.get('system_prompt') or '')} chars, context={len(request)} chars")
        decision = await self.dispatcher.route(request, self._messages(c.get("system_prompt"), request), lambda: self.llm)
        return asdict(decision)



PY;
        $playbook = <<<'PY'
class PlaybookNode(Node):
    """A playbook node: the playbook interpreter over native verbs, human gates and bound #Actions.

    Its output is the Markdown transcript of what the playbook did.
    """

    async def run(self, request: str, trace) -> dict:
        """Playbook: the playbook runtime; gates are answered by PlaybookRun.gate(), or
        by the GATE_BRIDGE the surrounding file installed (an input-required task
        update in an A2A agent server)."""
        pb = self.cfg
        run = PlaybookRun(bool(pb.get("writes_enabled")), pb.get("policy") or {}, gate_bridge=GATE_BRIDGE)
        tools = PlaybookToolset(pb, run).build()
        await trace(f"{self.display!r} playbook -- {len(tools)} tools (provider={pb.get('provider', '?')}, "
                    f"model={pb.get('model', '?')}, writes={'on' if run.writes_enabled else 'off'})")
        system = PLAYBOOK_SYSTEM_PROMPT.format(
            domain=pb.get("domain") or "this organization",
            instructions=pb["instructions"],
            policy_json=json.dumps(run.policy, ensure_ascii=False),
            requester_json=json.dumps(pb.get("requester") or {}, ensure_ascii=False),
            approvers_json=json.dumps(pb["approvers"], ensure_ascii=False) if pb.get("approvers") else "{}",
        )
        agent = create_react_agent(self.llm, tools)
        t0 = time.monotonic()
        text = ""
        try:
            result = await agent.ainvoke({"messages": self._messages(system, "REQUEST:\n" + request)},
                                         config={"recursion_limit": 2 * PLAYBOOK_MAX_ROUNDS + 1})
            text = self._final_text(result)
        except Exception as e:
            run.status = "failed"
            run.emit(type="note", text=f"Round budget of {PLAYBOOK_MAX_ROUNDS} exhausted or run failed: {e}")
            await trace(f"⚠ playbook failed: {e}")
        await trace(f"done -- status={run.status} ({len(run.events)} events, {time.monotonic() - t0:.1f}s)")
        return {"text": run.transcript(pb["title"], run.summary or text), "route": "", "notes": "", "status": run.status}



PY;
        $code = <<<'PY'
class CodeNode(Node):
    """A code node: the node's own Python run(input, call_tool) -- deterministic, no model.

    The contract (input, exits, declared tools, error exit, timeout) is CODE_HARNESS's, the
    same file the workflow editor runs, so the compiled node behaves like the debugged one.
    """

    def __init__(self, cfg: dict):
        super().__init__(cfg)
        # Fail fast (spec §5.2): the Node is built when the script starts, so a bad import or a
        # missing run() stops the script here, before any node of the workflow has run.
        try:
            CODE_HARNESS.check_code(self.source())
        except (CODE_HARNESS.CodeNodeError, OSError) as e:
            raise RuntimeError(f"code node {self.display!r}: {e}") from None

    def source(self) -> str:
        """The node's code: its file in the package (cfg "source_file", relative to PACKAGE_DIR), read
        at each run so an edit takes effect on the next run; else the code embedded in cfg "source"."""
        if self.cfg.get("source_file"):
            with open(os.path.join(PACKAGE_DIR, self.cfg["source_file"]), encoding="utf-8") as fh:
                return fh.read()
        return self.cfg["source"]

    async def run(self, request: str, trace) -> dict:
        """request is JSON {"user_prompt", "parents"}; the chosen exit travels back as "route"."""
        c = self.cfg
        req = json.loads(request)
        await trace(f"{self.display!r} code -- exits={c['exits']}, mcp_servers={c['mcp_servers']}")
        value = CODE_HARNESS.decode_input(req["parents"], req["user_prompt"])
        res = await asyncio.to_thread(CODE_HARNESS.execute, self.source(), value, c["exits"], c["mcp_servers"],
                                      _code_transport, c["timeout_s"])
        for call in res["tool_calls"]:
            await trace(f"tool {call['server']}.{call['tool']} ok={call['ok']} ({call['ms']} ms)")
        if res["stdout"]:
            await trace("stdout: " + res["stdout"][:2000])
        if not res["ok"]:
            raise RuntimeError(f"code node {self.display!r} failed: {res['error']}")
        await trace(f"exit {res['route']!r}")
        return {"text": res["output_text"], "route": res["route"], "notes": "", "status": "ok"}



PY;
        $kindHead = <<<'PY'
class NodeKind(str, Enum):
    """The kinds of node make_node() builds; a node entry's "kind" holds one of these values.

    A str mixin, not enum.StrEnum (Python 3.11+; the floor is 3.10). Members compare equal
    to their plain strings, so the node entries stay plain editor data.
    """
    AGENT = "agent"
    DISPATCHER = "dispatcher"
    PLAYBOOK = "playbook"
PY;
        $makeHead = <<<'PY'


def make_node(cfg: dict) -> Node:
    """The Node for one frozen node entry, chosen by its kind (agent, dispatcher, playbook)."""
    match cfg["kind"]:
        case NodeKind.AGENT:
            return AgentNode(cfg)
        case NodeKind.DISPATCHER:
            # Dispatcher: a decision model or one forced route_to call picks the child; no ReAct loop.
            return DispatcherNode(cfg)

PY;
        $playbookArm = <<<'PY'
        case NodeKind.PLAYBOOK:
            return PlaybookNode(cfg)

PY;
        $codeArm = <<<'PY'
        case NodeKind.CODE:
            return CodeNode(cfg)

PY;
        $factoryTail = <<<'PY'
        case _:
            raise ValueError(f"unknown node kind: {cfg['kind']!r}")

PY;
        return $base . ($withPlaybook ? $playbook : '') . ($withCode ? $code : '')
            . $kindHead . "\n" . ($withCode ? "    CODE = \"code\"\n" : '') . $makeHead
            . ($withPlaybook ? $playbookArm : '') . ($withCode ? $codeArm : '') . $factoryTail;
    }

    /**
     * Dispatcher node runtime: DecisionResult, one adapter class per decision protocol the
     * workflow's dispatchers use (JevRouter for "typesafe"), DECISION_ADAPTERS, RouteDecision
     * and Dispatcher. A dispatcher routes with a decision model (a provider key, or unset
     * with a candidate whose key is set) or with one forced route_to call over the menu
     * (the model), never both. JevRouter.route() is the standard-library twin of
     * JevRouter::route() (same body, same 'unclear' option, same floor, same outcomes);
     * Dispatcher.mode() mirrors GraphWorkflowRunner's mode choice. DispatcherNode.run() is
     * its one caller.
     *
     * @param list<string> $protocols decision protocols any dispatcher may use (one adapter each)
     */
    public static function dispatcherBlock(array $protocols): string
    {
        return self::decisionHead()
            . implode('', array_map(fn(string $p) => self::adapterBlock($p), $protocols))
            . self::adaptersTable($protocols)
            . self::dispatcherClasses();
    }

    /** Python adapter class per decision protocol: the runtime twin of DecisionProtocols' 'adapter'. */
    public const ADAPTER_CLASSES = ['typesafe' => 'JevRouter'];

    /** The routing banner and DecisionResult, the record every adapter returns. */
    private static function decisionHead(): string
    {
        return "# Decision-model routing (twin of DecisionProtocols.php / DecisionRouters.php).\n\n\n"
            . <<<'PY'
@dataclass(frozen=True)
class DecisionResult:
    """What a decision adapter's route() found for one request: an outcome and the evidence behind it.

    outcome is 'routed'|'unclear'|'low_confidence'|'unavailable'|'error'; only 'routed'
    decides, and then target is the chosen menu entry. A record rather than a dict, so a
    misspelt field fails at once instead of reading as missing.
    """
    outcome: str
    target: dict | None = None
    confidence: float | None = None
    ms: int | None = None
    reason: str | None = None
    probabilities: dict | list = field(default_factory=dict)
    usage: dict = field(default_factory=dict)



PY;
    }

    /**
     * One decision protocol's Python adapter. The registry and the runtime grow together:
     * a protocol with no adapter here fails at compile time, not mid-run.
     */
    private static function adapterBlock(string $protocol): string
    {
        return match ($protocol) {
            'typesafe' => <<<'PY'
# TypeSafe Jev (twin of JevRouter.php). A System One model: it answers a closed
# question with one of the options supplied -- never a value outside them.


class JevRouter:
    """Asks TypeSafe Jev (the "typesafe" decision protocol) a closed routing question:
    the Python twin of JevRouter.php, one instance per provider row compiled in.

    Same request body, same 'unclear' option, same floor and outcomes. route() never raises.
    """
    URL = "https://api.typesafe.ai/v1/systemone"   # protocol default; the row's URL, then its <NAME>_BASE_URL, override it
    MODEL = "jev-latest"
    UNCLEAR = "unclear"   # synthetic option that makes "I cannot tell" sayable; never a real branch
    UNCLEAR_DESC = ("The request does not say enough to choose, or it genuinely spans "
                    "several of the options. Pick this rather than guessing.")
    CONFIDENCE_FLOOR = 0.6   # default minimum confidence (a dispatcher's min_confidence overrides it)
    TIMEOUT_S = 10
    LEGACY_KEY_ENV = "TYPESAFE_API_KEY"   # .env files written before per-row names
    LEGACY_URL_ENV = "TYPESAFE_BASE_URL"

    def __init__(self, key_env: str = "JEV_API_KEY", url_env: str = "JEV_BASE_URL", url: str = URL, model: str = MODEL):
        """key_env/url_env are this provider row's variables (compiled in); url/model its defaults."""
        self.key_env, self.url_env, self.url, self.model = key_env, url_env, url or self.URL, model or self.MODEL

    def _creds(self) -> tuple[str, str]:
        """(key, url): the row's own variables, else the legacy TYPESAFE_* pair; url defaults to the compiled one."""
        key = os.environ.get(self.key_env) or ""
        if key:
            return key, os.environ.get(self.url_env) or self.url
        return os.environ.get(self.LEGACY_KEY_ENV) or "", os.environ.get(self.LEGACY_URL_ENV) or self.url

    def available(self) -> bool:
        """Configured = a key is present (the row's own variable or the legacy one)."""
        return bool(self._creds()[0])

    @cached_property
    def ssl_context(self):
        """The system trust store PLUS certifi's bundle when present (httpx, which
        this script already needs, depends on it). The union matters both ways: a
        python.org macOS build has no system CA store until "Install Certificates"
        is run, and an enterprise TLS-inspecting proxy's root CA lives ONLY in the
        system store -- replacing it with certifi would break every call there."""
        import ssl
        ctx = ssl.create_default_context()   # system store, SSL_CERT_FILE, OS trust (e.g. a proxy's root CA)
        try:
            import certifi
            ctx.load_verify_locations(certifi.where())   # ADDED to, never replacing, the system store
        except Exception:
            pass
        return ctx

    def route(self, request: str, targets: list[dict], question: str, floor: float = CONFIDENCE_FLOOR) -> DecisionResult:
        """Choose one target for `request`, or say why not. Returns a DecisionResult with
        outcome ('routed'|'unclear'|'low_confidence'|'unavailable'|'error'), target,
        confidence, probabilities, ms, usage, reason. Only 'routed' decides; every
        other outcome means the dispatcher does not route (no model fallback).
        `floor` is the dispatcher's minimum
        confidence (settings.min_confidence). Never raises."""
        try:
            return self._route(request, targets, question, floor)
        except Exception as e:   # anything at all -> an 'error' outcome, never a raise
            return DecisionResult("error", reason=f"{type(e).__name__}: {e}")

    def _route(self, request, targets, question, floor) -> DecisionResult:
        """route() without its safety net: check the menu, ask Jev, read its answer."""
        import urllib.request
        key, url = self._creds()
        if not key:
            return DecisionResult("unavailable", reason=f"no {self.key_env}")
        named = {}
        for t in targets:
            name = str(t.get("name") or "").strip()
            if name == "" or name.lower() == self.UNCLEAR:
                # A branch literally named "unclear" would collide with the escape hatch.
                return DecisionResult("error", reason=f"unusable target name: '{name}'")
            named[name] = t
        if len(named) < 2:
            return DecisionResult("error", reason="a menu needs at least two targets")
        criteria = {}
        for name, t in named.items():
            desc = str(t.get("description") or "").strip()
            criteria[name] = desc[:400] if desc else name
        criteria[self.UNCLEAR] = self.UNCLEAR_DESC
        body = {
            "state": {"request": request},
            "model": self.model,
            "questions": {"route": {"type": "choice", "instructions": question, "criteria": criteria}},
        }
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"Authorization": "Bearer " + key, "Accept": "application/json",
                     "Content-Type": "application/json"})
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.TIMEOUT_S, context=self.ssl_context) as resp:   # HTTP 4xx/5xx raise here
                raw = resp.read()
        except Exception as e:
            return DecisionResult("error", reason=str(e))
        ms = int(round((time.monotonic() - t0) * 1000))
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except ValueError:
            decoded = None
        answers = decoded.get("answers") if isinstance(decoded, dict) else None
        answer = answers.get("route") if isinstance(answers, dict) else None
        if not isinstance(answer, dict) or answer.get("choice") is None:
            return DecisionResult("error", ms=ms, reason="no choice in the response")
        choice = str(answer["choice"])
        conf = float(answer["confidence"]) if answer.get("confidence") is not None else None
        probs = answer.get("probabilities") if isinstance(answer.get("probabilities"), (dict, list)) else {}
        usage = decoded.get("usage") if isinstance(decoded.get("usage"), dict) else {}
        common = {"confidence": conf, "probabilities": probs, "ms": ms, "usage": usage}
        if choice == self.UNCLEAR:
            return DecisionResult("unclear", reason="the request names no branch", **common)
        if choice not in named:
            # Unreachable by contract; treated as an error rather than trusted.
            return DecisionResult("error", reason=f"answer '{choice}' is not on the menu", **common)
        if conf is not None and conf < floor:
            return DecisionResult("low_confidence", target=named[choice],
                                  reason=f"confidence {conf:.2f} below floor {floor:.2f}", **common)
        return DecisionResult("routed", target=named[choice], **common)



PY,
            default => throw new \InvalidArgumentException("no LangGraph adapter for decision protocol '{$protocol}'"),
        };
    }

    /** DECISION_ADAPTERS: protocol -> adapter class, for the protocols compiled in. */
    private static function adaptersTable(array $protocols): string
    {
        $entries = array_map(fn(string $p) => '"' . $p . '": ' . self::ADAPTER_CLASSES[$p], $protocols);
        return "# Decision protocol -> adapter class (only the protocols this workflow's dispatchers use).\n"
            . 'DECISION_ADAPTERS = {' . implode(', ', $entries) . "}\n\n\n";
    }

    /** RouteDecision and Dispatcher: the mode choice and both routing paths. */
    private static function dispatcherClasses(): string
    {
        return <<<'PY'
@dataclass(frozen=True)
class RouteDecision:
    """A dispatcher's answer: the text its child receives, the chosen child's id and the notes.

    route is "" and status "unrouted" when no child was chosen; text then says why.
    DispatcherNode.run() hands it on as Node.run()'s {"text", "route", "notes", "status"}.
    """
    text: str
    route: str
    notes: str
    status: str


class Dispatcher:
    """Picks exactly one child for a dispatcher node: through a decision model or through one forced route_to call, never both.

    Dispatcher agent (twin of DispatchRouting in the PHP runner): the model
    MUST call route_to with one of the menu names; that child alone runs. The
    child receives the dispatcher's original input plus the notes.
    With no choice the run stops at the dispatcher. It holds the menu, the
    confidence floor and the compiled decision candidates -- nothing of the graph.
    """

    def __init__(self, cfg: dict, router=None):
        """cfg is the dispatcher's node entry (id, display, dispatch, decision_question, routing_mode,
        min_confidence, decision); router replaces every candidate's adapter (tests only)."""
        self.cfg = cfg
        self.display = cfg["display"]
        self.targets = cfg["dispatch"]
        self.names = [t["name"] for t in self.targets]
        self.candidates = cfg.get("decision", [])
        self._router = router
        self._adapters = {}   # provider -> adapter, built once so its cached SSL context is reused
        floor = cfg.get("min_confidence")
        # 0.6 = JevRouter::DEFAULT_CONFIDENCE_FLOOR, the interpreter's default.
        self.floor = 0.6 if floor is None else floor

    def router_for(self, provider: str):
        """The adapter for one candidate, None when the provider was not compiled in or its protocol has no adapter."""
        c = next((c for c in self.candidates if c["provider"] == provider), None)
        if c is None:
            return None
        if self._router is not None:
            return self._router
        if provider not in self._adapters:
            cls = DECISION_ADAPTERS.get(c["protocol"])
            self._adapters[provider] = (cls(key_env=c["key_env"], url_env=c["url_env"], url=c["url"], model=c["model"])
                                        if cls else None)
        return self._adapters[provider]

    def mode(self) -> str:
        """"llm", or the decision provider this run routes with (twin of GraphWorkflowRunner):
          "llm" -> the model only.
          a key -> that decision model only; any outcome but 'routed' (unclear,
                   low_confidence, no key, error, timeout) stops the run here.
          ""    -> unset: the first compiled candidate whose key is set (the editor's runner
                   sync writes only keys the plan allows), else "llm".
        """
        match self.cfg.get("routing_mode", ""):
            case "llm":
                return "llm"
            case "":
                for c in self.candidates:
                    r = self.router_for(c["provider"])
                    if r is not None and r.available():
                        return c["provider"]
                return "llm"
            case key:
                return key

    async def route(self, task: str, msgs: list, make_llm) -> RouteDecision:
        """Route `task` (the dispatcher's input) to one child of the menu (see mode()).

        msgs is the dispatcher's model turn; make_llm() returns its chat model and is
        read only on the LLM path, so a decision-model dispatcher needs no model key or package.
        route is "" and status "unrouted" when no child is chosen.
        """
        match self.mode():
            case "llm":
                return await self._via_llm(task, msgs, make_llm)
            case key:
                return await self._via_decision(key, task)

    async def _via_decision(self, key: str, task: str) -> RouteDecision:
        """Decision model `key` only: 'routed' decides; any other outcome stops the run here (no model fallback)."""
        nid = self.cfg["id"]
        router = self.router_for(key)
        if router is None:
            # Not compiled in (no usable row at generation) or no adapter: nothing is called.
            res = DecisionResult("unavailable", reason=f"'{key}' is not an available decision provider")
        else:
            try:
                # urlopen's timeout bounds each socket op, not DNS or the total; this does.
                res = await asyncio.wait_for(
                    asyncio.to_thread(router.route, task, self.targets, self.cfg.get("decision_question", ""), self.floor),
                    router.TIMEOUT_S + 1)
            except Exception as e:   # asyncio.TimeoutError included -> an 'error' outcome (did not route)
                res = DecisionResult("error", reason=f"{type(e).__name__}: no answer within {router.TIMEOUT_S + 1}s"
                                     if isinstance(e, asyncio.TimeoutError) else str(e))
        conf = f"{res.confidence:.2f}" if res.confidence is not None else "?"
        if res.outcome == "routed":
            chosen = res.target
            # Same shape the model path returns, minus notes: a decision model writes no prose.
            node_print(f"[node] [{nid}] {self.display!r} {key} routed to {chosen['name']!r} "
                       f"(confidence {conf}, {res.ms}ms, no LLM turn)")
            return RouteDecision(text=task, route=chosen["id"], notes="", status="ok")
        not_classified = res.outcome in ("unclear", "low_confidence")
        # Not classified goes to the branch the form names for it (by name), while it is on the menu.
        unclear = self.cfg.get("unclear_branch", "")
        chosen = next((t for t in self.targets if t["name"] == unclear), None) if not_classified and unclear else None
        if chosen is not None:
            node_print(f"[node] [{nid}] {self.display!r} {key} did not classify ({res.outcome}: {res.reason}, "
                       f"confidence {conf}) -- sent to the unclear branch {chosen['name']!r}")
            return RouteDecision(text=task, route=chosen["id"], notes="", status="ok")
        # Decision model only: no model fallback, so the run stops here and says why
        # (the reason names a missing key, too). Same message as the interpreter.
        # A request no branch fits is a normal ending ("Not classified"), anything else an error.
        msg = (f'{"Not classified" if not_classified else "Error"}: dispatcher "{self.display}" did not route the request '
               f'({key}: {res.outcome}: {res.reason}).')
        node_print(f"[node] [{nid}] ⚠ {self.display!r} {key} did not route ({res.outcome}: {res.reason}, "
                   f"confidence {conf}) — decision-model dispatcher, no model fallback")
        return RouteDecision(text=msg, route="", notes="", status="unrouted")

    def _route_tool(self) -> StructuredTool:
        """The route_to tool over this menu's names: the model MUST pick exactly one."""
        route_args = create_model(
            "RouteToArgs",
            target=(Literal[tuple(self.names)], Field(..., description="Name of the agent to route to. MUST be one of the listed values.")),
            notes=(str, Field("", description="Optional short note for the target agent (what you understood, what to focus on).")),
        )
        return StructuredTool.from_function(
            func=lambda target, notes="": "routed",
            name="route_to",
            description=("REQUIRED tool to hand the request to exactly one downstream agent. Pick the agent "
                         "whose role matches the request. Available targets: " + ", ".join(self.names)
                         + ". The chosen agent receives the original request, plus your notes."),
            args_schema=route_args,
        )

    async def _via_llm(self, task: str, msgs: list, make_llm) -> RouteDecision:
        """The model only: one forced route_to call over the menu."""
        nid = self.cfg["id"]
        llm = make_llm().bind_tools([self._route_tool()], tool_choice="any")
        t0 = time.monotonic()
        resp = await llm.ainvoke(msgs)
        dt = time.monotonic() - t0
        chosen, notes = None, ""
        for call in getattr(resp, "tool_calls", None) or []:
            if call.get("name") != "route_to":
                continue
            args = call.get("args") or {}
            want = str(args.get("target", "")).strip().lower()
            for t in self.targets:
                if t["name"].strip().lower() == want:
                    chosen, notes = t, str(args.get("notes", "") or "").strip()
                    break
            if chosen:
                break
        if chosen is None:
            msg = (f"Error: dispatcher {self.display!r} did not route the request. "
                   f"Expected route_to with one of: {', '.join(self.names)}.")
            node_print(f"[node] [{nid}] ⚠ {msg}")
            return RouteDecision(text=msg, route="", notes="", status="unrouted")
        node_print(f"[node] [{nid}] {self.display!r} routed to {chosen['name']!r} ({dt:.1f}s)"
                   + (f" -- notes: {notes[:120]!r}" if notes else ""))
        text = task + (f"\n\n## Dispatcher notes\n{notes}" if notes else "")
        return RouteDecision(text=text, route=chosen["id"], notes=notes, status="ok")


PY;
    }

    /**
     * The code node harness (frontend/assets/py/code_node_harness.py, the file the editor runs)
     * embedded as a module ($fromFile: imported from the package's code_harness.py), plus the
     * transport its call_tool uses: MCP_SLUGS maps a server slug to its URL, McpClient.call_tool_raw
     * makes the call.
     */
    public static function codeHarnessBlock(bool $fromFile = false): string
    {
        if ($fromFile) {
            // The modular package ships the harness as code_harness.py beside this file (LangGraphPackage).
            $load = "import code_harness as CODE_HARNESS   # code_harness.py in the package folder\n\n\n";
        } else {
            $src = file_get_contents(__DIR__ . '/../../../../frontend/assets/py/code_node_harness.py');
            if ($src === false) {
                throw new \RuntimeException('code node harness not found (frontend/assets/py/code_node_harness.py)');
            }
            $load = 'CODE_HARNESS_SOURCE = ' . json_encode($src, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n"
                . "CODE_HARNESS = types.ModuleType(\"code_node_harness\")\n"
                . "exec(CODE_HARNESS_SOURCE, CODE_HARNESS.__dict__)\n\n\n";
        }
        return "# ==============================================================\n"
            . "# CODE NODE HARNESS -- the same file the workflow editor runs\n"
            . "# ==============================================================\n"
            . $load
            . "def _code_transport(server: str, tool: str, args: dict) -> dict:\n"
            . "    \"\"\"call_tool's transport in a compiled script: the raw MCP result of server.tool(args).\"\"\"\n"
            . "    url = MCP_SLUGS.get(server)\n"
            . "    if not url:\n"
            . "        return {\"isError\": True, \"content\": [{\"type\": \"text\", \"text\": f\"MCP server {server!r} is not in this workflow\"}]}\n"
            . "    return MCP.call_tool_raw(url, tool, args)\n";
    }

    /**
     * Run records (spec 2026-10-15 §4): each run's events in the server's run-log format
     * (GraphWorkflowRunner::emitNodeEvent), one JSONL file per run under RUNS_DIR plus a `current`
     * pointer, and the server's quiet rule (CodeNodeStep::summarize). The entry file supplies json,
     * os, time, uuid, datetime and Callable.
     */
    public static function runRecordBlock(): string
    {
        return <<<'PY'
# ==============================================================
# RUN RECORDS
# Every run's events, in the format the SynergyAI server writes
# (workflow_start, node_start, node_complete, node_log, workflow_complete),
# one JSONL file per run under RUNS_DIR, and RUNS_DIR/current naming the
# latest. A quiet run (a poll that found nothing) leaves no file.
# ==============================================================
WORK_TYPES = ("agent", "playbook", "output")
OUTPUT_IN_LOG = 4000   # characters of a node's output kept in its node_complete event


def is_quiet(node_types: dict, routes: dict, agents: dict, ran: list) -> bool:
    """The server's rule (CodeNodeStep::summarize): a code node took an exit other than `error`,
    none took `error`, and no agent, playbook or output node ran."""
    code_exits = [r for nid, r in routes.items() if (agents.get(nid) or {}).get("kind") == "code"]
    if not code_exits or "error" in code_exits:
        return False
    return not any(node_types.get(nid) in WORK_TYPES for nid in ran)


class RunRecorder:
    """One run at a time: its events to a JSONL file (when runs_dir is set) and to each listener."""

    def __init__(self, runs_dir: str | None, workflow_id: int, workflow_name: str,
                 listeners: list[Callable[[dict], None]] | None = None):
        self.runs_dir, self.workflow_id, self.workflow_name = runs_dir, workflow_id, workflow_name
        self.listeners = list(listeners or [])
        self.run_id: str | None = None
        self._path: str | None = None

    def current_path(self) -> str | None:
        """The open run's file, or None (no runs_dir, or the run ended)."""
        return self._path

    def begin(self) -> str:
        """Start a run: a new id, its file, the pointer, and workflow_start."""
        self.run_id = uuid.uuid4().hex
        if self.runs_dir:
            os.makedirs(self.runs_dir, exist_ok=True)
            stem = f"{datetime.now():%Y-%m-%d_%H-%M-%S}_{self.run_id}"
            self._path = os.path.join(self.runs_dir, stem + ".jsonl")
            tmp = os.path.join(self.runs_dir, ".current.tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(stem)
            os.replace(tmp, os.path.join(self.runs_dir, "current"))
        self.emit("workflow_start", run_id=self.run_id, workflow_id=self.workflow_id, workflow_name=self.workflow_name)
        return self.run_id

    def emit(self, type: str, **fields) -> dict:
        """Stamp one event, append it to the run file and hand it to every listener; returns it."""
        ev = {"type": type, **fields, "timestamp": time.time()}
        if "node_id" in ev:
            ev.setdefault("drawflow_id", None)
        if self._path:
            with open(self._path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        for listen in self.listeners:
            try:
                listen(ev)
            except Exception as e:  # noqa: BLE001 -- a broken view must not break the run
                print(f"[warn] run listener failed: {e}", flush=True)
        return ev

    def node_start(self, nid: str, name: str, ntype: str) -> None:
        """A node began."""
        self.emit("node_start", node_id=nid, node_type=ntype, node_name=name)

    def node_complete(self, nid: str, name: str, ntype: str, *, success: bool = True, output: str = "",
                      exit: str | None = None, route: dict | None = None, error: str | None = None) -> None:
        """A node finished: its output (cut to OUTPUT_IN_LOG), a code node's exit, a dispatcher's route, or its error."""
        extra = {k: v for k, v in (("exit", exit), ("route", route), ("error", error)) if v is not None}
        self.emit("node_complete", node_id=nid, node_type=ntype, node_name=name, success=success,
                  output=str(output or "")[:OUTPUT_IN_LOG], **extra)

    def node_log(self, nid: str, message: str) -> None:
        """A progress line of a node (what its trace callback prints)."""
        self.emit("node_log", node_id=nid, message=message)

    def complete(self, *, success: bool, output: str = "", error: str | None = None) -> None:
        """The run is over: workflow_complete with its outcome."""
        self.emit("workflow_complete", success=success, output=str(output or ""),
                  **({"error": error} if error is not None else {}))

    def end(self, *, quiet: bool) -> None:
        """Close the run; a quiet one's file is deleted (the pointer may then name a missing file)."""
        if quiet and self._path:
            try:
                os.remove(self._path)
            except FileNotFoundError:
                pass
        self._path = None


NULL_RECORDER = RunRecorder(None, 0, "")


class RunOutput:
    """Where a run's progress lines go ([info] Running..., [node] ...): `mode` print (as they come, the
    default), hold (kept until the run ends, then printed or dropped by release()) or drop. The
    program sets it per run: a --cron / --watch run holds them (shown only under --verbose, never
    for a quiet run), a --once --quiet run drops them. once() is for startup lines: printed the
    first time only, and only when `chatty`."""

    def __init__(self):
        self.mode = "print"
        self.held: list[str] = []
        self.chatty = True
        self._said: set[str] = set()

    def __call__(self, line: str) -> None:
        if self.mode == "print":
            print(line, flush=True)
        elif self.mode == "hold":
            self.held.append(line)

    def begin(self, mode: str) -> None:
        """A new run: its lines go to `mode` (print | hold | drop)."""
        self.mode, self.held = mode, []

    def release(self, show: bool) -> None:
        """The run is over: print its held lines when `show`, else drop them."""
        lines, self.held = self.held, []
        for line in lines if show else ():
            print(line, flush=True)

    def once(self, line: str, always: bool = False) -> None:
        """A startup line: printed the first time it is said, when `chatty` (or `always`, for warnings)."""
        if line not in self._said and (self.chatty or always):
            self._said.add(line)
            print(line, flush=True)


RUN_OUT = RunOutput()   # the run's progress lines (WorkflowGraph, each node's trace)
NODE_OUT = RUN_OUT      # node_print() (the node runtime's [tool] / [run_skill_script] / route lines) goes here too


PY;
    }

    /**
     * The live feed (plan task 8): LiveFeed::next ported, over the files runRecordBlock() writes --
     * RUNS_DIR/current naming `<stem>_<runId>` and one `<stem>.jsonl` per run. api.py's GET /live
     * streams what live_next() returns. Emitted into the modular common.py; the entry file supplies
     * json, os and re.
     */
    public static function liveFeedBlock(): string
    {
        return <<<'PY'
# ==============================================================
# LIVE FEED (api.py's GET /live)
# What a live view has not been sent yet of this program's runs, with the
# rules of SynergyAI's LiveFeed::next. The cursor is "<runId>:<complete
# lines read>". On a first connect only a run in progress is sent (a
# finished one is history). A quiet poll writes Start and the trigger node,
# then deletes its file, so a run is held back until a work node or its end
# appears; when the pointer has moved on, the rest of the cursor's run is
# sent first.
# ==============================================================
import glob, math

LIVE_TRIGGER_ID_FROM = 1000000000   # node ids from here on are a Start option's trigger node (StartOptionGraph::ID_OFFSET)
_LIVE_CURSOR = re.compile(r"([a-f0-9]{32}):([0-9]+)")


def live_next(runs_dir: str, cursor: str | None) -> tuple[list[dict], str | None]:
    """The events after `cursor` and the cursor to ask from next time (LiveFeed::next)."""
    m = _LIVE_CURSOR.fullmatch(cursor or "")
    cur_run, cur_lines = (m.group(1), int(m.group(2))) if m else (None, 0)
    run_id = _live_current(runs_dir)
    tail: list[dict] = []
    if cur_run is not None and cur_run != run_id:
        prev = _live_read(runs_dir, cur_run)
        if prev is not None:
            tail = prev[cur_lines:]
            cursor = f"{cur_run}:{max(cur_lines, len(prev))}"
    events = None if run_id is None else _live_read(runs_dir, run_id)
    if events is None:
        return tail, cursor
    nxt = f"{run_id}:{len(events)}"
    if cur_run == run_id:
        return events[cur_lines:], nxt
    if not _live_real(events):
        return tail, cursor
    if cur_run is None and _live_finished(events):
        return [], nxt
    return tail + events, nxt


def _live_current(runs_dir: str) -> str | None:
    """The run RUNS_DIR/current names (its 32-hex id), or None."""
    try:
        with open(os.path.join(runs_dir, "current"), encoding="utf-8") as fh:
            m = re.search(r"([a-f0-9]{32})$", fh.read().strip())
    except OSError:
        return None
    return m.group(1) if m else None


def _live_read(runs_dir: str, run_id: str) -> list[dict] | None:
    """The run's complete lines as events (an undecodable one is {"type": "unreadable"}), or None when its
    file is gone. A last line without its newline is left for next time: the run may be mid-append."""
    paths = glob.glob(os.path.join(glob.escape(runs_dir), f"*_{run_id}.jsonl"))
    if not paths:
        return None
    try:
        with open(paths[0], "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    complete = raw[:raw.rfind(b"\n") + 1].rstrip(b"\n")
    events = []
    for line in complete.split(b"\n") if complete else []:
        try:
            e = json.loads(line)
        except ValueError:
            e = None
        events.append(e if isinstance(e, dict) else {"type": "unreadable"})
    return events


def _live_node_id(v) -> int | None:
    """A node id as PHP's is_numeric + (int) read it, or None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, str):
        try:
            v = float(v)
        except ValueError:
            return None
    return int(v) if isinstance(v, (int, float)) and math.isfinite(v) else None


def _live_real(events: list[dict]) -> bool:
    """A work node ran (not Start, not the Start option's trigger node) or the run ended."""
    for e in events:
        nid = _live_node_id(e.get("node_id"))
        if (e.get("type") in ("node_start", "node_complete") and e.get("node_type") != "start"
                and nid is not None and nid < LIVE_TRIGGER_ID_FROM):
            return True
    return _live_finished(events)


def _live_finished(events: list[dict]) -> bool:
    """The run wrote workflow_complete or workflow_error."""
    return any(e.get("type") in ("workflow_complete", "workflow_error") for e in events)


PY;
    }

    /**
     * Console view (spec 2026-10-15 §5): a run's progress as the live overlay words it. Listener of
     * RunRecorder; buffers a run's lines and prints them at workflow_complete, so a quiet run (which
     * the program discards) prints nothing. event_subject is start-options.js eventSubject, ported.
     * Needs datetime and Callable from the entry file.
     */
    public static function consoleBlock(): string
    {
        return <<<'PY'
# ==============================================================
# CONSOLE VIEW
# One run's progress as lines (the live overlay's texts), printed when
# the run completes. verbosity: quiet (outcome only), normal, verbose.
# ==============================================================
import re as _re

TRIGGER_MIN_ID = 1000000000   # the Start option's hidden code node (StartOptionGraph::ID_OFFSET)


def print_line(s: str) -> None:
    """The console's default sink."""
    print(s, flush=True)


def event_subject(text: str) -> str:
    """The event a run started on: its From and Subject lines (one per line), else the first 200 characters.
    Port of start-options.js eventSubject."""
    s = str(text if text is not None else "")
    found = [_re.search(rf"^{k}:[ \t]*(.+)$", s, _re.M) for k in ("From", "Subject")]
    lines = [m.group(0).strip() for m in found if m]
    return "\n".join(lines) if lines else s[:200]


class ConsoleView:
    """A RunRecorder listener: ConsoleView(verbosity)(event)."""

    def __init__(self, verbosity: str = "normal", out: Callable[[str], None] = print_line, now=datetime.now):
        self.verbosity, self.out, self.now = verbosity, out, now
        self.buffered: list[str] = []
        self.started: float | None = None

    def _stamp(self) -> str:
        return f"[{self.now():%H:%M}]"

    def discard(self) -> None:
        """Drop the run's buffered lines (a quiet run prints nothing)."""
        self.buffered.clear()

    def __call__(self, ev: dict) -> None:
        kind = ev.get("type")
        if kind == "workflow_start":
            self.buffered.clear()
            self.started = ev.get("timestamp")
        elif kind == "node_complete":
            self._node_complete(ev)
        elif kind == "node_log":
            if ev.get("message") and self.verbosity != "quiet":
                self.buffered.append(f"    · {ev['message']}")
        elif kind == "workflow_complete":
            self._complete(ev)

    def _node_complete(self, ev: dict) -> None:
        if ev.get("node_type") == "start" or self.verbosity == "quiet":
            return
        name, ok = ev.get("node_name") or ev.get("node_id"), ev.get("success") is not False
        try:
            trigger = ev.get("drawflow_id") is None and int(ev.get("node_id")) >= TRIGGER_MIN_ID
        except (TypeError, ValueError):
            trigger = False
        if trigger and ok:
            self.buffered.append(f"{self._stamp()} New event — {' · '.join(l for l in event_subject(ev.get('output')).split(chr(10)) if l.strip())}")
        elif not ok:
            self.buffered.append(f"  ✗ {name}: {ev.get('error') or 'failed'}")
        else:
            route = ev.get("route")
            self.buffered.append(f"  ✓ {name}" + (f" → {route['name']}" if route and route.get("name") else ""))
            if self.verbosity == "verbose" and ev.get("output"):
                self.buffered.append("      " + str(ev["output"])[:500])

    def _complete(self, ev: dict) -> None:
        lines, self.buffered = self.buffered, []
        if ev.get("success") is False:
            lines.append(f"{self._stamp()} Failed: {ev.get('error') or 'run failed'}")
        else:
            took = (ev["timestamp"] - self.started) if self.started is not None and "timestamp" in ev else 0.0
            tail = f" — {str(ev.get('output') or '')[:200]}" if self.verbosity == "verbose" and ev.get("output") else ""
            lines.append(f"{self._stamp()} Done in {took:.1f} s{tail}")
        for line in (lines[-1:] if self.verbosity == "quiet" else lines):
            self.out(line)


PY;
    }

    /**
     * WorkflowGraph: the workflow as a LangGraph StateGraph, built from the frozen
     * EDGES / ORDER / NODE_TYPES and one node table. Written once for every mode: the
     * single file and orchestrator.py carry it inline, the modular package in common.py.
     * The mode supplies only `run_node(nid, request)` -- a Node in this process, an agent
     * module, or an A2A task -- so the graph code (Start, Output, the request framing,
     * the dispatcher's conditional edge) is the same everywhere.
     */
    public static function workflowGraphBlock(): string
    {
        return <<<'PY'
# ==============================================================
# WORKFLOW GRAPH
# WorkflowGraph builds the LangGraph, wires edges, and executes it.
# Each node type has a method (_start_node, _module_node, _output_node)
# that returns a callable for LangGraph to invoke. Agent and playbook
# nodes go through the run_node the mode supplies; Start and Output
# run here, with no LLM.
# ==============================================================


class ErrorExitTaken(Exception):
    """A run in which a code node took its `error` exit (WorkflowGraph.check_error_exits)."""

    def __init__(self, failed: list[tuple[str, str]]):
        """failed: (display name, the error exit's output -- why the run failed, '' when none) per code node."""
        self.nodes = [n for n, _ in failed]   # display names of the code nodes that took it
        super().__init__(", ".join(f"code node {n!r} took its error exit" + (f": {self.reason(out)}" if out.strip() else "")
                                   for n, out in failed))

    REASON_MAX = 200   # characters of an error exit's output in the error line

    @classmethod
    def reason(cls, out: str) -> str:
        """The output as one line of at most REASON_MAX characters: it may be a whole tool error page or email body."""
        line = " ".join(out.split())
        return line if len(line) <= cls.REASON_MAX else line[:cls.REASON_MAX] + "…"


class WorkflowGraph:
    """The workflow as a LangGraph StateGraph built from its frozen EDGES / ORDER / NODE_TYPES.

    Start and Output run here with no LLM; every agent/playbook node goes through `run_node`
    (in this process, in an agent module, or over A2A -- the graph does not care). A dispatcher's
    menu children hang off one conditional edge, so only the chosen child runs.
    """

    def __init__(self, *, edges: list, order: list[str], node_types: dict[str, str], agents: dict[str, dict],
                 run_node: Callable[[str, str], Awaitable[dict]], start_documents: list[dict],
                 recorder: "RunRecorder | None" = None):
        """agents maps an agent/playbook node id to its entry (display, kind, dispatch menu);
        run_node(nid, request) runs that node and returns {"text", "route", "notes", "status"}."""
        self.edges, self.order, self.node_types = edges, order, node_types
        self.agents, self.run_node, self.start_documents = agents, run_node, start_documents
        self.started: float | None = None   # time.monotonic() when the run began (RUN SUMMARY)
        self.routes: dict[str, str] = {}     # the last run's exit per code node / child per dispatcher
        self.outputs: dict[str, dict] = {}   # the last run's node_outputs (an error exit's output says why)
        self.recorder = recorder or NULL_RECORDER
        self.ran: list[str] = []             # ids of the nodes that ran this run (the quiet rule)

    def parents(self, nid: str) -> list[str]:
        """Get direct predecessor node IDs (nodes with edges INTO this node)."""
        return [f for f, t in self.edges if t == nid]

    def children(self, nid: str) -> list[str]:
        """Get direct successor node IDs (nodes this node has edges TO)."""
        return [t for f, t in self.edges if f == nid]

    def _start_node(self, nid: str):
        """The Start node: the prompt, with attached documents converted to Markdown placed before it."""
        def _run(state):
            text = state.get("user_prompt", "")
            if self.start_documents:
                doc_parts = []
                for doc in self.start_documents:
                    name = doc.get("name", "Document")
                    path = doc.get("path", "")
                    if not path:
                        doc_parts.append(f"### {name}\n\n_(no path on attachment record)_")
                        continue
                    if not os.path.isabs(path):
                        path = os.path.join(PACKAGE_DIR, path)   # a packaged copy (start_documents/...) sits in the program's folder
                    try:
                        md = DOCUMENTS.convert(path)
                        doc_parts.append(f"### {name}\n\n{md}")
                    except Exception as e:
                        doc_parts.append(f"### {name}\n\n_(conversion failed: {e})_")
                if doc_parts:
                    text = (
                        "## Attached Documents\n\n"
                        + "\n\n---\n\n".join(doc_parts)
                        + "\n\n---\n\n"
                        + text
                    )
            RUN_OUT(f"[node] [{nid}] start -- {len(text)} chars")
            self.ran.append(nid)
            self.recorder.node_start(nid, "Start", "start")
            self.recorder.node_complete(nid, "Start", "start", output=text)
            return {"node_outputs": {nid: {"source": "start", "text": text}}}
        return _run

    def _code_parents(self, nid: str, seen: frozenset = frozenset()) -> list[str]:
        """A code node's parents, a dispatcher standing for its own parents: a branch receives what
        the dispatcher received (the email), not the agent-framed context it was handed."""
        out = []
        for p in self.parents(nid):
            if (self.agents.get(p) or {}).get("dispatch"):
                if p not in seen:
                    out += self._code_parents(p, seen | {p})
            else:
                out.append(p)
        return out

    def _request_for(self, nid: str, state: dict) -> str:
        """What a node receives: a playbook gets its parents' texts joined, an agent the labelled context."""
        outs = state.get("node_outputs", {})
        if self.agents[nid]["kind"] == "code":
            # A code node gets its parents one by one (the harness decodes them); a parent
            # whose branch was not taken has no output and is left out.
            return json.dumps({"user_prompt": state.get("user_prompt", ""),
                               "parents": [{"name": outs[p]["source"], "text": outs[p]["text"],
                                            "start": self.node_types.get(p) == "start"}
                                           for p in self._code_parents(nid) if p in outs]}, ensure_ascii=False)
        if self.agents[nid]["kind"] == "playbook":
            return "\n\n".join(outs[p]["text"] for p in self.parents(nid) if p in outs) or state.get("user_prompt", "")
        return build_context(state.get("user_prompt", ""), self.parents(nid), outs)

    def _module_node(self, nid: str):
        """An agent/playbook node: run it, then turn a dispatcher's choice into the conditional edge's input."""
        async def _run(state):
            ad = self.agents[nid]
            self.recorder.node_start(nid, ad["display"], self.node_types.get(nid, ""))
            try:
                out = await self.run_node(nid, self._request_for(nid, state))
            except Exception as e:
                self.recorder.node_complete(nid, ad["display"], self.node_types.get(nid, ""), success=False, error=f"{type(e).__name__}: {e}")
                raise
            self.ran.append(nid)
            route_info = None
            if ad.get("dispatch"):
                chosen = next((t for t in ad["dispatch"] if t["id"] == out.get("route")), None)
                route_info = {"id": chosen["id"], "name": chosen["name"]} if chosen else None
            self.recorder.node_complete(nid, ad["display"], self.node_types.get(nid, ""), output=out["text"],
                                        exit=out["route"] if ad.get("kind") == "code" else None, route=route_info)
            result = {"node_outputs": {nid: {"source": ad["display"], "text": out["text"]}}}
            if ad.get("kind") == "code":
                # Code node: the exit it took selects its children (conditional edge).
                result["routes"] = {nid: out["route"]}
            if ad.get("dispatch"):
                # Dispatcher: the node chose a child (or none) -> conditional edge input;
                # a request it did not route ends the run with its message.
                route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END
                if route == END:
                    RUN_OUT(f"[node] [{nid}] ⚠ dispatcher did not route; ending the run")
                    result["final_output"] = out["text"]
                result["routes"] = {nid: route}
            return result
        return _run

    def _output_node(self, nid: str):
        """The Output node: the lone parent's text verbatim, else every parent's text under its name."""
        def _run(state):
            pids = self.parents(nid)
            outs = state.get("node_outputs", {})
            if len(pids) == 1 and pids[0] in outs:
                final = outs[pids[0]]["text"]
            else:
                blocks = [f"## {outs[p]['source']}\n\n{outs[p]['text']}" for p in pids if p in outs]
                final = "\n\n---\n\n".join(blocks)
            RUN_OUT(f"[node] [{nid}] output -- {len(final)} chars")
            self.ran.append(nid)
            self.recorder.node_start(nid, "Output", "output")
            self.recorder.node_complete(nid, "Output", "output", output=final)
            return {"final_output": final}
        return _run

    def _router(self, nid: str):
        """The conditional-edge function of dispatcher `nid`: the child it chose, or END."""
        return lambda state: state.get("routes", {}).get(nid) or END

    def _code_router(self, nid: str):
        """The conditional-edge function of code node `nid`: the children on the exit it took, or END."""
        targets = self.agents[nid].get("exit_targets", {})
        return lambda state: targets.get(state.get("routes", {}).get(nid), []) or END

    def _wire_edges(self, sg) -> None:
        """Plain edges forward in ORDER; a dispatcher's menu children only through its conditional edge."""
        # Wire edges. A dispatcher's menu children hang off a conditional edge:
        # only the child named in state["routes"] runs (siblings are skipped).
        pos = {n: i for i, n in enumerate(self.order)}
        sg.add_edge(START, self.order[0])
        for nid in self.order:
            entry = self.agents.get(nid, {})
            is_code = entry.get("kind") == "code"
            menu = set(self.children(nid)) if is_code else {t["id"] for t in entry.get("dispatch", [])}
            for child in self.children(nid):
                if child in pos and pos[child] > pos[nid] and child not in menu:
                    sg.add_edge(nid, child)
            if menu:
                router = self._code_router(nid) if is_code else self._router(nid)
                sg.add_conditional_edges(nid, router, {t: t for t in menu} | {END: END})
        for nid in self.order:
            if not self.children(nid):
                sg.add_edge(nid, END)

    def compile(self):
        """The compiled LangGraph: one graph node per workflow node, chosen by its type."""
        sg = StateGraph(WFState)
        for nid in self.order:
            ntype = self.node_types.get(nid, "")
            match ntype:
                case "start":
                    sg.add_node(nid, self._start_node(nid))
                case "agent" | "playbook" | "code":
                    sg.add_node(nid, self._module_node(nid))
                case "output":
                    sg.add_node(nid, self._output_node(nid))
                case _:
                    sg.add_node(nid, lambda s: {})
        self._wire_edges(sg)
        return sg.compile()

    async def run(self, prompt: str) -> str:
        """Run the workflow once on `prompt`; returns the final output ('' if the run stopped with none).

        Steps: compile the graph (nodes from ORDER, edges from EDGES in topological
        order), invoke it on the prompt, and return the final output text.
        """
        self.ran = []
        graph = self.compile()
        RUN_OUT("[info] Running...")
        self.started = time.monotonic()
        result = await graph.ainvoke({"user_prompt": prompt, "node_outputs": {}})
        self.routes = result.get("routes", {})
        self.outputs = result.get("node_outputs", {})
        return result.get("final_output", "")

    def check_error_exits(self) -> None:
        """Raise ErrorExitTaken when a code node of the last run took its `error` exit: that
        run failed, even when the error branch produced output (--cron reports it, never drains)."""
        failed = [(self.agents[nid]["display"], self.outputs.get(nid, {}).get("text", ""))
                  for nid, route in self.routes.items()
                  if route == "error" and self.agents.get(nid, {}).get("kind") == "code"]
        if failed:
            raise ErrorExitTaken(failed)


PY;
    }

    /**
     * --cron: the autonomous loop of a compiled workflow (spec 2026-10-07 §7.2), emitted once per
     * entry file. CronExpression is the twin of CronExpression.php (same fields, same "restricted
     * day field" rule -- a day field is restricted unless it is exactly "*", so "*\/2" is -- same
     * never-firing bound). run_cron follows ScheduleTick + CodeNodeStep::summarize: a run with
     * output did work and, when the workflow has code nodes, drains (runs again at once) up to
     * MAX_RUNS_PER_TICK runs; a run without output is quiet; an error -- an exception, or a code
     * node's error exit (WorkflowGraph.check_error_exits) -- is always printed, never quiet,
     * never drained, and the loop goes on. Each run executes in a worker thread with a 30 min cap
     * (drain()); LoopState is the loop's state line, SingleInstance its lock file (spec 2026-10-15
     * §3). The entry file supplies re, time, argparse and datetime/timedelta, asyncio and signal;
     * the block imports sys, threading and (when present) fcntl itself, so every entry file that
     * embeds it -- single file, modular workflow.py, A2A orchestrator.py, swarm -- compiles as is.
     */
    public static function cronBlock(): string
    {
        return <<<'PY'
# ==============================================================
# CRON LOOP (--cron)
# CronExpression has the server scheduler's rules (CronExpression.php): 5
# fields (minute hour day-of-month month day-of-week), local time, *, n, a-b
# and /step, comma-separated, day-of-week 0 and 7 = Sunday; when neither day
# field is exactly "*", a day matches either one. run_cron() follows the
# server's tick: a run with output did work -- in a workflow with code nodes
# it runs again at once (the next email may be waiting), at most 20 runs per
# tick; a run without output is quiet (one line); an error is always printed,
# ends the tick, and the loop goes on. Each run has a 30 min cap; a lock
# file keeps a second copy of the loop from starting.
# ==============================================================

import sys, threading
try:
    import fcntl   # POSIX: SingleInstance's lock; where it is missing the lock is a no-op
except ImportError:
    fcntl = None


class CronExpression:
    """A 5-field cron expression, with the rules of the server's CronExpression.php."""

    RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
    MAX_STEPS = 60000   # day steps bound the search at about 164 years: enough for a leap day, bounded for one that never fires
    _ITEM = re.compile(r"(\*|[0-9]+(?:-[0-9]+)?)(?:/([0-9]+))?")

    def __init__(self, expr: str):
        parts = re.split(r"[ \t\n\v\f\r]+", expr.strip(" \t\n\r\0\v"))
        if len(parts) != 5:
            raise ValueError("cron needs 5 fields: minute hour day-of-month month day-of-week")
        self.minutes, self.hours, self.days, self.months, self.weekdays = (
            self._field(p, lo, hi) for p, (lo, hi) in zip(parts, self.RANGES))
        if 7 in self.weekdays:
            self.weekdays = (self.weekdays - {7}) | {0}
        self.dom_star, self.dow_star = parts[2] == "*", parts[4] == "*"

    @classmethod
    def _field(cls, f: str, lo: int, hi: int) -> set[int]:
        """The values one field allows: items "*", "n" or "a-b", each with an optional "/step"."""
        out = set()
        for item in f.split(","):
            m = cls._ITEM.fullmatch(item)
            if not m:
                raise ValueError(f"bad cron field '{f}'")
            base, step = m.group(1), int(m.group(2) or 1)
            match base.split("-"):
                case ["*"]:
                    a, b = lo, hi
                case [x, y]:
                    a, b = int(x), int(y)
                case [x]:
                    a = b = int(x)
                    if m.group(2) is not None:
                        b = hi   # "5/10" = from 5, every 10
            if a < lo or b > hi or a > b or step < 1:
                raise ValueError(f"cron field '{f}' is out of range {lo}-{hi}")
            out.update(range(a, b + 1, step))
        return out

    def _day_matches(self, t: datetime) -> bool:
        if t.month not in self.months:
            return False
        dom, dow = t.day in self.days, t.isoweekday() % 7 in self.weekdays
        return (dom and dow) if (self.dom_star or self.dow_star) else (dom or dow)

    def next_after(self, after: datetime) -> datetime:
        """The first minute strictly after `after` that matches."""
        t = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
        for _ in range(self.MAX_STEPS):
            if not self._day_matches(t):
                t = t.replace(hour=0, minute=0) + timedelta(days=1)
                continue
            if t.hour not in self.hours:
                t = t.replace(minute=0) + timedelta(hours=1)
                continue
            for minute in range(t.minute, 60):
                if minute in self.minutes:
                    return t.replace(minute=minute)
            t = t.replace(minute=0) + timedelta(hours=1)
        raise ValueError("cron expression never fires")

    @classmethod
    def from_cli(cls, ap: argparse.ArgumentParser, value: str | None, default: str | None) -> str | None:
        """--cron's expression: None without the flag, the baked DEFAULT_CRON for a bare --cron,
        else the one given. A missing or invalid expression is a usage error (exit 2)."""
        match value:
            case None:
                return None
            case "":
                if not default:
                    ap.error("--cron needs an expression: this workflow has no cron schedule")
                expr = default
            case _:
                expr = value
        try:
            cls(expr).next_after(datetime.now())
        except ValueError as e:
            ap.error(f"--cron {expr!r}: {e}")
        return expr


class LoopState:
    """What a --cron / --watch loop is doing, as one line and a tone (ok | warn | err | off), the
    server worker's state line. set() hands a changed state to each of on_change, and prints it as
    "[<tag> HH:MM] <line>" (only when `echo`) when it differs from the line last printed -- so a
    transient state set with show=False ("Running…" on a wake that finds nothing) that goes back to
    the line already on the console prints nothing. Thread-safe: a loop may run in a thread."""

    def __init__(self, tag: str = "watch", now=datetime.now, echo: bool = True):
        self.line, self.tone = "", "off"
        self.listening = False     # the loop is running
        self.last_failed = False   # the last drain ended in an error or an abandoned run
        self.on_change: list[Callable[["LoopState"], None]] = []
        self.tag, self.now, self.echo = tag, now, echo
        self.shown: str | None = None   # the line last printed (None: print the next one whatever it is)
        self._lock = threading.Lock()

    def set(self, line: str, tone: str, show: bool = True) -> None:
        """The new state, handed to the listeners only when it changed; printed (when `echo` and
        `show`) only when it is not the line already printed."""
        with self._lock:
            if (line, tone) == (self.line, self.tone):
                return
            self.line, self.tone = line, tone
            say = self.echo and show and line != self.shown
            if say:
                self.shown = line
        if say:
            print(f"[{self.tag} {self.now():%H:%M}] {line}", flush=True)
        self.notify()

    def notify(self) -> None:
        """Hand the state to each on_change listener (e.g. api.py's /live feed); one that raises is
        reported and skipped, so a broken listener never stops the loop."""
        for listener in list(self.on_change):
            try:
                listener(self)
            except Exception as e:  # noqa: BLE001 -- a broken listener must not break the loop
                print(f"[warn] state listener failed: {e}", flush=True)


class SingleInstance:
    """One loop per package: an exclusive, non-blocking flock on `path` (e.g. <package>/.run.lock)
    for as long as the loop runs. Held by another process -> the state (when given) becomes
    "Not listening: already running (<path>)", tone off -- else "[watch] already running (<path>)"
    is printed -- and sys.exit(0) (in a thread that only ends the thread). No path, or no fcntl
    (Windows): a no-op."""

    def __init__(self, path: str | None, tag: str = "watch", state: LoopState | None = None):
        self.path, self.tag, self.state, self.fh = path, tag, state, None

    def __enter__(self):
        if self.path is None or fcntl is None:
            return self
        self.fh = open(self.path, "a")
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.fh.close()
            self.fh = None
            if self.state is not None:
                self.state.tag = self.tag
                self.state.set(f"Not listening: already running ({self.path})", "off")
            if self.state is None or not self.state.echo:
                print(f"[{self.tag}] already running ({self.path})", flush=True)
            sys.exit(0)
        return self

    def __exit__(self, *exc):
        if self.fh is not None:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
            self.fh.close()
            self.fh = None
        return False


RUN_CAP_S = 1800.0   # a run longer than 30 min is abandoned (the server worker's cap)


class RunLoop:
    """The runs' event loop, behind a holder: each run reads `.loop` when it starts. When drain()
    abandons a run stuck past the cap, it swaps in a fresh loop here; the stuck run keeps the old
    one (never cancelled, never closed) and the next run starts on the new one. Accepted: a stuck
    run that wakes up late may still write into the shared GRAPH_RECORDER / NODE_DURATIONS, so its
    late events can land in the next run's log."""

    def __init__(self, loop: asyncio.AbstractEventLoop | None = None):
        self.loop = loop if loop is not None else asyncio.new_event_loop()
        self.abandoned: list[threading.Thread] = []   # worker threads of abandoned runs, still alive or not

    def abandon(self, thread: threading.Thread) -> None:
        """`thread`'s run passed the cap: leave it its loop, give the next runs a fresh one."""
        self.abandoned.append(thread)
        self.loop = asyncio.new_event_loop()


def _capped(fn: Callable[[], str], cap_s: float) -> tuple[bool, str, BaseException | None, threading.Thread]:
    """fn() in a daemon thread: (finished, result, error, thread). Ctrl-C while waiting joins it
    fully, so the run finishes its output and log, then re-raises."""
    box: dict = {}

    def target():
        try:
            box["r"] = fn()
        except BaseException as e:  # noqa: BLE001 -- handed to the caller
            box["e"] = e

    t = threading.Thread(target=target, name="run", daemon=True)
    t.start()
    try:
        t.join(cap_s)
    except KeyboardInterrupt:
        t.join()
        raise
    if t.is_alive():
        return False, "", None, t
    return True, box.get("r", ""), box.get("e"), t


def drain(run_once: Callable[[], str], *, drains: bool, max_runs: int,
          loop: RunLoop | None = None, run_cap_s: float = RUN_CAP_S) -> str:
    """What one cron tick or one --watch wake runs: the workflow, again while runs do work (only
    when `drains`), at most max_runs runs; an error ends it. Returns the line the loop prints.

    Each run executes in a worker thread joined for at most run_cap_s: past it the run is
    abandoned (the thread is left, its result dropped) and `loop` (the RunLoop the runs read their
    event loop from) gets a fresh event loop, so the loop goes on. An event loop is only driven
    from one worker thread, one run at a time: after a failed run, its leftover tasks are
    cancelled there too -- never on an abandoned run's loop. KeyboardInterrupt propagates once the
    current run has finished."""
    worked = 0

    def one(event_loop: asyncio.AbstractEventLoop | None, abandoned: threading.Event) -> Callable[[], str]:
        def run() -> str:
            try:
                return run_once()
            except BaseException:
                if not abandoned.is_set():
                    cancel_leftovers(event_loop)
                raise
        return run

    for _ in range(max_runs):
        abandoned = threading.Event()
        finished, output, error, thread = _capped(one(loop.loop if loop else None, abandoned), run_cap_s)
        if not finished:
            abandoned.set()
            if loop is not None:
                loop.abandon(thread)
            return "abandoned a run after 30 min"
        if isinstance(error, (Exception, asyncio.CancelledError)):   # one bad run must not stop the loop
            return f"error after {worked} run(s) that did work: {type(error).__name__}: {error}"
        if error is not None:   # SystemExit, KeyboardInterrupt raised by the run itself
            raise error
        if not output:
            break
        worked += 1
        if not drains:
            break
    return f"{worked} run(s) did work" if worked else "nothing to do"


def drain_shown(line: str, verbosity: str) -> bool:
    """Whether a loop prints the line drain() returned: a drain that did nothing prints nothing (but
    under --verbose); one that did work prints, but under --quiet (each run's done line says it); an
    error or an abandoned run always prints."""
    if verbosity == "verbose" or line.startswith(("error", "abandoned")):
        return True
    return line != "nothing to do" and verbosity != "quiet"


def cancel_leftovers(loop: asyncio.AbstractEventLoop | None) -> None:
    """After a failed run, cancel the tasks it left on the runs' event loop, so none of them
    wakes up inside the next run. Called on the thread that ran the run."""
    if loop is None or loop.is_closed() or loop.is_running():   # running: on another thread, not ours to touch
        return
    leftovers = [t for t in asyncio.all_tasks(loop) if not t.done()]
    for t in leftovers:
        t.cancel()
    if leftovers:
        loop.run_until_complete(asyncio.gather(*leftovers, return_exceptions=True))


class SigtermAsCtrlC:
    """While active, SIGTERM stops a loop the way Ctrl-C does (the caller's finally blocks run).
    Only on the main thread: elsewhere (a loop run by api.py's listener) it does nothing."""

    def __enter__(self):
        self.previous = None
        if threading.current_thread() is threading.main_thread():
            self.previous = signal.signal(signal.SIGTERM, self._raise)
        return self

    @staticmethod
    def _raise(signum, frame):
        raise KeyboardInterrupt

    def __exit__(self, *exc):
        if self.previous is not None:
            signal.signal(signal.SIGTERM, self.previous)
        return False


def _nap(seconds: float, sleep, stop: threading.Event | None) -> None:
    """A loop's sleep: the given one, or -- with a stop event and the real clock -- a wait that a
    stop ends at once."""
    if stop is not None and sleep is time.sleep:
        stop.wait(seconds)
    else:
        sleep(seconds)


class CronLoop:
    """The --cron loop: sleep until the next fire, run one tick, print its line (drain_shown()), repeat.
    `banner` replaces the loop's first line (the Listener's, printed once the lock is held)."""

    MAX_NAP = 60.0   # seconds: sleep in naps and re-check the clock (DST changes, a laptop asleep)

    def __init__(self, expr: str, run_once: Callable[[], str], *, drains: bool, max_runs: int, sleep, now,
                 loop: RunLoop | None = None, state: LoopState | None = None,
                 stop: threading.Event | None = None, run_cap_s: float = RUN_CAP_S,
                 verbosity: str = "normal", banner: str | None = None):
        self.expr, self.cron = expr, CronExpression(expr)
        self.run_once, self.drains, self.max_runs, self.loop = run_once, drains, max_runs, loop
        self.sleep, self.now, self.stop, self.run_cap_s = sleep, now, stop, run_cap_s
        self.verbosity, self.banner = verbosity, banner
        # the [tick] line is the console; the state line is for listeners (api.py)
        self.state = state if state is not None else LoopState()
        self.state.tag, self.state.now, self.state.echo = "cron", now, False

    def _stopped(self) -> bool:
        return self.stop is not None and self.stop.is_set()

    def tick(self) -> str:
        """One tick's runs, as the line it prints (drain())."""
        self.state.set("Running…", "ok")
        line = drain(self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop, run_cap_s=self.run_cap_s)
        self.state.last_failed = line.startswith(("error", "abandoned"))
        return line

    def _idle(self, due: datetime) -> None:
        if self.state.last_failed:
            self.state.set("Scheduled — the last run failed", "warn")
        else:
            self.state.set(f"Scheduled: {self.expr} — next run {due:%H:%M}", "ok")

    def _wait_until(self, due: datetime) -> None:
        """Sleep until `due` in naps of at most MAX_NAP seconds, re-reading the clock after each."""
        while not self._stopped() and (left := (due - self.now()).total_seconds()) > 0:
            _nap(min(left, self.MAX_NAP), self.sleep, self.stop)

    def run(self, ticks: int | None = None) -> None:
        """Tick on every fire until Ctrl-C, SIGTERM or `stop` (or `ticks` ticks, for tests)."""
        due = self.cron.next_after(self.now())
        print(self.banner or f"[cron] {self.expr!r}: next run {due:%Y-%m-%d %H:%M}. Ctrl-C to stop.", flush=True)
        done = 0
        self.state.listening = True
        self._idle(due)
        with SigtermAsCtrlC():
            try:
                while (ticks is None or done < ticks) and not self._stopped():
                    self._wait_until(due)
                    if self._stopped():
                        break
                    done += 1
                    line = self.tick()
                    if drain_shown(line, self.verbosity):
                        print(f"[tick {due:%H:%M}] {line}", flush=True)
                    # The fire after this one -- or after now, when the runs overran the next fires.
                    due = self.cron.next_after(max(due, self.now()))
                    self._idle(due)
                if self._stopped():
                    print("[cron] stopped.", flush=True)
            except KeyboardInterrupt:
                print("\n[cron] stopped.", flush=True)
            finally:
                self.state.listening = False
                self.state.notify()


def cron_next(expr: str, after: datetime) -> datetime:
    """The first minute strictly after `after` that matches the 5-field cron `expr`."""
    return CronExpression(expr).next_after(after)


def run_cron(expr: str, run_once: Callable[[], str], *, drains: bool, max_runs: int = 20, sleep=time.sleep,
             now=datetime.now, ticks: int | None = None, loop: RunLoop | None = None,
             state: LoopState | None = None, stop: threading.Event | None = None, lock_path: str | None = None,
             verbosity: str = "normal", banner: str | None = None) -> None:
    """Run the workflow on every fire of `expr` until Ctrl-C, SIGTERM or `stop` (or `ticks` ticks, for tests).

    run_once() runs the workflow once and returns its output ('' = nothing to do). drains is
    True when the workflow has code nodes: a run that did work then runs again at once, up to
    max_runs runs per tick (the server's MAX_RUNS_PER_TICK). `loop` is the RunLoop the runs read
    their event loop from: the tasks a failed run leaves on it are cancelled before the next run,
    and a run abandoned past the 30 min cap leaves the next runs a fresh one. `state` receives
    the loop's state line; `lock_path` (e.g. <package>/.run.lock) keeps a second copy from starting.
    verbosity (quiet | normal | verbose) decides which tick lines print (drain_shown()); `banner`, when
    given, is the first line, printed once the lock is held. May run in a thread (api.py's listener):
    it then installs no signal handler.
    """
    with SingleInstance(lock_path, "cron", state):
        CronLoop(expr, run_once, drains=drains, max_runs=max_runs, sleep=sleep, now=now, loop=loop,
                 state=state, stop=stop, verbosity=verbosity, banner=banner).run(ticks)


PY;
    }

    /**
     * --watch: run when an MCP tool says something new arrived, instead of on a timer (spec
     * 2026-10-12 mail/drive events §7), with the server event worker's rules (spec 2026-10-15 §3).
     * The trigger tool blocks until then and answers {"status": "ready"} -- the workflow then runs
     * and drains exactly like a cron tick (drain()) -- or {"status": "timeout"}, and the loop asks
     * again. A failed call (WatchError: unreachable, reconnect_needed, not_connected, bad_answer,
     * tool_error) is retried after a backoff of 30 s doubling to 300 s, reset by any valid answer.
     * The loop's state line (LoopState) prints once when it changes. Generic: nothing here knows
     * which server or tool it is (outlook.wait_for_new is one). Emitted after cronBlock(), whose
     * drain(), LoopState, SingleInstance and SigtermAsCtrlC it uses; the entry file supplies json,
     * MCP and MCP_SERVER_SLUGS.
     */
    public static function watchBlock(): string
    {
        return <<<'PY'
# ==============================================================
# WATCH LOOP (--watch)
# Instead of a timer, an MCP tool decides when to run: the loop calls the
# trigger tool (e.g. outlook.wait_for_new), which waits until something new
# probably arrived and answers {"status": "ready"} -- the workflow then runs
# and drains as a cron tick does -- or {"status": "timeout"}, and the loop
# asks again. A failed call is retried after 30 s, doubling to 5 min; the
# state line ("Listening for events", "Not listening: ...") prints when it
# changes.
# ==============================================================


class WatchError(Exception):
    """The trigger tool failed, or did not answer {"status": "ready" | "timeout"}. `kind`:
    unreachable | reconnect_needed | not_connected | bad_answer | tool_error."""

    def __init__(self, kind: str, message: str = ""):
        super().__init__(message or kind)
        self.kind = kind


class WatchTrigger:
    """The MCP tool --watch waits on: a server slug (as in MCP_HEADERS_<SLUG>), a tool, its arguments."""

    def __init__(self, server: str, tool: str, args: dict):
        self.server, self.tool, self.args = server, tool, args

    def __str__(self) -> str:
        return f"{self.server}.{self.tool}"

    @classmethod
    def parse(cls, text: str) -> "WatchTrigger":
        """'server.tool', optionally followed by a JSON object of the tool's arguments."""
        head, _, rest = text.strip().partition(" ")
        server, dot, tool = head.partition(".")
        if not (server and dot and tool):
            raise ValueError("expected server.tool, e.g. outlook.wait_for_new")
        try:
            args = json.loads(rest) if rest.strip() else {}
        except ValueError as e:
            raise ValueError(f"the arguments are not JSON: {e}") from None
        if not isinstance(args, dict):
            raise ValueError("the arguments must be a JSON object")
        return cls(server, tool, args)

    @classmethod
    def from_cli(cls, ap: argparse.ArgumentParser, value: str | None, default: dict | None) -> "WatchTrigger | None":
        """--watch's trigger: None without the flag, the baked DEFAULT_WATCH for a bare --watch, else
        the one given. A missing or bad trigger, or a server this workflow does not use, is a usage
        error (exit 2), before any agent starts."""
        match value:
            case None:
                return None
            case "":
                if not default:
                    ap.error("--watch needs a trigger: this workflow has no event trigger, e.g. "
                             "--watch 'outlook.wait_for_new {\"args\": {\"folder\": \"Inbox\"}}'")
                trigger = cls(default["server"], default["tool"], dict(default.get("args") or {}))
            case _:
                try:
                    trigger = cls.parse(value)
                except ValueError as e:
                    ap.error(f"--watch {value!r}: {e}")
        if trigger.url() is None:
            known = ", ".join(sorted(set(MCP_SERVER_SLUGS.values()))) or "none"
            ap.error(f"--watch: MCP server {trigger.server!r} is not used by this workflow (its servers: {known}); "
                     f"set MCP_URL_{trigger.server.upper()} in .env if the server moved")
        return trigger

    def url(self) -> str | None:
        """The server's registered URL (MCP_SERVER_SLUGS), or None when the workflow does not use it."""
        return next((u for u, slug in MCP_SERVER_SLUGS.items() if slug == self.server), None)

    def wait(self) -> dict:
        """One call of the tool, as its result object; anything else raises WatchError."""
        try:
            raw = MCP.call_tool_raw(self.url(), self.tool, self.args)
        except Exception as e:  # noqa: BLE001 -- transport: refused, timed out, HTTP error
            raise WatchError("unreachable", str(e) or type(e).__name__) from e
        text = "\n".join(c.get("text", "") for c in raw.get("content") or []
                         if isinstance(c, dict) and c.get("type") == "text").strip()
        if raw.get("transport_error"):   # McpClient's own transport failure, returned rather than raised
            raise WatchError("unreachable", text or "server unreachable")
        result = raw.get("structuredContent")
        if result is None:
            try:
                result = json.loads(text)
            except ValueError:
                result = None
        if isinstance(result, dict) and result.get("error"):   # e.g. {"error": "reconnect_needed", "message": ...}
            code = str(result["error"])
            kind = code if code in ("reconnect_needed", "not_connected") else "tool_error"
            raise WatchError(kind, str(result.get("message") or code))
        if raw.get("isError"):
            raise WatchError("tool_error", text or "tool error")
        if not isinstance(result, dict) or result.get("status") not in ("ready", "timeout"):
            raise WatchError("bad_answer", f'expected {{"status": "ready" | "timeout"}}, got {text[:200]!r}')
        return result


class WatchLoop:
    """The --watch loop: wait on the trigger, drain the workflow when it says ready, repeat."""

    BACKOFF_START = 30.0
    BACKOFF_MAX = 300.0

    def __init__(self, trigger: WatchTrigger, run_once: Callable[[], str], *, drains: bool, max_runs: int, sleep, now,
                 loop: RunLoop | None = None, state: LoopState | None = None,
                 stop: threading.Event | None = None, run_cap_s: float = RUN_CAP_S,
                 verbosity: str = "normal", banner: str | None = None):
        self.trigger, self.sleep, self.now, self.stop = trigger, sleep, now, stop
        self.run_once, self.drains, self.max_runs, self.loop = run_once, drains, max_runs, loop
        self.run_cap_s, self.verbosity, self.banner = run_cap_s, verbosity, banner
        self.state = state if state is not None else LoopState()
        self.state.tag, self.state.now = "watch", now
        self.backoff: float | None = None   # the current retry delay; None after a valid answer

    def _say(self, text: str) -> None:
        print(f"[watch {self.now():%H:%M}] {text}", flush=True)

    def _stopped(self) -> bool:
        return self.stop is not None and self.stop.is_set()

    def step(self) -> None:
        """One call of the trigger, and the runs it calls for (spec 2026-10-15 §3). A wake that finds
        nothing to do prints nothing: "Running…" goes to the listeners only, and the idle line that
        follows is the one already printed."""
        try:
            r = self.trigger.wait()
        except WatchError as e:
            self._fail(e.kind, str(e))
            return
        except Exception:  # noqa: BLE001 -- transport: the server may be down for a while
            self._fail("unreachable", "server unreachable")
            return
        self.backoff = None
        idle = ("Listening (checks every 15 min)" if (r.get("via") == "fallback" or r.get("events") == "off")
                else "Listening for events")
        if r["status"] == "ready":
            self.state.set("Running…", "ok", show=False)
            line = drain(self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,
                         run_cap_s=self.run_cap_s)
            if drain_shown(line, self.verbosity):
                self._say(f"ready ({r.get('via') or 'no reason given'}): {line}")
                self.state.shown = None   # the console moved on: say the idle line again
            self.state.last_failed = line.startswith(("error", "abandoned"))
        if self.state.last_failed:
            self.state.set("Listening — the last run failed", "warn")
        else:
            self.state.set(idle, "ok")

    def _fail(self, kind: str, message: str) -> None:
        self.backoff = self.BACKOFF_START if self.backoff is None else min(self.backoff * 2, self.BACKOFF_MAX)
        text = "server unreachable" if kind == "unreachable" else message
        self.state.set(f"Not listening: {text} — retrying in {self.backoff:.0f} s", "err")
        _nap(self.backoff, self.sleep, self.stop)

    def run(self, calls: int | None = None) -> None:
        """Until Ctrl-C, SIGTERM or `stop` (or `calls` trigger calls, for tests). Ctrl-C during a run
        lets that run finish its output and log first (drain())."""
        print(self.banner or f"[watch] waiting on {self.trigger}. Ctrl-C to stop.", flush=True)
        done = 0
        self.state.listening = True
        with SigtermAsCtrlC():
            try:
                while (calls is None or done < calls) and not self._stopped():
                    done += 1
                    self.step()
                if self._stopped():
                    print("[watch] stopped.", flush=True)
            except KeyboardInterrupt:
                print("\n[watch] stopped.", flush=True)
            finally:
                self.state.listening = False
                self.state.notify()


def run_watch(trigger: WatchTrigger, run_once: Callable[[], str], *, drains: bool, max_runs: int = 20,
              sleep=time.sleep, now=datetime.now, calls: int | None = None,
              loop: RunLoop | None = None, state: LoopState | None = None,
              stop: threading.Event | None = None, lock_path: str | None = None,
              verbosity: str = "normal", banner: str | None = None) -> None:
    """Run the workflow each time `trigger` answers ready, until Ctrl-C, SIGTERM or `stop`. drains,
    max_runs, loop, state, lock_path, verbosity and banner as in run_cron(). May run in a thread
    (api.py's listener): it then installs no signal handler."""
    with SingleInstance(lock_path, "watch", state):
        WatchLoop(trigger, run_once, drains=drains, max_runs=max_runs, sleep=sleep, now=now, loop=loop,
                  state=state, stop=stop, verbosity=verbosity, banner=banner).run(calls)


PY;
    }

    /**
     * The program's mode (spec 2026-10-15 §2): choose_mode() picks one run, --cron or --watch from
     * the flags and the Start's baked START_MODE; Listener runs the cron or watch loop, either in
     * the foreground (run_blocking(): workflow.py's default mode) or in a daemon thread that a
     * stop event ends (start()/stop(): api.py). A thread installs no signal handler (R3). Emitted
     * after watchBlock(), whose run_watch/run_cron, LoopState and WatchTrigger it uses; the entry
     * file supplies json, threading and datetime.
     */
    public static function listenerBlock(): string
    {
        return <<<'PY'
# ==============================================================
# MODE AND LISTENER
# choose_mode(): one run, --cron or --watch, from the flags and the
# Start's mode. Listener runs the cron or watch loop: in the foreground
# (run_blocking, Ctrl-C / SIGTERM stop it) or in a background thread
# (start / stop, e.g. api.py), with a lock so one copy listens.
# ==============================================================


def choose_mode(args, start_mode: str) -> str:
    """"once" | "cron" | "watch": a flag decides, then a prompt given on the command line (one run),
    then the Start's mode (prompt -> one run)."""
    if args.once:
        return "once"
    if args.cron is not None:
        return "cron"
    if args.watch is not None:
        return "watch"
    if args.prompt:
        return "once"
    return start_mode if start_mode in ("cron", "watch") else "once"


class Listener:
    """The cron or watch loop of the workflow: run_blocking() in this thread, or start()/stop() in a
    daemon thread. `state` carries the loop's state line; `lock_path` keeps a second copy out."""

    def __init__(self, mode: str, run_once: Callable[[], str], *, drains: bool, loop: RunLoop | None,
                 cron_expr: str | None, trigger: "WatchTrigger | None", state: LoopState, lock_path: str | None,
                 max_runs: int = 20, verbosity: str = "normal"):
        if mode not in ("cron", "watch"):
            raise ValueError(f"a Listener runs --cron or --watch, not {mode!r}")
        if (mode == "cron" and not cron_expr) or (mode == "watch" and trigger is None):
            raise ValueError(f"{mode} needs its " + ("cron expression" if mode == "cron" else "trigger"))
        self.mode, self.run_once, self.drains, self.loop = mode, run_once, drains, loop
        self.cron_expr, self.trigger, self.state, self.lock_path = cron_expr, trigger, state, lock_path
        self.max_runs, self.verbosity = max_runs, verbosity
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._restart = False   # start() came while a stop was taking effect: run the loop again
        self._guard = threading.Lock()

    @property
    def running(self) -> bool:
        """The background loop is alive (False for run_blocking, and once a stop has taken effect)."""
        return self._thread is not None and self._thread.is_alive()

    @property
    def listening(self) -> bool:
        """Running and not asked to stop: what api.py reports (a stopping loop may still finish a call)."""
        return self.running and not self._stop_event.is_set()

    def banner(self, now: datetime | None = None) -> str:
        """The startup line naming the mode."""
        if self.mode == "cron":
            due = cron_next(self.cron_expr, now or datetime.now())
            return f"Scheduled: {self.cron_expr} — next run {due:%Y-%m-%d %H:%M} (Ctrl-C to stop)"
        args = json.dumps(self.trigger.args, ensure_ascii=False, separators=(",", ":"))
        return f"Listening for events: {self.trigger} {args} (Ctrl-C to stop)"

    def _loop(self) -> None:
        """The loop itself, in the calling thread, its banner first once the lock is held; a held lock
        sets the state and ends it (SystemExit 0) with no banner."""
        if self.mode == "cron":
            run_cron(self.cron_expr, self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,
                     state=self.state, stop=self._stop_event, lock_path=self.lock_path,
                     verbosity=self.verbosity, banner=self.banner())
        else:
            run_watch(self.trigger, self.run_once, drains=self.drains, max_runs=self.max_runs, loop=self.loop,
                      state=self.state, stop=self._stop_event, lock_path=self.lock_path,
                      verbosity=self.verbosity, banner=self.banner())

    def run_blocking(self) -> None:
        """The program's default mode: the banner, then the loop in this thread until Ctrl-C or SIGTERM."""
        self._loop()

    def start(self) -> None:
        """Run the loop in a daemon thread; does nothing while it already runs. Right after a stop() the
        thread may still be finishing its trigger call or run: the stop is then called off, and should
        the loop have left already, the same thread runs it again (a second thread would find the lock
        held by the first)."""
        with self._guard:
            if self.running:
                if self._stop_event.is_set():
                    self._stop_event.clear()
                    self._restart = True
                return
            self._stop_event = threading.Event()
            self._restart = False
            self._thread = threading.Thread(target=self._serve, name=f"listener-{self.mode}", daemon=True)
            self._thread.start()

    def _serve(self) -> None:
        """The thread: the loop, again while start() asked for it during a stop; then the state says so."""
        while True:
            self._loop()
            with self._guard:
                if not self._restart:
                    self.state.set("Not listening: stopped", "off")
                    self._thread = None   # from here on start() starts a new thread
                    return
                self._restart = False

    def stop(self) -> None:
        """Ask the loop to stop; returns at once (the loop ends after the current trigger call or run)."""
        with self._guard:
            self._restart = False
            self._stop_event.set()


PY;
    }

    /**
     * save_output() and print_run_summary(): what every mode does once the graph has
     * answered. One rule for the saved file's name and place (the modular package's),
     * and one RUN SUMMARY whose only per-mode part is the timing label.
     */
    public static function outputBlock(bool $packaged = false): string
    {
        $block = <<<'PY'
# ==============================================================
# OUTPUT STORAGE + RUN SUMMARY
# ==============================================================


def save_output(output: str, *, enabled: bool, folder: str | None, workflow_id: int, workflow_name: str) -> str | None:
    """Honour the Output node's storage setting: when ON, save the final result where the
    app stores it (~/Documents/synergyAI/outputs/workflow/ by default, overridable via
    SYNERGYAI_OUTPUT_ROOT) or the workflow's custom folder; when OFF, don't save.

    A full HTML document is saved without the narration/fences around it. Returns the
    saved file's absolute path, or None (storage OFF, or the save failed with a warning).
    """
    if not enabled:
        return None
    try:
        root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")
        target = os.path.expanduser(folder) if folder else os.path.join(root, "workflow")
        if not os.path.isabs(target):
            target = os.path.join(root, target)
        os.makedirs(target, exist_ok=True)
        m = re.search(r"(?is)<!doctype html.*?</html\s*>", output) or re.search(r"(?is)<html[\s>].*?</html\s*>", output)
        ext = "html" if m else "md"
        slug = "".join(c if c.isalnum() else "-" for c in workflow_name.lower()).strip("-")[:40]
        path = os.path.join(target, f"{workflow_id}-{slug}_{time.strftime('%Y%m%d-%H%M%S')}.{ext}")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(m.group(0) if m else output)
        return os.path.abspath(path)
    except Exception as e:
        print(f"\n[warn] failed to save result: {e}")
        return None


def print_run_summary(output: str, saved: str | None, started: float | None, durations: dict[str, float], timing_label: str) -> None:
    """Closing RUN SUMMARY (printed LAST): time per node, total wall-clock, document location.

    timing_label names what a node's time covers in this mode (in this process, in its
    module, or an A2A round trip); the rest of the summary is the same in every mode.
    """
    print("\n" + "=" * 74 + "\nRUN SUMMARY\n" + "-" * 74, flush=True)
    if durations:
        w = max(len(n) for n in durations)
        print(f"  {timing_label}:", flush=True)
        for name, secs in sorted(durations.items(), key=lambda kv: -kv[1]):
            print(f"    {name:<{w}}   {secs:7.1f}s", flush=True)
    print(f"  Total wall-clock: {time.monotonic() - started:.1f}s" if started else "  Total wall-clock: n/a", flush=True)
    print(f"  Final output: {len(output)} chars", flush=True)
    print(f"  Document saved to: {saved}" if saved else "  Document not saved (output storage is OFF in the workflow settings) -- the output is printed above.", flush=True)
    print("=" * 74, flush=True)


PY;
        if (!$packaged) {
            return $block;
        }
        // The modular package saves inside its own folder (spec 2026-10-15 §4.3).
        $out = str_replace([
            'app stores it (~/Documents/synergyAI/outputs/workflow/ by default, overridable via',
            'root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.expanduser("~/Documents/synergyAI/outputs")',
        ], [
            'package stores it (<package>/outputs/workflow/ by default, overridable via',
            'root = os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(PACKAGE_DIR, "outputs")',
        ], $block, $n);
        if ($n !== 2) {
            throw new \LogicException('outputBlock: the packaged defaults no longer match the block');
        }
        return $out;
    }

    /**
     * _make_llm() and one small private function per provider.
     *
     * LangGraph's own copy of LangGraphGenerator::llmFactoryLines() (which stays as it is
     * for ADK, MAF and NOOA). _make_llm keeps its name and stays a plain function: it
     * resolves the model, then one `match` arm calls the provider's function, each of which
     * holds its lazy import so a missing package fails only the node that uses it. The
     * provider rules (DeepSeek V4 thinking, Kimi K2 temperature, GLM reasoning) live in
     * the functions that apply them. Callers look _make_llm up as a module global, so a
     * probe that patches common._make_llm still reaches every node.
     */
    public static function llmFactoryBlock(): string
    {
        return <<<'PY'
def _make_llm(provider: str, model: str, temperature: float = 0.7, max_tokens: int = 4096, thinking=None):
    """Build a LangChain chat model for the given provider/model.

    The (provider, model) pair was resolved by the generator: the
    agent's explicit model overrides the provider's default from
    system_llm_settings, and that result is what reaches this
    function. No hardcoded model fallbacks here: every value was read
    from the database when this file was generated (the script never
    reads it), so a model changed in the editor takes effect at the
    next Generate Python.

    Recognised providers (case-insensitive):
      claude     → langchain_anthropic.ChatAnthropic
      openai     → langchain_openai.ChatOpenAI
      gemini     → langchain_google_genai.ChatGoogleGenerativeAI
      grok       → ChatOpenAI on https://api.x.ai/v1
      deepseek   → ChatOpenAI on https://api.deepseek.com
      kimi       → ChatOpenAI on https://api.moonshot.ai/v1
      glm        → ChatOpenAI on https://api.z.ai/api/paas/v4

    Reads API keys from the environment (loaded from .env at startup).
    An entry point (gateway) replaces a vendor link via <PREFIX>_BASE_URL:
    XAI_/DEEPSEEK_/KIMI_/GLM_BASE_URL here; ANTHROPIC_BASE_URL and
    OPENAI_BASE_URL are read by the Anthropic / OpenAI clients themselves.
    """
    p = (provider or "claude").lower()
    if MODEL_NAME_OVERRIDE:
        model = MODEL_NAME_OVERRIDE
    if not model:
        raise RuntimeError(
            f"No model specified for provider {p!r}. "
            "Set a model name on the agent in the workflow editor, "
            "or set MODEL_NAME in .env."
        )
    match p:
        case "claude":
            return _claude(model, temperature, max_tokens)
        case "openai":
            return _openai(model, temperature, max_tokens)
        case "gemini":
            return _gemini(model, temperature, max_tokens)
        case "grok":
            return _grok(model, temperature, max_tokens)
        case "deepseek":
            return _deepseek(model, temperature, max_tokens, thinking)
        case "kimi":
            return _kimi(model, temperature, max_tokens, thinking)
        case "glm":
            return _glm(model, temperature, max_tokens)
        case _:
            raise RuntimeError(
                f"Unknown provider {provider!r}. Supported: claude, openai, gemini, grok, deepseek, kimi, glm."
            )


def _claude(model, temperature, max_tokens):
    """Anthropic Claude through langchain_anthropic."""
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(model=model, temperature=temperature, max_tokens=max_tokens)


def _openai(model, temperature, max_tokens):
    """OpenAI through langchain_openai."""
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(model=model, temperature=temperature, max_tokens=max_tokens)


def _gemini(model, temperature, max_tokens):
    """Google Gemini through langchain_google_genai (its token limit is called max_output_tokens)."""
    from langchain_google_genai import ChatGoogleGenerativeAI
    return ChatGoogleGenerativeAI(model=model, temperature=temperature, max_output_tokens=max_tokens)


def _grok(model, temperature, max_tokens):
    """xAI Grok: OpenAI-compatible."""
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        model=model,
        base_url=os.environ.get("XAI_BASE_URL") or "https://api.x.ai/v1",
        api_key=os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"),
        temperature=temperature,
        max_tokens=max_tokens,
    )


def _deepseek(model, temperature, max_tokens, thinking):
    """DeepSeek: OpenAI-compatible; V4 models also take the node's Thinking setting."""
    from langchain_openai import ChatOpenAI
    kwargs = dict(
        model=model,
        base_url=os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com",
        api_key=os.environ.get("DEEPSEEK_API_KEY"),
        temperature=temperature,
        max_tokens=max_tokens,
    )
    if model.startswith(("deepseek-v4", "deepseek-flash")):
        # The node form Thinking attribute governs (platform parity):
        # off -> disabled, form temperature kept; on/default -> V4 thinking
        # stays enabled and the API rejects sampling params, so temperature
        # is dropped (set Thinking=Off on the node to use a temperature).
        if thinking == "off":
            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "disabled"}}}
        else:
            kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": "enabled"}}}
            if "temperature" in kwargs:
                print(f"[info] deepseek {model}: temperature dropped (thinking mode)", flush=True)
                kwargs.pop("temperature", None)
    return ChatOpenAI(**kwargs)


def _kimi(model, temperature, max_tokens, thinking):
    """Moonshot Kimi: OpenAI-compatible; K2 models take the node's Thinking setting."""
    from langchain_openai import ChatOpenAI
    # Kimi is OpenAI-compatible. The node form Thinking attribute governs
    # K2 reasoning mode (default off, matching the PHP KimiProvider); the
    # API then constrains sampling: thinking OFF -> temperature MUST be 0.6,
    # thinking ON -> 1.0 (provider CONSTRAINT, not a preference override).
    _k2 = model.startswith("kimi-k2")
    if _k2:
        _want = 1.0 if thinking == "on" else 0.6
        if temperature != _want:
            print(f"[info] kimi {model}: temperature {temperature} -> {_want} (model constraint)", flush=True)
            temperature = _want
    kwargs = dict(
        model=model,
        base_url=os.environ.get("KIMI_BASE_URL") or "https://api.moonshot.ai/v1",
        api_key=os.environ.get("KIMI_API_KEY"),
        temperature=temperature,
        max_tokens=max_tokens,
    )
    if _k2:
        _mode = "enabled" if thinking == "on" else "disabled"
        kwargs["model_kwargs"] = {"extra_body": {"thinking": {"type": _mode}}}
    return ChatOpenAI(**kwargs)


def _glm(model, temperature, max_tokens):
    """Zhipu GLM (z.ai): OpenAI-compatible, with thinking switched off."""
    from langchain_openai import ChatOpenAI
    # GLM 5.2 (z.ai / Zhipu) is OpenAI-compatible.
    return ChatOpenAI(
        model=model,
        base_url=os.environ.get("GLM_BASE_URL") or "https://api.z.ai/api/paas/v4",
        api_key=os.environ.get("GLM_API_KEY"),
        temperature=temperature,
        max_tokens=max_tokens,
        # GLM 5.2 defaults to heavy reasoning; disable thinking for direct answers.
        model_kwargs={"extra_body": {"thinking": {"type": "disabled"}}},
    )
PY;
    }

    /**
     * DocumentConverter and DOCUMENTS: turn a Start-node attachment into Markdown.
     *
     * LangGraph's own copy of PythonEmitHelpers::documentConverterBlock() (the flat
     * _convert_doc_to_markdown function), split into one method per format. That helper
     * stays as it is for ADK, MAF and NOOA. WorkflowGraph._start_node calls DOCUMENTS.convert
     * for each attachment that has a path.
     */
    public static function documentConverterBlock(): string
    {
        return <<<'PY'
class DocumentConverter:
    """Read a file and return its contents as Markdown.

    Text-native formats (HTML/MD/TXT/JSON/YAML/CSV/XML/source) are returned
    verbatim. Binary office formats and PDFs are routed to their matching
    pure-Python parser. Imports are lazy so the script doesn't pull in a
    library unless the corresponding format is actually attached.

    convert() picks the parser by extension; each binary format has its own method.
    """

    TEXT_NATIVE = {
        ".html", ".htm", ".md", ".markdown", ".txt", ".text",
        ".json", ".yaml", ".yml", ".xml", ".csv", ".tsv",
        ".css", ".scss", ".less",
        ".js", ".mjs", ".ts", ".tsx", ".jsx",
        ".py", ".rb", ".go", ".rs", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
        ".sh", ".bash", ".zsh", ".sql", ".log", ".rtf", ".ini", ".toml",
    }
    MAX_ROWS = 200  # spreadsheet rows kept per sheet; the rest is cut with a note

    def convert(self, path: str) -> str:
        """Return the file at `path` as Markdown, choosing the parser by extension.

        Raises FileNotFoundError if the path doesn't exist, ValueError for an
        unsupported extension, ImportError if the format's library is missing.
        """
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(f"document not found: {path}")
        ext = p.suffix.lower()
        match ext:
            case _ if ext in self.TEXT_NATIVE:
                return p.read_text(encoding="utf-8", errors="replace")
            case ".docx":
                return self._docx(p)
            case ".pptx":
                return self._pptx(p)
            case ".xlsx" | ".xlsm":
                return self._xlsx(p)
            case ".pdf":
                return self._pdf(p)
            case _:
                raise ValueError(f"unsupported document format: {ext}")

    def _docx(self, p) -> str:
        """Word document -> Markdown through mammoth."""
        import mammoth
        with p.open("rb") as f:
            return mammoth.convert_to_markdown(f).value

    def _pptx(self, p) -> str:
        """PowerPoint deck -> one section per slide: title, bullet text and speaker notes."""
        from pptx import Presentation
        prs = Presentation(str(p))
        sections = [f"# {p.name}", f"_{len(prs.slides)} slide(s)_"]
        for i, slide in enumerate(prs.slides, start=1):
            layout = slide.slide_layout.name if slide.slide_layout else "?"
            sections.append(f"## Slide {i} -- {layout}")
            title_text = ""
            if slide.shapes.title and slide.shapes.title.has_text_frame:
                title_text = slide.shapes.title.text_frame.text.strip()
            if title_text:
                sections.append(f"### {title_text}")
            body = []
            for shape in slide.shapes:
                if shape == slide.shapes.title:
                    continue
                if not getattr(shape, "has_text_frame", False):
                    continue
                for para in shape.text_frame.paragraphs:
                    line = "".join(run.text or "" for run in para.runs).strip()
                    if not line and para.text:
                        line = para.text.strip()
                    if line:
                        indent = "  " * (para.level or 0)
                        body.append(f"{indent}- {line}")
            if body:
                sections.append("\n".join(body))
            if slide.has_notes_slide:
                notes = (slide.notes_slide.notes_text_frame.text or "").strip()
                if notes:
                    sections.append("### Notes")
                    sections.append(notes)
        return "\n\n".join(sections) + "\n"

    def _xlsx(self, p) -> str:
        """Excel workbook -> one Markdown table per sheet, cut at MAX_ROWS rows."""
        from openpyxl import load_workbook
        wb = load_workbook(str(p), data_only=True)
        sections = [f"# {p.name}", f"_{len(wb.sheetnames)} sheet(s)_"]
        for name in wb.sheetnames:
            ws = wb[name]
            rows = []
            for row in ws.iter_rows(values_only=True):
                row_vals = list(row)
                while row_vals and (row_vals[-1] is None or row_vals[-1] == ""):
                    row_vals.pop()
                if row_vals or not rows:
                    rows.append(row_vals)
            while rows and not any(c not in (None, "") for c in rows[-1]):
                rows.pop()
            sections.append(f"## Sheet: {name}")
            sections.append(f"_{len(rows)} row(s) -- {ws.max_column} col(s)_")
            if not rows:
                sections.append("_(empty)_")
                continue
            width = max(len(r) for r in rows)
            rows = [list(r) + [""] * (width - len(r)) for r in rows]
            truncated = len(rows) > self.MAX_ROWS
            if truncated:
                rows = rows[:self.MAX_ROWS]
            def cell(v):
                return ("" if v is None else str(v)).replace("|", "\\|").replace("\n", " ")
            table = ["| " + " | ".join(cell(v) for v in rows[0]) + " |",
                     "| " + " | ".join(["---"] * width) + " |"]
            for r in rows[1:]:
                table.append("| " + " | ".join(cell(v) for v in r) + " |")
            if truncated:
                table.append(f"\n_(showing first {self.MAX_ROWS} rows)_")
            sections.append("\n".join(table))
        return "\n\n".join(sections) + "\n"

    def _pdf(self, p) -> str:
        """PDF -> one section per page; a page with no extractable text says so."""
        from pypdf import PdfReader
        reader = PdfReader(str(p))
        parts = [f"# {p.name} -- {len(reader.pages)} page(s)"]
        for i, page in enumerate(reader.pages, start=1):
            try:
                t = (page.extract_text() or "").strip()
            except Exception as e:
                t = ""
            parts.append(f"## Page {i}")
            parts.append(t if t else "_(no extractable text)_")
        return "\n\n".join(parts) + "\n"


DOCUMENTS = DocumentConverter()

PY;
    }

    /**
     * McpClient and its module instance MCP: the MCP JSON-RPC client every tool call goes
     * through (URL normalisation, the initialize handshake with its fallback to the URL as
     * registered, the per-server endpoint cache, tools/call, plain-JSON or SSE parsing).
     *
     * LangGraph's own copy of PythonEmitHelpers::mcpClientBlock() (_normalize_mcp_url,
     * _MCP_ENDPOINTS, _init_mcp_session, _parse_mcp_response, _call_mcp_tool), restructured
     * into a class that reuses one httpx.Client. PythonEmitHelpers::mcpClientBlock() stays
     * as it is for ADK, MAF and NOOA.
     *
     * Its callers are ToolCatalog (catalog tools) and PlaybookToolset (bound #Actions), both
     * through MCP.call_tool.
     */
    public static function mcpClientBlock(): string
    {
        return <<<'PY'
class McpClient:
    """The MCP client: calls a tool on an MCP server and returns its text.

    The Model Context Protocol (MCP) uses JSON-RPC 2.0 over HTTP.
    Each tool call requires:
      1. URL normalization -- append /mcp if not present
      2. Session initialization -- send 'initialize' + notification
      3. Tool invocation -- send 'tools/call' with name + arguments
      4. Response parsing -- handle plain JSON or SSE-wrapped JSON

    Some MCP servers return Server-Sent Events (SSE) instead of
    plain JSON. The parser handles both formats transparently.

    One instance (MCP) serves the whole process: it remembers which endpoint each
    server answered on and sends every request through one reused HTTP client.
    """

    HEADERS = {"Content-Type": "application/json",
               "Accept": "application/json, text/event-stream, */*"}

    def __init__(self):
        self._endpoints: dict[str, str] = {}   # registered server URL -> endpoint that accepted the handshake
        # One connection pool for every handshake and call; each request sets its own
        # timeout (30 s for the handshake, 180 s for a tool call).
        # Its cookie jar is shared by every server on the same host (MCP uses headers, not cookies).
        self._http = httpx.Client()

    def _headers(self, server_url: str) -> dict:
        """HEADERS plus the server's own headers from MCP_HEADERS_<SLUG> in .env (a JSON object).

        Header values (keys, connection ids) never live in this script: the editor's MCP server
        entry holds them, and .env carries them to the compiled run.
        """
        slug = MCP_SERVER_SLUGS.get(server_url, "")
        var = f"MCP_HEADERS_{slug.upper()}"
        raw = os.environ.get(var, "") if slug else ""
        if not raw:
            return self.HEADERS
        try:
            extra = json.loads(raw)
        except json.JSONDecodeError:
            raise RuntimeError(f"{var} in .env is not valid JSON (expected e.g. {{\"Header\": \"value\"}})") from None
        if not isinstance(extra, dict):
            raise RuntimeError(f"{var} in .env must be a JSON object")
        for k, v in extra.items():
            if not isinstance(v, str) or "\r" in v or "\n" in v or "\r" in str(k) or "\n" in str(k):
                raise RuntimeError(f"{var} in .env: every header value must be a single-line string (check header {str(k)!r})")
        return {**self.HEADERS, **{str(k): v for k, v in extra.items()}}

    @staticmethod
    def _live_url(server_url: str) -> str:
        """Where the server answers: MCP_URL_<SLUG> from .env when set (the server moved), else the URL
        it was registered with. The registered URL stays the key for headers, tools and endpoints."""
        slug = MCP_SERVER_SLUGS.get(server_url, "")
        return (os.environ.get(f"MCP_URL_{slug.upper()}", "").strip() if slug else "") or server_url

    @staticmethod
    def normalize_url(url: str) -> str:
        """Ensure the URL points to the MCP endpoint.

        - If it already ends with /mcp, leave it alone.
        - If it ends with a .php file, it IS the endpoint already (XAMPP-style
          MCP server scripts like mcp-server.php). Don't append anything.
        - Otherwise, append /mcp per the MCP convention.
        """
        url = url.rstrip("/")
        if url.endswith("/mcp") or url.endswith(".php"):
            return url
        return url + "/mcp"

    @staticmethod
    def _parse(text: str) -> dict | None:
        """Parse a JSON-RPC response from an MCP server.

        MCP servers may respond in two formats:
        - Plain JSON: standard JSON-RPC response body
        - SSE (Server-Sent Events): lines prefixed with 'data:' containing JSON
        This function tries plain JSON first, then falls back to SSE parsing.
        """
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

    def _handshake(self, url: str) -> str | None:
        """Initialize an MCP session with the server.

        The MCP protocol requires a handshake before tool calls:
        1. Client sends 'initialize' with protocol version and capabilities
        2. Server responds with its capabilities
        3. Client sends 'notifications/initialized' to confirm

        Tries the /mcp-normalised URL first, then the URL exactly as registered
        (servers mounted at their bare URL, e.g. PHP mock servers, answer there
        and 404 or error on /mcp). The endpoint that answers is remembered.
        Returns that endpoint URL, or None when no candidate accepted the handshake.
        """
        init_req = {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "LangGraph-Workflow", "version": "1.0.0"},
                "capabilities": {}
            }
        }
        candidates = [self._endpoints[url]] if url in self._endpoints else []
        live = self._live_url(url)
        for cand in (self.normalize_url(live), live):
            if cand not in candidates:
                candidates.append(cand)
        last_err = None
        h = self._headers(url)   # outside the try: a bad MCP_HEADERS_<SLUG> must stop the run, not look like a failed handshake
        for mcp_url in candidates:
            try:
                r = self._http.post(mcp_url, json=init_req, headers=h, timeout=30)
                r.raise_for_status()
                data = self._parse(r.text)
                if data is None or "error" in (data or {}):
                    last_err = (data or {}).get("error") if data else "invalid response"
                    continue
                # Send initialized notification
                self._http.post(mcp_url, json={
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                    "params": {}
                }, headers=h, timeout=30)
                self._endpoints[url] = mcp_url
                return mcp_url
            except Exception as e:
                last_err = e
        print(f"[warn] MCP init failed for {url}: {last_err}")
        return None

    def call_tool(self, server_url: str, tool_name: str, arguments: dict) -> str:
        """Call a tool on an MCP server via JSON-RPC 2.0.

        Sequence: init session -> send tools/call -> parse response -> extract text.
        The MCP response contains a 'content' array; we extract all text items
        and join them. If no text is found, falls back to raw JSON.
        """
        mcp_url = self._handshake(server_url) or self.normalize_url(server_url)

        request = {
            "jsonrpc": "2.0", "id": int(time.time()),
            "method": "tools/call",
            "params": {"name": tool_name,
                       "arguments": arguments or {}}
        }
        try:
            r = self._http.post(mcp_url, json=request, headers=self._headers(server_url), timeout=180)
            r.raise_for_status()
            data = self._parse(r.text)
        except Exception as e:
            return json.dumps({"error": str(e)})

        if data is None:
            return json.dumps({"error": "invalid response"})
        if "error" in data:
            return json.dumps({"error": data["error"].get("message", "unknown")})

        content = (data.get("result") or {}).get("content", [])
        texts = [c.get("text", "") for c in content
                 if isinstance(c, dict) and c.get("type") == "text"]
        return "\n".join(t for t in texts if t) or json.dumps(data.get("result"))[:8000]

    def call_tool_raw(self, server_url: str, tool_name: str, arguments: dict) -> dict:
        """Call a tool and return the raw MCP result {content, structuredContent?, isError?} (code nodes)."""
        mcp_url = self._handshake(server_url) or self.normalize_url(server_url)
        request = {
            "jsonrpc": "2.0", "id": int(time.time()),
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments or {}}
        }
        try:
            r = self._http.post(mcp_url, json=request, headers=self._headers(server_url), timeout=180)
            r.raise_for_status()
            data = self._parse(r.text)
        except Exception as e:   # transport: refused, timed out, HTTP error -- marked, so --watch says "unreachable"
            return {"isError": True, "transport_error": True, "content": [{"type": "text", "text": str(e)}]}
        if data is None:
            return {"isError": True, "content": [{"type": "text", "text": "invalid response"}]}
        if "error" in data:
            return {"isError": True, "content": [{"type": "text", "text": data["error"].get("message", "unknown")}]}
        return data.get("result") or {}


MCP = McpClient()
PY;
    }

    /**
     * ToolCatalog and its module instance TOOLS: the workflow's tools as LangChain
     * StructuredTools -- every baked TOOL_CATALOG entry (an MCP tool) plus the local
     * run_skill_script (SKILLS.tool) -- built once per process and shared by every node.
     *
     * LangGraph's own copy of what was LangGraphGenerator::toolBuilderBlock()'s tool half
     * (_summarize_tool_result + build_tools_from_catalog), restructured into a class.
     * Emitted after TOOL_CATALOG and the MCP client (MCP.call_tool), which it calls.
     */
    public static function toolCatalogBlock(): string
    {
        return <<<'PY'
class ToolCatalog:
    """The workflow's tools, built once and shared: each node takes its own by name.

    Converts the baked catalog (tool name -> MCP server URL, description, JSON Schema) into
    LangChain StructuredTools whose calls go out over MCP JSON-RPC, and adds the local
    run_skill_script (SKILLS.tool). Building is deferred to the first build(), so importing
    the file costs nothing, and every later call reuses the same tools.
    """

    # JSON Schema "type" -> the Python type of the pydantic field (anything else is a str).
    TYPE_MAP = {"string": str, "integer": int, "number": float,
                "boolean": bool, "array": list, "object": dict}

    def __init__(self, catalog: dict[str, dict]):
        self.catalog = catalog
        self._built: dict[str, StructuredTool] | None = None   # set by the first build()

    def build(self) -> dict[str, StructuredTool]:
        """Build LangChain StructuredTool wrappers from TOOL_CATALOG.

        For each tool:
        1. Parse the JSON Schema into a Pydantic model (for LLM argument validation)
        2. Create a callable that sends the MCP JSON-RPC request
        3. Wrap both into a LangChain StructuredTool

        Built on the first call, then reused; run_skill_script is added to the MCP tools.
        Returns: dict mapping tool_name -> StructuredTool
        """
        if self._built is None:
            built = {name: self._tool(name, info) for name, info in self.catalog.items()}
            # Local (non-MCP) tool: lets skill-bound agents run their folder-backed
            # skill as a subprocess. Always registered; only agents whose tool_names
            # include it (skill agents) actually receive it.
            built["run_skill_script"] = SKILLS.tool
            self._built = built
        return self._built

    def tools_for(self, names: list[str]) -> list[StructuredTool]:
        """The tools a node names (its tool_names), in that order; a name the catalog lacks is skipped."""
        built = self.build()
        return [built[t] for t in names if t in built]

    @staticmethod
    def args_model(name: str, schema: dict):
        """The pydantic model `<name>Args` for a tool's JSON Schema, so the LLM's arguments are
        validated: required properties are mandatory, the others default to None."""
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        required = set(schema.get("required", []) if isinstance(schema, dict) else [])
        fields = {}
        for pname, pspec in props.items():
            spec = pspec if isinstance(pspec, dict) else {}
            ptype = ToolCatalog.TYPE_MAP.get(spec.get("type", "string"), str)
            default = ... if pname in required else None
            fields[pname] = (ptype, Field(default, description=spec.get("description", "")))
        return create_model(f"{name}Args", **fields) if fields else create_model(f"{name}Args")

    def _tool(self, name: str, info: dict) -> StructuredTool:
        """One catalog entry as a StructuredTool: a logged call to its MCP server."""
        server_url = info["server_url"]

        def invoke(**kwargs):
            argv = json.dumps(kwargs, default=str)
            argv_preview = argv if len(argv) <= 250 else argv[:250] + f" ... +{len(argv) - 250} chars"
            node_print(f"  [tool] -> {name}({argv_preview})")
            t0 = time.monotonic()
            result = MCP.call_tool(server_url, name, kwargs)
            dt = time.monotonic() - t0
            summary = self._summarize(result)
            node_print(f"  [tool] ← {name}: {summary} ({len(result)} chars, {dt:.1f}s)")
            return result

        return StructuredTool.from_function(
            func=invoke,
            name=name,
            description=info.get("description") or f"MCP tool {name}",
            args_schema=self.args_model(name, info.get("input_schema") or {}),
        )

    @staticmethod
    def _summarize(result: str) -> str:
        """Short, informative summary of a tool result for logs.

        Parses JSON when possible and surfaces the most useful fields
        (article count + first PMIDs, error message, query text, etc.)
        so the log shows *what* came back, not just the raw first 120 chars.
        """
        try:
            parsed = json.loads(result)
        except Exception:
            s = result.strip().replace("\n", " ")
            return s[:160] + (" ..." if len(s) > 160 else "")
        match parsed:
            case {"error": err}:
                return f"error: {str(err)[:200]}"
            case {"articles": list() as arts}:
                pmids = [str(a.get("pmid", "?")) for a in arts[:5] if isinstance(a, dict)]
                more = "" if len(arts) <= 5 else f", +{len(arts) - 5} more"
                return f"{len(arts)} articles (PMIDs: {', '.join(pmids)}{more})"
            case {"suggestions": list() as sugg}:
                return f"{len(sugg)} suggestions"
            case {"query": str() as q}:
                return f"query: {q[:200]}" + (" ..." if len(q) > 200 else "")
            case {"items": list() as items}:
                return f"{len(items)} items"
            case dict():
                return f"keys: {', '.join(list(parsed.keys())[:6])}"
            case list():
                return f"list of {len(parsed)} items"
            case _:
                s = str(parsed)
                return s[:160] + (" ..." if len(s) > 160 else "")


TOOLS = ToolCatalog(TOOL_CATALOG)


PY;
    }

    /**
     * SkillRuntime and its module instance SKILLS: folder-backed skills run as CPython
     * subprocesses (dependency install, bucketed /outputs and /scratch dirs, virtual-path
     * remap, input staging, output readback), the run_skill_script tools, and a skill run
     * as a mandatory node step (run_step).
     *
     * LangGraph's own copy of PythonEmitHelpers::skillDepsBlock() + skillFsSyncBlock() and
     * of the LangChain tail of what was LangGraphGenerator::toolBuilderBlock()
     * (RUN_SKILL_SCRIPT_TOOL, _make_skill_tool, _run_skill_step), restructured into a
     * class. The PythonEmitHelpers blocks stay as they are for ADK, MAF and NOOA.
     */
    public static function skillRuntimeBlock(bool $packaged = false): string
    {
        $block = <<<'PY'
# ---------------------------------------------------------------------------
# Local run_skill_script — execute a folder-backed skill's Python script as a
# subprocess. Skills are real CPython (the browser runs them in Pyodide; here
# we shell out). Registered into the catalog at startup so skill-bound agents
# actually run their skill instead of fabricating output.
# ---------------------------------------------------------------------------
SKILLS_DIR = os.environ.get(
    "SYNERGYAI_SKILLS_DIR",
    os.path.join(os.path.expanduser("~"), "Documents", "synergyAI", "skills"),
)


# Skill filesystem (mirrors the browser interpreter + ADK): real bucketed /outputs and
# /scratch dirs, virtual-path remap, env exposure, and a deliverable stash so a skill's
# produced file (not the model's chatter) can become the node output.
class SkillRuntime:
    """Runs folder-backed skills the way the browser does, but as real CPython subprocesses.

    Owns the skill folders, the /outputs and /scratch dirs a skill writes into, the
    dependencies already installed, and the stash of files a skill produced, so that a
    skill run as a node step can hand its produced document on as the node's output.
    """

    def __init__(self, skills_dir: str, outputs_root: str, scratch_dir: str):
        self.skills_dir = skills_dir
        self.outputs_root = outputs_root
        self.scratch_dir = scratch_dir
        # Skills declare their PyPI deps in SKILL.md frontmatter
        # (e.g. `dependencies: [beautifulsoup4]`). The browser installs them via
        # micropip; here we pip-install missing ones into the runner venv on first
        # use. Cached + lock-guarded because parallel branches call skills at once.
        self._installed_deps = set()
        self._deps_lock = threading.Lock()
        self._last_outputs = {}   # dir_name -> contents of the files its last run produced

    def ensure_deps(self, skill_dir: str) -> None:
        """pip-install the dependencies a skill's SKILL.md frontmatter declares, once per process."""
        md = os.path.join(skill_dir, "SKILL.md")
        if not os.path.isfile(md):
            return
        deps = []
        try:
            lines = open(md, encoding="utf-8").read().splitlines()
        except Exception:
            return
        # Only the YAML frontmatter (between leading '---' fences) is authoritative;
        # a 'dependencies:' line in the prose body is not a real declaration.
        if not lines or lines[0].strip() != "---":
            return
        for line in lines[1:]:
            s = line.strip()
            if s == "---":
                break
            if s.lower().startswith("dependencies:"):
                val = s.split(":", 1)[1].strip().strip("[]")
                deps = [d.strip().strip("'").strip('"') for d in val.split(",") if d.strip()]
                break
        with self._deps_lock:
            for d in deps:
                if d in self._installed_deps:
                    continue
                self._installed_deps.add(d)
                try:
                    node_print(f"  [run_skill_script] ensuring dependency: {d}")
                    r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", d],
                                       capture_output=True, text=True, timeout=600)
                    if r.returncode != 0:
                        node_print(f"  [run_skill_script] pip install {d} FAILED: "
                                   f"{(r.stderr or '')[-300:]}")
                except Exception as e:
                    node_print(f"  [run_skill_script] pip install {d} error: {e}")

    def output_dir(self, dir_name: str) -> str:
        """The real /outputs dir of a skill: <outputs root>/<group> for a grouped skill ('GEO/x'), else the root."""
        group = dir_name.split("/")[0] if "/" in dir_name else ""
        if group and all(c.isalnum() or c in "._-" for c in group):
            return os.path.join(self.outputs_root, group)
        return self.outputs_root

    def remap_path(self, p, out_dir: str) -> str:
        """A virtual /outputs/... or /scratch/... path as the real path; any other path unchanged."""
        p = str(p)
        for virt, real in (("/outputs", out_dir), ("/scratch", self.scratch_dir)):
            if p == virt:
                return real
            if p.startswith(virt + "/"):
                return os.path.join(real, p[len(virt) + 1:])
        return p

    @staticmethod
    def fix_overescaped(text):
        """Repair JSON-style over-escaping in model-carried document content.

        Models (Claude especially) sometimes emit large documents inside tool
        arguments as an escaped single-line string: literal \\n / \\" sequences
        and ZERO real newlines. Written verbatim, the HTML/CSS is broken and the
        page renders unstyled (a live report shipped with 1131 literal \\n).
        Mirrors the platform chat's _coerceInputFiles over-escape recovery.
        Detection is conservative: many escape sequences AND no real newlines."""
        s = str(text)
        if s.count("\\n") > 5 and s.count("\n") == 0:
            print("  [stage] repairing over-escaped content ("
                  + str(s.count("\\n")) + " literal escape sequences)", flush=True)
            s = (s.replace("\\\\", "\x00").replace("\\n", "\n").replace("\\t", "\t")
                  .replace("\\r", "").replace('\\"', '"').replace("\\'", "'").replace("\x00", "\\"))
        return s

    def run_script(self, dir_name: str, script: str, argv=None,
                   input_files=None, read_outputs=None) -> str:
        """run_skill_script: run one script of a skill and return its stdout (plus the files read back).

        Stages input_files, executes the script with the virtual paths in argv remapped,
        then reads back read_outputs and stashes them for run_step. Errors come back as
        text for the model, never as exceptions.
        """
        if isinstance(argv, str):
            try:
                argv = json.loads(argv)
            except Exception:
                argv = [argv]
        argv = list(argv) if argv else []
        skill_dir = os.path.join(self.skills_dir, *str(dir_name).split("/"))
        script_path = os.path.join(skill_dir, *str(script).split("/"))
        if not os.path.isfile(script_path):
            return f"ERROR: skill script not found: {dir_name}/{script} (looked in {script_path})"
        self.ensure_deps(skill_dir)
        out_dir = self.output_dir(dir_name)
        os.makedirs(out_dir, exist_ok=True)
        os.makedirs(self.scratch_dir, exist_ok=True)
        # Remap the interpreter's virtual /outputs & /scratch in argv to real dirs.
        argv = [self.remap_path(a, out_dir) for a in argv]
        # Stage input_files (e.g. HTML the skill will render) at their remapped paths.
        self._stage_inputs(input_files, out_dir)
        try:
            out = self._exec(dir_name, script, skill_dir, script_path, argv, out_dir)
        except subprocess.TimeoutExpired:
            node_print(f"  [run_skill_script] ← {dir_name}/{script}: TIMEOUT after 300s")
            return f"ERROR: skill {dir_name}/{script} timed out after 300s"
        # Read back requested outputs AND stash them so the skill step can use the produced
        # document as the node output.
        out += self._read_outputs(dir_name, read_outputs, out_dir)
        return out or "(skill produced no stdout)"

    def _stage_inputs(self, input_files, out_dir: str) -> None:
        """Write each input_files entry (path -> content) at its remapped path; a failure is logged, not raised."""
        if isinstance(input_files, dict):
            for raw_path, content in input_files.items():
                try:
                    target = self.remap_path(raw_path, out_dir)
                    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
                    with open(target, "w", encoding="utf-8") as fh:
                        fh.write(self.fix_overescaped(content))
                except Exception as e:
                    node_print(f"  [run_skill_script] could not stage {raw_path}: {e}")

    def _exec(self, dir_name: str, script: str, skill_dir: str, script_path: str, argv: list, out_dir: str) -> str:
        """Run the script in its skill dir with the SYNERGYAI_* env; stdout, plus the exit code and
        stderr tail when it failed. Raises subprocess.TimeoutExpired after 300s."""
        env = dict(
            os.environ,
            SYNERGYAI_OUTPUT_DIR=out_dir,
            SYNERGYAI_SCRATCH_DIR=self.scratch_dir,
            SYNERGYAI_SKILL_DIR_NAME=dir_name,
            SYNERGYAI_SKILL_GROUP=(dir_name.split("/")[0] if "/" in dir_name else ""),
        )
        cmd = [sys.executable, script_path] + [str(a) for a in argv]
        node_print(f"  [run_skill_script] → {dir_name}/{script} argv={argv}")
        _t0 = time.monotonic()
        proc = subprocess.run(cmd, cwd=skill_dir, env=env, capture_output=True,
                              text=True, timeout=300)
        _dt = time.monotonic() - _t0
        out = proc.stdout or ""
        _stderr = (proc.stderr or "").strip()
        _head = out.replace(chr(10), " ")[:160]
        node_print(f"  [run_skill_script] ← {dir_name}/{script}: exit={proc.returncode}, "
                   f"{len(out)} chars stdout, {_dt:.1f}s | {_head}")
        if proc.returncode != 0 and _stderr:
            node_print(f"  [run_skill_script]   stderr tail: {_stderr[-400:]}")
        if proc.returncode != 0:
            out = (out + f"\n[run_skill_script exit {proc.returncode}]\n"
                   + _stderr[-2000:]).strip()
        return out

    def _read_outputs(self, dir_name: str, read_outputs, out_dir: str) -> str:
        """The read_outputs files as text to append to stdout; their contents are stashed for run_step.
        A file that cannot be read is skipped."""
        text = ""
        _produced = []
        if isinstance(read_outputs, list):
            for rel in read_outputs:
                try:
                    with open(self.remap_path(rel, out_dir), "r", encoding="utf-8") as fh:
                        _content = fh.read()
                    text += f"\n\n[output file {rel}]\n" + _content
                    _produced.append(_content)
                except Exception:
                    pass
        if _produced:
            self._last_outputs[dir_name] = _produced
        return text

    def read_skill_md(self, dir_name: str) -> str:
        """The live SKILL.md body (progressive disclosure); frontmatter stripped."""
        path = os.path.join(self.skills_dir, *str(dir_name).split("/"), "SKILL.md")
        try:
            with open(path, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            return f"(SKILL.md not found for skill '{dir_name}')"
        if text.startswith("---"):
            end = text.find("\n---\n", 3)
            if end != -1:
                nl = text.find("\n", end + 1)
                text = text[nl + 1:] if nl != -1 else ""
        return text.strip()

    @cached_property
    def tool(self) -> StructuredTool:
        """run_skill_script for ANY skill dir: the model names dir_name, script and argv (a catalog tool)."""
        return StructuredTool.from_function(
            func=self.run_script,
            name="run_skill_script",
            description=("Execute a folder-backed skill's Python script and return its "
                         "stdout. Pass the dir_name/script/argv the skill instructions "
                         "specify, e.g. dir_name='GEO/geo-llmstxt', "
                         "script='scripts/llmstxt_signals.py', argv=['https://example.com']."),
            args_schema=create_model(
                "RunSkillScriptArgs",
                dir_name=(str, ...),
                script=(str, ...),
                # list[str] (not bare list) so the generated JSON schema carries
                # `items`. Gemini rejects array params without `items` (400
                # INVALID_ARGUMENT); list[str] is valid for every provider. Leave
                # input_files as a bare dict — Gemini accepted that, and dict[str,str]
                # would add additionalProperties which Gemini may reject.
                argv=(list[str], []),
                input_files=(dict, {}),
                read_outputs=(list[str], []),
            ),
        )

    def scoped_tool(self, dir_name: str) -> StructuredTool:
        """run_skill_script scoped to ONE skill dir: the model picks only the script + argv
        (and input_files/read_outputs); the dir is fixed to this skill."""
        def run_skill_script(script: str, argv=None, input_files=None, read_outputs=None) -> str:
            return self.run_script(dir_name, script, argv, input_files, read_outputs)
        return StructuredTool.from_function(
            func=run_skill_script, name="run_skill_script",
            description=(f"Run a script in the '{dir_name}' skill (dir fixed). Stage authored "
                         "content via input_files and pass the output path in read_outputs."),
            args_schema=create_model(
                "ScopedSkillArgs",
                script=(str, ...), argv=(list[str], []),
                input_files=(dict, {}), read_outputs=(list[str], []),
            ),
        )

    async def run_step(self, skill: dict, prior: str, llm) -> str:
        """Run ONE skill as a mandatory step on `prior` (the previous stage's output). A
        dir-backed skill = an LLM turn instructed by SKILL.md with run_skill_script scoped to
        the dir; the step output becomes the skill's produced deliverable file (via
        read_outputs) when it wrote one, else the LLM's text. Inline skill = an LLM transform."""
        dir_name = skill.get("dir", "")
        body = skill.get("inline") or (self.read_skill_md(dir_name) if dir_name else "")
        system = (
            "You are running the '" + (dir_name or "inline") + "' skill as a MANDATORY step in "
            "a compiled workflow. Follow the skill instructions below and APPLY THE SKILL to the "
            "INPUT. If the skill produces a document/file (e.g. an HTML report via a create/"
            "render script), you MUST call run_skill_script -- stage your authored content via "
            "input_files and pass the output path in read_outputs; the workflow captures that "
            "produced file as this node's output. If the skill has no script, return the "
            "transformed result as your response.\n\n=== SKILL INSTRUCTIONS ===\n" + body
        )
        tools = [self.scoped_tool(dir_name)] if dir_name else []
        if dir_name:
            self._last_outputs.pop(dir_name, None)
        agent = create_react_agent(llm, tools)
        msgs = [SystemMessage(content=system),
                HumanMessage(content="## INPUT (apply the skill to this)\n" + str(prior))]
        result = await agent.ainvoke({"messages": msgs})
        final = result["messages"][-1]
        text = final.content if isinstance(final, AIMessage) else str(final)
        if isinstance(text, list):
            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
        produced = self._last_outputs.pop(dir_name, None) if dir_name else None
        return produced[-1] if produced else text


SKILLS = SkillRuntime(
    skills_dir=SKILLS_DIR,
    outputs_root=os.environ.get("SYNERGYAI_OUTPUT_ROOT") or os.path.join(os.path.dirname(SKILLS_DIR), "outputs"),
    scratch_dir=os.environ.get("SYNERGYAI_SCRATCH_DIR") or os.path.join(os.path.dirname(SKILLS_DIR), "scratch"),
)

PY;
        if (!$packaged) {
            return $block;
        }
        // The modular package: skills/, outputs/ and scratch/ are folders of the package (spec 2026-10-15 §5).
        $out = str_replace([
            "SKILLS_DIR = os.environ.get(\n    \"SYNERGYAI_SKILLS_DIR\",\n    os.path.join(os.path.expanduser(\"~\"), \"Documents\", \"synergyAI\", \"skills\"),\n)\n",
            'os.path.join(os.path.dirname(SKILLS_DIR), "outputs")',
            'os.path.join(os.path.dirname(SKILLS_DIR), "scratch")',
        ], [
            "SKILLS_DIR = os.environ.get(\"SYNERGYAI_SKILLS_DIR\") or os.path.join(PACKAGE_DIR, \"skills\")   # the package's own skills/\n",
            'os.path.join(PACKAGE_DIR, "outputs")',
            'os.path.join(PACKAGE_DIR, "scratch")',
        ], $block, $n);
        if ($n !== 3) {
            throw new \LogicException('skillRuntimeBlock: the packaged defaults no longer match the block');
        }
        return $out;
    }

    /**
     * RunEvents and its module instance EVENTS: how a run's events reach a watching host
     * (api.py installs a sink) and the rendezvous where a human gate waits for its answer.
     * With no sink installed it is inert, so a console run prints its trace lines and nothing
     * else changes.
     *
     * LangGraph's own copy of PythonEmitHelpers::eventSinkBlock() (_SINK, _GATES, _GATES_LOCK,
     * set_event_sink, emit_event, open_gate, resolve_gate, take_gate_answer), restructured into
     * a class. Every LangGraph file that runs a node or a graph emits it (the single file,
     * common.py, the A2A orchestrator and every A2A agent file), so no caller ever probes for
     * it with globals() or NameError. PythonEmitHelpers::eventSinkBlock() stays as it is for
     * ADK, MAF and NOOA.
     *
     * The block ends with the aliases api.py (emitted by the shared RunServerEmitter) and the
     * run-server probes import: set_event_sink, emit_event, resolve_gate.
     */
    public static function runEventsBlock(): string
    {
        return <<<'PY'
# ==============================================================
# EVENT SINK + GATE RENDEZVOUS
# Inert until a host installs a sink (see api.py). With no sink the
# generated code prints its trace lines and nothing else changes.
# ==============================================================
class RunEvents:
    """The run's event stream and its human-gate rendezvous.

    A host watching the run (api.py) installs a sink with set_sink() and receives every
    protocol event emit() publishes. A playbook gate registers itself with open_gate(),
    blocks on the returned Event, and collects what resolve_gate() delivered with
    take_answer(). One instance (EVENTS) serves the whole process.
    """

    def __init__(self):
        self._sink = None            # callable(dict) -> None, or None
        self._gates = {}             # tool_call_id -> {"event": threading.Event, "answer": dict | None}
        self._lock = threading.Lock()

    @property
    def active(self) -> bool:
        """Is a run host watching this run?

        True once a host (api.py) has installed a sink. Read on every call, never copied,
        because set_sink() replaces the sink after import.
        """
        return self._sink is not None

    def set_sink(self, fn: Callable | None) -> Callable | None:
        """Install (or clear with None) the run-event sink. Returns the previous one."""
        prev, self._sink = self._sink, fn
        return prev

    def emit(self, **ev) -> None:
        """Publish one protocol event. A no-op when no sink is installed."""
        sink = self._sink
        if sink is not None:
            sink(dict(ev))

    def open_gate(self, tool_call_id: str) -> threading.Event:
        """Register a pending gate and return the Event the waiter blocks on."""
        with self._lock:
            slot = {"event": threading.Event(), "answer": None}
            self._gates[tool_call_id] = slot
        return slot["event"]

    def resolve_gate(self, tool_call_id: str, answer: dict) -> bool:
        """Deliver a human answer to a waiting gate. False when no gate is waiting."""
        with self._lock:
            slot = self._gates.get(tool_call_id)
        if slot is None:
            return False
        slot["answer"] = dict(answer or {})
        slot["event"].set()
        return True

    def take_answer(self, tool_call_id: str) -> dict | None:
        """Pop a resolved gate's answer (None when unanswered), clearing the slot."""
        with self._lock:
            slot = self._gates.pop(tool_call_id, None)
        return slot["answer"] if slot else None


EVENTS = RunEvents()


NODE_OUT: Callable[[str], None] | None = None   # RUN_OUT where this file has one (set after RUN_OUT is made)


def node_print(line: str) -> None:
    """A node runtime line ([tool], [run_skill_script], a dispatcher's route): through RUN_OUT where
    this file has it -- a --cron / --watch run then holds it with its other progress lines, a --once
    --quiet run drops it -- else printed (an A2A agent process)."""
    if NODE_OUT is not None:
        NODE_OUT(line)
    else:
        print(line, flush=True)


# The names api.py (the shared run server) and the run-server test probes import.
set_event_sink = EVENTS.set_sink
emit_event = EVENTS.emit
resolve_gate = EVENTS.resolve_gate

PY;
    }

    /**
     * The playbook interpreter: its constants, PlaybookRun (one node run's timeline, status,
     * write ledger, human gates and Markdown transcript) and PlaybookToolset (the whitelisted
     * tool surface the model calls). PlaybookNode (nodeClassesBlock) runs them. Twin of the
     * PHP interpreter stack (PlaybookInterpreter + PlaybookActionSpace + PlaybookNativeTools +
     * GateManager + PlaybookNodeRunner::renderTranscript). Emitted only when the workflow has
     * a playbook node (an A2A agent file: only when its node is one).
     *
     * LangGraph's own copy of PlaybookEmit::runtimeBlock() (_PlaybookRun, _pb_sink_active,
     * _playbook_gate, _playbook_gate_policy, build_playbook_tools, render_playbook_transcript),
     * restructured into classes. It reports through EVENTS (runEventsBlock) and calls bound
     * #Actions through MCP.call_tool, so it no longer probes for either. An A2A agent server
     * forwards gates to its client by setting GATE_BRIDGE. PlaybookEmit::runtimeBlock() stays
     * as it is for ADK, MAF and NOOA.
     */
    public static function playbookBlock(): string
    {
        return <<<'PY'
# ---------------------------------------------------------------------------
# PLAYBOOK RUNTIME
#
# The LLM re-decides each round from the running transcript of tool calls
# (no pre-computed action queue). Tools it sees: the native verbs, the human
# gates, one tool per bound #Action (MCP, write-policed) and a stub per
# unbound #Action. The node output is the same Markdown transcript the app's
# run overlay shows, so downstream nodes get the story either way.
# ---------------------------------------------------------------------------
PLAYBOOK_MAX_ROUNDS = 40

PLAYBOOK_SYSTEM_PROMPT = """You are a playbook interpreter for {domain}. Execute the PLAYBOOK below
for the current REQUEST, step by step, using ONLY the tools provided.
Rules:
- Never invent tool results, user input, or tools. If information from the requester
  is missing, you must obtain it through the provided tools; if an action has no
  working tool (an "unbound" tool tells you so), follow its guidance instead of guessing.
- Take parameters for later steps from earlier tool results.
- When the playbook says Stop or the work is complete, call resolve_request.
- Record what you did with leave_internal_note before resolving, as the playbook asks.
PLAYBOOK:
{instructions}
POLICY: {policy_json}
REQUESTER: {requester_json}
APPROVERS: {approvers_json}"""

# Fail-closed write classifier: a tool is a WRITE unless its name is recognizably read-only.
_PB_READ_VERB_RE = re.compile(r"^(?:[a-z0-9]+_)?(get|list|search|read|find|describe|verify|check|lookup)(_|$)", re.I)

_PB_GATES = {
    "trigger_form": ("form", "Present a form to the requester and wait for it to be submitted"),
    "request_approval": ("approval", "Ask an approver to approve or deny an action and wait for their decision"),
    "prompt_handoff": ("handoff", "Hand off to a human team or person and wait for their response"),
    "await_message": ("await_message", "Wait for a message from the requester before continuing"),
}
_PB_GATE_FIELDS = {
    "trigger_form": {"prompt": (str, True, "Instructions shown above the form"),
                     "fields": (list[dict], True, "Form fields to collect: [{name, label, type, options?, sensitive?}]")},
    "request_approval": {"approver": (str, True, "Who must approve"), "question": (str, True, "What is being approved"),
                         "context": (str, False, "Supporting context for the decision")},
    "prompt_handoff": {"team_or_person": (str, True, "Who to hand off to"), "reason": (str, True, "Why this needs a human"),
                       "summary": (str, False, "Summary of the situation so far")},
    "await_message": {"prompt": (str, True, "What to wait for")},
}

# None: gates are answered here (a watching host, the console, or PLAYBOOK_GATE_MODE).
# An A2A agent server sets it to forward gates to its client.
GATE_BRIDGE = None


class PlaybookRun:
    """Per-node run record: event timeline (twin of the run overlay), status, write ledger.

    Also where the run's human gates are answered (gate()) and where its timeline becomes
    the node's Markdown output (transcript()).
    """

    def __init__(self, writes_enabled: bool, policy: dict, gate_bridge: Callable | None = None):
        self.events = []
        self.status = "running"
        self.summary = ""   # resolve_request's summary: the run's answer
        self.writes_enabled = writes_enabled
        self.policy = policy
        self.ledger = {}
        self.gate_bridge = gate_bridge   # gate_bridge(run, kind, name, args) answers every gate instead, when set

    def emit(self, **ev) -> None:
        """The run's own timeline AND, when a host is watching, the live stream."""
        self.events.append(ev)
        EVENTS.emit(**ev)

    def gate(self, kind: str, name: str, args: dict) -> dict:
        """Human gate. A host watching this run (api.py) gets the question over the
        event stream and answers it with resolve_gate(). On an interactive terminal
        the question is asked on the console. Otherwise PLAYBOOK_GATE_MODE decides:
        auto (default) approves approvals and acknowledges handoffs, deny denies,
        prompt forces the console. PLAYBOOK_GATE_MODE always wins.

        A run given a gate_bridge (an A2A agent server's) hands every gate to it instead."""
        if self.gate_bridge is not None:
            return self.gate_bridge(self, kind, name, args)
        mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or (
            "server" if EVENTS.active
            else "prompt" if sys.stdin.isatty()
            else "auto")
        what = args.get("question") or args.get("prompt") or args.get("reason") or ""
        if mode == "server":
            # NOTE: run.emit() already tees a gate_request into the stream, but
            # without the tool_call_id the answer must come back on, so the server
            # mode emits its own and skips the bare one.
            tool_call_id = uuid.uuid4().hex
            waiter = EVENTS.open_gate(tool_call_id)
            self.events.append({"type": "gate_request", "kind": kind, "payload": dict(args)})
            EVENTS.emit(type="gate_request", kind=kind, payload=dict(args), tool_call_id=tool_call_id)
            waiter.wait(float(os.environ.get("PLAYBOOK_GATE_TIMEOUT_S", "900")))
            answer = EVENTS.take_answer(tool_call_id)
            if answer is not None:
                return {"ok": True, "decision": answer}
            # Nobody attached, or nobody answered in time: same result as a
            # non-interactive run, recorded so the transcript says who decided.
            # PlaybookToolset._wrap() emits the single tool_result for this call, same as
            # every other mode -- do not emit one here too.
            return self.policy_answer(kind, "no answer within PLAYBOOK_GATE_TIMEOUT_S")
        self.emit(type="gate_request", kind=kind, payload=dict(args))
        match mode:
            case "prompt":
                print(f"\n✋ [{kind}] {what}", flush=True)
                if kind == "approval":
                    ans = input("approve/deny [comment]: ").strip()
                    decision = "denied" if ans.lower().startswith("d") else "approved"
                    comment = ans.split(" ", 1)[1] if " " in ans else ""
                    return {"ok": True, "decision": {"decision": decision, "comment": comment, "actor": "console"}}
                ans = input("your answer: ").strip()
                return {"ok": True, "decision": {"decision": "answered", "comment": ans, "actor": "console"}}
            case "deny":
                return self.policy_answer(kind, "denied by PLAYBOOK_GATE_MODE=deny", deny=True)
            case _:
                return self.policy_answer(kind, "non-interactive run")

    @staticmethod
    def policy_answer(kind: str, why: str, deny: bool = False) -> dict:
        """The answer a policy gives when no human is available. One definition so
        the auto, deny and timed-out-server paths cannot drift apart."""
        if deny:
            return {"ok": True, "decision": {"decision": "denied", "comment": why, "actor": "policy"}}
        if kind == "approval":
            return {"ok": True, "decision": {"decision": "approved", "comment": f"auto-approved ({why})", "actor": "policy"}}
        if kind == "handoff":
            return {"ok": True, "decision": {"decision": "acknowledged", "comment": f"handed off; no human available ({why})", "actor": "policy"}}
        return {"ok": False, "timeout": True,
                "guidance": "No human is available in this non-interactive run. Continue with what you already know "
                            "and note the gap with leave_internal_note."}

    def transcript(self, title: str, final: str) -> str:
        """Markdown transcript, twin of PlaybookNodeRunner::renderTranscript() (PHP)."""
        gate_titles = {"approval": "Approval requested", "form": "Form request", "handoff": "Handed off to a human",
                       "await_message": "Waiting for the requester", "wait": "Waiting"}
        gate_tools = {"request_approval", "trigger_form", "prompt_handoff", "await_message", "wait_until"}
        lines, pending = [], {}

        def s(v):
            if isinstance(v, str):
                return v.strip()
            return "" if v is None else json.dumps(v, ensure_ascii=False)

        for ev in self.events:
            t = ev.get("type")
            match t:
                case "tool_call":
                    name = ev.get("name", "tool")
                    if name in gate_tools:
                        continue
                    lines.append(f"- 🔧 {name} …")
                    pending[name] = len(lines) - 1
                case "tool_result":
                    name = ev.get("name", "tool")
                    res = ev.get("result") if isinstance(ev.get("result"), dict) else {}
                    if name in gate_tools:
                        d = res.get("decision", res.get("status", ""))
                        if isinstance(d, dict):
                            res = {**d, **res}
                            d = d.get("decision", d.get("status", d.get("outcome", "answered")))
                        decision, comment = s(d), s(res.get("comment", ""))
                        if decision:
                            lines.append(f"  → {decision}" + (f" ({comment})" if comment else ""))
                        continue
                    ok = res.get("ok", True) is not False
                    mark = "✓" if ok else "✗"
                    suffix = (" — " + s(res.get("error"))) if (not ok and res.get("error")) else ""
                    if name in pending:
                        lines[pending.pop(name)] = f"- 🔧 {name} {mark}{suffix}"
                    else:
                        lines.append(f"- 🔧 {name} {mark}")
                case "message":
                    text = "(message redacted)" if ev.get("sensitive") else s(ev.get("text", ""))
                    if text:
                        lines.append("- 💬 Playbook:\n" + "\n".join("  " + l for l in text.split("\n")))
                case "gate_request":
                    kind = ev.get("kind", "gate")
                    p = ev.get("payload") or {}
                    what = s(p.get("question") or p.get("prompt")
                             or (s(p.get("team_or_person", "")) + (" — " + s(p.get("reason")) if p.get("reason") else "")))
                    lines.append("- ✋ " + gate_titles.get(kind, kind.capitalize()) + (f": {what}" if what else ""))
        out = f"# Playbook: {title} ({self.status})\n\n## Timeline\n" + ("\n".join(lines) if lines else "- (no steps recorded)")
        if final.strip():
            out += "\n\n## Result\n" + final.strip()
        return out + f"\n\n[playbook run: {self.status}]"


class PlaybookToolset:
    """The whitelisted tool surface for one playbook run (twin of PlaybookActionSpace).

    build() returns every tool the model may call. Each one goes through _wrap(), which
    logs the call and records it, and its result, on the run's timeline.
    """

    def __init__(self, pb: dict, run: PlaybookRun):
        self.pb = pb
        self.run = run

    def build(self) -> list[StructuredTool]:
        """The run's tools, in the order the model sees them: native verbs, human gates, #Actions."""
        tools = []
        tools += self._native_tools()
        # Human gates.
        tools += self._gate_tools()
        # Bound MCP actions (write-policed) and unbound stubs.
        tools += [self._action_tool(act) for act in self.pb.get("actions", [])]
        return tools

    @staticmethod
    def _model(name: str, fields: dict):
        """The pydantic model `<name>Args` for a field table {field: (type, required, description)}."""
        return create_model(name + "Args", **{p: (t, Field(... if req else None, description=d))
                                              for p, (t, req, d) in fields.items()})

    def _wrap(self, name, fn, description, args_model) -> StructuredTool:
        """One tool: prints the call and its result, and records both on the run's timeline."""
        run = self.run

        def invoke(**kwargs):
            run.emit(type="tool_call", name=name, args=kwargs)
            preview = json.dumps(kwargs, default=str, ensure_ascii=False)
            print(f"  [playbook] -> {name}({preview[:200]}{'...' if len(preview) > 200 else ''})", flush=True)
            result = fn(**kwargs)
            run.emit(type="tool_result", name=name, result=result)
            ok = result.get("ok", True) is not False
            detail = str(result.get("error") or result.get("guidance") or result.get("decision") or "")
            print(f"  [playbook] <- {name}: {'✓' if ok else '✗'} {detail[:160]}", flush=True)
            return json.dumps(result, default=str, ensure_ascii=False)
        return StructuredTool.from_function(func=invoke, name=name, description=description, args_schema=args_model)

    def _native_tools(self) -> list:
        """Native verbs: always available, no binding needed."""
        run = self.run
        tools = []

        def message(**a):
            run.emit(type="message", text=str(a.get("text", "")), sensitive=bool(a.get("sensitive", False)))
            return {"ok": True}
        tools.append(self._wrap("send_direct_message", message, "Send a direct message to the requester",
                                self._model("SendDirectMessage", {"text": (str, True, "Message text"),
                                                                  "sensitive": (bool, False, "Mark as sensitive for redaction")})))
        tools.append(self._wrap("send_channel_message", message, "Post a message in a channel",
                                self._model("SendChannelMessage", {"channel": (str, True, "Channel name"), "text": (str, True, "Message text")})))
        tools.append(self._wrap("send_email", message, "Send an email",
                                self._model("SendEmail", {"to": (str, True, "Email recipient"), "subject": (str, True, "Email subject"),
                                                          "text": (str, True, "Email body")})))

        def note(**a):
            run.emit(type="note", text=str(a.get("text", "")))
            return {"ok": True}
        tools.append(self._wrap("leave_internal_note", note, "Leave an internal note on the request record",
                                self._model("LeaveInternalNote", {"text": (str, True, "Note text")})))

        def priority(**a):
            run.emit(type="note", text=f"priority → {a.get('priority', '')}: {a.get('reason', '')}")
            return {"ok": True}
        tools.append(self._wrap("set_priority", priority, "Set the request priority (escalation)",
                                self._model("SetPriority", {"priority": (str, True, "Priority level"), "reason": (str, True, "Reason for priority")})))

        def resolve(**a):
            run.status = "resolved"
            run.summary = str(a.get("summary") or "").strip()   # the run's answer, not the turn's narration
            return {"ok": True, "terminal": True}
        tools.append(self._wrap("resolve_request", resolve, "Mark the request as resolved",
                                self._model("ResolveRequest", {"outcome": (str, True, "Resolution outcome"), "summary": (str, True, "Resolution summary")})))
        return tools

    def _gate_tools(self) -> list:
        """Human gates: one tool per _PB_GATES entry, answered by PlaybookRun.gate()."""
        tools = []
        for gname, (kind, desc) in _PB_GATES.items():
            def gate_fn(_kind=kind, _name=gname, **a):
                return self.run.gate(_kind, _name, a)
            tools.append(self._wrap(gname, gate_fn, desc, self._model(gname, _PB_GATE_FIELDS[gname])))
        return tools

    def _action_tool(self, act: dict) -> StructuredTool:
        """One #Action: a write-policed MCP call when it is bound, an unbound stub otherwise."""
        match act.get("kind"):
            case "mcp":
                return self._mcp_action_tool(act)
            case _:
                return self._unbound_tool(act)

    def _mcp_action_tool(self, act: dict) -> StructuredTool:
        """A bound #Action: its MCP tool, with the write policy (writes_enabled) and the ledger
        that replays a write already made with the same arguments."""
        run = self.run
        is_write = _PB_READ_VERB_RE.match(act["tool"]) is None

        def mcp_fn(**a):
            key = act["target"] + "|" + json.dumps(a, sort_keys=True, default=str)
            if is_write and key in run.ledger:
                return {"ok": True, "outcome": "replayed", "result": run.ledger[key]}
            if is_write and not run.writes_enabled:
                return {"ok": False, "error": "writes disabled by policy"}
            raw = MCP.call_tool(act["server_url"], act["tool"], a)
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = raw
            error = parsed.get("error") if isinstance(parsed, dict) else None
            if error:
                return {"ok": False, "error": str(error)}
            if is_write:
                run.ledger[key] = parsed
            return {"ok": True, "result": parsed}
        desc = act["action_name"] + (" — " + act["description"] if act.get("description") else "")
        return self._wrap(act["llm_name"], mcp_fn, desc, ToolCatalog.args_model(act["llm_name"], act.get("input_schema") or {}))

    def _unbound_tool(self, act: dict) -> StructuredTool:
        """An unbound #Action: calling it returns the guidance of the on_unbound policy."""
        run = self.run

        def unbound_fn(**a):
            pol = run.policy.get("on_unbound", "handoff")
            match pol:
                case "skip":
                    return {"ok": False, "unbound": True, "skipped": True,
                            "guidance": "This action is unavailable and the policy says skip it: note it in the internal record and continue with the rest of the playbook."}
                case "fail":
                    return {"ok": False, "unbound": True, "fatal": True,
                            "guidance": "This action is unavailable and the policy says fail: leave an internal note and resolve the request as not completed."}
                case _:
                    return {"ok": False, "unbound": True, "policy": pol,
                            "guidance": "This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done."}
        return self._wrap(act["llm_name"], unbound_fn,
                          f"{act['action_name']}: NOT AVAILABLE — calling this applies the on_unbound policy",
                          create_model(act["llm_name"] + "Args"))


PY;
    }
}
