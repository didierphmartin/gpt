/**
 * Playbooks Library
 *
 * Sidebar list of the caller's playbook collection (GET /playbooks). Rows drag onto the workflow
 * canvas as playbook nodes; a click or "New Playbook" opens the playbook form of the workflow
 * editor (showPlaybookForm). Same markup and lazy-init pattern as the MCP Servers Library.
 *
 * Publishing (only when GET /robot says can_use; otherwise nothing of it shows): Published badges,
 * Publish / Republish / Unpublish in the row menu, and a Robot tab listing the robot's collection.
 */
class PlaybooksLibrary {
    constructor(t) {
        this.t = typeof t === 'function' ? t : (k) => k;
        this.rows = [];
        this.contextTarget = null;
        this.robot = null;        // GET /robot, once: {can_use, ...}; {can_use:false} when it fails
        this.robotRows = [];
        this.tab = 'mine';        // 'mine' | 'robot'
        this.publishState = null; // the menu's Publish replace confirmation (PlaybookCollection.publishStep)
        const base = window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';
        this.api = new window.PlaybookCollection.PlaybookApi(base, () => window.chatApp?.getAuthHeaders?.() || {});
    }

    init() {
        this.treeContainer = document.getElementById('playbooks-tree');
        this.searchInput   = document.getElementById('playbooks-search');
        this.newBtn        = document.getElementById('playbooks-new-btn');
        this.contextMenu   = document.getElementById('playbooks-context-menu');
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
                // Delete is two-step: the first click arms the button and keeps the menu open.
                if (action === 'delete' && !this.armDelete(btn)) return;
                // Publish keeps the menu open: a `replaces` answer arms the button, a second click confirms.
                if (action === 'publish' || action === 'republish') { this.publishFromMenu(btn); return; }
                this.handleContextAction(action);
                this.hideContextMenu();
            });
        }
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
        try {
            this.robotRows = (await this.api.robotPlaybooks()).data || [];
        } catch (err) {
            this.robotRows = [];
            this.setStatus(err.message);
        }
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
                ${tools ? `<span class="mcp-badge mcp-badge-transport">${this.esc(tools)}</span>` : ''}
                ${pub ? `<span class="mcp-badge ${pubCls}" data-pb-published="${this.esc(r.published)}">${this.esc(pub)}</span>` : ''}
                ${used ? `<span class="mcp-lib-count">${this.esc(this.t('playbookLibrary.usedBy', { count: used }))}</span>` : ''}
                <button class="mcp-lib-menu" data-playbook-id="${r.id}" title="More">⋮</button>
            </div>`;
    }

    // The Robot tab: the robot's collection (key, title, published by, when, from which playbook), with Unpublish.
    renderRobotTree() {
        const q = (this.searchInput?.value || '').toLowerCase().trim();
        const visible = q
            ? this.robotRows.filter(r => (r.title || '').toLowerCase().includes(q) || (r.pkey || '').toLowerCase().includes(q))
            : this.robotRows;
        if (visible.length === 0) {
            this.treeContainer.innerHTML = `<div class="text-center text-gray-400 text-xs py-6">${this.esc(this.t('playbookLibrary.robotEmpty'))}</div>`;
            return;
        }
        this.treeContainer.innerHTML = visible.map(r => {
            const from = r.source_title ? this.t('playbookLibrary.robotFrom', { title: r.source_title }) : this.t('playbookLibrary.robotSourceGone');
            const by = this.t('playbookLibrary.robotPublishedBy', { name: r.published_by_name || '?', date: String(r.published_at || '').slice(0, 10) });
            return `
            <div class="mcp-lib-item" data-robot-playbook-id="${r.id}" style="cursor:default; flex-wrap:wrap;">
                <span>🤖</span>
                <span class="mcp-lib-name font-semibold">${this.esc(r.title || r.pkey)}</span>
                <code class="text-gray-500">${this.esc(r.pkey)}</code>
                <span class="mcp-lib-count">${this.esc(by)} · ${this.esc(from)}</span>
                <button class="pb-robot-unpublish ml-auto text-red-600 hover:underline" data-robot-playbook-id="${r.id}">${this.esc(this.t('playbookLibrary.unpublish'))}</button>
            </div>`;
        }).join('');
        this.treeContainer.querySelectorAll('.pb-robot-unpublish').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.unpublishRobotRow(parseInt(btn.dataset.robotPlaybookId, 10));
            });
        });
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
                this.setStatus('');
                this.contextTarget = parseInt(btn.dataset.playbookId, 10);
                this.showPublishItems(this.rows.find(r => Number(r.id) === this.contextTarget));
                this.contextMenu.style.left = `${e.clientX}px`;
                this.contextMenu.style.top  = `${e.clientY}px`;
                this.contextMenu.classList.remove('hidden');
            });
        });
    }

    hideContextMenu() { this.contextMenu?.classList.add('hidden'); this.disarmDelete(); this.disarmPublish(); }

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
