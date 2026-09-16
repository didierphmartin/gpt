/**
 * The swarm rewrite: a swarm canvas -> the graph that actually runs.
 *
 * A swarm is exactly the agents fanned out directly from Start (spec §3),
 * wired into a full mesh with each other and nothing else. An agent not
 * connected to Start is refused rather than absorbed: every agent in a
 * swarm can hand to every other, so a partial mesh (a member's child
 * reachable only through its parent) would contradict that. The Dispatcher
 * tag belongs to workflow mode; in a swarm every member routes, so the tag
 * is refused wherever it appears.
 *
 * Twin of backend/src/AgentTeam/Services/SwarmRewriter.php. Both are tested
 * against backend/tests/fixtures/swarm/rewrite-cases.json; a change that
 * satisfies one side only fails the other. The editor needs this in JS so
 * canvas feedback updates as you draw, without a round trip per edit.
 */
(function (global) {
    const HOP_BUDGET = 25;

    // Mirrors PHP's trim()/rtrim() default charlist (" \t\n\r\0\x0B", ASCII
    // only). JS's native .trim() and /\s/ are Unicode-aware and also strip
    // things like U+00A0 NBSP, which PHP's do not — every trim in this file
    // must go through this helper (or the matching trailing-only regex
    // below), never .trim()/\s, or non-ASCII whitespace makes the two
    // implementations diverge (finding 7).
    const phpTrim = s => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

    function handoffGuide(colleagues) {
        const lines = ['## Colleagues you can hand this to'];
        for (const c of colleagues) {
            const role = phpTrim(c.role || '');
            lines.push('- ' + c.name + (role ? ' — ' + role : ''));
        }
        lines.push('',
            'Hand off when the request is theirs rather than yours, and say why in the reason.',
            'Answer directly when it is yours.',
            'Do not hand back what you were just handed unless the subject has genuinely changed.');
        return lines.join('\n');
    }

    function swarmRewrite(graph) {
        const nodes = {};
        const ids = [];
        for (const n of (graph.nodes || [])) { nodes[String(n.id)] = n; ids.push(String(n.id)); }
        const edges = (graph.edges || []).map(e => [
            String(e.from ?? e.from_node_id ?? ''), String(e.to ?? e.to_node_id ?? ''),
        ]);
        // Order every returned list by node id, never by insertion: the PHP
        // twin keeps insertion order and JS does not, and they must agree.
        // Numeric-string ids sort numerically; anything else falls back to a
        // plain byte-order compare. This tiebreak must match the PHP twin
        // exactly, so it is never localeCompare() (locale-aware, decides
        // non-numeric ties differently from PHP's strcmp()) — and the "is
        // this numeric" test is a literal /^\d+$/, never JS's Number() vs
        // PHP's (int) cast, which disagree with each other on strings like "a".
        const byId = list => [...list].sort((a, b) => {
            const as = String(a), bs = String(b);
            const an = /^\d+$/.test(as), bn = /^\d+$/.test(bs);
            if (an && bn) return Number(as) - Number(bs);
            return as < bs ? -1 : as > bs ? 1 : 0;
        });
        const children = id => edges.filter(([f]) => f === id).map(([, t]) => t);
        const typeOf = n => String(n.config?.type ?? n.node_type ?? '');
        const isAgent = n => ['agent', 'agent-template'].includes(typeOf(n));
        const isDispatcher = n => (n.config?.agent_type || '') === 'dispatcher';

        const playbooks = ids.filter(id => typeOf(nodes[id]) === 'playbook');
        if (playbooks.length) return { ok: false, error: 'playbook_unsupported', nodes: byId(playbooks) };
        const outputs = ids.filter(id => typeOf(nodes[id]) === 'output');
        if (outputs.length > 1) return { ok: false, error: 'multiple_outputs', nodes: byId(outputs) };

        // The Dispatcher tag belongs to workflow mode. In a swarm every member
        // routes, so the tag has no meaning here wherever it appears — including
        // on a node nothing connects to.
        const tagged = ids.filter(id => isAgent(nodes[id]) && isDispatcher(nodes[id]));
        if (tagged.length) return { ok: false, error: 'dispatcher_in_swarm', nodes: byId(tagged) };

        // The swarm is what was drawn from Start (spec §3). No node is
        // dissolved and none is synthesised: the members are exactly the
        // agents on the other end of Start's edges.
        const menuIds = [];
        for (const id of ids) {
            if (typeOf(nodes[id]) !== 'start') continue;
            for (const c of children(id)) {
                if (nodes[c] && isAgent(nodes[c]) && !menuIds.includes(c)) menuIds.push(c);   // a doubled edge must not double a member
            }
        }
        const menu = byId(menuIds);
        if (menu.length < 2) return { ok: false, error: 'start_needs_two_agents', nodes: [] };

        // Every agent in the swarm can hand to every other (spec, revised).
        // An agent connected to a member but not to Start — "connected to
        // Start" means Start has an edge TO it, not merely a path from it —
        // would otherwise be reachable only through that one parent, a
        // partial mesh the owner has ruled out. Refuse it by name rather
        // than silently absorbing or dropping it.
        const notOnStart = ids.filter(id => isAgent(nodes[id]) && !menu.includes(id));
        if (notOnStart.length) return { ok: false, error: 'agent_not_on_start', nodes: byId(notOnStart) };

        // The swarm is exactly the menu: no absorption, no transitive walk.
        const ordered = menu;

        const nameOf = id => String(nodes[id].config?.agent_name ?? nodes[id].config?.name ?? `node ${id}`);
        // Truncate by codepoint, never by UTF-16 code unit: Array.from(...)
        // splits astral characters (surrogate pairs) into single elements,
        // matching PHP's mb_substr($s, 0, 120), which counts codepoints.
        // Plain .slice(0,120) here would diverge on non-BMP input and can
        // split a surrogate pair in half.
        const roleOf = id => {
            const text = phpTrim(String(nodes[id].config?.instructions ?? ''));
            const first = phpTrim(text.split('\n')[0] ?? '');
            return Array.from(first).slice(0, 120).join('');
        };

        const agents = {};
        for (const id of ordered) {
            let handoffs = [];
            for (const other of menu) if (other !== id) handoffs.push(other);   // the full mesh
            handoffs = byId(handoffs);
            const colleagues = handoffs.map(h => ({ name: nameOf(h), role: roleOf(h) }));
            const own = String(nodes[id].config?.instructions ?? '');
            const guide = colleagues.length ? handoffGuide(colleagues) : '';
            const skill = nodes[id].config?.bound_skill;
            // PHP's rtrim() default charlist is " \t\n\r\0\x0B" (ASCII only).
            // Strip the identical fixed set here, never JS's Unicode-aware
            // \s (which also eats U+00A0 NBSP and would diverge from PHP).
            agents[id] = {
                id, name: nameOf(id),
                instructions: guide ? own.replace(/[ \t\n\r\0\x0B]+$/, '') + '\n\n' + guide : own,
                tools: [...(nodes[id].config?.tools || [])],
                skills: skill ? [skill] : [],
                handoffs,
            };
        }

        return { ok: true, agents, entry: menu[0] };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { swarmRewrite, handoffGuide, HOP_BUDGET };   // node tests
    } else {
        // The editor calls these by these exact names (Tasks 5-7) — do not rename.
        global.swarmRewrite = swarmRewrite;
        global.swarmHandoffGuide = handoffGuide;
        global.SWARM_HOP_BUDGET = HOP_BUDGET;
    }
})(typeof window !== 'undefined' ? window : globalThis);
