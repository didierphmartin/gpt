// Skill-store strings that go through i18n exist in en, es and fr (t() returns the raw key when one is missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lang = (l) => JSON.parse(readFileSync(fileURLToPath(new URL(`../assets/i18n/${l}.json`, import.meta.url)), 'utf8'));
const get = (o, key) => key.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
const KEYS = [
  'skills.zip.noFile', 'skills.zip.unreadable', 'skills.zip.failed', 'skills.startup.label', 'skills.startup.desc',
  'skills.run.skillsRootUnavailable', 'skills.run.robotRefusal', 'skills.bundle.unknownFiles',
  'skills.import.alsoInstalls', 'skills.import.alreadyInstalled', 'skills.import.requiredClash', 'skills.import.alsoInstalled',
  'skills.zip.requiresMissing', 'skills.run.skillsRootReadOnly', 'workflow.package.alsoInstalls',
  'skills.requiredBy.delete', 'skills.requiredBy.rename', 'skills.requiredBy.private', 'skills.requiredBy.public',
  'skills.visibility.confirmAlso', 'skills.visibility.confirmTitle', 'skills.requiredBy.changed', 'workflow.package.reasonRequiredClash',
];

test('skill-store i18n keys exist in en, es and fr with the same placeholders', () => {
  const en = lang('en');
  for (const l of ['en', 'es', 'fr']) {
    const d = lang(l);
    for (const k of KEYS) {
      const v = get(d, k);
      assert.equal(typeof v, 'string', `${l}: ${k}`);
      assert.deepEqual((v.match(/\{\{\w+\}\}/g) || []).sort(), (get(en, k).match(/\{\{\w+\}\}/g) || []).sort(), `${l}: ${k}`);
    }
  }
});

test('the runner and the skills manager name these keys (no new English literals)', () => {
  const src = (f) => readFileSync(fileURLToPath(new URL(`../assets/js/${f}`, import.meta.url)), 'utf8');
  const runner = src('pyodide-runner.js');
  for (const k of ['skills.run.skillsRootUnavailable', 'skills.run.robotRefusal', 'skills.bundle.unknownFiles']) assert.ok(runner.includes(`'${k}'`), k);
  const mgr = src('skills-manager.js');
  for (const k of ['skills.zip.noFile', 'skills.zip.unreadable', 'skills.startup.label', 'skills.startup.desc']) assert.ok(mgr.includes(`'${k}'`), k);
  assert.doesNotMatch(mgr, /No file selected|Checking your existing skills|\{ message: '' \}/);
});
