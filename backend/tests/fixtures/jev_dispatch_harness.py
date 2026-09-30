"""Exercise the generated dispatcher runtime (LangGraphRuntime::dispatcherBlock): JevRouter and Dispatcher.

Usage: python3 jev_dispatch_harness.py <extracted_block.py> [<node_classes.py>]

The block is the slice of a generated LangGraph file from the TypeSafe Jev comment
through the end of Dispatcher._via_llm(). It is exec'd into a namespace with stubs
for the LangChain/pydantic names the model path touches, so this needs only the
standard library. urllib.request.urlopen is monkeypatched: no network.
The optional second file is the Node classes (class Node through make_node()),
sliced from the same generated file; when given, the dispatcher cases also run
through make_node(...).run(), the way every mode runs a dispatcher node.

Exits 0 and prints "OK <n> cases" when every case passes; otherwise raises.
"""
import asyncio
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from abc import ABC, abstractmethod
from contextlib import redirect_stdout
from dataclasses import asdict, dataclass, field
from enum import Enum
from functools import cached_property
from typing import Literal

BLOCK = open(sys.argv[1], encoding="utf-8").read()
KIND = open(sys.argv[2], encoding="utf-8").read() if len(sys.argv) > 2 else None
END = "__end__"
TARGETS = [{"id": "3", "name": "IT claims", "description": ""},
           {"id": "4", "name": "Human resources", "description": "Leave, payroll and benefits."}]
QUESTION = 'You are "techBuddy", the front desk, an agent in the workflow "Dispatcher demo".'


class FakeResp:
    def __init__(self, tool_calls):
        self.tool_calls = tool_calls


class FakeLLM:
    """Model path stand-in: always routes to Human resources with a note."""
    def __init__(self, ns=None):
        self.calls = 0
        self.ns = ns
        self.durations_at_call = None   # NODE_DURATIONS as the model path found it

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def ainvoke(self, msgs):
        self.calls += 1
        if self.ns is not None:
            self.durations_at_call = dict(self.ns["NODE_DURATIONS"])
        return FakeResp([{"name": "route_to", "args": {"target": "Human resources", "notes": "from the model"}}])


class _Tool:
    @staticmethod
    def from_function(**kw):
        return object()


def namespace():
    ns = {"asyncio": asyncio, "json": json, "os": os, "time": time, "Literal": Literal,
          "create_model": lambda *a, **k: object, "Field": lambda *a, **k: None, "StructuredTool": _Tool,
          "NODE_DURATIONS": {}, "dataclass": dataclass, "field": field, "asdict": asdict,
          # What the Node classes need to be defined and to build a dispatcher's turn.
          "ABC": ABC, "abstractmethod": abstractmethod, "cached_property": cached_property, "Enum": Enum,
          "SystemMessage": lambda content: content, "HumanMessage": lambda content: content,
          "AIMessage": FakeResp, "inject_datetime": lambda s: s}
    exec(compile(BLOCK, "dispatch_block", "exec"), ns)
    return ns


class FakeHTTP:
    """urlopen replacement: records the request, returns a canned body or raises."""
    def __init__(self, body=None, exc=None):
        self.body, self.exc, self.requests = body, exc, []

    def __call__(self, req, timeout=None, context=None):
        self.requests.append((req, timeout))
        if self.exc is not None:
            raise self.exc
        raw = self.body if isinstance(self.body, bytes) else json.dumps(self.body).encode()

        class _R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return raw
        return _R()


def answer(choice, conf):
    return {"answers": {"route": {"choice": choice, "confidence": conf,
                                  "probabilities": {choice: conf}}},
            "usage": {"input_tokens": 12, "output_tokens": 1}}


def run_dispatcher(ns, http, key="test-key", routing_mode="", floor=0.6, router=None):
    """The cfg carries what the generator emits for a dispatcher: routing_mode is
    'jev' | 'llm' | '' (unset: Jev when TYPESAFE_API_KEY is set, else the
    model) and jev_min_confidence the floor. Returns the RouteDecision as a dict."""
    urllib.request.urlopen = http
    if key is None:
        os.environ.pop("TYPESAFE_API_KEY", None)
    else:
        os.environ["TYPESAFE_API_KEY"] = key
    llm = FakeLLM(ns)
    cfg = {"id": "2", "display": "techBuddy", "dispatch": TARGETS, "jev_question": QUESTION,
           "routing_mode": routing_mode, "jev_min_confidence": floor}
    made = []   # how many times the dispatcher asked for its chat model

    def make_llm():
        made.append(1)
        return llm
    buf = io.StringIO()
    with redirect_stdout(buf):
        decision = asyncio.run(ns["Dispatcher"](cfg, router).route("My laptop will not boot", [], make_llm))
    assert isinstance(decision, ns["RouteDecision"]), decision
    run_dispatcher.last_llm = llm
    run_dispatcher.llm_made = len(made)
    return asdict(decision), llm.calls, buf.getvalue()


