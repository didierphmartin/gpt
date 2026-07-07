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
  // Per-host base URLs for each backend flavour. The admin picks one in
  // Settings → Account (persisted as localStorage 'BACKEND_KIND' = 'php' | 'node').
  var PHP_BY_HOST = {
    'localhost': '/gpt/backend/api/v1',
    '127.0.0.1': '/gpt/backend/api/v1',
    'synergyaichat.com': '/gpt/backend/api/v1', // prod: frontend + backend same origin
  };
  var NODE_BY_HOST = {
    'localhost': 'http://localhost:3001/api/v1',
    '127.0.0.1': 'http://localhost:3001/api/v1',
    'synergyaichat.com': '/gpt/backend-node/api/v1', // prod Node URL (update when deployed)
  };

  // Non-browser (Node test) context: expose pure helpers and stop.
  if (typeof window === 'undefined') {
    globalThis.__API_CONFIG_TEST__ = { resolveApiBase: resolveApiBase, makeApiUrl: makeApiUrl };
    return;
  }

  var override = null, kind = 'php';
  try { override = localStorage.getItem('API_BASE_URL'); } catch (e) { override = null; }
  try { kind = (localStorage.getItem('BACKEND_KIND') || 'php').toLowerCase(); } catch (e) { kind = 'php'; }
  if (kind !== 'node') kind = 'php';

  var base = resolveApiBase({
    override: override,                                  // explicit manual override wins (testing)
    hostname: location.hostname,
    byHost: kind === 'node' ? NODE_BY_HOST : PHP_BY_HOST,  // else the admin-chosen flavour
    fallback: FALLBACK,
  });

  window.APP_CONFIG = window.APP_CONFIG || {};
  window.APP_CONFIG.API_BASE_URL = base;
  window.APP_CONFIG.BACKEND_KIND = kind;                 // 'php' | 'node' — read by Settings UI
  window.APP_CONFIG.BACKEND_URLS = {                     // so the UI can show each target
    php: PHP_BY_HOST[location.hostname] || FALLBACK,
    node: NODE_BY_HOST[location.hostname] || FALLBACK,
  };
  window.apiUrl = makeApiUrl(base);

  // Admin backend switcher (Settings → Account). Persists the choice and reloads so the whole
  // app re-resolves against the selected backend.
  window.setBackendKind = function (k) {
    k = (k === 'node') ? 'node' : 'php';
    try { localStorage.setItem('BACKEND_KIND', k); } catch (e) {}
    location.reload();
  };

  console.log('[api-config] backend =', kind, '→', base);
})();
