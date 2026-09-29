"""Exercise the generated dispatcher runtime's Jev fast path (LangGraphGenerator::dispatchBlock).

Usage: python3 jev_dispatch_harness.py <extracted_block.py> [<run_dispatcher_kind.py>]

The block is the slice of a generated LangGraph file from the JEV_URL constants
through the end of _run_dispatcher(). It is exec'd into a namespace with stubs
for the LangChain/pydantic names the model path touches, so this needs only the
standard library. urllib.request.urlopen is monkeypatched: no network.
The optional second file is the A2A/modular wrapper _run_dispatcher_kind(),
sliced from an agent file; when given, a routed case runs through it too.

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
from contextlib import redirect_stdout
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
    ns = {"asyncio": asyncio, "json": json, "os": os, "time": time, "Literal": Literal, "END": END,
          "create_model": lambda *a, **k: object, "Field": lambda *a, **k: None, "StructuredTool": _Tool,
          "NODE_DURATIONS": {}, "parents": lambda n: ["1"]}
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


def run_dispatcher(ns, http, key="test-key"):
    urllib.request.urlopen = http
    if key is None:
        os.environ.pop("TYPESAFE_API_KEY", None)
    else:
        os.environ["TYPESAFE_API_KEY"] = key
    llm = FakeLLM(ns)
    ad = {"display": "techBuddy", "dispatch": TARGETS, "jev_question": QUESTION}
    state = {"node_outputs": {"1": {"source": "Start", "text": "My laptop will not boot"}}, "user_prompt": "x"}
    buf = io.StringIO()
    with redirect_stdout(buf):
        out = asyncio.run(ns["_run_dispatcher"]("2", ad, state, [], llm))
    run_dispatcher.last_llm = llm
    return out, llm.calls, buf.getvalue()


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
    assert out == {"node_outputs": {"2": {"source": "techBuddy", "text": "My laptop will not boot"}},
                   "routes": {"2": "3"}}, out
    assert "Jev routed to 'IT claims' (confidence 0.97, " in log and "ms, no LLM turn)" in log, log
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
                             "unclear": ns["JEV_UNCLEAR_DESC"]}, q["criteria"]
    r = ns["_jev_route"]("x", TARGETS, QUESTION)
    assert r["outcome"] == "routed" and r["target"]["id"] == "3" and r["usage"]["input_tokens"] == 12, r


def falls_through(body=None, exc=None, outcome=""):
    ns = namespace()
    http = FakeHTTP(body, exc)
    out, llm_calls, log = run_dispatcher(ns, http)
    assert llm_calls == 1, f"{outcome}: the model must decide"
    assert out["routes"] == {"2": "4"}, out
    assert out["node_outputs"]["2"]["text"].endswith("## Dispatcher notes\nfrom the model"), out
    assert f"Jev declined ({outcome}: " in log and "asking the model" in log, log
    # Jev's wall time is counted even when it declines (before the model runs).
    assert "techBuddy" in (run_dispatcher.last_llm.durations_at_call or {}), "declined Jev time not counted"
    r = ns["_jev_route"]("x", TARGETS, QUESTION)
    assert r["outcome"] == outcome, r


def no_key():
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    out, llm_calls, log = run_dispatcher(ns, http, key=None)
    assert http.requests == [], "no key must not call HTTP"
    assert llm_calls == 1 and out["routes"] == {"2": "4"}, out
    assert "Jev" not in log, log
    assert run_dispatcher.last_llm.durations_at_call == {}, "no key must not touch NODE_DURATIONS before the model"
    assert ns["_jev_route"]("x", TARGETS, QUESTION)["outcome"] == "unavailable"
    os.environ["TYPESAFE_API_KEY"] = ""
    out, llm_calls, log = run_dispatcher(ns, http, key="")
    assert http.requests == [] and llm_calls == 1 and "Jev" not in log


def refusals():
    ns = namespace()
    http = FakeHTTP(answer("IT claims", 0.99))
    urllib.request.urlopen = http
    os.environ["TYPESAFE_API_KEY"] = "k"
    r = ns["_jev_route"]("x", [{"id": "1", "name": "Unclear"}, TARGETS[0]], QUESTION)
    assert r["outcome"] == "error" and "unusable target name" in r["reason"], r
    r = ns["_jev_route"]("x", [TARGETS[0]], QUESTION)
    assert r["outcome"] == "error" and "at least two" in r["reason"], r
    assert http.requests == [], "refusals happen before any HTTP"
    long = [{"id": "1", "name": "A", "description": "d" * 900}, {"id": "2", "name": "B"}]
    ns["_jev_route"]("x", long, QUESTION)
    crit = json.loads(http.requests[0][0].data)["questions"]["route"]["criteria"]
    assert crit["A"] == "d" * 400 and crit["B"] == "B", crit


def hung():
    """A Jev call that never returns (DNS, a stalled read) is cut off by
    asyncio.wait_for(JEV_TIMEOUT_S + 1) and lands in the model path."""
    ns = namespace()
    ns["JEV_TIMEOUT_S"] = 0   # -> wait_for bound of 1s
    ns["_jev_route"] = lambda *a: (time.sleep(2), {"outcome": "routed"})[1]
    t0 = time.monotonic()
    out, llm_calls, log = run_dispatcher(ns, FakeHTTP(answer("IT claims", 0.99)))
    assert llm_calls == 1 and out["routes"] == {"2": "4"}, out
    assert "Jev declined (error: TimeoutError" in log and "no answer within 1s" in log, log
    assert ns["NODE_DURATIONS"]["techBuddy"] >= 1.0, ns["NODE_DURATIONS"]


def kind_routed():
    """A2A / modular: _run_dispatcher_kind carries the route id back as "route"."""
    ns = namespace()
    urllib.request.urlopen = FakeHTTP(answer("IT claims", 0.97))
    os.environ["TYPESAFE_API_KEY"] = "test-key"
    llm = FakeLLM(ns)
    ns["NODE"] = {"display": "techBuddy", "dispatch": TARGETS, "jev_question": QUESTION}
    ns["_llm"] = lambda: llm
    ns["parents"] = lambda n: []   # agent file / module: no graph
    exec(compile(KIND, "dispatcher_kind", "exec"), ns)
    buf = io.StringIO()
    with redirect_stdout(buf):
        out = asyncio.run(ns["_run_dispatcher_kind"]("Framed request: my laptop will not boot", []))
    assert llm.calls == 0, "routed must not spend an LLM turn"
    assert out == {"text": "Framed request: my laptop will not boot", "route": "3", "notes": "", "status": "ok"}, out
    assert "Jev routed to 'IT claims'" in buf.getvalue()


case(routed)
case(lambda: falls_through(answer("unclear", 1.0), outcome="unclear"))
case(lambda: falls_through(answer("IT claims", 0.46), outcome="low_confidence"))
case(lambda: falls_through(exc=urllib.error.URLError("timed out"), outcome="error"))
case(lambda: falls_through(body=b"<html>not json</html>", outcome="error"))
case(lambda: falls_through(answer("Sales", 0.99), outcome="error"))   # off-menu answer is never trusted
case(no_key)
case(refusals)
case(hung)
if KIND is not None:
    case(kind_routed)
print(f"OK {cases} cases")
