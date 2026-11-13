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
    const own = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
    /** o[k] only when it is o's own property (package data may name "__proto__", "constructor" ...). */
    const pick = (o, k) => (own(o, k) ? o[k] : undefined);

    /** One folder / file name with no way out of its parent: non-empty, no "/", "\\" or "..", no leading ".". */
    function isSafeSegment(s) {
        return typeof s === 'string' && !!s && !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.startsWith('.');
    }
    /** A playbook key (twin of playbook-collection.js isValidKey). */
    const isPlaybookKey = (k) => typeof k === 'string' && k.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(k);
    /** A skill folder: one or two safe segments ("pdf", "GEO/geo-compare"). */
    const isSkillDir = (d) => typeof d === 'string' && d.split('/').length <= 2 && d.split('/').every(isSafeSegment);

    const WRITE_ROOTS = ['skills', 'mcps', 'components', 'playbooks'];
    /**
     * May the installer write `path`? Under one of WRITE_ROOTS (or that root itself), no empty, ".", ".."
     * or backslash segment, no segment starting with "." except a final ".env.example" -- or ".env"
     * when `allowEnv` (only the installer's own settings file).
     */
    function isSafeWritePath(path, root, allowEnv) {
        if (typeof path !== 'string' || !WRITE_ROOTS.includes(root)) return false;
        if (path === root) return true;
        if (!path.startsWith(root + '/')) return false;
        const segs = path.split('/');
        return segs.every((seg, i) => {
            if (!seg || seg === '.' || seg === '..' || seg.includes('\\')) return false;
            if (!seg.startsWith('.')) return true;
            return i === segs.length - 1 && (seg === '.env.example' || (allowEnv && seg === '.env'));
        });
    }

    /** Where a package skill goes: `skills/<dir>` from the manifest's kind:'skill' entries only. */
    function packageSkills(manifest) {
        const deps = (manifest && Array.isArray(manifest.dependencies)) ? manifest.dependencies : [];
        const seen = new Set();
        const out = [];
        for (const d of deps) {
            if (!d || d.kind !== 'skill') continue;
            const dir = String(d.name === undefined || d.name === null ? '' : d.name);
            if (seen.has(dir)) continue;
            seen.add(dir);
            out.push({ dir, safe: isSkillDir(dir) });
        }
        return out;
    }

    /** Where a package keeps one skill: a complete skill zip (folder + bundled libraries), named from the folder only. */
    const skillZipPath = (dir) => `skills/${dir}.skill.zip`;

    /** The skill zip reader: SkillZip is a browser global; in node it loads lazily (it requires this file). */
    function skillZipLib() {
        if (globalThis.SkillZip) return globalThis.SkillZip;
        if (typeof require === 'function') return require('./skill-zip.js');
        throw new Error('skill zip reader is not loaded');
    }

    /**
     * One package skill as skillsFs.importSkill wants it: { dir, name, files, pyodideWheels, nativeWheels, legacy }.
     * New packages carry skills/<dir>.skill.zip (manifest entry has `zip`); old ones a skills/<dir>/... folder.
     * Throws when the zip cannot be read or names another folder than the manifest entry.
     */
    function readPackageSkill(pkg, dir) {
        const files = pkg.files || {};
        const dep = ((pkg.manifest && pkg.manifest.dependencies) || []).find((d) => d && d.kind === 'skill' && String(d.name) === dir);
        if (dep && dep.zip) {
            const bytes = own(files, skillZipPath(dir)) ? files[skillZipPath(dir)] : null;
            if (!bytes) throw new Error('skill zip missing');
            const read = skillZipLib().read(bytes, { fallbackName: dir, fflate: globalThis.fflate });
            if (read.dir !== dir) throw new Error('skill zip names another folder');
            return read;
        }
        const prefix = `skills/${dir}/`;
        const tree = {};
        for (const p of Object.keys(files)) if (p.startsWith(prefix) && !isEnvFile(p)) tree[p.slice(prefix.length)] = files[p];
        return { dir, name: dir.split('/').pop(), files: tree, pyodideWheels: {}, nativeWheels: {}, legacy: true, manifest: null };
    }

    /** A local server's folder under mcps/ (reader-side: the manifest's folder or the server name), or null when unsafe. */
    function serverFolder(s, dep) {
        const raw = dep && dep.folder !== undefined && dep.folder !== null ? String(dep.folder) : null;
        let folder;
        if (raw !== null) {
            const m = /^mcps\/([^/]*)\/?$/.exec(raw);
            folder = m ? m[1] : null;
        } else folder = s && typeof s.name === 'string' ? s.name : null;
        return isSafeSegment(folder) ? folder : null;
    }

    /** Fixed file names for a playbook / component of the package (never the manifest's own file paths). */
    const playbookDestination = (pkey) => (isPlaybookKey(pkey) ? `playbooks/${safeFileName(pkey)}.md` : null);
    const componentBase = (name) => `components/${safeFileName(name)}`;

    /**
     * What each node needs that this install lacks: { [nodeId]: ['skill:<dir>', 'tool:<name>', 'server:<name>',
     * 'store:<id>', 'playbook:<id>', 'playbook_missing:', 'store_missing:'] } (the last two: a package import cleared a link it could not map). `have` lists what exists; a null list is unknown and skips its check.
     */
    function missingByNode(nodes, have) {
        const h = have || {};
        const skills = h.skills ? new Set(h.skills) : null;
        const serverNames = h.servers ? new Set(h.servers.map((s) => String(s.name).toLowerCase())) : null;
        const serverIds = h.servers ? new Set(h.servers.map((s) => Number(s.id))) : null;
        const playbooks = h.playbookIds ? new Set(h.playbookIds.map(Number)) : null;
        const out = {};
        for (const node of nodes || []) {
            const cfg = node.config || {};
            const type = node.node_type;
            const miss = [];
            if (type === 'agent') {
                const dir = cfg.bound_skill && cfg.bound_skill.dir_name;
                if (skills && dir && !skills.has(dir)) miss.push(`skill:${dir}`);
                if (h.tools) for (const tool of cfg.tools || []) if (!(h.tools.get(tool) || []).length) miss.push(`tool:${tool}`);
            }
            if (type === 'code' && serverNames) {
                for (const name of cfg.mcp_servers || []) if (!serverNames.has(String(name).toLowerCase())) miss.push(`server:${name}`);
            }
            if (INGESTION_TYPES.includes(type) && serverIds && typeof cfg.store === 'string') {
                const m = /^mcp:(\d+)$/.exec(cfg.store);
                if (m && !serverIds.has(Number(m[1]))) miss.push(`store:${m[1]}`);
            }
            if (playbooks && (type === 'playbook' || type === 'agent') && isId(cfg.playbook_id) && !playbooks.has(Number(cfg.playbook_id))) miss.push(`playbook:${Number(cfg.playbook_id)}`);
            // Ids an import could not map were cleared and flagged: the marker stands until a new link is set.
            if ((type === 'playbook' || type === 'agent') && cfg.playbook_missing === true && !isId(cfg.playbook_id)) miss.push('playbook_missing:');
            if (INGESTION_TYPES.includes(type) && cfg.store_missing === true && !cfg.store) miss.push('store_missing:');
            if (miss.length) out[node.id] = miss;
        }
        return out;
    }

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
                    // Agents store MCP tools as "mcp_<tool name>"; unprefixed names are built-in tools.
                    const isMcp = typeof tool === 'string' && tool.startsWith('mcp_');
                    const owners = (isMcp && toolServers.get(tool.slice(4))) || toolServers.get(tool) || [];
                    if (!owners.length) {
                        if (!isMcp) continue;
                        warnings.push({ kind: 'tool-missing', node: node.id, message: `Tool "${tool}" is offered by no registered server; nothing was bundled for it.` });
                        continue;
                    }
                    owners.forEach((s) => servers.add(s));
                    if (owners.length > 1) warnings.push({ kind: 'tool-ambiguous', node: node.id, message: `Tool "${tool}" is offered by several servers (${owners.join(', ')}); all were bundled.` });
                }
            }
            // Code nodes declare their servers; playbook (and playbook-agent) nodes keep the ones Validate found.
            if (Array.isArray(cfg.mcp_servers)) cfg.mcp_servers.forEach((s) => servers.add(s));
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

    // dsn / connection strings carry the password (pgvector DSN, Azure AccountKey) inside the value.
    const SECRET_FIELD_RE = /key|secret|token|password|passwd|credential|dsn|connection|connection_string|conn_str|connstr|auth|bearer|private/i;

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

    const DEFAULT_EXCLUDES = ['.venv/', 'venv/', 'node_modules/', 'vendor/', '__pycache__/', 'dist/', 'build/', '.git/', 'log/', 'logs/', 'tests/', 'docs/', '.env', '*.sqlite*', '*.log',
        // any settings file, whatever comes before ".env" (config/pdi.env held a ServiceNow login);
        // a ".env.example" does not end in ".env", so it still travels
        '*.env',
        // generic secret files
        '*.pem', '*.key', '*.p12', '*.pfx', 'credentials*.json', 'token*.json', '*secret*'];

    const globRe = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

    // "dir/" = that directory name at any depth; no "/" = basename at any depth; inner "/" = whole path.
    function matches(path, pattern) {
        const segs = path.split('/');
        if (pattern.endsWith('/')) return segs.slice(0, -1).includes(pattern.slice(0, -1));
        if (pattern.includes('/')) return globRe(pattern).test(path);
        return globRe(pattern).test(segs[segs.length - 1]);
    }

    /** The volume folder a registered URL points at (gateway + "/" + folder + ...), else null. */
    function hostFolderOf(url, gateway) {
        const gw = String(gateway || '').replace(/\/+$/, '');
        if (!gw || typeof url !== 'string' || !url.startsWith(gw + '/')) return null;
        const seg = url.slice(gw.length + 1).split(/[/?#]/)[0];
        return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(seg) ? seg : null;
    }

    /** A supervisor source answer ({files: {rel: base64}}) as { files: {"mcps/<folder>/<rel>": bytes}, manifest }. */
    function hostSourceFiles(folder, answer) {
        const files = {};
        let manifest = null;
        if (!isSafeSegment(folder)) return { files, manifest };
        for (const [rel, b64] of Object.entries((answer && answer.files) || {})) {
            const segs = rel.split('/');
            // a final .env.example travels (import derives the settings form from it); .env and other dotfiles don't
            if (!segs.every((seg, i) => isSafeSegment(seg) || (i === segs.length - 1 && seg === '.env.example'))) continue;
            const bin = atob(String(b64));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            files[`mcps/${folder}/${rel}`] = bytes;
            if (rel === 'synergyai-mcp.json') {
                try { manifest = JSON.parse(new TextDecoder().decode(bytes)) || null; } catch (_) { manifest = null; }
            }
        }
        return { files, manifest };
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
            // the install manifest itself always travels, whether or not include names it
            return !include || p === 'synergyai-mcp.json' || include.some((x) => matches(p, x));
        });
    }

    const unquote = (v) => (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v);

    /** Private settings a server needs: manifest.env wins, else parsed from its .env.example. */
    function envFields(manifest, envExampleText) {
        const norm = (f) => ({
            name: f.name, label: f.label || '', required: !!f.required,
            secret: f.secret !== undefined ? !!f.secret : SECRET_FIELD_RE.test(f.name),
            default: f.default === undefined || f.default === null ? '' : String(f.default),
            // Settings that go together: once one of a group is filled, the others are needed too.
            ...(typeof f.group === 'string' && f.group.trim() ? { group: f.group.trim() } : {}),
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

    /**
     * `existingText` with the declared `values` set: every other line (comments, undeclared keys) is kept,
     * a declared key's line is replaced in place, a declared key not there yet is appended. renderEnv's escaping.
     */
    function mergeEnv(existingText, values) {
        const vals = values || {};
        const line = (k) => renderEnv({ [k]: vals[k] }).replace(/\n$/, '');
        const keys = Object.keys(vals);
        keys.forEach((k) => line(k));   // invalid names throw before anything is merged
        const text = String(existingText || '');
        if (!text) return renderEnv(vals);
        const done = new Set();
        const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).map((raw) => {
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
            if (!m || !own(vals, m[1])) return raw;
            done.add(m[1]);
            return line(m[1]);
        });
        for (const k of keys) if (!done.has(k)) lines.push(line(k));
        return lines.join('\n') + '\n';
    }

    /** KEY=value lines back to { KEY: value } (renderEnv's inverse): "..." unescapes \\ \" \n, '...' is literal,
     *  an unquoted value ends at " #". Comments, blank and malformed lines are skipped. */
    function parseEnv(text) {
        const out = {};
        for (const raw of String(text || '').split(/\r?\n/)) {
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
            if (!m) continue;
            const rest = m[2].trim();
            let v;
            if (rest[0] === '"') {
                v = '';
                for (let i = 1; i < rest.length; i++) {
                    const c = rest[i];
                    if (c === '"') break;
                    if (c === '\\' && i + 1 < rest.length) {
                        const n = rest[++i];
                        v += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
                    } else v += c;
                }
            } else if (rest[0] === "'") {
                const end = rest.indexOf("'", 1);
                v = end === -1 ? rest.slice(1) : rest.slice(1, end);
            } else {
                v = rest.replace(/\s+#.*$/, '').trim();
            }
            out[m[1]] = v;
        }
        return out;
    }

    /**
     * Names of the fields still needed: a required one not filled, and in a group (fields sharing `group`)
     * where at least one is filled, every member not filled. isFilled(field) says whether a field has a value.
     */
    function missingSettings(fields, isFilled) {
        const list = fields || [];
        const started = new Set(list.filter((f) => f.group && isFilled(f)).map((f) => f.group));
        return list.filter((f) => !isFilled(f) && (f.required || (f.group && started.has(f.group)))).map((f) => f.name);
    }

    /** Names of the fields still needed for these values (missingSettings: required ones and started groups). */
    function missingRequired(fields, values) {
        return missingSettings(fields, (f) => !!String(pick(values, f.name) || '').trim());
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

    /**
     * Rewrite server / playbook ids to this install's ids; returns new nodes, inputs untouched.
     * maps.clearUnmapped (the package import): an id no map knows would point at an unrelated row here,
     * so it is cleared and flagged instead -- store '' + store_missing, playbook_id null + playbook_missing.
     */
    function relinkNodes(nodes, maps) {
        const { serverNameByOldId, serverIdByName, playbookIdByOldId, clearUnmapped } = maps || {};
        return (nodes || []).map((n) => {
            const out = { ...n };
            if (['loader', 'splitter', 'vectorstore'].includes(n.node_type) && n.config && typeof n.config.store === 'string') {
                const m = /^mcp:(\d+)$/.exec(n.config.store);
                const name = m && serverNameByOldId && serverNameByOldId.get(Number(m[1]));
                const id = name !== undefined && serverIdByName ? serverIdByName.get(name) : undefined;
                if (id !== undefined) out.config = { ...n.config, store: 'mcp:' + id };
                else if (m && clearUnmapped) out.config = { ...n.config, store: '', store_missing: true };
            }
            if ((n.node_type === 'playbook' || n.node_type === 'agent') && n.config && (playbookIdByOldId || clearUnmapped)) {
                const raw = n.config.playbook_id;
                const id = raw === undefined || raw === null || raw === '' || !playbookIdByOldId ? undefined : playbookIdByOldId.get(Number(raw));
                if (id !== undefined) out.config = { ...(out.config || n.config), playbook_id: id };
                else if (isId(raw) && clearUnmapped) out.config = { ...(out.config || n.config), playbook_id: null, playbook_missing: true };
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
            // Where a hosted server came from on GitHub: information only (the package always carries its files).
            ...(s.source && typeof s.source === 'object' ? { source: s.source } : {}),
        };
    }

    /** manifest.json: format + one entry per dependency, with where its files sit in the zip. */
    /**
     * A server's settings as the export carries them: every declared setting by name; a plain one with its value,
     * a secret one (declared secret, or a secret-looking name) always empty -- the person importing enters their own.
     * fields: envFields-shaped; values: { name: value }. Returns { name: value } (insertion order = fields order).
     */
    function exportSettings(fields, values) {
        const out = {};
        for (const f of fields || []) {
            if (!f || typeof f.name !== 'string' || !f.name) continue;
            const v = values && Object.prototype.hasOwnProperty.call(values, f.name) ? values[f.name] : undefined;
            out[f.name] = f.secret || SECRET_FIELD_RE.test(f.name) || v === undefined || v === null ? '' : String(v);
        }
        return out;
    }

    /** The plain values a package carries for these fields (secrets never, even if a package has one). */
    function carriedSettings(fields, settings) {
        const out = Object.create(null);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return out;
        for (const f of fields || []) {
            const v = Object.prototype.hasOwnProperty.call(settings, f.name) ? settings[f.name] : undefined;
            if (typeof v === 'string' && v !== '' && !f.secret && !SECRET_FIELD_RE.test(f.name)) out[f.name] = v;
        }
        return out;
    }

    function buildManifest({ workflowName, deps, servers, components, playbooks, skills, strippedSecrets }) {
        const unique = (used, base, ext) => {
            let name = base + ext;
            for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base}_${k}${ext}`;
            used.add(name.toLowerCase());
            return name;
        };
        const compFiles = new Set(), pbFiles = new Set();
        const dependencies = [
            ...(skills || []).map((dir) => ({ kind: 'skill', name: dir, zip: skillZipPath(dir) })),
            ...(servers || []).map((s) => ({
                kind: 'server', ...serverRegistration(s),
                ...(s.local ? { folder: `mcps/${s.folder}/`, has_install_manifest: !!s.hasManifest } : {}),
                // its settings: plain values filled in, secrets empty (exportSettings)
                ...(s.local && s.settings && typeof s.settings === 'object' ? { settings: s.settings } : {}),
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
    const isEnvFile = (p) => p.split('/').pop() === '.env';   // a package never ships one; never copied
    /** The key of the review's workflow-keys values: a Symbol, so no server name can collide with it. */
    const WORKFLOW_KEYS = Symbol('workflow keys');

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
        const unsafe = (r) => { r.status = 'attention'; r.reasons.push('unsafe-path'); r.destination = null; rows.push(r); };

        // skills: the manifest's kind:'skill' entries -- a skill zip each (old packages: a folder of files)
        for (const { dir, safe } of packageSkills(pkg.manifest)) {
            const r = base('skill', dir, `skills/${dir}`);
            if (!safe) { unsafe(r); continue; }
            const dep = deps.find((d) => d && d.kind === 'skill' && String(d.name) === dir);
            const prefix = `skills/${dir}/`;
            if (!(dep && dep.zip)) {
                const paths = Object.keys(files).filter((p) => p.startsWith(prefix));
                if (paths.some((p) => !isEnvFile(p) && !isSafeWritePath(p, 'skills'))) { unsafe(r); continue; }
                if (!files[`${prefix}SKILL.md`]) { r.status = 'attention'; r.reasons.push('unreadable'); rows.push(r); continue; }
            }
            let read;
            try { read = readPackageSkill(pkg, dir); } catch (e) { r.status = 'attention'; r.reasons.push('unreadable'); rows.push(r); continue; }
            r.status = classify('skill', { dir, hash: await filesHash(read.files) }, h.skills).status;
            r.requires = (read.requires || []).map((x) => x.dir);   // the skills it needs, carried in its zip
            // A different skill already installed under the name of one it needs: shown here, before Install.
            r.requiredClash = [];
            for (const x of read.requires || []) {
                if (classify('skill', { dir: x.dir, hash: await filesHash(x.files) }, h.skills).status === 'clash') r.requiredClash.push(x.dir);
            }
            if (r.requiredClash.length && r.status !== 'present') { r.status = 'attention'; r.reasons.push('required-clash'); }
            rows.push(r);
        }

        for (const s of pkg.servers || []) {
            const dep = deps.find((d) => d.kind === 'server' && d.name === s.name);
            const r = base('server', s.name, null);
            if (s.local) {
                const f = serverFolder(s, dep);
                const prefix = `mcps/${f}/`;
                if (!f || Object.keys(files).some((p) => p.startsWith(prefix) && !isEnvFile(p) && !isSafeWritePath(p, 'mcps'))) { unsafe(r); continue; }
                r.destination = `mcps/${f}`;
                if (h.host) r.volume = true;
            }
            const folder = r.destination;
            const cls = classify('server', s, h.servers).status;
            // Not registered here, but its folder is already in the user's folder (e.g. another install shares it).
            if (folder && cls === 'install' && ((h.host ? h.hostFolders : h.serverFolders) || []).includes(folder.slice('mcps/'.length))) {
                r.folderExists = true;
                r.reasons.push('folder-exists');
            }
            if (folder && cls !== 'present') {
                const mj = files[`${folder}/synergyai-mcp.json`], ex = files[`${folder}/.env.example`];
                let man = null;
                try { man = mj ? JSON.parse(dec(mj)) : null; } catch (e) { man = null; }
                const fields = envFields(man, ex ? dec(ex) : '');
                // the plain values the package carries pre-fill the form; secrets stay for the importer to enter
                const carried = carriedSettings(fields, dep && dep.settings);
                if (fields.some((f) => f.required)) r.reasons.push('settings-required');
                if (fields.some((f) => f.required) || Object.keys(carried).length) { r.envFields = fields; r.carried = carried; }
            }
            if (!(h.host && s.local) && isLocalUrl(s.url)) { r.reasons.push('localhost-url'); r.url = s.url; }
            if (s.needs_auth) r.reasons.push('needs-key');
            if (s.global) r.reasons.push('global-server');
            if (s.source && typeof s.source === 'object') r.source = s.source;
            r.status = r.folderExists ? 'clash' : cls !== 'install' ? cls : r.reasons.some((x) => x !== 'global-server') ? 'attention' : cls;
            rows.push(r);
        }

        for (const dep of deps.filter((d) => d.kind === 'component')) {
            const r = base('component', dep.name, null);
            let item = null;
            try { item = pick(files, dep.file) ? JSON.parse(dec(files[dep.file])) : null; } catch (e) { item = undefined; }
            if (item === undefined) { r.status = 'attention'; r.reasons.push('unreadable'); }
            else if (item) {
                if (matchComponent(item, h.components)) r.status = 'present';
                else if ((h.components || []).some((c) => norm(c.name) === norm(item.name || dep.name))) r.reasons.push('renamed');
            }
            rows.push(r);
        }

        for (const dep of deps.filter((d) => d.kind === 'playbook')) {
            const r = base('playbook', dep.pkey || dep.name, null);
            if (!playbookDestination(dep.pkey)) { unsafe(r); continue; }
            const raw = own(files, dep.file) ? files[dep.file] : null;
            if (raw) {
                let pb = null;
                try { pb = mdToPlaybook(dec(raw)); } catch (e) { pb = null; }
                if (pb) r.status = classify('playbook', pb, h.playbooks).status;
                else { r.status = 'attention'; r.reasons.push('unreadable'); }
            }
            rows.push(r);
        }

        const stripped = (pkg.manifest && pkg.manifest.strippedSecrets) || [];
        if (stripped.length) rows.push({ kind: 'secrets', name: 'workflow keys', status: 'attention', destination: null, reasons: ['workflow-keys'], choice: null, fields: stripped });
        return rows;
    }

    /** May the import start? Clashes need a choice; required private settings need a value or "fill later";
     *  an unreadable item or one whose files would land outside its folder must be skipped. */
    function canConfirm(rows, values) {
        const vals = values || {};
        return (rows || []).every((r) => {
            if (r.choice === 'skip') return true;
            if ((r.reasons || []).includes('unsafe-path')) return false;
            if (r.status === 'present') return true;
            if (r.status === 'clash' && r.choice === null) return false;
            if ((r.reasons || []).includes('unreadable') || (r.reasons || []).includes('required-clash')) return false;
            if (r.envFields && r.choice !== 'use-existing') {
                const v = pick(vals, r.name) || {};
                if (missingRequired(r.envFields, v).length && !pick(v, 'fillLater')) return false;
            }
            return true;
        });
    }

    /**
     * Install what the review rows say into the user's folder and this account, in the spec's order.
     * io (paths relative to the user's folder; writeFile creates parent folders):
     *   exists(path) -> boolean, ensureDir(path), writeFile(path, Uint8Array), readJson(path) -> obj|undefined, writeJson(path, obj),
     *   addServer({name,url,description,transport,is_mock,headers}) -> {id}, createPlaybook({pkey,title,text}) -> {id},
     *   importComponents(bundle, nodes) -> nodes, importSkill(read, {visibility}) -> {status, requires?} (throws .code 'clash'),
     *   checkSkill(read) -> [{dir, name, status}] (optional: skillsFs.importPlan; a 'clash' refuses before any write).
     * Skipped rows do nothing; use-existing / present rows write nothing but lend their existing id
     * (from `have`) to the re-link. Refuses (writing nothing) while a review item is unresolved or when a
     * skill folder, server folder or playbook file to install already exists, or when a path to write would leave its
     * kind's folder (skills/, mcps/, components/, playbooks/). Destinations come from names, never from the manifest's paths.
     * values: { [row name]: {...} } plus values[WORKFLOW_KEYS] for the workflow keys; only own properties are read.
     * Ids no row maps are cleared and flagged on the nodes (playbook_missing, store_missing, code_component_missing).
     * Any io failure rejects with the step and item named; err.installed lists what was done before it.
     * Returns { installed, commands, nodes }.
     */
    async function installPackage(rows, pkg, values, io, have) {
        const vals = values || {};
        const h = have || {};
        const files = pkg.files || {};
        const deps = (pkg.manifest && pkg.manifest.dependencies) || [];
        const installed = [], commands = [];
        const step = async (label, fn) => {
            try { return await fn(); } catch (e) {
                const err = new Error(`install failed at "${label}": ${e && e.message ? e.message : e}`);
                err.installed = installed.slice();
                err.cause = e;
                throw err;
            }
        };
        const active = (r) => r.choice !== 'skip';
        const toInstall = (r) => active(r) && r.choice !== 'use-existing' && r.status !== 'present';
        // A server whose folder is already there, kept as it is: registered, nothing written.
        const keepsFolder = (r) => !!r.folderExists && r.choice === 'use-existing';
        const ofKind = (k) => (rows || []).filter((r) => r.kind === k);
        const rowValues = (r) => pick(vals, r.name) || {};
        const parse = (path) => { try { return own(files, path) ? JSON.parse(dec(files[path])) : null; } catch (e) { return null; } };
        // A volume server's address (McpHostInstall.registrationUrl: <gw>/<folder>/<entry> for PHP); without one, the Python "/mcp".
        const hostUrl = typeof io.registrationUrl === 'function' ? io.registrationUrl
            : (gw, folder) => `${String(gw || '').replace(/\/+$/, '')}/${folder}/mcp`;
        const playbookDep = (r) => deps.find((d) => d.kind === 'playbook' && (d.pkey || d.name) === r.name);
        const serverOf = (r) => (pkg.servers || []).find((x) => x.name === r.name);
        const serverDep = (r) => deps.find((d) => d.kind === 'server' && d.name === r.name);
        const treeOf = (prefix) => Object.keys(files).filter((x) => x.startsWith(prefix) && !isEnvFile(x)).sort();

        // Every write goes through here: inside its kind's folder, no way out (".."), no dotfile but the settings files.
        const guard = (path, root, allowEnv) => {
            if (!isSafeWritePath(path, root, allowEnv)) throw new Error('install refused: unsafe path ' + path);
            return path;
        };
        const writeFile = (path, root, bytes, allowEnv) => io.writeFile(guard(path, root, allowEnv), bytes);

        if (!canConfirm(rows, vals)) throw new Error('install refused: unresolved items in the review');

        // Where each item to install goes, worked out here from names (never the manifest's paths), then checked.
        const skillDirs = new Set(packageSkills(pkg.manifest).filter((x) => x.safe).map((x) => x.dir));
        const plan = { skills: [], servers: [], playbooks: [], components: [] };
        for (const r of ofKind('skill').filter(toInstall)) {
            const dest = skillDirs.has(r.name) ? `skills/${r.name}` : null;
            let read = null;
            if (dest) try { read = readPackageSkill(pkg, r.name); } catch (e) { throw new Error(`install refused: skill ${r.name} cannot be read (${e.message})`); }
            plan.skills.push({ r, dest, read, paths: read && read.legacy ? Object.keys(read.files).map((f) => `${dest}/${f}`) : [] });
        }
        for (const r of ofKind('server').filter(toInstall)) {
            const s = serverOf(r);
            if (!s || !s.local) continue;
            const f = serverFolder(s, serverDep(r));
            const dest = f ? `mcps/${f}` : null;
            plan.servers.push({ r, folder: f, dest, paths: dest ? treeOf(`${dest}/`) : [] });
        }
        for (const r of ofKind('playbook').filter(toInstall)) {
            const d = playbookDep(r);
            if (!d || !own(files, d.file) || !files[d.file]) continue;
            plan.playbooks.push({ r, dep: d, dest: playbookDestination(d.pkey) });
        }
        const unsafePaths = [
            ...plan.skills.flatMap((x) => (x.dest ? x.paths.filter((p) => !isSafeWritePath(p, 'skills')) : [`skill ${x.r.name}`])),
            ...plan.servers.flatMap((x) => (x.dest ? x.paths.filter((p) => !isSafeWritePath(p, 'mcps')).concat(isSafeWritePath(`${x.dest}/.env`, 'mcps', true) ? [] : [`${x.dest}/.env`])
                : [`server ${x.r.name}`])),
            ...plan.playbooks.filter((x) => !x.dest).map((x) => `playbook ${x.r.name}`),
        ];
        if (unsafePaths.length) throw new Error('install refused: unsafe path ' + unsafePaths.join(', '));
        // A volume server is registered at the host's gateway: without one its address would be "/<folder>/mcp".
        const volumeServers = ofKind('server').filter(active).some((r) => serverOf(r)?.local && (toInstall(r) || keepsFolder(r)));
        if (h.host && volumeServers && !String(h.host.gateway || '').trim()) throw new Error('install refused: the server host has no gateway address');

        // Never overwrite: every destination of an item to install must be free before anything is written.
        // (a server going to the Docker app's volume is checked by the host: a taken folder answers 409.)
        const targets = [...(h.host ? [] : plan.servers.map((x) => x.dest)), ...plan.playbooks.map((x) => x.dest)];
        const taken = [];
        for (const t of targets) if (await step(`check ${t}`, () => io.exists(t))) taken.push(t);
        if (taken.length) throw new Error('install refused: would overwrite ' + taken.join(', '));
        // Skills (and the skills each requires): a different skill already there under any of their names stops it all.
        if (typeof io.checkSkill === 'function') {
            for (const { read } of plan.skills) {
                if (!read) continue;
                const hit = ((await step(`check skill ${read.dir}`, () => io.checkSkill(read))) || []).find((x) => x.status === 'clash');
                if (hit) throw new Error(`install refused: a different skill named ${hit.name || hit.dir} is already installed`);
            }
        }

        for (const dir of WRITE_ROOTS.filter((d) => !(h.host && d === 'mcps'))) await step(`create folder ${dir}`, () => io.ensureDir(guard(dir, dir)));

        // Skills go through the skill store (a folder or the Docker app's store), private to the user.
        for (const { r, dest, read } of plan.skills) {
            if (typeof io.importSkill !== 'function') throw new Error('install refused: no skill installer');
            const res = await step(`install skill ${r.name}`, () => io.importSkill(read, { visibility: 'private' }));
            for (const q of (res && res.requires) || []) {
                installed.push({ kind: 'skill', name: q.dir, destination: `skills/${q.dir}`, requiredBy: r.name, ...(q.status === 'identical' ? { alreadyInstalled: true } : {}) });
            }
            installed.push({ kind: 'skill', name: r.name, destination: dest, ...(res && res.status === 'identical' ? { alreadyInstalled: true } : {}) });
        }

        // Local server source + private settings, then the name -> folder map.
        const map = Object.create(null);
        const volumeState = new Map();
        for (const { r, folder, dest, paths } of plan.servers) {
            if (h.host) {
                // Docker app: the files and settings go to the server host's volume; nothing in the user's folder.
                const v = rowValues(r);
                const man = parse(`${dest}/synergyai-mcp.json`);
                const ex = pick(files, `${dest}/.env.example`);
                // what the form holds is saved; "fill in later" only lets missing ones wait
                const env = Object.create(null);
                for (const f of envFields(man, ex ? dec(ex) : '')) { const x = pick(v, f.name); env[f.name] = x !== undefined && x !== null ? x : f.default; }
                for (const k of Object.keys(env)) if (env[k] === '') delete env[k];   // blank: the server's own default applies
                const sent = Object.create(null);
                for (const p of paths) sent[p.slice(dest.length + 1)] = files[p];
                const srv = serverOf(r);
                const source = srv && srv.source && typeof srv.source === 'object' ? srv.source : null;   // information only
                const res = await step(`install server ${r.name}`, () => io.installServer(folder, { name: r.name, files: sent, env, source }));
                volumeState.set(r.name, res || {});
                map[r.name] = folder;
                continue;
            }
            for (const p of paths) await step(`write server ${r.name}: ${p}`, () => writeFile(p, 'mcps', files[p]));
            installed.push({ kind: 'server-files', name: r.name, destination: dest });
            const v = rowValues(r);
            const ex = pick(files, `${dest}/.env.example`);
            const man = parse(`${dest}/synergyai-mcp.json`);
            const fields = envFields(man, ex ? dec(ex) : '');
            // what the form holds is saved; "fill in later" only lets missing ones wait
            const env = Object.create(null);
            for (const f of fields) { const x = pick(v, f.name); env[f.name] = x !== undefined && x !== null ? x : f.default; }
            for (const k of Object.keys(env)) if (env[k] === '') delete env[k];   // blank: the server's own default applies
            if (fields.length) {
                await step(`write settings for ${r.name}`, () => writeFile(`${dest}/.env`, 'mcps', new TextEncoder().encode(renderEnv(env)), true));
            }
            map[r.name] = folder;
            commands.push({ server: r.name, install: (man && man.install) || null, start: (man && man.start) || null });
        }
        for (const r of ofKind('server').filter(keepsFolder)) {
            const folder = r.destination.slice('mcps/'.length);
            const man = parse(`${r.destination}/synergyai-mcp.json`);
            map[r.name] = folder;
            if (h.host) continue;
            commands.push({ server: r.name, install: (man && man.install) || null, start: (man && man.start) || null });
        }
        if (!h.host && Object.keys(map).length) {
            await step('update mcps/servers.json', async () => {
                const cur = await io.readJson('mcps/servers.json');
                const next = Object.create(null);
                if (cur && typeof cur === 'object' && !Array.isArray(cur)) for (const k of Object.keys(cur)) next[k] = cur[k];
                for (const k of Object.keys(map)) next[k] = map[k];
                await io.writeJson(guard('mcps/servers.json', 'mcps'), next);
            });
        }

        // Registrations; existing ids for use-existing / present rows.
        const serverIdByName = new Map();
        for (const r of ofKind('server').filter(active)) {
            const s = serverOf(r);
            if (!s) continue;
            if (!toInstall(r) && !keepsFolder(r)) {
                const ex = (h.servers || []).find((e) => norm(e.name) === norm(r.name));
                if (ex && isId(ex.id)) serverIdByName.set(r.name, Number(ex.id));
                continue;
            }
            const v = rowValues(r);
            const url = pick(v, 'url'), auth = pick(v, 'authorization');
            const volumeFolder = h.host && s.local ? map[r.name] : null;   // served by the host at a fixed address
            const reg = { name: s.name, url: volumeFolder ? hostUrl(h.host.gateway, volumeFolder, parse(`mcps/${volumeFolder}/synergyai-mcp.json`))
                : url !== undefined && url !== '' ? url : s.url, description: s.description || '',
                transport: s.transport || 'http', is_mock: !!s.is_mock, headers: auth ? { Authorization: auth } : {} };
            const res = await step(`register server ${r.name}`, () => io.addServer(reg));
            serverIdByName.set(r.name, Number(res.id));
            if (volumeFolder) {
                const st = volumeState.get(r.name);
                installed.push({ kind: 'server', name: r.name, destination: `volume: ${volumeFolder}`, ...(st ? { state: st.state, log: st.log } : {}) });
                continue;
            }
            installed.push({ kind: 'server', name: r.name, destination: plan.servers.find((x) => x.r === r)?.dest || (keepsFolder(r) ? r.destination : null) });
        }
        const serverNameByOldId = new Map((pkg.servers || []).filter((s) => isId(s.old_id)).map((s) => [Number(s.old_id), s.name]));

        const playbookIdByOldId = new Map();
        for (const r of ofKind('playbook').filter(active)) {
            const dep = playbookDep(r);
            if (!dep) continue;
            let id;
            if (!toInstall(r)) {
                const ex = (h.playbooks || []).find((e) => norm(e.pkey) === norm(r.name));
                id = ex && isId(ex.id) ? Number(ex.id) : undefined;
            } else {
                const p = plan.playbooks.find((x) => x.r === r);
                if (!p) continue;   // its file is not in the package: the nodes are flagged below
                const pb = mdToPlaybook(dec(files[dep.file]));
                await step(`write playbook ${r.name}`, () => writeFile(p.dest, 'playbooks', files[dep.file]));
                const res = await step(`create playbook ${r.name}`, () => io.createPlaybook(pb));
                id = Number(res.id);
                installed.push({ kind: 'playbook', name: r.name, destination: p.dest });
            }
            if (id !== undefined && isId(dep.old_id)) playbookIdByOldId.set(Number(dep.old_id), id);
        }

        // Components: a folder copy here; creation / reuse in the library is importComponents' job.
        const workflow = pkg.workflow || {};
        const skippedIds = new Set();
        for (const r of ofKind('component')) {
            const dep = deps.find((d) => d.kind === 'component' && d.name === r.name);
            if (!dep) continue;
            if (!active(r)) { skippedIds.add(Number(dep.old_id)); continue; }
            if (toInstall(r) && own(files, dep.file) && files[dep.file]) {
                // A folder copy never refuses: the next free name, <base>.json then <base>_2.json ...
                const base = componentBase(r.name);
                let path = `${base}.json`;
                for (let k = 2; await step(`check ${path}`, () => io.exists(path)); k++) path = `${base}_${k}.json`;
                await step(`write component ${r.name}`, () => writeFile(path, 'components', files[dep.file]));
                installed.push({ kind: 'component', name: r.name, destination: path });
            }
        }
        const bundle = (workflow.code_components || []).filter((c) => !skippedIds.has(Number(c.id)));
        const bundled = new Set(bundle.map((c) => Number(c.id)));
        // A component link the bundle does not bring would point at an unrelated row here: cleared and flagged.
        let nodes = ((workflow.definition && workflow.definition.nodes) || []).map((n) => {
            const cfg = n.config || {};
            if (n.node_type === 'code' && isId(cfg.code_component_id) && !bundled.has(Number(cfg.code_component_id))) {
                return { ...n, config: { ...cfg, code_component_id: null, code_component_missing: true } };
            }
            if (n.node_type === 'start' && isId(cfg.start_option) && !bundled.has(Number(cfg.start_option))) {
                return { ...n, config: { ...cfg, start_option: null, start_option_missing: true } };
            }
            return n;
        });
        nodes = await step('import code components', () => io.importComponents(bundle, nodes));
        nodes = relinkNodes(nodes, { serverNameByOldId, serverIdByName, playbookIdByOldId, clearUnmapped: true });

        // Workflow keys entered in the review go back into each node's connection.
        const keysRow = ofKind('secrets')[0];
        if (!keysRow || active(keysRow)) {
            const keys = pick(vals, WORKFLOW_KEYS) || {};
            for (const k of Object.keys(keys)) {
                const v = keys[k];
                const i = k.lastIndexOf('.');
                if (i < 0 || v === undefined || v === null || String(v) === '') continue;
                const id = k.slice(0, i), field = k.slice(i + 1);
                nodes = nodes.map((n) => (String(n.id) !== id ? n : {
                    ...n, config: { ...(n.config || {}), connection: { ...((n.config && n.config.connection) || {}), [field]: v } },
                }));
            }
        }
        return { installed, commands, nodes };
    }

    return { WORKFLOW_KEYS, isSafeSegment, isSafeWritePath, packageSkills, skillZipPath, readPackageSkill, mergeEnv, collectDependencies, missingByNode, serverFolder, SECRET_FIELD_RE, stripSecrets, DEFAULT_EXCLUDES, selectServerFiles, hostFolderOf, hostSourceFiles, envFields, renderEnv, parseEnv, missingRequired, missingSettings, exportSettings, carriedSettings, classify, playbookToMd, mdToPlaybook, relinkNodes, filesHash, safeFileName, serverRegistration, buildManifest, readPackage, matchComponent, reviewRows, canConfirm, installPackage };
});
