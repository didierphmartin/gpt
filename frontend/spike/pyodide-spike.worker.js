// Throwaway spike worker. Validates that a worker-side Pyodide can mount a
// transferred FSA handle AND PERSIST writes to the real folder. The persist
// step is the crux: Pyodide's mountNativeFS buffers writes in memory; they
// only reach disk when you call syncfs() on the object mountNativeFS returns.
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);

let pyodide = null;

self.onmessage = async (e) => {
  const { id, outputsHandle, filename, contents } = e.data;
  try {
    if (!pyodide) {
      pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    }
    const perm = await outputsHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error(`permission not granted in worker: ${perm}`);

    pyodide.FS.mkdirTree('/outputs');
    // Capture the mount object — its syncfs() is the documented flush.
    const nativefs = await pyodide.mountNativeFS('/outputs', outputsHandle);

    pyodide.globals.set('_fname', filename);
    pyodide.globals.set('_body', contents);
    await pyodide.runPythonAsync(`
with open('/outputs/' + _fname, 'w') as f:
    f.write(_body)
`);

    // THE flush: persist the in-memory NativeFS layer back to the FSA folder.
    await nativefs.syncfs();

    // In-worker sanity: is the file visible in the mounted FS right now?
    let inMount = false;
    try { pyodide.FS.stat('/outputs/' + filename); inMount = true; } catch (_) {}

    self.postMessage({ id, ok: true, inMount });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
