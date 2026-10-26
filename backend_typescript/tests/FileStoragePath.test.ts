import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './support/fakeDb';
import { FileStorageController } from '../src/Controllers/FileStorageController';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/Controllers/FileStoragePathTest.php: storage paths stay inside the
 * user's own folder. Plus a local read of a listed path (storage root + path, not user_<id>/).
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-storage-'));
fs.mkdirSync(path.join(base, 'synergyaichatroot/alice'), { recursive: true });
fs.writeFileSync(path.join(base, 'synergyaichatroot/alice/a.txt'), 'inside');
after(() => fs.rmSync(base, { recursive: true, force: true }));

let c: FileStorageController;

beforeEach(() => {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, storage_provider TEXT, storage_folder TEXT)');
  d.exec("INSERT INTO users VALUES (1, 'local', 'alice'), (2, 'local', '../..')");
  installFakeDb((sqlText, params) => d.prepare(sqlText).all(...(params as any[])) as any[]);
  c = new FileStorageController(base);
});

function ctx(userId: number, query: Record<string, unknown>): Ctx {
  return { method: 'GET', uri: '/', headers: {}, query, body: {}, user_id: userId, auth_type: 'jwt', params: {}, remote_addr: '127.0.0.1' } as any;
}

test('list refuses . and .. segments and NUL', async () => {
  for (const p of ['..', '../../backend', 'a/../../b', './x', 'a\0b']) {
    const r: any = await c.listFiles(ctx(1, { path: p }));
    assert.equal(r.success, false, p);
    assert.equal(r.error, 'Invalid path');
    assert.deepEqual(r.items, []);
  }
});

test('read refuses paths outside the user folder', async () => {
  for (const fileId of [
    '../../backend/.env',
    '/etc/passwd',
    'synergyaichatroot/bob/x.txt',
    'synergyaichatroot/alice/../bob/x.txt',
    'synergyaichatroot/alice',
    'synergyaichatroot/alicex/x.txt',
  ]) {
    const r = await c.readFile(ctx(1, { fileId }));
    assert.deepEqual(r, { success: false, error: 'File not found' }, fileId);
  }
});

test('a .. storage folder setting counts as none', async () => {
  const r: any = await c.readFile(ctx(2, { fileId: 'synergyaichatroot/x.txt' }));
  assert.equal(r.error, 'File not found');
  const l: any = await c.listFiles(ctx(2, {}));
  assert.deepEqual(l.items, []);
  assert.equal(l.userFolder, '');
});

test('a listed path reads from the storage root', async () => {
  const r: any = await c.readFile(ctx(1, { fileId: 'synergyaichatroot/alice/a.txt' }));
  assert.equal(r.success, true);
  assert.equal(r.content, 'inside');
  const l: any = await c.listFiles(ctx(1, {}));
  assert.deepEqual(l.items.map((i: any) => i.path), ['synergyaichatroot/alice/a.txt']);
});
