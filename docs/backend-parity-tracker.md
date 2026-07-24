# Backend Parity & Hardening Tracker

Tracks the suboptimal/quirky items found in the PHP backend (`gpt/backend`) and their status in
each backend. The TypeScript backend (`gpt/backend_typescript`) is a faithful mirror, so most items
are either **fixed in both** or **mirrored as-is** (deliberately replicating PHP). DB-schema changes
are written as `.sql` for the owner to run (migrations are applied manually).

**Legend:** ✅ done · ⬜ to do · ➖ N/A · 🪞 mirror as-is (no fix intended) · 🚫 won't do (decided) · 🧪 differential-tested vs live PHP

**Deployment context / threat model:** internal corporate access, behind authentication (not public
internet). This lowers the priority of anti-abuse hardening (e.g. login rate-limiting) but NOT of
correctness or authentication-integrity items (e.g. #1 token verification still matters).

Last updated: 2026-06-30

## A. Fixes (correct in BOTH backends)

| # | Item | PHP | TS | Tested | Notes |
|---|------|-----|----|--------|-------|
| 1 | `firebaseAuth` verifies the Firebase ID token server-side (RS256 vs Google certs, aud/iss bound to projectId; identity from verified claims) | ✅ | ✅ | 🧪 | Reject-parity tested (empty→400, garbage/forged/old-attack→401). Happy path needs real social-login check. New dep: reach `googleapis.com` for certs (cached 1h). |
| 2 | JWT secret fails closed (no weak `your-secret-key…` / empty fallback) | ✅ | ✅ | 🧪 | PHP: throw if `JWT_SECRET` empty in `AuthController`, `WebAuthnController`, `MiddlewareProcessor`. TS: already fails closed via `required('JWT_SECRET')`. Verified normal boot/auth unaffected. |
| 4 | Public `/api/v1/auth` dispatcher gates protected actions centrally | ✅ | ✅ | 🧪 | `handleAction` rejects link/unlink_phone, upgrade_plan, *_app_key with 401 when unauthenticated (defense-in-depth; methods already self-checked, so responses unchanged). Parity confirmed byte-identical. |
| 3 | Login rate-limiting / lockout | 🚫 | 🚫 | — | **Won't do for now (2026-06-30).** Target is internal corporate access behind authentication, so brute-force exposure is low. Revisit if the backend is exposed to the public internet. |
| 7 | Remove runtime DDL from `AuthController` (`ensureUserSubscriptionColumns`) | ✅ | ➖ | 🧪 | Columns confirmed present in live DB → method + constructor call deleted; no migration needed. TS never did this. Live auth smoke OK. |
| 7b | Same runtime-DDL pattern in 11 other PHP files (MCP, memory repos, traces, file storage, admin, settings, heal) | ⬜ | ➖ | — | NOT yet ported to TS. Handle per-file when porting: if the table/columns are already in `schema/chatbot.sql` → delete the runtime DDL; if the runtime `CREATE TABLE IF NOT EXISTS` is the ONLY creator → add it to the schema (migration) first, then delete. Do NOT blind-delete. |
| 8 | `prompt_library.user_id` `varchar(255)` → integer to match JWT id | ✅ | ✅ | 🧪 | Migration `schema/migrations/2026-06-30_prompt_library_user_id_to_int.sql` **applied** (column now `int NOT NULL`). PHP already bound the int natively (no change). TS: typed `user_id` as `number`, dropped `String()` casts. getTree parity re-confirmed. FK still optional (1 orphan row to resolve first). |
| 5 | Pre-prod hardening: CORS `*`, shared JWT secret, browser-shipped voice keys | ⬜ | ⬜ | — | Already on the separate pre-prod hardening checklist; cross-listed here. |

## B. Mirror as-is (replicate PHP — no fix intended unless re-prioritized)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 6 | `firebaseAuth` writes arbitrary `provider` into an enum column | 🪞 | Both store the request `provider` as PHP does. Revisit only if #8-style schema cleanup happens. |
| 9 | Single inline per-user app key; regen silently invalidates old | 🪞 | Mirrored; matches PHP `users.app_key_*` semantics. |
| 10 | `getTree` loose `==` parent match, drops orphans | 🪞 | TS reproduces the same tree-building (orphans dropped). |
| 11 | Inconsistent messages ("Invalid or expired credential" vs "…token") | 🪞 | Mirrored verbatim. |
| 12 | Duplicate call paths (RESTful routes shadowed by action dispatcher) | 🪞 | Both supported, as in PHP. |
| 13 | Controllers only ever use the contexts DB | 🪞 | TS uses the contexts pool for controllers, same as PHP. |
| 14 | Body parsed unconditionally; invalid JSON → `{}` | 🪞 | TS body parser mirrors `json_decode(...) ?? []`. |
| 15 | register returns 200 (not 201); response timestamps are wall-clock | 🪞 | Mirrored. |
| 16 | `firebaseAuth` synthesizes `<phone>@phone.auth` emails | 🪞 | Mirrored (now from the verified phone claim). |
| 17 | Controller "response" array mixes transport keys with body | 🪞 | TS `handle()` replicates the convention. |
| 18 | `json_encode` full-precision floats + slash/unicode escaping | 🪞 | Cosmetic; JSON parsers (incl. the frontend) normalize. TS emits clean values. |

## How items get verified
Each fix is validated by **differential testing against the live PHP backend** (byte/semantic
compare) before its 🧪 box is checked. Changes are left unstaged for the repo owner to commit;
schema changes ship as `.sql` to run manually.
