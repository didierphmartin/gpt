/**
 * The code components collection on the client: a cache of the user's components shared by the Code
 * Library pane and the workflow editor, the /code-components API client, and the pure helpers that
 * turn a component into a linked node's config and a node form into a component body.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CodeComponents = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // The fields a component owns; a linked node carries them only as a cache (the server strips them on save).
    const CONTENT_KEYS = ['code', 'exits', 'mcp_servers', 'timeout_s'];

    const rows = new Map();
    let loadFailed = false;
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

    class CodeComponentApi {
        constructor(apiBase, getAuthHeaders) { this.base = apiBase; this.headers = getAuthHeaders; }
        async call(method, path, body) {
            const resp = await fetch(`${this.base}/code-components${path}`, {
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
        create(body) { return this.call('POST', '', body); }
        update(id, body) { return this.call('PUT', `/${id}`, body); }
        remove(id) { return this.call('DELETE', `/${id}`); }
        usedBy(id) { return this.call('GET', `/${id}/used-by`); }
    }

    function linkedNodeConfig(row, nodeName) {
        return { name: nodeName || row.name, code_component_id: Number(row.id), code: row.code,
            exits: [...row.exits], mcp_servers: [...row.mcp_servers], timeout_s: row.timeout_s };
    }

    function componentBody(cfg, { name, description }) {
        return { name: String(name || '').trim(), description: description || '', code: cfg.code,
            exits: [...cfg.exits], mcp_servers: [...cfg.mcp_servers], timeout_s: cfg.timeout_s };
    }

    // Another cached component with this name (the DB's collation ignores case), or null.
    function nameClash(name, ownId) {
        const n = String(name || '').trim().toLowerCase();
        return cache.all().find((r) => String(r.name).trim().toLowerCase() === n && Number(r.id) !== Number(ownId)) || null;
    }

    let shared = null;
    // One client for the page (the pane and the editor), built on first use from the app's base URL and auth.
    function api() {
        if (!shared) shared = new CodeComponentApi(window.APP_CONFIG?.API_BASE_URL || '/gpt/backend/api/v1',
            () => window.chatApp?.getAuthHeaders?.() || {});
        return shared;
    }

    return { CONTENT_KEYS, cache, api, CodeComponentApi, linkedNodeConfig, componentBody, nameClash };
});
