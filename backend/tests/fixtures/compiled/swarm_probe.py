"""Probe: a compiled SWARM package actually builds and behaves, not just parses.

py_compile (LangGraphSwarmGeneratorTest's existing coverage) only proves the
emitted text is syntactically valid Python. It says nothing about whether the
installed `langgraph-swarm` (and the langchain/langgraph majors sitting next
to it in the runner venv) actually accept the calls the generator emits, or
whether a conversation really survives between two `run()` calls the way
`workflow.py`'s own docstring promises.

This probe imports the REAL emitted package (workflow.py + agents/*.py,
unmodified) with only the LLM factory stubbed, and asserts:

  1. the graph compiles                              (build_graph()/`._graph()` succeeds)
  2. its nodes are exactly the member display names   (Alice, Bob)
  3. default_active_agent is the entry agent          (Alice -- first off Start)
  4. each member exposes one handoff tool per colleague, named for that colleague
  5. a session survives between calls: the SAME `session` on a second run()
     resumes the conversation (transcript grows, the agent that ended call 1
     still holds the turn), while a DIFFERENT session starts fresh at the
     entry agent.

argv[1] is a compiled swarm package root (see
LangGraphSwarmGeneratorTest::twoAgentSwarm() -- Alice/Bob, Start fans out to
both, no dispatcher). The fixture is fixed, so this probe hard-codes their
names/modules exactly like node_events_probe.py hard-codes Researcher/Writer
for ITS fixture.

--------------------------------------------------------------------------
Two workarounds below are test scaffolding, not fixes to the generator:

(a) `agents` namespace collision. The runner venv has `openai-agents`
    installed (pulled in transitively, e.g. by openai-chatkit), which owns a
    REGULAR top-level `agents` package in site-packages. The emitted swarm
    package's own `agents/` directory has no `__init__.py` by design (a
    swarm has no router/dispatcher module -- see
    testNoRouterOrDispatcherModuleIsEmitted), so it is a PEP 420 namespace
    package -- and PEP 420 says a regular package anywhere on sys.path wins
    over a namespace portion, regardless of order. `python workflow.py` run
    for real, from inside the package root, hits exactly this. We
    pre-register the package's own `agents/` as `sys.modules["agents"]`
    before anything imports it, purely to reach the swarm-specific code
    under test; this is reported as a real defect, not silently absorbed.

(b) The LLM factory (`common._make_llm`) is stubbed per the brief, with two
    roles assigned by BUILD ORDER (workflow.py's member list is built in
    canvas/Start-fan-out order, i.e. Alice then Bob): the first agent built
    always hands off to its first colleague (RouterStub); every other agent
    always gives a final answer (AnswererStub). For this two-member fixture
    that means Alice always routes to Bob and Bob always answers -- which is
    exactly the shape needed to observe a handoff, a resumed session, and a
    fresh one, without an infinite handoff ping-pong (both members carry a
    handoff tool to the other, so a naive "answer with a tool call if one is
    bound" stub loops forever).
--------------------------------------------------------------------------

A SEPARATE, independent defect lives past those two workarounds: the emitted
agents/*.py calls `create_react_agent(_llm(), tools, prompt=..., name=...)`,
and in THIS venv `create_react_agent` resolves to `langchain.agents.create_agent`
(langchain 1.3.11 -- the `try: from langchain.agents import create_agent ...`
branch succeeds), whose signature has no `prompt` kwarg at all (only
`system_prompt`). That call raises TypeError before any of the five
assertions above can run. This probe does NOT work around it -- doing so
would just be "a probe adjusted to match broken output", which proves
nothing -- it detects that specific TypeError and reports it distinctly
(exit 2) so the caller can tell "known generator defect" apart from a new
regression.
"""
import asyncio
import os
import sys
import types
import uuid

ROOT = sys.argv[1]
sys.path.insert(0, ROOT)

# ---------------------------------------------------------------------------
# Workaround (a): make the package's own agents/ resolve, ahead of the
# unrelated `openai-agents` package installed in this venv (see docstring).
# ---------------------------------------------------------------------------
_agents_pkg = types.ModuleType("agents")
_agents_pkg.__path__ = [os.path.join(ROOT, "agents")]
sys.modules["agents"] = _agents_pkg

from langchain_core.language_models.chat_models import BaseChatModel  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402
from langchain_core.outputs import ChatGeneration, ChatResult  # noqa: E402


class RouterStub(BaseChatModel):
    """Always hands off to its first colleague. Used for the first agent built."""

    @property
    def _llm_type(self) -> str:
        return "router-stub"

    def bind_tools(self, tools, **kwargs):
        names = []
        for t in tools:
            n = getattr(t, "name", None)
            if n is None and isinstance(t, dict):
                n = t.get("name") or (t.get("function") or {}).get("name")
            names.append(n)
        return self.bind(tool_names=names)

    def _generate(self, messages, stop=None, run_manager=None, tool_names=None, **kwargs):
        tool_names = tool_names or []
        handoffs = [n for n in tool_names if n and n.startswith("transfer_to_")]
        assert handoffs, f"RouterStub expected a bound handoff tool, got {tool_names}"
        call_id = "call_" + uuid.uuid4().hex[:8]
        msg = AIMessage(content="", tool_calls=[{"name": handoffs[0], "args": {}, "id": call_id}])
        return ChatResult(generations=[ChatGeneration(message=msg)])


