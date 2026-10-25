/**
 * Dispatcher routing for batch workflows — the batch twin of the voice runner's handoff_to.
 * Mirrors backend/src/AgentTeam/Services/DispatchRouting.php.
 *
 * For an agent of type 'dispatcher', its outgoing edges are a MENU of branches the model may pick
 * from by name, not a parallel fan-out. The model calls route_to(target) once; exactly that branch
 * runs and every node reachable only through the unchosen branches is skipped.
 *
 * Pure functions over the graph shape used by GraphWorkflowRunner (nodes indexed by id with
 * node_type/config; edges with from_node_id / to_node_id). No I/O.
 */

export interface DispatchTarget {
  id: number;
  name: string;
  description?: string;
}

export interface DispatchRoute {
  id: number;
  name: string;
  notes: string;
}

const intval = (v: any): number => {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? 0 : n;
};

export const DispatchRouting = {
  TOOL_NAME: 'route_to',

  /** Decision outcomes that mean "no branch fits", as opposed to a failure (no key, network). */
  NOT_CLASSIFIED: ['unclear', 'low_confidence'] as readonly string[],

  /**
   * The branch a decision-model dispatcher sends what it could not classify to:
   * settings.unclear_branch (a branch NAME -- node ids change on every save), only for an
   * unclear/low_confidence outcome and only while that branch is still on the menu. null = no such
   * branch: the run stops there.
   */
  unclearBranch(settings: Record<string, any>, targets: DispatchTarget[], outcome: string): DispatchTarget | null {
    if (!DispatchRouting.NOT_CLASSIFIED.includes(outcome)) return null;
    const name = String(settings?.unclear_branch ?? '').trim();
    if (name === '') return null;
    for (const t of targets) {
      if (t.name === name) return t;
    }
    return null;
  },

  /** Downstream agent and code nodes of nodeId as [{id, name}, …] in edge order. */
  targets(nodeId: number, edges: any[], nodes: Record<number, any>): DispatchTarget[] {
    const out: DispatchTarget[] = [];
    for (const edge of edges) {
      if (intval(edge.from_node_id) !== nodeId) continue;
      const toId = intval(edge.to_node_id);
      const node = nodes[toId] ?? null;
      // Agents and code nodes are branches (as in the editor run and compiled scripts).
      if (!node || !['agent', 'code'].includes(node.node_type ?? '')) continue;
      const cfg = node.config ?? {};
      const name = String(cfg.agent_name ?? cfg.name ?? `Agent ${toId}`);
      out.push({ id: toId, name });
    }
    return out;
  },

  /** Tool definition in the Claude shape ({name, description, input_schema}); providers translate it. */
  toolDefinition(targets: DispatchTarget[]): Record<string, any> {
    const names = targets.map((t) => t.name);
    return {
      name: DispatchRouting.TOOL_NAME,
      description:
        'REQUIRED tool to hand the request to exactly one downstream agent. ' +
        'Pick the agent whose role matches the request. Available targets: ' +
        names.join(', ') +
        '. The chosen agent receives the original request, plus your notes.',
      input_schema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: names,
            description: 'Name of the agent to route to. MUST be one of the listed values.',
          },
          notes: {
            type: 'string',
            description: 'Optional short note for the target agent (what you understood, what to focus on).',
          },
        },
        required: ['target'],
      },
    };
  },

  /**
   * Instructions for a node the author left blank. Without this the chat endpoint falls back to
   * the user's CONVERSATION persona — a workflow node must never inherit that.
   */
  defaultInstructions(agentName: string, description: string, workflowName: string): string {
    const desc = description.trim();
    return (
      `You are "${agentName}"` +
      (desc !== '' ? `, ${desc}` : '') +
      `, an agent in the workflow "${workflowName}". ` +
      'Handle the request you receive directly and completely, in the role your name implies.'
    );
  },

  /** Fragment appended to the CHOSEN target's instructions. */
  routedPrompt(targetName: string, fromName: string, notes: string): string {
    const n = notes.trim();
    return (
      '## Routed request\n' +
      `The dispatcher "${fromName}" reviewed this request and routed it to you, "${targetName}", ` +
      `because it falls under your responsibility. Handle it yourself as "${targetName}". ` +
      'Do not redirect the requester to another department or agent, and do not ask who should handle it.' +
      (n !== '' ? `\nNotes from the dispatcher: ${n}` : '')
    );
  },

  /** {from: dispatcherName, notes} when an upstream dispatcher's output routed to nodeId, else null. */
  routedBy(nodeId: number, edges: any[], outputs: Record<number, any>): { from: string; notes: string } | null {
    for (const edge of edges) {
      if (intval(edge.to_node_id) !== nodeId) continue;
      const out = outputs[intval(edge.from_node_id)] ?? null;
      const route = out && typeof out === 'object' ? out.route ?? null : null;
      if (route && typeof route === 'object' && intval(route.id ?? 0) === nodeId) {
        return { from: String(out.agent_name ?? 'dispatcher'), notes: String(route.notes ?? '') };
      }
    }
    return null;
  },

  /** Prompt fragment appended to the dispatcher's instructions (mirrors the voice TRANSFER RULES). */
  promptBlock(targets: DispatchTarget[]): string {
    const lines = targets.map((t) => `  - ${t.name}`);
    return (
      '## Routing\n' +
      'You are a dispatcher. Your only job is to decide which ONE of these agents should handle the request:\n' +
      lines.join('\n') +
      '\n' +
      "Read the request, then call the route_to function with target set to that agent's exact name " +
      '(optionally add notes). You MUST call route_to — answering in prose does not route the request. ' +
      'Never call it more than once.'
    );
  },

  /** The chosen target from the model's tool calls, or null when no route_to call names a known target. */
  resolve(toolCalls: any[], targets: DispatchTarget[]): DispatchRoute | null {
    for (const call of toolCalls ?? []) {
      if ((call?.name ?? '') !== DispatchRouting.TOOL_NAME) continue;
      const isObj = (v: any) => v !== null && typeof v === 'object';
      const input = isObj(call.input) ? call.input : isObj(call.arguments) ? call.arguments : {};
      const want = String(input.target ?? '').trim().toLowerCase();
      for (const t of targets) {
        if (t.name.trim().toLowerCase() === want) {
          return { id: t.id, name: t.name, notes: String(input.notes ?? '').trim() };
        }
      }
    }
    return null;
  },

  /**
   * Node ids to skip given the unchosen direct targets: those nodes plus, transitively, any node
   * ALL of whose predecessors are skipped. A node fed by at least one live predecessor stays
   * runnable. Ascending order. `from`: the node that chose. Its links to the unchosen targets are
   * dead, its other links live, so an unchosen target that another node still feeds is not
   * skipped. Without it every unchosen target is skipped outright.
   */
  skipSet(unchosenIds: number[], edges: any[], from: number | null = null): number[] {
    const unchosen = new Set(unchosenIds.map(intval));
    const skipped = new Set<number>(from === null ? unchosen : []);
    const preds = new Map<number, number[]>();
    for (const edge of edges) {
      const to = intval(edge.to_node_id);
      if (!preds.has(to)) preds.set(to, []);
      preds.get(to)!.push(intval(edge.from_node_id));
    }
    let grew: boolean;
    do {
      grew = false;
      for (const [nodeId, ps] of preds) {
        if (skipped.has(nodeId)) continue;
        let allDead = true;
        for (const p of ps) {
          const dead = skipped.has(p) || (p === from && unchosen.has(nodeId));
          if (!dead) {
            allDead = false;
            break;
          }
        }
        if (allDead) {
          skipped.add(nodeId);
          grew = true;
        }
      }
    } while (grew);
    return [...skipped].sort((a, b) => a - b);
  },
};
