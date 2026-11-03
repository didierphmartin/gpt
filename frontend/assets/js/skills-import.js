/**
 * Skill import (and zip export) service.
 *
 * Import paths:
 *   1. importFromFolder() — opens a folder picker, copies the source folder
 *      tree into <root>/skills/<name>/.
 *   2. importFromZipPicker() — opens a file picker for a .zip, extracts it
 *      via fflate, writes the contents into <root>/skills/<name>/.
 *
 * exportSkillZip() is the reverse of path 2: it zips a skill folder.
 *
 * Both imports validate that the source contains a SKILL.md at its root and that
 * the destination name doesn't already exist under <root>/skills/. Failure
 * modes return { ok: false, error: ... } so the caller can surface them.
 *
 * Depends on:
 *   - window.skillsFs (the skills folder, or the skill store in the Docker app)
 *   - window.fflate.unzip  (loaded via CDN script tag)
 */
(function () {
    'use strict';

    const SKIP_PREFIXES = ['.DS_Store', '__MACOSX', 'Thumbs.db'];
    const isJunk = (name) => SKIP_PREFIXES.some(p => name === p || name.startsWith(p + '/'));

    /**
     * Verify skills can be written (the folder exists, or the skill store is
     * used) and that no skill named `name` is already there.
     */
    async function ensureSkillsDir(name) {
        if (!window.skillsFs) {
            return { ok: false, error: 'Local filesystem not available — pick your data folder in Settings first.' };
        }
        if (await window.skillsFs.mode() !== 'volume') {
            if (!window.localFs) {
                return { ok: false, error: 'Local filesystem not available — pick your data folder in Settings first.' };
            }
            if (!(await window.skillsFs.folderHandle(''))) {
                return { ok: false, error: 'Could not open or create the skills folder under your data root.' };
            }
        }
        if (await window.skillsFs.skillExists(name)) {
            return { ok: false, error: `A skill folder named "${name}" already exists. Rename or remove it first.` };
        }
        return { ok: true };
    }

    /** Write the collected { rel: bytes } of a new skill through skillsFs. */
    async function installFiles(name, files) {
        try {
            await window.skillsFs.writeSkillFiles(name, files);
        } catch (e) {
            if (e?.code === 'clash') {
                return { ok: false, error: `A skill folder named "${name}" already exists. Rename or remove it first.` };
            }
            console.error('[skillsImport] write failed:', e);
            return { ok: false, error: 'Copy failed: ' + (e?.message || e) };
        }
        return { ok: true, name, fileCount: Object.keys(files).length };
    }

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
    async function importFromFolder() {
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
        const ensured = await ensureSkillsDir(srcDir.name);
        if (!ensured.ok) return ensured;
        let files;
        try {
            files = await readFolderFiles(srcDir, '', (entry) => !isJunk(entry.name));
        } catch (e) {
            console.error('[skillsImport] copy failed:', e);
            return { ok: false, error: 'Copy failed: ' + (e?.message || e) };
        }
        const result = await installFiles(srcDir.name, files);
        if (result.ok) console.log(`[skillsImport] copied ${result.fileCount} files to skills/${srcDir.name}/`);
        return result;
    }

    /**
     * Decide where the SKILL.md sits inside a zip's flat record produced
     * by fflate.unzip. Returns either:
     *   - { topDir: 'medium-format' }   when entries look like
     *     'medium-format/SKILL.md', 'medium-format/scripts/...'
     *   - { topDir: '' }                when 'SKILL.md' sits at the root
     *     and the user-supplied fallback name should be used
     *   - null                          when SKILL.md isn't at any
     *     reasonable location (reject)
     */
    function detectZipLayout(entries) {
        const paths = Object.keys(entries).filter(p => !isJunk(p) && !p.endsWith('/'));
        // SKILL.md at root?
        if (paths.includes('SKILL.md')) {
            return { topDir: '' };
        }
        // Single top-level directory pattern?
        const topDirs = new Set(paths.map(p => p.split('/')[0]));
        if (topDirs.size === 1) {
            const top = [...topDirs][0];
            if (paths.includes(`${top}/SKILL.md`)) {
                return { topDir: top };
            }
        }
        return null;
    }

    /**
     * Read a File (zip) into memory, extract via fflate, write entries
     * into <root>/skills/<name>/.
     */
    async function importFromZipFile(file) {
        if (!window.fflate || typeof window.fflate.unzip !== 'function') {
            return { ok: false, error: 'Zip library (fflate) is not loaded.' };
        }
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = await new Promise((resolve, reject) => {
            window.fflate.unzip(buf, (err, data) => err ? reject(err) : resolve(data));
        });

        const layout = detectZipLayout(entries);
        if (!layout) {
            return { ok: false, error: 'Zip does not contain a SKILL.md at the root or inside a single top-level folder.' };
        }

        // Pick the destination skill folder name.
        // - If the zip nests everything under "medium-format/", use that.
        // - Otherwise (SKILL.md is bare at root), derive from the file name,
        //   minus the .zip / .skill extension.
        let name = layout.topDir;
        if (!name) {
            name = file.name.replace(/\.(zip|skill)$/i, '');
        }
        if (!name || /^[. ]+$/.test(name)) {
            return { ok: false, error: 'Could not derive a folder name for this skill.' };
        }
        // Sanitize: only allow safe filename chars; preserve hyphens and underscores.
        name = name.replace(/[\\/:*?"<>|]/g, '_').trim();

        const ensured = await ensureSkillsDir(name);
        if (!ensured.ok) return ensured;

        const files = {};
        for (const [path, content] of Object.entries(entries)) {
            if (isJunk(path)) continue;
            // fflate flags directories with a trailing slash — skip them
            // (we create dirs on demand via ensureDir).
            if (path.endsWith('/')) continue;

            // Strip the zip's top-level folder if there was one, so files
            // land at <skill>/SKILL.md not <skill>/<top>/SKILL.md.
            let rel = path;
            if (layout.topDir && rel.startsWith(layout.topDir + '/')) {
                rel = rel.slice(layout.topDir.length + 1);
            }
            const fileName = rel.slice(rel.lastIndexOf('/') + 1);
            if (!fileName) continue;
            files[rel] = content;
        }

        return installFiles(name, files);
    }

    /**
     * Open a file picker for .zip / .skill files and import the chosen one.
     * Browser shows a standard input dialog; no FSA-only behavior here.
     */
    function importFromZipPicker() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.zip,.skill,application/zip';
            input.style.display = 'none';
            input.onchange = async () => {
                const file = input.files?.[0];
                input.remove();
                if (!file) return resolve({ ok: false, cancelled: true });
                resolve(await importFromZipFile(file));
            };
            // Some browsers need the input in the DOM to fire the dialog.
            document.body.appendChild(input);
            input.click();
        });
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
    async function importFromGitHub(url) {
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

        const ensured = await ensureSkillsDir(safeName);
        if (!ensured.ok) return ensured;
        const files = {};
        try {
            await fetchGitHubTree(owner, repo, ref, path, files);
        } catch (e) {
            return { ok: false, error: 'Download failed: ' + (e?.message || e) };
        }
        return installFiles(safeName, files);
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

    /**
     * Export: zip <root>/skills/<dirName>/ with every file under one top-level
     * folder named after the skill, the layout importFromZipFile() reads back.
     * Junk, dotfiles (may hold secrets) and __pycache__ are left out.
     * Returns { ok, name, bytes } or { ok: false, error }.
     */
    async function exportSkillZip(dirName) {
        if (!window.fflate || typeof window.fflate.zip !== 'function') {
            return { ok: false, error: 'Zip library (fflate) is not loaded.' };
        }
        const found = filterSkillFiles(window.skillsFs ? await window.skillsFs.readSkillFiles(dirName) : {});
        if (!Object.keys(found).length) return { ok: false, error: `Skill folder "${dirName}" not found.` };
        const leaf = dirName.split('/').pop();
        const files = {};
        for (const [rel, b] of Object.entries(found)) files[`${leaf}/${rel}`] = b;

        const bytes = await new Promise((resolve, reject) => {
            window.fflate.zip(files, { level: 6 }, (err, data) => err ? reject(err) : resolve(data));
        });
        return { ok: true, name: leaf, bytes };
    }

    window.skillsImport = {
        importFromFolder,
        importFromZipPicker,
        importFromZipFile,    // exposed for drag-drop later
        importFromGitHub,
        exportSkillZip,
        readFolderFiles,
        filterSkillFiles,
    };
})();
