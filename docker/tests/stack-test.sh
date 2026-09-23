#!/usr/bin/env bash
# The stack comes up clean and loads schema + seed.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# Isolated project name and port: `docker compose down -v` below (and in
# cleanup) targets whatever compose project is in scope, and a real install
# is very likely to be the default (unnamed, port 8080) project on this same
# machine. Without this, running this test wipes the user's own gpt-db
# volume -- conversations, agents, workflows, the seeded admin account, gone.
export COMPOSE_PROJECT_NAME=gpt-test
export GPT_PORT=18080

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

# --- generated-password path (I8) -------------------------------------------
# Every other test in this suite exports GPT_ADMIN_PASSWORD, so the
# no-env-var path -- bootstrap-admin.php generating a random password and
# printing it to the log, which is what the README's quickstart actually
# exercises ("docker compose logs web | tail -20") -- was covered by no
# test at all. Boot fresh with the var unset, scrape the password back out
# of the log exactly as the README instructs, and prove it logs in for real.
echo
echo "== generated admin password (I8) =="
docker compose down -v >/dev/null 2>&1
unset GPT_ADMIN_PASSWORD
docker compose up -d >/dev/null 2>&1 || fail "compose up (no admin password) failed"

for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
  [ "$i" -eq 60 ] && fail "web never became healthy (generated-password boot)"
done

# bootstrap-admin.php prints "  password:  <value>" -- match that literal
# line (docker/bootstrap-admin.php's banner), not a paraphrase of it.
gen_password=$(docker compose logs web 2>/dev/null \
  | grep -oE 'password:[[:space:]]+[^[:space:]]+' | tail -1 | awk '{print $NF}')
[ -n "$gen_password" ] || fail "no generated admin password found in 'docker compose logs web'"

code=$(curl -s -o /tmp/gpt-genpw-login.json -w '%{http_code}' \
  -X POST "http://localhost:${GPT_PORT}/gpt/backend/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@localhost\",\"password\":\"${gen_password}\"}")
[ "$code" = "200" ] || fail "login with the generated password returned HTTP $code"
grep -q 'token' /tmp/gpt-genpw-login.json \
  || fail "login response with the generated password carried no token"
rm -f /tmp/gpt-genpw-login.json

echo "PASS: generated-password path (bootstrap-admin.php + README quickstart) verified"
