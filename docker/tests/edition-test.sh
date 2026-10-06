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

# --- upgrade path: a volume from before GPT_AUTO_PASSWORD existed -----------
# secrets.env on a volume created by an earlier version holds only
# JWT_SECRET and APP_KEY_SECRET. `set -u` used to turn the missing
# GPT_AUTO_PASSWORD into "unbound variable" -> exit 1 -> restart-loop, with
# `down -v` at the top of every other test meaning nothing else in this suite
# could ever see it. Strip the key back out of the running volume and reboot
# to reproduce that exact shape, then require the container to reach healthy.
web_cid=$(docker compose ps -q web)
[ -n "$web_cid" ] || fail "web container not found for the upgrade-path check"
docker compose exec -T web sh -c \
  "grep -v '^GPT_AUTO_PASSWORD=' /run/gpt/secrets.env > /run/gpt/secrets.env.old && mv /run/gpt/secrets.env.old /run/gpt/secrets.env" \
  || fail "could not roll back secrets.env to its pre-upgrade shape"
docker compose exec -T web grep -q '^GPT_AUTO_PASSWORD=' /run/gpt/secrets.env \
  && fail "secrets.env still has GPT_AUTO_PASSWORD after stripping it"

docker compose restart web >/dev/null 2>&1 || fail "restart failed (upgrade-path check)"
healthy=0
for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && { healthy=1; break; }
done
# A crash-looping container ("unbound variable" -> exit 1 -> restart:
# unless-stopped) never reports a Health value at all -- it just keeps
# restarting -- so failing to reach "healthy" within the loop above is
# exactly the regression this test exists to catch.
[ "$healthy" -eq 1 ] || fail "web did not reach healthy after an upgrade-shaped secrets.env (state: $(docker compose ps --format '{{.State}}' web 2>/dev/null))"
docker compose exec -T web grep -q '^GPT_AUTO_PASSWORD=' /run/gpt/secrets.env \
  || fail "GPT_AUTO_PASSWORD was not backfilled into secrets.env"

echo "PASS: an upgrade-shaped secrets.env (no GPT_AUTO_PASSWORD) still boots healthy"

# --- registration is unavailable off-hosted ---------------------------------
login_html=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/login.html")
echo "$login_html" | grep -q "gpt-edition-hide-register" \
  || fail "login.html has no edition-aware register suppression"

reg_html=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/register.html")
echo "$reg_html" | grep -q "gpt-edition-guard" \
  || fail "register.html has no edition guard"

echo "PASS: the edition reaches the browser"

# --- hosted: GPT_EDITION unset must take NO new code path -------------------
# Every frontend branch in this feature tests for GPT_EDITION being present,
# so production (which never sets it) must serve a config.js byte-identical
# to the example -- not merely "look right". A stray "individual" default
# picked up from a leftover .env, or an edition block that renders even when
# the variable is blank, both need to fail here.
docker compose down -v >/dev/null 2>&1 || true
GPT_EDITION= docker compose up -d --build >/dev/null 2>&1 \
  || fail "compose up failed (hosted)"

for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
done

hosted_cfg=/tmp/edition-hosted-config.js
curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/assets/js/config.js" -o "$hosted_cfg" \
  || fail "config.js is not served (hosted)"

cmp -s "$hosted_cfg" frontend/assets/js/config.example.js \
  || fail "hosted config.js differs from config.example.js -- the edition path leaked into production"

sentinel_count=$(grep -cF "container-generated below this line" "$hosted_cfg" || true)
[ "$sentinel_count" -eq 0 ] \
  || fail "hosted config.js carries the container-generated sentinel ($sentinel_count occurrences)"

rm -f "$hosted_cfg"

echo "PASS: hosted (GPT_EDITION unset) config.js is byte-identical to config.example.js"
