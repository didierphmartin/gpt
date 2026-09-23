#!/usr/bin/env bash
# The rule that must never rot: a running container holds no LLM key.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# Isolated project name and port -- see stack-test.sh. This script only
# execs into an already-running stack, but standalone runs must still never
# collide with a real install on the default project/port.
export COMPOSE_PROJECT_NAME=gpt-test
export GPT_PORT=18080

# R2b: prove the stack is actually up and answering BEFORE concluding
# "no keys found". If `docker compose exec` fails outright (container not
# running, wrong service name, stack down), the pipelines below produce no
# output, grep matches nothing, and every check below would silently PASS
# against a dead container. That would satisfy the single most important
# guarantee in this whole plan by doing nothing at all. Do not remove this
# guard to "simplify" the script.
docker compose exec -T web true >/dev/null 2>&1 \
  || fail "stack is not up: 'docker compose exec -T web true' failed"
docker compose exec -T db mysql -ugpt -pgpt gpt_chatbot -e 'SELECT 1' >/dev/null 2>&1 \
  || fail "stack is not up: db is not answering queries"

q() { docker compose exec -T db mysql -ugpt -pgpt gpt_chatbot -N -B -e "$1" 2>/dev/null; }

keyed=$(q "SELECT COUNT(*) FROM system_llm_settings
           WHERE api_key IS NOT NULL AND api_key != '';")
[ "$keyed" = "0" ] || fail "$keyed provider rows ship with an API key"

keyed_users=$(q "SELECT COUNT(*) FROM user_api_keys;")
[ "$keyed_users" = "0" ] || fail "user_api_keys is not empty"

# Nothing in the image or the rendered .env carries a key.
docker compose exec -T web sh -c '
  grep -hoE "^(ANTHROPIC|OPENAI|GEMINI|XAI|DEEPSEEK|KIMI|GLM)_API_KEY=.+" \
    /var/www/html/gpt/backend/.env 2>/dev/null
' | grep -q . && fail "backend/.env carries an LLM key"

docker compose exec -T web env \
  | grep -E "^(ANTHROPIC|OPENAI|GEMINI|XAI|DEEPSEEK|KIMI|GLM)_API_KEY=.+" \
  && fail "an LLM key is present in the container environment"

# --- M4: image-wide scan, not just backend/.env -----------------------------
# The two checks above only ever looked at backend/.env and the process
# environment. That would NOT have caught a stray real .env anywhere else
# under the app root -- e.g. a developer's own langchain_runner/.env, which
# per backend/.env.example is exactly where the workflow editor writes the
# user's real provider keys (see .dockerignore, which now excludes it: this
# is the regression guard for that fix). Scan the whole app root recursively
# instead.
#
# Match on assignment-WITH-VALUE (KEY_NAME=<20+ key-shaped chars>), and
# separately on a long key-SHAPE run, rather than the bare variable name or
# prefix alone -- a bare-string/short-prefix match would trip on things that
# only look like a key at a glance: frontend/index.html's
# placeholder="sk-ant-...", placeholder="sk-proj-...", placeholder="xai-..."
# input hints, the doc examples in backend/README.md ('xai-your-api-key')
# and langchain_runner/README.md ('ANTHROPIC_API_KEY=sk-ant-...'), and
# VoiceController.php's comment documenting an unrelated xAI response shape
# ('xai-realtime-client-secret-...', an ephemeral realtime token, not
# XAI_API_KEY). All of those are short, or dash-joined words, or end in a
# literal "..." within a few characters -- comfortably under the per-prefix
# floors below. A real key isn't: Anthropic/OpenAI/DeepSeek/Kimi keys run
# 90+ chars after their "sk-"/"xai-" prefix, Google's AIzaSy... is exactly
# 39 chars total (33 after the prefix), Groq-shaped gsk_ keys run 50+.
# Trailing `true`: under set -e, a bare `var=$(cmd)` assignment aborts the
# script the instant cmd's exit status is non-zero -- and a clean grep (no
# match, meaning no key found, the outcome we want) exits 1, which would
# otherwise become docker compose exec's exit code. Without the trailing
# `true` forcing that to 0, the happy path itself would kill the script
# before the `[ -z ... ]` check below ever ran.
key_scan=$(docker compose exec -T web sh -c '
  grep -rIhoE "(ANTHROPIC|OPENAI|GEMINI|XAI|DEEPSEEK|KIMI|GLM)_API_KEY[[:space:]]*=[[:space:]]*[A-Za-z0-9_+/=-]{20,}" /var/www/html/gpt 2>/dev/null
  grep -rIhoE "sk-[A-Za-z0-9_+/=-]{40,}" /var/www/html/gpt 2>/dev/null
  grep -rIhoE "xai-[A-Za-z0-9_+/=-]{40,}" /var/www/html/gpt 2>/dev/null
  grep -rIhoE "AIzaSy[A-Za-z0-9_-]{25,}" /var/www/html/gpt 2>/dev/null
  grep -rIhoE "gsk_[A-Za-z0-9_+/=-]{40,}" /var/www/html/gpt 2>/dev/null
  true
')
[ -z "$key_scan" ] \
  || fail "a real-looking LLM key was found under /var/www/html/gpt: $key_scan"

# --- C1: backend/.env must never be servable over HTTP ----------------------
# Apache's only default dotfile deny is <FilesMatch "^\.ht">, which does not
# cover .env, and backend/.htaccess's rewrite guard (REQUEST_FILENAME !-f)
# does not apply to a file that exists -- so without an explicit deny,
# GET /gpt/backend/.env returns the file body (JWT_SECRET, APP_KEY_SECRET,
# DB creds) over plain HTTP. docker/web/apache-gpt.conf now denies every
# dotfile; assert that here so this can never regress silently.
env_status=$(curl -s -o /dev/null -w '%{http_code}' \
  "http://localhost:${GPT_PORT}/gpt/backend/.env")
[ "$env_status" = "403" ] \
  || fail "GET /gpt/backend/.env returned HTTP $env_status, expected 403"

echo "PASS: no LLM keys anywhere in the running stack, and backend/.env is not servable"
