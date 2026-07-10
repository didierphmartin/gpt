import bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import path from 'path';
import { sql } from 'kysely';
import { db } from '../db/pools';
import { Ctx, ControllerResult } from '../Support/Http';
import { PackageResolver } from '../Services/PackageResolver';

/**
 * Mirrors src/Controllers/AdminController.php — the admin dashboard's user management over the
 * `users` table. This slice ports the 6 user-CRUD methods (listUsers, getUser, getUserAccount,
 * createUser, updateUser, deleteUser).
 *
 * Faithful-divergence notes:
 *  - GATING: AdminController.php has NO admin-role check (no requireAdmin). These endpoints are
 *    gated by AUTHENTICATION ONLY (the global auth middleware populates ctx.user_id). We therefore
 *    do NOT add a role === 'admin' check — that would diverge from PHP.
 *  - Runtime existence checks: getUserAccount replicates PHP's `SHOW TABLES LIKE
 *    'llm_usage_transactions'` guard (so a missing usage table yields tokens 0/0), but no DDL is
 *    created.
 *  - Password hashing: PHP password_hash($pw, PASSWORD_DEFAULT) = bcrypt cost 10. We use
 *    bcrypt.hashSync(String(pw), 10). Hashes are not byte-identical to PHP (random salt) but are
 *    write-only, so that's fine.
 *  - Int/string parity: the PHP PDO connection uses ATTR_EMULATE_PREPARES=false (native types), so
 *    INT columns come back as ints — matching mysql2, which returns INT as JS number. listUsers/
 *    getUser therefore need no casts. getUserAccount casts id (int)/email_verified (bool) exactly as
 *    PHP does. SUM(...) aggregates come back as strings from mysql2; PHP casts them (int).
 */

// PHP trim() default character mask (" \t\n\r\0\x0B").
function phpTrim(v: any): string {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  return s.replace(/^[ \t\n\r\0\x0B]+/, '').replace(/[ \t\n\r\0\x0B]+$/, '');
}

// PHP empty(): true for null/undefined, false, 0, 0.0, '', '0', [].
function phpEmpty(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === false) return true;
  if (v === '' || v === '0') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// PHP (int) cast semantics (truncating; bool→1/0; leading-numeric, else 0).
function phpIntVal(v: any): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

// PHP (bool) cast semantics (false for null/0/""/"0"/false; true otherwise).
function phpBoolVal(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0';
  if (v === null || v === undefined) return false;
  return true;
}

// PHP round($v, 2) — half away from zero. Values here are non-negative.
// PHP round($v, $precision) — half away from zero. PHP pre-rounds the scaled value to ~15
// significant digits to cancel float representation error before rounding; naive Math.round(v*f)/f
// drifts by 1 ulp on values like 8.09865 (JS → 8.0986, PHP → 8.0987). Mirror the pre-round.
function phpRound(value: number, precision: number): number {
  if (!isFinite(value)) return value;
  const f = Math.pow(10, precision);
  const scaled = parseFloat((value * f).toPrecision(15));
  return (scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5)) / f;
}
function phpRound2(value: number): number {
  return phpRound(value, 2);
}

// PHP <=> spaceship operator.
function spaceship(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// PHP array-key normalization: canonical decimal-integer STRING keys become INT keys (so
// is_string($key) is false). Used by normalizeMCPHeaders to reject numeric header names.
function isPhpIntKey(k: string): boolean {
  return /^(0|-?[1-9][0-9]*)$/.test(k) && Number.isSafeInteger(Number(k));
}

// Mirror of PHP filter_var($url, FILTER_VALIDATE_URL). PHP requires a scheme (and, for hierarchical
// URLs, a host). Approximated with the WHATWG URL parser (as the sibling MCPServerController does):
// require a parseable URL with a protocol. Faithful for the real-world http(s) MCP URLs under test;
// some exotic filter_var edge cases may differ.
function filterValidateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return !!u.protocol;
  } catch {
    return false;
  }
}

// Mirrors PHP `$row['settings'] ? json_decode($row['settings'], true) : null`. mysql2 auto-parses a
// `json` column into an object/array already — pass that through; decode strings; falsy → null.
function decodeSettingsColumn(val: any): any {
  if (!val && val !== 0) return null; // null/undefined/'' → null
  if (typeof val === 'string') {
    if (val === '' || val === '0') return null;
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  }
  return val;
}

// PHP truthiness for a decoded settings value (json_decode(assoc) turns {} into [] → falsy).
function phpTruthyValue(v: any): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === '' || v === '0') return false;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// PHP strcmp() — binary-safe byte comparison, returns -1/0/1.
function phpStrcmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));
}

// PHP date('Y-m-d') for a Date (server-local time).
function phpDateYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// PHP date('Y-m-d H:i:s') for a Date (server-local time).
function phpDateYmdHis(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// PHP substr($s, $start, $length) — byte-based (PHP strings are byte arrays). Mirror by slicing the
// UTF-8 byte buffer, so the 15000-char truncation in fetchPricingWithClaude cuts at the same byte
// boundary PHP does (may split a multibyte char at the edge, exactly as PHP substr can).
function phpByteSubstr(s: string, start: number, length: number): string {
  return Buffer.from(s, 'utf8').subarray(start, start + length).toString('utf8');
}

// Mirrors PHP strip_tags() with no allowed tags: drops everything between '<' and '>'. An unclosed
// '<' (no following '>') removes the remainder of the string, matching strip_tags' state machine.
function phpStripTags(input: string): string {
  let out = '';
  let inTag = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '<') {
      inTag = true;
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) out += ch;
  }
  return out;
}

// Mirrors `json_decode($col, true) ?? []` on a mysql2-auto-parsed `json` column (arrays/objects
// come back already parsed; NULL → null; a raw string is decoded). foreach-over-values semantics:
// a decoded object yields its values (matches PHP iterating an assoc array).
function decodeJsonArray(v: any): any[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      return decodeJsonArray(JSON.parse(v));
    } catch {
      return [];
    }
  }
  if (typeof v === 'object') return Object.values(v);
  return [];
}

// Mirrors PHP `$col ? json_decode($col, true) : []` used for transaction tool arrays. mysql2 gives
// the parsed value already; treat NULL/empty as [] and pass a parsed array/object through.
function decodeToolArrayCol(v: any): any {
  if (v === null || v === undefined) return [];
  if (typeof v === 'string') {
    if (v === '' || v === '0') return [];
    try {
      return JSON.parse(v);
    } catch {
      return null; // PHP json_decode returns null on invalid JSON (no ?? [] here)
    }
  }
  return v; // already-parsed array/object
}

// PHP `trim($a . ' ' . $b) ?: 'Unknown'` — empty/"0" result falls back to 'Unknown'.
function nameOrUnknown(first: any, last: any): string {
  const name = phpTrim((first ?? '') + ' ' + (last ?? ''));
  return name === '' || name === '0' ? 'Unknown' : name;
}

export class AdminController {
  private static readonly VALID_ROLES = ['guest', 'prospect', 'user', 'admin'];

  /** GET /api/v1/admin/users — list all users. Mirrors listUsers(). */
  async listUsers(_ctx: Ctx): Promise<ControllerResult> {
    const users = (
      await sql<any>`SELECT id, email, first_name, last_name, role, provider, plan, app_key_prefix, app_key_created_at, created_at, updated_at FROM users ORDER BY id`.execute(
        db
      )
    ).rows;

    return {
      success: true,
      users,
      status_code: 200,
    };
  }

  /** GET /api/v1/admin/users/:id — single user by ID. Mirrors getUser(). */
  async getUser(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    const user = (
      await sql<any>`SELECT id, email, first_name, last_name, role, provider, plan, app_key_prefix, app_key_created_at, created_at, updated_at FROM users WHERE id = ${userId}`.execute(
        db
      )
    ).rows[0];

    if (!user) {
      return { success: false, error: 'User not found', status_code: 404 };
    }

    return { success: true, user, status_code: 200 };
  }

