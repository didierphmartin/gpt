<?php

declare(strict_types=1);

namespace AgentTeam\Services;

use RuntimeException;

/**
 * The playbook node, shared by every compile target.
 *
 * A playbook node is not an agent: it is an interpreter loop. The LLM
 * re-decides each round from the running transcript of tool calls, with a live
 * tool surface (the native verbs, the human gates, one tool per bound #Action
 * and a stub per unbound one), and the node's output is the Markdown transcript
 * the app's run overlay shows.
 *
 * That loop is target-independent, so it lives here rather than in one
 * generator: LangGraph, ADK, MAF and NOOA all emit THIS text and call
 * run_playbook_node() from wherever their graph reaches the node. Keeping one
 * copy is the point -- four hand-ported interpreters would be four different
 * answers to "what did the playbook do?", which is exactly what a workflow that
 * must behave identically on four runtimes cannot have.
 *
 * The runtime is written against langchain-core + langgraph (StructuredTool and
 * create_react_agent). The non-LangGraph targets therefore install those two
 * packages for a playbook node -- a deliberate trade: one verified interpreter
 * on every target, rather than three rewrites in three tool idioms drifting
 * apart. Targets emit the extra requirement only when the workflow HAS a
 * playbook node (see each generator's deps line).
 */
final class PlaybookEmit
{
    public static function nodeData(array $node, array $availableById, array $providerDefaults, ?string $userId): array
    {
        $nid = (string) ($node['id'] ?? $node['drawflow_node_id'] ?? ($node['_id'] ?? ''));
        $cfg = is_array($node['config'] ?? null) ? $node['config'] : [];
        $raw = $cfg['playbook'] ?? null;
        if (is_string($raw) && trim($raw) !== '') {
            $doc = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromConsoleText($raw);
        } elseif (is_array($raw)) {
            $doc = \Quantis\AIPortfolioAssistant\Playbook\PlaybookDocument::fromArray($raw);
        } else {
            throw new RuntimeException("Playbook node {$nid} has no playbook text.");
        }
        $writesEnabled = !empty($cfg['writes_enabled']);
        $policy = $doc->policy;
        if ($writesEnabled) {
            $policy['writes_enabled'] = true;
        }
        $analysis = (new \Quantis\AIPortfolioAssistant\Playbook\PlaybookAnalyzer())->analyze($doc, array_keys($availableById), []);
        if (!empty($analysis['errors'])) {
            throw new RuntimeException("Playbook node {$nid} has unresolved bindings: " . implode('; ', $analysis['errors']));
        }
        $actions = [];
        foreach ($analysis['actions'] as $a) {
            $name = (string) ($a['name'] ?? '');
            $kind = (string) ($a['kind'] ?? '');
            $target = $a['target'] ?? null;
            if ($kind === 'native') {
                continue; // native verbs are always exposed by the runtime
            }
            if ($kind === 'bound' && is_string($target) && str_contains($target, '.') && !str_starts_with($target, 'agent.')
                && isset($availableById[$target])) {
                $info = $availableById[$target];
                // llm tool name = PlaybookActionSpace::sanitizeTarget() ("okta.lookup_users" -> "okta__lookup_users")
                $llmName = strtolower((string) preg_replace('/[^a-z0-9_]+/i', '_', str_replace('.', '__', $target)));
                $actions[] = [
                    'llm_name' => $llmName, 'kind' => 'mcp', 'action_name' => $name, 'target' => $target,
                    'server_url' => $info['server_url'], 'tool' => $info['tool'],
                    'description' => $info['description'], 'input_schema' => $info['input_schema'],
                ];
                continue;
            }
            $slug = trim(strtolower((string) preg_replace('/[^a-z0-9]+/i', '_', $name)), '_');
            $actions[] = ['llm_name' => 'unbound__' . $slug, 'kind' => 'unbound', 'action_name' => $name, 'target' => $target];
        }
        $provider = strtolower((string) ($cfg['agent_provider'] ?? $cfg['provider'] ?? $cfg['llm_provider'] ?? ''));
        if ($provider === '') {
            $provider = 'claude';
        }
        $model = (string) ($cfg['model'] ?? '');
        if ($model === '') {
            $model = $providerDefaults[$provider] ?? '';
        }
        $settings = is_array($cfg['settings'] ?? null) ? $cfg['settings'] : [];
        return [
            'display' => (string) ($cfg['name'] ?? $cfg['agent_name'] ?? $doc->title),
            'title' => $doc->title,
            'domain' => $doc->domain,
            'instructions' => $doc->instructions,
            'policy' => $policy,
            'approvers' => $doc->approvers,
            'requester' => ['id' => (string) ($userId ?? '')],
            'provider' => $provider,
            'model' => $model,
            'temperature' => (float) ($settings['temperature'] ?? 0.7),
            'max_tokens' => (int) ($settings['max_tokens'] ?? 4096),
            'thinking' => in_array($settings['thinking'] ?? null, ['on', 'off'], true) ? $settings['thinking'] : null,
            'writes_enabled' => $writesEnabled,
            'actions' => $actions,
        ];
    }

