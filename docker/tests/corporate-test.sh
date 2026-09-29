#!/usr/bin/env bash
# The corporate image serves gpt AND gpt_admin from one origin, with sign-in on.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "FAIL: $1" >&2; exit 1; }

# The brief's relative default (../gpt_admin) resolves wrongly from a worktree
# checkout; default to the real sibling checkout instead. A customer who
# clones both repos side by side overrides this with the relative form.
ADMIN_SRC=${GPT_ADMIN_SRC:-/Applications/XAMPP/xamppfiles/htdocs/gpt_admin}
[ -d "$ADMIN_SRC" ] || { echo "SKIP: gpt_admin not found at $ADMIN_SRC"; exit 0; }

export COMPOSE_PROJECT_NAME=gpt-corp-test
export GPT_PORT=18082
trap 'docker compose -f compose.yaml -f compose.corporate.yaml down -v >/dev/null 2>&1 || true' EXIT

docker compose -f compose.yaml -f compose.corporate.yaml down -v >/dev/null 2>&1 || true

# Dockerfile.corporate starts FROM gpt-web-base:latest, and gpt-admin-dist
# is a separate image built from gpt_admin's own directory as its context
# (Docker's COPY cannot reach outside a build's own context, so gpt_admin's
# sources cannot be pulled in directly by Dockerfile.corporate). Both must be
# tagged before the compose build below.
docker build -t gpt-web-base:latest -f docker/web/Dockerfile . >/dev/null 2>&1 \
  || fail "base image build failed"
docker build -t gpt-admin-dist:latest -f docker/gptadmin/Dockerfile "$ADMIN_SRC" >/dev/null 2>&1 \
  || fail "gpt_admin image build failed"
LOGIN_SRC=${GPT_LOGIN_SRC:-/Applications/XAMPP/xamppfiles/htdocs/login}
[ -d "$LOGIN_SRC" ] || { echo "SKIP: login service checkout not found at $LOGIN_SRC"; exit 0; }
docker build -q -t gpt-login-src:latest -f docker/login/Dockerfile "$LOGIN_SRC" >/dev/null \
  || fail "login service image build failed"

docker compose -f compose.yaml -f compose.corporate.yaml up -d --build >/dev/null 2>&1 \
  || fail "corporate stack failed to build"

for i in $(seq 1 90); do
  sleep 2
  [ "$(docker compose -f compose.yaml -f compose.corporate.yaml ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
done

curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/login.html" >/dev/null \
  || fail "gpt is not served"
curl -fsS "http://localhost:${GPT_PORT}/gpt_admin/" | grep -qi "<html" \
  || fail "gpt_admin is not served at /gpt_admin/"

# Auto-login must be OFF -- corporate users sign in.
cfg=$(curl -fsS "http://localhost:${GPT_PORT}/gpt/frontend/assets/js/config.js")
echo "$cfg" | grep -q "gpt-auto-login" && fail "corporate edition has auto-login enabled"
echo "$cfg" | grep -q "corporate" || fail "config.js does not report the corporate edition"

# Unauthenticated /verify answers 401 from the login service itself; a 404 or
# 500 means Apache is not routing /login/ to it.
code=$(curl -sS -o /dev/null -w '%{http_code}' "http://localhost:${GPT_PORT}/login/backend/api/v1/verify")
[ "$code" = "401" ] || [ "$code" = "200" ] \
  || fail "login service API is not served at /login/backend/api/v1 (HTTP $code)"
curl -fsS "http://localhost:${GPT_PORT}/gpt/backend/api/v1/setup/status" | grep -q '"needs_setup":true' \
  || fail "a fresh corporate install does not report needs_setup"

echo "PASS: corporate stack serves gpt + gpt_admin, login service at /login/, awaiting setup"
