/**
 * MCP Servers Library
 *
 * Sidebar collection listing the caller's MCP servers (own + global), and
 * the overlay modal used to view/edit a server and to test its tools with
 * an MCPeek-style tool tester (mcp-tool-tester.js).
 *
 * Data access goes through window.mcpClient (mcp-client.js); nothing here
 * talks to the backend directly.
 */
class MCPLibrary {
    constructor(t) {
        this.t = typeof t === 'function' ? t : (k) => k;
        this.servers = [];
        this.collapsed = new Set();
        this.contextTarget = null;
        this.tester = null;
    }

    init() {
        this.treeContainer = document.getElementById('mcp-servers-tree');
        this.searchInput   = document.getElementById('mcp-servers-search');
        this.newBtn        = document.getElementById('mcp-servers-new-btn');
        this.masterToggle  = document.getElementById('mcp-servers-master-toggle');
        this.contextMenu   = document.getElementById('mcp-servers-context-menu');

        if (this.newBtn)      this.newBtn.addEventListener('click', () => this.openServerForm(null));
        if (this.searchInput) this.searchInput.addEventListener('input', () => this.renderTree());
        if (this.masterToggle) {
            this.masterToggle.addEventListener('change', async () => {
                const res = await window.mcpClient.setMcpMasterEnabled(this.masterToggle.checked);
                if (!res?.success) this.masterToggle.checked = !this.masterToggle.checked;
            });
        }
        if (this.contextMenu) {
            this.contextMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = e.target.closest('[data-action]')?.dataset.action;
                if (!action) return;
                this.handleContextAction(action);
                this.hideContextMenu();
            });
        }
        document.addEventListener('click', () => this.hideContextMenu());
    }

    // ─── data ──────────────────────────────────────────────────────────────
    async loadTree() {
        try {
            const [servers, mine] = await Promise.all([
                window.mcpClient.loadServers(true),
                window.mcpClient.listMyMcpServers().catch(() => null),
            ]);
            this.servers = Array.isArray(servers) ? servers : [];
            if (this.masterToggle && mine && typeof mine.mcp_enabled === 'boolean') {
                this.masterToggle.checked = mine.mcp_enabled;
            }
            this.renderTree();
        } catch (err) {
            console.error('[mcpLibrary] loadTree failed:', err);
            if (this.treeContainer) {
                this.treeContainer.innerHTML = `<div class="text-center text-red-500 text-xs py-6">${this.esc(this.t('mcpLibrary.loadFailed'))}</div>`;
            }
        }
    }

    isOwn(server) { return server.user_id !== null && server.user_id !== undefined; }
    getServer(id) { return this.servers.find(s => Number(s.id) === Number(id)); }

    // ─── render ────────────────────────────────────────────────────────────
    renderTree() {
        if (!this.treeContainer) return;
        const q = (this.searchInput?.value || '').toLowerCase().trim();
        const visible = q
            ? this.servers.filter(s => (s.name || '').toLowerCase().includes(q) || (s.url || '').toLowerCase().includes(q))
            : this.servers;
        if (visible.length === 0) {
            this.treeContainer.innerHTML = `<div class="text-center text-gray-400 text-xs py-6">${this.esc(this.t('mcpLibrary.noServers'))}</div>`;
            return;
        }
        const own = visible.filter(s => this.isOwn(s));
        const global = visible.filter(s => !this.isOwn(s));
        this.treeContainer.innerHTML =
            this.renderFolder('own', this.t('mcpLibrary.myServers'), own) +
            this.renderFolder('global', this.t('mcpLibrary.globalServers'), global);
        this.attachListeners();
    }

    renderFolder(key, label, items) {
        const collapsed = this.collapsed.has(key);
        const rows = collapsed ? '' : items.map(s => this.renderRow(s)).join('');
        return `
            <div class="mb-1">
                <div class="mcp-lib-folder" data-folder="${key}">
                    <span class="text-gray-500">${collapsed ? '▶' : '▼'}</span>
                    <span>📁</span>
                    <span class="truncate">${this.esc(label)}</span>
                    <span class="mcp-lib-count">(${items.length})</span>
                </div>
                ${rows}
            </div>`;
    }

    renderRow(s) {
        const enabled = Number(s.enabled) === 1;
        const typeBadge = s.server_type === 'mcp_app'
            ? `<span class="mcp-badge mcp-badge-type mcp-badge-app">App</span>`
            : `<span class="mcp-badge mcp-badge-type">MCP</span>`;
        const transport = `<span class="mcp-badge mcp-badge-transport">${this.esc((s.transport || 'http').toUpperCase())}</span>`;
        const mock = Number(s.is_mock) === 1 ? `<span class="mcp-badge mcp-badge-mock">mock</span>` : '';
        return `
            <div class="mcp-lib-item ${enabled ? '' : 'is-disabled'}" data-server-id="${s.id}" title="${this.esc(s.url || '')}">
                <span class="mcp-lib-dot ${enabled ? '' : 'off'}"></span>
                <span class="mcp-lib-name">${this.esc(s.name || '(unnamed)')}</span>
                ${typeBadge}${transport}${mock}
                <span class="mcp-lib-count">${Number(s.tool_count) || 0}</span>
                <button class="mcp-lib-menu" data-server-id="${s.id}" title="More">⋮</button>
            </div>`;
    }

    attachListeners() {
        this.treeContainer.querySelectorAll('.mcp-lib-folder').forEach(el => {
            el.addEventListener('click', () => {
                const k = el.dataset.folder;
                this.collapsed.has(k) ? this.collapsed.delete(k) : this.collapsed.add(k);
                this.renderTree();
            });
        });
        this.treeContainer.querySelectorAll('.mcp-lib-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.mcp-lib-menu')) return;
                this.openServerForm(parseInt(el.dataset.serverId, 10));
            });
        });
        this.treeContainer.querySelectorAll('.mcp-lib-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.contextTarget = parseInt(btn.dataset.serverId, 10);
                this.showContextMenu(e);
            });
        });
    }

    // ─── context menu ─────────────────────────────────────────────────────
    showContextMenu(event) {
        if (!this.contextMenu) return;
        const s = this.getServer(this.contextTarget);
        const own = s && this.isOwn(s);
        this.contextMenu.querySelectorAll('[data-action]').forEach(btn => {
            const a = btn.dataset.action;
            if (a === 'toggle') {
                btn.style.display = own ? '' : 'none';
                btn.textContent = Number(s?.enabled) === 1 ? this.t('mcpLibrary.disable') : this.t('mcpLibrary.enable');
            } else if (a === 'delete') {
                btn.style.display = own ? '' : 'none';
            }
        });
        this.contextMenu.style.left = `${event.clientX}px`;
        this.contextMenu.style.top  = `${event.clientY}px`;
        this.contextMenu.classList.remove('hidden');
    }
    hideContextMenu() { this.contextMenu?.classList.add('hidden'); }

    async handleContextAction(action) {
        const s = this.getServer(this.contextTarget);
        if (!s) return;
        if (action === 'edit')   return this.openServerForm(s.id);
        if (action === 'toggle') {
            await window.mcpClient.toggleServer(s.id, Number(s.enabled) !== 1);
            return this.loadTree();
        }
        if (action === 'delete') return this.openServerForm(s.id, { confirmDelete: true });
    }

    // ─── overlay modal ─────────────────────────────────────────────────────
    async openServerForm(serverId, opts = {}) {
        const server = serverId != null ? this.getServer(serverId) : null;
        const isNew = !server;
        const own = isNew || this.isOwn(server);
        const t = this.t;
        document.getElementById('mcp-server-modal')?.remove();

        const headersText = server?.headers && Object.keys(server.headers).length
            ? JSON.stringify(server.headers, null, 2) : '';
        const typeLabel = isNew || !server.tool_count
            ? t('mcpLibrary.typeUnknown')
            : (server.server_type === 'mcp_app' ? 'MCP App' : 'MCP');
        const dis = own ? '' : 'disabled';

        const html = `
        <div id="mcp-server-modal" class="fixed inset-0 z-[200] flex items-center justify-center" style="background-color: rgba(0,0,0,0.5)">
          <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
            <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
              <h3 class="text-base font-semibold text-gray-800">🔌 ${this.esc(isNew ? t('mcpLibrary.newServer') : server.name)}
                ${!isNew && !own ? `<span class="mcp-badge mcp-badge-global">${this.esc(t('mcpLibrary.global'))}</span>` : ''}
              </h3>
              <button id="mcp-modal-close" class="text-gray-500 hover:text-gray-800 text-xl leading-none">×</button>
            </div>
            <div class="flex border-b border-gray-200 px-3">
              <button class="mcp-modal-tab active" data-tab="settings">${this.esc(t('mcpLibrary.tabSettings'))}</button>
              <button class="mcp-modal-tab" data-tab="tools" ${isNew ? 'disabled' : ''}>${this.esc(t('mcpLibrary.tabTools'))} <span id="mcp-modal-tool-count" class="mcp-lib-count">(${Number(server?.tool_count) || 0})</span></button>
            </div>
            <div class="flex-1 overflow-y-auto px-5 py-4">
              <div id="mcp-tab-settings">
                <label class="mcp-field">${this.esc(t('mcpLibrary.name'))} *<input id="mcp-f-name" class="mcp-input" ${dis} value="${this.esc(server?.name || '')}"></label>
                <label class="mcp-field">${this.esc(t('mcpLibrary.url'))} *<input id="mcp-f-url" class="mcp-input" ${dis} value="${this.esc(server?.url || '')}" placeholder="https://host/mcp"></label>
                <label class="mcp-field">${this.esc(t('mcpLibrary.description'))}<input id="mcp-f-desc" class="mcp-input" ${dis} value="${this.esc(server?.description || '')}"></label>
                <div class="grid grid-cols-2 gap-4">
                  <label class="mcp-field">${this.esc(t('mcpLibrary.transport'))}
                    <select id="mcp-f-transport" class="mcp-input" ${dis}>
                      <option value="http" ${(server?.transport || 'http') === 'http' ? 'selected' : ''}>Streamable HTTP</option>
                      <option value="sse" ${server?.transport === 'sse' ? 'selected' : ''}>SSE</option>
                    </select>
                    <div class="mcp-help">${this.esc(t('mcpLibrary.transportHelp'))}</div>
                  </label>
                  <div class="mcp-field">${this.esc(t('mcpLibrary.type'))}
                    <div class="mt-2"><span id="mcp-f-type" class="mcp-badge ${server?.server_type === 'mcp_app' ? 'mcp-badge-app' : 'mcp-badge-type'}" style="font-size:11px">${this.esc(typeLabel)}</span></div>
                    <div class="mcp-help">${this.esc(t('mcpLibrary.typeHelp'))}</div>
                  </div>
                </div>
                <label class="mcp-field">${this.esc(t('mcpLibrary.headers'))}<textarea id="mcp-f-headers" class="mcp-input" ${dis} placeholder='{"Authorization": "Bearer ..."}'>${this.esc(headersText)}</textarea></label>
                <label class="mcp-field flex items-center gap-2"><input type="checkbox" id="mcp-f-enabled" ${dis} ${isNew || Number(server.enabled) === 1 ? 'checked' : ''}> ${this.esc(t('mcpLibrary.enabled'))}</label>
                <div id="mcp-f-msg" class="mcp-msg hidden"></div>
                <div class="flex items-center gap-2 mt-4">
                  <button id="mcp-f-test" class="mcp-btn mcp-btn-secondary">${this.esc(t('mcpLibrary.testConnection'))}</button>
                  ${own ? `<button id="mcp-f-save" class="mcp-btn mcp-btn-primary">${this.esc(t('mcpLibrary.save'))}</button>` : ''}
                  <span class="flex-1"></span>
                  ${own && !isNew ? `<button id="mcp-f-delete" class="mcp-btn mcp-btn-secondary" data-armed="0">${this.esc(t('mcpLibrary.delete'))}</button>` : ''}
                </div>
              </div>
              <div id="mcp-tab-tools" class="hidden">
                <div class="flex items-center justify-between mb-3">
                  <span class="text-sm text-gray-600" id="mcp-tools-summary"></span>
                  <button id="mcp-tools-refresh" class="mcp-btn mcp-btn-secondary">🔄 ${this.esc(t('mcpLibrary.refreshTools'))}</button>
                </div>
                <div id="mcp-tools-cards"><div class="mcp-tool-empty">${this.esc(t('mcpLibrary.loadingTools'))}</div></div>
              </div>
            </div>
          </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        this.bindModal(server, own, isNew);
        if (opts.confirmDelete) document.getElementById('mcp-f-delete')?.click();
    }

    bindModal(server, own, isNew) {
        const modal = document.getElementById('mcp-server-modal');
        const close = () => modal.remove();
        document.getElementById('mcp-modal-close').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        modal.querySelectorAll('.mcp-modal-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.disabled) return;
                modal.querySelectorAll('.mcp-modal-tab').forEach(b => b.classList.toggle('active', b === btn));
                document.getElementById('mcp-tab-settings').classList.toggle('hidden', btn.dataset.tab !== 'settings');
                document.getElementById('mcp-tab-tools').classList.toggle('hidden', btn.dataset.tab !== 'tools');
                if (btn.dataset.tab === 'tools') this.loadTools(server);
            });
        });

        document.getElementById('mcp-f-test').addEventListener('click', () => this.testConnection());
        document.getElementById('mcp-f-save')?.addEventListener('click', () => this.save(server, isNew));
        document.getElementById('mcp-f-delete')?.addEventListener('click', (e) => this.deleteTwoStep(e.currentTarget, server));
        document.getElementById('mcp-tools-refresh').addEventListener('click', () => this.loadTools(server, /*force*/ true));
    }

    readForm() {
        const g = (id) => document.getElementById(id);
        let headers = null;
        const raw = g('mcp-f-headers').value.trim();
        if (raw) {
            try {
                headers = JSON.parse(raw);
                if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new Error();
            } catch {
                return { error: this.t('mcpLibrary.invalidHeaders') };
            }
        }
        return {
            name: g('mcp-f-name').value.trim(),
            url: g('mcp-f-url').value.trim(),
            description: g('mcp-f-desc').value.trim(),
            transport: g('mcp-f-transport').value,
            enabled: g('mcp-f-enabled').checked,
            headers,
        };
    }

    showMsg(text, ok) {
        const el = document.getElementById('mcp-f-msg');
        if (!el) return;
        el.textContent = text;
        el.className = `mcp-msg ${ok ? 'ok' : 'err'}`;
    }

    async testConnection() {
        const f = this.readForm();
        if (f.error) return this.showMsg(f.error, false);
        if (!f.url) return this.showMsg(this.t('mcpLibrary.urlRequired'), false);
        this.showMsg(this.t('mcpLibrary.testing'), true);
        const res = await window.mcpClient.testConnection(f.url, f.headers || {}, f.transport);
        if (res?.success) {
            const info = res.serverInfo ? ` — ${res.serverInfo.name || ''} ${res.serverInfo.version || ''}` : '';
            this.showMsg(this.t('mcpLibrary.connected') + info, true);
        } else {
            this.showMsg((res?.error?.message || res?.error || this.t('mcpLibrary.connectionFailed')), false);
        }
    }

    async save(server, isNew) {
        const f = this.readForm();
        if (f.error) return this.showMsg(f.error, false);
        if (!f.name || !f.url) return this.showMsg(this.t('mcpLibrary.nameUrlRequired'), false);
        const btn = document.getElementById('mcp-f-save');
        btn.disabled = true;
        try {
            let res;
            if (isNew) {
                res = await window.mcpClient.addServer(f.name, f.url, f.description, f.headers || {}, f.transport);
                if (res?.success && res.server_id && !f.enabled) {
                    await window.mcpClient.toggleServer(Number(res.server_id), false);
                }
            } else {
                res = await window.mcpClient.updateServer(server.id, f.name, f.url, f.description, f.headers, f.transport);
                if (res?.success && (Number(server.enabled) === 1) !== f.enabled) {
                    const toggleRes = await window.mcpClient.toggleServer(server.id, f.enabled);
                    if (!toggleRes?.success) return this.showMsg(this.t('mcpLibrary.saveFailed'), false);
                }
            }
            if (!res?.success) return this.showMsg(res?.error || this.t('mcpLibrary.saveFailed'), false);
            this.showMsg(this.t('mcpLibrary.saved'), true);
            await this.loadTree();
            // Re-open on the saved server so the Tools tab becomes available
            // (discovery runs in the background inside mcpClient).
            const id = isNew ? Number(res.server_id) : server.id;
            const fresh = this.getServer(id);
            if (fresh) { await this.openServerForm(id); document.querySelector('#mcp-server-modal [data-tab="tools"]')?.click(); }
        } finally {
            btn.disabled = false;
        }
    }

    async deleteTwoStep(btn, server) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = this.t('mcpLibrary.confirmDelete');
            btn.classList.add('text-red-600');
            setTimeout(() => { btn.dataset.armed = '0'; btn.textContent = this.t('mcpLibrary.delete'); btn.classList.remove('text-red-600'); }, 4000);
            return;
        }
        const res = await window.mcpClient.deleteServer(server.id);
        if (!res?.success) return this.showMsg(res?.error || this.t('mcpLibrary.deleteFailed'), false);
        document.getElementById('mcp-server-modal')?.remove();
        await this.loadTree();
    }

    // ─── tools tab ─────────────────────────────────────────────────────────
    async loadTools(server, force = false) {
        if (!server) return;
        const cards = document.getElementById('mcp-tools-cards');
        const summary = document.getElementById('mcp-tools-summary');
        cards.innerHTML = `<div class="mcp-tool-empty">${this.esc(this.t('mcpLibrary.loadingTools'))}</div>`;

        let raw = force ? [] : await window.mcpClient.getServerTools(server.id);
        if (raw.length === 0) {
            const disc = await window.mcpClient.discoverTools(server.url, server.id);
            if (!disc?.success) {
                cards.innerHTML = `<div class="mcp-tool-error">❌ ${this.esc(disc?.error?.message || disc?.error || this.t('mcpLibrary.discoveryFailed'))}</div>`;
                return;
            }
            raw = disc.tools || [];
        }
        const tools = window.mcpClient.registerTools(server, raw);
        if (summary) summary.textContent = this.t('mcpLibrary.toolsFound', { count: tools.length });
        const countEl = document.getElementById('mcp-modal-tool-count');
        if (countEl) countEl.textContent = `(${tools.length})`;
        // Type badge follows discovery (auto-detected).
        const typeEl = document.getElementById('mcp-f-type');
        if (typeEl) {
            const isApp = tools.some(t => t.hasUi);
            typeEl.textContent = isApp ? 'MCP App' : 'MCP';
            typeEl.className = `mcp-badge ${isApp ? 'mcp-badge-app' : 'mcp-badge-type'}`;
            typeEl.style.fontSize = '11px';
        }
        this.tester = new window.MCPToolTester({ container: cards, server, t: this.t });
        this.tester.render(tools);
        // Keep the sidebar's tool_count / server_type badge in sync: refresh the
        // tree whenever what we just rendered disagrees with what it shows
        // (covers force-refresh and the initial discovery right after creating
        // a server, without refetching on every routine tab open).
        if (force || Number(server.tool_count) !== tools.length) this.loadTree();
    }

    esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
}

window.MCPLibrary = MCPLibrary;