    /**
     * Everything the interpreter needs that a non-LangGraph target does not
     * already emit: the imports, a date-grounding helper, the LangChain model
     * factory, optionally the shared MCP client, and run_playbook_node() -- the
     * one entry point each target's adapter calls.
     *
     * LangGraph does NOT use this: it already has all of it, and calls the
     * interpreter through its own node machinery.
     *
     * @param bool $needsMcpClient true when the caller has not already emitted
     *                             PythonEmitHelpers::mcpClientBlock() (which is
     *                             where _call_mcp_tool comes from).
     */
    /**
     * Doc nodes with playbook nodes described and marked as RUN.
     *
     * WorkflowGraphAnalyzer::docNodesFromAnalyzed() knows nothing about
     * playbooks: they are not in $analyzed['agents'] (they are not agents), so
     * without this overlay a playbook node documents as nameless and, worse,
     * as "NOT RUN BY THIS TARGET" on a target that now runs it. Mirrors what
     * LangGraphGenerator does inline. Falls straight through when the workflow
     * has no playbook node.
     */
    public static function docNodes(array $analyzed): array
    {
        $pbs = (array) ($analyzed['playbooks'] ?? []);
        if ($pbs === []) {
            return WorkflowGraphAnalyzer::docNodesFromAnalyzed($analyzed);
        }
        $agents = (array) ($analyzed['agents'] ?? []);
        $extra  = [];
        foreach ($pbs as $nid => $pd) {
            $nid = (string) $nid;
            $mcp = count(array_filter((array) $pd['actions'], fn($a) => ($a['kind'] ?? '') === 'mcp'));
            $extra[$nid]['playbook'] = [
                'title'   => $pd['title'],
                'writes'  => $pd['writes_enabled'],
                'bound'   => $mcp,
                'unbound' => count((array) $pd['actions']) - $mcp,
            ];
            $agents[$nid] = [
                'name' => $pd['display'], 'provider' => $pd['provider'], 'model' => $pd['model'],
                'temperature' => $pd['temperature'], 'max_tokens' => $pd['max_tokens'],
                'thinking' => $pd['thinking'], 'tools' => [], 'skills' => [],
            ];
        }
        return WorkflowGraphAnalyzer::docNodes(
            (array) ($analyzed['byId'] ?? []),
            (array) ($analyzed['order'] ?? array_keys((array) ($analyzed['byId'] ?? []))),
            (array) ($analyzed['edges'] ?? []),
            $agents,
            $extra,
            ['start', 'agent', 'agent-template', 'playbook', 'output']
        );
    }

    /** Extra pip requirements a playbook node adds to a non-LangGraph target. */
    public static function extraDeps(array $analyzed): array
    {
        if (empty($analyzed['playbooks'])) {
            return [];
        }
        $provs = [];
        foreach ((array) $analyzed['playbooks'] as $pd) {
            $p = strtolower((string) ($pd['provider'] ?? 'claude'));
            $provs[['anthropic' => 'claude', 'google' => 'gemini'][$p] ?? $p] = true;
        }
        $pkg = ['claude' => 'langchain-anthropic', 'gemini' => 'langchain-google-genai'];
        $extra = [];
        foreach (array_keys($provs) as $p) {
            // Everything else in the factory is an OpenAI-compatible endpoint.
            $extra[$pkg[$p] ?? 'langchain-openai'] = true;
        }
        // httpx: a bound #Action calls its MCP server through the shared client.
        return ['# A playbook node runs the shared interpreter (langchain + langgraph):',
                'pip install langchain-core langgraph httpx ' . implode(' ', array_keys($extra))];
    }

