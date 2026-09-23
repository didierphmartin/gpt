#!/usr/bin/env bash
# Full verification. Destroys and rebuilds the stack -- do not run against
# anything you care about.
#
# Runs in its own compose project on its own port (see stack-test.sh), so
# even though this script (and stack-test.sh/admin-test.sh, which it calls)
# runs `docker compose down -v`, it can never reach a real install's stack
# or its gpt-db volume.
set -euo pipefail
cd "$(dirname "$0")/../.."

export COMPOSE_PROJECT_NAME=gpt-test
export GPT_PORT=18080

echo "== static checks (no Docker needed) =="
./docker/tests/schema-test.sh
./docker/tests/seed-test.sh

echo
echo "== image =="
./docker/tests/image-test.sh

echo
echo "== entrypoint =="
./docker/tests/entrypoint-test.sh

echo
echo "== stack =="
docker compose down -v >/dev/null 2>&1 || true
./docker/tests/stack-test.sh

echo
echo "== seeded admin =="
./docker/tests/admin-test.sh

echo
echo "== bringing the stack up for the live checks =="
docker compose up -d --build >/dev/null 2>&1
for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
done

./docker/tests/no-keys-test.sh
./docker/tests/persistence-test.sh

echo
echo "== cleaning up =="
docker compose down -v >/dev/null 2>&1

echo
echo "ALL CHECKS PASSED"
