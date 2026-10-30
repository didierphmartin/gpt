/**
 * Workflow package import: the review screen, the install and the result panel
 * (docs/superpowers/specs/2026-10-30-workflow-package-design.md, "Import flow").
 *
 * importPackage(editor, file, overrides) / importPackageBytes(editor, bytes, overrides):
 *   0. the user's folder (explain + picker; cancel stops before anything is written),
 *   1. read the package and what this install already has,
 *   2. the review dialog (one card per dependency),
 *   3. Confirm -> WorkflowPackage.installPackage, then the workflow goes on the canvas (unsaved),
 *   4. the result panel (what was installed, where, and each local server's install / start commands).
 * overrides (console tests): { io: {...partial io}, have: {...partial have}, skipFolder: true }.
 * Resolves once the review dialog is shown, with { pkg, rows, values, have } (or undefined when stopped).
 *
 * Depends on: window.WorkflowPackage, window.WorkflowPackageUI (workflow-package-ui.js), window.localFs,
 * window.skillsImport.readFolderFiles, window.mcpClient, window.PlaybookCollection, window.CodeComponents,
 * window.fflate.
 */
(function () {
    'use strict';

    const WP = () => window.WorkflowPackage;
    const UI = window.WorkflowPackageUI;
    const esc = UI.esc;
    const MODAL_ID = 'workflow-package-import-modal';
    const BTN = 'padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;';
    const BTN_PLAIN = `${BTN} background: #fff; border: 1px solid #cbd5e1;`;
    const BTN_ON = `${BTN} background: #eff6ff; border: 1px solid #2563eb; color: #1d4ed8; font-weight: 600;`;
    const INPUT = 'padding: 5px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; min-width: 0; flex: 1;';
    const SKILL_RE = /^skills\/.+\/SKILL\.md$/;   // the same skill folders reviewRows sees

    /** The io installPackage writes through: the user's folder, the server list, playbooks, components. */
    function defaultIo(editor) {
        const fs = () => window.localFs;
        const fileHandle = async (path, create) => fs().resolvePath(path, { create, kind: 'file' });
        const writeFile = async (path, bytes) => {
            const fh = await fileHandle(path, true);
            if (!fh) throw new Error(`cannot write ${path}`);
            const w = await fh.createWritable();
            await w.write(bytes);
            await w.close();
        };
        return {
            async exists(path) {
                return !!(await fileHandle(path, false)) || !!(await fs().resolvePath(path, { kind: 'directory' }));
            },
            async ensureDir(path) {
                if (!(await fs().resolvePath(path, { create: true, kind: 'directory' }))) throw new Error(`cannot create ${path}`);
            },
            writeFile,
            async readJson(path) {
                const fh = await fileHandle(path, false);
                if (!fh) return undefined;
                return JSON.parse(await (await fh.getFile()).text());
            },
            writeJson: (path, obj) => writeFile(path, new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n')),
            async addServer(reg) {
                const res = await window.mcpClient.addServer(reg.name, reg.url, reg.description, reg.headers, reg.transport, reg.is_mock);
                if (!res || !res.success) throw new Error((res && res.error) || 'the server could not be registered');
                return { id: res.server_id };
            },
            async createPlaybook(row) {
                const res = await editor._playbookApi().create(row);
                const created = (res && res.data) || res;
                if (created && created.id !== undefined) window.PlaybookCollection.cache.put(created);
                return { id: created.id };
            },
            importComponents: (bundle, nodes) => editor._importCodeComponents(bundle, nodes),
        };
    }

    /** What this install already has, in reviewRows' shape. Keys given in `given` are not loaded. */
    async function loadHave(editor, pkg, given = {}) {
        const have = { ...given };
        if (!have.servers) {
            const mc = window.mcpClient;
            const res = mc ? await mc.request(`/mcp/servers?user_id=${encodeURIComponent(mc.getUserId())}&include_disabled=1`) : null;
            have.servers = (res && res.servers) || [];
        }
        if (!have.playbooks) {
            const PC = window.PlaybookCollection;
            if (PC) await PC.cache.load(editor._playbookApi());
            have.playbooks = PC ? PC.cache.all() : [];
        }
        if (!have.components) {
            const CC = window.CodeComponents;
            if (CC) await CC.cache.load(CC.api());
            have.components = CC ? CC.cache.all() : [];
        }
        if (!have.skills) {
            have.skills = [];
            const dirs = Object.keys(pkg.files || {}).filter((p) => SKILL_RE.test(p)).map((p) => p.slice(7, -9));
            for (const dir of dirs) {
                const handle = window.localFs && await window.localFs.resolvePath(`skills/${dir}`);
                // Bare relative paths with the skill export's filter: the same convention reviewRows hashes.
                if (handle) have.skills.push({ dir, hash: await WP().filesHash(await window.skillsImport.readFolderFiles(handle, '')) });
            }
        }
        return have;
    }

    const STATUS_ICON = { present: '✓', install: '➕', clash: '⚠', attention: '⚠' };
    const REASON_KEY = {
        'settings-required': 'reasonSettings', 'localhost-url': 'reasonLocalhost', 'needs-key': 'reasonNeedsKey',
        'global-server': 'reasonGlobal', renamed: 'reasonRenamed', unreadable: 'reasonUnreadable',
    };
    const KIND_KEY = { skill: 'kindSkill', server: 'kindServer', component: 'kindComponent', playbook: 'kindPlaybook', secrets: 'kindKeys' };

    /** A masked input with a show/hide toggle. */
    function secretInput(t, attrs, value) {
        return `<span style="display: flex; gap: 6px; flex: 1;">
            <input type="password" ${attrs} value="${esc(value)}" autocomplete="off" style="${INPUT}">
            <button type="button" data-toggle-secret style="${BTN_PLAIN} padding: 4px 10px;">${t('show')}</button></span>`;
    }

    function fieldRow(label, required, control, help, requiredTitle) {
        return `<label style="display: flex; flex-direction: column; gap: 3px; font-size: 13px;">
            <span>${label}${required ? ` <span style="color: #dc2626;" title="${requiredTitle || ''}">*</span>` : ''}</span>
            <span style="display: flex; gap: 6px;">${control}</span>
            ${help ? `<span style="color: #64748b; font-size: 12px;">${help}</span>` : ''}</label>`;
    }

    function cardHtml(editor, state, r, i) {
        const t = (key, params) => esc(editor.t(`workflow.package.${key}`, params));
        const v = state.values[r.name] || {};
        const skipped = r.choice === 'skip';
        const live = !skipped && r.choice !== 'use-existing' && r.status !== 'present';   // will be installed
        const warn = r.status === 'clash' || r.status === 'attention';
        let status;
        if (skipped) status = t('statusSkipped');
        else if (r.choice === 'use-existing') status = t('statusUseExisting');
        else if (r.status === 'present') status = t('statusPresent');
        else if (r.status === 'clash') status = t('statusClash', { name: r.name });
        else if (r.kind === 'secrets') status = t('statusKeys');
        else status = r.destination ? t('statusInstallTo', { destination: r.destination }) : t('statusInstall');
        const reasons = (r.reasons || []).filter((x) => REASON_KEY[x]);
        const parts = [];
        if (reasons.length && !skipped) {
            parts.push(`<ul style="margin: 0 0 0 18px; color: #92400e; font-size: 13px;">${reasons.map((x) => `<li>${t(REASON_KEY[x])}</li>`).join('')}</ul>`);
        }
        if (r.status === 'clash') {
            parts.push(`<div style="display: flex; gap: 8px;">
                <button type="button" data-choice="use-existing" style="${r.choice === 'use-existing' ? BTN_ON : BTN_PLAIN}">${t('useExisting')}</button>
                <button type="button" data-choice="skip" style="${skipped ? BTN_ON : BTN_PLAIN}">${t('skipIt')}</button></div>`);
        } else if ((r.reasons || []).includes('unreadable')) {
            parts.push(`<div><button type="button" data-choice="skip" style="${skipped ? BTN_ON : BTN_PLAIN}">${t('skipIt')}</button></div>`);
        }
        if (live && r.kind === 'server') {
            if (r.url !== undefined) {
                parts.push(fieldRow(t('serverUrl'), false, `<input type="text" data-value="url" value="${esc(v.url !== undefined ? v.url : r.url)}" style="${INPUT}">`, t('serverUrlHelp')));
            }
            if ((r.reasons || []).includes('needs-key')) {
                parts.push(fieldRow(t('authorization'), false, secretInput(t, 'data-value="authorization"', v.authorization || ''), t('authorizationHelp')));
            }
            if (r.envFields) {
                const form = r.envFields.map((f) => fieldRow(esc(f.name), f.required,
                    f.secret ? secretInput(t, `data-value="${esc(f.name)}"`, v[f.name] || '')
                        : `<input type="text" data-value="${esc(f.name)}" value="${esc(v[f.name] || '')}" style="${INPUT}">`,
                    esc(f.label), t('required'))).join('');
                parts.push(`<div style="border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
                    <strong style="font-size: 13px;">${t('settingsTitle')}</strong>${form}
                    <label style="font-size: 13px;"><input type="checkbox" data-fill-later ${v.fillLater ? 'checked' : ''}> ${t('fillLater')}</label></div>`);
            }
        }
        if (r.kind === 'secrets') {
            const nodes = (state.pkg.workflow && state.pkg.workflow.definition && state.pkg.workflow.definition.nodes) || [];
            const keys = state.values['workflow keys'];
            parts.push(`<div style="color: #475569; font-size: 13px;">${t('workflowKeysHelp')}</div>` + (r.fields || []).map((f) => {
                const n = nodes.find((x) => String(x.id) === String(f.node)) || {};
                const label = `${esc(n.name || n.label || (n.config && n.config.name) || n.node_type || f.node)} — ${esc(f.field)}`;
                return fieldRow(label, false, secretInput(t, `data-key="${esc(`${f.node}.${f.field}`)}"`, keys[`${f.node}.${f.field}`] || ''), '');
            }).join(''));
        }
        const border = warn && !skipped && r.choice !== 'use-existing' ? '#f59e0b' : '#e2e8f0';
        const title = r.kind === 'secrets' ? t('kindKeys') : `${t(KIND_KEY[r.kind])}: ${esc(r.name)}`;
        return `<div data-row="${i}" style="border: 1px solid ${border}; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; ${skipped ? 'opacity: 0.6;' : ''}">
            <div style="display: flex; gap: 8px; align-items: baseline;">
                <span style="font-size: 15px;">${skipped ? '–' : STATUS_ICON[r.status] || ''}</span>
                <div style="flex: 1;"><strong>${title}</strong><div style="color: #475569; font-size: 13px;">${status}</div></div>
            </div>${parts.join('')}</div>`;
    }

    /** "Installed" list items; a local server's files + registration are one line. */
    function installedHtml(editor, installed) {
        const t = (key, params) => esc(editor.t(`workflow.package.${key}`, params));
        const registered = new Set(installed.filter((x) => x.kind === 'server').map((x) => x.name));
        return `<ul style="margin: 6px 0 0 18px;">${installed
            .filter((x) => !(x.kind === 'server-files' && registered.has(x.name)))
            .map((x) => {
                const kind = x.kind === 'server-files' ? t('kindServerFiles') : t(KIND_KEY[x.kind] || 'kindComponent');
                const where = x.destination ? ` → <code>${esc(x.destination)}</code>` : ` — ${t('registeredOnly')}`;
                return `<li>${kind}: ${esc(x.name)}${where}</li>`;
            }).join('')}</ul>`;
    }

    function resultHtml(editor, state, result) {
        const t = (key, params) => esc(editor.t(`workflow.package.${key}`, params));
        const box = 'border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;';
        let html = `<div style="${box} border-color: #16a34a; background: #f0fdf4;"><strong>✓ ${t('resultDone')}</strong>
            ${result.installed.length ? installedHtml(editor, result.installed) : `<div style="margin-top: 6px;">${t('resultNothing')}</div>`}</div>`;
        const later = state.rows.filter((r) => r.envFields && (state.values[r.name] || {}).fillLater && r.choice !== 'skip' && r.choice !== 'use-existing');
        if (later.length) {
            html += `<div style="${box} border-color: #f59e0b; background: #fffbeb;">⚠ ${t('resultFillLater', { names: later.map((r) => r.name).join(', ') })}</div>`;
        }
        const cmds = result.commands.filter((c) => c.install || c.start);
        if (cmds.length) {
            const block = (label, cmd) => (cmd ? `<div style="font-size: 13px; color: #475569;">${label}</div>
                <div style="display: flex; gap: 6px; align-items: flex-start;"><pre style="flex: 1; margin: 0; padding: 6px 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; white-space: pre-wrap; word-break: break-all; font-size: 12px;">${esc(cmd)}</pre>
                <button type="button" data-copy="${esc(cmd)}" style="${BTN_PLAIN} padding: 4px 10px;">${t('copy')}</button></div>` : '');
            html += `<div style="${box} display: flex; flex-direction: column; gap: 6px;"><strong>${t('commandsTitle')}</strong>
                <div style="color: #475569; font-size: 13px;">${t('commandsHelp')}</div>
                ${cmds.map((c) => {
                    const row = state.rows.find((r) => r.kind === 'server' && r.name === c.server);
                    return `<div style="display: flex; flex-direction: column; gap: 4px; margin-top: 6px;"><strong style="font-size: 13px;">${esc(c.server)}${row && row.destination ? ` — <code>${esc(row.destination)}</code>` : ''}</strong>
                        ${block(t('installCommand'), c.install)}${block(t('startCommand'), c.start)}</div>`;
                }).join('')}</div>`;
        }
        return html;
    }

    /** The review dialog; Confirm installs, puts the workflow on the canvas and shows the result. */
    function showReview(editor, state, io) {
        const t = (key, params) => editor.t(`workflow.package.${key}`, params);
        const notify = (msg, type) => (editor.showNotification ? editor.showNotification(msg, type) : console.log(msg));
        document.getElementById(MODAL_ID)?.remove();
        const name = (state.pkg.manifest.workflow && state.pkg.manifest.workflow.name) || state.pkg.workflow.name || '';
        document.body.insertAdjacentHTML('beforeend', `
            <div id="${MODAL_ID}" class="workflow-results-overlay">
                <div class="workflow-results-container" style="max-width: 680px; max-height: 85vh; display: flex; flex-direction: column;">
                    <div class="workflow-results-header">
                        <h2 style="margin: 0;">📦 ${esc(t('reviewTitle'))} — ${esc(name)}</h2>
                        <button class="workflow-results-close" data-import-close>×</button>
                    </div>
                    <div class="workflow-results-body" style="padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 10px;">
                        <div data-import-rows style="display: flex; flex-direction: column; gap: 10px;"></div>
                        <div data-import-error style="display: none; border: 1px solid #dc2626; background: #fef2f2; border-radius: 8px; padding: 10px 12px; font-size: 13px;"></div>
                        <div data-import-actions style="display: flex; gap: 8px; justify-content: flex-end; align-items: center;">
                            <span data-import-status style="color: #64748b; font-size: 13px; margin-right: auto;"></span>
                            <button data-import-close style="${BTN_PLAIN}">${esc(t('cancel'))}</button>
                            <button data-import-confirm style="${BTN} background: #16a34a; color: #fff; border: 1px solid #15803d;">${esc(t('confirm'))}</button>
                        </div>
                    </div>
                </div>
            </div>`);
        const modal = document.getElementById(MODAL_ID);
        const list = modal.querySelector('[data-import-rows]');
        const confirm = modal.querySelector('[data-import-confirm]');
        const statusEl = modal.querySelector('[data-import-status]');
        const errorEl = modal.querySelector('[data-import-error]');
        let busy = false, locked = false;
        const refresh = () => {
            const ok = !busy && !locked && WP().canConfirm(state.rows, state.values);
            confirm.disabled = !ok;
            confirm.style.opacity = ok ? '1' : '0.5';
            confirm.style.cursor = ok ? 'pointer' : 'not-allowed';
            statusEl.textContent = busy ? t('installing') : (!ok && !locked ? t('blocked') : '');
        };
        const render = () => {
            list.innerHTML = state.rows.length ? state.rows.map((r, i) => cardHtml(editor, state, r, i)).join('') : `<div>${esc(t('nothingToInstall'))}</div>`;
            refresh();
        };
        modal.querySelectorAll('[data-import-close]').forEach((b) => { b.onclick = () => modal.remove(); });

        list.addEventListener('click', (e) => {
            const toggle = e.target.closest('[data-toggle-secret]');
            if (toggle) {
                const input = toggle.parentElement.querySelector('input');
                const hidden = input.type === 'password';
                input.type = hidden ? 'text' : 'password';
                toggle.textContent = t(hidden ? 'hide' : 'show');
                return;
            }
            const btn = e.target.closest('[data-choice]');
            if (!btn || busy || locked) return;
            const r = state.rows[Number(btn.closest('[data-row]').dataset.row)];
            r.choice = r.choice === btn.dataset.choice ? null : btn.dataset.choice;   // a second click undoes
            render();
        });
        list.addEventListener('input', (e) => {
            const card = e.target.closest('[data-row]');
            if (!card) return;
            const r = state.rows[Number(card.dataset.row)];
            if (e.target.dataset.key !== undefined) state.values['workflow keys'][e.target.dataset.key] = e.target.value;
            else if (e.target.dataset.value !== undefined) (state.values[r.name] = state.values[r.name] || {})[e.target.dataset.value] = e.target.value;
            refresh();
        });
        list.addEventListener('change', (e) => {
            if (e.target.dataset.fillLater === undefined) return;
            const r = state.rows[Number(e.target.closest('[data-row]').dataset.row)];
            (state.values[r.name] = state.values[r.name] || {}).fillLater = e.target.checked;
            render();
        });

        confirm.onclick = async () => {
            if (busy || locked || !WP().canConfirm(state.rows, state.values)) return;
            busy = true; errorEl.style.display = 'none'; refresh();
            let result;
            try {
                result = await WP().installPackage(state.rows, state.pkg, state.values, io, state.have);
            } catch (err) {
                console.error('[workflow-package] install failed:', err);
                busy = false;
                // A partial install can't simply be retried (its folders now exist): Confirm stays off.
                if (err.installed) locked = true;
                errorEl.innerHTML = `<strong>${esc(t('installFailed'))}</strong><div style="margin-top: 4px;">${esc(err.message)}</div>`
                    + (err.installed && err.installed.length ? `<div style="margin-top: 6px;">${esc(t('alreadyInstalled'))}</div>${installedHtml(editor, err.installed)}` : '');
                errorEl.style.display = 'block';
                refresh();
                return;
            }
            // installPackage already imported / re-linked the components: no code_components here.
            const { code_components: _skip, ...workflow } = state.pkg.workflow;
            try {
                await editor._applyImportedWorkflow({ ...workflow, definition: { ...(workflow.definition || {}), nodes: result.nodes } });
            } catch (err) {
                console.error('[workflow-package] canvas update failed:', err);
                notify(t('canvasFailed', { error: err.message }), 'error');
            }
            busy = false; locked = true;
            list.innerHTML = resultHtml(editor, state, result);
            modal.querySelector('h2').textContent = `📦 ${t('resultTitle')} — ${name}`;
            const actions = modal.querySelector('[data-import-actions]');
            actions.innerHTML = `<button data-import-close style="${BTN} background: #2563eb; color: #fff; border: 1px solid #1d4ed8;">${esc(t('close'))}</button>`;
            actions.querySelector('[data-import-close]').onclick = () => modal.remove();
            list.querySelectorAll('[data-copy]').forEach((b) => {
                b.onclick = async () => {
                    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = t('copied'); } catch (_) { b.textContent = t('copyFailed'); }
                };
            });
            state.result = result;
        };
        render();
        return modal;
    }

    /** Import a package from its zip bytes. */
    async function importPackageBytes(editor, bytes, overrides = {}) {
        const t = (key, params) => editor.t(`workflow.package.${key}`, params);
        const notify = (msg, type) => (editor.showNotification ? editor.showNotification(msg, type) : console.log(msg));
        let pkg;
        try {
            pkg = WP().readPackage(window.fflate.unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
            if (!pkg.workflow || !pkg.workflow.definition) throw new Error('not a workflow package');
        } catch (err) {
            console.error('[workflow-package] import failed:', err);
            notify(t('importFailed', { error: err.message }), 'error');
            return undefined;
        }
        // Step 0: the user's folder, before anything is read from or written to it.
        if (!overrides.skipFolder) {
            const ok = await UI.askFolderAccess(editor, { textKey: 'needFolder', skipKey: 'cancel' });
            if (!ok) { notify(t('importStopped'), 'warning'); return undefined; }
        }
        let have;
        try {
            have = await loadHave(editor, pkg, overrides.have || {});
        } catch (err) {
            console.error('[workflow-package] import failed:', err);
            notify(t('importFailed', { error: err.message }), 'error');
            return undefined;
        }
        const rows = await WP().reviewRows(pkg, have);
        const values = { 'workflow keys': {} };
        // Defaults count as filled in: installPackage would write them anyway.
        for (const r of rows) {
            if (r.envFields) values[r.name] = Object.fromEntries(r.envFields.filter((f) => f.default !== '').map((f) => [f.name, f.default]));
        }
        const io = { ...defaultIo(editor), ...(overrides.io || {}) };
        const state = { pkg, rows, values, have };
        showReview(editor, state, io);
        return state;
    }

    /** The Import button's .zip path. */
    async function importPackage(editor, file, overrides = {}) {
        return importPackageBytes(editor, new Uint8Array(await file.arrayBuffer()), overrides);
    }

    Object.assign(window.WorkflowPackageUI, { importPackage, importPackageBytes, loadImportHave: loadHave, importIo: defaultIo });
})();
