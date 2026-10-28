/** pyLiteral on very long and escape-heavy strings: stays a valid Python literal that evaluates back to the value. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PythonEmitHelpers } from '../src/AgentTeam/compiler/PythonEmitHelpers';

function evalPy(lit: string): unknown {
    const out = execFileSync('python3', ['-c', 'import sys,json; print(json.dumps(eval(sys.stdin.read())))'],
        { input: lit, maxBuffer: 64 * 1024 * 1024 }).toString();
    return JSON.parse(out);
}

test('pyLiteral: a 200000-character string value round-trips', () => {
    const v = { k: 'x'.repeat(200000), b: true, n: null };
    assert.deepEqual(evalPy(PythonEmitHelpers.pyLiteral(v)), v);
});

test('pyLiteral: escaped quotes, backslashes and bare words inside long strings stay untouched', () => {
    const v = { k: 'a"b\\c true null '.repeat(20000), f: false };
    assert.deepEqual(evalPy(PythonEmitHelpers.pyLiteral(v)), v);
    assert.equal(PythonEmitHelpers.pyLiteral({ a: true, b: 'true', c: null }), '{"a":True,"b":"true","c":None}');
});
