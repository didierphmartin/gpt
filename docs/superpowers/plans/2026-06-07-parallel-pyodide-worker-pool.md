# Parallel Pyodide Worker Pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a round's independent `run_skill_script` calls concurrently across a pool of Web Worker Pyodide instances, without regressing the existing single-call path.

**Architecture:** A new `PyodideWorkerPool` runs *alongside* the unchanged main-thread `pyodideRunner`. `dispatchClientToolCall` routes rounds of 2+ independent `run_skill_script` calls to the pool; everything else (single calls, `Task`, `discover_skill`) stays on the main thread. The pool lazily spawns up to `min(cores-1, 4)` workers, reuses them, and reaps them after idle. Any pool failure falls back to the existing sequential path, so a working audit can never be broken.

**Tech Stack:** Vanilla JS (IIFE globals on `window`, mirrors `pyodide-runner.js`), Web Workers, Pyodide `mountNativeFS` + File System Access API, `node --test`-style `.mjs` unit tests, Playwright for browser e2e.

**Project note:** This project is NOT under version control. Replace "commit" with the **Checkpoint** step in each task: stop, run the listed verification, and confirm green before moving on.

---

## File Structure

- **Create** `frontend/spike/pyodide-worker-spike.html` — throwaway manual spike harness (Task 1).
- **Create** `frontend/spike/pyodide-spike.worker.js` — throwaway minimal worker for the spike (Task 1).
- **Create** `frontend/assets/js/pyodide.worker.js` — production worker: one Pyodide instance, `runSkillScript` verb (Task 3).
- **Create** `frontend/assets/js/pyodide-pool.js` — `PyodideWorkerPool` (sizing, queue, ordering, idle-reap, fallback hook). Attaches `window.pyodideWorkerPool`; testable under node via injectable worker factory (Task 4).
- **Create** `frontend/tests/pyodide-pool.test.mjs` — pure-logic unit tests with a mock worker (Task 4).
- **Modify** `frontend/assets/js/chat.js` — extract `_buildSkillScriptRequest(call, ctx)` from the existing `run_skill_script` branch, then branch `dispatchClientToolCall` to the pool for 2+ calls with fallback (Tasks 5–6).
- **Modify** `frontend/index.html:3984` area — add `<script>` tags for the two new assets (Task 6).

---

## Task 1: Feasibility spike — `mountNativeFS` inside a worker (HARD GATE)

Proves the core assumption: a worker-side Pyodide can mount a transferred, pre-permitted FSA handle and write to disk, and two workers can write distinct files into the same `outputs/` mount concurrently without corruption. **If this fails, STOP and revise the spec** (pivot to the content-passing fallback architecture documented in the design); do not start Task 2.

**Files:**
- Create: `frontend/spike/pyodide-spike.worker.js`
- Create: `frontend/spike/pyodide-worker-spike.html`

- [ ] **Step 1: Write the spike worker**

Create `frontend/spike/pyodide-spike.worker.js`:

```js
// Throwaway spike worker. One job: load Pyodide, mount a transferred FSA
// handle, write a file from Python, report back.
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';
importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);

let pyodide = null;

self.onmessage = async (e) => {
  const { id, outputsHandle, filename, contents } = e.data;
  try {
    if (!pyodide) {
      pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    }
    // queryPermission must already be 'granted' (granted on main thread).
    const perm = await outputsHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error(`permission not granted in worker: ${perm}`);

    pyodide.FS.mkdirTree('/outputs');
    await pyodide.mountNativeFS('/outputs', outputsHandle);
    pyodide.globals.set('_fname', filename);
    pyodide.globals.set('_body', contents);
    await pyodide.runPythonAsync(`
with open('/outputs/' + _fname, 'w') as f:
    f.write(_body)
`);
    // CRITICAL: flush NativeFS (in-memory) back to the real folder. Pyodide's
    // mountNativeFS writes land in an in-memory layer; without FS.syncfs(false)
    // they NEVER reach disk even though the write "succeeds". This is the same
    // flush pyodide-runner.js does on its `persist` path. `false` = mem->disk.
    await new Promise((resolve, reject) =>
      pyodide.FS.syncfs(false, err => err ? reject(err) : resolve()));
    self.postMessage({ id, ok: true });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
```

- [ ] **Step 2: Write the spike harness page**

