#!/bin/sh
# Fail a commit that changes a browser-loaded asset (JS or CSS) without moving
# its ?v= in frontend/index.html.
#
# Why this exists: on 2026-09-15 swarm-rewrite.js was rewritten three times
# while its ?v= stayed put. Browsers kept serving the original, so the editor
# validated canvases against rules that had been replaced hours earlier, and
# the failure looked like a bug in the user's drawing rather than a stale file.
# The content on disk was correct every time — which is exactly what makes this
# class of bug expensive to chase.
#
# Install: ln -sf ../../scripts/check-cache-busters.sh .git/hooks/pre-commit
# Bypass (rarely right): git commit --no-verify

INDEX="frontend/index.html"
[ -f "$INDEX" ] || exit 0

# CSS is browser-loaded with a ?v= exactly as JS is, and was invisible here —
# workflow-editor.css had to be bumped by hand. Anything index.html does not
# reference is skipped below by the "$base?v=" test, so widening is safe:
# test files and unreferenced modules still pass without a bump.
staged=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^frontend/assets/.*\.(js|css)$')
[ -n "$staged" ] || exit 0

# The version of index.html this commit will produce.
if git diff --cached --name-only | grep -qx "$INDEX"; then
    after=$(git show ":$INDEX" 2>/dev/null)
else
    after=$(cat "$INDEX")
fi
before=$(git show "HEAD:$INDEX" 2>/dev/null || echo "")

bad=""
for f in $staged; do
    base=${f#frontend/}
    # Only assets index.html actually loads are our business.
    echo "$after" | grep -q "$base?v=" || continue
    v_after=$(echo "$after"  | sed -n "s|.*$base?v=\([^\"']*\).*|\1|p" | head -1)
    v_before=$(echo "$before" | sed -n "s|.*$base?v=\([^\"']*\).*|\1|p" | head -1)
    [ "$v_after" = "$v_before" ] && bad="$bad $f"
done

[ -n "$bad" ] || exit 0

echo "✗ Changed asset(s) whose cache-buster did not move:"
for f in $bad; do
    base=${f#frontend/}
    echo "    $f   (still ?v=$(echo "$after" | sed -n "s|.*$base?v=\([^\"']*\).*|\1|p" | head -1))"
done
cat <<'MSG'

  Browsers will keep serving the old file, and the bug will look like it is
  somewhere else entirely. Bump the ?v= for each of these in
  frontend/index.html, stage it, and commit again.

  If this is genuinely not a browser-loaded change: git commit --no-verify
MSG
exit 1
