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
            if ((n.node_type === 'playbook' || n.node_type === 'agent') && n.config && playbookIdByOldId) {
                const raw = n.config.playbook_id;
                const id = raw === undefined || raw === null || raw === '' ? undefined : playbookIdByOldId.get(Number(raw));
                if (id !== undefined) out.config = { ...(out.config || n.config), playbook_id: id };
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

    /** A name usable as one file name: runs of other characters become "_". */
    function safeFileName(name) {
        return String(name || '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.]+|_+$/g, '') || 'item';
    }

    const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

    /** A server's registration for the package: never a header value, only whether it needs a key. */
    function serverRegistration(s) {
        const headers = s.headers && typeof s.headers === 'object' ? s.headers : {};
        return {
            name: s.name, url: s.url || '', description: s.description || '', transport: s.transport || 'http',
            is_mock: truthy(s.is_mock),
            needs_auth: Object.keys(headers).some((k) => k.toLowerCase() === 'authorization'),
            old_id: isId(s.id) ? Number(s.id) : null,
            local: !!s.local,
            // A global server (no owner) carries its keys on the administrator's side.
            global: s.user_id === null || s.user_id === undefined || s.user_id === '',
        };
    }

    /** manifest.json: format + one entry per dependency, with where its files sit in the zip. */
    function buildManifest({ workflowName, deps, servers, components, playbooks, skills, strippedSecrets }) {
        const unique = (used, base, ext) => {
            let name = base + ext;
            for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}_${k}${ext}`;
            used.add(name.toLowerCase());
            return name;
        };
        const compFiles = new Set(), pbFiles = new Set();
        const dependencies = [
            ...(skills || []).map((dir) => ({ kind: 'skill', name: dir, folder: `skills/${dir}/` })),
            ...(servers || []).map((s) => ({
                kind: 'server', ...serverRegistration(s),
                ...(s.local ? { folder: `mcps/${s.folder}/`, has_install_manifest: !!s.hasManifest } : {}),
            })),
            ...(components || []).map((c) => ({
                kind: 'component', name: c.name, old_id: Number(c.id),
                file: 'components/' + unique(compFiles, safeFileName(c.name), '.json'),
            })),
            ...(playbooks || []).map((p) => ({
                kind: 'playbook', name: p.title || p.pkey, pkey: p.pkey, old_id: Number(p.id),
                file: 'playbooks/' + unique(pbFiles, safeFileName(p.pkey), '.md'),
            })),
        ];
        return {
            format: 'synergyai-workflow-package', version: 1,
            workflow: { name: workflowName || '' },
            dependencies,
            strippedSecrets: strippedSecrets || [],
            warnings: (deps && deps.warnings) || [],
        };
    }


    const dec = (u8) => new TextDecoder().decode(u8);

    /** Decode a package's entries ({path: Uint8Array}) into manifest, workflow, servers and the raw files. */
    function readPackage(entries) {
        const files = entries || {};
        const json = (path, dflt) => { try { return files[path] ? JSON.parse(dec(files[path])) : dflt; } catch (e) { return dflt; } };
        const manifest = json('manifest.json', null);
        if (!manifest || manifest.format !== 'synergyai-workflow-package') throw new Error('not a workflow package');
        const servers = json('mcps/servers.json', []);
        return { manifest, workflow: json('workflow.json', null), servers: Array.isArray(servers) ? servers : [], files };
    }

    const componentContent = (c) => JSON.stringify([c.code, c.exits, c.mcp_servers, Number(c.timeout_s), c.args || [], c.provides || [], c.start_trigger || null]);

    /** The existing component row this one equals (same id + content, else same name + content), or null. */
    function matchComponent(item, rows) {
        const list = rows || [];
        const content = componentContent(item);
        return list.find((r) => item.id !== undefined && item.id !== null && String(r.id) === String(item.id) && componentContent(r) === content)
            || list.find((r) => norm(r.name) === norm(item.name) && componentContent(r) === content) || null;
    }

    function isLocalUrl(url) {
        const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(String(url || '').trim());
        return !!m && /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/i.test(m[1]);
    }

    /** One row per thing the package brings, with its status against what the user already has. */
    async function reviewRows(pkg, have) {
        const h = have || {};
        const files = pkg.files || {};
        const deps = (pkg.manifest && pkg.manifest.dependencies) || [];
        const rows = [];
        const base = (kind, name, destination) => ({ kind, name, status: 'install', destination, reasons: [], choice: null });

        // skills: every folder holding a SKILL.md under skills/
        const dirs = Object.keys(files).filter((p) => /^skills\/.+\/SKILL\.md$/.test(p)).map((p) => p.slice(7, -9));
        for (const dir of dirs) {
            const prefix = `skills/${dir}/`;
            const own = {};
            for (const p of Object.keys(files)) if (p.startsWith(prefix)) own[p.slice(prefix.length)] = files[p];
            const r = base('skill', dir, `skills/${dir}`);
            r.status = classify('skill', { dir, hash: await filesHash(own) }, h.skills).status;
            rows.push(r);
        }

        for (const s of pkg.servers || []) {
            const dep = deps.find((d) => d.kind === 'server' && d.name === s.name);
            const folder = s.local ? ((dep && dep.folder) ? dep.folder.replace(/\/$/, '') : `mcps/${s.name}`) : null;
            const r = base('server', s.name, folder);
            if (folder) {
                const mj = files[`${folder}/synergyai-mcp.json`], ex = files[`${folder}/.env.example`];
                let man = null;
                try { man = mj ? JSON.parse(dec(mj)) : null; } catch (e) { man = null; }
                const fields = envFields(man, ex ? dec(ex) : '');
                if (fields.some((f) => f.required)) { r.reasons.push('settings-required'); r.envFields = fields; }
            }
            if (isLocalUrl(s.url)) { r.reasons.push('localhost-url'); r.url = s.url; }
            if (s.needs_auth) r.reasons.push('needs-key');
            if (s.global) r.reasons.push('global-server');
            const cls = classify('server', s, h.servers).status;
            r.status = cls === 'clash' ? 'clash' : r.reasons.some((x) => x !== 'global-server') ? 'attention' : cls;
            rows.push(r);
        }

        for (const dep of deps.filter((d) => d.kind === 'component')) {
            const r = base('component', dep.name, null);
            const item = files[dep.file] ? JSON.parse(dec(files[dep.file])) : null;
            if (item) {
                if (matchComponent(item, h.components)) r.status = 'present';
                else if ((h.components || []).some((c) => norm(c.name) === norm(item.name || dep.name))) r.reasons.push('renamed');
            }
            rows.push(r);
        }

        for (const dep of deps.filter((d) => d.kind === 'playbook')) {
            const r = base('playbook', dep.pkey || dep.name, null);
            if (files[dep.file]) r.status = classify('playbook', mdToPlaybook(dec(files[dep.file])), h.playbooks).status;
            rows.push(r);
        }

        const stripped = (pkg.manifest && pkg.manifest.strippedSecrets) || [];
        if (stripped.length) rows.push({ kind: 'secrets', name: 'workflow keys', status: 'attention', destination: null, reasons: ['workflow-keys'], choice: null, fields: stripped });
        return rows;
    }

    /** May the import start? Clashes need a choice; required private settings need a value or "fill later". */
    function canConfirm(rows, values) {
        const vals = values || {};
        return (rows || []).every((r) => {
            if (r.choice === 'skip') return true;
            if (r.status === 'clash' && r.choice === null) return false;
            if (r.envFields && r.choice !== 'use-existing') {
                const v = vals[r.name] || {};
                if (missingRequired(r.envFields, v).length && !v.fillLater) return false;
            }
            return true;
        });
    }

    return { collectDependencies, SECRET_FIELD_RE, stripSecrets, DEFAULT_EXCLUDES, selectServerFiles, envFields, renderEnv, missingRequired, classify, playbookToMd, mdToPlaybook, relinkNodes, filesHash, safeFileName, serverRegistration, buildManifest, readPackage, matchComponent, reviewRows, canConfirm };
});
