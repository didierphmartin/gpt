// Against the vendored Pyodide (scripts/vendor-pyodide.sh): a scipy bundle (scipy + numpy wheels + the openblas
// shared library .zip) installs offline and `import scipy` works. Skipped when Pyodide is not vendored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const VENDOR = fileURLToPath(new URL('../vendor/pyodide/v0.27.7/', import.meta.url));
const FILES = ['scipy-1.14.1-cp312-cp312-pyodide_2024_0_wasm32.whl', 'numpy-2.0.2-cp312-cp312-pyodide_2024_0_wasm32.whl', 'openblas-0.3.26.zip'];
const skip = FILES.some((f) => !existsSync(VENDOR + f)) && 'Pyodide 0.27.7 is not vendored';

function runner() {
  const SRC = readFileSync(fileURLToPath(new URL('../assets/js/pyodide-runner.js', import.meta.url)), 'utf8');
  const window = {};
  vm.runInContext(SRC, vm.createContext({ window, document: { baseURI: 'http://x/gpt/' }, console, URL, TextEncoder, TextDecoder, Uint8Array, performance }));
  return window.pyodideRunner;
}

const bundle = () => Object.fromEntries(FILES.map((f) => [f, new Uint8Array(readFileSync(VENDOR + f))]));
const CHECK = 'import numpy, scipy.linalg\nf"{scipy.__version__} {scipy.linalg.det(numpy.eye(3))}"';

async function pyodide() {
  const { loadPyodide } = await import(VENDOR + 'pyodide.mjs');
  return loadPyodide({ indexURL: VENDOR, stdout: () => {}, stderr: () => {} });
}

test('scipy bundle: distro packages load from the local index and scipy imports', { skip }, async () => {
  const py = await pyodide();
  await runner()._installBundle(py, bundle());
  assert.equal(await py.runPythonAsync(CHECK), '1.14.1 1.0');
});

test('scipy bundle: when the local index lacks them, the bundled bytes (openblas .zip included) are installed', { skip }, async () => {
  const real = await pyodide();
  // An index without these packages: loadPackage loads nothing but micropip.
  const py = new Proxy(real, {
    get: (t, k) => (k === 'loadPackage'
      ? (n) => ([].concat(n).includes('micropip') ? t.loadPackage('micropip') : Promise.resolve([]))
      : Reflect.get(t, k)),
  });
  await runner()._installBundle(py, bundle());
  assert.equal(await real.runPythonAsync(CHECK), '1.14.1 1.0');
});
