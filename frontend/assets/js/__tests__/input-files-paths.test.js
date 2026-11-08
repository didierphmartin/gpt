const assert = require('assert');
const P = require('../input-files-paths.js');

const mount = '/skill/servicenow-automation-author';

// The usual keys stage.
for (const ok of ['/scratch/spec.json', ' /scratch/spec.json ', '/outputs/report.html', '/tmp/x/y.csv', '/skills-root-not/x']) {
    assert.strictEqual(P.problem(ok, mount), null, ok);
}
assert.strictEqual(P.refusal({ '/scratch/a.json': '{}', '/scratch/b.html': '<p/>' }, mount), null);
assert.strictEqual(P.refusal(null, mount), null);
assert.strictEqual(P.refusal({}, mount), null);

// 2026-11-07, DeepSeek: part of the JSON spec arrived as the key. It became a file in the skill
// mount whose name the File System Access API refuses, and every later run on the page failed.
const contentKey = '    "language": "en",\n    "form": {\n      "submitted_by": "An employee"';
assert.match(P.problem(contentKey, mount), /looks like file content/);

// A relative key would be written into the skill folder (the user's real folder in folder mode).
assert.match(P.problem('okta-password-reset.json', mount), /not an absolute path/);
assert.match(P.problem(`${mount}/okta-password-reset.json`, mount), /inside the skill folder/);
assert.match(P.problem('/skill/other-skill/x.json', mount), /inside the skill folder/);
assert.match(P.problem('/scratch/../skill/x', mount), /"\.\."/);
assert.match(P.problem(`/scratch/${'a'.repeat(256)}`, mount), /longer than 255/);
assert.match(P.problem('   ', mount), /empty/);
assert.match(P.problem('/', mount), /names no file/);

// The message names every bad key (shortened), keeps the good ones out, and shows the right form.
const msg = P.refusal({ '/scratch/ok.json': '{}', [contentKey]: '{}', 'spec.json': '{}' }, mount);
assert.match(msg, /^input_files refused, nothing was run\./);
assert.match(msg, /"\/scratch\/spec\.json"/);
assert.match(msg, /- "spec\.json": it is not an absolute path/);
assert.match(msg, /- ""language": "en", "form": \{ "submitted_by": "An employee"": it contains a quote/);
const longLine = P.refusal({ [contentKey + ' locked out of Okta, from the service catalog."']: '' }, mount).split('\n')[1];
assert.match(longLine, /^- ".{57}\.\.\.": it contains a quote/);
assert.doesNotMatch(msg, /ok\.json/);
assert.strictEqual(msg.split('\n').filter((l) => l.startsWith('- ')).length, 2);

console.log('input-files-paths ok');
