// mergeBlocks(originalMd, editedMd) -> md
// Block-level merge for the skill editor's save: top-level markdown blocks the editor did not change keep the
// ORIGINAL bytes; changed / inserted blocks take the edited markdown; deleted blocks disappear.
// UMD: window.mergeBlocks (needs window.marked) or require('./merge-blocks.js') with a lexer passed in.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.mergeBlocks = factory().mergeBlocks;
}(typeof self !== 'undefined' ? self : this, function () {
  // Comparison key of a block: token type + raw text with the differences the editor introduces on its own
  // folded away (whitespace, backslash escapes, list marker, hr style, emphasis style, table padding/dash width, <br>).
  // Nothing else is folded: any other character change makes the block "changed".
  function keyOf(tok) {
    var t = tok.raw.replace(/\r\n/g, '\n');
    t = t.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\]\\^_`{|}~])/g, '$1');
    t = t.replace(/<br>/g, '');
    // inline code: same content, whatever backtick fence / padding the editor chose
    t = t.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, function (m, f, c) { return '`' + c.replace(/^ (.*) $/, '$1') + '`'; });
    // autolink <u> and [u](u) are the same link
    t = t.replace(/\[([^\]\s]+)\]\(\1\)/g, '<$1>');
    if (tok.type === 'blockquote') t = t.split('\n').filter(function (l) { return !/^\s*(>\s*)+$/.test(l); }).map(function (l) { return l.replace(/^\s*(>\s*)+/, ''); }).join('\n');
    if (tok.type === 'code') return 'code|' + (tok.lang || '') + '|' + (tok.text || '').replace(/^\s+|\s+$/gm, '');
    if (tok.type === 'hr') return 'hr';
    if (tok.type === 'table') {
      t = t.split('\n').map(function (l) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) return '|' + l.replace(/[^:|]/g, '').replace(/\s/g, '');
        return l.replace(/\s*\|\s*/g, '|').trim();
      }).join('\n');
    }
    t = t.replace(/^(\s*)[*+](\s)/gm, '$1-$2');
    t = t.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1*$2*').replace(/__([^_\n]+)__/g, '**$1**');
    return tok.type + '|' + t.replace(/\s+/g, ' ').trim();
  }

  // groups: each content token plus the blank-line (space) tokens that follow it; a leading space is its own group
  function groups(md, lexer) {
    var toks = lexer(md), out = [], cur = null;
    toks.forEach(function (tk) {
      if (tk.type === 'space' && cur) { cur.raw += tk.raw; return; }
      cur = { tok: tk, raw: tk.raw, key: tk.type === 'space' ? 'space' : keyOf(tk) };
      out.push(cur);
    });
    return out;
  }

  function mergeBlocks(originalMd, editedMd, lexer) {
    lexer = lexer || (typeof marked !== 'undefined' ? function (s) { return marked.lexer(s); } : null);
    var A = groups(originalMd, lexer), B = groups(editedMd, lexer);
    // links defined by reference ([x]: url) are not tokens; if the lexer dropped bytes, do not guess
    if (A.map(function (g) { return g.raw; }).join('') !== originalMd) return editedMd;
    var n = A.length, m = B.length, dp = [], i, j;
    for (i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--)
      dp[i][j] = A[i].key === B[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var out = '', prevFromOriginal = true; i = 0; j = 0;
    // leading blank lines of the original are kept as they are (the editor drops them)
    if (A.length && A[0].key === 'space') { out = A[0].raw; i = 1; if (B.length && B[0].key === 'space') j = 1; }
    function push(raw, fromOriginal) {
      if (out && !/\n$/.test(out)) out += '\n\n';
      else if (out && !/\n\n$/.test(out) && !fromOriginal && prevFromOriginal) out += '\n';
      out += raw; prevFromOriginal = fromOriginal;
    }
    while (i < n || j < m) {
      if (i < n && j < m && A[i].key === B[j].key) { push(A[i].raw, true); i++; j++; }
      else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { i++; }          // deleted: gone
      else { if (B[j].key !== 'space') push(B[j].raw, false); j++; }                  // inserted / changed
    }
    return out;
  }
  return { mergeBlocks: mergeBlocks, keyOf: keyOf };
}));
