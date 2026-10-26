import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './support/fakeDb';
import { GraphWorkflowRunner } from '../src/AgentTeam/GraphWorkflowRunner';

/**
 * Twin of backend/tests/Unit/AgentTeam/WorkflowDocumentPathTest.php: a document node's path reads
 * only files under the storage root folder (symlinks resolved).
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-doc-'));
fs.mkdirSync(path.join(base, 'synergyaichatroot/alice'), { recursive: true });
fs.writeFileSync(path.join(base, 'synergyaichatroot/alice/a.txt'), 'inside');
fs.writeFileSync(path.join(base, 'secret.txt'), 'outside');
fs.symlinkSync(path.join(base, 'secret.txt'), path.join(base, 'synergyaichatroot/alice/link.txt'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const runner: any = new GraphWorkflowRunner({ storage_path: base, workflow_runs_dir: os.tmpdir() });
const read = (doc: Record<string, string>): string | null => {
  const b = runner.readFileRaw(doc);
  return b === null ? null : b.toString('utf8');
};

test('a file under the root folder is read', () => {
  assert.equal(read({ path: 'alice/a.txt' }), 'inside');
  assert.equal(read({ fullPath: '/synergyaichatroot/alice/a.txt' }), 'inside');
});

test('paths leaving the root folder are refused', () => {
  for (const doc of [
    { path: '../secret.txt' },
    { fullPath: 'secret.txt' },
    { fullPath: 'synergyaichatroot/../secret.txt' },
    { fullPath: 'synergyaichatroot\\..\\secret.txt' },
    { path: 'alice/link.txt' },
    { fullPath: '/etc/passwd' },
  ]) {
    assert.equal(read(doc), null, JSON.stringify(doc));
  }
});
