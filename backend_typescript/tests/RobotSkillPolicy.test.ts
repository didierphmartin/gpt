import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { robotSchema, agentsAndPlaybooks, WF, OWNER } from './support/robotSchema';
import { SchedDb } from './support/schedulerDb';
import { makeRunnerHarness } from './support/runnerHarness';
import { config } from '../src/config/env';
import { RobotAccount } from '../src/Services/RobotAccount';
import { RobotOwnership } from '../src/Services/RobotOwnership';
import { RobotSkillPolicy } from '../src/Services/RobotSkillPolicy';
import { SkillStore } from '../src/Services/SkillStore';
import { PrivateSkillsRefused } from '../src/Services/SkillErrors';
import { WorkflowOwnerTransfer } from '../src/AgentTeam/WorkflowOwnerTransfer';
import { ActiveWorkflowService } from '../src/AgentTeam/ActiveWorkflowService';
import { ActiveWorkflowController } from '../src/Controllers/ActiveWorkflowController';
import { WorkflowController } from '../src/Controllers/WorkflowController';
import { ScheduleTick } from '../src/AgentTeam/ScheduleTick';
import { GraphWorkflowRunner } from '../src/AgentTeam/GraphWorkflowRunner';

/**
 * Port of backend/tests/Unit/RobotSkillPolicyTest.php (the corporate robot uses public skills only: private
 * bindings are refused on transfer, activate, run, compile and scheduled runs) and GraphWorkflowRunnerSkillTest.php
 * (a skill-bound node without the browser's client_skills fails the run).
 */

let root = '';
let d: SchedDb;
let robot = 0;
const savedEdition = config.edition;

