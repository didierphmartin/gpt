/**
 * Code node — the editor's pure logic (no DOM): exits <-> Drawflow ports, the parents a
 * run hands the harness, config validation and templates. The run contract itself lives
 * in assets/py/code_node_harness.py (shared with compiled LangGraph).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CodeNode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const EXIT_RE = /^[a-z][a-z0-9_]{0,31}$/;
    const TOOL_RE = /^[a-z0-9_]{1,64}\.[A-Za-z0-9_.-]{1,128}$/;

    const TEMPLATES = {
        poll_servicenow: {
            label: 'Poll ServiceNow jobs',
            exits: ['job', 'no_job', 'error'],
            mcp_tools: ['servicenow.poll_jobs'],
            code: [
                'def run(input, call_tool):',
                '    # Oldest open, unclaimed SynergyAI task (optionally: {"tag": "okta-reset"}).',
                '    result = call_tool("servicenow", "poll_jobs", {})',
                '    job = result.get("job")',
                '    if job is None:',
                '        return {"route": "no_job", "output": None}',
                '    return {"route": "job", "output": job}',
                '',
            ].join('\n'),
        },
        passthrough: {
            label: 'Pass-through',
            exits: ['next'],
            mcp_tools: [],
            code: 'def run(input, call_tool):\n    return input\n',
        },
    };

    function validateConfig(cfg) {
        const errs = [];
        if (!String(cfg.code || '').includes('def run(')) errs.push('The code must define run(input, call_tool).');
        const exits = Array.isArray(cfg.exits) ? cfg.exits : [];
        if (exits.length < 1 || exits.length > 8) errs.push('A code node has 1 to 8 exits.');
        exits.forEach((e) => { if (!EXIT_RE.test(e)) errs.push(`Exit "${e}": lowercase letters, digits and _ only.`); });
        if (new Set(exits).size !== exits.length) errs.push('Exit names must be unique.');
        (cfg.mcp_tools || []).forEach((t) => { if (!TOOL_RE.test(t)) errs.push(`Tool "${t}": write server.tool, e.g. servicenow.poll_jobs.`); });
        const t = Number(cfg.timeout_s);
        if (!Number.isInteger(t) || t < 1 || t > 300) errs.push('Timeout: 1 to 300 seconds.');
        return errs;
    }

    function exitForPort(exits, port) {
        const k = Number(String(port).replace(/^output_/, ''));
        return Number.isInteger(k) && k >= 1 && k <= exits.length ? exits[k - 1] : null;
    }

    function portForExit(exits, exit) {
        const i = exits.indexOf(exit);
        return i < 0 ? null : `output_${i + 1}`;
    }

    function targetsForExit(nodeId, nodes, exit, exits) {
        const port = portForExit(exits, exit);
        const out = (nodes[nodeId]?.outputs || {})[port];
        return (out?.connections || []).map((c) => String(c.node));
    }

    /** The parents that ran, as the harness wants them; a parent with no output (skipped) is left out. */
    function parentsFor(nodeId, nodes, outputs, kindOf) {
        const res = [];
        const ins = nodes[nodeId]?.inputs || {};
        for (const k of Object.keys(ins)) {
            for (const c of ins[k].connections || []) {
                const u = String(c.node);
                const text = outputs[u];
                if (text == null || text === '') continue;
                const d = nodes[u]?.data || {};
                const start = kindOf(u) === 'start';
                res.push({ name: start ? 'start' : (d.agent_name || d.name || `node_${u}`), text: String(text), start });
            }
        }
        return res;
    }

    /** Every edge leaving `node`, each on its real port (exit k = output_k). */
    function edgesFrom(nodeId, node) {
        const edges = [];
        for (const [port, out] of Object.entries(node.outputs || {})) {
            for (const c of out.connections || []) edges.push({ to: String(c.node), from_port: port, to_port: c.output });
        }
        return edges;
    }

    /** Every child of `nodeId`, edge order (port by port), as ids. */
    function childrenOf(nodeId, nodes) {
        const out = [];
        for (const o of Object.values(nodes[nodeId]?.outputs || {})) for (const c of o.connections || []) out.push(String(c.node));
        return out;
    }

    /**
     * A run that failed outside the harness (the editor's timer fired, or the worker failed), reported
     * as the harness reports a failure (spec §3.4): the `error` exit when the node has one, else not ok.
     */
    function failureResult(exits, message) {
        const error = `CodeNodeError: ${message}`;
        if ((exits || []).includes('error')) {
            return { ok: true, route: 'error', output_text: JSON.stringify({ error }), stdout: '', tool_calls: [] };
        }
        return { ok: false, error, stdout: '', tool_calls: [] };
    }

    /**
     * What a code node's result means for the run: the node's output, the children on the exit it took,
     * and the children to skip (the run then skips what is reachable only through them). A failed node
     * skips all its children -- compiled stops there. An exit with no edge skips every child: that
     * branch ends (spec §5.1), which is not a failure.
     */
    function routeAfter(nodeId, nodes, r, exits) {
        const kids = childrenOf(nodeId, nodes);
        if (!r.ok) return { success: false, output: 'Error: ' + r.error, exit: null, chosen: [], skip: kids };
        const chosen = targetsForExit(nodeId, nodes, r.route, exits);
        const keep = new Set(chosen);
        return { success: true, output: r.output_text, exit: r.route, chosen, skip: kids.filter((d) => !keep.has(d)) };
    }

    /**
     * Did the run succeed: nothing failed and nothing is left. An Output node that a code node's
     * routing cut off (an unwired exit) leaves the final output '' -- as compiled returns '' -- and
     * that is not a failure.
     */
    function runSucceeded({ finalOutput, hadError, remaining, outputEndedByRoute }) {
        return !hadError && remaining === 0 && (!!finalOutput || !!outputEndedByRoute);
    }

    /**
     * The node's connections after its exits change, matched BY NAME: a surviving exit keeps its
     * children on its new port; a removed exit's connections are dropped. An exit's name is its only
     * identity, so a renamed exit counts as one removed plus one added (its children are dropped).
     * outputs: the node's Drawflow outputs before the change (output_k = old exit k).
     */
    function remapExits(oldExits, newExits, outputs) {
        const connections = [], dropped = [];
        oldExits.forEach((exit, i) => {
            const conns = (outputs || {})[`output_${i + 1}`]?.connections || [];
            const j = newExits.indexOf(exit);
            if (j < 0) {
                if (conns.length) dropped.push({ exit, count: conns.length });
                return;
            }
            for (const c of conns) connections.push({ port: `output_${j + 1}`, node: String(c.node), input: c.output });
        });
        return { connections, dropped };
    }

    /** A loaded config whose exits / mcp_tools are null or not arrays (or exits empty) takes the defaults. */
    function normalizeConfig(cfg, defaults) {
        const out = { ...cfg };
        out.exits = Array.isArray(cfg.exits) && cfg.exits.length ? cfg.exits : [...defaults.exits];
        out.mcp_tools = Array.isArray(cfg.mcp_tools) ? cfg.mcp_tools : [...defaults.mcp_tools];
        return out;
    }

    return { EXIT_RE, TOOL_RE, TEMPLATES, validateConfig, exitForPort, portForExit, targetsForExit, parentsFor, edgesFrom,
             failureResult, routeAfter, runSucceeded, remapExits, normalizeConfig };
});
