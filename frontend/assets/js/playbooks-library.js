/**
 * Playbooks Library
 *
 * Sidebar list of the caller's playbook collection (GET /playbooks). Rows drag onto the workflow
 * canvas as playbook nodes; a click or "New Playbook" opens the playbook form of the workflow
 * editor (showPlaybookForm). Same markup and lazy-init pattern as the MCP Servers Library.
 */
class PlaybooksLibrary {
    constructor(t) {
        this.t = typeof t === 'function' ? t : (k) => k;
        this.rows = [];
        this.contextTarget = null;
        const base = window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';
        this.api = new window.PlaybookCollection.PlaybookApi(base, () => window.chatApp?.getAuthHeaders?.() || {});
    }

    init() {
        this.treeContainer = document.getElementById('playbooks-tree');
        this.searchInput   = document.getElementById('playbooks-search');
        this.newBtn        = document.getElementById('playbooks-new-btn');
        this.contextMenu   = document.getElementById('playbooks-context-menu');
        this.statusLine    = document.getElementById('playbooks-status');

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
                this.handleContextAction(action);
                this.hideContextMenu();
            });
        }
        document.addEventListener('click', () => this.hideContextMenu());
    }

    async loadTree() {
        try {
            this.rows = await window.PlaybookCollection.cache.load(this.api);
            this.renderTree();
        } catch (err) {
            console.error('[playbooksLibrary] loadTree failed:', err);
            if (this.treeContainer) {
                this.treeContainer.innerHTML = `<div class="text-center text-red-500 text-xs py-6">${this.esc(err.message)}</div>`;
            }
        }
    }

    renderTree() {
        if (!this.treeContainer) return;
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
        return `
            <div class="mcp-lib-item" draggable="true" data-playbook-id="${r.id}" title="${this.esc(tools)}">
                <span>📖</span>
                <span class="mcp-lib-name font-semibold">${this.esc(r.title || r.pkey)}</span>
                <code class="text-gray-500">${this.esc(r.pkey)}</code>
                ${tools ? `<span class="mcp-badge mcp-badge-transport">${this.esc(tools)}</span>` : ''}
                ${used ? `<span class="mcp-lib-count">${this.esc(this.t('playbookLibrary.usedBy', { count: used }))}</span>` : ''}
                <button class="mcp-lib-menu" data-playbook-id="${r.id}" title="More">⋮</button>
            </div>`;
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
                this.setStatus('');
                this.contextTarget = parseInt(btn.dataset.playbookId, 10);
                this.contextMenu.style.left = `${e.clientX}px`;
                this.contextMenu.style.top  = `${e.clientY}px`;
                this.contextMenu.classList.remove('hidden');
            });
        });
    }

    hideContextMenu() { this.contextMenu?.classList.add('hidden'); this.disarmDelete(); }

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
        if (action === 'delete') {
            this.setStatus('');
            try {
                await this.api.remove(id);
                window.PlaybookCollection.cache.drop(id);
                await this.loadTree();
            } catch (err) {
                // The refusal names what uses the playbook.
                this.setStatus(`${this.t('playbookLibrary.deleteRefused')} ${err.message}`);
            }
        }
    }

    async openForm(id) {
        const editor = await this.ensureWorkflowEditor();
        if (editor && typeof editor.showPlaybookForm === 'function') {
            editor._libraryOnSave = () => this.loadTree();
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
