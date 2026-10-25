/**
 * The TypeScript side of a compiler parity fixture (tests/fixtures/compiler/*.json, format at the top of
 * php_compile.php): the same in-memory SQLite schema + statements, the same in-memory repositories and
 * skills folder, then the TypeScript LangGraphGenerator.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { installSqliteDb } from './sqliteDb';
import { FIXTURES, fixturePath } from './phpCompiler';
import { jsonDecodeAssoc, entries } from '../../src/AgentTeam/compiler/php';
import { WorkflowView } from '../../src/AgentTeam/compiler/WorkflowView';
import { StartOptionGraph } from '../../src/AgentTeam/StartOptionGraph';
import { hydrateAgent } from '../../src/AgentTeam/AgentRepository';
import { LangGraphGenerator } from '../../src/AgentTeam/LangGraphGenerator';
import { StartDocumentStore } from '../../src/AgentTeam/compiler/StartDocumentStore';

/** A fixture; {"extends": "<other fixture>", ...} is that fixture with these top-level keys replaced (as php_compile.php reads it). */
export function loadFixture(name: string): any {
  const fx = jsonDecodeAssoc(readFileSync(fixturePath(name), 'utf8'));
  if (fx.extends !== undefined) {
    const base = loadFixture(String(fx.extends));
    delete fx.extends;
    for (const [k, v] of entries(fx)) base[k] = v;
    return base;
  }
  return fx;
}

/** The compile targets, each a generator class constructed as LangGraphGenerator is (repositories, skills root, documents). */
export const TARGETS = ['langgraph', 'adk', 'maf', 'nooa'] as const;
export type Target = (typeof TARGETS)[number];
export const MODES = ['single', 'modular', 'a2a'] as const;
export type Mode = (typeof MODES)[number];

function targetClass(target: Target): any {
  switch (target) {
    case 'langgraph':
      return LangGraphGenerator;
    case 'adk':
      return require('../../src/AgentTeam/ADKGenerator').ADKGenerator;
    case 'maf':
      return require('../../src/AgentTeam/MAFGenerator').MAFGenerator;
    case 'nooa':
      return require('../../src/AgentTeam/NOOAGenerator').NOOAGenerator;
  }
}

/**
 * One target's generation of a fixture in one code structure, as WorkflowController calls it (php_compile.php's
 * fixture_target_compile): {ok, result} or {ok: false, error}.
 */
export async function fixtureTargetCompile(name: string, target: Target, mode: Mode): Promise<{ ok: boolean; result?: any; error?: string }> {
  const { gen, fx, cleanup } = fixtureGenerator(name, target);
  const wid = Number(fx.workflow.id);
  const uid = fx.user_id !== undefined && fx.user_id !== null ? String(fx.user_id) : null;
  try {
    let result: any;
    if (target === 'langgraph') {
      result = await gen.generate(wid, uid, { a2a: mode === 'a2a', modular: mode === 'modular' });
    } else {
      result = mode === 'a2a' ? await gen.generateA2A(wid, uid) : mode === 'modular' ? await gen.generatePackage(wid, uid) : await gen.generate(wid, uid);
    }
    return { ok: true, result };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    cleanup();
  }
}

/** Installs the fixture's database (replacing the previous one) and returns its generator; cleanup() removes the skills folder. */
export function fixtureGenerator(name: string, target: Target = 'langgraph'): { gen: any; fx: any; cleanup: () => void } {
  const fx = loadFixture(name);
  const sqlite = installSqliteDb();
  for (const s of [...JSON.parse(readFileSync(path.join(FIXTURES, 'schema.json'), 'utf8')), ...(fx.sql ?? [])]) {
    sqlite.exec(s);
  }
  const root = mkdtempSync(path.join(tmpdir(), 'lg_parity_skills_'));
  for (const [dir, files] of entries(fx.skills ?? [])) {
    for (const [rel, text] of entries(files)) {
      mkdirSync(path.dirname(path.join(root, dir, rel)), { recursive: true });
      writeFileSync(path.join(root, dir, rel), String(text));
    }
  }
  // The user's document storage (fixture "start_documents"): a local root read through StartDocumentStore.
  let docStore: StartDocumentStore | null = null;
  let docRoot: string | null = null;
  if (fx.start_documents !== undefined) {
    docRoot = mkdtempSync(path.join(tmpdir(), 'lg_parity_docs_'));
    const folder = String(fx.start_documents.user_folder);
    for (const [rel, content] of entries(fx.start_documents.files ?? [])) {
      const p = path.join(docRoot, 'synergyaichatroot', folder, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content !== null && typeof content === 'object' ? Buffer.from(String((content as any).base64), 'base64') : String(content));
    }
    docStore = new StartDocumentStore(folder, null, docRoot);
  }
  const components = fx.code_components ?? {};
  const agents = fx.agents ?? {};
  const Gen = targetClass(target);
  const gen = new Gen(
    { findById: async () => WorkflowView.fromRecord(fx.workflow) },
    { getGraph: async () => StartOptionGraph.expand(fx.graph, (id: number) => components[String(id)] ?? null) },
    { findById: async (id: number) => (agents[String(id)] !== undefined ? hydrateAgent(agents[String(id)]) : null) },
    root,
    docStore,
  );
  return {
    gen,
    fx,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      if (docRoot !== null) rmSync(docRoot, { recursive: true, force: true });
    },
  };
}
