/**
 * Settings Panel - UI Component for LLM Usage Statistics and API Key Management
 *
 * This class manages the settings panel UI including:
 * - Panel visibility toggle (replaces chat view when active)
 * - LLM usage statistics display (monthly costs, tokens, requests)
 * - Custom API key management (save/load user-specific keys)
 * - Integration with AuthManager for user context
 */

class SettingsPanel {
    constructor() {
        // API endpoint
        this.apiBaseUrl = '/gpt/backend/api/v1';

        // DOM Elements
        this.panel = document.getElementById('settings-panel');
        this.toggleBtn = document.getElementById('settings-toggle-btn');
        this.primaryPane = document.getElementById('primary-pane');
        this.verifierPane = document.getElementById('verifier-pane');
        this.splitDivider = document.getElementById('split-pane-divider');

        // Usage elements
        this.usageGrid = document.getElementById('usage-grid');
        this.totalCostEl = document.getElementById('settings-total-cost');
        this.monthLabelEl = document.getElementById('settings-month-label');
        this.refreshBtn = document.getElementById('settings-refresh');

        // API key elements
        this.saveKeysBtn = document.getElementById('settings-save-keys');
        this.clearKeysBtn = document.getElementById('settings-clear-keys');

        // Tab elements
        this.tabs = document.querySelectorAll('.settings-tab');
        this.tabContents = document.querySelectorAll('.settings-tab-content');

        // MCP elements
        this.mcpServerList = document.getElementById('mcp-server-list');
        this.mcpToolsList = document.getElementById('mcp-tools-list');
        this.mcpToolCount = document.getElementById('mcp-tool-count');
        this.mcpAddBtn = document.getElementById('mcp-add-server-btn');
        this.mcpAddForm = document.getElementById('mcp-add-server-form');
        this.mcpRefreshBtn = document.getElementById('mcp-refresh');

        // Provider list
        this.providers = ['claude', 'openai', 'kimi', 'gemini', 'grok', 'deepseek'];

        // Pricing per 1M tokens (USD). Populated from the shared catalog fetch
        // below; each provider's entry mirrors the first model in its catalog
        // so cost readouts have a sensible fallback before/while the fetch
        // completes.
        this.pricing = {};

        // Model catalog per provider: id, label, description, input/output
        // cost per 1M tokens. Populated from /api/v1/models/catalog on init —
        // single source of truth shared with gpt_admin.
        this.modelCatalog = {};

        // User-selected models (loaded from backend)
        this.userModels = {};

        // Exchange rates (base: USD) - March 2026
        // Sources: Bank of Canada, X-Rates
        this.exchangeRates = {
            'USD': { rate: 1.0, symbol: '$', name: 'USD' },
            'EUR': { rate: 0.862, symbol: '€', name: 'EUR' },  // 1 USD = 0.862 EUR
            'CAD': { rate: 1.36, symbol: 'C$', name: 'CAD' }   // 1 USD = 1.36 CAD
        };

        // Current selected currency (default: USD)
        this.selectedCurrency = localStorage.getItem('settings-currency') || 'USD';

        // State
        this.isActive = false;
        this.usageData = null;
        this.userKeys = {};
        this.activeTab = 'usage';
        this.editingServerId = null;

        // Initialize
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupTabListeners();
        this.setupMCPListeners();
        this.setupAccountListeners();
        this.setupI18n();
        // Fetch shared model catalog first; populate dropdowns once it lands.
        // If the fetch fails (offline, backend down), the dropdowns stay empty
        // but the rest of Settings continues to work.
        this.loadModelCatalog().then(() => this.populateModelSelectors());

        // Phone auth state
        this.phoneConfirmationResult = null;
        this.recaptchaVerifier = null;
    }

    /**
     * Fetch the canonical model catalog shared with gpt_admin.
     * Writes to this.modelCatalog and derives this.pricing from the first
     * entry of each provider's list.
     */
    async loadModelCatalog() {
        try {
            const res = await fetch('/gpt/backend/api/v1/models/catalog');
            const body = await res.json();
            if (!body.success || !body.providers) {
                console.warn('[SettingsPanel] Model catalog fetch returned error:', body.error);
                return;
            }
            this.modelCatalog = body.providers;
            // Derive per-provider pricing defaults from the first model so
            // cost readouts have numbers to show before the user picks a model.
            for (const provider of this.providers) {
                const first = this.modelCatalog[provider]?.[0];
                if (first) {
                    this.pricing[provider] = {
                        input: first.input,
                        output: first.output,
                        model: first.label,
                    };
                }
            }
        } catch (err) {
            console.warn('[SettingsPanel] Failed to fetch model catalog:', err);
        }
    }

    // i18n helper method
    t(key) {
        if (window.i18n && typeof window.i18n.t === 'function') {
            return window.i18n.t(key);
        }
        return key.split('.').pop();
    }

    setupI18n() {
        if (window.i18n && typeof window.i18n.onLanguageChange === 'function') {
            window.i18n.onLanguageChange(() => this.onLanguageChanged());
        }
    }

    onLanguageChanged() {
        if (this.isActive && this.usageData) {
            this.renderUsageStats(this.usageData);
        }
    }

    /**
     * Convert USD amount to selected currency
     */
    convertCurrency(amountUsd) {
        const rate = this.exchangeRates[this.selectedCurrency]?.rate || 1;
        return amountUsd * rate;
    }

    /**
     * Format currency amount with symbol
     */
    formatCurrency(amountUsd, decimals = 4) {
        const converted = this.convertCurrency(amountUsd);
        const currency = this.exchangeRates[this.selectedCurrency];
        return `${currency.symbol}${converted.toFixed(decimals)} ${currency.name}`;
    }

    /**
     * Set selected currency and re-render
     */
    setCurrency(currencyCode) {
        if (this.exchangeRates[currencyCode]) {
            this.selectedCurrency = currencyCode;
            localStorage.setItem('settings-currency', currencyCode);
            if (this.usageData) {
                this.renderUsageStats(this.usageData);
            }
        }
    }

    /**
     * Create currency selector dropdown HTML
     */
    createCurrencySelector() {
        return `
            <div class="currency-selector">
                <label for="currency-select">Currency:</label>
                <select id="currency-select" onchange="window.settingsPanel.setCurrency(this.value)">
                    ${Object.keys(this.exchangeRates).map(code => `
                        <option value="${code}" ${code === this.selectedCurrency ? 'selected' : ''}>
                            ${this.exchangeRates[code].symbol} ${code}
                        </option>
                    `).join('')}
                </select>
            </div>
        `;
    }

    setupEventListeners() {
        // Toggle button
        if (this.toggleBtn) {
            this.toggleBtn.addEventListener('click', () => this.toggle());
        }

        // Change-password form (Settings → Account, hidden for social-login users)
        const cpBtn = document.getElementById('change-password-btn');
        if (cpBtn) {
            cpBtn.addEventListener('click', () => this.changePassword());
        }

        // Save keys button
        if (this.saveKeysBtn) {
            this.saveKeysBtn.addEventListener('click', () => this.saveApiKeys());
        }

        // Clear keys button
        if (this.clearKeysBtn) {
            this.clearKeysBtn.addEventListener('click', () => this.clearApiKeys());
        }

        // Refresh button
        if (this.refreshBtn) {
            this.refreshBtn.addEventListener('click', () => this.loadUsageData());
        }

        // Memory tab: save + live char counters
        const memSave = document.getElementById('memory-save-btn');
        const memProject = document.getElementById('memory-project-input');
        const memUser = document.getElementById('memory-user-input');
        const memProjectCount = document.getElementById('memory-project-count');
        const memUserCount = document.getElementById('memory-user-count');

        if (memProject && memProjectCount) {
            memProject.addEventListener('input', () => {
                memProjectCount.textContent = memProject.value.length;
            });
        }
        if (memUser && memUserCount) {
            memUser.addEventListener('input', () => {
                memUserCount.textContent = memUser.value.length;
            });
        }
        if (memSave) {
            memSave.addEventListener('click', () => this.saveMemory());
        }

        // Auto-heal settings save
        const healSave = document.getElementById('heal-save-btn');
        if (healSave) {
            healSave.addEventListener('click', () => this.saveHealSettings());
        }
        const healScan = document.getElementById('heal-scan-btn');
        if (healScan) {
            healScan.addEventListener('click', () => window.healSystem && window.healSystem.scan());
        }

        // Memory auto-update: toggle + model dropdown
        const autoToggle = document.getElementById('memory-auto-toggle');
        const autoModel = document.getElementById('memory-auto-model');
        if (autoToggle) {
            autoToggle.addEventListener('change', () => this.saveAutoUpdate());
        }
        if (autoModel) {
            autoModel.addEventListener('change', () => this.saveAutoUpdate());
        }

        // Memory history: expand/collapse
        const histToggle = document.getElementById('memory-history-toggle');
        if (histToggle) {
            histToggle.addEventListener('click', () => this.toggleMemoryHistory());
        }
    }

