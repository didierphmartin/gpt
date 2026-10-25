/**
 * PHP-vs-TypeScript differential harness — the twin of backend_python/tests/differential/conftest.py.
 *
 * PHP is hit over HTTP (Apache, DIFF_PHP_BASE, default http://localhost/gpt/backend); the TS port
 * is mounted in-process (tests/differential/app.ts) on an ephemeral 127.0.0.1 port. Both are sent
 * the same request with a JWT for DIFF_USER_ID (default 3) signed with the TS config's JWT_SECRET
 * (the same .env secret PHP reads).
 *
 * WARNING: both backends use the REAL databases (the CONTEXTS DB is production). Every case that
 * writes data is registered with `dtest.write(...)` and only runs when DIFF_ALLOW_WRITES=1.
 * The Python suite has no such gate (only test_ingestion.py's DIFF_INGESTION=1); this one is TS-only.
 *
 * Skip rule (conftest.py `_require_php`): when PHP's `GET /` does not answer 200 within 3s, every
 * differential case skips. Nothing from src/ is imported until PHP is up, so a skip run needs no
 * .env, no DB and opens no connection.
 */
import { test, after, TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const PHP_BASE = (process.env.DIFF_PHP_BASE ?? 'http://localhost/gpt/backend').replace(/\/+$/, '');
export const DIFF_USER_ID = parseInt(process.env.DIFF_USER_ID ?? '3', 10);
/** Off by default: cases that create/update/delete rows (or files) only run with DIFF_ALLOW_WRITES=1. */
export const ALLOW_WRITES = process.env.DIFF_ALLOW_WRITES === '1';
const TIMEOUT_MS = 60_000;

// ─── response + client ──────────────────────────────────────────────────────

export interface Resp {
  status: number;
  headers: Headers;
  text: string;
  bytes: Buffer;
  /** JSON.parse(text); throws on a non-JSON body (httpx `.json()`). */
  json(): any;
}

export interface ReqOpts {
  /** JSON body (httpx `json=`): serialised + `Content-Type: application/json`. */
  json?: unknown;
  /** Raw body (httpx `content=` / `files=` via FormData). */
  body?: string | Buffer | FormData | URLSearchParams;
  headers?: Record<string, string>;
  /** Query string params. */
  params?: Record<string, string | number>;
  timeoutMs?: number;
}

export class Client {
  constructor(readonly base: string, readonly label: string) {}

  async request(method: string, path: string, opts: ReqOpts = {}): Promise<Resp> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: any = undefined;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    } else if (opts.body !== undefined) {
      body = opts.body;
    }
    let url = this.base + path;
    if (opts.params) {
      const qs = new URLSearchParams(Object.entries(opts.params).map(([k, v]): [string, string] => [k, String(v)])).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    return {
      status: res.status,
      headers: res.headers,
      text,
      bytes,
      json() {
        return JSON.parse(text);
      },
    };
  }

  get(path: string, opts?: ReqOpts) { return this.request('GET', path, opts); }
  post(path: string, opts?: ReqOpts) { return this.request('POST', path, opts); }
  put(path: string, opts?: ReqOpts) { return this.request('PUT', path, opts); }
  patch(path: string, opts?: ReqOpts) { return this.request('PATCH', path, opts); }
  delete(path: string, opts?: ReqOpts) { return this.request('DELETE', path, opts); }
}

// ─── PHP probe ──────────────────────────────────────────────────────────────

let probe: Promise<boolean> | null = null;
export function phpUp(): Promise<boolean> {
  if (!probe) {
    probe = fetch(PHP_BASE + '/', { signal: AbortSignal.timeout(3000), redirect: 'manual' })
      .then(async (r) => {
        await r.arrayBuffer().catch(() => undefined);
        return r.status === 200;
      })
      .catch(() => false);
  }
  return probe;
}

// ─── the in-process TS app + DB helper (lazy) ───────────────────────────────

