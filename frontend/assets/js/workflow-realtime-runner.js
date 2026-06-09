/**
 * RealtimeWorkflowRunner
 *
 * Event-driven engine for realtime audio workflows.
 * Reads a graph definition, maintains an agent stack, auto-generates
 * handoff_to / done / end_session tools from the graph topology,
 * injects prompt fragments, and orchestrates the handoff protocol.
 *
 * This class is provider-agnostic — it delegates all provider-specific
 * operations to a ProviderAdapter (GrokRealtimeAdapter, GeminiRealtimeAdapter).
 *
 * Design doc: /docs/REALTIME_WORKFLOW_DESIGN.md
 */
class RealtimeWorkflowRunner {
    /**
     * @param {object} graph - { agents: { key: { name, voice, instructions, handoffTargets, whenDone, tools } }, startAgent: string }
     * @param {object} adapter - ProviderAdapter instance (GrokRealtimeAdapter, etc.)
     * @param {object} options - { onStateChange, onTranscript, onEvent, onEnd }
     */
    constructor(graph, adapter, options = {}) {
        this.graph = graph;
        this.adapter = adapter;

        // Agent stack — array of agent keys. Top of stack = active agent.
        this.agentStack = [];
        this.running = false;

        // Pending handoff (deferred until turn completes so transfer speech plays)
        this._pendingHandoff = null;

        // Hook for waiting until audio playback is silent.
        // Set by the host (test page / editor) since AudioStreamer is owned there.
        // Should return a Promise that resolves when playback stops.
        this.waitForSilence = null;

        // Callbacks for the UI layer
        this.onStateChange = options.onStateChange || null;  // (activeAgentKey, stack)
        this.onTranscript = options.onTranscript || null;    // (text, isFinal, direction, agentKey)
        this.onEvent = options.onEvent || null;              // (type, data) — for logging
        this.onEnd = options.onEnd || null;                  // (reason)

        // Wire adapter callbacks
        this.adapter.onToolCall = (name, args, callId) => this._handleToolCall(name, args, callId);
        this.adapter.onTurnComplete = () => this._handleTurnComplete();
        this.adapter.onTranscript = (text, isFinal, direction) => {
            if (this.onTranscript) {
                this.onTranscript(text, isFinal, direction, this.activeAgentKey);
            }
        };
        this.adapter.onInterrupted = () => {
            this._pendingHandoff = null; // Cancel deferred handoff if user interrupted
            this._emit('interrupted');
        };
        this.adapter.onError = (error) => this._emit('error', { error });
        this.adapter.onClose = () => {
            if (this.running) {
                this.running = false;
                if (this.onEnd) this.onEnd('connection_closed');
            }
        };
    }

    // ================================================================
    // Public API
    // ================================================================

    /**
     * Get the currently active agent key (top of stack).
     */
    get activeAgentKey() {
        return this.agentStack.length > 0 ? this.agentStack[this.agentStack.length - 1] : null;
    }

    /**
     * Get the currently active agent config.
     */
    get activeAgent() {
        return this.activeAgentKey ? this.graph.agents[this.activeAgentKey] : null;
    }

    /**
     * Start the workflow: connect to provider, activate the first agent.
     */
    async start() {
        if (this.running) throw new Error('Runner is already running');

        this._emit('starting');

        // Connect to provider
        await this.adapter.connect();
        this._emit('connected');

        this.running = true;

        // Activate the start agent
        const startKey = this.graph.startAgent;
        if (!startKey || !this.graph.agents[startKey]) {
            throw new Error(`Start agent "${startKey}" not found in graph`);
        }

        this.agentStack = [startKey];
        await this._activateAgent(startKey);

        // Trigger the agent to greet the caller
        this.adapter.resumeAfterTool();

        this._emit('started', { agent: startKey });
    }

    /**
     * Stop the workflow: close connections, report usage.
     */
    stop() {
        this.running = false;
        this._pendingHandoff = null;
        this.adapter.disconnect();
        this._emit('stopped');
        if (this.onEnd) this.onEnd('user_stopped');
    }

    // ================================================================
    // Tool generation from graph topology
    // ================================================================

