# Secret Centralization — Design Spec

- **Date:** 2026-06-08
- **Project:** `gpt`
- **Status:** Approved design → ready for implementation planning
- **Context:** Pre–first-PR hardening. Today secrets are scattered: four different `ai_config.php`
  copies (PHP), the DB (`system_llm_settings`), three frontend config files, and inline keys in HTML.

## 1. Goal

Every secret lives in **one gitignored file per surface**, and **no committed source file (PHP, JS,
or HTML) contains a secret**. Backend → a single `.env`. Frontend → one config file **per app**.
The repo becomes safe by construction: ignore those files and there is nothing sensitive left to leak.

## 2. Decisions (locked in brainstorming)

- **Backend `.env` covers the file-based secrets** currently in `ai_config.php`: both DB credentials
  (`database` + `contexts_database`: host/db/user/password), `jwt_secret`, `app_key_secret`,
  `scheduler.token`, the search keys (`serpapi`, `scrapingdog`, `brave`), `financial.fmp`,
  `hume_evi.api_key`, `grok_voice.api_key` (+ its endpoint), `gemini_voice.api_key`.
- **Provider LLM keys stay in the DB** (`system_llm_settings`: OpenAI, Claude, Grok, Gemini, DeepSeek,
  Kimi). They are already not in any file, and are managed DB-side. Moving them is **out of scope**.
- **Loader:** `vlucas/phpdotenv` via Composer (backend already uses Composer). Load `.env` once at
  each entrypoint before config is read.
- **Secret-free in place — one shared `backend/.env`** (revised 2026-06-08 after planning found the 4
  `ai_config.php` are *different* configs, not duplicates: the three 18 KB variants carry inline LLM
  provider keys their own tools read from the file, and differ from each other). **Each** of the four
  `ai_config.php` keeps its existing structure but reads **every** secret value from the single
  `backend/.env` via `$_ENV`/`getenv()` — no literal secrets in any of them. **No consolidation, no
  include rewiring, no deletions.** The shared `.env` therefore holds the **union** of file-based
  secrets across all four configs — including the provider keys (`claude`, `openai`, `providers.*`)
  that the database/migrations/examples configs reference inline. (Structural consolidation of the four
  files is an optional later cleanup — see §11.)
- **Frontend: one config file per app.**
  - **Main site:** merge `firebase-config.js` into a single `config.js` exposing a global
    (`window.APP_CONFIG`); update pages to load only `config.js`; remove inline keys from HTML.
  - **Voice PWA** (`frontend/voice/`): `voice/config.json` is already that app's single runtime config
    — keep it as-is.
- **`.gitignore` inversion:** once `ai_config.php` is secret-free it gets **committed** (it documents
  the config shape); the new ignored file is `backend/.env`. Committed examples: `backend/.env.example`,
  `frontend/assets/js/config.example.js`, `frontend/voice/config.example.json`.
- **Sequencing:** do this **before** the first PR, so the repo ships clean by structure, not just by
  `.gitignore`.

## 3. Non-Goals

- Moving provider LLM keys out of the DB.
- Changing auth/WebAuthn/Firebase behavior — only the *source* of config values changes.
- Adding a frontend build step (the site stays static; config stays a runtime JS file).
- Refactoring unrelated structure in the 18 KB `ai_config.php` variants beyond what consolidation needs.
- Anything in `learn_language`.

## 4. Architecture

### Backend
- **`backend/.env`** (gitignored) — `KEY=VALUE` for every file-based secret across all four configs.
  Proposed names: `DB_HOST, DB_NAME, DB_USER, DB_PASS, CTX_DB_HOST, CTX_DB_NAME, CTX_DB_USER,
  CTX_DB_PASS, JWT_SECRET, APP_KEY_SECRET, SCHEDULER_TOKEN, SERPAPI_KEY, SCRAPINGDOG_KEY, BRAVE_KEY,
  FMP_KEY, HUME_API_KEY, GROK_VOICE_API_KEY, GEMINI_VOICE_API_KEY`, plus the provider keys the 18 KB
  configs reference inline: `CLAUDE_API_KEY, OPENAI_API_KEY, KIMI_API_KEY, GROK_API_KEY, GEMINI_API_KEY,
  DEEPSEEK_API_KEY` (final list derived by walking all four configs during planning).
- **`backend/.env.example`** — identical keys, placeholder values. Committed.
- **Env bootstrap** — add `vlucas/phpdotenv`; a small shared loader (`backend/config/load_env.php`)
  computes the backend root from its own `__DIR__` and runs `Dotenv::createImmutable($backendRoot)
  ->safeLoad()` once (idempotent guard), then validates required keys. **Each of the four
  `ai_config.php` requires this loader at its top** (via a relative path to it), so every consumer gets
  `.env` loaded just by requiring its config — no entrypoint edits. `.env` lives at the backend root;
  the four configs sit at different depths but all resolve to the same loader/`.env`.
