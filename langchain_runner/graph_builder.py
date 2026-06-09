"""Build and run a LangGraph workflow from a PHP-backend workflow definition.

Scope (v1): start → agent(s) → output. Diamond/converging graphs supported via
linear traversal that preserves topological order. Each node receives only its
direct predecessors' outputs, labeled by source agent name — matching the PHP
`buildContextForNode` semantics.

Single provider: Anthropic Claude.
"""
from __future__ import annotations

import logging
from typing import Annotated, Any, Callable, TypedDict

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.tools import StructuredTool
from langgraph.graph import END, START, StateGraph
try:
    from langchain.agents import create_agent as create_react_agent
except ImportError:
    from langgraph.prebuilt import create_react_agent

from mcp_tools import build_tools
from workflow_loader import WorkflowLoader

logger = logging.getLogger(__name__)


def _inject_datetime(system_prompt: str) -> str:
    """Prepend current date/time context to a system prompt and fill
    [date]/[weekday]/[year]/[time] placeholders. LLMs don't know today's
    date by default, so this grounds them for time-sensitive reasoning.
    """
    from datetime import datetime as _dt
    now = _dt.now()
    date_str = now.strftime("%Y-%m-%d")
    weekday_str = now.strftime("%A")
    year_str = now.strftime("%Y")
    time_str = now.strftime("%H:%M")
    prompt = system_prompt
    prompt = prompt.replace("[date]", date_str)
    prompt = prompt.replace("[weekday]", weekday_str)
    prompt = prompt.replace("[year]", year_str)
    prompt = prompt.replace("[time]", time_str)
    header = (
        f"## Current Date & Time\n"
        f"Today is {weekday_str}, {date_str} ({time_str}).\n"
        f"Use this as the reference for any date-sensitive reasoning "
        f"(recent research, latest news, time-relative phrasing, etc.).\n\n"
    )
    return header + prompt


def _merge_outputs(
    left: dict[str, dict[str, str]] | None,
    right: dict[str, dict[str, str]] | None,
) -> dict[str, dict[str, str]]:
    """Reducer for node_outputs — shallow merge, right wins on conflict."""
    out: dict[str, dict[str, str]] = {}
    if left:
        out.update(left)
    if right:
        out.update(right)
    return out


class WFState(TypedDict, total=False):
    user_prompt: str
    # node_id -> {"text": str, "source": str (display name)}
    node_outputs: Annotated[dict[str, dict[str, str]], _merge_outputs]
    final_output: str


def _normalize_graph(workflow: dict[str, Any]) -> tuple[list[dict], list[dict]]:
    graph = workflow.get("graph") or {}
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    return nodes, edges


def _node_type(n: dict[str, Any]) -> str:
    return n.get("node_type") or n.get("type") or (n.get("config") or {}).get("type") or ""


def _node_id(n: dict[str, Any]) -> str:
    return str(n.get("id") or n.get("drawflow_node_id") or n.get("_id"))


def _edge_from(e: dict) -> str:
    return str(e.get("from_node_id") or e.get("from") or e.get("source"))


def _edge_to(e: dict) -> str:
    return str(e.get("to_node_id") or e.get("to") or e.get("target"))


def _children(node_id: str, edges: list[dict]) -> list[str]:
    return [_edge_to(e) for e in edges if _edge_from(e) == node_id]


def _parents(node_id: str, edges: list[dict]) -> list[str]:
    return [_edge_from(e) for e in edges if _edge_to(e) == node_id]


def _display_name(node: dict[str, Any]) -> str:
    cfg = node.get("config") or {}
    return (
        cfg.get("agent_name")
        or cfg.get("name")
        or node.get("name")
        or f"node {_node_id(node)}"
    )


def _topo_order(start_id: str, edges: list[dict], by_id: dict[str, dict]) -> list[str]:
    """Kahn's algorithm restricted to nodes reachable from start.
    Produces an order where every node appears after all its parents.
    """
    reachable: set[str] = set()
    stack = [start_id]
    while stack:
        nid = stack.pop()
        if nid in reachable:
            continue
        reachable.add(nid)
        stack.extend(_children(nid, edges))

    in_deg: dict[str, int] = {nid: 0 for nid in reachable}
    for e in edges:
        f, t = _edge_from(e), _edge_to(e)
        if f in reachable and t in reachable:
            in_deg[t] += 1

    order: list[str] = []
    queue = [nid for nid, d in in_deg.items() if d == 0]
    while queue:
        nid = queue.pop(0)
        order.append(nid)
        for child in _children(nid, edges):
            if child not in in_deg:
                continue
            in_deg[child] -= 1
            if in_deg[child] == 0:
                queue.append(child)
    return order