    /**
     * Generate tool declarations for a given agent based on graph topology.
     * - handoff_to(target) for each handoff target
     * - done() for non-start agents
     * - end_session() if End is in the handoff targets
     */
    getToolsForAgent(agentKey) {
        const agent = this.graph.agents[agentKey];
        if (!agent) return [];

        const tools = [];
        const handoffTargets = (agent.handoffTargets || []).filter(t => t !== 'end');

        // handoff_to tool (if agent has handoff targets other than End)
        if (handoffTargets.length > 0) {
            tools.push({
                type: 'function',
                name: 'handoff_to',
                description:
                    `REQUIRED tool to actually transfer the caller to another department. ` +
                    `Call this EVERY time you want to transfer the caller — saying "I'll transfer you" ` +
                    `in audio is NOT enough; the transfer only happens when this function is called. ` +
                    `Available targets: ${handoffTargets.join(', ')}. ` +
                    `Flow: 1) briefly say you are transferring the caller; 2) call this function.`,
                parameters: {
                    type: 'object',
                    properties: {
                        target: {
                            type: 'string',
                            enum: handoffTargets,
                            description: 'Which department/agent to transfer the caller to. MUST be one of the listed enum values.'
                        }
                    },
                    required: ['target']
                }
            });
        }

        // end_session tool (if End is in handoff targets)
        if ((agent.handoffTargets || []).includes('end')) {
            tools.push({
                type: 'function',
                name: 'end_session',
                description: 'End the call. Call this when the conversation is complete, the caller says goodbye, or there is nothing more to help with. Always say goodbye to the caller before calling this function.',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            });
        }

        // done() tool for non-start agents
        if (agentKey !== this.graph.startAgent) {
            const whenDone = agent.whenDone || { type: 'return' };
            let doneDesc = 'Call this when you have finished helping the caller with your specialty.';
            if (whenDone.type === 'return') {
                doneDesc += ' The caller will be transferred back to the previous agent.';
            } else if (whenDone.type === 'goto') {
                doneDesc += ` The caller will be transferred to ${whenDone.target}.`;
            }
            doneDesc += ' Always verbally let the caller know before calling this function.';

            tools.push({
                type: 'function',
                name: 'done',
                description: doneDesc,
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            });
        }

        // Include agent's own tools (MCP, code functions, etc.)
        if (agent.tools) {
            tools.push(...agent.tools);
        }

        return tools;
    }

    /**
     * Generate the auto-injected prompt fragment for a given agent.
     */
    getPromptFragmentForAgent(agentKey) {
        const agent = this.graph.agents[agentKey];
        if (!agent) return '';

        const fragments = [];
        const handoffTargets = (agent.handoffTargets || []).filter(t => t !== 'end');

        // Tell the agent which language to speak in, based on the app's i18n
        // setting. The caller could still switch mid-conversation — the agent
        // may follow along naturally.
        const langCode = (typeof window !== 'undefined' && window.i18n?.getLanguage)
            ? window.i18n.getLanguage()
            : 'en';
        const langName = { en: 'English', fr: 'French', es: 'Spanish' }[langCode] || 'English';
        const langNative = { en: 'in English', fr: 'en français', es: 'en español' }[langCode] || 'in English';
        fragments.push(
            `LANGUAGE: You MUST speak ${langNative} (${langName}) to the caller. ` +
            `Your instructions below may be written in English, but that's just the instruction language — ` +
            `your actual spoken responses, greetings, and examples must all be in ${langName}. ` +
            `Translate any quoted example phrases into ${langName} on the fly. ` +
            `If the caller switches language, follow their lead.`
        );

        if (handoffTargets.length > 0) {
            const ruleLines = handoffTargets.map(t => {
                const targetAgent = this.graph.agents[t];
                return `  - To transfer to the ${targetAgent?.name || t}: ` +
                    `(1) briefly say you're transferring the caller (e.g. "Let me connect you with ${targetAgent?.name || t} right away."); ` +
                    `(2) call handoff_to with target="${t}".`;
            }).join('\n');
            fragments.push(
                `TRANSFER RULES (IMPORTANT):\n${ruleLines}\n` +
                `You MUST call the handoff_to function to actually execute the transfer. ` +
                `Saying "I'll transfer you" without calling handoff_to does NOT transfer the caller. ` +
                `Always speak the acknowledgment first, then call the function — never call it silently.`
            );
        }

        if ((agent.handoffTargets || []).includes('end')) {
            fragments.push(
                `To end the call: (1) say a warm goodbye; (2) call end_session. ` +
                `You MUST call end_session — simply saying goodbye does not end the call.`
            );
        }

        if (agentKey !== this.graph.startAgent) {
            fragments.push(
                `When you've finished helping with your specialty: (1) let the caller know you're transferring them back; ` +
                `(2) call done. You MUST call done — without it the caller stays stuck with you.`
            );
        }

        return fragments.length > 0 ? '\n\n' + fragments.join('\n\n') : '';
    }

