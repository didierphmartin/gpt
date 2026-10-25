import fs from 'fs';
import os from 'os';
import path from 'path';
import { installFakeDb, FakeHandler } from './fakeDb';

/**
 * A GraphWorkflowRunner over a canned graph, a fake model and an in-memory
 * agent_workflow_executions table (the PHP tests' Mockery graph repository + SQLite). The
 * collaborators are replaced the way the PHP tests set private properties by reflection.
 */
export interface ExecutionRow {
  id: number;
  status: string;
  output: string | null;
  error_message: string | null;
}

export interface Harness {
  runner: any;
  runsDir: string;
  rows: ExecutionRow[];
  runLogs(): string[];
  cleanup(): void;
}

export function makeRunnerHarness(opts: {
  nodes: any[];
  edges: any[];
  config?: Record<string, any>;
  agentRunner?: { run: (...a: any[]) => Promise<any> };
  agentRepository?: { findById: (id: any) => Promise<any> };
  /** Answers every query the executions table does not (decision rows, packages, ...). */
  extra?: FakeHandler;
}): Harness {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfruns_'));
  const rows: ExecutionRow[] = [];
  installFakeDb((sql, p) => {
    if (sql.includes('INSERT INTO agent_workflow_executions')) {
      const id = rows.length + 1;
      rows.push({ id, status: 'running', output: null, error_message: null });
      return { rows: [], insertId: id };
    }
    if (sql.includes('UPDATE agent_workflow_executions') && sql.includes("status = 'completed'")) {
      const row = rows.find((r) => r.id === Number(p[3]));
      if (row) Object.assign(row, { status: 'completed', output: p[0] as string, error_message: (p[1] as string | null) ?? null });
      return [];
    }
    if (sql.includes('UPDATE agent_workflow_executions') && sql.includes("status = 'failed'")) {
      const row = rows.find((r) => r.id === Number(p[1]));
      if (row) Object.assign(row, { status: 'failed', error_message: p[0] as string });
      return [];
    }
    if (sql.includes('DELETE FROM agent_workflow_executions')) {
      const i = rows.findIndex((r) => r.id === Number(p[0]));
      if (i >= 0) rows.splice(i, 1);
      return [];
    }
    return opts.extra ? opts.extra(sql, p) : [];
  });

  const { GraphWorkflowRunner } = require('../../src/AgentTeam/GraphWorkflowRunner');
  const runner = new GraphWorkflowRunner({ workflow_runs_dir: runsDir, ...(opts.config ?? {}) });
  const start = opts.nodes.find((n) => n.node_type === 'start');
  runner.graphRepository = {
    findStartNode: async () => start,
    getGraph: async () => ({ nodes: opts.nodes, edges: opts.edges }),
  };
  runner.agentRunner = opts.agentRunner ?? {
    run: async () => {
      throw new Error('the model must not be called');
    },
  };
  if (opts.agentRepository) runner.agentRepository = opts.agentRepository;
  // Output storage is a best-effort side effect: record the call instead of touching disk/DB.
  runner.outputStorage = { saveOutput: async () => ({ success: false, error: 'storage disabled in tests' }) };

  return {
    runner,
    runsDir,
    rows,
    runLogs: () => fs.readdirSync(runsDir).filter((f) => f.endsWith('.jsonl')),
    cleanup: () => fs.rmSync(runsDir, { recursive: true, force: true }),
  };
}
