# Backend URL Single-Source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every frontend→backend call through one runtime-configurable base URL so the backend can be repointed (to a TS/Java/Python reimplementation) by changing a single value.

**Architecture:** A new browser script `api-config.js` resolves the backend base URL once (explicit `localStorage` override → per-host map → relative default) and exposes `window.APP_CONFIG.API_BASE_URL` plus a join helper `window.apiUrl(path)`. All ~17 modules that currently hardcode `/gpt/backend/api/v1` (66 occurrences) are refactored to read from it. A deterministic codemod performs the bulk string rewrite; an exact grep gate proves zero literals remain.

**Tech Stack:** Plain ES (no bundler) loaded via `<script>` tags as globals; Node 22 `node:test` for the resolver unit test; Playwright for the browser smoke test (already in `frontend/package.json`).

**Scope note:** This plan covers **Part A** of `docs/superpowers/specs/2026-06-29-backend-decoupling-design.md` only. **Part B** (the OpenAPI contract + contract-test suite) is a separate plan written next.

## Global Constraints

- **No build step.** Files are loaded via `<script src>` and communicate through `window` globals — no `import`/`export` in browser-loaded files.
- **Single source of truth:** after this plan, the string `/gpt/backend` must appear in exactly one file: `frontend/assets/js/api-config.js`. This is the acceptance gate.
- **Default behavior preserved:** with no override and an unknown host, the resolved base must remain `/gpt/backend/api/v1` (the current relative path), so existing localhost/XAMPP usage is unchanged.
- **Opaque base string:** the base may be relative (`/gpt/backend/api/v1`) or absolute (`https://host/v1`); no code may assume one form.
- **Load order:** `api-config.js` must load before `config.js` and before any feature module on every HTML entry page.

---

## File Structure

- Create: `frontend/assets/js/api-config.js` — the only place the base URL and the `/gpt/backend` default live. Exposes `window.APP_CONFIG.API_BASE_URL` + `window.apiUrl(path)`; also exports a pure `resolveApiBase()` for Node testing.
- Create: `frontend/tests/api-config.resolver.test.mjs` — Node unit test for `resolveApiBase()`.
- Create: `frontend/tests/api-config.browser.spec.ts` — Playwright test: globals are set, and intercepted requests target the configured base (incl. an override case).
- Create (not committed): `<scratchpad>/codemod-api-base.mjs` — one-time deterministic rewriter for inline literals.
- Modify (HTML entry, add one `<script>` line each): `index.html`, `login.html`, `register.html`, `workflow-editor-test.html`, `test-gemini-realtime-tools.html`, `test-grok-realtime-tools.html`.
- Modify (per-class base defs → read global): `assets/js/auth.js:14`, `assets/js/mcp-client.js:10`, `assets/js/file-storage.js:9`, `assets/js/settings-panel.js:14`.
- Modify (broken `window.CONFIG` → `window.APP_CONFIG`): `assets/js/gemini-realtime-adapter.js:290`, `assets/js/workflow-realtime-runner.js:387`, `assets/js/workflow-editor.js:27`.
- Modify (inline literals via codemod): `chat.js` (34), `agent-teams-panel.js` (11), `settings-panel.js` (2 remaining), `voice-panel.js` (2), `pyodide-runner.js` (2), `grok-realtime-adapter.js` (2), `gemini-realtime-adapter.js` (1 remaining), `voice-dictation.js` (1), `skills-manager.js` (1), `heal-panel.js` (1), `grok-live-client.js` (1), `gemini-live-client.js` (1), and any inline literal left in the base-def files.

All paths below are relative to `/Applications/XAMPP/xamppfiles/htdocs/gpt/frontend`.

---

### Task 1: Create `api-config.js` with a tested pure resolver

**Files:**
- Create: `assets/js/api-config.js`
- Test: `tests/api-config.resolver.test.mjs`

