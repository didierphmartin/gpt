/**
 * Decision-model routing rules shared by the Dispatcher form and the browser
 * runner (twins of GraphWorkflowRunner / DecisionKeyResolver on the server).
 * `list` is GET /dispatch/providers ({default, providers}) or null when it
 * could not be read. Pure functions: no DOM, no fetch.
 */
(function (root) {
    const DEFAULT_FLOOR = 0.6;

    /** What a saved routing_mode selects: the model, or one decision provider (provider null = not listed). */
    function routingChoice(saved, list) {
        const s = String(saved ?? '').trim();
        if (s === 'llm') return { mode: 'llm' };
        const key = s !== '' ? s : (list ? list.default : '');
        if (key === null) return { mode: 'llm' };
        const provider = ((list && list.providers) || []).find((p) => p.key === key) || null;
        return { mode: 'decision', key, provider };
    }

    /** The provider key a node routes with; null = the model; '' = unset and the list is unreadable. */
    function effectiveKey(saved, list) {
        const c = routingChoice(saved, list);
        return c.mode === 'llm' ? null : c.key;
    }

    function minConfidence(settings) {
        const s = settings || {};
        const v = s.min_confidence ?? s.jev_min_confidence;
        const n = Number(v);
        if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return DEFAULT_FLOOR;
        return Math.max(0, Math.min(1, n));
    }

    /**
     * Which runner .env lines to write and which to remove, from the admin rows
     * (raw keys, GET /admin/llm-settings) and the user's provider list. Legacy
     * names are always removed: a stale TYPESAFE_API_KEY must not let a compiled
     * dispatcher route with a provider the plan forbids.
     */
    function envPlan(rows, list) {
        if (!list) return { set: {}, drop: [] };
        const set = {};
        const drop = new Set();
        for (const p of list.providers || []) {
            if (p.legacy_env) { drop.add(p.legacy_env.key); drop.add(p.legacy_env.url); }
            const row = (rows || []).find((r) => r.provider_key === p.key);
            const key = row && row.enabled !== false ? String(row.api_key || '').trim() : '';
            if (p.allowed === false || key === '') { drop.add(p.key_env); drop.add(p.url_env); continue; }
            set[p.key_env] = key;
            const url = String((row && row.base_url) || '').trim();
            if (url) set[p.url_env] = url; else drop.add(p.url_env);
        }
        return { set, drop: [...drop] };
    }

    const api = { routingChoice, effectiveKey, minConfidence, envPlan };
    root.DecisionRouting = api;
    root.__DECISION_ROUTING_TEST__ = api;
})(typeof window !== 'undefined' && window ? window : globalThis);