Create `frontend/spike/pyodide-worker-spike.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Pyodide worker FSA spike</title>
<button id="pick">1. Pick outputs/ folder</button>
<button id="one" disabled>2. One worker writes a file</button>
<button id="two" disabled>3. Two workers write distinct files concurrently</button>
<pre id="log"></pre>
<script>
const log = (m) => document.getElementById('log').textContent += m + '\n';
let outputsHandle = null;

document.getElementById('pick').onclick = async () => {
  outputsHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  const p = await outputsHandle.requestPermission({ mode: 'readwrite' });
  log('permission: ' + p);
  document.getElementById('one').disabled = false;
  document.getElementById('two').disabled = false;
};

function runWorker(filename, contents) {
  return new Promise((resolve) => {
    const w = new Worker('./pyodide-spike.worker.js');
    const id = filename;
    w.onmessage = (e) => { w.terminate(); resolve(e.data); };
    w.postMessage({ id, outputsHandle, filename, contents });
  });
}

document.getElementById('one').onclick = async () => {
  log('one: starting...');
  const r = await runWorker('spike-one.txt', 'hello from worker\n');
  log('one: ' + JSON.stringify(r) + ' — now check the file exists on disk');
};

document.getElementById('two').onclick = async () => {
  log('two: starting two workers concurrently...');
  const [a, b] = await Promise.all([
    runWorker('spike-A.txt', 'A'.repeat(1000) + '\n'),
    runWorker('spike-B.txt', 'B'.repeat(1000) + '\n'),
  ]);
  log('two: A=' + JSON.stringify(a) + ' B=' + JSON.stringify(b));
  log('two: verify BOTH files exist on disk with correct contents and the folder is intact');
};
</script>
```

- [ ] **Step 3: Run the spike manually**

1. Serve via XAMPP and open `http://localhost/gpt/frontend/spike/pyodide-worker-spike.html`.
2. Click button 1, pick a scratch folder, confirm `permission: granted`.
3. Click button 2; confirm `{ok:true}` and that `spike-one.txt` appears on disk with the right contents.
4. Click button 3; confirm both `{ok:true}`, both `spike-A.txt`/`spike-B.txt` land with correct contents, and the folder is not corrupted.

Expected: all three succeed.

- [ ] **Step 4: Decision checkpoint (GATE)**

- **All pass** → mark the gate PASSED in this plan and proceed to Task 2.
- **Any fail** (esp. mount or concurrent write) → STOP. Record the exact error here, re-invoke brainstorming to revise the spec toward the content-passing fallback (workers receive/return file *content* via messages; main thread does disk I/O). Do not proceed.

- [ ] **Step 5: Checkpoint**

The `frontend/spike/` folder is throwaway. Leave it in place until the e2e task (Task 7) passes, then delete it. Confirm the gate decision is recorded above before continuing.

---

## Task 2: Confirm the production runner steps to port

Read-only task: capture the exact per-run sequence the worker must reproduce, so Task 3's worker matches the main-thread runner's behavior.

**Files:**
- Read: `frontend/assets/js/pyodide-runner.js` (functions `ensureLoaded` ~86, `ensureMounted` ~106, `ensureOutputsMounted` ~140, `ensureSkillsRootMounted` ~178, `getSkillDependencies` ~220, `prefetchUrlArgs` ~306, `ensureDeps` ~444, the Python harness ~816–885, and the public `runSkillScript` entry ~894 and `window.pyodideRunner` export ~1200).

- [ ] **Step 1: Write down the per-run contract**

In a scratch comment at the top of the new `frontend/assets/js/pyodide.worker.js` (created in Task 3), record the ordered steps observed: (1) ensure Pyodide loaded, (2) mount skill dir at `/skill/<dirName>`, (3) mount `/outputs`, (4) `ensureDeps(getSkillDependencies(dirName))`, (5) `prefetchUrlArgs(argv, dirName)` if the skill `fetches_urls`, (6) run the Python harness capturing stdout/stderr, (7) read back `readOutputs`, (8) return `{ stdout, stderr, exitCode, outputs, durationMs }`.

- [ ] **Step 2: Checkpoint**

Confirm the contract list is accurate against the source before writing the worker. No tests for a read-only task.

---

## Task 3: Production worker `pyodide.worker.js`

A worker that owns one Pyodide instance and exposes a single `runSkillScript` message verb returning the same shape as `window.pyodideRunner.runSkillScript`.

**Files:**
- Create: `frontend/assets/js/pyodide.worker.js`

