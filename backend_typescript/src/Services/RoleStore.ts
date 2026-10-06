import { sql } from 'kysely';
import { db } from '../db/pools';

/** A refused role operation: kind (invalid_key, invalid_name, exists, not_found, builtin, in_use) and its HTTP status. */
export class RoleStoreError extends Error {
  constructor(public readonly kind: string, message: string, public readonly status: number) {
    super(message);
  }
}

export type Role = { role: string; name: string; builtin: boolean; capabilities: Record<string, any>; used_by: number };

const BUILTIN = ['guest', 'prospect', 'user', 'admin', 'robot'];
const KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEY_MAX = 64;
const NAME_MAX = 100;

/** PHP ucfirst. */
function ucfirst(s: string): string {
  return s === '' ? s : s[0].toUpperCase() + s.slice(1);
}

/** The capabilities column: mysql2 returns the `json` column parsed; a string is decoded. Not an object → {}. */
function decodeCapabilities(v: any): Record<string, any> {
  let c = v;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch { c = null; }
  }
  return c !== null && typeof c === 'object' ? c : {};
}

/** A packages row as the API shows it (PHP RoleStore::shape). */
export function shapeRole(r: { role: any; name: any; builtin: any; capabilities: any }, usedBy: number): Role {
  const key = String(r.role);
  const name = String(r.name ?? '').trim();
  return {
    role: key,
    name: name !== '' ? name : ucfirst(key),
    builtin: Boolean(Number(r.builtin ?? 0)) || BUILTIN.includes(key),
    capabilities: decodeCapabilities(r.capabilities),
    used_by: usedBy,
  };
}

/** Built-ins first in BUILTIN order, then rows flagged built-in, then by name, then by key (PHP RoleStore::list usort). */
export function sortRoles(rows: Role[]): Role[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows].sort((a, b) => {
    const ia = BUILTIN.indexOf(a.role);
    const ib = BUILTIN.indexOf(b.role);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return cmp(a.name, b.name) || cmp(a.role, b.role);
  });
}

/** Trimmed display name; empty or longer than 100 characters → invalid_name 422. */
export function cleanRoleName(name: string): string {
  const n = name.trim();
  if (n === '' || [...n].length > NAME_MAX) {
    throw new RoleStoreError('invalid_name', `Role name is required (at most ${NAME_MAX} characters)`, 422);
  }
  return n;
}

/**
 * Mirrors src/Services/RoleStore.php. The roles of an installation: one `packages` row per role
 * (key, display name, capabilities). Built-in roles cannot be deleted; custom roles can while no
 * person holds them.
 */
export class RoleStore {
  static readonly BUILTIN = BUILTIN;
  static readonly KEY_MAX = KEY_MAX;
  static readonly NAME_MAX = NAME_MAX;

  static isValidKey(key: string): boolean {
    return key.length <= KEY_MAX && KEY_RE.test(key);
  }

  /** Every role, built-ins first. A built-in role with no row yet (fresh install) is still a role, with no capabilities. */
  async list(): Promise<Role[]> {
    const rows = (await sql<any>`SELECT role, name, builtin, capabilities FROM packages`.execute(db)).rows;
    const have = rows.map((r) => String(r.role));
    for (const key of BUILTIN) {
      if (!have.includes(key)) rows.push({ role: key, name: null, builtin: 1, capabilities: '{}' });
    }
    const out: Role[] = [];
    for (const r of rows) out.push(shapeRole(r, (await this.usersWith(String(r.role))).length));
    return sortRoles(out);
  }

  async get(key: string): Promise<Role | null> {
    let row: any = (await sql<any>`SELECT role, name, builtin, capabilities FROM packages WHERE role = ${key}`.execute(db)).rows[0];
    if (!row && BUILTIN.includes(key)) row = { role: key, name: null, builtin: 1, capabilities: '{}' };
    return row ? shapeRole(row, (await this.usersWith(String(row.role))).length) : null;
  }

  /** A role exists when it has a row, or is built-in (a fresh install has no rows yet). */
  async exists(key: string): Promise<boolean> {
    return BUILTIN.includes(key) || (await this.hasRow(key));
  }

  private async hasRow(key: string): Promise<boolean> {
    return (await sql<any>`SELECT 1 AS one FROM packages WHERE role = ${key}`.execute(db)).rows.length > 0;
  }

  async create(key: string, name: string, copyFrom: string | null): Promise<Role> {
    if (!RoleStore.isValidKey(key)) {
      throw new RoleStoreError('invalid_key',
        `Role key: lowercase letters and digits, words separated by single dashes, at most ${KEY_MAX} characters`, 422);
    }
    name = cleanRoleName(name);
    if (await this.exists(key)) throw new RoleStoreError('exists', `Role '${key}' already exists`, 409);
    let caps = '{"providers":{},"sidebar":{}}';
    if (copyFrom !== null && copyFrom !== '') {
      const src = await this.get(copyFrom);
      if (src === null) throw new RoleStoreError('not_found', `Role '${copyFrom}' not found`, 404);
      caps = JSON.stringify(src.capabilities);
    }
    await sql`INSERT INTO packages (role, name, builtin, capabilities) VALUES (${key}, ${name}, 0, ${caps})`.execute(db);
    return (await this.get(key))!;
  }

  async rename(key: string, name: string): Promise<Role> {
    name = cleanRoleName(name);
    if (!(await this.exists(key))) throw new RoleStoreError('not_found', `Role '${key}' not found`, 404);
    if (await this.hasRow(key)) {
      await sql`UPDATE packages SET name = ${name} WHERE role = ${key}`.execute(db);
    } else {
      await sql`INSERT INTO packages (role, name, builtin, capabilities) VALUES (${key}, ${name}, 1, ${'{}'})`.execute(db);
    }
    return (await this.get(key))!;
  }

  async delete(key: string): Promise<void> {
    const row = await this.get(key);
    if (row === null) throw new RoleStoreError('not_found', `Role '${key}' not found`, 404);
    if (row.builtin || BUILTIN.includes(key)) throw new RoleStoreError('builtin', "Built-in roles can't be deleted", 409);
    const holders = await this.usersWith(key);
    if (holders.length) {
      throw new RoleStoreError('in_use', `Role '${key}' is held by: ${holders.map((h) => h.email).join(', ')}`, 409);
    }
    await sql`DELETE FROM packages WHERE role = ${key}`.execute(db);
  }

  /** The people (not the robot) holding the role. */
  async usersWith(key: string): Promise<{ id: number; email: string }[]> {
    const rows = (await sql<any>`SELECT id, email FROM users WHERE role = ${key} AND kind = 'person' ORDER BY id`.execute(db)).rows;
    return rows.map((r) => ({ id: Number(r.id), email: String(r.email) }));
  }
}
