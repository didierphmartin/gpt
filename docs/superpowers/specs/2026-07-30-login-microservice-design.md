# Login Microservice — Design

**Date:** 2026-07-30
**Status:** Approved by Didier (brainstorming session)
**Location:** `/Applications/XAMPP/xamppfiles/htdocs/login` (new standalone project)

## Goal

Extract gpt's login mechanism into a standalone SSO-style login microservice with its
own database. Apps send the browser to the service with an **app key** and an **entry
point** (redirect URL); on successful login the service redirects back to the app with
a JWT. Multiple htdocs apps (dialog, Voice, GEOApps, later gpt itself) share one login.

## Decisions (settled during brainstorming)

- **Auth methods:** everything gpt has — Firebase social (Google/Facebook/phone),
  email/password (bcrypt fallback), WebAuthn passkeys. Firebase project
  `transledgersite` stays the provider for social login and password reset.
- **Token handoff:** redirect flow. App → `http://localhost/login/?app_key=...&redirect=...`;
  on success → `entry_point#token=<access>&refresh=<refresh>` (URL fragment).
- **Own DB**, proposed name `netfo587_login`, seeded by a one-time import of users and
  webauthn tables from `netfo587_chatbot` (ids and bcrypt hashes preserved).
- **Validation:** HS256 with the **same `JWT_SECRET` value as gpt**, so existing gpt
  middleware validates service-minted tokens unchanged. Apps with backends put the
  secret in their `.env` and validate locally; a `GET /verify` endpoint serves apps
  that would rather ask the service. (gpt's middleware ignores `iss`, so the service
  using `iss: login-service` is compatible.)
- **Stack:** PHP under the same XAMPP Apache, front-controller routing, composer deps
  `firebase/php-jwt` + `vlucas/phpdotenv` — same conventions as gpt's backend.
- **Scope:** build the service only. Converting gpt/dialog/etc. to consume it is a
  follow-up project per app. gpt remains untouched.
- **Approach:** trimmed clean port (Approach A). Port gpt's auth code but strip
  gpt-specific baggage: `ledger_user_id` register requirement, plan/upgrade/link-phone
  endpoints, iframe-embed `postMessage` mode, AgentTeam scoped `ak_` keys, per-user
  `uak_` keys. Those concerns stay in gpt.

## Project layout

```
login/
├── frontend/
│   ├── index.php          # login page — reads ?app_key=...&redirect=...
│   ├── register.html
│   └── assets/js/         # auth.js (trimmed), api-config.js, login-client.js (copyable snippet)
├── backend/
│   ├── api/index.php      # front controller → routes
│   ├── src/
│   │   ├── routes.php
│   │   ├── Controllers/AuthController.php      # login, register, firebase, refresh, verify, logout
│   │   ├── Controllers/WebAuthnController.php
│   │   ├── Controllers/AppController.php       # registered-apps introspection
│   │   ├── Middleware/AuthMiddleware.php
│   │   └── Services/AppRepository.php          # registered_apps lookup/validation
│   ├── config/            # load_env.php, config.php; own .env: DB creds, JWT_SECRET, LOGIN_APP_KEY_SECRET
│   ├── schema/login.sql
│   └── scripts/
│       ├── mint-app-key.php    # register an app: name + entry point → prints key once
│       └── import-users.php    # one-time copy from netfo587_chatbot
└── composer.json
```

Source material to port from gpt: `backend/src/Controllers/AuthController.php`,
`backend/src/Controllers/WebAuthnController.php`, `backend/src/Middleware/AuthMiddleware.php`,
key-hashing scheme from `backend/src/AgentTeam/Services/AppKeyRepository.php`,
`frontend/login.html` + `frontend/assets/js/auth.js` + `account-store.js`.

## Database (`netfo587_login`)

