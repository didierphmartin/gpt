/**
 * Voice Panel - UI Component for Multi-Provider Voice Interface
 * Supports: Gemini, Grok, Hume voice providers
 *
 * This class manages the voice panel UI including:
 * - Panel visibility and collapse/expand
 * - Status indicator display
 * - Transcription history rendering
 * - Audio visualizer animation
 * - Resize functionality
 * - Multi-provider voice API connection (Gemini, Grok, Hume)
 * - Audio streaming (microphone input / speaker output)
 * - Function-aware prompt generation for main chat
 */

class VoicePanel {
    constructor() {
        // DOM Elements
        this.panel = document.getElementById('voice-panel');
        this.backdrop = document.getElementById('voice-panel-backdrop');
        this.resizer = document.getElementById('voice-panel-resizer');

        // Header elements
        this.headerToggle = document.getElementById('voice-panel-toggle-header');
        this.collapseBtn = document.getElementById('voice-panel-collapse');
        this.bottomToggle = document.getElementById('voice-panel-toggle-bottom');
        this.bottomToggleIcon = document.getElementById('voice-panel-toggle-bottom-icon');

        // Status elements
        this.statusDot = document.getElementById('voice-status-dot');
        this.statusLabel = document.getElementById('voice-status-label');

        // History elements
        this.historyContainer = document.getElementById('voice-history');

        // Control elements
        this.visualizerCanvas = document.getElementById('voice-visualizer-canvas');
        this.controlStatus = document.getElementById('voice-control-status');
        this.connectBtn = document.getElementById('voice-connect-btn');
        this.connectBtnText = document.getElementById('voice-connect-btn-text');
        this.providerSelect = document.getElementById('voice-provider-select');

        // State
        this.collapsed = false;
        this.status = 'disconnected'; // disconnected, connecting, connected, error, speaking, listening
        this.isConnected = false;
        this.transcriptions = [];
        this.animationId = null;
        this.analyserData = null;

        // Resize state
        this.isResizing = false;
        this.startX = 0;
        this.startWidth = 0;

        // Voice API components (generic - supports multiple providers)
        this.voiceClient = null;
        this.activeProvider = 'gemini'; // Current provider: 'gemini', 'grok', or 'hume'
        this.audioStreamer = null;
        this.allowInterruption = true;

        // Function descriptions for prompt generation
        this.functionDescriptions = [];

        // Flag to track if current turn is the initial greeting (not a user prompt)
        this.isGreetingTurn = false;

        // Initialize
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupVisualizer();
        this.loadPanelState();
        this.setupI18n();
        this.initProviderSelector();
    }

    // i18n helper method
    t(key) {
        if (window.i18n && typeof window.i18n.t === 'function') {
            return window.i18n.t(key);
        }
        // Fallback to key if i18n not available
        return key.split('.').pop();
    }

