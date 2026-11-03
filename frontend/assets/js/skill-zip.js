/**
 * Skill zip: the self-contained file a skill travels in (skill folder + bundled wheels + manifest.json).
 * Pure: no DOM, no localFs. fflate comes from opts.fflate or root.fflate; WorkflowPackage (filesHash) from
 * opts.workflowPackage or root.WorkflowPackage / require('./workflow-package.js').
 * NOTE build() is async (filesHash uses crypto.subtle); read() stays synchronous.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./workflow-package.js'));
    else root.SkillZip = factory(root, root.WorkflowPackage);
})(typeof self !== 'undefined' ? self : this, function (root, WP) {
    const FORMAT = 1;
    const JUNK = ['.DS_Store', '__MACOSX', 'Thumbs.db'];
    const isJunk = (n) => JUNK.some((p) => n === p || n.startsWith(p + '/') || n.split('/').pop() === p);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const lib = (opts) => (opts && opts.fflate) || root.fflate;
    const wp = (opts) => (opts && opts.workflowPackage) || WP || root.WorkflowPackage;

    /** A relative path with no way out: no empty/./.. segments, no backslash, not absolute. */
    function isSafeRel(p) {
        return typeof p === 'string' && !!p && !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z]:/.test(p)
            && p.split('/').every((s) => s && s !== '.' && s !== '..');
    }
    /** Skill dir: one or two segments, none dot-prefixed. */
    const isSkillDir = (d) => isSafeRel(d) && d.split('/').length <= 2 && d.split('/').every((s) => !s.startsWith('.'));
    const isWheelName = (f) => typeof f === 'string' && !!f && !f.includes('/') && !f.includes('\\') && !f.startsWith('.');

    /** Twin of PHP LangGraphPackage::skillDependencies. */
    function skillDependencies(md) {
        const lines = String(md).split(/\r\n|\r|\n/);
        if (lines[0].trim() !== '---') return [];
        for (const line of lines.slice(1)) {
            const s = line.trim();
            if (s === '---') break;
            if (s.toLowerCase().startsWith('dependencies:')) {
                const val = s.slice(s.indexOf(':') + 1).trim().replace(/^\[+|\]+$/g, '');
                return val.split(',').map((d) => d.trim().replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
            }
        }
        return [];
    }

    const toBytes = (v) => (typeof v === 'string' ? enc.encode(v) : v);

    async function build({ dir, name, files, pyodideWheels, nativeWheels }, opts) {
        if (!isSkillDir(dir)) throw new Error('Unsafe skill folder: ' + dir);
        const z = {};
        const skillFiles = {};
        for (const [rel, b] of Object.entries(files || {})) {
            if (!isSafeRel(rel)) throw new Error('Unsafe path: ' + rel);
            skillFiles[rel] = toBytes(b);
            z[`skill/${dir}/${rel}`] = skillFiles[rel];
        }
        const py = pyodideWheels || {}, nat = nativeWheels || {};
        for (const [f, b] of Object.entries(py)) { if (!isWheelName(f)) throw new Error('Unsafe wheel: ' + f); z[`wheels/pyodide/${f}`] = toBytes(b); }
        for (const [f, b] of Object.entries(nat)) { if (!isWheelName(f)) throw new Error('Unsafe wheel: ' + f); z[`wheels/native/${f}`] = toBytes(b); }
        const md = skillFiles['SKILL.md'] ? dec.decode(skillFiles['SKILL.md']) : '';
        z['manifest.json'] = enc.encode(JSON.stringify({
            format: FORMAT, dir, name: name || dir.split('/').pop(), dependencies: skillDependencies(md),
            wheels: { pyodide: Object.keys(py), native: Object.keys(nat) },
            files_hash: await wp(opts).filesHash(skillFiles),
        }));
        return lib(opts).zipSync(z);
    }

    function read(bytes, opts) {
        const entries = lib(opts).unzipSync(bytes);
        for (const p of Object.keys(entries)) {
            if (!isSafeRel(p.replace(/\/$/, ''))) throw new Error('Unsafe path in zip: ' + p);
        }
        if (entries['manifest.json']) {
            const manifest = JSON.parse(dec.decode(entries['manifest.json']));
            if (!isSkillDir(manifest.dir)) throw new Error('Unsafe skill folder: ' + manifest.dir);
            const prefix = `skill/${manifest.dir}/`;
            const files = {}, pyodideWheels = {}, nativeWheels = {};
            for (const [p, b] of Object.entries(entries)) {
                if (p.endsWith('/')) continue;
                if (p.startsWith(prefix)) files[p.slice(prefix.length)] = b;
                else if (p.startsWith('wheels/pyodide/')) pyodideWheels[p.slice(15)] = b;
                else if (p.startsWith('wheels/native/')) nativeWheels[p.slice(14)] = b;
            }
            return { dir: manifest.dir, name: manifest.name || manifest.dir.split('/').pop(), files, pyodideWheels, nativeWheels, legacy: false, manifest };
        }
        // Legacy (mirror skills-import.js detectZipLayout): SKILL.md at root, or in a single top-level folder.
        const paths = Object.keys(entries).filter((p) => !isJunk(p) && !p.endsWith('/'));
        let topDir = null;
        if (paths.includes('SKILL.md')) topDir = '';
        else {
            const tops = new Set(paths.map((p) => p.split('/')[0]));
            if (tops.size === 1 && paths.includes(`${[...tops][0]}/SKILL.md`)) topDir = [...tops][0];
        }
        if (topDir === null) throw new Error('Zip does not contain a SKILL.md at the root or inside a single top-level folder.');
        const dir = topDir || (opts && opts.fallbackName) || '';
        if (!isSkillDir(dir)) throw new Error('Could not derive a folder name for this skill.');
        const files = {};
        for (const p of paths) files[topDir ? p.slice(topDir.length + 1) : p] = entries[p];
        return { dir, name: dir.split('/').pop(), files, pyodideWheels: {}, nativeWheels: {}, legacy: true, manifest: null };
    }

    function toStoreFiles(r) {
        const out = { ...r.files };
        for (const [f, b] of Object.entries(r.pyodideWheels || {})) out[`.wheels/pyodide/${f}`] = b;
        for (const [f, b] of Object.entries(r.nativeWheels || {})) out[`.wheels/native/${f}`] = b;
        out['.wheels/wheels.json'] = enc.encode(JSON.stringify({ pyodide: Object.keys(r.pyodideWheels || {}), native: Object.keys(r.nativeWheels || {}) }));
        return out;
    }

    function fromStoreFiles(all) {
        const files = {}, pyodideWheels = {}, nativeWheels = {};
        for (const [p, b] of Object.entries(all || {})) {
            if (p === '.wheels/wheels.json') continue;
            if (p.startsWith('.wheels/pyodide/')) pyodideWheels[p.slice(16)] = b;
            else if (p.startsWith('.wheels/native/')) nativeWheels[p.slice(15)] = b;
            else files[p] = b;
        }
        return { files, pyodideWheels, nativeWheels };
    }

    return { FORMAT, build, read, toStoreFiles, fromStoreFiles, skillDependencies };
});
