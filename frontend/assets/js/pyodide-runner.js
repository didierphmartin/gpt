/**
 * Pyodide skill-script runner.
 *
 * Lazy-loads the Pyodide runtime on first use, stays warm for the rest of
 * the session, and runs Python scripts shipped inside folder-backed skills.
 * The skill folder is mounted into Pyodide's virtual FS via the File System
 * Access API, so the script can read its bundled assets and write outputs
 * back to the user's real folder unchanged.
 *
 * Public API:
 *   await window.pyodideRunner.runSkillScript({
 *       dirName,        // skill folder under <root>/skills/
 *       script,         // path within the skill, e.g. "scripts/transform.py"
 *       argv,           // array of CLI arguments (passed as-is to the script)
 *       inputFiles,     // optional { [skillRelativePath]: string|Uint8Array }
 *       readOutputs,    // optional [skillRelativePath, ...] to read back
 *       dependencies,   // optional override for SKILL.md `dependencies:` list
 *       persist,        // default true: syncfs to host after run
 *   })
 *   // → { stdout, stderr, exitCode, outputs, durationMs }
 *
 * Dependencies are read from the skill's SKILL.md frontmatter (extension
 * key `dependencies:`, comma-separated or `[a, b]` inline-list — Anthropic's
 * parser ignores unknown keys, so adding it stays spec-compatible). Pre-built
 * Pyodide packages load via `loadPackage`; everything else falls through to
 * `micropip.install`.
 *
 * Concurrent calls are serialized: the runtime is shared and we mutate
 * `sys.argv`, `cwd`, and stdout/stderr per run. Queueing keeps that simple.
 *
 * Chromium-only — relies on showDirectoryPicker via window.localFs.
 */
