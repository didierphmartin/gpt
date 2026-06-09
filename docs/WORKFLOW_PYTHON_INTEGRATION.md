# Workflow Python Integration

How to use workflows defined in this app from an external Python program.

Two integration modes are supported:

1. **Call the REST API** — workflow executes on this server, Python is a thin client.
2. **Generate standalone LangGraph Python** — the app exports a self-contained `.py` file that runs anywhere, and **can be imported as a library** by other Python code.

---

## Mode 1 — REST API

**When to use:** your app is a thin client; workflows, agent templates, credentials, and tool servers all live on this backend.

### Authenticate (once)

```python
import requests

BASE = "https://your-host/api/v1"

token = requests.post(f"{BASE}/auth/login", json={
    "email": "you@example.com",
    "password": "…",
}).json()["token"]

headers = {"Authorization": f"Bearer {token}"}
```

### Run a workflow (blocking)

`POST /api/v1/workflows/{id}/run` — returns the final output in JSON once complete.

```python
r = requests.post(
    f"{BASE}/workflows/42/run",
    headers=headers,
    json={"variables": {"topic": "GLP-1 agonists and cardiovascular outcomes"}},
)
r.raise_for_status()
payload = r.json()
print(payload["output"])
```

Request body accepts either `variables` or `inputs` (alias). Keys become substitution variables in the Start node's user prompt template.

### Stream node-by-node events

`POST /api/v1/workflows/{id}/run-stream` — SSE stream with `node_start` / `node_complete` / `workflow_complete` / `error` events.

```python
import json

with requests.post(
    f"{BASE}/workflows/42/run-stream",
    headers=headers,
    json={"variables": {"topic": "…"}},
    stream=True,
) as r:
    for line in r.iter_lines():
        if not line or not line.startswith(b"data: "):
            continue
        event = json.loads(line[6:])
        if event.get("type") == "node_complete":
            print(f"[{event['node_id']}] {event.get('agent_name')} done")
        elif event.get("type") == "workflow_complete":
            print("FINAL:", event.get("output"))
```

---

## Mode 2 — Generated LangGraph Python (standalone)

**When to use:** airgapped / offline / embedded in a Python pipeline / no dependency on this PHP backend at runtime.

### Generate and download

```bash
curl -H "Authorization: Bearer $JWT" \
     "https://your-host/api/v1/workflows/42/generate-python?download=1" \
     -o pubmed_workflow.py
```

The downloaded file is **self-contained**. It bakes in:

- `AGENTS` — one entry per agent node, with `display`, `system_prompt` (system prompt + appended `## Skill` section), and `tool_names`.
- `TOOL_CATALOG` — MCP tool definitions and URLs.
- `NODE_TYPES`, `EDGES`, `ORDER` — the graph structure.
- `START_DOCUMENTS` — any documents attached to the Start node.
- `DEFAULT_PROMPT` — baked from the Start node's user prompt config.

### Install runtime dependencies

```bash
pip install langgraph langchain-anthropic langchain-core
# (add `requests` if your workflow uses MCP tools)
export ANTHROPIC_API_KEY=sk-…
```

### Run from the CLI

```bash
python pubmed_workflow.py "GLP-1 agonist trials 2024"
```

Writes a timestamped markdown result alongside the script.

---

## Using the generated file as a Python library

The generator exposes a top-level `async def run(user_prompt: str) -> str` and keeps CLI bootstrap under `if __name__ == "__main__":`. **Importing the file does not execute the workflow.**

### Basic import

```python
# your_app.py — same folder as pubmed_workflow.py, or anywhere on PYTHONPATH
import asyncio
from pubmed_workflow import run

async def main():
    return await run("Latest RCTs on GLP-1 and cardiovascular outcomes")

report = asyncio.run(main())  # returns the Output node's final_output (str)
print(report)
```

### Sync wrapper (Flask / Django / CLI scripts)

```python
import asyncio
from pubmed_workflow import run

def run_sync(prompt: str) -> str:
    return asyncio.run(run(prompt))
```

### Multiple workflows in the same process

```python
import asyncio
from pubmed_workflow import run as run_pubmed
from crypto_workflow import run as run_crypto

async def main():
    pubmed, crypto = await asyncio.gather(
        run_pubmed("GLP-1 trials"),
        run_crypto("ETH staking regulation in EU"),
    )
    return pubmed, crypto

asyncio.run(main())
```

### Introspection without running

Every module-level constant is importable on its own:

```python
from pubmed_workflow import AGENTS, TOOL_CATALOG, EDGES, ORDER, DEFAULT_PROMPT

for nid, a in AGENTS.items():
    print(nid, "→", a["display"], "tools:", a["tool_names"])
```

Useful for auditing what's in a generated workflow, diffing versions, or rendering a UI over it.

---

## Environment & gotchas

| Item | Notes |
|---|---|
| **API key** | `ANTHROPIC_API_KEY` must be in `os.environ` before `run()` is called. Set it once at process start. |
| **MCP URLs** | Baked at generation time. If an MCP server moves, regenerate. To override at runtime, monkey-patch `TOOL_CATALOG[tool_name]["url"]` before calling `run()`. |
| **Module name** | The downloaded filename becomes the Python module name. Python module rules apply (no hyphens, must start with a letter). Rename e.g. `My Workflow.py` → `my_workflow.py` before importing. |
| **Concurrency** | `run()` compiles a fresh graph each call — correct but redundant for high-throughput callers. If you need it, a `build_app()` helper that compiles once can be added to the generator. |
| **Structured output** | If a node has an output schema configured in the app, the agent is instructed to emit JSON matching it. The generated file still returns a string — parse it with `json.loads()` on your side if you need a dict. |
| **Tracing** | Standard `print("[node] ...")` lines go to stdout. Redirect via `contextlib.redirect_stdout` if you need to capture them. |

---

## Picking the right mode

| Requirement | Mode 1 (REST) | Mode 2 (import) |
|---|---|---|
| Latest workflow definition always wins | ✅ | Needs regen |
| No dependency on this PHP backend at runtime | ❌ | ✅ |
| Live node-by-node event stream | ✅ | Via stdout lines |
| Version-controlled alongside your Python project | ❌ | ✅ |
| Runs in a notebook / Airflow / cron / Lambda | Possible | ✅ |
| Embedded credentials on caller | JWT | `ANTHROPIC_API_KEY` |

Both modes are supported simultaneously — nothing stops you using REST for development and the exported `.py` for production.

---

## Reference

- Backend entry points: `backend/src/AgentTeam/Controllers/WorkflowController.php` — `run()`, `runStream()`, `generatePython()`.
- Code generator: `backend/src/AgentTeam/Services/LangGraphGenerator.php` — produces the Python file.
- Routes: `backend/src/routes.php` — lines 233, 236, 237.
- Agent-execution composition (system prompt + skill + merged data): `backend/src/AgentTeam/Services/GraphWorkflowRunner.php::executeAgentNode`.
