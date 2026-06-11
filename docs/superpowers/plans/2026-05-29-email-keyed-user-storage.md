# Email-keyed User Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single flat `localStorage['user']` key in `/gpt/frontend` with an email-keyed `access` map plus an `activeEmail` pointer, so several email accounts can coexist on one browser without clobbering each other.

**Architecture:** A new plain-global module `assets/js/account-store.js` owns all reads/writes of `access` / `activeEmail` / session tokens. Every existing `localStorage['user']` call site routes through it. One active session at a time (switching accounts = logging in again). The shared passkey (`webauthn_credential_id`) and the backend are unchanged.

**Tech Stack:** Vanilla browser JS (non-module `<script>` globals, cache-busted by `?v=`), HTML inline scripts, Node + `node:assert` + `node:vm` for a dependency-free unit test of the store module.

> **Note on git:** `/gpt` is NOT a git repository. The `Commit` steps below assume one will be initialized (`cd /Applications/XAMPP/xamppfiles/htdocs/gpt && git init`) or are otherwise skipped. They are kept for discipline; adapt to the team's VCS.

> **Note on the sandbox:** new files under `/gpt` are outside the agent's primary working directory. Create/edit them with the Edit/Write tools where the file already exists; for brand-new files, write via Bash with the sandbox disabled (see project memory `feedback_sandbox_writes`).

---

### Task 1: Create the `account-store.js` module (TDD)

**Files:**
- Create: `/Applications/XAMPP/xamppfiles/htdocs/gpt/frontend/assets/js/account-store.js`
- Test:   `/Applications/XAMPP/xamppfiles/htdocs/gpt/frontend/tests/account-store.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/account-store.test.mjs`:

```js
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Minimal localStorage shim shared via globalThis (account-store.js reads the
// global `localStorage` and, when `window` is undefined, attaches to globalThis).
function freshStore() {
  const data = {};
  globalThis.localStorage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    clear: () => { for (const k of Object.keys(data)) delete data[k]; },
  };
  return data;
}

function loadModule() {
  const code = readFileSync(new URL('../assets/js/account-store.js', import.meta.url), 'utf8');
  vm.runInThisContext(code);
  return globalThis.accountStore;
}

// 1. setActiveAccount writes access[email], activeEmail, token
let data = freshStore();
let store = loadModule();
const userA = { id: 1, email: 'A@X.com', plan: 'free', provider: 'email' };
assert.strictEqual(store.setActiveAccount(userA, 'tokA', 'refA'), true);
assert.strictEqual(store.getActiveEmail(), 'a@x.com', 'email normalized to lowercase');
assert.deepStrictEqual(store.getActiveUser(), userA);
assert.strictEqual(store.getToken(), 'tokA');
assert.strictEqual(store.getRefreshToken(), 'refA');

// 2. A second account coexists; first is retained
const userB = { id: 7, email: 'b@y.com', plan: 'premium', provider: 'google' };
store.setActiveAccount(userB, 'tokB');
assert.strictEqual(store.getActiveEmail(), 'b@y.com');
assert.deepStrictEqual(store.getActiveUser(), userB);
const access = JSON.parse(globalThis.localStorage.getItem('access'));
assert.ok(access['a@x.com'] && access['b@y.com'], 'both accounts cached');

// 3. updateActiveUser merges into the active entry only
store.updateActiveUser({ plan: 'standard' });
assert.strictEqual(store.getActiveUser().plan, 'standard');
assert.strictEqual(JSON.parse(globalThis.localStorage.getItem('access'))['a@x.com'].plan, 'free', 'other account untouched');

// 4. clearActiveAccount drops session but keeps the cache
store.clearActiveAccount();
assert.strictEqual(store.getActiveEmail(), null);
assert.strictEqual(store.getActiveUser(), null);
assert.strictEqual(store.getToken(), null);
assert.ok(JSON.parse(globalThis.localStorage.getItem('access'))['b@y.com'], 'cache retained after logout');

// 5. setActiveAccount with no email is rejected (no undefined key written)
assert.strictEqual(store.setActiveAccount({ id: 9 }, 'tok'), false);

// 6. Migration: legacy 'user' key becomes access[email] + activeEmail, legacy key removed
data = freshStore();
globalThis.localStorage.setItem('user', JSON.stringify({ id: 3, email: 'Legacy@Z.com' }));
globalThis.localStorage.setItem('token', 'legacyTok');
store = loadModule();
assert.strictEqual(store.migrateLegacyUser(), true);
assert.strictEqual(store.getActiveEmail(), 'legacy@z.com');
assert.strictEqual(store.getActiveUser().id, 3);
assert.strictEqual(store.getToken(), 'legacyTok', 'session preserved across migration');
assert.strictEqual(globalThis.localStorage.getItem('user'), null, 'legacy key removed');

// 7. Migration is a no-op when access already exists
assert.strictEqual(store.migrateLegacyUser(), false);

// 8. Corrupt access JSON => treated as empty, never throws
data = freshStore();
globalThis.localStorage.setItem('access', '{not json');
globalThis.localStorage.setItem('activeEmail', 'a@x.com');
store = loadModule();
assert.strictEqual(store.getActiveUser(), null);

console.log('account-store: all assertions passed');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && node tests/account-store.test.mjs`
Expected: FAIL — `TypeError: Cannot read properties of undefined (reading 'setActiveAccount')` (module not created yet).

