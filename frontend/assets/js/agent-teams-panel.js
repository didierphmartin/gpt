/**
 * Agent Teams Panel
 *
 * Handles the UI for creating and managing AI agent teams.
 * - Sidebar: Tree view of teams and agents
 * - Content: Editor panel for the selected team/agent
 */
class AgentTeamsPanel {
    constructor() {
        // Sidebar elements
        this.createTeamBtn = document.getElementById('create-team-btn');
        this.teamsTree = document.getElementById('teams-tree');

        // Content panel elements
        this.contentPanel = document.getElementById('agent-teams-content');
        this.placeholder = document.getElementById('agent-teams-placeholder');
        this.editor = document.getElementById('agent-teams-editor');
        this.newTeamForm = document.getElementById('new-team-form');
        this.teamInfoSection = document.getElementById('team-info-section');
        this.agentFormContainer = document.getElementById('agent-form-container');
        this.teamAgentsList = document.getElementById('team-agents-list');

        // Chat panes (to hide when showing agent teams)
        this.primaryPane = document.getElementById('primary-pane');
        this.verifierPane = document.getElementById('verifier-pane');
        this.comparePane = document.getElementById('compare-pane');
        this.splitDivider = document.getElementById('split-pane-divider');
        this.providerBar = document.getElementById('provider-bar');
        this.infoBar = document.querySelector('.bg-blue-50.border-b.border-blue-200');
        this.inputBar = document.getElementById('input-bar');
        this.progressBar = document.getElementById('progress-bar');

        // Active state
        this.isActive = false;

        // State
        this.teams = [];
        this.selectedTeamId = null;
        this.editingAgentId = null;
        this.draggedAgentId = null;  // For drag and drop reordering

        // Agent activity tracking for real-time visualization
        this.activeAgents = new Map(); // agentId -> { status: 'processing'|'delegating'|'completed'|'error', startTime }
        this.delegationChain = []; // Array of { from, to, task } for visualizing delegation flow

        // View state: 'team' | 'agent'
        this.currentView = 'team';
        this.viewingAgentId = null;

        // Provider/model options - loaded from backend API
        this.providers = [];
        this.providersLoaded = false;
        this.providersLoadingPromise = null;
        this.loadError = null;

        // Available tools - loaded from backend API
        this.availableTools = [];

        // Delegation tools (auto-added for managers)
        this.delegationTools = [
            { name: 'delegate_to_agent', description: 'Delegate to another agent' },
            { name: 'list_available_agents', description: 'List available agents' },
            { name: 'run_agents_parallel', description: 'Run agents in parallel' },
        ];

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.renderTree(); // Initial empty render
        this.loadProviders();
        this.loadTeamsFromAPI(); // Load teams from backend
        this.injectActivityStyles(); // Add CSS for agent activity states
    }

