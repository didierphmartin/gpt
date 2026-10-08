const assert = require('assert');
const CT = require('../cron-text.js');

assert.strictEqual(CT.validate('*/2 * * * *'), null);
assert.strictEqual(CT.validate('*/5 8-18 * * 1-5'), null);
for (const bad of ['', '* * * *', '60 * * * *', '*/0 * * * *', '5-1 * * * *', 'x * * * *']) {
    assert.ok(CT.validate(bad), bad);
}
assert.deepStrictEqual(CT.PRESETS.map((p) => p.expr), ['*/2 * * * *', '*/15 * * * *', '*/5 8-18 * * 1-5']);

// Fake t(): "key(params)" -- day names come back as "day1()" etc.
const d = (e) => CT.describe(e, (k, p = {}) => `${k.split('.').pop()}(${Object.values(p).join('|')})`);
assert.strictEqual(d('*/2 * * * *'), 'everyNMinutes(2)');
assert.strictEqual(d('*/5 8-18 * * 1-5'), 'everyNMinutes(5), duringHours(8–18), onWeekdays(day1()–day5())');
assert.strictEqual(d('30 9 * * *'), 'atTime(09:30)');
assert.strictEqual(d('bad'), '');
console.log('cron-text ok');