- [ ] **Step 3: Write the module**

Create `assets/js/account-store.js`:

```js
/**
 * account-store.js — email-keyed client-side account storage.
 *
 * localStorage layout:
 *   access        = { "<email>": <user object>, ... }   // one entry per email used here
 *   activeEmail   = "<email>" | absent                   // who is logged in now
 *   token / refresh_token                                // the active session only
 *   webauthn_credential_id                               // shared passkey (owned elsewhere, untouched)
 *
 * One account is active at a time; switching accounts requires logging in again.
 * Loaded as a plain global <script> before auth.js / mcp-client.js / chat.js and
 * before any inline auth handler. Exposes window.accountStore (globalThis in Node).
 */
(function (root) {
  'use strict';

  var ACCESS = 'access';
  var ACTIVE = 'activeEmail';
  var TOKEN = 'token';
  var REFRESH = 'refresh_token';
  var LEGACY_USER = 'user';

  function normEmail(email) {
    return String(email == null ? '' : email).trim().toLowerCase();
  }

  function readAccess() {
    try {
      var raw = localStorage.getItem(ACCESS);
      var parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeAccess(map) {
    localStorage.setItem(ACCESS, JSON.stringify(map));
  }

  function getActiveEmail() {
    return localStorage.getItem(ACTIVE);
  }

  function getActiveUser() {
    var email = getActiveEmail();
    if (!email) return null;
    var map = readAccess();
    return map[email] || null;
  }

  function getToken() {
    return localStorage.getItem(TOKEN);
  }

  function getRefreshToken() {
    return localStorage.getItem(REFRESH);
  }

  function setActiveAccount(user, token, refreshToken) {
    var email = normEmail(user && user.email);
    if (!email) {
      console.error('[account-store] setActiveAccount: user has no email; ignoring', user);
      return false;
    }
    var map = readAccess();
    map[email] = user;
    writeAccess(map);
    localStorage.setItem(ACTIVE, email);
    if (token) localStorage.setItem(TOKEN, token);
    if (refreshToken) localStorage.setItem(REFRESH, refreshToken);
    return true;
  }

  function updateActiveUser(patch) {
    var email = getActiveEmail();
    if (!email) return false;
    var map = readAccess();
    if (!map[email]) return false;
    var merged = {};
    var k;
    for (k in map[email]) merged[k] = map[email][k];
    for (k in (patch || {})) merged[k] = patch[k];
    map[email] = merged;
    writeAccess(map);
    return true;
  }

  function clearActiveAccount() {
    localStorage.removeItem(ACTIVE);
    localStorage.removeItem(TOKEN);
    localStorage.removeItem(REFRESH);
  }

  function migrateLegacyUser() {
    try {
      if (localStorage.getItem(ACCESS) != null) return false; // already migrated
      var raw = localStorage.getItem(LEGACY_USER);
      if (!raw) return false;
      var user = JSON.parse(raw);
      var email = normEmail(user && user.email);
      if (email) {
        var map = {};
        map[email] = user;
        writeAccess(map);
        localStorage.setItem(ACTIVE, email);
      }
      localStorage.removeItem(LEGACY_USER);
      return true;
    } catch (e) {
      return false;
    }
  }

  root.accountStore = {
    getActiveEmail: getActiveEmail,
    getActiveUser: getActiveUser,
    getToken: getToken,
    getRefreshToken: getRefreshToken,
    setActiveAccount: setActiveAccount,
    updateActiveUser: updateActiveUser,
    clearActiveAccount: clearActiveAccount,
    migrateLegacyUser: migrateLegacyUser,
  };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && node tests/account-store.test.mjs`
