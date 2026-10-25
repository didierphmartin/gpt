import { sql } from 'kysely';
import { db } from '../db/pools';
import { DECISION_PROTOCOLS, envStem } from './DecisionProtocols';
import { ROUTER_FORMAT } from './ProviderKinds';

/**
 * The decision providers an admin configured: system_llm_settings rows with api_format 'router'.
 * Read with SELECT * so an install without the `protocol` column reads protocol null = unusable.
 * Mirrors backend/src/Services/DecisionProviders.php.
 */
export type DecisionRow = Record<string, any>;
export type DecisionProtocol = (typeof DECISION_PROTOCOLS)[string];

const truthy = (v: any) => !(v === undefined || v === null || v === false || v === 0 || v === '' || v === '0');

export const DecisionProviders = {
  /** Router rows in admin order (sort_order, then key); enabled ones only unless asked. */
  async rows(enabledOnly = true): Promise<DecisionRow[]> {
    let rows: DecisionRow[];
    try {
      rows = (
        await sql<DecisionRow>`SELECT * FROM system_llm_settings WHERE api_format = ${ROUTER_FORMAT} ORDER BY sort_order ASC, provider_key ASC`.execute(db)
      ).rows;
    } catch (e: any) {
      console.error('[DecisionProviders] rows lookup failed: ' + (e?.message ?? e));
      return [];
    }
    return rows.filter((r) => !enabledOnly || truthy(r.enabled));
  },

  /** The enabled decision row for a key, null when there is none. */
  async row(key: string): Promise<DecisionRow | null> {
    for (const r of await DecisionProviders.rows()) {
      if (String(r.provider_key) === key) return r;
    }
    return null;
  },

  /** Every decision key, enabled or not (quota, key screens). */
  async keys(): Promise<string[]> {
    return (await DecisionProviders.rows(false)).map((r) => String(r.provider_key));
  },

  protocolOf(row: DecisionRow): DecisionProtocol | null {
    const id = row?.protocol;
    return typeof id === 'string' && Object.hasOwn(DECISION_PROTOCOLS, id) ? DECISION_PROTOCOLS[id] : null;
  },

  /** Env var stem for a row key: upper case, every char outside A-Z0-9 -> '_'. */
  envStem,
};
