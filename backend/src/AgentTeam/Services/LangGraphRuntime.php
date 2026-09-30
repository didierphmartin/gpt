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
     * (_make_llm, build_tools_from_catalog, _run_dispatcher, the playbook runtime, ...),
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
        Returns {"text": str, "route": str|"" , "notes": str, "status": str}.
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
            stem = Path(sys.argv[0]).stem
            dump_path = debug_dir / f"{stem}_{nid}_{ts}.json"
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

    async def run(self, request: str, trace) -> dict:
        """Dispatcher: Jev or one forced route_to call (_run_dispatcher); the chosen child id travels back as "route"."""
        c = self.cfg
        await trace(f"{self.display!r} -- {len(self.tools)} tools (provider={c.get('provider', '?')}, model={c.get('model', '?')})")
        await trace(f"inputs: system={len(c.get('system_prompt') or '')} chars, context={len(request)} chars")
        # Until the Dispatcher class (next commit) the dispatcher runtime still speaks graph state.
        ad = {"display": self.display, "dispatch": c["dispatch"], "jev_question": c.get("jev_question", ""),
              "routing_mode": c.get("routing_mode", ""), "jev_min_confidence": c.get("jev_min_confidence")}
        state = {"node_outputs": {}, "user_prompt": request}
        out = await _run_dispatcher(c["id"], ad, state, self._messages(c.get("system_prompt"), request), self.llm)
        route = out.get("routes", {}).get(c["id"], "")
        text = out["node_outputs"][c["id"]]["text"]
        notes = text.split("## Dispatcher notes\n", 1)[1] if "## Dispatcher notes\n" in text else ""
        return {"text": text, "route": "" if route == END else str(route), "notes": notes, "status": "ok" if route != END else "unrouted"}


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
            # Dispatcher: one forced route_to call picks the child; no ReAct loop.
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
}