- [ ] **Step 1: Scaffold the worker message protocol**

Create `frontend/assets/js/pyodide.worker.js`:

```js
// Pool worker: one Pyodide instance, one verb (`runSkillScript`). Mirrors the
// per-run steps of pyodide-runner.js (see Task 2 contract). Handles are
// transferred from the main thread with readwrite already granted.
// MUST match pyodide-runner.js PYODIDE_VERSION (0.27.7) — version drift changes
// asyncio/event-loop semantics (0.26.x breaks scripts that call asyncio.run()).
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);

let pyodide = null;
const mountedSkills = new Map();   // dirName -> mountPath
let outputsMounted = false;

async function ensureLoaded() {
  if (!pyodide) pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  return pyodide;
}

self.onmessage = async (e) => {
  const { id, verb, payload } = e.data || {};
  try {
    if (verb !== 'runSkillScript') throw new Error(`unknown verb: ${verb}`);
    const result = await runSkillScript(payload);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
```

- [ ] **Step 2: Implement mounting from transferred handles**

Append:

```js
async function mountSkill(dirName, skillHandle) {
  if (mountedSkills.has(dirName)) return mountedSkills.get(dirName);
  const perm = await skillHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error(`skill "${dirName}" not permitted in worker`);
  const mountPath = `/skill/${dirName}`;
  pyodide.FS.mkdirTree(mountPath);
  await pyodide.mountNativeFS(mountPath, skillHandle);
  mountedSkills.set(dirName, mountPath);
  return mountPath;
}

async function mountOutputs(outputsHandle) {
  if (outputsMounted) return '/outputs';
  const perm = await outputsHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('outputs not permitted in worker');
  pyodide.FS.mkdirTree('/outputs');
  await pyodide.mountNativeFS('/outputs', outputsHandle);
  outputsMounted = true;
  return '/outputs';
}
```

- [ ] **Step 3: Implement `runSkillScript` (mirror the Task 2 contract)**

Append. The payload carries everything resolved on the main thread (so the worker does no FSA resolution or permission prompting):

```js
// payload: { dirName, skillHandle, outputsHandle, argv, deps, readOutputs,
//            scriptRelPath, prefetched }
// `prefetched` is an optional array of { path, contents } the main thread
// fetched via the backend proxy (workers do not call the URL proxy — keep
// network on the main thread for one consistent fetch path).
async function runSkillScript(payload) {
  const t0 = Date.now();
  await ensureLoaded();
  await mountSkill(payload.dirName, payload.skillHandle);
  await mountOutputs(payload.outputsHandle);

  // Materialize any prefetched URL content into /tmp (mirrors main-thread prefetch).
  for (const f of (payload.prefetched || [])) {
    pyodide.FS.mkdirTree('/tmp');
    pyodide.FS.writeFile(f.path, f.contents);
  }

  // Install deps (loadPackage for prebuilt; micropip for the rest).
  if (Array.isArray(payload.deps) && payload.deps.length) {
    const prebuilt = payload.deps.filter(d => !d.includes('=='));
    if (prebuilt.length) await pyodide.loadPackage(prebuilt);
    const viaMicropip = payload.deps.filter(d => d.includes('=='));
    if (viaMicropip.length) {
      await pyodide.loadPackage('micropip');
      const micropip = pyodide.pyimport('micropip');
      for (const pkg of viaMicropip) await micropip.install(pkg);
    }
  }

  pyodide.globals.set('_argv', payload.argv || []);
  pyodide.globals.set('_script', `/skill/${payload.dirName}/${payload.scriptRelPath}`);

  // Python harness: capture stdout/stderr, run the script as __main__, record exit code.
  const harness = `
import sys, io, runpy
_out, _err = io.StringIO(), io.StringIO()
_so, _se = sys.stdout, sys.stderr
_code = 0
try:
    sys.stdout, sys.stderr = _out, _err
    sys.argv = [_script] + list(_argv)
    runpy.run_path(_script, run_name='__main__')
except SystemExit as e:
    _code = int(e.code) if isinstance(e.code, int) else (0 if e.code is None else 1)
    if _code != 0:
        print(e.code, file=sys.stderr)
except Exception as e:
    import traceback; traceback.print_exc(); _code = 1
finally:
    sys.stdout, sys.stderr = _so, _se
