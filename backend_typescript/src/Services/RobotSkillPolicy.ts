import { sql } from 'kysely';
import * as path from 'node:path';
import { db } from '../db/pools';
import { config } from '../config/env';
import { GraphAnalyzer } from '../AgentTeam/compiler/GraphAnalyzer';
import { Edition, EditionConfig } from './Edition';
import { RobotAccount } from './RobotAccount';
import { PRIVATE_SKILLS_MESSAGE, PrivateSkill } from './SkillErrors';
import { SkillStore } from './SkillStore';

/**
 * Mirrors src/Services/RobotSkillPolicy.php: in the corporate edition (volume mode) the robot uses public skills
 * only. Matching is on the skill's leaf name, as everywhere in the store.
 */
export class RobotSkillPolicy {
  static readonly MESSAGE = PRIVATE_SKILLS_MESSAGE;

  constructor(private readonly cfg: EditionConfig = config, private readonly store: SkillStore | null = null) {}

  /** The policy of this backend: the skill store of SKILLS_DIR (none in folder mode). */
  static fromEnv(cfg: EditionConfig = config): RobotSkillPolicy {
    return new RobotSkillPolicy(cfg, SkillStore.fromEnv(cfg));
  }

  /** The 409 every refusal answers with. */
  static refusal(skills: PrivateSkill[]): Record<string, any> {
    return { success: false, code: 'private_skills', message: RobotSkillPolicy.MESSAGE, error: RobotSkillPolicy.MESSAGE,
      data: { skills }, status_code: 409 };
  }

  /** Empty unless corporate + volume mode. */
  async privateSkills(workflowId: number): Promise<PrivateSkill[]> {
    const robot = await RobotAccount.id();
    if (this.store === null || robot === null || !Edition.isCorporate(this.cfg)) return [];
    const pub = new Set(this.store.list(robot, true).map((row) => path.posix.basename(row.path)));
    const out = new Map<string, PrivateSkill>();
    for (const dir of await this.boundSkills(workflowId)) {
      const leaf = path.posix.basename(dir);
      if (pub.has(leaf) || out.has(leaf)) continue;
      const found = this.store.findPrivate(leaf);
      out.set(leaf, {
        path: found?.path ?? dir, owner_id: found?.owner_id ?? 0,
        owner_name: found === null ? '' : await this.ownerName(found.owner_id),
        ...(found === null ? { missing: true as const } : {}),
      });
    }
    return [...out.values()];
  }

  /** privateSkills() for a workflow run on behalf of ownerId: only the robot's runs are held to public skills. */
  async privateSkillsForOwner(ownerId: number, workflowId: number): Promise<PrivateSkill[]> {
    return (await RobotAccount.id()) === ownerId ? this.privateSkills(workflowId) : [];
  }

  /** The robot's workflows whose nodes bind the skill leafName. */
  async robotWorkflowsUsing(leafName: string): Promise<Array<{ id: number; name: string }>> {
    const robot = await RobotAccount.id();
    if (robot === null) return [];
    const rows = (await sql<any>`SELECT w.id, w.name, n.config FROM agent_workflows w JOIN workflow_nodes n ON n.workflow_id = w.id
      WHERE w.user_id = ${robot} ORDER BY w.name, w.id`.execute(db)).rows;
    const out = new Map<number, { id: number; name: string }>();
    for (const r of rows) {
      for (const dir of RobotSkillPolicy.dirs(r.config)) {
        if (path.posix.basename(dir) === leafName) out.set(Number(r.id), { id: Number(r.id), name: String(r.name) });
      }
    }
    return [...out.values()];
  }

  private async boundSkills(workflowId: number): Promise<string[]> {
    const rows = (await sql<any>`SELECT config FROM workflow_nodes WHERE workflow_id = ${workflowId}`.execute(db)).rows;
    return rows.flatMap((r) => RobotSkillPolicy.dirs(r.config));
  }

  private static dirs(config: any): string[] {
    let cfg: any = config;
    if (typeof config === 'string') {
      try {
        cfg = JSON.parse(config);
      } catch {
        cfg = null;
      }
    }
    if (cfg === null || typeof cfg !== 'object') return [];
    return GraphAnalyzer.skillsFromConfig(cfg).filter((s: any) => s?.dir !== undefined && s?.dir !== null).map((s: any) => String(s.dir));
  }

  private async ownerName(userId: number): Promise<string> {
    const r = (await sql<any>`SELECT first_name, last_name FROM users WHERE id = ${userId}`.execute(db)).rows[0];
    return r ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : '';
  }
}
