import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SF = createRequire(import.meta.url)('../assets/js/skill-frontmatter.js');
const doc = (front, body = 'Body\n', eol = '\n') =>
  ['---', ...front.split('\n'), '---'].join(eol) + eol + body;

const SAMPLE = [
  'name: demo',
  'description: >',
  '  Use this skill when: the user',
  '  wants things.',
  '',
  'dependencies:',
  '  - alpha',
  '  - beta',
  'allowed-tools: run_skill_script',
  'metadata:',
  '  author: me',
  '  tags: [a, b]',
].join('\n');

test('split: front, body, eol', () => {
  const r = SF.split(doc('name: x\ndescription: y'));
  assert.equal(r.front, 'name: x\ndescription: y\n');
  assert.equal(r.body, 'Body\n');
  assert.equal(r.eol, '\n');
  assert.equal(SF.split('# no front\n').front, null);
  assert.equal(SF.split('# no front\n').body, '# no front\n');
  assert.equal(SF.split('---\nname: x\nno close\n').front, null);
  assert.equal(SF.split(doc('a: 1', 'x', '\r\n')).eol, '\r\n');
});

test('join(split(t)) is byte identical, incl. no final newline, empty front, CRLF', () => {
  for (const t of [doc(SAMPLE), doc(SAMPLE, 'no newline at end'), doc(SAMPLE, '', '\r\n'),
    '---\n---\nbody', '---\nname: a\n---', '---\nname: a\n---\n', '---  \na: 1\n--- \nb', 'plain']) {
    assert.equal(SF.join(SF.split(t)), t);
  }
});

test('fields: spans, values, complex', () => {
  const f = SF.fields(SAMPLE + '\n');
  const by = Object.fromEntries(f.filter((x) => x.key).map((x) => [x.key, x]));
  assert.equal(by.name.value, 'demo');
  assert.equal(by.description.value, 'Use this skill when: the user wants things.\n');
  assert.deepEqual(by.dependencies.value, ['alpha', 'beta']);
  assert.equal(by['allowed-tools'].value, 'run_skill_script');
  assert.equal(by.metadata.complex, true);
  assert.equal(f.map((x) => x.raw).join(''), SAMPLE + '\n');
  assert.equal(by.description.start, 1);
  assert.equal(by.description.end, 5);
});

test('fields: scalars, quotes, flow lists, literal and chomping', () => {
  const v = (s) => SF.fields(s + '\n')[0];
  assert.equal(v('a: "x: y \\"q\\" \\\\"').value, 'x: y "q" \\');
  assert.equal(v("a: 'it''s'").value, "it's");
  assert.deepEqual(v('a: [x, "y, z", \'w\']').value, ['x', 'y, z', 'w']);
  assert.deepEqual(v('a: []').value, []);
  assert.equal(v('a: |\n  l1\n  l2\n').value, 'l1\nl2\n');
  assert.equal(v('a: |-\n  l1\n  l2\n').value, 'l1\nl2');
  assert.equal(v('a: >-\n  l1\n  l2\n\n  l3\n').value, 'l1 l2\nl3');
  assert.equal(v('a: |+\n  l1').value, 'l1\n');
  assert.equal(v('a: |+\n  l1\n').value, 'l1\n\n');
  assert.equal(v('a:').value, '');
  assert.equal(v('a: {x: 1}').complex, true);
  assert.equal(v('a: {x: 1}').value, '{x: 1}');
  assert.equal(v('a: foo # note').complex, true);
  assert.equal(v('a: &anchor x').complex, true);
});

test('fields: top-level comment before first key is its own span; trailing comment stays in span', () => {
  const f = SF.fields('# hi\nname: x\n# about desc\ndescription: y\n');
  assert.equal(f[0].key, null);
  assert.equal(f[0].raw, '# hi\n');
  assert.equal(f[1].raw, 'name: x\n# about desc\n');
});

test('rebuild: {} is identity', () => {
  assert.equal(SF.rebuild(SAMPLE + '\n', {}), SAMPLE + '\n');
});

test('rebuild: editing dependencies leaves the block-scalar description byte-for-byte', () => {
  const out = SF.rebuild(SAMPLE + '\n', { dependencies: ['alpha', 'gamma'] });
  assert.equal(out, SAMPLE.replace('dependencies:\n  - alpha\n  - beta', 'dependencies: [alpha, gamma]') + '\n');
});

test('rebuild: unchanged value passed back keeps the original form', () => {
  const out = SF.rebuild(SAMPLE + '\n', { dependencies: ['alpha', 'beta'], description: 'Use this skill when: the user wants things.\n' });
  assert.equal(out, SAMPLE + '\n');
});

test('rebuild: null removes, new key appends, optional empty list written', () => {
  const f = 'name: a\ndescription: b\nrequires-skills: [x, y]\nlicense: MIT\n';
  assert.equal(SF.rebuild(f, { 'requires-skills': null }), 'name: a\ndescription: b\nlicense: MIT\n');
  assert.equal(SF.rebuild('name: a\ndescription: b\n', { 'requires-skills': ['x', 'y z'] }),
    'name: a\ndescription: b\nrequires-skills: [x, y z]\n');
  assert.equal(SF.rebuild('name: a\n', { dependencies: [] }), 'name: a\ndependencies: []\n');
  assert.equal(SF.rebuild('', { name: 'a' }), 'name: a\n');
});

