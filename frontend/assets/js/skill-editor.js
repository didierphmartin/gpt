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
 *   factory() -> { mount(el, text, { readOnly, rel }), getText(), onChange(cb), destroy() }   (mount may be async)
 * markdown / markdownSource / code default to a plain <textarea>; binary is a read-only placeholder.
 * skill-md-editor.js installs markdown (Milkdown, formatted), markdownSource (CodeMirror markdown) and checkMarkdown.
 * SkillEditor.frontPanel is the frontmatter panel slot, same shape: mount(el, front, { readOnly, isNew }).
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
            destroy() { if (ta && host) host.removeChild(ta); ta = null; },
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
            destroy() { if (box && host) host.removeChild(box); box = null; },
        };
    }

    /** Frontmatter panel slot (Task 7 puts the form here). Raw text; editable only for New Skill. */
    function rawFrontPanel() {
        let box = null, ta = null, host = null;
        return {
            mount(el, front, { readOnly, isNew } = {}) {
                host = el;
                ta = h('textarea', {
                    class: 'w-full mt-1 p-2 text-xs font-mono border border-gray-300 rounded-lg resize-y',
                    rows: 5, spellcheck: 'false', readOnly: !!readOnly, value: front || '',
                });
                box = h('details', { class: 'text-xs text-gray-700', open: !!isNew },
                    h('summary', { class: 'cursor-pointer font-medium text-gray-600', text: tr('skills.editor.frontmatter') }), ta);
                el.appendChild(box);
            },
            getText: () => (ta ? ta.value : ''),
            onChange(cb) { if (ta) ta.addEventListener('input', () => cb()); },
            destroy() { if (box && host) host.removeChild(box); box = ta = null; },
        };
    }

    // ---- New Skill ----

    const newSkillTemplate = () => '---\nname:\ndescription:\ndependencies: []\n---\n\n' + tr('skills.editor.template');

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
            return f.current !== (f.loaded === null ? f.template : f.loaded);   // New Skill: compared with the template
        }

        build() {
            const sel = h('select', { 'data-se': 'file', class: 'flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white',
                on: { change: () => this.show(sel.value) } });
            this.el = h('div', { id: 'skill-editor-modal', class: 'fixed inset-0 z-[200] flex items-center justify-center', style: 'background-color: rgba(0,0,0,0.5)' },
                h('div', { class: 'bg-white rounded-xl shadow-xl border border-gray-200 w-[96vw] h-[94vh] overflow-hidden flex flex-col' },
                    h('div', { class: 'flex items-center justify-between px-4 py-3 border-b border-gray-200' },
                        h('h3', { 'data-se': 'title', class: 'text-sm font-bold text-gray-800' }),
                        h('button', { 'data-se': 'close', type: 'button', class: 'p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded', text: '✕',
                            on: { click: () => this.requestClose() } })),
                    h('div', { class: 'flex items-center gap-3 px-4 pt-3' },
                        h('label', { class: 'text-xs font-medium text-gray-700', text: tr('skills.editor.file') }),
                        sel,
                        h('span', { class: 'text-xs text-gray-400 whitespace-nowrap', text: tr('skills.editor.unsavedLegend') })),
                    h('div', { 'data-se': 'note', class: 'px-4 pt-2 text-xs text-gray-500' }),
                    h('div', { 'data-se': 'front', class: 'px-4 pt-2' }),
                    h('div', { 'data-se': 'editor', class: 'flex-1 min-h-0 px-4 py-3' }),
                    h('div', { class: 'flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200' },
                        h('div', { 'data-se': 'status', class: 'flex-1 min-w-0 text-xs' }),
                        h('button', { 'data-se': 'cancel', type: 'button', class: `${BTN} text-gray-600 border-gray-300 hover:bg-gray-100`, text: tr('common.cancel'),
                            on: { click: () => this.requestClose() } }),
                        this.readOnly ? null : h('button', { 'data-se': 'save', type: 'button', class: `${BTN} text-white bg-blue-600 border-blue-600 hover:bg-blue-700`, text: tr('common.save'),
                            on: { click: () => this.save() } }))));
            this.q = (k) => this.el.querySelector(`[data-se="${k}"]`);
            document.body.appendChild(this.el);
            this.setTitle();
        }

        setTitle() {
            this.q('title').textContent = this.isNew ? tr('skills.editor.titleNew') : tr('skills.editor.titleEdit', { name: this.dir });
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
            for (const f of this.files.values()) {
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
                if (this.panel && this.isNew) f.front = this.panel.getText();   // existing skills: front kept as loaded (Task 7: form)
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
            }
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
            this.q('file').value = rel;
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
                this.panel = await this.mountOne(SE.frontPanel, this.q('front'), f.front, { readOnly: readOnly || !this.isNew, isNew: this.isNew });
                if (this.closed) return;
            }
            const el = this.q('editor'), text = f.binary ? '' : (rel === 'SKILL.md' ? f.body : f.current);
            try {
                this.editor = await this.mountOne(SE.adapters[kind], el, text, { readOnly, rel });
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

        changed() {
            this.capture();
            this.refreshDots();
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
            this.setTitle();
            await this._show('SKILL.md');       // the panel remounts as for an existing skill
            await this.refreshTree();
            this.status(tr('skills.editor.created', { name }), 'ok');
            return { written: ['SKILL.md'], failed: [] };
        }

        /** Files that opened in the formatted editor and whose markdown changed: what "Changes to be saved" lists. */
        reviews(dirty) {
            const MB = window.MergeBlocks;
            const out = [];
            for (const f of dirty) {
                if (!f.md || !f.md.ok || f.loaded === null || !MB) continue;
                const before = this.mdOf(f, f.loaded), after = this.mdOf(f, f.current);
                if (before === after) continue;    // e.g. only the frontmatter changed
                const m = MB.merge(before, after);
                if (!m.merged) { out.push({ rel: f.rel, changes: [{ before, after }], refused: m.reason }); continue; }
                out.push({ rel: f.rel, changes: MB.diffBlocks(before, after).changes, refused: '' });
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
                            h('h4', { class: 'text-xs font-semibold text-gray-700', text: r.rel }),
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
            const first = this.files.keys().next().value;
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
        adapters: { markdown: textareaAdapter, markdownSource: textareaAdapter, code: textareaAdapter, binary: binaryAdapter },
        frontPanel: rawFrontPanel,
        checkMarkdown: null,                // (md) -> { ok, changes, reason, error }; skill-md-editor.js sets it
        current: null,
        // helpers (Tasks 5-7 and tests)
        TEXT_EXT, kindOf, isTextExt, extOf, decode, validateNew, textareaAdapter, keepLineEnds, renderChanges,
    };
})();
