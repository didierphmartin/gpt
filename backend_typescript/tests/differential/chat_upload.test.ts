/**
 * Upload parity — twin of backend_python/tests/differential/test_chat_upload.py: same multipart to
 * both backends; rows/files removed afterwards.
 *
 * WRITES: test_upload_parity_and_cleanup, test_docx_upload_divergence_is_environment_caused and
 * test_pptx_upload_divergence_is_environment_caused (each stores a chat_attachments row + a file
 * under chat-uploads/3, then deletes both). test_upload_validation_parity writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dtest, Harness, Client, same, sameKeys, assert } from './harness';

const FIXTURES = path.resolve(__dirname, '../../../backend_python/tests/fixtures/attachments');

function upload(client: Client, token: string, name: string, data: Buffer, ctype: string) {
  const form = new FormData();
  form.append('file', new Blob([data], { type: ctype }), name);
  return client.post('/api/v1/chat/upload', { body: form, headers: { Authorization: `Bearer ${token}` } });
}

async function removeAttachment(hx: Harness, id: unknown, mustExist: boolean): Promise<any> {
  const row = await hx.primaryDb.fetchOne('SELECT stored_path FROM chat_attachments WHERE id = ?', [id]);
  if (mustExist) assert.notEqual(row, null);
  if (row && fs.existsSync(row.stored_path)) fs.rmSync(row.stored_path);
  await hx.primaryDb.execute('DELETE FROM chat_attachments WHERE id = ?', [id]);
  return row;
}

dtest.write('test_upload_parity_and_cleanup', async (hx) => {
  const data = Buffer.from('differential upload body\n'.repeat(8));
  const a = await upload(hx.php, hx.token, 'diff.txt', data, 'text/plain');
  const b = await upload(hx.ts, hx.token, 'diff.txt', data, 'text/plain');
  assert.ok(a.status === 200 && b.status === 200, `${a.status} ${a.text}\n${b.status} ${b.text}`);
  const ja = a.json();
  const jb = b.json();
  sameKeys(ja, jb);
  sameKeys(ja.attachment, jb.attachment);
  for (const k of ['name', 'mime_type', 'size']) assert.equal(jb.attachment[k], ja.attachment[k]);
  assert.equal(ja.attachment.name, 'diff.txt');
  assert.equal(ja.attachment.mime_type, 'text/plain');
  assert.equal(ja.attachment.size, data.length);

  for (const j of [ja, jb]) {
    const row = await hx.primaryDb.fetchOne('SELECT stored_path FROM chat_attachments WHERE id = ?', [j.attachment.id]);
    try {
      assert.notEqual(row, null);
      assert.ok(String(row.stored_path).endsWith('.txt'));
      // Both backends store under the SAME physical root.
      assert.ok(path.dirname(row.stored_path).endsWith('/chat-uploads/3'));
      assert.ok(fs.statSync(row.stored_path).isFile());
      assert.deepStrictEqual(fs.readFileSync(row.stored_path), data);
    } finally {
      await removeAttachment(hx, j.attachment.id, false);
    }
  }
});

/**
 * KNOWN divergence, pinned so a libmagic upgrade tells us. This box's libmagic types a .docx as
 * `application/octet-stream`, and PHP's octet-stream branch (ChatAttachmentController.php:196-204)
 * maps only md/csv/html/json/txt — so PHP 415s it. The TS sniffer (ChatAttachmentController.ts
 * sniffMagic) sees the OOXML `PK\x03\x04` container, returns `application/zip`, and the zip
 * branch maps it to the docx MIME — so TS accepts it (same as the Python port).
 */
for (const [ext, ctype] of [
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
] as const) {
  dtest.write(`test_${ext}_upload_divergence_is_environment_caused`, async (hx) => {
    const data = fs.readFileSync(path.join(FIXTURES, `tiny.${ext}`));
    const a = await upload(hx.php, hx.token, `tiny.${ext}`, data, ctype);
    const b = await upload(hx.ts, hx.token, `tiny.${ext}`, data, ctype);
    try {
      assert.equal(a.status, 415, `PHP now accepts ${ext} (${a.status}) — libmagic upgraded?`);
      assert.ok(String(a.json().error).startsWith('Unsupported file type: application/octet-stream.'));
      assert.equal(b.status, 200, b.text);
      const jb = b.json();
      assert.equal(jb.attachment.mime_type, ctype);
      assert.ok(jb.attachment.name === `tiny.${ext}` && jb.attachment.size === data.length);
    } finally {
      if (b.status === 200) {
        const row = await removeAttachment(hx, b.json().attachment.id, true);
        assert.ok(String(row.stored_path).endsWith(`.${ext}`));
      }
    }
  });
}

dtest('test_upload_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/chat/upload', { json: {}, auth: false })));
  same(...(await hx.both('POST', '/api/v1/chat/upload', { json: {} })));
});
