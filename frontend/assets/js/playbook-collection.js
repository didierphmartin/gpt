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

    return { keyFromTitle, isValidKey, titleOf, toolsUsedOf, cache, PlaybookApi };
});