_runner_stdout = _out.getvalue()
_runner_stderr = _err.getvalue()
_runner_exit = _code
`;
  await pyodide.runPythonAsync(harness);

  // CRITICAL: persist NativeFS mounts (incl. /outputs) to disk by calling
  // syncfs() on each mount OBJECT (the value mountNativeFS returns). The Task 1
  // spike proved the global pyodide.FS.syncfs(false) does NOT persist a
  // worker's transferred mount — only the per-mount syncfs() does. `flushables`
  // collects the mount objects from mountSkill()/mountOutputs().
  for (const fs of flushables) await fs.syncfs();

  const outputs = {};
  for (const rel of (payload.readOutputs || [])) {
    try { outputs[rel] = pyodide.FS.readFile(`/outputs/${rel}`, { encoding: 'utf8' }); }
    catch (_) { /* missing output is reported by absence */ }
  }

  return {
    stdout: pyodide.globals.get('_runner_stdout') ?? '',
    stderr: pyodide.globals.get('_runner_stderr') ?? '',
    exitCode: pyodide.globals.get('_runner_exit') ?? 0,
    outputs,
    durationMs: Date.now() - t0,
  };
}
```

- [ ] **Step 4: Manual smoke test via the spike harness pattern**

Temporarily point a copy of the Task 1 harness at `../assets/js/pyodide.worker.js`, send `{verb:'runSkillScript', payload:{...}}` for one real geo sub-skill (e.g. `geo-crawlers` with a test URL prefetched on the main thread), and confirm it returns non-empty `stdout`/`outputs` and the extract file lands on disk.

Expected: PASS (a `GEO-*-EXTRACT.md` is written, `exitCode: 0`).

- [ ] **Step 5: Checkpoint**

Confirm the worker returns the exact `{ stdout, stderr, exitCode, outputs, durationMs }` shape. Verify by `JSON.stringify` of the result in the harness log.

---

## Task 4: `PyodideWorkerPool` + unit tests

The pool: lazy spawn up to `min(cores-1, 4)`, queue, run a batch concurrently, preserve original order, idle-reap. Worker creation is injected so it is testable under node.

**Files:**
- Create: `frontend/assets/js/pyodide-pool.js`
- Test: `frontend/tests/pyodide-pool.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/pyodide-pool.test.mjs`:

```js
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadPool() {
  const code = readFileSync(new URL('../assets/js/pyodide-pool.js', import.meta.url), 'utf8');
  // Inject the host realm's Array so arrays the IIFE builds (new Array(...))
  // share this realm's Array.prototype — otherwise assert.deepStrictEqual
  // rejects identical arrays on a cross-realm prototype mismatch. Also pass
  // the timer fns the reaper needs. A real browser has one realm, so this is
  // closer to production than an isolated-globals sandbox.
  const ctx = { Array, navigator: { hardwareConcurrency: 8 }, console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx; // PyodideWorkerPool is attached to the ctx (globalThis)
}

// Mock worker factory: each "worker" runs a provided async fn keyed by payload.label.
function mockFactory(behavior) {
  let live = 0; const peak = { n: 0 };
  const make = () => {
    live++; peak.n = Math.max(peak.n, live);
    return {
      run: async (payload) => behavior(payload),
      terminate: () => { live--; },
    };
  };
  return { make, peak, liveCount: () => live };
}

// 1. Batch preserves original order even when later items finish first.
{
  const ctx = loadPool();
  const f = mockFactory(async (p) => { await new Promise(r => setTimeout(r, p.label === 'slow' ? 30 : 1)); return p.label; });
  const pool = new ctx.PyodideWorkerPool({ workerFactory: f.make, maxWorkers: 4 });
  const out = await pool.runBatch([{ label: 'slow' }, { label: 'fast' }]);
  assert.deepStrictEqual(out.map(r => r.result), ['slow', 'fast'], 'results in original order');
  await pool.shutdown();
}

// 2. Concurrency is capped at maxWorkers.
{
  const ctx = loadPool();
  const f = mockFactory(async () => { await new Promise(r => setTimeout(r, 10)); return 'ok'; });
  const pool = new ctx.PyodideWorkerPool({ workerFactory: f.make, maxWorkers: 2 });
  await pool.runBatch(Array.from({ length: 6 }, (_, i) => ({ label: i })));
  assert.strictEqual(f.peak.n, 2, 'never more than 2 workers live');
  await pool.shutdown();
}

// 3. A failing item rejects only that item; siblings still resolve.
{
  const ctx = loadPool();
  const f = mockFactory(async (p) => { if (p.label === 'bad') throw new Error('boom'); return p.label; });
  const pool = new ctx.PyodideWorkerPool({ workerFactory: f.make, maxWorkers: 4 });
  const out = await pool.runBatch([{ label: 'good' }, { label: 'bad' }]);
  assert.strictEqual(out[0].ok, true);
  assert.strictEqual(out[0].result, 'good');
  assert.strictEqual(out[1].ok, false);
  assert.match(out[1].error, /boom/);
  await pool.shutdown();
}

console.log('pyodide-pool.test.mjs: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node frontend/tests/pyodide-pool.test.mjs`
Expected: FAIL with `ReferenceError: PyodideWorkerPool is not defined` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `frontend/assets/js/pyodide-pool.js`:

