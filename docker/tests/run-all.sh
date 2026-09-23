#!/usr/bin/env bash
# Full verification. Destroys and rebuilds the stack -- do not run against
# anything you care about.
set -euo pipefail
cd "$(dirname "$0")/../.."

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
