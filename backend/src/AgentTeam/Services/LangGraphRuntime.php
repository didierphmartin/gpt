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
     * (_make_llm, build_tools_from_catalog, Dispatcher, the playbook runtime, ...),
     * which is why a test that patches common._make_llm after import still reaches them.
     */
    public static function nodeClassesBlock(bool $withPlaybook): string
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
        catalog = build_tools_from_catalog()
        catalog["run_skill_script"] = RUN_SKILL_SCRIPT_TOOL   # local (non-MCP) tool, same as the single-file script
        return [catalog[t] for t in self.cfg.get("tool_names", []) if t in catalog]

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
            text = await _run_skill_step(skill, text, self.llm)
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
    """A dispatcher node: routes the request to exactly one child of its menu (Jev or one forced route_to call)."""

    @cached_property
    def dispatcher(self) -> Dispatcher:
        """This node's Dispatcher, built once per process so its JevRouter -- and that router's
        cached SSL context -- is reused by every run of the node instead of rebuilt per request."""
        return Dispatcher(self.cfg)

    async def run(self, request: str, trace) -> dict:
        """Dispatcher: Jev or one forced route_to call (Dispatcher); the chosen child id travels back as "route"."""
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
        """Playbook: the playbook runtime; gates go through whatever _playbook_gate the
        surrounding file installed (console prompts in a modular package, an
        input-required task update in an A2A agent server)."""
        pb = self.cfg
        run = _PlaybookRun(bool(pb.get("writes_enabled")), pb.get("policy") or {})
        tools = build_playbook_tools(pb, run)
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
        transcript = render_playbook_transcript(pb["title"], run.events, text, run.status)
        return {"text": transcript, "route": "", "notes": "", "status": run.status}


PY;
        $factoryHead = <<<'PY'
class NodeKind(str, Enum):
    """The kinds of node make_node() builds; a node entry's "kind" holds one of these values.

    A str mixin, not enum.StrEnum (Python 3.11+; the floor is 3.10). Members compare equal
    to their plain strings, so the node entries stay plain editor data.
    """
    AGENT = "agent"
    DISPATCHER = "dispatcher"
    PLAYBOOK = "playbook"


def make_node(cfg: dict) -> Node:
    """The Node for one frozen node entry, chosen by its kind (agent, dispatcher, playbook)."""
    match cfg["kind"]:
        case NodeKind.AGENT:
            return AgentNode(cfg)
        case NodeKind.DISPATCHER:
            # Dispatcher: Jev or one forced route_to call picks the child; no ReAct loop.
            return DispatcherNode(cfg)

PY;
        $playbookArm = <<<'PY'
        case NodeKind.PLAYBOOK:
            return PlaybookNode(cfg)

PY;
        $factoryTail = <<<'PY'
        case _:
            raise ValueError(f"unknown node kind: {cfg['kind']!r}")

