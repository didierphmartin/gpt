#!/usr/bin/env bash
# down && up must not re-seed, re-roll secrets, or lose data.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# Isolated project name and port -- see stack-test.sh: this script runs
# `docker compose down`/`up` against whatever compose project is in scope,
# and must never be the user's own default-project stack.
export COMPOSE_PROJECT_NAME=gpt-test
export GPT_PORT=18080

q() { docker compose exec -T db mysql -ugpt -pgpt gpt_chatbot -N -B -e "$1" 2>/dev/null; }
wait_healthy() {
  for i in $(seq 1 60); do
    sleep 2
    [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && return 0
  done
  fail "web never became healthy"
}

before_hash=$(q "SELECT password FROM users ORDER BY id LIMIT 1;")
before_jwt=$(docker compose exec -T web sh -c 'grep "^JWT_SECRET=" /var/www/html/gpt/backend/.env')

# A row the user might have added. `type` is a NOT NULL enum and the label
# column is `name`, not `title`.
q "INSERT INTO prompt_library (user_id, type, name, content, created_at)
   VALUES (1, 'prompt', 'persistence probe', 'probe', NOW());" || true

docker compose down >/dev/null 2>&1      # NOTE: no -v
docker compose up -d >/dev/null 2>&1
wait_healthy

[ "$(q "SELECT password FROM users ORDER BY id LIMIT 1;")" = "$before_hash" ] \
  || fail "admin password changed across a restart"
[ "$(docker compose exec -T web sh -c 'grep "^JWT_SECRET=" /var/www/html/gpt/backend/.env')" = "$before_jwt" ] \
  || fail "JWT_SECRET was re-rolled across a restart"
[ "$(q 'SELECT COUNT(*) FROM users;')" = "1" ] || fail "admin was re-seeded"
[ "$(q "SELECT COUNT(*) FROM prompt_library WHERE name='persistence probe';")" -ge 1 ] \
  || fail "user data did not survive a restart"

echo "PASS: data, secrets and admin survive down && up"
