// Pool worker: one Pyodide instance, one verb (`runSkillScript`). Mirrors the
// per-run steps of pyodide-runner.js's `_runOne`. Handles are transferred from
// the main thread with readwrite already granted (workers cannot show the FSA
// prompt).
// MUST match pyodide-runner.js PYODIDE_VERSION so the worker behaves identically
// to the main-thread runner (event-loop/asyncio semantics differ across versions)
// and reuses the same cached Pyodide assets.
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);

let pyodide = null;
const mountedSkills = new Map();   // dirName -> mountPath
let outputsMounted = false;
const installedDeps = new Set();   // canonical dep names already installed
// NativeFS mount objects. Persisting writes to the real folders requires
// calling syncfs() on THESE objects (the value mountNativeFS returns) — the
// global pyodide.FS.syncfs does NOT cover a worker's transferred mounts.
// Confirmed by the Task 1 spike.
const flushables = [];

// Mirror of pyodide-runner.js PREBUILT_PACKAGES — the exact split rule for
// loadPackage (prebuilt) vs micropip (everything else). Must stay in sync
// with the runner so deps install identically off the main thread.
const PREBUILT_PACKAGES = new Set([
  'beautifulsoup4',
  'lxml', 'numpy', 'pandas', 'scipy', 'matplotlib',
  'pillow', 'pyyaml', 'regex', 'requests', 'pytz',
  'sqlite3', 'soupsieve', 'markupsafe', 'jinja2',
]);

// Progress reporter: logs to the worker console (surfaces in DevTools) AND
// posts a progress event so the main thread can show a per-worker timeline.
// This is the visibility that was missing — without it a slow/stuck worker
// looks like a frozen UI with no clue why.
function report(msg) {
  try { console.log('[pyodide.worker] ' + msg); } catch (_) {}
  try { self.postMessage({ type: 'progress', msg }); } catch (_) {}
}

async function ensureLoaded() {
  if (!pyodide) {
    report('loading Pyodide ' + PYODIDE_INDEX_URL + ' …');
    const t = Date.now();
    pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    report(`Pyodide ready in ${Date.now() - t}ms`);
  }
  return pyodide;
}

async function mountSkill(dirName, skillHandle) {
  if (mountedSkills.has(dirName)) return mountedSkills.get(dirName);
  const perm = await skillHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error(`skill "${dirName}" not permitted in worker`);
  const mountPath = `/skill/${dirName}`;
  pyodide.FS.mkdirTree(mountPath);
  flushables.push(await pyodide.mountNativeFS(mountPath, skillHandle));
  mountedSkills.set(dirName, mountPath);
  return mountPath;
}

async function mountOutputs(outputsHandle) {
  if (outputsMounted) return '/outputs';
  const perm = await outputsHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('outputs not permitted in worker');
  pyodide.FS.mkdirTree('/outputs');
  flushables.push(await pyodide.mountNativeFS('/outputs', outputsHandle));
  outputsMounted = true;
  return '/outputs';
}

// Mirror of pyodide-runner.js ensureDeps: loadPackage for prebuilt names,
// micropip for everything else (pinned wheels, anything not in the prebuilt
// set). Split is by PREBUILT_PACKAGES membership — NOT by `==` presence.
async function ensureDeps(deps) {
  if (!Array.isArray(deps) || deps.length === 0) return;
  const fresh = deps.filter(d => !installedDeps.has(d));
  if (fresh.length === 0) return;

  const prebuilt = fresh.filter(d => PREBUILT_PACKAGES.has(d));
  const viaMicropip = fresh.filter(d => !PREBUILT_PACKAGES.has(d));

  const tDeps = Date.now();
  report(`installing deps [${fresh.join(', ')}] …`);
  if (prebuilt.length) {
    await pyodide.loadPackage(prebuilt);
  }
  if (viaMicropip.length) {
    await pyodide.loadPackage('micropip');
    pyodide.globals.set('_runner_micropip_deps', viaMicropip);
    await pyodide.runPythonAsync(`
import micropip
for _dep in list(_runner_micropip_deps):
    await micropip.install(_dep)
    `);
  }
  for (const d of fresh) installedDeps.add(d);
  report(`deps ready in ${Date.now() - tDeps}ms`);
}

// Mirror of pyodide-runner.js ensureParentDir: create only the PARENT dirs of
// an absolute path so writeFile doesn't blow up on the leaf.
function ensureParentDir(path) {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return;
  pyodide.FS.mkdirTree(path.slice(0, idx));
}

