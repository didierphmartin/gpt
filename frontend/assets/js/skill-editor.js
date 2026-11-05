/**
 * Skill editor dialog: edit a skill's files in the app (one file at a time, picked from a drop-down).
 *
 *   SkillEditor.open({ skill, manager })   skill: a Skills-list row ({ dir_name, mine, owner_name }) or null for
 *                                          New Skill; manager: the SkillsManager (loadTree after a SKILL.md save).
 *
 * Per file: { rel, size, loaded, current, binary, ready, error }; a file is dirty when its current text differs
 * from the text as loaded (a change event alone is not an edit). Save writes only dirty files, each on its own: the
 * ones that saved lose their dot, failures keep it and are named. SKILL.md: the editor holds the BODY; the
 * frontmatter (SkillFrontmatter.split) goes to the frontmatter panel and is written back as it was.
 *
 * The editors sit behind one adapter interface, chosen by file kind from SkillEditor.adapters:
 *   factory() -> { mount(el, text, { readOnly, rel, original }), getText(), onChange(cb), setOriginal(text), destroy() }
 *   (mount may be async; setOriginal: the text just saved becomes the merge base - a no-op except for formatted markdown)
 * markdown / markdownSource default to a plain <textarea>, code is CodeMirror 5 (modeOf: by extension); binary is a read-only placeholder.
 * skill-md-editor.js installs markdown (Milkdown, formatted), markdownSource (CodeMirror markdown) and checkMarkdown.
 * SkillEditor.frontPanel is the frontmatter form (frontForm): mount(el, front, { readOnly, isNew, state, installed }),
 * getText() -> the rebuilt frontmatter (only the fields the user changed), errors(), setOriginal(front), destroy().
 * The form always compares with the frontmatter as loaded (f.parts.front); its inputs live in f.form across switches.
 *
 * Markdown, per file, on first open: SkillEditor.checkMarkdown(original) -> { ok, changes, reason, error }.
 * ok -> the formatted editor; otherwise (or when it fails to mount) the markdown pane, with a note and a Why? list of
 * the blocks the formatted editor would change. Saving a file that opened formatted first shows "Changes to be
 * saved" (the changed blocks, before -> after) with [Back] [Save]; markdown-pane files are written as typed.
 */
