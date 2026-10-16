"""Exercise the generated dispatcher runtime (LangGraphRuntime::dispatcherBlock): JevRouter and Dispatcher.

Usage: python3 jev_dispatch_harness.py <extracted_block.py> [<node_classes.py>]

The block is the slice of a generated LangGraph file from the decision-model routing
comment through the end of Dispatcher._via_llm(). It is exec'd into a namespace with stubs
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
JEV_URL = "https://api.typesafe.ai/v1/systemone"
ENV_NAMES = ("JEV_API_KEY", "JEV_BASE_URL", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "ACME_API_KEY", "ACME_BASE_URL")


def candidate(provider="jev", url=JEV_URL):
    """One compiled decision candidate, as the generator emits it in a dispatcher's "decision" list."""
    stem = provider.upper().replace("-", "_")
    return {"provider": provider, "protocol": "typesafe", "url": url, "model": "jev-latest",
            "key_env": f"{stem}_API_KEY", "url_env": f"{stem}_BASE_URL"}


def set_env(**env):
    """Exactly these decision env vars (None or missing = unset)."""
    for name in ENV_NAMES:
        os.environ.pop(name, None)
    for name, value in env.items():
        if value is not None:
            os.environ[name] = value


def router(ns):
    """The jev row's adapter, as Dispatcher.router_for() builds it."""
    return ns["JevRouter"](key_env="JEV_API_KEY", url_env="JEV_BASE_URL")


class FakeResp:
    def __init__(self, tool_calls):
        self.tool_calls = tool_calls


class FakeLLM:
    """Model path stand-in: always routes to Human resources with a note."""
    def __init__(self):
        self.calls = 0

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def ainvoke(self, msgs):
        self.calls += 1
        return FakeResp([{"name": "route_to", "args": {"target": "Human resources", "notes": "from the model"}}])


class _Tool:
    @staticmethod
    def from_function(**kw):
        return object()


def namespace():
    ns = {"asyncio": asyncio, "json": json, "os": os, "time": time, "Literal": Literal,
          "create_model": lambda *a, **k: object, "Field": lambda *a, **k: None, "StructuredTool": _Tool,
          "dataclass": dataclass, "field": field, "asdict": asdict,
          # What the Node classes need to be defined and to build a dispatcher's turn.
          "ABC": ABC, "abstractmethod": abstractmethod, "cached_property": cached_property, "Enum": Enum,
          "SystemMessage": lambda content: content, "HumanMessage": lambda content: content,
          "AIMessage": FakeResp, "inject_datetime": lambda s: s,
          "node_print": lambda line: print(line, flush=True)}   # the runtime's node_print with no RUN_OUT
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


def run_dispatcher(ns, http, key="test-key", routing_mode="", floor=0.6, router=None, decision=None, env=None, unclear_branch=""):
    """The cfg carries what the generator emits for a dispatcher: routing_mode is
    'llm' | a provider key | '' (unset: the first candidate whose key is set, else
    the model), min_confidence the floor and decision the compiled candidates (the
    jev row unless given). key sets JEV_API_KEY; env, when given, replaces the decision
    env vars instead. Returns the RouteDecision as a dict."""
    urllib.request.urlopen = http
    set_env(**(env if env is not None else {"JEV_API_KEY": key}))
    llm = FakeLLM()
    cfg = {"id": "2", "display": "techBuddy", "dispatch": TARGETS, "decision_question": QUESTION,
           "routing_mode": routing_mode, "min_confidence": floor, "unclear_branch": unclear_branch,
           "decision": [candidate()] if decision is None else decision}
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
    assert run_dispatcher.llm_made == 0, "a decision model must not even build the chat model"
    assert out == {"text": "My laptop will not boot", "route": "3", "notes": "", "status": "ok"}, out
    assert "[node] [2] 'techBuddy' jev routed to 'IT claims' (confidence 0.97, " in log and "ms, no LLM turn)" in log, log
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
    r = router(ns).route("x", TARGETS, QUESTION)
    assert isinstance(r, ns["DecisionResult"]), r
    assert r.outcome == "routed" and r.target["id"] == "3" and r.usage["input_tokens"] == 12, r


