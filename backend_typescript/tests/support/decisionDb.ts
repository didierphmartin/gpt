import { FakeHandler } from './fakeDb';
import { DecisionHttp } from '../../src/AgentTeam/DecisionRouter';

/**
 * In-memory tables for the decision-provider lookups (the PHP tests' SQLite fixtures):
 * system_llm_settings, user_api_keys, packages, users. `handler` answers the queries
 * DecisionProviders / DecisionKeyResolver / PackageResolver send.
 */
export interface DecisionTables {
  settings: Array<Record<string, any>>;
  userKeys: Array<{ user_id: number; provider: string; api_key: string; base_url?: string | null; enabled?: number }>;
  packages: Record<string, any>; // role => capabilities object
  users: Record<number, string>; // id => role
  /** price row returned for price lookups (PricingResolver), or null */
  prices?: Record<string, [number | null, number | null]>;
}

export function decisionTables(init: Partial<DecisionTables> = {}): DecisionTables {
  return { settings: [], userKeys: [], packages: {}, users: {}, prices: {}, ...init };
}

export function decisionHandler(t: DecisionTables, fallback?: FakeHandler): FakeHandler {
  return (sql, p) => {
    if (sql.startsWith('SELECT * FROM system_llm_settings WHERE api_format = ?')) {
      return t.settings
        .filter((r) => r.api_format === p[0])
        .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || String(a.provider_key).localeCompare(String(b.provider_key)));
    }
    if (sql.startsWith('SELECT role FROM users WHERE id = ?')) {
      const role = t.users[Number(p[0])];
      return role ? [{ role }] : [];
    }
    if (sql.startsWith('SELECT capabilities, updated_at FROM packages WHERE role = ?')) {
      const caps = t.packages[String(p[0])];
      return caps === undefined ? [] : [{ capabilities: caps, updated_at: null }];
    }
    if (sql.startsWith('SELECT 1 AS one FROM packages WHERE role = ?')) {
      return t.packages[String(p[0])] === undefined ? [] : [{ one: 1 }];
    }
    if (sql.startsWith('SELECT * FROM user_api_keys WHERE user_id = ?')) {
      return t.userKeys.filter((k) => k.user_id === Number(p[0]) && k.provider === p[1] && (k.enabled ?? 1) === 1).slice(0, 1);
    }
    if (sql.includes('price_input_per_1m')) {
      const key = String(p[0]);
      const pr = t.prices?.[key];
      return pr ? [{ price_input_per_1m: pr[0], price_output_per_1m: pr[1] }] : [];
    }
    return fallback ? fallback(sql, p) : [];
  };
}

/** A router row (api_format 'router'). */
export function routerRow(key: string, apiKey = '', extra: Record<string, any> = {}): Record<string, any> {
  return {
    provider_key: key, display_name: key.charAt(0).toUpperCase() + key.slice(1), api_key: apiKey, model: 'jev-latest',
    base_url: null, api_format: 'router', protocol: 'typesafe', enabled: 1, sort_order: 100, ...extra,
  };
}

export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A canned-response HTTP transport (Guzzle's MockHandler + history). An Error in the queue is thrown. */
export function fakeHttp(queue: Array<{ status?: number; body: any } | Error>): { http: DecisionHttp; seen: SeenRequest[]; left: () => number } {
  const seen: SeenRequest[] = [];
  const http: DecisionHttp = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = queue.shift();
    if (next === undefined) throw new Error('Mock queue is empty');
    if (next instanceof Error) throw next;
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return { status: next.status ?? 200, statusText: '', text: async () => text };
  };
  return { http, seen, left: () => queue.length };
}

/** A Jev answer (the recorded API shape). */
export function jevAnswer(choice: string, confidence: number) {
  return {
    body: {
      model: 'jev-1.13.0',
      answers: { route: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } },
      usage: { input_tokens: 342, output_tokens: 39 },
    },
  };
}