**Interfaces:**
- Produces (browser globals): `window.APP_CONFIG.API_BASE_URL` (string), `window.apiUrl(path: string): string`.
- Produces (Node, for tests only): `resolveApiBase({ override, hostname, byHost, fallback }): string` and `makeApiUrl(base): (path) => string`, available via `globalThis.__API_CONFIG_TEST__` when not in a browser.

- [ ] **Step 1: Write the failing test**

Create `tests/api-config.resolver.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load api-config.js in a non-browser context; it must expose test hooks.
const path = fileURLToPath(new URL('../assets/js/api-config.js', import.meta.url));
globalThis.window = undefined;            // ensure browser branch is skipped
new Function(readFileSync(path, 'utf8'))();
const { resolveApiBase, makeApiUrl } = globalThis.__API_CONFIG_TEST__;

const BY_HOST = { 'localhost': '/gpt/backend/api/v1', 'synergyaichat.com': 'https://api.synergyaichat.com/v1' };
const FALLBACK = '/gpt/backend/api/v1';

test('override wins over everything', () => {
  assert.equal(
    resolveApiBase({ override: 'http://localhost:3000/v1', hostname: 'synergyaichat.com', byHost: BY_HOST, fallback: FALLBACK }),
    'http://localhost:3000/v1');
});

test('known host maps to its base', () => {
  assert.equal(
    resolveApiBase({ override: null, hostname: 'synergyaichat.com', byHost: BY_HOST, fallback: FALLBACK }),
    'https://api.synergyaichat.com/v1');
});

test('unknown host falls back to relative default', () => {
  assert.equal(
    resolveApiBase({ override: null, hostname: 'example.test', byHost: BY_HOST, fallback: FALLBACK }),
    '/gpt/backend/api/v1');
});

test('apiUrl joins base and path with exactly one slash', () => {
  const apiUrl = makeApiUrl('/gpt/backend/api/v1');
  assert.equal(apiUrl('/chat'), '/gpt/backend/api/v1/chat');
  assert.equal(apiUrl('chat'), '/gpt/backend/api/v1/chat');
});

test('apiUrl works with an absolute base', () => {
  const apiUrl = makeApiUrl('https://api.host/v1');
  assert.equal(apiUrl('/chat'), 'https://api.host/v1/chat');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/api-config.resolver.test.mjs`
Expected: FAIL — `assets/js/api-config.js` does not exist / `__API_CONFIG_TEST__` undefined.

- [ ] **Step 3: Write the implementation**

Create `assets/js/api-config.js`:

```js
/**
 * Backend base-URL single source of truth.
 * THE ONLY FILE that may contain the "/gpt/backend" default.
 * Repoint the whole app at another backend by changing the BY_HOST map,
 * or for a quick test: localStorage.setItem('API_BASE_URL', 'http://localhost:3000/v1'); location.reload();
 */
(function () {
  function resolveApiBase({ override, hostname, byHost, fallback }) {
    return override || byHost[hostname] || fallback;
  }
  function makeApiUrl(base) {
    return (path) => base + (String(path).startsWith('/') ? path : '/' + path);
  }

  var FALLBACK = '/gpt/backend/api/v1';
  var BY_HOST = {
    'localhost': '/gpt/backend/api/v1',
    '127.0.0.1': '/gpt/backend/api/v1',
    // Add real deployment hosts here, e.g.:
    // 'synergyaichat.com': 'https://api.synergyaichat.com/v1',
  };

  // Non-browser (Node test) context: expose pure helpers and stop.
  if (typeof window === 'undefined') {
    globalThis.__API_CONFIG_TEST__ = { resolveApiBase: resolveApiBase, makeApiUrl: makeApiUrl };
    return;
  }

  var override = null;
  try { override = localStorage.getItem('API_BASE_URL'); } catch (e) { override = null; }

  var base = resolveApiBase({
    override: override,
    hostname: location.hostname,
    byHost: BY_HOST,
    fallback: FALLBACK,
  });

  window.APP_CONFIG = window.APP_CONFIG || {};
  window.APP_CONFIG.API_BASE_URL = base;
  window.apiUrl = makeApiUrl(base);

  console.log('[api-config] backend base =', base);
})();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/api-config.resolver.test.mjs`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add assets/js/api-config.js tests/api-config.resolver.test.mjs
git commit -m "feat(frontend): add api-config.js single-source backend base URL"
```

---

### Task 2: Wire `api-config.js` into HTML entry pages

**Files:**
- Modify: `index.html`, `login.html`, `register.html`, `workflow-editor-test.html`, `test-gemini-realtime-tools.html`, `test-grok-realtime-tools.html`
- Test: `tests/api-config.browser.spec.ts`

**Interfaces:**
- Consumes: `window.apiUrl`, `window.APP_CONFIG.API_BASE_URL` from Task 1.

- [ ] **Step 1: Write the failing Playwright test**

Create `tests/api-config.browser.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('globals are set on index.html', async ({ page }) => {
  await page.goto('/gpt/frontend/index.html');
  const base = await page.evaluate(() => (window as any).APP_CONFIG?.API_BASE_URL);
  expect(base).toBe('/gpt/backend/api/v1');           // localhost default
  const joined = await page.evaluate(() => (window as any).apiUrl('/chat'));
  expect(joined).toBe('/gpt/backend/api/v1/chat');
});

