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
    // Normalize the lookup key: setActiveAccount/migrateLegacyUser always store
    // and point activeEmail at the normalized form, but normalize here too so a
    // differently-cased activeEmail written elsewhere can't silently miss.
    return map[normEmail(email)] || null;
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
    // Clear any prior refresh token when the new login didn't supply one, so a
    // switched account never inherits the previous account's refresh token.
    if (refreshToken) localStorage.setItem(REFRESH, refreshToken);
    else localStorage.removeItem(REFRESH);
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
      } else {
        console.warn('[account-store] migrateLegacyUser: legacy user had no email; dropping', user);
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
