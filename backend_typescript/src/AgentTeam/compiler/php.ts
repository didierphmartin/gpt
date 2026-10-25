/**
 * The PHP runtime semantics the compiler ports rely on, so the TypeScript emitters produce the
 * same bytes as backend/src/AgentTeam/Services/*.php.
 *
 * Representation of PHP values:
 *  - a PHP list                          -> a JS array
 *  - a PHP array keyed by data (ids, urls, names: insertion order matters, keys may look numeric)
 *                                        -> oarr(): an insertion-ordered object (a Proxy over a Map),
 *                                           read and written with plain `x[k]` syntax
 *  - a PHP array used as a record (fixed string keys) -> a plain object
 *  - a PHP stdClass / `(object)` cast    -> an object tagged with stdObj() (always a JSON object)
 *  - a PHP float that must print as one (1.0, not 1) -> PhpFloat (only where PHP json_encodes it)
 *
 * json_encode treats an oarr/plain object as a PHP array: empty -> [], keys 0..n-1 in order -> a list.
 */

const ORDERED = Symbol('phpOrdered');
const STD = Symbol('phpStdClass');

/** An insertion-ordered PHP array (keys are strings; "2" stays where it was inserted). */
export function oarr<T = any>(init?: Iterable<[string | number, T]> | Record<string, T> | null): Record<string, T> {
  const m = new Map<string, T>();
  if (init) {
    if (isIterable(init)) {
      for (const [k, v] of init as Iterable<[string | number, T]>) m.set(String(k), v);
    } else {
      for (const k of keysOf(init)) m.set(k, (init as any)[k]);
    }
  }
  let stdTag = false;   // stdObj() on an oarr (jsonDecodeStd / jsonDecodePhp's `{}`)
  return new Proxy({} as Record<string, T>, {
    get(_t, k) {
      if (k === ORDERED) return m;
      if (k === STD) return stdTag || undefined;
      if (typeof k === 'symbol') return undefined;
      return m.get(k);
    },
    set(_t, k, v) {
      if (typeof k === 'symbol') return false;
      m.set(k, v);
      return true;
    },
    has(_t, k) {
      if (k === ORDERED) return true;
      return typeof k === 'string' && m.has(k);
    },
    deleteProperty(_t, k) {
      if (typeof k === 'string') m.delete(k);
      return true;
    },
    ownKeys() {
      return [...m.keys()];
    },
    getOwnPropertyDescriptor(_t, k) {
      if (typeof k === 'string' && m.has(k)) {
        return { value: m.get(k), enumerable: true, configurable: true, writable: true };
      }
      return undefined;
    },
    defineProperty(_t, k, d) {
      if (k === STD) {
        stdTag = d.value === true;
        return true;
      }
      if (typeof k === 'symbol') return false;
      m.set(k, d.value);
      return true;
    },
  });
}

function isIterable(x: any): boolean {
  return x !== null && typeof x === 'object' && typeof x[Symbol.iterator] === 'function';
}

export function isOrdered(x: any): boolean {
  return x !== null && typeof x === 'object' && (x as any)[ORDERED] instanceof Map;
}

/** Tag an object as a PHP stdClass (json_encode always writes an object, even when empty). */
export function stdObj<T extends object>(o: T): T {
  Object.defineProperty(o, STD, { value: true, enumerable: false });
  return o;
}

export function isStd(x: any): boolean {
  return x !== null && typeof x === 'object' && (x as any)[STD] === true;
}

/** PHP `(object) $array`: a stdClass with the array's keys (a list's keys become "0", "1", ...). */
export function toObject(v: any): any {
  if (isStd(v)) return v;
  return stdObj(oarr(entries(v)));
}

/** (array) cast: a stdClass's fields as an ordered array; a scalar as [scalar]; null as []. */
export function toArr(v: any): any {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && !(v instanceof PhpFloat)) return oarr(entries(v));
  return [v];
}

/** json_decode($s) (objects as stdClass, key order kept). Returns null on invalid JSON. */
export function jsonDecodeStd(s: string): any {
  try {
    return reorderParse(s, true);
  } catch {
    return null;
  }
}

/** json_decode($s, true): objects as ordered PHP arrays. Returns null on invalid JSON. */
export function jsonDecodeAssoc(s: string): any {
  try {
    return reorderParse(s, false);
  } catch {
    return null;
  }
}

/**
 * A PHP value read back from its json_encode text: objects as ordered PHP arrays, except `{}`, which only
 * a stdClass (or (object) cast) encodes to, so it comes back as an empty stdClass.
 */
export function jsonDecodePhp(s: string): any {
  return reorderParse(s, 'php');
}

/** JSON.parse keeping each object's key order as written (numeric-looking keys included). */
function reorderParse(s: string, std: boolean | 'php'): any {
  let i = 0;
  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
  };
  const val = (): any => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const entries: Array<[string, any]> = [];
      ws();
      if (s[i] === '}') {
        i++;
      } else {
        for (;;) {
          ws();
          const k = str();
          ws();
          if (s[i] !== ':') throw new Error('bad json');
          i++;
          const v = val();
          const at = entries.findIndex((e) => e[0] === k);
          if (at >= 0) entries[at][1] = v;
          else entries.push([k, v]);
          ws();
          if (s[i] === ',') {
            i++;
            continue;
          }
          if (s[i] === '}') {
            i++;
            break;
          }
          throw new Error('bad json');
        }
      }
      const o = oarr(entries);
      return std === true || (std === 'php' && entries.length === 0) ? stdObj(o) : o;
    }
    if (c === '[') {
      i++;
      const out: any[] = [];
      ws();
      if (s[i] === ']') {
        i++;
        return out;
      }
      for (;;) {
        out.push(val());
        ws();
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === ']') {
          i++;
          return out;
        }
        throw new Error('bad json');
      }
    }
    if (c === '"') return str();
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i));
    if (!m) throw new Error('bad json');
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    if (m[0] === 'null') return null;
    const n = Number(m[0]);
    return /[.eE]/.test(m[0]) ? new PhpFloat(n) : n;
  };
  const str = (): string => {
    if (s[i] !== '"') throw new Error('bad json');
    const start = i;
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') i++;
      i++;
    }
    i++;
    return JSON.parse(s.slice(start, i));
  };
  const v = val();
  ws();
  if (i !== s.length) throw new Error('bad json');
  return v;
}

