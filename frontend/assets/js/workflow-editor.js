/**
 * Workflow Editor
 *
 * Visual workflow builder using Drawflow library.
 * Allows drag & drop of agents to create execution pipelines.
 * Replaces the need for a "manager" agent - users define the workflow visually.
 */
class WorkflowEditor {
    constructor(containerId, agentsPanelId) {
        this.container = document.getElementById(containerId);
        this.agentsPanel = document.getElementById(agentsPanelId);
        this.editor = null;
        this.agents = [];
        this.workflows = [];
        this.dbNodeToDrawflowMap = {}; // Maps database node IDs to Drawflow node IDs
        this.currentWorkflowId = null;
        this.currentWorkflowName = '';
        this.currentWorkflowDescription = '';
        this.audioLlmProvider = 'grok';
        this.isInitialized = false;

        // Output storage settings
        this.outputStorageEnabled = false;
        this.outputFolder = '';

        // API base URL
        this.apiBase = window.CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';

        // Expose the live instance for console-driven testing of the new
        // browser-driven node runner (wfEditor.runNodeChatUnitTest(...)).
        window.wfEditor = this;

        // Agent form related
        this.providers = [];
        this.providersLoaded = false;
        this.availableTools = [];
        this.toolsLoaded = false;
        this.editingAgent = null;

        // Store last workflow results for viewing on Output node click
        this.lastWorkflowResults = null;

        // Store real-time node execution data (input/output as they arrive)
        this.nodeExecutionData = {};

        // Latest renderable artifact (HTML/MD) produced by a skill during
        // the current run. Surfaced in the chat artifact pane when the
        // workflow reaches the end node so the user sees the transformed
        // file alongside the run summary.
        this.lastProducedArtifact = null;

        // Store user prompt for viewing on Start node click
        this.lastUserPrompt = '';

        // Schedule configuration for the workflow
        this.currentSchedule = null;
        this.scheduleEnabled = false; // When true, attachments must use remote storage

        // UniversalFS for document storage
        this.universalFS = null;
        this.localFsAdapter = null;
        this.remoteFsAdapter = null;
        this.localFsHandle = null; // Persisted directory handle for local storage
        this.universalFSEndpoint = '/universalfs/api'; // UniversalFS PHP API endpoint

        // Multi-select support
        this.selectedNodes = new Set();
        this.isMovingSelection = false;
        this.lastNodePosition = null;

        // Realtime workflow support
        this.runtimeMode = 'batch';  // 'batch' or 'realtime'
    }

    /**
     * Get translated string (with fallback to key)
     */
    t(key, params = {}) {
        if (window.i18n && typeof window.i18n.t === 'function') {
            return window.i18n.t(key, params);
        }
        // Fallback: return the last part of the key
        return key.split('.').pop();
    }

    /**
     * Initialize the workflow editor
     */
    async init() {
        if (this.isInitialized) return;

        // Make container focusable for keyboard events
        this.container.setAttribute('tabindex', '0');
        this.container.style.outline = 'none';

        // Initialize Drawflow
        this.editor = new Drawflow(this.container);
        this.editor.reroute = true;
        this.editor.reroute_fix_curvature = true;
        this.editor.curvature = 0.5;
        this.editor.reroute_curvature_start_end = 0.5;
        this.editor.reroute_curvature = 0.5;
        this.editor.force_first_input = false;
        this.editor.line_path = 5;
        this.editor.editor_mode = 'edit'; // Ensure edit mode is enabled
        this.editor.start();

        console.log('[WorkflowEditor] Drawflow editor mode:', this.editor.editor_mode);

        // Add arrowhead marker for connection lines
        this.addArrowheadMarker();

        // Inject CSS styles for animated connections
        this.injectConnectionStyles();

        // Add zoom controls overlay
        this.addZoomControls();

        // Add workflow info box
        this.addWorkflowInfoBox();
        this.addAudioWorkflowInfoBox();
        // Editor defaults to batch mode on load. Show the batch info box
        // briefly so users see it's there, then auto-collapse it — symmetric
        // with the audio workflow form's show-then-collapse behavior.
        const initialBatchBox = document.getElementById('workflow-info-box');
        if (initialBatchBox) {
            initialBatchBox.style.display = '';
            this._scheduleFormAutoCollapse(initialBatchBox);
        }

        // Set up event listeners
        this.setupEditorEvents();
        this.setupDragAndDrop();
        this.setupDocumentDragDrop();

        // Load agents from API (excluding managers)
        await this.loadAgents();

        // Load tool catalog (built-in + MCP) for realtime agent selection.
        // Done once; if servers add tools later, reload by re-opening the editor.
        this.loadToolCatalog();

        // Render agents panel
        this.renderAgentsPanel();

        // Listen for language changes to re-render
        if (window.i18n && typeof window.i18n.onLanguageChange === 'function') {
            window.i18n.onLanguageChange(() => {
                this.renderAgentsPanel();
            });
        }

        this.isInitialized = true;
        console.log('[WorkflowEditor] Initialized');
    }

    /**
     * Load agents from API, excluding manager types
     */
    /**
     * Load the tool catalog (built-in + MCP). Cached on this.toolCatalog.
     * Each entry: { name, description, type: 'builtin'|'mcp', server?, input_schema }
     */
    async loadToolCatalog() {
        try {
            const response = await fetch(`${this.apiBase}/tools`, {
                headers: this.getAuthHeaders()
            });
            if (!response.ok) {
                console.warn('[WorkflowEditor] Tool catalog fetch failed:', response.status);
                this.toolCatalog = [];
                return;
            }
            const data = await response.json();
            this.toolCatalog = Array.isArray(data.tools) ? data.tools : [];
            console.log('[WorkflowEditor] Loaded tool catalog:', this.toolCatalog.length, 'tools');
        } catch (e) {
            console.error('[WorkflowEditor] Error loading tool catalog:', e);
            this.toolCatalog = [];
        }
    }

    async loadAgents() {
        try {
            console.log('[WorkflowEditor] Loading agents...');

            // Try loading from /agents endpoint first
            let response = await fetch(`${this.apiBase}/agents`, {
                headers: this.getAuthHeaders()
            });

            console.log('[WorkflowEditor] Agents API response status:', response.status);

            if (!response.ok) {
                // Try loading from teams endpoint as fallback
                console.log('[WorkflowEditor] Trying teams endpoint as fallback...');
                response = await fetch(`${this.apiBase}/teams`, {
                    headers: this.getAuthHeaders()
                });

                if (response.ok) {
                    const teamsData = await response.json();
                    const teams = teamsData.teams || teamsData.data || [];
                    console.log('[WorkflowEditor] Loaded teams:', teams.length);

                    // Extract agents from all teams
                    this.agents = [];
                    teams.forEach(team => {
                        const teamAgents = team.agents || [];
                        teamAgents.forEach(agent => {
                            if (agent.agent_type !== 'manager') {
                                this.agents.push(agent);
                            }
                        });
                    });
                    console.log('[WorkflowEditor] Extracted agents from teams:', this.agents.length);
                    return;
                }

                throw new Error('Failed to load agents from both endpoints');
            }

            const data = await response.json();
            console.log('[WorkflowEditor] Raw API response:', data);

            // Filter out manager agents - we don't need them in workflow editor
            const allAgents = data.agents || data.data || [];
            console.log('[WorkflowEditor] All agents before filter:', allAgents.length, allAgents);

            // For now, show ALL agents (including managers for debugging)
            // TODO: Filter out managers once we confirm agents are loading
            this.agents = allAgents;

            console.log('[WorkflowEditor] Loaded ALL agents:', this.agents.length, this.agents);
            console.log('[WorkflowEditor] Agent types:', allAgents.map(a => `${a.name}: ${a.agent_type}`));
        } catch (error) {
            console.error('[WorkflowEditor] Error loading agents:', error);
            this.agents = [];
        }
    }

    /**
     * Render the agents panel (right side).
     * In realtime mode, shows a different palette: Start (with Play), Agent (with mic), End.
     */
    renderAgentsPanel() {
        if (!this.agentsPanel) return;

        // Realtime mode gets a dedicated palette
        if (this.runtimeMode === 'realtime') {
            this.renderRealtimeAgentsPanel();
            return;
        }

        // Debug: log agents before filtering
        console.log('[WorkflowEditor] Agents before render:', this.agents);
        console.log('[WorkflowEditor] Agent types:', this.agents.map(a => `${a.name}: "${a.agent_type}"`));

        // Filter out manager agents - only show workers and standard agents
        const workflowAgents = this.agents.filter(a =>
            a.agent_type?.toLowerCase() !== 'manager'
        );

        console.log('[WorkflowEditor] Filtered agents (no managers):', workflowAgents.length);

        // Show message if no agents loaded
        const agentsHtml = workflowAgents.length > 0
            ? workflowAgents.map(agent => this.renderAgentCard(agent)).join('')
            : `<div style="padding: 16px; text-align: center; color: #94a3b8; font-size: 13px;">
                   <p style="margin-bottom: 8px;">No agents found.</p>
                   <p style="font-size: 11px;">Click "Add Agent" below to create one.</p>
               </div>`;

        // Get collapsed state from localStorage
        const collapsedSections = JSON.parse(localStorage.getItem('workflowPanelCollapsed') || '{}');

        this.agentsPanel.innerHTML = `
            <!-- Panel header with collapse/expand toggle -->
            <div class="workflow-panel-header">
                <span class="panel-title">Nodes</span>
                <button id="workflow-panel-toggle" class="workflow-panel-toggle"
                        title="Collapse panel" aria-label="Collapse panel">▶</button>
            </div>

            <!-- All Nodes with collapsible sections -->
            <div class="workflow-agents-list" id="workflow-agents-list">
                <!-- Essentials Section -->
                <div class="workflow-section">
                    <div class="workflow-section-header" data-section="essentials">
                        <span class="section-toggle">${collapsedSections.essentials ? '▶' : '▼'}</span>
                        <span class="section-title">${this.t('workflow.essentials')}</span>
                        <span class="section-count">2</span>
                    </div>
                    <div class="workflow-section-content ${collapsedSections.essentials ? 'collapsed' : ''}" data-section="essentials">
                        <!-- Start Node -->
                        <div class="workflow-agent-card special start-node"
                             draggable="true"
                             data-node-type="start">
                            <div class="agent-icon">▶</div>
                            <div class="agent-info">
                                <div class="agent-name">${this.t('workflow.nodes.start')}</div>
                                <div class="agent-type">${this.t('workflow.nodes.startDesc')}</div>
                            </div>
                        </div>
                        <!-- Output Node -->
                        <div class="workflow-agent-card special output-node"
                             draggable="true"
                             data-node-type="output">
                            <div class="agent-icon">■</div>
                            <div class="agent-info">
                                <div class="agent-name">${this.t('workflow.nodes.output')}</div>
                                <div class="agent-type">${this.t('workflow.nodes.outputDesc')}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Ingestion Section -->
                <div class="workflow-section">
                    <div class="workflow-section-header" data-section="ingestion">
                        <span class="section-toggle">${collapsedSections.ingestion ? '▶' : '▼'}</span>
                        <span class="section-title">Ingestion</span>
                        <span class="section-count">3</span>
                    </div>
                    <div class="workflow-section-content ${collapsedSections.ingestion ? 'collapsed' : ''}" data-section="ingestion">
                        <div class="workflow-agent-card special ingestion-node" draggable="true" data-node-type="loader">
                            <span class="ingestion-order" title="Step 1 — place first">1</span><div class="agent-icon">📥</div><div class="agent-info"><div class="agent-name">Loader</div><div class="agent-type">Load a document (PDF)</div></div></div>
                        <div class="workflow-agent-card special ingestion-node" draggable="true" data-node-type="splitter">
                            <span class="ingestion-order" title="Step 2 — after the loader">2</span><div class="agent-icon">✂️</div><div class="agent-info"><div class="agent-name">Splitter</div><div class="agent-type">Chunk the text</div></div></div>
                        <div class="workflow-agent-card special ingestion-node" draggable="true" data-node-type="vectorstore">
                            <span class="ingestion-order" title="Step 3 — after the splitter">3</span><div class="agent-icon">🗄️</div><div class="agent-info"><div class="agent-name">Vector store</div><div class="agent-type">Embed → pgvector</div></div></div>
                    </div>
                </div>

                <!-- Agents Section — templates only. Specific saved agents come
                     from the left sidebar's Agents list (drag-to-canvas); this
                     section keeps the draggable Agent Template + the "+" to add one. -->
                <div class="workflow-section">
                    <div class="workflow-section-header" data-section="agents">
                        <span class="section-toggle">${collapsedSections.agents ? '▶' : '▼'}</span>
                        <span class="section-title">${this.t('workflow.agents')}</span>
                        <span class="section-count">0</span>
                        <button class="section-add-btn" data-action="add-agent" title="${this.t('agentTeams.addTemplate')}">+</button>
                    </div>
                    <div class="workflow-section-content ${collapsedSections.agents ? 'collapsed' : ''}" data-section="agents"></div>
                </div>
            </div>

            <!-- Action Buttons — symmetric with audio workflows: execution
                 happens via the ▶ button on the Start node on the canvas. -->
            <div class="workflow-actions">
                <button id="workflow-save-toggle" class="workflow-btn primary">
                    ${this.t('workflow.saveWorkflow')}
                </button>
            </div>
        `;

        // Set up section toggle click handlers (exclude clicks on add buttons)
        this.agentsPanel.querySelectorAll('.workflow-section-header').forEach(header => {
            header.addEventListener('click', (e) => {
                // Don't toggle if clicking the add button
                if (e.target.classList.contains('section-add-btn')) return;
                this.toggleSection(e.currentTarget);
            });
        });

        // Panel collapse/expand toggle. The .collapsed class lives on the
        // panel container (not rebuilt by innerHTML), so its state survives
        // re-renders; we still re-apply from localStorage to stay in sync.
        const panelToggleBtn = this.agentsPanel.querySelector('#workflow-panel-toggle');
        if (panelToggleBtn) {
            const applyToggleState = () => {
                const collapsed = this.agentsPanel.classList.contains('collapsed');
                // Match the left sidebar's glyphs (◀/▶). On this right-side
                // panel ▶ collapses (toward the right edge); ◀ expands.
                panelToggleBtn.textContent = collapsed ? '◀' : '▶';
                panelToggleBtn.title = collapsed ? 'Expand panel' : 'Collapse panel';
                panelToggleBtn.setAttribute('aria-label', panelToggleBtn.title);
            };
            if (localStorage.getItem('workflowPanelHidden') === '1') {
                this.agentsPanel.classList.add('collapsed');
            }
            applyToggleState();
            panelToggleBtn.onclick = () => {
                const nowCollapsed = this.agentsPanel.classList.toggle('collapsed');
                localStorage.setItem('workflowPanelHidden', nowCollapsed ? '1' : '0');
                applyToggleState();
            };
        }

        // Set up section add button handlers
        this.agentsPanel.querySelectorAll('.section-add-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (action === 'add-agent') {
                    this.addAgentTemplate();
                }
            });
        });

        // Initialize agent templates with one default if not exists
        if (!this.agentTemplates) {
            this.agentTemplates = [{ id: 'new-agent-1', templateNum: 1 }];
        }
        // Always render agent templates (includes real agents + templates)
        this.renderAgentTemplates();

        // Set up drag events for all draggable cards
        this.agentsPanel.querySelectorAll('.workflow-agent-card').forEach(card => {
            card.addEventListener('dragstart', (e) => this.onDragStart(e, card));
            card.addEventListener('dragend', (e) => this.onDragEnd(e, card));
        });

        // Set up click events for edit buttons (separate from drag)
        this.agentsPanel.querySelectorAll('.agent-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent drag interference
                e.preventDefault();
                const agentId = btn.dataset.agentId;
                this.showAgentEditForm(agentId);
            });
        });

        // Set up action buttons
        document.getElementById('workflow-save-toggle')?.addEventListener('click', () => {
            this.showSaveOverlay();
        });
        document.getElementById('workflow-run-btn')?.addEventListener('click', () => this.runWorkflow());
        document.getElementById('workflow-clear-btn')?.addEventListener('click', () => this.clearWorkflow());

        // Set up "New Workflow" button in left sidebar — show Batch/Audio choice
        document.getElementById('new-workflow-btn')?.addEventListener('click', (e) => {
            this.showNewWorkflowTypeSelector(e.target.closest('button'));
        });

        // Sidebar Import Workflow button — same flow as the form's Import action.
        // Use onclick (single slot) NOT addEventListener: this setup re-runs on
        // every editor re-init, and addEventListener would stack a new listener
        // each time → one click fires N file pickers (Cancel reveals the next).
        const sidebarImportBtn = document.getElementById('sidebar-import-workflow-btn');
        if (sidebarImportBtn) sidebarImportBtn.onclick = () => this._handleImportWorkflow();

        // Load existing workflows into left panel
        this.loadWorkflowsList();
    }

    /**
     * Load list of workflows and update the left panel
     */
    async loadWorkflowsList() {
        // Show a loading placeholder so users know the list is being fetched.
        // The earlier gate `!this.workflows` never matched because the
        // constructor inits this.workflows = [] (line 14), so ![] === false
        // and the spinner branch was dead code. Track first-load explicitly
        // with `_workflowsLoadedOnce` so the spinner appears on the slow
        // initial fetch (when the user notices the wait) but doesn't flash
        // on subsequent silent refreshes (after Save/Delete/Duplicate).
        const listContainer = document.getElementById('workflows-list');
        if (listContainer && !this._workflowsLoadedOnce) {
            listContainer.innerHTML = `
                <div class="flex items-center justify-center gap-2 text-gray-400 text-xs py-4">
                    <span class="inline-block w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin"></span>
                    <span>${this.tWithFallback('common.loading', 'Loading...')}</span>
                </div>
            `;
        }

        try {
            // Add cache-busting parameter to prevent stale data
            const response = await fetch(`${this.apiBase}/workflows?_=${Date.now()}`, {
                headers: this.getAuthHeaders(),
                cache: 'no-store'
            });

            if (!response.ok) {
                console.error('[WorkflowEditor] Failed to load workflows list');
                return;
            }

            const data = await response.json();
            this.workflows = data.data || data.workflows || [];
            this._workflowsLoadedOnce = true;

            // Update the saved workflows panel (left side)
            this.renderSavedWorkflowsList();

            console.log('[WorkflowEditor] Loaded workflows list:', this.workflows.length, 'current:', this.currentWorkflowId);

        } catch (error) {
            console.error('[WorkflowEditor] Error loading workflows list:', error);
        }
    }

    /**
     * Render the saved workflows list in the left sidebar
     */
    renderSavedWorkflowsList() {
        // Use the existing sidebar element #workflows-list
        const listContainer = document.getElementById('workflows-list');
        if (!listContainer) {
            console.warn('[WorkflowEditor] workflows-list element not found in sidebar');
            return;
        }

        if (this.workflows.length === 0) {
            listContainer.innerHTML = `
                <div class="text-center text-gray-400 text-xs py-4">
                    No saved workflows yet
                </div>
            `;
            return;
        }

        listContainer.innerHTML = this.workflows.map(wf => {
            const isActive = String(this.currentWorkflowId) === String(wf.id);
            const nodes = wf.definition?.nodes || wf.graph?.nodes || [];
            const isAudio = wf.runtime_mode === 'realtime'
                || wf.definition?.runtime_mode === 'realtime'
                || nodes.some(n => {
                    const t = n.type || n.node_type || n.config?.type || '';
                    return typeof t === 'string' && t.startsWith('realtime-');
                });
            const icon = isAudio ? '🎙' : '⚙️';
            const badgeLabel = isAudio ? 'Audio' : 'Batch';
            const badgeStyle = isAudio
                ? 'background:#ede9fe;color:#6d28d9;'
                : 'background:#dbeafe;color:#1d4ed8;';
            return `
                <div class="sidebar-workflow-item flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition
                            ${isActive ? 'text-blue-700' : 'hover:bg-gray-100 text-gray-700'}"
                     data-workflow-id="${wf.id}" data-workflow-name="${this.escapeHtml(wf.name || '')}"
                     ${isActive ? 'style="background:#dbeafe; border-left:3px solid #3b82f6;"' : ''}>
                    <span class="opacity-60">${icon}</span>
                    <span class="flex-1 truncate" title="${this.escapeHtml(wf.name)} (${badgeLabel}, ID: ${wf.id})">${this.escapeHtml(wf.name || 'Untitled')}</span>
                    <span class="text-[9px] font-semibold px-1.5 py-0.5 rounded" style="${badgeStyle}">${badgeLabel}</span>
                    <button type="button"
                            class="sidebar-workflow-menu px-1 text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded transition flex-shrink-0"
                            data-workflow-id="${wf.id}" title="Options">⋮</button>
                </div>
            `;
        }).join('');

        // Add click handlers for workflow items
        listContainer.querySelectorAll('.sidebar-workflow-item').forEach(item => {
            item.addEventListener('click', (e) => {
                // Don't trigger if clicking the menu button.
                if (e.target.closest('.sidebar-workflow-menu')) return;

                const workflowId = item.dataset.workflowId;

                // Make sure the workflow editor panel is shown first
                if (window.agentTeamsPanel) {
                    window.agentTeamsPanel.show();
                }

                // Load the workflow after a short delay to ensure panel is ready
                setTimeout(() => {
                    this.loadWorkflow(parseInt(workflowId));
                }, 100);
            });

            // Right-click also opens the same context menu — matches the
            // skills sidebar convention.
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const id = parseInt(item.dataset.workflowId);
                const name = item.dataset.workflowName || '';
                this.showWorkflowContextMenu(id, name, e.clientX, e.clientY);
            });
        });

        // ⋮ menu buttons — open the context menu positioned just below
        // the button so it visually anchors to the row.
        listContainer.querySelectorAll('.sidebar-workflow-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const id = parseInt(btn.dataset.workflowId);
                const item = btn.closest('.sidebar-workflow-item');
                const name = item?.dataset.workflowName || '';
                const rect = btn.getBoundingClientRect();
                this.showWorkflowContextMenu(id, name, rect.right, rect.bottom + 2);
            });
        });
    }

    /**
     * Render and show a Rename / Delete context menu for a workflow row.
     * Self-contained: the menu is created once and reused, positioned
     * absolutely near the click. Click-outside dismisses it.
     */
    showWorkflowContextMenu(workflowId, workflowName, x, y) {
        // Build (once) and reuse a shared menu element.
        if (!this._workflowContextMenu) {
            const menu = document.createElement('div');
            menu.id = 'workflow-context-menu';
            menu.className = 'hidden absolute z-50 bg-white border border-gray-200 rounded-md shadow-lg py-1 text-sm';
            menu.style.minWidth = '140px';
            menu.innerHTML = `
                <button type="button" data-action="rename"
                        class="w-full text-left px-3 py-1.5 hover:bg-gray-100 text-gray-700 flex items-center gap-2">
                    <span>✏️</span><span data-i18n="contextMenu.rename">${this.t('contextMenu.rename')}</span>
                </button>
                <button type="button" data-action="delete"
                        class="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600 flex items-center gap-2">
                    <span>🗑️</span><span data-i18n="contextMenu.delete">${this.t('contextMenu.delete')}</span>
                </button>
            `;
            document.body.appendChild(menu);
            this._workflowContextMenu = menu;

            // Click-outside / Escape dismissal — installed once.
            document.addEventListener('click', (ev) => {
                if (!this._workflowContextMenu) return;
                if (this._workflowContextMenu.classList.contains('hidden')) return;
                if (this._workflowContextMenu.contains(ev.target)) return;
                this._workflowContextMenu.classList.add('hidden');
            });
            document.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape' && this._workflowContextMenu
                    && !this._workflowContextMenu.classList.contains('hidden')) {
                    this._workflowContextMenu.classList.add('hidden');
                }
            });

            // Action handler — closures capture the latest target via
            // `this._workflowContextTarget` (set on each open below).
            menu.querySelectorAll('button[data-action]').forEach(btn => {
                btn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    const action = btn.dataset.action;
                    this._workflowContextMenu.classList.add('hidden');
                    const target = this._workflowContextTarget;
                    if (!target) return;
                    if (action === 'rename') {
                        await this.renameWorkflow(target.id, target.name);
                    } else if (action === 'delete') {
                        await this.deleteWorkflow(target.id);
                    }
                });
            });
        }

        this._workflowContextTarget = { id: workflowId, name: workflowName };
        const menu = this._workflowContextMenu;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.classList.remove('hidden');

        // Clamp into viewport so the menu stays fully visible when the
        // workflow is near the bottom or right edge of the sidebar.
        const margin = 8;
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (rect.bottom > vh - margin) {
            menu.style.top = Math.max(margin, y - rect.height) + 'px';
        }
        if (rect.right > vw - margin) {
            menu.style.left = Math.max(margin, x - rect.width) + 'px';
        }
    }

    /**
     * Centered modal rename prompt. Replaces window.prompt(), which
     * shows the browser-native dialog anchored to the top of the
     * viewport — distracting and inconsistent with the rest of the app.
     *
     * Resolves with the entered string, or null if the user cancelled
     * (Cancel button / Escape / backdrop click).
     */
    _showRenameDialog(titleKey, promptKey, currentValue) {
        return new Promise((resolve) => {
            const backdrop = document.createElement('div');
            backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
            backdrop.innerHTML = `
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-md" role="dialog" aria-modal="true">
                    <h3 class="text-lg font-semibold text-gray-900 mb-1">${this.escapeHtml(this.t(titleKey))}</h3>
                    <p class="text-sm text-gray-600 mb-3">${this.escapeHtml(this.t(promptKey))}</p>
                    <input type="text"
                           class="rename-input w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm"
                           value="${this.escapeHtml(currentValue || '')}">
                    <div class="flex justify-end gap-2 mt-4">
                        <button type="button"
                                class="rename-cancel-btn px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md">
                            ${this.escapeHtml(this.t('common.cancel'))}
                        </button>
                        <button type="button"
                                class="rename-save-btn px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md">
                            ${this.escapeHtml(this.t('common.save'))}
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(backdrop);
            const input = backdrop.querySelector('.rename-input');
            // Focus + select on next tick so the browser commits layout first.
            setTimeout(() => { input?.focus(); input?.select(); }, 0);

            let resolved = false;
            const cleanup = (result) => {
                if (resolved) return;
                resolved = true;
                document.removeEventListener('keydown', onKey, true);
                backdrop.remove();
                resolve(result);
            };

            const onKey = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    cleanup(null);
                } else if (e.key === 'Enter' && e.target === input) {
                    e.preventDefault();
                    cleanup(input.value);
                }
            };
            document.addEventListener('keydown', onKey, true);

            backdrop.addEventListener('click', (e) => {
                if (e.target === backdrop) cleanup(null);
            });
            backdrop.querySelector('.rename-cancel-btn').addEventListener('click', () => cleanup(null));
            backdrop.querySelector('.rename-save-btn').addEventListener('click', () => cleanup(input.value));
        });
    }

    /**
     * Rename a workflow. Prompts for the new name, PUTs to the
     * workflow update endpoint, and refreshes the list. If the renamed
     * workflow is the one currently loaded in the editor, keep its
     * in-memory name in sync so the header reflects the change without
     * a reload.
     */
    async renameWorkflow(workflowId, currentName) {
        const newName = await this._showRenameDialog(
            'workflow.dialogs.renameWorkflowTitle',
            'workflow.dialogs.renameWorkflowPrompt',
            currentName || ''
        );
        if (newName === null) return; // user cancelled
        const trimmed = newName.trim();
        if (!trimmed) return;
        if (trimmed === currentName) return;

        try {
            const response = await fetch(`${this.apiBase}/workflows/${workflowId}`, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ name: trimmed })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.success === false) {
                throw new Error(data.error || data.message || `HTTP ${response.status}`);
            }
            // Keep the editor's in-memory state aligned if we just renamed
            // the workflow currently loaded on the canvas.
            if (String(this.currentWorkflowId) === String(workflowId)) {
                this.currentWorkflowName = trimmed;
                if (typeof this.updateWorkflowInfoBox === 'function') {
                    this.updateWorkflowInfoBox();
                }
            }
            await this.loadWorkflowsList();
        } catch (error) {
            console.error('[WorkflowEditor] Error renaming workflow:', error);
            alert(
                (this.t('workflow.errors.renameWorkflowFailed') || 'Failed to rename workflow: ')
                + (error.message || error)
            );
        }
    }

    /**
     * Delete a workflow
     */
    async deleteWorkflow(workflowId) {
        if (!confirm(this.t('workflow.dialogs.confirmDeleteWorkflow'))) return;

        console.log('[WorkflowEditor] Attempting to delete workflow ID:', workflowId);

        try {
            const response = await fetch(`${this.apiBase}/workflows/${workflowId}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            const responseData = await response.json();
            console.log('[WorkflowEditor] Delete response:', response.status, responseData);

            if (!response.ok) {
                throw new Error(responseData.error || 'Failed to delete workflow');
            }

            console.log('[WorkflowEditor] Workflow deleted successfully:', workflowId);

            // If we deleted the current workflow, clear the canvas
            if (String(this.currentWorkflowId) === String(workflowId)) {
                this.clearWorkflow(true);
                this.currentWorkflowId = null;
                this.currentWorkflowName = '';
                this.currentWorkflowDescription = '';
                this.updateWorkflowInfoBox();
            }

            // Refresh the list
            await this.loadWorkflowsList();
            console.log('[WorkflowEditor] Workflows list after delete:', this.workflows.map(w => ({ id: w.id, name: w.name })));

        } catch (error) {
            console.error('[WorkflowEditor] Error deleting workflow:', error);
            alert(this.t('workflow.errors.deleteWorkflowFailed', { error: error.message }));
        }
    }

    /**
     * Render a single agent card
     */
    renderAgentCard(agent, isRealtimeMode = false) {
        const typeIcon = agent.agent_type === 'worker' ? '⚙️' : '🤖';
        const typeClass = agent.agent_type || 'standard';
        const providerDisplay = agent.provider || agent.llm_provider || '';
        const isTemplate = agent.is_template || false;

        // Apply saved-template styling for agents marked as templates
        const cardClass = isTemplate
            ? `workflow-agent-card ${typeClass} saved-template`
            : `workflow-agent-card ${typeClass}`;

        const iconStyle = isTemplate
            ? 'background: #ecfdf5; color: #10b981;'
            : '';

        return `
            <div class="${cardClass}"
                 draggable="true"
                 data-node-type="agent"
                 data-agent-id="${agent.id}"
                 data-agent-name="${this.escapeHtml(agent.name)}"
                 data-agent-type="${agent.agent_type || 'standard'}"
                 data-agent-provider="${this.escapeHtml(providerDisplay)}"
                 ${isTemplate ? 'data-is-template="true"' : ''}>
                <div class="agent-icon" ${iconStyle ? `style="${iconStyle}"` : ''}>${typeIcon}</div>
                <div class="agent-info">
                    <div class="agent-name">${this.escapeHtml(agent.name)}</div>
                    <div class="agent-type">${this.t('workflow.worker')}</div>
                </div>
                ${isTemplate ? '<span class="template-badge" title="Reusable template">✓</span>' : ''}
                <button class="agent-edit-btn" data-agent-id="${agent.id}" title="Edit agent">
                    ✏️
                </button>
            </div>
        `;
    }

    /**
     * Add SVG arrowhead marker for connection lines
     */
    addArrowheadMarker() {
        // Wait for Drawflow to create its SVG element
        setTimeout(() => {
            // Try different selectors for the SVG element
            let svg = this.container.querySelector('svg.connection');
            if (!svg) {
                svg = this.container.querySelector('.drawflow svg');
            }
            if (!svg) {
                svg = this.container.querySelector('svg');
            }

            console.log('[WorkflowEditor] Looking for SVG:', svg);

            if (!svg) {
                console.warn('[WorkflowEditor] SVG not found, retrying...');
                setTimeout(() => this.addArrowheadMarker(), 500);
                return;
            }

            // Check if marker already exists
            if (document.getElementById('arrowhead')) {
                console.log('[WorkflowEditor] Arrowhead marker already exists');
                return;
            }

            // Create defs element if it doesn't exist
            let defs = svg.querySelector('defs');
            if (!defs) {
                defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                svg.insertBefore(defs, svg.firstChild);
            }

            // Create arrowhead marker (default color)
            const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            marker.setAttribute('id', 'arrowhead');
            marker.setAttribute('markerWidth', '10');
            marker.setAttribute('markerHeight', '10');
            marker.setAttribute('refX', '8');
            marker.setAttribute('refY', '3');
            marker.setAttribute('orient', 'auto');
            marker.setAttribute('markerUnits', 'strokeWidth');

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M0,0 L0,6 L9,3 z');
            path.setAttribute('fill', '#64748b');

            marker.appendChild(path);
            defs.appendChild(marker);

            // Create hover arrowhead marker (blue color)
            const markerHover = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            markerHover.setAttribute('id', 'arrowhead-hover');
            markerHover.setAttribute('markerWidth', '10');
            markerHover.setAttribute('markerHeight', '10');
            markerHover.setAttribute('refX', '8');
            markerHover.setAttribute('refY', '3');
            markerHover.setAttribute('orient', 'auto');
            markerHover.setAttribute('markerUnits', 'strokeWidth');

            const pathHover = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            pathHover.setAttribute('d', 'M0,0 L0,6 L9,3 z');
            pathHover.setAttribute('fill', '#3b82f6');

            markerHover.appendChild(pathHover);
            defs.appendChild(markerHover);

            console.log('[WorkflowEditor] Arrowhead markers added to:', svg);
        }, 100);
    }

    /**
     * Add zoom controls overlay to the canvas
     */
    addZoomControls() {
        // Create zoom controls container
        const zoomControls = document.createElement('div');
        zoomControls.className = 'workflow-zoom-controls';
        zoomControls.innerHTML = `
            <button class="zoom-btn" id="zoom-in-btn" title="${this.t('workflow.zoom.in')}">+</button>
            <span class="zoom-level" id="zoom-level">100%</span>
            <button class="zoom-btn" id="zoom-out-btn" title="${this.t('workflow.zoom.out')}">−</button>
            <button class="zoom-btn zoom-reset" id="zoom-reset-btn" title="${this.t('workflow.zoom.reset')}">⟲</button>
        `;

        // Add to container (the canvas parent)
        this.container.style.position = 'relative';
        this.container.appendChild(zoomControls);

        // Set up event handlers
        document.getElementById('zoom-in-btn').addEventListener('click', () => {
            this.editor.zoom_in();
            this.updateZoomLevel();
        });

        document.getElementById('zoom-out-btn').addEventListener('click', () => {
            this.editor.zoom_out();
            this.updateZoomLevel();
        });

        document.getElementById('zoom-reset-btn').addEventListener('click', () => {
            this.editor.zoom_reset();
            this.updateZoomLevel();
        });

        // Listen for zoom changes from mouse wheel
        this.editor.on('zoom', () => {
            this.updateZoomLevel();
        });
    }

    /**
     * Update zoom level display
     */
    updateZoomLevel() {
        const zoomLevel = document.getElementById('zoom-level');
        if (zoomLevel) {
            const percentage = Math.round(this.editor.zoom * 100);
            zoomLevel.textContent = `${percentage}%`;
        }
    }

    /**
     * Add workflow info box to the canvas
     */
    addWorkflowInfoBox() {
        const infoBox = document.createElement('div');
        infoBox.id = 'workflow-info-box';
        infoBox.className = 'workflow-info-box';
        infoBox.innerHTML = `
            <button id="workflow-info-close" class="workflow-info-close" title="Collapse">&times;</button>
            <div class="workflow-info-toggle" title="Click to expand">
                <span>📝</span>
                <span>${this.t('workflow.batchWorkflowSettings')}</span>
                <span class="workflow-info-chevron">&#9660;</span>
            </div>
            <div class="workflow-form-group">
                <label class="workflow-form-label">Name</label>
                <input type="text" id="workflow-name-input" class="workflow-name-input" value="">
            </div>
            <div class="workflow-form-group">
                <label class="workflow-form-label">Description</label>
                <textarea id="workflow-description-input" class="workflow-description-input"
                          rows="2"></textarea>
            </div>
            <div class="workflow-form-group workflow-schedule-toggle">
                <label class="workflow-toggle-label">
                    <input type="checkbox" id="workflow-schedule-enabled" class="workflow-toggle-checkbox">
                    <span class="workflow-toggle-switch"></span>
                    <span class="workflow-toggle-text">Schedule Enabled</span>
                </label>
                <div class="workflow-schedule-hint">When enabled, attachments are stored remotely for offline execution</div>
            </div>
            <div class="workflow-btn-group">
                <button id="workflow-import-btn" class="workflow-io-btn" title="Import a workflow from a JSON file">
                    📥 Import
                </button>
                <button id="workflow-export-btn" class="workflow-io-btn" title="Export the current workflow as JSON">
                    📤 Export
                </button>
            </div>
            <div class="workflow-btn-group">
                <button id="workflow-save-btn" class="workflow-save-btn" title="Save Workflow">
                    Save
                </button>
                <button id="workflow-delete-btn" class="workflow-delete-btn" title="Delete Workflow">
                    Delete
                </button>
            </div>
        `;

        // Add styles
        const style = document.createElement('style');
        style.textContent = `
            .workflow-info-box {
                position: absolute;
                top: 12px;
                right: 12px;
                z-index: 10;
                background: white;
                border: 1px solid #e2e8f0;
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.1);
                min-width: 280px;
                max-width: 350px;
            }
            .workflow-info-box.collapsed {
                padding: 6px 12px;
                min-width: auto;
                cursor: pointer;
                border-radius: 6px;
                box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            }
            .workflow-info-box.collapsed > *:not(.workflow-info-toggle) {
                display: none;
            }
            .workflow-info-close {
                position: absolute;
                top: 8px;
                right: 8px;
                width: 24px;
                height: 24px;
                border: none;
                background: transparent;
                color: #9ca3af;
                font-size: 20px;
                font-weight: 300;
                line-height: 1;
                cursor: pointer;
                border-radius: 4px;
                transition: all 0.15s ease;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .workflow-info-close:hover {
                background: #f3f4f6;
                color: #374151;
            }
            .workflow-info-toggle {
                display: none;
                font-size: 13px;
                font-weight: 500;
                color: #374151;
            }
            .workflow-info-box.collapsed .workflow-info-toggle {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .workflow-info-chevron {
                font-size: 10px;
                color: #6b7280;
                margin-left: 4px;
                transition: transform 0.2s ease;
                animation: workflow-chevron-pulse 2s ease-in-out infinite;
            }
            .workflow-info-box.collapsed:hover .workflow-info-chevron {
                color: #3b82f6;
                transform: translateY(2px);
            }
            @keyframes workflow-chevron-pulse {
                0%, 100% { transform: translateY(0); opacity: 0.7; }
                50% { transform: translateY(2px); opacity: 1; }
            }
            .workflow-form-group {
                margin-bottom: 12px;
            }
            .workflow-form-label {
                display: block;
                font-size: 13px;
                font-weight: 600;
                color: #374151;
                margin-bottom: 6px;
            }
            .workflow-name-input {
                width: 100%;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                color: #1f2937;
                background: white;
                padding: 10px 12px;
                outline: none;
                transition: border-color 0.2s, box-shadow 0.2s;
                box-sizing: border-box;
            }
            .workflow-name-input:hover {
                border-color: #9ca3af;
            }
            .workflow-name-input:focus {
                border-color: #3b82f6;
                box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
            }
            .workflow-btn-group {
                display: flex;
                gap: 8px;
                margin-top: 12px;
            }
            .workflow-save-btn {
                flex: 1;
                padding: 10px 18px;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                color: white;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            .workflow-save-btn:hover {
                background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
            }
            .workflow-delete-btn {
                padding: 10px 18px;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                color: white;
                transition: all 0.2s ease;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
            }
            .workflow-delete-btn:hover {
                background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
            }
            .workflow-delete-btn:disabled {
                background: #d1d5db;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }
            .workflow-io-btn {
                flex: 1;
                padding: 8px 14px;
                border: 1px solid #c7d2fe;
                border-radius: 8px;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                background: #eef2ff;
                color: #4338ca;
                transition: all 0.15s ease;
            }
            .workflow-io-btn:hover {
                background: #e0e7ff;
                border-color: #a5b4fc;
            }
            .workflow-description-input {
                width: 100%;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                font-size: 14px;
                color: #1f2937;
                background: white;
                padding: 10px 12px;
                outline: none;
                resize: vertical;
                min-height: 60px;
                max-height: 120px;
                transition: border-color 0.2s, box-shadow 0.2s;
                font-family: inherit;
                box-sizing: border-box;
            }
            .workflow-description-input:hover {
                border-color: #9ca3af;
            }
            .workflow-description-input:focus {
                border-color: #3b82f6;
                box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
            }
            .workflow-schedule-toggle {
                margin-top: 8px;
                padding-top: 12px;
                border-top: 1px solid #e5e7eb;
            }
            .workflow-toggle-label {
                display: flex;
                align-items: center;
                gap: 10px;
                cursor: pointer;
                user-select: none;
            }
            .workflow-toggle-checkbox {
                display: none;
            }
            .workflow-toggle-switch {
                position: relative;
                width: 36px;
                height: 20px;
                background: #d1d5db;
                border-radius: 10px;
                transition: background 0.2s;
                flex-shrink: 0;
            }
            .workflow-toggle-switch::after {
                content: '';
                position: absolute;
                top: 2px;
                left: 2px;
                width: 16px;
                height: 16px;
                background: white;
                border-radius: 50%;
                transition: transform 0.2s;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            }
            .workflow-toggle-checkbox:checked + .workflow-toggle-switch {
                background: #3b82f6;
            }
            .workflow-toggle-checkbox:checked + .workflow-toggle-switch::after {
                transform: translateX(16px);
            }
            .workflow-toggle-text {
                font-size: 13px;
                font-weight: 500;
                color: #374151;
            }
            .workflow-schedule-hint {
                font-size: 11px;
                color: #6b7280;
                margin-top: 6px;
                line-height: 1.4;
            }
        `;
        document.head.appendChild(style);

        // Add to container
        this.container.appendChild(infoBox);

        // Hidden by default — shown only after workflow type is chosen (batch)
        // or when loading an existing batch workflow. Audio workflows have their
        // own form and keep this hidden.
        infoBox.style.display = 'none';

        // Set up event handlers
        const nameInput = document.getElementById('workflow-name-input');
        const descInput = document.getElementById('workflow-description-input');
        const scheduleCheckbox = document.getElementById('workflow-schedule-enabled');
        const saveBtn = document.getElementById('workflow-save-btn');

        nameInput.addEventListener('input', (e) => {
            this.currentWorkflowName = e.target.value;
        });

        descInput.addEventListener('input', (e) => {
            this.currentWorkflowDescription = e.target.value;
        });

        scheduleCheckbox.addEventListener('change', (e) => {
            this.scheduleEnabled = e.target.checked;
            this.updateDocumentStorageMode();
            this.updateLocalStorageGroupState();
        });

        saveBtn.addEventListener('click', () => {
            this.saveWorkflow();
        });

        // Import / Export — JSON interchange. Export reuses the existing
        // _showWorkflowJson() modal (with a Download .json button added);
        // Import re-hydrates the canvas from a pasted/uploaded JSON file.
        // onclick (single slot), not addEventListener — this binding code re-runs
        // on re-init; addEventListener would stack listeners → duplicate pickers.
        const importBtn = document.getElementById('workflow-import-btn');
        if (importBtn) importBtn.onclick = () => this._handleImportWorkflow();
        const exportBtn = document.getElementById('workflow-export-btn');
        if (exportBtn) exportBtn.onclick = () => this._showWorkflowJson();

        // Delete button handler
        const deleteBtn = document.getElementById('workflow-delete-btn');
        deleteBtn.addEventListener('click', () => {
            if (this.currentWorkflowId) {
                this.deleteWorkflow(this.currentWorkflowId);
            } else {
                // No saved workflow - just clear the canvas
                if (confirm(this.t('workflow.dialogs.confirmClearUnsavedWorkflow'))) {
                    this.clearCanvas();
                    this.currentWorkflowName = '';
                    this.currentWorkflowDescription = '';
                    document.getElementById('workflow-name-input').value = '';
                    document.getElementById('workflow-description-input').value = '';
                }
            }
        });
        // Update delete button state based on whether workflow is saved
        this.updateDeleteButtonState();

        // Prevent Drawflow from capturing these inputs
        [nameInput, descInput].forEach(input => {
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('keydown', (e) => e.stopPropagation());
        });

        // Close/collapse button handler
        const closeBtn = document.getElementById('workflow-info-close');
        const toggleEl = infoBox.querySelector('.workflow-info-toggle');

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            infoBox.classList.add('collapsed');
        });

        // Toggle to expand when collapsed
        toggleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            infoBox.classList.remove('collapsed');
        });

        // Also expand when clicking on collapsed box
        infoBox.addEventListener('click', (e) => {
            if (infoBox.classList.contains('collapsed')) {
                infoBox.classList.remove('collapsed');
            }
        });
    }

    /**
     * Auto-collapse the workflow settings form a few seconds after it's shown.
     * Users see the form briefly so they know it's there, then the canvas
     * takes back most of the screen. The user can re-expand by clicking the
     * collapsed bar (existing handler in addWorkflowInfoBox / addAudioWorkflowInfoBox).
     */
    _scheduleFormAutoCollapse(infoBox, delayMs = 3000) {
        if (!infoBox) return;
        if (this._formAutoCollapseTimer) {
            clearTimeout(this._formAutoCollapseTimer);
            this._formAutoCollapseTimer = null;
        }
        infoBox.classList.remove('collapsed');
        this._formAutoCollapseTimer = setTimeout(() => {
            // Don't collapse if the user is actively editing (focus inside).
            if (infoBox.contains(document.activeElement)) return;
            infoBox.classList.add('collapsed');
            this._formAutoCollapseTimer = null;
        }, delayMs);
    }

    addAudioWorkflowInfoBox() {
        const infoBox = document.createElement('div');
        infoBox.id = 'audio-workflow-info-box';
        infoBox.className = 'workflow-info-box';
        infoBox.innerHTML = `
            <button id="audio-workflow-info-close" class="workflow-info-close" title="Collapse">&times;</button>
            <div class="workflow-info-toggle" title="Click to expand">
                <span>🎙</span>
                <span>${this.t('workflow.realtime.audioWorkflowSettings')}</span>
                <span class="workflow-info-chevron">&#9660;</span>
            </div>
            <div class="workflow-form-group">
                <label class="workflow-form-label">Name</label>
                <input type="text" id="audio-workflow-name-input" class="workflow-name-input" value="">
            </div>
            <div class="workflow-form-group">
                <label class="workflow-form-label">LLM</label>
                <select id="audio-workflow-llm-select" class="workflow-name-input">
                    <option value="grok">Grok</option>
                    <option value="gemini">Gemini</option>
                </select>
            </div>
            <div class="workflow-form-group">
                <label class="workflow-form-label">Description</label>
                <textarea id="audio-workflow-description-input" class="workflow-description-input"
                          rows="2"></textarea>
            </div>
            <div class="workflow-btn-group">
                <button id="audio-workflow-save-btn" class="workflow-save-btn" title="Save Workflow">
                    Save
                </button>
                <button id="audio-workflow-delete-btn" class="workflow-delete-btn" title="Delete Workflow">
                    Delete
                </button>
            </div>
        `;

        this.container.appendChild(infoBox);
        infoBox.style.display = 'none';

        const nameInput = document.getElementById('audio-workflow-name-input');
        const descInput = document.getElementById('audio-workflow-description-input');
        const llmSelect = document.getElementById('audio-workflow-llm-select');
        const saveBtn = document.getElementById('audio-workflow-save-btn');
        const deleteBtn = document.getElementById('audio-workflow-delete-btn');
        const closeBtn = document.getElementById('audio-workflow-info-close');
        const toggleEl = infoBox.querySelector('.workflow-info-toggle');

        nameInput.addEventListener('input', (e) => {
            this.currentWorkflowName = e.target.value;
        });
        descInput.addEventListener('input', (e) => {
            this.currentWorkflowDescription = e.target.value;
        });
        llmSelect.addEventListener('change', (e) => {
            this.audioLlmProvider = e.target.value;
        });
        saveBtn.addEventListener('click', () => this.saveWorkflow());
        deleteBtn.addEventListener('click', () => {
            if (this.currentWorkflowId) {
                this.deleteWorkflow(this.currentWorkflowId);
            } else if (confirm(this.t('workflow.dialogs.confirmClearUnsavedWorkflow'))) {
                this.clearCanvas();
                this.currentWorkflowName = '';
                this.currentWorkflowDescription = '';
                nameInput.value = '';
                descInput.value = '';
            }
        });

        [nameInput, descInput].forEach(input => {
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('keydown', (e) => e.stopPropagation());
        });

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            infoBox.classList.add('collapsed');
        });
        toggleEl.addEventListener('click', (e) => {
            e.stopPropagation();
            infoBox.classList.remove('collapsed');
        });
        infoBox.addEventListener('click', () => {
            if (infoBox.classList.contains('collapsed')) {
                infoBox.classList.remove('collapsed');
            }
        });
    }

    /**
     * Update workflow info box display
     */
    updateWorkflowInfoBox() {
        const nameInput = document.getElementById('workflow-name-input');
        const descInput = document.getElementById('workflow-description-input');
        const scheduleCheckbox = document.getElementById('workflow-schedule-enabled');

        if (nameInput) {
            nameInput.value = this.currentWorkflowName || '';
        }
        if (descInput) {
            descInput.value = this.currentWorkflowDescription || '';
        }
        if (scheduleCheckbox) {
            scheduleCheckbox.checked = this.scheduleEnabled;
        }

        const audioName = document.getElementById('audio-workflow-name-input');
        const audioDesc = document.getElementById('audio-workflow-description-input');
        const audioLlm = document.getElementById('audio-workflow-llm-select');
        if (audioName) audioName.value = this.currentWorkflowName || '';
        if (audioDesc) audioDesc.value = this.currentWorkflowDescription || '';
        if (audioLlm) audioLlm.value = this.audioLlmProvider || 'grok';

        // Update local storage group state and display
        this.updateLocalStorageGroupState();
        this.updateLocalFolderDisplay();

        // Update delete button state
        this.updateDeleteButtonState();
    }

    /**
     * Update the local storage group state (enabled/disabled based on schedule)
     */
    updateLocalStorageGroupState() {
        const localStorageGroup = document.getElementById('workflow-local-storage-group');
        if (localStorageGroup) {
            if (this.scheduleEnabled) {
                localStorageGroup.classList.add('disabled');
            } else {
                localStorageGroup.classList.remove('disabled');
            }
        }
    }

    /**
     * Update the delete button state based on workflow save status
     */
    updateDeleteButtonState() {
        const deleteBtn = document.getElementById('workflow-delete-btn');
        if (!deleteBtn) return;

        // Always enabled - shows "Delete" for saved workflows, allows "Clear" for unsaved
        deleteBtn.disabled = false;
        deleteBtn.title = this.currentWorkflowId ? 'Delete Workflow' : 'Clear Workflow';
    }

    /**
     * Update the local folder display name
     */
    updateLocalFolderDisplay() {
        const folderNameEl = document.getElementById('workflow-local-folder-name');
        if (!folderNameEl) return;

        if (this.localFsAdapter && this.localFolderName) {
            folderNameEl.textContent = this.localFolderName;
            folderNameEl.classList.add('configured');
        } else {
            folderNameEl.textContent = 'Not configured';
            folderNameEl.classList.remove('configured');
        }
    }

    /**
     * Select local attachments folder
     */
    async selectLocalAttachmentsFolder() {
        if (!this.currentWorkflowId) {
            this.showToast(this.t('workflow.messages.saveFirst'), 'warning');
            return;
        }

        try {
            const ufs = await this.initUniversalFS();
            if (!ufs) {
                this.showToast(this.t('workflow.fileStorage.storageNotAvailable'), 'error');
                return;
            }

            // Check if File System Access API is supported
            if (!this.fsFeatures?.fileSystemAccess) {
                this.showToast(this.t('workflow.fileStorage.localStorageNotSupported'), 'error');
                return;
            }

            // Prompt user to select directory
            this.localFsAdapter = await ufs.connect('filesystem-access');

            // Get folder name for display
            const handle = this.localFsAdapter.getRootHandle();
            this.localFolderName = handle?.name || 'Selected folder';

            // Save handle for this workflow
            await this.saveLocalFsHandleForWorkflow(this.currentWorkflowId, handle);

            // Update display
            this.updateLocalFolderDisplay();
            this.showToast(this.t('workflow.fileStorage.localFolderSet', { name: this.localFolderName }), 'success');

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[WorkflowEditor] User cancelled folder selection');
            } else {
                console.error('[WorkflowEditor] Failed to select folder:', error);
                this.showToast(this.t('workflow.fileStorage.failedToSelectFolder'), 'error');
            }
        }
    }

    /**
     * Save folder handle for a specific workflow
     */
    async saveLocalFsHandleForWorkflow(workflowId, handle) {
        if (!handle) return;

        try {
            const dbName = 'workflow-local-storage';
            const storeName = 'folder-handles';

            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
                request.onupgradeneeded = (e) => {
                    const database = e.target.result;
                    if (!database.objectStoreNames.contains(storeName)) {
                        database.createObjectStore(storeName, { keyPath: 'workflowId' });
                    }
                };
            });

            await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                const store = tx.objectStore(storeName);
                store.put({ workflowId, handle, folderName: handle.name });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });

            db.close();
            console.log('[WorkflowEditor] Saved folder handle for workflow:', workflowId);
        } catch (error) {
            console.error('[WorkflowEditor] Failed to save folder handle:', error);
        }
    }

    /**
     * Load folder handle for a specific workflow
     */
    async loadLocalFsHandleForWorkflow(workflowId) {
        try {
            const dbName = 'workflow-local-storage';
            const storeName = 'folder-handles';

            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve(request.result);
                request.onupgradeneeded = (e) => {
                    const database = e.target.result;
                    if (!database.objectStoreNames.contains(storeName)) {
                        database.createObjectStore(storeName, { keyPath: 'workflowId' });
                    }
                };
            });

            const result = await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readonly');
                const store = tx.objectStore(storeName);
                const request = store.get(workflowId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            db.close();

            if (result && result.handle) {
                // Verify we still have permission
                const permission = await result.handle.queryPermission({ mode: 'readwrite' });
                if (permission === 'granted') {
                    return { handle: result.handle, folderName: result.folderName };
                }

                // Permission not granted - return null silently instead of prompting
                // User can re-connect the folder manually if needed
            }

            return null;
        } catch (error) {
            console.error('[WorkflowEditor] Failed to load folder handle:', error);
            return null;
        }
    }

    /**
     * Restore local folder connection for a workflow
     */
    async restoreLocalFolderForWorkflow(workflowId) {
        // Reset current folder state
        this.localFsAdapter = null;
        this.localFolderName = null;

        try {
            const saved = await this.loadLocalFsHandleForWorkflow(workflowId);
            if (saved && saved.handle) {
                const ufs = await this.initUniversalFS();
                if (ufs) {
                    this.localFsAdapter = await ufs.connect('filesystem-access', { handle: saved.handle });
                    this.localFolderName = saved.folderName;
                    console.log('[WorkflowEditor] Restored local folder for workflow:', workflowId, saved.folderName);
                }
            }
        } catch (error) {
            console.error('[WorkflowEditor] Failed to restore local folder:', error);
        }

        // Update display
        this.updateLocalFolderDisplay();
    }

    /**
     * Update document storage mode based on schedule setting
     * When schedule is enabled, documents must be stored remotely
     */
    updateDocumentStorageMode() {
        // This method is called when schedule toggle changes
        console.log('[WorkflowEditor] Schedule enabled:', this.scheduleEnabled,
                    '- Documents will be stored', this.scheduleEnabled ? 'remotely' : 'locally or remotely');
    }

    // =========================================================================
    // UNIVERSALFS INTEGRATION
    // =========================================================================

    /**
     * Initialize UniversalFS client (lazy loading via dynamic import)
     */
    async initUniversalFS() {
        if (this.universalFS) return this.universalFS;

        try {
            const module = await import('/universalfs/js/index.js');
            const token = window.authManager?.token || window.authManager?.getToken?.();

            this.universalFS = new module.UniversalFS({
                serverEndpoint: this.universalFSEndpoint,
                authToken: token
            });

            // Store feature detection
            this.fsFeatures = module.FEATURES;

            console.log('[WorkflowEditor] UniversalFS initialized, features:', this.fsFeatures);
            return this.universalFS;
        } catch (error) {
            console.error('[WorkflowEditor] Failed to load UniversalFS:', error);
            return null;
        }
    }

    /**
     * Connect to local filesystem (File System Access API)
     * Prompts user to select a directory for document storage
     */
    async connectLocalStorage() {
        const ufs = await this.initUniversalFS();
        if (!ufs) return null;

        // Check if File System Access API is supported
        if (!this.fsFeatures?.fileSystemAccess) {
            this.showToast(this.t('workflow.fileStorage.localStorageNotSupported'), 'error');
            return null;
        }

        try {
            // 1. Workflow-specific saved handle (highest priority — lets
            //    advanced users keep different workflows in different
            //    folders if they want).
            const savedHandle = await this.loadLocalFsHandle();
            if (savedHandle) {
                this.localFsAdapter = await ufs.connect('filesystem-access', { handle: savedHandle });
                console.log('[WorkflowEditor] Restored local filesystem connection');
                return this.localFsAdapter;
            }

            // 2. Reuse the app-wide synergyAI root the user already
            //    granted for skills/outputs. Avoids re-prompting them for
            //    a folder just to attach a workflow document — the same
            //    folder works fine for both.
            if (window.localFs) {
                try {
                    const globalHandle = await window.localFs.getRootHandle();
                    if (globalHandle) {
                        this.localFsAdapter = await ufs.connect('filesystem-access', { handle: globalHandle });
                        console.log('[WorkflowEditor] Reusing app-wide synergyAI root for workflow documents');
                        return this.localFsAdapter;
                    }
                } catch (e) {
                    console.warn('[WorkflowEditor] Could not reuse app-wide root:', e);
                }
            }

            // 3. Last resort: prompt the user to pick a directory.
            this.localFsAdapter = await ufs.connect('filesystem-access');
            const handle = this.localFsAdapter.getRootHandle();
            await this.saveLocalFsHandle(handle);

            console.log('[WorkflowEditor] Connected to local filesystem');
            return this.localFsAdapter;
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[WorkflowEditor] User cancelled directory selection');
            } else {
                console.error('[WorkflowEditor] Failed to connect to local storage:', error);
            }
            return null;
        }
    }

    /**
     * Connect to remote storage (S3 via PHP backend)
     */
    async connectRemoteStorage() {
        const ufs = await this.initUniversalFS();
        if (!ufs) return null;

        try {
            this.remoteFsAdapter = await ufs.connect('s3');
            console.log('[WorkflowEditor] Connected to remote storage (S3)');
            return this.remoteFsAdapter;
        } catch (error) {
            console.error('[WorkflowEditor] Failed to connect to remote storage:', error);
            return null;
        }
    }

    /**
     * Save local filesystem handle to IndexedDB for persistence.
     * Uses raw IDB (not the idb wrapper), so IDBRequest must be
     * promisified explicitly — otherwise `await req` resolves with the
     * IDBRequest object instead of the stored value, and the load path
     * fails with `TypeError: handle.queryPermission is not a function`.
     */
    async saveLocalFsHandle(handle) {
        if (!handle) return;
        try {
            const db = await this.openHandleDB();
            await new Promise((resolve, reject) => {
                const tx = db.transaction('handles', 'readwrite');
                tx.objectStore('handles').put(handle, 'workflowDocsHandle');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch (error) {
            console.warn('[WorkflowEditor] Could not save filesystem handle:', error);
        }
    }

    /**
     * Load local filesystem handle from IndexedDB.
     */
    async loadLocalFsHandle() {
        try {
            const db = await this.openHandleDB();
            const handle = await new Promise((resolve, reject) => {
                const tx = db.transaction('handles', 'readonly');
                const req = tx.objectStore('handles').get('workflowDocsHandle');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            if (handle && typeof handle.queryPermission === 'function') {
                const permission = await handle.queryPermission({ mode: 'readwrite' });
                if (permission === 'granted') {
                    return handle;
                }
                // Permission not granted — return null silently. User can
                // re-connect the folder manually if needed.
            }
        } catch (error) {
            console.warn('[WorkflowEditor] Could not load filesystem handle:', error);
        }
        return null;
    }

    /**
     * Open IndexedDB for filesystem handle storage
     */
    async openHandleDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('WorkflowEditorFS', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('handles')) {
                    db.createObjectStore('handles');
                }
            };
        });
    }

    /**
     * Check if File System Access API is available
     */
    isLocalStorageAvailable() {
        return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
    }

    /**
     * Get storage path for workflow documents
     */
    getDocumentStoragePath(workflowId, docId, filename) {
        return `workflow_docs/${workflowId}/${docId}_${filename}`;
    }

    /**
     * Properly remove a connection from Drawflow's internal data structure
     * This ensures the connection won't reappear when the workflow is saved/loaded
     */
    removeConnectionProperly(connectionEl) {
        if (!connectionEl) return;

        // Parse the class attribute to get connection info
        const classAttr = connectionEl.getAttribute('class') || '';
        const classes = classAttr.split(' ');

        let nodeOut, nodeIn, outputClass, inputClass;

        classes.forEach(cls => {
            if (cls.startsWith('node_out_node-')) nodeOut = cls.replace('node_out_node-', '');
            else if (cls.startsWith('node_out_')) nodeOut = cls.replace('node_out_', '');
            if (cls.startsWith('node_in_node-')) nodeIn = cls.replace('node_in_node-', '');
            else if (cls.startsWith('node_in_')) nodeIn = cls.replace('node_in_', '');
            if (cls.startsWith('output_')) outputClass = cls;
            if (cls.startsWith('input_')) inputClass = cls;
        });

        if (nodeOut && nodeIn && outputClass && inputClass) {
            try {
                // Use Drawflow's API to properly remove from internal data
                this.editor.removeSingleConnection(nodeOut, nodeIn, outputClass, inputClass);
            } catch (err) {
                // Fallback: manually update Drawflow's internal data structure
                this.removeConnectionFromDrawflowData(nodeOut, nodeIn, outputClass, inputClass);
                connectionEl.remove();
            }
        } else {
            // Fallback: remove from Drawflow data by searching
            this.removeConnectionByElement(connectionEl);
            connectionEl.remove();
        }
    }

    /**
     * Manually remove connection from Drawflow's internal data structure
     */
    removeConnectionFromDrawflowData(nodeOut, nodeIn, outputClass, inputClass) {
        try {
            const data = this.editor.drawflow.drawflow.Home.data;

            // Remove from source node's outputs
            if (data[nodeOut]?.outputs?.[outputClass]?.connections) {
                const connections = data[nodeOut].outputs[outputClass].connections;
                const index = connections.findIndex(
                    c => c.node === nodeIn && c.output === inputClass
                );
                if (index > -1) {
                    connections.splice(index, 1);
                    console.log('[WorkflowEditor] Removed from source node outputs');
                }
            }

            // Remove from target node's inputs
            if (data[nodeIn]?.inputs?.[inputClass]?.connections) {
                const connections = data[nodeIn].inputs[inputClass].connections;
                const index = connections.findIndex(
                    c => c.node === nodeOut && c.input === outputClass
                );
                if (index > -1) {
                    connections.splice(index, 1);
                    console.log('[WorkflowEditor] Removed from target node inputs');
                }
            }
        } catch (e) {
            console.error('[WorkflowEditor] Error removing from Drawflow data:', e);
        }
    }

    /**
     * Remove a connection by its SVG element (searches Drawflow data)
     */
    removeConnectionByElement(connectionEl) {
        try {
            const data = this.editor.drawflow.drawflow.Home.data;

            // Search all nodes for connections and remove matching ones
            Object.entries(data).forEach(([nodeId, node]) => {
                if (node.outputs) {
                    Object.entries(node.outputs).forEach(([outputName, output]) => {
                        if (output.connections) {
                            // Filter out any connections whose SVG might match
                            // This is a fallback, so we just clear orphaned connections
                        }
                    });
                }
            });
        } catch (e) {
            console.error('[WorkflowEditor] Error in removeConnectionByElement:', e);
        }
    }

    /**
     * Style all connection lines with animated dashed effect
     */
    styleConnections() {
        setTimeout(() => {
            const connections = this.container.querySelectorAll('.connection .main-path, svg.connection path.main-path');
            console.log('[WorkflowEditor] Styling connections:', connections.length);

            connections.forEach(path => {
                // Add a class for CSS styling
                path.classList.add('animated-connection');
            });
        }, 50);
    }

    /**
     * Inject CSS styles for animated connections
     */
    injectConnectionStyles() {
        // Check if styles already injected
        if (document.getElementById('connection-animation-styles')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'connection-animation-styles';
        style.textContent = `
            .drawflow .connection .main-path,
            .drawflow .connection .main-path.animated-connection,
            svg.connection path.main-path {
                stroke: #8899aa !important;
                stroke-width: 4px !important;
                fill: none !important;
                stroke-linecap: round !important;
                stroke-dasharray: 12 6 !important;
                animation: connectionFlowAnim 1s linear infinite !important;
            }

            @keyframes connectionFlowAnim {
                from { stroke-dashoffset: 18; }
                to { stroke-dashoffset: 0; }
            }

            .drawflow .connection:hover .main-path {
                stroke: #60a5fa !important;
                stroke-width: 5px !important;
            }
        `;
        document.head.appendChild(style);
        console.log('[WorkflowEditor] Connection animation styles injected');
    }

    /**
     * Set up Drawflow editor events
     */
    setupEditorEvents() {
        // Node selected
        this.editor.on('nodeSelected', (nodeId) => {
            console.log('[WorkflowEditor] Node selected:', nodeId);
        });

        // Connection created
        this.editor.on('connectionCreated', (connection) => {
            console.log('[WorkflowEditor] Connection created:', connection);
            // Enforce the ingestion pipeline (start → loader → splitter →
            // vectorstore → output). If an ingestion node is involved and the
            // edge isn't a valid pipeline pair, undo it immediately.
            if (!this._isValidIngestionConnection(connection)) {
                try {
                    this.editor.removeSingleConnection(
                        connection.output_id, connection.input_id,
                        connection.output_class, connection.input_class
                    );
                } catch (e) { /* connection already gone */ }
                const msg = this.t('workflow.ingestion.invalidConnection')
                    || 'Invalid connection — ingestion pipeline must be start → loader → splitter → vector store → output.';
                if (this.showToast) this.showToast(msg, 'error'); else console.warn(msg);
                return;
            }
            // Apply animated styles to the new connection
            this.styleConnections();
            // Graph changed — flip the Output node variant if needed.
            this.refreshOutputNodeVariant();
            this.refreshStartNodeVariant();
            this._scheduleStructureSave();
        });

        // Connection removed — graph changed, refresh the Output node variant.
        this.editor.on('connectionRemoved', (connection) => {
            console.log('[WorkflowEditor] Connection removed:', connection);
            this.refreshOutputNodeVariant();
            this.refreshStartNodeVariant();
            this._scheduleStructureSave();
        });

        // Connection start (dragging from output)
        this.editor.on('connectionStart', (connection) => {
            console.log('[WorkflowEditor] Connection started:', connection);
        });

        // Connection cancel
        this.editor.on('connectionCancel', (connection) => {
            console.log('[WorkflowEditor] Connection cancelled:', connection);
        });

        // Node removed
        this.editor.on('nodeRemoved', (nodeId) => {
            console.log('[WorkflowEditor] Node removed:', nodeId);
            // Removing the last ingestion node flips the Output node back to
            // the agent variant.
            this.refreshOutputNodeVariant();
            this.refreshStartNodeVariant();
            this._scheduleStructureSave();
        });

        // Click event for debugging
        this.editor.on('click', (e) => {
            console.log('[WorkflowEditor] Click event:', e);
        });

        // Re-add arrowhead marker when nodes are created (ensures SVG exists)
        this.editor.on('nodeCreated', () => {
            this.addArrowheadMarker();
            this.hideHelpOverlay();
            // A new node may make this an ingestion workflow — flip the variant.
            this.refreshOutputNodeVariant();
            this.refreshStartNodeVariant();
            this._scheduleStructureSave();
        });

        // Track selected connection
        this.selectedConnection = null;

        // Handle double-click on connections to delete them
        this.container.addEventListener('dblclick', (e) => {
            const target = e.target;
            const isPath = target.tagName === 'path' || target.classList?.contains('main-path');

            if (isPath) {
                e.preventDefault();
                e.stopPropagation();

                const connection = target.closest('svg.connection') || target.parentElement?.closest('svg.connection');
                if (connection) {
                    this.removeConnectionProperly(connection);
                }
            }
        });

        // Handle click on connections to select them (use mousedown for SVG)
        this.container.addEventListener('mousedown', (e) => {
            // Check if clicked on a connection path (SVG path element)
            const target = e.target;
            const isPath = target.tagName === 'path' || target.classList?.contains('main-path');

            if (isPath) {
                e.stopPropagation();

                // Deselect previous connection
                if (this.selectedConnection) {
                    this.selectedConnection.classList.remove('selected');
                }

                // Find the parent connection SVG
                const connection = target.closest('svg.connection') || target.parentElement?.closest('svg.connection');
                if (connection) {
                    connection.classList.add('selected');
                    this.selectedConnection = connection;
                    // Focus container to receive keyboard events
                    this.container.focus();
                }
                return;
            }

            // Click elsewhere deselects connection
            if (this.selectedConnection) {
                const clickedOnConnection = target.closest('svg.connection') || target.closest('.connection');
                if (!clickedOnConnection) {
                    this.selectedConnection.classList.remove('selected');
                    this.selectedConnection = null;
                }
            }
        });

        // Handle Delete/Backspace key for removing selected connections and nodes
        // Bind to both document and container for better coverage
        const handleDelete = (e) => {
            // Only handle if not in input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                // Check for selected connection
                if (this.selectedConnection) {
                    e.preventDefault();
                    e.stopPropagation();

                    // Use helper method to properly remove from Drawflow's internal data
                    this.removeConnectionProperly(this.selectedConnection);
                    this.selectedConnection = null;
                    return;
                }

                // Check for selected node
                const selectedNode = this.container.querySelector('.drawflow-node.selected');
                if (selectedNode) {
                    e.preventDefault();
                    const nodeId = selectedNode.id.replace('node-', '');
                    this.editor.removeNodeId('node-' + nodeId);
                }
            }
        };

        // Bind to container (when focused)
        this.container.addEventListener('keydown', handleDelete);
        // Also bind to document as backup
        document.addEventListener('keydown', handleDelete);

        // Track drag state to avoid triggering click handlers when dragging
        let dragStartPos = null;
        this.container.addEventListener('mousedown', (e) => {
            dragStartPos = { x: e.clientX, y: e.clientY };
        });

        // Prevent node selection when clicking on play button (stop Drawflow's mousedown handler)
        this.container.addEventListener('mousedown', (e) => {
            const playBtn = e.target.closest('.node-play-btn');
            if (playBtn) {
                e.stopPropagation();
            }
        }, true); // Use capture phase to intercept before Drawflow

        // Handle edit button clicks on nodes (event delegation)
        this.container.addEventListener('click', (e) => {
            // Check if this was a drag (moved more than 5px)
            if (dragStartPos) {
                const dx = Math.abs(e.clientX - dragStartPos.x);
                const dy = Math.abs(e.clientY - dragStartPos.y);
                if (dx > 5 || dy > 5) {
                    // This was a drag, not a click - ignore
                    dragStartPos = null;
                    return;
                }
            }
            dragStartPos = null;

            const editBtn = e.target.closest('.node-edit-btn');
            if (editBtn) {
                e.stopPropagation();
                e.preventDefault();
                // Get the node ID from the drawflow node container
                const drawflowNode = editBtn.closest('.drawflow-node');
                const nodeId = drawflowNode ? drawflowNode.id.replace('node-', '') : null;

                // Ingestion nodes (loader / splitter / vectorstore) use the same
                // pen affordance as agent nodes, but open their own config modal.
                if (editBtn.dataset.ingestion === 'true' && nodeId) {
                    this.showIngestionConfigModal(nodeId);
                    return;
                }

                // Check if this is a realtime agent node
                if (editBtn.dataset.rtNode === 'true' && nodeId) {
                    this.showRealtimeAgentEditForm(nodeId);
                    return;
                }

                console.log('[WorkflowEditor] Edit button clicked - nodeId:', nodeId);

                // Get agent_id from node data (more reliable than button attribute)
                let agentId = editBtn.dataset.agentId;
                if (nodeId) {
                    const nodeData = this.editor.getNodeFromId(nodeId);
                    console.log('[WorkflowEditor] Edit button - nodeData:', nodeData);
                    console.log('[WorkflowEditor] Edit button - nodeData.data:', nodeData?.data);
                    if (nodeData?.data?.agent_id) {
                        agentId = nodeData.data.agent_id;
                    }
                }

                console.log('[WorkflowEditor] Edit button - calling showAgentEditForm with agentId:', agentId, 'nodeId:', nodeId);
                // Open form even without agentId (for editing node-specific config)
                this.showAgentEditForm(agentId || null, nodeId);
                return;
            }

            // Handle node delete button click (X button)
            const deleteBtn = e.target.closest('.node-delete-btn');
            if (deleteBtn) {
                e.stopPropagation();
                e.preventDefault();
                const drawflowNode = deleteBtn.closest('.drawflow-node');
                if (drawflowNode) {
                    const nodeId = drawflowNode.id.replace('node-', '');
                    this.deleteNodeById(nodeId);
                }
                return;
            }

            // Handle Output node storage section clicks
            const storageSection = e.target.closest('.node-storage');
            if (storageSection) {
                e.stopPropagation();
                this.showStorageConfigModal();
                return;
            }

            // Handle Ingestion node clicks (loader / splitter / vectorstore)
            // to open their editable config modal. Skip the delete button.
            const ingestionNode = e.target.closest('.workflow-node.ingestion-node');
            if (ingestionNode && !e.target.closest('.node-delete-btn')) {
                e.stopPropagation();
                const drawflowNode = ingestionNode.closest('.drawflow-node');
                if (drawflowNode) {
                    const nodeId = drawflowNode.id.replace('node-', '');
                    this.showIngestionConfigModal(nodeId);
                }
                return;
            }

            // Handle Agent Template node clicks to configure (unconfigured template)
            // But NOT if clicking on document zone elements
            const agentTemplateNode = e.target.closest('.workflow-node.agent-node.template');
            if (agentTemplateNode) {
                // Skip if clicking on document-related elements
                if (e.target.closest('.node-documents-zone') ||
                    e.target.closest('.documents-drop-hint') ||
                    e.target.closest('.attached-doc') ||
                    e.target.closest('.doc-remove')) {
                    return;
                }
                e.stopPropagation();
                const drawflowNode = agentTemplateNode.closest('.drawflow-node');
                if (drawflowNode) {
                    const nodeId = drawflowNode.id.replace('node-', '');
                    this.showAgentTemplateConfigModal(nodeId);
                }
                return;
            }

            // Handle configured Agent Template node clicks (to edit the agent)
            // But NOT if clicking on document zone elements
            const configuredAgentNode = e.target.closest('.workflow-node.agent-node.configurable:not(.template)');
            if (configuredAgentNode) {
                // Skip if clicking on document-related elements
                if (e.target.closest('.node-documents-zone') ||
                    e.target.closest('.documents-drop-hint') ||
                    e.target.closest('.attached-doc') ||
                    e.target.closest('.doc-remove')) {
                    return;
                }
                e.stopPropagation();
                const drawflowNode = configuredAgentNode.closest('.drawflow-node');
                if (drawflowNode) {
                    const nodeId = drawflowNode.id.replace('node-', '');
                    this.showAgentTemplateConfigModal(nodeId);
                }
                return;
            }

            // Handle Output node clicks to show last workflow results.
            // The "LangGraph" button inside the output node opens a small
            // menu (Setup / Generate) and must not also trigger the
            // results modal.
            // Ingestion output node: one click on "Compile to Python" produces
            // and shows the standalone ingestion script directly (no dropdown).
            const ingestionCompileBtn = e.target.closest('[data-action="ingestion-compile"]');
            if (ingestionCompileBtn) {
                e.stopPropagation();
                this._compileIngestionToPython();
                return;
            }

            const langgraphBtn = e.target.closest('[data-action="langgraph-menu"]');
            if (langgraphBtn) {
                e.stopPropagation();
                this._showLangGraphMenu(langgraphBtn);
                return;
            }
            const viewJsonBtn = e.target.closest('[data-action="view-json"]');
            if (viewJsonBtn) {
                e.stopPropagation();
                this._showWorkflowJson();
                return;
            }
            const outputNode = e.target.closest('.workflow-node.output-node');
            if (outputNode) {
                if (this.lastWorkflowResults) {
                    this.showWorkflowResults(this.lastWorkflowResults);
                } else {
                    // Show a message that no results are available
                    this.showNoResultsMessage();
                }
                return;
            }

            // Realtime (audio) Start node — click anywhere on it opens the test overlay.
            // Must be checked before the batch Start-node handlers below.
            const rtStartNode = e.target.closest('.realtime-start-node');
            if (rtStartNode) {
                e.stopPropagation();
                this.startRealtimeTest();
                return;
            }

            // Handle Start node play button click to run workflow
            const playBtn = e.target.closest('.node-play-btn');
            if (playBtn) {
                e.stopPropagation();
                if (!this.currentWorkflowId) {
                    alert(this.t('workflow.messages.saveFirst'));
                } else if (this._isIngestionWorkflow()) {
                    // Ingestion: run the PHP interpreter from the Start node —
                    // it drives the loader node round-by-round (one file at a
                    // time), the same loop the store will later clock.
                    this._runIngestionFromStart();
                } else if (this.lastUserPrompt) {
                    this.executeWorkflow(this.lastUserPrompt);
                } else {
                    // No prompt yet - show prompt form
                    this.showPromptForm();
                }
                return;
            }

            // Handle Start node clicks to show/edit prompt
            // But NOT if clicking on document zone elements
            const startNode = e.target.closest('.workflow-node.start-node');
            if (startNode) {
                // Skip if clicking on document-related elements
                if (e.target.closest('.node-documents-zone') ||
                    e.target.closest('.documents-drop-hint') ||
                    e.target.closest('.attached-doc') ||
                    e.target.closest('.doc-remove')) {
                    return;
                }
                this.showPromptForm();
            }
        });

        // ==========================================
        // Multi-select functionality
        // ==========================================
        this.setupMultiSelect();
    }

    /**
     * Set up multi-select functionality for nodes
     */
    setupMultiSelect() {
        // Handle Ctrl/Cmd+click to toggle node selection
        // Use mousedown with capture to intercept before Drawflow
        this.container.addEventListener('mousedown', (e) => {
            // Only handle Ctrl/Cmd+click for multi-select
            if (!e.ctrlKey && !e.metaKey) return;

            const node = e.target.closest('.drawflow-node');
            if (!node) return;

            // Prevent Drawflow's default selection behavior
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const nodeId = node.id.replace('node-', '');

            // Toggle selection
            if (this.selectedNodes.has(nodeId)) {
                this.selectedNodes.delete(nodeId);
                node.classList.remove('multi-selected');
            } else {
                this.selectedNodes.add(nodeId);
                node.classList.add('multi-selected');
            }
            console.log('[WorkflowEditor] Selected nodes:', Array.from(this.selectedNodes));
        }, true); // Capture phase

        // Click on empty canvas clears selection
        this.container.addEventListener('click', (e) => {
            const node = e.target.closest('.drawflow-node');
            const isConnection = e.target.closest('.connection') || e.target.tagName === 'path';

            if (!node && !isConnection && !e.ctrlKey && !e.metaKey) {
                this.clearNodeSelection();
            }
        });

        // Track node movement to move all selected nodes together
        let isDraggingSelection = false;
        let draggedNodeId = null;
        let initialPositions = {};
        let lastMousePos = null;

        // On mousedown, store initial positions of all selected nodes
        this.container.addEventListener('mousedown', (e) => {
            // Don't start multi-drag if Ctrl is pressed (that's for selection)
            if (e.ctrlKey || e.metaKey) return;

            const node = e.target.closest('.drawflow-node');
            if (!node) return;

            const nodeId = node.id.replace('node-', '');

            // Only start multi-drag if clicking on a selected node and we have multiple selected
            if (this.selectedNodes.has(nodeId) && this.selectedNodes.size > 1) {
                isDraggingSelection = true;
                draggedNodeId = nodeId;
                lastMousePos = { x: e.clientX, y: e.clientY };

                // Store initial positions of all selected nodes
                initialPositions = {};
                this.selectedNodes.forEach(id => {
                    const nodeEl = document.getElementById('node-' + id);
                    if (nodeEl) {
                        initialPositions[id] = {
                            x: parseFloat(nodeEl.style.left) || 0,
                            y: parseFloat(nodeEl.style.top) || 0
                        };
                    }
                });
            }
        });

        // On mousemove, move all selected nodes by the delta
        document.addEventListener('mousemove', (e) => {
            if (!isDraggingSelection || !lastMousePos) return;

            const zoom = this.editor.zoom || 1;
            const deltaX = (e.clientX - lastMousePos.x) / zoom;
            const deltaY = (e.clientY - lastMousePos.y) / zoom;

            if (deltaX === 0 && deltaY === 0) return;

            // Move all selected nodes except the one being dragged (Drawflow handles that one)
            this.selectedNodes.forEach(nodeId => {
                if (nodeId === draggedNodeId) return; // Skip the dragged node

                const nodeEl = document.getElementById('node-' + nodeId);
                if (nodeEl && initialPositions[nodeId]) {
                    const newX = initialPositions[nodeId].x + (e.clientX - lastMousePos.x) / zoom + deltaX;
                    const newY = initialPositions[nodeId].y + (e.clientY - lastMousePos.y) / zoom + deltaY;

                    // Update DOM position
                    nodeEl.style.left = (initialPositions[nodeId].x + (e.clientX - lastMousePos.x) / zoom) + 'px';
                    nodeEl.style.top = (initialPositions[nodeId].y + (e.clientY - lastMousePos.y) / zoom) + 'px';

                    // Update Drawflow internal data
                    if (this.editor.drawflow.drawflow.Home.data[nodeId]) {
                        this.editor.drawflow.drawflow.Home.data[nodeId].pos_x = initialPositions[nodeId].x + (e.clientX - lastMousePos.x) / zoom;
                        this.editor.drawflow.drawflow.Home.data[nodeId].pos_y = initialPositions[nodeId].y + (e.clientY - lastMousePos.y) / zoom;
                    }

                    // Update connections
                    this.editor.updateConnectionNodes('node-' + nodeId);
                }
            });
        });

        // On mouseup, stop dragging
        document.addEventListener('mouseup', () => {
            isDraggingSelection = false;
            draggedNodeId = null;
            initialPositions = {};
            lastMousePos = null;
        });
    }

    /**
     * Clear all selected nodes
     */
    clearNodeSelection() {
        this.selectedNodes.forEach(nodeId => {
            const node = document.getElementById('node-' + nodeId);
            if (node) {
                node.classList.remove('multi-selected');
            }
        });
        this.selectedNodes.clear();
    }

    /**
     * Update Start node to show prompt availability indicator
     */
    updateStartNodeIndicator(hasPrompt) {
        const startNodes = this.container.querySelectorAll('.workflow-node.start-node');
        startNodes.forEach(node => {
            const small = node.querySelector('.node-body small');
            const playBtn = node.querySelector('.node-play-btn');

            // Ingestion start nodes need no prompt — always show the play button
            // and skip the prompt-text indicator entirely.
            if (node.classList.contains('ingestion-start')) {
                if (playBtn) playBtn.style.display = 'flex';
                return;
            }

            if (hasPrompt) {
                node.classList.add('has-prompt');
                if (small) {
                    small.textContent = '📝 Click to edit';
                    small.style.color = '#2563eb';
                }
                if (playBtn) {
                    playBtn.style.display = 'flex';
                }
            } else {
                node.classList.remove('has-prompt');
                if (small) {
                    small.textContent = 'User prompt input';
                    small.style.color = '';
                }
                if (playBtn) {
                    playBtn.style.display = 'none';
                }
            }
        });
    }

    /**
     * Save prompt to the Start node's Drawflow data so it persists with the workflow
     */
    savePromptToStartNode(prompt) {
        // Find the start node in Drawflow and update directly
        const nodes = this.editor.drawflow.drawflow.Home.data;

        for (const nodeId of Object.keys(nodes)) {
            const node = nodes[nodeId];
            if (node.data?.type === 'start') {
                // Update the node's data with the prompt directly
                node.data = {
                    ...node.data,
                    prompt: prompt
                };
                console.log('[WorkflowEditor] Saved prompt to start node:', nodeId, 'prompt:', prompt ? prompt.substring(0, 50) + '...' : '(empty)');
                return;
            }
        }

        console.log('[WorkflowEditor] No start node found to save prompt');
    }

    /**
     * Restore prompt from start node config when loading a workflow
     */
    restorePromptFromStartNode(nodes) {
        // Find start node in the loaded nodes
        const startNode = nodes.find(n => n.type === 'start' || n.node_type === 'start' || n.config?.type === 'start');

        if (startNode) {
            const prompt = startNode.config?.prompt || '';
            this.lastUserPrompt = prompt;

            if (prompt) {
                console.log('[WorkflowEditor] Restored prompt from start node:', prompt.substring(0, 50) + '...');
                this.updateStartNodeIndicator(true);
            } else {
                console.log('[WorkflowEditor] No prompt found in start node');
                this.updateStartNodeIndicator(false);
            }
        }
    }

    /**
     * Update Output node to show results availability indicator
     */
    updateOutputNodeIndicator(hasResults) {
        const outputNodes = this.container.querySelectorAll('.workflow-node.output-node');
        outputNodes.forEach(node => {
            if (hasResults) {
                node.classList.add('has-results');
                // Update the small text to indicate clickable
                const small = node.querySelector('.node-body small');
                if (small) {
                    small.textContent = '📋 Click to view results';
                    small.style.cursor = 'pointer';
                    small.style.color = '#2563eb';
                }
            } else {
                node.classList.remove('has-results');
                const small = node.querySelector('.node-body small');
                if (small) {
                    small.textContent = 'Response to user';
                    small.style.cursor = 'default';
                    small.style.color = '';
                }
            }
        });
    }

    /**
     * Fetch the generated .py from the backend and save it into the
     * user's local Python runtime at synergyAI/python/scripts/ via the
     * File System Access API.
     *
     * Prereqs: the user picked a local folder via local-fs.js (done at
     * first app launch) AND ran `python3 setup.py` from
     * /Applications/XAMPP/xamppfiles/htdocs/gpt/langchain_runner/ at
     * least once (so synergyAI/python/ exists with the runtime files).
     * If the python/ folder hasn't been provisioned yet we open a small
     * modal explaining the one-time setup command instead of silently
     * creating an empty folder the user can't run scripts from.
     */
    async downloadGeneratedPython() {
        if (!this.currentWorkflowId) {
            alert(this.t('workflow.output.saveFirst'));
            return;
        }
        if (!window.localFs || !window.localFs.isSupported || !window.localFs.isSupported()) {
            alert(this.t('workflow.output.fsaUnavailable')
                || 'Local filesystem access is not available in this browser.');
            return;
        }

        // Bail with a setup prompt if the user hasn't run setup.py yet.
        // We probe for python/main.py — the runner's entry file — as the
        // sentinel for "setup has been done".
        const runnerEntry = await window.localFs.resolvePath('python/main.py', { create: false, kind: 'file' });
        if (!runnerEntry) {
            this._showRunnerSetupModal();
            return;
        }

        try {
            const resp = await fetch(
                `${this.apiBase}/workflows/${this.currentWorkflowId}/generate-python?download=1`,
                { headers: this.getAuthHeaders() }
            );
            if (!resp.ok) {
                const err = await resp.text();
                throw new Error(err || `HTTP ${resp.status}`);
            }
            // Derive filename from Content-Disposition, fall back to workflow name
            let filename = 'workflow.py';
            const dispo = resp.headers.get('Content-Disposition') || '';
            const m = dispo.match(/filename="([^"]+)"/);
            if (m) filename = m[1];
            const text = await resp.text();

            // Make sure python/scripts/ exists, then write the .py file there.
            const scriptsDir = await window.localFs.resolvePath('python/scripts', { create: true });
            if (!scriptsDir) {
                throw new Error('Could not resolve synergyAI/python/scripts.');
            }
            const fileHandle = await scriptsDir.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(text);
            await writable.close();

            const rootName = (await window.localFs.getRootHandle())?.name || 'synergyAI';
            console.log(`[WorkflowEditor] Saved generated Python to ${rootName}/python/scripts/${filename}`);
            this._showToast(
                (this.t('workflow.output.savedTo') || 'Saved to')
                + ` ${rootName}/python/scripts/${filename}`
            );
        } catch (e) {
            console.error('[WorkflowEditor] generate-python failed:', e);
            alert(this.t('workflow.output.generateFailed') + ': ' + (e.message || e));
        }
    }

    /**
     * Persist a completed workflow's final output to the local FS so
     * the user has a permanent copy outside the browser tab. Path:
     *
     *   synergyAI/outputs/workflow/<wf-id>-<slug>_<YYYYMMDD-HHMMSS>.<ext>
     *
     * Extension is auto-detected (HTML if the content looks like HTML
     * — `<!DOCTYPE html>`, `<html`, `<body`, `<section`, `<article` in
     * the first 2000 chars — otherwise Markdown). Timestamp makes the
     * filename unique per run so multiple executions of the same
     * workflow never overwrite each other.
     */
    async _saveWorkflowOutput(content) {
        if (!content || typeof content !== 'string') return;
        if (!window.localFs || !window.localFs.isSupported || !window.localFs.isSupported()) {
            console.warn('[WorkflowEditor] FSA unavailable; cannot persist workflow output.');
            return;
        }

        // Detect HTML vs Markdown. Same heuristic as the langchain
        // runner's script_io._detect_format_and_strip — kept local to
        // avoid a backend dependency for this purely browser-side save.
        const head = content.slice(0, 2000);
        const isHtml = /<!DOCTYPE\s+html\b|<html[\s>]|<head[\s>]|<body[\s>]|<section[\s>]|<article[\s>]/i.test(head);
        const ext = isHtml ? 'html' : 'md';

        // If HTML signatures appear *after* some markdown wrapper text,
        // slice from the first signature so the saved .html file is a
        // valid standalone document (no stray `# Result` prefix etc).
        let body = content;
        if (isHtml) {
            const m = head.match(/<!DOCTYPE\s+html\b|<html[\s>]|<head[\s>]|<body[\s>]|<section[\s>]|<article[\s>]/i);
            if (m && m.index > 0) body = content.slice(m.index);
        }

        const id = this.currentWorkflowId || 'wf';
        const slug = this._slugify(this.currentWorkflowName || 'workflow');
        const ts = this._compactTimestamp();
        const filename = `${id}-${slug}_${ts}.${ext}`;

        try {
            const dir = await window.localFs.resolvePath('outputs/workflow', { create: true });
            if (!dir) throw new Error('Could not resolve synergyAI/outputs/workflow.');
            const fh = await dir.getFileHandle(filename, { create: true });
            const writable = await fh.createWritable();
            await writable.write(body);
            await writable.close();
            const rootName = (await window.localFs.getRootHandle())?.name || 'synergyAI';
            const path = `${rootName}/outputs/workflow/${filename}`;
            console.log(`[WorkflowEditor] Saved workflow output to ${path}`);
            this._showToast(
                (this.t('workflow.output.savedTo') || 'Saved to') + ` ${path}`
            );
        } catch (e) {
            console.error('[WorkflowEditor] Failed to save workflow output:', e);
        }
    }

    /** Kebab-case slugify for filenames. Strips non-alphanumeric, collapses dashes. */
    _slugify(name) {
        return String(name)
            .toLowerCase()
            // NFKD + strip combining marks (U+0300–U+036F) → "café" → "cafe".
            .normalize('NFKD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'workflow';
    }

    /** Compact local-time timestamp: YYYYMMDD-HHMMSS, no separators inside groups. */
    _compactTimestamp() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    /**
     * Dropdown menu shown when the user clicks the "LangGraph" button on
     * the Output node. Exposes the LangGraph runtime actions:
     *   - Setup       : one-shot install instructions for the runner
     *   - Generate    : download the freshly generated script to scripts/
     *   - Info        : describes the runtime layout under synergyAI/python/
     *   - Run         : execute the generated .py via the local runner
     *   - Display Code: fetch + show the generated Python in a modal
     */
    _showLangGraphMenu(buttonEl) {
        // Close any existing instance — clicking the button again should toggle.
        const existing = document.querySelector('.langgraph-menu');
        if (existing) {
            existing.remove();
            return;
        }

        const isIngestion = this._outputConnectedToIngestion();

        const menu = document.createElement('div');
        menu.className = 'langgraph-menu';
        // Ingestion workflows get a script-focused menu (no langgraph-runtime
        // setup/info, which are agent-only). The agent menu is unchanged.
        menu.innerHTML = isIngestion
            ? `
            <button type="button" class="langgraph-menu-item" data-action="generate">
                ${this.escapeHtml(this.t('workflow.output.ingestionGenerate') || 'Generate Python script')}
            </button>
            <button type="button" class="langgraph-menu-item" data-action="run">
                ${this.escapeHtml(this.t('workflow.output.ingestionRun') || 'Run ingestion')}
            </button>
            <button type="button" class="langgraph-menu-item" data-action="download">
                ${this.escapeHtml(this.t('workflow.output.ingestionDownload') || 'Download script')}
            </button>
            <button type="button" class="langgraph-menu-item" data-action="display-code">
                ${this.escapeHtml(this.t('workflow.output.langgraphDisplayCode') || 'Display Code')}
            </button>
        `
            : `
            <button type="button" class="langgraph-menu-item" data-action="setup">
                ${this.escapeHtml(this.t('workflow.output.langgraphSetup') || 'Setup')}
            </button>
            <button type="button" class="langgraph-menu-item" data-action="generate">
                ${this.escapeHtml(this.t('workflow.output.langgraphGenerate') || 'Generate')}
            </button>
            <button type="button" class="langgraph-menu-item" data-action="info">
                ${this.escapeHtml(this.t('workflow.output.langgraphInfo') || 'Info')}
            </button>
            <button type="button" class="langgraph-menu-item" data-action="run">
                ${this.escapeHtml(this.t('workflow.output.langgraphRun') || 'Run')}
            </button>
            <button type="button" class="langgraph-menu-item" data-action="display-code">
                ${this.escapeHtml(this.t('workflow.output.langgraphDisplayCode') || 'Display Code')}
            </button>
        `;
        document.body.appendChild(menu);

        const r = buttonEl.getBoundingClientRect();
        // Anchor below the button, left-aligned. Clamp inside the viewport.
        const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${r.bottom + 4}px`;

        // Guard each binding with ?. so the items absent in one variant
        // (setup/info for ingestion; download for agent) don't throw.
        menu.querySelector('[data-action="setup"]')?.addEventListener('click', () => {
            menu.remove();
            this._showRunnerSetupModal();
        });
        menu.querySelector('[data-action="generate"]')?.addEventListener('click', () => {
            menu.remove();
            this.downloadGeneratedPython();
        });
        menu.querySelector('[data-action="info"]')?.addEventListener('click', () => {
            menu.remove();
            this._showLangGraphInfoModal();
        });
        menu.querySelector('[data-action="download"]')?.addEventListener('click', () => {
            menu.remove();
            this.downloadGeneratedPython();
        });
        menu.querySelector('[data-action="run"]')?.addEventListener('click', () => {
            menu.remove();
            // Ingestion runs server-side via run-ingestion, not the
            // langgraph_runner (/api/run-file) used for agent scripts.
            if (isIngestion) {
                this._runIngestion();
            } else {
                this._runLangGraphScript();
            }
        });
        menu.querySelector('[data-action="display-code"]')?.addEventListener('click', () => {
            menu.remove();
            this._showLangGraphCodeModal();
        });

        // Dismiss on any outside click. Schedule on next tick so the
        // current click event (which opened the menu) doesn't close it.
        setTimeout(() => {
            const onDocClick = (ev) => {
                if (!menu.contains(ev.target)) {
                    menu.remove();
                    document.removeEventListener('click', onDocClick, true);
                }
            };
            document.addEventListener('click', onDocClick, true);
        }, 0);
    }

    /**
     * The local LangGraph runner. It's a FastAPI service the user starts
     * separately (`python3 main.py` from ~/Documents/synergyAI/python/);
     * see _showRunnerSetupModal for first-time install. Default port is
     * 8765 (set in langchain_runner/main.py). All three new menu actions
     * share this base URL.
     */
    get _langgraphRunnerBase() { return 'http://127.0.0.1:8765'; }

    /**
     * Info modal — explains where the runtime lives and how to use it.
     * Pure documentation, no side effects. Mirrors the layout used by
     * _showRunnerSetupModal for visual consistency.
     */
    _showLangGraphInfoModal() {
        const backdrop = document.createElement('div');
        backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
        backdrop.innerHTML = `
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl" role="dialog" aria-modal="true">
                <h3 class="text-lg font-semibold text-gray-900 mb-2">LangGraph runtime</h3>
                <p class="text-sm text-gray-600 mb-3">
                    Generated workflows are LangGraph Python scripts. They run on a small FastAPI runner installed
                    locally in <code class="text-xs bg-gray-100 px-1 rounded">~/Documents/synergyAI/python/</code>.
                </p>
                <table class="w-full text-xs text-left mb-4">
                    <tbody class="divide-y divide-gray-200">
                        <tr><td class="py-1 pr-3 font-medium text-gray-700 w-40">Runtime folder</td><td><code class="text-xs">~/Documents/synergyAI/python/</code></td></tr>
                        <tr><td class="py-1 pr-3 font-medium text-gray-700">Entry point</td><td><code class="text-xs">main.py</code> (FastAPI server on <code class="text-xs">${this.escapeHtml(this._langgraphRunnerBase)}</code>)</td></tr>
                        <tr><td class="py-1 pr-3 font-medium text-gray-700">Generated scripts</td><td><code class="text-xs">python/scripts/&lt;workflow&gt;.py</code></td></tr>
                        <tr><td class="py-1 pr-3 font-medium text-gray-700">Requirements</td><td><code class="text-xs">requirements.txt</code> (LangGraph, LangChain, FastAPI, uvicorn, …)</td></tr>
                        <tr><td class="py-1 pr-3 font-medium text-gray-700">First-time setup</td><td><code class="text-xs">python3 setup.py</code> from the runtime folder</td></tr>
                        <tr><td class="py-1 pr-3 font-medium text-gray-700">Start the runner</td><td><code class="text-xs">./.venv/bin/python main.py</code> from the runtime folder (NOT system <code class="text-xs">python3</code> — see note below)</td></tr>
                        <tr><td class="py-1 pr-3 font-medium text-gray-700">Standalone CLI run</td><td><code class="text-xs">./.venv/bin/python main.py run scripts/&lt;workflow&gt;.py</code></td></tr>
                        <tr><td class="py-1 pr-3 font-medium text-gray-700">Live endpoints</td><td><code class="text-xs">POST /api/run</code>, <code class="text-xs">POST /api/run-file</code>, <code class="text-xs">GET /health</code></td></tr>
                    </tbody>
                </table>
                <p class="text-xs text-gray-500 mb-4">
                    The Output-node's <b>Run</b> menu item hits <code class="text-xs">POST ${this.escapeHtml(this._langgraphRunnerBase)}/api/run-file</code>.
                    It only works while the runner is running.
                </p>
                <p class="text-xs text-gray-500 mb-4">
                    <b>Important:</b> start the runner with <code class="text-xs">./.venv/bin/python main.py</code>, not bare <code class="text-xs">python3 main.py</code>.
                    The runner spawns each generated script as a subprocess via <code class="text-xs">sys.executable</code>, so whichever interpreter starts <code class="text-xs">main.py</code>
                    is the one that runs every workflow. Only the venv has LangGraph and the per-provider <code class="text-xs">langchain-*</code> packages — system Python doesn't,
                    and you'll see <code class="text-xs">ModuleNotFoundError: No module named 'langchain_openai'</code> if you start the runner with the wrong interpreter.
                </p>
                <div class="flex justify-end">
                    <button class="info-close-btn px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        backdrop.querySelector('.info-close-btn').addEventListener('click', close);
    }

    /**
     * Ingestion "Compile to Python": persist the latest graph FIRST so the
     * backend compiler sees the ingestion nodes (loader/splitter/vectorstore)
     * and emits the lean standalone ingestion script — not the LangGraph/LLM
     * script it would fall back to if the saved graph were stale. Then show it.
     */
    async _compileIngestionToPython() {
        // Only create the workflow once (for the endpoint id); no re-save when
        // parameters change — the compiler reads the LIVE configs from the canvas.
        if (!this.currentWorkflowId) {
            try {
                await this.saveWorkflow();
            } catch (e) {
                console.warn('[WorkflowEditor] save before ingestion compile failed:', e);
            }
            if (!this.currentWorkflowId) return; // create cancelled / failed
        }

        // Gather the ingestion stage configs straight from the canvas (the form
        // attributes) and hand them to the standalone IngestionCompiler. No
        // saved-graph lookup / node interpretation — just parameters → Python.
        const data = this.editor.drawflow?.drawflow?.Home?.data || {};
        let loader = {}, splitter = {}, vectorstore = {};
        for (const id in data) {
            const nt = data[id]?.data?.node_type;
            if (nt === 'loader') loader = data[id].data.config || {};
            else if (nt === 'splitter') splitter = data[id].data.config || {};
            else if (nt === 'vectorstore') vectorstore = data[id].data.config || {};
        }

        let code = '', savedPath = '', filename = '';
        try {
            const resp = await fetch(`${this.apiBase}/workflows/${this.currentWorkflowId}/ingestion/compile`, {
                method: 'POST',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ loader, splitter, vectorstore }),
            });
            const j = await resp.json().catch(() => ({}));
            if (j && j.success && j.data) {
                code = j.data.code || '';
                savedPath = j.data.path || '';
                filename = j.data.filename || '';
            } else {
                this.showToast('Compile failed: ' + ((j && j.error) || resp.status), 'error');
                return;
            }
        } catch (e) {
            this.showToast('Compile failed: ' + (e?.message || e), 'error');
            return;
        }
        this._showLangGraphCodeModal(savedPath, code, filename);
    }

    /**
     * Display Code — fetch the generated Python from the backend and show
     * it in a scrollable code block with copy-to-clipboard. Read-only;
     * does not touch the local filesystem. The same endpoint
     * (/workflows/<id>/generate-python) backs the Generate action that
     * downloads the file.
     */
    async _showLangGraphCodeModal(savedPath = '', providedCode = null, filename = '') {
        if (!this.currentWorkflowId) {
            alert(this.t('workflow.output.saveFirst') || 'Save the workflow first.');
            return;
        }
        // Ingestion passes the already-compiled code directly; the agent path
        // fetches its LangGraph script from generate-python.
        let code = providedCode;
        if (code === null) {
            try {
                const resp = await fetch(
                    `${this.apiBase}/workflows/${this.currentWorkflowId}/generate-python?download=1`,
                    { headers: this.getAuthHeaders() }
                );
                if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
                code = await resp.text();
            } catch (e) {
                alert(`Could not fetch the generated code: ${e?.message || e}`);
                return;
            }
        }

        // Ingestion passes the code directly → offer a "Store location" field
        // (pre-filled with the default langchain_runner env) so the user can save
        // the script wherever they want.
        const isIngestion = providedCode !== null;
        const defaultDir = savedPath ? savedPath.replace(/\/[^\/]*$/, '') : 'langchain_runner';
        const saveFilename = filename || (savedPath ? savedPath.replace(/^.*\//, '') : 'ingestion_pipeline.py');

        const backdrop = document.createElement('div');
        backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
        backdrop.innerHTML = `
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-4xl max-h-[85vh] flex flex-col" role="dialog" aria-modal="true">
                <div class="flex items-center justify-between mb-3">
                    <h3 class="text-lg font-semibold text-gray-900">${this._isIngestionWorkflow() ? 'Generated ingestion script (standalone Python)' : 'Generated LangGraph code'}</h3>
                    <button class="code-copy-btn text-xs px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded">Copy</button>
                </div>
                ${isIngestion ? `
                <div class="flex items-center gap-2 mb-2">
                    <label class="text-xs text-gray-500 whitespace-nowrap">Store location</label>
                    <input type="text" class="code-dest-input flex-1 text-xs border border-gray-300 rounded px-2 py-1 font-mono" value="${this.escapeHtml(defaultDir)}" title="Folder (or full .py path) to copy the script to. Default: the langchain_runner Python environment.">
                    <button class="code-save-btn text-xs px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded whitespace-nowrap">Save here</button>
                    <span class="code-save-status text-xs text-gray-500 whitespace-nowrap"></span>
                </div>`
                : (savedPath ? `<div class="text-xs text-gray-500 mb-2">Saved to <code class="text-gray-700">${this.escapeHtml(savedPath)}</code></div>` : '')}
                <pre class="bg-gray-900 text-green-200 text-xs rounded p-3 overflow-auto flex-1 select-all"></pre>
                <div class="flex justify-end mt-3">
                    <button class="code-close-btn px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.querySelector('pre').textContent = code;
        const close = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        backdrop.querySelector('.code-close-btn').addEventListener('click', close);
        backdrop.querySelector('.code-copy-btn').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(code);
                const btn = backdrop.querySelector('.code-copy-btn');
                const prev = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = prev; }, 1200);
            } catch (e) { /* user just selects + copies manually */ }
        });
        // Ingestion: save the script to the chosen location (default langchain_runner).
        const saveBtn = backdrop.querySelector('.code-save-btn');
        if (saveBtn) saveBtn.addEventListener('click', async () => {
            const destEl = backdrop.querySelector('.code-dest-input');
            const statusEl = backdrop.querySelector('.code-save-status');
            const dest = (destEl?.value || '').trim();
            if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'code-save-status text-xs text-gray-500 whitespace-nowrap'; }
            try {
                const resp = await fetch(`${this.apiBase}/workflows/${this.currentWorkflowId}/ingestion/save-script`, {
                    method: 'POST',
                    headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ code, dest, filename: saveFilename }),
                });
                const j = await resp.json().catch(() => ({}));
                if (resp.ok && j && j.success && j.data) {
                    if (statusEl) { statusEl.textContent = '✓ ' + (j.data.path || 'saved'); statusEl.className = 'code-save-status text-xs text-green-600 whitespace-nowrap'; }
                } else {
                    if (statusEl) { statusEl.textContent = '✗ ' + ((j && j.error) || `HTTP ${resp.status}`); statusEl.className = 'code-save-status text-xs text-red-600 whitespace-nowrap'; }
                }
            } catch (e) {
                if (statusEl) { statusEl.textContent = '✗ ' + (e?.message || e); statusEl.className = 'code-save-status text-xs text-red-600 whitespace-nowrap'; }
            }
        });
    }

    /**
     * Run — execute the generated .py via the local runner. The runner is
     * a FastAPI service the user has to start separately; if it isn't
     * reachable we surface a setup hint instead of silently failing. The
     * call shape matches RunFileReq in langchain_runner/main.py:
     *   POST /api/run-file  body={ filename, args }
     */
    async _runLangGraphScript() {
        if (!this.currentWorkflowId) {
            alert(this.t('workflow.output.saveFirst') || 'Save the workflow first.');
            return;
        }
        // Liveness probe first so the failure mode is "runner not started"
        // not "looks like it ran but you got nothing". /health is cheap.
        try {
            const ping = await fetch(`${this._langgraphRunnerBase}/health`, { method: 'GET' });
            if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
        } catch (e) {
            this._showRunnerNotRunningModal();
            return;
        }

        // Derive the filename the same way downloadGeneratedPython does:
        // fetch from backend with download=1, read Content-Disposition.
        let filename;
        try {
            const resp = await fetch(
                `${this.apiBase}/workflows/${this.currentWorkflowId}/generate-python?download=1`,
                { headers: this.getAuthHeaders() }
            );
            if (!resp.ok) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
            const dispo = resp.headers.get('Content-Disposition') || '';
            const m = dispo.match(/filename="([^"]+)"/);
            filename = m ? m[1] : 'workflow.py';
            // We don't need the body here — Generate already wrote it to disk
            // on previous use; if it hasn't been generated, the runner will
            // return a clear "file not found" via run-file's 400. We don't
            // re-write here to keep this action read-only on the FS.
            await resp.text();
        } catch (e) {
            alert(`Could not resolve the generated filename: ${e?.message || e}\nClick "Generate" first.`);
            return;
        }

        // Prompt the user for argv (most generated scripts read sys.argv[1:]).
        const prompt = window.prompt(
            (this.t('workflow.output.langgraphRunPrompt')
                || `Prompt to pass to ${filename}? (will be sys.argv[1:])`),
            ''
        );
        if (prompt === null) return; // user cancelled

        // Show a streaming-output modal up-front so the user sees progress.
        const { backdrop, append, close } = this._openRunOutputModal(filename);

        try {
            const resp = await fetch(`${this._langgraphRunnerBase}/api/run-file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename,
                    args: prompt ? prompt.trim().split(/\s+/) : [],
                }),
            });
            if (!resp.ok) {
                const text = await resp.text();
                append(`\n[runner returned HTTP ${resp.status}]\n${text}\n`);
                return;
            }
            // Stream the SSE body. We don't parse event types — just append
            // every chunk as raw text; the runner emits stdout/stderr lines
            // and a final result event the user can read directly.
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                append(decoder.decode(value, { stream: true }));
            }
        } catch (e) {
            append(`\n[fetch failed: ${e?.message || e}]\n`);
        }
    }

    /**
     * Modal shown when the runner liveness probe to /health fails.
     * Tells the user to start `python3 main.py` from the runtime folder.
     */
    _showRunnerNotRunningModal() {
        // Use the venv's Python directly (./.venv/bin/python) instead of
        // system python3. The runner spawns each script as a subprocess
        // via sys.executable (langchain_runner/main.py:237), so whichever
        // interpreter starts main.py is the one that runs every workflow.
        // System python3 has no langchain_openai / langgraph etc. — those
        // are pip-installed by setup.py into .venv/ only. Activating via
        // `source .venv/bin/activate` would also work but depends on the
        // shell; calling the venv binary by path works in any context.
        const startCmd = 'cd ~/Documents/synergyAI/python && ./.venv/bin/python main.py';
        const backdrop = document.createElement('div');
        backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
        backdrop.innerHTML = `
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg" role="dialog" aria-modal="true">
                <h3 class="text-lg font-semibold text-gray-900 mb-2">LangGraph runner isn't running</h3>
                <p class="text-sm text-gray-600 mb-3">
                    The local runner (FastAPI on <code class="text-xs bg-gray-100 px-1 rounded">${this.escapeHtml(this._langgraphRunnerBase)}</code>)
                    isn't responding. Start it from a terminal:
                </p>
                <div class="relative mb-3">
                    <pre class="bg-gray-900 text-green-200 text-xs rounded p-3 pr-12 select-all overflow-auto">${this.escapeHtml(startCmd)}</pre>
                    <button class="cmd-copy-btn absolute top-2 right-2 text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded" title="Copy command to clipboard">📋</button>
                </div>
                <p class="text-xs text-gray-500 mb-4">
                    Leave that terminal open, then click Run again. If you've never installed it, click <b>Setup</b> in the LangGraph menu first.
                </p>
                <div class="flex justify-end">
                    <button class="rnr-close-btn px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        backdrop.querySelector('.rnr-close-btn').addEventListener('click', close);
        this._wireCmdCopyBtn(backdrop.querySelector('.cmd-copy-btn'), startCmd);
    }

    /**
     * Wire a "copy to clipboard" icon button next to a command pre block.
     * Briefly swaps the icon to a checkmark on success so the user sees
     * confirmation. Used by both runner modals (Setup and Not-Running);
     * keeping it in one place stops the copy logic from drifting.
     */
    _wireCmdCopyBtn(btn, text) {
        if (!btn) return;
        btn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(text);
                const prev = btn.textContent;
                btn.textContent = '✓';
                btn.classList.add('bg-green-600', 'hover:bg-green-500');
                btn.classList.remove('bg-gray-700', 'hover:bg-gray-600');
                setTimeout(() => {
                    btn.textContent = prev;
                    btn.classList.remove('bg-green-600', 'hover:bg-green-500');
                    btn.classList.add('bg-gray-700', 'hover:bg-gray-600');
                }, 1200);
            } catch (e) {
                // Clipboard API failed (insecure context, denied permission).
                // The select-all on the pre is the user's fallback path.
                console.warn('[workflow-editor] clipboard write failed:', e);
            }
        });
    }

    /**
     * Build a small modal with a scrolling output pane. Returns
     * { append(chunk), close() } so the streaming caller can write into
     * it line-by-line.
     */
    _openRunOutputModal(filename) {
        const backdrop = document.createElement('div');
        backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
        backdrop.innerHTML = `
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-3xl max-h-[85vh] flex flex-col" role="dialog" aria-modal="true">
                <div class="flex items-center justify-between mb-3">
                    <h3 class="text-lg font-semibold text-gray-900">Run output — <span class="font-mono text-sm">${this.escapeHtml(filename)}</span></h3>
                    <button class="run-close-btn text-xs px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded">Close</button>
                </div>
                <pre class="bg-gray-900 text-gray-100 text-xs rounded p-3 overflow-auto flex-1 whitespace-pre-wrap"></pre>
            </div>
        `;
        document.body.appendChild(backdrop);
        const pre = backdrop.querySelector('pre');
        const close = () => backdrop.remove();
        backdrop.querySelector('.run-close-btn').addEventListener('click', close);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        const append = (text) => {
            pre.textContent += text;
            // Auto-scroll to bottom so the user sees the latest line.
            pre.scrollTop = pre.scrollHeight;
        };
        return { backdrop, append, close };
    }

    /**
     * Modal shown the first time the user clicks "Generate" if
     * the synergyAI/python/ folder hasn't been provisioned yet. Tells
     * them how to run setup.py once.
     */
    _showRunnerSetupModal() {
        const setupPath = '/Applications/XAMPP/xamppfiles/htdocs/gpt/langchain_runner';
        const cmd = `cd ${setupPath} && python3 setup.py`;
        const backdrop = document.createElement('div');
        backdrop.className = 'fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4';
        backdrop.innerHTML = `
            <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-lg" role="dialog" aria-modal="true">
                <h3 class="text-lg font-semibold text-gray-900 mb-2">
                    ${this.escapeHtml(this.t('workflow.runnerSetup.title') || 'Python runtime not installed')}
                </h3>
                <p class="text-sm text-gray-600 mb-3">
                    ${this.escapeHtml(this.t('workflow.runnerSetup.body')
                        || 'Generated Python scripts are saved into ~/Documents/synergyAI/python/scripts/. The runtime needs to be installed there once. Open a terminal and run:')}
                </p>
                <div class="relative mb-3">
                    <pre class="bg-gray-900 text-green-200 text-xs rounded p-3 pr-12 select-all overflow-auto">${this.escapeHtml(cmd)}</pre>
                    <button class="cmd-copy-btn absolute top-2 right-2 text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded" title="${this.escapeHtml(this.t('workflow.runnerSetup.copy') || 'Copy command')}">📋</button>
                </div>
                <p class="text-xs text-gray-500 mb-4">
                    ${this.escapeHtml(this.t('workflow.runnerSetup.note')
                        || 'After that finishes, click Generate Python again.')}
                </p>
                <div class="flex justify-end">
                    <button type="button" class="close-btn px-4 py-2 text-sm bg-blue-600 text-white hover:bg-blue-700 rounded-md">
                        ${this.escapeHtml(this.t('common.close') || 'Close')}
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
        const close = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        backdrop.querySelector('.close-btn').addEventListener('click', close);
        this._wireCmdCopyBtn(backdrop.querySelector('.cmd-copy-btn'), cmd);
    }

    /**
     * Lightweight toast notification (top-right). Used for "Saved to …"
     * confirmations. Auto-dismisses after 4 seconds.
     */
    _showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'fixed top-4 right-4 z-[1001] bg-gray-900 text-white text-sm px-4 py-2 rounded-md shadow-lg max-w-md break-all';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    /**
     * Show message when clicking Output node with no results
     */
    showNoResultsMessage() {
        const existingModal = document.getElementById('workflow-results-modal');
        if (existingModal) existingModal.remove();

        const modalHtml = `
            <div id="workflow-results-modal" class="workflow-results-overlay">
                <div class="workflow-results-container" style="max-width: 400px;">
                    <div class="workflow-results-header">
                        <h2>${this.t('workflow.results.noResults')}</h2>
                        <button class="workflow-results-close" onclick="document.getElementById('workflow-results-modal').remove()">×</button>
                    </div>
                    <div class="workflow-results-body" style="padding: 30px; text-align: center;">
                        <p style="color: #64748b; margin: 0;">${this.t('workflow.results.noResultsDesc')}</p>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
    }

    /**
     * Show the JSON payload this workflow would POST to /api/v1/workflows on save.
     * Reuses exportWorkflow() + the same payload assembly as saveWorkflow() so the
     * preview is byte-for-byte what the backend receives.
     */
    _showWorkflowJson() {
        const existingModal = document.getElementById('workflow-json-modal');
        if (existingModal) existingModal.remove();

        const workflow = this.exportWorkflow();
        const payload = {
            name: this.currentWorkflowName || 'My Workflow',
            description: this.currentWorkflowDescription || '',
            definition: {
                runtime_mode: this.runtimeMode || 'batch',
                llm_provider: this.runtimeMode === 'realtime' ? (this.audioLlmProvider || 'grok') : undefined,
                nodes: workflow.nodes,
                edges: workflow.edges
            },
            triggers: { schedule: { enabled: this.scheduleEnabled } },
            output_storage_enabled: this.outputStorageEnabled ? 1 : 0,
            output_folder: this.outputFolder || null
        };
        const pretty = JSON.stringify(payload, null, 2);
        const method = this.currentWorkflowId ? 'PUT' : 'POST';
        const path = this.currentWorkflowId
            ? `/api/v1/workflows/${this.currentWorkflowId}`
            : `/api/v1/workflows`;

        const modalHtml = `
            <div id="workflow-json-modal" class="workflow-results-overlay">
                <div class="workflow-results-container" style="max-width: 900px; max-height: 85vh; display: flex; flex-direction: column;">
                    <div class="workflow-results-header">
                        <h2 style="margin: 0;">Workflow JSON — <code style="font-size: 0.85em;">${method} ${path}</code></h2>
                        <button class="workflow-results-close" onclick="document.getElementById('workflow-json-modal').remove()">×</button>
                    </div>
                    <div class="workflow-results-body" style="padding: 16px; overflow: hidden; display: flex; flex-direction: column; gap: 12px;">
                        <div style="display: flex; gap: 8px;">
                            <button id="workflow-json-copy" style="padding: 6px 14px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">Copy to clipboard</button>
                            <button id="workflow-json-download" style="padding: 6px 14px; background: #16a34a; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 13px;">Download .json</button>
                            <span id="workflow-json-copy-status" style="align-self: center; color: #16a34a; font-size: 13px; display: none;">Copied.</span>
                            <span style="align-self: center; color: #64748b; font-size: 12px; margin-left: auto;">${workflow.nodes.length} nodes · ${workflow.edges.length} edges</span>
                        </div>
                        <pre id="workflow-json-pre" style="flex: 1; overflow: auto; background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 6px; font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 12px; line-height: 1.45; margin: 0; white-space: pre;"></pre>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        document.getElementById('workflow-json-pre').textContent = pretty;
        const copyBtn = document.getElementById('workflow-json-copy');
        const status = document.getElementById('workflow-json-copy-status');
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(pretty);
                status.style.display = 'inline';
                setTimeout(() => { status.style.display = 'none'; }, 2000);
            } catch (err) {
                status.textContent = 'Copy failed — select the text manually.';
                status.style.color = '#dc2626';
                status.style.display = 'inline';
            }
        });
        const downloadBtn = document.getElementById('workflow-json-download');
        downloadBtn?.addEventListener('click', () => {
            const safeName = (this.currentWorkflowName || 'workflow')
                .trim()
                .replace(/[^a-z0-9_\-]+/gi, '_')
                .replace(/^_+|_+$/g, '') || 'workflow';
            const blob = new Blob([pretty], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${safeName}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }

    /**
     * Import a workflow from a JSON file the user picks. The expected shape
     * is what `_showWorkflowJson()` produces — i.e. the same payload sent to
     * POST/PUT /api/v1/workflows. The imported workflow lands on the canvas
     * as an unsaved new workflow (currentWorkflowId = null) so Save creates
     * a fresh row instead of overwriting whatever was previously loaded.
     */
    _handleImportWorkflow() {
        // Re-entrancy guard: only ever one picker open at a time. Even if some
        // path invokes this more than once in a burst, the duplicates bail.
        if (this._importPickerOpen) return;
        this._importPickerOpen = true;

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.style.display = 'none';

        const done = () => {
            this._importPickerOpen = false;
            if (input.parentNode) document.body.removeChild(input);
        };

        input.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            try {
                if (file) this._applyImportedWorkflow(JSON.parse(await file.text()));
            } catch (err) {
                console.error('[WorkflowEditor] Import failed:', err);
                alert(`Import failed: ${err.message}`);
            }
            done();
        });
        // Cancel path: the 'cancel' event (Chrome 113+) plus a window-focus
        // fallback for browsers that don't fire it — both release the guard so
        // a later import still works. The 500ms delay lets 'change' win first.
        input.addEventListener('cancel', done);
        window.addEventListener('focus', () => {
            setTimeout(() => { if (this._importPickerOpen) done(); }, 500);
        }, { once: true });

        document.body.appendChild(input);
        input.click();
    }

    /**
     * Apply a parsed workflow JSON payload to the editor. Mirrors the
     * re-hydration done by loadWorkflow() but without hitting the backend.
     */
    _applyImportedWorkflow(payload) {
        const def = payload?.definition || {};
        const nodes = def.nodes;
        const edges = def.edges || [];
        if (!Array.isArray(nodes) || nodes.length === 0) {
            alert('Import failed: JSON has no definition.nodes array.');
            return;
        }

        this.clearWorkflow(true);
        this.dbNodeToDrawflowMap = {};

        this.currentWorkflowId = null;
        this.currentWorkflowName = payload.name || '';
        this.currentWorkflowDescription = payload.description || '';

        const isRealtime = def.runtime_mode === 'realtime'
            || nodes.some(n => {
                const t = n.type || n.node_type || n.config?.type || '';
                return typeof t === 'string' && t.startsWith('realtime-');
            });
        this.runtimeMode = isRealtime ? 'realtime' : 'batch';
        if (isRealtime) {
            const startNode = nodes.find(n => {
                const t = n.type || n.node_type || n.config?.type || '';
                return t === 'realtime-start';
            });
            this.audioLlmProvider = startNode?.config?.provider
                || def.llm_provider
                || 'grok';
        }
        this.updateConnectorStyleForMode();
        this.renderAgentsPanel();

        const infoBoxEl = document.getElementById('workflow-info-box');
        if (infoBoxEl) infoBoxEl.style.display = isRealtime ? 'none' : '';
        const audioInfoBoxEl = document.getElementById('audio-workflow-info-box');
        if (audioInfoBoxEl) audioInfoBoxEl.style.display = isRealtime ? '' : 'none';

        this.outputStorageEnabled = !!payload.output_storage_enabled;
        this.outputFolder = payload.output_folder || '';
        this.scheduleEnabled = !!(payload.triggers?.schedule?.enabled);

        this.importGraphFromBackend({ nodes, edges });
        this.restorePromptFromStartNode(nodes);

        this.updateWorkflowInfoBox();
        this.renderSavedWorkflowsList();
        this.hideHelpOverlay();
    }

    /**
     * Show storage configuration modal for Output node
     */
    showStorageConfigModal() {
        // Remove existing modal if any
        const existingModal = document.getElementById('storage-config-modal');
        if (existingModal) existingModal.remove();

        const storageEnabled = this.outputStorageEnabled;
        const outputFolder = this.outputFolder || '';

        const modalHtml = `
            <div id="storage-config-modal" class="storage-config-overlay">
                <div class="storage-config-modal">
                    <div class="storage-config-header">
                        <h3><span>💾</span> ${this.t('workflow.storage.title')}</h3>
                        <button class="storage-config-close" id="storage-config-close">×</button>
                    </div>
                    <div class="storage-config-body">
                        <div class="storage-config-toggle">
                            <div class="storage-config-toggle-label">
                                <span>${this.t('workflow.storage.enableStorage')}</span>
                                <span>${this.t('workflow.storage.enableStorageDesc')}</span>
                            </div>
                            <label class="storage-toggle-switch">
                                <input type="checkbox" id="storage-enabled-toggle" ${storageEnabled ? 'checked' : ''}>
                                <span class="storage-toggle-slider"></span>
                            </label>
                        </div>
                        <div class="storage-config-folder ${storageEnabled ? '' : 'disabled'}" id="storage-folder-section">
                            <label for="storage-folder-input">${this.t('workflow.storage.customFolder')}</label>
                            <input type="text" id="storage-folder-input" value="${this.escapeHtml(outputFolder)}" placeholder="${this.t('workflow.storage.customFolderPlaceholder')}">
                            <small>${this.t('workflow.storage.customFolderHint')}</small>
                        </div>
                    </div>
                    <div class="storage-config-footer">
                        <button class="storage-config-btn cancel" id="storage-config-cancel">${this.t('common.cancel')}</button>
                        <button class="storage-config-btn save" id="storage-config-save">${this.t('common.save')}</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('storage-config-modal');
        const closeBtn = document.getElementById('storage-config-close');
        const cancelBtn = document.getElementById('storage-config-cancel');
        const saveBtn = document.getElementById('storage-config-save');
        const enabledToggle = document.getElementById('storage-enabled-toggle');
        const folderSection = document.getElementById('storage-folder-section');

        // Toggle folder section enable/disable
        enabledToggle.addEventListener('change', () => {
            if (enabledToggle.checked) {
                folderSection.classList.remove('disabled');
            } else {
                folderSection.classList.add('disabled');
            }
        });

        // Close modal on background click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        // Close button
        closeBtn.addEventListener('click', () => modal.remove());
        cancelBtn.addEventListener('click', () => modal.remove());

        // Save button
        saveBtn.addEventListener('click', () => {
            const enabled = enabledToggle.checked;
            const folder = document.getElementById('storage-folder-input').value.trim();

            this.outputStorageEnabled = enabled;
            this.outputFolder = folder || null;

            // Update the Output node display
            this.updateOutputNodeDisplay();

            modal.remove();
        });
    }

    /**
     * Update the Output node display to reflect current storage settings
     */
    updateOutputNodeDisplay() {
        // Find the output node in drawflow
        if (!this.editor) return;

        const nodes = this.editor.drawflow?.drawflow?.Home?.data;
        if (!nodes) return;

        for (const nodeId in nodes) {
            const node = nodes[nodeId];
            if (node.name === 'output') {
                // Re-render the node HTML
                const newHtml = this.createOutputNodeHtml();
                this.editor.updateNodeDataFromId(nodeId, {});

                // Update DOM directly
                const nodeElement = document.getElementById(`node-${nodeId}`);
                if (nodeElement) {
                    const contentDiv = nodeElement.querySelector('.drawflow_content_node');
                    if (contentDiv) {
                        contentDiv.innerHTML = newHtml;
                        // The variant change alters the node's height, which moves
                        // its input/output ports — recalc its connections so the
                        // connector still reaches the endpoints.
                        try { this.editor.updateConnectionNodes('node-' + nodeId); } catch (_) {}
                    }
                }
                break;
            }
        }
    }

    /**
     * Re-render the Output node in place so it shows the variant (agent vs
     * ingestion) matching the current graph. The Output node is usually added
     * before the ingestion nodes, so its variant must flip when the workflow
     * type changes (a vectorstore/loader/splitter appears or disappears).
     * Reuses the same find-node-named-'output' + set innerHTML loop as
     * updateOutputNodeDisplay(); createOutputNodeHtml() picks the variant.
     */
    refreshOutputNodeVariant() {
        if (!this.editor) return;

        const nodes = this.editor.drawflow?.drawflow?.Home?.data;
        if (!nodes) return;

        for (const nodeId in nodes) {
            const node = nodes[nodeId];
            if (node.name === 'output') {
                const newHtml = this.createOutputNodeHtml();
                const nodeElement = document.getElementById(`node-${nodeId}`);
                if (nodeElement) {
                    const contentDiv = nodeElement.querySelector('.drawflow_content_node');
                    if (contentDiv) {
                        contentDiv.innerHTML = newHtml;
                        // The variant change alters the node's height, which moves
                        // its input/output ports — recalc its connections so the
                        // connector still reaches the endpoints.
                        try { this.editor.updateConnectionNodes('node-' + nodeId); } catch (_) {}
                    }
                }
                break;
            }
        }
    }

    /**
     * Re-render the Start node in place so it shows the variant (agent vs
     * ingestion) matching what it's connected to — mirrors
     * refreshOutputNodeVariant(). createStartNodeHtml() picks the variant.
     */
    refreshStartNodeVariant() {
        if (!this.editor) return;

        const nodes = this.editor.drawflow?.drawflow?.Home?.data;
        if (!nodes) return;

        for (const nodeId in nodes) {
            const node = nodes[nodeId];
            if (node.name === 'start') {
                const newHtml = this.createStartNodeHtml();
                const nodeElement = document.getElementById(`node-${nodeId}`);
                if (nodeElement) {
                    const contentDiv = nodeElement.querySelector('.drawflow_content_node');
                    if (contentDiv) {
                        contentDiv.innerHTML = newHtml;
                        // The variant change alters the node's height, which moves
                        // its input/output ports — recalc its connections so the
                        // connector still reaches the endpoints.
                        try { this.editor.updateConnectionNodes('node-' + nodeId); } catch (_) {}
                    }
                }
                break;
            }
        }
    }

    /**
     * Show prompt form overlay for entering/viewing user prompt
     */
    showPromptForm(callback = null) {
        // Remove existing modal if any
        const existingModal = document.getElementById('prompt-form-modal');
        if (existingModal) existingModal.remove();

        const buttonText = callback ? this.t('workflow.promptForm.run') : this.t('workflow.promptForm.save');
        const isRunMode = !!callback;

        // Get current schedule data
        const schedule = this.currentSchedule || {};
        const hasSchedule = !!schedule.id;
        const scheduleEnabled = hasSchedule || schedule.enabled;

        // Format datetime for input (local time)
        const formatDateTimeLocal = (dateStr) => {
            if (!dateStr) {
                // Default to now + 1 hour
                const d = new Date();
                d.setHours(d.getHours() + 1);
                d.setMinutes(0);
                return d.toISOString().slice(0, 16);
            }
            const d = new Date(dateStr);
            return d.toISOString().slice(0, 16);
        };

        const scheduledTime = formatDateTimeLocal(schedule.scheduled_time || schedule.next_run);

        const modalHtml = `
            <div id="prompt-form-modal" class="workflow-results-overlay">
                <div class="workflow-results-container" style="max-width: 600px;">
                    <div class="workflow-results-header" style="background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);">
                        <h2 style="display: flex; align-items: center; gap: 8px;">
                            <span style="font-size: 20px;">▶</span>
                            ${this.t('workflow.promptForm.title')}
                        </h2>
                        <button class="workflow-results-close" onclick="document.getElementById('prompt-form-modal').remove()">×</button>
                    </div>
                    <div class="workflow-results-body" style="padding: 16px;">
                        <textarea
                            id="prompt-form-textarea"
                            style="width: 100%; min-height: 120px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; resize: vertical; font-family: inherit; margin-bottom: 16px;"
                            placeholder="${this.t('workflow.promptForm.placeholder')}"
                        >${this.lastUserPrompt || schedule.input_prompt || ''}</textarea>

                        <!-- Schedule Section -->
                        <div id="schedule-section" style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px; background: #f9fafb;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <input type="checkbox" id="schedule-enabled" ${scheduleEnabled ? 'checked' : ''} style="width: 18px; height: 18px; cursor: pointer;">
                                <label for="schedule-enabled" style="font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                                    <span style="font-size: 16px;">🕐</span>
                                    ${this.t('workflow.schedule.enableSchedule')}
                                </label>
                                ${hasSchedule ? `<span style="margin-left: auto; font-size: 12px; color: #059669; background: #d1fae5; padding: 2px 8px; border-radius: 4px;">● ${this.t('workflow.schedule.scheduled')}</span>` : ''}
                            </div>

                            <div id="schedule-fields" style="display: ${scheduleEnabled ? 'block' : 'none'};">
                                <!-- Date/Time -->
                                <div style="margin-bottom: 12px;">
                                    <label style="display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px;">${this.t('workflow.schedule.runAt')}</label>
                                    <input type="datetime-local" id="schedule-datetime" value="${scheduledTime}"
                                        style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;">
                                </div>

                                <!-- Repeat Type -->
                                <div style="display: flex; gap: 12px; align-items: flex-end;">
                                    <div style="flex: 1;">
                                        <label style="display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px;">${this.t('workflow.schedule.repeat')}</label>
                                        <select id="schedule-repeat-type" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; background: white;">
                                            <option value="none" ${(schedule.repeat_type || 'none') === 'none' ? 'selected' : ''}>${this.t('workflow.schedule.repeatOptions.none')}</option>
                                            <option value="hourly" ${schedule.repeat_type === 'hourly' ? 'selected' : ''}>${this.t('workflow.schedule.repeatOptions.hourly')}</option>
                                            <option value="daily" ${schedule.repeat_type === 'daily' ? 'selected' : ''}>${this.t('workflow.schedule.repeatOptions.daily')}</option>
                                            <option value="weekly" ${schedule.repeat_type === 'weekly' ? 'selected' : ''}>${this.t('workflow.schedule.repeatOptions.weekly')}</option>
                                            <option value="monthly" ${schedule.repeat_type === 'monthly' ? 'selected' : ''}>${this.t('workflow.schedule.repeatOptions.monthly')}</option>
                                        </select>
                                    </div>
                                    <div id="repeat-interval-container" style="width: 120px; display: ${schedule.repeat_type && schedule.repeat_type !== 'none' ? 'block' : 'none'};">
                                        <label style="display: block; font-size: 13px; color: #6b7280; margin-bottom: 4px;">${this.t('workflow.schedule.every')}</label>
                                        <input type="number" id="schedule-repeat-interval" value="${schedule.repeat_interval || 1}" min="1" max="99"
                                            style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; text-align: center;">
                                    </div>
                                </div>

                                ${hasSchedule ? `
                                <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #e5e7eb;">
                                    <button id="delete-schedule-btn" style="padding: 8px 16px; border: 1px solid #fca5a5; background: #fef2f2; color: #dc2626; border-radius: 6px; cursor: pointer; font-size: 13px;">
                                        ${this.t('workflow.schedule.deleteSchedule')}
                                    </button>
                                </div>
                                ` : ''}
                            </div>
                        </div>

                        <div style="display: flex; justify-content: flex-end; gap: 10px;">
                            <button
                                id="prompt-form-cancel"
                                style="padding: 10px 20px; border: 1px solid #d1d5db; background: #f9fafb; border-radius: 6px; cursor: pointer; font-size: 14px;"
                            >${this.t('common.cancel')}</button>
                            ${!isRunMode ? `
                            <button
                                id="prompt-form-save-schedule"
                                style="padding: 10px 20px; border: none; background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); color: white; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; display: none;"
                            >${this.t('workflow.schedule.saveSchedule')}</button>
                            ` : ''}
                            <button
                                id="prompt-form-submit"
                                style="padding: 10px 20px; border: none; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;"
                            >${buttonText}</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('prompt-form-modal');
        const textarea = document.getElementById('prompt-form-textarea');
        const cancelBtn = document.getElementById('prompt-form-cancel');
        const submitBtn = document.getElementById('prompt-form-submit');
        const scheduleEnabledChk = document.getElementById('schedule-enabled');
        const scheduleFields = document.getElementById('schedule-fields');
        const repeatTypeSelect = document.getElementById('schedule-repeat-type');
        const repeatIntervalContainer = document.getElementById('repeat-interval-container');
        const saveScheduleBtn = document.getElementById('prompt-form-save-schedule');
        const deleteScheduleBtn = document.getElementById('delete-schedule-btn');

        // Focus textarea
        textarea.focus();

        // Toggle schedule fields visibility
        scheduleEnabledChk.addEventListener('change', () => {
            scheduleFields.style.display = scheduleEnabledChk.checked ? 'block' : 'none';
            if (saveScheduleBtn) {
                saveScheduleBtn.style.display = scheduleEnabledChk.checked ? 'inline-block' : 'none';
            }
        });

        // Show/hide repeat interval based on repeat type
        repeatTypeSelect.addEventListener('change', () => {
            repeatIntervalContainer.style.display = repeatTypeSelect.value !== 'none' ? 'block' : 'none';
        });

        // Show save schedule button if enabled
        if (saveScheduleBtn && scheduleEnabledChk.checked) {
            saveScheduleBtn.style.display = 'inline-block';
        }

        // Handle cancel
        cancelBtn.addEventListener('click', () => modal.remove());

        // Handle save schedule
        if (saveScheduleBtn) {
            saveScheduleBtn.addEventListener('click', async () => {
                if (!this.currentWorkflowId) {
                    alert(this.t('workflow.messages.saveFirst'));
                    return;
                }

                const scheduleData = {
                    workflow_id: this.currentWorkflowId,
                    input_prompt: textarea.value.trim(),
                    scheduled_time: document.getElementById('schedule-datetime').value,
                    repeat_type: repeatTypeSelect.value,
                    repeat_interval: parseInt(document.getElementById('schedule-repeat-interval').value) || 1
                };

                const success = await this.saveSchedule(scheduleData);
                if (success) {
                    modal.remove();
                }
            });
        }

        // Handle delete schedule
        if (deleteScheduleBtn) {
            deleteScheduleBtn.addEventListener('click', async () => {
                if (this.currentSchedule?.id) {
                    const success = await this.deleteSchedule(this.currentSchedule.id);
                    if (success) {
                        modal.remove();
                    }
                }
            });
        }

        // Handle submit
        submitBtn.addEventListener('click', () => {
            const prompt = textarea.value.trim();
            modal.remove();
            // Always persist the prompt to the start node so it's available
            // for code generation and future sessions.
            this.lastUserPrompt = prompt;
            this.savePromptToStartNode(prompt);
            this.updateStartNodeIndicator(!!prompt);
            this.autoPersistWorkflow();

            if (callback && prompt) {
                callback(prompt);
            }
        });

        // Handle Enter key (Ctrl+Enter or Cmd+Enter to submit)
        textarea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                const prompt = textarea.value.trim();
                modal.remove();
                if (callback && prompt) {
                    callback(prompt);
                }
            }
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    /**
     * Show save overlay with Save and Save As options
     */
    showSaveOverlay() {
        // Remove existing modal if any
        const existingModal = document.getElementById('save-options-modal');
        if (existingModal) existingModal.remove();

        // Get button position to place panel next to it
        const saveBtn = document.getElementById('workflow-save-toggle');
        const btnRect = saveBtn.getBoundingClientRect();

        const modalHtml = `
            <div id="save-options-modal" class="workflow-save-overlay">
                <div class="workflow-save-panel" style="bottom: ${window.innerHeight - btnRect.bottom}px; right: ${window.innerWidth - btnRect.left + 8}px;">
                    <button id="save-option-save" class="workflow-save-option">
                        💾 ${this.t('workflow.save')}
                    </button>
                    <button id="save-option-saveas" class="workflow-save-option">
                        📄 ${this.t('workflow.saveAs')}
                    </button>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('save-options-modal');
        const saveBtnOption = document.getElementById('save-option-save');
        const saveAsBtn = document.getElementById('save-option-saveas');

        // Handle Save
        saveBtnOption.addEventListener('click', () => {
            modal.remove();
            this.saveWorkflow();
        });

        // Handle Save As
        saveAsBtn.addEventListener('click', () => {
            modal.remove();
            this.saveWorkflowAs();
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    /**
     * Show workflow type selector popup (Batch Workflow / Audio Workflow)
     * Same UI pattern as the save button's dropdown.
     */
    showNewWorkflowTypeSelector(btn) {
        const existingModal = document.getElementById('new-workflow-type-modal');
        if (existingModal) existingModal.remove();

        const btnRect = btn.getBoundingClientRect();

        const modalHtml = `
            <div id="new-workflow-type-modal" class="workflow-save-overlay">
                <div class="workflow-save-panel" style="top: ${btnRect.top - 90}px; left: ${btnRect.right + 8}px;">
                    <button id="new-wf-batch" class="workflow-save-option">
                        ⚙️ Batch Workflow
                    </button>
                    <button id="new-wf-realtime" class="workflow-save-option">
                        🎙 Audio Workflow
                    </button>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('new-workflow-type-modal');

        document.getElementById('new-wf-batch').addEventListener('click', () => {
            modal.remove();
            this.runtimeMode = 'batch';
            this.clearWorkflow(false);
            // Restore batch-specific UI elements
            const infoBox = document.getElementById('workflow-info-box');
            if (infoBox) infoBox.style.display = '';
            const audioInfoBox = document.getElementById('audio-workflow-info-box');
            if (audioInfoBox) audioInfoBox.style.display = 'none';
            this._scheduleFormAutoCollapse(infoBox);
            this.updateConnectorStyleForMode();
            this.renderAgentsPanel();
        });

        document.getElementById('new-wf-realtime').addEventListener('click', () => {
            modal.remove();
            this.runtimeMode = 'realtime';
            this.clearWorkflow(false);
            this.setupRealtimeCanvas();
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    /**
     * Set up the canvas for a realtime audio workflow:
     * - Hide batch-specific overlays (settings form, help overlay)
     * - Update connector styling
     * - Refresh the sidebar palette with realtime node types
     * - Add a Start node automatically
     */
    setupRealtimeCanvas() {
        console.log('[WorkflowEditor] Setting up realtime canvas');

        // Hide batch-specific overlays
        this.hideHelpOverlay();
        const infoBox = document.getElementById('workflow-info-box');
        if (infoBox) infoBox.style.display = 'none';
        const audioInfoBox = document.getElementById('audio-workflow-info-box');
        if (audioInfoBox) audioInfoBox.style.display = '';
        this._scheduleFormAutoCollapse(audioInfoBox);

        // Update connector styling for realtime mode
        this.updateConnectorStyleForMode();

        // Refresh the sidebar to show realtime palette
        this.renderAgentsPanel();

        // Automatically add a realtime Start node
        this.addRealtimeStartNode(100, 200);
    }

    /**
     * Update connector CSS based on runtime mode.
     * Batch: animated flowing dashes. Realtime: static colored dashes.
     */
    updateConnectorStyleForMode() {
        let styleEl = document.getElementById('realtime-connector-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'realtime-connector-style';
            document.head.appendChild(styleEl);
        }

        if (this.runtimeMode === 'realtime') {
            styleEl.textContent = `
                .drawflow .connection .main-path {
                    stroke: #10b981 !important;
                    stroke-width: 3px !important;
                    stroke-dasharray: 8 8 !important;
                    animation: none !important;
                }
                .drawflow .connection:hover .main-path {
                    stroke: #34d399 !important;
                    filter: drop-shadow(0 0 6px rgba(16, 185, 129, 0.5));
                }
            `;
        } else {
            styleEl.textContent = '';
        }
    }

    /**
     * Render the right sidebar palette for realtime audio workflows.
     * Shows: Start (with Play), Agent (with mic), End.
     */
    renderRealtimeAgentsPanel() {
        const collapsedSections = JSON.parse(localStorage.getItem('workflowPanelCollapsed') || '{}');

        this.agentsPanel.innerHTML = `
            <div class="workflow-agents-list" id="workflow-agents-list">
                <!-- Realtime Essentials -->
                <div class="workflow-section">
                    <div class="workflow-section-header" data-section="rt-essentials">
                        <span class="section-toggle">${collapsedSections['rt-essentials'] ? '▶' : '▼'}</span>
                        <span class="section-title">🎙 ${this.t('workflow.realtime.audioWorkflowPaletteTitle')}</span>
                        <span class="section-count">3</span>
                    </div>
                    <div class="workflow-section-content ${collapsedSections['rt-essentials'] ? 'collapsed' : ''}" data-section="rt-essentials">
                        <!-- Realtime Start Node -->
                        <div class="workflow-agent-card special start-node"
                             draggable="true"
                             data-node-type="realtime-start">
                            <div class="agent-icon" style="background: #d1fae5; color: #059669;">▶</div>
                            <div class="agent-info">
                                <div class="agent-name">${this.t('workflow.realtime.paletteStart')}</div>
                                <div class="agent-type">${this.t('workflow.realtime.paletteStartHint')}</div>
                            </div>
                        </div>
                        <!-- Audio Agent Template (draggable, creates a new instance each time) -->
                        <div class="workflow-agent-card special"
                             draggable="true"
                             data-node-type="realtime-agent">
                            <div class="agent-icon" style="background: #dbeafe; color: #2563eb;">🎙</div>
                            <div class="agent-info">
                                <div class="agent-name">${this.t('workflow.realtime.paletteAudioAgent')}</div>
                                <div class="agent-type">${this.t('workflow.realtime.paletteAudioAgentHint')}</div>
                            </div>
                        </div>
                        <!-- End Node -->
                        <div class="workflow-agent-card special output-node"
                             draggable="true"
                             data-node-type="realtime-end">
                            <div class="agent-icon" style="background: #fee2e2; color: #dc2626;">■</div>
                            <div class="agent-info">
                                <div class="agent-name">${this.t('workflow.realtime.paletteEnd')}</div>
                                <div class="agent-type">${this.t('workflow.realtime.paletteEndHint')}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Action Buttons -->
            <div class="workflow-actions">
                <button id="workflow-save-toggle" class="workflow-btn primary">
                    ${this.t('workflow.saveWorkflow')}
                </button>
            </div>
        `;

        // Re-attach event listeners
        document.getElementById('workflow-save-toggle')?.addEventListener('click', () => {
            this.showSaveOverlay();
        });

        // Set up section toggle click handlers
        this.agentsPanel.querySelectorAll('.workflow-section-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.classList.contains('section-add-btn')) return;
                this.toggleSection(e.currentTarget);
            });
        });

        // Re-attach drag events on the new palette cards
        this.agentsPanel.querySelectorAll('.workflow-agent-card').forEach(card => {
            card.addEventListener('dragstart', (e) => this.onDragStart(e, card));
            card.addEventListener('dragend', (e) => this.onDragEnd(e, card));
        });
    }

    /**
     * Add a realtime Start node to the canvas.
     * Contains: provider selector, Play button for test mode.
     */
    addRealtimeStartNode(x = 100, y = 200) {
        const nodeId = this.editor.addNode(
            'realtime_start',
            0,    // no inputs
            1,    // one output
            x, y,
            'realtime-start',
            {
                type: 'realtime-start',
                runtime_mode: 'realtime',
                provider: this.audioLlmProvider || 'grok'
            },
            this.createRealtimeStartNodeHtml()
        );

        this.wireRealtimeStartNode(nodeId);
        return nodeId;
    }

    /**
     * Copy the current `audioLlmProvider` onto the realtime-start node's
     * config so the selection persists when the workflow is saved.
     */
    _stampProviderOnStartNode() {
        const exported = this.editor.export();
        const drawflowData = exported.drawflow?.Home?.data || {};
        for (const [id, node] of Object.entries(drawflowData)) {
            if (node.data?.type === 'realtime-start') {
                const updatedData = { ...node.data, provider: this.audioLlmProvider || 'grok' };
                this.editor.updateNodeDataFromId(id, updatedData);
                break;
            }
        }
    }

    createRealtimeStartNodeHtml() {
        return `
            <div class="workflow-node start-node realtime-start-node">
                <div class="node-header">
                    <span class="node-icon">▶</span>
                    <span class="node-title">${this.t('workflow.realtime.canvasStartLabel')}</span>
                </div>
                <div class="node-body">
                    <small>${this.t('workflow.realtime.canvasStartSubtitle')}</small>
                    <button class="realtime-play-btn" title="${this.t('workflow.realtime.playTestTitle')}">▶</button>
                </div>
            </div>
        `;
    }

    wireRealtimeStartNode(nodeId) {
        setTimeout(() => {
            const nodeEl = document.querySelector(`#node-${nodeId}`);
            if (!nodeEl) return;
            const playBtn = nodeEl.querySelector('.realtime-play-btn');
            if (playBtn && !playBtn.dataset.wired) {
                playBtn.dataset.wired = '1';
                playBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.startRealtimeTest();
                });
            }
        }, 100);
    }

    /**
     * Add a realtime Audio Agent node to the canvas.
     * Each drop creates a new instance. Click to configure via inspector.
     */
    addRealtimeAgentNode(x = 400, y = 200) {
        if (!this._realtimeAgentCounter) this._realtimeAgentCounter = 0;
        const instanceNum = ++this._realtimeAgentCounter;
        const defaultName = `Agent ${instanceNum}`;

        const nodeId = this.editor.addNode(
            `rt_agent_${Date.now()}`,
            1,    // one input
            1,    // one output
            x, y,
            'realtime-agent',
            {
                type: 'realtime-agent',
                agent_name: defaultName,
                voice: 'Ara',
                systemPrompt: '',
                handoffTargets: [],
                whenDone: { type: 'return' },
                transferDelay: 1,
                runtime_mode: 'realtime'
            },
            this.createRealtimeAgentNodeHtml(defaultName, 'Ara', `rt-${instanceNum}`)
        );

        return nodeId;
    }

    createRealtimeAgentNodeHtml(name, voice, dataAgentId) {
        return `
            <div class="workflow-node agent-node worker" data-agent-id="${this.escapeHtml(dataAgentId || '')}">
                <div class="node-header">
                    <span class="node-icon">🎙</span>
                    <span class="node-title rt-agent-name">${this.escapeHtml(name || 'Agent')}</span>
                    <button class="node-delete-btn" title="Delete node">×</button>
                </div>
                <div class="node-body">
                    <span class="node-timer rt-agent-voice">${this.escapeHtml(voice || 'Ara')}</span>
                    <button class="node-edit-btn" data-rt-node="true" title="Edit agent">✏️</button>
                </div>
            </div>
        `;
    }

    createRealtimeEndNodeHtml() {
        return `
            <div class="workflow-node output-node">
                <div class="node-header">
                    <span class="node-icon">■</span>
                    <span class="node-title">${this.t('workflow.realtime.canvasEndLabel')}</span>
                </div>
                <div class="node-body">
                    <small>${this.t('workflow.realtime.canvasEndSubtitle')}</small>
                </div>
            </div>
        `;
    }

    /**
     * Show the realtime agent edit form (inspector modal).
     * Fields: name, voice, system prompt, handoff targets, when done, transfer delay.
     */
    showRealtimeAgentEditForm(nodeId) {
        const nodeData = this.editor.getNodeFromId(nodeId);
        if (!nodeData) return;
        const data = nodeData.data || {};

        // Collect all other agent nodes for handoff target and "goto" selection
        const exported = this.editor.export();
        const allNodes = exported.drawflow?.Home?.data || {};
        const otherAgents = [];
        for (const [id, node] of Object.entries(allNodes)) {
            if ((node.data?.type === 'agent' || node.data?.type === 'realtime-agent') && String(id) !== String(nodeId)) {
                otherAgents.push({ id: String(id), name: node.data.agent_name || `Agent ${id}` });
            }
        }

        // Compute "previous state" (which agents have this one as a handoff target)
        // For now, derive from edges (who connects TO this node)
        const previousStates = [];
        for (const [id, node] of Object.entries(allNodes)) {
            if ((node.data?.type === 'agent' || node.data?.type === 'realtime-agent') && String(id) !== String(nodeId)) {
                for (const [outputKey, conns] of Object.entries(node.outputs || {})) {
                    for (const conn of conns.connections || []) {
                        if (String(conn.node) === String(nodeId)) {
                            previousStates.push(node.data.agent_name || `Agent ${id}`);
                        }
                    }
                }
            }
            // Also check if start node connects here
            if (node.data?.type === 'realtime-start') {
                for (const [outputKey, conns] of Object.entries(node.outputs || {})) {
                    for (const conn of conns.connections || []) {
                        if (String(conn.node) === String(nodeId)) {
                            previousStates.push('Start');
                        }
                    }
                }
            }
        }

        // Voice lists per provider. The modal's Voice dropdown stays in sync
        // with the Provider dropdown so users only see valid options.
        const voicesByProvider = {
            grok: ['Ara', 'Rex', 'Sal', 'Eve', 'Leo'],
            gemini: ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede']
        };
        const defaultVoice = { grok: 'Ara', gemini: 'Kore' };
        const currentProvider = data.provider || this.audioLlmProvider || 'grok';
        const voices = voicesByProvider[currentProvider] || voicesByProvider.grok;
        const currentWhenDone = data.whenDone || { type: 'return' };

        const gotoOptions = otherAgents.map(a =>
            `<option value="${a.id}" ${currentWhenDone.type === 'goto' && currentWhenDone.target === a.id ? 'selected' : ''}>${this.escapeHtml(a.name)}</option>`
        ).join('');

        // Remove existing modal
        document.getElementById('rt-agent-edit-modal')?.remove();

        const modalHtml = `
            <div id="rt-agent-edit-modal" class="fixed inset-0 z-[200] flex items-center justify-center" style="background-color: rgba(0,0,0,0.5);">
                <div class="bg-white rounded-xl shadow-xl w-full mx-4" style="max-width: 1100px; max-height: 85vh; overflow-y: auto;">
                    <!-- Header -->
                    <div class="flex items-center justify-between px-5 py-3 border-b" style="background: linear-gradient(135deg, #dbeafe, #ede9fe);">
                        <div class="flex items-center gap-2">
                            <span style="font-size: 18px;">🎙</span>
                            <h3 class="text-base font-semibold text-gray-800">${this.t('workflow.realtime.audioAgent')}</h3>
                        </div>
                        <button id="rt-agent-modal-close" class="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded">✕</button>
                    </div>

                    <!-- Form: 2-column layout -->
                    <div class="p-5" style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">

                        <!-- LEFT COLUMN: Identity -->
                        <div style="display: flex; flex-direction: column; gap: 16px;">
                            <h4 style="font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin: 0;">${this.t('workflow.realtime.identity')}</h4>

                            <!-- Name -->
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('workflow.realtime.name')}</label>
                                <input type="text" id="rt-agent-name" class="w-full border rounded-lg px-3 py-2 text-sm" value="${this.escapeHtml(data.agent_name || '')}">
                            </div>

                            <!-- Provider (read-only, workflow-level) + Voice — side by side -->
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                                <div>
                                    <label class="block text-sm font-medium text-gray-500 mb-1">${this.t('workflow.realtime.providerReadOnly')}</label>
                                    <div class="bg-gray-50 border rounded-lg px-3 py-2 text-sm text-gray-600" title="${this.escapeHtml(this.t('workflow.realtime.providerTooltip'))}">
                                        ${currentProvider === 'gemini' ? 'Gemini' : 'Grok'}
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('workflow.realtime.voice')}</label>
                                    <select id="rt-agent-voice" class="w-full border rounded-lg px-3 py-2 text-sm">
                                        ${voices.map(v => `<option value="${v}" ${data.voice === v ? 'selected' : ''}>${v}</option>`).join('')}
                                    </select>
                                </div>
                            </div>

                            <!-- System Prompt -->
                            <div style="flex: 1; display: flex; flex-direction: column;">
                                <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('workflow.realtime.systemPrompt')}</label>
                                <textarea id="rt-agent-prompt" class="w-full border rounded-lg px-3 py-2 text-sm" style="flex: 1; min-height: 300px; resize: vertical;" placeholder="${this.escapeHtml(this.t('workflow.realtime.systemPromptPlaceholder'))}">${this.escapeHtml(data.systemPrompt || '')}</textarea>
                            </div>
                        </div>

                        <!-- RIGHT COLUMN: Routing -->
                        <div style="display: flex; flex-direction: column; gap: 16px;">
                            <h4 style="font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; margin: 0;">${this.t('workflow.realtime.routing')}</h4>

                            <!-- Previous State (read-only) + Transfer delay — side by side -->
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                                <div>
                                    <label class="block text-sm font-medium text-gray-500 mb-1">${this.t('workflow.realtime.previousState')}</label>
                                    <div class="text-sm text-gray-600 bg-gray-50 rounded-lg px-3 py-2">
                                        ${previousStates.length > 0 ? this.escapeHtml(previousStates.join(', ')) : `<span style="color: #999;">${this.escapeHtml(this.t('workflow.realtime.notConnectedYet'))}</span>`}
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('workflow.realtime.transferDelay')}</label>
                                    <input type="number" id="rt-agent-delay" class="w-full border rounded-lg px-3 py-2 text-sm" value="${data.transferDelay || 1}" min="0" max="10" step="0.5">
                                </div>
                            </div>

                            <!-- When Done -->
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('workflow.realtime.whenDone')}</label>
                                <div class="bg-gray-50 rounded-lg px-3 py-2 text-sm space-y-2">
                                    <label style="display: flex; align-items: center; gap: 6px;">
                                        <input type="radio" name="rt-when-done" value="return" ${currentWhenDone.type === 'return' ? 'checked' : ''}>
                                        ${this.t('workflow.realtime.returnToCaller')}
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 6px;">
                                        <input type="radio" name="rt-when-done" value="goto" ${currentWhenDone.type === 'goto' ? 'checked' : ''}>
                                        ${this.t('workflow.realtime.goTo')}
                                        <select id="rt-goto-target" class="border rounded px-2 py-1 text-sm" ${currentWhenDone.type !== 'goto' ? 'disabled' : ''}>
                                            <option value="">${this.escapeHtml(this.t('workflow.realtime.selectAgent'))}</option>
                                            ${gotoOptions}
                                        </select>
                                    </label>
                                </div>
                            </div>

                            <!-- Functions -->
                            <div>
                                <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('workflow.realtime.functions')}</label>
                                <div class="bg-gray-50 rounded-lg px-3 py-2 text-sm" style="max-height: 220px; overflow-y: auto;">
                                    ${(this.toolCatalog && this.toolCatalog.length > 0)
                                        ? this.toolCatalog.map(t => {
                                            const checked = (data.selectedTools || []).includes(t.name);
                                            const badge = t.type === 'mcp'
                                                ? `<span style="background:#ede9fe;color:#6d28d9;padding:1px 5px;border-radius:4px;font-size:10px;">${this.escapeHtml(this.t('workflow.realtime.mcpBadge'))}${t.server ? ' · ' + this.escapeHtml(t.server) : ''}</span>`
                                                : `<span style="background:#dbeafe;color:#1d4ed8;padding:1px 5px;border-radius:4px;font-size:10px;">${this.escapeHtml(this.t('workflow.realtime.builtinBadge'))}</span>`;
                                            return `
                                                <label style="display:flex; align-items:flex-start; gap:8px; padding:3px 0; cursor:pointer;">
                                                    <input type="checkbox" name="rt-agent-tool" value="${this.escapeHtml(t.name)}" ${checked ? 'checked' : ''} style="margin-top:3px;">
                                                    <div style="flex:1; min-width:0;">
                                                        <div style="display:flex; align-items:center; gap:6px; font-family: monospace; font-size: 12px;">
                                                            ${this.escapeHtml(t.name)} ${badge}
                                                        </div>
                                                        <div style="font-size: 11px; color: #6b7280; line-height: 1.4;">
                                                            ${this.escapeHtml((t.description || '').slice(0, 160))}
                                                        </div>
                                                    </div>
                                                </label>
                                            `;
                                        }).join('')
                                        : `<span style="color:#999; font-style:italic;">${this.escapeHtml(this.t('workflow.realtime.noToolsAvailable'))}</span>`
                                    }
                                </div>
                            </div>
                        </div>

                    </div>

                    <!-- Footer -->
                    <div class="flex justify-end gap-2 px-5 py-3 border-t bg-gray-50 rounded-b-xl">
                        <button id="rt-agent-modal-cancel" class="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">${this.t('workflow.realtime.cancel')}</button>
                        <button id="rt-agent-modal-save" class="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-lg font-medium">${this.t('workflow.realtime.save')}</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Enable/disable goto dropdown based on radio selection
        document.querySelectorAll('input[name="rt-when-done"]').forEach(radio => {
            radio.addEventListener('change', () => {
                document.getElementById('rt-goto-target').disabled = radio.value !== 'goto';
            });
        });

        // Close handlers
        document.getElementById('rt-agent-modal-close').addEventListener('click', () => {
            document.getElementById('rt-agent-edit-modal').remove();
        });
        document.getElementById('rt-agent-modal-cancel').addEventListener('click', () => {
            document.getElementById('rt-agent-edit-modal').remove();
        });

        // Save handler
        document.getElementById('rt-agent-modal-save').addEventListener('click', () => {
            const name = document.getElementById('rt-agent-name').value.trim() || 'Agent';
            const voice = document.getElementById('rt-agent-voice').value;
            const prompt = document.getElementById('rt-agent-prompt').value;
            const delay = parseFloat(document.getElementById('rt-agent-delay').value) || 1;

            // When done
            const whenDoneType = document.querySelector('input[name="rt-when-done"]:checked')?.value || 'return';
            const whenDone = whenDoneType === 'goto'
                ? { type: 'goto', target: document.getElementById('rt-goto-target').value }
                : { type: 'return' };

            // Collect selected tools
            const selectedTools = [];
            document.querySelectorAll('input[name="rt-agent-tool"]:checked').forEach(cb => {
                selectedTools.push(cb.value);
            });

            // Update node data. Provider is not stored on the agent — it's a
            // workflow-level field (see the workflow settings form).
            const updatedData = {
                ...nodeData.data,
                agent_name: name,
                voice: voice,
                systemPrompt: prompt,
                whenDone: whenDone,
                transferDelay: delay,
                selectedTools: selectedTools
            };
            this.editor.updateNodeDataFromId(nodeId, updatedData);

            // Update the visual card on the canvas
            const nodeEl = document.querySelector(`#node-${nodeId}`);
            if (nodeEl) {
                const nameEl = nodeEl.querySelector('.rt-agent-name');
                if (nameEl) nameEl.textContent = name;
                const voiceEl = nodeEl.querySelector('.rt-agent-voice');
                if (voiceEl) voiceEl.textContent = voice;
            }

            document.getElementById('rt-agent-edit-modal').remove();
        });
    }

    /**
     * Add a realtime End node to the canvas.
     */
    addRealtimeEndNode(x = 800, y = 200) {
        return this.editor.addNode(
            'realtime_end',
            1,    // one input
            0,    // no outputs
            x, y,
            'realtime-end',
            { type: 'realtime-end' },
            this.createRealtimeEndNodeHtml()
        );
    }

    /**
     * Start a realtime test session from the Play button on the Start node.
     * Opens an overlay with mic/speaker, runs the workflow engine.
     */
    async startRealtimeTest() {
        // Guard against double-invocation — the canvas-level click handler
        // and the inner Play button both fire for the same click.
        if (document.getElementById('realtime-overlay')) return;

        const graph = this.buildRealtimeGraph();
        if (!graph || !graph.startAgent) {
            alert('Connect at least one agent to the Start node.');
            return;
        }

        this.showRealtimeOverlay(graph);
    }

    /**
     * Show an in-page overlay that runs the audio workflow session.
     * Creates its own AudioStreamer / adapter / runner, wires the canvas
     * node highlight directly, and cleans up on stop/close.
     */
    showRealtimeOverlay(graph) {
        const overlayHtml = `
            <div id="realtime-overlay" style="
                position: fixed; top: 80px; left: 20px; width: 520px; max-height: 70vh;
                z-index: 400; background: #0f172a; color: #e2e8f0;
                border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.4);
                font-family: -apple-system, system-ui, sans-serif; overflow: hidden;
                display: flex; flex-direction: column;">
                <div style="display: flex; justify-content: space-between; align-items: center;
                            padding: 12px 16px; border-bottom: 1px solid #1e293b;">
                    <span style="color: #10b981; font-weight: 600; font-size: 14px;">🎙 Audio Workflow — Live Session</span>
                    <button id="realtime-overlay-stop" style="
                        background: #dc2626; color: white; border: none;
                        padding: 6px 14px; border-radius: 6px; cursor: pointer;
                        font-size: 12px; font-weight: 600;">■ Stop</button>
                </div>
                <div id="realtime-overlay-status" style="color: #fbbf24; font-size: 12px; padding: 8px 16px;">Connecting…</div>
                <div id="realtime-overlay-active" style="
                    margin: 0 16px 10px; padding: 8px 12px;
                    background: #1e293b; border: 2px solid #10b981; border-radius: 6px;
                    font-size: 12px;">Active: —</div>
                <div id="realtime-overlay-transcript" style="
                    margin: 0 16px 16px; padding: 10px 12px; background: #020617;
                    border-radius: 6px; flex: 1; overflow-y: auto; min-height: 180px;
                    font-family: monospace; font-size: 11px; line-height: 1.6;"></div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', overlayHtml);

        const overlay = document.getElementById('realtime-overlay');
        const statusEl = document.getElementById('realtime-overlay-status');
        const activeEl = document.getElementById('realtime-overlay-active');
        const transcriptEl = document.getElementById('realtime-overlay-transcript');
        const stopBtn = document.getElementById('realtime-overlay-stop');

        const addLine = (text, color = '#e2e8f0') => {
            const div = document.createElement('div');
            div.style.color = color;
            div.textContent = text;
            transcriptEl.appendChild(div);
            transcriptEl.scrollTop = transcriptEl.scrollHeight;
        };

        const highlight = (agentKey) => {
            document.querySelectorAll('.drawflow-node').forEach(n => n.classList.remove('node-active'));
            const nodeId = graph.agents[agentKey]?._nodeId;
            if (nodeId) {
                const nodeEl = document.querySelector(`#node-${nodeId}`);
                if (nodeEl) nodeEl.classList.add('node-active');
            }
        };

        const providerName = this.audioLlmProvider || 'grok';
        const AdapterClass = providerName === 'gemini'
            ? window.GeminiRealtimeAdapter
            : window.GrokRealtimeAdapter;
        if (!AdapterClass) {
            alert(`Realtime adapter for "${providerName}" isn't loaded.`);
            return;
        }
        const adapter = new AdapterClass();
        const audioStreamer = new window.AudioStreamer({
            onAudioData: (base64) => {
                if (runner?.running && adapter.isReady()) adapter.sendAudio(base64);
            }
        });
        adapter.onAudio = (b64) => audioStreamer.playAudio(b64);

        const runner = new window.RealtimeWorkflowRunner(graph, adapter, {
            onStateChange: (agentKey) => {
                const agent = graph.agents[agentKey];
                activeEl.textContent = `Active: ${agent?.name || agentKey} (voice: ${agent?.voice || '?'})`;
                highlight(agentKey);
            },
            onTranscript: (text, isFinal, direction, agentKey) => {
                if (!isFinal) return;
                const agent = graph.agents[agentKey];
                if (direction === 'in') addLine(`🗣 You: "${text}"`, '#a78bfa');
                else addLine(`🎙 ${agent?.name || agentKey}: "${text}"`, '#60a5fa');
            },
            onEvent: (type, data) => {
                if (type === 'handoff_execute') {
                    addLine(`→ Handoff: ${data.type} to ${graph.agents[data.to]?.name || data.to}`, '#f472b6');
                } else if (type === 'end_execute') {
                    addLine('■ Session ended', '#f472b6');
                }
            },
            onEnd: (reason) => {
                statusEl.textContent = `Session ended: ${reason}`;
                statusEl.style.color = '#94a3b8';
                activeEl.textContent = 'Active: —';
                document.querySelectorAll('.drawflow-node').forEach(n => n.classList.remove('node-active'));
                // Briefly highlight the End node so users see where the workflow finished.
                try {
                    const exported = this.editor.export();
                    const drawflowData = exported.drawflow?.Home?.data || {};
                    const endNodeId = Object.keys(drawflowData).find(id =>
                        drawflowData[id]?.data?.type === 'realtime-end'
                    );
                    if (endNodeId) {
                        const endEl = document.querySelector(`#node-${endNodeId}`);
                        if (endEl) {
                            endEl.classList.add('node-active');
                            setTimeout(() => endEl.classList.remove('node-active'), 1000);
                        }
                    }
                } catch (_) {}
            }
        });

        runner.waitForSilence = () => new Promise(resolve => {
            const check = () => {
                if (!audioStreamer || !audioStreamer.isPlaying()) resolve();
                else setTimeout(check, 100);
            };
            check();
        });

        const cleanup = () => {
            try { if (runner?.running) runner.stop(); } catch (_) {}
            try { audioStreamer.stopCapture(); audioStreamer.stopPlayback(); } catch (_) {}
            document.querySelectorAll('.drawflow-node').forEach(n => n.classList.remove('node-active'));
            overlay.remove();
        };

        stopBtn.addEventListener('click', cleanup);

        (async () => {
            try {
                await audioStreamer.startCapture();
                statusEl.textContent = 'Mic active — connecting to provider…';
                await runner.start();
                statusEl.textContent = 'Live — speak to test';
                statusEl.style.color = '#10b981';
            } catch (e) {
                statusEl.textContent = `Error: ${e.message}`;
                statusEl.style.color = '#ef4444';
                addLine(`Error: ${e.message}`, '#ef4444');
                cleanup();
            }
        })();
    }

    /**
     * Build a RealtimeWorkflowRunner-compatible graph from the current Drawflow canvas.
     */
    buildRealtimeGraph() {
        const exported = this.editor.export();
        const drawflowData = exported.drawflow?.Home?.data || {};

        const agents = {};
        let startNodeId = null;
        const edges = [];

        // First pass: find all nodes
        for (const [id, node] of Object.entries(drawflowData)) {
            if (node.data?.type === 'realtime-start') {
                startNodeId = id;
            }
        }

        // Collect edges
        for (const [id, node] of Object.entries(drawflowData)) {
            for (const [outputKey, connections] of Object.entries(node.outputs || {})) {
                for (const conn of connections.connections || []) {
                    edges.push({ from: id, to: conn.node });
                }
            }
        }

        // Resolve a stable, human-readable key per agent node (its name).
        // Falls back to a slug of the Drawflow id if name is missing/duplicated.
        const keyByNodeId = {};
        const usedKeys = new Set();
        for (const [id, node] of Object.entries(drawflowData)) {
            if (node.data?.type !== 'agent' && node.data?.type !== 'realtime-agent') continue;
            const data = node.data;
            const rawName = data.agent_name
                || this.agents.find(a => data.agent_id && String(a.id) === String(data.agent_id))?.name
                || `Agent ${id}`;
            let key = String(rawName).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
            if (!key) key = `agent_${id}`;
            let candidate = key;
            let n = 2;
            while (usedKeys.has(candidate)) {
                candidate = `${key}_${n++}`;
            }
            usedKeys.add(candidate);
            keyByNodeId[id] = candidate;
        }

        // Second pass: build agent configs
        for (const [id, node] of Object.entries(drawflowData)) {
            if ((node.data?.type === 'agent' || node.data?.type === 'realtime-agent')) {
                const data = node.data;
                const agentId = data.agent_id;
                const key = keyByNodeId[id];

                // Find which other agents this one connects to (outgoing edges)
                const handoffTargets = [];
                for (const edge of edges) {
                    if (edge.from === id) {
                        const targetNode = drawflowData[edge.to];
                        if (targetNode?.data?.type === 'agent' || targetNode?.data?.type === 'realtime-agent') {
                            const targetKey = keyByNodeId[edge.to];
                            if (targetKey) handoffTargets.push(targetKey);
                        } else if (targetNode?.data?.type === 'realtime-end') {
                            handoffTargets.push('end');
                        }
                    }
                }

                // Find this agent's full data from the agents list.
                // Match by agent_id, or by name if the node wasn't linked to a DB agent.
                const agentInfo = this.agents.find(a =>
                    (agentId && String(a.id) === String(agentId))
                    || (data.agent_name && a.name === data.agent_name)
                ) || {};

                let instructions = data.systemPrompt
                    || agentInfo.instructions
                    || agentInfo.system_prompt
                    || agentInfo.prompt
                    || '';
                // Normalize: collapse runs of whitespace within lines, strip
                // trailing whitespace on each line, collapse 3+ newlines to 2.
                // Mid-sentence line breaks (from copy-paste or manual edits)
                // confuse Grok enough to silently break the session.
                instructions = instructions
                    .split('\n')
                    .map(line => line.replace(/[ \t]+/g, ' ').trim())
                    .join('\n')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

                // Resolve user-selected tool names to full function schemas
                // from the catalog so they can be pushed in session.update.
                const selectedToolNames = data.selectedTools || [];
                const resolvedTools = [];
                const catalog = this.toolCatalog || [];
                for (const tName of selectedToolNames) {
                    const entry = catalog.find(t => t.name === tName);
                    if (!entry) continue;
                    resolvedTools.push({
                        type: 'function',
                        name: entry.name,
                        description: entry.description || '',
                        parameters: entry.input_schema || { type: 'object', properties: {} }
                    });
                }

                agents[key] = {
                    name: data.agent_name || agentInfo.name || `Agent ${id}`,
                    voice: data.voice || 'Ara',
                    instructions,
                    handoffTargets,
                    whenDone: data.whenDone || null,
                    transferDelay: data.transferDelay || 0,
                    tools: resolvedTools,
                    _nodeId: id
                };
            }
        }

        // Find start agent (first agent connected to start node).
        let startAgent = null;
        for (const edge of edges) {
            if (edge.from === startNodeId) {
                const targetKey = keyByNodeId[edge.to];
                if (targetKey && agents[targetKey]) {
                    startAgent = targetKey;
                    // Start agent has no "when done" semantics (nowhere to
                    // return to — it's the base of the stack).
                    agents[targetKey].whenDone = null;
                    break;
                }
            }
        }

        if (!startAgent) return null;

        return { agents, startAgent };
    }


    /**
     * Set up drag and drop from agents panel to canvas
     */
    setupDragAndDrop() {
        // Allow drop on canvas
        this.container.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.container.classList.add('drag-over');
        });

        this.container.addEventListener('dragleave', (e) => {
            this.container.classList.remove('drag-over');
        });

        this.container.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.container.classList.remove('drag-over');
            this.onDrop(e);
        });
    }

    /**
     * Set up document drag & drop on agent nodes
     */
    setupDocumentDragDrop() {
        // Selector for nodes that accept documents (agent nodes and start node)
        const acceptsDocsSelector = '[data-accepts-documents]';

        // Handle dragover - allow drop anywhere on nodes that accept documents
        this.container.addEventListener('dragover', (e) => {
            const targetNode = e.target.closest(acceptsDocsSelector);

            if (targetNode && this.isFileDrag(e)) {
                e.preventDefault();
                e.stopPropagation();
                targetNode.classList.add('document-drag-over');
            }
        });

        // Handle dragleave
        this.container.addEventListener('dragleave', (e) => {
            const targetNode = e.target.closest(acceptsDocsSelector);
            if (targetNode) {
                // Only remove class if we're leaving the node entirely
                const related = e.relatedTarget;
                if (!related || !targetNode.contains(related)) {
                    targetNode.classList.remove('document-drag-over');
                }
            }
        });

        // Handle drop - accept drops anywhere on the node
        this.container.addEventListener('drop', (e) => {
            const targetNode = e.target.closest(acceptsDocsSelector);

            if (targetNode && e.dataTransfer.files.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                targetNode.classList.remove('document-drag-over');
                this.handleDocumentDrop(targetNode, e.dataTransfer.files);
            }
        });

        // Handle click on document zone to open file picker
        this.container.addEventListener('click', (e) => {
            const dropHint = e.target.closest('.documents-drop-hint');
            if (dropHint) {
                e.stopPropagation();
                e.preventDefault();
                const targetNode = dropHint.closest(acceptsDocsSelector);
                if (targetNode) {
                    this.openDocumentPicker(targetNode);
                }
                return;
            }

            // Handle click on document remove button
            const removeBtn = e.target.closest('.doc-remove');
            if (removeBtn) {
                e.stopPropagation();
                e.preventDefault();
                const docItem = removeBtn.closest('.attached-doc');
                const targetNode = removeBtn.closest(acceptsDocsSelector);
                if (docItem && targetNode) {
                    this.removeDocument(targetNode, docItem.dataset.docId);
                }
                return;
            }
        });
    }

    /**
     * Check if drag event contains files
     */
    isFileDrag(e) {
        return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files');
    }

    /**
     * Handle document drop on agent node
     * Routes to appropriate storage based on schedule setting and configured local folder
     */
    async handleDocumentDrop(agentNode, files) {
        const drawflowNodeId = this.getDrawflowNodeIdFromElement(agentNode);
        if (!drawflowNodeId) {
            console.error('[WorkflowEditor] Could not find Drawflow node ID');
            return;
        }

        const nodeData = this.editor.getNodeFromId(drawflowNodeId);
        const dbNodeId = nodeData?.data?.db_node_id;

        if (!dbNodeId) {
            console.log('[WorkflowEditor] Node not saved yet, storing documents locally');
            this.showToast(this.t('workflow.fileStorage.saveFirstAttach'), 'warning');
            return;
        }

        // Determine storage mode based on schedule setting and local folder config
        if (this.scheduleEnabled) {
            // Schedule enabled: must use remote storage
            console.log('[WorkflowEditor] Schedule enabled, using remote storage');
            await this.handleDocumentUploadRemote(agentNode, files, nodeData, dbNodeId, drawflowNodeId);
            return;
        }

        // Try to bring up the local FS adapter silently. connectLocalStorage
        // reuses the app-wide synergyAI root the user already granted for
        // skills, so no prompt fires when that path is available. This
        // avoids asking "where to store?" every time the user drops a file
        // on a fresh page load — the synergyAI folder is the obvious answer.
        if (!this.localFsAdapter) {
            try {
                await this.connectLocalStorage();
            } catch (e) {
                console.warn('[WorkflowEditor] silent connectLocalStorage failed:', e);
            }
        }

        if (this.localFsAdapter) {
            console.log('[WorkflowEditor] Local folder configured, using local storage automatically');
            await this.handleDocumentUploadLocal(agentNode, files, nodeData, dbNodeId, drawflowNodeId);
        } else {
            // Truly no local folder available (no FSA support, user denied,
            // etc.). Fall back to the explicit choice dialog.
            console.log('[WorkflowEditor] No local folder available, showing storage choice dialog');
            const storageChoice = await this.showStorageChoiceDialog();
            if (storageChoice === 'local') {
                await this.handleDocumentUploadLocal(agentNode, files, nodeData, dbNodeId, drawflowNodeId);
            } else if (storageChoice === 'remote') {
                await this.handleDocumentUploadRemote(agentNode, files, nodeData, dbNodeId, drawflowNodeId);
            }
            // 'cancel' - do nothing
        }
    }

    /**
     * Show dialog for user to choose storage type
     * @returns {Promise<'local'|'remote'|'cancel'>}
     */
    async showStorageChoiceDialog() {
        // If local storage not available, default to remote
        if (!this.isLocalStorageAvailable()) {
            return 'remote';
        }

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'storage-choice-overlay';
            overlay.innerHTML = `
                <div class="storage-choice-dialog">
                    <h3>Choose Storage Location</h3>
                    <p>Where would you like to store this document?</p>
                    <div class="storage-choice-options">
                        <button class="storage-choice-btn local" data-choice="local">
                            <span class="storage-icon">💻</span>
                            <span class="storage-label">Local Filesystem</span>
                            <span class="storage-desc">File stays on your computer. Fast access, but only works when browser is open.</span>
                        </button>
                        <button class="storage-choice-btn remote" data-choice="remote">
                            <span class="storage-icon">☁️</span>
                            <span class="storage-label">Cloud Storage (S3)</span>
                            <span class="storage-desc">File uploaded to server. Works with scheduled workflows.</span>
                        </button>
                    </div>
                    <button class="storage-choice-cancel" data-choice="cancel">Cancel</button>
                </div>
            `;

            // Add styles if not already present
            if (!document.getElementById('storage-choice-styles')) {
                const style = document.createElement('style');
                style.id = 'storage-choice-styles';
                style.textContent = `
                    .storage-choice-overlay {
                        position: fixed;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0,0,0,0.5);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        z-index: 10000;
                    }
                    .storage-choice-dialog {
                        background: white;
                        border-radius: 12px;
                        padding: 24px;
                        max-width: 400px;
                        box-shadow: 0 20px 40px rgba(0,0,0,0.2);
                    }
                    .storage-choice-dialog h3 {
                        margin: 0 0 8px;
                        font-size: 18px;
                        color: #1f2937;
                    }
                    .storage-choice-dialog p {
                        margin: 0 0 16px;
                        font-size: 14px;
                        color: #6b7280;
                    }
                    .storage-choice-options {
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                    }
                    .storage-choice-btn {
                        display: flex;
                        flex-direction: column;
                        align-items: flex-start;
                        padding: 16px;
                        border: 2px solid #e5e7eb;
                        border-radius: 8px;
                        background: white;
                        cursor: pointer;
                        text-align: left;
                        transition: all 0.2s;
                    }
                    .storage-choice-btn:hover {
                        border-color: #3b82f6;
                        background: #f0f9ff;
                    }
                    .storage-icon {
                        font-size: 24px;
                        margin-bottom: 8px;
                    }
                    .storage-label {
                        font-weight: 600;
                        color: #1f2937;
                        margin-bottom: 4px;
                    }
                    .storage-desc {
                        font-size: 12px;
                        color: #6b7280;
                        line-height: 1.4;
                    }
                    .storage-choice-cancel {
                        margin-top: 16px;
                        padding: 8px 16px;
                        border: none;
                        background: transparent;
                        color: #6b7280;
                        cursor: pointer;
                        font-size: 14px;
                        width: 100%;
                    }
                    .storage-choice-cancel:hover {
                        color: #1f2937;
                    }
                `;
                document.head.appendChild(style);
            }

            overlay.addEventListener('click', (e) => {
                const choice = e.target.closest('[data-choice]')?.dataset.choice;
                if (choice) {
                    overlay.remove();
                    resolve(choice);
                }
            });

            document.body.appendChild(overlay);
        });
    }

    /**
     * Upload documents to remote storage (S3 via PHP API)
     */
    async handleDocumentUploadRemote(agentNode, files, nodeData, dbNodeId, drawflowNodeId) {
        for (const file of files) {
            if (file.size > 1024 * 1024) {
                this.showToast(this.t('workflow.fileStorage.fileSizeExceeds', { name: file.name }), 'error');
                continue;
            }

            try {
                const result = await this.uploadDocumentToNode(dbNodeId, file);
                if (result.success) {
                    if (!nodeData.data.documents) {
                        nodeData.data.documents = [];
                    }
                    result.document.storage = 'remote';
                    nodeData.data.documents.push(result.document);

                    // Force sync Drawflow's internal data
                    this.editor.updateNodeDataFromId(drawflowNodeId, nodeData.data);
                    console.log('[WorkflowEditor] Updated node data, documents:', nodeData.data.documents.length);

                    this.renderNodeDocuments(drawflowNodeId);
                    this.showToast(this.t('workflow.fileStorage.attachedCloud', { name: file.name }), 'success');
                } else {
                    this.showToast(result.error || this.t('workflow.fileStorage.uploadFailedGeneric'), 'error');
                }
            } catch (error) {
                console.error('[WorkflowEditor] Remote upload error:', error);
                this.showToast(this.t('workflow.fileStorage.uploadFailed'), 'error');
            }
        }
    }

    /**
     * Store documents locally using File System Access API
     */
    async handleDocumentUploadLocal(agentNode, files, nodeData, dbNodeId, drawflowNodeId) {
        // Ensure we have local filesystem connection
        if (!this.localFsAdapter) {
            const adapter = await this.connectLocalStorage();
            if (!adapter) {
                this.showToast(this.t('workflow.fileStorage.localStorageInaccessible'), 'warning');
                await this.handleDocumentUploadRemote(agentNode, files, nodeData, dbNodeId, drawflowNodeId);
                return;
            }
        }

        console.log('[WorkflowEditor] Local adapter type:', this.localFsAdapter.constructor.name);

        for (const file of files) {
            if (file.size > 1024 * 1024) {
                this.showToast(this.t('workflow.fileStorage.fileSizeExceeds', { name: file.name }), 'error');
                continue;
            }

            try {
                // Generate unique filename to avoid collisions
                const docId = 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                const safeFilename = `${docId}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

                // Store directly in user-selected folder (no forced subdirectories)
                const storagePath = safeFilename;

                console.log('[WorkflowEditor] Storing file locally:', storagePath);

                // Write file directly to user-selected folder
                await this.localFsAdapter.write('/' + storagePath, file);
                console.log('[WorkflowEditor] File written successfully');

                // Create document metadata (stored in node config via API)
                const document = {
                    id: docId,
                    name: file.name,
                    path: storagePath,
                    localUri: `filesystem-access:///${storagePath}`,
                    mimeType: file.type || 'application/octet-stream',
                    size: file.size,
                    storage: 'local',
                    addedAt: new Date().toISOString()
                };

                // Save metadata to backend
                const result = await this.saveDocumentMetadata(dbNodeId, document);
                if (result.success) {
                    if (!nodeData.data.documents) {
                        nodeData.data.documents = [];
                    }
                    nodeData.data.documents.push(result.document || document);

                    // Force sync Drawflow's internal data
                    this.editor.updateNodeDataFromId(drawflowNodeId, nodeData.data);
                    console.log('[WorkflowEditor] Updated node data, documents:', nodeData.data.documents.length);

                    this.renderNodeDocuments(drawflowNodeId);
                    this.showToast(this.t('workflow.fileStorage.attachedLocal', { name: file.name }), 'success');
                } else {
                    this.showToast(result.error || this.t('workflow.fileStorage.metadataSaveFailed'), 'error');
                }
            } catch (error) {
                console.error('[WorkflowEditor] Local storage error:', error);
                console.error('[WorkflowEditor] Error details:', error.message, error.stack);

                // Fallback to cloud storage
                this.showToast(this.t('workflow.fileStorage.localStorageFallbackToCloud'), 'warning');
                try {
                    const result = await this.uploadDocumentToNode(dbNodeId, file);
                    if (result.success) {
                        if (!nodeData.data.documents) {
                            nodeData.data.documents = [];
                        }
                        result.document.storage = 'remote';
                        nodeData.data.documents.push(result.document);

                        // Force sync Drawflow's internal data
                        this.editor.updateNodeDataFromId(drawflowNodeId, nodeData.data);

                        this.renderNodeDocuments(drawflowNodeId);
                        this.showToast(this.t('workflow.fileStorage.attachedCloud', { name: file.name }), 'success');
                    } else {
                        this.showToast(result.error || this.t('workflow.fileStorage.uploadFailedGeneric'), 'error');
                    }
                } catch (uploadError) {
                    console.error('[WorkflowEditor] Cloud fallback also failed:', uploadError);
                    this.showToast(this.t('workflow.fileStorage.storeFailed'), 'error');
                }
            }
        }
    }

    /**
     * Save document metadata to backend (for locally stored files)
     */
    async saveDocumentMetadata(nodeId, document) {
        const response = await fetch(
            `${this.apiBase}/workflows/${this.currentWorkflowId}/nodes/${nodeId}/documents/metadata`,
            {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ document })
            }
        );
        return response.json();
    }

    /**
     * Upload document to node via PHP API (remote storage)
     */
    async uploadDocumentToNode(nodeId, file) {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(
            `${this.apiBase}/workflows/${this.currentWorkflowId}/nodes/${nodeId}/documents`,
            {
                method: 'POST',
                body: formData,
                headers: this.getAuthHeaders(false) // Don't set Content-Type for FormData
            }
        );

        return response.json();
    }

    /**
     * Open file picker for document attachment
     */
    openDocumentPicker(agentNode) {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.txt,.md,.pdf,.json,.csv,.xml,.html,.js,.py,.php,.png,.jpg,.jpeg,.gif,.webp';
        input.onchange = (e) => {
            if (e.target.files.length > 0) {
                this.handleDocumentDrop(agentNode, e.target.files);
            }
        };
        input.click();
    }

    /**
     * Remove document from node
     */
    async removeDocument(agentNode, docId) {
        const drawflowNodeId = this.getDrawflowNodeIdFromElement(agentNode);
        if (!drawflowNodeId) return;

        const nodeData = this.editor.getNodeFromId(drawflowNodeId);
        const dbNodeId = nodeData?.data?.db_node_id;

        // Find the document to check if it's locally stored
        const documents = nodeData?.data?.documents || [];
        const docToRemove = documents.find(d => d.id === docId);

        if (!dbNodeId) {
            // Just remove from local data
            nodeData.data.documents = documents.filter(d => d.id !== docId);
            this.renderNodeDocuments(drawflowNodeId);
            return;
        }

        try {
            // If document is stored locally, try to delete the file via UniversalFS
            if (docToRemove && docToRemove.storage === 'local') {
                console.log('[WorkflowEditor] Attempting to delete local file:', docToRemove.path);

                // Try to restore local adapter if not available
                if (!this.localFsAdapter && this.currentWorkflowId) {
                    console.log('[WorkflowEditor] Local adapter not available, trying to restore...');
                    await this.restoreLocalFolderForWorkflow(this.currentWorkflowId);
                }

                // Don't prompt for a folder just to delete a file — the
                // user clicked × on a chip, not "manage storage." If the
                // local adapter can't be brought up silently, skip the
                // disk delete and proceed with the metadata removal so
                // the chip disappears. An orphan file on disk is harmless.
                if (this.localFsAdapter) {
                    try {
                        const deletePath = '/' + docToRemove.path;
                        console.log('[WorkflowEditor] Calling UniversalFS delete with path:', deletePath);
                        await this.localFsAdapter.delete(deletePath);
                        console.log('[WorkflowEditor] Successfully deleted local file via UniversalFS:', docToRemove.path);
                        this.showToast(this.t('workflow.notifications.fileDeletedLocal'), 'success');
                    } catch (localErr) {
                        // File may already be deleted or inaccessible
                        console.warn('[WorkflowEditor] Could not delete local file via UniversalFS:', localErr.message, localErr);
                        this.showToast(this.t('workflow.notifications.cannotDeleteLocalFile', { error: localErr.message }), 'warning');
                    }
                } else {
                    console.warn('[WorkflowEditor] Cannot delete local file - no local adapter available. File may need manual deletion.');
                    this.showToast(this.t('workflow.notifications.fileNotDeletedManual'), 'warning');
                }
            }

            // Call backend to remove metadata
            const response = await fetch(
                `${this.apiBase}/workflows/${this.currentWorkflowId}/nodes/${dbNodeId}/documents/${docId}`,
                {
                    method: 'DELETE',
                    headers: this.getAuthHeaders()
                }
            );

            // 404 = the doc/node isn't on the backend anymore (commonly
            // because each save re-INSERTs nodes with new ids and the
            // chip's reference is now stale). That's the same end state
            // we want, so treat it as success and remove locally.
            const result = response.status === 404
                ? { success: true, alreadyGone: true }
                : await response.json();
            if (result.success) {
                nodeData.data.documents = documents.filter(d => d.id !== docId);
                this.editor.updateNodeDataFromId(drawflowNodeId, nodeData.data);
                this.renderNodeDocuments(drawflowNodeId);
                this.showToast(this.t('workflow.notifications.documentRemoved'), 'success');
            } else {
                this.showToast(result.error || 'Failed to remove document', 'error');
            }
        } catch (error) {
            console.error('[WorkflowEditor] Remove document error:', error);
            this.showToast(this.t('workflow.notifications.documentRemoveFailed'), 'error');
        }
    }

    /**
     * Render documents list in node
     */
    renderNodeDocuments(drawflowNodeId) {
        console.log('[WorkflowEditor] renderNodeDocuments called for drawflowNodeId:', drawflowNodeId);

        const node = this.editor.getNodeFromId(drawflowNodeId);
        if (!node) {
            console.warn('[WorkflowEditor] renderNodeDocuments: Node not found in editor');
            return;
        }

        const documents = node.data?.documents || [];
        console.log('[WorkflowEditor] renderNodeDocuments: documents count:', documents.length);

        const nodeElement = this.container.querySelector(`#node-${drawflowNodeId}`);
        if (!nodeElement) {
            console.warn('[WorkflowEditor] renderNodeDocuments: Node element not found in DOM');
            return;
        }

        const listContainer = nodeElement.querySelector('.documents-list');
        const dropHint = nodeElement.querySelector('.documents-drop-hint');

        console.log('[WorkflowEditor] renderNodeDocuments: listContainer found:', !!listContainer, 'dropHint found:', !!dropHint);

        if (!listContainer) {
            console.warn('[WorkflowEditor] renderNodeDocuments: .documents-list not found in node');
            return;
        }

        if (documents.length === 0) {
            listContainer.innerHTML = '';
            if (dropHint) dropHint.style.display = 'block';
            return;
        }

        if (dropHint) dropHint.style.display = 'none';

        const html = documents.map(doc => {
            const storageIcon = doc.storage === 'local' ? '💻' : '☁️';
            const storageTitle = doc.storage === 'local' ? 'Stored locally' : 'Stored in cloud';
            return `
                <div class="attached-doc ${doc.storage === 'local' ? 'local-storage' : 'remote-storage'}" data-doc-id="${this.escapeHtml(doc.id)}">
                    <span class="doc-storage-icon" title="${storageTitle}">${storageIcon}</span>
                    <span class="doc-icon">${this.getDocIcon(doc.mimeType)}</span>
                    <span class="doc-name" title="${this.escapeHtml(doc.name)}">${this.truncateFilename(doc.name, 10)}</span>
                    <button class="doc-remove" title="Remove document">×</button>
                </div>
            `;
        }).join('');

        console.log('[WorkflowEditor] renderNodeDocuments: Setting innerHTML:', html.substring(0, 100) + '...');
        listContainer.innerHTML = html;
    }

    /**
     * Get icon for document type
     */
    getDocIcon(mimeType) {
        if (!mimeType) return '📄';
        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType === 'application/pdf') return '📕';
        if (mimeType.includes('json')) return '📋';
        if (mimeType.includes('csv') || mimeType.includes('excel')) return '📊';
        return '📄';
    }

    /**
     * Truncate filename for display
     */
    truncateFilename(name, maxLen) {
        if (!name || name.length <= maxLen) return name;
        const ext = name.split('.').pop();
        const baseName = name.substring(0, name.length - ext.length - 1);
        const truncatedBase = baseName.substring(0, maxLen - ext.length - 3);
        return `${truncatedBase}...${ext}`;
    }

    /**
     * Get Drawflow node ID from DOM element
     */
    getDrawflowNodeIdFromElement(element) {
        const nodeContainer = element.closest('.drawflow-node');
        if (nodeContainer) {
            const match = nodeContainer.id.match(/node-(\d+)/);
            if (match) return parseInt(match[1]);
        }
        return null;
    }

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        // Check if there's an existing toast system
        if (window.showToast) {
            window.showToast(message, type);
            return;
        }

        // Simple fallback toast - centered for better UX (locus of attention principle)
        const toast = document.createElement('div');
        toast.className = `workflow-toast ${type}`;
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            padding: 12px 24px;
            border-radius: 8px;
            color: white;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            animation: toastSlideUp 0.3s ease;
            background: ${type === 'error' ? '#dc2626' : type === 'warning' ? '#d97706' : type === 'success' ? '#16a34a' : '#3b82f6'};
        `;

        // Add animation keyframes if not present
        if (!document.getElementById('toast-animations')) {
            const style = document.createElement('style');
            style.id = 'toast-animations';
            style.textContent = `
                @keyframes toastSlideUp {
                    from { opacity: 0; transform: translateX(-50%) translateY(20px); }
                    to { opacity: 1; transform: translateX(-50%) translateY(0); }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    /**
     * Handle drag start
     */
    onDragStart(e, card) {
        e.dataTransfer.setData('node-type', card.dataset.nodeType);
        e.dataTransfer.setData('agent-id', card.dataset.agentId || '');
        e.dataTransfer.setData('agent-name', card.dataset.agentName || '');
        e.dataTransfer.setData('agent-type', card.dataset.agentType || '');
        e.dataTransfer.setData('agent-provider', card.dataset.agentProvider || '');
        e.dataTransfer.setData('template-id', card.dataset.templateId || '');
        card.classList.add('dragging');
    }

    /**
     * Handle drag end
     */
    onDragEnd(e, card) {
        card.classList.remove('dragging');
    }

    /**
     * Handle drop on canvas
     */
    onDrop(e) {
        const nodeType = e.dataTransfer.getData('node-type');
        console.log('[WorkflowEditor] onDrop fired, nodeType:', nodeType);
        const agentId = e.dataTransfer.getData('agent-id');
        const agentName = e.dataTransfer.getData('agent-name');
        const agentType = e.dataTransfer.getData('agent-type');
        let agentProvider = e.dataTransfer.getData('agent-provider');
        let agentTools = null;

        // Look up agent data from agents list to get provider and tools
        if (agentId) {
            const agentData = this.agents.find(a => String(a.id) === String(agentId));
            if (agentData) {
                if (!agentProvider) {
                    agentProvider = agentData.provider || agentData.llm_provider || '';
                }
                // Get tools from agent data
                agentTools = agentData.tools || [];
            }
        }

        // Calculate position for Drawflow node
        const precanvasBounds = this.editor.precanvas.getBoundingClientRect();
        const zoom = this.editor.zoom || 1;

        // Calculate position relative to precanvas, accounting for zoom
        // Offset by half the typical node size to center the node on cursor
        const nodeWidth = 80;  // Half of ~160px node width
        const nodeHeight = 30; // Half of ~60px node height

        const x = ((e.clientX - precanvasBounds.left) / zoom) - nodeWidth;
        const y = ((e.clientY - precanvasBounds.top) / zoom) - nodeHeight;

        // Create appropriate node
        switch (nodeType) {
            case 'start':
                this.addStartNode(x, y);
                break;
            case 'output':
                this.addOutputNode(x, y);
                break;
            case 'agent':
                this.addAgentNode(x, y, agentId, agentName, agentType, agentProvider, agentTools);
                break;
            case 'agent-template':
                // Create an empty agent node that will be configured
                this.addAgentTemplateNode(x, y);
                break;
            case 'loader':
            case 'splitter':
            case 'vectorstore':
                this.addIngestionNode(x, y, nodeType);
                break;
            case 'realtime-start':
                this.addRealtimeStartNode(x, y);
                break;
            case 'realtime-agent':
                this.addRealtimeAgentNode(x, y);
                break;
            case 'realtime-end':
                this.addRealtimeEndNode(x, y);
                break;
        }
    }

    /**
     * Add an agent template node to the canvas
     */
    addAgentTemplateNode(x, y) {
        const html = `
            <div class="workflow-node agent-node template configurable">
                <div class="node-header" style="background: #fef3c7;">
                    <span class="node-icon">🤖</span>
                    <span class="node-title">${this.t('agentTeams.newTemplate')}</span>
                    <span class="node-config-hint" title="Click to configure">⚙</span>
                    <button class="node-delete-btn" title="Delete node">×</button>
                </div>
                <div class="node-body">
                    <small class="node-config-display">${this.t('agentTeams.templateDesc')}</small>
                </div>
            </div>
        `;

        const nodeId = this.editor.addNode(
            'agent-template',
            1, // inputs
            1, // outputs
            x, y,
            'agent-template',
            { type: 'agent-template', isTemplate: true },
            html
        );

        this.hideHelpOverlay();
    }

    /**
     * Add an Ingestion component node (loader / splitter / vectorstore).
     * Each is a 1-input / 1-output node with a config object and a
     * one-line summary, mirroring the agent-template node so that
     * connections, the ⚙ config hint, and saving all work.
     */
    addIngestionNode(x, y, nodeType, config = null) {
        const INGESTION_DEFAULTS = {
            loader:      { types: [], path: '' },
            splitter:    { strategy: 'recursive', chunk_size: 1000, overlap: 150 },
            vectorstore: { store: '', provider: 'qdrant', connection: {}, embedding: '', collection: '' },
        };
        const META = {
            loader:      { icon: '📥', name: 'Loader' },
            splitter:    { icon: '✂️', name: 'Splitter' },
            vectorstore: { icon: '🗄️', name: 'Vector store' },
        };
        const meta = META[nodeType];
        if (!meta) return;

        // Copy defaults so each node owns its own config object. When a saved
        // config is supplied (re-hydration from backend DSL), merge it over the
        // type defaults so any missing keys still have a sensible value.
        const defaults = JSON.parse(JSON.stringify(INGESTION_DEFAULTS[nodeType]));
        const nodeConfig = config
            ? { ...defaults, ...config }
            : defaults;
        const summary = this.ingestionNodeSummary(nodeType, nodeConfig);

        const html = `
            <div class="workflow-node ingestion-node configurable ${nodeConfig.disabled ? 'node-disabled' : ''}" data-ingestion-type="${nodeType}">
                <div class="node-header">
                    <span class="node-icon">${meta.icon}</span>
                    <span class="node-title">${this.escapeHtml(meta.name)}</span>
                    <button class="node-delete-btn" title="Delete node">×</button>
                </div>
                <div class="node-body">
                    <small class="node-config-display">${this.escapeHtml(summary)}</small>
                    <button class="node-edit-btn" data-ingestion="true" title="Edit">✏️</button>
                </div>
            </div>
        `;

        const drawflowId = this.editor.addNode(
            nodeType,
            1, // inputs
            1, // outputs
            x, y,
            'ingestion',
            {
                type: 'ingestion',
                node_type: nodeType,
                name: meta.name,
                config: nodeConfig
            },
            html
        );

        this.hideHelpOverlay();

        // The Output node is usually already on the canvas; dragging an
        // ingestion node must immediately flip it to the ingestion variant.
        this.refreshOutputNodeVariant();
        this.refreshStartNodeVariant();

        return drawflowId;
    }

    /**
     * Build the one-line summary shown on an ingestion node's body.
     */
    ingestionNodeSummary(nodeType, config) {
        switch (nodeType) {
            case 'loader':
                return config.source || 'pdf';
            case 'splitter':
                return `${config.strategy || 'recursive'} ${config.chunk_size}/${config.overlap}`;
            case 'vectorstore':
                return config.store || 'pgvector';
            default:
                return '';
        }
    }

    /**
     * Wire the loader's single "Browse…" button to the native OS file picker
     * (File System Access API). The pick MUST live inside the user's mounted
     * workspace root; we store the path RELATIVE to it via root.resolve(). The
     * selection's kind (file vs folder) comes straight from handle.kind; for a
     * path that's typed in, _pathIsFile() decides via its extension. The right
     * column shows the file path or, for a folder, its contents.
     */
    _wireLoaderPathPicker() {
        document.getElementById('ingestion-browse')
            ?.addEventListener('click', () => this._pickLoaderPath());
        const input = document.getElementById('ingestion-loader-path');
        input?.addEventListener('input', () => this._refreshLoaderSelection());
        // Reflect a saved value when the modal re-opens.
        if (input && input.value.trim()) this._refreshLoaderSelection();
    }

    /** Right-column placeholder shown until something is selected. */
    _loaderHelpHtml() {
        return `
            <div class="ingestion-folder-help">
                <p class="muted">Nothing selected yet.</p>
                <p class="muted">Click “Browse storage…” to pick a folder or a file, or type a path on the left.</p>
            </div>`;
    }

    /**
     * Algorithm to tell a file from a folder when we only have a path string:
     * a final segment carrying a file extension is a file, otherwise a folder.
     */
    _pathIsFile(path) {
        return /\.[A-Za-z0-9]{1,8}$/.test(String(path).trim().replace(/[\/\\]+$/, ''));
    }

    /**
     * Browse the storage provider THROUGH UniversalFS (`list_files`) and pick a
     * folder OR a file. We only need the PATH — UniversalFS does the actual
     * reading — so this never touches the browser's local file system (which
     * can't supply absolute provider paths anyway).
     */
    async _pickLoaderPath() {
        const input = document.getElementById('ingestion-loader-path');
        // Resume browsing from the current value if it's a folder, else root.
        const start = (input && input.dataset.isDir === '1' && input.value.trim()) ? input.value.trim() : null;
        await this._browseLoaderStorage(start);
    }

    /** Fetch + render one folder level of the storage provider. */
    async _browseLoaderStorage(path = null) {
        const box = document.getElementById('ingestion-folder-list');
        const title = document.getElementById('ingestion-sel-title');
        if (!box) return;
        if (!window.mcpClient || typeof window.mcpClient.callTool !== 'function') {
            box.innerHTML = `<div class="ingestion-folder-help"><p class="muted">Storage browser unavailable — type a path on the left instead.</p></div>`;
            return;
        }
        const providerEl = document.querySelector('input[name="ingestion-loader-provider"]:checked');
        const provider = providerEl ? providerEl.value : 'local';
        if (title) title.textContent = 'Browse storage';
        box.innerHTML = `<div class="ingestion-folder-help"><p class="muted">Loading…</p></div>`;
        let parsed, mcpError = '';
        try {
            const args = { provider };
            if (path) args.path = path;
            const res = await window.mcpClient.callTool('list_files', args);
            mcpError = this._extractMcpError(res);
            parsed = this._parseListFiles(res);
        } catch (e) {
            box.innerHTML = `<div class="ingestion-folder-help"><p class="muted">Could not list files: ${this.escapeHtml(e?.message || String(e))}</p></div>`;
            return;
        }
        this._loaderBrowsePath = (parsed.folder_id !== '' ? parsed.folder_id : (path || ''));
        // Keep the Source field in sync with the folder we're viewing, so the
        // current folder is ALREADY the selected source even if the user never
        // clicks "Use this folder" (clicking a file overrides with that file).
        const pathInput = document.getElementById('ingestion-loader-path');
        if (pathInput && this._loaderBrowsePath) {
            pathInput.value = this._loaderBrowsePath;
            pathInput.dataset.isDir = '1';
        }
        // A non-empty folder we can't read returns an MCP error, not zero files —
        // surface it (with a permissions hint) instead of a misleading "(empty)".
        if (parsed.items.length === 0 && mcpError) {
            this._renderStorageBrowserError(provider, mcpError);
            return;
        }
        this._renderStorageBrowser(parsed, provider);
    }

    /**
     * Defensively parse a list_files result into { folder_id, items:[{id,name,
     * type}] }. Handles the callTool wrapper, the MCP content[0].text JSON
     * framing and structuredContent. Returns empties on failure.
     */
    _parseListFiles(res) {
        try {
            const result = (res && res.result !== undefined) ? res.result : res;
            let obj = null;
            if (result && Array.isArray(result.files)) obj = result;
            else if (result && Array.isArray(result.content)) {
                for (const part of result.content) {
                    if (part && typeof part.text === 'string') {
                        try { const o = JSON.parse(part.text); if (o && Array.isArray(o.files)) { obj = o; break; } } catch (_) { /* not JSON */ }
                    }
                }
            } else if (result && result.structuredContent && Array.isArray(result.structuredContent.files)) {
                obj = result.structuredContent;
            }
            if (!obj) return { folder_id: '', items: [] };
            const items = obj.files
                .map(f => ({ id: f.id, name: f.name || f.id, type: f.type }))
                .filter(x => x.id);
            return { folder_id: obj.folder_id || '', items };
        } catch (e) {
            console.warn('[ingestion/loader] parse list_files failed:', e);
            return { folder_id: '', items: [] };
        }
    }

    /** Dig an error message out of an MCP/callTool result, or '' if none. */
    _extractMcpError(res) {
        try {
            if (!res || typeof res === 'string') return '';
            if (res.error) return (typeof res.error === 'string') ? res.error : (res.error.message || '');
            if (res.success === false && typeof res.message === 'string') return res.message;
            const result = (res.result !== undefined) ? res.result : res;
            if (result) {
                if (result.error) return (typeof result.error === 'string') ? result.error : (result.error.message || '');
                if (result.isError && Array.isArray(result.content)) {
                    const t = result.content.map(c => c && c.text).filter(Boolean).join(' ');
                    if (t) return t;
                }
            }
        } catch (_) { /* ignore */ }
        return '';
    }

    /** Render a browse-level error (e.g. permission denied) with a hint + Up. */
    _renderStorageBrowserError(provider, msg) {
        const box = document.getElementById('ingestion-folder-list');
        if (!box) return;
        const cur = (this._loaderBrowsePath || '').replace(/\/+$/, '');
        const parent = cur ? cur.split('/').slice(0, -1).join('/') : '';
        const denied = /not permitted|failed to open directory|permission/i.test(msg);
        const body = denied
            ? `⚠️ Can’t read this folder. The web server (Apache/UniversalFS) isn’t allowed to access it — on macOS, <strong>Documents</strong>, <strong>Desktop</strong> and <strong>Downloads</strong> need <strong>Full Disk Access</strong> granted to Apache (System Settings → Privacy &amp; Security → Full Disk Access), then restart Apache. Or point the loader at a readable location.`
            : `⚠️ ${this.escapeHtml(msg)}`;
        box.innerHTML = `
            <div class="ingestion-browse-bar">
                <button type="button" class="ingestion-browse-up" data-path="${this.escapeHtml(parent)}" ${cur === '' ? 'disabled' : ''}>⬆ Up</button>
            </div>
            <p class="muted ingestion-browse-cur">${this.escapeHtml(provider)} : /${this.escapeHtml(cur)}</p>
            <div class="ingestion-folder-help"><p class="muted">${body}</p></div>`;
        const up = box.querySelector('.ingestion-browse-up');
        if (up && !up.disabled) up.addEventListener('click', () => this._browseLoaderStorage(up.dataset.path || null));
    }

    /** Render the storage browser (Up · Use-this-folder · folders · files). */
    _renderStorageBrowser(parsed, provider) {
        const box = document.getElementById('ingestion-folder-list');
        if (!box) return;
        const cur = (this._loaderBrowsePath || '').replace(/\/+$/, '');
        const parent = cur ? cur.split('/').slice(0, -1).join('/') : '';
        const folders = parsed.items.filter(i => i.type === 'folder').sort((a, b) => a.name.localeCompare(b.name));
        const files = parsed.items.filter(i => i.type !== 'folder').sort((a, b) => a.name.localeCompare(b.name));

        const list = [];
        for (const d of folders) list.push(`<li class="ingestion-browse-folder" data-path="${this.escapeHtml(d.id)}">📁 ${this.escapeHtml(d.name)}</li>`);
        for (const f of files) list.push(`<li class="ingestion-browse-file" data-path="${this.escapeHtml(f.id)}">📄 ${this.escapeHtml(f.name)}</li>`);

        box.innerHTML = `
            <div class="ingestion-browse-bar">
                <button type="button" class="ingestion-browse-up" data-path="${this.escapeHtml(parent)}" ${cur === '' ? 'disabled' : ''}>⬆ Up</button>
                <button type="button" class="ingestion-browse-usefolder" data-path="${this.escapeHtml(cur)}">✓ Use this folder</button>
            </div>
            <p class="muted ingestion-browse-cur">${this.escapeHtml(provider)} : /${this.escapeHtml(cur)}</p>
            <ul class="ingestion-folder-files">${list.join('') || '<li class="muted">(empty)</li>'}</ul>`;

        box.querySelectorAll('.ingestion-browse-folder').forEach(el =>
            el.addEventListener('click', () => this._browseLoaderStorage(el.dataset.path)));
        box.querySelectorAll('.ingestion-browse-file').forEach(el =>
            el.addEventListener('click', () => this._selectLoaderPath(el.dataset.path, false)));
        const up = box.querySelector('.ingestion-browse-up');
        if (up && !up.disabled) up.addEventListener('click', () => this._browseLoaderStorage(up.dataset.path || null));
        const useF = box.querySelector('.ingestion-browse-usefolder');
        if (useF) useF.addEventListener('click', () => this._selectLoaderPath(useF.dataset.path, true));
    }

    /** Commit a browsed path (folder or file) into the loader's Source field. */
    _selectLoaderPath(path, isDir) {
        const input = document.getElementById('ingestion-loader-path');
        if (!input) return;
        input.value = path || '';
        input.dataset.isDir = isDir ? '1' : '';
        this.showToast?.(isDir ? `Folder selected: /${path}` : `File selected: /${path}`, 'success');
        this._refreshLoaderSelection();
    }

    /**
     * Recompute the selection's kind and update the right-column display:
     * a file shows its path; a folder shows its contents.
     */
    async _refreshLoaderSelection(dirHandle = null) {
        const input = document.getElementById('ingestion-loader-path');
        const box = document.getElementById('ingestion-folder-list');
        const title = document.getElementById('ingestion-sel-title');
        if (!input || !box) return;

        const path = input.value.trim();
        if (!path) {
            input.dataset.isDir = '';
            if (title) title.textContent = 'Selection';
            box.innerHTML = this._loaderHelpHtml();
            return;
        }

        // handle.kind wins; otherwise fall back to the path-extension algorithm.
        const isDir = (input.dataset.isDir === '1') || !this._pathIsFile(path);
        input.dataset.isDir = isDir ? '1' : '';

        if (isDir) {
            if (title) title.textContent = 'Folder contents';
            const dh = dirHandle || await this._resolveDir(path);
            if (dh) {
                this._renderFolderListing(dh);
            } else {
                box.innerHTML = `<div class="ingestion-folder-help">`
                    + `<p>📁 Folder: <code class="ingestion-path-code">${this.escapeHtml(path)}</code></p>`
                    + `<p class="muted">Its contents are read when the pipeline runs.</p></div>`;
            }
        } else {
            if (title) title.textContent = 'Selected file';
            // The type is detected from the extension; the File-types checkboxes
            // filter which formats are processed. Flag when the picked file's
            // type isn't among the checked formats so it's clear it'll be skipped.
            const ext = (path.split('.').pop() || '').toLowerCase();
            const map = { pdf: 'pdf', docx: 'word', doc: 'word', txt: 'text', csv: 'csv', html: 'html', htm: 'html' };
            const detected = map[ext] || null;
            const checked = Array.from(document.querySelectorAll('.ingestion-loader-type:checked')).map(c => c.value);
            const allowed = checked.length === 0 || (detected && checked.includes(detected));
            let note = '';
            if (!detected) note = `<p class="muted">⚠️ Unsupported type (.${this.escapeHtml(ext)}) — it will be skipped.</p>`;
            else if (!allowed) note = `<p class="muted">⚠️ ${detected} isn't in the checked File types — it will be skipped.</p>`;
            box.innerHTML = `<div class="ingestion-folder-help">`
                + `<p>📄 File:</p>`
                + `<p><code class="ingestion-path-code">${this.escapeHtml(path)}</code></p>${note}</div>`;
        }
    }

    /** Render the entries of a directory handle into the right-column panel. */
    async _renderFolderListing(dirHandle) {
        const box = document.getElementById('ingestion-folder-list');
        if (!box) return;
        box.innerHTML = '<div class="ingestion-folder-help"><p class="muted">Reading folder…</p></div>';
        const items = [];
        try {
            for await (const [name, handle] of dirHandle.entries()) {
                items.push({ name, kind: handle.kind });
            }
        } catch (e) {
            box.innerHTML = `<div class="ingestion-folder-help"><p class="muted">Could not read folder: ${this.escapeHtml(e?.message || String(e))}</p></div>`;
            return;
        }
        if (!items.length) {
            box.innerHTML = '<div class="ingestion-folder-help"><p class="muted">This folder is empty.</p></div>';
            return;
        }
        items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : (a.kind === 'directory' ? -1 : 1)));
        box.innerHTML = '<ul class="ingestion-folder-files">'
            + items.map(it => `<li>${it.kind === 'directory' ? '📁' : '📄'} ${this.escapeHtml(it.name)}</li>`).join('')
            + '</ul>';
    }

    /** Resolve a folder path under the workspace root, or null. */
    async _resolveDir(relPath) {
        try {
            const fs = window.localFs;
            if (!fs || !fs.isSupported()) return null;
            return await fs.resolvePath(relPath, { kind: 'directory' });
        } catch (_) { return null; }
    }

    /**
     * Append the user's registered MCP servers to the Vector store node's
     * "Vector DB" dropdown. Sourced the same way the agent node forms get their
     * tools — GET /mcp/servers (returns enabled servers, `{servers:[...]}`).
     * Each option's value is "mcp:<id>" (the convention VectorMcpStore reads).
     * @param {string} selected the currently-saved store value
     */
    /**
     * Heuristic: is this MCP server a file-storage / UniversalFS server?
     * Mirrors the vector-MCP filtering convention but matches on storage-ish
     * keywords in the server name/description/url. Defensive against bad shapes.
     */
    _isFileStorageMcpServer(server) {
        if (!server) return false;
        const hay = `${server.name || ''} ${server.description || ''} ${server.url || ''}`.toLowerCase();
        return /\b(file|storage|universalfs|filesystem|drive|onedrive|s3|gdrive|langfs|blob)\b/.test(hay)
            || /universalfs|filesystem|onedrive|gdrive|langfs/.test(hay);
    }

    /**
     * The full UniversalFS provider set. `local` needs no key; the rest need a
     * UniversalFS `ufs_…` key unless list_providers reports them as available.
     */
    get _ufsKnownProviders() { return ['local', 'gdrive', 's3', 'onedrive']; }

    /**
     * Wire the loader's "File storage" picker + "Provider" radios + conditional
     * UniversalFS key box. SCOPE: provider-selection UI only — no file reading.
     *
     * Everything degrades gracefully: missing mcpClient, no file-storage servers,
     * or a failing list_providers must never throw. Radios render SYNCHRONOUSLY
     * from the known set; the async list_providers call only refines which
     * providers are marked "(needs key)".
     */
    _wireLoaderStorageAndProvider(config = {}) {
        const storageHost = document.getElementById('ingestion-loader-storage-host');
        const providerHost = document.getElementById('ingestion-loader-provider-host');
        const keyWrap = document.getElementById('ingestion-loader-ufskey-wrap');
        if (!storageHost || !providerHost) return;

        // --- 1. Discover registered file-storage MCP servers (sync, from the
        //        already-loaded mcpClient.servers map; refresh async best-effort). ---
        const collectServers = () => {
            const out = [];
            try {
                const map = window.mcpClient && window.mcpClient.servers;
                if (map && typeof map.forEach === 'function') {
                    map.forEach(s => { if (this._isFileStorageMcpServer(s)) out.push(s); });
                }
            } catch (e) { console.warn('[ingestion/loader] server collect failed:', e); }
            return out;
        };

        const savedId = config.storage_mcp_id != null ? String(config.storage_mcp_id) : '';
        let chosen = null; // {id, url, name}

        // We use ONLY the langfs (LangChain loaders) MCP — no UniversalFS, no
        // user-facing storage picker. Auto-resolve the langfs server and stash
        // its id in a hidden input so the backend can scope dispatch to it.
        const resolveStorage = () => {
            const servers = collectServers();
            // Prefer the saved server, then anything that looks like langfs, then
            // the first available file-storage server.
            const pick = servers.find(s => savedId && String(s.id) === savedId)
                || servers.find(s => /langfs/i.test(`${s.name || ''} ${s.url || ''}`))
                || servers[0] || null;
            chosen = pick
                ? { id: String(pick.id), url: pick.url || '', name: pick.name || `server ${pick.id}` }
                : null;
            storageHost.innerHTML = `<input type="hidden" id="ingestion-loader-storage"`
                + ` value="${chosen ? this.escapeHtml(chosen.id) : ''}"`
                + (chosen ? ` data-url="${this.escapeHtml(chosen.url)}" data-name="${this.escapeHtml(chosen.name)}"` : '')
                + `>`;
        };

        // --- 2. Provider radios — the LIST comes from langfs `list_providers`
        //        (the default package). Each entry carries `available`: true = the
        //        loader is implemented and selectable; false = not yet implemented
        //        → rendered greyed/inactive ("coming soon"). Until the list loads,
        //        show just `local`. ---
        const savedProvider = config.provider || 'local';
        // Provider list, refined async from list_providers. Each: {name, available}.
        let providers = [{ name: 'local', available: true }];

        const toggleKeyBox = () => {
            const checked = providerHost.querySelector('input[name="ingestion-loader-provider"]:checked');
            const prov = checked ? checked.value : 'local';
            if (keyWrap) keyWrap.style.display = (prov && prov !== 'local') ? '' : 'none';
        };

        const renderProviders = () => {
            // Lay the providers out in a 2-column grid filling the allocated space.
            providerHost.style.display = 'grid';
            providerHost.style.gridTemplateColumns = '1fr 1fr';
            providerHost.style.columnGap = '16px';
            providerHost.style.rowGap = '8px';
            providerHost.innerHTML = providers.map(p => {
                const disabled = !p.available;          // not-yet-implemented → greyed/inactive
                const checked = (p.name === savedProvider && !disabled) ? 'checked' : '';
                const suffix = disabled ? ' (coming soon)' : '';
                const style = `display:flex;align-items:center;gap:6px;`
                    + (disabled ? 'opacity:.5;cursor:not-allowed;' : '');
                return `<label class="ingestion-loader-provider-radio${disabled ? ' disabled' : ''}" style="${style}">`
                    + `<input type="radio" name="ingestion-loader-provider" value="${this.escapeHtml(p.name)}" ${checked} ${disabled ? 'disabled' : ''}>`
                    + `<span data-prov="${this.escapeHtml(p.name)}">${this.escapeHtml(p.name)}${suffix}</span></label>`;
            }).join('');
            // Guarantee an enabled radio is checked (fall back to the first enabled).
            if (!providerHost.querySelector('input[name="ingestion-loader-provider"]:checked')) {
                const firstEnabled = providerHost.querySelector('input[name="ingestion-loader-provider"]:not([disabled])');
                if (firstEnabled) firstEnabled.checked = true;
            }
            providerHost.querySelectorAll('input[name="ingestion-loader-provider"]').forEach(r => {
                r.addEventListener('change', toggleKeyBox);
            });
            toggleKeyBox();
        };

        // --- 3. Async, NON-blocking list_providers refresh, SCOPED to the chosen
        //        storage server (langfs) via the MCP proxy — so it can't be
        //        answered by a different registered server, and doesn't depend on
        //        the global tool-map being fresh. ---
        const refreshAvailability = async () => {
            const rpc = await this._mcpProxyToolCall(chosen, 'list_providers', {});
            if (!rpc) return;             // no chosen server / call failed — keep defaults
            const parsed = this._parseListProviders(rpc);
            if (parsed && parsed.length) {
                providers = parsed;       // the langfs default package (all 10, with `available`)
                renderProviders();
            }
        };

        // Resolve the langfs server synchronously, then kick the async refresh.
        resolveStorage();
        renderProviders();
        // Refresh from the live server list too (map may load late), then query.
        try {
            if (window.mcpClient && typeof window.mcpClient.loadServers === 'function') {
                window.mcpClient.loadServers()
                    .then(() => { resolveStorage(); refreshAvailability(); })
                    .catch(e => console.warn('[ingestion/loader] loadServers failed:', e));
            }
        } catch (e) { console.warn('[ingestion/loader] loadServers threw:', e); }
        refreshAvailability();
    }

    /**
     * Call ONE tool on a specific MCP server via the backend /mcp/proxy gateway,
     * scoped by server_url + server_id so a different registered server can't
     * answer. Returns the JSON-RPC result object (data.response || data), or null
     * on any failure — callers must tolerate null and never throw.
     */
    async _mcpProxyToolCall(chosen, toolName, args = {}) {
        try {
            if (!chosen || !chosen.url || !window.mcpClient
                || typeof window.mcpClient.request !== 'function') return null;
            const data = await window.mcpClient.request('/mcp/proxy', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'proxy',
                    server_url: chosen.url,
                    server_id: chosen.id,
                    user_id: (typeof window.mcpClient.getUserId === 'function')
                        ? window.mcpClient.getUserId() : undefined,
                    jsonrpc: {
                        jsonrpc: '2.0', id: 1, method: 'tools/call',
                        params: { name: toolName, arguments: args || {} },
                    },
                }),
            });
            return (data && data.response) ? data.response : data;
        } catch (e) {
            console.warn(`[ingestion] ${toolName} proxy call failed:`, e);
            return null;
        }
    }

    /**
     * Defensively parse an MCP list_providers result into a string[] of provider
     * names. Handles: { providers:[...] }, result.content[0].text JSON, plain
     * arrays, and the callTool wrapper { success, result }. Returns [] on failure.
     */
    _parseListProviders(res) {
        const norm = (arr) => Array.isArray(arr)
            ? arr.map(x => {
                if (typeof x === 'string') return { name: x, available: true };
                const name = x && (x.name || x.id);
                if (!name) return null;
                return {
                    name,
                    label: x.label || name,
                    available: x.available !== false,
                    embeds_internally: x.embeds_internally === true,
                    connection_schema: (x.connection_schema && typeof x.connection_schema === 'object') ? x.connection_schema : null,
                };
            }).filter(Boolean)
            : [];
        try {
            if (!res) return [];
            // callTool wrapper { success, result }.
            const result = (res.result !== undefined) ? res.result : res;
            if (!result) return [];
            // Direct providers array.
            if (Array.isArray(result.providers)) return norm(result.providers);
            if (Array.isArray(result)) return norm(result);
            // MCP content framing: result.content[0].text = JSON string.
            const content = result.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part && typeof part.text === 'string') {
                        try {
                            const obj = JSON.parse(part.text);
                            if (Array.isArray(obj)) return norm(obj);
                            if (obj && Array.isArray(obj.providers)) return norm(obj.providers);
                        } catch (e) { /* not JSON — ignore */ }
                    }
                }
            }
            // structuredContent fallback.
            const sc = result.structuredContent;
            if (sc && Array.isArray(sc.providers)) return norm(sc.providers);
        } catch (e) {
            console.warn('[ingestion/loader] parse list_providers failed:', e);
        }
        return [];
    }

    /** Heuristic: is this MCP server a vector-store server? (name/desc/url). */
    _isVectorStoreMcpServer(server) {
        if (!server) return false;
        const hay = `${server.name || ''} ${server.description || ''} ${server.url || ''}`.toLowerCase();
        return /\b(vector|qdrant|qdant|mcp_qrant|pgvector)\b/.test(hay)
            || /vector|qdrant|mcp_qrant|pgvector/.test(hay);
    }

    /**
     * Wire the store node's "Vector DB" provider radios + dynamic connection form
     * + conditional embeddings dropdown + Test connection. Mirrors the loader:
     * the vector-store MCP server is auto-resolved into a hidden input (store:
     * "mcp:<id>"); providers/connection/embeddings come from list_providers /
     * connection_schema / list_embeddings. Everything degrades gracefully — a
     * missing mcpClient or a failing call must never throw.
     */
    _wireStoreProviderAndConnection(config = {}) {
        const storeInput = document.getElementById('ingestion-vs-store');
        const providerHost = document.getElementById('ingestion-vs-provider-host');
        const connHost = document.getElementById('ingestion-vs-connection-host');
        const embWrap = document.getElementById('ingestion-vs-embeddings-wrap');
        const embSel = document.getElementById('ingestion-vs-embedding');
        if (!storeInput || !providerHost || !connHost) return;

        const savedConn = (config.connection && typeof config.connection === 'object') ? config.connection : {};
        const savedProvider = config.provider || '';
        const savedEmbedding = config.embedding || '';

        // --- 1. Resolve the vector-store MCP server (sync, from mcpClient.servers). ---
        const collectServers = () => {
            const out = [];
            try {
                const map = window.mcpClient && window.mcpClient.servers;
                if (map && typeof map.forEach === 'function') {
                    map.forEach(s => { if (this._isVectorStoreMcpServer(s)) out.push(s); });
                }
            } catch (e) { console.warn('[ingestion/store] server collect failed:', e); }
            return out;
        };
        const savedId = String(config.store || '').startsWith('mcp:') ? String(config.store).slice(4) : '';
        let chosen = null; // {id, url, name}
        const resolveServer = () => {
            const servers = collectServers();
            const pick = servers.find(s => savedId && String(s.id) === savedId)
                || servers.find(s => /mcp_qrant|qdrant/i.test(`${s.name || ''} ${s.url || ''}`))
                || servers[0] || null;
            chosen = pick ? { id: String(pick.id), url: pick.url || '', name: pick.name || `server ${pick.id}` } : null;
            storeInput.value = chosen ? `mcp:${chosen.id}` : '';
            if (chosen) storeInput.dataset.url = chosen.url;
        };

        // --- providers (from list_providers; gated on `available`). ---
        let providers = [];
        const providerByName = (name) => providers.find(p => p.name === name) || null;

        const renderConnection = () => {
            const checked = providerHost.querySelector('input[name="ingestion-vs-provider"]:checked');
            const prov = checked ? providerByName(checked.value) : null;
            const fields = (prov && prov.connection_schema && Array.isArray(prov.connection_schema.fields))
                ? prov.connection_schema.fields : [];
            connHost.innerHTML = fields.map(f => {
                const name = f.name;
                const label = this.escapeHtml(f.label || name);
                const req = f.required ? ' *' : '';
                const cur = savedConn[name] != null ? String(savedConn[name]) : '';
                if (f.type === 'select' && Array.isArray(f.options)) {
                    const opts = f.options.map(o => `<option value="${this.escapeHtml(String(o))}" ${cur === String(o) ? 'selected' : ''}>${this.escapeHtml(String(o))}</option>`).join('');
                    return `<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#9ca3af;">${label}${req}</label>`
                        + `<select data-conn-field="${this.escapeHtml(name)}">${opts}</select></div>`;
                }
                const inputType = (f.mask || f.type === 'password') ? 'password' : (f.type === 'number' ? 'number' : 'text');
                return `<div style="margin-bottom:8px;"><label style="display:block;font-size:12px;color:#9ca3af;">${label}${req}</label>`
                    + `<input type="${inputType}" data-conn-field="${this.escapeHtml(name)}" value="${this.escapeHtml(cur)}"></div>`;
            }).join('') || '<span style="font-size:12px;color:#6b7280;">No connection fields for this provider.</span>';
        };

        const toggleEmbeddings = () => {
            const checked = providerHost.querySelector('input[name="ingestion-vs-provider"]:checked');
            const prov = checked ? providerByName(checked.value) : null;
            // Self-embedding providers (Qdrant) hide the dropdown; others show it.
            if (!prov || prov.embeds_internally) {
                if (embWrap) embWrap.style.display = 'none';
                return;
            }
            if (embWrap) embWrap.style.display = '';
            if (embSel && embSel.options.length === 0) {
                this._mcpProxyToolCall(chosen, 'list_embeddings', {}).then(rpc => {
                    const embs = this._parseListEmbeddings(rpc);
                    embSel.innerHTML = embs.map(e =>
                        `<option value="${this.escapeHtml(e.id)}" ${e.id === savedEmbedding ? 'selected' : ''}>${this.escapeHtml(e.label || e.id)}</option>`).join('');
                });
            }
        };

        const renderProviders = () => {
            providerHost.style.display = 'grid';
            providerHost.style.gridTemplateColumns = '1fr 1fr';
            providerHost.style.columnGap = '16px';
            providerHost.style.rowGap = '8px';
            providerHost.innerHTML = providers.map(p => {
                const disabled = !p.available;
                const checked = (p.name === savedProvider && !disabled) ? 'checked' : '';
                const suffix = disabled ? ' (coming soon)' : '';
                const style = `display:flex;align-items:center;gap:6px;` + (disabled ? 'opacity:.5;cursor:not-allowed;' : '');
                return `<label class="ingestion-loader-provider-radio${disabled ? ' disabled' : ''}" style="${style}">`
                    + `<input type="radio" name="ingestion-vs-provider" value="${this.escapeHtml(p.name)}" ${checked} ${disabled ? 'disabled' : ''}>`
                    + `<span>${this.escapeHtml(p.label || p.name)}${suffix}</span></label>`;
            }).join('');
            if (!providerHost.querySelector('input[name="ingestion-vs-provider"]:checked')) {
                const firstEnabled = providerHost.querySelector('input[name="ingestion-vs-provider"]:not([disabled])');
                if (firstEnabled) firstEnabled.checked = true;
            }
            providerHost.querySelectorAll('input[name="ingestion-vs-provider"]').forEach(r => {
                r.addEventListener('change', () => { renderConnection(); toggleEmbeddings(); });
            });
            renderConnection();
            toggleEmbeddings();
        };

        // Show a status/diagnostic line in the provider host (while probing or
        // when nothing answers) so the box is never a silent empty.
        const showProviderStatus = (msg, color) => {
            providerHost.style.display = 'block';
            providerHost.innerHTML = `<span style="font-size:12px;color:${color || '#9ca3af'};">${this.escapeHtml(msg)}</span>`;
        };

        // Probe the registered vector-store servers and adopt the FIRST that
        // answers list_providers — the old qdrant double (no list_providers,
        // session-stateful) is skipped automatically. Sets `chosen` to the winner.
        const refreshProviders = async () => {
            const servers = collectServers();
            if (!servers.length) {
                showProviderStatus('No vector-store MCP server registered. Register the mcp_qrant server (e.g. http://127.0.0.1:8008/mcp) in MCP servers, then reopen.', '#f59e0b');
                return;
            }
            // Order: saved first, then mcp_qrant/8008/vector-ish names, then the rest.
            const ordered = [];
            const pushUnique = (s) => { if (s && !ordered.some(o => String(o.id) === String(s.id))) ordered.push(s); };
            servers.filter(s => savedId && String(s.id) === savedId).forEach(pushUnique);
            servers.filter(s => /mcp_qrant|8008|vector/i.test(`${s.name || ''} ${s.url || ''}`)).forEach(pushUnique);
            servers.forEach(pushUnique);

            for (const s of ordered) {
                const cand = { id: String(s.id), url: s.url || '', name: s.name || `server ${s.id}` };
                const rpc = await this._mcpProxyToolCall(cand, 'list_providers', {});
                const parsed = this._parseListProviders(rpc);
                if (parsed && parsed.length) {
                    chosen = cand;
                    storeInput.value = `mcp:${cand.id}`;
                    storeInput.dataset.url = cand.url;
                    providers = parsed;
                    renderProviders();
                    return;
                }
            }
            const tried = ordered.map(s => `${s.name || s.id} (${s.url || '?'})`).join(', ');
            showProviderStatus(`No registered vector-store MCP answered list_providers. Tried: ${tried}. Point the store node at the new mcp_qrant server (http://127.0.0.1:8008/mcp).`, '#f59e0b');
        };

        // Wire the Test connection button.
        const testBtn = document.getElementById('ingestion-vs-test');
        const testOut = document.getElementById('ingestion-vs-test-result');
        if (testBtn) testBtn.addEventListener('click', async () => {
            const checked = providerHost.querySelector('input[name="ingestion-vs-provider"]:checked');
            const provider = checked ? checked.value : '';
            if (!provider) { if (testOut) testOut.textContent = 'Pick a provider first.'; return; }
            if (testOut) testOut.textContent = 'Testing…';
            const rpc = await this._mcpProxyToolCall(chosen, 'test_connection', { provider, connection: this._readStoreConnection() });
            let ok = false, msg = 'no response';
            try {
                // test_connection payload is {ok:bool,message?} inside content[0].text.
                const result = (rpc && rpc.result !== undefined) ? rpc.result : rpc;
                let payload = result;
                const content = result && result.content;
                if (Array.isArray(content) && content[0] && typeof content[0].text === 'string') {
                    try { payload = JSON.parse(content[0].text); } catch (e) { /* ignore */ }
                }
                ok = !!(payload && payload.ok);
                msg = (payload && payload.message) ? payload.message : (ok ? 'OK' : 'failed');
            } catch (e) { msg = String(e); }
            if (testOut) { testOut.textContent = ok ? '✓ OK' : `✗ ${msg}`; testOut.style.color = ok ? '#34d399' : '#f87171'; }
        });

        // Resolve a default sync (for the hidden input), show a probing status,
        // then refresh from the live server list — the probe in refreshProviders
        // authoritatively adopts whichever registered server answers list_providers.
        resolveServer();
        showProviderStatus('Discovering vector-store providers…');
        try {
            if (window.mcpClient && typeof window.mcpClient.loadServers === 'function') {
                window.mcpClient.loadServers()
                    .then(() => refreshProviders())
                    .catch(e => { console.warn('[ingestion/store] loadServers failed:', e); refreshProviders(); });
            } else {
                refreshProviders();
            }
        } catch (e) { console.warn('[ingestion/store] loadServers threw:', e); refreshProviders(); }
    }

    /** Gather the store node's connection form into a {field: value} object. */
    _readStoreConnection() {
        const host = document.getElementById('ingestion-vs-connection-host');
        const out = {};
        if (!host) return out;
        host.querySelectorAll('[data-conn-field]').forEach(el => {
            const k = el.getAttribute('data-conn-field');
            const v = (el.value != null ? String(el.value) : '').trim();
            if (k && v !== '') out[k] = v;
        });
        return out;
    }

    /**
     * Defensively parse a list_embeddings result into [{id,label}]. Handles the
     * MCP content[0].text JSON framing and {embeddings:[...]}. Returns [] on fail.
     */
    _parseListEmbeddings(res) {
        const norm = (arr) => Array.isArray(arr)
            ? arr.map(x => {
                const id = x && (x.id || x.name);
                return id ? { id, label: x.label || id } : null;
            }).filter(Boolean)
            : [];
        try {
            if (!res) return [];
            const result = (res.result !== undefined) ? res.result : res;
            if (!result) return [];
            if (Array.isArray(result.embeddings)) return norm(result.embeddings);
            const content = result.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part && typeof part.text === 'string') {
                        try {
                            const obj = JSON.parse(part.text);
                            if (Array.isArray(obj)) return norm(obj);
                            if (obj && Array.isArray(obj.embeddings)) return norm(obj.embeddings);
                        } catch (e) { /* not JSON */ }
                    }
                }
            }
        } catch (e) { console.warn('[ingestion/store] parse list_embeddings failed:', e); }
        return [];
    }

    showIngestionConfigModal(nodeId) {
        const nodeData = this.editor.getNodeFromId(nodeId);
        if (!nodeData) return;

        const nodeType = nodeData.data?.node_type;
        const config = nodeData.data?.config || {};
        if (!nodeType) return;

        const META = {
            loader:      { icon: '📥', name: 'Loader' },
            splitter:    { icon: '✂️', name: 'Splitter' },
            vectorstore: { icon: '🗄️', name: 'Vector store' },
        };
        const meta = META[nodeType] || { icon: '⚙', name: nodeType };

        // Build type-specific, pre-filled fields.
        // "Disable execution" is shared chrome. For the loader we place it inside
        // the 2-column grid (row 1, right of the File storage box) per the
        // requested layout; other node types keep it at the top.
        const disableHtml = `
                <div class="storage-config-folder storage-config-disable">
                    <label for="ingestion-node-disabled" class="storage-config-disable-row">
                        <input type="checkbox" id="ingestion-node-disabled" ${config.disabled ? 'checked' : ''}>
                        <span>Disable execution</span>
                    </label>
                    <small>This node is skipped when the pipeline compiles or runs — handy for debugging.</small>
                </div>`;
        let fieldsHtml = '';
        if (nodeType === 'loader') {
            // File-type FILTER: the checked formats are the only ones processed.
            // Empty set = no restriction (every supported type). Migrate the old
            // single `source` field: 'auto' -> [] (all), an explicit type -> [it].
            let loaderTypes = Array.isArray(config.types) ? config.types.slice() : null;
            if (loaderTypes === null) {
                loaderTypes = (config.source && config.source !== 'auto') ? [config.source] : [];
            }
            const typeOpts = [
                { v: 'pdf',  label: 'PDF (.pdf)' },
                { v: 'word', label: 'Word (.docx)' },
                { v: 'text', label: 'Text (.txt)' },
                { v: 'csv',  label: 'CSV (.csv)' },
                { v: 'html', label: 'HTML (.html)' },
            ];
            const typeChecksHtml = typeOpts.map(o => {
                const checked = loaderTypes.length === 0 || loaderTypes.includes(o.v);
                return `<label class="ingestion-type-check"><input type="checkbox" class="ingestion-loader-type" value="${o.v}" ${checked ? 'checked' : ''}><span>${o.label}</span></label>`;
            }).join('');
            // 2-column layout: row 1 = Parallel workers | Disable execution,
            // row 2 = File types (checkbox filter) | Provider (radios). The
            // storage-server selector is kept HIDDEN (the loader resolves which
            // MCP server to use under the hood — not user-facing). The key box and
            // the Source picker span full width below.
            fieldsHtml = `
                <div class="storage-config-folder">
                    <label for="ingestion-loader-workers">Parallel workers <span style="font-weight:400;color:#6b7280;">(▶ Start runs this many in parallel — defaults to your CPU cores)</span></label>
                    <input type="number" id="ingestion-loader-workers" min="1" max="32" value="${this.escapeHtml(config.workers != null && config.workers !== '' ? String(config.workers) : String(Math.min((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, 8)))}" placeholder="auto (≈ CPU cores)">
                </div>
                ${disableHtml}
                <div class="storage-config-folder">
                    <label>File types <span style="font-weight:400;color:#6b7280;">(only the checked formats are processed)</span></label>
                    <div id="ingestion-loader-types" class="ingestion-loader-type-checks">
                        ${typeChecksHtml}
                    </div>
                </div>
                <div class="storage-config-folder" id="ingestion-loader-provider-wrap">
                    <label>Provider</label>
                    <div id="ingestion-loader-provider-host" class="ingestion-loader-provider-radios"></div>
                </div>
                <div id="ingestion-loader-storage-wrap" style="display:none;">
                    <div id="ingestion-loader-storage-host"></div>
                </div>
                <div class="storage-config-folder full" id="ingestion-loader-ufskey-wrap" style="display:none;">
                    <label for="ingestion-loader-ufskey">UniversalFS key <span style="font-weight:400;color:#6b7280;">(required for this provider)</span></label>
                    <input type="text" id="ingestion-loader-ufskey" value="${this.escapeHtml(config.ufskey || '')}" placeholder="ufs_…">
                </div>
                <div class="storage-config-folder full">
                    <label>Source <span style="font-weight:400;color:#6b7280;">(inside your workspace folder)</span></label>
                    <div class="ingestion-loader-split">
                        <div class="ingestion-loader-left">
                            <button type="button" class="ingestion-browse-btn" id="ingestion-browse">📂 Browse storage…</button>
                            <p class="ingestion-loader-explain">
                                Browse your storage provider (via UniversalFS) and pick a <strong>folder</strong>
                                — every file inside it (recursively) is processed — or a single <strong>file</strong>.
                                You can also type a path directly. UniversalFS reads it; only the path is needed.
                            </p>
                            <input type="text" id="ingestion-loader-path" class="ingestion-path-input" value="${this.escapeHtml(config.path || '')}" data-is-dir="${config.is_dir ? '1' : ''}" placeholder="Path to a file or folder — or click Browse storage…">
                        </div>
                        <div class="ingestion-loader-right">
                            <div class="ingestion-folder-list-title" id="ingestion-sel-title">Selection</div>
                            <div id="ingestion-folder-list" class="ingestion-folder-list">${this._loaderHelpHtml()}</div>
                        </div>
                    </div>
                </div>
            `;
        } else if (nodeType === 'splitter') {
            fieldsHtml = `
                <div class="storage-config-folder">
                    <label for="ingestion-splitter-strategy">Strategy</label>
                    <select id="ingestion-splitter-strategy">
                        <option value="recursive" selected>recursive</option>
                    </select>
                </div>
                <div class="storage-config-folder">
                    <label for="ingestion-splitter-chunk">Chunk size</label>
                    <input type="number" id="ingestion-splitter-chunk" value="${this.escapeHtml(String(config.chunk_size ?? 1000))}" min="1">
                </div>
                <div class="storage-config-folder">
                    <label for="ingestion-splitter-overlap">Overlap</label>
                    <input type="number" id="ingestion-splitter-overlap" value="${this.escapeHtml(String(config.overlap ?? 150))}" min="0">
                </div>
            `;
        } else if (nodeType === 'vectorstore') {
            // Two column stacks inside the 2-col grid:
            //   LEFT  = Vector DB (provider) → Collection → Test connection
            //   RIGHT = Connection (provider's DB params) → Disable execution
            // Embeddings (non-self-embedding providers only) spans full width below.
            fieldsHtml = `
                <div class="ingestion-vs-col">
                    <div class="storage-config-folder" id="ingestion-vs-provider-wrap">
                        <label>Vector DB</label>
                        <div id="ingestion-vs-provider-host" class="ingestion-loader-provider-radios"></div>
                        <input type="hidden" id="ingestion-vs-store" value="${this.escapeHtml(config.store || '')}">
                    </div>
                    <div class="storage-config-folder">
                        <label for="ingestion-vs-collection">Collection</label>
                        <input type="text" id="ingestion-vs-collection" value="${this.escapeHtml(config.collection || '')}" placeholder="Collection name">
                    </div>
                    <div class="storage-config-folder">
                        <button type="button" id="ingestion-vs-test" class="storage-config-btn cancel" style="padding:4px 14px;">Test connection</button>
                        <span id="ingestion-vs-test-result" style="margin-left:8px;font-size:12px;color:#9ca3af;"></span>
                    </div>
                </div>
                <div class="ingestion-vs-col">
                    <div class="storage-config-folder">
                        <label for="ingestion-node-disabled" class="storage-config-disable-row">
                            <input type="checkbox" id="ingestion-node-disabled" ${config.disabled ? 'checked' : ''}>
                            <span>Disable execution</span>
                        </label>
                        <small>This node is skipped when the pipeline compiles or runs — handy for debugging.</small>
                    </div>
                    <div class="storage-config-folder" id="ingestion-vs-connection-wrap">
                        <label>Connection</label>
                        <div id="ingestion-vs-connection-host"></div>
                    </div>
                    <div class="storage-config-folder" id="ingestion-vs-embeddings-wrap" style="display:none;">
                        <label for="ingestion-vs-embedding">Embeddings</label>
                        <select id="ingestion-vs-embedding"></select>
                    </div>
                </div>
            `;
        }

        // Remove existing modal if any.
        const existingModal = document.getElementById('ingestion-config-modal');
        if (existingModal) existingModal.remove();

        // Tab layout. Compiler nodes (splitter / vectorstore) keep the four-tab
        // view: "Config", "Input" (code received from the previous stage),
        // "Generated code" (this node's own chunk) and "Output" (Input +
        // Generated). The LOADER is interpreted — its Input/Generated-code tabs
        // are irrelevant, so it shows only "Config" and "Output", where Output
        // displays the file CONTENT extracted to text (not compiler code).
        // Loader and splitter are INTERPRETED nodes: Config + Output only, where
        // Output is per-round (one file at a time) with a Prev/Next stepper —
        // loader shows the file's text, splitter shows that text's chunks.
        const isInterpretedNode = (nodeType === 'loader' || nodeType === 'splitter' || nodeType === 'vectorstore');
        const outputHint = nodeType === 'splitter'
            ? 'Open this tab to chunk the first file.'
            : nodeType === 'vectorstore'
                ? 'Open this tab to preview what will be stored (▶ Start writes).'
                : 'Open this tab to extract the first file to text.';
        const codePreStyle = "margin:0;padding:12px;background:#1e1e1e;color:#d4d4d4;border-radius:6px;font-family:Menlo,Monaco,'Courier New',monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto;";
        const tabBtn = (tab, label, active) =>
            `<button type="button" class="ingestion-tab-btn${active ? ' active' : ''}" data-tab="${tab}"
                style="background:none;border:none;border-bottom:2px solid transparent;padding:8px 12px;color:inherit;cursor:pointer;font-size:13px;${active ? '' : 'opacity:0.7;'}">${label}</button>`;
        const isStoreNode = nodeType === 'vectorstore';
        const tabsHtml = isInterpretedNode
            ? `${tabBtn('config', 'Config', true)}${tabBtn('output', 'Output', false)}${isStoreNode ? tabBtn('search', 'Search', false) : ''}${tabBtn('logs', 'Logs', false)}`
            : `${tabBtn('config', 'Config', true)}${tabBtn('input', 'Input', false)}${tabBtn('generated', 'Generated code', false)}${tabBtn('output', 'Output', false)}`;
        const searchPanel = isStoreNode
            ? `<div class="ingestion-tab-panel" data-panel="search" style="display:none;">
                   <div style="display:flex;gap:8px;margin-bottom:8px;">
                       <input type="text" id="ingestion-search-query" placeholder="Search the vector store (semantic)…" style="flex:1;padding:6px 10px;border:1px solid rgba(255,255,255,0.18);border-radius:6px;background:#1e1e1e;color:#d4d4d4;">
                       <button type="button" id="ingestion-search-btn" class="storage-config-btn save" style="padding:4px 14px;">Search</button>
                   </div>
                   <pre id="ingestion-search-results" style="${codePreStyle}">Type a query and Search to retrieve the most similar chunks from the vector store.</pre>
               </div>`
            : '';
        const codePanels = isInterpretedNode
            ? `<div class="ingestion-tab-panel" data-panel="output" style="display:none;">
                   <div class="ingestion-loader-roundbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                       <button type="button" id="ingestion-round-prev" class="storage-config-btn cancel" style="padding:4px 10px;">◀ Prev</button>
                       <button type="button" id="ingestion-round-next" class="storage-config-btn cancel" style="padding:4px 10px;">Next file ▶</button>
                       <span id="ingestion-round-info" style="color:#9ca3af;font-size:12px;"></span>
                   </div>
                   <pre id="ingestion-output-code" style="${codePreStyle}">${outputHint}</pre>
               </div>
               ${searchPanel}
               <div class="ingestion-tab-panel" data-panel="logs" style="display:none;">
                   <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                       <span style="color:#9ca3af;font-size:12px;">Logs published by this node (and its upstream stages).</span>
                       <button type="button" id="ingestion-logs-clear" class="storage-config-btn cancel" style="padding:4px 10px;">Clear</button>
                   </div>
                   <pre id="ingestion-logs-pre" style="${codePreStyle}">No logs yet — run this node (Output tab) or ▶ Start.</pre>
               </div>`
            : `<div class="ingestion-tab-panel" data-panel="input" style="display:none;">
                   <pre id="ingestion-input-code" style="${codePreStyle}">Loading…</pre>
               </div>
               <div class="ingestion-tab-panel" data-panel="generated" style="display:none;">
                   <pre id="ingestion-generated-code" style="${codePreStyle}">Loading…</pre>
               </div>
               <div class="ingestion-tab-panel" data-panel="output" style="display:none;">
                   <pre id="ingestion-output-code" style="${codePreStyle}">Loading…</pre>
               </div>`;
        const modalHtml = `
            <div id="ingestion-config-modal" class="storage-config-overlay">
                <div class="storage-config-modal">
                    <div class="storage-config-header">
                        <h3><span>${meta.icon}</span> ${this.escapeHtml(meta.name)}</h3>
                        <button class="storage-config-close" id="ingestion-config-close">×</button>
                    </div>
                    <div class="storage-config-body">
                        <div class="ingestion-config-tabs" style="display:flex;gap:8px;margin-bottom:14px;border-bottom:1px solid rgba(255,255,255,0.12);">
                            ${tabsHtml}
                        </div>
                        <div class="ingestion-tab-panel" data-panel="config">
                            <div class="storage-config-grid">
                                ${(nodeType === 'loader' || nodeType === 'vectorstore') ? '' : disableHtml}
                                ${fieldsHtml}
                            </div>
                        </div>
                        ${codePanels}
                    </div>
                    <div class="storage-config-footer">
                        <button class="storage-config-btn cancel" id="ingestion-config-cancel">${this.t('common.cancel')}</button>
                        <button class="storage-config-btn save" id="ingestion-config-save">${this.t('common.save')}</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        if (nodeType === 'vectorstore') {
            this._wireStoreProviderAndConnection(config);
            // Retrieval test panel: query the vector store via `find`.
            const searchBtn = document.getElementById('ingestion-search-btn');
            const searchInput = document.getElementById('ingestion-search-query');
            if (searchBtn) searchBtn.addEventListener('click', () => this.searchVectorStore(nodeId));
            if (searchInput) searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.searchVectorStore(nodeId); }
            });
        }
        if (nodeType === 'loader') {
            this._wireLoaderPathPicker();
            this._wireLoaderStorageAndProvider(config);
        }
        if (nodeType === 'loader' || nodeType === 'splitter' || nodeType === 'vectorstore') {
            // Per-round Output stepper, shared by loader (text), splitter
            // (chunks) and store (write preview). Each round = one file.
            this._nodeRound = 0;
            this._nodeRoundCount = null;
            const runRound = () => this._loadNodeRound(nodeId, nodeType);
            const prevBtn = document.getElementById('ingestion-round-prev');
            const nextBtn = document.getElementById('ingestion-round-next');
            if (prevBtn) prevBtn.addEventListener('click', () => {
                if (this._nodeRound > 0) { this._nodeRound--; runRound(); }
            });
            if (nextBtn) nextBtn.addEventListener('click', () => {
                const max = (this._nodeRoundCount ?? 1) - 1;
                if (this._nodeRound < max) { this._nodeRound++; runRound(); }
            });
            // Logs tab: per-node-type buffer (persists across opens within a
            // session), populated by node runs and ▶ Start. Track the open node
            // type so live appends re-render the right modal.
            this._ingestionLogs = this._ingestionLogs || { loader: [], splitter: [], vectorstore: [] };
            this._openIngestionNodeType = nodeType;
            this._renderIngestionLogs(nodeType);
            const clearLogsBtn = document.getElementById('ingestion-logs-clear');
            if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => {
                if (this._ingestionLogs[nodeType]) this._ingestionLogs[nodeType] = [];
                this._renderIngestionLogs(nodeType);
            });
        }

        const modal = document.getElementById('ingestion-config-modal');
        const closeBtn = document.getElementById('ingestion-config-close');
        const cancelBtn = document.getElementById('ingestion-config-cancel');
        const saveBtn = document.getElementById('ingestion-config-save');

        // No orange "active" halo for ingestion — the node only turns GREEN once
        // its code chunk has been generated (see loadIngestionNodeOutput). Clear
        // any stray orange, but never the green "generated" state.
        document.querySelectorAll('.drawflow-node.node-active').forEach(n => n.classList.remove('node-active'));

        const closeModal = () => {
            // Remove the halo on every close path (X, Cancel, overlay, Save, Escape).
            const el = document.getElementById('node-' + nodeId);
            if (el) el.classList.remove('node-active');
            this._openIngestionNodeType = null;
            modal.remove();
            document.removeEventListener('keydown', escHandler);
        };
        const escHandler = (e) => { if (e.key === 'Escape') closeModal(); };

        // --- Tab toggling + lazy Output fetch ---
        const tabBtns = modal.querySelectorAll('.ingestion-tab-btn');
        const panels = modal.querySelectorAll('.ingestion-tab-panel');
        const showTab = (tab) => {
            tabBtns.forEach(b => {
                const on = b.dataset.tab === tab;
                b.classList.toggle('active', on);
                b.style.borderBottomColor = on ? '#ff8c00' : 'transparent';
                b.style.opacity = on ? '1' : '0.7';
            });
            panels.forEach(p => { p.style.display = p.dataset.panel === tab ? '' : 'none'; });
            if (isInterpretedNode) {
                // Interpreted node: Output shows real results (loader=text,
                // splitter=chunks), NOT compiler code — so don't hit the
                // compiler endpoint; run the node live per round.
                if (tab === 'output') this._loadNodeRound(nodeId, nodeType);
                if (tab === 'logs') this._renderIngestionLogs(nodeType);
                return;
            }
            if (tab === 'input' || tab === 'generated' || tab === 'output') {
                // Always re-generate from the current form so changing an
                // attribute (e.g. document type) updates the code. One fetch
                // fills all three code panels (input / generated / output).
                this.loadIngestionNodeOutput(nodeId);
            }
        };
        tabBtns.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
        // Initialise the active-tab underline colour.
        showTab('config');

        // Close on background click, X, Cancel, Escape.
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        document.addEventListener('keydown', escHandler);

        // Save: read fields, build new config, write back to node data,
        // refresh the on-canvas summary, close.
        saveBtn.addEventListener('click', () => {
            let newConfig;
            if (nodeType === 'loader') {
                newConfig = this._readIngestionFormConfig('loader', config);
            } else if (nodeType === 'splitter') {
                const chunk = parseInt(document.getElementById('ingestion-splitter-chunk').value, 10);
                const overlap = parseInt(document.getElementById('ingestion-splitter-overlap').value, 10);
                newConfig = {
                    strategy: document.getElementById('ingestion-splitter-strategy').value,
                    chunk_size: Number.isFinite(chunk) ? chunk : 1000,
                    overlap: Number.isFinite(overlap) ? overlap : 150,
                };
            } else if (nodeType === 'vectorstore') {
                newConfig = this._readIngestionFormConfig('vectorstore', config);
            } else {
                newConfig = { ...config };
            }

            // The disable toggle is common to every ingestion node type.
            newConfig.disabled = !!document.getElementById('ingestion-node-disabled')?.checked;

            // Write back to the Drawflow node data, mirroring the agent
            // path's use of updateNodeDataFromId.
            const updatedData = { ...nodeData.data, config: newConfig };
            this.editor.updateNodeDataFromId(nodeId, updatedData);

            // Refresh the on-canvas summary line.
            const summary = this.ingestionNodeSummary(nodeType, newConfig);
            const nodeElement = document.getElementById(`node-${nodeId}`);
            const displayEl = nodeElement?.querySelector('.node-config-display');
            if (displayEl) displayEl.textContent = summary;
            // Grey the node out on the canvas when disabled.
            nodeElement?.querySelector('.workflow-node')?.classList.toggle('node-disabled', newConfig.disabled);

            closeModal();
        });
    }

    /**
     * Fetch the Python code a single ingestion node generates and render it
     * in the Output tab's <pre>. Read-only; the backend writes nothing and
     * runs nothing. Only 'loader' returns code so far — other node types get
     * the backend's "not implemented yet" message shown as the output text.
     */
    async loadIngestionNodeOutput(nodeId) {
        const inputPre = document.getElementById('ingestion-input-code');
        const generatedPre = document.getElementById('ingestion-generated-code');
        const outputPre = document.getElementById('ingestion-output-code');
        // The three code panels are filled together; bail only if none exist.
        if (!inputPre && !generatedPre && !outputPre) return;

        // Set the same text on whichever of the three panels exist.
        const setAll = (text) => {
            [inputPre, generatedPre, outputPre].forEach(p => { if (p) p.textContent = text; });
        };

        if (!this.currentWorkflowId) {
            setAll(this.t('workflow.output.saveFirst') || 'Save the workflow first.');
            return;
        }

        // Ingestion compiles from the node's OWN config (its form attributes),
        // read straight from the canvas — NO saved-graph lookup (that's the agent
        // paradigm). This hits the standalone IngestionCompiler endpoint.
        const node = this.editor.getNodeFromId(nodeId);
        const nodeType = node?.data?.node_type;
        if (!nodeType) { setAll('Not an ingestion node.'); return; }

        // Read the CURRENT form attributes so the code reflects edits even
        // before Save — change the document type and the code re-generates.
        // Each node is just parameters → code.
        const config = this._readIngestionFormConfig(nodeType, node?.data?.config || {});
        // Ordered stages (start → … → this node) so Input = the upstream Output.
        const stages = this._gatherIngestionStages(nodeType, config);
        const nodeEl = document.getElementById('node-' + nodeId);

        setAll('Loading…');
        try {
            const resp = await fetch(
                `${this.apiBase}/workflows/${this.currentWorkflowId}/ingestion/node-code`,
                {
                    method: 'POST',
                    headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ stages }),
                }
            );
            const json = await resp.json().catch(() => ({}));
            const data = (json && json.data) || {};
            // New response shape: { input, generated, output } (strings).
            // Backward-compatible: older responses only had { code } — fall back
            // to it for generated/output (and leave input empty).
            const hasNew = typeof data.input === 'string' || typeof data.generated === 'string';
            if (resp.ok && json && json.success && (hasNew || typeof data.code === 'string')) {
                const input = typeof data.input === 'string' ? data.input : '';
                const generated = typeof data.generated === 'string'
                    ? data.generated
                    : (typeof data.code === 'string' ? data.code : '');
                const output = typeof data.output === 'string'
                    ? data.output
                    : (typeof data.code === 'string' ? data.code : generated);

                if (inputPre) inputPre.textContent = input !== '' ? input : '—';
                if (generatedPre) generatedPre.textContent = generated;
                if (outputPre) outputPre.textContent = output;

                // Green halo once this node's chunk has been generated.
                if (nodeEl) { nodeEl.classList.remove('node-error'); nodeEl.classList.add('node-completed'); }
            } else {
                setAll((json && json.error) ? json.error : `Failed to load code (HTTP ${resp.status}).`);
                if (nodeEl) { nodeEl.classList.remove('node-completed'); nodeEl.classList.add('node-error'); }
            }
        } catch (e) {
            setAll('Failed to load code: ' + (e?.message || String(e)));
            if (nodeEl) { nodeEl.classList.remove('node-completed'); nodeEl.classList.add('node-error'); }
        }
    }

    /**
     * Loader node interpreter, ONE ROUND: enumerate the source via the
     * UniversalFS MCP and read + decode the file at the current cursor — the
     * loader's actual role (turn a file into text for the splitter). Each round
     * REPLACES the Output with the new file's text, mirroring the live loop
     * where the store clocks the loader one file at a time.
     */
    /** Dispatch an interpreted node's Output round to the right runner. */
    _loadNodeRound(nodeId, nodeType) {
        if (nodeType === 'splitter') return this.loadSplitterChunks(nodeId);
        if (nodeType === 'vectorstore') return this.loadStorePreview(nodeId);
        return this.loadLoaderText(nodeId);
    }

    /** Find a node's saved config by node_type (the upstream pipeline input). */
    _findNodeConfig(nodeType) {
        const nodes = this.editor.drawflow.drawflow.Home.data || {};
        for (const id of Object.keys(nodes)) {
            if (nodes[id].data?.node_type === nodeType) return nodes[id].data.config || {};
        }
        return null;
    }

    _findLoaderConfig() { return this._findNodeConfig('loader'); }
    _findSplitterConfig() { return this._findNodeConfig('splitter'); }

    /** Map a tagged log line ([loader]/[splitter]/[store]) to a node type. */
    _logTypeFromTag(line) {
        const s = String(line);
        if (s.startsWith('[loader]')) return 'loader';
        if (s.startsWith('[splitter]')) return 'splitter';
        if (s.startsWith('[store]')) return 'vectorstore';
        return null;
    }

    /**
     * Append node-published log lines to their per-type buffers (routed by the
     * [loader]/[splitter]/[store] tag), and live-refresh the open node's Logs
     * tab if it was touched. Called from node runs and ▶ Start.
     */
    _appendIngestionLogs(lines) {
        if (!Array.isArray(lines) || !lines.length) return;
        this._ingestionLogs = this._ingestionLogs || { loader: [], splitter: [], vectorstore: [] };
        let stamp = '';
        try { stamp = new Date().toLocaleTimeString(); } catch (_) { stamp = ''; }
        const touched = new Set();
        for (const line of lines) {
            const type = this._logTypeFromTag(line);
            if (!type) continue;
            const buf = this._ingestionLogs[type];
            buf.push(stamp ? `${stamp}  ${line}` : String(line));
            if (buf.length > 500) buf.shift();
            touched.add(type);
        }
        if (this._openIngestionNodeType && touched.has(this._openIngestionNodeType)) {
            this._renderIngestionLogs(this._openIngestionNodeType);
        }
    }

    /** Render a node type's log buffer into the open modal's Logs panel. */
    _renderIngestionLogs(nodeType) {
        const pre = document.getElementById('ingestion-logs-pre');
        if (!pre) return;
        const buf = (this._ingestionLogs && this._ingestionLogs[nodeType]) || [];
        pre.textContent = buf.length ? buf.join('\n') : 'No logs yet — run this node (Output tab) or ▶ Start.';
        pre.scrollTop = pre.scrollHeight;
    }

    /**
     * Generic per-round Output runner for interpreted nodes. `opts.url` is the
     * node endpoint, `opts.body` the request body (gets `cursor` added), and
     * `opts.render(data)` formats the panel text. Drives glow + the round bar.
     */
    async _runNodeRound(nodeId, opts) {
        const outputPre = document.getElementById('ingestion-output-code');
        if (!outputPre) return;
        const nodeEl = document.getElementById('node-' + nodeId);
        const info = document.getElementById('ingestion-round-info');

        if (!this.currentWorkflowId) {
            outputPre.textContent = this.t('workflow.output.saveFirst') || 'Save the workflow first.';
            return;
        }
        if (opts.precheck) {
            const msg = opts.precheck();
            if (msg) { outputPre.textContent = msg; return; }
        }

        const cursor = this._nodeRound || 0;
        outputPre.textContent = opts.loading || 'Running…';
        if (nodeEl) nodeEl.classList.add('node-active');
        try {
            const resp = await fetch(
                `${this.apiBase}/workflows/${this.currentWorkflowId}/ingestion/${opts.endpoint}`,
                {
                    method: 'POST',
                    headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ ...opts.body, cursor }),
                }
            );
            const json = await resp.json().catch(() => ({}));
            if (nodeEl) nodeEl.classList.remove('node-active');
            const data = (json && json.data) || {};
            if (resp.ok && json && json.success) {
                this._nodeRoundCount = data.count || 0;
                outputPre.textContent = opts.render(data);
                this._updateRoundBar(data);
                this._appendIngestionLogs(data.logs);
                if (nodeEl) { nodeEl.classList.remove('node-error'); nodeEl.classList.add('node-completed'); }
            } else {
                outputPre.textContent = (json && json.error) ? json.error : `Failed (HTTP ${resp.status}).`;
                if (info) info.textContent = '';
                if (nodeEl) { nodeEl.classList.remove('node-completed'); nodeEl.classList.add('node-error'); }
            }
        } catch (e) {
            if (nodeEl) nodeEl.classList.remove('node-active');
            outputPre.textContent = 'Failed: ' + (e?.message || String(e));
            if (nodeEl) { nodeEl.classList.remove('node-completed'); nodeEl.classList.add('node-error'); }
        }
    }

    /**
     * Loader node interpreter, ONE ROUND: enumerate the source via the
     * UniversalFS MCP and read + decode the file at the current cursor — the
     * loader's actual role (turn a file into text for the splitter). Each round
     * REPLACES the Output with the new file's text.
     */
    async loadLoaderText(nodeId) {
        const node = this.editor.getNodeFromId(nodeId);
        const config = this._readIngestionFormConfig('loader', node?.data?.config || {});
        return this._runNodeRound(nodeId, {
            endpoint: 'loader-text',
            body: { config },
            loading: 'Reading and extracting text…',
            precheck: () => config.path ? '' : 'Choose a file or folder in the Config tab first.',
            render: (data) => this._renderLoaderRound(data),
        });
    }

    /**
     * Splitter node interpreter, ONE ROUND: take the upstream loader's text for
     * the file at the current cursor and chunk it (recursive splitter). Output
     * shows that file's chunks.
     */
    async loadSplitterChunks(nodeId) {
        const node = this.editor.getNodeFromId(nodeId);
        const splitter = this._readIngestionFormConfig('splitter', node?.data?.config || {});
        const loader = this._findLoaderConfig();
        return this._runNodeRound(nodeId, {
            endpoint: 'splitter-chunks',
            body: { loader: loader || {}, splitter },
            loading: 'Chunking the file…',
            precheck: () => {
                if (!loader) return 'Add a loader node upstream first.';
                if (!loader.path) return 'The upstream loader has no Source set — open it and pick a file or folder.';
                return '';
            },
            render: (data) => this._renderSplitterRound(data),
        });
    }

    /**
     * Store node Output = a SAFE preview (no write): per file, how many chunks
     * WOULD be written and to which collection/server. The real write happens on
     * ▶ Start. Reuses splitter-chunks for the chunk count.
     */
    async loadStorePreview(nodeId) {
        const node = this.editor.getNodeFromId(nodeId);
        const store = this._readIngestionFormConfig('vectorstore', node?.data?.config || {});
        const loader = this._findLoaderConfig();
        const splitter = this._findSplitterConfig();
        return this._runNodeRound(nodeId, {
            endpoint: 'splitter-chunks',
            body: { loader: loader || {}, splitter: splitter || {} },
            loading: 'Previewing what will be stored…',
            precheck: () => {
                if (!loader || !loader.path) return 'The upstream loader has no Source set.';
                if (!String(store.store || '').startsWith('mcp:')) return 'Pick a vector-DB MCP server in this node’s Config tab.';
                return '';
            },
            render: (data) => this._renderStoreRound(data, store),
        });
    }

    /**
     * Retrieval test: run find against the store node's vector-DB MCP and
     * show the matched chunks (with their source file). Read-only.
     */
    async searchVectorStore(nodeId) {
        const resultsPre = document.getElementById('ingestion-search-results');
        const queryEl = document.getElementById('ingestion-search-query');
        if (!resultsPre || !queryEl) return;
        const query = queryEl.value.trim();
        if (!query) { resultsPre.textContent = 'Enter a query.'; return; }
        if (!this.currentWorkflowId) { resultsPre.textContent = this.t('workflow.output.saveFirst') || 'Save the workflow first.'; return; }
        const node = this.editor.getNodeFromId(nodeId);
        const store = this._readIngestionFormConfig('vectorstore', node?.data?.config || {});
        if (!String(store.store || '').startsWith('mcp:')) {
            resultsPre.textContent = 'Pick a vector-DB MCP server in the Config tab first.';
            return;
        }
        resultsPre.textContent = 'Searching…';
        try {
            const resp = await fetch(
                `${this.apiBase}/workflows/${this.currentWorkflowId}/ingestion/store-find`,
                {
                    method: 'POST',
                    headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ vectorstore: store, query }),
                }
            );
            const json = await resp.json().catch(() => ({}));
            if (resp.ok && json && json.success) {
                resultsPre.textContent = this._renderSearchResults(json.data || {});
            } else {
                resultsPre.textContent = (json && json.error) ? json.error : `Search failed (HTTP ${resp.status}).`;
            }
        } catch (e) {
            resultsPre.textContent = 'Search failed: ' + (e?.message || String(e));
        }
    }

    /** Format find results for the Search panel. */
    _renderSearchResults(data) {
        const results = Array.isArray(data.results) ? data.results : [];
        const q = data.query || '';
        if (!results.length) return `No matches for “${q}”.`;
        const hasScores = results.some(r => typeof r.score === 'number');
        const out = [`${results.length} result(s) for “${q}”${hasScores ? ' (score = similarity)' : ''}:\n`];
        results.forEach((r, i) => {
            const score = (typeof r.score === 'number') ? `${r.score.toFixed(3)}  ` : '';
            const src = r.source ? `[${String(r.source).split('/').pop()}] ` : '';
            const text = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
            out.push(`▸ ${i + 1}. ${score}${src}`, text, '');
        });
        return out.join('\n');
    }

    /**
     * Run the ingestion interpreter from the ▶ Start node — the CLOSED event
     * loop. The backend enumerates the source ONCE and loops loader→split→store
     * itself (the store's completion clocks the loader to the next file: true
     * backpressure, no browser cursor, no re-enumeration). We just open the SSE
     * stream and reflect its events live — node glow + per-file logs.
     */
    async _runIngestionFromStart() {
        if (!this.currentWorkflowId) { alert(this.t('workflow.messages.saveFirst')); return; }
        const nodes = this.editor.drawflow.drawflow.Home.data || {};
        const idByType = {};
        let loaderCfg = null, splitterCfg = null, storeCfg = null;
        for (const id of Object.keys(nodes)) {
            const d = nodes[id].data || {};
            if (d.config && d.config.disabled) continue;   // disabled nodes are excluded from the pipeline
            const nt = d.node_type;
            if (nt === 'loader' && !idByType.loader) { idByType.loader = id; loaderCfg = d.config || {}; }
            if (nt === 'splitter' && !idByType.splitter) { idByType.splitter = id; splitterCfg = d.config || {}; }
            if (nt === 'vectorstore' && !idByType.vectorstore) { idByType.vectorstore = id; storeCfg = d.config || {}; }
        }
        if (!idByType.loader) { this.showToast?.('No loader node in this pipeline.', 'error'); return; }
        if (!loaderCfg.path) { this.showToast?.('Open the loader and pick a Source (Browse storage…), then Save before running.', 'error'); return; }
        if (idByType.vectorstore && !String(storeCfg.store || '').startsWith('mcp:')) {
            this.showToast?.('The store node needs a vector-DB MCP server selected — open it and pick one, then Save.', 'error'); return;
        }

        // Reset glow on the wired nodes; the SSE events will drive it from here.
        const glow = (type, state) => {
            const id = idByType[type];
            if (!id) return;
            const el = document.getElementById('node-' + id);
            if (!el) return;
            el.classList.remove('node-active', 'node-completed', 'node-error');
            el.classList.add(state === 'active' ? 'node-active' : state === 'done' ? 'node-completed' : 'node-error');
        };
        for (const t of Object.keys(idByType)) {
            const el = document.getElementById('node-' + idByType[t]);
            if (el) el.classList.remove('node-completed', 'node-error', 'node-active');
        }

        const body = { loader: loaderCfg };
        if (idByType.splitter) body.splitter = splitterCfg || {};
        if (idByType.vectorstore) body.vectorstore = storeCfg || {};
        const glowAll = (state) => { for (const t of Object.keys(idByType)) glow(t, state); };

        try {
            // 1. Enumerate once + create the shared run (cursor on disk).
            const startResp = await fetch(
                `${this.apiBase}/workflows/${this.currentWorkflowId}/ingestion/run-start`,
                { method: 'POST', headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) }
            );
            const startJson = await startResp.json().catch(() => ({}));
            if (!startResp.ok || !startJson.success) throw new Error((startJson && startJson.error) || `run-start HTTP ${startResp.status}`);
            const runId = startJson.data?.run_id;
            const count = startJson.data?.count || 0;
            if (!runId || count === 0) {
                this.showToast?.('No matching files — check the Source and the File-types filter.', 'error');
                return;
            }

            // 2. Open K concurrent worker streams (true multi-core — each is a
            //    separate PHP process pulling files from the shared cursor).
            //    K = the loader's "Parallel workers" field, or auto (~CPU cores).
            const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
            const declared = parseInt(loaderCfg.workers, 10);
            const wanted = Number.isFinite(declared) && declared > 0 ? declared : Math.min(cores, 8);
            const K = Math.max(1, Math.min(count, wanted));
            glowAll('active');
            this.showToast?.(`Ingesting ${count} file(s) across ${K} parallel worker(s)…`, 'info');

            const totals = { files: 0, chunks: 0, stored: 0, errors: 0 };
            let wrote = false;
            const workerErrors = [];
            const onEvent = (ev) => {
                if (ev.type === 'log') this._appendIngestionLogs(ev.lines);
                else if (ev.type === 'done') {
                    totals.files += ev.files || 0; totals.chunks += ev.chunks || 0;
                    totals.stored += ev.stored || 0; totals.errors += ev.errors || 0;
                    wrote = wrote || !!ev.wrote;
                } else if (ev.type === 'error') {
                    workerErrors.push(ev.error || 'worker error');
                }
            };
            const workers = [];
            for (let k = 0; k < K; k++) workers.push(this._streamIngestionWorker(runId, onEvent));
            await Promise.all(workers);

            if (totals.files === 0 && workerErrors.length) {
                glowAll('error');
                this.showToast?.(workerErrors[0], 'error');
                return;
            }
            glowAll('done');
            let msg;
            if (wrote) {
                msg = `Ingested: ${totals.files} file(s) → ${totals.chunks.toLocaleString()} chunk(s) → ${totals.stored.toLocaleString()} stored${totals.errors ? `, ${totals.errors} error(s)` : ''} · ${K} workers.`;
            } else if (idByType.splitter) {
                msg = `Run: ${totals.files} file(s) → ${totals.chunks.toLocaleString()} chunk(s)${totals.errors ? `, ${totals.errors} error(s)` : ''} · ${K} workers. Add a store node to ingest.`;
            } else {
                msg = `Loader run: ${totals.files} file(s) read${totals.errors ? `, ${totals.errors} error(s)` : ''} · ${K} workers.`;
            }
            this.showToast?.(msg, (totals.errors && !totals.files) ? 'error' : 'success');
        } catch (e) {
            glowAll('error');
            this.showToast?.('Run failed: ' + (e?.message || String(e)), 'error');
        }
    }

    /** Open ONE worker SSE stream (run-worker), dispatching each event to onEvent. */
    async _streamIngestionWorker(runId, onEvent) {
        const resp = await fetch(
            `${this.apiBase}/workflows/${this.currentWorkflowId}/ingestion/run-worker`,
            {
                method: 'POST',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                credentials: 'include',
                body: JSON.stringify({ run_id: runId }),
            }
        );
        if (!resp.ok || !resp.body) throw new Error(`worker HTTP ${resp.status}`);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '' || data === '[DONE]') continue;
                let ev; try { ev = JSON.parse(data); } catch (_) { continue; }
                try { onEvent(ev); } catch (_) { /* ignore */ }
            }
        }
    }

    /** Render one round (one file's extracted text) for the Output panel. */
    _renderLoaderRound(data) {
        const count = data.count || 0;
        if (count === 0) {
            return 'No matching files found — check the Source and the File-types filter.';
        }
        const c = data.current;
        if (!c) return 'No more files.';
        if (c.error) return `── ${c.source} [ERROR] ──\n⚠️ ${c.error}`;
        const hdr = `── ${c.source} (${c.type}, ${c.chars} chars${c.clipped ? ', clipped' : ''}) ──`;
        return `${hdr}\n${c.text}`;
    }

    /** Render one round (one file's chunks) for the splitter Output panel. */
    _renderSplitterRound(data) {
        const count = data.count || 0;
        if (count === 0) return 'No matching files found — check the loader’s Source and File-types.';
        const c = data.current;
        if (!c) return 'No more files.';
        if (c.error) return `── ${c.source} [ERROR] ──\n⚠️ ${c.error}`;
        const chunks = Array.isArray(c.chunks) ? c.chunks : [];
        const out = [`── ${c.source} (${c.type}) → ${c.chunk_count} chunk(s) ──\n`];
        chunks.forEach((ch, i) => {
            out.push(`▸ chunk ${i + 1} (${ch.chars} chars${ch.clipped ? ', clipped' : ''})`, ch.text, '');
        });
        if (c.truncated) out.push(`… ${c.chunk_count - chunks.length} more chunk(s) not shown.`);
        return out.join('\n');
    }

    /** Render one round of the store node's write PREVIEW (no write). */
    _renderStoreRound(data, store) {
        const count = data.count || 0;
        if (count === 0) return 'No matching files — check the loader’s Source and File-types.';
        const c = data.current;
        if (!c) return 'No more files.';
        if (c.error) return `── ${c.source} [ERROR] ──\n⚠️ ${c.error}`;
        const coll = (store && store.collection) ? store.collection : '(server default)';
        const server = (store && String(store.store || '').startsWith('mcp:')) ? store.store : '(none)';
        return `── ${c.source} (${c.type}) ──\n`
            + `Will store ${c.chunk_count} chunk(s) → collection "${coll}" on ${server}.\n\n`
            + `Preview only — click ▶ Start on the Start node to embed + write all files.`;
    }

    /** Sync the round toolbar (file k of N + Prev/Next enabled state). */
    _updateRoundBar(data) {
        const info = document.getElementById('ingestion-round-info');
        const prevBtn = document.getElementById('ingestion-round-prev');
        const nextBtn = document.getElementById('ingestion-round-next');
        const count = data.count || 0;
        const cursor = data.cursor || 0;
        if (info) info.textContent = count ? `File ${cursor + 1} of ${count}` : 'No files';
        if (prevBtn) prevBtn.disabled = cursor <= 0;
        if (nextBtn) nextBtn.disabled = count === 0 || cursor >= count - 1;
    }

    /**
     * Read an ingestion node's CURRENT form-field values into a config object so
     * the Output reflects unsaved edits (change the document type → code updates).
     * Falls back to the saved config for fields/node-types not yet wired.
     */
    _readIngestionFormConfig(nodeType, fallback = {}) {
        const val = (id, def) => { const el = document.getElementById(id); return el ? el.value : def; };
        const num = (id, def) => { const el = document.getElementById(id); const n = el ? parseInt(el.value, 10) : NaN; return Number.isFinite(n) ? n : def; };
        const disEl = document.getElementById('ingestion-node-disabled');
        const disabled = disEl ? disEl.checked : !!fallback.disabled;
        if (nodeType === 'loader') {
            const pEl = document.getElementById('ingestion-loader-path');
            // File-type FILTER: the checked formats. [] = no restriction (all
            // supported). Read from the checkboxes; fall back to the saved set.
            const typeBoxes = document.querySelectorAll('.ingestion-loader-type');
            const types = typeBoxes.length
                ? Array.from(typeBoxes).filter(c => c.checked).map(c => c.value)
                : (Array.isArray(fallback.types) ? fallback.types : []);
            // Parallel workers: blank = auto. Read defensively; clamp 1..32.
            const wEl = document.getElementById('ingestion-loader-workers');
            let workers = '';
            if (wEl) {
                const w = parseInt(wEl.value, 10);
                workers = (wEl.value.trim() !== '' && Number.isFinite(w)) ? Math.max(1, Math.min(32, w)) : '';
            } else if (fallback.workers != null) {
                workers = fallback.workers;
            }
            const cfg = {
                types,
                path: (val('ingestion-loader-path', fallback.path || '') || '').trim(),
                is_dir: pEl ? pEl.dataset.isDir === '1' : !!fallback.is_dir,
                workers,
                disabled,
            };
            // File-storage MCP selection (provider-selection UI; read defensively).
            const storageEl = document.getElementById('ingestion-loader-storage');
            if (storageEl) {
                const id = (storageEl.value || '').trim();
                cfg.storage_mcp_id = id || (fallback.storage_mcp_id || '');
                // For a <select>, the URL/name live on the chosen <option>; for the
                // single-server hidden input they live in data-* on the input itself.
                let url = '';
                if (storageEl.tagName === 'SELECT') {
                    const opt = storageEl.options[storageEl.selectedIndex];
                    url = opt ? (opt.dataset.url || '') : '';
                } else {
                    url = storageEl.dataset.url || '';
                }
                cfg.storage_mcp_url = url || (fallback.storage_mcp_url || '');
            } else {
                if (fallback.storage_mcp_id != null) cfg.storage_mcp_id = fallback.storage_mcp_id;
                if (fallback.storage_mcp_url != null) cfg.storage_mcp_url = fallback.storage_mcp_url;
            }
            // Provider from the checked radio.
            const provEl = document.querySelector('input[name="ingestion-loader-provider"]:checked');
            cfg.provider = provEl ? provEl.value : (fallback.provider || 'local');
            // UniversalFS key — include only when non-empty.
            const keyEl = document.getElementById('ingestion-loader-ufskey');
            const keyVal = keyEl ? (keyEl.value || '').trim() : (fallback.ufskey || '');
            if (keyVal) cfg.ufskey = keyVal;
            return cfg;
        }
        if (nodeType === 'splitter') {
            return {
                strategy: val('ingestion-splitter-strategy', fallback.strategy || 'recursive'),
                chunk_size: num('ingestion-splitter-chunk', fallback.chunk_size ?? 1000),
                overlap: num('ingestion-splitter-overlap', fallback.overlap ?? 150),
                disabled,
            };
        }
        if (nodeType === 'vectorstore') {
            const storeEl = document.getElementById('ingestion-vs-store');
            const store = storeEl ? (storeEl.value || '') : (fallback.store || '');
            const provEl = document.querySelector('input[name="ingestion-vs-provider"]:checked');
            const provider = provEl ? provEl.value : (fallback.provider || '');
            const connection = document.getElementById('ingestion-vs-connection-host')
                ? this._readStoreConnection()
                : (fallback.connection || {});
            const embWrap = document.getElementById('ingestion-vs-embeddings-wrap');
            const embSel = document.getElementById('ingestion-vs-embedding');
            const embedding = (embWrap && embWrap.style.display !== 'none' && embSel)
                ? (embSel.value || '')
                : (fallback.embedding || '');
            return {
                store,
                provider,
                connection,
                embedding,
                collection: (val('ingestion-vs-collection', fallback.collection || '') || '').trim(),
                disabled,
            };
        }
        return fallback;
    }

    /**
     * Build the ORDERED ingestion stages (start → … → target) so the backend can
     * compute the cumulative Input/Output. The target's config is read LIVE from
     * its form; upstream stages use their saved canvas config (their forms aren't
     * open). Start carries no config (it's the common header).
     */
    _gatherIngestionStages(targetType, targetConfig) {
        const data = this.editor.drawflow?.drawflow?.Home?.data || {};
        const cfgByType = {};
        for (const id in data) {
            const nt = data[id]?.data?.node_type;
            if (['loader', 'splitter', 'vectorstore'].includes(nt)) cfgByType[nt] = data[id].data.config || {};
        }
        const order = ['start', 'loader', 'splitter', 'vectorstore'];
        const targetIdx = order.indexOf(targetType);
        const stages = [];
        for (let i = 0; i <= targetIdx; i++) {
            const kind = order[i];
            if (kind === 'start') { stages.push({ node_type: 'start', config: {} }); continue; }
            const config = (kind === targetType) ? targetConfig : (cfgByType[kind] || {});
            stages.push({ node_type: kind, config });
        }
        return stages;
    }

    /**
     * Debounced auto-save triggered ONLY by structure changes (nodes/links added
     * or removed) on an existing ingestion workflow. Parameter edits (the node
     * forms) never trigger this — the generated code reads them live. Suppressed
     * while a graph is being imported from storage.
     */
    _scheduleStructureSave() {
        if (!this.currentWorkflowId || this._suppressAutoSave) return;
        if (!this._isIngestionWorkflow()) return;
        clearTimeout(this._structureSaveTimer);
        this._structureSaveTimer = setTimeout(() => { this.saveWorkflow(); }, 800);
    }

    /**
     * Add a Start node (user input trigger)
     */
    addStartNode(x, y) {
        // Use the full template (it includes the ▶ play button and picks the
        // agent vs ingestion variant). Previously this was a stripped-down
        // version without the play button.
        const html = this.createStartNodeHtml();

        // Start node: 0 inputs, 1 output
        this.editor.addNode('start', 0, 1, x, y, 'start', { type: 'start', documents: [] }, html);
    }

    /**
     * Add an Output node (final response)
     */
    addOutputNode(x, y) {
        // Use the full template so a freshly-dropped output node already has its
        // actions (storage + the langGraph/compile menu + view-json). This was
        // previously a stripped-down header+body, which is why a just-dragged
        // output node showed no compile button until something re-rendered it.
        // createOutputNodeHtml() also picks the agent vs ingestion variant.
        const html = this.createOutputNodeHtml();

        // Output node: 1 input, 0 outputs
        this.editor.addNode('output', 1, 0, x, y, 'output', { type: 'output' }, html);
    }

    /**
     * Add an Agent node
     */
    addAgentNode(x, y, agentId, agentName, agentType, agentProvider = '', agentTools = null) {
        const typeIcon = agentType === 'worker' ? '⚙️' : '🤖';
        const providerDisplay = agentProvider ? `<span class="node-provider">${this.escapeHtml(agentProvider)}</span>` : '';

        const html = `
            <div class="workflow-node agent-node ${agentType}" data-accepts-documents="true">
                <div class="node-header">
                    <span class="node-icon">${typeIcon}</span>
                    <span class="node-title">${this.escapeHtml(agentName)}</span>
                </div>
                <div class="node-body">
                    <span class="node-timer">0:00</span>
                    ${providerDisplay}
                </div>
                <div class="node-documents-zone">
                    <div class="documents-list"></div>
                    <div class="documents-drop-hint">📎 ${this.t('workflow.documents.dropHint') || 'Drop files or click to attach'}</div>
                </div>
            </div>
        `;

        // Agent node: 1 input, 1 output (multiple connections to same input are merged automatically)
        this.editor.addNode(
            `agent_${agentId}`,
            1, // inputs
            1, // outputs
            x, y,
            'agent',
            {
                type: 'agent',
                agent_id: parseInt(agentId),
                agent_name: agentName,
                agent_type: agentType,
                agent_provider: agentProvider,
                tools: agentTools || [],
                documents: []
            },
            html
        );
    }

    /**
     * Add a new Agent template to the panel
     */
    addAgentTemplate() {
        // Create a temporary agent object in the local list
        if (!this.agentTemplates) {
            this.agentTemplates = [{ id: 'new-agent-1', templateNum: 1 }];
        }

        // Get next template number
        const nextNum = this.agentTemplates.length + 1;

        const newId = `new-agent-${Date.now()}`;
        this.agentTemplates.push({
            id: newId,
            templateNum: nextNum
        });

        this.renderAgentTemplates();
    }

    /**
     * Render agent templates in the panel
     */
    renderAgentTemplates() {
        const container = this.agentsPanel?.querySelector('.workflow-section-content[data-section="agents"]');
        if (!container) return;

        // Get existing workflow agents (same filter as renderAgentsPanel)
        const workflowAgents = this.agents?.filter(a =>
            a.agent_type?.toLowerCase() !== 'manager'
        ) || [];

        // Combine real agents with templates
        const allAgents = [...workflowAgents];
        const templates = this.agentTemplates || [];

        // Update count
        const countEl = container.closest('.workflow-section')?.querySelector('.section-count');
        if (countEl) countEl.textContent = templates.length;

        // Specific saved agents now live in the left sidebar's Agents list
        // (drag-to-canvas); this section shows only the draggable Agent Template(s).
        let agentsHtml = '';

        // Add templates HTML (translate at render time for i18n support)
        agentsHtml += templates.map(template => {
            const name = `${this.t('agentTeams.newTemplate')} ${template.templateNum}`;
            const type = this.t('agentTeams.templateDesc');
            return `
                <div class="workflow-agent-card template"
                     draggable="true"
                     data-template-id="${template.id}"
                     data-node-type="agent-template">
                    <div class="agent-icon">🤖</div>
                    <div class="agent-info">
                        <div class="agent-name">${this.escapeHtml(name)}</div>
                        <div class="agent-type">${this.escapeHtml(type)}</div>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = agentsHtml;

        // Re-attach drag events
        container.querySelectorAll('.workflow-agent-card').forEach(card => {
            card.addEventListener('dragstart', (e) => this.onDragStart(e, card));
            card.addEventListener('dragend', (e) => this.onDragEnd(e, card));
        });

        // Re-attach edit button events
        container.querySelectorAll('.agent-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const agentId = btn.dataset.agentId;
                this.showAgentEditForm(agentId);
            });
        });
    }

    /**
     * Export workflow to graph format for backend API
     */
    exportWorkflow() {
        const data = this.editor.export();
        const drawflowNodes = data.drawflow?.Home?.data || {};

        const nodes = [];
        const edges = [];

        Object.entries(drawflowNodes).forEach(([id, node]) => {
            console.log(`[WorkflowEditor] Exporting node ${id} - node.data:`, JSON.stringify(node.data));
            console.log(`[WorkflowEditor] Exporting node ${id} - node.data.type:`, node.data?.type);
            // Extract node info in backend format
            // Ingestion component nodes carry their specific type in
            // node.data.node_type ('loader'/'splitter'/'vectorstore') and their
            // real config in node.data.config — export those directly so the DSL
            // the engine reads has the right node_type + config (not the
            // 'ingestion' group tag, and not the config nested one level deep).
            const isIngestion = node.data?.type === 'ingestion';
            const resolvedType = isIngestion
                ? (node.data?.node_type || 'ingestion')
                : (node.data?.type || 'agent');
            const nodeExport = {
                id: id,
                node_type: resolvedType,
                type: resolvedType, // For validation
                agent_id: node.data?.agent_id || null,
                agent_name: node.data?.agent_name || null,
                config: isIngestion
                    ? { ...(node.data?.config || {}) }
                    : {
                        agent_type: node.data?.agent_type || null,
                        ...node.data,
                        // Hoist disabled explicitly so JSON.stringify never drops it
                        // (undefined values in a spread are omitted by JSON.stringify).
                        disabled: node.data?.disabled ?? false
                    },
                position: { x: node.pos_x, y: node.pos_y },
                pos_x: node.pos_x,
                pos_y: node.pos_y
            };
            console.log(`[WorkflowEditor] Node ${id} exported as:`, nodeExport);
            nodes.push(nodeExport);

            // Extract connections (edges)
            Object.values(node.outputs || {}).forEach(output => {
                (output.connections || []).forEach(conn => {
                    edges.push({
                        from: id,
                        to: conn.node,
                        from_port: 'output_1',
                        to_port: conn.input
                    });
                });
            });
        });

        return {
            nodes,
            edges,
            raw: data // Include raw Drawflow data for reimporting
        };
    }

    /**
     * Export workflow in legacy steps format (for validation)
     */
    exportWorkflowSteps() {
        const { nodes, edges } = this.exportWorkflow();

        // Convert to steps format for validation
        const steps = nodes.map(node => ({
            id: node.id,
            type: node.node_type,
            agent_id: node.agent_id
        }));

        return { steps, edges };
    }

    /**
     * Import workflow from JSON
     */
    importWorkflow(workflowData) {
        // Clear previous results and prompt when loading a new workflow
        this.lastWorkflowResults = null;
        this.lastUserPrompt = '';

        if (workflowData.raw) {
            // Import from raw Drawflow format
            this.editor.import(workflowData.raw);
            // Apply connection styles after import
            this.styleConnections();
            // Reset node indicators
            this.updateOutputNodeIndicator(false);
            this.updateStartNodeIndicator(false);
        } else {
            // TODO: Import from simplified format
            console.warn('[WorkflowEditor] Simplified import not yet implemented');
        }
    }

    /**
     * Translate a key with a hard fallback. `this.t()` returns the key
     * (or the last segment of the key) when no translation is found,
     * which means a plain `||` fallback never fires because the result
     * is always truthy. This helper detects the unresolved case and
     * substitutes the provided fallback string. Supports {{name}}-style
     * placeholder interpolation in both the translated value and the
     * fallback string.
     */
    tWithFallback(key, fallback, params = {}) {
        const value = this.t(key, params);
        const interpolate = (str) =>
            str.replace(/\{\{(\w+)\}\}/g, (m, p) => params[p] !== undefined ? params[p] : m);

        if (!value) return interpolate(fallback);
        // Unresolved key cases: full key returned, or last segment returned
        if (value === key) return interpolate(fallback);
        if (value === key.split('.').pop()) return interpolate(fallback);
        return value;
    }

    /**
     * Persist the workflow to the backend if it has already been saved
     * (i.e. has a currentWorkflowId). Used by node-config modals so that
     * clicking "Save" inside a node form actually persists the change to
     * the backend, not just to local Drawflow state. Skipped silently for
     * new unsaved workflows so the user is not prompted for a workflow
     * name from inside a node modal — that prompt belongs to the main
     * Save Workflow button.
     *
     * Surfaces a brief toast on success/failure so the user gets visible
     * confirmation that the change actually reached the backend.
     */
    autoPersistWorkflow() {
        if (!this.currentWorkflowId) {
            console.log('[WorkflowEditor] autoPersistWorkflow skipped: no currentWorkflowId (workflow not yet saved)');
            this.showToast(
                this.tWithFallback('workflow.messages.changesPendingSave', 'Click Save Workflow to persist your changes'),
                'info'
            );
            return;
        }
        this.saveWorkflow()
            .then(() => {
                this.showToast(
                    this.tWithFallback('workflow.messages.autoSaved', 'Workflow saved'),
                    'success'
                );
            })
            .catch(err => {
                console.error('[WorkflowEditor] autoPersistWorkflow failed:', err);
                this.showToast(
                    this.tWithFallback('workflow.messages.autoSaveFailed', 'Auto-save failed — use Save Workflow to retry'),
                    'error'
                );
            });
    }

    /**
     * Save workflow to backend
     */
    async saveWorkflow() {
        console.log('[WorkflowEditor] saveWorkflow called - currentWorkflowId:', this.currentWorkflowId, 'currentWorkflowName:', this.currentWorkflowName);

        // For audio workflows: stamp the selected LLM provider onto the
        // realtime-start node's config so it survives in the persisted graph.
        if (this.runtimeMode === 'realtime') {
            this._stampProviderOnStartNode();
        }

        const workflow = this.exportWorkflow();

        // Resolve the name for a new workflow. Prefer the name already typed in
        // the metadata form (#workflow-name-input) so we don't re-prompt for a
        // name the user just entered there; only fall back to prompt() when the
        // form name is empty too.
        let workflowName = this.currentWorkflowName || '';
        if (!this.currentWorkflowId) {
            const nameInput = document.getElementById('workflow-name-input');
            const formName = nameInput ? (nameInput.value || '').trim() : '';
            if (formName) {
                workflowName = formName;
            } else {
                workflowName = prompt(this.t('workflow.dialogs.promptWorkflowName'), this.t('workflow.dialogs.defaultWorkflowName'));
                if (!workflowName) return;
            }
        }

        try {
            const method = this.currentWorkflowId ? 'PUT' : 'POST';
            const url = this.currentWorkflowId
                ? `${this.apiBase}/workflows/${this.currentWorkflowId}`
                : `${this.apiBase}/workflows`;

            const payload = {
                name: workflowName || this.currentWorkflowName || 'My Workflow',
                description: this.currentWorkflowDescription || '',
                definition: {
                    runtime_mode: this.runtimeMode || 'batch',
                    llm_provider: this.runtimeMode === 'realtime' ? (this.audioLlmProvider || 'grok') : undefined,
                    nodes: workflow.nodes,
                    edges: workflow.edges
                },
                triggers: {
                    schedule: {
                        enabled: this.scheduleEnabled
                    }
                },
                output_storage_enabled: this.outputStorageEnabled ? 1 : 0,
                output_folder: this.outputFolder || null
            };

            console.log('[WorkflowEditor] Saving workflow with payload:', payload);
            console.log('[WorkflowEditor] Nodes to save:', workflow.nodes.length);
            console.log('[WorkflowEditor] Edges to save:', workflow.edges.length);

            const response = await fetch(url, {
                method,
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                // Include validation errors in the message if available
                let errorMsg = errorData.error || 'Failed to save workflow';
                if (errorData.validation_errors && errorData.validation_errors.length > 0) {
                    errorMsg += ':\n- ' + errorData.validation_errors.join('\n- ');
                }
                throw new Error(errorMsg);
            }

            const data = await response.json();
            console.log('[WorkflowEditor] Save response:', data);

            const savedWorkflowId = data.data?.id || data.id;
            this.currentWorkflowName = data.data?.name || workflowName;

            console.log('[WorkflowEditor] Workflow saved with ID:', savedWorkflowId, 'Name:', this.currentWorkflowName);

            // Refresh the workflows list
            console.log('[WorkflowEditor] Refreshing workflows list...');
            await this.loadWorkflowsList();
            console.log('[WorkflowEditor] Workflows list refreshed, count:', this.workflows.length);

            // Reload the workflow to get proper node IDs from database
            // This ensures nodes have db_node_id set for document operations
            await this.loadWorkflow(savedWorkflowId);

            this.showToast(
                this.tWithFallback('workflow.messages.saved', 'Workflow saved successfully!'),
                'success'
            );

        } catch (error) {
            console.error('[WorkflowEditor] Error saving workflow:', error);
            alert(this.t('workflow.errors.saveWorkflowFailed', { error: error.message }));
        }
    }

    /**
     * Save workflow as a new workflow (Save As)
     */
    async saveWorkflowAs() {
        const workflow = this.exportWorkflow();

        // Always prompt for a new name
        const defaultName = this.currentWorkflowName ? `${this.currentWorkflowName} (copy)` : 'My Workflow';
        const workflowName = prompt(this.t('workflow.dialogs.promptNewWorkflowName'), defaultName);
        if (!workflowName) return;

        try {
            // Always POST to create a new workflow
            const url = `${this.apiBase}/workflows`;

            const payload = {
                name: workflowName,
                description: this.currentWorkflowDescription || '',
                definition: {
                    runtime_mode: this.runtimeMode || 'batch',
                    llm_provider: this.runtimeMode === 'realtime' ? (this.audioLlmProvider || 'grok') : undefined,
                    nodes: workflow.nodes,
                    edges: workflow.edges
                },
                triggers: {
                    schedule: {
                        enabled: this.scheduleEnabled
                    }
                },
                output_storage_enabled: this.outputStorageEnabled ? 1 : 0,
                output_folder: this.outputFolder || null
            };

            console.log('[WorkflowEditor] Saving workflow as new with payload:', payload);

            const response = await fetch(url, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to save workflow');
            }

            const data = await response.json();
            console.log('[WorkflowEditor] Save As response:', data);

            const savedWorkflowId = data.data?.id || data.id;

            console.log('[WorkflowEditor] New workflow created with ID:', savedWorkflowId, 'Name:', workflowName);

            // Refresh the workflows list
            await this.loadWorkflowsList();

            // Reload the workflow to get proper node IDs from database
            // This ensures nodes have db_node_id set for document operations
            await this.loadWorkflow(savedWorkflowId);

            this.showToast(
                this.tWithFallback(
                    'workflow.messages.savedAs',
                    'Workflow saved as "{{name}}" successfully!',
                    { name: workflowName }
                ),
                'success'
            );

        } catch (error) {
            console.error('[WorkflowEditor] Error saving workflow as:', error);
            alert(this.t('workflow.errors.saveWorkflowFailed', { error: error.message }));
        }
    }

    /**
     * Load a workflow from backend
     */
    async loadWorkflow(workflowId) {
        try {
            console.log('[WorkflowEditor] Loading workflow ID:', workflowId);
            // Add cache-busting parameter to prevent stale data
            const response = await fetch(`${this.apiBase}/workflows/${workflowId}?_=${Date.now()}`, {
                headers: this.getAuthHeaders(),
                cache: 'no-store'
            });

            if (!response.ok) throw new Error('Failed to load workflow');

            const data = await response.json();
            const workflowData = data.data || data;

            console.log('[WorkflowEditor] Loaded workflow data:', workflowData);
            console.log('[WorkflowEditor] workflowData.id:', workflowData.id, 'workflowData.name:', workflowData.name);
            console.log('[WorkflowEditor] Graph data:', workflowData.graph);
            console.log('[WorkflowEditor] Has graph nodes:', workflowData.graph?.nodes?.length || 0);

            // Clear current canvas FIRST (this resets currentWorkflowId)
            this.clearWorkflow(true);

            // Clear the node ID mapping for SSE highlighting
            this.dbNodeToDrawflowMap = {};

            // Set current workflow info AFTER clear
            this.currentWorkflowId = workflowData.id;
            this.currentWorkflowName = workflowData.name;
            this.currentWorkflowDescription = workflowData.description || '';

            // Restore runtime mode (batch vs realtime audio) so the right sidebar
            // palette and canvas styling match the loaded workflow type. The
            // runtime_mode isn't stored at the workflow level, so infer it from
            // the presence of realtime-* node types (or a legacy runtime_mode flag
            // on the start node's config).
            const graphNodes = workflowData.graph?.nodes || [];
            const isRealtime = workflowData.runtime_mode === 'realtime'
                || graphNodes.some(n => {
                    const t = n.type || n.node_type || n.config?.type || '';
                    return typeof t === 'string' && t.startsWith('realtime-');
                })
                || graphNodes.some(n => n.config?.runtime_mode === 'realtime');
            this.runtimeMode = isRealtime ? 'realtime' : 'batch';
            // Restore the audio workflow's LLM provider. Prefer the value
            // persisted on the realtime-start node's config; fall back to
            // top-level / definition fields or default to grok.
            if (isRealtime) {
                const startNode = graphNodes.find(n => {
                    const t = n.type || n.node_type || n.config?.type || '';
                    return t === 'realtime-start';
                });
                this.audioLlmProvider = startNode?.config?.provider
                    || workflowData.llm_provider
                    || workflowData.definition?.llm_provider
                    || 'grok';
            }
            this.updateConnectorStyleForMode();
            this.renderAgentsPanel();
            const infoBoxEl = document.getElementById('workflow-info-box');
            if (infoBoxEl) infoBoxEl.style.display = isRealtime ? 'none' : '';
            const audioInfoBoxEl = document.getElementById('audio-workflow-info-box');
            if (audioInfoBoxEl) audioInfoBoxEl.style.display = isRealtime ? '' : 'none';
            // Recalling an existing workflow: keep the settings form collapsed
            // immediately (skip the show-then-collapse animation used for new workflows).
            if (this._formAutoCollapseTimer) {
                clearTimeout(this._formAutoCollapseTimer);
                this._formAutoCollapseTimer = null;
            }
            const activeInfoBox = isRealtime ? audioInfoBoxEl : infoBoxEl;
            if (activeInfoBox) activeInfoBox.classList.add('collapsed');

            // Update the workflow info box
            this.updateWorkflowInfoBox();

            // Load output storage settings
            this.outputStorageEnabled = !!workflowData.output_storage_enabled;
            this.outputFolder = workflowData.output_folder || '';

            // Load schedule enabled setting (from triggers or computed field)
            this.scheduleEnabled = !!workflowData.schedule_enabled ||
                                   !!(workflowData.triggers?.schedule?.enabled);
            this.updateWorkflowInfoBox(); // Refresh to show schedule toggle state

            console.log('[WorkflowEditor] After setting - currentWorkflowId:', this.currentWorkflowId, 'currentWorkflowName:', this.currentWorkflowName);
            console.log('[WorkflowEditor] Output storage enabled:', this.outputStorageEnabled, 'folder:', this.outputFolder);
            console.log('[WorkflowEditor] Schedule enabled:', this.scheduleEnabled);

            // Import graph if available
            if (workflowData.graph && workflowData.graph.nodes && workflowData.graph.nodes.length > 0) {
                console.log('[WorkflowEditor] Importing graph with', workflowData.graph.nodes.length, 'nodes');
                this.importGraphFromBackend(workflowData.graph);

                // Restore prompt from start node if saved
                this.restorePromptFromStartNode(workflowData.graph.nodes);
            } else if (workflowData.raw) {
                // Legacy: import raw Drawflow data
                console.log('[WorkflowEditor] Importing legacy raw Drawflow data');
                this.editor.import(workflowData.raw);
            } else {
                // No graph data - workflow was created before graph feature
                console.log('[WorkflowEditor] No graph data found for workflow. Workflow may need to be re-created.');
                alert(this.t('workflow.errors.noGraphData'));
            }

            // Update left panel to show active workflow
            this.renderSavedWorkflowsList();

            // Hide the help overlay since we have a workflow loaded
            this.hideHelpOverlay();

            // Auto-collapse the workflow settings box to give more space to the canvas
            // User has already seen the full form; the chevron indicates it can be re-expanded
            const infoBox = document.getElementById('workflow-info-box');
            if (infoBox) {
                infoBox.classList.add('collapsed');
            }

            // Load any existing schedule for this workflow
            await this.loadWorkflowSchedule(workflowId);

            // Restore local folder handle for this workflow
            await this.restoreLocalFolderForWorkflow(workflowId);

            console.log('[WorkflowEditor] Workflow loaded:', this.currentWorkflowName);

        } catch (error) {
            console.error('[WorkflowEditor] Error loading workflow:', error);
            alert(this.t('workflow.errors.loadWorkflowFailed', { error: error.message }));
        }
    }

    /**
     * Import graph data from backend format
     */
    importGraphFromBackend(graph) {
        console.log('[WorkflowEditor] importGraphFromBackend called with:', graph);

        // Suppress structure auto-save while loading from storage — the node/
        // connection events fired below are not user edits. Cleared after the
        // synchronous import (and its events) settle.
        this._suppressAutoSave = true;
        setTimeout(() => { this._suppressAutoSave = false; }, 0);

        const { nodes, edges } = graph;

        if (!nodes || nodes.length === 0) {
            console.warn('[WorkflowEditor] No nodes to import');
            return;
        }

        console.log('[WorkflowEditor] Importing', nodes.length, 'nodes and', edges?.length || 0, 'edges');

        // Create a map of old IDs to new Drawflow IDs
        const idMap = {};

        // Create a map of database node IDs to Drawflow IDs (for SSE highlighting)
        this.dbNodeToDrawflowMap = {};

        // First, add all nodes
        nodes.forEach((node, index) => {
            try {
                // Get type from multiple possible sources (backend may send in different places)
                let type = node.type || node.node_type || node.config?.type || 'agent';
                // Legacy audio workflows saved agent nodes with type='agent' and
                // runtime_mode='realtime' in config. Normalize to 'realtime-agent'
                // so the realtime HTML (and edit form) is used.
                if (type === 'agent' && node.config?.runtime_mode === 'realtime') {
                    type = 'realtime-agent';
                }
                console.log(`[WorkflowEditor] Adding node ${index}:`, type, node);

                let html, inputs, outputs;

                switch (type) {
                    case 'loader':
                    case 'splitter':
                    case 'vectorstore': {
                        // Ingestion nodes manage their own addNode() call (custom
                        // HTML + config modal), so they don't flow through the
                        // shared addNode path below. Recreate from saved config,
                        // register the id mappings exactly like the shared path,
                        // then skip the rest of this iteration.
                        const x = node.position?.x || node.pos_x || 100;
                        const y = node.position?.y || node.pos_y || 100;
                        const dbNodeId = node.db_id || node.id;
                        const drawflowId = this.addIngestionNode(x, y, type, node.config || {});
                        idMap[node.id] = String(drawflowId);
                        if (dbNodeId) {
                            this.dbNodeToDrawflowMap[dbNodeId] = String(drawflowId);
                        }
                        return; // next forEach iteration
                    }
                    case 'realtime-start':
                        html = this.createRealtimeStartNodeHtml();
                        inputs = 0;
                        outputs = 1;
                        break;
                    case 'realtime-agent':
                        html = this.createRealtimeAgentNodeHtml(
                            node.config?.agent_name || 'Agent',
                            node.config?.voice || 'Ara',
                            `rt-${node.id || index}`
                        );
                        inputs = 1;
                        outputs = 1;
                        break;
                    case 'realtime-end':
                        html = this.createRealtimeEndNodeHtml();
                        inputs = 1;
                        outputs = 0;
                        break;
                    case 'start':
                        html = this.createStartNodeHtml();
                        inputs = 0;
                        outputs = 1;
                        break;
                    case 'output':
                        html = this.createOutputNodeHtml();
                        inputs = 1;
                        outputs = 0;
                        break;
                    case 'agent-template':
                        // Unconfigured agent template node
                        html = `
                            <div class="workflow-node agent-node template configurable">
                                <div class="node-header" style="background: #fef3c7;">
                                    <span class="node-icon">🤖</span>
                                    <span class="node-title">${node.config?.agent_name || this.t('agentTeams.newTemplate')}</span>
                                    <span class="node-config-hint" title="Click to configure">⚙</span>
                                    <button class="node-delete-btn" title="Delete node">×</button>
                                </div>
                                <div class="node-body">
                                    <small class="node-config-display">${this.t('agentTeams.templateDesc')}</small>
                                </div>
                            </div>
                        `;
                        inputs = 1;
                        outputs = 1;
                        break;
                    default: // agent
                        const agentName = node.config?.agent_name || node.agent_name || 'Agent';
                        const agentType = node.config?.agent_type || 'standard';
                        // Look up provider from agents list if not in config
                        let agentProvider = node.config?.agent_provider || '';
                        if (!agentProvider && node.agent_id) {
                            const agentData = this.agents.find(a => String(a.id) === String(node.agent_id));
                            agentProvider = agentData?.provider || agentData?.llm_provider || '';
                        }
                        const nodeMergeStrategy = node.config?.merge_strategy || 'labeled';
                        const nodeDisabled = node.config?.disabled ?? false;
                        html = this.createAgentNodeHtml(node.agent_id, agentName, agentType, agentProvider, nodeMergeStrategy, nodeDisabled);
                        inputs = 1;
                        outputs = 1;
                }

                const x = node.position?.x || node.pos_x || 100;
                const y = node.position?.y || node.pos_y || 100;

                console.log(`[WorkflowEditor] Creating node at (${x}, ${y}) with ${inputs} inputs, ${outputs} outputs`);

                // Get the database node ID
                const dbNodeId = node.db_id || node.id;

                // Ensure the node data includes the type and db_node_id for
                // proper operations. Spread the saved config FIRST, then
                // override db_node_id with the current value — the backend
                // re-INSERTs nodes with new ids on every save, so any
                // db_node_id captured into config from a previous session
                // is stale and would 404 on attach/delete if it won.
                const nodeData = {
                    type: type,
                    ...(node.config || {}),
                    db_node_id: dbNodeId,
                };

                const drawflowId = this.editor.addNode(
                    type === 'agent' ? `agent_${node.agent_id}` : type,
                    inputs,
                    outputs,
                    x,
                    y,
                    type,
                    nodeData,
                    html
                );

                console.log(`[WorkflowEditor] Node created with Drawflow ID:`, drawflowId, 'db_node_id:', dbNodeId);
                idMap[node.id] = String(drawflowId);

                // Store mapping from database node ID to Drawflow ID (for SSE highlighting)
                if (dbNodeId) {
                    this.dbNodeToDrawflowMap[dbNodeId] = String(drawflowId);
                    console.log(`[WorkflowEditor] Stored mapping: dbNodeId ${dbNodeId} -> drawflowId ${drawflowId}`);
                }

                // Wire the realtime Start node's Play button after the node is in the DOM.
                if (type === 'realtime-start') {
                    this.wireRealtimeStartNode(drawflowId);
                }
            } catch (error) {
                console.error(`[WorkflowEditor] Error adding node ${index}:`, error, node);
            }
        });

        // Then, add all edges (connections)
        edges.forEach(edge => {
            const fromId = idMap[edge.from] || edge.from;
            const toId = idMap[edge.to] || edge.to;

            if (fromId && toId) {
                const outputPort = edge.from_port || 'output_1';
                const inputPort = edge.to_port || 'input_1';

                this.editor.addConnection(fromId, toId, outputPort, inputPort);
            }
        });

        // Render any existing documents attached to nodes
        this.renderAllNodeDocuments(nodes, idMap);
    }

    /**
     * Render documents for all loaded nodes
     */
    renderAllNodeDocuments(nodes, idMap) {
        nodes.forEach(node => {
            const type = node.type || node.node_type || node.config?.type || 'agent';

            // Only process nodes that can have documents (agent and start nodes)
            if (type !== 'agent' && type !== 'start') return;

            const documents = node.config?.documents || [];
            if (documents.length === 0) return;

            const drawflowId = idMap[node.id];
            if (!drawflowId) return;

            // Update node data with documents
            const nodeData = this.editor.getNodeFromId(drawflowId);
            if (nodeData && nodeData.data) {
                nodeData.data.documents = documents;
                nodeData.data.db_node_id = node.id; // Store DB node ID for API calls
            }

            // Render the documents in the UI
            this.renderNodeDocuments(parseInt(drawflowId));
        });
    }

    /**
     * Create HTML for start node
     */
    createStartNodeHtml() {
        if (this._startConnectedToIngestion()) return this.createIngestionStartNodeHtml();
        return `
            <div class="workflow-node start-node" data-accepts-documents="true">
                <div class="node-header">
                    <span class="node-icon">▶</span>
                    <span class="node-title">${this.t('workflow.nodes.start')}</span>
                </div>
                <div class="node-body">
                    <small>${this.t('workflow.messages.userPromptInput')}</small>
                    <button class="node-play-btn" title="${this.t('workflow.runWorkflow')}">▶</button>
                </div>
                <div class="node-documents-zone">
                    <div class="documents-list"></div>
                    <div class="documents-drop-hint">📎 ${this.t('workflow.documents.dropHint') || 'Drop files or click to attach'}</div>
                </div>
            </div>
        `;
    }

    /**
     * Start node variant for ingestion pipelines (start → loader): no user
     * prompt is needed, so it shows just the ▶ play button (+ the document
     * drop zone for the file to ingest), recoloured to match the ingestion
     * nodes. Picked by createStartNodeHtml() when the start is wired to a loader.
     */
    createIngestionStartNodeHtml() {
        return `
            <div class="workflow-node start-node ingestion-start" data-accepts-documents="true">
                <div class="node-header">
                    <span class="node-icon">▶</span>
                    <span class="node-title">${this.t('workflow.nodes.start') || 'Start'}</span>
                </div>
                <div class="node-body">
                    <small>Play</small>
                    <button class="node-play-btn" title="Run the ingestion pipeline">▶</button>
                </div>
                <div class="node-documents-zone">
                    <div class="documents-list"></div>
                </div>
            </div>
        `;
    }

    /**
     * Is the current canvas an ingestion (RAG) workflow rather than an agent
     * workflow? True when it contains any loader/splitter/vectorstore node.
     * exportWorkflow() already resolves each node's node_type to its concrete
     * ingestion type (see exportWorkflow), so this is the consistent source.
     */
    _isIngestionWorkflow() {
        try {
            return this.exportWorkflow().nodes.some(
                n => ['loader', 'splitter', 'vectorstore'].includes(n.node_type)
            );
        } catch (_) {
            return false;
        }
    }

    /**
     * Resolve a Drawflow node id to its logical type:
     * 'loader' | 'splitter' | 'vectorstore' for ingestion components, else the
     * node's base type/name ('start' | 'output' | 'agent' | …).
     */
    _nodeTypeById(id) {
        const n = this.editor.getNodeFromId(id);
        if (!n) return null;
        const nt = n.data?.node_type;
        if (['loader', 'splitter', 'vectorstore'].includes(nt)) return nt;
        return n.data?.type || n.name || null;
    }

    /**
     * Validate a just-created connection against the ingestion pipeline rules.
     * Ingestion is a fixed linear pipeline:
     *   start → loader → splitter → vectorstore → output
     * If EITHER endpoint is an ingestion component node, the edge must be one of
     * those pairs (so e.g. only a splitter may follow a loader, and ingestion
     * nodes can't be wired to agents). Connections that involve no ingestion
     * node are left to the existing agent-workflow behavior.
     */
    _isValidIngestionConnection(connection) {
        const ING = ['loader', 'splitter', 'vectorstore'];
        const src = this._nodeTypeById(connection.output_id);
        const tgt = this._nodeTypeById(connection.input_id);
        if (!ING.includes(src) && !ING.includes(tgt)) return true; // pure agent edge
        const ALLOWED = { start: 'loader', loader: 'splitter', splitter: 'vectorstore', vectorstore: 'output' };
        return ALLOWED[src] === tgt;
    }

    /**
     * True when the output (end) node is wired, on its input, to an ingestion
     * component (loader/splitter/vectorstore) — i.e. this output is an ingestion
     * pipeline's sink. The output node uses this to switch between the agent
     * "response to user" variant and the compile-to-Python ingestion variant.
     */
    _outputConnectedToIngestion() {
        try {
            const data = this.editor.export().drawflow.Home.data;
            for (const id in data) {
                const n = data[id];
                if (n.name !== 'output') continue;
                const inputs = n.inputs || {};
                for (const key in inputs) {
                    for (const conn of (inputs[key].connections || [])) {
                        if (['loader', 'splitter', 'vectorstore'].includes(this._nodeTypeById(conn.node))) {
                            return true;
                        }
                    }
                }
            }
        } catch (_) { /* editor not ready */ }
        return false;
    }

    /**
     * True when the start node's output is wired to an ingestion component
     * (a loader, normally) — i.e. this starts an ingestion pipeline, which
     * needs no user prompt. The start node uses this to switch to the
     * prompt-less, recoloured ingestion variant.
     */
    _startConnectedToIngestion() {
        try {
            const data = this.editor.export().drawflow.Home.data;
            for (const id in data) {
                const n = data[id];
                if (n.name !== 'start') continue;
                const outputs = n.outputs || {};
                for (const key in outputs) {
                    for (const conn of (outputs[key].connections || [])) {
                        if (['loader', 'splitter', 'vectorstore'].includes(this._nodeTypeById(conn.node))) {
                            return true;
                        }
                    }
                }
            }
        } catch (_) { /* editor not ready */ }
        return false;
    }

    /**
     * Create HTML for the ingestion (RAG) end node — the vector-store sink.
     * Mirrors createOutputNodeHtml()'s structure (same node-langgraph and
     * node-view-json buttons so existing CSS/click wiring applies) but with
     * ingestion-flavored content and no agent-only storage indicator.
     */
    createIngestionOutputNodeHtml() {
        return `
            <div class="workflow-node output-node ingestion-output">
                <div class="node-header">
                    <span class="node-icon">■</span>
                    <span class="node-title">${this.t('workflow.nodes.output') || 'Output'}</span>
                </div>
                <div class="node-body">
                    <button class="ingestion-compile-btn" title="Compile this ingestion pipeline to a standalone Python script" data-action="ingestion-compile">⚙ Compile to Python</button>
                </div>
            </div>
        `;
    }

    /**
     * Create HTML for output node
     */
    createOutputNodeHtml() {
        if (this._outputConnectedToIngestion()) return this.createIngestionOutputNodeHtml();

        const storageEnabled = this.outputStorageEnabled;
        const storageIcon = storageEnabled ? '💾' : '📤';
        const storageLabel = storageEnabled ? this.t('workflow.storage.storageOn') : this.t('workflow.storage.storageOff');
        const storageClass = storageEnabled ? 'storage-enabled' : 'storage-disabled';

        return `
            <div class="workflow-node output-node">
                <div class="node-header">
                    <span class="node-icon">■</span>
                    <span class="node-title">${this.t('workflow.nodes.output')}</span>
                </div>
                <div class="node-body">
                    <small>${this.t('workflow.messages.responseToUser')}</small>
                </div>
                <div class="node-storage ${storageClass}" title="${this.t('workflow.storage.clickToConfigure')}">
                    <span class="storage-icon">${storageIcon}</span>
                    <span class="storage-label">${storageLabel}</span>
                </div>
                <button class="node-langgraph" title="${this.t('workflow.output.langgraphTitle') || 'LangGraph: setup the runtime or generate the script'}" data-action="langgraph-menu">
                    <span class="gen-label">langGraph - Python</span>
                    <span class="gen-caret" aria-hidden="true">▾</span>
                </button>
                <button class="node-view-json" title="${this.t('workflow.output.viewJsonTitle') || 'View the JSON payload this workflow sends to the backend on save'}" data-action="view-json">
                    <span class="gen-label">${this.t('workflow.output.viewJson') || '{ } View JSON'}</span>
                </button>
            </div>
        `;
    }

    /**
     * Create HTML for agent node
     */
    createAgentNodeHtml(agentId, agentName, agentType, agentProvider = '', mergeStrategy = 'labeled', disabled = false) {
        const typeIcon = agentType === 'worker' ? '⚙️' : '🤖';
        const providerDisplay = agentProvider ? `<span class="node-provider">${this.escapeHtml(agentProvider)}</span>` : '';

        // Show merge indicator if non-default strategy
        let mergeIndicator = '';
        if (mergeStrategy && mergeStrategy !== 'labeled') {
            const strategyLabel = { numbered: '#', concatenate: '+', xml: '<>', json: '{}' }[mergeStrategy] || '';
            mergeIndicator = `<span class="node-merge-indicator" title="Merge: ${mergeStrategy}">⨃${strategyLabel}</span>`;
        }

        return `
            <div class="workflow-node agent-node ${agentType}${disabled ? ' node-disabled' : ''}" data-agent-id="${agentId}" data-merge-strategy="${mergeStrategy}" data-accepts-documents="true">
                <div class="node-header">
                    <span class="node-icon">${typeIcon}</span>
                    <span class="node-title">${this.escapeHtml(agentName)}</span>
                    ${mergeIndicator}
                    <button class="node-delete-btn" title="Delete node">×</button>
                </div>
                <div class="node-body">
                    <span class="node-timer">0:00</span>
                    ${providerDisplay}
                    <button class="node-edit-btn" data-agent-id="${agentId}" title="Edit agent">✏️</button>
                </div>
                <div class="node-documents-zone">
                    <div class="documents-list"></div>
                    <div class="documents-drop-hint">📎 ${this.t('workflow.documents.dropHint') || 'Drop files or click to attach'}</div>
                </div>
            </div>
        `;
    }

    /**
     * Validate workflow structure
     */
    validateWorkflow(workflow) {
        const errors = [];
        const steps = workflow.steps || workflow.nodes || [];
        const edges = workflow.edges || [];

        // Check for start node
        const startNodes = steps.filter(s => s.type === 'start');
        if (startNodes.length === 0) {
            errors.push('Workflow must have a Start node');
        } else if (startNodes.length > 1) {
            errors.push('Workflow can only have one Start node');
        }

        // Check for output node
        const outputNodes = steps.filter(s => s.type === 'output');
        if (outputNodes.length === 0) {
            errors.push('Workflow must have an Output node');
        }

        // Check for unconfigured agent-template nodes
        const templateNodes = steps.filter(s =>
            s.type === 'agent-template' ||
            s.node_type === 'agent-template' ||
            (s.config && s.config.isTemplate === true)
        );
        if (templateNodes.length > 0) {
            errors.push('Workflow has unconfigured agent node(s). Please configure all agent nodes before running.');
        }

        // Check for agent nodes without agent_id
        const agentNodes = steps.filter(s => s.type === 'agent' || s.node_type === 'agent');
        agentNodes.forEach((node, index) => {
            const agentId = node.agent_id || node.config?.agent_id;
            if (!agentId) {
                errors.push(`Agent node ${node.agent_name || index + 1} is not properly configured (missing agent)`);
            }
        });

        // Check for at least one processing node (agent)
        const processingNodes = steps.filter(s => s.type === 'agent');
        if (processingNodes.length === 0) {
            errors.push('Workflow must have at least one Agent node');
        }

        // Check that start is connected
        if (startNodes.length > 0) {
            const startId = startNodes[0].id;
            const hasConnection = edges.some(e => e.from === startId || e.from === String(startId));
            if (!hasConnection) {
                errors.push('Start node must be connected to another node');
            }
        }

        // Check that output has input
        if (outputNodes.length > 0) {
            outputNodes.forEach((outputNode, index) => {
                const outputId = outputNode.id;
                const hasInput = edges.some(e => e.to === outputId || e.to === String(outputId));
                if (!hasInput) {
                    const label = outputNodes.length > 1 ? ` #${index + 1}` : '';
                    errors.push(`Output node${label} must receive input from another node`);
                }
            });
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Run the workflow with SSE streaming
     */
    async runWorkflow() {
        const workflow = this.exportWorkflow();

        // Validate first
        const validation = this.validateWorkflow(workflow);
        if (!validation.valid) {
            alert(this.t('workflow.errors.cannotRunWorkflow', { errors: validation.errors.join('\n') }));
            return;
        }

        if (!this.currentWorkflowId) {
            alert(this.t('workflow.messages.saveFirst'));
            return;
        }

        // Show prompt form and execute when submitted
        this.showPromptForm((userPrompt) => {
            this.executeWorkflow(userPrompt);
        });
    }

    /**
     * Execute the workflow with the given prompt
     */
    async executeWorkflow(userPrompt) {
        // Store the prompt for later viewing
        this.lastUserPrompt = userPrompt;

        // Ingestion graphs (loader/splitter/vectorstore) compile to Python and run
        // in langchain_runner via the run-ingestion endpoint — not the agent
        // run-stream. Route them there.
        const _exported = this.exportWorkflow();
        const _isIngestion = (_exported.nodes || []).some(
            n => ['loader', 'splitter', 'vectorstore'].includes(n.node_type)
        );
        if (_isIngestion) {
            return this._runIngestion();
        }

        // Agent workflows now run BROWSER-DRIVEN (each node = a chat unit,
        // concurrent, non-blocking) instead of the old server run-stream that
        // blocked on the skill bridge. The server path stays below as a
        // fallback (set window.WF_SERVER_RUN = true to force it).
        if (!window.WF_SERVER_RUN) {
            return this.executeWorkflowInBrowser(userPrompt);
        }

        this.updateStartNodeIndicator(true);

        console.log('[WorkflowEditor] executeWorkflow - currentWorkflowId:', this.currentWorkflowId);

        // Re-promote local FS permission if Chrome silently downgraded it
        // since the last grant. Folder-backed skills + locally-stored
        // attachments both need readwrite access; without it, the bundle
        // sent to the backend would be empty (no skill_content, no
        // scripts) and the agent would get no run_skill_script tool.
        // Must run BEFORE any heavy awaits so the Run-button click's
        // transient activation is still valid for requestPermission().
        await this._ensureLocalFsPermission();

        // Reset all node states
        this.resetNodeStates();

        // Track execution state
        this.executionState = {
            startTime: Date.now(),
            activeNodeId: null,
            nodeTimers: new Map(),  // Track timers per-node for parallel execution
            completedNodes: new Set(),
            abortController: new AbortController()
        };

        // Hide reset button if visible and show abort button
        this.hideResetButton();
        this.showAbortButton();

        try {
            const token = window.authManager?.token || window.authManager?.getToken?.();
            const url = `${this.apiBase}/workflows/${this.currentWorkflowId}/run-stream`;

            // Folder-backed skills live in the user's local FS (not on
            // the server). Read SKILL.md content + script list for any
            // node bound to a folder-backed skill and send the bundle
            // inline so the runner can resolve them. Server-side skills
            // (source !== 'local') are unaffected — the runner reads
            // them from the DB as before.
            const clientSkills = await this._collectClientSkillsForRun();
            // Locally-stored attachments live on the user's disk and the
            // server can't read them. The collector splits docs into two
            // shipping modes: bound-skill workflows ship metadata only
            // (scratch_files) and the body lands in Pyodide's /scratch/
            // at tool-call time; non-skill workflows ship the body
            // inline (inline_documents) the same way cloud docs do.
            const { inlineDocuments, scratchFiles } = await this._collectInlineDocumentsForRun();
            console.log('[WorkflowEditor] run-stream payload: client_skills keys=',
                Object.keys(clientSkills || {}),
                'inline_documents keys=', Object.keys(inlineDocuments || {}),
                'scratch_files=', (scratchFiles || []).map(f => f.path));

            const body = {
                variables: { prompt: userPrompt },
            };
            if (clientSkills && Object.keys(clientSkills).length > 0) {
                body.client_skills = clientSkills;
            }
            if (inlineDocuments && Object.keys(inlineDocuments).length > 0) {
                body.inline_documents = inlineDocuments;
            }
            if (scratchFiles && scratchFiles.length > 0) {
                body.scratch_files = scratchFiles;
            }

            // Use fetch with streaming for SSE (EventSource doesn't support POST body)
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify(body),
                signal: this.executionState.abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            console.log('[WorkflowEditor] SSE stream complete');
                            continue;
                        }
                        try {
                            const event = JSON.parse(data);
                            finalResult = this.handleWorkflowEvent(event) || finalResult;
                        } catch (e) {
                            console.warn('[WorkflowEditor] Failed to parse SSE event:', data);
                        }
                    }
                }
            }

            // Clear all node timers and hide abort button
            if (this.executionState.nodeTimers) {
                for (const [nodeId, timerInfo] of this.executionState.nodeTimers) {
                    clearInterval(timerInfo.interval);
                }
                this.executionState.nodeTimers.clear();
            }
            this.hideAbortButton();

            // Show results
            if (finalResult) {
                this.showWorkflowResults(finalResult);
            }

            // Cleanup /scratch/ files we pre-wrote at run start. MEMFS is
            // in-browser only and gets wiped on tab close, but explicit
            // unlink keeps memory hygiene tight across long sessions.
            this._cleanupScratchFiles();

        } catch (error) {
            this._cleanupScratchFiles();
            // Hide abort button
            this.hideAbortButton();

            // Clear all node timers
            if (this.executionState?.nodeTimers) {
                for (const [nodeId, timerInfo] of this.executionState.nodeTimers) {
                    clearInterval(timerInfo.interval);
                }
                this.executionState.nodeTimers.clear();
            }

            // Check if it was an abort
            if (error.name === 'AbortError') {
                console.log('[WorkflowEditor] Workflow aborted by user');
                this.resetNodeStates();
                return;
            }

            console.error('[WorkflowEditor] Error running workflow:', error);
            this.resetNodeStates();
            alert(this.t('workflow.errors.runWorkflowFailed', { error: error.message }));
        }
    }

    /**
     * Ingestion "Play": run the pipeline ONE baby-step at a time. For now it
     * stops at the LOADER stage — it activates the loader node (orange halo) and
     * opens its Output tab to show the code that node generates, so the loader's
     * output can be examined/debugged before we wire the next steps. No
     * execution (needs no vector DB / API key).
     */
    async _runIngestion() {
        // No re-save when parameters change — the workflow exists only to host
        // the pipeline; the per-node code is generated from the LIVE form attrs.
        // Only create it once (to get an id for the endpoints) if it's brand new.
        if (!this.currentWorkflowId) {
            await this.saveWorkflow();
            if (!this.currentWorkflowId) {
                this.showToast(
                    this.tWithFallback('workflow.messages.saveFirst', 'Save the workflow first'),
                    'warning'
                );
                this.updateStartNodeIndicator(false);
                return;
            }
        }
        this.updateStartNodeIndicator(false); // not a long-running execution

        // Find the loader node — the first ingestion stage.
        const data = this.editor.drawflow?.drawflow?.Home?.data || {};
        let loaderId = null;
        for (const id in data) {
            if (data[id]?.data?.node_type === 'loader') { loaderId = String(id); break; }
        }
        if (!loaderId) {
            this.showToast('Add a Loader node to start the ingestion pipeline.', 'warning');
            return;
        }

        // Activate the loader (orange halo) and show the code it generates in its
        // Output tab. showIngestionConfigModal adds/removes the .node-active halo.
        this.showIngestionConfigModal(loaderId);
        const outputBtn = document.querySelector('.ingestion-tab-btn[data-tab="output"]');
        if (outputBtn) outputBtn.click();
    }

    /**
     * Headless run: execute a workflow and return its result without
     * driving the editor canvas (no node highlighting, abort button,
     * reset button, or results modal). This is the reusable entry point
     * the chat uses to run a workflow inline.
     *
     * Behavior mirrors executeWorkflow's network/stream contract exactly
     * (same body shape, headers, SSE loop, and handleWorkflowEvent call —
     * so client_tool_call round-trips and final-result extraction keep
     * working), but deliberately skips all canvas-UI side effects.
     *
     * @param {string|number} workflowId
     * @param {string} userPrompt
     * @param {{ onProgress?: (event: object) => void }} [opts]
     * @returns {Promise<{ result: object|null, outputs: object|null }>}
     */
    async runHeadless(workflowId, userPrompt, { onProgress } = {}) {
        // Populate the drawflow so client-skill / inline-document
        // collection can walk the node graph below.
        await this.loadWorkflow(workflowId);

        // Re-promote local FS permission if Chrome silently downgraded it
        // (same rationale as executeWorkflow).
        await this._ensureLocalFsPermission();

        const clientSkills = await this._collectClientSkillsForRun();
        const { inlineDocuments, scratchFiles } = await this._collectInlineDocumentsForRun();

        const body = {
            variables: { prompt: userPrompt },
        };
        if (clientSkills && Object.keys(clientSkills).length > 0) {
            body.client_skills = clientSkills;
        }
        if (inlineDocuments && Object.keys(inlineDocuments).length > 0) {
            body.inline_documents = inlineDocuments;
        }
        if (scratchFiles && scratchFiles.length > 0) {
            body.scratch_files = scratchFiles;
        }

        const token = window.authManager?.token || window.authManager?.getToken?.();
        const url = `${this.apiBase}/workflows/${workflowId}/run-stream`;
        const abortController = new AbortController();

        // handleWorkflowEvent (invoked per SSE event below) drives the editor's
        // per-node timers via this.executionState. executeWorkflow initializes
        // it; runHeadless MUST too, or every event throws inside the handler and
        // gets swallowed by the catch — losing finalResult and the artifact.
        this.resetNodeStates();
        this.executionState = {
            startTime: Date.now(),
            activeNodeId: null,
            nodeTimers: new Map(),
            completedNodes: new Set(),
            abortController,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify(body),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResult = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') {
                            console.log('[WorkflowEditor] runHeadless SSE stream complete');
                            continue;
                        }
                        try {
                            const ev = JSON.parse(data);
                            const r = this.handleWorkflowEvent(ev);
                            if (r) finalResult = r;
                            if (typeof onProgress === 'function' &&
                                (ev.type === 'node_start' || ev.type === 'node_complete' ||
                                 ev.type === 'workflow_start' || ev.type === 'workflow_complete')) {
                                onProgress(ev);
                            }
                        } catch (e) {
                            console.warn('[WorkflowEditor] runHeadless error handling SSE event:', e, data);
                        }
                    }
                }
            }

            if (this.executionState?.nodeTimers) {
                for (const [, timerInfo] of this.executionState.nodeTimers) {
                    clearInterval(timerInfo.interval);
                }
                this.executionState.nodeTimers.clear();
            }
            // The editor panel is visible during a chat-driven run, so surface
            // the result in its own results panel + artifact view — exactly like
            // executeWorkflow does (otherwise the panel shows "No Results Yet").
            if (finalResult) {
                this.showWorkflowResults(finalResult);
            }
            this._cleanupScratchFiles();
            return { result: finalResult, outputs: finalResult?.outputs ?? null };

        } catch (error) {
            this._cleanupScratchFiles();
            if (error.name === 'AbortError') {
                console.log('[WorkflowEditor] runHeadless aborted');
                return { result: null, outputs: null };
            }
            throw error;
        }
    }

    /**
     * Walk drawflow nodes, find any bound to a folder-backed skill
     * (source === 'local'), and read their SKILL.md + script list off
     * the user's local FS so we can ship them inline with the run
     * request. The runner cannot reach the user's disk; without this
     * bundle, folder-backed skills resolve to empty content.
     *
     * Returns an object keyed by dir_name:
     *   { "<dir>": { skill_content, scripts: ["scripts/x.py", ...] } }
     * or {} if there's nothing folder-backed in the graph.
     */
    async _collectClientSkillsForRun() {
        if (!window.skillsFs) return {};
        const drawflowNodes = this.editor?.drawflow?.drawflow?.Home?.data || {};
        const dirNames = new Set();
        for (const nodeId of Object.keys(drawflowNodes)) {
            const data = drawflowNodes[nodeId]?.data || {};
            const bs = data.bound_skill;
            if (bs && bs.source === 'local' && typeof bs.dir_name === 'string' && bs.dir_name) {
                dirNames.add(bs.dir_name);
            }
        }
        if (dirNames.size === 0) return {};

        const out = {};
        await Promise.all(Array.from(dirNames).map(async (dirName) => {
            try {
                const skill_content = await window.skillsFs.getSkillContent(dirName);
                let scripts = [];
                try {
                    scripts = await window.skillsFs.listSkillScripts(dirName);
                } catch (_) { /* tolerate empty/missing scripts dir */ }
                out[dirName] = { skill_content: skill_content || '', scripts };
            } catch (e) {
                console.warn(`[WorkflowEditor] could not read folder-backed skill "${dirName}":`, e);
            }
        }));
        return out;
    }

    /**
     * Read every locally-stored attachment off the user's disk. Routes
     * them in one of two ways depending on whether the workflow has any
     * folder-backed skill agent:
     *
     *   - **Bound-skill workflow**: docs go to Pyodide /scratch/<name>
     *     and the backend gets `scratch_files` metadata only (no body).
     *     The agent's prompt sees a one-line "file at /scratch/<name>"
     *     reference instead of the full document, saving ~14K input
     *     tokens per LLM call. Mirrors the chat B3 pre-write pattern.
     *     Content is stashed on `this._scratchFileContents` so
     *     `handleClientToolCall` can merge into runSkillScript's
     *     inputFiles when the agent invokes the script.
     *
     *   - **Non-skill workflow**: docs ship inline as before
     *     (`inline_documents`), so generic agents still see the body.
     *
     * Returns `{ inlineDocuments, scratchFiles }`. Callers cleanup
     * `_scratchFileContents` paths via pyodideRunner.cleanupPath after
     * the run.
     */
    async _collectInlineDocumentsForRun() {
        const drawflowNodes = this.editor?.drawflow?.drawflow?.Home?.data || {};
        const localDocs = [];
        const allDocsSeen = [];
        let anyBoundSkillLocal = false;
        for (const nodeId of Object.keys(drawflowNodes)) {
            const data = drawflowNodes[nodeId]?.data || {};
            if (data.bound_skill?.source === 'local' && data.bound_skill?.dir_name) {
                anyBoundSkillLocal = true;
            }
            const docs = data.documents || [];
            for (const doc of docs) {
                allDocsSeen.push({ nodeId, name: doc?.name, storage: doc?.storage, hasPath: !!doc?.path, hasId: !!doc?.id });
                if (doc?.storage === 'local' && doc.path && doc.id) {
                    localDocs.push(doc);
                }
            }
        }
        console.log('[WorkflowEditor] _collectInlineDocumentsForRun: scanned', allDocsSeen.length, 'docs, qualifying', localDocs.length, 'as local. anyBoundSkillLocal=', anyBoundSkillLocal);

        this._scratchFileContents = {};
        if (localDocs.length === 0) {
            return { inlineDocuments: {}, scratchFiles: [] };
        }

        // Need an FSA adapter to read. connectLocalStorage now silently
        // reuses the app-wide synergyAI root if the user already
        // granted it for skills, so this usually succeeds without a
        // prompt. If the adapter still isn't available, fall through
        // and let the agent see the legacy "stored locally" message.
        if (!this.localFsAdapter) {
            try {
                await this.connectLocalStorage();
            } catch (e) {
                console.warn('[WorkflowEditor] Could not bring up local FS adapter for inline doc shipping:', e);
            }
        }
        if (!this.localFsAdapter) {
            console.warn('[WorkflowEditor] No local FS adapter — local-storage docs will not be visible to the agent.');
            return { inlineDocuments: {}, scratchFiles: [] };
        }

        const inlineDocuments = {};
        const scratchFiles = [];
        // Binary file types we should NOT decode as UTF-8. .docx, .xlsx,
        // .pptx are ZIPs; PDFs and images are obviously binary.
        //
        // Mime detection uses exact matches + safe suffixes, NOT
        // substring includes — Office formats like
        // application/vnd.openxmlformats-officedocument.wordprocessingml.document
        // contain "xml" in "wordprocessingml" but are binary ZIPs
        // underneath. The `+xml && !vnd.` rule keeps atom+xml etc.
        // as text while excluding all vendor (vnd.*) binary formats.
        const isTextLike = (doc) => {
            const mime = (doc.mimeType || '').toLowerCase();
            const name = (doc.name || '').toLowerCase();
            if (mime.startsWith('text/')) return true;
            if (mime === 'application/json' || mime === 'application/xml' ||
                mime === 'application/xhtml+xml' || mime === 'application/javascript' ||
                mime === 'application/x-yaml' || mime === 'application/yaml' ||
                mime === 'application/x-toml') return true;
            if (mime.endsWith('+json')) return true;
            if (mime.endsWith('+xml') && !mime.startsWith('application/vnd.')) return true;
            return /\.(html?|md|markdown|txt|json|csv|xml|css|js|py|sh|yml|yaml|toml|ini|log)$/.test(name);
        };

        for (const doc of localDocs) {
            try {
                // Two outputs per doc, computed independently:
                //   inlineMarkdown — text the agent reads (always populated
                //                    when we can produce it).
                //   scratchPayload — raw bytes/string for skill scripts
                //                    that need to read the original file
                //                    (e.g. docx/edit.py find-and-replace).
                let inlineMarkdown = null;
                let scratchPayload = null;
                let sizeForLog;

                if (isTextLike(doc)) {
                    const text = await this.localFsAdapter.read('/' + doc.path);
                    if (typeof text !== 'string') continue;
                    inlineMarkdown = text;
                    scratchPayload = text;
                    sizeForLog = `${text.length} chars`;
                } else {
                    const buf = await this.localFsAdapter.readArrayBuffer('/' + doc.path);
                    if (!buf) continue;
                    const bytes = new Uint8Array(buf);
                    scratchPayload = bytes;
                    sizeForLog = `${bytes.byteLength} bytes (binary)`;

                    // Run the binary through the platform converter
                    // (attachment-converter.js) so the agent sees DOCX/
                    // PPTX/XLSX/PDF as markdown, the same way chat does.
                    // Failure is logged but non-fatal — the doc still
                    // ships via scratchFiles for skill workflows that
                    // can read it directly; non-skill workflows just lose
                    // visibility into that one doc.
                    if (window.attachmentConverter && typeof window.attachmentConverter.toMarkdown === 'function') {
                        try {
                            const file = new File([bytes], doc.name || 'attachment', {
                                type: doc.mimeType || 'application/octet-stream',
                            });
                            const result = await window.attachmentConverter.toMarkdown(file);
                            inlineMarkdown = result.markdown;
                        } catch (convErr) {
                            console.warn(`[WorkflowEditor] Conversion failed for "${doc.name}": ${convErr?.message || convErr}`);
                        }
                    } else {
                        console.warn('[WorkflowEditor] attachmentConverter not available; binary doc will not be visible to non-skill agents.');
                    }
                }
                console.log(`[WorkflowEditor] read local doc "${doc.name}" path=/${doc.path} → ${sizeForLog}${inlineMarkdown ? ' · markdown ready' : ''}`);

                if (inlineMarkdown) {
                    inlineDocuments[doc.id] = inlineMarkdown;
                }

                // Skill-bound workflows also get the raw file written to
                // /scratch/ so edit.py-style scripts can operate on the
                // original bytes. Non-skill workflows skip this — agent
                // already has the markdown via inlineDocuments.
                if (anyBoundSkillLocal && scratchPayload != null) {
                    const safeName = (doc.name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_');
                    const scratchPath = `/scratch/${safeName}`;
                    this._scratchFileContents[scratchPath] = scratchPayload;
                    const reportedSize = typeof scratchPayload === 'string'
                        ? scratchPayload.length
                        : scratchPayload.byteLength;
                    scratchFiles.push({
                        doc_id: doc.id,
                        name: doc.name,
                        path: scratchPath,
                        mime_type: doc.mimeType || 'application/octet-stream',
                        size: reportedSize,
                    });
                }
            } catch (e) {
                console.warn(`[WorkflowEditor] Could not read local doc "${doc.name}" (${doc.path}):`, e);
            }
        }
        return { inlineDocuments, scratchFiles };
    }

    /**
     * Bridge a workflow agent's run_skill_script call to Pyodide.
     * Backend has emitted a `client_tool_call` SSE event and is now
     * blocked on SkillToolBridge::awaitResult; we run the script and
     * POST the result to /workflows/tool-result so the runner can
     * resume.
     */
    /**
     * Run a skill off the main thread via the Pyodide worker pool when possible.
     * This is what makes workflow skills reliable under fan-out: the single
     * main-thread Pyodide can't keep up with several skills running while it also
     * services the SSE stream and posts results, so skills blow the bridge
     * timeout. Each pool worker loads its own Pyodide and runs concurrently.
     * Skills that need main-thread URL prefetch (fetches_urls:true) stay on the
     * main thread; the GEO skills are fetches_urls:false (they self-fetch through
     * the auth'd backend proxy) so they pool fine. Any pool/permission failure
     * falls back to the main-thread runner so a run can never get worse.
     */
    async _runSkillPooledOrMain(req) {
        try {
            let fetchesUrls = false;
            try { fetchesUrls = await window.pyodideRunner.getSkillFetchesUrls(req.dirName); } catch (_) {}
            if (!fetchesUrls && typeof Worker !== 'undefined' && window.PyodideWorkerPool && window.localFs) {
                if (!this._pyodidePool) this._pyodidePool = this._makePyodidePool();
                return await this._runViaPool(req);
            }
        } catch (e) {
            console.warn('[WorkflowEditor] worker-pool path failed, falling back to main thread:', e);
        }
        return await window.pyodideRunner.runSkillScript(req);
    }

    // Pool factory — mirrors chat.js so workflow skills use the same workers.
    _makePyodidePool() {
        let workerN = 0;
        return new window.PyodideWorkerPool({
            workerFactory: () => {
                const wid = ++workerN;
                const w = new Worker('assets/js/pyodide.worker.js?v=20260612-writtenoutputs');
                console.log(`[wf-pool] spawned worker w${wid} (each worker loads its own Pyodide — first use is a cold start)`);
                let seq = 0;
                const pending = new Map();
                w.onmessage = (e) => {
                    const d = e.data || {};
                    if (d.type === 'progress') { console.log(`[wf-pool w${wid}] ${d.msg}`); return; }
                    const { id, ok, result, error } = d;
                    const p = pending.get(id);
                    if (!p) return;
                    pending.delete(id);
                    ok ? p.resolve(result) : p.reject(new Error(error));
                };
                w.onerror = (e) => {
                    const err = new Error('pyodide worker error: ' + (e.message || e.filename || ''));
                    for (const p of pending.values()) p.reject(err);
                    pending.clear();
                };
                return {
                    run: (payload) => new Promise((resolve, reject) => {
                        const id = ++seq;
                        pending.set(id, { resolve, reject });
                        w.postMessage({ id, verb: 'runSkillScript', payload });
                    }),
                    terminate: () => w.terminate(),
                };
            },
        });
    }

    // Resolve FSA handles + deps on the main thread, then run one skill in a
    // worker. Mirrors chat.js _runViaPool. Throws on any failure so the caller
    // falls back to the main-thread runner.
    async _runViaPool(req) {
        if (!window.localFs) throw new Error('localFs unavailable for pool path');
        this._poolHandleCache = this._poolHandleCache || new Map();
        const resolveCached = (path, opts) => {
            if (!this._poolHandleCache.has(path)) {
                this._poolHandleCache.set(path, window.localFs.resolvePath(path, opts));
            }
            return this._poolHandleCache.get(path);
        };
        const skillHandle = await resolveCached(`skills/${req.dirName}`);
        const outputsHandle = await resolveCached('outputs', { create: true });
        if (!skillHandle || !outputsHandle) throw new Error('could not resolve skill/outputs handles for pool path');
        for (const h of [skillHandle, outputsHandle]) {
            if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
                    throw new Error('readwrite permission denied for pool path');
                }
            }
        }
        const dependencies = await window.pyodideRunner.getSkillDependencies(req.dirName);
        const authToken = window.authManager?.token || null;
        const [r] = await this._pyodidePool.runBatch([{
            ...req, dependencies, authToken, skillHandle, outputsHandle, prefetched: [],
        }]);
        if (!r || !r.ok) throw new Error(r ? r.error : 'pool returned no result');
        return r.result;
    }

    // ---- Browser-driven node execution (the "chat unit" model) -------------
    // Run ONE agent node the way chat does: loop /api/v1/chat (non-streaming),
    // and whenever the model asks for a skill, run it on the worker pool and
    // re-call /chat with the result — until the model returns final text. No
    // server-side blocking, no bridge, no timeout caps. Returns {success, output}.

    _wfNodeLog(dfId, phase, message, level = 'info') {
        if (!this.nodeExecutionData[dfId]) this.nodeExecutionData[dfId] = {};
        if (!Array.isArray(this.nodeExecutionData[dfId].activity)) this.nodeExecutionData[dfId].activity = [];
        this.nodeExecutionData[dfId].activity.push({ ts: Date.now() / 1000, level, phase, message });
        this.updateModalInputOutput(dfId);
    }

    async _runNodeAsChatUnit(node, inputText) {
        const dfId = String(node.id);
        const data = node.data || {};
        const provider = data.agent_provider || data.provider || 'openai';
        const model = data.model || null;
        const instructions = data.instructions || '';
        const dirName = data.bound_skill?.dir_name || null;

        if (!this.nodeExecutionData[dfId]) this.nodeExecutionData[dfId] = {};
        this.nodeExecutionData[dfId].input = inputText;
        this.nodeExecutionData[dfId].activity = [];
        this.nodeExecutionData[dfId].logs = [];
        this.highlightNode(dfId, 'active', dfId, 'agent');
        this.updateModalInputOutput(dfId);
        this._wfNodeLog(dfId, 'llm', `calling ${provider}${model ? ' (' + model + ')' : ''}`);

        // Load the bound skill's body + scripts so the model can call it.
        let skillContent = null, skillMetadata = null;
        if (dirName && window.skillsFs) {
            try {
                skillContent = await window.skillsFs.getSkillContent(dirName);
                const scripts = await window.skillsFs.listSkillScripts(dirName);
                skillMetadata = { dir_name: dirName, scripts };
            } catch (e) { console.warn('[wf-unit] skill load failed for', dirName, e); }
        }

        const conversationHistory = [];
        const MAX_ROUNDS = 8;
        try {
            for (let round = 0; round < MAX_ROUNDS; round++) {
                const body = {
                    message: round === 0 ? inputText : '',
                    conversation_history: conversationHistory,
                    streaming: false,
                    provider,
                    model,
                    system_prompt: instructions,
                    skill_content: skillContent,
                    skill_metadata: skillMetadata,
                };
                const resp = await fetch(`${this.apiBase}/chat`, {
                    method: 'POST',
                    headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify(body),
                });
                if (!resp.ok) throw new Error(`chat HTTP ${resp.status}`);
                const r = await resp.json();

                if (r.pending_client_tool_call) {
                    const calls = Array.isArray(r.pending_tool_calls) ? r.pending_tool_calls : [];
                    const assistantText = r.assistant_text || r.text || '';
                    this._wfNodeLog(dfId, 'llm', 'model requested run_skill_script');
                    conversationHistory.push({
                        role: 'assistant',
                        content: assistantText || null,
                        tool_calls: calls.map(c => ({
                            id: c.id,
                            type: 'function',
                            function: { name: c.name || 'run_skill_script', arguments: JSON.stringify(c.input || {}) },
                        })),
                    });
                    for (const c of calls) {
                        const input = c.input || {};
                        this._wfNodeLog(dfId, 'skill', `running skill ${input.dir_name || dirName}`);
                        const result = await this._runSkillPooledOrMain({
                            dirName: input.dir_name || dirName,
                            script: input.script,
                            argv: Array.isArray(input.argv) ? input.argv : [],
                            inputFiles: null,
                            readOutputs: Array.isArray(input.read_outputs) && input.read_outputs.length ? input.read_outputs : null,
                        });
                        this._wfNodeLog(dfId, 'skill', `skill finished (exit ${result?.exitCode ?? 0})`);
                        this.nodeExecutionData[dfId].logs.push({
                            dirName: input.dir_name || dirName, script: input.script || '',
                            argv: Array.isArray(input.argv) ? input.argv : [],
                            exitCode: result?.exitCode ?? 0, stdout: result?.stdout || '',
                            logMessages: result?.stderr || '', durationMs: Math.round(result?.durationMs ?? 0),
                        });
                        // Trim outputs to keep the tool result small.
                        const outs = {};
                        for (const [p, v] of Object.entries(result?.outputs || {})) {
                            outs[p] = (typeof v === 'string') ? (v.length > 2000 ? v.slice(0, 2000) + ' …[truncated]' : v)
                                : `[binary ${v?.byteLength ?? 0} bytes]`;
                        }
                        conversationHistory.push({
                            role: 'tool',
                            tool_call_id: c.id,
                            name: c.name || 'run_skill_script',
                            content: JSON.stringify({
                                success: (result?.exitCode ?? 0) === 0,
                                output: { exit_code: result?.exitCode ?? 0, stdout: result?.stdout || '', log_messages: result?.stderr || '', outputs: outs },
                            }),
                        });
                        this.updateModalInputOutput(dfId);
                    }
                } else {
                    const finalText = r.text || r.assistant_text || '';
                    this.nodeExecutionData[dfId].output = finalText;
                    this.nodeExecutionData[dfId].success = true;
                    this._wfNodeLog(dfId, 'done', 'completed');
                    this.highlightNode(dfId, 'completed', dfId, 'agent');
                    this.updateModalInputOutput(dfId);
                    return { success: true, output: finalText };
                }
            }
            throw new Error(`did not finish within ${MAX_ROUNDS} rounds`);
        } catch (e) {
            const msg = String(e?.message || e);
            this.nodeExecutionData[dfId].output = 'Error: ' + msg;
            this.nodeExecutionData[dfId].success = false;
            this._wfNodeLog(dfId, 'error', msg, 'error');
            this.highlightNode(dfId, 'error', dfId, 'agent');
            this.updateModalInputOutput(dfId);
            return { success: false, output: 'Error: ' + msg };
        }
    }

    // ---- Browser-driven concurrent orchestrator ---------------------------
    // Runs the whole graph as N chat-units: seed Start with the prompt, then
    // run each node when all its upstream are done (allSettled per ready layer,
    // so the 6 dimensions run concurrently and one failure never sinks the
    // rest). Fan-in nodes (geo-report) get the merged upstream outputs. No
    // server blocking — each node is its own chat conversation.

    _wfUpstreamIds(nodeId, nodes) {
        const ins = nodes[nodeId]?.inputs || {};
        const out = [];
        for (const k in ins) for (const c of (ins[k].connections || [])) out.push(String(c.node));
        return out;
    }

    _wfNodeKind(nodeId, nodes) {
        const n = nodes[nodeId] || {};
        const d = n.data || {};
        const t = d.type || d.node_type || n.name || '';
        if (t === 'start' || (n.class || '').includes('start-node')) return 'start';
        if (t === 'output' || (n.class || '').includes('output-node')) return 'output';
        return 'agent';
    }

    _wfBuildContext(nodeId, nodes) {
        const ups = this._wfUpstreamIds(nodeId, nodes);
        const parts = [];
        for (const u of ups) {
            const out = this._wfOutputs?.[u];
            if (out == null || out === '') continue;
            if (this._wfNodeKind(u, nodes) === 'start') { parts.push(out); continue; }
            const name = nodes[u]?.data?.agent_name || nodes[u]?.data?.name || `node ${u}`;
            parts.push(`## ${name}\n${out}`);
        }
        return parts.join('\n\n');
    }

    async executeWorkflowInBrowser(userPrompt) {
        this.lastUserPrompt = userPrompt;
        this.updateStartNodeIndicator(true);
        const nodes = this.editor.drawflow.drawflow.Home.data;
        const ids = Object.keys(nodes);
        this._wfOutputs = {};
        const done = new Set();
        const remaining = new Set();

        // Seed Start node(s) with the prompt; reset agent node UI.
        for (const id of ids) {
            const kind = this._wfNodeKind(id, nodes);
            if (kind === 'start') { this._wfOutputs[id] = userPrompt; done.add(id); }
            else {
                remaining.add(id);
                if (kind === 'agent') { this.nodeExecutionData[id] = {}; this.highlightNode(id, 'idle', id, 'agent'); }
            }
        }

        let guard = 0;
        while (remaining.size && guard++ < 100) {
            const ready = [...remaining].filter(id => this._wfUpstreamIds(id, nodes).every(u => done.has(u)));
            if (!ready.length) break; // cycle or orphan — stop
            await Promise.allSettled(ready.map(async (id) => {
                const node = { id, data: nodes[id].data || {} };
                try {
                    if (node.data && node.data.disabled) {
                        this._wfOutputs[id] = 'disabled node';
                        this.highlightNode(id, 'completed', id, 'agent');
                    } else if (this._wfNodeKind(id, nodes) === 'output') {
                        this._wfOutputs[id] = this._wfBuildContext(id, nodes);
                    } else {
                        const ctx = this._wfBuildContext(id, nodes) || userPrompt;
                        const res = await this._runNodeAsChatUnit(node, ctx);
                        this._wfOutputs[id] = res.output;
                    }
                } catch (e) {
                    this._wfOutputs[id] = 'Error: ' + (e?.message || e);
                    this.highlightNode(id, 'error', id, 'agent');
                }
                done.add(id);
                remaining.delete(id);
            }));
        }

        this.updateStartNodeIndicator(false);
        const outId = ids.find(id => this._wfNodeKind(id, nodes) === 'output');
        const finalOutput = outId ? this._wfOutputs[outId] : '';
        console.log('[wf-browser] run complete. outputs:', this._wfOutputs);
        if (typeof this.showWorkflowResults === 'function' && finalOutput) {
            try { this.showWorkflowResults({ output: finalOutput, node_outputs: this._wfOutputs }); } catch (_) {}
        }
        return this._wfOutputs;
    }

    // Console test entry: wfEditor.runNodeChatUnitTest('<drawflowId>', 'input text')
    async runNodeChatUnitTest(drawflowId, inputText) {
        const node = this.editor.getNodeFromId(drawflowId);
        if (!node) { console.error('[wf-unit] no node', drawflowId); return; }
        console.log('[wf-unit] running node', drawflowId, node.data?.agent_name || node.data?.name);
        const out = await this._runNodeAsChatUnit(node, inputText);
        console.log('[wf-unit] result:', out);
        return out;
    }

    async handleClientToolCall(event) {
        const toolCallId = event.tool_call_id;
        const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
        const dirName = event.dir_name || calls[0]?.input?.dir_name;
        if (!toolCallId || !calls.length) {
            console.warn('[WorkflowEditor] client_tool_call missing tool_call_id or tool_calls', event);
            return;
        }
        if (!window.pyodideRunner) {
            await this._postToolResult(toolCallId, {
                tool_call_id: toolCallId,
                success: false,
                error: 'pyodideRunner not loaded — cannot run skill script in this browser.',
            });
            return;
        }
        if (!dirName) {
            await this._postToolResult(toolCallId, {
                tool_call_id: toolCallId,
                success: false,
                error: 'No skill dir_name in client_tool_call event.',
            });
            return;
        }

        const call = calls[0];
        const input = call.input || {};
        // Merge any /scratch/ files we pre-stashed at workflow start
        // with whatever the LLM passed via input_files. Pre-stashed
        // entries WIN — for binary files (.docx/.xlsx/.pdf) the LLM
        // physically can't send raw bytes through JSON, so any value
        // it provides for a stashed path is a corrupted guess. The
        // LLM's input_files still apply for paths we didn't stash.
        const llmInputFiles = (input.input_files && typeof input.input_files === 'object') ? input.input_files : {};
        const stashed = this._scratchFileContents || {};
        const mergedInputFiles = { ...llmInputFiles, ...stashed };
        const finalInputFiles = Object.keys(mergedInputFiles).length > 0 ? mergedInputFiles : null;
        try {
            const result = await this._runSkillPooledOrMain({
                dirName,
                script: input.script,
                argv: Array.isArray(input.argv) ? input.argv : [],
                inputFiles: finalInputFiles,
                readOutputs: Array.isArray(input.read_outputs) && input.read_outputs.length > 0 ? input.read_outputs : null,
            });

            // Capture this skill run's logs so the node modal's Logs tab can
            // show what the script actually did (stdout + log_messages), which
            // dir/script/argv ran, the exit code and duration. This is the
            // richest signal when a node misbehaves — far more than a red glow.
            try {
                const logNodeId = this.dbNodeToDrawflowMap?.[event.node_id] || event.node_id;
                if (logNodeId != null) {
                    if (!this.nodeExecutionData[logNodeId]) this.nodeExecutionData[logNodeId] = {};
                    if (!Array.isArray(this.nodeExecutionData[logNodeId].logs)) this.nodeExecutionData[logNodeId].logs = [];
                    this.nodeExecutionData[logNodeId].logs.push({
                        dirName,
                        script: input.script || '',
                        argv: Array.isArray(input.argv) ? input.argv : [],
                        exitCode: result?.exitCode ?? 0,
                        stdout: result?.stdout || '',
                        logMessages: result?.stderr || '',
                        durationMs: Math.round(result?.durationMs ?? 0),
                    });
                    this.updateModalInputOutput(logNodeId);
                }
            } catch (e) {
                console.warn('[WorkflowEditor] failed to capture skill logs:', e);
            }

            // Capture the latest renderable artifact (HTML/MD) for the
            // end-node display. Reuses chat's existing selector so the
            // detection logic stays in one place. The pane itself is
            // opened later, in showWorkflowResults().
            try {
                const artifact = window.chatApp?._selectArtifactFromOutputs?.(result?.outputs);
                if (artifact) {
                    this.lastProducedArtifact = { dirName, ...artifact };
                }
            } catch (e) {
                console.warn('[WorkflowEditor] artifact selection failed:', e);
            }

            // Trim outputs the same way chat.js does:
            //   - binary (Uint8Array) → placeholder with disk path so the
            //     agent can tell the user where the file lives
            //   - large strings truncated to keep tokens down
            //   - small strings passed through
            // Also resolves /outputs/<name> to a human-friendly disk path
            // (e.g. "synergyAI/outputs/foo.docx") that the agent can echo
            // back. Without this, raw Uint8Arrays get JSON-serialized as
            // {"0":1,"1":255,...} — 4x the bytes and unusable to the LLM.
            const MAX_OUTPUT_CHARS = 2_000;
            const rootName = window.chatApp?._fsaRootName || 'storage';
            const diskPathFor = (path) => (typeof path === 'string' && path.startsWith('/'))
                ? `${rootName}${path}`
                : null;
            const trimmedOutputs = {};
            for (const [path, val] of Object.entries(result?.outputs || {})) {
                const disk = diskPathFor(path);
                const diskHint = disk ? ` File saved on disk at: ${disk}` : '';
                if (val == null) {
                    trimmedOutputs[path] = null;
                } else if (typeof val === 'string' && val.length > MAX_OUTPUT_CHARS) {
                    trimmedOutputs[path] = val.slice(0, MAX_OUTPUT_CHARS) + `\n\n[truncated — original was ${val.length} chars.${diskHint}]`;
                } else if (typeof val === 'string') {
                    trimmedOutputs[path] = val;
                } else {
                    trimmedOutputs[path] = `[binary file, ${val.byteLength} bytes.${diskHint} Tell the user where the file lives on their disk.]`;
                }
            }

            await this._postToolResult(toolCallId, {
                tool_call_id: toolCallId,
                success: (result?.exitCode ?? 0) === 0,
                output: {
                    exit_code: result?.exitCode ?? 0,
                    stdout: result?.stdout || '',
                    log_messages: result?.stderr || '',
                    outputs: trimmedOutputs,
                    duration_ms: Math.round(result?.durationMs ?? 0),
                },
                note: 'Treat success=true as the script ran cleanly. Summarize what changed; do not re-quote large outputs.',
            });
        } catch (e) {
            console.error('[WorkflowEditor] runSkillScript failed:', e);
            await this._postToolResult(toolCallId, {
                tool_call_id: toolCallId,
                success: false,
                error: e?.message || String(e),
            });
        }
    }

    /**
     * Re-promote the app-wide local-FS permission (window.localFs) when
     * Chrome has silently downgraded it from 'granted' to 'prompt'
     * between sessions. Must be called from a user-gesture context
     * (e.g. the Run button's click handler) before any long awaits, so
     * the browser still considers transient activation valid.
     *
     * No-op when already granted, when FSA is unsupported, or when no
     * folder has ever been picked. On 'denied' we surface a toast so
     * the user knows their bundle will be empty.
     */
    async _ensureLocalFsPermission() {
        if (!window.localFs?.getStatus) return;
        let s;
        try { s = await window.localFs.getStatus(); } catch (_) { return; }
        if (!s || s.state === 'granted' || s.state === 'unsupported' || s.state === 'not_picked') return;
        if (!s.handle?.requestPermission) return;
        try {
            const result = await s.handle.requestPermission({ mode: 'readwrite' });
            console.log('[WorkflowEditor] requested local-fs permission, result:', result);
            if (result !== 'granted') {
                this.showToast?.(
                    'Local folder access not granted — folder-backed skills and local attachments will not be visible to the agent.',
                    'warning'
                );
            }
        } catch (e) {
            console.warn('[WorkflowEditor] requestPermission failed:', e);
        }
    }

    /**
     * Unlink any /scratch/<file> paths we pre-stashed at workflow start
     * and clear the in-memory map. Safe to call multiple times.
     */
    _cleanupScratchFiles() {
        const stashed = this._scratchFileContents || {};
        for (const path of Object.keys(stashed)) {
            window.pyodideRunner?.cleanupPath?.(path);
        }
        this._scratchFileContents = {};
    }

    async _postToolResult(toolCallId, payload) {
        try {
            const url = `${this.apiBase}/workflows/tool-result`;
            const res = await fetch(url, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                console.warn('[WorkflowEditor] tool-result POST failed:', res.status);
            }
        } catch (e) {
            console.error('[WorkflowEditor] tool-result POST threw:', e);
        }
    }

    /**
     * Handle SSE workflow events
     */
    handleWorkflowEvent(event) {
        console.log('[WorkflowEditor] SSE event:', event.type, event);

        switch (event.type) {
            case 'workflow_start':
                console.log('[WorkflowEditor] Workflow started:', event.workflow_name);
                // Clear previous execution data for fresh run
                this.nodeExecutionData = {};
                if (event.run_id) {
                    this.currentRunId = event.run_id;
                    try {
                        const wfKey = this.currentWorkflowId || 'unsaved';
                        localStorage.setItem('lastRunId:' + wfKey, event.run_id);
                    } catch (e) { /* localStorage may be unavailable; non-fatal */ }
                }
                this.lastProducedArtifact = null;
                break;

            case 'node_start':
                this.highlightNode(event.node_id, 'active', event.drawflow_id, event.node_type);
                this.startNodeTimer(event.node_id, event.drawflow_id);
                // Store input content and start time as soon as it arrives
                {
                    const drawflowId = this.dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id;
                    if (!this.nodeExecutionData[drawflowId]) {
                        this.nodeExecutionData[drawflowId] = {};
                    }
                    this.nodeExecutionData[drawflowId].startTime = Date.now();
                    if (event.input) {
                        this.nodeExecutionData[drawflowId].input = event.input;
                        // Update modal if it's open for this node
                        this.updateModalInputOutput(drawflowId);
                    }
                }
                break;

            case 'node_complete':
                // Use 'error' state if success is explicitly false, otherwise 'completed'
                const nodeState = event.success === false ? 'error' : 'completed';
                this.highlightNode(event.node_id, nodeState, event.drawflow_id, event.node_type);
                this.stopNodeTimer(event.node_id);
                if (event.node_id) {
                    this.executionState.completedNodes.add(event.node_id);
                }
                // Store output content, tokens, and execution time
                {
                    const drawflowId = this.dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id;
                    if (!this.nodeExecutionData[drawflowId]) {
                        this.nodeExecutionData[drawflowId] = {};
                    }
                    const nodeData = this.nodeExecutionData[drawflowId];
                    if (event.output !== undefined) {
                        nodeData.output = event.output;
                    }
                    // Store token usage
                    nodeData.inputTokens = event.input_tokens || 0;
                    nodeData.outputTokens = event.output_tokens || 0;
                    nodeData.totalTokens = nodeData.inputTokens + nodeData.outputTokens;
                    // Backend-computed USD cost (from centralized system_llm_settings
                    // pricing). null when pricing is unknown for the provider.
                    nodeData.costUsd = (event.cost_usd !== undefined && event.cost_usd !== null)
                        ? Number(event.cost_usd) : null;
                    // Calculate execution time
                    if (nodeData.startTime) {
                        nodeData.executionTime = Date.now() - nodeData.startTime;
                    }
                    nodeData.agentName = event.agent_name || null;
                    nodeData.success = event.success !== false;
                    // Update modal if it's open for this node
                    this.updateModalInputOutput(drawflowId);
                }
                break;

        case 'node_log': {
            const dfId = this.dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id;
            if (dfId != null) {
                if (!this.nodeExecutionData[dfId]) this.nodeExecutionData[dfId] = {};
                if (!Array.isArray(this.nodeExecutionData[dfId].activity)) this.nodeExecutionData[dfId].activity = [];
                this.nodeExecutionData[dfId].activity.push({
                    ts: event.timestamp || 0,
                    level: event.level || 'info',
                    phase: event.phase || '',
                    message: event.message || '',
                });
                this.updateModalInputOutput(dfId);
            }
            break;
        }

            case 'node_error':
                this.highlightNode(event.node_id, 'error', event.drawflow_id, event.node_type);
                this.stopNodeTimer(event.node_id);
                console.error('[WorkflowEditor] Node error:', event.error);
                break;

            case 'client_tool_call':
                // Backend ran an agent that emitted run_skill_script;
                // it's now blocked on the bridge waiting for us. Run
                // the script via Pyodide and POST the result back.
                this.handleClientToolCall(event).catch(err => {
                    console.error('[WorkflowEditor] client_tool_call handler failed:', err);
                });
                break;

            case 'workflow_complete':
                console.log('[WorkflowEditor] Workflow completed:', event);
                // Post-run self-heal hook (Auto mode only; debounced + threshold'd).
                try { window.healSystem && window.healSystem.autoAfterRun && window.healSystem.autoAfterRun(); } catch (_) {}
                // Hide abort button and show reset button with token stats
                this.hideAbortButton();
                const tokenInfo = {
                    input: event.total_input_tokens || 0,
                    output: event.total_output_tokens || 0,
                    total: event.total_tokens || (event.total_input_tokens || 0) + (event.total_output_tokens || 0)
                };
                this.showResetButton(tokenInfo);
                // Refresh the chat sidebar so the just-archived workflow row
                // appears immediately without requiring a page reload.
                if (window.chatApp && typeof window.chatApp.loadContextsList === 'function') {
                    window.chatApp.loadContextsList().catch(e => {
                        console.warn('[WorkflowEditor] Could not refresh chat sidebar:', e);
                    });
                }
                // Persist the final output to synergyAI/outputs/workflows/.
                // Filename is timestamped so multiple runs of the same
                // workflow never overwrite each other. Fires-and-forgets:
                // we don't block the UI completion path on the FSA write.
                if (event.success && event.output) {
                    this._saveWorkflowOutput(event.output).catch(err => {
                        console.warn('[WorkflowEditor] Could not save workflow output:', err);
                    });
                }
                // Return the result data for display
                return {
                    success: event.success,
                    output: event.output,
                    node_outputs: event.node_outputs,
                    nodes_executed: event.nodes_executed,
                    response_time_ms: event.response_time_ms,
                    total_input_tokens: event.total_input_tokens,
                    total_output_tokens: event.total_output_tokens,
                    total_tokens: event.total_tokens
                };

            case 'workflow_error':
            case 'error':
                console.error('[WorkflowEditor] Workflow error:', event.error);
                // Hide abort button and show reset button (keep node states visible to show errors)
                this.hideAbortButton();
                this.showResetButton();
                alert(this.t('workflow.errors.workflowError', { error: event.error }));
                break;
        }
        return null;
    }

    /**
     * Highlight a node in the canvas
     * @param {string|number} nodeId - Database node ID or Drawflow ID
     * @param {string} state - 'active', 'completed', or 'error'
     * @param {string|number} drawflowId - Optional Drawflow ID from backend
     * @param {string} nodeType - Optional node type for fallback matching
     */
    highlightNode(nodeId, state, drawflowId = null, nodeType = null) {
        // Try to find the node using multiple strategies
        let nodeEl = null;

        // Strategy 1: Use the database node ID to Drawflow ID mapping
        if (this.dbNodeToDrawflowMap && this.dbNodeToDrawflowMap[nodeId]) {
            const mappedId = this.dbNodeToDrawflowMap[nodeId];
            nodeEl = document.querySelector(`#node-${mappedId}`);
            console.log(`[WorkflowEditor] Found node via dbNodeToDrawflowMap: ${nodeId} -> ${mappedId}`);
        }

        // Strategy 2: Try the drawflow_id directly from the event
        if (!nodeEl && drawflowId) {
            nodeEl = document.querySelector(`#node-${drawflowId}`);
            if (nodeEl) {
                console.log(`[WorkflowEditor] Found node via drawflowId: ${drawflowId}`);
            }
        }

        // Strategy 3: Try the nodeId directly (might be the Drawflow ID)
        if (!nodeEl && nodeId) {
            nodeEl = document.querySelector(`#node-${nodeId}`);
            if (nodeEl) {
                console.log(`[WorkflowEditor] Found node via nodeId: ${nodeId}`);
            }
        }

        // Strategy 4: For specific node types, find by CSS class (fallback)
        if (!nodeEl && nodeType) {
            let selector = null;
            if (nodeType === 'start') {
                selector = '.drawflow-node .workflow-node.start-node';
            } else if (nodeType === 'output') {
                selector = '.drawflow-node .workflow-node.output-node';
            }
            if (selector) {
                const innerEl = document.querySelector(selector);
                if (innerEl) {
                    nodeEl = innerEl.closest('.drawflow-node');
                    if (nodeEl) {
                        console.log(`[WorkflowEditor] Found ${nodeType} node via CSS class fallback`);
                    }
                }
            }
        }

        if (!nodeEl) {
            console.warn('[WorkflowEditor] Node element not found. nodeId:', nodeId, 'drawflowId:', drawflowId, 'map:', this.dbNodeToDrawflowMap);
            return;
        }

        // Remove previous states
        nodeEl.classList.remove('node-active', 'node-completed', 'node-error');

        // Add new state
        switch (state) {
            case 'active':
                nodeEl.classList.add('node-active');
                console.log(`[WorkflowEditor] Added 'node-active' class to node. Classes: ${nodeEl.className}`);
                break;
            case 'completed':
                nodeEl.classList.add('node-completed');
                break;
            case 'error':
                nodeEl.classList.add('node-error');
                break;
        }
    }

    /**
     * Start timer display on a node
     */
    startNodeTimer(nodeId, drawflowId = null) {
        console.log('[WorkflowEditor] startNodeTimer called:', { nodeId, drawflowId, map: this.dbNodeToDrawflowMap });

        // Find the node element using the same strategy as highlightNode
        let nodeEl = null;

        if (this.dbNodeToDrawflowMap && this.dbNodeToDrawflowMap[nodeId]) {
            const mappedId = this.dbNodeToDrawflowMap[nodeId];
            nodeEl = document.querySelector(`#node-${mappedId}`);
            console.log('[WorkflowEditor] Found via map:', mappedId, nodeEl);
        }
        if (!nodeEl && drawflowId) {
            nodeEl = document.querySelector(`#node-${drawflowId}`);
            console.log('[WorkflowEditor] Found via drawflowId:', drawflowId, nodeEl);
        }
        if (!nodeEl && nodeId) {
            nodeEl = document.querySelector(`#node-${nodeId}`);
            console.log('[WorkflowEditor] Found via nodeId:', nodeId, nodeEl);
        }

        if (!nodeEl) {
            console.warn('[WorkflowEditor] startNodeTimer: Node element not found');
            return;
        }

        // Find the timer element
        const timerEl = nodeEl.querySelector('.node-timer');
        console.log('[WorkflowEditor] Timer element:', timerEl);

        if (timerEl) {
            timerEl.classList.add('node-timer-active');
        } else {
            console.warn('[WorkflowEditor] startNodeTimer: Timer element not found in node');
        }

        const startTime = Date.now();

        // Update timer every 100ms (always show minutes:seconds format)
        const interval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            if (timerEl) {
                timerEl.textContent = timeStr;
            }
        }, 100);

        // Store timer info per-node to support parallel execution
        this.executionState.nodeTimers.set(nodeId, { interval, timerEl });
        console.log('[WorkflowEditor] Timer started for node:', nodeId);
    }

    /**
     * Stop timer display on a node (keeps final time visible)
     */
    stopNodeTimer(nodeId) {
        // Get timer info for this specific node
        const timerInfo = this.executionState?.nodeTimers?.get(nodeId);

        if (timerInfo) {
            // Clear the interval for this node
            clearInterval(timerInfo.interval);

            // Keep the final time displayed, just remove the active styling
            if (timerInfo.timerEl) {
                timerInfo.timerEl.classList.remove('node-timer-active');
            }

            // Remove from map
            this.executionState.nodeTimers.delete(nodeId);
        }
    }

    /**
     * Reset all node visual states
     */
    resetNodeStates() {
        document.querySelectorAll('.drawflow-node').forEach(node => {
            node.classList.remove('node-active', 'node-completed', 'node-error');

            // Reset timer to 0:00
            const timerEl = node.querySelector('.node-timer');
            if (timerEl) {
                timerEl.textContent = '0:00';
                timerEl.classList.remove('node-timer-active');
            }
        });
    }

    /**
     * Show abort button during workflow execution
     */
    showAbortButton() {
        // Remove existing button if any
        this.hideAbortButton();

        const btn = document.createElement('button');
        btn.id = 'workflow-abort-btn';
        btn.className = 'workflow-abort-btn';
        btn.innerHTML = '⏹ Abort Workflow';
        btn.onclick = () => this.abortWorkflow();

        // Add to canvas area
        const canvas = document.querySelector('.workflow-canvas');
        if (canvas) {
            canvas.appendChild(btn);
        }
    }

    /**
     * Hide abort button
     */
    hideAbortButton() {
        const btn = document.getElementById('workflow-abort-btn');
        if (btn) btn.remove();
    }

    /**
     * Show reset button after workflow completion or error
     * Positioned in header area (top right) next to Workflow Settings
     * @param {object} tokenInfo - Optional token info {input: number, output: number, total: number}
     */
    showResetButton(tokenInfo = null) {
        // Remove existing button if any
        this.hideResetButton();

        // Create container for button and stats (horizontal layout)
        const container = document.createElement('div');
        container.id = 'workflow-reset-container';
        container.className = 'workflow-reset-container';

        // Add token stats first (appears on left side)
        if (tokenInfo && (tokenInfo.input > 0 || tokenInfo.output > 0)) {
            const stats = document.createElement('div');
            stats.id = 'workflow-token-stats';
            stats.className = 'workflow-token-stats';
            stats.innerHTML = `<span class="token-in">In: ${tokenInfo.input.toLocaleString()}</span> <span class="token-out">Out: ${tokenInfo.output.toLocaleString()}</span> <span class="token-total">Total: ${tokenInfo.total.toLocaleString()}</span>`;
            container.appendChild(stats);
        }

        // Add reset button (appears on right side)
        const btn = document.createElement('button');
        btn.id = 'workflow-reset-btn';
        btn.className = 'workflow-reset-btn';
        btn.innerHTML = '↺ Reset';
        btn.onclick = () => {
            this.resetNodeStates();
            this.hideResetButton();
        };
        container.appendChild(btn);

        // Add to canvas area (positioned at top right via CSS)
        const canvas = document.querySelector('.workflow-canvas');
        if (canvas) {
            canvas.appendChild(container);
        }
    }

    /**
     * Hide reset button
     */
    hideResetButton() {
        const container = document.getElementById('workflow-reset-container');
        if (container) container.remove();
        // Also remove standalone button (backwards compatibility)
        const btn = document.getElementById('workflow-reset-btn');
        if (btn) btn.remove();
    }

    /**
     * Abort the currently running workflow
     */
    abortWorkflow() {
        if (this.executionState?.abortController) {
            console.log('[WorkflowEditor] Aborting workflow...');
            this.executionState.abortController.abort();
            this.hideAbortButton();
            this.resetNodeStates();

            // Clear all node timers
            if (this.executionState.nodeTimers) {
                for (const [nodeId, timerInfo] of this.executionState.nodeTimers) {
                    clearInterval(timerInfo.interval);
                }
                this.executionState.nodeTimers.clear();
            }
        }
    }

    /**
     * Clear the workflow canvas
     * @param {boolean} skipConfirm - If true, don't ask for confirmation
     */
    clearWorkflow(skipConfirm = false) {
        // Check if there are any nodes
        const data = this.editor.export();
        const nodes = data.drawflow?.Home?.data || {};
        const hasNodes = Object.keys(nodes).length > 0;

        if (hasNodes && !skipConfirm) {
            if (!confirm(this.t('workflow.dialogs.confirmClearWorkflow'))) {
                return;
            }
        }

        this.editor.clear();
        this.currentWorkflowId = null;
        this.currentWorkflowName = '';
        this.currentWorkflowDescription = '';

        // Update workflow info box
        this.updateWorkflowInfoBox();

        // Clear stored workflow results, prompt, and schedule
        this.lastWorkflowResults = null;
        this.lastUserPrompt = '';
        this.currentSchedule = null;
        this.nodeExecutionData = {};
        this.updateOutputNodeIndicator(false);
        this.updateStartNodeIndicator(false);

        // Reset output storage settings
        this.outputStorageEnabled = false;
        this.outputFolder = '';

        // Reset schedule setting
        this.scheduleEnabled = false;

        // Update left panel to remove active state
        this.renderSavedWorkflowsList();

        // Show help overlay on empty canvas
        this.showHelpOverlay();

        console.log('[WorkflowEditor] Canvas cleared');
    }

    /**
     * Hide the help overlay on the canvas
     */
    hideHelpOverlay() {
        const overlay = document.getElementById('workflow-help-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
    }

    /**
     * Show the help overlay on the canvas
     */
    showHelpOverlay() {
        const overlay = document.getElementById('workflow-help-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
        }
    }

    /**
     * Toggle a collapsible section in the agents panel
     */
    toggleSection(header) {
        const sectionName = header.dataset.section;
        const content = this.agentsPanel.querySelector(`.workflow-section-content[data-section="${sectionName}"]`);
        const toggle = header.querySelector('.section-toggle');

        if (!content) return;

        const isCollapsed = content.classList.toggle('collapsed');
        toggle.textContent = isCollapsed ? '▶' : '▼';

        // Save state to localStorage
        const collapsedSections = JSON.parse(localStorage.getItem('workflowPanelCollapsed') || '{}');
        collapsedSections[sectionName] = isCollapsed;
        localStorage.setItem('workflowPanelCollapsed', JSON.stringify(collapsedSections));
    }

    /**
     * Escape HTML for display
     */
    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ==========================================
    // AGENT TEMPLATE NODE CONFIGURATION
    // ==========================================

    /**
     * Show configuration modal for Agent Template node
     * Opens the full agent creation form and links it to the workflow node
     */
    showAgentTemplateConfigModal(nodeId) {
        const nodeData = this.editor.getNodeFromId(nodeId);
        console.log('[WorkflowEditor] showAgentTemplateConfigModal - nodeId:', nodeId, 'nodeData:', nodeData);
        console.log('[WorkflowEditor] showAgentTemplateConfigModal - nodeData.data:', nodeData?.data);
        if (!nodeData) return;

        // Check if this node already has an agent configured
        const config = nodeData.data || {};

        // Store the node ID for linking after agent creation (if new)
        this.pendingTemplateNodeId = nodeId;

        console.log('[WorkflowEditor] showAgentTemplateConfigModal - calling showAgentEditForm with agent_id:', config.agent_id, 'nodeId:', nodeId);
        // Pass nodeId to showAgentEditForm so it loads node-specific data
        this.showAgentEditForm(config.agent_id || null, nodeId);
    }

    /**
     * Update workflow node with agent data after agent is saved
     */
    updateWorkflowNodeWithAgent(nodeId, agent) {
        const nodeData = this.editor.getNodeFromId(nodeId);
        if (!nodeData) return;

        // Update node data with all agent fields
        nodeData.data.type = 'agent';
        nodeData.data.agent_id = agent.id;
        nodeData.data.agent_name = agent.name;
        nodeData.data.description = agent.description || '';
        nodeData.data.agent_type = agent.agent_type || 'standard';
        nodeData.data.agent_provider = agent.provider || agent.llm_provider || '';
        nodeData.data.model = agent.model || '';
        nodeData.data.instructions = agent.instructions || '';
        nodeData.data.tools = agent.tools || [];
        nodeData.data.settings = agent.settings || { temperature: 0.7, max_tokens: 4096 };
        nodeData.data.isTemplate = false; // No longer a template, it's configured

        // Update the visual display of the node
        const nodeElement = document.getElementById(`node-${nodeId}`);
        if (nodeElement) {
            const titleElement = nodeElement.querySelector('.node-title');
            const bodyElement = nodeElement.querySelector('.node-body');
            const headerElement = nodeElement.querySelector('.node-header');
            const nodeDiv = nodeElement.querySelector('.workflow-node');

            if (titleElement) {
                titleElement.textContent = agent.name;
            }

            // Update body with proper agent node structure (timer, provider, edit button)
            if (bodyElement) {
                const providerDisplay = agent.provider || agent.llm_provider || '';
                bodyElement.innerHTML = `
                    <span class="node-timer">0:00</span>
                    ${providerDisplay ? `<span class="node-provider">${this.escapeHtml(providerDisplay)}</span>` : ''}
                    <button class="node-edit-btn" data-agent-id="${agent.id}" title="Edit agent">✏️</button>
                `;
            }

            // Change from template yellow to configured style
            if (headerElement) {
                headerElement.style.background = '';
                // Remove config hint if present
                const configHint = headerElement.querySelector('.node-config-hint');
                if (configHint) configHint.remove();
                // Add delete button if not present
                if (!headerElement.querySelector('.node-delete-btn')) {
                    headerElement.insertAdjacentHTML('beforeend', '<button class="node-delete-btn" title="Delete node">×</button>');
                }
            }
            if (nodeDiv) {
                nodeDiv.classList.remove('template', 'configurable');
                nodeDiv.dataset.agentId = agent.id;
            }
        }

        console.log('[WorkflowEditor] Workflow node updated with agent:', nodeId, agent.name);
    }

    /**
     * Show workflow execution results in a modal overlay
     */
    showWorkflowResults(data) {
        // Store the results for later viewing
        this.lastWorkflowResults = data;

        // Update Output node to show results are available
        this.updateOutputNodeIndicator(true);

        // The artifact (if any) goes INSIDE the results modal as a
        // second column rather than calling chat's showArtifactPane,
        // because that pane lives in the chat layout and isn't visible
        // when the user is in the workflow editor view.
        const artifact = this.lastProducedArtifact;

        // Remove existing modal if any
        const existingModal = document.getElementById('workflow-results-modal');
        if (existingModal) existingModal.remove();

        const success = data.success;
        const responseTime = data.response_time_ms || 0;
        const nodesExecuted = data.nodes_executed || 0;
        const nodeOutputs = data.node_outputs || {};
        const totalInputTokens = data.total_input_tokens || 0;
        const totalOutputTokens = data.total_output_tokens || 0;
        const totalTokens = data.total_tokens || (totalInputTokens + totalOutputTokens);

        // Build combined output from agent nodes (frontend merge)
        let output = data.output || '';
        if (!output && nodeOutputs) {
            output = this.mergeAgentOutputs(nodeOutputs);
        }

        // Escape HTML for raw display
        const escapeHtml = (str) => str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        // Build the artifact column header path (mirrors the chat
        // artifact pane convention so the user sees a consistent
        // "where does the file live" label).
        let artifactPath = '';
        if (artifact) {
            const rootName = window.chatApp?._fsaRootName || 'storage';
            const rel = artifact.relPath || '';
            artifactPath = rel.startsWith('/')
                ? `${rootName}${rel}`
                : `${rootName}/skills/${artifact.dirName}/${rel}`;
        }

        const containerClass = artifact ? 'workflow-results-container with-artifact' : 'workflow-results-container';

        // Create modal HTML - only show final output
        const modalHtml = `
            <div id="workflow-results-modal" class="workflow-results-overlay">
                <div class="${containerClass}">
                    <div class="workflow-results-header">
                        <h2>${success ? '✓ Workflow Completed' : '❌ Workflow Failed'}</h2>
                        <div class="workflow-results-header-actions">
                            <button id="workflow-save-pdf-btn" class="workflow-action-btn" title="Save the result as a PDF (choose 'Save as PDF' in the print dialog)">
                                📄 Save as PDF
                            </button>
                            <button id="workflow-save-md-btn" class="workflow-action-btn" title="Download the result as a Markdown (.md) file">
                                📝 Save as .md
                            </button>
                            <button id="workflow-print-btn" class="workflow-action-btn" title="Print Results">
                                🖨️ Print
                            </button>
                            <button id="workflow-raw-toggle" class="workflow-action-btn" title="Toggle Raw Markdown">
                                Raw Format
                            </button>
                            <button class="workflow-results-close" type="button" aria-label="Close" title="Close">×</button>
                        </div>
                    </div>
                    <div class="workflow-results-meta">
                        <span>⏱️ ${(responseTime / 1000).toFixed(1)}s</span>
                        <span>📊 ${nodesExecuted} nodes executed</span>
                        ${totalTokens > 0 ? `<span class="workflow-token-info">🎯 <span class="tok-in">In: ${totalInputTokens.toLocaleString()}</span> <span class="tok-out">Out: ${totalOutputTokens.toLocaleString()}</span> <span class="tok-total">Total: ${totalTokens.toLocaleString()}</span></span>` : ''}
                    </div>
                    <div class="workflow-results-body">
                        <div class="workflow-result-final">
                            <div id="workflow-rendered-content" class="workflow-result-content markdown-content">
                                ${output ? this.formatMarkdown(output) : '<em>No output generated</em>'}
                            </div>
                            <div id="workflow-raw-content" class="workflow-result-content workflow-raw-content" style="display: none;">
                                <pre>${output ? escapeHtml(output) : 'No output'}</pre>
                            </div>
                        </div>
                        ${artifact ? `
                        <div class="workflow-result-artifact">
                            <div class="workflow-artifact-header">
                                <span class="workflow-artifact-icon">📄</span>
                                <span class="workflow-artifact-label">Output</span>
                                <span class="workflow-artifact-path" title="${escapeHtml(artifactPath)}">${escapeHtml(artifactPath)}</span>
                            </div>
                            <div id="workflow-artifact-content" class="workflow-artifact-content"></div>
                        </div>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;

        // Add styles if not already present
        if (!document.getElementById('workflow-results-styles')) {
            const styles = document.createElement('style');
            styles.id = 'workflow-results-styles';
            styles.textContent = `
                .workflow-results-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                }
                .workflow-results-container {
                    background: white;
                    border-radius: 12px;
                    width: 90%;
                    max-width: 800px;
                    max-height: 90vh;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                }
                /* When a skill produced a renderable artifact, widen the
                   modal and turn the body into a 2-column layout: LM
                   response on the left, processed document on the right. */
                .workflow-results-container.with-artifact {
                    max-width: 1280px;
                    height: 90vh;
                }
                .workflow-results-container.with-artifact .workflow-results-body {
                    display: flex;
                    flex-direction: row;
                    gap: 16px;
                    padding: 16px;
                    min-height: 0;
                }
                .workflow-results-container.with-artifact .workflow-result-final {
                    flex: 1 1 0;
                    min-width: 0;
                    overflow-y: auto;
                    padding-right: 4px;
                }
                .workflow-result-artifact {
                    flex: 1 1 0;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    border: 1px solid #fde68a;
                    border-radius: 8px;
                    overflow: hidden;
                    background: #fffbeb;
                }
                .workflow-artifact-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 8px 12px;
                    background: linear-gradient(to right, #fef3c7, #fde68a);
                    border-bottom: 1px solid #fcd34d;
                    flex-shrink: 0;
                }
                .workflow-artifact-icon { font-size: 14px; color: #b45309; }
                .workflow-artifact-label {
                    font-size: 13px;
                    font-weight: 600;
                    color: #78350f;
                    flex-shrink: 0;
                }
                .workflow-artifact-path {
                    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
                    font-size: 11px;
                    color: #92400e;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-width: 0;
                }
                .workflow-artifact-content {
                    flex: 1 1 auto;
                    min-height: 0;
                    background: white;
                    overflow: hidden;
                }
                .workflow-results-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 16px 20px;
                    border-bottom: 1px solid #e5e7eb;
                    background: #f9fafb;
                }
                .workflow-results-header h2 {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 600;
                }
                .workflow-results-header-actions {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .workflow-action-btn {
                    padding: 6px 12px;
                    font-size: 12px;
                    font-weight: 500;
                    border: 1px solid #d1d5db;
                    border-radius: 6px;
                    background: white;
                    color: #374151;
                    cursor: pointer;
                    transition: all 0.2s ease;
                }
                .workflow-action-btn:hover {
                    background: #f3f4f6;
                    border-color: #9ca3af;
                }
                .workflow-action-btn.active {
                    background: #3b82f6;
                    color: white;
                    border-color: #3b82f6;
                }
                @media print {
                    /* Hide everything except the modal */
                    body > *:not(#workflow-results-modal) {
                        display: none !important;
                    }

                    /* Reset modal positioning for print */
                    #workflow-results-modal {
                        position: static !important;
                        width: 100% !important;
                        height: auto !important;
                        background: white !important;
                        overflow: visible !important;
                    }

                    .workflow-results-overlay {
                        position: static !important;
                        background: none !important;
                        display: block !important;
                        overflow: visible !important;
                        height: auto !important;
                    }

                    .workflow-results-container {
                        position: static !important;
                        width: 100% !important;
                        max-width: none !important;
                        max-height: none !important;
                        height: auto !important;
                        overflow: visible !important;
                        box-shadow: none !important;
                        border-radius: 0 !important;
                    }

                    .workflow-results-header-actions,
                    .workflow-results-close {
                        display: none !important;
                    }

                    .workflow-results-body {
                        overflow: visible !important;
                        height: auto !important;
                        max-height: none !important;
                        flex: none !important;
                    }

                    .workflow-result-final,
                    .workflow-result-content,
                    #workflow-rendered-content {
                        overflow: visible !important;
                        height: auto !important;
                        max-height: none !important;
                    }

                    .workflow-raw-content {
                        display: none !important;
                    }

                    /* Allow content to break across pages */
                    .workflow-result-content {
                        page-break-inside: auto;
                    }

                    h2, h3, h4 {
                        page-break-after: avoid;
                    }

                    pre, table {
                        page-break-inside: avoid;
                    }
                }
                .workflow-raw-content pre {
                    margin: 0;
                    padding: 16px;
                    background: #1f2937;
                    color: #e5e7eb;
                    border-radius: 8px;
                    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
                    font-size: 13px;
                    line-height: 1.5;
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    overflow-x: auto;
                }
                .workflow-results-close {
                    background: none;
                    border: none;
                    font-size: 24px;
                    cursor: pointer;
                    color: #6b7280;
                    padding: 0;
                    line-height: 1;
                }
                .workflow-results-close:hover {
                    color: #111827;
                }
                .workflow-results-meta {
                    padding: 12px 20px;
                    background: #f3f4f6;
                    display: flex;
                    gap: 20px;
                    font-size: 14px;
                    color: #6b7280;
                }
                .workflow-results-body {
                    padding: 20px;
                    overflow-y: auto;
                    flex: 1;
                }
                .workflow-result-final {
                    padding: 0;
                    background: white;
                    border-radius: 8px;
                }
                .workflow-result-final h3 {
                    margin: 0 0 12px 0;
                    font-size: 14px;
                    font-weight: 600;
                    color: #374151;
                }
                .workflow-result-content {
                    font-size: 14px;
                    line-height: 1.6;
                    color: #1f2937;
                }
                .workflow-result-nodes h3 {
                    margin: 0 0 16px 0;
                    font-size: 14px;
                    font-weight: 600;
                    color: #374151;
                }
                .workflow-result-node {
                    margin-bottom: 16px;
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    overflow: hidden;
                }
                .workflow-result-node-header {
                    padding: 10px 14px;
                    background: #f9fafb;
                    border-bottom: 1px solid #e5e7eb;
                    font-weight: 500;
                    font-size: 13px;
                    display: flex;
                    gap: 8px;
                    align-items: center;
                    cursor: pointer;
                    user-select: none;
                    transition: background 0.2s ease;
                }
                .workflow-result-node-header:hover {
                    background: #f3f4f6;
                }
                .workflow-result-node-header .collapse-icon {
                    font-size: 10px;
                    color: #6b7280;
                    transition: transform 0.2s ease;
                    width: 12px;
                }
                .workflow-result-node-header .node-preview {
                    flex: 1;
                    text-align: right;
                    color: #9ca3af;
                    font-weight: 400;
                    font-size: 12px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .workflow-result-node-content {
                    padding: 14px;
                    font-size: 13px;
                    line-height: 1.6;
                    max-height: 400px;
                    overflow-y: auto;
                    transition: max-height 0.3s ease, padding 0.3s ease, opacity 0.2s ease;
                }
                .workflow-result-node-content.collapsed {
                    max-height: 0;
                    padding: 0 14px;
                    opacity: 0;
                    overflow: hidden;
                }
                .workflow-result-node-content pre {
                    background: #f3f4f6;
                    padding: 12px;
                    border-radius: 6px;
                    overflow-x: auto;
                }
                .workflow-result-node-content code {
                    background: #e5e7eb;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 12px;
                }
                /* Markdown content styling */
                .markdown-content {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                .markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4 {
                    margin-top: 1.5em;
                    margin-bottom: 0.5em;
                    font-weight: 600;
                    line-height: 1.3;
                }
                .markdown-content h1 { font-size: 1.5em; }
                .markdown-content h2 { font-size: 1.3em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
                .markdown-content h3 { font-size: 1.1em; }
                .markdown-content h4 { font-size: 1em; }
                .markdown-content p { margin: 0.8em 0; }
                .markdown-content ul, .markdown-content ol { margin: 0.8em 0; padding-left: 1.5em; }
                .markdown-content li { margin: 0.3em 0; }
                .markdown-content strong { font-weight: 600; }
                .markdown-content em { font-style: italic; }
                .markdown-content hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
                .markdown-content pre {
                    background: #f3f4f6;
                    padding: 12px;
                    border-radius: 6px;
                    overflow-x: auto;
                    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
                    font-size: 13px;
                }
                .markdown-content code {
                    background: #e5e7eb;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 0.9em;
                    font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
                }
                .markdown-content pre code {
                    background: none;
                    padding: 0;
                }
                .markdown-content blockquote {
                    border-left: 4px solid #e5e7eb;
                    margin: 1em 0;
                    padding-left: 1em;
                    color: #6b7280;
                }
            `;
            document.head.appendChild(styles);
        }

        // Insert modal into DOM
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Fix SVG viewBoxes after rendering (same as chat does)
        const modal = document.getElementById('workflow-results-modal');
        if (modal && window.chatApp?.fixAllSVGsInContainer) {
            window.chatApp.fixAllSVGsInContainer(modal);
        }

        // Bind close handler. Inline onclick="" attributes are blocked by
        // the PWA build's stricter CSP, so the X did nothing in installed-
        // app mode. Also wire Escape + click-on-overlay to close, matching
        // typical modal UX.
        const closeModal = () => {
            const m = document.getElementById('workflow-results-modal');
            if (m) m.remove();
            document.removeEventListener('keydown', escHandler);
        };
        const escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
        modal?.querySelector('.workflow-results-close')
            ?.addEventListener('click', closeModal);
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        document.addEventListener('keydown', escHandler);

        // Populate the artifact column. HTML goes through a sandboxed
        // iframe (no scripts, no same-origin) so a malicious skill
        // can't read parent-page state. Markdown goes through the
        // existing in-app renderer.
        if (artifact) {
            const artifactHost = document.getElementById('workflow-artifact-content');
            if (artifactHost) {
                if (artifact.kind === 'html') {
                    const iframe = document.createElement('iframe');
                    iframe.setAttribute('sandbox', '');
                    iframe.style.cssText = 'width:100%; height:100%; border:0; background:white;';
                    iframe.srcdoc = artifact.content || '';
                    artifactHost.appendChild(iframe);
                } else if (artifact.kind === 'markdown') {
                    const wrap = document.createElement('div');
                    wrap.className = 'markdown-content';
                    wrap.style.cssText = 'padding:16px; height:100%; overflow:auto; background:white;';
                    wrap.innerHTML = this.formatMarkdown(artifact.content || '');
                    artifactHost.appendChild(wrap);
                }
            }
        }

        // Add raw/rendered toggle handler
        const rawToggleBtn = document.getElementById('workflow-raw-toggle');
        const renderedContent = document.getElementById('workflow-rendered-content');
        const rawContent = document.getElementById('workflow-raw-content');

        if (rawToggleBtn && renderedContent && rawContent) {
            rawToggleBtn.addEventListener('click', () => {
                const isRawVisible = rawContent.style.display !== 'none';
                if (isRawVisible) {
                    // Switch to rendered
                    rawContent.style.display = 'none';
                    renderedContent.style.display = 'block';
                    rawToggleBtn.textContent = 'Raw Format';
                    rawToggleBtn.classList.remove('active');
                } else {
                    // Switch to raw
                    renderedContent.style.display = 'none';
                    rawContent.style.display = 'block';
                    rawToggleBtn.textContent = 'Rendered';
                    rawToggleBtn.classList.add('active');
                }
            });
        }

        // Add print button handler
        const printBtn = document.getElementById('workflow-print-btn');
        if (printBtn) {
            printBtn.addEventListener('click', () => {
                window.print();
            });
        }

        // Save as PDF — uses the existing print CSS path. The browser
        // print dialog exposes "Save as PDF" as a destination on all
        // modern browsers (Chrome/Safari/Edge/Firefox), giving the user
        // a high-quality, selectable-text PDF without an extra library.
        const savePdfBtn = document.getElementById('workflow-save-pdf-btn');
        if (savePdfBtn) {
            savePdfBtn.addEventListener('click', () => {
                window.print();
            });
        }

        // Save as Markdown — downloads the raw output content as a
        // .md file using a Blob + object URL. One-click, no library.
        const saveMdBtn = document.getElementById('workflow-save-md-btn');
        if (saveMdBtn) {
            saveMdBtn.addEventListener('click', () => {
                this.downloadResultsAsMarkdown(output);
            });
        }

        // Add click handlers for collapsible sections
        modal?.querySelectorAll('.workflow-result-node-header.collapsible').forEach(header => {
            header.addEventListener('click', () => {
                const targetId = header.dataset.target;
                const content = document.getElementById(targetId);
                const icon = header.querySelector('.collapse-icon');
                const preview = header.querySelector('.node-preview');

                if (content) {
                    const isCollapsed = content.classList.toggle('collapsed');
                    if (icon) {
                        icon.textContent = isCollapsed ? '▶' : '▼';
                    }
                    if (preview) {
                        preview.style.display = isCollapsed ? 'block' : 'none';
                    }
                }
            });
        });

        // Hide preview for expanded sections
        modal?.querySelectorAll('.workflow-result-node-content:not(.collapsed)').forEach(content => {
            const header = content.previousElementSibling;
            const preview = header?.querySelector('.node-preview');
            if (preview) {
                preview.style.display = 'none';
            }
        });
    }

    /**
     * Download the workflow results as a Markdown (.md) file.
     * Filename is derived from the current workflow name (slugified)
     * and a timestamp so repeated saves don't collide.
     *
     * @param {string} markdown - The raw markdown content to save
     */
    downloadResultsAsMarkdown(markdown) {
        if (!markdown || !markdown.trim()) {
            this.showToast(this.t('workflow.fileStorage.noContentToSave'), 'warning');
            return;
        }

        // Build a safe, descriptive filename
        const slug = (this.currentWorkflowName || 'workflow-results')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'workflow-results';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `${slug}_${ts}.md`;

        // Trigger a Blob download via a temporary anchor
        try {
            const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            // Release the object URL on the next tick to give the
            // browser time to start the download
            setTimeout(() => URL.revokeObjectURL(url), 0);
            this.showToast(this.t('workflow.fileStorage.fileSaved', { filename }), 'success');
        } catch (err) {
            console.error('[WorkflowEditor] downloadResultsAsMarkdown failed:', err);
            this.showToast(this.t('workflow.fileStorage.saveFileFailed'), 'error');
        }
    }

    /**
     * Truncate text for preview display
     */
    truncateText(text, maxLength) {
        if (!text) return '';
        // Remove markdown formatting and newlines for preview
        const clean = text.replace(/[#*_`\[\]]/g, '').replace(/\n/g, ' ').trim();
        if (clean.length <= maxLength) return clean;
        return clean.substring(0, maxLength) + '...';
    }

    /**
     * Merge agent outputs from node_outputs (frontend fallback)
     * Used when backend doesn't provide combined output
     */
    mergeAgentOutputs(nodeOutputs) {
        const agentOutputs = [];

        for (const [nodeId, nodeData] of Object.entries(nodeOutputs)) {
            // Only include agent type nodes with output
            if (nodeData.type === 'agent' && nodeData.output) {
                const agentName = nodeData.agent_name || `Agent ${nodeId}`;
                agentOutputs.push(`## 📄 ${agentName}\n\n${nodeData.output}`);
            }
        }

        return agentOutputs.join('\n\n---\n\n');
    }

    /**
     * Check if text appears to be HTML content
     * Returns true if the text looks like HTML output rather than markdown
     */
    isHtmlContent(text) {
        if (!text) return false;

        const trimmed = text.trim();

        // Check for common HTML document patterns
        if (/^<!DOCTYPE\s+html/i.test(trimmed)) return true;
        if (/^<html[\s>]/i.test(trimmed)) return true;

        // Check if content starts with common HTML block elements
        const htmlStartPatterns = [
            /^<article[\s>]/i,
            /^<section[\s>]/i,
            /^<div[\s>]/i,
            /^<header[\s>]/i,
            /^<main[\s>]/i,
            /^<body[\s>]/i,
            /^<table[\s>]/i,
            /^<style[\s>]/i
        ];

        for (const pattern of htmlStartPatterns) {
            if (pattern.test(trimmed)) return true;
        }

        // Check for significant HTML structure (multiple tags with attributes)
        // This detects content that has substantial HTML markup
        const htmlTagCount = (trimmed.match(/<[a-z][a-z0-9]*(?:\s+[^>]*)?>/gi) || []).length;
        const closingTagCount = (trimmed.match(/<\/[a-z][a-z0-9]*>/gi) || []).length;

        // If we have many HTML tags (more than typical markdown might generate)
        // and a good balance of opening/closing tags, it's likely HTML content
        if (htmlTagCount > 10 && closingTagCount > 5) {
            // Check for HTML-specific attributes that markdown wouldn't generate
            const hasHtmlAttributes = /class=["'][^"']+["']|style=["'][^"']+["']|id=["'][^"']+["']/i.test(trimmed);
            if (hasHtmlAttributes) return true;
        }

        return false;
    }

    /**
     * Format markdown text to HTML
     * Uses the same renderer as the chat for consistent formatting
     * Detects HTML content and passes it through without markdown processing
     */
    formatMarkdown(text) {
        if (!text) return '';
        if (this.isHtmlContent(text)) return text;
        return window.renderMarkdown(text);
    }

    /**
     * Open dialog to add a new agent
     */
    openAddAgentDialog() {
        this.showAgentEditForm(null);
    }

    // ==========================================
    // AGENT EDIT FORM
    // ==========================================

    /**
     * Load providers from API
     */
    async loadProviders() {
        if (this.providersLoaded) return;

        try {
            const response = await fetch(`${this.apiBase}/providers?_=${Date.now()}`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const data = await response.json();
                this.providers = data.providers || data || [];
                this.providersLoaded = true;
            }
        } catch (error) {
            console.error('[WorkflowEditor] Error loading providers:', error);
            this.providers = [];
        }
    }

    /**
     * Load available tools from API
     */
    async loadTools() {
        if (this.toolsLoaded) return;

        try {
            const response = await fetch(`${this.apiBase}/tools`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const data = await response.json();
                this.availableTools = data.tools || data || [];
                this.toolsLoaded = true;
            }
        } catch (error) {
            console.error('[WorkflowEditor] Error loading tools:', error);
            this.availableTools = [];
        }
    }

    /**
     * Load reusable workflow output schemas from API
     */
    async loadWorkflowSchemas(force = false) {
        if (this.workflowSchemasLoaded && !force) return;
        try {
            const response = await fetch(`${this.apiBase}/workflow-schemas`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const data = await response.json();
                this.workflowSchemas = data.data || [];
                this.workflowSchemasLoaded = true;
            }
        } catch (error) {
            console.error('[WorkflowEditor] Error loading workflow schemas:', error);
            this.workflowSchemas = [];
        }
    }

    /**
     * Show the agent edit form modal
     * @param {string|null} agentId - The agent ID to edit
     * @param {string|null} nodeId - The workflow node ID (if editing a node's config)
     */
    async showAgentEditForm(agentId, nodeId = null) {
        // Load providers, tools, and (when editing a node) workflow schemas
        const loadPromises = [this.loadProviders(), this.loadTools()];
        if (nodeId) {
            loadPromises.push(this.loadWorkflowSchemas());
        }
        await Promise.all(loadPromises);

        // Store the node ID for saving node-specific config
        this.editingNodeId = nodeId;

        // Cancel any pending structure-save timer. A background saveWorkflow()
        // call would trigger loadWorkflow() which clears and rebuilds the canvas,
        // invalidating editingNodeId and causing the non-node (library) path to
        // run instead of the canvas-node path — dropping the disabled flag.
        if (nodeId) {
            clearTimeout(this._structureSaveTimer);
            this._structureSaveTimer = null;
        }

        // If we have no live execution data for this node (e.g. the editor was
        // reopened, the SSE dropped, or the run died), pull it from the
        // persisted run log so Input/Output/Logs are still debuggable.
        const _hasLive = this.nodeExecutionData?.[nodeId] &&
            (this.nodeExecutionData[nodeId].input != null ||
             this.nodeExecutionData[nodeId].output != null ||
             Array.isArray(this.nodeExecutionData[nodeId].logs));
        if (!_hasLive) {
            const wfKey = this.currentWorkflowId || 'unsaved';
            const runId = this.currentRunId || (() => {
                try { return localStorage.getItem('lastRunId:' + wfKey); } catch (e) { return null; }
            })();
            if (runId) {
                this.hydrateNodeDataFromRun(runId).then((ok) => {
                    if (ok) this.updateModalInputOutput(nodeId);
                });
            }
        }

        // Find the agent if editing
        let agent = null;
        if (agentId) {
            agent = this.agents.find(a => String(a.id) === String(agentId));
        }

        // Create new agent template if not found
        if (!agent) {
            const defaultProvider = this.providers.length > 0 ? this.providers[0].name : '';
            agent = {
                id: null,
                name: '',
                description: '',
                agent_type: 'worker',
                provider: defaultProvider,
                model: '',
                instructions: '',
                tools: [],
                settings: { temperature: 0.7, max_tokens: 4096 }
            };
        }

        // If editing a node, load all node-specific data
        if (nodeId) {
            const nodeData = this.editor.getNodeFromId(nodeId);
            console.log('[WorkflowEditor] showAgentEditForm - nodeId:', nodeId, 'nodeData:', nodeData);
            console.log('[WorkflowEditor] showAgentEditForm - nodeData.data:', nodeData?.data);
            if (nodeData && nodeData.data) {
                const data = nodeData.data;

                // Check if this node has been configured locally (no longer a template)
                // If isTemplate is explicitly false, use ONLY node data - no fallback to template
                const useOnlyNodeData = data.isTemplate === false;

                if (useOnlyNodeData) {
                    // Node has local configuration - use only its data, no template fallback
                    console.log('[WorkflowEditor] Node has local config (isTemplate=false), using only node data');
                    agent = {
                        id: data.agent_id ?? null,
                        name: data.agent_name ?? '',
                        description: data.description ?? '',
                        agent_type: data.agent_type ?? 'worker',
                        provider: data.agent_provider ?? '',
                        model: data.model ?? '',
                        instructions: data.instructions ?? '',
                        tools: Array.isArray(data.tools) ? data.tools : [],
                        settings: data.settings ?? { temperature: 0.7, max_tokens: 4096 },
                        merge_strategy: data.merge_strategy ?? 'labeled',
                        output_schema_id: data.output_schema_id ?? null,
                        output_schema: data.output_schema ?? null,
                        // Read disabled from flat data (post-reload path) OR from
                        // nested data.config (legacy/edge-case path).
                        disabled: data.disabled ?? data.config?.disabled ?? false
                    };
                } else {
                    // Node is still a template or unconfigured - fall back to template data
                    console.log('[WorkflowEditor] Node is template/unconfigured, using template fallback');
                    agent = {
                        id: data.agent_id || agent?.id || null,
                        name: data.agent_name || agent?.name || '',
                        description: data.description || agent?.description || '',
                        agent_type: data.agent_type || agent?.agent_type || 'worker',
                        provider: data.agent_provider || agent?.provider || '',
                        model: data.model || agent?.model || '',
                        instructions: data.instructions || agent?.instructions || '',
                        tools: Array.isArray(data.tools) ? data.tools : (agent?.tools || []),
                        settings: data.settings || agent?.settings || { temperature: 0.7, max_tokens: 4096 },
                        merge_strategy: data.merge_strategy ?? 'labeled',
                        output_schema_id: data.output_schema_id ?? null,
                        output_schema: data.output_schema ?? null,
                        disabled: data.disabled ?? data.config?.disabled ?? false
                    };
                }
                console.log('[WorkflowEditor] Loaded agent data:', agent);
            }
        }

        this.editingAgent = agent;

        // Create and show modal
        this.createAgentEditModal(agent);
    }

    /**
     * Create the agent edit modal
     */
    createAgentEditModal(agent) {
        // Remove existing modal if any
        const existingModal = document.getElementById('agent-edit-modal');
        if (existingModal) existingModal.remove();

        const isNew = !agent.id;

        // Build provider options
        const providersOptions = this.providers.map(p =>
            `<option value="${p.name}" ${agent.provider === p.name ? 'selected' : ''}>${p.display_name || p.name}</option>`
        ).join('');

        // Build tools checkboxes
        const toolsHTML = this.availableTools.map(tool => `
            <label class="flex items-center gap-2 p-1.5 hover:bg-gray-100 rounded cursor-pointer" title="${tool.description || tool.name}">
                <input type="checkbox" class="tool-checkbox w-3.5 h-3.5 text-blue-600 rounded"
                       data-tool="${tool.name}" ${agent.tools?.includes(tool.name) ? 'checked' : ''}>
                <span class="text-xs text-gray-700 truncate">${tool.name}</span>
            </label>
        `).join('');

        const tf = (key) => this.t('workflow.agentForm.' + key);
        const modalHTML = `
            <div id="agent-edit-modal" class="fixed inset-0 z-[200] flex items-center justify-center" style="background-color: rgba(0, 0, 0, 0.5);">
                <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-4xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
                    <!-- Modal Header -->
                    <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
                        <h3 id="agent-modal-title" class="text-base font-semibold text-gray-800 truncate pr-4">
                            ${this.escapeHtml(agent.name || '') || (isNew ? tf('createTitle') : tf('editTitle'))}
                        </h3>
                        <button id="close-agent-modal" class="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition">
                            ✕
                        </button>
                    </div>

                    <!-- Modal Body -->
                    <div class="flex-1 overflow-y-auto p-4">
                        <!-- Tab Bar -->
                        <!-- Settings + System Prompt show in both modes (library + workflow node);
                             remaining tabs are node-runtime concepts and stay workflow-only. -->
                        <div class="flex border-b border-gray-200 mb-4">
                            <button id="tab-settings" class="agent-modal-tab px-4 py-2 text-sm font-medium text-blue-600 border-b-2 border-blue-600 -mb-px">
                                ${tf('tabs.settings')}
                            </button>
                            <button id="tab-system-prompt" class="agent-modal-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent">
                                ${tf('tabs.systemPrompt') || 'System Prompt'}
                            </button>
                            ${this.editingNodeId ? `
                            <button id="tab-skills" class="agent-modal-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent">
                                ${tf('tabs.skills') || 'Skills'}
                            </button>
                            <button id="tab-schema" class="agent-modal-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent">
                                ${tf('tabs.outputSchema')}
                            </button>
                            <button id="tab-input" class="agent-modal-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent">
                                ${tf('tabs.inputContent')}
                            </button>
                            <button id="tab-output" class="agent-modal-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent">
                                ${tf('tabs.outputResponse')}
                            </button>
                            <button id="tab-statistics" class="agent-modal-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent">
                                ${tf('tabs.statistics')}
                            </button>
                            <button id="tab-logs" class="agent-modal-tab px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 border-b-2 border-transparent">
                                ${tf('tabs.logs') || 'Logs'}
                            </button>
                            ` : ''}
                        </div>

                        <!-- Settings Tab Content -->
                        <div id="settings-tab-content" class="tab-content">
                        <div class="grid grid-cols-2 gap-6" data-agent-id="${agent.id || 'new'}">
                            <!-- Left Column: Agent Settings -->
                            <div class="space-y-4">
                                <!-- Type and Name -->
                                <div class="grid grid-cols-3 gap-3">
                                    <div>
                                        <label class="block text-sm font-medium text-gray-700 mb-1">${tf('type')}</label>
                                        <select id="agent-type-select" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                            <option value="worker" ${agent.agent_type === 'worker' ? 'selected' : ''}>⚙️ ${tf('typeWorker')}</option>
                                            <option value="standard" ${agent.agent_type === 'standard' ? 'selected' : ''}>🤖 ${tf('typeStandard')}</option>
                                        </select>
                                    </div>
                                    <div class="col-span-2">
                                        <label class="block text-sm font-medium text-gray-700 mb-1">${tf('name')}</label>
                                        <input type="text" id="agent-name-input" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                               value="${this.escapeHtml(agent.name || '')}" placeholder="${tf('namePlaceholder')}">
                                    </div>
                                </div>

                                <!-- Description -->
                                <div>
                                    <label class="block text-sm font-medium text-gray-700 mb-1">${tf('description')}</label>
                                    <input type="text" id="agent-description-input" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                           value="${this.escapeHtml(agent.description || '')}" placeholder="${tf('descriptionPlaceholder')}">
                                </div>

                                <!-- Provider and Model -->
                                <div class="grid grid-cols-2 gap-3">
                                    <div>
                                        <label class="block text-sm font-medium text-gray-700 mb-1">${tf('provider')}</label>
                                        <select id="agent-provider-select" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                                            ${providersOptions}
                                        </select>
                                    </div>
                                    <div>
                                        <label class="block text-sm font-medium text-gray-700 mb-1">${tf('model')}</label>
                                        <input type="text" id="agent-model-input" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                               value="${this.escapeHtml(agent.model || '')}" placeholder="${tf('modelPlaceholder')}">
                                    </div>
                                </div>

                                <!-- System Prompt now always lives in its own tab; the inline
                                     textarea here was removed so we don't render duplicate
                                     #agent-instructions-input elements. -->


                                <!-- Temperature and Max Tokens -->
                                <div class="grid grid-cols-2 gap-3">
                                    <div>
                                        <label class="block text-sm font-medium text-gray-700 mb-1">
                                            ${tf('temperature')}: <span id="temperature-value">${agent.settings?.temperature || 0.7}</span>
                                        </label>
                                        <input type="range" id="agent-temperature-input" class="w-full" min="0" max="1" step="0.1"
                                               value="${agent.settings?.temperature || 0.7}">
                                    </div>
                                    <div>
                                        <label class="block text-sm font-medium text-gray-700 mb-1">${tf('maxTokens')}</label>
                                        <input type="number" id="agent-max-tokens-input" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                               value="${agent.settings?.max_tokens || 4096}" min="256" max="128000">
                                    </div>
                                </div>

                                <!-- Save as Template (shown when editing workflow node) -->
                                ${this.editingNodeId || this.pendingTemplateNodeId ? `
                                <div class="border-t border-gray-200 pt-4 mt-2">
                                    <label class="flex items-center gap-3 cursor-pointer">
                                        <input type="checkbox" id="save-as-template-checkbox" class="w-4 h-4 text-green-600 rounded focus:ring-green-500">
                                        <div>
                                            <span class="text-sm font-medium text-gray-700">${tf('saveAsTemplateLabel')}</span>
                                            <p class="text-xs text-gray-500">${tf('saveAsTemplateDesc')}</p>
                                        </div>
                                    </label>
                                </div>
                                ` : ''}

                                <!-- Disable execution (shown only when editing a workflow node) -->
                                ${this.editingNodeId ? `
                                <div class="border-t border-gray-200 pt-4 mt-2">
                                    <label class="flex items-center gap-3 cursor-pointer">
                                        <input type="checkbox" id="agent-node-disabled" class="w-4 h-4 text-gray-600 rounded focus:ring-gray-500" ${agent.disabled ? 'checked' : ''}>
                                        <div>
                                            <span class="text-sm font-medium text-gray-700">Disable execution</span>
                                            <p class="text-xs text-gray-500">This node is skipped when the workflow runs (returns 'disabled node') — handy for debugging.</p>
                                        </div>
                                    </label>
                                </div>
                                ` : ''}
                            </div>

                            <!-- Right Column: Tools -->
                            <div class="flex flex-col">
                                <div class="flex items-center justify-between mb-2">
                                    <label class="text-sm font-medium text-gray-700">
                                        ${tf('tools')} <span class="text-xs text-gray-400">(<span id="tools-selected-count">${agent.tools?.length || 0}</span> ${tf('toolsSelectedSuffix')})</span>
                                    </label>
                                    <div class="flex gap-2">
                                        <button type="button" id="tools-select-all" class="text-xs text-blue-600 hover:text-blue-800">${tf('toolsSelectAll')}</button>
                                        <span class="text-gray-300">|</span>
                                        <button type="button" id="tools-select-none" class="text-xs text-blue-600 hover:text-blue-800">${tf('toolsClear')}</button>
                                    </div>
                                </div>
                                <div id="tools-content" class="flex-1 border border-gray-200 rounded-lg overflow-y-auto bg-gray-50 p-2" style="max-height: 500px; min-height: 250px;">
                                    <div class="grid grid-cols-2 gap-1">
                                        ${toolsHTML || `<span class="text-gray-400 text-xs">${tf('toolsNoneAvailable')}</span>`}
                                    </div>
                                </div>

                                <!-- Merge Settings (shown when editing workflow node) -->
                                ${this.editingNodeId || this.pendingTemplateNodeId ? `
                                <div class="border-t border-gray-200 pt-3 mt-3">
                                    <div class="flex items-center gap-2 mb-2">
                                        <span style="color: #db2777;">⨃</span>
                                        <span class="text-sm font-medium text-gray-700">${tf('inputMergeStrategy')}</span>
                                    </div>
                                    <div class="flex items-center gap-2">
                                        <select id="agent-merge-strategy-select" style="width: 160px;" class="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-pink-500 text-sm">
                                            <option value="labeled" ${(agent.merge_strategy || 'labeled') === 'labeled' ? 'selected' : ''}>${tf('mergeStrategies.labeled')}</option>
                                            <option value="numbered" ${agent.merge_strategy === 'numbered' ? 'selected' : ''}>${tf('mergeStrategies.numbered')}</option>
                                            <option value="concatenate" ${agent.merge_strategy === 'concatenate' ? 'selected' : ''}>${tf('mergeStrategies.concatenate')}</option>
                                            <option value="xml" ${agent.merge_strategy === 'xml' ? 'selected' : ''}>${tf('mergeStrategies.xml')}</option>
                                            <option value="json" ${agent.merge_strategy === 'json' ? 'selected' : ''}>${tf('mergeStrategies.json')}</option>
                                        </select>
                                        <button type="button" id="merge-strategy-help-btn" class="merge-help-btn" title="${tf('mergeStrategyHelpTitle')}">?</button>
                                    </div>
                                </div>
                                ` : ''}
                            </div>
                        </div>
                        </div><!-- End Settings Tab Content -->

                        <!-- System Prompt Tab Content (always rendered, hidden by default;
                             both library and workflow modes use this single textarea). -->
                        <div id="system-prompt-tab-content" class="tab-content hidden">
                            <label class="block text-sm font-medium text-gray-700 mb-2">${tf('systemPrompt')}</label>
                            <textarea id="agent-instructions-input" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 font-mono"
                                      placeholder="${tf('systemPromptPlaceholder')}"
                                      style="min-height: 500px; resize: vertical; line-height: 1.5;">${this.escapeHtml(agent.instructions || '')}</textarea>
                        </div>

                        ${this.editingNodeId ? `
                        <!-- Skills Tab Content (hidden by default) -->
                        <div id="skills-tab-content" class="tab-content hidden">
                            <div class="space-y-3">
                                <p class="text-xs text-gray-600">
                                    Bind this node to a skill from your library. The node will use the
                                    skill's content at run time — there's no need to copy or edit the
                                    text here. Edit the skill itself in the Skills sidebar to update
                                    every node that uses it.
                                </p>

                                <!-- Currently bound skill (chip). Hidden when none. -->
                                <div id="node-skill-chip" class="hidden flex items-center justify-between gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded">
                                    <div class="flex items-center gap-2 min-w-0">
                                        <span>🎯</span>
                                        <div class="min-w-0">
                                            <div id="node-skill-chip-name" class="text-sm font-medium text-blue-900 truncate"></div>
                                            <div id="node-skill-chip-meta" class="text-[11px] text-blue-700/80 truncate"></div>
                                        </div>
                                    </div>
                                    <button type="button" id="node-skill-chip-clear" class="text-blue-700 hover:bg-blue-100 rounded px-2 py-0.5 text-sm" title="Unbind skill">✕</button>
                                </div>

                                <!-- Picker: search + tree -->
                                <div>
                                    <input id="node-skill-picker-search" type="text" placeholder="Search skills…"
                                           class="w-full text-sm border border-gray-300 rounded px-2 py-1.5 mb-2">
                                    <div id="node-skill-picker-tree" class="border border-gray-200 rounded p-1 max-h-72 overflow-auto bg-gray-50">
                                        <div class="text-center text-gray-400 text-xs py-6">Loading skills…</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        ` : ''}

                        ${this.editingNodeId ? `
                        <!-- Output Schema Tab Content (hidden by default) -->
                        <div id="schema-tab-content" class="tab-content hidden">
                            <div class="space-y-3">
                                <!-- Header / explanation -->
                                <div>
                                    <p class="text-xs text-gray-600">
                                        ${tf('schema.explanation')}
                                    </p>
                                </div>

                                <!-- Load from library -->
                                <div class="flex items-end gap-2">
                                    <div class="flex-1">
                                        <label class="block text-xs font-medium text-gray-700 mb-1">${tf('schema.loadFromLibrary')}</label>
                                        <select id="agent-schema-load-select" class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
                                            <option value="">${tf('schema.buildFromScratch')}</option>
                                            ${(this.workflowSchemas || []).map(s =>
                                                `<option value="${s.id}">${this.escapeHtml(s.name)}</option>`
                                            ).join('')}
                                        </select>
                                    </div>
                                    <label class="flex items-center gap-1.5 text-xs text-gray-700 pb-1.5">
                                        <input id="agent-schema-strict" type="checkbox" class="w-4 h-4" checked>
                                        ${tf('schema.strictMode')}
                                    </label>
                                    <button type="button" id="agent-schema-clear-btn" class="px-2 py-1.5 text-xs text-red-600 hover:text-red-800 border border-red-200 rounded hover:bg-red-50" title="${tf('schema.clearBtnTitle')}">${tf('schema.clearBtn')}</button>
                                </div>

                                <!-- Embedded schema builder (form + JSON tabs) -->
                                <div id="agent-schema-builder-host" class="border border-gray-200 rounded-lg overflow-hidden flex flex-col" style="height: 480px;"></div>

                                <!-- Save to library -->
                                <div class="bg-blue-50 border border-blue-200 rounded p-3">
                                    <label class="flex items-center gap-2 text-sm cursor-pointer">
                                        <input id="agent-schema-save-to-library" type="checkbox" class="w-4 h-4">
                                        <span class="font-medium text-gray-800">${tf('schema.saveToLibrary')}</span>
                                    </label>
                                    <p class="text-xs text-gray-600 mt-1 ml-6">${tf('schema.saveToLibraryDesc')}</p>
                                    <div id="agent-schema-save-name-wrap" class="hidden mt-2 ml-6 grid grid-cols-2 gap-2">
                                        <input id="agent-schema-save-name" type="text" placeholder="${tf('schema.schemaNamePlaceholder')}" class="px-2 py-1.5 border border-gray-300 rounded text-sm">
                                        <input id="agent-schema-save-description" type="text" placeholder="${tf('schema.schemaDescriptionPlaceholder')}" class="px-2 py-1.5 border border-gray-300 rounded text-sm">
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Input Content Tab Content (hidden by default) -->
                        <div id="input-tab-content" class="tab-content hidden">
                            <div class="border border-gray-200 rounded-lg bg-gray-50 p-4" style="min-height: 400px; max-height: 500px; overflow-y: auto;">
                                <label class="block text-sm font-medium text-gray-700 mb-2">${tf('agentInputContent')}</label>
                                <pre id="agent-input-display" class="whitespace-pre-wrap text-sm text-gray-800 font-mono bg-white border border-gray-200 rounded p-3" style="min-height: 350px;">${this.escapeHtml(this.getNodeInputForModal(this.editingNodeId))}</pre>
                            </div>
                        </div>

                        <!-- Output Response Tab Content (hidden by default) -->
                        <div id="output-tab-content" class="tab-content hidden">
                            <div class="border border-gray-200 rounded-lg bg-gray-50 p-4" style="min-height: 400px; max-height: 500px; overflow-y: auto;">
                                <label class="block text-sm font-medium text-gray-700 mb-2">${tf('agentOutputResponse')}</label>
                                <pre id="agent-output-display" class="whitespace-pre-wrap text-sm text-gray-800 font-mono bg-white border border-gray-200 rounded p-3" style="min-height: 350px;">${this.escapeHtml(this.getNodeOutputForModal(this.editingNodeId))}</pre>
                            </div>
                        </div>

                        <!-- Statistics Tab Content (hidden by default) -->
                        <div id="statistics-tab-content" class="tab-content hidden">
                            <div class="border border-gray-200 rounded-lg bg-gray-50 p-4">
                                <div id="agent-statistics-display">
                                    ${this.getNodeStatisticsHtml(this.editingNodeId)}
                                </div>
                            </div>
                        </div>

                        <!-- Logs Tab Content (hidden by default) — node status,
                             error text, and the skill's stdout/log_messages. -->
                        <div id="logs-tab-content" class="tab-content hidden">
                            <div class="border border-gray-200 rounded-lg bg-gray-50 p-4" style="min-height: 400px; max-height: 500px; overflow-y: auto;">
                                <div id="agent-logs-display">
                                    ${this.getNodeLogsHtml(this.editingNodeId)}
                                </div>
                            </div>
                        </div>
                        ` : ''}
                    </div>

                    <!-- Modal Footer — pinned at bottom of the form -->
                    <div class="px-4 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-between flex-shrink-0">
                        <div>
                            ${this.editingNodeId ? `<button id="delete-node-btn" class="text-red-500 hover:text-red-700 text-xs flex items-center gap-1">
                                <span>🗑️</span> ${tf('deleteNode')}
                            </button>` : (!isNew ? `<button id="delete-agent-btn" class="text-red-500 hover:text-red-700 text-xs">${tf('deleteAgent')}</button>` : '')}
                        </div>
                        <div class="flex gap-2">
                            <button id="cancel-agent-btn" class="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-medium transition">
                                ${this.t('common.cancel')}
                            </button>
                            <button id="save-agent-btn" class="px-5 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium text-sm shadow-sm transition">
                                ${this.t('common.save')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        // Set up event listeners
        this.setupAgentModalEvents();

        // If this node failed in the last run, open straight to the Logs tab
        // so the error is visible immediately instead of just a red glow.
        if (this.editingNodeId && this.nodeExecutionData?.[this.editingNodeId]?.success === false) {
            this.switchAgentModalTab('logs');
        }
    }

    /**
     * Set up event listeners for the agent edit modal
     */
    setupAgentModalEvents() {
        const modal = document.getElementById('agent-edit-modal');
        if (!modal) return;

        // Close button
        document.getElementById('close-agent-modal')?.addEventListener('click', () => this.closeAgentEditModal());
        document.getElementById('cancel-agent-btn')?.addEventListener('click', () => this.closeAgentEditModal());

        // Save button
        document.getElementById('save-agent-btn')?.addEventListener('click', () => this.saveAgent());

        // Disable switch: write to the node the INSTANT it's toggled (not only
        // on Save). This makes it survive the slow save→reload cycle — the flag
        // is already in the node's data before any export/persist, so a reload
        // from the DB restores it. Avoids the save-vs-toggle race.
        document.getElementById('agent-node-disabled')?.addEventListener('change', (e) => {
            const on = !!e.target.checked;
            const idStr = String(this.editingNodeId);
            const node = this.editor?.drawflow?.drawflow?.Home?.data?.[idStr];
            if (node && node.data) {
                node.data.disabled = on;
            }
            document.getElementById(`node-${idStr}`)
                ?.querySelector('.workflow-node')
                ?.classList.toggle('node-disabled', on);
        });

        // Delete agent button (for template agents)
        document.getElementById('delete-agent-btn')?.addEventListener('click', () => this.deleteAgent());

        // Delete node button (for workflow nodes)
        document.getElementById('delete-node-btn')?.addEventListener('click', () => this.deleteWorkflowNode());

        // Live-update the modal title to the agent name as the user types
        const nameInput = document.getElementById('agent-name-input');
        const titleEl = document.getElementById('agent-modal-title');
        if (nameInput && titleEl) {
            const tf = (key) => this.t('workflow.agentForm.' + key);
            const fallback = this.editingAgent?.id ? tf('editTitle') : tf('createTitle');
            nameInput.addEventListener('input', (e) => {
                const v = e.target.value.trim();
                titleEl.textContent = v || fallback;
            });
        }

        // Temperature slider
        document.getElementById('agent-temperature-input')?.addEventListener('input', (e) => {
            document.getElementById('temperature-value').textContent = e.target.value;
        });

        // Tools - Select All
        document.getElementById('tools-select-all')?.addEventListener('click', () => {
            const checkboxes = document.querySelectorAll('.tool-checkbox');
            checkboxes.forEach(cb => cb.checked = true);
            this.updateToolsSelectedCount();
        });

        // Tools - Clear All
        document.getElementById('tools-select-none')?.addEventListener('click', () => {
            const checkboxes = document.querySelectorAll('.tool-checkbox');
            checkboxes.forEach(cb => cb.checked = false);
            this.updateToolsSelectedCount();
        });

        // Tools - Update count on checkbox change
        document.querySelectorAll('.tool-checkbox').forEach(cb => {
            cb.addEventListener('change', () => this.updateToolsSelectedCount());
        });

        // Click outside to close
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeAgentEditModal();
            }
        });

        // Tab switching (only present when editing workflow node)
        document.getElementById('tab-settings')?.addEventListener('click', () => {
            this.switchAgentModalTab('settings');
        });
        document.getElementById('tab-system-prompt')?.addEventListener('click', () => {
            this.switchAgentModalTab('system-prompt');
        });
        document.getElementById('tab-skills')?.addEventListener('click', () => {
            this.switchAgentModalTab('skills');
        });
        document.getElementById('tab-schema')?.addEventListener('click', () => {
            this.switchAgentModalTab('schema');
        });
        document.getElementById('tab-input')?.addEventListener('click', () => {
            this.switchAgentModalTab('input');
        });
        document.getElementById('tab-output')?.addEventListener('click', () => {
            this.switchAgentModalTab('output');
        });
        document.getElementById('tab-statistics')?.addEventListener('click', () => {
            this.switchAgentModalTab('statistics');
        });
        document.getElementById('tab-logs')?.addEventListener('click', () => {
            this.switchAgentModalTab('logs');
        });

        // Skills tab: tree-style skill picker. The user picks a skill
        // from the library and the node binds to it by reference (not
        // by copying its content). The bound skill is stored on
        // this._boundSkill until saveAgent reads it. Folder-backed
        // skills are now selectable: the browser ships SKILL.md inline
        // at run start (see _collectClientSkillsForRun) and the runner
        // resolves it via SkillRepository::resolveBoundSkillContent.
        // Caveat: folder-backed skills require the editor to be open
        // when the workflow runs, so they can't be used by scheduled
        // (cron-triggered) executions.
        const pickerTree = document.getElementById('node-skill-picker-tree');
        const chipClearBtn = document.getElementById('node-skill-chip-clear');
        if (pickerTree && window.skillsManager) {
            this._skillPickerHandle = window.skillsManager.renderPickerInto(pickerTree, {
                searchInputId: 'node-skill-picker-search',
                onSelect: (skill) => this._setNodeBoundSkill(skill),
            });
        }
        if (chipClearBtn) {
            chipClearBtn.addEventListener('click', () => this._setNodeBoundSkill(null));
        }
        // Pre-populate from existing node data:
        //   - new shape: node.data.bound_skill = { id, source, dir_name?, name }
        //   - legacy shape: node.data.skill_content (string) → no chip; user
        //     re-binds when they next edit. We don't auto-resolve legacy
        //     content into a chip because we don't know which library
        //     skill it came from (or whether it ever was one).
        try {
            const drawflowNodes = this.editor?.drawflow?.drawflow?.Home?.data || {};
            const nodeData = this.editingNodeId
                ? (drawflowNodes[String(this.editingNodeId)]?.data || {})
                : {};
            if (nodeData.bound_skill && nodeData.bound_skill.id) {
                const cached = nodeData.bound_skill;
                // Folder-backed skills (source='local') have string ids like
                // Filesystem skills only — DB skills no longer exist. The
                // cached binding is authoritative for the picker highlight.
                this._setNodeBoundSkill(cached, /*silent*/ true);
            }
        } catch (_) {}

        // Skills tab: save — always applies to agent; optionally saves to library
        // Merge strategy help button
        document.getElementById('merge-strategy-help-btn')?.addEventListener('click', () => {
            this.showMergeStrategyHelp();
        });

        // Mount the embedded schema builder when editing a workflow node
        if (this.editingNodeId) {
            this.mountAgentNodeSchemaBuilder();
        }
    }

    /**
     * Mount the schema builder into the agent node's Output Schema tab
     * and wire its peripheral controls (Load from library, Save to library,
     * Clear, Strict mode).
     */
    mountAgentNodeSchemaBuilder() {
        const host = document.getElementById('agent-schema-builder-host');
        if (!host) return;

        const agent = this.editingAgent || {};

        // Determine initial schema source from agent state
        // (set up earlier in showAgentEditForm from node data)
        const initialOptions = {
            inline: agent.output_schema || null,
            libraryId: agent.output_schema_id || null,
            strict: true
        };

        this.mountSchemaBuilderInto(host, initialOptions);

        // Strict mode checkbox (separate from builder, controls serialization)
        const strictCb = document.getElementById('agent-schema-strict');
        if (strictCb) {
            strictCb.checked = this.schemaBuilder.strict;
            strictCb.addEventListener('change', () => {
                this.schemaBuilder.strict = strictCb.checked;
                this.updateSchemaJsonPreview();
            });
        }

        // Load from library
        const loadSelect = document.getElementById('agent-schema-load-select');
        if (loadSelect) {
            // Pre-select if loaded from library
            if (initialOptions.libraryId) loadSelect.value = String(initialOptions.libraryId);
            loadSelect.addEventListener('change', (e) => {
                const id = e.target.value;
                if (!id) return;
                const lib = (this.workflowSchemas || []).find(s => String(s.id) === String(id));
                if (!lib) return;
                if (this.schemaBuilder.state.fields.length > 0) {
                    if (!confirm(this.t('workflow.dialogs.confirmLoadSchemaTemplate', { name: lib.name }))) {
                        e.target.value = '';
                        return;
                    }
                }
                const result = this.deserializeJsonSchema(lib.schema_json);
                this.schemaBuilder.state = { fields: result.fields };
                this.schemaBuilder.incompatible = result.incompatible;
                this.schemaBuilder.strict = lib.strict ?? true;
                this.schemaBuilder.rawJson = JSON.stringify(lib.schema_json, null, 2);
                const ta = document.getElementById('schema-raw-json');
                if (ta) ta.value = this.schemaBuilder.rawJson;
                if (strictCb) strictCb.checked = this.schemaBuilder.strict;
                this.renderSchemaBuilder();
            });
        }

        // Clear button — wipes the builder back to empty
        document.getElementById('agent-schema-clear-btn')?.addEventListener('click', () => {
            if (this.schemaBuilder.state.fields.length === 0) return;
            if (!confirm(this.t('workflow.dialogs.confirmRemoveSchemaFromNode'))) return;
            this.clearEmbeddedSchemaBuilder();
            const ls = document.getElementById('agent-schema-load-select');
            if (ls) ls.value = '';
        });

        // Save to library checkbox toggles the name/description inputs
        const saveCb = document.getElementById('agent-schema-save-to-library');
        const saveWrap = document.getElementById('agent-schema-save-name-wrap');
        if (saveCb && saveWrap) {
            saveCb.addEventListener('change', () => {
                if (saveCb.checked) saveWrap.classList.remove('hidden');
                else saveWrap.classList.add('hidden');
            });
        }
    }

    /**
     * Switch between tabs in the agent modal
     * @param {string} tabName - 'settings', 'schema', 'input', 'output', or 'statistics'
     */
    switchAgentModalTab(tabName) {
        const settingsTab = document.getElementById('tab-settings');
        const systemPromptTab = document.getElementById('tab-system-prompt');
        const skillsTab = document.getElementById('tab-skills');
        const schemaTab = document.getElementById('tab-schema');
        const inputTab = document.getElementById('tab-input');
        const outputTab = document.getElementById('tab-output');
        const statisticsTab = document.getElementById('tab-statistics');
        const logsTab = document.getElementById('tab-logs');
        const settingsContent = document.getElementById('settings-tab-content');
        const systemPromptContent = document.getElementById('system-prompt-tab-content');
        const skillsContent = document.getElementById('skills-tab-content');
        const schemaContent = document.getElementById('schema-tab-content');
        const inputContent = document.getElementById('input-tab-content');
        const outputContent = document.getElementById('output-tab-content');
        const statisticsContent = document.getElementById('statistics-tab-content');
        const logsContent = document.getElementById('logs-tab-content');

        // Settings + System Prompt are always rendered; the rest are workflow-only.
        // We must NOT require input/output tabs here or library-mode clicks no-op.
        if (!settingsTab || !settingsContent) return;

        // Deactivate all tabs
        [settingsTab, systemPromptTab, skillsTab, schemaTab, inputTab, outputTab, statisticsTab, logsTab].filter(Boolean).forEach(tab => {
            tab.classList.remove('text-blue-600', 'border-blue-600');
            tab.classList.add('text-gray-500', 'border-transparent');
        });

        // Hide all content
        [settingsContent, systemPromptContent, skillsContent, schemaContent, inputContent, outputContent, statisticsContent, logsContent].filter(Boolean).forEach(content => {
            content.classList.add('hidden');
        });

        // Activate selected tab
        if (tabName === 'settings') {
            settingsTab.classList.add('text-blue-600', 'border-blue-600');
            settingsTab.classList.remove('text-gray-500', 'border-transparent');
            settingsContent.classList.remove('hidden');
        } else if (tabName === 'system-prompt' && systemPromptTab && systemPromptContent) {
            systemPromptTab.classList.add('text-blue-600', 'border-blue-600');
            systemPromptTab.classList.remove('text-gray-500', 'border-transparent');
            systemPromptContent.classList.remove('hidden');
        } else if (tabName === 'skills' && skillsTab && skillsContent) {
            skillsTab.classList.add('text-blue-600', 'border-blue-600');
            skillsTab.classList.remove('text-gray-500', 'border-transparent');
            skillsContent.classList.remove('hidden');
            this.populateSkillsPicker();
            this.refreshSkillEditorPreviews();
            this.populateSkillCategoryDropdown();
        } else if (tabName === 'schema' && schemaTab && schemaContent) {
            schemaTab.classList.add('text-blue-600', 'border-blue-600');
            schemaTab.classList.remove('text-gray-500', 'border-transparent');
            schemaContent.classList.remove('hidden');
        } else if (tabName === 'input') {
            inputTab.classList.add('text-blue-600', 'border-blue-600');
            inputTab.classList.remove('text-gray-500', 'border-transparent');
            inputContent.classList.remove('hidden');
        } else if (tabName === 'output') {
            outputTab.classList.add('text-blue-600', 'border-blue-600');
            outputTab.classList.remove('text-gray-500', 'border-transparent');
            outputContent.classList.remove('hidden');
        } else if (tabName === 'statistics' && statisticsTab && statisticsContent) {
            statisticsTab.classList.add('text-blue-600', 'border-blue-600');
            statisticsTab.classList.remove('text-gray-500', 'border-transparent');
            statisticsContent.classList.remove('hidden');
        } else if (tabName === 'logs' && logsTab && logsContent) {
            logsTab.classList.add('text-blue-600', 'border-blue-600');
            logsTab.classList.remove('text-gray-500', 'border-transparent');
            logsContent.classList.remove('hidden');
            this._renderNodeLogs(this.editingNodeId);
        }
    }

    /**
     * Populate the skill picker dropdown in the Skills tab
     */
    async populateSkillsPicker() {
        const picker = document.getElementById('skill-picker');
        if (!picker) return;

        // Ensure skills are loaded
        if (window.skillsManager) {
            if (window.skillsManager.skills.length === 0) {
                await window.skillsManager.loadTree();
            }
            const skills = window.skillsManager.getSkillsForPicker();
            picker.innerHTML = `<option value="">-- ${this.t('skills.loadFromLibrary') || 'Load from Skill Library'} --</option>`;
            if (skills.length === 0) {
                picker.innerHTML += `<option value="" disabled>${this.t('skills.noSkillsAvailable') || 'No skills available'}</option>`;
            } else {
                for (const s of skills) {
                    const catLabel = s.category ? ` [${s.category}]` : '';
                    picker.innerHTML += `<option value="${s.id}">${this.escapeHtml(s.name)}${catLabel}</option>`;
                }
            }
        }

        // Reset preview
        const preview = document.getElementById('skill-preview');
        if (preview) preview.classList.add('hidden');
        const loadBtn = document.getElementById('load-skill-btn');
        if (loadBtn) loadBtn.disabled = true;
        this._selectedSkill = null;
    }

    /**
     * Show a brief toast notification for skill operations
     */
    showSkillNotification(message) {
        const notification = document.createElement('div');
        notification.className = 'fixed top-4 right-4 p-3 rounded-lg shadow-lg z-[300] bg-green-50 border border-green-200 text-green-800 text-sm font-medium';
        notification.textContent = message;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 3000);
    }

    /**
     * Set (or clear) the node's bound skill. Updates the chip in the
     * Skills tab and stashes the selection on `this._boundSkill` for
     * saveAgent to pick up. When `silent` is true we don't show a
     * toast — used during initial pre-population.
     */
    _setNodeBoundSkill(skill, silent = false) {
        const chip = document.getElementById('node-skill-chip');
        const nameEl = document.getElementById('node-skill-chip-name');
        const metaEl = document.getElementById('node-skill-chip-meta');
        if (!skill) {
            this._boundSkill = null;
            if (chip) chip.classList.add('hidden');
            this._skillPickerHandle?.markSelected?.(null);
            return;
        }
        // Normalize what we actually need to persist: just enough to
        // re-fetch / re-display. We deliberately avoid persisting the
        // skill_content here — that's the whole point: the library is
        // the source of truth.
        this._boundSkill = {
            id: skill.id ?? null,
            source: skill.source || 'db',
            dir_name: skill.dir_name || null,
            name: skill.name || '',
            description: skill.description || '',
        };
        if (chip) chip.classList.remove('hidden');
        if (nameEl) nameEl.textContent = skill.name || '(unnamed skill)';
        if (metaEl) {
            const parts = [];
            if (skill.source === 'local') parts.push('folder-backed');
            else parts.push('library');
            if (skill.description) parts.push(skill.description.slice(0, 80));
            metaEl.textContent = parts.join(' · ');
        }
        // Keep the tree's selection highlight in sync with the chip
        // so users see exactly which skill is bound, including after
        // form re-opens or workflow reload (silent path).
        this._skillPickerHandle?.markSelected?.(skill.id ?? null);
        if (!silent && typeof this.showSkillNotification === 'function') {
            this.showSkillNotification(`Bound to skill: ${skill.name || ''}`);
        }
    }

    /**
     * Refresh the prompt/tools previews inside the skill editor section.
     * Reads current values from the Settings tab fields.
     */
    refreshSkillEditorPreviews() {
        const editorText = document.getElementById('skill-editor-text');
        const toolsPreview = document.getElementById('skill-editor-tools-preview');

        // Seed from the node's saved skill_content first, then fall back to instructions
        if (editorText && !editorText.value.trim()) {
            // Check if the node has a saved skill_content
            if (this.editingNodeId) {
                try {
                    const drawflowNodes = this.editor?.drawflow?.drawflow?.Home?.data || {};
                    const nodeData = drawflowNodes[String(this.editingNodeId)]?.data || {};
                    if (nodeData.skill_content) {
                        editorText.value = nodeData.skill_content;
                        return; // Don't overwrite with instructions
                    }
                } catch (_) {}
            }
            // Fall back to the Settings tab's instructions
            const instructions = document.getElementById('agent-instructions-input')?.value || '';
            if (instructions) editorText.value = instructions;
        }

        if (toolsPreview) {
            const checked = Array.from(document.querySelectorAll('.tool-checkbox:checked'));
            if (checked.length > 0) {
                toolsPreview.textContent = checked.map(cb => cb.dataset.tool).join(', ');
            } else {
                toolsPreview.textContent = '(no tools selected)';
            }
        }
    }

    /**
     * Populate the folder dropdown in the skill editor section. Skills are
     * organized into group folders under <root>/skills/; an empty value
     * means the skill sits at the top level.
     */
    async populateSkillCategoryDropdown() {
        const select = document.getElementById('save-skill-category');
        if (!select || !window.skillsManager) return;

        // Ensure folders are loaded.
        if (window.skillsManager.folders.length === 0) {
            await window.skillsManager.loadTree();
        }

        select.innerHTML = `<option value="">${this.t('skills.uncategorized') || 'Top level'}</option>`;
        for (const folder of window.skillsManager.folders) {
            const safe = this.escapeHtml(folder.name);
            select.innerHTML += `<option value="${safe}">${safe}</option>`;
        }
    }

    /**
     * Show merge strategy help overlay
     */
    showMergeStrategyHelp() {
        // Remove existing overlay if any
        document.getElementById('merge-help-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'merge-help-overlay';
        overlay.className = 'merge-help-overlay';
        const tf = (key) => this.t('workflow.agentForm.mergeHelp.' + key);
        overlay.innerHTML = `
            <div class="merge-help-content">
                <div class="merge-help-header">
                    <h3>${tf('title')}</h3>
                    <button class="merge-help-close">&times;</button>
                </div>
                <p class="merge-help-intro">${tf('intro')}</p>

                <div class="merge-help-options">
                    <div class="merge-help-option">
                        <div class="merge-help-option-header">
                            <span class="merge-help-badge">${tf('labeledBadge')}</span>
                            <span class="merge-help-default">${tf('defaultBadge')}</span>
                        </div>
                        <p>${tf('labeledDesc')}</p>
                        <pre class="merge-help-example">[Research Agent]:
The research findings show...

[Data Analyst]:
Based on the analysis...</pre>
                    </div>

                    <div class="merge-help-option">
                        <div class="merge-help-option-header">
                            <span class="merge-help-badge">${tf('numberedBadge')}</span>
                        </div>
                        <p>${tf('numberedDesc')}</p>
                        <pre class="merge-help-example">[Input 1 - Research Agent]
The research findings show...

[Input 2 - Data Analyst]
Based on the analysis...</pre>
                    </div>

                    <div class="merge-help-option">
                        <div class="merge-help-option-header">
                            <span class="merge-help-badge">${tf('concatenateBadge')}</span>
                        </div>
                        <p>${tf('concatenateDesc')}</p>
                        <pre class="merge-help-example">The research findings show...

Based on the analysis...</pre>
                    </div>

                    <div class="merge-help-option">
                        <div class="merge-help-option-header">
                            <span class="merge-help-badge">${tf('xmlBadge')}</span>
                        </div>
                        <p>${tf('xmlDesc')}</p>
                        <pre class="merge-help-example">&lt;input source="Research Agent" index="1"&gt;
The research findings show...
&lt;/input&gt;

&lt;input source="Data Analyst" index="2"&gt;
Based on the analysis...
&lt;/input&gt;</pre>
                    </div>

                    <div class="merge-help-option">
                        <div class="merge-help-option-header">
                            <span class="merge-help-badge">${tf('jsonBadge')}</span>
                        </div>
                        <p>${tf('jsonDesc')}</p>
                        <pre class="merge-help-example">[
  {"source": "Research Agent", "content": "..."},
  {"source": "Data Analyst", "content": "..."}
]</pre>
                    </div>
                </div>
            </div>
        `;

        // Add styles if not present
        if (!document.getElementById('merge-help-styles')) {
            const style = document.createElement('style');
            style.id = 'merge-help-styles';
            style.textContent = `
                .merge-help-btn {
                    width: 24px;
                    height: 24px;
                    border: 1px solid #d1d5db;
                    border-radius: 50%;
                    background: #f9fafb;
                    color: #6b7280;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: all 0.15s;
                    flex-shrink: 0;
                }
                .merge-help-btn:hover {
                    background: #3b82f6;
                    border-color: #3b82f6;
                    color: white;
                }
                .merge-help-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0,0,0,0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10001;
                }
                .merge-help-content {
                    background: white;
                    border-radius: 12px;
                    padding: 24px;
                    max-width: 550px;
                    max-height: 80vh;
                    overflow-y: auto;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.2);
                }
                .merge-help-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 12px;
                }
                .merge-help-header h3 {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 600;
                    color: #1f2937;
                }
                .merge-help-close {
                    width: 28px;
                    height: 28px;
                    border: none;
                    background: transparent;
                    color: #9ca3af;
                    font-size: 24px;
                    cursor: pointer;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .merge-help-close:hover {
                    background: #f3f4f6;
                    color: #374151;
                }
                .merge-help-intro {
                    font-size: 14px;
                    color: #4b5563;
                    margin-bottom: 16px;
                    line-height: 1.5;
                }
                .merge-help-options {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                }
                .merge-help-option {
                    border: 1px solid #e5e7eb;
                    border-radius: 8px;
                    padding: 12px;
                    background: #fafafa;
                }
                .merge-help-option-header {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 8px;
                }
                .merge-help-badge {
                    background: #3b82f6;
                    color: white;
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 600;
                }
                .merge-help-default {
                    background: #10b981;
                    color: white;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 10px;
                    font-weight: 500;
                }
                .merge-help-option p {
                    font-size: 13px;
                    color: #4b5563;
                    margin: 0 0 8px 0;
                }
                .merge-help-example {
                    background: #1f2937;
                    color: #e5e7eb;
                    padding: 10px 12px;
                    border-radius: 6px;
                    font-size: 11px;
                    font-family: 'Monaco', 'Menlo', monospace;
                    overflow-x: auto;
                    margin: 0;
                    white-space: pre-wrap;
                    word-break: break-word;
                }
            `;
            document.head.appendChild(style);
        }

        // Close handlers
        overlay.querySelector('.merge-help-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);
    }

    /**
     * Update the tools selected count display
     */
    updateToolsSelectedCount() {
        const count = document.querySelectorAll('.tool-checkbox:checked').length;
        const countElement = document.getElementById('tools-selected-count');
        if (countElement) {
            countElement.textContent = count;
        }
    }

    // Map one persisted run event into this.nodeExecutionData, mirroring the
    // live SSE handlers, so a node form can be populated from the JSONL log.
    _applyRunEventToNodeData(event) {
        const dfId = this.dbNodeToDrawflowMap?.[event.node_id] || event.drawflow_id || event.node_id;
        if (dfId == null) return;
        if (!this.nodeExecutionData[dfId]) this.nodeExecutionData[dfId] = {};
        const nd = this.nodeExecutionData[dfId];

        switch (event.type) {
            case 'node_start':
                if (event.input != null) nd.input = event.input;
                break;
            case 'node_complete':
                if (event.output !== undefined) nd.output = event.output;
                nd.inputTokens = event.input_tokens || 0;
                nd.outputTokens = event.output_tokens || 0;
                nd.totalTokens = nd.inputTokens + nd.outputTokens;
                nd.costUsd = (event.cost_usd !== undefined && event.cost_usd !== null) ? Number(event.cost_usd) : null;
                nd.agentName = event.agent_name || nd.agentName || null;
                nd.success = event.success !== false;
                break;
            case 'node_trace':
                if (!Array.isArray(nd.logs)) nd.logs = [];
                nd.logs.push({
                    dirName: event.skill_dir || '',
                    script: '',
                    argv: [],
                    exitCode: event.skill_exit_code ?? 0,
                    stdout: event.skill_stdout || '',
                    logMessages: event.skill_log_messages || '',
                    durationMs: 0,
                });
                if (event.success === false && event.error_text) nd.error = event.error_text;
                break;
            case 'node_log':
                if (!Array.isArray(nd.activity)) nd.activity = [];
                nd.activity.push({
                    ts: event.timestamp || 0,
                    level: event.level || 'info',
                    phase: event.phase || '',
                    message: event.message || '',
                });
                break;
            default:
                break; // client_tool_call logs already arrive live; ignore here
        }
    }

    // Fetch the persisted event log for a run and replay it into
    // nodeExecutionData. Cached per runId so reopening a form is cheap.
    async hydrateNodeDataFromRun(runId) {
        if (!runId) return false;
        if (this._hydratedRunId === runId) return true;
        try {
            const resp = await fetch(`${this.apiBase}/workflows/runs/${runId}/events`, {
                headers: this.getAuthHeaders(),
                credentials: 'include',
            });
            if (!resp.ok) return false;
            const data = await resp.json();
            const events = Array.isArray(data?.events) ? data.events : [];
            for (const ev of events) this._applyRunEventToNodeData(ev);
            this._hydratedRunId = runId;
            return true;
        } catch (e) {
            console.warn('[WorkflowEditor] hydrateNodeDataFromRun failed:', e);
            return false;
        }
    }

    /**
     * Update modal input/output/statistics display if modal is open for this node
     * @param {string|number} drawflowId - The Drawflow node ID
     */
    updateModalInputOutput(drawflowId) {
        // Check if modal is open for this node
        if (String(this.editingNodeId) !== String(drawflowId)) return;

        const inputDisplay = document.getElementById('agent-input-display');
        const outputDisplay = document.getElementById('agent-output-display');
        const statisticsDisplay = document.getElementById('agent-statistics-display');

        if (inputDisplay && this.nodeExecutionData[drawflowId]?.input) {
            inputDisplay.textContent = this.nodeExecutionData[drawflowId].input;
        }
        if (outputDisplay && this.nodeExecutionData[drawflowId]?.output) {
            outputDisplay.textContent = this.nodeExecutionData[drawflowId].output;
        }
        if (statisticsDisplay) {
            statisticsDisplay.innerHTML = this.getNodeStatisticsHtml(drawflowId);
        }
        if (document.getElementById('agent-logs-display')) {
            this._renderNodeLogs(drawflowId);
        }
    }

    /**
     * Render the Logs panel for a node and wire its Close button. Re-rendered
     * on every update (live during a run), so the close handler is re-attached
     * each time.
     * @param {string|number} drawflowId
     */
    _renderNodeLogs(drawflowId) {
        const el = document.getElementById('agent-logs-display');
        if (!el) return;
        el.innerHTML = this.getNodeLogsHtml(drawflowId);
        el.querySelector('#logs-close-btn')?.addEventListener('click', () => this.closeAgentEditModal());
    }

    /**
     * Build the Logs tab HTML for a node: status badge, error box (for failed
     * nodes — the error string arrives as the node output), and each skill
     * run's stdout / log_messages with exit code and duration.
     * @param {string|number} drawflowId
     * @returns {string}
     */
    getNodeLogsHtml(drawflowId) {
        const data = this.nodeExecutionData?.[drawflowId];
        const esc = (s) => this.escapeHtml(String(s ?? ''));
        const tl = (k) => this.t('workflow.agentForm.logs.' + k);
        const closeBtn = `<button id="logs-close-btn" class="px-2 py-1 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded transition" title="${tl('close')}">✕ ${tl('close')}</button>`;

        if (!data || (data.success === undefined && !Array.isArray(data.logs) && !data.output && !Array.isArray(data.activity))) {
            return `<div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold text-gray-600">${tl('title')}</span>${closeBtn}
                </div>
                <p class="text-sm text-gray-400 italic">${tl('empty')}</p>`;
        }

        const failed = data.success === false;
        const statusBadge = failed
            ? `<span class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-red-100 text-red-700">✕ ${tl('statusFailed')}</span>`
            : (data.success === true
                ? `<span class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-green-100 text-green-700">✓ ${tl('statusCompleted')}</span>`
                : `<span class="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-gray-100 text-gray-600">… ${tl('statusPending')}</span>`);

        let html = `<div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">${statusBadge}${data.agentName ? `<span class="text-xs text-gray-500">${esc(data.agentName)}</span>` : ''}</div>
            ${closeBtn}
        </div>`;

        // Error box — the failed node's error string lands in its output.
        if (failed && data.output) {
            html += `<div class="mb-3">
                <div class="text-xs font-semibold text-red-700 mb-1">${tl('error')}</div>
                <pre class="whitespace-pre-wrap text-xs text-red-800 font-mono bg-red-50 border border-red-200 rounded p-3">${esc(data.output)}</pre>
            </div>`;
        }

        // Per-node activity timeline (node_log events), interleaved with skill
        // runs by timestamp. Empty array => render nothing (no behavior change
        // for nodes that produced no activity).
        const nd = this.nodeExecutionData[drawflowId] || {};
        const activity = Array.isArray(nd.activity) ? nd.activity : [];
        const timelineRows = activity
            .slice()
            .sort((a, b) => (a.ts || 0) - (b.ts || 0))
            .map(a => {
                const color = a.level === 'error' ? '#e5534b' : (a.level === 'warn' ? '#d9a23a' : '#8a8f98');
                const icon = a.phase === 'skill' ? '▶' : (a.phase === 'done' ? '✓' : (a.phase === 'error' ? '✗' : '→'));
                return `<div style="font-family:monospace;font-size:12px;color:${color};white-space:pre-wrap;">`
                    + `${icon} ${this.escapeHtml(a.message)}</div>`;
            })
            .join('');
        const timelineHtml = timelineRows
            ? `<div style="margin:6px 0;padding:6px;background:#1116;border-radius:4px;">${timelineRows}</div>`
            : '';
        html += timelineHtml;

        // Skill execution logs (stdout + log_messages per run).
        const logs = Array.isArray(data.logs) ? data.logs : [];
        if (logs.length) {
            html += `<div class="text-xs font-semibold text-gray-700 mb-1">${tl('skillExecution')}</div>`;
            logs.forEach((lg) => {
                const argv = Array.isArray(lg.argv) ? lg.argv.join(' ') : '';
                const exitOk = (lg.exitCode ?? 0) === 0;
                html += `<div class="mb-3 border border-gray-200 rounded bg-white">
                    <div class="flex items-center justify-between px-3 py-1.5 bg-gray-100 border-b border-gray-200 text-xs gap-2">
                        <span class="font-mono text-gray-700 truncate">${esc(lg.dirName || '')} · ${esc(lg.script || '')} ${esc(argv)}</span>
                        <span class="${exitOk ? 'text-green-600' : 'text-red-600'} font-semibold whitespace-nowrap">exit ${esc(lg.exitCode ?? 0)} · ${esc(lg.durationMs ?? 0)}ms</span>
                    </div>`;
                if (lg.stdout) {
                    html += `<pre class="whitespace-pre-wrap text-xs text-gray-800 font-mono p-3 max-h-60 overflow-y-auto">${esc(lg.stdout)}</pre>`;
                }
                if (lg.logMessages) {
                    html += `<div class="border-t border-gray-100">
                        <div class="text-[10px] uppercase tracking-wide text-gray-400 px-3 pt-2">${tl('logMessages')}</div>
                        <pre class="whitespace-pre-wrap text-xs text-gray-600 font-mono px-3 pb-3 max-h-40 overflow-y-auto">${esc(lg.logMessages)}</pre>
                    </div>`;
                }
                html += `</div>`;
            });
        } else if (!failed) {
            html += `<p class="text-xs text-gray-400 italic">${tl('noSkillLogs')}</p>`;
        }

        // Metadata footer.
        const meta = [];
        if (data.executionTime) meta.push(`${tl('duration')}: ${(data.executionTime / 1000).toFixed(1)}s`);
        if (data.totalTokens) meta.push(`${tl('tokens')}: ${data.totalTokens}`);
        if (data.costUsd != null) meta.push(`${tl('cost')}: $${Number(data.costUsd).toFixed(4)}`);
        if (meta.length) html += `<div class="mt-2 text-[11px] text-gray-400">${esc(meta.join(' · '))}</div>`;

        return html;
    }

    /**
     * Get node output for display in the modal
     * @param {string|number} nodeId - The Drawflow node ID being edited
     * @returns {string} The node's output or a placeholder message
     */
    getNodeOutputForModal(nodeId) {
        // Check real-time execution data first
        if (this.nodeExecutionData[nodeId]?.output) {
            return this.nodeExecutionData[nodeId].output;
        }

        if (!this.lastWorkflowResults?.node_outputs) {
            return '(No workflow results available. Run the workflow first to see output.)';
        }

        // Try to find this node's output in the workflow results
        // The node_outputs keys might be database IDs, so we need to check the mapping
        const nodeOutputs = this.lastWorkflowResults.node_outputs;

        // Try direct match with nodeId (Drawflow ID)
        if (nodeOutputs[nodeId]?.output) {
            return nodeOutputs[nodeId].output;
        }

        // Try to find via the database node ID mapping (reverse lookup)
        if (this.dbNodeToDrawflowMap) {
            for (const [dbId, drawflowId] of Object.entries(this.dbNodeToDrawflowMap)) {
                if (String(drawflowId) === String(nodeId) && nodeOutputs[dbId]?.output) {
                    return nodeOutputs[dbId].output;
                }
            }
        }

        return '(No output available for this node. Run the workflow to generate output.)';
    }

    /**
     * Get node input for display in the modal
     * @param {string|number} nodeId - The Drawflow node ID being edited
     * @returns {string} The node's input content or a placeholder message
     */
    getNodeInputForModal(nodeId) {
        // Check real-time execution data first
        if (this.nodeExecutionData[nodeId]?.input) {
            return this.nodeExecutionData[nodeId].input;
        }

        if (!this.lastWorkflowResults?.node_outputs) {
            return '(No workflow results available. Run the workflow first to see input content.)';
        }

        // Try to find this node's input in the workflow results
        const nodeOutputs = this.lastWorkflowResults.node_outputs;

        // Try direct match with nodeId (Drawflow ID)
        if (nodeOutputs[nodeId]?.input) {
            return nodeOutputs[nodeId].input;
        }

        // Try to find via the database node ID mapping (reverse lookup)
        if (this.dbNodeToDrawflowMap) {
            for (const [dbId, drawflowId] of Object.entries(this.dbNodeToDrawflowMap)) {
                if (String(drawflowId) === String(nodeId) && nodeOutputs[dbId]?.input) {
                    return nodeOutputs[dbId].input;
                }
            }
        }

        return '(No input content available for this node. Run the workflow to see what was sent to the agent.)';
    }

    /**
     * Get node statistics HTML for display in the Statistics tab
     * @param {string|number} nodeId - The Drawflow node ID being edited
     * @returns {string} HTML for the statistics display
     */
    getNodeStatisticsHtml(nodeId) {
        // Get execution data for this node
        const execData = this.nodeExecutionData[nodeId] || {};
        const tf = (key) => this.t('workflow.agentForm.stats.' + key);

        // Check if we have any stats
        const hasStats = execData.executionTime !== undefined ||
                         execData.inputTokens !== undefined ||
                         execData.outputTokens !== undefined;

        if (!hasStats) {
            return `
                <div class="text-center py-12 text-gray-500">
                    <div class="text-4xl mb-4">📊</div>
                    <p class="text-lg font-medium mb-2">${tf('noStatsTitle')}</p>
                    <p class="text-sm">${tf('noStatsDesc')}</p>
                </div>
            `;
        }

        const executionTime = execData.executionTime || 0;
        const inputTokens = execData.inputTokens || 0;
        const outputTokens = execData.outputTokens || 0;
        const totalTokens = execData.totalTokens || (inputTokens + outputTokens);
        const agentName = execData.agentName || 'Agent';
        const success = execData.success !== false;
        const costUsd = (execData.costUsd !== undefined && execData.costUsd !== null) ? execData.costUsd : null;
        const formatCost = (c) => c == null ? '—' : (c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`);

        // Format execution time
        const formatTime = (ms) => {
            if (ms < 1000) return `${ms}ms`;
            return `${(ms / 1000).toFixed(2)}s`;
        };

        return `
            <div class="space-y-6">
                <!-- Header -->
                <div class="flex items-center justify-between pb-4 border-b border-gray-200">
                    <h4 class="text-lg font-semibold text-gray-800">${this.escapeHtml(agentName)}</h4>
                    <span class="px-3 py-1 rounded-full text-sm font-medium ${success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                        ${success ? '✓ ' + tf('completed') : '✗ ' + tf('failed')}
                    </span>
                </div>

                <!-- Stats Grid -->
                <div class="grid grid-cols-2 gap-4">
                    <!-- Execution Time -->
                    <div class="bg-white rounded-lg border border-gray-200 p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-2xl">⏱️</span>
                            <span class="text-sm font-medium text-gray-600">${tf('executionTime')}</span>
                        </div>
                        <div class="text-2xl font-bold text-gray-900">${formatTime(executionTime)}</div>
                    </div>

                    <!-- Total Tokens -->
                    <div class="bg-white rounded-lg border border-gray-200 p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-2xl">🎯</span>
                            <span class="text-sm font-medium text-gray-600">${tf('totalTokens')}</span>
                        </div>
                        <div class="text-2xl font-bold text-gray-900">${totalTokens.toLocaleString()}</div>
                    </div>

                    <!-- Input Tokens -->
                    <div class="bg-white rounded-lg border border-gray-200 p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-2xl">📥</span>
                            <span class="text-sm font-medium text-gray-600">${tf('inputTokens')}</span>
                        </div>
                        <div class="text-2xl font-bold text-green-600">${inputTokens.toLocaleString()}</div>
                        <div class="text-xs text-gray-500 mt-1">${tf('sentToLLM')}</div>
                    </div>

                    <!-- Output Tokens -->
                    <div class="bg-white rounded-lg border border-gray-200 p-4">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-2xl">📤</span>
                            <span class="text-sm font-medium text-gray-600">${tf('outputTokens')}</span>
                        </div>
                        <div class="text-2xl font-bold text-orange-600">${outputTokens.toLocaleString()}</div>
                        <div class="text-xs text-gray-500 mt-1">${tf('generatedByLLM')}</div>
                    </div>

                    <!-- Estimated Cost (full width) -->
                    <div class="bg-white rounded-lg border border-gray-200 p-4 col-span-2">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="text-2xl">💲</span>
                            <span class="text-sm font-medium text-gray-600">${tf('estimatedCost') || 'Estimated Cost'}</span>
                        </div>
                        <div class="text-2xl font-bold text-gray-900">${formatCost(costUsd)}</div>
                        <div class="text-xs text-gray-500 mt-1">${costUsd == null
                            ? (tf('costUnavailable') || 'Pricing not set for this provider')
                            : (tf('costBasis') || 'Based on centralized per-token pricing')}</div>
                    </div>
                </div>

                <!-- Token Ratio Bar -->
                ${totalTokens > 0 ? `
                <div class="bg-white rounded-lg border border-gray-200 p-4">
                    <div class="text-sm font-medium text-gray-600 mb-3">${tf('tokenDistribution')}</div>
                    <div class="flex h-4 rounded-full overflow-hidden bg-gray-100">
                        <div class="bg-green-500" style="width: ${(inputTokens / totalTokens * 100).toFixed(1)}%" title="${tf('inputTokens')}: ${inputTokens.toLocaleString()}"></div>
                        <div class="bg-orange-500" style="width: ${(outputTokens / totalTokens * 100).toFixed(1)}%" title="${tf('outputTokens')}: ${outputTokens.toLocaleString()}"></div>
                    </div>
                    <div class="flex justify-between mt-2 text-xs text-gray-500">
                        <span>${tf('inputTokens')}: ${(inputTokens / totalTokens * 100).toFixed(1)}%</span>
                        <span>${tf('outputTokens')}: ${(outputTokens / totalTokens * 100).toFixed(1)}%</span>
                    </div>
                </div>
                ` : ''}
            </div>
        `;
    }

    /**
     * Close the agent edit modal
     */
    closeAgentEditModal() {
        const modal = document.getElementById('agent-edit-modal');
        if (modal) modal.remove();
        this.editingAgent = null;
        this.editingNodeId = null; // Clear node editing state
        this.pendingTemplateNodeId = null; // Clear any pending workflow node link
    }

    /**
     * Save the agent
     */
    async saveAgent() {
        const modal = document.getElementById('agent-edit-modal');
        if (!modal) return;

        // Check if "Save as Template" is checked
        const saveAsTemplate = document.getElementById('save-as-template-checkbox')?.checked || false;

        // Collect output schema from the embedded builder (node-specific).
        // The builder always serializes to an inline schema; "Save to library"
        // additionally creates a library copy.
        let outputSchemaInline = null;
        let saveSchemaToLibrary = false;
        let librarySchemaName = '';
        let librarySchemaDescription = '';

        if (this.editingNodeId && this.schemaBuilder) {
            try {
                outputSchemaInline = this.getEmbeddedSchemaJson();
            } catch (e) {
                alert(e.message);
                return;
            }

            saveSchemaToLibrary = document.getElementById('agent-schema-save-to-library')?.checked || false;
            if (saveSchemaToLibrary) {
                if (!outputSchemaInline) {
                    alert(this.t('workflow.validation.emptySchemaToLibrary'));
                    return;
                }
                librarySchemaName = (document.getElementById('agent-schema-save-name')?.value || '').trim();
                librarySchemaDescription = (document.getElementById('agent-schema-save-description')?.value || '').trim();
                if (!librarySchemaName) {
                    alert(this.t('workflow.validation.schemaNameRequiredForLibrary'));
                    return;
                }
                if (!/^[a-zA-Z0-9_\-]+$/.test(librarySchemaName)) {
                    alert(this.t('workflow.validation.schemaNameInvalidCharsDot'));
                    return;
                }
            }
        }

        // Collect form data
        const agentData = {
            id: this.editingAgent?.id || null,
            name: document.getElementById('agent-name-input')?.value?.trim() || '',
            description: document.getElementById('agent-description-input')?.value?.trim() || '',
            agent_type: document.getElementById('agent-type-select')?.value || 'worker',
            provider: document.getElementById('agent-provider-select')?.value || '',
            model: document.getElementById('agent-model-input')?.value?.trim() || '',
            instructions: document.getElementById('agent-instructions-input')?.value || '',
            // Workflow nodes now BIND to a skill in the library rather
            // than carrying inline skill_content. The runner resolves
            // bound_skill at execution time. We keep `skill_content`
            // empty so legacy back-end paths that still read it just
            // see no inline override; the bound_skill is the source.
            bound_skill: this._boundSkill ? {
                id: this._boundSkill.id,
                source: this._boundSkill.source,
                dir_name: this._boundSkill.dir_name,
                name: this._boundSkill.name,
            } : null,
            skill_content: '',
            tools: Array.from(modal.querySelectorAll('.tool-checkbox:checked')).map(cb => cb.dataset.tool),
            settings: {
                temperature: parseFloat(document.getElementById('agent-temperature-input')?.value) || 0.7,
                max_tokens: parseInt(document.getElementById('agent-max-tokens-input')?.value) || 4096
            },
            is_template: saveAsTemplate,
            // Merge strategy (node-specific, not saved to template)
            merge_strategy: document.getElementById('agent-merge-strategy-select')?.value || 'labeled',
            // Output schema for constrained decoding (node-specific, always inline)
            output_schema: outputSchemaInline,
            // Cleared for new flow — kept null to overwrite any legacy reference
            output_schema_id: null,
            // Disabled flag (node-specific; backend skips node and returns "disabled node")
            disabled: document.getElementById('agent-node-disabled')?.checked || false
        };

        // If user opted in, save the schema to the workflow library too.
        // This is fire-and-forget on the agent save flow — failure here
        // doesn't block saving the node itself.
        if (saveSchemaToLibrary && outputSchemaInline) {
            try {
                const res = await fetch(`${this.apiBase}/workflow-schemas`, {
                    method: 'POST',
                    headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: librarySchemaName,
                        description: librarySchemaDescription,
                        schema_json: outputSchemaInline,
                        strict: this.schemaBuilder?.strict ?? true
                    })
                });
                const result = await res.json();
                if (!res.ok || result.success === false) {
                    const errs = result.validation_errors ? '\n' + result.validation_errors.join('\n') : '';
                    alert(this.t('workflow.errors.saveSchemaToLibraryFailed', { error: (result.error || 'Unknown error') + errs }));
                    // Continue saving the node anyway — schema is still attached inline
                } else {
                    await this.loadWorkflowSchemas(true);
                    this.showNotification(this.t('workflow.notifications.schemaSavedToLibrary', { name: librarySchemaName }));
                }
            } catch (e) {
                alert(this.t('workflow.errors.saveSchemaFailed', { error: e.message }));
            }
        }

        // Validate
        if (!agentData.name) {
            alert(this.t('workflow.validation.agentNameRequired'));
            return;
        }

        try {
            // Check if this node is linked to a template (has agent_id)
            console.log('[WorkflowEditor] saveAgent - editingNodeId:', this.editingNodeId, 'saveAsTemplate:', saveAsTemplate);
            console.log('[WorkflowEditor] saveAgent - agentData:', agentData);

            const isLinkedToTemplate = agentData.id !== null && agentData.id !== undefined;

            // If editing a workflow node — but only if the node is still on the canvas.
            // editingNodeId can be stale (e.g. saved-template edit, prior modal cycle),
            // in which case Drawflow's getNodeFromId throws on the missing entry.
            const drawflowNodes = this.editor?.drawflow?.drawflow?.Home?.data || {};
            const nodeStillOnCanvas = this.editingNodeId
                && Object.prototype.hasOwnProperty.call(drawflowNodes, String(this.editingNodeId));
            if (this.editingNodeId && nodeStillOnCanvas) {
                const nodeData = this.editor.getNodeFromId(this.editingNodeId);
                console.log('[WorkflowEditor] saveAgent - nodeData before update:', JSON.stringify(nodeData?.data));

                if (nodeData) {
                    // Build the new data object with all agent-related fields
                    const newNodeData = {
                        ...nodeData.data,  // Preserve existing data
                        type: 'agent',  // Ensure it's marked as configured agent
                        agent_id: agentData.id || null,
                        agent_name: agentData.name,
                        description: agentData.description,
                        agent_type: agentData.agent_type,
                        agent_provider: agentData.provider,
                        model: agentData.model,
                        instructions: agentData.instructions,
                        skill_content: agentData.skill_content,
                        // Persist the picker's binding. agentData.bound_skill
                        // can be null (user explicitly unbound) — write the
                        // explicit null so saveAgent overrides any stale
                        // bound_skill carried in via the spread.
                        bound_skill: agentData.bound_skill,
                        tools: agentData.tools,
                        settings: agentData.settings,
                        isTemplate: false,
                        // Merge strategy for multiple inputs
                        merge_strategy: agentData.merge_strategy,
                        // Output schema for constrained decoding
                        output_schema_id: agentData.output_schema_id,
                        output_schema: agentData.output_schema,
                        // Disabled flag for node-level skip
                        disabled: agentData.disabled
                    };

                    // Update node locally in Drawflow
                    const nodeIdStr = String(this.editingNodeId);
                    if (this.editor.drawflow.drawflow.Home.data[nodeIdStr]) {
                        this.editor.drawflow.drawflow.Home.data[nodeIdStr].data = newNodeData;
                        console.log('[WorkflowEditor] saveAgent - directly updated node data in drawflow structure');
                    } else {
                        this.editor.updateNodeDataFromId(this.editingNodeId, newNodeData);
                        console.log('[WorkflowEditor] saveAgent - updated node data via updateNodeDataFromId (fallback)');
                    }

                    // Update the visual display of the node
                    this.updateAgentNodeVisual(this.editingNodeId, agentData, newNodeData);

                    // Grey the node out on the canvas when disabled (mirrors ingestion pattern).
                    const _agentNodeEl = document.getElementById(`node-${this.editingNodeId}`);
                    _agentNodeEl?.querySelector('.workflow-node')?.classList.toggle('node-disabled', agentData.disabled);

                    // If linked to a template OR user wants to save as template, sync to backend
                    if (isLinkedToTemplate || saveAsTemplate) {
                        console.log('[WorkflowEditor] saveAgent - syncing to backend template');
                        try {
                            const url = agentData.id
                                ? `${this.apiBase}/agents/${agentData.id}`
                                : `${this.apiBase}/agents`;

                            const response = await fetch(url, {
                                method: agentData.id ? 'PUT' : 'POST',
                                headers: this.getAuthHeaders(),
                                body: JSON.stringify(agentData)
                            });

                            if (response.ok) {
                                const savedAgent = await response.json();
                                const savedId = savedAgent.id || savedAgent.data?.id;
                                console.log('[WorkflowEditor] saveAgent - template synced to backend, id:', savedId);

                                // Update node with the saved agent ID (important for new templates)
                                if (savedId && !agentData.id) {
                                    newNodeData.agent_id = savedId;
                                    if (this.editor.drawflow.drawflow.Home.data[nodeIdStr]) {
                                        this.editor.drawflow.drawflow.Home.data[nodeIdStr].data = newNodeData;
                                    }
                                    // Update edit button with new ID
                                    const editBtn = document.querySelector(`#node-${this.editingNodeId} .node-edit-btn`);
                                    if (editBtn) editBtn.dataset.agentId = savedId;
                                }

                                // Reload agents list to show updated template
                                await this.loadAgents();
                                this.renderAgentsPanel();
                            } else {
                                console.error('[WorkflowEditor] saveAgent - failed to sync template:', await response.text());
                            }
                        } catch (error) {
                            console.error('[WorkflowEditor] saveAgent - error syncing template:', error);
                        }
                    }

                    console.log('[WorkflowEditor] saveAgent - newNodeData saved:', JSON.stringify(newNodeData));
                }

                // Close modal and clear editing state
                this.editingNodeId = null;
                this.closeAgentEditModal();

                // Persist the workflow to the backend so the Save button in
                // the agent modal actually saves (not just to local Drawflow state)
                this.autoPersistWorkflow();

                // "Keep in library" was a DB-skill creation path; skills now
                // live only in the filesystem under ~/Documents/synergyAI/skills/<dir>/.
                // Users author them by editing SKILL.md directly on disk.

                return;
            }

            const isNew = !agentData.id;
            const url = isNew
                ? `${this.apiBase}/agents`
                : `${this.apiBase}/agents/${agentData.id}`;

            // Library-mode hint: when this save was opened from the Agents
            // sidebar service, drop the new agent in the currently-selected
            // container. For edits, only override if the hint is explicitly
            // set (otherwise preserve the existing category by omitting it).
            if (isNew && this._libraryCategoryHint) {
                agentData.category = this._libraryCategoryHint;
            }

            const response = await fetch(url, {
                method: isNew ? 'POST' : 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(agentData)
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to save agent');
            }

            const savedAgent = await response.json();
            console.log('[WorkflowEditor] Agent saved successfully:', savedAgent);

            // Library refresh callback (set by agents-library.js when it
            // opened the form). Fire-and-forget; clears the hint+callback so
            // subsequent workflow-context saves don't reuse them.
            try { this._libraryOnSave?.(); } catch (_) {}
            this._libraryOnSave = null;
            this._libraryCategoryHint = null;

            // Reload agents and refresh panel
            await this.loadAgents();
            this.renderAgentsPanel();

            // Sync template changes to any workflow nodes that reference this agent
            const savedAgentId = savedAgent.id || savedAgent.data?.id;
            if (savedAgentId && !isNew) {
                console.log('[WorkflowEditor] Syncing template changes to workflow nodes');
                this.syncTemplateToWorkflowNodes(savedAgentId, agentData);
            }

            // If this agent was created/edited from a workflow template node, update the node
            if (this.pendingTemplateNodeId) {
                // Find the saved agent in our refreshed list
                const agent = this.agents.find(a =>
                    String(a.id) === String(savedAgent.id) ||
                    String(a.id) === String(savedAgent.data?.id) ||
                    a.name === agentData.name
                );
                if (agent) {
                    this.updateWorkflowNodeWithAgent(this.pendingTemplateNodeId, agent);
                }
                this.pendingTemplateNodeId = null;
            }

            // Clear editing state
            this.editingNodeId = null;

            // Close modal
            this.closeAgentEditModal();

            // If editing a standalone template that is referenced by nodes
            // in the current workflow, syncTemplateToWorkflowNodes() above
            // updated those local node datas as a side effect — persist
            // the workflow so the Save button truly saves. autoPersistWorkflow
            // is a no-op when no workflow is currently loaded.
            this.autoPersistWorkflow();

        } catch (error) {
            console.error('[WorkflowEditor] Error saving agent:', error);
            alert(this.t('workflow.errors.saveAgentFailed', { error: error.message }));
        }
    }

    /**
     * Delete the agent
     */
    async deleteAgent() {
        if (!this.editingAgent?.id) return;

        if (!confirm(this.t('workflow.dialogs.confirmDeleteAgent'))) return;

        try {
            const response = await fetch(`${this.apiBase}/agents/${this.editingAgent.id}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to delete agent');
            }

            console.log('[WorkflowEditor] Agent deleted successfully');

            // Reload agents and refresh panel
            await this.loadAgents();
            this.renderAgentsPanel();

            // Close modal
            this.closeAgentEditModal();

        } catch (error) {
            console.error('[WorkflowEditor] Error deleting agent:', error);
            alert(this.t('workflow.errors.deleteAgentFailed', { error: error.message }));
        }
    }

    /**
     * Update the visual display of an agent node
     */
    updateAgentNodeVisual(nodeId, agentData, newNodeData) {
        const nodeElement = document.querySelector(`#node-${nodeId}`);
        if (!nodeElement) return;

        const nodeDiv = nodeElement.querySelector('.workflow-node');
        const headerElement = nodeElement.querySelector('.node-header');
        const bodyElement = nodeElement.querySelector('.node-body');

        // Update node title
        const titleElement = nodeElement.querySelector('.node-title');
        if (titleElement) {
            titleElement.textContent = agentData.name;
        }

        // Remove config hint from header if present (template indicator)
        const configHint = headerElement?.querySelector('.node-config-hint');
        if (configHint) configHint.remove();

        // Update merge strategy indicator in header (show if non-default)
        const mergeStrategy = agentData.merge_strategy || 'labeled';
        const existingMergeIndicator = headerElement?.querySelector('.node-merge-indicator');
        if (existingMergeIndicator) existingMergeIndicator.remove();

        if (mergeStrategy !== 'labeled' && headerElement) {
            const deleteBtn = headerElement.querySelector('.node-delete-btn');
            const strategyLabel = { numbered: '#', concatenate: '+', xml: '<>', json: '{}' }[mergeStrategy] || '';
            const mergeIndicatorHtml = `<span class="node-merge-indicator" title="Merge: ${mergeStrategy}">⨃${strategyLabel}</span>`;
            if (deleteBtn) {
                deleteBtn.insertAdjacentHTML('beforebegin', mergeIndicatorHtml);
            } else {
                headerElement.insertAdjacentHTML('beforeend', mergeIndicatorHtml);
            }
        }

        // Reset header background (remove template yellow)
        if (headerElement) {
            headerElement.style.background = '';
            // Add delete button if not present
            if (!headerElement.querySelector('.node-delete-btn')) {
                headerElement.insertAdjacentHTML('beforeend', '<button class="node-delete-btn" title="Delete node">×</button>');
            }
        }

        // Update body with proper agent node structure (timer, provider, edit button)
        if (bodyElement) {
            bodyElement.innerHTML = `
                <span class="node-timer">0:00</span>
                ${agentData.provider ? `<span class="node-provider">${this.escapeHtml(agentData.provider)}</span>` : ''}
                <button class="node-edit-btn" data-agent-id="${newNodeData.agent_id || ''}" title="Edit agent">✏️</button>
            `;
        }

        // Update the workflow-node div
        if (nodeDiv) {
            nodeDiv.dataset.agentId = newNodeData.agent_id || '';
            nodeDiv.dataset.mergeStrategy = mergeStrategy;
            nodeDiv.classList.remove('unconfigured', 'template', 'configurable');
        }
    }

    /**
     * Sync template changes to all workflow nodes that reference it
     */
    syncTemplateToWorkflowNodes(agentId, agentData) {
        const nodes = this.editor.drawflow.drawflow.Home.data;

        for (const nodeId of Object.keys(nodes)) {
            const node = nodes[nodeId];
            if (node.data?.agent_id && String(node.data.agent_id) === String(agentId)) {
                console.log('[WorkflowEditor] Syncing template to node:', nodeId);

                // Update node data
                node.data = {
                    ...node.data,
                    agent_name: agentData.name,
                    description: agentData.description,
                    agent_type: agentData.agent_type,
                    agent_provider: agentData.provider,
                    model: agentData.model,
                    instructions: agentData.instructions,
                    tools: agentData.tools,
                    settings: agentData.settings
                };

                // Update visual display
                this.updateAgentNodeVisual(nodeId, agentData, node.data);
            }
        }
    }

    /**
     * Delete a workflow node
     */
    deleteWorkflowNode() {
        if (!this.editingNodeId) return;

        if (!confirm(this.t('workflow.dialogs.confirmDeleteNode'))) return;

        try {
            this.editor.removeNodeId(`node-${this.editingNodeId}`);
            console.log('[WorkflowEditor] Node deleted:', this.editingNodeId);

            // Close modal and clear state
            this.editingNodeId = null;
            this.closeAgentEditModal();

            // Persist the workflow to the backend so the Delete button
            // actually deletes (not just from local Drawflow state). Same
            // UX contract as the Save buttons in node modals.
            this.autoPersistWorkflow();
        } catch (error) {
            console.error('[WorkflowEditor] Error deleting node:', error);
            alert(this.t('workflow.errors.deleteNodeFailed', { error: error.message }));
        }
    }

    /**
     * Delete a workflow node by ID (for X button)
     */
    deleteNodeById(nodeId) {
        if (!confirm(this.t('workflow.dialogs.confirmDeleteNodeShort'))) return;

        try {
            this.editor.removeNodeId(`node-${nodeId}`);
            console.log('[WorkflowEditor] Node deleted:', nodeId);

            // Persist the workflow to the backend so the Delete button
            // actually deletes (not just from local Drawflow state). Same
            // UX contract as the Save buttons in node modals.
            this.autoPersistWorkflow();
        } catch (error) {
            console.error('[WorkflowEditor] Error deleting node:', error);
        }
    }

    /**
     * Show the workflow editor
     */
    show() {
        if (!this.isInitialized) {
            this.init();
        }

        // Show the editor container
        const editorView = document.getElementById('workflow-editor-view');
        if (editorView) {
            editorView.classList.remove('hidden');
        }
    }

    /**
     * Hide the workflow editor
     */
    hide() {
        const editorView = document.getElementById('workflow-editor-view');
        if (editorView) {
            editorView.classList.add('hidden');
        }
    }

    /**
     * Get auth headers for API calls (same pattern as agent-teams-panel.js)
     */
    getAuthHeaders(includeContentType = true) {
        const headers = {};
        if (includeContentType) {
            headers['Content-Type'] = 'application/json';
        }
        if (window.authManager && window.authManager.token) {
            headers['Authorization'] = `Bearer ${window.authManager.token}`;
        }
        return headers;
    }

    // ==========================================
    // Schedule Management Methods
    // ==========================================

    /**
     * Load schedule for the current workflow
     */
    async loadWorkflowSchedule(workflowId) {
        try {
            const response = await fetch(`${this.apiBase}/workflows/${workflowId}/schedules`, {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                console.log('[WorkflowEditor] No schedules found for workflow');
                this.currentSchedule = null;
                return;
            }

            const data = await response.json();
            const schedules = data.data || [];

            // Get the first active schedule (pending or paused)
            this.currentSchedule = schedules.find(s => s.status === 'pending' || s.status === 'paused') || null;

            if (this.currentSchedule) {
                console.log('[WorkflowEditor] Loaded schedule:', this.currentSchedule);
                this.updateStartNodeScheduleIndicator(true);
            } else {
                this.updateStartNodeScheduleIndicator(false);
            }
        } catch (error) {
            console.error('[WorkflowEditor] Error loading schedule:', error);
            this.currentSchedule = null;
        }
    }

    /**
     * Save or update a schedule
     */
    async saveSchedule(scheduleData) {
        try {
            const isUpdate = this.currentSchedule?.id;
            const url = isUpdate
                ? `${this.apiBase}/schedules/${this.currentSchedule.id}`
                : `${this.apiBase}/schedules`;

            const response = await fetch(url, {
                method: isUpdate ? 'PUT' : 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(scheduleData)
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to save schedule');
            }

            const data = await response.json();
            this.currentSchedule = data.data;

            console.log('[WorkflowEditor] Schedule saved:', this.currentSchedule);

            // Update Start node indicator
            this.updateStartNodeScheduleIndicator(true);

            // Show success message
            this.showNotification(
                isUpdate ? this.t('workflow.schedule.scheduleUpdated') : this.t('workflow.schedule.scheduleCreated'),
                'success'
            );

            return true;
        } catch (error) {
            console.error('[WorkflowEditor] Error saving schedule:', error);
            this.showNotification(this.t('workflow.schedule.scheduleFailed') + ': ' + error.message, 'error');
            return false;
        }
    }

    /**
     * Delete a schedule
     */
    async deleteSchedule(scheduleId) {
        try {
            const response = await fetch(`${this.apiBase}/schedules/${scheduleId}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to delete schedule');
            }

            console.log('[WorkflowEditor] Schedule deleted:', scheduleId);

            this.currentSchedule = null;
            this.updateStartNodeScheduleIndicator(false);

            this.showNotification(this.t('workflow.schedule.scheduleDeleted'), 'success');
            return true;
        } catch (error) {
            console.error('[WorkflowEditor] Error deleting schedule:', error);
            this.showNotification(this.t('workflow.errors.failedToDeleteSchedule', { error: error.message }), 'error');
            return false;
        }
    }

    /**
     * Update Start node to show schedule indicator
     */
    updateStartNodeScheduleIndicator(hasSchedule) {
        const startNodes = this.container.querySelectorAll('.workflow-node.start-node');
        startNodes.forEach(node => {
            let indicator = node.querySelector('.schedule-indicator');

            if (hasSchedule) {
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.className = 'schedule-indicator';
                    indicator.innerHTML = '🕐';
                    indicator.style.cssText = 'position: absolute; top: -8px; right: -8px; font-size: 16px; background: #8b5cf6; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 4px rgba(0,0,0,0.2);';
                    indicator.title = this.currentSchedule?.next_run
                        ? `${this.t('workflow.schedule.nextRun')}: ${new Date(this.currentSchedule.next_run).toLocaleString()}`
                        : this.t('workflow.schedule.scheduled');
                    node.querySelector('.workflow-node')?.appendChild(indicator) || node.appendChild(indicator);
                }
            } else if (indicator) {
                indicator.remove();
            }
        });
    }

    /**
     * Show a notification toast
     */
    showNotification(message, type = 'info') {
        // Remove existing notifications
        const existing = document.querySelector('.workflow-notification');
        if (existing) existing.remove();

        const colors = {
            success: { bg: '#d1fae5', border: '#10b981', text: '#065f46' },
            error: { bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },
            info: { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' }
        };
        const color = colors[type] || colors.info;

        const notification = document.createElement('div');
        notification.className = 'workflow-notification';
        notification.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 12px 20px;
            background: ${color.bg};
            border: 1px solid ${color.border};
            color: ${color.text};
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
        `;
        notification.textContent = message;

        // Add animation keyframes if not exists
        if (!document.getElementById('workflow-notification-styles')) {
            const style = document.createElement('style');
            style.id = 'workflow-notification-styles';
            style.textContent = `
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(notification);

        // Auto remove after 4 seconds
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            notification.style.transition = 'all 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 4000);
    }

    // ==========================================
    // OUTPUT SCHEMA LIBRARY (constrained decoding)
    // ==========================================

    /**
     * Show the schema library modal — list, create, edit, delete reusable schemas.
     */
    async showWorkflowSchemasModal() {
        await this.loadWorkflowSchemas(true);

        // Remove existing if any
        document.getElementById('workflow-schemas-modal')?.remove();

        const schemas = this.workflowSchemas || [];
        const rows = schemas.length === 0
            ? `<tr><td colspan="3" class="text-center text-gray-400 py-6">No schemas yet — click "New schema" to create one.</td></tr>`
            : schemas.map(s => `
                <tr class="border-t border-gray-200 hover:bg-gray-50">
                    <td class="px-3 py-2 text-sm font-medium text-gray-800">${this.escapeHtml(s.name)}</td>
                    <td class="px-3 py-2 text-xs text-gray-600">${this.escapeHtml(s.description || '')}</td>
                    <td class="px-3 py-2 text-right whitespace-nowrap">
                        <button class="schema-edit-btn text-xs text-blue-600 hover:text-blue-800 mr-2" data-id="${s.id}">Edit</button>
                        <button class="schema-delete-btn text-xs text-red-600 hover:text-red-800" data-id="${s.id}">Delete</button>
                    </td>
                </tr>
            `).join('');

        const modalHTML = `
            <div id="workflow-schemas-modal" class="fixed inset-0 z-[210] flex items-center justify-center" style="background-color: rgba(0,0,0,0.5);">
                <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-3xl mx-4 max-h-[85vh] overflow-hidden flex flex-col">
                    <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
                        <h3 class="text-base font-semibold text-gray-800">Output Schemas</h3>
                        <button id="close-schemas-modal" class="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded">✕</button>
                    </div>
                    <div class="flex-1 overflow-y-auto p-4">
                        <p class="text-xs text-gray-500 mb-3">
                            Reusable JSON Schemas for constrained decoding. Attach one to an agent node to force its output to conform to the structure.
                        </p>
                        <div class="border border-gray-200 rounded-lg overflow-hidden">
                            <table class="w-full">
                                <thead class="bg-gray-50">
                                    <tr>
                                        <th class="px-3 py-2 text-left text-xs font-semibold text-gray-700">Name</th>
                                        <th class="px-3 py-2 text-left text-xs font-semibold text-gray-700">Description</th>
                                        <th class="px-3 py-2 text-right text-xs font-semibold text-gray-700"></th>
                                    </tr>
                                </thead>
                                <tbody>${rows}</tbody>
                            </table>
                        </div>
                    </div>
                    <div class="flex justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
                        <button id="schema-new-btn" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">+ New schema</button>
                        <button id="schemas-modal-done" class="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">Done</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);

        const modal = document.getElementById('workflow-schemas-modal');
        document.getElementById('close-schemas-modal')?.addEventListener('click', () => modal.remove());
        document.getElementById('schemas-modal-done')?.addEventListener('click', () => {
            modal.remove();
            // Refresh the agent modal's schema dropdown if it's open
            this.refreshAgentModalSchemaDropdown();
        });
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        document.getElementById('schema-new-btn')?.addEventListener('click', () => {
            this.showSchemaEditModal(null);
        });
        modal.querySelectorAll('.schema-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseInt(btn.dataset.id, 10);
                const schema = (this.workflowSchemas || []).find(s => s.id === id);
                this.showSchemaEditModal(schema);
            });
        });
        modal.querySelectorAll('.schema-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = parseInt(btn.dataset.id, 10);
                if (!confirm(this.t('workflow.dialogs.confirmDeleteSchema'))) return;
                try {
                    const res = await fetch(`${this.apiBase}/workflow-schemas/${id}`, {
                        method: 'DELETE',
                        headers: this.getAuthHeaders()
                    });
                    if (res.ok) {
                        await this.loadWorkflowSchemas(true);
                        modal.remove();
                        this.showWorkflowSchemasModal();
                    } else {
                        alert(this.t('workflow.errors.failedToDeleteSchema'));
                    }
                } catch (e) {
                    alert(this.t('workflow.errors.deleteSchemaFailed', { error: e.message }));
                }
            });
        });
    }

    // ==========================================
    // SCHEMA BUILDER (form-based JSON Schema editor)
    // ==========================================

    /**
     * Generate a unique field id for the builder's internal state.
     */
    schemaBuilderNewId() {
        return 'f_' + Math.random().toString(36).slice(2, 10);
    }

    /**
     * Built-in starter templates for the schema builder.
     */
    getSchemaBuilderTemplates() {
        const id = () => this.schemaBuilderNewId();
        return {
            blank: { label: 'Blank', state: { fields: [] } },
            sentiment: {
                label: 'Sentiment analysis',
                state: { fields: [
                    { _id: id(), name: 'sentiment', type: 'enum', required: true,
                      enumValues: ['positive', 'negative', 'neutral'], enumValueType: 'string',
                      description: 'Overall sentiment' },
                    { _id: id(), name: 'confidence', type: 'number', required: true,
                      constraints: { minimum: 0, maximum: 1 }, description: 'Confidence score (0-1)' },
                    { _id: id(), name: 'reasoning', type: 'string', required: false,
                      description: 'Explanation of the classification' }
                ]}
            },
            classification: {
                label: 'Classification',
                state: { fields: [
                    { _id: id(), name: 'category', type: 'string', required: true,
                      description: 'Predicted category' },
                    { _id: id(), name: 'confidence', type: 'number', required: true,
                      constraints: { minimum: 0, maximum: 1 } },
                    { _id: id(), name: 'alternatives', type: 'array', required: false,
                      itemType: 'object', itemFields: [
                        { _id: id(), name: 'category', type: 'string', required: true },
                        { _id: id(), name: 'score', type: 'number', required: true,
                          constraints: { minimum: 0, maximum: 1 } }
                      ]}
                ]}
            },
            extraction: {
                label: 'Entity extraction',
                state: { fields: [
                    { _id: id(), name: 'entities', type: 'array', required: true,
                      itemType: 'object', itemFields: [
                        { _id: id(), name: 'type', type: 'string', required: true,
                          description: 'Entity type (PERSON, ORG, LOC, ...)' },
                        { _id: id(), name: 'value', type: 'string', required: true },
                        { _id: id(), name: 'span', type: 'string', required: false,
                          description: 'Original text span' }
                      ]}
                ]}
            },
            qa: {
                label: 'Q&A with sources',
                state: { fields: [
                    { _id: id(), name: 'answer', type: 'string', required: true,
                      description: 'Answer to the question' },
                    { _id: id(), name: 'sources', type: 'array', required: false,
                      itemType: 'object', itemFields: [
                        { _id: id(), name: 'title', type: 'string', required: true },
                        { _id: id(), name: 'url', type: 'url', required: false },
                        { _id: id(), name: 'quote', type: 'string', required: false }
                      ]},
                    { _id: id(), name: 'confidence', type: 'number', required: false,
                      constraints: { minimum: 0, maximum: 1 } }
                ]}
            },
            list: {
                label: 'Bullet list',
                state: { fields: [
                    { _id: id(), name: 'items', type: 'array', required: true,
                      itemType: 'string', description: 'List of items' }
                ]}
            },
            decision: {
                label: 'Decision',
                state: { fields: [
                    { _id: id(), name: 'decision', type: 'enum', required: true,
                      enumValues: ['proceed', 'hold', 'reject'], enumValueType: 'string' },
                    { _id: id(), name: 'reasoning', type: 'string', required: true },
                    { _id: id(), name: 'next_steps', type: 'array', required: false,
                      itemType: 'string' }
                ]}
            }
        };
    }

    /**
     * Convert a JSON Schema (loaded from API) into the builder's internal
     * field array. Returns { fields, incompatible } — incompatible=true if
     * the schema uses features the form builder cannot represent.
     */
    deserializeJsonSchema(jsonSchema) {
        const incompatible = { value: false };
        const fields = this.deserializeProperties(jsonSchema, incompatible);
        return { fields, incompatible: incompatible.value };
    }

    deserializeProperties(objSchema, incompatibleFlag) {
        const required = new Set(Array.isArray(objSchema?.required) ? objSchema.required : []);
        const props = objSchema?.properties || {};
        const fields = [];
        for (const [name, prop] of Object.entries(props)) {
            const f = this.deserializeField(name, prop, required.has(name), incompatibleFlag);
            if (f) fields.push(f);
        }
        return fields;
    }

    deserializeField(name, propSchema, isRequired, incompatibleFlag) {
        if (!propSchema || typeof propSchema !== 'object') return null;

        // Detect features the form builder doesn't represent
        const unsupported = ['oneOf', 'anyOf', 'allOf', 'not', '$ref', 'patternProperties', 'if', 'then', 'else'];
        if (unsupported.some(k => k in propSchema)) {
            incompatibleFlag.value = true;
            return null;
        }

        const _id = this.schemaBuilderNewId();
        const description = propSchema.description || '';
        const t = propSchema.type;

        if (t === 'string') {
            if (Array.isArray(propSchema.enum)) {
                return { _id, name, type: 'enum', required: isRequired, description,
                         enumValues: propSchema.enum.map(String), enumValueType: 'string' };
            }
            const fmt = propSchema.format;
            if (fmt === 'date' || fmt === 'date-time') return { _id, name, type: 'date', required: isRequired, description };
            if (fmt === 'email') return { _id, name, type: 'email', required: isRequired, description };
            if (fmt === 'uri' || fmt === 'url') return { _id, name, type: 'url', required: isRequired, description };
            return { _id, name, type: 'string', required: isRequired, description,
                     constraints: {
                         minLength: propSchema.minLength ?? null,
                         maxLength: propSchema.maxLength ?? null,
                         pattern: propSchema.pattern ?? null
                     }};
        }
        if (t === 'integer' || t === 'number') {
            if (Array.isArray(propSchema.enum)) {
                return { _id, name, type: 'enum', required: isRequired, description,
                         enumValues: propSchema.enum, enumValueType: t };
            }
            return { _id, name, type: t, required: isRequired, description,
                     constraints: {
                         minimum: propSchema.minimum ?? null,
                         maximum: propSchema.maximum ?? null,
                         multipleOf: propSchema.multipleOf ?? null
                     }};
        }
        if (t === 'boolean') {
            return { _id, name, type: 'boolean', required: isRequired, description };
        }
        if (t === 'array') {
            const items = propSchema.items || { type: 'string' };
            let itemType = 'string';
            let itemFields = null;
            if (items.type === 'object') {
                itemType = 'object';
                itemFields = this.deserializeProperties(items, incompatibleFlag);
            } else if (items.type === 'integer' || items.type === 'number' || items.type === 'boolean') {
                itemType = items.type;
            } else if (items.type === 'string') {
                itemType = 'string';
            } else {
                incompatibleFlag.value = true;
                return null;
            }
            return { _id, name, type: 'array', required: isRequired, description,
                     itemType, itemFields,
                     constraints: {
                         minItems: propSchema.minItems ?? null,
                         maxItems: propSchema.maxItems ?? null,
                         uniqueItems: propSchema.uniqueItems ?? false
                     }};
        }
        if (t === 'object') {
            return { _id, name, type: 'object', required: isRequired, description,
                     fields: this.deserializeProperties(propSchema, incompatibleFlag) };
        }

        incompatibleFlag.value = true;
        return null;
    }

    /**
     * Convert the builder's internal field array → standard JSON Schema.
     */
    serializeBuilderState(state, strict = true) {
        return this.serializeObjectFields(state.fields, strict);
    }

    serializeObjectFields(fields, strict) {
        const properties = {};
        const required = [];
        (fields || []).forEach(f => {
            if (!f.name) return;
            properties[f.name] = this.serializeField(f, strict);
            if (f.required) required.push(f.name);
        });
        const out = { type: 'object', properties };
        if (required.length > 0) out.required = required;
        if (strict) out.additionalProperties = false;
        return out;
    }

    serializeField(field, strict) {
        const desc = field.description ? { description: field.description } : {};

        const numClean = (v) => (v === null || v === '' || v === undefined || isNaN(v)) ? undefined : Number(v);
        const strClean = (v) => (v === null || v === '' || v === undefined) ? undefined : v;

        switch (field.type) {
            case 'string': {
                const c = field.constraints || {};
                const out = { type: 'string', ...desc };
                if (numClean(c.minLength) !== undefined) out.minLength = numClean(c.minLength);
                if (numClean(c.maxLength) !== undefined) out.maxLength = numClean(c.maxLength);
                if (strClean(c.pattern) !== undefined) out.pattern = c.pattern;
                return out;
            }
            case 'integer':
            case 'number': {
                const c = field.constraints || {};
                const out = { type: field.type, ...desc };
                if (numClean(c.minimum) !== undefined) out.minimum = numClean(c.minimum);
                if (numClean(c.maximum) !== undefined) out.maximum = numClean(c.maximum);
                if (numClean(c.multipleOf) !== undefined) out.multipleOf = numClean(c.multipleOf);
                return out;
            }
            case 'boolean':
                return { type: 'boolean', ...desc };
            case 'enum': {
                const valueType = field.enumValueType || 'string';
                const values = (field.enumValues || []).map(v =>
                    valueType === 'number' ? Number(v) : String(v)
                );
                return { type: valueType, enum: values, ...desc };
            }
            case 'date':
                return { type: 'string', format: 'date', ...desc };
            case 'email':
                return { type: 'string', format: 'email', ...desc };
            case 'url':
                return { type: 'string', format: 'uri', ...desc };
            case 'array': {
                const c = field.constraints || {};
                let items;
                if (field.itemType === 'object') {
                    items = this.serializeObjectFields(field.itemFields || [], strict);
                } else {
                    items = { type: field.itemType || 'string' };
                }
                const out = { type: 'array', items, ...desc };
                if (numClean(c.minItems) !== undefined) out.minItems = numClean(c.minItems);
                if (numClean(c.maxItems) !== undefined) out.maxItems = numClean(c.maxItems);
                if (c.uniqueItems) out.uniqueItems = true;
                return out;
            }
            case 'object':
                return { ...this.serializeObjectFields(field.fields || [], strict), ...desc };
            default:
                return { type: 'string', ...desc };
        }
    }

    /**
     * Walk the field tree and return the field with this id.
     */
    findSchemaFieldById(id, container = null) {
        const fields = container || this.schemaBuilder.state.fields;
        for (const f of fields) {
            if (f._id === id) return f;
            if (f.fields) {
                const found = this.findSchemaFieldById(id, f.fields);
                if (found) return found;
            }
            if (f.itemFields) {
                const found = this.findSchemaFieldById(id, f.itemFields);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Find the array containing a field with this id (so we can splice/reorder).
     */
    findSchemaParentArray(id, container = null) {
        const fields = container || this.schemaBuilder.state.fields;
        for (const f of fields) {
            if (f._id === id) return fields;
            if (f.fields) {
                const found = this.findSchemaParentArray(id, f.fields);
                if (found) return found;
            }
            if (f.itemFields) {
                const found = this.findSchemaParentArray(id, f.itemFields);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Resolve a "container id" to the array we should append to.
     * 'root' → top-level fields. Otherwise it's a parent field id.
     */
    findSchemaContainer(containerId) {
        if (containerId === 'root') return this.schemaBuilder.state.fields;
        const parent = this.findSchemaFieldById(containerId);
        if (!parent) return null;
        if (parent.type === 'object') {
            if (!parent.fields) parent.fields = [];
            return parent.fields;
        }
        if (parent.type === 'array' && parent.itemType === 'object') {
            if (!parent.itemFields) parent.itemFields = [];
            return parent.itemFields;
        }
        return null;
    }

    /**
     * Show the create/edit schema form (form-based builder).
     */
    showSchemaEditModal(schema) {
        document.getElementById('schema-edit-modal')?.remove();

        // Initialize builder state
        const isNew = !schema;
        let state = { fields: [] };
        let incompatible = false;

        if (schema?.schema_json) {
            const result = this.deserializeJsonSchema(schema.schema_json);
            state = { fields: result.fields };
            incompatible = result.incompatible;
        }

        this.schemaBuilder = {
            isNew,
            id: schema?.id || null,
            name: schema?.name || '',
            description: schema?.description || '',
            strict: schema?.strict ?? true,
            state,
            activeTab: incompatible ? 'json' : 'form',
            incompatible,
            // For "raw JSON" tab editing
            rawJson: JSON.stringify(
                schema?.schema_json || { type: 'object', properties: {}, required: [], additionalProperties: false },
                null, 2
            )
        };

        // Build modal shell
        const modalHTML = `
            <div id="schema-edit-modal" class="fixed inset-0 z-[220] flex items-center justify-center" style="background-color: rgba(0,0,0,0.5);">
                <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-6xl mx-4 max-h-[92vh] overflow-hidden flex flex-col">
                    <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
                        <h3 class="text-base font-semibold text-gray-800">${isNew ? 'New schema' : 'Edit schema'}</h3>
                        <button id="schema-edit-close" class="p-1.5 text-gray-500 hover:text-gray-700 rounded">✕</button>
                    </div>

                    <!-- Schema metadata -->
                    <div class="px-4 py-3 border-b border-gray-200 grid grid-cols-12 gap-3 bg-gray-50">
                        <div class="col-span-3">
                            <label class="block text-xs font-medium text-gray-700 mb-1">Name</label>
                            <input id="schema-meta-name" type="text" class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                                   placeholder="research_results" value="${this.escapeHtml(this.schemaBuilder.name)}">
                        </div>
                        <div class="col-span-5">
                            <label class="block text-xs font-medium text-gray-700 mb-1">Description</label>
                            <input id="schema-meta-description" type="text" class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                                   placeholder="What this schema represents" value="${this.escapeHtml(this.schemaBuilder.description)}">
                        </div>
                        <div class="col-span-2">
                            <label class="block text-xs font-medium text-gray-700 mb-1">Start from</label>
                            <select id="schema-template-select" class="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
                                ${Object.entries(this.getSchemaBuilderTemplates()).map(([k, v]) =>
                                    `<option value="${k}">${v.label}</option>`
                                ).join('')}
                            </select>
                        </div>
                        <div class="col-span-2 flex items-end">
                            <label class="flex items-center gap-2 text-xs font-medium text-gray-700">
                                <input id="schema-meta-strict" type="checkbox" class="w-4 h-4" ${this.schemaBuilder.strict ? 'checked' : ''}>
                                Strict mode
                            </label>
                        </div>
                    </div>

                    <!-- Tab bar -->
                    <div class="flex border-b border-gray-200 px-4">
                        <button id="schema-tab-form" class="schema-builder-tab px-4 py-2 text-sm font-medium border-b-2 -mb-px ${this.schemaBuilder.activeTab === 'form' ? 'text-blue-600 border-blue-600' : 'text-gray-500 border-transparent'}">
                            Form Builder
                        </button>
                        <button id="schema-tab-json" class="schema-builder-tab px-4 py-2 text-sm font-medium border-b-2 -mb-px ${this.schemaBuilder.activeTab === 'json' ? 'text-blue-600 border-blue-600' : 'text-gray-500 border-transparent'}">
                            Raw JSON
                        </button>
                        ${incompatible ? `<span class="ml-auto self-center text-xs text-amber-600">⚠️ Schema uses features the form can't fully represent — edit in JSON tab</span>` : ''}
                    </div>

                    <!-- Body -->
                    <div class="flex-1 overflow-hidden flex">
                        <!-- Form Builder pane -->
                        <div id="schema-form-pane" class="${this.schemaBuilder.activeTab === 'form' ? 'flex' : 'hidden'} flex-1 overflow-hidden">
                            <div class="flex-1 overflow-y-auto p-4 border-r border-gray-200">
                                <div id="schema-fields-container"></div>
                            </div>
                            <div class="w-2/5 flex flex-col bg-gray-900">
                                <div class="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
                                    <span class="text-xs font-medium text-gray-300">JSON Preview</span>
                                    <button id="schema-copy-json" class="text-xs text-blue-300 hover:text-blue-200">📋 Copy</button>
                                </div>
                                <pre id="schema-json-preview" class="flex-1 overflow-auto p-3 text-xs text-green-300 font-mono"></pre>
                            </div>
                        </div>

                        <!-- Raw JSON pane -->
                        <div id="schema-json-pane" class="${this.schemaBuilder.activeTab === 'json' ? 'flex' : 'hidden'} flex-1 flex-col p-4">
                            <textarea id="schema-raw-json" class="flex-1 w-full px-3 py-2 border border-gray-300 rounded font-mono text-xs">${this.escapeHtml(this.schemaBuilder.rawJson)}</textarea>
                            <p class="text-xs text-gray-500 mt-2">Edit JSON Schema directly. Switching back to Form Builder will try to parse it; unsupported features will keep the JSON tab.</p>
                        </div>
                    </div>

                    <!-- Footer -->
                    <div class="flex justify-end gap-2 px-4 py-3 border-t border-gray-200 bg-gray-50">
                        <button id="schema-edit-cancel" class="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50">Cancel</button>
                        <button id="schema-edit-save" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded font-medium">Save</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.renderSchemaBuilder();
        this.attachSchemaBuilderEvents();
    }

    /**
     * Build the HTML for the embedded schema builder body (tab bar + form
     * pane + JSON pane). Same DOM IDs as the standalone modal — both never
     * coexist (the agent modal closes before the library modal can open).
     */
    buildSchemaBuilderCoreHTML() {
        const sb = this.schemaBuilder || { activeTab: 'form', rawJson: '', incompatible: false };
        return `
            <!-- Tab bar -->
            <div class="flex border-b border-gray-200 px-3 bg-gray-50">
                <button id="schema-tab-form" type="button" class="schema-builder-tab px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${sb.activeTab === 'form' ? 'text-blue-600 border-blue-600' : 'text-gray-500 border-transparent'}">
                    Form Builder
                </button>
                <button id="schema-tab-json" type="button" class="schema-builder-tab px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${sb.activeTab === 'json' ? 'text-blue-600 border-blue-600' : 'text-gray-500 border-transparent'}">
                    Raw JSON
                </button>
                ${sb.incompatible ? `<span class="ml-auto self-center text-xs text-amber-600 px-2">⚠️ Uses features the form can't fully represent — edit in JSON tab</span>` : ''}
            </div>

            <!-- Body -->
            <div class="flex-1 overflow-hidden flex">
                <div id="schema-form-pane" class="${sb.activeTab === 'form' ? 'flex' : 'hidden'} flex-1 overflow-hidden">
                    <div class="flex-1 overflow-y-auto p-3 border-r border-gray-200">
                        <div class="mb-2">
                            <label class="text-xs font-medium text-gray-700">Templates: </label>
                            <select id="schema-template-select" class="px-2 py-1 border border-gray-300 rounded text-xs bg-white">
                                ${Object.entries(this.getSchemaBuilderTemplates()).map(([k, v]) =>
                                    `<option value="${k}">${v.label}</option>`
                                ).join('')}
                            </select>
                        </div>
                        <div id="schema-fields-container"></div>
                    </div>
                    <div class="w-2/5 flex flex-col bg-gray-900">
                        <div class="px-3 py-1.5 border-b border-gray-700 flex items-center justify-between">
                            <span class="text-xs font-medium text-gray-300">JSON Preview</span>
                            <button id="schema-copy-json" type="button" class="text-xs text-blue-300 hover:text-blue-200">📋 Copy</button>
                        </div>
                        <pre id="schema-json-preview" class="flex-1 overflow-auto p-3 text-xs text-green-300 font-mono"></pre>
                    </div>
                </div>

                <div id="schema-json-pane" class="${sb.activeTab === 'json' ? 'flex' : 'hidden'} flex-1 flex-col p-3">
                    <textarea id="schema-raw-json" class="flex-1 w-full px-2 py-1.5 border border-gray-300 rounded font-mono text-xs">${this.escapeHtml(sb.rawJson || '')}</textarea>
                    <p class="text-xs text-gray-500 mt-1">Edit JSON Schema directly. Switching back to Form Builder will try to parse it.</p>
                </div>
            </div>
        `;
    }

    /**
     * Mount the schema builder into a host element (for the agent node tab).
     * Initializes builder state from an inline schema or library reference,
     * renders, and attaches the core form-pane events.
     */
    mountSchemaBuilderInto(hostEl, options = {}) {
        if (!hostEl) return;

        // Resolve initial schema_json from inline > library reference > empty
        let schemaJson = null;
        if (options.inline && typeof options.inline === 'object') {
            // Inline can be { schema: {...} } wrapper or a bare schema
            schemaJson = options.inline.schema || options.inline;
        } else if (options.libraryId) {
            const lib = (this.workflowSchemas || []).find(s => String(s.id) === String(options.libraryId));
            if (lib) schemaJson = lib.schema_json;
        }

        // Initialize schemaBuilder state (same shape as showSchemaEditModal uses)
        let state = { fields: [] };
        let incompatible = false;
        if (schemaJson) {
            const result = this.deserializeJsonSchema(schemaJson);
            state = { fields: result.fields };
            incompatible = result.incompatible;
        }

        this.schemaBuilder = {
            isNew: true,
            id: null,
            name: '',
            description: '',
            strict: options.strict ?? true,
            state,
            activeTab: incompatible ? 'json' : 'form',
            incompatible,
            rawJson: JSON.stringify(
                schemaJson || { type: 'object', properties: {}, required: [], additionalProperties: false },
                null, 2
            ),
            embedded: true   // marks this instance as embedded (no modal-only wiring)
        };

        hostEl.innerHTML = this.buildSchemaBuilderCoreHTML();
        this.renderSchemaBuilder();
        this.attachSchemaBuilderEvents();
    }

    /**
     * Reset the embedded builder back to an empty schema.
     */
    clearEmbeddedSchemaBuilder() {
        if (!this.schemaBuilder) return;
        this.schemaBuilder.state = { fields: [] };
        this.schemaBuilder.rawJson = JSON.stringify(
            { type: 'object', properties: {}, required: [], additionalProperties: false },
            null, 2
        );
        this.schemaBuilder.incompatible = false;
        const ta = document.getElementById('schema-raw-json');
        if (ta) ta.value = this.schemaBuilder.rawJson;
        this.renderSchemaBuilder();
    }

    /**
     * Returns the JSON Schema currently represented by the embedded builder,
     * or null if it's empty / has no fields.
     */
    getEmbeddedSchemaJson() {
        if (!this.schemaBuilder) return null;
        const sb = this.schemaBuilder;
        if (sb.activeTab === 'json') {
            const ta = document.getElementById('schema-raw-json');
            if (!ta || !ta.value.trim()) return null;
            try {
                return JSON.parse(ta.value);
            } catch (e) {
                throw new Error('Output schema raw JSON is invalid: ' + e.message);
            }
        }
        if (!sb.state.fields || sb.state.fields.length === 0) return null;
        const errors = this.validateSchemaBuilderState();
        if (errors.length > 0) {
            throw new Error('Output schema has errors:\n' + errors.join('\n'));
        }
        return this.serializeBuilderState(sb.state, sb.strict);
    }

    /**
     * Render the form fields and JSON preview from the current builder state.
     */
    renderSchemaBuilder() {
        const container = document.getElementById('schema-fields-container');
        if (!container) return;

        const fields = this.schemaBuilder.state.fields;
        const fieldsHTML = fields.map(f => this.renderSchemaFieldRow(f, 0)).join('');

        container.innerHTML = `
            ${fieldsHTML || '<p class="text-xs text-gray-400 italic mb-2">No fields yet. Add one below or pick a template.</p>'}
            <button class="schema-add-field mt-2 px-3 py-1.5 text-xs font-medium text-blue-600 border border-dashed border-blue-300 rounded hover:bg-blue-50"
                    data-parent="root">+ Add field</button>
        `;

        this.updateSchemaJsonPreview();
    }

    /**
     * Render one field row, recursively for object/array-of-object fields.
     */
    renderSchemaFieldRow(field, depth) {
        const indent = depth * 16;
        const types = [
            ['string', 'String'],
            ['integer', 'Integer'],
            ['number', 'Number'],
            ['boolean', 'Boolean'],
            ['enum', 'Enum (fixed choices)'],
            ['date', 'Date'],
            ['email', 'Email'],
            ['url', 'URL'],
            ['array', 'Array'],
            ['object', 'Object']
        ];
        const typeOptions = types.map(([v, l]) =>
            `<option value="${v}" ${field.type === v ? 'selected' : ''}>${l}</option>`
        ).join('');

        const isContainer = field.type === 'object' || (field.type === 'array' && field.itemType === 'object');

        return `
            <div class="schema-field-row mb-2 bg-white border border-gray-200 rounded-lg" data-field-id="${field._id}" style="margin-left: ${indent}px">
                <div class="flex items-center gap-1.5 px-2 py-1.5 bg-gray-50 border-b border-gray-200 rounded-t-lg">
                    <button class="schema-move-up text-gray-400 hover:text-gray-700 px-1" data-id="${field._id}" title="Move up">↑</button>
                    <button class="schema-move-down text-gray-400 hover:text-gray-700 px-1" data-id="${field._id}" title="Move down">↓</button>
                    <input type="text" class="schema-field-name flex-1 px-2 py-1 text-sm border border-gray-300 rounded font-medium"
                           data-id="${field._id}" value="${this.escapeHtml(field.name || '')}" placeholder="field_name">
                    <select class="schema-field-type px-2 py-1 text-sm border border-gray-300 rounded bg-white" data-id="${field._id}">
                        ${typeOptions}
                    </select>
                    <label class="flex items-center gap-1 text-xs text-gray-700 px-1 whitespace-nowrap">
                        <input type="checkbox" class="schema-field-required w-3.5 h-3.5" data-id="${field._id}" ${field.required ? 'checked' : ''}>
                        Required
                    </label>
                    <button class="schema-field-delete text-red-500 hover:text-red-700 px-1.5" data-id="${field._id}" title="Delete">🗑</button>
                </div>
                <div class="px-2 py-2 space-y-1.5">
                    <input type="text" class="schema-field-description w-full px-2 py-1 text-xs border border-gray-200 rounded text-gray-600"
                           data-id="${field._id}" value="${this.escapeHtml(field.description || '')}" placeholder="Description (optional)">
                    ${this.renderSchemaFieldConstraints(field)}
                </div>
                ${isContainer ? this.renderSchemaNestedFields(field, depth) : ''}
            </div>
        `;
    }

    /**
     * Render type-specific constraints for a field.
     */
    renderSchemaFieldConstraints(field) {
        const c = field.constraints || {};
        const numInput = (key, label, value) => `
            <label class="text-xs text-gray-600 flex items-center gap-1">
                ${label}: <input type="number" class="schema-constraint w-16 px-1 py-0.5 border border-gray-200 rounded text-xs"
                                 data-id="${field._id}" data-key="${key}" value="${value ?? ''}">
            </label>
        `;

        switch (field.type) {
            case 'string':
                return `
                    <div class="flex flex-wrap gap-3 items-center">
                        ${numInput('minLength', 'Min length', c.minLength)}
                        ${numInput('maxLength', 'Max length', c.maxLength)}
                        <label class="text-xs text-gray-600 flex items-center gap-1 flex-1">
                            Pattern: <input type="text" class="schema-constraint flex-1 min-w-[100px] px-1 py-0.5 border border-gray-200 rounded text-xs font-mono"
                                            data-id="${field._id}" data-key="pattern" value="${this.escapeHtml(c.pattern || '')}" placeholder="^[A-Z]+$">
                        </label>
                    </div>
                `;
            case 'integer':
            case 'number':
                return `
                    <div class="flex flex-wrap gap-3 items-center">
                        ${numInput('minimum', 'Min', c.minimum)}
                        ${numInput('maximum', 'Max', c.maximum)}
                        ${numInput('multipleOf', 'Step', c.multipleOf)}
                    </div>
                `;
            case 'enum':
                return this.renderSchemaEnumValues(field);
            case 'array':
                return this.renderSchemaArrayConstraints(field);
            case 'boolean':
            case 'date':
            case 'email':
            case 'url':
                return '';
            case 'object':
                return '';
            default:
                return '';
        }
    }

    renderSchemaEnumValues(field) {
        const values = field.enumValues || [];
        const chips = values.map((v, i) => `
            <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 text-xs rounded">
                ${this.escapeHtml(String(v))}
                <button class="schema-enum-remove text-blue-600 hover:text-blue-900" data-id="${field._id}" data-index="${i}">×</button>
            </span>
        `).join('');
        return `
            <div class="flex flex-wrap gap-2 items-center">
                <span class="text-xs text-gray-600">Values:</span>
                <div class="flex flex-wrap gap-1 flex-1">${chips || '<span class="text-xs text-gray-400 italic">No values yet</span>'}</div>
                <input type="text" class="schema-enum-input px-2 py-0.5 border border-gray-200 rounded text-xs w-32"
                       data-id="${field._id}" placeholder="Add value...">
                <button class="schema-enum-add px-2 py-0.5 text-xs text-blue-600 border border-blue-300 rounded hover:bg-blue-50" data-id="${field._id}">Add</button>
            </div>
        `;
    }

    renderSchemaArrayConstraints(field) {
        const c = field.constraints || {};
        const itemTypes = [
            ['string', 'String'],
            ['integer', 'Integer'],
            ['number', 'Number'],
            ['boolean', 'Boolean'],
            ['object', 'Object (nested fields)']
        ];
        const itemOptions = itemTypes.map(([v, l]) =>
            `<option value="${v}" ${field.itemType === v ? 'selected' : ''}>${l}</option>`
        ).join('');
        const numInput = (key, label, value) => `
            <label class="text-xs text-gray-600 flex items-center gap-1">
                ${label}: <input type="number" class="schema-constraint w-16 px-1 py-0.5 border border-gray-200 rounded text-xs"
                                 data-id="${field._id}" data-key="${key}" value="${value ?? ''}">
            </label>
        `;
        return `
            <div class="flex flex-wrap gap-3 items-center">
                <label class="text-xs text-gray-600 flex items-center gap-1">
                    Items: <select class="schema-array-item-type px-2 py-0.5 border border-gray-200 rounded text-xs bg-white" data-id="${field._id}">${itemOptions}</select>
                </label>
                ${numInput('minItems', 'Min', c.minItems)}
                ${numInput('maxItems', 'Max', c.maxItems)}
                <label class="text-xs text-gray-600 flex items-center gap-1">
                    <input type="checkbox" class="schema-constraint w-3 h-3" data-id="${field._id}" data-key="uniqueItems" ${c.uniqueItems ? 'checked' : ''}>
                    Unique
                </label>
            </div>
        `;
    }

    renderSchemaNestedFields(field, depth) {
        let children;
        let containerId;
        if (field.type === 'object') {
            children = field.fields || [];
            containerId = field._id;
        } else if (field.type === 'array' && field.itemType === 'object') {
            children = field.itemFields || [];
            containerId = field._id;
        } else {
            return '';
        }
        const childrenHTML = children.map(c => this.renderSchemaFieldRow(c, depth + 1)).join('');
        const label = field.type === 'array' ? '+ Add item field' : '+ Add field';
        return `
            <div class="px-2 pb-2 pt-1 border-t border-gray-100 bg-gray-50/50">
                ${childrenHTML || '<p class="text-xs text-gray-400 italic mb-1" style="margin-left: ' + ((depth + 1) * 16) + 'px">No fields</p>'}
                <button class="schema-add-field mt-1 px-2 py-1 text-xs font-medium text-blue-600 border border-dashed border-blue-300 rounded hover:bg-blue-50"
                        data-parent="${containerId}" style="margin-left: ${(depth + 1) * 16}px">${label}</button>
            </div>
        `;
    }

    /**
     * Update the JSON preview pane to reflect the current builder state.
     */
    updateSchemaJsonPreview() {
        const pre = document.getElementById('schema-json-preview');
        if (!pre) return;
        const json = this.serializeBuilderState(this.schemaBuilder.state, this.schemaBuilder.strict);
        pre.textContent = JSON.stringify(json, null, 2);
    }

    /**
     * Wire all event listeners for the schema builder modal.
     * Uses delegation so we don't need to re-bind after re-renders.
     */
    attachSchemaBuilderEvents() {
        const modal = document.getElementById('schema-edit-modal');
        if (!modal) return;

        const close = () => modal.remove();
        document.getElementById('schema-edit-close')?.addEventListener('click', close);
        document.getElementById('schema-edit-cancel')?.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        // Metadata
        document.getElementById('schema-meta-name')?.addEventListener('input', (e) => {
            this.schemaBuilder.name = e.target.value;
        });
        document.getElementById('schema-meta-description')?.addEventListener('input', (e) => {
            this.schemaBuilder.description = e.target.value;
        });
        document.getElementById('schema-meta-strict')?.addEventListener('change', (e) => {
            this.schemaBuilder.strict = e.target.checked;
            this.updateSchemaJsonPreview();
        });

        // Templates
        document.getElementById('schema-template-select')?.addEventListener('change', (e) => {
            const key = e.target.value;
            if (!key) return;
            const tpl = this.getSchemaBuilderTemplates()[key];
            if (!tpl) return;
            if (this.schemaBuilder.state.fields.length > 0) {
                if (!confirm(this.t('workflow.dialogs.confirmReplaceWithTemplate'))) {
                    e.target.value = '';
                    return;
                }
            }
            // Templates are built fresh each call so IDs are unique
            this.schemaBuilder.state = JSON.parse(JSON.stringify(tpl.state));
            // Re-id every field after the deep clone (clone preserves IDs which we want unique)
            this.reassignSchemaFieldIds(this.schemaBuilder.state.fields);
            this.renderSchemaBuilder();
        });

        // Tab switching
        document.getElementById('schema-tab-form')?.addEventListener('click', () => this.switchSchemaBuilderTab('form'));
        document.getElementById('schema-tab-json')?.addEventListener('click', () => this.switchSchemaBuilderTab('json'));

        // Copy JSON
        document.getElementById('schema-copy-json')?.addEventListener('click', () => {
            const pre = document.getElementById('schema-json-preview');
            if (pre) {
                navigator.clipboard.writeText(pre.textContent || '').then(() => {
                    this.showNotification(this.t('workflow.notifications.jsonCopied'));
                }).catch(() => {});
            }
        });

        // Form pane delegated events
        const formPane = document.getElementById('schema-form-pane');
        if (formPane) {
            // Text inputs (no re-render to preserve focus)
            formPane.addEventListener('input', (e) => {
                const t = e.target;
                if (t.classList.contains('schema-field-name')) {
                    const f = this.findSchemaFieldById(t.dataset.id);
                    if (f) { f.name = t.value; this.updateSchemaJsonPreview(); }
                } else if (t.classList.contains('schema-field-description')) {
                    const f = this.findSchemaFieldById(t.dataset.id);
                    if (f) { f.description = t.value; this.updateSchemaJsonPreview(); }
                } else if (t.classList.contains('schema-constraint')) {
                    const f = this.findSchemaFieldById(t.dataset.id);
                    if (f) {
                        if (!f.constraints) f.constraints = {};
                        const key = t.dataset.key;
                        if (t.type === 'checkbox') {
                            f.constraints[key] = t.checked;
                        } else if (t.type === 'number') {
                            f.constraints[key] = t.value === '' ? null : Number(t.value);
                        } else {
                            f.constraints[key] = t.value === '' ? null : t.value;
                        }
                        this.updateSchemaJsonPreview();
                    }
                }
            });

            // Selects, checkboxes (re-render to swap constraint editors)
            formPane.addEventListener('change', (e) => {
                const t = e.target;
                if (t.classList.contains('schema-field-type')) {
                    const f = this.findSchemaFieldById(t.dataset.id);
                    if (f) {
                        const newType = t.value;
                        f.type = newType;
                        // Reset/initialize type-specific fields
                        f.constraints = {};
                        if (newType === 'enum') {
                            f.enumValues = f.enumValues || [];
                            f.enumValueType = f.enumValueType || 'string';
                        }
                        if (newType === 'array') {
                            f.itemType = f.itemType || 'string';
                            if (f.itemType === 'object' && !f.itemFields) f.itemFields = [];
                        }
                        if (newType === 'object' && !f.fields) {
                            f.fields = [];
                        }
                        this.renderSchemaBuilder();
                    }
                } else if (t.classList.contains('schema-field-required')) {
                    const f = this.findSchemaFieldById(t.dataset.id);
                    if (f) { f.required = t.checked; this.updateSchemaJsonPreview(); }
                } else if (t.classList.contains('schema-array-item-type')) {
                    const f = this.findSchemaFieldById(t.dataset.id);
                    if (f) {
                        f.itemType = t.value;
                        if (f.itemType === 'object' && !f.itemFields) f.itemFields = [];
                        this.renderSchemaBuilder();
                    }
                } else if (t.classList.contains('schema-constraint') && t.type === 'checkbox') {
                    const f = this.findSchemaFieldById(t.dataset.id);
                    if (f) {
                        if (!f.constraints) f.constraints = {};
                        f.constraints[t.dataset.key] = t.checked;
                        this.updateSchemaJsonPreview();
                    }
                }
            });

            // Buttons
            formPane.addEventListener('click', (e) => {
                const t = e.target;
                if (t.classList.contains('schema-add-field')) {
                    const parentId = t.dataset.parent;
                    const container = this.findSchemaContainer(parentId);
                    if (container) {
                        container.push({
                            _id: this.schemaBuilderNewId(),
                            name: '',
                            type: 'string',
                            required: false,
                            description: '',
                            constraints: {}
                        });
                        this.renderSchemaBuilder();
                        // Focus the new field's name input
                        setTimeout(() => {
                            const inputs = document.querySelectorAll('.schema-field-name');
                            inputs[inputs.length - 1]?.focus();
                        }, 0);
                    }
                } else if (t.classList.contains('schema-field-delete')) {
                    const id = t.dataset.id;
                    const arr = this.findSchemaParentArray(id);
                    if (arr) {
                        const idx = arr.findIndex(f => f._id === id);
                        if (idx >= 0) arr.splice(idx, 1);
                        this.renderSchemaBuilder();
                    }
                } else if (t.classList.contains('schema-move-up') || t.classList.contains('schema-move-down')) {
                    const id = t.dataset.id;
                    const arr = this.findSchemaParentArray(id);
                    if (arr) {
                        const idx = arr.findIndex(f => f._id === id);
                        const dir = t.classList.contains('schema-move-up') ? -1 : 1;
                        const newIdx = idx + dir;
                        if (newIdx >= 0 && newIdx < arr.length) {
                            [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
                            this.renderSchemaBuilder();
                        }
                    }
                } else if (t.classList.contains('schema-enum-add')) {
                    const id = t.dataset.id;
                    const f = this.findSchemaFieldById(id);
                    const input = document.querySelector(`.schema-enum-input[data-id="${id}"]`);
                    if (f && input && input.value.trim()) {
                        if (!f.enumValues) f.enumValues = [];
                        f.enumValues.push(input.value.trim());
                        input.value = '';
                        this.renderSchemaBuilder();
                    }
                } else if (t.classList.contains('schema-enum-remove')) {
                    const id = t.dataset.id;
                    const idx = parseInt(t.dataset.index, 10);
                    const f = this.findSchemaFieldById(id);
                    if (f && f.enumValues) {
                        f.enumValues.splice(idx, 1);
                        this.renderSchemaBuilder();
                    }
                }
            });

            // Enter key in enum input adds the value
            formPane.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.target.classList.contains('schema-enum-input')) {
                    e.preventDefault();
                    const id = e.target.dataset.id;
                    const btn = document.querySelector(`.schema-enum-add[data-id="${id}"]`);
                    btn?.click();
                }
            });
        }

        // Save
        document.getElementById('schema-edit-save')?.addEventListener('click', () => this.saveSchemaFromBuilder());
    }

    /**
     * Reassign fresh _id values to all fields in a tree (used after cloning a template).
     */
    reassignSchemaFieldIds(fields) {
        (fields || []).forEach(f => {
            f._id = this.schemaBuilderNewId();
            if (f.fields) this.reassignSchemaFieldIds(f.fields);
            if (f.itemFields) this.reassignSchemaFieldIds(f.itemFields);
        });
    }

    /**
     * Switch between Form Builder and Raw JSON tabs.
     */
    switchSchemaBuilderTab(tab) {
        if (tab === this.schemaBuilder.activeTab) return;

        if (tab === 'json') {
            // Going from form → JSON: serialize current state
            this.schemaBuilder.rawJson = JSON.stringify(
                this.serializeBuilderState(this.schemaBuilder.state, this.schemaBuilder.strict),
                null, 2
            );
            const ta = document.getElementById('schema-raw-json');
            if (ta) ta.value = this.schemaBuilder.rawJson;
        } else {
            // Going from JSON → form: parse and try to deserialize
            const ta = document.getElementById('schema-raw-json');
            if (ta) {
                try {
                    const parsed = JSON.parse(ta.value);
                    const result = this.deserializeJsonSchema(parsed);
                    if (result.incompatible) {
                        if (!confirm(this.t('workflow.dialogs.confirmSwitchToFormLossy'))) {
                            return;
                        }
                    }
                    this.schemaBuilder.state = { fields: result.fields };
                    this.schemaBuilder.rawJson = ta.value;
                } catch (e) {
                    alert(this.t('workflow.errors.jsonInvalid', { error: e.message }));
                    return;
                }
            }
        }

        this.schemaBuilder.activeTab = tab;

        // Update tab UI
        const formTab = document.getElementById('schema-tab-form');
        const jsonTab = document.getElementById('schema-tab-json');
        const formPane = document.getElementById('schema-form-pane');
        const jsonPane = document.getElementById('schema-json-pane');

        if (tab === 'form') {
            formTab?.classList.add('text-blue-600', 'border-blue-600');
            formTab?.classList.remove('text-gray-500', 'border-transparent');
            jsonTab?.classList.remove('text-blue-600', 'border-blue-600');
            jsonTab?.classList.add('text-gray-500', 'border-transparent');
            formPane?.classList.remove('hidden');
            formPane?.classList.add('flex');
            jsonPane?.classList.add('hidden');
            jsonPane?.classList.remove('flex');
            this.renderSchemaBuilder();
        } else {
            jsonTab?.classList.add('text-blue-600', 'border-blue-600');
            jsonTab?.classList.remove('text-gray-500', 'border-transparent');
            formTab?.classList.remove('text-blue-600', 'border-blue-600');
            formTab?.classList.add('text-gray-500', 'border-transparent');
            jsonPane?.classList.remove('hidden');
            jsonPane?.classList.add('flex');
            formPane?.classList.add('hidden');
            formPane?.classList.remove('flex');
        }
    }

    /**
     * Save the schema currently in the builder. Validates and POSTs/PUTs.
     */
    async saveSchemaFromBuilder() {
        const sb = this.schemaBuilder;
        if (!sb) return;

        const name = (document.getElementById('schema-meta-name')?.value || '').trim();
        const description = (document.getElementById('schema-meta-description')?.value || '').trim();
        const strict = document.getElementById('schema-meta-strict')?.checked ?? true;

        if (!name) { alert(this.t('workflow.validation.schemaNameRequired')); return; }
        if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
            alert(this.t('workflow.validation.schemaNameInvalidChars'));
            return;
        }

        // Build JSON Schema from whichever tab is active
        let schemaJson;
        if (sb.activeTab === 'json') {
            const ta = document.getElementById('schema-raw-json');
            try {
                schemaJson = JSON.parse(ta.value);
            } catch (e) {
                alert(this.t('workflow.errors.rawJsonInvalid', { error: e.message }));
                return;
            }
        } else {
            // Validate field names in form mode
            const errors = this.validateSchemaBuilderState();
            if (errors.length > 0) {
                alert(this.t('workflow.errors.cannotSaveSchema', { errors: errors.join('\n') }));
                return;
            }
            schemaJson = this.serializeBuilderState(sb.state, strict);
        }

        const body = { name, description, schema_json: schemaJson, strict };
        const url = sb.isNew
            ? `${this.apiBase}/workflow-schemas`
            : `${this.apiBase}/workflow-schemas/${sb.id}`;

        try {
            const res = await fetch(url, {
                method: sb.isNew ? 'POST' : 'PUT',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const result = await res.json();
            if (!res.ok || result.success === false) {
                const errs = result.validation_errors ? '\n' + result.validation_errors.join('\n') : '';
                alert((result.error || 'Failed to save schema') + errs);
                return;
            }
            document.getElementById('schema-edit-modal')?.remove();
            await this.loadWorkflowSchemas(true);
            // Refresh the parent schemas list modal
            document.getElementById('workflow-schemas-modal')?.remove();
            this.showWorkflowSchemasModal();
        } catch (e) {
            alert(this.t('workflow.errors.saveSchemaFailed', { error: e.message }));
        }
    }

    /**
     * Validate the builder state. Returns array of error messages.
     */
    validateSchemaBuilderState() {
        const errors = [];
        const seenAtLevel = new Set();
        const checkFields = (fields, path) => {
            const seen = new Set();
            (fields || []).forEach((f, i) => {
                const where = path ? `${path}[${i}]` : `field ${i + 1}`;
                if (!f.name || !f.name.trim()) {
                    errors.push(`${where}: name is required`);
                } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.name)) {
                    errors.push(`${where} (${f.name}): name must start with a letter/underscore and contain only letters, numbers, underscores`);
                } else if (seen.has(f.name)) {
                    errors.push(`${where}: duplicate field name "${f.name}"`);
                } else {
                    seen.add(f.name);
                }
                if (f.type === 'enum' && (!f.enumValues || f.enumValues.length === 0)) {
                    errors.push(`${where} (${f.name}): enum needs at least one value`);
                }
                if (f.type === 'object') checkFields(f.fields, `${where}.${f.name}`);
                if (f.type === 'array' && f.itemType === 'object') checkFields(f.itemFields, `${where}.${f.name}[items]`);
            });
        };
        checkFields(this.schemaBuilder.state.fields, '');
        return errors;
    }

    /**
     * Refresh the agent modal's schema dropdown after the library was updated.
     */
    refreshAgentModalSchemaDropdown() {
        const select = document.getElementById('agent-output-schema-select');
        if (!select) return;
        const currentValue = select.value;
        const options = ['<option value="">— None (free-form text) —</option>'];
        (this.workflowSchemas || []).forEach(s => {
            options.push(`<option value="${s.id}">${this.escapeHtml(s.name)}</option>`);
        });
        options.push(`<option value="__inline__">✏️ Inline schema…</option>`);
        select.innerHTML = options.join('');
        // Try to restore previous selection
        if (currentValue) select.value = currentValue;
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Export for use
window.WorkflowEditor = WorkflowEditor;
