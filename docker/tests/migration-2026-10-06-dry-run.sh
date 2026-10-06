#!/usr/bin/env bash
# Dry run of backend/schema/migrations/2026-10-06_roles_robot_publishing.sql
# on a THROWAWAY mysql:8.4 container (unique name, random host port, removed
# on exit). It never reads .env and never connects to any other database.
#
# Steps: load the pre-branch chatbot.sql (git d09a80a), insert fixture rows,
# run the migration TWICE (it must be re-runnable), then check that the old
# reads still work and the data is intact. Exits non-zero on any failed check.
set -euo pipefail
cd "$(dirname "$0")/../.."

MIGRATION=backend/schema/migrations/2026-10-06_roles_robot_publishing.sql
PRE_BRANCH=d09a80a
NAME="gpt-migration-dryrun-$$-$RANDOM"
PASS="dryrun-$RANDOM$RANDOM"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { echo "ok: $1"; }

# Every query goes through `docker exec` into the throwaway container only.
q() { docker exec -i "$NAME" mysql -uroot -p"$PASS" --batch --skip-column-names dryrun 2>/dev/null; }
sql() { printf '%s\n' "$1" | q; }

echo "== start throwaway mysql:8.4 ($NAME) =="
docker run -d --name "$NAME" -e MYSQL_ROOT_PASSWORD="$PASS" -e MYSQL_DATABASE=dryrun \
  -p 127.0.0.1::3306 mysql:8.4 >/dev/null
for _ in $(seq 1 90); do
  if docker exec "$NAME" mysql -uroot -p"$PASS" -e 'SELECT 1' dryrun >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "$NAME" mysql -uroot -p"$PASS" -e 'SELECT 1' dryrun >/dev/null 2>&1 || fail "mysql did not come up"
echo "mysql $(sql 'SELECT VERSION();') on host port $(docker port "$NAME" 3306/tcp | head -1)"

echo "== load the pre-branch schema ($PRE_BRANCH:backend/schema/chatbot.sql) =="
git show "$PRE_BRANCH:backend/schema/chatbot.sql" | q || fail "pre-branch schema did not load"

echo "== fixtures =="
q <<'SQL' || fail "fixtures did not load"
INSERT INTO packages (role, capabilities) VALUES
  ('guest',    JSON_OBJECT('max_tokens', 1)),
  ('prospect', JSON_OBJECT('max_tokens', 2)),
  ('user',     JSON_OBJECT('max_tokens', 3, 'workflows', true)),
  ('admin',    JSON_OBJECT('max_tokens', 4));
INSERT INTO users (id, email, first_name, role, plan) VALUES
  (1, 'g@x.test',  'G',  'guest',     'free'),
  (2, 'p@x.test',  'P',  'prospect',  'free'),
  (3, 'u@x.test',  'U',  'user',      'standard'),
  (4, 'a@x.test',  'A',  'admin',     'premium'),
  (5, 'af@x.test', 'Af', 'affiliate', 'free'),
  (6, 'n@x.test',  'N',  NULL,        'free');
INSERT INTO users (id, email, first_name) VALUES (7, 'd@x.test', 'D');
INSERT INTO playbooks (id, user_id, pkey, title, text) VALUES (1, 3, 'reset-password', 'Reset password', 'Do the thing.');
SQL
BEFORE_USERS=$(sql 'SELECT id, email, IFNULL(role, "<NULL>"), plan FROM users ORDER BY id;')
BEFORE_PKG=$(sql 'SELECT role, capabilities FROM packages ORDER BY CONCAT(role);')
BEFORE_PB=$(sql 'SELECT id, user_id, pkey, title, text FROM playbooks ORDER BY id;')
echo "$BEFORE_USERS"

for run in 1 2; do
  echo "== migration run $run =="
  if ! docker exec -i "$NAME" mysql -uroot -p"$PASS" dryrun < "$MIGRATION" 2> >(grep -v 'Using a password' >&2); then
    fail "migration run $run failed"
  fi
  ok "migration run $run"
done

echo "== checks =="
[ "$(sql "SELECT capabilities FROM packages WHERE role='user';")" = '{"workflows": true, "max_tokens": 3}' ] \
  || fail "old read SELECT capabilities FROM packages WHERE role='user' changed: $(sql "SELECT capabilities FROM packages WHERE role='user';")"