    /**
     * Inject CSS styles for agent activity visualization
     */
    injectActivityStyles() {
        if (document.getElementById('agent-activity-styles')) return;

        const style = document.createElement('style');
        style.id = 'agent-activity-styles';
        style.textContent = `
            /* Agent processing state - pulsing border */
            .agent-processing {
                animation: agent-pulse 1.5s ease-in-out infinite;
                border-color: #3b82f6 !important;
                box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
            }

            @keyframes agent-pulse {
                0%, 100% {
                    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
                }
                50% {
                    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.5);
                }
            }

            /* Agent delegating state - animated gradient border */
            .agent-delegating {
                border-color: #8b5cf6 !important;
                animation: agent-delegate 1s ease-in-out infinite;
                position: relative;
            }

            @keyframes agent-delegate {
                0%, 100% {
                    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.4);
                }
                50% {
                    box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.6);
                }
            }

            /* Agent receiving delegation */
            .agent-receiving {
                animation: agent-receive 0.5s ease-out;
                border-color: #f59e0b !important;
            }

            @keyframes agent-receive {
                0% {
                    transform: scale(1);
                }
                50% {
                    transform: scale(1.02);
                }
                100% {
                    transform: scale(1);
                }
            }

            /* Agent completed successfully */
            .agent-completed {
                border-color: #10b981 !important;
                animation: agent-complete 0.5s ease-out;
            }

            @keyframes agent-complete {
                0% {
                    box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.6);
                }
                100% {
                    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
                }
            }

            /* Agent error state */
            .agent-error {
                border-color: #ef4444 !important;
                animation: agent-error 0.5s ease-out;
            }

            @keyframes agent-error {
                0%, 20%, 40%, 60%, 80%, 100% {
                    transform: translateX(0);
                }
                10%, 30%, 50%, 70%, 90% {
                    transform: translateX(-2px);
                }
            }

            /* Activity log fade in */
            @keyframes fade-in {
                from {
                    opacity: 0;
                    transform: translateY(-4px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }

            .animate-fade-in {
                animation: fade-in 0.2s ease-out;
            }

            /* Processing indicator for tree nodes */
            .agent-tree-node.agent-processing::before,
            .agent-card.agent-processing::before {
                content: '';
                position: absolute;
                left: 4px;
                top: 50%;
                transform: translateY(-50%);
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background-color: #3b82f6;
                animation: blink 1s ease-in-out infinite;
            }

            @keyframes blink {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.3; }
            }

            .agent-tree-node,
            .agent-card {
                position: relative;
                transition: border-color 0.3s, box-shadow 0.3s, transform 0.2s;
            }

            /* Drag and drop styles */
            .agent-card.dragging {
                opacity: 0.5;
                transform: scale(0.98);
            }

            .agent-card.drag-over {
                border-color: #3b82f6;
                border-style: dashed;
                background-color: #eff6ff;
            }

            .agent-card.drag-over-top {
                border-top: 3px solid #3b82f6;
            }

            .agent-card.drag-over-bottom {
                border-bottom: 3px solid #3b82f6;
            }

            .drag-handle {
                user-select: none;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Load providers and tools from backend API
     */
    async loadProviders() {
        // If already loading, return the existing promise
        if (this.providersLoadingPromise) {
            return this.providersLoadingPromise;
        }

        this.providersLoadingPromise = this._doLoadProviders();
        return this.providersLoadingPromise;
    }

    async _doLoadProviders() {
        try {
            // Reuse providers from chatApp if already loaded (same data source)
            if (window.chatApp && window.chatApp.providers && window.chatApp.providers.length > 0) {
                this.providers = window.chatApp.providers;
                this.availableTools = (window.chatApp.functions || []).map(name => ({
                    name: name,
                    description: name.startsWith('mcp_') ? 'MCP Tool' : 'Built-in',
                    isMCP: name.startsWith('mcp_'),
                    type: name.startsWith('mcp_') ? 'mcp' : 'builtin'
                }));
                this.loadError = null;
            } else {
                // Fallback: load from API directly (same as chat.js)
                const response = await fetch('/gpt/backend/api/v1/providers', {
                    headers: this.getAuthHeaders()
                });
                const data = await response.json();

                if (data.success && data.providers) {
                    this.providers = data.providers;
                    this.loadError = null;

                    if (data.functions && Array.isArray(data.functions)) {
                        this.availableTools = data.functions.map(name => ({
                            name: name,
                            description: name.startsWith('mcp_') ? 'MCP Tool' : 'Built-in',
                            isMCP: name.startsWith('mcp_'),
                            type: name.startsWith('mcp_') ? 'mcp' : 'builtin'
                        }));
                    }
                } else {
                    this.loadError = data.error || 'Failed to load providers from backend';
                    console.error('[AgentTeams] API error:', this.loadError);
                }
            }

            // Also load tools from agents API (includes delegation tools)
            await this.loadAgentTools();
        } catch (error) {
            this.loadError = error.message || 'Failed to connect to backend';
            console.error('[AgentTeams] Failed to load providers:', error);
        } finally {
            this.providersLoaded = true;
            this.providersLoadingPromise = null;
        }
    }

    /**
     * Load tools from agents API (includes delegation tools)
     */
    async loadAgentTools() {
        try {
            const response = await fetch('/gpt/backend/api/v1/agents/tools', {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success && data.tools) {
                // Add delegation tools to availableTools
                if (data.tools.delegation) {
                    const delegationTools = data.tools.delegation.map(tool => ({
                        name: tool.name,
                        description: tool.description,
                        isMCP: false,
                        type: 'delegation',
                        isDelegation: true
                    }));

                    // Add delegation tools if not already present
                    for (const tool of delegationTools) {
                        if (!this.availableTools.some(t => t.name === tool.name)) {
                            this.availableTools.push(tool);
                        }
                    }
                }

                // Also update builtin and mcp tools with better descriptions
                if (data.tools.builtin) {
                    for (const tool of data.tools.builtin) {
                        const existing = this.availableTools.find(t => t.name === tool.name);
                        if (existing) {
                            existing.description = tool.description || existing.description;
                        }
                    }
                }

                if (data.tools.mcp) {
                    for (const tool of data.tools.mcp) {
                        const existing = this.availableTools.find(t => t.name === tool.name);
                        if (existing) {
                            existing.description = tool.description || existing.description;
                            existing.server = tool.server;
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[AgentTeams] Failed to load agent tools:', error);
        }
    }

    /**
     * Get auth headers for API requests (same as chat.js)
     */
    getAuthHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (window.authManager && window.authManager.token) {
            headers['Authorization'] = `Bearer ${window.authManager.token}`;
        }
        return headers;
    }

    // ==========================================
    // API METHODS
    // ==========================================

    /**
     * Load teams from backend API
     */
    async loadTeamsFromAPI() {
        try {
            const response = await fetch('/gpt/backend/api/v1/teams', {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success && data.data) {
                // Transform backend data to frontend format
                this.teams = data.data.map(team => ({
                    id: team.id,
                    name: team.name,
                    description: team.description || '',
                    workspace_id: team.workspace_id,
                    agents: (team.agents || []).map(agent => this.transformAgentFromAPI(agent)),
                    expanded: true
                }));
                this.renderTree();
            } else {
                console.error('[AgentTeams] Failed to load teams:', data.error);
                // Try to load from localStorage as fallback for offline/unauthenticated
                this.loadFromStorage();
            }
        } catch (error) {
            console.error('[AgentTeams] Error loading teams from API:', error);
            // Fallback to localStorage
            this.loadFromStorage();
        }
    }

    /**
     * Transform agent from API format to frontend format
     */
    transformAgentFromAPI(agent) {
        return {
            id: agent.id,
            name: agent.name,
            description: agent.description || '',
            agent_type: agent.agent_type || 'standard',
            display_order: agent.display_order ?? 0,  // Pipeline order from backend
            provider: agent.provider || 'claude',
            model: agent.model || '',
            instructions: agent.instructions || '',
            tools: agent.tools || [],
            settings: agent.settings || { temperature: 0.7, max_tokens: 4096 },
            avatar_url: agent.avatar_url,
            visibility: agent.visibility || 'personal',
            enabled: agent.enabled !== false
        };
    }

    /**
     * Transform agent to API format for saving
     */
    transformAgentToAPI(agent, teamId) {
        return {
            team_id: teamId,
            name: agent.name,
            description: agent.description || '',
            agent_type: agent.agent_type || 'standard',
            provider: agent.provider || 'claude',
            model: agent.model || null,
            instructions: agent.instructions || '',
            tools: agent.tools || [],
            settings: agent.settings || { temperature: 0.7, max_tokens: 4096 },
            visibility: 'personal',
            enabled: true
        };
    }

    /**
     * Create a new team via API
     */
    async createTeamAPI(name, description) {
        try {
            const response = await fetch('/gpt/backend/api/v1/teams', {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ name, description })
            });
            const data = await response.json();

            if (data.success && data.data) {
                return {
                    id: data.data.id,
                    name: data.data.name,
                    description: data.data.description || '',
                    agents: [],
                    expanded: true
                };
            } else {
                throw new Error(data.error || 'Failed to create team');
            }
        } catch (error) {
            console.error('[AgentTeams] Error creating team:', error);
            throw error;
        }
    }

    /**
     * Update a team via API
     */
    async updateTeamAPI(teamId, name, description) {
        try {
            const response = await fetch(`/gpt/backend/api/v1/teams/${teamId}`, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ name, description })
            });
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to update team');
            }
            return data.data;
        } catch (error) {
            console.error('[AgentTeams] Error updating team:', error);
            throw error;
        }
    }

    /**
     * Delete a team via API
     */
    async deleteTeamAPI(teamId) {
        try {
            const response = await fetch(`/gpt/backend/api/v1/teams/${teamId}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to delete team');
            }
            return true;
        } catch (error) {
            console.error('[AgentTeams] Error deleting team:', error);
            throw error;
        }
    }

    /**
     * Create an agent via API
     */
    async createAgentAPI(agentData, teamId) {
        try {
            const response = await fetch('/gpt/backend/api/v1/agents', {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(this.transformAgentToAPI(agentData, teamId))
            });
            const data = await response.json();

            if (data.success && data.data) {
                return this.transformAgentFromAPI(data.data);
            } else {
                throw new Error(data.error || 'Failed to create agent');
            }
        } catch (error) {
            console.error('[AgentTeams] Error creating agent:', error);
            throw error;
        }
    }

    /**
     * Update an agent via API
     */
    async updateAgentAPI(agentId, agentData, teamId) {
        try {
            const response = await fetch(`/gpt/backend/api/v1/agents/${agentId}`, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(this.transformAgentToAPI(agentData, teamId))
            });
            const data = await response.json();

            if (data.success && data.data) {
                return this.transformAgentFromAPI(data.data);
            } else {
                throw new Error(data.error || 'Failed to update agent');
            }
        } catch (error) {
            console.error('[AgentTeams] Error updating agent:', error);
            throw error;
        }
    }

    /**
     * Delete an agent via API
     */
    async deleteAgentAPI(agentId) {
        try {
            const response = await fetch(`/gpt/backend/api/v1/agents/${agentId}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to delete agent');
            }
            return true;
        } catch (error) {
            console.error('[AgentTeams] Error deleting agent:', error);
            throw error;
        }
    }

    setupEventListeners() {
        // Create team button in sidebar
        if (this.createTeamBtn) {
            this.createTeamBtn.addEventListener('click', () => this.showNewTeamForm());
        }

        // Tree clicks
        if (this.teamsTree) {
            this.teamsTree.addEventListener('click', (e) => this.handleTreeClick(e));
        }

        // New team form buttons
        const cancelNewTeamBtn = document.getElementById('cancel-new-team-btn');
        const saveNewTeamBtn = document.getElementById('save-new-team-btn');
        if (cancelNewTeamBtn) {
            cancelNewTeamBtn.addEventListener('click', () => this.hideNewTeamForm());
        }
        if (saveNewTeamBtn) {
            saveNewTeamBtn.addEventListener('click', () => this.saveNewTeam());
        }

        // Add agent button in content panel
        const addAgentContentBtn = document.getElementById('add-agent-content-btn');
        if (addAgentContentBtn) {
            addAgentContentBtn.addEventListener('click', () => this.showAgentForm());
        }

        // Agent form container clicks (for save/cancel/delete)
        if (this.agentFormContainer) {
            this.agentFormContainer.addEventListener('click', (e) => this.handleAgentFormClick(e));
            this.agentFormContainer.addEventListener('change', (e) => this.handleAgentFormChange(e));
        }

        // Team agents list clicks
        if (this.teamAgentsList) {
            this.teamAgentsList.addEventListener('click', (e) => this.handleAgentListClick(e));
        }

        // Team tab switching (Manual, Scheduled, Settings)
        const runTabManual = document.getElementById('run-tab-manual');
        const runTabScheduled = document.getElementById('run-tab-scheduled');
        const runTabSettings = document.getElementById('run-tab-settings');
        if (runTabManual) {
            runTabManual.addEventListener('click', () => this.switchTeamTab('manual'));
        }
        if (runTabScheduled) {
            runTabScheduled.addEventListener('click', () => this.switchTeamTab('scheduled'));
        }
        if (runTabSettings) {
            runTabSettings.addEventListener('click', () => this.switchTeamTab('settings'));
        }

        // Run team button
        const runTeamBtn = document.getElementById('run-team-btn');
        if (runTeamBtn) {
            runTeamBtn.addEventListener('click', () => this.runTeam());
        }

        // Team action buttons (Save, Delete)
        const saveTeamBtn = document.getElementById('save-team-btn');
        const deleteTeamBtn = document.getElementById('delete-team-btn');
        if (saveTeamBtn) {
            saveTeamBtn.addEventListener('click', () => this.saveTeamSettings());
        }
        if (deleteTeamBtn) {
            deleteTeamBtn.addEventListener('click', () => this.deleteTeamFromSettings());
        }

        // Response overlay controls
        const responseOverlay = document.getElementById('team-response-overlay');
        const closeResponseBtn = document.getElementById('close-response-btn');
        const toggleRawBtn = document.getElementById('team-toggle-raw-btn');
        const printResponseBtn = document.getElementById('print-response-btn');
        const viewResponseBtn = document.getElementById('view-response-btn');

        if (closeResponseBtn) {
            closeResponseBtn.addEventListener('click', () => this.hideResponseOverlay());
        }
        if (toggleRawBtn) {
            toggleRawBtn.addEventListener('click', () => this.toggleRawResponse());
        }
        if (printResponseBtn) {
            printResponseBtn.addEventListener('click', () => this.printResponse());
        }
        if (viewResponseBtn) {
            viewResponseBtn.addEventListener('click', () => this.viewStoredResponse());
        }
        // Click on dark background to close
        if (responseOverlay) {
            responseOverlay.addEventListener('click', (e) => {
                if (e.target === responseOverlay) {
                    this.hideResponseOverlay();
                }
            });
        }
    }

    /**
     * Get translation string
     */
    t(key) {
        if (window.i18n && window.i18n.t) {
            return window.i18n.t(key);
        }
        return key.split('.').pop();
    }

    // ==========================================
    // TREE VIEW (Sidebar)
    // ==========================================

    renderTree() {
        if (!this.teamsTree) return;

        if (this.teams.length === 0) {
            this.teamsTree.innerHTML = `
                <div class="text-center text-gray-400 text-xs py-6" data-i18n="agentTeams.noTeams">
                    ${this.t('agentTeams.noTeams')}
                </div>
            `;
            return;
        }

        this.teamsTree.innerHTML = this.teams.map(team => this.createTreeNodeHTML(team)).join('');
    }

    createTreeNodeHTML(team) {
        const isSelected = team.id === this.selectedTeamId;
        const isExpanded = team.expanded !== false;
        const agentCount = team.agents?.length || 0;

        const agentsHTML = isExpanded && team.agents?.length > 0
            ? team.agents.map(agent => this.createAgentTreeNodeHTML(team.id, agent)).join('')
            : '';

        return `
            <div class="team-tree-node ${isSelected ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'} border rounded-lg mb-1" data-team-id="${team.id}">
                <div class="team-header flex items-center justify-between px-2 py-1.5 cursor-pointer hover:bg-gray-50 rounded-t-lg" data-action="select-team">
                    <div class="flex items-center gap-1.5 flex-1 min-w-0">
                        <button class="text-gray-400 hover:text-gray-600 text-xs p-0.5" data-action="toggle-expand" title="${isExpanded ? 'Collapse' : 'Expand'}">
                            ${isExpanded ? '▼' : '▶'}
                        </button>
                        <span class="text-sm">${isExpanded ? '📂' : '📁'}</span>
                        <span class="text-xs font-medium text-gray-800 truncate">${team.name || 'Unnamed Team'}</span>
                        <span class="text-xs text-gray-400">(${agentCount})</span>
                    </div>
                    <div class="flex items-center gap-1">
                        <button class="text-green-500 hover:text-green-700 text-xs px-1" data-action="add-agent" title="${this.t('agentTeams.addAgent')}">+</button>
                        <button class="text-red-400 hover:text-red-600 text-xs px-1" data-action="delete-team" title="${this.t('common.delete')}">✕</button>
                    </div>
                </div>
                ${isExpanded ? `<div class="team-agents border-t border-gray-100">${agentsHTML || `<div class="text-gray-400 text-xs py-2 px-6 italic">${this.t('agentTeams.emptyTeam')}</div>`}</div>` : ''}
            </div>
        `;
    }

    createAgentTreeNodeHTML(teamId, agent) {
        const typeIcon = this.getTypeIcon(agent.agent_type);
        const typeLabel = agent.agent_type ? agent.agent_type.charAt(0).toUpperCase() + agent.agent_type.slice(1) : '';
        return `
            <div class="agent-tree-node flex items-center justify-between py-1.5 px-2 pl-7 hover:bg-gray-50 cursor-pointer border-b border-gray-50 last:border-b-0"
                 data-team-id="${teamId}" data-agent-id="${agent.id}" data-action="select-agent">
                <div class="flex items-center gap-1.5 flex-1 min-w-0">
                    <span class="text-xs">${typeIcon}</span>
                    <span class="text-xs text-gray-700 truncate">${agent.name || 'Unnamed'}</span>
                    <span class="text-xs text-gray-400">(${typeLabel})</span>
                </div>
                <div class="flex items-center gap-1">
                    <button class="text-green-500 hover:text-green-700 text-xs" data-action="run-agent" title="${this.t('agentTeams.run')}">▶</button>
                    <button class="text-red-400 hover:text-red-600 text-xs" data-action="delete-agent" title="${this.t('common.delete')}">✕</button>
                </div>
            </div>
        `;
    }

    handleTreeClick(e) {
        const action = e.target.closest('[data-action]')?.dataset.action;
        const teamNode = e.target.closest('[data-team-id]');
        const agentNode = e.target.closest('[data-agent-id]');

        const teamId = teamNode?.dataset.teamId;
        const agentId = agentNode?.dataset.agentId;

        // Prevent propagation for certain actions
        if (action === 'toggle-expand' || action === 'delete-team' || action === 'delete-agent' || action === 'run-agent' || action === 'add-agent') {
            e.stopPropagation();
        }

        switch (action) {
            case 'toggle-expand':
                this.toggleTeamExpand(teamId);
                break;
            case 'select-team':
                if (!agentId) this.selectTeam(teamId);
                break;
            case 'select-agent':
                // First select team, then show agent detail
                if (this.selectedTeamId !== ((!isNaN(teamId) ? parseInt(teamId, 10) : teamId))) {
                    this.selectedTeamId = !isNaN(teamId) ? parseInt(teamId, 10) : teamId;
                    this.renderTree();
                }
                this.showAgentDetail(agentId);
                break;
            case 'add-agent':
                this.selectTeam(teamId);
                this.showAgentForm();
                break;
            case 'delete-team':
                this.deleteTeam(teamId);
                break;
            case 'delete-agent':
                this.deleteAgent(teamId, agentId);
                break;
            case 'run-agent':
                this.runAgent(teamId, agentId);
                break;
        }
    }

    toggleTeamExpand(teamId) {
        // Convert to number if it's a numeric string
        const id = !isNaN(teamId) ? parseInt(teamId, 10) : teamId;
        const team = this.teams.find(t => t.id === id);
        if (team) {
            team.expanded = !team.expanded;
            this.saveToStorage();
            this.renderTree();
        }
    }

    // ==========================================
    // CONTENT PANEL
    // ==========================================

    showNewTeamForm() {
        // Hide other sections
        if (this.placeholder) this.placeholder.classList.add('hidden');
        if (this.editor) this.editor.classList.add('hidden');
        if (this.newTeamForm) {
            this.newTeamForm.classList.remove('hidden');
            const nameInput = document.getElementById('new-team-name');
            if (nameInput) {
                nameInput.value = '';
                nameInput.focus();
            }
            const descInput = document.getElementById('new-team-description');
            if (descInput) descInput.value = '';
        }
    }

    hideNewTeamForm() {
        if (this.newTeamForm) this.newTeamForm.classList.add('hidden');

        if (this.selectedTeamId) {
            this.showTeamEditor();
        } else {
            if (this.placeholder) this.placeholder.classList.remove('hidden');
        }
    }

    async saveNewTeam() {
        const nameInput = document.getElementById('new-team-name');
        const descInput = document.getElementById('new-team-description');

        const name = nameInput?.value?.trim();
        const description = descInput?.value?.trim();

        if (!name) {
            alert(this.t('agentTeams.teamName') + ' is required');
            nameInput?.focus();
            return;
        }

        try {
            // Create team via API
            const newTeam = await this.createTeamAPI(name, description);
            this.teams.push(newTeam);
            this.saveToStorage(); // Keep local cache in sync
            this.renderTree();

            // Select the new team
            this.selectTeam(newTeam.id);
        } catch (error) {
            alert('Failed to create team: ' + error.message);
        }
    }

    selectTeam(teamId) {
        // Convert to number if it's a numeric string (API returns numbers, DOM returns strings)
        const newTeamId = !isNaN(teamId) ? parseInt(teamId, 10) : teamId;

        // If switching to a different team, clear the stored response
        if (this.selectedTeamId !== newTeamId) {
            this.clearStoredResponse();
        }

        this.selectedTeamId = newTeamId;
        this.editingAgentId = null;
        this.currentView = 'team';
        this.viewingAgentId = null;
        this.renderTree();
        this.showTeamOverview();
    }

    /**
     * Show agent detail view (expanded)
     */
    showAgentDetail(agentId) {
        const aId = !isNaN(agentId) ? parseInt(agentId, 10) : agentId;
        this.currentView = 'agent';
        this.viewingAgentId = aId;
        this.editAgent(aId);
    }

    showTeamOverview() {
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (!team) return;

        // Hide other sections
        if (this.placeholder) this.placeholder.classList.add('hidden');
        if (this.newTeamForm) this.newTeamForm.classList.add('hidden');
        if (this.editor) this.editor.classList.remove('hidden');

        // Update team info
        const teamNameEl = document.getElementById('editor-team-name');
        const teamDescEl = document.getElementById('editor-team-description');
        if (teamNameEl) teamNameEl.textContent = team.name;
        if (teamDescEl) teamDescEl.textContent = team.description || 'No description';

        // Hide agent form (show agents list)
        if (this.agentFormContainer) this.agentFormContainer.classList.add('hidden');
        if (this.teamAgentsList) this.teamAgentsList.classList.remove('hidden');

        // Render agents list (clickable cards)
        this.renderAgentsList();

        // Refresh translations for dynamically shown content
        if (window.i18n && window.i18n.updateAllTranslations) {
            window.i18n.updateAllTranslations();
        }
    }

    /**
     * Legacy alias for compatibility
     */
    showTeamEditor() {
        this.showTeamOverview();
    }

    renderAgentsList() {
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (!team || !this.teamAgentsList) return;

        if (!team.agents || team.agents.length === 0) {
            this.teamAgentsList.innerHTML = `
                <div class="text-center text-gray-400 text-sm py-8" data-i18n="agentTeams.emptyTeam">
                    ${this.t('agentTeams.emptyTeam')}
                </div>
            `;
            return;
        }

        this.teamAgentsList.innerHTML = team.agents.map(agent => this.createAgentCardHTML(agent)).join('');

        // Setup drag and drop
        this.setupAgentDragDrop();
    }

    /**
     * Setup drag and drop for agent reordering
     */
    setupAgentDragDrop() {
        const cards = this.teamAgentsList.querySelectorAll('.agent-card[draggable="true"]');

        cards.forEach(card => {
            card.addEventListener('dragstart', (e) => this.handleDragStart(e));
            card.addEventListener('dragend', (e) => this.handleDragEnd(e));
            card.addEventListener('dragover', (e) => this.handleDragOver(e));
            card.addEventListener('dragenter', (e) => this.handleDragEnter(e));
            card.addEventListener('dragleave', (e) => this.handleDragLeave(e));
            card.addEventListener('drop', (e) => this.handleDrop(e));
        });
    }

    handleDragStart(e) {
        // Prevent dragging if can_reorder is false (managers)
        const canReorder = e.target.dataset.canReorder !== 'false';
        if (!canReorder) {
            e.preventDefault();
            return;
        }

        this.draggedAgentId = e.target.dataset.agentId;
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', this.draggedAgentId);
    }

    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        // Remove all drag-over classes
        this.teamAgentsList.querySelectorAll('.agent-card').forEach(card => {
            card.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
        });
        this.draggedAgentId = null;
    }

    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    }

    handleDragEnter(e) {
        e.preventDefault();
        const card = e.target.closest('.agent-card');
        if (card && card.dataset.agentId !== this.draggedAgentId) {
            card.classList.add('drag-over');
        }
    }

    handleDragLeave(e) {
        const card = e.target.closest('.agent-card');
        if (card) {
            // Only remove if we're actually leaving the card (not entering a child)
            const relatedTarget = e.relatedTarget;
            if (!card.contains(relatedTarget)) {
                card.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
            }
        }
    }

    async handleDrop(e) {
        e.preventDefault();
        const targetCard = e.target.closest('.agent-card');
        if (!targetCard) return;

        const targetAgentId = targetCard.dataset.agentId;
        const draggedAgentId = this.draggedAgentId;

        if (targetAgentId === draggedAgentId) return;

        // Get current team and agents
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (!team || !team.agents) return;

        // Find indices
        const draggedIndex = team.agents.findIndex(a => String(a.id) === String(draggedAgentId));
        const targetIndex = team.agents.findIndex(a => String(a.id) === String(targetAgentId));

        if (draggedIndex === -1 || targetIndex === -1) return;

        // Prevent dropping above a manager (managers must stay at top)
        const targetAgent = team.agents[targetIndex];
        if (targetIndex === 0 && targetAgent.agent_type === 'manager') {
            console.log('Cannot drop above manager - managers must stay at top');
            return;
        }

        // Reorder locally
        const [draggedAgent] = team.agents.splice(draggedIndex, 1);
        team.agents.splice(targetIndex, 0, draggedAgent);

        // Re-render immediately for visual feedback
        this.renderAgentsList();

        // Send reorder to backend
        await this.saveAgentOrder();
    }

    /**
     * Save the current agent order to the backend
     *
     * Note: The backend enforces that managers stay at position 0 (top).
     * If the submitted order violates this, it will be adjusted and
     * a notice will be returned.
     */
    async saveAgentOrder() {
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (!team || !team.agents) return;

        const agentIds = team.agents.map(a => a.id);

        console.log('[REORDER] Saving agent order:', { teamId: this.selectedTeamId, agentIds });

        try {
            const response = await fetch('/gpt/backend/api/v1/agents/reorder', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${window.authManager?.token || localStorage.getItem('auth_token')}`
                },
                body: JSON.stringify({
                    team_id: this.selectedTeamId,
                    agent_ids: agentIds
                })
            });

            const result = await response.json();
            console.log('[REORDER] Response:', response.status, result);

            if (!result.success) {
                console.error('[REORDER] Failed to save agent order:', result.error);
                // Reload to revert to server state
                await this.loadTeamsFromAPI();
                return;
            }

            // Update local agents with server response (includes pipeline info)
            if (result.agents) {
                team.agents = result.agents;
                this.renderAgentsList();
            }

            // Show notice if order was enforced (manager moved back to top)
            if (result.enforced && result.notice) {
                this.showToast(result.notice, 'info');
            }
        } catch (error) {
            console.error('[REORDER] Exception:', error);
        }
    }

    createAgentCardHTML(agent) {
        const typeIcon = this.getTypeIcon(agent.agent_type);
        const typeLabel = agent.agent_type ? agent.agent_type.charAt(0).toUpperCase() + agent.agent_type.slice(1) : 'Agent';

        // Count tools excluding auto-added delegation tools
        const delegationToolNames = this.delegationTools.map(t => t.name);
        const userSelectedTools = (agent.tools || []).filter(t => !delegationToolNames.includes(t));
        const toolCount = userSelectedTools.length;

        // Pipeline position badge (only for workers - shows execution order from backend)
        const isManager = agent.agent_type === 'manager';
        const canReorder = !isManager; // Managers can't be reordered

        // Show pipeline step for workers using display_order from backend
        // Manager is always at display_order 0, workers are 1, 2, 3...
        let pipelineBadge = '';
        if (!isManager && typeof agent.display_order === 'number' && agent.display_order > 0) {
            pipelineBadge = `<span class="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full">Step ${agent.display_order}</span>`;
        }

        // Drag handle - disabled for managers
        const dragHandle = canReorder
            ? '<span class="text-gray-400 drag-handle cursor-grab mr-1 text-sm">↕</span>'
            : '<span class="text-gray-200 mr-1 text-sm" title="Manager must stay at top">⚓</span>';

        // Card styling - managers have distinct border
        const cardBorder = isManager
            ? 'border-purple-200 bg-purple-50/50'
            : 'border-gray-200 bg-gray-50';

        const cursorClass = canReorder ? 'cursor-grab active:cursor-grabbing' : 'cursor-default';

        return `
            <div class="agent-card flex items-center justify-between p-4 rounded-lg border hover:border-blue-300 transition ${cardBorder} ${cursorClass}"
                 data-agent-id="${agent.id}"
                 data-can-reorder="${canReorder}"
                 draggable="${canReorder}">
                <div class="flex items-center gap-3">
                    ${dragHandle}
                    <span class="text-2xl">${typeIcon}</span>
                    <div>
                        <div class="flex items-center gap-2">
                            <span class="font-medium text-gray-800">${agent.name || 'Unnamed Agent'}</span>
                            ${pipelineBadge}
                        </div>
                        <div class="text-xs text-gray-500">${typeLabel} · ${agent.provider || 'Claude'} · ${toolCount} ${this.t('agentTeams.tools')}</div>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button class="text-blue-600 hover:text-blue-800 text-sm px-3 py-1.5 bg-blue-50 hover:bg-blue-100 rounded-lg transition" data-action="edit">
                        ${this.t('common.edit')}
                    </button>
                    <button class="text-red-500 hover:text-red-700 text-sm px-2 py-1.5 hover:bg-red-50 rounded-lg transition" data-action="delete">
                        ✕
                    </button>
                </div>
            </div>
        `;
    }

    handleAgentListClick(e) {
        const action = e.target.closest('[data-action]')?.dataset.action;
        const agentCard = e.target.closest('[data-agent-id]');
        const agentId = agentCard?.dataset.agentId;

        if (!agentId) return;

        switch (action) {
            case 'edit':
                this.editAgent(agentId);
                break;
            case 'delete':
                this.deleteAgent(this.selectedTeamId, agentId);
                break;
        }
    }

    // ==========================================
    // AGENT FORM
    // ==========================================

    async showAgentForm(agent = null) {
        // Ensure providers and tools are loaded before showing form
        if (!this.providersLoaded) {
            await this.loadProviders();
        }

        this.editingAgentId = agent?.id || 'new-agent-' + Date.now();

        if (!agent) {
            // Set default provider to first available from backend
            const defaultProvider = this.providers.length > 0 ? this.providers[0].name : '';
            agent = {
                id: this.editingAgentId,
                name: '',
                description: '',
                agent_type: '',
                provider: defaultProvider,
                model: '',
                instructions: '',
                tools: [],
                settings: { temperature: 0.7, max_tokens: 4096 }
            };
        }

        if (this.agentFormContainer) {
            // Hide the agents list when showing the form
            if (this.teamAgentsList) {
                this.teamAgentsList.classList.add('hidden');
            }

            this.agentFormContainer.innerHTML = this.createAgentFormHTML(agent);
            this.agentFormContainer.classList.remove('hidden');

            // Focus on type or name
            const typeSelect = this.agentFormContainer.querySelector('.agent-type-select');
            if (typeSelect) typeSelect.focus();
        }
    }

    editAgent(agentId) {
        // Convert to number if numeric string
        const aId = !isNaN(agentId) ? parseInt(agentId, 10) : agentId;

        const team = this.teams.find(t => t.id === this.selectedTeamId);
        const agent = team?.agents?.find(a => a.id === aId);
        if (agent) {
            this.showAgentForm(agent);
        }
    }

    createAgentFormHTML(agent) {
        const isNew = String(agent.id).startsWith('new-agent-');

        // Show error if providers failed to load
        if (this.loadError) {
            return `
                <div class="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                    <div class="font-medium mb-2">Error loading providers</div>
                    <div class="text-sm">${this.loadError}</div>
                    <button class="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700" onclick="window.agentTeamsPanel.loadProviders().then(() => window.agentTeamsPanel.showAgentForm())">
                        Retry
                    </button>
                </div>
            `;
        }

        // Check if there's already a manager in this team
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        const isCurrentAgentManager = agent.agent_type === 'manager';

        // For new agents or non-manager agents, check if team already has a manager
        let hasOtherManager = false;
        if (team?.agents) {
            console.log('[AgentTeams] Checking for manager in team:', team.name, 'agents:', team.agents.map(a => ({id: a.id, type: a.agent_type})));
            for (const a of team.agents) {
                // Skip the current agent being edited (only if it's a saved agent, not new)
                if (a.id === agent.id) continue;
                if (a.agent_type === 'manager') {
                    hasOtherManager = true;
                    console.log('[AgentTeams] Found manager:', a.name);
                    break;
                }
            }
        }
        console.log('[AgentTeams] hasOtherManager:', hasOtherManager, 'current agent id:', agent.id);

        // Build type options - if team has a manager, other agents can only be workers
        let typeOptions;
        if (hasOtherManager) {
            // Only worker option available (team already has a manager)
            typeOptions = `<option value="worker" selected>⚙️ Worker</option>`;
        } else if (isCurrentAgentManager) {
            // Current agent is the manager - show all options
            typeOptions = `
                <option value="standard" ${agent.agent_type === 'standard' ? 'selected' : ''}>🤖 Standard</option>
                <option value="manager" selected>👔 Manager</option>
                <option value="worker" ${agent.agent_type === 'worker' ? 'selected' : ''}>⚙️ Worker</option>
            `;
        } else {
            // No manager in team yet - show all options
            typeOptions = `
                <option value="" ${!agent.agent_type ? 'selected' : ''}>Select type...</option>
                <option value="standard" ${agent.agent_type === 'standard' ? 'selected' : ''}>🤖 Standard</option>
                <option value="manager" ${agent.agent_type === 'manager' ? 'selected' : ''}>👔 Manager</option>
                <option value="worker" ${agent.agent_type === 'worker' ? 'selected' : ''}>⚙️ Worker</option>
            `;
        }

        // Build provider options from backend API (same structure as chat.js)
        const providersOptions = this.providers.map(p =>
            `<option value="${p.name}" ${agent.provider === p.name ? 'selected' : ''}>${p.display_name || p.name}${p.available === false ? ' (unavailable)' : ''}</option>`
        ).join('');

        // Get current provider's default model
        const currentProvider = this.providers.find(p => p.name === agent.provider) || this.providers[0];
        const defaultModel = currentProvider?.model || '';

        // Separate built-in, MCP, and delegation tools
        const builtInTools = this.availableTools.filter(t => !t.isMCP && !t.isDelegation);
        const mcpTools = this.availableTools.filter(t => t.isMCP);
        const delegationTools = this.availableTools.filter(t => t.isDelegation || t.type === 'delegation');

        const createToolCheckbox = (tool, checked, disabled = false) => {
            const bgClass = tool.isMCP ? 'bg-purple-50' : (tool.isDelegation ? 'bg-indigo-50' : '');
            const textClass = tool.isMCP ? 'text-purple-600' : (tool.isDelegation ? 'text-indigo-600' : 'text-blue-600');
            const labelClass = tool.isMCP ? 'text-purple-700' : (tool.isDelegation ? 'text-indigo-700' : 'text-gray-700');

            return `
                <label class="flex items-center gap-2 p-1.5 hover:bg-gray-100 rounded cursor-pointer ${bgClass}" title="${tool.description || tool.name}">
                    <input type="checkbox" class="tool-checkbox w-3.5 h-3.5 ${textClass} rounded"
                           data-tool="${tool.name}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
                    <span class="text-xs ${labelClass} truncate">${tool.name}</span>
                </label>
            `;
        };

        const toolsHTML = `
            <div class="grid grid-cols-2 gap-1">
                ${builtInTools.map(tool => createToolCheckbox(tool, agent.tools?.includes(tool.name))).join('')}
            </div>
            ${mcpTools.length > 0 ? `
                <div class="mt-2 pt-2 border-t border-purple-200">
                    <div class="text-xs font-medium text-purple-700 mb-1">MCP Tools</div>
                    <div class="grid grid-cols-2 gap-1">
                        ${mcpTools.map(tool => createToolCheckbox(tool, agent.tools?.includes(tool.name))).join('')}
                    </div>
                </div>
            ` : ''}
        `;

        // Show delegation tools for managers (auto-enabled, cannot be unchecked)
        const delegationToolsHTML = agent.agent_type === 'manager' ? `
            <div class="mt-2 p-2 bg-indigo-50 rounded-lg border border-indigo-200">
                <div class="text-xs font-medium text-indigo-800 mb-1">Delegation Tools (Auto-enabled for Managers)</div>
                <div class="grid grid-cols-1 gap-1">
                    ${delegationTools.map(tool => `
                        <label class="flex items-center gap-2 p-1.5 rounded" title="${tool.description || ''}">
                            <input type="checkbox" class="w-3.5 h-3.5 text-indigo-600 rounded" checked disabled>
                            <span class="text-xs text-indigo-700">${tool.name}</span>
                            <span class="text-xs text-indigo-500 truncate flex-1">${tool.description || ''}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        ` : '';

        return `
            <div class="space-y-4" data-agent-id="${agent.id}">
                <div class="grid grid-cols-3 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">Type</label>
                        <select class="agent-type-select w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                            ${typeOptions}
                        </select>
                    </div>
                    <div class="col-span-2">
                        <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('agentTeams.fields.name')}</label>
                        <input type="text" class="agent-name-input w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                               value="${agent.name || ''}" placeholder="${this.t('agentTeams.fields.namePlaceholder')}">
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('agentTeams.fields.description')}</label>
                    <input type="text" class="agent-description-input w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                           value="${agent.description || ''}" placeholder="${this.t('agentTeams.fields.descriptionPlaceholder')}">
                </div>

                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('agentTeams.fields.provider')}</label>
                        <select class="agent-provider-select w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                            ${providersOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('agentTeams.fields.model')}</label>
                        <input type="text" class="agent-model-input w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                               value="${agent.model || defaultModel || ''}" placeholder="Default: ${defaultModel || 'auto'}">
                    </div>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('agentTeams.fields.systemPrompt')}</label>
                    <textarea class="agent-instructions-input w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 resize-y"
                              rows="10" placeholder="${this.t('agentTeams.fields.systemPromptPlaceholder')}">${agent.instructions || ''}</textarea>
                </div>

                <div class="tools-section collapsed">
                    <button type="button" class="tools-toggle flex items-center gap-2 text-sm font-medium text-gray-700 mb-1 hover:text-blue-600 transition"
                            onclick="this.parentElement.classList.toggle('collapsed')">
                        <span class="toggle-icon transition-transform">▼</span>
                        ${this.t('agentTeams.fields.tools')}
                        <span class="text-xs text-gray-400">(${agent.tools?.length || 0} selected)</span>
                    </button>
                    <div class="tools-content border border-gray-200 rounded-lg max-h-48 overflow-y-auto bg-white p-2">
                        ${toolsHTML}
                    </div>
                    ${delegationToolsHTML}
                </div>
                <style>
                    .tools-section.collapsed .tools-content { display: none; }
                    .tools-section.collapsed .toggle-icon { transform: rotate(-90deg); }
                </style>

                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">
                            ${this.t('agentTeams.fields.temperature')}: <span class="temperature-value">${agent.settings?.temperature || 0.7}</span>
                        </label>
                        <input type="range" class="agent-temperature-input w-full" min="0" max="1" step="0.1"
                               value="${agent.settings?.temperature || 0.7}">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">${this.t('agentTeams.fields.maxTokens')}</label>
                        <input type="number" class="agent-max-tokens-input w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                               value="${agent.settings?.max_tokens || 4096}" min="256" max="128000">
                    </div>
                </div>

                <div class="flex justify-end gap-3 pt-4 border-t border-gray-200">
                    ${!isNew ? `<button class="text-red-600 hover:text-red-800 px-4 py-2" data-action="delete-agent">${this.t('common.delete')}</button>` : ''}
                    <button class="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50" data-action="cancel-agent">
                        ${this.t('common.cancel')}
                    </button>
                    <button class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium" data-action="save-agent">
                        ${this.t('common.save')}
                    </button>
                </div>
            </div>
        `;
    }

    handleAgentFormClick(e) {
        const action = e.target.closest('[data-action]')?.dataset.action;

        switch (action) {
            case 'save-agent':
                this.saveAgent();
                break;
            case 'cancel-agent':
                this.hideAgentForm();
                break;
            case 'delete-agent':
                this.deleteAgent(this.selectedTeamId, this.editingAgentId);
                break;
        }
    }

    handleAgentFormChange(e) {
        // Temperature slider
        if (e.target.classList.contains('agent-temperature-input')) {
            const valueSpan = this.agentFormContainer.querySelector('.temperature-value');
            if (valueSpan) valueSpan.textContent = e.target.value;
        }

        // Provider change - update model field with provider's default model
        if (e.target.classList.contains('agent-provider-select')) {
            const modelInput = this.agentFormContainer.querySelector('.agent-model-input');
            const provider = this.providers.find(p => p.name === e.target.value);
            if (modelInput && provider) {
                modelInput.value = provider.model || '';
                modelInput.placeholder = `Default: ${provider.model || 'auto'}`;
            }
        }

        // Type change - re-render form for delegation tools
        if (e.target.classList.contains('agent-type-select')) {
            const agentData = this.collectAgentFormData();
            agentData.agent_type = e.target.value;

            // If selecting "manager", set all other agents in this team to "worker"
            if (e.target.value === 'manager') {
                const team = this.teams.find(t => t.id === this.selectedTeamId);
                if (team && team.agents) {
                    this.convertOtherAgentsToWorkers(team);
                }
            }

            this.agentFormContainer.innerHTML = this.createAgentFormHTML(agentData);
        }
    }

    /**
     * Convert all other agents in the team to workers when a manager is selected
     */
    async convertOtherAgentsToWorkers(team) {
        const updatePromises = [];

        for (const agent of team.agents) {
            if (agent.id !== this.editingAgentId && agent.agent_type !== 'worker') {
                agent.agent_type = 'worker';

                // Update via API if it's a backend agent
                if (typeof agent.id === 'number' || !String(agent.id).startsWith('agent-')) {
                    updatePromises.push(
                        this.updateAgentAPI(agent.id, agent, this.selectedTeamId)
                            .catch(err => console.error('[AgentTeams] Failed to update agent to worker:', err))
                    );
                }
            }
        }

        // Wait for all API updates
        if (updatePromises.length > 0) {
            await Promise.all(updatePromises);
        }

        this.saveToStorage();
        this.renderTree();
        this.renderAgentsList();
    }

    async saveAgent() {
        const agentData = this.collectAgentFormData();

        if (!agentData.name?.trim()) {
            alert(this.t('agentTeams.fields.name') + ' is required');
            return;
        }
        if (!agentData.agent_type) {
            alert('Please select an agent type');
            return;
        }

        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (!team) return;

        // Add delegation tools for managers
        if (agentData.agent_type === 'manager') {
            this.delegationTools.forEach(tool => {
                if (!agentData.tools.includes(tool.name)) {
                    agentData.tools.push(tool.name);
                }
            });
        }

        const isNew = String(this.editingAgentId).startsWith('new-agent-');

        try {
            if (isNew) {
                // Create via API
                const savedAgent = await this.createAgentAPI(agentData, this.selectedTeamId);
                if (!team.agents) team.agents = [];
                team.agents.push(savedAgent);
            } else {
                // Update via API
                const savedAgent = await this.updateAgentAPI(this.editingAgentId, agentData, this.selectedTeamId);
                const index = team.agents.findIndex(a => a.id === this.editingAgentId);
                if (index !== -1) {
                    team.agents[index] = savedAgent;
                }
            }

            this.saveToStorage();
            this.renderTree();
            this.hideAgentForm();
            this.renderAgentsList();
        } catch (error) {
            alert('Failed to save agent: ' + error.message);
        }
    }

    hideAgentForm() {
        if (this.agentFormContainer) {
            this.agentFormContainer.classList.add('hidden');
            this.agentFormContainer.innerHTML = '';
        }
        // Show the agents list again
        if (this.teamAgentsList) {
            this.teamAgentsList.classList.remove('hidden');
        }
        this.editingAgentId = null;
    }

    collectAgentFormData() {
        const form = this.agentFormContainer;
        if (!form) return {};

        const tools = [];
        form.querySelectorAll('.tool-checkbox:checked:not(:disabled)').forEach(cb => {
            tools.push(cb.dataset.tool);
        });

        return {
            id: this.editingAgentId,
            name: form.querySelector('.agent-name-input')?.value || '',
            description: form.querySelector('.agent-description-input')?.value || '',
            agent_type: form.querySelector('.agent-type-select')?.value || '',
            provider: form.querySelector('.agent-provider-select')?.value || 'claude',
            model: form.querySelector('.agent-model-input')?.value || '',
            instructions: form.querySelector('.agent-instructions-input')?.value || '',
            tools: tools,
            settings: {
                temperature: parseFloat(form.querySelector('.agent-temperature-input')?.value || 0.7),
                max_tokens: parseInt(form.querySelector('.agent-max-tokens-input')?.value || 4096)
            }
        };
    }

    // ==========================================
    // ACTIONS
    // ==========================================

    async deleteTeam(teamId) {
        if (!confirm('Are you sure you want to delete this team and all its agents?')) {
            return;
        }

        // Convert to number if numeric string
        const tId = !isNaN(teamId) ? parseInt(teamId, 10) : teamId;

        try {
            // Delete via API (only for backend-created teams with numeric IDs)
            if (typeof tId === 'number' || !String(tId).startsWith('team-')) {
                await this.deleteTeamAPI(tId);
            }

            const index = this.teams.findIndex(t => t.id === tId);
            if (index !== -1) {
                this.teams.splice(index, 1);
            }

            if (this.selectedTeamId === tId) {
                this.selectedTeamId = null;
                if (this.editor) this.editor.classList.add('hidden');
                if (this.placeholder) this.placeholder.classList.remove('hidden');
            }

            this.saveToStorage();
            this.renderTree();
        } catch (error) {
            alert('Failed to delete team: ' + error.message);
        }
    }

    async deleteAgent(teamId, agentId) {
        if (!confirm(this.t('agentTeams.actions.confirmDelete'))) {
            return;
        }

        // Convert IDs to numbers if numeric strings
        const tId = !isNaN(teamId) ? parseInt(teamId, 10) : teamId;
        const aId = !isNaN(agentId) ? parseInt(agentId, 10) : agentId;

        try {
            // Delete via API (only for backend-created agents with numeric IDs)
            if (typeof aId === 'number' || !String(aId).startsWith('agent-')) {
                await this.deleteAgentAPI(aId);
            }

            const team = this.teams.find(t => t.id === tId);
            if (!team) return;

            const index = team.agents?.findIndex(a => a.id === aId);
            if (index !== undefined && index !== -1) {
                team.agents.splice(index, 1);
            }

            this.saveToStorage();
            this.renderTree();

            if (this.editingAgentId === aId) {
                this.hideAgentForm();
            }

            this.renderAgentsList();
        } catch (error) {
            alert('Failed to delete agent: ' + error.message);
        }
    }

    runAgent(teamId, agentId) {
        // Convert IDs to numbers if numeric strings
        const tId = !isNaN(teamId) ? parseInt(teamId, 10) : teamId;
        const aId = !isNaN(agentId) ? parseInt(agentId, 10) : agentId;

        const team = this.teams.find(t => t.id === tId);
        const agent = team?.agents?.find(a => a.id === aId);
        if (agent) {
            alert(`Running agent: ${agent.name}\n\nTeam: ${team.name}\n\nThis will be connected to the backend API.`);
        }
    }

    // ==========================================
    // AGENT ACTIVITY TRACKING
    // ==========================================

    /**
     * Handle agent activity events from SSE stream
     */
    handleAgentActivityEvent(event) {
        // Debug: log all agent activity events
        console.log('[AgentActivity]', event.type, event);

        switch (event.type) {
            case 'agent_start':
                this.onAgentStart(event);
                break;
            case 'agent_delegate':
                this.onAgentDelegate(event);
                break;
            case 'agent_complete':
                this.onAgentComplete(event);
                break;
            case 'agent_thinking':
                this.onAgentThinking(event);
                break;
        }
    }

    /**
     * Called when an agent starts processing
     */
    onAgentStart(event) {
        const { agent_id, agent_name, agent_type } = event;

        this.activeAgents.set(agent_id, {
            status: 'processing',
            name: agent_name,
            type: agent_type,
            startTime: Date.now()
        });

        this.updateAgentVisualState(agent_id, 'processing');
        this.updateActivityLog(`${agent_name} processing...`);

        // Start elapsed time display for this agent
        this.startElapsedTimeDisplay(agent_id, agent_name);
    }

    /**
     * Start showing elapsed time for an agent
     */
    startElapsedTimeDisplay(agentId, agentName) {
        // Find the agent card and add elapsed time element
        const cards = [
            this.teamsTree?.querySelector(`[data-agent-id="${agentId}"]`),
            this.teamAgentsList?.querySelector(`[data-agent-id="${agentId}"]`)
        ].filter(Boolean);

        cards.forEach(card => {
            // Add or update elapsed time display
            let timeEl = card.querySelector('.agent-elapsed-time');
            if (!timeEl) {
                timeEl = document.createElement('span');
                timeEl.className = 'agent-elapsed-time text-xs text-blue-600 font-mono ml-2';
                const nameEl = card.querySelector('.agent-name, .font-medium');
                if (nameEl) {
                    nameEl.parentElement.appendChild(timeEl);
                }
            }
            timeEl.textContent = '0s';
        });

        // Update timer every second
        const timerId = setInterval(() => {
            const agent = this.activeAgents.get(agentId);
            if (!agent || agent.status !== 'processing') {
                clearInterval(timerId);
                // Remove elapsed time display
                cards.forEach(card => {
                    const timeEl = card.querySelector('.agent-elapsed-time');
                    if (timeEl) timeEl.remove();
                });
                return;
            }

            // Include accumulated time from previous processing segments
            const currentSegment = Date.now() - agent.startTime;
            const totalMs = (agent.accumulatedTime || 0) + currentSegment;
            const elapsed = Math.round(totalMs / 1000);
            cards.forEach(card => {
                const timeEl = card.querySelector('.agent-elapsed-time');
                if (timeEl) {
                    timeEl.textContent = elapsed >= 60
                        ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
                        : `${elapsed}s`;
                }
            });
        }, 1000);

        // Store timer ID for cleanup
        if (!this.elapsedTimers) this.elapsedTimers = new Map();
        this.elapsedTimers.set(agentId, timerId);
    }

    /**
     * Called when a manager delegates to a worker
     */
    onAgentDelegate(event) {
        const { from_agent_id, from_agent_name, to_agent_id, to_agent_name, task } = event;

        // Manager is now waiting - pause its timer and accumulate time
        if (this.activeAgents.has(from_agent_id)) {
            const manager = this.activeAgents.get(from_agent_id);
            // Accumulate time spent so far
            const timeSpent = Date.now() - manager.startTime;
            manager.accumulatedTime = (manager.accumulatedTime || 0) + timeSpent;
            manager.status = 'waiting';

            // Stop the timer
            if (this.elapsedTimers?.has(from_agent_id)) {
                clearInterval(this.elapsedTimers.get(from_agent_id));
                this.elapsedTimers.delete(from_agent_id);
            }
        }

        // Track the delegation
        this.delegationChain.push({
            from: from_agent_id,
            fromName: from_agent_name,
            to: to_agent_id,
            toName: to_agent_name,
            task: task
        });

        // Remove highlight from manager (it's now idle/waiting)
        this.updateAgentVisualState(from_agent_id, 'idle');
        this.updateActivityLog(`${from_agent_name} → ${to_agent_name}`);
    }

    /**
     * Called when an agent completes (success or error)
     */
    onAgentComplete(event) {
        const { agent_id, agent_name, success, error } = event;

        // Calculate total elapsed time for this agent (including accumulated time from delegation pauses)
        const agent = this.activeAgents.get(agent_id);
        let totalMs = 0;
        if (agent) {
            const currentSegment = Date.now() - agent.startTime;
            totalMs = (agent.accumulatedTime || 0) + currentSegment;
        }
        const elapsed = Math.round(totalMs / 1000);
        const elapsedStr = elapsed >= 60
            ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
            : `${elapsed}s`;

        const status = success ? 'completed' : 'error';

        if (this.activeAgents.has(agent_id)) {
            this.activeAgents.get(agent_id).status = status;
        }

        // Stop elapsed time timer
        if (this.elapsedTimers?.has(agent_id)) {
            clearInterval(this.elapsedTimers.get(agent_id));
            this.elapsedTimers.delete(agent_id);
        }

        this.updateAgentVisualState(agent_id, status);

        if (success) {
            this.updateActivityLog(`${agent_name} ✓ (${elapsedStr})`);
        } else {
            this.updateActivityLog(`${agent_name} failed: ${error}`, 'error');
        }

        // Check if this was a delegated worker - if so, re-activate the parent manager
        const delegation = this.delegationChain.find(d => d.to === agent_id);
        if (delegation) {
            // Worker completed, manager resumes processing
            const managerId = delegation.from;
            const manager = this.activeAgents.get(managerId);
            if (manager && manager.status === 'waiting') {
                manager.status = 'processing';
                manager.startTime = Date.now(); // Reset start time for new processing segment
                this.updateAgentVisualState(managerId, 'processing');
                // Restart timer for manager (will add to accumulated time)
                this.startElapsedTimeDisplay(managerId, manager.name);
            }
            // Remove this delegation from the chain
            this.delegationChain = this.delegationChain.filter(d => d.to !== agent_id);
        }

        // Clear the completed agent's status after a brief flash
        setTimeout(() => {
            this.updateAgentVisualState(agent_id, 'idle');
            this.activeAgents.delete(agent_id);
        }, 1500);
    }

    /**
     * Called for thinking/progress updates
     */
    onAgentThinking(event) {
        const { agent_id, agent_name, status } = event;
        this.updateActivityLog(`${agent_name}: ${status}`);
    }

    /**
     * Update the visual state of an agent card
     */
    updateAgentVisualState(agentId, status) {
        // Find agent cards in both tree and list views
        const treeCard = this.teamsTree?.querySelector(`[data-agent-id="${agentId}"]`);
        const listCard = this.teamAgentsList?.querySelector(`[data-agent-id="${agentId}"]`);

        const cards = [treeCard, listCard].filter(Boolean);

        cards.forEach(card => {
            // Remove all state classes
            card.classList.remove(
                'agent-processing',
                'agent-delegating',
                'agent-completed',
                'agent-error',
                'agent-idle'
            );

            // Add the new state class
            if (status !== 'idle') {
                card.classList.add(`agent-${status}`);
            }
        });
    }

    /**
     * Show visual connection between delegating agents (placeholder for future SVG implementation)
     */
    showDelegationConnection(fromAgentId, toAgentId) {
        // Could draw SVG arrow from manager to worker in the future
        // For now, the activity log shows the delegation flow
    }

    /**
     * Update the activity log in the UI
     */
    updateActivityLog(message, type = 'info') {
        const logContainer = document.getElementById('agent-activity-log');
        if (!logContainer) return;

        const timestamp = new Date().toLocaleTimeString();
        const colorClass = type === 'error' ? 'text-red-600' : 'text-gray-600';

        const entry = document.createElement('div');
        entry.className = `text-xs ${colorClass} py-1 border-b border-gray-100 animate-fade-in`;
        entry.innerHTML = `<span class="text-gray-400">${timestamp}</span> ${message}`;

        logContainer.insertBefore(entry, logContainer.firstChild);

        // Keep only last 20 entries
        while (logContainer.children.length > 20) {
            logContainer.removeChild(logContainer.lastChild);
        }
    }

    /**
     * Reset all agent activity states
     */
    resetAgentActivityStates() {
        this.activeAgents.clear();
        this.delegationChain = [];

        // Clear all elapsed timers
        if (this.elapsedTimers) {
            this.elapsedTimers.forEach((timerId) => {
                clearInterval(timerId);
            });
            this.elapsedTimers.clear();
        }

        // Reset accumulated time on all agents
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (team?.agents) {
            team.agents.forEach(agent => {
                agent.accumulatedTime = 0;
                agent.startTime = null;
            });
        }

        // Remove all activity classes and elapsed time displays from cards
        document.querySelectorAll('[data-agent-id]').forEach(card => {
            card.classList.remove(
                'agent-processing',
                'agent-delegating',
                'agent-completed',
                'agent-error'
            );
            // Remove elapsed time display
            const timeEl = card.querySelector('.agent-elapsed-time');
            if (timeEl) {
                timeEl.remove();
            }
        });

        // Clear activity log
        const logContainer = document.getElementById('agent-activity-log');
        if (logContainer) {
            logContainer.innerHTML = '';
        }
    }

    // ==========================================
    // RUN TEAM
    // ==========================================

    /**
     * Switch between Manual, Scheduled, and Settings tabs
     */
    switchTeamTab(tab) {
        const tabs = {
            manual: document.getElementById('run-tab-manual'),
            scheduled: document.getElementById('run-tab-scheduled'),
            settings: document.getElementById('run-tab-settings')
        };
        const contents = {
            manual: document.getElementById('run-content-manual'),
            scheduled: document.getElementById('run-content-scheduled'),
            settings: document.getElementById('run-content-settings')
        };

        // Reset all tabs
        Object.values(tabs).forEach(t => {
            t?.classList.remove('bg-green-600', 'bg-blue-600', 'text-white');
            t?.classList.add('bg-gray-100', 'text-gray-600');
        });

        // Hide all contents
        Object.values(contents).forEach(c => c?.classList.add('hidden'));

        // Activate selected tab
        const activeTab = tabs[tab];
        const activeContent = contents[tab];

        if (tab === 'settings') {
            activeTab?.classList.add('bg-blue-600', 'text-white');
            activeTab?.classList.remove('bg-gray-100', 'text-gray-600');
            // Populate settings form with current team data
            this.populateTeamSettings();
        } else {
            activeTab?.classList.add('bg-green-600', 'text-white');
            activeTab?.classList.remove('bg-gray-100', 'text-gray-600');
        }

        activeContent?.classList.remove('hidden');
    }

    /**
     * Populate settings form with current team data
     */
    populateTeamSettings() {
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (!team) return;

        const nameInput = document.getElementById('edit-team-name-input');
        const descInput = document.getElementById('edit-team-description-input');

        if (nameInput) nameInput.value = team.name || '';
        if (descInput) descInput.value = team.description || '';
    }

    /**
     * Save team settings
     */
    async saveTeamSettings() {
        const nameInput = document.getElementById('edit-team-name-input');
        const descInput = document.getElementById('edit-team-description-input');

        const name = nameInput?.value?.trim();
        const description = descInput?.value?.trim();

        if (!name) {
            alert(this.t('agentTeams.teamNameRequired') || 'Team name is required');
            return;
        }

        try {
            await this.updateTeamAPI(this.selectedTeamId, name, description);

            // Update local state
            const team = this.teams.find(t => t.id === this.selectedTeamId);
            if (team) {
                team.name = name;
                team.description = description;
            }

            // Update UI
            const teamNameEl = document.getElementById('editor-team-name');
            const teamDescEl = document.getElementById('editor-team-description');
            if (teamNameEl) teamNameEl.textContent = name;
            if (teamDescEl) teamDescEl.textContent = description || '';

            // Update tree view
            this.renderTree();

            // Switch back to manual tab
            this.switchTeamTab('manual');
        } catch (error) {
            alert('Failed to save team: ' + error.message);
        }
    }

    /**
     * Delete team from settings tab
     */
    async deleteTeamFromSettings() {
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        if (!team) return;

        if (!confirm(this.t('agentTeams.confirmDeleteTeam') || `Are you sure you want to delete "${team.name}"? This will also delete all agents in the team.`)) {
            return;
        }

        try {
            await this.deleteTeamAPI(this.selectedTeamId);

            // Remove from local state
            this.teams = this.teams.filter(t => t.id !== this.selectedTeamId);
            this.selectedTeamId = null;

            // Update UI
            this.renderTree();

            // Show placeholder
            if (this.editor) this.editor.classList.add('hidden');
            if (this.placeholder) this.placeholder.classList.remove('hidden');
        } catch (error) {
            alert('Failed to delete team: ' + error.message);
        }
    }

    /**
     * Run the team with the provided prompt (using SSE for real-time updates)
     */
    async runTeam() {
        const promptInput = document.getElementById('team-prompt-input');
        const runBtn = document.getElementById('run-team-btn');
        const prompt = promptInput?.value?.trim();

        if (!prompt) {
            alert('Please enter a task for the team to execute.');
            return;
        }

        if (!this.selectedTeamId) {
            alert('No team selected.');
            return;
        }

        // Find the manager agent for this team
        const team = this.teams.find(t => t.id === this.selectedTeamId);
        const manager = team?.agents?.find(a => a.agent_type === 'manager');

        if (!manager) {
            alert('This team needs a manager agent to run. Please add a manager agent first.');
            return;
        }

        // Reset activity states and clear previous response
        this.resetAgentActivityStates();
        this.clearStoredResponse();

        // Show loading state with cancel button
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = '<span class="animate-spin">⏳</span> Running...';

            // Add cancel button if not already present
            let cancelBtn = document.getElementById('cancel-team-btn');
            if (!cancelBtn) {
                cancelBtn = document.createElement('button');
                cancelBtn.id = 'cancel-team-btn';
                cancelBtn.className = 'ml-2 px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition';
                cancelBtn.textContent = 'Cancel';
                cancelBtn.onclick = () => this.cancelRunTeam();
                runBtn.parentElement.appendChild(cancelBtn);
            }
            cancelBtn.classList.remove('hidden');
        }

        // Show activity log panel
        this.showActivityPanel();

        // Track processing time
        const startTime = Date.now();

        // Create abort controller for timeout
        const abortController = new AbortController();
        const TIMEOUT_MS = 5 * 60 * 1000; // 5 minute timeout
        const timeoutId = setTimeout(() => {
            abortController.abort();
            this.updateActivityLog('Request timed out after 5 minutes', 'error');
        }, TIMEOUT_MS);

        // Store abort controller so it can be cancelled manually
        this.currentRunAbortController = abortController;

        try {
            // Use SSE endpoint for real-time updates
            const response = await fetch(`/gpt/backend/api/v1/agents/${manager.id}/chat`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    input: prompt,
                    conversation_history: []
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }

            // Process SSE stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let buffer = '';
            let lastActivityTime = Date.now();
            const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minute idle timeout

            while (true) {
                // Check for idle timeout (no data received)
                const idleCheck = new Promise((_, reject) => {
                    setTimeout(() => {
                        if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS) {
                            reject(new Error('Connection idle timeout - no data received for 3 minutes'));
                        }
                    }, 10000); // Check every 10 seconds
                });

                const readPromise = reader.read();

                // Race between read and idle timeout check
                let result;
                try {
                    result = await Promise.race([readPromise, idleCheck]);
                } catch (idleError) {
                    reader.cancel();
                    throw idleError;
                }

                const { done, value } = result;
                if (done) break;

                lastActivityTime = Date.now();
                buffer += decoder.decode(value, { stream: true });

                // Process complete SSE messages
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);

                        if (data === '[DONE]') {
                            continue;
                        }

                        try {
                            const event = JSON.parse(data);
                            this.handleSSEEvent(event, fullContent);

                            // Accumulate text chunks
                            if (event.type === 'chunk' && event.text) {
                                fullContent += event.text;
                            }
                        } catch (e) {
                            console.warn('[AgentTeams] Failed to parse SSE event:', data);
                        }
                    }
                }
            }

            // Show final response
            if (fullContent) {
                const elapsedTime = Date.now() - startTime;
                this.lastResponse = fullContent;
                this.lastResponseTime = elapsedTime;
                this.showResponseOverlay(fullContent, elapsedTime);
                this.showViewResponseButton(true);
                // Clear prompt input
                if (promptInput) promptInput.value = '';
            } else {
                this.updateActivityLog('No response received from agents', 'error');
            }

        } catch (error) {
            console.error('[AgentTeams] Error running team:', error);
            const errorMsg = error.name === 'AbortError' ? 'Request was cancelled or timed out' : error.message;
            this.updateActivityLog(`Error: ${errorMsg}`, 'error');
            if (error.name !== 'AbortError') {
                alert('Failed to run team: ' + error.message);
            }
        } finally {
            clearTimeout(timeoutId);
            this.currentRunAbortController = null;
            if (runBtn) {
                runBtn.disabled = false;
                runBtn.innerHTML = '<span>▶</span> <span>Run Now</span>';
            }
            // Hide cancel button
            const cancelBtn = document.getElementById('cancel-team-btn');
            if (cancelBtn) {
                cancelBtn.classList.add('hidden');
            }
            // Reset processing states on completion/error
            this.resetAgentActivityStates();
        }
    }

    /**
     * Cancel the current running team execution
     */
    cancelRunTeam() {
        if (this.currentRunAbortController) {
            this.currentRunAbortController.abort();
            this.updateActivityLog('Execution cancelled by user', 'error');
        }
    }

    /**
     * Handle SSE events during team execution
     */
    handleSSEEvent(event) {
        // Debug: log all SSE events
        console.log('[SSE Event]', event.type, event);

        // Handle agent activity events
        if (['agent_start', 'agent_delegate', 'agent_complete', 'agent_thinking'].includes(event.type)) {
            this.handleAgentActivityEvent(event);
            return;
        }

        // Handle other event types
        switch (event.type) {
            case 'chunk':
                // Text chunk - handled in main loop
                break;
            case 'error':
                this.updateActivityLog(`Error: ${event.error}`, 'error');
                break;
            case 'tool_call':
                if (event.name) {
                    this.updateActivityLog(`Tool called: ${event.name}`);
                }
                break;
            case 'tool_result':
                // Tool result received
                break;
        }
    }

    /**
     * Show the activity panel during execution
     */
    showActivityPanel() {
        let panel = document.getElementById('agent-activity-panel');

        if (!panel) {
            // Create activity panel if it doesn't exist
            panel = document.createElement('div');
            panel.id = 'agent-activity-panel';
            panel.className = 'mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200';
            panel.innerHTML = `
                <div class="flex items-center justify-between mb-2">
                    <h4 class="text-sm font-medium text-gray-700">Activity Log</h4>
                    <button id="clear-activity-log" class="text-xs text-gray-500 hover:text-gray-700">Clear</button>
                </div>
                <div id="agent-activity-log" class="max-h-32 overflow-y-auto"></div>
            `;

            // Insert after the prompt input
            const manualContent = document.getElementById('run-content-manual');
            if (manualContent) {
                manualContent.appendChild(panel);

                // Add clear button handler
                document.getElementById('clear-activity-log')?.addEventListener('click', () => {
                    const log = document.getElementById('agent-activity-log');
                    if (log) log.innerHTML = '';
                });
            }
        }

        panel.classList.remove('hidden');
    }

    /**
     * Show the response overlay with rendered markdown
     */
    showResponseOverlay(markdown, elapsedTimeMs = null) {
        const overlay = document.getElementById('team-response-overlay');
        const contentEl = document.getElementById('team-response-content');
        const rawEl = document.getElementById('team-response-raw');
        const toggleBtn = document.getElementById('team-toggle-raw-btn');
        const timeEl = document.getElementById('team-response-time');

        if (!overlay || !contentEl || !rawEl) return;

        const html = window.renderMarkdown(markdown);

        // Wrap in markdown-content class for proper styling (same as chat)
        contentEl.innerHTML = `<div class="markdown-content">${html}</div>`;
        rawEl.textContent = markdown;

        // Apply syntax highlighting to code blocks (same as chat)
        if (typeof hljs !== 'undefined') {
            contentEl.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }

        // Fix SVG viewBoxes (same as chat)
        if (window.chatApp?.fixAllSVGsInContainer) {
            window.chatApp.fixAllSVGsInContainer(contentEl);
        }

        // Show processing time if available
        if (timeEl && elapsedTimeMs) {
            const seconds = Math.round(elapsedTimeMs / 1000);
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            if (minutes > 0) {
                timeEl.textContent = `${minutes}m ${remainingSeconds}s`;
            } else {
                timeEl.textContent = `${seconds}s`;
            }
        } else if (timeEl) {
            timeEl.textContent = '';
        }

        // Reset to rendered view
        contentEl.classList.remove('hidden');
        rawEl.classList.add('hidden');
        if (toggleBtn) {
            toggleBtn.textContent = 'Raw';
            toggleBtn.classList.remove('bg-gray-200');
        }

        // Show overlay
        overlay.classList.remove('hidden');
    }

    /**
     * Hide the response overlay
     */
    hideResponseOverlay() {
        const overlay = document.getElementById('team-response-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
    }

    /**
     * View the stored response (re-display after closing)
     */
    viewStoredResponse() {
        if (this.lastResponse) {
            this.showResponseOverlay(this.lastResponse, this.lastResponseTime);
        }
    }

    /**
     * Show or hide the "View Response" button
     */
    showViewResponseButton(show) {
        const btn = document.getElementById('view-response-btn');
        if (btn) {
            if (show) {
                btn.classList.remove('hidden');
            } else {
                btn.classList.add('hidden');
            }
        }
    }

    /**
     * Clear the stored response (called when starting a new process)
     */
    clearStoredResponse() {
        this.lastResponse = null;
        this.lastResponseTime = null;
        this.showViewResponseButton(false);
    }

    /**
     * Toggle between rendered HTML and raw markdown
     */
    toggleRawResponse() {
        const contentEl = document.getElementById('team-response-content');
        const rawEl = document.getElementById('team-response-raw');
        const toggleBtn = document.getElementById('team-toggle-raw-btn');

        if (!contentEl || !rawEl) return;

        const isShowingRaw = !rawEl.classList.contains('hidden');

        if (isShowingRaw) {
            // Switch to rendered
            rawEl.classList.add('hidden');
            contentEl.classList.remove('hidden');
            if (toggleBtn) {
                toggleBtn.textContent = 'Raw';
                toggleBtn.classList.remove('bg-gray-200');
            }
        } else {
            // Switch to raw
            contentEl.classList.add('hidden');
            rawEl.classList.remove('hidden');
            if (toggleBtn) {
                toggleBtn.textContent = 'Rendered';
                toggleBtn.classList.add('bg-gray-200');
            }
        }
    }

    /**
     * Print the response
     */
    printResponse() {
        const contentEl = document.getElementById('team-response-content');
        if (!contentEl) return;

        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('Please allow popups to print the response.');
            return;
        }

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Team Response</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        max-width: 800px;
                        margin: 40px auto;
                        padding: 20px;
                        line-height: 1.6;
                    }
                    pre, code {
                        background: #f4f4f4;
                        padding: 2px 6px;
                        border-radius: 4px;
                        font-size: 14px;
                    }
                    pre {
                        padding: 16px;
                        overflow-x: auto;
                    }
                    h1, h2, h3 { margin-top: 24px; }
                    ul, ol { padding-left: 24px; }
                </style>
            </head>
            <body>
                ${contentEl.innerHTML}
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.print();
    }

    // ==========================================
    // UTILITIES
    // ==========================================

    getTypeIcon(type) {
        switch (type) {
            case 'standard': return '🤖';
            case 'manager': return '👔';
            case 'worker': return '⚙️';
            default: return '📄';
        }
    }

    saveToStorage() {
        try {
            localStorage.setItem('agent-teams', JSON.stringify(this.teams));
        } catch (e) {
            console.error('Failed to save teams:', e);
        }
    }

    loadFromStorage() {
        try {
            const stored = localStorage.getItem('agent-teams');
            if (stored) {
                const data = JSON.parse(stored);
                if (Array.isArray(data) && data.length > 0) {
                    if (data[0].agents !== undefined) {
                        this.teams = data;
                    } else {
                        // Migrate old format
                        this.teams = [{
                            id: 'team-migrated',
                            name: 'Default Team',
                            description: 'Migrated from previous agents',
                            agents: data,
                            expanded: true
                        }];
                    }
                }
            }
        } catch (e) {
            console.error('Failed to load teams:', e);
            this.teams = [];
        }
    }

    /**
     * Show the content panel (called from chat.js when switching to agent-teams view)
     */
    show() {
        this.isActive = true;

        // Hide chat panes
        if (this.primaryPane) this.primaryPane.classList.add('hidden');
        if (this.verifierPane) this.verifierPane.classList.add('hidden');
        if (this.comparePane) this.comparePane.classList.add('hidden');
        if (this.splitDivider) this.splitDivider.classList.add('hidden');

        // Hide chat-specific UI elements
        const providerBar = document.getElementById('provider-bar');
        const infoBar = document.getElementById('info-bar');
        const inputArea = document.getElementById('input-area');
        const progressBar = document.getElementById('progress-bar');

        const messagesWrapper = document.getElementById('messages-wrapper');

        if (providerBar) providerBar.classList.add('hidden');
        if (infoBar) infoBar.classList.add('hidden');
        if (inputArea) inputArea.classList.add('hidden');
        if (progressBar) progressBar.classList.add('hidden');
        if (messagesWrapper) messagesWrapper.classList.add('hidden');

        // Show agent teams content panel
        if (this.contentPanel) {
            this.contentPanel.classList.remove('hidden');
        }

        // Initialize WorkflowEditor if not already done
        if (window.WorkflowEditor && !window.workflowEditor) {
            console.log('[AgentTeamsPanel] Initializing WorkflowEditor...');
            window.workflowEditor = new WorkflowEditor('workflow-canvas', 'workflow-agents-panel');
            window.workflowEditor.init();

            // Set up "New Workflow" button in sidebar
            const newWorkflowBtn = document.getElementById('new-workflow-btn');
            if (newWorkflowBtn) {
                newWorkflowBtn.addEventListener('click', () => {
                    if (window.workflowEditor) {
                        window.workflowEditor.clearWorkflow();
                    }
                });
            }
        } else if (window.workflowEditor) {
            // Refresh agents panel if editor already exists
            console.log('[AgentTeamsPanel] WorkflowEditor already initialized');
        }

        // Refresh translations
        if (window.i18n && window.i18n.updateAllTranslations) {
            window.i18n.updateAllTranslations();
        }
    }

    /**
     * Hide the content panel (called from chat.js when switching away from agent-teams view)
     */
    hide() {
        this.isActive = false;

        // Show chat panes
        if (this.primaryPane) this.primaryPane.classList.remove('hidden');

        // Show chat-specific UI elements
        const providerBar = document.getElementById('provider-bar');
        const infoBar = document.getElementById('info-bar');
        const inputArea = document.getElementById('input-area');

        const messagesWrapper = document.getElementById('messages-wrapper');

        if (providerBar) providerBar.classList.remove('hidden');
        if (infoBar) infoBar.classList.remove('hidden');
        if (inputArea) inputArea.classList.remove('hidden');
        if (messagesWrapper) messagesWrapper.classList.remove('hidden');

        // Hide agent teams content panel
        if (this.contentPanel) {
            this.contentPanel.classList.add('hidden');
        }
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.agentTeamsPanel = new AgentTeamsPanel();
});
