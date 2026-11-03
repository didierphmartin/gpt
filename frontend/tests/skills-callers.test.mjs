import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every skill read and write goes through window.skillsFs (folder or skill store):
// only skills-fs.js (the storage module) and local-fs.js (the folder itself) may
// resolve a path under skills/ on the local folder.
const JS_DIR = fileURLToPath(new URL('../assets/js/', import.meta.url));
const ALLOWED = new Set(['skills-fs.js', 'local-fs.js']);
// resolvePath('skills…'), resolvePath("skills…"), resolvePath(`skills…`), also across a line break;
// and a raw getDirectoryHandle('skills') on the storage root.
const SKILLS_PATH = /(resolvePath|resolveCached)\(\s*['"`]skills\b|getDirectoryHandle\(\s*['"`]skills['"`]/;

const files = readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));

test('the scan sees the frontend modules', () => {
  assert.ok(files.includes('pyodide-runner.js') && files.includes('chat.js') && files.includes('skills-fs.js'));
  assert.match("x = await window.localFs.resolvePath(`skills/${d}`)", SKILLS_PATH);
  assert.match("x = await window.localFs.resolvePath(\n  'skills')", SKILLS_PATH);
  assert.match('x = await window.localFs.resolvePath("skills/a")', SKILLS_PATH);
});

test('no file except skills-fs.js and local-fs.js resolves skills/ on the local folder', () => {
  const offenders = [];
  for (const f of files) {
    if (ALLOWED.has(f)) continue;
    const src = readFileSync(JS_DIR + f, 'utf8');
    src.split('\n').forEach((line, i) => {
      // Join each line with the next so a call broken after "(" is still caught.
      const pair = line + '\n' + (src.split('\n')[i + 1] || '');
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (SKILLS_PATH.test(line) || (/(resolvePath|resolveCached)\(\s*$/.test(line) && SKILLS_PATH.test(pair))) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
