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
count=$(echo "$cfg" | grep -c "GPT_EDITION" || true)
[ "$count" -eq 1 ] || fail "after restart, GPT_EDITION appears $count times (expected 1)"

echo "PASS: the edition reaches the browser"