    /**
     * Build the full instructions for an agent (their own prompt + auto-generated fragment).
     */
    getFullInstructions(agentKey) {
        const agent = this.graph.agents[agentKey];
        if (!agent) return '';
        const fragment = this.getPromptFragmentForAgent(agentKey);
        // Prepend the tool-use rules so they frame the role BEFORE the
        // user-written prompt's domain guidance. Gemini in particular follows
        // the first instructions it sees more reliably than trailing ones.
        return (fragment ? fragment.trimStart() + '\n\n' : '') + (agent.instructions || '');
    }

    // ================================================================
    // Internal: agent activation
    // ================================================================

    /**
     * Activate an agent: push its config to the provider.
     * If the agent has a transferDelay configured, waits that many
     * seconds before activating — simulates a natural phone transfer pause.
     */
    async _activateAgent(agentKey) {
        const agent = this.graph.agents[agentKey];
        if (!agent) throw new Error(`Agent "${agentKey}" not found`);

        // Wait for current audio to finish playing before transitioning.
        // Transfer-delay (to make handoffs feel natural) is applied by the
        // handoff path in _handleTurnComplete, NOT here — applying it on the
        // initial start-agent activation would delay session.update past the
        // first mic bytes and leave Grok's VAD in a broken state.
        if (this.waitForSilence) {
            this._emit('waiting_for_silence', { agent: agentKey });
            await this.waitForSilence();
        }

        const tools = this.getToolsForAgent(agentKey);
        const instructions = this.getFullInstructions(agentKey);

        this._emit('activating_agent', { agent: agentKey, voice: agent.voice, toolCount: tools.length });

        console.log('[Runner] Activating', agentKey, 'with', tools.length, 'tools');

        // Adapters that implement a missed-handoff safety net (Gemini) need
        // the full agents map to resolve name-based synthesis; pass it in.
        if (typeof this.adapter.setGraphContext === 'function') {
            this.adapter.setGraphContext({ agents: this.graph.agents });
        }

        await this.adapter.configureAgent(
            { name: agent.name, voice: agent.voice, instructions },
            tools
        );

        this._emit('agent_active', { agent: agentKey });

        // Notify UI
        if (this.onStateChange) {
            this.onStateChange(agentKey, [...this.agentStack]);
        }
    }

    // ================================================================
    // Internal: tool call handling
    // ================================================================

    _handleToolCall(name, args, callId) {
        console.log('[Runner] Tool call received:', name, JSON.stringify(args));
        this._emit('tool_call', { name, args, callId });

        if (name === 'handoff_to') {
            const target = args.target;
            if (!target || !this.graph.agents[target]) {
                console.error(`[Runner] Unknown handoff target: ${target}`);
                this.adapter.returnToolResult(callId, { error: `Unknown agent: ${target}` });
                this.adapter.resumeAfterTool();
                return;
            }

            // Return result immediately (protocol requires it)
            this.adapter.returnToolResult(callId, { status: 'ok', transferred_to: target });

            // Determine push vs replace:
            // - Start agent's handoff_to → push (start agent stays as base)
            // - Any other agent's handoff_to → replace (lateral transfer between peers)
            const isFromStartAgent = this.activeAgentKey === this.graph.startAgent;
            const handoffType = isFromStartAgent ? 'push' : 'replace';

            this._pendingHandoff = { type: handoffType, target, source: this.activeAgentKey };
            this._emit('handoff_pending', { from: this.activeAgentKey, to: target, handoffType });

        } else if (name === 'done') {
            this.adapter.returnToolResult(callId, { status: 'ok' });

            const agent = this.activeAgent;
            const whenDone = agent?.whenDone || { type: 'return' };

            if (whenDone.type === 'goto' && whenDone.target) {
                this._pendingHandoff = { type: 'goto', target: whenDone.target, source: this.activeAgentKey };
            } else {
                this._pendingHandoff = { type: 'return', source: this.activeAgentKey };
            }
            this._emit('done_pending', { agent: this.activeAgentKey, whenDone });

        } else if (name === 'end_session') {
            this.adapter.returnToolResult(callId, { status: 'ok' });
            // Defer end until turn completes (so goodbye speech plays)
            this._pendingHandoff = { type: 'end', source: this.activeAgentKey };
            this._emit('end_pending');

        } else {
            // External tool (built-in backend function or MCP). Dispatch to
            // the backend tools/execute endpoint, feed the result back to the
            // LLM, and resume the conversation so the agent can narrate it.
            this._emit('external_tool_call', { name, args, callId });
            this._executeExternalTool(name, args, callId);
        }
    }

