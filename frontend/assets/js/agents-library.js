/**
 * Agents Library
 *
 * Sidebar service that lists user agents organized in a tree of
 * containers (the `category` field on agents). Reuses the existing
 * workflow-editor agent form by calling showAgentEditForm(id, null)
 * in library mode — same fields, same save path, same delete path.
 *
 * The form modal is owned by workflow-editor.js; agents-library.js
 * is only responsible for the sidebar list + container management +
 * 3-dot context menu (Rename / Delete / Edit).
 */
class AgentsLibrary {
    constructor(apiBase, getAuthHeaders, t) {
        this.apiBase = apiBase;
        this.getAuthHeaders = getAuthHeaders;
        // i18n: gracefully fall back to the key if no translator is wired.
        this.t = typeof t === 'function' ? t : (key) => key;

        this.agents = [];
        this.categories = []; // distinct category strings (from server)
        this.collapsed = new Set();   // category names currently collapsed
        this.selectedCategory = null; // null = root; new agents inherit this
        this.contextTarget = null;    // {type, id|name} for context menu
    }

    init() {
        this.treeContainer = document.getElementById('agents-tree');
        this.newAgentBtn   = document.getElementById('agents-new-btn');
        this.newFolderBtn  = document.getElementById('agents-new-folder-btn');
        this.searchInput   = document.getElementById('agents-search');
        this.contextMenu   = document.getElementById('agents-context-menu');

        if (this.newAgentBtn)  this.newAgentBtn.addEventListener('click',  () => this.openCreateAgent());
        if (this.newFolderBtn) this.newFolderBtn.addEventListener('click', () => this.promptNewContainer());
        if (this.searchInput)  this.searchInput.addEventListener('input',  () => this.renderTree());

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

        // Re-load whenever the workflow editor signals it changed agents.
        // Workflow-editor's saveAgent() calls this.loadAgents() then
        // renderAgentsPanel(); we hook into the agent list itself by
        // polling on view-open. Cheap and correct enough for V1.
    }

    // ─── data ──────────────────────────────────────────────────────────────
    async loadTree() {
        try {
            const [agentsRes, categoriesRes] = await Promise.all([
                fetch(`${this.apiBase}/agents?limit=500`, { headers: this.getAuthHeaders() }),
                fetch(`${this.apiBase}/agents/categories`,    { headers: this.getAuthHeaders() }),
            ]);
            const agentsBody = await agentsRes.json();
            const catBody    = await categoriesRes.json();

            this.agents     = Array.isArray(agentsBody?.data) ? agentsBody.data : [];
            this.categories = Array.isArray(catBody?.data)    ? catBody.data    : [];

            // Surface any category referenced by an agent but absent from the
            // categories list (shouldn't happen, but defensive).
            for (const a of this.agents) {
                if (a.category && !this.categories.includes(a.category)) {
                    this.categories.push(a.category);
                }
            }
            this.categories.sort((a, b) => a.localeCompare(b));

            this.renderTree();
        } catch (err) {
            console.error('[agentsLibrary] loadTree failed:', err);
            if (this.treeContainer) {
                this.treeContainer.innerHTML =
                    `<div class="text-center text-red-500 text-xs py-6">Failed to load agents.</div>`;
            }
        }
    }

    // ─── render ────────────────────────────────────────────────────────────
    renderTree() {
        if (!this.treeContainer) return;
        const query = (this.searchInput?.value || '').toLowerCase().trim();
        const visibleAgents = query
            ? this.agents.filter(a =>
                (a.name || '').toLowerCase().includes(query) ||
                (a.description || '').toLowerCase().includes(query))
            : this.agents;

        if (visibleAgents.length === 0 && this.categories.length === 0) {
            this.treeContainer.innerHTML =
                `<div class="text-center text-gray-400 text-xs py-6">No agents yet.</div>`;
            return;
        }

        let html = '';
        // One container row per category, with its agents collapsed under it.
        for (const cat of this.categories) {
            const items = visibleAgents.filter(a => (a.category || '') === cat);
            html += this.renderContainer(cat, items);
        }
        // Uncategorized agents at root.
        const root = visibleAgents.filter(a => !a.category);
        for (const a of root) html += this.renderAgentRow(a);

        this.treeContainer.innerHTML = html;
        this.attachListeners();
    }

