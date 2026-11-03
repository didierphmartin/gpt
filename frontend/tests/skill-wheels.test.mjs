import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SkillWheels = require('../assets/js/skill-wheels.js');

const INDEX = 'https://cdn.example/pyodide/';
function fakePyodide(lock, gained, calls) {
    const py = {
        loadedPackages: { numpy: 'default channel' },
        async loadPackage(n) { calls.push(['loadPackage', n]); if (n === 'micropip') py.loadedPackages.micropip = 'default channel'; },
        globals: { set: (k, v) => calls.push(['set', k, v]) },
        // the install gains packages (loadedPackages keys keep their own case); freeze() is the whole lock
        async runPythonAsync() { calls.push(['py']); Object.assign(py.loadedPackages, gained); return JSON.stringify({ packages: lock }); },
    };
    return py;
}
const bytes = (s) => new TextEncoder().encode(s).buffer;

test('no dependencies: nothing is loaded or called', async () => {
    let touched = 0;
    const r = await SkillWheels.gather([], { loadPyodide: () => { touched++; }, fetch: () => { touched++; }, nativeWheels: () => { touched++; } });
    assert.deepEqual(r, { pyodide: {}, native: {} });
    assert.equal(touched, 0);
});

test('only packages the install gained are fetched, not the whole lock', async () => {
    const calls = [], fetched = [];
    const lock = {
        numpy: { name: 'numpy', file_name: 'numpy-2.0.whl' },
        scipy: { name: 'scipy', file_name: 'scipy-1.whl' },
        micropip: { name: 'micropip', file_name: 'micropip-0.whl' },
        pillow: { name: 'pillow', file_name: 'pillow-10.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl' },   // relative, distro
        fonttools: { name: 'fonttools', file_name: 'fonttools-4.51.0-py3-none-any.whl' },
        fpdf2: { name: 'fpdf2', file_name: 'https://files.pythonhosted.org/x/fpdf2-2.9.0-py3-none-any.whl' },
    };
    const gained = { fpdf2: 'pypi', fonttools: 'default channel', Pillow: 'default channel' };
    const r = await SkillWheels.gather(['fpdf2'], {
        indexURL: INDEX,
        loadPyodide: async (o) => { calls.push(['load', o.indexURL]); return fakePyodide(lock, gained, calls); },
        fetch: async (u) => { fetched.push(u); return { ok: true, arrayBuffer: async () => bytes(u) }; },
        nativeWheels: async () => ({ 'fpdf2-2.9.0-py3-none-any.whl': new Uint8Array([1]) }),
    });
    assert.deepEqual(Object.keys(r.pyodide).sort(), ['fonttools-4.51.0-py3-none-any.whl', 'fpdf2-2.9.0-py3-none-any.whl', 'pillow-10.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl']);
    assert.deepEqual(fetched.sort(), [INDEX + 'fonttools-4.51.0-py3-none-any.whl', INDEX + 'pillow-10.2.0-cp312-cp312-pyodide_2024_0_wasm32.whl', 'https://files.pythonhosted.org/x/fpdf2-2.9.0-py3-none-any.whl']);
    assert.deepEqual(calls.find((c) => c[0] === 'load'), ['load', INDEX]);
    assert.deepEqual(calls.find((c) => c[0] === 'set'), ['set', '_skill_deps', ['fpdf2']]);
    assert.deepEqual(Object.keys(r.native), ['fpdf2-2.9.0-py3-none-any.whl']);
});

test('a failed wheel download names the file', async () => {
    const frozen = { a: { name: 'a', file_name: 'a-1.whl' } };
    await assert.rejects(SkillWheels.gather(['a'], {
        indexURL: INDEX, loadPyodide: async () => fakePyodide(frozen, { a: 'x' }, []),
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
        loadPyodide: async () => fakePyodide({}, {}, []), fetch: async () => ({}), nativeWheels: async () => ({}),
    });
    assert.deepEqual(seen, ['native', 'pyodide-load', 'pyodide-install']);
});
