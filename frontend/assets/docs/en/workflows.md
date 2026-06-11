# Workflows

Build automated multi-step pipelines that orchestrate AI agents and tools.

![Workflow editor screenshot](assets/docs/images/workflow.png)

## Visual editor

Workflows are built in a **drag-and-drop editor** (drawflow). Each node is an agent, a tool call, a document attachment, or an output formatter. Connect nodes to define the flow.

## Execution

Run workflows two ways:

- **On demand** — click "Run" from the editor or sidebar.
- **Scheduled** — cron-style schedules (e.g., every weekday at 9 AM).

## Outputs

Outputs can be displayed two ways:

- **Inline** in the chat as a normal response.
- **Written to a folder** on your computer (the same folder browsed via File Storage).

## Structured outputs

Each node can be paired with a **JSON Schema** for constrained decoding — guarantees the output matches a defined shape, useful for downstream processing.

## Compile to Python

Any workflow can be **compiled into a standalone Python application**. The generated script uses LangGraph and can run independently of the web app — useful when you want to ship a workflow as a CLI or scheduled script.

## Node types

- **Agent** — runs an LLM call with specific instructions.
- **Tool call** — invokes a built-in tool or MCP server tool.
- **Document** — attaches PDFs, Office docs, etc., as context.
- **Schema** — applies a JSON Schema to constrain output shape.
- **Output** — writes results inline, to a file, or to both.
