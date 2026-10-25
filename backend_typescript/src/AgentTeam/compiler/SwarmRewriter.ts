import { entries, has, implode, is_array, keysOf, mb_substr, oarr, rtrim, strcmp, strval, trim, values } from './php';

/**
 * Turns a swarm canvas into the graph that actually runs: exactly the agents fanned out directly from Start,
 * wired into a full mesh. Pure. Ported from backend/src/AgentTeam/Services/SwarmRewriter.php (the JS twin is
 * frontend/assets/js/swarm-rewrite.js; tests/fixtures/swarm/rewrite-cases.json is the contract).
 */

/** PHP `$x['a']['b'] ?? null`. */
function dig(x: any, ...keys: string[]): any {
  let v = x;
  for (const k of keys) {
    if (v === null || v === undefined || typeof v !== 'object') return null;
    v = Array.isArray(v) ? v[Number(k)] : v[k];
  }
  return v === undefined ? null : v;
}

function coalesce(...xs: any[]): any {
  for (const x of xs) if (x !== null && x !== undefined) return x;
  return null;
}

/** Node ids ordered numerically when both are /^\d+$/, else by bytes (strcmp). */
function byId(list: string[]): string[] {
  return [...list].sort((a, b) => {
    const as = strval(a);
    const bs = strval(b);
    const an = /^\d+$/.test(as);
    const bn = /^\d+$/.test(bs);
    if (an && bn) {
      const x = parseInt(as, 10);
      const y = parseInt(bs, 10);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return strcmp(as, bs);
  });
}

export class SwarmRewriter {
  /** Handoffs beyond this end a run; mirrored in the interpreter. */
  static readonly HOP_BUDGET = 25;

  /** ok: {ok, agents (id => {id, name, instructions, tools, skills, handoffs}), entry} | refusal: {ok: false, error, nodes}. */
  static rewrite(graph: any): any {
    const nodes = oarr();
    const ids: string[] = [];
    for (const n of values(coalesce(dig(graph, 'nodes'), []))) {
      const id = strval(dig(n, 'id'));
      nodes[id] = n;
      ids.push(id);
    }
    const edges: Array<[string, string]> = [];
    for (const e of values(coalesce(dig(graph, 'edges'), []))) {
      edges.push([strval(coalesce(dig(e, 'from'), dig(e, 'from_node_id'), '')), strval(coalesce(dig(e, 'to'), dig(e, 'to_node_id'), ''))]);
    }
    const children = (id: string): string[] => edges.filter(([f]) => f === id).map(([, t]) => t);
    const typeOf = (n: any): string => strval(coalesce(dig(n, 'config', 'type'), dig(n, 'node_type'), ''));
    const isAgent = (n: any): boolean => ['agent', 'agent-template'].includes(typeOf(n));
    const isDispatcher = (n: any): boolean => coalesce(dig(n, 'config', 'agent_type'), '') === 'dispatcher';

    const playbooks: string[] = [];
    const outputs: string[] = [];
    for (const id of ids) {
      if (typeOf(nodes[id]) === 'playbook') playbooks.push(id);
      if (typeOf(nodes[id]) === 'output') outputs.push(id);
    }
    if (playbooks.length) return { ok: false, error: 'playbook_unsupported', nodes: byId(playbooks) };
    if (outputs.length > 1) return { ok: false, error: 'multiple_outputs', nodes: byId(outputs) };

    const tagged = ids.filter((id) => isAgent(nodes[id]) && isDispatcher(nodes[id]));
    if (tagged.length) return { ok: false, error: 'dispatcher_in_swarm', nodes: byId(tagged) };

    let menu: string[] = [];
    for (const id of ids) {
      if (typeOf(nodes[id]) !== 'start') continue;
      for (const c of children(id)) {
        if (has(nodes, c) && isAgent(nodes[c]) && !menu.includes(c)) menu.push(c);
      }
    }
    menu = byId(menu);
    if (menu.length < 2) return { ok: false, error: 'start_needs_two_agents', nodes: [] };

    const notOnStart = ids.filter((id) => isAgent(nodes[id]) && !menu.includes(id));
    if (notOnStart.length) return { ok: false, error: 'agent_not_on_start', nodes: byId(notOnStart) };

    const seen = new Map<string, string>();
    const dupes = oarr<boolean>();
    for (const id of menu) {
      const key = trim(SwarmRewriter.displayName(nodes, id)).toLowerCase();
      if (seen.has(key)) {
        dupes[seen.get(key)!] = true;
        dupes[id] = true;
      } else {
        seen.set(key, id);
      }
    }
    if (keysOf(dupes).length) return { ok: false, error: 'duplicate_agent_names', nodes: byId(keysOf(dupes)) };

    const nameOf = (id: string): string => SwarmRewriter.displayName(nodes, id);
    const roleOf = (id: string): string => {
      const text = trim(strval(coalesce(dig(nodes[id], 'config', 'instructions'), '')));
      const first = trim(text.split('\n')[0] ?? '');
      return mb_substr(first, 0, 120);
    };

    const agents = oarr();
    for (const id of menu) {
      const handoffs = byId(menu.filter((other) => other !== id));
      const colleagues = handoffs.map((h) => ({ name: nameOf(h), role: roleOf(h) }));
      const own = strval(coalesce(dig(nodes[id], 'config', 'instructions'), ''));
      const guide = colleagues.length === 0 ? '' : SwarmRewriter.handoffGuide(colleagues);
      const skills = dig(nodes[id], 'config', 'bound_skill');
      agents[id] = {
        id,
        name: nameOf(id),
        instructions: guide === '' ? own : rtrim(own) + '\n\n' + guide,
        tools: SwarmRewriter.toolList(dig(nodes[id], 'config', 'tools')),
        skills: SwarmRewriter.hasSkill(skills) ? [skills] : [],
        handoffs,
      };
    }
    return { ok: true, agents, entry: menu[0] };
  }

  /** The display name a handoff would use: agent_name, then name (non-empty strings only), else "node <id>". */
  private static displayName(nodes: any, id: string): string {
    for (const k of ['agent_name', 'name']) {
      const v = dig(nodes, id, 'config', k);
      if (typeof v === 'string' && v !== '') return v;
    }
    return `node ${id}`;
  }

  /** A genuine list, or nothing. */
  private static toolList(v: any): any[] {
    if (!is_array(v)) return [];
    if (Array.isArray(v)) return v;
    const es = entries(v);
    return es.every(([k], i) => k === String(i)) ? es.map(([, x]) => x) : [];
  }

  /** Presence, not truthiness. */
  private static hasSkill(v: any): boolean {
    return v !== null && v !== undefined && v !== '' && v !== false;
  }

  /** The block appended to every agent that can hand off: its colleagues, each with its own role summary. */
  static handoffGuide(colleagues: any): string {
    const lines = ['## Colleagues you can hand this to'];
    for (const c of values(colleagues)) {
      const role = trim(strval(c['role']));
      lines.push('- ' + strval(c['name']) + (role !== '' ? ' — ' + role : ''));
    }
    lines.push('');
    lines.push('Hand off when the request is theirs rather than yours, and say why in the reason.');
    lines.push('Answer directly when it is yours.');
    lines.push('Do not hand back what you were just handed unless the subject has genuinely changed.');
    return implode('\n', lines);
  }
}