/** A PHP float: json_encode / var_export write 1.0 (not 1); string conversion writes 1. */
export class PhpFloat {
  constructor(public readonly v: number) {}
  valueOf(): number {
    return this.v;
  }
  toString(): string {
    return phpFloatToString(this.v);
  }
  toJSON(): number {
    return this.v;
  }
}

export function F(x: any): PhpFloat {
  return new PhpFloat(floatval(x));
}

export function num(x: any): number {
  return x instanceof PhpFloat ? x.v : Number(x);
}

/** (string) of a float under precision=14. */
export function phpFloatToString(v: number): string {
  if (!isFinite(v)) return v > 0 ? 'INF' : v < 0 ? '-INF' : 'NAN';
  if (v === Math.trunc(v) && Math.abs(v) < 1e15) return String(v) === '-0' ? '-0' : String(v);
  const p = Number(v.toPrecision(14));
  let s = String(p);
  if (/e/.test(s)) {
    const [m, e] = s.split('e');
    const exp = Number(e);
    s = m + 'E' + (exp < 0 ? '-' : '+') + Math.abs(exp);
  }
  return s;
}

/** json_encode / var_export float text under serialize_precision=-1. */
export function phpFloatRepr(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return (Object.is(v, -0) ? '-0' : String(v)) + '.0';
  let s = String(v);
  if (/e/.test(s)) {
    const [m, e] = s.split('e');
    const exp = Number(e);
    s = (m.includes('.') ? m : m + '.0') + 'e' + (exp < 0 ? '-' : '+') + Math.abs(exp);
  }
  return s;
}

// ---------------------------------------------------------------- iteration

/** The keys of a PHP array value in PHP order. */
export function keysOf(x: any): string[] {
  if (x === null || x === undefined) return [];
  if (Array.isArray(x)) return x.map((_, i) => String(i));
  if (x instanceof Map) return [...x.keys()].map(String);
  if (typeof x === 'object') return Object.keys(x);
  return [];
}

/** foreach ($x as $k => $v) */
export function entries<T = any>(x: any): Array<[string, T]> {
  if (x === null || x === undefined) return [];
  if (Array.isArray(x)) return x.map((v, i) => [String(i), v]);
  if (x instanceof Map) return [...x.entries()].map(([k, v]) => [String(k), v]);
  if (typeof x === 'object') return Object.keys(x).map((k) => [k, x[k]]);
  return [];
}

/** foreach ($x as $v) */
export function values<T = any>(x: any): T[] {
  if (x === null || x === undefined) return [];
  if (Array.isArray(x)) return x;
  if (x instanceof Map) return [...x.values()];
  if (typeof x === 'object') return Object.keys(x).map((k) => x[k]);
  return [];
}

export const array_values = values;

export function array_keys(x: any): string[] {
  return keysOf(x);
}

export function count(x: any): number {
  if (x === null || x === undefined) return 0;
  if (Array.isArray(x)) return x.length;
  if (x instanceof Map) return x.size;
  if (typeof x === 'object') return Object.keys(x).length;
  return 1;
}

export function is_array(x: any): boolean {
  return Array.isArray(x) || (x !== null && typeof x === 'object' && !isStd(x) && !(x instanceof PhpFloat) && !Buffer.isBuffer(x));
}

export function is_string(x: any): x is string {
  return typeof x === 'string';
}

export function is_numeric(x: any): boolean {
  if (typeof x === 'number') return isFinite(x);
  if (x instanceof PhpFloat) return true;
  if (typeof x !== 'string') return false;
  return /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(x);
}

/** PHP empty() */
export function empty(x: any): boolean {
  if (x === null || x === undefined || x === false || x === '' || x === '0' || x === 0) return true;
  if (x instanceof PhpFloat) return x.v === 0;
  if (Array.isArray(x)) return x.length === 0;
  if (x !== null && typeof x === 'object' && !isStd(x)) return count(x) === 0;
  return false;
}

/** PHP truthiness (if ($x)) */
export function truthy(x: any): boolean {
  if (x instanceof PhpFloat) return x.v !== 0;
  if (x !== null && typeof x === 'object' && !isStd(x) && !Buffer.isBuffer(x)) return count(x) > 0;
  if (typeof x === 'string') return x !== '' && x !== '0';
  return !!x;
}

/** $a === [] for any PHP array value. */
export function isEmptyArr(x: any): boolean {
  return count(x) === 0;
}

/** PHP array_is_list-like check used by json_encode. */
function isPhpList(keys: string[]): boolean {
  for (let i = 0; i < keys.length; i++) if (keys[i] !== String(i)) return false;
  return true;
}

// ---------------------------------------------------------------- casts

export function strval(x: any): string {
  if (x === null || x === undefined || x === false) return '';
  if (x === true) return '1';
  if (x instanceof PhpFloat) return phpFloatToString(x.v);
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : phpFloatToString(x);
  if (Array.isArray(x) || (typeof x === 'object' && x !== null)) return 'Array';
  return String(x);
}

export function intval(x: any): number {
  if (x === null || x === undefined || x === false) return 0;
  if (x === true) return 1;
  if (x instanceof PhpFloat) return Math.trunc(x.v);
  if (typeof x === 'number') return Math.trunc(x);
  if (typeof x === 'string') {
    const m = /^[ \t\n\r\v\f]*([+-]?\d+(\.\d*)?([eE][+-]?\d+)?)/.exec(x);
    if (!m) return 0;
    return Math.trunc(Number(m[1]));
  }
  if (Array.isArray(x)) return x.length ? 1 : 0;
  return 1;
}

export function floatval(x: any): number {
  if (x === null || x === undefined || x === false) return 0;
  if (x === true) return 1;
  if (x instanceof PhpFloat) return x.v;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    const m = /^[ \t\n\r\v\f]*([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?)/.exec(x);
    return m ? Number(m[1]) : 0;
  }
  return 1;
}

// ---------------------------------------------------------------- json

export const JSON_HEX_TAG = 1;
export const JSON_HEX_AMP = 2;
export const JSON_HEX_APOS = 4;
export const JSON_HEX_QUOT = 8;
export const JSON_FORCE_OBJECT = 16;
export const JSON_PRETTY_PRINT = 128;
export const JSON_UNESCAPED_SLASHES = 64;
export const JSON_UNESCAPED_UNICODE = 256;
export const JSON_PRESERVE_ZERO_FRACTION = 1024;

