/**
 * Code components as Start options (spec 2026-10-13 start-trigger-options): the pure parts -- where a drop
 * registers an option, the register dialog's prefill, which row Start ticks, Start's links when its trigger
 * changes, and the removal warning's lines. The editor
 * (workflow-editor.js) does the DOM and the API calls.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.StartOptions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const CN = () => (typeof window !== 'undefined' ? window.CodeNode : global.CodeNode);

    /** The Start node a drop landed on, its Drawflow frame included; an ingestion Start takes files, not triggers. */
    function isStartDrop(target) {
        const start = target?.closest?.('.workflow-node.start-node')
            || target?.closest?.('.drawflow-node')?.querySelector?.('.workflow-node.start-node');
        if (!start || start.classList.contains('ingestion-start')) return null;
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

    /** Which row is ticked on Start (spec §10, one at a time): the saved schedule row decides. */
    function active(schedule) {
        if (schedule?.trigger_component_id) return Number(schedule.trigger_component_id);
        return schedule?.id ? 'schedule' : 'prompt';
    }

    /**
     * Start's links when its trigger changes (spec §10). `from` / `to` are {exits, work}; a plain Start is
     * {exits: ['next'], work: 'next'}. The links on the work exit's port move to the new work exit's port;
     * the other ports' links are removed. Returns {ports, connections: [{port, node, input}], dropped: [{exit, count}]}.
     */
    function startLinks(outputs, from, to) {
        const portOf = (side) => `output_${Math.max(0, side.exits.indexOf(side.work)) + 1}`;
        const fromWork = portOf(from), toWork = portOf(to);
        const connections = [], dropped = [];
        from.exits.forEach((exit, i) => {
            const port = `output_${i + 1}`;
            const conns = (outputs || {})[port]?.connections || [];
            if (port === fromWork) conns.forEach((c) => connections.push({ port: toWork, node: String(c.node), input: c.output }));
            else if (conns.length) dropped.push({ exit, count: conns.length });
        });
        return { ports: to.exits.length, connections, dropped };
    }

    /** The removal warning's lines, as i18n keys + params (spec §4, §10). */
    function warning(label, impact, workExit) {
        const tail = [{ key: 'workflow.startOptions.warnEverywhere', params: {} },
            { key: 'workflow.startOptions.warnLibrary', params: {} }];
        if (!impact.length) return tail;
        return [
            { key: 'workflow.startOptions.warnActive', params: { count: impact.length, names: impact.map((w) => w.workflow_name).join(', ') } },
            { key: 'workflow.startOptions.warnStops', params: { label } },
            { key: 'workflow.startOptions.warnPorts', params: { exit: workExit } },
            ...tail,
        ];
    }

    /**
     * The mode ▶ acts in: active(schedule), except that a paused schedule row cannot be activated (the server reads
     * only pending / running rows), so ▶ stays the prompt-mode run door for it instead of offering "Activate".
     */
    function startMode(schedule) {
        return schedule?.status === 'paused' ? 'prompt' : active(schedule);
    }

    /**
     * Start's ▶ and state line (spec 2026-10-14 event-worker §5). `mode`: startMode(schedule); `act`: the user's active
     * row (GET /workflows/active) or null; ▶ runs in prompt mode, else activates / deactivates this workflow.
     */
    function startView(mode, act, workflowId) {
        if (mode === 'prompt') return { button: 'run', hint: null };
        const k = (key, params = {}) => ({ key: `workflow.active.${key}`, params });
        if (!act || Number(act.workflow_id) !== Number(workflowId)) return { button: 'activate', hint: k('notActive') };
        const off = (s) => ({ button: 'deactivate', hint: s });
        if (act.checked_age_s == null) return off(act.activated_age_s > 60 ? k('serviceDown') : k('starting'));
        if (act.checked_age_s > 60) return off(k('serviceDown'));
        const m = act.watch_message;
        switch (act.watch_state) {
            case 'running': return off(k('running'));
            case 'scheduled': return off(k('scheduled', { next: m || '' }));
            case 'waiting':
                if (m === 'run_failed') return off(k('lastRunFailed'));
                return off(k(m === 'fallback' ? 'listeningFallback' : 'listening'));
            case 'error':
                if (m === 'run_failed') return off(k('runFailed'));
                if (m === 'reconnect_needed' || m === 'not_connected') return off(k('needsReconnect'));
                if (m === 'unreachable' || m === 'server_missing' || /^http_/.test(m || '')) return off(k('unreachable'));
                return off(k('errorOther', { message: m || '' }));
            case 'idle':
                return off(k({ no_links: 'noLinks', disabled: 'disabled' }[m] || 'modeGone'));
            default: return off(k('starting'));
        }
    }

    /** The dot beside Start's state: off (not active), ok (working), warn (working, with a caveat), err (not listening). */
    function stateTone(key) {
        const k = String(key || '').replace(/^workflow\.active\./, '');
        if (k === 'notActive') return 'off';
        if (['listening', 'scheduled', 'running'].includes(k)) return 'ok';
        if (['starting', 'listeningFallback', 'lastRunFailed'].includes(k)) return 'warn';
        return 'err';
    }

    return { isStartDrop, sortWaitTools, guessWorkExit, defaultTrigger, active, startMode, startLinks, warning, startView, stateTone };
});
