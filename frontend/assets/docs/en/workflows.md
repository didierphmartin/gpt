# Workflows

Build automated multi-step pipelines that orchestrate AI agents and tools.

![Workflow editor screenshot](assets/docs/images/workflow.png)

## Visual editor

Workflows are built in a **drag-and-drop editor** (drawflow). Each node is an agent, a tool call, a document attachment, or an output formatter. Connect nodes to define the flow.

## Execution

Run workflows two ways:

- **On demand** — click "Run" from the editor or sidebar.
- **Scheduled** — cron-style schedules (e.g., every weekday at 9 AM).

Only the nodes connected to **Start** run. A node left unconnected on the canvas is ignored, so you can keep one aside and compare a run with and without it.

## Outputs

Outputs can be displayed two ways:

- **Inline** in the chat as a normal response.
- **Written to a folder** on your computer (the same folder browsed via File Storage).

## Structured outputs

Each node can be paired with a **JSON Schema** for constrained decoding — guarantees the output matches a defined shape, useful for downstream processing.

## Event triggers

Instead of a time, a schedule can wait for an **event**: set *Repeat* to **On event (MCP tool)** and choose an MCP server and its trigger tool — e.g. *Outlook* → *wait_for_new*, which answers as soon as new mail arrives. *Tool arguments* is the tool's JSON input, e.g. `{"args": {"folder": "Inbox"}}` for the folder a *Poll Outlook* node reads (`{}` = Inbox).

- The compiled Python script runs it: `python <file> --watch` waits on that tool and runs the workflow each time it answers *ready*, then again until nothing is left.
- In the app, an event schedule does not run on its own yet.
- For Outlook, the notifications come through Azure Event Hubs (see the Outlook server's README). Without them, the tool still answers every 15 minutes.

### Start options

The Start node lists how the workflow starts: **Enter Prompt**, **Set Schedule**, and every **event option** you added. One is ticked at a time; ticking another switches to it.

- **Enter Prompt / Set Schedule:** click the text to switch to it and open the prompt box or the schedule fields (run at, repeat, cron). Set Schedule stays ticked once the schedule is saved. Unticking it goes back to Enter Prompt and deletes the schedule.
- **Add an option:** drag a component from the Code Library onto any Start node. Choose the wait tool (for Outlook, `wait_for_new`), its arguments and the exit that carries work. Every workflow's Start then lists it.
- **Use it:** tick the option on Start. Start becomes the component: it shows one connector per exit (for Outlook, `new_mail`, `no_mail`, `error`), and you link each one to what should happen next. The workflow runs when the event arrives; what leaves a connector (the email on `new_mail`) is the next node's input. Start's existing links move to the exit that carries work.
- **Switch back:** tick Enter Prompt or Set Schedule. Start goes back to one connector: the links on the exit that carries work stay, the others are removed. A warning lists them first; Cancel changes nothing.
- **Edit or remove it:** the component is edited only in the Code Library, and every Start using it follows. If a save removes exits that workflows link from, a warning lists those workflows and links first. ⋮ on the component → Edit Start option or Remove Start option; removing it turns those Starts back into a plain Start.

## Compile to Python

Any workflow can be **compiled into a standalone Python application**. The generated script uses LangGraph and can run independently of the web app — useful when you want to ship a workflow as a CLI or scheduled script.

## Node types

- **Agent** — runs an LLM call with specific instructions.
- **Dispatcher** — an agent set to type *Dispatcher*: sends each request to exactly one of the branches connected after it (see below).
- **Tool call** — invokes a built-in tool or MCP server tool.
- **Document** — attaches PDFs, Office docs, etc., as context.
- **Schema** — applies a JSON Schema to constrain output shape.
- **Output** — writes results inline, to a file, or to both.

## Dispatcher node

A dispatcher reads the request and sends it to **one** of the nodes connected after it — its *branches*. The other branches do not run. Typical use: an email classifier with branches such as *claims*, *information* and *Miscellaneous*.

### What to set in the dispatcher's form

Open the dispatcher with its ✏️ pencil:

- **Type** — *Dispatcher*.
- **Routing** — who chooses the branch:
  - a **decision model** (e.g. *Jev*): very fast and cheap, and it can only answer with one of your branches. If it is unsure, it says so instead of guessing.
  - **LLM**: the dispatcher's own model chooses, and can add notes for the chosen branch.
  - **Default**: the first decision model your plan allows, otherwise the LLM.
- **Catch-all branch** (decision model only) — the branch that receives every message no category fits: the decision model is unsure, or its confidence is below the minimum. Pick any connected branch, whatever its name (*Miscellaneous*, *Other*, *Needs review*…). With **None**, such messages stop the run as *Not classified*.
- **Minimum confidence** (decision model only, default 0.6) — below this the answer is not trusted and the message goes to the catch-all branch. Lower it if clear requests keep missing their branch.
- **Description** — tell the decision model what each branch handles, e.g. *"claims: insurance claims and damage reports; information: questions about our services; Miscellaneous: anything else"*. This is the main thing that makes routing accurate.

### Branches

- Each branch is a node connected **after** the dispatcher, chosen by its **name** — give branches names that say what they handle.
- Keep **one** catch-all branch: two branches meaning "everything else" split the leftovers between them.
- Do not name a branch *unclear*: that word is reserved for the decision model's "I can't tell" answer.
- Connect every branch to **Output**, otherwise its answer never reaches the conversation.
- A branch can be an agent or a **Code** node. An agent receives the request with the dispatcher's notes; a Code node receives exactly what the dispatcher received (for example the email from a poll), so its code can use the email's fields such as `id`.

### On the canvas

- **1 of N** on the dispatcher — only one branch will run.
- The dispatcher's badge shows who routes (e.g. **Jev**, or the LLM provider).
- **catch-all** marks the catch-all branch; **⚠ no catch-all** warns that unclassified messages stop at this dispatcher.
- After a run, the chosen branch shows its output and logs; the other branches are greyed as **skipped**.

### Outcomes

- **Routed** — one branch runs.
- **Not classified** — no branch fits and there is no catch-all: the run ends there, normally (not an error).
- **Error** — the decision model could not be reached (no key, network). The run stops and says why.

Recompile a compiled (Python) workflow after changing these settings.

## Code components library

Save a code node to the **Code Library** (the node's *Save to library* button, or *New Code Component* in the sidebar) to reuse it in any workflow: drag it from the library onto a canvas. A placed component is a link: its code, exits, MCP servers and timeout belong to the component, and editing it (from any workflow or from the library) changes every workflow that uses it. For a variant — say another mail folder — save it under a new name. A component can't be deleted while a workflow uses it; *Used by* in its menu lists them.