    public static function supportBlock(bool $needsMcpClient): string
    {
        $parts = [];
        $parts[] = <<<'PY'
# ---------------------------------------------------------------------------
# PLAYBOOK SUPPORT
#
# A playbook node is an interpreter loop, not an agent, and the same loop runs
# on every compile target (see PLAYBOOK RUNTIME below). It is written against
# langchain-core + langgraph, so those two packages are installed for a
# workflow that HAS a playbook node -- one verified interpreter everywhere
# beats one rewrite per framework, silently disagreeing about what the
# playbook did.
# ---------------------------------------------------------------------------
import json
import re
import sys
import uuid

# Read by the model factory below (shared with the LangGraph target, which
# defines this global itself). Without it the first playbook LLM call dies with
# NameError -- the factory is reused verbatim, so its globals come with it.
MODEL_NAME_OVERRIDE = os.environ.get('MODEL_NAME', '').strip()

from pydantic import Field, create_model
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool
from langgraph.prebuilt import create_react_agent


# The run host, when there is one. In a compiled PACKAGE the run server
# (api.py) installs its event sink into common.py's globals -- NOT into this
# module -- so without this the interpreter's gate names are simply undefined,
# every gate falls back to the non-interactive policy, and a form that should
# have been answered in the browser times out instead. Bound dynamically
# (`import common`, not `from common import _SINK`): set_event_sink() REBINDS
# that global, so a by-value import would freeze None forever.
try:
    import common as _pb_host
    if not hasattr(_pb_host, "set_event_sink"):
        _pb_host = None          # some unrelated module named common
except Exception:
    _pb_host = None              # single-file target: console / policy gates


if _pb_host is not None:
    def emit_event(**ev):
        """Publish one protocol event through the host's sink."""
        _pb_host.emit_event(**ev)

    def open_gate(tool_call_id: str):
        """Register a pending gate with the host; returns the Event to wait on."""
        return _pb_host.open_gate(tool_call_id)

    def take_gate_answer(tool_call_id: str):
        """Collect the answer the host resolved this gate with, if any."""
        return _pb_host.take_gate_answer(tool_call_id)


def _pb_inject_datetime(text: str) -> str:
    """Ground the interpreter in TODAY. Without it a playbook reasons from the
    model's training era -- dates in approvals and SLAs come out wrong."""
    return ("Current date: " + time.strftime("%Y-%m-%d") + ". Treat this as 'now'.\n\n") + text
PY;
        if ($needsMcpClient) {
            // mcpClientBlock() calls httpx.Client; a target that emits no MCP
            // section of its own has never imported it.
            $parts[] = "import httpx";
            $parts[] = PythonEmitHelpers::mcpClientBlock();
        }
        $parts[] = implode("\n", LangGraphGenerator::llmFactoryLines());
        $parts[] = <<<'PY'
def _pb_request_text(parent_texts, request) -> str:
    """The REQUEST a playbook node interprets: its parents' output, or the
    original user request when it hangs straight off Start."""
    joined = "\n\n".join(t for src, t in parent_texts if t and src != "Start")
    return joined or str(request)


async def run_playbook_node(pb: dict, request_text: str) -> str:
    """Run ONE playbook node; return the Markdown transcript as its output.

    The transcript IS the node output on every target -- downstream nodes get
    the story of what the playbook did, not just its last sentence. Identical
    to the LangGraph target's _run_playbook_kind(), which reads its node from a
    module global instead of an argument.
    """
    run = _PlaybookRun(bool(pb.get("writes_enabled")), pb.get("policy") or {})
    tools = build_playbook_tools(pb, run)
    print(f"[node] [{pb.get('display', 'playbook')}] playbook -- {len(tools)} tools "
          f"(writes={'on' if run.writes_enabled else 'off'})", flush=True)
    system = PLAYBOOK_SYSTEM_PROMPT.format(
        domain=pb.get("domain") or "this organization", instructions=pb["instructions"],
        policy_json=json.dumps(run.policy, ensure_ascii=False),
        requester_json=json.dumps(pb.get("requester") or {}, ensure_ascii=False),
        approvers_json=json.dumps(pb["approvers"], ensure_ascii=False) if pb.get("approvers") else "{}")
    msgs = [SystemMessage(content=_pb_inject_datetime(system)),
            HumanMessage(content="REQUEST:\n" + request_text)]
    agent = create_react_agent(
        _make_llm(pb.get("provider", "claude"), pb.get("model", ""),
                  float(pb.get("temperature", 0.7)), int(pb.get("max_tokens", 4096)),
                  pb.get("thinking")),
        tools)
    text = ""
    try:
        result = await agent.ainvoke({"messages": msgs},
                                     config={"recursion_limit": 2 * PLAYBOOK_MAX_ROUNDS + 1})
        final = result["messages"][-1]
        text = final.content if isinstance(final, AIMessage) else str(final)
        if isinstance(text, list):
            text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
    except Exception as e:
        run.status = "failed"
        run.emit(type="note", text=f"Round budget of {PLAYBOOK_MAX_ROUNDS} exhausted or run failed: {e}")
    return render_playbook_transcript(pb["title"], run.events, text, run.status)
PY;
        return implode("\n\n", $parts);
    }

