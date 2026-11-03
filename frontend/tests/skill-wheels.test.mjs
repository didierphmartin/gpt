import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SkillWheels = require('../assets/js/skill-wheels.js');

const INDEX = 'https://cdn.example/pyodide/';
function fakePyodide(frozen, calls) {
    return {
        loadedPackages: { numpy: 'default channel' },
        async loadPackage(n) { calls.push(['loadPackage', n]); if (n === 'micropip') this.loadedPackages.micropip = 'x'; },
        globals: { set: (k, v) => calls.push(['set', k, v]) },
        async runPythonAsync(code) { calls.push(['py']); return JSON.stringify({ packages: frozen }); },
    };
}
const bytes = (s) => new TextEncoder().encode(s).buffer;

test('no dependencies: nothing is loaded or called', async () => {
    let touched = 0;
    const r = await SkillWheels.gather([], { loadPyodide: () => { touched++; }, fetch: () => { touched++; }, nativeWheels: () => { touched++; } });
    assert.deepEqual(r, { pyodide: {}, native: {} });
    assert.equal(touched, 0);
});

test('freeze diff picks only packages beyond the baseline; absolute and relative file_name', async () => {
    const calls = [], fetched = [];
    const frozen = {
        numpy: { name: 'numpy', file_name: 'numpy-2.0.whl' },                       // baseline: skipped
        micropip: { name: 'micropip', file_name: 'micropip-0.whl' },                // loaded by us: skipped
        pillow: { name: 'pillow', file_name: 'pillow-11.0-cp312-pyodide.whl' },      // relative, from the lock
        fpdf2: { name: 'fpdf2', file_name: 'https://files.pythonhosted.org/x/fpdf2-2.8-py3-none-any.whl?sha=1' },
    };
    const r = await SkillWheels.gather(['fpdf2', 'pillow'], {
        indexURL: INDEX,
        loadPyodide: async (o) => { calls.push(['load', o.indexURL]); return fakePyodide(frozen, calls); },
        fetch: async (u) => { fetched.push(u); return { ok: true, arrayBuffer: async () => bytes(u) }; },
        nativeWheels: async () => ({ 'fpdf2-2.8-py3-none-any.whl': new Uint8Array([1]) }),
    });
    assert.deepEqual(Object.keys(r.pyodide).sort(), ['fpdf2-2.8-py3-none-any.whl', 'pillow-11.0-cp312-pyodide.whl']);
    assert.deepEqual(fetched.sort(), [INDEX + 'pillow-11.0-cp312-pyodide.whl', 'https://files.pythonhosted.org/x/fpdf2-2.8-py3-none-any.whl?sha=1']);
    assert.deepEqual(calls.find((c) => c[0] === 'load'), ['load', INDEX]);
    assert.deepEqual(calls.find((c) => c[0] === 'set'), ['set', '_skill_deps', ['fpdf2', 'pillow']]);
    assert.deepEqual(Object.keys(r.native), ['fpdf2-2.8-py3-none-any.whl']);
});

test('a failed wheel download names the file', async () => {
    const frozen = { a: { name: 'a', file_name: 'a-1.whl' } };
    await assert.rejects(SkillWheels.gather(['a'], {
        indexURL: INDEX, loadPyodide: async () => fakePyodide(frozen, []),
        fetch: async () => ({ ok: false, status: 404 }), nativeWheels: async () => ({}),
    }), (e) => e.code === 'download' && /a-1\.whl/.test(e.message));
});

test('native-wheels errors: 422 carries library and platform, 503 and 502 get codes', async () => {
    const run = (err) => SkillWheels.gather(['x'], { loadPyodide: async () => { throw new Error('should not load'); }, nativeWheels: async () => { throw err; } });
    const e422 = Object.assign(new Error('HTTP 422'), { status: 422, data: { success: false, data: { message: 'No wheel', library: 'foo', platform: 'win_amd64' } } });
    await assert.rejects(run(e422), (e) => e.code === 'native-missing' && e.library === 'foo' && e.platform === 'win_amd64');
    await assert.rejects(run(Object.assign(new Error('x'), { status: 503 })), (e) => e.code === 'native-unavailable');
    const e502 = Object.assign(new Error('HTTP 502: pip said no'), { status: 502, data: { data: { message: 'pip said no' } } });
    await assert.rejects(run(e502), (e) => e.code === 'native-failed' && /pip said no/.test(e.message));
});

test('progress reports the stages', async () => {
    const seen = [];
    await SkillWheels.gather(['a'], {
        indexURL: INDEX, onProgress: (s) => seen.push(s),
        loadPyodide: async () => fakePyodide({}, []), fetch: async () => ({}), nativeWheels: async () => ({}),
    });
    assert.deepEqual(seen, ['native', 'pyodide-load', 'pyodide-install']);
});
