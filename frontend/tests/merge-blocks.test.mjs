import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { marked } = require('marked');
const { merge, mergeBlocks } = require('../tools/md-roundtrip/merge-blocks.js');
const M = { lexer: (s) => marked.lexer(s), parse: (s) => marked.parse(s) };
const mb = (o, e) => mergeBlocks(o, e, M);

// [name, original, edited, expected]: 'edit' = the edit MUST be in the result; 'orig' = same meaning, original bytes kept
const meaning = [
  ['star -> underscore emphasis (same meaning)', 'Say *hello* now.\n', 'Say _hello_ now.\n', 'orig'],
  ['user removes an escape: literal \\*a\\* -> emphasis', 'Use \\*a\\* literally.\n', 'Use *a* literally.\n', 'edit'],
  ['user adds an escape', 'Use *a* here.\n', 'Use \\*a\\* here.\n', 'edit'],
  ['list marker - -> * (same meaning)', '- a\n- b\n', '* a\n* b\n', 'orig'],
  ['ordered -> bullet', '1. a\n2. b\n', '- a\n- b\n', 'edit'],
  ['user adds <br>', 'line one\n', 'line one<br>\n', 'edit'],
  ['user removes <br> in a paragraph', 'a<br>b\n', 'ab\n', 'edit'],
  ['double space -> single space', 'a  b\n', 'a b\n', 'edit'],
  ['hard break (2 spaces) removed', 'a  \nb\n', 'a\nb\n', 'edit'],
  ['hard break added', 'a\nb\n', 'a  \nb\n', 'edit'],
  ['nested list flattened', '- a\n  - b\n', '- a\n- b\n', 'edit'],
  ['task [ ] -> [x]', '- [ ] a\n', '- [x] a\n', 'edit'],
  ['code span fence changes content', 'Use ``a`b`` x\n', 'Use `a`b` x\n', 'edit'],
  ['code span padding (same meaning)', 'Use ` a ` x\n', 'Use `a` x\n', 'orig'],
  ['code block: line indent removed', '```\n  x\n```\n', '```\nx\n```\n', 'edit'],
  ['code block: indent changed in the middle', '```py\nif a:\n    b\n```\n', '```py\nif a:\nb\n```\n', 'edit'],
  ['code block: blank line removed', '```\na\n\nb\n```\n', '```\na\nb\n```\n', 'edit'],
  ['code block: language tag changed', '```py\nx\n```\n', '```js\nx\n```\n', 'edit'],
  ['fence info string: title changed', '```py title="a.py"\nx\n```\n', '```py title="b.py"\nx\n```\n', 'edit'],
  ['fence info string: {linenos} dropped', '```py {linenos}\nx\n```\n', '```py\nx\n```\n', 'edit'],
  ['fence info string unchanged (same bytes kept)', '```py title="a.py"\nx\n```\n', '~~~py title="a.py"\nx\n~~~\n', 'orig'],
  ['table padding / dash width (same meaning)', '|a|b|\n|-|-|\n|1|2|\n', '| a | b |\n|---|---|\n| 1 | 2 |\n', 'orig'],
  ['table alignment changed', '|a|\n|:--|\n|1|\n', '|a|\n|:-:|\n|1|\n', 'edit'],
  ['table cell text edited', '|a|\n|-|\n|x y|\n', '|a|\n|-|\n|xy|\n', 'edit'],
  ['blockquote: paragraph split', '> a\n>\n> b\n', '> a\n> b\n', 'edit'],
  ['blockquote: text edited', '> a\n>\n> b\n', '> a\n>\n> c\n', 'edit'],
  ['link text == url vs autolink (same meaning)', 'See [http://x.com](http://x.com)\n', 'See <http://x.com>\n', 'orig'],
  ['link target changed', 'See [x](http://x.com)\n', 'See [x](http://y.com)\n', 'edit'],
  ['autolink -> plain text', 'See <http://x.com>\n', 'See http://x.com\n', 'orig'], // gfm renders a bare url as a link
  ['<u> removed', 'a <u>b</u>\n', 'a b\n', 'edit'],
  ['heading level', '## A\n', '### A\n', 'edit'],
  ['setext -> atx (same meaning)', 'A\n===\n', '# A\n', 'orig'],
  ['hr style (same meaning)', '***\n', '---\n', 'orig'],
  ['\\# literal -> heading', '\\# not heading\n', '# not heading\n', 'edit'],
  ['1\\. -> 1.', '1\\. foo\n', '1. foo\n', 'edit'],
  ['ordered start 1 -> 2', '1. a\n', '2. a\n', 'edit'],
  ['emphasis removed', 'a _x_ b\n', 'a x b\n', 'edit'],
  ['snake_case word edited', 'call my_func_name now\n', 'call my_func_nam now\n', 'edit'],
  ['snake_case becomes emphasis', 'call my_func_name now\n', 'call my*func*name now\n', 'edit'],
  ['backslash in a path removed', 'C:\\\\x\n', 'C:\\x\n', 'orig'], // both render C:\x
  ['backslash dropped before a letter changes nothing visible', 'a \\q b\n', 'a q b\n', 'edit'], // \q renders \q, q renders q
  ['an extra word', 'one two\n', 'one two three\n', 'edit'],
  ['whitespace-only indent change inside a list item code block', '- a\n\n  ```\n  x\n  ```\n', '- a\n\n  ```\n    x\n  ```\n', 'edit'],
];
for (const [name, o, e, want] of meaning) {
  test(name, () => {
    const got = mb(o, e);
    if (want === 'edit') { assert.equal(got, e, 'the edit must be in the result'); assert.notEqual(got, o); }
    else assert.equal(got, o, 'a change with no meaning keeps the original bytes');
  });
}

