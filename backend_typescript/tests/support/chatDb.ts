import { FakeHandler } from './fakeDb';

/**
 * In-memory tables for the chat path's lookups: system_llm_settings, users, packages,
 * user_api_keys, user_model_selections, llm_usage_balance. `missing` lists tables SHOW TABLES
 * must report absent.
 */
export interface ChatTables {
  settings: Array<Record<string, any>>;
  users: Record<number, { role: string; plan?: string }>;
  packages: Record<string, any>; // role => capabilities object
  userKeys: Array<Record<string, any>>;
  models: Array<{ user_id: number; provider: string; model: string }>;
  usage: Array<{ user_id: number; provider: string; total_tokens: number }>;
  missing: string[];
}

export function chatTables(init: Partial<ChatTables> = {}): ChatTables {
  return { settings: [], users: {}, packages: {}, userKeys: [], models: [], usage: [], missing: [], ...init };
}

export function chatHandler(t: ChatTables, fallback?: FakeHandler): FakeHandler {
  return (sql, p) => {
    const show = /^SHOW TABLES LIKE '([a-z_]+)'/.exec(sql);
    if (show) return t.missing.includes(show[1]) ? [] : [{ table: show[1] }];
    if (sql.startsWith('select * from `system_llm_settings` where `provider_key` = ?')) {
      return t.settings.filter((r) => r.provider_key === p[0] && Number(r.enabled ?? 1) === Number(p[1])).slice(0, 1);
    }
    if (sql.startsWith('SELECT provider_key FROM system_llm_settings WHERE api_format = ?') || sql.startsWith('SELECT * FROM system_llm_settings WHERE api_format = ?')) {
      return t.settings.filter((r) => r.api_format === p[0]);
    }
    if (sql.startsWith('SELECT role FROM users WHERE id = ?')) {
      const u = t.users[Number(p[0])];
      return u ? [{ role: u.role }] : [];
    }
    if (sql.startsWith('SELECT plan, role FROM users WHERE id = ?')) {
      const u = t.users[Number(p[0])];
      return u ? [{ plan: u.plan ?? 'free', role: u.role }] : [];
    }
    if (sql.startsWith('SELECT capabilities, updated_at FROM packages WHERE role = ?')) {
      const caps = t.packages[String(p[0])];
      return caps === undefined ? [] : [{ capabilities: caps, updated_at: null }];
    }
    if (sql.startsWith('SELECT * FROM user_api_keys WHERE user_id = ?')) {
      return t.userKeys.filter((k) => k.user_id === Number(p[0]));
    }
    if (sql.startsWith('SELECT provider, model FROM user_model_selections WHERE user_id = ?')) {
      return t.models.filter((m) => m.user_id === Number(p[0]));
    }
    if (sql.startsWith('SELECT COALESCE(SUM(total_tokens), 0) as total FROM llm_usage_balance WHERE user_id = ?')) {
      const excluded = p.slice(1).map(String);
      const total = t.usage.filter((u) => u.user_id === Number(p[0]) && !excluded.includes(u.provider)).reduce((n, u) => n + u.total_tokens, 0);
      return [{ total }];
    }
    return fallback ? fallback(sql, p) : [];
  };
}

/** A chat provider row as system_llm_settings stores it. */
export function settingsRow(key: string, extra: Record<string, any> = {}): Record<string, any> {
  return {
    provider_key: key, display_name: key, api_key: 'sys-' + key, model: key + '-model', base_url: 'https://api.' + key + '.test',
    chat_endpoint: '/v1/chat', api_format: key === 'claude' ? 'anthropic' : 'openai', max_tokens: 4096, temperature: 0.7,
    system_prompt: 'admin persona', enabled: 1, sort_order: 0, streaming: null, supports_tools: null, ...extra,
  };
}