const B = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
const files = (name: string) => B({ 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\nbody\n` });
const policy = (edition = 'corporate', store: SkillStore | null = new SkillStore(root, edition)) => new RobotSkillPolicy({ edition }, store);
const secret = () => [{ path: 'tools/secret', owner_id: OWNER, owner_name: 'Olga Ops' }];
const req = (u: number, extra: Record<string, any> = {}): any =>
  ({ method: 'POST', uri: '/', headers: {}, query: {}, body: {}, user_id: u, auth_type: 'jwt', params: { id: String(WF) }, remote_addr: '', ...extra });
const toRobot = () => new WorkflowOwnerTransfer(new RobotOwnership({ edition: 'corporate' })).toRobot(OWNER, WF);

beforeEach(async () => {
  root = fs.mkdtempSync(os.tmpdir() + '/robotskills_');
  ({ d } = await robotSchema());
  agentsAndPlaybooks(d);
  for (const c of ['description TEXT', 'steps TEXT', 'triggers TEXT', 'variables TEXT', 'workspace_id INTEGER', 'output_storage_enabled INTEGER DEFAULT 0',
    'output_folder TEXT', 'orchestration TEXT']) d.exec(`ALTER TABLE agent_workflows ADD COLUMN ${c}`);
  robot = await RobotAccount.ensure();
  d.exec("UPDATE users SET first_name = 'Olga', last_name = 'Ops' WHERE id = 2");
  // wf 75 binds the private skill "secret" (user 2's) and the public skill "shared"
  const node = d.prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)');
  node.run(WF, 'agent', JSON.stringify({ type: 'agent', bound_skill: { dir_name: 'tools/secret' } }));
  node.run(WF, 'agent', JSON.stringify({ type: 'agent', bound_skill: { dir_name: 'shared' } }));
  const s = new SkillStore(root, 'corporate');
  s.import(OWNER, 'tools/secret', files('secret'), 'private');
  s.import(OWNER, 'shared', files('shared'), 'public');
  (config as any).edition = 'corporate';
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.SKILLS_DIR;
  (config as any).edition = savedEdition;
});

test('private skills are listed in corporate; an unknown one without owner; none in individual or folder mode', async () => {
  assert.deepEqual(await policy().privateSkills(WF), secret());
  d.prepare('INSERT INTO workflow_nodes (workflow_id, node_type, config) VALUES (?, ?, ?)').run(WF, 'agent', JSON.stringify({ bound_skill: { dir_name: 'ghost' } }));
  assert.ok((await policy().privateSkills(WF)).some((x) => JSON.stringify(x) === JSON.stringify({ path: 'ghost', owner_id: 0, owner_name: '', missing: true })));
  assert.deepEqual(await policy('individual').privateSkills(WF), []);
  assert.deepEqual(await policy('corporate', null).privateSkills(WF), []);
});

test('the refusal shape', () => {
  assert.deepEqual(RobotSkillPolicy.refusal(secret()), { success: false, code: 'private_skills',
    message: 'This workflow uses private skills. The robot can only use public skills.',
    error: 'This workflow uses private skills. The robot can only use public skills.', data: { skills: secret() }, status_code: 409 });
});

test('the transfer is refused with private skills (service and route)', async () => {
  const t = new WorkflowOwnerTransfer(new RobotOwnership({ edition: 'corporate' }), policy());
  for (const m of ['preview', 'toRobot'] as const) {
    await assert.rejects(t[m](OWNER, WF), (e: any) => e instanceof PrivateSkillsRefused && JSON.stringify(e.skills) === JSON.stringify(secret()));
  }
  assert.equal(Number((d.prepare('SELECT user_id FROM agent_workflows WHERE id = ?').get(WF) as any).user_id), OWNER);
  process.env.SKILLS_DIR = root;
  assert.deepEqual(await new WorkflowController().owner(req(OWNER, { body: { owner: 'robot', confirm: true } })), RobotSkillPolicy.refusal(secret()));
});

test('activating a robot workflow with private skills is refused; the route passes once the skill is public', async () => {
  await toRobot();
  await assert.rejects(new ActiveWorkflowService(policy()).activate(robot, WF), PrivateSkillsRefused);
  process.env.SKILLS_DIR = root;
  const c = new ActiveWorkflowController();
  assert.deepEqual(await c.activate(req(OWNER)), RobotSkillPolicy.refusal(secret()));
  await new SkillStore(root, 'corporate').setVisibility(OWNER, 'tools/secret', 'public');
  assert.notEqual((await c.activate(req(OWNER))).status_code, 409);
});

test("a robot run is refused with private skills; a person's own workflow is not checked", async () => {
  process.env.SKILLS_DIR = root;
  const own = await new WorkflowController().run(req(OWNER));
  assert.notEqual(own.code ?? null, 'private_skills');
  await toRobot();
  assert.deepEqual(await new WorkflowController().run(req(OWNER)), RobotSkillPolicy.refusal(secret()));
});

test('compiling a corporate robot workflow that binds a private skill is refused, for every target', async () => {
  await toRobot();
  process.env.SKILLS_DIR = root;
  const c = new WorkflowController();
  for (const route of ['generatePython', 'generateAdk', 'generateMaf', 'generateNooa'] as const) {
    assert.deepEqual(await c[route](req(OWNER, { query: { modular: '1' } })), RobotSkillPolicy.refusal(secret()), route);
  }
});

test('a scheduled robot run refuses private skills; a person keeps running', async () => {
  let ran = 0;
  const runner = { run: async () => { ran++; return { success: true }; } };
  const run = ScheduleTick.workflowRunner({ findById: async () => ({ enabled: true }) }, { getNodes: async () => [{ id: 1 }] }, runner, runner, policy());
  await toRobot();
  assert.deepEqual(await run({ workflow_id: WF, user_id: robot }),
    { success: false, error: RobotSkillPolicy.MESSAGE, code: 'private_skills', skills: secret() });
  assert.equal(ran, 0);
  assert.deepEqual(await run({ workflow_id: WF, user_id: OWNER }), { success: true });
  assert.equal(ran, 1);
});

// ---- GraphWorkflowRunner: a skill step without a browser ----

const MESSAGE = 'Skill "pdf-tools" can only run from the editor or in a compiled program: this run has no browser to run it.';

async function runSkilled(agentConfig: Record<string, any>, clientSkills: Record<string, any> = {}, fanOut = false) {
  const nodes: any[] = [
    { id: 1, node_type: 'start', config: {} },
    { id: 2, node_type: 'agent', agent_id: 7, config: { name: 'Skilled', ...agentConfig } },
    { id: 3, node_type: 'output', config: {} },
  ];
  const edges: any[] = [{ from_node_id: 1, to_node_id: 2, from_port: 'output_1' }, { from_node_id: 2, to_node_id: 3, from_port: 'output_1' }];
  if (fanOut) {
    nodes.push({ id: 4, node_type: 'agent', agent_id: 8, config: { name: 'Plain' } });
    edges.push({ from_node_id: 1, to_node_id: 4, from_port: 'output_1' }, { from_node_id: 4, to_node_id: 3, from_port: 'output_1' });
  }
  const h = makeRunnerHarness({ nodes, edges, agentRepository: { findById: async () => { throw new Error('no agent lookup expected'); } } });
  try {
    return { out: await h.runner.run({ id: 44, name: 'Skill test' }, 3, { prompt: 'go' }, clientSkills), rows: [...h.rows] };
  } finally {
    h.cleanup();
  }
}

test('a bound skill without a browser fails the run (sequential and fan-out); inline skill_content does not rescue it', async () => {
  let r = await runSkilled({ bound_skill: { dir_name: 'pdf-tools', source: 'local' } });
  assert.deepEqual([r.out.success, r.out.error], [false, MESSAGE]);
  assert.deepEqual(r.rows.map((x) => [x.status, x.error_message]), [['failed', MESSAGE]]);
  r = await runSkilled({ bound_skill: { dir_name: 'pdf-tools' }, skill_content: 'old inline body' });
  assert.deepEqual([r.out.success, r.out.error], [false, MESSAGE]);
  r = await runSkilled({ bound_skill: { dir_name: 'pdf-tools' } }, {}, true);
  assert.deepEqual([r.out.success, r.out.error], [false, MESSAGE]);
});

test('the guard passes when the browser sent the skill; nodes without a bound skill are unaffected', () => {
  GraphWorkflowRunner.assertBoundSkillRunnable({ bound_skill: { dir_name: 'pdf-tools' } }, { 'pdf-tools': { skill_content: 'x' } });
  for (const cfg of [{}, { skill_content: 'inline only' }, { bound_skill: { dir_name: '' } }, { bound_skill: null }]) {
    GraphWorkflowRunner.assertBoundSkillRunnable(cfg, {});
  }
  assert.throws(() => GraphWorkflowRunner.assertBoundSkillRunnable({ bound_skill: { dir_name: 'pdf-tools' } }, {}), new RegExp(MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
