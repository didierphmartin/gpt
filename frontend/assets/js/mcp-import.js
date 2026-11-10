/**
 * Import an MCP server from a GitHub folder link (Docker app, server host).
 * window.mcpImport.open({onDone}) shows the modal; reviewState is the pure Install gate.
 * Depends on: window.mcpClient, window.McpHostInstall, window.WorkflowPackageUI, window.WorkflowPackage, window.i18n.
 */
(function () {
    'use strict';

    const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const BTN = 'padding: 6px 14px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; cursor: pointer; font-size: 13px;';
    const BTN_PRIMARY = 'padding: 6px 14px; border: 1px solid #2563eb; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; font-size: 13px;';
    const INPUT = 'width: 100%; padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; box-sizing: border-box;';

    /** Whether Install is allowed, and if not why: 'installed' (folder taken) or 'missing' (required setting empty). */
    function reviewState(fetched, installedFolders, values) {
        if ((installedFolders || []).includes(fetched.folder)) return { canInstall: false, reason: 'installed' };
        const missing = window.WorkflowPackage && window.WorkflowPackage.missingRequired
            ? window.WorkflowPackage.missingRequired(fetched.fields, values)
            : (fetched.fields || []).filter((f) => f.required && !String((values || {})[f.name] || '').trim());
        return missing.length ? { canInstall: false, reason: 'missing' } : { canInstall: true, reason: null };
    }

    function open({ onDone } = {}) {
        const t = (k, p) => (window.i18n ? window.i18n.t(`mcpLibrary.import.${k}`, p) : k);
        const pt = (k) => esc(window.i18n ? window.i18n.t(`workflow.package.${k}`) : k);
        const modal = document.createElement('div');
        modal.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10000; display: flex; align-items: center; justify-content: center;';
        modal.innerHTML = `<div style="background: #fff; border-radius: 12px; padding: 20px; width: 520px; max-width: 94vw; max-height: 88vh; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;">
            <h2 data-title style="margin: 0; font-size: 16px; font-weight: 600;">${esc(t('title'))}</h2><div data-body style="display: flex; flex-direction: column; gap: 10px;"></div></div>`;
        document.body.appendChild(modal);
        const body = modal.querySelector('[data-body]');
        const close = () => { modal.remove(); };
        modal.addEventListener('click', (e) => { if (e.target === modal && !installing) close(); });
        let url = '', busy = false, installing = false;

        function linkForm(error) {
            body.innerHTML = `<label style="font-size: 13px; display: flex; flex-direction: column; gap: 4px;">${esc(t('linkLabel'))}
                <input data-url type="text" value="${esc(url)}" placeholder="https://github.com/owner/repo/tree/main/server" style="${INPUT}"></label>
                <div style="font-size: 12px; color: #64748b;">${esc(t('linkHint'))}</div>
                ${error ? `<div data-error style="font-size: 12px; color: #b91c1c;">${esc(error)}</div>` : ''}
                <div style="display: flex; justify-content: flex-end; gap: 8px;">
                    <button type="button" data-cancel style="${BTN}">${esc(t('cancel'))}</button>
                    <button type="button" data-fetch style="${BTN_PRIMARY}">${esc(t('fetch'))}</button></div>`;
            const input = body.querySelector('[data-url]');
            input.focus();
            body.querySelector('[data-cancel]').onclick = close;
            const go = async () => {
                url = input.value.trim();
                if (!url || busy) return;
                busy = true;
                body.querySelector('[data-fetch]').disabled = true;
                body.querySelector('[data-fetch]').textContent = '…';
                try {
                    const [fetched, rows] = await Promise.all([window.mcpClient.hostFetch(url), window.mcpClient.hostServers().catch(() => [])]);
                    review(fetched, rows.map((r) => r.folder));
                } catch (e) { linkForm((e && e.message) || String(e)); } finally { busy = false; }
            };
            body.querySelector('[data-fetch]').onclick = go;
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        }

        function review(fetched, installed) {
            const m = fetched.manifest || {};
            const s = fetched.source || {};
            const fields = fetched.fields || [];
            const runtime = m.runtime === 'php' ? t('runtimePhp') : t('runtimePython');
            const from = t('from', { source: `${s.owner}/${s.repo} @ ${String(s.sha || '').slice(0, 7)}` });
            body.innerHTML = `<div style="font-weight: 600;">${esc(m.name || fetched.folder)}</div>
                <div style="font-size: 13px; color: #475569;">${esc(m.description || '')}</div>
                <div style="font-size: 12px; color: #64748b;">${esc(runtime)} · ${esc(fetched.folder)} · ${esc(from)}</div>
                <div data-fields style="display: flex; flex-direction: column; gap: 8px;">${window.WorkflowPackageUI.settingsFieldsHtml(pt, fields, {})}</div>
                <div data-reason style="font-size: 12px; color: #b45309;"></div>
                <div style="display: flex; justify-content: flex-end; gap: 8px;">
                    <button type="button" data-cancel style="${BTN}">${esc(t('cancel'))}</button>
                    <button type="button" data-install style="${BTN_PRIMARY}">${esc(t('install'))}</button></div>`;
            const values = () => {
                const v = {};
                body.querySelectorAll('[data-value]').forEach((i) => { v[i.dataset.value] = i.value; });
                return v;
            };
            const refresh = () => {
                const st = reviewState(fetched, installed, values());
                const btn = body.querySelector('[data-install]');
                btn.disabled = !st.canInstall;
                btn.style.opacity = st.canInstall ? '1' : '0.5';
                body.querySelector('[data-reason]').textContent = st.reason === 'installed' ? t('installed') : st.reason === 'missing' ? t('missingRequired') : '';
            };
            body.oninput = refresh;
            body.onclick = (e) => {
                const tg = e.target.closest('[data-toggle-secret]');
                if (tg) window.WorkflowPackageUI.toggleSecret(tg, (k) => window.i18n.t(`workflow.package.${k}`));
            };
            refresh();
            body.querySelector('[data-cancel]').onclick = close;
            body.querySelector('[data-install]').onclick = () => install(fetched, values());
        }

        async function install(fetched, env) {
            installing = true;
            body.oninput = body.onclick = null;
            body.innerHTML = `<div style="display: flex; align-items: center; gap: 10px; font-size: 13px;">
                <span style="width: 16px; height: 16px; border: 2px solid #cbd5e1; border-top-color: #2563eb; border-radius: 50%; display: inline-block; animation: mcpimp-spin 1s linear infinite;"></span>
                <span>${esc(t('installing'))}</span></div><style>@keyframes mcpimp-spin { to { transform: rotate(360deg); } }</style>`;
            let res, err;
            try {
                const st = await window.mcpClient.hostStatus();
                res = await window.McpHostInstall.installAndRegister({ folder: fetched.folder, manifest: fetched.manifest, filesB64: fetched.files, env, source: fetched.source, gateway: st.gateway });
            } catch (e) { err = (e && e.message) || String(e); }
            installing = false;
            const ok = !err && res && res.state === 'running';
            const log = err || ((res && res.log) || []).slice(-20).join('\n');
            body.innerHTML = `<div style="font-size: 13px; ${ok ? 'color: #15803d;' : 'color: #b91c1c;'}">${esc(ok ? t('done') : t('failed'))}</div>
                ${!ok && log ? `<pre style="margin: 0; padding: 6px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; white-space: pre-wrap; font-size: 12px; max-height: 240px; overflow: auto;">${esc(log)}</pre>` : ''}
                <div style="display: flex; justify-content: flex-end;"><button type="button" data-close style="${BTN}">${esc(t('close'))}</button></div>`;
            body.querySelector('[data-close]').onclick = close;
            if (ok && typeof onDone === 'function') onDone();
        }

        linkForm();
    }

    window.mcpImport = { open, reviewState };
})();