// Mirror of pyodide-runner.js writeInput: strings → UTF-8; Uint8Array passes
// through; other typed-array views are re-viewed as Uint8Array; ArrayBuffer is
// wrapped; plain objects are coerced to pretty JSON; everything else is logged
// and skipped. The Claude-quirk recovery branches (self-keyed wrap, single-key
// wrap, string-encoded wrap) are carried over so behavior matches the runner.
function writeInput(absPath, data) {
  ensureParentDir(absPath);
  let bytes;
  if (typeof data === 'string') {
    const lowerPath = absPath.toLowerCase();
    const isJsonPath = lowerPath.endsWith('.json');
    const trimmed = data.trim();
    const looksLikeJsonObj = !isJsonPath
      && trimmed.length > 8
      && trimmed.startsWith('{')
      && trimmed.endsWith('}');
    if (looksLikeJsonObj) {
      let parsed = null;
      try { parsed = JSON.parse(data); } catch (_) {}
      if (!parsed) {
        try {
          parsed = JSON.parse(data.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
        } catch (_) {}
      }
      if (parsed && typeof parsed === 'object') {
        // Self-keyed wrap: {"<absPath>": "<body>"} — write inner string.
        if (typeof parsed[absPath] === 'string') {
          const innerBytes = new TextEncoder().encode(parsed[absPath]);
          pyodide.FS.writeFile(absPath, innerBytes);
          return;
        }
        const pkeys = Object.keys(parsed);
        if (pkeys.length === 1
          && typeof parsed[pkeys[0]] === 'string'
          && pkeys[0].startsWith('/')) {
          const innerBytes = new TextEncoder().encode(parsed[pkeys[0]]);
          pyodide.FS.writeFile(absPath, innerBytes);
          return;
        }
      }
    }
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (data !== null && typeof data === 'object') {
    // Self-keyed double-wrap: value is {<absPath>: "<content>"}.
    if (typeof data[absPath] === 'string') {
      bytes = new TextEncoder().encode(data[absPath]);
      pyodide.FS.writeFile(absPath, bytes);
      return;
    }
    const keys = Object.keys(data);
    if (keys.length === 1
      && typeof data[keys[0]] === 'string'
      && keys[0].startsWith('/')) {
      bytes = new TextEncoder().encode(data[keys[0]]);
      pyodide.FS.writeFile(absPath, bytes);
      return;
    }
    // Plain object/array → pretty JSON, dropping over-escaped `\"` first.
    try {
      const dropOverEscape = (v) => {
        if (typeof v === 'string') {
          return v.indexOf('\\"') !== -1 ? v.replace(/\\"/g, '"') : v;
        }
        if (Array.isArray(v)) return v.map(dropOverEscape);
        if (v !== null && typeof v === 'object') {
          const out = {};
          for (const [k, vv] of Object.entries(v)) out[k] = dropOverEscape(vv);
          return out;
        }
        return v;
      };
      const json = JSON.stringify(dropOverEscape(data), null, 2);
      bytes = new TextEncoder().encode(json);
    } catch (e) {
      console.error(`[pyodide.worker] writeInput: object at "${absPath}" failed JSON.stringify (${e?.message || e}); skipping`);
      return;
    }
  } else {
    const t = data === null ? 'null' : data === undefined ? 'undefined' : typeof data;
    console.error(`[pyodide.worker] writeInput: unsupported data type "${t}" for path "${absPath}"; skipping.`);
    return;
  }
  pyodide.FS.writeFile(absPath, bytes);
}

// Mirror of pyodide-runner.js readOutput: decode UTF-8; on invalid UTF-8
// return the raw bytes so binary outputs aren't corrupted; null if missing.
function readOutput(absPath) {
  let bytes;
  try {
    bytes = pyodide.FS.readFile(absPath);
  } catch {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bytes;
  }
}

// Verbatim copy of pyodide-runner.js RUN_HARNESS: sets sys.argv + cwd, exposes
// the SYNERGYAI_* env vars (so grouped skills self-bucket outputs identically),
// runs the script as __main__, captures stdout/stderr, and translates
// SystemExit / exceptions to an exit code. Reads globals _runner_argv,
// _runner_script, _runner_cwd, _runner_env_{dir_name,group,out_dir}; writes
// _runner_{stdout,stderr,exit}. Keep in sync with the runner.
const RUN_HARNESS = `
import os, sys, runpy, io, traceback

_argv = list(_runner_argv)
_script = str(_runner_script)
_cwd = str(_runner_cwd)

_env_dir_name = str(_runner_env_dir_name)
_env_group    = str(_runner_env_group)
_env_out_dir  = str(_runner_env_out_dir)

_saved_argv = sys.argv
_saved_cwd = os.getcwd()
_saved_stdout = sys.stdout
_saved_stderr = sys.stderr
_saved_dir_name = os.environ.get('SYNERGYAI_SKILL_DIR_NAME')
_saved_group    = os.environ.get('SYNERGYAI_SKILL_GROUP')
_saved_out_dir  = os.environ.get('SYNERGYAI_OUTPUT_DIR')
_stdout_buf = io.StringIO()
_stderr_buf = io.StringIO()
_runner_exit = 0

def _restore_env(name, val):
    if val is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = val

try:
    sys.argv = [_script] + _argv
    os.chdir(_cwd)
    sys.stdout = _stdout_buf
    sys.stderr = _stderr_buf
    os.environ['SYNERGYAI_SKILL_DIR_NAME'] = _env_dir_name
    os.environ['SYNERGYAI_SKILL_GROUP']    = _env_group
    os.environ['SYNERGYAI_OUTPUT_DIR']     = _env_out_dir
    try:
        runpy.run_path(_script, run_name='__main__')
    except SystemExit as e:
        if isinstance(e.code, int):
            _runner_exit = e.code
        elif e.code is None:
            _runner_exit = 0
        else:
            print(e.code, file=sys.stderr)
            _runner_exit = 1
    except BaseException:
        traceback.print_exc()
        _runner_exit = 1
finally:
    sys.argv = _saved_argv
    os.chdir(_saved_cwd)
    sys.stdout = _saved_stdout
    sys.stderr = _saved_stderr
    _restore_env('SYNERGYAI_SKILL_DIR_NAME', _saved_dir_name)
    _restore_env('SYNERGYAI_SKILL_GROUP',    _saved_group)
    _restore_env('SYNERGYAI_OUTPUT_DIR',     _saved_out_dir)

_runner_stdout = _stdout_buf.getvalue()
_runner_stderr = _stderr_buf.getvalue()
`;

// payload: { dirName, script, argv, inputFiles, readOutputs, dependencies,
//            persist } — the object produced by chat.js _buildSkillScriptRequest
// and consumed by pyodide-runner.js _runOne — plus three transport extras the
// main thread adds: { skillHandle, outputsHandle, prefetched }.
// `prefetched` is an optional array of { path, contents } the main thread
// fetched via the backend proxy (workers do not call the URL proxy — keep
// network on the main thread for one consistent fetch path).
// (`preInputFiles` from the main-thread call site is intentionally ignored.)
async function runSkillScript(payload) {
  const t0 = Date.now();
  await ensureLoaded();

  // Skills fetch through the same-origin backend proxy and read its auth token
  // via `from js import window` -> window.authManager.token. A worker has no
  // `window`, so expose a minimal shim with the token the main thread passed in.
  // Without it the proxy POST is unauthenticated (401) and fetches return HTTP 0
  // ("site unreachable") even though the site is fine.
  globalThis.window = globalThis.window || globalThis;
  globalThis.window.authManager = { token: payload.authToken || null };

  const mount = await mountSkill(payload.dirName, payload.skillHandle);
  await mountOutputs(payload.outputsHandle);

  // Materialize any prefetched URL content into /tmp (mirrors main-thread prefetch).
  for (const f of (payload.prefetched || [])) {
    pyodide.FS.mkdirTree('/tmp');
    pyodide.FS.writeFile(f.path, f.contents);
  }

  // Install deps (loadPackage for prebuilt; micropip for the rest).
  await ensureDeps(payload.dependencies);

  // Resolve a caller-supplied path: absolute paths (starting with `/`) pass
  // through verbatim; relative paths resolve against the skill mount (the cwd
  // of the running script). Mirrors _runOne's `resolveAbs`.
  const resolveAbs = (p) => p.startsWith('/') ? p : `${mount}/${p}`;

  // Write inputFiles into the FS BEFORE running. Tolerate the JSON-encoded-
  // string form the way _runOne does before iterating entries.
  let inputFilesObj = payload.inputFiles;
  if (typeof inputFilesObj === 'string') {
    try {
      inputFilesObj = JSON.parse(inputFilesObj);
    } catch (e) {
      console.error('[pyodide.worker] input_files is a string but not valid JSON; skipping all input file writes:', e?.message || e);
      inputFilesObj = null;
    }
  }
  if (inputFilesObj && typeof inputFilesObj === 'object') {
    for (const [rel, data] of Object.entries(inputFilesObj)) {
      try {
        writeInput(resolveAbs(rel), data);
      } catch (e) {
        console.error(`[pyodide.worker] writeInput threw for ${rel}:`, e?.message || e, 'data type:', typeof data);
      }
    }
  }

  // Output bucketing, mirroring _runOne (pyodide-runner.js:1010-1023): a
  // grouped skill (dirName like "GEO/geo-crawlers") buckets its outputs into
  // /outputs/<group>; pre-create that dir so scripts can write into it.
  const envGroup = (typeof payload.dirName === 'string' && payload.dirName.includes('/'))
    ? payload.dirName.split('/')[0]
    : '';
  const envOutDir = (envGroup && /^[A-Za-z0-9._-]+$/.test(envGroup))
    ? `/outputs/${envGroup}`
    : '/outputs';
  if (envGroup) { try { pyodide.FS.mkdir(envOutDir); } catch (_) {} }

  // Globals consumed by RUN_HARNESS. Script path resolves exactly as _runOne:
  // `${mount}/${script}` (= `/skill/<dirName>/<script>`), cwd = skill mount,
  // argv as a real Python list, plus the SYNERGYAI_* env values.
  pyodide.globals.set('_runner_argv', pyodide.toPy(payload.argv || []));
  pyodide.globals.set('_runner_script', `${mount}/${payload.script}`);
  pyodide.globals.set('_runner_cwd', mount);
  pyodide.globals.set('_runner_env_dir_name', payload.dirName || '');
  pyodide.globals.set('_runner_env_group', envGroup);
  pyodide.globals.set('_runner_env_out_dir', envOutDir);

  report(`running ${payload.dirName}/${payload.script} [${(payload.argv || []).join(' ')}] …`);
  const tRun = Date.now();
  await pyodide.runPythonAsync(RUN_HARNESS);
  const exit = pyodide.globals.get('_runner_exit') ?? 0;
  report(`script finished in ${Date.now() - tRun}ms (exit ${exit})`);

  // Persist every NativeFS mount (incl. /outputs) back to the real folders on
  // disk by calling syncfs() on each mount object. Without this the script's
  // writes live only in the worker's in-memory FS and never reach the user's
  // disk (proven by the Task 1 spike — the global FS.syncfs does not suffice).
  if (payload.persist !== false) {
    for (const fs of flushables) await fs.syncfs();
  }

  const stdout = pyodide.globals.get('_runner_stdout') ?? '';
  const stderr = pyodide.globals.get('_runner_stderr') ?? '';

  const outputs = {};
  for (const rel of (payload.readOutputs || [])) {
    let val = readOutput(resolveAbs(rel));
    // Grouped skills bucket their writes into /outputs/<group>/ (via
    // SYNERGYAI_OUTPUT_DIR), but the model's read_outputs frequently points at
    // /outputs/<file> WITHOUT the group. When the plain path is missing, retry
    // inside the group bucket and return it under the key the model asked for —
    // otherwise the model sees its output as "missing", assumes the run failed,
    // and re-runs the whole skill in a loop (the exact failure we diagnosed).
    if (val == null && envGroup && rel.startsWith('/outputs/')
        && !rel.startsWith(`/outputs/${envGroup}/`)) {
      const bucketed = rel.replace('/outputs/', `/outputs/${envGroup}/`);
      const alt = readOutput(bucketed);
      if (alt != null) {
        report(`output ${rel} found in group bucket → ${bucketed}`);
        val = alt;
      }
    }
    outputs[rel] = val;
  }

  // Platform safety net: surface the files the script ACTUALLY wrote, even when
  // the model set NO read_outputs (or guessed the wrong filename). Skill scripts
  // announce writes to stdout/stderr as `wrote <path>` (e.g. `[geo-content] … —
  // wrote /outputs/GEO/GEO-CONTENT-EXTRACT.md`). Read those back so the model
  // always has concrete proof its deliverable exists on disk and never re-runs a
  // skill that already succeeded. Additive — never overwrites a model-requested
  // key, and capped so a chatty script can't blow up the result.
  const writtenRe = /\bwrote\s+(\/[^\s'"]+\.[A-Za-z0-9]+)/g;
  let wroteCount = 0;
  for (const src of [stderr, stdout]) {
    let m;
    while ((m = writtenRe.exec(src)) !== null && wroteCount < 12) {
      const p = m[1];
      if (!(p in outputs)) {
        const v = readOutput(p);
        if (v != null) { outputs[p] = v; wroteCount++; report(`auto-surfaced written output ${p}`); }
      }
    }
  }

  return {
    stdout: pyodide.globals.get('_runner_stdout') ?? '',
    stderr: pyodide.globals.get('_runner_stderr') ?? '',
    exitCode: pyodide.globals.get('_runner_exit') ?? 0,
    outputs,
    durationMs: Date.now() - t0,
  };
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