(function () {
    const TEXT_EXT = ['md', 'py', 'js', 'mjs', 'json', 'yaml', 'yml', 'sh', 'mmd', 'html', 'css', 'txt', 'csv',
        'toml', 'ini', 'svg', 'xml'];
    const MD_EXT = ['md', 'markdown'];
    const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const enc = new TextEncoder();

    const tr = (key, params) => {
        const i = window.i18n;
        return i && typeof i.t === 'function' ? i.t(key, params || {}) : key;
    };
    const extOf = (rel) => { const m = /\.([^./]+)$/.exec(String(rel)); return m ? m[1].toLowerCase() : ''; };
    const isTextExt = (rel) => TEXT_EXT.includes(extOf(rel));
    const kindOf = (rel) => (MD_EXT.includes(extOf(rel)) ? 'markdown' : 'code');

    /** Text of the bytes, or null when the file is binary: a NUL byte or invalid UTF-8 (any extension). */
    function decode(bytes, _rel) {
        if (bytes.includes(0)) return null;
        try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return null; }
    }

    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
            else if (k in { value: 1, readOnly: 1, disabled: 1, hidden: 1, type: 1, rows: 1, open: 1 }) el[k] = v;
            else el.setAttribute(k, v);
        }
        for (const c of children) if (c) el.append(c);
        return el;
    }

    // ---- default adapters (Tasks 5/6 replace markdown and code) ----

    /**
     * Editors (<textarea>, CodeMirror) report line ends as \n. Give back the text as loaded when nothing changed, and
     * keep a CRLF file CRLF, so opening a file never makes it dirty. A file with MIXED line ends (some CRLF, some LF,
     * or lone CR) has no one style to restore: untouched it is returned as loaded; once edited it is saved with \n.
     */
    function keepLineEnds(orig, v) {
        if (v === orig || v === orig.replace(/\r\n?/g, '\n')) return orig;
        const crlf = /\r\n/.test(orig) && !/(^|[^\r])\n/.test(orig) && !/\r(?!\n)/.test(orig);   // every line end is CRLF
        return crlf ? v.replace(/\n/g, '\r\n') : v;
    }

    function textareaAdapter() {
        let ta = null, host = null, orig = '';
        return {
            mount(el, text, { readOnly } = {}) {
                host = el;
                orig = String(text || '');
                ta = h('textarea', {
                    class: 'w-full h-full p-3 text-sm font-mono border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500',
                    spellcheck: 'false', readOnly: !!readOnly, value: text,
                });
                el.appendChild(ta);
            },
            getText: () => (ta ? keepLineEnds(orig, ta.value) : ''),
            onChange(cb) { if (ta) ta.addEventListener('input', () => cb()); },
            setOriginal() {},
            destroy() { if (ta && host) host.removeChild(ta); ta = null; },
        };
    }

    /** CodeMirror 5 mode per extension (.mmd: no mermaid mode, plain text). Unknown: plain text. */
    const CODE_MODES = { py: 'python', js: 'javascript', mjs: 'javascript', json: 'application/json', sh: 'shell',
        yaml: 'yaml', yml: 'yaml', html: 'htmlmixed', css: 'css' };
    const modeOf = (rel) => CODE_MODES[extOf(rel)] || 'text/plain';

    /** Scripts and other non-markdown text: CodeMirror 5 (a <textarea> when it did not load). No auto-formatting. */
    function codeAdapter() {
        if (!window.CodeMirror) return textareaAdapter();
        let host = null, box = null, cm = null, orig = '';
        return {
            mount(el, text, { readOnly, rel } = {}) {
                host = el;
                orig = String(text || '');
                box = h('div', { class: 'h-full min-h-0 border border-gray-300 rounded-lg overflow-hidden bg-white', 'data-se': 'code' });
                el.appendChild(box);
                // folding (▸/▾ beside the line numbers) when the fold add-ons loaded: the mode picks the rule
                // (indentation for Python/YAML, brackets for JS/JSON/CSS); it only hides lines, the text is unchanged
                const fold = 'foldGutter' in (window.CodeMirror.defaults || {});
                cm = window.CodeMirror(box, {
                    value: orig, mode: modeOf(rel), lineNumbers: true, readOnly: !!readOnly,
                    indentUnit: 4, tabSize: 4, indentWithTabs: false, viewportMargin: 50,
                    ...(fold ? {
                        foldGutter: true,
                        gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
                        extraKeys: { 'Ctrl-Q': (ed) => ed.foldCode(ed.getCursor()) },
                    } : {}),
                });
                cm.setSize('100%', '100%');
            },
            getText: () => (cm ? keepLineEnds(orig, cm.getValue()) : orig),
            onChange(cb) { if (cm) cm.on('change', () => cb()); },
            setOriginal() {},
            // for editors hosted elsewhere (the code node's Code tab): replace the text, redraw once visible
            setText(text) { orig = String(text || ''); if (cm) cm.setValue(orig); },
            refresh() { if (cm) cm.refresh(); },
            destroy() { if (box && host) host.removeChild(box); box = cm = null; },
        };
    }

    function binaryAdapter() {
        let box = null, host = null;
        return {
            mount(el, _text, { rel } = {}) {
                host = el;
                box = h('div', { class: 'h-full flex items-center justify-center text-sm text-gray-500 border border-gray-200 rounded-lg bg-gray-50', text: rel || '' });
                el.appendChild(box);
            },
            getText: () => '',
            onChange() {},
            setOriginal() {},
            destroy() { if (box && host) host.removeChild(box); box = null; },
        };
    }

    // ---- the frontmatter form (SKILL.md) ----

    /**
     * The form's fields. kind: scalar (one line), text (description: a textarea + expand overlay), list (written as a
     * list). lines: one item per line in a textarea (pip specifiers have commas: `numpy>=1.20,<2`, `requests[socks,x]`),
     * else comma-separated (tool names); keepShape: a field that is a comma scalar in the file stays one. A field
     * changes only when its trimmed text (scalars) or its items (lists) differ from what was shown. A key the file
     * has in a shape the form cannot show (complex, or a list where a scalar belongs) is listed under Other fields.
     */
    /** hidden + display:none: a Tailwind display class (flex) would otherwise win over the hidden attribute. */
    const hide = (el, yes) => { el.hidden = !!yes; el.style.display = yes ? 'none' : ''; };

    const FORM_FIELDS = [
        { key: 'name', kind: 'scalar', label: 'skills.editor.fm.name', required: 'skills.editor.nameRequired', hint: 'skills.editor.fm.nameHint', hideHintNew: true },
        { key: 'description', kind: 'text', label: 'skills.editor.fm.description', required: 'skills.editor.descriptionRequired', hint: 'skills.editor.fm.oneLine' },
        { key: 'license', kind: 'scalar', label: 'skills.editor.fm.license', placeholder: 'MIT' },
        { key: 'origin', kind: 'scalar', label: 'skills.editor.fm.origin', placeholder: 'synergyAI custom' },
        { key: 'dependencies', kind: 'list', lines: true, label: 'skills.editor.fm.libraries' },
        { key: 'requires-skills', kind: 'list', lines: true, label: 'skills.editor.fm.requiredSkills' },
        { key: 'allowed-tools', kind: 'list', label: 'skills.editor.fm.allowedTools', placeholder: 'run_skill_script', keepShape: true },
    ];
    const splitList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
    const splitLines = (s) => String(s).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const itemsOf = (spec, text) => (spec.lines ? splitLines(text) : splitList(text));
    const leafOf = (p) => String(p).split('/').pop();

    /** What the form shows for a parsed field (a clip block scalar's final \n is not shown). */
    function displayOf(spec, field) {
        if (!field) return '';
        if (Array.isArray(field.value)) return field.value.join(spec.lines ? '\n' : ', ');
        if (spec.lines) return splitList(field.value).join('\n');   // a comma scalar (`a, b`): the readers split it on commas
        return String(field.value).replace(/\n+$/, '');
    }

    /**
     * The frontmatter form: mount(el, front, { readOnly, isNew, state, installed }); getText() -> the frontmatter
     * (SkillFrontmatter.rebuild of the as-loaded front with ONLY the fields whose input differs from what was shown);
     * errors() -> i18n keys (a required field cleared); setOriginal(front) after a save; destroy().
     * state (kept by the dialog per file): { values: { key: input text }, open } so edits survive a file switch.
     * installed: a promise of the Skills-list rows (or null) for the Required skills warning.
     */
    function frontForm() {
        let host = null, box = null, wrap = null, opts = {}, front = '', state = { values: {} }, rows = [], other = [], dups = [];
        let closeDesc = null;   // the open description overlay's close(), so destroy() never leaks its keydown listener
        let fileHost = null;    // the grid cell that holds the dialog's file selector while the panel is open
        const cbs = [];
        let installed = null;              // Set of installed skill paths and leaf names; null = unknown (no warning)
        const F = () => window.SkillFrontmatter;
        const inputs = {};

        const val = (spec) => (inputs[spec.key] ? inputs[spec.key].value : rows.find((r) => r.spec === spec)?.shown ?? '');
        const isChanged = (r) => {
            const v = val(r.spec);
            if (r.spec.kind !== 'list') return v.trim() !== r.shown.trim();
            const a = itemsOf(r.spec, v), b = itemsOf(r.spec, r.shown);
            return a.length !== b.length || a.some((x, i) => x !== b[i]);
        };
        const changedRows = () => rows.filter(isChanged);

        function edits() {
            const out = {};
            for (const r of changedRows()) {
                const spec = r.spec, v = val(spec);
                if (spec.kind === 'list') {
                    const items = itemsOf(spec, v);
                    if (!items.length) {
                        // requires-skills: [] declares "none" (scanning stops); other lists are removed when emptied
                        if (spec.key === 'requires-skills') out[spec.key] = [];
                        else if (r.field) out[spec.key] = null;
                        continue;
                    }
                    out[spec.key] = spec.keepShape && r.field && typeof r.field.value === 'string' ? items.join(', ') : items;
                } else {
                    const t = v.trim();
                    if (t) out[spec.key] = t;
                    else if (!spec.required && r.field) out[spec.key] = null;
                }
            }
            return out;
        }
        function errors() {
            return changedRows().filter((r) => r.spec.required && !val(r.spec).trim()).map((r) => r.spec.required);
        }

        /** The ▸/▾ line: "Expand to display <name> metadata" (collapsed) / "Collapse <name> metadata" (open). */
        function summary() {
            const nameRow = rows.find((x) => x.spec.key === 'name');
            const name = (nameRow ? val(nameRow.spec).trim() : '') || opts.dir || '—';
            return tr(box && box.open ? 'skills.editor.fm.collapseMeta' : 'skills.editor.fm.expandMeta', { name });
        }

        function refresh() {
            if (!box) return;
            box.querySelector('[data-se="fm-summary"]').textContent = summary();
            for (const r of rows) {
                const err = box.querySelector(`[data-se="fm-${r.spec.key}-error"]`);
                if (err) {
                    const bad = r.spec.required && isChanged(r) && !val(r.spec).trim();
                    err.hidden = !bad;
                    err.textContent = bad ? tr(r.spec.required) : '';
                }
            }
            const warn = box.querySelector('[data-se="fm-requires-skills-warning"]');
            if (warn) {
                const missing = installed ? splitLines(val(FORM_FIELDS.find((x) => x.key === 'requires-skills'))).filter((n) => !installed.has(n) && !installed.has(leafOf(n))) : [];
                warn.hidden = !missing.length;
                warn.textContent = missing.length ? tr('skills.editor.fm.notInstalled', { names: missing.join(', ') }) : '';
            }
        }

        function onInput(spec) {
            if (opts.readOnly) return;
            state.values[spec.key] = inputs[spec.key].value;
            refresh();
            for (const cb of cbs) cb();
        }

        /** The roomy textarea over the dialog for the description (Escape, the backdrop or ✕ closes and keeps the text). */
        function expandDescription() {
            const spec = FORM_FIELDS[1], inp = inputs.description;
            const ta = h('textarea', { class: 'w-full h-64 px-3 py-2 text-sm border border-gray-300 rounded-lg resize-y focus:ring-2 focus:ring-blue-500',
                readOnly: !!opts.readOnly, value: inp.value });
            let ov = null;
            const onKey = (e) => { if (e.key === 'Escape') close(); };
            const close = () => {
                if (!ov) return;
                document.removeEventListener('keydown', onKey);
                if (closeDesc === close) closeDesc = null;
                if (!opts.readOnly && ta.value !== inp.value) { inp.value = ta.value; onInput(spec); }
                ov.remove(); ov = null;
            };
            if (closeDesc) closeDesc();
            closeDesc = close;
            const panel = h('div', { class: 'bg-white rounded-xl shadow-xl border border-gray-200 w-[min(640px,90vw)] max-h-[80vh] flex flex-col' },
                h('div', { class: 'flex items-center justify-between px-4 py-3 border-b border-gray-200' },
                    h('h4', { class: 'text-sm font-semibold text-gray-800', text: tr('skills.editor.fm.description') }),
                    h('button', { type: 'button', 'data-se': 'fm-description-overlay-close', class: 'p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded', text: '✕',
                        'aria-label': tr('skills.editor.fm.close'), on: { click: () => close() } })),
                h('div', { class: 'p-4 flex-1 overflow-y-auto' }, ta));
            ov = h('div', { id: 'skill-editor-desc', 'data-se': 'fm-description-overlay', class: 'fixed inset-0 z-[220] flex items-center justify-center', style: 'background-color: rgba(0,0,0,0.4)',
                on: { click: (e) => { if (e.target === ov) close(); } } }, panel);
            document.body.appendChild(ov);
            document.addEventListener('keydown', onKey);
            if (ta.focus) ta.focus();
        }

        function fieldEl(r) {
            const spec = r.spec, se = 'fm-' + spec.key;
            const cls = 'w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500';
            const initial = Object.prototype.hasOwnProperty.call(state.values, spec.key) ? state.values[spec.key] : r.shown;
            const inp = spec.kind === 'text' || spec.lines
                ? h('textarea', { 'data-se': se, class: cls + ' resize-y' + (spec.lines ? ' font-mono' : ''), rows: spec.lines ? 3 : 2,
                    spellcheck: spec.lines ? 'false' : 'true', readOnly: !!opts.readOnly, value: initial, placeholder: spec.placeholder })
                : h('input', { 'data-se': se, type: 'text', class: cls, readOnly: !!opts.readOnly, value: initial, placeholder: spec.placeholder });
            inp.addEventListener('input', () => onInput(spec));
            inputs[spec.key] = inp;
            const label = h('div', { class: 'flex items-center gap-2 mb-1' },
                h('label', { class: 'text-xs font-medium text-gray-700', text: tr(spec.label) }),
                spec.kind === 'list' ? h('span', { class: 'text-[11px] text-gray-400', text: tr(spec.lines ? 'skills.editor.fm.lineHint' : 'skills.editor.fm.commaHint') }) : null,
                spec.kind === 'text' ? h('button', { type: 'button', 'data-se': 'fm-description-expand', class: 'text-[11px] text-blue-600 underline hover:text-blue-800',
                    text: tr('skills.editor.fm.expand'), on: { click: () => expandDescription() } }) : null);
            return h('div', { class: spec.kind === 'text' ? 'col-span-3' : '' }, label, inp,
                spec.hint && !(spec.hideHintNew && opts.isNew) ? h('p', { class: 'mt-0.5 text-[11px] text-gray-400', text: tr(spec.hint) }) : null,
                spec.required ? h('p', { 'data-se': se + '-error', class: 'mt-0.5 text-xs text-red-700', hidden: true }) : null,
                spec.key === 'requires-skills' ? h('p', { 'data-se': se + '-warning', class: 'mt-0.5 text-xs text-amber-700', hidden: true }) : null,
                r.detected && !opts.readOnly ? h('p', { 'data-se': se + '-detected', class: 'mt-0.5 text-[11px] text-amber-700' },
                    tr('skills.editor.fm.detected') + ' ',
                    h('button', { type: 'button', 'data-se': se + '-declare', class: 'text-blue-600 underline hover:text-blue-800', text: tr('skills.editor.fm.declare'),
                        on: { click: (e) => { r.shown = ''; r.detected = false; e.target.parentNode.remove(); onInput(spec); } } })) : null);
        }

        /** Which keys the form edits and what goes under Other fields, from the as-loaded front. */
        function parse() {
            const all = F().fields(front || '');
            const first = (k) => all.find((x) => x.key === k);
            const shownOk = (spec, f) => !f || (!f.complex && (spec.kind === 'list' || typeof f.value === 'string'));
            const metaOrigin = all.some((x) => x.key === 'metadata' && /\n[ \t]+origin[ \t]*:/.test(x.raw));
            rows = [];
            const editable = new Set();
            for (const spec of FORM_FIELDS) {
                const f = first(spec.key);
                if (!shownOk(spec, f)) continue;
                if (spec.key === 'origin' && !f && metaOrigin) continue;   // origin is in metadata: listed there
                const row = { spec, field: f || null, shown: displayOf(spec, f) };
                // not declared: show the skills the Skills list found in the skill's files (unchanged until Declare or an edit)
                if (spec.key === 'requires-skills' && !f && Array.isArray(opts.detected) && opts.detected.length) {
                    row.shown = opts.detected.join('\n');
                    row.detected = true;
                }
                rows.push(row);
                editable.add(spec.key);
            }
            other = all.filter((x) => x.key !== null && !editable.has(x.key));
            // a later duplicate of a form field: rebuild drops it when that field is saved, so it is not "kept as is"
            dups = all.filter((x) => x.key !== null && editable.has(x.key) && first(x.key) !== x);
        }

        function render() {
            for (const k of Object.keys(inputs)) delete inputs[k];
            const wasOpen = box ? box.open : undefined;
            if (wrap && host) host.removeChild(wrap);
            const PRE = 'm-0 p-2 text-xs font-mono whitespace-pre-wrap break-words max-h-32 overflow-auto rounded border border-gray-200 bg-gray-50 text-gray-600';
            const rawOf = (list) => trimEnd(list.map((x) => x.raw.replace(/\r\n/g, '\n')).join(''));
            const otherBox = other.length || dups.length ? h('div', { 'data-se': 'fm-other', class: 'min-w-0 space-y-1' },
                h('div', { class: 'flex items-center gap-2' },
                    h('span', { class: 'text-xs font-medium text-gray-700', text: tr('skills.editor.fm.other') }),
                    other.length ? h('span', { class: 'text-[11px] text-gray-400', text: tr('skills.editor.fm.otherHint') }) : null),
                other.length ? h('pre', { class: PRE, text: rawOf(other) }) : null,
                ...dups.map((x) => h('div', { 'data-se': 'fm-duplicate' },
                    h('p', { class: 'mb-0.5 text-[11px] text-amber-700', text: tr('skills.editor.fm.duplicateHint') }),
                    h('pre', { class: PRE, text: rawOf([x]) })))) : null;
            box = h('details', { 'data-se': 'fm-panel', class: 'text-xs text-gray-700 border border-gray-200 rounded-lg' },
                h('summary', { class: 'cursor-pointer px-3 py-1.5 select-none' },
                    h('span', { 'data-se': 'fm-summary', class: 'font-medium text-gray-600' })),
                h('div', { class: 'grid grid-cols-4 gap-3 px-3 pb-3 pt-1 max-h-[40vh] overflow-auto' }, ...cells(otherBox)));
            box.open = !!(wasOpen !== undefined ? wasOpen : state.open);   // (h() skips false)
            box.addEventListener('toggle', () => { state.open = box.open; placeFile(); refresh(); });
            // the "Metadata" label over the panel matches the File label beside it
            wrap = h('div', { 'data-se': 'fm-wrap' },
                h('div', { 'data-se': 'fm-label', class: 'block text-xs font-medium text-gray-700 mb-1', text: tr('skills.editor.fm.metadata') }), box);
            host.appendChild(wrap);
            placeFile();
            refresh();
        }

        /**
         * The grid, 4 columns: Name | Description (3) / License | Python libraries | Required skills | Other fields /
         * Allowed tools | Origin (when it is a top-level field) | File selector (the rest of the row).
         */
        function cells(otherBox) {
            const ORDER = ['name', 'description', 'license', 'dependencies', 'requires-skills', '(other)', 'allowed-tools', 'origin'];
            const byKey = new Map(rows.map((r) => [r.spec.key, r]));
            const out = [];
            let used = 0;
            for (const k of ORDER) {
                if (k === '(other)') { if (otherBox) { out.push(otherBox); used += 1; } continue; }
                const r = byKey.get(k);
                if (!r) continue;
                out.push(fieldEl(r));
                used += r.spec.kind === 'text' ? 3 : 1;
            }
            if (opts.fileBlock) {
                const span = 4 - (used % 4);   // the rest of the row (a full row when the last one is full)
                fileHost = h('div', { 'data-se': 'fm-file-cell', class: ['', '', 'col-span-2', 'col-span-3', 'col-span-4'][span] });
                out.push(fileHost);
            }
            return out;
        }
        /** Open: the selector is in the grid; closed: back on the dialog's row, beside the summary, so it stays reachable. */
        function placeFile() {
            const fb = opts.fileBlock;
            if (!fb) return;
            const target = box && box.open && fileHost ? fileHost : opts.fileHome;
            if (target && fb.parentNode !== target) target.appendChild(fb);
        }

        return {
            mount(el, text, o = {}) {
                host = el;
                opts = o;
                front = text || '';
                state = o.state || { values: {} };
                if (!state.values) state.values = {};
                if (state.open === undefined) state.open = !!o.isNew;   // collapsed for an existing skill; New Skill opens it to fill in
                parse();
                render();
                if (o.installed) Promise.resolve(o.installed).then((list) => {
                    if (!list) return;
                    installed = new Set();
                    for (const s of list) for (const n of [s.path, s.dirName, s.leafName, s.dir_name]) if (n) installed.add(n);
                    refresh();
                }).catch(() => {});
            },
            getText() {
                const e = edits();
                return Object.keys(e).length ? F().rebuild(front, e) : front;
            },
            errors,
            /** Open the panel (a Save blocked by a field error shows where). */
            reveal() { if (box) { box.open = true; state.open = true; } },
            onChange(cb) { cbs.push(cb); },
            /** The front just saved is the new baseline; the inputs show it. */
            setOriginal(text) { front = text || ''; state.values = {}; parse(); render(); },
            destroy() {
                if (closeDesc) closeDesc();
                if (opts.fileBlock && opts.fileHome && opts.fileBlock.parentNode !== opts.fileHome) opts.fileHome.appendChild(opts.fileBlock);
                if (wrap && host) host.removeChild(wrap);
                box = wrap = null;
            },
        };
    }

    // ---- New Skill ----

    const newSkillTemplate = () => '---\nname:\ndescription:\ndependencies: []\nrequires-skills: []\n---\n\n' + tr('skills.editor.template');

    /** i18n keys of what is wrong with a New Skill's frontmatter text ([] = fine). */
    function validateNew(front) {
        const F = window.SkillFrontmatter;
        const val = (k) => { const f = F.fields(front || '').find((x) => x.key === k); return f ? String(f.value).trim() : ''; };
        const errs = [];
        const name = val('name');
        if (!name) errs.push('skills.editor.nameRequired');
        else if (name.length > 64 || !NAME_RE.test(name)) errs.push('skills.editor.nameInvalid');
        if (!val('description')) errs.push('skills.editor.descriptionRequired');
        return errs;
    }

    // ---- the dialog ----

    const BTN = 'px-3 py-1.5 text-sm rounded-lg border';
    const BOM = '\uFEFF';
    const errMsg = (e) => (e && e.message) || String(e);
    const trimEnd = (s) => String(s).replace(/\n+$/, '');

    /** Compact before -> after list of changed blocks ([{ before, after }]). */
    function renderChanges(changes) {
        const side = (text, cls) => (text
            ? h('pre', { class: `m-0 p-2 text-xs font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto rounded border ${cls}`, text: trimEnd(text) })
            : h('div', { class: 'p-2 text-xs italic text-gray-400 rounded border border-gray-200', text: tr('skills.editor.changes.nothing') }));
        return h('ol', { class: 'space-y-2', 'data-se': 'change-list' }, ...changes.map((c) => h('li', { class: 'space-y-1', 'data-se': 'change' },
            h('div', { class: 'text-[11px] uppercase tracking-wide text-gray-400', text: tr('skills.editor.changes.before') }),
            side(c.before, 'bg-red-50 border-red-200 text-red-900'),
            h('div', { class: 'text-[11px] uppercase tracking-wide text-gray-400', text: tr('skills.editor.changes.after') }),
            side(c.after, 'bg-green-50 border-green-200 text-green-900'))));
    }

    /** Before -> after of each frontmatter field whose lines changed (a removed field has no after, a new one no before). */
    function frontChanges(before, after) {
        const F = window.SkillFrontmatter;
        if (before === after) return [];
        const spans = (t) => {
            const m = new Map();
            for (const x of F.fields(t || '')) {
                const k = x.key === null ? '\u0000' + x.start : x.key;
                m.set(k, (m.get(k) || '') + x.raw);
            }
            return m;
        };
        const a = spans(before), b = spans(after);
        const out = [];
        for (const k of new Set([...a.keys(), ...b.keys()])) {
            const x = a.get(k) || '', y = b.get(k) || '';
            if (x !== y) out.push({ before: x, after: y });
        }
        return out;
    }

    class Dialog {
        constructor({ skill, manager }) {
            this.skill = skill;
            this.manager = manager || null;
            this.fs = window.skillsFs;
            this.isNew = !skill;
            this.readOnly = !!skill && skill.mine === false;
            this.files = new Map();
            this.rel = null;
            this.editor = null;
            this.panel = null;
            this.closed = false;
            this._busy = Promise.resolve();
        }

        get dir() { return this.skill && this.skill.dir_name; }

        /** Resolves when the current file switch / save has finished. */
        ready() { return this._busy; }

        dirtyFiles() { return [...this.files.values()].filter((f) => this.isDirty(f)).map((f) => f.rel); }

        isDirty(f) {
            if (this.readOnly || f.binary || !f.ready || f.error) return false;
            if (f.frontErrors && f.frontErrors.length) return true;            // e.g. the name cleared: not saved yet
            return f.current !== (f.loaded === null ? f.template : f.loaded);   // New Skill: compared with the template
        }

        /** The Skills-list rows, once per dialog (the Required skills warning); null when they cannot be listed. */
        installed() {
            if (!this._installed) {
                this._installed = typeof this.fs.listSkills === 'function'
                    ? Promise.resolve().then(() => this.fs.listSkills()).catch((e) => { console.warn('[SkillEditor] listSkills', e); return null; })
                    : Promise.resolve(null);
            }
            return this._installed;
        }

        /** A root README file (README.md, readme.markdown, README) gets its own tab; null when there is none. */
        readmeRel() {
            for (const rel of this.files.keys()) if (/^readme(\.(md|markdown|txt))?$/i.test(rel)) return rel;
            return null;
        }

        /** Skill tab: the file selector, frontmatter and the editable text; README tab: the README alone. */
        setTab(name) {
            for (const b of this.el.querySelectorAll('[data-tab]')) {
                const on = b.dataset.tab === name;
                b.className = 'px-3 py-1.5 text-sm rounded-t-lg border border-b-0 -mb-px ' +
                    (on ? 'bg-white text-gray-900 font-medium border-gray-200' : 'bg-gray-50 text-gray-500 border-transparent hover:text-gray-800');
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            }
            hide(this.q('file-row'), name !== 'skill');
        }

        build() {
            const tab = (name, label) => h('button', { type: 'button', 'data-tab': name, role: 'tab',
                on: { click: () => { const r = this.readmeRel(); this.show(name === 'readme' ? r : (this.skillRel && this.files.has(this.skillRel) ? this.skillRel : 'SKILL.md')); } }, text: label });
            const sel = h('select', { 'data-se': 'file', class: 'w-72 px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white',
                on: { change: () => this.show(sel.value) } });
            this.el = h('div', { id: 'skill-editor-modal', class: 'fixed inset-0 z-[200] flex items-center justify-center', style: 'background-color: rgba(0,0,0,0.5)' },
                h('div', { class: 'bg-white rounded-xl shadow-xl border border-gray-200 w-[96vw] h-[94vh] overflow-hidden flex flex-col' },
                    // no title: the skill's name is in the frontmatter; the tabs (only when there is a README) and ✕ share the top row
                    h('div', { class: 'flex items-end justify-between gap-2 px-4 pt-2 border-b border-gray-200 min-h-[2.75rem]' },
                        h('div', { 'data-se': 'tabs', class: 'flex items-end gap-1', hidden: true, style: 'display:none' },
                            tab('skill', tr('skills.editor.tabSkill')), tab('readme', 'README')),
                        h('button', { 'data-se': 'close', type: 'button', class: 'ml-auto mb-1.5 p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded', text: '✕',
                            'aria-label': tr('common.close'), on: { click: () => this.requestClose() } })),
                    // the frontmatter panel and the file selector share one row (frontmatter first; the panel opens below its summary)
                    h('div', { 'data-se': 'file-row', class: 'flex items-start gap-3 px-4 pt-3' },
                        h('div', { 'data-se': 'front', class: 'flex-1 min-w-0' }),
                        h('div', { 'data-se': 'file-slot', class: 'flex-shrink-0' },
                            h('div', { 'data-se': 'file-block' },
                                h('label', { class: 'block text-xs font-medium text-gray-700 mb-1', text: tr('skills.editor.file') }),
                                h('div', { class: 'flex items-center gap-2' }, sel,
                                    h('span', { class: 'text-xs text-gray-400 whitespace-nowrap', text: tr('skills.editor.unsavedLegend') }))))),
                    h('div', { 'data-se': 'note', class: 'px-4 pt-2 text-xs text-gray-500' }),
                    h('div', { 'data-se': 'editor', class: 'flex-1 min-h-0 px-4 py-3' }),
                    h('div', { class: 'flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200' },
                        h('div', { 'data-se': 'status', class: 'flex-1 min-w-0 text-xs' }),
                        h('button', { 'data-se': 'cancel', type: 'button', class: `${BTN} text-gray-600 border-gray-300 hover:bg-gray-100`, text: tr('common.cancel'),
                            on: { click: () => this.requestClose() } }),
                        this.readOnly ? null : h('button', { 'data-se': 'save', type: 'button', class: `${BTN} text-white bg-blue-600 border-blue-600 hover:bg-blue-700`, text: tr('common.save'),
                            on: { click: () => this.save() } }))));
            this.q = (k) => this.el.querySelector(`[data-se="${k}"]`);
            document.body.appendChild(this.el);
        }

        status(text, kind) {
            const el = this.q('status');
            el.className = 'flex-1 min-w-0 text-xs ' + (kind === 'error' ? 'text-red-700' : kind === 'ok' ? 'text-green-700' : 'text-gray-500');
            el.textContent = text || '';
        }

        note() {
            const f = this.files.get(this.rel);
            const parts = [];
            if (this.readOnly) parts.push(tr('skills.editor.readOnlyOwner', { name: (this.skill && this.skill.owner_name) || '' }));
            if (f && f.binary) parts.push(tr('skills.editor.binary'));
            if (f && f.error) parts.push(tr('skills.editor.loadFailed', { file: f.rel, message: f.error }));
            const el = this.q('note');
            el.textContent = parts.join(' ');
            if (f && f.md && !f.md.ok && !f.binary && !f.error) this.noteMarkdown(el, f.md);
        }

        /** "This file opens as markdown" + Why? (the blocks the formatted editor would change, or why it could not run). */
        noteMarkdown(el, md) {
            const why = h('div', { 'data-se': 'why-list', class: 'mt-2 p-2 max-h-64 overflow-auto border border-gray-200 rounded-lg bg-gray-50', hidden: true },
                md.error ? h('p', { class: 'text-xs text-gray-600', text: tr('skills.editor.md.whyError', { message: md.error }) }) : null,
                md.reason ? h('p', { class: 'text-xs text-gray-600 mb-2', text: tr('skills.editor.md.whyRefused') }) : null,
                md.changes && md.changes.length ? renderChanges(md.changes) : null);
            el.append(h('span', { 'data-se': 'md-note', text: (el.textContent ? ' ' : '') + tr('skills.editor.md.opensAsMarkdown') + ' ' }),
                h('button', { type: 'button', 'data-se': 'why', class: 'text-blue-600 underline hover:text-blue-800', text: tr('skills.editor.md.why'),
                    on: { click: () => { why.hidden = !why.hidden; } } }),
                why);
        }

        /** Fill the drop-down: SKILL.md first, then one group per top folder (references, scripts, ...), then other files. */
        renderFiles() {
            const sel = this.q('file');
            const opt = (f) => h('option', { value: f.rel, text: (this.isDirty(f) ? '● ' : '') + f.rel });
            const groups = new Map();
            const top = [], other = [];
            const readme = this.readmeRel();
            hide(this.q('tabs'), !readme);
            for (const f of this.files.values()) {
                if (f.rel === readme) continue;   // it has its own tab
                if (f.rel === 'SKILL.md') top.push(f);
                else if (f.rel.includes('/')) {
                    const g = f.rel.split('/')[0];
                    if (!groups.has(g)) groups.set(g, []);
                    groups.get(g).push(f);
                } else other.push(f);
            }
            const order = [...groups.keys()].sort((a, b) => (a === 'references' ? -1 : b === 'references' ? 1 : a === 'scripts' ? -1 : b === 'scripts' ? 1 : a < b ? -1 : 1));
            sel.replaceChildren(...top.map(opt),
                ...order.map((g) => h('optgroup', { label: g + '/' }, ...groups.get(g).map(opt))),
                ...(other.length ? [h('optgroup', { label: tr('skills.editor.otherFiles') }, ...other.map(opt))] : []));
            if (this.rel) sel.value = this.rel;
        }

        refreshDots() {
            for (const o of this.q('file').querySelectorAll('option')) {
                const f = this.files.get(o.value);
                if (f) o.textContent = (this.isDirty(f) ? '● ' : '') + f.rel;
            }
        }

        /** SKILL.md: the full text from its parts + the current frontmatter and body. */
        joinSkillMd(f) { return (f.bom || '') + window.SkillFrontmatter.join({ ...f.parts, front: f.front, body: f.body }); }

        /** The markdown the editor holds for this text: the body for SKILL.md (BOM and frontmatter off). */
        mdOf(f, text) {
            if (f.rel !== 'SKILL.md') return text;
            return window.SkillFrontmatter.split(text.startsWith(BOM) ? text.slice(1) : text).body;
        }

        /** Pull the editor's (and panel's) text into the file state. */
        capture() {
            const f = this.files.get(this.rel);
            if (!f || !f.ready || f.binary || f.error || this.readOnly) return;
            if (f.rel === 'SKILL.md') {
                if (this.editor) f.body = this.editor.getText();
                if (this.panel) { f.front = this.panel.getText(); f.frontErrors = this.panel.errors(); }
                f.current = this.joinSkillMd(f);
            } else if (this.editor) f.current = this.editor.getText();
        }

        async load(f) {
            try {
                const bytes = await this.fs.getSkillFileBytes(this.dir, f.rel);
                if (!bytes) throw new Error(tr('skills.editor.missing'));
                const text = decode(bytes, f.rel);
                if (text === null) f.binary = true;
                else this.setLoaded(f, text);
            } catch (e) {
                f.error = (e && e.message) || String(e);
            }
            f.ready = true;
        }

        setLoaded(f, text, { isNew = false } = {}) {
            f.loaded = isNew ? null : text;
            f.template = isNew ? text : undefined;
            f.current = text;
            f.md = undefined;                   // the markdown check runs again on this text
            if (f.rel === 'SKILL.md') {
                f.bom = text.startsWith(BOM) ? BOM : '';   // split / join work on the text after the BOM
                f.parts = window.SkillFrontmatter.split(text.slice(f.bom.length));
                f.front = f.parts.front;
                f.body = f.parts.body;
                f.form = { values: {}, open: f.form ? f.form.open : undefined };
                f.frontErrors = [];
            }
        }

        /** After SKILL.md was written: what was saved is the frontmatter as loaded (the form's new baseline). */
        rebase(f, text) {
            f.parts = window.SkillFrontmatter.split(text.slice(f.bom.length));
            f.front = f.parts.front;
            f.form.values = {};
            f.frontErrors = [];
            if (f.rel === this.rel && this.panel && typeof this.panel.setOriginal === 'function') this.panel.setOriginal(f.front);
        }

        unmount() {
            if (this.editor) { try { this.editor.destroy(); } catch (e) { console.warn('[SkillEditor] destroy', e); } }
            if (this.panel) { try { this.panel.destroy(); } catch (e) { console.warn('[SkillEditor] destroy', e); } }
            this.editor = this.panel = null;
        }

        /** Run switches and saves one at a time; a failure is shown and does not block the next one. */
        queue(fn) {
            const run = this._busy.then(() => (this.closed ? undefined : fn())).catch((e) => {
                console.error('[SkillEditor]', e);
                this.status(tr('skills.editor.failed', { message: (e && e.message) || String(e) }), 'error');
            });
            this._busy = run;
            return run;
        }

        show(rel) { return this.queue(() => this._show(rel)); }

        async _show(rel) {
            const f = this.files.get(rel);
            if (!f) return;
            this.capture();
            this.unmount();
            this.rel = rel;
            const isReadme = rel === this.readmeRel();
            if (!isReadme) { this.skillRel = rel; this.q('file').value = rel; }
            this.setTab(isReadme ? 'readme' : 'skill');
            if (!f.ready) {
                this.q('note').textContent = tr('skills.editor.loading');
                await this.load(f);
                if (this.closed) return;
            }
            const SE = window.SkillEditor;
            let kind = f.binary ? 'binary' : kindOf(rel);
            if (kind === 'markdown' && !f.error && f.md === undefined) {
                this.q('note').textContent = tr('skills.editor.loading');
                f.md = await this.checkMarkdown(this.mdOf(f, f.loaded === null ? f.template : f.loaded));
                if (this.closed) return;
            }
            if (kind === 'markdown' && !f.md.ok) kind = 'markdownSource';
            this.note();
            this.refreshDots();
            if (f.error) return;
            const readOnly = this.readOnly || f.binary;
            if (rel === 'SKILL.md' && (this.isNew || f.front !== null)) {
                this.panel = await this.mountOne(SE.frontPanel, this.q('front'), f.parts.front,
                    { readOnly, isNew: this.isNew, state: f.form, installed: this.installed(), detected: (this.skill && this.skill.requires) || null, dir: this.dir, fileBlock: this.q('file-block'), fileHome: this.q('file-slot') });
                if (this.closed) return;
            }
            const el = this.q('editor'), text = f.binary ? '' : (rel === 'SKILL.md' ? f.body : f.current);
            try {
                // original: the markdown as loaded, the merge base of a formatted save
                this.editor = await this.mountOne(SE.adapters[kind], el, text, { readOnly, rel, original: this.mdOf(f, f.loaded === null ? f.template : f.loaded) });
            } catch (e) {
                if (kind !== 'markdown') throw e;
                f.md = { ok: false, changes: [], reason: '', error: errMsg(e) };   // the formatted editor did not load
                this.note();
                this.editor = await this.mountOne(SE.adapters.markdownSource, el, text, { readOnly, rel });
            }
        }

        async checkMarkdown(md) {
            const fn = window.SkillEditor.checkMarkdown;
            if (typeof fn !== 'function') return { ok: false, changes: [], reason: '', error: tr('skills.editor.md.notLoaded') };
            try { return await fn(md); }
            catch (e) { return { ok: false, changes: [], reason: '', error: errMsg(e) }; }
        }

        /** Mount an adapter; only a mounted one is kept (capture never reads a half-mounted editor). Null after close. */
        async mountOne(factory, el, text, opts) {
            const a = factory();
            try {
                await a.mount(el, text, opts);
            } catch (e) {
                try { a.destroy(); } catch { /* nothing mounted */ }
                throw e;
            }
            if (this.closed) { try { a.destroy(); } catch { /* gone */ } return null; }
            a.onChange(() => this.changed());
            return a;
        }

        /** An editor's change event (often from a timer): an error is shown, never thrown. */
        changed() {
            try {
                this.capture();
                this.refreshDots();
            } catch (e) {
                console.error('[SkillEditor]', e);
                this.status(tr('skills.editor.failed', { message: errMsg(e) }), 'error');
            }
        }

        save() {
            const btn = this.q('save');
            if (btn) btn.disabled = true;           // one save at a time
            return this.queue(() => this._save()).finally(() => { if (btn) btn.disabled = false; });
        }

        async _save() {
            if (this.readOnly) return { written: [], failed: [] };
            this.capture();
            if (this.isNew) return this.saveNew();
            const sk = this.files.get('SKILL.md');
            if (sk && sk.frontErrors && sk.frontErrors.length) {
                if (this.rel === 'SKILL.md' && this.panel && this.panel.reveal) this.panel.reveal();
                this.status(sk.frontErrors.map((k) => tr(k)).join(' '), 'error');
                return { written: [], failed: [] };
            }
            const dirty = [...this.files.values()].filter((f) => this.isDirty(f));
            if (!dirty.length) { this.status(tr('skills.editor.nothingToSave')); return { written: [], failed: [] }; }
            const reviews = this.reviews(dirty);
            if (reviews.length && !(await this.confirmChanges(reviews))) return { written: [], failed: [], cancelled: true };
            if (this.closed) return { written: [], failed: [] };
            const written = [], failed = [];
            for (const f of dirty) {
                const text = f.current;
                try {
                    await this.fs.writeSkillFile(this.dir, f.rel, enc.encode(text));
                    f.loaded = text;
                    if (f.rel === 'SKILL.md') this.rebase(f, text);
                    // the open editor's merge base is now what was just written
                    if (f.rel === this.rel && this.editor && typeof this.editor.setOriginal === 'function') {
                        try { this.editor.setOriginal(this.mdOf(f, text)); } catch (e) { console.warn('[SkillEditor] setOriginal', e); }
                    }
                    written.push(f.rel);
                } catch (e) {
                    failed.push({ rel: f.rel, message: (e && e.message) || String(e) });
                }
            }
            this.refreshDots();
            if (written.includes('SKILL.md')) await this.refreshTree();
            if (failed.length) {
                this.status(tr('skills.editor.saveFailed', { files: failed.map((x) => `${x.rel} (${x.message})`).join(', ') }), 'error');
            } else {
                this.status(tr('skills.editor.saved', { count: written.length }), 'ok');
            }
            return { written, failed };
        }

        async saveNew() {
            const f = this.files.get('SKILL.md');
            const errs = validateNew(f.front);
            if (errs.length) { this.status(errs.map((k) => tr(k)).join(' '), 'error'); return { written: [], failed: [] }; }
            const name = String(window.SkillFrontmatter.fields(f.front).find((x) => x.key === 'name').value).trim();
            const text = f.current;
            try {
                await this.fs.importSkill({ dir: name, name, files: { 'SKILL.md': enc.encode(text) }, pyodideWheels: {}, nativeWheels: {} },
                    { visibility: 'private' });
            } catch (e) {
                this.status(e && e.code === 'clash' ? tr('skills.zip.clash', { name })
                    : tr('skills.editor.saveFailed', { files: `SKILL.md (${(e && e.message) || e})` }), 'error');
                return { written: [], failed: [{ rel: 'SKILL.md', message: (e && e.message) || String(e) }] };
            }
            if (this.closed) { await this.refreshTree(); return { written: ['SKILL.md'], failed: [] }; }
            // From here on it is an edit dialog for that skill.
            this.isNew = false;
            this.skill = { dir_name: name, name, mine: true };
            if (this.manager) this.manager.lastSkillDir = name;
            this.setLoaded(f, text);
            await this._show('SKILL.md');       // the panel remounts as for an existing skill
            await this.refreshTree();
            this.status(tr('skills.editor.created', { name }), 'ok');
            return { written: ['SKILL.md'], failed: [] };
        }

        /**
         * What "Changes to be saved" lists: SKILL.md's changed frontmatter fields (the form writes them in its own
         * form, so they are always shown), and the changed blocks of files that opened in the formatted editor.
         */
        reviews(dirty) {
            const MB = window.MergeBlocks;
            const out = [];
            for (const f of dirty) {
                if (f.loaded === null) continue;
                const front = f.rel === 'SKILL.md' && f.parts && f.parts.front !== null ? frontChanges(f.parts.front, f.front) : [];
                let body = [], refused = '';
                if (f.md && f.md.ok && MB) {
                    const before = this.mdOf(f, f.loaded), after = this.mdOf(f, f.current);
                    if (before !== after) {
                        const m = MB.merge(before, after);
                        if (!m.merged) { body = [{ before, after }]; refused = m.reason; }
                        else body = MB.diffBlocks(before, after).changes;
                    }
                }
                if (front.length) out.push({ rel: f.rel, title: tr('skills.editor.fm.changesTitle', { file: f.rel }), changes: front, refused: '' });
                if (body.length) out.push({ rel: f.rel, changes: body, refused });
            }
            return out;
        }

        /** The "Changes to be saved" view: resolves true for [Save], false for [Back]. */
        confirmChanges(reviews) {
            document.getElementById('skill-editor-changes')?.remove();
            return new Promise((resolve) => {
                const done = (ok) => { ov.remove(); resolve(ok); };
                const ov = h('div', { id: 'skill-editor-changes', 'data-se': 'changes', class: 'fixed inset-0 z-[210] flex items-center justify-center', style: 'background-color: rgba(0,0,0,0.3)' },
                    h('div', { class: 'bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col' },
                        h('h3', { class: 'px-5 pt-5 text-sm font-bold text-gray-800', text: tr('skills.editor.changes.title') }),
                        h('div', { class: 'px-5 py-3 space-y-4 overflow-auto min-h-0' }, ...reviews.map((r) => h('section', { 'data-se': 'changes-file', class: 'space-y-2' },
                            h('h4', { class: 'text-xs font-semibold text-gray-700', text: r.title || r.rel }),
                            r.refused ? h('p', { 'data-se': 'changes-whole', class: 'text-xs text-amber-700', text: tr('skills.editor.changes.whole') }) : null,
                            renderChanges(r.changes)))),
                        h('div', { class: 'flex justify-end gap-2 px-5 pb-5 pt-2' },
                            h('button', { 'data-se': 'changes-back', type: 'button', class: `${BTN} text-gray-600 border-gray-300 hover:bg-gray-100`, text: tr('skills.editor.changes.back'),
                                on: { click: () => done(false) } }),
                            h('button', { 'data-se': 'changes-save', type: 'button', class: `${BTN} text-white bg-blue-600 border-blue-600 hover:bg-blue-700`, text: tr('common.save'),
                                on: { click: () => done(true) } }))));
                document.body.appendChild(ov);
            });
        }

        async refreshTree() {
            try { if (this.manager && this.manager.loadTree) await this.manager.loadTree(); }
            catch (e) { console.warn('[SkillEditor] loadTree failed', e); }
        }

        /** Close, asking first when files have unsaved edits. Resolves true when the dialog closed. */
        requestClose() {
            this.capture();
            const n = this.dirtyFiles().length;
            if (!n) { this.close(); return Promise.resolve(true); }
            return this.askDiscard(n);
        }

        askDiscard(n) {
            document.getElementById('skill-editor-discard')?.remove();
            let resolve;
            const p = new Promise((r) => { resolve = r; });
            const ov = h('div', { id: 'skill-editor-discard', 'data-se': 'discard', class: 'fixed inset-0 z-[210] flex items-center justify-center', style: 'background-color: rgba(0,0,0,0.3)' },
                h('div', { class: 'bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-sm mx-4 p-5 space-y-4' },
                    h('h3', { class: 'text-sm font-bold text-gray-800', text: tr('skills.editor.discardTitle') }),
                    h('p', { class: 'text-sm text-gray-600', text: tr('skills.editor.discardMessage', { count: n }) }),
                    h('div', { class: 'flex justify-end gap-2' },
                        h('button', { 'data-se': 'discard-keep', type: 'button', class: `${BTN} text-gray-600 border-gray-300 hover:bg-gray-100`, text: tr('skills.editor.keepEditing'),
                            on: { click: () => { ov.remove(); resolve(false); } } }),
                        h('button', { 'data-se': 'discard-confirm', type: 'button', class: `${BTN} text-white bg-red-600 border-red-600 hover:bg-red-700`, text: tr('skills.editor.discard'),
                            on: { click: () => { ov.remove(); this.close(); resolve(true); } } }))));
            document.body.appendChild(ov);
            return p;
        }

        /** Close now: destroys the editors; switches / saves still queued or in flight stop at their next step. */
        close() {
            if (this.closed) return;
            this.closed = true;
            this.unmount();
            this.el.remove();
            if (window.SkillEditor.current === this) window.SkillEditor.current = null;
        }

        async init() {
            this.build();
            if (this.isNew) {
                const f = { rel: 'SKILL.md', size: 0, ready: true, binary: false, error: null };
                this.setLoaded(f, newSkillTemplate(), { isNew: true });
                this.files.set('SKILL.md', f);
            } else {
                let list = [];
                try { list = await this.fs.listSkillFiles(this.dir); }
                catch (e) { this.status(tr('skills.editor.listFailed', { message: (e && e.message) || String(e) }), 'error'); }
                for (const r of list) this.files.set(r.rel, { rel: r.rel, size: r.size, loaded: null, current: null, binary: false, ready: false, error: null });
            }
            this.renderFiles();
            const first = this.files.has('SKILL.md') ? 'SKILL.md' : [...this.files.keys()].find((r) => r !== this.readmeRel()) || this.files.keys().next().value;
            if (first) await this.show(first);
            return this;
        }
    }

    async function open({ skill = null, manager = null } = {}) {
        const SE = window.SkillEditor;
        if (SE.current && !(await SE.current.requestClose())) return SE.current;   // kept editing: no new dialog
        document.getElementById('skill-editor-modal')?.remove();
        if (skill && skill.dir_name && manager) manager.lastSkillDir = skill.dir_name;   // Export preselects it
        const dlg = new Dialog({ skill, manager });
        SE.current = dlg;
        return dlg.init();
    }

    window.SkillEditor = {
        open,
        adapters: { markdown: textareaAdapter, markdownSource: textareaAdapter, code: codeAdapter, binary: binaryAdapter },
        frontPanel: frontForm,
        checkMarkdown: null,                // (md) -> { ok, changes, reason, error }; skill-md-editor.js sets it
        current: null,
        // helpers (Tasks 5-7 and tests)
        TEXT_EXT, kindOf, isTextExt, extOf, decode, validateNew, textareaAdapter, codeAdapter, modeOf, keepLineEnds, renderChanges, frontChanges,
    };
})();
