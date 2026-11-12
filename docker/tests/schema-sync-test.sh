#!/usr/bin/env bash
# docker/schema-sync.php brings an old volume up to chatbot.sql.
# Needs the stack up. Works in a scratch database (sync_test) that it creates
# and drops; the app's own database is only checked, never changed.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail() { echo "FAIL: $1" >&2; exit 1; }

RP=$(docker compose exec -T db printenv MYSQL_ROOT_PASSWORD)
GPT_USER=$(docker compose exec -T db printenv MYSQL_USER)
root() { docker compose exec -T db mysql -uroot -p"$RP" --batch --skip-column-names "$@" 2>/dev/null; }
sync() { docker compose exec -T -e MYSQL_DATABASE=sync_test web php docker/schema-sync.php; }
trap 'root -e "DROP DATABASE IF EXISTS sync_test" || true' EXIT

root -e "DROP DATABASE IF EXISTS sync_test; CREATE DATABASE sync_test; GRANT ALL ON sync_test.* TO '$GPT_USER'@'%';"
root sync_test < backend/schema/chatbot.sql

# An "old volume": a column, a key and a table that chatbot.sql has, missing.
root sync_test -e "ALTER TABLE agent_workflows DROP COLUMN mlflow_tracing, DROP INDEX idx_workflows_enabled;
                   SET FOREIGN_KEY_CHECKS=0; DROP TABLE active_workflows;"

out=$(sync)
echo "$out"
for want in "added column agent_workflows.mlflow_tracing" \
            "added key agent_workflows.idx_workflows_enabled" \
            "added table active_workflows" \
            "added constraint active_workflows.fk_active_workflows_workflow"; do
  grep -qF "$want" <<<"$out" || fail "missing: $want"
done

out=$(sync)
grep -qF "up to date" <<<"$out" || fail "second run is not a no-op: $out"

out=$(docker compose exec -T web php docker/schema-sync.php)
grep -qF "up to date" <<<"$out" || fail "a fresh volume differs from chatbot.sql: $out"

echo "PASS: schema-sync adds what an old volume lacks, and is a no-op after"