ok "old read: SELECT capabilities FROM packages WHERE role='user'"

sql 'SELECT id, email, first_name, last_name, role, plan, provider, last_login, created_at FROM users ORDER BY id;' >/dev/null \
  || fail "old admin users SELECT"
ok "old admin users SELECT"

AFTER_USERS=$(sql "SELECT id, email, IFNULL(role, '<NULL>'), plan FROM users WHERE kind = 'person' ORDER BY id;")
[ "$AFTER_USERS" = "$BEFORE_USERS" ] || fail "users changed:
before:
$BEFORE_USERS
after:
$AFTER_USERS"
ok "users.role values unchanged (incl. affiliate, NULL and the column default)"

[ "$(sql "SELECT COUNT(*) FROM users WHERE id <= 7 AND kind = 'person';")" = 7 ] || fail "existing users are not all kind=person"
[ "$(sql "SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'kind';")" = person ] \
  || fail "users.kind default is not person"
sql "INSERT INTO users (email) VALUES ('new@x.test');"
[ "$(sql "SELECT CONCAT(kind, '/', role) FROM users WHERE email = 'new@x.test';")" = person/prospect ] \
  || fail "a new user does not default to kind=person, role=prospect"
sql "DELETE FROM users WHERE email = 'new@x.test';"
ok "kind defaults to person (role still defaults to prospect)"

[ "$(sql "SELECT COUNT(*) FROM users WHERE kind = 'service';")" = 1 ] || fail "expected exactly one service user"
[ "$(sql "SELECT CONCAT(email, '/', role, '/', IFNULL(password, 'NULL'), '/', provider) FROM users WHERE kind = 'service';")" = 'robot@synergyai.invalid/robot/NULL/email' ] \
  || fail "robot row: $(sql "SELECT email, role, password, provider FROM users WHERE kind = 'service';")"
ok "exactly one robot user"

[ "$(sql "SELECT COUNT(*) FROM packages WHERE role = 'robot';")" = 1 ] || fail "expected exactly one robot packages row"
[ "$(sql "SELECT capabilities FROM packages WHERE role = 'robot';")" = "$(sql "SELECT capabilities FROM packages WHERE role = 'user';")" ] \
  || fail "robot capabilities are not a copy of user"
[ "$(sql "SELECT GROUP_CONCAT(CONCAT(role, ':', name, ':', builtin) ORDER BY role) FROM packages;")" = 'admin:Admin:1,guest:Guest:1,prospect:Prospect:1,robot:Robot:1,user:User:1' ] \
  || fail "packages names/builtin: $(sql "SELECT role, name, builtin FROM packages;")"
ok "exactly one robot packages row; built-ins named and flagged"

AFTER_PKG=$(sql "SELECT role, capabilities FROM packages WHERE role <> 'robot' ORDER BY CONCAT(role);")
[ "$AFTER_PKG" = "$BEFORE_PKG" ] || fail "packages capabilities changed"
ok "packages capabilities intact"

[ "$(sql "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playbooks' AND COLUMN_NAME IN ('published_by', 'published_at', 'source_id');")" = 3 ] \
  || fail "playbooks is missing a new column"
AFTER_PB=$(sql 'SELECT id, user_id, pkey, title, text FROM playbooks ORDER BY id;')
[ "$AFTER_PB" = "$BEFORE_PB" ] || fail "playbooks data changed"
[ "$(sql "SELECT CONCAT(IFNULL(published_by, 'NULL'), IFNULL(published_at, 'NULL'), IFNULL(source_id, 'NULL')) FROM playbooks WHERE id = 1;")" = NULLNULLNULL ] \
  || fail "new playbooks columns are not NULL on existing rows"
ok "playbooks has the 3 new columns; existing row intact"

[ "$(sql "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'packages' AND INDEX_NAME = 'PRIMARY' AND COLUMN_NAME = 'role';")" = 1 ] \
  || fail "packages lost its primary key on role"
ok "packages keeps PRIMARY KEY(role)"

sql "INSERT INTO packages (role, name, builtin, capabilities) VALUES ('it-ops-2', 'IT Ops', 0, JSON_OBJECT('use_robot', true));
     UPDATE users SET role = 'it-ops-2' WHERE id = 3;" || fail "custom role key not accepted"
ok "a custom role key is accepted in packages and users"

echo "PASS: migration dry run (ran twice) on $(sql 'SELECT VERSION();')"
