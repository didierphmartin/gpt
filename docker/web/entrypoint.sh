#!/usr/bin/env bash
# First-boot setup. Idempotent: safe to run on every container start.
set -euo pipefail

APP=/var/www/html/gpt
ENV_FILE="$APP/backend/.env"
SECRETS=/run/gpt/secrets.env

log() { echo "[gpt] $*"; }

# --- per-install secrets -----------------------------------------------------
# Generated once and kept on a named volume. Regenerating them on every
# container recreate would silently invalidate every session and every app key.
if [ ! -f "$SECRETS" ]; then
    log "generating per-install secrets"
    mkdir -p "$(dirname "$SECRETS")"
    {
        echo "JWT_SECRET=$(openssl rand -hex 32)"
        echo "APP_KEY_SECRET=$(openssl rand -hex 32)"
    } > "$SECRETS"
    chmod 600 "$SECRETS"
fi
# shellcheck disable=SC1090
. "$SECRETS"

# --- backend/.env ------------------------------------------------------------
# Re-rendered every boot from the committed example plus the persisted secrets,
# so compose-level changes take effect and the file itself stays disposable.
set_env() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        # '|' delimiter: values may contain '/'. No value may contain '|'.
        sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
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

chown www-data:www-data "$ENV_FILE"
chmod 600 "$ENV_FILE"

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

# --- admin account -----------------------------------------------------------
if [ "${GPT_SKIP_ADMIN:-0}" != "1" ]; then
    php "$APP/docker/bootstrap-admin.php" || log "admin bootstrap skipped (database not ready)"
fi

log "ready -- http://localhost:${GPT_PORT:-8080}/gpt/"
exec "$@"