cases = 0


def case(fn):
    global cases
    fn()
    cases += 1


def routed():
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.97))
    out, llm_calls, log = run_dispatcher(ns, http)
    assert llm_calls == 0, "routed must not spend an LLM turn"
    assert run_dispatcher.llm_made == 0, "Jev mode must not even build the chat model"
    assert out == {"text": "My laptop will not boot", "route": "3", "notes": "", "status": "ok"}, out
    assert "[node] [2] 'techBuddy' Jev routed to 'IT claims' (confidence 0.97, " in log and "ms, no LLM turn)" in log, log
    assert "techBuddy" in ns["NODE_DURATIONS"], ns["NODE_DURATIONS"]
    # The wire request: same contract as JevRouter.php.
    req, timeout = http.requests[0]
    assert req.full_url == "https://api.typesafe.ai/v1/systemone" and req.get_method() == "POST"
    assert timeout == 10, timeout
    assert req.get_header("Authorization") == "Bearer test-key"
    body = json.loads(req.data)
    assert body["model"] == "jev-latest" and body["state"] == {"request": "My laptop will not boot"}, body
    q = body["questions"]["route"]
    assert q["type"] == "choice" and q["instructions"] == QUESTION, q
    assert q["criteria"] == {"IT claims": "IT claims",   # blank description -> the name
                             "Human resources": "Leave, payroll and benefits.",
                             "unclear": ns["JevRouter"].UNCLEAR_DESC}, q["criteria"]
    r = ns["JevRouter"]().route("x", TARGETS, QUESTION)
    assert isinstance(r, ns["JevResult"]), r
    assert r.outcome == "routed" and r.target["id"] == "3" and r.usage["input_tokens"] == 12, r


