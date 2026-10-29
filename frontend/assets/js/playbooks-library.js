/**
 * Playbooks Library
 *
 * Sidebar list of the caller's playbook collection (GET /playbooks). Rows drag onto the workflow
 * canvas as playbook nodes; a click or "New Playbook" opens the playbook form of the workflow
 * editor (showPlaybookForm). Same markup and lazy-init pattern as the MCP Servers Library.
 *
 * Publishing (only when GET /robot says can_use; otherwise nothing of it shows): Published badges,
 * Publish / Republish / Unpublish in the row menu, and a Robot tab listing the robot's playbooks, its
 * published workflows (Activate / Stop, Unpublish, Runs) and its own MCP connections (Robot connections:
 * Add / Edit / Delete, and the editor's Connect box on the robot's routes; keys are never shown).
 */
class PlaybooksLibrary {
    constructor(t) {
        this.t = typeof t === 'function' ? t : (k) => k;
        this.rows = [];
        this.contextTarget = null;
        this.robot = null;        // GET /robot, once: {can_use, ...}; {can_use:false} when it fails
        this.robotRows = [];
        this.robotServers = [];
        this.robotServerForm = null; // the open Add / Edit robot connection form: {id?} ({} = Add)
        this.tab = 'mine';       // 'mine' | 'robot'
        this.publishState = null; // the menu's Publish replace confirmation (PlaybookCollection.publishStep)
        this.unpublishArmed = null; // the armed Unpublish target ('menu:<id>' | 'robot:<robotId>'), PlaybookCollection.armClick
        const base = window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';
        this.api = new window.PlaybookCollection.PlaybookApi(base, () => window.chatApp?.getAuthHeaders?.() || {});
    }

