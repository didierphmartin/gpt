/**
 * GeminiRealtimeAdapter
 *
 * Provider adapter for Gemini Live API, matching the interface consumed by
 * RealtimeWorkflowRunner. Differs from the Grok adapter in key ways:
 *  - Uses the @google/genai SDK (CDN-loaded) instead of raw WebSocket.
 *  - Auth is a direct API key (no ephemeral token flow).
 *  - Handoffs are implemented by closing the session and reconnecting with
 *    a new voice/instructions, not by mutating a live session.
 *
 * The runner calls `configureAgent(agent, tools)` both on initial activation
 * and on every handoff; this adapter performs a close+reconnect each time,
 * preserving the mic capture in the streamer across the reconnect gap.
 */
class GeminiRealtimeAdapter {
    constructor(config = {}) {
        this.model = config.model
            || window.APP_CONFIG?.gemini?.model
            || 'gemini-2.5-flash-native-audio-preview-12-2025';
        this.apiKey = config.apiKey || window.APP_CONFIG?.gemini?.apiKey || null;
        this.sampleRateInput = config.sampleRateInput || 16000;
        this.sampleRateOutput = config.sampleRateOutput || 24000;

        // SDK + session state
        this._GoogleGenAI = null;
        this._Modality = null;
        this.ai = null;
        this.session = null;
        this.ready = false;              // connect() succeeded (SDK loaded, client built)
        this.sessionActive = false;      // a live session is open and ready for audio
        this._handoffInProgress = false; // true between close and new onopen
        this._sessionGen = 0;            // bumped on each configureAgent — lets
                                         // old sessions' onclose callbacks know
                                         // whether they're still the "current"
                                         // session (and should fire onClose to
                                         // the runner) or stale (ignore).

        // Session tracking
        this.sessionId = null;
        this.audioInputBytes = 0;
        this.audioOutputBytes = 0;

        // Tool-call name lookup (Gemini requires the function name in the
        // sendToolResponse payload, but the runner only passes call_id back).
        this._toolCallNames = {};

        // Event callbacks (runner wires these)
        this.onToolCall = null;
        this.onTranscript = null;
        this.onAudio = null;
        this.onTurnComplete = null;
        this.onInterrupted = null;
        this.onSessionReady = null;
        this.onError = null;
        this.onClose = null;

        this._pendingSessionReady = null;
    }

    // ================================================================
    // Connection
    // ================================================================

    async connect() {
        if (!this.apiKey) {
            throw new Error('Gemini API key missing from APP_CONFIG.gemini.apiKey');
        }

        // Lazy-load the SDK from CDN on first connect
        if (!this._GoogleGenAI) {
            const module = await import('https://cdn.jsdelivr.net/npm/@google/genai@1.37.0/dist/web/index.mjs');
            this._GoogleGenAI = module.GoogleGenAI;
            this._Modality = module.Modality;
        }

        this.ai = new this._GoogleGenAI({ apiKey: this.apiKey });
        this.sessionId = 'gemini_rt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
        this.audioInputBytes = 0;
        this.audioOutputBytes = 0;
        this.ready = true;
        console.log('[GeminiAdapter] Ready (SDK loaded, client built)');
    }

    disconnect() {
        this._reportUsage();
        this.sessionActive = false;
        this._handoffInProgress = false;
        if (this.session) {
            try { this.session.close(); } catch (_) {}
            this.session = null;
        }
        this.ready = false;
    }

    isReady() {
        return this.ready && this.sessionActive && !this._handoffInProgress;
    }

    // ================================================================
    // Agent configuration (open/reopen session)
    // ================================================================

    /**
     * For Gemini, configuring an agent means opening a fresh session with the
     * desired voice + instructions + tools. On handoff the prior session is
     * closed first. Resolves when the new session's onopen fires.
     */
    /**
     * Runner calls this before the transferDelay pause. Closes the current
     * session but keeps `_handoffInProgress` true so the close event is
     * swallowed (doesn't trigger the runner's `onClose` → session-end path).
     * Lets the delay be a true silent gap — Gemini can't idle-close what's
     * already closed.
     */
    beginHandoff() {
        if (!this.session) return;
        this._handoffInProgress = true;
        this.sessionActive = false;
        // Bump the gen so the about-to-fire close is treated as stale.
        ++this._sessionGen;
        try { this.session.close(); } catch (_) {}
        this.session = null;
    }

