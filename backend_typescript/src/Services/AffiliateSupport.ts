import crypto from 'crypto';

/**
 * Mirrors src/Services/AffiliateSupport.php — pure helpers for affiliate keys
 * and link construction. No DB access.
 */

// PHP trim() default character mask (" \t\n\r\0\x0B").
function phpTrim(v: any): string {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  return s.replace(/^[ \t\n\r\0\x0B]+/, '').replace(/[ \t\n\r\0\x0B]+$/, '');
}

// PHP rawurlencode(): RFC 3986. encodeURIComponent leaves !'()* unescaped and ~
// unescaped; rawurlencode escapes !'()* but leaves -_.~ . So escape the extra set.
function rawurlencode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

export class AffiliateSupport {
  private static readonly KEY_LENGTH = 16;
  private static readonly ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  /** Generate a URL-safe random affiliate key. Uniqueness vs. the DB is the caller's job. */
  static generateKey(): string {
    const max = AffiliateSupport.ALPHABET.length - 1;
    let out = '';
    for (let i = 0; i < AffiliateSupport.KEY_LENGTH; i++) {
      // PHP random_int(0, $max) is inclusive; crypto.randomInt(0, max + 1) is [0, max].
      out += AffiliateSupport.ALPHABET[crypto.randomInt(0, max + 1)];
    }
    return out;
  }

  /** Append ?ref=KEY (or &ref=KEY) to a sales-page URL. */
  static buildLink(salesPageUrl: string, key: string): string {
    const url = phpTrim(salesPageUrl);
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'ref=' + rawurlencode(key);
  }
}
