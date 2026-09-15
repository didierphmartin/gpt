/**
 * The swarm rewrite: a swarm canvas -> the graph that actually runs.
 *
 * Twin of backend/src/AgentTeam/Services/SwarmRewriter.php. Both are tested
 * against backend/tests/fixtures/swarm/rewrite-cases.json; a change that
 * satisfies one side only fails the other. The editor needs this in JS so
 * canvas feedback updates as you draw, without a round trip per edit.
 */
(function (global) {
    const HOP_BUDGET = 25;

    function handoffGuide(dispatcherInstructions, colleagues) {
        const lines = ['## Colleagues you can hand this to'];
        for (const c of colleagues) {
            const role = (c.role || '').trim();
            lines.push('- ' + c.name + (role ? ' — ' + role : ''));
        }
        const routing = (dispatcherInstructions || '').trim();
        if (routing) { lines.push('', '## When to hand off', routing); }
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
        const byId = list => [...list].sort((a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b)));
        const children = id => edges.filter(([f]) => f === id).map(([, t]) => t);
        const parents = id => edges.filter(([, t]) => t === id).map(([f]) => f);
        const typeOf = n => String(n.config?.type ?? n.node_type ?? '');
        const isAgent = n => ['agent', 'agent-template'].includes(typeOf(n));
        const isDispatcher = n => (n.config?.agent_type || '') === 'dispatcher';

        const playbooks = ids.filter(id => typeOf(nodes[id]) === 'playbook');
        if (playbooks.length) return { ok: false, error: 'playbook_unsupported', nodes: byId(playbooks) };
        const outputs = ids.filter(id => typeOf(nodes[id]) === 'output');
        if (outputs.length > 1) return { ok: false, error: 'multiple_outputs', nodes: byId(outputs) };

        const dispatchers = ids.filter(id => isAgent(nodes[id]) && isDispatcher(nodes[id]));
        if (dispatchers.length > 1) return { ok: false, error: 'nested_dispatchers', nodes: byId(dispatchers) };
        if (!dispatchers.length) return { ok: false, error: 'no_dispatcher', nodes: [] };
        const dispatcherId = dispatchers[0];

        const entryTargets = byId([...new Set(ids.filter(id => typeOf(nodes[id]) === 'start').flatMap(children))]);
        if (entryTargets.length > 1) return { ok: false, error: 'two_entry_points', nodes: entryTargets };

        const menu = byId(children(dispatcherId).filter(c => nodes[c] && isAgent(nodes[c])));
        if (menu.length < 2) return { ok: false, error: 'dispatcher_needs_two_children', nodes: [dispatcherId] };

        for (const id of ids) {
            if (!isAgent(nodes[id])) continue;
            const agentParents = parents(id).filter(p => p !== dispatcherId && nodes[p] && isAgent(nodes[p]));
            if (agentParents.length > 1) return { ok: false, error: 'merge_node', nodes: [id] };
        }

        // Walk outward from the menu: any agent reachable from a swarm member is
        // itself a member. Absorbing only the menu's direct children leaves a
        // grandchild as a handoff target with no agent behind it, which the
        // interpreter dereferences and crashes on. members.length is re-read
        // each pass, so newly absorbed members are walked too.
        const members = [...menu];
        for (let i = 0; i < members.length; i++) {
            for (const c of children(members[i])) {
                if (nodes[c] && isAgent(nodes[c]) && c !== dispatcherId && !members.includes(c)) members.push(c);
            }
        }
        const ordered = byId(members);

        const nameOf = id => String(nodes[id].config?.agent_name ?? nodes[id].config?.name ?? `node ${id}`);
        const roleOf = id => String(nodes[id].config?.instructions ?? '').trim().split('\n')[0].slice(0, 120);

        const agents = {};
        for (const id of ordered) {
            let handoffs = [];
            if (menu.includes(id)) for (const other of menu) if (other !== id) handoffs.push(other);
            for (const c of children(id)) {
                if (nodes[c] && isAgent(nodes[c]) && c !== dispatcherId && !handoffs.includes(c)) handoffs.push(c);
            }
            handoffs = byId(handoffs);
            const colleagues = handoffs.map(h => ({ name: nameOf(h), role: roleOf(h) }));
            const own = String(nodes[id].config?.instructions ?? '');
            const guide = colleagues.length
                ? handoffGuide(String(nodes[dispatcherId].config?.instructions ?? ''), colleagues)
                : '';
            const skill = nodes[id].config?.bound_skill;
            agents[id] = {
                id, name: nameOf(id),
                instructions: guide ? own.replace(/\s+$/, '') + '\n\n' + guide : own,
                tools: [...(nodes[id].config?.tools || [])],
                skills: skill ? [skill] : [],
                handoffs,
            };
        }

        const dcfg = nodes[dispatcherId].config || {};
        return {
            ok: true, agents, entry: menu[0],
            dropped: { tools: (dcfg.tools || []).length, skills: dcfg.bound_skill ? 1 : 0 },
        };
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
