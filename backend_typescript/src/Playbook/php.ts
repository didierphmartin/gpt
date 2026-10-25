/**
 * The handful of PHP built-ins the playbook port leans on, with PHP's semantics.
 */

/** PHP trim(): strips " \t\n\r\0\x0B" only (JS trim() also strips Unicode spaces). */
export function phpTrim(s: string): string {
  return s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

/** PHP (string) cast of a scalar/null. */
export function phpStr(v: any): string {
  if (v === null || v === undefined || v === false) return '';
  if (v === true) return '1';
  return String(v);
}

/** PHP (bool) cast. */
export function phpBool(v: any): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || v === '0') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** PHP empty(). */
export function phpEmpty(v: any): boolean {
  if (!phpBool(v)) return true;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).length === 0;
  return false;
}

/** PHP (array) cast: null -> [], a scalar -> [scalar], arrays/objects unchanged. */
export function phpArray(v: any): any {
  if (v === null || v === undefined) return [];
  if (typeof v === 'object') return v;
  return [v];
}

/** An associative PHP array (a non-list object). */
export function isAssoc(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE). */
export function phpJson(v: any): string {
  return JSON.stringify(v === undefined ? null : v);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** date('Y-m-d H:i:s') in server-local time. */
export function sqlNow(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** date('c'): ISO 8601 with the local UTC offset. */
export function isoNow(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** uniqid($prefix): 13 hex characters derived from the current time in microseconds. */
export function uniqid(prefix = ''): string {
  const us = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const sec = us / 1000000n;
  const usec = us % 1000000n;
  return prefix + sec.toString(16).padStart(8, '0') + usec.toString(16).padStart(5, '0');
}

/** mb_strlen / mb_substr on code points. */
export function mbLen(s: string): number {
  return Array.from(s).length;
}
export function mbSub(s: string, start: number, len: number): string {
  return Array.from(s).slice(start, start + len).join('');
}