    async _executeExternalTool(name, args, callId) {
        try {
            const apiBase = (typeof window !== 'undefined' && window.CONFIG?.API_BASE_URL)
                || '/gpt/backend/api/v1';
            const authToken = (typeof localStorage !== 'undefined') ? localStorage.getItem('token') : null;
            const headers = { 'Content-Type': 'application/json' };
            if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

            const resp = await fetch(`${apiBase}/tools/execute`, {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify({ tool_name: name, parameters: args || {} })
            });
            const data = await resp.json().catch(() => ({}));

            let result;
            if (resp.ok && data.success) {
                result = data.result !== undefined ? data.result : { status: 'ok' };
            } else {
                result = {
                    status: 'error',
                    error: data.error || `Tool execution failed (HTTP ${resp.status})`
                };
                console.warn('[Runner] Tool execution failed:', name, result);
            }
            this.adapter.returnToolResult(callId, result);
        } catch (e) {
            console.error('[Runner] Tool dispatch error:', e);
            this.adapter.returnToolResult(callId, { status: 'error', error: e.message });
        }
        // Always resume so the conversation isn't stuck waiting.
        this.adapter.resumeAfterTool();
    }

    /**
     * Called when a turn completes (all audio for the turn has been sent).
     * This is when we execute deferred handoffs.
     */
    async _handleTurnComplete() {
        this._emit('turn_complete');

        if (!this._pendingHandoff) return;

        const handoff = this._pendingHandoff;
        this._pendingHandoff = null;

        // Apply the SOURCE agent's transfer-delay — natural phone-transfer
        // feel ("hang up → hold → new agent picks up"). We call beginHandoff
        // on the adapter BEFORE the delay so providers that reconnect per
        // handoff (Gemini) can close their current session now, rather than
        // letting it sit idle during the delay and risk an idle-close from
        // the server. Grok's beginHandoff is a no-op.
        const sourceAgent = handoff.source ? this.graph.agents[handoff.source] : null;
        const delay = sourceAgent?.transferDelay || 0;
        if (delay > 0 && handoff.type !== 'end') {
            this._emit('transfer_delay', { agent: handoff.source, seconds: delay });
            if (typeof this.adapter.beginHandoff === 'function') {
                this.adapter.beginHandoff();
            }
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }

        if (handoff.type === 'push') {
            // Push target onto stack (start agent stays as base)
            this.agentStack.push(handoff.target);
            this._emit('handoff_execute', { type: 'push', to: handoff.target, stack: [...this.agentStack] });
            await this._activateAgent(handoff.target);
            // Nudge the new agent to introduce itself
            const targetAgent = this.graph.agents[handoff.target];
            this.adapter.injectContextAndResume(
                `A caller has just been transferred to you. Please introduce yourself as ${targetAgent?.name || handoff.target} and ask how you can help.`
            );

        } else if (handoff.type === 'replace') {
            // Replace current agent with target (lateral transfer between peers)
            // The start agent (base of stack) is preserved
            const replaced = this.agentStack.pop();
            this.agentStack.push(handoff.target);
            this._emit('handoff_execute', { type: 'replace', from: replaced, to: handoff.target, stack: [...this.agentStack] });
            await this._activateAgent(handoff.target);
            // Nudge the new agent to introduce itself
            const targetAgent = this.graph.agents[handoff.target];
            this.adapter.injectContextAndResume(
                `A caller has just been transferred to you. Please introduce yourself as ${targetAgent?.name || handoff.target} and ask how you can help.`
            );

        } else if (handoff.type === 'return') {
            // Pop stack
            if (this.agentStack.length > 1) {
                const popped = this.agentStack.pop();
                const returnTo = this.activeAgentKey;
                this._emit('handoff_execute', { type: 'return', from: popped, to: returnTo, stack: [...this.agentStack] });
                await this._activateAgent(returnTo);
                const returnAgent = this.graph.agents[returnTo];
                this.adapter.injectContextAndResume(
                    `The caller has been transferred back to you from ${this.graph.agents[popped]?.name || popped}. Please ask how else you can help.`
                );
            } else {
                // Already at the start agent — nowhere to return to. End session.
                this._emit('end_execute', { reason: 'return_from_start' });
                this._endSession();
            }

        } else if (handoff.type === 'goto') {
            // Clear stack, set target as sole agent
            const from = this.activeAgentKey;
            this.agentStack = [handoff.target];
            this._emit('handoff_execute', { type: 'goto', from, to: handoff.target, stack: [...this.agentStack] });
            await this._activateAgent(handoff.target);
            const gotoAgent = this.graph.agents[handoff.target];
            this.adapter.injectContextAndResume(
                `A caller has just been transferred to you. Please greet them and ask how you can help.`
            );

        } else if (handoff.type === 'end') {
            this._emit('end_execute', { reason: 'end_session_called' });
            // Wait for audio playback to finish before disconnecting,
            // otherwise the goodbye speech gets cut off.
            this._endSessionAfterPlayback();
        }
    }

