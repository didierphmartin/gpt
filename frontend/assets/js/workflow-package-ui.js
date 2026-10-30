/**
 * Workflow package export: the workflow plus its skills, MCP servers, code components and
 * playbooks as one .zip (layout: docs/superpowers/specs/2026-10-30-workflow-package-design.md).
 *
 * buildPackageBytes(editor, opts) collects and zips without any dialog (testable from the console);
 * exportPackage(editor) opens its window at once (preparing), then the summary, then the system save dialog.
 *
 * Depends on: window.WorkflowPackage, window.skillsImport.readFolderFiles, window.localFs,
 * window.mcpClient, window.PlaybookCollection, window.fflate.
 */
(function () {
    'use strict';

    const WP = () => window.WorkflowPackage;
    const encode = (obj) => new TextEncoder().encode(JSON.stringify(obj, null, 2));
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const zip = (files) => new Promise((resolve, reject) => {
        window.fflate.zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
    });

    /** Registered servers (own + global, disabled too) and tool name -> server names, from the raw lists. */
    async function loadServers() {
        const mc = window.mcpClient;
        if (!mc) return { servers: [], toolServers: new Map() };
        const uid = encodeURIComponent(mc.getUserId());
        const [srv, tools] = await Promise.all([
            mc.request(`/mcp/servers?user_id=${uid}&include_disabled=1`),
            mc.request(`/mcp/servers/all-tools?user_id=${uid}`),
        ]);
        const toolServers = new Map();
        for (const t of (tools && tools.tools) || []) {
            const list = toolServers.get(t.tool_name) || [];
            if (!list.includes(t.server_name)) list.push(t.server_name);
            toolServers.set(t.tool_name, list);
        }
        return { servers: (srv && srv.servers) || [], toolServers };
    }

    async function readJsonFile(path) {
        const fh = window.localFs && await window.localFs.resolvePath(path, { kind: 'file' });
        if (!fh) return undefined;   // no such file
        return JSON.parse(await (await fh.getFile()).text());
    }

    /** A local server's filtered source as { "mcps/<folder>/<path>": bytes } and its install manifest. */
    async function readServerSource(folder) {
        const dir = window.localFs && await window.localFs.resolvePath(`mcps/${folder}`);
        if (!dir) return null;
        let manifest = null;
        try { manifest = (await readJsonFile(`mcps/${folder}/synergyai-mcp.json`)) || null; } catch (_) { manifest = null; }
        const dirExclude = { exclude: (manifest && manifest.exclude) || [] };
        const keep = (entry, path) => (entry.kind === 'directory'
            // a folder is entered unless the default / manifest excludes rule out everything in it
            ? WP().selectServerFiles([`${path}/__probe__`], dirExclude).length === 1
            : path === 'synergyai-mcp.json' || WP().selectServerFiles([path], manifest).length === 1);
        const files = await window.skillsImport.readFolderFiles(dir, `mcps/${folder}`, (entry, path) =>
            keep(entry, path.slice(`mcps/${folder}/`.length)));
        return { files, manifest };
    }

    /** True when the user's folder is granted (readable now). */
    async function folderReadable() {
        try { return !!window.localFs && (await window.localFs.getStatus()).state === 'granted'; } catch (_) { return false; }
    }

    /**
     * Folder not readable: explain, then ask for it (re-grant a lapsed permission, else pick the folder).
     * opts.textKey / opts.skipKey: the explanation and the skip button's i18n keys (default: export's).
     * Resolves true when the folder is readable afterwards, false when skipped, refused or unsupported.
     * The export goes on either way (the summary then warns); the import stops on false.
     */
    async function askFolderAccess(editor, opts = {}) {
        if (!window.localFs) return false;
        if (await folderReadable()) return true;
        let status = { state: 'unsupported' };
        try { status = await window.localFs.getStatus(); } catch (_) { /* unsupported */ }
        if (status.state === 'unsupported') return false;
        const t = (key) => esc(editor.t(`workflow.package.${key}`));
        const textKey = opts.textKey || 'needFolderExport', skipKey = opts.skipKey || 'folderSkip';
        let picked = false;
        await new Promise((resolve) => {
            document.body.insertAdjacentHTML('beforeend', `
                <div id="workflow-package-folder-modal" class="workflow-results-overlay">
                    <div class="workflow-results-container" style="max-width: 520px;">
                        <div class="workflow-results-header"><h2 style="margin: 0;">📁 ${t('folderTitle')}</h2></div>
                        <div class="workflow-results-body" style="padding: 16px; display: flex; flex-direction: column; gap: 12px;">
                            <div>${t(textKey)}</div>
                            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                                <button data-folder-skip style="padding: 6px 14px; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; cursor: pointer; font-size: 13px;">${t(skipKey)}</button>
                                <button data-folder-pick style="padding: 6px 14px; background: #2563eb; color: #fff; border: 1px solid #1d4ed8; border-radius: 6px; cursor: pointer; font-size: 13px;">${t('folderPick')}</button>
                            </div>
                        </div>
                    </div>
                </div>`);
            const modal = document.getElementById('workflow-package-folder-modal');
            const done = () => { modal.remove(); resolve(); };
            modal.querySelector('[data-folder-skip]').onclick = done;
            modal.querySelector('[data-folder-pick]').onclick = async () => {
                // This click is the user gesture the permission prompt / folder picker needs.
                try {
                    const res = status.handle ? await window.localFs.regrantAccess() : null;
                    if (!res || !res.ok) await window.localFs.requestRootAccess('synergyAI');
                } catch (e) { console.warn('[workflow-package] folder access:', e); }
                picked = true;
                done();
            };
        });
        return picked && folderReadable();
    }

    /**
     * Collect the dependencies of the workflow on the canvas and zip them.
     * opts.playbookIds: extra playbooks to bundle (the workflow picks its playbook at run time).
     * Returns { bytes, summary }.
     */
    async function buildPackageBytes(editor, opts = {}) {
        if (!window.fflate || typeof window.fflate.zip !== 'function') throw new Error('Zip library (fflate) is not loaded.');
        const t = (key, params) => editor.t(`workflow.package.${key}`, params);
        const { payload, stripped, codeComponents, workflow } = await editor._buildWorkflowPayload();
        const { servers: registered, toolServers } = await loadServers();
        const serverNameById = new Map(registered.map((s) => [Number(s.id), s.name]));
        const deps = WP().collectDependencies(workflow.nodes, { toolServers, serverNameById });
        const warnings = [...deps.warnings];
        const warn = (kind, key, params) => warnings.push({ kind, message: t(key, params) });
        const files = { 'workflow.json': encode(payload) };
        // Skills and local server source are read from the user's folder: say so when it can't be read.
        const canRead = await folderReadable();
        if (!canRead) warn('folder-not-accessible', 'warnFolderNotAccessible');

        // Skills: each bound folder, with the skill export's filter.
        const skills = [];
        for (const dir of deps.skills) {
            if (!canRead) { warn('skill-unreadable', 'warnSkillUnreadable', { name: dir }); continue; }
            const handle = await window.localFs.resolvePath(`skills/${dir}`);
            if (!handle) { warn('skill-missing', 'warnSkillMissing', { name: dir }); continue; }
            Object.assign(files, await window.skillsImport.readFolderFiles(handle, `skills/${dir}`));
            skills.push(dir);
        }

        // MCP servers: every registration; a local one's source too (named in mcps/servers.json).
        let localMap = {};
        if (canRead) try { localMap = (await readJsonFile('mcps/servers.json')) || {}; } catch (_) { warn('servers-map', 'warnServersMap'); }
        const uid = String(window.mcpClient?.getUserId?.() ?? '');
        const servers = [];
        for (const name of deps.servers) {
            const regs = registered.filter((s) => s.name === name);
            const reg = regs.find((s) => String(s.user_id) === uid) || regs[0];
            if (!reg) { warn('server-missing', 'warnServerMissing', { name }); continue; }
            const folder = Object.prototype.hasOwnProperty.call(localMap, name) ? localMap[name] : null;
            const source = folder ? await readServerSource(folder) : null;
            if (folder && !source) warn('folder-unreadable', 'warnFolderUnreadable', { name });
            if (source && !source.manifest) warn('no-install', 'warnNoInstall', { name });
            if (source) Object.assign(files, source.files);
            servers.push({ ...reg, local: !!source, folder, hasManifest: !!(source && source.manifest) });
        }

        // Code components: the ones _bundleCodeComponents found in the library.
        const foundIds = new Set(codeComponents.map((c) => Number(c.id)));
        deps.components.filter((id) => !foundIds.has(id)).forEach((id) => warn('component-missing', 'warnComponentMissing', { id }));

        // Playbooks: linked ones plus the ones ticked in the summary.
        const PC = window.PlaybookCollection;
        const pbIds = [...new Set([...deps.playbooks, ...(opts.playbookIds || []).map(Number)])];
        if (PC && pbIds.some((id) => !PC.cache.get(id))) await PC.cache.load(editor._playbookApi()).catch(() => {});
        const playbooks = [];
        for (const id of pbIds) {
            const row = PC && PC.cache.get(id);
            if (row) playbooks.push(row); else warn('playbook-missing', 'warnPlaybookMissing', { id });
        }

        const manifest = WP().buildManifest({
            workflowName: payload.name, deps: { warnings }, servers, components: codeComponents, playbooks, skills,
            strippedSecrets: stripped,
        });
        const entry = (kind, oldId) => manifest.dependencies.find((d) => d.kind === kind && d.old_id === Number(oldId));
        codeComponents.forEach((c) => { files[entry('component', c.id).file] = encode(c); });
        playbooks.forEach((p) => { files[entry('playbook', p.id).file] = new TextEncoder().encode(WP().playbookToMd(p)); });
        files['mcps/servers.json'] = encode(servers.map(WP().serverRegistration));
        files['manifest.json'] = encode(manifest);

        const bytes = await zip(files);
        const regs = servers.map(WP().serverRegistration);
        const summary = {
            name: payload.name,
            fileName: `${WP().safeFileName(payload.name)}.zip`,
            skills: skills.length,
            servers: servers.length,
            localServers: regs.filter((r) => r.local).length,
            hostedServers: regs.filter((r) => !r.local).length,
            needsKey: regs.filter((r) => r.needs_auth).length,
            components: codeComponents.length,
            playbooks: playbooks.length,
            playbookAtRunTime: deps.playbookAtRunTime,
            warnings,
            paths: Object.keys(files).sort(),
        };
        return { bytes, summary };
    }

    function summaryHtml(editor, s, choosable) {
        const t = (key, params) => esc(editor.t(`workflow.package.${key}`, params));
        const lines = [];
        if (s.skills) lines.push(t('countSkills', { count: s.skills }));
        if (s.servers) lines.push(t('countServers', { count: s.servers, local: s.localServers, hosted: s.hostedServers }));
        if (s.needsKey) lines.push(t('countNeedsKey', { count: s.needsKey }));
        if (s.components) lines.push(t('countComponents', { count: s.components }));
        if (s.playbooks) lines.push(t('countPlaybooks', { count: s.playbooks }));
        const box = 'border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;';
        let html = `<div style="${box}">${lines.length
            ? `<div>${t('needs')}</div><ul style="margin: 6px 0 0 18px;">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`
            : t('nothing')}</div>`;
        if (s.warnings.length) {
            html += `<div style="${box} border-color: #f59e0b; background: #fffbeb;"><strong>⚠ ${t('warnings')}</strong>
                <ul style="margin: 6px 0 0 18px;">${s.warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></div>`;
        }
        if (s.playbookAtRunTime) {
            html += `<div style="${box}"><div>${t('runTimePlaybook')}</div>${choosable.length
                ? choosable.map((p) => `<label style="display: block; margin-top: 4px;"><input type="checkbox" data-package-playbook="${esc(p.id)}"> ${esc(p.title || p.pkey)}</label>`).join('')
                : `<div style="color: #64748b;">${t('noPlaybooks')}</div>`}</div>`;
        }
        return html;
    }

    /** Write bytes to the picked file, or download them when the browser has no save dialog. */
    async function saveBytes(handle, bytes, fileName) {
        const blob = new Blob([bytes], { type: 'application/zip' });
        if (handle) {
            const w = await handle.createWritable();
            await w.write(blob);
            await w.close();
            return handle.name;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return fileName;
    }

    /**
     * Export: the window opens at once ("Preparing the package…") while the dependencies are collected
     * -- that takes seconds -- then shows the summary, then the save dialog.
     */
    async function exportPackage(editor) {
        const t = (key, params) => editor.t(`workflow.package.${key}`, params);
        const notify = (msg, type) => (editor.showNotification ? editor.showNotification(msg, type) : console.log(msg));
        document.getElementById('workflow-package-modal')?.remove();
        await askFolderAccess(editor);
        const title = esc(editor.currentWorkflowName || '');
        document.body.insertAdjacentHTML('beforeend', `
            <div id="workflow-package-modal" class="workflow-results-overlay">
                <div class="workflow-results-container" style="max-width: 640px; max-height: 85vh; display: flex; flex-direction: column;">
                    <div class="workflow-results-header">
                        <h2 style="margin: 0;">📦 ${esc(t('summaryTitle'))}${title ? ` — ${title}` : ''}</h2>
                        <button class="workflow-results-close" data-package-cancel>×</button>
                    </div>
                    <div class="workflow-results-body" data-package-body style="padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: flex; align-items: center; gap: 10px; color: #475569;">
                            <span class="spinner" style="width: 16px; height: 16px; border: 2px solid #cbd5e1; border-top-color: #2563eb; border-radius: 50%; display: inline-block; animation: spin-active 0.8s linear infinite;"></span>
                            ${esc(t('preparing'))}
                        </div>
                    </div>
                </div>
            </div>`);
        const modal = document.getElementById('workflow-package-modal');
        // The wait cursor until the summary shows: collecting takes seconds.
        const waiting = (on) => { document.body.style.cursor = on ? 'wait' : ''; modal.style.cursor = on ? 'wait' : ''; };
        waiting(true);
        let cancelled = false;
        modal.querySelectorAll('[data-package-cancel]').forEach((b) => { b.onclick = () => { cancelled = true; waiting(false); modal.remove(); }; });
        let built;
        try {
            built = await buildPackageBytes(editor, {});
        } catch (err) {
            waiting(false);
            console.error('[workflow-package] export failed:', err);
            modal.remove();
            if (!cancelled) notify(t('failed', { error: err.message }), 'error');
            return;
        }
        if (cancelled) return;
        const PC = window.PlaybookCollection;
        if (built.summary.playbookAtRunTime && PC) await PC.cache.load(editor._playbookApi()).catch(() => {});
        waiting(false);
        if (cancelled) return;
        const choosable = built.summary.playbookAtRunTime && PC ? PC.cache.all() : [];

        modal.querySelector('[data-package-body]').innerHTML = `
                        ${summaryHtml(editor, built.summary, choosable)}
                        <div style="display: flex; gap: 8px; justify-content: flex-end; align-items: center;">
                            <span data-package-status style="color: #dc2626; font-size: 13px; margin-right: auto;"></span>
                            <button data-package-cancel style="padding: 6px 14px; background: #fff; border: 1px solid #cbd5e1; border-radius: 6px; cursor: pointer; font-size: 13px;">${esc(t('cancel'))}</button>
                            <button data-package-save style="padding: 6px 14px; background: #16a34a; color: #fff; border: 1px solid #15803d; border-radius: 6px; cursor: pointer; font-size: 13px;">${esc(t('save'))}</button>
                        </div>`;
        const status = modal.querySelector('[data-package-status]');
        modal.querySelectorAll('[data-package-cancel]').forEach((b) => { b.onclick = () => modal.remove(); });
        modal.querySelector('[data-package-save]').onclick = async () => {
            let handle = null;
            // The save dialog opens first, while this click still counts as a user gesture.
            if (typeof window.showSaveFilePicker === 'function') {
                try {
                    handle = await window.showSaveFilePicker({
                        suggestedName: built.summary.fileName,
                        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
                    });
                } catch (e) {
                    if (e && e.name === 'AbortError') return;   // the user closed the dialog
                    status.textContent = t('failed', { error: e.message });
                    return;
                }
            }
            try {
                const ticked = [...modal.querySelectorAll('[data-package-playbook]:checked')].map((c) => Number(c.dataset.packagePlaybook));
                const { bytes } = ticked.length ? await buildPackageBytes(editor, { playbookIds: ticked }) : built;
                const savedAs = await saveBytes(handle, bytes, built.summary.fileName);
                modal.remove();
                notify(t('saved', { name: savedAs }), 'success');
            } catch (err) {
                console.error('[workflow-package] export failed:', err);
                status.textContent = t('failed', { error: err.message });
            }
        };
    }

    window.WorkflowPackageUI = { buildPackageBytes, exportPackage, askFolderAccess, folderReadable, loadServers, esc };
})();
