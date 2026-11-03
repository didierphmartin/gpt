#!/usr/bin/env bash
# The MCP host: an imported server runs, is reachable through the published
# gateway, and survives a restart of mcps and a rebuild of the stack.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# Isolated project, ports and teardown: see stack-test.sh. `down -v` below must
# never be able to reach a real install's volumes.
export COMPOSE_PROJECT_NAME=gpt-test
export GPT_PORT=18080
export MCPS_PORT=18790

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

wait_healthy() {
  for i in $(seq 1 60); do
    sleep 2
    [ "$(docker compose ps --format '{{.Health}}' "$1" 2>/dev/null)" = "healthy" ] && return 0
  done
  fail "$1 never became healthy"
}

docker compose up -d --build >/dev/null 2>&1 || fail "compose up failed"
wait_healthy web
wait_healthy mcps

# The fixture's files, base64 in the install body (the shape the backend sends).
FIX=docker/mcps/tests/fixtures/ok_server
body=$(python3 - "$FIX" <<'PY'
import base64, json, sys
d = sys.argv[1]
b = lambda n: base64.b64encode(open(f"{d}/{n}", "rb").read()).decode()
print(json.dumps({"name": "ok_server", "files": {"run.sh": b("run.sh"), "synergyai-mcp.json": b("synergyai-mcp.json")}, "env": {}}))
PY
)

TOKEN=$(docker compose exec -T web sh -c '. /run/gpt/secrets.env; echo $MCPS_TOKEN' | tr -d '\r')
[ "${#TOKEN}" -eq 64 ] || fail "MCPS_TOKEN missing from secrets.env"

# The backend's env tells it where the host is.
docker compose exec -T web grep -q '^MCPS_URL=http://mcps:9000' /var/www/html/gpt/backend/.env \
  || fail "MCPS_URL not rendered into backend/.env"

# Control API, from inside the compose network (it is not published).
code=$(printf '%s' "$body" | docker compose exec -T web curl -s -o /dev/null -w '%{http_code}' \
  -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- http://mcps:9000/servers/ok_server/install)
[ "$code" = "200" ] || [ "$code" = "201" ] || fail "install answered $code"

gateway_ok() {
  for i in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$MCPS_PORT/ok_server/")" = "200" ] && return 0
    sleep 1
  done
  return 1
}
gateway_ok || fail "gateway did not serve ok_server from the host"
echo "PASS: server installed and reachable through the gateway"

docker compose restart mcps >/dev/null 2>&1
wait_healthy mcps
gateway_ok || fail "ok_server not running after restarting mcps"
echo "PASS: server comes back after a restart of mcps"

docker compose up -d --build >/dev/null 2>&1 || fail "second compose up failed"
wait_healthy mcps
gateway_ok || fail "ok_server lost after a rebuild"
echo "PASS: server kept in the volume across a rebuild"
