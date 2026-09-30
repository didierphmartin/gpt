"""Run generated LangGraph code against a stub chat model (no network).

  lg_run_probe.py workflow single  <file.py>      <prompt>
  lg_run_probe.py workflow modular <package root> <prompt>
  lg_run_probe.py node module <package root> <agents.module> <request>
  lg_run_probe.py node a2a    <agent file.py>                <request>
  lg_run_probe.py save <file.py | package root> <output text>   (from Task 5: save_output)
  lg_run_probe.py llm  <file.py> <cfg json>                     (no stub: build cfg's model, report the error)
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


main()
