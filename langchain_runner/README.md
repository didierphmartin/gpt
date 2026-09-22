# LangChain Workflow Runner (prototype)

Runs a saved **batch workflow** from the PHP backend as a LangGraph graph in Python.
MCP tools are invoked through the backend's existing `/api/v1/mcp/proxy` route, so
no direct MCP transport handling is needed here.

## Scope (v1)

- Node types: `start`, `agent`, `output` (linear traversal)
- LLM: Anthropic Claude only
- Auth: JWT pasted in UI (sent with every backend call)
- Logs: per-node + per-tool-call, streamed over SSE

## Setup

```bash
cd langchain_runner
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...
# optional: GPT_BACKEND_URL prepopulates the form
export GPT_BACKEND_URL=http://localhost/gpt/backend

python main.py
```

Then open `index.html` directly in your browser (double-click, or any static
server). It calls the FastAPI endpoints via CORS — no Python templating
involved. Default API URL in the form is `http://127.0.0.1:8765`.

## Flow

1. Enter backend URL + JWT, click **Load workflows**.
2. Pick a workflow, enter a user prompt, click **Run**.
3. Logs stream live: graph build, node execution, MCP tool calls + results.
4. Final output lands in the right pane.

## What this is not (yet)

- No condition / switch / parallel nodes
- No prompt-template variable substitution
- No multi-provider (only Anthropic)
- No static code generation — this **interprets** the workflow directly.
  Converting that to a static generator (emit `.py` files per workflow) is the
  next step once this runtime matches the PHP output.

## Files

- `main.py` — FastAPI + SSE
- `workflow_loader.py` — pulls workflow, agents, MCP tools from PHP
- `mcp_tools.py` — wraps MCP tools as LangChain `StructuredTool`s via proxy
- `graph_builder.py` — builds + runs a LangGraph from the workflow graph
- `templates/index.html` — one-page UI