    /**
     * Setup tab switching listeners
     */
    setupTabListeners() {
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                this.switchTab(tabName);
            });
        });
    }

    /**
     * Switch to a specific tab
     */
    switchTab(tabName) {
        this.activeTab = tabName;

        // Update tab buttons
        this.tabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Update tab contents
        this.tabContents.forEach(content => {
            content.classList.toggle('active', content.id === `settings-tab-${tabName}`);
        });

        // Load tab-specific data
        if (tabName === 'mcp') {
            this.loadMCPData();
        } else if (tabName === 'account') {
            this.loadAccountData();
        } else if (tabName === 'memory') {
            this.loadMemory();
        } else if (tabName === 'skills') {
            this.loadSkills();
        } else if (tabName === 'auto') {
            this.loadHealSettings();
        }
    }

    /** Load the auto-heal settings into the Auto tab controls. */
    async loadHealSettings() {
        try {
            const res = await fetch(`${this.apiBaseUrl}/settings/heal?t=${Date.now()}`, {
                headers: { 'Authorization': `Bearer ${this.getAuthToken()}` },
                cache: 'no-store'
            });
            if (!res.ok) return;
            const json = await res.json();
            const s = json.settings || {};
            const mode = s.heal_mode || 'off';
            document.querySelectorAll('input[name="heal-mode"]').forEach(r => { r.checked = (r.value === mode); });
            const set = (id, v) => { const el = document.getElementById(id); if (el != null && v != null) el.value = v; };
            set('heal-daily-budget', s.heal_daily_budget_usd);
            set('heal-per-heal-ceiling', s.heal_per_heal_ceiling_usd);
            set('heal-eval-provider', s.heal_eval_provider);
            set('heal-proposer-provider', s.heal_proposer_provider);
            set('heal-judge-provider', s.heal_judge_provider);
            set('heal-max-iterations', s.heal_max_iterations);
            set('heal-runs-per-query', s.heal_runs_per_query);
        } catch (e) {
            console.warn('[settings] loadHealSettings failed:', e);
        }
    }

    /** Save the auto-heal settings from the Auto tab controls. */
    async saveHealSettings() {
        const status = document.getElementById('heal-save-status');
        const num = (id, d) => { const v = parseFloat(document.getElementById(id)?.value); return Number.isFinite(v) ? v : d; };
        const mode = document.querySelector('input[name="heal-mode"]:checked')?.value || 'off';
        const body = {
            heal_mode: mode,
            heal_daily_budget_usd: num('heal-daily-budget', 5),
            heal_per_heal_ceiling_usd: num('heal-per-heal-ceiling', 1),
            heal_eval_provider: document.getElementById('heal-eval-provider')?.value || 'kimi',
            heal_proposer_provider: document.getElementById('heal-proposer-provider')?.value || 'claude',
            heal_judge_provider: document.getElementById('heal-judge-provider')?.value || 'kimi',
            heal_max_iterations: num('heal-max-iterations', 3),
            heal_runs_per_query: num('heal-runs-per-query', 3),
        };
        try {
            const res = await fetch(`${this.apiBaseUrl}/settings/heal`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.getAuthToken()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (status) {
                status.textContent = json.success
                    ? (window.i18n?.t('settings.auto.saved') || 'Saved')
                    : (window.i18n?.t('settings.auto.saveFailed') || 'Save failed');
                status.className = json.success ? 'text-sm text-green-600' : 'text-sm text-red-600';
                setTimeout(() => { if (status) status.textContent = ''; }, 3000);
            }
        } catch (e) {
            console.warn('[settings] saveHealSettings failed:', e);
            if (status) { status.textContent = 'Save failed'; status.className = 'text-sm text-red-600'; }
        }
    }

    /**
     * Render the per-skill on/off list for the Skills tab. Reads the
     * current local skill catalog from window.skillsManager and the
     * enabled/disabled state from skillsManager's localStorage helpers.
     * Listeners are delegated on the container so re-rendering doesn't
     * leak handlers.
     *
     * SkillsManager loads skills asynchronously on app init (FSA pick + disk
     * read), so the array is sometimes still empty when the user first
     * opens this tab. We force a fresh loadTree() and render afterward
     * to make the list always reflect what's actually on disk.
     */
    async loadSkills() {
        const list = document.getElementById('skills-list');
        if (!list) return;

        if (!window.skillsManager) {
            list.innerHTML = '<div class="text-sm text-gray-500 p-4">Skills manager not loaded.</div>';
            return;
        }

        // Show a spinner while we ensure skills are loaded.
        list.innerHTML = '<div class="text-sm text-gray-500 p-4">Loading skills…</div>';

        try {
            // Always re-scan the disk so newly-dropped skills show up
            // without a full app reload. Cheap (FS reads only) on the
            // typical handful-of-skills case.
            if (typeof window.skillsManager.loadTree === 'function') {
                await window.skillsManager.loadTree();
            }
        } catch (e) {
            console.warn('[settings:skills] loadTree failed:', e);
        }

        const skills = (window.skillsManager.skills || []).filter(s =>
            s?.source === 'local'
            && typeof s?.dir_name === 'string'
            && Array.isArray(s?.scripts)
            && s.scripts.length > 0
        );

        if (skills.length === 0) {
            list.innerHTML = `
                <div class="text-sm text-gray-500 p-4 border border-dashed border-gray-200 rounded">
                    No local skills installed. Drop a skill folder under <code class="text-xs bg-gray-100 px-1 rounded">skills/</code> in your synergyAI root and reload to see it here.
                </div>
            `;
            return;
        }

        const escape = (s) => {
            const d = document.createElement('div');
            d.textContent = s ?? '';
            return d.innerHTML;
        };

        list.innerHTML = skills
            .slice()
            .sort((a, b) => (a.dir_name || '').localeCompare(b.dir_name || ''))
            .map(s => {
                const enabled = window.skillsManager.isSkillEnabled(s.dir_name);
                const desc = (s.description || '').replace(/\s+/g, ' ').trim();
                const truncated = desc.length > 240 ? desc.slice(0, 237) + '…' : desc;
                return `
                    <div class="flex items-start justify-between gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50">
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                                <span class="font-medium text-sm text-gray-900">${escape(s.name || s.dir_name)}</span>
                                <code class="text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">${escape(s.dir_name)}</code>
                            </div>
                            <div class="text-xs text-gray-600 mt-1 leading-relaxed">${escape(truncated || '(no description)')}</div>
                        </div>
                        <label class="inline-flex items-center cursor-pointer flex-shrink-0 mt-0.5" title="${enabled ? 'Enabled — visible to the chat auto-router' : 'Disabled — hidden from the auto-router'}">
                            <input type="checkbox" data-skill-toggle="${escape(s.dir_name)}" class="sr-only peer" ${enabled ? 'checked' : ''}>
                            <span class="relative w-10 h-5 bg-gray-300 peer-checked:bg-blue-600 rounded-full transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-5"></span>
                        </label>
                    </div>
                `;
            })
            .join('');

        // Single delegated change listener; wired once per render is fine
        // because we replace the container's innerHTML each time.
        list.addEventListener('change', (e) => {
            const cb = e.target.closest('input[type="checkbox"][data-skill-toggle]');
            if (!cb) return;
            const dirName = cb.dataset.skillToggle;
            window.skillsManager.setSkillEnabled(dirName, cb.checked);
            const label = cb.closest('label');
            if (label) label.title = cb.checked
                ? 'Enabled — visible to the chat auto-router'
                : 'Disabled — hidden from the auto-router';
        });
    }

    /**
     * Load the user's frozen memory blocks into the Memory tab.
     */
    async loadMemory() {
        const memProject = document.getElementById('memory-project-input');
        const memUser = document.getElementById('memory-user-input');
        const memProjectCount = document.getElementById('memory-project-count');
        const memUserCount = document.getElementById('memory-user-count');
        const autoToggle = document.getElementById('memory-auto-toggle');
        const autoModel = document.getElementById('memory-auto-model');

        try {
            const res = await fetch(`${this.apiBaseUrl}/user-memories?t=${Date.now()}`, {
                headers: { 'Authorization': `Bearer ${this.getAuthToken()}` },
                cache: 'no-store'
            });
            if (!res.ok) return;
            const json = await res.json();
            const data = json.data || {};
            if (memProject) memProject.value = data.memory?.content || '';
            if (memUser) memUser.value = data.user?.content || '';
            if (memProjectCount) memProjectCount.textContent = (memProject?.value || '').length;
            if (memUserCount) memUserCount.textContent = (memUser?.value || '').length;

            // Auto-update settings
            const auto = data.auto_update || { enabled: true, model: '', allowed_models: [] };
            if (autoModel) {
                autoModel.innerHTML = '';
                (auto.allowed_models || []).forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    if (m === auto.model) opt.selected = true;
                    autoModel.appendChild(opt);
                });
            }
            if (autoToggle) autoToggle.checked = !!auto.enabled;

            // Reset history panel; it loads lazily when the user expands it.
            const histBody = document.getElementById('memory-history-body');
            if (histBody) histBody.innerHTML = '';
            const histCount = document.getElementById('memory-history-count');
            if (histCount) histCount.textContent = '';
            const histCaret = document.getElementById('memory-history-caret');
            if (histCaret) histCaret.textContent = '▶';
            if (histBody) histBody.classList.add('hidden');
        } catch (e) {
            console.error('[SettingsPanel] loadMemory failed:', e);
        }
    }

    async saveAutoUpdate() {
        const autoToggle = document.getElementById('memory-auto-toggle');
        const autoModel = document.getElementById('memory-auto-model');
        const status = document.getElementById('memory-auto-status');
        if (!autoToggle || !autoModel) return;

        const body = {
            auto_update: {
                enabled: !!autoToggle.checked,
                model: autoModel.value,
            },
        };

        try {
            const res = await fetch(`${this.apiBaseUrl}/user-memories`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`,
                },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (status) {
                status.textContent = json.success ? '✓ Saved' : `Error: ${json.error || 'failed'}`;
                status.className = json.success ? 'text-sm text-green-600' : 'text-sm text-red-600';
                setTimeout(() => { status.className = 'hidden text-sm'; }, 2000);
            }
        } catch (e) {
            console.error('[SettingsPanel] saveAutoUpdate failed:', e);
        }
    }

    async toggleMemoryHistory() {
        const body = document.getElementById('memory-history-body');
        const caret = document.getElementById('memory-history-caret');
        if (!body) return;

        const isHidden = body.classList.contains('hidden');
        if (isHidden) {
            body.classList.remove('hidden');
            if (caret) caret.textContent = '▼';
            await this.loadMemoryHistory();
        } else {
            body.classList.add('hidden');
            if (caret) caret.textContent = '▶';
        }
    }

    async loadMemoryHistory() {
        const body = document.getElementById('memory-history-body');
        const count = document.getElementById('memory-history-count');
        if (!body) return;

        body.innerHTML = '<div class="text-xs text-gray-500">Loading…</div>';

        try {
            const res = await fetch(`${this.apiBaseUrl}/user-memories/events?limit=30&t=${Date.now()}`, {
                headers: { 'Authorization': `Bearer ${this.getAuthToken()}` },
                cache: 'no-store'
            });
            if (!res.ok) {
                body.innerHTML = '<div class="text-xs text-red-600">Failed to load history</div>';
                return;
            }
            const json = await res.json();
            const events = json.data || [];
            if (count) count.textContent = events.length ? `(${events.length})` : '';

            if (events.length === 0) {
                body.innerHTML = '<div class="text-xs text-gray-500">No changes yet.</div>';
                return;
            }

            body.innerHTML = events.map(e => this.renderHistoryEvent(e)).join('');
        } catch (e) {
            console.error('[SettingsPanel] loadMemoryHistory failed:', e);
            body.innerHTML = '<div class="text-xs text-red-600">Error loading history</div>';
        }
    }

    renderHistoryEvent(event) {
        const sourceLabels = {
            manual: 'Manual edit',
            auto_extract: 'Auto',
            revert: 'Reverted',
            compact: 'Compacted',
        };
        const sourceColors = {
            manual: 'bg-gray-100 text-gray-700',
            auto_extract: 'bg-blue-100 text-blue-700',
            revert: 'bg-yellow-100 text-yellow-700',
            compact: 'bg-purple-100 text-purple-700',
        };
        const srcLabel = sourceLabels[event.source] || event.source;
        const srcClass = sourceColors[event.source] || 'bg-gray-100 text-gray-700';
        const scope = event.scope === 'memory' ? 'Memory' : 'User';
        const rationale = event.rationale ? `<div class="text-xs text-gray-600 mt-1 italic">${this.escapeHtml(event.rationale)}</div>` : '';
        const diff = this.renderDiff(event.before, event.after);

        return `
            <div class="border border-gray-200 rounded-lg p-3 bg-white">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <span class="px-2 py-0.5 rounded text-xs font-medium ${srcClass}">${srcLabel}</span>
                        <span class="text-xs text-gray-500">${scope}</span>
                        <span class="text-xs text-gray-400">${this.escapeHtml(event.created_at)}</span>
                    </div>
                    <button class="text-xs text-red-600 hover:text-red-800 font-medium" onclick="window.settingsPanel.deleteMemoryEvent(${event.id})" title="Remove this entry. If the change hasn't been undone yet, it will be undone first.">Delete</button>
                </div>
                ${rationale}
                <details class="mt-2">
                    <summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-700">View diff</summary>
                    <div class="mt-2 text-xs font-mono space-y-1">${diff}</div>
                </details>
            </div>
        `;
    }

    renderDiff(before, after) {
        const beforeLines = new Set((before || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean));
        const afterLines = (after || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const removed = Array.from(beforeLines).filter(l => !afterLines.includes(l));
        const added = afterLines.filter(l => !beforeLines.has(l));

        const parts = [];
        removed.forEach(l => parts.push(`<div class="text-red-600">− ${this.escapeHtml(l)}</div>`));
        added.forEach(l => parts.push(`<div class="text-green-700">+ ${this.escapeHtml(l)}</div>`));
        if (parts.length === 0) {
            return '<div class="text-gray-400">(no line-level changes)</div>';
        }
        return parts.join('');
    }

    escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    async deleteMemoryEvent(eventId) {
        if (!eventId) return;
        if (!confirm('Delete this entry? If the change is still applied to memory, it will be undone first.')) return;

        try {
            const res = await fetch(`${this.apiBaseUrl}/user-memories/events/${eventId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.getAuthToken()}` },
            });
            const json = await res.json();
            if (json.success) {
                // Refresh both panels — memory text may have changed if
                // the entry's effect was undone before the row was removed.
                await this.loadMemory();
                await this.loadMemoryHistory();
                const body = document.getElementById('memory-history-body');
                const caret = document.getElementById('memory-history-caret');
                if (body) body.classList.remove('hidden');
                if (caret) caret.textContent = '▼';
            } else {
                alert('Delete failed: ' + (json.error || 'unknown error'));
            }
        } catch (e) {
            console.error('[SettingsPanel] deleteMemoryEvent failed:', e);
            alert('Delete failed');
        }
    }

    /**
     * Save both memory blocks.
     */
    async saveMemory() {
        const memProject = document.getElementById('memory-project-input');
        const memUser = document.getElementById('memory-user-input');
        const status = document.getElementById('memory-status');

        const body = {
            memory: memProject ? memProject.value : '',
            user: memUser ? memUser.value : ''
        };

        try {
            const res = await fetch(`${this.apiBaseUrl}/user-memories`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify(body)
            });
            const json = await res.json();
            if (status) {
                status.textContent = json.success ? '✓ Saved' : `Error: ${json.error || 'Save failed'}`;
                status.className = json.success
                    ? 'text-sm text-green-600'
                    : 'text-sm text-red-600';
                setTimeout(() => { status.className = 'hidden text-sm'; }, 3000);
            }
        } catch (e) {
            console.error('[SettingsPanel] saveMemory failed:', e);
            if (status) {
                status.textContent = 'Save failed';
                status.className = 'text-sm text-red-600';
            }
        }
    }

    /**
     * Setup MCP-related event listeners
     */
    setupMCPListeners() {
        // Add server button
        if (this.mcpAddBtn) {
            this.mcpAddBtn.addEventListener('click', () => this.showAddServerForm());
        }

        // Cancel add button
        const cancelBtn = document.getElementById('mcp-cancel-add');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.hideAddServerForm());
        }

        // Test connection button
        const testBtn = document.getElementById('mcp-test-connection');
        if (testBtn) {
            testBtn.addEventListener('click', () => this.testMCPConnection());
        }

        // Save server button
        const saveBtn = document.getElementById('mcp-save-server');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveMCPServer());
        }

        // Refresh MCP button
        if (this.mcpRefreshBtn) {
            this.mcpRefreshBtn.addEventListener('click', () => this.loadMCPData());
        }
    }

    /**
     * Show add server form
     */
    showAddServerForm(server = null) {
        this.editingServerId = server?.id || null;

        const nameInput = document.getElementById('mcp-server-name');
        const urlInput = document.getElementById('mcp-server-url');
        const descInput = document.getElementById('mcp-server-description');
        const authInput = document.getElementById('mcp-server-auth');

        if (nameInput) nameInput.value = server?.name || '';
        if (urlInput) urlInput.value = server?.url || '';
        if (descInput) descInput.value = server?.description || '';
        if (authInput) authInput.value = '';

        this.setMCPTestStatus('', null);
        urlInput?.addEventListener('input', () => this.setMCPTestStatus('', null), { once: true });

        if (this.mcpAddForm) {
            this.mcpAddForm.classList.remove('hidden');
        }
        if (this.mcpAddBtn) {
            this.mcpAddBtn.classList.add('hidden');
        }
    }

    /**
     * Hide add server form
     */
    hideAddServerForm() {
        this.editingServerId = null;

        const nameInput = document.getElementById('mcp-server-name');
        const urlInput = document.getElementById('mcp-server-url');
        const descInput = document.getElementById('mcp-server-description');
        const authInput = document.getElementById('mcp-server-auth');

        if (nameInput) nameInput.value = '';
        if (urlInput) urlInput.value = '';
        if (descInput) descInput.value = '';
        if (authInput) authInput.value = '';

        this.setMCPTestStatus('', null);

        if (this.mcpAddForm) {
            this.mcpAddForm.classList.add('hidden');
        }
        if (this.mcpAddBtn) {
            this.mcpAddBtn.classList.remove('hidden');
        }
    }

    /**
     * Test MCP server connection
     */
    setMCPTestStatus(text, state) {
        const el = document.getElementById('mcp-test-status');
        if (!el) return;
        el.classList.remove('visible', 'pending', 'success', 'error');
        if (!text) { el.textContent = ''; return; }
        el.textContent = text;
        el.title = text;
        el.classList.add('visible', state || 'pending');
    }

    /**
     * Read the optional Authorization field and build a headers object.
     * Empty field => {} (no headers => exactly today's behavior).
     */
    getMCPAuthHeaders() {
        const auth = document.getElementById('mcp-server-auth')?.value.trim() || '';
        return auth
            ? { Authorization: /^(Bearer|Basic|Token)\s/i.test(auth) ? auth : ('Bearer ' + auth) }
            : {};
    }

    async testMCPConnection() {
        const urlInput = document.getElementById('mcp-server-url');
        const url = urlInput?.value.trim();
        const authHeaders = this.getMCPAuthHeaders();

        if (!url) {
            this.setMCPTestStatus('Please enter a server URL', 'error');
            return;
        }

        const testBtn = document.getElementById('mcp-test-connection');
        const originalText = testBtn?.textContent;
        if (testBtn) {
            testBtn.textContent = 'Testing...';
            testBtn.disabled = true;
        }
        this.setMCPTestStatus('Testing connection…', 'pending');

        try {
            const result = await window.mcpClient?.testConnection(url, authHeaders);
            console.log('MCP connection test result:', result);

            if (result?.success) {
                const serverName = result.serverInfo?.name || 'Unknown';
                this.setMCPTestStatus(`✓ Connected · ${serverName}`, 'success');
            } else {
                const errorMsg = result?.error || 'Unknown error';
                const urlTried = result?.url_tried ? ` (tried: ${result.url_tried})` : '';
                this.setMCPTestStatus(`✗ ${errorMsg}${urlTried}`, 'error');
                console.error('MCP connection failed:', result);
            }
        } catch (error) {
            this.setMCPTestStatus(`✗ ${error.message}`, 'error');
            console.error('MCP connection error:', error);
        } finally {
            if (testBtn) {
                testBtn.textContent = originalText;
                testBtn.disabled = false;
            }
        }
    }

    /**
     * Save MCP server
     */
    async saveMCPServer() {
        const nameInput = document.getElementById('mcp-server-name');
        const urlInput = document.getElementById('mcp-server-url');
        const descInput = document.getElementById('mcp-server-description');

        const name = nameInput?.value.trim();
        const url = urlInput?.value.trim();
        const description = descInput?.value.trim();
        const authHeaders = this.getMCPAuthHeaders();

        if (!name || !url) {
            this.showNotification('Name and URL are required', 'warning');
            return;
        }

        const saveBtn = document.getElementById('mcp-save-server');
        const originalText = saveBtn?.textContent;
        if (saveBtn) {
            saveBtn.textContent = 'Saving...';
            saveBtn.disabled = true;
        }

        try {
            let result;
            if (this.editingServerId) {
                result = await window.mcpClient?.updateServer(this.editingServerId, name, url, description);
            } else {
                result = await window.mcpClient?.addServer(name, url, description, authHeaders);
            }

            if (result?.success) {
                if (this.editingServerId) {
                    this.showNotification('Server updated', 'success');
                } else {
                    // Discovery is kicked off in the background by mcpClient.addServer;
                    // tell the user the tool count will populate momentarily so the
                    // initial "0 tools" row doesn't look broken.
                    this.showNotification('Server added — discovering tools…', 'info');
                }
                this.hideAddServerForm();
                this.loadMCPData();
            } else if (!this.editingServerId && /already exists/i.test(result?.error || '')) {
                // A prior save inserted the row but tool discovery failed (e.g. the
                // historical TypeError in MCPProxyController::discoverTools).
                // Recover by reloading the list, locating the row by name, and
                // running discovery now so the user sees the tools immediately.
                await window.mcpClient?.loadServers();
                const existing = Array.from(window.mcpClient?.servers?.values() || [])
                    .find(s => s.name === name);
                if (existing) {
                    this.showNotification('Server already saved — discovering tools…', 'info');
                    // discoverTools can reject (e.g. a transient HTTP 404 from the
                    // proxy). Guard it so a failure shows a clear message and still
                    // closes the form + refreshes — never leaving the user stuck on
                    // a stale form with a raw "HTTP 404".
                    try {
                        const disc = await window.mcpClient?.discoverTools(url, existing.id);
                        if (disc?.success) {
                            this.showNotification(`Found ${disc.tools?.length || 0} tools`, 'success');
                        } else {
                            this.showNotification(disc?.error?.message || disc?.error || 'Discovery failed', 'error');
                        }
                    } catch (e) {
                        this.showNotification(`Discovery failed: ${e.message}`, 'error');
                    } finally {
                        this.hideAddServerForm();
                        this.loadMCPData();
                    }
                } else {
                    this.showNotification(result?.error || 'Failed to save server', 'error');
                }
            } else {
                this.showNotification(result?.error || 'Failed to save server', 'error');
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
        } finally {
            if (saveBtn) {
                saveBtn.textContent = originalText;
                saveBtn.disabled = false;
            }
        }
    }

    /**
     * Load MCP servers and tools
     */
    async loadMCPData() {
        if (!window.mcpClient) {
            console.warn('MCP Client not available');
            return;
        }

        await window.mcpClient.loadServers();
        this.renderMCPServers();

        await window.mcpClient.loadAllTools();
        this.renderMCPTools();
    }

    /**
     * Render MCP servers list
     */
    renderMCPServers() {
        if (!this.mcpServerList) return;

        const servers = Array.from(window.mcpClient?.servers?.values() || []);

        if (servers.length === 0) {
            this.mcpServerList.innerHTML = `
                <div class="mcp-empty-state">
                    <svg class="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path>
                    </svg>
                    <p data-i18n="settings.mcpNoServers">No MCP servers configured</p>
                    <small data-i18n="settings.mcpAddFirst">Add a server to get started</small>
                </div>
            `;
            return;
        }

        this.mcpServerList.innerHTML = servers.map(server => {
            const isGlobal = server.user_id === null || server.user_id === undefined || server.user_id === '';
            const scopeBadge = isGlobal
                ? `<span class="mcp-scope-badge mcp-scope-global" title="Available to all users">🌐 Global</span>`
                : `<span class="mcp-scope-badge mcp-scope-user" title="Private to your account">👤 Yours</span>`;
            return `
            <div class="mcp-server-item ${isGlobal ? 'is-global' : 'is-user'}" data-server-id="${server.id}">
                <div class="mcp-server-icon">
                    <span>🔌</span>
                </div>
                <div class="mcp-server-info">
                    <div class="mcp-server-name">
                        ${this.escapeHtml(server.name)}
                        ${scopeBadge}
                    </div>
                    <div class="mcp-server-url">${this.escapeHtml(server.url)}</div>
                    <div class="mcp-server-stats">
                        <span>🔧 ${server.tool_count || 0} tools</span>
                        <span>📱 ${server.ui_tool_count || 0} with UI</span>
                    </div>
                </div>
                <div class="mcp-server-toggle ${server.enabled ? 'active' : ''}"
                     data-server-id="${server.id}"
                     title="${server.enabled ? 'Disable' : 'Enable'}">
                </div>
                <button class="mcp-server-btn refresh" data-action="rediscover" data-server-id="${server.id}" data-server-url="${this.escapeHtml(server.url)}" title="Rediscover tools">
                    ⟳ Rediscover
                </button>
                ${isGlobal ? '' : `
                <button class="mcp-server-btn edit" data-server-id="${server.id}" title="Edit">
                    ✏️
                </button>
                <button class="mcp-server-btn delete" data-server-id="${server.id}" title="Delete">
                    🗑️
                </button>`}
            </div>
        `;
        }).join('');

        // Add event listeners to server items
        this.mcpServerList.querySelectorAll('.mcp-server-toggle').forEach(toggle => {
            toggle.addEventListener('click', (e) => this.toggleMCPServer(e.target.dataset.serverId));
        });

        this.mcpServerList.querySelectorAll('.mcp-server-btn.refresh').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const el = e.currentTarget;
                this.rediscoverMCPServer(el.dataset.serverId, el.dataset.serverUrl);
            });
        });

        this.mcpServerList.querySelectorAll('.mcp-server-btn.edit').forEach(btn => {
            btn.addEventListener('click', (e) => this.editMCPServer(e.target.dataset.serverId));
        });

        this.mcpServerList.querySelectorAll('.mcp-server-btn.delete').forEach(btn => {
            btn.addEventListener('click', (e) => this.deleteMCPServer(e.target.dataset.serverId));
        });
    }

    /**
     * Render MCP tools list
     */
    renderMCPTools() {
        if (!this.mcpToolsList) return;

        const tools = window.mcpClient?.getAllTools() || [];

        if (this.mcpToolCount) {
            this.mcpToolCount.textContent = `(${tools.length})`;
        }

        if (tools.length === 0) {
            this.mcpToolsList.innerHTML = `
                <div class="text-center text-gray-400 text-sm py-4" data-i18n="settings.mcpNoTools">
                    No tools available. Add and enable MCP servers to see their tools.
                </div>
            `;
            return;
        }

        this.mcpToolsList.innerHTML = tools.map(tool => `
            <div class="mcp-tool-item">
                <div class="mcp-tool-icon ${tool.hasUi ? 'has-ui' : ''}">
                    ${tool.hasUi ? '📱' : '🔧'}
                </div>
                <div class="mcp-tool-info">
                    <div class="mcp-tool-name">
                        ${this.escapeHtml(tool.name)}
                        ${tool.hasUi ? '<span class="mcp-tool-badge ui">Has UI</span>' : ''}
                    </div>
                    <div class="mcp-tool-description">${this.escapeHtml(tool.description || 'No description')}</div>
                </div>
            </div>
        `).join('');
    }

    /**
     * Toggle MCP server enabled state
     */
    async toggleMCPServer(serverId) {
        const server = window.mcpClient?.servers?.get(parseInt(serverId));
        if (!server) return;

        const newState = !server.enabled;
        const result = await window.mcpClient?.toggleServer(serverId, newState);

        if (result?.success) {
            this.loadMCPData();
        } else {
            this.showNotification(result?.error || 'Failed to toggle server', 'error');
        }
    }

    /**
     * Re-run tool discovery for a single server. Carries the URL directly from
     * the button's data-server-url so it works even if the in-memory server map
     * lookup is stale/empty (e.g. a server that finished with 0 tools because it
     * still required auth when first added). Always refreshes the panel so the
     * tool count updates regardless of the discovery outcome.
     */
    async rediscoverMCPServer(serverId, serverUrl) {
        this.showNotification('Discovering tools…', 'info');
        try {
            const res = await window.mcpClient?.discoverTools(serverUrl, serverId);
            if (res?.success) {
                this.showNotification(`Found ${res.tools?.length || 0} tools`, 'success');
            } else {
                this.showNotification(res?.error?.message || res?.error || 'Discovery failed', 'error');
            }
        } catch (e) {
            this.showNotification(`Discovery failed: ${e.message}`, 'error');
        } finally {
            this.loadMCPData(); // refresh the tool count regardless
        }
    }

    /**
     * Edit MCP server
     */
    editMCPServer(serverId) {
        const server = window.mcpClient?.servers?.get(parseInt(serverId));
        if (!server) return;

        this.showAddServerForm(server);
    }

    /**
     * Delete MCP server
     */
    async deleteMCPServer(serverId) {
        if (!confirm('Are you sure you want to delete this MCP server?')) {
            return;
        }

        const result = await window.mcpClient?.deleteServer(serverId);

        if (result?.success) {
            this.showNotification('Server deleted', 'success');
            // If the add/edit form was open for the server we just deleted, close
            // it — otherwise the user is stranded in a stale form with no
            // "Add server" button (the button is hidden while a form is open).
            if (this.editingServerId != null && String(this.editingServerId) === String(serverId)) {
                this.hideAddServerForm();
            }
            this.loadMCPData();
        } else {
            this.showNotification(result?.error || 'Failed to delete server', 'error');
        }
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    // ==========================================
    // ACCOUNT TAB METHODS
    // ==========================================

    /**
     * Setup Account tab event listeners
     */
    setupAccountListeners() {
        // Voice dictation provider (used by the mic button next to Send).
        const vdSelect = document.getElementById('voice-dictation-provider');
        if (vdSelect) {
            const saved = localStorage.getItem('voiceDictationProvider');
            vdSelect.value = (saved === 'gemini' || saved === 'grok') ? saved : 'gemini';
            vdSelect.addEventListener('change', (e) => {
                localStorage.setItem('voiceDictationProvider', e.target.value);
            });
        }

        // Send verification code button
        const sendVerificationBtn = document.getElementById('send-verification-btn');
        if (sendVerificationBtn) {
            sendVerificationBtn.addEventListener('click', () => this.sendPhoneVerification());
        }

        // Verify code button
        const verifyCodeBtn = document.getElementById('verify-code-btn');
        if (verifyCodeBtn) {
            verifyCodeBtn.addEventListener('click', () => this.verifyPhoneCode());
        }

        // Cancel verification button
        const cancelVerificationBtn = document.getElementById('cancel-verification-btn');
        if (cancelVerificationBtn) {
            cancelVerificationBtn.addEventListener('click', () => this.cancelPhoneVerification());
        }

        // Phone toggle switch
        const phoneToggle = document.getElementById('phone-toggle');
        if (phoneToggle) {
            phoneToggle.addEventListener('change', (e) => {
                if (!e.target.checked) {
                    // Turning off = unlink
                    if (confirm('Unlink your phone number?')) {
                        this.unlinkPhone();
                    } else {
                        e.target.checked = true;
                    }
                }
                // Turning on is handled by the phone link form
            });
        }

        // Logout button
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                if (window.authManager) {
                    window.authManager.logout();
                }
            });
        }

        // Biometric toggle switch
        const biometricToggle = document.getElementById('biometric-toggle');
        if (biometricToggle) {
            biometricToggle.addEventListener('change', (e) => {
                if (e.target.checked) {
                    this.registerBiometric();
                } else {
                    this.removeBiometric();
                }
            });
        }

        // Storage provider + root folder are set by the install wizard;
        // settings panel just displays them. No save button to wire.

        // Auto-submit verification code when 6 digits entered
        const verificationInput = document.getElementById('verification-code-input');
        if (verificationInput) {
            verificationInput.addEventListener('input', (e) => {
                // Only allow digits
                e.target.value = e.target.value.replace(/\D/g, '');
                // Auto-submit when 6 digits
                if (e.target.value.length === 6) {
                    this.verifyPhoneCode();
                }
            });
        }
    }

    /**
     * Load account data when Account tab is opened
     */
    loadAccountData() {
        // Display user info
        const user = window.authManager?.user;
        if (user) {
            const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '-'; };

            setEl('account-first-name', user.first_name);
            setEl('account-last-name', user.last_name);
            setEl('account-email', user.email);
            setEl('account-role', user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : null);
            setEl('account-plan', user.plan ? user.plan.charAt(0).toUpperCase() + user.plan.slice(1) : 'Free');

            const providerNames = {
                'email': 'Email/Password',
                'google': 'Google',
                'facebook': 'Facebook',
                'phone': 'Phone'
            };
            setEl('account-provider', providerNames[user.provider] || user.provider);

            // Format dates
            const formatDate = (d) => {
                if (!d) return '-';
                const dt = new Date(d);
                return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            };
            setEl('account-last-login', formatDate(user.last_login));
            setEl('account-created-at', formatDate(user.created_at));

            // Change-password card is shown whenever the Firebase account
            // has a password provider linked — `providerData` is the source
            // of truth, not `user.provider` (which only holds the *last*
            // sign-in method and gets overwritten on every social login).
            const cpSection = document.getElementById('change-password-section');
            if (cpSection) {
                const fbUser = window.firebase?.auth?.()?.currentUser;
                const hasPassword = !!fbUser?.providerData?.some(p => p.providerId === 'password');
                cpSection.classList.toggle('hidden', !hasPassword);
            }

            this.renderEmailVerificationBanner(user);
            this.renderLinkedMethods();
            this.renderAppKeySection(user);
        }

        // Load token usage and quota info
        this.loadAccountUsage();

        // Load phone status
        this.loadPhoneStatus();

        // Load biometric status
        this.loadBiometricStatus();

        // Reset the change-password form whenever the panel opens, so old
        // values don't linger across sessions.
        ['cp-current', 'cp-new', 'cp-confirm'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        const cpMsg = document.getElementById('change-password-message');
        if (cpMsg) cpMsg.classList.add('hidden');

        // Load storage settings
        this.loadStorageSettings();

        // Initialize reCAPTCHA if not already
        this.initRecaptcha();
    }

    // ===== App Key (per-user API credential) =====

    /**
     * Toggle the App Key card between "no key" and "key exists" states based
     * on user.app_key_prefix. Wires the buttons on first render.
     */
    renderAppKeySection(user) {
        if (!document.getElementById('app-key-section') || !user) return;

        const hasKey = !!user.app_key_prefix;
        document.getElementById('app-key-empty')?.classList.toggle('hidden', hasKey);
        document.getElementById('app-key-exists')?.classList.toggle('hidden', !hasKey);

        if (hasKey) {
            const prefixEl  = document.getElementById('app-key-prefix-display');
            const createdEl = document.getElementById('app-key-created-display');
            if (prefixEl)  prefixEl.textContent  = user.app_key_prefix;
            if (createdEl) createdEl.textContent = this._formatAppKeyDate(user.app_key_created_at);
        }

        this._bindAppKeyHandlersOnce();
    }

    _formatAppKeyDate(d) {
        if (!d) return '—';
        const dt = new Date(d);
        return isNaN(dt) ? d : dt.toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    _bindAppKeyHandlersOnce() {
        if (this._appKeyBound) return;
        this._appKeyBound = true;
        document.getElementById('app-key-generate-btn')?.addEventListener('click', () => this._appKeyGenerate(false));
        document.getElementById('app-key-regenerate-btn')?.addEventListener('click', () => this._appKeyGenerate(true));
        document.getElementById('app-key-revoke-btn')?.addEventListener('click', () => this._appKeyRevoke());
        document.getElementById('app-key-copy-btn')?.addEventListener('click', () => this._appKeyCopy());
        document.getElementById('app-key-dismiss-btn')?.addEventListener('click', () => this._appKeyDismissNew());
    }

    async _appKeyGenerate(isRegenerate) {
        if (isRegenerate && !confirm('Regenerating will invalidate your current app key. Continue?')) return;
        this._showAppKeyMessage('');
        try {
            const result = await this._appKeyAuthFetch('generate_app_key');
            if (!result?.success) throw new Error(result?.message || 'Failed to generate app key.');
            const data = result.data || {};

            // Show the full key once.
            const input = document.getElementById('app-key-fullkey');
            const wrap  = document.getElementById('app-key-just-generated');
            if (input) input.value = data.app_key || '';
            wrap?.classList.remove('hidden');

            // Mirror prefix + created_at onto window.authManager.user AND
            // localStorage.user so the rest of the app sees the new state
            // without a re-login.
            this._updateUserField('app_key_prefix', data.app_key_prefix);
            this._updateUserField('app_key_created_at', data.app_key_created_at);

            this.renderAppKeySection(window.authManager?.user);
        } catch (err) {
            this._showAppKeyMessage(err.message || 'Failed to generate app key.', 'error');
        }
    }

    async _appKeyRevoke() {
        if (!confirm('Revoke your app key? Any client using it will lose access.')) return;
        this._showAppKeyMessage('');
        try {
            const result = await this._appKeyAuthFetch('revoke_app_key');
            if (!result?.success) throw new Error(result?.message || 'Failed to revoke app key.');
            this._updateUserField('app_key_prefix', null);
            this._updateUserField('app_key_created_at', null);
            document.getElementById('app-key-just-generated')?.classList.add('hidden');
            const input = document.getElementById('app-key-fullkey');
            if (input) input.value = '';
            this.renderAppKeySection(window.authManager?.user);
            this._showAppKeyMessage('App key revoked.', 'success');
        } catch (err) {
            this._showAppKeyMessage(err.message || 'Failed to revoke app key.', 'error');
        }
    }

    async _appKeyCopy() {
        const input = document.getElementById('app-key-fullkey');
        const value = input?.value || '';
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            this._showAppKeyMessage('App key copied to clipboard.', 'success');
        } catch {
            input?.select();
            input?.setSelectionRange(0, 99999);
            this._showAppKeyMessage('Press Ctrl/Cmd-C to copy the highlighted key.', 'error');
        }
    }

    _appKeyDismissNew() {
        const input = document.getElementById('app-key-fullkey');
        if (input) input.value = '';
        document.getElementById('app-key-just-generated')?.classList.add('hidden');
    }

    async _appKeyAuthFetch(action) {
        const token = (typeof localStorage !== 'undefined') ? localStorage.getItem('token') : null;
        const res = await fetch('/gpt/backend/api/v1/auth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
            },
            body: JSON.stringify({ action }),
        });
        const text = await res.text();
        try { return text ? JSON.parse(text) : null; }
        catch { throw new Error(`Server returned a non-JSON response (status ${res.status}).`); }
    }

    _updateUserField(field, value) {
        const auth = window.authManager;
        if (auth && auth.user) auth.user[field] = value;
        try {
            const raw = localStorage.getItem('user');
            if (raw) {
                const u = JSON.parse(raw);
                u[field] = value;
                localStorage.setItem('user', JSON.stringify(u));
            }
        } catch {}
    }

    _showAppKeyMessage(text, type = 'error') {
        const el = document.getElementById('app-key-message');
        if (!el) return;
        if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
        el.textContent = text;
        el.classList.remove('hidden');
        el.classList.remove('bg-red-50', 'text-red-700', 'border', 'border-red-200', 'bg-green-50', 'text-green-700', 'border-green-200');
        if (type === 'success') {
            el.classList.add('bg-green-50', 'text-green-700', 'border', 'border-green-200');
        } else {
            el.classList.add('bg-red-50', 'text-red-700', 'border', 'border-red-200');
        }
    }

    /**
     * Show or hide the email-verification banner in Settings → Account.
     * Firebase is the source of truth for verification status — `currentUser`
     * is the authoritative live state. The banner is hidden when:
     *   - The account isn't on Firebase (legacy local-bcrypt user not yet
     *     migrated — they'll get this UI after import).
     *   - The user signed in via Phone (no email verification concept).
     *   - The Firebase user reports `emailVerified === true`.
     */
    renderEmailVerificationBanner(user) {
        const banner = document.getElementById('account-email-verification');
        if (!banner) return;

        const fbUser = (window.firebase?.auth?.()?.currentUser) || null;
        const provider = user?.provider ?? 'email';

        // Phone users have no email to verify; legacy non-Firebase users
        // don't have a Firebase session to act against. Hide silently.
        if (provider === 'phone' || !fbUser || !fbUser.email) {
            banner.classList.add('hidden');
            return;
        }

        if (fbUser.emailVerified) {
            banner.className = 'mt-3 py-2 px-3 rounded-lg border text-sm flex items-center justify-between gap-3 bg-green-50 border-green-200 text-green-800';
            banner.innerHTML = `
                <div class="flex items-center gap-2">
                    <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                    </svg>
                    <span>Email verified</span>
                </div>
            `;
        } else {
            banner.className = 'mt-3 py-2 px-3 rounded-lg border text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-amber-50 border-amber-200 text-amber-900';
            banner.innerHTML = `
                <div class="flex items-center gap-2">
                    <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3l-6.93-12a2 2 0 00-3.48 0L3.33 16a2 2 0 001.74 3z"/>
                    </svg>
                    <span>Your email is not verified yet.</span>
                </div>
                <button id="resend-verification-btn" type="button"
                    class="px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-md transition flex-shrink-0">
                    Send verification email
                </button>
            `;
            const btn = banner.querySelector('#resend-verification-btn');
            if (btn) btn.addEventListener('click', () => this.resendEmailVerification(btn));
        }
        banner.classList.remove('hidden');
    }

    /**
     * Trigger Firebase to send (or re-send) the email-verification message
     * to the currently signed-in user. Firebase enforces its own throttling.
     */
    async resendEmailVerification(btn) {
        const fbUser = window.firebase?.auth?.()?.currentUser;
        if (!fbUser) return;

        const original = btn?.textContent;
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        try {
            await fbUser.sendEmailVerification();
            if (btn) btn.textContent = '✓ Sent — check inbox';
            setTimeout(() => {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = original;
                }
            }, 2500);
        } catch (e) {
            console.error('sendEmailVerification failed:', e);
            const msg = e?.code === 'auth/too-many-requests'
                ? 'Too many attempts — try again later'
                : 'Could not send — try again';
            if (btn) {
                btn.textContent = msg;
                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = original;
                }, 2500);
            }
        }
    }

    /**
     * Render the Linked Sign-in Methods panel. Reads the live state from
     * `firebase.auth().currentUser.providerData` (the source of truth)
     * and shows one row per supported method (Email/Password, Google,
     * Facebook). Each row says "Linked" or shows an "Add" button that
     * triggers the appropriate Firebase link* call.
     *
     * Hidden when the user isn't on Firebase yet (legacy local-bcrypt).
     */
    renderLinkedMethods() {
        const section = document.getElementById('linked-methods-section');
        const list = document.getElementById('linked-methods-list');
        if (!section || !list) return;

        const fbUser = window.firebase?.auth?.()?.currentUser;
        if (!fbUser) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        // Map providerId -> entry. providerData is an array of UserInfo objects.
        const linked = {};
        (fbUser.providerData || []).forEach(p => { linked[p.providerId] = p; });

        const methods = [
            { id: 'password',         label: 'Email & Password', icon: '✉️',  add: () => this.startLinkEmail() },
            { id: 'google.com',       label: 'Google',           icon: 'G',  add: () => this.linkSocial('google') },
            { id: 'facebook.com',     label: 'Facebook',         icon: 'f',  add: () => this.linkSocial('facebook') },
        ];

        list.innerHTML = '';
        methods.forEach(m => {
            const isLinked = !!linked[m.id];
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between py-2 px-3 bg-gray-50 border border-gray-200 rounded-lg';
            const linkedEmail = isLinked && linked[m.id].email ? `<span class="text-xs text-gray-500 ml-2">${linked[m.id].email}</span>` : '';
            row.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white border border-gray-300 text-xs font-bold">${m.icon}</span>
                    <span class="text-sm text-gray-800">${m.label}</span>
                    ${linkedEmail}
                </div>
                <div></div>
            `;
            const right = row.querySelector('div:last-child');
            if (isLinked) {
                right.innerHTML = `<span class="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">Linked</span>`;
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'text-xs font-medium px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition';
                btn.textContent = 'Add';
                btn.addEventListener('click', m.add);
                right.appendChild(btn);
            }
            list.appendChild(row);
        });

        // Wire the email/password inline form (idempotent — listener-set check via dataset).
        const submit = document.getElementById('link-email-submit');
        const cancel = document.getElementById('link-email-cancel');
        if (submit && !submit.dataset.wired) {
            submit.dataset.wired = '1';
            submit.addEventListener('click', () => this.submitLinkEmail());
        }
        if (cancel && !cancel.dataset.wired) {
            cancel.dataset.wired = '1';
            cancel.addEventListener('click', () => this.cancelLinkEmail());
        }
    }

    startLinkEmail() {
        const form = document.getElementById('link-email-form');
        const emailInput = document.getElementById('link-email-input');
        if (!form) return;
        // Pre-fill with the Firebase user's email if set (typical for Facebook
        // logins where Facebook returned an email).
        const fbUser = window.firebase?.auth?.()?.currentUser;
        if (emailInput && fbUser?.email) emailInput.value = fbUser.email;
        ['link-password-input', 'link-password-confirm'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        const msg = document.getElementById('link-email-message'); if (msg) msg.classList.add('hidden');
        form.classList.remove('hidden');
    }

    cancelLinkEmail() {
        const form = document.getElementById('link-email-form');
        if (form) form.classList.add('hidden');
    }

    async submitLinkEmail() {
        const emailEl = document.getElementById('link-email-input');
        const pwEl = document.getElementById('link-password-input');
        const confirmEl = document.getElementById('link-password-confirm');
        const msg = document.getElementById('link-email-message');
        if (!emailEl || !pwEl || !confirmEl) return;

        const setMsg = (text, kind) => {
            if (!msg) return;
            msg.textContent = text;
            msg.className = 'py-2 px-3 rounded-lg text-xs ' + (kind === 'success'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700');
            msg.classList.remove('hidden');
        };

        const email = emailEl.value.trim();
        const pw = pwEl.value;
        const confirm = confirmEl.value;
        if (!email || !pw || !confirm) { setMsg('Please fill in all fields.', 'error'); return; }
        if (pw.length < 8) { setMsg('Password must be at least 8 characters.', 'error'); return; }
        if (pw !== confirm) { setMsg('Passwords do not match.', 'error'); return; }

        const fbUser = window.firebase?.auth?.()?.currentUser;
        if (!fbUser) { setMsg('Not signed in.', 'error'); return; }

        try {
            const credential = firebase.auth.EmailAuthProvider.credential(email, pw);
            await fbUser.linkWithCredential(credential);
            // If the linked email differs from the verified one, send a verify email.
            if (!fbUser.emailVerified) {
                try { await fbUser.sendEmailVerification(); } catch (e) { console.warn('verification send failed', e); }
            }
            setMsg('Email & password linked. You can now sign in either way.', 'success');
            this.cancelLinkEmail();
            this.renderLinkedMethods();
            this.renderEmailVerificationBanner(window.authManager?.user || {});
        } catch (e) {
            const map = {
                'auth/email-already-in-use':    'That email is already used by another account. Use a different email.',
                'auth/credential-already-in-use': 'Those credentials already belong to another account.',
                'auth/provider-already-linked': 'Email & password is already linked to this account.',
                'auth/weak-password':           'Password is too weak (must be at least 8 characters).',
                'auth/invalid-email':           'Please enter a valid email address.',
                'auth/requires-recent-login':   'Please sign out and sign in again, then try linking.',
            };
            setMsg(map[e?.code] || (e?.message || 'Could not link the account.'), 'error');
        }
    }

    /**
     * Link a Google or Facebook identity to the current Firebase user via
     * `linkWithPopup`. After success the providerData array gains the new
     * entry, so we just re-render the list.
     */
    async linkSocial(which) {
        const fbUser = window.firebase?.auth?.()?.currentUser;
        if (!fbUser) return;

        const provider = which === 'google'
            ? new firebase.auth.GoogleAuthProvider()
            : new firebase.auth.FacebookAuthProvider();

        try {
            await fbUser.linkWithPopup(provider);
            this.showNotification?.(`${which.charAt(0).toUpperCase() + which.slice(1)} linked.`, 'success');
            this.renderLinkedMethods();
        } catch (e) {
            const map = {
                'auth/credential-already-in-use': 'That account is already linked to another user.',
                'auth/provider-already-linked':   'That provider is already linked to this account.',
                'auth/popup-closed-by-user':      null, // silent — user cancelled
                'auth/cancelled-popup-request':   null,
            };
            const msg = map[e?.code];
            if (msg === null) return;
            (this.showNotification || alert)(msg || (e?.message || 'Could not link the account.'), 'error');
        }
    }

    /**
     * Change the password via Firebase. Two-step, both client-side:
     *   1. reauthenticateWithCredential(EmailAuthProvider.credential(...))
     *      — verifies the current password, also satisfies Firebase's
     *      "recent login" requirement.
     *   2. updatePassword(newPassword) — Firebase stores the new hash.
     *
     * The backend isn't involved; our local `users.password` column is no
     * longer the source of truth (Firebase is). The user's JWT remains
     * valid — no forced re-login.
     */
    async changePassword() {
        const currentEl = document.getElementById('cp-current');
        const newEl = document.getElementById('cp-new');
        const confirmEl = document.getElementById('cp-confirm');
        const btn = document.getElementById('change-password-btn');
        const msg = document.getElementById('change-password-message');
        if (!currentEl || !newEl || !confirmEl || !btn) return;

        const setMsg = (text, kind /* 'success' | 'error' */) => {
            if (!msg) return;
            msg.textContent = text;
            msg.className = 'py-2 px-3 rounded-lg text-sm ' + (kind === 'success'
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700');
        };

        const current = currentEl.value;
        const next = newEl.value;
        const confirm = confirmEl.value;

        if (!current || !next || !confirm) { setMsg('Please fill in all three fields.', 'error'); return; }
        if (next.length < 8)                { setMsg('New password must be at least 8 characters.', 'error'); return; }
        if (next !== confirm)               { setMsg('New password and confirmation do not match.', 'error'); return; }
        if (next === current)               { setMsg('New password must differ from the current one.', 'error'); return; }

        const fbUser = window.firebase?.auth?.()?.currentUser;
        if (!fbUser || !fbUser.email) {
            setMsg('You must be signed in with an email/password account to change the password.', 'error');
            return;
        }

        btn.disabled = true;
        const originalLabel = btn.querySelector('span')?.textContent;
        if (btn.querySelector('span')) btn.querySelector('span').textContent = 'Updating…';

        try {
            const credential = firebase.auth.EmailAuthProvider.credential(fbUser.email, current);
            await fbUser.reauthenticateWithCredential(credential);
            await fbUser.updatePassword(next);
            setMsg('Password updated.', 'success');
            currentEl.value = '';
            newEl.value = '';
            confirmEl.value = '';
        } catch (e) {
            const map = {
                'auth/wrong-password':            'Current password is incorrect.',
                'auth/invalid-credential':        'Current password is incorrect.',
                'auth/invalid-login-credentials': 'Current password is incorrect.',
                'auth/too-many-requests':         'Too many attempts — please wait a few minutes and try again.',
                'auth/weak-password':             'New password is too weak (must be at least 8 characters).',
                'auth/requires-recent-login':     'Please sign out and sign in again, then change your password.',
                'auth/network-request-failed':    'Network error — check your connection and try again.',
            };
            setMsg(map[e?.code] || (e?.message || 'Could not update password.'), 'error');
        } finally {
            btn.disabled = false;
            if (btn.querySelector('span') && originalLabel) {
                btn.querySelector('span').textContent = originalLabel;
            }
        }
    }

    /**
     * Load token usage stats and quota info for the Account tab
     * Fetches lifetime totals + plan/role to compute quota percentage
     */
    async loadAccountUsage() {
        try {
            const response = await fetch(`${this.apiBaseUrl}/settings/usage`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                }
            });

            if (!response.ok) return;

            const data = await response.json();
            if (!data.success) return;

            const usage = data.usage || {};
            const lifetime = usage.lifetime || {};
            const plan = usage.plan || 'free';
            const role = usage.role || 'prospect';
            const quota = usage.free_trial_quota || 50000;

            // Display lifetime input/output token totals
            const inputTokens = lifetime.input_tokens || 0;
            const outputTokens = lifetime.output_tokens || 0;
            const totalTokens = lifetime.total_tokens || (inputTokens + outputTokens);

            const inputEl = document.getElementById('account-input-tokens');
            const outputEl = document.getElementById('account-output-tokens');
            if (inputEl) inputEl.textContent = inputTokens.toLocaleString();
            if (outputEl) outputEl.textContent = outputTokens.toLocaleString();

            // Quota usage section: only shown for free plan + non-admin
            const quotaSection = document.getElementById('account-quota-section');
            const quotaText = document.getElementById('account-quota-text');
            const quotaBar = document.getElementById('account-quota-bar');
            const quotaWarning = document.getElementById('account-quota-warning');

            if (plan === 'free' && role !== 'admin') {
                if (quotaSection) quotaSection.classList.remove('hidden');

                const percent = Math.min(100, Math.round((totalTokens / quota) * 100));

                if (quotaText) {
                    quotaText.textContent = `${totalTokens.toLocaleString()} / ${quota.toLocaleString()} tokens (${percent}%)`;
                }
                if (quotaBar) {
                    quotaBar.style.width = `${percent}%`;
                    // Color shifts based on usage
                    quotaBar.classList.remove('bg-amber-500', 'bg-orange-500', 'bg-red-500', 'bg-green-500');
                    if (percent >= 100) {
                        quotaBar.classList.add('bg-red-500');
                    } else if (percent >= 80) {
                        quotaBar.classList.add('bg-orange-500');
                    } else if (percent >= 50) {
                        quotaBar.classList.add('bg-amber-500');
                    } else {
                        quotaBar.classList.add('bg-green-500');
                    }
                }
                if (quotaWarning) {
                    if (percent >= 100) {
                        quotaWarning.classList.remove('hidden');
                    } else {
                        quotaWarning.classList.add('hidden');
                    }
                }
            } else {
                // Hide quota section for paid plans or admins
                if (quotaSection) quotaSection.classList.add('hidden');
            }
        } catch (error) {
            console.error('Error loading account usage:', error);
        }
    }

    /**
     * Load phone linking status from backend
     */
    async loadPhoneStatus() {
        try {
            const response = await fetch(`${this.apiBaseUrl}/settings/phone`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                }
            });

            const data = await response.json();

            const phoneToggle = document.getElementById('phone-toggle');
            const phoneLabel = document.getElementById('phone-toggle-label');
            const linkedInfoEl = document.getElementById('phone-linked-info');
            const linkedNumberEl = document.getElementById('linked-phone-number');
            const linkFormEl = document.getElementById('phone-link-form');

            if (data.success && data.phone) {
                // Phone is linked
                if (phoneToggle) phoneToggle.checked = true;
                if (phoneLabel) {
                    phoneLabel.textContent = 'Phone login enabled';
                    phoneLabel.classList.remove('text-gray-700');
                    phoneLabel.classList.add('text-green-700');
                }
                if (linkedInfoEl) linkedInfoEl.classList.remove('hidden');
                if (linkedNumberEl) linkedNumberEl.textContent = this.formatPhoneNumber(data.phone);
                if (linkFormEl) linkFormEl.classList.add('hidden');
            } else {
                // Phone not linked
                if (phoneToggle) phoneToggle.checked = false;
                if (phoneLabel) {
                    phoneLabel.textContent = 'Phone login not set up';
                    phoneLabel.classList.remove('text-green-700');
                    phoneLabel.classList.add('text-gray-700');
                }
                if (linkedInfoEl) linkedInfoEl.classList.add('hidden');
                if (linkFormEl) linkFormEl.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Error loading phone status:', error);
        }
    }

    /**
     * Format phone number for display (e.g., +1 514-791-9453)
     */
    formatPhoneNumber(phone) {
        if (!phone) return phone;

        // Handle North American numbers (+1 followed by 10 digits)
        const naMatch = phone.match(/^\+1(\d{10})$/);
        if (naMatch) {
            const number = naMatch[1];
            return `+1 ${number.slice(0,3)}-${number.slice(3,6)}-${number.slice(6)}`;
        }

        // For other international numbers, just clean up spacing
        return phone.replace(/^\+(\d{1,3})/, '+$1 ');
    }

    /**
     * Initialize Firebase reCAPTCHA verifier
     */
    initRecaptcha() {
        if (this.recaptchaVerifier) return;

        const container = document.getElementById('recaptcha-container-settings');
        if (!container || !window.firebase?.auth) return;

        try {
            this.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container-settings', {
                'size': 'invisible',
                'callback': () => {
                    console.log('[Settings] reCAPTCHA solved');
                },
                'expired-callback': () => {
                    console.log('[Settings] reCAPTCHA expired');
                    this.recaptchaVerifier = null;
                }
            });
        } catch (error) {
            console.error('Error initializing reCAPTCHA:', error);
        }
    }

    /**
     * Send SMS verification code
     */
    async sendPhoneVerification() {
        const countryCode = document.getElementById('phone-country-code')?.value || '+1';
        const phoneInput = document.getElementById('phone-number-input')?.value.trim();

        if (!phoneInput) {
            this.showNotification('Please enter a phone number', 'warning');
            return;
        }

        // Format phone number
        const cleanNumber = phoneInput.replace(/\D/g, '');
        const fullPhoneNumber = countryCode + cleanNumber;

        const sendBtn = document.getElementById('send-verification-btn');
        const originalText = sendBtn?.innerHTML;
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Sending...';
        }

        try {
            // Initialize reCAPTCHA if needed
            if (!this.recaptchaVerifier) {
                this.initRecaptcha();
            }

            // Send verification code via Firebase
            const confirmationResult = await firebase.auth().signInWithPhoneNumber(
                fullPhoneNumber,
                this.recaptchaVerifier
            );

            this.phoneConfirmationResult = confirmationResult;

            // Show verification form
            const linkForm = document.getElementById('phone-link-form');
            const verifyForm = document.getElementById('phone-verify-form');
            const phoneDisplay = document.getElementById('verification-phone-display');

            if (linkForm) linkForm.classList.add('hidden');
            if (verifyForm) verifyForm.classList.remove('hidden');
            if (phoneDisplay) phoneDisplay.textContent = fullPhoneNumber;

            // Focus on code input
            document.getElementById('verification-code-input')?.focus();

            this.showNotification('Verification code sent!', 'success');

        } catch (error) {
            console.error('Error sending verification:', error);

            // Reset reCAPTCHA on error
            this.recaptchaVerifier = null;

            let errorMessage = 'Failed to send verification code';
            if (error.code === 'auth/invalid-phone-number') {
                errorMessage = 'Invalid phone number format';
            } else if (error.code === 'auth/too-many-requests') {
                errorMessage = 'Too many requests. Please try again later';
            } else if (error.message) {
                errorMessage = error.message;
            }

            this.showNotification(errorMessage, 'error');
        } finally {
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.innerHTML = originalText;
            }
        }
    }

    /**
     * Verify the SMS code and link phone
     */
    async verifyPhoneCode() {
        const code = document.getElementById('verification-code-input')?.value.trim();

        if (!code || code.length !== 6) {
            this.showNotification('Please enter a 6-digit code', 'warning');
            return;
        }

        if (!this.phoneConfirmationResult) {
            this.showNotification('Verification session expired. Please try again.', 'error');
            this.cancelPhoneVerification();
            return;
        }

        const verifyBtn = document.getElementById('verify-code-btn');
        const originalText = verifyBtn?.textContent;
        if (verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.textContent = 'Verifying...';
        }

        try {
            // Verify the code with Firebase
            const credential = await this.phoneConfirmationResult.confirm(code);
            const phoneNumber = credential.user.phoneNumber;

            // Link phone to user account in backend
            const response = await fetch(`${this.apiBaseUrl}/auth`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({
                    action: 'link_phone',
                    phone_number: phoneNumber
                })
            });

            const data = await response.json();

            if (data.success) {
                this.showNotification('Phone number linked successfully!', 'success');
                this.cancelPhoneVerification();
                this.loadPhoneStatus();
            } else {
                throw new Error(data.message || 'Failed to link phone');
            }

        } catch (error) {
            console.error('Error verifying code:', error);

            let errorMessage = 'Verification failed';
            if (error.code === 'auth/invalid-verification-code') {
                errorMessage = 'Invalid verification code';
            } else if (error.code === 'auth/code-expired') {
                errorMessage = 'Code expired. Please request a new one';
            } else if (error.message) {
                errorMessage = error.message;
            }

            this.showNotification(errorMessage, 'error');
        } finally {
            if (verifyBtn) {
                verifyBtn.disabled = false;
                verifyBtn.textContent = originalText;
            }
        }
    }

    /**
     * Cancel phone verification and reset form
     */
    cancelPhoneVerification() {
        const linkForm = document.getElementById('phone-link-form');
        const verifyForm = document.getElementById('phone-verify-form');
        const codeInput = document.getElementById('verification-code-input');

        if (linkForm) linkForm.classList.remove('hidden');
        if (verifyForm) verifyForm.classList.add('hidden');
        if (codeInput) codeInput.value = '';

        this.phoneConfirmationResult = null;
    }

    /**
     * Unlink phone from account
     */
    async unlinkPhone() {
        if (!confirm('Are you sure you want to unlink your phone number? You won\'t be able to use phone login until you link again.')) {
            return;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/auth`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({
                    action: 'unlink_phone'
                })
            });

            const data = await response.json();

            if (data.success) {
                this.showNotification('Phone number unlinked', 'success');
                this.loadPhoneStatus();
            } else {
                throw new Error(data.message || 'Failed to unlink phone');
            }
        } catch (error) {
            console.error('Error unlinking phone:', error);
            this.showNotification('Failed to unlink phone: ' + error.message, 'error');
        }
    }

    // ==========================================
    // WEBAUTHN (BIOMETRIC) METHODS
    // ==========================================

    /**
     * Load biometric authentication status
     */
    async loadBiometricStatus() {
        const notSupportedEl = document.getElementById('biometric-not-supported');
        const toggleContainer = document.getElementById('biometric-toggle-container');
        const toggle = document.getElementById('biometric-toggle');
        const toggleLabel = document.getElementById('biometric-toggle-label');

        // Check if WebAuthn is supported
        if (!window.PublicKeyCredential) {
            if (notSupportedEl) notSupportedEl.classList.remove('hidden');
            if (toggleContainer) toggleContainer.classList.add('hidden');
            return;
        }

        // Check platform authenticator availability
        try {
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            if (!available) {
                if (notSupportedEl) {
                    notSupportedEl.classList.remove('hidden');
                    notSupportedEl.querySelector('span').textContent = 'No platform authenticator (Face ID, Touch ID, Windows Hello) available on this device.';
                }
                if (toggleContainer) toggleContainer.classList.add('hidden');
                return;
            }
        } catch (error) {
            console.log('[Settings] Could not check platform authenticator:', error);
        }

        // Show toggle container
        if (notSupportedEl) notSupportedEl.classList.add('hidden');
        if (toggleContainer) toggleContainer.classList.remove('hidden');

        // Check if user has a registered credential
        const storedCredentialId = localStorage.getItem('webauthn_credential_id');
        const isRegistered = !!storedCredentialId;

        // Update toggle state
        if (toggle) {
            toggle.checked = isRegistered;
        }

        // Update label text
        if (toggleLabel) {
            if (isRegistered) {
                toggleLabel.textContent = window.i18n?.t('settings.biometricEnabled') || 'Biometric login enabled';
                toggleLabel.classList.remove('text-gray-700');
                toggleLabel.classList.add('text-green-700');
            } else {
                toggleLabel.textContent = window.i18n?.t('settings.biometricNotRegistered') || 'Biometric login not set up';
                toggleLabel.classList.remove('text-green-700');
                toggleLabel.classList.add('text-gray-700');
            }
        }
    }

    /**
     * Register a new biometric credential
     */
    async registerBiometric() {
        const toggle = document.getElementById('biometric-toggle');
        const toggleLabel = document.getElementById('biometric-toggle-label');
        const messageEl = document.getElementById('biometric-message');

        // Show loading state
        if (toggle) toggle.disabled = true;
        if (toggleLabel) toggleLabel.textContent = 'Setting up...';

        try {
            // Step 1: Get challenge from server
            const challengeResponse = await fetch(`${this.apiBaseUrl}/webauthn/challenge`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({ action: 'register' })
            });

            const challengeData = await challengeResponse.json();
            if (!challengeData.success) {
                throw new Error(challengeData.message || 'Failed to get registration challenge');
            }

            // Step 2: Get user info for credential
            const user = window.authManager?.user;
            const userId = user?.id || user?.uid || 'user';
            const userEmail = user?.email || 'user@example.com';
            const userName = user?.first_name ? `${user.first_name} ${user.last_name || ''}`.trim() : userEmail;

            // Step 3: Create credential options
            const publicKeyCredentialCreationOptions = {
                challenge: this.base64UrlDecode(challengeData.challenge),
                rp: {
                    name: challengeData.rp_name || 'AI Assistant',
                    id: challengeData.rp_id
                },
                user: {
                    id: new TextEncoder().encode(userId.toString()),
                    name: userEmail,
                    displayName: userName
                },
                pubKeyCredParams: [
                    { alg: -7, type: 'public-key' },   // ES256
                    { alg: -257, type: 'public-key' }  // RS256
                ],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    userVerification: 'required',
                    residentKey: 'preferred'
                },
                timeout: 60000,
                attestation: 'none'
            };

            // Step 4: Create credential (triggers biometric prompt)
            const credential = await navigator.credentials.create({
                publicKey: publicKeyCredentialCreationOptions
            });

            if (!credential) {
                throw new Error('No credential returned from authenticator');
            }

            // Step 5: Send credential to server for storage
            const credentialId = this.base64UrlEncode(new Uint8Array(credential.rawId));
            const publicKey = this.base64UrlEncode(new Uint8Array(credential.response.getPublicKey()));

            const registerResponse = await fetch(`${this.apiBaseUrl}/webauthn/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({
                    credential_id: credentialId,
                    public_key: publicKey,
                    client_data_json: this.base64UrlEncode(new Uint8Array(credential.response.clientDataJSON)),
                    attestation_object: this.base64UrlEncode(new Uint8Array(credential.response.attestationObject))
                })
            });

            const registerData = await registerResponse.json();

            if (registerData.success) {
                // Store credential ID locally for future login
                localStorage.setItem('webauthn_credential_id', credentialId);

                // Show success message
                this.showBiometricMessage('Biometric login enabled successfully!', 'success');
                this.showNotification('Biometric login enabled!', 'success');

                // Refresh status
                this.loadBiometricStatus();
            } else {
                throw new Error(registerData.message || 'Failed to register biometric');
            }

        } catch (error) {
            console.error('Biometric registration error:', error);

            let errorMessage = 'Failed to set up biometric login';
            if (error.name === 'NotAllowedError') {
                errorMessage = 'Biometric setup was cancelled or not allowed';
            } else if (error.name === 'SecurityError') {
                errorMessage = 'Security error. Please ensure you are using HTTPS';
            } else if (error.name === 'InvalidStateError') {
                errorMessage = 'A credential already exists for this device';
            } else if (error.message) {
                errorMessage = error.message;
            }

            this.showBiometricMessage(errorMessage, 'error');
            this.showNotification(errorMessage, 'error');

            // Revert toggle state on error
            if (toggle) toggle.checked = false;
        } finally {
            // Re-enable toggle and refresh status
            if (toggle) toggle.disabled = false;
            this.loadBiometricStatus();
        }
    }

    /**
     * Remove biometric credential
     */
    async removeBiometric() {
        const toggle = document.getElementById('biometric-toggle');
        const toggleLabel = document.getElementById('biometric-toggle-label');

        const storedCredentialId = localStorage.getItem('webauthn_credential_id');
        if (!storedCredentialId) {
            this.showNotification('No biometric credential found', 'warning');
            this.loadBiometricStatus();
            return;
        }

        // Show loading state
        if (toggle) toggle.disabled = true;
        if (toggleLabel) toggleLabel.textContent = 'Removing...';

        try {
            // Delete from server
            const response = await fetch(`${this.apiBaseUrl}/webauthn/register`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({
                    credential_id: storedCredentialId
                })
            });

            const data = await response.json();

            // Remove from localStorage regardless of server response
            localStorage.removeItem('webauthn_credential_id');

            this.showNotification('Biometric login removed', 'success');

        } catch (error) {
            console.error('Error removing biometric:', error);
            // Still remove from localStorage
            localStorage.removeItem('webauthn_credential_id');
            this.showNotification('Biometric login removed locally', 'warning');
        } finally {
            // Re-enable toggle and refresh status
            if (toggle) toggle.disabled = false;
            this.loadBiometricStatus();
        }
    }

    /**
     * Show biometric message
     */
    showBiometricMessage(message, type) {
        const messageEl = document.getElementById('biometric-message');
        if (!messageEl) return;

        messageEl.classList.remove('hidden', 'bg-green-50', 'text-green-800', 'bg-red-50', 'text-red-800', 'bg-blue-50', 'text-blue-800');

        if (type === 'success') {
            messageEl.classList.add('bg-green-50', 'text-green-800');
        } else if (type === 'error') {
            messageEl.classList.add('bg-red-50', 'text-red-800');
        } else {
            messageEl.classList.add('bg-blue-50', 'text-blue-800');
        }

        messageEl.textContent = message;

        // Auto-hide after 5 seconds
        setTimeout(() => {
            messageEl.classList.add('hidden');
        }, 5000);
    }

    /**
     * Base64URL encode (for WebAuthn)
     */
    base64UrlEncode(buffer) {
        let binary = '';
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    /**
     * Base64URL decode (for WebAuthn)
     */
    base64UrlDecode(str) {
        let padded = str.replace(/-/g, '+').replace(/_/g, '/');
        while (padded.length % 4) {
            padded += '=';
        }
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // ==========================================
    // WORKFLOW OUTPUT STORAGE METHODS
    // ==========================================

    /**
     * Display storage settings (provider + root folder).
     *
     * Source of truth is the install wizard, which stores the chosen
     * FileSystemDirectoryHandle in IndexedDB. We read it here and show
     * the folder name read-only. Provider is "Local" — only local is
     * supported in this incarnation, so no other options are shown.
     */
    async loadStorageSettings() {
        const folderDisplay = document.getElementById('storage-folder-display');
        const folderHidden  = document.getElementById('storage-folder');
        const providerHidden = document.getElementById('storage-provider');

        if (providerHidden) providerHidden.value = 'local';

        if (!folderDisplay) return;

        try {
            const handle = await window.UniversalFSWizard?.loadRootHandle?.();
            const name = handle?.name || '';
            folderDisplay.textContent = name || '— (not yet selected)';
            if (folderHidden) folderHidden.value = name;
        } catch (error) {
            console.error('Error loading wizard root handle:', error);
            folderDisplay.textContent = '— (error)';
        }

        // Render the FSA permission state — separate from the folder name.
        // Picked-but-revoked, picked-and-granted, never-picked, and
        // unsupported-browser are visually distinct.
        await this.renderLocalFsState();
    }

    /**
     * Paint the "Browser Access" row inside Settings → Workflow Output
     * Storage. Reflects window.localFs.getStatus() — separate from the
     * folder *name* the wizard wrote, this is whether the browser can
     * actually read/write that folder right now.
     */
    async renderLocalFsState() {
        const stateEl = document.getElementById('local-fs-state');
        const textEl = document.getElementById('local-fs-state-text');
        const btn = document.getElementById('local-fs-grant-btn');
        if (!stateEl || !textEl || !btn || !window.localFs) return;

        const status = await window.localFs.getStatus();
        const expected = document.getElementById('storage-folder-display')?.textContent?.trim() || '';

        const setColor = (cls) => {
            stateEl.className = 'flex items-center justify-between gap-3 w-full px-3 py-2 rounded-lg text-sm ' + cls;
        };

        if (status.state === 'unsupported') {
            setColor('border border-red-200 bg-red-50 text-red-800');
            textEl.textContent = 'This browser does not support the File System Access API. Use Chrome, Edge, or Brave.';
            btn.classList.add('hidden');
            return;
        }
        if (status.state === 'granted') {
            setColor('border border-green-200 bg-green-50 text-green-800');
            const namePart = status.name ? `"${status.name}"` : 'configured folder';
            textEl.textContent = `✓ Browser has access to ${namePart}`;
            btn.classList.remove('hidden');
            btn.textContent = 'Re-pick';
            btn.onclick = () => this.grantLocalFsAccess(expected);
            return;
        }
        if (status.state === 'prompt') {
            setColor('border border-amber-200 bg-amber-50 text-amber-900');
            textEl.textContent = `Permission needs to be re-confirmed for "${status.name}".`;
            btn.classList.remove('hidden');
            btn.textContent = 'Re-grant';
            btn.onclick = () => this.grantLocalFsAccess(expected || status.name);
            return;
        }
        if (status.state === 'denied') {
            setColor('border border-red-200 bg-red-50 text-red-800');
            textEl.textContent = `Access was denied for "${status.name}". Pick the folder again to restore.`;
            btn.classList.remove('hidden');
            btn.textContent = 'Pick folder';
            btn.onclick = () => this.grantLocalFsAccess(expected || status.name);
            return;
        }
        // not_picked
        setColor('border border-gray-200 bg-gray-50 text-gray-700');
        textEl.textContent = expected
            ? `Browser doesn't have access to "${expected}" yet.`
            : 'No local folder configured.';
        btn.classList.remove('hidden');
        btn.textContent = 'Grant access';
        btn.onclick = () => this.grantLocalFsAccess(expected);
    }

    async grantLocalFsAccess(expectedName) {
        const result = await window.localFs.requestRootAccess(expectedName || '');
        if (result.cancelled) return;
        if (!result.ok) {
            this.showNotification?.(result.error || 'Could not grant access.', 'error');
            return;
        }
        if (result.warning) {
            this.showNotification?.(result.warning, 'warning');
        } else {
            this.showNotification?.('Browser access granted.', 'success');
        }
        await this.renderLocalFsState();
    }

    /**
     * Save storage settings to backend
     */
    async saveStorageSettings() {
        const providerSelect = document.getElementById('storage-provider');
        const folderInput = document.getElementById('storage-folder');
        const saveBtn = document.getElementById('save-storage-btn');
        const messageEl = document.getElementById('storage-message');

        if (!providerSelect || !folderInput) return;

        const provider = providerSelect.value;
        const folder = folderInput.value.trim();

        // Show loading state
        const originalHtml = saveBtn?.innerHTML;
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = `
                <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span>Saving...</span>
            `;
        }

        try {
            const response = await fetch(`${this.apiBaseUrl}/settings/storage`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({ provider, folder })
            });

            const data = await response.json();

            if (data.success) {
                this.showStorageMessage('Storage settings saved successfully!', 'success');
                this.showNotification('Storage settings saved', 'success');
            } else {
                throw new Error(data.error || 'Failed to save settings');
            }
        } catch (error) {
            console.error('Error saving storage settings:', error);
            this.showStorageMessage(error.message, 'error');
            this.showNotification('Failed to save storage settings', 'error');
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = originalHtml;
            }
        }
    }

    /**
     * Show storage settings message
     */
    showStorageMessage(message, type) {
        const messageEl = document.getElementById('storage-message');
        if (!messageEl) return;

        messageEl.classList.remove('hidden', 'bg-green-50', 'text-green-800', 'bg-red-50', 'text-red-800');

        if (type === 'success') {
            messageEl.classList.add('bg-green-50', 'text-green-800');
        } else {
            messageEl.classList.add('bg-red-50', 'text-red-800');
        }

        messageEl.textContent = message;

        setTimeout(() => {
            messageEl.classList.add('hidden');
        }, 5000);
    }

    /**
     * Toggle settings panel visibility
     */
    toggle() {
        this.isActive = !this.isActive;

        if (this.isActive) {
            this.show();
        } else {
            this.hide();
        }
    }

    /**
     * Show settings panel, hide chat
     */
    show() {
        this.isActive = true;

        // Hide chat panes and input area
        if (this.primaryPane) this.primaryPane.classList.add('hidden');
        if (this.verifierPane) this.verifierPane.classList.add('hidden');
        if (this.splitDivider) this.splitDivider.classList.add('hidden');
        const inputArea = document.getElementById('input-area');
        if (inputArea) inputArea.classList.add('hidden');
        const messagesWrapper = document.getElementById('messages-wrapper');
        if (messagesWrapper) messagesWrapper.classList.add('hidden');

        // Show settings panel
        if (this.panel) this.panel.classList.add('active');

        // Update toggle button state
        if (this.toggleBtn) this.toggleBtn.classList.add('active');

        // Sync currency dropdown with saved preference
        const currencySelect = document.getElementById('currency-select');
        if (currencySelect) {
            currencySelect.value = this.selectedCurrency;
        }

        // Load data for the currently active tab so stale content isn't shown
        this.loadUsageData();
        this.loadApiKeys();
        if (this.activeTab === 'memory') {
            this.loadMemory();
        } else if (this.activeTab === 'mcp') {
            this.loadMCPData();
        } else if (this.activeTab === 'account') {
            this.loadAccountData();
        }
    }

    /**
     * Hide settings panel, show chat
     */
    hide() {
        this.isActive = false;

        // Hide settings panel
        if (this.panel) this.panel.classList.remove('active');

        // Update toggle button state
        if (this.toggleBtn) this.toggleBtn.classList.remove('active');

        // Only restore chat elements if workflow view is NOT active
        const workflowActive = window.agentTeamsPanel?.isActive;
        if (!workflowActive) {
            if (this.primaryPane) this.primaryPane.classList.remove('hidden');
            const inputArea = document.getElementById('input-area');
            if (inputArea) inputArea.classList.remove('hidden');
            const messagesWrapper = document.getElementById('messages-wrapper');
            if (messagesWrapper) messagesWrapper.classList.remove('hidden');
        }
    }

    /**
     * Load usage statistics from backend
     */
    async loadUsageData() {
        try {
            // Show loading state
            if (this.usageGrid) {
                this.usageGrid.innerHTML = `
                    <div class="text-center text-gray-400 text-sm py-8">
                        <svg class="w-6 h-6 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Loading usage data...
                    </div>
                `;
            }

            // Get user ID from auth manager
            const userId = this.getUserId();

            const response = await fetch(`${this.apiBaseUrl}/settings/usage`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.success) {
                this.usageData = data.usage;
                this.renderUsageStats(data.usage);
            } else {
                throw new Error(data.error || 'Failed to load usage data');
            }
        } catch (error) {
            console.error('Error loading usage data:', error);
            this.renderUsageError(error.message);
        }
    }

    /**
     * Render usage statistics cards
     */
    renderUsageStats(usage) {
        if (!this.usageGrid) return;

        // Get current currency info
        const currency = this.exchangeRates[this.selectedCurrency];
        const rate = currency.rate;

        // Calculate total cost
        let totalCost = 0;
        const providerUsage = usage.by_provider || {};

        // Build cards HTML
        let cardsHtml = '';

        for (const provider of this.providers) {
            const data = providerUsage[provider] || {
                month_requests: 0,
                month_tokens: 0,
                month_cost_usd: 0
            };

            const costUsd = parseFloat(data.month_cost_usd) || 0;
            totalCost += costUsd;

            // Get pricing info for this provider and convert to selected currency
            const pricing = this.pricing[provider] || { input: 0, output: 0, model: '' };
            const inputPrice = (pricing.input * rate).toFixed(2);
            const outputPrice = (pricing.output * rate).toFixed(2);
            const pricingText = `${currency.symbol}${inputPrice}/${currency.symbol}${outputPrice} per 1M`;

            // Convert cost to selected currency
            const costConverted = costUsd * rate;

            // Get input/output tokens
            const inputTokens = data.month_input_tokens || 0;
            const outputTokens = data.month_output_tokens || 0;
            const totalTokens = inputTokens + outputTokens;

            cardsHtml += `
                <div class="usage-card ${provider}">
                    <div class="usage-card-header">${this.getProviderDisplayName(provider)}</div>
                    <div class="usage-card-model">${pricing.model}</div>
                    <div class="usage-card-stat">
                        <span>Requests</span>
                        <span>${this.formatNumber(data.month_requests || 0)}</span>
                    </div>
                    <div class="usage-card-stat">
                        <span>Input Tokens</span>
                        <span>${this.formatNumber(inputTokens)}</span>
                    </div>
                    <div class="usage-card-stat">
                        <span>Output Tokens</span>
                        <span>${this.formatNumber(outputTokens)}</span>
                    </div>
                    <div class="usage-card-stat">
                        <span>Total Tokens</span>
                        <span>${this.formatNumber(totalTokens)}</span>
                    </div>
                    <div class="usage-card-stat">
                        <span>Avg Response</span>
                        <span>${data.avg_response_time ? Math.round(data.avg_response_time) + 'ms' : 'N/A'}</span>
                    </div>
                    <div class="usage-card-pricing">
                        <span>Rate (in/out)</span>
                        <span>${pricingText}</span>
                    </div>
                    <div class="usage-card-cost">
                        <span class="cost-label">Month Cost</span>
                        <span class="cost-value">${currency.symbol}${costConverted.toFixed(2)} ${currency.name}</span>
                    </div>
                </div>
            `;
        }

        this.usageGrid.innerHTML = cardsHtml;

        // Update total cost with selected currency
        const totalConverted = totalCost * rate;
        if (this.totalCostEl) {
            this.totalCostEl.textContent = `${currency.symbol}${totalConverted.toFixed(2)} ${currency.name}`;
        }

        // Update month label
        if (this.monthLabelEl) {
            const now = new Date();
            const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' });
            this.monthLabelEl.textContent = monthName;
        }

        // Render usage chart
        this.renderUsageChart(usage, currency);
    }

    /**
     * Render usage histogram chart
     */
    renderUsageChart(usage, currency) {
        const canvas = document.getElementById('usage-chart');
        if (!canvas || typeof Chart === 'undefined') return;

        const ctx = canvas.getContext('2d');
        const providerUsage = usage.by_provider || {};

        // Destroy existing chart if any
        if (this.usageChart) {
            this.usageChart.destroy();
        }

        // Prepare data for chart
        const labels = [];
        const costData = [];
        const tokenData = [];

        for (const provider of this.providers) {
            const data = providerUsage[provider];
            // Include providers with any activity (requests, tokens, or cost)
            if (data && (data.month_requests > 0 || data.month_cost_usd > 0 || data.month_tokens > 0)) {
                labels.push(this.getProviderDisplayName(provider));
                costData.push((parseFloat(data.month_cost_usd) || 0) * currency.rate);
                tokenData.push((parseInt(data.month_tokens) || 0) / 1000); // Show in thousands
            }
        }

        // If no data, show message
        if (labels.length === 0) {
            ctx.font = '14px sans-serif';
            ctx.fillStyle = '#9ca3af';
            ctx.textAlign = 'center';
            ctx.fillText('No usage data to display', canvas.width / 2, canvas.height / 2);
            return;
        }

        // Create chart
        this.usageChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: `Cost (${currency.name})`,
                        data: costData,
                        backgroundColor: 'rgba(59, 130, 246, 0.7)',
                        borderColor: 'rgb(59, 130, 246)',
                        borderWidth: 1,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Tokens (K)',
                        data: tokenData,
                        backgroundColor: 'rgba(107, 114, 128, 0.3)',
                        borderColor: 'rgb(107, 114, 128)',
                        borderWidth: 1,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            boxWidth: 12,
                            padding: 10,
                            font: { size: 11 }
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                if (context.datasetIndex === 0) {
                                    return `Cost: ${currency.symbol}${context.raw.toFixed(2)} ${currency.name}`;
                                } else {
                                    return `Tokens: ${(context.raw * 1000).toLocaleString()}`;
                                }
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: `Cost (${currency.symbol})`,
                            font: { size: 11 }
                        },
                        ticks: {
                            callback: (value) => currency.symbol + value.toFixed(2)
                        }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Tokens (K)',
                            font: { size: 11 }
                        },
                        grid: {
                            drawOnChartArea: false
                        }
                    }
                }
            }
        });
    }

    /**
     * Render error state for usage stats
     */
    renderUsageError(message) {
        if (!this.usageGrid) return;

        this.usageGrid.innerHTML = `
            <div class="text-center text-red-500 text-sm py-8">
                <svg class="w-8 h-8 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                </svg>
                <p>Failed to load usage data</p>
                <p class="text-xs text-gray-400 mt-1">${message}</p>
            </div>
        `;
    }

    /**
     * Populate model selector dropdowns and wire up change events
     */
    populateModelSelectors() {
        for (const provider of this.providers) {
            const selectEl = document.getElementById(`model-select-${provider}`);
            if (!selectEl) continue;

            const models = this.modelCatalog[provider] || [];
            selectEl.innerHTML = '';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = `${m.label} — $${m.input}/$${m.output} per M`;
                selectEl.appendChild(opt);
            }

            // Show info for the default (first) model
            this.updateModelInfo(provider, models[0]?.id);

            // On change, update the description
            selectEl.addEventListener('change', () => {
                this.updateModelInfo(provider, selectEl.value);
            });
        }
    }

    /**
     * Update the model description + cost text next to the dropdown
     */
    updateModelInfo(provider, modelId) {
        const infoEl = document.getElementById(`model-info-${provider}`);
        if (!infoEl) return;

        const models = this.modelCatalog[provider] || [];
        const m = models.find(x => x.id === modelId);
        if (!m) {
            // Model isn't in the static catalog. This is normal when the
            // admin has configured a model in Global Settings that hasn't
            // been added to backend/resources/model_catalog.json yet.
            // Render a transparent placeholder so the user-facing panel
            // still reflects ground truth (the actual configured model)
            // rather than blanking out and creating a mismatch with the
            // admin panel.
            if (modelId) {
                infoEl.innerHTML = `<span class="model-desc" style="color:#aa6;">Model "${modelId}" is configured by admin but is not in the local catalog \u2014 description and pricing data unavailable.</span>`;
            } else {
                infoEl.innerHTML = '';
            }
            return;
        }

        infoEl.innerHTML = `<span class="model-desc">${m.desc}</span><br><span class="model-cost">$${m.input}/M in \u00b7 $${m.output}/M out</span>`;
    }

    /**
     * Load user's custom API keys from backend
     */
    async loadApiKeys() {
        try {
            const userId = this.getUserId();

            const response = await fetch(`${this.apiBaseUrl}/settings/keys`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.success) {
                this.userKeys = data.keys || {};
                this.userModels = data.models || {};
                this.userSystemPrompts = data.system_prompts || {};
                // Per-provider lock + package model fallback. The model
                // dropdown is locked when the user is on the package's API
                // key (locked[provider] === true); the package's default
                // model is what actually runs in chat, so we display it
                // even if the user has nothing saved.
                this.providerLocked = data.locked || {};
                this.packageModels = data.package_models || {};
                this.renderApiKeyStatuses();
                this.renderModelSelections();
                this.renderSystemPrompts();
            }
        } catch (error) {
            console.error('Error loading API keys:', error);
        }
    }

    /**
     * Prefill the per-provider system-prompt textareas with the user's saved
     * overrides. Empty / missing means "no override → admin default applies".
     */
    renderSystemPrompts() {
        for (const provider of this.providers) {
            const ta = document.getElementById(`system-prompt-${provider}`);
            if (!ta) continue;
            ta.value = (this.userSystemPrompts && this.userSystemPrompts[provider]) || '';
        }
    }

    /**
     * Apply saved model selections to dropdowns. When a provider is locked
     * (user is on the package key), force the dropdown to the package's
     * default_model, disable it, and show a hint. The user's saved selection
     * is intentionally not displayed because it would not be applied on the
     * chat path — admin pays, admin picks the model.
     */
    renderModelSelections() {
        const locked = this.providerLocked || {};
        const pkgModels = this.packageModels || {};
        for (const provider of this.providers) {
            const selectEl = document.getElementById(`model-select-${provider}`);
            if (!selectEl) continue;

            const isLocked = !!locked[provider];
            const pkgModel = pkgModels[provider] || null;

            // Defensive option-add: if the package's configured model isn't
            // in the static catalog (e.g. admin switched the global to
            // `grok-4-1-fast-reasoning` but the catalog file only lists
            // older variants, OR the catalog was loaded before the model
            // was added), the dropdown won't have an <option> for it and
            // selectEl.value = pkgModel silently falls back to the first
            // option. That's how the admin-configured "grok-4-1-fast-
            // reasoning" appears as "Grok-3" in the user panel — the user
            // is shown a different model than what actually runs.
            // Inject a synthetic option for the package model so the
            // dropdown always reflects ground truth.
            if (isLocked && pkgModel) {
                const hasOption = Array.from(selectEl.options).some(opt => opt.value === pkgModel);
                if (!hasOption) {
                    const opt = document.createElement('option');
                    opt.value = pkgModel;
                    opt.textContent = `${pkgModel} (configured by admin)`;
                    selectEl.insertBefore(opt, selectEl.firstChild);
                }
            }

            if (isLocked && pkgModel) {
                selectEl.value = pkgModel;
                selectEl.disabled = true;
                selectEl.title = 'Using package key — enter your own API key above to choose a different model.';
            } else {
                selectEl.disabled = false;
                selectEl.title = '';
                const savedModel = this.userModels[provider];
                if (savedModel) {
                    selectEl.value = savedModel;
                }
            }

            // Recompute this.pricing[provider] from the model that's
            // actually going to run, not the catalog's first entry.
            // This is what powers the Usage-tab card's `pricing.model`
            // and `pricing.input/output` readouts. Without this, the
            // Usage tab can show "Grok-3 — $3.00/$15.00" while admin has
            // configured `grok-4-1-fast-reasoning` at $0.20/$0.50 — a
            // misleading bill estimate that does not match reality.
            const activeModelId = selectEl.value;
            const catalogEntry = (this.modelCatalog[provider] || [])
                .find(m => m.id === activeModelId);
            if (catalogEntry) {
                this.pricing[provider] = {
                    input: catalogEntry.input,
                    output: catalogEntry.output,
                    model: catalogEntry.label,
                };
            } else if (activeModelId) {
                // Catalog has no entry for the active model (e.g. admin
                // configured a model the catalog doesn't list). Show the
                // raw model id and zero pricing so it's obvious to the
                // user/admin that pricing data is missing for this model
                // — better than silently displaying wrong numbers from
                // some unrelated catalog entry.
                this.pricing[provider] = {
                    input: 0,
                    output: 0,
                    model: `${activeModelId} (not in catalog — pricing unknown)`,
                };
            }

            this.renderModelLockHint(provider, isLocked, pkgModel);
            this.updateModelInfo(provider, selectEl.value);
        }
    }

    /**
     * Render a small inline note next to the model dropdown when locked.
     * Idempotent — safe to call on every renderModelSelections() pass.
     */
    renderModelLockHint(provider, isLocked, pkgModel) {
        const hintId = `model-lock-hint-${provider}`;
        let hintEl = document.getElementById(hintId);
        const selectEl = document.getElementById(`model-select-${provider}`);
        if (!selectEl) return;

        if (isLocked && pkgModel) {
            if (!hintEl) {
                hintEl = document.createElement('div');
                hintEl.id = hintId;
                hintEl.className = 'model-lock-hint';
                hintEl.style.cssText = 'font-size:0.8em;color:#666;margin-top:4px;';
                selectEl.parentNode.insertBefore(hintEl, selectEl.nextSibling);
            }
            hintEl.textContent = '🔒 Locked to package model — enter your own API key to customize.';
        } else if (hintEl) {
            hintEl.remove();
        }
    }

    /**
     * Update API key status indicators
     */
    renderApiKeyStatuses() {
        for (const provider of this.providers) {
            const statusEl = document.getElementById(`key-status-${provider}`);
            const inputEl = document.getElementById(`api-key-${provider}`);

            if (statusEl && inputEl) {
                const hasCustomKey = this.userKeys[provider] && this.userKeys[provider].has_custom_key;

                if (hasCustomKey) {
                    statusEl.textContent = 'Custom';
                    statusEl.classList.remove('default');
                    statusEl.classList.add('custom');
                    inputEl.placeholder = '****' + (this.userKeys[provider].masked_key || '');
                } else {
                    statusEl.textContent = 'Default';
                    statusEl.classList.remove('custom');
                    statusEl.classList.add('default');
                }
            }
        }
    }

    /**
     * Save custom API keys to backend
     */
    async saveApiKeys() {
        try {
            const userId = this.getUserId();
            const keys = {};

            // Collect non-empty keys
            for (const provider of this.providers) {
                const inputEl = document.getElementById(`api-key-${provider}`);
                if (inputEl && inputEl.value.trim()) {
                    keys[provider] = inputEl.value.trim();
                }
            }

            // Collect model selections. Skip providers locked to the package
            // model — saving that value would freeze the package's current
            // default into user_model_selections and break the admin's
            // ability to change the package model later.
            const models = {};
            const locked = this.providerLocked || {};
            for (const provider of this.providers) {
                if (locked[provider]) continue;
                const selectEl = document.getElementById(`model-select-${provider}`);
                if (selectEl) {
                    models[provider] = selectEl.value;
                }
            }

            // Collect per-provider system-prompt overrides. Always include
            // every provider so the user can clear an override by emptying
            // the textarea — the backend treats '' as "clear" (NULL column).
            const systemPrompts = {};
            for (const provider of this.providers) {
                const ta = document.getElementById(`system-prompt-${provider}`);
                if (ta) {
                    systemPrompts[provider] = ta.value.trim();
                }
            }

            if (Object.keys(keys).length === 0
                && Object.keys(models).length === 0
                && Object.keys(systemPrompts).length === 0) {
                this.showNotification('No changes to save', 'warning');
                return;
            }

            const response = await fetch(`${this.apiBaseUrl}/settings/keys`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({
                    keys: keys,
                    models: models,
                    system_prompts: systemPrompts
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.success) {
                this.showNotification('API keys saved successfully', 'success');

                // Clear input fields
                for (const provider of this.providers) {
                    const inputEl = document.getElementById(`api-key-${provider}`);
                    if (inputEl) inputEl.value = '';
                }

                // Reload key statuses
                this.loadApiKeys();
            } else {
                throw new Error(data.error || 'Failed to save API keys');
            }
        } catch (error) {
            console.error('Error saving API keys:', error);
            this.showNotification('Failed to save API keys: ' + error.message, 'error');
        }
    }

    /**
     * Clear all custom API keys
     */
    async clearApiKeys() {
        if (!confirm('Are you sure you want to remove all custom API keys? This will revert to using the default shared keys.')) {
            return;
        }

        try {
            const userId = this.getUserId();

            const response = await fetch(`${this.apiBaseUrl}/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getAuthToken()}`
                },
                body: JSON.stringify({
                    action: 'clear_keys',
                    user_id: userId
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            if (data.success) {
                this.showNotification('All custom API keys cleared', 'success');
                this.userKeys = {};
                this.renderApiKeyStatuses();

                // Clear input fields
                for (const provider of this.providers) {
                    const inputEl = document.getElementById(`api-key-${provider}`);
                    if (inputEl) inputEl.value = '';
                }
            } else {
                throw new Error(data.error || 'Failed to clear API keys');
            }
        } catch (error) {
            console.error('Error clearing API keys:', error);
            this.showNotification('Failed to clear API keys: ' + error.message, 'error');
        }
    }

    /**
     * Get current user ID from AuthManager
     */
    getUserId() {
        if (window.authManager && window.authManager.user) {
            return window.authManager.user.id || window.authManager.user.uid || 'demo-user';
        }
        return 'demo-user';
    }

    /**
     * Get auth token from AuthManager
     */
    getAuthToken() {
        if (window.authManager) {
            return window.authManager.token || '';
        }
        return localStorage.getItem('token') || '';
    }

    /**
     * Get display name for provider
     */
    getProviderDisplayName(provider) {
        const names = {
            'claude': 'Claude (Anthropic)',
            'openai': 'OpenAI (GPT)',
            'kimi': 'Kimi (Moonshot)',
            'gemini': 'Gemini (Google)',
            'grok': 'Grok (xAI)',
            'deepseek': 'DeepSeek'
        };
        return names[provider] || provider;
    }

    /**
     * Format number with commas
     */
    formatNumber(num) {
        return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /**
     * Show notification toast
     */
    showNotification(message, type = 'info') {
        // Create notification element.
        // Inline z-index overrides Tailwind's z-50 so the toast appears above
        // the settings panel overlay (#settings-panel uses z-index: 100).
        const notification = document.createElement('div');
        notification.className = `fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg text-white text-sm transition-all transform translate-y-0 opacity-100`;
        notification.style.zIndex = '10000';

        // Set color based on type
        const colors = {
            success: 'bg-green-600',
            error: 'bg-red-600',
            warning: 'bg-amber-600',
            info: 'bg-blue-600'
        };
        notification.classList.add(colors[type] || colors.info);

        notification.textContent = message;
        document.body.appendChild(notification);

        // Animate out and remove after 3 seconds
        setTimeout(() => {
            notification.classList.add('opacity-0', 'translate-y-2');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.settingsPanel = new SettingsPanel();
});
