/**
 * Skill frontmatter: split SKILL.md into frontmatter + body, and rebuild the frontmatter line-span by line-span so
 * every field the user did not edit is written back byte-for-byte (the frontmatter drives imports, runs and delete
 * protection: requires-skills, dependencies, allowed-tools). Pure: no DOM, no dependencies.
 *
 * split(text)  -> { front, body, eol, open, close, closeEol }   front = whole lines between the --- lines (each with
 *                 its line terminator), null when there is no frontmatter. open/close/closeEol keep the delimiter
 *                 lines exact so join(split(t)) === t.
 * fields(front)-> [{ key, start, end, raw, value, complex }]   one per top-level key (start/end = line indexes, end
 *                 exclusive). A comment/blank run before the first key is a span with key null (untouchable).
 *                 value: string | string[]; complex:true => value is the raw text after the colon (read-only).
 * rebuild(front, edits) -> string   edits = { key: string | string[] | null }; null removes the span.
 * join({ front, body, eol, ... }) -> string
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SkillFrontmatter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const REQUIRED = ['name', 'description'];
    const KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.\- ]*?)[ \t]*:(?:[ \t](.*))?$/;

    // Lines with their terminators kept.
    function lines(s) { return s === '' ? [] : s.match(/[^\n]*\n|[^\n]+$/g); }
    const bare = (l) => l.replace(/\r?\n$/, '');

    function split(text) {
        text = String(text);
        const ls = lines(text) || [];
        const none = { front: null, body: text, eol: text.includes('\r\n') ? '\r\n' : '\n', open: '---', close: '---', closeEol: '\n' };
        if (!ls.length || !/^---[ \t]*\r?\n$/.test(ls[0])) return none;
        const eol = /\r\n$/.test(ls[0]) ? '\r\n' : '\n';
        for (let i = 1; i < ls.length; i++) {
            if (/^---[ \t]*(\r?\n)?$/.test(ls[i])) {
                const m = /^(---[ \t]*)(\r?\n)?$/.exec(ls[i]);
                return {
                    front: ls.slice(1, i).join(''), body: ls.slice(i + 1).join(''), eol,
                    open: bare(ls[0]), close: m[1], closeEol: m[2] || '',
                };
            }
        }
        return none;
    }

    function join(s) {
        const eol = s.eol || '\n';
        if (s.front === null || s.front === undefined) return s.body;
        const closeEol = s.closeEol === undefined ? eol : s.closeEol;
        return (s.open || '---') + eol + s.front + (s.close || '---') + closeEol + s.body;
    }

    // ---- value parsing -------------------------------------------------------------------------------------

    const ESC = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/', ' ': ' ' };

    // Parse one quoted scalar occupying all of s; returns string or undefined when not a simple quoted scalar.
    function unquote(s) {
        const q = s[0];
        if (s.length < 2 || s[s.length - 1] !== q) return undefined;
        const inner = s.slice(1, -1);
        if (q === "'") {
            if (/'/.test(inner.replace(/''/g, ''))) return undefined;
            return inner.replace(/''/g, "'");
        }
        let out = '';
        for (let i = 0; i < inner.length; i++) {
            const c = inner[i];
            if (c === '"') return undefined;
            if (c !== '\\') { out += c; continue; }
            const e = ESC[inner[++i]];
            if (e === undefined) return undefined;
            out += e;
        }
        return out;
    }

    // Split flow-list inner text on top-level commas; undefined when anything nested/unbalanced.
    function flowItems(inner) {
        const items = [];
        let cur = '', q = null;
        for (let i = 0; i < inner.length; i++) {
            const c = inner[i];
            if (q) {
                cur += c;
                if (q === '"' && c === '\\') cur += inner[++i] ?? '';
                else if (c === q) {
                    if (q === "'" && inner[i + 1] === "'") cur += inner[++i];
                    else q = null;
                }
            } else if (c === '"' || c === "'") {
                if (cur.trim() !== '') return undefined;
                q = c; cur += c;
            } else if (c === ',') { items.push(cur); cur = ''; }
            else if ('[]{}'.includes(c)) return undefined;
            else cur += c;
        }
        if (q) return undefined;
        items.push(cur);
        if (items.length === 1 && items[0].trim() === '') return [];
        const out = [];
        for (const raw of items) {
            const t = raw.trim();
            if (t === '') return undefined;
            const v = scalar(t);
            if (v === undefined) return undefined;
            out.push(v);
        }
        return out;
    }

    // A single-line scalar (plain or quoted) -> string, undefined when not simple.
    function scalar(t) {
        if (t[0] === '"' || t[0] === "'") return unquote(t);
        if (/^[&*!{}|>%@`?]/.test(t) || / #/.test(t) || /:(\s|$)/.test(t)) return undefined;
        return t;
    }

    function blockScalar(header, rest) {
        const m = /^([>|])([+-]?)(\d?)([+-]?)$/.exec(header);
        if (!m) return undefined;
        const folded = m[1] === '>';
        const chomp = m[2] || m[4];
        // content = leading run of blank / indented lines
        const body = [];
        for (const l of rest) {
            const b = bare(l);
            if (b.trim() === '' || /^[ \t]/.test(b)) body.push(b); else break;
        }
        let indent;
        if (m[3]) indent = +m[3];
        else {
            const first = body.find((b) => b.trim() !== '');
            indent = first ? first.match(/^ */)[0].length : 0;
        }
        const strip = (b) => (b.trim() === '' ? b.slice(Math.min(indent, b.length)) : b.slice(indent));
        let ls = body.map(strip);
        let trailing = 0;
        while (ls.length && ls[ls.length - 1].trim() === '') { ls.pop(); trailing++; }
        let text;
        if (!folded) text = ls.join('\n');
        else {
            text = '';
            for (let i = 0; i < ls.length; i++) {
                const l = ls[i];
                if (i === 0) { text = l; continue; }
                const prev = ls[i - 1];
                if (l.trim() === '') text += '\n';
                else if (prev.trim() === '') text += l;
                else if (/^[ \t]/.test(l) || /^[ \t]/.test(prev)) text += '\n' + l;
                else text += ' ' + l;
            }
        }
        if (ls.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
        if (chomp === '-') return text;
        if (chomp === '+') return text + '\n'.repeat(trailing + 1);
        return text + '\n';
    }

    function parseValue(headerRaw, rest) {
        const header = (headerRaw || '').trim();
        const content = rest.filter((l) => l.trim() !== '' && !/^#/.test(l));
        const rawText = () => [headerRaw === undefined ? '' : headerRaw, ...rest.map(bare)].join('\n').replace(/\n+$/, '').replace(/^\s+/, '');
        const complex = () => ({ value: rawText(), complex: true });
        if (header === '') {
            if (!content.length) return { value: '', complex: false };
            const items = [];
            for (const l of content) {
                const m = /^[ \t]*-[ \t]+(.*)$/.exec(bare(l));
                if (!m) return complex();
                const v = scalar(m[1].trim());
                if (v === undefined) return complex();
                items.push(v);
            }
            return { value: items, complex: false };
        }
        if (/^[>|]/.test(header)) {
            const v = blockScalar(header, rest);
            return v === undefined ? complex() : { value: v, complex: false };
        }
        if (content.length) return complex();     // multi-line plain / quoted scalar
        if (header[0] === '[') {
            if (header[header.length - 1] !== ']') return complex();
            const v = flowItems(header.slice(1, -1));
            return v === undefined ? complex() : { value: v, complex: false };
        }
        const v = scalar(header);
        return v === undefined ? complex() : { value: v, complex: false };
    }

    function fields(front) {
        const ls = lines(front || '') || [];
        let cur = null;
        const out = [];
        let pre = null;
        ls.forEach((l, i) => {
            const m = KEY_RE.exec(bare(l));
            const isKey = m && !/^[ \t#-]/.test(l);
            if (isKey) { pre = null; cur = { key: m[1], start: i, end: i + 1, lines: [l], head: m[2] }; out.push(cur); }
            else if (cur && out[out.length - 1] === cur) { cur.end = i + 1; cur.lines.push(l); }
            else {
                if (!pre) { pre = { key: null, start: i, end: i + 1, lines: [] }; out.push(pre); }
                pre.end = i + 1; pre.lines.push(l);
            }
        });
        return out.map((s) => {
            const raw = s.lines.join('');
            if (s.key === null) return { key: null, start: s.start, end: s.end, raw, value: raw, complex: true };
            const p = parseValue(s.head, s.lines.slice(1));
            return { key: s.key, start: s.start, end: s.end, raw, value: p.value, complex: p.complex };
        });
    }

    // ---- writing -------------------------------------------------------------------------------------------

    const INDICATOR = /^[-?:,\[\]{}#&*!|>'"%@`]/;
    function needsQuote(s) {
        return s === '' || INDICATOR.test(s) || /^\s|\s$/.test(s) || /: |:$| #|[\n\r\t]/.test(s) || /[\x00-\x1f]/.test(s);
    }
    const quote = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
    function canonScalar(v) {
        let s = String(v).replace(/\n+$/, '');
        return needsQuote(s) ? quote(s) : s;
    }
    function canonItem(v) {
        const s = String(v);
        return needsQuote(s) || /[,\[\]{}"']/.test(s) ? quote(s) : s;
    }
    function canonLine(key, v) {
        if (Array.isArray(v)) return key + ': [' + v.map(canonItem).join(', ') + ']';
        return key + ': ' + canonScalar(v);
    }

    const sameValue = (a, b) => Array.isArray(a) && Array.isArray(b)
        ? a.length === b.length && a.every((x, i) => x === b[i]) : typeof a === 'string' && a === b;

    function rebuild(front, edits) {
        front = front || '';
        edits = edits || {};
        const eol = /\r\n/.test(front) ? '\r\n' : '\n';
        for (const k of Object.keys(edits)) {
            if (!/^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(k)) throw new Error('Invalid frontmatter key: ' + k);
            if (REQUIRED.includes(k) && (edits[k] === null || edits[k] === '' || (Array.isArray(edits[k]) && !edits[k].length)))
                throw new Error('"' + k + '" cannot be empty');
        }
        const ls = lines(front) || [];
        const seen = new Set();
        let out = '';
        for (const f of fields(front)) {
            if (f.key === null || !Object.prototype.hasOwnProperty.call(edits, f.key) || seen.has(f.key)) { out += f.raw; seen.add(f.key); continue; }
            seen.add(f.key);
            const e = edits[f.key];
            if (e === undefined || (!f.complex && sameValue(f.value, e))) { out += f.raw; continue; }
            if (e === null) continue;
            // keep trailing blank / comment-only lines of the span
            const spanLines = ls.slice(f.start, f.end);
            let t = spanLines.length;
            while (t > 1 && (spanLines[t - 1].trim() === '' || /^#/.test(spanLines[t - 1]))) t--;
            out += canonLine(f.key, e) + eol + spanLines.slice(t).join('');
        }
        for (const k of Object.keys(edits)) {
            if (seen.has(k) || edits[k] === null || edits[k] === undefined) continue;
            out += canonLine(k, edits[k]) + eol;
        }
        return out;
    }

    return { split, fields, rebuild, join };
});
