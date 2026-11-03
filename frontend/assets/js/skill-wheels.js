/**
 * Skill wheels: what a self-contained skill zip carries so the skill runs offline.
 *   gather(deps, opts) -> { pyodide: { file: Uint8Array }, native: { file: Uint8Array } }
 * Pyodide wheels: a FRESH Pyodide from the CDN (export is the one online step, and it must not disturb the app's
 * running Pyodide) installs deps with micropip; everything micropip added beyond the baseline (prebuilt Pyodide
 * packages and transitive deps included) is downloaded - the runner installs a bundle with deps=False.
 * Native wheels: the backend downloads them for the three desktop platforms.
 * opts (all optional, for tests): loadPyodide, fetch, nativeWheels(deps), indexURL, onProgress(stage),
 *   session: an object the caller keeps for one export (e.g. a workflow package with several skills): the first
 *   gather() loads the export Pyodide into it, the next ones reuse it (and the files already downloaded). A skill's
 *   files are then its dependency closure in the lock, not only what its own install added.
 * Errors carry .code: native-unavailable | native-missing (+ .library, .platform) | native-failed | download.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(root);
    else root.SkillWheels = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
    const INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
    const norm = (n) => String(n).toLowerCase().replace(/[-_.]+/g, '-');
    const fail = (code, message, extra) => Object.assign(new Error(message), { code }, extra);

    async function defaultLoadPyodide(o) {
        const mod = await import(o.indexURL + 'pyodide.mjs');
        return mod.loadPyodide(o);
    }

    function b64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    async function defaultNative(deps) {
        const d = await root.skillsFs.api('POST', '/skills/native-wheels', { dependencies: deps });
        const out = {};
        for (const [f, b64] of Object.entries((d && d.wheels) || {})) out[f] = b64ToBytes(b64);
        return out;
    }

    async function native(deps, o) {
        try {
            return await (o.nativeWheels || defaultNative)(deps);
        } catch (e) {
            const payload = (e && e.data && (e.data.data || e.data)) || {};
            if (e && e.status === 503) throw fail('native-unavailable', 'No Python on the server');
            if (e && e.status === 422) throw fail('native-missing', payload.message || e.message, { library: payload.library, platform: payload.platform });
            if (e && e.status === 502) throw fail('native-failed', payload.message || e.message);
            throw e;
        }
    }

    /** The export Pyodide: loaded once per session (fresh when there is none), with micropip and its baseline. */
    async function exportPyodide(o, indexURL) {
        if (o.session && o.session.pyodide) return o.session;
        if (o.onProgress) o.onProgress('pyodide-load');
        const pyodide = await (o.loadPyodide || defaultLoadPyodide)({ indexURL });
        await pyodide.loadPackage('micropip');
        const st = { pyodide, baseline: new Set(Object.keys(pyodide.loadedPackages).map(norm)), bytes: new Map() };
        return o.session ? Object.assign(o.session, st) : st;
    }

    const reqName = (d) => norm(String(d).trim().split(/[\s<>=!~;\[(]/)[0]);

    async function pyodideWheels(deps, o) {
        const indexURL = o.indexURL || INDEX_URL;
        const doFetch = o.fetch || ((...a) => root.fetch(...a));
        const st = await exportPyodide(o, indexURL);
        const { pyodide } = st;
        const before = new Set(Object.keys(pyodide.loadedPackages));
        if (o.onProgress) o.onProgress('pyodide-install');
        pyodide.globals.set('_skill_deps', deps);
        // freeze() is the WHOLE lock (distro + what micropip added); loadedPackages says what the install pulled in.
        const lock = JSON.parse(await pyodide.runPythonAsync(
            'import micropip\nawait micropip.install(list(_skill_deps))\nmicropip.freeze()')).packages || {};
        const byName = {};
        for (const [key, pkg] of Object.entries(lock)) byName[norm(pkg.name || key)] = pkg;
        // What this install added, plus the lock closure of the deps (on a reused Pyodide an earlier skill may
        // have installed some of them already); never the baseline (micropip and what the runtime starts with).
        const names = new Set(Object.keys(pyodide.loadedPackages).filter((n) => !before.has(n)).map(norm));
        const walked = new Set();
        const todo = deps.map(reqName);
        while (todo.length) {
            const n = todo.pop();
            if (walked.has(n) || st.baseline.has(n) || !byName[n]) continue;
            walked.add(n);
            names.add(n);
            for (const d of byName[n].depends || []) todo.push(norm(d));
        }
        const out = {};
        for (const name of names) {
            if (st.baseline.has(name)) continue;
            const pkg = byName[name];
            if (!pkg || !pkg.file_name) throw fail('download', `No wheel file known for ${name}`);
            const url = /^https?:\/\//.test(pkg.file_name) ? pkg.file_name : indexURL + pkg.file_name;
            const file = url.split('?')[0].split('#')[0].split('/').pop();
            if (!st.bytes.has(url)) {
                const res = await doFetch(url);
                if (!res.ok) throw fail('download', `Could not download ${file}: HTTP ${res.status}`);
                st.bytes.set(url, new Uint8Array(await res.arrayBuffer()));
            }
            out[file] = st.bytes.get(url);
        }
        return out;
    }

    async function gather(deps, opts) {
        const o = opts || {};
        if (!deps || !deps.length) return { pyodide: {}, native: {} };
        if (o.onProgress) o.onProgress('native');
        const nat = await native(deps, o);          // cheap, and fails fast before the Pyodide load
        return { pyodide: await pyodideWheels(deps, o), native: nat };
    }

    return { gather, INDEX_URL };
});
