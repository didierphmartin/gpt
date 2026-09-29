# gpt — Multi‑Provider AI Framework

A self‑hostable **framework for building with many LLM providers**. It brings together three things:

- 🧩 **A harness** — a backend runtime that brokers **Claude, OpenAI, Grok, Gemini, DeepSeek, Kimi,
  GLM and self-hosted (vLLM) models** behind one API, with streaming, function/tool calling, MCP,
  agent teams and workflows. It handles provider resolution, auth, tool execution and orchestration
  so you don't have to. The same runtime comes in three interchangeable implementations — PHP
  (reference), TypeScript and Python.
- 🗣️ **A human‑AI interface** — a frontend for *directing* and *conversing with* the AI: a chat UI,
  realtime voice, and a visual workflow editor.
- 📦 **Packaged know‑how** — reusable capability built in: browser‑side **Skills** (Python), MCP tool
  servers, agent‑team designs, workflow templates, and service integrations (search, financial,
  PubMed, Google Drive).

Chat is just one surface onto a general multi‑provider AI orchestration layer.

> **Status:** standalone, self‑hostable. Secrets live outside the repo — see [Configuration](#configuration--secrets).

---

## Three ways to use it

| | **Individual** | **Corporate** | **Hosted service** |
|---|---|---|---|
| **Who it's for** | One person, noncommercial use | A company and its staff | Us, or anyone running a classic web host |
| **How it's delivered** | Docker container on your own machine | Docker container on the company intranet | Apache + PHP + MySQL, no container |
| **LLM access** | Your own provider keys | Your company's own provider keys, shared by all staff | Keys configured by whoever runs the server |
| **Admin app** | Not included | Included (`gpt_admin`): manage users, roles, LLM settings, MCP servers and usage | — |
| **Sign-in** | None: the container signs you in | One account per person in the login service, for both the app and the admin app | Yes |
| **Install guide** | [Individual install](#individual-install-docker) | [Corporate install](#corporate-install-docker-on-your-intranet) | [Manual install](#manual-install-apache--php) |

Coming next: both Docker editions will also let you create an account with us
to subscribe or buy credits, instead of bringing your own keys.

---

## Installation

Both Docker editions are the same stack. The **compose files you start choose
the edition**, not a setting in `.env`: `compose.yaml` alone is the individual
edition, and adding `compose.corporate.yaml` makes it corporate. The corporate
build is the only one that contains the admin app, so the edition always
matches what the image holds.

### Individual install (Docker)

For one person on their own computer. No account and no password: the
container signs you in.

**You need:** Docker Desktop (or Docker Engine + Compose v2), and an API key
from at least one LLM provider (Claude, OpenAI, Gemini, …).

1. **Get the files and start the app.**

   ```bash
   git clone https://github.com/didierphmartin/gpt.git && cd gpt
   docker compose up -d --build
   ```

   A `.env` is optional. Copy `.env.example` to `.env` only if you want to
   change the port or database settings.

2. **Open http://localhost:8080/gpt/.** You are signed in automatically.

3. **Run the setup wizard.** It starts on its own and asks for:
   - **a local folder**: everything the app reads or writes lives there
     (`skills/`, `outputs/`, `python/`);
   - **the Python runner**, needed only to run compiled workflows (see
     *First run* below);
   - **your LLM keys**: one per provider you want to use. The container ships
     without any keys, and chat does nothing until you add one.

> **Warning: that port is open to your whole network, not just this machine.**
> `docker compose up` publishes on `0.0.0.0`, so anyone who can reach
> `GPT_PORT` on your LAN — not only `localhost` — can open the same URL, and
> in the individual edition that means signing in as admin with no password
> prompt at all. The admin password is also printed in plain text to
> `docker compose logs web`. If this host is reachable by people you don't
> trust, set `GPT_BIND=127.0.0.1` in `.env` to restrict it to localhost.

### Corporate install (Docker on your intranet)

For a company. The server runs on your intranet, and your staff use it from
their browsers. Everyone signs in with their own account.

The corporate package adds the **admin app** (`gpt_admin`). It is not part of
this repository or the individual edition. The people who manage the
installation use it to:
- create and manage user accounts;
- assign roles and control which features each role gets;
- configure LLM providers and settings;
- add MCP servers (connections to external tools) for everyone or for
  particular users;
- follow token usage and costs, per user and for the whole company.

**Sign-in and access.**
- **Every user signs in.** Each person has their own account, and nobody can
  use the app without signing in, so every conversation, setting and token
  counted belongs to a named user.
- **One account for both apps.** Accounts live in the login service that
  ships with the corporate package, so the same email and password sign in
  to gpt and `gpt_admin`.
- **Only admins reach the admin app.** Other users who sign in get the app
  only.

**You need:**
- An intranet server (Linux recommended) with Docker Engine + Compose v2.
- A checkout of the `gpt_admin` repository, which we supply with the
  corporate package (it is not public).
- A checkout of the login service repository, which we supply with the
  corporate package.
- Your company's LLM provider keys.

1. **Get the files and choose your settings.**

   ```bash
   git clone https://github.com/didierphmartin/gpt.git && cd gpt
   cp .env.example .env
   ```

   Edit `.env` **before the first start**. It only holds the database
   passwords and the port; there is no admin account to set here:
   - Replace `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD` with strong passwords.
   - Change `GPT_PORT` if 8080 is already in use on the server.

2. **Build and start the app.** This takes four commands, not one: Docker
   cannot copy files from outside the folder it is building, so `gpt_admin`
   and the login service (both separate checkouts) are each built into their
   own image first. `GPT_ADMIN_SRC` and `GPT_LOGIN_SRC` must be exported in
   the shell, because they name folders on disk that only the shell can pass
   to `docker build`.

   ```bash
   export GPT_ADMIN_SRC=../gpt_admin      # your gpt_admin checkout
   export GPT_LOGIN_SRC=../login          # your login service checkout
   docker build -t gpt-web-base:latest -f docker/web/Dockerfile .
   docker build -t gpt-admin-dist:latest -f docker/gptadmin/Dockerfile "$GPT_ADMIN_SRC"
   docker build -t gpt-login-src:latest -f docker/login/Dockerfile "$GPT_LOGIN_SRC"
   docker compose -f compose.yaml -f compose.corporate.yaml up -d --build
   ```

   The containers restart on their own when the server reboots.

3. **Open `gpt_admin`** at `http://<server-name>:8080/gpt_admin/`, from any
   machine on the intranet. The setup wizard starts on its own, because no
   account exists yet.

4. **Create the administrator account.** The wizard's first screen is for the
   administrator: enter an email and a password (at least 10 characters).
   That account signs in to both gpt and `gpt_admin`, through the login
   service, and it creates everyone else's.

5. **Add the company's LLM keys** on the wizard's second screen. They apply
   to every user.

6. **Create your staff's accounts** in `gpt_admin`, one per person. Nobody
   can sign themselves up.

7. **Give your staff the address.** Each person signs in with their own
   account from their own browser. Anyone who runs compiled workflows installs
   the local runner on *their own* computer (see *First run* below), because
   workflows run on the user's machine, not on the server.

We recommend putting the server behind your company's HTTPS reverse proxy, so
passwords and conversations are encrypted on the network.

> **Upgrading an earlier corporate test install:** start from a fresh
> database (`docker compose -f compose.yaml -f compose.corporate.yaml down
> -v`). Installs made before this change created their admin from `.env`,
> without a login-service account, so that admin cannot sign in any more.

> **Coming next for the corporate edition:** both editions will offer a
> choice between your own keys and an account with us, to **subscribe** (a
> monthly plan covering every LLM we support, up to a token limit) or **buy
> credits** (pay as you go).

### What the containers leave out, on purpose

- **The local Python runner.** Compiled workflows run as *you*, on *your*
  machine, so they can read your files and ask you questions mid-run. Your
  browser is on the host either way, so it still reaches the runner at
  127.0.0.1:8765 — install it from the app's setup wizard exactly as described
  below in *First run*.
- **Browser Skills.** They execute as Python in your browser against a folder
  you grant. Nothing server-side to package.
- **LLM keys.** Yours, entered in the app, never in an image or an env var.

### Docker notes

**Handy commands**

```bash
docker compose logs -f web            # follow the backend log
docker compose down                   # stop, keep the database
docker compose down -v                # stop and DELETE the database
docker compose --profile node up -d   # also start the TypeScript backend (3001)
docker compose --profile python up -d # also start the FastAPI backend (3002)
```

For the corporate edition, pass both files to every command, for example
`docker compose -f compose.yaml -f compose.corporate.yaml logs -f web`.

The `node` and `python` profiles bind-mount `./backend_typescript` and
`./backend_python` respectively, so — unlike the default `db`/`web` stack,
which builds from self-contained images — they do require the clone to live
somewhere Docker Desktop is allowed to share (on macOS, your home directory by
default).

> **The database is seeded only once.** `backend/schema/chatbot.sql` and
> `docker/db/02-seed.sql` are baked into the `db` image at build time (see
> `docker/db/Dockerfile`) and copied into `/docker-entrypoint-initdb.d/`, which
> MySQL only runs on an empty data volume. So editing either file needs
> `docker compose up -d --build` (to rebuild the image with the new file) *and*
> `docker compose down -v` first (to clear the volume so the init scripts run
> again) — either alone will appear to ignore your change.

> **Editing `frontend/` needs a real rebuild, not just `up -d --build`.**
> `frontend/` is `COPY`'d into the `web` image at build time. If the image
> already exists, plain `docker compose up -d --build` can decide nothing
> changed and keep serving the old files even after a hard refresh. Force it:
> ```bash
> docker compose build web && docker compose up -d --force-recreate web
> ```

> **`frontend/assets/js/config.js` is regenerated on every boot, in both
> editions.** The entrypoint rewrites it from the committed example plus a
> container-generated section (edition marker, auto-login) on every start.
> Any hand-edit made inside a running container — including the voice and
> Firebase placeholders — is discarded on the next restart. There is currently
> no supported way to set those keys from inside an edition container; set
> them before building the image, or accept that they reset.

Run `./docker/tests/run-all.sh` to verify the whole stack end to end after a
change. It runs in its own `gpt-test` compose project on port 18080, so it
never touches a real install's stack or its data -- but it does run
`docker compose down -v` inside that project, so don't point `COMPOSE_PROJECT_NAME`
or `GPT_PORT` at anything you care about when invoking it.

### Manual install (Apache + PHP)

This is how our hosted service runs: directly on Apache + PHP + MySQL, with no
container. Use it to install on a hosted web server, or if you already run
Apache and MySQL and prefer to install the parts yourself.

**Prerequisites**

| | Needed for | Notes |
|---|---|---|
| PHP 8.1+ · Composer · MySQL | the backend | any of the three backends needs MySQL |
| A web server | serving `frontend/` and the PHP backend | see *No Apache?* below |
| Python 3.10+ | compiled workflows (LangGraph / ADK / MAF / NOOA) | optional, installed from the app |
| Node.js 18+ | only for the TypeScript backend | optional |

### No Apache? Install XAMPP

XAMPP bundles Apache, MySQL (MariaDB) and PHP in one installer — the shortest path if you have none of them.

1. Download it from [apachefriends.org](https://www.apachefriends.org/) and install.
2. Start **Apache** and **MySQL** from the XAMPP control panel.
3. Clone this repo into XAMPP's web root so it is served at `/gpt`:

```bash
# macOS
cd /Applications/XAMPP/xamppfiles/htdocs && git clone https://github.com/didierphmartin/gpt.git
# Windows:  C:\xampp\htdocs      Linux:  /opt/lampp/htdocs
```

4. The app is then at `http://localhost/gpt/frontend/index.html`.

Already have Apache/nginx? Serve the repo so the frontend reaches the backend at `/gpt/backend` (that
default lives in `frontend/assets/js/api-config.js`), or point the app at a Node/Python backend instead — see
*Other backends* below.

### 1. Backend dependencies

```bash
cd backend && composer install
```

### 2. Databases

gpt uses **two** MySQL connections. The schema dump creates the first:

```bash
mysql -u <user> -p < backend/schema/chatbot.sql     # creates netfo587_chatbot (41 tables)
```

- **Contexts DB** (`netfo587_chatbot`) — everything gpt owns: users, agents, workflows, playbooks,
  app keys, `system_llm_settings`.
- **Main DB** — gpt was derived from another product and still reads a few of its tables. That schema
  is not included. Point `DB_*` at that database if you have it; otherwise point it at the contexts DB
  so the app boots, and expect the handful of features reading those tables to be inert.
  See [`backend/schema/README.md`](backend/schema/README.md).

### 3. Backend secrets

```bash
cp backend/.env.example backend/.env
```

`backend/config/load_env.php` **refuses to boot** until these ten are filled in:

```
DB_HOST  DB_NAME  DB_USER  DB_PASS
CTX_DB_HOST  CTX_DB_NAME  CTX_DB_USER  CTX_DB_PASS
JWT_SECRET  APP_KEY_SECRET          # openssl rand -hex 32
```

Everything else in that file is optional and documented inline — blank simply leaves the feature off.

**LLM provider keys do not go here.** They are rows in `system_llm_settings` in the contexts DB, edited
in the app under *Admin → LLM settings*.

### 4. Frontend config

```bash
cp frontend/assets/js/config.example.js frontend/assets/js/config.js
cp frontend/voice/config.example.json   frontend/voice/config.json
```

Fill in the Firebase web config (needed only for social login). Both files are gitignored. Note that
anything placed here is **served to the browser** — it is not a secret store.

### 5. First run

Open `http://localhost/gpt/frontend/index.html` and sign in. A setup wizard asks for a **local folder**;
everything the app reads or writes lives there (`skills/`, `outputs/`, `python/`).

The wizard also installs the Python runner into `<your folder>/python/`. To finish it — a browser cannot
create a virtual environment — run once, in that folder:

```bash
cd <your folder>/python
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
```

Then start the runner from the same folder, and leave it running:

```bash
./.venv/bin/python main.py          # NOT bare python3 — the venv holds the frameworks
```

To have it start at login instead (macOS): `python3 setup.py --launchagent` from `langchain_runner/`.

Compiled workflows need that runner: your machine executes them, not the web server. Browser-only
storage (OPFS) therefore cannot host them — chat and browser-side Python skills still work.

### Other backends (optional)

The PHP backend is the reference implementation. Two ports exist and speak the same API; pick one in
*Settings → Account*, which sets the base URL from `frontend/assets/js/api-config.js`.

```bash
# Node.js — http://localhost:3001
cd backend_typescript && npm install && cp .env.example .env && npm run dev

# Python — http://localhost:3002
cd backend_python && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cp .env.example .env && ./run.sh
```

Both read the same two databases and must share `JWT_SECRET` and `APP_KEY_SECRET` with the PHP backend,
or a session issued by one is rejected by the other.

---

## What it does

- **One chat API, many providers.** Talk to **Claude, OpenAI, Grok, Gemini, DeepSeek, Kimi, GLM**
  and any OpenAI-compatible endpoint you host yourself, through a single endpoint. Provider keys are
  managed in the database (global + per‑user), not in code.
- **Streaming.** Responses stream over **Server‑Sent Events (SSE)**, with progress, verifier, and
  compare events.
- **Tools & MCP.** Function‑calling with a server‑side tool registry and **MCP** (Model Context
  Protocol) servers, plus **client‑side "Skills"** that run **Python in the browser** (Pyodide/WASM)
  against the user's local folder via the File System Access API.
- **Realtime voice.** A voice prompt‑builder backed by **Hume EVI**, **Grok realtime**, and
  **Gemini native audio**.
- **Agents & workflows.** Agent teams and a **visual workflow editor** that compiles one canvas to
  **four runtimes** — LangGraph, **Google ADK**, **Microsoft Agent Framework** and **NVIDIA NOOA** —
  as self-contained Python you can read, keep and run without this app. Dispatcher nodes route to one
  branch instead of fanning out, and playbook nodes run an interpreter loop with human gates (forms,
  approvals, hand-offs) that surface in the conversation. Compiled workflows run on **your machine**
  through a small local runner, not on the web server.
- **Auth & accounts.** Firebase (Google/Facebook OAuth), app keys, per‑user API keys, plans/subscriptions.
- **Integrations.** Web/search (SerpAPI, Brave, ScrapingDog), financial data (FMP), PubMed, Google Drive.

---

## Architecture

```mermaid
graph TD
    User(["👤 User"])

    subgraph UI["🗣️ Human-AI Interface · frontend"]
        direction LR
        Chat["Chat UI"]
        Voice["Realtime Voice"]
        Flow["Workflow Editor"]
    end

    subgraph Harness["🧩 Harness · backend /api/v1"]
        direction LR
        Auth["Auth"]
        Resolver["Provider Resolver"]
        Exec["Tools · MCP · Agents · Workflows"]
    end

    subgraph Know["📦 Packaged Know-how"]
        direction LR
        SkillsK["Skills · Python"]
        ToolsK["MCP tool servers"]
        Integ["Integrations"]
    end

    Providers["🤖 Claude · OpenAI · Grok · Gemini<br/>DeepSeek · Kimi · GLM · self-hosted"]
    Store[("🗄️ MySQL · keys, contexts")]
    Secrets["🔑 backend/.env"]
    Runner["🐍 Local runner · 127.0.0.1:8765<br/>runs compiled workflows"]

    User --> UI
    UI -->|"SSE / REST"| Harness
    Harness --> Providers
    Exec --> Know
    Resolver -.->|keys| Store
    Auth -.-> Store
    Harness -.-> Secrets
    Flow -->|"compiled package"| Runner
    Runner --> Providers
```

The harness has three interchangeable implementations behind the same `/api/v1` contract: **PHP**
(the reference), **TypeScript** and **Python**. Compiled workflows do not run in any of them — the
editor writes a self-contained Python package into your local folder and a **local runner** executes
it as your user, which is what lets a workflow read your files and ask you questions mid-run.

Repository layout:

```
gpt/
├── backend/            PHP 8.1+ API (front controller at /api/v1) — the reference implementation
│   ├── src/                controllers, services (LLMProviderResolver, …), AgentTeam, middleware
│   │   └── AgentTeam/      workflow compilers: LangGraph, ADK, MAF, NOOA + the shared
│   │                       PlaybookEmit interpreter and RunServerEmitter
│   ├── config/             ai_config.php (reads backend/.env), load_env.php
│   ├── schema/             chatbot.sql, migrations, run-protocol-v1.json (event contract)
│   └── .env                secrets (gitignored; copy from .env.example)
├── backend_typescript/ Node/TypeScript port of the same API (port 3001)
├── backend_python/     FastAPI port of the same API (port 3002)
├── langchain_runner/   source of the local Python runner; installed into your chosen
│                       folder by the setup wizard, or by `python3 setup.py`
└── frontend/           static HTML/CSS/JS (no build step), served by any web server
    ├── assets/js/          config.js (gitignored), chat, voice, workflow editor
    └── voice/              voice PWA + config.json (gitignored)
```

- **LLM provider keys live only in the database** (`system_llm_settings` global, `user_api_keys`
  per‑user), resolved by `LLMProviderResolver` — never in committed files.
- The backend uses **two MySQL connections**: a primary `chatbot` DB (auth, contexts,
  provider settings) and a residual `portfolio_manager` connection inherited from the app this was
  derived from (documented in `docs/HARDENING.md`, which is not published — see *Documentation* below).

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
`docs/HARDENING.md` (not published) for known security follow‑ups (e.g. moving the browser‑side
voice keys to backend brokering).

---

## Documentation

**In this repository**
- [`backend/README.md`](backend/README.md) — structure, installation, API reference, tools & MCP architecture, LLM invocation paths
- [`frontend/README.md`](frontend/README.md) — structure, setup, SSE streaming, browser-side Python skills, workflow editor
- [`backend/schema/README.md`](backend/schema/README.md) — the database schema and the note on the second DB
- [`backend/docs/architecture-chat.md`](backend/docs/architecture-chat.md) · [`backend/docs/agentDesign.md`](backend/docs/agentDesign.md) — backend internals
- [`backend/schema/run-protocol-v1.json`](backend/schema/run-protocol-v1.json) — the run-protocol event contract a compiled workflow server speaks
- [`HUME_TOOLS_SYNC_SETUP.md`](HUME_TOOLS_SYNC_SETUP.md) — Hume tool sync

**Not published.** The deep-dive guides and design notes (auth, MCP, workflows, voice, context
management, i18n, hardening) live in `docs/` in the working tree, which is deliberately kept out of
this repository. Ask the maintainer if you need them.

---

## Tech stack

- **Backend:** PHP 8.1+, Composer (Guzzle, `firebase/php-jwt`, `nikic/fast-route`, PhpOffice,
  `smalot/pdfparser`, `vlucas/phpdotenv`), MySQL. Two ports of the same API: **TypeScript** (Node 18+,
  tsx/tsc) and **Python** (FastAPI + uvicorn).
- **Compiled workflows:** Python 3.10+ — LangGraph, Google ADK, Microsoft Agent Framework, NVIDIA
  NOOA — executed by a local FastAPI runner, never by the web server.
- **Frontend:** vanilla HTML/CSS/JS, Tailwind CSS, Marked.js, Highlight.js, Firebase compat SDK,
  **Pyodide** (CPython→WebAssembly), File System Access API, Drawflow (workflow editor).

## License

**[SynergyAI Software Licence](LICENSE)**. In short:

- **Individual users** may use it free of charge for personal, noncommercial
  purposes, with their own LLM keys or an account with us (subscription or
  credits). They may not sell it, modify it or redistribute it without written
  permission.
- **Corporate users** may run it on their own intranet for their own staff,
  with their own LLM keys or an account with us (subscription or credits).
  Only the corporate package includes the admin app (`gpt_admin`).
  They may not offer it outside the organisation, sell it, modify it or
  redistribute it without written permission.
- **Containers** (including the PHP backend inside them) may be run, but not
  copied, extracted, modified or reverse engineered.

The source is published so you can see what you're running. This is not open
source. Third-party dependencies keep their own licences. Releases up to and
including commit `3fff3e5` were published under MIT, and copies obtained under
earlier terms keep those terms. The [LICENSE](LICENSE) file is the binding
text; this summary is not.
