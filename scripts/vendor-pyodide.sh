#!/bin/sh
# Download Pyodide into the app so skills run without reaching a CDN.
# Usage: scripts/vendor-pyodide.sh [dest]   (default: frontend/vendor/pyodide/v0.27.7)
# Exits non-zero on any failed download or checksum mismatch.
set -eu

VERSION=0.27.7
BASE="https://cdn.jsdelivr.net/pyodide/v$VERSION/full"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/frontend/vendor/pyodide/v$VERSION}"
# Keep in step with PREBUILT_PACKAGES in frontend/assets/js/pyodide-runner.js.
PACKAGES="micropip beautifulsoup4 lxml numpy pandas scipy matplotlib pillow pyyaml regex requests pytz sqlite3 soupsieve markupsafe jinja2"

mkdir -p "$DEST"
for f in pyodide.js pyodide.mjs pyodide.asm.js pyodide.asm.wasm python_stdlib.zip pyodide-lock.json; do
    curl -fsSL "$BASE/$f" -o "$DEST/$f"
done

# Resolve the package closure and print "file_name sha256" lines.
LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT
python3 -I - "$DEST/pyodide-lock.json" $PACKAGES > "$LIST" <<'PY'
import json, sys
lock = json.load(open(sys.argv[1]))["packages"]
by_name = {k.lower(): v for k, v in lock.items()}
seen, todo = set(), [n.lower() for n in sys.argv[2:]]
while todo:
    n = todo.pop().replace("_", "-")
    if n in seen:
        continue
    seen.add(n)
    if n not in by_name:
        sys.exit("package not in pyodide-lock.json: " + n)
    todo += [d.lower() for d in by_name[n].get("depends", [])]
for n in sorted(seen):
    print(by_name[n]["file_name"], by_name[n]["sha256"])
PY
while read -r name sum; do
    curl -fsSL "$BASE/$name" -o "$DEST/$name"
    got="$(shasum -a 256 "$DEST/$name" | cut -d' ' -f1)"
    [ "$got" = "$sum" ] || { echo "checksum mismatch: $name" >&2; exit 1; }
done < "$LIST"
echo "Pyodide $VERSION installed in $DEST"
