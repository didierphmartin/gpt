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
        let key = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
    const cache = {
        async load(api) { const body = await api.list(); rows.clear(); for (const r of body.data || []) rows.set(Number(r.id), r); return [...rows.values()]; },
        get(id) { return rows.get(Number(id)) || null; },
        put(row) { rows.set(Number(row.id), row); },
        drop(id) { rows.delete(Number(id)); },
        all() { return [...rows.values()]; },
    };

    class PlaybookApi {
        constructor(apiBase, getAuthHeaders) { this.base = apiBase; this.headers = getAuthHeaders; }
        async call(method, path, body) {
            const resp = await fetch(`${this.base}/playbooks${path}`, {
                method, credentials: 'include',
                headers: { ...this.headers(), 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const json = await resp.json().catch(() => ({ success: false, error: `HTTP ${resp.status}` }));
            if (!json.success) { const e = new Error(json.error || `HTTP ${resp.status}`); e.kind = json.kind; e.status = resp.status; throw e; }
            return json;
        }
        list() { return this.call('GET', ''); }
        get(id) { return this.call('GET', `/${id}`); }
        create(row) { return this.call('POST', '', row); }
        update(id, row) { return this.call('PUT', `/${id}`, row); }
        remove(id) { return this.call('DELETE', `/${id}`); }
        usedBy(id) { return this.call('GET', `/${id}/used-by`); }
    }

    // A playbook node on the canvas links to the collection by playbook_id; its data never holds the text.
    function nodeData(config) {
        const c = { name: 'Playbook', agent_provider: '', model: '', writes_enabled: true, ...(config || {}) };
        return {
            type: 'playbook', node_type: 'playbook', name: c.name || 'Playbook',
            playbook_id: c.playbook_id ? Number(c.playbook_id) : null,
            agent_id: c.agent_id ? Number(c.agent_id) : null, // set when dropped from a playbook agent card
            agent_provider: c.agent_provider || '', model: c.model || '',
            mcp_servers: Array.isArray(c.mcp_servers) ? c.mcp_servers : [],
            writes_enabled: !!c.writes_enabled, disabled: !!c.disabled,
        };
    }
    // The node's text from the cache: '' when unlinked (a fresh palette node), null when the id is not there.
    function nodeText(data) {
        if (!data || !data.playbook_id) return '';
        const row = cache.get(data.playbook_id);
        return row ? String(row.text || '') : null;
    }
    // One line for the node body: the Title, else the first non-blank line; a missing playbook says so.
    function nodeSummary(data) {
        const text = nodeText(data);
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
    // node_config for POST /workflows/playbook-node/run: the reference, the server reads the text.
    function runNodeConfig(data) {
        const d = data || {};
        return {
            playbook_id: d.playbook_id ? Number(d.playbook_id) : null,
            agent_provider: d.agent_provider || '', model: d.model || '', name: d.name || '',
            writes_enabled: !!d.writes_enabled,
        };
    }
    // The form's key check: the i18n key of the problem (playbookLibrary.*), or null. Empty = server derives it.
    function keyProblem(key, ownId) {
        if (!key) return null;
        if (!isValidKey(key)) return 'keyInvalid';
        const other = cache.all().find((r) => r.pkey === key && Number(r.id) !== Number(ownId));
        return other ? 'keyTaken' : null;
    }

    return { keyFromTitle, isValidKey, titleOf, toolsUsedOf, cache, PlaybookApi,
        nodeData, nodeText, nodeSummary, nodeServerNames, runNodeConfig, keyProblem };
});
