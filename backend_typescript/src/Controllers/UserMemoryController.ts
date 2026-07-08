import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';

/**
 * Mirrors src/AgentTeam/Controllers/UserMemoryController.php (+ its three repositories:
 * UserMemoryRepository, UserMemoryEventsRepository, UserMemorySettingsRepository, inlined here).
 *
 * Two per-user markdown blocks — `memory` (project/env facts) and `user` (preferences) — plus an
 * audit log of every change and per-user auto-update settings.
 *
 * Endpoints:
 *  - GET    /api/v1/user-memories             → both scopes + budgets + last_source + auto_update
 *  - PUT    /api/v1/user-memories             → update scope(s) and/or auto_update settings
 *  - GET    /api/v1/user-memories/events      → recent audit events
 *  - DELETE /api/v1/user-memories/events/:id  → remove an audit entry (reverting its change first)
 *
 * Runtime DDL (ensureTablesExist) is not replicated — the schema already exists.
 */
export class UserMemoryController {
  private static readonly SCOPE_MEMORY = 'memory';
  private static readonly SCOPE_USER = 'user';
  private static readonly BUDGET_MEMORY = 2200;
  private static readonly BUDGET_USER = 1375;

  private static readonly SOURCE_MANUAL = 'manual';
  private static readonly SOURCE_REVERT = 'revert';

  private static readonly DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
  private static readonly DEFAULT_ENABLED = true;
  private static readonly ALLOWED_MODELS = [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307',
  ];

  private budgetFor(scope: string): number {
    return scope === UserMemoryController.SCOPE_MEMORY ? UserMemoryController.BUDGET_MEMORY : UserMemoryController.BUDGET_USER;
  }

  // --- memory repository ------------------------------------------------------------------

  private async getScope(userId: number, scope: string): Promise<string> {
    const row = (await sql<{ content: string }>`SELECT content FROM user_memories WHERE user_id = ${userId} AND scope = ${scope}`.execute(db)).rows[0];
    return row ? String(row.content) : '';
  }

  private async getBoth(userId: number): Promise<Record<string, string>> {
    const rows = (await sql<{ scope: string; content: string }>`SELECT scope, content FROM user_memories WHERE user_id = ${userId}`.execute(db)).rows;
    const out: Record<string, string> = { [UserMemoryController.SCOPE_MEMORY]: '', [UserMemoryController.SCOPE_USER]: '' };
    for (const row of rows) out[row.scope] = String(row.content);
    return out;
  }

  private async setScope(userId: number, scope: string, content: string): Promise<void> {
    if (scope !== UserMemoryController.SCOPE_MEMORY && scope !== UserMemoryController.SCOPE_USER) {
      throw new Error(`Invalid scope: ${scope}`);
    }
    const limit = this.budgetFor(scope);
    // Truncate by Unicode code points (matches PHP mb_substr).
    const cp = [...content];
    const value = cp.length > limit ? cp.slice(0, limit).join('') : content;
    await sql`
      INSERT INTO user_memories (user_id, scope, content)
      VALUES (${userId}, ${scope}, ${value})
      ON DUPLICATE KEY UPDATE content = VALUES(content)`.execute(db);
  }

  // --- events repository ------------------------------------------------------------------

  private async logEvent(userId: number, scope: string, source: string, before: string, after: string, rationale: string | null = null, sessionId: string | null = null): Promise<void> {
    if (before === after) return; // no-op change, no audit row
    await sql`
      INSERT INTO user_memory_events (user_id, scope, source, before_content, after_content, rationale, session_id)
      VALUES (${userId}, ${scope}, ${source}, ${before}, ${after}, ${rationale}, ${sessionId})`.execute(db);
  }

  private async lastSource(userId: number, scope: string): Promise<string | null> {
    const row = (await sql<{ source: string }>`SELECT source FROM user_memory_events WHERE user_id = ${userId} AND scope = ${scope} ORDER BY id DESC LIMIT 1`.execute(db)).rows[0];
    return row ? String(row.source) : null;
  }

  private async getEvent(userId: number, eventId: number): Promise<any | null> {
    const row = (
      await sql<any>`
        SELECT id, scope, source, before_content, after_content, rationale, session_id, created_at
        FROM user_memory_events WHERE id = ${eventId} AND user_id = ${userId}`.execute(db)
    ).rows[0];
    return row ?? null;
  }

