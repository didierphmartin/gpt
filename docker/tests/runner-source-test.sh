#!/usr/bin/env bash
# The setup wizard installs the Python runner by FETCHING it from this app:
# local-fs.js deployRunner reads langchain_runner/install-manifest.json over
# HTTP and writes each runtime file into the folder the user grants. A page
# cannot read the host's disk, so the server is the only possible source.
#
# .dockerignore once excluded langchain_runner/ on the theory that the runner
# "is installed on the host", which had the direction backwards: the fetch
# 404'd, the wizard said "Could not install the Python runner here", and
# compiled workflows had no runtime at all. Nothing caught it, because every
# other test asks about the PHP app. This one asks about the runner.
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }

# Isolated project name and port -- see stack-test.sh.
export COMPOSE_PROJECT_NAME=gpt-test
export GPT_PORT=18080
# The app is mounted at /gpt (see docker/web/apache-gpt.conf), and local-fs.js
# derives this same path from its own script URL -- three levels up from
# <app root>/frontend/assets/js/. Test the URL the browser really requests.
BASE="http://localhost:${GPT_PORT}/gpt"

# Same guard as no-keys-test.sh: prove the stack answers before concluding
# anything, or a dead container makes every check below vacuous.
docker compose exec -T web true >/dev/null 2>&1 \
  || fail "stack is not up: 'docker compose exec -T web true' failed"

code=$(curl -s -o /tmp/gpt-runner-manifest.json -w '%{http_code}' \
       "$BASE/langchain_runner/install-manifest.json")
[ "$code" = "200" ] \
  || fail "install-manifest.json returned HTTP $code -- deployRunner cannot install the runner"

# Every file the manifest promises must actually be served. A manifest listing
# a file the image lacks is a partial install: the wizard names the gap, but
# the breakage only shows up later, when a compiled workflow tries to run.
files=$(grep -oE '"[a-zA-Z_]+\.(py|txt|md)"' /tmp/gpt-runner-manifest.json | tr -d '"')
[ -n "$files" ] || fail "manifest lists no runtime files"

for f in $files; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/langchain_runner/$f")
  [ "$code" = "200" ] || fail "manifest promises $f but it returns HTTP $code"
done
echo "  runner source: manifest + $(echo "$files" | wc -w | tr -d ' ') runtime files served"

# The reason the directory was excluded in the first place. It must stay out,
# and the `**/.env` rule -- not the absence of the whole directory -- is what
# keeps it out. Assert that directly, so re-including the directory cannot
# smuggle a developer's provider keys into the image.
docker compose exec -T web test -e /var/www/html/gpt/langchain_runner/.env \
  && fail "langchain_runner/.env is in the image"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/langchain_runner/.env")
[ "$code" = "200" ] && fail "langchain_runner/.env is served over HTTP"

echo "  runner source: no .env in the image or over HTTP"
echo "PASS: runner-source-test"
