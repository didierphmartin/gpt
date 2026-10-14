/**
 * Code components as Start options (spec 2026-10-13 start-trigger-options): the pure parts -- where a drop
 * registers an option, the register dialog's prefill, the Starts-on ticking rules and the removal warning's
 * lines. The editor (workflow-editor.js) does the DOM and the API calls.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.StartOptions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const CN = () => (typeof window !== 'undefined' ? window.CodeNode : global.CodeNode);

    /** The Start node a drop landed on; an ingestion Start takes files, not triggers. */
    function isStartDrop(target) {
        const start = target?.closest?.('.workflow-node.start-node');
        if (!start || target.closest('.ingestion-start')) return null;
        return start;
    }

    function sortWaitTools(names) {
        const wait = names.filter((n) => n.startsWith('wait_'));
        return [...wait, ...names.filter((n) => !n.startsWith('wait_'))];
    }

    function guessWorkExit(exits) {
        return exits.find((e) => e.startsWith('new_')) || exits[0] || '';
    }

    /** The literal, non-empty arguments of the component's template-shaped call, or null. */
    function callArgs(code) {
        const call = CN().callTemplate(code)?.call;
        const args = call ? CN().readCallArgs(code, call) : null;
        if (!args) return null;
        const kept = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== '' && v !== false));
        return Object.keys(kept).length ? kept : null;
    }

    /** The register dialog's starting values (spec §4). */
    function defaultTrigger(comp, toolNames) {
        const tool = sortWaitTools(toolNames)[0] || '';
        const found = tool.startsWith('wait_') ? callArgs(comp.code || '') : null;
        return {
            label: comp.name || '',
            watch: { server: (comp.mcp_servers || [])[0] || '', tool, args: found ? { args: found } : {} },
            work_exit: guessWorkExit(comp.exits || []),
        };
    }

    /** One event option at a time; Delay and an event exclude each other (spec decision 7). */
    function tick(state, key) {
        if (key === 'delay') {
            if (state.delay) return { state: { delay: false, event: state.event }, note: null };
            return { state: { delay: true, event: null }, note: state.event !== null ? 'eventOff' : null };
        }
        if (state.event === key) return { state: { delay: state.delay, event: null }, note: null };
        const note = state.delay ? 'delayOff' : (state.event !== null ? 'replaced' : null);
        return { state: { delay: false, event: key }, note };
    }

    /** The removal warning's lines, as i18n keys + params (spec §4). */
    function warning(label, impact) {
        const tail = [{ key: 'workflow.startOptions.warnEverywhere', params: {} },
            { key: 'workflow.startOptions.warnLibrary', params: {} }];
        if (!impact.length) return tail;
        const nodes = [...new Set(impact.map((w) => w.node_name).filter(Boolean))];
        return [
            { key: 'workflow.startOptions.warnActive', params: { count: impact.length, names: impact.map((w) => w.workflow_name).join(', ') } },
            { key: 'workflow.startOptions.warnStops', params: { label } },
            ...(nodes.length ? [{ key: 'workflow.startOptions.warnNodes', params: { nodes: nodes.join(', ') } }] : []),
            ...tail,
        ];
    }

    return { isStartDrop, sortWaitTools, guessWorkExit, defaultTrigger, tick, warning };
});
