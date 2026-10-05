import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// The store module imports the db pools (lazy connections, but config needs env vars): dummy values, set before the import.
for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS', 'JWT_SECRET']) {
  process.env[k] ||= 'x';
}
type Store = typeof import('../src/Playbook/PlaybookStore');
let keyFromTitle: Store['keyFromTitle'], isValidKey: Store['isValidKey'], parseTitle: Store['parseTitle'], PlaybookStoreError: Store['PlaybookStoreError'];
before(async () => {
  ({ keyFromTitle, isValidKey, parseTitle, PlaybookStoreError } = await import('../src/Playbook/PlaybookStore'));
});

const OKTA = `Title: Okta password reset
Trigger: a user asks for a reset
Instructions: 1. Verify the user. 2. Reset the password.
Tools used: okta.reset
`;

test('keyFromTitle slugs a title', () => {
  assert.equal(keyFromTitle('Okta password reset'), 'okta-password-reset');
  assert.equal(keyFromTitle('###'), 'playbook');
});

test('keyFromTitle caps at 64 with no trailing dash', () => {
  const k = keyFromTitle('abcd'.repeat(20));
  assert.equal(k.length, 64);
  assert.ok(!k.endsWith('-'));
});

test('isValidKey', () => {
  assert.ok(isValidKey('okta-reset'));
  assert.ok(isValidKey('a'));
  assert.ok(!isValidKey('Okta'));
  assert.ok(!isValidKey('-a'));
  assert.ok(!isValidKey('a--b'));
  assert.ok(!isValidKey('a-'));
  assert.ok(!isValidKey(''));
  assert.ok(!isValidKey('okta-reset\n'));
  assert.ok(!isValidKey('a'.repeat(65)));
  assert.ok(isValidKey('a'.repeat(64)));
});

test('parseTitle returns the title', () => {
  assert.equal(parseTitle(OKTA), 'Okta password reset');
  assert.equal(parseTitle('## Title: T\n1. Instructions: do it'), 'T');
});

test('parseTitle refuses a missing Title or Instructions', () => {
  assert.throws(() => parseTitle('Trigger: x\n'), (e: any) =>
    e instanceof PlaybookStoreError && e.kind === 'invalid_text' && e.status === 422 &&
    e.message.includes('Missing "Title:" and "Instructions:" section') && e.message.includes('Recognized sections: Trigger'));
  assert.throws(() => parseTitle('Title: T\n'), (e: any) => e.message.startsWith('Missing "Instructions:" section. Recognized sections: Title.'));
});