def no_key():
    """Unset without TYPESAFE_API_KEY resolves to the model: Jev is never asked."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    out, llm_calls, log = run_dispatcher(ns, http, key=None)
    assert http.requests == [], "no key must not call HTTP"
    assert llm_calls == 1 and out == {"text": "My laptop will not boot\n\n## Dispatcher notes\nfrom the model",
                                      "route": "4", "notes": "from the model", "status": "ok"}, out
    assert "Jev" not in log, log
    assert run_dispatcher.last_llm.durations_at_call == {}, "no key must not touch NODE_DURATIONS before the model"
    assert ns["JevRouter"]().route("x", TARGETS, QUESTION).outcome == "unavailable"
    os.environ["TYPESAFE_API_KEY"] = ""
    out, llm_calls, log = run_dispatcher(ns, http, key="")
    assert http.requests == [] and llm_calls == 1 and "Jev" not in log


def refusals():
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    urllib.request.urlopen = http
    os.environ["TYPESAFE_API_KEY"] = "k"
    r = ns["JevRouter"]().route("x", [{"id": "1", "name": "Unclear"}, TARGETS[0]], QUESTION)
    assert r.outcome == "error" and "unusable target name" in r.reason, r
    r = ns["JevRouter"]().route("x", [TARGETS[0]], QUESTION)
    assert r.outcome == "error" and "at least two" in r.reason, r
    assert http.requests == [], "refusals happen before any HTTP"
    long = [{"id": "1", "name": "A", "description": "d" * 900}, {"id": "2", "name": "B"}]
    ns["JevRouter"]().route("x", long, QUESTION)
    crit = json.loads(http.requests[0][0].data)["questions"]["route"]["criteria"]
    assert crit["A"] == "d" * 400 and crit["B"] == "B", crit


def hung():
    """A Jev call that never returns (DNS, a stalled read) is cut off by
    asyncio.wait_for(router.TIMEOUT_S + 1): an unset dispatcher with a key is Jev
    only, so the run stops with "did not route" -- the model is never asked."""
    ns = namespace()

    class Slow(ns["JevRouter"]):
        TIMEOUT_S = 0   # -> wait_for bound of 1s

        def route(self, *a):
            time.sleep(2)
            return ns["JevResult"]("routed")

    out, llm_calls, log = run_dispatcher(ns, FakeHTTP(answer("IT claims", 0.99)), router=Slow())
    assert llm_calls == 0 and run_dispatcher.llm_made == 0, "a Jev timeout never falls back to the model"
    assert out["route"] == "" and out["status"] == "unrouted" and branch_that_runs(out) is None, out
    assert "Jev did not route (error: TimeoutError" in log and "no answer within 1s" in log, log
    assert ns["NODE_DURATIONS"]["techBuddy"] >= 1.0, ns["NODE_DURATIONS"]


async def _noop_trace(line):
    pass


def run_dispatcher_node(ns, llm, routing_mode, request):
    """A2A / modular / single: the dispatcher node as every mode now runs it,
    make_node(cfg).run(request, trace), with the model replaced by `llm`. With llm None
    the node has no usable model (_make_llm is not defined here), so reading node.llm raises."""
    exec(compile(KIND, "node_classes", "exec"), ns)
    node = ns["make_node"]({"id": "2", "kind": "dispatcher", "display": "techBuddy", "provider": "claude", "model": "m",
                            "temperature": 0.7, "max_tokens": 10, "system_prompt": "", "tool_names": [],
                            "dispatch": TARGETS, "jev_question": QUESTION, "routing_mode": routing_mode,
                            "jev_min_confidence": 0.6})
    if llm is not None:
        node.llm = llm
    node.__dict__["tools"] = []
    buf = io.StringIO()
    with redirect_stdout(buf):
        out = asyncio.run(node.run(request, _noop_trace))
    return out, buf.getvalue()


def kind_routed():
    """DispatcherNode carries the route id back as "route"."""
    ns = namespace()
    urllib.request.urlopen = FakeHTTP(answer("IT claims", 0.97))
    os.environ["TYPESAFE_API_KEY"] = "test-key"
    out, log = run_dispatcher_node(ns, None, "", "Framed request: my laptop will not boot")   # no model: Jev never builds one
    assert out == {"text": "Framed request: my laptop will not boot", "route": "3", "notes": "", "status": "ok"}, out
    assert "Jev routed to 'IT claims'" in log


def branch_that_runs(out):
    """What the compiled graph does with a dispatcher's result: its conditional
    edge router is `state.get("routes", {}).get(n) or END` over the menu ids
    plus END (single script and the modular/A2A orchestrators alike, which map
    a route that is not a menu id to END). None = no branch runs."""
    route = out["route"] or END
    return route if route in {t["id"] for t in TARGETS} else None


def llm_mode():
    """routing_mode 'llm': the model only; Jev is never asked, key or not."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    out, llm_calls, log = run_dispatcher(ns, http, routing_mode="llm")
    assert http.requests == [], "LLM mode must never call Jev"
    assert llm_calls == 1 and out["route"] == "4" and out["notes"] == "from the model", out
    assert "Jev" not in log, log
    assert run_dispatcher.last_llm.durations_at_call == {}, "LLM mode must not time a Jev call"


def jev_routed():
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.97))
    out, llm_calls, log = run_dispatcher(ns, http, routing_mode="jev")
    assert llm_calls == 0 and run_dispatcher.llm_made == 0, "Jev mode never builds or calls the model"
    assert out == {"text": "My laptop will not boot", "route": "3", "notes": "", "status": "ok"}, out
    assert branch_that_runs(out) == "3"
    assert "Jev routed to 'IT claims'" in log, log


def jev_not_routed(expect_reason, body=None, exc=None, key="test-key", floor=0.6, http_calls=1, routing_mode="jev"):
    """routing_mode 'jev' (or unset with a key, which resolves to Jev): any
    non-routed outcome stops at the dispatcher with the interpreter's "did not
    route" message; no model call, no branch."""
    ns = namespace()
    http = FakeHTTP(body, exc)
    out, llm_calls, log = run_dispatcher(ns, http, key=key, routing_mode=routing_mode, floor=floor)
    assert llm_calls == 0, f"Jev mode never calls the model ({expect_reason})"
    assert run_dispatcher.llm_made == 0, f"Jev mode never builds the model ({expect_reason})"
    assert len(http.requests) == http_calls, http.requests
    msg = f'Error: dispatcher "techBuddy" did not route the request (Jev: {expect_reason}).'
    assert out == {"text": msg, "route": "", "notes": "", "status": "unrouted"}, out
    assert branch_that_runs(out) is None, "no branch may run"
    assert "asking the model" not in log and "no model fallback" in log, log
    assert "techBuddy" in ns["NODE_DURATIONS"], "Jev's wall time is counted"


