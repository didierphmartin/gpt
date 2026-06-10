/**
 * Voice dictation: a mic button that streams the user's speech (via the
 * selected Grok/Gemini realtime adapter) into the chat input. Dictation only —
 * the AI audio reply is never played.
 */
(function (global) {
    'use strict';

    // Pure text math for live dictation. `base` is the input value captured
    // when dictation started (with a trailing space if it was non-empty).
    // interim transcripts preview as base+transcript; a final transcript commits
    // into base (+ one trailing space) so the next phrase appends after it.
    function nextInputState(base, transcript, isFinal) {
        const value = base + transcript;
        const newBase = (isFinal && transcript) ? (base + transcript + ' ') : base;
        return { value, base: newBase };
    }

    const PROVIDER_KEY = 'voiceDictationProvider';
    const SILENCE_MS = 3000;  // auto-stop after this much quiet, once speech has started
    const INITIAL_MS = 12000; // grace period to START speaking before auto-stop

    // Turn whatever the adapter throws (Error, WebSocket Event, close event,
    // string) into a human, actionable message. Browser WebSocket 'error'
    // events carry no detail, so fall back to a hint.
    function errMsg(e) {
        if (!e) return 'Voice connection failed.';
        if (typeof e === 'string') return e;
        if (e.message) return e.message;
        if (e.code || e.reason) return `Voice connection closed (${e.code || ''} ${e.reason || ''}).`.trim();
        return 'Voice connection failed — the provider rejected it. Check the key in Settings → Account, or try the other provider.';
    }

    class VoiceDictation {
        constructor({ inputEl, buttonEl, onState, onError } = {}) {
            this.inputEl = inputEl;
            this.buttonEl = buttonEl;
            this.onState = onState || (() => {});       // 'idle' | 'recording'
            this.onError = onError || ((msg) => console.warn('[VoiceDictation]', msg));
            this.isRecording = false;
            this._base = '';
            this._silenceTimer = null;
            this._client = null;
            this._streamer = null;
        }

        getProvider() {
            const p = localStorage.getItem(PROVIDER_KEY);
            return (p === 'gemini' || p === 'grok') ? p : 'gemini';
        }

        toggle() { return this.isRecording ? this.stop() : this.start(); }

        _setState(s) { this.isRecording = (s === 'recording'); this.onState(s); }

        // Log the raw error for diagnosis, surface a readable message, stop.
        _fail(e) {
            console.error('[VoiceDictation] error:', e);
            this.onError(errMsg(e));
            this.stop();
        }

        _applyTranscript(text, isFinal) {
            if (!text) return;
            const r = nextInputState(this._base, text, isFinal);
            this.inputEl.value = r.value;
            this.inputEl.dispatchEvent(new Event('input', { bubbles: true })); // grow textarea / enable Send
            if (isFinal) this._base = r.base;
            this._resetSilenceTimer(); // any transcript activity counts as "not silent"
        }

        _resetSilenceTimer(ms) {
            clearTimeout(this._silenceTimer);
            this._silenceTimer = setTimeout(() => { this.stop(); }, ms || SILENCE_MS);
        }

        async start() {
            if (this.isRecording) return;
            const provider = this.getProvider();
            const config = (window.APP_CONFIG && window.APP_CONFIG[provider]) || {};
            // Use the SAME clients the Voice Panel uses (verified working):
            // gemini → GeminiLiveClient, grok → GrokLiveClient. Both share a
            // config-based callback interface.
            const ClientClass = provider === 'gemini' ? window.GeminiLiveClient : window.GrokLiveClient;
            if (!config.apiKey) {
                this.onError(`No ${provider} voice key configured — set the Voice provider in Settings → Account.`);
                return;
            }
            if (!ClientClass || !window.AudioStreamer) {
                this.onError(`Voice component not loaded for ${provider}.`);
                return;
            }
            const existing = (this.inputEl.value || '').replace(/\s+$/, '');
            this._base = existing ? existing + ' ' : '';
            try {
                this._streamer = new window.AudioStreamer({
                    onAudioData: (b64) => { if (this._client && (!this._client.isReady || this._client.isReady())) this._client.sendAudio(b64); },
                });
                // onAudio is intentionally omitted → the AI reply is never played.
                // onInputTranscription gives a live preview; onTurnComplete gives
                // the committed user text (what the Voice Panel relies on).
                const clientConfig = {
                    apiKey: config.apiKey,
                    systemPrompt: "Transcribe the user's speech verbatim. Do not reply.",
                    sampleRateInput: config.sampleRateInput || 16000,
                    sampleRateOutput: config.sampleRateOutput || 24000,
                    onSetupComplete: async () => {
                        await this._streamer.startCapture();
                        this._setState('recording');
                        this._resetSilenceTimer(INITIAL_MS); // long grace until the first words
                    },
                    onInputTranscription: (a, b) => {
                        // Gemini calls (deltaChunk, accumulatedFullText); Grok calls
                        // (fullText, isFinal). Use the full accumulated text either way.
                        const full = provider === 'gemini' ? (b || '') : (a || '');
                        this._applyTranscript(full, false); // live preview (persists if turn-complete is late)
                    },
                    onTurnComplete: (userText) => { if (userText) this._applyTranscript(userText, true); },
                    onError: (e) => this._fail(e),
                    onClose: () => { if (this.isRecording) this.stop(); },
                };
                if (provider === 'gemini') {
                    clientConfig.model = config.model || 'gemini-2.5-flash-native-audio-preview-12-2025';
                    clientConfig.voiceName = config.voiceName || 'Kore';
                } else {
                    clientConfig.voice = config.voice || 'Ara';
                }
                this._client = new ClientClass(clientConfig);
                await this._client.connect();
            } catch (e) {
                this._fail(e);
            }
        }

        async stop() {
            clearTimeout(this._silenceTimer);
            try { if (this._streamer && this._streamer.stopCapture) await this._streamer.stopCapture(); } catch (_) {}
            try { if (this._client && this._client.disconnect) await this._client.disconnect(); } catch (_) {}
            this._streamer = null; this._client = null;
            this._setState('idle');
        }
    }

    const api = { nextInputState };
    api.VoiceDictation = VoiceDictation;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;                 // node tests
    } else {
        global.VoiceDictationLib = api;       // browser
    }
})(typeof window !== 'undefined' ? window : globalThis);
