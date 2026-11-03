/**
 * Skill requires: which other skills a skill needs to run (it loads their scripts or files through the
 * skills root, e.g. servicenow-automation-author's load_script('playbook-author', 'create.py')).
 * Twin of PHP LangGraphPackage::requiredSkills.
 *
 * A skill requires:
 *   - every skill listed in `requires-skills:` of its SKILL.md frontmatter (list or single form, parsed as
 *     `dependencies:`), and
 *   - every OTHER installed skill whose leaf folder name appears in its own scripts/** text files as a quoted
 *     string ('name' / "name") or as a path segment of one ('/skill/name/references/x.md').
 * Names resolve against the installed skill paths (resolveName). The closure follows each required skill's
 * own requirements, cycle-safe, dependencies first.
 *
 * Pure: no DOM, no storage. closure() reads files through the reader it is given.
 *   direct(path, files, installed)          -> { requires: [path], missing: [name] }
 *   closure(path, installed, read(path))    -> { requires: [path, dependencies first], missing: [{ name, by }] }
 *   missingError(missing)                   -> Error, code 'missing-skill' (+ .skill, .by)
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SkillRequires = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const dec = new TextDecoder('utf-8', { fatal: true });
    const leafOf = (p) => String(p).split('/').pop();
    const groupOf = (p) => (String(p).includes('/') ? String(p).split('/')[0] : '');

    /** `requires-skills:` of a SKILL.md frontmatter ([] when absent). */
    function declared(md) {
        const lines = String(md || '').split(/\r\n|\r|\n/);
        if (lines[0].trim() !== '---') return [];
        for (const line of lines.slice(1)) {
            const s = line.trim();
            if (s === '---') break;
            if (s.toLowerCase().startsWith('requires-skills:')) {
                const val = s.slice(s.indexOf(':') + 1).trim().replace(/^\[+|\]+$/g, '');
                return val.split(',').map((d) => d.trim().replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
            }
        }
        return [];
    }

    /** The installed skill a name means: the exact path, else by leaf (same group as `from`, then top level, then any). */
    function resolveName(name, installed, from) {
        const list = installed || [];
        if (list.includes(name)) return name;
        const leaf = leafOf(name);
        const hits = list.filter((p) => leafOf(p) === leaf);
        if (!hits.length) return null;
        const g = groupOf(from || '');
        return hits.find((p) => groupOf(p) === g) || hits.find((p) => !p.includes('/')) || hits.slice().sort()[0];
    }

    const isText = (b) => { try { dec.decode(b); return true; } catch (e) { return false; } };
    const toText = (b) => (typeof b === 'string' ? b : dec.decode(b));

    /** The skill's own requirements (one level). files: { rel: bytes } of that skill; installed: skill paths. */
    function direct(path, files, installed) {
        const list = (installed || []).filter((p) => p !== path);
        const out = new Set();
        const missing = [];
        const md = files && files['SKILL.md'] ? toText(files['SKILL.md']) : '';
        for (const name of declared(md)) {
            const hit = resolveName(name, list, path);
            if (hit) out.add(hit); else missing.push(name);
        }
        // Quoted literals of the scripts; a literal names a skill when one of its '/'-segments is its leaf name.
        const segments = new Set();
        for (const [rel, b] of Object.entries(files || {})) {
            if (!rel.startsWith('scripts/') || rel.split('/').includes('__pycache__') || rel.endsWith('.pyc')) continue;
            if (typeof b !== 'string' && !isText(b)) continue;
            const re = /'([^'\n\\]*)'|"([^"\n\\]*)"/g;
            const text = toText(b);
            let m;
            while ((m = re.exec(text)) !== null) {
                for (const seg of (m[1] !== undefined ? m[1] : m[2]).split('/')) if (seg) segments.add(seg);
            }
        }
        const byLeaf = new Map();
        for (const p of list) if (!byLeaf.has(leafOf(p))) byLeaf.set(leafOf(p), true);
        for (const leaf of byLeaf.keys()) {
            if (segments.has(leaf)) out.add(resolveName(leaf, list, path));
        }
        return { requires: [...out].sort(), missing };
    }

    /** Every skill `path` needs, transitively; read(path) -> { rel: bytes } | null (null = cannot be read: missing). */
    async function closure(path, installed, read) {
        const order = [];
        const missing = [];
        const seen = new Set([path]);
        const visit = async (p, by) => {
            const files = await read(p);
            if (!files) { missing.push({ name: p, by }); return false; }
            const d = direct(p, files, installed);
            for (const name of d.missing) missing.push({ name, by: p });
            for (const q of d.requires) {
                if (seen.has(q)) continue;
                seen.add(q);
                if (await visit(q, p)) order.push(q);
            }
            return true;
        };
        await visit(path, null);
        return { requires: order, missing };
    }

    function missingError(missing) {
        const m = (missing || [])[0] || {};
        const e = new Error(`${m.by || '?'} needs skill ${m.name || '?'}, which is not installed.`);
        return Object.assign(e, { code: 'missing-skill', skill: m.name, by: m.by });
    }

    return { declared, resolveName, direct, closure, missingError };
});
