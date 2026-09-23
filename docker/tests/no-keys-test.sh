#!/usr/bin/env bash
# The rule that must never rot: a running container holds no LLM key.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

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

echo "PASS: no LLM keys anywhere in the running stack"
