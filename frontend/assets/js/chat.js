/**
 * AI Portfolio Assistant - Chat Interface (Optimized)
 * Supports multiple AI providers with one-click switching
 *
 * Optimizations:
 * - Request cancellation with AbortController
 * - Audio queue system for EVI
 * - Memory management for audio playback
 * - Optimized MediaRecorder settings
 * - Connection health monitoring
 * - Automatic reconnection logic
 */

// Load marker — confirms which chat.js the browser is actually running.
// If you do NOT see this line in the console, the browser is serving a CACHED
// old chat.js (hard-reload, Cmd-Shift-R, to fetch the versioned file).
console.log('%c[chat.js] LOADED build 20260612-writtenoutputs', 'color:#063;font-weight:bold');

class ChatApp {
    // Per-file upload cap, in bytes. Must stay <= the matching limit in
    // backend/.htaccess (`upload_max_filesize` / `post_max_size`) AND
    // backend/src/Controllers/ChatAttachmentController::MAX_BYTES, otherwise
    // an upload that passes the client check still 413s server-side.
    static MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

    constructor() {
        // DOM Elements (cached for performance)
        this.messagesContainer = document.getElementById('messages');
        this.userInput = document.getElementById('user-input');
        this.sendBtn = document.getElementById('send-btn');
        this.stopBtn = document.getElementById('stop-btn');
        this.attachFileBtn = document.getElementById('attach-file-btn');
        this.attachFileInput = document.getElementById('attach-file-input');
        this.savePromptBtn = document.getElementById('save-prompt-btn');
        this.attachmentsStrip = document.getElementById('attachments-strip');
        this.clearBtn = document.getElementById('clear-chat');
        this.progressBar = document.getElementById('progress-bar');
        this.progressText = document.getElementById('progress-text');
        this.providerName = document.getElementById('provider-name');
        this.functionCount = document.getElementById('function-count');
        this.tokenInfo = document.getElementById('token-info');
        this.functionsModal = document.getElementById('functions-modal');
        this.functionsList = document.getElementById('functions-list');
        this.showFunctionsBtn = document.getElementById('show-functions');
        this.closeModalBtn = document.getElementById('close-modal');
        this.contextModal = document.getElementById('context-modal');
        this.contextList = document.getElementById('context-list');
        this.contextJson = document.getElementById('context-json');
        this.contextJsonContent = document.getElementById('context-json-content');
        this.contextStats = document.getElementById('context-stats');
        this.showContextBtn = document.getElementById('show-context');
        this.closeContextModalBtn = document.getElementById('close-context-modal');
        this.contextCopyBtn = document.getElementById('context-copy-btn');
        this.contextTabButtons = document.querySelectorAll('.context-tab-btn');
        this.activeContextTab = 'array';
        this.providerButtons = document.getElementById('provider-buttons');
        this.mergeConversationsCheckbox = document.getElementById('merge-conversations');

        // Sidebar elements
        this.contextsSidebar = document.getElementById('contexts-sidebar');
        this.contextsList = document.getElementById('contexts-list');
        this.sidebarToggle = document.getElementById('sidebar-toggle');
        this.sidebarToggleIcon = document.getElementById('sidebar-toggle-icon');
        this.sidebarToggleTop = document.getElementById('sidebar-toggle-top');
        this.sidebarToggleTopIcon = document.getElementById('sidebar-toggle-top-icon');
        this.newChatBtn = document.getElementById('new-chat-btn');
        this.mobileSidebarBackdrop = document.getElementById('mobile-sidebar-backdrop');
        this.toolsToggleBtn = document.getElementById('tools-toggle-btn');

        // Prompt Library elements
        this.navConversations = document.getElementById('nav-conversations');
        this.navPromptLibrary = document.getElementById('nav-prompt-library');
        this.conversationsView = document.getElementById('conversations-view');
        this.promptLibraryView = document.getElementById('prompt-library-view');
        this.promptTree = document.getElementById('prompt-tree');
        this.promptContextMenu = document.getElementById('prompt-context-menu');

        // Verifier elements
        this.navVerifier = document.getElementById('nav-verifier');
        this.verifierView = document.getElementById('verifier-view');
        this.verifierToggle = document.getElementById('verifier-toggle');
        this.verifierLLMList = document.getElementById('verifier-llm-list');
        this.verifierStatus = document.getElementById('verifier-status');
        this.verifierSelectedName = document.getElementById('verifier-selected-name');
        this.verifierNewChatBtn = document.getElementById('verifier-new-chat-btn');
        this.verifierClearChatBtn = document.getElementById('verifier-clear-chat-btn');

        // Compare elements
        this.navCompare = document.getElementById('nav-compare');
        this.compareView = document.getElementById('compare-view');

        // Skills elements
        this.navSkills = document.getElementById('nav-skills');
        this.skillsView = document.getElementById('skills-view');

        // Agent Teams elements
        this.navAgentTeams = document.getElementById('nav-agent-teams');
        this.agentTeamsView = document.getElementById('agent-teams-view');

        // Agents library elements
        this.navAgents = document.getElementById('nav-agents');
        this.agentsView = document.getElementById('agents-view');

        // File Storage elements
        this.navFileStorage = document.getElementById('nav-file-storage');
        this.fileStorageView = document.getElementById('file-storage-view');
        this.compareToggle = document.getElementById('compare-toggle');
        this.compareLLMList = document.getElementById('compare-llm-list');
        this.compareStatus = document.getElementById('compare-status');
        this.compareSelectedName = document.getElementById('compare-selected-name');
        this.compareNewChatBtn = document.getElementById('compare-new-chat-btn');
        this.compareClearChatBtn = document.getElementById('compare-clear-chat-btn');

        // Split-pane elements
        this.messagesWrapper = document.getElementById('messages-wrapper');
        this.primaryPane = document.getElementById('primary-pane');
        this.primaryPaneHeader = document.getElementById('primary-pane-header');
        this.primaryProviderBadge = document.getElementById('primary-provider-badge');
        this.toggleRawBtn = document.getElementById('toggle-raw-btn');
        this.toggleRawLabel = document.getElementById('toggle-raw-label');
        this.verifyLastBtn = document.getElementById('verify-last-btn');
        this.compareLastBtn = document.getElementById('compare-last-btn');
        this.splitPaneDivider = document.getElementById('split-pane-divider');
        // Separate divider used only in compare-artifacts 2-iframe mode
        // (between #artifact-pane and #compare-artifact-pane). Initialized
        // in initCompareArtifactsDivider() below.
        this.compareArtifactsDivider = document.getElementById('compare-artifacts-divider');
        this.verifierPane = document.getElementById('verifier-pane');
        this.verifierPaneHeader = document.getElementById('verifier-pane-header');
        this.verifierProviderBadge = document.getElementById('verifier-provider-badge');
        this.verifierMessagesContainer = document.getElementById('verifier-messages');
        this.verifierPlaceholder = document.getElementById('verifier-placeholder');

        // Compare pane elements
        this.comparePane = document.getElementById('compare-pane');
        this.comparePaneHeader = document.getElementById('compare-pane-header');
        this.compareProviderBadge = document.getElementById('compare-provider-badge');
        this.compareMessagesContainer = document.getElementById('compare-messages');
        this.comparePlaceholder = document.getElementById('compare-placeholder');

        // Artifact pane (B3 skill outputs) — opens automatically when a
        // folder-backed skill writes a renderable file (HTML/MD).
        this.artifactPane = document.getElementById('artifact-pane');
        this.artifactPanePath = document.getElementById('artifact-path');
        this.artifactPaneContent = document.getElementById('artifact-content');
        // Compare artifact pane (4th pane): the comparer's skill output.
        // Sibling of artifactPane; rendered when the comparer's
        // run_skill_script produces a renderable file in compare mode.
        this.compareArtifactPane = document.getElementById('compare-artifact-pane');
        this.compareArtifactPanePath = document.getElementById('compare-artifact-path');
        this.compareArtifactPaneContent = document.getElementById('compare-artifact-content');
        // Elapsed-time badges shown in each pane's header. Populated
        // when the iframe replaces the spinner (i.e. when pyodide
        // finishes for that provider). Hidden by default.
        this.artifactElapsedBadge = document.getElementById('artifact-elapsed');
        this.compareArtifactElapsedBadge = document.getElementById('compare-artifact-elapsed');
        this.artifactTokensBadge = document.getElementById('artifact-tokens');
        this.compareArtifactTokensBadge = document.getElementById('compare-artifact-tokens');
        this.artifactProviderBadge = document.getElementById('artifact-provider');
        this.compareArtifactProviderBadge = document.getElementById('compare-artifact-provider');
        this.compareArtifactCloseBtn = document.getElementById('compare-artifact-close-btn');
        if (this.compareArtifactCloseBtn) {
            this.compareArtifactCloseBtn.addEventListener('click', () => this.hideCompareArtifactPane());
        }
        this.artifactCloseBtn = document.getElementById('artifact-close-btn');
        if (this.artifactCloseBtn) {
            this.artifactCloseBtn.addEventListener('click', () => this.hideArtifactPane());
        }

        // Conversation context menu
        this.conversationContextMenu = document.getElementById('conversation-context-menu');
        this.currentConversationMenuId = null;

        // EVI elements
        this.eviStatus = document.getElementById('evi-status');
        this.eviIcon = document.getElementById('evi-icon');
        this.eviStateText = document.getElementById('evi-state-text');
        this.eviHintText = document.getElementById('evi-hint-text');
        this.eviToggleBtn = document.getElementById('evi-toggle-connection');
        this.eviReturnHomeBtn = document.getElementById('evi-return-home');
        this.inputArea = this.userInput.closest('.border-t');

        // State
        this.conversationHistory = [];
        this.isLoading = false;
        this.functions = [];
        this.totalTokens = 0;
        this.providers = [];
        this.currentProvider = 'claude';

        // Context management state
        this.currentContextId = null;
        this.contexts = [];
        this.sidebarCollapsed = false;

        // Active skill dragged onto the prompt input.
        // One skill at a time. Cleared on page reload (no persistence).
        // Shape: { id, name, skill_content } or null.
        this.activeSkill = null;

        // Files queued by the user via the paperclip picker or drag-drop.
        // Phase 1: client-side only — each entry is a raw File object.
        // Phase 2 will replace File entries with { id, name, mime, size }
        // after upload. Cleared after a successful send.
        this.pendingAttachments = [];

        // Prompt Library state
        this.promptLibrary = [];
        this.expandedFolders = new Set();
        this.currentView = 'conversations'; // 'conversations' or 'prompts'
        this.currentPromptId = null;
        this.currentPromptName = null;
        // Currently-selected folder in the Prompt Library tree (clicking a
        // folder selects it). Used by the Save Prompt button to choose
        // where to save. null = root.
        this.selectedPromptFolderId = null;
        this.editingNodeId = null;
        this.contextMenuNode = null;

        // Request management
        this.abortController = null;

        // Raw/Rendered toggle state
        this.isRawMode = false;

        // EVI state (optimized)
        this.eviSocket = null;
        this.eviConnected = false;
        this.eviMediaRecorder = null;
        this.eviMediaStream = null;
        this.eviAudioElement = null;
        this.eviAudioQueue = []; // Audio queue for smooth playback
        this.eviIsPlaying = false;
        this.eviToolExecuting = false; // Flag to track tool execution state
        this.eviReconnectAttempts = 0;
        this.eviMaxReconnectAttempts = 3;
        this.eviManualDisconnect = false; // Flag to prevent auto-reconnect on manual disconnect

        // Verifier state
        this.selectedVerifier = null;         // Selected verifier LLM name
        this.verificationEnabled = false;     // Toggle state

        // Compare state
        this.selectedComparer = null;         // Selected compare LLM name
        this.compareEnabled = false;          // Toggle state

        // Split pane state
        this.splitPaneActive = false;
        this.splitPaneRatio = 0.5;            // Default 50/50 split
        this.isResizingSplitPane = false;
        this.activeSplitMode = null;          // 'verifier' or 'compare' - tracks which mode is active

        // Verifier streaming state (mirrors primary streaming state)
        this.verifierParserState = null;
        this.verifierBuffer = '';
        this.verifierDisplayHtml = '';
        this.verifierFullContent = '';
        this.verifierCarryOver = '';
        this.verifierCurrentCodeBlockPlaceholder = null;

        // Compare streaming state (mirrors primary streaming state)
        this.compareParserState = null;
        this.compareBuffer = '';
        this.compareDisplayHtml = '';
        this.compareFullContent = '';
        this.compareCarryOver = '';
        this.compareCurrentCodeBlockPlaceholder = null;

        // MCP state
        this.mcpEnabled = true;  // Enable MCP by default
        this.mcpAppContainer = null;
        this.mcpIframes = new Map(); // iframe contentWindow -> { serverUrl, toolName, containerId }

        // Provider styles
        this.providerStyles = {
            claude: { bg: 'bg-purple-600', hover: 'hover:bg-purple-700', text: 'text-white', icon: '🟣' },
            openai: { bg: 'bg-green-600', hover: 'hover:bg-green-700', text: 'text-white', icon: '🟢' },
            kimi: { bg: 'bg-blue-500', hover: 'hover:bg-blue-600', text: 'text-white', icon: '🔵' },
            grok: { bg: 'bg-gray-800', hover: 'hover:bg-gray-900', text: 'text-white', icon: '⚫' },
            gemini: { bg: 'bg-cyan-500', hover: 'hover:bg-cyan-600', text: 'text-white', icon: '💎' },
            deepseek: { bg: 'bg-indigo-700', hover: 'hover:bg-indigo-800', text: 'text-white', icon: '🧠' },
            evi: { bg: 'bg-orange-600', hover: 'hover:bg-orange-700', text: 'text-white', icon: '🎙️' },
            default: { bg: 'bg-indigo-600', hover: 'hover:bg-indigo-700', text: 'text-white', icon: '🤖' }
        };

        // Disable UI initially until auth is verified
        this.setUIEnabled(false);

        // Configure marked.js globally for GFM table support
        this.configureMarked();

        this.init();
    }

    configureMarked() {
        // Configure marked for GitHub Flavored Markdown with table support
        marked.setOptions({
            gfm: true,
            breaks: true,
            tables: true,
            headerIds: false,
            pedantic: false,
            sanitize: false
        });
    }

    /**
     * Get authorization headers for API requests
     * @returns {Object} Headers object with Authorization and Content-Type
     */
    getAuthHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (window.authManager && window.authManager.token) {
            headers['Authorization'] = `Bearer ${window.authManager.token}`;
        }
        return headers;
    }

    async init() {
        // Wait for authentication verification before initializing
        if (window.authManager && window.authManager.authPromise) {
            try {
                await window.authManager.authPromise;
                if (!window.authManager.authVerified) {
                    // Auth failed, page will redirect to login
                    return;
                }
            } catch (error) {
                console.error('Authentication verification failed:', error);
                return;
            }
        }

        await window.i18n.init();

        const languageSwitcherContainer = document.getElementById('language-switcher-container');
        if (languageSwitcherContainer) {
            languageSwitcherContainer.appendChild(window.i18n.createLanguageSwitcher());
        }

        window.i18n.onLanguageChange((lang) => this.onLanguageChanged(lang));

        // Event listeners
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        if (this.stopBtn) {
            this.stopBtn.addEventListener('click', () => this.abortCurrentMessage());
        }
        if (this.savePromptBtn) {
            this.savePromptBtn.addEventListener('click', () => this.savePromptToSelectedCollection());
        }

        this.initSkillDropZone();
        this.initAttachmentPicker();
        this.initFileDropZone();
        this.clearBtn.addEventListener('click', () => this.clearChat());
        this.showFunctionsBtn.addEventListener('click', () => this.showFunctionsModal());
        this.closeModalBtn.addEventListener('click', () => this.hideFunctionsModal());
        if (this.showContextBtn) {
            this.showContextBtn.addEventListener('click', () => this.showContextModal());
        }
        if (this.closeContextModalBtn) {
            this.closeContextModalBtn.addEventListener('click', () => this.hideContextModal());
        }
        if (this.contextModal) {
            this.contextModal.addEventListener('click', (e) => {
                if (e.target === this.contextModal) this.hideContextModal();
            });
        }
        if (this.contextCopyBtn) {
            this.contextCopyBtn.addEventListener('click', () => this.copyContextToClipboard());
        }
        if (this.contextTabButtons) {
            this.contextTabButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    this.switchContextTab(btn.dataset.contextTab);
                });
            });
        }
        this.eviToggleBtn.addEventListener('click', () => this.toggleEVIConnection());
        this.eviReturnHomeBtn.addEventListener('click', () => this.returnToHome());
        this.functionsModal.addEventListener('click', (e) => {
            if (e.target === this.functionsModal) this.hideFunctionsModal();
        });

        // Raw/Rendered toggle button
        if (this.toggleRawBtn) {
            this.toggleRawBtn.addEventListener('click', () => this.toggleRawMode());
        }

        // On-demand Verify button (visible when verifier split pane is active)
        if (this.verifyLastBtn) {
            this.verifyLastBtn.addEventListener('click', () => this.verifyLastResponse());
        }

        // On-demand Compare button (visible when compare split pane is active)
        if (this.compareLastBtn) {
            this.compareLastBtn.addEventListener('click', () => this.compareLastPrompt());
        }

        // Sidebar event listeners
        this.sidebarToggle.addEventListener('click', () => this.toggleSidebar());
        this.sidebarToggleTop?.addEventListener('click', () => this.toggleSidebar());
        if (this.toolsToggleBtn) {
            this.toolsToggleBtn.addEventListener('click', () => this.toggleSidebar());
        }
        this.newChatBtn.addEventListener('click', () => this.newChat());

        // Verifier view action buttons
        if (this.verifierNewChatBtn) {
            this.verifierNewChatBtn.addEventListener('click', () => this.newChat());
        }
        if (this.verifierClearChatBtn) {
            this.verifierClearChatBtn.addEventListener('click', () => this.clearChat());
        }

        // Compare view action buttons
        if (this.compareNewChatBtn) {
            this.compareNewChatBtn.addEventListener('click', () => this.newChat());
        }
        if (this.compareClearChatBtn) {
            this.compareClearChatBtn.addEventListener('click', () => this.clearChat());
        }

        // Mobile backdrop click to close sidebar
        if (this.mobileSidebarBackdrop) {
            this.mobileSidebarBackdrop.addEventListener('click', () => {
                if (!this.sidebarCollapsed) {
                    this.toggleSidebar();
                }
            });
        }

        this.userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Prompt Library event listeners
        this.navConversations.addEventListener('click', () => this.switchView('conversations'));
        this.navPromptLibrary.addEventListener('click', () => this.switchView('prompts'));
        this.navVerifier.addEventListener('click', () => this.switchView('verifier'));
        this.navCompare.addEventListener('click', () => this.switchView('compare'));
        if (this.navAgents) {
            this.navAgents.addEventListener('click', () => this.switchView('agents'));
        }
        if (this.navSkills) {
            this.navSkills.addEventListener('click', () => this.switchView('skills'));
        }
        if (this.navAgentTeams) {
            this.navAgentTeams.addEventListener('click', () => this.switchView('agent-teams'));
        }
        if (this.navFileStorage) {
            this.navFileStorage.addEventListener('click', () => this.switchView('file-storage'));
        }

        // Activity rail (visible when sidebar is collapsed). Each icon expands
        // the sidebar and switches to the matching view; the chevron just
        // expands without changing the current view.
        const railExpand = document.getElementById('rail-expand');
        if (railExpand) {
            railExpand.addEventListener('click', () => {
                if (this.sidebarCollapsed) this.toggleSidebar();
            });
        }
        document.querySelectorAll('#sidebar-rail [data-rail-target]').forEach(btn => {
            btn.addEventListener('click', () => {
                const view = btn.dataset.railTarget;
                if (this.sidebarCollapsed) this.toggleSidebar();
                this.switchView(view);
            });
        });

        // Context menu listeners
        document.addEventListener('click', () => {
            this.hideContextMenu();
            this.hideConversationMenu();
        });
        this.promptContextMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            // closest(): buttons may wrap their label in a <span> (e.g. i18n),
            // so e.target can be the span rather than the button itself —
            // same idiom as the conversation menu listener below.
            const action = e.target.closest('.context-menu-item')?.dataset.action;
            if (action) {
                this.handleContextMenuAction(action);
            }
        });

        // Conversation context menu listeners
        this.conversationContextMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            const button = e.target.closest('.conversation-menu-item');
            if (button) {
                const action = button.dataset.action;
                if (action) {
                    this.handleConversationMenuAction(action);
                }
            }
        });

        // Initialize sidebar state based on screen size
        this.initializeSidebar();

        // Initialize sidebar resize functionality
        this.initSidebarResize();

        // Handle window resize to update sidebar behavior
        window.addEventListener('resize', () => {
            this.updateSidebarForScreenSize();
        });

        this.loadProviders();
        this.loadContextsList();
        this.initVerifierView();
        this.initCompareView();
        this.initSplitPaneDivider();
        this.initCompareArtifactsDivider();
        // Apply the user's role-based package to the sidebar (hide disabled
        // nav items). Runs async; nothing below depends on it.
        this.applyUserPackage();

        // Initialize MCP (async, runs in background)
        this.initMCP();

        // Enable UI after auth verification and initialization complete
        this.setUIEnabled(true);
    }

    /**
     * Fetch the current user's role-based package and hide sidebar nav items
     * the package doesn't allow. Stashed on `this.userPackage` so other code
     * paths (e.g. voice/avatar gating) can consult it.
     *
     * Gracefully no-ops if the endpoint fails — offline / unauthenticated
     * users keep the pre-package UI.
     */
    async applyUserPackage() {
        try {
            const res = await fetch(window.apiUrl('/me/package'), {
                headers: this.getAuthHeaders(),
            });
            if (!res.ok) return;
            const body = await res.json();
            if (!body.success || !body.capabilities) return;

            this.userPackage = body;
            const sidebar = body.capabilities.sidebar || {};

            // Map each sidebar feature key to its nav button id.
            const map = {
                conversations:   'nav-conversations',
                verifier:        'nav-verifier',
                compare:         'nav-compare',
                prompt_library:  'nav-prompt-library',
                skills:          'nav-skills',
                agent_teams:     'nav-agent-teams',
                file_storage:    'nav-file-storage',
            };

            for (const [key, id] of Object.entries(map)) {
                const el = document.getElementById(id);
                if (!el) continue;
                // Absence from the map or explicit `false` hides the button.
                if (sidebar[key] === false) {
                    el.classList.add('hidden');
                } else {
                    el.classList.remove('hidden');
                }
            }
        } catch (err) {
            console.warn('[Chat] applyUserPackage failed:', err);
        }
    }

    /**
     * Initialize MCP client and app container
     */
    async initMCP() {
        // Create MCP app container for embedded apps
        this.mcpAppContainer = document.createElement('div');
        this.mcpAppContainer.id = 'mcp-app-container';
        this.mcpAppContainer.className = 'mcp-app-container';

        // Insert before messages container
        const chatArea = this.messagesContainer?.parentElement;
        if (chatArea) {
            chatArea.insertBefore(this.mcpAppContainer, this.messagesContainer);
        }

        // Setup message bridge for MCP app iframes (JSON-RPC over postMessage)
        this.setupMCPBridge();

        // Wait for MCP client to be ready
        if (window.mcpClient) {
            try {
                await window.mcpClient.initialize();
                console.log('MCP integration ready');
            } catch (error) {
                console.warn('MCP initialization deferred:', error.message);
            }
        }
    }

    /**
     * Setup postMessage bridge for MCP app iframes
     * Handles JSON-RPC 2.0 protocol for ui/initialize, resources/read, tools/call
     */
    setupMCPBridge() {
        window.addEventListener('message', async (event) => {
            // Check if this is a JSON-RPC message from an MCP iframe
            const data = event.data;
            if (!data || typeof data !== 'object') return;
            if (data.jsonrpc !== '2.0') return;

            // Find which iframe sent this message
            let iframeInfo = null;
            for (const [win, info] of this.mcpIframes) {
                if (event.source === win) {
                    iframeInfo = info;
                    break;
                }
            }

            if (!iframeInfo) {
                console.log('[MCP Bridge] Message from unknown iframe, checking containers...');
                // Try to find iframe by checking all MCP UI containers
                const containers = document.querySelectorAll('.mcp-ui-container');
                console.log('[MCP Bridge] Found', containers.length, 'MCP containers');
                for (const container of containers) {
                    const iframe = container.querySelector('iframe');
                    if (iframe) {
                        console.log('[MCP Bridge] Checking iframe:', iframe.dataset.toolName,
                            'contentWindow match:', iframe.contentWindow === event.source);
                    }
                    if (iframe && iframe.contentWindow === event.source) {
                        // Found it - register it now
                        const serverUrl = iframe.dataset.serverUrl;
                        const toolName = iframe.dataset.toolName;
                        if (serverUrl) {
                            let toolArgs = null;
                            let toolResult = null;
                            try {
                                if (iframe.dataset.toolArgs) {
                                    toolArgs = JSON.parse(iframe.dataset.toolArgs);
                                }
                                if (iframe.dataset.toolResult) {
                                    toolResult = JSON.parse(iframe.dataset.toolResult);
                                }
                            } catch (e) {
                                console.warn('[MCP Bridge] Failed to parse tool data:', e);
                            }
                            iframeInfo = { serverUrl, toolName, containerId: container.id, toolArgs, toolResult };
                            this.mcpIframes.set(event.source, iframeInfo);
                            console.log('[MCP Bridge] Late-registered iframe:', toolName, 'args:', toolArgs);
                        }
                        break;
                    }
                }
            }

            if (!iframeInfo) {
                console.log('[MCP Bridge] Could not find iframe for message:', data.method);
                return;
            }

            // Check if this is a notification (no id) vs request (has id)
            const isNotification = data.id === undefined || data.id === null;
            console.log('[MCP Bridge] Received JSON-RPC:', data.method, isNotification ? '(notification)' : `id: ${data.id}`);

            // Handle notifications (no response expected)
            if (isNotification) {
                // Handle size-changed notification to resize iframe
                if (data.method === 'ui/notifications/size-changed') {
                    console.log('[MCP Bridge] 📐 Size-changed notification received:', data.params);
                    console.log('[MCP Bridge] 📐 iframeInfo:', iframeInfo);
                    if (!iframeInfo) {
                        console.error('[MCP Bridge] ❌ No iframeInfo found for size-changed!');
                    }
                    this.handleMCPSizeChanged(event.source, data.params, iframeInfo);
                } else {
                    console.log('[MCP Bridge] Ignoring notification:', data.method);
                }
                return;
            }

            try {
                let result;

                switch (data.method) {
                    case 'ui/initialize':
                        result = this.handleMCPInitialize(data.params, iframeInfo, event.source);
                        break;

                    case 'resources/read':
                        result = await this.handleMCPResourceRead(data.params, iframeInfo);
                        break;

                    case 'tools/call':
                        result = await this.handleMCPToolCall(data.params, iframeInfo);
                        break;

                    case 'ui/message':
                        result = await this.handleMCPMessage(data.params, iframeInfo);
                        break;

                    case 'ui/openLink':
                        result = this.handleMCPOpenLink(data.params);
                        break;

                    case 'ui/request-display-mode':
                        result = this.handleMCPRequestDisplayMode(data.params, iframeInfo);
                        break;

                    default:
                        // Unknown method - only send error for requests, not notifications
                        console.warn('[MCP Bridge] Unknown method:', data.method);
                        this.sendMCPError(event.source, data.id, -32601, `Method not found: ${data.method}`);
                        return;
                }

                // Send success response
                this.sendMCPResponse(event.source, data.id, result);

            } catch (error) {
                console.error('[MCP Bridge] Error handling request:', error);
                const errorMsg = typeof error.message === 'string' ? error.message :
                                (typeof error === 'string' ? error : JSON.stringify(error));
                this.sendMCPError(event.source, data.id, -32000, errorMsg);
            }
        });
    }

    /**
     * Handle ui/initialize request from MCP app
     */
    handleMCPInitialize(params, iframeInfo, eventSource) {
        console.log('[MCP Bridge] Handling ui/initialize for:', iframeInfo.toolName);

        // Schedule sending tool-input and tool-result after init response
        setTimeout(() => {
            this.sendMCPToolNotifications(eventSource, iframeInfo);
        }, 100);

        // Detect platform
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        const platform = isMobile ? 'mobile' : 'web';

        // Get user's locale and timezone
        const locale = navigator.language || 'en-US';
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

        // Detect theme
        const isDark = document.documentElement.classList.contains('dark') ||
                       window.matchMedia('(prefers-color-scheme: dark)').matches;

        return {
            protocolVersion: '2026-01-26',
            hostInfo: {
                name: 'GPT-Chatbot',
                version: '1.0.0'
            },
            hostCapabilities: {
                serverResources: { listChanged: false },
                serverTools: { listChanged: false },
                logging: {},
                message: {},  // Support showing messages to user
                openLinks: {}  // Support opening links
            },
            hostContext: {
                theme: isDark ? 'dark' : 'light',
                locale: locale,
                timeZone: timeZone,
                platform: platform,
                displayMode: 'inline',
                availableDisplayModes: ['inline'],  // Only inline mode supported for now
                safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
                containerDimensions: {
                    maxHeight: 800
                },
                deviceCapabilities: {
                    touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0
                },
                styles: {
                    variables: {
                        '--font-sans': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                        '--color-background-primary': isDark ? '#1f2937' : '#ffffff',
                        '--color-background-secondary': isDark ? '#111827' : '#f9fafb',
                        '--color-text-primary': isDark ? '#f3f4f6' : '#1f2937',
                        '--color-text-secondary': isDark ? '#9ca3af' : '#6b7280',
                        '--color-border-primary': isDark ? '#374151' : '#e5e7eb'
                    }
                }
            }
        };
    }

    /**
     * Send tool-input and tool-result notifications to the app
     */
    sendMCPToolNotifications(targetWindow, iframeInfo) {
        // Send tool-input notification with tool arguments
        if (iframeInfo.toolArgs) {
            const toolInputNotification = {
                jsonrpc: '2.0',
                method: 'ui/notifications/tool-input',
                params: {
                    arguments: iframeInfo.toolArgs
                }
            };
            console.log('[MCP Bridge] Sending tool-input:', toolInputNotification);
            targetWindow.postMessage(toolInputNotification, '*');
        }

        // Send tool-result notification with tool result
        if (iframeInfo.toolResult) {
            const toolResultNotification = {
                jsonrpc: '2.0',
                method: 'ui/notifications/tool-result',
                params: iframeInfo.toolResult
            };
            console.log('[MCP Bridge] Sending tool-result:', toolResultNotification);
            targetWindow.postMessage(toolResultNotification, '*');
        }
    }

    /**
     * Handle resources/read request - forward to MCP server
     */
    async handleMCPResourceRead(params, iframeInfo) {
        console.log('[MCP Bridge] Handling resources/read:', params.uri);

        if (!window.mcpClient) {
            throw new Error('MCP client not available');
        }

        const response = await window.mcpClient.request('/mcp/proxy', {
            method: 'POST',
            body: JSON.stringify({
                action: 'proxy',
                server_url: iframeInfo.serverUrl,
                user_id: window.mcpClient.getUserId(),
                jsonrpc: {
                    jsonrpc: '2.0',
                    id: Date.now(),
                    method: 'resources/read',
                    params: { uri: params.uri }
                }
            })
        });

        if (!response.success) {
            throw new Error(response.error || 'Failed to read resource');
        }

        if (response.response?.error) {
            throw new Error(response.response.error.message || 'Resource read failed');
        }

        return response.response?.result || response.response;
    }

    /**
     * Handle tools/call request - forward to MCP server directly
     */
    async handleMCPToolCall(params, iframeInfo) {
        console.log('[MCP Bridge] Handling tools/call:', params.name, 'server:', iframeInfo.serverUrl);

        // Call the MCP server directly via our proxy
        const serverUrl = iframeInfo.serverUrl;
        if (!serverUrl) {
            throw new Error('No MCP server URL available');
        }

        try {
            const response = await fetch(window.apiUrl('/mcp/proxy'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    action: 'proxy',
                    server_url: serverUrl,
                    jsonrpc: {
                        jsonrpc: '2.0',
                        id: Date.now(),
                        method: 'tools/call',
                        params: {
                            name: params.name,
                            // Ensure arguments is an object, not an empty array
                            arguments: (params.arguments && !Array.isArray(params.arguments)) ? params.arguments : {}
                        }
                    }
                })
            });

            const data = await response.json();
            console.log('[MCP Bridge] Tool call response:', data);

            if (data.success && data.response) {
                if (data.response.error) {
                    const errorMsg = data.response.error.message ||
                                    (typeof data.response.error === 'string' ? data.response.error : JSON.stringify(data.response.error));
                    throw new Error(errorMsg);
                }
                return data.response.result;
            }

            // Handle error in response - extract message from error object if needed
            let errorMsg = 'Tool call failed';
            if (data.error) {
                if (typeof data.error === 'string') {
                    errorMsg = data.error;
                } else if (data.error.message) {
                    errorMsg = data.error.message;
                } else {
                    errorMsg = JSON.stringify(data.error);
                }
            } else if (data.message) {
                errorMsg = data.message;
            }
            throw new Error(errorMsg);
        } catch (error) {
            console.error('[MCP Bridge] Tool call error:', error);
            throw new Error(error.message || 'Tool call failed');
        }
    }

    /**
     * Handle ui/message request - display message in chat from the MCP app
     */
    async handleMCPMessage(params, iframeInfo) {
        console.log('[MCP Bridge] 💬 Handling ui/message:', params);

        const { role, content } = params || {};

        if (role !== 'user') {
            console.warn('[MCP Bridge] Unsupported message role:', role);
            return { isError: true };
        }

        if (!content || !Array.isArray(content) || content.length === 0) {
            console.warn('[MCP Bridge] Invalid message content');
            return { isError: true };
        }

        try {
            // Convert content blocks to displayable format
            let messageText = '';
            let hasImage = false;

            for (const block of content) {
                if (block.type === 'text' && block.text) {
                    messageText += block.text;
                } else if (block.type === 'image') {
                    hasImage = true;
                    // For images, we could display them or note that an image was sent
                    messageText += '[Image from MCP App]';
                }
            }

            // Display the message in chat as if from user
            if (messageText && this.messagesContainer) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'flex justify-end mb-4';
                messageDiv.innerHTML = `
                    <div class="bg-blue-500 text-white px-4 py-2 rounded-2xl rounded-br-md max-w-[80%] shadow-sm">
                        <span class="text-xs text-blue-200 block mb-1">From: ${iframeInfo?.toolName || 'MCP App'}</span>
                        ${this.escapeHtml(messageText)}
                    </div>
                `;
                this.messagesContainer.appendChild(messageDiv);
                this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
            }

            console.log('[MCP Bridge] 💬 Message displayed successfully');
            return { isError: false };
        } catch (error) {
            console.error('[MCP Bridge] Error handling message:', error);
            return { isError: true };
        }
    }

    /**
     * Handle ui/openLink request - open URL in new tab
     */
    handleMCPOpenLink(params) {
        console.log('[MCP Bridge] 🔗 Handling ui/openLink:', params);

        const { url } = params || {};

        if (!url || typeof url !== 'string') {
            console.warn('[MCP Bridge] Invalid URL for openLink');
            return { isError: true };
        }

        try {
            // Security: only allow http/https URLs
            const urlObj = new URL(url);
            if (!['http:', 'https:'].includes(urlObj.protocol)) {
                console.warn('[MCP Bridge] Blocked non-http(s) URL:', url);
                return { isError: true };
            }

            // Open in new tab
            window.open(url, '_blank', 'noopener,noreferrer');
            console.log('[MCP Bridge] 🔗 Opened link:', url);
            return { isError: false };
        } catch (error) {
            console.error('[MCP Bridge] Error opening link:', error);
            return { isError: true };
        }
    }

    /**
     * Handle ui/request-display-mode - change display mode (inline, fullscreen, pip)
     */
    handleMCPRequestDisplayMode(params, iframeInfo) {
        console.log('[MCP Bridge] 🖥️ Handling ui/request-display-mode:', params);

        const { mode } = params || {};
        const validModes = ['inline', 'fullscreen', 'pip'];

        if (!mode || !validModes.includes(mode)) {
            console.warn('[MCP Bridge] Invalid display mode:', mode);
            return { mode: 'inline' };  // Fall back to inline
        }

        // Find the container and iframe
        const container = document.getElementById(iframeInfo?.containerId);
        if (!container) {
            console.warn('[MCP Bridge] Container not found for display mode change');
            return { mode: 'inline' };
        }

        const iframe = container.querySelector('iframe');
        const wrapper = container.closest('.flex');

        // Remove existing display mode classes
        container.classList.remove('mcp-display-inline', 'mcp-display-fullscreen', 'mcp-display-pip');

        switch (mode) {
            case 'fullscreen':
                // Make the container fullscreen
                container.classList.add('mcp-display-fullscreen');
                container.style.position = 'fixed';
                container.style.top = '0';
                container.style.left = '0';
                container.style.width = '100vw';
                container.style.height = '100vh';
                container.style.maxWidth = '100vw';
                container.style.zIndex = '9999';
                container.style.borderRadius = '0';
                if (iframe) {
                    iframe.style.width = '100%';
                    iframe.style.height = '100%';
                    iframe.style.borderRadius = '0';
                }
                console.log('[MCP Bridge] 🖥️ Switched to fullscreen mode');
                return { mode: 'fullscreen' };

            case 'pip':
                // Picture-in-picture: small floating window
                container.classList.add('mcp-display-pip');
                container.style.position = 'fixed';
                container.style.bottom = '20px';
                container.style.right = '20px';
                container.style.width = '320px';
                container.style.height = '240px';
                container.style.maxWidth = '320px';
                container.style.zIndex = '9998';
                container.style.borderRadius = '12px';
                container.style.boxShadow = '0 8px 32px rgba(0,0,0,0.3)';
                if (iframe) {
                    iframe.style.width = '100%';
                    iframe.style.height = '100%';
                }
                console.log('[MCP Bridge] 🖥️ Switched to PiP mode');
                return { mode: 'pip' };

            case 'inline':
            default:
                // Reset to inline mode
                container.classList.add('mcp-display-inline');
                container.style.position = '';
                container.style.top = '';
                container.style.left = '';
                container.style.bottom = '';
                container.style.right = '';
                container.style.width = '80%';  // Match text bubble width
                container.style.height = '';
                container.style.maxWidth = '80%';
                container.style.zIndex = '';
                container.style.borderRadius = '';
                container.style.boxShadow = '';
                if (iframe) {
                    iframe.style.width = '';
                    iframe.style.height = '';
                    iframe.style.borderRadius = '';
                }
                console.log('[MCP Bridge] 🖥️ Switched to inline mode');
                return { mode: 'inline' };
        }
    }

    /**
     * Handle ui/notifications/size-changed - resize iframe to match content
     * Apply both width and height changes from the View, with reasonable constraints
     */
    handleMCPSizeChanged(sourceWindow, params, iframeInfo) {
        const { width, height } = params || {};
        console.log('[MCP Bridge] 📐 handleMCPSizeChanged called:', { width, height, tool: iframeInfo?.toolName });

        // Find the iframe element
        const containerId = iframeInfo?.containerId;
        console.log('[MCP Bridge] 📐 Looking for container:', containerId);

        const container = document.getElementById(containerId);
        if (!container) {
            console.error('[MCP Bridge] ❌ Container not found:', containerId);
            return;
        }

        const iframe = container.querySelector('iframe');
        if (!iframe) {
            console.error('[MCP Bridge] ❌ Iframe not found in container');
            return;
        }

        console.log('[MCP Bridge] 📐 Found iframe, current size:', iframe.style.width, iframe.style.height);

        // Apply height with constraints
        if (height != null && height > 0) {
            const minHeight = 100;
            const maxHeight = 800;
            const clampedHeight = Math.min(Math.max(height, minHeight), maxHeight);
            iframe.style.height = `${clampedHeight}px`;
            // Also set container height to allow growth
            container.style.height = 'auto';
            container.style.minHeight = `${clampedHeight}px`;
            console.log('[MCP Bridge] Applied height:', clampedHeight);
        }

        // Apply width if specified by the server (capped at 80% of messages container)
        // Default is 80% width (set when container is created)
        // Only change if server explicitly requests a different width
        if (width != null && width > 0) {
            // Calculate max allowed width (80% of messages container, not the wrapper)
            // Use messagesContainer for reliable width since wrapper may shrink with content
            const messagesContainer = document.getElementById('messages') || container.parentElement?.parentElement;
            const maxWidth = messagesContainer ? Math.floor(messagesContainer.clientWidth * 0.8) : 800;
            const minWidth = 200;
            const clampedWidth = Math.min(Math.max(width, minWidth), maxWidth);

            // Remove Tailwind width class to allow inline styles to take effect
            container.classList.remove('w-[80%]');
            // Set exact width - use !important via setProperty to override any CSS
            container.style.setProperty('width', `${clampedWidth}px`, 'important');
            container.style.setProperty('max-width', `${clampedWidth}px`, 'important');
            container.style.setProperty('min-width', `${clampedWidth}px`, 'important');
            iframe.style.width = '100%';
            console.log('[MCP Bridge] Applied width:', clampedWidth, '(max:', maxWidth, ')');
        }
    }

    /**
     * Send JSON-RPC success response to iframe
     */
    sendMCPResponse(targetWindow, id, result) {
        const response = {
            jsonrpc: '2.0',
            id: id,
            result: result
        };
        console.log('[MCP Bridge] Sending response:', response);
        targetWindow.postMessage(response, '*');
    }

    /**
     * Send JSON-RPC error response to iframe
     */
    sendMCPError(targetWindow, id, code, message) {
        const response = {
            jsonrpc: '2.0',
            id: id,
            error: {
                code: code,
                message: message
            }
        };
        console.log('[MCP Bridge] Sending error:', response);
        targetWindow.postMessage(response, '*');
    }

    /**
     * Get MCP tool definitions for AI requests
     */
    getMCPToolDefinitions() {
        if (!this.mcpEnabled || !window.mcpClient) {
            return [];
        }
        return window.mcpClient.getToolDefinitions();
    }

    /**
     * Handle MCP tool execution from AI response
     */
    async executeMCPTool(toolName, args) {
        if (!window.mcpClient) {
            return { error: 'MCP client not available' };
        }

        // Remove mcp_ prefix if present
        const actualToolName = toolName.startsWith('mcp_') ? toolName.substring(4) : toolName;
        const tool = window.mcpClient.getTool(actualToolName);

        if (!tool) {
            return { error: `MCP tool '${actualToolName}' not found` };
        }

        // If tool has UI, show the embedded app
        if (tool.hasUi && window.mcpAppHost && this.mcpAppContainer) {
            try {
                const result = await window.mcpAppHost.createAppFrame(actualToolName, this.mcpAppContainer);
                return {
                    success: true,
                    message: `Launched ${tool.name} UI`,
                    appId: result.appId
                };
            } catch (error) {
                console.error('Failed to launch MCP app UI:', error);
                // Fall back to direct tool call
            }
        }

        // Execute tool without UI
        const result = await window.mcpClient.callTool(actualToolName, args);
        return result;
    }

    /**
     * Display MCP tool result in chat
     */
    displayMCPToolResult(toolName, result) {
        if (!result) return;

        let content = '';
        if (result.success) {
            if (typeof result.result === 'string') {
                content = result.result;
            } else if (result.result?.content) {
                // MCP tool result format
                const contentBlocks = result.result.content;
                content = contentBlocks.map(block => {
                    if (block.type === 'text') return block.text;
                    return JSON.stringify(block);
                }).join('\n');
            } else {
                content = JSON.stringify(result.result, null, 2);
            }
        } else {
            content = `Error: ${result.error || 'Unknown error'}`;
        }

        // Add tool result as a system-style message
        const msgId = this.addMessage('assistant', `**[MCP Tool: ${toolName}]**\n\n${content}`, false, 'mcp');
        return msgId;
    }

    /**
     * Display MCP UI (iframe) for a tool with visual interface
     */
    async displayMCPUI(mcpData) {
        const { tool_name, ui_info } = mcpData;
        if (!ui_info) {
            console.warn('MCP UI data missing ui_info');
            return;
        }

        console.log('🖼️ Displaying MCP UI for tool:', tool_name);
        console.log('🖼️ Full ui_info:', JSON.stringify(ui_info, null, 2));
        console.log('🖼️ Arguments:', JSON.stringify(ui_info.arguments, null, 2));

        // Create simple container for MCP UI (no window chrome)
        // Use same styling as assistant message bubbles for consistent layout
        // IMPORTANT: Use w-[80%] Tailwind class for proper flex behavior, NOT inline style
        const container = document.createElement('div');
        container.className = 'mcp-ui-container w-[80%] bg-white border border-gray-200 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm';
        container.id = `mcp-ui-${Date.now()}`;

        // Create iframe
        const iframe = document.createElement('iframe');
        iframe.className = 'mcp-ui-frame';
        // allow-downloads: MCP apps offer file downloads (e.g. generated images) via
        // anchor download, which is the only path when the app is cross-origin (Node
        // backend on :3001). allow-modals: surface the apps' alert() error messages.
        iframe.sandbox = 'allow-scripts allow-forms allow-same-origin allow-downloads allow-modals';

        const serverUrl = ui_info.server_url || '';
        const viewUUID = ui_info.view_uuid || '';
        const args = ui_info.arguments || {};

        // Store data attributes for bridge identification
        iframe.dataset.serverUrl = serverUrl;
        iframe.dataset.toolName = ui_info.tool_name || tool_name;
        iframe.dataset.toolArgs = JSON.stringify(args);
        if (ui_info.tool_result) {
            iframe.dataset.toolResult = JSON.stringify(ui_info.tool_result);
        }

        container.appendChild(iframe);

        // Add loading indicator
        const loading = document.createElement('div');
        loading.className = 'mcp-ui-loading';
        loading.innerHTML = '<div class="mcp-ui-spinner"></div><span>Loading...</span>';
        container.appendChild(loading);

        // Insert into chat area (use this.messagesContainer which is #messages)
        // Wrap in flex container like AI messages for consistent alignment
        if (this.messagesContainer) {
            const wrapper = document.createElement('div');
            wrapper.className = 'flex justify-center w-full';
            wrapper.appendChild(container);
            this.messagesContainer.appendChild(wrapper);
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
            console.log('📍 MCP UI container added to messages');
        } else {
            console.error('❌ Could not find messagesContainer');
        }

        // Load the MCP app via our proxy endpoint
        // This fetches the HTML via MCP protocol and serves it with the right headers
        try {
            console.log('🔄 Loading MCP UI via proxy:', serverUrl);

            // Build URL to our MCP app proxy
            const params = new URLSearchParams();
            params.set('server', serverUrl);

            // Add the resource URI from the tool's metadata (REQUIRED)
            const resourceUri = ui_info.resource_uri;
            if (resourceUri) {
                params.set('resource', resourceUri);
            } else {
                console.error('❌ No resource_uri in ui_info:', ui_info);
            }

            // Add tool arguments (pass all arguments generically)
            if (args && typeof args === 'object') {
                Object.entries(args).forEach(([key, value]) => {
                    if (value !== undefined && value !== null) {
                        params.set(key, String(value));
                    }
                });
            }
            if (viewUUID) params.set('viewUUID', viewUUID);

            const appUrl = window.apiUrl(`/mcp/app?${params.toString()}`);
            console.log('📍 Loading app from proxy:', appUrl);
            console.log('📍 URL params:', Object.fromEntries(params.entries()));

            iframe.src = appUrl;

            // Pre-register iframe with MCP bridge IMMEDIATELY after setting src
            // This prevents race condition where React app calls connect() before onload fires
            if (iframe.contentWindow) {
                this.mcpIframes.set(iframe.contentWindow, {
                    serverUrl: serverUrl,
                    toolName: ui_info.tool_name || tool_name,
                    containerId: container.id,
                    toolArgs: args,
                    toolResult: ui_info.tool_result || null
                });
                console.log('🔗 Pre-registered iframe with MCP bridge:', ui_info.tool_name || tool_name);
            }

            iframe.onload = () => {
                console.log('✅ MCP UI iframe loaded successfully');
                loading.remove();
                container.classList.add('mcp-ui-loaded');

                // Re-register in case contentWindow reference changed during navigation
                if (iframe.contentWindow) {
                    this.mcpIframes.set(iframe.contentWindow, {
                        serverUrl: serverUrl,
                        toolName: ui_info.tool_name || tool_name,
                        containerId: container.id,
                        toolArgs: args,
                        toolResult: ui_info.tool_result || null
                    });
                    console.log('🔗 Confirmed iframe registration:', ui_info.tool_name || tool_name);
                }
            };

            iframe.onerror = () => {
                console.error('❌ Failed to load MCP UI iframe');
                loading.innerHTML = '<span style="color: #f44336;">Failed to load app</span>';
            };

        } catch (error) {
            console.error('Failed to load MCP UI:', error);
            loading.innerHTML = `<span style="color: #f44336;">Error: ${error.message}</span>`;
        }
    }

    setUIEnabled(enabled) {
        if (enabled) {
            this.userInput.disabled = false;
            this.sendBtn.disabled = false;
            this.userInput.placeholder = window.i18n?.t('input.placeholder') || 'Type your message...';
        } else {
            this.userInput.disabled = true;
            this.sendBtn.disabled = true;
            this.userInput.placeholder = window.i18n?.t('input.verifying') || 'Verifying authentication...';
        }
    }

    onLanguageChanged(lang) {
        if (this.totalTokens === 0) {
            this.tokenInfo.textContent = window.i18n.t('infoBar.ready');
        }
        if (this.providers.length > 0) {
            this.renderProviderButtons();
        }
        // Re-render contexts list to apply new translations
        this.renderContextsList();
    }

    async loadProviders() {
        try {
            const response = await fetch(window.apiUrl('/providers'), {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success) {
                this.providers = data.providers;

                // Check localStorage for stored LLM provider preference (shared with Voice app)
                const storedProvider = localStorage.getItem('app-llm-provider');
                const availableProviderNames = this.providers.filter(p => p.available).map(p => p.name);

                if (storedProvider && availableProviderNames.includes(storedProvider)) {
                    this.currentProvider = storedProvider;
                    console.log('[Chat] Using LLM provider from localStorage:', storedProvider);
                } else {
                    this.currentProvider = data.current_provider;
                    // Save to localStorage for sharing with Voice app
                    localStorage.setItem('app-llm-provider', this.currentProvider);
                }

                this.functions = data.functions;
                this.functionCount.textContent = data.function_count;
                this.renderProviderButtons();
                this.updateProviderDisplay();

                // Update verifier and compare lists with loaded providers
                this.updateVerifierStatus();
                this.updateCompareStatus();
                this.populateVerifierList();
                this.populateCompareList();

                // Update split pane badges with current provider
                this.updateSplitPaneBadges();
            }
        } catch (error) {
            console.error('Failed to load providers:', error);
            if (this.providerName) this.providerName.textContent = window.i18n.t('header.loading');
            this.providerButtons.innerHTML = `<span class="text-red-500 text-sm">${window.i18n.t('providerBar.failedToLoad')}</span>`;
        }
    }

    renderProviderButtons() {
        this.providerButtons.innerHTML = '';

        this.providers.forEach(provider => {
            const btn = document.createElement('button');
            const style = this.providerStyles[provider.name] || this.providerStyles.default;
            const isActive = provider.name === this.currentProvider;
            const isAvailable = provider.available;

            btn.className = `provider-btn px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ${
                isActive
                    ? `${style.bg} ${style.text} ring-2 ring-offset-2 ring-blue-400`
                    : isAvailable
                        ? `bg-white border border-gray-300 text-gray-700 hover:bg-gray-50`
                        : `bg-gray-100 text-gray-400 cursor-not-allowed`
            }`;
            btn.disabled = !isAvailable;
            btn.dataset.provider = provider.name;

            btn.innerHTML = `
                <span>${style.icon}</span>
                <span>${provider.display_name}</span>
                ${isActive ? `<span class="text-xs">(${window.i18n.t('provider.active')})</span>` : ''}
                ${!isAvailable ? `<span class="text-xs">(${window.i18n.t('provider.unavailable')})</span>` : ''}
            `;

            if (isAvailable) {
                btn.addEventListener('click', () => this.switchProvider(provider.name));
            }

            this.providerButtons.appendChild(btn);
        });
    }

    addEVIButton() {
        const btn = document.createElement('button');
        const style = this.providerStyles.evi;
        const isActive = this.currentProvider === 'evi';

        btn.className = `provider-btn px-4 py-2 rounded-lg text-sm font-medium transition flex items-center gap-2 ${
            isActive
                ? `${style.bg} ${style.text} ring-2 ring-offset-2 ring-orange-400`
                : `bg-white border border-gray-300 text-gray-700 hover:bg-gray-50`
        }`;
        btn.dataset.provider = 'evi';

        btn.innerHTML = `
            <span>${style.icon}</span>
            <span>Hume EVI</span>
            ${isActive ? '<span class="text-xs">(Active)</span>' : ''}
            <span class="text-xs text-gray-500">(Voice)</span>
        `;

        btn.addEventListener('click', () => this.switchProvider('evi'));
        this.providerButtons.appendChild(btn);
    }

    async switchProvider(providerName) {
        if (providerName === this.currentProvider || this.isLoading) return;

        // Cancel any pending requests
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        try {
            // Handle EVI
            if (providerName === 'evi') {
                this.currentProvider = 'evi';
                this.eviManualDisconnect = false; // Clear flag when switching to EVI
                this.renderProviderButtons();
                this.updateProviderDisplay();
                await this.connectToEVI();
                return;
            }

            // Disconnect EVI if switching away
            if (this.currentProvider === 'evi') {
                await this.disconnectEVI();
            }

            this.showProgress(`${window.i18n.t('progress.switchingTo')} ${providerName}...`);

            const response = await fetch(window.apiUrl('/providers'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ provider: providerName })
            });

            const data = await response.json();

            if (data.success) {
                this.currentProvider = providerName;
                // Save to localStorage for sharing with Voice app
                localStorage.setItem('app-llm-provider', providerName);
                console.log('[Chat] Saved LLM provider to localStorage:', providerName);

                this.renderProviderButtons();
                this.updateProviderDisplay();

                // If the new provider was selected as verifier, clear verifier selection
                if (this.selectedVerifier === providerName) {
                    this.selectedVerifier = null;
                    this.verificationEnabled = false;
                    if (this.verifierToggle) {
                        this.verifierToggle.checked = false;
                    }
                    this.updateVerifierStatus();
                    this.saveVerifierState();
                    this.hideSplitPane();
                }

                // Always update split pane badges to keep them in sync
                this.updateSplitPaneBadges();

                // Update verifier list if view is active
                if (this.currentView === 'verifier') {
                    this.populateVerifierList();
                }

                if (!this.mergeConversationsCheckbox.checked) {
                    this.clearChat();
                }
            } else {
                throw new Error(data.error || window.i18n.t('messages.failedToSwitch'));
            }
        } catch (error) {
            console.error('Failed to switch provider:', error);
            this.addSystemMessage(`${window.i18n.t('messages.failedToSwitch')}: ${error.message}`, 'error');
        } finally {
            this.hideProgress();
        }
    }

    getProviderDisplayName(name) {
        const provider = this.providers.find(p => p.name === name);
        return provider ? provider.display_name : name;
    }

    updateProviderDisplay() {
        const provider = this.providers.find(p => p.name === this.currentProvider);
        if (provider) {
            if (this.providerName) this.providerName.textContent = `${provider.display_name} (${provider.model})`;
        }
    }

    addSystemMessage(text, type = 'info') {
        const wrapper = document.createElement('div');
        wrapper.className = 'flex justify-center';

        const bgColor = type === 'error' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600';
        const bubble = document.createElement('div');
        bubble.className = `${bgColor} px-4 py-2 rounded-full text-sm`;
        bubble.textContent = text;

        wrapper.appendChild(bubble);
        this.messagesContainer.appendChild(wrapper);
        this.scrollToBottom();
    }

    async sendMessage() {
        const message = this.userInput.value.trim();
        if (!message || this.isLoading) return;

        // Block send if any attachment is still being uploaded or converted
        // — the prefix (and attachment_ids) wouldn't include them and the
        // turn would silently drop their content. Surface as a toast so the
        // user knows to wait rather than guessing why the chip is spinning.
        const stillWorking = (this.pendingAttachments || []).some(a =>
            a.status === 'uploading' || a.conversionStatus === 'pending'
        );
        if (stillWorking) {
            if (typeof this.showNotification === 'function') {
                this.showNotification('Still processing attachments — wait for the spinners to finish.', 'info');
            }
            return;
        }

        // If the previous turn's B3 stream is still running in the
        // background (artifact pane visible, user freed to type a new
        // prompt), abort it cleanly and preserve whatever it streamed
        // so far in conversation_history. Done BEFORE we reset
        // this.fullContent below, since aborting is async and the OLD
        // catch handler can't read the value once we've cleared it.
        if (this._b3StreamFinalized && this.abortController) {
            if (this.fullContent && this._lastB3UserMessage) {
                this.conversationHistory.push(this._lastB3UserMessage);
                this.conversationHistory.push({
                    role: 'assistant',
                    content: this.fullContent,
                    provider: this.currentProvider
                });
            }
            this._abortReasonNewTurn = true;
            try { this.abortController.abort(); } catch {}
            this._b3StreamFinalized = false;
            this._lastB3UserMessage = null;
        }

        this.isLoading = true;
        this.aborted = false;
        this.sendBtn.classList.add('hidden');
        if (this.stopBtn) this.stopBtn.classList.remove('hidden');
        this.userInput.value = '';

        const userMsgId = this.addMessage('user', message, false, this.currentProvider);
        const userMessage = { role: 'user', content: message, provider: this.currentProvider };

        // Provider-named "thinking" indicator while we wait for the
        // first byte back. Honest about what's happening: the model is
        // generating, we have nothing to render yet. Replaced once
        // streaming chunks arrive (text turns) or the JSON resolves
        // (skill / non-streaming turns).
        this.showProgress(`${this.getProviderDisplayName(this.currentProvider)}: thinking...`);

        const assistantMsgId = this.addMessage('assistant', '', true, this.currentProvider);

        // Track message IDs for potential abort cleanup
        this.currentUserMsgId = userMsgId;
        this.currentAssistantMsgId = assistantMsgId;

        // Reset streaming buffers for new message
        this.displayContent = '';
        this.fullContent = '';
        this.displayHtml = '';  // Reset displayHtml for streaming
        this.parserState = 'NORMAL';
        this.buffer = '';
        this.symbolBuffer = '';
        this.ttsBuffer = '';
        this.carryOver = '';  // Reset carryOver too
        this.currentCodeBlockPlaceholder = null;  // Reset placeholder tracking

        // Create AbortController for this request
        this.abortController = new AbortController();

        // Verification state for this message
        let verifierMsgId = null;
        this.verifierFullContent = '';

        // Compare state for this message
        let compareMsgId = null;
        this.compareFullContent = '';

        // If verification is enabled, prepare the verifier pane
        if (this.verificationEnabled && this.selectedVerifier && this.splitPaneActive) {
            this.clearVerifierMessages();
        }

        // If compare is enabled, prepare the compare pane
        if (this.compareEnabled && this.selectedComparer && this.splitPaneActive) {
            this.clearCompareMessages();
            // Mirror the user prompt into the compare pane so both panes
            // render the same conversation (prompt + each provider's
            // response). Must come AFTER clearCompareMessages, which
            // wipes the entire container. The existing addCompareMessage
            // styles role='user' as a right-aligned blue bubble —
            // visually identical to the primary pane's user bubble.
            this.addCompareMessage('user', message);
        }

        try {
            // Get user ID from localStorage
            const storedUser = window.accountStore.getActiveUser();

            // EARLY skill-mode detection — computed BEFORE we decide how to
            // package attachments, because skill mode flips the strategy
            // from "inline content into the prompt" to "let the backend
            // dispatcher elide it to a /scratch/ reference and let the
            // skill script read the file directly". The full computation
            // (autoPickedSkill, effectiveSkill, etc.) happens further down
            // around line 1734+; here we just need the binary "will a
            // skill probably handle this?" answer to decide whether to
            // skip frontend inlining for text-native pass-through.
            const _earlyChipActive = (this.activeSkill?.source === 'local'
                && this.activeSkill?.dir_name);
            const _earlyEnabledSkills = (typeof window.skillsManager?.getEnabledLocalSkills === 'function')
                ? window.skillsManager.getEnabledLocalSkills()
                : [];
            const _earlySingleAttachment = Array.isArray(this.pendingAttachments)
                && this.pendingAttachments.length === 1
                && this.pendingAttachments[0]?.name;
            let _earlyAutoMatchSkill = null;
            if (!_earlyChipActive && _earlySingleAttachment && _earlyEnabledSkills.length > 0) {
                const _attName = (this.pendingAttachments[0].name || '').trim();
                const _attExt = _attName.includes('.')
                    ? _attName.slice(_attName.lastIndexOf('.') + 1).toLowerCase()
                    : '';
                const _promptText = (message || '').toLowerCase();
                if (_attExt && /\b(create|generate|make|build|produce|edit|update|replace|fix|correct|swap|change|modify|revise|write|render|format)\b/.test(_promptText)) {
                    _earlyAutoMatchSkill = _earlyEnabledSkills.find(s => s.dir_name === _attExt) || null;
                }
            }
            const _skillInPlay = !!_earlyChipActive || !!_earlyAutoMatchSkill;

            // PROVIDER GATE for the elide-vs-inline decision.
            //
            // We default to INLINING text-native pass-through attachments
            // (HTML/TXT/MD) into the user message, even in skill mode.
            // Why: Claude, OpenAI, Gemini, and Kimi all handle 80K-char
            // user messages without issue, and they USE the inlined
            // template content to mirror its style/structure when the
            // user prompt is "...as template for style and structure".
            // Eliding it for those providers would degrade output
            // quality even if the script itself still ran.
            //
            // Only providers known to choke on large user messages get
            // the elision. Today: Grok (xAI) returns an EMPTY response
            // (text_len=0, tool_calls=0, finish_reason=stop) when the
            // user message exceeds ~30K chars combined with a forced
            // tool_choice — confirmed empirically with grok-4-1-fast-
            // non-reasoning. DeepSeek-v4 has documented context-handling
            // quirks too; pre-emptively included.
            //
            // For these providers, the trade-off is "no template-style
            // mirroring vs no response at all" — and any output beats
            // none. The script still runs; the model just authors HTML
            // from generic styling rather than mimicking the template.
            const _LARGE_PROMPT_SENSITIVE_PROVIDERS = ['grok', 'deepseek'];
            const _providerNeedsElision = _LARGE_PROMPT_SENSITIVE_PROVIDERS.includes(this.currentProvider);
            const _earlySkillModeLikely = _skillInPlay && _providerNeedsElision;

            // Build the outgoing message: prepend any frontend-converted
            // attachments (DOCX/PPTX/XLSX/PDF) using the same prose format
            // the backend's AttachmentDispatcher uses, so the model
            // recognizes them as real attachments rather than as a custom
            // XML wrapper it doesn't know about. Image attachments are NOT
            // included here — they ride attachment_ids and go through
            // provider-native image dispatch server-side.
            //
            // EXCLUSIONS:
            //  - Text-native pass-through (HTML/TXT/MD): the
            //    attachment-converter "converts" these by simple file
            //    read, marking conversionStatus='done' and storing the
            //    full content under .markdown. If we then prepend that
            //    content here, the message balloons by ~80KB for a normal
            //    HTML doc — which (we've observed) makes Grok return an
            //    empty response despite tool_choice forcing. For these
            //    files, when skill mode is likely, leave them out of the
            //    prefix and route them through attachment_ids so the
            //    backend AttachmentDispatcher can substitute a short
            //    /scratch/ reference instead of inlining the bytes.
            //
            //  - In non-skill mode, text-native pass-through stays
            //    inlined here (preserves existing behaviour for casual
            //    "summarise this document" turns where the LLM needs to
            //    actually read the content).
            const TEXT_NATIVE_EXTS = new Set(['html', 'htm', 'md', 'markdown', 'txt', 'json', 'csv', 'xml']);
            const _isTextNativePassThrough = (a) => {
                const name = (a?.name || '').toLowerCase();
                const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
                return TEXT_NATIVE_EXTS.has(ext);
            };
            const convertedDocs = (this.pendingAttachments || [])
                .filter(a => a.conversionStatus === 'done'
                    && typeof a.markdown === 'string'
                    && a.markdown.length > 0
                    // Skip text-native pass-through when skill mode is likely.
                    // The backend dispatcher will elide them to /scratch/ refs.
                    && !(_earlySkillModeLikely && _isTextNativePassThrough(a)));
            let outgoingMessage = message;
            if (convertedDocs.length > 0) {
                const blocks = convertedDocs.map(a => `### ${a.name || 'attachment'}\n${a.markdown}`);
                const prefix = '[The user attached the following document(s); use them as authoritative context for the message that follows.]\n\n'
                    + blocks.join('\n\n---\n\n')
                    + '\n\n---\n\n';
                outgoingMessage = prefix + message;
            }

            // Critical for multi-round tool flows: the userMessage object
            // is what dispatchClientToolCall replays into conversation_history
            // on every continuation turn. If we leave it as the raw user
            // text (no prepended attachment), the model loses sight of the
            // document content as soon as the first tool_result comes back
            // — and then asks "could you please attach the HTML file?".
            // Patch the same content we sent on this turn so subsequent
            // rounds see the attachment too. The chat bubble (addMessage
            // above) still shows the raw text — only the model-facing copy
            // carries the attachment.
            userMessage.content = outgoingMessage;

            // Phase 6 multi-skill auto-routing + Phase 7 user filter: send
            // the catalog of every ENABLED installed local skill so the
            // model can pick one based on intent. The user controls which
            // skills are exposed via Settings → Skills (default ON). The
            // chip-active skill (skill_metadata, below) still overrides
            // this when set — chip = "use THIS specific skill, even if
            // disabled in settings".
            //
            // Re-read the skills folder before building the catalog so a
            // skill the user just created (e.g. via skill-creator) shows up
            // immediately — no hard refresh needed. The filesystem is the
            // source of truth; the in-memory list is just a stale snapshot
            // until we refresh it here. Cost: a few tens of ms on FSA.
            if (typeof window.skillsManager?.refreshSkills === 'function') {
                await window.skillsManager.refreshSkills();
            }

            const enabledLocalSkills = (typeof window.skillsManager?.getEnabledLocalSkills === 'function')
                ? window.skillsManager.getEnabledLocalSkills()
                : (window.skillsManager?.skills || []).filter(s =>
                    s?.source === 'local'
                    && typeof s?.dir_name === 'string'
                    && Array.isArray(s?.scripts)
                    && s.scripts.length > 0);
            const availableSkills = enabledLocalSkills.map(s => ({
                dir_name: s.dir_name,
                description: s.description || '',
                scripts: s.scripts,
            }));

            // Auto-pick a skill when conditions warrant it, so auto-routing
            // collapses to a single phase identical to chip-dragged.
            //
            // Why: the two-phase auto-routing architecture (discover_skill
            // → run_skill_script) puts a structured tool_result in Claude's
            // context immediately before run_skill_script. That biases the
            // model to emit JSON-shaped content for input_files/argv, which
            // we keep having to recover at the dispatcher with progressively
            // hackier parsers. Chip-dragged works cleanly because it has
            // NO preceding tool_result — Claude reads SKILL.md from the
            // system prompt and emits the call shape per the contract.
            //
            // By identifying the right skill on the frontend BEFORE the
            // first request, we can inject skill_metadata + skill_content
            // into that request — same as a real chip-drag. The backend's
            // single-skill branch fires immediately, no discover step, no
            // JSON-biased context. End-to-end behaviour matches chip-drag.
            //
            // Heuristic: match attachment file extension to skill dir_name
            // (.html → html skill, .docx → docx skill). Conservative —
            // only auto-picks when:
            //   - no chip is already dragged
            //   - exactly one attachment (multi-attachment routing is
            //     ambiguous; fall back to discover flow)
            //   - the prompt has a deliverable verb (so we know a skill
            //     run is intended, not just a question about the doc)
            //   - the attachment's extension matches an enabled skill's
            //     dir_name exactly
            // If any check fails, we fall through to the existing
            // multi-skill auto-routing path (Phase 1 discover, Phase 2
            // execute) — that path still works for skills the user picks
            // by intent rather than file extension.
            let autoPickedSkill = null;
            const noChipActive = !(this.activeSkill?.source === 'local'
                && this.activeSkill?.dir_name);
            const singleAttachment = Array.isArray(this.pendingAttachments)
                && this.pendingAttachments.length === 1
                && this.pendingAttachments[0]?.name;
            if (noChipActive && singleAttachment && enabledLocalSkills.length > 0) {
                const attName = (this.pendingAttachments[0].name || '').trim();
                const attExt = attName.includes('.')
                    ? attName.slice(attName.lastIndexOf('.') + 1).toLowerCase()
                    : '';
                const promptText = (message || '').toLowerCase();
                const hasDeliverableVerb = /\b(create|generate|make|build|produce|edit|update|replace|fix|correct|swap|change|modify|revise|write|render|format)\b/.test(promptText);
                if (attExt && hasDeliverableVerb) {
                    const match = enabledLocalSkills.find(s => s.dir_name === attExt);
                    if (match) {
                        autoPickedSkill = match;
                        console.log(`[Chat] Auto-picked skill "${match.dir_name}" (extension=.${attExt}, deliverable verb detected). Sending as chip-equivalent: skill_metadata + skill_content injected; discover_skill phase skipped.`);
                    }
                }
            }
            const effectiveSkill = autoPickedSkill || (this.activeSkill?.source === 'local' ? this.activeSkill : null);

            // Streaming is a UX feature, not a transport detail. We
            // stream when the user can read the response progressively
            // (text/markdown turns); we DON'T stream when the model is
            // emitting structured arguments the UI can't render mid-flight
            // (skill turns that run a transform via run_skill_script).
            // For those, the entire input_files payload would just be
            // buffered in the backend and dispatched as a single event —
            // pure overhead. Set streaming=false so the backend takes
            // the non-streaming path (handleRegularChat) and returns
            // the complete response as JSON in one shot.
            const turnRunsSkillTransform = !!(
                effectiveSkill?.dir_name
                && Array.isArray(effectiveSkill?.scripts)
                && effectiveSkill.scripts.length > 0
            );

            const requestBody = {
                message: outgoingMessage,
                conversation_history: this.conversationHistory.slice(-10),
                streaming: !turnRunsSkillTransform,
                user_id: storedUser?.id || 'demo-user',
                provider: this.currentProvider,
                // Skill content appended to system prompt server-side. Set
                // when either chip-dragged OR auto-picked — both paths feed
                // the same downstream branch.
                skill_content: effectiveSkill?.skill_content || null,
                // skill_metadata: set for chip-dragged AND auto-picked.
                skill_metadata: (effectiveSkill?.dir_name
                    && Array.isArray(effectiveSkill?.scripts)
                    && effectiveSkill.scripts.length > 0)
                    ? { dir_name: effectiveSkill.dir_name, scripts: effectiveSkill.scripts }
                    : null,
                // Multi-skill catalog — used when no chip is active. The
                // model gets to pick which skill (if any) to call. Empty
                // array means "no local skills installed; behave as
                // before".
                available_skills: availableSkills,
                // Add verification parameters
                verification_enabled: this.verificationEnabled && this.selectedVerifier ? true : false,
                verifier_provider: this.selectedVerifier,
                // Add compare parameters
                compare_enabled: this.compareEnabled && this.selectedComparer ? true : false,
                compare_provider: this.selectedComparer,
                // Attachment IDs — sent on every turn so the doc stays in
                // conversation context (matches claude.ai / gemini.google.com
                // behaviour). Frontend-converted attachments (markdown
                // already prepended above) are EXCLUDED so the backend
                // doesn't double-extract their text. Image attachments and
                // any conversion-failure / converter-skip entries still
                // ride this list — backend dispatch handles them.
                //
                // EXCEPTION: text-native pass-through (HTML/TXT/MD) when
                // skill mode is likely. We REVERSED the prepend decision
                // for those above (we DIDN'T inline them into outgoingMessage),
                // so we must INCLUDE them here so the backend's
                // AttachmentDispatcher gets a chance to elide them to a
                // /scratch/ reference. Without this branch, an HTML
                // attachment would be neither inlined client-side nor
                // visible server-side — the model would have no reference
                // to it at all.
                attachment_ids: this.pendingAttachments
                    .filter((a) =>
                        (a.status === 'done' || a.status === 'active')
                        && a.id != null
                        && (
                            a.conversionStatus !== 'done'
                            || (_earlySkillModeLikely && _isTextNativePassThrough(a))
                        )
                    )
                    .map((a) => a.id),
            };

            // (Earlier optimization stripped conversation_history when
            // skill+attachment were both present. That broke follow-up
            // turns within a skill session — the LLM lost context like
            // "user said page mode in response to my earlier question"
            // and would either bail or hallucinate. The /scratch
            // pre-write optimization already reclaimed the bigger
            // latency cost, so keeping history is the right call.)

            // B3 turn — a folder-backed skill is going to execute. Two
            // ways this can happen:
            //   1. Chip-active path: user dragged a skill onto the prompt.
            //      Detected by skill_metadata in the request body.
            //   2. Multi-skill auto-routing (Phase 6): user attached a doc
            //      AND the prompt has a deliverable verb, so the backend
            //      will force tool_choice = run_skill_script. We mirror the
            //      backend heuristic here so the overlay + indicator fire
            //      from the moment Send is clicked — without this the user
            //      sees only the chat dancing dots even though a skill is
            //      definitely about to run.
            const hasSkillMetadata = !!requestBody.skill_metadata;
            const hasConvertedAttachment = convertedDocs.length > 0;
            const messageHasDeliverableVerb = /\b(create|generate|make|build|produce|edit|update|replace|fix|correct|swap|change|modify|revise)\b|in the (document|file)\b|attached (html|document|file)/i.test(message);
            const isAutoRoutedSkill = !hasSkillMetadata
                && Array.isArray(availableSkills) && availableSkills.length > 0
                && hasConvertedAttachment
                && messageHasDeliverableVerb;
            const isB3Turn = hasSkillMetadata || isAutoRoutedSkill;
            if (isB3Turn) {
                // Centered overlay + indicator mode — covers the chat input
                // and shows feedback while the skill is running. The actual
                // dual-pane layout (when Compare is enabled) is set up
                // further down in the compareSkillLayout block so we don't
                // duplicate/conflict with it here.
                const skillName = this.activeSkill?.name
                    || this.activeSkill?.dir_name
                    || (isAutoRoutedSkill ? 'a skill' : 'skill');
                const providerLabel = this.getProviderDisplayName(this.currentProvider);
                this._showB3Overlay(`Working with ${skillName} — ${providerLabel} is thinking…`);
                this._enterB3IndicatorMode();
            } else if (this.activeSplitMode === 'artifact') {
                // Non-skill turn: tear down any leftover artifact pane so
                // the chat returns to single-column. The artifact + the
                // skill that produced it are no longer in the conversation
                // context — they were a one-shot result.
                this.hideArtifactPane();
            }

            // Promote freshly-uploaded entries to 'active' so they keep
            // appearing in the strip and keep being sent on subsequent turns.
            // Failed/still-uploading entries are left alone. The strip is
            // re-rendered so the chips lose their spinner. Cleared only by
            // New Chat / Clear Chat / loading another conversation, or by the
            // user clicking the × on an individual chip.
            let promoted = false;
            for (const entry of this.pendingAttachments) {
                if (entry.status === 'done') {
                    entry.status = 'active';
                    promoted = true;
                }
            }
            if (promoted) this.renderAttachmentChips();

            // Parallel-compare setup. Both panes process the SAME prompt
            // (same skill, same attachments) on their OWN provider, in
            // parallel. We do this by firing two SSE requests
            // concurrently from the browser:
            //   - /api/v1/chat   for the primary provider
            //   - /api/v1/compare for the comparer
            // Each stream feeds its own pane independently. No backend
            // sequencing, no merging — the user sees both LLMs reading
            // the prompt at the same time, side by side.
            //
            // We override compare_enabled to false in the primary body so
            // the backend doesn't ALSO try to run a sequential compare
            // pass; that would double-bill and serialize what we just
            // parallelized.
            const compareInParallel = !!(this.compareEnabled && this.selectedComparer);
            if (compareInParallel) {
                requestBody.compare_enabled = false;
                // /api/v1/compare doesn't emit `compare_start` (only
                // handleComparison in the sequential path does), so the
                // bubble has to be created here, before the request
                // fires. Reset all the compare-streaming parser state at
                // the same time so a previous turn's leftovers don't
                // leak into this one.
                compareMsgId = this.addCompareMessage('assistant', '', true);
                this.compareParserState = null;
                this.compareBuffer = '';
                this.compareDisplayHtml = '';
                this.compareFullContent = '';
                this.compareCarryOver = '';
                this.compareCurrentCodeBlockPlaceholder = null;
            }

            // 2-IFRAME COMPARE LAYOUT — switch the moment we know this
            // is a compare turn that will produce file-system artifacts
            // (skill with transform). The chat bubbles still get created
            // in the DOM and stream as usual; CSS just hides them so the
            // user sees only the deliverables side-by-side. Placeholder
            // content goes into both artifact panes immediately so the
            // user has visual feedback during the wait. Each pane's
            // content gets replaced with the real iframe when its
            // provider's pyodide finishes — the existing
            // showArtifactPane / openCompareArtifactPane methods clear
            // and rewrite innerHTML wholesale, so the placeholders are
            // overwritten cleanly.
            const compareSkillLayout = compareInParallel && turnRunsSkillTransform;
            // Capture turn start time when the layout flips to 2-iframe
            // mode. Used to compute elapsed-time-to-artifact for each
            // pane's header badge. performance.now() is monotonic and
            // sub-millisecond precise — much better than Date.now() for
            // measuring durations.
            const turnStartTime = compareSkillLayout ? performance.now() : null;
            this._compareSkillTurnStartTime = turnStartTime;
            // Reset the badges from any previous compare turn.
            if (this.artifactElapsedBadge) {
                this.artifactElapsedBadge.textContent = '';
                this.artifactElapsedBadge.classList.add('hidden');
            }
            if (this.compareArtifactElapsedBadge) {
                this.compareArtifactElapsedBadge.textContent = '';
                this.compareArtifactElapsedBadge.classList.add('hidden');
            }
            if (this.artifactTokensBadge) {
                this.artifactTokensBadge.textContent = '';
                this.artifactTokensBadge.classList.add('hidden');
            }
            if (this.compareArtifactTokensBadge) {
                this.compareArtifactTokensBadge.textContent = '';
                this.compareArtifactTokensBadge.classList.add('hidden');
            }
            // Per-provider token accumulators. Each compare-skill turn
            // has two LLM phases per side: the initial tool-call shot
            // and the post-tool-result continuation. We sum both so the
            // badge reflects total LLM spend for that provider on this
            // turn. Reset here so a previous turn's counts don't leak.
            this._primaryUsage = { input: 0, output: 0 };
            this._compareUsage = { input: 0, output: 0 };
            // If THIS turn isn't a compare+skill turn, drop any leftover
            // 2-iframe layout from a previous compare+skill turn — chat
            // panes need to come back into view for normal/text/compare-
            // text turns. Also reset any custom flex sizing the user
            // dragged into place so the next compare turn starts at
            // 50/50 again.
            if (!compareSkillLayout && this.messagesWrapper) {
                this.messagesWrapper.classList.remove('compare-artifacts-mode');
                // Tear down the artifact panes from the previous turn so the
                // current (non-skill) turn shows the chat bubbles instead of
                // stale iframes. Without this the user sees the new prompt's
                // chat bubble on the primary side but the OLD compare-artifact
                // on the comparer side — confusing.
                if (this.artifactPane) {
                    this.artifactPane.style.flex = '';
                    this.artifactPane.classList.add('hidden');
                    if (this.artifactPaneContent) this.artifactPaneContent.innerHTML = '';
                }
                if (this.compareArtifactPane) {
                    this.compareArtifactPane.style.flex = '';
                    this.compareArtifactPane.classList.add('hidden');
                    if (this.compareArtifactPaneContent) this.compareArtifactPaneContent.innerHTML = '';
                }
                // If compare/verify mode is still on, make sure the split
                // layout is fully in place so the secondary chat bubble
                // is visible. Without `split-active` on messagesWrapper,
                // CSS pins `#compare-pane` and `#verifier-pane` to
                // opacity:0 — they're in the DOM with content but
                // invisible. Closing the failed artifact pane (X button)
                // strips `split-active` via hideArtifactPane; this puts
                // it back at the next turn's boot.
                if ((this.compareEnabled && this.selectedComparer) ||
                    (this.verificationEnabled && this.selectedVerifier)) {
                    this.messagesWrapper.classList.add('split-active');
                    this.splitPaneActive = true;
                    this.activeSplitMode = this.compareEnabled ? 'compare' : 'verifier';
                    if (this.splitPaneDivider) this.splitPaneDivider.classList.remove('hidden');
                    if (this.primaryPaneHeader) this.primaryPaneHeader.classList.remove('hidden');
                    if (this.comparePane && this.compareEnabled) {
                        this.comparePane.classList.remove('hidden');
                    }
                    if (this.verifierPane && this.verificationEnabled) {
                        this.verifierPane.classList.remove('hidden');
                    }
                }
            }
            if (compareSkillLayout) {
                if (this.messagesWrapper) {
                    this.messagesWrapper.classList.add('split-active');
                    this.messagesWrapper.classList.add('compare-artifacts-mode');
                }
                if (this.splitPaneDivider) {
                    this.splitPaneDivider.classList.remove('hidden');
                }
                const placeholderHtml = (providerName) => `
                    <div style="height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:#6b7280; background:#fafafa;">
                        <svg class="animate-spin" style="width:32px;height:32px;color:#3b82f6;" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.25"></circle>
                            <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"></path>
                        </svg>
                        <div style="font-size:0.95rem; font-weight:500;">${this.escapeHtmlLocal(providerName)}: thinking…</div>
                    </div>`;
                if (this.artifactPane && this.artifactPaneContent) {
                    this.artifactPane.classList.remove('hidden');
                    this.artifactPaneContent.innerHTML = placeholderHtml(this.getProviderDisplayName(this.currentProvider));
                    if (this.artifactPanePath) this.artifactPanePath.textContent = '';
                    if (this.artifactProviderBadge) {
                        this.artifactProviderBadge.textContent = this.getProviderDisplayName(this.currentProvider);
                        this.artifactProviderBadge.classList.remove('hidden');
                    }
                }
                if (this.compareArtifactPane && this.compareArtifactPaneContent) {
                    this.compareArtifactPane.classList.remove('hidden');
                    this.compareArtifactPaneContent.innerHTML = placeholderHtml(this.getProviderDisplayName(this.selectedComparer));
                    if (this.compareArtifactPanePath) this.compareArtifactPanePath.textContent = '';
                    if (this.compareArtifactProviderBadge) {
                        this.compareArtifactProviderBadge.textContent = this.getProviderDisplayName(this.selectedComparer);
                        this.compareArtifactProviderBadge.classList.remove('hidden');
                    }
                }
            }

            // The compareOnly endpoint expects compare_provider (not
            // provider) and ignores verifier/compare flags.
            const compareRequestBody = compareInParallel ? (() => {
                const b = { ...requestBody, compare_provider: this.selectedComparer };
                delete b.provider;
                delete b.verification_enabled;
                delete b.verifier_provider;
                delete b.compare_enabled;
                return b;
            })() : null;

            const primaryFetchP = fetch(window.apiUrl('/chat'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(requestBody),
                signal: this.abortController.signal
            });
            const compareFetchP = compareRequestBody
                ? fetch(window.apiUrl('/compare'), {
                    method: 'POST',
                    headers: this.getAuthHeaders(),
                    body: JSON.stringify(compareRequestBody),
                    signal: this.abortController.signal,
                }).catch(e => {
                    console.error('[compare parallel] fetch failed:', e);
                    if (compareMsgId) {
                        this.updateMessage(compareMsgId,
                            `**Comparison Error:** ${e?.message || e}`, false);
                    }
                    return null;
                })
                : null;

            const response = await primaryFetchP;

            // Check for quota exceeded (free trial limit)
            if (response.status === 403) {
                const errData = await response.json().catch(() => ({}));
                if (errData.code === 'QUOTA_EXCEEDED') {
                    this.updateMessage(assistantMsgId, `**Free trial quota reached.**\n\nYou have used all ${(errData.usage?.quota || 50000).toLocaleString()} tokens in your free trial. To continue using Synergy AI Chat, please upgrade to a paid plan.\n\n<a href="payment.html" style="display:inline-block;padding:8px 20px;background:#2563eb;color:white;border-radius:6px;text-decoration:none;font-weight:600;" onclick="localStorage.setItem('selectedPlan',JSON.stringify({id:'standard',name:'Synergy AI Standard',price:9.95,currency:'USD',interval:'month',features:[]}))">Upgrade to Standard — $9.95/mo</a>`);
                    this.hideProgress();
                    this.isLoading = false;
                    this.sendBtn.disabled = false;
                    return;
                }
            }

            // NON-STREAMING PATH (skill turns that run a transform).
            // The backend's handleRegularChat returned a single JSON
            // body — no SSE chunks to read. Dispatch any pending
            // client-side tool call directly, then handle the assistant
            // text. We branch out here so the entire SSE reader / chunk
            // loop / buffer accumulator below doesn't run for these
            // turns. That's the point of the rule: streaming machinery
            // exists only for turns that progressive-render.
            if (!requestBody.streaming) {
                const data = await response.json().catch(e => {
                    console.error('[non-streaming] response.json() failed:', e);
                    return null;
                });
                // Phase 1 (initial tool-call shot) usage for the primary.
                // handleRegularChat puts the provider's usage on the JSON
                // body directly. Add to the accumulator now; the badge
                // gets rendered when the artifact pane opens, and is
                // updated again when the Phase 2 continuation lands.
                this._addUsageToAccumulator(this._primaryUsage, data?.usage);
                if (!data) {
                    this.updateMessage(assistantMsgId,
                        `**Error:** Unable to parse non-streaming response.`, false);
                } else if (data.success === false) {
                    this.updateMessage(assistantMsgId,
                        `**Error:** ${data.error || 'Unknown failure'}`, false);
                } else if (data.pending_client_tool_call) {
                    // Same dispatch path the streaming flow uses, just
                    // synthesizing the client_tool_call payload from
                    // the JSON body fields.
                    try {
                        const continuation = await this.dispatchClientToolCall(
                            {
                                assistant_text: data.assistant_text || data.text || '',
                                tool_calls: data.pending_tool_calls || [],
                            },
                            {
                                assistantMsgId,
                                userMessage,
                                baseRequestBody: requestBody,
                                activeSkill: effectiveSkill || this.activeSkill,
                            }
                        );
                        if (continuation && continuation.finalResponse) {
                            // Token usage / final-response metadata for the
                            // tail of the post-stream block below.
                            this._nonStreamFinalResponse = continuation.finalResponse;
                            // Phase 2 (post-tool-result continuation) usage
                            // for the primary — accumulate and re-render
                            // the tokens badge now that the full turn
                            // total is known.
                            this._addUsageToAccumulator(this._primaryUsage, continuation.finalResponse.usage);
                            this._renderTokensBadge(this.artifactTokensBadge, this._primaryUsage);
                        }
                    } catch (e) {
                        console.error('[non-streaming] tool dispatch failed:', e);
                        this.appendChunk(assistantMsgId,
                            `\n\n_Tool execution failed: ${e.message || e}_`);
                    }
                    // Defensive finalize: re-render the bubble with the
                    // accumulated content and `isStreaming=false` so the
                    // typing-indicator dots are removed. The continuation
                    // SSE may or may not emit a 'response' event with
                    // non-empty text (depends on whether the model wrote
                    // a summary or chose to dispatch another tool), so we
                    // can't rely on handleSSEEvent's 'response' case to
                    // clear the indicator. Calling updateMessage with a
                    // string content path replaces innerHTML wholesale,
                    // wiping any leftover typing indicator span.
                    if (this.fullContent) {
                        this.updateMessage(assistantMsgId, this.fullContent, false);
                    }
                } else {
                    // Plain text answer — render it into the assistant
                    // bubble in one shot.
                    this.fullContent = data.text || '';
                    this.updateMessage(assistantMsgId, this.fullContent, false);
                }

                // Push the user + assistant turns into history so the
                // next request includes this exchange.
                if (this.fullContent) {
                    this.conversationHistory.push(userMessage);
                    this.conversationHistory.push({
                        role: 'assistant',
                        content: this.fullContent,
                        provider: this.currentProvider,
                    });
                }

                // PARALLEL COMPARE — the non-streaming branch above
                // returns early, skipping the SSE reader where the
                // compareFetchP gets consumed in the streaming path.
                // We have to consume it here too, otherwise the
                // /api/v1/compare request fires, stays unread, and the
                // comparer's tool call never dispatches (= "Kimi never
                // returns content" in the UI).
                if (compareFetchP) {
                    let pendingComparerToolCall = null;
                    try {
                        const compareResp = await compareFetchP;
                        if (compareResp && compareResp.ok) {
                            const cReader = compareResp.body.getReader();
                            const cDecoder = new TextDecoder();
                            let cBuffer = '';
                            // Inline SSE parser — mirrors
                            // consumeCompareStream in the streaming
                            // path, but only captures the events the
                            // compare-skill flow needs:
                            // compare_client_tool_call → drives the
                            // dispatch; compare_chunk/_response are
                            // ignored because the chat bubble is hidden.
                            while (true) {
                                const { done, value } = await cReader.read();
                                if (done) break;
                                cBuffer += cDecoder.decode(value, { stream: true });
                                while (true) {
                                    const idx = cBuffer.indexOf('\n\n');
                                    if (idx === -1) break;
                                    const block = cBuffer.substring(0, idx);
                                    cBuffer = cBuffer.substring(idx + 2);
                                    if (!block.trim()) continue;
                                    let evt = null, payload = '', payloadLineCount = 0;
                                    for (const ln of block.split('\n')) {
                                        if (ln.startsWith('event:')) {
                                            evt = ln.substring(6).trim();
                                        } else if (ln.startsWith('data:')) {
                                            const dl = ln.substring(5);
                                            const lc = dl.startsWith(' ') ? dl.substring(1) : dl;
                                            if (payloadLineCount > 0) payload += '\n';
                                            payload += lc;
                                            payloadLineCount++;
                                        }
                                    }
                                    if (evt === 'compare_client_tool_call' && payload) {
                                        try {
                                            pendingComparerToolCall = JSON.parse(payload);
                                            console.log('🔧 [compare_client_tool_call] received (non-streaming):', pendingComparerToolCall);
                                        } catch (e) {
                                            console.error('Failed to parse compare_client_tool_call:', e);
                                        }
                                    } else if (evt === 'compare_response' && payload) {
                                        // Phase 1 (initial tool-call shot)
                                        // usage for the comparer. Same
                                        // pattern as the primary above —
                                        // accumulate now, render when the
                                        // artifact pane opens.
                                        try {
                                            const r = JSON.parse(payload);
                                            this._addUsageToAccumulator(this._compareUsage, r?.usage);
                                        } catch (e) {
                                            console.error('Failed to parse compare_response usage:', e);
                                        }
                                    } else if (evt === 'compare_error' && payload) {
                                        let compareErrMsg;
                                        try { compareErrMsg = JSON.parse(payload).message; }
                                        catch (e) { compareErrMsg = payload; }
                                        console.error('[non-streaming compare] error event:', compareErrMsg);
                                        if (this.compareArtifactPane && !this.compareArtifactPane.classList.contains('hidden')) {
                                            this._renderArtifactPaneError(
                                                'compare',
                                                this.getProviderDisplayName(this.selectedComparer),
                                                compareErrMsg
                                            );
                                        }
                                    }
                                }
                            }
                        } else if (compareResp) {
                            console.error('[non-streaming compare] HTTP', compareResp.status);
                        }
                    } catch (e) {
                        console.error('[non-streaming compare] stream consume failed:', e);
                    }
                    if (pendingComparerToolCall && compareMsgId) {
                        try {
                            await this.dispatchCompareClientToolCall(
                                pendingComparerToolCall,
                                {
                                    compareMsgId,
                                    assistantMsgId,
                                    userMessage,
                                    baseRequestBody: requestBody,
                                    activeSkill: effectiveSkill || this.activeSkill,
                                }
                            );
                        } catch (e) {
                            console.error('[non-streaming compare] dispatch failed:', e);
                            if (this.compareArtifactPaneContent) {
                                this.compareArtifactPaneContent.innerHTML =
                                    `<div style="padding:16px; color:#b91c1c;">Compare execution failed: ${this.escapeHtmlLocal(String(e?.message || e))}</div>`;
                            }
                        }
                    }
                }

                // Save context, finalize UI, and exit the function —
                // skipping the SSE reader entirely.
                this.saveCurrentContext().catch(err => {
                    console.error('❌ Failed to auto-save context:', err);
                });
                this.hideProgress();
                this.isLoading = false;
                if (this.sendBtn) this.sendBtn.disabled = false;
                // Belt-and-braces: scrub any lingering typing-indicator
                // dots in the messages container. The streaming/dispatch
                // path normally removes them via bubble.innerHTML='' when
                // the first chunk arrives, but if the continuation
                // produced no chunks (e.g. backend returned a 'response'
                // event with the full text directly), the placeholder
                // span stays orphaned in the DOM. Find any
                // .typing-indicator nodes still present and detach them.
                try {
                    document.querySelectorAll('.typing-indicator').forEach(el => el.remove());
                } catch (_) { /* ignore */ }
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalResponse = null;
            // B3: captured when the backend forwards a `client_tool_call`
            // SSE event; consumed after the stream ends to dispatch via
            // window.pyodideRunner and re-issue /chat with the tool result.
            let pendingClientToolCall = null;
            // Compare-pane parity: same shape, but for the comparer pane.
            // Backend renames the comparer's `client_tool_call` to
            // `compare_client_tool_call` so the two panes don't collide.
            // Consumed after the stream ends to run pyodide for the
            // compare pane and re-issue /api/v1/compare with its own
            // tool_result tail.
            let pendingComparerToolCall = null;

            // The compare-stream reader (parallel mode). Awaits its own
            // /api/v1/compare response and processes only compare_*
            // events, routing them to the compare bubble. Runs
            // concurrently with the primary loop via Promise.all below.
            const compareResponse = compareFetchP ? await compareFetchP : null;
            const compareReader = (compareResponse && compareResponse.ok)
                ? compareResponse.body.getReader()
                : null;
            if (compareResponse && !compareResponse.ok) {
                console.error('[compare parallel] response not ok:', compareResponse.status);
                if (compareMsgId) {
                    this.updateMessage(compareMsgId,
                        `**Comparison Error:** HTTP ${compareResponse.status}`, false);
                }
            }
            const consumeCompareStream = async () => {
                if (!compareReader) return;
                const cDecoder = new TextDecoder();
                let cBuffer = '';
                while (true) {
                    const { done, value } = await compareReader.read();
                    if (done) break;
                    cBuffer += cDecoder.decode(value, { stream: true });
                    while (true) {
                        const idx = cBuffer.indexOf('\n\n');
                        if (idx === -1) break;
                        const block = cBuffer.substring(0, idx);
                        cBuffer = cBuffer.substring(idx + 2);
                        if (!block.trim()) continue;
                        let event = null, data = '', dataLineCount = 0;
                        for (const line of block.split('\n')) {
                            if (line.startsWith('event:')) {
                                event = line.substring(6).trim();
                            } else if (line.startsWith('data:')) {
                                const dl = line.substring(5);
                                const lc = dl.startsWith(' ') ? dl.substring(1) : dl;
                                if (dataLineCount > 0) data += '\n';
                                data += lc;
                                dataLineCount++;
                            }
                        }
                        if (!event || !data) continue;

                        if (event === 'compare_progress') {
                            this.showProgress(`[Compare] ${data}`);
                        } else if (event === 'compare_chunk') {
                            if (compareMsgId) {
                                this.appendCompareChunk(compareMsgId, data);
                                this.scrollCompareToBottom();
                            }
                        } else if (event === 'compare_response') {
                            if (this.compareFullContent && compareMsgId) {
                                this.updateMessage(compareMsgId, this.compareFullContent, false);
                            }
                        } else if (event === 'compare_error') {
                            try {
                                const err = JSON.parse(data);
                                if (compareMsgId) {
                                    this.updateMessage(compareMsgId,
                                        `**Comparison Error:** ${err.message || data}`, false);
                                }
                            } catch (e) {
                                if (compareMsgId) {
                                    this.updateMessage(compareMsgId,
                                        `**Comparison Error:** ${data}`, false);
                                }
                            }
                            console.error('Compare error:', data);
                        } else if (event === 'compare_complete') {
                            // No-op (cleanup only).
                        } else if (event === 'compare_client_tool_call') {
                            try {
                                pendingComparerToolCall = JSON.parse(data);
                                console.log('🔧 [compare_client_tool_call] received (parallel):', pendingComparerToolCall);
                            } catch (e) {
                                console.error('Failed to parse compare_client_tool_call payload:', e);
                            }
                        }
                        // Other events are ignored on the compare stream;
                        // primary stream owns chunk/response/etc.
                    }
                }
            };
            const compareStreamP = consumeCompareStream();

            const consumePrimaryStream = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                while (true) {
                    const doubleNewline = buffer.indexOf('\n\n');
                    if (doubleNewline === -1) break;

                    const eventBlock = buffer.substring(0, doubleNewline);
                    buffer = buffer.substring(doubleNewline + 2);

                    if (!eventBlock.trim()) continue;

                    const lines = eventBlock.split('\n');
                    let event = null;
                    let data = '';
                    let dataLineCount = 0;

                    for (const line of lines) {
                        if (line.startsWith('event:')) {
                            event = line.substring(6).trim();
                        } else if (line.startsWith('data:')) {
                            // Don't trim data - it could be whitespace-only chunks
                            const dataLine = line.substring(5);
                            // Only trim if it starts with space (SSE format padding)
                            const lineContent = dataLine.startsWith(' ') ? dataLine.substring(1) : dataLine;

                            // SSE spec: multiple data: lines should be joined with newlines
                            if (dataLineCount > 0) {
                                data += '\n';
                            }
                            data += lineContent;
                            dataLineCount++;
                        }
                    }

                    if (event && data) {
                        // Handle verification events separately
                        if (event === 'verification_start') {
                            // Create verifier message bubble with streaming indicator
                            verifierMsgId = this.addVerifierMessage('assistant', '', true);
                            // Initialize verifier streaming content
                            this.verifierFullContent = '';
                        } else if (event === 'verification_progress') {
                            // Use the SAME showProgress as main LLM for consistent UI
                            this.showProgress(`[Verifier] ${data}`);
                        } else if (event === 'verifier_chunk') {
                            // Accumulate content and render with markdown (same as final render)
                            if (verifierMsgId) {
                                this.verifierFullContent += data;
                                // Use the SAME renderMarkdown as main response for consistent formatting
                                const wrapper = document.getElementById(verifierMsgId);
                                if (wrapper) {
                                    const bubble = wrapper.querySelector('div') || wrapper.children[0];
                                    if (bubble) {
                                        const renderedHtml = this.renderMarkdown(this.verifierFullContent);
                                        bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div><span class="inline-block w-2 h-4 bg-green-500 animate-pulse ml-1"></span>`;
                                    }
                                }
                                this.scrollVerifierToBottom();
                            }
                        } else if (event === 'verification_response') {
                            // Final verification response - render with full markdown
                            // Use client-accumulated content (like main response) to ensure all
                            // streamed content is captured, especially when tool calls are involved
                            if (this.verifierFullContent && verifierMsgId) {
                                this.updateMessage(verifierMsgId, this.verifierFullContent, false);
                            }
                        } else if (event === 'verification_complete') {
                            // Verification done - cleanup only, rendering already done by verification_response
                            // Do NOT call updateMessage here to avoid overwriting the correct render
                        } else if (event === 'verification_error') {
                            // Handle verification errors - display error message in verifier bubble
                            try {
                                const errorData = JSON.parse(data);
                                const errorMessage = errorData.message || 'Verification failed';
                                if (verifierMsgId) {
                                    this.updateMessage(verifierMsgId, `**Verification Error:** ${errorMessage}`, false);
                                }
                            } catch (e) {
                                // If data is a plain string
                                if (verifierMsgId) {
                                    this.updateMessage(verifierMsgId, `**Verification Error:** ${data}`, false);
                                }
                            }
                            console.error('Verification error:', data);
                        } else if (event === 'compare_start') {
                            // Create compare message bubble with streaming indicator
                            compareMsgId = this.addCompareMessage('assistant', '', true);
                            // Reset compare streaming parser state so the compare panel
                            // uses the same incremental parser as the primary panel
                            // (buffers code/SVG blocks and shows a placeholder until
                            // the closing ``` arrives).
                            this.compareParserState = null;
                            this.compareBuffer = '';
                            this.compareDisplayHtml = '';
                            this.compareFullContent = '';
                            this.compareCarryOver = '';
                            this.compareCurrentCodeBlockPlaceholder = null;
                        } else if (event === 'compare_progress') {
                            // Use the SAME showProgress as main LLM for consistent UI
                            this.showProgress(`[Compare] ${data}`);
                        } else if (event === 'compare_chunk') {
                            // Route through the same streaming parser as the primary
                            // panel so in-progress SVG/code blocks render as a
                            // placeholder instead of raw streamed markup.
                            if (compareMsgId) {
                                this.appendCompareChunk(compareMsgId, data);
                                this.scrollCompareToBottom();
                            }
                        } else if (event === 'compare_response') {
                            // Final compare response - render with full markdown
                            // Use client-accumulated content (like main response) to ensure all
                            // streamed content is captured, especially when tool calls are involved
                            if (this.compareFullContent && compareMsgId) {
                                this.updateMessage(compareMsgId, this.compareFullContent, false);
                            }
                        } else if (event === 'compare_error') {
                            // Handle compare errors - display error message in compare bubble
                            try {
                                const errorData = JSON.parse(data);
                                const errorMessage = errorData.message || 'Comparison failed';
                                if (compareMsgId) {
                                    this.updateMessage(compareMsgId, `**Comparison Error:** ${errorMessage}`, false);
                                }
                            } catch (e) {
                                // If data is a plain string
                                if (compareMsgId) {
                                    this.updateMessage(compareMsgId, `**Comparison Error:** ${data}`, false);
                                }
                            }
                            console.error('Compare error:', data);
                        } else if (event === 'compare_complete') {
                            // Comparison done - cleanup only
                        } else if (event === 'client_tool_call') {
                            // B3: backend short-circuited because the LLM
                            // invoked a client-side tool (run_skill_script
                            // today). Capture the payload — we'll dispatch
                            // it after the stream ends.
                            try {
                                pendingClientToolCall = JSON.parse(data);
                                console.log('🔧 [client_tool_call] received:', pendingClientToolCall);
                            } catch (e) {
                                console.error('Failed to parse client_tool_call payload:', e);
                            }
                        } else if (event === 'compare_client_tool_call') {
                            // Compare pane parity: the comparer also
                            // short-circuited with a client-side tool call.
                            // Captured separately so the post-stream
                            // dispatcher can run pyodide for the compare
                            // pane and feed the result back via
                            // /api/v1/compare without colliding with the
                            // primary pane's continuation.
                            try {
                                pendingComparerToolCall = JSON.parse(data);
                                console.log('🔧 [compare_client_tool_call] received:', pendingComparerToolCall);
                            } catch (e) {
                                console.error('Failed to parse compare_client_tool_call payload:', e);
                            }
                        } else {
                            // Handle regular events
                            this.handleSSEEvent(event, data, assistantMsgId);

                            if (event === 'response') {
                                try {
                                    finalResponse = JSON.parse(data);
                                } catch (e) {
                                    console.error('Parse error:', e);
                                }
                            }
                        }
                    }
                }
            }
            }; // close consumePrimaryStream

            // Run primary and compare streams concurrently. Each handler
            // routes its own events to its own pane — there's no merging.
            // Errors on the compare side don't fail the primary, since
            // the user's main work is the primary response.
            await Promise.all([
                consumePrimaryStream(),
                compareStreamP.catch(e => {
                    console.error('[compare parallel] stream consumer failed:', e);
                    if (compareMsgId) {
                        this.updateMessage(compareMsgId,
                            `**Comparison Error:** ${e?.message || e}`, false);
                    }
                }),
            ]);

            // B3: if the LLM short-circuited with a client-side tool call,
            // dispatch it now (window.pyodideRunner) and re-issue /chat
            // with the tool_result prepended so Claude can produce its
            // real answer. This may itself short-circuit again — the
            // helper handles recursion up to a small bounded depth.
            //
            // Compare-pane parity: capture compareMsgId now so we can
            // pass it to the compare-pane dispatcher AFTER the primary
            // dispatch resolves. Pyodide is a single shared instance —
            // the two dispatches must run sequentially, not concurrently.
            const _compareMsgIdForDispatch = compareMsgId;
            if (pendingClientToolCall) {
                try {
                    const continuation = await this.dispatchClientToolCall(
                        pendingClientToolCall,
                        {
                            assistantMsgId,
                            userMessage,
                            baseRequestBody: requestBody,
                            // Pin the active skill onto the dispatch context.
                            // Three sources, in priority order:
                            //   1. autoPickedSkill — the heuristic-matched
                            //      skill on auto-routing turns where no chip
                            //      was dragged. Without this the recursive
                            //      run_skill_script dispatch can't resolve
                            //      dir_name (single-skill schema doesn't
                            //      include dir_name as a tool parameter).
                            //   2. this.activeSkill — the chip-dragged case.
                            //   3. null — falls through to the multi-skill
                            //      flow's own dirName resolution from
                            //      call.input.dir_name.
                            // _finalizeB3UIAfterArtifact clears this.activeSkill
                            // after the first artifact renders, but a multi-step
                            // skill (e.g. extract.py → create.py) still needs the
                            // dir_name on the recursive dispatch. Reading from ctx
                            // keeps the second tool call working.
                            activeSkill: effectiveSkill || this.activeSkill,
                        }
                    );
                    if (continuation && continuation.finalResponse) {
                        finalResponse = continuation.finalResponse;
                    }
                } catch (e) {
                    console.error('❌ Client tool dispatch failed:', e);
                    this.appendChunk(assistantMsgId,
                        `\n\n_Tool execution failed: ${e.message || e}_`);
                }
            }

            // Compare-pane dispatch: runs sequentially after the primary
            // since pyodide is a single shared instance. This is what
            // gives the user true apples-to-apples evaluation — both
            // panes execute their tool call and produce a summary in
            // their respective bubbles.
            if (pendingComparerToolCall && _compareMsgIdForDispatch) {
                try {
                    await this.dispatchCompareClientToolCall(
                        pendingComparerToolCall,
                        {
                            compareMsgId: _compareMsgIdForDispatch,
                            assistantMsgId,
                            userMessage,
                            baseRequestBody: requestBody,
                            activeSkill: effectiveSkill || this.activeSkill,
                        }
                    );
                } catch (e) {
                    console.error('❌ Compare-pane tool dispatch failed:', e);
                    if (_compareMsgIdForDispatch) {
                        this.appendCompareChunk(_compareMsgIdForDispatch,
                            `\n\n_Compare-pane tool execution failed: ${e.message || e}_`);
                    }
                }
            }

            // Re-render the final message with full markdown support (for tables, etc.)
            if (this.fullContent) {
                this.updateMessage(assistantMsgId, this.fullContent, false);
            }

            // Add to conversation history using streamed content
            if (this.fullContent) {
                this.conversationHistory.push(userMessage);
                this.conversationHistory.push({
                    role: 'assistant',
                    content: this.fullContent,
                    provider: this.currentProvider
                });
            } else {
                console.warn('⚠️ fullContent is empty, not adding to history');
            }

            // Apply final response metadata from backend
            if (finalResponse) {

                if (finalResponse.usage) {
                    const inputTokens = finalResponse.usage.input_tokens || finalResponse.usage.prompt_tokens || 0;
                    const outputTokens = finalResponse.usage.output_tokens || finalResponse.usage.completion_tokens || 0;
                    const totalTokens = finalResponse.usage.total_tokens || (inputTokens + outputTokens);
                    this.totalTokens += totalTokens;
                    // Show breakdown: In: X | Out: Y | Total: Z
                    this.tokenInfo.textContent = `In: ${inputTokens.toLocaleString()} | Out: ${outputTokens.toLocaleString()} | Total: ${this.totalTokens.toLocaleString()}`;
                }
            }

            // Auto-save context after assistant response (non-blocking)
            this.saveCurrentContext().catch(err => {
                console.error('❌ Failed to auto-save context:', err);
                // Show user-visible error notification
                this.showNotification(
                    '⚠️ Failed to save conversation. Please check if you are logged in.',
                    'error'
                );
            });

        } catch (error) {
            if (error.name === 'AbortError') {
                if (this._abortReasonNewTurn) {
                    // Programmatic abort triggered by a new sendMessage —
                    // the previous B3 stream is being torn down because
                    // the user moved on. Bubbles stay in the DOM with
                    // whatever was streamed; conversation_history was
                    // already updated at the top of the new sendMessage.
                    console.log('Previous B3 stream aborted to make room for new turn');
                    this._abortReasonNewTurn = false;
                } else {
                    console.log('Request cancelled by user');
                    // Remove the user and assistant message bubbles from the DOM
                    const userEl = document.getElementById(userMsgId);
                    const assistantEl = document.getElementById(assistantMsgId);
                    if (userEl) userEl.remove();
                    if (assistantEl) assistantEl.remove();
                    // Do NOT add to conversation history
                }
            } else {
                console.error('Chat error:', error);
                this.updateMessage(assistantMsgId, `${window.i18n.t('messages.error')}: ${error.message}`);
            }
        } finally {
            this.isLoading = false;
            this.sendBtn.classList.remove('hidden');
            this.sendBtn.disabled = false;
            this.hideProgress();
            // B3: clear the centered overlay and restore Stop button styling
            // unconditionally — idempotent if the turn wasn't a B3 round.
            this._hideB3Overlay();
            // _exitB3IndicatorMode restores Stop's saved className, which
            // was captured WITHOUT the `hidden` class (Stop was visible
            // mid-turn). Hiding Stop must happen AFTER the className
            // restore, otherwise the restore re-shows Stop and the user
            // ends up with both Send and Stop buttons rendered side by
            // side. Same ordering is already correct in _finalizeB3UIAfterArtifact.
            this._exitB3IndicatorMode();
            if (this.stopBtn) this.stopBtn.classList.add('hidden');
            // Clear lingering B3 stream-finalization markers so the next
            // turn's start-of-sendMessage check sees a clean slate.
            // (When the stream completed naturally, history was already
            // pushed in the post-loop code; nothing to recover.)
            this._b3StreamFinalized = false;
            this._lastB3UserMessage = null;
            this.scrollToBottom();
            this.abortController = null;
            this.currentUserMsgId = null;
            this.currentAssistantMsgId = null;
        }
    }

    /**
     * B3 client-side tool dispatcher.
     *
     * Runs the LLM-emitted tool call locally via window.pyodideRunner and
     * re-issues /chat with the tool_result prepended so the model can
     * deliver its real answer. The new fetch is consumed inline; if the
     * second response also short-circuits with another client_tool_call
     * we recurse, capped at MAX_DEPTH so a misbehaving model can't pin
     * the runtime forever.
     *
     * Returns { finalResponse } so the caller can pick up usage metadata
     * from whichever response actually closed the turn.
     */
    /**
     * Compare-mode output namespacing helper. Inserts the given provider
     * name as a subdirectory after `/outputs/` for every path that
     * appears in argv (after -o/--output/--out flags) and in readOutputs.
     * Used to prevent the primary and comparer from overwriting each
     * other when both pyodide runs target the same canonical filename
     * (the LLMs almost always pick the same output name from the
     * prompt's verbiage). Returns rewritten copies plus a list of
     * before→after path changes for diagnostic logging. Idempotent:
     * a path already under `/outputs/<providerName>/` is left as-is.
     */
    _rewriteOutputsForProvider(argv, readOutputs, providerName) {
        const safeProvider = String(providerName || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!safeProvider) return { argv, readOutputs, changedPaths: [] };
        const prefix = `/outputs/${safeProvider}/`;
        const changedPaths = [];
        const insertSubdir = (path) => {
            if (typeof path !== 'string' || !path.startsWith('/outputs/')) return path;
            if (path.startsWith(prefix)) return path; // already namespaced
            const rewritten = path.replace(/^\/outputs\//, prefix);
            changedPaths.push(`${path} → ${rewritten}`);
            return rewritten;
        };
        const newArgv = Array.isArray(argv) ? [...argv] : argv;
        if (Array.isArray(newArgv)) {
            for (let i = 0; i < newArgv.length - 1; i++) {
                if (newArgv[i] === '-o' || newArgv[i] === '--output' || newArgv[i] === '--out') {
                    newArgv[i + 1] = insertSubdir(newArgv[i + 1]);
                }
            }
        }
        const newReadOutputs = Array.isArray(readOutputs)
            ? readOutputs.map(insertSubdir)
            : readOutputs;
        return { argv: newArgv, readOutputs: newReadOutputs, changedPaths };
    }

    /**
     * Multi-tool-use dispatcher. The LLM may emit N tool_use blocks in a
     * single assistant response (standard Anthropic / OpenAI tool-use
     * protocol). We execute each call sequentially through the single
     * shared Pyodide instance, collect all tool_results, and continue
     * the conversation with one assistant tool_use turn (N tool_calls)
     * paired with N role:'tool' turns — exactly what the providers
     * require.
     *
     * Depth counts continuation rounds, not individual calls: a single
     * LLM round with N tool calls increments depth by 1, not N.
     */
    /**
     * Resolve the client-tool round cap for this turn. Defaults to
     * DEFAULT_MAX_ROUNDS, but an orchestrator skill (e.g. geo-audit) can
     * raise it by declaring `max_tool_rounds` in its SKILL.md frontmatter.
     *
     * The cap is the max declared budget across (a) the turn's active skill
     * — stable for the whole recursion since ctx is reused — and (b) any
     * skill referenced by dir_name in this round's tool_calls, as a backstop
     * for discover/multi-skill turns where no single activeSkill is promoted.
     * Always clamped to HARD_CEILING so a typo'd or malicious frontmatter
     * value can't pin the runtime — preserving the original safety-valve
     * intent of the constant this replaces.
     */
    _resolveRoundBudget(ctx, payload) {
        // Default raised from 6 → 10: multi-step orchestrations (geo-audit and
        // friends) legitimately need several rounds, and the per-skill
        // max_tool_rounds override only resolves when the orchestrator is the
        // active/known skill — which isn't reliable in discover/no-chip mode.
        // 10 gives real headroom for orchestration while still bounding a
        // runaway model; skills can raise further via max_tool_rounds (≤ ceiling).
        const DEFAULT_MAX_ROUNDS = 10;
        const HARD_CEILING = 24;
        const budgetOf = (skill) => {
            const n = Number.parseInt(skill?.max_tool_rounds, 10);
            return Number.isFinite(n) && n > 0 ? n : 0;
        };
        const skillsById = window.skillsManager?.skills || [];
        const lookup = (dirName) => skillsById.find(s => s?.dir_name === dirName);

        let cap = DEFAULT_MAX_ROUNDS;
        let source = 'default';
        const bump = (n, why) => { if (n > cap) { cap = n; source = why; } };
        bump(budgetOf(ctx?.activeSkill), `activeSkill:${ctx?.activeSkill?.dir_name}`);
        // Scan EVERY call's dir_name — including discover_skill, which carries the
        // orchestrator's dir_name (e.g. GEO/geo-audit) before any sub-skill runs.
        if (Array.isArray(payload?.tool_calls)) {
            for (const call of payload.tool_calls) {
                const dn = (typeof call?.input?.dir_name === 'string')
                    ? call.input.dir_name.trim() : '';
                if (dn) bump(budgetOf(lookup(dn)), `toolCall:${dn}`);
            }
        }
        cap = Math.min(cap, HARD_CEILING);

        // STICKY high-water mark per turn. ctx is reused across the whole round
        // recursion, so a budget discovered in round 0 (e.g. discover_skill for
        // geo-audit -> 12) must persist into later rounds whose payloads only
        // reference sub-skills (which carry no budget and would otherwise revert
        // to the default 6, stopping the orchestration early).
        if (ctx) {
            if ((ctx._roundBudgetHW || 0) >= cap) {
                cap = ctx._roundBudgetHW;
            } else {
                ctx._roundBudgetHW = cap;
                console.log(`[B3 budget] round cap = ${cap} (from ${source})`);
            }
        }
        return cap;
    }

    /**
     * Lazily build the Pyodide worker pool (one per Chat instance). Each
     * worker wraps assets/js/pyodide.worker.js and speaks the
     * {id,verb,payload} -> {id,ok,result|error} protocol. The pool itself
     * (sizing/queue/idle-reap) lives in pyodide-pool.js.
     */
    _makePyodidePool() {
        let workerN = 0;
        return new window.PyodideWorkerPool({
            workerFactory: () => {
                const wid = ++workerN;
                const w = new Worker('assets/js/pyodide.worker.js?v=20260626-unwrap');
                console.log(`[pool] spawned worker w${wid} (each worker loads its own Pyodide — first use is a cold start)`);
                let seq = 0;
                const pending = new Map();
                w.onmessage = (e) => {
                    const d = e.data || {};
                    // Per-worker progress timeline (Pyodide load, deps, run).
                    if (d.type === 'progress') { console.log(`[pool w${wid}] ${d.msg}`); return; }
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
                        // FSA handles in payload are structured-cloneable.
                        w.postMessage({ id, verb: 'runSkillScript', payload });
                    }),
                    terminate: () => w.terminate(),
                };
            },
        });
    }

    /**
     * Run one already-built skill request off the main thread via the worker
     * pool. Resolves the FSA handles + dependencies on the main thread (the
     * worker can't), then hands the augmented payload to the pool. Throws on
     * any pool/permission failure so the dispatcher falls back to sequential.
     * Used as the injected `runSkill` for the parallel fast path.
     */
    async _runViaPool(req) {
        if (!window.localFs) throw new Error('localFs unavailable for pool path');
        // Memoize handle resolution. A parallel round fires N _runViaPool calls
        // at once; if each independently does resolvePath('outputs',{create:true}),
        // concurrent get-or-create on the same dir can throw "could not be found".
        // Sharing one in-flight promise per path dedupes the race. Cached on the
        // instance for the session (handles stay valid).
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
        // Permission must be granted on the main thread (a worker can't prompt).
        // In practice it's already granted from the skill's first main-thread run.
        for (const h of [skillHandle, outputsHandle]) {
            if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') {
                    throw new Error('readwrite permission denied for pool path');
                }
            }
        }
        const dependencies = await window.pyodideRunner.getSkillDependencies(req.dirName);
        // Skills fetch through the same-origin backend proxy and read the auth
        // token via `window.authManager.token`. Workers have no `window`, so
        // pass the token in and let the worker expose a minimal shim — without
        // it the proxy POST is unauthenticated (401) and the skill sees HTTP 0.
        const authToken = window.authManager?.token || null;
        const [r] = await this._pyodidePool.runBatch([{
            ...req, dependencies, authToken, skillHandle, outputsHandle, prefetched: [],
        }]);
        if (!r || !r.ok) throw new Error(r ? r.error : 'pool returned no result');
        return r.result;
    }

    async dispatchClientToolCall(payload, ctx, depth = 0) {
        const MAX_DEPTH = this._resolveRoundBudget(ctx, payload);
        if (depth >= MAX_DEPTH) {
            this.appendChunk(ctx.assistantMsgId,
                `\n\n_Stopped after ${MAX_DEPTH} client-tool rounds. Do not invent results. Tell the user which tool calls succeeded, which output files exist on disk, and that the task did not complete — then stop. Do not produce a final summary, score, or report from memory or inference._`);
            return { finalResponse: null };
        }

        if (!window.pyodideRunner) {
            throw new Error('pyodideRunner is not available — cannot run client-side skill scripts.');
        }
        if (!Array.isArray(payload.tool_calls) || payload.tool_calls.length === 0) {
            throw new Error('client_tool_call payload had no tool_calls.');
        }

        // Pyodide is a single shared instance — calls within a round MUST
        // run sequentially. Collect (call, toolResultPayload) pairs in
        // order so the continuation can pair them back to their
        // tool_use_ids correctly. Merge followUpExtras across calls (only
        // discover_skill produces non-empty extras; in practice ≤1 per
        // round, so last-wins is safe).
        const results = [];
        const mergedFollowUpExtras = {};
        const total = payload.tool_calls.length;
        if (total > 1) {
            console.log(`[B3 dispatch] LLM emitted ${total} tool_use blocks in one round`);
        }

        // PARALLEL FAST PATH: a round of 2+ independent run_skill_script calls
        // runs concurrently across the Pyodide worker pool instead of serially
        // through the single main-thread instance. Guarded to skills that don't
        // need main-thread URL prefetch (fetches_urls:false) — those stay
        // sequential (their prefetch rewrites argv on the main thread). Any
        // pool/permission failure discards partials and falls through to the
        // sequential loop below, so this can never break a working round.
        if (total >= 2 && typeof Worker !== 'undefined' && window.PyodideWorkerPool
            && payload.tool_calls.every(c => c?.name === 'run_skill_script')) {
            let canPool = true;
            try {
                for (const c of payload.tool_calls) {
                    const dn = (typeof c.input?.dir_name === 'string' && c.input.dir_name.trim())
                        ? c.input.dir_name.trim()
                        : (ctx?.activeSkill || this.activeSkill)?.dir_name;
                    if (!dn || await window.pyodideRunner.getSkillFetchesUrls(dn)) { canPool = false; break; }
                }
            } catch (e) {
                console.warn('[B3 pool] fetches_urls preflight failed; using sequential path:', e);
                canPool = false;
            }
            if (canPool) {
                try {
                    if (!this._pyodidePool) this._pyodidePool = this._makePyodidePool();
                    console.log(`[B3 dispatch] ${total} run_skill_script calls — executing IN PARALLEL via worker pool (machine cores: ${navigator.hardwareConcurrency || '?'})`);
                    const tBatch = performance.now();
                    const settled = await Promise.all(payload.tool_calls.map((call, i) =>
                        this._executeSingleClientToolCall(
                            call, ctx, depth, i === total - 1, (req) => this._runViaPool(req))));
                    console.log(`[B3 dispatch] parallel round of ${total} finished in ${Math.round(performance.now() - tBatch)}ms`);
                    for (let i = 0; i < total; i++) {
                        results.push({ call: payload.tool_calls[i], toolResultPayload: settled[i].toolResultPayload });
                    }
                    return await this._continueAfterClientToolResults(
                        payload, results, ctx, depth, mergedFollowUpExtras);
                } catch (err) {
                    console.warn('[B3 dispatch] parallel pool path failed; falling back to sequential:', err);
                    results.length = 0; // discard any partial results; redo the round sequentially
                }
            }
        }

        let discoverCount = 0;
        for (let i = 0; i < total; i++) {
            const call = payload.tool_calls[i];
            const isLast = i === total - 1;
            if (call?.name === 'discover_skill') discoverCount++;
            const { toolResultPayload, followUpExtras } =
                await this._executeSingleClientToolCall(call, ctx, depth, isLast);
            results.push({ call, toolResultPayload });
            if (followUpExtras && typeof followUpExtras === 'object') {
                Object.assign(mergedFollowUpExtras, followUpExtras);
            }
        }

        // If MULTIPLE discover_skill calls happened in this round, the
        // last-wins merge above would lock the follow-up's `skill_metadata`
        // to the LAST discovered skill — and the backend then switches to
        // single-skill schema for that one skill, stripping `dir_name` from
        // run_skill_script and forcing every subsequent call to dispatch
        // against that one skill. That's wrong for orchestrators that
        // legitimately discover N skills to run them all. Each SKILL.md body
        // is already in the per-call tool_result history, so the LLM has
        // the contracts it needs; just keep the multi-skill catalog active
        // by NOT promoting any one skill via skill_metadata.
        if (discoverCount > 1) {
            console.log(`[B3 dispatch] ${discoverCount} discover_skill calls this round — clearing skill_metadata promotion so follow-up stays multi-skill`);
            for (const k of Object.keys(mergedFollowUpExtras)) {
                delete mergedFollowUpExtras[k];
            }
        }

        return await this._continueAfterClientToolResults(
            payload, results, ctx, depth, mergedFollowUpExtras,
        );
    }

    /**
     * Execute a single client tool call (Task / discover_skill /
     * run_skill_script) and return its tool_result. The continuation
     * (i.e. the next /api/v1/chat round) is NOT issued here — that's
     * the outer dispatcher's job, so N calls in one round become ONE
     * continuation request carrying N tool_results.
     *
     * Returns { toolResultPayload, followUpExtras }. followUpExtras is
     * only populated by the discover_skill branch (skill_content +
     * skill_metadata, used to promote the chosen skill to chip-
     * equivalence on the next turn).
     *
     * `isLastCallInRound` gates UI-finalization side effects that should
     * only fire once per round (e.g. _finalizeB3UIAfterArtifact). For the
     * common single-call case this is always true, so behavior is bit-
     * identical to the pre-refactor single-call path.
     */
    /**
     * POST one chat execution trace to the backend (Phase 0 self-healing).
     * Fire-and-forget — wrapped so it can never block or break the chat flow.
     */
    _postExecutionTrace(data) {
        try {
            fetch(window.apiUrl('/traces'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(data),
                keepalive: true,
            }).catch(() => {});
        } catch (_) { /* tracing must never throw */ }
    }

    async _executeSingleClientToolCall(call, ctx, depth, isLastCallInRound = true, runSkill = null) {
        // Resolve dir_name. Phase 6 multi-skill auto-routing: the model
        // picks the skill via the tool call's input.dir_name. Chip override
        // (ctx.activeSkill / this.activeSkill) is the fallback for the
        // legacy single-skill path where the backend's tool schema doesn't
        // include dir_name.
        const activeSkill = ctx?.activeSkill || this.activeSkill;
        // TRUE forced signal for tracing: only the GLOBAL chip (this.activeSkill)
        // means the user drag-dropped the skill. discover_skill promotes
        // ctx.activeSkill (local) on auto-discovery, so we must NOT read that —
        // captured here at the start, before the finalize step can clear it.
        const forcedSkill = !!this.activeSkill;
        const dirName = (typeof call.input?.dir_name === 'string' && call.input.dir_name.trim())
            ? call.input.dir_name.trim()
            : activeSkill?.dir_name;
        if (!dirName) {
            throw new Error('No skill resolved for tool call — model did not pick a dir_name and no chip override is set.');
        }
        // Look up the chosen skill's record for permission checks / URL
        // interception. Falls back to the chip-active skill record if the
        // model picked it; otherwise pulls from skillsManager.
        const chosenSkill = (activeSkill?.dir_name === dirName)
            ? activeSkill
            : (window.skillsManager?.skills || []).find(s => s?.dir_name === dirName) || activeSkill;

        // Task subagent branch. Mirrors Claude Code's Task tool: spawn an
        // isolated single-shot LLM call with no tools, using
        // skills/<dirName>/agents/<subagent_type>.md as the system prompt.
        // The work goes in input.prompt; the response text comes back as
        // the tool_result. Implementation:
        //   1. Read the agent .md from the user's local FSA mount.
        //   2. POST /api/v1/agent (the no-tools, single-pass endpoint).
        //   3. Re-issue /chat with the agent's text as the tool_result.
        if (call.name === 'Task') {
            const subagentType = (typeof call.input?.subagent_type === 'string'
                ? call.input.subagent_type.trim() : '');
            const userPrompt = (typeof call.input?.prompt === 'string'
                ? call.input.prompt : '');
            const modelOverride = (typeof call.input?.model === 'string'
                ? call.input.model.trim() : '');
            // Optional provider override. Lets the primary LLM route the
            // subagent to a cheaper or specialised provider (e.g. claude
            // primary → deepseek grader at ~10× lower cost). Falls back to
            // the current primary's provider when omitted, preserving the
            // pre-existing behaviour.
            const PROVIDER_ALLOWLIST = ['claude', 'openai', 'grok', 'gemini', 'deepseek', 'kimi', 'gamma4', 'glm'];
            const providerOverrideRaw = (typeof call.input?.provider === 'string'
                ? call.input.provider.trim().toLowerCase() : '');
            const providerOverride = PROVIDER_ALLOWLIST.includes(providerOverrideRaw)
                ? providerOverrideRaw : '';
            let taskResultPayload;
            if (!subagentType || !/^[a-z0-9_-]+$/i.test(subagentType)) {
                taskResultPayload = {
                    success: false,
                    error: `subagent_type must be a non-empty identifier (got ${JSON.stringify(call.input?.subagent_type)}). Use the basename of a file in the active skill's agents/ folder.`,
                };
            } else if (!userPrompt) {
                taskResultPayload = {
                    success: false,
                    error: 'prompt is required (the work the subagent should do).',
                };
            } else {
                try {
                    // Resolve agents/<subagent_type>.md inside the active
                    // skill's folder. window.localFs.resolvePath gives the
                    // FSA handle; we read the file as text.
                    if (!window.localFs) throw new Error('window.localFs unavailable');
                    const skillDir = await window.localFs.resolvePath(`skills/${dirName}`);
                    if (!skillDir) throw new Error(`skill folder not found: ${dirName}`);
                    const agentsDir = await skillDir.getDirectoryHandle('agents', { create: false });
                    const agentFile = await agentsDir.getFileHandle(`${subagentType}.md`, { create: false });
                    const fileObj = await agentFile.getFile();
                    const systemPrompt = await fileObj.text();
                    // Hand the work to the no-tools agent endpoint.
                    const headers = {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${window.authManager?.token || ''}`,
                    };
                    const body = {
                        prompt: userPrompt,
                        system: systemPrompt,
                        provider: providerOverride || this.currentProvider || 'claude',
                    };
                    if (modelOverride) body.model = modelOverride;
                    const resp = await fetch(window.apiUrl('/agent'), {
                        method: 'POST', headers, body: JSON.stringify(body),
                    });
                    const data = await resp.json();
                    if (!data.success) {
                        taskResultPayload = {
                            success: false,
                            error: data.error || `agent endpoint returned status ${resp.status}`,
                        };
                    } else {
                        taskResultPayload = {
                            success: true,
                            text: data.text || '',
                            usage: data.usage || null,
                            subagent_type: subagentType,
                        };
                    }
                } catch (e) {
                    taskResultPayload = {
                        success: false,
                        error: `Task subagent "${subagentType}" failed: ${e?.message || e}`,
                    };
                }
            }
            return { toolResultPayload: taskResultPayload, followUpExtras: {} };
        }

        // Progressive-disclosure branch: discover_skill returns the full
        // SKILL.md body for the requested dir_name as a tool_result. Then
        // — and this is the critical part — the follow-up request also
        // injects skill_content + skill_metadata into the request body,
        // which makes the backend treat the next turn as a chip-dragged
        // turn for this skill: the SKILL.md body is appended to the
        // system prompt (full authority, not buried in tool_result), and
        // the single-skill tool schema with forced tool_choice replaces
        // the looser multi-skill catalog. Net effect: after discover, the
        // model sees the exact same context as if the user had dragged
        // the chip onto the input. Anything less than this (e.g. body
        // only in tool_result) leaves the model treating the body as
        // optional reference material rather than a binding contract,
        // which is what we kept observing on the failed retests.
        if (call.name === 'discover_skill') {
            const skillContent = chosenSkill?.skill_content || '';
            // Enumerate the user's attached files with their /scratch/
            // paths so Phase 2 has the same attachment context that
            // chip-dragged Phase 1 would see (where the backend
            // AttachmentDispatcher prepends a reference block to the user
            // message). Without this list, the model in Phase 2 only sees
            // the raw user prompt in conversation history (no attachment
            // prefix — the backend prefix is added server-side and never
            // round-trips back to the frontend), so it has to guess the
            // attachment's filename and path. With this list, the model
            // can match prompts like "use the attached html as template"
            // to the actual file at /scratch/<original-name> and pass
            // that exact path to run_skill_script via argv -i.
            const attachedFiles = (this.pendingAttachments || [])
                .filter(a => a && (a.name || a.file?.name))
                .map(a => {
                    const name = (a.name || a.file?.name || '').trim();
                    const sizeBytes = a.size_bytes ?? a.file?.size ?? null;
                    const mime = (a.mime || a.file?.type || '').toLowerCase();
                    return {
                        name,
                        path: `/scratch/${name}`,
                        size_bytes: sizeBytes,
                        mime: mime || null,
                    };
                });
            const toolResultPayload = skillContent
                ? {
                    success: true,
                    note: `SKILL.md body for "${dirName}" loaded (${skillContent.length} chars). ` +
                          `It has been promoted to the system prompt for the next turn — read it ` +
                          `as binding instructions. Construct the run_skill_script call exactly ` +
                          `per the contract (input-file shape, example tool-call JSON, decision ` +
                          `rules). Do NOT call discover_skill again for "${dirName}" on this turn.` +
                          (attachedFiles.length > 0
                            ? ` The user attached ${attachedFiles.length} file(s) — see ` +
                              `attached_files below for their exact /scratch/ paths and pass ` +
                              `the right one to run_skill_script via argv (e.g. -i <path>).`
                            : ''),
                    dir_name: dirName,
                    skill_md: skillContent,
                    attached_files: attachedFiles,
                }
                : {
                    success: false,
                    note: `No SKILL.md body found for dir_name="${dirName}". Verify the ` +
                          `dir_name matches an installed skill from the catalog. Other ` +
                          `available skills: ` +
                          ((window.skillsManager?.skills || [])
                            .filter(s => s?.source === 'local' && s?.dir_name)
                            .map(s => s.dir_name)
                            .join(', ') || '(none)'),
                    dir_name: dirName,
                    attached_files: attachedFiles,
                };
            console.log(`[B3 discover] returning SKILL.md body for "${dirName}" (${skillContent.length} chars); ${attachedFiles.length} attachment(s) listed; promoting to skill_content + skill_metadata on follow-up`);
            // Make the chosen skill discoverable to the recursive dispatch
            // that handles Phase 2's run_skill_script call. The single-skill
            // schema used in Phase 2 (set by the backend when it sees
            // skill_metadata) does NOT include `dir_name` in its parameters
            // — that's implicit because only one skill is in scope. Without
            // the chip-dragged path's `this.activeSkill`, the recursive
            // dispatch can't resolve the dir_name and bails with
            // "No skill resolved for tool call". Setting ctx.activeSkill
            // here mirrors what the chip-drag does globally, but only for
            // this dispatch chain — clean, no global state pollution.
            if (chosenSkill) {
                ctx.activeSkill = chosenSkill;
            }
            // Promote this skill to chip-equivalent on the follow-up. The
            // backend's `if ($skillMetadata !== null)` branch kicks in,
            // declares only run_skill_script with the single-skill schema,
            // appends skill_content to the system prompt, and forces
            // tool_choice. Identical to drag-and-drop from this point.
            const followUpExtras = skillContent
                ? {
                    skill_content: skillContent,
                    skill_metadata: {
                        dir_name: dirName,
                        scripts: Array.isArray(chosenSkill?.scripts) ? chosenSkill.scripts : [],
                    },
                }
                : {};
            return { toolResultPayload, followUpExtras };
        }

        // Defensive `script` resolution. The schema marks `script` as required
        // and provides an enum of the skill's script paths, but Gemini
        // (especially gemini-3-flash-preview) intermittently emits a tool
        // call with argv/input_files/read_outputs filled in correctly while
        // OMITTING the script field. fixSchemaForGemini strips JSON-Schema
        // `enum` and converts it to a description hint, which is enough for
        // tighter providers but not for Gemini under load. Rather than
        // fail the run with "script is required", infer the script:
        //   1. If the model named one and it's in the skill's script list, use it.
        //   2. If the skill has exactly one script, use that (no ambiguity).
        //   3. Otherwise, fall back to a name-match heuristic against argv
        //      (e.g. argv contains "create" → prefer scripts/create.py).
        // If none resolve, fall through to pyodide-runner's existing error.
        const skillScripts = Array.isArray(chosenSkill?.scripts) ? chosenSkill.scripts : [];
        let resolvedScript = (typeof call.input?.script === 'string' && call.input.script.trim())
            ? call.input.script.trim()
            : '';
        if (resolvedScript && !skillScripts.includes(resolvedScript)) {
            // Model named a script that doesn't exist in the skill — drop and re-resolve.
            console.warn(`[B3] model named script "${resolvedScript}" but skill "${dirName}" exposes`, skillScripts);
            resolvedScript = '';
        }
        if (!resolvedScript && skillScripts.length === 1) {
            resolvedScript = skillScripts[0];
            console.log(`[B3] model omitted script; defaulting to skill's only script: ${resolvedScript}`);
        }
        if (!resolvedScript && skillScripts.length > 1) {
            // Heuristic: scan argv for a verb that matches a script basename.
            const argvJoined = Array.isArray(call.input?.argv) ? call.input.argv.join(' ').toLowerCase() : '';
            const VERBS = ['create', 'edit', 'transform', 'format', 'render', 'build', 'generate', 'extract', 'convert'];
            for (const verb of VERBS) {
                if (!argvJoined.includes(verb)) continue;
                const match = skillScripts.find(s => s.toLowerCase().includes(verb));
                if (match) {
                    resolvedScript = match;
                    console.log(`[B3] model omitted script; argv hint "${verb}" matched ${resolvedScript}`);
                    break;
                }
            }
            // Last-ditch: if there's a script literally named "create" or
            // "main", use it. Generation-style skills usually expose one.
            if (!resolvedScript) {
                const fallback = skillScripts.find(s => /\/create\.py$|\/main\.py$/i.test(s));
                if (fallback) {
                    resolvedScript = fallback;
                    console.log(`[B3] model omitted script; defaulted to canonical entry: ${resolvedScript}`);
                }
            }
        }
        if (resolvedScript && resolvedScript !== call.input?.script) {
            // Splice the inferred value back into the input so downstream
            // code (label, dispatch, logging) sees a consistent shape.
            call.input = { ...(call.input || {}), script: resolvedScript };
        }

        // sendMessage already showed the overlay + disabled Stop when this
        // turn was identified as B3-eligible. Update the phase text now
        // that we know which script is about to run.
        const scriptLabel = call.input?.script || call.name || 'script';
        // Make the progress recognizable for workflow authoring — otherwise the
        // user just sees a bare "Running compile.py…" and can't tell a workflow
        // is being built.
        const isWorkflowBuild = dirName === 'workflow-compile';
        const phaseLabel = isWorkflowBuild ? '🔄 Building workflow…' : `Running ${scriptLabel}…`;
        this._updateB3OverlayPhase(phaseLabel);
        const isOuterMost = depth === 0;
        try {

        this.showProgress(phaseLabel);


        const req = await this._buildSkillScriptRequest(call, ctx);
        const { preInputFiles } = req;
        // Execution seam: the parallel worker-pool path injects `runSkill` to
        // run this script off the main thread; the default is the proven
        // main-thread runner. All result-finalization below is identical for
        // both paths. A thrown runSkill (pool/permission failure) propagates
        // out so the dispatcher can fall back to the sequential path.
        const result = await (runSkill
            ? runSkill(req)
            : window.pyodideRunner.runSkillScript(req));

        // Dynamic-workflow loop: if workflow-compile produced a DSL, create it
        // and let the user open it in the editor or run-and-show here.
        if (isWorkflowBuild) {
            try {
                const wfDsl = this._detectWorkflowOutput(dirName, result?.outputs);
                if (wfDsl) {
                    await this._onWorkflowAuthored(wfDsl, ctx?.userMessage || '');
                } else {
                    this.showProgress('✅ Workflow built — open it in the editor.');
                }
            } catch (e) {
                console.warn('[workflow] post-author orchestration failed:', e);
                this.showProgress('✅ Workflow built — open it in the editor.');
            }
        }

        // Resolve the FSA root name once, BEFORE any output processing.
        // Used by the artifact-pane header, the disk-path hint we put in
        // the LLM's tool_result placeholder, and the output chips. If we
        // only resolved it inside the artifact-pane branch, binary
        // outputs (.pptx, .docx, etc.) would fall back to the literal
        // string "storage" — and the LLM would faithfully tell the user
        // their file is at "storage/outputs/..." instead of the real
        // root name (e.g. "synergyAI").
        if (!this._fsaRootName && window.localFs) {
            try {
                const rootHandle = await window.localFs.getRootHandle();
                if (rootHandle) this._fsaRootName = rootHandle.name;
            } catch (e) {
                console.warn('[fsa root] could not resolve:', e);
            }
        }

        // Open the artifact pane if the run produced a renderable file.
        // V1 only triggers on HTML/MD; everything else is treated as data.
        // Once it's showing, finalize the UI: the user can resume typing,
        // and we drop the active skill + attachments since the artifact
        // is now the visible result of this turn.
        let artifactPath = null;
        try {
            // DIAGNOSTIC: dump the entire outputs map (paths + content types
            // + length + leading bytes) BEFORE artifact selection. Tells us
            // exactly what create.py wrote — and whether the artifact-pane
            // confusion ("right pane shows the JSON spec, not generated
            // HTML") is the script writing JSON to a .html path, or our
            // selector picking the wrong file from a multi-output map.
            if (result && result.outputs && typeof result.outputs === 'object') {
                const outputsMap = result.outputs;
                const outputKeys = Object.keys(outputsMap);
                console.log(`[B3 outputs] runner returned ${outputKeys.length} output path(s):`, outputKeys);
                for (const path of outputKeys) {
                    const v = outputsMap[path];
                    const desc = v === null ? 'null (file missing)'
                        : typeof v === 'string' ? `string(${v.length})`
                        : v instanceof Uint8Array ? `Uint8Array(${v.byteLength})`
                        : typeof v;
                    let leading = '';
                    if (typeof v === 'string' && v.length > 0) {
                        leading = JSON.stringify(v.slice(0, 200));
                    }
                    console.log(`[B3 outputs]   ${path} → ${desc}${leading ? ' starts with ' + leading : ''}`);
                }
                // Stdout/stderr from the script — tells us if create.py
                // crashed, exited with errors, or printed warnings while
                // succeeding.
                if (result.stdout) console.log('[B3 outputs] script stdout:', JSON.stringify(result.stdout.slice(0, 1000)));
                if (result.stderr) console.warn('[B3 outputs] script stderr:', JSON.stringify(result.stderr.slice(0, 1000)));
                if (typeof result.exitCode === 'number') console.log('[B3 outputs] script exit code:', result.exitCode);
            }

            const artifact = this._selectArtifactFromOutputs(result?.outputs);
            if (artifact) {
                // DIAGNOSTIC: log a sample of the HTML/MD content the SCRIPT
                // wrote to /outputs/ before we render it in the artifact pane.
                // This nails whether SVG-attribute over-escapes are coming
                // from the script itself (likely create.py is using
                // json.dumps/repr on string values when templating) or from
                // somewhere in our display pipeline.
                if (artifact.kind === 'html' && typeof artifact.content === 'string') {
                    const svgIdx = artifact.content.indexOf('<svg');
                    if (svgIdx !== -1) {
                        console.log(
                            `[B3 artifact] script-written HTML contains <svg — sample at offset ${svgIdx}:`,
                            JSON.stringify(artifact.content.slice(svgIdx, svgIdx + 200))
                        );
                    }
                    const escIdx = artifact.content.indexOf('\\"');
                    if (escIdx !== -1) {
                        console.warn(
                            `[B3 artifact] script-written HTML contains literal \\" sequence — over-escape originates in the skill script, not in our pipeline. Sample around offset ${escIdx}:`,
                            JSON.stringify(artifact.content.slice(Math.max(0, escIdx - 40), escIdx + 80))
                        );
                    }
                    // Also detect the "JSON-as-HTML" failure mode: artifact
                    // is named .html but its first character is `{` or `[`,
                    // meaning create.py dumped the spec rather than rendering.
                    const trimmed = artifact.content.trimStart();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        console.error(
                            `[B3 artifact] WARNING: artifact path "${artifact.relPath}" has a .html extension ` +
                            `but its content starts with "${trimmed.charAt(0)}" — the script likely wrote JSON ` +
                            `(or the spec itself) to the output path instead of rendering HTML. The artifact ` +
                            `pane is loading JSON into an iframe srcdoc, which is why the browser SVG parser ` +
                            `is firing on string substrings.`
                        );
                    }
                }
                // Update the pane at every depth so a multi-step skill
                // (e.g. extract.py at depth 0 → create.py at depth 1)
                // ends up showing the FINAL document, not the intermediate
                // report. Finalize stays gated to the outermost call —
                // it's a one-shot UI handoff that frees the user to type
                // again, and re-running it on nested calls is just churn.
                this.showArtifactPane(dirName, artifact.relPath, artifact.content, artifact.kind);
                artifactPath = artifact.relPath;
                // Finalize is gated to: (1) outermost dispatch round
                // (depth===0) and (2) the LAST call in the round. Without
                // (2), a multi-tool-use round with 4 run_skill_script calls
                // would fire _finalizeB3UIAfterArtifact 4 times in quick
                // succession — every intermediate finalize is wasted UI
                // churn since the next call overwrites the artifact pane.
                if (isOuterMost && isLastCallInRound) {
                    this._finalizeB3UIAfterArtifact(ctx.userMessage);
                }
            }
        } catch (e) {
            console.warn('[artifact pane] failed to display output:', e);
        }

        // Clean up the /scratch/ pre-write paths now that the script
        // has consumed them. Pyodide's MEMFS is in-browser only and
        // gets wiped on tab close, but over a long session multiple
        // attachments would accumulate — explicit unlink keeps memory
        // hygiene tight.
        for (const path of Object.keys(preInputFiles)) {
            window.pyodideRunner?.cleanupPath?.(path);
        }

        // If this turn produced output files but none were renderable,
        // close any stale artifact pane left open from a previous turn.
        // Without this, after extract→pane, a follow-up create→.pptx
        // leaves the old extracted markdown visible on the right while
        // the new result lives only as a chip under the message — the
        // pane misleads the user about which file is "current."
        const hasOutputs = result?.outputs && Object.keys(result.outputs).some(
            p => p.startsWith('/outputs/') && result.outputs[p] != null
        );
        if (hasOutputs && !artifactPath && this.activeSplitMode === 'artifact') {
            try { this.hideArtifactPane(); } catch (_) {}
        }

        // Build the tool_result the LLM sees. Two key optimizations to
        // keep the second-shot fast (the LLM rereads everything we put
        // in here, so this directly affects latency):
        //   1. The output file shown in the artifact pane is REPLACED
        //      with a small placeholder. The user already sees the file
        //      rendered to the right; the LLM doesn't need to reread it
        //      to produce its summary. Saves ~10-50 KB of input tokens
        //      per turn for a typical document-transform skill.
        //   2. Other output files are capped at 2 KB (down from 16 KB).
        //      Tight enough to cut latency, generous enough for status
        //      JSON / metadata files.
        // stdout/stderr keep the higher cap because warnings printed
        // there are exactly what the LLM needs to summarize for the user.
        const MAX_STREAM_CHARS = 16_000;   // stdout / stderr
        const MAX_OUTPUT_CHARS = 20_000;   // text output files (audit reports,
                                           // summaries, etc.) — must be large
                                           // enough that the model can summarize
                                           // them faithfully without truncation.
        // Resolve the user-visible disk path for any /outputs/<name>
        // file so the LLM can name it back to the user. Without this
        // the model only sees the in-Pyodide path (/outputs/foo.docx)
        // and has no way to communicate where the file actually lives
        // on disk (~/Documents/<root>/outputs/foo.docx).
        const rootName = this._fsaRootName || 'storage';
        const diskPathFor = (path) => {
            if (typeof path !== 'string') return null;
            if (path.startsWith('/outputs/')) return `${rootName}${path}`;
            if (path.startsWith('/')) return `${rootName}${path}`;
            return null;
        };
        const trimmedOutputs = {};
        for (const [path, val] of Object.entries(result.outputs || {})) {
            const disk = diskPathFor(path);
            const diskHint = disk ? ` File saved on disk at: ${disk}` : '';
            if (val == null) {
                trimmedOutputs[path] = null;
            } else if (typeof val === 'string') {
                // Text content — always send to the model. Even when the file
                // is also displayed in the user's artifact pane, the model
                // needs to read it to summarize it accurately. Replacing the
                // body with a placeholder ("already displayed — summarize
                // from stdout/stderr") forced models to invent a summary
                // when stdout/stderr were empty, which is the failure mode
                // we hit on the audit skill.
                const isArtifact = path === artifactPath;
                const displayHint = isArtifact
                    ? ' The user is also viewing this file in their artifact pane — summarize and discuss it with them, do NOT dump it back verbatim in your reply.'
                    : '';
                if (val.length > MAX_OUTPUT_CHARS) {
                    trimmedOutputs[path] = val.slice(0, MAX_OUTPUT_CHARS)
                        + `\n\n[truncated — original was ${val.length} chars.${diskHint}${displayHint}]`;
                } else if (isArtifact) {
                    trimmedOutputs[path] = val + `\n\n[${val.length} bytes total.${diskHint}${displayHint}]`;
                } else {
                    trimmedOutputs[path] = val;
                }
            } else {
                // Uint8Array (binary) — describe rather than embed bytes.
                // Binary artifacts can't be read by the model and there's no
                // useful summary it can produce from raw bytes; the disk path
                // lets it tell the user where the file lives.
                trimmedOutputs[path] = `[binary file, ${val.byteLength} bytes.${diskHint} Tell the user where the file lives on their disk.]`;
            }
        }
        // Some models (notably OpenAI / DeepSeek) misread the script's
        // stderr "Warnings:" lines as errors and retry the tool when
        // it actually succeeded. Lead with an explicit boolean so the
        // model's first signal is unambiguous, and rename `stderr` to
        // `log_messages` to defuse the failure connotation. Provide a
        // human-readable note for the LLM to anchor on.
        const succeeded = (result.exitCode ?? 1) === 0;
        const toolResultPayload = {
            success: succeeded,
            note: succeeded
                ? 'The script completed successfully. exit_code=0. Any "Warnings:" lines below are advisory (they describe transformation choices like dropped tables or unfetched stylesheets) — they are NOT errors and you should NOT retry the tool. Summarize the result for the user from log_messages.'
                : 'The script failed. exit_code is non-zero. Read log_messages for the cause and decide whether to retry with corrected arguments or report the failure to the user.',
            exit_code: result.exitCode ?? null,
            stdout: (result.stdout || '').slice(0, MAX_STREAM_CHARS),
            log_messages: (result.stderr || '').slice(0, MAX_STREAM_CHARS),
            outputs: trimmedOutputs,
            duration_ms: Math.round(result.durationMs ?? 0),
        };

        // Update the overlay so users know we've moved from "running
        // script" to "<provider> is responding". This is per-call status
        // — the actual continuation request is issued once per round by
        // the outer dispatcher (after all calls in this round finish),
        // but the user-visible text is still accurate: we've finished
        // executing this script and the round is moving toward the next
        // LLM turn. Active skill may have been cleared by the
        // post-artifact finalize step so fall back to the dirName from
        // the dispatcher's context.
        const skillName = chosenSkill?.name || chosenSkill?.dir_name || dirName || 'skill';
        const providerLabel = this.getProviderDisplayName(this.currentProvider);
        this._updateB3OverlayPhase(`Working with ${skillName} — ${providerLabel} is responding…`);

        // Phase 0 self-healing: record a chat execution trace. `activeSkill`
        // set means the skill was drag-dropped (forced); otherwise the model
        // discovered it from the catalog. Fire-and-forget — never blocks chat.
        this._postExecutionTrace({
            invocation_mode: forcedSkill ? 'forced' : 'auto_discovery',
            provider: this.currentProvider,
            skill_dir: dirName,
            script: call.input?.script || null,
            argv: Array.isArray(call.input?.argv) ? call.input.argv : [],
            exit_code: result.exitCode ?? null,
            stdout: (result.stdout || '').slice(0, 20000),
            log_messages: (result.stderr || '').slice(0, 20000),
            output_files: result.outputs ? Object.keys(result.outputs) : [],
            success: succeeded,
            run_id: ctx?.runId || ctx?.requestId || null,
        });

        // Post-run self-heal hook (Auto mode only; debounced + threshold'd).
        try { window.healSystem && window.healSystem.autoAfterRun && window.healSystem.autoAfterRun([dirName]); } catch (_) {}

        return { toolResultPayload, followUpExtras: {} };

        } finally {
            // sendMessage owns the indicator + overlay lifecycle for the
            // whole turn — don't tear down here. Block kept so any future
            // dispatcher-local cleanup has a home.
            void isOuterMost;
        }
    }

    // Coerce a model-supplied input_files value into the schema's
    // object<path → string> shape. Claude (especially on large HTML payloads)
    // emits input_files inconsistently: sometimes a proper object, sometimes a
    // JSON-encoded STRING (often over-escaped), sometimes a raw content string.
    // This is the single source of truth for that recovery — chat's skill
    // dispatch AND the workflow runner (workflow-editor.js _runNodeAsChatUnit)
    // both call it so the two paths can't drift. Returns a sanitized object
    // (possibly empty); never throws.
    _coerceInputFiles(rawInputFiles, argv) {
        argv = Array.isArray(argv) ? argv : [];
        let llmInputFiles;
        if (rawInputFiles && typeof rawInputFiles === 'object') {
            llmInputFiles = rawInputFiles;
        } else if (typeof rawInputFiles === 'string' && rawInputFiles.trim()) {
            let parsed = null;
            let lastError = null;
            const trimmed = rawInputFiles.trim();
            const looksLikeJsonObject = trimmed.startsWith('{') && trimmed.endsWith('}');
            // Strategy 1: direct JSON.parse
            try { parsed = JSON.parse(rawInputFiles); }
            catch (e) { lastError = e; }
            // Strategy 2: undo one level of over-escape (`\"`→`"`, `\\`→`\`).
            // This is the one that recovers Claude's over-escaped large JSON.
            if (!parsed && looksLikeJsonObject) {
                try {
                    const unescaped = rawInputFiles
                        .replace(/\\"/g, '"')
                        .replace(/\\\\/g, '\\');
                    parsed = JSON.parse(unescaped);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        console.log('[coerceInputFiles] parsed after one over-escape pass');
                    }
                } catch (e) { lastError = e; }
            }
            // Strategy 3: double-decode (a JSON-string-of-a-JSON-string).
            if (!parsed) {
                try {
                    const oneLayer = JSON.parse('"' + rawInputFiles.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
                    if (typeof oneLayer === 'string') {
                        parsed = JSON.parse(oneLayer);
                        if (parsed && typeof parsed === 'object') {
                            console.log('[coerceInputFiles] parsed after double-decode');
                        }
                    }
                } catch (e) { lastError = e; }
            }
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                llmInputFiles = parsed;
                console.log(`[coerceInputFiles] input_files was a JSON-stringified object; ${Object.keys(parsed).length} key(s):`, Object.keys(parsed));
            } else {
                if (looksLikeJsonObject && lastError) {
                    console.warn(`[coerceInputFiles] input_files LOOKS like a JSON object (${rawInputFiles.length} chars) but every parse strategy failed — last error:`, lastError?.message || lastError);
                    console.warn('[coerceInputFiles] first 300 chars:', JSON.stringify(rawInputFiles.slice(0, 300)));
                }
                // Treat the string as raw file content; wrap it under the -i/--input path.
                let inputPathFromArgv = null;
                for (let i = 0; i < argv.length - 1; i++) {
                    if ((argv[i] === '-i' || argv[i] === '--input' || argv[i] === '--in')
                        && typeof argv[i + 1] === 'string'
                        && !argv[i + 1].startsWith('-')) {
                        inputPathFromArgv = argv[i + 1];
                        break;
                    }
                }
                if (inputPathFromArgv) {
                    llmInputFiles = { [inputPathFromArgv]: rawInputFiles };
                    console.log(`[coerceInputFiles] raw content string (${rawInputFiles.length} chars) wrapped under "${inputPathFromArgv}"`);
                } else {
                    llmInputFiles = {};
                    console.warn(`[coerceInputFiles] raw content string but argv has no -i/--input; dropping. argv:`, argv);
                }
            }
        } else {
            llmInputFiles = {};
        }
        return this._sanitizeInputFilesKeys(llmInputFiles);
    }

    // Builds the exact request object passed to pyodideRunner.runSkillScript for
    // a run_skill_script tool call. Extracted so the parallel worker-pool path
    // can reuse the identical normalization. Side-effect-free except for the
    // same console diagnostics that were already here.
    async _buildSkillScriptRequest(call, ctx) {
        // Resolve dir_name / chosenSkill identically to the dispatcher so the
        // normalization below sees the same values it did when inlined.
        const activeSkill = ctx?.activeSkill || this.activeSkill;
        const dirName = (typeof call.input?.dir_name === 'string' && call.input.dir_name.trim())
            ? call.input.dir_name.trim()
            : activeSkill?.dir_name;
        const chosenSkill = (activeSkill?.dir_name === dirName)
            ? activeSkill
            : (window.skillsManager?.skills || []).find(s => s?.dir_name === dirName) || activeSkill;

        const input = call.input || {};
        // Augment read_outputs with paths inferred from argv. Skill scripts
        // typically write to a path passed as `-o <path>` or `--output <path>`;
        // the LLM doesn't always remember to also list that path in
        // read_outputs. Catching it here ensures the artifact pane has
        // something to display even if the model forgot to ask.
        // Coerce argv to an array of strings. The schema says
        // `argv: array<string>` but Claude (and Gemini) routinely violate
        // this in two ways depending on schema looseness:
        //   1. Whole shell-line as a string: "-i /scratch/spec.json -o /outputs/foo.html --pretty"
        //   2. Just the output path as a string: "/outputs/foo.html"
        // Form (1) splits cleanly on whitespace. Form (2) is what blew up
        // the run we just diagnosed: the recovered ['/outputs/foo.html']
        // has no flags, argparse aborts with "the following arguments are
        // required: -i/--input, -o/--output", and exit code 2.
        //
        // Recovery strategy:
        //   • If the string contains any flag tokens (-x or --x), split on
        //     whitespace — the model meant a shell line.
        //   • Otherwise treat the string as a bare path:
        //       - starts with /outputs/ → output path → reconstruct
        //         ['-i', <best-input>, '-o', <path>]
        //       - starts with /scratch/ → input path → reconstruct
        //         ['-i', <path>, '-o', <best-output>]
        //   • Best-input is the first /scratch/*.json key in input_files
        //     (typically the spec the model authored inline). Best-output
        //     is the first /outputs/* path in read_outputs (or a
        //     deterministic default).
        let argv;
        const llmInputFilesEarly = (input.input_files && typeof input.input_files === 'object') ? input.input_files : {};
        const findFirstSpecPath = () => {
            for (const k of Object.keys(llmInputFilesEarly)) {
                if (k.startsWith('/scratch/') && k.endsWith('.json')) return k;
            }
            return null;
        };
        const readOutputsRaw = input.read_outputs;
        const findFirstOutputPath = () => {
            if (Array.isArray(readOutputsRaw)) {
                for (const p of readOutputsRaw) {
                    if (typeof p === 'string' && p.startsWith('/outputs/')) return p;
                }
            } else if (typeof readOutputsRaw === 'string') {
                if (readOutputsRaw.startsWith('/outputs/')) return readOutputsRaw;
            }
            return null;
        };

        if (Array.isArray(input.argv)) {
            argv = input.argv;
        } else if (typeof input.argv === 'string') {
            const argStr = input.argv.trim();
            const looksLikeShellLine = /(^|\s)(-{1,2}[a-zA-Z])/.test(argStr);
            if (looksLikeShellLine) {
                argv = argStr.split(/\s+/).filter(s => s.length > 0);
                console.log('[B3 dispatch] argv was a shell-line string; split into:', argv);
            } else if (argStr.startsWith('/outputs/')) {
                const inputPath = findFirstSpecPath() || '/scratch/spec.json';
                argv = ['-i', inputPath, '-o', argStr];
                console.log(`[B3 dispatch] argv was a bare output path "${argStr}"; reconstructed as:`, argv);
            } else if (argStr.startsWith('/scratch/')) {
                const outputPath = findFirstOutputPath() || '/outputs/output.html';
                argv = ['-i', argStr, '-o', outputPath];
                console.log(`[B3 dispatch] argv was a bare input path "${argStr}"; reconstructed as:`, argv);
            } else {
                argv = argStr.split(/\s+/).filter(s => s.length > 0);
                console.log('[B3 dispatch] argv was an unstructured string; whitespace-split as fallback:', argv);
            }
        } else {
            argv = [];
        }

        // read_outputs has the same string-instead-of-array failure mode;
        // wrap a bare path in an array so the runner reads the file the
        // model intended.
        let explicit;
        if (Array.isArray(input.read_outputs)) {
            explicit = input.read_outputs;
        } else if (typeof input.read_outputs === 'string' && input.read_outputs.trim()) {
            explicit = [input.read_outputs.trim()];
            console.log('[B3 dispatch] read_outputs was a string; wrapped into:', explicit);
        } else {
            explicit = [];
        }
        const inferred = [];
        for (let i = 0; i < argv.length - 1; i++) {
            if ((argv[i] === '-o' || argv[i] === '--output' || argv[i] === '--out')
                && typeof argv[i + 1] === 'string'
                && !argv[i + 1].startsWith('-')) {
                inferred.push(argv[i + 1]);
            }
        }
        const mergedReadOutputs = Array.from(new Set([...explicit, ...inferred]));

        // PERFORMANCE: pre-write the user's attached document(s) to
        // /scratch/<filename> in Pyodide BEFORE invoking the script.
        // Without this, the LLM has to emit the entire attachment as
        // tool-call arguments (input_files), which is roughly 4 chars
        // per output token — for a 50 KB doc that's ~12K output tokens
        // generated by the model, costing minutes per turn. By
        // pre-writing on our side, the model only needs to emit a path
        // reference in argv (~50 tokens) and tool-call latency drops
        // back into the seconds.
        const preInputFiles = {};
        const attCount = (this.pendingAttachments || []).length;
        console.log('[B3 pre-write] pendingAttachments count:', attCount);
        for (const entry of (this.pendingAttachments || [])) {
            try {
                if (!entry) {
                    console.log('[B3 pre-write] entry is null — skipped');
                    continue;
                }
                if (!entry.file) {
                    // Fall back: try to fetch text via the backend's
                    // attachment ID (when File object is no longer in
                    // memory — e.g., after a page reload restoring state
                    // from server-side storage). This handles the common
                    // case where pendingAttachments was rehydrated.
                    console.log(`[B3 pre-write] entry "${entry.name}" has no .file (id=${entry.id}); cannot pre-read on the frontend`);
                    continue;
                }
                const mime = (entry.mime || entry.file.type || '').toLowerCase();
                const name = (entry.name || entry.file.name || '').trim();
                if (!name) {
                    console.log('[B3 pre-write] entry has no name — skipped');
                    continue;
                }
                // Decide text vs binary. Text gets UTF-8 decoded;
                // binary stays as Uint8Array so ZIP-based formats
                // (.docx, .xlsx, .pptx) and PDFs/images survive the
                // pre-write into Pyodide intact. writeInput in
                // pyodide-runner accepts both shapes natively.
                //
                // Mime detection uses exact matches + safe suffixes,
                // NOT substring includes — Office formats like
                // application/vnd.openxmlformats-officedocument.wordprocessingml.document
                // literally contain the substring "xml" in
                // "wordprocessingml" but are binary ZIPs underneath.
                // The `+xml && !vnd.` rule keeps atom+xml etc. as text
                // while excluding all vendor (vnd.*) binary formats.
                const lowerName = name.toLowerCase();
                const isTextMime = (
                    mime.startsWith('text/') ||
                    mime === 'application/json' ||
                    mime === 'application/xml' ||
                    mime === 'application/xhtml+xml' ||
                    mime === 'application/javascript' ||
                    mime === 'application/x-yaml' ||
                    mime === 'application/yaml' ||
                    mime === 'application/x-toml' ||
                    mime.endsWith('+json') ||
                    (mime.endsWith('+xml') && !mime.startsWith('application/vnd.'))
                );
                const isTextExt = /\.(html?|md|markdown|txt|json|csv|xml|css|js|py|sh|yml|yaml|toml|ini|log)$/i.test(lowerName);
                if (isTextMime || isTextExt) {
                    const content = await entry.file.text();
                    preInputFiles[`/scratch/${name}`] = content;
                    console.log(`[B3 pre-write] queued /scratch/${name} (${content.length} chars, text)`);
                } else {
                    const buf = await entry.file.arrayBuffer();
                    preInputFiles[`/scratch/${name}`] = new Uint8Array(buf);
                    console.log(`[B3 pre-write] queued /scratch/${name} (${buf.byteLength} bytes, binary)`);
                }
            } catch (e) {
                console.warn('[B3 pre-write] failed for entry:', entry?.name || '?', e);
            }
        }
        console.log('[B3 pre-write] final paths to write:', Object.keys(preInputFiles));

        // Merge: pre-stashed entries WIN over the LLM's input_files for
        // any path we already wrote. Two reasons:
        //   1. Binary files: the LLM physically cannot transmit raw
        //      bytes through a JSON tool call — anything it sends for
        //      a .docx/.xlsx/.pdf path is a stringified guess that
        //      breaks the file (e.g. "Bad offset for central directory"
        //      from mammoth on a corrupted ZIP).
        //   2. Text files we pre-wrote: we have the canonical content
        //      from disk; an LLM-emitted version is at best a copy and
        //      at worst a mangled excerpt.
        // The LLM's input_files still apply for paths we DIDN'T stash
        // (e.g. small synthesized files like a JSON spec the model
        // composed on the fly).
        // Coerce input_files to the schema-expected object shape. The schema
        // says `input_files: object<path → string>`, but Claude (especially
        // when authoring large HTML payloads) sometimes emits input_files
        // as a single STRING containing just the file content — without the
        // path-keyed wrapper object. Without recovery the string is silently
        // dropped, the script tries to read a path that was never written,
        // and we end up with "input file not found" / exit code 2.
        //
        // Three recovery paths, in priority order:
        //   1. Already an object → use as-is.
        //   2. String that JSON-parses to an object → that's the intended
        //      object, just stringified by mistake. Use the parsed value.
        //   3. Raw content string (HTML/JSON/text body) → wrap it under the
        //      input path the model named in argv (the value after -i /
        //      --input). Without that path, fall back to the only /scratch/
        //      key the model didn't pre-write.
        // input_files recovery (object / over-escaped JSON string / raw
        // content) lives in the shared _coerceInputFiles so chat and the
        // workflow runner can't drift. See that method for the strategies.
        let llmInputFiles = this._coerceInputFiles(input.input_files, argv);

        // DIAGNOSTIC: when both the LLM and pre-write target the same
        // /scratch/<path>, show what each has so we can see why the
        // output ended up with one or the other. The MERGE order
        // (`{...llmInputFiles, ...preInputFiles}`) means preInputFiles
        // wins — but only if it actually has the key. If pre-write
        // silently failed for that path (e.g. entry.file unreadable),
        // llmInputFiles wins by default and we end up with whatever
        // garbage the LLM emitted. This log nails which side won
        // for every collision, including the first 120 chars of each
        // so JSON-as-HTML failures are visible at a glance.
        for (const k of Object.keys(llmInputFiles)) {
            if (Object.prototype.hasOwnProperty.call(preInputFiles, k)) {
                const llmVal = llmInputFiles[k];
                const preVal = preInputFiles[k];
                const sample = (v) => typeof v === 'string'
                    ? JSON.stringify(v.slice(0, 120)) + (v.length > 120 ? '…' : '')
                    : (v instanceof Uint8Array ? `<binary, ${v.byteLength} bytes>` : `<${typeof v}>`);
                const llmLen = typeof llmVal === 'string' ? llmVal.length : (llmVal instanceof Uint8Array ? llmVal.byteLength : 'n/a');
                const preLen = typeof preVal === 'string' ? preVal.length : (preVal instanceof Uint8Array ? preVal.byteLength : 'n/a');
                console.log(
                    `[B3 merge collision] "${k}" — pre-write WINS (${preLen} chars/bytes), LLM emission discarded (${llmLen}).\n`
                    + `  pre-write head: ${sample(preVal)}\n`
                    + `  LLM head:       ${sample(llmVal)}`
                );
            }
        }

        const mergedInputFiles = { ...llmInputFiles, ...preInputFiles };

        // URL interception. If the active skill declares `fetches_urls: true`
        // in its SKILL.md frontmatter, scan argv for URL-shaped tokens and
        // pre-fetch them server-side via /api/v1/fetch-url (Pyodide can't
        // cross-origin XHR for non-CORS sites). The fetched HTML is written
        // into Pyodide's MEMFS at /scratch/url-N.html and the URL token in
        // argv is replaced with the file path; a `--source <url>` pair is
        // appended so reports can still show the original URL.
        let finalArgv = argv;
        try {
            const intercepted = await this._interceptUrlsInArgv(chosenSkill, argv);
            if (intercepted) {
                finalArgv = intercepted.newArgv;
                Object.assign(mergedInputFiles, intercepted.addedInputFiles);
                if (intercepted.fetched.length) {
                    console.log('[B3 url-intercept] fetched URLs:', intercepted.fetched);
                }
                if (intercepted.warnings.length) {
                    console.warn('[B3 url-intercept] warnings:', intercepted.warnings);
                }
            }
        } catch (e) {
            console.warn('[B3 url-intercept] failed; falling back to raw argv:', e);
        }

        const finalInputFiles = Object.keys(mergedInputFiles).length > 0 ? mergedInputFiles : null;

        // DIAGNOSTIC: log the COMPLETE call shape right before dispatch. We
        // already know inputFiles ships a clean string from the pre-write,
        // so when Pyodide still throws "Unsupported data type" the offending
        // value must be in argv (passed through pyodide.toPy()), the script
        // path itself, or one of the readOutputs entries. Logging types for
        // each lets us pinpoint which one in a single retest.
        const typeOf = (v) => v === null ? 'null'
            : v === undefined ? 'undefined'
            : v instanceof Uint8Array ? `Uint8Array(${v.byteLength})`
            : v instanceof ArrayBuffer ? `ArrayBuffer(${v.byteLength})`
            : ArrayBuffer.isView(v) ? `${v.constructor.name}(${v.byteLength})`
            : Array.isArray(v) ? `array(${v.length})[${v.map(x => typeof x).join(',')}]`
            : typeof v === 'string' ? `string(${v.length})`
            : typeof v;
        if (finalInputFiles) {
            const shape = Object.fromEntries(Object.entries(finalInputFiles).map(([k, v]) => [k, typeOf(v)]));
            console.log('[B3 dispatch] inputFiles shape:', shape);
            // Per-entry head sample — string values get the first 150
            // chars in JSON-quoted form so JSON-as-HTML wrappers are
            // immediately visible (`"{\\"/scratch/...\\":` vs the clean
            // `<!DOCTYPE html>` start).
            for (const [k, v] of Object.entries(finalInputFiles)) {
                if (typeof v === 'string') {
                    console.log(
                        `[B3 dispatch] inputFiles head "${k}": ${JSON.stringify(v.slice(0, 150))}${v.length > 150 ? '…' : ''}`
                    );
                }
            }
        }
        console.log('[B3 dispatch] call shape:', {
            dirName: typeOf(dirName),
            dirNameValue: dirName,
            script: typeOf(input.script),
            scriptValue: input.script,
            argv: typeOf(finalArgv),
            argvValue: finalArgv,
            readOutputs: typeOf(mergedReadOutputs),
            readOutputsValue: mergedReadOutputs,
        });
        // Also log the raw model input verbatim so we can see if Claude
        // emitted any unexpected fields or value types we strip below.
        console.log('[B3 dispatch] raw model input keys:', Object.keys(input || {}));
        for (const k of Object.keys(input || {})) {
            console.log(`[B3 dispatch] raw model input.${k}:`, typeOf(input[k]));
        }

        // Compare-mode collision avoidance: when both panes will run
        // pyodide for the same skill, both LLMs typically choose the
        // SAME output filename (e.g. /outputs/synergyai-workflow.html).
        // Without namespacing, the second run silently overwrites the
        // first in MEMFS and on disk via FSA. Rewrite output paths to
        // include the provider name as a subdirectory so each provider's
        // artifact lands at /outputs/<provider>/<filename> — symmetric
        // for primary and comparer, easy to identify on disk.
        // No-op when not in compare mode (single-provider turns keep
        // the canonical /outputs/<filename> path).
        if (this.compareEnabled && this.selectedComparer && this.currentProvider) {
            const rewritten = this._rewriteOutputsForProvider(
                finalArgv, mergedReadOutputs, this.currentProvider
            );
            finalArgv = rewritten.argv;
            for (let i = 0; i < mergedReadOutputs.length; i++) {
                mergedReadOutputs[i] = rewritten.readOutputs[i];
            }
            console.log(`[B3 compare-mode] rewrote outputs for primary "${this.currentProvider}":`, rewritten.changedPaths);
        }

        return {
            dirName,
            script: input.script,
            argv: finalArgv,
            inputFiles: finalInputFiles,
            readOutputs: mergedReadOutputs.length > 0 ? mergedReadOutputs : null,
            preInputFiles,
        };
    }

    /**
     * Compare-pane parity dispatcher (Step 2). Runs the comparer's
     * run_skill_script call through pyodide, then POSTs the tool_result
     * to /api/v1/compare so the comparer can write its summary into the
     * compare bubble. Mirrors the primary dispatcher's flow but is
     * intentionally narrower:
     *
     *   - run_skill_script only (V1). discover_skill in compare-mode
     *     would require recursive multi-skill catalog handling on the
     *     comparer side; chip-equivalent injection from the primary's
     *     turn already routes the comparer to direct run_skill_script
     *     in the dominant case.
     *   - input_files / argv coercion is best-effort. The primary
     *     dispatcher carries heavy defensive code for malformed model
     *     output (bare-path argv, JSON-stringified input_files, etc.).
     *     If the comparer emits malformed input we log and proceed
     *     best-effort rather than recovering.
     *   - Sequential to the primary: pyodide is a single shared
     *     instance, so this method must be awaited AFTER the primary
     *     dispatcher resolves.
     *
     * Returns { finalResponse } same as the primary dispatcher.
     */
    async dispatchCompareClientToolCall(payload, ctx, depth = 0) {
        const MAX_DEPTH = this._resolveRoundBudget(ctx, payload);
        if (depth >= MAX_DEPTH) {
            this.appendCompareChunk(ctx.compareMsgId,
                `\n\n_Compare pane stopped after ${MAX_DEPTH} client-tool rounds. Do not invent results. Report which tool calls completed and which output files exist — do not synthesize a final answer from memory._`);
            return { finalResponse: null };
        }
        if (!window.pyodideRunner) {
            throw new Error('pyodideRunner unavailable for compare-pane dispatch.');
        }
        if (!Array.isArray(payload.tool_calls) || payload.tool_calls.length === 0) {
            throw new Error('compare client_tool_call payload had no tool_calls.');
        }
        const call = payload.tool_calls[0];
        if (call.name !== 'run_skill_script') {
            // V1 doesn't dispatch discover_skill in the compare pane.
            // Surface this in the bubble so the user sees the comparer's
            // intent without the dispatcher silently swallowing it.
            this.appendCompareChunk(ctx.compareMsgId,
                `\n\n_Compare pane: comparer requested ${call.name} — not yet supported in compare mode (V1)._`);
            return { finalResponse: null };
        }

        const activeSkill = ctx?.activeSkill || this.activeSkill;
        const dirName = (typeof call.input?.dir_name === 'string' && call.input.dir_name.trim())
            ? call.input.dir_name.trim()
            : activeSkill?.dir_name;
        if (!dirName) {
            throw new Error('No skill resolved for compare-pane tool call.');
        }
        const chosenSkill = (activeSkill?.dir_name === dirName)
            ? activeSkill
            : (window.skillsManager?.skills || []).find(s => s?.dir_name === dirName) || activeSkill;

        // Resolve script with the same fallback the primary uses, but
        // simplified: explicit name → only-script-in-skill → bail.
        const skillScripts = Array.isArray(chosenSkill?.scripts) ? chosenSkill.scripts : [];
        let resolvedScript = (typeof call.input?.script === 'string' && call.input.script.trim())
            ? call.input.script.trim()
            : '';
        if (resolvedScript && !skillScripts.includes(resolvedScript)) {
            resolvedScript = '';
        }
        if (!resolvedScript && skillScripts.length === 1) {
            resolvedScript = skillScripts[0];
        }

        const input = call.input || {};
        const argv = Array.isArray(input.argv)
            ? input.argv
            : (typeof input.argv === 'string' ? input.argv.trim().split(/\s+/).filter(Boolean) : []);
        const llmInputFiles = this._sanitizeInputFilesKeys(
            (input.input_files && typeof input.input_files === 'object' && !Array.isArray(input.input_files))
                ? input.input_files
                : {}
        );
        const readOutputs = Array.isArray(input.read_outputs)
            ? input.read_outputs
            : (typeof input.read_outputs === 'string' && input.read_outputs.trim() ? [input.read_outputs.trim()] : []);

        // Pre-write attachments to /scratch/ — same trick the primary
        // uses to keep model output token cost down. Without this the
        // comparer would have to emit the full attachment content in
        // input_files (a 50KB doc → ~12K tokens of latency).
        const preInputFiles = {};
        for (const entry of (this.pendingAttachments || [])) {
            try {
                if (!entry?.file) continue;
                const name = (entry.name || entry.file.name || '').trim();
                if (!name) continue;
                const mime = (entry.mime || entry.file.type || '').toLowerCase();
                const lowerName = name.toLowerCase();
                const isText = mime.startsWith('text/') || mime === 'application/json'
                    || mime.endsWith('+json') || mime === 'application/xml'
                    || /\.(html?|md|markdown|txt|json|csv|xml|css|js|py|sh|yml|yaml|toml|ini|log)$/i.test(lowerName);
                if (isText) {
                    preInputFiles[`/scratch/${name}`] = await entry.file.text();
                } else {
                    preInputFiles[`/scratch/${name}`] = new Uint8Array(await entry.file.arrayBuffer());
                }
            } catch (e) {
                console.warn('[compare dispatch] pre-write failed for', entry?.name, e);
            }
        }
        const finalInputFiles = { ...llmInputFiles, ...preInputFiles };

        // Compare-mode collision avoidance: rewrite output paths to
        // include the comparer's provider name as a subdirectory so
        // /outputs/X.html becomes /outputs/<comparer>/X.html. Without
        // this, both panes overwrite each other. Always applied here
        // since dispatchCompareClientToolCall runs only in compare mode.
        const rewritten = this._rewriteOutputsForProvider(
            argv, readOutputs, this.selectedComparer
        );
        const finalArgv = rewritten.argv;
        const finalReadOutputs = rewritten.readOutputs;
        if (rewritten.changedPaths.length > 0) {
            console.log(`[compare dispatch] rewrote outputs for comparer "${this.selectedComparer}":`, rewritten.changedPaths);
        }

        const scriptLabel = resolvedScript || call.name;
        this._updateB3OverlayPhase(`Compare pane: running ${scriptLabel}…`);
        console.log('[compare dispatch] runSkillScript', { dirName, script: resolvedScript, argv: finalArgv, readOutputs: finalReadOutputs });

        let result;
        try {
            result = await window.pyodideRunner.runSkillScript({
                dirName,
                script: resolvedScript,
                argv: finalArgv,
                inputFiles: finalInputFiles,
                readOutputs: finalReadOutputs.length > 0 ? finalReadOutputs : null,
            });
        } catch (e) {
            console.error('[compare dispatch] pyodide threw:', e);
            this.appendCompareChunk(ctx.compareMsgId,
                `\n\n_Compare pane script failed: ${e.message || e}_`);
            return { finalResponse: null };
        }

        // Render the comparer's artifact in the dedicated 4th pane so
        // the user can see both LLMs' output side by side. This is the
        // "and 2 panes for the other provider" half of the 4-pane
        // layout the user requested. Same selector as the primary so
        // it picks the first renderable output (HTML/MD).
        try {
            const compareArtifact = this._selectArtifactFromOutputs(result?.outputs);
            if (compareArtifact) {
                this.openCompareArtifactPane(
                    compareArtifact.relPath,
                    dirName,
                    compareArtifact.content,
                    compareArtifact.kind,
                );
            }
        } catch (e) {
            console.warn('[compare dispatch] artifact-pane render failed:', e);
        }

        // Build tool_result. Same shape as primary so the comparer's
        // backend continuation interprets it identically.
        const MAX_STREAM_CHARS = 200_000;
        const trimmedOutputs = {};
        for (const [path, content] of Object.entries(result?.outputs || {})) {
            if (typeof content === 'string') {
                trimmedOutputs[path] = content.length > MAX_STREAM_CHARS
                    ? content.slice(0, MAX_STREAM_CHARS) + `\n... (truncated, ${content.length - MAX_STREAM_CHARS} chars elided)`
                    : content;
            } else if (content instanceof Uint8Array) {
                trimmedOutputs[path] = `<binary, ${content.byteLength} bytes>`;
            } else if (content === null) {
                trimmedOutputs[path] = null;
            }
        }
        const succeeded = (result?.exitCode === 0);
        const toolResultPayload = {
            success: succeeded,
            note: succeeded
                ? 'The script completed successfully. exit_code=0. Summarize the result for the user from log_messages.'
                : 'The script failed. Read log_messages for the cause.',
            exit_code: result?.exitCode ?? null,
            stdout: (result?.stdout || '').slice(0, MAX_STREAM_CHARS),
            log_messages: (result?.stderr || '').slice(0, MAX_STREAM_CHARS),
            outputs: trimmedOutputs,
            duration_ms: Math.round(result?.durationMs ?? 0),
        };

        // Continuation history. Comparer's user turn is the same prompt
        // (already in ctx.userMessage). Assistant turn carries the
        // comparer's tool_use; tool turn carries the result.
        const continuationHistory = [
            ...this.conversationHistory,
            ctx.userMessage,
            {
                role: 'assistant',
                content: payload.assistant_text || '',
                tool_calls: [{
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input || {}),
                    },
                    ...(call.thought_signature ? { thought_signature: call.thought_signature } : {}),
                }],
            },
            {
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: JSON.stringify(toolResultPayload),
            },
        ];

        // The base request body carries skill_metadata, skill_content,
        // available_skills, attachment_ids — but for compareOnly we
        // need compare_provider (not provider) and we drop attachment_ids
        // since the comparer already saw the attachment on the first shot.
        const followUpBody = {
            ...ctx.baseRequestBody,
            message: '',
            conversation_history: continuationHistory,
            compare_provider: this.selectedComparer,
            attachment_ids: [],
            // Same rule as the primary continuation: stream only when
            // the bubble is visible. In compare-skill 2-iframe mode the
            // compare bubble is hidden, so streaming the summary text
            // serves no UX purpose — request non-streaming.
            // (Note: the backend's compareOnly currently always streams
            // regardless; this flag is here for when that gets fixed.)
            streaming: !this.messagesWrapper?.classList.contains('compare-artifacts-mode'),
        };
        // Strip primary-only fields the compareOnly endpoint doesn't use.
        delete followUpBody.provider;
        delete followUpBody.verification_enabled;
        delete followUpBody.compare_enabled;

        this._updateB3OverlayPhase(`Compare pane: ${this.getProviderDisplayName(this.selectedComparer)} responding…`);

        const resp = await fetch(window.apiUrl('/compare'), {
            method: 'POST',
            headers: this.getAuthHeaders(),
            body: JSON.stringify(followUpBody),
            signal: this.abortController?.signal,
        });
        if (!resp.ok) {
            throw new Error(`Compare continuation request failed: HTTP ${resp.status}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let nestedFinalResponse = null;
        let nestedPending = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            while (true) {
                const idx = buffer.indexOf('\n\n');
                if (idx === -1) break;
                const block = buffer.substring(0, idx);
                buffer = buffer.substring(idx + 2);
                if (!block.trim()) continue;
                let event = null;
                let data = '';
                let dataLineCount = 0;
                for (const line of block.split('\n')) {
                    if (line.startsWith('event:')) event = line.substring(6).trim();
                    else if (line.startsWith('data:')) {
                        const dl = line.substring(5);
                        const lc = dl.startsWith(' ') ? dl.substring(1) : dl;
                        if (dataLineCount > 0) data += '\n';
                        data += lc;
                        dataLineCount++;
                    }
                }
                if (!event || !data) continue;

                if (event === 'compare_chunk') {
                    if (ctx.compareMsgId) {
                        this.appendCompareChunk(ctx.compareMsgId, data);
                        this.scrollCompareToBottom?.();
                    }
                } else if (event === 'compare_response') {
                    try {
                        nestedFinalResponse = JSON.parse(data);
                        // Phase 2 (post-tool-result continuation) usage
                        // for the comparer. Accumulate and re-render the
                        // tokens badge so it shows the full turn total.
                        this._addUsageToAccumulator(this._compareUsage, nestedFinalResponse?.usage);
                        this._renderTokensBadge(this.compareArtifactTokensBadge, this._compareUsage);
                    } catch (e) { console.error('Parse compare response:', e); }
                } else if (event === 'compare_client_tool_call') {
                    try { nestedPending = JSON.parse(data); }
                    catch (e) { console.error('Parse nested compare_client_tool_call:', e); }
                } else if (event === 'compare_error') {
                    let compareErrMsg;
                    try { compareErrMsg = JSON.parse(data).message || data; }
                    catch (e) { compareErrMsg = data; }
                    this.appendCompareChunk(ctx.compareMsgId, `\n\n_Compare error: ${compareErrMsg}_`);
                    if (this.compareArtifactPane && !this.compareArtifactPane.classList.contains('hidden')) {
                        this._renderArtifactPaneError(
                            'compare',
                            this.getProviderDisplayName(this.selectedComparer),
                            compareErrMsg
                        );
                    }
                }
                // compare_complete / progress / others: ignored here.
            }
        }

        if (nestedPending) {
            const deeper = await this.dispatchCompareClientToolCall(nestedPending, ctx, depth + 1);
            return { finalResponse: deeper.finalResponse || nestedFinalResponse };
        }
        return { finalResponse: nestedFinalResponse };
    }

    /**
     * Thin wrapper around `_continueAfterClientToolResults` that preserves
     * the historical single-call signature. Any external callers (or new
     * code paths that only have one tool_result on hand) keep working.
     */
    async _continueAfterClientToolResult(call, payload, toolResultPayload, ctx, depth, followUpExtras = {}) {
        return this._continueAfterClientToolResults(
            payload,
            [{ call, toolResultPayload }],
            ctx,
            depth,
            followUpExtras,
        );
    }

    /**
     * Send N tool_results back to the LLM and stream the next turn,
     * recursing on any nested client_tool_call. Shared by all dispatch
     * branches so they don't each implement their own SSE follow-up
     * loop. The conversation_history shape mirrors the standard
     * Anthropic / OpenAI tool-use protocol: ONE assistant tool_use turn
     * carrying N tool_calls, followed by N role:'tool' turns — one per
     * tool_use_id, in the same order.
     *
     * Inputs:
     *   - payload: the original client_tool_call event (has assistant_text
     *     and the original tool_calls array).
     *   - results: ordered array of { call, toolResultPayload } pairs.
     *     Length and order MUST match payload.tool_calls (each entry
     *     pairs with the assistant tool_use that produced it).
     *   - followUpExtras: merged extras from any discover_skill branch
     *     (skill_content + skill_metadata) — last-wins merge done upstream.
     */
    async _continueAfterClientToolResults(payload, results, ctx, depth, followUpExtras = {}) {
        if (!Array.isArray(results) || results.length === 0) {
            throw new Error('_continueAfterClientToolResults: results array required');
        }

        // Provider-correct tool-round turns. Shared with the workflow runner
        // (window.AgentTurn) so the format — incl. Gemini's thought_signature
        // and per-tool function name — lives in ONE place and never drifts.
        const { assistantTurn, toolResultTurns } =
            window.AgentTurn.buildToolRoundTurns(results, payload.assistant_text);

        const continuationHistory = [
            ...this.conversationHistory,
            ctx.userMessage,
            assistantTurn,
            ...toolResultTurns,
        ];

        // Streaming decision: stream when the user can see the response
        // render. Single-pane skill turn → bubble visible; compare+skill
        // turn (2-iframe mode) → bubbles hidden, streaming is waste. We
        // detect compare mode via the live DOM class set in sendMessage.
        // Matches the prior inline run_skill_script continuation's rule.
        const streaming = !this.messagesWrapper?.classList.contains('compare-artifacts-mode');

        // followUpExtras lets the discover_skill branch promote a skill to
        // chip-equivalence for the next turn: by setting `skill_content`
        // (full SKILL.md body) and `skill_metadata` ({dir_name, scripts}),
        // the backend's `if ($skillMetadata !== null)` branch fires and
        // the next turn behaves exactly like a chip-dragged turn — body
        // appended to the system prompt with full authority, single-skill
        // tool schema, forced tool_choice to run_skill_script. Without
        // this the body is only visible as tool_result content, which
        // models de-prioritise compared to system prompt instructions.
        const followUpBody = {
            ...ctx.baseRequestBody,
            message: '',
            conversation_history: continuationHistory,
            // The user turn is already inside conversation_history, so
            // suppress verifier/compare for the follow-up — those phases
            // are turn-level and the first shot already triggered them
            // (or didn't, depending on settings). Re-running here would
            // double-count.
            verification_enabled: false,
            compare_enabled: false,
            // Strip attachment_ids: the LLM already saw the attachment on
            // the first shot (where it decided to call the tool). Re-
            // processing the same attachment server-side would prepend the
            // full document again to a fresh user turn — wasting input
            // tokens and latency for no gain.
            attachment_ids: [],
            streaming,
            ...followUpExtras,
        };
        if (Object.keys(followUpExtras).length > 0) {
            console.log('[B3 continue] follow-up body extras:', Object.keys(followUpExtras));
        }
        if (results.length > 1) {
            console.log(`[B3 continue] continuing with ${results.length} tool_result(s) paired to ${assistantToolCalls.length} tool_use(s)`);
        }

        const resp = await fetch(window.apiUrl('/chat'), {
            method: 'POST',
            headers: this.getAuthHeaders(),
            body: JSON.stringify(followUpBody),
            signal: this.abortController?.signal,
        });
        if (!resp.ok) {
            throw new Error(`Continuation request failed: HTTP ${resp.status}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let nestedFinalResponse = null;
        let nestedPending = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            while (true) {
                const idx = buffer.indexOf('\n\n');
                if (idx === -1) break;
                const block = buffer.substring(0, idx);
                buffer = buffer.substring(idx + 2);
                if (!block.trim()) continue;

                let event = null;
                let data = '';
                let dataLineCount = 0;
                for (const line of block.split('\n')) {
                    if (line.startsWith('event:')) {
                        event = line.substring(6).trim();
                    } else if (line.startsWith('data:')) {
                        const dl = line.substring(5);
                        const lc = dl.startsWith(' ') ? dl.substring(1) : dl;
                        if (dataLineCount > 0) data += '\n';
                        data += lc;
                        dataLineCount++;
                    }
                }
                if (!event || !data) continue;

                if (event === 'client_tool_call') {
                    try {
                        nestedPending = JSON.parse(data);
                    } catch (e) {
                        console.error('Failed to parse nested client_tool_call:', e);
                    }
                } else if (event === 'response') {
                    try {
                        nestedFinalResponse = JSON.parse(data);
                    } catch (e) {
                        console.error('Failed to parse nested response:', e);
                    }
                    this.handleSSEEvent(event, data, ctx.assistantMsgId);
                } else if (event === 'complete') {
                    // No-op; fall through to handleSSEEvent if it cares.
                } else {
                    this.handleSSEEvent(event, data, ctx.assistantMsgId);
                }
            }
        }

        if (nestedPending) {
            const deeper = await this.dispatchClientToolCall(nestedPending, ctx, depth + 1);
            return { finalResponse: deeper.finalResponse || nestedFinalResponse };
        }
        return { finalResponse: nestedFinalResponse };
    }

    /**
     * During a B3 turn the Stop button must not be actionable (Pyodide
     * can't be aborted; aborting the second-shot mid-tool-result is
     * messy). We grey it out and disable the click, but keep the "Stop"
     * label intact — the rich progress indicator lives in the chat
     * overlay (see _showB3Overlay) so this slot stays minimal.
     * Idempotent.
     */
    _enterB3IndicatorMode(_text) {
        if (!this.stopBtn) return;
        if (this._stopBtnOriginalClass !== undefined) return; // already in indicator mode
        this._stopBtnOriginalClass = this.stopBtn.className;
        this._stopBtnOriginalTitle = this.stopBtn.getAttribute('title') || '';

        this.stopBtn.disabled = true;
        this.stopBtn.setAttribute('title', 'Skill turn in progress — please wait');
        this.stopBtn.className = 'self-stretch bg-gray-400 text-white px-3 sm:px-4 md:px-6 py-2 md:py-3 rounded-lg font-medium flex items-center justify-center gap-1 md:gap-2 text-sm md:text-base cursor-not-allowed opacity-70';
    }

    /**
     * Restore the Stop button to its original interactive state. Always
     * called from sendMessage's finally, so it runs even if the turn
     * threw. Idempotent.
     */
    _exitB3IndicatorMode() {
        if (!this.stopBtn) return;
        if (this._stopBtnOriginalClass === undefined) return; // not in indicator mode
        this.stopBtn.disabled = false;
        this.stopBtn.className = this._stopBtnOriginalClass;
        if (this._stopBtnOriginalTitle) {
            this.stopBtn.setAttribute('title', this._stopBtnOriginalTitle);
        }
        this._stopBtnOriginalClass = undefined;
        this._stopBtnOriginalTitle = undefined;
    }

    /**
     * Centered overlay shown during a B3 turn. Anchored to the chat
     * viewport, semi-transparent backdrop (so streamed text remains
     * legible underneath), card itself opaque so the spinner and phase
     * text are crisp. The wrapper has pointer-events:none so the user
     * can still scroll the chat — the overlay is purely informational.
     *
     * Lifecycle:
     *   - _showB3Overlay(text)       — create on first call, show, set text
     *   - _updateB3OverlayPhase(t)   — cheap text update; no-op if hidden
     *   - _hideB3Overlay()           — hide; element stays in DOM for reuse
     */
    _showB3Overlay(text) {
        if (!this._b3Overlay) {
            // Anchor to the prompt input area: it's where the user just
            // acted (clicked Send) so their attention is already there,
            // and overlaying that region clearly signals "input is locked
            // — wait for the system to come back."
            const anchor = document.getElementById('input-area')
                || this.messagesWrapper
                || document.body;
            const wrap = document.createElement('div');
            wrap.id = 'b3-overlay';
            wrap.style.cssText = `
                position: absolute; inset: 0;
                display: flex; align-items: center; justify-content: center;
                pointer-events: none;
                z-index: 30;
            `;
            wrap.innerHTML = `
                <div data-b3-card style="
                    pointer-events: auto;
                    background: rgba(255,255,255,0.96);
                    backdrop-filter: blur(2px);
                    border: 1px solid rgba(59, 130, 246, 0.25);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.08);
                    border-radius: 12px;
                    padding: 14px 18px;
                    max-width: 92%;
                    display: flex; align-items: center; gap: 12px;
                    color: #1f2937;
                    font-size: 0.9rem;
                ">
                    <svg class="animate-spin shrink-0" style="width:24px;height:24px;color:#3b82f6;" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.25"></circle>
                        <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"></path>
                    </svg>
                    <div style="display:flex; flex-direction:column; gap:2px;">
                        <div style="font-weight:600;" data-b3-overlay-title>Working…</div>
                        <div style="font-size:0.78rem; color:#6b7280;">The system is processing in the background.</div>
                    </div>
                </div>
            `;
            // The anchor must be a positioned ancestor so absolute insets work.
            const computed = window.getComputedStyle(anchor);
            if (computed.position === 'static') {
                anchor.style.position = 'relative';
            }
            anchor.appendChild(wrap);
            this._b3Overlay = wrap;
        }
        const title = this._b3Overlay.querySelector('[data-b3-overlay-title]');
        if (title) title.textContent = (typeof text === 'string' && text.length > 0) ? text : 'Working…';
        this._b3Overlay.style.display = 'flex';
    }

    /**
     * URL interceptor for skill argv.
     *
     * If the active skill declares `fetches_urls: true` in its SKILL.md
     * frontmatter, scan argv for URL-shaped tokens, fetch each via the
     * server-side /api/v1/fetch-url endpoint, write the HTML into Pyodide's
     * MEMFS at /scratch/url-N.html, and rewrite argv to pass the file path
     * (with a `--source <url>` pair so reports still show the original).
     *
     * Skills without the flag are untouched. Returns null when interception
     * is skipped, otherwise { newArgv, addedInputFiles, fetched, warnings }.
     *
     * Existence rationale: Pyodide cannot perform cross-origin XHR for sites
     * that don't send Access-Control-Allow-Origin headers (≈ every production
     * site). Server-side PHP has no such restriction. This pattern lets any
     * fetch-needing skill opt in with one frontmatter line.
     */
    async _interceptUrlsInArgv(activeSkill, argv) {
        if (!activeSkill || !Array.isArray(argv) || argv.length === 0) return null;
        if (!window.skillsFs || typeof window.skillsFs.parseFrontmatter !== 'function') return null;
        if (!window.localFs) return null;

        // Read fetches_urls from the skill's SKILL.md frontmatter.
        // Mirrors the pattern in pyodide-runner.js getSkillDependencies().
        let fetchesUrls = false;
        try {
            const skillsDir = await window.localFs.resolvePath('skills');
            if (!skillsDir) return null;
            const skillDir = await skillsDir.getDirectoryHandle(activeSkill.dir_name, { create: false });
            const skillMdHandle = await skillDir.getFileHandle('SKILL.md', { create: false });
            const file = await skillMdHandle.getFile();
            const text = await file.text();
            const { meta } = window.skillsFs.parseFrontmatter(text);
            // YAML booleans come through as strings from the lightweight parser.
            const v = meta && meta.fetches_urls;
            fetchesUrls = (v === true) || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim()));
        } catch {
            return null;
        }
        if (!fetchesUrls) return null;

        const fetched = [];
        const warnings = [];
        const addedInputFiles = {};
        const newArgv = [];
        let urlIdx = 0;

        for (const tok of argv) {
            if (typeof tok !== 'string') { newArgv.push(tok); continue; }
            const url = this._normalizeUrlToken(tok);
            if (!url) { newArgv.push(tok); continue; }

            try {
                const resp = await fetch(window.apiUrl('/fetch-url'), {
                    method: 'POST',
                    headers: this.getAuthHeaders(),
                    body: JSON.stringify({ url }),
                });
                const json = await resp.json();
                if (!json || json.success !== true || !json.data || typeof json.data.html !== 'string') {
                    const msg = (json && json.error) || `fetch-url returned non-success for ${url}`;
                    warnings.push(msg);
                    newArgv.push(tok);  // leave the URL — script will raise its own error
                    continue;
                }
                const realUrl = json.data.final_url || url;
                const path = `/scratch/url-${urlIdx}.html`;
                urlIdx += 1;
                addedInputFiles[path] = json.data.html;
                fetched.push(realUrl);
                // Replace URL with the local file path; pass the original URL via --source
                // so the skill's report shows it (audit.py honors --source in file mode).
                newArgv.push(path, '--source', realUrl);
            } catch (e) {
                warnings.push(`fetch-url request failed for ${url}: ${e && e.message ? e.message : e}`);
                newArgv.push(tok);
            }
        }

        return { newArgv, addedInputFiles, fetched, warnings };
    }

    /**
     * Decide whether a token is a URL-shaped argument that should be fetched.
     * Returns the canonical https:// URL, or null if it isn't URL-shaped.
     *
     * Conservative on bare domains to avoid false positives:
     *   - Must have at least one dot.
     *   - TLD ≥ 2 letters.
     *   - No path-prefix indicators (`/`, `./`, `../`).
     *   - No `@` (skip emails).
     *   - No spaces.
     *   - Doesn't end in `.html`/`.htm`/`.md`/etc. (already a local file).
     */
    _normalizeUrlToken(s) {
        if (typeof s !== 'string' || s.length === 0) return null;
        const t = s.trim();
        if (/^https?:\/\//i.test(t)) return t;
        if (t.includes(' ') || t.includes('@')) return null;
        if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../')) return null;
        if (/\.(html?|md|markdown|txt|json|csv|xml|yml|yaml|css|js|py)$/i.test(t)) return null;
        const host = t.split('/', 1)[0];
        const parts = host.split('.');
        if (parts.length < 2) return null;
        const tld = parts[parts.length - 1];
        if (tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) return null;
        if (!/^[a-zA-Z0-9.\-]+$/.test(host)) return null;
        return `https://${t}`;
    }

    _updateB3OverlayPhase(text) {
        if (!this._b3Overlay) return;
        const title = this._b3Overlay.querySelector('[data-b3-overlay-title]');
        if (title) title.textContent = (typeof text === 'string' && text.length > 0) ? text : 'Working…';
    }

    _hideB3Overlay() {
        if (!this._b3Overlay) return;
        this._b3Overlay.style.display = 'none';
    }

    /**
     * Once the artifact pane is showing, the heavy lifting (Pyodide +
     * second-shot setup) is done. We free the UI even though Claude may
     * still be streaming a summary into the chat:
     *   - hide the overlay (work the user was waiting on is visibly done)
     *   - re-enable Send / hide Stop (next turn allowed)
     *   - clear the active skill chip and pending attachments — they've
     *     served their purpose; the document is the result and lives in
     *     the right pane (and on disk)
     *   - mark isLoading=false so a new send isn't blocked
     *
     * The trailing LLM stream keeps writing into the chat. If the user
     * sends a new prompt before it finishes, sendMessage detects the
     * still-running stream via _b3StreamFinalized and aborts it cleanly,
     * preserving the in-flight bubbles and pushing whatever's been
     * streamed so far to conversation_history.
     */
    _finalizeB3UIAfterArtifact(userMessage) {
        this._hideB3Overlay();
        this._exitB3IndicatorMode();
        this.isLoading = false;
        if (this.sendBtn) {
            this.sendBtn.classList.remove('hidden');
            this.sendBtn.disabled = false;
        }
        if (this.stopBtn) this.stopBtn.classList.add('hidden');
        if (typeof this.clearActiveSkill === 'function') this.clearActiveSkill();
        if (Array.isArray(this.pendingAttachments) && this.pendingAttachments.length > 0) {
            this.pendingAttachments = [];
            if (typeof this.renderAttachmentChips === 'function') {
                this.renderAttachmentChips();
            }
        }
        // Stash the in-flight user message so a new send (or a clean
        // natural exit) can push partial content to history before the
        // old fullContent is reset/discarded.
        this._lastB3UserMessage = userMessage || null;
        this._b3StreamFinalized = true;
    }

    /**
     * Open the artifact pane on the right with a document produced by a
     * folder-backed skill. `relPath` is the skill-relative output path
     * (e.g. "output_body.html"); `dirName` is the skill's folder name; the
     * pane header shows a friendly storage-relative path so the user can
     * find the file on disk. `content` is the file body; `kind` is one
     * of 'html' or 'markdown' — anything else is a no-op (V1 only opens
     * the pane for renderable types).
     *
     * The pane is sandboxed: HTML renders inside an <iframe srcdoc> with
     * sandbox="" (no origin, no script execution), so a malicious skill
     * can't pop modals or read parent-page state.
     */
    showArtifactPane(dirName, relPath, content, kind) {
        if (!this.artifactPane || !this.artifactPaneContent || !this.messagesWrapper) return;
        if (kind !== 'html' && kind !== 'markdown') return;

        // Header path: depends where the script wrote the file.
        //  • absolute /outputs/<file> → "<rootName>/outputs/<file>" (the
        //    canonical destination per spec — sibling of skills/)
        //  • skill-relative (no leading /) → "<rootName>/skills/<dirName>/<rel>"
        //    (legacy fallback for skills written before the /outputs/ convention)
        const rootName = (this._fsaRootName || 'storage');
        let fullPath;
        if (typeof relPath === 'string' && relPath.startsWith('/outputs/')) {
            fullPath = `${rootName}${relPath}`; // → synergyAI/outputs/foo.html
        } else if (typeof relPath === 'string' && relPath.startsWith('/')) {
            fullPath = `${rootName}${relPath}`; // any other absolute path under root
        } else {
            fullPath = `${rootName}/skills/${dirName}/${relPath}`;
        }
        if (this.artifactPanePath) {
            this.artifactPanePath.textContent = fullPath;
            this.artifactPanePath.setAttribute('title', fullPath);
        }
        if (this.artifactProviderBadge) {
            this.artifactProviderBadge.textContent = this.getProviderDisplayName(this.currentProvider);
            this.artifactProviderBadge.classList.remove('hidden');
        }

        // Render content. HTML goes through a sandboxed iframe; markdown
        // goes through the existing in-app renderer.
        this.artifactPaneContent.innerHTML = '';
        if (kind === 'html') {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', ''); // empty = strictest: no scripts, no same-origin, no forms
            iframe.style.cssText = 'width:100%; height:100%; border:0; background:white;';
            iframe.srcdoc = content;
            this.artifactPaneContent.appendChild(iframe);
        } else if (kind === 'markdown') {
            const wrap = document.createElement('div');
            wrap.className = 'markdown-content';
            wrap.style.cssText = 'padding:16px; height:100%; overflow:auto; background:white;';
            wrap.innerHTML = (typeof this.renderMarkdown === 'function')
                ? this.renderMarkdown(content)
                : this.escapeHtmlLocal(content);
            this.artifactPaneContent.appendChild(wrap);
        }

        // Activate split layout (mirrors verifier/compare logic).
        this.splitPaneActive = true;
        this.activeSplitMode = 'artifact';
        this.messagesWrapper.classList.add('split-active');
        this.artifactPane.classList.remove('hidden');
        if (this.splitPaneDivider) this.splitPaneDivider.classList.remove('hidden');
        if (this.primaryPaneHeader) this.primaryPaneHeader.classList.remove('hidden');

        // Elapsed-time badge: only stamp when we have a recorded
        // turn-start (set in sendMessage for compare-skill turns). Other
        // skill turns don't carry the timing context and leave the
        // badge hidden — matches the user's request "in the compare 2-
        // pane mode, show how long each provider took".
        if (this.artifactElapsedBadge && this._compareSkillTurnStartTime) {
            const ms = performance.now() - this._compareSkillTurnStartTime;
            this.artifactElapsedBadge.textContent = this._formatElapsed(ms);
            this.artifactElapsedBadge.classList.remove('hidden');
        }
        // Render whatever primary tokens we've accumulated so far. Phase
        // 1 usage was added before pyodide ran; Phase 2 usage gets added
        // when the continuation completes, which updates this badge
        // again. Hiding the badge for non-compare-skill turns is the
        // caller's responsibility (we only reset it on those entries).
        if (this._primaryUsage && (this._primaryUsage.input || this._primaryUsage.output)) {
            this._renderTokensBadge(this.artifactTokensBadge, this._primaryUsage);
        }
    }

    /**
     * Format a duration in ms as "Ns" (under 60s) or "Mm Ss" (60s+).
     * Tight, monospace-friendly for the header badges.
     */
    _formatElapsed(ms) {
        const seconds = ms / 1000;
        if (seconds < 60) return `${seconds.toFixed(1)}s`;
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds - m * 60);
        return `${m}m ${s}s`;
    }

    /**
     * Add a usage object's input/output token counts into the provided
     * accumulator. Tolerant of the field-name differences across
     * providers (Anthropic uses input_tokens/output_tokens, OpenAI uses
     * prompt_tokens/completion_tokens, others a mix). Missing fields
     * count as 0.
     */
    _addUsageToAccumulator(acc, usage) {
        if (!acc || !usage || typeof usage !== 'object') return;
        acc.input += Number(usage.input_tokens || usage.prompt_tokens || 0) || 0;
        acc.output += Number(usage.output_tokens || usage.completion_tokens || 0) || 0;
    }

    // Replace the placeholder/iframe in an artifact pane with a visible
    // error card. Used when the upstream provider fails during a turn
    // that has already opened the artifact pane — without this, the
    // user sees the spinner persist forever because the chat bubble
    // where errors normally land is hidden in compare-artifacts-mode.
    _renderArtifactPaneError(target, providerName, message) {
        const contentEl = target === 'compare'
            ? this.compareArtifactPaneContent
            : this.artifactPaneContent;
        if (!contentEl) return;
        const provider = this.escapeHtmlLocal(providerName || '');
        const msg = this.escapeHtmlLocal(message || 'Provider error');
        contentEl.innerHTML = `
            <div style="height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:24px; background:#fef2f2;">
                <div style="width:48px; height:48px; border-radius:50%; background:#fee2e2; display:flex; align-items:center; justify-content:center; font-size:26px; color:#b91c1c;">⚠</div>
                <div style="font-size:0.95rem; font-weight:600; color:#991b1b;">${provider} request failed</div>
                <div style="font-size:0.85rem; color:#7f1d1d; text-align:center; max-width:420px; line-height:1.5;">${msg}</div>
            </div>`;
    }

    // Mirror compare/verify mode state into the sidebar nav so the user
    // can see at a glance which auxiliary mode is active, even when the
    // current view is somewhere else (Skills, Workflows, Conversations).
    // Distinct from the `active` class which marks the CURRENT view.
    syncAuxModeIndicators() {
        if (this.navCompare) {
            this.navCompare.classList.toggle('mode-active', !!this.compareEnabled);
        }
        if (this.navVerifier) {
            this.navVerifier.classList.toggle('mode-active', !!this.verificationEnabled);
        }
    }

    // Some models JSON-encode the path and use the encoded form as the
    // object key in input_files, producing keys like `"/scratch/foo.html"`
    // (with literal quote characters). The FSA's getDirectoryHandle
    // rejects names containing `"` with "Name is not allowed".
    _sanitizeInputFilesKeys(obj) {
        if (!obj || typeof obj !== 'object') return {};
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            const key = (typeof k === 'string'
                && k.length >= 2 && k.startsWith('"') && k.endsWith('"'))
                ? k.slice(1, -1) : k;
            out[key] = v;
        }
        return out;
    }

    /**
     * Render a compact "↓N ↑M" tokens badge into the given DOM span.
     * Down-arrow = input (received by the model), up-arrow = output
     * (emitted by the model). Locale-grouped so 1234 reads as "1,234".
     */
    _renderTokensBadge(badgeEl, usage) {
        if (!badgeEl) return;
        const i = (usage?.input || 0).toLocaleString();
        const o = (usage?.output || 0).toLocaleString();
        badgeEl.textContent = `↓${i}  ↑${o}`;
        badgeEl.classList.remove('hidden');
    }

    /**
     * Close the artifact pane. Restores single-column layout. The next
     * skill output will open it again automatically.
     */
    hideArtifactPane() {
        if (!this.artifactPane || !this.messagesWrapper) return;
        this.artifactPane.classList.add('hidden');
        // Closing the primary artifact also drops the 2-iframe compare
        // layout so the chat panes can come back into view.
        this.messagesWrapper.classList.remove('compare-artifacts-mode');
        if (this.activeSplitMode === 'artifact') {
            this.splitPaneActive = false;
            this.activeSplitMode = null;
            this.messagesWrapper.classList.remove('split-active');
            if (this.splitPaneDivider) this.splitPaneDivider.classList.add('hidden');
            // Hide primary pane header iff no other split feature is active.
            if (this.primaryPaneHeader && !this.verificationEnabled && !this.compareEnabled) {
                this.primaryPaneHeader.classList.add('hidden');
            }
            if (this.primaryPane) this.primaryPane.style.width = '';
        }
        if (this.artifactPaneContent) this.artifactPaneContent.innerHTML = '';
    }

    /**
     * Open the compare artifact pane (4th pane). Mirrors openArtifactPane
     * but targets the comparer's pane elements. Used in compare mode to
     * render the comparer's run_skill_script output side-by-side with the
     * primary's artifact, so the user can visually compare what each
     * provider produced from the same prompt+skill+attachment.
     */
    openCompareArtifactPane(relPath, dirName, content, kind) {
        if (!this.compareArtifactPane || !this.compareArtifactPaneContent || !this.messagesWrapper) return;
        const rootName = (this._fsaRootName || 'storage');
        let fullPath;
        if (typeof relPath === 'string' && relPath.startsWith('/outputs/')) {
            fullPath = `${rootName}${relPath}`;
        } else if (typeof relPath === 'string' && relPath.startsWith('/')) {
            fullPath = `${rootName}${relPath}`;
        } else {
            fullPath = `${rootName}/skills/${dirName}/${relPath}`;
        }
        if (this.compareArtifactPanePath) {
            this.compareArtifactPanePath.textContent = fullPath;
            this.compareArtifactPanePath.setAttribute('title', fullPath);
        }
        if (this.compareArtifactProviderBadge) {
            this.compareArtifactProviderBadge.textContent = this.getProviderDisplayName(this.selectedComparer);
            this.compareArtifactProviderBadge.classList.remove('hidden');
        }
        this.compareArtifactPaneContent.innerHTML = '';
        if (kind === 'html') {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', '');
            iframe.style.cssText = 'width:100%; height:100%; border:0; background:white;';
            iframe.srcdoc = content;
            this.compareArtifactPaneContent.appendChild(iframe);
        } else if (kind === 'markdown') {
            const wrap = document.createElement('div');
            wrap.className = 'markdown-content';
            wrap.style.cssText = 'padding:16px; height:100%; overflow:auto; background:white;';
            wrap.innerHTML = (typeof this.renderMarkdown === 'function')
                ? this.renderMarkdown(content)
                : this.escapeHtmlLocal(content);
            this.compareArtifactPaneContent.appendChild(wrap);
        }
        // Activate split layout if not already (the primary artifact pane
        // will have done this for the primary's output; this just makes
        // sure the layout is in split mode if compare-artifact alone is
        // showing — uncommon but possible if primary has no artifact).
        this.splitPaneActive = true;
        this.messagesWrapper.classList.add('split-active');
        this.compareArtifactPane.classList.remove('hidden');
        if (this.splitPaneDivider) this.splitPaneDivider.classList.remove('hidden');
        if (this.primaryPaneHeader) this.primaryPaneHeader.classList.remove('hidden');

        // 2-IFRAME COMPARE MODE: when both panes have rendered an
        // artifact (this method fires AFTER the primary's because
        // pyodide runs serially: primary → comparer), switch the
        // layout to "two iframes only" — hide the primary chat and the
        // comparer chat. The chat bubbles were just narration of what
        // was about to be created; for a side-by-side comparison the
        // user wants the actual deliverable (the rendered HTML).
        // Toggling this class lets CSS hide the chat panes via a
        // single rule, without manipulating each pane individually.
        // Cleared when compare mode is disabled or chat is reset.
        if (this.artifactPane && !this.artifactPane.classList.contains('hidden')) {
            this.messagesWrapper.classList.add('compare-artifacts-mode');
        }

        // Elapsed-time badge for the comparer pane (mirrors the
        // primary's stamp in showArtifactPane).
        if (this.compareArtifactElapsedBadge && this._compareSkillTurnStartTime) {
            const ms = performance.now() - this._compareSkillTurnStartTime;
            this.compareArtifactElapsedBadge.textContent = this._formatElapsed(ms);
            this.compareArtifactElapsedBadge.classList.remove('hidden');
        }
        // Initial render of comparer tokens — Phase 1 captured from the
        // compare_response SSE event in sendMessage; Phase 2 will get
        // added in dispatchCompareClientToolCall after its continuation
        // SSE finishes, at which point the badge is re-rendered.
        if (this._compareUsage && (this._compareUsage.input || this._compareUsage.output)) {
            this._renderTokensBadge(this.compareArtifactTokensBadge, this._compareUsage);
        }
    }

    /**
     * Close the compare artifact pane only. Other panes (primary chat,
     * primary artifact, compare chat) stay as they are.
     */
    hideCompareArtifactPane() {
        if (!this.compareArtifactPane) return;
        this.compareArtifactPane.classList.add('hidden');
        if (this.compareArtifactPaneContent) this.compareArtifactPaneContent.innerHTML = '';
        // Drop the 2-iframe layout class — only one (or zero) artifact
        // pane is showing now, so the chat panes should come back.
        if (this.messagesWrapper) {
            this.messagesWrapper.classList.remove('compare-artifacts-mode');
        }
    }

    /**
     * Pick the first renderable file out of a runner outputs map and
     * return { relPath, content, kind } — or null if nothing renders.
     * V1 supports HTML and Markdown only; binary blobs (Uint8Array) and
     * unknown extensions are skipped.
     */
    _selectArtifactFromOutputs(outputs) {
        if (!outputs || typeof outputs !== 'object') return null;
        const renderable = (path, value) => {
            if (typeof value !== 'string') return null;     // binary or null → skip
            const lower = path.toLowerCase();
            if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
            if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
            return null;
        };
        // Prefer rendered HTML over Markdown when both are present in the
        // same outputs map. Common case: a multi-step skill emits both an
        // extract report (.md) and a final document (.html); users want
        // the rendered page in the right pane, not the report.
        let mdMatch = null;
        for (const [path, value] of Object.entries(outputs)) {
            const kind = renderable(path, value);
            if (!kind) continue;
            if (kind === 'html') return { relPath: path, content: value, kind };
            if (kind === 'markdown' && !mdMatch) {
                mdMatch = { relPath: path, content: value, kind };
            }
        }
        return mdMatch;
    }

    // True iff a skill result is a workflow DSL produced by workflow-compile.
    // Returns the parsed DSL ({name, description, definition:{nodes,edges}}) or null.
    _detectWorkflowOutput(dirName, outputs) {
        if (dirName !== 'workflow-compile' || !outputs) return null;
        for (const [path, content] of Object.entries(outputs)) {
            if (!/\.json$/i.test(path) || typeof content !== 'string') continue;
            try {
                const dsl = JSON.parse(content);
                if (dsl && dsl.definition && Array.isArray(dsl.definition.nodes)) return dsl;
            } catch (_) { /* not the DSL */ }
        }
        return null;
    }

    // Create the workflow in the engine. Returns the new id, or throws with the
    // backend's validation errors surfaced.
    async _createWorkflowFromDsl(dsl) {
        const token = window.authManager?.token || window.authManager?.getToken?.();
        const base = window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1';
        const resp = await fetch(`${base}/workflows`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                name: dsl.name || 'Untitled workflow',
                description: dsl.description || '',
                definition: dsl.definition,
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data?.success === false) {
            const errs = data?.validation_errors || data?.message || `HTTP ${resp.status}`;
            throw new Error(Array.isArray(errs) ? errs.join('; ') : String(errs));
        }
        return data?.data?.id ?? data?.id;
    }

    // Render a finished workflow run. Prefer the artifact the editor captured
    // during the run (report-pdf/html → overlay); else the markdown text inline.
    _renderWorkflowResult(run) {
        const art = window.workflowEditor?.lastProducedArtifact;
        // The chat artifact pane is showArtifactPane(dirName, relPath, content, kind);
        // lastProducedArtifact has shape { dirName, relPath, content, kind, ... }.
        if (art && art.relPath && typeof this.showArtifactPane === 'function') {
            this.showArtifactPane(art.dirName, art.relPath, art.content, art.kind);
            return;
        }
        const text = (run && run.result && typeof run.result.output === 'string') ? run.result.output : '';
        if (text.trim()) {
            this.addMessage('assistant', text);
        } else {
            this.showProgress('Workflow finished.');
        }
    }

    // Minimal modal: resolves 'editor' | 'run' | null (dismissed).
    _showWorkflowChoiceDialog(summary) {
        return new Promise((resolve) => {
            const ov = document.createElement('div');
            ov.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/40';
            ov.innerHTML = `
              <div class="bg-white rounded-xl shadow-xl p-5 max-w-sm w-full">
                <p class="text-sm text-gray-800 mb-4">${summary}<br>What would you like to do?</p>
                <div class="flex flex-col gap-2">
                  <button data-act="run"    class="px-3 py-2 rounded-md bg-indigo-600 text-white text-sm">▶ Run &amp; show the result</button>
                  <button data-act="editor" class="px-3 py-2 rounded-md border border-gray-300 text-sm">✏️ Open in the workflow editor</button>
                </div>
              </div>`;
            ov.addEventListener('click', (e) => {
                const act = e.target?.dataset?.act;
                if (act || e.target === ov) { ov.remove(); resolve(act || null); }
            });
            document.body.appendChild(ov);
        });
    }

    // After workflow-compile authored a DSL: create it, then ask the user.
    async _onWorkflowAuthored(dsl, userPrompt = '') {
        let id;
        try {
            this.showProgress('🔄 Building workflow…');
            id = await this._createWorkflowFromDsl(dsl);
        } catch (e) {
            this.addMessage('assistant', `⚠️ Could not create the workflow: ${e.message}`);
            return;
        }
        const agentCount = (dsl.definition.nodes || []).filter(n => n.node_type === 'agent').length;
        const summary = `Workflow “${dsl.name || 'Untitled'}” created — ${agentCount} agent(s).`;
        const choice = await this._showWorkflowChoiceDialog(summary);

        if (choice === 'editor') {
            // Reuse the canonical open flow: it reveals the panel (which lazily
            // creates window.workflowEditor), WAITS for the editor to be ready,
            // THEN loads the workflow — fixing the empty-canvas race.
            await this.openWorkflowFromContext(Number(id));
            return;
        }
        if (choice !== 'run') return;  // dismissed

        // window.workflowEditor is created lazily when the panel is first shown;
        // make sure it exists before we drive a run through it.
        const ed = await this._ensureWorkflowEditor();
        if (!ed) {
            this.addMessage('assistant', `⚠️ Could not open the workflow engine. The workflow is saved — open it in the editor to run.`);
            return;
        }
        // The run prompt must be a STRING — the backend's initTemplateProcessor
        // rejects arrays. Use the workflow's own start-node prompt (the chat
        // message can be a structured array and isn't the right run input anyway).
        const startNode = (dsl.definition.nodes || []).find(n => n.node_type === 'start');
        const runPrompt = (startNode && typeof startNode.config?.prompt === 'string' && startNode.config.prompt)
            ? startNode.config.prompt
            : (typeof userPrompt === 'string' ? userPrompt : '');
        try {
            this.showProgress('▶ Running workflow…');
            ed.lastProducedArtifact = null; // avoid showing a stale artifact
            const run = await ed.runHeadless(Number(id), runPrompt, {
                onProgress: (ev) => {
                    const name = ev.node?.agent_name || ev.agent_name || ev.node_id || '';
                    if (ev.type === 'node_start') this.showProgress(`▶ ${name}…`);
                    else if (ev.type === 'node_complete') this.showProgress(`✓ ${name}`);
                },
            });
            // The result + produced artifact are shown by the editor's own
            // results panel (runHeadless calls showWorkflowResults) since the
            // editor is the visible view during a chat-driven run. `run` is kept
            // for the return contract / future inline rendering.
            void run;
        } catch (e) {
            this.addMessage('assistant', `⚠️ Workflow run failed: ${e.message}. It's saved — open it in the editor to retry.`);
        }
    }

    // Ensure window.workflowEditor exists — it's lazily created when the agent-
    // teams panel is first shown. Reveals the panel if needed, then waits (up to
    // ~1s) for the editor to be ready. Returns the editor instance or null.
    async _ensureWorkflowEditor() {
        if (window.workflowEditor?.loadWorkflow) return window.workflowEditor;
        if (window.agentTeamsPanel?.show) window.agentTeamsPanel.show();
        for (let i = 0; i < 20; i++) {
            if (window.workflowEditor?.loadWorkflow) return window.workflowEditor;
            await new Promise(r => setTimeout(r, 50));
        }
        return null;
    }

    /**
     * Abort the current message generation
     * - Aborts the fetch stream (client side)
     * - Backend will detect disconnection via connection_aborted() and cancel upstream LLM call
     * - The user and assistant message bubbles will be removed in the catch block
     * - The exchange is NOT added to conversation history
     */
    abortCurrentMessage() {
        if (!this.isLoading || !this.abortController) return;
        this.aborted = true;
        this.abortController.abort();
    }

    handleSSEEvent(event, data, messageId) {
        switch (event) {
            case 'progress':
                this.showProgress(data);
                break;

            case 'chunk':
                this.appendChunk(messageId, data);
                break;

            case 'response':
                try {
                    const response = JSON.parse(data);
                    if (response.text) {
                        // Final render with complete content, isStreaming = false
                        this.updateMessage(messageId, response.text, false);
                    }
                } catch (e) {
                    console.error('Failed to parse response:', e);
                }
                break;

            case 'error':
                let primaryErrMsg;
                try {
                    primaryErrMsg = JSON.parse(data).message;
                } catch (e) {
                    primaryErrMsg = data;
                }
                this.updateMessage(messageId, `${window.i18n.t('messages.error')}: ${primaryErrMsg}`);
                if (this.artifactPane && !this.artifactPane.classList.contains('hidden')) {
                    this._renderArtifactPaneError(
                        'primary',
                        this.getProviderDisplayName(this.currentProvider),
                        primaryErrMsg
                    );
                }
                break;

            case 'mcp_ui':
                // MCP tool with UI - display the iframe
                console.log('📺 [SSE] Received mcp_ui event:', data);
                try {
                    const mcpData = JSON.parse(data);
                    console.log('📺 [SSE] Parsed MCP UI data:', mcpData);

                    // Deduplicate: check if we already displayed this UI (by viewUUID or tool+args hash)
                    const uiKey = mcpData.ui_info?.view_uuid ||
                                  `${mcpData.tool_name}_${JSON.stringify(mcpData.ui_info?.arguments || {})}`;
                    if (!this.displayedMCPUIs) {
                        this.displayedMCPUIs = new Set();
                    }
                    if (this.displayedMCPUIs.has(uiKey)) {
                        console.log('📺 [SSE] Skipping duplicate MCP UI:', uiKey);
                        break;
                    }
                    this.displayedMCPUIs.add(uiKey);

                    // Clear the set after 5 seconds to allow re-display if user asks again
                    setTimeout(() => this.displayedMCPUIs.delete(uiKey), 5000);

                    this.displayMCPUI(mcpData);
                } catch (e) {
                    console.error('Failed to parse MCP UI data:', e, 'Raw data:', data);
                }
                break;

            case 'usage_warning':
                try {
                    this.showUsageWarning(messageId, JSON.parse(data));
                } catch (e) {
                    console.error('Failed to parse usage_warning:', e);
                }
                break;

            case 'complete':
                // Flush any remaining buffered content (like incomplete headers)
                if (this.buffer && this.parserState.startsWith('BUFFERING_HEADER_')) {
                    const headerLevel = parseInt(this.parserState.replace('BUFFERING_HEADER_', ''));
                    this.displayHtml += `<h${headerLevel}>${this.escapeHtml(this.buffer)}</h${headerLevel}>`;

                    // Final render
                    const wrapper = document.getElementById(messageId);
                    if (wrapper) {
                        const bubble = wrapper.querySelector('div');
                        let streamContainer = bubble.querySelector('.streaming-content');
                        if (streamContainer) {
                            streamContainer.innerHTML = this.displayHtml;
                        }
                    }
                }


                // Send any remaining TTS buffer
                if (this.ttsBuffer && this.ttsBuffer.trim()) {
                    this.sendToElevenLabs(this.ttsBuffer.trim());
                    this.ttsBuffer = '';
                }

                this.hideProgress();

                // Clear streaming state (but keep fullContent for conversation history)
                this.parserState = 'NORMAL';
                this.buffer = '';
                this.displayHtml = '';
                // Don't reset fullContent here - it's needed for conversation history after the loop
                this.carryOver = '';
                this.lastRenderTime = null;
                break;
        }
    }

    /**
     * Append chunk to verifier message - swaps state, calls appendChunk, swaps back
     */
    appendVerifierChunk(messageId, chunk, isRecursive = false) {
        // Save primary state
        const savedPrimary = {
            parserState: this.parserState,
            buffer: this.buffer,
            displayHtml: this.displayHtml,
            fullContent: this.fullContent,
            carryOver: this.carryOver,
            currentCodeBlockPlaceholder: this.currentCodeBlockPlaceholder
        };

        // Load verifier state into primary variables
        this.parserState = this.verifierParserState;
        this.buffer = this.verifierBuffer;
        this.displayHtml = this.verifierDisplayHtml;
        this.fullContent = this.verifierFullContent;
        this.carryOver = this.verifierCarryOver;
        this.currentCodeBlockPlaceholder = this.verifierCurrentCodeBlockPlaceholder;

        // Call the original appendChunk
        this.appendChunk(messageId, chunk, isRecursive);

        // Save verifier state back
        this.verifierParserState = this.parserState;
        this.verifierBuffer = this.buffer;
        this.verifierDisplayHtml = this.displayHtml;
        this.verifierFullContent = this.fullContent;
        this.verifierCarryOver = this.carryOver;
        this.verifierCurrentCodeBlockPlaceholder = this.currentCodeBlockPlaceholder;

        // Restore primary state
        this.parserState = savedPrimary.parserState;
        this.buffer = savedPrimary.buffer;
        this.displayHtml = savedPrimary.displayHtml;
        this.fullContent = savedPrimary.fullContent;
        this.carryOver = savedPrimary.carryOver;
        this.currentCodeBlockPlaceholder = savedPrimary.currentCodeBlockPlaceholder;
    }

    /**
     * Append chunk to compare message - swaps state, calls appendChunk, swaps back
     * Ensures the comparison panel goes through the same streaming parser as the
     * primary panel, so in-progress code/SVG blocks show a placeholder instead of
     * raw streamed markup.
     */
    appendCompareChunk(messageId, chunk, isRecursive = false) {
        // Save primary state
        const savedPrimary = {
            parserState: this.parserState,
            buffer: this.buffer,
            displayHtml: this.displayHtml,
            fullContent: this.fullContent,
            carryOver: this.carryOver,
            currentCodeBlockPlaceholder: this.currentCodeBlockPlaceholder
        };

        // Load compare state into primary variables
        this.parserState = this.compareParserState;
        this.buffer = this.compareBuffer;
        this.displayHtml = this.compareDisplayHtml;
        this.fullContent = this.compareFullContent;
        this.carryOver = this.compareCarryOver;
        this.currentCodeBlockPlaceholder = this.compareCurrentCodeBlockPlaceholder;

        // Call the original appendChunk
        this.appendChunk(messageId, chunk, isRecursive);

        // Save compare state back
        this.compareParserState = this.parserState;
        this.compareBuffer = this.buffer;
        this.compareDisplayHtml = this.displayHtml;
        this.compareFullContent = this.fullContent;
        this.compareCarryOver = this.carryOver;
        this.compareCurrentCodeBlockPlaceholder = this.currentCodeBlockPlaceholder;

        // Restore primary state
        this.parserState = savedPrimary.parserState;
        this.buffer = savedPrimary.buffer;
        this.displayHtml = savedPrimary.displayHtml;
        this.fullContent = savedPrimary.fullContent;
        this.carryOver = savedPrimary.carryOver;
        this.currentCodeBlockPlaceholder = savedPrimary.currentCodeBlockPlaceholder;
    }

    appendChunk(messageId, chunk, isRecursive = false) {
        // Skip undefined/null chunks
        if (chunk === undefined || chunk === null || chunk === '') {
            return;
        }

        // Initialize parser state
        if (!this.parserState) {
            this.parserState = 'NORMAL';
            this.buffer = '';
            this.displayHtml = '';
            this.fullContent = '';
            this.carryOver = ''; // For partial delimiters at chunk boundaries
        }

        // Only add to fullContent on first call, not on recursive calls
        // Add BEFORE prepending carryOver to avoid double-adding carried content
        if (!isRecursive) {
            this.fullContent += chunk;
        }

        // Prepend any carry-over from previous chunk (partial delimiters)
        if (this.carryOver) {
            chunk = this.carryOver + chunk;
            this.carryOver = '';
        }

        // If we're buffering a markdown construct, just add to buffer
        if (this.parserState !== 'NORMAL') {
            this.buffer += chunk;

            // Check for closing delimiters
            if (this.parserState === 'BUFFERING_CODE_BLOCK') {
                const match = this.buffer.match(/```[\s\S]*?```/);
                if (match) {
                    const codeBlock = match[0];
                    let replacementHtml = '';

                    // Check if it's an SVG block by language tag (```svg)
                    const svgByLangMatch = codeBlock.match(/```svg\s*\n?([\s\S]*?)```/i);
                    // Check if it's a mermaid block by language tag (```mermaid)
                    const mermaidByLangMatch = codeBlock.match(/```mermaid\s*\n?([\s\S]*?)```/i);

                    if (svgByLangMatch) {
                        // Render actual SVG from ```svg block
                        const svgContent = svgByLangMatch[1].trim();
                        const sanitizedSVG = this.sanitizeSVG(svgContent);
                        replacementHtml = `<div class="svg-render-container"><div class="svg-display">${sanitizedSVG}</div></div>`;
                    } else if (mermaidByLangMatch) {
                        // Don't display the mermaid source during streaming — show
                        // a rendering placeholder that mirrors the SVG path. The
                        // raw source survives in the full content string that
                        // updateMessage(string) receives at end-of-stream; the
                        // final render pass calls renderMermaidIn() which turns
                        // <pre><code.language-mermaid> blocks into SVG diagrams.
                        // This eliminates the flash of raw mermaid code between
                        // closing-``` and end-of-stream final render.
                        replacementHtml = '<div class="svg-placeholder mermaid-pending-stream"><div class="svg-placeholder-spinner"></div><div><span class="svg-placeholder-label">Rendering diagram…</span></div></div>';
                    } else {
                        // Check if it's a markdown block by language tag (```markdown or ```md)
                        const mdByLangMatch = codeBlock.match(/```(?:markdown|md)\s*\n?([\s\S]*?)```/i);

                        if (mdByLangMatch) {
                            // Extract markdown content and render it (recursive interpretation)
                            // This allows embedded SVG, code blocks, etc. to be properly processed
                            const mdContent = mdByLangMatch[1].trim();
                            replacementHtml = this.renderMarkdown(mdContent);
                        } else {
                            // Extract code content for other code blocks
                            const codeContentMatch = codeBlock.match(/```(\w*)\s*\n?([\s\S]*?)```/);
                            const langTag = codeContentMatch ? codeContentMatch[1].toLowerCase() : '';
                            const codeContent = codeContentMatch ? codeContentMatch[2].trim() : '';

                            // Check if content contains SVG (for ```xml or unmarked blocks)
                            const svgInContent = /<svg[\s\S]*<\/svg>/i.test(codeContent);

                            if (svgInContent && (langTag === '' || langTag === 'xml' || langTag === 'html')) {
                                // Extract and render SVG from content
                                const svgMatch = codeContent.match(/<svg[\s\S]*<\/svg>/i);
                                if (svgMatch) {
                                    const sanitizedSVG = this.sanitizeSVG(svgMatch[0]);
                                    replacementHtml = `<div class="svg-render-container"><div class="svg-display">${sanitizedSVG}</div></div>`;
                                } else {
                                    // Fallback to code block
                                    const html = marked.parse(codeBlock);
                                    if (html && html !== 'undefined') {
                                        replacementHtml = html;
                                    }
                                }
                            } else {
                                // Use marked.js to render regular code blocks
                                const html = marked.parse(codeBlock);
                                if (html && html !== 'undefined') {
                                    replacementHtml = html;
                                }
                            }
                        }
                    }

                    // Replace the placeholder with actual content
                    if (this.currentCodeBlockPlaceholder) {
                        const placeholderRegex = new RegExp(`<div id="${this.currentCodeBlockPlaceholder}"[^>]*>.*?</div>`, 's');
                        this.displayHtml = this.displayHtml.replace(placeholderRegex, replacementHtml);
                        this.currentCodeBlockPlaceholder = null;
                    } else {
                        // Fallback if no placeholder (shouldn't happen)
                        this.displayHtml += replacementHtml;
                    }

                    // Any text after closing ```
                    const remaining = this.buffer.substring(match[0].length);
                    this.buffer = '';
                    this.parserState = 'NORMAL';
                    // Process remaining text
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                }
            } else if (this.parserState === 'BUFFERING_BOLD') {
                const match = this.buffer.match(/\*\*.*?\*\*/);
                if (match) {
                    const html = marked.parseInline(match[0]);
                    if (html && html !== 'undefined') {
                        this.displayHtml += html;
                    }
                    const remaining = this.buffer.substring(match[0].length);
                    this.buffer = '';
                    this.parserState = 'NORMAL';
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                }
            } else if (this.parserState === 'BUFFERING_ITALIC') {
                const match = this.buffer.match(/\*[^*]+?\*/);
                if (match) {
                    const html = marked.parseInline(match[0]);
                    if (html && html !== 'undefined') {
                        this.displayHtml += html;
                    }
                    const remaining = this.buffer.substring(match[0].length);
                    this.buffer = '';
                    this.parserState = 'NORMAL';
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                }
            } else if (this.parserState === 'BUFFERING_INLINE_CODE') {
                const match = this.buffer.match(/`[^`]+?`/);
                if (match) {
                    const html = marked.parseInline(match[0]);
                    if (html && html !== 'undefined') {
                        this.displayHtml += html;
                    }
                    const remaining = this.buffer.substring(match[0].length);
                    this.buffer = '';
                    this.parserState = 'NORMAL';
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                }
            } else if (this.parserState === 'BUFFERING_TABLE') {
                // Find the first *complete* line (terminated by \n) that ends the table:
                // a blank line or any line that doesn't start with '|'.
                let tableEndIdx = -1;
                let scanPos = 0;
                let completeLineCount = 0;
                while (scanPos < this.buffer.length) {
                    const nlIdx = this.buffer.indexOf('\n', scanPos);
                    if (nlIdx === -1) break; // last line is partial, no terminator
                    const line = this.buffer.substring(scanPos, nlIdx);
                    const trimmed = line.trim();
                    if (trimmed === '' || !trimmed.startsWith('|')) {
                        tableEndIdx = scanPos;
                        break;
                    }
                    completeLineCount++;
                    scanPos = nlIdx + 1;
                }

                // Early bailout: once we have ≥2 complete lines, line 2 must be a
                // GFM separator row. If not, this isn't a table — flush as plain
                // text so content doesn't get stuck in the placeholder.
                if (completeLineCount >= 2) {
                    const firstNl = this.buffer.indexOf('\n');
                    const secondNl = this.buffer.indexOf('\n', firstNl + 1);
                    const sepLine = this.buffer.substring(firstNl + 1, secondNl).trim();
                    const isSep = /^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(sepLine) && sepLine.includes('-');
                    if (!isSep) {
                        this.replaceTablePlaceholder(this.escapeHtml(this.buffer));
                        this.currentTablePlaceholderId = null;
                        this.buffer = '';
                        this.parserState = 'NORMAL';
                        this.updateStreamingDisplay(messageId);
                        return;
                    }
                }

                if (tableEndIdx !== -1) {
                    // Table region ended. If valid, render as a table; otherwise
                    // fall back to plain escaped text (covers the "one `|` line
                    // followed by regular prose" case).
                    const tableText = this.buffer.substring(0, tableEndIdx);
                    const remaining = this.buffer.substring(tableEndIdx);
                    if (this.isValidTable(tableText)) {
                        this.replaceTablePlaceholder(this.renderStreamingTable(tableText));
                    } else {
                        this.replaceTablePlaceholder(this.escapeHtml(tableText));
                    }
                    this.currentTablePlaceholderId = null;
                    this.buffer = '';
                    this.parserState = 'NORMAL';
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                }

                // Still buffering - render partial using complete lines only
                const lastNl = this.buffer.lastIndexOf('\n');
                const completePart = lastNl === -1 ? '' : this.buffer.substring(0, lastNl);
                const partialHtml = this.renderStreamingTable(completePart);
                this.replaceTablePlaceholder(partialHtml);
                this.updateStreamingDisplay(messageId);
                return;
            } else if (this.parserState.startsWith('BUFFERING_HEADER_')) {
                // Buffer already contains accumulated chunks (added at line 621)
                // Check for newline anywhere in the accumulated buffer
                const newlineIndex = this.buffer.indexOf('\n');
                if (newlineIndex !== -1) {
                    // Found complete header
                    const headerContent = this.buffer.substring(0, newlineIndex);
                    const headerLevel = parseInt(this.parserState.replace('BUFFERING_HEADER_', ''));

                    // Convert to HTML heading using marked.js for consistent styling
                    const headerMarkdown = '#'.repeat(headerLevel) + ' ' + headerContent;
                    const html = marked.parse(headerMarkdown).trim();
                    if (html && html !== 'undefined') {
                        this.displayHtml += html;
                    }

                    // Process remaining text after the newline
                    let remaining = this.buffer.substring(newlineIndex + 1);
                    this.buffer = '';
                    this.parserState = 'NORMAL';
                    if (remaining) {
                        // Process remaining text, preserving all newlines
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                }
            }

            // Still buffering, wait for more chunks
            this.updateStreamingDisplay(messageId);
            return;
        }

        // NORMAL state - check if we're at the start of a line and chunk begins with
        // a '|' - this is a table row start. (The '\n|' case is handled by the
        // delimiter regex below.)
        // displayHtml holds rendered HTML, not raw markdown. Two forms count
        // as line-start here:
        //   1. A literal trailing '\n' — happens when prior chunks contained
        //      newlines that *weren't* run through escapeHtml.
        //   2. A trailing block boundary — </p>, </h3>, </li>, etc. — or a
        //      <br> (escapeHtml converts every '\n' to '<br>', so plain prose
        //      with '\n\n' separator ends up as '<br><br>' here, not '\n').
        // Without case #2 we'd miss tables that follow a paragraph or
        // header and they'd render only at end-of-stream.
        const lineEndRegex = /(?:<\/(?:p|li|ul|ol|h[1-6]|blockquote|pre|table|div)>|<br\s*\/?>)\s*$/i;
        const atLineStart = this.displayHtml === ''
            || /\n[\t ]*$/.test(this.displayHtml)
            || lineEndRegex.test(this.displayHtml);
        if (atLineStart && chunk.charAt(0) === '|') {
            this.enterTableState();
            this.appendChunk(messageId, chunk, true);
            return;
        }

        // NORMAL state - First check for header symbols anywhere in chunk
        const headerRegex = /(?<!#)#{1,6}(?!#)/;
        const headerMatch = headerRegex.exec(chunk);

        if (headerMatch) {
            const headerStartIndex = headerMatch.index;
            const headerSymbols = headerMatch[0];
            const headerLevel = headerSymbols.length;

            // Look for newline after header symbols
            const afterHeaderStart = headerStartIndex + headerLevel;
            const afterHeader = chunk.substring(afterHeaderStart);
            const newlineIndex = afterHeader.indexOf('\n');

            if (newlineIndex !== -1) {
                // Complete header found - has ending newline
                // Process text before header
                const textBefore = chunk.substring(0, headerStartIndex);
                if (textBefore) {
                    this.displayHtml += this.escapeHtml(textBefore);
                }

                // Extract header content (everything between ## and \n, trimmed)
                const headerContent = afterHeader.substring(0, newlineIndex).trim();
                const headerMarkdown = headerSymbols + ' ' + headerContent;
                const html = marked.parse(headerMarkdown).trim();
                if (html && html !== 'undefined') {
                    this.displayHtml += html;
                }

                // Process remaining text after newline
                const remaining = chunk.substring(afterHeaderStart + newlineIndex + 1);
                if (remaining) {
                    this.appendChunk(messageId, remaining, true);
                }
                this.updateStreamingDisplay(messageId);
                return;
            } else {
                // Incomplete header - no newline yet, carry over
                // Process text before header
                const textBefore = chunk.substring(0, headerStartIndex);
                if (textBefore) {
                    this.displayHtml += this.escapeHtml(textBefore);
                }

                // Carry over header symbols and everything after
                this.carryOver = chunk.substring(headerStartIndex);
                this.updateStreamingDisplay(messageId);
                return;
            }
        }

        // No headers found - check for other delimiters (including table start \n|)
        const delimiterRegex = /```|\*\*|\*|`|\n\|/g;
        const matches = [];
        let match;

        while ((match = delimiterRegex.exec(chunk)) !== null) {
            matches.push({
                delimiter: match[0],
                index: match.index
            });
        }

        if (matches.length === 0) {
            // No delimiters - just append as plain text
            // Check for partial delimiters at end (headers handled separately above)
            if (chunk.endsWith('``') || chunk.endsWith('`') || chunk.endsWith('**') || chunk.endsWith('*')) {
                // Save potential partial delimiter for next chunk
                const lastThree = chunk.slice(-3);
                if (lastThree === '```' || lastThree.startsWith('``')) {
                    this.carryOver = lastThree.match(/`+$/)[0];
                    chunk = chunk.slice(0, -this.carryOver.length);
                } else if (chunk.endsWith('**')) {
                    this.carryOver = '**';
                    chunk = chunk.slice(0, -2);
                } else if (chunk.endsWith('*')) {
                    this.carryOver = '*';
                    chunk = chunk.slice(0, -1);
                }
            }
            this.displayHtml += this.escapeHtml(chunk);
        } else {
            // Process text and delimiters
            let lastIndex = 0;

            for (let i = 0; i < matches.length; i++) {
                const m = matches[i];

                // Add text before delimiter
                if (m.index > lastIndex) {
                    const text = chunk.substring(lastIndex, m.index);
                    this.displayHtml += this.escapeHtml(text);
                }

                // Handle delimiter
                if (m.delimiter === '```') {
                    this.parserState = 'BUFFERING_CODE_BLOCK';
                    this.buffer = '```';
                    // Show placeholder immediately
                    const placeholderId = `code-block-${Date.now()}-${Math.random()}`;
                    this.currentCodeBlockPlaceholder = placeholderId;
                    this.displayHtml += `<div id="${placeholderId}" class="svg-placeholder"><div class="svg-placeholder-spinner"></div><div><span class="svg-placeholder-label">Generating graph</span></div></div>`;
                    const remaining = chunk.substring(m.index + 3);
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                } else if (m.delimiter === '**') {
                    this.parserState = 'BUFFERING_BOLD';
                    this.buffer = '**';
                    const remaining = chunk.substring(m.index + 2);
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                } else if (m.delimiter === '*') {
                    this.parserState = 'BUFFERING_ITALIC';
                    this.buffer = '*';
                    const remaining = chunk.substring(m.index + 1);
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                } else if (m.delimiter === '`') {
                    this.parserState = 'BUFFERING_INLINE_CODE';
                    this.buffer = '`';
                    const remaining = chunk.substring(m.index + 1);
                    if (remaining) {
                        this.appendChunk(messageId, remaining, true);
                    }
                    return;
                } else if (m.delimiter === '\n|') {
                    // Table start after a newline - emit the newline, enter
                    // BUFFERING_TABLE, and recurse with the '|' (and rest) as input.
                    this.displayHtml += '\n';
                    this.enterTableState();
                    const remaining = '|' + chunk.substring(m.index + 2);
                    this.appendChunk(messageId, remaining, true);
                    return;
                }

                lastIndex = m.index + m.delimiter.length;
            }

            // Add any remaining text after last delimiter
            if (lastIndex < chunk.length) {
                let text = chunk.substring(lastIndex);

                // Check for partial delimiters at end that should carry over
                const partialMatch = text.match(/(``|`|\*\*|\*)$/);
                if (partialMatch) {
                    this.carryOver = partialMatch[0];
                    text = text.slice(0, -this.carryOver.length);
                }

                this.displayHtml += this.escapeHtml(text);
            }
        }

        // Throttle rendering (60fps)
        const now = Date.now();
        const shouldRender = !this.lastRenderTime || now - this.lastRenderTime > 16;

        if (shouldRender) {
            this.updateStreamingDisplay(messageId);
            this.lastRenderTime = now;
        }

        // TTS (skip during code blocks)
        if (this.parserState === 'NORMAL') {
            if (!this.ttsBuffer) {
                this.ttsBuffer = '';
            }
            this.ttsBuffer += chunk;

            const sentences = this.extractCompleteSentences();
            sentences.forEach(sentence => {
                this.sendToElevenLabs(sentence);
            });
        }
    }

    updateStreamingDisplay(messageId) {
        const wrapper = document.getElementById(messageId);
        if (!wrapper) return;

        const bubble = wrapper.querySelector('div');

        // Get or create streaming container
        let streamContainer = bubble.querySelector('.streaming-content');
        if (!streamContainer) {
            streamContainer = document.createElement('div');
            streamContainer.className = 'streaming-content markdown-content';
            bubble.innerHTML = '';
            bubble.appendChild(streamContainer);
            // Initialize displayHtml on first call
            if (!this.displayHtml) {
                this.displayHtml = '';
            }
        }

        // Display the HTML we've built progressively
        let displayHtml = this.displayHtml || '';

        streamContainer.innerHTML = displayHtml;
        streamContainer.style.whiteSpace = 'pre-wrap';
    }

    /**
     * Enter BUFFERING_TABLE state and insert a placeholder bounded by HTML
     * comment markers so subsequent incremental updates can safely replace
     * the inner content even when it contains nested <div>s.
     */
    enterTableState() {
        this.parserState = 'BUFFERING_TABLE';
        this.buffer = '';
        const placeholderId = `table-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        this.currentTablePlaceholderId = placeholderId;
        const startMarker = `<!--table-start-${placeholderId}-->`;
        const endMarker = `<!--table-end-${placeholderId}-->`;
        const initialHtml = '<div class="streaming-table-placeholder" style="color:#6b7280;font-style:italic;padding:8px 0;">Generating table...</div>';
        this.displayHtml += startMarker + initialHtml + endMarker;
    }

    /**
     * Replace the inner HTML between the current table placeholder's comment
     * markers. Safe for repeated calls because the markers are unique and
     * don't collide with generated HTML.
     */
    replaceTablePlaceholder(innerHtml) {
        if (!this.currentTablePlaceholderId) return;
        const startMarker = `<!--table-start-${this.currentTablePlaceholderId}-->`;
        const endMarker = `<!--table-end-${this.currentTablePlaceholderId}-->`;
        const startIdx = this.displayHtml.indexOf(startMarker);
        const endIdx = this.displayHtml.indexOf(endMarker);
        if (startIdx === -1 || endIdx === -1) return;
        this.displayHtml =
            this.displayHtml.substring(0, startIdx + startMarker.length) +
            innerHtml +
            this.displayHtml.substring(endIdx);
    }

    /**
     * Returns true if `text` contains a header row followed by a GFM
     * separator row (dashes with optional colons for alignment).
     */
    isValidTable(text) {
        if (!text) return false;
        const lines = text.split('\n').filter(l => l.trim() !== '');
        if (lines.length < 2) return false;
        const sep = lines[1].trim();
        return /^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(sep) && sep.includes('-');
    }

    /**
     * Render a (possibly partial) GFM table to HTML for the streaming view.
     * Requires a header row plus separator row before emitting a <table>;
     * earlier than that, shows a "Generating table..." placeholder.
     */
    renderStreamingTable(tableText) {
        const placeholder = '<div class="streaming-table-placeholder" style="color:#6b7280;font-style:italic;padding:8px 0;">Generating table...</div>';
        if (!tableText || !tableText.trim()) return placeholder;

        const lines = tableText.split('\n').filter(l => l.trim() !== '');
        if (lines.length < 2) return placeholder;

        // Line 2 must look like a GFM separator row (dashes with optional
        // colons for alignment, separated by pipes).
        const sepLine = lines[1].trim();
        const isSeparator = /^\|?[\s:-]+(\|[\s:-]+)+\|?$/.test(sepLine) && sepLine.includes('-');
        if (!isSeparator) return placeholder;

        // If only header+separator so far, append an empty data row so marked
        // will actually render a <table> shell (otherwise it emits nothing).
        let mdToRender = lines.join('\n');
        if (lines.length === 2) {
            const headerCellCount = lines[0].split('|').filter((c, i, arr) => {
                // Ignore leading/trailing empties from surrounding pipes
                if ((i === 0 || i === arr.length - 1) && c.trim() === '') return false;
                return true;
            }).length;
            if (headerCellCount > 0) {
                mdToRender += '\n|' + ' |'.repeat(headerCellCount);
            }
        }

        try {
            if (typeof marked.use === 'function') {
                marked.use({ gfm: true, breaks: true, headerIds: false });
            }
            const html = marked.parse(mdToRender);
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = html;
            // Wrap tables in a responsive container (matches renderMarkdown)
            tempDiv.querySelectorAll('table').forEach(table => {
                if (!table.closest('.table-container')) {
                    const container = document.createElement('div');
                    container.className = 'table-container';
                    const clone = table.cloneNode(true);
                    container.appendChild(clone);
                    table.replaceWith(container);
                }
            });
            return tempDiv.innerHTML || placeholder;
        } catch (e) {
            console.error('renderStreamingTable error:', e);
            return placeholder;
        }
    }

    extractCompleteSentences() {
        const sentences = [];
        const sentenceEndRegex = /[.!?]\s/g;
        let match;

        while ((match = sentenceEndRegex.exec(this.ttsBuffer)) !== null) {
            const sentence = this.ttsBuffer.substring(0, match.index + 1).trim();
            if (sentence) {
                sentences.push(sentence);
            }
            this.ttsBuffer = this.ttsBuffer.substring(match.index + 2);
            // Reset regex after modifying buffer
            sentenceEndRegex.lastIndex = 0;
        }

        return sentences;
    }

    sendToElevenLabs(text) {
        // TODO: Integrate with ElevenLabs API
        // For now, do nothing
        // console.log('[ElevenLabs TTS]:', text);

        // Future implementation:
        // - Call ElevenLabs text-to-speech endpoint
        // - Queue audio for playback similar to Hume EVI
        // - Handle audio streaming
    }

    addMessage(type, content, isPlaceholder = false, provider = null) {
        const id = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const wrapper = document.createElement('div');
        wrapper.id = id;
        wrapper.className = `flex ${type === 'user' ? 'justify-end' : 'justify-center'}`;

        // Store provider for this message
        if (provider) {
            wrapper.setAttribute('data-provider', provider);
        }

        const bubble = document.createElement('div');
        bubble.className = type === 'user'
            ? 'max-w-[80%] bg-blue-600 text-white px-4 py-3 rounded-2xl rounded-br-md'
            : 'max-w-[80%] bg-white border border-gray-200 text-gray-800 px-4 py-3 rounded-2xl rounded-bl-md shadow-sm';

        if (isPlaceholder) {
            bubble.innerHTML = `
                <div class="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            `;
        } else if (type === 'user') {
            // Create a container for the message content (vertical layout)
            const messageContainer = document.createElement('div');
            messageContainer.className = 'flex flex-col gap-1 w-full';

            // Message text at the top
            const messageText = document.createElement('span');
            messageText.textContent = content;

            // Store message content for later saving
            messageText.setAttribute('data-message-content', content);
            messageContainer.appendChild(messageText);

            // Create bottom row for provider badge and action icons
            const bottomRow = document.createElement('div');
            bottomRow.className = 'flex items-center justify-between gap-2';

            // Add provider badge if provider is specified
            if (provider) {
                const style = this.providerStyles[provider] || this.providerStyles.default;
                const providerBadge = document.createElement('div');
                providerBadge.className = 'text-xs opacity-75 flex items-center gap-1';
                providerBadge.innerHTML = `
                    <span>${style.icon}</span>
                    <span>Answered by ${this.getProviderDisplayName(provider)}</span>
                `;
                bottomRow.appendChild(providerBadge);
            } else {
                // If no provider, add an empty spacer to push icons to the right
                const spacer = document.createElement('div');
                bottomRow.appendChild(spacer);
            }

            // Light slate-blue panel: dark enough for the white-tinted cloud
            // emoji (☁️) to be visible, light enough for colored emoji (❌, 📋…)
            // to keep their pop against the dark blue user bubble.
            // gap-2 + px-2 gives the icons room to breathe.
            const iconContainer = document.createElement('div');
            iconContainer.className = 'flex gap-2 px-2 py-1 bg-slate-200 rounded';

            // Create Google Drive save button (on top).
            // The ☁️ emoji is nearly pure white on macOS — invisible against the
            // light icon-container background. Drop-shadow gives it a dark
            // outline so it reads on any surface.
            const saveBtn = document.createElement('button');
            saveBtn.className = 'save-to-drive-btn flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity';
            saveBtn.style.filter = 'drop-shadow(0 0 1px rgba(0,0,0,0.8))';
            saveBtn.innerHTML = '☁️';
            saveBtn.title = 'Save to Google Drive';
            saveBtn.setAttribute('aria-label', 'Save this conversation to Google Drive');
            saveBtn.setAttribute('data-message-id', id);
            saveBtn.onclick = (e) => {
                e.stopPropagation();
                this.saveToGoogleDrive(id);
            };

            // Create print button (below)
            const printBtn = document.createElement('button');
            printBtn.className = 'print-response-btn flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity';
            printBtn.innerHTML = '🖨️';
            printBtn.title = 'Print response';
            printBtn.setAttribute('aria-label', 'Print this response');
            printBtn.onclick = (e) => {
                e.stopPropagation();
                this.printResponse(id);
            };

            // Save prompt to Prompt Library
            const savePromptBtn = document.createElement('button');
            savePromptBtn.className = 'save-to-prompt-library-btn flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity';
            savePromptBtn.innerHTML = '💾';
            savePromptBtn.title = 'Save prompt to Prompt Library';
            savePromptBtn.setAttribute('aria-label', 'Save this prompt to the Prompt Library');
            savePromptBtn.onclick = (e) => {
                e.stopPropagation();
                this.saveToPromptLibrary(content);
            };

            // Copy the response associated with this prompt
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-response-btn flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity';
            copyBtn.innerHTML = '📋';
            copyBtn.title = 'Copy response to clipboard';
            copyBtn.setAttribute('aria-label', 'Copy the response for this prompt');
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                this.copyResponseFor(id, copyBtn);
            };

            // Delete this prompt + its response from the conversation history.
            // The trash glyph renders dark on dark blue and disappears — use ❌
            // (red, naturally high-contrast) and skip the opacity dimming so the
            // destructive action stays prominent.
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-qa-pair-btn flex-shrink-0 hover:scale-110 transition-transform';
            deleteBtn.innerHTML = '❌';
            deleteBtn.title = 'Delete this prompt and its response';
            deleteBtn.setAttribute('aria-label', 'Delete this prompt and its response from the conversation');
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                this.deleteQAPair(id);
            };

            iconContainer.appendChild(saveBtn);
            iconContainer.appendChild(printBtn);
            iconContainer.appendChild(savePromptBtn);
            iconContainer.appendChild(copyBtn);
            iconContainer.appendChild(deleteBtn);

            bottomRow.appendChild(iconContainer);
            messageContainer.appendChild(bottomRow);
            bubble.appendChild(messageContainer);
        } else {
            bubble.innerHTML = `<div class="markdown-content">${this.renderMarkdown(content)}</div>`;
            // Stash raw markdown so the per-prompt Copy button can return
            // source instead of innerText (which strips markdown formatting).
            bubble.dataset.rawContent = content;
        }

        wrapper.appendChild(bubble);
        this.messagesContainer.appendChild(wrapper);
        this.scrollToBottom();

        return id;
    }

    showUsageWarning(messageId, info) {
        const wrapper = document.getElementById(messageId);
        if (!wrapper) return;
        const bubble = wrapper.querySelector('div');
        if (!bubble) return;

        // Dedupe by reason — only one banner per kind per message
        const dedupeKey = `usage-warning-${info.reason}`;
        if (bubble.querySelector(`[data-warning="${dedupeKey}"]`)) return;

        const model = info.model ? ` (${info.model})` : '';
        let text;
        if (info.reason === 'output_truncated') {
            text = `⚠️ Response was cut off because it reached max_tokens (${info.output_tokens} / ${info.max_tokens})${model}. Raise max_tokens in admin settings, or ask the model to continue.`;
        } else if (info.reason === 'context_high') {
            text = `⚠️ Conversation is using ${info.percent}% of the context window (${info.input_tokens.toLocaleString()} / ${info.context_window.toLocaleString()} tokens)${model}. Consider starting a new chat soon.`;
        } else {
            text = `⚠️ ${info.reason || 'Usage warning'}`;
        }

        const banner = document.createElement('div');
        banner.className = 'usage-warning-banner';
        banner.setAttribute('data-warning', dedupeKey);
        banner.innerHTML = `<span class="usage-warning-text"></span><button class="usage-warning-dismiss" aria-label="Dismiss">×</button>`;
        banner.querySelector('.usage-warning-text').textContent = text;
        banner.querySelector('.usage-warning-dismiss').addEventListener('click', () => banner.remove());

        bubble.insertBefore(banner, bubble.firstChild);
    }

    repairTruncatedSVG(content) {
        if (typeof content !== 'string' || !content) return content;

        const notice = '\n\n<div class="svg-repaired-notice">⚠️ The diagram was cut off by the model and auto-repaired. Some elements may be missing — ask to regenerate for a complete version.</div>';

        const closeSvg = (body) => {
            const lastGt = body.lastIndexOf('>');
            if (lastGt !== -1) body = body.substring(0, lastGt + 1);
            if (!/<\/svg>/i.test(body)) body += '\n</svg>';
            return body;
        };

        const lastFence = content.lastIndexOf('```svg');
        if (lastFence !== -1) {
            const afterFence = lastFence + 6;
            if (content.indexOf('```', afterFence) === -1) {
                const body = closeSvg(content.substring(afterFence).replace(/^\s*\n/, ''));
                return content.substring(0, lastFence) + '```svg\n' + body + '\n```' + notice;
            }
        }

        const rawOpen = content.search(/<svg\b[^>]*>/i);
        if (rawOpen !== -1 && !/<\/svg>/i.test(content.substring(rawOpen))) {
            const body = closeSvg(content.substring(rawOpen));
            return content.substring(0, rawOpen) + body + notice;
        }

        return content;
    }

    updateMessage(id, parts, hasCodeBlock = false) {
        const wrapper = document.getElementById(id);
        if (!wrapper) return;

        const bubble = wrapper.querySelector('div');

        // Check if this is streaming (array) or final render (string)
        const isStreaming = Array.isArray(parts);

        if (isStreaming) {
            // During streaming, use a lighter rendering approach
            let streamContainer = bubble.querySelector('.streaming-content');
            if (!streamContainer) {
                streamContainer = document.createElement('div');
                streamContainer.className = 'streaming-content markdown-content';
                bubble.innerHTML = '';
                bubble.appendChild(streamContainer);
            }

            // Clear the container
            streamContainer.innerHTML = '';

            // Render each part separated by code blocks
            parts.forEach((part, index) => {
                if (part) {
                    const partDiv = document.createElement('div');
                    partDiv.innerHTML = this.renderSimpleMarkdown(part);
                    streamContainer.appendChild(partDiv);
                }

                // Add placeholder after each part except the last
                if (index < parts.length - 1) {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'svg-placeholder';
                    placeholder.innerHTML = '<div class="svg-placeholder-spinner"></div><div><span class="svg-placeholder-label">Generating graph</span></div>';
                    streamContainer.appendChild(placeholder);
                }
            });

            streamContainer.style.whiteSpace = 'pre-wrap';
        } else {
            // Final render with full markdown support
            const content = this.repairTruncatedSVG(parts);
            const renderedHtml = this.renderMarkdown(content);
            bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div>`;

            // Store raw content for raw/rendered toggle
            bubble.dataset.rawContent = content;

            wrapper.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });

            // Fix SVG viewBoxes after rendering
            this.fixAllSVGsInContainer(wrapper);

            // Render mermaid code blocks into SVG diagrams. Final pass only —
            // mid-stream blocks are incomplete and would throw.
            if (typeof window.renderMermaidIn === 'function') {
                window.renderMermaidIn(wrapper);
            }
        }
    }

    renderSimpleMarkdown(text) {
        // Simple text rendering for streaming - preserve all spaces and formatting
        // Just escape HTML and add line breaks after sentences

        // First escape HTML to prevent XSS
        let escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Add line breaks after sentences (but keep the space!)
        let formatted = escaped
            .replace(/\n\n+/g, '<br><br>')                     // Double+ newlines = paragraph breaks
            .replace(/\n/g, '<br>')                            // Single newlines = line breaks
            .replace(/\.\s/g, '. <br><br>')                    // Period + space, keep space
            .replace(/\!\s/g, '! <br><br>')                    // Exclamation + space, keep space
            .replace(/\?\s/g, '? <br><br>');                   // Question + space, keep space

        return formatted;
    }

    escapeHtml(text) {
        if (text === undefined || text === null) {
            return '';
        }
        // First convert newlines to a placeholder before escaping
        const textWithPlaceholder = text.replace(/\n/g, '__NEWLINE__');

        const div = document.createElement('div');
        div.textContent = textWithPlaceholder;

        // Now replace the placeholder with <br> tags
        return div.innerHTML.replace(/__NEWLINE__/g, '<br>');
    }

    renderMarkdown(text) {
        return window.renderMarkdown(text);
    }

    sanitizeSVG(svgString) {
        return window.sanitizeSVG(svgString);
    }

    /**
     * Fix SVG viewBox after rendering by measuring actual content bounds
     * This ensures all SVG content is visible without truncation
     */
    fixSVGViewBox(svgElement) {
        if (!svgElement || svgElement.tagName.toLowerCase() !== 'svg') return;

        try {
            // Get the actual bounding box of all SVG content
            const bbox = svgElement.getBBox();

            if (bbox.width > 0 && bbox.height > 0) {
                // Add padding around content (5% on each side)
                const padding = Math.max(bbox.width, bbox.height) * 0.05;
                const newViewBox = `${Math.floor(bbox.x - padding)} ${Math.floor(bbox.y - padding)} ${Math.ceil(bbox.width + padding * 2)} ${Math.ceil(bbox.height + padding * 2)}`;

                svgElement.setAttribute('viewBox', newViewBox);
                svgElement.classList.remove('needs-viewbox-fix'); // Remove marker class
                svgElement.style.visibility = 'visible'; // Make visible after fix
                svgElement.style.height = 'auto';
            } else {
                // If bbox is empty, still show the SVG
                svgElement.classList.remove('needs-viewbox-fix');
                svgElement.style.visibility = 'visible';
            }
        } catch (e) {
            console.warn('Could not fix SVG viewBox:', e);
            // Still show the SVG even if fix fails
            svgElement.classList.remove('needs-viewbox-fix');
            svgElement.style.visibility = 'visible';
        }
    }

    /**
     * Fix all SVGs in a container that need viewBox correction
     */
    fixAllSVGsInContainer(container) {
        if (!container) return;

        const svgs = container.querySelectorAll('svg.needs-viewbox-fix');
        svgs.forEach(svg => {
            // Use double requestAnimationFrame to ensure SVG is fully rendered and layout is computed
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.fixSVGViewBox(svg);
                });
            });
        });
    }

    /**
     * Copy the assistant response that follows the given user-prompt bubble.
     * Mirrors printSingleResponse's lookup (next sibling with .markdown-content)
     * so a click on the copy icon next to a prompt grabs that prompt's answer.
     * Copies clean text (textContent) — strips HTML formatting but preserves
     * the visible content order.
     */
    copyResponseFor(userMessageId, btn) {
        const userWrapper = document.getElementById(userMessageId);
        if (!userWrapper) return;

        let assistantWrapper = userWrapper.nextElementSibling;
        while (assistantWrapper && !assistantWrapper.querySelector('.markdown-content')) {
            assistantWrapper = assistantWrapper.nextElementSibling;
        }
        const mdEl = assistantWrapper?.querySelector('.markdown-content');
        // Prefer the raw markdown source we stashed at render time — it
        // round-trips into other markdown-aware tools cleanly. Fall back
        // to innerText for older bubbles that pre-date the data attribute.
        const text = mdEl?.parentElement?.dataset?.rawContent
            || mdEl?.innerText?.trim()
            || '';
        if (!text) {
            this.flashIconLabel(btn, '⚠️');
            return;
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text)
                .then(() => this.flashIconLabel(btn, '✓'))
                .catch(() => this.flashIconLabel(btn, '✗'));
        } else {
            this.flashIconLabel(btn, '✗');
        }
    }

    /**
     * Delete a user prompt and its assistant response from both the DOM and
     * conversationHistory. Pairs map by position: the Nth user wrapper in DOM
     * order corresponds to conversationHistory[2N] (user) + [2N+1] (assistant),
     * because pushes are strict pairs (chat.js:1842-1843).
     *
     * If a user wrapper has no following assistant wrapper yet (mid-stream or
     * a failed response that was never pushed), only the DOM is touched.
     */
    deleteQAPair(userMessageId) {
        const userWrapper = document.getElementById(userMessageId);
        if (!userWrapper) return;

        if (!confirm('Delete this prompt and its response from the conversation? Saved contexts are not updated.')) {
            return;
        }

        let assistantWrapper = userWrapper.nextElementSibling;
        while (assistantWrapper && !assistantWrapper.querySelector('.markdown-content')) {
            assistantWrapper = assistantWrapper.nextElementSibling;
        }

        const userWrappers = Array.from(this.messagesContainer.children)
            .filter(w => w.querySelector('[data-message-content]'));
        const idx = userWrappers.indexOf(userWrapper);

        if (idx >= 0) {
            const histUserIdx = idx * 2;
            const userEntry = this.conversationHistory[histUserIdx];
            const expectedContent = userWrapper.querySelector('[data-message-content]')?.getAttribute('data-message-content');
            if (userEntry && userEntry.role === 'user' && (!expectedContent || userEntry.content === expectedContent)) {
                const removeCount = (this.conversationHistory[histUserIdx + 1]?.role === 'assistant') ? 2 : 1;
                this.conversationHistory.splice(histUserIdx, removeCount);
            } else {
                console.warn('[deleteQAPair] history index mismatch — DOM removed but history left intact', { idx, userEntry });
            }
        }

        assistantWrapper?.remove();
        userWrapper.remove();
    }

    flashIconLabel(btn, glyph) {
        if (!btn) return;
        const original = btn.innerHTML;
        btn.innerHTML = glyph;
        btn.disabled = true;
        setTimeout(() => {
            btn.innerHTML = original;
            btn.disabled = false;
        }, 1200);
    }

    printResponse(userMessageId) {
        // Check if we should print full conversation or single Q&A
        const mergeCheckbox = document.getElementById('merge-conversations');
        const printFullConversation = mergeCheckbox && mergeCheckbox.checked;

        if (printFullConversation) {
            // Print all Q&A pairs in the conversation
            this.printFullConversation();
        } else {
            // Print only the single Q&A pair
            this.printSingleResponse(userMessageId);
        }
    }

    printSingleResponse(userMessageId) {
        const userWrapper = document.getElementById(userMessageId);
        if (!userWrapper) {
            console.error('User message not found');
            return;
        }

        // Find the next sibling (assistant response)
        let assistantWrapper = userWrapper.nextElementSibling;

        // Skip system messages if any
        while (assistantWrapper && !assistantWrapper.querySelector('.markdown-content')) {
            assistantWrapper = assistantWrapper.nextElementSibling;
        }

        if (!assistantWrapper) {
            alert('No response found to print');
            return;
        }

        const userBubble = userWrapper.querySelector('div');
        const userPrompt = userBubble.querySelector('span')?.textContent || '';

        const assistantBubble = assistantWrapper.querySelector('.markdown-content');
        const responseContent = assistantBubble ? assistantBubble.innerHTML : '';

        if (!responseContent) {
            alert('Response is empty');
            return;
        }

        // Get provider information from user message
        const providerName = userWrapper.getAttribute('data-provider') || this.currentProvider;
        const provider = this.providers.find(p => p.name === providerName);
        const modelInfo = provider ? `${provider.display_name} (${provider.model})` : providerName;

        // Create print window
        const printWindow = window.open('', '_blank');
        const timestamp = new Date().toLocaleString();

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>AI Response from ${modelInfo} - ${timestamp}</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        max-width: 800px;
                        margin: 40px auto;
                        padding: 20px;
                        line-height: 1.6;
                        color: #333;
                    }
                    .header {
                        border-bottom: 2px solid #3b82f6;
                        padding-bottom: 20px;
                        margin-bottom: 30px;
                    }
                    .header h1 {
                        margin: 0 0 10px 0;
                        color: #1f2937;
                        font-size: 24px;
                    }
                    .timestamp {
                        color: #6b7280;
                        font-size: 14px;
                    }
                    .prompt {
                        background: #eff6ff;
                        border-left: 4px solid #3b82f6;
                        padding: 15px;
                        margin-bottom: 30px;
                        border-radius: 4px;
                    }
                    .prompt-label {
                        font-weight: 600;
                        color: #1e40af;
                        margin-bottom: 8px;
                        font-size: 14px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .prompt-text {
                        color: #1f2937;
                        font-size: 16px;
                    }
                    .response {
                        background: white;
                    }
                    .response-label {
                        font-weight: 600;
                        color: #059669;
                        margin-bottom: 15px;
                        font-size: 14px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .response-content {
                        color: #1f2937;
                    }
                    pre {
                        background: #f3f4f6;
                        border: 1px solid #d1d5db;
                        border-radius: 6px;
                        padding: 16px;
                        overflow-x: auto;
                        margin: 16px 0;
                    }
                    code {
                        background: #f3f4f6;
                        padding: 2px 6px;
                        border-radius: 3px;
                        font-family: 'Monaco', 'Courier New', monospace;
                        font-size: 14px;
                    }
                    pre code {
                        background: none;
                        padding: 0;
                    }
                    table {
                        border-collapse: collapse;
                        width: 100%;
                        margin: 16px 0;
                    }
                    th, td {
                        border: 1px solid #d1d5db;
                        padding: 8px 12px;
                        text-align: left;
                    }
                    th {
                        background: #f3f4f6;
                        font-weight: 600;
                    }
                    blockquote {
                        border-left: 4px solid #d1d5db;
                        margin: 16px 0;
                        padding-left: 16px;
                        color: #6b7280;
                    }
                    a {
                        color: #3b82f6;
                        text-decoration: none;
                    }
                    a:hover {
                        text-decoration: underline;
                    }
                    @media print {
                        body {
                            margin: 0;
                            padding: 20px;
                        }
                        .no-print {
                            display: none;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>AI Assistant Response</h1>
                    <div class="timestamp">${timestamp}</div>
                </div>

                <div class="prompt">
                    <div class="prompt-label">Your Question</div>
                    <div class="prompt-text">${userPrompt}</div>
                </div>

                <div class="response">
                    <div class="response-label">AI Response from ${modelInfo}</div>
                    <div class="response-content">${responseContent}</div>
                </div>
            </body>
            </html>
        `);

        printWindow.document.close();

        // Make all links in the print window open in new tabs
        setTimeout(() => {
            printWindow.document.querySelectorAll('a').forEach(link => {
                link.setAttribute('target', '_blank');
                link.setAttribute('rel', 'noopener noreferrer');
            });

            printWindow.focus();
            // Auto-print after a short delay
            printWindow.print();
        }, 250);
    }

    printFullConversation() {
        // Collect all Q&A pairs from the conversation
        const allMessages = this.messagesContainer.children;
        const qaPairs = [];

        for (let i = 0; i < allMessages.length; i++) {
            const wrapper = allMessages[i];

            // Check if this is a user message (has justify-end class)
            if (wrapper.className.includes('justify-end')) {
                const userBubble = wrapper.querySelector('div');
                const userPrompt = userBubble.querySelector('span')?.textContent || '';

                // Get provider information
                const providerName = wrapper.getAttribute('data-provider') || this.currentProvider;
                const provider = this.providers.find(p => p.name === providerName);
                const modelInfo = provider ? `${provider.display_name} (${provider.model})` : providerName;

                // Find the next sibling (assistant response)
                let assistantWrapper = wrapper.nextElementSibling;

                // Skip system messages if any
                while (assistantWrapper && !assistantWrapper.querySelector('.markdown-content')) {
                    assistantWrapper = assistantWrapper.nextElementSibling;
                }

                if (assistantWrapper) {
                    const assistantBubble = assistantWrapper.querySelector('.markdown-content');
                    const responseContent = assistantBubble ? assistantBubble.innerHTML : '';

                    if (userPrompt && responseContent) {
                        qaPairs.push({
                            prompt: userPrompt,
                            response: responseContent,
                            model: modelInfo
                        });
                    }
                }
            }
        }

        if (qaPairs.length === 0) {
            alert('No conversation found to print');
            return;
        }

        // Create print window
        const printWindow = window.open('', '_blank');
        const timestamp = new Date().toLocaleString();

        // Build the Q&A pairs HTML
        let qaPairsHtml = '';
        qaPairs.forEach((pair, index) => {
            qaPairsHtml += `
                <div class="qa-pair">
                    <div class="prompt">
                        <div class="prompt-label">Question ${index + 1}</div>
                        <div class="prompt-text">${pair.prompt}</div>
                    </div>
                    <div class="response">
                        <div class="response-label">Response from ${pair.model}</div>
                        <div class="response-content">${pair.response}</div>
                    </div>
                </div>
            `;
        });

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Full Conversation - ${timestamp}</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                        max-width: 800px;
                        margin: 40px auto;
                        padding: 20px;
                        line-height: 1.6;
                        color: #333;
                    }
                    .qa-pair {
                        margin-bottom: 40px;
                        page-break-inside: avoid;
                    }
                    .prompt {
                        background: #eff6ff;
                        border-left: 4px solid #3b82f6;
                        padding: 15px;
                        margin-bottom: 20px;
                        border-radius: 4px;
                    }
                    .prompt-label {
                        font-weight: 600;
                        color: #1e40af;
                        margin-bottom: 8px;
                        font-size: 14px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .prompt-text {
                        color: #1f2937;
                        font-size: 16px;
                    }
                    .response {
                        background: white;
                    }
                    .response-label {
                        font-weight: 600;
                        color: #059669;
                        margin-bottom: 15px;
                        font-size: 14px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .response-content {
                        color: #1f2937;
                    }
                    pre {
                        background: #f3f4f6;
                        border: 1px solid #d1d5db;
                        border-radius: 6px;
                        padding: 16px;
                        overflow-x: auto;
                        margin: 16px 0;
                    }
                    code {
                        background: #f3f4f6;
                        padding: 2px 6px;
                        border-radius: 3px;
                        font-family: 'Monaco', 'Courier New', monospace;
                        font-size: 14px;
                    }
                    pre code {
                        background: none;
                        padding: 0;
                    }
                    table {
                        border-collapse: collapse;
                        width: 100%;
                        margin: 16px 0;
                    }
                    th, td {
                        border: 1px solid #d1d5db;
                        padding: 8px 12px;
                        text-align: left;
                    }
                    th {
                        background: #f3f4f6;
                        font-weight: 600;
                    }
                    blockquote {
                        border-left: 4px solid #d1d5db;
                        margin: 16px 0;
                        padding-left: 16px;
                        color: #6b7280;
                    }
                    a {
                        color: #3b82f6;
                        text-decoration: none;
                    }
                    a:hover {
                        text-decoration: underline;
                    }
                    @media print {
                        body {
                            margin: 0;
                            padding: 20px;
                        }
                        .no-print {
                            display: none;
                        }
                    }
                </style>
            </head>
            <body>
                ${qaPairsHtml}
            </body>
            </html>
        `);

        printWindow.document.close();

        // Make all links in the print window open in new tabs
        setTimeout(() => {
            printWindow.document.querySelectorAll('a').forEach(link => {
                link.setAttribute('target', '_blank');
                link.setAttribute('rel', 'noopener noreferrer');
            });

            printWindow.focus();
            // Auto-print after a short delay
            printWindow.print();
        }, 250);
    }

    async saveToGoogleDrive(userMessageId) {
        // TEMPORARY: Show information dialog until Google Drive integration is complete
        alert(
            '📋 Google Drive Integration - In Progress\n\n' +
            '⚠️ This feature is not yet fully implemented.\n\n' +
            'What needs to be done:\n' +
            '✓ User authentication system\n' +
            '✓ Google OAuth authorization\n' +
            '✓ Database setup for storing tokens\n' +
            '✓ Backend integration with Google Drive API\n\n' +
            'For details, see: GOOGLE_DRIVE_INTEGRATION.md\n\n' +
            'Current functionality: UI is ready, backend integration pending.'
        );

        // Keep for reference when implementing:
        /*
        const userWrapper = document.getElementById(userMessageId);
        if (!userWrapper) {
            console.error('User message not found');
            alert('Error: Could not find the message to save');
            return;
        }

        // Find the next sibling (assistant response)
        let assistantWrapper = userWrapper.nextElementSibling;
        while (assistantWrapper && !assistantWrapper.querySelector('.markdown-content')) {
            assistantWrapper = assistantWrapper.nextElementSibling;
        }

        if (!assistantWrapper) {
            alert('No response found to save. Please wait for the AI to respond first.');
            return;
        }

        const userBubble = userWrapper.querySelector('div');
        const userPrompt = userBubble.querySelector('span[data-message-content]')?.getAttribute('data-message-content') ||
                           userBubble.querySelector('span')?.textContent || '';

        const assistantBubble = assistantWrapper.querySelector('.markdown-content');
        const responseContent = assistantBubble ? assistantBubble.textContent : '';

        if (!responseContent) {
            alert('Response is empty. Cannot save to Google Drive.');
            return;
        }

        // Show loading state
        const saveBtn = userWrapper.querySelector('.save-to-drive-btn');
        const originalContent = saveBtn.innerHTML;
        saveBtn.innerHTML = '⏳';
        saveBtn.disabled = true;

        try {
            // TODO: Implement actual Google Drive save
            // Call backend API: /gpt/app/api/save-to-drive.php
            // Backend should use GoogleDriveService (see GOOGLE_DRIVE_INTEGRATION.md)

            // Placeholder success
            saveBtn.innerHTML = '✅';
            setTimeout(() => {
                saveBtn.innerHTML = originalContent;
                saveBtn.disabled = false;
            }, 2000);

        } catch (error) {
            console.error('Error saving to Google Drive:', error);
            saveBtn.innerHTML = '❌';
            setTimeout(() => {
                saveBtn.innerHTML = originalContent;
                saveBtn.disabled = false;
            }, 2000);
            alert(`Failed to save to Google Drive: ${error.message}`);
        }
        */
    }

    /**
     * Wire the paperclip button + hidden file input.
     * Selecting files routes them through addAttachments(), which is also
     * the entry point for the OS drag-drop handler (Phase 1.2).
     */
    initAttachmentPicker() {
        if (!this.attachFileBtn || !this.attachFileInput) return;

        this.attachFileBtn.addEventListener('click', () => {
            // Reset value so re-picking the same file still fires onChange.
            this.attachFileInput.value = '';
            this.attachFileInput.click();
        });

        this.attachFileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) this.addAttachments(files);
        });

        // Event-delegated chip actions: remove (×) and retry (after failure).
        if (this.attachmentsStrip) {
            this.attachmentsStrip.addEventListener('click', (e) => {
                const removeBtn = e.target.closest('[data-attach-remove]');
                if (removeBtn) {
                    const idx = parseInt(removeBtn.getAttribute('data-attach-remove'), 10);
                    if (!Number.isNaN(idx)) this.removeAttachment(idx);
                    return;
                }
                const retryBtn = e.target.closest('[data-attach-retry]');
                if (retryBtn) {
                    const idx = parseInt(retryBtn.getAttribute('data-attach-retry'), 10);
                    if (!Number.isNaN(idx)) this.retryAttachment(idx);
                }
            });
        }
    }

    /**
     * Queue File objects, kick off an upload for each, and re-render the
     * chip strip. Each entry in pendingAttachments has shape:
     *   { file, name, size, mime,
     *     status: 'uploading' | 'done' | 'active' | 'error',
     *     id: number|null, error: string|null, retryable: bool }
     *
     * Pre-flight size check: anything past MAX_UPLOAD_BYTES is rejected here
     * so the user sees a clear "too big" message instead of a vague server
     * 400 + "retry" loop after a slow upload.
     */
    addAttachments(files) {
        const limit = ChatApp.MAX_UPLOAD_BYTES;
        for (const f of files) {
            const entry = {
                file: f,
                name: f.name,
                size: f.size,
                mime: f.type || '',
                status: 'uploading',
                id: null,
                error: null,
                retryable: true,
                // Frontend-side markdown conversion (attachment-converter.js).
                // Runs in parallel with the backend upload so the LLM gets
                // the document's text content directly in the message
                // prefix, not via per-format skill scripts. See Phase 3 of
                // the attachment-converter plan.
                conversionStatus: 'pending',  // 'pending' | 'done' | 'skip' | 'error'
                markdown: null,
                conversionError: null,
            };
            if (f.size > limit) {
                entry.status = 'error';
                entry.error = `Too big (${this.formatFileSize(f.size)}) — limit is ${this.formatFileSize(limit)}`;
                entry.retryable = false;
                entry.flashed = false; // first chip render will play the flash
                entry.conversionStatus = 'skip';
                this.pendingAttachments.push(entry);
                // Auto-remove after the flash + a beat to read.
                this.scheduleAutoDismiss(entry);
                continue;
            }
            this.pendingAttachments.push(entry);
            // Upload + convert run in parallel — neither blocks the other.
            this.uploadAttachment(entry);
            this.convertAttachment(entry);
        }
        this.renderAttachmentChips();
    }

    /**
     * Convert an attachment to Markdown via the platform-level converter,
     * so the LLM sees its content as text regardless of original format.
     * Images are skipped — they ride the existing native-dispatch path
     * via attachment_ids. Failures fail loudly: the entry is marked as
     * an error chip and the user must remove it (no silent fallback).
     */
    async convertAttachment(entry) {
        if (!window.attachmentConverter || typeof window.attachmentConverter.toMarkdown !== 'function') {
            // Converter not loaded — degrade gracefully and let the
            // backend handle the attachment via the legacy path.
            entry.conversionStatus = 'skip';
            this.renderAttachmentChips();
            return;
        }
        const mime = (entry.mime || entry.file?.type || '').toLowerCase();
        if (mime.startsWith('image/')) {
            // Images don't get converted — provider-native image dispatch
            // (Claude/Gemini) handles them server-side via attachment_ids.
            entry.conversionStatus = 'skip';
            this.renderAttachmentChips();
            return;
        }
        try {
            const result = await window.attachmentConverter.toMarkdown(entry.file);
            entry.markdown = result.markdown;
            entry.conversionStatus = 'done';
        } catch (e) {
            entry.conversionStatus = 'error';
            entry.conversionError = e?.message || String(e);
            // Surface as a chip error too — the user needs to see this and
            // can't send the turn until they remove the bad attachment.
            entry.status = 'error';
            entry.error = `Couldn't read ${entry.name}: ${entry.conversionError}`;
            entry.retryable = false;
            entry.flashed = false;
            this.scheduleAutoDismiss(entry, 8000);
        }
        this.renderAttachmentChips();
    }

    /**
     * POST one attachment to /chat/upload. On success replaces entry.id and
     * marks status 'done'. On failure marks 'error' with the server message;
     * the chip's retry button calls this method again.
     */
    async uploadAttachment(entry) {
        try {
            const form = new FormData();
            form.append('file', entry.file, entry.name);
            const headers = {};
            if (window.authManager && window.authManager.token) {
                headers['Authorization'] = `Bearer ${window.authManager.token}`;
            }
            const res = await fetch(window.apiUrl('/chat/upload'), {
                method: 'POST',
                headers,
                body: form,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) {
                entry.status = 'error';
                entry.error = body.error || body.message || `HTTP ${res.status}`;
                // 413 (too big), 415 (wrong type), and 400 with "No file
                // field" are permanent — retrying the same bytes won't help.
                // Other failures (5xx, network) get a retry button.
                entry.retryable = !(
                    res.status === 413 ||
                    res.status === 415 ||
                    (res.status === 400 && /No file field|too large|exceeds|Unsupported/i.test(entry.error))
                );
                entry.flashed = false; // next render plays the flash
                // Permanent failures auto-remove after the flash; transient
                // ones keep the chip + retry button for the user to act on.
                if (!entry.retryable) this.scheduleAutoDismiss(entry);
            } else {
                entry.status = 'done';
                entry.id = body.attachment.id;
                entry.mime = body.attachment.mime_type || entry.mime;
                // Keep the raw File around even after upload completes.
                // B3 skill turns need to pre-write the attachment to
                // /scratch/<name> in Pyodide directly from the in-memory
                // File (avoids a backend round-trip and the LLM having
                // to re-emit the document inline). Memory cost is the
                // file's size; cleared on attachment removal / new chat.
            }
        } catch (err) {
            // Network / fetch-level failure — these are usually transient.
            entry.status = 'error';
            entry.error = err?.message || String(err);
            entry.retryable = true;
            entry.flashed = false;
        }
        this.renderAttachmentChips();
    }

    /**
     * Schedule a non-retryable error chip to auto-remove after a short delay.
     * Lets the user see the flash + read the inline error, then the chip
     * disappears so the strip doesn't accumulate dead entries. The user is
     * left with a clean state — reinforces "this file was rejected, pick
     * another one." Retryable error chips are NOT auto-removed; the user
     * needs them around to click retry.
     *
     * Removal is by entry identity (not index) so it stays correct even if
     * the user added/removed other chips during the delay window.
     */
    scheduleAutoDismiss(entry, delayMs = 4200) {
        setTimeout(() => {
            const idx = this.pendingAttachments.indexOf(entry);
            if (idx !== -1) {
                this.pendingAttachments.splice(idx, 1);
                this.renderAttachmentChips();
            }
        }, delayMs);
    }

    /**
     * Retry a failed upload for the given index. Only valid for transient
     * failures — permanent ones (too-big, wrong-type) skip the retry path.
     */
    retryAttachment(index) {
        const entry = this.pendingAttachments[index];
        if (!entry || entry.status !== 'error' || !entry.file) return;
        if (entry.retryable === false) return;
        entry.status = 'uploading';
        entry.error = null;
        this.renderAttachmentChips();
        this.uploadAttachment(entry);
    }

    /**
     * Remove a queued attachment by index and re-render.
     */
    removeAttachment(index) {
        if (index < 0 || index >= this.pendingAttachments.length) return;
        this.pendingAttachments.splice(index, 1);
        this.renderAttachmentChips();
    }

    /**
     * Render the chip strip below the prompt input. Each chip has a type icon,
     * truncated filename, size, and a remove (×) button. Click is handled by
     * delegation — see initAttachmentPicker for the listener.
     */
    renderAttachmentChips() {
        if (!this.attachmentsStrip) return;
        if (this.pendingAttachments.length === 0) {
            this.attachmentsStrip.classList.add('hidden');
            this.attachmentsStrip.innerHTML = '';
            return;
        }
        this.attachmentsStrip.classList.remove('hidden');
        this.attachmentsStrip.innerHTML = this.pendingAttachments
            .map((f, i) => this.renderAttachmentChip(f, i))
            .join('');
    }

    /**
     * Build the HTML for a single attachment chip.
     * Accepts either a raw File (Phase 1) or a {name,size,mime,status,...}
     * entry (Phase 2). The two shapes share the fields we read here.
     */
    renderAttachmentChip(entry, index) {
        const name = entry.name || (entry.file && entry.file.name) || 'file';
        const safeName = this.escapeHtml(name);
        const size = this.formatFileSize(entry.size ?? (entry.file ? entry.file.size : 0));
        const mime = ((entry.mime ?? entry.type) || '').toLowerCase();
        const ext = (name.split('.').pop() || '').toLowerCase();
        const status = entry.status || 'done';

        // Uniform chip tone — every attachment looks the same so the user
        // reads "attachment" at a glance, regardless of file type. Icon is
        // still differentiated to identify the format. Darker than the old
        // per-format tones for visibility against the chat background.
        let tone = 'bg-gray-200 border-gray-400 text-gray-900';
        let iconSvg;
        if (mime.startsWith('image/') || ['png','jpg','jpeg','webp','gif'].includes(ext)) {
            iconSvg = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>';
        } else if (mime === 'application/pdf' || ext === 'pdf') {
            iconSvg = '<span class="font-bold text-[10px] tracking-tight">PDF</span>';
        } else if (mime.startsWith('text/') || ['txt','md','csv','json','html'].includes(ext)) {
            iconSvg = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>';
        } else {
            iconSvg = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>';
        }

        // Status-specific overlay: spinner while uploading OR converting,
        // error glyph + retry on fail. We treat "still converting" the
        // same as "still uploading" visually — both are pre-send work the
        // user is waiting on.
        const isConverting = entry.conversionStatus === 'pending';
        let statusBlock = '';
        let chipExtraClass = '';
        if (status === 'uploading' || isConverting) {
            chipExtraClass = ' opacity-70';
            statusBlock = `
                <svg class="w-3 h-3 animate-spin text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                </svg>
            `;
        } else if (status === 'error') {
            tone = 'bg-red-50 border-red-300 text-red-700';
            const safeErr = this.escapeHtml(entry.error || 'upload failed');
            // Inline the error text so the user sees WHY without hovering.
            // Retry is only offered for transient failures; for permanent
            // ones (file too big, wrong type) the user has to ✕ and try a
            // different file instead.
            const retryBtn = entry.retryable === false ? '' : `
                <button type="button" data-attach-retry="${index}" aria-label="Retry upload"
                        class="ml-0.5 text-blue-600 hover:underline leading-none text-[10px]">retry</button>
            `;
            statusBlock = `
                <span class="text-red-700 text-[10px] truncate max-w-[240px]" title="${safeErr}">${safeErr}</span>
                ${retryBtn}
            `;
            // Flash 3× the first time this error chip renders so the user
            // notices it. We mark `flashed` synchronously so subsequent
            // re-renders (from adding more files, removing chips, etc.)
            // don't replay the animation.
            if (!entry.flashed) {
                chipExtraClass += ' attach-error-flash';
                entry.flashed = true;
            }
        }

        return `
            <span class="inline-flex items-center gap-1.5 px-2 py-1 border rounded text-xs ${tone}${chipExtraClass}" title="${safeName}">
                ${iconSvg}
                <span class="truncate max-w-[180px]">${safeName}</span>
                <span class="text-gray-600">${size}</span>
                ${statusBlock}
                <button type="button" data-attach-remove="${index}" aria-label="Remove ${safeName}"
                        class="ml-0.5 text-gray-500 hover:text-red-500 leading-none">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
            </span>
        `;
    }

    /**
     * Format a byte count as KB/MB for display.
     */
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * OS-file drag-drop. Anything dropped anywhere on the page is captured
     * (page-level handler) and routed into addAttachments(). The visual
     * overlay sits inside the messages area while a file is hovering.
     *
     * Page-level capture matters because: (a) dropping onto the prompt input
     * or the empty white space around it is intuitive but those aren't
     * children of the messages container, and (b) without preventDefault on
     * window-level dragover/drop, the browser navigates to the file when
     * dropped outside any registered zone, which silently destroys the user's
     * conversation state.
     *
     * Distinct from the skill drop zone (which filters on application/x-skill
     * and stays narrow). This one filters on `Files` in dataTransfer.types.
     */
    initFileDropZone() {
        const overlayHost = this.messagesContainer;
        if (!overlayHost) return;

        // Build the overlay lazily on first hover; sits inside the messages
        // area and absolutely covers it. The overlay is sometimes wiped from
        // the DOM by code that resets messagesContainer.innerHTML (clearChat,
        // loading a saved context) — when that happens we just re-append the
        // same node next time. The closure ref survives detachment.
        let overlay = null;
        const ensureOverlay = () => {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'file-drop-overlay';
                overlay.className = 'hidden absolute inset-0 z-30 pointer-events-none flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-400 rounded-md m-2';
                overlay.innerHTML = `
                    <div class="bg-white px-4 py-3 rounded-lg shadow-lg text-blue-700 font-medium text-sm flex items-center gap-2">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                        <span>Drop files anywhere to attach</span>
                    </div>
                `;
            }
            const cs = window.getComputedStyle(overlayHost);
            if (cs.position === 'static') overlayHost.style.position = 'relative';
            // If the overlay was detached (e.g. innerHTML reset), re-append it.
            if (!overlay.isConnected) overlayHost.appendChild(overlay);
            return overlay;
        };

        let depth = 0;

        const isFileDrag = (e) =>
            e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

        // Page-level capture: anything dragged anywhere on the window.
        window.addEventListener('dragenter', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth++;
            ensureOverlay().classList.remove('hidden');
        });
        window.addEventListener('dragover', (e) => {
            if (!isFileDrag(e)) return;
            // preventDefault is what stops the browser from opening the file
            // when the user releases. Must happen even when overlay isn't
            // visible (e.g. during the initial dragenter race).
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        window.addEventListener('dragleave', (e) => {
            if (!isFileDrag(e)) return;
            depth = Math.max(0, depth - 1);
            if (depth === 0 && overlay) overlay.classList.add('hidden');
        });
        window.addEventListener('drop', (e) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            depth = 0;
            if (overlay) overlay.classList.add('hidden');
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length > 0) this.addAttachments(files);
        });
    }

    initSkillDropZone() {
        const dropZone = document.getElementById('input-area');
        if (!dropZone) return;

        dropZone.addEventListener('dragover', (e) => {
            if (e.dataTransfer.types.includes('application/x-skill')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                dropZone.classList.add('ring-2', 'ring-blue-400');
            }
        });
        dropZone.addEventListener('dragleave', (e) => {
            if (e.target === dropZone) {
                dropZone.classList.remove('ring-2', 'ring-blue-400');
            }
        });
        dropZone.addEventListener('drop', (e) => {
            dropZone.classList.remove('ring-2', 'ring-blue-400');
            const raw = e.dataTransfer.getData('application/x-skill');
            if (!raw) return;
            e.preventDefault();
            try {
                const skill = JSON.parse(raw);
                if (skill && skill.id && skill.name) {
                    this.setActiveSkill(skill);
                }
            } catch (err) {
                console.error('Invalid skill drop payload:', err);
            }
        });
    }

    setActiveSkill(skill) {
        this.activeSkill = skill;
        this.renderActiveSkillChip();
        // Folder-backed skills require the LLM to call run_skill_script.
        // Verified empirically (2026-05-05) that DeepSeek V4 refuses to
        // call the tool even with the /scratch pre-write, MCP-tool
        // suppression, simplified payload, and forced tool_choice — its
        // tool_choice constraint handling is genuinely broken (Pydantic
        // AI issue #5193, NVIDIA NIM forum). Restoring the user-facing
        // warning so people don't waste time on it. Non-folder skills
        // (server-side / prompt-only) work fine on any provider.
        const isFolderBacked = skill?.source === 'local'
            && Array.isArray(skill?.scripts)
            && skill.scripts.length > 0;
        if (isFolderBacked && this.currentProvider === 'deepseek') {
            this.showNotification(
                '⚠️ DeepSeek doesn\'t reliably support folder-backed skills (it ignores forced tool calls). Switch to Claude, OpenAI, Grok, Kimi or Gemini for skill-driven workflows.',
                'error'
            );
        }
    }

    clearActiveSkill() {
        this.activeSkill = null;
        this.renderActiveSkillChip();
    }

    renderActiveSkillChip() {
        const chipEl = document.getElementById('active-skill-chip');
        if (!chipEl) return;
        if (!this.activeSkill) {
            chipEl.classList.add('hidden');
            chipEl.innerHTML = '';
            return;
        }
        const name = this.activeSkill.name || '';
        chipEl.classList.remove('hidden');
        chipEl.innerHTML = `
            <div class="inline-flex items-center gap-2 px-3 py-1 bg-blue-50 border border-blue-200 text-blue-700 rounded-full text-xs">
                <span>🎯</span>
                <span class="font-medium">${this.escapeHtmlLocal(name)}</span>
                <button type="button" id="active-skill-clear" class="ml-1 text-blue-400 hover:text-blue-700" aria-label="Remove active skill">&#10005;</button>
            </div>
        `;
        const clearBtn = chipEl.querySelector('#active-skill-clear');
        if (clearBtn) clearBtn.addEventListener('click', () => this.clearActiveSkill());
    }

    escapeHtmlLocal(s) {
        const div = document.createElement('div');
        div.textContent = s ?? '';
        return div.innerHTML;
    }

    async saveToPromptLibrary(content) {
        if (!content || !content.trim()) {
            alert('Nothing to save — the prompt is empty.');
            return;
        }

        const defaultName = content.trim().slice(0, 60);
        const name = prompt('Name for this prompt in the library:', defaultName);
        if (name === null) return; // user cancelled
        const trimmedName = name.trim();
        if (!trimmedName) {
            alert('A name is required.');
            return;
        }

        try {
            const res = await fetch(window.apiUrl('/prompts'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    type: 'prompt',
                    name: trimmedName,
                    content,
                    parent_id: null
                })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.success === false) {
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            this.showNotification(`Saved "${trimmedName}" to Prompt Library`, 'success');
            if (this.currentView === 'prompts') {
                await this.loadPromptLibrary();
            }
        } catch (err) {
            console.error('Save to Prompt Library failed:', err);
            this.showNotification(`Failed to save prompt: ${err.message}`, 'error');
        }
    }

    /**
     * Save the text currently in the prompt entry box (#user-input) into the
     * currently-selected Prompt Library folder. The folder is set by
     * clicking it in the Prompt Library tree (or implicitly when a prompt
     * is loaded — its parent becomes the selection). null = save at root.
     *
     * Wired to the "Save Prompt" button (#save-prompt-btn) immediately to
     * the left of the attach-file button. Reuses the same `/api/v1/prompts`
     * POST as saveToPromptLibrary, but with `parent_id` set from
     * `selectedPromptFolderId` instead of hard-coded null.
     */
    async savePromptToSelectedCollection() {
        const content = (this.userInput?.value || '').trim();
        if (!content) {
            this.showNotification('Prompt is empty — nothing to save.', 'info');
            return;
        }
        const defaultName = this.deriveDefaultPromptName(content);
        const name = prompt('Name for this prompt in the library:', defaultName);
        if (name === null) return;   // user cancelled
        const trimmedName = name.trim();
        if (!trimmedName) {
            alert('A name is required.');
            return;
        }
        try {
            const res = await fetch(window.apiUrl('/prompts'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    type: 'prompt',
                    name: trimmedName,
                    content,
                    parent_id: this.selectedPromptFolderId,
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.success === false) {
                throw new Error(body.error || `HTTP ${res.status}`);
            }
            const folderLabel = this.selectedPromptFolderId
                ? `"${this.findPromptFolderName(this.selectedPromptFolderId)}"`
                : 'the root';
            this.showNotification(`Saved "${trimmedName}" to ${folderLabel}`, 'success');
            if (this.currentView === 'prompts') {
                await this.loadPromptLibrary();
            }
        } catch (err) {
            console.error('Save Prompt failed:', err);
            this.showNotification(`Failed to save prompt: ${err.message}`, 'error');
        }
    }

    /**
     * Derive the default name for a prompt being saved to the library.
     *
     * Convention: the user can give the prompt a "title" by writing one line
     * at the top, separated from the body by a blank line (or as the only
     * line of content). When that pattern matches, the title becomes the
     * name; otherwise the first 30 characters of the (whitespace-collapsed)
     * content are used. Both branches are capped at 30 characters.
     */
    deriveDefaultPromptName(content) {
        const text = (content || '').replace(/\r\n/g, '\n');
        const lines = text.split('\n');
        // Skip any leading blank lines before locating the title candidate.
        let i = 0;
        while (i < lines.length && lines[i].trim() === '') i++;
        if (i >= lines.length) return '';

        const first = lines[i].trim();
        // It "has a title" when the first non-empty line is either the only
        // non-empty line, or it's followed by a blank line. Anything else
        // (a multi-line paragraph with no blank separator) is treated as
        // bodyless prose — fall back to the first-50-chars rule.
        const hasTitle = (i + 1 >= lines.length) || lines[i + 1].trim() === '';
        const candidate = hasTitle ? first : text.replace(/\s+/g, ' ').trim();
        return candidate.slice(0, 30);
    }

    /**
     * Look up a folder's display name in the loaded prompt library tree.
     * Returns the name or a "folder #<id>" fallback so the notification
     * never shows an empty string.
     */
    findPromptFolderName(folderId) {
        const walk = (nodes) => {
            for (const n of nodes || []) {
                if (n.id === folderId) return n.name;
                const child = walk(n.children);
                if (child) return child;
            }
            return null;
        };
        return walk(this.promptLibrary) || `folder #${folderId}`;
    }

    showNotification(message, type = 'info', link = null) {
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 p-4 rounded-lg shadow-lg z-50 ${
            type === 'success' ? 'bg-green-50 border border-green-200 text-green-800' :
            type === 'error' ? 'bg-red-50 border border-red-200 text-red-800' :
            'bg-blue-50 border border-blue-200 text-blue-800'
        }`;

        let content = `<p class="font-medium">${message}</p>`;
        if (link) {
            content += `<a href="${link}" target="_blank" rel="noopener noreferrer" class="text-sm underline mt-2 block">Open in Google Drive →</a>`;
        }

        notification.innerHTML = content;
        document.body.appendChild(notification);

        // Auto-remove after 5 seconds
        setTimeout(() => {
            notification.remove();
        }, 5000);
    }

    showProgress(text) {
        this.progressBar.classList.remove('hidden');
        this.progressText.textContent = text;
    }

    hideProgress() {
        this.progressBar.classList.add('hidden');
    }

    scrollToBottom() {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    /**
     * Show/hide the on-demand Verify button based on whether the verifier split pane is active.
     */
    updateVerifyLastBtnVisibility() {
        if (!this.verifyLastBtn) return;
        const shouldShow = this.splitPaneActive && this.activeSplitMode === 'verifier';
        this.verifyLastBtn.classList.toggle('hidden', !shouldShow);
        this.verifyLastBtn.classList.toggle('flex', shouldShow);
    }

    /**
     * Show/hide the on-demand Compare button based on whether the compare split pane is active.
     */
    updateCompareLastBtnVisibility() {
        if (!this.compareLastBtn) return;
        const shouldShow = this.splitPaneActive && this.activeSplitMode === 'compare';
        this.compareLastBtn.classList.toggle('hidden', !shouldShow);
        this.compareLastBtn.classList.toggle('flex', shouldShow);
    }

    /**
     * On-demand comparison: re-run the last user prompt against the selected
     * compare LLM and stream the result into the compare pane. Does not
     * re-trigger the primary LLM.
     */
    async compareLastPrompt() {
        if (this.compareLastBtn?.disabled) return;

        if (!this.selectedComparer) {
            alert('Select a compare LLM in the sidebar first.');
            return;
        }

        // Find the last user message in the conversation
        let lastUserMessage = '';
        for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
            if (this.conversationHistory[i].role === 'user') {
                lastUserMessage = this.conversationHistory[i].content || '';
                break;
            }
        }
        if (!lastUserMessage) {
            alert('No user prompt to replay yet.');
            return;
        }

        this.compareLastBtn.disabled = true;

        // Prepare the compare pane: clear prior content, echo the user's prompt
        // as a blue user bubble (matching the primary pane), then show the 3-dot
        // indicator so the user sees activity before the first chunk arrives.
        this.clearCompareMessages();
        this.addCompareMessage('user', lastUserMessage);
        const compareMsgId = this.addCompareMessage('assistant', '', true);

        // Reset the same streaming parser state used by the main compare flow
        // so in-progress SVG/code blocks render via placeholders.
        this.compareParserState = null;
        this.compareBuffer = '';
        this.compareDisplayHtml = '';
        this.compareFullContent = '';
        this.compareCarryOver = '';
        this.compareCurrentCodeBlockPlaceholder = null;

        this.showProgress(`[Compare] Starting ${this.selectedComparer}...`);

        try {
            const storedUser = window.accountStore.getActiveUser();
            // Strip the trailing user message from history so the backend re-answers it
            // instead of treating it as prior context.
            const historyForReplay = this.conversationHistory.slice(0, -1).slice(-10);

            const response = await fetch(window.apiUrl('/compare'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    message: lastUserMessage,
                    conversation_history: historyForReplay,
                    compare_provider: this.selectedComparer,
                    user_id: storedUser?.id || 'demo-user'
                })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const block of events) {
                    if (!block.trim()) continue;
                    let event = '', data = '';
                    for (const line of block.split('\n')) {
                        if (line.startsWith('event: ')) event = line.substring(7);
                        else if (line.startsWith('data: ')) data += (data ? '\n' : '') + line.substring(6);
                    }
                    if (!event) continue;

                    if (event === 'compare_start') {
                        this.showProgress(`[Compare] Running...`);
                    } else if (event === 'compare_progress') {
                        this.showProgress(`[Compare] ${data}`);
                    } else if (event === 'compare_chunk') {
                        if (compareMsgId) {
                            this.appendCompareChunk(compareMsgId, data);
                            this.scrollCompareToBottom();
                        }
                    } else if (event === 'compare_response') {
                        if (this.compareFullContent && compareMsgId) {
                            this.updateMessage(compareMsgId, this.compareFullContent, false);
                        }
                    } else if (event === 'compare_error') {
                        let msg = 'Compare failed';
                        try { msg = JSON.parse(data).message || msg; } catch (e) { msg = data || msg; }
                        if (compareMsgId) {
                            this.updateMessage(compareMsgId, `**Compare Error:** ${msg}`, false);
                        }
                    } else if (event === 'compare_complete') {
                        this.hideProgress();
                    }
                }
            }
        } catch (err) {
            console.error('compareLastPrompt failed:', err);
            if (compareMsgId) {
                this.updateMessage(compareMsgId, `**Compare Error:** ${err.message || err}`, false);
            } else {
                alert(`Compare failed: ${err.message || err}`);
            }
        } finally {
            this.hideProgress();
            this.compareLastBtn.disabled = false;
        }
    }

    /**
     * On-demand verification of the latest assistant response in the conversation.
     */
    async verifyLastResponse() {
        if (this.verifyLastBtn?.disabled) return;

        if (!this.selectedVerifier) {
            alert('Select a verifier in the sidebar first.');
            return;
        }

        // Find the last assistant message and the user message that preceded it
        let lastAssistantIdx = -1;
        for (let i = this.conversationHistory.length - 1; i >= 0; i--) {
            if (this.conversationHistory[i].role === 'assistant') {
                lastAssistantIdx = i;
                break;
            }
        }
        if (lastAssistantIdx === -1) {
            alert('No assistant response to verify yet.');
            return;
        }
        const responseText = this.conversationHistory[lastAssistantIdx].content || '';
        let originalMessage = '';
        for (let i = lastAssistantIdx - 1; i >= 0; i--) {
            if (this.conversationHistory[i].role === 'user') {
                originalMessage = this.conversationHistory[i].content || '';
                break;
            }
        }
        if (!originalMessage || !responseText) {
            alert('Could not locate the original question or response.');
            return;
        }

        this.verifyLastBtn.disabled = true;
        this.clearVerifierMessages();
        let verifierMsgId = null;

        try {
            const storedUser = window.accountStore.getActiveUser();
            const response = await fetch(window.apiUrl('/verify'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    original_message: originalMessage,
                    response_text: responseText,
                    verifier_provider: this.selectedVerifier,
                    user_id: storedUser?.id || 'demo-user'
                })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let verifierFullContent = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const block of events) {
                    if (!block.trim()) continue;
                    let event = '', data = '';
                    for (const line of block.split('\n')) {
                        if (line.startsWith('event: ')) event = line.substring(7);
                        else if (line.startsWith('data: ')) data += (data ? '\n' : '') + line.substring(6);
                    }
                    if (!event) continue;

                    if (event === 'verification_start') {
                        verifierMsgId = this.addVerifierMessage('assistant', '', true);
                        verifierFullContent = '';
                        this.showProgress('[Verifier] Starting verification...');
                    } else if (event === 'verification_progress') {
                        this.showProgress(`[Verifier] ${data}`);
                    } else if (event === 'verifier_chunk') {
                        if (verifierMsgId) {
                            verifierFullContent += data;
                            const wrapper = document.getElementById(verifierMsgId);
                            const bubble = wrapper?.querySelector('div');
                            if (bubble) {
                                const html = this.renderMarkdown(verifierFullContent);
                                bubble.innerHTML = `<div class="markdown-content">${html}</div><span class="inline-block w-2 h-4 bg-green-500 animate-pulse ml-1"></span>`;
                            }
                            this.scrollVerifierToBottom();
                        }
                    } else if (event === 'verification_response') {
                        if (verifierFullContent && verifierMsgId) {
                            this.updateMessage(verifierMsgId, verifierFullContent, false);
                        }
                    } else if (event === 'verification_error') {
                        let msg = 'Verification failed';
                        try { msg = JSON.parse(data).message || msg; } catch (e) { msg = data || msg; }
                        if (verifierMsgId) {
                            this.updateMessage(verifierMsgId, `**Verification Error:** ${msg}`, false);
                        }
                    } else if (event === 'verification_complete') {
                        this.hideProgress();
                    }
                }
            }
        } catch (err) {
            console.error('verifyLastResponse failed:', err);
            if (verifierMsgId) {
                this.updateMessage(verifierMsgId, `**Verification Error:** ${err.message || err}`, false);
            } else {
                alert(`Verification failed: ${err.message || err}`);
            }
        } finally {
            this.hideProgress();
            this.verifyLastBtn.disabled = false;
        }
    }

    /**
     * Toggle between raw markdown and rendered view for main response
     */
    toggleRawMode() {
        this.isRawMode = !this.isRawMode;

        // Update button label
        if (this.toggleRawLabel) {
            this.toggleRawLabel.textContent = this.isRawMode ? 'Rendered' : 'Raw';
        }

        // Update button style to indicate active state
        if (this.toggleRawBtn) {
            if (this.isRawMode) {
                // Active state - highlighted
                this.toggleRawBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-600');
                this.toggleRawBtn.classList.remove('bg-white', 'text-blue-700', 'border-blue-300');
            } else {
                // Default state
                this.toggleRawBtn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600');
                this.toggleRawBtn.classList.add('bg-white', 'text-blue-700', 'border-blue-300');
            }
        }

        // Find all assistant message bubbles and toggle their display
        const assistantMessages = this.messagesContainer.querySelectorAll('.flex.justify-center');
        assistantMessages.forEach(wrapper => {
            const bubble = wrapper.querySelector('.bg-white');
            if (!bubble) return;

            const markdownContent = bubble.querySelector('.markdown-content');
            if (!markdownContent) return;

            // Get raw content stored on the bubble
            const rawContent = bubble.dataset.rawContent;
            if (!rawContent) return;

            if (this.isRawMode) {
                // Switch to raw mode - store rendered HTML and show raw
                if (!bubble.dataset.renderedHtml) {
                    bubble.dataset.renderedHtml = markdownContent.innerHTML;
                }
                markdownContent.innerHTML = `
                    <div class="raw-content-wrapper relative">
                        <pre class="raw-content-pre whitespace-pre-wrap font-mono text-sm bg-gray-100 p-4 rounded-lg border overflow-x-auto max-h-[70vh] overflow-y-auto">${this.escapeHtml(rawContent)}</pre>
                        <div class="scroll-indicator absolute bottom-0 left-0 right-0 h-12 pointer-events-none rounded-b-lg flex items-end justify-center pb-1" style="background: linear-gradient(transparent, rgba(243,244,246,0.95));">
                            <span class="text-xs text-gray-500 flex items-center gap-1">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>
                                Scroll for more
                            </span>
                        </div>
                    </div>`;

                // Hide scroll indicator when scrolled to bottom
                const pre = markdownContent.querySelector('.raw-content-pre');
                const indicator = markdownContent.querySelector('.scroll-indicator');
                if (pre && indicator) {
                    const updateIndicator = () => {
                        const isScrollable = pre.scrollHeight > pre.clientHeight;
                        const isAtBottom = pre.scrollHeight - pre.scrollTop <= pre.clientHeight + 20;
                        indicator.style.opacity = (isScrollable && !isAtBottom) ? '1' : '0';
                        indicator.style.transition = 'opacity 0.2s';
                    };
                    updateIndicator();
                    pre.addEventListener('scroll', updateIndicator);
                }
            } else {
                // Switch back to rendered mode
                if (bubble.dataset.renderedHtml) {
                    markdownContent.innerHTML = bubble.dataset.renderedHtml;
                }
            }
        });
    }

    clearChat() {
        this.messagesContainer.innerHTML = `
            <div class="flex justify-center">
                <div class="bg-gray-100 text-gray-600 px-4 py-2 rounded-full text-sm" data-i18n="welcome.message">
                    ${window.i18n.t('welcome.message')}
                </div>
            </div>
        `;
        this.conversationHistory = [];
        this.totalTokens = 0;
        this.tokenInfo.textContent = window.i18n.t('infoBar.ready');
        this.currentContextId = null; // Reset context to start a new conversation
        this.renderContextsList(); // Update sidebar to show no active conversation
        // Drop any attachments — they belong to the previous conversation.
        this.pendingAttachments = [];
        this.renderAttachmentChips();

        // Also clear the verifier pane if it exists
        if (this.splitPaneActive) {
            this.clearVerifierMessages();
        }

        // Tear down the artifact pane too — the document it was showing
        // belonged to the conversation we just cleared.
        if (this.activeSplitMode === 'artifact' && typeof this.hideArtifactPane === 'function') {
            this.hideArtifactPane();
        }
    }

    showFunctionsModal() {
        this.functionsList.innerHTML = this.functions.map(fn => `
            <div class="py-2 border-b last:border-0">
                <code class="text-blue-600 font-medium">${fn}</code>
            </div>
        `).join('');
        this.functionsModal.classList.remove('hidden');
    }

    hideFunctionsModal() {
        this.functionsModal.classList.add('hidden');
    }

    /**
     * Show the conversation context modal with both Array and JSON views
     * Renders both tabs at once; user toggles between them
     */
    showContextModal() {
        if (!this.contextModal || !this.contextList) return;

        // History as actually sent to the backend (matches sendMessage slicing)
        const history = (this.conversationHistory || []).slice(-10);
        const pendingPrompt = (this.userInput?.value || '').trim();
        const activeSkill = this.activeSkill || null;

        // Build the ordered list of context items as they reach the LLM
        const items = this.buildContextItems(history, pendingPrompt, activeSkill);

        // Stats — count chars across displayed items (including placeholders)
        const totalChars = items.reduce((acc, it) => acc + (it.content?.length || 0), 0);
        const approxTokens = Math.ceil(totalChars / 4);
        if (this.contextStats) {
            this.contextStats.textContent =
                `${items.length} item${items.length !== 1 ? 's' : ''} · ${totalChars.toLocaleString()} chars · ~${approxTokens.toLocaleString()} tokens`;
        }

        this.renderContextArrayTab(items);
        this.renderContextJsonTab(history, pendingPrompt, activeSkill);

        this.switchContextTab(this.activeContextTab || 'array');
        this.contextModal.classList.remove('hidden');
    }

    /**
     * Compose the ordered context as the LLM receives it:
     *   system (server-side) → memory (server-side) → skill → history → pending user prompt
     */
    buildContextItems(history, pendingPrompt, activeSkill) {
        const items = [];

        items.push({
            role: 'system',
            content: '(built server-side by the current provider — not visible from the client)',
            note: 'Each provider has its own default system prompt. Not sent by the client, so it cannot be displayed here.',
            serverSide: true
        });

        items.push({
            role: 'memory',
            content: "(built server-side from the user's frozen memory — not visible from the client)",
            note: "Appended to the system prompt on the backend as options['memory_context'].",
            serverSide: true
        });

        if (activeSkill) {
            items.push({
                role: 'skill',
                content: activeSkill.skill_content || '',
                note: `Active skill "${activeSkill.name}" — sent in the request body as skill_content and appended to the system prompt.`
            });
        } else {
            items.push({
                role: 'skill',
                content: '(no active skill — drag one from the Skills sidebar onto the prompt input)',
                serverSide: true
            });
        }

        for (const msg of history) {
            items.push({
                role: msg.role || 'unknown',
                content: msg.content || '',
                provider: msg.provider || ''
            });
        }

        items.push({
            role: 'user',
            content: pendingPrompt,
            note: pendingPrompt
                ? 'Next user prompt — current content of the input box, what will be sent on Send.'
                : 'Next user prompt — input is empty.',
            pending: true
        });

        return items;
    }

    /**
     * Render the "Array Formatted" tab - cards with raw markdown content
     */
    renderContextArrayTab(items) {
        if (!this.contextList) return;

        if (!items || items.length === 0) {
            this.contextList.innerHTML = `
                <div class="text-center py-12 text-gray-500 text-sm">
                    No conversation yet. Send a message to see the context.
                </div>
            `;
            return;
        }

        const escapeHtml = (s) => String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        const roleColorFor = (role) => {
            switch (role) {
                case 'user':      return 'bg-blue-100 text-blue-800 border-blue-200';
                case 'assistant': return 'bg-green-100 text-green-800 border-green-200';
                case 'system':    return 'bg-purple-100 text-purple-800 border-purple-200';
                case 'memory':    return 'bg-amber-100 text-amber-800 border-amber-200';
                case 'skill':     return 'bg-indigo-100 text-indigo-800 border-indigo-200';
                default:          return 'bg-gray-100 text-gray-800 border-gray-200';
            }
        };

        this.contextList.innerHTML = items.map((it, idx) => {
            const role = it.role || 'unknown';
            const content = it.content || '';
            const charCount = content.length;
            const muted = it.serverSide || it.pending && !content;

            return `
                <div class="mb-4 bg-white border ${muted ? 'border-dashed border-gray-300' : 'border-gray-200'} rounded-lg overflow-hidden">
                    <div class="px-3 py-2 border-b border-gray-200 flex items-center justify-between text-xs">
                        <div class="flex items-center gap-2">
                            <span class="text-gray-400 font-mono">#${idx + 1}</span>
                            <span class="px-2 py-0.5 rounded border ${roleColorFor(role)} font-semibold uppercase tracking-wider">${escapeHtml(role)}</span>
                            ${it.provider ? `<span class="text-gray-500">${escapeHtml(it.provider)}</span>` : ''}
                            ${it.pending ? `<span class="px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-200 font-semibold">PENDING</span>` : ''}
                        </div>
                        <span class="text-gray-400 font-mono">${charCount.toLocaleString()} chars</span>
                    </div>
                    ${it.note ? `<div class="px-3 py-1.5 bg-gray-50 text-[11px] text-gray-500 italic border-b border-gray-100">${escapeHtml(it.note)}</div>` : ''}
                    <pre class="px-3 py-3 text-xs font-mono ${muted ? 'text-gray-400' : 'text-gray-800'} whitespace-pre-wrap break-words overflow-x-auto leading-relaxed">${escapeHtml(content)}</pre>
                </div>
            `;
        }).join('');
    }

    /**
     * Render the "JSON Formatted" tab - the actual payload structure sent to the LLM
     * Shows the messages array as it would appear in the provider request body,
     * annotated with a comment about server-added fields (system prompt, tools)
     */
    renderContextJsonTab(history, pendingPrompt, activeSkill) {
        if (!this.contextJsonContent) return;

        const messages = history.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        const payload = {
            provider: this.currentProvider || 'unknown',
            conversation_history: messages,
            pending_user_message: pendingPrompt || '',
            skill_content: activeSkill?.skill_content ?? null,
            skill_metadata: (activeSkill?.source === 'local'
                && activeSkill?.dir_name
                && Array.isArray(activeSkill?.scripts)
                && activeSkill.scripts.length > 0)
                ? { dir_name: activeSkill.dir_name, scripts: activeSkill.scripts }
                : null,
            streaming: true
        };

        const jsonString = JSON.stringify(payload, null, 2);

        const annotation =
`// ============================================================
// Request body as sent by the client to POST /api/v1/chat.
// ------------------------------------------------------------
// conversation_history is sliced to the last 10 messages, same
// as sendMessage(). pending_user_message is the current input
// box content (becomes the "message" field on Send).
//
// The backend adds, before calling the LLM API:
//   - the provider's default system prompt
//   - options['memory_context'] (user's frozen memory)
//   - options['skill_content']  (appended to system prompt)
//   - "tools" array (builtin + MCP tools)
//   - temperature / max_tokens / tool_choice
//
// System prompt and memory_context are not visible on the
// client — they are assembled server-side per provider.
// ============================================================

`;

        this.contextJsonContent.textContent = annotation + jsonString;
    }

    /**
     * Switch between the Array and JSON tabs in the context modal
     */
    switchContextTab(tabName) {
        this.activeContextTab = tabName;

        // Update tab buttons
        if (this.contextTabButtons) {
            this.contextTabButtons.forEach(btn => {
                const isActive = btn.dataset.contextTab === tabName;
                if (isActive) {
                    btn.classList.add('active', 'border-blue-600', 'text-blue-600');
                    btn.classList.remove('border-transparent', 'text-gray-500');
                } else {
                    btn.classList.remove('active', 'border-blue-600', 'text-blue-600');
                    btn.classList.add('border-transparent', 'text-gray-500');
                }
            });
        }

        // Show/hide tab content
        if (this.contextList && this.contextJson) {
            if (tabName === 'array') {
                this.contextList.classList.remove('hidden');
                this.contextJson.classList.add('hidden');
            } else {
                this.contextList.classList.add('hidden');
                this.contextJson.classList.remove('hidden');
            }
        }
    }

    hideContextModal() {
        if (this.contextModal) {
            this.contextModal.classList.add('hidden');
        }
    }

    copyContextToClipboard() {
        const history = this.conversationHistory || [];
        if (history.length === 0) return;

        let text;
        if (this.activeContextTab === 'json') {
            // Copy the JSON-formatted content exactly as shown
            text = this.contextJsonContent?.textContent || '';
        } else {
            // Copy the array-formatted content as human-readable sections
            text = history.map((msg, idx) => {
                const role = (msg.role || 'unknown').toUpperCase();
                const provider = msg.provider ? ` [${msg.provider}]` : '';
                return `--- Message #${idx + 1} · ${role}${provider} ---\n${msg.content || ''}`;
            }).join('\n\n');
        }

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = this.contextCopyBtn.textContent;
                this.contextCopyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    this.contextCopyBtn.textContent = originalText;
                }, 1500);
            });
        }
    }

    // ============================================
    // EVI (Empathic Voice Interface) - OPTIMIZED
    // ============================================

    async connectToEVI() {
        try {
            console.log('🎙️ Connecting to Hume EVI...');

            // Clear manual disconnect flag when connecting
            this.eviManualDisconnect = false;
            this.eviReconnectAttempts = 0;

            this.updateEVIStatus('🔄', 'Connecting...', 'Initializing voice connection');
            this.eviStatus.classList.remove('hidden');

            if (this.inputArea) {
                this.inputArea.style.display = 'none';
            }

            // Auto-sync tools to Hume before connecting
            this.updateEVIStatus('🔄', 'Syncing tools...', 'Updating function definitions');
            await this.syncHumeTools();

            const apiKey = window.APP_CONFIG?.hume?.apiKey;
            if (!apiKey) {
                throw new Error('Hume API key not configured in config.js');
            }

            let wsUrl = `wss://api.hume.ai/v0/evi/chat?api_key=${encodeURIComponent(apiKey)}`;

            const configId = window.APP_CONFIG.hume.configId;
            if (configId) {
                wsUrl += `&config_id=${encodeURIComponent(configId)}`;
            }

            this.eviSocket = new WebSocket(wsUrl);

            this.eviSocket.onopen = async () => {
                console.log('✅ EVI WebSocket connected');
                this.eviConnected = true;
                this.eviReconnectAttempts = 0;

                // Update button to show "Disconnect" when connected
                this.eviToggleBtn.textContent = 'Disconnect';
                this.eviToggleBtn.className = 'bg-red-500 hover:bg-red-600 text-white px-8 py-4 rounded-lg font-medium transition shadow-xl transform hover:scale-105';

                await this.startEVIAudioCapture();

                this.updateEVIStatus('🟢', 'Listening...', 'Speak now to start conversation');
            };

            this.eviSocket.onmessage = (event) => {
                this.handleEVIMessage(JSON.parse(event.data));
            };

            this.eviSocket.onerror = (error) => {
                console.error('❌ EVI WebSocket error:', error);
                this.updateEVIStatus('⚠️', 'Error', 'Connection error occurred');
            };

            this.eviSocket.onclose = () => {
                console.log('EVI connection closed');
                this.eviConnected = false;
                this.updateEVIStatus('⭕', 'Disconnected', 'Connection closed');

                // Auto-reconnect logic - only if NOT a manual disconnect
                if (!this.eviManualDisconnect && this.currentProvider === 'evi' && this.eviReconnectAttempts < this.eviMaxReconnectAttempts) {
                    this.eviReconnectAttempts++;
                    console.log(`Reconnecting... Attempt ${this.eviReconnectAttempts}/${this.eviMaxReconnectAttempts}`);
                    setTimeout(() => this.connectToEVI(), 2000 * this.eviReconnectAttempts);
                } else {
                    // Update button to show "Connect" when disconnected (manual or max retries)
                    this.eviToggleBtn.textContent = 'Connect';
                    this.eviToggleBtn.className = 'bg-green-500 hover:bg-green-600 text-white px-8 py-4 rounded-lg font-medium transition shadow-xl transform hover:scale-105';
                    if (this.eviManualDisconnect) {
                        console.log('Manual disconnect - skipping auto-reconnect');
                    }
                }
            };

        } catch (error) {
            console.error('❌ EVI connection failed:', error);
            this.updateEVIStatus('❌', 'Connection Failed', error.message);
            setTimeout(() => {
                this.addSystemMessage(`EVI connection failed: ${error.message}`, 'error');
                if (this.providers.length > 0) {
                    this.switchProvider(this.providers[0].name);
                }
            }, 2000);
        }
    }

    handleEVIMessage(message) {
        // Debug: Log all message types to identify patterns
        if (message.type !== 'audio_output') {
            console.log(`📨 EVI message: ${message.type}`, message.type === 'tool_call' ? message : '');
        }

        switch (message.type) {
            case 'chat_metadata':
                break;

            case 'user_message':
                this.updateEVIStatus('🔵', 'Processing...', 'Understanding your message');
                break;

            case 'assistant_message':
                break;

            case 'audio_output':
                // Queue audio instead of playing immediately
                this.queueEVIAudio(message.data);
                this.updateEVIStatus('🔊', 'Speaking...', 'EVI is responding');
                break;

            case 'assistant_end':
                break;

            case 'user_interruption':
                // Don't clear audio queue during tool execution to prevent glitches
                if (!this.eviToolExecuting) {
                    this.clearEVIAudioQueue();
                    this.updateEVIStatus('🟢', 'Listening...', 'Continue speaking');
                }
                break;

            case 'tool_call':
                // Handle function tool calls from Hume EVI
                this.handleEVIToolCall(message);
                break;

            case 'error':
                console.error('EVI error:', message);
                this.updateEVIStatus('⚠️', 'Error', message.message || 'An error occurred');
                break;

            default:
                break;
        }
    }

    /**
     * Handle tool call from Hume EVI
     * Executes backend function and returns result to EVI
     */
    async handleEVIToolCall(message) {
        const { tool_call_id, name, parameters } = message;

        console.log('🔧 Tool call received:', name, parameters);

        // Skip built-in Hume tools (they're handled by EVI automatically)
        const builtInTools = ['web_search', 'hang_up'];
        if (builtInTools.includes(name)) {
            console.log('⚠️ Skipping built-in tool:', name, '(handled by Hume)');
            return;
        }

        // Set tool executing flag to prevent audio state issues
        this.eviToolExecuting = true;
        this.updateEVIStatus('⚙️', 'Executing...', `Running ${name}`);

        try {
            // Parse parameters if they're a JSON string
            const params = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;

            // Call backend to execute the function
            const response = await fetch(window.apiUrl('/hume/tools/execute'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    toolCallId: tool_call_id,
                    toolName: name,
                    parameters: params
                })
            });

            const data = await response.json();

            if (data.success) {
                // Send successful result back to EVI
                this.eviSocket.send(JSON.stringify({
                    type: 'tool_response',
                    tool_call_id: tool_call_id,
                    content: data.content
                }));

                console.log('✅ Tool result sent to EVI:', name);
                // Don't immediately change to Listening - let Hume respond with audio first
                this.updateEVIStatus('⚙️', 'Processing...', 'Waiting for response');
            } else {
                // Send error to EVI
                this.eviSocket.send(JSON.stringify({
                    type: 'tool_error',
                    tool_call_id: tool_call_id,
                    error: data.error || 'Tool execution failed',
                    content: `Failed to execute ${name}`
                }));

                console.error('❌ Tool execution failed:', data.error);
                this.updateEVIStatus('⚠️', 'Error', 'Tool execution failed');
            }

        } catch (error) {
            console.error('❌ Tool call error:', error);

            // Send error to EVI
            if (this.eviSocket && this.eviConnected) {
                this.eviSocket.send(JSON.stringify({
                    type: 'tool_error',
                    toolCallId: tool_call_id,
                    error: error.message,
                    content: 'An error occurred while executing the tool'
                }));
            }

            this.updateEVIStatus('⚠️', 'Error', error.message);
        } finally {
            // Clear tool executing flag
            this.eviToolExecuting = false;
        }
    }

    /**
     * Sync backend tools to Hume API
     * Automatically syncs tools when connecting to EVI
     */
    async syncHumeTools() {
        try {
            console.log('🔄 Syncing tools to Hume API...');

            const response = await fetch(window.apiUrl('/hume/tools/sync'), {
                method: 'POST',
                headers: this.getAuthHeaders()
            });

            const data = await response.json();

            if (data.success) {
                console.log(`✅ Tools synced! Created: ${data.stats.created}, Updated: ${data.stats.updated}`);
                return true;
            } else {
                console.warn('⚠️ Tool sync failed:', data.error);
                // Don't block connection if sync fails
                return false;
            }

        } catch (error) {
            console.warn('⚠️ Tool sync error:', error.message);
            // Don't block connection if sync fails
            return false;
        }
    }

    async startEVIAudioCapture() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Optimized codec selection
            const mimeTypes = [
                'audio/webm;codecs=opus',  // Best quality/compression
                'audio/webm',
                'audio/ogg;codecs=opus',
                'audio/ogg'
            ];

            let selectedMimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));

            const mediaRecorder = new MediaRecorder(stream, {
                mimeType: selectedMimeType,
                audioBitsPerSecond: 128000  // Optimized bitrate
            });

            mediaRecorder.ondataavailable = async (event) => {
                if (event.data.size > 0 && this.eviSocket && this.eviConnected) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const base64Audio = reader.result.split(',')[1];

                        this.eviSocket.send(JSON.stringify({
                            type: 'audio_input',
                            data: base64Audio
                        }));
                    };
                    reader.readAsDataURL(event.data);
                }
            };

            // Optimized chunk size (200ms instead of 100ms for less overhead)
            mediaRecorder.start(200);

            this.eviMediaRecorder = mediaRecorder;
            this.eviMediaStream = stream;

            console.log('🎤 Microphone active');

        } catch (error) {
            console.error('Failed to access microphone:', error);
            throw new Error('Microphone access denied. Please allow microphone access.');
        }
    }

    // Audio queue system for smooth playback
    queueEVIAudio(base64Audio) {
        this.eviAudioQueue.push(base64Audio);

        if (!this.eviIsPlaying) {
            this.playNextEVIAudio();
        }
    }

    async playNextEVIAudio() {
        if (this.eviAudioQueue.length === 0) {
            this.eviIsPlaying = false;
            console.log('🔇 Audio queue empty, stopping playback');
            // Don't switch to "Listening" if a tool is currently executing
            if (!this.eviToolExecuting) {
                this.updateEVIStatus('🟢', 'Listening...', 'Your turn to speak');
            }
            return;
        }

        this.eviIsPlaying = true;
        const base64Audio = this.eviAudioQueue.shift();
        console.log(`🔊 Playing audio chunk, ${this.eviAudioQueue.length} remaining in queue`);

        try {
            // Optimized decoding
            const binaryString = atob(base64Audio);
            const bytes = new Uint8Array(binaryString.length);

            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Hume EVI sends audio as WAV format
            const blob = new Blob([bytes], { type: 'audio/wav' });
            const audioUrl = URL.createObjectURL(blob);

            // Reuse audio element
            if (!this.eviAudioElement) {
                this.eviAudioElement = new Audio();
            }

            this.eviAudioElement.src = audioUrl;

            this.eviAudioElement.onended = () => {
                URL.revokeObjectURL(audioUrl);  // Clean up memory
                this.playNextEVIAudio();  // Play next in queue
            };

            this.eviAudioElement.onerror = (e) => {
                console.error('❌ Error playing EVI audio:', e, 'Audio element error:', this.eviAudioElement?.error);
                URL.revokeObjectURL(audioUrl);
                this.playNextEVIAudio();  // Continue with next
            };

            await this.eviAudioElement.play();

        } catch (error) {
            console.error('Error decoding EVI audio:', error);
            this.playNextEVIAudio();  // Continue with next
        }
    }

    clearEVIAudioQueue() {
        // Clear the queue
        this.eviAudioQueue = [];

        // Stop and cleanup audio element
        if (this.eviAudioElement) {
            try {
                // Pause playback
                this.eviAudioElement.pause();

                // Reset time
                this.eviAudioElement.currentTime = 0;

                // Remove event handlers to prevent continuation
                this.eviAudioElement.onended = null;
                this.eviAudioElement.onerror = null;

                // Revoke the current audio URL to free memory
                if (this.eviAudioElement.src && this.eviAudioElement.src.startsWith('blob:')) {
                    URL.revokeObjectURL(this.eviAudioElement.src);
                }

                // Clear the source
                this.eviAudioElement.src = '';
                this.eviAudioElement.removeAttribute('src');

            } catch (error) {
                console.error('Error clearing audio:', error);
            }
        }

        this.eviIsPlaying = false;
    }

    updateEVIStatus(icon, state, hint) {
        this.eviIcon.textContent = icon;
        this.eviStateText.textContent = state;
        this.eviHintText.textContent = hint;
    }

    async disconnectEVI() {
        console.log('🔌 Disconnecting EVI...');

        try {
            // Set manual disconnect flag to prevent auto-reconnect
            this.eviManualDisconnect = true;

            // Send pause command to Hume before disconnecting
            if (this.eviSocket && this.eviSocket.readyState === WebSocket.OPEN) {
                try {
                    this.eviSocket.send(JSON.stringify({
                        type: 'pause_assistant_message'
                    }));
                    console.log('📤 Sent pause command to Hume');
                } catch (e) {
                    console.error('Failed to send pause command:', e);
                }
            }

            // Clear audio queue and stop playback
            this.clearEVIAudioQueue();

            // Stop media recorder
            if (this.eviMediaRecorder && this.eviMediaRecorder.state !== 'inactive') {
                this.eviMediaRecorder.stop();
                this.eviMediaRecorder = null;
            }

            // Stop media stream
            if (this.eviMediaStream) {
                this.eviMediaStream.getTracks().forEach(track => track.stop());
                this.eviMediaStream = null;
            }

            // Cleanup audio element
            if (this.eviAudioElement) {
                this.eviAudioElement.pause();
                this.eviAudioElement = null;
            }

            // Close WebSocket
            if (this.eviSocket && this.eviSocket.readyState === WebSocket.OPEN) {
                this.eviSocket.close();
                this.eviSocket = null;
            }

            this.eviConnected = false;
            this.eviReconnectAttempts = 0;

            // Update UI to show disconnected state
            this.updateEVIStatus('⭕', 'Disconnected', 'Click Connect to start');
            this.eviToggleBtn.textContent = 'Connect';
            this.eviToggleBtn.className = 'bg-green-500 hover:bg-green-600 text-white px-8 py-4 rounded-lg font-medium transition shadow-xl transform hover:scale-105';

            console.log('✅ EVI disconnected');
        } catch (error) {
            console.error('Error disconnecting EVI:', error);
        }
    }

    async toggleEVIConnection() {
        if (this.eviConnected) {
            // Currently connected, so disconnect
            await this.disconnectEVI();
        } else {
            // Currently disconnected, so connect
            // Clear manual disconnect flag to allow auto-reconnect if needed
            this.eviManualDisconnect = false;
            this.eviToggleBtn.textContent = 'Disconnect';
            this.eviToggleBtn.className = 'bg-red-500 hover:bg-red-600 text-white px-8 py-4 rounded-lg font-medium transition shadow-xl transform hover:scale-105';
            await this.connectToEVI();
        }
    }

    async returnToHome() {
        console.log('🏠 Returning to home...');

        try {
            // First disconnect EVI
            await this.disconnectEVI();

            // Hide EVI screen
            this.eviStatus.classList.add('hidden');

            // Show input area
            if (this.inputArea) {
                this.inputArea.style.display = '';
            }

            // Switch back to Claude (first provider)
            if (this.providers.length > 0) {
                const claudeProvider = this.providers[0];

                try {
                    this.showProgress(`Switching to ${claudeProvider.display_name}...`);

                    const response = await fetch(window.apiUrl('/providers'), {
                        method: 'POST',
                        headers: this.getAuthHeaders(),
                        body: JSON.stringify({ provider: claudeProvider.name })
                    });

                    const data = await response.json();

                    if (data.success) {
                        this.currentProvider = claudeProvider.name;
                        this.renderProviderButtons();
                        this.updateProviderDisplay();
                    }
                } catch (error) {
                    console.error('Failed to switch back to Claude:', error);
                } finally {
                    this.hideProgress();
                }
            }

            console.log('✅ Returned to home');
        } catch (error) {
            console.error('Error returning to home:', error);
        }
    }

    // ========================================
    // SIDEBAR & CONTEXT MANAGEMENT
    // ========================================

    /**
     * Initialize sidebar state based on screen size
     */
    initializeSidebar() {
        const isMobile = window.innerWidth < 768;

        // On mobile, start with sidebar collapsed
        if (isMobile) {
            this.sidebarCollapsed = true;
            this.contextsSidebar.classList.add('collapsed');
            if (this.sidebarToggleTopIcon) this.sidebarToggleTopIcon.textContent = '☰';
            // Tools button inactive when sidebar is collapsed
            if (this.toolsToggleBtn) {
                this.toolsToggleBtn.classList.remove('active');
            }
        } else {
            // On desktop, sidebar is visible by default
            this.sidebarCollapsed = false;
            this.sidebarToggleIcon.textContent = '◀';
            if (this.sidebarToggleTopIcon) this.sidebarToggleTopIcon.textContent = '◀';
            // Tools button active when sidebar is expanded
            if (this.toolsToggleBtn) {
                this.toolsToggleBtn.classList.add('active');
            }
        }
    }

    /**
     * Initialize sidebar resize functionality
     */
    initSidebarResize() {
        const sidebar = this.contextsSidebar;
        const resizer = document.getElementById('sidebar-resizer');

        if (!resizer) return;

        // Hide resizer on mobile
        const isMobile = window.innerWidth < 768;
        if (isMobile || this.sidebarCollapsed) {
            resizer.style.display = 'none';
        }

        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        // Load saved width from localStorage
        const savedWidth = localStorage.getItem('sidebarWidth');
        if (savedWidth) {
            sidebar.style.width = savedWidth + 'px';
        }

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = sidebar.offsetWidth;
            document.body.classList.add('sidebar-resizing');
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const delta = e.clientX - startX;
            const newWidth = startWidth + delta;

            // Set min/max constraints
            const minWidth = 150;
            const maxWidth = 500;

            if (newWidth >= minWidth && newWidth <= maxWidth) {
                sidebar.style.width = newWidth + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.classList.remove('sidebar-resizing');

                // Save width to localStorage
                localStorage.setItem('sidebarWidth', sidebar.offsetWidth);
            }
        });
    }

    /**
     * Update sidebar icons and behavior on window resize
     */
    updateSidebarForScreenSize() {
        const isMobile = window.innerWidth < 768;
        const resizer = document.getElementById('sidebar-resizer');

        // Update icons based on current state and screen size
        if (this.sidebarCollapsed) {
            if (this.sidebarToggleTopIcon) this.sidebarToggleTopIcon.textContent = isMobile ? '☰' : '▶';

            // Remove backdrop if resized to desktop while collapsed
            if (!isMobile && this.mobileSidebarBackdrop) {
                this.mobileSidebarBackdrop.classList.remove('active');
            }

            // Tools button inactive when sidebar is collapsed
            if (this.toolsToggleBtn) {
                this.toolsToggleBtn.classList.remove('active');
            }
        } else {
            if (this.sidebarToggleTopIcon) this.sidebarToggleTopIcon.textContent = isMobile ? '✕' : '◀';

            // Remove backdrop if resized to desktop while open
            if (!isMobile && this.mobileSidebarBackdrop) {
                this.mobileSidebarBackdrop.classList.remove('active');
            }

            // Tools button active when sidebar is expanded
            if (this.toolsToggleBtn) {
                this.toolsToggleBtn.classList.add('active');
            }
        }

        // Show/hide resize handle based on screen size and sidebar state
        if (resizer) {
            if (isMobile || this.sidebarCollapsed) {
                resizer.style.display = 'none';
            } else {
                resizer.style.display = 'block';
            }
        }
    }

    /**
     * Toggle sidebar collapsed/expanded state
     */
    toggleSidebar() {
        this.sidebarCollapsed = !this.sidebarCollapsed;
        const isMobile = window.innerWidth < 768;
        const resizer = document.getElementById('sidebar-resizer');
        const rail = document.getElementById('sidebar-rail');

        if (this.sidebarCollapsed) {
            this.contextsSidebar.classList.add('collapsed');
            this.sidebarToggleIcon.textContent = '▶';
            if (this.sidebarToggleTopIcon) this.sidebarToggleTopIcon.textContent = isMobile ? '☰' : '▶';

            // Hide resize handle when sidebar is collapsed
            if (resizer) {
                resizer.style.display = 'none';
            }

            // Hide mobile backdrop
            if (this.mobileSidebarBackdrop) {
                this.mobileSidebarBackdrop.classList.remove('active');
            }

            // Update Tools button state (inactive when sidebar is collapsed)
            if (this.toolsToggleBtn) {
                this.toolsToggleBtn.classList.remove('active');
            }

            // Show the activity rail so the user has an in-situ way back.
            if (rail && !isMobile) {
                rail.classList.add('show');
                this.syncRailActive();
            }
        } else {
            this.contextsSidebar.classList.remove('collapsed');
            this.sidebarToggleIcon.textContent = '◀';
            if (this.sidebarToggleTopIcon) this.sidebarToggleTopIcon.textContent = isMobile ? '✕' : '◀';

            // Show resize handle when sidebar is expanded (desktop only)
            if (resizer && !isMobile) {
                resizer.style.display = 'block';
            }

            // Show mobile backdrop on mobile devices
            if (isMobile && this.mobileSidebarBackdrop) {
                this.mobileSidebarBackdrop.classList.add('active');
            }

            // Update Tools button state (active when sidebar is expanded)
            if (this.toolsToggleBtn) {
                this.toolsToggleBtn.classList.add('active');
            }

            // Hide the activity rail — sidebar already shows the nav.
            if (rail) rail.classList.remove('show');
        }
    }

    /**
     * Mirror the current `currentView` onto the rail's icons so the highlight
     * matches the visible view. Called whenever the rail becomes visible or
     * the active view changes.
     */
    syncRailActive() {
        const view = this.currentView || 'conversations';
        document.querySelectorAll('#sidebar-rail [data-rail-target]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.railTarget === view);
        });
    }

    /**
     * Load and display all contexts from backend
     */
    async loadContextsList() {
        try {
            const response = await fetch(window.apiUrl('/contexts'), {
                headers: this.getAuthHeaders()
            });

            // Check for 401 Unauthorized - redirect to login
            if (response.status === 401) {
                window.location.href = 'login.html';
                return;
            }

            const data = await response.json();

            if (data.success) {
                this.contexts = data.data || [];
                this.renderContextsList();
            } else {
                console.error('❌ Failed to load contexts:', data.message);
            }
        } catch (error) {
            console.error('❌ Error loading contexts:', error);
        }
    }

    /**
     * Render contexts list in sidebar
     */
    renderContextsList() {
        if (this.contexts.length === 0) {
            // Use translation if available, fallback to English
            const noConvText = window.i18n ? window.i18n.t('sidebar.noConversations') : 'No conversations yet';
            this.contextsList.innerHTML = `
                <div class="text-center text-gray-400 text-sm py-8" data-i18n="sidebar.noConversations">
                    ${noConvText}
                </div>
            `;
            return;
        }

        this.contextsList.innerHTML = this.contexts.map(context => {
            // Workflow-archive rows have provider="workflow:<id>"; render with
            // a distinct badge and resolve the workflow name for the label.
            const isWorkflow = typeof context.provider === 'string' && context.provider.startsWith('workflow:');
            let style;
            let workflowLabel = '';
            if (isWorkflow) {
                const wfId = parseInt(context.provider.slice('workflow:'.length), 10);
                const wfList = window.workflowEditor?.workflows || [];
                const wf = wfList.find(w => String(w.id) === String(wfId));
                workflowLabel = wf?.name || `Workflow #${wfId}`;
                style = { icon: '🔄' };
            } else {
                style = this.providerStyles[context.provider] || this.providerStyles.default;
            }
            const isActive = context.id === this.currentContextId;
            const date = new Date(context.updated_at);
            const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const wfIdForOpen = isWorkflow ? parseInt(context.provider.slice('workflow:'.length), 10) : null;
            // Is THIS row's workflow currently open in the center panel?
            const isCenterShowingThisWorkflow = isWorkflow
                && window.agentTeamsPanel?.isActive === true
                && String(window.workflowEditor?.currentWorkflowId) === String(wfIdForOpen);
            // Active-in-editor rows use a bold marine-blue fill with white text —
            // unmistakable against the rest of the list.
            const itemBg = isCenterShowingThisWorkflow
                ? 'bg-blue-900 shadow-md'
                : (isWorkflow ? 'bg-indigo-50' : 'bg-white');
            const itemBorder = isCenterShowingThisWorkflow
                ? 'border border-blue-900'
                : 'border border-gray-200';
            // Text/label color tokens flipped to white when the row is highlighted.
            const titleTextCls = isCenterShowingThisWorkflow ? 'text-white' : 'text-gray-800';
            const metaTextCls = isCenterShowingThisWorkflow ? 'text-blue-200' : 'text-gray-500';
            const wfLabelCls = isCenterShowingThisWorkflow ? 'text-white font-semibold' : 'text-indigo-600 font-medium';
            const openWfTitle = isWorkflow
                ? (isCenterShowingThisWorkflow
                    ? (window.i18n?.t?.('sidebar.backToConversation') || 'Back to conversation')
                    : (window.i18n?.t?.('sidebar.openWorkflow') || 'Open in workflow editor'))
                : '';

            const menuBtnCls = isCenterShowingThisWorkflow
                ? 'text-blue-200 hover:text-white'
                : 'text-gray-500 hover:text-gray-700';

            // Skip the ".active" class when our marine-blue workflow
            // highlight is in effect — the CSS rule .context-item.active
            // (index.html) has higher specificity and would overwrite the
            // marine fill with pale blue, making the white text unreadable.
            const applyActiveClass = isActive && !isCenterShowingThisWorkflow;

            return `
                <div class="context-item ${applyActiveClass ? 'active' : ''} ${itemBg} ${itemBorder} rounded p-1 mb-1"
                     data-context-id="${context.id}"
                     onclick="window.chatApp.loadContext(${context.id})"
                     style="max-width: 100%;">
                    <div class="flex items-center gap-1" style="width: 100%;">
                        <div class="flex-1" style="min-width: 0; overflow: hidden;">
                            <div class="context-title text-xs font-medium ${titleTextCls}"
                                 data-context-id="${context.id}"
                                 style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
                                 title="${context.title}">
                                ${context.title}
                            </div>
                            <div class="flex items-center gap-0.5 text-[10px] ${metaTextCls}">
                                <span>${style.icon}</span>
                                ${isWorkflow ? `<span class="${wfLabelCls}">${workflowLabel}</span>` : ''}
                                <span>${context.message_count}</span>
                                <span class="ml-auto font-mono opacity-70">#${context.id}</span>
                            </div>
                        </div>
                        ${isWorkflow ? `
                        <button class="open-workflow-btn flex-shrink-0 rounded-md ${isCenterShowingThisWorkflow
                                    ? 'bg-white text-blue-900 hover:bg-blue-100'
                                    : 'bg-indigo-100 hover:bg-indigo-600 hover:text-white text-indigo-700'}"
                                onclick="event.stopPropagation(); window.chatApp.openWorkflowFromContext(${wfIdForOpen});"
                                title="${openWfTitle}"
                                style="border:1px solid ${isCenterShowingThisWorkflow ? '#ffffff' : '#c7d2fe'}; padding:2px 6px; font-size:13px; font-weight:700; line-height:1; cursor:pointer;">
                            ${isCenterShowingThisWorkflow ? '←' : '✎'}
                        </button>
                        ` : ''}
                        <button class="context-menu-btn ${menuBtnCls} flex-shrink-0 text-sm font-bold"
                                onclick="event.stopPropagation(); window.chatApp.showConversationMenu(event, ${context.id});"
                                title="Options">
                            ⋮
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Toggle the workflow editor view from the sidebar "✎" icon.
     *
     * - Chat view → workflow editor + load this workflow.
     * - Workflow editor showing the SAME workflow → back to chat view.
     * - Workflow editor showing a DIFFERENT workflow → stay in editor, load
     *   the new workflow (lets users switch between workflow rows directly).
     *
     * The conversations sidebar never changes — only the center panel swaps.
     */
    async openWorkflowFromContext(workflowId) {
        if (!workflowId || !Number.isFinite(workflowId)) return;
        const panel = window.agentTeamsPanel;
        const editor = window.workflowEditor;
        if (!panel) return;

        const alreadyActive = panel.isActive === true;
        const currentWfId = editor?.currentWorkflowId;

        // Same workflow icon clicked while its editor is already open → close.
        if (alreadyActive && String(currentWfId) === String(workflowId)) {
            panel.hide();
            this.renderContextsList();
            return;
        }

        // Open the editor (no-op if already open) and load the requested workflow.
        if (!alreadyActive && typeof panel.show === 'function') {
            panel.show();
        }

        // Wait for the editor's async loadWorkflow to finish so
        // currentWorkflowId is populated before we re-render the sidebar
        // (otherwise the highlight lags one click behind).
        const waitForEditor = (attempt = 0) => new Promise(resolve => {
            if (window.workflowEditor && typeof window.workflowEditor.loadWorkflow === 'function') {
                resolve(window.workflowEditor);
                return;
            }
            if (attempt > 20) { resolve(null); return; }
            setTimeout(() => resolve(waitForEditor(attempt + 1)), 50);
        });

        const ed = await waitForEditor();
        if (!ed) {
            console.warn('[chat] workflow editor not available to load workflow', workflowId);
            return;
        }

        try {
            await ed.loadWorkflow(workflowId);
        } catch (e) {
            console.warn('[chat] loadWorkflow failed:', e);
        }
        this.renderContextsList();
    }

    /**
     * Start a new conversation
     */
    async newChat(opts = {}) {
        const { awaitSave = true } = opts;
        // Close settings panel if open
        if (window.settingsPanel?.isActive) {
            window.settingsPanel.hide();
        }

        if (!awaitSave) {
            // Fire-and-forget path — used when navigating away from an
            // aux mode. Clears the UI immediately so the user gets an
            // instant transition; the context save runs in the
            // background. saveCurrentContext snapshots
            // conversationHistory synchronously before its first await,
            // so clearing right after is safe (the snapshot has already
            // captured what it needs).
            if (this.conversationHistory.length > 0) {
                this.saveCurrentContext().catch(err => {
                    console.error('Failed to save current context (background):', err);
                    try {
                        this.showNotification?.(
                            (window.i18n && window.i18n.t && window.i18n.t('conversations.saveFailed'))
                                || 'Failed to save the conversation. Try again.',
                            'error'
                        );
                    } catch (_) { /* ignore */ }
                });
            }
            this.currentContextId = null;
            this.clearChat();
            this.userInput.focus();
            this.renderContextsList();
            return;
        }

        // Default path: await save (preserves ordering for direct
        // "New Chat" button clicks where the user is staying put).
        if (this.conversationHistory.length > 0) {
            try {
                await this.saveCurrentContext();
            } catch (err) {
                console.error('Failed to save current context:', err);
                // Don't block the new chat creation if save fails
            }
        }

        // Clear current context
        this.currentContextId = null;
        this.clearChat();
        this.userInput.focus();

        // Update active context in sidebar
        this.renderContextsList();
    }

    /**
     * Load a specific context
     */
    async loadContext(contextId) {
        // Close settings panel if open
        if (window.settingsPanel?.isActive) {
            window.settingsPanel.hide();
        }

        // Auto-save current context before loading new one
        if (this.conversationHistory.length > 0 && this.currentContextId !== contextId) {
            await this.saveCurrentContext();
        }

        try {
            const response = await fetch(window.apiUrl(`/contexts/${contextId}`), {
                headers: this.getAuthHeaders()
            });

            // Check for 401 Unauthorized - redirect to login
            if (response.status === 401) {
                window.location.href = 'login.html';
                return;
            }

            const data = await response.json();

            if (data.success && data.data) {
                const context = data.data;

                // Clear current chat
                this.messagesContainer.innerHTML = '';

                // Drop any attachments from the previous conversation —
                // they don't belong to the loaded one. (Phase B will hydrate
                // attachments from the saved context if/when we persist them.)
                this.pendingAttachments = [];
                this.renderAttachmentChips();

                // Load messages (with safety check for null context_data)
                const messages = (context.context_data && context.context_data.messages) || [];
                this.conversationHistory = [];

                for (const msg of messages) {
                    this.addMessage(msg.role, msg.content, false, msg.provider);
                    this.conversationHistory.push({
                        role: msg.role,
                        content: msg.content,
                        provider: msg.provider
                    });
                }

                // Fix SVG viewBoxes after all archived messages are in the DOM
                // (same post-processing as updateMessage() does for live streaming)
                this.fixAllSVGsInContainer(this.messagesContainer);

                // Same for mermaid blocks — diagrams persisted in past contexts.
                if (typeof window.renderMermaidIn === 'function') {
                    window.renderMermaidIn(this.messagesContainer);
                }

                // Set current context ID
                this.currentContextId = contextId;

                // Update sidebar to show active context
                this.renderContextsList();
            } else {
                this.showNotification(window.i18n.t('conversations.loadFailed'), 'error');
            }
        } catch (error) {
            console.error('Error loading context:', error);
            this.showNotification(window.i18n.t('conversations.loadError'), 'error');
        }
    }

    /**
     * Delete a context
     */
    async deleteContext(contextId) {
        const confirmed = confirm(window.i18n.t('conversations.deleteConfirm'));
        if (!confirmed) return;

        try {
            const response = await fetch(window.apiUrl(`/contexts/${contextId}`), {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            // Check for 401 Unauthorized - redirect to login
            if (response.status === 401) {
                window.location.href = 'login.html';
                return;
            }

            const data = await response.json();

            if (data.success) {
                // If deleted context was the current one, clear chat
                if (this.currentContextId === contextId) {
                    this.currentContextId = null;
                    this.clearChat();
                }

                // Reload contexts list
                await this.loadContextsList();

                this.showNotification(window.i18n.t('conversations.deletedSuccess'), 'success');
            } else {
                this.showNotification(window.i18n.t('conversations.deleteFailed'), 'error');
            }
        } catch (error) {
            console.error('Error deleting context:', error);
            this.showNotification(window.i18n.t('conversations.deleteError'), 'error');
        }
    }

    /**
     * Show conversation context menu
     */
    showConversationMenu(event, contextId) {
        event.preventDefault();
        event.stopPropagation();

        this.currentConversationMenuId = contextId;

        const menu = this.conversationContextMenu;

        // Position menu at cursor
        menu.style.left = event.pageX + 'px';
        menu.style.top = event.pageY + 'px';
        menu.classList.remove('hidden');
    }

    /**
     * Hide conversation context menu
     */
    hideConversationMenu() {
        this.conversationContextMenu.classList.add('hidden');
    }

    /**
     * Handle conversation context menu actions
     */
    handleConversationMenuAction(action) {
        if (!this.currentConversationMenuId) return;

        const contextId = this.currentConversationMenuId;

        switch (action) {
            case 'rename':
                this.startRenameContext(contextId);
                break;

            case 'skillify':
                this.createSkillFromConversation(contextId);
                break;

            case 'delete':
                this.deleteContext(contextId);
                break;
        }

        this.hideConversationMenu();
    }

    /**
     * L0 genesis on-ramp: one reflection call over this conversation's stored
     * context → proposal overlay (genesis-panel.js). The skills catalog is
     * client-side, so we pass name+description pairs for the merge-router.
     *
     * `contextId` here is `this.currentConversationMenuId`, which is the
     * same server context id `deleteContext`/`updateContextTitle` use
     * directly against `/contexts/{id}` — no local-store indirection.
     *
     * Catalog fields: window.skillsManager.skills entries carry `dir_name`
     * (folder/identifier, snake_case) and `name` (human title from
     * SKILL.md frontmatter, which the spec requires to match dir_name) —
     * not `dirName`. We prefer `dir_name` to match the identifier the rest
     * of chat.js sends the backend as the skill catalog key (see
     * `availableSkills` in sendMessage).
     */
    async createSkillFromConversation(contextId) {
        if (this._skillifyInFlight) {
            this.showNotification('Skill proposal already in progress…', 'info');
            return;
        }
        this._skillifyInFlight = true;
        try {
            const catalog = (window.skillsManager && Array.isArray(window.skillsManager.skills))
                ? window.skillsManager.skills.map(s => ({
                    name: s.dir_name || s.name || '',
                    description: (s.description || '').slice(0, 200),
                  })).filter(s => s.name)
                : [];
            this.showNotification(window.i18n?.t('genesis.analyzingConversation') || 'Analyzing conversation…', 'info');
            const resp = await fetch(window.apiUrl('/genesis/proposals'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ source: 'conversation', context_id: Number(contextId), catalog }),
            });
            if (resp.status === 401) {
                window.location.href = 'login.html';
                return;
            }

            const data = await resp.json();
            if (!data.success) {
                this.showNotification(`${window.i18n?.t('genesis.proposalFailed') || 'Proposal failed'}: ${data.error || 'unknown'}`, 'error');
                return;
            }
            window.genesisSystem.showProposal(data.promotion); // null → "no procedure" toast
        } catch (e) {
            console.error('[genesis] createSkillFromConversation failed:', e);
            this.showNotification(window.i18n?.t('genesis.proposalFailed') || 'Proposal failed', 'error');
        } finally {
            this._skillifyInFlight = false;
        }
    }

    /**
     * L0 genesis on-ramp: prompt-library variant of createSkillFromConversation.
     * Same in-flight guard (shared flag — only one proposal reflection at a
     * time regardless of source), same catalog mapper, same 401/error
     * handling. `promptId` is the saved-prompt row id (node.id from the
     * prompt tree), not a context id.
     */
    async createSkillFromPrompt(promptId) {
        if (this._skillifyInFlight) {
            this.showNotification('Skill proposal already in progress…', 'info');
            return;
        }
        this._skillifyInFlight = true;
        try {
            const catalog = (window.skillsManager && Array.isArray(window.skillsManager.skills))
                ? window.skillsManager.skills.map(s => ({
                    name: s.dir_name || s.name || '',
                    description: (s.description || '').slice(0, 200),
                  })).filter(s => s.name)
                : [];
            this.showNotification(window.i18n?.t('genesis.analyzingPrompt') || 'Analyzing prompt…', 'info');
            const resp = await fetch(window.apiUrl('/genesis/proposals'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ source: 'prompt', prompt_id: Number(promptId), catalog }),
            });
            if (resp.status === 401) {
                window.location.href = 'login.html';
                return;
            }

            const data = await resp.json();
            if (!data.success) {
                this.showNotification(`${window.i18n?.t('genesis.proposalFailed') || 'Proposal failed'}: ${data.error || 'unknown'}`, 'error');
                return;
            }
            window.genesisSystem.showProposal(data.promotion); // null → "no procedure" toast
        } catch (e) {
            console.error('[genesis] createSkillFromPrompt failed:', e);
            this.showNotification(window.i18n?.t('genesis.proposalFailed') || 'Proposal failed', 'error');
        } finally {
            this._skillifyInFlight = false;
        }
    }

    /**
     * Start renaming a conversation (inline editing)
     */
    startRenameContext(contextId) {
        // Find the context title element
        const titleElement = document.querySelector(`.context-title[data-context-id="${contextId}"]`);
        if (!titleElement) return;

        const currentTitle = titleElement.textContent;

        // Replace with input
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-xs font-medium text-gray-800 w-full px-1 border border-blue-500 rounded';
        input.value = currentTitle;
        input.style.outline = 'none';

        titleElement.replaceWith(input);
        input.focus();
        input.select();

        let isProcessing = false; // Flag to prevent duplicate calls

        // Save on Enter
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (isProcessing) return; // Prevent duplicate calls
                isProcessing = true;

                const newTitle = input.value.trim();
                if (newTitle && newTitle !== currentTitle) {
                    await this.updateContextTitle(contextId, newTitle);
                } else {
                    await this.loadContextsList();
                }
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                if (isProcessing) return;
                isProcessing = true;
                await this.loadContextsList();
            }
        });

        // Save on blur (only if not already processing)
        input.addEventListener('blur', async () => {
            if (isProcessing) return; // Prevent duplicate calls
            isProcessing = true;

            const newTitle = input.value.trim();
            if (newTitle && newTitle !== currentTitle) {
                await this.updateContextTitle(contextId, newTitle);
            } else {
                await this.loadContextsList();
            }
        });

        // Prevent clicking the input from triggering loadContext
        input.addEventListener('click', (e) => {
            e.stopPropagation();
        });
    }

    /**
     * Update conversation title via API
     */
    async updateContextTitle(contextId, newTitle) {
        try {
            const response = await fetch(window.apiUrl(`/contexts/${contextId}`), {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({ title: newTitle })
            });

            if (response.status === 401) {
                window.location.href = 'login.html';
                return;
            }

            const data = await response.json();

            if (data.success) {
                await this.loadContextsList();
                this.showNotification(window.i18n.t('conversations.renamedSuccess'), 'success');
            } else {
                this.showNotification(window.i18n.t('conversations.renameFailed'), 'error');
                await this.loadContextsList();
            }
        } catch (error) {
            console.error('Error updating context title:', error);
            this.showNotification(window.i18n.t('conversations.renameError'), 'error');
            await this.loadContextsList();
        }
    }

    /**
     * Save current conversation context
     * Called automatically after each assistant response
     */
    async saveCurrentContext() {
        // Don't save if no messages
        if (this.conversationHistory.length === 0) {
            return;
        }

        try {
            const requestBody = {
                id: this.currentContextId,
                messages: this.conversationHistory.map((msg, index) => ({
                    id: `msg_${Date.now()}_${index}`,
                    role: msg.role,
                    content: msg.content,
                    provider: msg.provider || this.currentProvider,
                    timestamp: new Date().toISOString()
                })),
                metadata: {
                    merge_conversations: this.mergeConversationsCheckbox?.checked || false,
                    functions_used: []
                }
            };

            const response = await fetch(window.apiUrl('/contexts'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(requestBody)
            });

            // Check for 401 Unauthorized - redirect to login
            if (response.status === 401) {
                window.location.href = 'login.html';
                return;
            }

            const data = await response.json();

            if (data.success) {
                // Update current context ID ONLY if this was a NEW context creation
                // Check the ID we SENT (requestBody.id), not current value (this.currentContextId)
                // to avoid race condition when newChat() is called during an auto-save
                if (!requestBody.id && data.data?.id) {
                    this.currentContextId = data.data.id;
                }

                // Refresh contexts list in sidebar
                await this.loadContextsList();
            } else {
                // Handle specific error cases
                const errorMsg = data.message || 'Unknown error';
                console.error('❌ Failed to save context:', errorMsg);
                throw new Error(`Failed to save: ${errorMsg}`);
            }
        } catch (error) {
            console.error('❌ Error saving context:', error);
            throw error; // Re-throw to be caught by the caller
        }
    }

    // ============================================
    // PROMPT LIBRARY MANAGEMENT
    // ============================================

    /**
     * Switch between conversations, prompt library, and verifier views
     */
    switchView(view) {
        // Entering Compare or Verifier mode from any OTHER mode starts
        // a fresh conversation in the primary pane. Keeping a stale
        // history from Conversations / a prior session would put the
        // left pane out of sync with the right (which starts clean
        // every time) and is confusing. Saved conversations remain in
        // the Conversations list — only the active chat is reset.
        const enteringCompare = view === 'compare' && this.currentView !== 'compare';
        const enteringVerifier = view === 'verifier' && this.currentView !== 'verifier';
        if ((enteringCompare || enteringVerifier)
            && Array.isArray(this.conversationHistory)
            && this.conversationHistory.length > 0) {
            // Clear UI instantly; save runs in the background.
            this.newChat({ awaitSave: false });
        }

        // UX RULE — auxiliary modes (compare / verify) reset only when
        // the user returns to Conversations. Visiting Skills, Workflows,
        // Prompt Library, or File Storage preserves compare/verify so
        // the user can grab content from those views and come back to a
        // chat with the auxiliary mode still configured.
        // Detect that we're about to leave an aux mode. The reciprocal
        // of step 1: when exiting compare/verify (mode actually turns
        // off), don't keep the left-pane context. The session is
        // auto-saved into the Conversations list by newChat(), then the
        // active chat is wiped so Conversations starts empty.
        const leavingCompare = view === 'conversations' && this.compareEnabled;
        const leavingVerifier = view === 'conversations' && this.verificationEnabled;
        if ((leavingCompare || leavingVerifier)
            && Array.isArray(this.conversationHistory)
            && this.conversationHistory.length > 0) {
            // Clear UI instantly; save runs in the background.
            this.newChat({ awaitSave: false });
        }
        if (view === 'conversations' && this.compareEnabled) {
            this.compareEnabled = false;
            // Keep `selectedComparer` set — we use it as the "preferred"
            // comparer to auto-restore the next time the user navigates
            // to the Compare view. Only the active-mode flag is dropped.
            if (this.compareToggle) this.compareToggle.checked = false;
            if (typeof this.hideCompareSplitPane === 'function') {
                this.hideCompareSplitPane();
            }
            // Tear down any leftover artifact panes from a compare-skill turn.
            if (this.messagesWrapper) {
                this.messagesWrapper.classList.remove('compare-artifacts-mode');
            }
            if (this.artifactPane) {
                this.artifactPane.style.flex = '';
                this.artifactPane.classList.add('hidden');
                if (this.artifactPaneContent) this.artifactPaneContent.innerHTML = '';
            }
            if (this.compareArtifactPane) {
                this.compareArtifactPane.style.flex = '';
                this.compareArtifactPane.classList.add('hidden');
                if (this.compareArtifactPaneContent) this.compareArtifactPaneContent.innerHTML = '';
            }
            this.saveCompareState();
        }
        if (view === 'conversations' && this.verificationEnabled) {
            this.verificationEnabled = false;
            // Same logic as compare: keep `selectedVerifier` so the next
            // Verifier nav click can restore the mode without a re-pick.
            if (this.verifierToggle) this.verifierToggle.checked = false;
            if (typeof this.hideSplitPane === 'function') {
                this.hideSplitPane();
            }
            this.saveVerifierState?.();
        }
        // Clicking the Compare / Verifier nav is the user expressing
        // "I want this mode on" — show the split layout immediately.
        // If a comparer/verifier was previously chosen, restore it; if
        // not, auto-pick the first available non-primary provider so
        // the user gets a working split layout without an extra click.
        if (view === 'compare' && !this.compareEnabled) {
            if (!this.selectedComparer) {
                const candidate = (this.providers || []).find(p =>
                    p && p.available
                    && p.name !== this.currentProvider
                    && p.name !== 'evi'
                );
                if (candidate) this.selectedComparer = candidate.name;
            }
            if (this.selectedComparer) {
                this.compareEnabled = true;
                if (this.compareToggle) this.compareToggle.checked = true;
                if (typeof this.showCompareSplitPane === 'function') {
                    this.showCompareSplitPane();
                }
                this.saveCompareState();
            }
        }
        if (view === 'verifier' && !this.verificationEnabled) {
            if (!this.selectedVerifier) {
                const candidate = (this.providers || []).find(p =>
                    p && p.available
                    && p.name !== this.currentProvider
                    && p.name !== 'evi'
                );
                if (candidate) this.selectedVerifier = candidate.name;
            }
            if (this.selectedVerifier) {
                this.verificationEnabled = true;
                if (this.verifierToggle) this.verifierToggle.checked = true;
                if (typeof this.showSplitPane === 'function') {
                    this.showSplitPane();
                }
                this.saveVerifierState?.();
            }
        }
        this.syncAuxModeIndicators();

        this.currentView = view;
        this.syncRailActive();

        // Close settings panel if open
        if (window.settingsPanel?.isActive) {
            window.settingsPanel.hide();
        }

        // Hide all views and deactivate all nav buttons
        this.conversationsView.classList.add('hidden');
        this.promptLibraryView.classList.add('hidden');
        this.verifierView.classList.add('hidden');
        this.compareView.classList.add('hidden');
        if (this.skillsView) this.skillsView.classList.add('hidden');
        if (this.agentTeamsView) this.agentTeamsView.classList.add('hidden');
        if (this.agentsView) this.agentsView.classList.add('hidden');
        if (this.fileStorageView) this.fileStorageView.classList.add('hidden');
        this.navConversations.classList.remove('active');
        this.navPromptLibrary.classList.remove('active');
        this.navVerifier.classList.remove('active');
        this.navCompare.classList.remove('active');
        if (this.navSkills) this.navSkills.classList.remove('active');
        if (this.navAgentTeams) this.navAgentTeams.classList.remove('active');
        if (this.navAgents) this.navAgents.classList.remove('active');
        if (this.navFileStorage) this.navFileStorage.classList.remove('active');

        if (view === 'conversations') {
            this.conversationsView.classList.remove('hidden');
            this.navConversations.classList.add('active');
        } else if (view === 'prompts') {
            this.promptLibraryView.classList.remove('hidden');
            this.navPromptLibrary.classList.add('active');

            // Load prompt library if not already loaded
            if (this.promptLibrary.length === 0) {
                this.loadPromptLibrary();
            }
        } else if (view === 'verifier') {
            this.verifierView.classList.remove('hidden');
            this.navVerifier.classList.add('active');

            // Refresh translations for verifier view
            if (window.i18n && window.i18n.updateAllTranslations) {
                window.i18n.updateAllTranslations();
            }

            // Populate verifier LLM list if providers are loaded
            if (this.providers.length > 0) {
                this.populateVerifierList();
            }
        } else if (view === 'compare') {
            this.compareView.classList.remove('hidden');
            this.navCompare.classList.add('active');

            // Refresh translations for compare view
            if (window.i18n && window.i18n.updateAllTranslations) {
                window.i18n.updateAllTranslations();
            }

            // Populate compare LLM list if providers are loaded
            if (this.providers.length > 0) {
                this.populateCompareList();
            }
        } else if (view === 'skills') {
            if (this.skillsView) {
                this.skillsView.classList.remove('hidden');
            }
            if (this.navSkills) {
                this.navSkills.classList.add('active');
            }

            // Load skills tree
            if (window.skillsManager) {
                window.skillsManager.loadTree();
            }

            // Refresh translations
            if (window.i18n && window.i18n.updateAllTranslations) {
                window.i18n.updateAllTranslations();
            }
        } else if (view === 'agent-teams') {
            if (this.agentTeamsView) {
                this.agentTeamsView.classList.remove('hidden');
            }
            if (this.navAgentTeams) {
                this.navAgentTeams.classList.add('active');
            }

            // Synchronous spinner injection — runs the instant the click
            // handler fires, BEFORE any async work (agentTeamsPanel.show,
            // workflow fetch). Without this the user sees the static
            // "No saved workflows yet" placeholder from index.html while
            // the list is being fetched in the background.
            // Gate on _workflowsLoadedOnce so we don't flash a spinner
            // over an already-populated list on every re-click.
            const wfList = document.getElementById('workflows-list');
            if (wfList && !window.workflowEditor?._workflowsLoadedOnce) {
                wfList.innerHTML = `
                    <div class="flex items-center justify-center gap-2 text-gray-400 text-xs py-4">
                        <span class="inline-block w-3 h-3 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin"></span>
                        <span>Loading…</span>
                    </div>
                `;
            }

            // Show agent teams content panel (hides chat UI)
            if (window.agentTeamsPanel) {
                window.agentTeamsPanel.show();
            }

            // Refresh translations for agent teams view
            if (window.i18n && window.i18n.updateAllTranslations) {
                window.i18n.updateAllTranslations();
            }
        } else if (view === 'agents') {
            if (this.agentsView) {
                this.agentsView.classList.remove('hidden');
            }
            if (this.navAgents) {
                this.navAgents.classList.add('active');
            }

            // Lazy-init the agents library on first visit, then reload its tree.
            if (!window.agentsLibrary && window.AgentsLibrary) {
                window.agentsLibrary = new window.AgentsLibrary(
                    window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1',
                    () => this.getAuthHeaders(),
                    (k) => (window.i18n?.t ? window.i18n.t(k) : k),
                );
                window.agentsLibrary.init();
            }
            window.agentsLibrary?.loadTree();

            if (window.i18n && window.i18n.updateAllTranslations) {
                window.i18n.updateAllTranslations();
            }
        } else if (view === 'file-storage') {
            if (this.fileStorageView) {
                this.fileStorageView.classList.remove('hidden');
            }
            if (this.navFileStorage) {
                this.navFileStorage.classList.add('active');
            }

            // Load file storage content
            if (window.fileStorageManager) {
                window.fileStorageManager.show();
            }

            // Refresh translations
            if (window.i18n && window.i18n.updateAllTranslations) {
                window.i18n.updateAllTranslations();
            }
        }

        // Hide agent teams content panel when switching to other views.
        //
        // Exception: when the user switches the sidebar to 'agents' or
        // 'skills' while the workflow canvas is already up, KEEP the canvas
        // visible. Agents AND skills are drag-dropped FROM their sidebar lists
        // ONTO the workflow canvas (skills bind to a node), so the canvas must
        // stay onscreen across that switch. The guard below is gated on
        // agentTeamsPanel.isActive, so from plain chat (no workflow up)
        // selecting Skills behaves as before. Any other view (conversations,
        // settings, file-storage) still hides the canvas.
        const KEEPS_WORKFLOW_CANVAS_VISIBLE = new Set(['agent-teams', 'agents', 'skills']);
        if (!KEEPS_WORKFLOW_CANVAS_VISIBLE.has(view) && window.agentTeamsPanel && window.agentTeamsPanel.isActive) {
            window.agentTeamsPanel.hide();
        }

        // Hide file storage content panel when switching to other views
        if (view !== 'file-storage' && window.fileStorageManager && window.fileStorageManager.isActive) {
            window.fileStorageManager.hide();
        }
    }

    /**
     * Load prompt library tree from backend
     */
    async loadPromptLibrary() {
        try {
            const response = await fetch(window.apiUrl('/prompts'), {
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success) {
                this.promptLibrary = data.data || [];

                // If library is empty, create a default root folder
                if (this.promptLibrary.length === 0) {
                    await this.createDefaultRootFolder();
                    // Reload the library to get the newly created folder
                    const reloadResponse = await fetch(window.apiUrl('/prompts'), {
                        headers: this.getAuthHeaders()
                    });
                    const reloadData = await reloadResponse.json();
                    if (reloadData.success) {
                        this.promptLibrary = reloadData.data || [];
                    }
                }

                this.renderPromptTree();
            } else {
                console.error('❌ Failed to load prompt library:', data.message);
            }
        } catch (error) {
            console.error('❌ Error loading prompt library:', error);
        }
    }

    /**
     * Create a default root folder when the library is empty
     */
    async createDefaultRootFolder() {
        try {
            const response = await fetch(window.apiUrl('/prompts'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    parent_id: null,
                    type: 'folder',
                    name: 'My Prompts',
                    content: null
                })
            });

            const data = await response.json();
            if (data.success) {
                console.log('✅ Default root folder created');
            } else {
                console.error('❌ Failed to create default folder:', data.message);
            }
        } catch (error) {
            console.error('❌ Error creating default folder:', error);
        }
    }

    /**
     * Render prompt library tree - Vristo style
     */
    renderPromptTree() {
        if (this.promptLibrary.length === 0) {
            this.promptTree.innerHTML = `
                <div class="text-center text-gray-400 text-xs py-6">
                    No prompts yet. Right-click to add folders and prompts.
                </div>
            `;
            return;
        }

        const ul = document.createElement('ul');
        ul.className = 'font-semibold';
        this.renderTreeNodes(this.promptLibrary, ul);

        this.promptTree.innerHTML = '';
        this.promptTree.appendChild(ul);
    }

    /**
     * Recursively render tree nodes - Vristo style
     */
    renderTreeNodes(nodes, parentElement) {
        nodes.forEach(node => {
            const li = document.createElement('li');

            if (node.type === 'folder') {
                // Folder with expand/collapse
                const button = this.createFolderButton(node);
                li.appendChild(button);

                // Children container
                if (node.children && node.children.length > 0) {
                    const childrenUl = document.createElement('ul');
                    childrenUl.className = 'tree-children ' + (this.expandedFolders.has(node.id) ? 'expanded' : 'collapsed');
                    childrenUl.id = `children-${node.id}`;
                    this.renderTreeNodes(node.children, childrenUl);
                    li.appendChild(childrenUl);
                }
            } else {
                // Prompt item
                const item = this.createPromptItem(node);
                li.appendChild(item);
            }

            parentElement.appendChild(li);
        });
    }

    /**
     * Create folder button element
     */
    createFolderButton(node) {
        const button = document.createElement('button');
        button.type = 'button';
        // Folders highlight when SELECTED (clicking a folder selects it as
        // the target for "Save Prompt"). currentPromptId only ever points
        // at a prompt leaf, so it never matched a folder id anyway.
        button.className = 'tree-node' + (node.id === this.selectedPromptFolderId ? ' active' : '');
        button.dataset.nodeId = node.id;
        button.dataset.nodeType = node.type;

        const isExpanded = this.expandedFolders.has(node.id);
        const hasChildren = node.children && node.children.length > 0;

        button.innerHTML = `
            ${hasChildren ? `
                <svg class="tree-chevron ${isExpanded ? 'expanded' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                </svg>
            ` : '<span style="width: 12px; display: inline-block;"></span>'}
            <svg class="tree-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
            </svg>
            <span class="tree-node-name">${node.name}</span>
            <button class="tree-menu-button" data-node-menu>⋮</button>
        `;

        // Click to toggle
        button.addEventListener('click', (e) => {
            // Don't toggle if clicking the menu button
            if (e.target.closest('[data-node-menu]')) {
                e.preventDefault();
                e.stopPropagation();
                this.showContextMenu(e, node);
                return;
            }
            e.stopPropagation();
            this.toggleFolder(node.id);
            // Clicking a folder also marks it as the currently-selected
            // collection — that's what the "Save Prompt" button writes into.
            this.selectedPromptFolderId = node.id;
            this.renderPromptTree();
        });

        // Double-click to rename
        button.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.startRenameNode(node);
        });

        // Context menu
        button.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showContextMenu(e, node);
        });

        return button;
    }

    /**
     * Create prompt item element
     */
    createPromptItem(node) {
        const div = document.createElement('div');
        div.className = 'tree-item' + (node.id === this.currentPromptId ? ' active' : '');
        div.dataset.nodeId = node.id;
        div.dataset.nodeType = node.type;

        div.innerHTML = `
            <svg class="tree-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            <span class="tree-node-name">${node.name}</span>
            <button class="tree-menu-button" data-node-menu>⋮</button>
        `;

        // Click to load
        div.addEventListener('click', (e) => {
            // Don't load if clicking the menu button
            if (e.target.closest('[data-node-menu]')) {
                e.preventDefault();
                e.stopPropagation();
                this.showContextMenu(e, node);
                return;
            }
            e.stopPropagation();
            this.loadPromptIntoTextarea(node);
        });

        // Double-click to rename
        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.startRenameNode(node);
        });

        // Context menu
        div.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showContextMenu(e, node);
        });

        return div;
    }

    /**
     * Toggle folder expand/collapse
     */
    toggleFolder(folderId) {
        if (this.expandedFolders.has(folderId)) {
            this.expandedFolders.delete(folderId);
        } else {
            this.expandedFolders.add(folderId);
        }
        this.renderPromptTree();
    }

    /**
     * Load prompt content into textarea
     */
    loadPromptIntoTextarea(prompt) {
        this.userInput.value = prompt.content || '';
        this.currentPromptId = prompt.id;
        this.currentPromptName = prompt.name;
        // Loading a prompt also selects its containing folder as the
        // current collection — so a subsequent "Save Prompt" round-trips
        // into the same folder by default.
        this.selectedPromptFolderId = prompt.parent_id || null;

        // Update visual highlight
        this.renderPromptTree();

        this.showNotification(`Loaded: ${prompt.name}`, 'success');
    }

    /**
     * Show context menu at mouse position
     */
    showContextMenu(event, node) {
        event.preventDefault();
        event.stopPropagation();

        this.contextMenuNode = node;

        const menu = this.promptContextMenu;

        // Enable/disable menu items based on node type
        const getPromptBtn = menu.querySelector('[data-action="get"]');
        const savePromptBtn = menu.querySelector('[data-action="save"]');
        const skillifyBtn = menu.querySelector('[data-action="skillify"]');

        if (node.type === 'folder') {
            getPromptBtn.classList.add('disabled');
            savePromptBtn.textContent = '💾 Save Prompt (New)';
            if (skillifyBtn) skillifyBtn.classList.add('disabled');
        } else {
            getPromptBtn.classList.remove('disabled');
            savePromptBtn.textContent = '💾 Save Prompt (Update)';
            if (skillifyBtn) skillifyBtn.classList.remove('disabled');
        }

        // Position menu at cursor
        menu.style.left = event.pageX + 'px';
        menu.style.top = event.pageY + 'px';
        menu.classList.remove('hidden');
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.promptContextMenu.classList.add('hidden');
    }

    /**
     * Handle context menu actions
     */
    handleContextMenuAction(action) {
        if (!this.contextMenuNode) return;

        const node = this.contextMenuNode;

        switch (action) {
            case 'get':
                if (node.type === 'prompt') {
                    this.loadPromptIntoTextarea(node);
                }
                break;

            case 'save':
                this.handleSavePrompt(node);
                break;

            case 'skillify':
                if (node.type === 'prompt') {
                    this.createSkillFromPrompt(node.id);
                } else {
                    this.showNotification(window.i18n?.t('genesis.promptOnly') || 'Select a prompt, not a folder', 'info');
                }
                break;

            case 'rename':
                this.startRenameNode(node);
                break;

            case 'newfolder':
                this.handleNewFolder(node.id);
                break;

            case 'delete':
                this.handleDeleteNode(node);
                break;
        }

        this.hideContextMenu();
    }

    /**
     * Start renaming a node (double-click or context menu)
     */
    startRenameNode(node) {
        // Find the node element
        const nodeElement = document.querySelector(`[data-node-id="${node.id}"]`);
        if (!nodeElement) return;

        const nameSpan = nodeElement.querySelector('.tree-node-name');
        if (!nameSpan) return;

        const currentName = nameSpan.textContent;

        // Replace with input
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'node-name-input';
        input.value = currentName;

        nameSpan.replaceWith(input);
        input.focus();
        // Cursor at the end — do NOT select the text. Pre-selection makes
        // the field look "highlighted" and the first keystroke wipes the
        // user's existing name, which is the wrong default for rename
        // (vs. create, where pre-selection would make sense).
        const end = input.value.length;
        input.setSelectionRange(end, end);

        // Guard so Enter/Escape and blur don't double-fire (Enter triggers
        // a re-render → input is removed → fires blur → blur handler runs
        // again). Same pattern as createEditableNode.
        let handled = false;

        // Enter → commit. Escape → cancel. Only these two trigger an
        // outcome; blur deliberately does NOT save (the user asked for
        // "edit until Enter is pressed").
        input.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (handled) return;
                handled = true;
                const newName = input.value.trim();
                if (newName && newName !== currentName) {
                    await this.renameNode(node.id, newName);
                } else {
                    await this.loadPromptLibrary();
                }
            } else if (e.key === 'Escape') {
                if (handled) return;
                handled = true;
                await this.loadPromptLibrary();
            }
        });

        // Blur → cancel (no save). If the user clicks away, the rename is
        // abandoned and the original name is restored on tree refresh.
        // This avoids "I clicked elsewhere and accidentally renamed it"
        // surprises and matches macOS Finder's file-rename behavior.
        input.addEventListener('blur', async () => {
            if (handled) return;
            handled = true;
            await this.loadPromptLibrary();
        });
    }

    /**
     * Rename a node via API
     */
    async renameNode(nodeId, newName) {
        try {
            const response = await fetch(window.apiUrl(`/prompts/${nodeId}`), {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    name: newName
                })
            });

            const data = await response.json();

            if (data.success) {
                await this.loadPromptLibrary();
                this.showNotification('Renamed successfully', 'success');
            } else {
                this.showNotification('Failed to rename', 'error');
            }
        } catch (error) {
            console.error('Error renaming node:', error);
            this.showNotification('Error renaming', 'error');
        }
    }

    /**
     * Handle save prompt action
     */
    async handleSavePrompt(node) {
        const textareaContent = this.userInput.value.trim();

        if (!textareaContent) {
            alert('Please enter some text in the prompt area first.');
            return;
        }

        if (node.type === 'folder') {
            // Create new prompt under this folder
            this.createEditableNode(node.id, 'prompt', textareaContent);
        } else {
            // Update existing prompt
            await this.updatePrompt(node.id, textareaContent);
        }
    }

    /**
     * Handle new folder action
     */
    handleNewFolder(parentId) {
        this.createEditableNode(parentId, 'folder', null);
    }

    /**
     * Handle delete node action
     */
    async handleDeleteNode(node) {
        const hasChildren = node.children && node.children.length > 0;
        const confirmMsg = hasChildren
            ? `Delete "${node.name}" and all its contents? This cannot be undone.`
            : `Delete "${node.name}"? This cannot be undone.`;

        if (!confirm(confirmMsg)) return;

        try {
            const response = await fetch(window.apiUrl(`/prompts/${node.id}`), {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });
            const data = await response.json();

            if (data.success) {
                // If deleted prompt was current, clear it
                if (this.currentPromptId === node.id) {
                    this.currentPromptId = null;
                    this.currentPromptName = null;
                }

                await this.loadPromptLibrary();
                this.showNotification(`${node.type === 'folder' ? 'Folder' : 'Prompt'} deleted`, 'success');
            } else {
                this.showNotification('Failed to delete', 'error');
            }
        } catch (error) {
            console.error('Error deleting node:', error);
            this.showNotification('Error deleting', 'error');
        }
    }

    /**
     * Create editable node (for new prompt/folder)
     */
    createEditableNode(parentId, type, content = null) {
        // Find parent node in tree
        const parentElement = parentId
            ? document.querySelector(`[data-node-id="${parentId}"]`)
            : this.promptTree;

        if (!parentElement && parentId) {
            console.error('Parent element not found');
            return;
        }

        // If parent is a folder, expand it and get children container
        let childrenContainer;
        if (parentId) {
            this.expandedFolders.add(parentId);
            childrenContainer = document.getElementById(`children-${parentId}`);
            if (!childrenContainer) {
                childrenContainer = document.createElement('div');
                childrenContainer.className = 'tree-children';
                childrenContainer.id = `children-${parentId}`;
                childrenContainer.style.display = 'block';
                parentElement.appendChild(childrenContainer);
            } else {
                childrenContainer.style.display = 'block';
            }
        } else {
            childrenContainer = this.promptTree;
        }

        // Create temporary editable node
        const tempNode = document.createElement('div');
        tempNode.className = 'tree-node editing';
        tempNode.innerHTML = `
            <span class="tree-node-toggle"></span>
            <span class="tree-node-icon">${type === 'folder' ? '📁' : '📄'}</span>
            <input type="text"
                   class="node-name-input"
                   placeholder="Enter ${type} name"
                   data-parent-id="${parentId || ''}"
                   data-type="${type}" />
        `;

        childrenContainer.insertBefore(tempNode, childrenContainer.firstChild);

        const input = tempNode.querySelector('input');
        input.focus();

        // Store content if creating prompt
        if (type === 'prompt' && content) {
            input.dataset.content = content;
        }

        // Guard: removing the input from the DOM (on Enter/Escape) also
        // fires a `blur` event on it, which would re-trigger the save
        // handler and create the same node twice. The flag is set by
        // whichever handler runs first and short-circuits the other.
        let handled = false;

        // Handle save on Enter (or cancel on Escape)
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (handled) return;
                handled = true;
                const name = input.value.trim();
                if (name) {
                    this.saveEditableNode(parentId, type, name, input.dataset.content);
                }
                tempNode.remove();
            } else if (e.key === 'Escape') {
                if (handled) return;
                handled = true;
                tempNode.remove();
            }
        });

        // Handle save on blur — only if Enter/Escape didn't already fire.
        input.addEventListener('blur', () => {
            if (handled) return;
            handled = true;
            const name = input.value.trim();
            if (name) {
                this.saveEditableNode(parentId, type, name, input.dataset.content);
            }
            tempNode.remove();
        });
    }

    /**
     * Save editable node to backend
     */
    async saveEditableNode(parentId, type, name, content = null) {
        try {
            const response = await fetch(window.apiUrl('/prompts'), {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    parent_id: parentId || null,
                    type: type,
                    name: name,
                    content: content
                })
            });

            const data = await response.json();

            if (data.success) {
                await this.loadPromptLibrary();
                this.showNotification(`${type === 'folder' ? 'Folder' : 'Prompt'} created`, 'success');
            } else {
                this.showNotification('Failed to create ' + type, 'error');
            }
        } catch (error) {
            console.error('Error creating node:', error);
            this.showNotification('Error creating ' + type, 'error');
        }
    }

    /**
     * Update existing prompt
     */
    async updatePrompt(promptId, content) {
        try {
            const response = await fetch(window.apiUrl(`/prompts/${promptId}`), {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    content: content
                })
            });

            const data = await response.json();

            if (data.success) {
                await this.loadPromptLibrary();
                this.showNotification('Prompt updated', 'success');
            } else {
                this.showNotification('Failed to update prompt', 'error');
            }
        } catch (error) {
            console.error('Error updating prompt:', error);
            this.showNotification('Error updating prompt', 'error');
        }
    }

    // ==================== Verifier Methods ====================

    /**
     * Initialize the verifier view and event listeners
     */
    initVerifierView() {
        // Set up the toggle switch listener
        if (this.verifierToggle) {
            this.verifierToggle.addEventListener('change', (e) => {
                this.toggleVerification(e.target.checked);
            });
        }

        // Load saved verifier state from localStorage
        this.loadVerifierState();
    }

    /**
     * Populate the verifier LLM list with available providers
     */
    populateVerifierList() {
        if (!this.verifierLLMList) return;

        // Filter out EVI and get available providers
        const availableProviders = this.providers.filter(p =>
            p.name !== 'evi' && p.available
        );

        if (availableProviders.length === 0) {
            this.verifierLLMList.innerHTML = `
                <div class="text-center text-gray-400 text-xs py-4">
                    ${window.i18n.t('verifier.loading')}
                </div>
            `;
            return;
        }

        this.verifierLLMList.innerHTML = '';

        availableProviders.forEach(provider => {
            const style = this.providerStyles[provider.name] || this.providerStyles.default;
            const isSelected = this.selectedVerifier === provider.name;
            const isCurrentProvider = this.currentProvider === provider.name;

            const btn = document.createElement('button');
            btn.className = `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all border ${
                isSelected
                    ? 'bg-green-100 border-green-400 text-green-800'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            } ${isCurrentProvider ? 'opacity-50' : ''}`;
            btn.disabled = isCurrentProvider;
            btn.title = isCurrentProvider ? 'Cannot use same LLM as responder and verifier' : `Select ${provider.display_name} as verifier`;

            btn.innerHTML = `
                <span class="text-base">${style.icon}</span>
                <span class="flex-1 text-left">${provider.display_name}</span>
                ${isSelected ? '<span class="text-green-600">✓</span>' : ''}
                ${isCurrentProvider ? '<span class="text-gray-400 text-xs">(active)</span>' : ''}
            `;

            if (!isCurrentProvider) {
                btn.addEventListener('click', () => this.selectVerifier(provider.name));
            }

            this.verifierLLMList.appendChild(btn);
        });
    }

    /**
     * Select a verifier LLM
     */
    selectVerifier(providerName) {
        // Toggle selection - if already selected, deselect
        if (this.selectedVerifier === providerName) {
            this.selectedVerifier = null;
            this.verificationEnabled = false;
            if (this.verifierToggle) {
                this.verifierToggle.checked = false;
            }
            // Hide split pane when deselecting
            this.hideSplitPane();
        } else {
            this.selectedVerifier = providerName;
            // Auto-enable verification when a verifier is selected
            this.verificationEnabled = true;
            if (this.verifierToggle) {
                this.verifierToggle.checked = true;
            }
            // Show split pane when selecting
            this.showSplitPane();
        }

        // Update UI
        this.populateVerifierList();
        this.updateVerifierStatus();
        this.saveVerifierState();
        this.syncAuxModeIndicators();
    }

    /**
     * Toggle verification on/off
     */
    toggleVerification(enabled) {
        if (enabled && !this.selectedVerifier) {
            // Can't enable without a selected verifier
            this.verifierToggle.checked = false;
            this.showNotification(window.i18n.t('verifier.selectToEnable'), 'warning');
            return;
        }

        this.verificationEnabled = enabled;
        this.saveVerifierState();
        this.updateVerifierStatus();

        // Toggle split pane view
        if (enabled) {
            this.showSplitPane();
        } else {
            this.hideSplitPane();
        }
        this.syncAuxModeIndicators();
    }

    /**
     * Update the verifier status display
     */
    updateVerifierStatus() {
        if (!this.verifierStatus || !this.verifierSelectedName) return;

        if (this.selectedVerifier) {
            const provider = this.providers.find(p => p.name === this.selectedVerifier);
            const displayName = provider ? provider.display_name : this.selectedVerifier;

            this.verifierSelectedName.textContent = displayName;
            this.verifierStatus.classList.remove('hidden');

            // Update status color based on enabled state
            if (this.verificationEnabled) {
                this.verifierStatus.classList.remove('bg-gray-100', 'text-gray-600');
                this.verifierStatus.classList.add('bg-green-50', 'text-green-700');
            } else {
                this.verifierStatus.classList.remove('bg-green-50', 'text-green-700');
                this.verifierStatus.classList.add('bg-gray-100', 'text-gray-600');
            }
        } else {
            this.verifierStatus.classList.add('hidden');
        }
    }

    /**
     * Save verifier state to localStorage
     */
    saveVerifierState() {
        try {
            localStorage.setItem('verifierState', JSON.stringify({
                selectedVerifier: this.selectedVerifier,
                verificationEnabled: this.verificationEnabled,
                splitPaneRatio: this.splitPaneRatio
            }));
        } catch (e) {
            console.warn('Could not save verifier state:', e);
        }
    }

    /**
     * Load verifier state from localStorage
     */
    loadVerifierState() {
        try {
            const saved = localStorage.getItem('verifierState');
            if (saved) {
                const state = JSON.parse(saved);
                // Same rule as loadCompareState: keep the remembered
                // verifier so the Verifier nav can auto-restore it, but
                // start the session with the mode OFF since the default
                // landing view is Conversations.
                this.selectedVerifier = state.selectedVerifier || null;
                this.verificationEnabled = false;
                this.splitPaneRatio = state.splitPaneRatio || 0.5;
                if (this.verifierToggle) {
                    this.verifierToggle.checked = false;
                }
                this.syncAuxModeIndicators();
            }
        } catch (e) {
            console.warn('Could not load verifier state:', e);
        }
    }

    // ==================== Split Pane Methods ====================

    /**
     * Initialize split pane divider drag functionality
     */
    initSplitPaneDivider() {
        if (!this.splitPaneDivider) return;

        let startX = 0;
        let startWidth = 0;

        const onMouseDown = (e) => {
            e.preventDefault();
            this.isResizingSplitPane = true;
            startX = e.clientX || e.touches?.[0]?.clientX || 0;
            startWidth = this.primaryPane.getBoundingClientRect().width;

            document.body.classList.add('split-resizing');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.addEventListener('touchmove', onMouseMove, { passive: false });
            document.addEventListener('touchend', onMouseUp);
        };

        const onMouseMove = (e) => {
            if (!this.isResizingSplitPane) return;
            e.preventDefault();

            const clientX = e.clientX || e.touches?.[0]?.clientX || 0;
            const delta = clientX - startX;
            const wrapperWidth = this.messagesWrapper.getBoundingClientRect().width;
            const dividerWidth = this.splitPaneDivider.getBoundingClientRect().width;

            // Calculate new width with constraints
            let newWidth = startWidth + delta;
            const minWidth = 300;
            const maxWidth = wrapperWidth - minWidth - dividerWidth;

            newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));

            // Apply the new width
            this.primaryPane.style.width = `${newWidth}px`;
            this.messagesWrapper.style.setProperty('--primary-pane-width', `${newWidth}px`);

            // Calculate and store ratio
            this.splitPaneRatio = newWidth / wrapperWidth;
        };

        const onMouseUp = () => {
            this.isResizingSplitPane = false;
            document.body.classList.remove('split-resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('touchmove', onMouseMove);
            document.removeEventListener('touchend', onMouseUp);

            // Save the ratio
            this.saveVerifierState();
        };

        this.splitPaneDivider.addEventListener('mousedown', onMouseDown);
        this.splitPaneDivider.addEventListener('touchstart', onMouseDown, { passive: false });
    }

    /**
     * Drag-resize the divider between the two artifact panes (compare-
     * skill 2-iframe mode). Mirrors initSplitPaneDivider's pattern but
     * targets a different divider/pane pair. The left pane (#artifact-
     * pane) gets a pinned inline width via flex:0 0 <px>; the right pane
     * (#compare-artifact-pane) keeps flex:1 so it absorbs the remaining
     * width. Constrained by min-width (200px each side) so the user
     * can't drag a pane completely off-screen. Touch + mouse supported.
     */
    initCompareArtifactsDivider() {
        if (!this.compareArtifactsDivider) return;
        if (!this.artifactPane || !this.compareArtifactPane || !this.messagesWrapper) return;

        let startX = 0;
        let startLeftWidth = 0;
        let isResizing = false;

        const onMouseDown = (e) => {
            e.preventDefault();
            isResizing = true;
            startX = e.clientX || e.touches?.[0]?.clientX || 0;
            startLeftWidth = this.artifactPane.getBoundingClientRect().width;
            document.body.classList.add('split-resizing');
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.addEventListener('touchmove', onMouseMove, { passive: false });
            document.addEventListener('touchend', onMouseUp);
        };

        const onMouseMove = (e) => {
            if (!isResizing) return;
            e.preventDefault();
            const clientX = e.clientX || e.touches?.[0]?.clientX || 0;
            const delta = clientX - startX;
            const wrapperWidth = this.messagesWrapper.getBoundingClientRect().width;
            const dividerWidth = this.compareArtifactsDivider.getBoundingClientRect().width;
            const minPane = 200;
            const maxLeftWidth = wrapperWidth - minPane - dividerWidth;
            let newLeftWidth = startLeftWidth + delta;
            newLeftWidth = Math.max(minPane, Math.min(maxLeftWidth, newLeftWidth));
            // Pin left pane via flex shorthand, let right absorb the rest.
            this.artifactPane.style.flex = `0 0 ${newLeftWidth}px`;
        };

        const onMouseUp = () => {
            isResizing = false;
            document.body.classList.remove('split-resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.removeEventListener('touchmove', onMouseMove);
            document.removeEventListener('touchend', onMouseUp);
        };

        this.compareArtifactsDivider.addEventListener('mousedown', onMouseDown);
        this.compareArtifactsDivider.addEventListener('touchstart', onMouseDown, { passive: false });
    }

    /**
     * Show the split pane view (verification enabled)
     */
    showSplitPane() {
        if (!this.messagesWrapper || !this.verifierPane) return;

        // Disable compare if it's enabled (mutual exclusivity)
        if (this.compareEnabled) {
            this.compareEnabled = false;
            this.selectedComparer = null;
            if (this.compareToggle) {
                this.compareToggle.checked = false;
            }
            this.comparePane.classList.add('hidden');
            this.saveCompareState();
            this.updateCompareStatus();
            this.populateCompareList();
        }

        this.splitPaneActive = true;
        this.activeSplitMode = 'verifier';
        this.updateVerifyLastBtnVisibility();
        this.updateCompareLastBtnVisibility();

        // Apply saved ratio
        const wrapperWidth = this.messagesWrapper.getBoundingClientRect().width;
        const primaryWidth = wrapperWidth * this.splitPaneRatio;
        this.messagesWrapper.style.setProperty('--primary-pane-width', `${primaryWidth}px`);

        // Show split pane elements
        this.messagesWrapper.classList.add('split-active');
        this.verifierPane.classList.remove('hidden');
        this.splitPaneDivider.classList.remove('hidden');

        // Show primary pane header
        if (this.primaryPaneHeader) {
            this.primaryPaneHeader.classList.remove('hidden');
        }

        // Update provider badges
        this.updateSplitPaneBadges();

        // Clear verifier messages for fresh start
        this.clearVerifierMessages();
    }

    /**
     * Hide the split pane view (verification disabled)
     */
    hideSplitPane() {
        if (!this.messagesWrapper || !this.verifierPane) return;

        this.splitPaneActive = false;
        this.activeSplitMode = null;
        this.updateVerifyLastBtnVisibility();
        this.updateCompareLastBtnVisibility();

        // Hide split pane elements
        this.messagesWrapper.classList.remove('split-active');
        this.verifierPane.classList.add('hidden');
        this.splitPaneDivider.classList.add('hidden');

        // Hide primary pane header if compare is also not active
        if (this.primaryPaneHeader && !this.compareEnabled) {
            this.primaryPaneHeader.classList.add('hidden');
        }

        // Reset primary pane width
        this.primaryPane.style.width = '';
    }

    /**
     * Update the provider badges in the split pane headers
     */
    updateSplitPaneBadges() {
        // Primary provider badge
        if (this.primaryProviderBadge) {
            const primaryProvider = this.providers.find(p => p.name === this.currentProvider);
            this.primaryProviderBadge.textContent = primaryProvider ? primaryProvider.display_name : this.currentProvider;
        }

        // Verifier provider badge
        if (this.verifierProviderBadge) {
            const verifierProvider = this.providers.find(p => p.name === this.selectedVerifier);
            this.verifierProviderBadge.textContent = verifierProvider ? verifierProvider.display_name : this.selectedVerifier || '';
        }
    }

    /**
     * Clear verifier messages container
     */
    clearVerifierMessages() {
        if (!this.verifierMessagesContainer) return;

        this.verifierMessagesContainer.innerHTML = '';

        // Add placeholder
        const placeholder = document.createElement('div');
        placeholder.id = 'verifier-placeholder';
        placeholder.className = 'flex justify-center';
        placeholder.innerHTML = `
            <div class="bg-green-50 text-green-600 px-4 py-3 rounded-lg text-sm border border-green-200">
                <div class="flex items-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                    <span data-i18n="verifier.waitingForResponse">${window.i18n?.t('verifier.waitingForResponse') || 'Waiting for primary response...'}</span>
                </div>
            </div>
        `;
        this.verifierMessagesContainer.appendChild(placeholder);
        this.verifierPlaceholder = placeholder;
    }

    /**
     * Add a message to the verifier pane
     */
    addVerifierMessage(role, content, isStreaming = false) {
        // Remove placeholder if exists
        if (this.verifierPlaceholder) {
            this.verifierPlaceholder.remove();
            this.verifierPlaceholder = null;
        }

        const msgId = 'verifier-msg-' + Date.now();

        const wrapper = document.createElement('div');
        wrapper.id = msgId;
        wrapper.className = `flex ${role === 'user' ? 'justify-end' : 'justify-start'} px-3 sm:px-4 md:px-6`;

        const bubble = document.createElement('div');
        bubble.className = role === 'user'
            ? 'bg-blue-600 text-white px-4 py-2 rounded-2xl rounded-br-md max-w-[85%]'
            : 'bg-white border border-green-200 px-4 py-2 rounded-2xl rounded-bl-md max-w-[85%] shadow-sm';

        if (isStreaming) {
            bubble.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
        } else {
            const renderedHtml = this.renderMarkdown(content);
            bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div>`;
        }

        wrapper.appendChild(bubble);
        this.verifierMessagesContainer.appendChild(wrapper);

        // Apply syntax highlighting if not streaming
        if (!isStreaming) {
            wrapper.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }

        this.scrollVerifierToBottom();

        return msgId;
    }

    /**
     * Update a verifier message
     */
    updateVerifierMessage(msgId, content, isStreaming = false) {
        const wrapper = document.getElementById(msgId);
        if (!wrapper) return;

        // Get the direct child div (the bubble), not nested divs
        const bubble = wrapper.children[0];
        if (!bubble) return;

        const renderedHtml = this.renderMarkdown(content);

        if (isStreaming) {
            bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div><span class="inline-block w-2 h-4 bg-green-500 animate-pulse ml-1"></span>`;
        } else {
            bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div>`;

            // Apply syntax highlighting to code blocks (same as primary messages)
            wrapper.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });

            // Fix SVG viewBoxes after rendering (same as primary messages)
            this.fixAllSVGsInContainer(wrapper);
        }

        this.scrollVerifierToBottom();
    }

    /**
     * Scroll verifier container to bottom
     */
    scrollVerifierToBottom() {
        if (this.verifierMessagesContainer) {
            this.verifierMessagesContainer.scrollTop = this.verifierMessagesContainer.scrollHeight;
        }
    }

    /**
     * Show verifying status in verifier pane
     */
    showVerifyingStatus() {
        // Remove placeholder
        if (this.verifierPlaceholder) {
            this.verifierPlaceholder.remove();
            this.verifierPlaceholder = null;
        }

        // Add verifying indicator
        const statusDiv = document.createElement('div');
        statusDiv.id = 'verifier-status-indicator';
        statusDiv.className = 'flex justify-center';
        statusDiv.innerHTML = `
            <div class="bg-yellow-50 text-yellow-700 px-4 py-3 rounded-lg text-sm border border-yellow-200">
                <div class="flex items-center gap-2">
                    <svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>${window.i18n?.t('verifier.verifying') || 'Verifying response...'}</span>
                </div>
            </div>
        `;
        this.verifierMessagesContainer.appendChild(statusDiv);
    }

    // ==================== Compare Methods ====================

    /**
     * Initialize the compare view and event listeners
     */
    initCompareView() {
        // Set up the toggle switch listener
        if (this.compareToggle) {
            this.compareToggle.addEventListener('change', (e) => {
                this.toggleCompare(e.target.checked);
            });
        }

        // Load saved compare state from localStorage
        this.loadCompareState();
    }

    /**
     * Populate the compare LLM list with available providers
     */
    populateCompareList() {
        if (!this.compareLLMList) return;

        // Filter out EVI and get available providers
        const availableProviders = this.providers.filter(p =>
            p.name !== 'evi' && p.available
        );

        if (availableProviders.length === 0) {
            this.compareLLMList.innerHTML = `
                <div class="text-center text-gray-400 text-xs py-4">
                    ${window.i18n.t('compare.loading')}
                </div>
            `;
            return;
        }

        this.compareLLMList.innerHTML = '';

        availableProviders.forEach(provider => {
            const style = this.providerStyles[provider.name] || this.providerStyles.default;
            const isSelected = this.selectedComparer === provider.name;
            const isCurrentProvider = this.currentProvider === provider.name;

            const btn = document.createElement('button');
            btn.className = `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all border ${
                isSelected
                    ? 'bg-blue-100 border-blue-400 text-blue-800'
                    : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
            } ${isCurrentProvider ? 'opacity-50' : ''}`;
            btn.disabled = isCurrentProvider;
            btn.title = isCurrentProvider ? 'Cannot compare with the same LLM as primary' : `Select ${provider.display_name} for comparison`;

            btn.innerHTML = `
                <span class="text-base">${style.icon}</span>
                <span class="flex-1 text-left">${provider.display_name}</span>
                ${isSelected ? '<span class="text-blue-600">✓</span>' : ''}
                ${isCurrentProvider ? '<span class="text-gray-400 text-xs">(active)</span>' : ''}
            `;

            if (!isCurrentProvider) {
                btn.addEventListener('click', () => this.selectComparer(provider.name));
            }

            this.compareLLMList.appendChild(btn);
        });
    }

    /**
     * Select a comparison LLM
     */
    selectComparer(providerName) {
        // Toggle selection - if already selected, deselect
        if (this.selectedComparer === providerName) {
            this.selectedComparer = null;
            this.compareEnabled = false;
            if (this.compareToggle) {
                this.compareToggle.checked = false;
            }
            // Hide split pane when deselecting
            this.hideCompareSplitPane();
        } else {
            this.selectedComparer = providerName;
            // Auto-enable comparison when a comparer is selected
            this.compareEnabled = true;
            if (this.compareToggle) {
                this.compareToggle.checked = true;
            }
            // Show split pane when selecting (this will also disable verifier)
            this.showCompareSplitPane();
        }

        // Update UI
        this.populateCompareList();
        this.updateCompareStatus();
        this.saveCompareState();
        this.syncAuxModeIndicators();
    }

    /**
     * Toggle comparison on/off
     */
    toggleCompare(enabled) {
        if (enabled && !this.selectedComparer) {
            // Can't enable without a selected comparer
            this.compareToggle.checked = false;
            this.showNotification(window.i18n.t('compare.selectToEnable'), 'warning');
            return;
        }

        this.compareEnabled = enabled;
        this.saveCompareState();
        this.updateCompareStatus();

        // Toggle split pane view
        if (enabled) {
            this.showCompareSplitPane();
        } else {
            this.hideCompareSplitPane();
        }
        this.syncAuxModeIndicators();
    }

    /**
     * Update the compare status display
     */
    updateCompareStatus() {
        if (!this.compareStatus || !this.compareSelectedName) return;

        if (this.selectedComparer) {
            const provider = this.providers.find(p => p.name === this.selectedComparer);
            const displayName = provider ? provider.display_name : this.selectedComparer;

            this.compareSelectedName.textContent = displayName;
            this.compareStatus.classList.remove('hidden');

            // Update status color based on enabled state
            if (this.compareEnabled) {
                this.compareStatus.classList.remove('bg-gray-100', 'text-gray-600');
                this.compareStatus.classList.add('bg-blue-50', 'text-blue-700');
            } else {
                this.compareStatus.classList.remove('bg-blue-50', 'text-blue-700');
                this.compareStatus.classList.add('bg-gray-100', 'text-gray-600');
            }
        } else {
            this.compareStatus.classList.add('hidden');
        }
    }

    /**
     * Save compare state to localStorage
     */
    saveCompareState() {
        try {
            localStorage.setItem('compareState', JSON.stringify({
                selectedComparer: this.selectedComparer,
                compareEnabled: this.compareEnabled
            }));
        } catch (e) {
            console.warn('Could not save compare state:', e);
        }
    }

    /**
     * Load compare state from localStorage
     */
    loadCompareState() {
        try {
            const saved = localStorage.getItem('compareState');
            if (saved) {
                const state = JSON.parse(saved);
                // Remember which comparer the user last picked so the
                // Compare nav can auto-restore it on click. But don't
                // auto-enable the mode on boot — the default landing view
                // is Conversations, which by rule has compare/verify off.
                // Toggling on happens via switchView('compare').
                this.selectedComparer = state.selectedComparer || null;
                this.compareEnabled = false;
                if (this.compareToggle) {
                    this.compareToggle.checked = false;
                }
                this.syncAuxModeIndicators();
            }
        } catch (e) {
            console.warn('Could not load compare state:', e);
        }
    }

    /**
     * Show the compare split pane view
     */
    showCompareSplitPane() {
        if (!this.messagesWrapper || !this.comparePane) return;

        // Disable verifier if it's enabled (mutual exclusivity)
        if (this.verificationEnabled) {
            this.verificationEnabled = false;
            this.selectedVerifier = null;
            if (this.verifierToggle) {
                this.verifierToggle.checked = false;
            }
            this.verifierPane.classList.add('hidden');
            this.saveVerifierState();
            this.updateVerifierStatus();
            this.populateVerifierList();
        }

        this.splitPaneActive = true;
        this.activeSplitMode = 'compare';
        this.updateVerifyLastBtnVisibility();
        this.updateCompareLastBtnVisibility();

        // Apply saved ratio
        const wrapperWidth = this.messagesWrapper.getBoundingClientRect().width;
        const primaryWidth = wrapperWidth * this.splitPaneRatio;
        this.messagesWrapper.style.setProperty('--primary-pane-width', `${primaryWidth}px`);

        // Show split pane elements
        this.messagesWrapper.classList.add('split-active');
        this.comparePane.classList.remove('hidden');
        this.splitPaneDivider.classList.remove('hidden');

        // Show primary pane header
        if (this.primaryPaneHeader) {
            this.primaryPaneHeader.classList.remove('hidden');
        }

        // Update provider badges
        this.updateCompareSplitPaneBadges();

        // Clear compare messages for fresh start
        this.clearCompareMessages();
    }

    /**
     * Hide the compare split pane view
     */
    hideCompareSplitPane() {
        if (!this.messagesWrapper || !this.comparePane) return;

        this.splitPaneActive = false;
        this.activeSplitMode = null;
        this.updateVerifyLastBtnVisibility();
        this.updateCompareLastBtnVisibility();

        // Hide split pane elements
        this.messagesWrapper.classList.remove('split-active');
        this.comparePane.classList.add('hidden');
        this.splitPaneDivider.classList.add('hidden');

        // Hide primary pane header if verifier is also not active
        if (this.primaryPaneHeader && !this.verificationEnabled) {
            this.primaryPaneHeader.classList.add('hidden');
        }

        // Reset primary pane width
        this.primaryPane.style.width = '';
    }

    /**
     * Update the provider badges in the compare split pane headers
     */
    updateCompareSplitPaneBadges() {
        // Primary provider badge
        if (this.primaryProviderBadge) {
            const primaryProvider = this.providers.find(p => p.name === this.currentProvider);
            this.primaryProviderBadge.textContent = primaryProvider ? primaryProvider.display_name : this.currentProvider;
        }

        // Compare provider badge
        if (this.compareProviderBadge) {
            const compareProvider = this.providers.find(p => p.name === this.selectedComparer);
            this.compareProviderBadge.textContent = compareProvider ? compareProvider.display_name : this.selectedComparer || '';
        }
    }

    /**
     * Clear compare messages container
     */
    clearCompareMessages() {
        if (!this.compareMessagesContainer) return;

        this.compareMessagesContainer.innerHTML = '';

        // Add placeholder
        const placeholder = document.createElement('div');
        placeholder.id = 'compare-placeholder';
        placeholder.className = 'flex justify-center';
        placeholder.innerHTML = `
            <div class="bg-blue-50 text-blue-600 px-4 py-3 rounded-lg text-sm border border-blue-200">
                <div class="flex items-center gap-2">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l4-4 4 4m0 6l-4 4-4-4"></path>
                    </svg>
                    <span data-i18n="compare.waitingForResponse">${window.i18n?.t('compare.waitingForResponse') || 'Generating alternative response...'}</span>
                </div>
            </div>
        `;
        this.compareMessagesContainer.appendChild(placeholder);
        this.comparePlaceholder = placeholder;
    }

    /**
     * Add a message to the compare pane
     */
    addCompareMessage(role, content, isStreaming = false) {
        // Remove placeholder if exists
        if (this.comparePlaceholder) {
            this.comparePlaceholder.remove();
            this.comparePlaceholder = null;
        }

        const msgId = 'compare-msg-' + Date.now();

        const wrapper = document.createElement('div');
        wrapper.id = msgId;
        wrapper.className = `flex ${role === 'user' ? 'justify-end' : 'justify-start'} px-3 sm:px-4 md:px-6`;

        const bubble = document.createElement('div');
        bubble.className = role === 'user'
            ? 'bg-blue-600 text-white px-4 py-2 rounded-2xl rounded-br-md max-w-[85%]'
            : 'bg-white border border-blue-200 px-4 py-2 rounded-2xl rounded-bl-md max-w-[85%] shadow-sm';

        if (isStreaming) {
            bubble.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
        } else {
            const renderedHtml = this.renderMarkdown(content);
            bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div>`;
        }

        wrapper.appendChild(bubble);
        this.compareMessagesContainer.appendChild(wrapper);

        // Apply syntax highlighting if not streaming
        if (!isStreaming) {
            wrapper.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });
        }

        this.scrollCompareToBottom();

        return msgId;
    }

    /**
     * Update a compare message
     */
    updateCompareMessage(msgId, content, isStreaming = false) {
        const wrapper = document.getElementById(msgId);
        if (!wrapper) return;

        // Get the direct child div (the bubble), not nested divs
        const bubble = wrapper.children[0];
        if (!bubble) return;

        const renderedHtml = this.renderMarkdown(content);

        if (isStreaming) {
            bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div><span class="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-1"></span>`;
        } else {
            bubble.innerHTML = `<div class="markdown-content">${renderedHtml}</div>`;

            // Apply syntax highlighting to code blocks (same as primary messages)
            wrapper.querySelectorAll('pre code').forEach((block) => {
                hljs.highlightElement(block);
            });

            // Fix SVG viewBoxes after rendering (same as primary messages)
            this.fixAllSVGsInContainer(wrapper);
        }

        this.scrollCompareToBottom();
    }

    /**
     * Scroll compare container to bottom
     */
    scrollCompareToBottom() {
        if (this.compareMessagesContainer) {
            this.compareMessagesContainer.scrollTop = this.compareMessagesContainer.scrollHeight;
        }
    }

    /**
     * Show comparing status in compare pane
     */
    showComparingStatus() {
        // Remove placeholder
        if (this.comparePlaceholder) {
            this.comparePlaceholder.remove();
            this.comparePlaceholder = null;
        }

        // Add comparing indicator
        const statusDiv = document.createElement('div');
        statusDiv.id = 'compare-status-indicator';
        statusDiv.className = 'flex justify-center';
        statusDiv.innerHTML = `
            <div class="bg-yellow-50 text-yellow-700 px-4 py-3 rounded-lg text-sm border border-yellow-200">
                <div class="flex items-center gap-2">
                    <svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>${window.i18n?.t('compare.comparing') || 'Getting alternative response...'}</span>
                </div>
            </div>
        `;
        this.compareMessagesContainer.appendChild(statusDiv);
    }

}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    window.chatApp = new ChatApp();
});