```js
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

  class PyodideWorkerPool {
    constructor({ workerFactory, maxWorkers, idleMs = 120000 } = {}) {
      if (typeof workerFactory !== 'function') throw new Error('workerFactory required');
      this._make = workerFactory;
      this._max = Math.max(1, maxWorkers || Math.min(hc - 1, 4));
      this._idleMs = idleMs;
      this._idle = [];      // available workers
      this._live = 0;       // total spawned
      this._timer = null;
    }

    _acquire() {
      if (this._idle.length) return this._idle.pop();
      if (this._live < this._max) { this._live++; return this._make(); }
      return null; // caller must queue
    }

    _release(w) { this._idle.push(w); this._scheduleReap(); }

    _scheduleReap() {
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        while (this._idle.length) { const w = this._idle.pop(); try { w.terminate(); } catch (_) {} this._live--; }
      }, this._idleMs);
    }

    // Run `items` concurrently (<= maxWorkers at once), preserving order.
    async runBatch(items) {
      const results = new Array(items.length);
      let next = 0;
      const runOne = async () => {
        while (next < items.length) {
          const i = next++;
          let w = this._acquire();
          while (!w) { await new Promise(r => setTimeout(r, 1)); w = this._acquire(); }
          try {
            const result = await w.run(items[i]);
            results[i] = { ok: true, result };
          } catch (err) {
            results[i] = { ok: false, error: String(err && err.message || err) };
          } finally {
            this._release(w);
          }
        }
      };
      const lanes = Math.min(this._max, items.length);
      await Promise.all(Array.from({ length: lanes }, runOne));
      return results;
    }

    async shutdown() {
      if (this._timer) clearTimeout(this._timer);
      while (this._idle.length) { const w = this._idle.pop(); try { w.terminate(); } catch (_) {} }
      this._live = 0;
    }
  }

  root.PyodideWorkerPool = PyodideWorkerPool;
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node frontend/tests/pyodide-pool.test.mjs`
Expected: PASS — prints `pyodide-pool.test.mjs: all assertions passed`.

- [ ] **Step 5: Checkpoint**

Confirm all three assertions pass. The browser worker factory (real `new Worker`) is wired in Task 6, not here — this task validates scheduling logic only.

---

## Task 5: Extract `_buildSkillScriptRequest(call, ctx)` in chat.js (DRY)

The existing `run_skill_script` branch (chat.js ~3340–3809) builds `argv`/`readOutputs`/dir resolution then calls `window.pyodideRunner.runSkillScript`. Extract the request-building (everything up to, but not including, the `runSkillScript` invocation) into a helper both the main-thread path and the pool path can call. This avoids duplicating ~400 lines of normalization.

**Files:**
- Modify: `frontend/assets/js/chat.js:3340-3809`

- [ ] **Step 1: Read the full branch**

Read `chat.js:3340-3809` end to end. Identify the exact point where `argv`, `readOutputs` (after augmentation/inference at ~3403–3482), `dirName`, and the resolved script path are all final, immediately before `const result = await window.pyodideRunner.runSkillScript({...})` at ~3809.

- [ ] **Step 2: Introduce the helper (no behavior change)**

Move the request-building into a new method on the same class:

```js
// Returns the fully-normalized request object passed to runSkillScript:
// { dirName, scriptRelPath, argv, readOutputs, deps, fetchesUrls }.
// Pure of side effects except the same console diagnostics as before.
_buildSkillScriptRequest(call, ctx) {
  // ...the existing normalization logic moved verbatim from 3340..3809...
  return { dirName, scriptRelPath, argv, readOutputs, deps, fetchesUrls };
}
```

