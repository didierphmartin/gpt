/**
 * Shared fixtures for the playbook tests, twins of backend/tests/Unit/Playbook's PlaybookDbTestCase,
 * FakeMcpExecutor, FakeGateBridge and FakeNodeRunnerBridge. The tables live in an in-memory SQLite
 * database behind the fake Kysely executor (tests/support/sqliteDb), as the PHP tests use SQLite PDO.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { McpExecutor } from '../../src/Playbook/PlaybookActionSpace';
import { GateBridge } from '../../src/Playbook/GateManager';

export function createRunTables(d: DatabaseSync): void {
  d.exec(`CREATE TABLE playbook_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INT, playbook_title TEXT,
    document TEXT, status TEXT DEFAULT 'pending', requester TEXT, variables TEXT, pending_gate TEXT,
    current_leg INT DEFAULT 0, coverage TEXT, created_at TEXT, updated_at TEXT, resolved_at TEXT)`);
  d.exec(`CREATE TABLE playbook_run_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
    direction TEXT, audience TEXT, text TEXT, sensitive INT DEFAULT 0, created_at TEXT)`);
  d.exec(`CREATE TABLE playbook_run_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT,
    author TEXT DEFAULT 'agent', text TEXT, created_at TEXT)`);
  d.exec(`CREATE TABLE playbook_run_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
    seq INT, action_name TEXT, tool TEXT, args TEXT, outcome TEXT, result_summary TEXT, returned_ids TEXT,
    sensitive INT DEFAULT 0, duration_ms INT, created_at TEXT)`);
  d.exec(`CREATE TABLE playbook_run_gates (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INT, leg INT DEFAULT 0,
    kind TEXT, args TEXT, asked_of TEXT, opened_at TEXT, closed_at TEXT, decision TEXT, actor TEXT)`);
}

/** PlaybookStoreTest::schema. */
export function createCollectionTables(d: DatabaseSync): void {
  d.exec(`CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,
    title TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, updated_at TEXT,
    published_by INTEGER NULL, published_at TEXT NULL, source_id INTEGER NULL, automation_id INTEGER NULL, UNIQUE (user_id, pkey))`);
  d.exec(`CREATE TABLE agent_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, name TEXT)`);
  d.exec(`CREATE TABLE workflow_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id INTEGER, node_type TEXT, agent_id INTEGER,
    config TEXT, pos_x INTEGER, pos_y INTEGER, drawflow_node_id TEXT)`);
}

export const OKTA = 'A note for colleagues: Okta prod tenant only.\n\nTitle: Okta password reset\nTrigger: A user is locked out.\nInstructions:\n1. #Search Okta Users with the email.\n2. #Reset Okta Password.\n\n(Ask Identity Team before changing step 2.)\nTools used: Okta\nActions used: #Search Okta Users; #Reset Okta Password\n';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pbtest-'));
}

export class FakeMcpExecutor implements McpExecutor {
  calls: Array<{ server: string; tool: string; args: any }> = [];
  canned: Record<string, any> = {};

  async call(server: string, tool: string, args: Record<string, any>): Promise<Record<string, any>> {
    this.calls.push({ server, tool, args });
    return this.canned[`${server}.${tool}`] ?? { ok: true, result: { done: true } };
  }

  availableTools() {
    return {
      'okta.search_users': {
        description: 'Search Okta users by attribute',
        input_schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
      },
      'okta.reset_password': {
        description: 'Reset an Okta user password',
        input_schema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] },
      },
    };
  }
}

/** Queued answers in order; null entries (or an exhausted queue) time out. */
export class FakeGateBridge implements GateBridge {
  calls: Array<{ runId: number; kind: string; payload: any; timeoutMs: number }> = [];
  constructor(private queue: Array<Record<string, any> | null> = [], private readonly onAsk: ((runId: number, kind: string, payload: any) => Promise<void> | void) | null = null) {}

  async ask(runId: number, kind: string, payload: Record<string, any>, timeoutMs: number) {
    this.calls.push({ runId, kind, payload, timeoutMs });
    if (this.onAsk) await this.onAsk(runId, kind, payload);
    if (this.queue.length === 0) return null;
    return this.queue.shift() ?? null;
  }
}

/** SkillBridgeGateBridge's contract (emit gate_request, then answer) without the file rendezvous. */
export class FakeNodeRunnerBridge implements GateBridge {
  calls: Array<{ runId: number; kind: string; payload: any }> = [];
  constructor(private readonly emit: (e: Record<string, any>) => void,
    private readonly answer: Record<string, any> | null = { actor: 'approver1', decision: 'approved' }) {}

  async ask(runId: number, kind: string, payload: Record<string, any>) {
    this.calls.push({ runId, kind, payload });
    this.emit({ type: 'gate_request', tool_call_id: 'f'.repeat(32), kind, payload, run_id: runId });
    return this.answer;
  }
}

/** A queue of rounds; each round is a list of tool calls (more than one = parallel calls in one turn). */
export function scriptedLlm(rounds: Array<Array<{ name: string; arguments?: any }>>, captured: any[][] = []) {
  const queue = [...rounds];
  let counter = 0;
  return async (messages: any[]) => {
    captured.push(JSON.parse(JSON.stringify(messages)));
    if (queue.length === 0) return { text: 'nothing left to do', tool_calls: [] };
    const round = queue.shift()!;
    return { text: null, tool_calls: round.map((c) => ({ id: 'call_' + ++counter, name: c.name, arguments: c.arguments ?? {} })) };
  };
}
