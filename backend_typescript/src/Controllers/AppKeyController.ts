import { sql } from 'kysely';
import { db } from '../db/pools';
import { config } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';
import { AppKeyRepository } from '../Services/AppKeyRepository';

/**
 * Mirrors src/AgentTeam/Controllers/AppKeyController.php.
 *
 * Manages app keys — scoped, revocable credentials for client code that
 * calls the backend without a user's login JWT.
 *
 *   POST   /api/v1/app-keys           create  (admin only)
 *   GET    /api/v1/app-keys           index   (admin only)
 *   DELETE /api/v1/app-keys/{id}      destroy (admin only)
 *   GET    /api/v1/app-keys/whoami    whoami  (app-key auth — introspection)
 *
 * CRUD is admin-only. `whoami` is the lone endpoint an app key itself may call.
 *
 * Faithful divergence: PHP constructs the AppKeyRepository in the controller
 * constructor (per request in index.php). Here the controller is a module-level
 * singleton, so the repo is built lazily — an empty app_key_secret therefore
 * throws on first endpoint use (→ 500 via handle()) instead of at import,
 * matching PHP's per-request RuntimeException rather than crashing boot.
 */
export class AppKeyController {
  private repoInstance: AppKeyRepository | null = null;

  private repo(): AppKeyRepository {
    if (this.repoInstance === null) {
      this.repoInstance = new AppKeyRepository(config.auth.appKeySecret ?? '');
    }
    return this.repoInstance;
  }

  /**
   * POST /api/v1/app-keys
   * Body: { user_id, application_id, name, scopes: string[] }
   */
  async create(ctx: Ctx): Promise<ControllerResult> {
    const gate = await this.requireAdmin(ctx);
    if (gate) return gate;

    const body: Record<string, any> = ctx.body ?? {};
    const userId = body.user_id !== undefined ? phpIntCast(body.user_id) : 0;
    const applicationId = String(body.application_id ?? '').trim();
    const name = String(body.name ?? '').trim();
    const scopes = body.scopes ?? null;

    if (userId <= 0) {
      return this.err('user_id is required', 400);
    }
    if (applicationId === '') {
      return this.err('application_id is required', 400);
    }
    if (name === '') {
      return this.err('name is required', 400);
    }
    if (!Array.isArray(scopes) || scopes.length === 0) {
      return this.err('scopes must be a non-empty array of strings', 400);
    }
    for (const s of scopes) {
      if (typeof s !== 'string' || s.trim() === '') {
        return this.err('every scope must be a non-empty string', 400);
      }
    }

    // The user the key acts for must exist.
    const userRow = (
      await sql<{ id: number }>`SELECT id FROM users WHERE id = ${userId} LIMIT 1`.execute(db)
    ).rows[0];
    if (!userRow) {
      return this.err(`user_id ${userId} does not exist`, 400);
    }

    const created = await this.repo().create(
      userId,
      applicationId,
      name,
      (scopes as string[]).map((s) => s.trim())
    );

    return {
      success: true,
      data: created, // includes full_key — visible ONCE
      status_code: 201,
    };
  }

  /**
   * GET /api/v1/app-keys[?application_id=&user_id=]
   */
  async index(ctx: Ctx): Promise<ControllerResult> {
    const gate = await this.requireAdmin(ctx);
    if (gate) return gate;

    const query: Record<string, any> = ctx.query ?? {};
    const applicationId =
      query.application_id !== undefined && query.application_id !== ''
        ? String(query.application_id)
        : null;
    const userId =
      query.user_id !== undefined && query.user_id !== '' ? phpIntCast(query.user_id) : null;

    return {
      success: true,
      data: await this.repo().listAll(applicationId, userId),
      status_code: 200,
    };
  }

  /**
   * DELETE /api/v1/app-keys/{id}
   */
  async destroy(ctx: Ctx): Promise<ControllerResult> {
    const gate = await this.requireAdmin(ctx);
    if (gate) return gate;

    const keyId = phpIntCast(ctx.params?.id ?? 0);
    if (keyId <= 0) {
      return this.err('Invalid key id', 400);
    }
    if (!(await this.repo().findById(keyId))) {
      return this.err('App key not found', 404);
    }

    const revoked = await this.repo().revoke(keyId);
    return {
      success: true,
      data: { id: keyId, revoked },
      status_code: 200,
    };
  }

