# gpt — Multi‑Provider AI Framework

A self‑hostable **framework for building with many LLM providers**. It brings together three things:

- 🧩 **A harness** — a backend runtime that brokers **Claude, OpenAI, Grok, Gemini, DeepSeek, and
  Kimi** behind one API, with streaming, function/tool calling, MCP, agent teams, and LangGraph
  workflows. It handles provider resolution, auth, tool execution, and orchestration so you don't
  have to.
- 🗣️ **A human‑AI interface** — a frontend for *directing* and *conversing with* the AI: a chat UI,
  realtime voice, and a visual workflow editor.
- 📦 **Packaged know‑how** — reusable capability built in: browser‑side **Skills** (Python), MCP tool
  servers, agent‑team designs, workflow templates, and service integrations (search, financial,
  PubMed, Google Drive).

Chat is just one surface onto a general multi‑provider AI orchestration layer.

> **Status:** standalone, self‑hostable. Secrets live outside the repo — see [Configuration](#configuration--secrets).

---

## What it does

- **One chat API, many providers.** Talk to **Claude, OpenAI, Grok, Gemini, DeepSeek, and Kimi**
  through a single endpoint. Provider keys are managed in the database (global + per‑user), not in code.
- **Streaming.** Responses stream over **Server‑Sent Events (SSE)**, with progress, verifier, and
  compare events.
- **Tools & MCP.** Function‑calling with a server‑side tool registry and **MCP** (Model Context
  Protocol) servers, plus **client‑side "Skills"** that run **Python in the browser** (Pyodide/WASM)
  against the user's local folder via the File System Access API.
- **Realtime voice.** A voice prompt‑builder backed by **Hume EVI**, **Grok realtime**, and
  **Gemini native audio**.
- **Agents & workflows.** Agent teams and a **visual workflow editor** that **compiles to LangGraph**.
- **Auth & accounts.** Firebase (Google/Facebook OAuth), app keys, per‑user API keys, plans/subscriptions.
- **Integrations.** Web/search (SerpAPI, Brave, ScrapingDog), financial data (FMP), PubMed, Google Drive.

---

## Architecture

```
gpt/
├── backend/     PHP 8.1+ API (front controller at /api/v1), Composer, MySQL
│   ├── src/         controllers, services (LLMProviderResolver, …), AgentTeam, middleware
│   ├── config/      ai_config.php (reads backend/.env), load_env.php
│   ├── schema/      chatbot.sql — DB schema (no data)
│   └── .env         secrets (gitignored; copy from .env.example)
└── frontend/    static HTML/CSS/JS (no build step), served by any web server
    ├── assets/js/   config.js (gitignored), chat, voice, workflow editor
    └── voice/       voice PWA + config.json (gitignored)
```

- **LLM provider keys live only in the database** (`system_llm_settings` global, `user_api_keys`
  per‑user), resolved by `LLMProviderResolver` — never in committed files.
- The backend uses **two MySQL connections**: a primary `chatbot` DB (auth, contexts,
  provider settings) and a residual `portfolio_manager` connection inherited from the app this was
  derived from (see [`docs/HARDENING.md`](docs/HARDENING.md)).

---

## Quick start

**Prerequisites:** PHP 8.1+, Composer, MySQL, and a web server (e.g. Apache / XAMPP). No Node build step.

```bash
# 1. Backend dependencies
cd backend && composer install

# 2. Backend secrets
cp .env.example .env          # then fill in DB credentials + service keys

# 3. Database
#    create a DB, then import the schema:
mysql -u <user> -p <db> < backend/schema/chatbot.sql
#    add your LLM provider keys to the system_llm_settings table

# 4. Frontend config
cp frontend/assets/js/config.example.js frontend/assets/js/config.js
cp frontend/voice/config.example.json   frontend/voice/config.json
#    fill in the keys in both

# 5. Serve the repo with your web server and open frontend/index.html
```

Details: [`backend/README.md`](backend/README.md) (installation, API) and
[`frontend/README.md`](frontend/README.md) (setup, usage).

---

## Configuration & secrets

All secrets are kept **out of the repository** and gitignored; committed `*.example` templates
document every key:

| Real file (gitignored) | Template (committed) | Holds |
|---|---|---|
| `backend/.env` | `backend/.env.example` | DB connectors, `jwt_secret`, `app_key_secret`, voice/search/financial keys |
| `frontend/assets/js/config.js` | `config.example.js` | Firebase web config + voice provider keys |
| `frontend/voice/config.json` | `voice/config.example.json` | voice PWA config |

LLM **chat** provider keys are stored in the **database**, not in any of these files. See
[`docs/HARDENING.md`](docs/HARDENING.md) for known security follow‑ups (e.g. moving the browser‑side
voice keys to backend brokering).

---

## Documentation

**Component guides**
- [`backend/README.md`](backend/README.md) — project structure, installation, API reference, tools & MCP architecture, LLM invocation paths, voice pricing
- [`frontend/README.md`](frontend/README.md) — structure, setup, SSE streaming, browser‑side Python skills, workflow editor

**Deep dives** (`docs/`)
- **Auth:** [AUTHENTICATION_IMPLEMENTATION.md](docs/AUTHENTICATION_IMPLEMENTATION.md) · [USER_SUBSCRIPTION_PROCESS.md](docs/USER_SUBSCRIPTION_PROCESS.md)
- **Tools & MCP:** [MCP_IMPLEMENTATION.md](docs/MCP_IMPLEMENTATION.md)
- **Workflows:** [WORKFLOW_DOCUMENTATION.md](docs/WORKFLOW_DOCUMENTATION.md) · [REALTIME_WORKFLOW_DESIGN.md](docs/REALTIME_WORKFLOW_DESIGN.md) · [WORKFLOW_PYTHON_INTEGRATION.md](docs/WORKFLOW_PYTHON_INTEGRATION.md)
- **Voice:** [voice-panel-implementation.md](docs/voice-panel-implementation.md) · [HUME_EVI_TOOLS_INTEGRATION.md](docs/HUME_EVI_TOOLS_INTEGRATION.md) · [HUME_TTS_GUIDE.md](docs/HUME_TTS_GUIDE.md) · [HUME_TOOLS_SYNC_SETUP.md](HUME_TOOLS_SYNC_SETUP.md)
- **Context & memory:** [CONTEXT_MANAGEMENT_IMPLEMENTATION.md](docs/CONTEXT_MANAGEMENT_IMPLEMENTATION.md)
- **Integrations:** [external-services-integration.md](docs/external-services-integration.md) · [GOOGLE_DRIVE_INTEGRATION.md](docs/GOOGLE_DRIVE_INTEGRATION.md) · [PUBMED_QUICKSTART.md](docs/PUBMED_QUICKSTART.md)
- **i18n / Ops:** [I18N_GUIDE.md](docs/I18N_GUIDE.md) · [OPTIMIZATIONS.md](docs/OPTIMIZATIONS.md)
- **Security:** [HARDENING.md](docs/HARDENING.md)
- **Database:** [backend/schema/README.md](backend/schema/README.md)
- **Backend internals:** [architecture-chat.md](backend/docs/architecture-chat.md) · [agentDesign.md](backend/docs/agentDesign.md)

---

## Tech stack

- **Backend:** PHP 8.1+, Composer (Guzzle, `firebase/php-jwt`, `nikic/fast-route`, PhpOffice,
  `smalot/pdfparser`, `vlucas/phpdotenv`), MySQL.
- **Frontend:** vanilla HTML/CSS/JS, Tailwind CSS, Marked.js, Highlight.js, Firebase compat SDK,
  **Pyodide** (CPython→WebAssembly), File System Access API, Drawflow (workflow editor).

## License

MIT — see [`backend/composer.json`](backend/composer.json).
