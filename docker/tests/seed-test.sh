#!/usr/bin/env bash
# The seed must define the eight providers, must never carry a key, and must
# not silently drift from the app's own fallback provider table.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$HERE/../db/02-seed.sql"
CONTROLLER="$HERE/../../backend/src/Controllers/SystemSettingsController.php"
KIMI_PROVIDER="$HERE/../../backend/src/Providers/KimiProvider.php"

fail() { echo "FAIL: $1" >&2; exit 1; }

[ -f "$SEED" ] || fail "missing $SEED"

grep -qi 'INSERT INTO `\?system_llm_settings' "$SEED" \
  || fail "seed inserts no provider rows"

# Any api_key-shaped literal that is not empty is a leaked key.
if grep -oiE "'(sk-|xai-|gsk_)[^']*'" "$SEED" | grep -q .; then
  fail "seed contains what looks like a real API key"
fi

# No row may carry a non-empty api_key. The column is 3rd in our fixed
# INSERT column list (provider_key, display_name, api_key, model, ...), so
# the literal "', '', '" (display_name's closing quote, an empty api_key,
# model's opening quote) must appear exactly once per row.
rows=$(grep -cE "^\('[a-z0-9]+'," "$SEED" || true)
[ "$rows" -gt 0 ] || fail "no provider row tuples found"
empty_keys=$(grep -o "', '', '" "$SEED" | wc -l | tr -d ' ')
[ "$empty_keys" -eq "$rows" ] \
  || fail "expected $rows empty api_key fields, found $empty_keys"

for p in claude openai gemini grok deepseek kimi gamma4 glm; do
  grep -qi "'$p'" "$SEED" || fail "no row for provider: $p"
done

[ -f "$CONTROLLER" ] || fail "missing $CONTROLLER"
[ -f "$KIMI_PROVIDER" ] || fail "missing $KIMI_PROVIDER"

# Drift guard (ruling R9): each provider's model/base_url in the seed must
# still appear in the controller's fallback defaults, so if the app's
# defaults move and the seed stands still, this fails loudly.
# (Plain indexed arrays, not associative -- macOS ships bash 3.2, which
# has no declare -A.)
PROVIDERS_MODEL=(
  "claude:claude-sonnet-4-5"
  "openai:gpt-4o"
  "gemini:gemini-2.0-flash"
  "grok:grok-2-latest"
  "deepseek:deepseek-chat"
  "kimi:moonshot-v1-auto"
  "gamma4:Gemma-4-E4B-it"
  "glm:glm-5.2"
)
# kimi's base_url is exempt here -- see below.
PROVIDERS_BASE_URL=(
  "claude:https://api.anthropic.com"
  "openai:https://api.openai.com"
  "gemini:https://generativelanguage.googleapis.com"
  "grok:https://api.x.ai"
  "deepseek:https://api.deepseek.com"
  "gamma4:https://g4eb.yellowbrickroad.info"
  "glm:https://api.z.ai/api/paas/v4"
)

for entry in "${PROVIDERS_MODEL[@]}"; do
  p="${entry%%:*}"
  model="${entry#*:}"
  grep -qi "'$model'" "$SEED" || fail "seed missing model for $p: $model"
  grep -qF "$model" "$CONTROLLER" \
    || fail "drift: model for $p ($model) no longer in SystemSettingsController.php"
done

for entry in "${PROVIDERS_BASE_URL[@]}"; do
  p="${entry%%:*}"
  base_url="${entry#*:}"
  grep -qi "'$base_url'" "$SEED" || fail "seed missing base_url for $p: $base_url"
  grep -qF "$base_url" "$CONTROLLER" \
    || fail "drift: base_url for $p ($base_url) no longer in SystemSettingsController.php"
done

# kimi.base_url is EXEMPT from the controller check above: the seed
# deliberately diverges from SystemSettingsController.php's fallback
# ('https://api.moonshot.cn', the China endpoint) per ruling R7b, because
# KimiProvider.php is what the runtime actually calls. Assert against that
# provider class instead.
KIMI_BASE_URL="https://api.moonshot.ai"
grep -qi "'$KIMI_BASE_URL'" "$SEED" \
  || fail "seed missing kimi base_url: $KIMI_BASE_URL"
grep -qF "$KIMI_BASE_URL" "$KIMI_PROVIDER" \
  || fail "drift: kimi base_url ($KIMI_BASE_URL) no longer in KimiProvider.php"
# Only the row tuples matter here -- explanatory comments are allowed to
# mention the .cn endpoint by name (that's how they explain the ruling).
if grep -E "^\(" "$SEED" | grep -qi "api.moonshot.cn"; then
  fail "seed must not use the moonshot.cn (China) endpoint for kimi"
fi

# Every row must be enabled, or the provider picker will look empty.
if grep -qE ", *0, *[0-9]+\);" "$SEED"; then
  fail "a row appears to have enabled=0"
fi

echo "PASS: seed defines all 8 providers, carries no keys, and matches the app's defaults"
