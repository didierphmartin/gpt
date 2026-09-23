#!/usr/bin/env bash
# Secrets are generated once, persisted, and never re-rolled.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
cleanup() {
  docker rm -f gpt-ep-test >/dev/null 2>&1 || true
  docker volume rm -f gpt-ep-secrets >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker build -q -t gpt-web:test -f docker/web/Dockerfile . >/dev/null
docker volume create gpt-ep-secrets >/dev/null

run_ep() {
  docker run --rm -v gpt-ep-secrets:/run/gpt \
    -e MYSQL_HOST=db -e MYSQL_DATABASE=gpt_chatbot \
    -e MYSQL_USER=gpt -e MYSQL_PASSWORD=gpt \
    -e GPT_SKIP_ADMIN=1 \
    gpt-web:test bash -c "$1"
}

# .env is rendered with every required key filled in.
out=$(run_ep 'gpt-entrypoint true >/dev/null 2>&1; cat /var/www/html/gpt/backend/.env')
for k in DB_HOST DB_NAME DB_USER DB_PASS CTX_DB_HOST CTX_DB_NAME \
         CTX_DB_USER CTX_DB_PASS JWT_SECRET APP_KEY_SECRET; do
  echo "$out" | grep -qE "^$k=.+" || fail "$k missing or empty in backend/.env"
done

# Main and contexts connections point at the same database.
[ "$(echo "$out" | grep -E '^DB_NAME=' | cut -d= -f2)" = \
  "$(echo "$out" | grep -E '^CTX_DB_NAME=' | cut -d= -f2)" ] \
  || fail "DB_NAME and CTX_DB_NAME differ"

# No LLM key was written.
echo "$out" | grep -E '^(ANTHROPIC|OPENAI|GEMINI|XAI|DEEPSEEK|KIMI|GLM)_API_KEY=.+' \
  && fail "an LLM key was written into backend/.env"

first_jwt=$(echo "$out" | grep '^JWT_SECRET=' | cut -d= -f2)
[ "${#first_jwt}" -eq 64 ] || fail "JWT_SECRET is not 64 hex chars"

# Second boot on the same volume reuses the secret.
second=$(run_ep 'gpt-entrypoint true >/dev/null 2>&1; cat /var/www/html/gpt/backend/.env')
second_jwt=$(echo "$second" | grep '^JWT_SECRET=' | cut -d= -f2)
[ "$first_jwt" = "$second_jwt" ] || fail "JWT_SECRET was re-rolled on second boot"

# A fresh volume gets a different secret.
docker volume rm -f gpt-ep-secrets >/dev/null
docker volume create gpt-ep-secrets >/dev/null
third=$(run_ep 'gpt-entrypoint true >/dev/null 2>&1; cat /var/www/html/gpt/backend/.env')
third_jwt=$(echo "$third" | grep '^JWT_SECRET=' | cut -d= -f2)
[ "$first_jwt" != "$third_jwt" ] || fail "fresh install reused a secret"

# Frontend configs exist.
run_ep 'gpt-entrypoint true >/dev/null 2>&1;
        test -f /var/www/html/gpt/frontend/assets/js/config.js &&
        test -f /var/www/html/gpt/frontend/voice/config.json' \
  || fail "frontend config files not created"

echo "PASS: secrets generated once, persisted, never re-rolled"