  private async deleteEventRow(userId: number, eventId: number): Promise<boolean> {
    const res = await sql`DELETE FROM user_memory_events WHERE id = ${eventId} AND user_id = ${userId}`.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  // --- settings repository ----------------------------------------------------------------

  private async getSettings(userId: number): Promise<{ enabled: boolean; model: string }> {
    const row = (await sql<{ auto_update_enabled: number; auto_update_model: string }>`SELECT auto_update_enabled, auto_update_model FROM user_memory_settings WHERE user_id = ${userId}`.execute(db)).rows[0];
    if (!row) return { enabled: UserMemoryController.DEFAULT_ENABLED, model: UserMemoryController.DEFAULT_MODEL };
    return { enabled: Boolean(row.auto_update_enabled), model: String(row.auto_update_model) };
  }

  private async setSettings(userId: number, enabled: boolean, model: string): Promise<void> {
    if (!UserMemoryController.ALLOWED_MODELS.includes(model)) {
      throw new InvalidArgument(`Unsupported model: ${model}`);
    }
    await sql`
      INSERT INTO user_memory_settings (user_id, auto_update_enabled, auto_update_model)
      VALUES (${userId}, ${enabled ? 1 : 0}, ${model})
      ON DUPLICATE KEY UPDATE auto_update_enabled = VALUES(auto_update_enabled), auto_update_model = VALUES(auto_update_model)`.execute(db);
  }

  // --- endpoints --------------------------------------------------------------------------

  /** GET /api/v1/user-memories */
  async show(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };

    const both = await this.getBoth(userId);
    const settings = await this.getSettings(userId);

    return {
      success: true,
      data: {
        memory: {
          content: both[UserMemoryController.SCOPE_MEMORY],
          budget: UserMemoryController.BUDGET_MEMORY,
          last_source: await this.lastSource(userId, UserMemoryController.SCOPE_MEMORY),
        },
        user: {
          content: both[UserMemoryController.SCOPE_USER],
          budget: UserMemoryController.BUDGET_USER,
          last_source: await this.lastSource(userId, UserMemoryController.SCOPE_USER),
        },
        auto_update: {
          enabled: settings.enabled,
          model: settings.model,
          allowed_models: UserMemoryController.ALLOWED_MODELS,
        },
      },
    };
  }

  /** PUT /api/v1/user-memories */
  async update(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };

    const body = ctx.body ?? {};
    const written: string[] = [];

    for (const scope of [UserMemoryController.SCOPE_MEMORY, UserMemoryController.SCOPE_USER]) {
      if (Object.prototype.hasOwnProperty.call(body, scope)) {
        const before = await this.getScope(userId, scope);
        const after = String(body[scope]);
        await this.setScope(userId, scope, after);
        await this.logEvent(userId, scope, UserMemoryController.SOURCE_MANUAL, before, after, null, null);
        written.push(scope);
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'auto_update') && body.auto_update && typeof body.auto_update === 'object') {
      const current = await this.getSettings(userId);
      const enabled = Object.prototype.hasOwnProperty.call(body.auto_update, 'enabled') ? Boolean(body.auto_update.enabled) : current.enabled;
      const model = Object.prototype.hasOwnProperty.call(body.auto_update, 'model') ? String(body.auto_update.model) : current.model;
      try {
        await this.setSettings(userId, enabled, model);
        written.push('auto_update');
      } catch (e: any) {
        if (e instanceof InvalidArgument) return { status_code: 400, success: false, error: e.message };
        throw e;
      }
    }

    if (written.length === 0) {
      return { status_code: 400, success: false, error: 'Nothing to update — provide "memory", "user", or "auto_update"' };
    }

    return { success: true, data: { updated: written } };
  }

  /** GET /api/v1/user-memories/events */
  async listEvents(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };

    let limit = parseInt(String((ctx.query as any)?.limit ?? 50), 10);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(1, Math.min(200, limit));

    const rows = (
      await sql<any>`
        SELECT id, scope, source, before_content, after_content, rationale, session_id, created_at
        FROM user_memory_events WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${sql.lit(limit)}`.execute(db)
    ).rows;

    return {
      success: true,
      data: rows.map((e) => ({
        id: Number(e.id),
        scope: e.scope,
        source: e.source,
        before: e.before_content,
        after: e.after_content,
        rationale: e.rationale,
        session_id: e.session_id,
        created_at: e.created_at,
      })),
    };
  }

  /** DELETE /api/v1/user-memories/events/:id */
  async deleteEvent(ctx: Ctx): Promise<ControllerResult> {
    const userId = Number(ctx.user_id ?? 0);
    if (!userId) return { status_code: 401, success: false, error: 'Authentication required' };

    const eventId = parseInt(ctx.params.id ?? '0', 10);
    if (!eventId) return { status_code: 400, success: false, error: 'Invalid event id' };

    const event = await this.getEvent(userId, eventId);
    if (!event) return { status_code: 404, success: false, error: 'Event not found' };

    const scope = event.scope;
    let reverted = false;
    if (event.source !== UserMemoryController.SOURCE_REVERT) {
      await this.setScope(userId, scope, String(event.before_content));
      reverted = true;
    }

    const deleted = await this.deleteEventRow(userId, eventId);

    return { success: true, data: { deleted_event: eventId, scope, reverted, deleted } };
  }
}

/** Marker error so update() can map an unsupported-model rejection to HTTP 400 (mirrors PHP's \InvalidArgumentException). */
class InvalidArgument extends Error {}
