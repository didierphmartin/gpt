import { isIPv6 } from 'node:net';

/**
 * filter_var($url, FILTER_VALIDATE_URL) — twin of backend_python's phpcompat.filter_validate_url.
 *
 * ext/filter: php_filter_url() first strips every byte outside RFC 1738 §5 and fails when that
 * changed the length; php_url_parse_ex() must then yield a scheme, and http/https additionally
 * require a host whose bytes are `isalnum() || '-' || '.'` with an alphanumeric first byte (or a
 * bracketed IPv6 literal). `_`/`~` in a host and a schemeless "example.com" are rejected, a trailing
 * dot and a userinfo prefix are accepted.
 */
const URL_ALLOWED = new Set(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' + '$-_.+!*\'(),{}|\\^~[]`<>#%";/?:@&=',
);
const URL_SCHEME_RE = /^([A-Za-z0-9+.\-]*):/;
// php_filter_validate_url() exempts only these three from the host requirement, case-sensitively.
const URL_HOSTLESS_SCHEMES = ['mailto', 'news', 'file'];

const isAsciiAlnum = (ch: string) => /^[0-9A-Za-z]$/.test(ch);

export function filterValidateUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  for (const ch of value) if (!URL_ALLOWED.has(ch)) return false; // php_filter_url() stripped a byte
  const m = URL_SCHEME_RE.exec(value);
  if (m === null || m[1] === '') return false; // no scheme
  const scheme = m[1];
  const rest = value.slice(m[0].length);
  let host = '';
  if (rest.startsWith('//')) {
    const authority = rest.slice(2).split('/', 1)[0].split('?', 1)[0].split('#', 1)[0];
    host = authority.slice(authority.lastIndexOf('@') + 1);
    if (host.startsWith('[') && host.includes(']')) host = host.slice(0, host.indexOf(']') + 1);
    else host = host.split(':', 1)[0];
  }
  if (['http', 'https'].includes(scheme.toLowerCase())) {
    if (host === '') return false;
    if (host.startsWith('[') && host.endsWith(']')) return isIPv6(host.slice(1, -1));
    if (!isAsciiAlnum(host[0])) return false;
    for (const ch of host) if (!isAsciiAlnum(ch) && ch !== '-' && ch !== '.') return false;
    return true;
  }
  if (host === '' && !URL_HOSTLESS_SCHEMES.includes(scheme)) return false;
  return true;
}
