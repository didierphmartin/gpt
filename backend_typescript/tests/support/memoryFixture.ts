/**
 * A compiler fixture held in memory (the tests/fixtures/compiler/*.json format, see php_compile.php) rather than in
 * that folder -- so a test can build its own workflow without joining every target's parity run. compile() runs
 * any target's generator on it as WorkflowController does (in-memory SQLite + repositories, as compilerFixture.ts);
 * phpCompile() runs backend/'s generator on the same fixture through php_compile.php, for a differential check.
 *
 * DISPATCHER_DEMO is backend/tests/Unit/Support/DispatcherDemoFixture.php's workflow 44.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { installSqliteDb } from './sqliteDb';
import { FIXTURES, phpBin, phpSkipReason } from './phpCompiler';
import { entries, jsonDecodeAssoc, jsonDecodePhp } from '../../src/AgentTeam/compiler/php';
import { WorkflowView } from '../../src/AgentTeam/compiler/WorkflowView';
import { StartOptionGraph } from '../../src/AgentTeam/StartOptionGraph';
import { hydrateAgent } from '../../src/AgentTeam/AgentRepository';

export type Mode = 'single' | 'modular' | 'a2a';
export type CompileResult = { ok: boolean; result?: any; error?: string };

/** DispatcherDemoFixture: Start -> techBuddy (dispatcher) -> IT claims | Human resources -> Output, deepseek with a blank model. */
export function dispatcherDemo(): any {
  const agent = (name: string, type = 'standard') => ({
    type: 'agent-template', agent_name: name, agent_type: type,
    instructions: `You are ${name}.`, agent_provider: 'deepseek', model: '', tools: [],
  });
  return {
    workflow: { id: 44, name: 'Dispatcher demo', user_id: 3, orchestration: 'workflow' },
    user_id: null,
    graph: {
      nodes: [
        { id: '1', node_type: 'start', config: { type: 'start', prompt: 'My laptop will not boot.' } },
        { id: '2', node_type: 'agent', config: agent('techBuddy', 'dispatcher') },
        { id: '3', node_type: 'agent', config: agent('IT claims') },
        { id: '4', node_type: 'agent', config: agent('Human resources') },
        { id: '5', node_type: 'output', config: { type: 'output' } },
      ],
      edges: [[1, 2], [2, 3], [2, 4], [3, 5], [4, 5]].map(([from, to]) => ({ from: String(from), to: String(to) })),
    },
    sql: [
      "INSERT INTO system_llm_settings (provider_key, model, enabled) VALUES ('deepseek', 'deepseek-chat', 1)",
      "INSERT INTO system_llm_settings (provider_key, model, enabled) VALUES ('claude', 'claude-sonnet-4-6', 1)",
    ],
  };
}

/**
 * A generator class (constructed as LangGraphGenerator is: repositories, skills root, documents) over the fixture:
 * its database installed (replacing the previous one), in-memory repositories. cleanup() removes the skills folder.
 */
export function memoryGenerator(fxIn: any, Gen: any): { gen: any; fx: any; cleanup: () => void } {
  const fx = jsonDecodeAssoc(JSON.stringify(fxIn));
  const sqlite = installSqliteDb();
  for (const s of [...JSON.parse(readFileSync(path.join(FIXTURES, 'schema.json'), 'utf8')), ...(fx.sql ?? [])]) {
    sqlite.exec(s);
  }
  const root = mkdtempSync(path.join(tmpdir(), 'mem_fixture_skills_'));
  for (const [dir, files] of entries(fx.skills ?? [])) {
    for (const [rel, text] of entries(files)) {
      mkdirSync(path.dirname(path.join(root, dir, rel)), { recursive: true });
      writeFileSync(path.join(root, dir, rel), String(text));
    }
  }
  const components = fx.code_components ?? {};
  const agents = fx.agents ?? {};
  const gen = new Gen(
    { findById: async () => WorkflowView.fromRecord(fx.workflow) },
    { getGraph: async () => StartOptionGraph.expand(fx.graph, (id: number) => components[String(id)] ?? null) },
    { findById: async (id: number) => (agents[String(id)] !== undefined ? hydrateAgent(agents[String(id)]) : null) },
    root,
    null,
  );
  return { gen, fx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** One target's generation of the fixture in one code structure (generate / generatePackage / generateA2A). */
export async function compile(fxIn: any, Gen: any, mode: Mode): Promise<CompileResult> {
  const { gen, fx, cleanup } = memoryGenerator(fxIn, Gen);
  const wid = Number(fx.workflow.id);
  const uid = fx.user_id !== undefined && fx.user_id !== null ? String(fx.user_id) : null;
  try {
    const result = mode === 'a2a' ? await gen.generateA2A(wid, uid) : mode === 'modular' ? await gen.generatePackage(wid, uid) : await gen.generate(wid, uid);
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    cleanup();
  }
}

/** backend/'s generator of `target` (adk, maf, nooa, langgraph) on the same fixture (php_compile.php target). */
export function phpCompile(fx: any, target: string, mode: Mode): CompileResult {
  const bin = phpBin();
  if (bin === null) throw new Error(phpSkipReason());
  const dir = mkdtempSync(path.join(tmpdir(), 'mem_fixture_'));
  const file = path.join(dir, 'fixture.json');
  writeFileSync(file, JSON.stringify(fx));
  try {
    const r = spawnSync(bin, [path.join(FIXTURES, 'php_compile.php'), 'target', file, target, mode], {
      encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, XDEBUG_MODE: 'off', TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    if (r.status !== 0) throw new Error(`php_compile.php target exited ${r.status}: ${r.stderr}`);
    return jsonDecodePhp(r.stdout.trim().split('\n').pop() ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A result's files as path => code (array_column($r['files'], 'code', 'path')). */
export function filesOf(result: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of result.files) out[f.path] = f.code;
  return out;
}