    renderContainer(name, items) {
        const isCollapsed = this.collapsed.has(name);
        const arrow = isCollapsed ? '▶' : '▼';
        const selected = this.selectedCategory === name ? 'bg-blue-50' : '';
        const safeName = this.escape(name);
        const rows = isCollapsed
            ? ''
            : items.map(a => this.renderAgentRow(a, true)).join('');
        return `
            <div class="agents-container mb-1">
                <div class="agents-folder flex items-center justify-between px-2 py-1 rounded hover:bg-gray-100 cursor-pointer ${selected}"
                     data-category="${safeName}">
                    <div class="flex items-center gap-1 min-w-0 flex-1">
                        <span class="text-xs text-gray-500">${arrow}</span>
                        <span class="text-xs">📁</span>
                        <span class="text-xs truncate" title="${safeName}">${safeName}</span>
                        <span class="text-xs text-gray-400 ml-1">(${items.length})</span>
                    </div>
                    <button class="agents-folder-menu text-gray-700 hover:text-black font-bold text-xs px-1"
                            data-category="${safeName}" title="More">⋮</button>
                </div>
                ${rows}
            </div>`;
    }

    renderAgentRow(agent, indented = false) {
        const safeName = this.escape(agent.name || '(unnamed)');
        const desc = this.escape(agent.description || '');
        const pad = indented ? 'pl-6' : 'pl-2';
        // draggable=true + data-* attributes carry the agent identity into
        // workflow-editor's drop handler when the user drags this row onto
        // the workflow canvas. The workflow editor reads dataTransfer keys
        // node-type, agent-id, agent-name, agent-type, agent-provider; we
        // set them in the dragstart handler attached in attachListeners().
        const agentType = this.escape(agent.agent_type || 'standard');
        const provider = this.escape(agent.provider || agent.llm_provider || '');
        return `
            <div class="agents-item flex items-center justify-between ${pad} pr-2 py-1 rounded hover:bg-gray-100 cursor-pointer"
                 draggable="true"
                 data-agent-id="${agent.id}"
                 data-agent-name="${safeName}"
                 data-agent-type="${agentType}"
                 data-agent-provider="${provider}">
                <div class="flex items-center gap-1 min-w-0 flex-1">
                    <span class="text-xs">🤖</span>
                    <span class="text-xs truncate" title="${desc || safeName}">${safeName}</span>
                </div>
                <button class="agents-item-menu text-gray-700 hover:text-black font-bold text-xs px-1"
                        data-agent-id="${agent.id}" title="More">⋮</button>
            </div>`;
    }

