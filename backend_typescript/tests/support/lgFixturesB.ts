/**
 * Helpers for the LangGraph generator unit-test ports (tests/LangGraph*.test.ts): the PHP tests' in-memory
 * `sqlite::memory:` PDO + mocked repositories, rebuilt over tests/support/sqliteDb.ts and plain-object repos.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { installSqliteDb, SqliteDb } from './sqliteDb';
import { WorkflowView } from '../../src/AgentTeam/compiler/WorkflowView';
import { hydrateAgent } from '../../src/AgentTeam/AgentRepository';
import { LangGraphGenerator } from '../../src/AgentTeam/LangGraphGenerator';

/** backend/tests/fixtures (the PHP tests' Python probes and fake servers). */
export const PHP_FIXTURES = path.resolve(__dirname, '../../../backend/tests/fixtures');
export const PHP_UNIT = path.resolve(__dirname, '../../../backend/tests/Unit');

/** A fresh in-memory database with these statements run (PHP: new PDO('sqlite::memory:') + exec). */
export function sqlite(statements: string[] = []): SqliteDb {
  const d = installSqliteDb();
  for (const s of statements) d.exec(s);
  return d;
}

/**
 * A generator over plain repositories: workflow record {id, name, orchestration, output_storage_enabled, output_folder},
 * a graph (or a function returning one), agents keyed by id (records hydrated as AgentRepository does) or a lookup function.
 */
export function makeGenerator(opts: {
  workflow: any;
  graph: any | (() => any);
  agents?: Record<string, any> | ((id: number) => any);
  skillsRoot?: string | null;
  startDocuments?: any;
}): LangGraphGenerator {
  const agents = opts.agents ?? {};
  return new LangGraphGenerator(
    { findById: async () => (opts.workflow === null ? null : WorkflowView.fromRecord(opts.workflow)) },
    { getGraph: async () => (typeof opts.graph === 'function' ? await opts.graph() : opts.graph) },
    {
      findById: async (id: number) => {
        const rec = typeof agents === 'function' ? agents(id) : agents[String(id)];
        return rec === undefined || rec === null ? null : hydrateAgent(rec);
      },
    },
    opts.skillsRoot ?? emptySkillsRoot(),
    opts.startDocuments ?? null,
  );
}

let emptyRoot: string | null = null;
/** An empty skills folder shared by the tests that do not need one. */
export function emptySkillsRoot(): string {
  if (emptyRoot === null) {
    emptyRoot = mkdtempSync(path.join(tmpdir(), 'lg_unit_skills_'));
    process.on('exit', () => rmSync(emptyRoot!, { recursive: true, force: true }));
  }
  return emptyRoot;
}

/** Runs a test body expecting it to throw an Error whose message contains `msg` (PHPUnit expectExceptionMessage). */
export async function expectMessage(fn: () => Promise<any>, msg: string): Promise<void> {
  let err: any = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (err === null) throw new Error(`expected an exception with message: ${msg}`);
  const m = String(err?.message ?? err);
  if (!m.includes(msg)) throw new Error(`expected message containing:\n  ${msg}\ngot:\n  ${m}`);
}

/** {path: code} of a multi-file result (PHP array_column($files, 'code', 'path')). */
export function filesByPath(result: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of result.files ?? []) out[f.path] = f.code;
  return out;
}

let py: string | null | undefined;
/** python3 on PATH, or null. */
export function python3(): string | null {
  if (py !== undefined) return py;
  const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  return (py = r.status === 0 ? 'python3' : null);
}

/** Whether python3 can import these modules. */
export function pyHas(...modules: string[]): boolean {
  if (python3() === null) return false;
  const r = spawnSync('python3', ['-c', modules.map((m) => `import ${m}`).join('; ') || 'pass'], { encoding: 'utf8' });
  return r.status === 0;
}

/** PHP's preg_replace chain collapsing pretty-printed dicts: {\s+ -> {, \s+} -> }, \s*\n\s* -> ' '. */
export function flatten(code: string): string {
  return code.replace(/\s+\}/g, '}').replace(/\{\s+/g, '{').replace(/\s*\n\s*/g, ' ');
}

/** PHP's python(): /usr/local/bin/python3 when executable, else python3; null when it is not Python 3.10+. */
export function python310(): string | null {
  let cand = 'python3';
  try {
    accessSync('/usr/local/bin/python3', fsConstants.X_OK);
    cand = '/usr/local/bin/python3';
  } catch {
    /* python3 on PATH */
  }
  const r = spawnSync(cand, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { encoding: 'utf8' });
  return r.status === 0 ? cand : null;
}

/** PHP exec($cmd . ' 2>&1', $out, $rc): [rc, output lines] (trailing whitespace of each line dropped, as exec does). */
export function execLines(argv: string[], env: Record<string, string> = {}, opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): [number, string[]] {
  const r = spawnSync('/bin/sh', ['-c', argv.map(shq).join(' ') + ' 2>&1'], {
    encoding: 'utf8', env: { ...process.env, ...env }, cwd: opts.cwd, timeout: opts.timeoutMs, input: opts.input ?? '',
    maxBuffer: 256 * 1024 * 1024,
  });
  const text = r.stdout ?? '';
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return [r.status ?? -1, lines];
}

/** escapeshellarg. */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
