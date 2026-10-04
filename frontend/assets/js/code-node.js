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
                res.push({ name: start ? 'start' : (d.agent_name || d.name || `node ${u}`), text: String(text), start });
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

    return { EXIT_RE, TOOL_RE, TEMPLATES, validateConfig, exitForPort, portForExit, targetsForExit, parentsFor, edgesFrom };
});