  /** GET /api/v1/admin/users/:id/account — account info (plan, role, token usage). Mirrors getUserAccount(). */
  async getUserAccount(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    try {
      const user = (
        await sql<any>`SELECT id, email, phone, first_name, last_name, role, plan,
                           provider, email_verified, firebase_uid, last_login, created_at
                    FROM users WHERE id = ${userId}`.execute(db)
      ).rows[0];

      if (!user) {
        return { success: false, error: 'User not found', status_code: 404 };
      }

      let tokensIn = 0;
      let tokensOut = 0;

      const tableCheck = (await sql<any>`SHOW TABLES LIKE 'llm_usage_transactions'`.execute(db)).rows;
      if (tableCheck.length > 0) {
        const tokenRow = (
          await sql<{ tokens_in: any; tokens_out: any }>`SELECT
                    COALESCE(SUM(prompt_tokens), 0) AS tokens_in,
                    COALESCE(SUM(completion_tokens), 0) AS tokens_out
                FROM llm_usage_transactions
                WHERE user_id = ${userId}`.execute(db)
        ).rows[0];
        tokensIn = phpIntVal(tokenRow?.tokens_in ?? 0);
        tokensOut = phpIntVal(tokenRow?.tokens_out ?? 0);
      }

      const plan = user.plan ?? 'free';
      const role = user.role ?? 'user';
      const totalTokens = tokensIn + tokensOut;
      const freeQuota = 50000;
      const isFreeProspect = plan === 'free' && role === 'prospect';

      return {
        success: true,
        account: {
          id: phpIntVal(user.id),
          email: user.email,
          phone: user.phone,
          first_name: user.first_name,
          last_name: user.last_name,
          plan,
          role,
          provider: user.provider ?? 'email',
          email_verified: phpBoolVal(user.email_verified ?? false),
          has_firebase_uid: !phpEmpty(user.firebase_uid),
          last_login: user.last_login,
          created_at: user.created_at,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          total_tokens: totalTokens,
          free_quota: freeQuota,
          is_free_prospect: isFreeProspect,
          free_quota_percent: isFreeProspect
            ? Math.min(100, phpRound2((totalTokens / freeQuota) * 100))
            : null,
        },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** POST /api/v1/admin/users — create a new user. Mirrors createUser(). */
  async createUser(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const firstName = phpTrim(input.first_name ?? '');
    const lastName = phpTrim(input.last_name ?? '');
    const email = phpTrim(input.email ?? '');
    const password = input.password ?? '';
    let role = input.role ?? 'user';

    if (phpEmpty(email) || phpEmpty(password)) {
      return { success: false, error: 'Email and password are required', status_code: 400 };
    }

    // Validate role
    if (!AdminController.VALID_ROLES.includes(role)) {
      role = 'user';
    }

    // Hash password
    const hashedPassword = bcrypt.hashSync(String(password), 10);

    const res = await sql`INSERT INTO users (email, password, first_name, last_name, role, provider, created_at, updated_at)
                VALUES (${email}, ${hashedPassword}, ${firstName}, ${lastName}, ${role}, 'email', NOW(), NOW())`.execute(
      db
    );

    const newUserId = (res as any).insertId;

    return {
      success: true,
      message: 'User created',
      user_id: phpIntVal(Number(newUserId)),
      status_code: 200,
    };
  }

  /** POST /api/v1/admin/users/update — update a user. Mirrors updateUser(). */
  async updateUser(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const userId = phpIntVal(input.user_id ?? 0);
    const firstName = phpTrim(input.first_name ?? '');
    const lastName = phpTrim(input.last_name ?? '');
    const email = phpTrim(input.email ?? '');
    const password = input.password ?? '';
    const role = input.role ?? null;

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    if (phpEmpty(email)) {
      return { success: false, error: 'Email is required', status_code: 400 };
    }

    // Validate role if provided
    if (role !== null && !AdminController.VALID_ROLES.includes(role)) {
      return { success: false, error: 'Invalid role', status_code: 400 };
    }

    // Build update query — column set mirrors PHP's $fields/$params assembly order.
    const setFragments = [
      sql`email = ${email}`,
      sql`first_name = ${firstName}`,
      sql`last_name = ${lastName}`,
      sql`updated_at = NOW()`,
    ];

    if (role !== null) {
      setFragments.push(sql`role = ${role}`);
    }

    if (!phpEmpty(password)) {
      setFragments.push(sql`password = ${bcrypt.hashSync(String(password), 10)}`);
    }

    await sql`UPDATE users SET ${sql.join(setFragments, sql`, `)} WHERE id = ${userId}`.execute(db);

    return { success: true, message: 'User updated', status_code: 200 };
  }

  /** DELETE /api/v1/admin/users/:id — delete a user. Mirrors deleteUser(). */
  async deleteUser(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    const res = await sql`DELETE FROM users WHERE id = ${userId}`.execute(db);

    if (Number(res.numAffectedRows ?? 0) === 0) {
      return { success: false, error: 'User not found', status_code: 404 };
    }

    return { success: true, message: 'User deleted', status_code: 200 };
  }

  // ============================================
  // PROVIDER SETTINGS (user_category_settings + user_provider_settings)
  // ============================================

  /**
   * GET /api/v1/admin/users/:id/providers — avatar/voice provider settings for a user.
   * Mirrors getProviderSettings(). Skips the runtime DDL (ensure*TableExists) per port policy.
   */
  async getProviderSettings(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    // Category-level settings.
    const categoryRows = (
      await sql<any>`SELECT category, enabled FROM user_category_settings WHERE user_id = ${userId}`.execute(db)
    ).rows;

    const categoryEnabled: Record<string, boolean> = { avatar: true, voice: true };
    for (const row of categoryRows) {
      categoryEnabled[row.category] = phpBoolVal(row.enabled);
    }

    // Provider-level settings. api_key here is plaintext TEXT; `settings` is a `json` column
    // (mysql2 auto-parses) — PHP json_decode's it, so we pass the parsed value through.
    const rows = (
      await sql<any>`SELECT category, provider, api_key, settings, is_active, enabled
                FROM user_provider_settings
                WHERE user_id = ${userId}`.execute(db)
    ).rows;

    const result: Record<string, { active: string | null; enabled: boolean; providers: Record<string, any> }> = {
      avatar: { active: null, enabled: categoryEnabled['avatar'], providers: {} },
      voice: { active: null, enabled: categoryEnabled['voice'], providers: {} },
    };

    for (const row of rows) {
      const category = row.category;
      const provider = row.provider;
      const settings = decodeSettingsColumn(row.settings);
      const enabled = row.enabled !== undefined && row.enabled !== null ? phpBoolVal(row.enabled) : true;

      const bucket = result[category];
      if (bucket) {
        bucket.providers[provider] = {
          has_key: !phpEmpty(row.api_key),
          api_key: row.api_key, // Return actual key for admin
          settings,
          enabled,
        };

        if (row.is_active == 1) {
          bucket.active = provider;
        }
      }
    }

    return {
      success: true,
      user_id: userId,
      avatar: result['avatar'],
      voice: result['voice'],
      status_code: 200,
    };
  }

  /** POST /api/v1/admin/providers — save a provider for a user. Mirrors saveProvider(). */
  async saveProvider(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const userId = phpIntVal(input.user_id ?? 0);
    const category = input.category ?? '';
    const provider = input.provider ?? '';
    const apiKey = input.api_key ?? null;
    let settings = input.settings ?? null;

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    if (!['avatar', 'voice'].includes(category)) {
      return { success: false, error: 'Invalid category', status_code: 400 };
    }

    if (phpEmpty(provider)) {
      return { success: false, error: 'Provider is required', status_code: 400 };
    }

    // Parse settings if string.
    if (typeof settings === 'string') {
      try {
        settings = JSON.parse(settings);
      } catch {
        settings = null;
      }
    }
    const settingsJson = phpTruthyValue(settings) ? JSON.stringify(settings) : null;

    // Check if exists.
    const existing = (
      await sql<any>`SELECT id, api_key FROM user_provider_settings
                     WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db)
    ).rows[0];

    if (existing) {
      // Update - only update api_key if provided.
      if (apiKey !== null) {
        await sql`UPDATE user_provider_settings
                        SET api_key = ${apiKey}, settings = ${settingsJson}, updated_at = NOW()
                        WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db);
      } else {
        await sql`UPDATE user_provider_settings
                        SET settings = ${settingsJson}, updated_at = NOW()
                        WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db);
      }
    } else {
      // Insert.
      await sql`INSERT INTO user_provider_settings
                    (user_id, category, provider, api_key, settings, is_active, created_at, updated_at)
                    VALUES (${userId}, ${category}, ${provider}, ${apiKey}, ${settingsJson}, 0, NOW(), NOW())`.execute(db);
    }

    // Handle set_active flag.
    if (!phpEmpty(input.set_active)) {
      await sql`UPDATE user_provider_settings SET is_active = 0 WHERE user_id = ${userId} AND category = ${category}`.execute(
        db
      );
      await sql`UPDATE user_provider_settings SET is_active = 1 WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(
        db
      );
    }

    return {
      success: true,
      message: `Provider '${provider}' saved`,
      status_code: 200,
    };
  }

  /** POST /api/v1/admin/providers/category-toggle — enable/disable a whole category. Mirrors toggleCategoryEnabled(). */
  async toggleCategoryEnabled(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const userId = phpIntVal(input.user_id ?? 0);
    const category = input.category ?? '';
    const enabled = phpBoolVal(input.enabled ?? true);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    if (!['avatar', 'voice'].includes(category)) {
      return { success: false, error: 'Invalid category', status_code: 400 };
    }

    const enabledValue = enabled ? 1 : 0;
    await sql`INSERT INTO user_category_settings (user_id, category, enabled, updated_at)
                VALUES (${userId}, ${category}, ${enabledValue}, NOW())
                ON DUPLICATE KEY UPDATE enabled = ${enabledValue}, updated_at = NOW()`.execute(db);

    // Also update all individual providers in this category to match. When disabling, also clear
    // is_active (can't be active if disabled).
    let updateRes;
    if (enabled) {
      updateRes = await sql`UPDATE user_provider_settings
                                   SET enabled = ${enabledValue}, updated_at = NOW()
                                   WHERE user_id = ${userId} AND category = ${category}`.execute(db);
    } else {
      updateRes = await sql`UPDATE user_provider_settings
                                   SET enabled = ${enabledValue}, is_active = 0, updated_at = NOW()
                                   WHERE user_id = ${userId} AND category = ${category}`.execute(db);
    }

    const updatedCount = Number(updateRes.numAffectedRows ?? 0);

    return {
      success: true,
      message: `Category '${category}' ${enabled ? 'enabled' : 'disabled'} (${updatedCount} providers updated)`,
      status_code: 200,
    };
  }

  /** POST /api/v1/admin/providers/toggle — enable/disable a single provider. Mirrors toggleProviderEnabled(). */
  async toggleProviderEnabled(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const userId = phpIntVal(input.user_id ?? 0);
    const category = input.category ?? '';
    const provider = input.provider ?? '';
    const enabled = phpBoolVal(input.enabled ?? true);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    if (!['avatar', 'voice'].includes(category)) {
      return { success: false, error: 'Invalid category', status_code: 400 };
    }

    if (phpEmpty(provider)) {
      return { success: false, error: 'Provider is required', status_code: 400 };
    }

    const existing = (
      await sql<any>`SELECT id FROM user_provider_settings
                     WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db)
    ).rows[0];

    if (existing) {
      // Update existing - when disabling, also clear is_active.
      if (enabled) {
        await sql`UPDATE user_provider_settings SET enabled = 1, updated_at = NOW()
                        WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db);
      } else {
        await sql`UPDATE user_provider_settings SET enabled = 0, is_active = 0, updated_at = NOW()
                        WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(db);
      }
    } else {
      // Insert new record with just enabled state.
      await sql`INSERT INTO user_provider_settings
                    (user_id, category, provider, enabled, is_active, created_at, updated_at)
                    VALUES (${userId}, ${category}, ${provider}, ${enabled ? 1 : 0}, 0, NOW(), NOW())`.execute(db);
    }

    return {
      success: true,
      message: `Provider '${provider}' ${enabled ? 'enabled' : 'disabled'}`,
      status_code: 200,
    };
  }

  /** DELETE /api/v1/admin/providers — delete a provider for a user. Mirrors deleteProvider(). */
  async deleteProvider(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const userId = phpIntVal(input.user_id ?? 0);
    const category = input.category ?? '';
    const provider = input.provider ?? '';

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    if (!['avatar', 'voice'].includes(category)) {
      return { success: false, error: 'Invalid category', status_code: 400 };
    }

    if (phpEmpty(provider)) {
      return { success: false, error: 'Provider is required', status_code: 400 };
    }

    const res = await sql`DELETE FROM user_provider_settings WHERE user_id = ${userId} AND category = ${category} AND provider = ${provider}`.execute(
      db
    );

    return {
      success: true,
      message: `Provider '${provider}' deleted`,
      deleted: Number(res.numAffectedRows ?? 0) > 0,
      status_code: 200,
    };
  }

  // ============================================
  // API KEYS (user_api_keys — PLAINTEXT here, unlike SettingsController)
  // ============================================

  /**
   * GET /api/v1/admin/users/:id/keys — LLM API keys for a user, seeded for all valid providers and
   * overlaid with the user's package-granted keys. Mirrors getApiKeys(). Keys are returned PLAINTEXT
   * (no decrypt — this table stores them raw); masked_key = '****' + last 4.
   */
  async getApiKeys(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    const rows = (
      await sql<any>`SELECT provider, api_key, model, base_url, max_tokens, temperature,
                       chat_endpoint, streaming, supports_tools, system_prompt, enabled, updated_at
                FROM user_api_keys WHERE user_id = ${userId}`.execute(db)
    ).rows;

    const emptyState = {
      api_key: null as any,
      masked_key: null as any,
      model: null as any,
      base_url: null as any,
      max_tokens: null as any,
      temperature: null as any,
      chat_endpoint: null as any,
      streaming: null as any,
      supports_tools: null as any,
      system_prompt: null as any,
      enabled: true,
      updated_at: null as any,
    };

    const keys: Record<string, any> = {};
    for (const row of rows) {
      const apiKey = row.api_key ?? '';
      keys[row.provider] = {
        api_key: apiKey, // Return actual key for admin
        masked_key: apiKey !== '' ? '****' + String(apiKey).slice(-4) : null,
        model: row.model,
        base_url: row.base_url,
        max_tokens: row.max_tokens !== null ? phpIntVal(row.max_tokens) : null,
        temperature: row.temperature !== null ? Number(row.temperature) : null,
        chat_endpoint: row.chat_endpoint,
        streaming: row.streaming !== null ? phpBoolVal(row.streaming) : null,
        supports_tools: row.supports_tools !== null ? phpBoolVal(row.supports_tools) : null,
        system_prompt: row.system_prompt,
        enabled: phpBoolVal(row.enabled ?? 1),
        updated_at: row.updated_at,
      };
    }

    // Include all valid providers with empty state if not set.
    const validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi', 'gamma4'];
    for (const provider of validProviders) {
      if (keys[provider] === undefined) {
        keys[provider] = { ...emptyState };
      }
    }

    // Overlay the keys this user inherits from their package (role). A personal key wins over the
    // package key; package-sourced entries are tagged source:'package' with the package name.
    try {
      const resolver = new PackageResolver();
      const packageName = await resolver.resolveRole(userId);
      const pkg = await resolver.resolveForUser(userId);
      let pkgProviders: any = pkg.capabilities?.providers ?? {};
      if (pkgProviders === null || typeof pkgProviders !== 'object') {
        pkgProviders = {};
      }
      for (const provider of validProviders) {
        const userKey = keys[provider].api_key ?? null;
        if (userKey !== null && userKey !== '') {
          // Personal key set on the user — that wins over the package.
          keys[provider].source = 'user';
          keys[provider].available = true;
          keys[provider].package_name = null;
          continue;
        }
        const rawPkg = pkgProviders[provider];
        const pkgEntry = rawPkg !== null && typeof rawPkg === 'object' ? rawPkg : {};
        const pkgEnabled = !phpEmpty(pkgEntry.enabled);
        const pkgKey =
          pkgEnabled && pkgEntry.default_api_key !== undefined && pkgEntry.default_api_key !== null
            ? phpTrim(String(pkgEntry.default_api_key))
            : '';
        const pkgModel =
          pkgEnabled && pkgEntry.default_model !== undefined && pkgEntry.default_model !== null
            ? phpTrim(String(pkgEntry.default_model))
            : '';
        if (pkgKey !== '') {
          keys[provider].api_key = pkgKey; // actual key for admin (display + reveal + edit)
          keys[provider].masked_key = '****' + pkgKey.slice(-4);
          if ((keys[provider].model ?? null) === null && pkgModel !== '') {
            keys[provider].model = pkgModel;
          }
          keys[provider].source = 'package';
          keys[provider].available = true;
          keys[provider].package_name = packageName;
        } else {
          keys[provider].source = 'none';
          keys[provider].available = false;
          keys[provider].package_name = null;
        }
      }
    } catch (e: any) {
      console.error('[AdminController] package key overlay failed: ' + (e?.message ?? ''));
    }

    return {
      success: true,
      user_id: userId,
      keys,
      status_code: 200,
    };
  }

  /**
   * POST /api/v1/admin/keys — save LLM API keys for a user. Mirrors saveApiKeys(). Stores api_key
   * RAW (no encryption). Preserve-on-blank: api_key is written only for a non-empty trimmed value;
   * a brand-new row can't be inserted without an api_key (NOT NULL column) so we SELECT 1 and skip.
   */
  async saveApiKeys(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const userId = phpIntVal(input.user_id ?? 0);
    const keys = input.keys ?? [];

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    // PHP `empty($keys)`: the JSON body is decoded assoc, so both `[]` and `{}` arrive as an empty
    // PHP array → empty. Mirror that (a non-empty object is not empty).
    const keysEmpty =
      phpEmpty(keys) ||
      (typeof keys === 'object' && keys !== null && !Array.isArray(keys) && Object.keys(keys).length === 0);
    if (keysEmpty) {
      return { success: false, error: 'No keys provided', status_code: 400 };
    }

    const validProviders = ['claude', 'openai', 'gemini', 'grok', 'deepseek', 'kimi', 'gamma4'];
    let savedCount = 0;

    // Columns that can be updated individually (without requiring an api_key).
    // Map: input field => [db column, caster]
    const settingFields: Array<[string, string, (v: any) => any]> = [
      ['model', 'model', (v) => (v === '' ? null : String(v))],
      ['base_url', 'base_url', (v) => (v === '' ? null : String(v))],
      ['max_tokens', 'max_tokens', (v) => (v === '' || v === null ? null : phpIntVal(v))],
      ['temperature', 'temperature', (v) => (v === '' || v === null ? null : Number(v))],
      ['chat_endpoint', 'chat_endpoint', (v) => (v === '' ? null : String(v))],
      ['streaming', 'streaming', (v) => (v === null ? null : v ? 1 : 0)],
      ['supports_tools', 'supports_tools', (v) => (v === null ? null : v ? 1 : 0)],
      ['system_prompt', 'system_prompt', (v) => (v === '' ? null : String(v))],
      ['enabled', 'enabled', (v) => (v ? 1 : 0)],
    ];

    // Iterate as an associative map (mirrors PHP `foreach ($keys as $provider => $entry)`).
    const entries: Array<[string, any]> = Array.isArray(keys)
      ? keys.map((v: any, i: number) => [String(i), v] as [string, any])
      : Object.entries(keys as Record<string, any>);

    for (let [provider, entry] of entries) {
      if (!validProviders.includes(provider)) {
        continue;
      }

      // Back-compat: allow plain string (api_key only).
      if (typeof entry === 'string') {
        entry = { api_key: entry };
      }
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }

      const hasApiKey =
        Object.prototype.hasOwnProperty.call(entry, 'api_key') && phpTrim(String(entry.api_key)) !== '';
      const apiKey = hasApiKey ? phpTrim(String(entry.api_key)) : null;

      // Build dynamic column list.
      const cols: string[] = ['user_id', 'provider'];
      const values: any[] = [userId, provider];
      const updates: string[] = [];

      if (hasApiKey) {
        cols.push('api_key');
        values.push(apiKey);
        updates.push('api_key = VALUES(api_key)');
      }

      for (const [inputKey, col, cast] of settingFields) {
        if (!Object.prototype.hasOwnProperty.call(entry, inputKey)) {
          continue;
        }
        cols.push(col);
        values.push(cast(entry[inputKey]));
        updates.push(`${col} = VALUES(${col})`);
      }

      // If only provider/user_id (no api_key, no settings), skip.
      if (cols.length <= 2) {
        continue;
      }

      // If inserting a brand-new row without an api_key, we can't (api_key is NOT NULL).
      // Check existence and skip insert in that case.
      if (!hasApiKey) {
        const check = (
          await sql<any>`SELECT 1 AS one FROM user_api_keys WHERE user_id = ${userId} AND provider = ${provider}`.execute(
            db
          )
        ).rows[0];
        if (!check) {
          continue; // can't create row without an api_key
        }
      }

      const valueFragments = values.map((v) => sql`${v}`);
      valueFragments.push(sql`NOW()`);
      valueFragments.push(sql`NOW()`);
      const allCols = [...cols, 'created_at', 'updated_at'];
      updates.push('updated_at = NOW()');

      const colIdent = allCols.map((c) => sql.ref(c));

      await sql`INSERT INTO user_api_keys (${sql.join(colIdent, sql`, `)})
                    VALUES (${sql.join(valueFragments, sql`, `)})
                    ON DUPLICATE KEY UPDATE ${sql.raw(updates.join(', '))}`.execute(db);
      savedCount++;
    }

    return {
      success: true,
      message: `Saved ${savedCount} API key(s)`,
      status_code: 200,
    };
  }

  /** POST /api/v1/admin/keys/delete — delete one LLM API key for a user. Mirrors deleteApiKey(). */
  async deleteApiKey(ctx: Ctx): Promise<ControllerResult> {
    const input = ctx.body ?? {};

    const userId = phpIntVal(input.user_id ?? 0);
    const provider = input.provider ?? '';

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    if (phpEmpty(provider)) {
      return { success: false, error: 'Provider is required', status_code: 400 };
    }

    const res = await sql`DELETE FROM user_api_keys WHERE user_id = ${userId} AND provider = ${provider}`.execute(
      db
    );

    return {
      success: true,
      message: `API key for '${provider}' deleted`,
      deleted: Number(res.numAffectedRows ?? 0) > 0,
      status_code: 200,
    };
  }

  // ============================================
  // MCP OVERRIDES (user_mcp_overrides)
  // ============================================

  /**
   * GET /api/v1/admin/users/:id/mcp-servers — every MCP server visible to the user (globals +
   * their private ones) with package default, per-user override, and effective state. Mirrors
   * getUserMCPServers().
   */
  async getUserMCPServers(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);

    try {
      // 1. Resolve the user's package allowlist.
      const resolver = new PackageResolver();
      const packageAllowlist = await resolver.allowedMcpServers(userId); // null = allow all

      // 2. Pull every server visible to this user: globals + their private ones.
      const rows = (
        await sql<any>`
                SELECT s.id, s.name, s.url, s.description, s.user_id, s.enabled,
                       COUNT(t.id) AS tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON t.server_id = s.id
                WHERE s.user_id IS NULL OR s.user_id = ${userId}
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC
            `.execute(db)
      ).rows;

      // 3. Pull the user's overrides.
      const overrideRows = (
        await sql<any>`SELECT server_id, allowed FROM user_mcp_overrides WHERE user_id = ${userId}`.execute(db)
      ).rows;
      const overrides: Record<number, boolean> = {};
      for (const row of overrideRows) {
        overrides[phpIntVal(row.server_id)] = phpBoolVal(row.allowed);
      }

      // 4. Merge into the effective view.
      const servers = rows.map((row: any) => {
        const serverId = phpIntVal(row.id);
        const isGlobal = row.user_id === null;
        const isPrivate = !isGlobal;

        // Package default: user-private servers always pass; globals pass when the package
        // allowlist is null OR contains the server name.
        const packageDefault =
          isPrivate || packageAllowlist === null || packageAllowlist.includes(row.name);

        const override = Object.prototype.hasOwnProperty.call(overrides, serverId)
          ? overrides[serverId]
          : null;
        const effective = override !== null ? override : packageDefault;

        return {
          id: serverId,
          name: row.name,
          url: row.url,
          description: row.description,
          is_global: isGlobal,
          is_user_private: isPrivate,
          enabled: phpBoolVal(row.enabled),
          tool_count: phpIntVal(row.tool_count),
          package_default: packageDefault,
          override,
          effective: phpBoolVal(effective),
        };
      });

      return {
        success: true,
        user_id: userId,
        package_allowlist: packageAllowlist, // null = unrestricted
        servers,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * PUT /api/v1/admin/users/:id/mcp-servers/:serverId/override — set/update the per-user override
   * for one MCP server. Mirrors setUserMCPOverride().
   */
  async setUserMCPOverride(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);
    const serverId = phpIntVal(ctx.params?.serverId ?? 0);

    try {
      const body = ctx.body ?? {};
      if (!Object.prototype.hasOwnProperty.call(body, 'allowed')) {
        return { success: false, error: 'Field "allowed" is required (boolean).', status_code: 400 };
      }
      const allowed = phpBoolVal(body.allowed);

      // Sanity-check both FKs exist before writing.
      const userRow = (await sql<any>`SELECT 1 AS one FROM users WHERE id = ${userId}`.execute(db)).rows[0];
      if (!userRow) {
        return { success: false, error: 'User not found', status_code: 404 };
      }
      const serverRow = (await sql<any>`SELECT 1 AS one FROM mcp_servers WHERE id = ${serverId}`.execute(db)).rows[0];
      if (!serverRow) {
        return { success: false, error: 'MCP server not found', status_code: 404 };
      }

      // Upsert. The unique key (user_id, server_id) makes this safe.
      await sql`
                INSERT INTO user_mcp_overrides (user_id, server_id, allowed)
                VALUES (${userId}, ${serverId}, ${allowed ? 1 : 0})
                ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), updated_at = CURRENT_TIMESTAMP
            `.execute(db);

      return {
        success: true,
        user_id: userId,
        server_id: serverId,
        allowed,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * DELETE /api/v1/admin/users/:id/mcp-servers/:serverId/override — remove the per-user override,
   * reverting to the package default. Mirrors clearUserMCPOverride().
   */
  async clearUserMCPOverride(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);
    const serverId = phpIntVal(ctx.params?.serverId ?? 0);

    try {
      const res = await sql`DELETE FROM user_mcp_overrides WHERE user_id = ${userId} AND server_id = ${serverId}`.execute(
        db
      );
      return {
        success: true,
        user_id: userId,
        server_id: serverId,
        cleared: Number(res.numAffectedRows ?? 0) > 0,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  // ============================================
  // ADMIN MCP SERVER MANAGEMENT
  // ============================================

  /**
   * ensureMCPSchema() in PHP performs idempotent ALTER TABLE DDL (drop legacy unique index, add
   * composite unique + headers JSON column), wrapped in a try/catch that only error_log()s on
   * failure — it has NO observable effect on the response. Per task constraints we SKIP runtime DDL,
   * so this is a no-op kept to preserve call-site structure/order. Mirrors ensureMCPSchema().
   */
  private async ensureMCPSchema(): Promise<void> {
    /* no-op — DDL skipped (user runs migrations); PHP swallows all errors here anyway */
  }

  /**
   * Normalize + validate headers input (object or JSON string) into a "Header: value" string array.
   * Returns [list, jsonToStore] or throws. Empty/null -> [[], null]. Mirrors normalizeMCPHeaders().
   */
  private normalizeMCPHeaders(raw: any): [string[], string | null] {
    if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
      return [[], null];
    }
    if (typeof raw === 'string') {
      let decoded: any;
      try {
        decoded = JSON.parse(raw);
      } catch {
        decoded = undefined;
      }
      // PHP is_array() is true for both JSON objects and JSON arrays (assoc decode).
      if (decoded === null || decoded === undefined || typeof decoded !== 'object') {
        throw new Error('Headers must be a JSON object, e.g. {"Authorization":"Bearer ..."}');
      }
      raw = decoded;
    }
    if (raw === null || typeof raw !== 'object') {
      throw new Error('Headers must be a JSON object');
    }
    const isArr = Array.isArray(raw);
    const list: string[] = [];
    for (const [name, value] of Object.entries(raw)) {
      // PHP: json_decode(assoc) turns canonical-decimal-integer string keys into int keys, and array
      // elements always have int keys -> is_string($name) === false -> "Invalid header name".
      const nameIsString = !isArr && !isPhpIntKey(name);
      if (!nameIsString || name === '' || /[\r\n:]/.test(name)) {
        throw new Error('Invalid header name: ' + name);
      }
      const isScalar = value !== null && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
      if (!isScalar) {
        throw new Error(`Header '${name}' value must be a string`);
      }
      const strValue = typeof value === 'boolean' ? (value ? '1' : '') : String(value);
      if (/[\r\n]/.test(strValue)) {
        throw new Error(`Header '${name}' contains invalid characters`);
      }
      list.push(name + ': ' + strValue);
    }
    return [list, JSON.stringify(raw)];
  }

  /**
   * GET /api/v1/admin/mcp/servers — list all MCP servers (globals + optionally user-scoped) with a
   * per-server tool_count and a resolved user_email. Mirrors listMCPServers().
   */
  async listMCPServers(ctx: Ctx): Promise<ControllerResult> {
    try {
      await this.ensureMCPSchema();

      const query = (ctx.query as any) ?? {};
      const scope = query.scope ?? 'all'; // all | global | user
      const filterUserId = query.user_id !== undefined && query.user_id !== '' ? String(query.user_id) : null;

      // headers CAST AS CHAR so we get MySQL's raw JSON string (mysql2 would auto-parse the JSON
      // column to an object), mirroring PHP's json_decode($s['headers'], true).
      let rowsQuery;
      if (scope === 'global') {
        rowsQuery = sql<any>`
                SELECT s.id, s.user_id, s.name, s.url, s.description, CAST(s.headers AS CHAR) AS headers,
                       s.enabled, s.created_at, s.updated_at, COUNT(t.id) as tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON s.id = t.server_id
                WHERE s.user_id IS NULL
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC
            `;
      } else if (scope === 'user' && filterUserId !== null) {
        rowsQuery = sql<any>`
                SELECT s.id, s.user_id, s.name, s.url, s.description, CAST(s.headers AS CHAR) AS headers,
                       s.enabled, s.created_at, s.updated_at, COUNT(t.id) as tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON s.id = t.server_id
                WHERE s.user_id = ${filterUserId}
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC
            `;
      } else if (filterUserId !== null) {
        rowsQuery = sql<any>`
                SELECT s.id, s.user_id, s.name, s.url, s.description, CAST(s.headers AS CHAR) AS headers,
                       s.enabled, s.created_at, s.updated_at, COUNT(t.id) as tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON s.id = t.server_id
                WHERE s.user_id = ${filterUserId}
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC
            `;
      } else {
        rowsQuery = sql<any>`
                SELECT s.id, s.user_id, s.name, s.url, s.description, CAST(s.headers AS CHAR) AS headers,
                       s.enabled, s.created_at, s.updated_at, COUNT(t.id) as tool_count
                FROM mcp_servers s
                LEFT JOIN mcp_server_tools t ON s.id = t.server_id
                GROUP BY s.id
                ORDER BY (s.user_id IS NULL) DESC, s.name ASC
            `;
      }
      const servers = (await rowsQuery.execute(db)).rows;

      // Build a map of user_id -> email for friendly display.
      const userIds = [...new Set(servers.map((s: any) => s.user_id).filter((v: any) => !phpEmpty(v)))];
      const userEmails: Record<string, any> = {};
      if (userIds.length > 0) {
        const uRows = (
          await sql<any>`SELECT id, email FROM users WHERE id IN (${sql.join(userIds)})`.execute(db)
        ).rows;
        for (const u of uRows) {
          userEmails[String(u.id)] = u.email;
        }
      }

      return {
        success: true,
        servers: servers.map((s: any) => {
          let headers: any = null;
          if (!phpEmpty(s.headers)) {
            let decoded: any;
            try {
              decoded = JSON.parse(s.headers);
            } catch {
              decoded = undefined;
            }
            // PHP is_array() — true for JSON objects and arrays.
            if (decoded !== null && decoded !== undefined && typeof decoded === 'object') headers = decoded;
          }
          return {
            id: phpIntVal(s.id),
            is_global: s.user_id === null,
            user_id: s.user_id,
            user_email: s.user_id !== null ? userEmails[String(s.user_id)] ?? null : null,
            name: s.name,
            url: s.url,
            description: s.description,
            headers,
            enabled: phpBoolVal(s.enabled),
            tool_count: phpIntVal(s.tool_count),
            created_at: s.created_at,
            updated_at: s.updated_at,
          };
        }),
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/admin/mcp/servers — create a new MCP server (global, or per-user if user_id given),
   * then best-effort fetches its tools. Mirrors createMCPServer().
   */
  async createMCPServer(ctx: Ctx): Promise<ControllerResult> {
    try {
      await this.ensureMCPSchema();

      const input = ctx.body ?? {};

      const name = phpTrim(input.name ?? '');
      const url = phpTrim(input.url ?? '');
      const description = phpTrim(input.description ?? '');
      // Optional scoping: if user_id is provided & non-empty, create a per-user server.
      const rawUserId = input.user_id ?? null;
      const userId =
        rawUserId === null || rawUserId === '' || rawUserId === 0 || rawUserId === '0' ? null : String(rawUserId);

      if (!name || !url) {
        return { success: false, error: 'Name and URL are required', status_code: 400 };
      }

      if (!filterValidateUrl(url)) {
        return { success: false, error: 'Invalid URL format', status_code: 400 };
      }

      // Check for duplicate within the same scope (global OR specific user).
      let dup: any;
      if (userId === null) {
        dup = (await sql<any>`SELECT id FROM mcp_servers WHERE user_id IS NULL AND name = ${name}`.execute(db)).rows[0];
      } else {
        dup = (await sql<any>`SELECT id FROM mcp_servers WHERE user_id = ${userId} AND name = ${name}`.execute(db))
          .rows[0];
      }
      if (dup) {
        return {
          success: false,
          error:
            userId === null
              ? 'A global server with this name already exists'
              : 'This user already has a server with this name',
          status_code: 409,
        };
      }

      // Normalize headers.
      let headerList: string[];
      let headersJson: string | null;
      try {
        [headerList, headersJson] = this.normalizeMCPHeaders(input.headers ?? null);
      } catch (e: any) {
        return { success: false, error: e?.message ?? '', status_code: 400 };
      }

      const res = await sql`
                INSERT INTO mcp_servers (user_id, name, url, description, headers, enabled)
                VALUES (${userId}, ${name}, ${url}, ${description}, ${headersJson}, 1)
            `.execute(db);

      const serverId = Number((res as any).insertId);

      // Try to fetch tools from the server.
      const toolsResult = await this.fetchMCPServerTools(serverId, url, headerList);

      return {
        success: true,
        server_id: serverId,
        tools_fetched: toolsResult.count ?? 0,
        tools_error: toolsResult.error ?? null,
        message: 'MCP server created successfully',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/admin/mcp/servers/update — update an MCP server; re-fetches tools if url/headers
   * changed. Mirrors updateMCPServer().
   */
  async updateMCPServer(ctx: Ctx): Promise<ControllerResult> {
    try {
      const input = ctx.body ?? {};

      const serverId = phpIntVal(input.server_id ?? 0);
      const name = phpTrim(input.name ?? '');
      const url = phpTrim(input.url ?? '');
      const description = phpTrim(input.description ?? '');

      if (!serverId) {
        return { success: false, error: 'Server ID is required', status_code: 400 };
      }

      if (!name || !url) {
        return { success: false, error: 'Name and URL are required', status_code: 400 };
      }

      await this.ensureMCPSchema();

      // Normalize headers.
      let headerList: string[];
      let headersJson: string | null;
      try {
        [headerList, headersJson] = this.normalizeMCPHeaders(input.headers ?? null);
      } catch (e: any) {
        return { success: false, error: e?.message ?? '', status_code: 400 };
      }

      // Check if URL or headers changed. CAST headers AS CHAR to compare against the freshly-encoded
      // JSON string exactly as PHP's PDO returns the raw canonical JSON string (mysql2 auto-parses).
      const existing = (
        await sql<any>`SELECT url, CAST(headers AS CHAR) AS headers FROM mcp_servers WHERE id = ${serverId}`.execute(db)
      ).rows[0];

      if (!existing) {
        return { success: false, error: 'Server not found', status_code: 404 };
      }

      const urlChanged = existing.url !== url;
      const headersChanged = (existing.headers ?? null) !== headersJson;

      await sql`
                UPDATE mcp_servers SET name = ${name}, url = ${url}, description = ${description}, headers = ${headersJson}, updated_at = NOW()
                WHERE id = ${serverId}
            `.execute(db);

      // If URL or headers changed, clear and re-fetch tools.
      let toolsFetched = 0;
      let toolsError: string | null = null;
      if (urlChanged || headersChanged) {
        await sql`DELETE FROM mcp_server_tools WHERE server_id = ${serverId}`.execute(db);
        const toolsResult = await this.fetchMCPServerTools(serverId, url, headerList);
        toolsFetched = toolsResult.count ?? 0;
        toolsError = toolsResult.error ?? null;
      }

      return {
        success: true,
        tools_fetched: toolsFetched,
        tools_error: toolsError,
        message: 'MCP server updated successfully',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/admin/mcp/servers/toggle — enable/disable an MCP server. Mirrors toggleMCPServer().
   */
  async toggleMCPServer(ctx: Ctx): Promise<ControllerResult> {
    try {
      const input = ctx.body ?? {};

      const serverId = phpIntVal(input.server_id ?? 0);
      const enabled = phpBoolVal(input.enabled ?? true);

      if (!serverId) {
        return { success: false, error: 'Server ID is required', status_code: 400 };
      }

      const res = await sql`
                UPDATE mcp_servers SET enabled = ${enabled ? 1 : 0}, updated_at = NOW() WHERE id = ${serverId}
            `.execute(db);

      if (Number(res.numAffectedRows ?? 0) === 0) {
        return { success: false, error: 'Server not found', status_code: 404 };
      }

      return {
        success: true,
        message: enabled ? 'Server enabled' : 'Server disabled',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * DELETE /api/v1/admin/mcp/servers/:id — delete an MCP server (tools cascade). Mirrors
   * deleteMCPServer().
   */
  async deleteMCPServer(ctx: Ctx): Promise<ControllerResult> {
    const serverId = phpIntVal(ctx.params?.id ?? 0);
    try {
      if (!serverId) {
        return { success: false, error: 'Server ID is required', status_code: 400 };
      }

      // Get server info before deleting.
      const server = (await sql<any>`SELECT name FROM mcp_servers WHERE id = ${serverId}`.execute(db)).rows[0];

      if (!server) {
        return { success: false, error: 'Server not found', status_code: 404 };
      }

      // Delete server (tools will be deleted via cascade).
      await sql`DELETE FROM mcp_servers WHERE id = ${serverId}`.execute(db);

      return {
        success: true,
        message: `Server '${server.name}' deleted successfully`,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/admin/mcp/servers/refresh — clear and re-fetch tools for an MCP server. Mirrors
   * refreshMCPServerTools().
   */
  async refreshMCPServerTools(ctx: Ctx): Promise<ControllerResult> {
    try {
      const input = ctx.body ?? {};
      const serverId = phpIntVal(input.server_id ?? 0);

      if (!serverId) {
        return { success: false, error: 'Server ID is required', status_code: 400 };
      }

      // Get server URL + headers (CAST AS CHAR: normalizeMCPHeaders expects a JSON string, mysql2
      // would otherwise hand back a parsed object).
      const server = (
        await sql<any>`SELECT url, CAST(headers AS CHAR) AS headers FROM mcp_servers WHERE id = ${serverId}`.execute(db)
      ).rows[0];

      if (!server) {
        return { success: false, error: 'Server not found', status_code: 404 };
      }

      const [headerList] = this.normalizeMCPHeaders(server.headers ?? null);

      // Clear existing tools.
      await sql`DELETE FROM mcp_server_tools WHERE server_id = ${serverId}`.execute(db);

      // Fetch new tools.
      const result = await this.fetchMCPServerTools(serverId, server.url, headerList);

      return {
        success: true,
        tools_fetched: result.count ?? 0,
        tools_error: result.error ?? null,
        tools: result.tools ?? [],
        message: 'Tools refreshed successfully',
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * Fetch tools from an MCP server and store them. Performs the full MCP handshake:
   * initialize -> notifications/initialized -> tools/list, preserves the Mcp-Session-Id across
   * requests, and parses both JSON and SSE responses. Mirrors fetchMCPServerTools().
   */
  private async fetchMCPServerTools(
    serverId: number,
    serverUrl: string,
    extraHeaders: string[] = []
  ): Promise<{ count: number; error?: string; tools?: string[] }> {
    try {
      const mcpUrl = serverUrl.replace(/\/+$/, ''); // rtrim($serverUrl, '/')

      const session: { id: string | null } = { id: null };

      // Step 1: initialize
      const initResult = await this.mcpHttpCall(
        mcpUrl,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            clientInfo: { name: 'GPT-Admin-MCP-Client', version: '1.0.0' },
            capabilities: {},
          },
        },
        extraHeaders,
        session
      );
      if (!initResult.ok) {
        return { count: 0, error: 'initialize failed: ' + initResult.error };
      }
      if (initResult.data && initResult.data.error) {
        const msg = initResult.data.error.message ?? 'server error';
        return { count: 0, error: 'initialize error: ' + msg };
      }

      // Step 2: notifications/initialized (no response body expected)
      await this.mcpHttpCall(
        mcpUrl,
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        extraHeaders,
        session,
        false
      );

      // Step 3: tools/list
      const listResult = await this.mcpHttpCall(
        mcpUrl,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        extraHeaders,
        session
      );
      if (!listResult.ok) {
        return { count: 0, error: 'tools/list failed: ' + listResult.error };
      }
      if (listResult.data && listResult.data.error) {
        const msg = listResult.data.error.message ?? 'server error';
        return { count: 0, error: 'tools/list error: ' + msg };
      }

      // listResult.data is already a decoded object (PHP re-decodes as object to preserve {}).
      const tools = listResult.data?.result?.tools ?? [];

      if (!tools || tools.length === 0) {
        return { count: 0, tools: [] };
      }

      const toolNames: string[] = [];
      for (const tool of tools) {
        const name = tool?.name ?? '';
        if (!name) continue;

        const description = tool.description ?? '';
        // Encode inputSchema preserving {} as objects. PHP isset() is false for null too.
        const inputSchema =
          tool.inputSchema !== undefined && tool.inputSchema !== null
            ? JSON.stringify(tool.inputSchema)
            : '{"type":"object","properties":{}}';

        // Check for UI info in both _meta.ui (MCP Apps) and annotations (legacy). PHP !empty().
        const hasUi = !phpEmpty(tool._meta?.ui) || !phpEmpty(tool.annotations?.hasUI) ? 1 : 0;
        const uiResourceUri = tool._meta?.ui?.resourceUri ?? tool.annotations?.uiResourceUri ?? null;

        try {
          await sql`
                        INSERT INTO mcp_server_tools (server_id, tool_name, tool_description, input_schema, has_ui, ui_resource_uri)
                        VALUES (${serverId}, ${name}, ${description}, ${inputSchema}, ${hasUi}, ${uiResourceUri})
                        ON DUPLICATE KEY UPDATE tool_description = VALUES(tool_description), input_schema = VALUES(input_schema), has_ui = VALUES(has_ui), ui_resource_uri = VALUES(ui_resource_uri)
                    `.execute(db);
        } catch (e: any) {
          // PHP logs the PDOException and continues (the name is still counted below).
          console.error(`[Admin] INSERT FAILED for ${name}: ` + (e?.message ?? e));
        }

        toolNames.push(name);
      }

      return { count: toolNames.length, tools: toolNames };
    } catch (e: any) {
      console.error('Failed to fetch MCP tools: ' + (e?.message ?? e));
      return { count: 0, error: e?.message ?? '' };
    }
  }

  /**
   * Low-level MCP HTTP call with SSE support + session id propagation. session.id is updated from any
   * Mcp-Session-Id response header. Returns { ok, error, data }. Mirrors mcpHttpCall().
   */
  private async mcpHttpCall(
    url: string,
    request: any,
    extraHeaders: string[],
    session: { id: string | null },
    expectResponse = true
  ): Promise<{ ok: boolean; error: string | null; data: any }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream, */*',
    };
    // extraHeaders are "Name: value" strings (the curl CURLOPT_HTTPHEADER form).
    for (const h of extraHeaders) {
      const idx = h.indexOf(':');
      if (idx > 0) {
        const n = h.slice(0, idx).trim();
        const v = h.slice(idx + 1).trim();
        if (n) headers[n] = v;
      }
    }
    if (session.id) {
      headers['Mcp-Session-Id'] = session.id;
    }

    // curl CURLOPT_TIMEOUT => 30 (CONNECTTIMEOUT 10 has no direct fetch equivalent; use total 30s).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
        redirect: 'follow', // CURLOPT_FOLLOWLOCATION
      });
    } catch (e: any) {
      clearTimeout(timer);
      return { ok: false, error: e?.message ?? String(e), data: null };
    }
    clearTimeout(timer);

    // Capture Mcp-Session-Id (case-insensitive; fetch header get is case-insensitive).
    const sid = res.headers.get('mcp-session-id');
    if (sid) session.id = sid.trim();

    const httpCode = res.status;
    const body = await res.text().catch(() => '');

    if (httpCode >= 400) {
      const snippet = body.slice(0, 200);
      return { ok: false, error: `HTTP ${httpCode}: ${snippet}`, data: null };
    }

    if (!expectResponse) {
      return { ok: true, error: null, data: null };
    }

    // Try plain JSON first (PHP is_array() -> objects and arrays only, not scalars/null).
    let decoded: any;
    try {
      decoded = JSON.parse(body);
    } catch {
      decoded = undefined;
    }
    if (decoded !== null && decoded !== undefined && typeof decoded === 'object') {
      return { ok: true, error: null, data: decoded };
    }

    // Parse SSE: find the LAST "data:" JSON payload.
    let sseData: any = null;
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (d !== '') {
          let parsed: any;
          try {
            parsed = JSON.parse(d);
          } catch {
            parsed = undefined;
          }
          if (parsed !== null && parsed !== undefined && typeof parsed === 'object') {
            sseData = parsed;
          }
        }
      }
    }
    if (sseData !== null) {
      return { ok: true, error: null, data: sseData };
    }

    return { ok: false, error: 'Unparseable response: ' + body.slice(0, 200), data: null };
  }

  // ============================================
  // COSTS (per-user usage costs breakdown)
  // ============================================

  /** GET /api/v1/admin/users/:id/costs — per-user usage costs breakdown (last 30 days). Mirrors getUserCosts(). */
  async getUserCosts(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);

    if (userId <= 0) {
      return { success: false, error: 'Invalid user ID', status_code: 400 };
    }

    try {
      const usageCosts = await this.getUsageCostsBreakdown(userId);
      return {
        success: true,
        user_id: userId,
        usageCosts,
        status_code: 200,
      };
    } catch (e: any) {
      return {
        success: false,
        error: 'Failed to fetch user costs: ' + (e?.message ?? ''),
        status_code: 500,
      };
    }
  }

  /**
   * Usage costs breakdown by category (LLM, Voice, Avatar), scoped to a user. Mirrors the
   * private getUsageCostsBreakdown($userId). Costs re-computed from tokens × current price
   * (system_llm_settings, then hardcoded fallbacks).
   */
  private async getUsageCostsBreakdown(userId: number | null = null): Promise<any> {
    // Conditional per-user scoping (mirrors PHP's $userClause / $userClauseNoAlias / $totalsWhere).
    const userClause = userId !== null ? sql` AND t.user_id = ${userId}` : sql``;
    const userClauseNoAlias = userId !== null ? sql` AND user_id = ${userId}` : sql``;
    const totalsWhere = userId !== null ? sql` WHERE user_id = ${userId}` : sql``;

    const llmCostsRaw = (
      await sql<any>`SELECT
            t.provider,
            COUNT(*) AS total_requests,
            COALESCE(SUM(t.prompt_tokens), 0) AS tokens_in,
            COALESCE(SUM(t.completion_tokens), 0) AS tokens_out,
            COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
            COALESCE(SUM(t.cost_usd), 0) AS stored_cost_total,
            s.price_input_per_1m AS price_in,
            s.price_output_per_1m AS price_out,
            MAX(t.created_at) AS last_used
        FROM llm_usage_transactions t
        LEFT JOIN system_llm_settings s ON s.provider_key = t.provider
        WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)${userClause}
        GROUP BY t.provider, s.price_input_per_1m, s.price_output_per_1m
        ORDER BY stored_cost_total DESC`.execute(db)
    ).rows;

    // No provider has a hardcoded fallback price; a missing/null system_llm_settings row stays null.
    const llmCosts: any[] = llmCostsRaw.map((row: any) => {
      const fb: [number | null, number | null] = [null, null];
      const priceIn = row.price_in !== null && row.price_in !== undefined ? Number(row.price_in) : fb[0];
      const priceOut = row.price_out !== null && row.price_out !== undefined ? Number(row.price_out) : fb[1];
      const tokensIn = phpIntVal(row.tokens_in);
      const tokensOut = phpIntVal(row.tokens_out);
      return {
        ...row,
        resolved_price_in: priceIn,
        resolved_price_out: priceOut,
        cost_in: priceIn !== null ? (tokensIn * priceIn) / 1_000_000 : null,
        cost_out: priceOut !== null ? (tokensOut * priceOut) / 1_000_000 : null,
      };
    });

    // Sort by computed total (in + out), falling back to stored cost when prices unknown.
    // PHP `$ta === 0.0` is a strict float compare: it only fires when the sum is float-zero, i.e.
    // at least one of cost_in/cost_out was non-null (both null → int 0, which is !== 0.0).
    llmCosts.sort((a, b) => {
      const ta = (a.cost_in ?? 0) + (a.cost_out ?? 0);
      const tb = (b.cost_in ?? 0) + (b.cost_out ?? 0);
      const aFloatZero = (a.cost_in !== null || a.cost_out !== null) && ta === 0;
      const bFloatZero = (b.cost_in !== null || b.cost_out !== null) && tb === 0;
      if (aFloatZero && bFloatZero) {
        return spaceship(Number(b.stored_cost_total), Number(a.stored_cost_total));
      }
      return spaceship(tb, ta);
    });

    // Voice costs (is_voice_request transactions).
    const voiceCosts = (
      await sql<any>`SELECT
            provider,
            COUNT(*) as total_requests,
            COALESCE(SUM(audio_duration_seconds), 0) as total_seconds,
            COALESCE(SUM(cost_usd), 0) as total_cost,
            MAX(created_at) as last_used
        FROM llm_usage_transactions
        WHERE is_voice_request = 1
            AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)${userClauseNoAlias}
        GROUP BY provider
        ORDER BY total_cost DESC`.execute(db)
    ).rows;

    // Totals for each period (day, week, month).
    const totals = (
      await sql<any>`SELECT
            SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN cost_usd ELSE 0 END) as cost_today,
            SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN cost_usd ELSE 0 END) as cost_week,
            SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN cost_usd ELSE 0 END) as cost_month,
            SUM(cost_usd) as cost_total,
            SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) THEN cost_usd ELSE 0 END) as voice_cost_today,
            SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN cost_usd ELSE 0 END) as voice_cost_week,
            SUM(CASE WHEN is_voice_request = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN cost_usd ELSE 0 END) as voice_cost_month,
            SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost_total
        FROM llm_usage_transactions${totalsWhere}`.execute(db)
    ).rows[0];

    return {
      llm: {
        byProvider: llmCosts.map((p: any) => {
          const costIn = p.cost_in;
          const costOut = p.cost_out;
          // Total: prefer computed in+out; if either is unknown (no price available), fall back to
          // the historical stored cost so we never show 0.
          let total: number;
          if (costIn !== null && costOut !== null) {
            total = costIn + costOut;
          } else {
            total = Number(p.stored_cost_total);
          }
          return {
            provider: p.provider,
            requests: phpIntVal(p.total_requests),
            tokensIn: phpIntVal(p.tokens_in),
            tokensOut: phpIntVal(p.tokens_out),
            tokens: phpIntVal(p.total_tokens),
            priceIn: p.resolved_price_in,
            priceOut: p.resolved_price_out,
            costIn: costIn !== null ? phpRound(costIn, 4) : null,
            costOut: costOut !== null ? phpRound(costOut, 4) : null,
            cost: phpRound(total, 4),
            storedCost: phpRound(Number(p.stored_cost_total), 4),
            lastUsed: p.last_used,
          };
        }),
        totals: {
          today: phpRound(Number(totals?.cost_today ?? 0), 4),
          week: phpRound(Number(totals?.cost_week ?? 0), 4),
          month: phpRound(Number(totals?.cost_month ?? 0), 4),
          total: phpRound(Number(totals?.cost_total ?? 0), 4),
        },
      },
      voice: {
        byProvider: voiceCosts.map((p: any) => {
          return {
            provider: p.provider,
            requests: phpIntVal(p.total_requests),
            seconds: phpRound(Number(p.total_seconds), 2),
            cost: phpRound(Number(p.total_cost), 4),
            lastUsed: p.last_used,
          };
        }),
        totals: {
          today: phpRound(Number(totals?.voice_cost_today ?? 0), 4),
          week: phpRound(Number(totals?.voice_cost_week ?? 0), 4),
          month: phpRound(Number(totals?.voice_cost_month ?? 0), 4),
          total: phpRound(Number(totals?.voice_cost_total ?? 0), 4),
        },
      },
      avatar: {
        byProvider: [],
        totals: {
          today: 0,
          week: 0,
          month: 0,
          total: 0,
        },
        note: 'Avatar usage costs are tracked separately if avatar provider integrations are active',
      },
    };
  }

  // ============================================
  // USAGE / ANALYTICS (read-only)
  // ============================================

  /** GET /api/v1/admin/usage/stats — overall + by-provider + daily-trend usage. Mirrors getUsageStats(). */
  async getUsageStats(ctx: Ctx): Promise<ControllerResult> {
    try {
      const q = ctx.query ?? {};
      const period = (q.period as any) ?? 'month';
      const dateFrom = (q.date_from as any) ?? null;
      const dateTo = (q.date_to as any) ?? null;

      const dateRange = this.getDateRange(period, dateFrom, dateTo);

      const overall = (
        await sql<any>`SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failed_requests,
                COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(AVG(response_time_ms), 0) as avg_response_time,
                COUNT(DISTINCT user_id) as unique_users,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as total_voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as total_audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as total_voice_cost,
                COALESCE(SUM(function_calls_count), 0) as total_function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as total_mcp_calls
            FROM llm_usage_transactions
            WHERE created_at BETWEEN ${dateRange.from} AND ${dateRange.to}`.execute(db)
      ).rows[0];

      const byProvider = (
        await sql<any>`SELECT
                provider,
                COUNT(*) as requests,
                COALESCE(SUM(total_tokens), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost,
                COALESCE(AVG(response_time_ms), 0) as avg_response_time,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE created_at BETWEEN ${dateRange.from} AND ${dateRange.to}
            GROUP BY provider
            ORDER BY cost DESC`.execute(db)
      ).rows;

      const dailyTrend = (
        await sql<any>`SELECT
                DATE(created_at) as date,
                COUNT(*) as requests,
                COALESCE(SUM(cost_usd), 0) as cost,
                COALESCE(SUM(total_tokens), 0) as tokens
            FROM llm_usage_transactions
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY DATE(created_at)
            ORDER BY date ASC`.execute(db)
      ).rows;

      return {
        success: true,
        period,
        date_range: dateRange,
        overall: {
          total_requests: phpIntVal(overall.total_requests),
          successful_requests: phpIntVal(overall.successful_requests),
          failed_requests: phpIntVal(overall.failed_requests),
          total_tokens: phpIntVal(overall.total_tokens),
          prompt_tokens: phpIntVal(overall.total_prompt_tokens),
          completion_tokens: phpIntVal(overall.total_completion_tokens),
          total_cost: phpRound(Number(overall.total_cost), 4),
          avg_response_time_ms: phpRound(Number(overall.avg_response_time), 0),
          unique_users: phpIntVal(overall.unique_users),
          voice_requests: phpIntVal(overall.total_voice_requests ?? 0),
          audio_seconds: phpRound(Number(overall.total_audio_seconds ?? 0), 2),
          voice_cost: phpRound(Number(overall.total_voice_cost ?? 0), 4),
          total_function_calls: phpIntVal(overall.total_function_calls ?? 0),
          total_mcp_calls: phpIntVal(overall.total_mcp_calls ?? 0),
        },
        by_provider: byProvider.map((p: any) => ({
          provider: p.provider,
          requests: phpIntVal(p.requests),
          tokens: phpIntVal(p.tokens),
          cost: phpRound(Number(p.cost), 4),
          avg_response_time_ms: phpRound(Number(p.avg_response_time), 0),
          voice_requests: phpIntVal(p.voice_requests ?? 0),
          audio_seconds: phpRound(Number(p.audio_seconds ?? 0), 2),
          voice_cost: phpRound(Number(p.voice_cost ?? 0), 4),
          function_calls: phpIntVal(p.function_calls ?? 0),
          mcp_calls: phpIntVal(p.mcp_calls ?? 0),
        })),
        daily_trend: dailyTrend.map((d: any) => ({
          date: d.date,
          requests: phpIntVal(d.requests),
          cost: phpRound(Number(d.cost), 4),
          tokens: phpIntVal(d.tokens),
        })),
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/admin/usage/by-user — usage breakdown by user (paginated). Mirrors getUsageByUser(). */
  async getUsageByUser(ctx: Ctx): Promise<ControllerResult> {
    try {
      const q = ctx.query ?? {};
      const period = (q.period as any) ?? 'month';
      const limit = Math.min(phpIntVal(q.limit ?? 50), 100);
      const offset = phpIntVal(q.offset ?? 0);

      const dateRange = this.getDateRange(period);

      const users = (
        await sql<any>`SELECT
                t.user_id,
                u.email,
                u.first_name,
                u.last_name,
                COUNT(*) as total_requests,
                COALESCE(SUM(t.total_tokens), 0) as total_tokens,
                COALESCE(SUM(t.cost_usd), 0) as total_cost,
                COALESCE(AVG(t.response_time_ms), 0) as avg_response_time,
                MAX(t.created_at) as last_activity,
                SUM(CASE WHEN t.is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(t.audio_duration_seconds), 0) as audio_seconds,
                SUM(CASE WHEN t.is_voice_request = 1 THEN t.cost_usd ELSE 0 END) as voice_cost,
                COALESCE(SUM(t.function_calls_count), 0) as function_calls,
                COALESCE(SUM(t.mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.created_at BETWEEN ${dateRange.from} AND ${dateRange.to}
            GROUP BY t.user_id, u.email, u.first_name, u.last_name
            ORDER BY total_cost DESC
            LIMIT ${sql.lit(limit)} OFFSET ${sql.lit(offset)}`.execute(db)
      ).rows;

      const total = phpIntVal(
        (
          await sql<any>`SELECT COUNT(DISTINCT user_id) as total FROM llm_usage_transactions
                         WHERE created_at BETWEEN ${dateRange.from} AND ${dateRange.to}`.execute(db)
        ).rows[0]?.total
      );

      return {
        success: true,
        period,
        date_range: dateRange,
        users: users.map((u: any) => ({
          user_id: phpIntVal(u.user_id),
          email: u.email ?? 'Unknown',
          name: nameOrUnknown(u.first_name, u.last_name),
          requests: phpIntVal(u.total_requests),
          tokens: phpIntVal(u.total_tokens),
          cost: phpRound(Number(u.total_cost), 4),
          avg_response_time_ms: phpRound(Number(u.avg_response_time), 0),
          last_activity: u.last_activity,
          voice_requests: phpIntVal(u.voice_requests ?? 0),
          audio_seconds: phpRound(Number(u.audio_seconds ?? 0), 2),
          voice_cost: phpRound(Number(u.voice_cost ?? 0), 4),
          function_calls: phpIntVal(u.function_calls ?? 0),
          mcp_calls: phpIntVal(u.mcp_calls ?? 0),
        })),
        pagination: {
          total,
          limit,
          offset,
        },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/admin/usage/users/:id — detailed usage for one user. Mirrors getUserUsageDetail(). */
  async getUserUsageDetail(ctx: Ctx): Promise<ControllerResult> {
    const userId = phpIntVal(ctx.params?.id ?? 0);
    try {
      const q = ctx.query ?? {};
      const period = (q.period as any) ?? 'month';
      const dateRange = this.getDateRange(period);

      const user = (
        await sql<any>`SELECT id, email, first_name, last_name FROM users WHERE id = ${userId}`.execute(db)
      ).rows[0];

      if (!user) {
        return { success: false, error: 'User not found', status_code: 404 };
      }

      const stats = (
        await sql<any>`SELECT
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
                COALESCE(SUM(total_tokens), 0) as total_tokens,
                COALESCE(SUM(cost_usd), 0) as total_cost,
                COALESCE(AVG(response_time_ms), 0) as avg_response_time,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                SUM(CASE WHEN is_voice_request = 1 THEN cost_usd ELSE 0 END) as voice_cost,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE user_id = ${userId} AND created_at BETWEEN ${dateRange.from} AND ${dateRange.to}`.execute(db)
      ).rows[0];

      const byProvider = (
        await sql<any>`SELECT
                provider,
                COUNT(*) as requests,
                COALESCE(SUM(total_tokens), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost,
                SUM(CASE WHEN is_voice_request = 1 THEN 1 ELSE 0 END) as voice_requests,
                COALESCE(SUM(audio_duration_seconds), 0) as audio_seconds,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE user_id = ${userId} AND created_at BETWEEN ${dateRange.from} AND ${dateRange.to}
            GROUP BY provider
            ORDER BY cost DESC`.execute(db)
      ).rows;

      const recentTransactions = (
        await sql<any>`SELECT
                id, provider, model, prompt_tokens, completion_tokens, total_tokens,
                cost_usd, response_time_ms, status, function_calls_count, created_at,
                is_voice_request, audio_duration_seconds, audio_input_seconds, audio_output_seconds,
                mcp_calls_count, functions_called, mcp_tools_called
            FROM llm_usage_transactions
            WHERE user_id = ${userId}
            ORDER BY created_at DESC
            LIMIT 50`.execute(db)
      ).rows;

      return {
        success: true,
        user: {
          id: phpIntVal(user.id),
          email: user.email,
          name: phpTrim((user.first_name ?? '') + ' ' + (user.last_name ?? '')),
        },
        period,
        date_range: dateRange,
        stats: {
          total_requests: phpIntVal(stats.total_requests),
          successful_requests: phpIntVal(stats.successful_requests),
          total_tokens: phpIntVal(stats.total_tokens),
          total_cost: phpRound(Number(stats.total_cost), 4),
          avg_response_time_ms: phpRound(Number(stats.avg_response_time), 0),
          voice_requests: phpIntVal(stats.voice_requests ?? 0),
          audio_seconds: phpRound(Number(stats.audio_seconds ?? 0), 2),
          voice_cost: phpRound(Number(stats.voice_cost ?? 0), 4),
          function_calls: phpIntVal(stats.function_calls ?? 0),
          mcp_calls: phpIntVal(stats.mcp_calls ?? 0),
        },
        by_provider: byProvider.map((p: any) => ({
          provider: p.provider,
          requests: phpIntVal(p.requests),
          tokens: phpIntVal(p.tokens),
          cost: phpRound(Number(p.cost), 4),
          voice_requests: phpIntVal(p.voice_requests ?? 0),
          audio_seconds: phpRound(Number(p.audio_seconds ?? 0), 2),
          function_calls: phpIntVal(p.function_calls ?? 0),
          mcp_calls: phpIntVal(p.mcp_calls ?? 0),
        })),
        recent_transactions: recentTransactions.map((t: any) => ({
          id: phpIntVal(t.id),
          provider: t.provider,
          model: t.model,
          prompt_tokens: phpIntVal(t.prompt_tokens),
          completion_tokens: phpIntVal(t.completion_tokens),
          total_tokens: phpIntVal(t.total_tokens),
          cost: phpRound(Number(t.cost_usd), 6),
          response_time_ms: phpIntVal(t.response_time_ms),
          status: t.status,
          function_calls: phpIntVal(t.function_calls_count),
          mcp_calls: phpIntVal(t.mcp_calls_count ?? 0),
          functions_called: t.functions_called ? decodeToolArrayCol(t.functions_called) : [],
          mcp_tools_called: t.mcp_tools_called ? decodeToolArrayCol(t.mcp_tools_called) : [],
          created_at: t.created_at,
          is_voice: phpBoolVal(t.is_voice_request ?? 0),
          audio_seconds: phpRound(Number(t.audio_duration_seconds ?? 0), 2),
        })),
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/admin/usage/transactions — filtered transaction list (admin view). Mirrors getUsageTransactions(). */
  async getUsageTransactions(ctx: Ctx): Promise<ControllerResult> {
    try {
      const q = ctx.query ?? {};
      const provider = (q.provider as any) ?? null;
      const userId = (q.user_id as any) ?? null;
      const status = (q.status as any) ?? null;
      const dateFrom = (q.date_from as any) ?? null;
      const dateTo = (q.date_to as any) ?? null;
      const limit = Math.min(phpIntVal(q.limit ?? 100), 500);
      const offset = phpIntVal(q.offset ?? 0);

      const conditions: any[] = [];

      if (!phpEmpty(provider)) {
        conditions.push(sql`t.provider = ${provider}`);
      }
      if (!phpEmpty(userId)) {
        conditions.push(sql`t.user_id = ${phpIntVal(userId)}`);
      }
      if (!phpEmpty(status)) {
        conditions.push(sql`t.status = ${status}`);
      }
      if (!phpEmpty(dateFrom)) {
        conditions.push(sql`t.created_at >= ${dateFrom}`);
      }
      if (!phpEmpty(dateTo)) {
        conditions.push(sql`t.created_at <= ${dateTo}`);
      }

      const whereClause =
        conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

      const transactions = (
        await sql<any>`SELECT
                t.id, t.user_id, t.provider, t.model, t.prompt_tokens, t.completion_tokens,
                t.total_tokens, t.cost_usd, t.response_time_ms, t.status, t.error_message,
                t.function_calls_count, t.mcp_calls_count, t.functions_called, t.mcp_tools_called,
                t.created_at,
                t.is_voice_request, t.audio_duration_seconds, t.audio_input_seconds, t.audio_output_seconds,
                u.email, u.first_name, u.last_name
            FROM llm_usage_transactions t
            LEFT JOIN users u ON t.user_id = u.id
            ${whereClause}
            ORDER BY t.created_at DESC
            LIMIT ${sql.lit(limit)} OFFSET ${sql.lit(offset)}`.execute(db)
      ).rows;

      const total = phpIntVal(
        (
          await sql<any>`SELECT COUNT(*) as total FROM llm_usage_transactions t ${whereClause}`.execute(db)
        ).rows[0]?.total
      );

      return {
        success: true,
        transactions: transactions.map((t: any) => ({
          id: phpIntVal(t.id),
          user_id: phpIntVal(t.user_id),
          user_email: t.email ?? 'Unknown',
          user_name: nameOrUnknown(t.first_name, t.last_name),
          provider: t.provider,
          model: t.model,
          prompt_tokens: phpIntVal(t.prompt_tokens),
          completion_tokens: phpIntVal(t.completion_tokens),
          total_tokens: phpIntVal(t.total_tokens),
          cost: phpRound(Number(t.cost_usd), 6),
          response_time_ms: phpIntVal(t.response_time_ms),
          status: t.status,
          error_message: t.error_message,
          function_calls: phpIntVal(t.function_calls_count),
          mcp_calls: phpIntVal(t.mcp_calls_count ?? 0),
          functions_called: t.functions_called ? decodeToolArrayCol(t.functions_called) : [],
          mcp_tools_called: t.mcp_tools_called ? decodeToolArrayCol(t.mcp_tools_called) : [],
          created_at: t.created_at,
          is_voice: phpBoolVal(t.is_voice_request ?? 0),
          audio_seconds: phpRound(Number(t.audio_duration_seconds ?? 0), 2),
          audio_input_seconds: phpRound(Number(t.audio_input_seconds ?? 0), 2),
          audio_output_seconds: phpRound(Number(t.audio_output_seconds ?? 0), 2),
        })),
        pagination: {
          total,
          limit,
          offset,
        },
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/admin/usage/tools — tool/MCP usage statistics. Mirrors getToolStats(). */
  async getToolStats(ctx: Ctx): Promise<ControllerResult> {
    try {
      const q = ctx.query ?? {};
      const period = (q.period as any) ?? 'month';
      const dateRange = this.getDateRange(period);

      // Source of truth for what is an MCP tool.
      const mcpToolsFromDb = await this.loadRegisteredMCPTools();

      const overall = (
        await sql<any>`SELECT
                COUNT(*) as total_requests,
                COALESCE(SUM(function_calls_count), 0) as total_function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as total_mcp_calls,
                SUM(CASE WHEN function_calls_count > 0 THEN 1 ELSE 0 END) as requests_with_tools
            FROM llm_usage_transactions
            WHERE created_at BETWEEN ${dateRange.from} AND ${dateRange.to}`.execute(db)
      ).rows[0];

      const byProvider = (
        await sql<any>`SELECT
                provider,
                COALESCE(SUM(function_calls_count), 0) as function_calls,
                COALESCE(SUM(mcp_calls_count), 0) as mcp_calls
            FROM llm_usage_transactions
            WHERE created_at BETWEEN ${dateRange.from} AND ${dateRange.to}
                AND function_calls_count > 0
            GROUP BY provider
            ORDER BY function_calls DESC`.execute(db)
      ).rows;

      const rows = (
        await sql<any>`SELECT user_id, functions_called, mcp_tools_called, created_at
            FROM llm_usage_transactions
            WHERE created_at BETWEEN ${dateRange.from} AND ${dateRange.to}
                AND functions_called IS NOT NULL`.execute(db)
      ).rows;

      // Aggregate detailed tool stats.
      type ToolStat = { count: number; users: Set<any>; last_used: string | null; is_mcp: boolean };
      const toolStats = new Map<string, ToolStat>();
      const mcpToolStats = new Map<string, { count: number; users: Set<any>; last_used: string | null }>();

      for (const row of rows) {
        const functions = decodeJsonArray(row.functions_called);
        const mcpTools = decodeJsonArray(row.mcp_tools_called);
        const userId = row.user_id;
        const createdAt = row.created_at;

        for (const fn of functions) {
          if (!toolStats.has(fn)) {
            toolStats.set(fn, { count: 0, users: new Set(), last_used: null, is_mcp: false });
          }
          const s = toolStats.get(fn)!;
          s.count++;
          s.users.add(userId);
          if (s.last_used === null || createdAt > s.last_used) {
            s.last_used = createdAt;
          }
        }

        for (const mcpTool of mcpTools) {
          const toolName = mcpTool;
          if (!toolStats.has(toolName)) {
            toolStats.set(toolName, { count: 0, users: new Set(), last_used: null, is_mcp: true });
          }
          const s = toolStats.get(toolName)!;
          s.count++;
          s.is_mcp = true;
          s.users.add(userId);
          if (s.last_used === null || createdAt > s.last_used) {
            s.last_used = createdAt;
          }

          if (!mcpToolStats.has(toolName)) {
            mcpToolStats.set(toolName, { count: 0, users: new Set(), last_used: null });
          }
          const ms = mcpToolStats.get(toolName)!;
          ms.count++;
          ms.users.add(userId);
          if (ms.last_used === null || createdAt > ms.last_used) {
            ms.last_used = createdAt;
          }
        }
      }

      // Sort by count descending (stable) and format detailed tools.
      const sortedTools = [...toolStats.entries()].sort((a, b) => b[1].count - a[1].count);

      const detailedTools: any[] = [];
      let totalMcpCalls = 0;
      let count = 0;
      for (const [name, stats] of sortedTools) {
        const mcpInfo = this.isMCPToolFromRegistry(name, mcpToolsFromDb);
        const isMcp = mcpInfo !== null;

        if (isMcp) {
          totalMcpCalls += stats.count;
        }

        detailedTools.push({
          name,
          count: stats.count,
          unique_users: stats.users.size,
          last_used: stats.last_used,
          is_mcp: isMcp,
          mcp_server: mcpInfo?.server_name ?? null,
        });
        count++;
        if (count >= 50) break; // Top 50 tools
      }

      // Aggregate MCP server stats with detailed tool breakdown.
      const mcpServerStats = new Map<
        string,
        { name: string; total_calls: number; tool_count: number; unique_users: Set<any>; tools: any[] }
      >();
      for (const tool of detailedTools) {
        if (tool.is_mcp && tool.mcp_server) {
          const serverName = tool.mcp_server;
          if (!mcpServerStats.has(serverName)) {
            mcpServerStats.set(serverName, {
              name: serverName,
              total_calls: 0,
              tool_count: 0,
              unique_users: new Set(),
              tools: [],
            });
          }
          const srv = mcpServerStats.get(serverName)!;
          srv.total_calls += tool.count;
          srv.tool_count++;
          const ts = toolStats.get(tool.name);
          if (ts) {
            for (const uid of ts.users) srv.unique_users.add(uid);
          }
          srv.tools.push({
            name: tool.name,
            count: tool.count,
            unique_users: tool.unique_users,
            last_used: tool.last_used,
          });
        }
      }

      // Sort tools within each server by count, then sort servers by total calls.
      const serverList = [...mcpServerStats.values()];
      for (const srv of serverList) {
        srv.tools.sort((a, b) => b.count - a.count);
      }
      serverList.sort((a, b) => b.total_calls - a.total_calls);
      const mcpServers = serverList.map((srv) => ({
        name: srv.name,
        total_calls: srv.total_calls,
        tool_count: srv.tool_count,
        unique_users: srv.unique_users.size,
        tools: srv.tools,
      }));

      // Tool usage rate.
      const totalRequests = phpIntVal(overall.total_requests);
      const requestsWithTools = phpIntVal(overall.requests_with_tools);
      const toolUsageRate =
        totalRequests > 0 ? phpRound((requestsWithTools / totalRequests) * 100, 1) : 0;

      const regularToolsUsed = detailedTools.filter((t) => !t.is_mcp);
      const mcpToolsUsed = detailedTools.filter((t) => t.is_mcp);

      const allAvailableRegularTools = this.loadAllAvailableRegularTools(toolStats);
      const allAvailableMcpTools = await this.loadAllAvailableMCPTools(toolStats);

      return {
        success: true,
        period,
        date_range: dateRange,
        total_function_calls: phpIntVal(overall.total_function_calls),
        total_mcp_calls: totalMcpCalls,
        total_requests: totalRequests,
        requests_with_tools: requestsWithTools,
        tool_usage_rate: toolUsageRate,
        unique_tools_count: toolStats.size,
        unique_mcp_tools_count: mcpToolsUsed.length,
        top_tools: detailedTools,
        regular_tools: regularToolsUsed,
        mcp_tools: mcpToolsUsed,
        mcp_servers: mcpServers,
        all_regular_tools: allAvailableRegularTools,
        all_mcp_tools: allAvailableMcpTools,
        by_provider: byProvider.map((p: any) => ({
          provider: p.provider,
          function_calls: phpIntVal(p.function_calls),
          mcp_calls: phpIntVal(p.mcp_calls),
        })),
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/admin/costs — stored provider pricing + usage costs breakdown (all users). Mirrors getCosts(). */
  async getCosts(_ctx: Ctx): Promise<ControllerResult> {
    try {
      // PHP ensureCostsTableExists() (CREATE TABLE IF NOT EXISTS) is skipped per DDL policy; the
      // SHOW TABLES guard yields the same effective empty-shape (→ getDefaultCosts) when absent.
      const tableCheck = (await sql<any>`SHOW TABLES LIKE 'provider_costs'`.execute(db)).rows;
      const rows =
        tableCheck.length > 0
          ? (await sql<any>`SELECT * FROM provider_costs ORDER BY category, provider`.execute(db)).rows
          : [];

      let costs: any = {
        llm: [] as any[],
        voice: [] as any[],
        avatar: [] as any[],
        lastRefreshed: null as any,
      };

      for (const row of rows) {
        const tiers = decodeJsonArray(row.tiers);
        (costs[row.category] as any[]).push({
          provider: row.provider,
          displayName: row.display_name,
          category: row.category,
          tiers,
          pricingUrl: row.pricing_url,
          lastUpdated: row.updated_at,
          notes: row.notes,
        });
        if (!costs.lastRefreshed || row.updated_at > costs.lastRefreshed) {
          costs.lastRefreshed = row.updated_at;
        }
      }

      if (costs.llm.length === 0 && costs.voice.length === 0 && costs.avatar.length === 0) {
        costs = this.getDefaultCosts();
      }

      const usageCosts = await this.getUsageCostsBreakdown();

      return {
        success: true,
        costs,
        usageCosts,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /** GET /api/v1/admin/exchange-rates — stored USD→X exchange rates. Mirrors getExchangeRates(). */
  async getExchangeRates(_ctx: Ctx): Promise<ControllerResult> {
    try {
      // PHP ensureExchangeRatesTableExists() DDL is skipped; SHOW TABLES guard yields the default
      // rate set when the table is absent (same effective shape as the post-create empty query).
      const tableCheck = (await sql<any>`SHOW TABLES LIKE 'exchange_rates'`.execute(db)).rows;
      const rows =
        tableCheck.length > 0
          ? (await sql<any>`SELECT * FROM exchange_rates ORDER BY currency`.execute(db)).rows
          : [];

      const rates: Record<string, number> = {
        USD: 1.0,
        EUR: 0.92,
        CAD: 1.36,
      };
      let lastUpdated: any = null;

      for (const row of rows) {
        rates[row.currency] = Number(row.rate);
        if (!lastUpdated || row.updated_at > lastUpdated) {
          lastUpdated = row.updated_at;
        }
      }

      return {
        success: true,
        rates,
        baseCurrency: 'USD',
        lastUpdated,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/admin/costs/refresh — refresh all provider costs. Mirrors refreshAllCosts().
   * Iterates the default catalog (llm/voice/avatar); per-provider failures accumulate into errors[]
   * as "{provider}: {message}". Returns the reloaded stored costs. AUTHENTICATION-ONLY gating.
   */
  async refreshAllCosts(_ctx: Ctx): Promise<ControllerResult> {
    try {
      // PHP ensureCostsTableExists() (CREATE TABLE IF NOT EXISTS) is skipped per DDL policy; the
      // reload SELECT below is guarded by SHOW TABLES like getCosts().
      const allCosts = this.getDefaultCosts();
      let updated = 0;
      const errors: string[] = [];

      // Process each category
      for (const category of ['llm', 'voice', 'avatar']) {
        for (const provider of allCosts[category] as any[]) {
          try {
            const updatedProvider = await this.fetchProviderPricing(provider);
            if (updatedProvider) {
              await this.saveProviderCosts(category, updatedProvider);
              updated++;
            }
          } catch (e: any) {
            errors.push(`${provider.provider}: ${e?.message ?? ''}`);
          }
        }
      }

      // Reload stored costs
      const tableCheck = (await sql<any>`SHOW TABLES LIKE 'provider_costs'`.execute(db)).rows;
      const rows =
        tableCheck.length > 0
          ? (await sql<any>`SELECT * FROM provider_costs ORDER BY category, provider`.execute(db)).rows
          : [];

      const costs: any = {
        llm: [] as any[],
        voice: [] as any[],
        avatar: [] as any[],
        lastRefreshed: phpDateYmdHis(new Date()),
      };

      for (const row of rows) {
        const tiers = decodeJsonArray(row.tiers);
        (costs[row.category] as any[]).push({
          provider: row.provider,
          displayName: row.display_name,
          category: row.category,
          tiers,
          pricingUrl: row.pricing_url,
          lastUpdated: row.updated_at,
          notes: row.notes,
        });
      }

      // Get usage costs
      const usageCosts = await this.getUsageCostsBreakdown();

      return {
        success: true,
        costs,
        usageCosts,
        updated_count: updated,
        errors,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/admin/costs/refresh-provider — refresh one provider. Mirrors refreshProviderCosts().
   * Identified by body {category, provider}. Validates category (400 'Invalid category'), then
   * requires provider (400 'Provider is required'), then 404 'Provider not found' if not in defaults.
   */
  async refreshProviderCosts(ctx: Ctx): Promise<ControllerResult> {
    try {
      const input = ctx.body ?? {};
      const category = input.category ?? '';
      const providerName = input.provider ?? '';

      if (!['llm', 'voice', 'avatar'].includes(category)) {
        return { success: false, error: 'Invalid category', status_code: 400 };
      }

      if (phpEmpty(providerName)) {
        return { success: false, error: 'Provider is required', status_code: 400 };
      }

      // PHP ensureCostsTableExists() DDL skipped per policy; reload SELECT guarded by SHOW TABLES.

      // Find the provider in defaults
      const allCosts = this.getDefaultCosts();
      let providerData: any = null;

      for (const p of allCosts[category] as any[]) {
        if (p.provider === providerName) {
          providerData = p;
          break;
        }
      }

      if (!providerData) {
        return { success: false, error: 'Provider not found', status_code: 404 };
      }

      // Fetch and update pricing
      const updatedProvider = await this.fetchProviderPricing(providerData);
      if (updatedProvider) {
        await this.saveProviderCosts(category, updatedProvider);
      }

      // Reload provider data
      const tableCheck = (await sql<any>`SHOW TABLES LIKE 'provider_costs'`.execute(db)).rows;
      const row =
        tableCheck.length > 0
          ? (
              await sql<any>`SELECT * FROM provider_costs WHERE category = ${category} AND provider = ${providerName}`.execute(
                db
              )
            ).rows[0]
          : undefined;

      let provider: any;
      if (row) {
        provider = {
          provider: row.provider,
          displayName: row.display_name,
          category: row.category,
          tiers: decodeJsonArray(row.tiers),
          pricingUrl: row.pricing_url,
          lastUpdated: row.updated_at,
          notes: row.notes,
        };
      } else {
        provider = { ...providerData, lastUpdated: phpDateYmdHis(new Date()) };
      }

      return {
        success: true,
        provider,
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  /**
   * POST /api/v1/admin/exchange-rates/refresh — refresh USD→EUR/CAD rates from a free external API.
   * Mirrors refreshExchangeRates(). Note: fetchExchangeRatesFromApi() never returns null (it falls
   * back to hardcoded defaults), so the 'Failed to fetch exchange rates' branch is effectively
   * unreachable — kept for fidelity with the PHP source.
   */
  async refreshExchangeRates(_ctx: Ctx): Promise<ControllerResult> {
    try {
      // PHP ensureExchangeRatesTableExists() DDL skipped per policy.

      // Fetch rates from exchangerate-api.com (free tier)
      const rates = await this.fetchExchangeRatesFromApi();

      if (!rates) {
        return {
          success: false,
          error: 'Failed to fetch exchange rates',
          status_code: 500,
        };
      }

      // Save rates to database
      for (const currency of ['EUR', 'CAD']) {
        if (rates[currency] !== undefined && rates[currency] !== null) {
          await sql`
                        INSERT INTO exchange_rates (currency, rate, updated_at)
                        VALUES (${currency}, ${rates[currency]}, NOW())
                        ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = NOW()
                    `.execute(db);
        }
      }

      return {
        success: true,
        rates: { USD: 1.0, ...rates },
        baseCurrency: 'USD',
        lastUpdated: phpDateYmdHis(new Date()),
        status_code: 200,
      };
    } catch (e: any) {
      return { success: false, error: e?.message ?? '', status_code: 500 };
    }
  }

  // ============================================
  // USAGE / ANALYTICS — private helpers
  // ============================================

  /** Mirrors getDateRange($period, $dateFrom, $dateTo). */
  private getDateRange(
    period: string,
    dateFrom: string | null = null,
    dateTo: string | null = null
  ): { from: string; to: string } {
    if (dateFrom && dateTo) {
      return { from: dateFrom, to: dateTo };
    }

    const now = new Date();
    const to = `${phpDateYmd(now)} 23:59:59`;
    let from: string;
    switch (period) {
      case 'day':
        from = `${phpDateYmd(now)} 00:00:00`;
        break;
      case 'week': {
        const d = new Date(now);
        d.setDate(d.getDate() - 7);
        from = `${phpDateYmd(d)} 00:00:00`;
        break;
      }
      case 'month': {
        const d = new Date(now);
        d.setDate(d.getDate() - 30);
        from = `${phpDateYmd(d)} 00:00:00`;
        break;
      }
      case 'year': {
        const d = new Date(now);
        d.setDate(d.getDate() - 365);
        from = `${phpDateYmd(d)} 00:00:00`;
        break;
      }
      case 'all':
        from = '2000-01-01 00:00:00';
        break;
      default: {
        const d = new Date(now);
        d.setDate(d.getDate() - 30);
        from = `${phpDateYmd(d)} 00:00:00`;
      }
    }

    return { from, to };
  }

  /** Mirrors loadRegisteredMCPTools(): tool_name (and mcp_ prefix) → {server_name, server_id}. */
  private async loadRegisteredMCPTools(): Promise<Record<string, { server_name: any; server_id: any }>> {
    const mcpTools: Record<string, { server_name: any; server_id: any }> = {};
    try {
      const rows = (
        await sql<any>`
                SELECT t.tool_name, s.name as server_name, s.id as server_id
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
            `.execute(db)
      ).rows;

      for (const row of rows) {
        const toolName = row.tool_name;
        mcpTools[toolName] = { server_name: row.server_name, server_id: row.server_id };
        mcpTools['mcp_' + toolName] = { server_name: row.server_name, server_id: row.server_id };
      }
    } catch (e: any) {
      console.error('Failed to load MCP tools: ' + (e?.message ?? ''));
    }
    return mcpTools;
  }

  /** Mirrors isMCPToolFromRegistry(): returns server info or null. */
  private isMCPToolFromRegistry(
    toolName: string,
    registry: Record<string, { server_name: any; server_id: any }>
  ): { server_name: any; server_id: any } | null {
    if (Object.prototype.hasOwnProperty.call(registry, toolName)) {
      return registry[toolName];
    }
    if (Object.prototype.hasOwnProperty.call(registry, 'mcp_' + toolName)) {
      return registry['mcp_' + toolName];
    }
    if (toolName.startsWith('mcp_')) {
      const withoutPrefix = toolName.slice(4);
      if (Object.prototype.hasOwnProperty.call(registry, withoutPrefix)) {
        return registry[withoutPrefix];
      }
    }
    return null;
  }

  /** Mirrors loadAllAvailableRegularTools(): reads resources/claude_tools.json, overlays usage. */
  private loadAllAvailableRegularTools(
    usageStats: Map<string, { count: number; users: Set<any>; last_used: string | null }>
  ): any[] {
    const tools: any[] = [];
    // PHP resolves dirname(__DIR__).'/../resources/claude_tools.json' (backend/resources). The TS
    // mirror keeps a copy in resources/claude_tools.json. Missing/invalid file → no tools (as PHP).
    const toolsJsonPath = path.resolve(__dirname, '../../resources/claude_tools.json');

    let toolDefinitions: any[] = [];
    try {
      const content = readFileSync(toolsJsonPath, 'utf8');
      toolDefinitions = decodeJsonArray(JSON.parse(content));
    } catch {
      toolDefinitions = [];
    }

    for (const tool of toolDefinitions) {
      const name = tool?.name ?? '';
      if (name === '' || name === '0') continue;

      const usage = usageStats.get(name) ?? null;
      tools.push({
        name,
        description: tool?.description ?? '',
        count: usage ? usage.count : 0,
        unique_users: usage ? usage.users.size : 0,
        last_used: usage ? usage.last_used : null,
        is_mcp: false,
        has_been_used: usage !== null,
      });
    }

    tools.sort((a, b) => {
      if (a.has_been_used !== b.has_been_used) {
        return spaceship(Number(b.has_been_used), Number(a.has_been_used));
      }
      if (a.count !== b.count) {
        return spaceship(b.count, a.count);
      }
      return phpStrcmp(a.name, b.name);
    });

    return tools;
  }

  /** Mirrors loadAllAvailableMCPTools(): reads mcp_server_tools, overlays usage. */
  private async loadAllAvailableMCPTools(
    usageStats: Map<string, { count: number; users: Set<any>; last_used: string | null }>
  ): Promise<any[]> {
    const tools: any[] = [];

    try {
      const rows = (
        await sql<any>`
                SELECT t.tool_name, t.tool_description, s.name as server_name, s.url as server_url
                FROM mcp_server_tools t
                JOIN mcp_servers s ON t.server_id = s.id
                ORDER BY s.name, t.tool_name
            `.execute(db)
      ).rows;

      for (const row of rows) {
        const originalName = row.tool_name;
        const prefixedName = 'mcp_' + originalName;

        const usage = usageStats.get(prefixedName) ?? usageStats.get(originalName) ?? null;

        tools.push({
          name: prefixedName,
          original_name: originalName,
          description: row.tool_description ?? '',
          mcp_server: row.server_name,
          server_url: row.server_url,
          count: usage ? usage.count : 0,
          unique_users: usage ? usage.users.size : 0,
          last_used: usage ? usage.last_used : null,
          is_mcp: true,
          has_been_used: usage !== null,
        });
      }
    } catch (e: any) {
      console.error('Failed to load MCP tools: ' + (e?.message ?? ''));
    }

    tools.sort((a, b) => {
      if (a.has_been_used !== b.has_been_used) {
        return spaceship(Number(b.has_been_used), Number(a.has_been_used));
      }
      if (a.count !== b.count) {
        return spaceship(b.count, a.count);
      }
      const serverCmp = phpStrcmp(a.mcp_server, b.mcp_server);
      if (serverCmp !== 0) return serverCmp;
      return phpStrcmp(a.name, b.name);
    });

    return tools;
  }

  /**
   * Mirrors fetchProviderPricing($provider): stamps a fresh lastUpdated, then (if an admin claude
   * key exists) tries to scrape+parse pricing via Claude, replacing tiers only on non-empty success.
   * ANY failure is swallowed (keeps default tiers). PHP passes the array by value; we shallow-copy so
   * the caller's providerData is not mutated (refreshProviderCosts reuses it as the fallback). Always
   * returns the provider (never null in practice).
   */
  private async fetchProviderPricing(provider: any): Promise<any> {
    // For now, return the default data with updated timestamp
    const p: any = { ...provider };
    p.lastUpdated = phpDateYmdHis(new Date());

    // Try to fetch current pricing using Claude API
    try {
      const apiKey = await this.getAdminApiKey('claude');
      if (apiKey) {
        const updatedTiers = await this.fetchPricingWithClaude(p.pricingUrl, p.displayName, apiKey);
        // PHP: $updatedTiers && !empty($updatedTiers)
        const nonEmpty =
          updatedTiers !== null &&
          (Array.isArray(updatedTiers)
            ? updatedTiers.length > 0
            : typeof updatedTiers === 'object'
              ? Object.keys(updatedTiers).length > 0
              : Boolean(updatedTiers));
        if (nonEmpty) {
          p.tiers = updatedTiers;
        }
      }
    } catch (e: any) {
      console.error(`Failed to fetch pricing for ${p.provider}: ` + (e?.message ?? ''));
      // Keep default tiers on failure
    }

    return p;
  }

  /**
   * Mirrors fetchPricingWithClaude($url, $providerName, $apiKey): fetch the pricing page HTML (30s,
   * PHP's desktop User-Agent, follow redirects), strip to text, truncate to 15000 bytes, then one-shot
   * the Claude Messages API (claude-3-5-haiku-20241022, max_tokens 2048) and parse a JSON tiers array.
   * Returns null on any non-200/empty/parse failure.
   */
  private async fetchPricingWithClaude(url: string, providerName: string, apiKey: string): Promise<any[] | null> {
    // Fetch the webpage content first
    let html = '';
    let httpCode = 0;
    {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: controller.signal,
        });
        httpCode = res.status;
        html = await res.text();
      } catch {
        httpCode = 0;
        html = '';
      } finally {
        clearTimeout(timer);
      }
    }

    if (httpCode !== 200 || !html) {
      console.error(`Failed to fetch pricing page for ${providerName}: HTTP ${httpCode}`);
      return null;
    }

    // Extract text content (strip tags but keep structure hints)
    let text = phpStripTags(
      html
        .split('<br>')
        .join('\n')
        .split('</div>')
        .join('\n')
        .split('</p>')
        .join('\n')
        .split('</li>')
        .join('\n')
    );
    text = text.replace(/\s+/g, ' ');
    text = phpByteSubstr(text, 0, 15000); // Limit context size

    // Call Claude to extract pricing
    const prompt = `Extract the current API pricing information for ${providerName} from this webpage content.

Return ONLY a JSON array of pricing tiers in this exact format:
[
  {"name": "Model or Plan Name", "price": "$X.XX", "unit": "per unit (e.g., / 1M tokens, / month)", "details": "optional additional info"}
]

Focus on API/developer pricing, not consumer subscription plans unless that's all available.
Include input/output token prices separately if available.

Webpage content:
${text}

Return ONLY the JSON array, no explanation or markdown.`;

    let response = '';
    let httpCode2 = 0;
    {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        });
        httpCode2 = res.status;
        response = await res.text();
      } catch {
        httpCode2 = 0;
        response = '';
      } finally {
        clearTimeout(timer);
      }
    }

    if (httpCode2 !== 200) {
      console.error(`Claude API call failed for ${providerName}: HTTP ${httpCode2}`);
      return null;
    }

    let data: any = null;
    try {
      data = JSON.parse(response);
    } catch {
      data = null;
    }
    let content = data?.content?.[0]?.text ?? '';

    // Parse the JSON response
    content = phpTrim(content);
    // Remove markdown code blocks if present
    content = content.replace(/^```json?\s*/, '');
    content = content.replace(/\s*```$/, '');

    let tiers: any = null;
    try {
      tiers = JSON.parse(content);
    } catch {
      tiers = null;
    }

    // PHP: !is_array($tiers) || empty($tiers)
    const isArrayLike = tiers !== null && typeof tiers === 'object';
    const isEmpty = !isArrayLike
      ? true
      : Array.isArray(tiers)
        ? tiers.length === 0
        : Object.keys(tiers).length === 0;
    if (!isArrayLike || isEmpty) {
      console.error(`Failed to parse Claude response for ${providerName}: ` + String(content).substring(0, 200));
      return null;
    }

    return tiers;
  }

  /**
   * Mirrors getAdminApiKey($provider). PHP first checks $this->config[strtoupper($provider).'_API_KEY']
   * — but the PHP config (ai_config.php) has NO such top-level key (keys are nested, e.g.
   * providers.claude.api_key), so that branch never fires; we go straight to the admin user's key.
   * Returns the RAW api_key column value (PHP does NOT decrypt here). If user_api_keys stores an
   * AES-encrypted key, PHP would send that ciphertext too — mirroring raw preserves identical behavior.
   */
  private async getAdminApiKey(provider: string): Promise<string | null> {
    try {
      // Then try from admin user's keys (user_id = 1 typically)
      const row = (
        await sql<any>`SELECT api_key FROM user_api_keys WHERE provider = ${provider} AND user_id = 1`.execute(db)
      ).rows[0];
      return row?.api_key ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Mirrors saveProviderCosts($category, $provider): upsert into provider_costs. tiers is the json
   * column — PHP json_encode()s it; we pass JSON.stringify(). notes falls back to null.
   */
  private async saveProviderCosts(category: string, provider: any): Promise<void> {
    await sql`
            INSERT INTO provider_costs (category, provider, display_name, tiers, pricing_url, notes, updated_at)
            VALUES (${category}, ${provider.provider}, ${provider.displayName}, ${JSON.stringify(provider.tiers)}, ${provider.pricingUrl}, ${provider.notes ?? null}, NOW())
            ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                tiers = VALUES(tiers),
                pricing_url = VALUES(pricing_url),
                notes = VALUES(notes),
                updated_at = NOW()
        `.execute(db);
  }

  /**
   * Mirrors fetchExchangeRatesFromApi(): tries exchangerate-api.com then frankfurter.app (10s each,
   * follow redirects, 'GPT-Admin/1.0' UA). Both expose a `rates` object, so the first `isset(rates)`
   * block always handles a 200 response (the second, identical PHP block is dead code and is omitted).
   * On total failure it returns the hardcoded defaults (never null).
   */
  private async fetchExchangeRatesFromApi(): Promise<Record<string, number> | null> {
    // Try multiple free exchange rate APIs
    const apis = [
      // exchangerate-api.com free tier
      'https://api.exchangerate-api.com/v4/latest/USD',
      // Alternative: frankfurter.app (European Central Bank data)
      'https://api.frankfurter.app/latest?from=USD&to=EUR,CAD',
    ];

    for (const apiUrl of apis) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        let response = '';
        let httpCode = 0;
        try {
          const res = await fetch(apiUrl, {
            redirect: 'follow',
            headers: { 'User-Agent': 'GPT-Admin/1.0' },
            signal: controller.signal,
          });
          httpCode = res.status;
          response = await res.text();
        } finally {
          clearTimeout(timer);
        }

        if (httpCode === 200 && response) {
          let data: any = null;
          try {
            data = JSON.parse(response);
          } catch {
            data = null;
          }

          // Handle exchangerate-api.com format (frankfurter.app also exposes `rates`, so it is caught here)
          if (data !== null && data !== undefined && data.rates !== undefined && data.rates !== null) {
            return {
              EUR: data.rates.EUR ?? 0.92,
              CAD: data.rates.CAD ?? 1.36,
            };
          }
        }
      } catch (e: any) {
        console.error(`Failed to fetch exchange rates from ${apiUrl}: ` + (e?.message ?? ''));
        continue;
      }
    }

    // Return default rates if all APIs fail
    return {
      EUR: 0.92,
      CAD: 1.36,
    };
  }

  /** Mirrors getDefaultCosts(): the hardcoded default pricing structure. */
  private getDefaultCosts(): any {
    return {
      llm: [
        {
          provider: 'claude',
          displayName: 'Claude (Anthropic)',
          category: 'llm',
          tiers: [
            { name: 'Claude 3.5 Sonnet', price: '$3.00', unit: '/ 1M input tokens', details: '$15.00 / 1M output tokens' },
            { name: 'Claude 3.5 Haiku', price: '$0.80', unit: '/ 1M input tokens', details: '$4.00 / 1M output tokens' },
            { name: 'Claude 3 Opus', price: '$15.00', unit: '/ 1M input tokens', details: '$75.00 / 1M output tokens' },
          ],
          pricingUrl: 'https://www.anthropic.com/pricing',
          lastUpdated: null,
        },
        {
          provider: 'openai',
          displayName: 'OpenAI',
          category: 'llm',
          tiers: [
            { name: 'GPT-4o', price: '$2.50', unit: '/ 1M input tokens', details: '$10.00 / 1M output tokens' },
            { name: 'GPT-4o mini', price: '$0.15', unit: '/ 1M input tokens', details: '$0.60 / 1M output tokens' },
            { name: 'GPT-4 Turbo', price: '$10.00', unit: '/ 1M input tokens', details: '$30.00 / 1M output tokens' },
          ],
          pricingUrl: 'https://openai.com/api/pricing',
          lastUpdated: null,
        },
        {
          provider: 'gemini',
          displayName: 'Gemini (Google)',
          category: 'llm',
          tiers: [
            { name: 'Gemini 1.5 Pro', price: '$1.25', unit: '/ 1M input tokens', details: '$5.00 / 1M output tokens' },
            { name: 'Gemini 1.5 Flash', price: '$0.075', unit: '/ 1M input tokens', details: '$0.30 / 1M output tokens' },
            { name: 'Gemini 2.0 Flash', price: '$0.10', unit: '/ 1M input tokens', details: '$0.40 / 1M output tokens' },
          ],
          pricingUrl: 'https://ai.google.dev/pricing',
          lastUpdated: null,
        },
        {
          provider: 'grok',
          displayName: 'Grok (xAI)',
          category: 'llm',
          tiers: [
            { name: 'Grok-2', price: '$2.00', unit: '/ 1M input tokens', details: '$10.00 / 1M output tokens' },
            { name: 'Grok-2 mini', price: '$0.20', unit: '/ 1M input tokens', details: '$1.00 / 1M output tokens' },
          ],
          pricingUrl: 'https://x.ai/api',
          lastUpdated: null,
        },
        {
          provider: 'deepseek',
          displayName: 'DeepSeek',
          category: 'llm',
          tiers: [
            { name: 'DeepSeek-V3', price: '$0.27', unit: '/ 1M input tokens', details: '$1.10 / 1M output tokens' },
            { name: 'DeepSeek-R1', price: '$0.55', unit: '/ 1M input tokens', details: '$2.19 / 1M output tokens' },
          ],
          pricingUrl: 'https://platform.deepseek.com/api-docs/pricing',
          lastUpdated: null,
        },
        {
          provider: 'kimi',
          displayName: 'Kimi (Moonshot)',
          category: 'llm',
          tiers: [
            { name: 'Moonshot-v1-8k', price: '$0.012', unit: '/ 1K tokens' },
            { name: 'Moonshot-v1-32k', price: '$0.024', unit: '/ 1K tokens' },
            { name: 'Moonshot-v1-128k', price: '$0.06', unit: '/ 1K tokens' },
          ],
          pricingUrl: 'https://platform.moonshot.cn/docs/pricing',
          lastUpdated: null,
        },
        {
          provider: 'gamma4',
          displayName: 'Gamma4',
          category: 'llm',
          tiers: [{ name: 'Gemma-4-E4B-it', price: '$0.00', unit: '/ 1M input tokens', details: 'Free' }],
          pricingUrl: null,
          lastUpdated: null,
        },
      ],
      voice: [
        {
          provider: 'elevenlabs',
          displayName: 'ElevenLabs',
          category: 'voice',
          tiers: [
            { name: 'Free', price: '$0', unit: '/ month', details: '10,000 characters/month' },
            { name: 'Starter', price: '$5', unit: '/ month', details: '30,000 characters/month' },
            { name: 'Creator', price: '$22', unit: '/ month', details: '100,000 characters/month' },
            { name: 'Pro', price: '$99', unit: '/ month', details: '500,000 characters/month' },
          ],
          pricingUrl: 'https://elevenlabs.io/pricing',
          lastUpdated: null,
        },
        {
          provider: 'hume',
          displayName: 'Hume AI',
          category: 'voice',
          tiers: [
            { name: 'EVI (Empathic Voice)', price: '$0.07', unit: '/ minute', details: 'Real-time voice with emotion' },
            { name: 'Expression Measurement', price: '$0.0036', unit: '/ API call' },
          ],
          pricingUrl: 'https://www.hume.ai/pricing',
          lastUpdated: null,
        },
        {
          provider: 'gemini',
          displayName: 'Gemini Live (Google)',
          category: 'voice',
          tiers: [
            { name: 'Gemini 2.0 Flash Live', price: '$0.35', unit: '/ 1M audio tokens input', details: '$8.75 / 1M audio tokens output' },
          ],
          pricingUrl: 'https://ai.google.dev/pricing',
          lastUpdated: null,
        },
        {
          provider: 'grok',
          displayName: 'Grok Voice (xAI)',
          category: 'voice',
          tiers: [
            { name: 'Grok Voice Agent API', price: '$0.05', unit: '/ minute', details: 'Real-time voice conversation' },
            { name: 'Tool Invocations', price: 'Additional', unit: 'per call', details: 'Web search, X search, function calls charged separately' },
          ],
          pricingUrl: 'https://docs.x.ai/developers/models',
          lastUpdated: null,
        },
      ],
      avatar: [
        {
          provider: 'did',
          displayName: 'D-ID',
          category: 'avatar',
          tiers: [
            { name: 'Free Trial', price: '$0', unit: '', details: '5 minutes of video' },
            { name: 'Lite', price: '$5.90', unit: '/ month', details: '10 minutes/month' },
            { name: 'Pro', price: '$49', unit: '/ month', details: '15 minutes/month' },
            { name: 'Advanced', price: '$299', unit: '/ month', details: '65 minutes/month' },
          ],
          pricingUrl: 'https://www.d-id.com/pricing',
          lastUpdated: null,
        },
        {
          provider: 'heygen',
          displayName: 'HeyGen',
          category: 'avatar',
          tiers: [
            { name: 'Free', price: '$0', unit: '', details: '1 credit (limited features)' },
            { name: 'Creator', price: '$24', unit: '/ month', details: '15 credits/month' },
            { name: 'Business', price: '$72', unit: '/ month', details: '30 credits/month' },
            { name: 'Enterprise', price: 'Custom', unit: '', details: 'Contact sales' },
          ],
          pricingUrl: 'https://www.heygen.com/pricing',
          lastUpdated: null,
        },
        {
          provider: 'tavus',
          displayName: 'Tavus',
          category: 'avatar',
          tiers: [
            { name: 'Starter', price: '$39', unit: '/ month', details: '30 minutes/month' },
            { name: 'Pro', price: '$149', unit: '/ month', details: '120 minutes/month' },
            { name: 'Enterprise', price: 'Custom', unit: '', details: 'Contact sales' },
          ],
          pricingUrl: 'https://www.tavus.io/pricing',
          lastUpdated: null,
        },
        {
          provider: 'anam',
          displayName: 'Anam AI',
          category: 'avatar',
          tiers: [
            { name: 'API Access', price: 'Contact', unit: 'for pricing', details: 'Real-time avatar streaming' },
          ],
          pricingUrl: 'https://www.anam.ai',
          lastUpdated: null,
        },
      ],
      lastRefreshed: null,
    };
  }
}
