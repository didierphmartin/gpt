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

    // Templates name the servers they need by slug; picking one checks the user's servers with that slug.
    // trigger: the exit that carries work -- the template can start a workflow (Start's "Poll a source").
    // call: the tool call whose literal argument dict the form edits (one field per key, typed by its default).
    const TEMPLATES = {
        blank: {
            label: 'Blank (pass-through)',
            exits: ['next'],
            servers: [],
            code: [
                'def run(input, call_tool):',
                '    # input: what the parent node(s) produced (the Start prompt when wired to Start).',
                '    #   One parent: its text, or the decoded value when it is JSON.',
                '    #   Several parents: a dict {parent name: value}.',
                '    #',
                '    # call_tool(server, tool, args) calls a tool on a server checked in "MCP Servers";',
                '    #   server is its name in lowercase, other characters as _ (e.g. "My Server" -> "my_server").',
                '    #',
                '    # Return the output. With several exits, return {"route": "<exit>", "output": ...}',
                '    #   to choose which exit the run continues on.',
                '    return input',
                '',
            ].join('\n'),
        },
        poll_servicenow: {
            label: 'Example: poll ServiceNow jobs',
            exits: ['job', 'no_job', 'error'],
            servers: ['servicenow'],
            trigger: 'job',
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
        poll_outlook: {
            label: 'Poll Outlook (new email)',
            exits: ['new_mail', 'no_mail', 'error'],
            servers: ['outlook'],
            trigger: 'new_mail',
            call: { server: 'outlook', tool: 'poll_new_mail', args: { folder: 'Inbox', from: '', subject_contains: '', has_attachments: false } },
            code: [
                'def run(input, call_tool):',
                '    # The next unseen email in the folder that matches the filters, or None.',
                '    # Attachments arrive as a list (id, name, content_type, size) and are NEVER opened here:',
                '    # a triage step decides first; only agents downstream of it may open them.',
                '    result = call_tool("outlook", "poll_new_mail", {',
                '        "folder": "Inbox",',
                '        "from": "",',
                '        "subject_contains": "",',
                '        "has_attachments": False,',
                '    })',
                '    if result.get("error"):',
                '        return {"route": "error", "output": result["error"]}',
                '    mail = result.get("mail")',
                '    if mail is None:',
                '        return {"route": "no_mail", "output": None}',
                '    return {"route": "new_mail", "output": mail}',
                '',
            ].join('\n'),
        },
    };
    const DEFAULT_TEMPLATE = 'blank';

    /** The server slug call_tool uses: twin of CodeNodeEmit::slug. */
    function slug(serverName) {
        return String(serverName).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    }

    const reEscape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /** call_tool("<server>", "<tool>", {...}) in the code: group 1 the head, group 2 the dict's lines. */
    const callRe = (call) => new RegExp(`(call_tool\\("${reEscape(call.server)}",\\s*"${reEscape(call.tool)}",\\s*)\\{([\\s\\S]*?)\\n\\s*\\}\\)`);
    const ARG_LINE_RE = /^\s*"(\w+)":\s*("(?:[^"\\]|\\.)*"|True|False),?\s*$/;

    /** Does the code call this template call's tool at all (form-shaped dict or not)? */
    function hasCall(code, call) {
        return !!call && String(code || '').includes(`call_tool("${call.server}", "${call.tool}"`);
    }

    /**
     * The values in the code's argument dict for `call`, when the dict is exactly what the form writes:
     * the call's keys, each once, each a literal of its default's type. null otherwise -- no dict, or a
     * dict edited by hand (an extra key, a variable, ...): the form then leaves the code alone.
     */
    function readCallArgs(code, call) {
        const m = call && String(code || '').match(callRe(call));
        if (!m) return null;
        const defaults = call.args || {};
        const out = {};
        for (const line of m[2].split('\n').filter((l) => l.trim())) {
            const v = line.match(ARG_LINE_RE);
            if (!v || !(v[1] in defaults) || v[1] in out) return null;
            const isBool = v[2] === 'True' || v[2] === 'False';
            if (isBool !== (typeof defaults[v[1]] === 'boolean')) return null;
            try { out[v[1]] = isBool ? v[2] === 'True' : JSON.parse(v[2]); } catch (_) { return null; }
        }
        return Object.keys(out).length === Object.keys(defaults).length ? out : null;
    }

    /** The form's values written into the code's dict for `call`; null when the form does not own that dict. */
    function writeCallArgs(code, call, values) {
        if (readCallArgs(code, call) === null) return null;
        const defaults = call.args || {};
        const py = (v) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : JSON.stringify(String(v)));
        const body = Object.keys(defaults).map((k) => `        "${k}": ${py(values[k] ?? defaults[k])},`).join('\n');
        return code.replace(callRe(call), (_, head) => `${head}{\n${body}\n    })`);
    }

    /** The template whose call the code makes, or null: the form's argument fields follow it. */
    function callTemplate(code) {
        return Object.values(TEMPLATES).find((t) => hasCall(code, t.call)) || null;
    }

    // A server that signs in a user implements these tools; connect_status names the header for its key.
    const CONNECT_TOOLS = ['connect_start', 'connect_status', 'whoami'];

    /** Does a server's tools/list answer offer the connect contract? */
    function isConnectable(toolNames) {
        const have = new Set(toolNames || []);
        return CONNECT_TOOLS.every((n) => have.has(n));
    }

    function validateConfig(cfg) {
        const errs = [];
        if (!String(cfg.code || '').includes('def run(')) errs.push('The code must define run(input, call_tool).');
        const exits = Array.isArray(cfg.exits) ? cfg.exits : [];
        if (exits.length < 1 || exits.length > 8) errs.push('A code node has 1 to 8 exits.');
        exits.forEach((e) => { if (!EXIT_RE.test(e)) errs.push(`Exit "${e}": lowercase letters, digits and _ only.`); });
        if (new Set(exits).size !== exits.length) errs.push('Exit names must be unique.');
        if (!Array.isArray(cfg.mcp_servers)) errs.push('MCP servers: a list of server names.');
        else cfg.mcp_servers.forEach((n) => { if (typeof n !== 'string' || !n.trim()) errs.push('MCP servers: an empty server name.'); });
        const t = Number(cfg.timeout_s);
        if (!Number.isInteger(t) || t < 1 || t > 300) errs.push('Timeout: 1 to 300 seconds.');
        return errs;
    }

    /** The Exits field: comma-separated names; empty means no branching -- the single default exit. */
    function parseExits(text) {
        const exits = String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
        return exits.length ? exits : ['next'];
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

    /**
     * The parents that ran, as the harness wants them; a parent with no output (skipped) is left out.
     * A dispatcher parent (isDispatcher) stands for its own parents: a branch receives what the
     * dispatcher received (the email), not the agent-framed context it was handed.
     */
    function parentsFor(nodeId, nodes, outputs, kindOf, isDispatcher = () => false, seen = new Set()) {
        const res = [];
        const ins = nodes[nodeId]?.inputs || {};
        for (const k of Object.keys(ins)) {
            for (const c of ins[k].connections || []) {
                const u = String(c.node);
                if (isDispatcher(u)) {
                    if (!seen.has(u)) res.push(...parentsFor(u, nodes, outputs, kindOf, isDispatcher, seen.add(u)));
                    continue;
                }
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

    /** The no-exit state: the single default exit, shown nowhere (the node behaves like any other). */
    function isPlain(exits) {
        return !exits || (exits.length === 1 && exits[0] === 'next');
    }

    /** The Exits field's text: empty in the no-exit state. */
    function exitsText(exits) {
        return isPlain(exits) ? '' : exits.join(', ');
    }

    /** The node card's exit line ("1:job  2:no_job"): empty in the no-exit state. */
    function exitsLabel(exits) {
        return isPlain(exits) ? '' : exits.map((e, i) => `${i + 1}:${e}`).join('  ');
    }

    /** One tag per link leaving a code node: the exit its port stands for (a port past the exits has none, the no-exit state none at all). */
    function exitTags(nodeId, nodes) {
        const exits = nodes[nodeId]?.data?.exits || ['next'];
        if (isPlain(exits)) return [];
        return edgesFrom(nodeId, nodes[nodeId] || {})
            .map((e) => ({ to: e.to, port: e.from_port, exit: exitForPort(exits, e.from_port) }))
            .filter((t) => t.exit !== null);
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
     * Branching removed (one exit left, e.g. the Exits field cleared): every link moves onto the
     * single connector instead -- a target reached from several exits is linked once.
     * Branching added (one exit before): its links land on exit 1, unless its name is still an exit.
     */
    function remapExits(oldExits, newExits, outputs) {
        const connections = [], dropped = [];
        if (newExits.length === 1) {
            const seen = new Set();
            oldExits.forEach((_, i) => {
                for (const c of (outputs || {})[`output_${i + 1}`]?.connections || []) {
                    const key = `${c.node}|${c.output}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    connections.push({ port: 'output_1', node: String(c.node), input: c.output });
                }
            });
            return { connections, dropped };
        }
        oldExits.forEach((exit, i) => {
            const conns = (outputs || {})[`output_${i + 1}`]?.connections || [];
            // Branching added: the single exit's links land on exit 1 unless its name survives.
            const j = oldExits.length === 1 && !newExits.includes(exit) ? 0 : newExits.indexOf(exit);
            if (j < 0) {
                if (conns.length) dropped.push({ exit, count: conns.length });
                return;
            }
            for (const c of conns) connections.push({ port: `output_${j + 1}`, node: String(c.node), input: c.output });
        });
        return { connections, dropped };
    }

    /** A loaded config whose exits / mcp_servers are null or not arrays (or exits empty) takes the defaults. */
    function normalizeConfig(cfg, defaults) {
        const out = { ...cfg };
        out.exits = Array.isArray(cfg.exits) && cfg.exits.length ? cfg.exits : [...defaults.exits];
        out.mcp_servers = Array.isArray(cfg.mcp_servers) ? cfg.mcp_servers : [...defaults.mcp_servers];
        return out;
    }

    /**
     * A run's record in the agent nodes' shape (nodeExecutionData), so the Input, Output and Logs
     * tabs show it: input as the node received it, output (the error on failure), and one activity
     * line per tool call, the printed text and the exit taken. `r` stays whole under `code`.
     */
    function runData(r, { parents, user_prompt, name, ts }) {
        const input = !parents.length ? String(user_prompt || '')
            : parents.length === 1 ? parents[0].text
            : parents.map((p) => `## ${p.name}\n${p.text}`).join('\n\n');
        const at = (level, message) => ({ ts, level, phase: level === 'error' ? 'error' : 'step', message });
        const activity = (r.tool_calls || []).map((c) => at(c.ok ? 'info' : 'error',
            `call_tool ${c.server}.${c.tool} ${JSON.stringify(c.args || {})} → ${c.ok ? 'ok' : 'failed'} (${c.ms} ms)`));
        if (r.stdout) activity.push(at('info', 'printed:\n' + r.stdout.replace(/\n$/, '')));
        if (r.ok) activity.push(at(r.route === 'error' ? 'warn' : 'info', `exit: ${r.route}`));
        else activity.push(at('error', r.error));
        return { input, output: r.ok ? r.output_text : r.error, success: !!r.ok, agentName: name, activity, code: r };
    }

    return { EXIT_RE, TEMPLATES, DEFAULT_TEMPLATE, slug, hasCall, readCallArgs, writeCallArgs, callTemplate, CONNECT_TOOLS, isConnectable, parseExits, isPlain, exitsText, exitsLabel, validateConfig, exitForPort, portForExit, targetsForExit, parentsFor,
             edgesFrom, exitTags, failureResult, routeAfter, runSucceeded, remapExits, normalizeConfig, runData };
});
