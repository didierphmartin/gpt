#!/usr/bin/env bash
# Asserts the tracked schema is the current, data-free one.
set -euo pipefail
SCHEMA="$(dirname "$0")/../../backend/schema/chatbot.sql"

fail() { echo "FAIL: $1" >&2; exit 1; }

tables=$(grep -cE '^CREATE TABLE' "$SCHEMA")
[ "$tables" -eq 50 ] || fail "expected 50 CREATE TABLE, got $tables"

inserts=$(grep -ciE '^(INSERT|REPLACE) INTO' "$SCHEMA" || true)
[ "$inserts" -eq 0 ] || fail "schema contains $inserts data statements"

for t in execution_traces heal_spend skill_promotions user_mcp_settings \
         playbook_runs playbook_run_gates playbook_run_ledger \
         playbook_run_messages playbook_run_notes; do
  grep -q "CREATE TABLE \`$t\`" "$SCHEMA" || fail "missing table: $t"
done

if grep -qE 'AUTO_INCREMENT=[2-9]' "$SCHEMA"; then
  fail "AUTO_INCREMENT counters not reset"
fi

echo "PASS: schema is current and data-free ($tables tables)"