- **All four `ai_config.php` read `$_ENV`** — in `backend/config/`, `backend/database/config/`,
  `backend/migrations/config/`, `backend/examples/config/`. Each keeps its current array shape and key
  set; only the secret *values* change from literals to `$_ENV['…'] ?? ''`. Non-secret values
  (`base_url`, `charset`, `engine`, `max_results`, model names, etc.) stay as literals.
- **No include rewiring or deletion** — the ~16 `require …/config/ai_config.php` sites are untouched;
  each tool keeps loading its own (now secret-free) config in place.

### Frontend
- **Main site:** `frontend/assets/js/config.js` becomes the single source — `window.APP_CONFIG =
  { firebase: {…}, apiBase: '…', … }` — folding in `firebase-config.js` (then delete it and update the
  pages that loaded it: `login.html`, `register.html`, `index.html`, the test pages). Remove inline
  keys from HTML. Gitignore `config.js`; commit `config.example.js`.
- **Voice PWA:** keep `frontend/voice/config.json` as the app's single config. Gitignore it; commit
  `voice/config.example.json`.

## 5. Data Flow

- **Backend:** request → entrypoint loads `.env` (phpdotenv) → `ai_config.php` reads `$_ENV` →
  controllers consume config exactly as before. Behavior unchanged; only the value *source* changes.
- **Frontend:** page → loads `config.js` → `window.APP_CONFIG` → Firebase init + API base + keys.

## 6. Error / Edge Handling

- Missing `.env` or a required var → fail fast at startup with a clear message (explicit required-keys
  check after `safeLoad()`), never silently connect with empty credentials.
- `.env.example` / `config.example.*` document every key so a fresh clone knows what to fill.
- Frontend: a missing `config.js` makes pages fail loudly (Firebase init error), not silently.

## 7. Testing / Verification

- **Backend:** existing test suite passes (tests load `ai_config.php`; provide test `.env` values).
  Smoke: an authed endpoint (app-key validation → DB) + `/chat` + a migration run, all reading `.env`;
  DB connects (already re-verified).
- **Secret hygiene (the point of the whole change):** grep **all tracked** files (PHP/JS/HTML/JSON) for
  key patterns → **zero**; `ai_config.php` has no literal secret; the three staged-content gates stay
  zero.
- **App runs locally:** login works (DB via `.env`), the voice app loads (`voice/config.json`).

## 8. Tech Stack

| Aspect | Choice |
|---|---|
| Backend secret store | `backend/.env` (gitignored) + committed `.env.example` |
| Loader | `vlucas/phpdotenv` (Composer), `safeLoad()` at entrypoints + required-keys check |
| Backend config | one canonical `ai_config.php` reading `$_ENV` (now committed, secret-free) |
| Provider LLM keys | unchanged — DB (`system_llm_settings`) |
| Frontend main site | single `config.js` (`window.APP_CONFIG`) + `config.example.js` |
| Frontend voice PWA | `voice/config.json` + `voice/config.example.json` |

## 9. Decomposition (for the plan)

1. Add `phpdotenv` (Composer) + the shared `backend/config/load_env.php`; create `backend/.env` (union
   of secrets across all four configs) + committed `backend/.env.example`.
2. In **each** of the four `ai_config.php`: require the loader at the top and replace every secret
   literal with `$_ENV['…'] ?? ''` (structure unchanged). Verify each returns the same effective values
   as before.
3. Verify each entrypoint/tool runs with secrets sourced from `.env` (`/chat` + an authed endpoint →
   DB, a migration run, the examples, the test suite); DB connects.
4. Frontend: merge `firebase-config.js` into a single `config.js` (`window.APP_CONFIG`); update all
   page references; remove inline HTML keys; add `config.example.js`.
5. Frontend voice: add `voice/config.example.json` (keep `voice/config.json` ignored).
6. **Update `.gitignore`:** remove `ai_config.php`/`**/ai_config.php` (now committed); remove
   `firebase-config.js` (deleted); add `backend/.env`; keep `config.js` and `voice/config.json` ignored.
7. Verify: secret gates zero, backend smoke (DB/login, `/chat`, migration), app runs locally.

## 10. Risks

- **Union completeness:** `.env` must contain *every* secret across all four (different) configs. If a
  secret in one config is missed, that tool silently gets an empty value. Mitigation: walk each of the
  four `ai_config.php` exhaustively for secret-keyed values; the required-keys check in the loader fails
  fast if a key is missing; verify each tool still works post-change.
- Deployment: `.env` must exist on the server (not committed) — document the deploy step in
  `.env.example` / README.
- Test suite may assume specific config values — give it test `.env` values.

## 11. Future (out of scope)

Optionally move provider keys from the DB into `.env` later (single source for *everything*); a real
secret manager/vault in production.