def no_key():
    """Unset without any decision key resolves to the model: Jev is never asked."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    out, llm_calls, log = run_dispatcher(ns, http, key=None)
    assert http.requests == [], "no key must not call HTTP"
    assert llm_calls == 1 and out == {"text": "My laptop will not boot\n\n## Dispatcher notes\nfrom the model",
                                      "route": "4", "notes": "from the model", "status": "ok"}, out
    assert "jev" not in log, log
    r = router(ns).route("x", TARGETS, QUESTION)
    assert r.outcome == "unavailable" and r.reason == "no JEV_API_KEY", r
    out, llm_calls, log = run_dispatcher(ns, http, key="")
    assert http.requests == [] and llm_calls == 1 and "jev" not in log


def refusals():
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    urllib.request.urlopen = http
    set_env(JEV_API_KEY="k")
    r = router(ns).route("x", [{"id": "1", "name": "Unclear"}, TARGETS[0]], QUESTION)
    assert r.outcome == "error" and "unusable target name" in r.reason, r
    r = router(ns).route("x", [TARGETS[0]], QUESTION)
    assert r.outcome == "error" and "at least two" in r.reason, r
    assert http.requests == [], "refusals happen before any HTTP"
    long = [{"id": "1", "name": "A", "description": "d" * 900}, {"id": "2", "name": "B"}]
    router(ns).route("x", long, QUESTION)
    crit = json.loads(http.requests[0][0].data)["questions"]["route"]["criteria"]
    assert crit["A"] == "d" * 400 and crit["B"] == "B", crit


def hung():
    """A Jev call that never returns (DNS, a stalled read) is cut off by
    asyncio.wait_for(router.TIMEOUT_S + 1): an unset dispatcher with a key routes with
    that decision model only, so the run stops with "did not route" -- the model is never asked."""
    ns = namespace()

    class Slow(ns["JevRouter"]):
        TIMEOUT_S = 0   # -> wait_for bound of 1s

        def route(self, *a):
            time.sleep(2)
            return ns["DecisionResult"]("routed")

    t0 = time.monotonic()
    out, llm_calls, log = run_dispatcher(ns, FakeHTTP(answer("IT claims", 0.99)), router=Slow())
    waited = time.monotonic() - t0
    assert llm_calls == 0 and run_dispatcher.llm_made == 0, "a Jev timeout never falls back to the model"
    assert out["route"] == "" and out["status"] == "unrouted" and branch_that_runs(out) is None, out
    assert "jev did not route (error: TimeoutError" in log and "no answer within 1s" in log, log
    assert waited >= 1.0, waited


async def _noop_trace(line):
    pass


def run_dispatcher_node(ns, llm, routing_mode, request):
    """A2A / modular / single: the dispatcher node as every mode now runs it,
    make_node(cfg).run(request, trace), with the model replaced by `llm`. With llm None
    the node has no usable model (_make_llm is not defined here), so reading node.llm raises."""
    exec(compile(KIND, "node_classes", "exec"), ns)
    node = ns["make_node"]({"id": "2", "kind": "dispatcher", "display": "techBuddy", "provider": "claude", "model": "m",
                            "temperature": 0.7, "max_tokens": 10, "system_prompt": "", "tool_names": [],
                            "dispatch": TARGETS, "decision_question": QUESTION, "routing_mode": routing_mode,
                            "min_confidence": 0.6, "decision": [candidate()]})
    if llm is not None:
        node.llm = llm
    node.__dict__["tools"] = []
    buf = io.StringIO()
    with redirect_stdout(buf):
        out = asyncio.run(node.run(request, _noop_trace))
    return out, buf.getvalue()


def legacy_key():
    """Only the legacy TYPESAFE_API_KEY set (an .env written before per-row names): the
    jev row still routes, and posts to TYPESAFE_BASE_URL when that is set."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.97))
    out, llm_calls, _ = run_dispatcher(ns, http, routing_mode="jev", env={"TYPESAFE_API_KEY": "legacy"})
    assert llm_calls == 0 and out["route"] == "3" and out["status"] == "ok", out
    req = http.requests[0][0]
    assert req.get_header("Authorization") == "Bearer legacy" and req.full_url == JEV_URL, req.full_url
    http = FakeHTTP(answer("IT claims", 0.97))
    out, _, _ = run_dispatcher(ns, http, env={"TYPESAFE_API_KEY": "legacy", "TYPESAFE_BASE_URL": "https://gw.local/jev"})
    assert out["route"] == "3", "unset mode: the legacy key makes the jev row usable"
    assert http.requests[0][0].full_url == "https://gw.local/jev", http.requests[0][0].full_url


