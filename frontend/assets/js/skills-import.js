/**
 * Skill import (and zip export) service.
 *
 * Import paths:
 *   1. readFromFolder() — opens a folder picker and reads the source folder.
 *   2. pickZipFile() + readZipFile() — a .zip via SkillZip.read.
 *   3. readFromGitHub() — downloads a repo path.
 * Folder and GitHub reads return { ok: true, read }; all three go through installRead (skillsFs.importSkill).
 *
 * exportSkillZip() builds the self-contained SkillZip (skill + wheels); zip imports read it with SkillZip.read
 * and install through skillsFs.importSkill (clash/identical handling lives there).
 *
 * Failure modes return { ok: false, error: ... } so the caller can surface them.
 *
 * Depends on:
 *   - window.skillsFs (the skills folder, or the skill store in the Docker app)
 *   - window.fflate.unzip  (loaded via CDN script tag)
 */
(function () {
    'use strict';

    const SKIP_PREFIXES = ['.DS_Store', '__MACOSX', 'Thumbs.db'];
    const isJunk = (name) => SKIP_PREFIXES.some(p => name === p || name.startsWith(p + '/'));
    const tr = (key, params) => (window.i18n && window.i18n.t ? window.i18n.t(key, params || {}) : key);

    /** A read-shaped result ({dir, name, files, pyodideWheels, nativeWheels}) for a plain folder of files. */
    const plainRead = (name, files) => ({ dir: name, name, files, pyodideWheels: {}, nativeWheels: {}, legacy: true, manifest: null });

    /**
     * Look at the immediate contents of a directory handle and decide if
     * it's "shaped like a skill" — at minimum has a SKILL.md at the root.
     */
    async function hasSkillMd(dirHandle) {
        try {
            await dirHandle.getFileHandle('SKILL.md', { create: false });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Import a skill from a folder picked via showDirectoryPicker. The
     * picked folder's name becomes the slug under <root>/skills/.
     */
    async function readFromFolder() {
        if (typeof window.showDirectoryPicker !== 'function') {
            return { ok: false, error: 'File System Access API not supported in this browser.' };
        }
        let srcDir;
        try {
            srcDir = await window.showDirectoryPicker({ mode: 'read' });
        } catch (e) {
            console.warn('[skillsImport] picker error/cancelled:', e);
            if (e?.name === 'AbortError') return { ok: false, cancelled: true };
            return { ok: false, error: e?.message || String(e) };
        }
        console.log('[skillsImport] picked source folder:', srcDir.name);
        if (!(await hasSkillMd(srcDir))) {
            return {
                ok: false,
                error: `Folder "${srcDir.name}" doesn't contain a SKILL.md at its root. Pick the folder that contains SKILL.md (not its parent).`
            };
        }
        let files;
        try {
            files = await readFolderFiles(srcDir, '', (entry) => !isJunk(entry.name));
        } catch (e) {
            console.error('[skillsImport] copy failed:', e);
            return { ok: false, error: 'Copy failed: ' + (e?.message || e) };
        }
        return { ok: true, read: plainRead(srcDir.name, files) };
    }

    /**
     * Read a File (zip) into a SkillZip.read() result ({dir, name, files, pyodideWheels, nativeWheels, legacy, manifest}).
     * Throws an Error (message already readable) when the file is not a skill zip.
     */
    async function readZipFile(file) {
        if (!window.fflate || !window.SkillZip) throw new Error('Zip library (fflate) is not loaded.');
        const fallbackName = file.name.replace(/\.(zip|skill)$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim();
        const read = window.SkillZip.read(new Uint8Array(await file.arrayBuffer()), { fallbackName });
        return read;
    }

    /**
     * Install a read result (and the skills it requires) through skillsFs.importSkill. visibility only matters in
     * the corporate edition. A clash in any of them installs nothing; the error names that skill.
     * Returns { ok, name, status: 'installed'|'identical', fileCount, requires: [{ dir, name, status }] } or { ok: false, error }.
     * 'identical' (also an identical public copy someone else owns) counts as already installed.
     */
    async function installRead(read, { visibility = 'private', confirmed = null } = {}) {
        if (!window.skillsFs) return { ok: false, error: 'Local filesystem not available — pick your data folder in Settings first.' };
        if (await window.skillsFs.mode() !== 'volume' && !window.localFs) {
            return { ok: false, error: 'Local filesystem not available — pick your data folder in Settings first.' };
        }
        try {
            // Required skills (read.requires) are checked with it and installed first, same visibility (skillsFs).
            // confirmed: { dir: [path] } the user agreed go public along (public import); the server checks it.
            const r = await window.skillsFs.importSkill(read, { visibility, ...(confirmed ? { confirmed } : {}) });
            return { ok: true, name: read.name, status: (r && r.status) || 'installed', fileCount: Object.keys(read.files).length, requires: (r && r.requires) || [] };
        } catch (e) {
            if (e?.code === 'clash') return { ok: false, error: tr('skills.zip.clash', { name: e.skill || read.name }) };
            const d = e?.data?.data;
            if (d && d.reason && window.skillsFs.requiredByMessage) return { ok: false, error: window.skillsFs.requiredByMessage(d) };
            console.error('[skillsImport] install failed:', e);
            return { ok: false, error: tr('skills.zip.failed', { message: e?.message || e }) };
        }
    }

    /** Pick a zip and install it without a review (private). The Skills page reviews first: pickZipFile + readZipFile + installRead. */
    async function importFromZipFile(file, opts) {
        let read;
        try { read = await readZipFile(file); } catch (e) { return { ok: false, error: e.message }; }
        return installRead(read, opts);
    }

    /**
     * Open a file picker for .zip / .skill files and import the chosen one.
     * Browser shows a standard input dialog; no FSA-only behavior here.
     */
    function pickZipFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.zip,.skill,application/zip';
            input.style.display = 'none';
            input.onchange = () => {
                const file = input.files?.[0];
                input.remove();
                resolve(file || null);
            };
            // Some browsers need the input in the DOM to fire the dialog.
            document.body.appendChild(input);
            input.click();
        });
    }

    async function importFromZipPicker() {
        const file = await pickZipFile();
        return file ? importFromZipFile(file) : { ok: false, cancelled: true };
    }

    /**
     * Parse a GitHub URL into { owner, repo, ref, path }. Accepts:
     *   - https://github.com/owner/repo
     *   - https://github.com/owner/repo/tree/<ref>
     *   - https://github.com/owner/repo/tree/<ref>/<path...>
     *   - github.com/owner/repo[/...]
     *   - owner/repo (bare slug)
     * Returns null if the input doesn't match any of these.
     */
    function parseGitHubUrl(input) {
        const trimmed = (input || '').trim();
        if (!trimmed) return null;
        // Strip protocol + host so we can pattern-match the path part.
        const stripped = trimmed
            .replace(/^https?:\/\//i, '')
            .replace(/^github\.com\//i, '')
            .replace(/\.git$/i, '')
            .replace(/\/$/, '');
        const parts = stripped.split('/');
        if (parts.length < 2) return null;
        const [owner, repo, treeOrBlob, ref, ...pathParts] = parts;
        if (!owner || !repo) return null;
        // bare "owner/repo" → ref=null (resolved later), path=''
        if (parts.length === 2) {
            return { owner, repo, ref: null, path: '' };
        }
        // Expect "tree" segment for sub-paths/refs.
        if (treeOrBlob !== 'tree' && treeOrBlob !== 'blob') return null;
        return {
            owner,
            repo,
            ref: ref || null,
            path: pathParts.join('/'),
        };
    }

    /**
     * Look up a repo's default branch when the URL didn't specify a ref.
     * Returns the branch name or null on failure.
     */
    async function resolveDefaultBranch(owner, repo) {
        try {
            const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
                headers: { Accept: 'application/vnd.github+json' },
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.default_branch || null;
        } catch {
            return null;
        }
    }

    /**
     * Walk a directory in a GitHub repo via the contents API and collect
     * everything into `files` ({ rel: bytes }, rel under `prefix`) preserving
     * the tree. Returns file count.
     * Throws on any unrecoverable error so the caller can surface it.
     *
     * Anonymous GitHub API has a 60 req/hour rate limit per IP. A typical
     * skill folder is ~5-15 files; the limit is plenty for normal use,
     * just noisy if a user spams installs.
     */
    async function fetchGitHubTree(owner, repo, ref, path, files, prefix = '') {
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
        const res = await fetch(apiUrl, {
            headers: { Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`GitHub contents API ${res.status}: ${body.slice(0, 160)}`);
        }
        const items = await res.json();
        if (!Array.isArray(items)) {
            throw new Error('GitHub contents API returned a non-array — expected a directory.');
        }
        let count = 0;
        for (const item of items) {
            if (isJunk(item.name)) continue;
            if (item.type === 'file') {
                if (!item.download_url) continue;
                const fileRes = await fetch(item.download_url);
                if (!fileRes.ok) {
                    throw new Error(`Could not download ${item.path}: ${fileRes.status}`);
                }
                files[prefix + item.name] = new Uint8Array(await fileRes.arrayBuffer());
                count++;
            } else if (item.type === 'dir') {
                count += await fetchGitHubTree(owner, repo, ref, item.path, files, `${prefix}${item.name}/`);
            }
            // Symlinks/submodules: skip silently.
        }
        return count;
    }

    /**
     * Install a skill from a GitHub repo or sub-path. The leaf path
     * component (or the repo name for a bare repo) becomes the skill
     * folder name under <root>/skills/. Validates SKILL.md presence at
     * the target path before writing anything.
     */
    async function readFromGitHub(url) {
        const parsed = parseGitHubUrl(url);
        if (!parsed) {
            return { ok: false, error: 'Could not parse GitHub URL. Expected forms: https://github.com/owner/repo[/tree/branch[/path]] or owner/repo.' };
        }
        let { owner, repo, ref, path } = parsed;
        if (!ref) {
            ref = await resolveDefaultBranch(owner, repo) || 'main';
        }

        // The folder name we'll create under skills/. Prefer the leaf of
        // the sub-path; fall back to the repo name when installing a
        // whole repo.
        const leaf = path ? path.split('/').filter(Boolean).pop() : repo;
        const safeName = leaf.replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!safeName) {
            return { ok: false, error: 'Could not derive a folder name from the URL.' };
        }

        // Verify the target path actually contains a SKILL.md before
        // creating any local folders. One extra HEAD-ish call but saves
        // the user from a half-written skill if they pasted a bad URL.
        try {
            const probeUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path ? path + '/' : ''}SKILL.md?ref=${encodeURIComponent(ref)}`;
            const probe = await fetch(probeUrl, { headers: { Accept: 'application/vnd.github+json' } });
            if (!probe.ok) {
                return { ok: false, error: `No SKILL.md found at ${owner}/${repo}/${path || ''}@${ref}. Pick the path that contains SKILL.md (not its parent).` };
            }
        } catch (e) {
            return { ok: false, error: 'Could not reach GitHub API: ' + (e?.message || e) };
        }

        const files = {};
        try {
            await fetchGitHubTree(owner, repo, ref, path, files);
        } catch (e) {
            return { ok: false, error: 'Download failed: ' + (e?.message || e) };
        }
        return { ok: true, read: plainRead(safeName, files) };
    }

    /** The skill filter: junk, dotfiles (may hold secrets) and __pycache__ are left out. */
    const skillEntryFilter = (entry) => !(isJunk(entry.name) || entry.name.startsWith('.') || entry.name === '__pycache__');

    /** The same filter over a { rel: bytes } map (e.g. skillsFs.readSkillFiles): a path is kept when every segment passes. */
    function filterSkillFiles(files) {
        const out = {};
        for (const [rel, b] of Object.entries(files || {})) {
            if (rel.split('/').every((name) => skillEntryFilter({ name }))) out[rel] = b;
        }
        return out;
    }

    /**
     * Every file under dirHandle as { "<prefix>/<relative path>": bytes } (no prefix: bare relative paths).
     * filter(entry, path) is asked for each file and folder; false skips it (a folder is not entered).
     * Default filter: the skill export's.
     */
    async function readFolderFiles(dirHandle, prefix = '', filter = skillEntryFilter) {
        const files = {};
        const walk = async (handle, base) => {
            for await (const entry of handle.values()) {
                const path = base ? `${base}/${entry.name}` : entry.name;
                if (!filter(entry, path)) continue;
                if (entry.kind === 'file') {
                    files[path] = new Uint8Array(await (await entry.getFile()).arrayBuffer());
                } else {
                    await walk(entry, path);
                }
            }
        };
        await walk(dirHandle, prefix);
        return files;
    }

    const isCompiled = (rel) => rel.split('/').some((seg) => seg === '__pycache__') || rel.endsWith('.pyc');

    /** One skill's files for a zip: the export filter, no bytecode; null when there is nothing (not installed / not visible). */
    async function zipFiles(dirName) {
        const found = filterSkillFiles(window.skillsFs ? await window.skillsFs.readSkillFiles(dirName) : {});
        for (const rel of Object.keys(found)) if (isCompiled(rel)) delete found[rel];
        return Object.keys(found).length ? found : null;
    }

    /**
     * The skills dirName requires (SkillRequires closure over the installed skills, dependencies first), each
     * read for a zip: [{ dir, name, files }]. files: dirName's own files (already read).
     * Throws a translated Error (.code 'missing-skill', .skill) when a required skill is not installed.
     */
    async function readRequires(dirName, files) {
        if (!window.SkillRequires || !window.skillsFs) return [];
        const installed = (await window.skillsFs.listSkills()).map((s) => s.dirName);
        const cache = new Map([[dirName, files]]);
        const read = async (p) => { if (!cache.has(p)) cache.set(p, await zipFiles(p)); return cache.get(p); };
        const r = await window.SkillRequires.closure(dirName, installed, read);
        if (r.missing.length) {
            const e = window.SkillRequires.missingError(r.missing);
            throw Object.assign(new Error(tr('skills.zip.requiresMissing', { by: e.by || dirName, name: e.skill })), { code: e.code, skill: e.skill, by: e.by });
        }
        const clash = window.SkillRequires.leafCollision(dirName, r.requires);
        if (clash) throw Object.assign(new Error(tr('skills.zip.leafCollision', { a: clash.skills[0], b: clash.skills[1], leaf: clash.leaf })), { code: clash.code });
        return r.requires.map((p) => ({ dir: p, name: p.split('/').pop(), files: cache.get(p) }));
    }

    /** A skill ({ dir, name, files }) with the wheels its SKILL.md dependencies need (gathered online). */
    async function withWheels(skill, opts) {
        const md = skill.files['SKILL.md'] ? new TextDecoder().decode(skill.files['SKILL.md']) : '';
        const w = await window.SkillWheels.gather(window.SkillZip.skillDependencies(md), opts || {});
        return { ...skill, pyodideWheels: w.pyodide, nativeWheels: w.native };
    }

    /**
     * Export: a self-contained zip (SkillZip format): the skill and every skill it requires (skill-requires.js),
     * each with the Pyodide and native wheels its SKILL.md dependencies need (the one online step).
     * Junk, dotfiles, __pycache__ and *.pyc are left out.
     * onProgress(stage): 'native' | 'pyodide-load' | 'pyodide-install' | 'pack'.
     * Returns { ok, name, bytes, requires: [dir] } or { ok: false, error } (error text is translated, naming
     * library + platform on a 422, or the required skill that is not installed).
     */
    async function exportSkillZip(dirName, { onProgress } = {}) {
        if (!window.SkillZip || !window.SkillWheels) return { ok: false, error: 'Zip library (fflate) is not loaded.' };
        const found = await zipFiles(dirName);
        if (!found) return { ok: false, error: `Skill folder "${dirName}" not found.` };
        const leaf = dirName.split('/').pop();
        let requires;
        try { requires = await readRequires(dirName, found); } catch (e) { return { ok: false, error: e.message }; }
        const session = {};   // one export Pyodide for the skill and the skills it requires
        let main;
        try {
            main = await withWheels({ dir: dirName, name: leaf, files: found }, { onProgress, session });
            for (let i = 0; i < requires.length; i++) requires[i] = await withWheels(requires[i], { onProgress, session });
        } catch (e) {
            console.error('[skillsImport] gathering wheels failed:', e);
            return { ok: false, error: wheelsError(e) };
        }
        if (onProgress) onProgress('pack');
        const bytes = await window.SkillZip.build({ ...main, requires });
        return { ok: true, name: leaf, bytes, requires: requires.map((r) => r.dir) };
    }

    function wheelsError(e) {
        switch (e?.code) {
            case 'native-missing': return tr('skills.zip.nativeMissing', { library: e.library || '?', platform: e.platform || '?' });
            case 'native-unavailable': return tr('skills.zip.nativeUnavailable');
            case 'native-failed': return tr('skills.zip.nativeFailed', { message: e.message });
            case 'download': return tr('skills.zip.downloadFailed', { message: e.message });
            default: return tr('skills.zip.gatherFailed', { message: e?.message || e });
        }
    }

    window.skillsImport = {
        wheelsError,
        readFromFolder,
        importFromZipPicker,
        pickZipFile,
        readZipFile,
        installRead,
        importFromZipFile,    // exposed for drag-drop later
        readFromGitHub,
        exportSkillZip,
        readRequires,
        withWheels,
        readFolderFiles,
        filterSkillFiles,
    };
})();