  /**
   * GET /api/v1/app-keys/workflows?user_id=N
   * Admin-only. Lists a given user's workflows (id + name).
   */
  async listUserWorkflows(ctx: Ctx): Promise<ControllerResult> {
    const gate = await this.requireAdmin(ctx);
    if (gate) return gate;

    const userId = phpIntCast(ctx.query?.user_id ?? 0);
    if (userId <= 0) {
      return this.err('user_id query parameter is required', 400);
    }
    const rows = (
      await sql<{ id: any; name: any }>`
        SELECT id, name FROM agent_workflows WHERE user_id = ${userId} ORDER BY name ASC
      `.execute(db)
    ).rows;
    return {
      success: true,
      data: rows.map((r) => ({ id: Number(r.id), name: String(r.name) })),
      status_code: 200,
    };
  }

  /**
   * GET /api/v1/app-keys/agents?user_id=N
   * Admin-only. Lists a given user's agents (id + name).
   */
  async listUserAgents(ctx: Ctx): Promise<ControllerResult> {
    const gate = await this.requireAdmin(ctx);
    if (gate) return gate;

    const userId = phpIntCast(ctx.query?.user_id ?? 0);
    if (userId <= 0) {
      return this.err('user_id query parameter is required', 400);
    }
    const rows = (
      await sql<{ id: any; name: any }>`
        SELECT id, name FROM agents WHERE user_id = ${userId} ORDER BY name ASC
      `.execute(db)
    ).rows;
    return {
      success: true,
      data: rows.map((r) => ({ id: Number(r.id), name: String(r.name) })),
      status_code: 200,
    };
  }

  /**
   * GET /api/v1/app-keys/whoami
   * App-key-authed. Lets client code introspect its own key. No user info.
   */
  async whoami(ctx: Ctx): Promise<ControllerResult> {
    if ((ctx.auth_type ?? null) !== 'app_key') {
      return this.err('This endpoint requires app-key authentication', 401);
    }

    const scopes: any[] = (ctx as any).app_key_scopes ?? [];

    // Pull the resource ids out of `workflows:run:<id>` / `agents:run:<id>`.
    const workflowIds: number[] = [];
    const agentIds: number[] = [];
    for (const scope of scopes) {
      let m: RegExpMatchArray | null;
      if ((m = String(scope).match(/^workflows:run:(\d+)$/))) {
        workflowIds.push(Number(m[1]));
      } else if ((m = String(scope).match(/^agents:run:(\d+)$/))) {
        agentIds.push(Number(m[1]));
      }
    }

    return {
      success: true,
      data: {
        application_id: (ctx as any).application_id ?? null,
        scopes,
        workflows: await this.resolveNames('agent_workflows', workflowIds),
        agents: await this.resolveNames('agents', agentIds),
      },
      status_code: 200,
    };
  }

  /**
   * Resolve a set of resource ids to [{id, name}], skipping any that no longer
   * exist. $table is a trusted internal literal, never user input.
   */
  private async resolveNames(table: string, ids: number[]): Promise<{ id: number; name: string }[]> {
    const unique = Array.from(new Set(ids.filter((i) => i > 0)));
    if (unique.length === 0) {
      return [];
    }
    const rows = (
      await sql<{ id: any; name: any }>`
        SELECT id, name FROM ${sql.raw(table)} WHERE id IN (${sql.join(unique)}) ORDER BY name ASC
      `.execute(db)
    ).rows;
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name) }));
  }

  /**
   * Gate: caller must be a logged-in user with role='admin'.
   */
  private async requireAdmin(ctx: Ctx): Promise<ControllerResult | null> {
    // App keys can never reach the admin CRUD — only JWT users can.
    if ((ctx.auth_type ?? null) === 'app_key') {
      return this.err('App keys cannot manage app keys', 403);
    }
    const userId = ctx.user_id ?? null;
    if (!userId) {
      return this.err('Authentication required', 401);
    }
    const user = (
      await sql<{ role: string | null }>`SELECT role FROM users WHERE id = ${userId}`.execute(db)
    ).rows[0];
    if (!user || user.role !== 'admin') {
      return this.err('Admin access required', 403);
    }
    return null;
  }

  private err(message: string, code: number): ControllerResult {
    return { success: false, error: message, status_code: code };
  }
}

// PHP (int) cast: truncating; bool→1/0; leading-numeric string, else 0.
function phpIntCast(v: any): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}
