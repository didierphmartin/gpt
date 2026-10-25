import { config, DbConfig } from '../config/env';
import { SqlConn, connectSql } from './LoginDb';

/** PHP strtolower(trim($email)) — trim's default mask. */
function normaliseEmail(email: string): string {
  return email.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '').toLowerCase();
}

/**
 * Mirrors src/Services/LoginAccounts.php. The login service's users table, written directly by gpt
 * on a corporate install: gpt_admin creates every account, so gpt must create the login row (the
 * credential) alongside its own row (the role). Emails are lowercased.
 */
export class LoginAccounts {
  constructor(private readonly db: SqlConn) {}

  /** Null when config['login_db'] names no database or user; throws when it is unreachable. */
  static async fromConfig(cfg: { loginDb?: DbConfig } = config): Promise<LoginAccounts | null> {
    const ld = cfg.loginDb;
    if (!ld || !ld.database || !ld.user) return null;
    return new LoginAccounts(await connectSql(ld));
  }

  /**
   * Create the account, or — when a row already exists (a setup retried after a partial failure) —
   * overwrite its password and mark it verified. gpt's sso_exchange refuses unverified accounts.
   */
  async upsertVerified(email: string, passwordHash: string, firstName: string, lastName: string): Promise<void> {
    email = normaliseEmail(email);
    const rows = await this.db.select('SELECT id FROM users WHERE email = ?', [email]);
    if (rows.length > 0) {
      await this.db.execute(
        'UPDATE users SET password = ?, first_name = ?, last_name = ?, email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE email = ?',
        [passwordHash, firstName, lastName, email],
      );
      return;
    }
    await this.db.execute(
      "INSERT INTO users (email, password, first_name, last_name, provider, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, 'email', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
      [email, passwordHash, firstName, lastName],
    );
  }

  async exists(email: string): Promise<boolean> {
    return (await this.db.select('SELECT 1 FROM users WHERE email = ?', [normaliseEmail(email)])).length > 0;
  }

  async setPassword(email: string, passwordHash: string): Promise<void> {
    await this.db.execute('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?', [
      passwordHash,
      normaliseEmail(email),
    ]);
  }

  async delete(email: string): Promise<void> {
    await this.db.execute('DELETE FROM users WHERE email = ?', [normaliseEmail(email)]);
  }
}
