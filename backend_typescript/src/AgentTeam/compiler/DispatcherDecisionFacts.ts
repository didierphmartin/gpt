import { agentToArray } from '../AgentRepository';
import { DecisionProviders } from '../../Services/DecisionProviders';
import { F, PhpFloat, floatval, intval, is_array, is_numeric, is_string, jsonDecodeAssoc, strtoupper, strval, trim, truthy } from './php';

/**
 * A dispatcher's decision-model routing as a compiled program bakes it, read at compile time only: its decision
 * question, routing mode, unclear branch, confidence floor and the decision providers it may call. The saved agent
 * record's name, description and settings when the node references one, else the node's own.
 * Ported from backend/src/AgentTeam/Services/DispatcherDecisionFacts.php.
 *
 * The decision rows are read through src/Services/DecisionProviders (the shared Kysely `db`); `db` here only
 * says whether there is a database at all (null: no decision providers), as PHP's ?PDO does.
 */

/** JevRouter::DEFAULT_CONFIDENCE_FLOOR. */
const DEFAULT_CONFIDENCE_FLOOR = 0.6;

function at(x: any, k: string): any {
  if (x === null || x === undefined || typeof x !== 'object') return null;
  const v = Array.isArray(x) ? x[Number(k)] : x[k];
  return v === undefined ? null : v;
}

function coalesce(...xs: any[]): any {
  for (const x of xs) if (x !== null && x !== undefined) return x;
  return null;
}

/** DispatchRouting::defaultInstructions (PHP trim()). */
function defaultInstructions(agentName: string, description: string, workflowName: string): string {
  const desc = trim(description);
  return `You are "${agentName}"` + (desc !== '' ? `, ${desc}` : '')
    + `, an agent in the workflow "${workflowName}". `
    + 'Handle the request you receive directly and completely, in the role your name implies.';
}

/** DecisionProviders::envStem over bytes, as PHP runs it: ASCII upper case, every byte outside A-Z0-9 -> '_'. */
function envStem(key: string): string {
  let out = '';
  for (const ch of strtoupper(key)) out += /^[A-Z0-9]$/.test(ch) ? ch : '_'.repeat(Buffer.byteLength(ch, 'utf8'));
  return out;
}

export type DecisionCandidate = { provider: string; protocol: string; url: string; model: string; key_env: string; url_env: string };

export class DispatcherDecisionFacts {
  /** {decision_question, routing_mode, unclear_branch, min_confidence (PhpFloat), decision: candidates}. */
  static async of(db: unknown | null, agentRepo: { findById(id: number): any } | null, node: any, wfName: string): Promise<{
    decision_question: string; routing_mode: string; unclear_branch: string; min_confidence: PhpFloat; decision: DecisionCandidate[];
  }> {
    const cfg = is_array(at(node, 'config')) ? node['config'] : [];
    let name = strval(coalesce(at(cfg, 'agent_name'), at(cfg, 'name'), at(node, 'name'), ''));
    let desc = strval(coalesce(at(cfg, 'description'), ''));
    let settings: any = is_array(at(cfg, 'settings')) ? cfg['settings'] : [];
    const agentId = coalesce(at(node, 'agent_id'), at(cfg, 'agent_id'));
    if (agentRepo !== null && agentId !== null && agentId !== '') {
      let agent: any;
      try {
        agent = await agentRepo.findById(intval(agentId));
      } catch {
        agent = null;
      }
      if (agent !== null && agent !== undefined) {
        const a = typeof agent.toArray === 'function' ? agent.toArray() : agentToArray(agent);
        if (trim(strval(coalesce(at(a, 'name'), ''))) !== '') name = strval(a['name']);
        if (trim(strval(coalesce(at(a, 'description'), ''))) !== '') desc = strval(a['description']);
        let rec = coalesce(at(a, 'settings'), []);
        rec = is_string(rec) ? jsonDecodeAssoc(rec) : rec;
        settings = is_array(rec) ? rec : [];
      }
    }
    const mode = trim(strval(coalesce(at(settings, 'routing_mode'), '')));
    const floor = coalesce(at(settings, 'min_confidence'), at(settings, 'jev_min_confidence'));
    return {
      decision_question: defaultInstructions(name, desc, wfName),
      routing_mode: mode,
      unclear_branch: trim(strval(coalesce(at(settings, 'unclear_branch'), ''))),
      min_confidence: is_numeric(floor) ? F(Math.max(0.0, Math.min(1.0, floatval(floor)))) : F(DEFAULT_CONFIDENCE_FLOOR),
      decision: db === null ? [] : await DispatcherDecisionFacts.candidates(mode),
    };
  }

  /** The named provider row, every usable row (admin order) for an unset mode, none for 'llm'. */
  private static async candidates(mode: string): Promise<DecisionCandidate[]> {
    if (mode === 'llm') return [];
    const out: DecisionCandidate[] = [];
    let rows: any[];
    try {
      rows = await DecisionProviders.rows();
    } catch {
      return [];
    }
    for (const row of rows) {
      const key = strval(row['provider_key']);
      const protocol = DecisionProviders.protocolOf(row);
      if (protocol === null || (mode !== '' && key !== mode)) continue;
      const stem = envStem(key);
      const url = trim(strval(coalesce(row['base_url'], '')));
      const model = trim(strval(coalesce(row['model'], '')));
      out.push({
        provider: key,
        protocol: strval(row['protocol']),
        url: truthy(url) ? url : protocol.url,
        model: truthy(model) ? model : protocol.model,
        key_env: stem + '_API_KEY',
        url_env: stem + '_BASE_URL',
      });
    }
    return out;
  }
}
