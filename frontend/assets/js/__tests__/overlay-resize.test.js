/**
 * The conversation overlay resizes from every edge and corner: the REAL _pbResizeRect from workflow-editor.js turns a
 * drag (edge, dx, dy) into the window's new rect. The opposite edge stays put; the size never goes under the floor.
 *
 * Run: node frontend/assets/js/__tests__/overlay-resize.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = fs.readFileSync(path.resolve(__dirname, '../workflow-editor.js'), 'utf8');
const sig = '    _pbResizeRect(r, dir, dx, dy, minW, minH) {';
const start = file.indexOf(sig);
if (start < 0) throw new Error('could not find: ' + sig.trim());
const ed = eval('({ ' + file.slice(start, file.indexOf('\n    }\n', start) + 6).trim() + ' })');
const R = (r, dir, dx, dy) => ed._pbResizeRect(r, dir, dx, dy, 320, 560);
const r = { left: 100, top: 50, width: 440, height: 700 };

// right / bottom edges grow and shrink, the top-left corner stays
assert.deepStrictEqual(R(r, 'e', 60, 999), { left: 100, top: 50, width: 500, height: 700 });
assert.deepStrictEqual(R(r, 's', 999, -40), { left: 100, top: 50, width: 440, height: 660 });
// left / top edges move that edge; the opposite one stays where it was
assert.deepStrictEqual(R(r, 'w', -100, 0), { left: 0, top: 50, width: 540, height: 700 });
assert.deepStrictEqual(R(r, 'n', 0, 30), { left: 100, top: 80, width: 440, height: 670 });
// corners do both
assert.deepStrictEqual(R(r, 'se', 10, 20), { left: 100, top: 50, width: 450, height: 720 });
assert.deepStrictEqual(R(r, 'nw', 20, -10), { left: 120, top: 40, width: 420, height: 710 });
assert.deepStrictEqual(R(r, 'ne', 5, 5), { left: 100, top: 55, width: 445, height: 695 });
assert.deepStrictEqual(R(r, 'sw', -5, 5), { left: 95, top: 50, width: 445, height: 705 });
// never under the floor; a left/top edge pushed past it stops with the right/bottom edge fixed
assert.deepStrictEqual(R(r, 'e', -400, 0), { left: 100, top: 50, width: 320, height: 700 });
assert.deepStrictEqual(R(r, 'w', 400, 0), { left: 220, top: 50, width: 320, height: 700 });
assert.deepStrictEqual(R(r, 'n', 0, 400), { left: 100, top: 190, width: 440, height: 560 });

console.log('overlay-resize: ok');
