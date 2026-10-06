#!/usr/bin/env bash
# The seed must define the eight providers, must never carry a key, and must
# not silently drift from the app's own fallback provider table. It also holds
# ONE router row (jev, api_format 'router'): not a chat provider, so it has no
# catalog entry and no base_url, and is exempt from the chat-provider checks.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$HERE/../db/02-seed.sql"
CONTROLLER="$HERE/../../backend/src/Controllers/SystemSettingsController.php"
KIMI_PROVIDER="$HERE/../../backend/src/Providers/KimiProvider.php"
CATALOG="$HERE/../../backend/resources/model_catalog.json"

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

# The router row: exactly one, it is jev, it has no base_url, and no chat
# provider row may borrow the 'router' format (that would drop it from chat).
router_rows=$(grep -E "^\('[a-z0-9]+'," "$SEED" | grep -c "'router'" || true)
[ "$router_rows" -eq 1 ] || fail "expected exactly 1 router row, found $router_rows"
jev_row=$(grep -E "^\('jev'," "$SEED" || true)
[ -n "$jev_row" ] || fail "no row for router: jev"
echo "$jev_row" | grep -q "'router'" || fail "jev row must use api_format 'router'"
echo "$jev_row" | grep -qE "^\('jev', '[^']*', '', 'jev-latest', NULL," \
  || fail "jev row must have an empty api_key, model jev-latest and base_url NULL"
# Jev is priced by its vendor ($0.042 per 1M input, output free), not by the
# model catalog; its row carries NULL prices, so a separate UPDATE must set them.
grep -qE "price_input_per_1m. = 0\.042, .price_output_per_1m. = 0" "$SEED" \
  || fail "seed must price the jev row: input 0.042, output 0"
grep -qE "provider_key. = 'jev'" "$SEED" \
  || fail "the jev price UPDATE must target provider_key = 'jev'"

[ -f "$CONTROLLER" ] || fail "missing $CONTROLLER"
[ -f "$KIMI_PROVIDER" ] || fail "missing $KIMI_PROVIDER"

