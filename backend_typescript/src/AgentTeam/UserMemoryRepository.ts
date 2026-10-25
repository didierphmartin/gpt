import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Mirrors src/AgentTeam/Services/UserMemoryRepository.php (+ the parts of
 * UserMemoryEventsRepository / UserMemorySettingsRepository the chat path needs): the user's two
 * memory blocks, the audit log and the auto-update settings. UserMemoryController (the
 * /user-memories API) reads and writes through these same functions.
 * Runtime DDL (ensureTablesExist) is not replicated — the schema already exists.
 */
export const SCOPE_MEMORY = 'memory';
export const SCOPE_USER = 'user';
export const BUDGET_MEMORY = 2200;
export const BUDGET_USER = 1375;

export const SOURCE_MANUAL = 'manual';
export const SOURCE_AUTO_EXTRACT = 'auto_extract';
export const SOURCE_REVERT = 'revert';
export const SOURCE_COMPACT = 'compact';

export const DEFAULT_MEMORY_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_AUTO_UPDATE_ENABLED = true;

const mbLength = (s: string) => [...s].length;
const mbSubstr = (s: string, start: number, len: number) => [...s].slice(start, start + len).join('');
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
const phpRtrim = (s: string) => s.replace(/[ \t\n\r\0\x0B]+$/g, '');

export function budgetFor(scope: string): number {
  return scope === SCOPE_MEMORY ? BUDGET_MEMORY : BUDGET_USER;
}

/** Both scopes in one query (absent scopes are ''). */
export async function getBoth(userId: number): Promise<Record<string, string>> {
  const rows = (await sql<{ scope: string; content: string }>`SELECT scope, content FROM user_memories WHERE user_id = ${userId}`.execute(db)).rows;
  const out: Record<string, string> = { [SCOPE_MEMORY]: '', [SCOPE_USER]: '' };
  for (const row of rows) out[row.scope] = String(row.content);
  return out;
}

/** Writes one scope, truncated to its budget (code points, as mb_substr). */
export async function setScope(userId: number, scope: string, content: string): Promise<void> {
  if (scope !== SCOPE_MEMORY && scope !== SCOPE_USER) throw new Error(`Invalid scope: ${scope}`);
  const limit = budgetFor(scope);
  const value = mbLength(content) > limit ? mbSubstr(content, 0, limit) : content;
  await sql`
      INSERT INTO user_memories (user_id, scope, content)
      VALUES (${userId}, ${scope}, ${value})
      ON DUPLICATE KEY UPDATE content = VALUES(content)`.execute(db);
}

/** Audit row for a change (none for a no-op change). */
export async function logEvent(userId: number, scope: string, source: string, before: string, after: string, rationale: string | null = null, sessionId: string | null = null): Promise<void> {
  if (before === after) return;
  await sql`
      INSERT INTO user_memory_events (user_id, scope, source, before_content, after_content, rationale, session_id)
      VALUES (${userId}, ${scope}, ${source}, ${before}, ${after}, ${rationale}, ${sessionId})`.execute(db);
}

/** The user's auto-update settings (defaults when no row). */
export async function getSettings(userId: number): Promise<{ enabled: boolean; model: string }> {
  const row = (await sql<{ auto_update_enabled: number; auto_update_model: string }>`SELECT auto_update_enabled, auto_update_model FROM user_memory_settings WHERE user_id = ${userId}`.execute(db)).rows[0];
  if (!row) return { enabled: DEFAULT_AUTO_UPDATE_ENABLED, model: DEFAULT_MEMORY_MODEL };
  return { enabled: Boolean(Number(row.auto_update_enabled)), model: String(row.auto_update_model) };
}

/**
 * Non-destructive append: existing lines kept, each new (case-insensitively unseen) addition
 * appended on its own line. Returns the candidate without writing.
 */
export function buildMerged(current: string, additions: unknown[]): string {
  current = phpRtrim(current);
  const existing = new Set<string>();
  for (const line of current.split(/\r?\n/)) {
    const key = phpTrim(line).toLowerCase();
    if (key !== '') existing.add(key);
  }
  const newLines: string[] = [];
  for (const raw of additions) {
    const addition = phpTrim(String(raw ?? ''));
    if (addition === '') continue;
    const key = addition.toLowerCase();
    if (existing.has(key)) continue;
    existing.add(key);
    newLines.push(addition);
  }
  if (!newLines.length) return current;
  if (current === '') return newLines.join('\n');
  return current + '\n' + newLines.join('\n');
}

/**
 * Both scopes as a system-prompt block ("## Memory" / "## User", empty scopes skipped); '' when
 * the user has none or the lookup fails. Providers append it as options.memory_context.
 */
export async function buildMemoryBlock(userId: number): Promise<string> {
  if (userId <= 0) return '';
  let both: Record<string, string>;
  try {
    both = await getBoth(userId);
  } catch (e: any) {
    console.error('[UserMemoryRepository] buildMemoryBlock failed: ' + (e?.message ?? e));
    return '';
  }
  const memory = phpTrim(both[SCOPE_MEMORY] ?? '');
  const user = phpTrim(both[SCOPE_USER] ?? '');
  const parts: string[] = [];
  if (memory !== '') parts.push('## Memory\n' + memory);
  if (user !== '') parts.push('## User\n' + user);
  return parts.join('\n\n');
}
