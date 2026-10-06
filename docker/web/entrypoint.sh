#!/usr/bin/env bash
# First-boot setup. Idempotent: safe to run on every container start.
set -euo pipefail

APP=/var/www/html/gpt
ENV_FILE="$APP/backend/.env"
SECRETS=/run/gpt/secrets.env

log() { echo "[gpt] $*"; }

# --- edition -----------------------------------------------------------------
# Only exact values count. The rest of this script and the frontend test for
# "individual" and for "set at all", so a typo ("Corporate", "corp") would
# otherwise run silently as a corporate install. Empty is the hosted behaviour.
case "${GPT_EDITION:-}" in
    ''|individual) ;;
    corporate)
        # Corporate means users sign in and gpt_admin creates them. Without
        # gpt_admin in the image nobody could ever create a user, so refuse
        # rather than start an install that cannot be administered. It is
        # only present when built with compose.corporate.yaml.
        if [ ! -d /var/www/html/gpt_admin ]; then
            log "ERROR: GPT_EDITION=corporate, but this image has no gpt_admin."
            log "Build the corporate edition with compose.corporate.yaml (see README)."
            exit 1
        fi
        ;;
    *)
        log "ERROR: GPT_EDITION='${GPT_EDITION}' is not an edition. Use individual or corporate."
        exit 1
        ;;
esac

# --- per-install secrets -----------------------------------------------------
# Generated once and kept on a named volume. Regenerating them on every
# container recreate would silently invalidate every session and every app key.
if [ ! -f "$SECRETS" ]; then
    log "generating per-install secrets"
    mkdir -p "$(dirname "$SECRETS")"
    {
        echo "JWT_SECRET=$(openssl rand -hex 32)"
        echo "APP_KEY_SECRET=$(openssl rand -hex 32)"
        echo "GPT_AUTO_PASSWORD=$(openssl rand -hex 9)"
    } > "$SECRETS"
    chmod 600 "$SECRETS"
fi

# Backfill keys added after this volume was created. A volume from an earlier
# version has only JWT_SECRET and APP_KEY_SECRET, and `set -u` turns the
# missing one into a crash loop on upgrade rather than a clear error.
grep -q '^GPT_AUTO_PASSWORD=' "$SECRETS" || \
    echo "GPT_AUTO_PASSWORD=$(openssl rand -hex 9)" >> "$SECRETS"
grep -q '^LOGIN_APP_KEY_SECRET=' "$SECRETS" || \
    echo "LOGIN_APP_KEY_SECRET=$(openssl rand -hex 32)" >> "$SECRETS"
# The login service signs with its OWN secret, never gpt's JWT_SECRET. The two
# user tables have independent ids and neither middleware checks `iss`, so a
# shared secret would let a login-service token pass as the gpt user with the
# same id (skipping sso_exchange's email mapping), and a gpt refresh token work
# on the login service. gpt only needs this one to verify tokens in sso_exchange.
grep -q '^LOGIN_JWT_SECRET=' "$SECRETS" || \
    echo "LOGIN_JWT_SECRET=$(openssl rand -hex 32)" >> "$SECRETS"

# shellcheck disable=SC1090
. "$SECRETS"

# In the individual edition the browser signs in on the user's behalf, so the
# entrypoint -- not bootstrap-admin.php -- owns the password: it has to embed
# the same value in config.js. Persisted in secrets.env above, so a restart
# cannot leave config.js holding a password the users row no longer has.
if [ "${GPT_EDITION:-}" = "individual" ] && [ -z "${GPT_ADMIN_PASSWORD:-}" ]; then
    export GPT_ADMIN_PASSWORD="$GPT_AUTO_PASSWORD"
fi

