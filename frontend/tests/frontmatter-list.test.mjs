// Every reader of a frontmatter list (dependencies:, requires-skills:) splits on commas OUTSIDE quotes, so what the
// frontmatter form writes for a pip range or extras reads back as written. The same table runs through the PHP
// reader and the emitted Python (backend/tests/Unit/FrontmatterListReadersTest.php).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SR = require('../assets/js/skill-requires.js');
const SZ = require('../assets/js/skill-zip.js');
const SF = require('../assets/js/skill-frontmatter.js');
const { cases, form } = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/frontmatter-list-cases.json', import.meta.url)), 'utf8'));

// pyodide-runner.js is a browser IIFE: run its parseDepsField alone, with window.SkillRequires.
const RUNNER = readFileSync(fileURLToPath(new URL('../assets/js/pyodide-runner.js', import.meta.url)), 'utf8');
const fnSrc = RUNNER.match(/    function parseDepsField\(value\) \{[\s\S]*?\n    \}\n/)[0];
const ctx = vm.createContext({ window: { SkillRequires: SR } });
vm.runInContext(fnSrc + '\nthis.parseDepsField = parseDepsField;', ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));

const readers = {
    'SkillRequires.listItems': (v) => SR.listItems(v),
    'SkillZip.skillDependencies': (v) => SZ.skillDependencies(`---\nname: a\ndependencies: ${v}\n---\nbody\n`),
    'SkillRequires.declared': (v) => SR.declared(`---\nname: a\nrequires-skills: ${v}\n---\n`),
    'pyodide-runner parseDepsField': (v) => plain(ctx.parseDepsField(v)),
};

for (const [name, read] of Object.entries(readers)) {
    test(`${name}: the shared list table`, () => {
        for (const c of cases) assert.deepEqual(read(c.value), c.items, c.name + ': ' + c.value);
    });
    test(`${name}: what the form writes reads back as the items`, () => {
        assert.deepEqual(read(form.value), form.items);
    });
}

test('the form writes the fixture line for a range, extras and quotes (pins the shared fixture)', () => {
    const out = SF.rebuild('name: a\ndescription: b\n', { dependencies: form.items, 'requires-skills': form.items });
    assert.equal(out, `name: a\ndescription: b\ndependencies: ${form.value}\nrequires-skills: ${form.value}\n`);
    const md = `---\n${out}---\n`;
    assert.deepEqual(SZ.skillDependencies(md), form.items);
    assert.deepEqual(SR.declared(md), form.items);
});
