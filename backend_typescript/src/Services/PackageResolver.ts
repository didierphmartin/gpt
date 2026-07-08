import { sql } from 'kysely';
import { db } from '../db/pools';

/**
 * Mirrors src/Services/PackageResolver.php.
 *
 * Resolves the effective capability package for a user by role. Packages are edited by admins in
 * gpt_admin and read by gpt at request time. Only the read path used by /api/v1/me/package is
 * ported here (resolveRole / loadPackage / resolveForUser); the admin CRUD helpers are out of scope.
 *
 * Faithful divergence notes:
 *  - The `capabilities` column is MySQL `json`; mysql2 returns it ALREADY parsed (object), so unlike
 *    PHP (which json_decode's a string) we use the value as-is. If it somehow isn't an object we fall
 *    back to {} — matching PHP's `is_array($decoded) ? $decoded : []`.
 */
export interface ResolvedPackage {
  role: string;
  capabilities: Record<string, any>;
  updated_at: any;
}

export class PackageResolver {
  static readonly VALID_ROLES = ['guest', 'prospect', 'user', 'admin'];

  private cache: Record<string, ResolvedPackage> = {};

  static validRoles(): string[] {
    return PackageResolver.VALID_ROLES;
  }

  /** Resolve the effective package for the given user. null → guest package. */
  async resolveForUser(userId: number | null): Promise<ResolvedPackage> {
    const role = await this.resolveRole(userId);
    return this.loadPackage(role);
  }

  /** Look up just the role. Returns 'guest' when the id is null or the user no longer exists. */
  async resolveRole(userId: number | null): Promise<string> {
    if (userId === null) {
      return 'guest';
    }

    const row = (
      await sql<{ role: string | null }>`SELECT role FROM users WHERE id = ${userId} LIMIT 1`.execute(db)
    ).rows[0];

    if (!row || !PackageResolver.VALID_ROLES.includes(row.role as string)) {
      return 'guest';
    }

    return String(row.role);
  }

  /** Load + decode the capabilities row for a role. Cached per-instance. */
  async loadPackage(role: string): Promise<ResolvedPackage> {
    if (!PackageResolver.VALID_ROLES.includes(role)) {
      role = 'guest';
    }

    if (this.cache[role] !== undefined) {
      return this.cache[role];
    }

    const row = (
      await sql<{ capabilities: any; updated_at: any }>`SELECT capabilities, updated_at FROM packages WHERE role = ${role} LIMIT 1`.execute(db)
    ).rows[0];

    let capabilities: Record<string, any>;
    let updatedAt: any;

    if (!row) {
      // Seed row missing; fall through to an empty-but-valid shape so callers don't crash.
      capabilities = {
        providers: [],
        mcp_servers: null,
        skills: null,
        sidebar: [],
        quota_tokens: null,
        voice: false,
        avatar: false,
      };
      updatedAt = null;
    } else {
      // mysql2 already parsed the `json` column into an object — use as-is.
      const decoded = row.capabilities;
      capabilities = decoded !== null && typeof decoded === 'object' ? decoded : {};
      updatedAt = row.updated_at;
    }

    const pkg: ResolvedPackage = { role, capabilities, updated_at: updatedAt };
    this.cache[role] = pkg;
    return pkg;
  }

  /**
   * The MCP server names the user's package allows, or null when unrestricted
   * (capabilities.mcp_servers === null). Callers treat null = "allow everything", [] = "allow nothing".
   * Mirrors PackageResolver::allowedMcpServers.
   */
  async allowedMcpServers(userId: number | null): Promise<string[] | null> {
    const pkg = await this.resolveForUser(userId);
    const list = pkg.capabilities?.mcp_servers ?? null;
    if (list === null) return null;
    if (!Array.isArray(list)) return [];
    return list.filter((s: any) => typeof s === 'string');
  }
}
