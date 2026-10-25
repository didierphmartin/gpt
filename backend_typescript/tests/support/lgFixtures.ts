/**
 * Shared fixtures for the ported PHP LangGraph*Test unit tests (backend/tests/Unit/LangGraph*Test.php):
 * LangGraphA2AGeneratorTest's pdo()/graph()/skillsRoot()/generator()/facts() and small helpers to build a
 * LangGraphGenerator over an in-memory SQLite database (the shared Kysely `db` routed to it) and to run python3.
 *
 * Other ports may APPEND helpers here; do not rewrite the existing ones.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { installSqliteDb, SqliteDb } from './sqliteDb';
import { WorkflowView } from '../../src/AgentTeam/compiler/WorkflowView';
import { hydrateAgent } from '../../src/AgentTeam/AgentRepository';
import { LangGraphGenerator } from '../../src/AgentTeam/LangGraphGenerator';

/** backend/tests/fixtures (the PHP tests' Python probes, fake MCP servers ...): read from there, never copied. */
export const PHP_FIXTURES = path.resolve(__dirname, '../../../backend/tests/fixtures');

/** A fresh in-memory SQLite database (replacing the previous one) with these statements run on it. */
export function lgDb(statements: string[]): SqliteDb {
  const d = installSqliteDb();
  for (const s of statements) d.exec(s);
  return d;
}

export type LgGenOptions = {
  /** The database statements (CREATE TABLE / INSERT), as the PHP test's pdo() runs them. */
  sql: string[];
  /** The workflow record ({id, name, ...}) WorkflowRepository::findById returns. */
  workflow: any;
  /** What WorkflowGraphRepository::getGraph returns (a plain object, or a function for a graph that changes). */
  graph: any | (() => any);
  /** AgentRepository::findById: the agent record per id (hydrated), or a function; default: null for every id. */
  agents?: Record<string, any> | ((id: number) => any);
  /**
   * true: findById returns the record verbatim (not hydrated), as a PHP test's mocked Agent whose toArray() returns
   * only the keys it lists (the generator reads a plain record as that array).
   */
  rawAgents?: boolean;
  skillsRoot?: string | null;
  startDocuments?: any;
};

/**
 * A LangGraphGenerator as the PHP tests build it with mocked repositories. Installs the database NOW (the
 * TypeScript generator reads the shared `db`), so build it right before generating.
 */
export function lgGenerator(o: LgGenOptions): LangGraphGenerator {
  lgDb(o.sql);
  const agents = o.agents;
  return new LangGraphGenerator(
    { findById: async () => WorkflowView.fromRecord(o.workflow) },
    { getGraph: async () => (typeof o.graph === 'function' ? await o.graph() : o.graph) },
    {
      findById: async (id: number) => {
        if (agents === undefined) return null;
        const r = typeof agents === 'function' ? await agents(id) : agents[String(id)];
        if (r === undefined || r === null) return null;
        return o.rawAgents ? r : hydrateAgent(r);
      },
    },
    o.skillsRoot ?? null,
    o.startDocuments ?? null,
  );
}

// ---------- LangGraphA2AGeneratorTest ----------

export const PLAYBOOK =
  'Title: Time Off\n\nTrigger: PTO.\n\nInstructions:\n1. #Get PTO Balance for the requester.\n2. #Request Approval from the manager then #Resolve Request.\n\nTools used: Workday\n\nActions used: #Get PTO Balance; #Request Approval; #Resolve Request\n';

/** LangGraphA2AGeneratorTest::pdo()'s statements. */
export function a2aSql(): string[] {
  return [
    'CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, user_id TEXT, name TEXT, url TEXT, enabled INTEGER)',
    'CREATE TABLE mcp_server_tools (id INTEGER PRIMARY KEY, server_id INTEGER, tool_name TEXT, description TEXT, input_schema TEXT)',
    'CREATE TABLE system_llm_settings (provider_key TEXT, display_name TEXT, model TEXT, base_url TEXT, api_format TEXT, protocol TEXT, enabled INTEGER, sort_order INTEGER)',
    "INSERT INTO mcp_servers VALUES (85, '3', 'Workday', 'http://localhost/mockstack/index.php/workday', 1)",
    "INSERT INTO mcp_servers VALUES (9, NULL, 'News', 'http://localhost/news/', 1)",
    'INSERT INTO mcp_server_tools VALUES (1, 85, \'get_pto_balance\', \'Get balances\', \'{"type":"object","properties":{"email":{"type":"string"}}}\')',
    "INSERT INTO mcp_server_tools VALUES (2, 9, 'get_news', 'News', '{}')",
    "INSERT INTO system_llm_settings (provider_key, model, enabled) VALUES ('claude', 'claude-sonnet-4-5', 1)",
    "INSERT INTO system_llm_settings (provider_key, display_name, model, base_url, api_format, protocol, enabled, sort_order) VALUES ('jev', 'Jev', 'jev-latest', NULL, 'router', 'typesafe', 1, 100)",
  ];
}