test('rebuild: quoting (single quotes, no escapes)', () => {
  const w = (v) => SF.rebuild('name: a\n', { description: v });
  assert.equal(w('Use: this'), "name: a\ndescription: 'Use: this'\n");
  assert.equal(w('[x]'), "name: a\ndescription: '[x]'\n");
  assert.equal(w(" pad "), "name: a\ndescription: pad\n");
  assert.equal(SF.rebuild('name: a\n', { x: '' }), "name: a\nx: ''\n");
  assert.equal(SF.rebuild('name: a\n', { dependencies: ['a,b', 'c'] }), "name: a\ndependencies: ['a,b', c]\n");
  assert.equal(w(`it's: x`), `name: a\ndescription: "it's: x"\n`);
  assert.equal(w(`it's "x"`), `name: a\ndescription: it's "x"\n`);
  assert.equal(w(`a: it's "x"`), `name: a\ndescription: 'a: it''s "x"'\n`);
});

test('rebuild: bool/null/number-like strings are quoted', () => {
  for (const v of ['true', 'False', 'YES', 'no', 'On', 'off', 'null', '~', '1.10', '0x1', '12', '-3', '1e5', '.5']) {
    assert.equal(SF.rebuild('', { k: v }), `k: '${v}'\n`, v);
  }
  assert.equal(SF.rebuild('', { k: '1.0.2' }), 'k: 1.0.2\n');
  assert.equal(SF.rebuild('', { k: 'trueish' }), 'k: trueish\n');
});

test('rebuild: written lines read back through the app parser (skillsFs.parseFrontmatter)', () => {
  const sandbox = { window: {}, console, TextEncoder, TextDecoder, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../assets/js/skills-fs.js', import.meta.url), 'utf8'), sandbox);
  const pf = sandbox.window.skillsFs.parseFrontmatter;
  const cases = [
    ['multi-line', 'line one\nline two\n', 'line one line two'],
    ['colon', 'Use this skill when: the user asks', 'Use this skill when: the user asks'],
    ['dquote', 'say "hi" now', 'say "hi" now'],
    ['squote', "it's fine", "it's fine"],
    ['hash', 'a # b', 'a # b'],
    ['hash-lead', '#tag', '#tag'],
    ['colon+squote', "Use: it's", "Use: it's"],
    ['bool', 'true', 'true'],
    ['num', '1.10', '1.10'],
  ];
  for (const [n, input, want] of cases) {
    const front = SF.rebuild('', { name: 'x', description: input });
    const meta = pf('---\n' + front + '---\nbody').meta;
    assert.equal(meta.description, want, n);
  }
});

test('rebuild: duplicate keys', () => {
  const f = 'name: a\nlicense: MIT\ndescription: b\nlicense: GPL\n';
  assert.equal(SF.rebuild(f, { license: null }), 'name: a\ndescription: b\n');
  assert.equal(SF.rebuild(f, { license: 'X' }), 'name: a\nlicense: X\ndescription: b\n');
  assert.equal(SF.rebuild(f, { license: 'MIT' }), 'name: a\nlicense: MIT\ndescription: b\n');
});

test('rebuild: front without final newline gets eol before an appended key', () => {
  assert.equal(SF.rebuild('name: a', { x: 'val' }), 'name: a\nx: val\n');
  assert.equal(SF.rebuild('name: a\r\ndescription: b', { x: 'val' }), 'name: a\r\ndescription: b\r\nx: val\r\n');
});

test('rebuild: --- inside a block scalar is untouched while another key is edited', () => {
  const f = 'name: a\ndescription: |\n  para\n  ---\n  more\nlicense: MIT\n';
  assert.equal(SF.rebuild(f, { license: 'X' }), 'name: a\ndescription: |\n  para\n  ---\n  more\nlicense: X\n');
});

test('rebuild: edit a complex field with a plain value, keeps trailing comment', () => {
  const out = SF.rebuild('name: a\nmetadata:\n  k: v\n# keep\nlicense: MIT\n', { metadata: 'none' });
  assert.equal(out, 'name: a\nmetadata: none\n# keep\nlicense: MIT\n');
});

test('rebuild: name/description cannot be emptied or removed', () => {
  assert.throws(() => SF.rebuild('name: a\ndescription: b\n', { name: '' }));
  assert.throws(() => SF.rebuild('name: a\ndescription: b\n', { description: '' }));
  assert.throws(() => SF.rebuild('name: a\ndescription: b\n', { description: null }));
});

test('rebuild: CRLF preserved for untouched and new lines', () => {
  const t = doc(SAMPLE, 'B\r\n', '\r\n');
  const s = SF.split(t);
  assert.equal(SF.rebuild(s.front, {}), s.front);
  const out = SF.rebuild(s.front, { dependencies: ['z'], extra: 'v' });
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF');
  assert.ok(out.endsWith('extra: v\r\n'));
  assert.ok(out.includes('dependencies: [z]\r\n'));
});

const ROOT = join(homedir(), 'Documents', 'synergyAI', 'skills');
function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n === 'SKILL.md') out.push(p);
  }
  return out;
}
test('corpus: every real SKILL.md round-trips byte-for-byte', { skip: !existsSync(ROOT) && `no ${ROOT}` }, () => {
  const files = walk(ROOT);
  assert.ok(files.length > 20, 'found ' + files.length);
  for (const p of files) {
    const t = readFileSync(p, 'utf8');
    const s = SF.split(t);
    assert.equal(SF.join(s), t, p);
    if (s.front !== null) {
      assert.equal(SF.rebuild(s.front, {}), s.front, p);
      assert.equal(SF.fields(s.front).map((f) => f.raw).join(''), s.front, p);
      const names = SF.fields(s.front).filter((f) => f.key === 'name');
      assert.equal(names.length, 1, p);
    }
  }
  console.log('corpus files:', files.length);
});
