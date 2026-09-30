"""Run generated LangGraph code against a stub chat model (no network).

  lg_run_probe.py workflow single  <file.py>      <prompt>
  lg_run_probe.py workflow modular <package root> <prompt>
  lg_run_probe.py node module <package root> <agents.module> <request>
  lg_run_probe.py node a2a    <agent file.py>                <request>
  lg_run_probe.py save <file.py | package root> <output text>   (from Task 5: save_output)
  lg_run_probe.py llm  <file.py> <cfg json>                     (no stub: build cfg's model, report the error)
  lg_run_probe.py llm-args <file.py>                            (records what _make_llm passes each provider class)
  lg_run_probe.py mcp  <file.py>                                (a local SSE MCP server; two tool calls)
The stub answers "answer to: <last 40 chars of the request>". Bound to route_to it routes to
$STUB_ROUTE_TO; bound to run_skill_script with $STUB_SKILL_CALL (JSON args) set, it calls that
tool once and then answers. $STUB_BLOCK_IMPORT=<module> makes that import fail (missing package).
Prints the code's own console lines, then one line: RESULT <json>.
"""
import asyncio, importlib, importlib.util, json, os, sys

if os.environ.get("STUB_BLOCK_IMPORT"):
    sys.modules[os.environ["STUB_BLOCK_IMPORT"]] = None     # `import x` now raises ImportError

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult


class StubChatModel(BaseChatModel):
    """The smallest model create_agent() and a bound route_to call will drive."""
    tool_names: list = []

    @property
    def _llm_type(self) -> str:
        return "stub"

    def bind_tools(self, tools, **kwargs):
        return self.model_copy(update={"tool_names": [getattr(t, "name", "") for t in tools]})

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        route, skill = os.environ.get("STUB_ROUTE_TO"), os.environ.get("STUB_SKILL_CALL")
        if "route_to" in self.tool_names and route:
            msg = AIMessage(content="", tool_calls=[{"name": "route_to", "args": {"target": route, "notes": ""}, "id": "r1"}])
        elif "run_skill_script" in self.tool_names and skill and not any(isinstance(m, ToolMessage) for m in messages):
            msg = AIMessage(content="", tool_calls=[{"name": "run_skill_script", "args": json.loads(skill), "id": "s1"}])
        else:
            last = messages[-1].content if messages else ""
            msg = AIMessage(content=f"answer to: {str(last)[-40:]}")
        return ChatResult(generations=[ChatGeneration(message=msg)])


def load_file(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


async def trace(line):
    print(f"[node] [probe] {line}", flush=True)


def main():
    cmd, *args = sys.argv[1:]
    stub = lambda *a, **k: StubChatModel()
    match cmd:
        case "workflow":
            kind, target, prompt = args
            if kind == "single":
                mod = load_file(target, "lg_single")
                mod._make_llm = stub
                out = asyncio.run(mod.run(prompt))
            else:
                sys.path.insert(0, target)
                importlib.import_module("common")._make_llm = stub
                out = asyncio.run(importlib.import_module("workflow").run(prompt))
            print("RESULT " + json.dumps({"output": out}))
        case "node":
            kind, *rest = args
            if kind == "module":
                root, module, request = rest
                sys.path.insert(0, root)
                importlib.import_module("common")._make_llm = stub
                mod = importlib.import_module(module)
            else:
                path, request = rest
                mod = load_file(path, "lg_agent")
                mod._make_llm = stub
            print("RESULT " + json.dumps(asyncio.run(mod.run_node(request, trace))))
        case "save":
            target, text = args
            if os.path.isdir(target):
                sys.path.insert(0, target)
                mod, wf = importlib.import_module("common"), importlib.import_module("workflow")
            else:
                mod = wf = load_file(target, "lg_single")
            path = mod.save_output(text, enabled=True, folder=None, workflow_id=wf.WORKFLOW_ID, workflow_name=wf.WORKFLOW_NAME)
            print("RESULT " + json.dumps({"path": path}))
        case "llm":
            path, cfg = args
            mod = load_file(path, "lg_single")
            node = mod.make_node(json.loads(cfg))
            try:
                node.llm
                print("RESULT " + json.dumps({"error": None}))
            except Exception as e:
                print("RESULT " + json.dumps({"error": f"{type(e).__name__}: {e}"}))
        case "llm-args":
            (path,) = args
            mod = load_file(path, "lg_single")
            import types
            seen = []

            class Recorder:
                """Stands in for a LangChain chat-model class: records the arguments the factory passes."""
                def __init__(self, **kwargs):
                    seen.append(kwargs)
            sys.modules["langchain_openai"] = types.SimpleNamespace(ChatOpenAI=Recorder)
            sys.modules["langchain_anthropic"] = types.SimpleNamespace(ChatAnthropic=Recorder)
            mod._make_llm("deepseek", "deepseek-v4-flash", 0.7, 100, "on")
            mod._make_llm("deepseek", "deepseek-v4-flash", 0.7, 100, "off")
            mod._make_llm("kimi", "kimi-k2-x", 0.3, 100, None)
            mod._make_llm("claude", "claude-x", 0.5, 100, None)
            print("RESULT " + json.dumps(seen, default=str))
        case "mcp":
            (path,) = args
            mod = load_file(path, "lg_single")
            import http.server, threading
            calls = {"initialize": 0}

            class Handler(http.server.BaseHTTPRequestHandler):
                """A one-tool MCP server answering in SSE form, counting handshakes."""
                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    if body.get("method") == "initialize":
                        calls["initialize"] += 1
                    result = {"content": [{"type": "text", "text": "news ok"}]} if body.get("method") == "tools/call" else {}
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(("data: " + json.dumps({"jsonrpc": "2.0", "id": body.get("id"), "result": result}) + "\n\n").encode())

                def log_message(self, *a):
                    pass
            srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            url = f"http://127.0.0.1:{srv.server_address[1]}/srv.php"      # .php = already the endpoint
            call = mod.MCP.call_tool if hasattr(mod, "MCP") else mod._call_mcp_tool
            texts = [call(url, "get_news", {}), call(url, "get_news", {})]
            print("RESULT " + json.dumps({"texts": texts, "initialize": calls["initialize"]}))


main()