PY;
        return $base . ($withPlaybook ? $playbook : '') . $factoryHead . ($withPlaybook ? $playbookArm : '') . $factoryTail;
    }

    /**
     * Dispatcher node runtime: JevResult and JevRouter (TypeSafe Jev), RoutingMode,
     * RouteDecision and Dispatcher. A dispatcher routes with Jev (routing_mode 'jev', or
     * unset with a key) or with one forced route_to call over the menu (the model), never
     * both. JevRouter.route() is the standard-library twin of JevRouter::route() (same body,
     * same 'unclear' option, same floor, same outcomes); Dispatcher.mode() mirrors
     * GraphWorkflowRunner's mode choice. DispatcherNode.run() is its one caller.
     */
    public static function dispatcherBlock(): string
    {
        return <<<'PY'
# TypeSafe Jev (twin of JevRouter.php). A System One model: it answers a closed
# question with one of the options supplied -- never a value outside them.


@dataclass(frozen=True)
class JevResult:
    """What JevRouter.route() found for one request: an outcome and the evidence behind it.

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


class JevRouter:
    """Asks TypeSafe Jev a closed routing question: the Python twin of JevRouter.php.

    Same request body, same 'unclear' option, same floor and outcomes. route() never raises.
    """
    URL = "https://api.typesafe.ai/v1/systemone"
    MODEL = "jev-latest"
    UNCLEAR = "unclear"   # synthetic option that makes "I cannot tell" sayable; never a real branch
    UNCLEAR_DESC = ("The request does not say enough to choose, or it genuinely spans "
                    "several of the options. Pick this rather than guessing.")
    CONFIDENCE_FLOOR = 0.6   # default minimum confidence (a dispatcher's jev_min_confidence overrides it)
    TIMEOUT_S = 10

    @staticmethod
    def available() -> bool:
        """Configured = a key is present. An unset dispatcher routes with Jev only then, else with the model."""
        return bool(os.environ.get("TYPESAFE_API_KEY") or "")

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

    def route(self, request: str, targets: list[dict], question: str, floor: float = CONFIDENCE_FLOOR) -> JevResult:
        """Choose one target for `request`, or say why not. Returns a JevResult with
        outcome ('routed'|'unclear'|'low_confidence'|'unavailable'|'error'), target,
        confidence, probabilities, ms, usage, reason. Only 'routed' decides; every
        other outcome means the dispatcher does not route (no model fallback).
        `floor` is the dispatcher's minimum
        confidence (settings.jev_min_confidence). Never raises."""
        try:
            return self._route(request, targets, question, floor)
        except Exception as e:   # anything at all -> an 'error' outcome, never a raise
            return JevResult("error", reason=f"{type(e).__name__}: {e}")

    def _route(self, request, targets, question, floor) -> JevResult:
        """route() without its safety net: check the menu, ask Jev, read its answer."""
        import urllib.request
        key = os.environ.get("TYPESAFE_API_KEY") or ""
        if not key:
            return JevResult("unavailable", reason="no TYPESAFE_API_KEY")
        named = {}
        for t in targets:
            name = str(t.get("name") or "").strip()
            if name == "" or name.lower() == self.UNCLEAR:
                # A branch literally named "unclear" would collide with the escape hatch.
                return JevResult("error", reason=f"unusable target name: '{name}'")
            named[name] = t
        if len(named) < 2:
            return JevResult("error", reason="a menu needs at least two targets")
        criteria = {}
        for name, t in named.items():
            desc = str(t.get("description") or "").strip()
            criteria[name] = desc[:400] if desc else name
        criteria[self.UNCLEAR] = self.UNCLEAR_DESC
        body = {
            "state": {"request": request},
            "model": self.MODEL,
            "questions": {"route": {"type": "choice", "instructions": question, "criteria": criteria}},
        }
        req = urllib.request.Request(
            self.URL, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"Authorization": "Bearer " + key, "Accept": "application/json",
                     "Content-Type": "application/json"})
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.TIMEOUT_S, context=self.ssl_context) as resp:   # HTTP 4xx/5xx raise here
                raw = resp.read()
        except Exception as e:
            return JevResult("error", reason=str(e))
        ms = int(round((time.monotonic() - t0) * 1000))
        try:
            decoded = json.loads(raw.decode("utf-8"))
        except ValueError:
            decoded = None
        answers = decoded.get("answers") if isinstance(decoded, dict) else None
        answer = answers.get("route") if isinstance(answers, dict) else None
        if not isinstance(answer, dict) or answer.get("choice") is None:
            return JevResult("error", ms=ms, reason="no choice in the response")
        choice = str(answer["choice"])
        conf = float(answer["confidence"]) if answer.get("confidence") is not None else None
        probs = answer.get("probabilities") if isinstance(answer.get("probabilities"), (dict, list)) else {}
        usage = decoded.get("usage") if isinstance(decoded.get("usage"), dict) else {}
        common = {"confidence": conf, "probabilities": probs, "ms": ms, "usage": usage}
        if choice == self.UNCLEAR:
            return JevResult("unclear", reason="the request names no branch", **common)
        if choice not in named:
            # Unreachable by contract; treated as an error rather than trusted.
            return JevResult("error", reason=f"answer '{choice}' is not on the menu", **common)
        if conf is not None and conf < floor:
            return JevResult("low_confidence", target=named[choice],
                             reason=f"confidence {conf:.2f} below floor {floor:.2f}", **common)
        return JevResult("routed", target=named[choice], **common)


class RoutingMode(str, Enum):
    """How a dispatcher picks its child: Jev only, or the model only -- never both.

    A str mixin, not enum.StrEnum (Python 3.11+; the floor is 3.10), so a saved
    routing_mode string compares equal to its member.
    """
    JEV = "jev"
    LLM = "llm"


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
    """Picks exactly one child for a dispatcher node: through Jev or through one forced route_to call, never both.

    Dispatcher agent (twin of DispatchRouting in the PHP runner): the model
    MUST call route_to with one of the menu names; that child alone runs. The
    child receives the dispatcher's original input plus the notes.
    With no choice the run stops at the dispatcher. It holds the menu, the
    confidence floor and the Jev router -- nothing of the graph.
    """

    def __init__(self, cfg: dict, router: JevRouter | None = None):
        """cfg is the dispatcher's node entry (id, display, dispatch, jev_question, routing_mode,
        jev_min_confidence); router is the Jev client, a real JevRouter unless a test passes one."""
        self.cfg = cfg
        self.display = cfg["display"]
        self.targets = cfg["dispatch"]
        self.names = [t["name"] for t in self.targets]
        self.router = router or JevRouter()
        floor = cfg.get("jev_min_confidence")
        self.floor = JevRouter.CONFIDENCE_FLOOR if floor is None else floor

    def mode(self) -> RoutingMode:
        """The routing mode for this run.

        Routing mode (settings.routing_mode, twin of GraphWorkflowRunner) --
        always exactly one, never both:
          "llm" -> the model only; Jev is never asked.
          "jev" -> Jev only; the model is never called. Any outcome but 'routed'
                   (unclear, low_confidence, no key, error, timeout) = did not
                   route: routes END, so none of the dispatcher's branches runs.
          ""    -> unset (saved before the setting existed): resolved here to
                   "jev" when TYPESAFE_API_KEY is set -- the editor's runner sync
                   writes it only when the user's plan allows Jev, the stand-in
                   for the interpreter's plan check -- else "llm".
        """
        mode = self.cfg.get("routing_mode", "")
        if mode in (RoutingMode.JEV, RoutingMode.LLM):
            return RoutingMode(mode)
        return RoutingMode.JEV if self.router.available() else RoutingMode.LLM

    async def route(self, task: str, msgs: list, make_llm) -> RouteDecision:
        """Route `task` (the dispatcher's input) to one child of the menu.

        msgs is the dispatcher's model turn; make_llm() returns its chat model and is
        read only on the LLM path, so a Jev-only dispatcher needs no model key or package.
        route is "" and status "unrouted" when no child is chosen.
        """
        match self.mode():
            case RoutingMode.JEV:
                return await self._via_jev(task)
            case _:
                return await self._via_llm(task, msgs, make_llm)

    async def _via_jev(self, task: str) -> RouteDecision:
        """Jev only: 'routed' decides; any other outcome stops the run here (no model fallback)."""
        nid = self.cfg["id"]
        try:
            # urlopen's timeout bounds each socket op, not DNS or the total; this does.
            jev = await asyncio.wait_for(
                asyncio.to_thread(self.router.route, task, self.targets, self.cfg.get("jev_question", ""), self.floor), self.router.TIMEOUT_S + 1)
        except Exception as e:   # asyncio.TimeoutError included -> an 'error' outcome (did not route)
            jev = JevResult("error", reason=f"{type(e).__name__}: no answer within {self.router.TIMEOUT_S + 1}s"
                            if isinstance(e, asyncio.TimeoutError) else str(e))
        conf = f"{jev.confidence:.2f}" if jev.confidence is not None else "?"
        if jev.outcome == "routed":
            chosen = jev.target
            # Same shape the model path returns, minus notes: Jev writes no prose.
            print(f"[node] [{nid}] {self.display!r} Jev routed to {chosen['name']!r} "
                  f"(confidence {conf}, {jev.ms}ms, no LLM turn)", flush=True)
            return RouteDecision(text=task, route=chosen["id"], notes="", status="ok")
        # Jev only: no model fallback, so the run stops here and says why
        # (the reason names a missing key, too). Same message as the interpreter.
        msg = (f'Error: dispatcher "{self.display}" did not route the request '
               f'(Jev: {jev.outcome}: {jev.reason}).')
        print(f"[node] [{nid}] ⚠ {self.display!r} Jev did not route ({jev.outcome}: {jev.reason}, "
              f"confidence {conf}) — Jev-only dispatcher, no model fallback", flush=True)
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
            print(f"[node] [{nid}] ⚠ {msg}", flush=True)
            return RouteDecision(text=msg, route="", notes="", status="unrouted")
        print(f"[node] [{nid}] {self.display!r} routed to {chosen['name']!r} ({dt:.1f}s)"
              + (f" -- notes: {notes[:120]!r}" if notes else ""), flush=True)
        text = task + (f"\n\n## Dispatcher notes\n{notes}" if notes else "")
        return RouteDecision(text=text, route=chosen["id"], notes=notes, status="ok")


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


class WorkflowGraph:
    """The workflow as a LangGraph StateGraph built from its frozen EDGES / ORDER / NODE_TYPES.

    Start and Output run here with no LLM; every agent/playbook node goes through `run_node`
    (in this process, in an agent module, or over A2A -- the graph does not care). A dispatcher's
    menu children hang off one conditional edge, so only the chosen child runs.
    """

    def __init__(self, *, edges: list, order: list[str], node_types: dict[str, str], agents: dict[str, dict],
                 run_node: Callable[[str, str], Awaitable[dict]], start_documents: list[dict]):
        """agents maps an agent/playbook node id to its entry (display, kind, dispatch menu);
        run_node(nid, request) runs that node and returns {"text", "route", "notes", "status"}."""
        self.edges, self.order, self.node_types = edges, order, node_types
        self.agents, self.run_node, self.start_documents = agents, run_node, start_documents
        self.started: float | None = None   # time.monotonic() when the run began (RUN SUMMARY)

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
                    try:
                        md = _convert_doc_to_markdown(path)
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
            print(f"[node] [{nid}] start -- {len(text)} chars", flush=True)
            return {"node_outputs": {nid: {"source": "start", "text": text}}}
        return _run

    def _request_for(self, nid: str, state: dict) -> str:
        """What a node receives: a playbook gets its parents' texts joined, an agent the labelled context."""
        outs = state.get("node_outputs", {})
        if self.agents[nid]["kind"] == "playbook":
            return "\n\n".join(outs[p]["text"] for p in self.parents(nid) if p in outs) or state.get("user_prompt", "")
        return build_context(state.get("user_prompt", ""), self.parents(nid), outs)

    def _module_node(self, nid: str):
        """An agent/playbook node: run it, then turn a dispatcher's choice into the conditional edge's input."""
        async def _run(state):
            ad = self.agents[nid]
            out = await self.run_node(nid, self._request_for(nid, state))
            result = {"node_outputs": {nid: {"source": ad["display"], "text": out["text"]}}}
            if ad.get("dispatch"):
                # Dispatcher: the node chose a child (or none) -> conditional edge input;
                # a request it did not route ends the run with its message.
                route = out["route"] if out["route"] in {t["id"] for t in ad["dispatch"]} else END
                if route == END:
                    print(f"[node] [{nid}] ⚠ dispatcher did not route; ending the run", flush=True)
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
            print(f"[node] [{nid}] output -- {len(final)} chars", flush=True)
            return {"final_output": final}
        return _run

    def _router(self, nid: str):
        """The conditional-edge function of dispatcher `nid`: the child it chose, or END."""
        return lambda state: state.get("routes", {}).get(nid) or END

    def _wire_edges(self, sg) -> None:
        """Plain edges forward in ORDER; a dispatcher's menu children only through its conditional edge."""
        # Wire edges. A dispatcher's menu children hang off a conditional edge:
        # only the child named in state["routes"] runs (siblings are skipped).
        pos = {n: i for i, n in enumerate(self.order)}
        sg.add_edge(START, self.order[0])
        for nid in self.order:
            menu = {t["id"] for t in self.agents.get(nid, {}).get("dispatch", [])}
            for child in self.children(nid):
                if child in pos and pos[child] > pos[nid] and child not in menu:
                    sg.add_edge(nid, child)
            if menu:
                sg.add_conditional_edges(nid, self._router(nid), {t: t for t in menu} | {END: END})
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
                case "agent" | "playbook":
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
        graph = self.compile()
        print("[info] Running...", flush=True)
        self.started = time.monotonic()
        result = await graph.ainvoke({"user_prompt": prompt, "node_outputs": {}})
        return result.get("final_output", "")


PY;
    }

    /**
     * save_output() and print_run_summary(): what every mode does once the graph has
     * answered. One rule for the saved file's name and place (the modular package's),
     * and one RUN SUMMARY whose only per-mode part is the timing label.
     */
    public static function outputBlock(): string
    {
        return <<<'PY'
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
    }
}
