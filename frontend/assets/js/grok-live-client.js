/**
 * Grok Live Client
 * WebSocket client for xAI Grok Voice Agent API
 * Endpoint: wss://api.x.ai/v1/realtime
 */

class GrokLiveClient {
    constructor(config = {}) {
        this.apiKey = config.apiKey;
        this.voice = config.voice || 'Ara';
        this.systemPrompt = config.systemPrompt || '';
        this.sampleRateInput = config.sampleRateInput || 16000;
        this.sampleRateOutput = config.sampleRateOutput || 24000;
        this.tools = Array.isArray(config.tools) ? config.tools : [];

        this.ws = null;
        this.ready = false;
        this.sessionConfigured = false;

        // In-flight function-call buffers keyed by call_id
        this.pendingFunctionCalls = {};

        // Callbacks
        this.onOpen = config.onOpen || (() => {});
        this.onClose = config.onClose || (() => {});
        this.onError = config.onError || (() => {});
        this.onAudio = config.onAudio || (() => {});
        this.onInputTranscription = config.onInputTranscription || (() => {});
        this.onOutputTranscription = config.onOutputTranscription || (() => {});
        this.onTurnComplete = config.onTurnComplete || (() => {});
        this.onInterrupted = config.onInterrupted || (() => {});
        this.onSetupComplete = config.onSetupComplete || (() => {});
        this.onToolCall = config.onToolCall || (async () => ({ ok: true }));

        // Transcription accumulators
        this.currentInputTranscript = '';
        this.currentOutputTranscript = '';

        // Usage tracking
        this.usageTrackingEnabled = config.usageTrackingEnabled !== false;
        this.backendUrl = config.backendUrl || '/gpt/backend/api/v1/voice/usage';
        this.sessionId = null;
        this.audioInputBytes = 0;
        this.audioOutputBytes = 0;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            try {
                const wsUrl = 'wss://api.x.ai/v1/realtime';

                // Use sec-websocket-protocol for auth in browser
                this.ws = new WebSocket(wsUrl, [`xai-client-secret.${this.apiKey}`]);

                this.ws.onopen = () => {
                    console.log('[GrokLive] WebSocket connected');
                    this.ready = true;

                    // Generate session ID for usage tracking
                    this.sessionId = 'grok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    this.audioInputBytes = 0;
                    this.audioOutputBytes = 0;

                    this.onOpen();
                    this.configureSession();
                    resolve();
                };

                this.ws.onclose = (event) => {
                    console.log('[GrokLive] WebSocket closed:', event.code, event.reason);
                    this.ready = false;
                    this.sessionConfigured = false;
                    this.onClose(event);
                };

                this.ws.onerror = (error) => {
                    console.error('[GrokLive] WebSocket error:', error);
                    this.onError(error);
                    reject(error);
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

            } catch (error) {
                console.error('[GrokLive] Connection error:', error);
                reject(error);
            }
        });
    }

    configureSession() {
        const session = {
            voice: this.voice,
            instructions: this.systemPrompt,
            turn_detection: { type: 'server_vad' },
            audio: {
                input: {
                    format: {
                        type: 'audio/pcm',
                        rate: this.sampleRateInput
                    }
                },
                output: {
                    format: {
                        type: 'audio/pcm',
                        rate: this.sampleRateOutput
                    }
                }
            }
        };

        if (this.tools.length > 0) {
            session.tools = this.tools;
            session.tool_choice = 'auto';
        }

        const sessionConfig = { type: 'session.update', session };

        console.log('[GrokLive] Sending session config:', sessionConfig);
        this.send(sessionConfig);
    }

    handleMessage(data) {
        try {
            const message = JSON.parse(data);
            const type = message.type;

            // console.log('[GrokLive] Received:', type, message);

            switch (type) {
                case 'session.created':
                    console.log('[GrokLive] Session created');
                    break;

                case 'session.updated':
                    console.log('[GrokLive] Session configured successfully');
                    this.sessionConfigured = true;
                    this.onSetupComplete();
                    break;

                case 'input_audio_buffer.speech_started':
                    console.log('[GrokLive] Speech started (VAD)');
                    this.currentInputTranscript = '';
                    break;

                case 'input_audio_buffer.speech_stopped':
                    console.log('[GrokLive] Speech stopped (VAD)');
                    break;

                case 'input_audio_buffer.committed':
                    console.log('[GrokLive] Audio buffer committed');
                    break;

                case 'conversation.item.input_audio_transcription.completed':
                    // Final input transcription
                    const inputText = message.transcript || '';
                    if (inputText) {
                        this.currentInputTranscript = inputText;
                        this.onInputTranscription(inputText, true);
                    }
                    break;

                case 'response.created':
                    console.log('[GrokLive] Response started');
                    this.currentOutputTranscript = '';
                    break;

                case 'response.output_audio.delta':
                    // Audio chunk received
                    const audioData = message.delta;
                    if (audioData) {
                        // Track output audio bytes for usage calculation
                        this.audioOutputBytes += Math.floor(audioData.length * 0.75);
                        this.onAudio(audioData);
                    }
                    break;

                case 'response.output_audio_transcript.delta':
                    // Partial output transcription
                    const deltaText = message.delta || '';
                    if (deltaText) {
                        this.currentOutputTranscript += deltaText;
                        this.onOutputTranscription(this.currentOutputTranscript, false);
                    }
                    break;

                case 'response.output_audio_transcript.done':
                    // Final output transcription
                    const finalText = message.transcript || this.currentOutputTranscript;
                    this.onOutputTranscription(finalText, true);
                    break;

                case 'response.output_item.added': {
                    // OpenAI-realtime emits function_call items here; seed the buffer
                    // so later .delta / .done events can be collated by call_id.
                    const item = message.item || {};
                    if (item.type === 'function_call' && item.call_id) {
                        this.pendingFunctionCalls[item.call_id] = {
                            name: item.name || '',
                            arguments: item.arguments || ''
                        };
                    }
                    break;
                }

                case 'response.function_call_arguments.delta': {
                    const callId = message.call_id;
                    if (callId) {
                        if (!this.pendingFunctionCalls[callId]) {
                            this.pendingFunctionCalls[callId] = { name: message.name || '', arguments: '' };
                        }
                        this.pendingFunctionCalls[callId].arguments += message.delta || '';
                    }
                    break;
                }

                case 'response.function_call_arguments.done': {
                    const callId = message.call_id;
                    const pending = callId ? this.pendingFunctionCalls[callId] : null;
                    const name = message.name || pending?.name || '';
                    const argsRaw = message.arguments || pending?.arguments || '';
                    if (callId) delete this.pendingFunctionCalls[callId];

                    let args = {};
                    try { args = argsRaw ? JSON.parse(argsRaw) : {}; }
                    catch (e) { console.warn('[GrokLive] Bad function args JSON:', argsRaw, e); }

                    Promise.resolve(this.onToolCall({ name, args, callId }))
                        .then((result) => this.sendToolResult(callId, result))
                        .catch((err) => {
                            console.error('[GrokLive] Tool handler error:', err);
                            this.sendToolResult(callId, { ok: false, error: String(err?.message || err) });
                        });
                    break;
                }

                case 'response.done':
                    console.log('[GrokLive] Response complete');
                    // Match Gemini signature: (userText, assistantText)
                    this.onTurnComplete(this.currentInputTranscript, this.currentOutputTranscript);
                    this.currentInputTranscript = '';
                    this.currentOutputTranscript = '';
                    break;

                case 'response.cancelled':
                    console.log('[GrokLive] Response cancelled/interrupted');
                    this.onInterrupted();
                    break;

                case 'error':
                    console.error('[GrokLive] Server error:', message.error);
                    this.onError(message.error);
                    break;

                default:
                    // Log unknown message types for debugging
                    if (type && !type.startsWith('rate_limits')) {
                        console.log('[GrokLive] Unhandled message type:', type);
                    }
            }
        } catch (error) {
            console.error('[GrokLive] Error parsing message:', error, data);
        }
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            console.warn('[GrokLive] Cannot send - WebSocket not open');
        }
    }

    sendAudio(base64Audio) {
        if (!this.isReady()) {
            console.warn('[GrokLive] Cannot send audio - not ready');
            return;
        }

        // Track input audio bytes for usage calculation
        // Base64 decodes to 3/4 the length in bytes
        this.audioInputBytes += Math.floor(base64Audio.length * 0.75);

        this.send({
            type: 'input_audio_buffer.append',
            audio: base64Audio
        });
    }

    sendText(text) {
        if (!this.isReady()) {
            console.warn('[GrokLive] Cannot send text - not ready');
            return;
        }

        // Create a conversation item with text
        this.send({
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

        // Request a response
        this.send({
            type: 'response.create'
        });
    }

    sendToolResult(callId, result) {
        if (!callId) return;
        this.send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(result ?? { ok: true })
            }
        });
        // Ask the model to continue speaking after the tool result
        this.send({ type: 'response.create' });
    }

    interrupt() {
        // Cancel ongoing response
        this.send({
            type: 'response.cancel'
        });
    }

    isReady() {
        return this.ready && this.sessionConfigured && this.ws?.readyState === WebSocket.OPEN;
    }

    disconnect() {
        // Report usage before disconnecting
        this.reportUsage();

        if (this.ws) {
            console.log('[GrokLive] Disconnecting...');
            this.ws.close();
            this.ws = null;
        }
        this.ready = false;
        this.sessionConfigured = false;
    }

    getOutputSampleRate() {
        return this.sampleRateOutput;
    }

    /**
     * Calculate audio duration in seconds from bytes
     * PCM 16-bit mono = 2 bytes per sample
     */
    calculateAudioDuration(bytes, sampleRate) {
        const bytesPerSample = 2; // 16-bit PCM
        const samples = bytes / bytesPerSample;
        return samples / sampleRate;
    }

    /**
     * Report voice usage to backend
     */
    async reportUsage(status = 'success', errorMessage = null) {
        if (!this.usageTrackingEnabled) {
            return;
        }

        const audioInputSeconds = this.calculateAudioDuration(this.audioInputBytes, this.sampleRateInput);
        const audioOutputSeconds = this.calculateAudioDuration(this.audioOutputBytes, this.sampleRateOutput);

        // Only report if there was actual audio usage
        if (audioInputSeconds <= 0 && audioOutputSeconds <= 0) {
            console.log('[GrokLive] No audio usage to report');
            return;
        }

        const usageData = {
            provider: 'grok',
            model: 'grok-2-voice',
            session_id: this.sessionId,
            audio_input_seconds: parseFloat(audioInputSeconds.toFixed(2)),
            audio_output_seconds: parseFloat(audioOutputSeconds.toFixed(2)),
            input_sample_rate: this.sampleRateInput,
            output_sample_rate: this.sampleRateOutput,
            status: status,
            error_message: errorMessage
        };

        console.log('[GrokLive] Reporting usage:', usageData);

        try {
            // Get auth token from localStorage
            const token = localStorage.getItem('token');
            const headers = {
                'Content-Type': 'application/json',
            };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const response = await fetch(this.backendUrl, {
                method: 'POST',
                headers: headers,
                credentials: 'include',
                body: JSON.stringify(usageData)
            });

            const result = await response.json();
            if (result.success) {
                console.log('[GrokLive] Usage reported successfully:', result);
            } else {
                console.warn('[GrokLive] Failed to report usage:', result.error);
            }
        } catch (error) {
            console.error('[GrokLive] Error reporting usage:', error);
        }

        // Reset counters after reporting
        this.audioInputBytes = 0;
        this.audioOutputBytes = 0;
    }
}

// Make available globally
window.GrokLiveClient = GrokLiveClient;

console.log('[GrokLive] GrokLiveClient loaded');
