/**
 * Workflow packages: pure helpers that find what a workflow depends on (skills, MCP servers, code
 * components, playbooks) so it can be exported as a zip with those dependencies and imported elsewhere.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.WorkflowPackage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const INGESTION_TYPES = ['loader', 'splitter', 'vectorstore'];

    const isId = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

    /**
     * What `nodes` (exportWorkflow().nodes) need. ctx.toolServers maps a tool name to the servers
     * offering it; ctx.serverNameById maps a registered server id to its name.
     */
    function collectDependencies(nodes, ctx) {
        const skills = new Set(), servers = new Set(), components = new Set(), playbooks = new Set();
        const warnings = [];
        let playbookAtRunTime = false;
        const toolServers = (ctx && ctx.toolServers) || new Map();
        const serverNameById = (ctx && ctx.serverNameById) || new Map();

        for (const node of nodes || []) {
            const cfg = node.config || {};
            const type = node.node_type;

            if (type === 'agent') {
                if (cfg.bound_skill && cfg.bound_skill.dir_name) skills.add(cfg.bound_skill.dir_name);
                for (const tool of cfg.tools || []) {
                    const owners = toolServers.get(tool) || [];
                    if (!owners.length) {
                        warnings.push({ kind: 'tool-missing', node: node.id, message: `Tool "${tool}" is offered by no registered server; nothing was bundled for it.` });
                        continue;
                    }
                    owners.forEach((s) => servers.add(s));
                    if (owners.length > 1) warnings.push({ kind: 'tool-ambiguous', node: node.id, message: `Tool "${tool}" is offered by several servers (${owners.join(', ')}); all were bundled.` });
                }
            }
            if (type === 'code') (cfg.mcp_servers || []).forEach((s) => servers.add(s));
            if (INGESTION_TYPES.includes(type) && typeof cfg.store === 'string') {
                const m = /^mcp:(\d+)$/.exec(cfg.store);
                const name = m && serverNameById.get(Number(m[1]));
                if (name) servers.add(name);
            }
            if (isId(cfg.code_component_id)) components.add(Number(cfg.code_component_id));
            if (type === 'start' && isId(cfg.start_option)) components.add(Number(cfg.start_option));
            if ((type === 'playbook' || type === 'agent') && isId(cfg.playbook_id)) playbooks.add(Number(cfg.playbook_id));
            if (type === 'playbook' && cfg.playbook_source === 'input') playbookAtRunTime = true;
        }

        const byNumber = (a, b) => a - b;
        return {
            skills: [...skills].sort(),
            servers: [...servers].sort(),
            components: [...components].sort(byNumber),
            playbooks: [...playbooks].sort(byNumber),
            playbookAtRunTime,
            warnings,
        };
    }

    const SECRET_FIELD_RE = /key|secret|token|password|passwd|credential/i;

    /** Copy of `nodes` with secret-looking fields removed from each config.connection; input untouched. */
    function stripSecrets(nodes) {
        const stripped = [];
        const out = (nodes || []).map((node) => {
            const conn = node && node.config && node.config.connection;
            if (!conn || typeof conn !== 'object') return node;
            const clean = {};
            for (const [k, v] of Object.entries(conn)) {
                if (SECRET_FIELD_RE.test(k)) stripped.push({ node: node.id, field: k });
                else clean[k] = v;
            }
            return { ...node, config: { ...node.config, connection: clean } };
        });
        return { nodes: out, stripped };
    }

    const DEFAULT_EXCLUDES = ['.venv/', 'venv/', 'node_modules/', 'vendor/', '__pycache__/', 'dist/', 'build/', '.git/', 'log/', 'logs/', 'tests/', 'docs/', '.env', '*.sqlite*', '*.log'];

    const globRe = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

    // "dir/" = that directory name at any depth; no "/" = basename at any depth; inner "/" = whole path.
    function matches(path, pattern) {
        const segs = path.split('/');
        if (pattern.endsWith('/')) return segs.slice(0, -1).includes(pattern.slice(0, -1));
        if (pattern.includes('/')) return globRe(pattern).test(path);
        return globRe(pattern).test(segs[segs.length - 1]);
    }

    /** Which of `paths` (relative to the server folder) are shipped: include (if any), then exclude + defaults. */
    function selectServerFiles(paths, manifest) {
        const include = manifest && Array.isArray(manifest.include) && manifest.include.length ? manifest.include : null;
        const exclude = DEFAULT_EXCLUDES.concat((manifest && manifest.exclude) || []);
        return (paths || []).filter((p) => {
            const segs = p.split('/');
            if (segs.slice(0, -1).some((s) => s.startsWith('.'))) return false;
            if (segs[segs.length - 1].startsWith('.') && segs[segs.length - 1] !== '.env.example') return false;
            if (exclude.some((x) => matches(p, x))) return false;
            return !include || include.some((x) => matches(p, x));
        });
    }

    const unquote = (v) => (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v);

    /** Private settings a server needs: manifest.env wins, else parsed from its .env.example. */
    function envFields(manifest, envExampleText) {
        const norm = (f) => ({
            name: f.name, label: f.label || '', required: !!f.required,
            secret: f.secret !== undefined ? !!f.secret : SECRET_FIELD_RE.test(f.name),
            default: f.default === undefined || f.default === null ? '' : String(f.default),
        });
        if (manifest && Array.isArray(manifest.env)) return manifest.env.map((f) => norm({ ...f, secret: f.secret }));
        const fields = [];
        let pending = [];
        for (const raw of String(envExampleText || '').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) { pending = []; continue; }
            if (line.startsWith('#')) { pending.push(line.replace(/^#+\s*/, '').trim()); continue; }
            const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
            if (!m) { pending = []; continue; }
            fields.push(norm({ name: m[1], label: pending.join(' '), default: unquote(m[2].trim()) }));
            pending = [];
        }
        return fields;
    }

    /** KEY=value lines for the server's .env; values with spaces, # or quotes are double-quoted. */
    function renderEnv(values) {
        return Object.entries(values || {}).map(([k, v]) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error('invalid setting name: ' + k);
            const str = String(v === undefined || v === null ? '' : v);
            if (!/[\s#"'\\]/.test(str)) return `${k}=${str}`;
            const esc = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r\n|\n|\r/g, '\\n');
            return `${k}="${esc}"`;
        }).join('\n') + '\n';
    }

    /** Names of required fields with no value. */
    function missingRequired(fields, values) {
        return (fields || []).filter((f) => f.required && !String((values || {})[f.name] || '').trim()).map((f) => f.name);
    }

    const norm = (v) => String(v === undefined || v === null ? '' : v).trim().toLowerCase();

    /** present = identical item already here; clash = same name, different content; install = new. */
    function classify(kind, incoming, existing) {
        const nameKey = { server: 'name', playbook: 'pkey', skill: 'dir' }[kind];
        if (!nameKey) throw new Error('unknown kind: ' + kind);
        const match = (existing || []).find((e) => norm(e[nameKey]) === norm(incoming[nameKey]));
        if (!match) return { status: 'install' };
        let same;
        if (kind === 'server') same = norm(match.name) === norm(incoming.name) && String(match.url || '').trim() === String(incoming.url || '').trim();
        else if (kind === 'playbook') same = match.text === incoming.text;
        else same = match.hash === incoming.hash;
        return same ? { status: 'present', match } : { status: 'clash', match };
    }

    function playbookToMd(p) {
        return `---\npkey: ${p.pkey}\ntitle: ${p.title}\n---\n${p.text}`;
    }

    function mdToPlaybook(md) {
        const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(String(md));
        if (!m) throw new Error('not a playbook file');
        const out = { pkey: '', title: '', text: m[2] };
        for (const line of m[1].split(/\r?\n/)) {
            const i = line.indexOf(': ');
            const key = i < 0 ? line.replace(/:$/, '') : line.slice(0, i);
            if (key === 'pkey' || key === 'title') out[key] = i < 0 ? '' : line.slice(i + 2);
        }
        return { pkey: out.pkey, title: out.title, text: out.text };
    }

    /** Rewrite server / playbook ids to this install's ids; returns new nodes, inputs untouched. */
    function relinkNodes(nodes, maps) {
        const { serverNameByOldId, serverIdByName, playbookIdByOldId } = maps || {};
        return (nodes || []).map((n) => {
            const out = { ...n };
            if (['loader', 'splitter', 'vectorstore'].includes(n.node_type) && n.config && typeof n.config.store === 'string') {
                const m = /^mcp:(\d+)$/.exec(n.config.store);
                const name = m && serverNameByOldId && serverNameByOldId.get(Number(m[1]));
                const id = name !== undefined && serverIdByName ? serverIdByName.get(name) : undefined;
                if (id !== undefined) out.config = { ...n.config, store: 'mcp:' + id };
            }
            if ((n.node_type === 'playbook' || n.node_type === 'agent') && n.playbook_id !== undefined && n.playbook_id !== null && playbookIdByOldId) {
                const id = playbookIdByOldId.get(n.playbook_id);
                if (id !== undefined) out.playbook_id = id;
            }
            return out;
        });
    }

    /** SHA-256 hex over path-sorted entries: path \0 bytes \0. */
    async function filesHash(files) {
        const enc = new TextEncoder();
        const parts = [];
        for (const path of Object.keys(files).sort()) {
            parts.push(enc.encode(path), new Uint8Array([0]), files[path], new Uint8Array([0]));
        }
        const buf = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
        let off = 0;
        for (const p of parts) { buf.set(p, off); off += p.length; }
        const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf));
        return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    return { collectDependencies, SECRET_FIELD_RE, stripSecrets, DEFAULT_EXCLUDES, selectServerFiles, envFields, renderEnv, missingRequired, classify, playbookToMd, mdToPlaybook, relinkNodes, filesHash };
});