- **`users`** — ported from gpt: `id`, `email`, `phone`, `password` (bcrypt, NULL for
  social), `first_name`, `last_name`, `firebase_uid`, `provider` enum, `role` enum,
  `profile_picture`, `email_verified`, `last_login`, `created_at`, `updated_at`.
  Dropped: `ledger_user_id`, `plan`, `storage_*`, `app_key_hash`/`app_key_prefix`/
  `app_key_created_at`. Original ids preserved on import.
- **`webauthn_credentials`**, **`webauthn_challenges`** — ported unchanged.
- **`registered_apps`** (new) — `id`, `app_id` varchar(64) unique, `name`,
  `key_prefix` char(12), `key_hash` char(64) (HMAC-SHA256 with `LOGIN_APP_KEY_SECRET`,
  same scheme as gpt's AppKeyRepository: prefix-indexed lookup, constant-time compare),
  `entry_point` varchar(255), `revoked_at`, `created_at`, `last_used_at`.

App keys use prefix `lak_` to distinguish them from gpt's `ak_`/`uak_` keys. They
authorize *applications* to use the login service; they are not API-caller credentials.

## Login flow

1. App finds no valid token in its localStorage → browser goes to
   `http://localhost/login/?app_key=lak_...&redirect=<url>`.
2. Login page validates `app_key` against `registered_apps` (revoked check, hash
   compare) and checks `redirect` matches the registered `entry_point` (same origin +
   path prefix). Invalid → error page, no login form. Valid → form shows the app name.
3. User authenticates (email/password, Firebase social/phone, or passkey). The backend
   re-validates `app_key` + `redirect` server-side and mints access (8h) + refresh (7d)
   HS256 JWTs (claims: `iss: login-service`, `iat`, `exp`, `sub` = user id, `type`).
4. Browser redirects to `<entry_point>#token=<access>&refresh=<refresh>`. Fragments
   don't reach server logs.
5. The app's `login-client.js` snippet (~30 lines, shipped in this repo for copying)
   reads the fragment, stores both tokens in the app's own localStorage, strips the
   fragment from the URL.
6. `app_key`/`redirect` omitted → standalone mode: after login the page shows a
   signed-in confirmation (useful for testing).

## API surface (`/login/backend/api/v1/`)

| Endpoint | Purpose |
|---|---|
| `POST /auth/login` | email/password (bcrypt fallback path) |
| `POST /auth/register` | email/password signup, no funnel requirement |
| `POST /auth/firebase` | Firebase ID token → service JWTs (social + primary email path) |
| `POST /auth/refresh` | valid refresh JWT → new access JWT (new — gpt minted but never consumed refresh tokens) |
| `GET /verify` | Bearer token → `{user_id, email, role}` |
| `POST /webauthn/challenge` / `register` / `authenticate` | passkeys, ported as-is |
| `GET /apps/whoami` | app key → registered app info |

Login/firebase/webauthn-authenticate accept optional `app_key` + `redirect`; when
present, the JSON response includes the validated `redirect_url` and the page performs
the fragment redirect.

## Error handling

- Ported behavior kept: generic "invalid credentials" (no user enumeration),
  fail-closed when `JWT_SECRET` unset, constant-time key comparison.
- Unknown/revoked app_key, or `redirect` not matching the registered entry point →
  HTTP 400 + human-readable error page before the form renders.
- Expired refresh token → 401 `{error: "refresh_expired"}`; client restarts the
  redirect flow.
- API routes return JSON; only the login page itself renders HTML.

## Testing

- PHP unit tests (gpt backend test style): app-key hash/validate; redirect-URL pinning
  including adversarial cases (`http://localhost/dialog.evil/`, wrong origin, path
  prefix tricks); JWT mint/verify/refresh; register/login round-trip on a test DB.
- Scripted end-to-end smoke (curl shell script): mint test app key → register user →
  login → follow redirect → verify fragment token via `/verify`.
- Manual browser check for Firebase social and passkey paths.

## Follow-ups (out of scope here)

- Convert dialog / Voice / GEOApps / gpt to consume the service (one project per app).
- Decide whether gpt's own users table eventually becomes read-only / removed.
