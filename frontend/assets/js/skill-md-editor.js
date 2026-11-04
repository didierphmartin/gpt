/**
 * Markdown editors for the skill editor (SkillEditor.adapters.markdown / .markdownSource) and the open-time check.
 *
 *   SkillMdEditor.check(md)        -> { ok, changes, reason, error }   ok = mergeBlocks(md, roundtrip(md)) === md:
 *                                     the formatted editor would save this file back unchanged. changes = the blocks
 *                                     it would change ([{ before, after }], for the "Why?" list).
 *   SkillMdEditor.roundtrip(md)    -> markdown: md loaded into a hidden Milkdown and serialised, no edit.
 *   SkillMdEditor.make(el, md, o)  -> a Milkdown Editor in el (o: { readOnly, onDocChange, stringify }).
 *   SkillMdEditor.formattedAdapter -> Milkdown in one pane, our toolbar, Show source swaps the SAME pane to a
 *                                     CodeMirror 5 markdown editor (and back). getText() = mergeBlocks(base, the
 *                                     editor's markdown): blocks the user did not change keep their bytes.
 *   SkillMdEditor.sourceAdapter    -> the markdown pane: CodeMirror 5 markdown mode, editable, saved as typed.
 *
 * Milkdown 7.23.0 (kit core + commonmark + gfm) loads on first use by dynamic import() from esm.sh, pinned (one
 * shared ProseMirror). Official remark-stringify options only, no patches: the round-trip check
 * (frontend/tools/md-roundtrip/run.mjs --editor milkdown, which loads THIS file) is the guard on any version change.
 */