Then in `_executeSingleClientToolCall`, replace the inlined building with:

```js
const req = this._buildSkillScriptRequest(call, ctx);
const result = await window.pyodideRunner.runSkillScript(req);
```

- [ ] **Step 3: Verify no behavior change (single-call path)**

Run a single-skill turn (e.g. one `geo-crawlers` call via its chip) in the browser and confirm it behaves exactly as before: same artifact pane, same output file, same stdout in the tool result.

Expected: identical behavior to pre-refactor.

- [ ] **Step 4: Syntax check**

Run: `node --check frontend/assets/js/chat.js`
Expected: no output (valid).

- [ ] **Step 5: Checkpoint**

Confirm the single-call path is unchanged. The helper now exists for Task 6 to reuse.

---

## STATUS (2026-06-08): Task 6 IMPLEMENTED — awaiting browser e2e (Task 7)

**Integration built via an execution SEAM (cleaner than the planned
`_finalizeSkillScriptResult` extraction — that 230-line block was left untouched):**
- `_executeSingleClientToolCall(call, ctx, depth, isLastCallInRound, runSkill=null)`
  gained an optional `runSkill`; at the call site it runs `runSkill(req)` when
  injected, else the main-thread runner. All finalization stays put.
- `_makePyodidePool()` (worker factory + {id,verb,payload} protocol) and
  `_runViaPool(req)` (resolves handles + deps on the main thread, calls the pool,
  throws on failure) added to chat.js.
- `dispatchClientToolCall`: parallel branch before the sequential loop — fires when
  `total>=2`, all `run_skill_script`, `window.PyodideWorkerPool` present, and every
  skill is `fetches_urls:false` (preflight via `getSkillFetchesUrls`). Runs
  `Promise.all` of `_executeSingleClientToolCall(..., req=>this._runViaPool(req))`,
  collects results, continues once. ANY throw → `results.length=0` → falls through
  to the sequential loop. Worker version pinned to 0.27.7 (matches runner).
- `index.html`: added `<script src="assets/js/pyodide-pool.js?v=20260608-parallel">`.
- All files pass `node --check`; pool unit tests green. Worker proven end-to-end on
  real geo-crawlers (smoke test).

**Remaining: Task 7 browser e2e only** — single-call regression, parallel geo-audit
(identical outputs, lower wall-clock), fallback drill.

---

## (superseded) STATUS (2026-06-07): PAUSED before Task 6 dispatcher wiring

**Done & verified headless:** Task 1 (gate PASSED — worker FSA persistence requires
`nativefs.syncfs()`, not `FS.syncfs(false)`); Task 4 (pool + unit tests green);
Task 3 (worker is a faithful `_runOne` port: script path, inputFiles, deps split,
cwd, `SYNERGYAI_*` env vars + group bucketing, per-mount syncfs persist); Task 5
(`_buildSkillScriptRequest` extracted); runner exports `getSkillDependencies` +
`getSkillFetchesUrls` added.