    async configureAgent(agent, tools) {
        this._handoffInProgress = true;
        this.sessionActive = false;
        const myGen = ++this._sessionGen;

        // Close prior session if any (if beginHandoff wasn't called).
        if (this.session) {
            try { this.session.close(); } catch (_) {}
            this.session = null;
        }

        const functionDeclarations = (tools || []).map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }));

        // Stash handoff_to's enum AND the full tool list for the missed-
        // call safety net (literal fast-path + LLM classifier).
        const handoffTool = (tools || []).find(t => t.name === 'handoff_to');
        this._handoffEnum = handoffTool?.parameters?.properties?.target?.enum || [];
        this._currentTools = tools || [];

        const config = {
            responseModalities: [this._Modality.AUDIO],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: this._mapVoice(agent.voice) }
                }
            },
            systemInstruction: agent.instructions || '',
            inputAudioTranscription: {},
            outputAudioTranscription: {}
        };
        if (functionDeclarations.length > 0) {
            config.tools = [{ functionDeclarations }];
        }

        // Await the session handle first; THEN wait for onopen. The SDK's
        // connect() promise can resolve before the onopen callback fires, so
        // we use a separate promise for open readiness. Waiting in this order
        // guarantees `this.session` is non-null by the time the runner's
        // next call (resumeAfterTool / injectContextAndResume) uses it.
        const openPromise = new Promise((resolve, reject) => {
            this._pendingSessionReady = resolve;
            this._pendingSessionReject = reject;
        });

        try {
            this.session = await this.ai.live.connect({
                model: this.model,
                callbacks: {
                    onopen: () => {
                        console.log('[GeminiAdapter] Session opened (voice:', agent.voice, ')');
                        this.sessionActive = true;
                        this._handoffInProgress = false;
                        if (this.onSessionReady) this.onSessionReady();
                        if (this._pendingSessionReady) {
                            this._pendingSessionReady();
                            this._pendingSessionReady = null;
                            this._pendingSessionReject = null;
                        }
                    },
                    onmessage: (msg) => this._handleMessage(msg),
                    onerror: (err) => {
                        console.error('[GeminiAdapter] Session error:', err);
                        if (this.onError) this.onError(err);
                        if (this._pendingSessionReject) {
                            this._pendingSessionReject(err);
                            this._pendingSessionReady = null;
                            this._pendingSessionReject = null;
                        }
                    },
                    onclose: () => {
                        // Only the CURRENT session's close means "call ended".
                        // Older sessions' close events (from handoff swaps)
                        // must be ignored or they'd tear down the live call.
                        if (myGen !== this._sessionGen) {
                            console.log('[GeminiAdapter] Stale session closed (gen', myGen, '), ignoring');
                            return;
                        }
                        console.log('[GeminiAdapter] Session closed (gen', myGen, ')');
                        const wasHandoff = this._handoffInProgress;
                        this.sessionActive = false;

                        // Last-chance safety net: Gemini sometimes closes the
                        // session mid-turn while the agent is narrating a
                        // transfer. Ask the classifier (async) if the partial
                        // transcript implied a tool call; if yes, fire it
                        // locally so the runner can progress. If no rescue,
                        // propagate onClose as usual.
                        if (!wasHandoff && !this._toolCalledThisTurn && this._turnOutputText) {
                            const partial = this._turnOutputText;
                            this._turnOutputText = '';
                            this._classifyMissedCall(partial).then(rescued => {
                                if (rescued && this.onToolCall) {
                                    console.log('[GeminiAdapter] Rescuing mid-turn close with:', rescued);
                                    this.onToolCall(rescued.tool, rescued.args, 'synth_close_' + Date.now());
                                    if (this.onTurnComplete) this.onTurnComplete();
                                } else if (this.onClose) {
                                    this.onClose();
                                }
                            }).catch(() => {
                                if (this.onClose) this.onClose();
                            });
                            return;
                        }

                        if (!wasHandoff && this.onClose) this.onClose();
                    }
                },
                config
            });
        } catch (err) {
            this._handoffInProgress = false;
            throw err;
        }

        await openPromise;
    }

    /**
     * Called by the runner before configureAgent — gives the adapter the
     * full agent map so the missed-handoff safety net can match on display
     * names in addition to enum keys.
     */
    setGraphContext({ agents }) {
        this._agentsByKey = agents || {};
    }

    /**
     * Multilingual safety net: ask a cheap LLM whether the agent's utterance
     * implied a tool call, and which tool. Called from turn-complete or
     * abrupt-close paths when no function call was emitted.
     *
     * Fast path: if the transcript echoes a handoff target's key or display
     * name literally, skip the LLM round-trip.
     *
     * Stores the current agent's full tool list in `this._currentTools` so
     * we can send the classifier the same list the agent saw.
     *
     * @returns {Promise<{tool:string, args:object}|null>}
     */
    async _classifyMissedCall(spokenText) {
        if (!spokenText) return null;

        // Fast path: literal target-name match (no LLM call needed).
        if (this._handoffEnum && this._handoffEnum.length > 0) {
            const lower = spokenText.toLowerCase();
            for (const target of this._handoffEnum) {
                const names = [target];
                const agentCfg = this._agentsByKey?.[target];
                if (agentCfg?.name) names.push(agentCfg.name);
                for (const name of names) {
                    if (name && lower.includes(name.toLowerCase())) {
                        return { tool: 'handoff_to', args: { target } };
                    }
                }
            }
        }

        // LLM classifier — handles any language / phrasing.
        if (!this._currentTools || this._currentTools.length === 0) return null;

        try {
            const apiBase = (typeof window !== 'undefined' && window.CONFIG?.API_BASE_URL)
                || '/gpt/backend/api/v1';
            const authToken = (typeof localStorage !== 'undefined') ? localStorage.getItem('token') : null;
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

            const resp = await fetch(`${apiBase}/tools/classify-intent`, {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify({
                    transcript: spokenText,
                    tools: this._currentTools
                })
            });
            const data = await resp.json().catch(() => ({}));
            if (data && data.success && data.tool) {
                console.log('[GeminiAdapter] Classifier suggested tool:', data.tool, data.args);
                return { tool: data.tool, args: data.args || {} };
            }
        } catch (e) {
            console.warn('[GeminiAdapter] classify-intent failed:', e.message);
        }
        return null;
    }

    /**
     * Map an agent's voice to the closest Gemini voice. Grok and Gemini have
     * disjoint voice catalogues (Grok: Ara/Rex/Sal/Eve/Leo; Gemini: Kore/Puck/
     * Charon/Fenrir/Aoede/Zephyr). If the agent's saved voice isn't in
     * Gemini's list, fall back to Kore so the session still opens.
     */
    _mapVoice(voice) {
        const geminiVoices = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede'];
        return geminiVoices.includes(voice) ? voice : 'Kore';
    }

    // ================================================================
    // Audio
    // ================================================================

    sendAudio(base64Audio) {
        if (!this.isReady() || !this.session) return;
        try {
            this.session.sendRealtimeInput({
                media: {
                    data: base64Audio,
                    mimeType: `audio/pcm;rate=${this.sampleRateInput}`
                }
            });
            this.audioInputBytes += Math.floor(base64Audio.length * 0.75);
        } catch (_) {
            // Session may have closed during a handoff — safe to drop.
        }
    }

    // ================================================================
    // Tool results
    // ================================================================

    returnToolResult(callId, result) {
        if (!this.session) return;
        try {
            this.session.sendToolResponse({
                functionResponses: [{
                    id: callId,
                    name: this._toolCallNames[callId] || undefined,
                    response: result
                }]
            });
            delete this._toolCallNames[callId];
        } catch (e) {
            console.warn('[GeminiAdapter] sendToolResponse failed:', e.message);
        }
    }

    /**
     * Gemini automatically produces a response after a tool result, so
     * there's nothing to trigger here. The runner calls this after the
     * initial _activateAgent too, and Gemini does NOT greet spontaneously
     * on a fresh session — so we nudge the agent to speak.
     */
    resumeAfterTool() {
        if (!this.isReady() || !this.session) return;
        try {
            this.session.sendClientContent({
                turns: [{
                    role: 'user',
                    parts: [{ text: 'Please greet the caller briefly and ask how you can help.' }]
                }],
                turnComplete: true
            });
        } catch (_) {}
    }

    /**
     * After a handoff-reconnect, nudge the new agent to introduce itself
     * with context about why the caller was transferred.
     */
    injectContextAndResume(text) {
        if (!this.isReady() || !this.session) return;
        try {
            this.session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text }] }],
                turnComplete: true
            });
        } catch (_) {}
    }

    // ================================================================
    // Message handling
    // ================================================================

    _handleMessage(message) {
        // Tool call from the model
        if (message.toolCall) {
            const calls = message.toolCall.functionCalls || [];
            for (const call of calls) {
                this._toolCallNames[call.id] = call.name;
                this._toolCalledThisTurn = true;
                if (this.onToolCall) {
                    this.onToolCall(call.name, call.args || {}, call.id);
                }
            }
            return;
        }

        // Tool call cancellation (e.g., interrupted mid-call)
        if (message.toolCallCancellation) {
            return;
        }

        const sc = message.serverContent;
        if (!sc) return;

        // Transcription: user side
        if (sc.inputTranscription?.text) {
            console.log('[GeminiAdapter] user transcript:', sc.inputTranscription.text);
            if (this.onTranscript) this.onTranscript(sc.inputTranscription.text, true, 'in');
        }
        // Transcription: model side. Accumulate across the turn so a turn-end
        // heuristic can rescue a missed handoff (Gemini native-audio sometimes
        // narrates the transfer without calling handoff_to).
        if (sc.outputTranscription?.text) {
            console.log('[GeminiAdapter] agent transcript:', sc.outputTranscription.text);
            this._turnOutputText = (this._turnOutputText || '') + sc.outputTranscription.text;
            if (this.onTranscript) this.onTranscript(sc.outputTranscription.text, true, 'out');
        }

        // Model audio output
        if (sc.modelTurn?.parts) {
            for (const part of sc.modelTurn.parts) {
                if (part.inlineData?.data && this.onAudio) {
                    this.audioOutputBytes += Math.floor(part.inlineData.data.length * 0.75);
                    this.onAudio(part.inlineData.data);
                }
            }
        }

        if (sc.turnComplete) {
            const uttered = this._turnOutputText;
            const needRescue = !this._toolCalledThisTurn && !!uttered;
            this._toolCalledThisTurn = false;
            this._turnOutputText = '';

            if (needRescue) {
                // Fire and forget the classifier — it may complete async.
                // If it finds a tool call, fire onToolCall locally as if the
                // LLM had emitted it. onTurnComplete below is already fired
                // so the runner can schedule the handoff immediately.
                this._classifyMissedCall(uttered).then(rescued => {
                    if (rescued && this.onToolCall) {
                        console.log('[GeminiAdapter] Synthesizing missed call:', rescued);
                        this.onToolCall(rescued.tool, rescued.args, 'synth_turn_' + Date.now());
                        // Poke the runner to process the newly-arrived handoff.
                        if (this.onTurnComplete) this.onTurnComplete();
                    }
                });
            }

            if (this.onTurnComplete) this.onTurnComplete();
        }

        if (sc.interrupted && this.onInterrupted) {
            this.onInterrupted();
        }
    }

    // ================================================================
    // Usage reporting
    // ================================================================

    async _reportUsage() {
        const inputSeconds = (this.audioInputBytes / 2) / this.sampleRateInput;
        const outputSeconds = (this.audioOutputBytes / 2) / this.sampleRateOutput;
        if (inputSeconds <= 0 && outputSeconds <= 0) return;

        try {
            const authToken = localStorage.getItem('token');
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
            await fetch('/gpt/backend/api/v1/voice/usage', {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify({
                    provider: 'gemini',
                    model: this.model,
                    session_id: this.sessionId,
                    audio_input_seconds: parseFloat(inputSeconds.toFixed(2)),
                    audio_output_seconds: parseFloat(outputSeconds.toFixed(2)),
                    input_sample_rate: this.sampleRateInput,
                    output_sample_rate: this.sampleRateOutput,
                    status: 'success'
                })
            });
        } catch (e) {
            console.error('[GeminiAdapter] Usage report failed:', e);
        }
    }
}

window.GeminiRealtimeAdapter = GeminiRealtimeAdapter;
console.log('[GeminiAdapter] GeminiRealtimeAdapter loaded');
