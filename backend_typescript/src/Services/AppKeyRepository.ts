import crypto from 'crypto';
import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Mirrors src/AgentTeam/Services/AppKeyRepository.php.
 *
 * CRUD + verification for `app_keys` — long-lived, scoped credentials that
 * let client code call the backend without a user's login JWT.
 *
 * Storage model (see app_keys table):
 *   - key_prefix : first 12 chars of the key ("ak_xxxxxxxx"). Indexed, not
 *                  secret. Used for an O(log N) lookup.
 *   - key_hash   : hex HMAC-SHA256(server_secret, full_key). A DB leak does
 *                  not expose usable keys.
 *
 * The full key value is returned exactly once — by create() — and is never
 * recoverable afterwards.
 */
export class AppKeyRepository {
  private static readonly KEY_BYTES = 16; // 16 random bytes -> 32 hex chars
  private static readonly PREFIX_LEN = 12; // "ak_" + 9 hex chars

  private readonly serverSecret: string;

  constructor(serverSecret: string) {
    if (serverSecret === '') {
      // Fail loud: an empty pepper would make every hash trivially
      // forgeable by anyone who reads the table.
      throw new Error('AppKeyRepository: app_key_secret is not configured.');
    }
    this.serverSecret = serverSecret;
  }

  /**
   * Mint a new app key. Returns row data PLUS `full_key` — the only time the
   * raw key is visible.
   */
  async create(
    userId: number,
    applicationId: string,
    name: string,
    scopes: string[]
  ): Promise<Record<string, any>> {
    const fullKey = 'ak_' + crypto.randomBytes(AppKeyRepository.KEY_BYTES).toString('hex');
    const prefix = fullKey.slice(0, AppKeyRepository.PREFIX_LEN);
    const hash = this.hash(fullKey);

    const res = await sql`
      INSERT INTO app_keys (user_id, application_id, name, key_prefix, key_hash, scopes)
      VALUES (${userId}, ${applicationId}, ${name}, ${prefix}, ${hash}, ${JSON.stringify(scopes)})
    `.execute(db);
    const id = Number((res as any).insertId ?? 0);

    return {
      id,
      user_id: userId,
      application_id: applicationId,
      name,
      key_prefix: prefix,
      scopes: scopes,
      full_key: fullKey,
      created_at: formatSqlDateTime(new Date()),
    };
  }

  /**
   * Verify a presented key. Returns the key row (no hash) or null.
   * Flow: prefix lookup → constant-time hash compare → not-revoked check.
   */
  async findByKey(fullKey: string): Promise<Record<string, any> | null> {
    fullKey = fullKey.trim();
    if (!fullKey.startsWith('ak_') || fullKey.length < AppKeyRepository.PREFIX_LEN) {
      return null;
    }
    const prefix = fullKey.slice(0, AppKeyRepository.PREFIX_LEN);

    const row = (
      await sql<any>`
        SELECT id, user_id, application_id, name, key_prefix, key_hash, scopes,
               created_at, last_used_at, revoked_at
        FROM app_keys
        WHERE key_prefix = ${prefix} AND revoked_at IS NULL
        LIMIT 1
      `.execute(db)
    ).rows[0];
    if (!row) {
      return null;
    }

    if (!timingSafeEqualHex(String(row.key_hash), this.hash(fullKey))) {
      return null;
    }

    delete row.key_hash;
    row.scopes = this.decodeScopes(row.scopes);
    row.id = Number(row.id);
    row.user_id = Number(row.user_id);
    return row;
  }

  /**
   * Stamp last_used_at. Fire-and-forget — a failure here must never block
   * the request that the key just authorized.
   */
  async recordUse(keyId: number): Promise<void> {
    try {
      await sql`UPDATE app_keys SET last_used_at = NOW() WHERE id = ${keyId}`.execute(db);
    } catch (e: any) {
      console.error('[AppKeyRepository] recordUse failed: ' + (e?.message ?? ''));
    }
  }

  /**
   * Soft-delete a key (sets revoked_at). Returns true if a row was changed.
   * Admin-only at the controller layer, so no ownership filter here.
   */
  async revoke(keyId: number): Promise<boolean> {
    const res = await sql`
      UPDATE app_keys SET revoked_at = NOW() WHERE id = ${keyId} AND revoked_at IS NULL
    `.execute(db);
    return Number(res.numAffectedRows ?? 0) > 0;
  }

  /**
   * List keys (admin view). Optional filters. Never returns key_hash.
   */
  async listAll(
    applicationId: string | null = null,
    userId: number | null = null
  ): Promise<Record<string, any>[]> {
    const conds = [sql`1=1`];
    if (applicationId !== null) {
      conds.push(sql`application_id = ${applicationId}`);
    }
    if (userId !== null) {
      conds.push(sql`user_id = ${userId}`);
    }

    const rows = (
      await sql<any>`
        SELECT id, user_id, application_id, name, key_prefix, scopes,
               created_at, last_used_at, revoked_at
        FROM app_keys WHERE ${sql.join(conds, sql` AND `)}
        ORDER BY created_at DESC
      `.execute(db)
    ).rows;

    for (const row of rows) {
      row.id = Number(row.id);
      row.user_id = Number(row.user_id);
      row.scopes = this.decodeScopes(row.scopes);
    }
    return rows;
  }

  /**
   * Fetch one key's metadata by id (no hash). Used by revoke's 404 check.
   */
  async findById(keyId: number): Promise<Record<string, any> | null> {
    const row = (
      await sql<any>`
        SELECT id, user_id, application_id, name, key_prefix, scopes,
               created_at, last_used_at, revoked_at
        FROM app_keys WHERE id = ${keyId} LIMIT 1
      `.execute(db)
    ).rows[0];
    if (!row) {
      return null;
    }
    row.id = Number(row.id);
    row.user_id = Number(row.user_id);
    row.scopes = this.decodeScopes(row.scopes);
    return row;
  }

  private hash(fullKey: string): string {
    return crypto.createHmac('sha256', this.serverSecret).update(fullKey).digest('hex');
  }

  // Mirrors PHP decodeScopes: array passes through; a JSON string is decoded;
  // anything non-array-decoding → []. mysql2 may auto-parse the json column into
  // an array already (see project_mysql2_json_autoparse), so handle both.
  private decodeScopes(raw: any): any[] {
    if (Array.isArray(raw)) {
      return raw;
    }
    try {
      const decoded = JSON.parse(String(raw));
      return Array.isArray(decoded) ? decoded : [];
    } catch {
      return [];
    }
  }
}

/** Constant-time compare of two hex strings (mirrors PHP hash_equals). */
function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Format a Date as 'Y-m-d H:i:s' (mirrors PHP date('Y-m-d H:i:s')). */
function formatSqlDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