**Discovered requirements for Task 6 (refine the steps below before resuming):**
1. The real `_buildSkillScriptRequest` returns `{ dirName, script, argv, inputFiles,
   readOutputs, preInputFiles }` — NO `dependencies`/`persist`. The dispatcher MUST
   compute `dependencies = await window.pyodideRunner.getSkillDependencies(dirName)`
   on the main thread and add it to each worker payload (worker can't read SKILL.md).
2. Parallelize a round ONLY if every call is `run_skill_script` AND every skill is
   `fetches_urls:false` (check `getSkillFetchesUrls`). `fetches_urls:true` skills stay
   sequential — their prefetch rewrites argv and is main-thread-coupled. All geo
   sub-skills are `fetches_urls:false`, so geo-audit fully parallelizes.
3. KEYSTONE NOT YET DONE: the ~200 lines AFTER `runSkillScript` in
   `_executeSingleClientToolCall` (chat.js ~3406+) do result finalization — artifact
   pane, output chips, tool_result text with real disk paths, `/scratch` cleanup, and
   a FIRE-ONCE-PER-ROUND `_finalizeB3UIAfterArtifact`. To keep the parallel path
   faithful, extract this into a shared `_finalizeSkillScriptResult(call, ctx, result,
   preInputFiles, isLastInRound)` that BOTH paths call. The pool only offloads the
   Python; request-building and result-finalization both stay on the main thread.
   Mind the once-per-round UI gating under parallelism.
4. Worker payload shape: `{ ...req, dependencies, skillHandle, outputsHandle,
   prefetched: [] }` (prefetched always empty since fetches_urls:true is excluded).
   Grant readwrite on BOTH handles on the main thread before transfer.

## Task 6: Dispatcher integration — route 2+ call rounds to the pool, with fallback

Branch `dispatchClientToolCall` so a round of 2+ independent `run_skill_script` calls runs on the pool; anything else stays sequential. On ANY pool error, fall back to the existing sequential loop.

**Files:**
- Modify: `frontend/assets/js/chat.js` (the round-execution loop at ~3037–3075, inside `dispatchClientToolCall`)
- Modify: `frontend/index.html:3984` (add script tags)

- [ ] **Step 1: Add the browser worker factory + pool singleton**

Near the top of `dispatchClientToolCall`, lazily create a pool whose factory wraps a real `Worker`:

```js
// One pool per Chat instance; workers wrap pyodide.worker.js.
if (!this._pyodidePool && typeof Worker !== 'undefined' && window.PyodideWorkerPool) {
  this._pyodidePool = new window.PyodideWorkerPool({
    workerFactory: () => {
      const w = new Worker('assets/js/pyodide.worker.js');
      let seq = 0; const pending = new Map();
      w.onmessage = (e) => {
        const { id, ok, result, error } = e.data || {};
        const p = pending.get(id); if (!p) return; pending.delete(id);
        ok ? p.resolve(result) : p.reject(new Error(error));
      };
      return {
        run: (payload) => new Promise((resolve, reject) => {
          const id = ++seq; pending.set(id, { resolve, reject });
          w.postMessage({ id, verb: 'runSkillScript', payload });
        }),
        terminate: () => w.terminate(),
      };
    },
  });
}
```

- [ ] **Step 2: Detect a parallelizable round**

Before the existing sequential `for` loop (~3044), add:

```js
const allRunSkill = payload.tool_calls.every(c => c?.name === 'run_skill_script');
const parallelizable = total >= 2 && allRunSkill && this._pyodidePool;
```

- [ ] **Step 3: Build pool payloads (reuse Task 5 helper + main-thread prefetch/handles)**

When `parallelizable`, build each worker payload on the main thread (handles + prefetch stay here, per the worker contract):

```js
if (parallelizable) {
  try {
    const reqs = [];
    for (const call of payload.tool_calls) {
      const req = this._buildSkillScriptRequest(call, ctx);   // { dirName, scriptRelPath, argv, readOutputs, deps, fetchesUrls }
      const skillHandle = await window.localFs.resolvePath(`skills/${req.dirName}`);
      const outputsHandle = await window.localFs.resolvePath('outputs', { create: true });
      // Permission must be granted on the MAIN thread (workers can't prompt).
      for (const h of [skillHandle, outputsHandle]) {
        if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
            throw new Error('readwrite permission denied; cannot use worker pool');
          }
        }
      }
      const prefetched = req.fetchesUrls
        ? await window.pyodideRunner.prefetchForWorker(req.argv, req.dirName)  // see Step 4
        : [];
      reqs.push({ ...req, skillHandle, outputsHandle, prefetched });
    }
    const batch = await this._pyodidePool.runBatch(reqs);
    // Map pool results back to the sequential `results` shape used downstream.
    for (let i = 0; i < payload.tool_calls.length; i++) {
      const call = payload.tool_calls[i];
      const r = batch[i];
      const toolResultPayload = r.ok
        ? { success: r.result.exitCode === 0, stdout: r.result.stdout, stderr: r.result.stderr, outputs: r.result.outputs }
        : { success: false, error: r.error };
      results.push({ call, toolResultPayload });
    }
    return await this._continueAfterClientToolResults(payload, results, ctx, depth, mergedFollowUpExtras);
  } catch (err) {
    console.warn('[B3 dispatch] worker pool failed; falling back to sequential main-thread path:', err);
    // fall through to the existing sequential loop below
  }
}
```

- [ ] **Step 4: Expose `prefetchForWorker` on pyodideRunner**

In `pyodide-runner.js`, add a thin wrapper that returns `[{path, contents}]` instead of writing into the main-thread FS, reusing `prefetchUrlArgs`'s proxy fetch:

```js
// Like prefetchUrlArgs, but returns the materialized files for transfer to a
// worker instead of writing them into this instance's /tmp.
async function prefetchForWorker(argv, dirName) {
  const files = [];
  // ...reuse the same /fetch-url proxy loop as prefetchUrlArgs (~306-361),
  //    pushing { path: `/tmp/prefetched_<slug>.html`, contents } per URL arg...
  return files;
}
```

Add `prefetchForWorker` to the `window.pyodideRunner = { ... }` export (~1200).

- [ ] **Step 5: Add script includes**

In `frontend/index.html` right after line 3984 (`pyodide-runner.js`), add:

```html
    <script src="assets/js/pyodide-pool.js?v=20260607-parallel"></script>
```

(The worker `pyodide.worker.js` is loaded by `new Worker(...)`, not a script tag.)

- [ ] **Step 6: Syntax check**

Run: `node --check frontend/assets/js/chat.js && node --check frontend/assets/js/pyodide-runner.js`
Expected: no output (valid).

- [ ] **Step 7: Checkpoint**

Confirm a single-call round still takes the sequential path (set a breakpoint/log) and only 2+ all-`run_skill_script` rounds hit the pool branch.

---

## Task 7: End-to-end verification — geo-audit parallel vs sequential

**Files:**
- (No new source) — uses the real app + a real audit.

- [ ] **Step 1: Baseline (sequential)**

Temporarily force `parallelizable = false`. Run a full `geo-audit` for a known URL. Record: wall-clock to `GEO-CLIENT-REPORT.md`, and the set + sizes of `GEO-*-EXTRACT.md` files written.

- [ ] **Step 2: Parallel run**

Re-enable the pool branch. Run the identical audit. Record wall-clock and the output file set.

- [ ] **Step 3: Compare**

Assert: the parallel run produces the **same set of output files** with equivalent contents (a sub-skill's extract may differ only in run-timestamp lines), and `geo-report` still consolidates. Wall-clock for the multi-call rounds should be meaningfully lower (target: the 6-call domain/homepage round approaches the slowest single sub-skill rather than their sum).

Expected: identical outputs, lower wall-clock, no errors in console.

- [ ] **Step 4: Fallback drill**

Temporarily make the worker factory throw on creation. Run the audit again; confirm it transparently falls back to the sequential path and still completes (just slower) with no user-visible error.

Expected: audit completes via fallback.

- [ ] **Step 5: Cleanup + Checkpoint**

Delete `frontend/spike/`. Confirm: e2e parallel run green, fallback drill green, single-call path unchanged (Task 5), pool unit tests green (`node frontend/tests/pyodide-pool.test.mjs`).

---

## Self-Review

**Spec coverage:**
- Worker pool alongside single instance → Tasks 3,4,6. ✓
- Branch only 2+ `run_skill_script` rounds → Task 6 Step 2. ✓
- Lazy/capped/idle-reaped sizing → Task 4 (`_acquire`, `_scheduleReap`, `maxWorkers`). ✓
- Main-thread permission grant + handle transfer → Task 6 Step 3. ✓
- Per-call isolation + hard fallback → Task 4 test 3, Task 6 Step 3 catch, Task 7 Step 4. ✓
- Output-collision safety → distinct files verified in Task 1 + Task 7 Step 3 (note: explicit `_rewriteOutputsForProvider`-style namespacing only needed if two calls target the same path; geo sub-skills don't — left as a follow-up if a future skill does). ✓
- Feasibility spike gates the build → Task 1. ✓
- Testing (spike manual, pool unit, e2e) → Tasks 1,4,7. ✓

**Placeholder scan:** Task 5 Step 2 and Task 6 Step 4 intentionally reference existing source ranges ("moved verbatim from 3340..3809", "reuse the proxy loop ~306-361") rather than re-pasting hundreds of lines of the engineer's own code — the exact line ranges make these unambiguous. All *new* code is shown in full.

**Type consistency:** `_buildSkillScriptRequest` returns `{ dirName, scriptRelPath, argv, readOutputs, deps, fetchesUrls }` (Task 5) and is consumed with those exact fields in Task 6 Step 3. Worker payload adds `{ skillHandle, outputsHandle, prefetched }`; worker `runSkillScript` reads exactly those (Task 3 Step 3). Pool `runBatch` returns `{ ok, result | error }` (Task 4) consumed identically in Task 6 Step 3. Result shape `{ stdout, stderr, exitCode, outputs, durationMs }` consistent across Tasks 2,3,6.