    _endSession() {
        this.running = false;
        this.adapter.disconnect();
        if (this.onEnd) this.onEnd('session_ended');
    }

    /**
     * Wait for audio playback to drain before ending the session.
     * Uses the onPlaybackComplete callback if available, with a
     * fallback timeout to avoid hanging indefinitely.
     */
    _endSessionAfterPlayback() {
        this.running = false; // Stop processing new events

        // If the adapter has a way to check playback status, use it
        if (this._onPlaybackComplete) {
            this._onPlaybackComplete(() => {
                this.adapter.disconnect();
                if (this.onEnd) this.onEnd('session_ended');
            });
        } else {
            // Fallback: wait a reasonable time for audio buffer to drain
            // At 24kHz, 3 seconds of audio = ~144KB — enough for a goodbye
            setTimeout(() => {
                this.adapter.disconnect();
                if (this.onEnd) this.onEnd('session_ended');
            }, 4000);
        }
    }

    // ================================================================
    // Internal: event emission
    // ================================================================

    _emit(type, data = {}) {
        if (this.onEvent) {
            this.onEvent(type, { ...data, timestamp: Date.now() });
        }
    }
}

// ================================================================
// Helper: build graph from editor data
// ================================================================

/**
 * Build a runner-compatible graph from raw workflow editor data.
 * This translates the Drawflow/editor format into the flat structure
 * the runner expects.
 *
 * @param {object} editorData - { nodes: [...], edges: [...] } from the editor
 * @returns {object} { agents: { key: {...} }, startAgent: string }
 */
RealtimeWorkflowRunner.buildGraph = function(editorData) {
    const agents = {};
    let startAgent = null;

    // Find start node and extract its connected agent
    const startNode = editorData.nodes.find(n => n.type === 'start');
    const endNode = editorData.nodes.find(n => n.type === 'end' || n.type === 'output');

    // Build agent map
    for (const node of editorData.nodes) {
        if (node.type !== 'agent') continue;
        const config = node.config || {};

        agents[node.id] = {
            name: config.name || node.name || `Agent ${node.id}`,
            voice: config.voice || 'Ara',
            instructions: config.systemPrompt || config.instructions || '',
            handoffTargets: config.handoffTargets || [],
            whenDone: config.whenDone || { type: 'return' },
            tools: config.tools || []
        };
    }

    // Find which agent the start node connects to
    if (startNode) {
        const startEdge = editorData.edges.find(e => e.from === startNode.id);
        if (startEdge) {
            startAgent = startEdge.to;
        }
    }

    // If no start edge found, use the first agent
    if (!startAgent) {
        const agentKeys = Object.keys(agents);
        if (agentKeys.length > 0) startAgent = agentKeys[0];
    }

    return { agents, startAgent };
};

window.RealtimeWorkflowRunner = RealtimeWorkflowRunner;
