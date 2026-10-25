import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { ApiKeyCrypto } from './ApiKeyCrypto';
import { PackageResolver } from './PackageResolver';
import { DecisionProtocol, DecisionProviders, DecisionRow } from './DecisionProviders';

/**
 * Which key and URL a decision provider uses for one user: the user's own key, else the package's
 * default key, else the row's (admin) key -- and only when the user's package allows that provider.
 * The user's own URL goes with the user's own key only, so an admin/package key is never sent to an
 * address a user picked. A key that names no enabled row with a registered protocol is 'unknown':
 * it cannot route, and nothing guesses another provider.
 * Mirrors backend/src/Services/DecisionKeyResolver.php.
 */
export type DecisionKeySource = 'user' | 'package' | 'global' | 'none' | 'not_allowed' | 'unknown';

export interface ResolvedDecisionKey {
  key: string;
  source: DecisionKeySource;
  url: string;
  row: DecisionRow | null;
  protocol: DecisionProtocol | null;
}

const userIdOf = (userId: unknown): number | null =>
  userId !== null && userId !== undefined && /^-?\d+$/.test(String(userId)) ? Number(userId) : null;

export const DecisionKeyResolver = {
  /** `secret`: the user-key encryption secret (auth.jwt_secret). */
  async resolve(userId: number | null, providerKey: string, secret: string = config.auth.jwtSecret): Promise<ResolvedDecisionKey> {
    const row = await DecisionProviders.row(providerKey);
    const protocol = row !== null ? DecisionProviders.protocolOf(row) : null;
    const base = { key: '', url: '', row, protocol };
    if (row === null || protocol === null) {
      return { ...base, source: 'unknown' };
    }
    const rowUrl = String(row.base_url ?? '').trim() || protocol.url;

    const pkg = await packageEntry(userId, providerKey);
    if (pkg === false) {
      return { ...base, source: 'not_allowed', url: rowUrl };
    }

    if (userId !== null && userId > 0) {
      const [userKey, userUrl] = await userRow(secret, userId, providerKey);
      if (userKey !== '') {
        return { ...base, key: userKey, source: 'user', url: userUrl !== '' ? userUrl : rowUrl };
      }
    }

    const packageKey = String(pkg.default_api_key ?? '').trim();
    if (packageKey !== '') {
      return { ...base, key: packageKey, source: 'package', url: rowUrl };
    }

    const globalKey = String(row.api_key ?? '').trim();
    if (globalKey !== '') {
      return { ...base, key: globalKey, source: 'global', url: rowUrl };
    }

    return { ...base, source: 'none', url: rowUrl };
  },

  /** The provider an unset dispatcher uses: first usable row (admin order) the plan allows. */
  async defaultProvider(userId: number | null): Promise<string | null> {
    for (const row of await DecisionProviders.rows()) {
      const key = String(row.provider_key);
      if (DecisionProviders.protocolOf(row) !== null && (await packageEntry(userId, key)) !== false) {
        return key;
      }
    }
    return null;
  },

  async allowed(userId: number | null, providerKey: string): Promise<boolean> {
    return (await packageEntry(userId, providerKey)) !== false;
  },

  /** Why a resolved-empty key cannot route, in the words the user sees. */
  unavailableReason(resolved: ResolvedDecisionKey, providerKey: string): string {
    const label = String(resolved.row?.display_name ?? '').trim() || providerKey;
    switch (resolved.source) {
      case 'unknown':
        return `'${providerKey}' is not an available decision provider`;
      case 'not_allowed':
        return `${label} is not enabled for your plan`;
      default:
        return `no ${label} key`;
    }
  },

  userIdOf,
};

/**
 * The package's entry for this provider, {} when the package sets no provider allowlist, false
 * when the role may not use it. Same rule as the LLM provider list.
 */
async function packageEntry(userId: number | null, providerKey: string): Promise<Record<string, any> | false> {
  let providers: any;
  try {
    providers = (await new PackageResolver().resolveForUser(userId)).capabilities?.providers ?? null;
  } catch (e: any) {
    console.error('[DecisionKeyResolver] package lookup failed: ' + (e?.message ?? e));
    return {};
  }
  // PHP is_array(): a JSON list or object; anything else = no allowlist.
  if (providers === null || typeof providers !== 'object') return {};
  const entry = Array.isArray(providers) ? undefined : providers[providerKey];
  const on = entry?.enabled;
  if (entry === null || typeof entry !== 'object' || on === undefined || on === null || on === false || on === 0 || on === '' || on === '0') {
    return false;
  }
  return entry;
}

/** The user's own [key, url]; ['', ''] when none. */
async function userRow(secret: string, userId: number, providerKey: string): Promise<[string, string]> {
  let row: any;
  try {
    row = (
      await sql<any>`SELECT * FROM user_api_keys WHERE user_id = ${userId} AND provider = ${providerKey} AND enabled = 1 LIMIT 1`.execute(db)
    ).rows[0];
  } catch (e: any) {
    console.error('[DecisionKeyResolver] user key lookup failed: ' + (e?.message ?? e));
    return ['', ''];
  }
  if (!row || typeof row !== 'object') return ['', ''];
  return [ApiKeyCrypto.reveal(String(row.api_key ?? ''), secret), String(row.base_url ?? '').trim()];
}
