# AI Service Backend

Backend for SynergyAI / GPT — a multi-provider AI assistant. Provides a RESTful API for chat with Claude, OpenAI, Gemini, Grok, DeepSeek, and Kimi, plus tool execution, MCP server integration, agents, workflows, voice support, and per-user usage tracking.

This README is the single source of truth: it merges the previous `README.md` and `docs/API_DOCUMENTATION.md` into one document.

## Table of Contents

- [Project Structure](#project-structure)
- [Installation](#installation)
- [Configuration](#configuration)
- [Development](#development)
- [Tools & MCP Architecture](#tools--mcp-architecture)
- [LLM Invocation Paths & Frontend/Backend Cooperation](#llm-invocation-paths--frontendbackend-cooperation)
- [Voice Pricing](#voice-pricing)
- [API Reference](#api-reference)
- [Security Considerations](#security-considerations)
- [Next Steps](#next-steps)
- [Changelog](#changelog)

## Project Structure

```
backend/
├── api/              # API endpoint handlers
│   ├── chat.php      # Main chat endpoint
│   ├── auth.php      # Authentication
│   ├── providers.php # Provider management
│   ├── contexts.php  # Conversation history
│   └── prompt-library.php # Prompt templates
├── src/              # Core library code
│   ├── AIPortfolioAssistant.php # Main facade
│   ├── Providers/    # AI provider implementations
│   ├── Services/     # Business logic services
│   ├── Functions/    # LLM tool functions
│   ├── Models/       # Data models
│   └── ...
├── config/           # Configuration files
│   └── ai_config.php # API keys and settings
├── resources/        # Static resources
│   └── prompts/      # System prompts
├── tests/            # Unit and integration tests
├── examples/         # Usage examples
├── index.php         # API entry point & router
├── .htaccess         # Apache rewrite rules
└── composer.json     # Dependencies

```

## Installation

1. Install dependencies:
```bash
composer install --no-dev
```

2. Configure your API keys in `config/ai_config.php`

3. Ensure Apache mod_rewrite is enabled

4. Access the API at `http://localhost/gpt/backend`

## Configuration

Edit `config/ai_config.php` to configure:
- API keys for AI providers (Claude, OpenAI, etc.)
- Model selection
- Database connections
- Feature flags
- Voice provider settings (Grok, Gemini)

### Voice Provider Configuration

```php
// Grok Voice (xAI Realtime API) - for secure ephemeral token generation
// Available voices: Eve (energetic), Ara (warm), Rex (confident), Sal (balanced), Leo (authoritative)
'grok_voice' => [
    'api_key' => 'xai-your-api-key',  // Server-side only, never exposed
    'base_url' => 'https://api.x.ai',
    'client_secrets_endpoint' => '/v1/realtime/client_secrets',
    'default_voice' => 'Eve',
    'token_expiry_minutes' => 5,
],

// Gemini Voice (Google Live API)
'gemini_voice' => [
    'api_key' => 'AIza...',
    'model' => 'gemini-2.5-flash-native-audio-preview',
    'default_voice' => 'Zephyr',
],
```

**Important:** Never commit API keys to version control. Use environment variables in production.

## Development

### Running Tests
```bash
composer test
```

### With Coverage
```bash
composer test-coverage
```

## Tools & MCP Architecture

### Architecture Overview

The system supports two types of tools that LLMs can call:

1. **Built-in Tools** - Defined in `resources/claude_tools.json`, executed locally
2. **MCP Tools** - Loaded from external MCP (Model Context Protocol) servers

### Tool Execution Algorithm

When the LLM requests a tool call, the `CombinedToolsExecutor` routes execution:

```
1. Receive tool call request with function name and parameters
2. Check if function is an MCP tool (via MCPToolsLoader.isMCPTool())
   ├── YES: Route to MCP server via JSON-RPC
   │   - Look up server URL from mcp_servers table
   │   - Send tools/call request to MCP server
   │   - Parse response and return to LLM
   └── NO: Route to built-in ToolsManager
       - Execute registered PHP handler
       - Return result to LLM
3. Log execution in usage_transactions table
```

### MCP Tool Loading

MCP tools are loaded from two sources, both filtered through the visibility
cascade described below:

- **Global servers** (`mcp_servers.user_id IS NULL`) — available to any user
  whose role package allows the server's name (and not overridden off).
- **User-private servers** (`mcp_servers.user_id = caller_id`) — only that
  user sees them; package allowlist does not gate them.

Tools are prefixed with `mcp_` to avoid conflicts:
- MCP server tool `pubmed_search` → `mcp_pubmed_search`

### MCP Server Visibility Cascade

The set of MCP servers a user can use at chat time is resolved by a cascade.
Each layer is bounded by the layer above it (subtractive):

```
1. Role Package allowlist           — capabilities.mcp_servers per role
   ↓ filtered by
2. Per-user admin override          — user_mcp_overrides table
   (can disable a package-allowed   (no row → defer to package default)
    server for one user; admin
    grants beyond the package are
    ignored by the gpt_admin UI but
    still respected by the loader)
   ↓ filtered by
3. End-user chat preference         — not yet implemented; the chat UI
                                      currently consumes the admin-allowed
                                      set as a take-it-or-leave-it bundle
   ↓
Effective MCP server set used to load tools for the LLM.
```

**Resolution applied in two places:**

- `MCPToolsLoader::loadToolsForUser($userId, $packageAllowlist)` — runtime
  tool resolution at chat time. Reads `user_mcp_overrides` and applies the
  cascade in PHP; user-private servers always pass.
- `MCPServerController::list() / getTools() / getAllTools()` — chat-side
  picker endpoints. Same cascade so the UI shows what the LLM will actually
  load.

**Override semantics in `user_mcp_overrides`:**

| `allowed` | Effect |
|-----------|--------|
| `1` | Force-on for this user (admin grants beyond package). The admin UI in `gpt_admin` does not surface this path; it's preserved by the loader for legacy / manual rows. |
| `0` | Force-off for this user — server hidden even if the package allows it. |
| no row | Defer to the package allowlist. |

### Tool Definition Format

Both built-in and MCP tools use Claude's format:

```json
{
  "name": "tool_name",
  "description": "What the tool does",
  "input_schema": {
    "type": "object",
    "properties": {
      "param1": { "type": "string", "description": "..." }
    },
    "required": ["param1"]
  }
}
```

For OpenAI-compatible providers, tools are auto-converted:
- `input_schema` → `parameters`
- Wrapped in `{ "type": "function", "function": { ... } }`

### Conflict Resolution

If tool names conflict:
- MCP tools are checked **first** and take precedence
- Built-in tools are fallback
- Same tool name on multiple MCP servers: last loaded wins

### Client-side Tool Execution (Skills)

> **READ THIS BEFORE TOUCHING ANY TOOL-CALLING CODE.** This is the single most important architectural invariant in this codebase: **tools whose code lives in the user's browser are dispatched by the backend but executed by the frontend.** The LLM doesn't know or care — to it, `run_skill_script` is just another tool. But internally there is a strict split:
>
> - **Backend** owns the LLM bridge. It declares the tool's JSON Schema to the provider, parses the provider's `tool_use` response, decides whether the tool runs server-side or client-side, and (for client-side tools) **short-circuits without executing**, returning the pending call to the frontend.
> - **Frontend (Pyodide)** owns execution. When it receives a `pending_client_tool_call` / `client_tool_call` SSE event, it loads the script from the user's local skill folder, runs it inside the browser's WASM Python runtime, captures `{stdout, stderr, exitCode, outputs}`, and **re-POSTs `/chat`** with the result appended to `conversation_history` as a `role: "tool"` entry. The backend then feeds that result back to the LLM and the conversation continues.
>
> The user's files never leave their machine. The LLM never gets direct access to filesystem or network. The execution sandbox is the browser. Future contributors must preserve this split: anything that would cause the backend to read the user's local files or run their Python is a bug, not a feature.
>
> The allowlist of client-side tool names lives in `ClientSideToolsTrait::getClientSideToolNames()` (currently `['run_skill_script', 'discover_skill', 'Task']`). **All six providers `use` this trait**, so client-side interception is shared, not Claude-specific (see Key Design Decisions below).

Folder-backed Skills can ship executable Python scripts under their `scripts/` subdirectory (Anthropic's Skills spec). The scripts run in **Pyodide in the user's browser** — the backend never executes Python, it only declares the tool to the LLM and routes the call.

Pieces involved:

| Layer | Component | Role |
|-------|-----------|------|
| Frontend | `window.pyodideRunner` (`pyodide-runner.js`) | Lazy-loads Pyodide, mounts the skill folder via the File System Access API, runs the script, returns `{ stdout, stderr, exitCode, outputs }`. |
| Frontend | `chat.js::dispatchClientToolCall` | Receives `client_tool_call`; iterates over N `tool_uses` in the assistant turn, runs each via `pyodideRunner.runSkillScript(...)` **sequentially** (Pyodide is a single shared instance), then re-POSTs `/chat` once with all N `tool_results` paired by `tool_use_id`. |
| Frontend | `chat.js::_executeSingleClientToolCall` | Per-call execution body (Task / discover_skill / run_skill_script). Returns `{ toolResultPayload, followUpExtras }` to the outer dispatcher. |
| Frontend | `chat.js::_continueAfterClientToolResults` | Builds the continuation `/chat` request with N `tool_calls` in the assistant message + N `role: "tool"` entries in the user message. |
| Backend | `ChatController::buildRunSkillScriptTool` | Builds the JSON-Schema tool def (`script` enum-constrained to listed paths, plus `argv` / `input_files` / `read_outputs`). |
| Backend | `ChatController::sanitizeSkillMetadata` | Validates the request's `skill_metadata` payload; rejects path-traversal and absolute paths. |
| Backend | `ClientSideToolsTrait::getClientSideToolNames()` | Shared list of tool names that bypass server-side execution (`run_skill_script`, `discover_skill`, `Task`). Used by all six providers via `isClientSideTool()`. Also supports per-request additions (`setPerRequestClientSideToolNames`). |
| Backend | `ClientSideToolsTrait::emitClientToolCallEvent` (called from each provider's tool-dispatch recursion) | Detects client-side tool_use, emits `client_tool_call` SSE event, returns the `_pending_client_tool_call` short-circuit marker. |
| Backend | `ClaudeProvider::buildMessages` | Round-trips OpenAI-shape `tool_calls` / `role: tool` history entries into Anthropic `tool_use` / `tool_result` blocks. |
| Backend | `LLMManager::normalizeConversationHistory` | Pass-through branches that preserve `tool_call_id` and `tool_calls` across the cross-provider history flattener. |

#### Two-shot workflow

The LLM doesn't run Python — it picks a tool and reads the result. Execution sits between two `POST /api/v1/chat` round-trips:

```
[Pass 1]
 frontend ──POST /chat (skill_metadata, message)──► backend
                                                     │
                                                     ▼
                                  builds run_skill_script tool, calls Claude
                                                     │
                                                     ▼
                                Claude emits tool_use { name: "run_skill_script",
                                                        input: { script, argv, ... } }
                                                     │
                                                     ▼
                                  provider intercepts via ClientSideToolsTrait,
                                  short-circuits, returns pending_client_tool_call=true
                                                     │
                              ◄──── SSE: client_tool_call ────
                              ◄──── SSE: response (pending_client_tool_call: true) ────
                              ◄──── SSE: complete ────

[Browser, between passes]
 chat.js::dispatchClientToolCall
   └─ window.pyodideRunner.runSkillScript({ dirName, script, argv, inputFiles, readOutputs })
        └─ Pyodide mounts skill folder via FSA, runs script, returns { stdout, stderr,
           exitCode, outputs }, syncs writes back to the user's real folder.

[Pass 2]
 frontend ──POST /chat (message: "", conversation_history with assistant tool_calls
                        + role:tool tool_result entries)──► backend
                                                              │
                                                              ▼
                                ChatController allows empty message because the last
                                history entry is role:tool (continuation marker).
                                                              │
                                                              ▼
                                ClaudeProvider::buildMessages converts the OpenAI-shape
                                tool round into Anthropic tool_use/tool_result blocks
                                and skips appending an empty user turn.
                                                              │
                                                              ▼
                                Claude reads the tool_result and writes the final answer.
                                                              │
                              ◄──── SSE: chunk / response / complete ────
```

After pass 2 the frontend keeps only the user message and the final assistant *text* in `this.conversationHistory` — the synthetic `tool_calls` / `tool_result` entries are dropped, so subsequent turns aren't bloated by tool-round noise. The conversation switches providers freely after the turn completes.

#### How the two `/chat` calls are distinguished

There is **no flag** on the request that says "this is the continuation." The shape of the body itself encodes which shot it is. Side-by-side:

**Pass 1 — initial request:**
```json
{
  "message": "Use the transform script to convert ...",
  "conversation_history": [],
  "provider": "claude",
  "skill_metadata": { "dir_name": "medium-format", "scripts": ["scripts/transform.py"] },
  "verification_enabled": false,
  "compare_enabled": false
}
```

**Pass 2 — continuation request:**
```json
{
  "message": "",
  "conversation_history": [
    { "role": "user", "content": "Use the transform script to convert ..." },
    { "role": "assistant", "content": "I'll run the transform now.",
      "tool_calls": [{
        "id": "toolu_01...",
        "type": "function",
        "function": {
          "name": "run_skill_script",
          "arguments": "{ \"script\": \"scripts/transform.py\", \"argv\": [...] }"
        }
      }] },
    { "role": "tool", "tool_call_id": "toolu_01...",
      "content": "{ \"stdout\": \"...\", \"exit_code\": 0, \"outputs\": { ... } }" }
  ],
  "provider": "claude",
  "skill_metadata": { "dir_name": "medium-format", "scripts": [...] },
  "verification_enabled": false,
  "compare_enabled": false
}
```

The discrimination rule lives in `ChatController::chat()`:

```php
$isToolResultContinuation = $message === ''
    && !empty($conversationHistory)
    && (($conversationHistory[count($conversationHistory) - 1]['role'] ?? '') === 'tool');
```

A request is a continuation **if and only if `message` is empty AND the last `conversation_history` entry has `role: "tool"`**. The same condition is re-checked in `ClaudeProvider::buildMessages` (via `lastBlockIsToolResult`) so the provider knows not to append an empty user turn to the Anthropic API call.

#### Stateless protocol, non-deterministic LLM

The `/chat` protocol is **stateless** — the server keeps no memory between requests, so every call carries everything it needs (history, message, skill_metadata). The backend never tracks "user X is mid-tool-round"; the request shape *is* the state.

It is **not idempotent**, however, because Claude is non-deterministic — replaying the same body can yield different text, different tool arguments, or even a different tool choice. (The Anthropic API itself is not idempotent. Most LLM APIs share this shape.)

What this asymmetry buys: the second-shot request is safe to retry on transient failure (e.g. network drop). The retry won't re-run Pyodide — the script already executed in the browser, the result is already in `conversation_history`, and the backend just resends the same payload to Claude. The model's response may differ between attempts, but no side effect is duplicated.

| Property      | Holds for `/chat`? |
|---------------|-------------------|
| Stateless     | ✓ — every request is self-describing |
| Idempotent    | ✗ — LLM sampling makes responses non-deterministic |

#### Key design decisions

- **Two-shot over pause-and-resume.** Each round of tool calls is two clean HTTP requests rather than one long-lived SSE that pauses for the browser. Trade-off: a small "thinking gap" while Pyodide runs (typically a few seconds for warm runs, ~9 s cold-start including bundle download). Upside: the protocol is straightforward and idempotent.
- **Solo client tools per turn (V1).** If the LLM emits a mix of client-side and server-side tool_use blocks in one assistant turn, the backend currently fails the client-side calls closed and continues server-side execution. Multi-tool mixed turns can be added later if real flows need them.
- **Bounded recursion.** `chat.js::dispatchClientToolCall` recurses up to `MAX_DEPTH = 3` for chained client-tool calls, to prevent runaway loops if the model keeps calling tools.
- **Output truncation.** Tool result bodies are capped at 16 KB per entry (stdout, stderr, each output file) before re-issuing pass 2 — protects the context window.
- **All six providers, not Claude-only.** `run_skill_script` is declared provider-agnostically — `ChatController` has no `provider === 'claude'` gate. Client-side interception is centralized in `ClientSideToolsTrait` (`src/Providers/Traits/ClientSideToolsTrait.php`) and `use`d by `ClaudeProvider`, `OpenAIProvider`, `GeminiProvider`, `GrokProvider`, `DeepSeekProvider`, and `KimiProvider` alike; each calls `isClientSideTool()` in its tool-dispatch recursion and short-circuits on `_pending_client_tool_call`. The normalizer pass-through branches in `LLMManager` are provider-agnostic too. _(Historical note: client-side execution was Claude-only in an earlier version; it was generalized into the shared trait.)_
- **Dependencies declared in SKILL.md frontmatter.** The runner reads a `dependencies: [pkg, ...]` field (extension key — Anthropic's spec ignores unknowns) and installs via Pyodide's `loadPackage` for pre-built packages or `micropip` for the rest. Per-call override is also accepted.

## LLM Invocation Paths & Frontend/Backend Cooperation

> **Read this for the big picture of *who triggers the model, with what context, and how the browser and server split the work.*** Everything below sits on top of the same `LLMManager` + provider classes (`claude`, `openai`, `gemini`, `grok`, `deepseek`, `kimi`); the paths differ only in **what context they assemble** and **how the client-side Python execution round-trip is wired**.

### The invariant that shapes everything

The **LLM always runs server-side.** Skills, their `scripts/*.py`, and the per-subagent `agents/*.md` definitions live **only in the user's browser**, mounted from local disk via the File System Access API (`window.localFs`). The backend never reads those files and never runs Python. So whenever a model wants to run a skill script, the backend **declares the tool but cannot execute it** — it hands the call back to the browser, which runs it in Pyodide and returns the result. See [Client-side Tool Execution (Skills)](#client-side-tool-execution-skills) for the deep dive; the two transport mechanisms are summarized in [§ Two ways the client-side round-trip is wired](#two-ways-the-client-side-round-trip-is-wired) below.

### (a) The ways to trigger an LLM, and what context each one gets

There are three distinct entry points. All six providers are reachable through every path (subject to the per-path tool gate noted below).

| # | Path | Endpoint(s) | System prompt | User prompt | Conversation history | Tools / skills | Providers |
|---|------|-------------|---------------|-------------|----------------------|----------------|-----------|
| 1 | **Main chat** | `POST /api/v1/chat` | From `ai_config.php` / `system_llm_settings`, **+ `skill_content`** (active SKILL.md body) appended when a skill is active | `message` field | Yes — last ~10 turns sent as `conversation_history` (see [Conversation Context](#conversation-context)) | **Full set:** built-in tools + MCP tools + folder-backed skills (`run_skill_script`, `discover_skill`, `Task`). Multi-round tool loop. Client-side skill calls use **Mechanism 1**. | All 6 — client-side interception is shared via `ClientSideToolsTrait`, not Claude-only |
| 2 | **Single-pass / Task subagent** | `POST /api/v1/agent` | `system` field. For the **Task tool**, the frontend reads `skills/<dir>/agents/<subagent_type>.md` from local disk and POSTs its contents as `system` | `prompt` field | **None** — fresh context every call | **None** — `tools: []` forced at the provider layer; no skills, no MCP. Single completion, no tool round (`function_calls: 0` is the invariant). | All 6 (`provider` required, no fallback) |
| 3 | **AgentTeam** (persistent agents, teams, workflows) | `POST /api/v1/agents/{id}/run` & `/chat`; `POST /api/v1/workflows/{id}/run` & `/run-stream` | Built from the **DB agent record** via `Agent::buildSystemPrompt()` (name + description + instructions; managers also get delegation text) | `input` field (agent) / per-node input (workflow) | Yes — per-agent / per-conversation history from DB | **Managers:** delegation tools only (`delegate_to_agent`, `list_available_agents`, …), `tool_choice` forced. **Workers/standard:** built-in + MCP (same as chat). **Skills:** injected per workflow node when bound. Client-side skill calls use **Mechanism 2**. | All 6 |

Key context-assembly notes:

- **System prompt sources differ by path:** chat reads it from config/DB and *appends* the active skill's `SKILL.md` body (`skill_content`); the Task subagent's identity is a **local `agents/*.md` file** chosen by `subagent_type` (no fallback — a missing file fails the call); AgentTeam agents build it from their **DB record**.
- **History differs:** chat and AgentTeam carry history; the single-pass `/agent` path is deliberately **stateless and historyless** — it exists for judges, summarizers, blind comparators, and Task subagents that "have no other access" beyond the prompt.
- **Tool exposure is the real differentiator.** `/chat` and AgentTeam workers wire the full executor; `/agent` forces `tools: []`; AgentTeam managers are restricted to delegation tools. See [`/chat` vs `/agent`](#chat-api) and [Tools API](#tools-api).

### (b) Two ways the client-side round-trip is wired

Both mechanisms achieve the same end — *a server-side LLM causes a Python script on the user's laptop to run* — but they differ in transport and in whether the server blocks. The choice is determined by **which surface you're on**, not by configuration.

#### Mechanism 1 — Chat: stateless two-shot (browser re-issues `/chat`)

Used by the **main chat** path. The server never blocks; a skill-script call is split across **two HTTP requests**.

```
Pass 1:  browser ──POST /api/v1/chat──► backend runs LLM, streams SSE
                 LLM emits run_skill_script
                 provider's ClientSideToolsTrait::isClientSideTool() matches,
                 SHORT-CIRCUITS (does not execute), emits SSE `client_tool_call`
         browser ◄── SSE: client_tool_call (script, argv, dir_name) ──
                     ◄── SSE: response { pending_client_tool_call: true } ──

Between passes (browser):
         window.pyodideRunner.runSkillScript(...)
            └─ mounts local skills/<dir>/ via FSA, runs the .py in Pyodide,
               returns { stdout, stderr, exitCode, outputs }

Pass 2:  browser ──POST /api/v1/chat (message:"", conversation_history with
                   assistant tool_calls + role:"tool" result)──► backend
                 backend detects the continuation (empty message + last
                 entry role:"tool"), feeds the result to the LLM, streams
                 the final answer
```

- **State lives in the request shape**, not on the server — every `/chat` body is self-describing. The continuation is identified by `message === '' && last history entry role === 'tool'` (`ChatController::chat()`).
- **No server-side blocking, idempotent-on-retry** (the script already ran in the browser; retrying pass 2 only re-asks the LLM). Full detail, payload shapes, and design rationale: [Client-side Tool Execution (Skills)](#client-side-tool-execution-skills).

#### Mechanism 2 — Workflows: blocking SSE + `/tmp` file rendezvous (`SkillToolBridge`)

Used by **AgentTeam graph workflows**, which run many nodes over one long-lived stream and so can't end-and-re-issue per tool call. Here the PHP worker **holds the SSE connection open and blocks** while the browser runs Python, using a file rendezvous in the system temp dir.

```
1. browser opens SSE: POST /api/v1/workflows/{id}/run-stream   (stays open)
2. WorkflowController::runStream calls GraphWorkflowRunner::run() synchronously
3. a node's LLM emits run_skill_script → provider returns pending_client_tool_call
4. GraphWorkflowRunner::runAgentWithClientToolBridge():
     - mints a 32-char hex tool_call_id (SkillToolBridge::generateToolCallId)
     - emits SSE `client_tool_call` (flushed to the browser)
     - BLOCKS in SkillToolBridge::awaitResult() — polls
       sys_get_temp_dir()/synergy-workflow-tool/<id>.result every 100 ms,
       5-min timeout
5. browser's stream reader runs the .py in Pyodide (same as Mechanism 1)
6. browser POSTs result on a SECOND request:
       POST /api/v1/workflows/tool-result  → WorkflowController::toolResult
       → SkillToolBridge::writeResult() atomically writes <id>.result
7. the blocked awaitResult() poll finds the file, reads + unlinks it, returns
8. runner appends assistant(tool_call) + tool(result) turns, re-runs the node
   (bounded by MAX_ROUNDS = 3), then keeps streaming over the same SSE
9. stream ends with data: [DONE]
```

Source: `src/AgentTeam/Services/SkillToolBridge.php` (constants `POLL_INTERVAL_US` = 100 ms, `DEFAULT_TIMEOUT_MS` = 5 min; `awaitResult()`, `writeResult()`), `src/AgentTeam/Services/GraphWorkflowRunner.php::runAgentWithClientToolBridge()`, routes `src/routes.php:271-272`.

> **Deployment caveat (single-worker deadlock).** `SkillToolBridge` is designed for **single-user, single-worker** rendezvous: one PHP process holds the blocked `run-stream` request while a *second* process serves the `tool-result` POST that unblocks it. Under PHP-FPM this is fine as long as the pool has ≥2 free workers; on a single-worker / single-threaded server it will **deadlock** (the blocked stream occupies the only worker, so the result POST can never be served). Size the worker pool accordingly.

#### Mechanism 1 vs. 2 at a glance

| | Mechanism 1 (chat) | Mechanism 2 (workflows) |
|---|---|---|
| Surface | `/api/v1/chat` | `/api/v1/workflows/{id}/run-stream` |
| Server blocks? | No | Yes (`awaitResult()` poll loop) |
| Transport | Two separate HTTP requests | One open SSE + a second `tool-result` POST |
| Result carrier | `conversation_history` (`role:"tool"`) in pass 2 | `/tmp/synergy-workflow-tool/<id>.result` file |
| Round cap | `MAX_DEPTH = 3` (`chat.js`) | `MAX_ROUNDS = 3` (`GraphWorkflowRunner`) |
| Worker requirement | 1 (stateless) | ≥2 concurrent workers |
| Python execution | identical — Pyodide mounts local `skills/<dir>/` via FSA and runs the `.py` in the browser | same |

In both cases the user's files never leave the machine and the LLM never gets direct filesystem/network access — the browser is the execution sandbox.

## Voice Pricing

_As of March 2026._

|----------|-------------|--------------|
| Gemini   | $0.00025/sec ($0.90/hr) | $0.0005/sec ($1.80/hr) |
| Grok     | $0.0004/sec ($1.44/hr) | $0.0008/sec ($2.88/hr) |


---

## API Reference


Complete REST API reference for the GPT Backend.

**Base URL:** `/api/v1/`

**Authentication:** Most endpoints require JWT token in header: `Authorization: Bearer <token>`

---

### API Endpoints Index

| # | Section | Endpoints | Auth | Description |
|---|---------|-----------|------|-------------|
| 1 | [Authentication](#authentication-api) | 8 | Partial | Login, register, Firebase auth, token verification, logout (public), phone linking, plan upgrade (protected) |
| 2 | [Chat](#chat-api) | 5 | Yes | Send messages, single-pass agent call, verify response, compare-only, file attachment upload |
| 2a | [Conversation Context](#conversation-context) | - | - | How context is built, structured, and sent to LLMs |
| 2b | [URL Fetch](#url-fetch-api) | 1 | Yes | Server-side fetcher for Pyodide skills (CORS bypass + SSRF guard) |
| 3 | [Model Catalog](#model-catalog-api) | 1 | No | Public model catalog (single source of truth for model choices) |
| 4 | [Tools](#tools-api) | 4 | Partial | List tools, list agent tools, execute, classify intent |
| 5 | [Agents](#agents-api) | 12 | Yes | CRUD, run, chat streaming, executions, duplicate, reorder, move |
| 6 | [Teams](#teams-api) | 6 | Yes | CRUD for agent teams, get team agents |
| 7 | [Workflows](#workflows-api) | 18 | Yes | CRUD, run, streaming, executions, toggle, duplicate, outputs, schedules, node documents, generate Python. See [Storage Model](#workflow-storage-model) and [Authoring via skills](#authoring-workflows-via-skills). |
| 8 | [Workflow Schemas](#workflow-schemas-api) | 5 | Yes | CRUD for workflow output JSON schemas (constrained decoding) |
| 9 | [Skills](#skills-api) | 10 | Yes | CRUD for skills (incl. create-from-agent) and skill categories |
| 10 | [User Memory](#user-memory-api) | 4 | Yes | Frozen memory (memory + user scopes), audit events, revert |
| 11 | [Scheduled Workflows](#scheduled-workflows-api) | 8 | Yes | CRUD, stats, pause/resume scheduled workflow executions |
| 12 | [Contexts](#contexts-api) | 5 | Yes | CRUD for conversation contexts/sessions |
| 13 | [Providers](#providers-api) | 2 | Yes | List available LLM providers, switch active provider |
| 14 | [Settings](#settings-api) | 11 | Yes | API keys, provider settings, storage settings, phone status |
| 15 | [Usage](#usage-api) | 3 | Yes | Token balance, transaction history, usage statistics |
| 16 | [Prompt Library](#prompt-library-api) | 5 | Yes | CRUD for prompt templates and folders |
| 17 | [File Storage](#file-storage-api) | 3 | Yes | List storage providers, list files, read file contents |
| 18 | [MCP Servers](#mcp-servers-api) | 10 | Partial | List/CRUD per-user servers, tools, proxy, JSON-RPC for agents (protected); MCP app UI (public) |
| 19 | [Voice](#voice-api) | 4 | Yes | Voice usage logging, stats, ephemeral tokens, config |
| 20 | [WebAuthn](#webauthn-api) | 4 | Partial | Challenge, authenticate (public); register, delete (protected) |
| 21 | [Hume Tools](#hume-tools-api) | 7 | Partial | Tool execution (protected); EVI webhook (public) |
| 22 | [Google Drive](#google-drive-api) | 1 | Yes | Save content to Google Drive |
| 23 | [Packages](#packages-api) | 4 | Partial | Authenticated user's package; admin CRUD for role packages |
| 24 | [Admin](#admin-api) | 33 | Yes | User management, provider config, usage stats, MCP servers, costs, LLM settings |
| 25 | [Scheduler](#scheduler-api) | 2 | Partial | Run (internal token); status (protected) |
| 26 | [App Keys](#app-keys-api) | 4 | Partial | Scoped credentials for client code: mint/list/revoke (admin); key introspection (app-key) |
| 27 | [Error Handling](#error-handling) | - | - | Error response format and HTTP status codes |
| 28 | [Architecture](#architecture) | - | - | Request flow, tool execution flow diagrams |

**Auth Legend:** Yes = All endpoints require auth | Partial = Mixed (see details) | No = Public | Admin = Requires admin privileges | Internal = Uses internal token

> **Note:** "Internal" endpoints are not meant to be called by end users or the frontend. They are used for backend-to-backend communication, typically triggered by cron jobs or scheduled tasks.

---

## Public Endpoints (No Auth Required)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/auth/login` | POST | User login |
| `/api/v1/auth/register` | POST | User registration |
| `/api/v1/auth/firebase` | POST | Firebase authentication |
| `/api/v1/auth/verify` | POST | Token verification |
| `/api/v1/auth/logout` | POST | User logout |
| `/api/v1/webauthn/challenge` | POST | Get WebAuthn challenge |
| `/api/v1/webauthn/authenticate` | POST | WebAuthn authentication |
| `/api/v1/evi/webhook` | POST | Hume EVI webhook |
| `/api/v1/mcp/app` | GET | MCP App UI resource |
| `/api/v1/models/catalog` | GET | Model catalog (model choices for gpt + gpt_admin) |
| `/api/v1/scheduler/run` | POST | Scheduler trigger (uses internal token) |
| `/` | GET | Health check |

---

## Authentication API

User authentication and session management.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/auth/login` | POST | No | Login with email/password |
| `/api/v1/auth/register` | POST | No | Register new user |
| `/api/v1/auth/firebase` | POST | No | Authenticate via Firebase |
| `/api/v1/auth/verify` | POST | No | Verify JWT token |
| `/api/v1/auth/logout` | POST | No | Logout user |
| `/api/v1/auth/link-phone` | POST | **Yes** | Link phone number |
| `/api/v1/auth/upgrade-plan` | POST | **Yes** | Upgrade user plan (standard/premium) |
| `/api/v1/debug/auth` | GET | **Yes** | Debug auth state (dev only) |

### Login

**Endpoint:** `POST /api/v1/auth/login` | **Auth:** No

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJ...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe"
  }
}
```

### Register

**Endpoint:** `POST /api/v1/auth/register` | **Auth:** No

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJ...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe"
  }
}
```

### Firebase Authentication

**Endpoint:** `POST /api/v1/auth/firebase` | **Auth:** No

**Request Body:**
```json
{
  "idToken": "firebase_id_token"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJ...",
  "user": {...}
}
```

### Verify Token

**Endpoint:** `POST /api/v1/auth/verify` | **Auth:** No

**Request Body:**
```json
{
  "token": "jwt_token"
}
```

**Response:**
```json
{
  "success": true,
  "valid": true,
  "user": {...}
}
```

### Logout

**Endpoint:** `POST /api/v1/auth/logout` | **Auth:** No

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

### Link Phone Number

**Endpoint:** `POST /api/v1/auth/link-phone` | **Auth:** Yes

**Request Body:**
```json
{
  "phone": "+1234567890"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Phone linked successfully"
}
```

### Upgrade Plan

**Endpoint:** `POST /api/v1/auth/upgrade-plan` | **Auth:** Yes

Updates the authenticated user's plan in the `users` table.

**Request Body:**
```json
{
  "plan": "premium"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `plan` | string | Yes | One of: `standard`, `premium` |

**Response:**
```json
{
  "success": true,
  "message": "Plan upgraded to premium",
  "plan": "premium"
}
```

Returns 400 for unsupported plan values.

---

## Chat API

Send messages to LLM providers with tool support.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/chat` | POST | **Yes** | Send chat message to LLM (multi-round; supports tools, skills, MCP, attachments) |
| `/api/v1/agent` | POST | **Yes** | **Single-pass** LLM call: prompt in → text out. No tools, no skills, no history. Used by callers that want to spawn an isolated agent and read its answer in one round-trip. |
| `/api/v1/verify` | POST | **Yes** | Verify a previous response with another provider (SSE) |
| `/api/v1/compare` | POST | **Yes** | Run a message against a comparison provider only (SSE) |
| `/api/v1/chat/upload` | POST | **Yes** | Upload a file attachment for use in chat |

> **`/chat` vs `/agent` — when to use which:** `/chat` is the rich path: it wires up the full tool executor (base tools + MCP + folder-backed skills via `run_skill_script`) and supports the **two-shot client-side tool round** described in [Client-side Tool Execution](#client-side-tool-execution-skills). `/agent` is the minimal path: it forces `tools: []` at the provider layer so the LLM cannot trigger any tool round, returns a single completion, and is appropriate for spawn-style use cases (judges, summarizers, description-improvers, blind comparators). Both endpoints sit on top of the same `LLMManager` and providers; they differ only in whether tools are exposed.

### Send Chat Message

**Endpoint:** `POST /api/v1/chat` | **Auth:** Yes

**Request Body:**
```json
{
  "message": "What's the weather in Paris?",
  "conversation_history": [],
  "provider": "claude",
  "streaming": true,
  "tools": ["serpapi_search", "brave_search"],
  "verification_enabled": false,
  "verifier_provider": null,
  "compare_enabled": false,
  "compare_provider": null,
  "skill_content": null,
  "skill_metadata": null,
  "system_prompt": null,
  "memory": true
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes (*) | The user's message. (*) May be empty when `conversation_history` ends with a `role: "tool"` entry — see [Client-side Tool Execution](#client-side-tool-execution-skills). |
| `conversation_history` | array | No | Previous conversation messages |
| `provider` | string | No | LLM provider: `claude`, `openai`, `gemini`, `grok`, `deepseek`, `kimi` |
| `streaming` | boolean | No | Enable SSE streaming (default: `true`) |
| `tools` | string[] | No | List of tool names to enable. If omitted, all tools available. |
| `verification_enabled` | boolean | No | Enable response verification by another LLM |
| `verifier_provider` | string | No | Provider for verification |
| `compare_enabled` | boolean | No | Enable comparison with another provider |
| `compare_provider` | string | No | Provider to compare with |
| `skill_content` | string\|null | No | Body of an active Skill's SKILL.md (frontmatter stripped). Appended to the system prompt server-side. Sent by the frontend when a Skill is dragged onto the prompt. |
| `skill_metadata` | object\|null | No | Folder-backed-skill descriptor: `{ "dir_name": "...", "scripts": ["scripts/transform.py", ...] }`. When present and provider is `claude`, the backend declares a `run_skill_script` tool to the LLM. See [Client-side Tool Execution](#client-side-tool-execution-skills). |
| `system_prompt` | string\|null | No | Custom system prompt that **replaces** the default persona for this call. Assembled as `date prefix + system_prompt (+ memory + skill_content)` by `ProviderRequestBuilderTrait::buildSystemPrompt()`. When absent/empty, the provider's default prompt is used. Read per-request, so it can differ each call. Used by API-driven callers such as the AI-Dialog app (two models conversing as peers). |
| `memory` | boolean | No | Whether to inject the user's frozen memory (Hermes Layer 1) into the system prompt. **Default `true`** (omit → today's behavior). Send `false` to suppress it — e.g. AI-Dialog sends `false` so the user's personal memory doesn't leak into a model-to-model conversation. Only has an effect when `user_id` is numeric and the user has stored memories. |

**Tool Filtering Behavior:**

| `tools` Parameter | Behavior |
|-------------------|----------|
| Not provided | All available tools (builtin + MCP) passed to LLM |
| Empty array `[]` | No tools passed to LLM |
| Array of names | Only specified tools passed to LLM |

**Example - Filter to specific tools:**
```json
{
  "message": "Search for quantum computing news",
  "tools": ["serpapi_search", "brave_search"]
}
```

**Streaming Response (SSE):**
```
event: response
data: {"success":true,"text":"...","usage":{...},"provider":"claude"}

event: verification_response
data: {"success":true,"text":"...","verifier":"openai"}

event: compare_response
data: {"success":true,"text":"...","comparer":"gemini"}

event: complete
data: {"status":"done"}
```

**Additional SSE event — `client_tool_call`** (B3 client-side tools, all six providers):

When the LLM invokes a tool whose name is in `ClientSideToolsTrait::getClientSideToolNames()` (currently `run_skill_script`, `discover_skill`, `Task`), the backend short-circuits server-side execution and surfaces the call to the frontend so it can dispatch the tool locally (e.g. via `window.pyodideRunner`).

```
event: client_tool_call
data: {
  "assistant_text": "I'll run the transform now.",
  "tool_calls": [
    {
      "id": "toolu_01...",
      "name": "run_skill_script",
      "input": { "script": "scripts/transform.py", "argv": [...], ... }
    }
  ]
}

event: response
data: {
  "success": true,
  "text": "I'll run the transform now.",
  "pending_client_tool_call": true,
  "pending_tool_calls": [...],
  ...
}
```

When `pending_client_tool_call` is `true`, verifier and compare phases are skipped — the assistant turn isn't finished yet. The frontend is expected to run the tool, then re-issue `POST /api/v1/chat` with the result prepended to `conversation_history` (see workflow below).

**Non-streaming Response:**
```json
{
  "success": true,
  "text": "The weather in Paris is...",
  "usage": {
    "input_tokens": 150,
    "output_tokens": 100,
    "total_tokens": 250
  },
  "provider": "claude"
}
```

### Single-Pass Agent Call

**Endpoint:** `POST /api/v1/agent` | **Auth:** Yes

A single-round LLM call. No tools, no `available_skills`, no `conversation_history`, no streaming. The endpoint is intended for callers that need the "spawn an agent, read its answer" pattern — e.g. eval judges, blind comparators, description improvers, or any one-shot text generation that should **not** invoke `run_skill_script`, `serpapi_search`, MCP tools, or any other tool the broader `/chat` path exposes.

**Why it exists:** `/chat` always wires up the full tool executor and, depending on provider, can recurse through several tool rounds before returning. That's the right behavior for the user-facing chat surface, but it's overkill (and a source of unwanted side effects) when a caller just wants a completion. `/agent` calls `LLMManager::chat($prompt, [], ['tools' => []])` — `tools: []` is the off-switch each provider checks (`ClaudeProvider::chat:174`, `OpenAIProvider:145`, and the `functionExecutor`-guarded line in Gemini / Grok / DeepSeek / Kimi). With no tools registered, the recursive tool-handling path never fires.

**Request Body:**
```json
{
  "prompt": "Respond with the single word: pong",
  "provider": "claude",
  "model": "claude-sonnet-4-6",
  "system": "You are a concise assistant."
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | The agent's input. Sent as a user message to the LLM. |
| `provider` | string | Yes | One of `claude`, `openai`, `gemini`, `grok`, `deepseek`, `kimi`. No silent fallback — missing/unknown provider returns 400. |
| `model` | string | No | Override the provider's default model. Applied via `setModel()` on the provider instance for the duration of the call. |
| `system` | string | No | System prompt. When provided, replaces the provider's default system prompt for this call (passed as `system_prompt` in `LLMManager::chat` options). |
| `user_id` | string | No | Per-request override; normally the user is derived from the JWT (`sub` claim). |

**Response:**
```json
{
  "success": true,
  "text": "pong",
  "usage": {
    "input_tokens": 375,
    "output_tokens": 5,
    "total_tokens": 380,
    "function_calls": 0
  },
  "provider": "kimi",
  "model": "kimi-k2.6"
}
```

`function_calls: 0` in every response is the structural invariant of this endpoint — confirmation that the tool round was skipped. If it ever shows non-zero, something has wired tools onto this path that shouldn't be there.

**Error Response:**
```json
{
  "success": false,
  "error": "provider is required",
  "status_code": 400
}
```

**Caller patterns:**
- **Pyodide skills** that need a sub-agent call without spawning a full chat loop. Example: `skill-creator/scripts/improve_description.py` calls `/api/v1/agent` to ask an LLM to rewrite a skill description; the prompt embeds the eval results, the response is parsed for `<new_description>` tags.
- **Workflow nodes** that should act as a pure transformer (text in → text out) without tool side-effects.
- **Server-side judges** that score one assistant's output by asking a second LLM to grade it.

**Not appropriate for:**
- Anything that needs to call `run_skill_script` — use `/chat` with `skill_metadata` or `available_skills` instead.
- Anything that needs MCP tools, search, or attachments — use `/chat`.
- Streaming UI rendering — `/chat` with `streaming: true`.

**Implementation:** `ChatController::agent()` in `backend/src/Controllers/ChatController.php`. Applies the same config layering as `/chat` (`applyDatabaseProviderSettings` → `applyPackageDefaults` → `applyUserApiKeys`) before constructing the `AIPortfolioAssistant`, so per-user API keys and model selections are honored.

---

### Verify Response

**Endpoint:** `POST /api/v1/verify` | **Auth:** Yes

Streams a verification of a previous LLM response by another provider. Always SSE.

**Request Body:**
```json
{
  "original_message": "What's the weather in Paris?",
  "response_text": "The weather in Paris is sunny...",
  "verifier_provider": "openai"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `original_message` | string | Yes | The original user message |
| `response_text` | string | Yes | The response text to verify |
| `verifier_provider` | string | Yes | Provider to use for verification (e.g., `claude`, `openai`) |

**SSE Events:**
```
event: verification_start
data: {"verifier":"openai"}

event: verifier_chunk
data: <raw text chunk>

event: verification_response
data: {"success":true,"text":"...","verifier":"openai"}

event: verification_complete
data: {"status":"done"}
```

On error: `event: verification_error` then `verification_complete` with `{"status":"error"}`.

### Compare Only

**Endpoint:** `POST /api/v1/compare` | **Auth:** Yes

Runs a message against a single comparison provider, without invoking the primary LLM. Always SSE.

**Request Body:**
```json
{
  "message": "What's the weather in Paris?",
  "conversation_history": [],
  "compare_provider": "gemini"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The user's message |
| `conversation_history` | array | No | Previous messages |
| `compare_provider` | string | Yes | Provider to run the message against |

**SSE Events:**
```
event: compare_start
data: {"comparer":"gemini"}

event: compare_chunk
data: <raw text chunk>

event: compare_response
data: {"success":true,"text":"...","comparer":"gemini"}

event: compare_complete
data: {"status":"done"}
```

### Upload Chat Attachment

**Endpoint:** `POST /api/v1/chat/upload` | **Auth:** Yes

Upload a file attachment that can be referenced in subsequent chat messages.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The file to upload |

**Constraints:**

- Max size: 50 MB
- Allowed types: PDF, PNG, JPEG, WebP, GIF, plain text, Markdown, CSV, HTML, JSON, DOCX, XLSX, PPTX, DOC, XLS, PPT

**Response:**
```json
{
  "success": true,
  "attachment": {
    "id": 42,
    "name": "report.pdf",
    "mime_type": "application/pdf",
    "size": 184320
  }
}
```

Returns 413 if oversized, 415 if MIME type not allowed.

---

## URL Fetch API

Server-side URL fetcher. Exists so **Pyodide-resident skill scripts can pull web content** despite the browser's same-origin policy. The browser-side Python in `pyodide-runner.js` cannot perform cross-origin XHR for sites without permissive CORS headers (virtually every production site), so the frontend's skill dispatcher intercepts URL arguments declared by skills with `fetches_urls: true` and routes them through this endpoint. The fetched HTML lands in Pyodide's virtual FS as a file the script reads normally.

**Endpoint:** `POST /api/v1/fetch-url` | **Auth:** Yes (JWT bearer)

Implementation: `Controllers/UrlFetchController.php`.

**Request body:**
```json
{ "url": "https://example.com/article" }
```
Bare domains (e.g. `"example.com"`) are auto-prepended with `https://`.

**Success response:**
```json
{
  "success": true,
  "url": "https://example.com/article",
  "final_url": "https://example.com/article",
  "status": 200,
  "content_type": "text/html; charset=utf-8",
  "html": "<!doctype html>...",
  "bytes": 24513
}
```

**Error response:**

| Failure | HTTP status | Body |
|---|---|---|
| curl could not reach the host (DNS, connection refused, timeout) | `502` | `{ "success": false, "error": "Fetch failed (curl errno N): …", "status_code": 502 }` |
| Response body exceeded `MAX_BYTES` (5 MB) | `502` | `{ "success": false, "error": "Response exceeded 5242880 bytes", "status_code": 502 }` |
| **Upstream returned a non-2xx (404, 503, etc.)** | **`200`** | `{ "success": false, "error": "Upstream returned HTTP 404", "data": { "upstream_status": 404, "final_url": "…" } }` |
| SSRF guard rejected a private/loopback host | `403` | `{ "success": false, "error": "Refusing to fetch from a private/internal address", "status_code": 403 }` |

Note the **non-2xx case returns HTTP 200** (not 502): the target's `404` for a missing `/robots.txt` is the target's own normal response, not a gateway failure on our end. Skill scripts already branch on the `success` flag and the `data.upstream_status` value — this mapping keeps the browser console clean of spurious "Bad Gateway" entries during routine 404 probes. (Was 502 before 2026-05-24 — see Changelog.)

**Behaviour & guarantees:**

| Property | Value |
|---|---|
| Max response body | **5 MB** (`MAX_BYTES`) — exceeded responses return 413-style error |
| Total timeout | **30 s** (`TIMEOUT_SECONDS`) |
| Connect timeout | **10 s** (`CONNECT_TIMEOUT_SECONDS`) |
| Max redirects | **5** |
| Allowed schemes | `http`, `https` only |
| User-Agent | A real Chrome string — many sites 403 on default curl UAs |
| Content-Encoding | gzip / deflate are decompressed transparently; caller always receives plain UTF-8 |

**SSRF protection:** loopback (`127.0.0.1`, `::1`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), and multicast hosts are rejected with `status_code: 403`. This is enforced **after** DNS resolution so domain names that resolve to private IPs are also blocked.

**Why no GET?** This is a POST so the URL is in the JSON body rather than as a query parameter — keeps URLs with `?` characters and very long URLs out of access logs and out of the URL-length cap of proxies. It's a state-altering side effect from the user's account (consumes outbound bandwidth, hits external services), so POST is also semantically correct.

**Frontend integration:** `pyodide-runner.js::prefetchUrlArgs` walks the skill's `argv`, POSTs each `http(s)://` token to this endpoint with the user's JWT, writes the returned HTML to `/tmp/prefetched_<slug>.html` in Pyodide's FS, and rewrites the argv to point at the local file before the script runs. Skills opt into this by declaring `fetches_urls: true` in their `SKILL.md` frontmatter.

---

## Conversation Context

This section explains how the context sent to LLMs is structured, where it is built, and what gets included in the final request to the provider API.

### Context Structure

LLMs receive the conversation context as a **structured JSON array of messages**, not as a single concatenated markdown blob. Each message is an object with a `role` and a `content` field.

Supported roles:

| Role | Purpose |
|------|---------|
| `system` | Instructions and persona injected before the conversation (e.g., "You are a helpful assistant...") |
| `user` | User-authored input |
| `assistant` | Previous LLM responses |
| `tool` | Tool/function call results (when tools are enabled) |

The `content` field is a free-form text string that typically contains **markdown** (headers, lists, code fences, tables, etc.). The LLM sees the raw markdown characters — there is no separate "markdown mode." The model has been trained on markdown and interprets its structure implicitly.

### JSON Example

This is what the backend actually sends to the provider API (e.g., OpenAI, Grok, Kimi, DeepSeek — all use this OpenAI-compatible format):

```json
{
  "model": "grok-4-1-fast-reasoning",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful AI assistant. When generating graphics, diagrams, charts, or any visual content, always provide them as SVG code embedded in markdown code blocks using the ```svg syntax..."
    },
    {
      "role": "user",
      "content": "make a short report about the market dynamics of silver"
    },
    {
      "role": "assistant",
      "content": "# Silver Market Dynamics: Short Report\n\n## Current Price & Performance\n- **Spot Price**: ~$74.00–$75.00 USD/t.oz\n- **Recent Trends**: Down 13–15% over the past month..."
    },
    {
      "role": "user",
      "content": "now compare it with gold"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 8192,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "serpapi_search",
        "description": "Search the web using SerpAPI",
        "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": true
}
```

**Provider variations:**
- **OpenAI, Grok, Kimi, DeepSeek** — Use the format above. System message is the first entry in the `messages` array.
- **Claude (Anthropic)** — Uses a separate top-level `system` field instead of a system message in the array. The `messages` array contains only `user` and `assistant` roles.
- **Gemini (Google)** — Uses a different schema with `contents` instead of `messages`, and `role: "model"` instead of `role: "assistant"`. The backend's `GeminiProvider` translates the canonical format.

### Where Context Is Built

Context assembly happens in **two stages** — partly on the frontend, partly on the backend.

#### Stage 1 — Frontend (`frontend/assets/js/chat.js`)

The frontend maintains a `conversationHistory` array as the user and assistant exchange messages. On each new user message, the frontend:

1. Appends the new user message to its in-memory `conversationHistory`
2. Slices **the last 10 messages** from the history (`this.conversationHistory.slice(-10)`)
3. Sends them in the `conversation_history` field of the `POST /api/v1/chat` request body

**Frontend request payload:**
```json
{
  "message": "now compare it with gold",
  "conversation_history": [
    { "role": "user", "content": "make a short report about the market dynamics of silver", "provider": "grok" },
    { "role": "assistant", "content": "# Silver Market Dynamics: Short Report\n\n...", "provider": "grok" }
  ],
  "streaming": true,
  "user_id": 123,
  "provider": "grok",
  "tools": ["serpapi_search", "brave_search"]
}
```

**Note:** The frontend truncates to the last 10 messages as a safeguard against unbounded context growth. If you need longer memory, this limit can be raised in `chat.js::sendMessage()`.

#### Stage 2 — Backend (`backend/src/Controllers/ChatController.php` → Provider class)

The backend receives the frontend request, extracts `$conversationHistory`, and hands it off to the provider class (e.g., `GrokProvider`, `ClaudeProvider`, `KimiProvider`). Each provider has a `buildMessages()` method that constructs the final array sent to the LLM API:

```php
// Simplified — from KimiProvider::buildMessages()
private function buildMessages(array $conversationHistory, string $newMessage, string $systemPrompt): array
{
    $messages = [['role' => 'system', 'content' => $systemPrompt]];

    foreach ($conversationHistory as $msg) {
        $messages[] = [
            'role' => $msg['role'],
            'content' => $msg['content']
        ];
    }

    $messages[] = ['role' => 'user', 'content' => $newMessage];
    return $messages;
}
```

The backend adds:

1. **System prompt** — Read from `backend/config/ai_config.php` (per provider) or from `system_llm_settings` DB table if the provider has been configured via the admin panel. This is prepended as the first message.
2. **The new user message** — Appended after the history. The frontend sends it as a separate `message` field, and the backend adds it to the array at the end.
3. **Tools list** — If tools are enabled, the backend loads them via `ToolsManager` (builtin tools) and `MCPToolsLoader` (MCP server tools), optionally filters them according to the frontend's `tools` field, and attaches them to the provider request as a separate `tools` array.
4. **Provider-specific translation** — Some providers need field renames (Claude uses top-level `system`, Gemini uses `contents`/`model` role), handled in each provider's `makeRequest()` method.

### What the User Sees vs. What the LLM Sees

The in-app **"View Context"** button (info bar, next to "View Functions") displays `this.conversationHistory` from the frontend — the same data that gets sent in the `conversation_history` field. **This does not include the system prompt or the tools list**, which are added server-side. To see exactly what the LLM receives, you would also need the system prompt (from `ai_config.php` or `system_llm_settings`) and the tools array.

### Context Summary

| Component | Where It Lives | Added By |
|-----------|---------------|----------|
| User/assistant messages | `conversationHistory` (frontend localStorage + in-memory) | Frontend |
| New user message | `message` field of the request body | Frontend |
| System prompt | `ai_config.php` or `system_llm_settings` table | Backend |
| Tools array | `ToolsManager` + `MCPToolsLoader` | Backend |
| Provider-specific format | `buildMessages()` in each provider class | Backend |
| Final JSON payload to LLM API | HTTP POST to provider endpoint | Backend (provider class) |

### Context Limits

- **Frontend history truncation:** Last 10 messages only (hardcoded in `chat.js::sendMessage()`)
- **Per-provider max tokens:** Set in `ai_config.php` under each provider's `max_tokens` field. This is the **output** limit, not the total context window.
- **Model context window:** Varies by model (e.g., Claude Sonnet 4.5: 200K tokens, GPT-4o: 128K tokens, Grok 4: 128K tokens). The backend does not currently enforce a context-window check — if the combined system prompt + history + tools + new message exceeds the model's window, the provider API will return an error.

---

## Model Catalog API

Public catalog of model choices used as the single source of truth for model pickers in `gpt` and `gpt_admin`.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/models/catalog` | GET | No | Get the model catalog |

### Get Model Catalog

**Endpoint:** `GET /api/v1/models/catalog` | **Auth:** No

**Response:**
```json
{
  "success": true,
  "providers": [
    {
      "key": "claude",
      "display_name": "Claude",
      "models": [
        {"id": "claude-sonnet-4-5", "label": "Claude Sonnet 4.5"},
        {"id": "claude-opus-4-6", "label": "Claude Opus 4.6"}
      ]
    }
  ],
  "updated": "2026-04-25T10:00:00Z"
}
```

Backed by `backend/resources/model_catalog.json`. Returns 500 if the file is missing or malformed.

---

## Tools API

List and manage tools available to LLM providers.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/tools` | GET | **Yes** | List all available tools |
| `/api/v1/agents/tools` | GET | **Yes** | List agent tools including delegation |
| `/api/v1/tools/execute` | POST | Optional | Execute a tool (built-in or MCP) |
| `/api/v1/tools/classify-intent` | POST | Optional | Classify a transcript against a tool list |

### List All Tools

**Endpoint:** `GET /api/v1/tools` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter: `all` (default), `builtin`, or `mcp` |
| `search` | string | Search by name or description |

**Response:**
```json
{
  "success": true,
  "tools": [
    {
      "name": "serpapi_search",
      "description": "Search the web using SerpAPI",
      "type": "builtin",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {"type": "string", "description": "Search query"}
        },
        "required": ["query"]
      }
    },
    {
      "name": "mcp_generate-image",
      "description": "Generate images using AI",
      "type": "mcp",
      "server": "Image-server",
      "input_schema": {...}
    }
  ],
  "counts": {
    "builtin": 19,
    "mcp": 6,
    "total": 25
  }
}
```

### List Agent Tools

**Endpoint:** `GET /api/v1/agents/tools` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "tools": {
    "builtin": [
      {"name": "serpapi_search", "description": "...", "type": "builtin"}
    ],
    "mcp": [
      {"name": "mcp_generate-image", "description": "...", "type": "mcp", "server": "Image-server"}
    ],
    "delegation": [
      {"name": "delegate_to_agent", "description": "Delegate task to another agent", "type": "delegation"},
      {"name": "list_available_agents", "description": "List available agents", "type": "delegation"},
      {"name": "run_agents_parallel", "description": "Run multiple agents in parallel", "type": "delegation"}
    ]
  },
  "counts": {
    "builtin": 32,
    "mcp": 6,
    "delegation": 3,
    "total": 41
  }
}
```

### Execute Tool

**Endpoint:** `POST /api/v1/tools/execute` | **Auth:** Optional (defaults to `demo-user` when unauthenticated)

Executes a built-in tool or MCP tool. Built-in tools are tried first, then MCP tools (filtered by the user's package allowlist).

**Request Body:**
```json
{
  "tool_name": "serpapi_search",
  "parameters": {
    "query": "quantum computing news"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tool_name` | string | Yes | Tool name (alias: `name`) |
| `parameters` | object | Yes | Tool input parameters (alias: `args`) |

**Response:**
```json
{
  "success": true,
  "result": { "...": "tool-specific output" }
}
```

Returns 404 if the tool is not found, 500 on execution error.

### Classify Intent

**Endpoint:** `POST /api/v1/tools/classify-intent` | **Auth:** Optional

Uses a cheap LLM call (temperature 0, max_tokens 120) to classify whether an agent utterance implies a tool call. Returns `null` for normal conversation.

**Request Body:**
```json
{
  "transcript": "Open the Paris weather dashboard",
  "tools": [
    {
      "name": "open_dashboard",
      "description": "Open a named dashboard",
      "parameters": {
        "properties": {
          "target": { "enum": ["paris-weather", "london-weather"] }
        }
      }
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transcript` | string | Yes | The agent utterance to classify |
| `tools` | array | Yes | Tool definitions to choose from |

**Response:**
```json
{
  "success": true,
  "tool": "open_dashboard",
  "args": { "target": "paris-weather" }
}
```

If the utterance is normal conversation, `tool` is `null`.

### Tool Naming Conventions

| Type | Format | Example |
|------|--------|---------|
| Built-in | snake_case | `serpapi_search`, `get_weather` |
| MCP | `mcp_` prefix | `mcp_generate-image`, `mcp_query_database` |
| Delegation | Special names | `delegate_to_agent`, `list_available_agents` |

---

## Agents API

Create and manage AI agents.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/agents` | GET | **Yes** | List all agents |
| `/api/v1/agents` | POST | **Yes** | Create new agent |
| `/api/v1/agents/tools` | GET | **Yes** | List available tools |
| `/api/v1/agents/reorder` | POST | **Yes** | Reorder agents in team |
| `/api/v1/agents/{id}` | GET | **Yes** | Get agent details |
| `/api/v1/agents/{id}` | PUT | **Yes** | Update agent |
| `/api/v1/agents/{id}` | DELETE | **Yes** | Delete agent |
| `/api/v1/agents/{id}/run` | POST | **Yes** | Run agent (non-streaming) |
| `/api/v1/agents/{id}/chat` | POST | **Yes** | Run agent (streaming) |
| `/api/v1/agents/{id}/executions` | GET | **Yes** | Get execution history |
| `/api/v1/agents/{id}/duplicate` | POST | **Yes** | Duplicate agent |
| `/api/v1/agents/{id}/move-up` | POST | **Yes** | Move agent up in order |
| `/api/v1/agents/{id}/move-down` | POST | **Yes** | Move agent down in order |

### List Agents

**Endpoint:** `GET /api/v1/agents` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | string | Filter: `standard`, `manager`, `worker` |
| `provider` | string | Filter by LLM provider |
| `visibility` | string | Filter: `personal`, `workspace`, `public` |
| `search` | string | Search by name |
| `limit` | int | Max results (default: 100) |
| `offset` | int | Pagination offset |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Research Agent",
      "description": "Performs web research",
      "agent_type": "worker",
      "provider": "claude",
      "model": "claude-sonnet-4-20250514",
      "enabled": true,
      "visibility": "personal",
      "team_id": null
    }
  ],
  "meta": {
    "total": 10,
    "count": 10,
    "limit": 100,
    "offset": 0
  }
}
```

### Create Agent

**Endpoint:** `POST /api/v1/agents` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "My Agent",
  "description": "Agent description",
  "agent_type": "worker",
  "provider": "claude",
  "model": "claude-sonnet-4-20250514",
  "instructions": "System prompt for the agent",
  "tools": ["serpapi_search", "brave_search"],
  "visibility": "personal",
  "team_id": null,
  "settings": {
    "temperature": 0.7,
    "max_tokens": 4096
  }
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Agent name |
| `description` | string | No | Agent description |
| `agent_type` | string | No | `standard`, `manager`, or `worker` (default: `standard`) |
| `provider` | string | No | LLM provider (default: `claude`) |
| `model` | string | No | Specific model to use |
| `instructions` | string | No | System prompt |
| `tools` | string[] | No | List of enabled tools |
| `visibility` | string | No | `personal`, `workspace`, `public` (default: `personal`) |
| `team_id` | int | No | Team to assign agent to |
| `settings` | object | No | Temperature, max_tokens, etc. |

### Get Agent

**Endpoint:** `GET /api/v1/agents/{id}` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `include_stats` | string | Set to `true` to include execution stats |

### Update Agent

**Endpoint:** `PUT /api/v1/agents/{id}` | **Auth:** Yes

**Request Body:** Same fields as Create Agent (all optional)

### Delete Agent

**Endpoint:** `DELETE /api/v1/agents/{id}` | **Auth:** Yes

### Run Agent

**Endpoint:** `POST /api/v1/agents/{id}/run` | **Auth:** Yes

**Request Body:**
```json
{
  "input": "Analyze this data",
  "conversation_history": [],
  "tools": ["data_analysis", "mcp_chart_generator"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `input` or `message` | string | Yes | Task for the agent |
| `conversation_history` | array | No | Previous messages |
| `tools` | string[] | No | Filter available tools |

**Response:**
```json
{
  "success": true,
  "text": "Analysis complete...",
  "usage": {
    "input_tokens": 200,
    "output_tokens": 150
  },
  "tools_used": ["data_analysis"],
  "execution_id": 123,
  "agent": {
    "id": 1,
    "name": "Data Analyst",
    "type": "worker"
  },
  "provider": "claude",
  "model": "claude-sonnet-4-20250514",
  "response_time_ms": 2500
}
```

### Run Agent (Streaming)

**Endpoint:** `POST /api/v1/agents/{id}/chat` | **Auth:** Yes

**Request Body:** Same as `/run`

**Response:** Server-Sent Events stream

### Get Agent Executions

**Endpoint:** `GET /api/v1/agents/{id}/executions` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | int | Max results (default: 50) |
| `offset` | int | Pagination offset |

### Duplicate Agent

**Endpoint:** `POST /api/v1/agents/{id}/duplicate` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "Copy of Agent"
}
```

### Reorder Agents

**Endpoint:** `POST /api/v1/agents/reorder` | **Auth:** Yes

**Request Body:**
```json
{
  "team_id": 1,
  "agent_ids": [3, 1, 2]
}
```

### Move Agent Up/Down

**Auth:** Yes

**Endpoints:**
- `POST /api/v1/agents/{id}/move-up`
- `POST /api/v1/agents/{id}/move-down`

---

## Teams API

Organize agents into teams.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/teams` | GET | **Yes** | List all teams |
| `/api/v1/teams` | POST | **Yes** | Create new team |
| `/api/v1/teams/{id}` | GET | **Yes** | Get team details |
| `/api/v1/teams/{id}` | PUT | **Yes** | Update team |
| `/api/v1/teams/{id}` | DELETE | **Yes** | Delete team |
| `/api/v1/teams/{id}/agents` | GET | **Yes** | Get team's agents |

### List Teams

**Endpoint:** `GET /api/v1/teams` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Research Team",
      "description": "Team for research tasks",
      "agent_count": 3
    }
  ]
}
```

### Create Team

**Endpoint:** `POST /api/v1/teams` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "Research Team",
  "description": "Team for research tasks"
}
```

### Get Team

**Endpoint:** `GET /api/v1/teams/{id}` | **Auth:** Yes

### Update Team

**Endpoint:** `PUT /api/v1/teams/{id}` | **Auth:** Yes

### Delete Team

**Endpoint:** `DELETE /api/v1/teams/{id}` | **Auth:** Yes

### Get Team Agents

**Endpoint:** `GET /api/v1/teams/{id}/agents` | **Auth:** Yes

---

## Workflows API

Create and execute multi-agent workflows.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/workflows` | GET | **Yes** | List all workflows |
| `/api/v1/workflows` | POST | **Yes** | Create new workflow |
| `/api/v1/workflows/{id}` | GET | **Yes** | Get workflow details |
| `/api/v1/workflows/{id}` | PUT | **Yes** | Update workflow |
| `/api/v1/workflows/{id}` | DELETE | **Yes** | Delete workflow |
| `/api/v1/workflows/{id}/run` | POST | **Yes** | Run workflow |
| `/api/v1/workflows/{id}/run-stream` | POST | **Yes** | Run workflow (streaming) |
| `/api/v1/workflows/{id}/executions` | GET | **Yes** | Get execution history |
| `/api/v1/workflows/{id}/toggle` | POST | **Yes** | Enable/disable workflow |
| `/api/v1/workflows/{id}/duplicate` | POST | **Yes** | Duplicate workflow |
| `/api/v1/workflows/{id}/generate-python` | GET | **Yes** | Generate LangGraph Python script for workflow |
| `/api/v1/workflows/{id}/outputs` | GET | **Yes** | List output files |
| `/api/v1/workflows/{id}/outputs/{filename}` | GET | **Yes** | Get output file |
| `/api/v1/workflows/{id}/schedules` | GET | **Yes** | Get workflow schedules |
| `/api/v1/workflows/{id}/nodes/{nodeId}/documents` | POST | **Yes** | Upload document to node |
| `/api/v1/workflows/{id}/nodes/{nodeId}/documents/metadata` | POST | **Yes** | Update document metadata |
| `/api/v1/workflows/{id}/nodes/{nodeId}/documents` | GET | **Yes** | List node documents |
| `/api/v1/workflows/{id}/nodes/{nodeId}/documents/{docId}` | DELETE | **Yes** | Delete node document |

### List Workflows

**Endpoint:** `GET /api/v1/workflows` | **Auth:** Yes

### Create Workflow

**Endpoint:** `POST /api/v1/workflows` | **Auth:** Yes

A workflow is a **graph of nodes and edges**, not a flat list of steps. The body carries a `definition` object holding the graph; the backend explodes it into rows across `agent_workflows`, `workflow_nodes`, and `workflow_edges`.

**Request Body:**
```json
{
  "name": "Daily Newspaper Journal",
  "description": "Crawl PubMed + crypto feeds and produce a daily digest.",
  "definition": {
    "runtime_mode": "batch",
    "nodes": [
      { "id": "1", "node_type": "start",  "type": "start",
        "config": { "type": "start" },
        "position": { "x": 120, "y": 200 }, "pos_x": 120, "pos_y": 200 },
      { "id": "2", "node_type": "agent",  "type": "agent",
        "agent_id": 17, "agent_name": "PubMed Researcher",
        "config": { "type": "agent", "agent_type": "researcher", "mode": "async" },
        "position": { "x": 380, "y": 120 }, "pos_x": 380, "pos_y": 120 },
      { "id": "3", "node_type": "agent",  "type": "agent",
        "agent_id": 18, "agent_name": "Crypto Researcher",
        "config": { "type": "agent", "agent_type": "researcher", "mode": "async" },
        "position": { "x": 380, "y": 280 }, "pos_x": 380, "pos_y": 280 },
      { "id": "4", "node_type": "agent",  "type": "agent",
        "agent_id": 22, "agent_name": "Newspaper Publisher",
        "config": { "type": "agent", "agent_type": "publisher" },
        "position": { "x": 640, "y": 200 }, "pos_x": 640, "pos_y": 200 },
      { "id": "5", "node_type": "output", "type": "output",
        "config": { "type": "output", "storage": "off", "language": "Python" },
        "position": { "x": 880, "y": 200 }, "pos_x": 880, "pos_y": 200 }
    ],
    "edges": [
      { "from": "1", "to": "2", "from_port": "output_1", "to_port": "input_1" },
      { "from": "1", "to": "3", "from_port": "output_1", "to_port": "input_1" },
      { "from": "2", "to": "4", "from_port": "output_1", "to_port": "input_1" },
      { "from": "3", "to": "4", "from_port": "output_1", "to_port": "input_1" },
      { "from": "4", "to": "5", "from_port": "output_1", "to_port": "input_1" }
    ]
  },
  "triggers": { "schedule": { "enabled": false } },
  "output_storage_enabled": 0,
  "output_folder": null
}
```

Validation runs synchronously on every save. A failure returns `400` with `validation_errors: [...]`. Required: **exactly one `start` node, at least one `output` node, every non-terminal node connected.** Legacy `condition` / `switch` node types are rejected — branching is now expressed inside agent nodes.

See [Workflow Storage Model](#workflow-storage-model) below and the [frontend README workflow editor section](../frontend/README.md#workflow-editor--storage-and-wire-format) for the full graph schema, node `config` shapes per `node_type`, and the editor's round-trip behaviour.

### Get Workflow

**Endpoint:** `GET /api/v1/workflows/{id}` | **Auth:** Yes

### Update Workflow

**Endpoint:** `PUT /api/v1/workflows/{id}` | **Auth:** Yes

### Delete Workflow

**Endpoint:** `DELETE /api/v1/workflows/{id}` | **Auth:** Yes

### Run Workflow

**Endpoint:** `POST /api/v1/workflows/{id}/run` | **Auth:** Yes

**Request Body:**
```json
{
  "input": "Generate report for today",
  "variables": {
    "date": "2024-01-15"
  }
}
```

### Run Workflow (Streaming)

**Endpoint:** `POST /api/v1/workflows/{id}/run-stream` | **Auth:** Yes

**Request Body:** Same as `/run`

**Response:** Server-Sent Events stream

### Get Workflow Executions

**Endpoint:** `GET /api/v1/workflows/{id}/executions` | **Auth:** Yes

### Toggle Workflow

**Endpoint:** `POST /api/v1/workflows/{id}/toggle` | **Auth:** Yes

### Duplicate Workflow

**Endpoint:** `POST /api/v1/workflows/{id}/duplicate` | **Auth:** Yes

### Generate Python Script

**Endpoint:** `GET /api/v1/workflows/{id}/generate-python` | **Auth:** Yes

Generates a LangGraph Python script that mirrors the workflow.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `download` | int | Set to `1` to receive the raw `.py` file (Content-Type: `text/x-python`); otherwise returns JSON. |

**Response (default JSON):**
```json
{
  "success": true,
  "data": {
    "filename": "workflow_42.py",
    "code": "from langgraph...\n..."
  }
}
```

Returns 404 if the workflow does not exist or is not owned by the user.

### List Workflow Outputs

**Endpoint:** `GET /api/v1/workflows/{id}/outputs` | **Auth:** Yes

### Get Workflow Output File

**Endpoint:** `GET /api/v1/workflows/{id}/outputs/{filename}` | **Auth:** Yes

### Get Workflow Schedules

**Endpoint:** `GET /api/v1/workflows/{id}/schedules` | **Auth:** Yes

### Upload Node Document

**Endpoint:** `POST /api/v1/workflows/{id}/nodes/{nodeId}/documents` | **Auth:** Yes

Upload a file attachment to a specific workflow node.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The file to upload |
| `metadata` | string (JSON) | No | Optional metadata JSON |

### Update Document Metadata

**Endpoint:** `POST /api/v1/workflows/{id}/nodes/{nodeId}/documents/metadata` | **Auth:** Yes

**Request Body:**
```json
{
  "doc_id": "abc123",
  "metadata": {
    "title": "Report Q1",
    "tags": ["finance", "quarterly"]
  }
}
```

### List Node Documents

**Endpoint:** `GET /api/v1/workflows/{id}/nodes/{nodeId}/documents` | **Auth:** Yes

### Delete Node Document

**Endpoint:** `DELETE /api/v1/workflows/{id}/nodes/{nodeId}/documents/{docId}` | **Auth:** Yes

### Workflow Storage Model

Workflows persist to **three MariaDB tables** — there is no JSON-file or single-blob representation; the graph is exploded into rows.

```sql
agent_workflows   -- parent row (name, description, triggers/variables JSON, output_*)
workflow_nodes    -- one row per node (node_type ENUM('start','output','agent','parallel'),
                  --                   agent_id FK→agents.id, config JSON, pos_x/pos_y,
                  --                   drawflow_node_id)
workflow_edges    -- one row per connection (from_node_id, to_node_id, from_port,
                  --                          to_port, condition_expr)
```

Migration: `database/migrations/create_workflow_graph_tables.sql`. Persistence: `Services/WorkflowGraphRepository.php`. `saveGraph()` clears and rewrites the whole graph in a transaction — partial graph updates are not supported; clients always send the full `definition`.

Key invariants the backend enforces:

| Rule | Enforced by |
|---|---|
| `node_type` ∈ `{start, output, agent, parallel}` | DB ENUM + `WorkflowGraphRepository::createNode` (legacy `condition`/`switch` throw) |
| `agent_id` is numeric (FK to `agents.id`) | `createNode` coerces non-numeric strings to `null` (silent — the agent reference is lost) |
| Frontend node IDs (`"1"`, `"2"`, …) are remapped to real DB IDs on save | `saveGraph` builds a temp-id→db-id map; edges pointing at unknown ids are dropped silently |
| Cascade delete | `workflow_nodes`/`workflow_edges` have `ON DELETE CASCADE` from `agent_workflows.id` |

Full wire format (request body, node `config` shapes per type, edge ports, response shape with rehydrated graph) lives in [`frontend/README.md` → "Workflow editor — storage and wire format"](../frontend/README.md#workflow-editor--storage-and-wire-format), since the editor is the canonical producer of the format.

### Authoring Workflows via Skills

A workflow can be authored by an LLM through a Pyodide-resident skill (the planned `workflow-builder` skill under `~/Documents/synergyAI/skills/`). The integration follows the same two-shot client-tool pattern as any other skill — see [Client-side Tool Execution (Skills)](#client-side-tool-execution-skills) — with three workflow-specific notes:

1. **The skill produces a `definition` JSON; it does not POST to `/api/v1/workflows` directly.** The user opens the result in the editor and commits it through the normal Save path. This keeps the existing validation, the user-review step, and the side-effect surface unchanged.
2. **Agent ID resolution requires the agent catalog.** The LLM cannot invent `agent_id` values — they must reference real rows in `agents`. The frontend pre-fetches `GET /api/v1/agents` and injects the result as a Pyodide `input_files` entry before invoking the skill (see the frontend README's "LLM-driven workflow authoring" sub-section for the exact mechanism). If you add a new backend that the workflow-builder skill needs to read (e.g. `GET /api/v1/workflow-schemas`), wire it through the same input-file injection — do **not** widen the URL-fetch bridge to general backend POST.
3. **Auto-layout is the skill's responsibility for now.** The editor renders `pos_x`/`pos_y` verbatim — if the skill emits zeros, every node draws at (0, 0). Either the skill computes positions (BFS depth × layer height; sibling index × node spacing is enough for v1) or a future `editor.loadFromJson()` entry point runs dagre/elk.js before opening the canvas.

The endpoints a workflow-authoring skill needs:

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/agents` | Resolve agent names → `agent_id` |
| `GET /api/v1/workflow-schemas` (optional) | Attach output schemas to agent nodes for constrained decoding |
| `POST /api/v1/workflows` | Final save (called by the editor, **not** by the skill) |

---

## Workflow Schemas API

JSON Schemas used for constrained decoding of workflow node outputs. Each schema is owned by a single user.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/workflow-schemas` | GET | **Yes** | List all schemas owned by user |
| `/api/v1/workflow-schemas` | POST | **Yes** | Create new schema |
| `/api/v1/workflow-schemas/{id}` | GET | **Yes** | Get schema details |
| `/api/v1/workflow-schemas/{id}` | PUT | **Yes** | Update schema |
| `/api/v1/workflow-schemas/{id}` | DELETE | **Yes** | Delete schema |

### List Schemas

**Endpoint:** `GET /api/v1/workflow-schemas` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "report_v1",
      "description": "Quarterly report shape",
      "schema_json": {"type": "object", "properties": {"...": "..."}},
      "strict": true
    }
  ],
  "count": 1
}
```

### Create Schema

**Endpoint:** `POST /api/v1/workflow-schemas` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "report_v1",
  "description": "Quarterly report shape",
  "schema_json": {
    "type": "object",
    "properties": {
      "title": {"type": "string"},
      "sections": {"type": "array"}
    },
    "required": ["title"]
  },
  "strict": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique per user |
| `description` | string | No | Optional description |
| `schema_json` | object | Yes | JSON Schema document |
| `strict` | boolean | No | Defaults to `true` |

Returns 409 if `name` already exists for the user.

### Get Schema

**Endpoint:** `GET /api/v1/workflow-schemas/{id}` | **Auth:** Yes

Returns 404 if not owned by the user.

### Update Schema

**Endpoint:** `PUT /api/v1/workflow-schemas/{id}` | **Auth:** Yes

**Request Body:** Any subset of `name`, `description`, `schema_json`, `strict`. Returns 409 if renamed to a duplicate.

### Delete Schema

**Endpoint:** `DELETE /api/v1/workflow-schemas/{id}` | **Auth:** Yes

---

## Skills API

Reusable skills that can be attached to agents, plus a category tree for organizing them.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/skills` | GET | **Yes** | List skills (own + public) |
| `/api/v1/skills` | POST | **Yes** | Create skill |
| `/api/v1/skills/from-agent` | POST | **Yes** | Create a skill from an existing agent's instructions |
| `/api/v1/skills/{id}` | GET | **Yes** | Get skill details |
| `/api/v1/skills/{id}` | PUT | **Yes** | Update skill |
| `/api/v1/skills/{id}` | DELETE | **Yes** | Delete skill |
| `/api/v1/skill-categories` | GET | **Yes** | List skill categories |
| `/api/v1/skill-categories` | POST | **Yes** | Create skill category |
| `/api/v1/skill-categories/{id}` | PUT | **Yes** | Rename skill category |
| `/api/v1/skill-categories/{id}` | DELETE | **Yes** | Delete skill category |

### List Skills

**Endpoint:** `GET /api/v1/skills` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `search` | string | Match against name/description |
| `tag` | string | Filter by tag |
| `visibility` | string | `personal` or `public` |
| `category_id` | int | Filter by category |
| `limit` | int | Default 100 |
| `offset` | int | Pagination offset |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Summarize transcripts",
      "description": "...",
      "skill_content": "...",
      "default_tools": ["serpapi_search"],
      "tags": ["summarization"],
      "visibility": "personal",
      "category_id": 3
    }
  ],
  "meta": {"count": 1, "limit": 100, "offset": 0}
}
```

### Create Skill

**Endpoint:** `POST /api/v1/skills` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "Summarize transcripts",
  "description": "Concise meeting recap",
  "skill_content": "You are a summarizer...",
  "default_tools": ["serpapi_search"],
  "tags": ["summarization"],
  "visibility": "personal",
  "category_id": 3
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Max 255 chars |
| `description` | string | No | |
| `skill_content` | string | Yes | The skill body / system prompt |
| `default_tools` | string[] | No | Tools enabled by default |
| `tags` | string[] | No | |
| `visibility` | string | No | `personal` (default) or `public` |
| `category_id` | int | No | Must belong to the user |

### Create Skill from Agent

**Endpoint:** `POST /api/v1/skills/from-agent` | **Auth:** Yes

Builds a skill by extracting `skill_content` from the agent's `instructions`.

**Request Body:**
```json
{
  "agent_id": 7,
  "name": "Optional override name",
  "description": "Optional description",
  "category_id": 3,
  "tags": ["research"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_id` | int | Yes | Source agent |
| `name` | string | No | Defaults to `"{agent_name} Skill"` |
| `description` | string | No | |
| `category_id` | int | No | |
| `tags` | string[] | No | |

Returns 400 if the agent has no instructions, or if `category_id` is not found.

### Get / Update / Delete Skill

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/api/v1/skills/{id}` | 404 if not accessible |
| PUT | `/api/v1/skills/{id}` | Partial update; same fields as Create |
| DELETE | `/api/v1/skills/{id}` | 404 if not owner |

### List Skill Categories

**Endpoint:** `GET /api/v1/skill-categories` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "data": [
    {"id": 1, "name": "Research", "parent_id": null},
    {"id": 2, "name": "Drafting", "parent_id": 1}
  ]
}
```

### Create Category

**Endpoint:** `POST /api/v1/skill-categories` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "Research",
  "parent_id": 1
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Max 255 chars |
| `parent_id` | int | No | Must belong to the user |

### Rename Category

**Endpoint:** `PUT /api/v1/skill-categories/{id}` | **Auth:** Yes

**Request Body:** `{ "name": "New name" }`

### Delete Category

**Endpoint:** `DELETE /api/v1/skill-categories/{id}` | **Auth:** Yes

Cascades deletion to child categories; orphaned skills are moved to root (no category).

---

## User Memory API

Hermes-style frozen memory that is always injected into the system prompt. Two scopes: `memory` (project-level) and `user` (user-level). Includes audit events with revert.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/user-memories` | GET | **Yes** | Get current memory + auto-update settings |
| `/api/v1/user-memories` | PUT | **Yes** | Update memory or auto-update settings |
| `/api/v1/user-memories/events` | GET | **Yes** | List recent audit events |
| `/api/v1/user-memories/events/{id}/revert` | POST | **Yes** | Revert to a prior memory state |

### Get Memory

**Endpoint:** `GET /api/v1/user-memories` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "data": {
    "memory": {
      "content": "...",
      "budget": 4000,
      "last_source": "manual"
    },
    "user": {
      "content": "...",
      "budget": 2000,
      "last_source": "auto"
    },
    "auto_update": {
      "enabled": true,
      "model": "claude-haiku-4-5-20251001",
      "allowed_models": ["claude-haiku-4-5-20251001", "gpt-4o-mini"]
    }
  }
}
```

### Update Memory

**Endpoint:** `PUT /api/v1/user-memories` | **Auth:** Yes

All fields optional; provide at least one.

**Request Body:**
```json
{
  "memory": "Project-level memory text",
  "user": "User-level memory text",
  "auto_update": {
    "enabled": true,
    "model": "claude-haiku-4-5-20251001"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {"updated": ["memory", "user", "auto_update"]}
}
```

Returns 400 if no fields are provided. Each scope change writes an audit event.

### List Audit Events

**Endpoint:** `GET /api/v1/user-memories/events` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | int | Default 50 |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 17,
      "scope": "memory",
      "source": "manual",
      "before": "...",
      "after": "...",
      "rationale": null,
      "session_id": null,
      "created_at": "2026-04-25T10:00:00Z"
    }
  ]
}
```

`source` is one of `manual`, `auto`, or `revert`.

### Revert Event

**Endpoint:** `POST /api/v1/user-memories/events/{id}/revert` | **Auth:** Yes

Restores the prior state captured by the given audit event. The revert itself is logged as a new audit event with `source: "revert"`.

**Response:**
```json
{
  "success": true,
  "data": {
    "reverted_to_event": 17,
    "scope": "memory"
  }
}
```

Returns 404 if event is not found.

---

## Scheduled Workflows API

Schedule automatic workflow executions.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/schedules` | GET | **Yes** | List all schedules |
| `/api/v1/schedules` | POST | **Yes** | Create new schedule |
| `/api/v1/schedules/stats` | GET | **Yes** | Get schedule statistics |
| `/api/v1/schedules/{id}` | GET | **Yes** | Get schedule details |
| `/api/v1/schedules/{id}` | PUT | **Yes** | Update schedule |
| `/api/v1/schedules/{id}` | DELETE | **Yes** | Delete schedule |
| `/api/v1/schedules/{id}/pause` | POST | **Yes** | Pause schedule |
| `/api/v1/schedules/{id}/resume` | POST | **Yes** | Resume schedule |

### List Schedules

**Endpoint:** `GET /api/v1/schedules` | **Auth:** Yes

### Create Schedule

**Endpoint:** `POST /api/v1/schedules` | **Auth:** Yes

**Request Body:**
```json
{
  "workflow_id": 1,
  "name": "Daily at 9am",
  "cron_expression": "0 9 * * *",
  "timezone": "America/New_York",
  "input_variables": {
    "date": "{{TODAY}}"
  }
}
```

### Get Schedule Stats

**Endpoint:** `GET /api/v1/schedules/stats` | **Auth:** Yes

### Get Schedule

**Endpoint:** `GET /api/v1/schedules/{id}` | **Auth:** Yes

### Update Schedule

**Endpoint:** `PUT /api/v1/schedules/{id}` | **Auth:** Yes

### Delete Schedule

**Endpoint:** `DELETE /api/v1/schedules/{id}` | **Auth:** Yes

### Pause Schedule

**Endpoint:** `POST /api/v1/schedules/{id}/pause` | **Auth:** Yes

### Resume Schedule

**Endpoint:** `POST /api/v1/schedules/{id}/resume` | **Auth:** Yes

---

## Contexts API

Manage conversation contexts/sessions.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/contexts` | GET | **Yes** | List all contexts |
| `/api/v1/contexts` | POST | **Yes** | Create new context |
| `/api/v1/contexts/{id}` | GET | **Yes** | Get context details |
| `/api/v1/contexts/{id}` | PUT | **Yes** | Update context |
| `/api/v1/contexts/{id}` | DELETE | **Yes** | Delete context |

### List Contexts

**Endpoint:** `GET /api/v1/contexts` | **Auth:** Yes

### Create Context

**Endpoint:** `POST /api/v1/contexts` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "Project Discussion",
  "description": "Context for project planning"
}
```

### Get Context

**Endpoint:** `GET /api/v1/contexts/{id}` | **Auth:** Yes

### Update Context

**Endpoint:** `PUT /api/v1/contexts/{id}` | **Auth:** Yes

### Delete Context

**Endpoint:** `DELETE /api/v1/contexts/{id}` | **Auth:** Yes

---

## Providers API

Manage LLM providers.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/providers` | GET | **Yes** | List available providers |
| `/api/v1/providers/switch` | POST | **Yes** | Switch active provider |

### List Providers

**Endpoint:** `GET /api/v1/providers` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "providers": [
    {"name": "claude", "enabled": true, "models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514"]},
    {"name": "openai", "enabled": true, "models": ["gpt-4o", "gpt-4-turbo"]},
    {"name": "gemini", "enabled": true, "models": ["gemini-2.0-flash", "gemini-1.5-pro"]},
    {"name": "grok", "enabled": true, "models": ["grok-2"]},
    {"name": "deepseek", "enabled": true, "models": ["deepseek-chat"]},
    {"name": "kimi", "enabled": true, "models": ["moonshot-v1-8k"]}
  ]
}
```

### Switch Provider

**Endpoint:** `POST /api/v1/providers/switch` | **Auth:** Yes

**Request Body:**
```json
{
  "provider": "claude"
}
```

---

## Settings API

User settings and configuration.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/settings/usage` | GET | **Yes** | Get usage settings |
| `/api/v1/settings/keys` | GET | **Yes** | Get API keys |
| `/api/v1/settings/keys` | POST | **Yes** | Save API keys |
| `/api/v1/settings/keys` | DELETE | **Yes** | Clear API keys |
| `/api/v1/settings/providers` | GET | **Yes** | Get provider settings |
| `/api/v1/settings/provider` | POST | **Yes** | Save provider settings |
| `/api/v1/settings/provider/active` | POST | **Yes** | Set active provider |
| `/api/v1/settings/provider` | DELETE | **Yes** | Delete provider settings |
| `/api/v1/settings/phone` | GET | **Yes** | Get phone status |
| `/api/v1/settings/storage` | GET | **Yes** | Get storage settings |
| `/api/v1/settings/storage` | POST | **Yes** | Save storage settings |

### Get API Keys & Model Selections

**Endpoint:** `GET /api/v1/settings/keys` | **Auth:** Yes

Returns masked custom API keys and per-provider model selections.

**Response:**
```json
{
  "success": true,
  "keys": {
    "claude": {
      "has_custom_key": true,
      "masked_key": "****api3",
      "updated_at": "2026-04-08 12:00:00"
    }
  },
  "models": {
    "claude": "claude-opus-4-6",
    "openai": "gpt-4o-mini"
  }
}
```

### Save API Keys & Model Selections

**Endpoint:** `POST /api/v1/settings/keys` | **Auth:** Yes

Saves custom API keys and/or per-provider model selections. Both fields are optional — you can save only keys, only models, or both.

**Request Body:**
```json
{
  "keys": {
    "openai": "sk-proj-...",
    "claude": "sk-ant-..."
  },
  "models": {
    "claude": "claude-opus-4-6",
    "openai": "gpt-4o-mini",
    "deepseek": "deepseek-reasoner"
  }
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `keys` | object | No | Map of provider name to API key string |
| `models` | object | No | Map of provider name to model ID string |

**Response:**
```json
{
  "success": true,
  "message": "Saved 2 API key(s), 3 model(s)",
  "saved_count": 2,
  "model_count": 3
}
```

### Clear API Keys & Model Selections

**Endpoint:** `DELETE /api/v1/settings/keys` | **Auth:** Yes

Clears all custom API keys **and** model selections for the authenticated user, reverting to default shared keys and default models.

### Get Provider Settings

**Endpoint:** `GET /api/v1/settings/providers` | **Auth:** Yes

### Save Provider Settings

**Endpoint:** `POST /api/v1/settings/provider` | **Auth:** Yes

### Set Active Provider

**Endpoint:** `POST /api/v1/settings/provider/active` | **Auth:** Yes

### Delete Provider Settings

**Endpoint:** `DELETE /api/v1/settings/provider` | **Auth:** Yes

### Get Phone Status

**Endpoint:** `GET /api/v1/settings/phone` | **Auth:** Yes

### Get Storage Settings

**Endpoint:** `GET /api/v1/settings/storage` | **Auth:** Yes

### Save Storage Settings

**Endpoint:** `POST /api/v1/settings/storage` | **Auth:** Yes

---

## Usage API

Track token usage and costs.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/usage` | GET | **Yes** | Get usage balance |
| `/api/v1/usage/balance` | GET | **Yes** | Get usage balance |
| `/api/v1/usage/transactions` | GET | **Yes** | Get transaction history |
| `/api/v1/usage/stats` | GET | **Yes** | Get usage statistics |

### Get Balance

**Endpoint:** `GET /api/v1/usage/balance` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "balance": {
    "total_tokens": 1000000,
    "used_tokens": 50000,
    "remaining_tokens": 950000,
    "cost_usd": 1.25
  }
}
```

### Get Transactions

**Endpoint:** `GET /api/v1/usage/transactions` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | int | Max results |
| `offset` | int | Pagination offset |
| `provider` | string | Filter by provider |

### Get Stats

**Endpoint:** `GET /api/v1/usage/stats` | **Auth:** Yes

---

## Prompt Library API

Manage reusable prompt templates.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/prompts` | GET | **Yes** | Get prompt tree |
| `/api/v1/prompts` | POST | **Yes** | Create prompt/folder |
| `/api/v1/prompts/{id}` | GET | **Yes** | Get prompt details |
| `/api/v1/prompts/{id}` | PUT | **Yes** | Update prompt |
| `/api/v1/prompts/{id}` | DELETE | **Yes** | Delete prompt |

### Get Prompt Tree

**Endpoint:** `GET /api/v1/prompts` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "tree": [
    {
      "id": 1,
      "name": "Writing",
      "type": "folder",
      "children": [
        {
          "id": 2,
          "name": "Blog Post",
          "type": "prompt",
          "content": "Write a blog post about {{topic}}"
        }
      ]
    }
  ]
}
```

### Create Prompt

**Endpoint:** `POST /api/v1/prompts` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "Blog Post",
  "content": "Write a blog post about {{topic}}",
  "parent_id": 1,
  "type": "prompt"
}
```

### Get Prompt

**Endpoint:** `GET /api/v1/prompts/{id}` | **Auth:** Yes

### Update Prompt

**Endpoint:** `PUT /api/v1/prompts/{id}` | **Auth:** Yes

### Delete Prompt

**Endpoint:** `DELETE /api/v1/prompts/{id}` | **Auth:** Yes

---

## File Storage API

Access file storage providers.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/storage/providers` | GET | **Yes** | List storage providers |
| `/api/v1/storage/list` | GET | **Yes** | List files in directory |
| `/api/v1/storage/read` | GET | **Yes** | Read file contents |

### Get Storage Providers

**Endpoint:** `GET /api/v1/storage/providers` | **Auth:** Yes

### List Files

**Endpoint:** `GET /api/v1/storage/list` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `provider` | string | Storage provider |
| `path` | string | Directory path |

### Read File

**Endpoint:** `GET /api/v1/storage/read` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `provider` | string | Storage provider |
| `path` | string | File path |

---

## MCP Servers API

Model Context Protocol server integration.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/mcp/servers` | GET | **Yes** | List enabled MCP servers |
| `/api/v1/mcp/servers` | POST | **Yes** | Create MCP server (per-user) |
| `/api/v1/mcp/servers/update` | POST | **Yes** | Update MCP server |
| `/api/v1/mcp/servers/toggle` | POST | **Yes** | Enable/disable MCP server |
| `/api/v1/mcp/servers` | DELETE | **Yes** | Delete MCP server |
| `/api/v1/mcp/servers/tools` | GET | **Yes** | Get server tools |
| `/api/v1/mcp/servers/all-tools` | GET | **Yes** | Get all MCP tools |
| `/api/v1/mcp/proxy` | POST | **Yes** | Proxy request to MCP server |
| `/api/v1/mcp/app` | GET | No | Get MCP app UI resource |
| `/api/v1/mcp/agents` | POST | **Yes** | MCP JSON-RPC for agents |

> **Note:** Admin-level MCP server management (across all users) lives under `/api/v1/admin/mcp/servers` — see the [Admin API](#admin-api).

### List MCP Servers

**Endpoint:** `GET /api/v1/mcp/servers` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "servers": [
    {
      "id": 1,
      "name": "Image-server",
      "url": "http://localhost:3001",
      "enabled": true,
      "tools_count": 2
    }
  ]
}
```

### Get Server Tools

**Endpoint:** `GET /api/v1/mcp/servers/tools` | **Auth:** Yes

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `server_id` | int | MCP server ID |

### Get All MCP Tools

**Endpoint:** `GET /api/v1/mcp/servers/all-tools` | **Auth:** Yes

### MCP Proxy

**Endpoint:** `POST /api/v1/mcp/proxy` | **Auth:** Yes

**Request Body:**
```json
{
  "server_id": 1,
  "method": "tools/call",
  "params": {
    "name": "generate-image",
    "arguments": {
      "prompt": "A sunset over mountains"
    }
  }
}
```

### Create MCP Server

**Endpoint:** `POST /api/v1/mcp/servers` | **Auth:** Yes

**Request Body:**
```json
{
  "name": "Image-server",
  "url": "http://localhost:3001",
  "description": "Optional description"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique per name |
| `url` | string | Yes | Valid URL |
| `description` | string | No | |

**Response:**
```json
{
  "success": true,
  "server_id": 12,
  "message": "Server added successfully"
}
```

Returns 409 if the name already exists, 400 if URL is invalid.

### Update MCP Server

**Endpoint:** `POST /api/v1/mcp/servers/update` | **Auth:** Yes

**Request Body:**
```json
{
  "server_id": 12,
  "name": "Image-server",
  "url": "http://localhost:3002",
  "description": "Updated"
}
```

Cached tools are cleared when the URL changes. Returns 404 if not found.

### Toggle MCP Server

**Endpoint:** `POST /api/v1/mcp/servers/toggle` | **Auth:** Yes

**Request Body:**
```json
{
  "server_id": 12,
  "enabled": true
}
```

`enabled` defaults to `true` if omitted. Returns 400 if `server_id` is missing.

### Delete MCP Server

**Endpoint:** `DELETE /api/v1/mcp/servers?server_id={id}` | **Auth:** Yes

Returns 404 if the server is not found.

### MCP App Resource

**Endpoint:** `GET /api/v1/mcp/app` | **Auth:** No

Serves HTML for MCP tool UIs in iframes. Public endpoint for iframe embedding.

### MCP Agents (JSON-RPC)

**Endpoint:** `POST /api/v1/mcp/agents` | **Auth:** Yes

JSON-RPC 2.0 endpoint for AI client integration with agents.

---

## Voice API

Voice interface and usage tracking.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/voice/usage` | POST | **Yes** | Log voice usage |
| `/api/v1/voice/stats` | GET | **Yes** | Get voice statistics |
| `/api/v1/voice/token` | POST | **Yes** | Get ephemeral token |
| `/api/v1/voice/config` | GET | **Yes** | Get voice configuration |

### Log Voice Usage

**Endpoint:** `POST /api/v1/voice/usage` | **Auth:** Yes

### Get Voice Stats

**Endpoint:** `GET /api/v1/voice/stats` | **Auth:** Yes

### Get Ephemeral Token

**Endpoint:** `POST /api/v1/voice/token` | **Auth:** Yes

### Get Voice Config

**Endpoint:** `GET /api/v1/voice/config` | **Auth:** Yes

---

## WebAuthn API

Biometric/passkey authentication.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/webauthn/challenge` | POST | No | Get authentication challenge |
| `/api/v1/webauthn/register` | POST | **Yes** | Register new credential |
| `/api/v1/webauthn/authenticate` | POST | No | Authenticate with credential |
| `/api/v1/webauthn/register` | DELETE | **Yes** | Delete credential |

### Get Challenge

**Endpoint:** `POST /api/v1/webauthn/challenge` | **Auth:** No

Public endpoint to get a challenge for WebAuthn authentication flow.

### Register Credential

**Endpoint:** `POST /api/v1/webauthn/register` | **Auth:** Yes

Requires authentication to register a new passkey to the user's account.

### Authenticate

**Endpoint:** `POST /api/v1/webauthn/authenticate` | **Auth:** No

Public endpoint used during login with passkey.

### Delete Credential

**Endpoint:** `DELETE /api/v1/webauthn/register` | **Auth:** Yes

Requires authentication to delete an existing passkey.

---

## Hume Tools API

Integration with Hume AI for voice/emotion.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/hume/tools/execute` | POST | **Yes** | Execute Hume tool |
| `/api/v1/hume/tools/list` | GET | **Yes** | List Hume tools |
| `/api/v1/hume/tools/sync` | POST | **Yes** | Sync tools with Hume |
| `/api/v1/hume/tools/status` | GET | **Yes** | Get integration status |
| `/api/v1/hume/tools/test-connection` | GET | **Yes** | Test Hume connection |
| `/api/v1/hume/config` | GET | **Yes** | Get Hume configuration |
| `/api/v1/evi/webhook` | POST | No | EVI webhook callback |

### Execute Tool

**Endpoint:** `POST /api/v1/hume/tools/execute` | **Auth:** Yes

### List Tools

**Endpoint:** `GET /api/v1/hume/tools/list` | **Auth:** Yes

### Sync Tools

**Endpoint:** `POST /api/v1/hume/tools/sync` | **Auth:** Yes

### Get Status

**Endpoint:** `GET /api/v1/hume/tools/status` | **Auth:** Yes

### Test Connection

**Endpoint:** `GET /api/v1/hume/tools/test-connection` | **Auth:** Yes

### Get Config

**Endpoint:** `GET /api/v1/hume/config` | **Auth:** Yes

### EVI Webhook

**Endpoint:** `POST /api/v1/evi/webhook` | **Auth:** No

External webhook for Hume EVI callbacks. Public endpoint for Hume to call.

---

## Google Drive API

Save content to Google Drive.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/drive/save` | POST | **Yes** | Save content to Drive |

### Save to Drive

**Endpoint:** `POST /api/v1/drive/save` | **Auth:** Yes

**Request Body:**
```json
{
  "content": "File content",
  "filename": "document.txt",
  "folder_id": "optional_folder_id"
}
```

---

## Packages API

Role-based capability bundles (e.g., providers allowlist, sidebar items, MCP servers, skills, quotas). Resolved by user role: `guest`, `prospect`, `user`, `admin`.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/me/package` | GET | **Yes** | Get the authenticated user's effective package |
| `/api/v1/admin/packages` | GET | **Admin** | List all role packages |
| `/api/v1/admin/packages/{role}` | GET | **Admin** | Get a single role's package |
| `/api/v1/admin/packages/{role}` | PUT | **Admin** | Update a role's package |

### Get My Package

**Endpoint:** `GET /api/v1/me/package` | **Auth:** Yes

**Response:**
```json
{
  "success": true,
  "role": "user",
  "capabilities": {
    "providers": {"claude": true, "openai": true},
    "sidebar": {"workflows": true, "agents": true},
    "mcp_servers": ["Image-server"],
    "skills": ["summarize"],
    "quota_tokens": 1000000
  },
  "updated_at": "2026-04-25T10:00:00Z"
}
```

### List Packages (Admin)

**Endpoint:** `GET /api/v1/admin/packages` | **Auth:** Admin

**Response:**
```json
{
  "success": true,
  "packages": [
    {"role": "guest", "capabilities": {...}, "updated_at": null},
    {"role": "prospect", "capabilities": {...}, "updated_at": "..."},
    {"role": "user", "capabilities": {...}, "updated_at": "..."},
    {"role": "admin", "capabilities": {...}, "updated_at": "..."}
  ]
}
```

### Get Package (Admin)

**Endpoint:** `GET /api/v1/admin/packages/{role}` | **Auth:** Admin

`{role}` must be one of: `guest`, `prospect`, `user`, `admin`.

### Update Package (Admin)

**Endpoint:** `PUT /api/v1/admin/packages/{role}` | **Auth:** Admin

**Request Body:**
```json
{
  "capabilities": {
    "providers": {"claude": true, "openai": true},
    "sidebar": {"workflows": true},
    "mcp_servers": ["Image-server"],
    "skills": ["summarize"],
    "quota_tokens": 1000000
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `capabilities.providers` | object | Yes | Provider allowlist |
| `capabilities.sidebar` | object | Yes | Sidebar item allowlist |
| `capabilities.mcp_servers` | array \| null | No | |
| `capabilities.skills` | array \| null | No | |
| `capabilities.quota_tokens` | int \| null | No | Token quota for the role |

---

## Admin API

Administrative functions (requires admin privileges).

**Note:** All Admin API endpoints require authentication with admin privileges.

### User Account Detail

**Endpoint:** `GET /api/v1/admin/users/{id}/account` | **Auth:** Admin

Returns a flattened account summary aggregating user data and token usage from `llm_usage_transactions`.

**Response:**
```json
{
  "success": true,
  "account": {
    "id": 42,
    "email": "user@example.com",
    "phone": "+1234567890",
    "first_name": "John",
    "last_name": "Doe",
    "plan": "premium",
    "role": "user",
    "provider": "firebase",
    "email_verified": true,
    "has_firebase_uid": true,
    "last_login": "2026-04-25T10:00:00Z",
    "created_at": "2026-01-12T08:30:00Z",
    "tokens_in": 124500,
    "tokens_out": 38200,
    "total_tokens": 162700,
    "free_quota": 50000,
    "is_free_prospect": false,
    "free_quota_percent": null
  }
}
```

Returns 404 if the user does not exist.

### User Costs

**Endpoint:** `GET /api/v1/admin/users/{id}/costs` | **Auth:** Admin

Computes LLM and voice usage costs over the last 30 days. Pricing is sourced from `system_llm_settings`, falling back to hardcoded defaults.

**Response:**
```json
{
  "success": true,
  "user_id": 42,
  "usageCosts": {
    "llm": {
      "byProvider": [
        {
          "provider": "claude",
          "total_requests": 18,
          "tokens_in": 124500,
          "tokens_out": 38200,
          "total_tokens": 162700,
          "cost_in": 0.37,
          "cost_out": 0.57,
          "resolved_price_in": 3.0,
          "resolved_price_out": 15.0,
          "last_used": "2026-04-25T10:00:00Z"
        }
      ],
      "summary": {"...": "..."}
    },
    "voice": {"byProvider": [], "summary": {}},
    "totals": {
      "cost_today": 0.10,
      "cost_week": 0.45,
      "cost_month": 0.94,
      "cost_total": 0.94,
      "voice_cost_today": 0,
      "voice_cost_week": 0,
      "voice_cost_month": 0,
      "voice_cost_total": 0
    }
  }
}
```

### User Management

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/users` | GET | **Admin** | List all users |
| `/api/v1/admin/users/{id}` | GET | **Admin** | Get user details |
| `/api/v1/admin/users/{id}/account` | GET | **Admin** | Get user account summary (incl. token usage) |
| `/api/v1/admin/users/{id}/costs` | GET | **Admin** | Get user usage costs (LLM + voice, 30-day rolling) |
| `/api/v1/admin/users` | POST | **Admin** | Create user |
| `/api/v1/admin/users/update` | POST | **Admin** | Update user |
| `/api/v1/admin/users/{id}` | DELETE | **Admin** | Delete user |

### Provider Management

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/users/{id}/providers` | GET | **Admin** | Get user provider settings |
| `/api/v1/admin/providers` | POST | **Admin** | Save provider settings |
| `/api/v1/admin/providers/toggle` | POST | **Admin** | Toggle provider enabled |
| `/api/v1/admin/providers/category-toggle` | POST | **Admin** | Toggle category enabled |
| `/api/v1/admin/providers` | DELETE | **Admin** | Delete provider settings |

### API Key Management

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/users/{id}/keys` | GET | **Admin** | Get user API keys |
| `/api/v1/admin/keys` | POST | **Admin** | Save API keys |
| `/api/v1/admin/keys/delete` | POST | **Admin** | Delete API key |

### Usage Statistics

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/usage/stats` | GET | **Admin** | Get overall usage stats |
| `/api/v1/admin/usage/by-user` | GET | **Admin** | Get usage by user |
| `/api/v1/admin/usage/users/{id}` | GET | **Admin** | Get user usage detail |
| `/api/v1/admin/usage/transactions` | GET | **Admin** | Get usage transactions |
| `/api/v1/admin/usage/tools` | GET | **Admin** | Get tool usage stats |

### MCP Server Management

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/mcp/servers` | GET | **Admin** | List MCP servers |
| `/api/v1/admin/mcp/servers` | POST | **Admin** | Create MCP server |
| `/api/v1/admin/mcp/servers/update` | POST | **Admin** | Update MCP server |
| `/api/v1/admin/mcp/servers/toggle` | POST | **Admin** | Toggle server enabled |
| `/api/v1/admin/mcp/servers/refresh` | POST | **Admin** | Refresh server tools |
| `/api/v1/admin/mcp/servers/{id}` | DELETE | **Admin** | Delete MCP server |

**Create MCP Server:**
```json
{
  "name": "my-mcp-server",
  "url": "http://localhost:3001",
  "description": "Optional description"
}
```

**Refresh Server Tools:**
```json
{
  "server_id": 1
}
```

#### Per-User MCP Server Overrides

Manage what MCP servers are available to **one specific user** on top of the
role's package allowlist. Backs the per-user MCP panel in `gpt_admin`.
Cascade: package → admin override → (future user pref). See
[MCP Server Visibility Cascade](#mcp-server-visibility-cascade).

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/users/{id}/mcp-servers` | GET | **Admin** | Effective MCP server list for one user (every visible server with `package_default`, `override`, `effective`). |
| `/api/v1/admin/users/{id}/mcp-servers/{serverId}/override` | PUT | **Admin** | Set a per-user override. Body: `{"allowed": true \| false}`. |
| `/api/v1/admin/users/{id}/mcp-servers/{serverId}/override` | DELETE | **Admin** | Clear the per-user override → revert to package default. |

**GET response:**
```json
{
  "success": true,
  "user_id": 3,
  "package_allowlist": ["Battery", "Cryptos", "Financial News", "..."],
  "servers": [
    {
      "id": 28,
      "name": "Battery",
      "url": "http://localhost/battery/mcp.php",
      "description": "A server connected to battery magazines RSS",
      "is_global": true,
      "is_user_private": false,
      "enabled": true,
      "tool_count": 2,
      "package_default": true,
      "override": null,
      "effective": true
    }
  ]
}
```

`package_allowlist` is `null` when the role's package has no MCP restriction
(allow everything). Per-row fields:

| Field | Meaning |
|-------|---------|
| `package_default` | Would the package allow this server for this user without any override? |
| `override` | Per-user override row: `true` (force on), `false` (force off), `null` (no row). |
| `effective` | Resolved enabled state after applying the cascade. |

**Set override:**
```bash
curl -X PUT https://api.yourdomain.com/api/v1/admin/users/3/mcp-servers/28/override \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"allowed": false}'
```

**Clear override:**
```bash
curl -X DELETE https://api.yourdomain.com/api/v1/admin/users/3/mcp-servers/28/override \
  -H "Authorization: Bearer $JWT"
```

Response: `{"success": true, "user_id": 3, "server_id": 28, "cleared": true}`.

### Cost Management

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/costs` | GET | **Admin** | Get pricing data |
| `/api/v1/admin/costs/refresh` | POST | **Admin** | Refresh all costs |
| `/api/v1/admin/costs/refresh-provider` | POST | **Admin** | Refresh provider costs |
| `/api/v1/admin/exchange-rates` | GET | **Admin** | Get exchange rates |
| `/api/v1/admin/exchange-rates/refresh` | POST | **Admin** | Refresh exchange rates |

### System LLM Settings

Manage system-wide LLM provider configurations stored in the database.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/admin/llm-settings` | GET | **Admin** | List all LLM providers |
| `/api/v1/admin/llm-settings/{key}` | GET | **Admin** | Get single provider |
| `/api/v1/admin/llm-settings` | POST | **Admin** | Create/update provider |
| `/api/v1/admin/llm-settings/{key}` | DELETE | **Admin** | Delete provider |
| `/api/v1/admin/llm-settings/toggle` | POST | **Admin** | Toggle provider enabled |
| `/api/v1/admin/llm-settings/seed` | POST | **Admin** | Seed from config file |

**List LLM Providers:**

`GET /api/v1/admin/llm-settings`

Response:
```json
{
  "success": true,
  "providers": [
    {
      "id": 1,
      "provider_key": "claude",
      "display_name": "Claude 4.5",
      "api_key_masked": "sk-a***api3",
      "model": "claude-sonnet-4-5",
      "base_url": "https://api.anthropic.com",
      "max_tokens": 64000,
      "temperature": 0.7,
      "chat_endpoint": null,
      "streaming": true,
      "supports_tools": true,
      "supported_models": [],
      "api_format": "anthropic",
      "system_prompt": "...",
      "enabled": true,
      "is_default": false,
      "sort_order": 0
    }
  ],
  "source": "database"
}
```

**Source values:** `database` (from DB) or `config` (fallback to ai_config.php)

**Create/Update Provider:**

`POST /api/v1/admin/llm-settings`

```json
{
  "provider_key": "custom_provider",
  "display_name": "Custom Provider",
  "api_key": "sk-...",
  "model": "custom-model-v1",
  "base_url": "https://api.custom.com",
  "max_tokens": 4096,
  "temperature": 0.7,
  "chat_endpoint": "/v1/chat/completions",
  "streaming": true,
  "supports_tools": true,
  "supported_models": ["model-v1", "model-v2"],
  "api_format": "openai",
  "system_prompt": "You are a helpful assistant.",
  "enabled": true,
  "sort_order": 10
}
```

**API Format values:** `openai`, `anthropic`, `gemini`

**Notes:**
- `provider_key` is unique and immutable after creation
- `api_key` can be omitted when updating to keep existing key
- If `api_key` contains `***`, existing key is preserved

**Toggle Provider:**

`POST /api/v1/admin/llm-settings/toggle`

```json
{
  "provider_key": "claude",
  "enabled": true
}
```

**Seed from Config:**

`POST /api/v1/admin/llm-settings/seed`

Imports all providers from `ai_config.php` into the database. Existing providers with same key are updated.

Response:
```json
{
  "success": true,
  "message": "Providers seeded from config",
  "seeded": ["claude", "openai", "kimi", "grok", "gemini", "deepseek"],
  "default_provider": "kimi"
}
```

---

## Scheduler API

Automated workflow scheduling.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/scheduler/run` | POST | Internal | Trigger scheduled workflows |
| `/api/v1/scheduler/status` | GET | **Yes** | Get scheduler status |

### Run Scheduler

**Endpoint:** `POST /api/v1/scheduler/run` | **Auth:** Internal Token

Triggers scheduled workflow execution. Called by cron job with internal scheduler token (not user JWT).

### Get Scheduler Status

**Endpoint:** `GET /api/v1/scheduler/status` | **Auth:** Yes

---

## App Keys API

Scoped, revocable credentials that let **client code** (a web page, a CLI, a browser extension, a server-to-server integration) call the backend **without embedding a user's login JWT**. A login JWT carries full account authority and is unsafe to place anywhere observable; an app key authorizes only the specific actions named in its `scopes`.

### Concept

- An **app key** is a string of the form `ak_<32 hex chars>` (e.g. `ak_8f2a1c4d9b3e7f02a1cd5e8493ff2106`).
- Each key is bound at mint time to one **user** (`user_id` — the user the key operates on behalf of) and one **application** (`application_id` — a free identifier for the calling application, e.g. `webmcp-newspaper-demo`).
- A key's authority is its **`scopes`** — a list of strings like `workflows:run:42`. An endpoint that accepts app keys checks the relevant scope before proceeding. A leaked key can do exactly what its scopes say and nothing more.
- Keys are **stored hashed**: the table keeps a non-secret 12-char `key_prefix` (indexed, for fast lookup) and an HMAC-SHA256 `key_hash` (peppered with a server-side secret). A database leak does not expose usable keys.
- Keys are **revocable** independently of the user's password/login (soft-delete; a revoked key is treated as not-found).

### Authentication — same header, two schemes

App keys travel on the **same `Authorization` header** as JWTs. The scheme name is the switch:

```
Authorization: Bearer <jwt>      # user login
Authorization: AppKey ak_<…>     # app key
```

`AuthMiddleware` recognizes both. A JWT-authed request gets `auth_type = 'jwt'`; an app-key-authed request gets `auth_type = 'app_key'` plus `application_id` and the key's `scopes`. Both paths populate `user_id`, so downstream controllers are agnostic to which scheme authenticated the call.

### Endpoints Overview

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/app-keys` | POST | **Admin** | Mint a new app key |
| `/api/v1/app-keys` | GET | **Admin** | List app keys (metadata only) |
| `/api/v1/app-keys/whoami` | GET | **AppKey** | Introspect the calling key |
| `/api/v1/app-keys/{id}` | DELETE | **Admin** | Revoke an app key |

The three CRUD endpoints require a JWT from a user with `role = 'admin'` — an app key can never mint, list, or revoke keys (closes the privilege-escalation path). `whoami` is the only endpoint an app key may call on this resource.

### Mint an App Key

**Endpoint:** `POST /api/v1/app-keys` | **Auth:** Admin (JWT, `role=admin`)

**Request Body:**
```json
{
  "user_id": 3,
  "application_id": "webmcp-newspaper-demo",
  "name": "WebMCP demo key",
  "scopes": ["workflows:run:42"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `user_id` | integer | Yes | The user the key operates on behalf of. Must be an existing user. |
| `application_id` | string | Yes | Free identifier for the calling application (slug, UUID, etc.). |
| `name` | string | Yes | Human label for this specific key. |
| `scopes` | string[] | Yes | Non-empty list of scope strings. See [Scopes](#scopes). |

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "user_id": 3,
    "application_id": "webmcp-newspaper-demo",
    "name": "WebMCP demo key",
    "key_prefix": "ak_df72ebaed",
    "scopes": ["workflows:run:42"],
    "full_key": "ak_df72ebaed0a9fa292c2bf5f66dd61b41",
    "created_at": "2026-05-22 02:13:18"
  }
}
```

⚠️ **`full_key` is returned exactly once.** It is not recoverable afterwards — the database stores only the hash. If lost, revoke the key and mint a new one.

### List App Keys

**Endpoint:** `GET /api/v1/app-keys` | **Auth:** Admin

**Query parameters (optional):**

| Param | Description |
|-------|-------------|
| `application_id` | Filter to one application |
| `user_id` | Filter to one user |

**Response (200):** an array of key metadata. **Never** includes `key_hash` or `full_key`.
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 3,
      "application_id": "webmcp-newspaper-demo",
      "name": "WebMCP demo key",
      "key_prefix": "ak_df72ebaed",
      "scopes": ["workflows:run:42"],
      "created_at": "2026-05-21 20:13:18",
      "last_used_at": "2026-05-21 20:13:19",
      "revoked_at": null
    }
  ]
}
```

### Introspect the Calling Key

**Endpoint:** `GET /api/v1/app-keys/whoami` | **Auth:** AppKey

Lets client code confirm what its own key authorizes. Returns no user information.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "application_id": "webmcp-newspaper-demo",
    "scopes": ["workflows:run:42"]
  }
}
```

Called with a JWT (or no credential) → `401`.

### Revoke an App Key

**Endpoint:** `DELETE /api/v1/app-keys/{id}` | **Auth:** Admin

Soft-deletes the key (sets `revoked_at`). A revoked key is rejected by `AuthMiddleware` as if it never existed.

**Response (200):**
```json
{ "success": true, "data": { "id": 1, "revoked": true } }
```

`404` if no key with that id exists.

### Scopes

A scope is a string an endpoint checks before honoring an app-key call. Current vocabulary:

| Scope | Authorizes |
|-------|-----------|
| `workflows:run:<id>` | Running the specific workflow `<id>` via `POST /api/v1/workflows/{id}/run` |
| `workflows:run` | Running any workflow the bound user owns (broad — prefer the per-id form) |

Endpoints opt into app-key auth by adding a scope check. The canonical example is `WorkflowController::run()`:

```php
if (($request['auth_type'] ?? null) === 'app_key') {
    $scopes = $request['app_key_scopes'] ?? [];
    $allowed = in_array('workflows:run', $scopes, true)
        || in_array("workflows:run:{$workflowId}", $scopes, true);
    if (!$allowed) {
        return ['success' => false, 'error' => '…', 'status_code' => 403];
    }
}
```

JWT-authed callers skip the scope check entirely (full account authority). An endpoint that does **not** add this block does not accept app keys at all — opting in is explicit and per-endpoint.

### Example: calling a scoped endpoint with an app key

```bash
curl -X POST http://<host>/gpt/backend/api/v1/workflows/42/run \
  -H "Authorization: AppKey ak_df72ebaed0a9fa292c2bf5f66dd61b41" \
  -H "Content-Type: application/json" \
  -d '{"variables":{"prompt":"Vitamin D and vascular aging"}}'
```

The middleware resolves the key → sets `user_id` (the bound user) and `auth_type=app_key`; `run()` verifies `workflows:run:42` is in the key's scopes; the existing ownership check confirms workflow 42 belongs to the bound user; the workflow runs.

### Configuration

`config/ai_config.php` → `auth.app_key_secret` — the HMAC pepper for `app_keys.key_hash`. Rotating it invalidates every existing app key. Must be set; `AppKeyRepository` throws if it's empty.

### Storage

Table `app_keys` (in the `contexts_database`):

| Column | Notes |
|--------|-------|
| `id` | PK |
| `user_id` | The user the key acts on behalf of |
| `application_id` | Free application identifier |
| `name` | Human label |
| `key_prefix` | First 12 chars; indexed; not secret |
| `key_hash` | HMAC-SHA256(server_secret, full_key); secret |
| `scopes` | JSON array of scope strings |
| `created_at`, `last_used_at`, `revoked_at` | Timestamps; `revoked_at` non-null = revoked |

---

## Error Handling

All error responses follow this format:

```json
{
  "success": false,
  "error": "Error message describing what went wrong",
  "status_code": 400
}
```

### HTTP Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing/invalid token |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource doesn't exist |
| 405 | Method Not Allowed |
| 500 | Internal Server Error |

---

## Architecture

### Request Flow

```
Client Request
    ↓
MiddlewareProcessor
    ├── CorsMiddleware (CORS headers)
    └── AuthMiddleware (JWT validation)
    ↓
FastRoute Dispatcher
    ↓
Controller
    ↓
Service Layer
    ↓
LLM Provider / Database
    ↓
Response
```

### Tool Execution Flow

```
Chat Request (with optional tools[] filter)
    ↓
ChatController
    ↓
FilteredToolsExecutor (filters tool list)
    ↓
CombinedToolsExecutor
    ├── ToolsManager (built-in tools)
    └── MCPToolsLoader (MCP server tools)
    ↓
LLM Provider (receives filtered tools)
    ↓
Tool Execution
    ↓
Response
```

### Agent Execution Flow

```
Agent Request
    ↓
AgentController
    ↓
AgentRunner
    ├── Build tools for agent type
    │   ├── Manager → delegation tools only
    │   └── Worker → builtin + MCP tools
    ├── Apply tools filter (if specified)
    └── AgentToolsExecutor
    ↓
LLM Provider
    ↓
Tool Execution / Agent Delegation
    ↓
Response
```

## Security Considerations

- API keys stored in config (move to .env for production)
- CORS currently allows all origins (restrict in production)
- No rate limiting implemented yet
- JWT authentication available but not enforced
- Admin endpoints require admin role verification
- **Grok Voice uses ephemeral tokens** - permanent API key stays server-side, frontend receives short-lived tokens via `/api/v1/voice/token`

## Next Steps

1. Add JWT authentication middleware
2. ~~Implement usage statistics and monitoring~~ ✅ Implemented
3. Add rate limiting
4. Move API keys to environment variables
5. Add request validation
6. Implement proper error logging
7. ~~Add voice usage tracking for Gemini/Grok Live~~ ✅ Implemented
8. ~~Add MCP server management~~ ✅ Implemented
9. ~~Add tool usage statistics~~ ✅ Implemented
10. ~~Add secure ephemeral tokens for Grok voice~~ ✅ Implemented
11. End-user MCP preference layer (tier 3 of the [visibility cascade](#mcp-server-visibility-cascade)) — currently unimplemented. Today the chat-side `/mcp/servers/toggle` is a no-op for global servers (only flips the user's own private servers); a dedicated `user_mcp_preferences` table + filter pass in `MCPToolsLoader` would let end-users pick a subset of the admin-allowed set.

## Changelog

### 2026-05-24 — Multi-tool-call client dispatch + URL-fetch status mapping
- **`chat.js::dispatchClientToolCall` now handles N `tool_use` blocks per assistant turn.** Previously the frontend strictly threw on `payload.tool_calls.length > 1` with *"V1 supports one per turn"*, killing every multi-step orchestration (e.g. an audit skill that batched 4 `run_skill_script` calls). The backend already passes `pending_tool_calls` as an array (`ChatController::chat` returns it whole) — the frontend cap was the bottleneck. The dispatcher now extracts each call into a new `_executeSingleClientToolCall` helper, runs them sequentially through Pyodide (single shared instance), collects all tool_results, and posts them back to `/api/v1/chat` in **one** continuation with N `tool_calls` in the assistant message and N `role: "tool"` entries paired by `tool_use_id` — the standard Anthropic/OpenAI tool-use shape. Single-call flows are bit-identical to the pre-change behavior; the depth counter still counts continuation rounds, not individual calls.
- **Multi-`discover_skill` rounds no longer lock the follow-up to a single skill.** The `followUpExtras` merge (which carries `skill_content` + `skill_metadata` for chip-equivalent promotion) was last-wins via `Object.assign`. When an orchestrator emitted N `discover_skill` calls in one round, only the LAST skill's metadata survived — the backend then switched to single-skill schema for the next round, stripping `dir_name` from `run_skill_script` so every subsequent call dispatched against that one skill. Fix: if N > 1 `discover_skill` calls happened, clear `mergedFollowUpExtras` so the multi-skill catalog stays active. Each discovered SKILL.md body is already in the per-call tool_result history.
- **`UrlFetchController` — upstream non-2xx is no longer reported as `502 Bad Gateway`.** Previously a target site returning `404` (missing `/robots.txt`, `/llms.txt`, `/sitemap.xml`) made the controller respond with HTTP `502` and a small JSON body. The 502 surfaced as a red error in the browser console even though skill scripts already handle "absent" gracefully via the `success` flag. Now upstream non-2xx returns HTTP **200** with `success: false`, `error: "Upstream returned HTTP <code>"`, and `data.upstream_status: <code>`. Curl-failure 502 (line 130-136) and 5MB-oversize 502 (line 137-143) are preserved — those are genuine gateway failures.

### 2026-05-21 — App-key authentication service
- New table `app_keys` — scoped, revocable credentials for client code that calls the backend without a user's login JWT. See [App Keys API](#app-keys-api).
- New endpoints: `POST/GET /api/v1/app-keys` and `DELETE /api/v1/app-keys/{id}` (admin-only), plus `GET /api/v1/app-keys/whoami` (app-key-authed introspection).
- `AuthMiddleware` now accepts a second credential scheme on the same `Authorization` header: `AppKey ak_<…>` alongside `Bearer <jwt>`. App-key requests get `auth_type='app_key'` + `application_id` + `app_key_scopes`; JWT requests get `auth_type='jwt'`. Both populate `user_id`. The middleware lazily opens a DB connection only when an app key is actually presented.
- `MiddlewareProcessor` passes the full config to `AuthMiddleware` (needed for the app-key DB lookup).
- New `AppKeyRepository` (mint / verify / revoke / list) and `AppKeyController` (the 4 endpoints). Keys stored as indexed `key_prefix` + HMAC-SHA256 `key_hash`; `full_key` is shown once at mint and never recoverable.
- `WorkflowController::run()` is the first scope-gated consumer: an app-key caller must carry `workflows:run` or `workflows:run:<id>`; JWT callers are unaffected.
- New config key `auth.app_key_secret` — HMAC pepper for `app_keys.key_hash`.

### 2026-05-03 — Folder-backed Skills Phase B (client-side Pyodide tools, Claude only)

End-to-end flow that lets a Skill ship Python scripts and have the LLM invoke them in-browser via Pyodide. See [Client-side Tool Execution (Skills)](#client-side-tool-execution-skills) for the full workflow.

**`POST /api/v1/chat` request shape additions:**
- New optional field `skill_metadata` (`{ dir_name, scripts[] }`). When present and `provider === 'claude'`, a `run_skill_script` tool is declared to the LLM with the standard input schema (`script` enum-constrained to listed paths, plus `argv` / `input_files` / `read_outputs`).
- `skill_content` field is now properly threaded into the system prompt for both streaming and non-streaming paths (it was previously silently dropped on the streaming path due to a missing parameter — that bug is fixed by the same change).
- Empty `message` is now allowed when `conversation_history` ends with a `role: "tool"` entry — this is the continuation marker for the second shot of a client-tool round.

**New SSE event:** `client_tool_call` (assistant_text + tool_calls payload) — emitted when the LLM invokes a tool from `ClaudeProvider::CLIENT_SIDE_TOOLS`. The accompanying `response` event carries `pending_client_tool_call: true`. Verifier and compare are skipped on the placeholder shot.

**Backend additions:**
- `ChatController::sanitizeSkillMetadata(mixed): ?array` — validates the request payload, rejects path-traversal/absolute paths.
- `ChatController::buildRunSkillScriptTool(array): array` — builds the JSON-Schema tool def from the validated metadata.
- `ChatController::handleStreamingChat` and `handleRegularChat` now take `$skillContent` and `$skillMetadata` as trailing parameters.
- `ClaudeProvider::CLIENT_SIDE_TOOLS` constant — narrow allowlist of tool names that bypass server-side execution.
- `ClaudeProvider::lastBlockIsToolResult(array): bool` — used by `buildMessages` to detect continuation turns.
- `ClaudeProvider::handleToolUseRecursive` extended to short-circuit on client-side tools (mixed turns fail closed).
- `ClaudeProvider::buildMessages` extended to round-trip OpenAI-shape `tool_calls` and `role: tool` history entries into Anthropic `tool_use` / `tool_result` blocks, and to skip the empty-user-turn append when the tail is already a `tool_result`.
- `LLMManager::normalizeConversationHistory` now has two pass-through branches that preserve `tool_call_id` (on `role: tool`) and `tool_calls` (on `role: assistant` with empty content) — the cross-provider flattener used to drop both, which would have destroyed the second-shot data.

**Frontend additions** (out of scope for this README, listed for completeness): `pyodide-runner.js` (lazy Pyodide loader + skill mount), `skillsFs.listSkillScripts(dirName)`, `chat.js::dispatchClientToolCall(payload, ctx, depth)`, plus drag-payload extension to carry `dir_name` + `scripts`.

**No new endpoints** — `POST /api/v1/chat` handles both shots of the round-trip.

### 2026-05-03 — Per-user MCP server overrides
- New table `user_mcp_overrides(user_id, server_id, allowed)` (migration `008_create_user_mcp_overrides_table.sql`).
- New admin endpoints under `/api/v1/admin/users/{id}/mcp-servers` for the merged effective list and per-user override set/clear. See [Per-User MCP Server Overrides](#per-user-mcp-server-overrides).
- `MCPToolsLoader::loadToolsForUser()` and `MCPServerController::list()` / `getTools()` / `getAllTools()` updated to apply the package + override cascade. Chat picker, runtime tool resolution, and `gpt_admin` per-user panel are now consistent.
- Backs the per-user MCP toggle UI in `gpt_admin` (`UserMcpServersPanel.tsx`).
- Subtractive-only model in the `gpt_admin` UI: admin can disable package-allowed servers per user; cannot grant beyond the package. Force-on overrides are still respected by the loader if a row exists with `allowed=1` (legacy / manual rows).

### 2026-05-03 — Role validation accepts `guest`
- `AdminController::createUser` and `updateUser` now allow `role: "guest"` (previously coerced to `user` on create, rejected on update). Aligns with the `users.role` ENUM (`guest, prospect, user, admin`) introduced in migration 006.

