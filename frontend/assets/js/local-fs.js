/**
 * Local FS bootstrap service.
 *
 * Bridges the user's configured "storage folder" name (e.g. synergyAi, kept
 * server-side in users.storage_folder) with a real File System Access API
 * directory handle. The handle is what lets the browser read/write the
 * actual folder on disk; the name is just metadata.
 *
 * The handle persists across sessions via IndexedDB. Chromium silently
 * re-grants permission on subsequent visits if it was granted before, so
 * after the first picker the user typically never sees it again.
 *
 * Usage:
 *   const fs = window.localFs;
 *   const handle = await fs.getRootHandle();      // null if not granted yet
 *   if (!handle) {
 *       // surface a button → fs.requestRootAccess('synergyAi')
 *   }
 */
(function () {
    'use strict';

    // Match the existing install-wizard storage exactly so the handle it
    // saves is the one we read here. Defined in pwa-install-prompt.js;
    // duplicating the constants is intentional (no shared module to import
    // from in this build).
    const DB_NAME = 'universalfs';
    const STORE_NAME = 'handles';
    const KEY = 'ufs-root-handle';
    const DB_VERSION = 1;

    /**
     * Open (or create) the local IndexedDB used to persist the directory
     * handle. FileSystemDirectoryHandle is structured-clonable so we can
     * store it as-is.
     */
    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(STORE_NAME);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function idbGet(key) {
        return openDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        }));
    }

    function idbSet(key, value) {
        return openDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    function idbDelete(key) {
        return openDb().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    /**
     * Returns true when the browser supports FSA. False on Safari / Firefox
     * (the user's already accepted Chromium-only constraint).
     */
    function isSupported() {
        return typeof window.showDirectoryPicker === 'function';
    }

    /**
     * Returns the cached handle if permission is currently granted; otherwise
     * null. Never prompts. Silent on every page load when previously granted
     * (Chromium retains the grant per origin until cleared).
     */
    async function getRootHandle() {
        if (!isSupported()) return null;
        let handle;
        try {
            handle = await idbGet(KEY);
        } catch {
            return null;
        }
        if (!handle) return null;
        const status = await handle.queryPermission({ mode: 'readwrite' });
        if (status === 'granted') return handle;
        return null;
    }

    /**
     * Same as getRootHandle but returns one of three states so callers can
     * render an accurate UI ("not picked", "needs re-grant after revoke",
     * "ready").
     */
    async function getStatus() {
        if (!isSupported()) return { state: 'unsupported' };
        let handle;
        try {
            handle = await idbGet(KEY);
        } catch {
            return { state: 'unsupported' };
        }
        if (!handle) return { state: 'not_picked' };
        const status = await handle.queryPermission({ mode: 'readwrite' });
        if (status === 'granted') return { state: 'granted', handle, name: handle.name };
        if (status === 'prompt')  return { state: 'prompt',  handle, name: handle.name };
        return { state: 'denied', handle, name: handle.name };
    }

    /**
     * Trigger the directory picker and persist the handle. Must be invoked
     * from a user gesture (button click). When `expectedName` is provided
     * we verify that the chosen directory matches the configured storage
     * folder name; mismatch is surfaced via the returned `warning` field
     * but doesn't block — the user may have moved the folder.
     */
    async function requestRootAccess(expectedName = '') {
        if (!isSupported()) {
            return { ok: false, error: 'File System Access API not supported in this browser. Use Chrome, Edge, or Brave.' };
        }
        let handle;
        try {
            handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        } catch (e) {
            // The user cancelling is a normal flow, not an error.
            if (e?.name === 'AbortError') return { ok: false, cancelled: true };
            return { ok: false, error: e?.message || String(e) };
        }
        // Always re-confirm permission — readwrite by default in Chromium
        // when triggered via the picker, but be defensive.
        const status = await handle.queryPermission({ mode: 'readwrite' });
        if (status !== 'granted') {
            const reqStatus = await handle.requestPermission({ mode: 'readwrite' });
            if (reqStatus !== 'granted') {
                return { ok: false, error: 'Permission denied.' };
            }
        }

        let warning = null;
        if (expectedName && handle.name !== expectedName) {
            warning = `Picked folder is "${handle.name}" but your configured root is "${expectedName}". This is fine if you renamed or moved it; otherwise pick the correct folder.`;
        }

        try {
            await idbSet(KEY, handle);
        } catch (e) {
            return { ok: false, error: 'Could not persist handle: ' + (e?.message || e) };
        }
        return { ok: true, handle, name: handle.name, warning };
    }

    /**
     * Drop the stored handle so the next call to getRootHandle returns null.
     * Useful for "switch folder" or testing flows.
     */
    async function revoke() {
        try {
            await idbDelete(KEY);
        } catch (e) {
            console.warn('[local-fs] revoke failed:', e);
        }
    }

    /**
     * Resolve a slash-separated path under the root, returning the leaf
     * directory or file handle. Returns null if any segment is missing.
     * Convenience wrapper used by Skills / Workflows / Artifacts later.
     */
    async function resolvePath(path, { create = false, kind = 'directory' } = {}) {
        const root = await getRootHandle();
        if (!root) return null;
        const parts = path.split('/').filter(Boolean);
        let cur = root;
        for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            const segKind = isLast ? kind : 'directory';
            try {
                if (segKind === 'file') {
                    cur = await cur.getFileHandle(parts[i], { create });
                } else {
                    cur = await cur.getDirectoryHandle(parts[i], { create });
                }
            } catch (e) {
                return null;
            }
        }
        return cur;
    }

    /**
     * Ensure the standard subdirectories exist under the root the user
     * picked: `skills/` (folder-backed skills) and `outputs/` (where
     * skill-generated documents are written by Pyodide). Idempotent —
     * safe to call on every app start so existing users get `outputs/`
     * lazily without a re-install.
     *
     * Returns an object with the resolved handles, or `null` when the
     * root isn't available (no permission, no FSA, picker not done yet).
     */
    async function ensureStandardSubdirs(rootHandleOpt = null) {
        const root = rootHandleOpt || await getRootHandle();
        if (!root) return null;
        try {
            const skillsHandle  = await root.getDirectoryHandle('skills',  { create: true });
            const outputsHandle = await root.getDirectoryHandle('outputs', { create: true });
            // `python/` is not optional decoration: the workflow editor writes
            // every compiled package to python/scripts/<pkg>/ under THIS root,
            // while the local runner reads them by real filesystem path from
            // its own install dir. The two only address the same place when the
            // install lives here — so the folder is created with the others.
            const pythonHandle  = await root.getDirectoryHandle('python',  { create: true });
            return { root, skills: skillsHandle, outputs: outputsHandle, python: pythonHandle };
        } catch (e) {
            console.warn('[local-fs] ensureStandardSubdirs failed:', e);
            return null;
        }
    }

    /**
     * Install the local Python runner into <granted root>/python/.
     *
     * Why the browser does this at all: a page cannot learn the granted
     * folder's absolute path, so it cannot tell setup.py where to install, and
     * the user would have to get the two to agree by hand. Writing the files
     * through the handle sidesteps that entirely — the folder the editor writes
     * packages into IS the folder the runner is installed in, by construction.
     *
     * What is left for a terminal: the virtualenv and pip install, which need a
     * process. That command is printed by the Setup modal.
     *
     * Idempotent, and safe to re-run to pick up a newer runner: each file is
     * overwritten, nothing else in the folder is touched. `.env` is never
     * written here — it holds provider keys and is synced separately.
     *
     * @returns {Promise<{written: string[], skipped: string[], error: string|null}>}
     */
    async function deployRunner(rootHandleOpt = null, baseUrl = null) {
        const root = rootHandleOpt || await getRootHandle();
        if (!root) return { written: [], skipped: [], error: 'no folder granted' };
        const base = baseUrl || (window.APP_RUNNER_SOURCE_URL || 'langchain_runner');
        const out = { written: [], skipped: [], error: null };
        try {
            const manRes = await fetch(`${base}/install-manifest.json`, { cache: 'no-store' });
            if (!manRes.ok) throw new Error(`manifest HTTP ${manRes.status}`);
            const man = await manRes.json();
            const files = Array.isArray(man.runtime_files) ? man.runtime_files : [];
            const subdirs = Array.isArray(man.subdirs) ? man.subdirs : [];
            if (!files.length) throw new Error('manifest lists no runtime files');

            const pyDir = await root.getDirectoryHandle('python', { create: true });
            for (const d of subdirs) {
                await pyDir.getDirectoryHandle(String(d), { create: true });
            }
            for (const name of files) {
                // One failed file must not abort the install: a partial runner
                // with a named gap is easier to finish than an opaque failure.
                try {
                    const res = await fetch(`${base}/${name}`, { cache: 'no-store' });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const text = await res.text();
                    const fh = await pyDir.getFileHandle(String(name), { create: true });
                    const w = await fh.createWritable();
                    await w.write(text);
                    await w.close();
                    out.written.push(String(name));
                } catch (e) {
                    console.warn(`[local-fs] deployRunner could not write ${name}:`, e);
                    out.skipped.push(String(name));
                }
            }
        } catch (e) {
            out.error = e?.message || String(e);
            console.warn('[local-fs] deployRunner failed:', e);
        }
        return out;
    }

    window.localFs = {
        isSupported,
        getRootHandle,
        getStatus,
        requestRootAccess,
        revoke,
        resolvePath,
        ensureStandardSubdirs,
        deployRunner,
    };
})();
