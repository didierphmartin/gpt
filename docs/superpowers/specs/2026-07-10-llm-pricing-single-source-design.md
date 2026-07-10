# LLM Token Pricing — Single Source of Truth

**Date:** 2026-07-10
**Status:** Design approved, pending spec review

## Problem

Token cost is computed in many places across two live backends (PHP `backend/` and
Node/TypeScript `backend_typescript/`). Only the TS `UsageLogger` reads the intended
source of truth — the `system_llm_settings` table (`price_input_per_1m`,
`price_output_per_1m`). Everything else carries its own hardcoded price numbers, several
of which are stale or wrong:

- PHP `UsageLogger::PRICING` — the **live** PHP cost writer; hardcoded and stale
  (e.g. prices `grok-4-1-fast-reasoning` at 3.0/15.0 vs. the real 0.20/0.50).
- PHP `UsageTracker::PRICING` — a second hardcoded live writer ("backup").
- PHP `GraphWorkflowRunner::getProviderPricing`, PHP `ExecutionTraceStore::pricing` —
  read the DB but embed a hardcoded defaults map.
- TS `ExecutionTraceStore`, `GraphWorkflowRunner`, `AdminController`,
  `SystemSettingsController` — read the DB but embed hardcoded defaults maps.

The result: the DB is **not** actually the source of truth for billed cost on the PHP
path, and the embedded default maps silently drift from the DB.

## Goal

`system_llm_settings` is the **single source of truth** for LLM token pricing in both
backends. No hardcoded price numbers remain on any billing/cost path. A price that
cannot be read from the DB is an **error that is surfaced**, never hidden behind a
fallback.

## Non-goals (out of scope)

- **Voice pricing** (`VOICE_PRICING`, per-second audio). Different concern; the table
  has no per-second columns. Untouched.
- **`model_catalog.json`** — the static file that feeds the *displayed* prices in the
  settings/usage UI. This is a display surface, not the billing path. Tracked as a
  follow-up, not part of this change.

## Design

### PricingResolver (one per backend)

A single small unit — `PricingResolver` in PHP, its mirror in TS — with one job:

> Given a provider key, return `[input_per_1m, output_per_1m]` from
> `system_llm_settings`, or throw if no valid price is configured.

Behaviour:

- Normalizes aliases: `anthropic → claude`, `google → gemini` (matches existing code).
- Queries `system_llm_settings` by `provider_key` for
  `price_input_per_1m`, `price_output_per_1m`.
- Caches results per request/run (as the existing DB-reading methods already do).
- **No hardcoded price numbers of any kind.**

### Resolution rules

| DB state for the provider | Result |
|---|---|
| Row exists, both prices non-NULL (incl. `0.0000`) | Return the values. `0` is a legitimate cost (e.g. self-hosted `gamma4`), used as-is. |
| Row missing | Throw `PricingUnavailableException`. |
| Row exists but a price is `NULL` | Throw `PricingUnavailableException`. |
| DB query itself fails (table/column absent, connection error) | Throw `PricingUnavailableException`. |

`NULL` (unconfigured) and `0` (configured as free) are treated as distinct: `NULL`
is a misconfiguration to surface; `0` is a valid zero cost.

### Error surfacing (an error is an error)

`PricingUnavailableException` carries a precise message, e.g.
*"No price configured for provider 'gemini' in system_llm_settings"*.

At each cost-calculation call site:

1. **Never crash the user's request.** The exception is caught at the cost boundary so
   a pricing misconfiguration does not fail a chat/workflow response.
2. **Log loudly** via the backend logger (PHP `error_log`, TS `Logger`).
3. **Surface to the operator** so they can fix the DB row:
   - Chat/usage responses include a `cost_error` field on the usage object with the
     message.
   - The transaction row is recorded with cost **unset and flagged as errored**, not a
     silent `$0`.
   - The admin usage view renders an error state for that entry.

### Call sites rewired to the resolver

**PHP**
- `Services/UsageLogger.php` — `calculateCost()` uses resolver; delete `const PRICING`.
- `Services/UsageTracker.php` — `calculateCost()` uses resolver; delete `const PRICING`.
- `AgentTeam/Services/GraphWorkflowRunner.php` — `getProviderPricing()` delegates to
  resolver; delete embedded defaults map.
- `AgentTeam/Services/ExecutionTraceStore.php` — `pricing()` delegates to resolver;
  delete embedded defaults map.

**TypeScript**
- `Services/UsageLogger.ts` — already DB-driven; refactor to use the shared resolver.
- `AgentTeam/ExecutionTraceStore.ts` — `pricing()` uses resolver; delete defaults map.
- `AgentTeam/GraphWorkflowRunner.ts` — uses resolver; delete defaults map.
- `Controllers/AdminController.ts`, `Controllers/SystemSettingsController.ts` — remove
  embedded `PRICE_DEFAULTS`-style pricing maps used at cost time (see seeding note).

### Provider-row seeding (`PRICE_DEFAULTS`)

To keep the system truly single-source, creating a **new** provider row seeds its price
as **`NULL`**, not a hardcoded guess. A newly added provider therefore surfaces
"price not configured" until an admin sets it in `system_llm_settings`. The
`PRICE_DEFAULTS` constants used only for cost computation are removed; any remaining use
for *seeding* is replaced by NULL.

## Testing

- Resolver returns configured values for a normal provider (e.g. `openai` 2.50/10.00).
- Resolver returns `0` for a provider priced 0/0 (`gamma4`) and cost computes to `0`.
- Resolver throws for: missing row, NULL price, simulated DB failure.
- Cost path catches the throw: request still succeeds, `cost_error` present, transaction
  flagged, logger called.
- Parity check: PHP and TS resolvers produce identical results for the same DB rows.

## Consequences

- One place to change a price: the DB row. No code edit ever needed to fix a price.
- Misconfiguration is visible immediately instead of producing silently wrong bills.
- `model_catalog.json` display prices remain a known, separate follow-up.
