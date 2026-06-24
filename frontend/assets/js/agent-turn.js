/**
 * Shared agent turn-loop helpers. ONE place for the provider-correct
 * tool-round continuation format so chat AND the workflow build identical
 * conversation_history — no drift, no per-surface provider bugs (this is what
 * fixed Gemini: thought_signature must be echoed back on the replayed turn).
 */
(function () {
    'use strict';

    const AgentTurn = {
        /**
         * Build the assistant tool-use turn + the role:'tool' result turns for
         * one completed round of tool calls. Standard multi-tool protocol that
         * works across Anthropic (content blocks), OpenAI (tool_calls array) and
         * Gemini (functionCall/functionResponse — needs the per-call
         * thought_signature preserved and the function name on each tool turn).
         *
         * @param {Array<{call:{id:string,name:string,input:*,thought_signature?:string}, toolResultPayload:*}>} results
         * @param {string} assistantText  text the model emitted alongside the calls
         * @returns {{assistantTurn:object, toolResultTurns:object[]}}
         */
        buildToolRoundTurns(results, assistantText) {
            const list = Array.isArray(results) ? results : [];
            const assistantToolCalls = list.map(({ call }) => ({
                id: call.id,
                type: 'function',
                function: {
                    name: call.name,
                    arguments: (typeof call.input === 'string') ? call.input : JSON.stringify(call.input || {}),
                },
                // Gemini 2.5+ requires this opaque per-call signature to be
                // preserved when the tool_use turn is replayed. Others ignore it.
                ...(call.thought_signature ? { thought_signature: call.thought_signature } : {}),
            }));
            const toolResultTurns = list.map(({ call, toolResultPayload }) => ({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name, // Gemini matches functionResponse by name
                content: (typeof toolResultPayload === 'string') ? toolResultPayload : JSON.stringify(toolResultPayload),
            }));
            return {
                assistantTurn: { role: 'assistant', content: assistantText || '', tool_calls: assistantToolCalls },
                toolResultTurns,
            };
        },
    };

    window.AgentTurn = AgentTurn;
})();