    /** `PLAYBOOKS = {node id: node data}` -- the frozen editor values, one entry per playbook node. */
    public static function metadataBlock(array $playbooks): string
    {
        return "# Frozen playbook nodes from the editor: the playbook text, its resolved\n"
             . "# #Action bindings (MCP tool per bound action), approvers, write policy and\n"
             . "# the node form's model settings. run_playbook_node() reads this by node id.\n"
             . 'PLAYBOOKS = ' . PythonEmitHelpers::jsonToPython($playbooks, true);
    }

    public static function runtimeBlock(): string
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


class _PlaybookRun:
    """Per-node run record: event timeline (twin of the run overlay), status, write ledger."""
    def __init__(self, writes_enabled: bool, policy: dict):
        self.events = []
        self.status = "running"
        self.writes_enabled = writes_enabled
        self.policy = policy
        self.ledger = {}

    def emit(self, **ev):
        # The run's own timeline AND, when a host is watching, the live stream.
        self.events.append(ev)
        try:
            emit_event(**ev)
        except NameError:
            pass   # single-file/A2A targets without the sink block


def _pb_sink_active() -> bool:
    """Is a run host watching this run?

    Two shapes, one question. LangGraph's package defines the sink in the same
    module as the interpreter; the other targets keep it in common.py and bind
    that module as _pb_host. Checked through the module (never a by-value copy)
    because set_event_sink() rebinds the global after import.
    """
    host = globals().get("_pb_host")
    if host is not None:
        return getattr(host, "_SINK", None) is not None
    try:
        return _SINK is not None
    except NameError:
        return False   # single-file/A2A targets without the sink block


def _playbook_gate(run, kind: str, name: str, args: dict) -> dict:
    """Human gate. A host watching this run (api.py) gets the question over the
    event stream and answers it with resolve_gate(). On an interactive terminal
    the question is asked on the console. Otherwise PLAYBOOK_GATE_MODE decides:
    auto (default) approves approvals and acknowledges handoffs, deny denies,
    prompt forces the console. PLAYBOOK_GATE_MODE always wins."""
    _sink_active = _pb_sink_active()
    mode = os.environ.get("PLAYBOOK_GATE_MODE", "").strip().lower() or (
        "server" if _sink_active
        else "prompt" if sys.stdin.isatty()
        else "auto")
    what = args.get("question") or args.get("prompt") or args.get("reason") or ""
    if mode == "server":
        # NOTE: run.emit() already tees a gate_request into the stream, but
        # without the tool_call_id the answer must come back on, so the server
        # mode emits its own and skips the bare one.
        tool_call_id = uuid.uuid4().hex
        waiter = open_gate(tool_call_id)
        run.events.append({"type": "gate_request", "kind": kind, "payload": dict(args)})
        emit_event(type="gate_request", kind=kind, payload=dict(args), tool_call_id=tool_call_id)
        waiter.wait(float(os.environ.get("PLAYBOOK_GATE_TIMEOUT_S", "900")))
        answer = take_gate_answer(tool_call_id)
        if answer is not None:
            return {"ok": True, "decision": answer}
        # Nobody attached, or nobody answered in time: same result as a
        # non-interactive run, recorded so the transcript says who decided.
        # wrap() emits the single tool_result for this call, same as every
        # other mode -- do not emit one here too.
        return _playbook_gate_policy(kind, "no answer within PLAYBOOK_GATE_TIMEOUT_S")
    run.emit(type="gate_request", kind=kind, payload=dict(args))
    if mode == "prompt":
        print(f"\n✋ [{kind}] {what}", flush=True)
        if kind == "approval":
            ans = input("approve/deny [comment]: ").strip()
            decision = "denied" if ans.lower().startswith("d") else "approved"
            comment = ans.split(" ", 1)[1] if " " in ans else ""
            return {"ok": True, "decision": {"decision": decision, "comment": comment, "actor": "console"}}
        ans = input("your answer: ").strip()
        return {"ok": True, "decision": {"decision": "answered", "comment": ans, "actor": "console"}}
    if mode == "deny":
        return _playbook_gate_policy(kind, "denied by PLAYBOOK_GATE_MODE=deny", deny=True)
    return _playbook_gate_policy(kind, "non-interactive run")


def _playbook_gate_policy(kind: str, why: str, deny: bool = False) -> dict:
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


def build_playbook_tools(pb: dict, run: _PlaybookRun) -> list:
    """The whitelisted tool surface for one playbook run (twin of PlaybookActionSpace)."""
    type_map = {"string": str, "integer": int, "number": float, "boolean": bool, "array": list, "object": dict}
    tools = []

