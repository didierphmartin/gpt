// A folder (or GitHub path, or old zip) carries only the skill: the import must find the skills it requires
// (installed, the local SynergyAI skills folder, or extra sources) and refuse before writing when one is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skills-import.js', import.meta.url)), 'utf8');
const enc = (s) => new TextEncoder().encode(s);

const AUTO = {
  'SKILL.md': enc('---\nname: auto\ndescription: d\n---\n'),
  'scripts/create.py': enc("flow = load_script('flow-author', 'create.py')\npb = load_script('pb-author', 'create.py')\n"),
};
const FLOW = { 'SKILL.md': enc('---\nname: flow-author\ndescription: d\n---\n') };
const PB = { 'SKILL.md': enc('---\nname: pb-author\ndescription: d\n---\n'), 'scripts/x.py': enc("load_script('wf-compile', 'c.py')\n") };
const WF = { 'SKILL.md': enc('---\nname: wf-compile\ndescription: d\n---\n') };

/** skills-import.js in a sandbox: `store` = installed (Docker storage), `folder` = the local SynergyAI skills folder. */
function load({ store = {}, folder = {}, mode = 'volume', granted = true } = {}) {
  const SkillRequires = require('../assets/js/skill-requires.js');
  const skillsFs = {
    mode: async () => mode,
    listSkills: async () => Object.keys(store).map((dirName) => ({ dirName })),
    readSkillFiles: async (p) => store[p] || {},
    listFolderSkills: async () => Object.keys(folder).map((dirName) => ({ dirName })),
    readFolderSkillFiles: async (p) => folder[p] || {},
  };
  const window = { skillsFs, SkillRequires, localFs: { getStatus: async () => ({ state: granted ? 'granted' : 'prompt' }) }, i18n: { t: (k, p) => `${k}${JSON.stringify(p || {})}` } };
  const ctx = vm.createContext({ window, console, TextEncoder, TextDecoder, Uint8Array });
  vm.runInContext(SRC, ctx);
  return window.skillsImport;
}

test('a folder import in the Docker app takes its required skills from the local skills folder, dependencies first', async () => {
  const si = load({ folder: { 'flow-author': FLOW, 'pb-author': PB, 'wf-compile': WF } });
  const read = await si._attachRequires({ dir: 'auto', name: 'auto', files: AUTO, pyodideWheels: {}, nativeWheels: {} });
  const dirs = read.requires.map((r) => r.dir);
  assert.equal(JSON.stringify([...dirs].sort()), JSON.stringify(['flow-author', 'pb-author', 'wf-compile']));
  assert.ok(dirs.indexOf('wf-compile') < dirs.indexOf('pb-author'), 'a required skill comes after what it needs');
  assert.ok(read.requires.every((r) => r.files['SKILL.md']));
});

test('a required skill already installed is carried from the store (reported identical at install)', async () => {
  const si = load({ store: { 'flow-author': FLOW, 'pb-author': PB, 'wf-compile': WF } });
  const read = await si._attachRequires({ dir: 'auto', name: 'auto', files: AUTO, pyodideWheels: {}, nativeWheels: {} });
  assert.equal(read.requires.length, 3);
});

test('a DECLARED required skill found nowhere refuses the import before anything is written, naming it', async () => {
  // Scanning can only recognise names of skills that exist somewhere; requires-skills: names them for certain.
  const PB_DECL = { ...PB, 'SKILL.md': enc('---\nname: pb-author\ndescription: d\nrequires-skills: [wf-compile]\n---\n') };
  const si = load({ folder: { 'flow-author': FLOW, 'pb-author': PB_DECL } });
  await assert.rejects(
    () => si._attachRequires({ dir: 'auto', name: 'auto', files: AUTO, pyodideWheels: {}, nativeWheels: {} }),
    (e) => /skills\.import\.requiresNotFound/.test(e.message) && /wf-compile/.test(e.message));
});

test('extra sources (sibling folders of a GitHub repo) fill what is neither installed nor local', async () => {
  const si = load({ folder: { 'flow-author': FLOW } });
  const repo = { 'pb-author': PB, 'wf-compile': WF };
  const read = await si._attachRequires({ dir: 'auto', name: 'auto', files: AUTO, pyodideWheels: {}, nativeWheels: {} },
    { names: Object.keys(repo), read: async (n) => repo[n] || null });
  assert.equal(read.requires.length, 3);
});

test('Docker app without access to the local folder: flagged so the review can ask for access, nothing read from it', async () => {
  const si = load({ folder: { 'flow-author': FLOW, 'pb-author': PB, 'wf-compile': WF }, granted: false });
  const read = await si._attachRequires({ dir: 'auto', name: 'auto', files: AUTO, pyodideWheels: {}, nativeWheels: {} });
  assert.equal(read.localUnavailable, true);
  assert.equal(read.requires.length, 0);
});
