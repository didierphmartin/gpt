// Spike: prove (1) loader+splitter deps load in Pyodide, (2) state flows
// between two separate runs via a shared namespace, (3) a pyfetch reaches a
// same-origin backend. Logs PASS/FAIL per assertion to the page via postMessage.
const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
importScripts(PYODIDE_INDEX_URL + 'pyodide.js');

let pyodide;
const log = (line) => postMessage({ type: 'log', line });

async function tryLoad(name, viaMicropip) {
  try {
    if (viaMicropip) {
      await pyodide.runPythonAsync(`import micropip; await micropip.install(${JSON.stringify(name)})`);
    } else {
      await pyodide.loadPackage(name);
    }
    log(`PASS load ${name}`);
    return true;
  } catch (e) { log(`FAIL load ${name}: ${e}`); return false; }
}

onmessage = async (e) => {
  if (e.data !== 'run') return;
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  await pyodide.loadPackage('micropip');

  // A. dep matrix — record what loads. This DECIDES loader reuse.
  await tryLoad('pypdf', true);
  await tryLoad('langchain-text-splitters', true);
  await tryLoad('langchain-core', true);
  await tryLoad('langchain-community', true); // expected heavy/maybe-fail
  await tryLoad('docx2txt', true);

  // B. shared namespace: cell 1 sets `docs`, cell 2 (separate call) reads it.
  const ns = pyodide.globals.get('dict')();
  try {
    await pyodide.runPythonAsync(`docs = ["hello world. second sentence."]`, { globals: ns });
    await pyodide.runPythonAsync(`
from langchain_text_splitters import RecursiveCharacterTextSplitter
splitter = RecursiveCharacterTextSplitter(chunk_size=12, chunk_overlap=0)
chunks = splitter.split_text(docs[0])
`, { globals: ns });
    const n = ns.get('chunks').length;
    log(n > 0 ? `PASS shared-namespace docs->chunks (${n} chunks)` : 'FAIL shared-namespace: 0 chunks');
  } catch (err) { log('FAIL shared-namespace: ' + err); }
  finally { ns.destroy && ns.destroy(); }

  // C. pyfetch to a same-origin backend (health route is fine).
  try {
    const res = await pyodide.runPythonAsync(`
import pyodide.http, json
r = await pyodide.http.pyfetch("/gpt/backend/api/v1/health")
json.dumps({"status": r.status})
`);
    log(`PASS pyfetch backend (${res})`);
  } catch (err) { log('FAIL pyfetch: ' + err); }

  log('DONE');
};
