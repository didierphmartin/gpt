/**
 * Filesystem-backed Skills service.
 *
 * Walks `<root>/skills/*` looking for folders that contain a SKILL.md
 * file (Anthropic spec). Parses the YAML frontmatter for the required
 * `name` + `description` fields and exposes them to the rest of the app.
 *
 * Standalone — depends only on window.localFs for the root handle.
 *
 * Usage:
 *   const skills = await window.skillsFs.listSkills();
 *   // -> [{ name, description, dirName, dirHandle, skillMdHandle }, ...]
 *
 *   const body = await window.skillsFs.getSkillContent('medium-format');
 *   // -> the SKILL.md body (frontmatter stripped) — pass directly as
 *   //    `skill_content` in the chat API request.
 */
(function () {
    'use strict';

    /**
     * Parse the YAML frontmatter at the top of a SKILL.md file.
     * Returns { meta, body } where:
     *   - meta is an object with parsed key/value pairs (only string values
     *     are supported; lists/objects are returned as raw strings).
     *   - body is the markdown content with frontmatter stripped.
     *
     * No external dependency: SKILL.md frontmatter is intentionally minimal
     * (just `name` and `description` per Anthropic's spec) so a tiny line
     * parser is enough.
     */
    function parseFrontmatter(text) {
        if (!text.startsWith('---')) return { meta: {}, body: text };
        // The opening `---` line ends at the first newline; the closing
        // `---` is the next standalone line of three dashes.
        const lines = text.split('\n');
        if (lines[0].trim() !== '---') return { meta: {}, body: text };

        let endIdx = -1;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === '---') { endIdx = i; break; }
        }
        if (endIdx === -1) return { meta: {}, body: text };

        const meta = {};
        let lastKey = null;
        for (let i = 1; i < endIdx; i++) {
            const line = lines[i];
            // Continuation line for multi-line scalar (rare in skill frontmatter
            // but cheap to support): if the line starts with whitespace, append
            // to the previous value.
            if (lastKey !== null && /^\s/.test(line) && line.trim() !== '') {
                meta[lastKey] = (meta[lastKey] + ' ' + line.trim()).trim();
                continue;
            }
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
            if (!m) { lastKey = null; continue; }
            const key = m[1];
            let val = m[2].trim();
            // Strip simple surrounding quotes.
            if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
                (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
                val = val.slice(1, -1);
            }
            meta[key] = val;
            lastKey = key;
        }

        const body = lines.slice(endIdx + 1).join('\n').replace(/^\n+/, '');
        return { meta, body };
    }

    /**
     * Validate parsed frontmatter against the agentskills.io / Anthropic
     * SKILL.md spec. Returns { compliant: bool, issues: [string] }.
     *
     * Required fields:
     *   - name: 1-64 chars, lowercase alphanumeric + hyphens, must equal
     *     the parent directory name.
     *   - description: 1-1024 chars.
     *
     * Strictly informational — we don't refuse to load a skill that
     * fails validation, just surface the issues in the picker so authors
     * can fix them.
     */
    function validateFrontmatter(meta, dirName) {
        const issues = [];
        const name = (meta.name || '').trim();
        if (!name) {
            issues.push('Missing required `name` frontmatter field.');
        } else {
            if (name.length > 64) issues.push('`name` exceeds 64 chars.');
            if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
                issues.push('`name` must be lowercase alphanumeric + hyphens (e.g. "my-skill").');
            }
            if (dirName && name !== dirName) {
                issues.push(`\`name\` ("${name}") must match folder name ("${dirName}").`);
            }
        }
        const desc = (meta.description || '').trim();
        if (!desc) {
            issues.push('Missing required `description` frontmatter field.');
        } else if (desc.length > 1024) {
            issues.push('`description` exceeds 1024 chars.');
        }
        return { compliant: issues.length === 0, issues };
    }

    /**
     * Read a file handle's full text content as UTF-8.
     */
    async function readText(fileHandle) {
        const file = await fileHandle.getFile();
        return await file.text();
    }

    // Directories that are never skills or skill groups: VCS internals,
    // dotfiles, and common tooling/output dirs. These show up once `skills/`
    // is itself a git repo (e.g. `.git`, `docs`) and must be hidden from the
    // skills tree.
    const NON_SKILL_DIRS = new Set(['node_modules', '__pycache__', 'docs', 'scratch', 'outputs', 'dist', 'build']);
    function isNonSkillDir(name) {
        return !name || name.startsWith('.') || NON_SKILL_DIRS.has(name);
    }

    /**
     * True when a directory handle contains a SKILL.md file. This is the
     * single disambiguator under `<root>/skills/`: a directory with a
     * SKILL.md is a skill; a directory without one is a (group) folder.
     */
    async function hasSkillMd(dirHandle) {
        try {
            await dirHandle.getFileHandle('SKILL.md', { create: false });
            return true;
        } catch {
            // No SKILL.md. We don't fall back to lowercase 'skill.md' — we
            // stay aligned with Anthropic's canonical casing.
            return false;
        }
    }

    /**
     * Shape one skill directory into the entry format the rest of the app
     * consumes. `group` is the parent folder name, or null for a skill that
     * sits directly under `skills/`.
     *
     * `dirName` is the path RELATIVE TO `skills/` — just the folder name for
     * a root skill (`pubmed`), or `<group>/<folder>` for a grouped one
     * (`research/pubmed`). Every FS helper here resolves a skill by that
     * path, so callers never need to know the group separately.
     */
    async function buildSkillEntry(dirHandle, group) {
        const skillMd = await dirHandle.getFileHandle('SKILL.md', { create: false });
        let meta = {};
        let dependencies = [];
        try {
            const text = await readText(skillMd);
            meta = parseFrontmatter(text).meta;
            dependencies = window.SkillZip ? window.SkillZip.skillDependencies(text) : [];
        } catch (e) {
            console.warn(`[skillsFs] Failed to read ${dirHandle.name}/SKILL.md:`, e);
        }
        // Spec compliance is checked against the skill's OWN folder name,
        // never the group-prefixed path.
        const compliance = validateFrontmatter(meta, dirHandle.name);
        return {
            name: meta.name || dirHandle.name,
            description: meta.description || '',
            dirName: group ? `${group}/${dirHandle.name}` : dirHandle.name,
            leafName: dirHandle.name,
            group: group || null,
            dirHandle,
            skillMdHandle: skillMd,
            source: 'local',
            visibility: 'private',
            mine: true,
            ownerId: null,
            dependencies,
            meta,                          // raw frontmatter for downstream consumers
            spec_compliant: compliance.compliant,
            spec_issues: compliance.issues,
        };
    }

    /**
     * Walk `<root>/skills/` and return one entry per skill. Skills may sit
     * directly under `skills/` or one level down inside a group folder:
     *
     *   skills/pubmed/SKILL.md            → root skill   (group: null)
     *   skills/research/pubmed/SKILL.md   → grouped      (group: 'research')
     *
     * Recursion is intentionally one level deep — a group folder holds
     * skills, not other groups.
     */
    async function folderListSkills() {
        if (!window.localFs) return [];
        const skillsDir = await window.localFs.resolvePath('skills');
        if (!skillsDir) return [];

        const out = [];
        for await (const entry of skillsDir.values()) {
            if (entry.kind !== 'directory' || isNonSkillDir(entry.name)) continue;
            if (await hasSkillMd(entry)) {
                out.push(await buildSkillEntry(entry, null));
            } else {
                // A directory without SKILL.md is a group folder — descend
                // one level and collect the skills inside it.
                for await (const child of entry.values()) {
                    if (child.kind === 'directory' && await hasSkillMd(child)) {
                        out.push(await buildSkillEntry(child, entry.name));
                    }
                }
            }
        }
        // Stable alphabetical order — predictable to the user.
        out.sort((a, b) => (a.name || a.dirName).localeCompare(b.name || b.dirName));
        return out;
    }

    /**
     * List the group folders directly under `skills/` — directories that do
     * NOT themselves contain a SKILL.md. Returned even when empty, so a
     * freshly created folder shows up in the tree before any skill is in it.
     */
    async function folder_listFolders() {
        if (!window.localFs) return [];
        const skillsDir = await window.localFs.resolvePath('skills');
        if (!skillsDir) return [];
        const out = [];
        for await (const entry of skillsDir.values()) {
            if (entry.kind === 'directory' && !isNonSkillDir(entry.name) && !(await hasSkillMd(entry))) {
                out.push({ name: entry.name });
            }
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    /**
     * Return the SKILL.md body (frontmatter stripped) for a skill, addressed
     * by its path relative to `skills/` (`pubmed`, or `research/pubmed` for a
     * grouped skill). This is exactly the string the chat backend accepts as
     * `skill_content`.
     */
    async function folder_getSkillContent(skillPath) {
        if (!skillPath || !window.localFs) return '';
        const skillMd = await window.localFs.resolvePath(
            `skills/${skillPath}/SKILL.md`, { kind: 'file' }
        );
        if (!skillMd) return '';
        const text = await readText(skillMd);
        return parseFrontmatter(text).body;
    }

    /**
     * Read an arbitrary file under a skill folder, e.g.
     *   skillsFs.getSkillFile('medium-format', 'references/medium-html-spec.md')
     * Returns the file text or null if missing. Useful for "load this on
     * demand" levels described in Anthropic's progressive-disclosure model.
     */
    async function folder_getSkillFile(dirName, relativePath) {
        if (!dirName || !relativePath || !window.localFs) return null;
        const handle = await window.localFs.resolvePath(`skills/${dirName}/${relativePath}`, { kind: 'file' });
        if (!handle) return null;
        return await readText(handle);
    }

    /**
     * Recursively walk a directory handle, yielding skill-relative paths for
     * every file whose name ends in one of `extensions`. Used by
     * listSkillScripts; kept private so the spec — Python scripts under
     * `scripts/` — stays the only thing exposed.
     */
    async function* walkFiles(dirHandle, prefix, extensions) {
        for await (const entry of dirHandle.values()) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.kind === 'directory') {
                yield* walkFiles(entry, path, extensions);
            } else if (entry.kind === 'file') {
                const lower = entry.name.toLowerCase();
                if (extensions.some(ext => lower.endsWith(ext))) {
                    yield path;
                }
            }
        }
    }

    /**
     * Enumerate the executable Python scripts shipped with a folder-backed
     * skill. Anthropic's spec puts them under `scripts/` so we scope the
     * walk there — anything outside that subdir is treated as data/refs and
     * skipped, which keeps the LLM's tool surface small and predictable.
     * Returns skill-relative paths (e.g. ['scripts/transform.py']) sorted
     * alphabetically. Returns [] if the skill has no `scripts/` folder.
     */
    async function folder_listSkillScripts(dirName) {
        if (!dirName || !window.localFs) return [];
        const scriptsDir = await window.localFs.resolvePath(`skills/${dirName}/scripts`);
        if (!scriptsDir) return [];
        const out = [];
        try {
            for await (const rel of walkFiles(scriptsDir, 'scripts', ['.py'])) {
                out.push(rel);
            }
        } catch (e) {
            console.warn(`[skillsFs] failed to walk scripts/ for ${dirName}:`, e);
            return [];
        }
        out.sort();
        return out;
    }

    /**
     * Enumerate the Markdown reference docs shipped with a folder-backed
     * skill. Anthropic's spec keeps supporting material under `references/`,
     * so we scope the walk there. Returns skill-relative paths (e.g.
     * ['references/second.md']) sorted alphabetically, or [] when the skill
     * has no `references/` folder.
     */
    async function folder_listSkillReferences(dirName) {
        if (!dirName || !window.localFs) return [];
        const refsDir = await window.localFs.resolvePath(`skills/${dirName}/references`);
        if (!refsDir) return [];
        const out = [];
        try {
            for await (const rel of walkFiles(refsDir, 'references', ['.md'])) {
                out.push(rel);
            }
        } catch (e) {
            console.warn(`[skillsFs] failed to walk references/ for ${dirName}:`, e);
            return [];
        }
        out.sort();
        return out;
    }

    // ───────────────────────── Folder & skill mutation ─────────────────────
    //
    // The File System Access API has no native rename or move for
    // directories, so rename/move are recursive copy + delete. All mutation
    // goes through these helpers so callers never juggle raw directory
    // handles — they pass a path relative to `skills/` and get {ok, ...} back.

    /**
     * Strip characters illegal in folder names on common filesystems, plus
     * leading/trailing dots and whitespace. Folder names are display labels —
     * unlike skill names they need not be spec-lowercase.
     */
    function sanitizeFolderName(name) {
        return String(name || '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/^[.\s]+|[.\s]+$/g, '')
            .trim();
    }

    /** Recursively copy every entry of the `src` directory into `dst`. */
    async function copyDir(src, dst) {
        for await (const entry of src.values()) {
            if (entry.kind === 'file') {
                const file = await entry.getFile();
                const fh = await dst.getFileHandle(entry.name, { create: true });
                const w = await fh.createWritable();
                await w.write(await file.arrayBuffer());
                await w.close();
            } else {
                const sub = await dst.getDirectoryHandle(entry.name, { create: true });
                await copyDir(entry, sub);
            }
        }
    }

    /** Resolve the `skills/` root directory handle, or throw a clear error. */
    async function skillsRoot() {
        const dir = await window.localFs?.resolvePath('skills');
        if (!dir) throw new Error('Local skills folder not accessible.');
        return dir;
    }

    /**
     * Create an empty group folder directly under `skills/`.
     * Returns { ok, name } or { ok:false, error }.
     */
    async function folder_createFolder(name) {
        const safe = sanitizeFolderName(name);
        if (!safe) return { ok: false, error: 'Please enter a valid folder name.' };
        try {
            const root = await skillsRoot();
            try {
                await root.getDirectoryHandle(safe, { create: false });
                return { ok: false, error: `"${safe}" already exists under skills/.` };
            } catch { /* name is free — fall through */ }
            await root.getDirectoryHandle(safe, { create: true });
            return { ok: true, name: safe };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    /**
     * Delete a group folder (recursive — anything still inside goes with it).
     * The caller is responsible for confirming a non-empty delete.
     */
    async function folder_deleteFolder(name) {
        try {
            const root = await skillsRoot();
            await root.removeEntry(name, { recursive: true });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    /** Rename a group folder (copy to the new name, then remove the old). */
    async function folder_renameFolder(oldName, newName) {
        const safe = sanitizeFolderName(newName);
        if (!safe) return { ok: false, error: 'Please enter a valid folder name.' };
        if (safe === oldName) return { ok: true, name: safe };
        try {
            const root = await skillsRoot();
            try {
                await root.getDirectoryHandle(safe, { create: false });
                return { ok: false, error: `"${safe}" already exists under skills/.` };
            } catch { /* free */ }
            const src = await root.getDirectoryHandle(oldName, { create: false });
            const dst = await root.getDirectoryHandle(safe, { create: true });
            await copyDir(src, dst);
            await root.removeEntry(oldName, { recursive: true });
            return { ok: true, name: safe };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    /**
     * Move a skill into a different group. `skillPath` is the skill's current
     * path relative to `skills/`; `targetGroup` is a folder name, or '' / null
     * to move it back to the top level. Returns the new path on success.
     */
    async function folder_moveSkill(skillPath, targetGroup) {
        try {
            const root = await skillsRoot();
            const leaf = skillPath.split('/').pop();
            const slash = skillPath.lastIndexOf('/');
            const srcParent = slash === -1
                ? root
                : await window.localFs.resolvePath('skills/' + skillPath.slice(0, slash));
            if (!srcParent) return { ok: false, error: 'Source folder not found.' };
            const destParent = targetGroup
                ? await window.localFs.resolvePath(`skills/${targetGroup}`, { create: true })
                : root;
            if (!destParent) return { ok: false, error: 'Destination folder not found.' };
            try {
                await destParent.getDirectoryHandle(leaf, { create: false });
                return { ok: false, error: `A skill folder "${leaf}" already exists there.` };
            } catch { /* free */ }
            const src = await srcParent.getDirectoryHandle(leaf, { create: false });
            const dst = await destParent.getDirectoryHandle(leaf, { create: true });
            await copyDir(src, dst);
            await srcParent.removeEntry(leaf, { recursive: true });
            return { ok: true, path: targetGroup ? `${targetGroup}/${leaf}` : leaf };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    /** Delete a skill folder by its path relative to `skills/`. */
    async function folder_deleteSkill(skillPath) {
        try {
            const leaf = skillPath.split('/').pop();
            const slash = skillPath.lastIndexOf('/');
            const parent = slash === -1
                ? await skillsRoot()
                : await window.localFs.resolvePath('skills/' + skillPath.slice(0, slash));
            if (!parent) return { ok: false, error: 'Skill folder not found.' };
            await parent.removeEntry(leaf, { recursive: true });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    /**
     * Rename a skill's folder, within its current group. This changes the
     * directory name only — the `name:` field inside SKILL.md is the on-disk
     * source of truth for the display name and is left untouched, so a
     * renamed skill may flag a spec mismatch until SKILL.md is edited too.
     */
    async function folder_renameSkill(skillPath, newLeafName) {
        const safe = sanitizeFolderName(newLeafName);
        if (!safe) return { ok: false, error: 'Please enter a valid name.' };
        try {
            const leaf = skillPath.split('/').pop();
            const slash = skillPath.lastIndexOf('/');
            const groupPrefix = slash === -1 ? '' : skillPath.slice(0, slash + 1);
            const parent = slash === -1
                ? await skillsRoot()
                : await window.localFs.resolvePath('skills/' + skillPath.slice(0, slash));
            if (!parent) return { ok: false, error: 'Skill folder not found.' };
            if (safe === leaf) return { ok: true, path: skillPath };
            try {
                await parent.getDirectoryHandle(safe, { create: false });
                return { ok: false, error: `A skill folder "${safe}" already exists here.` };
            } catch { /* free */ }
            const src = await parent.getDirectoryHandle(leaf, { create: false });
            const dst = await parent.getDirectoryHandle(safe, { create: true });
            await copyDir(src, dst);
            await parent.removeEntry(leaf, { recursive: true });
            return { ok: true, path: groupPrefix + safe };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }


    // ───────────────────────── Folder or skill store ───────────────────────
    //
    // One module, two backends. `mode()` asks the server once whether skills
    // live in the Docker skill store ('volume') or in the user's own folder
    // ('folder'). Every public method below dispatches on it; the folder_*
    // functions above are the original local-folder implementations.

    const dec = new TextDecoder();
    const enc = new TextEncoder();

    function toB64(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }
    function fromB64(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    const asBytes = (v) => (typeof v === 'string' ? enc.encode(v) : v);

    function authToken() {
        if (window.authManager) return window.authManager.token || '';
        return (typeof localStorage !== 'undefined' && localStorage.getItem('token')) || '';
    }

    /** Same auth path as the MCP client: Bearer token against APP_CONFIG.API_BASE_URL. */
    async function api(method, path, body) {
        const base = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || '/gpt/backend/api/v1';
        const res = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken()}` },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = await res.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}: ${(data && (data.error || data.message)) || raw || res.statusText}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        // The backend answers { success, data, ... }: hand back the payload.
        return data && typeof data === 'object' && 'success' in data && 'data' in data ? data.data : data;
    }

    const enqPath = (p) => encodeURIComponent(p);

    // Cache a successful answer or a 404 (route absent -> folder). Any other failure
    // (not logged in yet, network blip) answers 'folder' for this call only and retries next time.
    let storeCache = null;
    async function storeInfo() {
        if (storeCache) return storeCache;
        try {
            const d = await api('GET', '/skills/store');
            storeCache = { mode: d && d.mode === 'volume' ? 'volume' : 'folder', edition: (d && d.edition) || '' };
            return storeCache;
        } catch (e) {
            const absent = { mode: 'folder', edition: '' };
            if (e.status === 404) storeCache = absent;
            return absent;
        }
    }
    async function mode() { return (await storeInfo()).mode; }
    async function edition() { return (await storeInfo()).edition; }

    /**
     * Folder mode: add `requires` (the DIRECT required skills, as paths) to each listed skill, with skill-requires.js
     * over its SKILL.md + scripts/ only. The store computes the same on the server (SkillStore::list).
     */
    // Not read for `requires`: bytecode caches and binaries (they cannot name a skill).
    const BINARY_EXT = /\.(pyc|pyo|so|dylib|dll|whl|zip|gz|png|jpe?g|gif|webp|ico|pdf|bin|pkl|npy|onnx)$/i;
    const skipNonScript = (p, entry) => entry.name === '__pycache__' || (entry.kind !== 'directory' && BINARY_EXT.test(entry.name));

    async function withFolderRequires(list) {
        if (!window.SkillRequires) return list.map((x) => ({ ...x, requires: [] }));
        const all = list.map((x) => x.dirName);
        return Promise.all(list.map(async (x) => {
            try {
                const dir = await window.localFs?.resolvePath(`skills/${x.dirName}/scripts`);
                const files = dir ? await walkBytes(dir, 'scripts', {}, skipNonScript) : {};
                const md = await folder_getSkillFile(x.dirName, 'SKILL.md');
                if (md !== null && md !== undefined) files['SKILL.md'] = enc.encode(md);
                return { ...x, requires: window.SkillRequires.direct(x.dirName, files, all).requires };
            } catch (e) {
                console.warn(`[skillsFs] could not work out what ${x.dirName} requires:`, e);
                return { ...x, requires: [] };
            }
        }));
    }

    // withRequires: add `requires` to each row (reads every skill's SKILL.md + scripts/, so only the Skills list asks).
    async function listSkills({ asRobot = false, withRequires = false } = {}) {
        if (await mode() !== 'volume') {
            const list = await folderListSkills();
            return withRequires ? withFolderRequires(list) : list;
        }
        const q = [asRobot ? 'as=robot' : '', withRequires ? 'requires=1' : ''].filter(Boolean).join('&');
        const rows = await api('GET', '/skills' + (q ? '?' + q : ''));
        const out = (rows || []).map((r) => {
            const parts = r.path.split('/');
            return {
                name: r.name || parts[parts.length - 1],
                description: r.description || '',
                dirName: r.path,
                path: r.path,
                leafName: parts[parts.length - 1],
                group: parts.length === 2 ? parts[0] : null,
                visibility: r.visibility,
                mine: !!r.mine,
                ownerId: r.owner_id ?? null,
                ownerName: r.owner_name || '',
                dependencies: r.dependencies || [],
                ...(withRequires ? { requires: r.requires || [] } : {}),
                source: 'store',
            };
        });
        out.sort((a, b) => (a.name || a.dirName).localeCompare(b.name || b.dirName));
        return out;
    }

    async function listFolders() {
        if (await mode() !== 'volume') return folder_listFolders();
        const groups = new Set();
        for (const s of await listSkills()) if (s.group) groups.add(s.group);
        return [...groups].sort().map((name) => ({ name }));
    }

    async function volumeFile(path, rel, asRobot = false) {
        try {
            const d = await api('GET', `/skills/file?path=${enqPath(path)}&rel=${enqPath(rel)}${asRobot ? '&as=robot' : ''}`);
            return d && typeof d.content === 'string' ? fromB64(d.content) : null;
        } catch (e) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    // asRobot (store only): read what the robot may see — a robot-owned workflow's skills.
    async function getSkillContent(skillPath, { asRobot = false } = {}) {
        if (!skillPath) return '';
        if (await mode() !== 'volume') return folder_getSkillContent(skillPath);
        const b = await volumeFile(skillPath, 'SKILL.md', asRobot);
        return b ? parseFrontmatter(dec.decode(b)).body : '';
    }

    async function getSkillFile(dirName, relativePath, { asRobot = false } = {}) {
        if (!dirName || !relativePath) return null;
        if (await mode() !== 'volume') return folder_getSkillFile(dirName, relativePath);
        const b = await volumeFile(dirName, relativePath, asRobot);
        return b ? dec.decode(b) : null;
    }

    async function listUnder(dirName, prefix, ext, asRobot) {
        const files = await readSkillFiles(dirName, { asRobot, under: prefix });
        return Object.keys(files)
            .filter((r) => r.startsWith(prefix + '/') && r.toLowerCase().endsWith(ext))
            .sort();
    }
    async function listSkillScripts(dirName, { asRobot = false } = {}) {
        if (!dirName) return [];
        if (await mode() !== 'volume') return folder_listSkillScripts(dirName);
        return listUnder(dirName, 'scripts', '.py', asRobot);
    }
    async function listSkillReferences(dirName, { asRobot = false } = {}) {
        if (!dirName) return [];
        if (await mode() !== 'volume') return folder_listSkillReferences(dirName);
        return listUnder(dirName, 'references', '.md', asRobot);
    }

    const tr = (key, params, fallback) => {
        const v = window.i18n && window.i18n.t ? window.i18n.t(key, params || {}) : key;
        return v === key && fallback ? fallback : v;
    };
    const leafOf = (p) => String(p || '').split('/').pop();

    /**
     * The refusal text for a skill other skills need ({ reason, skill, required_by, needs } from SkillRequiredBy, or
     * the folder check): delete | rename | private | public. t: the caller's translator (default window.i18n).
     */
    function requiredByMessage(d, t) {
        const tt = t || ((k, p) => tr(k, p));
        const params = { name: leafOf(d.skill), dependents: (d.required_by || []).join(', '), dep: d.needs || '' };
        return tt(`skills.requiredBy.${d.reason}`, params);
    }

    // The backend's own message (e.g. which path a rename/move clashes with) beats "HTTP 409: clash";
    // a skill other skills need is explained in the user's language.
    const failure = (e) => {
        const d = e?.data?.data;
        if (d && Array.isArray(d.required_by) && d.reason) return { ok: false, error: requiredByMessage(d), requiredBy: d.required_by };
        return { ok: false, error: d?.message || e?.message || String(e) };
    };

    /**
     * Folder mode: the skills of the folder that require `path` (skill-requires.js over SKILL.md + scripts/**).
     * The store checks this itself (SkillStore, only the skills the caller sees).
     */
    async function folderDependents(path) {
        if (!window.SkillRequires) return [];
        const all = (await folderListSkills()).map((x) => x.dirName);
        const out = [];
        for (const p of all) {
            if (p === path) continue;
            const files = await readSkillFiles(p, { under: 'scripts' });
            const md = await folder_getSkillFile(p, 'SKILL.md');
            if (md !== null && md !== undefined) files['SKILL.md'] = enc.encode(md);
            if (window.SkillRequires.direct(p, files, all).requires.includes(path)) out.push(p);
        }
        return out.sort();
    }

    async function folderRefusal(path, reason) {
        const deps = await folderDependents(path);
        return deps.length ? { ok: false, error: requiredByMessage({ reason, skill: path, required_by: deps }), requiredBy: deps } : null;
    }

    // Groups exist implicitly in the store (a group is the first segment of a skill path).
    async function createFolder(name) {
        if (await mode() !== 'volume') return folder_createFolder(name);
        const safe = sanitizeFolderName(name);
        return safe ? { ok: true, name: safe } : { ok: false, error: 'Please enter a valid folder name.' };
    }
    /** A group goes with all its skills: none may be needed by a skill outside it (checked for every one first). */
    async function deleteFolder(name) {
        if (await mode() !== 'volume') {
            const members = (await folderListSkills()).filter((x) => x.group === name).map((x) => x.dirName);
            for (const p of members) {
                const deps = (await folderDependents(p)).filter((d) => !members.includes(d));
                if (deps.length) return { ok: false, error: requiredByMessage({ reason: 'delete', skill: p, required_by: deps }), requiredBy: deps };
            }
            return folder_deleteFolder(name);
        }
        try {
            const mine = (await listSkills()).filter((x) => x.group === name && x.mine).map((x) => x.path);
            const del = (p, dry) => api('DELETE', `/skills?path=${enqPath(p)}&with=${enqPath(mine.filter((x) => x !== p).join(','))}${dry ? '&dry_run=1' : ''}`);
            for (const p of mine) await del(p, true);    // every skill checked before any is deleted
            for (const p of mine) await del(p, false);
            return { ok: true };
        } catch (e) { return failure(e); }
    }
    async function renameFolder(oldName, newName) {
        if (await mode() !== 'volume') return folder_renameFolder(oldName, newName);
        const safe = sanitizeFolderName(newName);
        if (!safe) return { ok: false, error: 'Please enter a valid folder name.' };
        if (safe === oldName) return { ok: true, name: safe };
        try {
            for (const s of await listSkills()) {
                if (s.group === oldName && s.mine) {
                    await api('POST', '/skills/move', { from: s.path, to: `${safe}/${s.leafName}` });
                }
            }
            return { ok: true, name: safe };
        } catch (e) { return failure(e); }
    }
    async function volumeMove(from, to) {
        try {
            await api('POST', '/skills/move', { from, to });
            return { ok: true, path: to };
        } catch (e) { return failure(e); }
    }
    async function moveSkill(skillPath, targetGroup) {
        if (await mode() !== 'volume') return folder_moveSkill(skillPath, targetGroup);
        const leaf = skillPath.split('/').pop();
        return volumeMove(skillPath, targetGroup ? `${targetGroup}/${leaf}` : leaf);
    }
    async function deleteSkill(skillPath) {
        if (await mode() !== 'volume') return (await folderRefusal(skillPath, 'delete')) || folder_deleteSkill(skillPath);
        try {
            await api('DELETE', `/skills?path=${enqPath(skillPath)}`);
            return { ok: true };
        } catch (e) { return failure(e); }
    }
    async function renameSkill(skillPath, newLeafName) {
        if (await mode() !== 'volume') {
            const same = sanitizeFolderName(newLeafName) === leafOf(skillPath);
            return (!same && (await folderRefusal(skillPath, 'rename'))) || folder_renameSkill(skillPath, newLeafName);
        }
        const safe = sanitizeFolderName(newLeafName);
        if (!safe) return { ok: false, error: 'Please enter a valid name.' };
        const slash = skillPath.lastIndexOf('/');
        if (safe === skillPath.slice(slash + 1)) return { ok: true, path: skillPath };
        return volumeMove(skillPath, (slash === -1 ? '' : skillPath.slice(0, slash + 1)) + safe);
    }

    // ───────────────────────── Whole-skill read / write ────────────────────

    /** Every file under a local directory, as { 'a/b.txt': Uint8Array }. */
    async function walkBytes(dirHandle, prefix, out, skip) {
        for await (const entry of dirHandle.values()) {
            const p = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (skip(p, entry)) continue;
            if (entry.kind === 'directory') await walkBytes(entry, p, out, skip);
            else out[p] = new Uint8Array(await (await entry.getFile()).arrayBuffer());
        }
        return out;
    }

    async function writeLocalFile(relPath, bytes) {
        const parts = relPath.split('/').filter(Boolean);
        const leaf = parts.pop();
        const dir = await window.localFs.resolvePath(parts.length ? `skills/${parts.join('/')}` : 'skills', { create: true });
        if (!dir) throw new Error('Local skills folder not accessible.');
        const fh = await dir.getFileHandle(leaf, { create: true });
        const w = await fh.createWritable();
        await w.write(asBytes(bytes));
        await w.close();
    }

    /**
     * { rel: Uint8Array } for one skill. Wheels (.wheels/...) only when asked.
     * under: only the files below that skill-relative folder (keys stay skill-relative);
     * in folder mode only that folder is walked.
     */
    async function readSkillFiles(path, { asRobot = false, withWheels = false, under = '' } = {}) {
        let files;
        const sub = String(under || '').replace(/^\/+|\/+$/g, '');
        if (await mode() === 'volume') {
            // wheels=0: the server leaves .wheels/ out instead of sending what would be dropped here.
            const d = await api('GET', `/skills/files?path=${enqPath(path)}${asRobot ? '&as=robot' : ''}${withWheels ? '' : '&wheels=0'}`);
            files = {};
            for (const [rel, b64] of Object.entries((d && d.files) || {})) {
                if (!sub || rel.startsWith(sub + '/')) files[rel] = fromB64(b64);
            }
        } else {
            const dir = await window.localFs?.resolvePath(sub ? `skills/${path}/${sub}` : `skills/${path}`);
            if (!dir) return {};
            files = await walkBytes(dir, sub, {}, () => false);
        }
        if (!withWheels) {
            for (const rel of Object.keys(files)) if (rel.startsWith('.wheels/')) delete files[rel];
        }
        return files;
    }

    /** Folder mode: [{ rel, size }] from directory handles; getFile() gives the size without reading the bytes. */
    async function walkSizes(dirHandle, prefix, out) {
        for await (const entry of dirHandle.values()) {
            if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name.endsWith('.pyc')) continue;
            const p = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.kind === 'directory') await walkSizes(entry, p, out);
            else out.push({ rel: p, size: (await entry.getFile()).size });
        }
        return out;
    }

    /**
     * [{ rel, size }] for one skill, SKILL.md first then byte order of rel; no file contents are read.
     * Left out: .wheels/, __pycache__/, dot-files.
     */
    async function listSkillFiles(path, { asRobot = false } = {}) {
        let rows;
        if (await mode() === 'volume') {
            const d = await api('GET', `/skills/listing?path=${enqPath(path)}${asRobot ? '&as=robot' : ''}`);
            rows = ((d && d.files) || []).map((f) => ({ rel: f.rel, size: f.size }));
        } else {
            const dir = await window.localFs?.resolvePath(`skills/${path}`);
            rows = dir ? await walkSizes(dir, '', []) : [];
        }
        const key = (r) => [r.rel === 'SKILL.md' ? 0 : 1, r.rel];
        return rows.sort((a, b) => {
            const [x, y] = [key(a), key(b)];
            return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
        });
    }

    /**
     * Names of the folders directly under a skill's `under` folder (e.g. the run folders of
     * body-opt-results). Folder mode lists the directory without reading files; the store derives
     * them from that folder's files.
     */
    async function listSkillFolders(path, under) {
        const sub = String(under || '').replace(/^\/+|\/+$/g, '');
        if (await mode() !== 'volume') {
            const dir = await window.localFs?.resolvePath(sub ? `skills/${path}/${sub}` : `skills/${path}`);
            if (!dir) return [];
            const out = [];
            for await (const e of dir.values()) if (e.kind === 'directory') out.push(e.name);
            return out.sort();
        }
        const names = new Set();
        for (const rel of Object.keys(await readSkillFiles(path, { under: sub }))) {
            const parts = (sub ? rel.slice(sub.length + 1) : rel).split('/');
            if (parts.length > 1) names.add(parts[0]);
        }
        return [...names].sort();
    }

    /** Folder mode: the skill's directory handle ('' = the skills root, created when missing). Store: null. */
    async function folderHandle(path = '') {
        if (await mode() === 'volume' || !window.localFs) return null;
        return path ? window.localFs.resolvePath(`skills/${path}`) : window.localFs.resolvePath('skills', { create: true });
    }

    /** Is there a skill (folder) at this path? In the store a skill with the same leaf name counts too. */
    async function skillExists(path) {
        if (await mode() !== 'volume') return !!(await window.localFs?.resolvePath(`skills/${path}`));
        const leaf = path.split('/').pop();
        return (await listSkills()).some((s) => s.path === path || s.leafName === leaf);
    }

    /**
     * Write several files of one skill ({ rel: string|Uint8Array }), creating the skill when it is new.
     * Folder: file by file (as before). Store: a skill of mine is updated file by file; a new one is
     * imported (private). Throws .code = 'clash' when the store holds a different skill of that name.
     */
    async function writeSkillFiles(path, files) {
        if (await mode() === 'volume' && !(await listSkills()).some((s) => s.mine && s.path === path)) {
            return importSkill({ dir: path, name: path.split('/').pop(), files, pyodideWheels: {}, nativeWheels: {} });
        }
        for (const [rel, b] of Object.entries(files)) await writeSkillFile(path, rel, b);
        return { status: 'installed' };
    }

    async function writeSkillFile(path, rel, bytes) {
        const data = asBytes(bytes);
        if (await mode() === 'volume') {
            await api('PUT', '/skills/file', { path, rel, content: toB64(data) });
        } else {
            await writeLocalFile(`${path}/${rel}`, data);
        }
        return { ok: true };
    }

    const clashError = (read) => Object.assign(new Error(`A different skill named "${read.name || read.dir}" already exists.`), { code: 'clash', skill: read.name || read.dir });
    const sameBytes = (a, b) => a && a.length === b.length && a.every((v, i) => v === b[i]);

    /**
     * What installing this one skill would do, writing nothing: 'new' | 'identical' | 'clash', plus (store, public)
     * madePublic: my own private skills it requires that would go public with it.
     */
    async function skillPlan(read, { visibility = 'private', batch = [] } = {}) {
        const all = window.SkillZip.toStoreFiles(read);
        if (await mode() === 'volume') {
            const files = {};
            for (const [rel, b] of Object.entries(all)) if (!rel.startsWith('.wheels/')) files[rel] = toB64(asBytes(b));
            try {
                // batch: the other skills of the same zip (installed with it): a requirement naming one resolves to it.
                const r = await api('POST', '/skills/import', { path: read.dir, visibility, files, dry_run: true, ...(batch.length ? { incoming: batch } : {}) });
                return { status: r && r.status === 'identical' ? 'identical' : 'new', madePublic: (r && r.made_public) || [] };
            } catch (e) {
                if (e.status === 409 && e.data?.data?.reason) throw e;   // a required skill it cannot take public along
                if (e.status === 409) return { status: 'clash', madePublic: [] };
                throw e;
            }
        }
        const existing = await readSkillFiles(read.dir);
        if (!Object.keys(existing).length) return { status: 'new', madePublic: [] };
        const incoming = Object.keys(all).filter((r) => !r.startsWith('.wheels/'));
        const same = incoming.length === Object.keys(existing).length && incoming.every((r) => sameBytes(existing[r], asBytes(all[r])));
        return { status: same ? 'identical' : 'clash', madePublic: [] };
    }

    /** Install one skill (no required skills). Throws .code 'clash' when a different skill is there. */
    async function importOne(read, { visibility = 'private', expectPublic = null, batch = [] } = {}) {
        const all = window.SkillZip.toStoreFiles(read);
        if (await mode() === 'volume') {
            const files = {};
            for (const [rel, b] of Object.entries(all)) files[rel] = toB64(asBytes(b));
            try {
                return await api('POST', '/skills/import', { path: read.dir, visibility, files, ...(expectPublic ? { expect_public: expectPublic } : {}), ...(batch.length ? { incoming: batch } : {}) });
            } catch (e) {
                if (e.status === 409) throw clashError(read);
                throw e;
            }
        }
        const st = (await skillPlan(read)).status;
        if (st === 'identical') return { status: 'identical' };
        if (st === 'clash') throw clashError(read);
        for (const [rel, b] of Object.entries(all)) await writeLocalFile(`${read.dir}/${rel}`, b);
        return { status: 'installed' };
    }

    /**
     * What importing a read (and the skills it requires, read.requires) would do, writing nothing:
     * [{ dir, name, status: 'new'|'identical'|'clash', madePublic: [path] }], required skills first, the read itself last.
     * madePublic (store, visibility public): my own private skills that go public with that one.
     */
    const batchOf = (read) => [...(read.requires || []), read].map((r) => r.dir);

    async function importPlan(read, opts = {}) {
        const out = [];
        const batch = batchOf(read);
        for (const r of [...(read.requires || []), read]) {
            const p = await skillPlan(r, { ...opts, batch: batch.filter((d) => d !== r.dir) });
            out.push({ dir: r.dir, name: r.name || r.dir.split('/').pop(), status: p.status, madePublic: p.madePublic });
        }
        return out;
    }

    /**
     * Install a SkillZip.read() result and the skills it requires (read.requires), all with the same visibility.
     * Every skill is checked before anything is written: a clash in any of them throws (.code 'clash', .skill)
     * and writes nothing. Required skills install first; an identical one is already installed.
     * A public import also takes my own private required skills public (the server, all or nothing); opts.confirmed
     * ({ dir: [path] }, from importPlan's madePublic the user confirmed) is checked by the server for each skill.
     * Returns { status, requires: [{ dir, name, status }] } ('installed' | 'identical').
     */
    async function importSkill(read, opts = {}) {
        const reqs = read.requires || [];
        const batch = batchOf(read);
        const one = (r) => importOne(r, { ...opts, batch: reqs.length ? batch.filter((d) => d !== r.dir) : [],
            expectPublic: opts.confirmed ? (opts.confirmed[r.dir] || []) : null });
        if (!reqs.length) return one(read);
        const plan = await importPlan(read, opts);
        const clash = plan.find((x) => x.status === 'clash');
        if (clash) throw clashError(clash);
        const requires = [];
        for (let i = 0; i < reqs.length; i++) {
            const res = plan[i].status === 'identical' ? { status: 'identical' } : await one(reqs[i]);
            requires.push({ dir: reqs[i].dir, name: plan[i].name, status: (res && res.status) || 'installed' });
        }
        const main = await one(read);
        return { ...main, requires };
    }

    /**
     * Public takes along the skills it requires that are still my own private ones (the server does it all or
     * nothing); dryRun: only ask which (made_public). Returns { made_public: [path] }.
     */
    async function setVisibility(path, visibility, { dryRun = false, expectPublic = null } = {}) {
        if (await mode() !== 'volume') return { ok: true, made_public: [] };   // a folder is always private
        // expectPublic: what the user confirmed goes along; the server refuses (reason 'changed') when that is no longer so.
        const r = await api('PUT', '/skills/visibility', { path, visibility, ...(dryRun ? { dry_run: true } : {}), ...(expectPublic ? { expect_public: expectPublic } : {}) });
        return { made_public: [], ...(r || {}) };
    }

    /** The caller's own skills, flat: { '<path>/<rel>': Uint8Array } (what skill-creator edits). */
    async function skillsRootFiles() {
        if (await mode() !== 'volume') {
            const dir = await window.localFs?.resolvePath('skills');
            if (!dir) return {};
            return walkBytes(dir, '', {}, (p, e) => e.name === '.git' || e.name === 'node_modules' || e.name === '__pycache__');
        }
        const out = {};
        for (const s of await listSkills()) {
            if (!s.mine) continue;
            const files = await readSkillFiles(s.path, { withWheels: true });
            for (const [rel, b] of Object.entries(files)) out[`${s.path}/${rel}`] = b;
        }
        return out;
    }

    /** Write back a skillsRootFiles()-shaped map: new skills are imported, existing ones updated file by file. */
    async function writeSkillsRoot(files) {
        if (await mode() !== 'volume') {
            for (const [p, b] of Object.entries(files)) await writeLocalFile(p, b);
            return { ok: true };
        }
        const known = new Set((await listSkills()).filter((s) => s.mine).map((s) => s.path));
        const dirs = new Set(known);
        for (const p of Object.keys(files)) {
            if (p.endsWith('/SKILL.md')) dirs.add(p.slice(0, -'/SKILL.md'.length));
        }
        const byDir = new Map();
        for (const [p, b] of Object.entries(files)) {
            const segs = p.split('/');
            // A skill dir is one or two segments; the longest match wins.
            const dir = [2, 1].map((n) => segs.slice(0, n).join('/')).find((c) => dirs.has(c) && p.length > c.length);
            if (dir === undefined) continue;
            if (!byDir.has(dir)) byDir.set(dir, {});
            byDir.get(dir)[p.slice(dir.length + 1)] = b;
        }
        for (const [dir, fl] of byDir) {
            if (known.has(dir)) {
                for (const [rel, b] of Object.entries(fl)) await writeSkillFile(dir, rel, b);
            } else {
                const read = window.SkillZip.fromStoreFiles(fl);
                await importSkill({ dir, name: dir.split('/').pop(), ...read }, { visibility: 'private' });
            }
        }
        return { ok: true };
    }

    /** The skills in the user's own folder, whatever the mode (the source of the one-time import into the store). */
    async function listFolderSkills() {
        return folderListSkills();
    }

    /** One folder skill's files, whatever the mode; leaves out dotfiles/dot-folders (.wheels, .git...) and __pycache__. */
    async function readFolderSkillFiles(path) {
        const dir = await window.localFs?.resolvePath(`skills/${path}`);
        if (!dir) return {};
        return walkBytes(dir, '', {}, (p, e) => e.name.startsWith('.') || e.name === '__pycache__');
    }

    window.skillsFs = {
        listFolderSkills,
        readFolderSkillFiles,
        listSkills,
        listFolders,
        listSkillScripts,
        listSkillReferences,
        getSkillContent,
        getSkillFile,
        createFolder,
        deleteFolder,
        renameFolder,
        moveSkill,
        deleteSkill,
        renameSkill,
        mode,
        edition,
        api,                 // authenticated backend call, unwraps {success,data}
        readSkillFiles,
        listSkillFiles,
        writeSkillFile,
        writeSkillFiles,
        skillExists,
        folderHandle,
        listSkillFolders,
        importSkill,
        importPlan,
        setVisibility,
        skillsRootFiles,
        writeSkillsRoot,
        requiredByMessage,
        parseFrontmatter,    // exported for testing
    };
})();
