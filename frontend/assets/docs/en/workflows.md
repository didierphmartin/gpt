# Workflows

Build multi-step pipelines of AI agents, routing, procedures and code; test them step by step in the editor; then run them here or compile them into standalone Python for the agent framework of your choice.

![Workflow editor screenshot](assets/docs/images/workflow.png)

## Visual editor

Workflows are built in a **drag-and-drop editor**. Drag nodes from the palette — Start, Agent, Playbook, Code, Output, ingestion and realtime audio nodes — and connect them to define the flow. See *Node types* below.

## Execution

Start a workflow three ways:

- **On demand** — type a prompt and run it from the editor or the sidebar.
- **Scheduled** — cron-style schedules (e.g., every weekday at 9 AM).
- **On an event** — new mail, a new ServiceNow job, a file dropped in a folder… (see *Start options* below).

The same canvas can run in three places:

- **In the editor** — the browser runs the workflow node by node. This is where you design and debug.
- **On the server** — scheduled and event runs, and the runs of an activated workflow.
- **Compiled** — the generated Python runs on your computer through the local runner (see *Compile to Python*).

Only the nodes connected to **Start** run. A node left unconnected on the canvas is ignored, so you can keep one aside and compare a run with and without it.

## Debugging a run

- Click a node after a run to see its **Input**, **Output** and **Logs**.
- A dispatcher's chosen branch shows its output; the other branches are greyed as **skipped**.
- Server, scheduled and compiled runs can be followed **live**: the run's events appear as they happen, and stay in the run log afterwards.
- Run the workflow in the editor first, then compiled: both report the same events, so you can check the compiled code does what you designed.

## Outputs

Outputs can be displayed two ways:

- **Inline** in the chat as a normal response.
- **Written to a folder** on your computer (the same folder browsed via File Storage).

## Structured outputs

Each node can be paired with a **JSON Schema** for constrained decoding — guarantees the output matches a defined shape, useful for downstream processing.

## Event triggers

Instead of a time, a schedule can wait for an **event**: set *Repeat* to **On event (MCP tool)** and choose an MCP server and its trigger tool — e.g. *Outlook* → *wait_for_new*, which answers as soon as new mail arrives. *Tool arguments* is the tool's JSON input, e.g. `{"args": {"folder": "Inbox"}}` for the folder a *Poll Outlook* node reads (`{}` = Inbox).