    def model(name, fields):
        return create_model(name + "Args", **{p: (t, Field(... if req else None, description=d))
                                              for p, (t, req, d) in fields.items()})

    def wrap(name, fn, description, args_model):
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

    # Native verbs: always available, no binding needed.
    def message(**a):
        run.emit(type="message", text=str(a.get("text", "")), sensitive=bool(a.get("sensitive", False)))
        return {"ok": True}
    tools.append(wrap("send_direct_message", message, "Send a direct message to the requester",
                      model("SendDirectMessage", {"text": (str, True, "Message text"),
                                                  "sensitive": (bool, False, "Mark as sensitive for redaction")})))
    tools.append(wrap("send_channel_message", message, "Post a message in a channel",
                      model("SendChannelMessage", {"channel": (str, True, "Channel name"), "text": (str, True, "Message text")})))
    tools.append(wrap("send_email", message, "Send an email",
                      model("SendEmail", {"to": (str, True, "Email recipient"), "subject": (str, True, "Email subject"),
                                          "text": (str, True, "Email body")})))

    def note(**a):
        run.emit(type="note", text=str(a.get("text", "")))
        return {"ok": True}
    tools.append(wrap("leave_internal_note", note, "Leave an internal note on the request record",
                      model("LeaveInternalNote", {"text": (str, True, "Note text")})))

    def priority(**a):
        run.emit(type="note", text=f"priority → {a.get('priority', '')}: {a.get('reason', '')}")
        return {"ok": True}
    tools.append(wrap("set_priority", priority, "Set the request priority (escalation)",
                      model("SetPriority", {"priority": (str, True, "Priority level"), "reason": (str, True, "Reason for priority")})))

    def resolve(**a):
        run.status = "resolved"
        return {"ok": True, "terminal": True}
    tools.append(wrap("resolve_request", resolve, "Mark the request as resolved",
                      model("ResolveRequest", {"outcome": (str, True, "Resolution outcome"), "summary": (str, True, "Resolution summary")})))

    # Human gates.
    for gname, (kind, desc) in _PB_GATES.items():
        def gate_fn(_kind=kind, _name=gname, **a):
            return _playbook_gate(run, _kind, _name, a)
        tools.append(wrap(gname, gate_fn, desc, model(gname, _PB_GATE_FIELDS[gname])))