Expected: PASS — prints `account-store: all assertions passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/account-store.js frontend/tests/account-store.test.mjs
git commit -m "feat(frontend): add email-keyed account-store module + unit test"
```

---

### Task 2: Wire `auth.js` to the store; load the script on auth.js pages

**Files:**
- Modify: `frontend/assets/js/auth.js:15-16` (constructor hydrate)
- Modify: `frontend/assets/js/auth.js:73-78` (embed handler)
- Modify: `frontend/assets/js/auth.js:898-913` (`saveAuthData`)
- Modify: `frontend/assets/js/auth.js:1034-1040` (`clearAuthData`)
- Modify: `frontend/index.html` (add script before `assets/js/auth.js`)
- Modify: `frontend/login.html` (add script before `assets/js/auth.js`)

- [ ] **Step 1: Hydrate from the store in the constructor**

Replace `auth.js:15-16`:
```js
        this.token = localStorage.getItem('token');
        this.user = JSON.parse(localStorage.getItem('user') || 'null');
```
with:
```js
        // One-time migration of the legacy flat 'user' key into the email-keyed store.
        window.accountStore.migrateLegacyUser();
        this.token = window.accountStore.getToken();
        this.user = window.accountStore.getActiveUser();
```

- [ ] **Step 2: Route the embed-mode handler through the store**

Replace `auth.js:73-78`:
```js
            localStorage.setItem('token', data.token);
            this.token = data.token;
            if (data.user) {
                localStorage.setItem('user', JSON.stringify(data.user));
                this.user = data.user;
            }
```
with:
```js
            this.token = data.token;
            if (data.user) {
                window.accountStore.setActiveAccount(data.user, data.token);
                this.user = data.user;
            } else {
                localStorage.setItem('token', data.token);
            }
```

- [ ] **Step 3: Route `saveAuthData` through the store**

Replace `auth.js:898-913` body:
```js
    saveAuthData(authData) {
        // Store JWT token
        this.token = authData.access_token;
        localStorage.setItem('token', this.token);

        // Store refresh token
        if (authData.refresh_token) {
            localStorage.setItem('refresh_token', authData.refresh_token);
        }

        // Store user data
        this.user = authData.user;
        localStorage.setItem('user', JSON.stringify(this.user));

        console.log('✅ Authentication data saved');
    }
```
with:
```js
    saveAuthData(authData) {
        this.token = authData.access_token;
        this.user = authData.user;
        // Persist under the active email; one active session at a time.
        window.accountStore.setActiveAccount(
            authData.user,
            authData.access_token,
            authData.refresh_token
        );
        console.log('✅ Authentication data saved');
    }
```

- [ ] **Step 4: Route `clearAuthData` through the store**

Replace `auth.js:1034-1040`:
```js
    clearAuthData() {
        localStorage.removeItem('token');
        localStorage.removeItem('refresh_token');
        localStorage.removeItem('user');
        this.token = null;
        this.user = null;
    }
```
with:
```js
    clearAuthData() {
        // Clears the active session (activeEmail + tokens) but keeps the
        // per-email cache so the account can be logged into again.
        window.accountStore.clearActiveAccount();
        this.token = null;
        this.user = null;
    }
```

- [ ] **Step 5: Load `account-store.js` before `auth.js` on both pages**

In `index.html`, immediately before the line `<script src="assets/js/auth.js?v=20260515-startup-tasks"></script>` (currently line 3901), add:
```html
    <script src="assets/js/account-store.js?v=20260529-account-store"></script>
```
In `login.html`, find the `<script src="assets/js/auth.js...">` include and add the same line immediately before it.

