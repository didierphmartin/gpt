/**
 * GeminiLiveClient - Client for Gemini 2.5 Live API
 * Uses the official @google/genai library via CDN
 *
 * Handles:
 * - Connection to Gemini Live API
 * - Session setup with configuration
 * - Sending audio/text input
 * - Receiving audio responses and transcriptions
 * - Interruption handling
 */

// Import the library dynamically
let GoogleGenAI = null;
let Modality = null;

async function loadGoogleGenAI() {
    if (GoogleGenAI) return;

    try {
        const module = await import('https://cdn.jsdelivr.net/npm/@google/genai@1.37.0/dist/web/index.mjs');
        GoogleGenAI = module.GoogleGenAI;
        Modality = module.Modality;
        console.log('[GeminiLive] Google GenAI library loaded');
    } catch (error) {
        console.error('[GeminiLive] Failed to load Google GenAI library:', error);
        throw error;
    }
}

class GeminiLiveClient {
    constructor(options = {}) {
        // Configuration
        this.apiKey = options.apiKey || '';
        this.model = options.model || 'gemini-2.5-flash-native-audio-preview-12-2025';
        this.systemPrompt = options.systemPrompt || '';
        this.voiceName = options.voiceName || 'Kore';

        // Callbacks
        this.onOpen = options.onOpen || null;
        this.onClose = options.onClose || null;
        this.onError = options.onError || null;
        this.onAudio = options.onAudio || null;
        this.onInputTranscription = options.onInputTranscription || null;
        this.onOutputTranscription = options.onOutputTranscription || null;
        this.onTurnComplete = options.onTurnComplete || null;
        this.onInterrupted = options.onInterrupted || null;
        this.onSetupComplete = options.onSetupComplete || null;

        // State
        this.session = null;
        this.isConnected = false;
        this.isSetupComplete = false;

        // Transcription accumulation
        this.currentInputTranscription = '';
        this.currentOutputTranscription = '';

        // Usage tracking
        this.usageTrackingEnabled = options.usageTrackingEnabled !== false;
        this.backendUrl = options.backendUrl || window.apiUrl('/voice/usage');
        this.sessionId = null;
        this.audioInputBytes = 0;
        this.audioOutputBytes = 0;
        this.inputSampleRate = 16000;  // PCM input at 16kHz
        this.outputSampleRate = 24000; // PCM output at 24kHz
    }