class AnswererStub(BaseChatModel):
    """Never hands off -- always gives a final answer. Used for every other agent."""

    @property
    def _llm_type(self) -> str:
        return "answerer-stub"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        last = messages[-1].content if messages else ""
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=f"final answer to: {str(last)[-60:]}"))])


_build_calls = {"n": 0}


def _fake_make_llm(*_a, **_k):
    # First agent module to call _llm() (== build order == Start's fan-out
    # order for this fixture: Alice, then Bob) gets the router role.
    _build_calls["n"] += 1
    return RouterStub() if _build_calls["n"] == 1 else AnswererStub()


import importlib  # noqa: E402

common = importlib.import_module("common")
common._make_llm = _fake_make_llm

try:
    workflow = importlib.import_module("workflow")
except Exception as e:  # pragma: no cover - reported, not swallowed
    print(f"UNEXPECTED import failure: {type(e).__name__}: {e}")
    raise

KNOWN_DEFECT_NEEDLE = "unexpected keyword argument 'prompt'"


def _run_all_assertions():
    # --- 1. the graph compiles -------------------------------------------------
    g = workflow._graph()
    from langgraph.graph.state import CompiledStateGraph
    assert isinstance(g, CompiledStateGraph), f"build_graph() did not return a compiled graph: {type(g)}"

    # --- 2. nodes are exactly the member display names --------------------------
    nodes = set(g.get_graph().nodes.keys()) - {"__start__"}
    assert nodes == {"Alice", "Bob"}, f"expected nodes {{Alice, Bob}}, got {nodes}"

    # --- 3. default_active_agent is the entry agent (first off Start) -----------
    assert workflow.DEFAULT_ACTIVE_AGENT == "Alice", (
        f"expected DEFAULT_ACTIVE_AGENT == 'Alice', got {workflow.DEFAULT_ACTIVE_AGENT!r}"
    )

    # --- 4. each member exposes one handoff tool per colleague, named for it ----
    alice_mod = importlib.import_module("agents.alice")
    bob_mod = importlib.import_module("agents.bob")
    assert [t.name for t in alice_mod.HANDOFFS] == ["transfer_to_bob"], \
        f"Alice's handoffs: {[t.name for t in alice_mod.HANDOFFS]}"
    assert [t.name for t in bob_mod.HANDOFFS] == ["transfer_to_alice"], \
        f"Bob's handoffs: {[t.name for t in bob_mod.HANDOFFS]}"

    # --- 5. a session survives between calls -------------------------------------
    session_a = "session-A-" + uuid.uuid4().hex[:6]
    out1 = asyncio.run(workflow.run("plan a trip", session_a))
    assert "transferred to Bob" in out1, f"expected call 1 to route through the handoff, got: {out1!r}"

    state1 = g.get_state({"configurable": {"thread_id": session_a}})
    assert state1.values.get("active_agent") == "Bob", \
        f"expected Bob to hold the turn after call 1, got {state1.values.get('active_agent')!r}"
    n_after_1 = len(state1.values.get("messages", []))
    assert n_after_1 == 4, f"expected 4 messages after the handoff turn, got {n_after_1}"

    out2 = asyncio.run(workflow.run("more detail please", session_a))
    assert "final answer to: more detail please" in out2, f"unexpected call 2 output: {out2!r}"
    state2 = g.get_state({"configurable": {"thread_id": session_a}})
    # Same session resumed: still Bob (no re-handoff), transcript grew, not reset.
    assert state2.values.get("active_agent") == "Bob", \
        f"same-session call 2 should still be held by Bob, got {state2.values.get('active_agent')!r}"
    n_after_2 = len(state2.values.get("messages", []))
    assert n_after_2 == n_after_1 + 2, (
        f"expected the transcript to grow by one human+answer turn (no re-handoff), "
        f"went from {n_after_1} to {n_after_2}"
    )

    session_b = "session-B-" + uuid.uuid4().hex[:6]
    out3 = asyncio.run(workflow.run("a completely different conversation", session_b))
    assert "transferred to Bob" in out3, (
        f"a fresh session must start at the entry agent (Alice) and hand off again, got: {out3!r}"
    )
    state3 = g.get_state({"configurable": {"thread_id": session_b}})
    n_session_b = len(state3.values.get("messages", []))
    assert n_session_b == 4, f"a fresh session must not inherit session A's transcript, got {n_session_b} messages"


try:
    _run_all_assertions()
except TypeError as e:
    if KNOWN_DEFECT_NEEDLE in str(e):
        print("DEFECT: agents/*.py calls create_react_agent(..., prompt=..., ...); in this venv")
        print("create_react_agent resolves to langchain.agents.create_agent (langchain 1.3.11),")
        print("whose signature has no `prompt` kwarg (only `system_prompt`). See")
        print("LangGraphGenerator::emitSwarmAgentFile()'s build_agent() emission.")
        print(f"Underlying error: {e}")
        sys.exit(2)
    raise

print("OK")
