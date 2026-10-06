#!/usr/bin/env bash
# The wizard must offer a keys step, in all three languages, and must write
# through to system_llm_settings.
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "FAIL: $1" >&2; exit 1; }

W=frontend/assets/js/pwa-install-prompt.js

grep -q "'keys.title'" "$W" || fail "no keys step strings"

# i18n trap: t() returns the key when a string is missing, so a string present
# in one language and absent in another renders as a raw key at runtime.
for k in keys.title keys.intro keys.skip keys.save; do
  n=$(grep -c "'$k':" "$W" || true)
  [ "$n" -eq 3 ] || fail "'$k' defined $n times, expected 3 (en/fr/es)"
done

grep -q "admin/llm-settings" "$W" || fail "keys step does not post to the API"
grep -q "provider_key" "$W" || fail "payload is missing provider_key"

# Cache-buster, or browsers serve the old wizard.
grep -q "pwa-install-prompt.js?v=" frontend/index.html \
  || fail "pwa-install-prompt.js has no cache-buster in index.html"

echo "PASS: wizard keys step present, translated, and wired to the API"
