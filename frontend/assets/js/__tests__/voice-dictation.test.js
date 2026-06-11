const assert = require('assert');
const { nextInputState } = require('../voice-dictation.js');

// interim: value = base + transcript; base unchanged
let r = nextInputState('Hello ', 'world', false);
assert.strictEqual(r.value, 'Hello world');
assert.strictEqual(r.base, 'Hello ');

// final: commits — base grows by transcript + a trailing space
r = nextInputState('Hello ', 'world', true);
assert.strictEqual(r.value, 'Hello world');
assert.strictEqual(r.base, 'Hello world ');

// empty base (fresh input)
r = nextInputState('', 'hi there', false);
assert.strictEqual(r.value, 'hi there');
assert.strictEqual(r.base, '');

// empty transcript final → no spurious trailing space, base unchanged
r = nextInputState('Hello ', '', true);
assert.strictEqual(r.value, 'Hello ');
assert.strictEqual(r.base, 'Hello ');

console.log('nextInputState: ALL PASS');