    /**
     * Connect to Gemini Live API
     */
    async connect() {
        try {
            // Load the library first
            await loadGoogleGenAI();

            console.log('[GeminiLive] Connecting to Gemini Live API...');

            // Initialize the API client
            const ai = new GoogleGenAI({ apiKey: this.apiKey });

            // Connect to Live API
            this.session = await ai.live.connect({
                model: this.model,
                callbacks: {
                    onopen: () => {
                        console.log('[GeminiLive] Session opened');
                        this.isConnected = true;
                        this.isSetupComplete = true;

                        if (this.onOpen) {
                            this.onOpen();
                        }
                        if (this.onSetupComplete) {
                            this.onSetupComplete();
                        }
                    },
                    onmessage: (message) => {
                        this.handleMessage(message);
                    },
                    onerror: (error) => {
                        console.error('[GeminiLive] Session error:', error);
                        if (this.onError) {
                            this.onError(error);
                        }
                    },
                    onclose: (event) => {
                        console.log('[GeminiLive] Session closed');
                        this.isConnected = false;
                        this.isSetupComplete = false;
                        if (this.onClose) {
                            this.onClose(event);
                        }
                    }
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: this.voiceName
                            }
                        }
                    },
                    systemInstruction: this.systemPrompt,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {}
                }
            });

            console.log('[GeminiLive] Connected successfully');

            // Generate session ID for usage tracking
            this.sessionId = 'gemini_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            this.audioInputBytes = 0;
            this.audioOutputBytes = 0;

        } catch (error) {
            console.error('[GeminiLive] Connection failed:', error);
            if (this.onError) {
                this.onError(error);
            }
            throw error;
        }
    }

    /**
     * Send audio data to Gemini (Base64 PCM at 16kHz)
     */
    sendAudio(base64Data) {
        if (!this.session || !this.isSetupComplete) {
            return;
        }

        try {
            this.session.sendRealtimeInput({
                media: {
                    data: base64Data,
                    mimeType: 'audio/pcm;rate=16000'
                }
            });

            // Track input audio bytes for usage calculation
            // Base64 decodes to 3/4 the length in bytes
            this.audioInputBytes += Math.floor(base64Data.length * 0.75);
        } catch (error) {
            console.error('[GeminiLive] Failed to send audio:', error);
        }
    }

    /**
     * Send text message to Gemini
     */
    sendText(text, turnComplete = true) {
        if (!this.session || !this.isSetupComplete) {
            console.warn('[GeminiLive] Cannot send text: not connected');
            return;
        }

        try {
            this.session.sendClientContent({
                turns: [{
                    role: 'user',
                    parts: [{ text: text }]
                }],
                turnComplete: turnComplete
            });
            console.log('[GeminiLive] Text sent:', text);
        } catch (error) {
            console.error('[GeminiLive] Failed to send text:', error);
        }
    }

    /**
     * Handle incoming message from Gemini
     */
    handleMessage(message) {
        const serverContent = message.serverContent;
        if (!serverContent) return;

        // Handle input transcription (user's speech)
        if (serverContent.inputTranscription) {
            const text = serverContent.inputTranscription.text || '';
            this.currentInputTranscription += text;
            if (this.onInputTranscription) {
                this.onInputTranscription(text, this.currentInputTranscription);
            }
        }

        // Handle output transcription (AI's speech)
        if (serverContent.outputTranscription) {
            const text = serverContent.outputTranscription.text || '';
            this.currentOutputTranscription += text;
            if (this.onOutputTranscription) {
                this.onOutputTranscription(text, this.currentOutputTranscription);
            }
        }

        // Handle audio response
        if (serverContent.modelTurn?.parts) {
            for (const part of serverContent.modelTurn.parts) {
                if (part.inlineData?.data) {
                    // Track output audio bytes for usage calculation
                    this.audioOutputBytes += Math.floor(part.inlineData.data.length * 0.75);

                    if (this.onAudio) {
                        this.onAudio(part.inlineData.data);
                    }
                }
            }
        }

        // Handle turn complete
        if (serverContent.turnComplete) {
            console.log('[GeminiLive] Turn complete');
            if (this.onTurnComplete) {
                this.onTurnComplete(
                    this.cleanTranscription(this.currentInputTranscription),
                    this.cleanTranscription(this.currentOutputTranscription)
                );
            }
            // Reset transcription accumulators
            this.currentInputTranscription = '';
            this.currentOutputTranscription = '';
        }

        // Handle interruption
        if (serverContent.interrupted) {
            console.log('[GeminiLive] Interrupted');
            if (this.onInterrupted) {
                this.onInterrupted();
            }
            // Reset transcriptions on interruption
            this.currentInputTranscription = '';
            this.currentOutputTranscription = '';
        }
    }

    /**
     * Disconnect from Gemini Live API
     */
    disconnect() {
        // Report usage before disconnecting
        this.reportUsage();

        if (this.session) {
            try {
                this.session.close();
            } catch (e) {
                console.warn('[GeminiLive] Error closing session:', e);
            }
            this.session = null;
        }
        this.isConnected = false;
        this.isSetupComplete = false;
        this.currentInputTranscription = '';
        this.currentOutputTranscription = '';
        console.log('[GeminiLive] Disconnected');
    }

    /**
     * Check if connected and ready
     */
    isReady() {
        return this.isConnected && this.isSetupComplete;
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

        const audioInputSeconds = this.calculateAudioDuration(this.audioInputBytes, this.inputSampleRate);
        const audioOutputSeconds = this.calculateAudioDuration(this.audioOutputBytes, this.outputSampleRate);

        // Only report if there was actual audio usage
        if (audioInputSeconds <= 0 && audioOutputSeconds <= 0) {
            console.log('[GeminiLive] No audio usage to report');
            return;
        }

        const usageData = {
            provider: 'gemini',
            model: this.model,
            session_id: this.sessionId,
            audio_input_seconds: parseFloat(audioInputSeconds.toFixed(2)),
            audio_output_seconds: parseFloat(audioOutputSeconds.toFixed(2)),
            input_sample_rate: this.inputSampleRate,
            output_sample_rate: this.outputSampleRate,
            status: status,
            error_message: errorMessage
        };

        console.log('[GeminiLive] Reporting usage:', usageData);

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
                console.log('[GeminiLive] Usage reported successfully:', result);
            } else {
                console.warn('[GeminiLive] Failed to report usage:', result.error);
            }
        } catch (error) {
            console.error('[GeminiLive] Error reporting usage:', error);
        }

        // Reset counters after reporting
        this.audioInputBytes = 0;
        this.audioOutputBytes = 0;
    }

    /**
     * Clean up transcription text
     */
    cleanTranscription(text) {
        if (!text) return '';

        return text
            .replace(/<[^>]+>/g, '')
            .replace(/[\u0600-\u06FF]+/g, '')
            .replace(/[\u0E00-\u0E7F]+/g, '')
            .replace(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+/g, '')
            .replace(/[\u0400-\u04FF]+/g, '')
            .replace(/[\u0590-\u05FF]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

// Export for use in other modules
window.GeminiLiveClient = GeminiLiveClient;
