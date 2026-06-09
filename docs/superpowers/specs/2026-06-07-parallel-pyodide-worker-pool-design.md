# Parallel Pyodide via Web Worker Pool — Design

**Date:** 2026-06-07
**Status:** Approved (pending feasibility spike)
**Area:** `frontend/assets/js` skill execution

## Problem

Skill scripts run in a single Pyodide instance on the main thread
(`pyodide-runner.js`). Within an LLM round, multiple `run_skill_script` calls
execute strictly sequentially through that one instance. Orchestrators like
`geo-audit` emit several independent sub-skill calls per round; even when the
model batches them into one assistant response ("parallel tool_use blocks"),
execution is still serial. This makes full audits slow.

Pyodide cannot run Python in parallel inside one instance: CPython-on-WASM is
single-threaded, and the app is **not** cross-origin isolated (no COOP/COEP),
so SharedArrayBuffer / WASM threads are unavailable. The only path to true
parallelism is **multiple Pyodide instances, one per Web Worker.**

## Goals / Non-Goals

**Goals**
- Run a round's independent `run_skill_script` calls concurrently across a
  pool of Web Worker Pyodide instances.
- Zero regression risk to the existing single-call path.
- Bounded resource use on a single dev machine.

**Non-Goals**
- Parallelizing `Task` subagents or `discover_skill` (different execution
  path; deferred).
- Cross-origin isolation / SharedArrayBuffer threading.
- Moving skill execution server-side (considered, rejected for now — abandons
  the local-FSA model).

## Architecture (additive)

A new `PyodideWorkerPool` runs **alongside** the existing main-thread
`pyodideRunner`, which is left unchanged.

`dispatchClientToolCall` branches on the round's shape:
- **1 `run_skill_script`**, or any `Task` / `discover_skill` → existing
  main-thread instance (unchanged).
- **2+ independent `run_skill_script` calls** → the worker pool, executed
  concurrently.

The client-tool round budget / depth logic and the tool_result→tool_use_id
pairing are unchanged. Only *where* a round's scripts execute changes.

## Components

1. **`pyodide.worker.js`** — a dedicated worker owning one Pyodide instance.
   Exposes one verb, `runSkillScript`, mirroring the current runner's
   per-run steps: mount skill FS → `ensureDeps` → prefetch URL args → run the
   Python harness (capturing stdout/stderr) → read back `readOutputs`.
   Returns the existing shape: `{ stdout, stderr, exitCode, outputs, durationMs }`.

2. **`PyodideWorkerPool`** (`pyodide-pool.js`)
   - Lazy worker creation up to `min(navigator.hardwareConcurrency - 1, 4)`.
   - Ready/busy tracking with a pending queue.
   - `runBatch(calls)` — fan calls across free workers, await all, return
     results in **original order**.
   - Warm reuse within and across rounds.
   - Idle reaper: terminate workers after ~2 min idle to release memory.

3. **Handle / permission bootstrap** — the main thread resolves each skill
   dir + the `outputs/` dir and ensures **readwrite permission is granted on
   the main thread** (workers cannot show the permission prompt), then
   `postMessage`-transfers the handles to each worker for `mountNativeFS`.

4. **Dispatcher integration** — the branch in `dispatchClientToolCall`, plus
   output-collision safety: only if two calls in a round target the same
   output path, apply `_rewriteOutputsForProvider`-style namespacing. Geo
   sub-skills already write distinct `GEO-*-EXTRACT.md` files, so this is a
   backstop, not the common case.

## Data Flow — a parallel round

1. `dispatchClientToolCall` detects N≥2 independent `run_skill_script` calls.
2. Main thread grants/collects the FSA handles (skill dirs + `outputs/`).
3. `pool.runBatch([{dirName, argv, readOutputs}, …])`.
4. Pool assigns each call to a free worker; workers run concurrently, each
   writing its own extract file into the shared `outputs/` mount.
5. Results collected in original order, paired back to their `tool_use_id`s.
6. The continuation request fires exactly as today.

## Error Handling & Fallback

- **Per-call isolation:** a single worker error becomes that call's
  `tool_result` error; siblings continue. The model already handles partial
  tool failures.
- **Hard fallback:** if a worker cannot spawn / load Pyodide, or an FSA mount
  fails in a worker, the pool **falls back to running that round sequentially
  on the existing main-thread instance.** The feature can never make a
  previously-working audit fail — worst case is today's speed.
- **Worker crash:** the pool drops the dead worker, reaps it, and the next
  batch lazily respawns.

## Feasibility Spike (Step 1 — gates the build)

The whole design assumes `mountNativeFS` works inside a worker with a
transferred, pre-permitted handle, and that concurrent writes to *distinct*
files in the same `outputs/` mount are safe.

**Spike (manual, on a real machine — needs real FSA):**
1. One worker: mount the real `outputs/`, write a file from Python, confirm
   it lands on disk.
2. Two workers: write two distinct files concurrently, confirm both land and
   neither corrupts the directory.

- **Pass** → build the pool as specified.
- **Fail** → pivot to the fallback architecture: workers receive file
  *content* via messages and return output *content* via messages; the main
  thread performs all disk I/O. Same pool, different handle strategy.

## Testing

- **Spike:** manual script (requires real FSA / user gesture).
- **Pool unit tests** with a mock worker: sizing cap, queueing, idle reap,
  fallback-on-spawn-failure, original-order result mapping.
- **End-to-end:** one `geo-audit` run — compare wall-clock vs. the current
  sequential path and verify the produced output files are identical.

## Decisions (resolved during design)

- Pool **alongside** the single instance, not replacing it.
- Sizing: **lazy, capped at `min(cores-1, 4)`, idle-reaped (~2 min).**
- Build is **gated on the feasibility spike passing.**
- `Task` subagents stay sequential for now.