def row_key_wins():
    """The row's own JEV_API_KEY (and JEV_BASE_URL) win over the legacy TYPESAFE_* pair."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.97))
    out, _, _ = run_dispatcher(ns, http, routing_mode="jev",
                               env={"JEV_API_KEY": "row", "JEV_BASE_URL": "https://row.gw/jev",
                                    "TYPESAFE_API_KEY": "legacy", "TYPESAFE_BASE_URL": "https://legacy.gw/jev"})
    assert out["route"] == "3", out
    req = http.requests[0][0]
    assert req.get_header("Authorization") == "Bearer row" and req.full_url == "https://row.gw/jev", req.full_url


def unset_picks_first_keyed_candidate():
    """Unset mode with two candidates, only the second's key set: the second routes."""
    ns = namespace()
    set_env(ACME_API_KEY="acme-key")
    d = ns["Dispatcher"]({"id": "2", "display": "techBuddy", "dispatch": TARGETS, "routing_mode": "",
                          "decision": [candidate(), candidate("acme", "https://acme.example/route")]})
    assert d.mode() == "acme", d.mode()
    http = FakeHTTP(answer("IT claims", 0.97))
    out, llm_calls, log = run_dispatcher(ns, http, env={"ACME_API_KEY": "acme-key"},
                                         decision=[candidate(), candidate("acme", "https://acme.example/route")])
    assert llm_calls == 0 and out["route"] == "3", out
    req = http.requests[0][0]
    assert req.get_header("Authorization") == "Bearer acme-key" and req.full_url == "https://acme.example/route"
    assert "acme routed to 'IT claims'" in log, log


def missing_provider():
    """A node naming a provider that was not compiled in (row gone or disabled at
    generation): it does not route, and the model is never called."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    out, llm_calls, log = run_dispatcher(ns, http, routing_mode="gone", decision=[])
    assert llm_calls == 0 and run_dispatcher.llm_made == 0 and http.requests == [], (llm_calls, http.requests)
    msg = ('Error: dispatcher "techBuddy" did not route the request '
           "(gone: unavailable: 'gone' is not an available decision provider).")
    assert out == {"text": msg, "route": "", "notes": "", "status": "unrouted"}, out
    assert ns["RouteDecision"](**out).status == "unrouted"
    assert branch_that_runs(out) is None


def kind_routed():
    """DispatcherNode carries the route id back as "route"."""
    ns = namespace()
    urllib.request.urlopen = FakeHTTP(answer("IT claims", 0.97))
    set_env(JEV_API_KEY="test-key")
    out, log = run_dispatcher_node(ns, None, "", "Framed request: my laptop will not boot")   # no model: Jev never builds one
    assert out == {"text": "Framed request: my laptop will not boot", "route": "3", "notes": "", "status": "ok"}, out
    assert "jev routed to 'IT claims'" in log


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
    assert "jev" not in log, log


def jev_routed():
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.97))
    out, llm_calls, log = run_dispatcher(ns, http, routing_mode="jev")
    assert llm_calls == 0 and run_dispatcher.llm_made == 0, "Jev mode never builds or calls the model"
    assert out == {"text": "My laptop will not boot", "route": "3", "notes": "", "status": "ok"}, out
    assert branch_that_runs(out) == "3"
    assert "jev routed to 'IT claims'" in log, log


def jev_not_routed(expect_reason, body=None, exc=None, key="test-key", floor=0.6, http_calls=1, routing_mode="jev"):
    """routing_mode 'jev' (or unset with its key, which resolves to jev): any
    non-routed outcome stops at the dispatcher with the interpreter's "did not
    route" message; no model call, no branch."""
    ns = namespace()
    http = FakeHTTP(body, exc)
    out, llm_calls, log = run_dispatcher(ns, http, key=key, routing_mode=routing_mode, floor=floor)
    assert llm_calls == 0, f"Jev mode never calls the model ({expect_reason})"
    assert run_dispatcher.llm_made == 0, f"Jev mode never builds the model ({expect_reason})"
    assert len(http.requests) == http_calls, http.requests
    # A request no branch fits ends as "Not classified"; a failure (no key, network) is an error.
    prefix = "Not classified" if expect_reason.startswith(("unclear", "low_confidence")) else "Error"
    msg = f'{prefix}: dispatcher "techBuddy" did not route the request (jev: {expect_reason}).'
    assert out == {"text": msg, "route": "", "notes": "", "status": "unrouted"}, out
    assert branch_that_runs(out) is None, "no branch may run"
    assert "asking the model" not in log and "no model fallback" in log, log


