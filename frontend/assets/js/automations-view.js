/**
 * Automations: what one servicenow-automation-author prompt creates (the ServiceNow catalog item + flow, and the
 * SynergyAI playbook + workflow that fulfil it). This file holds
 *  - the pure helpers the chat client tools use (save_workflow / save_automation / install_automation in chat.js),
 *  - the /automations API client and the dev/test install (shared by chat.js and the view),
 *  - the sidebar view: each automation with its drift status and the buttons Check now / Install (dev/test).
 * Same lazy-init pattern as the Playbooks Library (chat.js switchView('automations')).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AutomationsView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const KEY_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
    const SCOPE_RE = /^[A-Za-z0-9_]{1,100}$/;
    // The connector's deploy allowlist (servicenow DeployToolset::allowedPath): package.json, now.config.json,
    // src/fluent/**.ts (src/fluent/generated/keys.ts included).
    const FLUENT_TS_RE = /^src\/fluent\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.ts$/;
    const TOOLS_BY_SKILL = {
        'playbook-author': ['save_playbook_agent'],
        'workflow-compile': ['save_workflow'],
        'servicenow-automation-author': ['save_playbook_agent', 'save_workflow', 'save_automation', 'install_automation'],
    };

    /** The paths the deploy accepts, in input order, deduplicated. */
    function deployFileList(paths) {
        const out = [];
        for (const p of Array.isArray(paths) ? paths : []) {
            if (typeof p !== 'string' || out.includes(p)) continue;
            if (p === 'package.json' || p === 'now.config.json' || (FLUENT_TS_RE.test(p) && !p.includes('..'))) out.push(p);
        }
        return out;
    }

    function instanceText(i) {
        const label = (i.server_name || `server ${i.mcp_server_id}`) + (i.environment ? ` (${i.environment})` : '');
        let s;
        if (i.status === 'in_sync') s = 'in sync' + (i.installed_version != null ? `, v${i.installed_version}` : '');
        else if (i.status === 'out_of_sync') s = 'out of sync' + (i.detail ? ` — ${i.detail}` : '');
        else if (i.status === 'not_installed') s = 'not installed';
        else s = String(i.status || 'unknown');
        return `${label}: ${s}`;
    }

    /** One line for an automation's instances (GET /automations or /check `instances`). */
    function driftSummary(instances) {
        const list = Array.isArray(instances) ? instances.filter(i => i && typeof i === 'object') : [];
        return list.length ? list.map(instanceText).join('; ') : 'not checked yet';
    }

    /** The browser-side client tools a skill turn sends (chat.js gating). */
    function clientToolNames(dirName) {
        return [...(TOOLS_BY_SKILL[dirName] || [])];
    }

    const positiveId = (v) => {
        const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
        return Number.isInteger(n) && n > 0 ? n : null;
    };

    /**
     * save_automation's request. A spec without ids creates the record or bumps an existing key's version (POST);
     * with playbook_id / workflow_id it links them (PUT; a spec given too replaces the stored one WITHOUT a bump), so
     * the skill's last save never bumps the version a second time. {error} when the input cannot be sent.
     */
    function saveAutomationPlan(input) {
        const i = input || {};
        const key = String(i.key || '').trim();
        const title = String(i.title || '').trim();
        if (!KEY_RE.test(key)) return { error: 'key must match ^[a-z0-9][a-z0-9-]{1,40}$ (the spec\'s name)' };
        if (!title) return { error: 'title is required' };
        let spec = i.spec;
        if (typeof spec === 'string') {
            try { spec = JSON.parse(spec); } catch (_) { return { error: 'spec is not valid JSON' }; }
        }
        if (spec != null && (typeof spec !== 'object' || Array.isArray(spec) || !Object.keys(spec).length)) {
            return { error: 'spec must be a non-empty object' };
        }
        const ids = {};
        for (const k of ['playbook_id', 'workflow_id']) {
            if (i[k] == null || i[k] === '') continue;
            const n = positiveId(i[k]);
            if (n === null) return { error: `${k} must be a positive integer` };
            ids[k] = n;
        }
        if (Object.keys(ids).length) return { method: 'PUT', body: { ...(spec ? { spec } : {}), ...ids } };
        if (!spec) return { error: 'save_automation needs the spec (first save) or playbook_id / workflow_id (linking)' };
        return { method: 'POST', body: { key, title, spec } };
    }

    /** An absolute /outputs/ path for a model-given path, or null (anything outside /outputs/, or with ..). */
    function outputsPath(path) {
        let p = String(path || '').trim();
        if (!p) return null;
        if (!p.startsWith('/')) p = '/outputs/' + p;
        if (!p.startsWith('/outputs/') || p.split('/').includes('..')) return null;
        return p;
    }

    function manualInstallMessage(scope) {
        return `install manually: sh build-install.sh in ~/Documents/synergyAI/outputs/servicenow/${scope}/`;
    }

    /** /api/v1/automations client. Throws Error {status, code, data} on a failed answer. */
    class AutomationApi {
        constructor(apiBase, getAuthHeaders) { this.base = apiBase; this.headers = getAuthHeaders; }
        async call(method, path, body) {
            const resp = await fetch(`${this.base}/automations${path}`, {
                method, credentials: 'include',
                headers: { ...this.headers(), 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const json = await resp.json().catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
            if (!json.success) {
                const e = new Error(json.error || `HTTP ${resp.status}`);
                e.status = resp.status; e.code = json.code; e.data = json.data;
                throw e;
            }
            return json.data;
        }
        list() { return this.call('GET', ''); }
        create(body) { return this.call('POST', '', body); }
        update(id, body) { return this.call('PUT', `/${id}`, body); }
        check(id) { return this.call('POST', `/${id}/check`); }
        install(id, body) { return this.call('POST', `/${id}/install`, body); }
    }

    /** {path: text} of the deployable files under /outputs/servicenow/<scope>/ (read through the Pyodide /outputs mount). */
    async function collectDeployFiles(scope) {
        const runner = (typeof window !== 'undefined') ? window.pyodideRunner : null;
        if (!runner?.listOutputFiles || !runner?.readOutputFile) throw new Error('the Python runtime is not available to read /outputs');
        const dir = `/outputs/servicenow/${scope}`;
        const files = {};
        for (const rel of deployFileList(await runner.listOutputFiles(dir))) {
            const text = await runner.readOutputFile(`${dir}/${rel}`);
            if (typeof text === 'string') files[rel] = text;
        }
        return files;
    }

    /**
     * Install the app of <scope> on a dev/test server, then check. {success, installed?, manual?, message, check?}.
     * A not_allowed answer (prod or unset SN_ENVIRONMENT) is not a failure: it says how to install by hand.
     */
    async function installAutomation(api, automationId, serverId, scope) {
        if (!SCOPE_RE.test(String(scope || ''))) return { success: false, error: 'scope must be the app scope from the flow: line (letters, digits, _)' };
        const files = await collectDeployFiles(scope);
        if (!files['package.json'] || !Object.keys(files).some(p => p.startsWith('src/fluent/'))) {
            return { success: false, error: `no deployable app found in /outputs/servicenow/${scope}/ (package.json and src/fluent/*.ts expected)`,
                manual: true, message: manualInstallMessage(scope) };
        }
        let installed;
        try {
            installed = await api.install(automationId, { server_id: serverId, scope, files });
        } catch (e) {
            if (e.code === 'not_allowed' || e.status === 409) return { success: true, installed: false, manual: true, message: manualInstallMessage(scope) };
            return { success: false, error: e.message, code: e.code || null, manual: true, message: manualInstallMessage(scope) };
        }
        let check = null;
        try { check = await api.check(automationId); } catch (e) { check = { error: e.message }; }
        return { success: true, installed: true, result: installed, files: Object.keys(files).length,
            check, drift: check?.instances ? driftSummary(withServerNames(check.instances, check.servers)) : null };
    }

    /** Instances with each server's name (from the same answer's `servers`). */
    function withServerNames(instances, servers) {
        const names = new Map((Array.isArray(servers) ? servers : []).map(s => [Number(s.id), s.name]));
        return (Array.isArray(instances) ? instances : []).map(i => ({ ...i, server_name: i.server_name || names.get(Number(i.mcp_server_id)) }));
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** The sidebar view (#automations-view): list, status, Check now, Install (dev/test). */
    class AutomationsLibrary {
        constructor(t) {
            this.t = typeof t === 'function' ? t : (k) => k;
            this.rows = [];
            this.busy = new Set();
            this.notes = {};   // automation id -> last action message
            const base = window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';
            this.api = new AutomationApi(base, () => window.chatApp?.getAuthHeaders?.() || {});
        }

        init() {
            this.tree = document.getElementById('automations-tree');
            this.statusLine = document.getElementById('automations-status');
            this.refreshBtn = document.getElementById('automations-refresh-btn');
            this.refreshBtn?.addEventListener('click', () => this.loadTree());
            this.tree?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-auto-action]');
                if (!btn || btn.disabled) return;
                const id = Number(btn.dataset.id);
                if (btn.dataset.autoAction === 'check') this.check(id);
                else if (btn.dataset.autoAction === 'install') this.install(id, Number(btn.dataset.server));
            });
        }

        status(msg) {
            if (!this.statusLine) return;
            this.statusLine.textContent = msg || '';
            this.statusLine.classList.toggle('hidden', !msg);
        }

        async loadTree() {
            this.status('');
            try {
                this.rows = await this.api.list() || [];
            } catch (e) {
                this.status(e.message);
                this.rows = [];
            }
            this.render();
        }

        devTestServers(row) {
            const env = new Map((row.instances || []).map(i => [Number(i.mcp_server_id), i.environment]));
            return (row.servers || []).filter(s => ['dev', 'test'].includes(s.environment || env.get(Number(s.id))));
        }

        render() {
            if (!this.tree) return;
            if (!this.rows.length) {
                this.tree.innerHTML = '<div class="text-center text-gray-400 text-xs py-6">No automations yet. Ask the servicenow-automation-author skill to create one.</div>';
                return;
            }
            this.tree.innerHTML = this.rows.map(r => {
                const busy = this.busy.has(r.id);
                const drift = driftSummary(withServerNames(r.instances, r.servers));
                const installs = r.sn_scope ? this.devTestServers(r).map(s =>
                    `<button type="button" data-auto-action="install" data-id="${r.id}" data-server="${s.id}" ${busy ? 'disabled' : ''}
                        class="text-xs px-2 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-50">Install (dev/test) → ${esc(s.name)}</button>`).join('') : '';
                const note = this.notes[r.id] ? `<div class="text-xs text-gray-700 mt-1">${esc(this.notes[r.id])}</div>` : '';
                return `<div class="bg-white rounded border border-gray-200 px-2 py-1.5 mb-2">
                    <div class="text-xs font-semibold text-gray-800">${esc(r.title)} <span class="text-gray-400 font-normal">${esc(r.key)} v${esc(r.version)}</span></div>
                    <div class="text-xs text-gray-500">${r.sn_scope ? `app ${esc(r.sn_scope)} · ` : ''}playbook ${r.playbook_id ? '#' + esc(r.playbook_id) : '—'} · workflow ${r.workflow_id ? '#' + esc(r.workflow_id) : '—'}</div>
                    <div class="text-xs text-gray-600 mt-1">${esc(drift)}</div>
                    <div class="flex flex-wrap gap-1 mt-1">
                        <button type="button" data-auto-action="check" data-id="${r.id}" ${busy ? 'disabled' : ''}
                            class="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50">${busy ? '…' : 'Check now'}</button>
                        ${installs}
                    </div>${note}</div>`;
            }).join('');
        }

        async check(id) {
            this.busy.add(id); this.render();
            try {
                const d = await this.api.check(id);
                const row = this.rows.find(r => r.id === id);
                if (row) { row.instances = d.instances; row.servers = d.servers; }
                this.notes[id] = 'Checked.';
            } catch (e) {
                this.notes[id] = e.message;
            } finally {
                this.busy.delete(id); this.render();
            }
        }

        async install(id, serverId) {
            const row = this.rows.find(r => r.id === id);
            if (!row?.sn_scope) return;
            this.busy.add(id); this.render();
            try {
                const r = await installAutomation(this.api, id, serverId, row.sn_scope);
                this.notes[id] = r.installed ? `Installed${r.drift ? ` — ${r.drift}` : ''}.` : (r.error ? `${r.error}. ${r.message || ''}` : r.message);
                if (r.check?.instances) { row.instances = r.check.instances; row.servers = r.check.servers; }
            } catch (e) {
                this.notes[id] = `${e.message}. ${manualInstallMessage(row.sn_scope)}`;
            } finally {
                this.busy.delete(id); this.render();
            }
        }
    }

    return { deployFileList, driftSummary, clientToolNames, saveAutomationPlan, outputsPath, manualInstallMessage,
        withServerNames, AutomationApi, collectDeployFiles, installAutomation, AutomationsLibrary };
});