test('localStorage override repoints apiUrl', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('API_BASE_URL', 'http://alt.test/v1'));
  await page.goto('/gpt/frontend/index.html');
  const joined = await page.evaluate(() => (window as any).apiUrl('/chat'));
  expect(joined).toBe('http://alt.test/v1/chat');
});
```

Confirm `playwright.config.ts` has a `baseURL` of `http://localhost` (XAMPP). If absent, add `use: { baseURL: 'http://localhost' }`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/api-config.browser.spec.ts`
Expected: FAIL — `APP_CONFIG.API_BASE_URL` is undefined (script not yet included).

- [ ] **Step 3: Add the script tag to each entry page**

In each of the 6 HTML files, add this line **before** the `config.js` script and before any `assets/js/*` feature module:

```html
<script src="assets/js/api-config.js"></script>
```

Find the existing `<script src="assets/js/config.js"></script>` (or the first `assets/js` script) and insert the new line immediately above it. For `index.html`, place it just before the first `assets/js/` script in `<head>`/top of `<body>` script block.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test tests/api-config.browser.spec.ts`
Expected: PASS — both tests pass.

- [ ] **Step 5: Commit**

```bash
git add index.html login.html register.html workflow-editor-test.html test-gemini-realtime-tools.html test-grok-realtime-tools.html tests/api-config.browser.spec.ts
git commit -m "feat(frontend): load api-config.js first on all entry pages"
```

---

### Task 3: Fix per-class base defs and broken `window.CONFIG` reads

These 7 sites are hand-edited (not codemod'd) because they set or read a *base*, not a path.

**Files:**
- Modify: `assets/js/auth.js:14`, `assets/js/mcp-client.js:10`, `assets/js/file-storage.js:9`, `assets/js/settings-panel.js:14`
- Modify: `assets/js/gemini-realtime-adapter.js:290`, `assets/js/workflow-realtime-runner.js:387`, `assets/js/workflow-editor.js:27`

- [ ] **Step 1: Confirm the sites still exist (pre-edit check)**

Run: `grep -nE "this\.apiBase(Url)?\s*=\s*'/gpt/backend|window\.CONFIG\?\.API_BASE_URL" assets/js/*.js`
Expected: 7 lines listed (the 4 base defs + 3 broken reads).

- [ ] **Step 2: Edit the 4 per-class base defs**

In each file, replace the literal assignment with a read from the global. The literal text to find is identical in all four:

Find: `this.apiBaseUrl = '/gpt/backend/api/v1';`
Replace: `this.apiBaseUrl = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || '/gpt/backend/api/v1';`

Apply in `auth.js`, `mcp-client.js`, `file-storage.js`, `settings-panel.js`.

> The `|| '/gpt/backend/api/v1'` here is a defensive fallback that keeps the module working if loaded on a page that forgot the script. It is the one *allowed* exception to the single-literal rule because it is a same-value safety net; the grep gate in Task 5 excludes these four lines explicitly. If you prefer zero exceptions, drop the fallback and rely on load order — but then Task 5's gate has no exclusions.

- [ ] **Step 3: Edit the 3 broken `window.CONFIG` reads**

`window.CONFIG` is never defined; `config.js` sets `window.APP_CONFIG`. Fix the global name.

`gemini-realtime-adapter.js:290` and `workflow-realtime-runner.js:387` — change `window.CONFIG?.API_BASE_URL` to `window.APP_CONFIG?.API_BASE_URL`.

`workflow-editor.js:27` — change:
Find: `this.apiBase = window.CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';`
Replace: `this.apiBase = window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';`

- [ ] **Step 4: Verify**

Run: `grep -rnE "window\.CONFIG\?\.API_BASE_URL" assets/js/*.js`
Expected: no matches.
Run: `npx playwright test tests/api-config.browser.spec.ts`
Expected: PASS (still green; no behavior change on localhost).

- [ ] **Step 5: Commit**

```bash
git add assets/js/auth.js assets/js/mcp-client.js assets/js/file-storage.js assets/js/settings-panel.js assets/js/gemini-realtime-adapter.js assets/js/workflow-realtime-runner.js assets/js/workflow-editor.js
git commit -m "refactor(frontend): read backend base from window.APP_CONFIG; fix broken window.CONFIG reads"
```

---

### Task 4: Codemod the inline path literals

A deterministic two-pass rewriter handles the remaining inline literals (quoted → `window.apiUrl('...')`; template-literal → `${window.APP_CONFIG.API_BASE_URL}`). Quoted-string occurrences contain no `${}` interpolation, so the regex is safe.

**Files:**
- Create (scratchpad, not committed): codemod script
- Modify: all `assets/js/*.js` files listed in File Structure that still contain inline literals after Task 3.

- [ ] **Step 1: Confirm the remaining literal count (pre-edit check)**

Run: `grep -rohE "/gpt/backend/api/v1" assets/js/*.js | wc -l`
Expected: a positive number (~59 — the original 66 minus the 4 base defs and minus literals already removed/kept; exact number is whatever grep reports now). Record it as N.

- [ ] **Step 2: Write the codemod**

Create the script at the scratchpad path `<scratchpad>/codemod-api-base.mjs` (substitute the real scratchpad dir):

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';     // Node 22 supports fs.globSync

const ROOT = '/Applications/XAMPP/xamppfiles/htdocs/gpt/frontend/assets/js';
const LIT = '/gpt/backend/api/v1';

// Files to skip: the single-source file, and the 4 base-def lines (kept as
// defensive fallbacks). We skip api-config.js entirely; base-def fallbacks are
// left intact because they are `... || '/gpt/backend/api/v1'`, which the
// quoted-string regex below would otherwise rewrite — so we guard them.
const SKIP_FILES = new Set(['api-config.js']);

// Pass 1: quoted strings  '...LIT.../x'  or  "...LIT.../x"  →  window.apiUrl('/x')
//   but NOT when preceded by `|| ` (the base-def fallback).
const quoted = /(^|[^|])(['"])\/gpt\/backend\/api\/v1((?:(?!\2).)*)\2/g;

// Pass 2: any remaining LIT is inside a backtick template literal → ${...}
function rewrite(src) {
  let out = src.replace(quoted, (m, pre, q, rest) => `${pre}window.apiUrl(${q}${rest || '/'}${q})`);
  // restore: if rest was empty we used '/', but empty path shouldn't occur inline; guard anyway
  out = out.split(LIT).join('${window.APP_CONFIG.API_BASE_URL}');
  return out;
}

for (const file of globSync(`${ROOT}/*.js`)) {
  const name = file.split('/').pop();
  if (SKIP_FILES.has(name)) continue;
  const src = readFileSync(file, 'utf8');
  if (!src.includes(LIT)) continue;
  const next = rewrite(src);
  if (next !== src) writeFileSync(file, next);
}
console.log('codemod done');
```

> Note: the `(^|[^|])` guard prevents rewriting the `|| '/gpt/backend/api/v1'` base-def fallbacks from Task 3. Verify by inspection after running.

- [ ] **Step 3: Run the codemod and inspect the diff**

Run: `node <scratchpad>/codemod-api-base.mjs && git -C /Applications/XAMPP/xamppfiles/htdocs/gpt diff --stat frontend/assets/js`
Expected: the ~17 inline-literal files show as modified. Visually scan `git diff frontend/assets/js/chat.js` to confirm rewrites look like `fetch(window.apiUrl('/chat'), {` and `` `${window.APP_CONFIG.API_BASE_URL}/mcp/app?...` ``.

- [ ] **Step 4: Verify the gate (zero inline literals outside allowed sites)**

Run:
```bash
grep -rnE "/gpt/backend" assets/js/*.js | grep -v "assets/js/api-config.js" | grep -vE "\|\| '/gpt/backend/api/v1'"
```
Expected: **no output** (every remaining `/gpt/backend` is either in `api-config.js` or a guarded base-def fallback).

- [ ] **Step 5: Run all tests**

Run: `node --test tests/api-config.resolver.test.mjs && npx playwright test tests/api-config.browser.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add assets/js/*.js
git commit -m "refactor(frontend): route inline backend URLs through window.apiUrl"
```

---

### Task 5: Full verification gate

**Files:** none modified — this task is the acceptance check.

- [ ] **Step 1: Acceptance grep — the single-source guarantee**

Run:
```bash
grep -rn "/gpt/backend" assets/js/*.js | grep -v "assets/js/api-config.js" | grep -vE "\|\| '/gpt/backend/api/v1'"
```
Expected: **no output.** This is the plan's definition of done: the only unguarded `/gpt/backend` lives in `api-config.js`.

- [ ] **Step 2: Manual smoke against the real backend (override path)**

In a browser at `http://localhost/gpt/frontend/index.html`, open DevTools console:
```js
localStorage.setItem('API_BASE_URL', '/gpt/backend/api/v1'); location.reload();
```
Log in, send a chat message (confirm SSE streams), open Settings, open a prompt list. Then in the Network tab confirm requests target `/gpt/backend/api/v1/...`. Expected: app works exactly as before.

- [ ] **Step 3: Manual smoke — redirection proof**

In console:
```js
localStorage.setItem('API_BASE_URL', 'http://localhost:9999/v1'); location.reload();
```
Reload; in the Network tab confirm requests now go to `http://localhost:9999/v1/...` (they will fail — no server there — which proves redirection works from the single switch). Then clear it: `localStorage.removeItem('API_BASE_URL'); location.reload();`.

- [ ] **Step 4: Run the full automated suite**

Run: `node --test tests/api-config.resolver.test.mjs && npx playwright test tests/api-config.browser.spec.ts`
Expected: PASS.

- [ ] **Step 5: Final commit (if any doc/notes changed)**

```bash
git add -A
git commit -m "test(frontend): verify backend URL single-source decoupling" --allow-empty
```

---

## Self-Review

**Spec coverage (Part A of the design doc):**
- §4.1 `api-config.js` resolver (override → host map → default) → Task 1. ✓
- §4.1 `window.apiUrl` join helper, relative & absolute bases → Task 1 tests. ✓
- §4.2 refactor per-class bases → Task 3; broken `window.CONFIG` reads → Task 3; inline literals → Task 4; script wired into entry HTML → Task 2. ✓
- §4.2 success criterion "zero `/gpt/backend` outside api-config.js" → Task 5 Step 1. ✓
- §4.3 cross-origin caveats → documentation only (in the spec), no code here. ✓ (out of scope by design)
- Part B (OpenAPI contract, CONVENTIONS.md, contract tests) → explicitly deferred to a separate plan. ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases". The one `<scratchpad>` token is a real path the executor substitutes (the session scratchpad dir). The "~59 / record as N" in Task 4 Step 1 is an observed count, not a placeholder — the gate in Step 4 is exact.

**Type/name consistency:** `resolveApiBase({override, hostname, byHost, fallback})`, `makeApiUrl(base)`, `window.APP_CONFIG.API_BASE_URL`, `window.apiUrl(path)` are used identically in Tasks 1–4. The test hook `globalThis.__API_CONFIG_TEST__` matches between `api-config.js` and the resolver test.

**Known residue (intentional):** the 4 guarded base-def fallbacks `... || '/gpt/backend/api/v1'` retain the literal as a same-value safety net and are excluded from the gate. To enforce literally one occurrence, drop those fallbacks in Task 3 and remove the `grep -vE` exclusion everywhere.

---

## Implementation Outcome (2026-06-29)

Executed in place, no commits (repo owner commits separately). All changes are unstaged in the working tree.

**Deviations / additions discovered during execution:**

1. **`config.js` clobber bug (found by the browser test).** `config.js` ended with `window.APP_CONFIG = CONFIG`, which *reassigned* the global and wiped the `API_BASE_URL` that `api-config.js` had set (config.js loads after it). Fixed by merging instead: `window.APP_CONFIG = Object.assign(window.APP_CONFIG || {}, CONFIG)` in both `config.js` and `config.example.js`. Without this, every module reading `window.APP_CONFIG.API_BASE_URL` would have silently fallen back to the hardcoded default.

2. **Codemod regex corrected.** The planned `(^|[^|])` guard would not have protected the `|| '/gpt/backend/api/v1'` fallbacks (a space precedes the quote). Replaced with a *trailing-slash* distinction: only literals followed by a path (`/gpt/backend/api/v1/...`) are rewritten; bare base literals (guarded fallbacks, host-map values) are left untouched. 54 substitutions across 10 files.

3. **Inline-HTML scripts were out of the original File Structure but needed the same treatment.** Converted hardcoded fetches/bases in `payment.html`, `register.html`, `workflow-editor-test.html`, `test-grok-realtime-tools.html`; removed the now-dead `window.CONFIG` harness in `workflow-editor-test.html` (nothing reads `window.CONFIG` anymore — verified zero occurrences frontend-wide).

4. **Entry-page coverage widened from 6 to 8.** `payment.html` and `test-realtime-runner.html` load refactored modules (which now call `window.apiUrl`) and were missing the script — both wired. A page loading a `window.apiUrl` module without `api-config.js` would throw at runtime; a coverage check confirms all such pages now load it first.

5. **Bare base-URL bindings** (`const API = '...'`, constructor args in `heal-panel.js`, `skills-manager.js`, `chat.js`) converted to the guarded-fallback form (they are bases, not paths, so the codemod correctly skipped them).

**Documented exceptions (intentionally not changed):**
- `spike/ingestion-pyodide-spike.worker.js:52` — a Web Worker (no `window`/`api-config.js`); redirecting it needs the base passed via `postMessage`. Throwaway experiment; left as a same-origin relative fetch.
- `pyodide-runner.js:270` — a code comment documenting the PHP route; not executable.

**Verification (all green):**
- `node --test tests/api-config.resolver.test.mjs` → 5/5
- `npx playwright test tests/e2e/api-config.browser.spec.ts` → 2/2 (globals set; localStorage override repoints `apiUrl`)
- `node --check` on all 19 modified JS files → OK
- Acceptance grep → only the two documented exceptions remain; zero `window.CONFIG` frontend-wide.

**Not done (manual, needs a logged-in session):** live click-through of login + chat SSE streaming against the real backend. The structural proof (served script order) and the override-redirection proof (Playwright) pass; a human should still eyeball one real chat stream.
