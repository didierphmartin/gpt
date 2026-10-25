import { config, DbConfig } from '../config/env';
import { Ctx, ControllerResult } from '../Support/Http';
import { SqlConn, connectSql } from '../Services/LoginDb';
import { requireAdmin } from './RequiresAdmin';
import { isPhpArray, phpJsonDecodeAssoc, phpJsonEncode, phpJsonEscape } from '../Support/PhpJson';
import { phpBool, phpEmpty, phpStr, phpTrim } from '../Playbook/php';

type VideoEditorConfig = { videoEditorDatabase?: DbConfig; loginDatabase?: DbConfig };

/** PHP (int) cast. */
function intVal(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (v === null || v === undefined || typeof v === 'object') return 0;
  const n = parseInt(phpTrim(String(v)), 10);
  return Number.isNaN(n) ? 0 : n;
}

/** PHP (float) cast. */
function floatVal(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || typeof v === 'object') return 0;
  const n = parseFloat(phpTrim(String(v)));
  return Number.isNaN(n) ? 0 : n;
}

/** PHP (string) cast, including (string) of an array ("Array"). */
function strVal(v: unknown): string {
  if (v !== null && typeof v === 'object') return 'Array';
  return phpStr(v);
}

/** PHP is_numeric() for a request value. */
function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  return /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(v);
}

/** A PHP float as json_encode writes it (1.0 -> "1.0"). */
function floatJson(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toFixed(1);
  return JSON.stringify(n);
}