    # Bound MCP actions (write-policed) and unbound stubs.
    for act in pb.get("actions", []):
        if act.get("kind") != "mcp":
            def unbound_fn(**a):
                pol = run.policy.get("on_unbound", "handoff")
                if pol == "skip":
                    return {"ok": False, "unbound": True, "skipped": True,
                            "guidance": "This action is unavailable and the policy says skip it: note it in the internal record and continue with the rest of the playbook."}
                if pol == "fail":
                    return {"ok": False, "unbound": True, "fatal": True,
                            "guidance": "This action is unavailable and the policy says fail: leave an internal note and resolve the request as not completed."}
                return {"ok": False, "unbound": True, "policy": pol,
                        "guidance": "This action has no connected implementation. Follow the policy: hand off to a human with prompt_handoff and note what could not be done."}
            tools.append(wrap(act["llm_name"], unbound_fn,
                              f"{act['action_name']}: NOT AVAILABLE — calling this applies the on_unbound policy",
                              create_model(act["llm_name"] + "Args")))
            continue
        schema = act.get("input_schema") or {}
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        required = set(schema.get("required", []) if isinstance(schema, dict) else [])
        fields = {}
        for pname, pspec in props.items():
            spec = pspec if isinstance(pspec, dict) else {}
            fields[pname] = (type_map.get(spec.get("type", "string"), str), pname in required, spec.get("description", ""))
        is_write = _PB_READ_VERB_RE.match(act["tool"]) is None

        def mcp_fn(_act=act, _write=is_write, **a):
            key = _act["target"] + "|" + json.dumps(a, sort_keys=True, default=str)
            if _write and key in run.ledger:
                return {"ok": True, "outcome": "replayed", "result": run.ledger[key]}
            if _write and not run.writes_enabled:
                return {"ok": False, "error": "writes disabled by policy"}
            raw = _call_mcp_tool(_act["server_url"], _act["tool"], a)
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = raw
            error = parsed.get("error") if isinstance(parsed, dict) else None
            if error:
                return {"ok": False, "error": str(error)}
            if _write:
                run.ledger[key] = parsed
            return {"ok": True, "result": parsed}
        desc = act["action_name"] + (" — " + act["description"] if act.get("description") else "")
        tools.append(wrap(act["llm_name"], mcp_fn, desc, model(act["llm_name"], fields)))
    return tools


def render_playbook_transcript(title: str, events: list, final: str, status: str) -> str:
    """Markdown transcript, twin of PlaybookNodeRunner::renderTranscript() (PHP)."""
    gate_titles = {"approval": "Approval requested", "form": "Form request", "handoff": "Handed off to a human",
                   "await_message": "Waiting for the requester", "wait": "Waiting"}
    gate_tools = {"request_approval", "trigger_form", "prompt_handoff", "await_message", "wait_until"}
    lines, pending = [], {}

    def s(v):
        if isinstance(v, str):
            return v.strip()
        return "" if v is None else json.dumps(v, ensure_ascii=False)

    for ev in events:
        t = ev.get("type")
        if t == "tool_call":
            name = ev.get("name", "tool")
            if name in gate_tools:
                continue
            lines.append(f"- 🔧 {name} …")
            pending[name] = len(lines) - 1
        elif t == "tool_result":
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
        elif t == "message":
            text = "(message redacted)" if ev.get("sensitive") else s(ev.get("text", ""))
            if text:
                lines.append("- 💬 Playbook:\n" + "\n".join("  " + l for l in text.split("\n")))
        elif t == "gate_request":
            kind = ev.get("kind", "gate")
            p = ev.get("payload") or {}
            what = s(p.get("question") or p.get("prompt")
                     or (s(p.get("team_or_person", "")) + (" — " + s(p.get("reason")) if p.get("reason") else "")))
            lines.append("- ✋ " + gate_titles.get(kind, kind.capitalize()) + (f": {what}" if what else ""))
    out = f"# Playbook: {title} ({status})\n\n## Timeline\n" + ("\n".join(lines) if lines else "- (no steps recorded)")
    if final.strip():
        out += "\n\n## Result\n" + final.strip()
    return out + f"\n\n[playbook run: {status}]"


PY;
    }
}
