/**
 * Mirrors backend/src/Services/ProviderKinds.php.
 *
 * Which system_llm_settings rows are chat providers, and which are not. A ROUTER row (Jev,
 * TypeSafe's dispatcher router) only borrows the table to store a key; it cannot write a sentence,
 * so it must never be offered, registered or fallen back to as a chat provider.
 * `api_format = 'router'` is the one marker.
 */
export const ROUTER_FORMAT = 'router';
export const JEV_KEY = 'jev';
/** Router rows are allowed for these keys only. */
export const ROUTER_KEYS: readonly string[] = [JEV_KEY];

/** A system_llm_settings row that is a router. */
export function isRouterRow(row: { api_format?: string | null }): boolean {
  return (row?.api_format ?? null) === ROUTER_FORMAT;
}

/** Rows that are chat providers (router rows dropped). */
export function chatProviderRows<T extends { api_format?: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => !isRouterRow(r));
}

/**
 * The two-way pairing rule of SystemSettingsController: a router key must use api_format 'router',
 * and 'router' is reserved for router keys. Returns the error message, or null when valid.
 */
export function routerPairingError(providerKey: string, apiFormat: string): string | null {
  const isRouterKey = ROUTER_KEYS.includes(providerKey);
  if (isRouterKey === (apiFormat === ROUTER_FORMAT)) return null;
  return isRouterKey
    ? `Provider '${providerKey}' is a router: api_format must be '${ROUTER_FORMAT}'`
    : `api_format '${ROUTER_FORMAT}' is reserved for: ${ROUTER_KEYS.join(', ')}`;
}