    attachListeners() {
        this.treeContainer.querySelectorAll('.agents-folder').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.agents-folder-menu')) return;
                const cat = el.dataset.category;
                if (this.collapsed.has(cat)) this.collapsed.delete(cat);
                else this.collapsed.add(cat);
                this.selectedCategory = cat;
                this.renderTree();
            });
        });
        this.treeContainer.querySelectorAll('.agents-folder-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.contextTarget = { type: 'category', name: btn.dataset.category };
                this.showContextMenu(e, /*isCategory*/ true);
            });
        });
        this.treeContainer.querySelectorAll('.agents-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('.agents-item-menu')) return;
                const id = parseInt(el.dataset.agentId, 10);
                this.openAgentForm(id);
            });
            // Drag-to-workflow: when the workflow canvas is up (the user
            // navigated to Workflows then over to Agents), dropping an
            // agent row onto the canvas creates an agent node. Workflow
            // editor's onDrop reads these exact dataTransfer keys.
            el.addEventListener('dragstart', (e) => {
                if (!e.dataTransfer) return;
                e.dataTransfer.setData('node-type', 'agent');
                e.dataTransfer.setData('agent-id', el.dataset.agentId || '');
                e.dataTransfer.setData('agent-name', el.dataset.agentName || '');
                e.dataTransfer.setData('agent-type', el.dataset.agentType || 'standard');
                e.dataTransfer.setData('agent-provider', el.dataset.agentProvider || '');
                e.dataTransfer.effectAllowed = 'copy';
                el.classList.add('dragging');
            });
            el.addEventListener('dragend', () => {
                el.classList.remove('dragging');
            });
        });
        this.treeContainer.querySelectorAll('.agents-item-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.agentId, 10);
                this.contextTarget = { type: 'agent', id };
                this.showContextMenu(e, /*isCategory*/ false);
            });
        });
    }

    // ─── context menu ─────────────────────────────────────────────────────
    showContextMenu(event, isCategory) {
        if (!this.contextMenu) return;
        // Toggle item visibility based on target type.
        this.contextMenu.querySelectorAll('[data-action]').forEach(btn => {
            const a = btn.dataset.action;
            // Categories can be renamed/deleted only. Agents get edit/rename/delete.
            if (isCategory) {
                btn.style.display = (a === 'rename' || a === 'delete') ? '' : 'none';
            } else {
                btn.style.display = '';
            }
        });
        this.contextMenu.style.left = `${event.clientX}px`;
        this.contextMenu.style.top  = `${event.clientY}px`;
        this.contextMenu.classList.remove('hidden');
    }

    hideContextMenu() {
        this.contextMenu?.classList.add('hidden');
    }

    handleContextAction(action) {
        if (!this.contextTarget) return;
        const { type } = this.contextTarget;
        if (type === 'agent') {
            const { id } = this.contextTarget;
            if (action === 'edit')   return this.openAgentForm(id);
            if (action === 'rename') return this.promptRenameAgent(id);
            if (action === 'delete') return this.deleteAgent(id);
        }
        if (type === 'category') {
            const { name } = this.contextTarget;
            if (action === 'rename') return this.promptRenameContainer(name);
            if (action === 'delete') return this.deleteContainer(name);
        }
    }

    // ─── agent form (reuses workflow-editor modal in library mode) ────────
    async openCreateAgent() {
        return this.openAgentForm(null, /*isCreate*/ true);
    }

    async openAgentForm(agentId, isCreate = false) {
        const editor = await this.ensureWorkflowEditor();
        if (!editor) {
            alert('Agent form unavailable. Please refresh and try again.');
            return;
        }
        // Pre-tag the editor with the currently-selected container so that
        // the form's save knows where to drop a brand-new agent.
        editor._libraryCategoryHint = this.selectedCategory || null;
        // After the form saves we reload so the new row appears.
        editor._libraryOnSave = () => this.loadTree();
        await editor.showAgentEditForm(agentId, null);
    }

    async ensureWorkflowEditor() {
        if (window.workflowEditor) return window.workflowEditor;
        if (!window.WorkflowEditor) {
            console.warn('[agentsLibrary] WorkflowEditor class not loaded yet');
            return null;
        }
        try {
            window.workflowEditor = new window.WorkflowEditor('workflow-canvas', 'workflow-agents-panel');
            await window.workflowEditor.init();
            return window.workflowEditor;
        } catch (err) {
            console.error('[agentsLibrary] failed to init WorkflowEditor:', err);
            return null;
        }
    }

    // ─── agent rename/delete (no form) ────────────────────────────────────
    async promptRenameAgent(agentId) {
        const agent = this.agents.find(a => a.id === agentId);
        if (!agent) return;
        const next = prompt('Rename agent:', agent.name || '');
        if (next == null) return;
        const newName = next.trim();
        if (!newName || newName === agent.name) return;
        try {
            const res = await fetch(`${this.apiBase}/agents/${agentId}`, {
                method: 'PUT',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName }),
            });
            if (!res.ok) throw new Error(await res.text());
            await this.loadTree();
        } catch (err) {
            alert('Rename failed: ' + err.message);
        }
    }

    async deleteAgent(agentId) {
        const agent = this.agents.find(a => a.id === agentId);
        if (!agent) return;
        if (!confirm(`Delete agent "${agent.name}"?`)) return;
        try {
            const res = await fetch(`${this.apiBase}/agents/${agentId}`, {
                method: 'DELETE', headers: this.getAuthHeaders(),
            });
            if (!res.ok) throw new Error(await res.text());
            await this.loadTree();
        } catch (err) {
            alert('Delete failed: ' + err.message);
        }
    }

    // ─── container ops ────────────────────────────────────────────────────
    async promptNewContainer() {
        const name = prompt('New container name:');
        if (name == null) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        if (this.categories.includes(trimmed)) {
            this.selectedCategory = trimmed; // already exists — just select
            this.renderTree();
            return;
        }
        // Containers exist only by virtue of containing an agent. We add the
        // name to the local list so the empty container shows in the tree;
        // selecting it and creating an agent inside is what truly persists it.
        this.categories.push(trimmed);
        this.categories.sort((a, b) => a.localeCompare(b));
        this.selectedCategory = trimmed;
        this.renderTree();
    }

    async promptRenameContainer(oldName) {
        const next = prompt('Rename container:', oldName);
        if (next == null) return;
        const newName = next.trim();
        if (!newName || newName === oldName) return;
        try {
            const res = await fetch(`${this.apiBase}/agents/categories/rename`, {
                method: 'PUT',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_name: oldName, new_name: newName }),
            });
            if (!res.ok) throw new Error(await res.text());
            await this.loadTree();
        } catch (err) {
            alert('Rename failed: ' + err.message);
        }
    }

    async deleteContainer(name) {
        if (!confirm(`Delete container "${name}"? Agents inside will move to Uncategorized.`)) return;
        try {
            const res = await fetch(`${this.apiBase}/agents/categories`, {
                method: 'DELETE',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) throw new Error(await res.text());
            await this.loadTree();
        } catch (err) {
            alert('Delete failed: ' + err.message);
        }
    }

    // ─── utils ────────────────────────────────────────────────────────────
    escape(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        })[c]);
    }
}

// Globalize for chat.js + workflow-editor.js to reach.
window.AgentsLibrary = AgentsLibrary;