    /**
     * Get authorization headers for API requests
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

    setupI18n() {
        // Register for language change events
        if (window.i18n && typeof window.i18n.onLanguageChange === 'function') {
            window.i18n.onLanguageChange(() => this.onLanguageChanged());
        }
    }

    onLanguageChanged() {
        // Update dynamic text based on current status
        this.setStatus(this.status);
        this.updateConnectButton();
    }

    setupEventListeners() {
        // Header toggle button (in main header)
        if (this.headerToggle) {
            this.headerToggle.addEventListener('click', () => this.toggle());
        }

        // Collapse button in panel header
        if (this.collapseBtn) {
            this.collapseBtn.addEventListener('click', () => this.collapse());
        }

        // Bottom toggle button
        if (this.bottomToggle) {
            this.bottomToggle.addEventListener('click', () => this.collapse());
        }

        // Backdrop click to close (mobile)
        if (this.backdrop) {
            this.backdrop.addEventListener('click', () => this.collapse());
        }

        // Connect button
        if (this.connectBtn) {
            this.connectBtn.addEventListener('click', () => this.handleConnectClick());
        }

        // Resize functionality
        if (this.resizer) {
            this.resizer.addEventListener('mousedown', (e) => this.startResize(e));
            document.addEventListener('mousemove', (e) => this.handleResize(e));
            document.addEventListener('mouseup', () => this.stopResize());
        }

        // Handle window resize
        window.addEventListener('resize', () => this.handleWindowResize());
    }

    setupVisualizer() {
        if (!this.visualizerCanvas) return;

        this.canvasCtx = this.visualizerCanvas.getContext('2d');
        this.visualizerContainer = this.visualizerCanvas.parentElement;
        this.resizeCanvas();

        // Hide visualizer by default (show only when active)
        this.hideVisualizer();
    }

    resizeCanvas() {
        if (!this.visualizerCanvas) return;

        const rect = this.visualizerCanvas.parentElement.getBoundingClientRect();
        this.visualizerCanvas.width = rect.width;
        this.visualizerCanvas.height = rect.height;
    }

    // Panel visibility methods
    toggle() {
        if (this.collapsed) {
            this.expand();
        } else {
            this.collapse();
        }
    }

    expand() {
        this.collapsed = false;
        this.panel.classList.remove('collapsed');
        this.headerToggle?.classList.add('active');
        this.backdrop?.classList.add('active');
        this.updateToggleIcons();
        this.savePanelState();
        this.resizeCanvas();

        // Show resizer on desktop
        if (window.innerWidth >= 1024) {
            this.resizer?.classList.remove('hidden');
        }
    }

    collapse() {
        this.collapsed = true;
        this.panel.classList.add('collapsed');
        this.headerToggle?.classList.remove('active');
        this.backdrop?.classList.remove('active');
        this.updateToggleIcons();
        this.savePanelState();

        // Hide resizer
        this.resizer?.classList.add('hidden');
    }

    updateToggleIcons() {
        const icon = this.collapsed ? '◀' : '▶';
        if (this.bottomToggleIcon) {
            this.bottomToggleIcon.textContent = icon;
        }
        if (this.collapseBtn) {
            this.collapseBtn.textContent = this.collapsed ? '◀' : '▶';
        }
    }

    // State persistence
    savePanelState() {
        try {
            localStorage.setItem('voicePanelCollapsed', JSON.stringify(this.collapsed));
            localStorage.setItem('voicePanelWidth', this.panel.style.width);
        } catch (e) {
            console.warn('Could not save voice panel state:', e);
        }
    }

    loadPanelState() {
        try {
            const collapsed = localStorage.getItem('voicePanelCollapsed');
            const width = localStorage.getItem('voicePanelWidth');

            if (collapsed !== null) {
                this.collapsed = JSON.parse(collapsed);
                if (this.collapsed) {
                    this.panel.classList.add('collapsed');
                    this.headerToggle?.classList.remove('active');
                } else {
                    this.panel.classList.remove('collapsed');
                    this.headerToggle?.classList.add('active');
                }
            } else {
                // Default: panel is expanded
                this.headerToggle?.classList.add('active');
            }

            if (width && !this.collapsed) {
                this.panel.style.width = width;
            }

            this.updateToggleIcons();
        } catch (e) {
            console.warn('Could not load voice panel state:', e);
        }
    }

    // Resize functionality
    startResize(e) {
        this.isResizing = true;
        this.startX = e.clientX;
        this.startWidth = this.panel.offsetWidth;
        document.body.classList.add('sidebar-resizing');
        e.preventDefault();
    }

    handleResize(e) {
        if (!this.isResizing) return;

        // Calculate new width (note: reversed because panel is on right)
        const diff = this.startX - e.clientX;
        const newWidth = Math.max(200, Math.min(450, this.startWidth + diff));

        this.panel.style.width = `${newWidth}px`;
        this.resizeCanvas();
    }

    stopResize() {
        if (this.isResizing) {
            this.isResizing = false;
            document.body.classList.remove('sidebar-resizing');
            this.savePanelState();
        }
    }

    handleWindowResize() {
        this.resizeCanvas();

        // Auto-collapse on small screens
        if (window.innerWidth < 1024 && !this.collapsed) {
            this.resizer?.classList.add('hidden');
        } else if (!this.collapsed) {
            this.resizer?.classList.remove('hidden');
        }
    }

    // Status management
    setStatus(status, label = null) {
        this.status = status;

        // Remove all status classes
        this.statusDot?.classList.remove('connecting', 'connected', 'error', 'speaking', 'listening');

        // Add appropriate class
        if (status !== 'disconnected') {
            this.statusDot?.classList.add(status);
        }

        // Update label using i18n
        if (this.statusLabel) {
            this.statusLabel.textContent = label || this.t(`voicePanel.status.${status}`);
        }

        // Update control status text using i18n
        const controlStatusMap = {
            disconnected: 'standby',
            connecting: 'connecting',
            connected: 'ready',
            error: 'error',
            speaking: 'speaking',
            listening: 'listening'
        };

        if (this.controlStatus) {
            const controlKey = controlStatusMap[status] || status;
            this.controlStatus.textContent = this.t(`voicePanel.controlStatus.${controlKey}`);
        }

        // Update connect button state
        this.updateConnectButton();
    }

    updateConnectButton() {
        if (!this.connectBtn || !this.connectBtnText) return;

        if (this.status === 'disconnected' || this.status === 'error') {
            this.connectBtn.classList.remove('stop');
            this.connectBtn.classList.add('start');
            this.connectBtnText.textContent = this.t('voicePanel.button.start');
            this.connectBtn.disabled = false;
            this.isConnected = false;
        } else if (this.status === 'connecting') {
            this.connectBtn.disabled = true;
            this.connectBtnText.textContent = this.t('voicePanel.button.connecting');
        } else {
            this.connectBtn.classList.remove('start');
            this.connectBtn.classList.add('stop');
            this.connectBtnText.textContent = this.t('voicePanel.button.stop');
            this.connectBtn.disabled = false;
            this.isConnected = true;
        }
    }

    handleConnectClick() {
        if (this.isConnected) {
            this.disconnect();
        } else {
            this.connect();
        }
    }

    /**
     * Fetch function descriptions from the backend
     */
    async fetchFunctionDescriptions() {
        try {
            const response = await fetch('/gpt/backend/api/v1/hume/tools/list', {
                headers: this.getAuthHeaders()
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();

            if (data.success && data.tools) {
                this.functionDescriptions = data.tools;
                console.log(`[VoicePanel] Loaded ${data.tools.length} function descriptions`);
                return data.tools;
            } else {
                console.warn('[VoicePanel] No tools found in response');
                return [];
            }
        } catch (error) {
            console.error('[VoicePanel] Failed to fetch function descriptions:', error);
            return [];
        }
    }

    /**
     * Initialize the provider selector dropdown
     */
    initProviderSelector() {
        if (!this.providerSelect) return;

        // Set initial value from config
        const currentProvider = this.getActiveProvider();
        this.providerSelect.value = currentProvider;

        // Handle provider change
        this.providerSelect.addEventListener('change', (e) => {
            const newProvider = e.target.value;
            this.setActiveProvider(newProvider);
            console.log(`[VoicePanel] Provider changed to: ${newProvider}`);
        });
    }

    /**
     * Get the active voice provider from config or localStorage
     */
    getActiveProvider() {
        // Check localStorage first (shared with Voice app)
        const storedProvider = localStorage.getItem('app-voice-provider');
        const validProviders = ['gemini', 'hume', 'grok'];
        if (storedProvider && validProviders.includes(storedProvider)) {
            // Sync to config
            if (window.APP_CONFIG?.voice) {
                window.APP_CONFIG.voice.activeProvider = storedProvider;
            }
            return storedProvider;
        }
        return window.APP_CONFIG?.voice?.activeProvider || 'gemini';
    }

    /**
     * Set the active voice provider in config and localStorage
     */
    setActiveProvider(provider) {
        if (window.APP_CONFIG?.voice) {
            window.APP_CONFIG.voice.activeProvider = provider;
        }
        // Save to localStorage for sharing with Voice app
        localStorage.setItem('app-voice-provider', provider);
        console.log('[VoicePanel] Saved voice provider to localStorage:', provider);
    }

    /**
     * Enable/disable the provider selector (disable when connected)
     */
    setProviderSelectorEnabled(enabled) {
        if (this.providerSelect) {
            this.providerSelect.disabled = !enabled;
        }
    }

    /**
     * Build the system prompt with function descriptions
     */
    async buildSystemPrompt() {
        const provider = this.getActiveProvider();
        const config = window.APP_CONFIG?.[provider] || {};
        let basePrompt = config.systemPrompt || '';

        // Fetch function descriptions if not already loaded (for Gemini which uses them)
        if (provider === 'gemini' && this.functionDescriptions.length === 0) {
            await this.fetchFunctionDescriptions();
        }

        // Build function list (primarily for Gemini)
        if (this.functionDescriptions.length > 0 && basePrompt.includes('{{FUNCTION_DESCRIPTIONS}}')) {
            const functionList = this.functionDescriptions.map(f =>
                `- ${f.name}: ${f.description}`
            ).join('\n');

            // Replace placeholder with actual function descriptions
            basePrompt = basePrompt.replace('{{FUNCTION_DESCRIPTIONS}}', functionList);
        } else {
            // No functions available, remove placeholder
            basePrompt = basePrompt.replace('{{FUNCTION_DESCRIPTIONS}}', '(No functions available)');
        }

        return basePrompt;
    }

    /**
     * Get the app's current language code
     */
    getAppLanguage() {
        if (window.i18n && typeof window.i18n.getLanguage === 'function') {
            return window.i18n.getLanguage();
        }
        return 'en';
    }

    /**
     * Get greeting instruction for Gemini based on app language
     */
    getGreetingInstruction() {
        const lang = this.getAppLanguage();

        const instructions = {
            'en': 'Greet the user warmly and ask what you can help them with today. Keep it brief and friendly.',
            'fr': 'Saluez chaleureusement l\'utilisateur en français et demandez-lui comment vous pouvez l\'aider aujourd\'hui. Soyez bref et amical.',
            'es': 'Saluda calurosamente al usuario en español y pregúntale en qué puedes ayudarle hoy. Sé breve y amable.'
        };

        return instructions[lang] || instructions['en'];
    }

    /**
     * Send initial greeting when connection is established
     */
    sendInitialGreeting() {
        if (this.voiceClient && this.voiceClient.isReady()) {
            // Mark this as a greeting turn (should not go to chat input)
            this.isGreetingTurn = true;
            const instruction = this.getGreetingInstruction();
            console.log('[VoicePanel] Sending greeting instruction:', instruction);
            this.voiceClient.sendText(instruction);
        }
    }

    /**
     * Set the generated prompt in the main chat input
     */
    setPromptInChatInput(promptText) {
        const chatInput = document.getElementById('user-input');
        if (chatInput) {
            chatInput.value = promptText;
            chatInput.focus();

            // Trigger input event so chat.js knows content changed
            chatInput.dispatchEvent(new Event('input', { bubbles: true }));

            // Auto-resize textarea if needed
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';

            console.log('[VoicePanel] Prompt set in chat input:', promptText);
        } else {
            console.warn('[VoicePanel] Chat input element not found');
        }
    }

    /**
     * Connect to voice API and start audio streaming
     * Supports multiple providers: gemini, grok, hume
     */
    async connect() {
        this.activeProvider = this.getActiveProvider();
        console.log(`[VoicePanel] Connecting to ${this.activeProvider} voice API...`);
        this.setStatus('connecting');
        this.setProviderSelectorEnabled(false);  // Disable provider selection while connected
        this.showVisualizer();

        try {
            // Get provider-specific config
            const config = window.APP_CONFIG?.[this.activeProvider] || {};
            if (!config.apiKey) {
                throw new Error(`${this.activeProvider} API key not configured`);
            }

            // Build system prompt with function descriptions
            const systemPrompt = await this.buildSystemPrompt();
            console.log('[VoicePanel] System prompt built');

            // Create AudioStreamer
            this.audioStreamer = new window.AudioStreamer({
                onAudioData: (base64Data) => {
                    // Send audio to voice provider (only if allowed)
                    if (this.voiceClient && this.voiceClient.isReady()) {
                        const canSend = this.allowInterruption || this.status !== 'speaking';
                        if (canSend) {
                            this.voiceClient.sendAudio(base64Data);
                        }
                    }
                },
                onPlaybackStart: () => {
                    this.setStatus('speaking');
                },
                onPlaybackEnd: () => {
                    if (this.isConnected) {
                        this.setStatus('listening');
                    }
                }
            });

            // Common callback handlers for all providers
            const commonCallbacks = {
                onOpen: () => {
                    console.log(`[VoicePanel] ${this.activeProvider} WebSocket connected`);
                },

                onSetupComplete: async () => {
                    console.log(`[VoicePanel] ${this.activeProvider} setup complete`);
                    try {
                        // Start microphone capture
                        await this.audioStreamer.startCapture();
                        this.setStatus('listening');
                        this.isConnected = true;
                        this.addSystemMessage(this.t('voicePanel.messages.connected') + ` (${this.activeProvider})`);
                        this.startActiveAnimation();

                        // Send initial greeting in app's language
                        this.sendInitialGreeting();
                    } catch (error) {
                        console.error('[VoicePanel] Failed to start microphone:', error);
                        this.setStatus('error');
                        this.addSystemMessage('Microphone access denied');
                        this.disconnect();
                    }
                },

                onAudio: (base64Data) => {
                    // Play received audio
                    if (this.audioStreamer) {
                        this.audioStreamer.playAudio(base64Data);
                    }
                },

                onInputTranscription: (text, isFinal) => {
                    // User's speech transcription (streaming)
                    // We'll add it to history on turnComplete
                },

                onOutputTranscription: (text, isFinal) => {
                    // AI's speech transcription (streaming)
                    // We'll add it to history on turnComplete
                },

                onTurnComplete: (userText, assistantText) => {
                    if (userText && userText.length > 1) {
                        this.addUserMessage(userText);
                    }
                    if (assistantText && assistantText.length > 1) {
                        this.addAssistantMessage(assistantText);
                    }
                    if (this.isGreetingTurn) {
                        this.isGreetingTurn = false;
                        console.log('[VoicePanel] Greeting complete, ready for user prompts');
                    }
                },

                onToolCall: async ({ name, args }) => {
                    console.log('[VoicePanel] Tool call:', name, args);
                    if (name === 'set_prompt') {
                        const text = (args?.prompt ?? '').toString().trim();
                        if (text) {
                            this.setPromptInChatInput(text);
                            return { ok: true };
                        }
                        return { ok: false, error: 'empty prompt' };
                    }
                    return { ok: false, error: `unknown tool ${name}` };
                },

                onInterrupted: () => {
                    console.log('[VoicePanel] Interrupted by user');
                    // Stop audio playback immediately
                    if (this.audioStreamer) {
                        this.audioStreamer.stopPlayback();
                    }
                    // Reset greeting flag if interrupted during greeting
                    this.isGreetingTurn = false;
                    this.setStatus('listening');
                },

                onError: (error) => {
                    console.error(`[VoicePanel] ${this.activeProvider} error:`, error);
                    this.setStatus('error');
                    this.addSystemMessage('Connection error');
                },

                onClose: () => {
                    console.log(`[VoicePanel] ${this.activeProvider} connection closed`);
                    if (this.isConnected) {
                        this.handleDisconnect();
                    }
                }
            };

            // Create provider-specific client
            if (this.activeProvider === 'grok') {
                // Grok Live Client
                if (!window.GrokLiveClient) {
                    throw new Error('GrokLiveClient not loaded. Include grok-live-client.js');
                }

                // xAI rejects raw API keys in the browser sub-protocol (WS closes with 1006).
                // Mint a short-lived ephemeral token server-side; it is the only credential
                // accepted by `xai-client-secret.<token>` from a browser.
                const tokenHeaders = { 'Content-Type': 'application/json' };
                const jwt = window.authManager?.token || localStorage.getItem('token') || localStorage.getItem('auth_token');
                if (jwt) tokenHeaders['Authorization'] = `Bearer ${jwt}`;
                const tokenResp = await fetch('/gpt/backend/api/v1/voice/token', {
                    method: 'POST',
                    headers: tokenHeaders,
                    credentials: 'include',
                    body: JSON.stringify({ provider: 'grok' })
                });
                if (!tokenResp.ok) {
                    const detail = await tokenResp.text().catch(() => '');
                    throw new Error(`Failed to mint grok ephemeral token (${tokenResp.status}): ${detail}`);
                }
                const tokenJson = await tokenResp.json();
                if (!tokenJson?.success || !tokenJson.client_secret) {
                    throw new Error(tokenJson?.error || 'Grok ephemeral token response missing client_secret');
                }

                const grokTools = [
                    {
                        type: 'function',
                        name: 'set_prompt',
                        description: 'Write the optimized English prompt into the chat input. Call this ONLY when the user explicitly asks to send/give/write the prompt. The prompt must be well-formed, specific, and directly actionable by the downstream AI assistant.',
                        parameters: {
                            type: 'object',
                            properties: {
                                prompt: {
                                    type: 'string',
                                    description: 'The optimized prompt text in English.'
                                }
                            },
                            required: ['prompt'],
                            additionalProperties: false
                        }
                    }
                ];

                this.voiceClient = new window.GrokLiveClient({
                    apiKey: tokenJson.client_secret,
                    voice: config.voice || tokenJson.voice || 'Ara',
                    systemPrompt: systemPrompt,
                    sampleRateInput: config.sampleRateInput || 16000,
                    sampleRateOutput: config.sampleRateOutput || 24000,
                    tools: grokTools,
                    ...commonCallbacks
                });
            } else if (this.activeProvider === 'hume') {
                // Hume EVI Client (TODO: implement HumeLiveClient)
                throw new Error('Hume voice client not yet implemented');
            } else {
                // Default: Gemini Live Client
                if (!window.GeminiLiveClient) {
                    throw new Error('GeminiLiveClient not loaded. Include gemini-live-client.js');
                }
                this.voiceClient = new window.GeminiLiveClient({
                    apiKey: config.apiKey,
                    model: config.model || 'gemini-2.5-flash-native-audio-preview-12-2025',
                    voiceName: config.voiceName || 'Kore',
                    systemPrompt: systemPrompt,
                    ...commonCallbacks
                });
            }

            // Connect to voice API
            await this.voiceClient.connect();

        } catch (error) {
            console.error('[VoicePanel] Connection failed:', error);
            this.setStatus('error');
            this.addSystemMessage('Failed to connect: ' + error.message);
            this.cleanup();
        }
    }

    /**
     * Disconnect from Gemini Live API
     */
    disconnect() {
        console.log('[VoicePanel] Disconnecting...');
        this.handleDisconnect();
        this.addSystemMessage(this.t('voicePanel.messages.disconnected'));
    }

    /**
     * Handle disconnection (cleanup resources)
     */
    handleDisconnect() {
        this.isConnected = false;
        this.isGreetingTurn = false;
        this.cleanup();
        this.setStatus('disconnected');
        this.setProviderSelectorEnabled(true);  // Re-enable provider selection
        this.hideVisualizer();
    }

    /**
     * Cleanup all resources
     */
    cleanup() {
        if (this.audioStreamer) {
            this.audioStreamer.cleanup();
            this.audioStreamer = null;
        }

        if (this.voiceClient) {
            this.voiceClient.disconnect();
            this.voiceClient = null;
        }
    }

    // Transcription history methods
    addUserMessage(text) {
        this.addTranscription('user', text);
    }

    addAssistantMessage(text) {
        this.addTranscription('assistant', text);
    }

    addSystemMessage(text) {
        this.addTranscription('system', text);
    }

    addTranscription(role, text) {
        const message = { role, text, timestamp: Date.now() };
        this.transcriptions.push(message);
        this.renderTranscription(message);
        this.scrollToBottom();
    }

    renderTranscription(message) {
        if (!this.historyContainer) return;

        // Clear placeholder if this is the first message
        if (this.transcriptions.length === 1) {
            this.historyContainer.innerHTML = '';
        }

        const div = document.createElement('div');
        div.className = `voice-message ${message.role}`;
        div.textContent = message.text;

        this.historyContainer.appendChild(div);
    }

    clearHistory() {
        this.transcriptions = [];
        if (this.historyContainer) {
            this.historyContainer.innerHTML = `
                <div class="text-center text-gray-400 text-xs py-8" id="voice-history-placeholder">
                    <svg class="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
                    </svg>
                    <p data-i18n="voicePanel.history.placeholder">${this.t('voicePanel.history.placeholder')}</p>
                    <p class="mt-1 text-gray-300" data-i18n="voicePanel.history.startHint">${this.t('voicePanel.history.startHint')}</p>
                </div>
            `;
        }
    }

    scrollToBottom() {
        if (this.historyContainer) {
            this.historyContainer.scrollTop = this.historyContainer.scrollHeight;
        }
    }

    // Visualizer visibility
    showVisualizer() {
        if (this.visualizerContainer) {
            this.visualizerContainer.style.display = 'block';
        }
    }

    hideVisualizer() {
        if (this.visualizerContainer) {
            this.visualizerContainer.style.display = 'none';
        }
        // Stop any running animation
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    // Visualizer animation methods
    startIdleAnimation() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }

        const animate = () => {
            this.drawIdleVisualization();
            this.animationId = requestAnimationFrame(animate);
        };

        animate();
    }

    startActiveAnimation() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }

        this.showVisualizer();

        const animate = () => {
            this.drawActiveVisualization();
            this.animationId = requestAnimationFrame(animate);
        };

        animate();
    }

    drawIdleVisualization() {
        if (!this.canvasCtx || !this.visualizerCanvas) return;

        const ctx = this.canvasCtx;
        const width = this.visualizerCanvas.width;
        const height = this.visualizerCanvas.height;

        // Clear canvas
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, width, height);

        // Draw subtle idle wave
        const time = Date.now() / 1000;
        const numBars = 32;
        const barWidth = width / numBars;
        const centerY = height / 2;

        ctx.fillStyle = '#9ca3af';

        for (let i = 0; i < numBars; i++) {
            const x = i * barWidth;
            const wave = Math.sin(time * 2 + i * 0.2) * 5 + 5;
            const barHeight = wave;

            ctx.fillRect(x + 2, centerY - barHeight / 2, barWidth - 4, barHeight);
        }
    }

    drawActiveVisualization() {
        if (!this.canvasCtx || !this.visualizerCanvas) return;

        const ctx = this.canvasCtx;
        const width = this.visualizerCanvas.width;
        const height = this.visualizerCanvas.height;

        // Clear canvas
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, width, height);

        // Draw animated bars (simulated audio visualization)
        const time = Date.now() / 1000;
        const numBars = 32;
        const barWidth = width / numBars;
        const maxBarHeight = height * 0.8;

        for (let i = 0; i < numBars; i++) {
            const x = i * barWidth;

            // Generate pseudo-random but smooth bar heights
            const wave1 = Math.sin(time * 3 + i * 0.3) * 0.3;
            const wave2 = Math.sin(time * 5 + i * 0.5) * 0.2;
            const wave3 = Math.sin(time * 7 + i * 0.7) * 0.15;
            const combined = (wave1 + wave2 + wave3 + 0.65) / 2;

            const barHeight = combined * maxBarHeight;

            // Gradient color based on height
            const hue = 220 + (i / numBars) * 30; // Blue to purple gradient
            const saturation = 70;
            const lightness = 50 + combined * 20;

            ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
            ctx.fillRect(x + 2, height - barHeight, barWidth - 4, barHeight);
        }
    }

    // Set external audio analyser for real visualizer (Goal 2)
    setAnalyser(analyser) {
        this.analyser = analyser;
        if (analyser) {
            this.analyserData = new Uint8Array(analyser.frequencyBinCount);
        }
    }

    drawRealVisualization() {
        if (!this.canvasCtx || !this.visualizerCanvas || !this.analyser) return;

        const ctx = this.canvasCtx;
        const width = this.visualizerCanvas.width;
        const height = this.visualizerCanvas.height;

        // Get audio data
        this.analyser.getByteFrequencyData(this.analyserData);

        // Clear canvas
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(0, 0, width, height);

        // Draw frequency bars
        const barCount = Math.min(32, this.analyserData.length);
        const barWidth = width / barCount;

        for (let i = 0; i < barCount; i++) {
            const value = this.analyserData[i] / 255;
            const barHeight = value * height * 0.9;
            const x = i * barWidth;

            // Gradient color based on value
            const hue = 220 + value * 30;
            ctx.fillStyle = `hsl(${hue}, 70%, ${50 + value * 20}%)`;
            ctx.fillRect(x + 2, height - barHeight, barWidth - 4, barHeight);
        }
    }

    // Cleanup
    destroy() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        this.cleanup();
    }
}

// Export for use in chat.js
window.VoicePanel = VoicePanel;