function jsonStr(s: string, flags: number): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    switch (ch) {
      case '"':
        out += flags & JSON_HEX_QUOT ? '\\u0022' : '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '/':
        out += flags & JSON_UNESCAPED_SLASHES ? '/' : '\\/';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\f':
        out += '\\f';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '<':
        out += flags & JSON_HEX_TAG ? '\\u003C' : '<';
        continue;
      case '>':
        out += flags & JSON_HEX_TAG ? '\\u003E' : '>';
        continue;
      case '&':
        out += flags & JSON_HEX_AMP ? '\\u0026' : '&';
        continue;
      case "'":
        out += flags & JSON_HEX_APOS ? '\\u0027' : "'";
        continue;
    }
    if (c < 0x20) {
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else if (c < 0x80) {
      out += ch;
    } else if ((flags & JSON_UNESCAPED_UNICODE) && c !== 0x2028 && c !== 0x2029) {
      out += ch;
    } else if (c > 0xffff) {
      const v = c - 0x10000;
      out += '\\u' + (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + '\\u' + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      out += '\\u' + c.toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

/**
 * json_encode's text for a float (php_gcvt with serialize_precision = -1: the shortest round-trip digits,
 * exponential when the decimal exponent is below -4 or above 17 -- "1.0e+20", "1.5e-7"); a whole value
 * prints as "1", or "1.0" with JSON_PRESERVE_ZERO_FRACTION.
 */
export function phpJsonDouble(v: number, preserveZeroFraction = false): string {
  if (v === 0) return (Object.is(v, -0) ? '-0' : '0') + (preserveZeroFraction ? '.0' : '');
  const neg = v < 0;
  const [mant, e] = Math.abs(v).toExponential().split('e');
  const digits = mant.replace('.', '');
  let decpt = Number(e) + 1;
  let out: string;
  if (decpt < 0 ? decpt < -3 : decpt > 17) {
    decpt--;
    out = digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + 'e' + (decpt < 0 ? '-' : '+') + Math.abs(decpt);
  } else if (decpt < 0) {
    out = '0.' + '0'.repeat(-decpt) + digits;
  } else {
    out = '';
    for (let i = 0; i < decpt; i++) out += i < digits.length ? digits[i] : '0';
    if (digits.length > decpt) out += (decpt === 0 ? '0' : '') + '.' + digits.slice(decpt);
  }
  if (preserveZeroFraction && !out.includes('.')) out += '.0';
  return (neg ? '-' : '') + out;
}

/** PHP json_encode($v, $flags) (serialize_precision = -1). */
export function json_encode(v: any, flags = 0): string {
  return enc(v, flags, 0);
}

/** json_encode with JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES (the compilers' usual flags). */
export function jsonU(v: any): string {
  return json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function enc(v: any, flags: number, depth: number): string {
  const pretty = (flags & JSON_PRETTY_PRINT) !== 0;
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v instanceof PhpFloat) {
    if (!isFinite(v.v)) throw new Error('json_encode: Inf and NaN cannot be JSON encoded');
    return phpJsonDouble(v.v, (flags & JSON_PRESERVE_ZERO_FRACTION) !== 0);
  }
  if (typeof v === 'number') {
    if (!isFinite(v)) throw new Error('json_encode: Inf and NaN cannot be JSON encoded');
    return Number.isInteger(v) ? String(v) : phpJsonDouble(v, (flags & JSON_PRESERVE_ZERO_FRACTION) !== 0);
  }
  if (typeof v === 'string') return jsonStr(v, flags);
  if (Buffer.isBuffer(v)) return jsonStr(v.toString('utf8'), flags);
  if (typeof v === 'object' && !isOrdered(v) && typeof v.toJSON === 'function') return enc(v.toJSON(), flags, depth);
  let isList: boolean;
  let pairs: Array<[string, any]>;
  if (Array.isArray(v)) {
    pairs = v.map((x, i) => [String(i), x]);
    isList = !(flags & JSON_FORCE_OBJECT);
  } else if (isStd(v)) {
    pairs = entries(v);
    isList = false;
  } else {
    pairs = entries(v);
    isList = !(flags & JSON_FORCE_OBJECT) && isPhpList(pairs.map((p) => p[0]));
  }
  const ind = pretty ? '    '.repeat(depth + 1) : '';
  const nl = pretty ? '\n' : '';
  if (isList) {
    if (pairs.length === 0) return '[]';
    return '[' + nl + pairs.map(([, x]) => ind + enc(x, flags, depth + 1)).join(',' + nl) + nl + (pretty ? '    '.repeat(depth) : '') + ']';
  }
  if (pairs.length === 0) return '{}';
  return '{' + nl + pairs.map(([k, x]) => ind + jsonStr(k, flags) + (pretty ? ': ' : ':') + enc(x, flags, depth + 1)).join(',' + nl) + nl + (pretty ? '    '.repeat(depth) : '') + '}';
}

/** var_export($v, true) for scalars. */
export function var_export_scalar(v: any): string {
  if (v instanceof PhpFloat) return phpJsonDouble(v.v, true).toUpperCase();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : phpJsonDouble(v, true).toUpperCase();
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ---------------------------------------------------------------- strings (bytes where PHP counts bytes)

export function strlen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** substr() over UTF-8 bytes (a cut inside a character is decoded leniently). */
export function substr(s: string, start: number, length?: number | null): string {
  const b = Buffer.from(s, 'utf8');
  const n = b.length;
  let st = start < 0 ? Math.max(0, n + start) : Math.min(start, n);
  let end: number;
  if (length === undefined || length === null) end = n;
  else if (length < 0) end = Math.max(st, n + length);
  else end = Math.min(n, st + length);
  if (end < st) return '';
  return b.subarray(st, end).toString('utf8');
}

export function str_repeat(s: string, n: number): string {
  return n > 0 ? s.repeat(n) : '';
}

function charlistSet(chars: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i + 1] === '.' && chars[i + 2] === '.' && i + 3 < chars.length) {
      const a = chars.charCodeAt(i);
      const z = chars.charCodeAt(i + 3);
      for (let c = a; c <= z; c++) set.add(String.fromCharCode(c));
      i += 3;
    } else set.add(chars[i]);
  }
  return set;
}

const WS = ' \t\n\r\0\x0B';

export function trim(s: any, chars: string = WS): string {
  return ltrim(rtrim(s, chars), chars);
}

export function ltrim(s: any, chars: string = WS): string {
  const str = strval(s);
  const set = charlistSet(chars);
  let i = 0;
  while (i < str.length && set.has(str[i])) i++;
  return str.slice(i);
}

export function rtrim(s: any, chars: string = WS): string {
  const str = strval(s);
  const set = charlistSet(chars);
  let i = str.length;
  while (i > 0 && set.has(str[i - 1])) i--;
  return str.slice(0, i);
}

export function strtolower(s: any): string {
  return strval(s).replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

export function strtoupper(s: any): string {
  return strval(s).replace(/[a-z]+/g, (m) => m.toUpperCase());
}

export function ucfirst(s: string): string {
  return s.length && /[a-z]/.test(s[0]) ? s[0].toUpperCase() + s.slice(1) : s;
}

export function lcfirst(s: string): string {
  return s.length && /[A-Z]/.test(s[0]) ? s[0].toLowerCase() + s.slice(1) : s;
}

export function ucwords(s: string): string {
  return s.replace(/(^|[ \t\r\n\f\v])([a-z])/g, (_m, a, b) => a + b.toUpperCase());
}

/** str_replace with string or array search/replace (applied in order, like PHP). */
export function str_replace(search: string | string[], replace: string | string[], subject: string): string {
  let out = strval(subject);
  if (Array.isArray(search)) {
    search.forEach((s, i) => {
      const r = Array.isArray(replace) ? (replace[i] ?? '') : replace;
      if (s !== '') out = out.split(s).join(r);
    });
    return out;
  }
  if (search === '') return out;
  return out.split(search).join(Array.isArray(replace) ? (replace[0] ?? '') : replace);
}

export function strtr(s: string, pairs: Record<string, string>): string {
  const keys = Object.keys(pairs).filter((k) => k !== '').sort((a, b) => b.length - a.length);
  if (!keys.length) return s;
  let out = '';
  let i = 0;
  outer: while (i < s.length) {
    for (const k of keys) {
      if (s.startsWith(k, i)) {
        out += pairs[k];
        i += k.length;
        continue outer;
      }
    }
    out += s[i++];
  }
  return out;
}

export function implode(sep: string, arr: any): string {
  return values(arr).map(strval).join(sep);
}

export function explode(sep: string, s: string, limit?: number): string[] {
  const parts = strval(s).split(sep);
  if (limit === undefined || limit === null) return parts;
  if (limit > 0) {
    if (parts.length <= limit) return parts;
    return [...parts.slice(0, limit - 1), parts.slice(limit - 1).join(sep)];
  }
  if (limit < 0) return parts.slice(0, limit);
  return [parts.join(sep)];
}

export function str_starts_with(s: string, p: string): boolean {
  return s.startsWith(p);
}

export function str_ends_with(s: string, p: string): boolean {
  return s.endsWith(p);
}

export function str_contains(s: string, p: string): boolean {
  return s.includes(p);
}

/** strpos (character offset; callers only compare with false / 0). */
export function strpos(s: string, n: string, offset = 0): number | false {
  const i = s.indexOf(n, offset);
  return i < 0 ? false : i;
}

/** str_pad over bytes. */
export function str_pad(s: string, len: number, pad = ' ', type: 'right' | 'left' | 'both' = 'right'): string {
  const n = len - strlen(s);
  if (n <= 0 || pad === '') return s;
  const mk = (k: number) => pad.repeat(Math.ceil(k / pad.length)).slice(0, k);
  if (type === 'left') return mk(n) + s;
  if (type === 'both') {
    const l = Math.floor(n / 2);
    return mk(l) + s + mk(n - l);
  }
  return s + mk(n);
}

/** sprintf for the conversions the compilers use: %s %d %-Ns %Ns %0Nd %.Nf %%, widths in bytes. */
export function sprintf(fmt: string, ...args: any[]): string {
  let ai = 0;
  return fmt.replace(/%(?:(\d+)\$)?([-+ 0]|'.)*(\d+)?(?:\.(\d+))?([sdfFuxXbceo%])/g, (whole, argnum, _f, width, prec, conv) => {
    if (conv === '%') return '%';
    const flags = /^%(?:\d+\$)?((?:[-+ 0]|'.)*)/.exec(whole)![1];
    const left = flags.includes('-');
    let padCh = ' ';
    const q = /'(.)/.exec(flags);
    if (q) padCh = q[1];
    else if (flags.includes('0')) padCh = '0';
    const arg = argnum ? args[Number(argnum) - 1] : args[ai++];
    let s: string;
    switch (conv) {
      case 's':
        s = strval(arg);
        if (prec !== undefined) s = substr(s, 0, Number(prec));
        break;
      case 'd':
      case 'u': {
        const n = intval(arg);
        s = String(n);
        if (flags.includes('+') && n >= 0) s = '+' + s;
        break;
      }
      case 'f':
      case 'F':
        s = floatval(arg).toFixed(prec !== undefined ? Number(prec) : 6);
        break;
      case 'x':
        s = intval(arg).toString(16);
        break;
      case 'X':
        s = intval(arg).toString(16).toUpperCase();
        break;
      case 'b':
        s = intval(arg).toString(2);
        break;
      case 'o':
        s = intval(arg).toString(8);
        break;
      case 'c':
        s = String.fromCharCode(intval(arg));
        break;
      case 'e':
        s = floatval(arg).toExponential(prec !== undefined ? Number(prec) : 6).replace(/e([+-])(\d)$/, 'e$1$2');
        break;
      default:
        s = strval(arg);
    }
    if (width !== undefined) {
      const w = Number(width);
      const n = w - strlen(s);
      if (n > 0) {
        if (left) s = s + (padCh === '0' ? ' ' : padCh).repeat(n);
        else if (padCh === '0' && /^[+-]/.test(s) && conv !== 's') s = s[0] + '0'.repeat(n) + s.slice(1);
        else s = padCh.repeat(n) + s;
      }
    }
    return s;
  });
}

/** wordwrap over bytes, PHP algorithm. */
export function wordwrap(text: string, width = 75, brk = '\n', cut = false): string {
  // Operate on a latin1 view of the UTF-8 bytes so lengths are byte lengths.
  const b = Buffer.from(text, 'utf8').toString('latin1');
  const br = Buffer.from(brk, 'utf8').toString('latin1');
  const out = wordwrapBytes(b, width, br, cut);
  return Buffer.from(out, 'latin1').toString('utf8');
}

function wordwrapBytes(text: string, width: number, brk: string, cut: boolean): string {
  const textLen = text.length;
  const brkLen = brk.length;
  if (textLen === 0) return '';
  if (brkLen === 0) throw new Error('wordwrap: break cannot be empty');
  if (width === 0 && cut) throw new Error("wordwrap: can't force cut when width is zero");
  // Special case: single-character break, no cut.
  if (brkLen === 1 && !cut) {
    const chars = text.split('');
    let lastStart = 0;
    let lastSpace = 0;
    for (let current = 0; current < textLen; current++) {
      if (chars[current] === brk) {
        lastStart = lastSpace = current + 1;
      } else if (chars[current] === ' ') {
        if (current - lastStart >= width) {
          chars[current] = brk;
          lastStart = current + 1;
        }
        lastSpace = current;
      } else if (current - lastStart >= width && lastStart !== lastSpace) {
        chars[lastSpace] = brk;
        lastStart = lastSpace + 1;
      }
    }
    return chars.join('');
  }
  let out = '';
  let lastStart = 0;
  let lastSpace = 0;
  let current: number;
  for (current = 0; current < textLen; current++) {
    if (text[current] === brk[0] && current + brkLen < textLen && text.substr(current, brkLen) === brk) {
      out += text.slice(lastStart, current + brkLen);
      current += brkLen - 1;
      lastStart = lastSpace = current + 1;
    } else if (text[current] === ' ') {
      if (current - lastStart >= width) {
        out += text.slice(lastStart, current) + brk;
        lastStart = current + 1;
      }
      lastSpace = current;
    } else if (current - lastStart >= width && cut && lastStart >= lastSpace) {
      out += text.slice(lastStart, current) + brk;
      lastStart = lastSpace = current;
    } else if (current - lastStart >= width && lastStart < lastSpace) {
      out += text.slice(lastStart, lastSpace) + brk;
      lastStart = lastSpace = lastSpace + 1;
    }
  }
  if (lastStart !== current) out += text.slice(lastStart, current);
  return out;
}

export function nl2space(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

export function basename(p: string, suffix?: string): string {
  let s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  if (i >= 0) s = s.slice(i + 1);
  if (suffix && s.endsWith(suffix) && s !== suffix) s = s.slice(0, -suffix.length);
  return s;
}

/** pathinfo($p, PATHINFO_EXTENSION) */
export function pathExtension(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1) : '';
}

// ---------------------------------------------------------------- regex (PCRE pattern strings)

const reCache = new Map<string, RegExp>();

/** A PHP PCRE pattern string ("/x/i", "#x#") as a JS RegExp (global when asked). */
export function pcre(pattern: string, global = false): RegExp {
  const key = pattern + (global ? '\u0000g' : '');
  const hit = reCache.get(key);
  if (hit) {
    hit.lastIndex = 0;
    return hit;
  }
  const d = pattern[0];
  const endD = d === '(' ? ')' : d === '{' ? '}' : d === '[' ? ']' : d === '<' ? '>' : d;
  const end = pattern.lastIndexOf(endD);
  let body = pattern.slice(1, end);
  const mods = pattern.slice(end + 1);
  let flags = global ? 'g' : '';
  for (const m of mods) {
    if (m === 'i') flags += 'i';
    else if (m === 'm') flags += 'm';
    else if (m === 's') flags += 's';
    else if (m === 'u') flags += 'u';
    else if (m === 'x') body = body.replace(/\\#/g, '\u0000').replace(/\s+|#.*$/gm, '').replace(/\u0000/g, '\\#');
    else if (m === 'D') {
      /* dollar end only: JS $ without m already matches only at end */
    }
  }
  // PCRE-only syntax: \A \z \Z, possessive/atomic not supported
  body = body.replace(/\\A/g, '^').replace(/\\z/g, '$(?![\\s\\S])').replace(/\\Z/g, '(?=\\n?$(?![\\s\\S]))');
  if (d !== '/') body = body.split('\\' + d).join(d);
  const re = new RegExp(body, flags);
  reCache.set(key, re);
  return re;
}

/** preg_replace($pattern, $replacement, $subject, $limit) with $1 / \1 / ${1} references. */
export function preg_replace(pattern: string | string[], replacement: string | string[], subject: string, limit = -1): string {
  if (Array.isArray(pattern)) {
    let out = subject;
    pattern.forEach((p, i) => {
      out = preg_replace(p, Array.isArray(replacement) ? (replacement[i] ?? '') : replacement, out, limit);
    });
    return out;
  }
  const re = pcre(pattern, true);
  const rep = String(replacement);
  let n = 0;
  return strval(subject).replace(re, (...m: any[]) => {
    if (limit >= 0 && n >= limit) return m[0];
    n++;
    const groups = m.slice(0, -2).filter((x: any) => typeof x !== 'object');
    return rep.replace(/\\\\|\\(\d{1,2})|\$(\d{1,2})|\$\{(\d{1,2})\}/g, (t, a, b, c) => {
      if (t === '\\\\') return '\\';
      const g = Number(a ?? b ?? c);
      return groups[g] ?? '';
    });
  });
}

export function preg_replace_callback(pattern: string, cb: (m: string[]) => string, subject: string): string {
  const re = pcre(pattern, true);
  return strval(subject).replace(re, (...m: any[]) => {
    const groups = m.slice(0, -2).filter((x: any) => typeof x !== 'object').map((x: any) => x ?? '');
    return cb(groups);
  });
}

/** preg_match: returns 1/0; fills `out` (when given) like $m. */
export function preg_match(pattern: string, subject: string, out?: string[]): number {
  const re = pcre(pattern);
  const m = re.exec(strval(subject));
  if (out) {
    out.length = 0;
    if (m) {
      // PHP drops trailing unmatched groups
      let last = m.length - 1;
      while (last > 0 && m[last] === undefined) last--;
      for (let i = 0; i <= last; i++) out.push(m[i] ?? '');
    }
  }
  return m ? 1 : 0;
}

/** preg_match_all with PREG_SET_ORDER-free default (PREG_PATTERN_ORDER): returns count, fills out[g][i]. */
export function preg_match_all(pattern: string, subject: string, out?: string[][]): number {
  const re = pcre(pattern, true);
  const all = [...strval(subject).matchAll(re)];
  if (out) {
    out.length = 0;
    const ng = all.length ? all[0].length : (new RegExp(re.source + '|').exec('')?.length ?? 1);
    for (let g = 0; g < ng; g++) out.push(all.map((m) => m[g] ?? ''));
  }
  return all.length;
}

export function preg_split(pattern: string, subject: string, limit = -1, noEmpty = false): string[] {
  const re = pcre(pattern, true);
  let parts = strval(subject).split(re).filter((x) => x !== undefined);
  // JS split includes capture groups; PHP only with PREG_SPLIT_DELIM_CAPTURE: patterns here have none
  if (limit > 0 && parts.length > limit) {
    // rebuild with limit
    const out: string[] = [];
    let rest = strval(subject);
    re.lastIndex = 0;
    for (let i = 0; i < limit - 1; i++) {
      const r2 = pcre(pattern);
      const m = r2.exec(rest);
      if (!m) break;
      out.push(rest.slice(0, m.index));
      rest = rest.slice(m.index + m[0].length);
    }
    out.push(rest);
    parts = out;
  }
  return noEmpty ? parts.filter((p) => p !== '') : parts;
}

export function preg_quote(s: string, delim?: string): string {
  let out = s.replace(/[.\\+*?[^\]$(){}=!<>|:\-#/]/g, (c) => (c === '/' && delim !== '/' ? c : '\\' + c));
  if (delim && delim !== '/' ) out = out.split(delim).join('\\' + delim);
  return out.replace(/\0/g, '\\000');
}

// ---------------------------------------------------------------- arrays

export function in_array(needle: any, hay: any, strict = false): boolean {
  for (const v of values(hay)) {
    if (strict ? looseStrictEq(v, needle) : looseEq(v, needle)) return true;
  }
  return false;
}

function looseStrictEq(a: any, b: any): boolean {
  if (a instanceof PhpFloat) a = a.v;
  if (b instanceof PhpFloat) b = b.v;
  return a === b;
}

function looseEq(a: any, b: any): boolean {
  if (a instanceof PhpFloat) a = a.v;
  if (b instanceof PhpFloat) b = b.v;
  if (typeof a === typeof b) return a === b;
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) {
    const s = typeof a === 'string' ? a : b;
    const n = typeof a === 'number' ? a : b;
    return is_numeric(s) ? Number(s) === n : String(n) === s;
  }
  if (a === null || a === undefined) return !truthy(b);
  if (b === null || b === undefined) return !truthy(a);
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  return a == b;
}

/** array_search (strict) */
export function array_search(needle: any, hay: any, strict = false): string | number | false {
  for (const [k, v] of entries(hay)) {
    if (strict ? looseStrictEq(v, needle) : looseEq(v, needle)) return Array.isArray(hay) ? Number(k) : k;
  }
  return false;
}

export function array_key_exists(k: any, arr: any): boolean {
  if (arr === null || arr === undefined) return false;
  if (Array.isArray(arr)) return Number(k) >= 0 && Number(k) < arr.length && String(Number(k)) === String(k);
  if (arr instanceof Map) return arr.has(String(k));
  return Object.prototype.hasOwnProperty.call(arr, String(k)) || (isOrdered(arr) && String(k) in arr);
}

/** isset($a[$k]) for one level */
export function has(arr: any, k: any): boolean {
  if (arr === null || arr === undefined || typeof arr !== 'object') return false;
  const v = Array.isArray(arr) ? arr[Number(k)] : arr instanceof Map ? arr.get(String(k)) : arr[String(k)];
  return v !== null && v !== undefined;
}

/** array_map over values; a list stays a list, a keyed array keeps its keys (single-array form). */
export function array_map<T, U>(fn: (v: T) => U, arr: any): any {
  if (Array.isArray(arr)) return arr.map((v) => fn(v));
  if (arr === null || arr === undefined) return [];
  const ks = keysOf(arr);
  if (isPhpList(ks)) return ks.map((k) => fn(arr[k]));
  return oarr(ks.map((k) => [k, fn(arr[k])] as [string, U]));
}

/** array_filter: keeps keys (a list with gaps becomes a keyed array, as in PHP). */
export function array_filter<T>(arr: any, fn?: (v: T, k?: string) => any, useKey = false): any {
  const f = fn ?? ((v: any) => truthy(v));
  const kept: Array<[string, T]> = [];
  for (const [k, v] of entries<T>(arr)) {
    if (truthy(useKey ? (f as any)(k) : f(v, k))) kept.push([k, v]);
  }
  if (isPhpList(kept.map((e) => e[0])) && (Array.isArray(arr) || isPhpList(keysOf(arr)))) return kept.map((e) => e[1]);
  return oarr(kept);
}

export function array_column(arr: any, col: string | null, indexKey?: string): any {
  const rows = values(arr);
  if (indexKey !== undefined) {
    return oarr(rows.filter((r) => r !== null && typeof r === 'object').map((r) => [strval(r[indexKey]), col === null ? r : r[col]] as [string, any]));
  }
  const out: any[] = [];
  for (const r of rows) {
    if (r !== null && typeof r === 'object' && (col === null || (r[col] !== undefined && r[col] !== null) || array_key_exists(col, r))) out.push(col === null ? r : r[col]);
  }
  return out;
}

/** array_unique (first occurrence kept, keys kept). */
export function array_unique(arr: any): any {
  const seen = new Set<string>();
  const kept: Array<[string, any]> = [];
  for (const [k, v] of entries(arr)) {
    const s = strval(v);
    if (seen.has(s)) continue;
    seen.add(s);
    kept.push([k, v]);
  }
  if (isPhpList(kept.map((e) => e[0]))) return kept.map((e) => e[1]);
  return oarr(kept);
}

/** array_merge: lists append, string keys overwrite in place. */
export function array_merge(...arrs: any[]): any {
  const allList = arrs.every((a) => Array.isArray(a) || isPhpList(keysOf(a)));
  if (allList) return arrs.flatMap((a) => values(a));
  const out = oarr();
  let next = 0;
  for (const a of arrs) {
    for (const [k, v] of entries(a)) {
      if (/^(0|-?[1-9]\d*)$/.test(k)) out[String(next++)] = v;
      else out[k] = v;
    }
  }
  return out;
}

export function array_slice(arr: any, offset: number, length?: number | null): any[] {
  const vs = values(arr);
  const st = offset < 0 ? Math.max(0, vs.length + offset) : offset;
  const end = length === undefined || length === null ? vs.length : length < 0 ? vs.length + length : st + length;
  return vs.slice(st, end);
}

export function array_flip(arr: any): Record<string, any> {
  return oarr(entries(arr).map(([k, v]) => [strval(v), /^\d+$/.test(k) ? Number(k) : k] as [string, any]));
}

export function array_intersect_key(a: any, b: any): any {
  const keep = new Set(keysOf(b));
  return oarr(entries(a).filter(([k]) => keep.has(k)));
}

export function array_diff(a: any, ...others: any[]): any[] {
  const drop = new Set(others.flatMap((o) => values(o).map(strval)));
  return values(a).filter((v) => !drop.has(strval(v)));
}

export function array_fill_keys(keys: any, v: any): Record<string, any> {
  return oarr(values(keys).map((k) => [strval(k), v] as [string, any]));
}

export function array_combine(keys: any, vals: any): Record<string, any> {
  const ks = values(keys);
  const vs = values(vals);
  return oarr(ks.map((k, i) => [strval(k), vs[i]] as [string, any]));
}

export function array_sum(arr: any): number {
  return values(arr).reduce((a: number, v: any) => a + num(v), 0);
}

export function array_reverse<T>(arr: T[]): T[] {
  return [...values(arr)].reverse();
}

/** PHP 8 standard comparison of two values (strings compared numerically when both numeric). */
export function spaceship(a: any, b: any): number {
  if (a instanceof PhpFloat) a = a.v;
  if (b instanceof PhpFloat) b = b.v;
  if (typeof a === 'string' && typeof b === 'string') {
    if (is_numeric(a) && is_numeric(b)) {
      const x = Number(a);
      const y = Number(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    return strcmp(a, b);
  }
  if (typeof a === 'number' && typeof b === 'string') {
    if (is_numeric(b)) return a < Number(b) ? -1 : a > Number(b) ? 1 : 0;
    return strcmp(String(a), b);
  }
  if (typeof a === 'string' && typeof b === 'number') return -spaceship(b, a);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** strcmp over UTF-8 bytes, sign only. */
export function strcmp(a: string, b: string): number {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  const c = Buffer.compare(x, y);
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}

/** sort($a, SORT_STRING) -- stable, byte order. */
export function sortStrings(arr: string[]): string[] {
  return arr.sort((a, b) => strcmp(strval(a), strval(b)));
}

/** sort($a) with PHP 8 default flags. */
export function sortRegular<T>(arr: T[]): T[] {
  return arr.sort((a, b) => spaceship(a, b));
}

/** ksort with default flags over an ordered array (returns a new oarr). */
export function ksort(arr: any): Record<string, any> {
  const es = entries(arr);
  es.sort((a, b) => {
    const ia = /^(0|-?[1-9]\d*)$/.test(a[0]);
    const ib = /^(0|-?[1-9]\d*)$/.test(b[0]);
    if (ia && ib) return Number(a[0]) - Number(b[0]);
    return spaceship(ia ? Number(a[0]) : a[0], ib ? Number(b[0]) : b[0]);
  });
  return oarr(es);
}

export function max(...xs: any[]): any {
  const list = xs.length === 1 && Array.isArray(xs[0]) ? xs[0] : xs;
  return list.reduce((a: any, b: any) => (spaceship(b, a) > 0 ? b : a));
}

export function min(...xs: any[]): any {
  const list = xs.length === 1 && Array.isArray(xs[0]) ? xs[0] : xs;
  return list.reduce((a: any, b: any) => (spaceship(b, a) < 0 ? b : a));
}

/**
 * The abbreviation tzdata gives zone `tz` at `d` (what PHP's date('T') prints: "CEST", "IST", "+03"), read from
 * the system's TZif file; null when there is none to read.
 */
function tzifAbbreviation(tz: string, d: Date): string | null {
  if (!/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return null;
  let b: Buffer;
  try {
    b = require('node:fs').readFileSync('/usr/share/zoneinfo/' + tz);
  } catch {
    return null;
  }
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'TZif') return null;
  const now = Math.floor(d.getTime() / 1000);
  const block = (at: number, timeSize: number) => {
    const isut = b.readUInt32BE(at + 20), isstd = b.readUInt32BE(at + 24), leap = b.readUInt32BE(at + 28);
    const timecnt = b.readUInt32BE(at + 32), typecnt = b.readUInt32BE(at + 36), charcnt = b.readUInt32BE(at + 40);
    let p = at + 44;
    const times: number[] = [];
    for (let i = 0; i < timecnt; i++, p += timeSize) times.push(timeSize === 8 ? Number(b.readBigInt64BE(p)) : b.readInt32BE(p));
    const idx: number[] = [];
    for (let i = 0; i < timecnt; i++, p++) idx.push(b[p]);
    const types: Array<{ off: number; abbr: number }> = [];
    for (let i = 0; i < typecnt; i++, p += 6) types.push({ off: b.readInt32BE(p), abbr: b[p + 5] });
    const chars = b.toString('latin1', p, p + charcnt);
    p += charcnt + leap * (timeSize + 4) + isstd + isut;
    const name = (t: { abbr: number }) => chars.slice(t.abbr, chars.indexOf('\0', t.abbr) >= 0 ? chars.indexOf('\0', t.abbr) : undefined);
    return { times, idx, types, name, end: p };
  };
  let blk = block(0, 4);
  let footer = '';
  if (b[4] >= 0x32 && blk.end + 44 <= b.length) {
    blk = block(blk.end, 8);
    const nl = b.indexOf(0x0a, blk.end + 1);
    if (b[blk.end] === 0x0a && nl > blk.end) footer = b.toString('latin1', blk.end + 1, nl);
  }
  if (blk.types.length === 0) return null;
  let last = -1;
  for (let i = 0; i < blk.times.length; i++) if (blk.times[i] <= now) last = i;
  if (last >= 0 && (last < blk.times.length - 1 || footer === '')) return blk.name(blk.types[blk.idx[last]]);
  if (last < 0 && blk.times.length > 0) return blk.name(blk.types[0]);
  // Past the table: the footer's POSIX TZ string names the standard and (if any) the daylight time.
  const m = /^(<[^>]+>|[A-Za-z]+)([+-]?\d+(?::\d+){0,2})(<[^>]+>|[A-Za-z]+)?/.exec(footer);
  if (!m) return blk.times.length ? blk.name(blk.types[blk.idx[blk.times.length - 1]]) : blk.name(blk.types[0]);
  const strip = (s: string) => s.replace(/^<|>$/g, '');
  if (m[3] === undefined) return strip(m[1]);
  const [h, mi = '0', s = '0'] = m[2].replace(/^[+-]/, '').split(':');
  const stdOff = (m[2].startsWith('-') ? 1 : -1) * (Number(h) * 3600 + Number(mi) * 60 + Number(s));
  return -d.getTimezoneOffset() * 60 === stdOff ? strip(m[1]) : strip(m[3]);
}

/**
 * date('T'): the process time zone's abbreviation at `d`, as PHP prints it -- "UTC", "EST", "CEST"...;
 * a zone with no abbreviation prints its offset ("+03", "+0530"). Read from the system tzdata when it is
 * there; else Intl spells most abbreviations PHP knows (US zones, UTC/GMT), and the "GMT+2" it gives for the
 * others is turned into PHP's offset form.
 */
export function tzAbbreviation(d: Date = new Date()): string {
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Universal' || tz === 'Zulu') return 'UTC';
  const fromTzif = tzifAbbreviation(tz, d);
  if (fromTzif !== null && fromTzif !== '') return fromTzif;
  let name = '';
  try {
    name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    name = '';
  }
  if (name === 'UTC' || name === 'GMT') return tz === 'UTC' ? 'UTC' : name;
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (m || name === '') {
    const off = -d.getTimezoneOffset();
    const sign = off < 0 ? '-' : '+';
    const a = Math.abs(off);
    const hh = String(Math.floor(a / 60)).padStart(2, '0');
    const mm = a % 60;
    return sign + hh + (mm ? String(mm).padStart(2, '0') : '');
  }
  return name;
}

/** East Asian Wide/Fullwidth code point ranges (mb_strwidth counts these as 2 columns). */
const EAW_WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function cpWidth(cp: number): number {
  for (const [a, z] of EAW_WIDE) {
    if (cp < a) return 1;
    if (cp <= z) return 2;
  }
  return 1;
}

/** mb_strwidth (UTF-8). */
export function mb_strwidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/** mb_strimwidth($s, $start, $width, $marker) for start >= 0 and width >= 0. */
export function mb_strimwidth(s: string, start: number, width: number, marker = ''): string {
  const cps = [...s].slice(start);
  const str = cps.join('');
  if (mb_strwidth(str) <= width) return str;
  const room = width - mb_strwidth(marker);
  let out = '';
  let w = 0;
  for (const ch of cps) {
    const cw = cpWidth(ch.codePointAt(0)!);
    if (w + cw > room) break;
    out += ch;
    w += cw;
  }
  return out + marker;
}

/** date('Ymd') etc. in the process time zone (format letters the compilers use). */
export function date(fmt: string, d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return fmt.replace(/[YmdHisjnyDT]/g, (c) => {
    switch (c) {
      case 'T':
        return tzAbbreviation(d);
      case 'Y':
        return String(d.getFullYear());
      case 'y':
        return p(d.getFullYear() % 100);
      case 'm':
        return p(d.getMonth() + 1);
      case 'n':
        return String(d.getMonth() + 1);
      case 'd':
        return p(d.getDate());
      case 'j':
        return String(d.getDate());
      case 'H':
        return p(d.getHours());
      case 'i':
        return p(d.getMinutes());
      case 's':
        return p(d.getSeconds());
      case 'D':
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    }
    return c;
  });
}

/**
 * iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s) as glibc/macOS spell it, approximated: accents dropped
 * (the callers strip the ' " ` ^ ~ marks the real call inserts), a few ligatures spelled out, the rest dropped.
 */
export function asciiTranslit(s: string): string {
  const special: Record<string, string> = {
    'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE', 'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L',
    'þ': 'th', 'Þ': 'TH', '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '€': 'EUR', '«': '<<', '»': '>>',
  };
  let out = '';
  for (const ch of s) {
    if (ch.charCodeAt(0) < 0x80) {
      out += ch;
      continue;
    }
    if (special[ch] !== undefined) {
      out += special[ch];
      continue;
    }
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += /^[\x00-\x7f]+$/.test(base) ? base : '?';
  }
  return out;
}

export function mb_check_encoding_utf8(b: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** mb_strlen (code points) */
export function mb_strlen(s: string): number {
  return [...s].length;
}

/** mb_substr (code points) */
export function mb_substr(s: string, start: number, length?: number | null): string {
  const cps = [...s];
  const st = start < 0 ? Math.max(0, cps.length + start) : start;
  const end = length === undefined || length === null ? cps.length : length < 0 ? cps.length + length : st + length;
  return cps.slice(st, end).join('');
}

/** PHP's `$a ?: $b` */
/** PHP's array union `$a + $b`: a's entries, then b's whose keys a lacks (an ordered array). */
export function union(a: any, b: any): any {
  const out = oarr(entries(a));
  for (const [k, v] of entries(b)) if (!(k in out)) out[k] = v;
  return out;
}

export function elvis<T>(a: T, b: T): T {
  return truthy(a) ? a : b;
}

/** A shallow PHP array copy (value semantics on assignment). */
export function copy<T>(x: T): T {
  if (Array.isArray(x)) return [...x] as any;
  if (isOrdered(x)) return oarr(entries(x)) as any;
  if (x !== null && typeof x === 'object' && !(x instanceof PhpFloat)) {
    const c = { ...(x as any) };
    if (isStd(x)) stdObj(c);
    return c;
  }
  return x;
}

/** A deep PHP array copy. */
export function deepCopy<T>(x: T): T {
  if (Array.isArray(x)) return x.map(deepCopy) as any;
  if (x instanceof PhpFloat || Buffer.isBuffer(x)) return x;
  if (x !== null && typeof x === 'object') {
    const std = isStd(x);
    const o = oarr(entries(x).map(([k, v]) => [k, deepCopy(v)] as [string, any]));
    return (std ? stdObj(o) : o) as any;
  }
  return x;
}
