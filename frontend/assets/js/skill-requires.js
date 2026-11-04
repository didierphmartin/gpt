/**
 * Skill requires: which other skills a skill needs to run (it loads their scripts or files through the
 * skills root, e.g. servicenow-automation-author's load_script('playbook-author', 'create.py')).
 * Twin of PHP LangGraphPackage::requiredSkills.
 *
 * A skill requires:
 *   - when its SKILL.md frontmatter declares `requires-skills:` (list or single form, parsed as `dependencies:`):
 *     exactly those, else
 *   - every OTHER installed skill whose leaf folder name is an exact quoted string of its scripts/** text files
 *     ('name' / "name") or a /name/ path segment (slashes on both sides) inside one ('/skill/name/references/x.md').
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

    /**
     * Items of a frontmatter list value (`a, b` or `[a, 'b,c']`, as dependencies:/requires-skills: are written):
     * split on commas outside single/double quotes, then one matching quote pair is stripped ('' -> ' inside
     * single quotes). An unterminated quote falls back to splitting on every comma. Twin of PHP
     * LangGraphPackage::listItems and the emitted Python dependency readers.
     */
    function listItems(raw) {
        const val = String(raw == null ? '' : raw).trim().replace(/^\[+|\]+$/g, '');
        const items = [];
        let cur = '', q = null;
        for (let i = 0; i < val.length; i++) {
            const c = val[i];
            if (q) {
                cur += c;
                if (c === q) {
                    if (q === "'" && val[i + 1] === "'") cur += val[++i];
                    else q = null;
                }
            } else if ((c === '"' || c === "'") && cur.trim() === '') { q = c; cur += c; }
            else if (c === ',') { items.push(cur); cur = ''; }
            else cur += c;
        }
        items.push(cur);
        if (q) return val.split(',').map((d) => d.trim().replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
        return items.map((d) => {
            d = d.trim();
            const k = d[0];
            if (d.length >= 2 && (k === "'" || k === '"') && d[d.length - 1] === k) {
                d = d.slice(1, -1);
                if (k === "'") d = d.replace(/''/g, "'");
            }
            return d;
        }).filter(Boolean);
    }

    /** `requires-skills:` of a SKILL.md frontmatter ([] when absent). */
    function declared(md) {
        const lines = String(md || '').split(/\r\n|\r|\n/);
        if (lines[0].trim() !== '---') return [];
        for (const line of lines.slice(1)) {
            const s = line.trim();
            if (s === '---') break;
            if (s.toLowerCase().startsWith('requires-skills:')) {
                return listItems(s.slice(s.indexOf(':') + 1));
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

    /**
     * The skill's own requirements (one level). files: { rel: bytes } of that skill; installed: skill paths.
     * A skill that declares `requires-skills:` requires exactly those (no scanning). Otherwise: every other installed
     * skill whose leaf name is an exact quoted literal ('x' / "x") of its scripts/** text files, or appears in one as
     * a path segment with a slash on both sides ('/skill/x/references/a.md'); "text/html" does not name html.
     */
    function direct(path, files, installed) {
        const list = (installed || []).filter((p) => p !== path);
        const out = new Set();
        const missing = [];
        const md = files && files['SKILL.md'] ? toText(files['SKILL.md']) : '';
        const decl = declared(md);
        if (decl.length) {
            for (const name of decl) {
                const hit = resolveName(name, list, path);
                if (hit) out.add(hit); else missing.push(name);
            }
            return { requires: [...out].sort(), missing };
        }
        const literals = [];
        for (const [rel, b] of Object.entries(files || {})) {
            if (!rel.startsWith('scripts/') || rel.split('/').includes('__pycache__') || rel.endsWith('.pyc')) continue;
            if (typeof b !== 'string' && !isText(b)) continue;
            const re = /'([^'\n\\]*)'|"([^"\n\\]*)"/g;
            const text = toText(b);
            let m;
            while ((m = re.exec(text)) !== null) literals.push(m[1] !== undefined ? m[1] : m[2]);
        }
        const exact = new Set(literals);
        const leaves = new Set(list.map(leafOf));
        for (const leaf of leaves) {
            if (exact.has(leaf) || literals.some((l) => l.includes(`/${leaf}/`))) out.add(resolveName(leaf, list, path));
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

    /**
     * Required skills land at their leaf (SKILLS_ROOT/<leaf>/): two different skills with one leaf cannot both be there.
     * main: the skill's own path (it stays at that path); required: [path]. Returns an Error (code 'leaf-collision',
     * .skills, .leaf) or null.
     */
    function leafCollision(main, required) {
        const at = new Map(main ? [[main, main]] : []);
        for (const p of required || []) {
            const leaf = leafOf(p);
            const other = at.get(leaf);
            if (other !== undefined && other !== p) {
                return Object.assign(new Error(`Skills ${other} and ${p} both need to be available as '${leaf}'; rename one.`),
                    { code: 'leaf-collision', skills: [other, p], leaf });
            }
            at.set(leaf, p);
        }
        return null;
    }

    function missingError(missing) {
        const m = (missing || [])[0] || {};
        const e = new Error(`${m.by || '?'} needs skill ${m.name || '?'}, which is not installed.`);
        return Object.assign(e, { code: 'missing-skill', skill: m.name, by: m.by });
    }

    return { listItems, declared, resolveName, direct, closure, missingError, leafCollision };
});
