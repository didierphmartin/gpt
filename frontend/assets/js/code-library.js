/**
 * Code Library
 *
 * Sidebar list of the caller's code components (GET /code-components). Rows drag onto the workflow
 * canvas as linked code nodes; a click or "New Code Component" opens the code modal on the component
 * (editor.showCodeComponentForm). Same markup and lazy-init pattern as the Playbooks Library.
 */
class CodeLibrary {
    constructor(t) {
        this.t = typeof t === 'function' ? t : (k) => k;
        this.rows = [];
        this.contextTarget = null;
    }

    init() {
        this.tree = document.getElementById('code-library-tree');
        this.search = document.getElementById('code-library-search');
        this.menu = document.getElementById('code-library-context-menu');
        this.status = document.getElementById('code-library-status');
        document.getElementById('code-library-new-btn')?.addEventListener('click', () => this.openForm(null));
        this.search?.addEventListener('input', () => this.renderTree());
        this.menu?.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.target.closest('[data-action]');
            const action = btn?.dataset.action;
            if (!action) return;
            if (action === 'usedby') { this.toggleUsedBy(); return; }
            if (action === 'delete' && !this.armDelete(btn)) return;
            this.hideMenu();
            if (action === 'edit') this.openForm(this.contextTarget);
            if (action === 'delete') this.remove(this.contextTarget);
        });
        document.addEventListener('click', () => this.hideMenu());
    }

    async loadTree() {
        try {
            this.rows = await window.CodeComponents.cache.load(window.CodeComponents.api());
            this.renderTree();
        } catch (err) {
            if (this.tree) this.tree.innerHTML = `<div class="text-center text-red-500 text-xs py-6">${this.esc(err.message)}</div>`;
        }
    }

    renderTree() {
        if (!this.tree) return;
        const q = (this.search?.value || '').toLowerCase().trim();
        const visible = q ? this.rows.filter(r => `${r.name} ${r.description}`.toLowerCase().includes(q)) : this.rows;
        if (!visible.length) {
            this.tree.innerHTML = `<div class="text-center text-gray-400 text-xs py-6">${this.esc(this.t('codeLibrary.empty'))}</div>`;
            return;
        }
        this.tree.innerHTML = visible.map(r => `
            <div class="mcp-lib-item" draggable="true" data-cc-id="${r.id}" title="${this.esc(r.description || window.CodeNode.exitsLabel(r.exits))}">
                <span>🐍</span>
                <span class="mcp-lib-name font-semibold">${this.esc(r.name)}</span>
                ${r.used_by ? `<span class="mcp-lib-count">${this.esc(this.t('codeLibrary.usedBy', { count: r.used_by }))}</span>` : ''}
                <button class="mcp-lib-menu" data-cc-id="${r.id}" title="More">⋮</button>
            </div>`).join('');
        this.tree.querySelectorAll('.mcp-lib-item').forEach(el => {
            el.addEventListener('click', (e) => { if (!e.target.closest('.mcp-lib-menu')) this.openForm(Number(el.dataset.ccId)); });
            el.addEventListener('dragstart', (ev) => {
                ev.dataTransfer.setData('node-type', 'code');
                ev.dataTransfer.setData('code-component-id', String(el.dataset.ccId));
                ev.dataTransfer.effectAllowed = 'copy';
            });
        });
        this.tree.querySelectorAll('.mcp-lib-menu').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.disarmDelete();
            this.setStatus('');
            this.contextTarget = Number(btn.dataset.ccId);
            this.menu.querySelector('[data-cc-usedby]').classList.add('hidden');
            this.menu.classList.remove('hidden');
            const r = this.menu.getBoundingClientRect();
            this.menu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 4))}px`;
            this.menu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 4))}px`;
        }));
    }

    // The workflows whose nodes link to the component, listed inside the menu.
    async toggleUsedBy() {
        const box = this.menu.querySelector('[data-cc-usedby]');
        if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
        box.classList.remove('hidden');
        box.textContent = '…';
        try {
            const used = (await window.CodeComponents.api().usedBy(this.contextTarget)).data || [];
            const lines = used.length ? used.map(u => `• ${u.workflow_name} — ${u.node_name}`) : [this.t('codeLibrary.unused')];
            box.replaceChildren(...lines.map(text => {
                const line = document.createElement('div');
                line.className = used.length ? 'px-5 py-0.5 text-gray-600' : 'px-5 py-0.5 text-gray-400 italic';
                line.textContent = text;
                return line;
            }));
        } catch (err) { box.textContent = err.message; }
    }

    async remove(id) {
        this.setStatus('');
        try {
            await window.CodeComponents.api().remove(id);
            window.CodeComponents.cache.drop(id);
        } catch (err) {
            this.setStatus(err.message);   // in_use: the refusal names the workflows
        }
        await this.loadTree();
    }

    armDelete(btn) {
        if (btn.dataset.armed === '1') return true;
        btn.dataset.armed = '1';
        btn.textContent = this.t('codeLibrary.confirmDelete');
        clearTimeout(this.armTimer);
        this.armTimer = setTimeout(() => this.disarmDelete(), 4000);
        return false;
    }
    disarmDelete() {
        clearTimeout(this.armTimer);
        const btn = this.menu?.querySelector('[data-action="delete"]');
        if (!btn) return;
        btn.dataset.armed = '0';
        btn.textContent = this.t('codeLibrary.delete');
    }
    hideMenu() { this.menu?.classList.add('hidden'); this.disarmDelete(); }
    setStatus(msg) { if (this.status) { this.status.textContent = msg; this.status.classList.toggle('hidden', !msg); } }

    async openForm(id) {
        const editor = await this.ensureWorkflowEditor();
        editor?.showCodeComponentForm?.(id);
    }

    async ensureWorkflowEditor() {
        if (window.workflowEditor) return window.workflowEditor;
        if (!window.WorkflowEditor) return null;
        window.workflowEditor = new window.WorkflowEditor('workflow-canvas', 'workflow-agents-panel');
        await window.workflowEditor.init();
        return window.workflowEditor;
    }

    esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
}

window.CodeLibrary = CodeLibrary;