def custom_floor():
    """jev_min_confidence is honoured: 0.8 is below a 0.9 floor (the default
    0.6 would route it). An unset dispatcher with a key is Jev only, so it
    stops there -- the model is never asked."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.8))
    urllib.request.urlopen = http
    os.environ["TYPESAFE_API_KEY"] = "k"
    r = ns["JevRouter"]().route("x", TARGETS, QUESTION, 0.9)
    assert r.outcome == "low_confidence" and r.reason == "confidence 0.80 below floor 0.90", r
    assert ns["JevRouter"]().route("x", TARGETS, QUESTION).outcome == "routed", "default floor stays 0.6"
    out, llm_calls, log = run_dispatcher(ns, FakeHTTP(answer("IT claims", 0.8)), floor=0.9)
    assert llm_calls == 0 and out["route"] == "" and out["status"] == "unrouted", out
    assert "Jev did not route (low_confidence: confidence 0.80 below floor 0.90" in log, log


def mode_resolution():
    """Dispatcher.mode(): a saved mode wins; unset (or anything else) is Jev with a key, else the model."""
    ns = namespace()
    for saved, key, want in [("jev", None, "jev"), ("llm", "k", "llm"), ("", "k", "jev"), ("", None, "llm"),
                             ("bogus", "k", "jev"), ("", "", "llm")]:
        if key is None:
            os.environ.pop("TYPESAFE_API_KEY", None)
        else:
            os.environ["TYPESAFE_API_KEY"] = key
        got = ns["Dispatcher"]({"id": "2", "display": "techBuddy", "dispatch": TARGETS, "routing_mode": saved}).mode()
        assert got == want, (saved, key, got)
        assert isinstance(got, ns["RoutingMode"]), got


def kind_jev_unrouted():
    """A Jev-only no-route travels back as route "" (not a menu id -> the
    graph's conditional edge goes to END) with the message."""
    ns = namespace()
    urllib.request.urlopen = FakeHTTP(answer("unclear", 1.0))
    os.environ["TYPESAFE_API_KEY"] = "test-key"
    out, _ = run_dispatcher_node(ns, None, "jev", "Framed request")   # no model: Jev never builds one
    msg = 'Error: dispatcher "techBuddy" did not route the request (Jev: unclear: the request names no branch).'
    assert out == {"text": msg, "route": "", "notes": "", "status": "unrouted"}, out
    assert out["route"] not in {t["id"] for t in TARGETS}, "no branch may run"


def kind_unset_no_key():
    """An unset dispatcher without TYPESAFE_API_KEY -> the model."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    urllib.request.urlopen = http
    os.environ.pop("TYPESAFE_API_KEY", None)
    llm = FakeLLM(ns)
    out, _ = run_dispatcher_node(ns, llm, "", "Framed request")
    assert http.requests == [] and llm.calls == 1 and out["route"] == "4", out


def kind_llm_mode():
    """The node passes routing_mode through -> no Jev call."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    urllib.request.urlopen = http
    os.environ["TYPESAFE_API_KEY"] = "test-key"
    llm = FakeLLM(ns)
    out, _ = run_dispatcher_node(ns, llm, "llm", "Framed request")
    assert http.requests == [] and llm.calls == 1 and out["route"] == "4", out
    assert out["notes"] == "from the model", out


case(routed)
# Unset with a key = Jev only: a decline never falls back to the model.
case(lambda: jev_not_routed("unclear: the request names no branch", body=answer("unclear", 1.0), routing_mode=""))
case(lambda: jev_not_routed("low_confidence: confidence 0.46 below floor 0.60", body=answer("IT claims", 0.46), routing_mode=""))
case(lambda: jev_not_routed("error: <urlopen error timed out>", exc=urllib.error.URLError("timed out"), routing_mode=""))
case(lambda: jev_not_routed("error: no choice in the response", body=b"<html>not json</html>", routing_mode=""))
case(lambda: jev_not_routed("error: answer 'Sales' is not on the menu", body=answer("Sales", 0.99), routing_mode=""))   # off-menu answer is never trusted
case(no_key)
case(refusals)
case(hung)
case(llm_mode)
case(jev_routed)
case(lambda: jev_not_routed("unclear: the request names no branch", body=answer("unclear", 1.0)))
case(lambda: jev_not_routed("unavailable: no TYPESAFE_API_KEY", body=answer("IT claims", 0.99), key=None, http_calls=0))
case(lambda: jev_not_routed("low_confidence: confidence 0.80 below floor 0.90", body=answer("IT claims", 0.8), floor=0.9))
case(lambda: jev_not_routed("error: <urlopen error timed out>", exc=urllib.error.URLError("timed out")))
case(custom_floor)
case(mode_resolution)
if KIND is not None:
    case(kind_routed)
    case(kind_jev_unrouted)
    case(kind_llm_mode)
    case(kind_unset_no_key)
print(f"OK {cases} cases")
