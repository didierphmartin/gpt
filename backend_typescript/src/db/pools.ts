import { createPool } from 'mysql2';
import { Kysely, MysqlDialect } from 'kysely';
import { config, DbConfig } from '../config/env';
import { DB } from './types';

function makePool(c: DbConfig) {
  return createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    charset: 'utf8mb4_unicode_ci',
    // Return DATETIME/TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' strings (matches PHP's
    // date('Y-m-d H:i:s') output) instead of JS Date objects.
    dateStrings: true,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: false,
  });
}

// Main app DB pool (DB_*). Kept available for endpoints that need it later.
export const mainPool = makePool(config.database);

// Contexts DB pool (CTX_DB_*) — the connection PHP controllers operate on.
export const contextsPool = makePool(config.contextsDatabase);

// Typed query builder over the contexts DB (users, prompt_library live here).
export const db = new Kysely<DB>({
  dialect: new MysqlDialect({ pool: contextsPool }),
});
