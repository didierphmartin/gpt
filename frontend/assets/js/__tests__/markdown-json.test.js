/**
 * JSON is pretty-printed wherever markdown is rendered (markdown-renderer.js): a text that IS
 * JSON becomes an indented ```json block, and ```json blocks inside markdown are re-indented.
 * Anything that is not valid JSON is left exactly as written.
 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const window = {};
vm.runInNewContext(fs.readFileSync(__dirname + '/../markdown-renderer.js', 'utf8'),
    { window, console: { warn() {}, error() {} } });
const pretty = window.prettyJsonMarkdown;

// a whole answer that is JSON (a code node's output)
assert.strictEqual(pretty('{"task": "t1", "answers": {"email": "a@b.c"}}'),
    '```json\n{\n  "task": "t1",\n  "answers": {\n    "email": "a@b.c"\n  }\n}\n```');
assert.strictEqual(pretty('  [1, 2]  '), '```json\n[\n  1,\n  2\n]\n```');
// a JSON scalar is just text
assert.strictEqual(pretty('42'), '42');
assert.strictEqual(pretty('"hello"'), '"hello"');
assert.strictEqual(pretty('null'), 'null');

// a ```json inclusion in markdown is re-indented, the prose around it untouched
assert.strictEqual(pretty('Result:\n\n```json\n{"a":1,"b":[true,null]}\n```\n\nDone.'),
    'Result:\n\n```json\n{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}\n```\n\nDone.');
// ... JSON (upper case) too, and two blocks each on their own
assert.strictEqual(pretty('```JSON\n{"x":1}\n```\ntext\n```json\n[2]\n```'),
    '```json\n{\n  "x": 1\n}\n```\ntext\n```json\n[\n  2\n]\n```');
// invalid JSON in a json block stays exactly as written
assert.strictEqual(pretty('```json\n{"a": 1,}\n```'), '```json\n{"a": 1,}\n```');
// prose is not JSON
assert.strictEqual(pretty('Hello {world}'), 'Hello {world}');
// other languages' blocks are left alone
assert.strictEqual(pretty('```js\nconst a = {"b":1}\n```'), '```js\nconst a = {"b":1}\n```');
assert.strictEqual(pretty(''), '');
console.log('markdown-json.test.js: OK');