test('unchanged blocks keep their original bytes, the edited block takes the edit', () => {
  const o = '# Title\n\nPara   one  with *odd*   spacing.\n\n- a\n- b\n\n```py\nx  =  1\n```\n\nLast.\n';
  const e = '# Title\n\nPara one with odd spacing EDIT.\n\n- a\n- b\n\n```py\nx = 1\n```\n\nLast.\n';
  const got = mb(o, e);
  assert.ok(got.includes('Para one with odd spacing EDIT.'));
  assert.ok(got.includes('x  =  1') === false && got.includes('x = 1'));
  assert.ok(got.startsWith('# Title\n\n'));
  assert.ok(got.endsWith('Last.\n'));
});
test('nothing changed: identical bytes', () => {
  const o = '\n# T\n\ntext\n\n* a\n* b\n\n---\n\n| a | b |\n|--|--|\n| 1 | 2 |\n';
  assert.equal(mb(o, '# T\n\ntext\n\n- a\n- b\n\n***\n\n|a|b|\n|-|-|\n|1|2|'), o);
});
test('inserted block appears, deleted block disappears, order kept', () => {
  assert.equal(mb('a\n\nb\n\nc\n', 'a\n\nNEW\n\nb\n\nc'), 'a\n\nNEW\n\nb\n\nc\n');
  assert.equal(mb('a\n\nb\n\nc\n', 'a\n\nc'), 'a\n\nc\n');
});
test('leading blank lines and the final newline are kept', () => {
  assert.equal(mb('\n\nhello\n', 'hello'), '\n\nhello\n');
  assert.equal(mb('hello\n', 'hello EDIT'), 'hello EDIT\n');
});
test('a changed block next to an unchanged one keeps a blank line between them', () => {
  assert.equal(mb('# H\ntext\n', '# H\n\nNEW text'), '# H\n\nNEW text\n');
});
test('reference definitions are not tokens: the merge is refused and says so', () => {
  const r = merge('see [x]\n\n[x]: http://a\n', 'see [x] EDIT\n\n[x]: http://a\n', M);
  assert.equal(r.merged, false);
  assert.match(r.reason, /definition/);
  assert.equal(r.md, 'see [x] EDIT\n\n[x]: http://a\n');
});
test('refused when the edited side has a definition too', () => {
  const r = merge('plain\n', 'plain\n\n[x]: http://a\n', M);
  assert.equal(r.merged, false);
});
test('html comments and html blocks survive', () => {
  const o = 'a\n\n<!-- keep me -->\n\n<div>x</div>\n\nb\n';
  assert.equal(mb(o, 'a\n\n<!-- keep me -->\n\n<div>x</div>\n\nb EDIT'), o.replace('b\n', 'b EDIT\n'));
});
