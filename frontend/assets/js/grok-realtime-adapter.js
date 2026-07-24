/**
 * GrokRealtimeAdapter
 *
 * Provider adapter for xAI Grok Voice Agent Realtime API.
 * Implements the ProviderAdapter interface used by RealtimeWorkflowRunner.
 *
 * Protocol: WebSocket at wss://api.x.ai/v1/realtime
 * Auth: ephemeral client secret from /api/v1/voice/token
 * Based on validated spike: test-grok-realtime-tools.html
 */
class GrokRealtimeAdapter {
    constructor(config = {}) {
        this.ws = null;
        this.ready = false;
        this.backendTokenUrl = config.backendTokenUrl || window.apiUrl('/voice/token');
        this.wsUrl = 'wss://api.x.ai/v1/realtime';

        // Audio format
        this.sampleRateInput = config.sampleRateInput || 16000;
        this.sampleRateOutput = config.sampleRateOutput || 24000;

        // Usage tracking
        this.sessionId = null;
        this.audioInputBytes = 0;
        this.audioOutputBytes = 0;
        this.usageUrl = config.usageUrl || window.apiUrl('/voice/usage');

        // Callbacks (set by runner)
        this.onToolCall = null;         // (name, args, callId)
        this.onTurnComplete = null;     // ()
        this.onTranscript = null;       // (text, isFinal, direction: 'in'|'out')
        this.onAudio = null;            // (base64Data)
        this.onSessionReady = null;     // ()
        this.onInterrupted = null;      // ()
        this.onError = null;            // (error)
        this.onClose = null;            // ()

        // Internal state
        this._pendingSessionReady = null;   // resolve function for waitForSessionReady
        this._currentOutputTranscript = '';
    }

    // ================================================================
    // Connection
    // ================================================================

    /**
     * Connect to Grok Realtime API using an ephemeral token.
     */
    async connect() {
        // Fetch ephemeral token from backend
        const token = await this._fetchEphemeralToken();

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl, [`xai-client-secret.${token}`]);

            this.ws.onopen = () => {
                console.log('[GrokAdapter] WebSocket connected');
                this.ready = true;
                this.sessionId = 'grok_rt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                this.audioInputBytes = 0;
                this.audioOutputBytes = 0;
                resolve();
            };

            this.ws.onclose = (event) => {
                console.log('[GrokAdapter] WebSocket closed:', event.code);
                this.ready = false;
                if (this.onClose) this.onClose();
            };

            this.ws.onerror = (error) => {
                console.error('[GrokAdapter] WebSocket error:', error);
                if (this.onError) this.onError(error);
                reject(error);
            };

