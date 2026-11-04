// merge(originalMd, editedMd, m) -> { md, merged, reason }      mergeBlocks(...) -> md
// Block-level merge for the skill editor's save: top-level markdown blocks the editor did not change keep the
// ORIGINAL bytes; changed / inserted blocks take the edited markdown; deleted blocks disappear.
//
// "Unchanged" means: the block RENDERS to the same HTML. That folds away exactly the differences that have no
// meaning (emphasis style * vs _, list marker, hr style, setext vs atx heading, table padding / dash width,
// <u> vs [u](u), `a_b` vs `a\_b`, ...) and nothing that has: code indentation, nested list indentation,
// <br>, hard breaks, escapes that change what is literal, link targets, heading levels, task state ... all change
// the HTML, so such a block counts as changed and the edited version wins.
//
// `m` is the marked module ({ lexer, parse }); in the browser it defaults to window.marked.
// If the lexer does not account for every byte of either text (reference definitions `[x]: url` are not tokens in
// marked 11), the merge is refused: md is the edited text and reason says why. Callers can show that.
// UMD: window.MergeBlocks = { merge, mergeBlocks, keyOf }.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MergeBlocks = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function keyOf(tok, m) {
    if (tok.type === 'space') return 'space';
    return tok.type + '|' + m.parse(tok.raw);
  }

  // each content token plus the blank-line (space) tokens that follow it; leading blank lines are their own group
  function groups(md, m) {
    var out = [], cur = null;
    m.lexer(md).forEach(function (tk) {
      if (tk.type === 'space' && cur) { cur.raw += tk.raw; return; }
      cur = { raw: tk.raw, key: keyOf(tk, m) };
      out.push(cur);
    });
    return out;
  }

  function merge(originalMd, editedMd, m) {
    m = m || (typeof marked !== 'undefined' ? marked : null);
    var A = groups(originalMd, m), B = groups(editedMd, m);
    function joined(g) { return g.map(function (x) { return x.raw; }).join(''); }
    if (joined(A) !== originalMd) return { md: editedMd, merged: false, reason: 'original has markdown the block lexer drops (reference definition?)' };
    if (joined(B) !== editedMd) return { md: editedMd, merged: false, reason: 'edited text has markdown the block lexer drops (reference definition?)' };
    var n = A.length, k = B.length, dp = [], i, j;
    for (i = 0; i <= n; i++) dp.push(new Array(k + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (j = k - 1; j >= 0; j--)
      dp[i][j] = A[i].key === B[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var out = '', prevOrig = true; i = 0; j = 0;
    if (A.length && A[0].key === 'space') { out = A[0].raw; i = 1; if (B.length && B[0].key === 'space') j = 1; } // leading blank lines stay
    function push(raw, fromOriginal) {
      if (out && !/\n$/.test(out)) out += '\n\n';
      else if (out && !/\n\n$/.test(out) && !fromOriginal && prevOrig) out += '\n';
      out += raw; prevOrig = fromOriginal;
    }
    while (i < n || j < k) {
      if (i < n && j < k && A[i].key === B[j].key) { push(A[i].raw, true); i++; j++; }
      else if (j >= k || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { i++; }            // deleted
      else { if (B[j].key !== 'space') push(B[j].raw, false); j++; }                    // inserted / changed
    }
    if (/\n$/.test(originalMd) && !/\n$/.test(out)) out += '\n';                        // keep the final newline
    return { md: out, merged: true, reason: '' };
  }
  function mergeBlocks(o, e, m) { return merge(o, e, m).md; }
  return { merge: merge, mergeBlocks: mergeBlocks, keyOf: keyOf };
}));