def _build_context_message(
    user_prompt: str,
    parent_ids: list[str],
    node_outputs: dict[str, dict[str, str]],
) -> str:
    """Format predecessor outputs as a labeled, framed message for the agent."""
    parts: list[str] = []
    parts.append(f'Original user request: "{user_prompt}"')
    parts.append("")
    parts.append("You are receiving the following inputs from upstream agents in this workflow.")
    parts.append("Use them as source material to perform your task as defined in your system prompt.")
    parts.append("")
    parts.append("---")

    valid = [(pid, node_outputs[pid]) for pid in parent_ids if pid in node_outputs]
    if not valid:
        parts.append("(no upstream inputs — respond to the original user request directly)")
    else:
        for pid, out in valid:
            source = out.get("source", f"node {pid}")
            text = out.get("text", "")
            parts.append("")
            parts.append(f"### Input from: {source}")
            parts.append("")
            parts.append(text)
            parts.append("")
            parts.append("---")

    return "\n".join(parts)


async def build_and_run(
    workflow_id: int,
    user_prompt: str | None,
    loader: WorkflowLoader,
    log_sink: Callable[[str, str], None],
    model_name: str = "claude-sonnet-4-5",
) -> dict[str, Any]:
    log_sink("info", f"Fetching workflow {workflow_id}…")
    workflow = await loader.get_workflow(workflow_id)
    log_sink("info", f"Workflow: {workflow.get('name')!r}")

    nodes, edges = _normalize_graph(workflow)
    if not nodes:
        raise RuntimeError("Workflow has no graph nodes.")

    by_id = {_node_id(n): n for n in nodes}
    start_nodes = [n for n in nodes if _node_type(n) == "start"]
    if not start_nodes:
        raise RuntimeError("No start node found.")
    start_id = _node_id(start_nodes[0])

    # Resolve prompt from the workflow's start node if not provided
    if not user_prompt:
        start_cfg = (start_nodes[0].get("config") or {})
        user_prompt = start_cfg.get("prompt") or ""
        log_sink("info", f"Using start node prompt ({len(user_prompt)} chars): {user_prompt[:100]!r}")
    if not user_prompt:
        raise RuntimeError("No prompt found — the start node has no prompt configured.")

    order = _topo_order(start_id, edges, by_id)
    if not order:
        raise RuntimeError("Topological sort produced no nodes (cycle?).")
    pretty = [f"{nid}({_display_name(by_id[nid])})" for nid in order]
    log_sink("info", f"Topological order ({len(order)} nodes): " + " → ".join(pretty))

    tool_defs = await loader.list_all_tools()
    discovered_names = sorted({(t.get("name") or "?") for t in tool_defs})
    by_type: dict[str, int] = {}
    for t in tool_defs:
        by_type[t.get("type", "?")] = by_type.get(t.get("type", "?"), 0) + 1
    log_sink(
        "info",
        f"Discovered {len(tool_defs)} tools ({by_type}): {discovered_names}",
    )

    llm = ChatAnthropic(model=model_name, temperature=0)
    log_sink("info", f"LLM: {model_name}")

    sg = StateGraph(WFState)

    def make_start_runner(nid: str):
        def _run(state: WFState) -> dict:
            text = state.get("user_prompt", "")
            log_sink("node", f"[{nid}] start → user prompt stored ({len(text)} chars)")
            return {
                "node_outputs": {
                    nid: {"source": _display_name(by_id[nid]), "text": text}
                }
            }
        return _run

    def make_agent_runner(nid: str, node: dict[str, Any]):
        async def _run(state: WFState) -> dict:
            cfg = node.get("config") or {}
            display = _display_name(node)
            agent_id = node.get("agent_id") or cfg.get("agent_id")

            system_prompt = cfg.get("systemPrompt") or cfg.get("instructions") or ""
            # Tristate: None = "no filter known yet → expose all"; set() = "explicitly no tools"
            selected_tool_names: set[str] | None = (
                set(cfg["selectedTools"]) if isinstance(cfg.get("selectedTools"), list) else None
            )

            # Always fetch the agent definition when an agent_id is present so
            # we get its tool selection, even if the node already carries a
            # system prompt. Without this, agents end up with every MCP tool
            # in the catalog instead of the ones they were configured with.
            if agent_id:
                try:
                    agent = await loader.get_agent(int(agent_id))
                    log_sink(
                        "node",
                        f"[{nid}] agent {agent_id} record: tools={agent.get('tools')!r}",
                    )
                    if not system_prompt:
                        system_prompt = (
                            agent.get("instructions")
                            or agent.get("system_prompt")
                            or agent.get("prompt")
                            or ""
                        )
                    if selected_tool_names is None and isinstance(agent.get("tools"), list):
                        selected_tool_names = set()
                        for t in agent["tools"]:
                            tname = t if isinstance(t, str) else (
                                t.get("name") or t.get("tool_name")
                                if isinstance(t, dict) else None
                            )
                            if tname:
                                if tname.startswith("mcp_"):
                                    tname = tname[4:]
                                selected_tool_names.add(tname)
                except Exception as e:
                    log_sink("warn", f"[{nid}] could not fetch agent {agent_id}: {e}")

            # selected_tool_names: None → unknown, expose nothing (safer than all);
            # empty set → explicit "no tools"; set with names → filter.
            effective_filter = selected_tool_names if selected_tool_names is not None else set()
            tools: list[StructuredTool] = build_tools(
                tool_defs,
                loader.backend_url,
                loader.headers["Authorization"].removeprefix("Bearer ").strip(),
                allowed_names=effective_filter,
                log_sink=log_sink,
            )
            filter_label = (
                "(none specified → 0 tools)" if selected_tool_names is None
                else (sorted(selected_tool_names) or "(empty → 0 tools)")
            )
            log_sink(
                "node",
                f"[{nid}] tool filter: {filter_label}; selected {len(tools)}/{len(tool_defs)}",
            )

            parent_ids = _parents(nid, edges)
            log_sink(
                "node",
                f"[{nid}] {display!r} ready — {len(tools)} tools, {len(system_prompt)} char prompt, "
                f"{len(parent_ids)} upstream input(s): {parent_ids}",
            )

            context = _build_context_message(
                state.get("user_prompt", ""),
                parent_ids,
                state.get("node_outputs", {}),
            )
            log_sink("node", f"[{nid}] context ({len(context)} chars) preview: {context[:300]!r}")

            messages: list[Any] = []
            if system_prompt:
                messages.append(SystemMessage(content=_inject_datetime(system_prompt)))
            messages.append(HumanMessage(content=context))

            agent_graph = create_react_agent(llm, tools)
            log_sink("node", f"[{nid}] invoking agent…")
            result = await agent_graph.ainvoke({"messages": messages})
            final_msg = result["messages"][-1]
            text = final_msg.content if isinstance(final_msg, AIMessage) else str(final_msg)
            if isinstance(text, list):  # claude returns content as list of blocks sometimes
                text = "".join(b.get("text", "") for b in text if isinstance(b, dict))
            log_sink("node", f"[{nid}] done — {len(text)} chars")
            return {"node_outputs": {nid: {"source": display, "text": text}}}

        return _run

    def make_output_runner(nid: str):
        def _run(state: WFState) -> dict:
            parent_ids = _parents(nid, edges)
            outs = state.get("node_outputs", {})
            if len(parent_ids) == 1 and parent_ids[0] in outs:
                final = outs[parent_ids[0]]["text"]
            else:
                blocks = [
                    f"## {outs[pid]['source']}\n\n{outs[pid]['text']}"
                    for pid in parent_ids if pid in outs
                ]
                final = "\n\n---\n\n".join(blocks)
            log_sink(
                "node",
                f"[{nid}] output finalized — {len(parent_ids)} input(s), {len(final)} chars",
            )
            return {"final_output": final}
        return _run

    for nid in order:
        node = by_id[nid]
        t = _node_type(node)
        if t == "start":
            sg.add_node(nid, make_start_runner(nid))
        elif t in ("agent", "agent-template"):
            sg.add_node(nid, make_agent_runner(nid, node))
        elif t == "output":
            sg.add_node(nid, make_output_runner(nid))
        else:
            log_sink("warn", f"[{nid}] unsupported node type '{t}' — treating as pass-through")
            sg.add_node(nid, (lambda _s: {}))

    # Wire edges in topo order: link parent_in_topo → node so each node only
    # runs after all its real graph predecessors have completed.
    pos = {nid: i for i, nid in enumerate(order)}
    sg.add_edge(START, order[0])
    for nid in order:
        for child in _children(nid, edges):
            if child in pos and pos[child] > pos[nid]:
                sg.add_edge(nid, child)
    # Connect sinks (no outgoing reachable edges) to END
    for nid in order:
        if not _children(nid, edges):
            sg.add_edge(nid, END)

    compiled = sg.compile()
    log_sink("info", "Graph compiled. Executing…")
    final_state = await compiled.ainvoke({"user_prompt": user_prompt, "node_outputs": {}})

    # Strip the inner dict from node_outputs in the returned summary
    flat_outputs = {
        nid: out["text"] if isinstance(out, dict) else str(out)
        for nid, out in (final_state.get("node_outputs") or {}).items()
    }

    return {
        "workflow_name": workflow.get("name"),
        "final_output": final_state.get("final_output", ""),
        "node_outputs": flat_outputs,
    }
