/**
 * The playbook collection on the client: the key rules (twin of PlaybookStore.php), reading a
 * playbook's Title / Tools used from its text, a cache of the user's playbooks shared by the
 * Playbooks Library and the workflow editor, and the /playbooks API client.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PlaybookCollection = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    // The parser's section header: optional "1." / "-" / "##" / "**" before the keyword (PlaybookDocument::SECTION_HEADER_RE).
    const header = (name) => new RegExp(`^\\s*(?:\\d+[.)]|[-*•]|#{1,6})?\\s*\\**${name}\\**\\s*:\\**\\s*(.*)$`, 'im');

    function keyFromTitle(title) {
        // Accents are dropped first (NFD, marks removed): "Ça va" -> "ca-va" (twin of PlaybookStore::keyFromTitle).
        let key = String(title || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        key = key.slice(0, 64).replace(/-+$/, '');
        return key || 'playbook';
    }
    function isValidKey(key) { return typeof key === 'string' && key.length <= 64 && KEY_RE.test(key); }
    function titleOf(text) { const m = String(text || '').match(header('Title')); return m ? m[1].replace(/\*+$/, '').trim() : ''; }
    function toolsUsedOf(text) {
        const m = String(text || '').match(header('Tools used'));
        return m ? m[1].split(';').map((s) => s.trim()).filter(Boolean) : [];
    }

    const rows = new Map();
    let loadFailed = false; // the last load failed: a missing id may only be unloaded, not "not found"
    const cache = {
        async load(api) {
            let body;
            try { body = await api.list(); } catch (e) { loadFailed = true; throw e; }
            loadFailed = false;
            rows.clear(); for (const r of body.data || []) rows.set(Number(r.id), r); return [...rows.values()];
        },
        loadFailed() { return loadFailed; },
        get(id) { return rows.get(Number(id)) || null; },
        put(row) { rows.set(Number(row.id), row); },
        drop(id) { rows.delete(Number(id)); },
        all() { return [...rows.values()]; },
    };

    class PlaybookApi {
        constructor(apiBase, getAuthHeaders) { this.base = apiBase; this.headers = getAuthHeaders; }
        call(method, path, body) { return this.request(method, `/playbooks${path}`, body); }
        async request(method, path, body) {
            const resp = await fetch(`${this.base}${path}`, {
                method, credentials: 'include',
                headers: { ...this.headers(), 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const json = await resp.json().catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
            if (!json.success) { const e = new Error(json.error || `HTTP ${resp.status}`); e.kind = json.kind; e.status = resp.status; e.data = json.data; throw e; }
            return json;
        }
        list() { return this.call('GET', ''); }
        get(id) { return this.call('GET', `/${id}`); }
        create(row) { return this.call('POST', '', row); }
        update(id, row) { return this.call('PUT', `/${id}`, row); }
        remove(id) { return this.call('DELETE', `/${id}`); }
        usedBy(id) { return this.call('GET', `/${id}/used-by`); }
        // Publishing to the robot: a frozen copy of the playbook (a 409 `replaces` until confirmReplace).
        publish(id, confirmReplace) { return this.call('POST', `/${id}/publish`, { confirm_replace: !!confirmReplace }); }
        robot() { return this.request('GET', '/robot'); }
        robotPlaybooks() { return this.request('GET', '/robot/playbooks'); }
        unpublish(robotId) { return this.request('DELETE', `/robot/playbooks/${robotId}`); }
    }

    // English fallbacks for the pure helpers below (the UI passes its i18n t()).
    const EN = {
        'playbookLibrary.published': 'Published',
        'playbookLibrary.publishedChanged': 'Published (changed since)',
        'playbookLibrary.replacesConfirm': 'Replaces {{key}} published by {{name}} on {{date}}',
    };
    const enT = (k, p) => String(EN[k] || k).replace(/\{\{(\w+)\}\}/g, (_, n) => (p && p[n] != null ? String(p[n]) : ''));
    // A row's publish badge ('' when not published, or the caller can't use the robot).
    function publishLabel(row, canUse, t = enT) {
        if (!canUse || !row) return '';
        if (row.published === 'published') return t('playbookLibrary.published');
        if (row.published === 'changed') return t('playbookLibrary.publishedChanged');
        return '';
    }
    // The Publish button's replace confirmation (no browser dialog). State: {armed, key, message}.
    // {type:'click', key} -> confirmReplace only when armed for that same key;
    // {type:'error', error, key} -> a `replaces` answer arms with the message, any other error disarms and says it;
    // {type:'ok'} -> disarmed, published.
    function publishStep(state, ev, t = enT) {
        const s = state || { armed: false, key: null, message: '' };
        if (ev.type === 'click') return { ...s, confirmReplace: !!s.armed && s.key === ev.key };
        if (ev.type === 'ok') return { armed: false, key: null, message: '', published: true };
        const err = ev.error || {};
        if (err.kind === 'replaces') {
            const d = err.data || {};
            return { armed: true, key: ev.key, message: t('playbookLibrary.replacesConfirm',
                { key: ev.key, name: d.published_by || '', date: String(d.published_at || '').slice(0, 10) }) };
        }
        return { armed: false, key: null, message: err.message || String(err) };
    }

    // A playbook node on the canvas links to the collection by playbook_id. A node saved before the
    // collection (unlinked) keeps its own `playbook` (text, or a JSON object) until its first save links it.
    function nodeData(config) {
        const c = { name: 'Playbook', agent_provider: '', model: '', writes_enabled: true, ...(config || {}) };
        const d = {
            type: 'playbook', node_type: 'playbook', name: c.name || 'Playbook',
            playbook_id: c.playbook_id ? Number(c.playbook_id) : null,
            agent_id: c.agent_id ? Number(c.agent_id) : null, // set when dropped from a playbook agent card
            agent_provider: c.agent_provider || '', model: c.model || '',
            mcp_servers: Array.isArray(c.mcp_servers) ? c.mcp_servers : [],
            writes_enabled: c.writes_enabled !== false, disabled: !!c.disabled,
        };
        if (!d.playbook_id && c.playbook && (typeof c.playbook === 'string' || typeof c.playbook === 'object')) d.playbook = c.playbook;
        if (c.policy !== undefined) d.policy = c.policy;       // run settings carried by the migration
        if (c.approvers !== undefined) d.approvers = c.approvers;
        return d;
    }
    // A JSON-object node playbook as console text (twin of PlaybookMigration::render).
    function renderDoc(o) {
        const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).join('; ');
        let out = `Title: ${String(o.title || '').trim()}\nTrigger: ${(o.trigger && o.trigger.description) || ''}\n`
            + `Instructions:\n${String(o.instructions || '').trim()}\nTools used: ${list(o.tools_used)}\nActions used: ${list(o.actions_used)}\n`;
        const domain = String(o.domain || '').trim();
        return domain ? `${out}Domain: ${domain}\n` : out;
    }
    // The node's text: from the cache when linked (null when the id is not there); an unlinked node's own
    // text ('' for a fresh palette node).
    function nodeText(data) {
        if (!data) return '';
        if (!data.playbook_id) {
            const p = data.playbook;
            if (p && typeof p === 'object') return renderDoc(p);
            return typeof p === 'string' ? p : '';
        }
        const row = cache.get(data.playbook_id);
        return row ? String(row.text || '') : null;
    }
    // One line for the node body: the Title, else the first non-blank line; a missing playbook says so,
    // and a failed collection load says that instead (loadFailed: the caller shows its own message).
    function nodeSummary(data) {
        const text = nodeText(data);
        if (text === null && loadFailed) return { text: 'Could not load playbooks', missing: true, loadFailed: true };
        if (text === null) return { text: `Playbook #${data.playbook_id} not found`, missing: true };
        const line = (titleOf(text) || text.split('\n').map((l) => l.trim()).find((l) => l) || '').trim();
        if (!line) return { text: 'No playbook pasted yet', missing: false };
        return { text: line.length > 60 ? line.slice(0, 60) + '…' : line, missing: false };
    }
    // Server badges: the servers saved by the last Validate, else the text's "Tools used:" line.
    function nodeServerNames(data) {
        if (data && Array.isArray(data.mcp_servers) && data.mcp_servers.length) return data.mcp_servers;
        return toolsUsedOf(nodeText(data) || '');
    }
    // node_config for POST /workflows/playbook-node/run: the reference (the server reads the text), or an
    // unlinked node's own playbook.
    function runNodeConfig(data) {
        const d = data || {};
        const cfg = {
            playbook_id: d.playbook_id ? Number(d.playbook_id) : null,
            agent_provider: d.agent_provider || '', model: d.model || '', name: d.name || '',
            writes_enabled: !!d.writes_enabled,
        };
        if (!cfg.playbook_id && d.playbook) cfg.playbook = d.playbook; // unlinked: the server runs the text itself
        return cfg;
    }
    // What a form save does with the collection for a (possibly linked) id and the form's text:
    // 'update' the cached row; 'create' a new row (unlinked, or the linked one is gone: the recovery path);
    // 'skip' (nothing typed for a new or missing playbook); 'unloaded' (the collection did not load:
    // the text is unknown and must not be written).
    function saveAction(id, text) {
        if (id && cache.get(id)) return 'update';
        if (id && loadFailed) return 'unloaded';
        return String(text || '').trim() ? 'create' : 'skip';
    }
    // The form's key check: the i18n key of the problem (playbookLibrary.*), or null. Empty = server derives it.
    function keyProblem(key, ownId) {
        if (!key) return null;
        if (!isValidKey(key)) return 'keyInvalid';
        const other = cache.all().find((r) => r.pkey === key && Number(r.id) !== Number(ownId));
        return other ? 'keyTaken' : null;
    }

    // Second-click confirmation (no browser dialog): the first click on a target arms it, a second click
    // on the same target fires; a click on another target arms that one instead.
    function armClick(armed, target) {
        return armed === target ? { fire: true, armed: null } : { fire: false, armed: target };
    }

    return { keyFromTitle, isValidKey, titleOf, toolsUsedOf, cache, PlaybookApi,
        nodeData, nodeText, nodeSummary, nodeServerNames, runNodeConfig, keyProblem, saveAction, publishLabel, publishStep, armClick };
});
