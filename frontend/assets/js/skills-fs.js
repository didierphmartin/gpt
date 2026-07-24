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
        try {
            meta = parseFrontmatter(await readText(skillMd)).meta;
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
    async function listSkills() {
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
    async function listFolders() {
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
    async function getSkillContent(skillPath) {
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
    async function getSkillFile(dirName, relativePath) {
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
    async function listSkillScripts(dirName) {
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
    async function listSkillReferences(dirName) {
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
    async function createFolder(name) {
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
    async function deleteFolder(name) {
        try {
            const root = await skillsRoot();
            await root.removeEntry(name, { recursive: true });
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e?.message || String(e) };
        }
    }

    /** Rename a group folder (copy to the new name, then remove the old). */
    async function renameFolder(oldName, newName) {
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
    async function moveSkill(skillPath, targetGroup) {
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
    async function deleteSkill(skillPath) {
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
    async function renameSkill(skillPath, newLeafName) {
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

    window.skillsFs = {
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
        parseFrontmatter,    // exported for testing
    };
})();