Also add the same include before the `auth.js` script in `workflow-editor-test.html` — it loads `auth.js`, whose constructor now calls `window.accountStore.migrateLegacyUser()`, so the store must be present there or that page throws.

- [ ] **Step 6: Verify (manual — no DOM test harness)**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && node -e "require('fs').readFileSync('assets/js/auth.js','utf8').includes(\"localStorage.getItem('user')\") && process.exit(1)"`
Expected: exit code 0 (the legacy `getItem('user')` read is gone from auth.js).
Then in a browser: load `login.html`, sign in with email/password, confirm DevTools → Application → Local Storage shows `access` with your email, `activeEmail` set, `token` present, and NO `user` key.

- [ ] **Step 7: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/auth.js frontend/index.html frontend/login.html
git commit -m "refactor(frontend): route auth.js session storage through account-store"
```

---

### Task 3: Migrate `register.html` signup paths

**Files:**
- Modify: `frontend/register.html:476-477` (email/password signup)
- Modify: `frontend/register.html:549-550` (Google signup)
- Modify: `frontend/register.html:612-613` (Facebook signup)
- Modify: `frontend/register.html` `<head>` (add script include)

- [ ] **Step 1: Add the script include**

In `register.html`, immediately before `<script src="assets/js/firebase-config.js"></script>` (currently line 630), add:
```html
    <script src="assets/js/account-store.js?v=20260529-account-store"></script>
```

- [ ] **Step 2: Email/password path**

Replace `register.html:476-477`:
```js
                    if (data.data?.access_token) localStorage.setItem('token', data.data.access_token);
                    if (data.data?.user) localStorage.setItem('user', JSON.stringify(data.data.user));
```
with:
```js
                    if (data.data?.user && data.data?.access_token) {
                        window.accountStore.setActiveAccount(data.data.user, data.data.access_token, data.data.refresh_token);
                    }
```

- [ ] **Step 3: Google path**

Replace `register.html:549-550`:
```js
                            localStorage.setItem('token', data.data.access_token);
                            localStorage.setItem('user', JSON.stringify(data.data.user));
```
with:
```js
                            window.accountStore.setActiveAccount(data.data.user, data.data.access_token, data.data.refresh_token);
```

- [ ] **Step 4: Facebook path**

Replace `register.html:612-613` (identical two lines as Step 3) with:
```js
                            window.accountStore.setActiveAccount(data.data.user, data.data.access_token, data.data.refresh_token);
```

- [ ] **Step 5: Verify**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && grep -c "setItem('user'" register.html`
Expected: `0`.
Browser: complete an email signup, confirm `access[<email>]` + `activeEmail` set, no `user` key.

- [ ] **Step 6: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/register.html
git commit -m "refactor(frontend): register.html writes accounts via account-store"
```

---

### Task 4: Migrate `payment.html` plan update

**Files:**
- Modify: `frontend/payment.html:234-236`
- Modify: `frontend/payment.html` `<head>` (add script include)

- [ ] **Step 1: Add the script include**

In `payment.html` `<head>`, add (before the first inline `<script>` that runs on load):
```html
    <script src="assets/js/account-store.js?v=20260529-account-store"></script>
```

- [ ] **Step 2: Replace the read-modify-write**

Replace `payment.html:234-236`:
```js
                    const cachedUser = JSON.parse(localStorage.getItem('user') || '{}');
                    cachedUser.plan = plan;
                    localStorage.setItem('user', JSON.stringify(cachedUser));
```
with:
```js
                    window.accountStore.updateActiveUser({ plan: plan });
```

- [ ] **Step 3: Verify**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && grep -c "Item('user'" payment.html`
Expected: `0`.

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/payment.html
git commit -m "refactor(frontend): payment.html updates plan via account-store"
```

---

### Task 5: Migrate `index.html` account modal + fallback logout

**Files:**
- Modify: `frontend/index.html:4019-4021` (fallback logout)
- Modify: `frontend/index.html:4041` (account modal read)

(The `account-store.js` include was added on `index.html` in Task 2.)