# --- backend/.env ------------------------------------------------------------
# Re-rendered every boot from the committed example plus the persisted secrets,
# so compose-level changes take effect and the file itself stays disposable.
set_env() {
    local key="$1" value="$2"
    # '|' delimiter: values may contain '/'. No value may contain '|'.
    # sed's REPLACEMENT text still treats '&' as "the whole match" and '\'
    # as an escape, so a value containing either (e.g. a MySQL password like
    # 'p&ss\w/rd') would silently corrupt the line instead of erroring --
    # escape both before substituting. Every key this function writes
    # (DB_*, CTX_DB_*, JWT_SECRET, APP_KEY_SECRET, STORAGE_PROVIDER, GPT_EDITION,
    # LOGIN_JWT_SECRET, LOGIN_DB_*) already
    # exists in backend/.env.example, which is copied to $ENV_FILE above, so
    # the grep always matches and there is no append path to fall back to.
    value=${value//\\/\\\\}
    value=${value//&/\\&}
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
}

log "rendering backend/.env"
cp "$APP/backend/.env.example" "$ENV_FILE"

# DB_* and CTX_DB_* address the same database: no code path reads the main
# connection, but load_env.php refuses to boot unless all eight are non-empty.
for prefix in DB CTX_DB; do
    set_env "${prefix}_HOST" "${MYSQL_HOST:-db}"
    set_env "${prefix}_NAME" "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"
    set_env "${prefix}_USER" "${MYSQL_USER:?MYSQL_USER is required}"
    set_env "${prefix}_PASS" "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
done
set_env JWT_SECRET "$JWT_SECRET"
set_env APP_KEY_SECRET "$APP_KEY_SECRET"
set_env STORAGE_PROVIDER local
set_env GPT_EDITION "${GPT_EDITION:-}"
if [ "${GPT_EDITION:-}" = "corporate" ]; then
    # gpt verifies the login service's tokens in sso_exchange (with the login
    # service's own secret, distinct from JWT_SECRET) and reads its users table
    # for sso_exchange and for creating accounts from gpt_admin.
    set_env LOGIN_JWT_SECRET "$LOGIN_JWT_SECRET"
    set_env LOGIN_DB_HOST "${MYSQL_HOST:-db}"
    set_env LOGIN_DB_NAME "${LOGIN_DB_NAME:-gpt_login}"
    set_env LOGIN_DB_USER "$MYSQL_USER"
    set_env LOGIN_DB_PASS "$MYSQL_PASSWORD"
fi

chown www-data:www-data "$ENV_FILE"
chmod 600 "$ENV_FILE"

# --- login service (corporate) -------------------------------------------------
if [ "${GPT_EDITION:-}" = "corporate" ]; then
    LOGIN_ENV=/var/www/html/login/backend/.env
    log "rendering login/backend/.env"
    {
        echo "DB_HOST=${MYSQL_HOST:-db}"
        echo "DB_NAME=${LOGIN_DB_NAME:-gpt_login}"
        echo "DB_USER=${MYSQL_USER}"
        echo "DB_PASS=${MYSQL_PASSWORD}"
        echo "JWT_SECRET=${LOGIN_JWT_SECRET}"
        echo "LOGIN_APP_KEY_SECRET=${LOGIN_APP_KEY_SECRET}"
        echo "LOGIN_DISABLE_SIGNUP=1"
    } > "$LOGIN_ENV"
    chown www-data:www-data "$LOGIN_ENV"
    chmod 600 "$LOGIN_ENV"
fi

# --- frontend config ---------------------------------------------------------
# Both are gitignored and the app expects them to exist. Firebase values stay
# blank, which only disables social login.
[ -f "$APP/frontend/assets/js/config.js" ] || {
    log "creating frontend/assets/js/config.js from the example"
    cp "$APP/frontend/assets/js/config.example.js" "$APP/frontend/assets/js/config.js"
}
[ -f "$APP/frontend/voice/config.json" ] || {
    log "creating frontend/voice/config.json from the example"
    cp "$APP/frontend/voice/config.example.json" "$APP/frontend/voice/config.json"
}

# --- container-generated config section (editions, auto-login, etc.) -------
# config.js persists in the container's writable layer across restarts, so we
# must regenerate this entire section on every boot to be idempotent. With
# GPT_EDITION unset (hosted), nothing is appended and the file stays
# byte-identical to the example.
CONFIG_MARK='/* --- container-generated below this line; rebuilt on every boot --- */'

if [ -n "${GPT_EDITION:-}" ]; then
    log "edition: ${GPT_EDITION}"
    # Regenerate from example to eliminate any stale container-generated content.
    # The container's config.js is generated anyway; the example is always in the image.
    cp "$APP/frontend/assets/js/config.example.js" "$APP/frontend/assets/js/config.js"
    # Append the container-generated section.
    cat >> "$APP/frontend/assets/js/config.js" <<EOF

${CONFIG_MARK}
window.APP_CONFIG = window.APP_CONFIG || {};
window.APP_CONFIG.GPT_EDITION = '${GPT_EDITION}';
EOF

    if [ "${GPT_EDITION:-}" = "individual" ]; then
        log "individual edition: enabling auto-login"
        # Escape backslash first, then the single quote, before interpolating
        # into the single-quoted JS string literals below. Unescaped, a
        # password (or email) containing "'" produces invalid JavaScript --
        # window.APP_CONFIG never gets defined and every guard silently
        # no-ops -- and one containing "\" corrupts the value instead.
        js_auto_email=${GPT_ADMIN_EMAIL:-admin@localhost}
        js_auto_email=${js_auto_email//\\/\\\\}
        js_auto_email=${js_auto_email//\'/\\\'}
        js_auto_pass=$GPT_ADMIN_PASSWORD
        js_auto_pass=${js_auto_pass//\\/\\\\}
        js_auto_pass=${js_auto_pass//\'/\\\'}
        cat >> "$APP/frontend/assets/js/config.js" <<EOF

/* --- added by the container entrypoint: gpt-auto-login ---
 * The individual edition has one user and no sign-in screen. The backend is
 * NOT relaxed: AuthMiddleware still demands a valid JWT on every non-public
 * route. This simply performs the login the human would have performed, using
 * the account the container seeded.
 *
 * Runs only when no session exists, so it costs one request on first visit and
 * nothing afterwards. config.js loads after api-config.js (so API_BASE_URL is
 * set) and before auth.js, so this settles before anything reads the session.
 */
(function () {
    if (window.APP_CONFIG.GPT_EDITION !== 'individual') { return; }

    var base = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || '/gpt/backend/api/v1';

    // A token merely EXISTING is not enough: after a fresh install (new
    // JWT_SECRET, new database) the browser can still hold an old one, which
    // fails validation everywhere else in the app -- so treating its presence
    // alone as "already signed in" strands the user on a login screen this
    // edition is not supposed to have. Verify it first; only trust it if it
    // verifies.
    try {
        var existingToken = localStorage.getItem('token');
        if (existingToken) {
            var vxhr = new XMLHttpRequest();
            vxhr.open('POST', base + '/auth', false); // synchronous, same as the
            vxhr.setRequestHeader('Content-Type', 'application/json'); // login
            vxhr.setRequestHeader('Authorization', 'Bearer ' + existingToken); // call below
            var stillValid = false;
            try {
                vxhr.send(JSON.stringify({ action: 'verify' }));
                stillValid = vxhr.status === 200 && JSON.parse(vxhr.responseText).success;
            } catch (e) { stillValid = false; }
            if (stillValid) { return; }
            // Stale -- clear it so the login below isn't shadowed by leftover keys.
            localStorage.removeItem('token');
            localStorage.removeItem('refresh_token');
            localStorage.removeItem('user');
            localStorage.removeItem('access');
            localStorage.removeItem('activeEmail');
        }
    } catch (e) { return; }

    var autoEmail = '${js_auto_email}';
    var autoPass  = '${js_auto_pass}';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', base + '/auth/login', false); // synchronous on purpose:
    xhr.setRequestHeader('Content-Type', 'application/json'); // the page's own
    try {                                                     // auth check runs
        xhr.send(JSON.stringify({ email: autoEmail, password: autoPass }));
    } catch (e) {
        console.error('[gpt] auto-login request failed', e);
        return;
    }
    if (xhr.status !== 200) {
        console.error('[gpt] auto-login rejected:', xhr.status, xhr.responseText);
        return;
    }

    var d = JSON.parse(xhr.responseText).data || {};
    var u = d.user || {};
    if (!d.access_token || !u.email) { return; }

    // account-store.js is the canonical store (access / activeEmail / token /
    // refresh_token) but loads AFTER this file, so write its keys directly.
    // The root index.html predates it and still gates on token + user, so
    // write that legacy key too; otherwise '/gpt/' bounces back to login.
    var map = {};
    try { map = JSON.parse(localStorage.getItem('access') || '{}'); } catch (e) { map = {}; }
    map[String(u.email).toLowerCase()] = u;
    localStorage.setItem('access', JSON.stringify(map));
    localStorage.setItem('activeEmail', String(u.email).toLowerCase());
    localStorage.setItem('token', d.access_token);
    if (d.refresh_token) { localStorage.setItem('refresh_token', d.refresh_token); }
    localStorage.setItem('user', JSON.stringify(u));

    if (/\/login\.html|\/register\.html/.test(location.pathname)) {
        location.replace('index.html');
    }
})();
EOF
    fi
fi

# --- admin account -----------------------------------------------------------
if [ "${GPT_EDITION:-}" = "corporate" ]; then
    # No admin from .env: the setup wizard in gpt_admin creates it, once.
    [ "${GPT_SKIP_ADMIN:-0}" = "1" ] || php "$APP/docker/login-schema.php"
elif [ "${GPT_SKIP_ADMIN:-0}" != "1" ]; then
    php "$APP/docker/bootstrap-admin.php" || log "admin bootstrap skipped (database not ready)"
fi

log "ready -- http://localhost:${GPT_PORT:-8080}/gpt/"
exec "$@"
