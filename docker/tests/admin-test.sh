#!/usr/bin/env bash
# The admin is created exactly once, is an admin, and its password verifies.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

export GPT_ADMIN_EMAIL=admin@localhost
export GPT_ADMIN_PASSWORD=test-password-123

docker compose up -d --build >/dev/null 2>&1 || fail "compose up failed"

for i in $(seq 1 60); do
  sleep 2
  [ "$(docker compose ps --format '{{.Health}}' web 2>/dev/null)" = "healthy" ] && break
  [ "$i" -eq 60 ] && fail "web never became healthy"
done

q() { docker compose exec -T db mysql -ugpt -pgpt gpt_chatbot -N -B -e "$1" 2>/dev/null; }

[ "$(q 'SELECT COUNT(*) FROM users;')" = "1" ] || fail "expected exactly 1 user"
[ "$(q "SELECT role FROM users WHERE email='admin@localhost';")" = "admin" ] \
  || fail "seeded user is not an admin"

# The password actually verifies against the stored bcrypt hash.
docker compose exec -T web php -r '
  $c = require "/var/www/html/gpt/backend/config/ai_config.php";
  $d = $c["contexts_database"];
  $p = new PDO("mysql:host={$d["host"]};dbname={$d["database"]};charset=utf8mb4",
               $d["username"], $d["password"]);
  $h = $p->query("SELECT password FROM users LIMIT 1")->fetchColumn();
  exit(password_verify("test-password-123", $h) ? 0 : 1);
' || fail "stored password does not verify"

# Re-running the bootstrap must not create a second user.
docker compose exec -T web php /var/www/html/gpt/docker/bootstrap-admin.php >/dev/null
[ "$(q 'SELECT COUNT(*) FROM users;')" = "1" ] || fail "bootstrap is not idempotent"

# End to end: the seeded admin can actually log in.
code=$(curl -s -o /tmp/gpt-login.json -w '%{http_code}' \
  -X POST "http://localhost:8080/gpt/backend/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@localhost","password":"test-password-123"}')
[ "$code" = "200" ] || fail "login returned HTTP $code"
grep -q 'token' /tmp/gpt-login.json || fail "login response carried no token"

echo "PASS: admin seeded once, verifies, and can log in"
