# Email-keyed user storage (frontend)

**Date:** 2026-05-29
**Scope:** `/gpt/frontend` (client-side only). Backend unchanged.

## Problem

The frontend caches the logged-in user as a single flat `localStorage['user']`
key. Each login overwrites it. When the same browser is used with more than one
account (the same person owning several email accounts), this single key is
clobbered, and cached identity (`user.id`, used for MCP tool scoping in
`mcp-client.js` and usage tracking in `chat.js`) can go stale relative to the
active `token`. In our system **email is the unique account identifier**, so
user info should be keyed by email rather than held in one flat slot.

## Decisions (from brainstorming)

- **Email is the key.** Cache user info under a top-level `access` map keyed by
  email.
- **One active account at a time.** Switching accounts requires logging in
  again — we do NOT persist multiple session tokens or build a no-relogin
  switcher.
- **Passkey is shared, not per-email.** A single fingerprint/passkey can serve
  multiple accounts; the backend resolves which account a credential maps to.
  `webauthn_credential_id` stays a single shared top-level key, unchanged.
- **Social-login differences are already captured.** What differs per account is
  the auth provider (Google / Facebook / email / phone), already carried in
  `user.provider` (+ `firebase_uid`) inside each user object. OAuth secrets never
  live in localStorage. Nothing extra to store per email beyond the user object.
- **Backend: no change.** `users.email` is already UNIQUE, every auth response
  already includes `email` in the user object, and JWT `sub` stays the integer
  `users.id` for server-side scoping.

## localStorage shape

```
access        -> { "a@x.com": {id, email, first_name, last_name, role, plan,
                                provider, created_at, ...},
                   "b@y.com": {id, email, ..., provider} }   // user object per email
activeEmail   -> "a@x.com"          // currently logged-in email; null when logged out
token         -> <jwt>              // active session only (single; switching = re-login)
refresh_token -> <jwt>
webauthn_credential_id -> "<id>"    // UNCHANGED: single shared passkey
```

"Current user" is always resolved as `access[activeEmail]`. The old flat
`localStorage['user']` key is removed.

## New module: `assets/js/account-store.js`

The single place that reads/writes `access`, `activeEmail`, and the session
tokens. No other file touches `localStorage['user']` directly.

- `getActiveEmail()` -> string | null
- `getActiveUser()` -> `access[activeEmail]` or null
- `getToken()` / `getRefreshToken()`
- `setActiveAccount(user, token, refreshToken)` -> writes `access[user.email]`
  (normalizing email to lowercase/trim, matching backend), sets `activeEmail`,
  stores tokens. Replaces any prior session.
- `updateActiveUser(patch)` -> shallow-merge `patch` into `access[activeEmail]`
  (used by the post-payment `plan` update).
- `clearActiveAccount()` -> clears `activeEmail`, `token`, `refresh_token` on
  logout. Keeps the `access` cache so the account can be logged into again.
- `migrateLegacyUser()` -> one-time migration (see below), called on load.

Email normalization mirrors the backend (`strtolower(trim(...))`) so keys match
across login methods.

## Call sites to migrate

| File | Current | New |
|------|---------|-----|
| `assets/js/auth.js` | constructor reads `token`+`user`; `saveAuthData` writes `token`/`refresh_token`/`user`; `clearAuthData` removes them; embed-mode `postMessage` handler writes `token`/`user` | hydrate via `getToken`/`getActiveUser`; `saveAuthData` -> `setActiveAccount`; `clearAuthData` -> `clearActiveAccount`; embed handler -> `setActiveAccount` |
| `register.html` | 3 signup paths (email, Google, Facebook) write `token`+`user` | `setActiveAccount(user, token, refreshToken)` |
| `payment.html` | read-modify-write of `user.plan` | `updateActiveUser({ plan })` |
| `index.html` | account modal reads `user`; fallback logout removes `token`/`refresh_token`/`user` | `getActiveUser()`; `clearActiveAccount()` |
| `chat.js` | 3 reads of `user.id` (compare/verify tracking) | `getActiveUser()?.id` |
| `mcp-client.js` | reads `user.id`/`user.uid` for tool scoping | `getActiveUser()` |

Untouched: `webauthn_credential_id` and `settings-panel.js` passkey
register/remove (shared passkey).

## One-time migration

On app load, before any auth read:

```
if localStorage['user'] exists and localStorage['access'] is absent:
    user = JSON.parse(localStorage['user'])
    if user?.email:
        access[normalize(user.email)] = user
        activeEmail = normalize(user.email)
    keep existing token / refresh_token / webauthn_credential_id
    delete localStorage['user']
```

Currently logged-in users stay logged in; no forced re-auth.

## Error handling / edge cases

- Malformed/absent `access` JSON -> treat as empty object; `getActiveUser()`
  returns null (logged-out state), never throws.
- `activeEmail` set but missing from `access` (corrupted) -> `getActiveUser()`
  returns null; treated as logged out.
- User object without `email` (should not happen post-backend) ->
  `setActiveAccount` rejects/no-ops and logs, rather than writing an
  `undefined` key.

## Testing

No automated frontend test harness exists in `/gpt/frontend`. Verification is
manual, scripted as a checklist:

1. Fresh login with email A -> `access` has A, `activeEmail = A`, chat/MCP work.
2. Logout -> `activeEmail`/tokens cleared, `access` retains A.
3. Login with email B -> `access` has A and B, `activeEmail = B`.
4. Log back into A -> reuses cached A, `activeEmail = A`, correct `user.id` in
   MCP/usage calls.
5. Payment plan update on active account mutates only that email's entry.
6. Migration: seed legacy `user`, load app, confirm it becomes `access[email]`
   + `activeEmail` and old key is gone, session preserved.
7. Social-login accounts (Google/Facebook) store correct `provider` per email.

## Out of scope

- Chrome extension (`/google_extension/js/storage.js`) has the identical
  single-`user` pattern but is a separate codebase; follow-up if desired.
- No-relogin account switching / multi-token sessions.
- Any backend change.