/** LangGraphA2AGeneratorTest::pdo(): installs that database. */
export function a2aPdo(): SqliteDb {
  return lgDb(a2aSql());
}

/** Dispatcher-demo shape: start -> dispatcher -> {IT claims, Human resources -> playbook} -> output. */
export function a2aGraph(): any {
  const agent = (name: string, type = 'standard', tools: string[] = [], extra: Record<string, any> = {}) => ({
    type: 'agent-template',
    agent_name: name,
    agent_type: type,
    instructions: `You are ${name}.`,
    agent_provider: 'claude',
    model: 'claude-sonnet-4-5',
    tools,
    settings: { temperature: 0.7, max_tokens: 4096 },
    ...extra,
  });
  return {
    nodes: [
      { id: '1', node_type: 'start', config: { type: 'start', prompt: 'I want to take some vacations' } },
      { id: '2', node_type: '', config: agent('techBuddy', 'dispatcher') },
      { id: '3', node_type: '', config: agent('IT claims', 'standard', ['mcp_get_news', 'run_skill_script'], { bound_skill: { dir_name: 'html' } }) },
      { id: '4', node_type: '', config: agent('Human resources') },
      {
        id: '5',
        node_type: 'playbook',
        config: { type: 'playbook', name: 'Playbook HR', playbook: PLAYBOOK, agent_provider: 'deepseek', model: 'deepseek-flash', writes_enabled: true },
      },
      { id: '6', node_type: 'output', config: { type: 'output' } },
    ],
    edges: [
      { from: '1', to: '2' },
      { from: '2', to: '3' },
      { from: '2', to: '4' },
      { from: '3', to: '6' },
      { from: '4', to: '5' },
      { from: '5', to: '6' },
    ],
  };
}

let skillsRootDir: string | null = null;

/**
 * A skills root for the fixtures' skill bindings (html, lgtest): the modular package copies each bound skill's
 * folder, and a test must not read the developer's own ~/Documents skills. One per process, removed at exit.
 */
export function skillsRoot(): string {
  if (skillsRootDir === null) {
    const root = mkdtempSync(path.join(tmpdir(), 'lg_fixture_skills_'));
    for (const d of ['html', 'lgtest']) {
      mkdirSync(path.join(root, d), { recursive: true });
      writeFileSync(path.join(root, d, 'SKILL.md'), `---\nname: ${d}\n---\nFixture skill.\n`);
    }
    skillsRootDir = root;
    process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  }
  return skillsRootDir;
}

/** LangGraphA2AGeneratorTest::generator(): workflow 44 "Dispatcher demo", a2aGraph(), no agents (installs the db). */
export function a2aGenerator(): LangGraphGenerator {
  return lgGenerator({
    sql: a2aSql(),
    workflow: { id: 44, name: 'Dispatcher demo', user_id: '3' },
    graph: a2aGraph(),
    skillsRoot: skillsRoot(),
  });
}

/** Facts as analyzeForEmit() returns them (private). */
export async function a2aFacts(): Promise<any> {
  return (a2aGenerator() as any).analyzeForEmit(44, '3');
}

// ---------- python ----------

let py3: string | null | undefined;

/** python3 on PATH (or null): the PHP tests' exec('python3 ...'). */
export function python3(): string | null {
  if (py3 !== undefined) return py3;
  const r = spawnSync('python3', ['-c', 'import sys'], { encoding: 'utf8' });
  return (py3 = r.status === 0 ? 'python3' : null);
}

/** Runs `python <args>`; {rc, out: stdout+stderr lines, right-trimmed, as PHP exec(... 2>&1, $out, $rc) gives them, text: raw}; rc -1 on timeout. */
export function execPy(python: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}): { rc: number; out: string[]; text: string } {
  const r = spawnSync('sh', ['-c', 'exec "$0" "$@" 2>&1', python, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 120000,
    killSignal: 'SIGKILL',
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  const text = r.stdout ?? '';
  // PHP exec() drops each line's trailing whitespace (and so the last empty line).
  const out = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (out.length && out[out.length - 1] === '') out.pop();
  return { rc: r.status ?? -1, out, text };
}

/** Writes `code` to a temp .py file, runs `python <file>`; the file is removed. */
export function runPySource(python: string, code: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): { rc: number; out: string[]; text: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lgpy_'));
  const file = path.join(dir, 'probe.py');
  writeFileSync(file, code);
  try {
    return execPy(python, [file], opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** python3 -m py_compile on `code`: {rc, out}. */
export function pyCompile(code: string, python: string = python3() ?? 'python3'): { rc: number; out: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'lgpyc_'));
  const file = path.join(dir, 'm.py');
  writeFileSync(file, code);
  try {
    const r = execPy(python, ['-m', 'py_compile', file]);
    return { rc: r.rc, out: r.out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** path => code of every emitted file (single file as workflow.py), as the PHP tests' files() helper. */
export function lgFiles(gen: any): Record<string, string> {
  if (gen.files !== undefined) {
    const out: Record<string, string> = {};
    for (const f of gen.files) out[f.path] = f.code;
    return out;
  }
  return { 'workflow.py': gen.code };
}
