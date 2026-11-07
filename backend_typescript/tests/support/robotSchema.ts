/**
 * The robot tests' fixture, twin of backend/tests/Unit/AgentTeam/RobotSchema.php: wf 75 of user 2 (Mail to PDF) with
 * its code components, Start option and schedule row, on the event-worker schema (schedulerDb).
 */
import { SchedDb, eventWorkerSchema, installSchedulerDb, row, WATCH } from './schedulerDb';
import { CodeComponentStore } from '../../src/CodeComponent/CodeComponentStore';

export const POLL = { name: 'Poll Drop', code: 'def run(input, call_tool): pass', exits: ['new_mail', 'no_mail'], mcp_servers: ['Outlook'], timeout_s: 20 };
export const PDF = { name: 'To PDF', code: 'v1', exits: ['done'], mcp_servers: ['Converter'] };
export const SP = { name: 'Store SharePoint', code: 'sp', exits: ['done'], mcp_servers: ['SharePoint', 'Outlook'] };
export const WF = 75;
export const OWNER = 2;

/**
 * EventWorkerSchema plus the users/packages the robot needs, an empty LLM settings table, and wf 75 of user 2:
 * Start on "Poll Drop" -> To PDF -> Store SharePoint -> Output, with its event schedule row. Returns the db and the
 * owner's component ids by name.
 */
export async function robotSchema(now = '2026-10-26 09:00:00'): Promise<{ d: SchedDb; ids: Record<string, number> }> {
  const d = installSchedulerDb(() => now);
  eventWorkerSchema(d);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,
    first_name TEXT, last_name TEXT, role TEXT, provider TEXT, kind TEXT NOT NULL DEFAULT 'person', email_verified INTEGER DEFAULT 0)`);
  d.exec('CREATE TABLE packages (role TEXT PRIMARY KEY, name TEXT, builtin INTEGER, capabilities TEXT, updated_at TEXT)');
  d.exec(`INSERT INTO packages (role, name, builtin, capabilities) VALUES ('user', 'User', 1, '{}'), ('admin', 'Admin', 1, '{}'),
    ('ops', 'Ops', 0, '{"use_robot": true}')`);
  d.exec("INSERT INTO users (id, email, role) VALUES (1, 'u@x.test', 'user'), (2, 'o@x.test', 'ops'), (3, 'a@x.test', 'admin')");
  d.exec('CREATE TABLE system_llm_settings (provider_key TEXT, enabled INTEGER)');

  const store = new CodeComponentStore();
  const ids: Record<string, number> = {};
  for (const c of [POLL, PDF, SP]) ids[c.name] = (await store.save(OWNER, null, c)).id;
  await store.setStartTrigger(OWNER, ids['Poll Drop'], { label: 'New drop', watch: WATCH, work_exit: 'new_mail' });
  d.prepare('INSERT INTO agent_workflows (id, user_id, name) VALUES (?, ?, ?)').run(WF, OWNER, 'Mail to PDF');
  const node = (type: string, cfg: Record<string, any>) =>
    Number(d.prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)').run(WF, type, JSON.stringify({ type, ...cfg })).lastInsertRowid);
  const start = node('start', { start_option: ids['Poll Drop'], start_args: { tag: 'vip' } });
  const pdf = node('code', { name: 'PDF', code_component_id: ids['To PDF'] });
  const sp = node('code', { name: 'SP', code_component_id: ids['Store SharePoint'] });
  const out = node('output', {});
  const edge = d.prepare('INSERT INTO workflow_edges (workflow_id, from_node_id, to_node_id, from_port) VALUES (?, ?, ?, ?)');
  edge.run(WF, start, pdf, 'output_1');
  edge.run(WF, pdf, sp, 'output_1');
  edge.run(WF, sp, out, 'output_1');
  row(d, WF, OWNER, 'event', ids['Poll Drop']);
  return { d, ids };
}

/** The agents and playbooks tables (unique per owner, as in MySQL; playbooks with the publish columns) and workflow_nodes.agent_id. */
export function agentsAndPlaybooks(d: SchedDb): void {
  d.exec('ALTER TABLE workflow_nodes ADD COLUMN agent_id INTEGER');
  d.exec(`CREATE TABLE playbooks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, pkey TEXT NOT NULL,
    title TEXT NOT NULL, text TEXT NOT NULL, automation_id INTEGER, published_by INTEGER, published_at TEXT, source_id INTEGER,
    created_at TEXT, updated_at TEXT, UNIQUE (user_id, pkey))`);
  d.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, team_id INTEGER,
    category TEXT, name TEXT NOT NULL, description TEXT, agent_type TEXT DEFAULT 'standard', parent_agent_id INTEGER,
    can_delegate_to TEXT, display_order INTEGER DEFAULT 0, provider TEXT DEFAULT 'claude', model TEXT, instructions TEXT,
    playbook_id INTEGER, tools TEXT, visibility TEXT DEFAULT 'personal', enabled INTEGER DEFAULT 1, settings TEXT,
    created_at TEXT, updated_at TEXT, UNIQUE (user_id, name))`);
}
