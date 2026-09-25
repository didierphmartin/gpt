/**
 * Says so when the selected backend isn't running, instead of failing silently.
 *
 * The app can be pointed at three interchangeable backends (see api-config.js):
 * PHP through Apache, TypeScript on :3001, Python on :3002. The last two are started
 * by hand, so a selection made during testing outlives the server it points at — and
 * every request then dies with a bare net::ERR_CONNECTION_REFUSED in the console.
 * Nothing in the UI says which backend it is calling, so a dead port reads as a broken
 * login, a wrong password, or a broken provider.
 *
 * Two signals, because they catch different moments:
 *   - a probe at load time, so you learn before you try to log in;
 *   - a fetch wrapper, so a backend that dies mid-session also announces itself.
 *
 * The probe uses mode:'no-cors' deliberately. A normal fetch also rejects when the
 * server IS running but CORS blocks the response, which would report a live backend as
 * dead. An opaque no-cors request resolves for anything that answers at all, so a
 * rejection means only one thing: nothing is listening.
 *
 * Loads after api-config.js, which owns the backend choice and publishes it on
 * window.APP_CONFIG.
 */
(function () {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;

  var cfg = window.APP_CONFIG || {};
  var kind = cfg.BACKEND_KIND || 'php';
  var base = cfg.API_BASE_URL || '';
  if (!base) return;

  // Commands are relative to the project root so they work for anyone who cloned the
  // repo, not just this machine.
  var BACKENDS = {
    node:   { name: 'TypeScript', cmd: 'cd backend_typescript && npm run dev' },
    python: { name: 'Python',     cmd: 'cd backend_python && ./run.sh' },
    php:    { name: 'PHP',        cmd: null },
  };

  var TEXT = {
    en: {
      title:  'backend is not running',
      refused: 'refused the connection.',
      start:  'Start it from the project root:',
      php:    'Check that Apache and MySQL are started in the XAMPP control panel.',
      button: 'Switch to the PHP backend',
      close:  'Dismiss',
    },
    fr: {
      title:  "n'est pas démarré",
      refused: 'a refusé la connexion.',
      start:  'Démarrez-le depuis la racine du projet :',
      php:    'Vérifiez qu’Apache et MySQL sont démarrés dans le panneau XAMPP.',
      button: 'Basculer vers le backend PHP',
      close:  'Fermer',
    },
    es: {
      title:  'no está en ejecución',
      refused: 'rechazó la conexión.',
      start:  'Inícialo desde la raíz del proyecto:',
      php:    'Comprueba que Apache y MySQL estén iniciados en el panel de XAMPP.',
      button: 'Cambiar al backend PHP',
      close:  'Cerrar',
    },
  };

  function lang() {
    var l;
    try { l = (localStorage.getItem('chatbot_language') || '').slice(0, 2).toLowerCase(); } catch (e) { l = ''; }
    return TEXT[l] ? l : 'en';
  }

  var shown = false;

  function show() {
    if (shown || document.getElementById('backend-health-banner')) return;
    shown = true;

    var t = TEXT[lang()];
    var b = BACKENDS[kind] || BACKENDS.php;

    var el = document.createElement('div');
    el.id = 'backend-health-banner';
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:#7f1d1d', 'color:#fee2e2', 'padding:14px 16px',
      'font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif',
      'box-shadow:0 2px 12px rgba(0,0,0,.4)',
    ].join(';');

    var head = document.createElement('div');
    head.style.cssText = 'font-weight:600;margin-bottom:4px';
    head.textContent = b.name + ' ' + t.title;

    var detail = document.createElement('div');
    detail.style.cssText = 'opacity:.9';
    detail.textContent = base + ' ' + t.refused + ' ' + (b.cmd ? t.start : t.php);

    el.appendChild(head);
    el.appendChild(detail);

    if (b.cmd) {
      var pre = document.createElement('code');
      pre.style.cssText = [
        'display:inline-block', 'margin-top:8px', 'padding:6px 10px',
        'background:rgba(0,0,0,.35)', 'border-radius:4px',
        'font-family:ui-monospace,SFMono-Regular,Menlo,monospace', 'user-select:all',
      ].join(';');
      pre.textContent = b.cmd;
      el.appendChild(pre);
    }

    var actions = document.createElement('div');
    actions.style.cssText = 'margin-top:10px;display:flex;gap:8px';

    // The one-click way out of a stale selection: the trap is that the choice persists
    // in localStorage long after the server it names has stopped.
    if (kind !== 'php' && typeof window.setBackendKind === 'function') {
      var swap = document.createElement('button');
      swap.type = 'button';
      swap.textContent = t.button;
      swap.style.cssText = 'padding:6px 12px;border:0;border-radius:4px;background:#fee2e2;color:#7f1d1d;font-weight:600;cursor:pointer';
      swap.addEventListener('click', function () { window.setBackendKind('php'); });
      actions.appendChild(swap);
    }

    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = t.close;
    close.style.cssText = 'padding:6px 12px;border:1px solid rgba(254,226,226,.5);border-radius:4px;background:transparent;color:#fee2e2;cursor:pointer';
    close.addEventListener('click', function () { el.remove(); });
    actions.appendChild(close);

    el.appendChild(actions);

    if (document.body) document.body.appendChild(el);
    else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(el); });
  }

  // Any API request that fails at the network level means nothing is listening. An HTTP
  // error status is a different problem (the server answered) and is left alone.
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    return nativeFetch(input, init).catch(function (err) {
      if (url.indexOf(base) === 0) show();
      throw err;
    });
  };

  // PHP is served by the same Apache that served this page, so if you are reading this
  // it is up — no probe needed, and no request spent on the default path.
  if (kind !== 'php') {
    nativeFetch(base, { mode: 'no-cors', cache: 'no-store' }).catch(show);
  }
})();
