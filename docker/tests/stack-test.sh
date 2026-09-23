#!/usr/bin/env bash
# The stack comes up clean and loads schema + seed.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker compose up -d --build >/dev/null 2>&1 || fail "compose up failed"

for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
  [ "$i" -eq 60 ] && fail "web never became healthy"
done

q() { docker compose exec -T db mysql -ugpt -pgpt gpt_chatbot -N -B -e "$1" 2>/dev/null; }

[ "$(q 'SHOW TABLES;' | wc -l | tr -d ' ')" = "50" ] || fail "expected 50 tables"
[ "$(q 'SELECT COUNT(*) FROM system_llm_settings;')" -gt 0 ] \
  || fail "provider catalog was not seeded"

# Default profile starts exactly two containers.
[ "$(docker compose ps --services | wc -l | tr -d ' ')" = "2" ] \
  || fail "default profile should start only db and web"

echo "PASS: stack up, schema and seed loaded"
