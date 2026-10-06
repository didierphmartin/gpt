import { config } from '../config/env';

/** The part of the config the edition is read from (PHP: $config['edition']). */
export type EditionConfig = { edition?: string | null };

/**
 * Mirrors src/Services/Edition.php (minimal): which edition this backend runs as,
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
}