# Drift guard (ruling R9): each provider's model/base_url in the seed must
# still appear in the controller's fallback defaults, so if the app's
# defaults move and the seed stands still, this fails loudly.
# (Plain indexed arrays, not associative -- macOS ships bash 3.2, which
# has no declare -A.)
PROVIDERS_MODEL=(
  "claude:claude-sonnet-5"
  "openai:gpt-5.6-terra"
  "gemini:gemini-3.6-flash"
  "grok:grok-4.6"
  "deepseek:deepseek-v4-pro"
  "kimi:kimi-k2.6"
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

# Catalog guard: every seeded model must be a model_catalog.json entry for
# its provider, and the seeded prices must be that entry's prices -- the
# admin UI and the user Settings panel both read prices from the catalog,
# so a seed that disagrees shows one price and bills another.
[ -f "$CATALOG" ] || fail "missing $CATALOG"
command -v python3 >/dev/null || fail "python3 is required for the catalog check"
catalog_errors=$(python3 - "$SEED" "$CATALOG" "$CONTROLLER" <<'PY'
import json, re, sys
seed, catalog = open(sys.argv[1]).read(), json.load(open(sys.argv[2]))["providers"]
controller = open(sys.argv[3]).read()
row = re.compile(r"^\('([a-z0-9]+)', '[^']*', '', '([^']+)', '[^']*', \d+, [0-9.]+, ([0-9.]+|NULL), ([0-9.]+|NULL), ", re.M)
rows = row.findall(seed)
expected = {"claude", "openai", "gemini", "grok", "deepseek", "kimi", "gamma4", "glm"}
matched = [r[0] for r in rows]
if len(matched) != len(expected) or set(matched) != expected:
    print(f"expected exactly one row per provider {sorted(expected)} in the expected column layout, matched {matched}")
for key, model, pin, pout in rows:
    entry = next((m for m in catalog.get(key, []) if m["id"] == model), None)
    if entry is None:
        print(f"{key}: seeded model {model} is not in model_catalog.json")
    elif pin == "NULL" or pout == "NULL" or float(pin) != float(entry["input"]) or float(pout) != float(entry["output"]):
        print(f"{key}: seeded prices {pin}/{pout} for {model} differ from the catalog's {entry['input']}/{entry['output']}")

# The PHP fallback table ($providerDefaults) must bill the same prices the
# seed and the catalog show, not only name the same model.
block = re.search(r"\$providerDefaults = \[(.*?)\n        \];", controller, re.S)
if block is None:
    print("could not find $providerDefaults in SystemSettingsController.php")
else:
    php = {}
    for m in re.finditer(r"'([a-z0-9]+)' => \[(.*?)\n            \]", block.group(1), re.S):
        body = m.group(2)
        get = lambda f, pat: (re.search(r"'" + f + r"' => " + pat, body) or [None, None])[1]
        php[m.group(1)] = (get("model", r"'([^']*)'"),
                           get("price_input_per_1m", r"([0-9.]+)"),
                           get("price_output_per_1m", r"([0-9.]+)"))
    for key, model, pin, pout in rows:
        if key not in php:
            print(f"{key}: no entry in SystemSettingsController.php $providerDefaults")
            continue
        pmodel, ppin, ppout = php[key]
        if pmodel != model:
            print(f"{key}: $providerDefaults model {pmodel} differs from the seeded {model}")
        if ppin is None or ppout is None or pin == "NULL" or pout == "NULL" \
                or float(ppin) != float(pin) or float(ppout) != float(pout):
            print(f"{key}: $providerDefaults prices {ppin}/{ppout} differ from the seeded {pin}/{pout}")
        entry = next((m for m in catalog.get(key, []) if m["id"] == pmodel), None)
        if entry is not None and ppin is not None and ppout is not None and \
                (float(ppin) != float(entry["input"]) or float(ppout) != float(entry["output"])):
            print(f"{key}: $providerDefaults prices {ppin}/{ppout} for {pmodel} differ from the catalog's {entry['input']}/{entry['output']}")
PY
)
[ -z "$catalog_errors" ] || fail "seed disagrees with model_catalog.json: $catalog_errors"

# The three backends each ship a copy of the catalog; they must be one file.
for copy in "$HERE/../../backend_typescript/resources/model_catalog.json" \
            "$HERE/../../backend_python/resources/model_catalog.json"; do
  cmp -s "$CATALOG" "$copy" || fail "catalog copy differs from backend/resources/model_catalog.json: $copy"
done

# Promotional prices expire. A catalog entry with "promo_ends" carries a
# price that stops being true after that date, so once today is past it the
# catalog (and the seed, if the model is a default) must be refreshed.
# SEED_TEST_TODAY=YYYY-MM-DD overrides today's date, to exercise this check.
TODAY="${SEED_TEST_TODAY:-$(date +%F)}"
[[ "$TODAY" =~ ^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$ ]] \
  || fail "SEED_TEST_TODAY must be a date in YYYY-MM-DD form, got: $TODAY"
promo_errors=$(python3 - "$CATALOG" "$TODAY" <<'PY'
import json, re, sys
catalog, today = json.load(open(sys.argv[1]))["providers"], sys.argv[2]
for key, models in catalog.items():
    for m in models:
        end = m.get("promo_ends")
        if end is None:
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(end)):
            print(f"{key}/{m['id']}: promo_ends {end!r} is not YYYY-MM-DD")
        elif today > end:
            print(f"{key}/{m['id']}: promotional price {m['input']}/{m['output']} ended {end}; refresh the catalog price for {m['id']}")
PY
)
[ -z "$promo_errors" ] || fail "expired promotional prices in model_catalog.json (today $TODAY): $promo_errors"

# Every row must be enabled, or the provider picker will look empty. Row
# tuples end in "...enabled, sort_order)" followed by either ',' (every row
# but the last) or ';' (only the last) -- anchoring on ");" alone would only
# ever look at the last row and miss enabled=0 on any of the other seven.
if grep -qE ", *0, *[0-9]+\)[,;]" "$SEED"; then
  fail "a row appears to have enabled=0"
fi

echo "PASS: seed defines all 8 providers + the jev router row, carries no keys, matches the app's defaults (models and prices) and the model catalog, and no promotional price has expired"