(function (root) {
    const BASE = 'https://esm.sh/@milkdown/kit@7.23.0/';
    const URLS = [BASE + 'core', BASE + 'preset/commonmark', BASE + 'preset/gfm', BASE + 'utils', BASE + 'prose/state'];
    /** The tuned serialiser: matches how the skills corpus writes markdown where remark-stringify can. */
    const STRINGIFY = { bullet: '-', emphasis: '*', strong: '*', rule: '-', fences: true, listItemIndent: 'one', incrementListMarker: true };
    const LOAD_TIMEOUT_MS = 20000;

    const tr = (key, params) => {
        const i = root.i18n;
        return i && typeof i.t === 'function' ? i.t(key, params || {}) : key;
    };
    const msg = (e) => (e && e.message) || String(e);
    /** Show / hide without fighting a display utility class (Tailwind's .flex beats the hidden attribute). */
    const showEl = (el, on) => { el.hidden = !on; el.style.display = on ? '' : 'none'; };
    const MB = () => root.MergeBlocks;

    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
            else if (k in { value: 1, disabled: 1, hidden: 1, type: 1 }) el[k] = v;
            else el.setAttribute(k, v);
        }
        for (const c of children) if (c) el.append(c);
        return el;
    }

    // ---- Milkdown ----

    /** p, or a timeout error after api.timeoutMs (LOAD_TIMEOUT_MS); a value that arrives after the timeout goes to onLate (to destroy it). */
    function withTimeout(p, onLate) {
        let timer = null, late = false;
        const t = new Promise((_, rej) => { timer = setTimeout(() => { late = true; rej(new Error(tr('skills.editor.md.loadTimeout'))); }, api.timeoutMs); });
        return Promise.race([p.then((v) => { clearTimeout(timer); if (late && onLate) onLate(v); return v; },
            (e) => { clearTimeout(timer); throw e; }), t]);
    }

    let libP = null;
    /** The Milkdown modules ({ core, commonmark, gfm, utils, state }); a failed load is retried next time. */
    function load() {
        if (!libP) {
            libP = withTimeout(Promise.all(URLS.map((u) => import(u))))
                .then(([core, commonmark, gfm, utils, state]) => ({ core, commonmark, gfm, utils, state }))
                .catch((e) => { libP = null; throw e; });
        }
        return libP;
    }

    async function make(el, md, { readOnly = false, onDocChange = null, stringify } = {}) {
        const L = await api.load();
        const C = L.core;
        let b = C.Editor.make()
            .config((ctx) => {
                ctx.set(C.rootCtx, el);
                ctx.set(C.defaultValueCtx, md);
                if (stringify !== null) ctx.update(C.remarkStringifyOptionsCtx, (o) => Object.assign({}, o, stringify || STRINGIFY));
                if (readOnly) ctx.update(C.editorViewOptionsCtx, (o) => Object.assign({}, o, { editable: () => false }));
            })
            .use(L.commonmark.commonmark)
            .use(L.gfm.gfm);
        if (onDocChange) {
            b = b.use(L.utils.$prose(() => new L.state.Plugin({
                view: () => ({ update(view, prev) { if (!view.state.doc.eq(prev.doc)) onDocChange(); } }),
            })));
        }
        // the timeout covers creating the editor too; an editor created too late is destroyed
        return withTimeout(Promise.resolve().then(() => b.create()), (late) => { try { late.destroy(); } catch { /* gone */ } });
    }

    async function markdownOf(ed) { const L = await api.load(); return ed.action(L.utils.getMarkdown()); }

    /** md loaded into a hidden Milkdown and serialised without an edit (opts.stringify: null = Milkdown's defaults). */
    async function roundtrip(md, opts = {}) {
        const box = h('div', { style: 'position:fixed;left:-10000px;top:0;width:800px;visibility:hidden', 'aria-hidden': 'true' });
        document.body.appendChild(box);
        let ed = null;
        try {
            ed = await make(box, md, { stringify: opts.stringify });
            return await markdownOf(ed);
        } finally {
            if (ed) { try { await ed.destroy(); } catch { /* gone */ } }
            box.remove();
        }
    }

    /** Would the formatted editor save md back unchanged? A throw / load failure counts as no. */
    async function check(md) {
        // the block lexer reads CRLF as LF, so such a file never merges back byte for byte: say why, not 50 blocks
        if (/\r/.test(md)) return { ok: false, changes: [], reason: '', error: tr('skills.editor.md.crlf') };
        try {
            const out = await api.roundtrip(md);
            const r = MB().merge(md, out);
            const ok = r.md === md;
            return { ok, changes: ok ? [] : r.changes, reason: r.merged ? '' : r.reason, error: '' };
        } catch (e) {
            return { ok: false, changes: [], reason: '', error: msg(e) };
        }
    }

    // ---- CodeMirror 5 markdown pane ----

    /** CodeMirror's getValue() turns CRLF into LF: give back the text as mounted when nothing changed, keep CRLF files CRLF. */
    const keepEnds = (orig, v) => (root.SkillEditor && root.SkillEditor.keepLineEnds ? root.SkillEditor.keepLineEnds(orig, v) : v);

    function makeCm(el, text, readOnly) {
        const cm = root.CodeMirror(el, {
            value: text, mode: 'markdown', lineNumbers: true, lineWrapping: true, readOnly: !!readOnly,
            indentUnit: 4, tabSize: 4, indentWithTabs: false, viewportMargin: 50,
        });
        cm.setSize('100%', '100%');
        return cm;
    }
    const PANE = 'h-full min-h-0 border border-gray-300 rounded-lg overflow-hidden bg-white';

    /** The markdown pane (files the formatted editor would change): CodeMirror markdown mode, saved as typed. */
    function sourceAdapter() {
        if (!root.CodeMirror && root.SkillEditor) return root.SkillEditor.textareaAdapter();
        let host = null, box = null, cm = null, orig = '';
        return {
            mount(el, text, { readOnly } = {}) {
                host = el;
                orig = String(text || '');
                box = h('div', { class: PANE, 'data-md': 'source' });
                el.appendChild(box);
                cm = makeCm(box, orig, readOnly);
            },
            getText: () => (cm ? keepEnds(orig, cm.getValue()) : orig),
            onChange(cb) { if (cm) cm.on('change', () => cb()); },
            destroy() { if (box && host) host.removeChild(box); box = cm = null; },
        };
    }

    // ---- the formatted editor ----

    const BTN = 'px-2 py-1 text-xs rounded border border-gray-300 text-gray-700 bg-white hover:bg-gray-100 disabled:opacity-40';

    function formattedAdapter() {
        let host = null, wrap = null, bar = null, pane = null, linkBox = null, linkInput = null, srcBtn = null;
        let ed = null, edBox = null, cm = null, cmBox = null;
        // original: the file's markdown AS LOADED (the merge base of every formatted save); base: the text this pane was
        // given (returned as is until the user edits); lastGood: the last text getText produced.
        let original = '', base = '', lastGood = '', touched = false, mode = 'formatted', readOnly = false, busy = false, destroyed = false, timer = null, L = null;
        const cbs = [];
        const fire = () => { clearTimeout(timer); timer = setTimeout(() => cbs.forEach((cb) => cb()), 150); };

        function view(fn) { if (ed) ed.action((ctx) => fn(ctx.get(L.core.editorViewCtx), ctx)); }
        function focus() { view((v) => v.focus()); }
        function cmd(key, payload) { if (ed) { ed.action(L.utils.callCommand(key, payload)); focus(); } }

        /** Checklist: make the current list item a task (wrapping it in a bullet list first) or a plain item again. */
        function toggleTask() {
            view((v, ctx) => {
                const find = () => {
                    const $f = v.state.selection.$from;
                    for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === 'list_item') return { n: $f.node(d), pos: $f.before(d) };
                    return null;
                };
                let li = find();
                if (!li) { ctx.get(L.core.commandsCtx).call(L.commonmark.wrapInBulletListCommand.key); li = find(); }
                if (!li) return;
                v.dispatch(v.state.tr.setNodeMarkup(li.pos, undefined, Object.assign({}, li.n.attrs, { checked: li.n.attrs.checked == null ? false : null })));
                v.focus();
            });
        }

        /** Bulleted / numbered list: wrap the block, or switch the list the cursor is in to the other kind. */
        function list(name, wrapCmd) {
            let switched = false;
            view((v) => {
                const $f = v.state.selection.$from;
                for (let d = $f.depth; d > 0; d--) {
                    const n = $f.node(d);
                    if (n.type.name !== 'bullet_list' && n.type.name !== 'ordered_list') continue;
                    if (n.type.name !== name) {
                        // the items carry their list type too (Milkdown syncs it back from them otherwise)
                        const pos = $f.before(d), listType = name === 'bullet_list' ? 'bullet' : 'ordered';
                        // every attribute the list has is kept (ProseMirror keeps those the new type defines, e.g. order)
                        const t = v.state.tr.setNodeMarkup(pos, v.state.schema.nodes[name], Object.assign({}, n.attrs));
                        n.forEach((item, off) => { t.setNodeMarkup(pos + 1 + off, undefined, Object.assign({}, item.attrs, { listType })); });
                        v.dispatch(t);
                        v.focus();
                    }
                    switched = true;
                    return;
                }
            });
            if (!switched) cmd(wrapCmd.key);
        }

        function applyLink() {
            const href = linkInput.value.trim();
            showEl(linkBox, false);
            if (!href) { focus(); return; }
            let empty = true;
            view((v) => { empty = v.state.selection.empty; });
            if (!empty) { cmd(L.commonmark.toggleLinkCommand.key, { href }); return; }
            view((v) => {
                const s = v.state, link = s.schema.marks.link.create({ href });
                v.dispatch(s.tr.replaceSelectionWith(s.schema.text(href, [link]), false));
                v.focus();
            });
        }

        function buildBar() {
            const keep = (e) => e.preventDefault();   // a click on the toolbar keeps the editor's selection
            const b = (key, label, fn, extra) => h('button', Object.assign({ type: 'button', class: BTN, title: tr('skills.editor.md.' + key), 'data-md': key, text: label,
                on: { mousedown: keep, click: () => { if (ed && mode === 'formatted') fn(); } } }, extra || {}));
            const C = () => L.commonmark;
            const heading = h('select', { class: 'px-1 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700', 'data-md': 'heading', title: tr('skills.editor.md.heading'),
                on: { change: () => {
                    const v = heading.value; heading.value = '';
                    if (!ed || mode !== 'formatted' || !v) return;
                    if (v === 'p') cmd(C().turnIntoTextCommand.key); else cmd(C().wrapInHeadingCommand.key, Number(v));
                } } },
            h('option', { value: '', text: tr('skills.editor.md.heading') }),
            ...[1, 2, 3, 4].map((n) => h('option', { value: String(n), text: tr('skills.editor.md.headingN', { n }) })),
            h('option', { value: 'p', text: tr('skills.editor.md.paragraph') }));
            const sep = () => h('span', { class: 'w-px h-5 bg-gray-300 mx-1' });
            linkInput = h('input', { type: 'text', class: 'px-2 py-1 text-xs border border-gray-300 rounded w-64', placeholder: tr('skills.editor.md.linkUrl'), 'data-md': 'link-url',
                on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } else if (e.key === 'Escape') { showEl(linkBox, false); focus(); } } } });
            linkBox = h('span', { class: 'flex items-center gap-1', 'data-md': 'link-box' }, linkInput,
                h('button', { type: 'button', class: BTN, 'data-md': 'link-apply', text: tr('skills.editor.md.linkApply'), on: { click: applyLink } }));
            showEl(linkBox, false);
            srcBtn = h('button', { type: 'button', class: BTN + ' ml-auto', 'data-md': 'toggle', text: tr('skills.editor.md.showSource'), on: { click: () => toggle() } });
            const items = readOnly ? [] : [
                heading,
                b('bold', 'B', () => cmd(C().toggleStrongCommand.key), { class: BTN + ' font-bold' }),
                b('italic', 'I', () => cmd(C().toggleEmphasisCommand.key), { class: BTN + ' italic' }),
                sep(),
                b('bulletList', '• ' + tr('skills.editor.md.list'), () => list('bullet_list', C().wrapInBulletListCommand)),
                b('orderedList', '1. ' + tr('skills.editor.md.list'), () => list('ordered_list', C().wrapInOrderedListCommand)),
                b('checklist', '☐', toggleTask),
                sep(),
                b('table', tr('skills.editor.md.tableShort'), () => cmd(L.gfm.insertTableCommand.key, { row: 3, col: 3 })),
                b('codeBlock', tr('skills.editor.md.codeShort'), () => cmd(C().createCodeBlockCommand.key)),
                b('link', tr('skills.editor.md.linkShort'), () => { linkInput.value = ''; showEl(linkBox, true); linkInput.focus(); }),
                linkBox,
            ];
            bar = h('div', { class: 'flex flex-wrap items-center gap-1 pb-2', 'data-md': 'toolbar' }, ...items, sep(), srcBtn);
        }

        function updateBar() {
            srcBtn.textContent = tr(mode === 'formatted' ? 'skills.editor.md.showSource' : 'skills.editor.md.showFormatted');
            for (const el of bar.querySelectorAll('button, select')) if (el !== srcBtn) el.disabled = mode !== 'formatted';
            if (mode !== 'formatted' && linkBox) showEl(linkBox, false);
        }

        async function showFormatted(text) {
            const box = h('div', { class: PANE + ' overflow-auto', 'data-md': 'formatted' });
            const inner = h('div', { class: 'markdown-content skill-md-pane min-h-full' });
            box.appendChild(inner);
            pane.appendChild(box);
            touched = false;
            let made;
            try {
                made = await make(inner, text, { readOnly, onDocChange: () => { touched = true; fire(); } });
            } catch (e) {
                box.remove();
                throw e;
            }
            if (destroyed) {                    // destroyed while Milkdown was being made: do not keep it
                box.remove();
                try { await made.destroy(); } catch { /* gone */ }
                return;
            }
            ed = made;
            edBox = box;
            base = lastGood = text;
            mode = 'formatted';
        }

        function showSource(text) {
            cmBox = h('div', { class: PANE, 'data-md': 'source' });
            pane.appendChild(cmBox);
            cm = makeCm(cmBox, text, readOnly);
            cm.on('change', fire);
            base = lastGood = text;
            mode = 'source';
        }

        /** Milkdown failed to give its markdown: show the last good text in the source pane, and the error. */
        function fallBack(e) {
            if (mode !== 'formatted' || destroyed) return;
            const old = ed; ed = null;
            if (edBox) { edBox.remove(); edBox = null; }
            if (old) Promise.resolve().then(() => old.destroy()).catch(() => {});
            showSource(lastGood);
            if (bar) updateBar();
            status(tr('skills.editor.md.serialiseFailed', { message: msg(e) }));
        }

        /** Show formatted was refused: say why and list the blocks it would change. */
        function showWhy(r) {
            if (!statusEl) return;
            const R = root.SkillEditor && root.SkillEditor.renderChanges;
            statusEl.replaceChildren(
                h('p', { text: tr('skills.editor.md.staysSource') + ' ' + (r.error ? r.error : r.reason ? tr('skills.editor.md.whyRefused') : '') }),
                r.changes && r.changes.length && R ? h('div', { class: 'mt-1 mb-2 max-h-48 overflow-auto text-gray-700', 'data-md': 'why-list' }, R(r.changes)) : null);
        }

        async function dropFormatted() {
            const e = ed; ed = null;
            if (edBox) { edBox.remove(); edBox = null; }
            if (e) { try { await e.destroy(); } catch (err) { console.warn('[SkillMdEditor] destroy', err); } }
        }
        function dropSource() { if (cmBox) cmBox.remove(); cmBox = cm = null; }

        /** Show source / Show formatted: the same pane, carrying the text. Never an edit by itself. */
        async function toggle() {
            if (busy || !pane || destroyed) return;
            busy = true;
            try {
                const from = mode;
                const text = api_.getText();
                if (mode !== from) return;      // getText fell back to the source pane (Milkdown failed)
                if (mode === 'formatted') {
                    await dropFormatted();
                    if (destroyed) return;
                    showSource(text);
                    status('');
                } else {
                    if (text !== base) {        // typed in the source pane: would Milkdown keep it?
                        const r = await api.check(text);
                        if (destroyed) return;
                        if (!r.ok) { showWhy(r); return; }
                    }
                    const keepCm = cmBox;
                    if (keepCm) showEl(keepCm, false);
                    try {
                        await showFormatted(text);
                        if (destroyed) return;
                        dropSource();
                        status('');
                    } catch (e) {
                        if (keepCm) showEl(keepCm, true);
                        mode = 'source';
                        base = text;
                        status(tr('skills.editor.md.loadFailed', { message: msg(e) }));
                    }
                }
            } catch (e) {
                status(tr('skills.editor.md.loadFailed', { message: msg(e) }));
            } finally {
                busy = false;
                if (bar) updateBar();
            }
        }

        let statusEl = null;
        function status(text) { if (statusEl) statusEl.textContent = text || ''; }

        const api_ = {
            async mount(el, text, opts = {}) {
                host = el;
                readOnly = !!opts.readOnly;
                original = String(opts.original !== undefined && opts.original !== null ? opts.original : (text || ''));
                L = await api.load();
                if (destroyed) return;
                buildBar();
                statusEl = h('div', { class: 'text-xs text-red-700', 'data-md': 'status' });
                pane = h('div', { class: 'flex-1 min-h-0' });
                wrap = h('div', { class: 'h-full flex flex-col' }, bar, statusEl, pane);
                el.appendChild(wrap);
                try {
                    await showFormatted(String(text || ''));
                } catch (e) {
                    if (wrap && wrap.parentNode === el) el.removeChild(wrap);
                    wrap = null;
                    throw e;
                }
                if (destroyed) return;          // destroy() already took the pane down
                updateBar();
            },
            /**
             * The text to save: as given until the user edits; then, formatted, mergeBlocks(the file AS LOADED, the
             * editor's markdown) - so the changes view (loaded -> this) is exactly what is written; source: as typed.
             * Never throws: a Milkdown failure falls back to the source pane with the last good text.
             */
            getText() {
                if (mode === 'source') { lastGood = cm ? keepEnds(base, cm.getValue()) : base; return lastGood; }
                if (!ed || !touched) return base;
                try {
                    lastGood = MB().mergeBlocks(original, ed.action(L.utils.getMarkdown()));
                } catch (e) {
                    fallBack(e);
                }
                return lastGood;
            },
            onChange(cb) { cbs.push(cb); },
            destroy() {
                destroyed = true;
                clearTimeout(timer);
                cbs.length = 0;
                dropSource();
                dropFormatted();
                if (wrap && host && wrap.parentNode === host) host.removeChild(wrap);
                wrap = pane = bar = null;
            },
            // for tests and the toolbar
            toggle, get mode() { return mode; },
        };
        return api_;
    }

    const api = { URLS, STRINGIFY, timeoutMs: LOAD_TIMEOUT_MS, load, make, roundtrip, check, formattedAdapter, sourceAdapter };
    root.SkillMdEditor = api;
    if (root.SkillEditor) {
        root.SkillEditor.adapters.markdown = formattedAdapter;
        root.SkillEditor.adapters.markdownSource = sourceAdapter;
        root.SkillEditor.checkMarkdown = (md) => api.check(md);
    }
})(typeof window !== 'undefined' ? window : globalThis);
