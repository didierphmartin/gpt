/**
 * PHP's json_encode / json_decode($s, true) round trip, for values that PHP stores or answers after
 * decoding JSON into arrays. PHP has one array type, so a decoded `{}` re-encodes as `[]` and an
 * object whose keys are 0..n-1 re-encodes as a list; phpJsonDecodeAssoc reproduces that shape so a
 * JSON response built from it matches PHP's, and phpJsonEncode writes PHP's default-flag bytes
 * (escaped slashes, \uXXXX for non-ASCII).
 *
 * Not reproduced: PHP keeps the int/float distinction (1.0 encodes as "1.0"); a JS number cannot.
 */

/** PHP json_encode default flags escape '/' as '\/' and non-ASCII as \uXXXX (UTF-16 units). */
export function phpJsonEscape(s: string): string {
  return s
    .replace(/\//g, '\\/')
    .replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Keys 0..n-1 in order: PHP encodes such an array as a JSON list. */
function isListKeys(keys: string[]): boolean {
  return keys.every((k, i) => k === String(i));
}

/** The PHP-array view of a decoded JSON value (see the file comment). */
export function phpArrayShape(v: any): any {
  if (Array.isArray(v)) return v.map(phpArrayShape);
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (isListKeys(keys)) return keys.map((k) => phpArrayShape(v[k]));
    const out: Record<string, any> = {};
    for (const k of keys) out[k] = phpArrayShape(v[k]);
    return out;
  }
  return v;
}

/**
 * json_decode($s, true): null for '' / invalid JSON. A value the MySQL driver already parsed
 * (a JSON column) is taken as decoded.
 */
export function phpJsonDecodeAssoc(s: unknown): any {
  if (s === null || s === undefined) return null;
  if (typeof s === 'object') return phpArrayShape(s);
  const str = typeof s === 'string' ? s : String(s);
  if (str === '') return null;
  try {
    return phpArrayShape(JSON.parse(str));
  } catch {
    return null;
  }
}

/**
 * A keyed PHP array built in a response (provider => value): json_encode writes an EMPTY one as `[]`, not
 * `{}`. Only the top level is reshaped; the values are the caller's.
 */
export function phpAssoc<T>(m: Record<string, T>): Record<string, T> | [] {
  return Object.keys(m).length === 0 ? [] : m;
}

/** PHP is_array() of a decoded/request value: a list or an object. */
export function isPhpArray(v: unknown): v is Record<string, any> | any[] {
  return v !== null && typeof v === 'object';
}

/** json_encode($v) with PHP's default flags. */
export function phpJsonEncode(v: any): string {
  return phpJsonEscape(JSON.stringify(phpArrayShape(v === undefined ? null : v)));
}
