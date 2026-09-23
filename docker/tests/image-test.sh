#!/usr/bin/env bash
# The image must build and serve the frontend without any database.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
cleanup() {
  rm -f "${catalog_body:-}"
  docker rm -f gpt-image-test >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -t gpt-web:test -f docker/web/Dockerfile . || fail "build failed"

# --entrypoint bypasses first-boot setup: this test is about the image only.
# Port 18081, not 18080: run-all.sh gives the isolated compose stack 18080, and
# this standalone container would otherwise collide with it whenever a stack is
# up -- failing with "port is already allocated" instead of with a real result.
docker run -d --name gpt-image-test -p 18081:80 \
  --entrypoint apache2-foreground gpt-web:test >/dev/null

for i in $(seq 1 30); do
  sleep 1
  curl -fsS "http://localhost:18081/gpt/" >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && fail "server never came up"
done

curl -fsS "http://localhost:18081/gpt/" | grep -qi '<html' \
  || fail "/gpt/ did not serve HTML"
curl -fsS "http://localhost:18081/gpt/frontend/index.html" >/dev/null \
  || fail "frontend not served"

# The success path for this route needs a real, reachable database, and this
# task ships no database and no compose stack -- that path is covered by the
# later full-stack test. Here we assert the failure path instead, which is
# strictly stronger for proving the image on its own: a 500 whose body names
# the DB error can only come from Apache's rewrite reaching index.php, PHP
# running, Composer's autoloader resolving classes, and .env parsing --  if
# any of those were broken we'd get Apache's own HTML 404 page instead, which
# cannot contain this string. DB_HOST=127.0.0.1 refuses the connection
# instantly (nothing listens on 3306 in this container); an unroutable
# address would hang the request until PHP's 600s max_execution_time instead,
# since index.php sets no PDO::ATTR_TIMEOUT.
env_file="$(mktemp)"
cat > "$env_file" <<'ENV'
DB_HOST=127.0.0.1
DB_NAME=x
DB_USER=x
DB_PASS=x
CTX_DB_HOST=127.0.0.1
CTX_DB_NAME=x
CTX_DB_USER=x
CTX_DB_PASS=x
JWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
APP_KEY_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
ENV
chmod 644 "$env_file"
docker cp "$env_file" gpt-image-test:/var/www/html/gpt/backend/.env
docker exec gpt-image-test chmod 644 /var/www/html/gpt/backend/.env
rm -f "$env_file"

catalog_body="$(mktemp)"
catalog_status="$(curl -sS -o "$catalog_body" -w '%{http_code}' \
  "http://localhost:18081/gpt/backend/api/v1/models/catalog")"
[ "$catalog_status" = "500" ] \
  || fail "catalog route: expected HTTP 500 with DB unreachable, got $catalog_status"
grep -q "Database connection failed" "$catalog_body" \
  || fail "rewrite or PHP broken: catalog route did not reach index.php"

for ext in pdo_mysql gd intl zip soap xsl sodium mbstring curl; do
  docker exec gpt-image-test php -m | grep -qix "$ext" || fail "missing ext: $ext"
done

docker exec gpt-image-test test -f /var/www/html/gpt/backend/vendor/autoload.php \
  || fail "composer install did not run at build time"

docker exec gpt-image-test php -r 'exit((int)(ini_get("upload_max_filesize")!=="60M"));' \
  || fail "php.ini not applied"

echo "PASS: image builds and serves gpt"
