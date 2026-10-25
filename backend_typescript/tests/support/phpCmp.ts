/**
 * The PHP side of the Compiled* emitter parity tests: tests/fixtures/compiler/php_cmp.php (backend/'s
 * CompiledRuntimeEmit / CompiledA2AEmit / CompiledArchitectureDoc / CompiledPackage on a fixture's analysis).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jsonDecodePhp, jsonDecodeAssoc, deepCopy, json_encode, JSON_UNESCAPED_SLASHES, JSON_UNESCAPED_UNICODE, JSON_PRESERVE_ZERO_FRACTION } from '../../src/AgentTeam/compiler/php';
import { FIXTURES, phpBin, fixturePath } from './phpCompiler';

const SCRIPT = path.join(FIXTURES, 'php_cmp.php');

function run(args: string[], stdin?: string): any {
  const bin = phpBin();
  if (bin === null) throw new Error('no PHP');
  const r = spawnSync(bin, [SCRIPT, ...args], {
    input: stdin, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, XDEBUG_MODE: 'off', TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
  if (r.status !== 0) throw new Error(`php_cmp.php ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return jsonDecodePhp(r.stdout.trim().split('\n').pop() ?? '');
}

/** The fixture's analysis as php_cmp.php prints it ({pre, index, graph, analyzed, adk, sql, agents, ...}). */
export function cmpAnalyzed(fixture: string): any {
  return run(['analyzed', fixturePath(fixture)]);
}

/** AdkCodeNodeTest::wf64Analyzed(). */
export function cmpWf64(): any {
  return run(['wf64']);
}

/** The fixtures php_cmp.php can analyze (ADKGenerator::analyzeWorkflow does not throw on them). */
export function analyzableFixtures(): string[] {
  return readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
}

export type PhpCall = { class: string; method?: string; const?: string; args?: any[] };
export type PhpResult = { ok: boolean; result?: any; error?: string };

/** Many static calls in one PHP process (argument specs: see php_cmp.php). */
export function cmpBatch(calls: PhpCall[]): PhpResult[] {
  const req = calls.map((c) => ({ ...c, args: (c.args ?? []).map((a) => (a && a.$analyzed ? { ...a, $analyzed: fixturePath(a.$analyzed) } : a && a.$skillsRoot ? { $skillsRoot: fixturePath(a.$skillsRoot) } : a)) }));
  return run(['batch'], JSON.stringify({ calls: req }));
}

/** A plain argument as PHP's json_decode(..., true) sees it. */
export function asPhpArg(v: any): any {
  return jsonDecodeAssoc(JSON.stringify(v));
}

/** `analyzed` with keys set / unset, a deep copy (PHP passes arrays by value). */
export function withKeys(analyzed: any, set: Record<string, any> = {}, unset: string[] = []): any {
  const a = deepCopy(analyzed);
  for (const [k, v] of Object.entries(set)) a[k] = asPhpArg(v);
  for (const k of unset) delete a[k];
  return a;
}

/** A value as the comparison text: strings as they are, everything else as PHP's out() prints it. */
export function asText(v: any): string {
  return typeof v === 'string' ? v : json_encode(v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
}

/** A directory holding the fixture's skills, as php_compile.php's fixture_skills_root() lays them out. */
export function skillsRootFor(fixture: string): string {
  const fx = JSON.parse(readFileSync(fixturePath(fixture), 'utf8'));
  const root = mkdtempSync(path.join(os.tmpdir(), 'cmp_skills_'));
  for (const [dir, files] of Object.entries<any>(fx.skills ?? {})) {
    for (const [rel, text] of Object.entries<string>(files)) {
      const p = path.join(root, dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  return root;
}