- The compiled Python script runs it: `python <file> --watch` waits on that tool and runs the workflow each time it answers *ready*, then again until nothing is left.
- Once a workflow is activated with ▶ on Start, it runs on its own (see *Activating a workflow* below).
- For Outlook, the notifications come through Azure Event Hubs (see the Outlook server's README). Without them, the tool still answers every 15 minutes.

### Start options

The Start node lists how the workflow starts: **Enter Prompt**, **Set Schedule**, and every **event option** you added. They are radio buttons: one is chosen at a time; choosing another switches to it.

- **Enter Prompt / Set Schedule:** click the text to switch to it and open the prompt box or the schedule fields (run at, repeat, cron). Set Schedule stays chosen once the schedule is saved. Choosing Enter Prompt (or an event option) instead deletes the schedule.
- **Add an option:** drag a component from the Code Library onto any Start node. Choose the wait tool (for Outlook, `wait_for_new`), its arguments and the exit that carries work. Every workflow's Start then lists it.
- **Use it:** choose the option on Start. Start becomes the component: it shows one connector per exit (for Outlook, `new_mail`, `no_mail`, `error`), and you link each one to what should happen next. The workflow runs when the event arrives; what leaves a connector (the email on `new_mail`) is the next node's input. Start's existing links move to the exit that carries work.
- **Switch back:** choose Enter Prompt or Set Schedule. Start goes back to one connector: the links on the exit that carries work stay, the others are removed. A warning lists them first; Cancel changes nothing.
- **Edit or remove it:** the component is edited only in the Code Library, and every Start using it follows. If a save removes exits that workflows link from, a warning lists those workflows and links first. ⋮ on the component → Edit Start option or Remove Start option; removing it turns those Starts back into a plain Start.

#### Activating a workflow

Choosing an input mode only selects it. To make a workflow run on its own, click ▶ on Start:

- **Enter Prompt:** ▶ opens the conversation, as before.
- **Set Schedule** or a **code option** (for example "Outlook: Get New Email"): ▶ activates the workflow. The event
  service runs it at its scheduled times, or waits for the event and runs it on each one. ■ deactivates it.

Only one workflow is active at a time: activating another one deactivates the first (you are asked first). Changing
the active workflow's input mode deactivates it. A Start with no links cannot be activated. Start shows the state:
*Listening for events*, *Running…*, *Active — next run …*, *Not listening:* and the reason, or *Event service isn't
running* when the background service is stopped.

Any MCP server can be an event source for a code option if it offers a waiting tool that answers
`{"status": "ready"}` or `{"status": "timeout"}`, like Outlook's `wait_for_new`.

## Compile to Python

Any workflow can be **compiled into standalone Python** for one of four agent frameworks. Use **Compile workflow** in the toolbar and pick a target:

- **LangGraph**
- **ADK** (Google Agent Development Kit)
- **MAF** (Microsoft Agent Framework)
- **NOOA** (NVIDIA OO Agents)

Each target's menu has **Setup** (the one-time steps to add that framework to your local runner), **Generate**, **Info**, **Run**, **Stop**, **Display Code**, **Export** (a zip) and **Architecture** (a description of the generated code).

Choose a layout in the code generation options:

- **Single file** — the whole workflow in one `.py` file.
- **Agents in separate files** — a Python package with one module per agent.
- **A2A** — one Agent-to-Agent server per node, plus an orchestrator.

The generated code does not need this app to run: it carries its own MCP client, code node harness, playbook interpreter and routing. Server addresses and connection headers go in its `.env` file. The editor writes it to `python/scripts/` in your local folder, and the local runner runs it on your computer, so a workflow can read your files and ask you questions while it runs.

If a target can't do something the workflow uses (a swarm outside LangGraph, for example), compiling says which node and why instead of producing code that half works. **Recompile after changing the workflow.**

## Node types

- **Start** — how the workflow starts: a prompt, a schedule or an event (see *Start options*).
- **Agent** — an LLM call with its own instructions, provider, tools, MCP servers and skills.
- **Dispatcher** — an agent set to type *Dispatcher*: sends each request to exactly one of the branches connected after it (see below).
- **Playbook** — an agent set to type *Playbook*: follows a written procedure step by step, with **gates** that ask a person to fill a form, approve or take over. The questions appear in the conversation; an unattended run ends cleanly at a gate.
- **Code** — Python `run(input, call_tool)` that calls MCP tools directly, with named **exits**: only the nodes on the exit taken run next (see *Code node*).
- **Output** — returns the answer, inline, to a file, or both. Each node can also have a **JSON Schema** for structured output.
- **Ingestion** — Loader → Splitter → Vector store, to index documents.
- **Realtime** — voice nodes for realtime audio conversations.

## Code node

Open a code node with its ✏️ pencil:

- **Code** — write `def run(input, call_tool)`. `call_tool("<server>", "<tool>", {...})` calls a tool on a checked MCP server. The **Assistant** under the code can write it for you from the servers' tool documentation; review the comparison, then **Accept** or **Discard**.
- **MCP Servers** — check the servers the code may call.
- **Tools** — what each checked server's tools take and return. Nothing is called.
- **Settings** — the name, the **exits** (comma-separated, one connector each; empty = the output goes to the next node) and the timeout. The code can read `NODE_NAME`.
- **Input / Output / Logs** — the last run of this node.

The code runs in your browser when you run the workflow in the editor, and in the compiled program otherwise, with the same rules: modules that reach the network or the system directly are refused, tools go through `call_tool`.

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
- A Code node's code can read `NODE_NAME`, its name on the canvas. One Code Library component can then serve every branch: for example it files the email into `"Inbox/" + NODE_NAME`, so the *claims* branch files into Inbox/Claims (folder names are matched without regard to case).

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
