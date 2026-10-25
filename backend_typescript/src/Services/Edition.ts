import { config } from '../config/env';

/** The part of the config the edition is read from (PHP: $config['edition']). */
export type EditionConfig = { edition?: string | null };

/**
 * Mirrors src/Services/Edition.php: which edition this backend runs as,
 * 'individual', 'corporate', or '' (hosted). Set from GPT_EDITION (config/env.ts),
 * which the compose files choose. Callers pass the config; production passes the real one.
 */
export class Edition {
  static current(cfg: EditionConfig = config): string {
    return String(cfg.edition ?? '');
  }

  static isCorporate(cfg: EditionConfig = config): boolean {
    return Edition.current(cfg) === 'corporate';
  }

  /**
   * On a corporate install every session comes from the login service via sso_exchange; gpt's own
   * credential paths (password login, register, Firebase, WebAuthn) must not issue one.
   */
  static refuseLocalSignIn(cfg: EditionConfig = config): { success: false; message: string; status_code: 403 } | null {
    if (!Edition.isCorporate(cfg)) return null;
    return { success: false, message: 'This installation signs in through its login service.', status_code: 403 };
  }
}