            this.ws.onmessage = (event) => {
                this._handleMessage(event.data);
            };
        });
    }

    /**
     * No-op for Grok: handoff is via mid-session session.update, so there's
     * nothing to close during the transfer-delay pause. Present only so the
     * runner can call it uniformly across providers.
     */
    beginHandoff() { /* no-op */ }

    /**
     * Disconnect and report usage.
     */
    disconnect() {
        this._reportUsage();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.ready = false;
    }

    isReady() {
        return this.ready && this.ws?.readyState === WebSocket.OPEN;
    }

    // ================================================================
    // Agent configuration (the core of handoff)
    // ================================================================

    /**
     * Push a new agent's personality, voice, and tools to the live session.
     * This is the validated session.update mechanism from the spike test.
     *
     * @param {object} agent - { name, voice, instructions }
     * @param {array} tools - Tool declarations (JSON schema format)
     * @returns {Promise} resolves when server confirms session.updated
     */
    configureAgent(agent, tools) {
        return new Promise((resolve) => {
            // Store resolve for when session.updated arrives
            this._pendingSessionReady = resolve;

            this._send({
                type: 'session.update',
                session: {
                    voice: agent.voice || 'Ara',
                    instructions: agent.instructions,
                    tools: tools,
                    turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700, prefix_padding_ms: 300 },
                    input_audio_transcription: { model: 'grok-2-public' },
                    audio: {
                        input: { format: { type: 'audio/pcm', rate: this.sampleRateInput } },
                        output: { format: { type: 'audio/pcm', rate: this.sampleRateOutput } }
                    }
                }
            });
        });
    }

    // ================================================================
    // Audio
    // ================================================================

    /**
     * Send mic audio to the provider.
     * @param {string} base64Audio - Base64-encoded PCM audio
     */
    sendAudio(base64Audio) {
        if (!this.isReady()) return;
        this.audioInputBytes += Math.floor(base64Audio.length * 0.75);
        this._send({
            type: 'input_audio_buffer.append',
            audio: base64Audio
        });
    }

    // ================================================================
    // Tool call response
    // ================================================================

    /**
     * Return a tool call result to the LLM.
     * @param {string} callId - The call_id from the tool call event
     * @param {object} result - The result object to return
     */
    returnToolResult(callId, result) {
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result)
            }
        });
    }

    /**
     * Trigger the LLM to generate a new response.
     * Called after configureAgent to make the new agent speak.
     */
    resumeAfterTool() {
        this._send({ type: 'response.create' });
    }

    /**
     * Inject a context message into the conversation as a user turn,
     * then trigger a response. Used after handoffs to tell the new agent
     * to introduce itself (the session history still has the prior agent's
     * messages, so without this nudge the new agent might just say "understood").
     *
     * @param {string} text - Context message for the new agent
     */
    injectContextAndResume(text) {
        this._send({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{
                    type: 'input_text',
                    text: text
                }]
            }
        });
        this._send({ type: 'response.create' });
    }

    // ================================================================
    // Internal: message handling
    // ================================================================

    _handleMessage(data) {
        const msg = JSON.parse(data);
        const type = msg.type;

        switch (type) {
            case 'session.created':
                console.log('[GrokAdapter] Session created');
                break;

            case 'session.updated':
                console.log('[GrokAdapter] Session updated (config confirmed)');
                if (this._pendingSessionReady) {
                    this._pendingSessionReady();
                    this._pendingSessionReady = null;
                }
                if (this.onSessionReady) this.onSessionReady();
                break;

            case 'input_audio_buffer.speech_started':
            case 'input_audio_buffer.speech_stopped':
            case 'input_audio_buffer.committed':
                break;

            case 'conversation.item.input_audio_transcription.completed':
                if (msg.transcript && this.onTranscript) {
                    this.onTranscript(msg.transcript, true, 'in');
                }
                break;

            case 'response.created':
                this._currentOutputTranscript = '';
                break;

            case 'response.output_audio.delta':
                if (msg.delta) {
                    this.audioOutputBytes += Math.floor(msg.delta.length * 0.75);
                    if (this.onAudio) this.onAudio(msg.delta);
                }
                break;

            case 'response.output_audio_transcript.delta':
                this._currentOutputTranscript += (msg.delta || '');
                break;

            case 'response.output_audio_transcript.done':
                if (this.onTranscript) {
                    const text = msg.transcript || this._currentOutputTranscript;
                    this.onTranscript(text, true, 'out');
                }
                break;

            // ===== Tool call events (the validated mechanism) =====
            case 'response.function_call_arguments.done':
                if (this.onToolCall) {
                    try {
                        const args = JSON.parse(msg.arguments || '{}');
                        this.onToolCall(msg.name, args, msg.call_id);
                    } catch (e) {
                        console.error('[GrokAdapter] Failed to parse tool call args:', e);
                    }
                }
                break;

            case 'response.done':
                if (this.onTurnComplete) this.onTurnComplete();
                break;

            case 'response.cancelled':
                if (this.onInterrupted) this.onInterrupted();
                break;

            case 'error':
                console.error('[GrokAdapter] Server error:', msg.error);
                if (this.onError) this.onError(msg.error);
                break;

            default:
                // Silently ignore known noise: rate_limits, ping, etc.
                break;
        }
    }

    // ================================================================
    // Internal: helpers
    // ================================================================

    _send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    async _fetchEphemeralToken() {
        const authToken = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

        const response = await fetch(this.backendTokenUrl, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify({ provider: 'grok' })
        });

        const data = await response.json();
        if (!data.success || !data.client_secret) {
            throw new Error(`Ephemeral token error: ${data.error || 'unknown'}`);
        }
        return data.client_secret;
    }

    async _reportUsage() {
        const inputSeconds = (this.audioInputBytes / 2) / this.sampleRateInput;
        const outputSeconds = (this.audioOutputBytes / 2) / this.sampleRateOutput;

        if (inputSeconds <= 0 && outputSeconds <= 0) return;

        const authToken = localStorage.getItem('token');
        const headers = { 'Content-Type': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

        try {
            await fetch(this.usageUrl, {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify({
                    provider: 'grok',
                    model: 'grok-2-voice',
                    session_id: this.sessionId,
                    audio_input_seconds: parseFloat(inputSeconds.toFixed(2)),
                    audio_output_seconds: parseFloat(outputSeconds.toFixed(2)),
                    input_sample_rate: this.sampleRateInput,
                    output_sample_rate: this.sampleRateOutput,
                    status: 'success'
                })
            });
        } catch (e) {
            console.error('[GrokAdapter] Usage report failed:', e);
        }
    }
}

window.GrokRealtimeAdapter = GrokRealtimeAdapter;
