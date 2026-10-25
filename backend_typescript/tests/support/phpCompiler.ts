/**
 * The PHP side of the compiler parity tests: runs tests/fixtures/compiler/php_compile.php (backend/'s own
 * compiler, no MySQL) and reads its JSON back with PHP's key order and float/stdClass shapes intact.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { JSON_PRESERVE_ZERO_FRACTION, JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, entries, jsonDecodePhp, json_encode } from '../../src/AgentTeam/compiler/php';
import { WorkflowView } from '../../src/AgentTeam/compiler/WorkflowView';

export const FIXTURES = path.resolve(__dirname, '../fixtures/compiler');
const SCRIPT = path.join(FIXTURES, 'php_compile.php');

let cached: string | null | undefined;

/** The PHP binary (`php` on PATH, else XAMPP's), or null when there is none. */
export function phpBin(): string | null {
  if (cached !== undefined) return cached;
  for (const cand of ['php', '/Applications/XAMPP/xamppfiles/bin/php']) {
    const r = spawnSync(cand, ['-r', 'echo extension_loaded("pdo_sqlite") ? "ok" : "no";'], { encoding: 'utf8', env: phpEnv() });
    if (r.status === 0 && r.stdout.trim() === 'ok') return (cached = cand);
  }
  return (cached = null);
}

/** Why the PHP side cannot run here ('' when it can): a test skips with this reason. */
export function phpSkipReason(): string {
  return phpBin() === null ? 'no PHP binary with pdo_sqlite (php on PATH or /Applications/XAMPP/xamppfiles/bin/php)' : '';
}

function phpEnv(): NodeJS.ProcessEnv {
  return { ...process.env, XDEBUG_MODE: 'off', TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function run(args: string[], stdin?: string): any {
  const bin = phpBin();
  if (bin === null) throw new Error(phpSkipReason());
  const r = spawnSync(bin, [SCRIPT, ...args], { input: stdin, encoding: 'utf8', env: phpEnv(), maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`php_compile.php ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return jsonDecodePhp(line);
}

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name.endsWith('.json') ? name : `${name}.json`);
}

/** PHP's generate() on a fixture: {ok, result} or {ok: false, error}. */
export function phpCompile(fixture: string): { ok: boolean; result?: any; error?: string } {
  return run(['compile', fixturePath(fixture)]);
}

/** Every target's (langgraph, adk, maf, nooa) PHP generation of a fixture in every mode: {target: {mode: {ok, result} | {ok: false, error}}}. */
export function phpTargets(fixture: string): any {
  return run(['targets', fixturePath(fixture)]);
}

/** PHP's analyzeForEmit() facts for a fixture, workflow as a WorkflowView (as the TypeScript generator holds it). */
export function phpFacts(fixture: string): any {
  const f = run(['facts', fixturePath(fixture)]);
  f.workflow = WorkflowView.fromRecord(f.workflow);
  return f;
}

/** A static PHP method's return value (`{$facts: fixture}` arguments are that fixture's facts). */
export function phpCall(cls: string, method: string, args: any[] = []): any {
  const r = run(['call'], json_encode({ class: cls, method, args: args.map((a) => (a && a.$facts ? { $facts: fixturePath(a.$facts) } : a)) }, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION));
  if (!r.ok) throw new Error(`${cls}::${method} threw: ${r.error}`);
  return r.result;
}

/** A compile result as a path -> text map (single file: the script and ARCHITECTURE.md). */
export function fileMap(result: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (result.files !== undefined) {
    for (const [, f] of entries(result.files)) out[(f as any).path] = (f as any).code;
  } else {
    out[result.filename] = typeof result.code === 'string' ? result.code : String(result.code);
    if (result.architecture !== null && result.architecture !== undefined) out['ARCHITECTURE.md'] = result.architecture;
  }
  return out;
}

/** Generation-time stamps (the doc's "Generated:" line, the A2A WORKFLOW_VERSION date) masked for comparison. */
export function maskStamps(s: string): string {
  return s
    .replace(/(Generated: {2})\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+/g, '$1<stamp>')
    .replace(/(WORKFLOW_VERSION = "\d+-)\d{8}"/g, '$1<date>"');
}
