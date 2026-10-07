/**
 * Mirrors backend/src/Services/ProviderKinds.php.
 *
 * Which system_llm_settings rows are chat providers, and which are not. A ROUTER row (a decision-model
 * provider such as TypeSafe's Jev) only borrows the table to store a key; it cannot write a sentence,
 * so it must never be offered, registered or fallen back to as a chat provider.
 * `api_format = 'router'` is the one marker.
 */
import { DECISION_PROTOCOLS, envStem } from './DecisionProtocols';

export const ROUTER_FORMAT = 'router';

/** A system_llm_settings row that is a router. */
export function isRouterRow(row: { api_format?: string | null }): boolean {
  return (row?.api_format ?? null) === ROUTER_FORMAT;
}

/** Rows that are chat providers (router rows dropped). */
export function chatProviderRows<T extends { api_format?: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => !isRouterRow(r));
}

/**
 * The save rules for a row's kind: a row's kind is fixed at creation, a router row names a
 * registered protocol, and no two decision keys may share an env stem. Returns the error message,
 * or null when valid. Same messages as ProviderKinds::routerRowError in PHP.
 */
export function routerRowError(input: {
  providerKey: string;
  apiFormat: string;
  protocol: string | null | undefined;
  existingFormat: string | null;
  otherDecisionKeys: string[];
}): string | null {
  const { providerKey, apiFormat, protocol, existingFormat, otherDecisionKeys } = input;
  const isRouter = apiFormat === ROUTER_FORMAT;
  if (existingFormat !== null && (existingFormat === ROUTER_FORMAT) !== isRouter) {
    return isRouter
      ? `Provider '${providerKey}' is an LLM; it cannot become a decision provider`
      : `Provider '${providerKey}' is a decision provider; it cannot become an LLM`;
  }
  if (!isRouter) return null;
  if (!protocol || !Object.hasOwn(DECISION_PROTOCOLS, protocol)) {
    return 'Decision provider needs a protocol: one of ' + Object.keys(DECISION_PROTOCOLS).join(', ');
  }
  const stem = envStem(providerKey);
  for (const other of otherDecisionKeys) {
    if (other !== providerKey && envStem(other) === stem) {
      return `'${other}' and '${providerKey}' would share the env name ${stem}_API_KEY`;
    }
  }
  return null;
}

type Row = Record<string, any>;

/** Enabled router rows in admin order (sort_order, then key). */
function decisionRows(rows: Row[]): Row[] {
  return rows
    .filter((r) => isRouterRow(r) && r.enabled)
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || String(a.provider_key).localeCompare(String(b.provider_key)));
}

const protocolOf = (row: Row) => (row.protocol && Object.hasOwn(DECISION_PROTOCOLS, row.protocol) && DECISION_PROTOCOLS[row.protocol]) || null;

/** `decision_providers` of GET /settings/keys: usable rows the plan allows. Never a key. No rate on TS. */
export function decisionProviderList(rows: Row[], allowed: (key: string) => boolean) {
  const out = [];
  for (const row of decisionRows(rows)) {
    const key = String(row.provider_key);
    const protocol = protocolOf(row);
    if (!protocol || !allowed(key)) continue;
    out.push({
      key,
      label: String(row.display_name || key),
      protocol: String(row.protocol),
      model: String(row.model || protocol.model),
      default_url: String(row.base_url ?? '').trim() || protocol.url,
      rate: null,
      console_url: protocol.console_url,
    });
  }
  return out;
}

/** GET /dispatch/providers: the rows, none routable (TS has no decision runtime). */
export function dispatchProviderList(rows: Row[], allowed: (key: string) => boolean) {
  const providers = decisionRows(rows).map((row) => {
    const key = String(row.provider_key);
    const protocol = protocolOf(row);
    const stem = envStem(key);
    return {
      key,
      label: String(row.display_name || key),
      protocol: row.protocol ?? null,
      model: String(row.model ?? ''),
      default_url: protocol ? String(row.base_url ?? '').trim() || protocol.url : '',
      allowed: allowed(key),
      has_key: false,
      source: 'none',
      routable: false,
      reason: 'not supported on this backend',
      key_env: `${stem}_API_KEY`,
      url_env: `${stem}_BASE_URL`,
      legacy_env: protocol?.legacy_env ?? null,
      supported: false,
    };
  });
  return { default: null, providers };
}