export interface SqlDb {
  fetchOne(sql: string, params?: unknown[]): Promise<any | null>;
  fetchAll(sql: string, params?: unknown[]): Promise<any[]>;
  /** Returns affectedRows (+ insertId). */
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number; insertId: number }>;
}

export interface Harness {
  php: Client;
  ts: Client;
  token: string;
  /** `{ Authorization: 'Bearer <token>' }` — the per-file `h` fixture. */
  h: Record<string, string>;
  /** The TS `config` (src/config/env) — Python's `config` fixture. */
  config: any;
  /** Python `open_primary(config)`: contexts DB ?? main DB. */
  primaryDb: SqlDb;
  /** The main app DB (DB_*). */
  mainDb: SqlDb;
  /** Same request to PHP then TS; auth=true adds the Bearer token unless headers carry Authorization. */
  both(method: string, path: string, opts?: ReqOpts & { auth?: boolean }): Promise<[Resp, Resp]>;
}

let harnessP: Promise<Harness> | null = null;
let server: Server | null = null;
let pools: Array<{ end(cb?: (err?: any) => void): void }> = [];

function sqlDb(pool: any): SqlDb {
  const p = pool.promise();
  return {
    async fetchOne(sql, params = []) {
      const [rows] = await p.query(sql, params);
      return (rows as any[])[0] ?? null;
    },
    async fetchAll(sql, params = []) {
      const [rows] = await p.query(sql, params);
      return rows as any[];
    },
    async execute(sql, params = []) {
      const [r] = await p.query(sql, params);
      return { affectedRows: (r as any).affectedRows ?? 0, insertId: (r as any).insertId ?? 0 };
    },
  };
}