/** json_encode of the cleaned model catalog, whose `cost` is a PHP float. */
function encodeModels(rows: Array<Record<string, any>>): string {
  const parts = rows.map((r) => '{' + Object.entries(r)
    .map(([k, v]) => JSON.stringify(k) + ':' + (k === 'cost' ? floatJson(v) : JSON.stringify(v)))
    .join(',') + '}');
  // PHP's escaping of slashes and non-ASCII (a float has neither).
  return phpJsonEscape('[' + parts.join(',') + ']');
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Mirrors src/Controllers/VideoEditorController.php — the gpt_admin "Video Editor" pages over the
 * dedicated video-edit usage DB (netfo587_video_editor): per-generation cost/usage, prices, the
 * provider/model catalog, per-role packages and per-user overrides. User names (and the video-edit
 * roles) come from the login DB, since usage.user_id is the login user id. Every endpoint is behind
 * RequiresAdmin (the chatbot DB re-reads the caller's role).
 *
 * Statements are PHP's with `?` placeholders (PHP binds named ones). mysql2 answers INT columns as
 * numbers and DECIMAL/SUM aggregates as strings, as PHP's mysqlnd does; only PHP's own casts are applied.
 */
export class VideoEditorController {
  /** App identifier stored in login.app_user_roles.app (must match video-edit's VE_APP). */
  static readonly APP = 'video-edit';
  private static readonly ROLES = ['guest', 'prospect', 'user', 'admin', 'affiliate'];

  constructor(private readonly cfg: VideoEditorConfig = config) {}

  /** A connection for a named config block, or null if unconfigured/unreachable. */
  private async connect(key: 'videoEditorDatabase' | 'loginDatabase'): Promise<SqlConn | null> {
    const c = this.cfg[key];
    if (!c || !c.user || !c.database) return null;
    try {
      return await connectSql(c);
    } catch (e: any) {
      const name = key === 'videoEditorDatabase' ? 'video_editor_database' : 'login_database';
      console.error(`[video-editor] DB '${name}' connect failed: ` + (e?.message ?? e));
      return null;
    }
  }

  /** The video-edit usage DB (overridable seam for tests). */
  protected ve(): Promise<SqlConn | null> {
    return this.connect('videoEditorDatabase');
  }

  /** The login DB (overridable seam for tests). */
  protected login(): Promise<SqlConn | null> {
    return this.connect('loginDatabase');
  }

  /** registered_apps.id for the video-edit app (roles live in login.app_user_roles keyed by it). */
  private async veAppId(login: SqlConn): Promise<number | null> {
    try {
      const r = (await login.select('SELECT id FROM registered_apps WHERE app_id = ? LIMIT 1', [VideoEditorController.APP]))[0];
      return r ? intVal(Object.values(r)[0]) : null;
    } catch {
      return null;
    }
  }

  /** Resolve {user_id: {email, name}} from the login users table. */
  private async usersById(ids: unknown[]): Promise<Map<number, { email: string; name: string }>> {
    const out = new Map<number, { email: string; name: string }>();
    const list = [...new Set(ids.map(intVal).filter((n) => n !== 0))];
    if (!list.length) return out;
    const login = await this.login();
    if (!login) return out;
    const rows = await login.select(
      `SELECT id, email, first_name, last_name FROM users WHERE id IN (${list.map(() => '?').join(',')})`, list);
    for (const r of rows) {
      const name = phpTrim(`${r.first_name ?? ''} ${r.last_name ?? ''}`);
      out.set(intVal(r.id), { email: r.email ?? '', name: name !== '' ? name : r.email ?? '' });
    }
    return out;
  }

  private days(ctx: Ctx): number {
    return Math.max(1, Math.min(365, intVal(ctx.query?.days ?? 30)));
  }

  /** GET /api/v1/admin/video-editor/usage/stats?days=30 — totals, by model, daily trend. */
  async getUsageStats(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, available: false, message: 'Video-edit usage DB not reachable' };
    const days = this.days(ctx);
    try {
      const totals = (await ve.select(`SELECT COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost,
                    COALESCE(SUM(prompt_tokens),0) tokens_in, COALESCE(SUM(completion_tokens),0) tokens_out,
                    COUNT(DISTINCT user_id) users
                    FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`, [days]))[0] ?? false;
      const byModel = await ve.select(`SELECT kind, model, COUNT(*) generations, COALESCE(SUM(units),0) units,
                    COALESCE(SUM(cost_usd),0) cost FROM video_edit_usage
                    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY kind, model ORDER BY cost DESC`, [days]);
      const daily = await ve.select(`SELECT DATE(created_at) day, COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost
                    FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                    GROUP BY DATE(created_at) ORDER BY day ASC`, [days]);
      return { success: true, available: true, days, totals, byModel, daily };
    } catch {
      return { success: false, available: false, message: 'Usage query failed' };
    }
  }

  /** GET /api/v1/admin/video-editor/usage/by-user?days=30 — per-user consumption + names. */
  async getUsageByUser(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, available: false, users: [] };
    const days = this.days(ctx);
    try {
      const rows = await ve.select(`SELECT user_id, COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost,
                COALESCE(SUM(prompt_tokens),0) tokens_in, COALESCE(SUM(completion_tokens),0) tokens_out,
                MAX(created_at) last_used
                FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                GROUP BY user_id ORDER BY cost DESC`, [days]);
      const names = await this.usersById(rows.map((r) => r.user_id));
      for (const r of rows) {
        const u = names.get(intVal(r.user_id));
        r.email = u?.email ?? null;
        r.name = u?.name ?? null;
      }
      return { success: true, available: true, days, users: rows };
    } catch {
      return { success: false, available: false, users: [] };
    }
  }

  /**
   * GET /api/v1/admin/video-editor/transactions?user_id=&month=YYYY-MM&days=&all=1&page=&per_page=
   * Row-level generation transactions, newest first, paged. Period defaults to the current
   * calendar month; user_id narrows to one user (the Users-tab drill-down).
   */
  async getTransactions(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, available: false, rows: [], total: 0 };
    const q: Record<string, any> = ctx.query ?? {};
    const page = Math.max(1, intVal(q.page ?? 1));
    const perPage = Math.max(1, Math.min(100, intVal(q.per_page ?? 20)));
    const where: string[] = [];
    const params: unknown[] = [];
    if (!phpEmpty(q.user_id)) {
      where.push('user_id = ?');
      params.push(intVal(q.user_id));
    }
    if (!phpEmpty(q.all)) {
      // no period filter
    } else if (!phpEmpty(q.days)) {
      where.push('created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
      params.push(Math.max(1, Math.min(365, intVal(q.days))));
    } else {
      let month = strVal(q.month ?? '');
      if (!/^\d{4}-\d{2}\n?$/.test(month)) {
        const d = new Date();
        month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
      }
      where.push("DATE_FORMAT(created_at, '%Y-%m') = ?");
      params.push(month);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    try {
      const c = (await ve.select(`SELECT COUNT(*) FROM video_edit_usage ${w}`, params))[0];
      const total = intVal(c ? Object.values(c)[0] : 0);
      const rows = await ve.select(`SELECT id, user_id, kind, provider, model, units, cost_usd, status, created_at
                FROM video_edit_usage ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, perPage, (page - 1) * perPage]);
      const names = await this.usersById(rows.map((r) => r.user_id));
      for (const r of rows) {
        const u = names.get(intVal(r.user_id));
        r.email = u?.email ?? null;
        r.name = u?.name ?? null;
      }
      return { success: true, available: true, rows, total, page, per_page: perPage };
    } catch {
      return { success: false, available: false, rows: [], total: 0 };
    }
  }

  /**
   * GET /api/v1/admin/video-editor/usage/summary — per-kind cost/generation totals bucketed today /
   * this week (ISO, since Monday) / this month (calendar) / all time, plus a last-30-day by-model
   * breakdown. All money is USD; the client converts for display.
   */
  async getUsageSummary(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, available: false, message: 'Video-edit usage DB not reachable' };
    const blank = () => ({
      totals: { today: 0.0, week: 0.0, month: 0.0, total: 0.0 },
      counts: { today: 0, week: 0, month: 0, total: 0 },
      byModel: [] as any[],
    });
    const kinds: Record<string, ReturnType<typeof blank>> = {};
    for (const k of ['video', 'image', 'music']) kinds[k] = blank();
    try {
      const weekStart = 'DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)';
      const monthStart = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
      const buckets = await ve.select(`SELECT kind,
                    COALESCE(SUM(CASE WHEN DATE(created_at)=CURDATE() THEN cost_usd END),0) cost_today,
                    COALESCE(SUM(CASE WHEN created_at >= ${weekStart} THEN cost_usd END),0) cost_week,
                    COALESCE(SUM(CASE WHEN created_at >= ${monthStart} THEN cost_usd END),0) cost_month,
                    COALESCE(SUM(cost_usd),0) cost_total,
                    COALESCE(SUM(DATE(created_at)=CURDATE()),0) gen_today,
                    COALESCE(SUM(created_at >= ${weekStart}),0) gen_week,
                    COALESCE(SUM(created_at >= ${monthStart}),0) gen_month,
                    COUNT(*) gen_total
                FROM video_edit_usage GROUP BY kind`);
      for (const r of buckets) {
        const k = strVal(r.kind);
        if (!kinds[k]) kinds[k] = blank();
        kinds[k].totals = {
          today: floatVal(r.cost_today), week: floatVal(r.cost_week),
          month: floatVal(r.cost_month), total: floatVal(r.cost_total),
        };
        kinds[k].counts = {
          today: intVal(r.gen_today), week: intVal(r.gen_week),
          month: intVal(r.gen_month), total: intVal(r.gen_total),
        };
      }
      const byModel = await ve.select(`SELECT kind, model, COUNT(*) generations,
                    COALESCE(SUM(units),0) units, COALESCE(SUM(cost_usd),0) cost, MAX(created_at) last_used
                FROM video_edit_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                GROUP BY kind, model ORDER BY cost DESC`);
      for (const r of byModel) {
        const k = strVal(r.kind);
        if (!kinds[k]) kinds[k] = blank();
        kinds[k].byModel.push({
          model: r.model,
          generations: intVal(r.generations),
          units: floatVal(r.units),
          cost: floatVal(r.cost),
          last_used: r.last_used,
        });
      }
      return { success: true, available: true, kinds };
    } catch {
      return { success: false, available: false, message: 'Usage summary query failed' };
    }
  }

  /** GET /api/v1/admin/video-editor/prices — the editable price table. */
  async getPrices(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, prices: [] };
    try {
      const prices = await ve.select('SELECT model, unit, rate, label, updated_at FROM video_edit_prices ORDER BY model');
      return { success: true, prices };
    } catch {
      return { success: false, prices: [] };
    }
  }

  /** POST /api/v1/admin/video-editor/prices — upsert one model's rate. */
  async savePrice(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, message: 'DB not reachable' };
    const b: Record<string, any> = ctx.body ?? {};
    const model = phpTrim(strVal(b.model ?? ''));
    const unit = ['sec', 'image', 'clip'].includes(b.unit ?? '') ? b.unit : null;
    if (model === '' || unit === null || b.rate === undefined || b.rate === null) {
      return { success: false, message: 'model, unit (sec|image|clip) and rate are required' };
    }
    try {
      await ve.execute(`INSERT INTO video_edit_prices (model, unit, rate, label)
                VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE unit=VALUES(unit), rate=VALUES(rate), label=VALUES(label)`,
      [model, unit, floatVal(b.rate), strVal(b.label ?? '')]);
      return { success: true };
    } catch {
      return { success: false, message: 'Save failed' };
    }
  }

  /** GET /api/v1/admin/video-editor/providers — provider credentials plus each provider's model catalog. */
  async getProviders(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, providers: [] };
    try {
      // Base rows never reference models_json, so a not-yet-migrated DB still works. api_key is
      // returned in the clear: this endpoint is admin-gated and the admin UI masks keys.
      const rows = await ve.select(`SELECT provider, label, api_base, enabled, api_key,
                (api_key IS NOT NULL AND api_key <> '') AS has_key, updated_at
                FROM video_edit_providers ORDER BY provider`);

      // Preferred source: the per-provider models_json catalog (empty if the column isn't there yet).
      const mjson: Record<string, any[]> = {};
      try {
        for (const r of await ve.select('SELECT provider, models_json FROM video_edit_providers')) {
          const d = phpJsonDecodeAssoc(r.models_json ?? '');
          if (isPhpArray(d) && Object.keys(d).length) mjson[r.provider] = Object.values(d);
        }
      } catch {
        /* models_json column not added yet */
      }

      // Legacy fallback: the old video_edit_models + video_edit_prices tables.
      const legacy: Record<string, any[]> = {};
      try {
        for (const r of await ve.select(`SELECT m.provider, m.model, m.label, m.kind, pr.unit, pr.rate
                        FROM video_edit_models m LEFT JOIN video_edit_prices pr ON pr.model = m.model
                        ORDER BY m.model`)) {
          const kind = strVal(r.kind ?? 'video');
          (legacy[r.provider] ??= []).push({
            model: r.model,
            label: strVal(r.label ?? ''),
            kind,
            cost: floatVal(r.rate ?? 0),
            unit: strVal(r.unit ?? (kind === 'image' ? 'image' : kind === 'music' ? 'clip' : 'sec')),
          });
        }
      } catch {
        /* old tables already dropped */
      }

      for (const r of rows) {
        r.enabled = intVal(r.enabled);
        r.has_key = phpBool(r.has_key);
        const prov = r.provider;
        r.models = mjson[prov]?.length ? mjson[prov] : legacy[prov] ?? [];
      }
      return { success: true, providers: rows };
    } catch {
      return { success: false, providers: [] };
    }
  }

  /**
   * POST /api/v1/admin/video-editor/providers — upsert a provider. A blank/omitted api_key leaves the
   * stored key untouched (so editing never wipes the secret); omitting "models" keeps the catalog.
   */
  async saveProvider(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, message: 'DB not reachable' };
    const b: Record<string, any> = ctx.body ?? {};
    const provider = phpTrim(strVal(b.provider ?? ''));
    if (provider === '') return { success: false, message: 'provider is required' };
    const label = strVal(b.label ?? provider);
    const apiBase = strVal(b.api_base ?? '');
    const enabled = !phpEmpty(b.enabled) ? 1 : 0;
    const apiKey = phpTrim(strVal(b.api_key ?? ''));
    let modelsJson: string | null = null;
    if (Object.prototype.hasOwnProperty.call(b, 'models') && isPhpArray(b.models)) {
      const clean: Array<Record<string, any>> = [];
      for (const raw of Object.values(b.models)) {
        const m: Record<string, any> = isPhpArray(raw) ? (raw as Record<string, any>) : {};
        const mid = phpTrim(strVal(m.model ?? ''));
        if (mid === '') continue;
        const row: Record<string, any> = {
          model: mid,
          label: strVal(m.label ?? ''),
          kind: ['video', 'image', 'music'].includes(m.kind ?? '') ? m.kind : 'video',
          cost: floatVal(m.cost ?? 0),
          unit: strVal(m.unit ?? ''),
        };
        // Optional metadata consumed by video-edit's api/models.php.
        const cid = phpTrim(strVal(m.client_id ?? ''));
        if (cid !== '') row.client_id = cid;
        if (Object.prototype.hasOwnProperty.call(m, 'start_frame')) row.start_frame = phpBool(m.start_frame);
        if (Object.prototype.hasOwnProperty.call(m, 'end_frame')) row.end_frame = phpBool(m.end_frame);
        clean.push(row);
      }
      modelsJson = encodeModels(clean);
    }
    try {
      const cols: Array<[string, unknown]> = [['provider', provider], ['label', label], ['api_base', apiBase], ['enabled', enabled]];
      if (apiKey !== '') cols.push(['api_key', apiKey]);
      else if (!phpEmpty(b.clear_key)) cols.push(['api_key', null]); // explicit removal only
      if (modelsJson !== null) cols.push(['models_json', modelsJson]);
      const fields = cols.map(([k]) => k).join(', ');
      const holders = cols.map(() => '?').join(', ');
      const updates = cols.filter(([k]) => k !== 'provider').map(([k]) => `${k}=VALUES(${k})`).join(', ');
      await ve.execute(`INSERT INTO video_edit_providers (${fields}) VALUES (${holders})
                ON DUPLICATE KEY UPDATE ${updates}`, cols.map(([, v]) => v));
      return { success: true };
    } catch {
      return { success: false, message: 'Save failed' };
    }
  }

  /** GET /api/v1/admin/video-editor/models — the model catalog (per provider). */
  async getModels(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, models: [] };
    try {
      const rows = await ve.select(`SELECT model, provider, kind, label, enabled, updated_at
                FROM video_edit_models ORDER BY provider, model`);
      for (const r of rows) r.enabled = intVal(r.enabled);
      return { success: true, models: rows };
    } catch {
      return { success: false, models: [] };
    }
  }

  /** POST /api/v1/admin/video-editor/models — upsert one model. */
  async saveModel(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, message: 'DB not reachable' };
    const b: Record<string, any> = ctx.body ?? {};
    const model = phpTrim(strVal(b.model ?? ''));
    const provider = phpTrim(strVal(b.provider ?? ''));
    const kind = ['video', 'image', 'music'].includes(b.kind ?? '') ? b.kind : null;
    if (model === '' || provider === '' || kind === null) {
      return { success: false, message: 'model, provider and kind (video|image|music) are required' };
    }
    const enabled = !phpEmpty(b.enabled) ? 1 : 0;
    try {
      await ve.execute(`INSERT INTO video_edit_models (model, provider, kind, label, enabled)
                VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
                provider=VALUES(provider), kind=VALUES(kind), label=VALUES(label), enabled=VALUES(enabled)`,
      [model, provider, kind, strVal(b.label ?? model), enabled]);
      return { success: true };
    } catch {
      return { success: false, message: 'Save failed' };
    }
  }

  /** GET /api/v1/admin/video-editor/user-override?user_id= — a user's capability override + BYO-key providers. */
  async getUserOverride(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, message: 'DB not reachable' };
    const uid = intVal(ctx.query?.user_id ?? 0);
    if (uid <= 0) return { success: false, message: 'user_id is required' };
    try {
      const r = (await ve.select('SELECT capabilities, byo_keys FROM video_edit_user_overrides WHERE user_id = ? LIMIT 1', [uid]))[0];
      const caps = r ? phpJsonDecodeAssoc(strVal(r.capabilities)) : null;
      const byo = r ? phpJsonDecodeAssoc(strVal(r.byo_keys)) : null;
      const byoProviders: Array<string | number> = [];
      if (isPhpArray(byo)) {
        for (const [prov, val] of Object.entries(byo)) if (strVal(val) !== '') byoProviders.push(Array.isArray(byo) ? Number(prov) : prov);
      }
      return { success: true, user_id: uid, capabilities: isPhpArray(caps) ? caps : null, byo_providers: byoProviders };
    } catch {
      return { success: false, message: 'Load failed' };
    }
  }

  /**
   * POST /api/v1/admin/video-editor/user-override — upsert a user's override.
   * Body: { user_id, capabilities: {...}|null, byo_keys: {provider: key} }.
   * A blank BYO value keeps the existing key; "__clear__" removes it.
   */
  async saveUserOverride(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, message: 'DB not reachable' };
    const b: Record<string, any> = ctx.body ?? {};
    const uid = intVal(b.user_id ?? 0);
    if (uid <= 0) return { success: false, message: 'user_id is required' };
    const caps = Object.prototype.hasOwnProperty.call(b, 'capabilities') ? b.capabilities : null;
    const capsJson = isPhpArray(caps) ? phpJsonEncode(caps) : null;
    const incoming: Record<string, any> = isPhpArray(b.byo_keys) ? b.byo_keys : {};
    const adminId = isNumeric(ctx.user_id) ? intVal(ctx.user_id) : null;
    try {
      const row = (await ve.select('SELECT byo_keys FROM video_edit_user_overrides WHERE user_id = ? LIMIT 1', [uid]))[0];
      const existing = row ? Object.values(row)[0] : false;
      const decoded = phpBool(existing) ? phpJsonDecodeAssoc(strVal(existing)) : null;
      const byo: Record<string, any> = isPhpArray(decoded) && Object.keys(decoded).length > 0 ? { ...decoded } : {};
      for (const [prov, raw] of Object.entries(incoming)) {
        const val = strVal(raw);
        if (val === '') continue; // keep existing
        if (val === '__clear__') {
          delete byo[prov];
          continue;
        }
        byo[prov] = val;
      }
      const byoJson = Object.keys(byo).length ? phpJsonEncode(byo) : null;
      await ve.execute(`INSERT INTO video_edit_user_overrides (user_id, capabilities, byo_keys, updated_by)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), byo_keys = VALUES(byo_keys), updated_by = VALUES(updated_by)`,
      [uid, capsJson, byoJson, adminId]);
      return { success: true };
    } catch {
      return { success: false, message: 'Save failed' };
    }
  }

  /** GET /api/v1/admin/video-editor/packages — role → capabilities (video-edit DB). */
  async getPackages(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, packages: [] };
    try {
      const rows = await ve.select('SELECT role, capabilities, updated_at FROM video_edit_packages ORDER BY role');
      for (const r of rows) {
        const d = phpJsonDecodeAssoc(strVal(r.capabilities));
        r.capabilities = isPhpArray(d) ? d : {};
      }
      return { success: true, packages: rows };
    } catch {
      return { success: false, packages: [] };
    }
  }

  /** POST /api/v1/admin/video-editor/packages — upsert one role's capabilities. Body: { role, capabilities }. */
  async savePackage(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const ve = await this.ve();
    if (!ve) return { success: false, message: 'DB not reachable' };
    const b: Record<string, any> = ctx.body ?? {};
    const role = strVal(b.role ?? '');
    if (!VideoEditorController.ROLES.includes(role)) return { success: false, message: 'invalid role' };
    const caps = b.capabilities ?? null;
    if (!isPhpArray(caps)) return { success: false, message: 'capabilities object is required' };
    const adminId = isNumeric(ctx.user_id) ? intVal(ctx.user_id) : null;
    try {
      await ve.execute(`INSERT INTO video_edit_packages (role, capabilities, updated_by)
                VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE capabilities = VALUES(capabilities), updated_by = VALUES(updated_by)`,
      [role, phpJsonEncode(caps), adminId]);
      return { success: true };
    } catch {
      return { success: false, message: 'Save failed' };
    }
  }

  /** GET /api/v1/admin/video-editor/users?q= — login users + their video-edit role. */
  async getUsers(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const login = await this.login();
    if (!login) {
      return { success: false, available: false, users: [], message: 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env' };
    }
    const q = phpTrim(strVal(ctx.query?.q ?? ''));
    try {
      const params: unknown[] = [];
      let where = '';
      if (q !== '') {
        where = 'WHERE (email LIKE ? OR first_name LIKE ? OR last_name LIKE ?)';
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      const rows = await login.select(`SELECT id, email, first_name, last_name, provider, email_verified, last_login
                    FROM users ${where} ORDER BY id DESC LIMIT 100`, params);

      // Roles from the CENTRALIZED login DB, keyed by user id.
      const roles = new Map<number, any>();
      const appId = await this.veAppId(login);
      if (appId !== null) {
        for (const rr of await login.select('SELECT user_id, role FROM app_user_roles WHERE app_id = ?', [appId])) {
          roles.set(intVal(rr.user_id), rr.role);
        }
      }
      for (const r of rows) {
        const name = phpTrim(`${r.first_name ?? ''} ${r.last_name ?? ''}`);
        r.name = name !== '' ? name : r.email ?? '';
        r.email_verified = intVal(r.email_verified ?? 0);
        r.ve_role = roles.get(intVal(r.id)) ?? null;
        delete r.first_name;
        delete r.last_name;
      }
      return { success: true, available: true, app: VideoEditorController.APP, users: rows };
    } catch {
      return { success: false, available: false, users: [], message: 'User query failed — check the login DB connection' };
    }
  }

  /**
   * POST /api/v1/admin/video-editor/users/role — set (or clear) a user's video-edit role.
   * Body: { user_id, role }. An empty/"none" role revokes. Stored in login.app_user_roles.
   */
  async setUserRole(ctx: Ctx): Promise<ControllerResult> {
    const err = await requireAdmin(ctx);
    if (err) return err;
    const login = await this.login();
    if (!login) return { success: false, message: 'Login DB not reachable' };
    const appId = await this.veAppId(login);
    if (appId === null) return { success: false, message: 'video-edit app not registered in login' };
    const b: Record<string, any> = ctx.body ?? {};
    const uid = intVal(b.user_id ?? 0);
    const role = strVal(b.role ?? '');
    if (uid <= 0) return { success: false, message: 'user_id is required' };
    const adminId = isNumeric(ctx.user_id) ? intVal(ctx.user_id) : null;
    try {
      if (role === '' || role === 'none') {
        await login.execute('DELETE FROM app_user_roles WHERE user_id = ? AND app_id = ?', [uid, appId]);
      } else {
        if (!VideoEditorController.ROLES.includes(role)) return { success: false, message: 'invalid role' };
        await login.execute(`INSERT INTO app_user_roles (user_id, app_id, role, updated_by)
                    VALUES (?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)`,
        [uid, appId, role, adminId]);
      }
      return { success: true };
    } catch {
      return { success: false, message: 'Save failed' };
    }
  }
}