def custom_floor():
    """min_confidence is honoured: 0.8 is below a 0.9 floor (the default
    0.6 would route it). An unset dispatcher with a key is Jev only, so it
    stops there -- the model is never asked."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.8))
    urllib.request.urlopen = http
    set_env(JEV_API_KEY="k")
    r = router(ns).route("x", TARGETS, QUESTION, 0.9)
    assert r.outcome == "low_confidence" and r.reason == "confidence 0.80 below floor 0.90", r
    assert router(ns).route("x", TARGETS, QUESTION).outcome == "routed", "default floor stays 0.6"
    out, llm_calls, log = run_dispatcher(ns, FakeHTTP(answer("IT claims", 0.8)), floor=0.9)
    assert llm_calls == 0 and out["route"] == "" and out["status"] == "unrouted", out
    assert "jev did not route (low_confidence: confidence 0.80 below floor 0.90" in log, log


def mode_resolution():
    """Dispatcher.mode(): a saved mode wins (any key, compiled in or not); unset is the
    first candidate whose key is set, else the model."""
    ns = namespace()
    for saved, key, want in [("jev", None, "jev"), ("llm", "k", "llm"), ("", "k", "jev"), ("", None, "llm"),
                             ("bogus", "k", "bogus"), ("", "", "llm")]:
        set_env(JEV_API_KEY=key)
        got = ns["Dispatcher"]({"id": "2", "display": "techBuddy", "dispatch": TARGETS, "routing_mode": saved,
                                "decision": [candidate()]}).mode()
        assert got == want, (saved, key, got)
        assert type(got) is str, got


def kind_jev_unrouted():
    """A Jev-only no-route travels back as route "" (not a menu id -> the
    graph's conditional edge goes to END) with the message."""
    ns = namespace()
    urllib.request.urlopen = FakeHTTP(answer("unclear", 1.0))
    set_env(JEV_API_KEY="test-key")
    out, _ = run_dispatcher_node(ns, None, "jev", "Framed request")   # no model: Jev never builds one
    msg = 'Not classified: dispatcher "techBuddy" did not route the request (jev: unclear: the request names no branch).'
    assert out == {"text": msg, "route": "", "notes": "", "status": "unrouted"}, out
    assert out["route"] not in {t["id"] for t in TARGETS}, "no branch may run"


def kind_unset_no_key():
    """An unset dispatcher without any decision key -> the model."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    urllib.request.urlopen = http
    set_env()
    llm = FakeLLM()
    out, _ = run_dispatcher_node(ns, llm, "", "Framed request")
    assert http.requests == [] and llm.calls == 1 and out["route"] == "4", out


def kind_llm_mode():
    """The node passes routing_mode through -> no Jev call."""
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    urllib.request.urlopen = http
    set_env(JEV_API_KEY="test-key")
    llm = FakeLLM()
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


def jev_unclear_branch(body, unclear_branch, expect_route, key="test-key"):
    """unclear / low_confidence go to the unclear branch (by name) while it is on the menu;
    a failure never does."""
    ns = namespace()
    out, llm_calls, log = run_dispatcher(ns, FakeHTTP(body), key=key, routing_mode="jev", unclear_branch=unclear_branch)
    assert llm_calls == 0, "the unclear branch is a route, not a model fallback"
    assert out["route"] == expect_route, out
    if expect_route:
        assert out["status"] == "ok" and "sent to the unclear branch" in log, (out, log)


case(lambda: jev_unclear_branch(answer("unclear", 0.7), "IT claims", "3"))
case(lambda: jev_unclear_branch(answer("IT claims", 0.4), "IT claims", "3"))
case(lambda: jev_unclear_branch(answer("unclear", 1.0), "Deleted branch", ""))
case(lambda: jev_unclear_branch(answer("IT claims", 0.99), "IT claims", "", key=None))
case(lambda: jev_not_routed("unavailable: no JEV_API_KEY", body=answer("IT claims", 0.99), key=None, http_calls=0))
case(lambda: jev_not_routed("low_confidence: confidence 0.80 below floor 0.90", body=answer("IT claims", 0.8), floor=0.9))
case(lambda: jev_not_routed("error: <urlopen error timed out>", exc=urllib.error.URLError("timed out")))
case(custom_floor)
case(mode_resolution)
case(legacy_key)
case(row_key_wins)
case(unset_picks_first_keyed_candidate)
case(missing_provider)
if KIND is not None:
    case(kind_routed)
    case(kind_jev_unrouted)
    case(kind_llm_mode)
    case(kind_unset_no_key)
print(f"OK {cases} cases")