async function buildHarness(): Promise<Harness> {
  // Lazy: src/config/env throws without the env vars, and src/db/pools opens pools on import.
  const { buildApp } = await import('./app');
  const { config } = await import('../../src/config/env');
  const { mainPool, contextsPool } = await import('../../src/db/pools');
  const jwt = (await import('jsonwebtoken')).default;
  pools = [mainPool as any, contextsPool as any];

  const app = buildApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { iss: 'gpt-chat', iat: now, exp: now + 3600, sub: DIFF_USER_ID, type: 'access' },
    config.auth.jwtSecret,
    { algorithm: 'HS256' },
  );
  const php = new Client(PHP_BASE, 'php');
  const ts = new Client(`http://127.0.0.1:${port}`, 'ts');
  const h = { Authorization: `Bearer ${token}` };
  return {
    php,
    ts,
    token,
    h,
    config,
    primaryDb: sqlDb(contextsPool),
    mainDb: sqlDb(mainPool),
    async both(method, path, opts = {}) {
      const { auth = true, ...rest } = opts;
      const headers: Record<string, string> = { ...(rest.headers ?? {}) };
      if (auth && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${token}`;
      // Sequential, PHP first (httpx: a = php.request(...); b = py.request(...)).
      const a = await php.request(method, path, { ...rest, headers });
      const b = await ts.request(method, path, { ...rest, headers });
      return [a, b];
    },
  };
}

export function harness(): Promise<Harness> {
  if (!harnessP) harnessP = buildHarness();
  return harnessP;
}

after(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  for (const p of pools) await new Promise<void>((r) => p.end(() => r()));
});

// ─── test registration (skip-if-PHP-down + write gate) ──────────────────────

export type DiffFn = (h: Harness, t: TestContext) => Promise<void> | void;
export interface DiffOpts {
  /** Writes data: skipped unless DIFF_ALLOW_WRITES=1. */
  writes?: boolean;
  /** Static skip (pytest.skip at the top of a case): the reason. */
  skip?: string;
}

async function guard(t: TestContext): Promise<Harness | null> {
  if (!(await phpUp())) {
    t.skip(`PHP backend not reachable at ${PHP_BASE}`);
    return null;
  }
  return harness();
}

/** One differential case (pytest `def test_…`). */
export function dtest(name: string, fn: DiffFn, opts: DiffOpts = {}): void {
  const skip = opts.skip ?? (opts.writes && !ALLOW_WRITES ? 'writes data; set DIFF_ALLOW_WRITES=1 to run' : undefined);
  test(name, { skip }, async (t) => {
    const hx = await guard(t);
    if (!hx) return;
    await fn(hx, t);
  });
}
/** A case that writes data (rows, files, settings): gated on DIFF_ALLOW_WRITES=1. */
dtest.write = (name: string, fn: DiffFn, opts: Omit<DiffOpts, 'writes'> = {}) => dtest(name, fn, { ...opts, writes: true });

/** Mid-case `pytest.skip(reason)`: call `return skipCase(t, reason)`. */
export function skipCase(t: TestContext, reason: string): void {
  t.skip(reason);
}

// ─── comparison helpers ─────────────────────────────────────────────────────

function dropKeys(o: any, ignore: readonly string[]): any {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const c = { ...o };
    for (const k of ignore) delete c[k];
    return c;
  }
  return o;
}

/** conftest.py `same`: status + JSON equality, ignoring listed top-level keys (wall-clock fields). */
export function same(a: Resp, b: Resp, ignore: readonly string[] = []): void {
  assert.equal(a.status, b.status, `status php=${a.status} ts=${b.status}\nphp: ${a.text.slice(0, 2000)}\nts: ${b.text.slice(0, 2000)}`);
  assert.deepStrictEqual(dropKeys(b.json(), ignore), dropKeys(a.json(), ignore));
}

/** `same` over an array pair, e.g. `same(...await both(...))` cannot spread a Promise. */
export function sameP(pair: [Resp, Resp], ignore: readonly string[] = []): void {
  same(pair[0], pair[1], ignore);
}

/**
 * Rounds every non-integer number (default 6 dp). Tracker rows 12 / 134: Apache php.ini has
 * serialize_precision=100, so PHP's json_encode leaks ~50 IEEE754 digits on computed floats; the
 * TS port applies PHP's round() (phpRound) but emits the shortest repr. Compared post-round.
 */
export function roundFloats(obj: any, ndigits = 6): any {
  if (typeof obj === 'number') {
    if (Number.isInteger(obj) || !Number.isFinite(obj)) return obj;
    const f = 10 ** ndigits;
    return Math.round(obj * f) / f;
  }
  if (Array.isArray(obj)) return obj.map((v) => roundFloats(v, ndigits));
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = roundFloats(v, ndigits);
    return out;
  }
  return obj;
}

/** `same_rounded` (test_admin_users.py / test_admin_usage_mcp_costs.py). */
export function sameRounded(a: Resp, b: Resp, ndigits = 6): void {
  assert.equal(a.status, b.status, `status php=${a.status} ts=${b.status}\nphp: ${a.text.slice(0, 2000)}\nts: ${b.text.slice(0, 2000)}`);
  assert.deepStrictEqual(roundFloats(b.json(), ndigits), roundFloats(a.json(), ndigits));
}

/**
 * Replace the values of the named keys (at any depth) with a fixed marker — for wall-clock fields
 * nested below the top level (timestamps, durations, generated ids).
 */
export function maskKeys(obj: any, keys: readonly string[], marker: unknown = '<masked>'): any {
  if (Array.isArray(obj)) return obj.map((v) => maskKeys(v, keys, marker));
  if (obj && typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) out[k] = keys.includes(k) ? marker : maskKeys(v, keys, marker);
    return out;
  }
  return obj;
}

/** Python `list(ja) == list(jb)`: same top-level keys in the same order. */
export function sameKeys(a: any, b: any, msg?: string): void {
  assert.deepStrictEqual(Object.keys(b ?? {}), Object.keys(a ?? {}), msg);
}

/** Python `set(a) == set(b)`. */
export function sameKeySet(a: any, b: any, msg?: string): void {
  assert.deepStrictEqual(Object.keys(b ?? {}).sort(), Object.keys(a ?? {}).sort(), msg);
}

export { assert };
