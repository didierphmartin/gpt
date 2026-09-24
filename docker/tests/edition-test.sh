#!/usr/bin/env bash
# The edition must reach the browser, and must be ABSENT when unset (hosted).
set -euo pipefail
cd "$(dirname "$0")/../.."
export COMPOSE_PROJECT_NAME=gpt-test
export GPT_PORT=18080

fail() { echo "FAIL: $1" >&2; exit 1; }
trap 'docker compose down -v >/dev/null 2>&1 || true' EXIT

docker compose down -v >/dev/null 2>&1 || true
GPT_EDITION=individual docker compose up -d --build >/dev/null 2>&1 \
  || fail "compose up failed"

for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
done

cfg=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/assets/js/config.js") \
  || fail "config.js is not served"

echo "$cfg" | grep -q "GPT_EDITION" \
  || fail "config.js carries no GPT_EDITION"
echo "$cfg" | grep -q "individual" \
  || fail "config.js does not report the individual edition"

# Verify idempotence: restart and check no duplication
docker compose restart web >/dev/null 2>&1 || fail "restart failed"
for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
done

cfg=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/assets/js/config.js") \
  || fail "config.js not served after restart"
# Match the block header, not any incidental "GPT_EDITION" text (the
# auto-login script below also references the constant by name).
count=$(echo "$cfg" | grep -cF "container-generated below this line" || true)
[ "$count" -eq 1 ] || fail "after restart, the edition block appears $count times (expected 1)"

# --- auto-login -------------------------------------------------------------
echo "$cfg" | grep -q "gpt-auto-login" \
  || fail "individual edition has no auto-login block"

# The credential it uses must actually work against the API.
email=$(echo "$cfg" | sed -n "s/.*autoEmail *= *'\([^']*\)'.*/\1/p" | head -1)
pass=$(echo  "$cfg" | sed -n "s/.*autoPass *= *'\([^']*\)'.*/\1/p"  | head -1)
[ -n "$email" ] && [ -n "$pass" ] || fail "auto-login credentials not found in config.js"

code=$(curl -s -o /tmp/edition-login.json -w '%{http_code}' \
  -X POST "http://localhost:${GPT_PORT}/gpt/backend/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"$pass\"}")
[ "$code" = "200" ] || fail "auto-login credentials rejected by the API (HTTP $code)"
grep -q access_token /tmp/edition-login.json || fail "login returned no token"
rm -f /tmp/edition-login.json

# And the password must survive a restart, or config.js and the DB row diverge.
docker compose restart web >/dev/null 2>&1
for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
done
cfg2=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/assets/js/config.js")
pass2=$(echo "$cfg2" | sed -n "s/.*autoPass *= *'\([^']*\)'.*/\1/p" | head -1)
[ "$pass" = "$pass2" ] || fail "the auto-login password changed across a restart"

# Two restarts now: neither block may have accumulated a second copy.
count=$(echo "$cfg2" | grep -cF "container-generated below this line" || true)
[ "$count" -eq 1 ] || fail "after two restarts, the edition block appears $count times (expected 1)"
count=$(echo "$cfg2" | grep -cF "gpt-auto-login" || true)
[ "$count" -eq 1 ] || fail "after two restarts, the auto-login block appears $count times (expected 1)"

# --- registration is unavailable off-hosted ---------------------------------
login_html=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/login.html")
echo "$login_html" | grep -q "gpt-edition-hide-register" \
  || fail "login.html has no edition-aware register suppression"

reg_html=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/register.html")
echo "$reg_html" | grep -q "gpt-edition-guard" \
  || fail "register.html has no edition guard"

echo "PASS: the edition reaches the browser"
