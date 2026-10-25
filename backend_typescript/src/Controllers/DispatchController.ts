import { Ctx, ControllerResult } from '../Support/Http';
import { DecisionHttp, DEFAULT_CONFIDENCE_FLOOR } from '../AgentTeam/DecisionRouter';
import { DecisionProviders } from '../Services/DecisionProviders';
import { DecisionKeyResolver } from '../Services/DecisionKeyResolver';
import { DecisionRouters } from '../Services/DecisionRouters';
import { DecisionUsage, UsageWriter } from '../Services/DecisionUsage';
import { config } from '../config/env';

/**
 * Decision-model routing for the browser run path. Mirrors backend/src/Controllers/DispatchController.php.
 *
 * The canvas Run button executes workflows in the browser, which must never hold a decision
 * provider's key. It asks the server which providers exist (GET /dispatch/providers), whether one
 * has a key (GET /dispatch/{key}/status) and to route (POST /dispatch/route); the key is resolved
 * here, per calling user, and never returned. The /dispatch/jev URLs remain as aliases.
 */
export class DispatchController {
  constructor(
    private http: DecisionHttp | null = null,
    private usage: UsageWriter | null = null,
    private secret: string = config.auth.jwtSecret
  ) {}

  /** GET /dispatch/providers: every decision provider and whether this user can route with it. Never a key. */
  async providers(ctx: Ctx): Promise<ControllerResult> {
    const userId = this.userId(ctx);
    const list = [];
    for (const row of await DecisionProviders.rows()) {
      const key = String(row.provider_key);
      const resolved = await DecisionKeyResolver.resolve(userId, key, this.secret);
      const protocol = resolved.protocol;
      const stem = DecisionProviders.envStem(key);
      const routable = resolved.key !== '';
      list.push({
        key,
        label: String(row.display_name || key),
        protocol: row.protocol ?? null,
        model: String(row.model ?? ''),
        default_url: protocol !== null ? String(row.base_url ?? '').trim() || protocol.url : '',
        allowed: !['not_allowed', 'unknown'].includes(resolved.source),
        has_key: routable,
        source: resolved.source,
        routable,
        reason: routable ? null : DecisionKeyResolver.unavailableReason(resolved, key),
        key_env: stem + '_API_KEY',
        url_env: stem + '_BASE_URL',
        legacy_env: protocol?.legacy_env ?? null,
        // This backend routes with decision models.
        supported: true,
      });
    }
    return { success: true, default: await DecisionKeyResolver.defaultProvider(userId), providers: list, status_code: 200 };
  }

  /** GET /dispatch/{key}/status */
  async status(ctx: Ctx): Promise<ControllerResult> {
    return this.statusOf(String(ctx.params?.key ?? ''), ctx);
  }

  /** GET /dispatch/jev/status (alias kept for pages loaded before the rename). */
  async jevStatus(ctx: Ctx): Promise<ControllerResult> {
    return this.statusOf('jev', ctx);
  }

  private async statusOf(key: string, ctx: Ctx): Promise<ControllerResult> {
    const resolved = await DecisionKeyResolver.resolve(this.userId(ctx), key, this.secret);
    return {
      success: true,
      provider: key,
      allowed: !['not_allowed', 'unknown'].includes(resolved.source),
      available: resolved.key !== '',
      source: resolved.source,
      status_code: 200,
    };
  }

  /** POST /dispatch/jev (alias): route with provider 'jev' unless the body names one. */
  async jevRoute(ctx: Ctx): Promise<ControllerResult> {
    const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    return this.route({ ...ctx, body: { provider: 'jev', ...body } });
  }

  /** POST /dispatch/route: route one request to one of the targets with the named decision provider. */
  async route(ctx: Ctx): Promise<ControllerResult> {
    const input: Record<string, any> = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
    const provider = typeof input.provider === 'string' ? input.provider.trim() : '';
    const text = input.request ?? null;
    const targets = input.targets ?? null;
    const question = input.question ?? null;
    let floor = DEFAULT_CONFIDENCE_FLOOR;

    if (provider === '') return this.bad('provider is required');
    if (typeof text !== 'string' || text.trim() === '') return this.bad('request is required');
    // PHP is_array(): a JSON list or object.
    if (targets === null || typeof targets !== 'object') return this.bad('targets must be an array');
    if (typeof question !== 'string') return this.bad('question must be a string');
    if (Object.hasOwn(input, 'min_confidence') && input.min_confidence !== null) {
      if (!isNumeric(input.min_confidence)) return this.bad('min_confidence must be a number');
      floor = Math.max(0, Math.min(1, Number(String(input.min_confidence).trim())));
    }

    const userId = this.userId(ctx);
    const resolved = await DecisionKeyResolver.resolve(userId, provider, this.secret);
    const router = resolved.key !== '' ? DecisionRouters.make(resolved, floor, this.http) : null;
    const list = Array.isArray(targets) ? targets : Object.values(targets);
    const out = router !== null ? await router.route(text, list, question) : DecisionRouters.unavailable(resolved, provider);
    // One usage row per call the vendor answered; refused calls record nothing.
    await DecisionUsage.record(this.usage, userId, provider, String(resolved.row?.model ?? ''), out);

    const target =
      out.target !== null && typeof out.target === 'object'
        ? { id: out.target.id ?? null, name: out.target.name ?? null }
        : null;

    return {
      success: true,
      provider,
      outcome: out.outcome,
      target,
      confidence: out.confidence,
      ms: out.ms,
      reason: out.reason,
      status_code: 200,
    };
  }

  private userId(ctx: Ctx): number | null {
    return ctx.user_id !== null && ctx.user_id !== undefined ? Math.trunc(Number(ctx.user_id)) || 0 : null;
  }

  private bad(message: string): ControllerResult {
    return { success: false, message, status_code: 400 };
  }
}

/** PHP is_numeric(): a number, or a numeric string (surrounding whitespace allowed). */
export function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  return /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}
