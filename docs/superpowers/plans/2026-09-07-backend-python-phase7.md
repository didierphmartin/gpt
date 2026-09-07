# Backend Python Port — Phase 7 (Back office) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the admin/back-office controllers and their 85 routes so gpt_admin works against the Python backend: `AdminController` (users, providers, keys, usage, MCP servers admin, user MCP overrides, costs, exchange rates), `SystemSettingsController` (system LLM settings), `LoginAdminController`, `VideoEditorController`, `AffiliateController`, `HumeToolController`, `EVIWebhookController`.

**Architecture:** One Python module per PHP controller under `app/controllers/`, same class/method names; admin gating exactly as PHP (`requireAdmin`-style checks — copy each controller's own check). Cost/exchange-rate refreshes call external APIs over httpx (unit-tested with `MockTransport`; differential validation-only + read endpoints).

**Tech Stack:** Python 3.13, FastAPI, PyMySQL, httpx, bcrypt, pytest.

**Spec:** `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§4 phase 7 row). Memory: the user's gpt_admin has a `py` backend kind — Phase 7 is what makes it usable end to end.

## Global Constraints
- Phase 1–6 Global Constraints apply (no runtime DDL; SQL byte-identical; PHP-first differential; self-cleaning mutations; by-path staging; trailer).
- **Admin identity for differential:** user 3 if `users.role` is admin (check first); otherwise every admin route is compared for its 403 text only and read endpoints are skipped with a truthful reason.
- **Passwords:** `createUser`/`updateUser` hash with bcrypt (`$2y$` prefix, Phase 1 helper) — a user created via Python must log in via PHP and vice versa (differential: create `differential-tmp-user@example.com` via one backend, `POST /auth/login` on the other, delete via the first).
- **External refreshes:** `refreshAllCosts`/`refreshProviderCosts`/`refreshExchangeRates`/`HumeToolController::sync/testConnection`/`VideoEditor` external calls are unit-tested with `MockTransport`; the differential compares validation responses only (no external side effects).
- **Webhook:** `EVIWebhookController::handleWebhook` signature verification ported exactly (HMAC helper from `hashlib/hmac`); differential: invalid-signature parity.
- Commit trailer as previous phases.

## Tasks
1. `SystemSettingsController` (728; routes 249–254) — the admin LLM settings gpt_admin edits; differential: `GET /admin/llm-settings`, `/admin/llm-settings/kimi` exact; `POST` save of the current row → GET equals; toggle ×2; `seed` validation. Commit `feat(py): SystemSettingsController`.
2. `AdminController` part 1 — users + providers + keys (routes 175–189; PHP methods `listUsers`, `getUser`, `getUserAccount`, `createUser`, `updateUser`, `deleteUser`, `getProviderSettings`, `saveProvider`, `toggleProviderEnabled`, `toggleCategoryEnabled`, `deleteProvider`, `getUserCosts`, `getApiKeys`, `saveApiKeys`, `deleteApiKey`). Commit `feat(py): AdminController (users, providers, keys)`.
3. `AdminController` part 2 — usage + MCP admin + user overrides + costs + exchange rates (routes 192–196, 228–246). Commit `feat(py): AdminController (usage, MCP admin, costs, exchange rates)`.
4. `LoginAdminController` (354; routes 217–225) + `AffiliateController` (397; routes 73–93 incl. the public `POST /affiliate/conversions` — check `PUBLIC_ROUTES`). Commit `feat(py): LoginAdminController + AffiliateController`.
5. `VideoEditorController` (652; routes 199–214). Commit `feat(py): VideoEditorController`.
6. `HumeToolController` (270; routes 292–297; uses `PortfolioFunctions`/`WatchlistFunctions`/`AnalysisFunctions` from 2c) + `EVIWebhookController` (79; route 302). Commit `feat(py): HumeToolController + EVIWebhookController`.
7. Docs, verification, gpt_admin browser smoke (controller: switch gpt_admin to `py`, log in, open Users / LLM settings / MCP servers / Usage panels). Commit `docs(py): Phase 7 status + parity rows`.

Each task: unit cases = every validation/permission branch string + SQL byte-identical via the fake `Db`; differential = every GET exact for the admin user + self-cleaning round-trips for creates/updates/deletes.

## Self-review notes
- Coverage of umbrella §4 phase 7 (admin, system settings, login admin, video editor, affiliates, Hume tools, EVI webhook): T1–T6; 85 routes.