(function () {
    'use strict';

    const PYODIDE_VERSION = '0.27.7';
    const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
    const PYODIDE_SCRIPT_URL = `${PYODIDE_INDEX_URL}pyodide.js`;

    // Pre-built (compiled-to-WASM) Pyodide packages. Anything not in this set
    // is attempted via micropip (pure-Python wheels on PyPI). Kept short by
    // design; expand only when a user hits a real failure.
    // Source: https://pyodide.org/en/stable/usage/packages-in-pyodide.html
    const PREBUILT_PACKAGES = new Set([
        'beautifulsoup4',
        'lxml', 'numpy', 'pandas', 'scipy', 'matplotlib',
        'pillow', 'pyyaml', 'regex', 'requests', 'pytz',
        'sqlite3', 'soupsieve', 'markupsafe', 'jinja2',
    ]);

    let pyodide = null;
    let pyodideLoadPromise = null;
    const mountedSkills = new Map();   // dirName → '/skill/<dirName>'
    const installedDeps = new Set();   // canonical dep names already installed
    let runQueue = Promise.resolve();  // tail of the serialization chain

    /**
     * Inject the Pyodide loader script tag exactly once. Resolves with the
     * global `loadPyodide` function exposed by the CDN bundle.
     */
    function loadPyodideScript() {
        if (typeof window.loadPyodide === 'function') {
            return Promise.resolve(window.loadPyodide);
        }
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${PYODIDE_SCRIPT_URL}"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(window.loadPyodide));
                existing.addEventListener('error', () => reject(new Error('Failed to load pyodide.js')));
                return;
            }
            const tag = document.createElement('script');
            tag.src = PYODIDE_SCRIPT_URL;
            tag.async = true;
            tag.onload = () => resolve(window.loadPyodide);
            tag.onerror = () => reject(new Error('Failed to load pyodide.js'));
            document.head.appendChild(tag);
        });
    }

    /**
     * Ensure the Pyodide runtime is loaded and cached. Subsequent calls are
     * no-ops. The promise is shared so concurrent first-callers wait on the
     * same load instead of racing.
     */
    async function ensureLoaded() {
        if (pyodide) return pyodide;
        if (!pyodideLoadPromise) {
            pyodideLoadPromise = (async () => {
                const loadPyodide = await loadPyodideScript();
                pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
                return pyodide;
            })().catch(err => {
                pyodideLoadPromise = null;
                throw err;
            });
        }
        return pyodideLoadPromise;
    }

    /**
     * Mount the named skill folder into Pyodide's virtual FS at
     * `/skill/<dirName>`. Caches per dirName: NativeFS doesn't allow
     * remounting the same path, and a single mount lasts the session.
     */
    /**
     * Map a possibly-bare skill name to its real folder path under skills/.
     * The model frequently calls run_skill_script with just a skill's own
     * folder name (e.g. "geo-report") even when it lives inside a group
     * folder (e.g. "GEO/geo-report") — and may target a skill OTHER than the
     * one bound to its node (a consolidator bound to `html` calling
     * `GEO/geo-report`). A name that already contains "/" or resolves at the
     * top level is returned unchanged; otherwise we scan ONE level of group
     * folders for "<group>/<name>/SKILL.md". Falls back to the original name
     * so the caller still throws a clear "not found".
     */
    async function resolveSkillDir(dirName) {
        if (!dirName || dirName.includes('/') || !window.localFs) return dirName;
        // Top-level skill folder? (e.g. "docx")
        const direct = await window.localFs.resolvePath(`skills/${dirName}/SKILL.md`, { kind: 'file' });
        if (direct) return dirName;
        // Otherwise look one level down inside group folders.
        const skillsDir = await window.localFs.resolvePath('skills');
        if (!skillsDir) return dirName;
        for await (const entry of skillsDir.values()) {
            if (entry.kind !== 'directory') continue;
            const md = await window.localFs.resolvePath(
                `skills/${entry.name}/${dirName}/SKILL.md`, { kind: 'file' }
            );
            if (md) return `${entry.name}/${dirName}`;
        }
        return dirName;
    }

    async function ensureMounted(dirName) {
        if (mountedSkills.has(dirName)) return mountedSkills.get(dirName);
        if (!window.localFs) {
            throw new Error('window.localFs is not available — cannot resolve skill folder.');
        }
        const dirHandle = await window.localFs.resolvePath(`skills/${dirName}`);
        if (!dirHandle) {
            throw new Error(`Skill folder not found at skills/${dirName}.`);
        }
        // Re-confirm permission silently; Chromium retains the grant per
        // origin so this is normally a no-op after first install.
        const status = await dirHandle.queryPermission({ mode: 'readwrite' });
        if (status !== 'granted') {
            const req = await dirHandle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') {
                throw new Error(`Permission to read/write skill folder "${dirName}" was denied.`);
            }
        }
        const mountPath = `/skill/${dirName}`;
        pyodide.FS.mkdirTree(mountPath);
        await pyodide.mountNativeFS(mountPath, dirHandle);
        mountedSkills.set(dirName, mountPath);
        return mountPath;
    }

    /**
     * Mount `<root>/outputs/` into Pyodide's virtual FS at `/outputs`.
     * Skills write all generated documents there (per spec: a sibling of
     * the skills folder under the user's chosen storage root). Lazy and
     * cached for the session — the directory is auto-created on the
     * host side if missing (covers users who installed before the
     * outputs/ folder convention existed).
     */
    let outputsMountPath = null;
    async function ensureOutputsMounted() {
        if (outputsMountPath) return outputsMountPath;
        if (!window.localFs) {
            throw new Error('window.localFs is not available — cannot resolve outputs folder.');
        }
        // Make sure the host-side folder exists; idempotent.
        if (typeof window.localFs.ensureStandardSubdirs === 'function') {
            await window.localFs.ensureStandardSubdirs();
        }
        const outHandle = await window.localFs.resolvePath('outputs', { create: true });
        if (!outHandle) {
            throw new Error('Could not resolve outputs/ directory.');
        }
        const status = await outHandle.queryPermission({ mode: 'readwrite' });
        if (status !== 'granted') {
            const req = await outHandle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') {
                throw new Error('Permission to write to outputs/ was denied.');
            }
        }
        const path = '/outputs';
        pyodide.FS.mkdirTree(path);
        await pyodide.mountNativeFS(path, outHandle);
        outputsMountPath = path;
        return path;
    }

    /**
     * Mount the skills ROOT folder (~/Documents/synergyAI/skills/) into
     * Pyodide's virtual FS at `/skills-root/`. Used by skills that need to
     * create or modify other skills — most importantly skill-creator's
     * create_skill.py, which writes a new skill directly into the live
     * skills folder so the user can test it without an import step.
     *
     * Lazy and cached for the session, same pattern as
     * ensureOutputsMounted().
     */
    let skillsRootMountPath = null;
    async function ensureSkillsRootMounted() {
        if (skillsRootMountPath) return skillsRootMountPath;
        if (!window.localFs) {
            throw new Error('window.localFs is not available — cannot resolve skills folder.');
        }
        const skillsHandle = await window.localFs.resolvePath('skills', { create: true });
        if (!skillsHandle) {
            throw new Error('Could not resolve skills/ directory.');
        }
        const status = await skillsHandle.queryPermission({ mode: 'readwrite' });
        if (status !== 'granted') {
            const req = await skillsHandle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') {
                throw new Error('Permission to write to skills/ was denied.');
            }
        }
        const path = '/skills-root';
        pyodide.FS.mkdirTree(path);
        await pyodide.mountNativeFS(path, skillsHandle);
        skillsRootMountPath = path;
        return path;
    }

    /**
     * Parse a YAML-ish dependencies value from SKILL.md frontmatter. Accepts
     * `bs4, cssutils` or `[bs4, cssutils]` — the small parser in skills-fs.js
     * stores both as plain strings. Returns a deduped array of names.
     */
    function parseDepsField(value) {
        if (!value) return [];
        let s = String(value).trim();
        if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
        return s.split(',')
            .map(x => x.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
    }

    /**
     * Read `dependencies:` from a skill's SKILL.md. Returns [] if the field
     * isn't declared — the runner installs nothing in that case and lets the
     * script's import error surface to the caller.
     */
    async function getSkillDependencies(dirName) {
        if (!window.skillsFs || typeof window.skillsFs.parseFrontmatter !== 'function') {
            return [];
        }
        // resolvePath splits on "/", so a group-folder prefix in dirName
        // (e.g. "SEO/ai-search-audit") resolves correctly — a single
        // getDirectoryHandle(dirName) call cannot traverse a nested path.
        const skillMd = await window.localFs?.resolvePath(
            `skills/${dirName}/SKILL.md`, { kind: 'file' }
        );
        if (!skillMd) return [];
        const file = await skillMd.getFile();
        const text = await file.text();
        const { meta } = window.skillsFs.parseFrontmatter(text);
        return parseDepsField(meta.dependencies);
    }

    /**
     * Read `fetches_urls:` from a skill's SKILL.md. Returns true when the
     * skill declares it needs URL pre-fetching — Pyodide has no socket access
     * and CORS blocks browser-side fetches, so URL arguments must be fetched
     * by the PHP backend (POST /gpt/backend/api/v1/fetch-url) before the
     * script runs. Returns false if the flag is absent, false, or unparseable.
     */
    async function getSkillFetchesUrls(dirName) {
        if (!window.skillsFs || typeof window.skillsFs.parseFrontmatter !== 'function') {
            return false;
        }
        // resolvePath handles a group-folder prefix in dirName (e.g.
        // "SEO/ai-search-audit"); getDirectoryHandle would not.
        const skillMd = await window.localFs?.resolvePath(
            `skills/${dirName}/SKILL.md`, { kind: 'file' }
        );
        if (!skillMd) return false;
        const file = await skillMd.getFile();
        const text = await file.text();
        const { meta } = window.skillsFs.parseFrontmatter(text);
        const v = meta.fetches_urls;
        if (v === true) return true;
        if (typeof v === 'string') return /^(true|yes|1)$/i.test(v.trim());
        return false;
    }

    /**
     * Build a deterministic Pyodide-FS path for a fetched URL. Used by
     * prefetchUrlArgs() to materialize remote HTML as a local file the
     * skill script can read with no awareness of the bridge.
     */
    function urlToTempPath(url) {
        const slug = String(url).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80);
        return `/tmp/prefetched_${slug || 'page'}.html`;
    }

    /**
     * Mirror the Python audit script's `_stem_from_source` so the bridge can
     * pre-compute the same report filename the script would produce. Used to
     * inject `-o /outputs/<stem>-audit.md` and force the script to write into
     * the host-mounted `/outputs/` (otherwise it falls back to
     * `Path.home() / "Documents" / "synergyAI" / "outputs"` which inside
     * Pyodide is MEMFS and never reaches the user's disk).
     */
    function urlStem(url) {
        try {
            const u = new URL(url);
            const pathPart = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '_') || 'index';
            return `${u.host}_${pathPart}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        } catch {
            return 'audit_output';
        }
    }

    /**
     * For skills that declare `fetches_urls: true`, intercept any http(s)
     * URL arguments in argv: POST each to the PHP backend's URL fetcher,
     * write the returned HTML to `/tmp/prefetched_<slug>.html` in the
     * Pyodide FS, and replace the URL in argv with that path. Also append
     * `--source <original-url>` (unless one is already present) so the
     * script's source-label, citation density host, and output filename
     * still derive from the URL rather than the temp path.
     *
     * Throws on fetch failure. Crawl/batch modes are rejected explicitly:
     * they invoke the script's own URL fetcher per-page, which the argv
     * interceptor cannot reach.
     *
     * Returns the rewritten argv array.
     */
    async function prefetchUrlArgs(argv, dirName = '') {
        // Reject modes the argv-level interceptor cannot cover.
        if (argv.includes('--crawl')) {
            throw new Error(
                'pyodide-runner: --crawl mode is not supported in the browser ' +
                'because the script fetches each discovered link itself, with ' +
                'no opportunity for the runner to intercept. Audit one URL ' +
                'at a time, or run the crawl from a non-Pyodide host.'
            );
        }
        if (argv.includes('--batch-file')) {
            throw new Error(
                'pyodide-runner: --batch-file mode is not supported in the ' +
                'browser because the script fetches each listed URL itself. ' +
                'Audit one URL at a time, or run the batch from a non-Pyodide host.'
            );
        }

        const hasSourceFlag = argv.some(a => a === '--source' || a.startsWith('--source='));
        const hasOutputFlag = argv.some(a => a === '-o' || a === '--output' || a.startsWith('-o=') || a.startsWith('--output='));
        const hasStdoutFlag = argv.includes('--stdout');
        const out = [];
        const fetchedUrls = []; // first one becomes --source if none was given

        // Match the auth scheme the rest of the frontend uses (chat.js
        // getAuthHeaders): JWT bearer token from window.authManager. Without
        // it, the backend's auth middleware rejects the POST with 401 and the
        // bridge surfaces a misleading "site blocked us" error to the LLM.
        const authHeaders = { 'Content-Type': 'application/json' };
        if (window.authManager && window.authManager.token) {
            authHeaders['Authorization'] = `Bearer ${window.authManager.token}`;
        }

        for (const arg of argv) {
            if (/^https?:\/\//i.test(arg)) {
                const tmpPath = urlToTempPath(arg);
                let resp;
                try {
                    resp = await fetch(window.apiUrl('/fetch-url'), {
                        method: 'POST',
                        headers: authHeaders,
                        body: JSON.stringify({ url: arg }),
                    });
                } catch (e) {
                    throw new Error(`pyodide-runner: fetch-url request failed for ${arg}: ${e.message}`);
                }
                // Read the body even on non-OK responses — the UrlFetchController
                // returns the real reason ("Fetch failed (curl errno N): ...",
                // "Upstream returned HTTP 401", "Response exceeded N bytes") in
                // a JSON body alongside the HTTP status. Without parsing it,
                // the LLM sees only "HTTP 502" and starts guessing about CDN/
                // bot-protection when the actual cause is, e.g., DNS failure
                // or a typo in the URL.
                let payload = null;
                try {
                    payload = await resp.json();
                } catch (e) {
                    if (!resp.ok) {
                        throw new Error(
                            `pyodide-runner: fetch-url returned HTTP ${resp.status} for ${arg} ` +
                            `(non-JSON body: ${e.message})`
                        );
                    }
                    throw new Error(`pyodide-runner: fetch-url returned non-JSON for ${arg}: ${e.message}`);
                }
                if (!resp.ok || (payload && payload.success === false)) {
                    const backendErr = (payload && payload.error) ? payload.error : 'unknown error';
                    const upstream = payload && payload.data && payload.data.upstream_status
                        ? ` upstream_status=${payload.data.upstream_status}` : '';
                    const finalUrl = payload && payload.data && payload.data.final_url
                        ? ` final_url=${payload.data.final_url}` : '';
                    throw new Error(
                        `pyodide-runner: fetch-url failed for ${arg} ` +
                        `(HTTP ${resp.status}, ${backendErr}${upstream}${finalUrl})`
                    );
                }
                // Backend envelope is { success, data: { html, ... } }; accept
                // top-level `html` too for robustness against future shape changes.
                const html = (payload && payload.data && payload.data.html) || (payload && payload.html);
                if (typeof html !== 'string' || html.length === 0) {
                    throw new Error(`pyodide-runner: fetch-url returned no HTML for ${arg}`);
                }
                try {
                    pyodide.FS.writeFile(tmpPath, html);
                } catch (e) {
                    throw new Error(`pyodide-runner: failed to write fetched HTML to ${tmpPath}: ${e.message}`);
                }
                out.push(tmpPath);
                fetchedUrls.push(arg);
            } else {
                out.push(arg);
            }
        }

        // If at least one URL was fetched and no --source was supplied, label
        // the report with the FIRST fetched URL. The script propagates --source
        // through to both the output filename (_stem_from_source) and the
        // report's "Source:" line.
        if (fetchedUrls.length > 0 && !hasSourceFlag) {
            out.push('--source', fetchedUrls[0]);
        }
        // Force the script to write into the host-mounted `/outputs/` folder.
        // Without this, the script's default `Path.home() / "Documents" /
        // "synergyAI" / "outputs"` resolves inside Pyodide to `/home/pyodide/
        // Documents/synergyAI/outputs/` — i.e. MEMFS, which the host filesystem
        // never sees and which gets garbage-collected with the runtime. The
        // host's outputs/ folder is mounted at `/outputs/` by ensureOutputsMounted,
        // so writes there sync back to the user's real disk on syncfs.
        //
        // Subfolder by group: if the skill lives under a group folder
        // (dirName like "GEO/geo-audit"), bucket the output into a matching
        // /outputs/<group>/ subfolder so the user doesn't end up with one
        // flat dumping ground.
        //
        // Skip the injection when the caller explicitly chose --stdout or
        // already supplied -o / --output.
        if (fetchedUrls.length > 0 && !hasOutputFlag && !hasStdoutFlag) {
            const stem = urlStem(fetchedUrls[0]);
            let outDir = '/outputs';
            if (typeof dirName === 'string' && dirName.includes('/')) {
                const group = dirName.split('/')[0];
                if (/^[A-Za-z0-9._-]+$/.test(group)) {
                    outDir = '/outputs/' + group;
                    // mkdir is sync on Pyodide.FS; ignore EEXIST.
                    try { pyodide.FS.mkdir(outDir); } catch {}
                }
            }
            out.push('-o', `${outDir}/${stem}-audit.md`);
        }
        return out;
    }

    /**
     * Install the given Python packages into the running Pyodide. Pre-built
     * names go through loadPackage (fast, WASM); the rest fall through to
     * micropip. Already-installed names are skipped — Pyodide's loadPackage
     * is idempotent but micropip's install isn't always, so the cache matters.
     */
    async function ensureDeps(deps) {
        if (!deps || deps.length === 0) return;
        const fresh = deps.filter(d => !installedDeps.has(d));
        if (fresh.length === 0) return;

        const prebuilt = fresh.filter(d => PREBUILT_PACKAGES.has(d));
        const viaMicropip = fresh.filter(d => !PREBUILT_PACKAGES.has(d));

        if (prebuilt.length) {
            await pyodide.loadPackage(prebuilt);
        }
        if (viaMicropip.length) {
            await pyodide.loadPackage('micropip');
            pyodide.globals.set('_runner_micropip_deps', viaMicropip);
            await pyodide.runPythonAsync(`
import micropip
for _dep in list(_runner_micropip_deps):
    await micropip.install(_dep)
            `);
        }
        for (const d of fresh) installedDeps.add(d);
    }

    /**
     * Create parent directories for `path` inside Pyodide's FS. `path` is
     * absolute (starts with /). Pyodide ships `mkdirTree` already, but it
     * makes the leaf — we want only the parent so writeFile doesn't blow
     * up if the leaf is meant to be a file.
     */
    function ensureParentDir(path) {
        const idx = path.lastIndexOf('/');
        if (idx <= 0) return;
        pyodide.FS.mkdirTree(path.slice(0, idx));
    }

    /**
     * Write a single input file into the skill mount before the script runs.
     * Strings are encoded UTF-8; Uint8Arrays pass through; ArrayBuffers are
     * wrapped in a Uint8Array view; everything else is logged and skipped
     * (Pyodide's FS.writeFile only accepts string/ArrayBufferView and
     * throws "Unsupported data type" otherwise — observed in production
     * when an LLM emitted input_files with a nested object instead of a
     * string value, or when the value parsed as null due to a streaming-
     * JSON glitch). Skipping rather than crashing lets the script still
     * run with the files that DID make it through, surfacing a clearer
     * stderr for the model to recover from.
     */
    function writeInput(absPath, data) {
        ensureParentDir(absPath);
        let bytes;
        if (typeof data === 'string') {
            // CLAUDE STRING-WRAP RECOVERY: Claude sometimes emits a
            // string value at "/scratch/X" whose CONTENT is the JSON
            // serialization of a self-keyed wrap object — i.e.
            //   "{\n  \"/scratch/X\": \"<actual HTML>\"\n}"
            // Same shape as the object-wrap case, but the LLM
            // pre-stringified the wrap. Without this branch, the
            // string passes through verbatim and the skill script
            // (which expects raw HTML or a clean JSON spec) gets the
            // wrap object and either writes it back out unchanged or
            // mis-renders it. Detect by parsing strings that look
            // JSON-object-shaped, and if the parse yields exactly the
            // self-keyed wrap pattern, write the inner string instead.
            //
            // Skip this for *.json paths — there a {/scratch/X: ...}
            // top-level shape could be legitimate, and we don't want
            // to unwrap a real spec.
            const lowerPath = absPath.toLowerCase();
            const isJsonPath = lowerPath.endsWith('.json');
            const trimmed = data.trim();
            const looksLikeJsonObj = !isJsonPath
                && trimmed.length > 8
                && trimmed.startsWith('{')
                && trimmed.endsWith('}');
            if (looksLikeJsonObj) {
                // Multi-strategy parse, mirroring chat.js's input_files
                // recovery: direct JSON.parse first; if that fails, try
                // peeling one layer of over-escape (`\"` → `"`, `\\` → `\`)
                // and parse again. Claude's streaming JSON sometimes
                // double-encodes string values, which makes the outer
                // wrap technically invalid JSON despite looking right.
                let parsed = null;
                let parseErrors = [];
                try { parsed = JSON.parse(data); }
                catch (e) { parseErrors.push(`direct: ${e.message}`); }
                if (!parsed) {
                    try {
                        const unescaped = data
                            .replace(/\\"/g, '"')
                            .replace(/\\\\/g, '\\');
                        parsed = JSON.parse(unescaped);
                        if (parsed) {
                            console.log(
                                `[pyodide-runner] writeInput: outer JSON parsed after one over-escape pass for "${absPath}"`
                            );
                        }
                    } catch (e) { parseErrors.push(`after-unescape: ${e.message}`); }
                }
                if (!parsed) {
                    // STRUCTURAL UNWRAP — last-resort fallback for when
                    // every JSON.parse strategy fails because Claude
                    // emitted the wrap with literal unescaped newlines /
                    // bare quotes inside the value (technically invalid
                    // JSON, but visually the same `{"<path>": "<body>"}`
                    // pattern). Match the opening `{ "<key>": "` head
                    // and the trailing `" }` tail; take everything in
                    // between as the unwrapped body. Bypasses JSON
                    // entirely — safe because we only do this when the
                    // outer shape is unambiguous and JSON has already
                    // failed.
                    const headMatch = data.match(/^\s*\{\s*"([^"]+)"\s*:\s*"/);
                    if (headMatch) {
                        const innerKey = headMatch[1];
                        const trimmedTail = data.replace(/\s+$/, '');
                        if ((innerKey === absPath || innerKey.startsWith('/'))
                            && trimmedTail.endsWith('}')) {
                            // Find the closing `"` that precedes the
                            // final `}` (skipping whitespace between).
                            const withoutBrace = trimmedTail.slice(0, -1).replace(/\s+$/, '');
                            if (withoutBrace.endsWith('"')) {
                                const innerStart = headMatch[0].length;
                                const innerEnd = withoutBrace.length - 1;
                                let inner = data.slice(innerStart, innerEnd);
                                // The captured slice is the BODY of a
                                // JSON-encoded string. The outer JSON
                                // was malformed (literal newlines, etc),
                                // but the inner body usually has clean
                                // JSON string-escape sequences from the
                                // model: `\"` for quotes, `\\` for
                                // backslashes, `\n`/`\t`/`\r` for
                                // whitespace. If we write it raw, the
                                // iframe sees literal `\"` and renders
                                // it as backslash+quote, breaking the
                                // HTML. Decode the standard JSON string
                                // escapes here so the file content is
                                // the actual document the model
                                // intended. Order: `\\` first (so `\\\"`
                                // resolves to `\"` literal, NOT to `"`),
                                // then the rest.
                                const escapesBefore = (inner.match(/\\["\\\/bfnrt]/g) || []).length;
                                if (escapesBefore > 0) {
                                    inner = inner
                                        .replace(/\\\\/g, '')   // protect literal backslashes
                                        .replace(/\\"/g, '"')
                                        .replace(/\\\//g, '/')
                                        .replace(/\\n/g, '\n')
                                        .replace(/\\r/g, '\r')
                                        .replace(/\\t/g, '\t')
                                        .replace(/\\b/g, '\b')
                                        .replace(/\\f/g, '\f')
                                        .replace(//g, '\\');    // restore protected backslashes
                                }
                                const innerBytes = new TextEncoder().encode(inner);
                                console.log(
                                    `[pyodide-runner] writeInput: regex-unwrapped malformed JSON wrap for "${absPath}" ` +
                                    `(inner key "${innerKey}", ${inner.length} chars after decoding ${escapesBefore} escape sequences). ` +
                                    `Bypassed JSON.parse failures: ${parseErrors.join('; ')}`
                                );
                                pyodide.FS.writeFile(absPath, innerBytes);
                                return;
                            }
                        }
                    }
                    // No structural match either — surface the failure
                    // visibly and fall through to write the raw string
                    // (which will reproduce the broken artifact, but at
                    // least we'll see WHY in the console).
                    console.warn(
                        `[pyodide-runner] writeInput: "${absPath}" looks like a JSON wrap ` +
                        `(starts with '{', ends with '}', ${data.length} chars) but every ` +
                        `parse and structural-unwrap strategy failed — writing raw string. Errors:`,
                        parseErrors
                    );
                }
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    // Pattern A: outer key matches absPath, inner is string
                    if (typeof parsed[absPath] === 'string') {
                        const inner = parsed[absPath];
                        const innerBytes = new TextEncoder().encode(inner);
                        console.log(
                            `[pyodide-runner] writeInput: unwrapped JSON-string self-keyed wrap for "${absPath}" ` +
                            `(${inner.length} chars). Outer length was ${data.length}.`
                        );
                        pyodide.FS.writeFile(absPath, innerBytes);
                        return;
                    }
                    // Pattern B: single key (any absolute path), string value
                    const keys = Object.keys(parsed);
                    if (keys.length === 1
                        && keys[0].startsWith('/')
                        && typeof parsed[keys[0]] === 'string') {
                        const inner = parsed[keys[0]];
                        const innerBytes = new TextEncoder().encode(inner);
                        console.log(
                            `[pyodide-runner] writeInput: unwrapped JSON-string single-key wrap for "${absPath}" ` +
                            `(inner key "${keys[0]}", ${inner.length} chars). Outer length was ${data.length}.`
                        );
                        pyodide.FS.writeFile(absPath, innerBytes);
                        return;
                    }
                }
            }
            bytes = new TextEncoder().encode(data);
        } else if (data instanceof Uint8Array) {
            bytes = data;
        } else if (ArrayBuffer.isView(data)) {
            // Other typed-array views (Int8Array, Uint16Array, etc.) — view
            // the same memory through a Uint8Array.
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (data instanceof ArrayBuffer) {
            // Raw ArrayBuffer — Pyodide's FS.writeFile expects an
            // ArrayBufferView, not a bare buffer. Wrap it.
            bytes = new Uint8Array(data);
        } else if (data !== null && typeof data === 'object') {
            // CLAUDE SELF-KEYED DOUBLE-WRAP: Claude has been observed
            // emitting input_files where the VALUE at /scratch/X is
            // itself another object {/scratch/X: "<actual content>"} —
            // duplicating the path as both outer and inner key. If we
            // JSON.stringify the outer object, we end up writing the
            // literal text `{"/scratch/X": "<content>"}` to the file
            // instead of `<content>`, and the skill script (which is
            // a pass-through writer) then copies that JSON into the
            // output, producing a .html file whose body starts with
            // `{` and is rejected by the iframe SVG parser.
            //
            // Detect: data has a key identical to absPath (or any
            // /scratch/* path) whose value is a string. That string
            // is the model's intended file content; unwrap and write
            // it directly. Kimi/OpenAI/Gemini emit the right shape
            // (string value at the outer key) and never trigger this
            // branch — the unwrap is purely a Claude-quirk patch.
            if (typeof data[absPath] === 'string') {
                const unwrapped = data[absPath];
                bytes = new TextEncoder().encode(unwrapped);
                console.log(
                    `[pyodide-runner] writeInput: unwrapped self-keyed double-wrap for "${absPath}" ` +
                    `(${unwrapped.length} chars). The model nested {${absPath}: <string>} inside the value; using inner string.`
                );
                pyodide.FS.writeFile(absPath, bytes);
                return;
            }
            // Fallback: maybe the value is keyed by a DIFFERENT /scratch/
            // path (Claude swapping path conventions), but still a single
            // string entry. Use it.
            const keys = Object.keys(data);
            if (keys.length === 1
                && typeof data[keys[0]] === 'string'
                && keys[0].startsWith('/')) {
                const innerKey = keys[0];
                const unwrapped = data[innerKey];
                bytes = new TextEncoder().encode(unwrapped);
                console.log(
                    `[pyodide-runner] writeInput: unwrapped single-key wrap for "${absPath}" ` +
                    `(inner key was "${innerKey}", ${unwrapped.length} chars).`
                );
                pyodide.FS.writeFile(absPath, bytes);
                return;
            }
            // Plain object or array. Models (Claude in particular) routinely
            // emit input_files entries like "/scratch/spec.json": {...} as a
            // raw JSON value rather than a JSON-encoded string, despite the
            // schema's `additionalProperties: {type: string}`. The model's
            // intent is unambiguous — write the JSON to the file — so we
            // coerce it here. Without this the run fails: writeFile rejects
            // the object, the script can't find its spec, and the model
            // loops re-emitting the same shape. Pretty-print so any human
            // inspecting /scratch can read it; size cost is negligible
            // compared to the round-trip token spend if we forced a retry.
            try {
                // Pre-clean: Claude sometimes streams tool_use args that are
                // double-escaped — string values whose JSON encoding looks
                // like `"\\\"0 0\\\""` instead of `"\"0 0\""`. After PHP's
                // json_decode, these arrive as JS strings containing literal
                // backslash-quote sequences (`\"0 0\"`). When we then
                // JSON.stringify the object and Python reads it back, the
                // backslashes are preserved into the output HTML, breaking
                // anything that requires clean quotes — most visibly inline
                // SVG attributes (`viewBox="\\\"0 0 100 100\\\""` etc., which
                // the browser SVG parser rejects with "Expected number" or
                // "Expected length"). Cleaning `\"` → `"` recursively before
                // stringification fixes this. The heuristic is safe in our
                // domain: HTML/SVG values never legitimately contain a
                // literal backslash-quote, and any clean JSON string with
                // an embedded quote arrives here as just `"`, never as `\"`.
                let cleanedCount = 0;
                const dropOverEscape = (v) => {
                    if (typeof v === 'string') {
                        if (v.indexOf('\\"') !== -1) {
                            cleanedCount++;
                            return v.replace(/\\"/g, '"');
                        }
                        return v;
                    }
                    if (Array.isArray(v)) return v.map(dropOverEscape);
                    if (v !== null && typeof v === 'object') {
                        const out = {};
                        for (const [k, vv] of Object.entries(v)) out[k] = dropOverEscape(vv);
                        return out;
                    }
                    return v;
                };
                const cleaned = dropOverEscape(data);
                const json = JSON.stringify(cleaned, null, 2);
                bytes = new TextEncoder().encode(json);
                if (cleanedCount > 0) {
                    console.log(
                        `[pyodide-runner] writeInput: coerced object → JSON for "${absPath}" (${json.length} chars; ` +
                        `un-double-escaped ${cleanedCount} string value${cleanedCount === 1 ? '' : 's'})`
                    );
                } else {
                    console.log(
                        `[pyodide-runner] writeInput: coerced object → JSON for "${absPath}" (${json.length} chars)`
                    );
                }
                // DIAGNOSTIC: hunt for SVG/HTML content with backslash escapes
                // anywhere in the written JSON. If anything is found, log a
                // sample so we can see exactly which character sequences are
                // present and where the over-escape actually originates.
                const backslashIdx = json.indexOf('\\\\');
                if (backslashIdx !== -1) {
                    console.warn(
                        `[pyodide-runner] writeInput: JSON contains \\\\ sequences — sample around offset ${backslashIdx}:`,
                        JSON.stringify(json.slice(Math.max(0, backslashIdx - 40), backslashIdx + 80))
                    );
                }
                const svgIdx = json.indexOf('<svg');
                if (svgIdx !== -1) {
                    console.log(
                        `[pyodide-runner] writeInput: JSON contains <svg — sample at offset ${svgIdx}:`,
                        JSON.stringify(json.slice(svgIdx, svgIdx + 200))
                    );
                }
            } catch (e) {
                console.error(
                    `[pyodide-runner] writeInput: object at "${absPath}" failed JSON.stringify (${e?.message || e}); skipping`
                );
                return;
            }
        } else {
            const t = data === null ? 'null'
                : data === undefined ? 'undefined'
                : typeof data;
            console.error(
                `[pyodide-runner] writeInput: unsupported data type "${t}" for path "${absPath}"; skipping. ` +
                `Expected string, Uint8Array, ArrayBuffer, or plain object.`
            );
            return;
        }
        pyodide.FS.writeFile(absPath, bytes);
    }

    /**
     * Read an output file the script (presumably) wrote. Returns null if the
     * path doesn't exist — easier for callers than catching exceptions.
     * Decodes as UTF-8 by default; if the bytes aren't valid UTF-8, returns
     * the raw Uint8Array so binary outputs aren't silently corrupted.
     */
    function readOutput(absPath) {
        let bytes;
        try {
            bytes = pyodide.FS.readFile(absPath);
        } catch {
            return null;
        }
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            return bytes;
        }
    }

    /**
     * The Python harness that runs the script. Captures stdout/stderr at the
     * Python layer (so we don't have to fight the JS-side stdout config),
     * sets sys.argv + cwd, and translates SystemExit / unhandled exceptions
     * into an exit code. State is restored in `finally` so the next call
     * starts clean.
     */
    const RUN_HARNESS = `
import os, sys, runpy, io, traceback

_argv = list(_runner_argv)
_script = str(_runner_script)
_cwd = str(_runner_cwd)

# Env vars exposed to skill scripts so they can self-bucket outputs by
# group (e.g. write to os.environ['SYNERGYAI_OUTPUT_DIR'] instead of a
# hardcoded '/outputs'). Backwards compatible — scripts that ignore these
# vars still write where they always have.
_env_dir_name = str(_runner_env_dir_name)
_env_group    = str(_runner_env_group)
_env_out_dir  = str(_runner_env_out_dir)

_saved_argv = sys.argv
_saved_cwd = os.getcwd()
_saved_stdout = sys.stdout
_saved_stderr = sys.stderr
_saved_dir_name = os.environ.get('SYNERGYAI_SKILL_DIR_NAME')
_saved_group    = os.environ.get('SYNERGYAI_SKILL_GROUP')
_saved_out_dir  = os.environ.get('SYNERGYAI_OUTPUT_DIR')
_stdout_buf = io.StringIO()
_stderr_buf = io.StringIO()
_runner_exit = 0

def _restore_env(name, val):
    if val is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = val

try:
    sys.argv = [_script] + _argv
    os.chdir(_cwd)
    sys.stdout = _stdout_buf
    sys.stderr = _stderr_buf
    os.environ['SYNERGYAI_SKILL_DIR_NAME'] = _env_dir_name
    os.environ['SYNERGYAI_SKILL_GROUP']    = _env_group
    os.environ['SYNERGYAI_OUTPUT_DIR']     = _env_out_dir
    try:
        runpy.run_path(_script, run_name='__main__')
    except SystemExit as e:
        if isinstance(e.code, int):
            _runner_exit = e.code
        elif e.code is None:
            _runner_exit = 0
        else:
            print(e.code, file=sys.stderr)
            _runner_exit = 1
    except BaseException:
        traceback.print_exc()
        _runner_exit = 1
finally:
    sys.argv = _saved_argv
    os.chdir(_saved_cwd)
    sys.stdout = _saved_stdout
    sys.stderr = _saved_stderr
    _restore_env('SYNERGYAI_SKILL_DIR_NAME', _saved_dir_name)
    _restore_env('SYNERGYAI_SKILL_GROUP',    _saved_group)
    _restore_env('SYNERGYAI_OUTPUT_DIR',     _saved_out_dir)

_runner_stdout = _stdout_buf.getvalue()
_runner_stderr = _stderr_buf.getvalue()
`;

    async function _runOne(opts) {
        const {
            script,
            argv = [],
            inputFiles = null,
            readOutputs = null,
            dependencies = null,
            persist = true,
        } = opts || {};

        // Normalize the requested skill name to its real on-disk path BEFORE
        // any helper touches it (mount, deps, fetches_urls, output bucketing
        // all assume the full group-prefixed form). A bare leaf like
        // "geo-report" becomes "GEO/geo-report"; an already-pathed or
        // top-level name is unchanged.
        const dirName = await resolveSkillDir(opts?.dirName);

        if (!dirName) throw new Error('runSkillScript: dirName is required');
        if (!script) throw new Error('runSkillScript: script is required');

        const t0 = performance.now();
        await ensureLoaded();
        const mount = await ensureMounted(dirName);
        // Outputs folder is sibling-mounted at `/outputs/` on every run so
        // skill scripts can write generated documents there via absolute
        // paths (e.g. `-o /outputs/result.html`).
        await ensureOutputsMounted();
        // Skills root is sibling-mounted at `/skills-root/` so meta-skills
        // (e.g. skill-creator/scripts/create_skill.py) can create new skill
        // folders in place and have them be immediately live. Mounted on
        // every run for consistency with /outputs/; cached after first call.
        await ensureSkillsRootMounted();

        const deps = Array.isArray(dependencies)
            ? dependencies
            : await getSkillDependencies(dirName);
        await ensureDeps(deps);

        // pyodide.toPy() rejects undefined/null/non-cloneable values with
        // "Unsupported data type". Validate argv before handing it off so we
        // get a precise, actionable error in the console rather than a
        // generic Pyodide stack trace. Done BEFORE the URL prefetch so that
        // a bad argv shape fails fast and doesn't waste a backend fetch.
        if (!Array.isArray(argv)) {
            console.error('[pyodide-runner] argv is not an array:', typeof argv, argv);
            throw new Error(`runSkillScript: argv must be an array of strings, got ${typeof argv}`);
        }
        const badArgv = argv.findIndex(v => typeof v !== 'string');
        if (badArgv !== -1) {
            console.error(`[pyodide-runner] argv[${badArgv}] is not a string:`, typeof argv[badArgv], argv[badArgv]);
            throw new Error(`runSkillScript: argv[${badArgv}] must be a string, got ${typeof argv[badArgv]}`);
        }

        // If the skill declares `fetches_urls: true` in SKILL.md, intercept
        // any http(s) URL arguments and pre-fetch them via the PHP backend
        // (Pyodide has no socket access, so URL handling must happen here).
        // Failures land in stderr as `[bridge] ...` and surface to the LLM —
        // the hardened SKILL.md prevents fabricated reports in that case.
        let effectiveArgv = argv;
        try {
            const fetchesUrls = await getSkillFetchesUrls(dirName);
            if (fetchesUrls) {
                effectiveArgv = await prefetchUrlArgs(argv, dirName);
            }
        } catch (e) {
            const msg = `[bridge] ${e.message || e}`;
            console.error('[pyodide-runner] URL pre-fetch failed:', msg);
            return {
                stdout: '',
                stderr: msg,
                exitCode: 2,
                outputs: {},
                durationMs: Math.round(performance.now() - t0),
            };
        }

        // Resolve a caller-supplied path: absolute paths (starting with `/`)
        // are passed through verbatim — this is how outputs end up under
        // `/outputs/...`. Relative paths are still resolved against the
        // skill mount, which is the cwd of the running script.
        const resolveAbs = (p) => p.startsWith('/') ? p : `${mount}/${p}`;

        // Models (Claude in particular, especially on large input_files
        // payloads) sometimes emit input_files as a JSON-encoded STRING
        // instead of a plain object — the "wasteful" pattern called out
        // in buildRunSkillScriptTool's description. Without this tolerance
        // the runner silently skips the writes (typeof string !== 'object'),
        // the script runs without its inputs, and the LLM burns rounds
        // re-trying. Parse the string if we recognize one; if parsing
        // fails, fall through to the type guard and write nothing.
        let inputFilesObj = inputFiles;
        if (typeof inputFilesObj === 'string') {
            try {
                inputFilesObj = JSON.parse(inputFilesObj);
                console.warn('[pyodide-runner] input_files arrived as a JSON-encoded string; parsed it back to an object. Model should emit the object form directly.');
            } catch (e) {
                console.error('[pyodide-runner] input_files is a string but not valid JSON; skipping all input file writes:', e?.message || e);
                inputFilesObj = null;
            }
        }
        if (inputFilesObj && typeof inputFilesObj === 'object') {
            for (const [rel, data] of Object.entries(inputFilesObj)) {
                try {
                    writeInput(resolveAbs(rel), data);
                } catch (e) {
                    // Pyodide errors here are usually FS.writeFile rejecting an
                    // unsupported value type (raw ArrayBuffer, plain object,
                    // null). writeInput already filters most of these but we
                    // wrap defensively so one bad entry doesn't kill the run.
                    console.error(`[pyodide-runner] writeInput threw for ${rel}:`, e?.message || e, 'data type:', typeof data);
                }
            }
            // Post-write verification: confirm each staged path exists in the FS
            // right before the script runs (definitive vs. inferring from the
            // model's narration about "missing" inputs).
            for (const rel of Object.keys(inputFilesObj)) {
                const abs = resolveAbs(rel);
                try {
                    const st = pyodide.FS.stat(abs);
                    console.log(`[pyodide-runner] staged ${abs}: ok (${st.size}B)`);
                } catch (e) {
                    console.warn(`[pyodide-runner] staged ${abs}: MISSING (${e?.message || e})`);
                }
            }
        }

        try {
            pyodide.globals.set('_runner_argv', pyodide.toPy(effectiveArgv));
        } catch (e) {
            console.error('[pyodide-runner] pyodide.toPy(argv) threw:', e?.message || e, 'argv:', effectiveArgv);
            throw e;
        }
        pyodide.globals.set('_runner_script', `${mount}/${script}`);
        pyodide.globals.set('_runner_cwd', mount);

        // Env-var exposure (RUN_HARNESS picks these up via `_runner_env_*`
        // and pushes them to os.environ before running the script). Skills
        // that opt in can write to SYNERGYAI_OUTPUT_DIR instead of a
        // hardcoded '/outputs', so grouped skills naturally bucket their
        // outputs into '/outputs/<group>/' on the host filesystem.
        const envGroup = (typeof dirName === 'string' && dirName.includes('/'))
            ? dirName.split('/')[0]
            : '';
        const envOutDir = (envGroup && /^[A-Za-z0-9._-]+$/.test(envGroup))
            ? `/outputs/${envGroup}`
            : '/outputs';
        if (envGroup) {
            // Pre-create the bucket so scripts can write into it without
            // their own mkdir. mkdir is sync on Pyodide.FS; ignore EEXIST.
            try { pyodide.FS.mkdir(envOutDir); } catch {}
        }
        pyodide.globals.set('_runner_env_dir_name', dirName || '');
        pyodide.globals.set('_runner_env_group',    envGroup);
        pyodide.globals.set('_runner_env_out_dir',  envOutDir);

        let exitCode = 0;
        let stdout = '';
        let stderr = '';
        try {
            await pyodide.runPythonAsync(RUN_HARNESS);
            exitCode = pyodide.globals.get('_runner_exit') ?? 0;
            stdout = pyodide.globals.get('_runner_stdout') ?? '';
            stderr = pyodide.globals.get('_runner_stderr') ?? '';
        } catch (e) {
            // The harness is supposed to swallow script errors; anything
            // raised here is a runtime failure (Pyodide crash, syntax error
            // in the harness, etc.) and we surface it as exit 1.
            exitCode = 1;
            stderr = String(e && e.message ? e.message : e);
        }

        const outputs = {};
        if (Array.isArray(readOutputs)) {
            for (const rel of readOutputs) {
                outputs[rel] = readOutput(resolveAbs(rel));
            }
        }

        // Platform safety net: surface the files the script ACTUALLY wrote, even
        // when the caller set NO read_outputs (or the model guessed the wrong
        // filename). Skill scripts announce writes as `wrote <path>` in stdout/
        // stderr; read those back so the model always sees its deliverable on
        // disk and never re-runs a skill that already succeeded. Additive (never
        // overwrites a requested key) and capped against a chatty script.
        const writtenRe = /\bwrote\s+(\/[^\s'"]+\.[A-Za-z0-9]+)/g;
        let wroteCount = 0;
        for (const src of [stderr, stdout]) {
            let m;
            while ((m = writtenRe.exec(src)) !== null && wroteCount < 12) {
                const p = m[1];
                if (!(p in outputs)) {
                    const v = readOutput(p);
                    if (v != null) { outputs[p] = v; wroteCount++; }
                }
            }
        }

        if (persist) {
            // syncfs without specifying a mount flushes ALL mounts, so the
            // outputs/ writes get pushed back to the host folder along
            // with anything the script touched in the skill mount.
            await new Promise((resolve, reject) => {
                pyodide.FS.syncfs(false, err => err ? reject(err) : resolve());
            });
        }

        return {
            stdout,
            stderr,
            exitCode,
            outputs,
            durationMs: performance.now() - t0,
        };
    }

    /**
     * Public entry point — serialized via runQueue so concurrent callers
     * don't trample each other's sys.argv / cwd / stdout state.
     */
    function runSkillScript(opts) {
        const next = runQueue.then(() => _runOne(opts));
        // Keep the chain alive even when a run rejects — otherwise one
        // failure poisons every subsequent call.
        runQueue = next.catch(() => {});
        return next;
    }

    /**
     * Inline-Python harness. Writes input files to MEMFS at the absolute
     * paths the caller specified, executes a string of Python source under
     * captured stdout/stderr, then reads back any requested outputs.
     *
     * Used by the attachment-converter to bridge binary formats (.docx,
     * .pptx, .xlsx, .pdf) into markdown the LLM can read — outside the
     * folder-backed-skill model entirely. No skill mount, no /outputs/
     * mount: this is platform plumbing, not a skill.
     */
    const INLINE_HARNESS = `
import sys, io, traceback
_inline_stdout = io.StringIO()
_inline_stderr = io.StringIO()
_inline_exit = 0
_saved_stdout = sys.stdout
_saved_stderr = sys.stderr
_inline_globals = {'__name__': '__main__'}
try:
    sys.stdout = _inline_stdout
    sys.stderr = _inline_stderr
    try:
        exec(_inline_code, _inline_globals)
    except SystemExit as e:
        if isinstance(e.code, int):
            _inline_exit = e.code
        elif e.code is None:
            _inline_exit = 0
        else:
            print(e.code, file=sys.stderr)
            _inline_exit = 1
    except BaseException:
        traceback.print_exc()
        _inline_exit = 1
finally:
    sys.stdout = _saved_stdout
    sys.stderr = _saved_stderr
_inline_stdout_str = _inline_stdout.getvalue()
_inline_stderr_str = _inline_stderr.getvalue()
`;

    async function _runInline(opts) {
        const {
            code,
            inputFiles = null,
            readOutputs = null,
            dependencies = null,
        } = opts || {};
        if (!code || typeof code !== 'string') {
            throw new Error('runInline: code (string) is required');
        }
        const t0 = performance.now();
        await ensureLoaded();
        if (Array.isArray(dependencies) && dependencies.length > 0) {
            await ensureDeps(dependencies);
        }
        if (inputFiles && typeof inputFiles === 'object') {
            for (const [absPath, data] of Object.entries(inputFiles)) {
                if (!absPath.startsWith('/')) {
                    throw new Error(`runInline: inputFiles paths must be absolute, got "${absPath}"`);
                }
                writeInput(absPath, data);
            }
        }
        pyodide.globals.set('_inline_code', code);
        let exitCode = 0;
        let stdout = '';
        let stderr = '';
        try {
            await pyodide.runPythonAsync(INLINE_HARNESS);
            exitCode = pyodide.globals.get('_inline_exit') ?? 0;
            stdout = pyodide.globals.get('_inline_stdout_str') ?? '';
            stderr = pyodide.globals.get('_inline_stderr_str') ?? '';
        } catch (e) {
            exitCode = 1;
            stderr = String(e && e.message ? e.message : e);
        }
        const outputs = {};
        if (Array.isArray(readOutputs)) {
            for (const absPath of readOutputs) {
                outputs[absPath] = readOutput(absPath);
            }
        }
        return {
            stdout,
            stderr,
            exitCode,
            outputs,
            durationMs: performance.now() - t0,
        };
    }

    function runInline(opts) {
        const next = runQueue.then(() => _runInline(opts));
        runQueue = next.catch(() => {});
        return next;
    }

    /**
     * For tests / debugging. Drops the warm runtime so the next call cold-
     * starts. Doesn't unmount FSA handles in the host filesystem — those
     * are owned by localFs.
     */
    function reset() {
        pyodide = null;
        pyodideLoadPromise = null;
        mountedSkills.clear();
        installedDeps.clear();
        runQueue = Promise.resolve();
    }

    /**
     * Best-effort unlink of a path inside Pyodide's virtual FS. Used by
     * the dispatcher to clean up /scratch/<filename> after a run so
     * MEMFS doesn't accumulate over a long session. Silent on failure
     * (path missing, runtime not loaded, etc.).
     */
    function cleanupPath(absPath) {
        if (!pyodide || !absPath || typeof absPath !== 'string') return;
        try { pyodide.FS.unlink(absPath); } catch (_) { /* tolerate */ }
    }

    window.pyodideRunner = {
        runSkillScript,
        runInline,
        ensureLoaded,
        ensureMounted,    // Phase 2B: cross-skill scripts (run_body_loop, etc.) call this from Python via `from js import window` to mount a sibling skill before reading its files
        reset,
        cleanupPath,
        // Exposed for the parallel worker-pool path (chat.js): the worker runs
        // off the main thread and cannot read SKILL.md, so the dispatcher
        // resolves these here and passes the results in the worker payload.
        getSkillDependencies,
        getSkillFetchesUrls,
        // exposed for tests / introspection
        _state: () => ({
            loaded: !!pyodide,
            mounts: Array.from(mountedSkills.keys()),
            deps: Array.from(installedDeps),
        }),
    };
})();