    init() {
        this.treeContainer = document.getElementById('playbooks-tree');
        this.searchInput   = document.getElementById('playbooks-search');
        this.newBtn        = document.getElementById('playbooks-new-btn');
        this.contextMenu   = document.getElementById('playbooks-context-menu');
        this.robotMenu     = document.getElementById('playbooks-robot-menu');
        this.statusLine    = document.getElementById('playbooks-status');
        this.tabsBar       = document.getElementById('playbooks-tabs');

        this.tabsBar?.querySelectorAll('[data-pb-tab]').forEach(b =>
            b.addEventListener('click', () => this.switchTab(b.dataset.pbTab)));

        if (this.newBtn)      this.newBtn.addEventListener('click', () => this.openForm(null));
        if (this.searchInput) this.searchInput.addEventListener('input', () => this.renderTree());
        if (this.contextMenu) {
            this.contextMenu.addEventListener('click', (e) => {
                e.stopPropagation();
                const btn = e.target.closest('[data-action]');
                const action = btn?.dataset.action;
                if (!action) return;
                // Dependencies opens its list inside the menu; the menu stays open.
                if (action === 'dependencies') { this.toggleDependencies(); return; }
                // Delete is two-step: the first click arms the button and keeps the menu open.
                if (action === 'delete' && !this.armDelete(btn)) return;
                // Unpublish too: the robot copy may be someone's scheduled run, or have no source left.
                if (action === 'unpublish') {
                    const row = this.rows.find(r => Number(r.id) === Number(this.contextTarget));
                    if (!this.armUnpublish(btn, `menu:${this.contextTarget}`, row?.pkey)) return;
                }
                // Publish keeps the menu open: a `replaces` answer arms the button, a second click confirms.
                if (action === 'publish' || action === 'republish') { this.publishFromMenu(btn); return; }
                this.handleContextAction(action);
                this.hideContextMenu();
            });
        }
        // The Robot tab's ⋮ menu: Info (who published it, when, from what) and Unpublish.
        this.robotMenu?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const btn = e.target.closest('[data-action]');
            const action = btn?.dataset.action;
            if (action === 'info') { this.toggleRobotInfo(); return; }
            if (action !== 'unpublish') return;
            const row = this.robotRows.find(r => Number(r.id) === Number(this.robotTarget));
            if (!this.armUnpublish(btn, `robot:${this.robotTarget}`, row?.pkey)) return;
            this.hideContextMenu();
            await this.unpublishRobotRow(Number(this.robotTarget));
        });
        document.addEventListener('click', () => this.hideContextMenu());
    }

    /** GET /robot once per library: what the caller may do with the robot. */
    async robotInfo() {
        if (!this.robotPromise) {
            this.robotPromise = this.api.robot().then(b => b.data || { can_use: false })
                .catch(err => { console.warn('[playbooksLibrary] GET /robot failed:', err); return { can_use: false }; });
        }
        this.robot = await this.robotPromise;
        return this.robot;
    }
    canUseRobot() { return !!this.robot?.can_use; }

    async loadTree() {
        try {
            const [rows] = await Promise.all([window.PlaybookCollection.cache.load(this.api), this.robotInfo()]);
            this.rows = rows;
            this.tabsBar?.classList.toggle('hidden', !this.canUseRobot());
            if (!this.canUseRobot()) this.tab = 'mine';
            if (this.tab === 'robot') await this.loadRobotRows();
            this.renderTree();
        } catch (err) {
            console.error('[playbooksLibrary] loadTree failed:', err);
            if (this.treeContainer) {
                this.treeContainer.innerHTML = `<div class="text-center text-red-500 text-xs py-6">${this.esc(err.message)}</div>`;
            }
        }
    }

    async loadRobotRows() {
        const load = async (call) => {
            try { return (await call()).data || []; } catch (err) { this.setStatus(err.message); return []; }
        };
        [this.robotRows, this.robotServers] = await Promise.all([
            load(() => this.api.robotPlaybooks()), load(() => this.api.robotServers())]);
    }

    async switchTab(tab) {
        if (tab === this.tab || (tab === 'robot' && !this.canUseRobot())) return;
        this.tab = tab;
        this.setStatus('');
        this.tabsBar?.querySelectorAll('[data-pb-tab]').forEach(b => {
            const on = b.dataset.pbTab === tab;
            b.classList.toggle('border-blue-600', on); b.classList.toggle('text-blue-600', on);
            b.classList.toggle('border-transparent', !on); b.classList.toggle('text-gray-500', !on);
        });
        if (tab === 'robot') await this.loadRobotRows();
        this.renderTree();
    }

    renderTree() {
        if (!this.treeContainer) return;
        this.disarmUnpublish();
        if (this.tab === 'robot') return this.renderRobotTree();
        const q = (this.searchInput?.value || '').toLowerCase().trim();
        const visible = q
            ? this.rows.filter(r => (r.title || '').toLowerCase().includes(q) || (r.pkey || '').toLowerCase().includes(q))
            : this.rows;
        if (visible.length === 0) {
            this.treeContainer.innerHTML = `<div class="text-center text-gray-400 text-xs py-6">${this.esc(this.t('playbookLibrary.noPlaybooks'))}</div>`;
            return;
        }
        this.treeContainer.innerHTML = visible.map(r => this.renderRow(r)).join('');
        this.attachListeners();
    }

    renderRow(r) {
        const tools = window.PlaybookCollection.toolsUsedOf(r.text).join(', ');
        const used = Number(r.used_by) || 0;
        const pub = window.PlaybookCollection.publishLabel(r, this.canUseRobot(), this.t);
        const pubCls = r.published === 'changed' ? 'mcp-badge-mock' : 'mcp-badge-global';
        return `
            <div class="mcp-lib-item" draggable="true" data-playbook-id="${r.id}" title="${this.esc(tools)}">
                <span>📖</span>
                <span class="mcp-lib-name font-semibold">${this.esc(r.title || r.pkey)}</span>
                <code class="text-gray-500">${this.esc(r.pkey)}</code>
                ${pub ? `<span class="mcp-badge ${pubCls}" data-pb-published="${this.esc(r.published)}">${this.esc(pub)}</span>` : ''}
                ${used ? `<span class="mcp-lib-count">${this.esc(this.t('playbookLibrary.usedBy', { count: used }))}</span>` : ''}
                <button class="mcp-lib-menu" data-playbook-id="${r.id}" title="More">⋮</button>
            </div>`;
    }

    // The Robot tab: the robot's playbooks (key; Info / Unpublish in the ⋮ menu), its workflows and its connections.
    renderRobotTree() {
        const q = (this.searchInput?.value || '').toLowerCase().trim();
        const has = (...v) => !q || v.some(x => String(x || '').toLowerCase().includes(q));
        const visible = this.robotRows.filter(r => has(r.title, r.pkey));
        const empty = (key) => `<div class="text-center text-gray-400 text-xs py-3">${this.esc(this.t(key))}</div>`;
        const head = (key, extra = '') => `<div class="flex items-center justify-between px-1 pt-3 pb-1 text-xs font-semibold text-gray-600"><span>${this.esc(this.t(key))}</span>${extra}</div>`;
        const playbooks = visible.length ? visible.map(r => `
            <div class="mcp-lib-item" data-robot-playbook-id="${r.id}" style="cursor:default;">
                <span>🤖</span>
                <code class="mcp-lib-name text-gray-700">${this.esc(r.pkey)}</code>
                <button class="mcp-lib-menu" data-robot-playbook-id="${r.id}" title="More">⋮</button>
            </div>`).join('') : empty('playbookLibrary.robotEmpty');
        const servers = this.robotServers.filter(s => has(s.name, s.url));
        this.treeContainer.innerHTML = head('robot.playbooks') + playbooks
            + head('robot.connections', `<button type="button" class="text-blue-600 hover:text-blue-700 font-medium" data-robot-server-add>${this.esc(this.t('robot.add'))}</button>`)
            + (this.robotServerForm && !this.robotServerForm.id ? this.renderRobotServerForm({}) : '')
            + (servers.length ? servers.map(s => this.renderRobotServer(s)).join('') : empty('robot.noConnections'));
        this.wireRobotServers();
        this.treeContainer.querySelectorAll('.mcp-lib-menu[data-robot-playbook-id]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hideContextMenu();
                this.setStatus('');
                this.robotTarget = parseInt(btn.dataset.robotPlaybookId, 10);
                this.toggleRobotInfo(false);
                this.menuAt = { x: e.clientX, y: e.clientY };
                this.robotMenu?.classList.remove('hidden');
                this.placeMenu(this.robotMenu);
            });
        });
    }

    // Who published the robot copy, when, and from which playbook, under the menu's Info item.
    toggleRobotInfo(open) {
        const box = this.robotMenu?.querySelector('[data-pb-robot-info]');
        if (!box) return;
        const show = open ?? box.classList.contains('hidden');
        box.classList.toggle('hidden', !show);
        if (show) {
            const r = this.robotRows.find(x => Number(x.id) === Number(this.robotTarget)) || {};
            const lines = [
                r.title || r.pkey || '',
                this.t('playbookLibrary.robotPublishedBy', { name: r.published_by_name || '?', date: String(r.published_at || '').slice(0, 10) }),
                r.source_title ? this.t('playbookLibrary.robotFrom', { title: r.source_title }) : this.t('playbookLibrary.robotSourceGone'),
            ];
            box.replaceChildren(...lines.map((text, i) => {
                const line = document.createElement('div');
                line.className = i === 0 ? 'px-5 py-0.5 font-semibold text-gray-700' : 'px-5 py-0.5 text-gray-600';
                line.textContent = text;
                return line;
            }));
        }
        this.placeMenu(this.robotMenu);
    }

    // A robot connection: name, URL, header names (never the keys), Edit / Delete, and the Connect box
    // when the server implements the connect contract.
    renderRobotServer(s) {
        if (this.robotServerForm && Number(this.robotServerForm.id) === Number(s.id)) return this.renderRobotServerForm(s);
        const names = s.header_names || [];
        const keys = names.length ? this.t('robot.keys', { names: names.join(', ') }) : this.t('robot.noKey');
        return `
            <div class="px-2 py-1.5 mb-1 bg-white rounded border border-gray-200 text-xs" data-robot-server-id="${s.id}">
                <div class="flex items-center gap-1">
                    <span>🔌</span>
                    <span class="font-semibold text-gray-800 truncate flex-1">${this.esc(s.name)}</span>
                    ${s.enabled ? '' : `<span class="mcp-badge mcp-badge-mock">${this.esc(this.t('robot.disabled'))}</span>`}
                </div>
                <div class="text-gray-500 truncate" title="${this.esc(s.url)}">${this.esc(s.url)}</div>
                <div class="text-gray-500">${this.esc(keys)}</div>
                <div class="flex gap-3 mt-1">
                    <button type="button" class="text-blue-600 hover:text-blue-700" data-robot-server-edit="${s.id}">${this.esc(this.t('robot.edit'))}</button>
                    <button type="button" class="text-red-600 hover:text-red-700" data-robot-server-delete="${s.id}">${this.esc(this.t('robot.delete'))}</button>
                </div>
                <div data-robot-connect class="mt-1"></div>
            </div>`;
    }

    // The Add / Edit form (the MCP library's field styles): name, URL, description, enabled. No headers:
    // the key comes from Connect only.
    renderRobotServerForm(s) {
        const isNew = !s.id;
        return `
            <div class="px-2 py-2 mb-1 bg-white rounded border border-blue-300 text-xs" data-robot-server-form>
                <label class="mcp-field">${this.esc(this.t('robot.name'))} *<input data-f="name" class="mcp-input" value="${this.esc(s.name || '')}"></label>
                <label class="mcp-field">${this.esc(this.t('robot.url'))} *<input data-f="url" class="mcp-input" value="${this.esc(s.url || '')}" placeholder="https://host/mcp"></label>
                ${isNew ? '' : `<div class="mcp-help">${this.esc(this.t('robot.urlClearsKey'))}</div>`}
                <label class="mcp-field">${this.esc(this.t('robot.description'))}<input data-f="description" class="mcp-input" value="${this.esc(s.description || '')}"></label>
                ${isNew ? '' : `<label class="mcp-field flex items-center gap-2"><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> ${this.esc(this.t('robot.enabled'))}</label>`}
                <div class="flex gap-2 mt-2">
                    <button type="button" class="mcp-btn mcp-btn-primary" data-robot-server-save>${this.esc(this.t('robot.save'))}</button>
                    <button type="button" class="mcp-btn mcp-btn-secondary" data-robot-server-cancel>${this.esc(this.t('robot.cancel'))}</button>
                </div>
            </div>`;
    }

    wireRobotServers() {
        const c = this.treeContainer;
        c.querySelector('[data-robot-server-add]')?.addEventListener('click', () => { this.robotServerForm = {}; this.renderTree(); });
        c.querySelectorAll('[data-robot-server-edit]').forEach(b => b.addEventListener('click', () => {
            this.robotServerForm = { id: Number(b.dataset.robotServerEdit) };
            this.renderTree();
        }));
        c.querySelectorAll('[data-robot-server-delete]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); // the document click disarms
            const id = Number(b.dataset.robotServerDelete);
            if (!this.armUnpublish(b, `server:${id}`, '', 'robot.confirmDelete', 'robot.delete')) return;
            this.setStatus('');
            try { await this.api.deleteRobotServer(id); } catch (err) { this.setStatus(err.message); }
            await this.loadRobotRows();
            this.renderTree();
        }));
        const form = c.querySelector('[data-robot-server-form]');
        if (form) {
            form.querySelector('[data-robot-server-cancel]').addEventListener('click', () => { this.robotServerForm = null; this.renderTree(); });
            form.querySelector('[data-robot-server-save]').addEventListener('click', async () => {
                const v = (f) => form.querySelector(`[data-f="${f}"]`);
                const data = { name: v('name').value.trim(), url: v('url').value.trim(), description: v('description').value.trim() };
                if (this.robotServerForm?.id) { data.id = this.robotServerForm.id; data.enabled = !!v('enabled')?.checked; }
                this.setStatus('');
                try {
                    await this.api.saveRobotServer(data);
                } catch (err) {
                    this.setStatus(err.message);
                    return;
                }
                this.robotServerForm = null;
                await this.loadRobotRows();
                this.renderTree();
            });
        }
        this.mountRobotConnectBoxes();
    }

    // The workflow editor's Connect box per enabled robot connection, on the robot's own routes (call / key).
    // tools/list needs no credentials: it goes through the user's proxy by URL alone.
    async mountRobotConnectBoxes() {
        const slots = [...this.treeContainer.querySelectorAll('[data-robot-server-id] [data-robot-connect]')];
        if (!slots.length) return;
        const editor = await this.ensureWorkflowEditor();
        if (!editor?._wireServerConnect) return;
        const CN = window.CodeNode;
        const io = {
            call: async (s, tool, args) => {
                try { return CN.toolJson((await this.api.callRobotServer(s.id, tool, args)).data, s.name); }
                catch (err) { return { error: 'network_error', message: err.message }; }
            },
            saveKey: async (s, header, key) => {
                try { await this.api.saveRobotKey(s.id, header, key); return { success: true }; }
                catch (err) { return { success: false, error: err.message }; }
            },
            listTools: (s) => editor._mcpProxyListToolEntries({ url: s.url, name: s.name }),
        };
        await Promise.all(slots.map(async (slot) => {
            const id = Number(slot.closest('[data-robot-server-id]').dataset.robotServerId);
            const server = this.robotServers.find(s => Number(s.id) === id);
            if (!server?.enabled) return;
            const listed = await io.listTools(server);
            if (!slot.isConnected || !CN.isConnectable((listed.tools || []).map(x => x.name))) return;
            slot.innerHTML = editor._connectBoxHtml(server.name);
            editor._wireServerConnect(slot, () => (slot.isConnected ? server : null), io).refresh();
        }));
    }

    async unpublishRobotRow(robotId) {
        this.setStatus('');
        try {
            await this.api.unpublish(robotId);
        } catch (err) {
            this.setStatus(err.message);
        }
        await this.loadTree();
    }

    attachListeners() {
        this.treeContainer.querySelectorAll('.mcp-lib-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.mcp-lib-menu')) return;
                this.openForm(parseInt(el.dataset.playbookId, 10));
            });
            el.addEventListener('dragstart', (ev) => {
                ev.dataTransfer.setData('node-type', 'playbook');
                ev.dataTransfer.setData('playbook-id', String(el.dataset.playbookId));
                ev.dataTransfer.effectAllowed = 'copy';
            });
        });
        if (!this.contextMenu) return;
        this.treeContainer.querySelectorAll('.mcp-lib-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.disarmDelete();
                this.disarmPublish();
                this.disarmUnpublish();
                this.setStatus('');
                this.contextTarget = parseInt(btn.dataset.playbookId, 10);
                this.showPublishItems(this.rows.find(r => Number(r.id) === this.contextTarget));
                this.toggleDependencies(false);
                this.menuAt = { x: e.clientX, y: e.clientY };
                this.contextMenu.classList.remove('hidden');
                this.placeMenu();
            });
        });
    }

    // At the click, moved up (and left) when it would run past the window's edge.
    placeMenu(menu = this.contextMenu) {
        const m = menu;
        if (!m || !this.menuAt) return;
        const r = m.getBoundingClientRect();
        m.style.left = `${Math.max(4, Math.min(this.menuAt.x, window.innerWidth - r.width - 4))}px`;
        m.style.top  = `${Math.max(4, Math.min(this.menuAt.y, window.innerHeight - r.height - 4))}px`;
    }

    // The MCP servers the playbook's "Tools used" line names, listed under the menu's Dependencies item.
    toggleDependencies(open) {
        const list = this.contextMenu?.querySelector('[data-pb-dependencies]');
        if (!list) return;
        const show = open ?? list.classList.contains('hidden');
        list.classList.toggle('hidden', !show);
        if (!show) return this.placeMenu();
        const row = this.rows.find(r => Number(r.id) === Number(this.contextTarget));
        const deps = window.PlaybookCollection.toolsUsedOf(row?.text);
        list.replaceChildren(...(deps.length ? deps : [this.t('playbookLibrary.noDependencies')]).map((name) => {
            const line = document.createElement('div');
            line.className = deps.length ? 'px-5 py-0.5 text-gray-600' : 'px-5 py-0.5 text-gray-400 italic';
            line.textContent = deps.length ? `• ${name}` : name;
            return line;
        }));
        this.placeMenu();
    }

    hideContextMenu() { this.contextMenu?.classList.add('hidden'); this.robotMenu?.classList.add('hidden'); this.disarmDelete(); this.disarmPublish(); this.disarmUnpublish(); }

    // Arm-then-confirm Unpublish (as Delete): true when this click is the confirming one.
    // confirmKey / labelKey: the armed and the resting label (a robot workflow or connection has its own).
    armUnpublish(btn, target, key, confirmKey = 'playbookLibrary.confirmUnpublish', labelKey = 'playbookLibrary.unpublish') {
        const step = window.PlaybookCollection.armClick(this.unpublishArmed, target);
        this.disarmUnpublish();
        if (step.fire) return true;
        this.unpublishArmed = step.armed;
        this.unpublishBtn = btn;
        this.unpublishLabel = labelKey;
        btn.textContent = this.t(confirmKey, { key: key || '' });
        this.unpublishTimer = setTimeout(() => this.disarmUnpublish(), 4000);
        return false;
    }
    disarmUnpublish() {
        clearTimeout(this.unpublishTimer);
        this.unpublishArmed = null;
        if (this.unpublishBtn) this.unpublishBtn.textContent = this.t(this.unpublishLabel || 'playbookLibrary.unpublish');
        this.unpublishBtn = null;
    }

    // Publish when not published; Republish + Unpublish when it is; none without "use the robot".
    showPublishItems(row) {
        const can = this.canUseRobot();
        const published = !!row?.published;
        const show = { publish: can && !published, republish: can && published, unpublish: can && published };
        for (const [action, on] of Object.entries(show)) {
            this.contextMenu?.querySelector(`[data-action="${action}"]`)?.classList.toggle('hidden', !on);
        }
    }

    // A `replaces` answer arms the clicked menu button with the message; the second click confirms.
    async publishFromMenu(btn) {
        const PC = window.PlaybookCollection;
        const row = this.rows.find(r => Number(r.id) === Number(this.contextTarget));
        if (!row || btn.dataset.busy === '1') return;
        const key = row.pkey;
        const step = PC.publishStep(this.publishState, { type: 'click', key });
        this.setStatus('');
        btn.dataset.busy = '1';
        try {
            await this.api.publish(row.id, step.confirmReplace);
            this.publishState = null;
            this.hideContextMenu();
            await this.loadTree();
        } catch (err) {
            this.publishState = PC.publishStep(step, { type: 'error', error: err, key }, this.t);
            if (this.publishState.armed) {
                btn.dataset.armed = '1';
                btn.textContent = this.publishState.message;
            } else {
                this.hideContextMenu();
                this.setStatus(this.publishState.message);
                this.publishState = null;
            }
        } finally {
            btn.dataset.busy = '0';
        }
    }
    disarmPublish() {
        this.publishState = null;
        for (const action of ['publish', 'republish']) {
            const b = this.contextMenu?.querySelector(`[data-action="${action}"]`);
            if (!b || b.dataset.armed !== '1') continue;
            b.dataset.armed = '0';
            b.textContent = this.t('playbookLibrary.' + action);
        }
    }

    // Arm-then-confirm delete (as the MCP library): true when this click is the confirming one.
    armDelete(btn) {
        if (btn.dataset.armed === '1') return true;
        btn.dataset.armed = '1';
        btn.textContent = this.t('playbookLibrary.confirmDelete');
        clearTimeout(this.armTimer);
        this.armTimer = setTimeout(() => this.disarmDelete(), 4000);
        return false;
    }
    disarmDelete() {
        clearTimeout(this.armTimer);
        const btn = this.contextMenu?.querySelector('[data-action="delete"]');
        if (!btn) return;
        btn.dataset.armed = '0';
        btn.textContent = this.t('playbookLibrary.delete');
    }

    setStatus(msg) {
        if (!this.statusLine) return;
        this.statusLine.textContent = msg;
        this.statusLine.classList.toggle('hidden', !msg);
    }

    async handleContextAction(action) {
        const id = this.contextTarget;
        if (id == null) return;
        if (action === 'edit') return this.openForm(id);
        if (action === 'unpublish') {
            // The robot copy published from this playbook (its robot row id is in the robot's list).
            this.setStatus('');
            try {
                const robotRows = (await this.api.robotPlaybooks()).data || [];
                const copy = robotRows.find(r => Number(r.source_id) === Number(id));
                if (!copy) { await this.loadTree(); return; }
                await this.unpublishRobotRow(Number(copy.id));
            } catch (err) {
                this.setStatus(err.message);
            }
            return;
        }
        if (action === 'delete') {
            this.setStatus('');
            try {
                await this.api.remove(id);
                window.PlaybookCollection.cache.drop(id);
                await this.loadTree();
            } catch (err) {
                // The refusal names what uses the playbook.
                this.setStatus(err.message);
            }
        }
    }

    async openForm(id) {
        const editor = await this.ensureWorkflowEditor();
        if (editor && typeof editor.showPlaybookForm === 'function') {
            await editor.showPlaybookForm(id);
        }
    }

    async ensureWorkflowEditor() {
        if (window.workflowEditor) return window.workflowEditor;
        if (!window.WorkflowEditor) {
            console.warn('[playbooksLibrary] WorkflowEditor class not loaded yet');
            return null;
        }
        try {
            window.workflowEditor = new window.WorkflowEditor('workflow-canvas', 'workflow-agents-panel');
            await window.workflowEditor.init();
            return window.workflowEditor;
        } catch (err) {
            console.error('[playbooksLibrary] failed to init WorkflowEditor:', err);
            return null;
        }
    }

    esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
}

window.PlaybooksLibrary = PlaybooksLibrary;
