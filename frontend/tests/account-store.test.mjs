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
assert.strictEqual(store.getRefreshToken(), null, 'switching accounts without a refresh token clears the stale one');

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

// 5b. updateActiveUser returns false when there is no active account
data = freshStore();
store = loadModule();
assert.strictEqual(store.updateActiveUser({ plan: 'standard' }), false, 'no active account => no-op false');

// 5c. Dangling activeEmail (valid access map missing the active key) => null, no throw
data = freshStore();
globalThis.localStorage.setItem('access', JSON.stringify({ 'kept@x.com': { id: 1, email: 'kept@x.com' } }));
globalThis.localStorage.setItem('activeEmail', 'gone@x.com');
store = loadModule();
assert.strictEqual(store.getActiveUser(), null, 'active email absent from access map => null');

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
