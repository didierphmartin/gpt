# Backend Python Port — Phase 8 (Schedules, scheduler, scripts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port scheduled workflows (`ScheduledWorkflowService`, `ScheduledWorkflowController` — 9 routes), the scheduler trigger (`SchedulerController` — 2 routes, internal token), the cron entry point (`backend/scheduler/run-scheduled-workflows.php` → `backend_python/scheduler/run_scheduled_workflows.py`), and the `backend/scripts/*.php` utilities that are still live (each becomes a `backend_python/scripts/*.py` with the same CLI contract; test-only PHP scripts are NOT ported — note them in the tracker).

**Architecture:** `app/agent_team/services/scheduled_workflow_service.py`, `app/agent_team/controllers/{scheduled_workflow,scheduler}_controller.py`, one module per PHP file; the cron script reuses the Python app's config/DB and calls the same service methods the PHP script calls; `GraphWorkflowRunner` (Phase 5) executes due schedules.

**Tech Stack:** Python 3.13, PyMySQL, pytest; cron via the same crontab line pointed at the Python script (documented, not installed by us).

**Spec:** `docs/superpowers/specs/2026-09-05-backend-python-port-design.md` (§4 phase 8 row).

## Global Constraints
- Phase 1–7 Global Constraints apply.
- **`calculateNextRun`** must produce the same `next_run_at` as PHP for the same schedule config and `now` (cron-expression parsing: port PHP's parser exactly, or, if PHP uses a library, pin the semantics with a table of 20 cases run through the live PHP script via `php -r` and stored as a fixture).
- **Internal token:** `SchedulerController::run` checks the internal token exactly as PHP (`config['scheduler']['internal_token']` or env — read `SchedulerController.php:run`); the Python config loader must expose the same key from the same `.env` var.
- **Cron script:** same exit codes, same stdout lines (they are parsed by nothing but humans — keep them identical anyway), same lock/overlap protection if PHP has one.
- **Differential (user 3):** `GET /schedules`, `/schedules/stats`, `/workflows/{id}/schedules` exact; round-trip create (`differential-tmp` schedule on the smallest workflow, paused) → show → update → pause → resume → delete → lists equal pre-state; `POST /scheduler/run` without/with an invalid token parity (never trigger a real run in the differential); `GET /scheduler/status` exact.
- Commit trailer as previous phases.

## Tasks
1. `ScheduledWorkflowService` (341: `create`, `update`, `delete`, `findById`, `findByUser`, `findByWorkflow`, `getDueSchedules`, `markRunning`, `markCompleted`, `markFailed`, `calculateNextRun`, `pause`, `resume`, `getStats`) — SQL byte-identical; `calculateNextRun` fixture table. Commit `feat(py): ScheduledWorkflowService`.
2. `ScheduledWorkflowController` (routes 451–459) + `SchedulerController` (routes 464–465; `run`, `status`, `executeScheduler` using the Phase 5 runner). Commit `feat(py): schedules + scheduler routes`.
3. Cron entry point `backend_python/scheduler/run_scheduled_workflows.py` mirroring `backend/scheduler/run-scheduled-workflows.php` (CLI flags, logging, exit codes) + `backend_python/scripts/` ports of the live utilities in `backend/scripts/` (`firebase-auth-export.php`, `migrate-skills-to-fs.php`, `register_mock_okta.php`, `register_mock_stack.php`; the `test-*.php` scripts are test harnesses already covered by Phase 6 tests — not ported, tracker row). Commit `feat(py): scheduler cron script + scripts`.
4. Docs, verification, final: README Phase 8 paragraph + "all phases complete" status table; tracker rows; full unit + differential (live cases once); browser smoke of the Schedules panel on Python; update the switcher docs (`docs/backend-parity-tracker.md` intro) to state the Python backend is feature-complete for the routes listed. Commit `docs(py): Phase 8 status + parity rows`.

## Self-review notes
- Coverage of umbrella §4 phase 8 (schedules + scheduler endpoints, cron script, scripts utilities): T1–T3.
