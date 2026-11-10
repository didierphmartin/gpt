/**
 * A server's private settings, read and saved where its files are, and the Run check that asks for missing ones.
 *
 * Two places hold a server's files:
 *   - local: mcps/<folder>/ in the user's SynergyAI folder (mcps/servers.json maps server name -> folder);
 *   - host:  the Docker app's server host (the registered URL points at its gateway + "/<folder>/...").
 * The Settings panel (key icon) and the editor's Run check both use these readers and writers.
 *
 * window.McpServerSettings:
 *   readLocalInfo(folder), readHostInfo(folder, host), saveLocal(info, values), saveHost(info, values)
 *   checkTargets(names, metas, map, gateway)   pure: which used servers can be checked, and where
 *   findMissing(names)                         the checkable servers with a required setting empty
 *   runGate(editor, names, metas)              Run check: true = run, false = cancelled
 *   mountServerSettings(el, editor, metas)     the code component form's per-server settings block
 * Depends on: window.WorkflowPackage, window.WorkflowPackageUI, window.localFs, window.mcpClient.
 */
(function () {
    'use strict';

    const WP = () => window.WorkflowPackage;
    const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

    async function readText(path) {
        const fh = await window.localFs.resolvePath(path, { kind: 'file' });
        return fh ? (await fh.getFile()).text() : null;
    }

    async function writeText(path, text) {
        const fh = await window.localFs.resolvePath(path, { create: true, kind: 'file' });
        if (!fh) throw new Error('cannot write');
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
    }

    async function folderGranted() {
        try { return (await window.localFs?.getStatus())?.state === 'granted'; } catch (_) { return false; }
    }

    /** { name: folder } from mcps/servers.json (null-prototype); empty when absent. Throws when unreadable. */
    async function readServerMap() {
        const out = Object.create(null);
        const text = await readText('mcps/servers.json');
        if (!text) return out;
        const map = JSON.parse(text);
        if (map && typeof map === 'object' && !Array.isArray(map)) for (const k of Object.keys(map)) out[k] = map[k];
        return out;
    }

    /** One local server's manifest, declared settings and current values. */
    async function readLocalInfo(folder) {
        const base = `mcps/${folder}`;
        const info = { folder, fields: [], values: {}, manifest: null, missing: [], error: false };
        try {
            const [manText, exText, envText] = await Promise.all([
                readText(`${base}/synergyai-mcp.json`).catch(() => null),
                readText(`${base}/.env.example`).catch(() => null),
                readText(`${base}/.env`).catch(() => null),
            ]);
            info.manifest = manText ? JSON.parse(manText) : null;
            info.fields = WP().envFields(info.manifest, exText || '');
            info.values = WP().parseEnv(envText || '');
            info.missing = WP().missingRequired(info.fields, info.values);
        } catch (_) {
            info.error = true;
        }
        return info;
    }

    /** One host server: its declared settings (no secret values) and its supervisor state. */
    async function readHostInfo(folder, host) {
        const info = { host: true, folder, fields: [], shown: {}, missing: [], manifest: null,
            state: host?.state || '', enabled: host ? host.enabled !== false : true,
            installedBy: host?.installed_by ?? host?.installedBy ?? null, error: false };
        try {
            const data = await window.mcpClient.hostSettings(folder);
            const all = data?.fields || [];
            // The host and port the supervisor sets itself are hidden: a value saved for them does nothing.
            const over = Array.isArray(data?.overridden) ? data.overridden
                : ['_HOST', '_PORT'].map(sfx => all.find(f => f.name?.endsWith(sfx))?.name).filter(Boolean);
            info.fields = all.filter(f => !over.includes(f.name));
            // Secrets show empty (their placeholder says they are set); the rest show value or default.
            info.shown = Object.fromEntries(info.fields.map(f => [f.name, f.secret ? '' : (f.filled ? (f.value ?? '') : (f.default ?? ''))]));   // default shows while unset (display only)
            info.missing = WP().missingSettings(info.fields, (f) => !!f.filled);   // required + started groups
        } catch (e) {
            console.warn('[settings:mcp] host settings unreadable:', e.message);
            info.error = true;
        }
        return info;
    }

    /** Write the declared settings to mcps/<folder>/.env, keeping every other line; updates info.values / missing. */
    async function saveLocal(info, values) {
        // Undeclared keys and comments in the file stay: only the declared keys' lines change.
        const path = `mcps/${info.folder}/.env`;
        const current = await readText(path).catch(() => null);
        await writeText(path, WP().mergeEnv(current || '', values));
        info.values = Object.assign(Object.create(null), info.values, values);
        info.missing = WP().missingRequired(info.fields, info.values);
    }

    /** Send the host only what changed from what it shows; a blank secret keeps the stored one. Returns the count sent. */
    async function saveHost(info, values) {
        const changed = {};
        for (const f of info.fields) {
            const v = own(values, f.name);
            if (v !== undefined && v !== (info.shown[f.name] ?? '')) changed[f.name] = v;
        }
        if (Object.keys(changed).length) await window.mcpClient.hostSaveSettings(info.folder, changed);
        return Object.keys(changed).length;
    }

    /**
     * Where each used server's settings can be read: [{name, host, folder}].
     * metas = the user's registered servers (/me/mcp-servers); their own row wins over a global one of the same name.
     * A server on the host (URL under gateway) is a host target; else a valid mcps/servers.json entry is a local one;
     * a server known only by its URL is not checkable and left out.
     */
    function checkTargets(names, metas, map, gateway) {
        const out = [];
        for (const name of [...new Set(names || [])]) {
            const rows = (metas || []).filter((m) => m && m.name === name && m.effective_on !== false);
            const meta = rows.find((m) => !m.is_global) || rows[0];
            if (!meta) continue;
            const hf = gateway ? WP().hostFolderOf(meta.url, gateway) : null;
            if (hf) { out.push({ name, host: true, folder: hf }); continue; }
            const folder = own(map, name);
            if (typeof folder === 'string' && WP().isSafeSegment(folder)) out.push({ name, host: false, folder });
        }
        return out;
    }

    /** The used servers that can be checked and have a required setting empty: [{name, info}]. Never throws. */
    async function findMissing(names, metas) {
        return (await readAll(names, metas)).filter((r) => !r.info.error && r.info.missing.length);
    }

    /** Every used server whose settings can be read, with its info (error = unreadable): [{name, info}]. */
    async function readAll(names, metas) {
        if (!(names || []).length || !window.WorkflowPackage) return [];
        let gateway = null, map = Object.create(null);
        try {
            const st = await window.mcpClient?.hostStatus();
            if (st?.available && st.gateway) gateway = st.gateway;
        } catch (_) { /* no host */ }
        if (window.localFs && await folderGranted()) {
            try { map = await readServerMap(); } catch (_) { /* unreadable map: no local servers */ }
        }
        const targets = checkTargets(names, metas, map, gateway);
        let hosted = [];
        if (targets.some((x) => x.host)) { try { hosted = await window.mcpClient.hostServers(); } catch (_) { /* state unknown */ } }
        const infos = await Promise.all(targets.map((x) => (x.host
            ? readHostInfo(x.folder, hosted.find((h) => h.folder === x.folder))
            : readLocalInfo(x.folder))));
        return targets.map((x, i) => ({ name: x.name, info: infos[i] }));
    }

    /** Settings still needed in a section (required + started groups): a host secret already stored counts as filled. */
    function sectionMissing(info, values) {
        const filled = (f) => !!String(own(values, f.name) ?? '').trim() || !!(info.host && f.secret && f.filled);
        return WP().missingSettings(info.fields, filled);
    }

    const BTN = 'padding: 6px 14px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px;';
    const BTN_PRIMARY = 'padding: 6px 14px; border: 1px solid #2563eb; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; font-size: 13px;';

    /**
     * The Run check: when a used server lacks a required setting, a form with all its settings opens.
     * Save writes them; a host server restarts by itself (its settings route does it) and the run goes on, a local one shows its start command
     * and waits for Continue. Resolves true to run, false when cancelled.
     */
    async function runGate(editor, names, metas) {
        const missing = await findMissing(names, metas);
        if (!missing.length) return true;
        const UI = window.WorkflowPackageUI;
        const esc = UI.esc;
        const t = (k, p) => esc(editor.t(`workflow.runSettings.${k}`, p));
        const tp = (k, p) => esc(editor.t(`workflow.package.${k}`, p));
        const tPlain = (k) => editor.t(`workflow.package.${k}`);

        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.id = 'wf-run-settings';
            modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10000; display: flex; align-items: center; justify-content: center;';
            modal.innerHTML = `<div style="background: #fff; border-radius: 12px; padding: 20px; width: 560px; max-width: 94vw; max-height: 88vh; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;">
                <h2 style="margin: 0; font-size: 16px; font-weight: 600;">${t('title')}</h2><div data-body style="display: flex; flex-direction: column; gap: 12px;"></div></div>`;
            document.body.appendChild(modal);
            const body = modal.querySelector('[data-body]');
            const done = (ok) => { modal.remove(); resolve(ok); };
            body.addEventListener('click', (e) => {
                const tg = e.target.closest('[data-toggle-secret]');
                if (tg) UI.toggleSecret(tg, tPlain);
            });

            const sectionValues = (i) => {
                const v = Object.create(null);
                body.querySelectorAll(`[data-section="${i}"] [data-value]`).forEach((el) => { v[el.dataset.value] = el.value; });
                return v;
            };

            function form(error) {
                body.innerHTML = `<div style="font-size: 13px; color: #475569;">${t('intro')}</div>
                    ${missing.map((m, i) => {
                        const info = m.info;
                        const shown = info.host ? info.shown : { ...Object.fromEntries(info.fields.map((f) => [f.name, f.default])), ...info.values };
                        return `<div data-section="${i}" style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;">
                            <strong style="font-size: 14px;">${esc(m.name)} <span style="font-weight: 400; color: #64748b; font-size: 12px;">mcps/${esc(info.folder)}</span></strong>
                            ${UI.settingsFieldsHtml(tp, info.fields, shown)}</div>`;
                    }).join('')}
                    <div data-reason style="font-size: 12px; color: #b45309;"></div>
                    ${error ? `<div style="font-size: 12px; color: #b91c1c;">${esc(error)}</div>` : ''}
                    <div style="display: flex; justify-content: flex-end; gap: 8px;">
                        <button type="button" data-cancel style="${BTN}">${tp('cancel')}</button>
                        <button type="button" data-save style="${BTN_PRIMARY}">${t('save')}</button></div>`;
                missing.forEach((m, i) => {
                    if (!m.info.host) return;
                    const set = new Set(m.info.fields.filter((f) => f.secret && f.filled).map((f) => f.name));
                    body.querySelectorAll(`[data-section="${i}"] [data-value]`).forEach((el) => {
                        if (set.has(el.dataset.value)) el.placeholder = editor.t('settings.mcpHostSecretSet');
                    });
                });
                const save = body.querySelector('[data-save]');
                const refresh = () => {
                    const left = missing.flatMap((m, i) => sectionMissing(m.info, sectionValues(i)));
                    save.disabled = left.length > 0;
                    save.style.opacity = left.length ? '0.5' : '1';
                    body.querySelector('[data-reason]').textContent = left.length ? editor.t('workflow.runSettings.stillMissing', { names: left.join(', ') }) : '';
                };
                body.oninput = refresh;
                refresh();
                body.querySelector('[data-cancel]').onclick = () => done(false);
                save.onclick = async () => {
                    save.disabled = true;
                    save.textContent = editor.t('workflow.runSettings.saving');
                    const restartLocal = [];
                    try {
                        for (const [i, m] of missing.entries()) {
                            const v = sectionValues(i);
                            if (m.info.host) {
                                await saveHost(m.info, v);   // the host restarts the server when its settings change
                            } else {
                                await saveLocal(m.info, v);
                                restartLocal.push(m);
                            }
                        }
                    } catch (e) {
                        form(editor.t('workflow.runSettings.saveFailed', { error: (e && e.message) || String(e) }));
                        return;
                    }
                    if (restartLocal.length) restart(restartLocal); else done(true);
                };
            }

            function restart(list) {
                body.oninput = null;
                body.innerHTML = `<div style="font-size: 13px; color: #166534;">✓ ${t('saved')}</div>
                    <div style="font-size: 13px; color: #475569;">${t('restartHelp')}</div>
                    ${list.map((m) => {
                        const start = typeof m.info.manifest?.start === 'string' ? m.info.manifest.start : '';
                        return `<div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;">
                            <strong style="font-size: 14px;">${esc(m.name)} <span style="font-weight: 400; color: #64748b; font-size: 12px;">mcps/${esc(m.info.folder)}</span></strong>
                            ${start ? UI.commandBlockHtml(tp, tp('startCommand'), start) : `<div style="font-size: 13px; color: #64748b;">${t('noStartCommand')}</div>`}</div>`;
                    }).join('')}
                    <div style="display: flex; justify-content: flex-end; gap: 8px;">
                        <button type="button" data-cancel style="${BTN}">${tp('cancel')}</button>
                        <button type="button" data-continue style="${BTN_PRIMARY}">${t('continue')}</button></div>`;
                UI.wireCopyButtons(body, tPlain);
                body.querySelector('[data-cancel]').onclick = () => done(false);
                body.querySelector('[data-continue]').onclick = () => done(true);
            }

            form('');
        });
    }

    /**
     * The code component form's "Server settings" block: one line per used server ("settings complete" / "missing: X",
     * or "kept by the server" when its files are not reachable from here), opening to all its settings and a Save.
     * A server with something missing starts open. Returns { refresh(names) } -- call it when the server ticks change.
     */
    function mountServerSettings(el, editor, metas) {
        const UI = window.WorkflowPackageUI;
        const esc = UI.esc;
        const t = (k, p) => esc(editor.t(`workflow.serverSettings.${k}`, p));
        const tp = (k, p) => esc(editor.t(`workflow.package.${k}`, p));
        const tPlain = (k) => editor.t(`workflow.package.${k}`);
        let seq = 0, names = [];
        const shownOf = (info) => (info.host ? info.shown : { ...Object.fromEntries(info.fields.map((f) => [f.name, f.default])), ...info.values });
        const status = (info) => (info.error ? `<span style="color:#b91c1c;">${t('unreadable')}</span>`
            : !info.fields.length ? `<span style="color:#64748b;">${t('none')}</span>`
            : info.missing.length ? `<span style="color:#b45309;">⚠ ${t('missing', { names: info.missing.join(', ') })}</span>`
            : `<span style="color:#166534;">✓ ${t('complete')}</span>`);

        function rowHtml(r, i) {
            const info = r.info;
            const body = info.error || !info.fields.length ? '' : `<div data-fields style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">${UI.settingsFieldsHtml(tp, info.fields, shownOf(info))}</div>
                <div data-result style="font-size:12px;"></div>
                <div style="display:flex;justify-content:flex-end;"><button type="button" data-save class="mcp-btn mcp-btn-primary" style="padding:4px 12px;">${t('save')}</button></div>`;
            return `<details data-row="${i}" ${info.missing.length ? 'open' : ''} style="border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;">
                <summary style="cursor:pointer;font-size:13px;"><strong>${esc(r.name)}</strong> <span style="color:#64748b;font-size:12px;">mcps/${esc(info.folder)}</span> — ${status(info)}</summary>${body}</details>`;
        }

        async function render() {
            const my = ++seq;
            if (!names.length) { el.innerHTML = ''; return; }
            el.innerHTML = `<p style="font-size:12px;color:#64748b;margin:0;">…</p>`;
            const rows = await readAll(names, metas);
            if (my !== seq) return;   // ticks changed meanwhile
            const unreachable = names.filter((n) => !rows.some((r) => r.name === n));
            el.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:4px;">${t('title')}</div>
                <p style="font-size:12px;color:#64748b;margin:0 0 8px;">${t('help')}</p>
                <div style="display:flex;flex-direction:column;gap:6px;">${rows.map(rowHtml).join('')}
                ${unreachable.map((n) => `<div style="font-size:13px;padding:4px 10px;"><strong>${esc(n)}</strong> — <span style="color:#64748b;">${t('notHere')}</span></div>`).join('')}</div>`;
            rows.forEach((r, i) => {
                const row = el.querySelector(`[data-row="${i}"]`);
                if (r.info.host) {
                    const set = new Set(r.info.fields.filter((f) => f.secret && f.filled).map((f) => f.name));
                    row.querySelectorAll('[data-value]').forEach((x) => { if (set.has(x.dataset.value)) x.placeholder = editor.t('settings.mcpHostSecretSet'); });
                }
                row.addEventListener('click', (e) => {
                    const tg = e.target.closest('[data-toggle-secret]');
                    if (tg) UI.toggleSecret(tg, tPlain);
                });
                const btn = row.querySelector('[data-save]');
                if (btn) btn.onclick = () => save(r, row, btn);
            });
        }

        async function save(r, row, btn) {
            const values = Object.create(null);
            row.querySelectorAll('[data-value]').forEach((x) => { values[x.dataset.value] = x.value; });
            const out = row.querySelector('[data-result]');
            btn.disabled = true;
            try {
                if (r.info.host) {
                    await saveHost(r.info, values);   // the host restarts the server when its settings change
                    out.innerHTML = `<span style="color:#166534;">✓ ${t('savedHost')}</span>`;
                } else {
                    for (const f of r.info.fields) if (own(values, f.name) === undefined) values[f.name] = own(r.info.values, f.name) ?? f.default;
                    await saveLocal(r.info, values);
                    const start = typeof r.info.manifest?.start === 'string' ? r.info.manifest.start : '';
                    out.innerHTML = `<div style="color:#166534;">✓ ${t('savedLocal')}</div>${start ? UI.commandBlockHtml(tp, tp('startCommand'), start) : ''}`;
                    UI.wireCopyButtons(out, tPlain);
                }
                const fresh = r.info.host ? await readHostInfo(r.info.folder, r.info) : r.info;
                r.info = fresh;
                row.querySelector('summary').innerHTML = `<strong>${esc(r.name)}</strong> <span style="color:#64748b;font-size:12px;">mcps/${esc(fresh.folder)}</span> — ${status(fresh)}`;
            } catch (e) {
                out.innerHTML = `<span style="color:#b91c1c;">${t('saveFailed', { error: (e && e.message) || String(e) })}</span>`;
            } finally {
                btn.disabled = false;
            }
        }

        return { refresh(next) { names = [...new Set(next || [])]; return render(); } };
    }

    window.McpServerSettings = { readText, writeText, folderGranted, readServerMap, readLocalInfo, readHostInfo,
        saveLocal, saveHost, checkTargets, readAll, findMissing, sectionMissing, runGate, mountServerSettings };
})();