- [ ] **Step 1: Fallback logout**

Replace `index.html:4019-4021`:
```js
                localStorage.removeItem('token');
                localStorage.removeItem('refresh_token');
                localStorage.removeItem('user');
```
with:
```js
                window.accountStore.clearActiveAccount();
```

- [ ] **Step 2: Account modal read**

Replace `index.html:4041`:
```js
            const userInfo = JSON.parse(localStorage.getItem('user') || '{}');
```
with:
```js
            const userInfo = window.accountStore.getActiveUser() || {};
```

- [ ] **Step 3: Verify**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && grep -c "Item('user'" index.html`
Expected: `0`.
Browser: open the account modal — email/name/id/created-at still populate for the active account.

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/index.html
git commit -m "refactor(frontend): index.html modal+logout via account-store"
```

---

### Task 6: Migrate `chat.js` and `mcp-client.js` identity reads

**Files:**
- Modify: `frontend/assets/js/chat.js:1733`, `:7641`, `:7756`
- Modify: `frontend/assets/js/mcp-client.js:27-30`

- [ ] **Step 1: chat.js — replace all three reads**

At each of `chat.js:1733`, `:7641`, `:7756` the line is identical:
```js
            const storedUser = JSON.parse(localStorage.getItem('user') || 'null');
```
Replace each with:
```js
            const storedUser = window.accountStore.getActiveUser();
```
(`getActiveUser()` returns `null` when logged out, matching the previous `|| 'null'` semantics; downstream `storedUser?.id` usage is unchanged.)

- [ ] **Step 2: mcp-client.js — replace the storage read**

Replace `mcp-client.js:26-30`:
```js
        try {
            const stored = JSON.parse(localStorage.getItem('user') || 'null');
            const fromStorage = stored?.id || stored?.uid;
            if (fromStorage) return String(fromStorage);
        } catch { /* corrupt localStorage entry */ }
```
with:
```js
        const stored = window.accountStore.getActiveUser();
        const fromStorage = stored?.id || stored?.uid;
        if (fromStorage) return String(fromStorage);
```
(`getActiveUser()` already swallows corrupt JSON and returns null, so the try/catch is no longer needed.)

- [ ] **Step 3: Verify**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && grep -rn "getItem('user')" assets/js/chat.js assets/js/mcp-client.js`
Expected: no output (all migrated).
Confirm `assets/js/mcp-client.js` is loaded after `assets/js/account-store.js` on `index.html` (account-store is added at line ~3901, mcp-client at ~3909 — order is correct).

- [ ] **Step 4: Commit**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add frontend/assets/js/chat.js frontend/assets/js/mcp-client.js
git commit -m "refactor(frontend): chat.js and mcp-client.js read identity via account-store"
```

---

### Task 7: Whole-app verification

**Files:** none (manual verification).

- [ ] **Step 1: Confirm no stray legacy reads remain**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && grep -rn "Item('user')" . --include='*.html' --include='*.js' | grep -v node_modules`
Expected: no output. (All `user`-key access now goes through `account-store.js`.)

- [ ] **Step 2: Re-run the unit test**

Run: `cd /Applications/XAMPP/xamppfiles/htdocs/gpt/frontend && node tests/account-store.test.mjs`
Expected: `account-store: all assertions passed`.

- [ ] **Step 3: Browser walkthrough (record results in the PR/commit message)**

1. Migration: with an existing logged-in session (legacy `user` key present), load `index.html`. Confirm `user` key is replaced by `access[<email>]` + `activeEmail`, and you stay logged in.
2. Login email A → `access` has A, `activeEmail = A`; chat send works; MCP tool create/list scoped to A's id.
3. Logout → `activeEmail` and `token` cleared; `access` still contains A.
4. Login email B → `access` has A and B; `activeEmail = B`.
5. Log back into A → reuses cached A, `activeEmail = A`, correct `user.id` in usage/verify calls.
6. Upgrade plan on the active account via `payment.html` → only that email's `plan` changes.
7. Google/Facebook signup on `register.html` → entry stored with correct `provider` per email.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/gpt
git add -A
git commit -m "test(frontend): verify email-keyed account storage end-to-end"
```
